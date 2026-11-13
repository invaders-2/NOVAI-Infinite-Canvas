#!/usr/bin/env node
/* 在线素材 / 任意窗口拖进画布（task-1 + task-3）：
   1) 载荷解析：text/uri-list 优先，其次 text/plain、text/html 里的 src，注释行与非 http 地址丢弃；
   2) 桌面兜底桥：拿不到地址要在有限时间内给提示，不能把整次 drop 静默挂死；
   3) 桌面字节通道（task-3）：Pinterest 的 originals 对后端下载回 403 / 连不通，
      主进程预取到的字节要优先走 import-urls 的 items[].data 内联通道，字节不可用才回退 URL 下载；
   4) 落点兜底：画布只给 #vp 标了落点，松手落在它上面的浮层（在线素材面板、左栏按钮）时浏览器会
      直接取消 drop（事件都不发），必须有文档级兜底并复用同一份落点处理、且不重复处理 #vp。
   跑法：node tests/test_novai_canvas_source_drop.js */
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const SRC = 'novai-canvas-ui/src/canvas/canvas-next/ui';
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function load(entry) {
    const build = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const m = { exports: {} };
    new Function('module', 'exports', 'require', build.outputFiles[0].text)(m, m.exports, require);
    return m.exports;
}

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

/* 极简 DataTransfer 替身：只实现被用到的 getData */
const dt = (data) => ({ getData: (type) => (Object.prototype.hasOwnProperty.call(data, type) ? data[type] : '') });

/* 假 store：只实现落节点用到的接口 */
function fakeStore() {
    const nodes = [];
    let seq = 0;
    return {
        nodes,
        toasts: [],
        toast(text) { this.toasts.push(String(text)); },
        newNode(kind, x, y, patch) { const node = Object.assign({ id: 'n' + (++seq), kind, x, y }, patch || {}); nodes.push(node); return node; },
        addNodes(list) { void list; },
        setUI() {},
    };
}

/* 图片尺寸探测替身（insertSourceRows → probeImage） */
class FakeImage {
    set src(value) { this._src = value; if (typeof this.onload === 'function') this.onload(); }
    get naturalWidth() { return 800; }
    get naturalHeight() { return 600; }
}

const screenshot = () => 'data:image/jpeg;base64,AAAA';
const bytesOk = (url, originalUrl) => ({ ok: true, url, originalUrl, dataUrl: screenshot(), contentType: 'image/jpeg; charset=binary', size: 26839 });
const importedItem = (url) => ({ items: [{ ok: true, item: { url, name: 'x.jpg', kind: 'image', width: 800, height: 600 } }] });

(async () => {
    console.log('[1] 拖拽载荷解析');
    const srcDrop = load(SRC + '/sourceDrop.ts');
    const fromDt = srcDrop.urlsFromDataTransfer;
    ok(JSON.stringify(fromDt(dt({ 'text/uri-list': 'https://i.pinimg.com/a.jpg' }))) === JSON.stringify(['https://i.pinimg.com/a.jpg']), 'uri-list 直取');
    ok(JSON.stringify(fromDt(dt({ 'text/uri-list': '# 注释\r\nhttps://a/1.jpg\r\nhttps://a/2.jpg' }))) === JSON.stringify(['https://a/1.jpg', 'https://a/2.jpg']), 'uri-list 多行 + # 注释行跳过');
    ok(JSON.stringify(fromDt(dt({ 'text/uri-list': '', 'text/plain': 'https://b/1.png' }))) === JSON.stringify(['https://b/1.png']), 'uri-list 为空才用 text/plain');
    ok(JSON.stringify(fromDt(dt({ 'text/html': '<img src="https://c/1.jpg"><a href="https://c/2.mp4">x</a>' }))) === JSON.stringify(['https://c/1.jpg', 'https://c/2.mp4']), 'text/html 里的 src/href 兜底');
    ok(JSON.stringify(fromDt(dt({ 'text/uri-list': 'https://d/1.jpg\r\nhttps://d/1.jpg' }))) === JSON.stringify(['https://d/1.jpg']), '重复地址去重');
    ok(fromDt(dt({ 'text/plain': 'file:///tmp/a.png' })).length === 0, '非 http 地址丢弃');
    ok(fromDt(dt({ 'text/uri-list': 'data:image/png;base64,AAA' })).length === 1, 'data:image 允许（页面内截图/粘贴）');
    ok(fromDt(null).length === 0 && fromDt(undefined).length === 0, '没有 dataTransfer 时返回空');

    global.Image = FakeImage;

    console.log('[2] 桌面兜底桥：不回包也必须给提示（不能静默挂死）');
    const store = fakeStore();
    const startedAt = Date.now();
    global.window = { pywebview: { api: { get_last_guest_drag: () => new Promise(() => {}) } } };
    const hangRun = srcDrop.dropSourceUrls(store, { x: 0, y: 0 }, dt({}));
    const settled = await Promise.race([
        hangRun.then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
    ]);
    const elapsed = Date.now() - startedAt;
    ok(settled === 'done', '桥永不 resolve 时 drop 仍在限定时间内结束（修复前会挂死）');
    ok(elapsed < 3500, '结束时间受上限约束（实测 ' + elapsed + 'ms）');
    ok(store.toasts.some((t) => t.indexOf('没读到拖进来的素材地址') >= 0), '给用户可操作提示，而不是毫无反应');

    console.log('[3] 只有拖拽记录（没有字节通道）：按 URL 导入');
    const store2 = fakeStore();
    const drag = { bestUrl: 'https://i.pinimg.com/originals/x.jpg', uriList: 'https://i.pinimg.com/originals/x.jpg', imageCandidates: [{ url: 'https://i.pinimg.com/originals/x.jpg', w: 0 }] };
    global.window = { pywebview: { api: { get_last_guest_drag: async () => ({ ok: true, drag }) } } };
    let requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => importedItem('/assets/uploads/x.jpg') }; };
    await srcDrop.dropSourceUrls(store2, { x: 100, y: 100 }, dt({}));
    ok(requests.length === 1 && requests[0].url === '/api/local-assets/import-urls', '走 import-urls 落盘');
    ok(requests[0].body.items[0].url === 'https://i.pinimg.com/originals/x.jpg' && requests[0].body.items[0].data === undefined, '只带地址（URL 通道）');
    ok(store2.nodes.length === 1, '导入成功后落一个节点');
    ok(store2.toasts.some((t) => t.indexOf('已从在线素材添加') >= 0), '成功提示');

    console.log('[4] 桌面字节通道优先（task-3：Pinterest originals 下载 403）');
    const store3 = fakeStore();
    const pinDrag = { bestUrl: 'https://i.pinimg.com/originals/ab/x.jpg', uriList: 'https://i.pinimg.com/originals/ab/x.jpg', imageCandidates: [{ url: 'https://i.pinimg.com/originals/ab/x.jpg', w: 0 }, { url: 'https://i.pinimg.com/736x/ab/x.jpg', w: 0 }] };
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: pinDrag }),
        get_guest_drag_bytes: async () => bytesOk('https://i.pinimg.com/736x/ab/x.jpg', 'https://i.pinimg.com/originals/ab/x.jpg'),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => importedItem('/assets/uploads/pin.jpg') }; };
    await srcDrop.dropSourceUrls(store3, { x: 10, y: 10 }, dt({}));
    const bytesBody = requests[0] && requests[0].body.items[0];
    ok(requests.length === 1, '字节通道成功时不再走 URL 下载（不会重复落节点）');
    ok(bytesBody && bytesBody.data === screenshot(), 'items[0].data 带内联字节');
    ok(bytesBody && bytesBody.content_type === 'image/jpeg', 'content_type 去掉 charset 后传');
    ok(bytesBody && bytesBody.url === 'https://i.pinimg.com/originals/ab/x.jpg', 'url 仍带原图地址（后端命名 / 记录用）');
    ok(store3.nodes.length === 1, '字节通道落一个节点');
    ok(store3.toasts.some((t) => t.indexOf('已从在线素材添加') >= 0), '字节通道成功提示');

    console.log('[5] 字节通道失败：回退 URL 下载');
    const store4 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: pinDrag }),
        get_guest_drag_bytes: async () => ({ ok: false, error: 'HTTP 403' }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => importedItem('/assets/uploads/pin2.jpg') }; };
    await srcDrop.dropSourceUrls(store4, { x: 10, y: 10 }, dt({}));
    ok(requests.length === 1 && requests[0].body.items[0].data === undefined, '回退成只带地址的 URL 通道');
    ok(store4.nodes.length === 1, 'URL 通道也能落节点');
    ok(!store4.toasts.some((t) => t.indexOf('在线素材导入失败') >= 0), 'URL 通道成功时不该报失败');

    console.log('[6] 两条通道都失败：提示里能看出原因');
    const store5 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: pinDrag }),
        get_guest_drag_bytes: async () => ({ ok: false, error: 'HTTP 403' }),
    } } };
    global.fetch = async () => ({ ok: true, json: async () => ({ items: [{ ok: false, error: '下载失败：ConnectTimeout' }] }) });
    await srcDrop.dropSourceUrls(store5, { x: 10, y: 10 }, dt({}));
    const failText = store5.toasts.find((t) => t.indexOf('在线素材导入失败') >= 0) || '';
    ok(!!failText, '两条都失败要有失败提示');
    ok(failText.indexOf('字节通道：HTTP 403') >= 0, '提示里有字节通道的原因');
    ok(failText.indexOf('下载失败：ConnectTimeout') >= 0, '提示里有 URL 下载的原因');
    ok(store5.nodes.length === 0, '失败时不落节点');

    console.log('[7] 字节属于另一张图：不用（宁可下载也不落错图）');
    const store6 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: pinDrag }),
        get_guest_drag_bytes: async () => bytesOk('https://i.pinimg.com/736x/zz/other.jpg', 'https://i.pinimg.com/originals/zz/other.jpg'),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => importedItem('/assets/uploads/x.jpg') }; };
    await srcDrop.dropSourceUrls(store6, { x: 10, y: 10 }, dt({}));
    ok(requests[0] && requests[0].body.items[0].data === undefined, '主路径不同 → 弃用字节，改走 URL 通道');
    ok(requests[0] && requests[0].body.items[0].url === 'https://i.pinimg.com/originals/ab/x.jpg', 'URL 通道用本次拖拽的地址');

    console.log('[8] 落点兜底接线（Viewport.tsx）');
    const viewport = read(SRC + '/Viewport.tsx');
    ok(/const dropPayload = useCallback\(/.test(viewport), '落点处理抽成 dropPayload 一份，@vp 与文档级共用');
    ok(/document\.addEventListener\("dragover", allow\)/.test(viewport), '文档级 dragover 兜底');
    ok(/document\.addEventListener\("drop", onDrop\)/.test(viewport), '文档级 drop 兜底');
    ok(/removeEventListener\("dragover", allow\)/.test(viewport) && /removeEventListener\("drop", onDrop\)/.test(viewport), '卸载时移除监听');
    ok(/const editable = \(target: EventTarget \| null\) => target instanceof Element && !!target\.closest\("input,textarea,\[contenteditable='true'\],\[contenteditable=''\]"\)/.test(viewport), '输入框 / 可编辑区有专门判定（target 先过 instanceof Element）');
    ok(/if \(!e\.defaultPrevented && !editable\(e\.target\) && e\.dataTransfer\) e\.preventDefault\(\)/.test(viewport), 'dragover 只在没人处理、且不在可编辑区时 preventDefault');
    ok(/if \(e\.defaultPrevented \|\| editable\(e\.target\) \|\| !e\.dataTransfer\) return;/.test(viewport), 'drop 已被 React 处理过或落在可编辑区就不再插手（不重复落节点、不抢默认插入）');
    ok(/onDrop=\{\(e\) => \{ e\.preventDefault\(\); dropPayload\(e\); \}\}/.test(viewport), '#vp 的 onDrop 复用 dropPayload');
    ok(!/const files = \[\.\.\.\(e\.dataTransfer\?\.files \|\| \[\]\)\]; if \(files\.length\) void addFiles/.test(viewport), '没有第二份内联落点逻辑');

    console.log('[9] 等待上限：取记录 1.2s，取字节单独一套');
    const sourceDropSrc = read(SRC + '/sourceDrop.ts');
    ok(/const GUEST_DRAG_TIMEOUT_MS = 1200;/.test(sourceDropSrc), 'get_last_guest_drag 保持 1.2s 上限');
    ok(/const GUEST_BYTES_TIMEOUT_MS = (\d+);/.test(sourceDropSrc) && Number(RegExp.$1) > 5000, '字节等待有独立的、更大的上限（不复用 1.2s）');
    ok(/api\.get_guest_drag_bytes\(\)/.test(sourceDropSrc), '调用真实桥方法 get_guest_drag_bytes');
    ok(/data: bytes\.bytes\.dataUrl/.test(sourceDropSrc), '字节进 items[].data 内联通道');

    console.log('[10] 后端下载失败文案（server/routes/assets.py）');
    const assets = read('server/routes/assets.py');
    ok(/下载失败：HTTP \{status\}/.test(assets), 'HTTP 状态带进错误（例：下载失败：HTTP 403）');
    ok(/下载失败：\{kind\}/.test(assets) || /下载失败：\{kind\} \{detail\}/.test(assets), '非 HTTP 异常带异常类型（例：下载失败：ConnectError）');
    ok(!/result\["error"\] = str\(exc\) or "导入失败"/.test(assets), '不再把异常吞成一句「导入失败」');

    console.log('');
    if (fails.length) {
        console.error('[FAIL] ' + fails.length + ' 项失败：');
        fails.forEach((f) => console.error('  - ' + f));
        process.exit(1);
    }
    console.log('[PASS] ' + pass + ' 项断言全部通过');
})().catch((err) => { console.error('[FAIL] 异常：', err); process.exit(1); });
