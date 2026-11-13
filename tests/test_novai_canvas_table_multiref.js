#!/usr/bin/env node
'use strict';
/*
 * 多维表格 + 批量生成：多参考图场景回归（场景 3 / 人物三视图 3 / 模特姿势 1 / 产品多角度 4）。
 * 覆盖：
 *   [1] 规划遍成功：行数 = 逐行组张数（3），输入1逐行、输入2-4全部；每行 9 张素材，不丢不重。
 *   [2] 规划遍失败 + 行文本带「输入 N 整组 / 第 k 张」：确定性推断通道模式，行数仍 = 3（产品不被拆行）。
 *   [3] 规划遍失败且行文本没有任何输入组证据：保持原有「沿用」默认，不按组名瞎猜（tests/test_novai_canvas_table_media.js:297 的既有约定）。
 *   [4] 嵌套分组：组里套组展开到最内层图片，堆叠顺序 / 位置排序规则不变；groupImages 同样递归。
 *   [5] 「输入 N」编号：重新出表把表格 data.gen.order 固定成 sources 边顺序；行文本引用越界 / 多出来的旧通道要常驻告警。
 *   [6] 超模型参考图上限：警告点名被截的通道（如「产品多角度」4 张只发送 2 张），行素材带通道身份。
 *   [7] 请求追加「参考图顺序」清单（图1=输入1 场景第1张；图2-4=输入2 人物三视图整组…）；
 *       普通图片节点也追加（放在提示词最前面），纯文生图不追加。
 *   [8] 后端 caps 的 ref_max 作为参考图上限权威值（不再按模型名猜成 4 张），缺字段才回落预设。
 *   [9] UI 接线：表格节点 / 批量面板常驻显示告警。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry, opts = {}) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent', ...opts,
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputText ? result.outputText : result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const table = load('novai-canvas-ui/src/canvas/canvas-next/table.ts');
const engine = load('novai-canvas-ui/src/canvas/canvas-next/engine.ts');
const caps = load('novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

/* ---------- 构造 ---------- */
const media = (id, url, pos = {}) => ({
    id, kind: 'image', x: pos.x || 0, y: pos.y || 0, w: 200, h: 200, text: '',
    data: { gen: { title: id, prompt: '', params: {}, order: [], hi: 0, hist: [{ url }] } },
});
const group = (id, children, text = '分组', extra = {}) => ({ id, kind: 'group', x: 0, y: (extra.y || 0), w: 300, h: 300, text, children, ...(extra.data ? { data: extra.data } : {}) });
const stack = (id, children, y = 0) => group(id, children, '堆叠', { y, data: { stack: true } });
const textNode = (id, title, extra = {}) => ({ id, kind: 'text', x: 0, y: 0, w: 280, h: 200, text: '', data: { gen: { title, prompt: extra.prompt || '', params: { output: extra.output || 'table', model: 'm-text' }, hist: [{ text: '正文' }], hi: 0, order: [] } } });
const tableNode = (id, t, order = []) => ({ id, kind: 'table', x: 0, y: 0, w: 400, h: 300, text: t.title, data: { table: t, gen: { title: t.title, prompt: '', params: {}, hist: [], hi: 0, order } } });
const genNode = (id, kind = 'image') => ({ id, kind, x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: id, prompt: '', params: {}, hist: [], hi: 0, order: [] } } });
const edge = (id, from, to) => ({ id, from, to });
const plain = (title, columns, rows, extra = {}) => ({ kind: 'table', version: 1, title, columns, rows, ...extra });

const textSpec = { id: 'm-text', name: '文本模型', vendor: '', tags: [], kind: 'text', secs: 6, vision: true };
const imageSpec = { id: 'm-img', name: '图片模型', vendor: '', tags: [], kind: 'image', secs: 10, i2i: true, maxRefs: 14 };

/** 老板场景：4 个分组（场景 3 / 人物三视图 3 / 模特姿势 1 / 产品多角度 4），文本节点输出多维表格 */
function multiRefDoc() {
    const scene = Array.from({ length: 3 }, (_, i) => media('sc' + i, '/assets/input/sc' + i + '.jpg', { y: i * 100 }));
    const person = Array.from({ length: 3 }, (_, i) => media('pe' + i, '/assets/input/pe' + i + '.jpg', { y: i * 100 }));
    const pose = [media('po0', '/assets/input/po0.jpg')];
    const product = Array.from({ length: 4 }, (_, i) => media('pr' + i, '/assets/input/pr' + i + '.jpg', { y: i * 100 }));
    return {
        nodes: [
            ...scene, ...person, ...pose, ...product,
            group('gScene', scene.map((n) => n.id), '场景参考'),
            group('gPerson', person.map((n) => n.id), '人物三视图'),
            group('gPose', pose.map((n) => n.id), '模特姿势'),
            group('gProduct', product.map((n) => n.id), '产品多角度'),
            textNode('t1', '多参考图批量', { prompt: '每行一个场景，人物三视图、模特姿势、产品多角度每行都作为参考', output: 'table' }),
        ],
        edges: [edge('p1', 'gScene', 't1'), edge('p2', 'gPerson', 't1'), edge('p3', 'gPose', 't1'), edge('p4', 'gProduct', 't1')],
    };
}
const ROW_REF = (i) => '输入1第' + i + '张场景；输入2整组人物三视图；输入3整组模特姿势；输入4整组产品多角度';
const planSuccess = JSON.stringify({
    rowCount: 3,
    inputGroups: [
        { group: 1, rowMode: 'per-row', role: '场景' },
        { group: 2, rowMode: 'every-row', role: '人物三视图' },
        { group: 3, rowMode: 'every-row', role: '模特姿势' },
        { group: 4, rowMode: 'every-row', role: '产品多角度' },
    ],
});
const table3 = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [[ROW_REF(1)], [ROW_REF(2)], [ROW_REF(3)]] });
const table4 = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [[ROW_REF(1)], [ROW_REF(2)], [ROW_REF(3)], [ROW_REF(3)]] });
const table4Plain = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['一'], ['二'], ['三'], ['四']] });

class FakeStore {
    constructor(doc, spec) { this.state = { doc, canvasId: 'c1', runtime: {} }; this.spec = spec; this.toasts = []; }
    node(id) { return this.state.doc.nodes.find((n) => n.id === id); }
    modelOf() { return this.spec; }
    setRun() { } patchRun() { }
    toast(s) { this.toasts.push(s); }
    logRun() { }
    snapshot() { }
    patchGen(id, patch) { this.updateNode(id, (n) => { const gen = { ...((n.data || {}).gen || {}) }; Object.assign(gen, typeof patch === 'function' ? patch(gen) : patch); return { ...n, data: { ...(n.data || {}), gen } }; }); }
    updateNode(id, fn) { this.state = { ...this.state, doc: { ...this.state.doc, nodes: this.state.doc.nodes.map((n) => (n.id === id ? fn(n) : n)) } }; }
    addNodes(nodes, edges = []) { this.state = { ...this.state, doc: { ...this.state.doc, nodes: [...this.state.doc.nodes, ...nodes], edges: [...this.state.doc.edges, ...edges] } }; }
    backendFor(...replies) {
        const queue = replies.length ? [...replies] : [''];
        const prompts = [];
        return {
            prompts,
            generate: async (req) => {
                prompts.push(String((req && req.resolvedPrompt) || ''));
                const text = queue.length > 1 ? queue.shift() : queue[0];
                return { outputs: [{ text }] };
            },
        };
    }
}
const runToTable = async (docIn, replies, spec = textSpec) => {
    const store = new FakeStore({ ...docIn, comments: [] }, spec);
    store.backend = store.backendFor(...replies);
    ok(await engine.runTextToTable(store, 't1'), '出表成功');
    return store;
};
const withDownstream = (doc, tableId, kind = 'image') => ({
    ...doc,
    nodes: [...doc.nodes, genNode('gx', kind)],
    edges: [...doc.edges, edge('t2g', tableId, 'gx')],
});

(async () => {
    /* ---------- [1] 规划遍成功：行数 = 逐行组张数，模式 逐行 / 全部 ---------- */
    console.log('[1] 规划遍成功：4 组多参考图');
    const store1 = await runToTable(multiRefDoc(), [planSuccess, table3]);
    eq(store1.backend.prompts.length, 2, '规划 + 生成两次请求');
    const tbl1 = store1.state.doc.nodes.find((n) => n.kind === 'table');
    ok(tbl1, '出表后有表格节点');
    const t1 = table.tableOf(tbl1);
    eq(t1.rows.length, 3, '行数 = 场景组张数 3（不再被产品多角度组的 4 张拉成 4 行）');
    eq(t1.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '输入1逐行、输入2-4全部');
    const ch1 = table.tableChannels(store1.state.doc, tbl1.id);
    eq(ch1.map((c) => c.title), ['场景参考', '人物三视图', '模特姿势', '产品多角度'], '通道顺序 = 提示词组号（场景→人物→姿势→产品）');
    eq(ch1.map((c) => c.items.length), [3, 3, 1, 4], '每组张数');
    // 提示词不再自相矛盾：不能写死「必须正好 N 行（N = 素材最多那组）」
    ok(!store1.backend.prompts[1].includes('必须正好'), '出表提示词不再写死「必须正好 N 行」');
    ok(!store1.backend.prompts[1].includes('行数应等于素材最多那组的张数'), '出表提示词不再要求行数 = 素材最多那组');
    ok(store1.backend.prompts[1].includes('输入 N') || store1.backend.prompts[1].includes('输入1'), '出表提示词要求每行写清「输入 N + 整组 / 第 k 张」');
    ok(store1.backend.prompts[1].includes('不增加行数'), '出表提示词写明整组参考不增加行数');
    ok(store1.backend.prompts[1].includes('「场景参考」3 张（输入 1）') && store1.backend.prompts[1].includes('「产品多角度」4 张（输入 4）'), '出表提示词里每组都标了真实的输入通道编号');
    const doc1 = withDownstream(store1.state.doc, tbl1.id);
    const rows1 = table.batchRows(doc1, 'gx');
    eq(rows1.length, 3, '批量 3 行');
    eq(rows1.map((r) => r.media.length), [9, 9, 9], '每行 media = 场景1 + 人物3 + 姿势1 + 产品4 = 9 张');
    eq(rows1[0].media.map((m) => m.url.replace('/assets/input/', '')), ['sc0.jpg', 'pe0.jpg', 'pe1.jpg', 'pe2.jpg', 'po0.jpg', 'pr0.jpg', 'pr1.jpg', 'pr2.jpg', 'pr3.jpg'], '第 1 行素材按通道顺序，无缺失');
    eq(rows1[1].media.map((m) => m.url.replace('/assets/input/', '')), ['sc1.jpg', 'pe0.jpg', 'pe1.jpg', 'pe2.jpg', 'po0.jpg', 'pr0.jpg', 'pr1.jpg', 'pr2.jpg', 'pr3.jpg'], '第 2 行换场景、其余整组');
    eq(new Set(rows1[0].media.map((m) => m.url)).size, 9, '行素材没有重复');
    eq(rows1[0].media[1].channel, '人物三视图', '行素材带通道身份（截断告警 / 参考图清单要用）');
    eq(rows1[0].media[1].channelId, 'input-2', '通道编号 = input-2');
    eq(table.tableInputWarnings(store1.state.doc, tbl1.id), [], '编号与通道一一对应时没有告警');

    /* ---------- [2] 规划遍失败：从行文本推断模式，行数仍按逐行组 ---------- */
    console.log('[2] 规划遍失败 → 行文本证据兜底');
    const store2 = await runToTable(multiRefDoc(), ['抱歉，我无法给出规划', '仍然不行', table4]);
    eq(store2.backend.prompts.length, 3, '规划失败会重试一次，再走单遍出表');
    ok(store2.backend.prompts[1].includes('JSON'), '规划重试只要 JSON（rowCount + inputGroups）');
    const tbl2 = store2.state.doc.nodes.find((n) => n.kind === 'table');
    const t2 = table.tableOf(tbl2);
    eq(t2.rows.length, 3, '模型给了 4 行 → 按推断出的逐行组裁到 3 行（产品不再被拆行）');
    eq(t2.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '从行文本「输入 N 整组 / 第 k 张」推断出模式');
    const rows2 = table.batchRows(withDownstream(store2.state.doc, tbl2.id), 'gx');
    eq(rows2.map((r) => r.media.length), [9, 9, 9], '每行仍带整组人物 / 姿势 / 产品');
    eq(rows2[2].media.map((m) => m.url.replace('/assets/input/', '')).slice(0, 1), ['sc2.jpg'], '第 3 行取场景第 3 张');

    /* ---------- [3] 没有证据时保持既有默认（沿用），不按组名乱猜 ---------- */
    console.log('[3] 没有输入组证据 → 沿用默认不变');
    const store3 = await runToTable(multiRefDoc(), ['没有规划', '没有规划', table4Plain]);
    const tbl3 = store3.state.doc.nodes.find((n) => n.kind === 'table');
    const t3 = table.tableOf(tbl3);
    eq(t3.rows.length, 4, '没有证据 → 不补不裁（保持模型行数）');
    eq(t3.inputModes, undefined, '没有证据 → 不写 inputModes');
    eq(table.tableChannels(store3.state.doc, tbl3.id).map((c) => c.mode), ['shared', 'shared', 'shared', 'shared'], '没有证据 → 全部沿用（既有约定）');
    eq(table.inferChannelModesFromRows(t3, table.tableChannels(store3.state.doc, tbl3.id)), {}, '推断函数：没有输入组引用 → 空');
    // 直接验证推断规则
    const inferDoc = multiRefDoc();
    const inferTable = table.tableChannels({ nodes: [...inferDoc.nodes, tableNode('tbI', plain('多维表格', ['画面'], [[ROW_REF(1)]]))], edges: [...inferDoc.edges, edge('i1', 'gScene', 'tbI'), edge('i2', 'gPerson', 'tbI'), edge('i3', 'gPose', 'tbI'), edge('i4', 'gProduct', 'tbI')] }, 'tbI');
    eq(table.inferChannelModesFromRows(plain('多维表格', ['画面'], [[ROW_REF(1)]]), inferTable), { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '推断函数：整组 → all、第 k 张 → sequence');

    /* ---------- [4] 嵌套分组：展开到最内层图片 ---------- */
    console.log('[4] 嵌套分组');
    const np0 = media('np0', '/assets/input/np0.jpg', { y: 0 });
    const np1 = media('np1', '/assets/input/np1.jpg', { y: 100 });
    const np2 = media('np2', '/assets/input/np2.jpg', { y: 300 });
    const np3 = media('np3', '/assets/input/np3.jpg', { y: 400 });
    const gInner = stack('gInner', ['np0', 'np1'], 0);
    const gNest = group('gNest', ['gInner', 'np2', 'np3'], '产品多角度');
    const nestedDoc = {
        nodes: [np0, np1, np2, np3, gInner, gNest, tableNode('tbN', plain('多维表格', ['画面'], [['一']], { inputModes: { 'input-1': 'all' } }))],
        edges: [edge('n1', 'gNest', 'tbN')],
    };
    eq(table.groupImages(nestedDoc, gNest).map((x) => x.nodeId), ['np0', 'np1', 'np2', 'np3'], 'groupImages 递归展开：堆叠内顺序 + 分组按位置排序');
    const nestedCh = table.tableChannels(nestedDoc, 'tbN');
    eq(nestedCh[0].items.map((x) => x.nodeId), ['np0', 'np1', 'np2', 'np3'], '通道里的嵌套分组图不再被丢掉');
    eq(table.batchRows(withDownstream(nestedDoc, 'tbN'), 'gx')[0].media.map((m) => m.url), ['/assets/input/np0.jpg', '/assets/input/np1.jpg', '/assets/input/np2.jpg', '/assets/input/np3.jpg'], '批量行拿到内层分组的全部产品图');

    /* ---------- [5] 输入编号 / 常驻告警 ---------- */
    console.log('[5] 「输入 N」编号与告警');
    // 行文本引用了不存在的输入 3
    const wImg = media('wImg', '/assets/input/w.jpg');
    const wTable = tableNode('tbW', plain('多维表格', ['画面'], [['保留输入1第1张'], ['以输入3整组作为参考']]));
    const wDoc = { nodes: [wImg, wTable], edges: [edge('w1', 'wImg', 'tbW')] };
    const wWarns = table.tableInputWarnings(wDoc, 'tbW');
    ok(wWarns.some((w) => w.includes('输入 3') && w.includes('只有 1 条')), '行文本引用越界输入 → 常驻告警点名「输入 3」');
    // 多出来的旧通道（用户手连）不删边，但要在告警里说清
    const wsImg = media('wsImg', '/assets/input/ws.jpg');
    const wxImg = media('wxImg', '/assets/input/wx.jpg');
    const wText = textNode('tW', '多参考图批量', { prompt: '每行一个场景', output: 'table' });
    const wTable2 = tableNode('tbW2', plain('多维表格', ['画面'], [['一']], { sourceId: 'tW' }));
    const wDoc2 = {
        nodes: [wsImg, wxImg, wText, group('gWs', ['wsImg'], '场景参考'), group('gWx', ['wxImg'], '产品多角度'), wTable2],
        edges: [edge('x1', 'gWs', 'tW'), edge('x2', 'gWs', 'tbW2'), edge('x3', 'gWx', 'tbW2')],
    };
    const wWarns2 = table.tableInputWarnings(wDoc2, 'tbW2');
    ok(wWarns2.some((w) => w.includes('不在这次提示词组里') && w.includes('输入 2') && w.includes('产品多角度')), '手连的额外通道保留并告警（不静默删边）');
    // 重新出表：表格 gen.order 固定成 sources 边顺序（即使表格原来的入边是反的）
    const revDoc = multiRefDoc();
    const revTable = tableNode('tbRev', plain('多维表格', ['画面'], [['一']], { sourceId: 't1' }), ['r4', 'r3', 'r2', 'r1']);
    revDoc.nodes.push(revTable);
    revDoc.edges.push(
        edge('r0', 't1', 'tbRev'), edge('r4', 'gProduct', 'tbRev'), edge('r3', 'gPose', 'tbRev'), edge('r2', 'gPerson', 'tbRev'), edge('r1', 'gScene', 'tbRev'),
    );
    eq(table.tableChannels(revDoc, 'tbRev').map((c) => c.sourceId), ['gProduct', 'gPose', 'gPerson', 'gScene'], '重出前：通道顺序跟着表格旧入边（乱序）');
    const storeRev = await runToTable(revDoc, [planSuccess, table3]);
    const tblRev = storeRev.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableChannels(storeRev.state.doc, tblRev.id).map((c) => c.sourceId), ['gScene', 'gPerson', 'gPose', 'gProduct'], '重出后：通道编号 = 提示词组号');
    const revOrder = storeRev.state.doc.nodes.find((n) => n.id === tblRev.id).data.gen.order;
    eq(revOrder, ['r0', 'r1', 'r2', 'r3', 'r4'], '表格 gen.order = 文本节点 + sources 的边顺序（通道编号稳定）');
    eq(table.tableOf(tblRev).inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '重出后模式写在正确通道上');
    // 用户手点过的通道模式不被下次出表冲掉
    const userDoc = JSON.parse(JSON.stringify(storeRev.state.doc));
    const userTbl = userDoc.nodes.find((n) => n.kind === 'table');
    userTbl.data.table.inputModes = { ...userTbl.data.table.inputModes, 'input-1': 'shared' };
    userTbl.data.table.inputModesAuto = (userTbl.data.table.inputModesAuto || []).filter((id) => id !== 'input-1');
    const storeUser = await runToTable(userDoc, [planSuccess, table3]);
    const userTblOut = storeUser.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(userTblOut).inputModes['input-1'], 'shared', '用户手设的通道模式优先，不被出表覆盖');
    ok((table.tableOf(userTblOut).inputModesAuto || []).includes('input-2'), '系统写的通道仍在自动列表里');

    /* ---------- [6] 超模型上限：点名被截的通道 ---------- */
    console.log('[6] 参考图上限截断点名');
    const truncDoc = multiRefDoc();
    // 第 1 行现实数据：场景第 1 张（逐行）+ 人物三视图 3 + 姿势 1 + 产品多角度 4 = 9 张
    const truncTable = tableNode('tbT', plain('多维表格', ['画面'], [['一']], { inputModes: { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' } }));
    truncDoc.nodes.push(truncTable);
    truncDoc.edges.push(edge('q1', 'gScene', 'tbT'), edge('q2', 'gPerson', 'tbT'), edge('q3', 'gPose', 'tbT'), edge('q4', 'gProduct', 'tbT'));
    const truncRows = table.batchRows(withDownstream(truncDoc, 'tbT'), 'gx');
    eq(truncRows[0].media.length, 9, '这一行共 9 张素材');
    eq(truncRows[0].media.map((m) => m.channel), ['场景参考', '人物三视图', '人物三视图', '人物三视图', '模特姿势', '产品多角度', '产品多角度', '产品多角度', '产品多角度'], '素材带通道名');
    const truncated = table.planRow('image', { model: 'm-img' }, { id: 'm-img', name: '图片模型', vendor: '', tags: [], kind: 'image', secs: 10, i2i: true, maxRefs: 7 }, truncRows[0]);
    ok(truncated.warnings.some((w) => w.includes('参考图超过模型上限 7 张') && w.includes('「产品多角度」4 张只发送 2 张')), '截断警告点名「产品多角度 4 张只发送 2 张」');
    ok(truncated.inputs.filter((x) => x.role === 'reference').length === 7, '实际只发送 7 张');
    const noRef = table.planRow('image', { model: 'm-img' }, { id: 'm-img', name: '图片模型', vendor: '', tags: [], kind: 'image', secs: 10, i2i: false, maxRefs: 0 }, truncRows[0]);
    ok(noRef.warnings.some((w) => w.includes('不支持参考图') && w.includes('产品多角度')), '不支持参考图时也点名被丢弃的通道');

    /* ---------- [7] 请求里的参考图顺序清单 ---------- */
    console.log('[7] 参考图顺序清单');
    const orderDoc = withDownstream(store1.state.doc, tbl1.id);
    const orderStore = new FakeStore(orderDoc, imageSpec);
    const orderRows = table.batchRows(orderDoc, 'gx');
    const req = engine.buildRequest(orderStore, orderStore.node('gx'), orderRows[0]);
    ok(req, '能组装请求');
    ok(req.resolvedPrompt.includes('参考图顺序'), '请求提示词追加参考图顺序清单');
    ok(req.resolvedPrompt.includes('图1=输入1「场景参考」第1张'), '图1 = 输入1 场景第1张');
    ok(req.resolvedPrompt.includes('图2-4=输入2「人物三视图」整组'), '图2-4 = 输入2 人物三视图整组');
    ok(req.resolvedPrompt.includes('图5=输入3「模特姿势」第1张'), '图5 = 输入3 模特姿势');
    ok(req.resolvedPrompt.includes('图6-9=输入4「产品多角度」整组'), '图6-9 = 输入4 产品多角度整组');
    // 普通（非表格）图片节点也要追加：后端按图片输入顺序发 reference_images，提示词里的「图 N」不说明是哪张
    const plainStore = new FakeStore({ nodes: [media('p1x', '/assets/p.jpg'), genNode('g2')], edges: [edge('e2', 'p1x', 'g2')] }, imageSpec);
    const plainReq = engine.buildRequest(plainStore, { id: 'g2', kind: 'image', x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: 'g2', prompt: '画一张图', params: {}, hist: [], hi: 0, order: [] } } });
    ok(plainReq && plainReq.resolvedPrompt.startsWith('参考图顺序'), '普通图片节点也追加参考图清单（在提示词最前面）');
    ok(plainReq.resolvedPrompt.includes('图1=「p1x」'), '普通节点清单：图1 = 实际发送的第 1 张图');
    // 纯文生图（没有图片输入）不追加，避免噪声
    const t2iStore = new FakeStore({ nodes: [genNode('g3')], edges: [] }, imageSpec);
    const t2iReq = engine.buildRequest(t2iStore, { id: 'g3', kind: 'image', x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: 'g3', prompt: '画一张图', params: {}, hist: [], hi: 0, order: [] } } });
    ok(t2iReq && !t2iReq.resolvedPrompt.includes('参考图顺序'), '纯文生图不追加参考图清单');

    /* ---------- [8] caps ref_max 权威值 ---------- */
    console.log('[8] caps ref_max');
    const refUi = caps.modelCapsUi('image', { provider: 'apimart', model: 'seedream-5-0', kind: 'image', ratios: ['1:1'], ref_max: 14 });
    eq(refUi.maxRefs, 14, 'caps { ref_max: 14 } → spec.maxRefs === 14');
    const refSpec = model.specFor({ configId: 'apimart::seedream-5-0', label: 'seedream-5-0', vendor: 'APIMART', kind: 'image', ui: refUi, specSource: 'spec' });
    eq(refSpec.maxRefs, 14, 'specFor 用 caps 的 14，不被按名字猜的 4 张盖掉');
    eq(caps.modelCapsUi('image', { kind: 'image', ratios: ['1:1'], ref_max: 0 }).maxRefs, 0, 'caps 明确给 0 → 保留 0（不支持参考图）');
    eq(caps.modelCapsUi('image', { kind: 'image', ratios: ['1:1'], max_refs: 6 }).maxRefs, 6, '旧字段 max_refs 仍兼容');
    const noRefUi = caps.modelCapsUi('image', { kind: 'image', ratios: ['1:1'], n_max: 1 });
    eq('maxRefs' in noRefUi, false, 'caps 没有 ref_max → 不编 maxRefs');
    const fallbackSpec = model.specFor({ configId: 'x::flux', label: 'flux', vendor: '', kind: 'image', ui: caps.mergeCapsReferenceCapability('image', noRefUi, { maxRefs: 4, i2i: true }), specSource: 'spec' });
    eq(fallbackSpec.maxRefs, 4, '缺 ref_max 时仍按原有官方 / 名字预设回落');
    eq(caps.mergeCapsReferenceCapability('image', refUi, { maxRefs: 20, i2i: true }).maxRefs, 14, 'caps 值优先于名字预设（officialImageUi 不会盖掉）');
    // 视频：前端 maxRefs 统计的是图片参考（rolesFor / planRow 的 refs 都是 image），后端 ref_max 才是图片上限；
    // video_ref_max 是视频参考上限，只在没有 ref_max 时兜底（证据 main.py APIMART_VIDEO_MODEL_CAPS.seedance-2-5）
    eq(caps.modelCapsUi('video', { kind: 'video', ratios: ['16:9'], ref_max: 30, video_ref_max: 10 }).maxRefs, 30, '视频 caps 的 ref_max（图片参考）优先');
    eq(caps.modelCapsUi('video', { kind: 'video', ratios: ['16:9'], video_ref_max: 10 }).maxRefs, 10, '视频只给 video_ref_max 时兜底');
    eq(caps.modelCapsUi('audio', { audio_ref_max: 7 }).maxRefs, 7, '音频 audio_ref_max 也接线到 maxRefs');
    const backendSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBackend.ts'), 'utf8');
    ok(backendSrc.includes('modelCapsUi("audio"'), 'listModels 里音频也调用 modelCapsUi（audio_ref_max 不再丢）');
    ok(backendSrc.includes('mergeCapsReferenceCapability(kind, capsUi'), '后端接线：caps 参考图能力优先合并');
    ok(backendSrc.indexOf('modelCapsUi(kind, capsItem)') >= 0 && backendSrc.indexOf('modelCapsUi(kind, capsItem)') < backendSrc.indexOf('mergeCapsReferenceCapability(kind, capsUi'), 'order：先 modelCapsUi，再用官方/预设补缺，不能反过来盖掉 caps');
    const mainSrc = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
    ok(mainSrc.includes('ref_max=table.get("ref_max")') && mainSrc.includes('video_ref_max=table.get("video_ref_max")'), '后端 _caps_payload 确实下发 ref_max / video_ref_max');

    /* ---------- [9] UI 接线：告警常驻可见 ---------- */
    console.log('[9] UI 接线');
    const tableNodeSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx'), 'utf8');
    ok(tableNodeSrc.includes('tableInputWarnings('), '表格节点显示输入编号告警');
    ok(tableNodeSrc.includes('trefwarn'), '表格节点有常驻告警条');
    const genPanelSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
    ok(genPanelSrc.includes('batchInputWarnings('), '批量面板显示上游表格的输入编号告警');
    ok(genPanelSrc.includes('ref-limit') || genPanelSrc.includes('参考图超过'), '批量面板留下超上限截断说明');
    const cssSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
    ok(cssSrc.includes('.trefwarn'), '告警条有样式');

    /* ---------- [10] 推断正则对抗（验证岗用例） ---------- */
    console.log('[10] 推断正则：并列组 / 词序 / 数字边界');
    const chans = (n) => Array.from({ length: n }, (_, i) => ({ id: 'input-' + (i + 1), sourceId: 's' + i, title: '组' + (i + 1), mode: 'shared', items: [] }));
    const inf = (rows, n) => table.inferChannelModesFromRows({ kind: 'table', version: 1, title: '表', columns: ['画面'], rows: rows.map((r) => [r]) }, chans(n));
    eq(inf(['输入 1、输入 2 整组'], 2), { 'input-1': 'all', 'input-2': 'all' }, '并列「输入 1、输入 2 整组」→ 两条都 all');
    eq(inf(['输入 1 和 输入 2 整组'], 2), { 'input-1': 'all', 'input-2': 'all' }, '并列「输入 1 和 输入 2 整组」→ 两条都 all');
    eq(inf(['输入 1、输入 2、输入 3 全部'], 3), { 'input-1': 'all', 'input-2': 'all', 'input-3': 'all' }, '三段并列共享「全部」');
    eq(inf(['输入 1 的 5 张图全部用上'], 2), { 'input-1': 'all' }, '「输入 1 的 5 张图全部用上」→ all');
    eq(inf(['输入 1 第 2 张'], 2), { 'input-1': 'sequence' }, '「输入 1 第 2 张」→ sequence');
    eq(inf(['第 2 张来自输入 10'], 10), { 'input-10': 'sequence' }, '「第 2 张来自输入 10」只命中 input-10（不串 input-1）');
    eq(inf(['输入 10 整组'], 3), {}, '3 通道时「输入 10 整组」不许把第 1 条当命中');
    eq(inf(['输入 3 第 1 张'], 2), {}, '引用越界不改任何通道');
    eq(inf(['输入 1 整组；输入 2 第 2 张'], 2), { 'input-1': 'all', 'input-2': 'sequence' }, '同一段里两组各判各的');

    /* ---------- [11] 旧文档 inputModes 迁移 ---------- */
    console.log('[11] 旧文档（无 inputModesAuto）模式迁移');
    {
      const world = multiRefDoc();
      const legacy = tableNode('tbLegacy', plain('多维表格', ['画面'], [['旧行']], { sourceId: 't1', inputModes: { 'input-1': 'all' } }));
      world.nodes.push(legacy);
      world.edges.push(edge('L0', 't1', 'tbLegacy'), edge('L1', 'gScene', 'tbLegacy'), edge('L2', 'gPerson', 'tbLegacy'), edge('L3', 'gPose', 'tbLegacy'), edge('L4', 'gProduct', 'tbLegacy'));
      const storeL = await runToTable(world, [planSuccess, table3]);
      const tbL = storeL.state.doc.nodes.find((n) => n.id === 'tbLegacy');
      const tL = table.tableOf(tbL);
      eq(tL.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '旧文档模式按本次规划覆盖（Boss 老画布也能生效）');
      eq(tL.rows.length, 3, '旧文档行数也按逐行组裁到 3');
      ok((tL.inputModesAuto || []).includes('input-1') && (tL.inputModesAuto || []).includes('input-4'), '迁移后补写 inputModesAuto');
      eq(table.tableChannels(storeL.state.doc, tbL.id).map((c) => c.mode), ['sequence', 'all', 'all', 'all'], '迁移后通道真正生效');
    }

    // 新格式（inputModesAuto 存在，哪怕空数组）→ 列表外的模式算用户手设，照样保护
    {
      const world = multiRefDoc();
      const newFmt = tableNode('tbNewFmt', plain('多维表格', ['画面'], [['旧']], { sourceId: 't1', inputModes: { 'input-1': 'shared' }, inputModesAuto: [] }), ['N0', 'N1', 'N2', 'N3', 'N4']);
      world.nodes.push(newFmt);
      world.edges.push(edge('N0', 't1', 'tbNewFmt'), edge('N1', 'gScene', 'tbNewFmt'), edge('N2', 'gPerson', 'tbNewFmt'), edge('N3', 'gPose', 'tbNewFmt'), edge('N4', 'gProduct', 'tbNewFmt'));
      const storeN = await runToTable(world, [planSuccess, table3]);
      const tN = table.tableOf(storeN.state.doc.nodes.find((n) => n.id === 'tbNewFmt'));
      eq(tN.inputModes['input-1'], 'shared', 'inputModesAuto 存在（空数组）时，input-1 手设 shared 不被覆盖');
      eq(tN.inputModesAuto, ['input-2', 'input-3', 'input-4'], '空 auto 列表只补系统写的三条，input-1 保持用户所有');
      eq(tN.rows.length, 3, '没有逐行通道 → 行数沿用模型给的 3 行');
    }

    /* ---------- [12] 参考图清单按最终 inputs 编号（含自身图） ---------- */
    console.log('[12] 参考图清单：自身图参与编号');
    {
      const own = media('own', '/assets/input/own.jpg');
      const orderDoc = withDownstream(store1.state.doc, tbl1.id);
      orderDoc.nodes.push(own);
      orderDoc.edges.push(edge('ownEdge', 'own', 'gx'));
      const orderRows = table.batchRows(orderDoc, 'gx');
      const ownStore = new FakeStore(orderDoc, imageSpec);
      const req = engine.buildRequest(ownStore, ownStore.node('gx'), orderRows[0]);
      const sent = req.inputs.filter((x) => x.kind === 'image').map((x) => (x.url || '').replace('/assets/input/', ''));
      eq(sent.length, 10, '自身图 + 9 张行素材一起发送');
      eq(sent[0], 'own.jpg', '自身图排在最终 inputs 第 1 位');
      const refOrder = (req.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
      ok(refOrder.includes('图1=「own」'), '清单图1 = 自身图（标题 own）');
      ok(refOrder.includes('图2=输入1「场景参考」第1张'), '清单图2 = 输入1 第1张');
      ok(refOrder.includes('图3-5=输入2「人物三视图」整组'), '清单图3-5 = 输入2 整组');
      ok(refOrder.includes('图6=输入3「模特姿势」第1张'), '清单图6 = 输入3 第1张');
      ok(refOrder.includes('图7-10=输入4「产品多角度」整组'), '清单图7-10 = 输入4 整组（覆盖到最后一张）');
      // 单跑行节点（frozen）用 frozen.inputs 编号，结果一致
      const rowNode = { id: 'gxRow', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { frozen: req, tableRow: 1, rowText: orderRows[0].text, gen: { title: 'gxRow', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
      const frozenStore = new FakeStore({ ...orderDoc, nodes: [...orderDoc.nodes, rowNode] }, imageSpec);
      const frozenReq = engine.requestForNode(frozenStore, rowNode);
      const frozenOrder = (frozenReq.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
      ok(frozenOrder.includes('图1=「own」') && frozenOrder.includes('图2=输入1「场景参考」第1张'), '重新单跑行节点（frozen）清单编号一致');
    }

    /* ---------- [13] 自身图占 maxRefs 名额 ---------- */
    console.log('[13] 自身图 + maxRefs 预留名额');
    {
      const own2 = media('own2', '/assets/input/own2.jpg');
      const pImgs = Array.from({ length: 4 }, (_, i) => media('p' + i, '/assets/input/p' + i + '.jpg', { y: i * 100 }));
      const tbOwn = tableNode('tbOwn', plain('多维表格', ['画面'], [['行一']], { inputModes: { 'input-1': 'all' } }));
      const gxOwn = genNode('gxOwn', 'image');
      const doc = {
        nodes: [...pImgs, group('gOwn', pImgs.map((n) => n.id), '产品多角度'), tbOwn, own2, gxOwn],
        edges: [edge('o1', 'gOwn', 'tbOwn'), edge('o2', 'tbOwn', 'gxOwn'), edge('o3', 'own2', 'gxOwn')],
      };
      const row = table.batchRows(doc, 'gxOwn')[0];
      eq(table.ownRefCount(doc, 'gxOwn', 'image'), 1, '自身参考图 1 张');
      eq(table.ownRefCount(doc, 'gxOwn', 'video'), 0, '视频行请求不预留（自身图不会发送）');
      const cap4 = { id: 'm4', name: '图片4', vendor: '', tags: [], kind: 'image', secs: 10, i2i: true, maxRefs: 4 };
      const plan = table.planRow('image', { model: 'm4' }, cap4, row, 1);
      eq(plan.inputs.filter((x) => x.kind === 'image').length, 3, '行素材只剩 3 个名额（4 - 自身 1）');
      ok(plan.warnings.some((w) => w.includes('自身参考图占 1 张') && w.includes('「产品多角度」4 张只发送 3 张')), '截断告警体现自身占位并点名产品组：' + plan.warnings.join('；'));
      const ownStore = new FakeStore(doc, cap4);
      const req = engine.buildRequest(ownStore, gxOwn, row);
      const sent = req.inputs.filter((x) => x.kind === 'image').map((x) => (x.url || '').replace('/assets/input/', ''));
      eq(sent, ['own2.jpg', 'p0.jpg', 'p1.jpg', 'p2.jpg'], '总发送 4 张 = 自身 1 + 行素材 3，不超过 maxRefs=4');
      const refOrder = (req.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
      ok(refOrder.includes('图1=「own2」'), '清单图1 = 自身图');
      ok(refOrder.includes('图2-4=输入1「产品多角度」第1-3张'), '清单图2-4 = 真正发送的 p0..p2');
    }

    /* ---------- [14] 表头点掉最后一条自动通道：保留空数组，手设不被覆盖 ---------- */
    console.log('[14] 表头切换：inputModesAuto 清空时保留空数组');
    {
      const tnSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx'), 'utf8');
      ok(tnSrc.includes('inputModesAuto: auto'), '表头切换写回 inputModesAuto: auto（空数组也保留）');
      ok(!tnSrc.includes('inputModesAuto: undefined'), '不再把 inputModesAuto 写成 undefined（删字段）');
      // 点掉最后一条自动通道后的文档状态：auto=[] + 用户手设 input-1=shared；同一份 plan 重新出表
      const clickedState = plain('多维表格', ['画面'], [['旧']], { sourceId: 't1', inputModes: { 'input-1': 'shared' }, inputModesAuto: [] });
      eq(table.tableOf(tableNode('tbState', clickedState)).inputModesAuto, [], '空数组原样保留（不会退化成缺字段）');
      const world = multiRefDoc();
      const tbClicked = tableNode('tbClicked', clickedState, ['K0', 'K1', 'K2', 'K3', 'K4']);
      world.nodes.push(tbClicked);
      world.edges.push(edge('K0', 't1', 'tbClicked'), edge('K1', 'gScene', 'tbClicked'), edge('K2', 'gPerson', 'tbClicked'), edge('K3', 'gPose', 'tbClicked'), edge('K4', 'gProduct', 'tbClicked'));
      const storeK = await runToTable(world, [planSuccess, table3]);
      const tK = table.tableOf(storeK.state.doc.nodes.find((n) => n.id === 'tbClicked'));
      eq(tK.inputModes['input-1'], 'shared', '重新出表后手设 input-1=shared 保持（不被规划覆盖）');
      ok(Array.isArray(tK.inputModesAuto), '重新出表后 inputModesAuto 仍是数组');
      ok(!tK.inputModesAuto.includes('input-1'), 'input-1 仍是用户手设，不在自动列表');
      eq(tK.inputModesAuto, ['input-2', 'input-3', 'input-4'], '自动列表补上系统写的三条');
      eq(tK.rows.length, 3, '没有逐行通道 → 行数沿用模型给的 3 行');
    }

    /* ---------- [15] 部分 inputGroups：合并 + 逐通道推断 ---------- */
    console.log('[15] 部分 inputGroups：两遍合并 + 未声明通道继续推断');
    const planOnly1 = JSON.stringify({ rowCount: 3, inputGroups: [{ group: 1, rowMode: 'per-row' }] });
    // 合并规则（生成遍优先、缺的保留规划遍）
    eq(table.mergeInputGroups([{ group: 1, rowMode: 'per-row' }], [{ group: 1, rowMode: 'every-row' }, { group: 2, rowMode: 'per-row' }]),
      [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'per-row' }], 'mergeInputGroups：同组生成遍优先，其它组保留规划遍');
    eq(table.mergeInputGroups([], [{ group: 2, rowMode: 'every-row' }]), [{ group: 2, rowMode: 'every-row' }], 'mergeInputGroups：生成遍没声明时全量保留规划遍');

    // A) 规划只声明 group1，行文本对 2-4 写了「整组/全部」→ 4 条模式齐全、每行 9 张
    {
      const storeA = await runToTable(multiRefDoc(), [planOnly1, table3]);
      const tblA = storeA.state.doc.nodes.find((n) => n.kind === 'table');
      const tA = table.tableOf(tblA);
      eq(tA.rows.length, 3, 'A：行数仍按逐行组 = 3');
      eq(tA.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, 'A：声明 group1 + 行文本推断 2-4 → 4 条模式齐全');
      const rowsA = table.batchRows(withDownstream(storeA.state.doc, tblA.id), 'gx');
      eq(rowsA.map((r) => r.media.length), [9, 9, 9], 'A：每行发 9 张（不是 4 张）');
    }

    // A2) 真实模型措辞：「参考输入 2 的全部三视图 / 输入 3 的模特姿势 / 输入 4 的全部产品多角度图」
    {
      const realRow = (i) => '参考输入 1 的第' + i + '张场景图，参考输入 2 的全部三视图，参考输入 3 的模特姿势，参考输入 4 的全部产品多角度图';
      const tableReal = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [[realRow(1)], [realRow(2)], [realRow(3)]] });
      const storeR = await runToTable(multiRefDoc(), [planOnly1, tableReal]);
      const tblR = storeR.state.doc.nodes.find((n) => n.kind === 'table');
      const tR = table.tableOf(tblR);
      eq(tR.rows.length, 3, 'A2：真实措辞下行数仍 = 3');
      eq(tR.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-4': 'all' }, 'A2：输入 2/4 从「的全部」推断 all；输入 3 没关键词不硬写');
      eq(table.tableChannels(storeR.state.doc, tblR.id).map((c) => c.mode), ['sequence', 'all', 'shared', 'all'], 'A2：输入 3 只有 1 张，沿用/全部效果一样（仅这 1 张）');
      const rowsR = table.batchRows(withDownstream(storeR.state.doc, tblR.id), 'gx');
      eq(rowsR.map((r) => r.media.length), [9, 9, 9], 'A2：每行仍发 9 张（真实 bug 的 4 张已修）');
      eq(rowsR[0].media.map((m) => m.url.replace('/assets/input/', '')), ['sc0.jpg', 'pe0.jpg', 'pe1.jpg', 'pe2.jpg', 'po0.jpg', 'pr0.jpg', 'pr1.jpg', 'pr2.jpg', 'pr3.jpg'], 'A2：第 1 行顺序 = 场景 1 + 人物整组 + 姿势 + 产品整组');
    }

    // B) 生成遍只回报 group1、规划遍有完整 4 组 → 合并后 4 组都在
    {
      const genPartial = JSON.stringify({ kind: 'table', version: 1, inputGroups: [{ group: 1, rowMode: 'per-row' }], columns: ['画面'], rows: [[ROW_REF(1)], [ROW_REF(2)], [ROW_REF(3)]] });
      const storeB = await runToTable(multiRefDoc(), [planSuccess, genPartial]);
      const tblB = storeB.state.doc.nodes.find((n) => n.kind === 'table');
      const tB = table.tableOf(tblB);
      eq(table.tableOf(tblB).rows.length, 3, 'B：行数 3');
      eq(tB.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, 'B：生成遍只报 group1，规划遍 2-4 组被保留（不整体替换）');
      const rowsB = table.batchRows(withDownstream(storeB.state.doc, tblB.id), 'gx');
      eq(rowsB.map((r) => r.media.length), [9, 9, 9], 'B：每行 9 张');
    }

    // C) 没有任何证据 → 不硬写（声明 group1 之外的通道保持沿用）
    {
      const tablePlain = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['输入 1 第 1 张'], ['输入 1 第 2 张'], ['输入 1 第 3 张']] });
      const storeC = await runToTable(multiRefDoc(), [planOnly1, tablePlain]);
      const tblC = storeC.state.doc.nodes.find((n) => n.kind === 'table');
      const tC = table.tableOf(tblC);
      eq(tC.inputModes, { 'input-1': 'sequence' }, 'C：只有声明 + 输入 1 证据，其它通道不硬写');
      eq(table.tableChannels(storeC.state.doc, tblC.id).map((c) => c.mode), ['sequence', 'shared', 'shared', 'shared'], 'C：2-4 保持默认沿用');
      const rowsC = table.batchRows(withDownstream(storeC.state.doc, tblC.id), 'gx');
      eq(rowsC.map((r) => r.media.length), [4, 4, 4], 'C：沿用默认时每行每组各 1 张（行为不变）');
    }

    /* ---------- [16] 文本节点出表：@ 引用展开 ---------- */
    console.log('[16] 出表提示词展开 @ 图片 / @ 分组');
    {
      const world = multiRefDoc();
      const tn = world.nodes.find((n) => n.id === 't1');
      tn.data.gen.prompt = '参考 @{gScene} 的场景，人物用 @{gPerson}，姿势用 @{po0}，产品参考 @{gProduct}';
      const storeM = await runToTable(world, [planSuccess, table3]);
      const prompts = storeM.backend.prompts;
      eq(prompts.length, 2, '规划 + 生成两次请求');
      ok(!/\@\{[A-Za-z0-9_-]+/.test(prompts[0]), '规划提示词不再含 @{节点id}');
      ok(!/\@\{[A-Za-z0-9_-]+/.test(prompts[1]), '生成提示词不再含 @{节点id}');
      ok(prompts[1].includes('「图1」、「图2」、「图3」'), '分组 @{gScene} 展开成成员图号 图1-3');
      ok(prompts[1].includes('「图4」、「图5」、「图6」'), '分组 @{gPerson} 展开成成员图号 图4-6');
      ok(prompts[1].includes('「图7」'), '图片 @{po0} 展开成图7');
      ok(prompts[1].includes('「图8」、「图9」、「图10」、「图11」'), '分组 @{gProduct} 展开成成员图号 图8-11');
      const tblM = storeM.state.doc.nodes.find((n) => n.kind === 'table');
      eq(table.tableChannels(storeM.state.doc, tblM.id).length, 4, '@ 不会新增输入通道（仍然只看连线）');
    }
    // 无 @ 的提示词保持原样
    {
      const storeP2 = await runToTable(multiRefDoc(), [planSuccess, table3]);
      ok(storeP2.backend.prompts[1].includes('每行一个场景，人物三视图、模特姿势、产品多角度每行都作为参考'), '无 @ 的提示词原样保留');
    }
    // 不能看图的模型：@ 回落成标题 / 组名，仍然不能漏 @{...}
    {
      const world = multiRefDoc();
      world.nodes.find((n) => n.id === 't1').data.gen.prompt = '参考 @{gScene}，姿势用 @{po0}';
      const storeNv = await runToTable(world, [planSuccess, table3], { ...textSpec, vision: false });
      const prompts = storeNv.backend.prompts;
      ok(!/\@\{[A-Za-z0-9_-]+/.test(prompts[0]) && !/\@\{[A-Za-z0-9_-]+/.test(prompts[1]), '不能看图时提示词也不含 @{节点id}');
      ok(prompts[1].includes('「场景参考」') && prompts[1].includes('「po0」'), '不能看图时 @ 回落成组名 / 节点标题');
    }

    /* ---------- [17] 堆叠重命名：groupLabel / groupInputs / tableChannels 口径一致 ---------- */
    console.log('[17] 堆叠重命名后的组名');
    {
      const imgs = ['k1a', 'k1b', 'k2a', 'k2b', 'k3a', 'k3b', 'g1', 'g2', 'd1', 'd2'].map((id) => media(id, '/assets/input/' + id + '.jpg'));
      const stk1 = { ...stack('stk1', ['k1a', 'k1b']), text: '人物三视图' };
      const stk2 = { ...stack('stk2', ['k2a', 'k2b']), text: '产品多角度' };
      const stk3 = stack('stk3', ['k3a', 'k3b']);
      const gPlain = group('gPlain', ['g1', 'g2'], '场景参考');
      const gDefault = group('gDefault', ['d1', 'd2'], '分组');
      const tb = tableNode('tbStk', plain('多维表格', ['画面'], [['x']]));
      const doc = {
        nodes: [...imgs, stk1, stk2, stk3, gPlain, gDefault, tb],
        edges: [edge('k1', 'stk1', 'tbStk'), edge('k2', 'stk2', 'tbStk'), edge('k3', 'stk3', 'tbStk'), edge('k4', 'gPlain', 'tbStk'), edge('k5', 'gDefault', 'tbStk')],
      };
      eq(table.tableChannels(doc, 'tbStk').map((c) => c.title), ['人物三视图', '产品多角度', '堆叠', '场景参考', '分组'], 'tableChannels 用重命名后的组名；未改名的堆叠仍是「堆叠」；普通分组不变');
      eq(table.groupInputs(doc, 'tbStk', 'image').map((g) => g.name), ['人物三视图', '产品多角度', '堆叠', '场景参考', '分组'], 'groupInputs 取名字口径与 tableChannels 一致');
      eq(table.tableChannels(doc, 'tbStk').map((c) => c.items.length), [2, 2, 2, 2, 2], '通道素材数量不受改名影响');
    }

    console.log('[PASS] 多维表格多参考图：行数 / 通道模式 / 输入编号 / 嵌套分组 / 截断点名 / caps ref_max / 旧文档迁移 / 自身图编号与名额 / 表头清空保数组 / 部分 inputGroups 合并与逐通道推断 / @ 展开与堆叠重命名');
})().catch((err) => { console.error(err); process.exit(1); });
