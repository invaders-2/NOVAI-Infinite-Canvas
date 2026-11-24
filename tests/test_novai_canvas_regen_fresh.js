#!/usr/bin/env node
/* 「再来一张 / 再来一条」和画布助手「再做一张」不再把上一版结果当参考图（产品规则 R1~R5）。
   规则（实现见 model.ts 的 meta.prompt、mentions.ts 的 autoSelfUrl/materialUrlOf、engine.ts 的 buildRequest）：
   R1 模型生成的上一版结果不再自动当参考图，自动带上的只有「原始素材」：上传 / 拖入 / 外部导入 / 本地编辑产物（没有 runId 的那一版）；
   R2 明确要带时才带：提示词里 @ 了本节点（既有能力），或提示词相对出这一版时改过（仍把当前这一版当第一参考）；
   R3 结果节点和来源节点之间的自动连线只表示来源，不作为输入发送；改为沿用来源节点自己的输入（展开、去重、递归 sourceNodeId 链）；
   R4 真正要拿来源当输入的功能（出成片 / 时间线重拍 / 视频延长）用 data.keepSourceInput = true 保住；
   R5 画布助手「在这张基础上改」：后端写 data.agentRun.referenceImages / agentPendingReferenceImages，前端当参考图加进请求。
   用例 a~g 对应验收清单，全部走真实 buildRequest / regenAsNew。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const mentions = load('novai-canvas-ui/src/canvas/canvas-next/mentions.ts');
const engine = load('novai-canvas-ui/src/canvas/canvas-next/engine.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const { buildRequest, regenAsNew, requestForNode } = engine;

const IMG = { id: 'm::img', name: 'img', vendor: 'v', kind: 'image', i2i: true, maxRefs: 4 };
const VID = { id: 'm::vid', name: 'vid', vendor: 'v', kind: 'video', modes: ['文生视频', '首帧', '视频编辑', '参考视频生视频', '视频延长'], maxRefs: 4 };
const node = (id, kind, gen = {}, data = {}) => ({ id, kind, x: 0, y: 0, w: 200, h: 200, text: '', data: { ...data, gen: { title: id, prompt: '', params: {}, order: [], hist: [], hi: 0, ...gen } } });
const edge = (id, from, to) => ({ id, from, to });
/** 模型生成的一版：带 runId + 出这版时的提示词 */
const modelVersion = (url, prompt = '画一只猫', extra = {}) => ({ url, meta: { runId: 'run-' + url, prompt, ...extra } });
const storeOf = (doc, m = IMG, runs) => ({ state: { doc, canvasId: 'c1', runs }, modelOf: () => m });
const urlsOf = (req) => (req.inputs || []).map((x) => x.url);
const idsOf = (req) => (req.inputs || []).map((x) => x.nodeId);

/* ---- a. 同提示词重复生成：不带上一版结果，也不带来源节点图 ---- */
{
    // 纯生成节点：当前这一版是模型生成的，提示词和出这一版时一样 → 没有原始素材，什么都不带
    const n = node('n1', 'image', { prompt: '画一只猫', hist: [modelVersion('/gen-v1.png')], hi: 0 });
    const req = buildRequest(storeOf({ nodes: [n], edges: [] }), n);
    assert.deepStrictEqual(urlsOf(req), [], 'a：同提示词重复生成不带上一版结果（R1）');
    assert.strictEqual(req.selfSrc, null, 'a：没发就记 null，下次也不会补上一版结果');

    // 结果节点：来源连线（S → R）只表示来源，不发送；来源自己也没有原始素材 → 不发
    const S = node('s1', 'image', { prompt: '画一只猫', hist: [modelVersion('/src-v1.png')], hi: 0 });
    const R = node('r1', 'image', { prompt: '画一只猫', hist: [modelVersion('/gen-v1.png')], hi: 0 }, { sourceNodeId: 's1' });
    const req2 = buildRequest(storeOf({ nodes: [S, R], edges: [edge('e1', 's1', 'r1')] }), R);
    assert.deepStrictEqual(urlsOf(req2), [], 'a：同提示词重复生成也不带来源节点图（R3）');
}

/* ---- b. 提示词改过：仍把当前这一版当第一参考（保留迭代手感） ---- */
{
    const n = node('n1', 'image', { prompt: '把猫换成狗', hist: [modelVersion('/gen-v1.png', '画一只猫')], hi: 0 });
    const req = buildRequest(storeOf({ nodes: [n], edges: [] }), n);
    assert.deepStrictEqual(urlsOf(req), ['/gen-v1.png'], 'b：提示词相对出这一版改过 → 当前这一版当参考（R2）');
    assert.strictEqual(req.inputs[0].role, 'reference', 'b：当前这一版用 reference 角色');
    assert.strictEqual(req.selfSrc, '/gen-v1.png', 'b：实际发出去的那张照常记到新版本');

    // 归一空白后再比较：只多了空格 / 换行算「没改」
    const same = node('n2', 'image', { prompt: '画 一只猫\n', hist: [modelVersion('/gen-v2.png', '画  一只猫')], hi: 0 });
    assert.strictEqual(mentions.samePromptAsVersion(model.genOf(same).hist[0], '画 一只猫\n'), true, 'b：空白归一后相同算同提示词');
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [same], edges: [] }), same)), [], 'b：只差空白 → 按同提示词处理，不带上一版');
}

/* ---- c. 上传素材节点：一直带上最初上传那张（含第二次、第三次生成） ---- */
{
    const U = node('u1', 'image', { prompt: '', uploaded: true, hist: [{ url: '/upload.png' }], hi: 0 });
    // 第一次生成出来的结果节点（来源 = 上传节点）
    const R1 = node('r1', 'image', { prompt: '做成海报', hist: [modelVersion('/gen-1.png', '做成海报', { selfSrc: '/upload.png' })], hi: 0 }, { sourceNodeId: 'u1' });
    const req1 = buildRequest(storeOf({ nodes: [U, R1], edges: [edge('e1', 'u1', 'r1')] }), R1);
    assert.deepStrictEqual(urlsOf(req1), ['/upload.png'], 'c：第一次生成带最初上传的那张');
    // 第二次 / 第三次生成（同一结果节点上追加版本）：仍然回到最初上传那张，不带上一次的生成结果
    for (const round of [2, 3]) {
        const R = node('r1', 'image', { prompt: '做成海报', hist: [modelVersion('/gen-1.png', '做成海报'), modelVersion('/gen-' + (round - 1) + '.png', '做成海报')], hi: round - 1 }, { sourceNodeId: 'u1' });
        const req = buildRequest(storeOf({ nodes: [U, R], edges: [edge('e1', 'u1', 'r1')] }), R);
        assert.deepStrictEqual(urlsOf(req), ['/upload.png'], 'c：第 ' + round + ' 次生成仍只带最初上传那张');
    }
    // 上传节点自己原地重生成（没有结果节点）：也带最初上传那张
    const U2 = node('u2', 'image', { prompt: '做成海报', uploaded: true, hist: [{ url: '/upload2.png' }, modelVersion('/gen-u2.png', '做成海报')], hi: 1 });
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [U2], edges: [] }), U2)), ['/upload2.png'], 'c：上传节点原地重生成带最初上传那张');
    assert.strictEqual(mentions.materialUrlOf({ nodes: [U2], edges: [] }, U2), '/upload2.png', 'c：materialUrlOf 对上传节点 = 最初上传那张');
    // 原地重生成的那一版记了 selfSrc=null（这次没带自我参考）：也不能因此丢掉最初上传的素材
    const U3 = node('u3', 'image', { prompt: '做成海报', uploaded: true, hist: [{ url: '/upload3.png' }, modelVersion('/gen-u3.png', '做成海报', { selfSrc: null })], hi: 1 });
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [U3], edges: [] }), U3)), ['/upload3.png'], 'c：当前版 selfSrc=null 时仍回到最初上传那张');
}

/* ---- d. 结果节点：来源连线不发送，改为沿用源节点输入 ---- */
{
    const A = node('a1', 'image', { prompt: '', uploaded: true, hist: [{ url: '/material.png' }], hi: 0 });
    const S = node('s1', 'image', { prompt: '做成海报', hist: [modelVersion('/src-v1.png')], hi: 0 });
    const R = node('r1', 'image', { prompt: '做成海报', hist: [modelVersion('/gen-v1.png', '做成海报')], hi: 0 }, { sourceNodeId: 's1' });
    const req = buildRequest(storeOf({ nodes: [A, S, R], edges: [edge('e1', 'a1', 's1'), edge('e2', 's1', 'r1')] }), R);
    assert.deepStrictEqual(idsOf(req), ['a1'], 'd：来源连线不发送，改用来源节点自己的输入（R3）');
    assert.deepStrictEqual(urlsOf(req), ['/material.png'], 'd：发出去的是源节点的原始素材');
    assert.strictEqual(req.inputs[0].role, 'reference', 'd：原始素材按 reference 发送');

    // 来源节点本身也是结果节点：沿 sourceNodeId 链继续往上展开（递归 + 去重）
    const R2 = node('r2', 'image', { prompt: '做成海报', hist: [], hi: 0 }, { sourceNodeId: 'r1' });
    const chainDoc = { nodes: [A, S, R, R2], edges: [edge('e1', 'a1', 's1'), edge('e2', 's1', 'r1'), edge('e3', 'r1', 'r2')] };
    assert.deepStrictEqual(idsOf(buildRequest(storeOf(chainDoc), R2)), ['a1'], 'd：sourceNodeId 链递归展开到最初的输入，按节点去重');
    assert.strictEqual(mentions.rootOriginOf(chainDoc, R2).id, 's1', 'd：rootOriginOf 沿链回溯到最初的源节点');
    const cyc = { nodes: [node('x', 'image', {}, { sourceNodeId: 'y' }), node('y', 'image', {}, { sourceNodeId: 'x' })], edges: [] };
    assert.ok(cyc.nodes.includes(mentions.rootOriginOf(cyc, cyc.nodes[0])), 'd：sourceNodeId 有环也不会死循环');
}

/* ---- e. keepSourceInput = true：来源照常发送（出成片 / 重拍 / 延长路径，R4） ---- */
{
    const S = node('s1', 'image', { prompt: '做成海报', hist: [modelVersion('/src-v1.png')], hi: 0 });
    const R = node('r1', 'image', { prompt: '做成海报', hist: [modelVersion('/gen-v1.png', '做成海报')], hi: 0 }, { sourceNodeId: 's1', keepSourceInput: true });
    const req = buildRequest(storeOf({ nodes: [S, R], edges: [edge('e1', 's1', 'r1')] }), R);
    assert.deepStrictEqual(idsOf(req), ['s1'], 'e：keepSourceInput 时来源连线照常发送（R4）');
    assert.deepStrictEqual(urlsOf(req), ['/src-v1.png'], 'e：发出去的就是来源结果');

    // 提示词里显式 @ 了来源节点：也照旧发送（@ 语义优先，不能被来源剔除吃掉）
    const R2 = node('r2', 'image', { prompt: '按 @{s1} 的风格再画一版', hist: [modelVersion('/gen-v2.png', '按 @{s1} 的风格再画一版')], hi: 0 }, { sourceNodeId: 's1' });
    const req2 = buildRequest(storeOf({ nodes: [S, R2], edges: [edge('e1', 's1', 'r2')] }), R2);
    assert.deepStrictEqual(idsOf(req2), ['s1'], 'e：提示词 @ 了来源节点时来源照常发送');
}

/* ---- f. 助手 referenceImages：进 inputs（R5，名字是后端契约） ---- */
{
    const n = node('n1', 'image', { prompt: '在这张基础上改成夜景', hist: [], hi: 0 });
    const doc = { nodes: [n], edges: [] };
    const req = buildRequest(storeOf(doc), n, undefined, { referenceImages: ['/agent-ref.png'] });
    assert.deepStrictEqual(urlsOf(req), ['/agent-ref.png'], 'f：data.agentRun.referenceImages 作为参考图进 inputs');
    assert.strictEqual(req.inputs[0].role, 'reference', 'f：用 reference 角色');
    // 去重：已经作为输入发送的同一张不再加一遍
    const A = node('a1', 'image', { prompt: '', uploaded: true, hist: [{ url: '/agent-ref.png' }], hi: 0 });
    const n2 = node('n2', 'image', { prompt: '改成夜景', hist: [], hi: 0 });
    const doc2 = { nodes: [A, n2], edges: [edge('e1', 'a1', 'n2')] };
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf(doc2), n2, undefined, { referenceImages: ['/agent-ref.png'] })), ['/agent-ref.png'], 'f：同一张不重复发送');
    // 受模型 maxRefs 限制：名额用满就不加
    const NOI2I = { ...IMG, maxRefs: 0 };
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf(doc, NOI2I), n, undefined, { referenceImages: ['/agent-ref.png'] })), [], 'f：模型没有参考名额时不加');

    // autorun 接线：两个契约字段都要读，并传给 runNode
    const autorun = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/autorun.ts'), 'utf8');
    assert.ok(/agentPendingReferenceImages/.test(autorun), 'f：autorun 读 data.agentPendingReferenceImages');
    assert.ok(/agentRun\?\.referenceImages|agentRun\.referenceImages/.test(autorun), 'f：autorun 读 data.agentRun.referenceImages');
    assert.ok(/referenceImages: references\.get\(id\) \|\| \[\]/.test(autorun), 'f：autorun 把参考图传给 runNode');
    const engineSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/engine.ts'), 'utf8');
    assert.ok(/referenceInputs\(flags\?\.referenceImages/.test(engineSrc), 'f：buildRequest 把参考图 push 进 inputs');
}

/* ---- g. 视频：来源被剔除后，依赖视频输入的方式回退到有效输入对应的方式 ---- */
{
    // 结果节点 V 的来源是视频 S（S 没有自己的输入）→ 来源连线不发送，视频输入归零 → 视频编辑退到文生视频
    const S = node('s1', 'video', { prompt: '拍一段猫', hist: [modelVersion('/src-v1.mp4')], hi: 0 });
    const V = node('v1', 'video', { prompt: '改成夜景', params: { model: VID.id, mode: '视频编辑', dur: 5, res: '720p', ratio: '16:9', sound: false, times: 1 }, hist: [modelVersion('/gen-v1.mp4', '改成夜景')], hi: 0 }, { sourceNodeId: 's1' });
    const doc = { nodes: [S, V], edges: [edge('e1', 's1', 'v1')] };
    const req = buildRequest(storeOf(doc, VID), V);
    assert.deepStrictEqual(urlsOf(req), [], 'g：来源视频不作为输入发送（R3）');
    assert.strictEqual(req.params.mode, '文生视频', 'g：视频编辑没有视频输入 → 请求里回退到文生视频');
    assert.strictEqual(req.videoMode.name, '文生视频', 'g：videoMode 跟着回退');
    assert.strictEqual(model.genOf(V).params.mode, '视频编辑', 'g：不回写节点（由 runNode 的 madeResult 决定）');

    // 来源自己有图 → 用剩下的有效输入重选（一张图 → 首帧）
    const A = node('a1', 'image', { prompt: '', uploaded: true, hist: [{ url: '/material.png' }], hi: 0 });
    const S2 = node('s2', 'video', { prompt: '拍一段猫', hist: [modelVersion('/src-v2.mp4')], hi: 0 });
    const V2 = node('v2', 'video', { prompt: '改成夜景', params: { model: VID.id, mode: '视频编辑', dur: 5, res: '720p', ratio: '16:9', sound: false, times: 1 }, hist: [modelVersion('/gen-v2.mp4', '改成夜景')], hi: 0 }, { sourceNodeId: 's2' });
    const doc2 = { nodes: [A, S2, V2], edges: [edge('e1', 'a1', 's2'), edge('e2', 's2', 'v2')] };
    const req2 = buildRequest(storeOf(doc2, VID), V2);
    assert.deepStrictEqual(idsOf(req2), ['a1'], 'g：改用来源节点的图');
    assert.strictEqual(req2.params.mode, '首帧', 'g：用有效输入（一张图）重选成首帧');
    // 用户显式选的方式有对应输入时保持原样
    const V3 = node('v3', 'video', { prompt: '改成夜景', params: { model: VID.id, mode: '视频编辑', dur: 5, res: '720p', ratio: '16:9', sound: false, times: 1 }, hist: [modelVersion('/gen-v3.mp4', '改成夜景')], hi: 0 }, { sourceNodeId: 's2', keepSourceInput: true });
    const req3 = buildRequest(storeOf({ nodes: [S2, V3], edges: [edge('e1', 's2', 'v3')] }, VID), V3);
    assert.strictEqual(req3.params.mode, '视频编辑', 'g：来源照常发送（keepSourceInput）时不动用户选的方式');
    assert.deepStrictEqual(req3.inputs.filter((x) => x.nodeId === 's2').map((x) => x.role), ['source_video'], 'g：来源视频用 source_video 角色');
}

/* ---- j. 老数据兜底（1）：版本没有 meta.prompt，但本地运行历史里最近一次就是同一条提示词 → 不带上一版 ----
   为什么老数据要看 runs：这次改动之前出的版本没有 meta.prompt，「提示词改没改」只能从本地运行历史里找依据；
   没有这个兜底，老画布直接点面板「生成」重跑还会把当前这一版当参考图，用户看到的就是「还是没变」。 */
{
    const oldVersion = { url: '/gen-v1.png', meta: { runId: 'r1' } };   // 老数据：有 runId、没有 prompt
    const n = node('n1', 'image', { prompt: '做成海报', hist: [oldVersion], hi: 0 });
    const runs = [{ node: 'n1', type: 'image', status: 'done', prompt: '做成海报' }];
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [n], edges: [] }, IMG, runs), n)), [], 'j：老数据 + 历史同提示词 → 同一条流水线重抽，不带上一版结果');

    // 历史里存的是显示口径（@{id} 已换成 @标题）：用 plainPrompt 口径比才比得上
    const S = node('s1', 'image', { prompt: '', uploaded: true, hist: [{ url: '/material.png' }], hi: 0 });
    const n2 = node('n2', 'image', { prompt: '把 @{s1} 换成夜景', hist: [{ url: '/gen-v2.png', meta: { runId: 'r2' } }], hi: 0 });
    const runs2 = [{ node: 'n2', type: 'image', status: 'done', prompt: '把 @s1 换成夜景' }];
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [S, n2], edges: [] }, IMG, runs2), n2)), [], 'j：@ 记号按 plainPrompt 口径比较，算同一条提示词');

    // 运行历史只留前 500 字：当前提示词是它的延长版时仍算同一条
    const longPrompt = '做成海报' + '猫'.repeat(400);
    const n3 = node('n3', 'image', { prompt: longPrompt, hist: [{ url: '/gen-v3.png', meta: { runId: 'r3' } }], hi: 0 });
    const runs3 = [{ node: 'n3', type: 'image', status: 'done', prompt: longPrompt.slice(0, 500) }];
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [n3], edges: [] }, IMG, runs3), n3)), [], 'j：历史截断到 500 字时前缀一致也算同一条');

    // 新数据（版本里有 meta.prompt）不看 runs：记录优先
    const n4 = node('n4', 'image', { prompt: '做成海报', hist: [{ url: '/gen-v4.png', meta: { runId: 'r4', prompt: '做成海报' } }], hi: 0 });
    const runs4 = [{ node: 'n4', type: 'image', status: 'done', prompt: '换个完全不同的提示词' }];
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [n4], edges: [] }, IMG, runs4), n4)), [], 'j：有 meta.prompt 时以记录为准，runs 不参与');

    // legacyPromptUnchanged 是纯函数：直接调用也成立（无历史 = false）
    assert.strictEqual(mentions.legacyPromptUnchanged([], { nodes: [n], edges: [] }, n), false, 'j：没有运行历史 → false（维持原回退）');
    assert.strictEqual(mentions.legacyPromptUnchanged(runs, { nodes: [n], edges: [] }, n), true, 'j：纯函数同提示词 → true');
    console.log('[j] 老数据 + runs 同提示词 inputs.urls =', JSON.stringify(urlsOf(buildRequest(storeOf({ nodes: [n], edges: [] }, IMG, runs), n))),
        '| 纯函数 legacyPromptUnchanged =', mentions.legacyPromptUnchanged(runs, { nodes: [n], edges: [] }, n));
}

/* ---- k. 老数据兜底（2）：历史里上次提示词不同 / 没有历史 → 仍带当前这一版（保留迭代手感） ---- */
{
    const n = node('n1', 'image', { prompt: '做成海报', hist: [{ url: '/gen-v1.png', meta: { runId: 'r1' } }], hi: 0 });
    const other = [{ node: 'n1', type: 'image', status: 'done', prompt: '换成赛博朋克' }];
    const reqOther = buildRequest(storeOf({ nodes: [n], edges: [] }, IMG, other), n);
    assert.deepStrictEqual(urlsOf(reqOther), ['/gen-v1.png'], 'k：老数据 + 上次提示词不同 → 判成改过，仍把当前这一版当参考');
    assert.strictEqual(reqOther.selfSrc, '/gen-v1.png', 'k：这条参考照常记进新版本');
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [n], edges: [] }, IMG), n)), ['/gen-v1.png'], 'k：老数据 + 没有运行历史 → 维持原回退');
    // 历史里只有失败 / 停止的记录不算「上次出图用的提示词」
    const failed = [{ node: 'n1', type: 'image', status: 'error', prompt: '做成海报' }];
    assert.deepStrictEqual(urlsOf(buildRequest(storeOf({ nodes: [n], edges: [] }, IMG, failed), n)), ['/gen-v1.png'], 'k：只认 status=done 的记录');
    console.log('[k] 老数据 + runs 上次不同 inputs.urls =', JSON.stringify(urlsOf(buildRequest(storeOf({ nodes: [n], edges: [] }, IMG, other), n))),
        '| 无 runs =', JSON.stringify(urlsOf(buildRequest(storeOf({ nodes: [n], edges: [] }, IMG), n))));
}

/* ---- h. 「再来一张 / 再来一条」fresh：不连来源那条边，复制来源自己的输入 ---- */
{
    const doc = { nodes: [], edges: [] };
    const store = {
        state: { doc, canvasId: 'c1' },
        modelOf: () => IMG,
        node(id) { return this.state.doc.nodes.find((x) => x.id === id); },
        toast() {},
        addNodes(nodes, edges = []) {
            this.state.doc = { ...this.state.doc, nodes: [...this.state.doc.nodes, ...nodes], edges: [...this.state.doc.edges, ...edges] };
            for (const e of edges) this.state.doc = { ...this.state.doc, nodes: this.state.doc.nodes.map((n) => (n.id === e.to ? model.withGen(n, { order: [...model.genOf(n).order, e.id] }) : n)) };
        },
        patchGen(id, patch) {
            const n = this.node(id); if (!n) return;
            const cur = model.genOf(n); const p = typeof patch === 'function' ? patch(cur) : patch;
            this.state.doc = { ...this.state.doc, nodes: this.state.doc.nodes.map((x) => (x.id === id ? model.withGen(x, p) : x)) };
        },
    };
    const U = node('u1', 'image', { prompt: '', uploaded: true, hist: [{ url: '/upload.png' }], hi: 0 });
    const S = node('s1', 'image', { prompt: '做成海报', hist: [modelVersion('/src-v1.png')], hi: 0 });
    const R = node('r1', 'image', { prompt: '做成海报', hist: [modelVersion('/gen-v1.png', '做成海报')], hi: 0 }, { sourceNodeId: 's1' });
    store.state.doc = { nodes: [U, S, R], edges: [edge('e1', 'u1', 's1'), edge('e2', 's1', 'r1')] };
    const made = regenAsNew(store, store.node('r1'), undefined, { linkSelf: false, fresh: true });
    const incoming = store.state.doc.edges.filter((e) => e.to === made.id).map((e) => e.from);
    assert.deepStrictEqual(incoming, ['u1'], 'h：再来一张不连结果节点，改连来源节点自己的输入（R3）');
    assert.strictEqual((made.data || {}).keepSourceInput, undefined, 'h：fresh 不写 keepSourceInput（来源不是真实输入）');
    const req = requestForNode(store, store.node(made.id));
    assert.deepStrictEqual(urlsOf(req), ['/upload.png'], 'h：新节点只带原始素材，不带上一版结果');
    // 新节点的参考来自复制过来的那条素材连线（不是自己带）；sourceNodeId 沿结果节点 → 来源追到源头仍是模型生成的图 → 没有自我参考
    assert.strictEqual(mentions.autoSelfUrl(store, store.node(made.id)), null, 'h：新节点不把上一版结果当自我参考');

    // linkSelf 分支（出成片 / 时间线重拍）：保留来源连线，并写 keepSourceInput 让请求照发来源
    const store2 = { ...store, state: { doc: { nodes: [U, S, R], edges: [edge('e1', 'u1', 's1'), edge('e2', 's1', 'r1')] }, canvasId: 'c1' } };
    const made2 = regenAsNew(store2, store2.node('r1'), undefined, {});
    const incoming2 = store2.state.doc.edges.filter((e) => e.to === made2.id).map((e) => e.from).sort();
    assert.deepStrictEqual(incoming2, ['r1', 's1'], 'h：linkSelf 照旧复制原输入 + 把自己连成来源');
    assert.strictEqual((made2.data || {}).keepSourceInput, true, 'h：linkSelf=true 写 data.keepSourceInput（R4）');

    // 从「出成片 / 重拍」节点再来一张：它标了 keepSourceInput，来源是真实输入，不能当成「只表示来源」撇掉
    const keepDoc = { nodes: [U, S, R], edges: [edge('e1', 'u1', 's1'), edge('e2', 's1', 'r1')] };
    const K = node('k1', 'image', { prompt: '做成海报', hist: [modelVersion('/final.png', '做成海报')], hi: 0 }, { sourceNodeId: 's1', keepSourceInput: true });
    keepDoc.nodes = [...keepDoc.nodes, K]; keepDoc.edges = [...keepDoc.edges, edge('e3', 's1', 'k1')];
    assert.deepStrictEqual(mentions.sourceInputsOf(keepDoc, 'k1').map((x) => x.node.id), ['s1'], 'h：keepSourceInput 节点的来源不被展开掉');
    store.state.doc = keepDoc;
    const madeK = regenAsNew(store, store.node('k1'), undefined, { linkSelf: false, fresh: true });
    assert.deepStrictEqual(store.state.doc.edges.filter((e) => e.to === madeK.id).map((e) => e.from), ['s1'], 'h：从 keepSourceInput 节点再来一张仍连它的来源（真实输入）');
}

/* ---- i. 版本记录：gen 版本上写 meta.prompt / meta.selfSrc（引擎接线） ---- */
{
    const engineSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/engine.ts'), 'utf8');
    assert.ok(/prompt: req\.prompt/.test(engineSrc), 'i：首次生成写回时把这次请求的提示词记进新版本');
    assert.ok(/prompt: genOf\(cur\)\.prompt/.test(engineSrc), 'i：续跑写回用节点当前提示词');
    assert.ok(/meta: \{ \.\.\.o\.meta,/.test(engineSrc), 'i：meta 合并写入，不覆盖已有的 model / runId');
}

console.log('test_novai_canvas_regen_fresh: ok（R1~R5 + a~k 全部通过）');
