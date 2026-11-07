'use strict';
/**
 * T49 局域网分享测试：
 *  1) 用 esbuild 直接单测 shareDoc.ts 的纯函数（令牌解析 / 快照映射 / 错误文案）；
 *  2) spawn python 跑 tests/test_canvas_share_store.py（真实 FastAPI 路由 + JSON 存取 + 权限 / 过期 / 撤销 / 克隆 / 路径脱敏）。
 * 没有能 import fastapi 的 python 时跳过后端部分并给出提示（与 test_canvas_gen_pipe.js 同款降级）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(root, 'novai-canvas-ui/node_modules/esbuild'));

function loadTs(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        write: false,
        tsconfig: path.join(root, 'novai-canvas-ui/tsconfig.json'),
    });
    const loaded = new Module('novai-share-doc');
    loaded.paths = Module._nodeModulePaths(root);
    loaded._compile(result.outputFiles[0].text, 'shareDoc.cjs');
    return loaded.exports;
}

function testShareDoc() {
    const { parseShareToken, parseShareLink, isRemoteShareUrl, previewDocOf, permissionLabel, shareErrorMessage } = loadTs('novai-canvas-ui/src/canvas/canvas-next/ui/shareDoc.ts');

    const token = 'qQo0CAug0xD9Rf76R2uoBQAblLVIoVH1794018389419';
    assert.equal(parseShareToken('http://192.168.1.8:3000/static/canvas.html?share=' + token), token);
    assert.equal(parseShareToken('http://192.168.1.8:3000/static/canvas.html?share=' + token + '&token=lan'), token);
    assert.equal(parseShareToken('https://x.test/c?foo=1&share=' + token), token);
    assert.equal(parseShareToken(token), token);
    assert.equal(parseShareToken('  ' + token + '  '), token);
    assert.equal(parseShareToken('http://192.168.1.8:3000/static/canvas.html'), '');
    assert.equal(parseShareToken('hello'), '');
    assert.equal(parseShareToken(''), '');
    assert.equal(parseShareToken(null), '');

    assert.equal(permissionLabel('view'), '仅查看');
    assert.equal(permissionLabel('clone'), '可克隆到画布');
    assert.equal(permissionLabel('template'), '可存为模板');
    assert.equal(permissionLabel('other'), '仅查看');

    assert.ok(shareErrorMessage(404).includes('无效'));
    assert.ok(shareErrorMessage(410).includes('过期'));
    assert.ok(shareErrorMessage(0).includes('局域网'));
    assert.ok(shareErrorMessage(403, '自定义').includes('自定义'));
    assert.ok(shareErrorMessage(400, '').includes('分享链接'));
    assert.ok(shareErrorMessage(401, '').includes('口令'));
    assert.ok(shareErrorMessage(413, '').includes('分享快照上限'));
    assert.ok(shareErrorMessage(504, '').includes('超时'));
    assert.ok(shareErrorMessage(502, '').includes('局域网'));
    assert.ok(shareErrorMessage(502, '对方离线').includes('对方离线'));

    // T53：完整 URL / ?share= / /api/canvas-share/<token> / 裸 token 三种输入
    const local = '192.168.1.5:3000';
    const remoteUrl = 'http://192.168.1.9:3000/static/canvas.html?share=' + token + '&token=lan';
    const sameUrl = 'http://192.168.1.5:3000/static/canvas.html?share=' + token + '&token=lan';
    const parsedRemote = parseShareLink(remoteUrl, local);
    assert.equal(parsedRemote.token, token);
    assert.equal(parsedRemote.remote, true);
    assert.equal(parsedRemote.origin, 'http://192.168.1.9:3000');
    assert.equal(parsedRemote.host, '192.168.1.9:3000');
    assert.equal(parsedRemote.error, '');
    const parsedSame = parseShareLink(sameUrl, local);
    assert.equal(parsedSame.token, token);
    assert.equal(parsedSame.remote, false);
    // 主机相同、端口不同 → 远端（避免 127.0.0.1:3999 vs 127.0.0.1 误判）
    assert.equal(parseShareLink('http://192.168.1.5:3999/static/canvas.html?share=' + token, local).remote, true);
    assert.equal(parseShareLink('http://192.168.1.5:3000/static/canvas.html?share=' + token, '192.168.1.5').remote, true);
    const parsedApi = parseShareLink('http://192.168.1.9:3000/api/canvas-share/' + token, local);
    assert.equal(parsedApi.token, token);
    assert.equal(parsedApi.remote, true);
    const parsedBare = parseShareLink(token, local);
    assert.equal(parsedBare.token, token);
    assert.equal(parsedBare.url, '');
    assert.equal(parsedBare.remote, false);
    const parsedPath = parseShareLink('?share=' + token + '&token=lan', local);
    assert.equal(parsedPath.token, token);
    assert.equal(parsedPath.remote, false);
    const parsedApiPath = parseShareLink('/api/canvas-share/' + token, local);
    assert.equal(parsedApiPath.token, token);
    assert.equal(parsedApiPath.remote, false);
    assert.ok(parseShareLink('hello', local).error.includes('分享链接'));
    assert.ok(parseShareLink('http://192.168.1.9:3000/static/canvas.html', local).error.includes('令牌'));
    assert.equal(isRemoteShareUrl(remoteUrl, local), true);
    assert.equal(isRemoteShareUrl(sameUrl, local), false);
    assert.equal(isRemoteShareUrl(token, local), false);

    const doc = {
        nodes: [
            { id: 'a', kind: 'image', x: 0, y: 0, w: 320, h: 240, text: '',
              data: { gen: { title: '主图', prompt: '白色背景', params: { ratio: '1:1' }, hist: [{ url: '/output/a.png' }], hi: 0 } } },
            { id: 'b', kind: 'video', x: 400, y: 0, w: 320, h: 320, text: '',
              data: { gen: { params: { ratio: '16:9' }, hist: [{ url: '/output/b.mp4', frame: '/output/b.jpg' }], hi: 0 } } },
            { id: 'c', kind: 'text', x: 0, y: 400, w: 320, h: 200, text: '第一行\n第二行',
              data: { gen: { hist: [{ text: '生成出来的正文' }], hi: 0 } } },
            { id: 'd', kind: 'table', x: 400, y: 400, w: 320, h: 160, text: '需求表',
              data: { table: { title: '需求表', columns: ['卖点'], rows: [['轻']] } } },
            { id: 'e', kind: 'note', x: 0, y: 700, w: 220, h: 168, text: '便签内容' },
            { id: 'f', kind: 'group', x: 800, y: 0, w: 320, h: 240, text: '分组', children: ['a'] },
        ],
        edges: [
            { id: 'e1', from: 'c', to: 'a' },
            { id: 'e2', from: 'a', to: 'ghost' },
            { id: 'e3', from: 'a', to: 'a' },
        ],
        comments: [],
    };
    const preview = previewDocOf(doc);
    assert.equal(preview.nodes.length, 6);
    const byId = new Map(preview.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get('a').title, '主图');
    assert.equal(byId.get('a').cover, '/output/a.png');
    assert.equal(byId.get('a').prompt, '白色背景');
    assert.equal(byId.get('a').params.ratio, '1:1');
    assert.equal(byId.get('a').x, 0);
    assert.equal(byId.get('a').w, 320);
    assert.equal(byId.get('b').cover, '/output/b.jpg');
    assert.equal(byId.get('b').kind, 'video');
    assert.equal(byId.get('c').kind, 'text');
    assert.equal(byId.get('c').text, '生成出来的正文');
    assert.equal(byId.get('c').title, '第一行');
    assert.equal(byId.get('d').kind, 'table');
    assert.equal(byId.get('d').table.title, '需求表');
    assert.equal(byId.get('e').kind, 'text');
    assert.equal(byId.get('e').text, '便签内容');
    assert.equal(byId.get('f').kind, 'text');
    assert.equal(preview.edges.length, 1);
    assert.deepEqual(preview.edges[0], { id: 'e1', from: 'c', to: 'a' });

    assert.deepEqual(previewDocOf(null), { nodes: [], edges: [] });
    console.log('[share-doc] 纯函数用例通过');
}

function testShareMedia() {
    const { mediaUrlsOf, rewriteDocMedia, canonicalMediaUrl, mediaStatsText } = loadTs('novai-canvas-ui/src/canvas/canvas-next/ui/shareMedia.ts');
    const doc = {
        nodes: [
            { id: 'a', kind: 'image', text: '提示词里也有 http://should-not-touch.test/x.png',
              data: { gen: { title: '主图', prompt: '画一只猫 http://prompt.test/a.png',
                             hist: [{ url: 'http://peer:8899/output/a.png?token=t1', frame: 'http://peer:8899/output/a.jpg?token=t1' }], hi: 0 } },
              variants: ['http://peer:8899/output/a.png?token=t1', 'http://peer:8899/output/v2.png'],
              url: 'http://peer:8899/output/a.png?token=t1' },
            { id: 'b', kind: 'video', text: '', url: '/output/local.mp4',
              clips: [{ id: 'c1', url: 'http://peer:8899/output/clip.mp4', mediaKind: 'video' }] },
            { id: 'c', kind: 'scene3d', text: '', data: { scene: { objects: [{ id: 'o1', url: 'http://peer:8899/assets/model.glb' }] } } },
        ],
        edges: [],
        comments: [],
    };
    assert.equal(canonicalMediaUrl('http://peer:8899/output/a.png?token=t1'), 'http://peer:8899/output/a.png');
    const urls = mediaUrlsOf(doc);
    assert.deepEqual(urls, [
        'http://peer:8899/output/a.png?token=t1',
        'http://peer:8899/output/a.jpg?token=t1',
        'http://peer:8899/output/v2.png',
        'http://peer:8899/output/clip.mp4',
        'http://peer:8899/assets/model.glb',
    ]);
    const mapping = new Map([
        ['http://peer:8899/output/a.png', '/assets/uploads/up_a.png'],
        ['http://peer:8899/output/v2.png', '/assets/uploads/up_v2.png'],
        ['http://peer:8899/output/clip.mp4', '/assets/uploads/up_clip.mp4'],
    ]);
    const next = rewriteDocMedia(doc, mapping);
    assert.equal(next.nodes[0].url, '/assets/uploads/up_a.png');
    assert.deepEqual(next.nodes[0].variants, ['/assets/uploads/up_a.png', '/assets/uploads/up_v2.png']);
    assert.equal(next.nodes[0].data.gen.hist[0].url, '/assets/uploads/up_a.png');
    assert.equal(next.nodes[0].data.gen.hist[0].frame, 'http://peer:8899/output/a.jpg?token=t1');
    assert.ok(next.nodes[0].data.gen.prompt.includes('http://prompt.test/a.png'), '提示词文本不能被改');
    assert.equal(next.nodes[1].url, '/output/local.mp4', '相对地址保持不动');
    assert.equal(next.nodes[1].clips[0].url, '/assets/uploads/up_clip.mp4');
    // 入参不被修改
    assert.equal(doc.nodes[0].url, 'http://peer:8899/output/a.png?token=t1');
    assert.equal(mediaStatsText({ copied: 3, failed: 1 }), '复制 3 个资源，1 个失败（保留原地址）');
    assert.equal(mediaStatsText({ copied: 3, failed: 0 }), '复制 3 个资源');
    assert.equal(mediaStatsText({ copied: 0, failed: 0 }), '');
    console.log('[share-media] 纯函数用例通过');
}

function pythonProbe() {
    const candidates = [path.join(root, 'venv/bin/python'), 'python3'];
    for (const bin of candidates) {
        const probe = spawnSync(bin, ['-c', 'import fastapi, fastapi.testclient'], { encoding: 'utf8' });
        if (probe.status === 0) return bin;
    }
    return '';
}

function testBackend() {
    const python = pythonProbe();
    if (!python) {
        console.log('[share-backend] 跳过：没有能 import fastapi 的 python（venv/bin/python 或 python3）');
        return;
    }
    const result = spawnSync(python, [path.join(__dirname, 'test_canvas_share_store.py')], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const output = (result.stdout || '') + (result.stderr || '');
    console.log(output.trim());
    assert.equal(result.status, 0, '后端分享单测退出码 ' + result.status);
}

testShareDoc();
testShareMedia();
testBackend();
console.log('[share] T49 分享测试全部通过');
