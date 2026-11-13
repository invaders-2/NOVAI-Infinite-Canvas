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

// localStorage 桩：store 的「记住默认模型」用
const memory = new Map();
global.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};

const fit = load('novai-canvas-ui/src/canvas/canvas-next/mediaFit.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const { CanvasStore } = load('novai-canvas-ui/src/canvas/canvas-next/store.ts');
const engine = load('novai-canvas-ui/src/canvas/canvas-next/engine.ts');
const actions = load('novai-canvas-ui/src/canvas/canvas-next/actions.ts');

const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

/* ---------- 比例解析 ---------- */
eq(fit.ratioOf('3:4'), 0.75, '3:4 → 0.75');
eq(fit.ratioOf('16:9'), 16 / 9, '16:9 → 16/9');
eq(fit.ratioOf(' 21:9 '), 21 / 9, '两边空格忽略');
eq(fit.ratioOf('自适应'), null, '自适应没有已知比例');
eq(fit.ratioOf('adaptive'), null, 'adaptive 没有已知比例');
eq(fit.ratioOf('auto'), null, 'auto 没有已知比例');
eq(fit.ratioOf(''), null, '空串 → null');
eq(fit.ratioOf(undefined), null, 'undefined → null');
eq(fit.ratioOf('0:4'), null, '宽 0 不合法');
// 「原图比例」的显式 WxH（params.sourceSize）也要能解析成比例
eq(fit.sizeRatioOf('2048x1536'), 4 / 3, 'sourceSize 2048x1536 → 4:3');
eq(fit.sizeRatioOf(' 2048×1536 '), 4 / 3, 'sourceSize 允许 × 与空格');
eq(fit.sizeRatioOf('1024'), null, '缺一半 → null');
eq(fit.sizeRatioOf('0x100'), null, '宽 0 → null');
eq(fit.sizeRatioOf(''), null, '空串 → null');
assert.strictEqual(fit.isAdaptiveRatio('自适应'), true);
assert.strictEqual(fit.isAdaptiveRatio('adaptive'), true);
assert.strictEqual(fit.isAdaptiveRatio('auto'), true);
assert.strictEqual(fit.isAdaptiveRatio('16:9'), false);
assert.strictEqual(fit.isAdaptiveRatio(''), false);

/* ---------- 假后端 ---------- */
const imgModel = { id: 'prov::img', name: 'img', vendor: 'v', kind: 'image', ratios: ['自适应', '1:1', '3:4', '16:9', '9:16', '21:9'], sizes: ['1K', '2K'], batch: [1, 2, 4], maxRefs: 0, i2i: false, secs: 10, tags: [] };
const vidModel = { id: 'prov::vid', name: 'vid', vendor: 'v', kind: 'video', modes: ['文生视频', '首帧'], ratios: ['16:9', '3:4', '自适应'], res: ['720p'], durs: [5], times: [1], audio: true, maxRefs: 0, secs: 60, tags: [] };
const txtModel = { id: 'prov::txt', name: 'txt', vendor: 'v', kind: 'text', vision: true, search: true, secs: 6, tags: [] };
// 默认比例是 1:1 的模型：用它造「旧画布里 240×240 的空节点」，再逐个换比例（3:4 才是真的变了）
const squareModel = { ...imgModel, id: 'prov::img-square', ratios: ['1:1', '16:9', '9:16', '21:9', '自适应'] };
const backend = {
    available: () => true,
    loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1 }),
    listModels: async () => [imgModel, squareModel, vidModel, txtModel],
    saveDoc: async () => ({ ok: true, version: 2 }),
    generate: async () => ({ outputs: [] }),
    importAsset: async (_c, u) => u,
    resolveAsset: async (u) => u,
};
const store = new CanvasStore(backend, 'canvas-ratio-preview-test');
store.set({ models: [imgModel, squareModel, vidModel, txtModel], loaded: true });

/** 空状态节点：显式尺寸模拟旧画布 / 用户已经拖过的节点 */
function emptyNode(kind, w, h, extra = {}) {
    const n = model.newNode(kind, 0, 0, { w, h, ...extra }, kind === 'image' ? squareModel : kind === 'video' ? vidModel : txtModel);
    store.addNodes([n], [], { select: false });
    return n.id;
}
const sizeOf = (id) => { const n = store.node(id); return { w: n.w, h: n.h }; };
const inputsOfId = (id) => model.inputsOf(store.state.doc, id);
const setRatio = (id, ratio) => store.patchGen(id, (g) => ({ params: { ...g.params, ratio } }));

/* ---------- 空图片节点：改比例立刻按比例摆正 ---------- */
const img = emptyNode('image', 240, 240);
setRatio(img, '3:4');
eq(sizeOf(img), { w: 240, h: 320 }, '3:4 → 240×320');
setRatio(img, '16:9');
eq(sizeOf(img), { w: 240, h: 135 }, '16:9 → 240×135');
setRatio(img, '9:16');
eq(sizeOf(img), { w: 240, h: 427 }, '9:16 → 240×427');
setRatio(img, '21:9');
eq(sizeOf(img), { w: 240, h: 103 }, '21:9 → 240×103');
setRatio(img, '1:1');
eq(sizeOf(img), { w: 240, h: 240 }, '1:1 → 240×240');
setRatio(img, '3:4');
const beforeAdaptive = sizeOf(img);
// 原图比例：比例本身不写死，必须从源图尺寸（上游结果 / params.sourceSize）来；没有源图就拿不到，保持原尺寸、不猜 1:1
setRatio(img, '自适应');
eq(sizeOf(img), beforeAdaptive, '原图比例但没有源图：保持原尺寸');
setRatio(img, 'adaptive');
eq(sizeOf(img), beforeAdaptive, 'adaptive 同样保持原尺寸');

/* ---------- 位置不动 / 清晰度等参数不改尺寸 ---------- */
const pos = store.node(img);
store.updateNode(img, (n) => ({ ...n, x: 123, y: 456 }));
setRatio(img, '16:9');
const moved = store.node(img);
eq({ x: moved.x, y: moved.y }, { x: 123, y: 456 }, '摆正只改宽高，节点位置不动');
eq({ w: moved.w, h: moved.h }, { w: 240, h: 135 }, '位置改过之后比例仍然生效');
const sizeBefore = sizeOf(img);
store.patchGen(img, (g) => ({ params: { ...g.params, size: '2K', count: 4 } }));
eq(sizeOf(img), sizeBefore, '清晰度 / 张数改动不碰尺寸');

/* ---------- 空视频节点 ---------- */
const vid = emptyNode('video', 320, 180);
setRatio(vid, '3:4');
eq(sizeOf(vid), { w: 320, h: 427 }, '视频 3:4 → 320×427');
const vidBefore = sizeOf(vid);
setRatio(vid, 'adaptive');
eq(sizeOf(vid), vidBefore, '视频原图比例但没有源图：保持原尺寸');

/* ---------- 有结果的节点：真实比例优先 ---------- */
const done = emptyNode('image', 240, 320);
store.patchGen(done, { hist: [{ url: '/assets/x.png', w: 1024, h: 768 }], hi: 0 });
eq(sizeOf(done), { w: 240, h: 320 }, '写入结果本身不改尺寸（结果尺寸由 engine 负责）');
setRatio(done, '16:9');
eq(sizeOf(done), { w: 240, h: 320 }, '已有结果的节点改比例：尺寸不动');
store.patchGen(done, (g) => ({ params: { ...g.params, size: '2K' } }));
eq(sizeOf(done), { w: 240, h: 320 }, '已有结果的节点改其它参数也不动');

/* ---------- 原图比例：有源图 / 有显式 WxH 就按源图比例摆正 ---------- */
const setOriginal = (id, size) => store.patchGen(id, (g) => ({ params: { ...g.params, ratio: '自适应', sourceSize: size } }));

// 面板选「原图比例」时把显式 WxH 写进 params.sourceSize：宽度沿用节点当前宽，位置不动
const autoSrc = emptyNode('image', 360, 270, { hist: [{ url: '/assets/source-4x3.png', w: 2048, h: 1536 }], hi: 0 });
const autoTarget = emptyNode('image', 240, 240);
actions.connect(store, autoSrc, autoTarget);
store.updateNode(autoTarget, (n) => ({ ...n, x: 88, y: 66 }));
setOriginal(autoTarget, '2048x1536');
eq(sizeOf(autoTarget), { w: 240, h: 180 }, '原图比例（sourceSize 2048×1536）→ 240×180');
eq({ x: store.node(autoTarget).x, y: store.node(autoTarget).y }, { x: 88, y: 66 }, '按源图比例摆正只改宽高，位置不动');

// 只写了 sourceSize（没有连线 / 上游没有结果）：一样按它摆正；换比例再摆一次
const sizeOnly = emptyNode('image', 240, 240);
setOriginal(sizeOnly, '1024x1024');
eq(sizeOf(sizeOnly), { w: 240, h: 240 }, 'sourceSize 1024×1024 → 240×240');
setOriginal(sizeOnly, '1600x900');
eq(sizeOf(sizeOnly), { w: 240, h: 135 }, 'sourceSize 1600×900 → 240×135');

// 只有上游结果的真实尺寸、还没写 sourceSize：也按它摆正（不猜 1:1）
const srcOnlySrc = emptyNode('image', 360, 270, { hist: [{ url: '/assets/source-9x16.png', w: 1080, h: 1920 }], hi: 0 });
const srcOnly = emptyNode('image', 240, 240);
actions.connect(store, srcOnlySrc, srcOnly);
setRatio(srcOnly, '自适应');
eq(sizeOf(srcOnly), { w: 240, h: 427 }, '原图比例：只有上游结果尺寸也按它摆正（9:16 → 240×427）');

// 连入 / 更换参考图之后（比例已经是原图比例）：按新源图比例摆正一次
const lateSrc = emptyNode('image', 360, 270, { hist: [{ url: '/assets/late.png', w: 900, h: 1600 }], hi: 0 });
const late = emptyNode('image', 240, 240);
setRatio(late, '自适应');
eq(sizeOf(late), { w: 240, h: 240 }, '还没有源图：原图比例保持原尺寸');
actions.connect(store, lateSrc, late);
eq(sizeOf(late), { w: 240, h: 427 }, '连入 9:16 源图后立刻按它摆正（不用等生成）');
assert(Math.abs(fit.sizeRatioOf(model.genOf(store.node(late)).params.sourceSize) - 9 / 16) < 1e-6, '源图比例记进 params.sourceSize（按尺寸档长边）');
// 同比例的源图再连进来：备忘没变，不重摆（用户拖过的尺寸不会被弹回去）
store.updateNode(late, (n) => ({ ...n, w: 360, h: 360 }));
actions.connect(store, emptyNode('image', 100, 100, { hist: [{ url: '/assets/late2.png', w: 600, h: 1200 }], hi: 0 }), late);
eq(sizeOf(late), { w: 360, h: 360 }, '同比例的源图再连进来：不把拖过的尺寸弹回去');
// 移除第一张、源图换成第二张（1:2）：源图比例变了，按新比例摆正（320×640 收进最大盒）
store.removeEdge(inputsOfId(late)[0].edge.id);
actions.afterInputsChanged(store, late);
eq(sizeOf(late), { w: 320, h: 640 }, '换掉的源图比例不同：按新源图比例摆正一次');

// 已有结果的节点：真实结果比例优先
const withOut = emptyNode('image', 240, 320, { hist: [{ url: '/assets/out.png', w: 1024, h: 768 }], hi: 0 });
setOriginal(withOut, '2048x1536');
eq(sizeOf(withOut), { w: 240, h: 320 }, '已有结果的节点：真实结果比例优先，不按原图比例改尺寸');

// 用户拖过的尺寸：只在比例取值真的变了（或源图比例第一次可用）时摆正
const dragged2 = emptyNode('image', 240, 240);
setOriginal(dragged2, '2048x1536');
eq(sizeOf(dragged2), { w: 240, h: 180 }, '原图比例先摆正一次');
store.updateNode(dragged2, (n) => ({ ...n, w: 360, h: 300 }));
store.patchGen(dragged2, (g) => ({ params: { ...g.params, size: '1K' } }));
eq(sizeOf(dragged2), { w: 360, h: 300 }, '只改清晰度：不把拖过的尺寸弹回去');
store.patchGen(dragged2, (g) => ({ params: { ...g.params, sourceSize: '1024x768' } }));
eq(sizeOf(dragged2), { w: 360, h: 300 }, '同比例换尺寸档（2048×1536 → 1024×768）：不重摆');
store.patchGen(dragged2, (g) => ({ params: { ...g.params, sourceSize: '1024x1024' } }));
eq(sizeOf(dragged2), { w: 360, h: 360 }, '源图比例真的变了（4:3 → 1:1）：按当前宽度重新摆正');

// 视频节点同一套逻辑
const vidSrc = emptyNode('image', 360, 270, { hist: [{ url: '/assets/vsrc.png', w: 1080, h: 1920 }], hi: 0 });
const vidAuto = emptyNode('video', 320, 180);
actions.connect(store, vidSrc, vidAuto);
setRatio(vidAuto, 'adaptive');
eq(sizeOf(vidAuto), { w: 320, h: 569 }, '视频原图比例：9:16 源图 → 320×569');
const vidLateSrc = emptyNode('image', 360, 270, { hist: [{ url: '/assets/vlate.png', w: 1080, h: 1920 }], hi: 0 });
const vidLate = emptyNode('video', 320, 180);
setRatio(vidLate, 'adaptive');
actions.connect(store, vidLateSrc, vidLate);
eq(sizeOf(vidLate), { w: 320, h: 569 }, '连入 9:16 源图后视频生成前就按它摆正');
assert(Math.abs(fit.sizeRatioOf(model.genOf(store.node(vidLate)).params.sourceSize) - 9 / 16) < 1e-6, '视频同样记下源图比例备忘（只判断比例是否变，不发请求）');

/* ---------- 文本 / 非图片视频节点 ---------- */
const txt = emptyNode('text', 280, 200);
store.patchGen(txt, (g) => ({ params: { ...g.params, search: true } }));
eq(sizeOf(txt), { w: 280, h: 200 }, '文本节点改参数不改尺寸');
store.patchGen(txt, (g) => ({ params: { ...g.params, ratio: '16:9' } }));
eq(sizeOf(txt), { w: 280, h: 200 }, '文本节点即使带了 ratio 字段也不按比例改尺寸');

/* ---------- 用户手动拖过尺寸的空节点：只有比例真的变了才摆正 ---------- */
const dragged = emptyNode('image', 240, 240);
store.updateNode(dragged, (n) => ({ ...n, w: 360, h: 360 }));
eq(sizeOf(dragged), { w: 360, h: 360 }, '拖拽缩放：保持用户拖出来的尺寸');
store.patchGen(dragged, (g) => ({ params: { ...g.params, size: '2K', count: 2, style: '无' } }));
eq(sizeOf(dragged), { w: 360, h: 360 }, '只改非比例参数：不把尺寸弹回去');
setRatio(dragged, '16:9');
eq(sizeOf(dragged), { w: 360, h: 203 }, '比例真的变了：按 360 的宽度重新摆正');
store.patchGen(dragged, (g) => ({ params: { ...g.params, size: '1K' } }));
eq(sizeOf(dragged), { w: 360, h: 203 }, '摆正之后再改非比例参数：尺寸不再变');
setRatio(dragged, '16:9');
eq(sizeOf(dragged), { w: 360, h: 203 }, '比例重新选同一个值：不触发摆正');

/* ---------- 新建节点：默认尺寸就是默认比例的尺寸 ---------- */
const fresh = store.newNode('image', 600, 0, { title: '新建', prompt: 'p' });
store.addNodes([fresh], [], { select: false });
eq(store.node(fresh.id).data.gen.params.ratio, '3:4', '模型 ratios 含 3:4 时默认比例是 3:4');
eq(sizeOf(fresh.id), { w: 240, h: 320 }, '新建图片节点初始就是 240×320（3:4）');

const freshVideo = store.newNode('video', 600, 400, { title: '新建视频', prompt: 'p' });
store.addNodes([freshVideo], [], { select: false });
eq(sizeOf(freshVideo.id), { w: 320, h: 180 }, '新建视频节点仍是 320×180（16:9）');

const freshText = store.newNode('text', 600, 800, { title: '新建文本', prompt: 'p' });
store.addNodes([freshText], [], { select: false });
eq(sizeOf(freshText.id), { w: 280, h: 200 }, '新建文本节点不受影响');

// 显式传尺寸的入口（模板 / 导入 / 复制 / 再生成）一律尊重传进来的值
const explicit = model.newNode('image', 0, 0, { w: 500, h: 300 }, imgModel);
eq({ w: explicit.w, h: explicit.h }, { w: 500, h: 300 }, '显式传 w/h 的新节点不被覆盖');
const explicitW = model.newNode('image', 0, 0, { w: 500 }, imgModel);
eq({ w: explicitW.w, h: explicitW.h }, { w: 500, h: 240 }, '只传 w 时高度仍走默认尺寸');
const adaptiveModel = { ...imgModel, id: 'prov::img-auto', ratios: ['自适应'] };
const autoImage = model.newNode('image', 0, 0, {}, adaptiveModel);
eq({ w: autoImage.w, h: autoImage.h }, { w: 240, h: 240 }, '默认比例是自适应：新建节点保持默认尺寸');

/* ---------- 源码接线 ---------- */
const src = (rel) => fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next', rel), 'utf8');
const fitSrc = src('mediaFit.ts');
const engineSrc = src('engine.ts');
const storeSrc = src('store.ts');
const modelSrc = src('model.ts');
assert(fitSrc.includes('export function ratioOf') && fitSrc.includes('export function fitMediaBox'), 'mediaFit 导出 ratioOf 与 fitMediaBox');
assert(engineSrc.includes('ratioOf') && !engineSrc.includes('export function ratioOf'), 'engine 改成从 mediaFit 引入 ratioOf，不再自己定义一份');
assert(modelSrc.includes('const wantRatio =') && modelSrc.includes('fitMediaBox(size.w, wantRatio, 1)'), '新建节点用同一套盒子按默认比例定初始尺寸');
assert(storeSrc.includes('function fitEmptyRatio') && storeSrc.includes('fitEmptyRatio(n, fn(n), d)'), 'updateNode 挂上「空节点按比例摆正」的不变量（带上文档，原图比例要读源图尺寸）');
assert(storeSrc.includes('wantedRatio(doc, next, kind)') && storeSrc.includes('declaredRatio(genOf(prev).params)'), '空节点摆正：目标比例按源图算，比较只看参数里已写着的比例');
const originalRatioSrc = src('originalRatio.ts');
assert(originalRatioSrc.includes('export function wantedRatio') && originalRatioSrc.includes('export function declaredRatio'), 'originalRatio 提供「这次要用的比例 / 参数里已写着的比例」');
assert(originalRatioSrc.includes('sizeRatioOf(p.sourceSize)') && originalRatioSrc.includes('sourceBoxInDoc(doc, node, kind)'), '原图比例先认 params.sourceSize，再退到源图真实像素');
assert(engineSrc.includes('wantedRatio(store.state.doc, node, node.kind as GenKind, req.params)') && engineSrc.includes('const wantBox ='), '生成中占位也走同一个比例函数（原图比例能识别 sourceSize / 源图尺寸）');
const actionsSrc = src('actions.ts');
assert(actionsSrc.includes('function syncSourceRatio') && actionsSrc.includes('syncSourceRatio(store, n)'), '输入变化后同步原图比例');
assert(actionsSrc.includes('sourceSizeForTier(sourceBoxForNode(store, n, n.kind as GenKind), tier)'), '连入 / 更换参考图后按新源图尺寸重写备忘（0 尺寸不写）');

/* ---------- 源码接线：换比例的尺寸过渡 / 拖拽缩放不播 / 圆角缩放手柄 ---------- */
const nodeViewSrc = src('ui/NodeView.tsx');
const viewportSrc = src('ui/Viewport.tsx');
const cssSrc = src('ui/canvas-next.css');
assert(nodeViewSrc.includes('const RATIO_ANIM_MS = 220'), '尺寸过渡约 220ms');
// 起动画必须在绘制前（useLayoutEffect）：passive 的 useEffect 会先按终尺寸画一帧，再被拉回旧尺寸，看起来是「先闪一下再动」
assert(nodeViewSrc.includes('useLayoutEffect(() => {\n    const prev = lastBox.current;'), '尺寸过渡在 useLayoutEffect 里起（首帧就是旧尺寸，不闪）');
assert(nodeViewSrc.includes('el.animate([{ width: prev.w + "px" }') && nodeViewSrc.includes('body.animate([{ height: prev.h + "px" }'), 'WAAPI 同时动画 .node 的宽和 .nbody 的高');
assert(nodeViewSrc.includes('cubic-bezier(.2,0,0,1)'), '缓动与设计 token 一致');
assert(nodeViewSrc.includes('if (prev.ratio === lastBox.current.ratio) return;'), '比例没变（拖拽缩放 / 结果写回 / 新建挂载）不播过渡');
assert(nodeViewSrc.includes('outOf(node)') && nodeViewSrc.includes('node.kind !== "image" && node.kind !== "video"'), '只有空状态图片 / 视频节点参与过渡');
assert(nodeViewSrc.includes('prefers-reduced-motion: reduce') && nodeViewSrc.includes('reducedMotion()'), 'prefers-reduced-motion 下不播');
// 拖拽缩放只改宽高、不动比例，所以上面那条「比例没变就 return」正好把它挡在外面
assert(viewportSrc.includes('store.updateNode(d.id, (n) => ({ ...n, w, h }))'), '拖右下角只写入宽高、不改 params.ratio');
const rzStart = cssSrc.indexOf('.cn-root .rz:after');
const rzEnd = cssSrc.indexOf('.cn-root .node.sel .rz');
const rzRule = cssSrc.slice(rzStart, rzEnd);
assert(rzStart > 0 && rzRule.length > 0, '找得到缩放手柄的样式');
assert(!rzRule.includes('border-right') && !rzRule.includes('border-bottom'), '手柄不再用直角 L 的 border 画');
assert(rzRule.includes("stroke-linecap='round'") && rzRule.includes("stroke-width='1.5'"), '手柄是 1.5px 圆头描边的弧线');
assert(rzRule.includes('-webkit-mask') && rzRule.includes('mask:url('), '手柄用遮罩裁出弧线形状（不会画成实心块）');
// 卡片圆角 14，手柄改用半径 20 的同心弧 + 60° 张角 => 弧线中心线在卡片边缘外 6px（明显离开节点、不压卡片描边）
assert(/A20 20/.test(rzRule), '手柄弧半径 20，比卡片 14px 圆角大 6px（弧离开节点）');
assert(rzRule.includes('M1.15 11.98') && rzRule.includes('11.98 1.15'), '弧是 22.5°→67.5° 的 45°（以 45° 方向为中心），两端圆头');
assert(/right:5\.5px;bottom:5\.5px;width:13px;height:13px/.test(rzRule), '遮罩盒 13×13 用 5.5px 偏移推出卡片外，弧心仍与卡片圆角同心');
assert(/\.cn-root \.rz\{position:absolute;right:-11px;bottom:-11px;width:22px;height:22px/.test(cssSrc), '命中区外扩到 22×22 / -11（命中区不画东西）');
assert(cssSrc.includes('.cn-root .rz{') && cssSrc.includes('color:var(--solid)'), '手柄颜色跟主题走，浅色主题下也看得见');

// 空状态的浮动工具条：图片只留「上传」一颗，文本 / 视频 / 音频不挂（生成中、有结果、非生成类都不受影响）
const genPanelSrc = src('ui/GenPanel.tsx');
assert(genPanelSrc.includes('if (isGenKind(node.kind) && !out && !running && node.kind !== "image") return null;'), 'Toolbar：空状态的文本 / 视频 / 音频不渲染整条，图片例外');
assert(genPanelSrc.includes('if (kind !== "image" && kind !== "video") return;') && genPanelSrc.includes('isAdaptiveRatio(ratioMemo.ratio)'), '面板量到源图尺寸后写回备忘（图片 / 视频同一处）');
// 空图片节点不再走 FloatMenuBar，而是单独一颗按钮：只有一个 upload 按钮、图标 + 文字常显
const emptyUpload = genPanelSrc.slice(genPanelSrc.indexOf('className="float enter ntb-empty-upload"'), genPanelSrc.indexOf('if (running) items ='));
assert(emptyUpload.includes('data-tb="upload"') && emptyUpload.includes('<Icon name="upload" />上传'), '空图片节点：图标 + 「上传」文字都写在按钮里（不靠 hover 展开）');
assert((emptyUpload.match(/data-tb=/g) || []).length === 1, '空图片节点只有这一颗按钮（没有裁剪 / 涂鸦 / 调色 / 素材库等）');
// 专属样式：和整条 dock 同一套容器（50 高 / 圆角 14 / padding 7 / 磨砂玻璃）里放一颗 36 高的按钮，图标 + 文字常显
const cssEmpty = cssSrc.slice(cssSrc.indexOf('#ntb.ntb-empty-upload'), cssSrc.indexOf('#ntb.ntb-empty-upload .ib svg'));
assert(/height:50px/.test(cssEmpty) && /border-radius:14px/.test(cssEmpty), '空上传 dock 容器：50 高、圆角 14');
assert(/background:linear-gradient\(rgba\(255,255,255,\.06\),rgba\(255,255,255,\.06\)\),color-mix\(in srgb,rgb\(17,17,17\) 74%,transparent\)/.test(cssEmpty), '空上传 dock 容器玻璃 V2：6% 白雾 + 74% 底色');
assert(/background:linear-gradient\(rgba\(255,255,255,\.04\),rgba\(255,255,255,\.04\)\),color-mix\(in srgb,#1c1c1e 80%,transparent\)/.test(cssEmpty), '空上传 dock 容器暗色 4% 白雾 + 80% 底色');
assert(cssEmpty.includes('backdrop-filter:blur(44px) saturate(190%)'), '空上传 dock 容器带 blur(44px) saturate(190%)');
assert(/height:36px/.test(cssEmpty) && /border-radius:8px/.test(cssEmpty) && /padding:0 12px/.test(cssEmpty), '空上传按钮：36 高、圆角 8、左右内距 12');
assert(cssEmpty.includes('font-size:13px') && cssEmpty.includes('color:#fff'), '「上传」文字常显：13px 白字');
assert(cssEmpty.includes('gap:6px'), '图标与文字间距 6');
assert(cssSrc.includes('#ntb.ntb-empty-upload .ib svg.i{width:15px;height:15px'), 'upload 图标 15px');
assert(/\.cn-root \.node\.sel \.rz\{opacity:1\}/.test(cssSrc), '手柄仍然只在选中时显示');

/* ---------- 生成中占位：点生成那一帧就按原图比例（不等到结果回来） ---------- */
(async () => {
    const pressed = [];
    let runStore = null;
    const backend = {
        available: () => true,
        loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1 }),
        listModels: async () => [imgModel, vidModel],
        saveDoc: async () => ({ ok: true, version: 2 }),
        importAsset: async (_canvas, url) => url,
        resolveAsset: async (url) => url,
        generate: async (req) => {
            const n = runStore.node(req.nodeId);
            pressed.push({ node: req.nodeId, ratio: req.params.ratio, sourceSize: req.params.sourceSize, w: n.w, h: n.h });
            return { outputs: [{ url: '/out/' + req.nodeId + '.png', w: 2048, h: 1536 }] };
        },
    };
    runStore = new CanvasStore(backend, 'canvas-ratio-placeholder-test');
    const imgParams = (patch) => ({ ...model.defaultParams('image', imgModel), model: imgModel.id, ...patch });
    const vidParams = (patch) => ({ ...model.defaultParams('video', vidModel), model: vidModel.id, ...patch });
    const docOf = (nodes, edges) => ({ doc: { nodes, edges, comments: [] }, loaded: true, models: [imgModel, vidModel] });

    // A) 面板写下的显式 WxH：没连参考图也能算（请求里的 sourceSize 就够）
    const a = model.newNode('image', 0, 0, { w: 240, h: 240, prompt: '画一张', params: imgParams({ ratio: '自适应', sourceSize: '2048x1536' }) }, imgModel);
    runStore.set(docOf([a], []));
    assert.strictEqual(await engine.runNode(runStore, a.id), true, '原图比例 + sourceSize：生成跑起来了');
    assert.deepStrictEqual({ w: pressed[0].w, h: pressed[0].h }, { w: 240, h: 180 }, '点生成那一帧占位就是 240×180（4:3），不用等结果');
    assert.deepStrictEqual({ w: runStore.node(a.id).w, h: runStore.node(a.id).h }, { w: 240, h: 180 }, '结果回来按真实像素摆正（2048×1536 → 240×180）');

    // B) 只有上游参考图的真实尺寸（还没写 sourceSize）：占位直接复用源图尺寸
    const up = model.newNode('image', 0, 0, { w: 240, h: 320, hist: [{ url: '/in.png', w: 1536, h: 2048 }], hi: 0, params: imgParams({ ratio: '3:4' }) }, imgModel);
    const b = model.newNode('image', 600, 0, { w: 240, h: 240, prompt: '看这张参考图', params: imgParams({ ratio: '自适应' }) }, imgModel);
    runStore.set(docOf([up, b], [{ id: 'eb', from: up.id, to: b.id }]));
    assert.strictEqual(await engine.runNode(runStore, b.id), true, '原图比例 + 上游源图：生成跑起来了');
    const pb = pressed[pressed.length - 1];
    assert.deepStrictEqual({ w: pb.w, h: pb.h }, { w: 240, h: 320 }, '上游 3:4 参考图：生成中占位也是 240×320');

    // C) 视频节点同一套：adaptive + 9:16 参考图 → 占位就是 9:16
    const vsrc = model.newNode('image', 0, 0, { w: 240, h: 427, hist: [{ url: '/vsrc.png', w: 1080, h: 1920 }], hi: 0, params: imgParams({ ratio: '3:4' }) }, imgModel);
    const v = model.newNode('video', 600, 0, { w: 320, h: 180, prompt: '镜头推进', params: vidParams({ ratio: 'adaptive' }) }, vidModel);
    runStore.set(docOf([vsrc, v], [{ id: 'ev', from: vsrc.id, to: v.id }]));
    assert.strictEqual(await engine.runNode(runStore, v.id), true, '视频原图比例：生成跑起来了');
    const pv = pressed[pressed.length - 1];
    assert.deepStrictEqual({ w: pv.w, h: pv.h }, { w: 320, h: 569 }, '视频生成中占位按 9:16 源图摆正（320×569）');

    console.log('[PASS] 空状态图片 / 视频节点宽高跟随所选比例（改比例立刻摆正、原图比例按源图 / sourceSize 摆正、生成中占位第一帧就是原图比例、没有源图与已有结果不动、拖过的尺寸只认比例变化、新建即按默认比例；换比例有尺寸过渡、拖拽缩放不播、缩放手柄是角外圆头弧线；空状态图片节点一颗磨砂玻璃「上传」单按钮条、其它生成类空状态不挂浮动工具条）');
})().catch((error) => { console.error(error); process.exit(1); });