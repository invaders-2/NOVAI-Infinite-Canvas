#!/usr/bin/env node
'use strict';
/*
 * 验证岗独立回归：多维表格「多参考图」修复的对抗性验证（不改产品，只断言）。
 *
 * 覆盖：通道模式推断正则（并列句 / 词序 / 数字边界）、输入编号 / 边顺序（pinSourceOrder）、
 *      用户手设模式与旧文档迁移（inputModesAuto 缺失 / 空数组两种口径）、行数裁剪、
 *      参考图顺序清单（refOrderText）按最终发送的 inputs 编号（含生成节点自身图占名额）、
 *      常驻告警、caps 的 ref_max（含 audio）、构建产物。
 *
 * 约定：修复后的行为用 assert 严格断言（失败即套件失败）；
 *      本轮新发现、但不允许修改产品的缺陷用 knownIssue() 记录并打印 [KNOWN]，
 *      不让它把套件挂掉（报告里单列「失败 / 风险」，由 Lead 决定是否修）。
 * 运行：node tests/test_novai_canvas_table_multiref_verify.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputText ? result.outputText : result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const table = load('novai-canvas-ui/src/canvas/canvas-next/table.ts');
const engine = load('novai-canvas-ui/src/canvas/canvas-next/engine.ts');
const caps = load('novai-canvas-ui/src/canvas/canvas-next/modelCaps.ts');
const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');
const readSrc = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
const known = [];
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); pass++; };
const ok = (v, msg) => { assert.ok(v, msg); pass++; };
const knownIssue = (id, detail) => { known.push({ id, detail }); console.log('[KNOWN] ' + id + '：' + detail); };

/* ---------- 文档构造 ---------- */
const media = (id, url) => ({ id, kind: 'image', x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: id, prompt: '', params: {}, order: [], hi: 0, hist: [{ url: url || '/assets/input/' + id + '.jpg' }] } } });
const videoMedia = (id, url) => ({ id, kind: 'video', x: 0, y: 0, w: 320, h: 180, text: '', data: { gen: { title: id, prompt: '', params: {}, order: [], hi: 0, hist: [{ url: url || '/output/' + id + '.mp4', frame: '/output/' + id + '.jpg' }] } } });
const textNode = (id, title, extra = {}) => ({ id, kind: 'text', x: 0, y: 0, w: 280, h: 200, text: '', data: { gen: { title, prompt: extra.prompt || '', params: { output: extra.output || 'table', model: 'm-text' }, hist: [{ text: '正文' }], hi: 0, order: extra.order || [] } } });
const group = (id, children, extra = {}) => ({ id, kind: 'group', x: 0, y: 0, w: 300, h: 300, text: extra.text || '分组', children, ...(extra.data ? { data: extra.data } : {}) });
const tableNode = (id, t, extra = {}) => ({ id, kind: 'table', x: 0, y: 0, w: 400, h: 300, text: t.title, data: { table: t, gen: { title: t.title, prompt: '', params: {}, hist: [], hi: 0, order: extra.order || [] } } });
const genNode = (id, kind, extra = {}) => ({ id, kind, x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: id, prompt: extra.prompt || '批量生成', params: extra.params || {}, hist: [], hi: 0, order: extra.order || [] } } });
const edge = (id, from, to) => ({ id, from, to });
const plain = (title, columns, rows, extra = {}) => ({ kind: 'table', version: 1, title, columns, rows, ...extra });
const orderOf = (n) => (n && n.data && n.data.gen ? n.data.gen.order : []) || [];
const warningsOf = (doc, id) => table.tableInputWarnings(doc, id);
const inferModes = (rows, channelCount) => table.inferChannelModesFromRows(
    { kind: 'table', version: 1, title: '表', columns: ['画面'], rows: rows.map((r) => [r]) },
    Array.from({ length: channelCount }, (_, i) => ({ id: 'input-' + (i + 1), sourceId: 's' + i, title: '组' + (i + 1), mode: 'shared', items: [] })),
);

class FakeStore {
    constructor(doc, spec) { this.state = { doc, canvasId: 'c1', runtime: {} }; this.spec = spec; this.toasts = []; }
    node(id) { return this.state.doc.nodes.find((n) => n.id === id); }
    modelOf() { return this.spec; }
    setRun() {} patchRun() {}
    toast(s) { this.toasts.push(s); }
    logRun() {} snapshot() {}
    patchGen(id, patch) { this.updateNode(id, (n) => { const gen = { ...((n.data || {}).gen || {}) }; Object.assign(gen, typeof patch === 'function' ? patch(gen) : patch); return { ...n, data: { ...(n.data || {}), gen } }; }); }
    updateNode(id, fn) { this.state = { ...this.state, doc: { ...this.state.doc, nodes: this.state.doc.nodes.map((n) => (n.id === id ? fn(n) : n)) } }; }
    addNodes(nodes, edges = []) { this.state = { ...this.state, doc: { ...this.state.doc, nodes: [...this.state.doc.nodes, ...nodes], edges: [...this.state.doc.edges, ...edges] } }; }
    backendFor(...replies) {
        const queue = replies.length ? [...replies] : [''];
        const prompts = [];
        return { prompts, generate: async (req) => { prompts.push(String((req && req.resolvedPrompt) || '')); const text = queue.length > 1 ? queue.shift() : queue[0]; return { outputs: [{ text }] }; } };
    }
}
const textSpec = { id: 'm-text', name: '文本模型', vendor: '', tags: [], kind: 'text', secs: 6, vision: true, search: true };
const imageSpec = { id: 'm-img', name: '图片模型', vendor: '', tags: [], kind: 'image', secs: 12, ratios: ['1:1', '16:9'], sizes: ['2K'], batch: [1], maxRefs: 12, i2i: true };
const imageSpecCap4 = { ...imageSpec, maxRefs: 4 };
const videoSpec = { id: 'm-vid', name: '视频模型', vendor: '', tags: [], kind: 'video', secs: 60, modes: ['文生视频', '首帧', '首尾帧', '参考生视频'], ratios: ['16:9'], res: ['720p'], durs: [5, 10], maxRefs: 6 };
const tableJson = (columns, rows) => JSON.stringify({ kind: 'table', version: 1, columns, rows });
const spec = (kind) => ({ id: 'm-' + kind, name: kind, vendor: '', tags: [], kind, secs: 10 });
const buildStore = (doc, s) => ({
    state: { doc, canvasId: 'c1', runtime: {} }, node: (id) => doc.nodes.find((n) => n.id === id), modelOf: () => s,
    toast: () => {}, patchGen: () => {}, setRun: () => {},
});

/* 4 组素材：场景 3 / 人物三视图 3 / 模特姿势 1 / 产品多角度 4（= Boss 场景） */
const TITLES = ['场景图', '人物三视图', '模特姿势', '产品多角度'];
const COUNTS = [3, 3, 1, 4];
function mkWorld(counts = COUNTS) {
    const nodes = []; const edges = [];
    counts.forEach((n, gi) => {
        const ids = [];
        for (let i = 0; i < n; i++) { const id = 'g' + (gi + 1) + 'm' + (i + 1); ids.push(id); nodes.push(media(id)); }
        nodes.push(group('grp' + (gi + 1), ids, { text: TITLES[gi] }));
        edges.push(edge('src' + (gi + 1), 'grp' + (gi + 1), 't1'));
    });
    nodes.push(textNode('t1', '批量生成', { prompt: '每行一个场景；人物三视图、模特姿势、产品多角度都用整组' }));
    return { nodes, edges };
}
const planOf = (groups) => JSON.stringify({ rowCount: groups.length, inputGroups: groups });
const plan4 = JSON.stringify({ rowCount: 3, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }, { group: 3, rowMode: 'every-row' }, { group: 4, rowMode: 'every-row' }] });
const addBatchNode = (doc, tableId, id = 'gx') => {
    const g = genNode(id, 'image');
    doc.nodes.push(g); doc.edges.push(edge(id + '-edge', tableId, id));
    return g;
};
const runToTable = async (world, output, replies) => {
    const store = new FakeStore({ ...world, comments: [] }, textSpec);
    store.backend = store.backendFor(...replies);
    if (output) { const n = store.node('t1'); n.data.gen.params = { ...n.data.gen.params, output }; }
    const okRun = await engine.runTextToTable(store, 't1');
    return { store, ok: okRun, table: store.state.doc.nodes.find((n) => n.kind === 'table'), doc: store.state.doc };
};

(async () => {
    /* ================= [1] 通道模式推断正则（inferChannelModesFromRows） ================= */
    console.log('[1] inferChannelModesFromRows 对抗：并列句 / 第 k 张 / 编号串号');
    eq(inferModes(['输入 1 第 2 张'], 2), { 'input-1': 'sequence' }, '「输入 1 第 2 张」→ 逐行');
    eq(inferModes(['输入 2 整组'], 2), { 'input-2': 'all' }, '「输入 2 整组」→ 全部');
    eq(inferModes(['输入 1 的整组'], 2), { 'input-1': 'all' }, '「输入 1 的整组」→ 全部');
    eq(inferModes(['输入 1 每张都用'], 2), { 'input-1': 'all' }, '「输入 1 每张」→ 全部');
    eq(inferModes(['输入 1 全组'], 2), { 'input-1': 'all' }, '「输入 1 全组」→ 全部');
    eq(inferModes(['输入 1 全部'], 2), { 'input-1': 'all' }, '「输入 1 全部」→ 全部');
    eq(inferModes(['输入 1 第 10 张'], 2), { 'input-1': 'sequence' }, '「输入 1 第 10 张」→ 逐行（不是误判成别的组）');
    eq(inferModes(['输入 1 第 2 张', '输入 2 整组'], 3), { 'input-1': 'sequence', 'input-2': 'all' }, '同一段行文本里两组各判各的');
    eq(inferModes(['第一行', '第二行'], 2), {}, '没有任何证据 → 不写任何模式');
    eq(inferModes(['输入 3 第 1 张'], 2), {}, '行文本引用的组号超出通道数 → 不改任何通道');
    eq(inferModes(['输入 10 整组'], 10), { 'input-10': 'all' }, '10 通道时「输入 10 整组」只命中第 10 条');
    eq(inferModes(['输入 10 整组'], 3), {}, '3 通道时「输入 10 整组」不许把第 1 条当成命中');
    eq(inferModes(['输入 10 第 2 张'], 10), { 'input-10': 'sequence' }, '「输入 10 第 2 张」只命中第 10 条');
    eq(inferModes(['第 2 张要用输入 1'], 2), { 'input-1': 'sequence' }, '倒装「第 2 张 … 输入 1」→ 逐行');

    // 修复后：并列句 / 词序变体 / 数字边界都必须判对（三条原 knownIssue 已转严格断言）
    eq(inferModes(['输入 1、输入 2 整组'], 2), { 'input-1': 'all', 'input-2': 'all' }, '并列句「输入 1、输入 2 整组」→ 两条都是全部');
    eq(inferModes(['输入 1 和 输入 2 整组'], 2), { 'input-1': 'all', 'input-2': 'all' }, '并列句「输入 1 和 输入 2 整组」→ 两条都是全部');
    eq(inferModes(['输入 1、输入 2 第 2 张'], 2), { 'input-1': 'sequence', 'input-2': 'sequence' }, '并列句共享后缀「第 2 张」→ 两条都逐行');
    eq(inferModes(['输入 1 的 5 张图全部用上'], 2), { 'input-1': 'all' }, '词序变体「输入 1 的 5 张图全部用上」→ 全部');
    eq(inferModes(['第 2 张来自输入 10'], 10), { 'input-10': 'sequence' }, '10 通道「第 2 张…输入 10」只命中 input-10（数字边界不再串到 input-1）');
    eq(inferModes(['输入 1 整组，输入 2 第 1 张'], 2), { 'input-1': 'all', 'input-2': 'sequence' }, '同段逗号并列：整组 / 第 k 张各判各的');
    eq(inferModes(['输入 1 都用'], 2), { 'input-1': 'all' }, '「输入 1 都用」→ 全部');

    /* ================= [2] 编号 / 边顺序（pinSourceOrder） ================= */
    console.log('[2] pinSourceOrder：反序入边 + 手连通道 / 夹在中间 / 加组删组 / 重复出表');
    {
        // 旧表入边顺序 = [grp2, grp1, 文本, hand]（与 sources 顺序 grp1..grp4 不一致），且 hand 不在提示词组里
        const world = mkWorld();
        const hand = media('hand');
        const oldTable = tableNode('tbOld', plain('多维表格', ['画面'], [['旧行']], { sourceId: 't1' }), { order: [] });
        world.nodes.push(hand, oldTable);
        world.edges.push(edge('eB', 'grp2', 'tbOld'), edge('eA', 'grp1', 'tbOld'), edge('eText', 't1', 'tbOld'), edge('eHand', 'hand', 'tbOld'));
        const res = await runToTable(world, 'table', [plan4, tableJson(['画面'], [['一'], ['二'], ['三']])]);
        const doc = res.doc; const tb = doc.nodes.find((n) => n.id === 'tbOld');
        ok(res.ok, '反序入边 + 手连通道时出表成功');
        eq(table.tableChannels(doc, 'tbOld').map((c) => c.sourceId), ['grp1', 'grp2', 'grp3', 'grp4', 'hand'], '通道顺序被钉回提示词组顺序，手连通道排最后且不丢');
        eq(table.tableChannels(doc, 'tbOld').map((c) => c.mode), ['sequence', 'all', 'all', 'all', 'shared'], '通道模式落在正确的组上（手连通道不动）');
        eq(table.tableOf(tb).rows.length, 3, '行数 = 逐行组张数（3），手连通道不参与行数');
        const pinned = orderOf(tb);
        eq(pinned.length, 5, 'data.gen.order 落成「文本 + 4 个素材来源」5 条');
        eq(pinned.map((id) => (doc.edges.find((e) => e.id === id) || {}).from), ['t1', 'grp1', 'grp2', 'grp3', 'grp4'], 'data.gen.order 顺序 = 文本 → 输入 1..4');
        ok(doc.edges.some((e) => e.from === 'hand' && e.to === 'tbOld'), '手连通道的连线没被删');
        const warns = warningsOf(doc, 'tbOld');
        eq(warns.length, 1, '多出一条旧通道 → 一条告警');
        ok(warns[0].includes('输入 5「hand」') && warns[0].includes('已排在最后'), '告警点名第 5 条旧通道并说明排最后：' + warns[0]);
        ok(res.store.toasts.join(' ').includes('已排在最后'), 'toast 也带上旧通道说明');
        // 提示词里的组顺序 = 通道顺序
        const prompt = res.store.backend.prompts[1] || '';
        const listed = prompt.split('\n').filter((l) => /^第 \d 组（输入 \d）/.test(l)).slice(0, 4).map((l) => l.replace(/^第 \d 组（输入 \d）「/, '').replace(/」.*$/, ''));
        eq(listed, TITLES, '提示词列出的组顺序 = 表格「输入 N」顺序');
    }
    {
        // 手连通道夹在两条来源之间、表格没有显式 order
        const world = mkWorld([2, 2]);
        const hand = media('hand1');
        const oldTable = tableNode('tbOld', plain('多维表格', ['画面'], [['旧']], { sourceId: 't1' }), { order: [] });
        world.nodes.push(hand, oldTable);
        world.edges.push(edge('e1', 'grp1', 'tbOld'), edge('eH', 'hand1', 'tbOld'), edge('e2', 'grp2', 'tbOld'), edge('eT', 't1', 'tbOld'));
        const res = await runToTable(world, 'table', [JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] }), tableJson(['画面'], [['1'], ['2']])]);
        eq(table.tableChannels(res.doc, 'tbOld').map((c) => c.sourceId), ['grp1', 'grp2', 'hand1'], '夹在中间的旧通道被排到对应来源之后');
        eq(table.tableOf(res.doc.nodes.find((n) => n.id === 'tbOld')).rows.length, 2, '夹手连通道时行数仍按逐行组 = 2');
        eq(orderOf(res.doc.nodes.find((n) => n.id === 'tbOld')).length, 3, '无 order 的旧表也被钉成 3 条边');
    }
    {
        // 重复出表：不建第二张表、order 稳定、行数不变
        const world = mkWorld([2, 3]);
        const plan2 = JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] });
        const store = new FakeStore({ ...world, comments: [] }, textSpec);
        store.backend = store.backendFor(plan2, tableJson(['画面'], [['1'], ['2']]), plan2, tableJson(['画面'], [['1'], ['2']]));
        ok(await engine.runTextToTable(store, 't1'), '第一次出表');
        const tb1 = store.state.doc.nodes.find((n) => n.kind === 'table');
        ok(await engine.runTextToTable(store, 't1'), '第二次出表');
        const tables = store.state.doc.nodes.filter((n) => n.kind === 'table');
        eq(tables.length, 1, '重复出表不新建第二张表');
        eq(table.tableOf(tables[0]).rows.length, 2, '重复出表后行数仍是 2');
        eq(orderOf(tables[0]).length, 3, '重复出表后 order 稳定为 3 条');
        eq(table.tableChannels(store.state.doc, tb1.id).map((c) => c.mode), ['sequence', 'all'], '重复出表模式不漂移');
    }
    {
        // 加组 / 删组：行数跟着变，删掉的来源变旧通道并告警
        const world = mkWorld([2, 2]);
        const plan2 = JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] });
        const store = new FakeStore({ ...world, comments: [] }, textSpec);
        store.backend = store.backendFor(plan2, tableJson(['画面'], [['1'], ['2']]));
        await engine.runTextToTable(store, 't1');
        const tb = store.state.doc.nodes.find((n) => n.kind === 'table');
        for (let i = 1; i <= 4; i++) store.state.doc.nodes.push(media('g3m' + i));
        store.state.doc.nodes.push(group('grp3', ['g3m1', 'g3m2', 'g3m3', 'g3m4'], { text: '产品多角度' }));
        store.state.doc.edges.push(edge('src3', 'grp3', 't1'));
        store.backend = store.backendFor(JSON.stringify({ rowCount: 4, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }, { group: 3, rowMode: 'per-row' }] }), tableJson(['画面'], [['1'], ['2'], ['3'], ['4'], ['5']]));
        await engine.runTextToTable(store, 't1');
        eq(table.tableOf(store.node(tb.id)).rows.length, 4, '加一组 4 张逐行来源 → 裁到 4 行');
        // 删组：只从文本节点断开，表格上的旧连线保留
        store.state.doc.edges = store.state.doc.edges.filter((e) => !(e.from === 'grp3' && e.to === 't1'));
        store.backend = store.backendFor(JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] }), tableJson(['画面'], [['1'], ['2'], ['3'], ['4'], ['5']]));
        await engine.runTextToTable(store, 't1');
        eq(table.tableOf(store.node(tb.id)).rows.length, 2, '删掉逐行来源后行数回到 2');
        eq(table.tableChannels(store.state.doc, tb.id).map((c) => c.sourceId), ['grp1', 'grp2', 'grp3'], '删掉的来源仍以旧通道保留');
        ok(warningsOf(store.state.doc, tb.id).join(' ').includes('不在这次提示词组里'), '删组后常驻告警提示旧通道');
    }

    /* ================= [3] 用户手设模式 / 旧文档迁移 ================= */
    console.log('[3] 新格式（inputModesAuto 存在）保护手设 / 旧文档（缺失）按规划迁移覆盖');
    {
        // 新格式：inputModesAuto 存在（哪怕是空数组）+ 表头手点 input-2=shared → 重新出表保持 shared
        const world = mkWorld([2, 2, 3]);
        const old = tableNode('tbNew', plain('多维表格', ['画面'], [['旧']], { sourceId: 't1', inputModes: { 'input-2': 'shared' }, inputModesAuto: [] }));
        world.nodes.push(old);
        world.edges.push(edge('e1', 'grp1', 'tbNew'), edge('e2', 'grp2', 'tbNew'), edge('e3', 'grp3', 'tbNew'), edge('eT', 't1', 'tbNew'));
        const plan = JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }, { group: 3, rowMode: 'every-row' }] });
        const res = await runToTable(world, 'table', [plan, tableJson(['画面'], [['一'], ['二']])]);
        const t = table.tableOf(res.doc.nodes.find((n) => n.id === 'tbNew'));
        eq(t.inputModes['input-2'], 'shared', '新格式（inputModesAuto=[]）里手点的 input-2=shared 重出表后仍是 shared');
        eq(t.inputModesAuto, ['input-1', 'input-3'], 'inputModesAuto 只记系统写的 input-1 / input-3，用户手设不写回 auto');
        eq(table.tableChannels(res.doc, 'tbNew').map((c) => c.mode), ['sequence', 'shared', 'all'], '生效模式：逐行 / 沿用（用户手设）/ 全部');
        // TableNode 表头点击把该通道从 inputModesAuto 移掉（源码级）
        const tableNodeSrc = readSrc('novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx');
        ok(tableNodeSrc.includes('(x.inputModesAuto || []).filter((k) => k !== id)'), 'TableNode 表头切换会把该通道移出 inputModesAuto');
    }
    {
        // 旧文档（上一版系统写的 inputModes，没有 inputModesAuto）：按旧自动模式对待，本次出表覆盖并补写 inputModesAuto
        const world = mkWorld([3, 3]);
        const old = tableNode('tbOld', plain('多维表格', ['画面'], [['旧']], { sourceId: 't1', inputModes: { 'input-1': 'all' } }));
        world.nodes.push(old);
        world.edges.push(edge('e1', 'grp1', 'tbOld'), edge('e2', 'grp2', 'tbOld'), edge('eT', 't1', 'tbOld'));
        const plan = JSON.stringify({ rowCount: 3, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] });
        const res = await runToTable(world, 'table', [plan, tableJson(['画面'], [['1'], ['2'], ['3'], ['4'], ['5']])]);
        const tb = res.doc.nodes.find((n) => n.id === 'tbOld');
        const t = table.tableOf(tb);
        eq(t.inputModes, { 'input-1': 'sequence', 'input-2': 'all' }, '旧文档的旧自动模式被本次规划覆盖（input-1=逐行）');
        eq(t.inputModesAuto, ['input-1', 'input-2'], '旧文档出表后补写 inputModesAuto，标成新格式');
        eq(t.rows.length, 3, '旧文档也按逐行组裁到 3 行');
        ok(res.store.toasts.join(' ').includes('行数对齐到 3 行'), '旧文档迁移后同样给「行数对齐」提示');
        // 迁移后字段已存在：再来一份不同的规划，系统写的模式仍可被覆盖（不会被旧文档口径锁死）
        const plan2 = JSON.stringify({ rowCount: 3, inputGroups: [{ group: 1, rowMode: 'every-row' }, { group: 2, rowMode: 'per-row' }] });
        const res2 = await runToTable({ nodes: res.doc.nodes, edges: res.doc.edges }, 'table', [plan2, tableJson(['画面'], [['一'], ['二'], ['三']])]);
        const t2 = table.tableOf(res2.doc.nodes.find((n) => n.id === 'tbOld'));
        eq(t2.inputModes, { 'input-1': 'all', 'input-2': 'sequence' }, '迁移后第二次出表：系统写的模式按新规划覆盖');
        eq(t2.inputModesAuto, ['input-1', 'input-2'], '迁移后第二份规划的系统模式都记在 inputModesAuto 里');
    }
    {
        // 表头把最后一个 auto 通道点掉：inputModesAuto 必须保留成空数组（删字段 = 退回旧格式，手设会被覆盖）
        const tableNodeSrc = readSrc('novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx');
        ok(tableNodeSrc.includes('inputModesAuto: auto'), 'TableNode 表头切换写回 inputModesAuto: auto（空数组也保留字段）');
        ok(!tableNodeSrc.includes('inputModesAuto: undefined'), 'TableNode 不再把 inputModesAuto 写成 undefined');
        // 清空最后一条 auto 后的表格经归一化仍是数组（不会被当旧文档）
        const cleared = table.tableOf(tableNode('tbCleared', plain('表格', ['画面'], [['x']], { inputModes: { 'input-1': 'sequence' }, inputModesAuto: [] })));
        eq(Array.isArray(cleared.inputModesAuto), true, '清空后 inputModesAuto 仍是数组');
        eq(cleared.inputModesAuto, [], '清空后 inputModesAuto = []（不是 undefined / 删字段）');
        // 端到端：清空后 input-1 是用户手设（shared），plan 声明 group1 per-row 也不能覆盖
        const world = mkWorld([3, 3]);
        const clicked = tableNode('tbClicked', plain('多维表格', ['画面'], [['旧']], { sourceId: 't1', inputModes: { 'input-1': 'shared' }, inputModesAuto: [] }));
        world.nodes.push(clicked);
        world.edges.push(edge('e1', 'grp1', 'tbClicked'), edge('e2', 'grp2', 'tbClicked'), edge('eT', 't1', 'tbClicked'));
        const plan = JSON.stringify({ rowCount: 3, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] });
        const res = await runToTable(world, 'table', [plan, tableJson(['画面'], [['1'], ['2'], ['3']])]);
        const t = table.tableOf(res.doc.nodes.find((n) => n.id === 'tbClicked'));
        eq(t.inputModes, { 'input-1': 'shared', 'input-2': 'all' }, '清空 auto 后手设的 input-1=shared 不被规划覆盖');
        eq(t.inputModesAuto, ['input-2'], '只有系统写的 input-2 进 inputModesAuto');
        eq(t.rows.length, 3, '没有逐行通道时行数按模型给的 3 行（不误裁）');
    }

    /* ================= [4] 行数口径 ================= */
    console.log('[4] 行数：规划成功 / 规划失败但有行文本 / 无证据 / 分镜表');
    {
        // 规划成功 4 组 → 3 行，每行 9 张，顺序 = 场景i → 人物 → 姿势 → 产品
        const world = mkWorld();
        const res = await runToTable(world, 'table', [plan4, tableJson(['画面'], [['一'], ['二'], ['三']])]);
        const t = table.tableOf(res.table);
        eq(t.rows.length, 3, '规划成功：行数 = 逐行组张数 3');
        eq(t.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '规划成功：模式照 inputGroups');
        eq(t.inputModesAuto, ['input-1', 'input-2', 'input-3', 'input-4'], '规划成功：四条通道都记进 inputModesAuto');
        addBatchNode(res.doc, res.table.id);
        const rows = table.batchRows(res.doc, 'gx');
        eq(rows.length, 3, '批量 3 行');
        eq(rows.map((r) => r.media.length), [9, 9, 9], '每行 9 张：场景 1 + 人物 3 + 姿势 1 + 产品 4');
        eq(rows[1].media.map((m) => m.url.replace('/assets/input/', '')), ['g1m2.jpg', 'g2m1.jpg', 'g2m2.jpg', 'g2m3.jpg', 'g3m1.jpg', 'g4m1.jpg', 'g4m2.jpg', 'g4m3.jpg', 'g4m4.jpg'], '第 2 行顺序 = 场景2 → 人物整组 → 姿势 → 产品整组');
        eq(rows[0].media.map((m) => m.channelId), ['input-1', 'input-2', 'input-2', 'input-2', 'input-3', 'input-4', 'input-4', 'input-4', 'input-4'], '每张图带着来源通道编号，供 refOrder 用');
    }
    {
        // 规划失败（含重试）但有行文本证据 → 仍 3 行
        const world = mkWorld();
        const rowsWithEvidence = [
            '场景 1：输入 1 第 1 张；人物三视图输入 2 整组；模特姿势输入 3 整组；产品多角度输入 4 整组',
            '场景 2：输入 1 第 2 张；人物三视图输入 2 整组；模特姿势输入 3 整组；产品多角度输入 4 整组',
            '场景 3：输入 1 第 3 张；人物三视图输入 2 整组；模特姿势输入 3 整组；产品多角度输入 4 整组',
            '多余的第 4 行',
        ];
        const res = await runToTable(world, 'table', ['这不是 JSON 规划', '还不是 JSON', tableJson(['画面'], rowsWithEvidence.map((r) => [r]))]);
        const t = table.tableOf(res.table);
        eq(res.store.backend.prompts.length, 3, '规划失败重试一次（规划 + 重试 + 生成 = 3 次请求）');
        eq(t.rows.length, 3, '规划失败但行文本有证据：仍裁到 3 行');
        eq(t.inputModes, { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' }, '行文本证据推断出 4 条通道模式');
        ok(res.store.toasts.join(' ').includes('行数对齐到 3 行'), 'toast 说明按素材对齐到 3 行');
    }
    {
        // 完全无证据 → 保持模型行数 + 沿用（老板截图场景不许回归）
        const world = mkWorld([2, 5]);
        const res = await runToTable(world, 'table', ['no json', 'no json', tableJson(['画面'], [['1'], ['2'], ['3'], ['4'], ['5']])]);
        const t = table.tableOf(res.table);
        eq(t.rows.length, 5, '无证据：保持模型给的 5 行');
        eq(t.inputModes, undefined, '无证据：不写 inputModes');
        eq(t.inputModesAuto, [], '无证据：仍写 inputModesAuto=[] 标成新格式（空数组 ≠ 旧文档）');
        eq(table.tableChannels(res.doc, res.table.id).map((c) => c.mode), ['shared', 'shared'], '无证据：两条通道都沿用');
        ok(!res.store.toasts.join(' ').includes('行数对齐'), '无证据：不给行数对齐提示');
    }
    {
        // 分镜表：不补不裁；没声明时模式沿用
        const world = mkWorld();
        const resSb = await runToTable(world, 'storyboard', [plan4, tableJson(['镜头', '画面'], [['1', 'a'], ['2', 'b'], ['3', 'c'], ['4', 'd'], ['5', 'e']])]);
        const tSb = table.tableOf(resSb.table);
        eq(tSb.rows.length, 5, '分镜表：行数 = 镜头数，不被逐行通道裁');
        ok(tSb.columns.includes('首帧') && tSb.columns.includes('尾帧'), '分镜表：追加首帧 / 尾帧图片列');
        const world2 = mkWorld();
        const resSb2 = await runToTable(world2, 'storyboard', ['no json', 'no json', tableJson(['镜头', '画面'], [['1', '输入 1 第 1 张'], ['2', 'b']])]);
        const tSb2 = table.tableOf(resSb2.table);
        eq(tSb2.inputModes, undefined, '分镜表没有声明时不做行文本推断（模式沿用）');
        eq(tSb2.inputModesAuto, [], '分镜表没声明也写 inputModesAuto=[]（新格式标记）');
    }

    /* ================= [5] refOrderText 与真实请求 inputs ================= */
    console.log('[5] 参考图顺序清单 vs 真实请求 inputs');
    {
        // 无自身输入：清单必须与 inputs 图片顺序一一对应
        const world = mkWorld();
        const modes = { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' };
        const tb = tableNode('tb', plain('多维表格', ['提示词'], [['行一'], ['行二'], ['行三']], { inputModes: modes }), { order: ['e0', 'e1', 'e2', 'e3'] });
        world.nodes.push(tb);
        world.edges.push(edge('e0', 'grp1', 'tb'), edge('e1', 'grp2', 'tb'), edge('e2', 'grp3', 'tb'), edge('e3', 'grp4', 'tb'));
        const gen = genNode('gx', 'image');
        world.nodes.push(gen); world.edges.push(edge('etb', 'tb', 'gx'));
        const store = buildStore(world, imageSpec);
        const rows = table.batchRows(world, 'gx');
        const req = engine.buildRequest(store, gen, rows[0]);
        const imgs = req.inputs.filter((i) => i.kind === 'image');
        eq(imgs.map((i) => i.url.split('/').pop()), ['g1m1.jpg', 'g2m1.jpg', 'g2m2.jpg', 'g2m3.jpg', 'g3m1.jpg', 'g4m1.jpg', 'g4m2.jpg', 'g4m3.jpg', 'g4m4.jpg'], '请求里的图片顺序 = 场景1 → 人物 → 姿势 → 产品');
        const refOrder = (req.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
        ok(refOrder.includes('图1=输入1「场景图」第1张'), '清单：图1 = 输入1 第1张');
        ok(refOrder.includes('图2-4=输入2「人物三视图」整组（第1-3张）'), '清单：图2-4 = 输入2 整组');
        ok(refOrder.includes('图5=输入3「模特姿势」第1张'), '清单：图5 = 输入3 第1张');
        ok(refOrder.includes('图6-9=输入4「产品多角度」整组（第1-4张）'), '清单：图6-9 = 输入4 整组');
        eq(refOrder.split('\n').filter((l) => /^图/.test(l)).length, 4, '清单行数 = 通道段数（编号从 1 连续覆盖 9 张图）');
        eq((refOrder.match(/参考图顺序/g) || []).length, 1, '清单只追加一次');
        // 「图 N」编号从 1 连续、不跳号：图1-4 → 图5 → 图6-9 首尾相接
        const ranges = refOrder.split('\n').filter((l) => /^图/.test(l)).map((l) => l.match(/^图(\d+)(?:-(\d+))?/)).map((m) => [Number(m[1]), Number(m[2] || m[1])]);
        eq(ranges[0][0], 1, '清单编号从图1开始');
        ranges.slice(1).forEach((rg, i) => eq(rg[0], ranges[i][1] + 1, '清单编号连续：' + ranges[i][1] + ' → ' + rg[0]));
        eq(ranges[ranges.length - 1][1], imgs.length, '清单覆盖到真实发送的第 9 张图');
    }
    {
        // 超 maxRefs 截断：清单只列真正发送的前 N 张，并点名被截通道
        const imgs = Array.from({ length: 6 }, (_, i) => media('q' + i));
        const tb = tableNode('tb', plain('多维表格', ['提示词'], [['行一']], { inputModes: { 'input-1': 'all' } }));
        const gen = genNode('gx2', 'image');
        const doc = { nodes: [...imgs, group('grp', imgs.map((x) => x.id), { text: '产品图' }), tb, gen], edges: [edge('e1', 'grp', 'tb'), edge('e2', 'tb', 'gx2')] };
        const row = table.batchRows(doc, 'gx2')[0];
        const req = engine.buildRequest(buildStore(doc, imageSpecCap4), gen, row);
        eq(req.inputs.filter((i) => i.kind === 'image').map((i) => i.url.split('/').pop()), ['q0.jpg', 'q1.jpg', 'q2.jpg', 'q3.jpg'], 'maxRefs=4：只发前 4 张');
        const refOrder = (req.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
        ok(refOrder.includes('图1-4=输入1「产品图」第1-4张'), '清单跟着截断到图1-4，不列没发送的第 5/6 张');
        const planWarn = table.planRow('image', { model: 'm-img' }, imageSpecCap4, row).warnings;
        ok(planWarn.join(' ').includes('「产品图」6 张只发送 4 张'), '截断告警点名通道：' + planWarn.join('；'));
    }
    {
        // 视频首帧 / 尾帧角色：图1 = 首帧、图2 = 尾帧
        const imgs = Array.from({ length: 4 }, (_, i) => media('v' + i));
        const tb = tableNode('tb', plain('多维表格', ['提示词', '首帧', '尾帧'], [['镜头一', '/assets/input/v0.jpg', '/assets/input/v1.jpg']], { inputModes: { 'input-1': 'all' } }));
        const gen = genNode('gv', 'video', { params: { mode: '参考生视频', ratio: '16:9', dur: 5, res: '720p' } });
        const doc = { nodes: [...imgs, group('grp', imgs.map((x) => x.id), { text: '场景' }), tb, gen], edges: [edge('e1', 'grp', 'tb'), edge('e2', 'tb', 'gv')] };
        const row = table.batchRows(doc, 'gv')[0];
        const req = engine.buildRequest(buildStore(doc, videoSpec), gen, row);
        eq(req.inputs.filter((i) => i.kind === 'image').map((i) => i.role), ['first_frame', 'last_frame'], '视频请求图片角色 = 首帧 + 尾帧');
        const refOrder = (req.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
        ok(refOrder.includes('图1=「首帧 · 行1」'), '清单：图1 = 首帧');
        ok(refOrder.includes('图2=「尾帧 · 行1」'), '清单：图2 = 尾帧');
    }
    {
        // 生成节点自身连了图（图片批量）：清单按最终发送的 inputs 顺序编号，自身图也占号（图1=「own」）
        const imgs = Array.from({ length: 2 }, (_, i) => media('p' + i));
        const tb = tableNode('tb', plain('多维表格', ['提示词'], [['行一'], ['行二']], { inputModes: { 'input-1': 'sequence' } }));
        const own = media('own');
        const gen = genNode('gx3', 'image');
        const doc = { nodes: [...imgs, group('grp', imgs.map((x) => x.id), { text: '产品图' }), tb, own, gen], edges: [edge('e1', 'grp', 'tb'), edge('e2', 'tb', 'gx3'), edge('e3', 'own', 'gx3')] };
        const row = table.batchRows(doc, 'gx3')[0];
        const req = engine.buildRequest(buildStore(doc, imageSpec), gen, row);
        const sent = req.inputs.filter((i) => i.kind === 'image').map((i) => i.url.split('/').pop());
        const refOrder = (req.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
        eq(sent, ['own.jpg', 'p0.jpg'], '图片批量：生成节点自身的图排在行素材之前一起发送');
        eq(table.ownRefCount(doc, 'gx3', 'image'), 1, 'ownRefCount 数出 1 张生成节点自身参考图');
        ok(refOrder.includes('图1=「own」'), '清单：图1 = 节点自身参考图「own」');
        ok(refOrder.includes('图2=输入1「产品图」第1张'), '清单：图2 = 行素材第1张（与真实 inputs 顺位一致）');
        eq(refOrder.split('\n').filter((l) => /^图/.test(l)).length, 2, '清单段数 = 2（自身图 + 行素材），没有错位');

        // 自身图占 maxRefs 名额：own + 6 张产品图 + maxRefs=4 → 总发送 4 张（own + 行素材前 3 张），告警点名
        const imgs6 = Array.from({ length: 6 }, (_, i) => media('q' + i));
        const tb6 = tableNode('tb6', plain('多维表格', ['提示词'], [['行一']], { inputModes: { 'input-1': 'all' } }));
        const gen6 = genNode('gx6', 'image');
        const doc6 = { nodes: [...imgs6, group('grp', imgs6.map((x) => x.id), { text: '产品图' }), tb6, own, gen6], edges: [edge('e1', 'grp', 'tb6'), edge('e2', 'tb6', 'gx6'), edge('e3', 'own', 'gx6')] };
        const row6 = table.batchRows(doc6, 'gx6')[0];
        const req6 = engine.buildRequest(buildStore(doc6, imageSpecCap4), gen6, row6);
        const sent6 = req6.inputs.filter((i) => i.kind === 'image').map((i) => i.url.split('/').pop());
        eq(sent6, ['own.jpg', 'q0.jpg', 'q1.jpg', 'q2.jpg'], '自身图先占 1 个名额：总发送 4 张 = own + 行素材前 3 张');
        ok(sent6.length <= imageSpecCap4.maxRefs, '发送总图数不超过模型 maxRefs=4');
        const refOrder6 = (req6.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
        ok(refOrder6.includes('图1=「own」'), '限流后清单：图1 = 自身参考图');
        ok(refOrder6.includes('图2-4=输入1「产品图」第1-3张'), '限流后清单：图2-4 = 产品通道第1-3张（第 4-6 张没有发送，不列入）');
        const planWarn = table.planRow('image', {}, imageSpecCap4, row6, table.ownRefCount(doc6, 'gx6', 'image')).warnings;
        ok(planWarn.join(' ').includes('自身参考图占 1 张'), '截断告警写明自身参考图占 1 张：' + planWarn.join('；'));
        ok(planWarn.join(' ').includes('「产品图」6 张只发送 3 张'), '截断告警点名产品通道 6 张只发送 3 张');
        // 单跑行节点（frozen）：重新生成时清单编号与首次请求完全一致
        const rowNode = { id: 'rowN', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { batchOf: 'gx6', tableRow: 1, rowText: row6.text, frozen: req6 } };
        const docF = { ...doc6, nodes: [...doc6.nodes, rowNode] };
        const reqF = engine.requestForNode(buildStore(docF, imageSpecCap4), rowNode);
        eq(reqF.inputs.filter((i) => i.kind === 'image').map((i) => i.url.split('/').pop()), ['own.jpg', 'q0.jpg', 'q1.jpg', 'q2.jpg'], 'frozen 行节点重跑发送的图与首次一致');
        const refOrderF = (reqF.resolvedPrompt.match(/参考图顺序[\s\S]*/) || [''])[0];
        ok(refOrderF.includes('图1=「own」') && refOrderF.includes('图2-4=输入1「产品图」第1-3张'), 'frozen 行节点重跑的清单编号与首次一致');
        ok(!refOrderF.includes('图5'), 'frozen 清单不会多列没发送的图');
    }

    /* ================= [6] tableInputWarnings 误报 / 措辞 ================= */
    console.log('[6] tableInputWarnings：合法组号不告警、越界告警、无 sourceId 不炸、旧通道措辞');
    {
        const nodes = []; const edges = []; const imgs = [];
        for (let i = 0; i < 5; i++) { const m = media('w' + i); imgs.push(m); nodes.push(m); }
        for (let i = 0; i < 5; i++) { const g = group('wg' + i, [imgs[i].id], { text: '组' + (i + 1) }); nodes.push(g); edges.push(edge('wt' + i, g.id, 't1')); }
        const t1 = textNode('t1', '任务', { prompt: '生成' });
        const tbOk = tableNode('tbOk', plain('表', ['提示词'], [['用输入 4 的第 2 张'], ['输入 5 整组']], { sourceId: 't1' }));
        nodes.push(t1, tbOk);
        for (let i = 0; i < 5; i++) edges.push(edge('e' + i, 'wg' + i, 'tbOk'));
        edges.push(edge('eT', 't1', 'tbOk'));
        const doc = { nodes, edges };
        eq(warningsOf(doc, 'tbOk'), [], '5 条通道 + 行文本只用「输入 4 / 输入 5」→ 不告警（合法组号不误报）');
        const tbBad = tableNode('tbBad', plain('表', ['提示词'], [['输入 6 整组'], ['输入 5 整组']], { sourceId: 't1' }));
        doc.nodes.push(tbBad);
        for (let i = 0; i < 5; i++) doc.edges.push(edge('eb' + i, 'wg' + i, 'tbBad'));
        doc.edges.push(edge('ebT', 't1', 'tbBad'));
        const badWarns = warningsOf(doc, 'tbBad');
        eq(badWarns.length, 1, '5 条通道 + 行文本「输入 6」→ 恰好一条告警');
        ok(badWarns[0].includes('「输入 6」') && badWarns[0].includes('只有 5 条输入通道'), '越界告警点名输入 6：' + badWarns[0]);
        const tbNo = tableNode('tbNo', plain('表', ['提示词'], [['随便写']]));
        doc.nodes.push(tbNo);
        eq(warningsOf(doc, 'tbNo'), [], '没有 sourceId、没有通道、行文本不提输入 → 不告警也不炸');
        const tbNo2 = tableNode('tbNo2', plain('表', ['提示词'], [['参考输入 1']]));
        doc.nodes.push(tbNo2);
        eq(warningsOf(doc, 'tbNo2').length, 1, '没有 sourceId 但行文本提「输入 1」→ 只给「组号过期」一条，不炸');
        const hand = media('handOnly');
        doc.nodes.push(hand); doc.edges.push(edge('eh', 'handOnly', 'tbOk'));
        const extraWarns = warningsOf(doc, 'tbOk');
        eq(extraWarns.length, 1, '多一条手连通道 → 一条旧通道告警');
        ok(extraWarns[0].includes('已排在最后') && extraWarns[0].includes('不需要可以删掉'), '旧通道措辞不吓人、给出路：' + extraWarns[0]);
        ok(!/错误|失败|异常/.test(extraWarns[0]), '旧通道告警不含「错误 / 失败 / 异常」等吓人措辞');
    }

    /* ================= [7] caps 的 ref_max ================= */
    console.log('[7] caps：ref_max / video_ref_max / audio_ref_max / 合并顺序');
    eq(caps.modelCapsUi('image', { ref_max: 14 }).maxRefs, 14, 'ref_max=14 → maxRefs=14');
    ok(!('maxRefs' in caps.modelCapsUi('image', { ratios: ['1:1'] })), '没有 ref_max → 不写 maxRefs（留给名字预设兜底）');
    eq(caps.modelCapsUi('image', { ref_max: 0 }).maxRefs, 0, 'ref_max=0 保留 0（不合法成 fallback）');
    eq(caps.modelCapsUi('image', { ref_max: '  ', maxRefs: 3 }).maxRefs, 3, 'ref_max 是空白串 → 回落旧字段 maxRefs');
    eq(caps.modelCapsUi('video', { ref_max: 30, video_ref_max: 10, audio_ref_max: 10, modes: ['text_to_video'] }).maxRefs, 30, 'seedance 风格 caps（ref_max 30 / video_ref_max 10）→ 图片参考上限 30');
    eq(caps.modelCapsUi('video', { video_ref_max: 10 }).maxRefs, 10, '视频没有 ref_max 时回落 video_ref_max');
    eq(caps.modelCapsUi('video', { max_refs: 3 }).maxRefs, 3, '视频最后回落 max_refs');
    eq(caps.modelCapsUi('audio', { audio_ref_max: 7 }).maxRefs, 7, '音频 audio_ref_max → maxRefs');
    eq(caps.mergeCapsReferenceCapability('image', caps.modelCapsUi('image', { ref_max: 14 }), { maxRefs: 20, i2i: true, refNote: 'x' }).maxRefs, 14, 'caps 的 14 不会被 officialImageUi 的 20 覆盖');
    eq(caps.mergeCapsReferenceCapability('image', caps.modelCapsUi('image', { ratios: ['1:1'] }), { maxRefs: 20, i2i: true }).maxRefs, 20, 'caps 没给 ref_max 时 officialImageUi 的 20 照常生效');
    const guessed = model.specFor({ configId: 'p::seedream-5.0', label: 'seedream-5.0', vendor: 'p', kind: 'image', ui: null });
    eq(guessed.maxRefs, 14, '名字预设（seedream）maxRefs=14');
    eq(caps.mergeCapsReferenceCapability('image', caps.modelCapsUi('image', { ratios: ['1:1'], resolutions: ['2K'] }), { ...guessed }).maxRefs, 14, 'caps 只有参数没有 ref_max → 合并后回落到名字预设 14');
    const backendSrc = readSrc('novai-canvas-ui/src/novaiBackend.ts');
    ok(backendSrc.includes('mergeCapsReferenceCapability(kind, capsUi, { ...guessed, ...(official || {}) })'), 'novaiBackend 的合并顺序：官方/预设在前、caps 优先不被覆盖');
    // 音频 caps 接线（上一轮报的「audio 永远传 null」已修）
    eq(caps.modelCapsUi('audio', { audio_ref_max: 0 }).maxRefs, 0, '音频 audio_ref_max=0 保留 0');
    eq(caps.mergeCapsReferenceCapability('audio', caps.modelCapsUi('audio', { audio_ref_max: 0 }), { maxRefs: 4 }).maxRefs, 0, '音频 caps 的 0 不会被预设 4 覆盖');
    eq(caps.mergeCapsReferenceCapability('audio', caps.modelCapsUi('audio', { durations: [5] }), { maxRefs: 4 }).maxRefs, 4, '音频 caps 没给 audio_ref_max → 回落预设 maxRefs');
    ok(backendSrc.includes('const hasCaps = kind === "image" || kind === "video" || kind === "audio"'), 'novaiBackend 的 caps 查找覆盖 image / video / audio');
    ok(backendSrc.includes('modelCapsUi("audio", capsItem)'), 'novaiBackend.listModels 对 audio 也调 modelCapsUi（audio_ref_max 已接线）');

    /* ================= [8] 构建产物 / 接线（只读核对，不重新构建） ================= */
    console.log('[8] 构建产物与接线');
    {
        const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        eq(version, '2.0.07', 'VERSION = 2.0.07');
        const built = fs.readFileSync(path.join(root, 'static/novai-canvas/canvas.js'), 'utf8');
        ['参考图顺序', 'inputModesAuto', '不在这次提示词组里的输入通道', '上一次的规划不是合法 JSON', '规划没解析出来，重试一次', '只发送', '整组（第', '自身参考图占', '名额已被生成节点自身的参考图占满'].forEach((needle) => {
            ok(built.includes(needle), 'canvas.js 含新逻辑串「' + needle + '」');
        });
        const indexHtml = fs.readFileSync(path.join(root, 'static/novai-canvas/index.html'), 'utf8');
        const assets = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/static/novai-canvas/'));
        eq(assets.length, 3, 'index.html 引用 canvas.js + vendor chunk + canvas.css');
        assets.forEach((u) => ok(fs.existsSync(path.join(root, u.replace('/static/', 'static/'))), '产物存在：' + u));
        const canvasHtml = fs.readFileSync(path.join(root, 'static/canvas.html'), 'utf8');
        const versions = [...canvasHtml.matchAll(/\?v=([^"'&]+)/g)].map((m) => m[1]);
        ok(versions.length >= 5, 'canvas.html 的资源都带 ?v=（' + versions.length + ' 处）');
        versions.forEach((v) => ok(v.startsWith(version + '.'), '?v= 前缀 = VERSION（' + v + '）'));
        const canvasJsVer = (canvasHtml.match(/novai-canvas\/canvas\.js\?v=([^"']+)/) || [])[1];
        const canvasCssVer = (canvasHtml.match(/novai-canvas\/canvas\.css\?v=([^"']+)/) || [])[1];
        ok(!!canvasJsVer && canvasJsVer.startsWith(version + '.'), 'canvas.js 的 ?v= 已刷新到 ' + canvasJsVer);
        ok(!!canvasCssVer && canvasCssVer.startsWith(version + '.'), 'canvas.css 的 ?v= 已刷新到 ' + canvasCssVer);
        eq(canvasJsVer, canvasCssVer, 'canvas.js / canvas.css 打同一个版本号');
    }
    {
        const tableSrc = readSrc('novai-canvas-ui/src/canvas/canvas-next/table.ts');
        ['inferChannelModesFromRows', 'groupMembersDeep', 'inputModesAuto', 'refOrderText', 'tableInputWarnings', 'batchInputWarnings', 'cutDetail'].forEach((needle) => ok(tableSrc.includes(needle), 'table.ts 含 ' + needle));
        const engineSrc = readSrc('novai-canvas-ui/src/canvas/canvas-next/engine.ts');
        ['planRepairPrompt', 'pinSourceOrder', 'inferChannelModesFromRows', 'refOrderText', 'tableInputWarnings', 'perRowRowCount(needChannels'].forEach((needle) => ok(engineSrc.includes(needle), 'engine.ts 含 ' + needle));
        const genPanelSrc = readSrc('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
        ok(genPanelSrc.includes('batchInputWarnings'), 'GenPanel 常驻显示表格输入告警');
        const css = readSrc('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
        ok(css.includes('.trefwarn'), 'CSS 有表格告警条样式 .trefwarn');
        ok(css.includes('.gp-warn'), 'CSS 有面板告警样式 .gp-warn');
    }

    /* ================= 汇总 ================= */
    console.log('\n[VERIFY] 严格断言通过 ' + pass + ' 组；已知问题 ' + known.length + ' 条（不阻塞套件，详见验证报告）');
    known.forEach((k, i) => console.log('  ' + (i + 1) + ') ' + k.id));
    console.log('[PASS] 多维表格多参考图独立验证（对抗性）：编号 / 行数 / 用户模式 / refOrder / 告警 / caps / 产物');
})().catch((err) => { console.error(err); process.exit(1); });
