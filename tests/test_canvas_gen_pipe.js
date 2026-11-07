#!/usr/bin/env node
/*
 * 生成链路回归（问题 1 + 问题 2）：
 *   1) 请求组装：四类下游（文本 / 图片 / 视频 / 音频）读上游；refMode 残留不再静默丢输入；
 *      表格行节点（data.frozen + rowText）用当前提示词重建请求（请求预览与实际发送同一个函数）。
 *   2) 失败信息：未知码（含 FAILED）主行透出后端可读 message，原始码留在 errCode。
 *   3) 尺寸钳制：GPT-Image 家族 4K 16:9 的 4096x2304 必须缩到上限内（与 main.py 同一套口径）。
 *   4) Midjourney 提示词清洗：单行、去 markdown、去 --（与 main.py 输出对拍）。
 *
 *   node tests/test_canvas_gen_pipe.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = 'novai-canvas-ui/src/canvas/canvas-next/';

/** 一次打进同一个 bundle：GenError 的 instanceof 在同一份模块实例里才成立 */
function loadAll() {
    const entry = path.join(require('os').tmpdir(), 'novai-gen-pipe-entry-' + process.pid + '.ts');
    const abs = (file) => JSON.stringify(path.join(ROOT, SRC + file));
    fs.writeFileSync(entry, [
        'export * as engine from ' + abs('engine.ts') + ';',
        'export * as model from ' + abs('model.ts') + ';',
        'export * as errorText from ' + abs('errorText.ts') + ';',
        'export * as caps from ' + abs('modelCaps.ts') + ';',
        'export * as mj from ' + abs('midjourney.ts') + ';',
        'export * as mentions from ' + abs('mentions.ts') + ';',
        'export * as optimize from ' + abs('promptOptimize.ts') + ';',
        'export * as types from ' + abs('backend/types.ts') + ';',
    ].join(String.fromCharCode(10)));
    try {
        const result = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
        const module = { exports: {} };
        new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
        return module.exports;
    } finally {
        fs.unlinkSync(entry);
    }
}

const { engine, model, errorText, caps, mj, mentions, optimize, types } = loadAll();

const CAM = { on: false, body: 0, lens: 0, focal: 2, aperture: 1 };
const specUI = (kind, ui) => model.specFor({ configId: 'apimart::' + kind + '-model', label: kind + '-model', vendor: 'APIMART', kind, ui, specSource: 'spec' });

const IMAGE_SPEC = specUI('image', { ratios: ['自适应', '1:1', '16:9'], sizes: ['1K', '2K', '4K'], batch: [1], maxRefs: 4, i2i: true });
const VIDEO_SPEC = specUI('video', { ratios: ['16:9'], res: ['720p'], durs: [5], modes: ['文生视频', '首帧'], times: [1] });
const TEXT_SPEC = model.specFor({ configId: 'apimart::text-model', label: 'text-model', vendor: 'APIMART', kind: 'text', vision: true, ui: { search: false }, specSource: 'spec' });
const AUDIO_SPEC = specUI('audio', { kinds: ['音乐'], adurs: ['自适应'] });
// 带「参考视频生视频」的视频规格（seedance-2.5 这类 up 有 video_urls 的模型）
const VIDEO_REF_SPEC = model.specFor({ configId: 'apimart::video-ref', label: 'video-ref', vendor: 'APIMART', kind: 'video', specSource: 'spec', ui: { ratios: ['16:9'], res: ['720p'], durs: [5], modes: ['文生视频', '首帧', '参考视频生视频', '视频编辑'], times: [1] } });
const SPECS = { [IMAGE_SPEC.id]: IMAGE_SPEC, [VIDEO_SPEC.id]: VIDEO_SPEC, [VIDEO_REF_SPEC.id]: VIDEO_REF_SPEC, [TEXT_SPEC.id]: TEXT_SPEC, [AUDIO_SPEC.id]: AUDIO_SPEC };

const PIX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const UPSTREAM_TEXT = '# 海报方案\n\n## 一、创意解题\n\n- **礼** 系红绸的礼盒\n- **乐** 古琴弦 → 音符\n\n--- 分隔线 ---\n\n负面提示词：AI generated look, CGI';

function genNode(id, kind, extra) {
    const spec = kind === 'image' ? IMAGE_SPEC : kind === 'video' ? VIDEO_SPEC : kind === 'text' ? TEXT_SPEC : AUDIO_SPEC;
    const node = model.newNode(kind, 0, 0, { id, ...(extra.data || {}) }, spec);
    return model.withGen(node, { title: extra.title || id, prompt: extra.prompt || '', ...(extra.gen || {}) });
}
const edge = (id, from, to) => ({ id, from, to });
function makeStore(doc) {
    return { state: { doc, canvasId: 'canvas-test' }, modelOf: (n) => SPECS[String((model.genOf(n).params || {}).model || '')] || null };
}
function doc(nodes, edges) { return { nodes, edges, comments: [] }; }

// ── 1. 请求组装：上游文本 + 上游图片 ─────────────────────────────────────────
const t1 = genNode('t1', 'text', { title: '上游提示词', gen: { manual: true, hist: [{ text: UPSTREAM_TEXT }], hi: 0 } });
const src = genNode('src', 'image', { title: '素材图', gen: { uploaded: true, hist: [{ url: PIX, w: 1024, h: 1024 }], hi: 0, params: { ...model.defaultParams('image', IMAGE_SPEC), ratio: '1:1', size: '1K' } } });

function downstream(kind, id, prompt, extra) {
    const params = kind === 'image' ? { ...model.defaultParams('image', IMAGE_SPEC), ratio: '16:9', size: '4K' }
        : kind === 'video' ? { ...model.defaultParams('video', VIDEO_SPEC), mode: '首帧' }
            : kind === 'text' ? model.defaultParams('text', TEXT_SPEC)
                : model.defaultParams('audio', AUDIO_SPEC);
    return genNode(id, kind, { title: id, prompt, gen: { ...(extra || {}), params, hist: [], hi: 0 } });
}

const req = (d, id) => engine.buildRequest(makeStore(d), d.nodes.find((n) => n.id === id));

// 图片下游：@ 引用上游文本 + 连入的图片
let d1 = doc([t1, src, downstream('image', 'i1', '参考 @{t1} 生成竖版海报，产品用图2')],
    [edge('e1', 't1', 'i1'), edge('e2', 'src', 'i1')]);
let r1 = req(d1, 'i1');
assert(r1, '图片下游要能组装请求');
assert(r1.resolvedPrompt.includes('## 一、创意解题'), '上游文本节点的正文要进 resolvedPrompt');
assert(!r1.resolvedPrompt.includes('@{t1}'), '@ 记号要被换成正文');
assert.deepStrictEqual(r1.inputs.map((x) => [x.nodeId, x.kind, x.role]), [['t1', 'text', 'context'], ['src', 'image', 'reference']], '文本 → context，图片 → reference');

// 视频下游（首帧）：文本当上下文，第 1 张图当首帧
let d2 = doc([t1, src, downstream('video', 'v1', '镜头推近，参考 @{t1}')], [edge('e1', 't1', 'v1'), edge('e2', 'src', 'v1')]);
let r2 = req(d2, 'v1');
assert.deepStrictEqual(r2.inputs.map((x) => [x.nodeId, x.role]), [['t1', 'context'], ['src', 'first_frame']], '视频「首帧」：文本 context + 图片 first_frame');
assert(r2.videoMode && r2.videoMode.name === '首帧');
assert(r2.resolvedPrompt.includes('## 一、创意解题'), '视频下游也要读到上游文本');

// 音频下游：文本当上下文
let d3 = doc([t1, downstream('audio', 'a1', '做一段氛围音乐，参考 @{t1}')], [edge('e1', 't1', 'a1')]);
let r3 = req(d3, 'a1');
assert.deepStrictEqual(r3.inputs.map((x) => [x.nodeId, x.role]), [['t1', 'context']]);
assert(r3.resolvedPrompt.includes('## 一、创意解题'));

// 文本下游：能读图的模型把图片当参考
let d4 = doc([src, downstream('text', 't2', '总结 @{src} 这张图')], [edge('e1', 'src', 't2')]);
let r4 = req(d4, 't2');
assert.deepStrictEqual(r4.inputs.map((x) => [x.nodeId, x.role]), [['src', 'reference']], '能读图的文本模型：图片 → reference');
assert(r4.resolvedPrompt.includes('「图1」'), '图片引用换成「图1」');

// ── 2. refMode 残留：提示词里已经没有 @，输入不能再被静默丢掉 ────────────────
let d5 = doc([t1, src, downstream('image', 'i2', '生成一张高级感海报', { refMode: 'mention' })], [edge('e1', 't1', 'i2'), edge('e2', 'src', 'i2')]);
const r5 = req(d5, 'i2');
assert.strictEqual(r5.inputs.length, 2, '引用模式残留但提示词里没有 @ → 已连接的输入照旧全部发送');
assert(r5.resolvedPrompt.includes('## 一、创意解题'), '上游文本仍然进提示词');

// 提示词里真的 @ 了：仍然只发被 @ 的那个
let d6 = doc([t1, src, downstream('image', 'i3', '只用 @{src} 这张图', { refMode: 'mention' })], [edge('e1', 't1', 'i3'), edge('e2', 'src', 'i3')]);
const r6 = req(d6, 'i3');
assert.deepStrictEqual(r6.inputs.map((x) => x.nodeId), ['src'], '引用模式生效：没被 @ 的上游不发送');

// ── 3. 表格行节点（data.frozen）：用当前提示词重建，预览与实际发送同一个函数 ──
const rowGen = genNode('row1', 'image', { title: '批量行', prompt: '新提示词：一只猫', gen: { hist: [], hi: 0 } });
const frozen = {
    canvasId: 'canvas-test', nodeId: 'row1', kind: 'image', model: IMAGE_SPEC, prompt: '旧提示词：一只狗',
    resolvedPrompt: '旧的上游文本\n旧提示词：一只狗', params: { ...model.defaultParams('image', IMAGE_SPEC), ratio: '1:1' },
    inputs: [{ nodeId: 't1', title: '上游提示词', kind: 'text', order: 1, role: 'context', text: '这一行的表格文本' }],
};
const rowNode = model.withGen({ ...rowGen, data: { ...rowGen.data, frozen, rowText: '这一行自己的文案' } }, { prompt: '新提示词：一只猫' });
const d7 = doc([t1, rowNode], [edge('e1', 't1', 'row1')]);
const store7 = makeStore(d7);
const pre = JSON.parse(JSON.stringify(engine.requestForNode(store7, d7.nodes[1])));
const sent = engine.requestForNode(store7, d7.nodes[1]);
assert.strictEqual(sent.resolvedPrompt, pre.resolvedPrompt, '请求预览与实际发送必须是同一个函数的结果');
assert(sent.resolvedPrompt.includes('新提示词：一只猫'), '行节点改了提示词，不能再发旧请求');
assert(sent.resolvedPrompt.includes('这一行自己的文案'), '行绑定的表格文案要保留');
assert(sent.resolvedPrompt.includes('这一行的表格文本'), '行输入里的上游文本要保留');
assert(sent.params.ratio === model.defaultParams('image', IMAGE_SPEC).ratio, '参数取节点当前值');

// ── 4. 失败信息：未知码（含 FAILED）透出后端可读 message ────────────────────
const realFail = 'GPT-Image-2 不支持当前尺寸 4096x2304：它有最大像素限制（长边最大 3840、总像素约 829 万）。';
let ne = errorText.nodeError(new types.GenError('FAILED', realFail));
assert.strictEqual(ne.err, realFail, 'FAILED + 中文 message：主行直接用后端文案');
assert.strictEqual(ne.errCode, 'FAILED', '原始码仍然保留（弹层以「代码：…」展示）');
ne = errorText.nodeError(new types.GenError('FAILED', ''));
assert.strictEqual(ne.err, errorText.FALLBACK_TEXT, 'message 为空才用兜底文案');
assert.strictEqual(ne.errCode, 'FAILED');
ne = errorText.nodeError(new types.GenError('RATE_LIMITED', '上游 429'));
assert.strictEqual(ne.err, '请求太频繁被限流，请稍后重试', '已知码保持现有映射（不打乱码表）');
assert.strictEqual(ne.errCode, 'RATE_LIMITED');
ne = errorText.nodeError(new types.GenError('SIZE_UNSUPPORTED', '这个尺寸模型不接受，请换 2K 或更小'));
assert.strictEqual(ne.err, '这个尺寸模型不接受，请换 2K 或更小', '未知码同样透出可读原因');
assert.strictEqual(ne.errCode, 'SIZE_UNSUPPORTED');
ne = errorText.nodeError(new TypeError('Cannot read properties of undefined'));
assert.strictEqual(ne.err, errorText.FALLBACK_TEXT, '非 GenError 的英文异常串不外泄（避免甩 JS 报错给用户）');

// ── 5. 尺寸钳制：GPT-Image 家族 4K 16:9 → 合法尺寸 ─────────────────────────
const GPT_LIMITS = { maxLongEdge: 3840, maxPixels: 8294400, minPixels: 655360 };
const clampEq = (input, want) => assert.strictEqual(caps.clampImageSize(input, GPT_LIMITS).size, want, input + ' → ' + want);
clampEq('4096x2304', '3840x2160');
clampEq('4096x4096', '2880x2880');
clampEq('16384x16384', '2880x2880');
clampEq('1024x1024', '1024x1024');
clampEq('2048x1152', '2048x1152');
assert.strictEqual(caps.clampImageSize('4096x2304', GPT_LIMITS).clamped, true);
assert.strictEqual(caps.clampImageSize('2048x1152', GPT_LIMITS).clamped, false);
assert.strictEqual(caps.clampImageSize('4096x2304', {}).size, '4096x2304', '模型没声明上限时原样发送');
assert.strictEqual(caps.clampImageSize('auto', GPT_LIMITS).size, 'auto', '档位 / auto 不在这里换算');

// ── 6. Midjourney 提示词清洗 ────────────────────────────────────────────────
const mjSource = IMAGE_SPEC;
const dirty = '根据「' + UPSTREAM_TEXT + '」生成一张国潮海报 --v 6.1 ---\n第二行';
const mjCleaned = mj.midjourneyPrompt(dirty);
assert(!/[\r\n]/.test(mjCleaned), 'MJ 提示词必须单行');
assert(!mjCleaned.includes('#'), '去 markdown 标题');
assert(!mjCleaned.includes('**'), '去 markdown 强调');
assert(!mjCleaned.includes('|'), '去表格竖线');
assert(!/--/.test(mjCleaned), '不能留下 --（MJ 会当参数解析）');
assert(mjCleaned.includes('系红绸的礼盒'), '内容要保留（上游文本仍然进提示词）');
assert(mjCleaned.length <= mj.MJ_PROMPT_LIMIT);
assert.strictEqual(mj.midjourneyPrompt('') , '');
void mjSource;

// ── 9. 已有结果的媒体节点再生成：新节点同时连上「原输入」和「被点的节点自己」 ──
function fakeStore(d) {
    const store = {
        state: { doc: d, canvasId: 'canvas-test' },
        modelOf: (n) => SPECS[String((model.genOf(n).params || {}).model || '')] || null,
        node(id) { return this.state.doc.nodes.find((x) => x.id === id); },
        toast() {},
        addNodes(nodes, edges = []) {
            this.state.doc = { nodes: [...this.state.doc.nodes, ...nodes], edges: [...this.state.doc.edges, ...edges], comments: [] };
            // 真实 store 会把新边追加进目标节点的 gen.order，这里照做（顺序断言要用）
            for (const e of edges) {
                this.state.doc = { ...this.state.doc, nodes: this.state.doc.nodes.map((n) => (n.id === e.to ? model.withGen(n, { order: [...model.genOf(n).order, e.id] }) : n)) };
            }
        },
        patchGen(id, patch) {
            const n = this.node(id); if (!n) return;
            const cur = model.genOf(n); const p = typeof patch === 'function' ? patch(cur) : patch;
            this.state.doc = { ...this.state.doc, nodes: this.state.doc.nodes.map((x) => (x.id === id ? model.withGen(x, p) : x)) };
        },
    };
    return store;
}
const incoming = (store, id) => store.state.doc.edges.filter((e) => e.to === id).map((e) => e.from);

// 9.1 图片：新节点 = 原输入（文本）+ 被点的图片节点自己
const imgOut = genNode('i_out', 'image', { title: '原图', gen: { hist: [{ url: PIX, w: 1024, h: 1024 }], hi: 0 } });
let s9 = fakeStore(doc([t1, imgOut], [edge('e1', 't1', 'i_out')]));
const madeImg = engine.regenAsNew(s9, s9.node('i_out'));
assert.deepStrictEqual(incoming(s9, madeImg.id).sort(), ['i_out', 't1'], '图片再生成：原输入 + 自己这条来源连线都要在');
const reqImg = engine.requestForNode(s9, s9.node(madeImg.id));
assert.deepStrictEqual(reqImg.inputs.map((x) => [x.nodeId, x.role]), [['t1', 'context'], ['i_out', 'reference']], '图片目标：来源图作为 reference 进请求，文本仍是 context');
// gen.order：两条边都进了新节点的输入顺序
assert.strictEqual(model.genOf(s9.node(madeImg.id)).order.length, 2, 'gen.order 要有两条输入');

// 9.2 图片：不支持 i2i 的模型 → 面板提示「不支持参考图」（这里断言 ignored，别的调用方据此出警告）
const NOI2I = model.specFor({ configId: 'apimart::no-i2i', label: 'no-i2i', vendor: 'APIMART', kind: 'image', specSource: 'spec', ui: { ratios: ['1:1'], sizes: ['1K'], batch: [1], maxRefs: 0 } });
SPECS[NOI2I.id] = NOI2I;
const flat = genNode('i_flat', 'image', { title: '不支持参考图的图', gen: { hist: [{ url: PIX }], hi: 0, params: { ...model.defaultParams('image', NOI2I), ratio: '1:1', size: '1K' } } });
let s9b = fakeStore(doc([t1, flat], [edge('e1', 't1', 'i_flat')]));
const madeFlat = engine.regenAsNew(s9b, s9b.node('i_flat'));
const reqFlat = engine.requestForNode(s9b, s9b.node(madeFlat.id));
assert.deepStrictEqual(reqFlat.inputs.map((x) => x.nodeId), ['t1'], '不支持参考图的模型：来源图不发送（面板照旧提示不支持参考图）');

// 9.3 文本：不加媒体边（文本是提示词，连过去只会变上下文）
const tOut = genNode('t_out', 'text', { title: '原文本', gen: { manual: true, hist: [{ text: '旧稿' }], hi: 0 } });
let s9c = fakeStore(doc([t1, tOut], [edge('e1', 't1', 't_out')]));
const madeText = engine.regenAsNew(s9c, s9c.node('t_out'));
assert.deepStrictEqual(incoming(s9c, madeText.id).sort(), ['t1'], '文本再生成：只复制原输入，不连文本自己');

// 9.4 没有结果的媒体节点：不连自己（避免留下取不到东西的空边）
const imgEmpty = genNode('i_empty', 'image', { title: '空图' });
let s9d = fakeStore(doc([t1, imgEmpty], [edge('e1', 't1', 'i_empty')]));
const madeEmpty = engine.regenAsNew(s9d, s9d.node('i_empty'));
assert.deepStrictEqual(incoming(s9d, madeEmpty.id).sort(), ['t1'], '没结果的节点不连自己');

// 9.5 视频：来源视频当参考 → 显式选「参考视频生视频」（autoVideoMode 会退回文生视频把来源丢掉）
const vOut = genNode('v_out', 'video', { title: '原视频', gen: { hist: [{ url: PIX, frame: PIX }], hi: 0, params: { ...model.defaultParams('video', VIDEO_REF_SPEC), mode: '文生视频' } } });
let s9e = fakeStore(doc([t1, vOut], [edge('e1', 't1', 'v_out')]));
const madeVid = engine.regenAsNew(s9e, s9e.node('v_out'));
assert.deepStrictEqual(incoming(s9e, madeVid.id).sort(), ['t1', 'v_out'], '视频再生成：原输入 + 来源视频');
assert.strictEqual(model.genOf(s9e.node(madeVid.id)).params.mode, '参考视频生视频', '来源视频要显式用「参考视频生视频」（否则 autoVideoMode 退回文生视频丢掉来源）');
const reqVid = engine.requestForNode(s9e, s9e.node(madeVid.id));
assert.deepStrictEqual(reqVid.inputs.map((x) => [x.nodeId, x.role]), [['t1', 'context'], ['v_out', 'reference_video']], '视频目标：来源视频作为 reference_video 发送');
assert.strictEqual(reqVid.videoMode.name, '参考视频生视频');

// 9.6 视频：模型没有「参考视频生视频」→ 退到「视频编辑」
const VID_EDIT = model.specFor({ configId: 'apimart::video-edit', label: 'video-edit', vendor: 'APIMART', kind: 'video', specSource: 'spec', ui: { ratios: ['16:9'], res: ['720p'], durs: [5], modes: ['文生视频', '首帧', '视频编辑'], times: [1] } });
SPECS[VID_EDIT.id] = VID_EDIT;
const vOut2 = genNode('v_out2', 'video', { title: '原视频2', gen: { hist: [{ url: PIX }], hi: 0, params: { ...model.defaultParams('video', VID_EDIT), mode: '文生视频' } } });
let s9f = fakeStore(doc([t1, vOut2], [edge('e1', 't1', 'v_out2')]));
const madeVid2 = engine.regenAsNew(s9f, s9f.node('v_out2'));
assert.strictEqual(model.genOf(s9f.node(madeVid2.id)).params.mode, '视频编辑', '没有「参考视频生视频」时退到「视频编辑」');

// 9.7 音频：连线保留（表示来源），但音频模型不收媒体输入 → 请求里没有它
const aOut = genNode('a_out', 'audio', { title: '原音频', gen: { hist: [{ url: PIX, dur: 30 }], hi: 0 } });
let s9g = fakeStore(doc([t1, aOut], [edge('e1', 't1', 'a_out')]));
const madeAud = engine.regenAsNew(s9g, s9g.node('a_out'));
assert.deepStrictEqual(incoming(s9g, madeAud.id).sort(), ['a_out', 't1'], '音频再生成：来源连线保留（面板会说明只是来源标记）');
const reqAud = engine.requestForNode(s9g, s9g.node(madeAud.id));
assert.deepStrictEqual(reqAud.inputs.map((x) => [x.nodeId, x.role]), [['t1', 'context']], '音频目标：媒体输入不随请求发送（只保留文本上下文）');

// 9.8 表格批量行节点（frozen）：不连自己（请求由冻结的行输入决定，媒体边不会进请求）
const rowOut = genNode('row_out', 'image', { title: '批量行', gen: { hist: [{ url: PIX }], hi: 0 } });
const rowFrozen = { canvasId: 'canvas-test', nodeId: 'row_out', kind: 'image', model: IMAGE_SPEC, prompt: '行提示词', resolvedPrompt: '行提示词',
    params: { ...model.defaultParams('image', IMAGE_SPEC) }, inputs: [{ nodeId: 't1', title: '上游提示词', kind: 'text', order: 1, role: 'context', text: '行素材说明' }] };
const rowNode2 = model.withGen({ ...rowOut, data: { ...rowOut.data, frozen: rowFrozen } }, { prompt: '行提示词' });
let s9h = fakeStore(doc([t1, rowNode2], [edge('e1', 't1', 'row_out')]));
const madeRow = engine.regenAsNew(s9h, s9h.node('row_out'));
assert.deepStrictEqual(incoming(s9h, madeRow.id), ['t1'], 'frozen 行节点再生成：不额外连自己（媒体边不进请求）');
assert.strictEqual(engine.requestForNode(s9h, s9h.node(madeRow.id)).resolvedPrompt, '行素材说明' + String.fromCharCode(10) + '行提示词', 'frozen 行节点的请求仍按冻结输入重建');

// 9.9 落点：新节点在原节点右边 120px 起、顶边对齐（不再往正下方叠）
const pBase = genNode('p_base', 'image', { title: '落点原图', gen: { hist: [{ url: PIX, w: 1024, h: 1024 }], hi: 0 } });
let s9i = fakeStore(doc([pBase], []));
const madePos = engine.regenAsNew(s9i, s9i.node('p_base'));
assert.ok(madePos.x >= pBase.x + pBase.w + 120, '新节点落在原节点右边（≥ 原 x + 原 w + 120）');
assert.strictEqual(madePos.y, pBase.y, '新节点与原节点顶边对齐');
// 来源节点记在新节点的 data 上；结果写回走 patchGen → withGen，不能把它弄丢
assert.strictEqual((s9i.node(madePos.id).data || {}).sourceNodeId, 'p_base', '新节点 data.sourceNodeId = 点生成的那个节点');
s9i.patchGen(madePos.id, { hist: [{ url: PIX }], hi: 0 });
assert.strictEqual((s9i.node(madePos.id).data || {}).sourceNodeId, 'p_base', '历史写回后来源节点仍在');
assert.strictEqual(model.genOf(s9i.node(madePos.id)).hist.length, 1, '结果照常写回历史');

// 9.10 让位：本该落的位置被别的节点占着 → 落到那个占位节点的右边
const holder = { ...genNode('p_holder', 'image', { title: '占位图' }), x: pBase.x + pBase.w + 120, y: pBase.y };
let s9j = fakeStore(doc([pBase, holder], []));
const madeLet = engine.regenAsNew(s9j, s9j.node('p_base'));
assert.ok(madeLet.x >= holder.x + holder.w + 120, '右边被占：落到占位节点的右边');
assert.strictEqual(madeLet.y, pBase.y, '让位后仍与原节点顶边对齐');

// 9.11 右边一整排都占着 → 掉到下方
const rowStart = pBase.x + pBase.w + 120;
const wall = Array.from({ length: 12 }, (_, i) => ({ ...genNode('p_wall' + i, 'image', { title: '排满' + i }), x: rowStart + i * 360, y: pBase.y }));
let s9k = fakeStore(doc([pBase, ...wall], []));
const madeWall = engine.regenAsNew(s9k, s9k.node('p_base'));
assert.ok(madeWall.y > pBase.y + pBase.h, '右边整排占满：掉到原节点下方');

// 9.12 freeSpotRight 是纯函数：不碰 store / doc，单独调用也是同一套落点
const beforeSpot = JSON.stringify(s9k.state.doc);
const spot = engine.freeSpotRight(s9k.state.doc, s9k.node('p_base'));
assert.ok(spot.y > pBase.y + pBase.h, 'freeSpotRight 单独调用同样掉到下方');
assert.strictEqual(JSON.stringify(s9k.state.doc), beforeSpot, 'freeSpotRight 不改 doc（纯函数）');

// ── 10. @ 本节点：把当前结果当参考发出去 ──────────────────────────────────
// 10.1 图片：@ 自己 + 有结果 → self 作为 reference 进 inputs，resolvedPrompt 里是「图N」而不是标题
const selfImg = genNode('self_img', 'image', { title: '本节点图', prompt: '把 @{self_img} 再画一版', gen: { hist: [{ url: PIX, w: 1024, h: 1024 }], hi: 0, params: { ...model.defaultParams('image', IMAGE_SPEC), ratio: '1:1', size: '1K' } } });
const d10 = doc([t1, selfImg], [edge('e1', 't1', 'self_img')]);
const r10 = engine.requestForNode(makeStore(d10), d10.nodes[1]);
const selfIn = r10.inputs.filter((x) => x.nodeId === 'self_img');
assert.strictEqual(selfIn.length, 1, '@ 本节点：inputs 里要有自己当前结果');
assert.strictEqual(selfIn[0].role, 'reference', '图片自引用 → reference');
assert.strictEqual(selfIn[0].url, PIX, '用的是本节点当前结果');
assert.strictEqual(selfIn[0].order, r10.inputs.length, 'self 追加在 inputs 末尾（order = length）');
assert(r10.resolvedPrompt.includes('「图1」') || r10.resolvedPrompt.includes('「图2」'), 'resolvedPrompt 里 self 显示成「图N」');
assert(!r10.resolvedPrompt.includes('@'), '记号要全部换成「图N」');
// 10.2 没有结果：不加 self（记号只显示标题）
const noOutImg = genNode('self_noout', 'image', { title: '没结果的图', prompt: '用 @{self_noout} 再画', gen: { hist: [], hi: 0 } });
const d10b = doc([t1, noOutImg], [edge('e1', 't1', 'self_noout')]);
const r10b = engine.requestForNode(makeStore(d10b), d10b.nodes[1]);
assert.strictEqual(r10b.inputs.filter((x) => x.nodeId === 'self_noout').length, 0, '没结果时不发 self');
assert(r10b.resolvedPrompt.includes('「没结果的图」'), '没发送时 self 记号退回标题');
assert.strictEqual(mentions.selfRefOf(d10b.nodes[1]), null, '没结果时 @ 面板不给「本节点」条目');
// 10.3 视频：参考视频生视频 → reference_video；文生视频 → 不发
const selfVid = genNode('self_vid', 'video', { title: '本节点视频', prompt: '用 @{self_vid} 当参考', gen: { hist: [{ url: PIX, frame: PIX }], hi: 0, params: { ...model.defaultParams('video', VIDEO_REF_SPEC), mode: '参考视频生视频' } } });
const d10c = doc([t1, selfVid], [edge('e1', 't1', 'self_vid')]);
const r10c = engine.requestForNode(makeStore(d10c), d10c.nodes[1]);
assert.deepStrictEqual(r10c.inputs.filter((x) => x.nodeId === 'self_vid').map((x) => x.role), ['reference_video'], '视频自引用（参考视频生视频）→ reference_video');
const selfVid2 = genNode('self_vid2', 'video', { title: '本节点视频2', prompt: '用 @{self_vid2}', gen: { hist: [{ url: PIX }], hi: 0, params: { ...model.defaultParams('video', VIDEO_REF_SPEC), mode: '文生视频' } } });
const d10d = doc([t1, selfVid2], [edge('e1', 't1', 'self_vid2')]);
assert.strictEqual(engine.requestForNode(makeStore(d10d), d10d.nodes[1]).inputs.filter((x) => x.nodeId === 'self_vid2').length, 0, '文生视频不接受视频输入：不伪造发送');
// 10.4 文本 / 音频：@ 面板不出「本节点」条目
assert.strictEqual(mentions.selfRefOf(t1), null, '文本节点不能 @ 自己');
const selfAud = genNode('self_aud', 'audio', { title: '本节点音频', gen: { hist: [{ url: PIX }], hi: 0 } });
assert.strictEqual(mentions.selfRefOf(selfAud), null, '音频节点不能 @ 自己');
// 10.5 refMode：只 @ 了自己不算「引用过上游」，已连接的输入照旧全发
const selfStale = genNode('self_stale', 'image', { title: '本节点图2', prompt: '把 @{self_stale} 变形', gen: { hist: [{ url: PIX }], hi: 0, refMode: 'mention', params: { ...model.defaultParams('image', IMAGE_SPEC), ratio: '1:1', size: '1K' } } });
const d10e = doc([t1, selfStale], [edge('e1', 't1', 'self_stale')]);
const r10e = engine.requestForNode(makeStore(d10e), d10e.nodes[1]);
assert(r10e.inputs.some((x) => x.nodeId === 't1'), '@ 本节点不应把已连接的上游丢掉（refMode 只算上游引用）');
assert(r10e.inputs.some((x) => x.nodeId === 'self_stale'), '同时仍然带上自己');
// 10.6 模型不支持图生图：不发 self（面板照旧提示不支持参考图）
const selfFlat = genNode('self_flat', 'image', { title: '本节点图3', prompt: '用 @{self_flat}', gen: { hist: [{ url: PIX }], hi: 0, params: { ...model.defaultParams('image', NOI2I), ratio: '1:1', size: '1K' } } });
const d10f = doc([selfFlat], []);
assert.strictEqual(engine.requestForNode(makeStore(d10f), d10f.nodes[0]).inputs.filter((x) => x.nodeId === 'self_flat').length, 0, '不支持参考图的模型：自引用不发送');

// ── 11. 优化提示词：引用用占位符保住（不依赖模型保住标题） + 默认模型优先级 ──
const countMentions = (s) => (String(s || '').match(/@\{[A-Za-z0-9_-]+/g) || []).length;
const PROMPT11 = '根据@{t1} 的画面，参考@{src} 的构图，再把@{i11} 的光影调亮，元素@小AB 也用上';
const MASK11 = optimize.maskPromptRefs(PROMPT11, { elements: ['小A', '小AB'], label: (t) => t });
// 11.1 引用全部换成占位符；模型把周围文字全改写也照样还原
assert(!MASK11.text.includes('@{'), '引用不能以记号形式发给模型');
assert(MASK11.text.includes('⟦1⟧') && MASK11.text.includes('⟦4⟧'), '每个引用一个占位符');
assert.strictEqual(MASK11.mask.slots.length, 4, '两处引用 + 自引用 + 元素 = 4 个占位符');
const rewriten = '换成另一套说法：把 ⟦1⟧ 里的产品放进 ⟦2⟧ 的场景，光线照 ⟦3⟧，质感学 ⟦4⟧，画面更干净';
const un11 = optimize.unmaskRefs(rewriten, MASK11.mask, { appendMissing: true });
assert(un11.text.includes('@{t1}') && un11.text.includes('@{src}') && un11.text.includes('@{i11}') && un11.text.includes('@小AB'), '四个引用都要还原成原始记号');
assert.strictEqual(un11.missing.length, 0, '模型保住了就不用补');
assert.strictEqual(countMentions(un11.text), countMentions(PROMPT11), '优化前后引用数量一致');
// 11.2 模型弄丢占位符：末尾补回，并且报告补了几个
const lost = '把 ⟦1⟧ 里的产品放到新场景，其余照旧';
const un12 = optimize.unmaskRefs(lost, MASK11.mask, { appendMissing: true });
assert.strictEqual(un12.missing.length, 3, '丢了 3 个引用要如实报告');
assert(un12.text.includes('@{src}') && un12.text.includes('@{i11}') && un12.text.includes('@小AB'), '丢掉的引用按原顺序补到末尾');
assert.strictEqual(countMentions(un12.text), countMentions(PROMPT11), '补回后引用数量仍然一致');
// 11.3 流式：半个占位符不能吐出来
const stream = optimize.unmaskRefs('把 ⟦1⟧ 里的产品 ⟦2', MASK11.mask, { appendMissing: false });
assert(!stream.text.includes('⟦'), '流式里不能出现半个占位符');
assert(stream.text.includes('@{t1}'), '完整的占位符照常还原');
// 11.4 元素名：长名优先，且不吞掉以元素名为前缀的其它 @ 文本
const m14 = optimize.maskPromptRefs('@小AB 和 @小A 都用，@产品图 不是元素', { elements: ['小A', '小AB', '产品'] });
assert.deepStrictEqual([...m14.mask.restore.values()], ['@小AB', '@小A'], '长元素名优先，短名各自独立');
assert(m14.text.includes('@产品图'), '元素「产品」不能把「@产品图」的前缀吃掉');
// 11.5 optimizeContext 发出去的 prompt 是占位符版，标签里能认出「本节点」
const ctx11 = (() => {
    const selfNode = genNode('i11', 'image', { title: '海报草稿', prompt: PROMPT11, gen: { hist: [{ url: PIX }], hi: 0 } });
    const d = doc([t1, src, selfNode], [edge('e1', 't1', 'i11'), edge('e2', 'src', 'i11')]);
    return optimize.optimizeContext({ state: { doc: d, canvasId: 'c1' }, modelOf: (n) => SPECS[String((model.genOf(n).params || {}).model || '')] || IMAGE_SPEC }, d.nodes[2]);
})();
assert(!ctx11.prompt.includes('@{'), 'optimizeContext 给模型的 prompt 已经换成占位符');
assert.strictEqual(ctx11.mask.slots.length, 3, '上游文本 + 上游图片 + 本节点 = 3 个占位符');
assert.strictEqual(ctx11.mask.labels.get(ctx11.mask.slots[2]), '本节点', '自引用在对照表里标成「本节点」');
// 11.6 pickOptimizerModel 优先级：设置默认 → 文本节点自己的 → 能看图的 → 第一个文本模型
const VISION_TXT = model.specFor({ configId: 'apimart::vtxt', label: 'vtxt', vendor: 'APIMART', kind: 'text', vision: true, ui: { search: false }, specSource: 'spec' });
const PLAIN_TXT = model.specFor({ configId: 'apimart::ptxt', label: 'ptxt', vendor: 'APIMART', kind: 'text', vision: false, ui: { search: false }, specSource: 'spec' });
const TEXT_MODELS = [VISION_TXT, PLAIN_TXT];
assert.strictEqual(optimize.pickOptimizerModel(TEXT_MODELS, { kind: 'text', model: PLAIN_TXT }, true, VISION_TXT.id).id, VISION_TXT.id, '设置里的默认文本模型优先');
assert.strictEqual(optimize.pickOptimizerModel(TEXT_MODELS, { kind: 'text', model: PLAIN_TXT }, true, PLAIN_TXT.id).id, PLAIN_TXT.id, '默认模型看不了图也不偷偷换');
assert.strictEqual(optimize.pickOptimizerModel(TEXT_MODELS, { kind: 'text', model: PLAIN_TXT }, true, null).id, PLAIN_TXT.id, '没有默认模型时用文本节点自己的模型');
assert.strictEqual(optimize.pickOptimizerModel([PLAIN_TXT], { kind: 'image', model: IMAGE_SPEC }, true, null).id, PLAIN_TXT.id, '非文本节点：没有能看图的就退到第一个文本模型');
assert.strictEqual(optimize.pickOptimizerModel([PLAIN_TXT, VISION_TXT], { kind: 'image', model: IMAGE_SPEC }, true, null).id, VISION_TXT.id, '需要看图时优先有 vision 的');
assert.strictEqual(optimize.pickOptimizerModel(TEXT_MODELS, { kind: 'image', model: IMAGE_SPEC }, false, 'not-exist').id, VISION_TXT.id, '默认模型 id 不在清单里 → 按原规则回退');

// ── 7. 接线：前端请求组装真的用上了这些（静态断言） ─────────────────────────
const backendSrc = fs.readFileSync(path.join(ROOT, 'novai-canvas-ui/src/novaiBackend.ts'), 'utf8');
assert(/requestImageSize\(req\.model, imageSize\(req\.params as ImageParams\)\)/.test(backendSrc), '图片请求组装要经过尺寸钳制');
assert(/promptForModel\(req\.model, req\.resolvedPrompt\)/.test(backendSrc), '图片请求组装要经过 MJ 提示词清洗');
assert(/clampImageSize\(size, \{ maxLongEdge/.test(backendSrc), '尺寸钳制读 /api/model-caps 的像素上限');
const panelSrc = fs.readFileSync(path.join(ROOT, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
assert(panelSrc.includes('requestForNode(store, node, rows[0])'), '请求预览与实际发送共用 requestForNode');
assert(panelSrc.includes('vp-pick tipB" + (preview ? " on" : "")} data-p="preview"'), '视频节点也有请求预览入口');
const editorSrc = fs.readFileSync(path.join(ROOT, 'novai-canvas-ui/src/canvas/canvas-next/ui/PromptEditor.tsx'), 'utf8');
assert(editorSrc.includes('selfRefOf(node)'), '@ 面板用 selfRefOf 判断本节点能不能 @ 自己');
assert(editorSrc.includes('本节点 · '), '@ 列表里给出「本节点」条目');
assert(!/connect\(store, id, node\.id/.test(editorSrc.split('id === node.id')[0].slice(-400)), '自引用胶囊不能去连一条自己到自己的边');

// ── 8. 与后端 main.py 对拍（没有可用 python 环境时跳过） ────────────────────
function pythonProbe() {
    const script = [
        'import json, sys',
        'import main',
        'rows = json.load(sys.stdin)',
        'print(json.dumps({',
        '  "normalize": {s: main.normalize_gpt_image_2_size(s) for s in rows["sizes"]},',
        '  "mj": {s: main.midjourney_prompt_text(s) for s in rows["prompts"]},',
        '}, ensure_ascii=False))',
    ].join('\n');
    const candidates = [path.join(ROOT, 'venv/bin/python'), 'python3'];
    for (const bin of candidates) {
        if (bin === 'python3') {
            const probe = spawnSync('python3', ['-c', 'import fastapi, httpx'], { encoding: 'utf8' });
            if (probe.error || probe.status !== 0) continue;
        } else if (!fs.existsSync(bin)) continue;
        const result = spawnSync(bin, ['-c', script], {
            cwd: ROOT, input: JSON.stringify({ sizes: ['4096x2304', '4096x4096', '16384x16384', '1024x1024'], prompts: [dirty] }),
            encoding: 'utf8', timeout: 180000, env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1', NOVAI_DATA_DIR: '/tmp/novai-gen-pipe-test' }),
        });
        if (result.error || result.status !== 0) continue;
        try { return { bin, data: JSON.parse(result.stdout.trim().split('\n').pop()) }; } catch { return null; }
    }
    return null;
}
const backendProbe = pythonProbe();
if (!backendProbe) {
    console.log('[gen-pipe] 跳过 main.py 对拍（没有能 import fastapi 的 python）');
} else {
    for (const size of ['4096x2304', '4096x4096', '16384x16384', '1024x1024']) {
        assert.strictEqual(caps.clampImageSize(size, GPT_LIMITS).size, backendProbe.data.normalize[size],
            '前端与后端 main.py 的尺寸口径一致：' + size + '（' + backendProbe.bin + '）');
    }
    assert.strictEqual(mj.midjourneyPrompt(dirty), backendProbe.data.mj[dirty], '前端与后端 main.py 的 MJ 清洗规则一致（' + backendProbe.bin + '）');
}

console.log('[gen-pipe] 全部通过' + (backendProbe ? '（含 main.py 对拍：' + backendProbe.bin + '）' : ''));
