#!/usr/bin/env node
'use strict';
/**
 * 画布拖入大文件：>8MB 走 multipart 原始字节（POST /api/ai/upload），≤8MB 仍走 data URL；
 * 逐文件 toast 失败原因（413 / 网络），不中断同批其它文件；>200MB 明确提示；
 * replace / target / linkTo 两条上传路径都要能走通。
 * 断言 = 源码接线（含构建产物）+ 真实 addFiles 逻辑（store 用桩 backend，浏览器 API 用最小桩）。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ---------- [0] 加载 addFiles 需要的最小浏览器桩 ---------- */
const urlCalls = { created: 0, revoked: 0 };
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => { urlCalls.created += 1; return 'blob:novai-test/' + urlCalls.created; };
URL.revokeObjectURL = () => { urlCalls.revoked += 1; };

// 图片只读 naturalWidth/Height：给每张图一个固定尺寸
global.Image = class FakeImage {
    constructor() { this.naturalWidth = 1280; this.naturalHeight = 720; this.onload = null; this.onerror = null; }
    set src(_v) { setTimeout(() => this.onload && this.onload(), 0); }
};

// 视频 / 音频元数据：mediaMeta 会 createElement('video'|'audio')
global.document = {
    createElement() {
        const el = {
            preload: '', muted: false, duration: 12.5, videoWidth: 1920, videoHeight: 1080,
            onloadedmetadata: null, onerror: null,
            removeAttribute() {},
            set src(_v) { setTimeout(() => el.onloadedmetadata && el.onloadedmetadata(), 0); },
        };
        return el;
    },
};

// ≤8MB 走 FileReader.readAsDataURL
global.FileReader = class FakeFileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then((buf) => {
            this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(buf).toString('base64');
            if (this.onload) this.onload();
        }, (error) => { if (this.onerror) this.onerror(error); });
    }
};

const memory = new Map();
global.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};
if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'node' } });
}

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', loader: { '.css': 'text' },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const { CanvasStore } = load('novai-canvas-ui/src/canvas/canvas-next/store.ts');
const actions = load('novai-canvas-ui/src/canvas/canvas-next/actions.ts');
const { GenError } = load('novai-canvas-ui/src/canvas/canvas-next/backend/types.ts');

const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);
const MB = 1024 * 1024;

/* ---------- [1] 源码接线：阈值 / 新接口 / 回落 ---------- */
const actionsSrc = read('novai-canvas-ui/src/canvas/canvas-next/actions.ts');
const typesSrc = read('novai-canvas-ui/src/canvas/canvas-next/backend/types.ts');
const backendSrc = read('novai-canvas-ui/src/novaiBackend.ts');
const bridgeSrc = read('novai-canvas-ui/src/canvas/canvas-next/backend/bridge.ts');
const mockSrc = read('novai-canvas-ui/src/canvas/canvas-next/backend/mock.ts');
const tableSrc = read('novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx');
const viewportSrc = read('novai-canvas-ui/src/canvas/canvas-next/ui/Viewport.tsx');

ok(actionsSrc.includes('export const MULTIPART_UPLOAD_MIN = 8 * 1024 * 1024;'), 'multipart 阈值 8MB');
ok(/base64 会把体积撑大约 1\/3/.test(actionsSrc), '阈值理由写在代码里（base64 膨胀 ~1/3）');
ok(actionsSrc.includes('typeof store.backend.importAssetFile === "function"'), '只有后端实现了 importAssetFile 才走 multipart');
ok(actionsSrc.includes('store.backend.importAssetFile!(store.state.canvasId, uploadBlob, uploadName)'), '大文件发原始字节 + 文件名');
ok(actionsSrc.includes('importAsset(store.state.canvasId, dataUrl, uploadName)'), '小文件仍走 data URL（旧桥 / mock 的回落路径）');
ok(actionsSrc.includes('URL.createObjectURL(uploadBlob)') && actionsSrc.includes('URL.revokeObjectURL(probeUrl)'), '尺寸 / 时长改用 objectURL 读并释放');
ok(!/readAsDataURL\(f\)[^]*?const url = await store\.backend\.importAsset/.test(actionsSrc), '大文件路径不再先整段读 base64');
ok(actionsSrc.includes('export function uploadFailureText'), '413 / 网络失败有统一文案函数');
ok(actionsSrc.includes('export const tooLargeText'), '>200MB 有统一文案（文件名 / 大小 / 上限 / 怎么办）');
ok(actionsSrc.indexOf('try {') < actionsSrc.indexOf('const kind: GenKind | null') && actionsSrc.includes('处理失败：'), '每个文件单独 try/catch，不中断同批其它文件');
ok(actionsSrc.includes('INLINE_FALLBACK_MAX'), 'INLINE_FALLBACK guard 保留（bridge 失败不写大段 data URL）');
ok(actionsSrc.includes('dataUrlToBlob(png.dataUrl)'), 'convert 档转好 PNG 后按 Blob 走 multipart');

ok(typesSrc.includes('importAssetFile?(canvasId: string, file: Blob, name: string): Promise<string>;'), 'CanvasBackend 增加可选 importAssetFile');
ok(/bridge \/ mock 不实现/.test(typesSrc), '类型注释写明 bridge / mock 不实现、调用方回落');
ok(!bridgeSrc.includes('importAssetFile') && !mockSrc.includes('importAssetFile'), 'bridge / mock 没有实现（可选接口，自动回落 data URL）');

ok(backendSrc.includes('form.append("files", file, name)'), 'novaiBackend 用 FormData 追加 files + 原始文件');
ok(backendSrc.includes('fetch("/api/ai/upload", { method: "POST", body: form })'), 'novaiBackend 发 multipart 到 /api/ai/upload（不是 upload-base64）');
ok(backendSrc.includes('throw new GenError(`HTTP_${response.status}`'), '上传失败抛 GenError，带 HTTP 状态与服务端 detail');
ok(backendSrc.includes('async importAssetFile(_canvasId, file, name) { return uploadAssetFile(file, name); }'), 'NOVAI 适配器实现 importAssetFile');

ok(tableSrc.includes('MULTIPART_UPLOAD_MIN') && tableSrc.includes('importAssetFile!'), '表格单元格大图也走 multipart');
ok(tableSrc.includes('uploadFailureText(f, error)') && tableSrc.includes('tooLargeText(f)'), '表格单元格也有 200MB 守卫与失败 toast');
ok(/void addFiles\([^)]*\)\.catch\(/.test(viewportSrc), 'Viewport 的 void addFiles 补了兜底 catch（不再静默）');

/* ---------- [2] 运行时：≤8MB → data URL；>8MB → 原始字节 ---------- */
const calls = { importAsset: [], importAssetFile: [] };
function makeBackend(overrides = {}) {
    return {
        kind: 'bridge',
        available: () => true,
        listModels: async () => [],
        loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1 }),
        saveDoc: async () => ({ ok: true, version: 2 }),
        importAsset: async (_canvasId, dataUrl, name) => {
            calls.importAsset.push({ dataUrl, name });
            return '/assets/input/' + name;
        },
        importAssetFile: async (canvasId, file, name) => {
            calls.importAssetFile.push({ canvasId, file, name });
            return '/assets/input/uploaded_' + name;
        },
        resolveAsset: async (ref) => ref,
        generate: async () => ({ outputs: [] }),
        editImage: async () => ({ outputs: [] }),
        chat: async () => '',
        ...overrides,
    };
}
function freshStore(overrides = {}) {
    const store = new CanvasStore(makeBackend(overrides), 'canvas-large-upload-test');
    store.set({ doc: { nodes: [], edges: [], comments: [] }, loaded: true, models: [] });
    return store;
}
const toastsSince = (store, n) => store.state.toasts.slice(n).map((t) => t.html).join(' | ');

(async () => {
    // 2.1 小图（2KB）：保持现有 data URL 路径
    calls.importAsset = []; calls.importAssetFile = [];
    let store = freshStore();
    await actions.addFiles(store, [new File([new Uint8Array(2048)], 'small.png', { type: 'image/png' })], { x: 0, y: 0 });
    eq(calls.importAssetFile.length, 0, '小图不调 importAssetFile');
    eq(calls.importAsset.length, 1, '小图仍走 importAsset（data URL）');
    ok(String(calls.importAsset[0].dataUrl).startsWith('data:image/png;base64,'), '小图传的是 data URL');
    eq(store.state.doc.nodes.length, 1, '小图建出一个节点');
    eq(model.genOf(store.state.doc.nodes[0]).hist[0].url, '/assets/input/small.png', '节点用的是后端返回的 /assets 地址');

    // 2.2 大图（9MB）：原始字节 + 文件名，不读 base64
    calls.importAsset = []; calls.importAssetFile = [];
    const created = urlCalls.created;
    store = freshStore();
    const bigImage = new File([new Uint8Array(9 * MB)], 'photo.png', { type: 'image/png' });
    await actions.addFiles(store, [bigImage], { x: 0, y: 0 });
    eq(calls.importAsset.length, 0, '大图不读 data URL');
    eq(calls.importAssetFile.length, 1, '大图走 importAssetFile');
    eq(calls.importAssetFile[0].name, 'photo.png', '带上原文件名');
    eq(calls.importAssetFile[0].canvasId, 'canvas-large-upload-test', '带上画布 id');
    assert(calls.importAssetFile[0].file instanceof File, '上传的是原始 File 对象');
    eq(calls.importAssetFile[0].file.size, 9 * MB, '字节数原样（没有 base64 膨胀）');
    ok(urlCalls.created > created && urlCalls.revoked >= 1, 'objectURL 建了也 revoke 了');
    eq(store.state.doc.nodes.length, 1, '大图建出节点');
    const bigNodeGen = model.genOf(store.state.doc.nodes[0]);
    eq(bigNodeGen.hist[0].url, '/assets/input/uploaded_photo.png', '节点用后端返回的 /assets 地址');
    eq(bigNodeGen.hist[0].w, 1280, '宽高从 objectURL 读出来写进 hist');

    // 2.3 大视频（60MB）：原始字节 + 时长
    calls.importAsset = []; calls.importAssetFile = [];
    store = freshStore();
    const bigVideo = new File([new Uint8Array(9 * MB)], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(bigVideo, 'size', { value: 60 * MB });
    await actions.addFiles(store, [bigVideo], { x: 0, y: 0 });
    eq(calls.importAssetFile.length, 1, '视频 >8MB 走 importAssetFile');
    eq(calls.importAssetFile[0].name, 'clip.mp4', '视频带原文件名');
    eq(store.state.doc.nodes[0].kind, 'video', '建出视频节点');
    const vidGen = model.genOf(store.state.doc.nodes[0]);
    eq(vidGen.hist[0].dur, 12.5, '时长从元数据读出来写进 hist');
    eq(vidGen.hist[0].w, 1920, '视频宽高写进 hist');

    // 2.4 上传失败（413）：toast 出可执行原因，同批下一个文件照常上传
    calls.importAsset = []; calls.importAssetFile = [];
    store = freshStore();
    let n = 0;
    const flaky = { importAssetFile: async () => { n += 1; if (n === 1) throw new GenError('HTTP_413', 'clip.mp4 有 210.0MB，超过视频单文件 200.0MB 上限，无法上传。请先压缩 / 裁短 / 转码后重试。'); return '/assets/input/ok.png'; } };
    store = freshStore(flaky);
    const beforeToasts = store.state.toasts.length;
    await actions.addFiles(store, [
        new File([new Uint8Array(9 * MB)], 'clip.mp4', { type: 'video/mp4' }),
        new File([new Uint8Array(9 * MB)], 'ok.png', { type: 'image/png' }),
    ], { x: 0, y: 0 });
    const failToast = toastsSince(store, beforeToasts);
    ok(failToast.includes('clip.mp4'), '失败 toast 带文件名（实际：' + failToast + '）');
    ok(failToast.includes('9.0MB'), '失败 toast 带实际大小（实际：' + failToast + '）');
    ok(failToast.includes('200.0MB') && failToast.includes('裁短'), '失败 toast 带上限与改法');
    ok(failToast.includes('未上传'), '413 映射成人话「未上传」');
    eq(store.state.doc.nodes.length, 1, '同批第二个文件照常建节点（不被中断）');
    eq(model.genOf(store.state.doc.nodes[0]).hist[0].url, '/assets/input/ok.png', '第二个文件上传成功');

    // 2.5 >200MB：不调任何上传接口，明确 toast
    calls.importAsset = []; calls.importAssetFile = [];
    store = freshStore();
    const tooBig = new File([new Uint8Array(32)], 'huge.mp4', { type: 'video/mp4' });
    Object.defineProperty(tooBig, 'size', { value: 225 * MB });
    const bigToastAt = store.state.toasts.length;
    await actions.addFiles(store, [tooBig], { x: 0, y: 0 });
    const bigToast = toastsSince(store, bigToastAt);
    ok(bigToast.includes('huge.mp4'), '>200MB toast 带文件名');
    ok(bigToast.includes('225.0MB'), '>200MB toast 带实际大小（实际：' + bigToast + '）');
    ok(bigToast.includes('200.0MB') && bigToast.includes('压缩'), '>200MB toast 带上限与改法');
    eq(calls.importAsset.length + calls.importAssetFile.length, 0, '>200MB 一个上传请求都没发');
    eq(store.state.doc.nodes.length, 0, '>200MB 不建节点');

    // 2.6 replace 分支：大文件也能替换当前版本
    calls.importAssetFile = [];
    store = freshStore();
    const repId = model.newNode('image', 0, 0, { w: 240, h: 240, hist: [{ url: '/assets/old.png', w: 800, h: 600 }], hi: 0 }).id;
    store.addNodes([{ ...model.newNode('image', 0, 0, { w: 240, h: 240, hist: [{ url: '/assets/old.png', w: 800, h: 600 }], hi: 0 }), id: repId }]);
    await actions.addFiles(store, [new File([new Uint8Array(9 * MB)], 'new.png', { type: 'image/png' })], { x: 0, y: 0 }, { replace: repId });
    const repNode = model.genOf(store.node(repId));
    eq(repNode.hist.length, 1, 'replace 不新增版本');
    eq(repNode.hist[0].url, '/assets/input/uploaded_new.png', 'replace 分支换成新地址（大文件路径）');
    eq(store.state.doc.nodes.length, 1, 'replace 不新建节点');

    // 2.7 target 分支：大文件填进已有节点
    calls.importAssetFile = [];
    store = freshStore();
    const targetNode = model.newNode('image', 0, 0, { w: 240, h: 240 });
    store.addNodes([targetNode]);
    await actions.addFiles(store, [new File([new Uint8Array(9 * MB)], 'fill.png', { type: 'image/png' })], { x: 0, y: 0 }, { target: targetNode.id });
    const fillGen = model.genOf(store.node(targetNode.id));
    eq(fillGen.hist.length, 1, 'target 分支写进目标节点的当前版本');
    eq(fillGen.hist[0].url, '/assets/input/uploaded_fill.png', 'target 分支用新地址');
    eq(store.state.doc.nodes.length, 1, 'target 不新建节点');

    // 2.8 linkTo 分支：大文件新节点连成输入
    calls.importAssetFile = [];
    store = freshStore();
    const sink = model.newNode('text', 400, 0, {});
    store.addNodes([sink]);
    await actions.addFiles(store, [new File([new Uint8Array(9 * MB)], 'ref.png', { type: 'image/png' })], { x: 0, y: 0 }, { linkTo: sink.id });
    eq(store.state.doc.nodes.length, 2, 'linkTo 新建节点');
    eq(store.state.doc.edges.length, 1, 'linkTo 连成输入');
    eq(store.state.doc.edges[0].to, sink.id, '连到指定节点');

    /* ---------- [3] 构建产物里有新路径（预览跑的是构建产物） ---------- */
    const built = read('static/novai-canvas/canvas.js');
    ok(built.includes('/api/ai/upload'), '构建产物里有多媒体上传接口');
    ok(built.includes('超过单文件'), '构建产物里有 200MB 上限文案');
    ok(built.includes('未上传'), '构建产物里有 413 人话文案');
    ok(!built.includes('超过 50MB，无法上传'), '构建产物里不再有旧的「超过 50MB，无法上传」');

    console.log('[PASS] 画布大文件上传：>8MB 走 multipart 原始字节、≤8MB 保持 data URL、失败逐文件 toast、>200MB 明确拒绝、replace / target / linkTo 两条路径都能走、构建产物已更新');
})().catch((error) => { console.error(error); process.exit(1); });
