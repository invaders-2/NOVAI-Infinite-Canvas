#!/usr/bin/env node
'use strict';
/*
 * 智能画布BEAT 工作流导入 / 导出（task-2）：
 *   1) 选中切片只含选中节点与内部连线，无选中回退整张画布；
 *   2) 媒体节点结果地址收集去重（url / frame / node.url 退化）；
 *   3) 资源清单生成 / 解析、导入时旧地址 → 新地址替换；
 *   4) makeZip → readZip 往返（中文名 / 多文件 / store+deflate）、坏包报错；
 *   5) UI 源码里确实有「新建画布」菜单项、面板按钮、拖拽区与 createCanvas 接口。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');
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

const bundle = load('novai-canvas-ui/src/canvas/canvas-next/workflowBundle.ts');
const zipLib = load('novai-canvas-ui/src/canvas/canvas-next/zip.ts');

const node = (id, kind, extra = {}) => ({ id, kind, x: 0, y: 0, w: 200, h: 200, text: extra.title || '', ...extra });
const doc = {
    nodes: [
        node('n1', 'text', { text: '脚本', data: { gen: { title: '脚本', prompt: '写脚本', hist: [{ text: '正文' }], hi: 0 } } }),
        node('n2', 'image', { text: '商品图', url: '/output/a.png', data: { gen: { title: '商品图', prompt: '参考 @{n1}', hist: [{ url: '/output/a.png' }], hi: 0 } } }),
        node('n3', 'video', { text: '短片', url: '/output/c.mp4', data: { gen: { title: '短片', hist: [{ url: '/output/c.mp4', frame: '/output/c.jpg' }], hi: 0 } } }),
        node('n4', 'text', { text: '尾注', data: { gen: { title: '尾注', hist: [{ text: '结束' }], hi: 0 } } }),
    ],
    edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
        { id: 'e3', from: 'n3', to: 'n4' },
    ],
    comments: [{ id: 'c1', x: 0, y: 0, text: '批注', createdAt: 1, clientId: 'x' }],
};

/* ---------- 1. 选中切片 ---------- */
const whole = bundle.sliceWorkflowDoc(doc, []);
assert.strictEqual(whole.selected, false);
assert.strictEqual(whole.nodeCount, 4);
assert.strictEqual(whole.edgeCount, 3);
assert.strictEqual(whole.doc, doc, '无选中必须原样回退整张画布（保留旧能力）');
assert.strictEqual(bundle.sliceWorkflowDoc(doc, new Set()).selected, false, '空选中集合同样回退全部');

const single = bundle.sliceWorkflowDoc(doc, ['n2']);
assert.strictEqual(single.selected, true);
assert.strictEqual(single.nodeCount, 1);
assert.strictEqual(single.edgeCount, 0, '跨出选中范围的连线不能带进切片');
assert.deepStrictEqual(single.doc.nodes.map((n) => n.id), ['n2']);
assert.strictEqual(single.doc.comments.length, 0, '选中切片不带画布级的评论');

const part = bundle.sliceWorkflowDoc(doc, new Set(['n1', 'n2', 'n3']));
assert.strictEqual(part.nodeCount, 3);
assert.strictEqual(part.edgeCount, 2);
assert.deepStrictEqual(part.doc.edges.map((e) => e.id), ['e1', 'e2']);
assert(!part.doc.nodes.some((n) => n.id === 'n4'));

const unknown = bundle.sliceWorkflowDoc(doc, ['nope']);
assert.strictEqual(unknown.selected, false, '不存在的 id 不算选中');
assert.strictEqual(unknown.nodeCount, 4);

/* ---------- 2. 媒体地址收集 / 去重 ---------- */
const mediaDoc = {
    nodes: [
        node('a', 'image', { url: '/output/a.png', data: { gen: { title: '商品图', hist: [{ url: '/output/a.png' }], hi: 0 } } }),
        node('b', 'image', { url: '/output/a.png', data: { gen: { title: '同图', hist: [{ url: '/output/a.png' }], hi: 0 } } }),
        node('c', 'video', { data: { gen: { title: '短片', hist: [{ url: '/output/c.mp4', frame: '/output/c.jpg' }], hi: 0 } } }),
        node('d', 'video', { url: '/output/d.mp4', data: { gen: { title: '旧视频' } } }),
        node('e', 'text', { url: '/output/e.txt', data: { gen: { title: '文本', hist: [{ text: '正文' }], hi: 0 } } }),
        node('f', 'audio', { data: { gen: { title: '配乐', hist: [{ url: '/output/f.mp3' }], hi: 0 } } }),
        node('g', 'image', { data: { gen: { title: '没结果', hist: [], hi: 0 } } }),
    ],
    edges: [],
    comments: [],
};
const refs = bundle.collectMediaRefs(mediaDoc);
assert.strictEqual(refs.length, 4, '同一地址只打包一次，文本 / 空结果不算资源');
assert.deepStrictEqual(refs[0].nodeIds, ['a', 'b']);
assert.strictEqual(refs[0].url, '/output/a.png');
const refC = refs.find((r) => r.nodeIds[0] === 'c');
assert.strictEqual(refC.url, '/output/c.mp4', '视频优先用成片地址，不是首帧缩略图');
assert.strictEqual(refC.ext, 'mp4');
assert.strictEqual(refs.find((r) => r.nodeIds[0] === 'd').url, '/output/d.mp4', '没有 gen.hist 的旧节点退化到 node.url');
assert.strictEqual(refs.find((r) => r.nodeIds[0] === 'f').kind, 'audio');
assert(!refs.some((r) => r.url === '/output/e.txt'));
assert(!refs.some((r) => r.nodeIds[0] === 'g'));

/* ---------- 3. 资源文件名 / 清单 / 地址映射 ---------- */
assert.strictEqual(bundle.assetFileName(0, '商品图', 'png'), 'assets/001-商品图.png');
assert.strictEqual(bundle.assetFileName(9, 'a/b:c', 'jpeg'), 'assets/010-a-b-c.jpeg');
assert.strictEqual(bundle.assetFileName(1, '', 'mp4'), 'assets/002-asset.mp4');
assert.strictEqual(bundle.safeAssetPart('   '), 'asset');

const manifest = bundle.buildAssetManifest([{ url: '/old/a.png', file: 'assets/001-商品图.png', name: '商品图', kind: 'image' }]);
assert.strictEqual(manifest.schema, bundle.ASSET_SCHEMA);
assert.strictEqual(manifest.workflow, 'workflow.json');
const parsedManifest = bundle.parseAssetManifest(JSON.stringify(manifest));
assert.deepStrictEqual(parsedManifest.assets, manifest.assets);
assert.strictEqual(bundle.parseAssetManifest('{"assets":[{"url":"u","file":"f","name":"n","kind":"video"},{"nope":1}]}').assets.length, 1);
assert.throws(() => bundle.parseAssetManifest('{bad json'), /JSON/);
assert.strictEqual(bundle.zipEntryKey('./assets/001-A.PNG'), 'assets/001-a.png');
assert.strictEqual(bundle.zipEntryKey('assets\\001-商品图.png'), 'assets/001-商品图.png');

const wfDoc = {
    nodes: [{ id: 'n1', kind: 'image', x: 0, y: 0, w: 100, h: 100, text: '图', url: '/old/a.png', data: { gen: { prompt: '参考 /old/a.png 生成', hist: [{ url: '/old/a.png' }], hi: 0 } } }],
    edges: [], comments: [],
};
const mapped = bundle.mapWorkflowUrls(wfDoc, new Map([['/old/a.png', '/new/a-1.png']]));
assert.strictEqual(mapped.nodes[0].url, '/new/a-1.png');
assert.strictEqual(mapped.nodes[0].data.gen.hist[0].url, '/new/a-1.png');
assert(mapped.nodes[0].data.gen.prompt.includes('/new/a-1.png'), '提示词里嵌着的旧地址也要换掉');
assert.strictEqual(wfDoc.nodes[0].url, '/old/a.png', '映射不能改原文档');
const unchanged = bundle.mapWorkflowUrls(wfDoc, new Map());
assert.strictEqual(unchanged, wfDoc, '没有映射时原样返回');

/* ---------- 4. ZIP 往返 ---------- */
const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);

function makeDeflatedZip(files) {
    const chunks = []; const central = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(enc(file.name));
        const data = Buffer.from(file.data);
        const comp = zlib.deflateRawSync(data);
        const crc = zipLib.crc32(new Uint8Array(data));
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
        chunks.push(local, name, comp);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
        cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
        cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
        central.push(cen, name);
        offset += 30 + name.length + comp.length;
    }
    const size = central.reduce((sum, buf) => sum + buf.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

(async () => {
    const files = [
        { name: 'workflow.json', data: enc('{"title":"测试工作流"}') },
        { name: 'manifest.json', data: enc('{"schema":"x","assets":[]}') },
        { name: 'assets/001-商品图.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
        { name: 'assets/002-短片.mp4', data: new Uint8Array(4096).fill(7) },
    ];
    const zip = await zipLib.makeZip(files);
    assert(zip.size > 0);
    const entries = await zipLib.readZip(zip);
    assert.strictEqual(entries.length, 4, 'makeZip → readZip 条目数一致');
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
    assert.strictEqual(dec(byName.get('workflow.json')), '{"title":"测试工作流"}');
    assert.strictEqual(dec(byName.get('manifest.json')), '{"schema":"x","assets":[]}');
    assert.deepStrictEqual([...byName.get('assets/001-商品图.png')], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.strictEqual(byName.get('assets/002-短片.mp4').length, 4096);
    assert.strictEqual(byName.get('assets/002-短片.mp4')[0], 7);

    // deflate(8) 分支：Node 侧造一个压缩包，readZip 必须能解
    const deflated = makeDeflatedZip([{ name: 'workflow.json', data: enc('{"压缩":"中文"}') }, { name: 'assets/长文件名.png', data: new Uint8Array(1024).fill(3) }]);
    const compressed = await zipLib.readZip(deflated);
    assert.strictEqual(compressed.length, 2);
    assert.strictEqual(dec(compressed.find((entry) => entry.name === 'workflow.json').data), '{"压缩":"中文"}');
    assert.strictEqual(compressed.find((entry) => entry.name === 'assets/长文件名.png').data.length, 1024);

    // ArrayBuffer / Uint8Array 入参都认
    assert.strictEqual((await zipLib.readZip(deflated.buffer)).length, 2);

    await assert.rejects(() => zipLib.readZip(new Uint8Array([1, 2, 3, 4])), /ZIP/);
    const textBytes = enc('这不是 ZIP');
    await assert.rejects(() => zipLib.readZip(textBytes), /ZIP/);
    await assert.rejects(() => zipLib.readZip(zip.slice(0, 12)), /ZIP/);

    // 含资源的 ZIP 导出 → 导入流程（读包 → 清单 → 地址映射）
    const imageDoc = {
        nodes: [{ id: 'n1', kind: 'image', x: 0, y: 0, w: 100, h: 100, text: '图', url: '/old/img.png', data: { gen: { title: '图', hist: [{ url: '/old/img.png' }], hi: 0 } } }],
        edges: [], comments: [],
    };
    const workflowText = JSON.stringify({ schema: 'novai.canvas-workflow/v1', title: '测试', doc: imageDoc });
    const pack = await zipLib.makeZip([
        { name: bundle.WORKFLOW_JSON, data: enc(workflowText) },
        { name: bundle.MANIFEST_JSON, data: enc(JSON.stringify(bundle.buildAssetManifest([{ url: '/old/img.png', file: 'assets/001-图.png', name: '图', kind: 'image' }]))) },
        { name: 'assets/001-图.png', data: new Uint8Array([9, 9, 9]) },
    ]);
    const unpacked = await zipLib.readZip(pack);
    const keyed = new Map(unpacked.map((entry) => [bundle.zipEntryKey(entry.name), entry.data]));
    assert(keyed.has(bundle.zipEntryKey('workflow.json')) && keyed.has(bundle.zipEntryKey('assets/001-图.png')));
    const importedManifest = bundle.parseAssetManifest(dec(keyed.get(bundle.zipEntryKey('manifest.json'))));
    assert.strictEqual(importedManifest.assets[0].file, 'assets/001-图.png');
    const remapped = bundle.mapWorkflowUrls(JSON.parse(dec(keyed.get(bundle.zipEntryKey('workflow.json')))).doc, new Map([[importedManifest.assets[0].url, '/new/img-1.png']]));
    assert.strictEqual(remapped.nodes[0].url, '/new/img-1.png');

    /* ---------- 5. UI 源码断言 ---------- */
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const chrome = read('novai-canvas-ui/src/canvas/canvas-next/ui/Chrome.tsx');
    const ctx = read('novai-canvas-ui/src/canvas/canvas-next/ui/ctx.tsx');
    const main = read('novai-canvas-ui/src/main.tsx');
    const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
    assert(chrome.includes('data-menu="new-canvas"'), '画布菜单要有「新建画布」');
    assert(chrome.includes('createCanvas!'), '「新建画布」要调用宿主注入的 createCanvas');
    assert(!chrome.includes('空白经典画布'), '「新建画布」不再带右侧小字（菜单宽度固定，避免被截断）');
    assert(chrome.includes('data-wf="export-json"') && chrome.includes('data-wf="export-assets"'), '面板要有两个导出按钮');
    assert(chrome.includes('className="btn" data-wf="export-json"'), '「导出 JSON」是次要按钮（btn）');
    assert(chrome.includes('className="btn solid" data-wf="export-assets"'), '「导出并包含资源」是主按钮（btn solid 白色胶囊）');
    assert(!chrome.includes('工作流已导出（'), '导出成功 toast 不再重复「工作流已导出（已导出 …）」');
    assert(chrome.includes('disabled={busy !== "" || !slice.nodeCount} onClick={exportJson}') && chrome.includes('disabled={busy !== "" || !slice.nodeCount} onClick={() => void exportAssets()}'), '打包/导入进行中两个导出按钮都 disabled');
    assert(chrome.includes('data-wf="import-drop"'), '面板要有拖拽导入区');
    assert(chrome.includes('拖入 JSON / ZIP 工作流') && chrome.includes('或点击选择文件'), '拖拽区文案');
    assert(chrome.includes('使用当前选中的节点和它们之间的连线生成工作流。'), '导出说明');
    assert(chrome.includes('支持工作流 JSON，也支持包含资源的 ZIP 包。导入内容会追加到当前画布。'), '导入说明');
    assert(chrome.includes('openWorkflowPanel') && chrome.includes('onDragOver') && chrome.includes('onDrop'), '菜单打开同一面板 + 拖拽事件');
    assert(chrome.includes('data-menu="export-workflow"') && chrome.includes('data-menu="import-workflow"'), '既有 data-menu 属性保持不变');
    assert(ctx.includes('createCanvas?:'), 'HostActions 要有可选 createCanvas');
    assert(main.includes('createCanvas') && main.includes('fetch("/api/canvases"') && /method: "POST"/.test(main), 'main.tsx 实现 createCanvas 且走 POST /api/canvases');
    assert(main.includes('board_x: 40') && main.includes('board_y: 40') && main.includes('icon: "🧩"'), '新建画布参数（icon / 坐标）');
    assert(css.includes('.cn-root .wf-drop') && css.includes('.cn-root .wf-status') && css.includes('.cn-root .wf-acts'), '面板样式');
    const wfCss = css.slice(css.indexOf('/* ---------- 工作流导入 / 导出面板 ---------- */'));
    assert(wfCss.length > 0 && css.includes('.cn-root .wf-sec'), '面板样式段落在');
    assert(!/border/.test(wfCss.replace(/border-radius/g, '')), '面板样式不许用 border 表达层级');
    assert(!/inset/.test(wfCss), '面板样式不许用 inset 阴影表达层级');

    console.log('[PASS] 智能画布BEAT 工作流导入导出（选中切片 / 去重 / URL 映射 / ZIP 读写 / 新建画布菜单）');
})().catch((error) => { console.error(error); process.exit(1); });
