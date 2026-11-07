#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const exported = load('novai-canvas-ui/src/canvas/canvas-next/exportCanvas.ts');
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
const blob = new Blob([bytes], { type: 'image/png' });

async function testBrowserFallback() {
    const payloads = [];
    const downloads = [];
    const result = await exported.saveCanvasBlob(blob, '画布.png',
        async (payload) => { payloads.push(payload); return { ok: false, error: 'NOT_SUPPORTED', detail: '当前 NOVAI 不支持 canvas/saveExport' }; },
        (saved, name) => downloads.push({ size: saved.size, name }));
    // 宿主没实现这个命令 → 必须真的走浏览器下载，而不是报「保存失败」
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.via, 'browser');
    assert.strictEqual(result.path, '画布.png');
    assert.strictEqual(result.display, '画布.png');
    assert.strictEqual(result.bytes, bytes.length);
    assert.deepStrictEqual(downloads, [{ size: bytes.length, name: '画布.png' }]);
    // 浏览器兜底前仍然按桥的协议把 base64 发过去（未来桌面版实现后可直接走桥）
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].type, 'canvas/saveExport');
    assert.strictEqual(payloads[0].fileName, '画布.png');
    assert.strictEqual(payloads[0].mime, 'image/png');
    assert.strictEqual(payloads[0].base64, Buffer.from(bytes).toString('base64'));
}

async function testBridgeSuccess() {
    const downloads = [];
    const savedPath = '/Users/wepingli/Downloads/画布.png';
    const result = await exported.saveCanvasBlob(blob, '画布.png',
        async () => ({ ok: true, path: savedPath, fileName: '画布.png', bytes: bytes.length }),
        () => downloads.push('unexpected'));
    // 桥真落盘了就不该再触发一次浏览器下载（否则会下载两份）
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.via, 'bridge');
    assert.strictEqual(result.path, savedPath);
    assert.strictEqual(result.display, '~/Downloads/画布.png');
    assert.strictEqual(downloads.length, 0);
}

async function testBridgeNoReply() {
    const downloads = [];
    const result = await exported.saveCanvasBlob(blob, 'c.png',
        async () => null,
        (saved, name) => downloads.push(name));
    // 桥没回话（老宿主 / 返回 undefined）同样退回浏览器下载
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.via, 'browser');
    assert.deepStrictEqual(downloads, ['c.png']);
}

async function testBridgeRealFailure() {
    const downloads = [];
    const result = await exported.saveCanvasBlob(blob, 'c.png',
        async () => ({ ok: false, error: 'EACCES', detail: '磁盘没有写入权限' }),
        () => downloads.push('unexpected'));
    // 真正的写盘失败要如实报错，不能假装成功
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'EACCES');
    assert.strictEqual(result.detail, '磁盘没有写入权限');
    assert.strictEqual(downloads.length, 0);
}

function testHelpers() {
    assert.strictEqual(exported.shortenPath('/Users/wepingli/Downloads/a.png'), '~/Downloads/a.png');
    assert.strictEqual(exported.shortenPath('/home/bob/Documents/a.png'), '~/Documents/a.png');
    assert.strictEqual(exported.shortenPath('/tmp/a.png'), '/tmp/a.png');
    assert.strictEqual(exported.shortenPath(null), '');
}

async function testBlobToBase64() {
    const data = new Uint8Array(0x8000 * 2 + 7).map((_, index) => index % 251);
    const encoded = await exported.blobToBase64(new Blob([data], { type: 'image/png' }));
    assert.strictEqual(encoded, Buffer.from(data).toString('base64'));
}

async function testBridgeSaveExportCommand() {
    // 直接驱动 novaiBridge 的 canvas/saveExport：根因就是这个分支不存在
    const clicks = [];
    const realSetTimeout = global.setTimeout;
    // saveExport 里 60 秒后才 revoke，会把 node 进程挂住；测试里立即执行
    global.setTimeout = (fn) => { fn(); return 0; };
    global.window = {};
    global.document = {
        createElement() {
            return {
                href: '', download: '',
                click() { clicks.push({ href: this.href, download: this.download }); },
                remove() {},
            };
        },
        body: { appendChild() {} },
    };
    try {
        const bridge = load('novai-canvas-ui/src/novaiBridge.ts');
        bridge.installNovaiBridge();
        const result = await global.window.novai.canvas.command({
            type: 'canvas/saveExport', fileName: '桥保存.png', mime: 'image/png',
            base64: Buffer.from(bytes).toString('base64'),
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.path, '桥保存.png');
        assert.strictEqual(result.fileName, '桥保存.png');
        assert.strictEqual(result.bytes, bytes.length);
        assert.strictEqual(clicks.length, 1);
        assert.strictEqual(clicks[0].download, '桥保存.png');
        assert(clicks[0].href.startsWith('blob:'), '应该用 Blob URL 触发下载，实际是 ' + clicks[0].href);
    } finally {
        global.setTimeout = realSetTimeout;
        delete global.window;
        delete global.document;
    }
}

(async () => {
    await testBrowserFallback();
    await testBridgeSuccess();
    await testBridgeNoReply();
    await testBridgeRealFailure();
    testHelpers();
    await testBlobToBase64();
    await testBridgeSaveExportCommand();
    console.log('[PASS] 下载画布在浏览器模式下走 <a download> 兜底，宿主桥 canvas/saveExport 可用');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
