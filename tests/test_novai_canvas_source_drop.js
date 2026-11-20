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
        toastMs: [],
        toast(text, ms) { this.toasts.push(String(text)); this.toastMs.push(Number(ms) || 0); },
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

    console.log('[11] 视频只有 blob 载荷：回主进程抓到的视频请求还原真链');
    /* <video> 在 Node 里不存在：probeVideo 只用到 createElement('video') 与元数据事件 */
    class FakeVideo {
        constructor() { this._src = ''; this._duration = 12.5; }
        set src(value) { this._src = value; if (typeof this.onloadedmetadata === 'function') this.onloadedmetadata(); }
        get src() { return this._src; }
        removeAttribute() {}
        load() {}
        get videoWidth() { return 720; }
        get videoHeight() { return 1280; }
        get duration() { return this._duration; }
    }
    global.document = { createElement: (tag) => { if (String(tag) === 'video') return new FakeVideo(); throw new Error('unexpected createElement: ' + tag); } };
    const videoItem = (url) => ({ items: [{ ok: true, item: { url, name: 'xhs-video', kind: 'video' } }] });
    const videoPage = 'https://www.xiaohongshu.com/explore/abc';
    const videoDrag = {
        tagName: 'VIDEO',
        pageUrl: videoPage,
        uriList: 'blob:https://www.xiaohongshu.com/1111',
        bestUrl: 'blob:https://www.xiaohongshu.com/1111',
        mediaUrl: 'blob:https://www.xiaohongshu.com/1111',
        videoUrls: ['blob:https://www.xiaohongshu.com/1111'],
        videoCandidates: [{ url: 'blob:https://www.xiaohongshu.com/1111' }],
        imageCandidates: [],
    };
    const store7 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoDrag }),
        get_recent_source_media: async () => ({ ok: true, items: [
            { url: 'https://sns-video-v6.xhscdn.com/stream/old.mp4', kind: 'video', pageUrl: videoPage, time: 100 },
            { url: 'https://sns-video-v6.xhscdn.com/stream/new.mp4', kind: 'video', pageUrl: videoPage, time: 300 },
            { url: 'https://sns-video-v6.xhscdn.com/stream/other.mp4', kind: 'video', pageUrl: 'https://www.xiaohongshu.com/explore/zzz', time: 500 },
            { url: 'https://i.pinimg.com/a.jpg', kind: 'image', pageUrl: videoPage, time: 600 },
        ] }) } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => videoItem('/assets/uploads/v.mp4') }; };
    await srcDrop.dropSourceUrls(store7, { x: 0, y: 0 }, dt({}));
    ok(requests.length === 1 && requests[0].body.items[0].url === 'https://sns-video-v6.xhscdn.com/stream/new.mp4', '用同页面最新的视频地址还原真链（同页面优先、最新优先）');
    ok(store7.nodes.length === 1 && store7.nodes[0].kind === 'video', '落成一个视频节点（不再是毫无反应）');
    ok(store7.nodes[0] && store7.nodes[0].hist[0].dur === 12.5, '视频节点带真实时长');
    ok(store7.toasts.some((t) => t.indexOf('已从在线素材添加') >= 0), '成功提示');

    console.log('[12] 视频连真链都抓不到：给视频专属提示，不落节点');
    const store8 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoDrag }),
        get_recent_source_media: async () => ({ ok: true, items: [] }),
    } } };
    global.fetch = async () => { throw new Error('没有地址时不该发请求'); };
    await srcDrop.dropSourceUrls(store8, { x: 0, y: 0 }, dt({}));
    ok(store8.nodes.length === 0, '没有地址时不落节点');
    ok(store8.toasts.some((t) => t.indexOf('加密流') >= 0), '提示里说明是加密流抓不到地址');
    ok(!store8.toasts.some((t) => t === '没读到拖进来的素材地址，请从在线素材面板里重新拖一次'), '不再用那句笼统的「没读到地址」糊过去');

    console.log('[13] 地址下载失败 → 页面上下文取字节成功');
    const videoHttpDrag = {
        tagName: 'VIDEO',
        pageUrl: videoPage,
        uriList: 'https://sns-video-v6.xhscdn.com/stream/x.mp4',
        bestUrl: 'https://sns-video-v6.xhscdn.com/stream/x.mp4',
        videoUrls: ['https://sns-video-v6.xhscdn.com/stream/x.mp4'],
    };
    const store9 = fakeStore();
    const pageCalls = [];
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoHttpDrag }),
        get_source_view_fetch_bytes: async (arg) => { pageCalls.push(arg); return { ok: true, dataUrl: 'data:video/mp4;base64,AAAA', contentType: 'video/mp4', size: 4 }; },
    } } };
    requests = [];
    global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url: String(url), body });
        if (body.items[0].data) return { ok: true, json: async () => videoItem('/assets/uploads/v2.mp4') };
        return { ok: true, json: async () => ({ items: [{ ok: false, error: '下载失败：HTTP 403' }] }) };
    };
    await srcDrop.dropSourceUrls(store9, { x: 0, y: 0 }, dt({}));
    ok(pageCalls[0] && pageCalls[0].url === 'https://sns-video-v6.xhscdn.com/stream/x.mp4', '页面取字节用的是这次拖拽的地址');
    ok(requests.length === 2 && requests[1].body.items[0].data === 'data:video/mp4;base64,AAAA', '第二条通道把字节内联给后端');
    ok(store9.nodes.length === 1 && store9.nodes[0].kind === 'video', '兜底成功落视频节点（且只落一个）');

    console.log('[14] 页面取字节也失败 → 主进程带登录态下载成功');
    const store10 = fakeStore();
    const sessionCalls = [];
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoHttpDrag }),
        get_source_view_fetch_bytes: async () => ({ ok: false, error: 'too-large' }),
        fetch_source_url: async (arg) => { sessionCalls.push(arg); return { ok: true, dataUrl: 'data:video/mp4;base64,BBBB', contentType: 'video/mp4' }; },
    } } };
    requests = [];
    global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url: String(url), body });
        if (body.items[0].data) return { ok: true, json: async () => videoItem('/assets/uploads/v3.mp4') };
        return { ok: true, json: async () => ({ items: [{ ok: false, error: '下载失败：HTTP 403' }] }) };
    };
    await srcDrop.dropSourceUrls(store10, { x: 0, y: 0 }, dt({}));
    ok(sessionCalls[0] && sessionCalls[0].url === 'https://sns-video-v6.xhscdn.com/stream/x.mp4', '带登录态下载用这次拖拽的地址');
    ok(requests.length === 2 && requests[1].body.items[0].data === 'data:video/mp4;base64,BBBB', '登录态通道同样走内联字节');
    ok(store10.nodes.length === 1, '登录态兜底也能落节点');

    console.log('[15] 三条通道全失败：提示里能看出各自的原因');
    const store11 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoHttpDrag }),
        get_source_view_fetch_bytes: async () => ({ ok: false, error: 'too-large' }),
        fetch_source_url: async () => ({ ok: false, error: 'HTTP 403' }),
    } } };
    global.fetch = async () => ({ ok: true, json: async () => ({ items: [{ ok: false, error: '下载失败：ConnectTimeout' }] }) });
    await srcDrop.dropSourceUrls(store11, { x: 0, y: 0 }, dt({}));
    const failText11 = store11.toasts.find((t) => t.indexOf('在线素材导入失败') >= 0) || '';
    ok(failText11.indexOf('下载失败：ConnectTimeout') >= 0, '提示里有地址下载的原因');
    ok(failText11.indexOf('素材超过 30MB') >= 0, '提示里有「文件过大」');
    ok(store11.nodes.length === 0, '全失败不落节点');

    console.log('[16] 接线检查（sourceDrop.ts）');
    const dropSrc = read(SRC + '/sourceDrop.ts');
    ok(/get_recent_source_media/.test(dropSrc), '接上主进程抓到的最近视频请求');
    ok(/get_source_view_fetch_bytes/.test(dropSrc), '接上页面上下文取字节');
    ok(/fetch_source_url/.test(dropSrc), '接上主进程带登录态下载');
    ok(/blobUrlsFromDataTransfer/.test(dropSrc), 'blob: 载荷单独收集（不再被过滤成空）');
    ok(/const MAX_FALLBACKS = 3;/.test(dropSrc), '兜底通道有条数上限，不会一次拖 20 个全部串行重试');

    console.log('[17] 载荷只有 HLS（m3u8）：直接说清楚，不做无效下载');
    const store12 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: { tagName: 'VIDEO', pageUrl: videoPage, uriList: 'https://sns-video-v6.xhscdn.com/stream/x.m3u8', bestUrl: 'https://sns-video-v6.xhscdn.com/stream/x.m3u8', videoUrls: ['https://sns-video-v6.xhscdn.com/stream/x.m3u8'] } }),
    } } };
    global.fetch = async () => { throw new Error('m3u8 不该发下载请求'); };
    await srcDrop.dropSourceUrls(store12, { x: 0, y: 0 }, dt({}));
    ok(store12.nodes.length === 0, 'm3u8 不落节点');
    ok(store12.toasts.some((t) => t.indexOf('m3u8') >= 0), '提示里点明是 m3u8 流');
    ok(store12.toastMs.some((ms) => ms === 12000), 'm3u8 提示时长 12s（有足够时间读完）');

    console.log('[18] 载荷只有页面地址：不当素材导入');
    const store13 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: { tagName: 'A', pageUrl: videoPage, uriList: 'https://www.xiaohongshu.com/explore/abc', bestUrl: 'https://www.xiaohongshu.com/explore/abc' } }),
    } } };
    global.fetch = async () => { throw new Error('页面地址不该发下载请求'); };
    await srcDrop.dropSourceUrls(store13, { x: 0, y: 0 }, dt({}));
    ok(store13.nodes.length === 0, '页面地址不落节点');
    ok(store13.toasts.some((t) => t.indexOf('页面地址') >= 0), '提示拖的是页面不是素材');

    console.log('[19] 主要字段没有地址时，从载荷自带的 HTML 里捞视频源');
    const store14 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: {
            tagName: 'DIV',
            pageUrl: videoPage,
            html: '<video src="https://sns-video-v6.xhscdn.com/stream/from-html.mp4" poster="https://i.pinimg.com/p.jpg"></video>',
        } }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => videoItem('/assets/uploads/v4.mp4') }; };
    await srcDrop.dropSourceUrls(store14, { x: 0, y: 0 }, dt({}));
    ok(requests.length === 1 && requests[0].body.items[0].url === 'https://sns-video-v6.xhscdn.com/stream/from-html.mp4', 'HTML 里的视频源被捞出来');
    ok(store14.nodes.length === 1 && store14.nodes[0].kind === 'video', 'HTML 兜底也能落视频节点');

    console.log('[20] 只拿到 fMP4 分片（.m4s）：不 import，给可操作引导');
    const store15 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoDrag }),
        get_recent_source_media: async () => ({ ok: true, items: [
            { url: 'https://sns-video-v6.xhscdn.com/stream/seg_000.m4s', kind: 'video', pageUrl: videoPage, time: 900 },
        ] }),
    } } };
    global.fetch = async () => { throw new Error('只剩分片时不该发 import 请求'); };
    const infoCalls = [];
    const prevInfo = console.info;
    console.info = (...args) => infoCalls.push(args.join(' '));
    try {
        await srcDrop.dropSourceUrls(store15, { x: 0, y: 0 }, dt({}));
    } finally {
        console.info = prevInfo;
    }
    ok(store15.nodes.length === 0, '分片不落节点');
    ok(store15.toasts.some((t) => t.indexOf('加密分片') >= 0 && t.indexOf('.m4s') >= 0), '提示说明拿到的是加密分片（.m4s）');
    ok(store15.toasts.some((t) => t.indexOf('播完') >= 0 && t.indexOf('直链 mp4') >= 0), '提示给出可操作引导（播完再拖 / 换直链）');
    ok(store15.toastMs.some((ms) => ms === 12000), '引导提示时长 12s');
    ok(infoCalls.some((m) => m.indexOf('跳过导入') >= 0), '控制台留一行诊断');

    console.log('[21] 同批真链里有整段：整段优先，不导分片');
    const store16 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoDrag }),
        get_recent_source_media: async () => ({ ok: true, items: [
            { url: 'https://sns-video-v6.xhscdn.com/stream/seg_000.m4s', kind: 'video', pageUrl: videoPage, time: 900 },
            { url: 'https://sns-video-v6.xhscdn.com/stream/full.mp4', kind: 'video', pageUrl: videoPage, time: 100 },
        ] }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => videoItem('/assets/uploads/full2.mp4') }; };
    await srcDrop.dropSourceUrls(store16, { x: 0, y: 0 }, dt({}));
    ok(requests.length === 1 && requests[0].body.items[0].url === 'https://sns-video-v6.xhscdn.com/stream/full.mp4', '更旧的整段排在更新的分片前面');
    ok(store16.nodes.length === 1 && store16.nodes[0].kind === 'video', '整段正常落视频节点');

    console.log('[22] URL 看不出、后端认出分片：同样给引导，不甩 400 原文');
    const store17 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: {
            tagName: 'VIDEO', pageUrl: videoPage,
            uriList: 'https://sns-video-v6.xhscdn.com/stream/abc',
            bestUrl: 'https://sns-video-v6.xhscdn.com/stream/abc',
            videoUrls: ['https://sns-video-v6.xhscdn.com/stream/abc'],
        } }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ items: [{ ok: false, error: '拿到的是视频分片（.m4s），不是整段视频' }] }) }; };
    await srcDrop.dropSourceUrls(store17, { x: 0, y: 0 }, dt({}));
    ok(store17.nodes.length === 0, '后端认出分片时不落节点');
    ok(store17.toasts.some((t) => t.indexOf('加密分片') >= 0 && t.indexOf('直链 mp4') >= 0), '失败提示换成可操作引导');
    ok(store17.toastMs.some((ms) => ms === 12000), '后端分片提示也是 12s');


    console.log('[23] 只拿到分片 + 桥给出 init/有序分片：拼接后落可播视频节点');
    const store18 = fakeStore();
    const initUrl = 'https://sns-video-v6.xhscdn.com/stream/init.mp4';
    const segUrls = [
        'https://sns-video-v6.xhscdn.com/stream/seg_000.m4s',
        'https://sns-video-v6.xhscdn.com/stream/seg_001.m4s',
        'https://sns-video-v6.xhscdn.com/stream/seg_002.m4s',
    ];
    global.window = { pywebview: { api: {
        get_source_fmp4_timeline: async () => ({ ok: true, init: initUrl, segments: segUrls, referer: videoPage, pageUrl: videoPage }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => videoItem('/assets/uploads/stitched.mp4') }; };
    await srcDrop.dropSourceUrls(store18, { x: 0, y: 0 }, dt({ 'text/uri-list': segUrls.join('\r\n') }));
    ok(requests.length === 1 && requests[0].url === '/api/local-assets/import-fmp4', '分片走 import-fmp4 拼接接口');
    ok(requests[0] && JSON.stringify(requests[0].body.urls) === JSON.stringify([initUrl].concat(segUrls)), 'urls[0] 是 init，其后按抓取顺序');
    ok(requests[0] && requests[0].body.referer === videoPage && requests[0].body.pageUrl === videoPage, 'body 带 referer / pageUrl');
    ok(store18.nodes.length === 1 && store18.nodes[0].kind === 'video', '拼接成功落一个视频节点');
    ok(store18.nodes[0] && store18.nodes[0].hist[0].dur === 12.5, '视频节点带真实时长');
    ok(store18.toasts.some((t) => t.indexOf('已从在线素材添加') >= 0), '成功提示');
    ok(!store18.toasts.some((t) => t.indexOf('加密分片') >= 0), '拼接成功时不再弹分片引导');

    console.log('[24] 分片没抓全（桥没有 init）：退回可操作引导');
    const store19 = fakeStore();
    global.window = { pywebview: { api: {
        get_source_fmp4_timeline: async () => ({ ok: true, init: '', segments: [segUrls[0]] }),
    } } };
    global.fetch = async () => { throw new Error('没抓全时不该发 import-fmp4 请求'); };
    await srcDrop.dropSourceUrls(store19, { x: 0, y: 0 }, dt({ 'text/uri-list': segUrls[0] }));
    ok(store19.nodes.length === 0, '没抓全不落节点');
    const guide = store19.toasts.find((t) => t.indexOf('只抓到分片且没抓全') >= 0) || '';
    ok(!!guide, '引导提示点明「只抓到分片且没抓全」');
    ok(guide.indexOf('先在面板里播一遍再拖') >= 0, '给出「先在面板里播一遍再拖」的具体操作');
    ok(guide.indexOf('直链 mp4') >= 0, '保留「换直链 mp4」的替代方案');
    ok(store19.toastMs.some((ms) => ms === 12000), '引导提示 12s（够读完）');

    console.log('[25] 载荷是页面地址：先合并主进程最近拖拽，再决定是否提示');
    const store20 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: {
            tagName: 'VIDEO',
            pageUrl: videoPage,
            uriList: 'https://sns-video-v6.xhscdn.com/stream/real.mp4',
            bestUrl: 'https://sns-video-v6.xhscdn.com/stream/real.mp4',
        } }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => videoItem('/assets/uploads/merged.mp4') }; };
    await srcDrop.dropSourceUrls(store20, { x: 0, y: 0 }, dt({ 'text/uri-list': videoPage }));
    ok(requests.length === 1 && requests[0].url === '/api/local-assets/import-urls', '合并后正常走 import-urls');
    ok(requests[0] && requests[0].body.items[0].url === 'https://sns-video-v6.xhscdn.com/stream/real.mp4', '用的是主进程记下的真视频地址');
    ok(store20.nodes.length === 1, '合并后能落节点');
    ok(!store20.toasts.some((t) => t.indexOf('页面地址') >= 0), '不再误报「拖的是页面不是素材」');

    console.log('[26] recent-media 老条目没有 kind：按扩展名兜底认视频');
    const store21 = fakeStore();
    global.window = { pywebview: { api: {
        get_last_guest_drag: async () => ({ ok: true, drag: videoDrag }),
        get_recent_source_media: async () => ({ ok: true, items: [
            { url: 'https://sns-video-v6.xhscdn.com/stream/legacy.mp4', pageUrl: videoPage, time: 200 },
            { url: 'https://i.pinimg.com/a.jpg', pageUrl: videoPage, time: 300 },
        ] }),
    } } };
    requests = [];
    global.fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => videoItem('/assets/uploads/legacy.mp4') }; };
    await srcDrop.dropSourceUrls(store21, { x: 0, y: 0 }, dt({}));
    ok(requests.length === 1 && requests[0].body.items[0].url === 'https://sns-video-v6.xhscdn.com/stream/legacy.mp4', '无 kind 的 .mp4 老条目被认成视频（jpg 仍跳过）');
    ok(store21.nodes.length === 1 && store21.nodes[0].kind === 'video', '老条目也能落视频节点');

    console.log('[27] fMP4 拼接接线（sourceDrop.ts / server/routes/assets.py）');
    const dropSrc2 = read(SRC + '/sourceDrop.ts');
    ok(/get_source_fmp4_timeline/.test(dropSrc2), '接上主进程 fMP4 分片清单桥');
    ok(/\/api\/local-assets\/import-fmp4/.test(dropSrc2), '调新的 import-fmp4 后端接口');
    ok(/type Fmp4Timeline = \{ init: string; segments: string\[\]; referer: string; pageUrl: string \};/.test(dropSrc2), '清单结构（init / segments / referer / pageUrl）');
    ok(!/下不了整段；先在面板里把视频播完/.test(dropSrc2), '旧那句「下不了整段」已被拼接流程取代');
    const assetsPy = read('server/routes/assets.py');
    ok(/@router\.post\("\/local-assets\/import-fmp4"\)/.test(assetsPy), '后端注册 import-fmp4');
    ok(/_is_fmp4_init_segment/.test(assetsPy), '后端校验第一段是 init（ftyp）');
    ok(/_FMP4_MAX_SEGMENTS = 600/.test(assetsPy) && /_FMP4_MAX_TOTAL_BYTES = 2 \* 1024 \* 1024 \* 1024/.test(assetsPy), '段数 / 总大小上限');

    console.log('');
    if (fails.length) {
        console.error('[FAIL] ' + fails.length + ' 项失败：');
        fails.forEach((f) => console.error('  - ' + f));
        process.exit(1);
    }
    console.log('[PASS] ' + pass + ' 项断言全部通过');
})().catch((err) => { console.error('[FAIL] 异常：', err); process.exit(1); });
