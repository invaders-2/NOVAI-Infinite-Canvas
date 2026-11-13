#!/usr/bin/env node
'use strict';
/*
 * 智能画布BEAT（canvas-next）多维表格的输入通道：
 *   一个上游素材来源（分组 / 堆叠 / 单个素材节点）= 一条通道 = 一列「输入 N」，
 *   每条通道各有模式（逐行 / 全部 / 沿用），逐行取该通道的 items；
 *   组里的图只进通道、不写进数据列；下游 batchRows 按通道汇总并做 Df 去重。
 * 对齐旧版 static/js/shared/table-node.js（Co / ab / Pu / Df）与 table-model.js（normalizeChannels / inputItemsForRow）。
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
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

/* ---------- 文档构造 ---------- */
const media = (id, kind, url, pos = {}) => ({
    id, kind, x: pos.x || 0, y: pos.y || 0, w: 200, h: 200, text: '', url,
    data: { gen: { title: id, prompt: '', params: {}, order: [], hi: 0, hist: [kind === 'video' ? { url, frame: url + '.poster.jpg' } : { url }] } },
});
const empty = (id, kind) => ({ id, kind, x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: id, prompt: '', params: {}, hist: [], hi: 0, order: [] } } });
const textNode = (id, title, extra = {}) => ({ id, kind: 'text', x: 0, y: 0, w: 280, h: 200, text: '', data: { gen: { title, prompt: extra.prompt || '', params: { output: extra.output || 'table', model: 'm-text' }, hist: [{ text: '正文' }], hi: 0, order: [] } } });
const group = (id, children, extra = {}) => ({ id, kind: 'group', x: 0, y: 0, w: 300, h: 300, text: extra.text || '分组', children, ...(extra.data ? { data: extra.data } : {}) });
const stack = (id, children) => ({ id, kind: 'group', x: 0, y: 0, w: 260, h: 260, text: '堆叠', children, data: { stack: true } });
const tableNode = (id, t, extra = {}) => ({ id, kind: 'table', x: 0, y: 0, w: 400, h: 300, text: t.title, data: { table: t, gen: { title: t.title, prompt: '', params: {}, hist: [], hi: 0, order: extra.order || [] } } });
const edge = (id, from, to) => ({ id, from, to });
const plain = (title, columns, rows, extra = {}) => ({ kind: 'table', version: 1, title, columns, rows, ...extra });

/* ---------- [1] 素材地址识别 ---------- */
console.log('[1] isMediaRef 规则');
['/assets/a.jpg', '/assets/input/ai_ref_a2e672f2a390.jpg', '/output/b.png', '/output/ai/c.mp4',
    'openarc-asset:abc', 'openarc-resource:def', 'https://x/y.png', 'http://x/y.mp4?t=1',
    'data:image/png;base64,xx', 'data:video/mp4;base64,xx', 'data:audio/mpeg;base64,xx',
    'blob:https://x/9a8b', './d.webp', 'ref.mp3'].forEach((u) => ok(table.isMediaRef(u), 'isMediaRef 应该认「' + u + '」'));
['以 @图片1 作为首帧', '棕色荔枝纹皮面', '', '   ', 'http://example.com/page', '镜头 3：推近，人物转头',
    '把 a.jpg 换成 b.png', 'output/b.png 放在第一行'].forEach((s) => ok(!table.isMediaRef(s), 'isMediaRef 不该认「' + s + '」'));

/* ---------- [2] 一个分组 + 一个堆叠 + 一张单图 = 3 条通道 ---------- */
console.log('[2] tableChannels 一个来源一条通道');
const g1 = media('g1', 'image', '/assets/input/g1.jpg', { x: 0, y: 120 });
const g2 = media('g2', 'image', '/assets/input/g2.jpg', { x: 0, y: 0 });
const s1 = media('s1', 'image', '/assets/input/s1.jpg');
const sv = media('sv', 'video', '/output/sv.mp4');
const single = media('single', 'image', '/assets/input/single.jpg');
const txt = textNode('txt1', '分镜要求');
const doc = {
    nodes: [g1, g2, s1, sv, single, txt,
        group('grp', ['g1', 'g2'], { text: '参考图' }), stack('stk', ['s1', 'sv']),
        tableNode('tb1', plain('多维表格', ['提示词'], [['镜头一']]), { order: ['e1', 'e2', 'e3', 'e4'] })],
    edges: [edge('e1', 'grp', 'tb1'), edge('e2', 'stk', 'tb1'), edge('e3', 'single', 'tb1'), edge('e4', 'txt1', 'tb1')],
};
const chs = table.tableChannels(doc, 'tb1');
eq(chs.map((c) => c.id), ['input-1', 'input-2', 'input-3'], '三个素材来源 = 三条通道，编号 input-1..3');
eq(chs.map((c) => c.sourceId), ['grp', 'stk', 'single'], '通道顺序按连线顺序');
eq(chs[0].items.map((x) => x.nodeId), ['g2', 'g1'], '分组内按画布位置（y/x）');
eq(chs[1].items.map((x) => x.nodeId), ['s1', 'sv'], '堆叠按叠内顺序（图、视频都算素材）');
eq(chs[1].items.map((x) => x.kind), ['image', 'video'], '素材种类要保住');
eq(chs[1].items[1].src, '/output/sv.mp4.poster.jpg', '视频用封面帧当缩略图');
eq(chs[0].mode, 'shared', '没有被出表写过的通道默认沿用');
ok(!chs.some((c) => c.sourceId === 'txt1'), '文本节点不进输入通道（走提示词上下文）');
// 还没有结果的来源也保留一列（表头数量显示 0）
const grpEmpty = { id: 'grp2', kind: 'group', x: 0, y: 0, w: 300, h: 300, text: '分组', children: ['i9'] };
const docEmpty = { nodes: [empty('i9', 'image'), grpEmpty, tableNode('tb2', plain('多维表格', ['提示词'], [['a']]))], edges: [edge('f1', 'grp2', 'tb2')] };
const chEmpty = table.tableChannels(docEmpty, 'tb2');
eq(chEmpty.length, 1, '没有结果的来源也保留一列');
eq(chEmpty[0].items.length, 0, '组里还没有结果 → 这条通道 0 个素材（表头显示 0）');
// 一个可当素材的上游都没有 → 没有输入列
eq(table.tableChannels({ nodes: [txt, tableNode('tb3', plain('多维表格', ['提示词'], [['a']]))], edges: [edge('h1', 'txt1', 'tb3')] }, 'tb3').length, 0, '只有文本上游时不显示输入列');

/* ---------- [3] 生成表的 sourceId 继承分支 ---------- */
console.log('[3] 生成表的文本节点继承分支');
const b1 = media('b1', 'image', '/assets/input/b1.jpg', { x: 100, y: 200 });
const b2 = media('b2', 'image', '/assets/input/b2.jpg', { x: 0, y: 50 });
const v1 = media('v1', 'video', '/output/v1.mp4');
const t1 = textNode('t1', '分镜表');
const tb2 = tableNode('tb2', plain('分镜表', ['画面'], [['镜头一']], { sourceId: 't1' }));
const doc2 = {
    nodes: [b1, b2, v1, t1, group('g2', ['b1', 'b2']), stack('s2', ['v1']), media('i5', 'image', '/assets/input/i5.jpg'), tb2],
    edges: [edge('x1', 'g2', 't1'), edge('x2', 's2', 't1'), edge('x3', 'i5', 't1'), edge('x4', 't1', 'tb2')],
};
const chInherit = table.tableChannels(doc2, 'tb2');
eq(chInherit.length, 3, '旧文档 / 没有直连时按 sourceId 继承，同样是 3 条通道');
eq(chInherit.map((c) => c.sourceId), ['g2', 's2', 'i5'], '继承分支的通道顺序 = 文本节点的上游顺序');
eq(chInherit[0].items.map((x) => x.nodeId), ['b2', 'b1'], '继承分支里分组仍按画布位置排序');
// 旧字段 inputMode 只映射第一通道；新字段 inputModes 优先，脏值丢弃
const legacyChart = (inputMode, inputModes) => {
    const t = plain('表', ['提示词'], [['a']], { ...(inputMode ? { inputMode } : {}), ...(inputModes ? { inputModes } : {}) });
    return table.tableChannels({ nodes: [media('q1', 'image', '/assets/q1.jpg'), tableNode('tq', t)], edges: [edge('q', 'q1', 'tq')] }, 'tq')[0].mode;
};
eq(legacyChart('sequence'), 'sequence', '旧字段 inputMode=sequence 映射到第一通道');
eq(legacyChart('pair'), 'shared', '旧字段 pair 视为沿用');
eq(legacyChart('auto'), 'shared', 'auto 视为沿用');
eq(legacyChart('shared', { 'input-1': 'all' }), 'all', '新的 inputModes 优先于旧字段');
eq(legacyChart('sequence', { 'input-1': 'bogus' }), 'sequence', '脏模式值丢弃，回落到旧字段');
eq(table.CHANNEL_MODES, ['sequence', 'all', 'shared'], '表头循环顺序：逐行 → 全部 → 沿用');
eq(table.CHANNEL_MODE_LABEL, { sequence: '逐行', all: '全部', shared: '沿用' }, '模式文案');
const roundTrip = table.tableOf(tableNode('rt', plain('表', ['a'], [['x']], { inputModes: { 'input-1': 'all', 'input-2': 'bogus' } })));
eq(roundTrip.inputModes, { 'input-1': 'all' }, 'inputModes 随表格数据存下来，脏值不落盘');

/* ---------- [4] 三种模式取行 ---------- */
console.log('[4] channelItemsForRow 逐行 / 全部 / 沿用');
const mk = (mode) => ({ id: 'input-1', sourceId: 'x', title: 't', mode, items: ['a', 'b', 'c'].map((n) => ({ nodeId: n, kind: 'image', title: n, src: n, url: n })) });
const seq = mk('sequence'), allMode = mk('all'), sh = mk('shared');
eq(table.channelItemsForRow(seq, 0).map((x) => x.nodeId), ['a'], '逐行：第 1 行取第 1 个');
eq(table.channelItemsForRow(seq, 5), [], '逐行：越界为空');
eq(table.channelItemsForRow(allMode, 5).map((x) => x.nodeId), ['a', 'b', 'c'], '全部：每一行都是整列');
eq(table.channelItemsForRow(sh, 0).map((x) => x.nodeId), ['a'], '沿用：按行取');
eq(table.channelItemsForRow(sh, 9).map((x) => x.nodeId), ['c'], '沿用：超出后取最后一张');
eq(table.channelItemsForRow({ ...sh, items: [] }, 0), [], '空通道取不到素材');
// 旧版 channelModeFor() 的默认值就是「沿用」：没声明时不分图片 / 视频
eq(table.plannedChannelMode(1, []), '', '没声明 → 不写模式（读出来回落沿用）');
eq(table.plannedChannelMode(1, [{ group: 1, rowMode: 'per-row' }]), 'sequence', '声明 per-row → 逐行');
eq(table.plannedChannelMode(2, [{ group: 2, rowMode: 'every-row' }]), 'all', '声明 every-row → 全部');
eq(table.plannedChannelMode(3, [{ group: 1, rowMode: 'per-row' }]), '', '声明别的组不影响这一组');
const wide = plain('多维表格', ['提示词', '画面', '运镜', '时长'], [['a', 'b', 'c', '5s']]);
eq(table.TABLE_INPUT_COL_W, 112, '输入列宽 112（对齐旧版 .table-input-column）');
eq(table.tableAutoSize(wide, 2).w - table.tableAutoSize(wide, 0).w, 2 * table.TABLE_INPUT_COL_W, '宽度按通道数预留：每条通道 112px');
// 多通道 + 多列会超过旧上限 800，现在要能算到 1600 以内
const fiveCols = plain('多维表格', ['镜头', '画面', '运镜', '时长', '台词'], [['1', '推近', '前推', '5s', '你']]);
eq(table.tableAutoSize(fiveCols, 3).w, 3 * 112 + 5 * 132 + 36, '3 条通道 + 5 列 = 1032，不再被 800 截断');
const huge = plain('多维表格', Array.from({ length: 8 }, (_, i) => '列' + i), [Array.from({ length: 8 }, () => 'x')]);
eq(table.tableAutoSize(huge, 12).w, 1600, '宽度封顶 1600');
// 节点持久化：sanitizeDoc 只给 table 放宽到 1600，其它节点仍 800
const schema = load('novai-canvas-ui/src/canvas/react-canvas/reactCanvasStore.ts');
const cleaned = schema.sanitizeDoc({
    nodes: [{ id: 'tb', kind: 'table', x: 0, y: 0, w: 1400, h: 300, text: '' }, { id: 'im', kind: 'image', x: 0, y: 0, w: 1400, h: 300, text: '' }],
    edges: [],
});
eq(cleaned.nodes.find((n) => n.id === 'tb').w, 1400, '表格节点宽度不再被 800 截断');
eq(cleaned.nodes.find((n) => n.id === 'im').w, 800, '其它节点仍按 800 收口');
eq(schema.sanitizeDoc({ nodes: [{ id: 'tb2', kind: 'table', x: 0, y: 0, w: 5000, h: 300, text: '' }], edges: [] }).nodes[0].w, 1600, '表格宽度封顶 1600');
eq(schema.sanitizeOp({ type: 'update-node', id: 'tb', patch: { w: 1400 } }).patch.w, 1400, 'update-node 操作里表格宽度不被 800 卡');

/* ---------- [5][6] LLM 出表：素材来源直连成一列，inputModes 按任务写 ---------- */
console.log('[5] runTextToTable 连出输入通道');
class FakeStore {
    constructor(doc, spec) { this.state = { doc, canvasId: 'c1', runtime: {} }; this.spec = spec; this.toasts = []; }
    node(id) { return this.state.doc.nodes.find((n) => n.id === id); }
    modelOf() { return this.spec; }
    setRun() {} patchRun() {}
    toast(s) { this.toasts.push(s); }
    logRun() {}
    snapshot() {}
    patchGen(id, patch) { this.updateNode(id, (n) => { const gen = { ...((n.data || {}).gen || {}) }; Object.assign(gen, typeof patch === 'function' ? patch(gen) : patch); return { ...n, data: { ...(n.data || {}), gen } }; }); }
    updateNode(id, fn) { this.state = { ...this.state, doc: { ...this.state.doc, nodes: this.state.doc.nodes.map((n) => (n.id === id ? fn(n) : n)) } }; }
    addNodes(nodes, edges = []) { this.state = { ...this.state, doc: { ...this.state.doc, nodes: [...this.state.doc.nodes, ...nodes], edges: [...this.state.doc.edges, ...edges] } }; }
    // replies 按调用顺序返回；记录每次发出的 prompt，补行修复要靠它断言
    backendFor(...replies) {
        const queue = replies.length ? [...replies] : [''];
        const prompts = [];
        return {
            prompts,
            generate: async (req) => {
                prompts.push(String(req && req.resolvedPrompt || ''));
                const text = queue.length > 1 ? queue.shift() : queue[0];
                return { outputs: [{ text }] };
            },
        };
    }
}
const textSpec = { id: 'm-text', name: '文本模型', vendor: '', tags: [], kind: 'text', secs: 6, vision: true, search: true };
const tableJson = JSON.stringify({ kind: 'table', version: 1, columns: ['镜头', '画面'], rows: [['1', '推近'], ['2', '拉远']] });
const runToTable = async (docIn, output, replies = [tableJson]) => {
    const store = new FakeStore({ ...docIn, comments: [] }, textSpec);
    store.backend = store.backendFor(...replies);
    if (output) { const node = store.node('t1'); node.data.gen.params = { ...node.data.gen.params, output }; }
    const okRun = await engine.runTextToTable(store, 't1');
    ok(okRun, '出表成功');
    return store.state.doc;
};

(async () => {
    const m1 = media('m1', 'image', '/assets/input/m1.jpg');
    const m2 = media('m2', 'image', '/assets/input/m2.jpg');
    const m3 = media('m3', 'image', '/assets/input/m3.jpg');
    const tn = textNode('t1', '商品图', { prompt: '做一套商品图', output: 'table' });
    const groupNode = group('grp', ['m1', 'm2'], { text: '参考图' });
    const docIn = { nodes: [m1, m2, m3, tn, groupNode], edges: [edge('a1', 'grp', 't1'), edge('a2', 'm3', 't1')] };
    const outDoc = await runToTable(docIn);
    const tbl = outDoc.nodes.find((n) => n.kind === 'table');
    ok(tbl, '出表后画布上有表格节点');
    eq(outDoc.edges.filter((e) => e.to === tbl.id).map((e) => e.from), ['t1', 'grp', 'm3'], '出表新增边：文本节点 + 每个素材来源（分组 / 单图）直接连到表格');
    eq(outDoc.nodes.filter((n) => n.kind === 'table').length, 1, '只建一张表');
    const channels = table.tableChannels(outDoc, tbl.id);
    eq(channels.map((c) => c.sourceId), ['grp', 'm3'], '表格的入边 → 两条输入通道');
    eq(channels[0].items.map((x) => x.nodeId), ['m1', 'm2'], '组里的两张图只进通道');
    const tdata = table.tableOf(tbl);
    eq(tdata.rows.map((r) => r.join('|')), ['1|推近', '2|拉远'], 'rows 只写文字列');
    ok(!JSON.stringify(tdata.rows).includes('/assets/'), 'LLM 出表不再把 /assets 路径灌进数据列');
    eq(tdata.columns, ['镜头', '画面'], '不追加图片列');
    eq(tdata.inputModes, undefined, '模型没声明 inputGroups → 不写 inputModes（读出来回落沿用）');
    eq(table.tableChannels(outDoc, tbl.id).map((c) => c.mode), ['shared', 'shared'], '默认模式是沿用，不再按图片 / 视频意图猜');

    // 重复出表：不重复连边，模式仍然写对
    const store2 = new FakeStore(outDoc, textSpec); store2.backend = store2.backendFor(tableJson);
    ok(await engine.runTextToTable(store2, 't1'), '第二次出表成功');
    const tbl2 = store2.state.doc.nodes.find((n) => n.kind === 'table');
    eq(store2.state.doc.edges.filter((e) => e.to === tbl2.id).map((e) => e.from), ['t1', 'grp', 'm3'], '重复出表不会重复连边');

    /* [6] 分镜表：默认同样是「沿用」（不声明就不写 inputModes） */
    console.log('[6] 分镜表的默认模式');
    const sb1 = media('sb1', 'image', '/assets/input/sb1.jpg');
    const sb2 = media('sb2', 'image', '/assets/input/sb2.jpg');
    const tn2 = textNode('t1', '分镜表', { prompt: '分镜', output: 'storyboard' });
    const outSb = await runToTable({ nodes: [sb1, sb2, tn2, group('grp', ['sb1', 'sb2'])], edges: [edge('k1', 'grp', 't1')] }, 'storyboard');
    const tblSb = outSb.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblSb).inputModes, undefined, '分镜表没声明也不写模式');
    eq(table.tableChannels(outSb, tblSb.id).map((c) => c.mode), ['shared'], '分镜表默认沿用');

    /* ---------- [7] batchRows：通道取行 + Df 去重 ---------- */
    console.log('[7] batchRows 按通道取行');
    const ga = media('ga', 'image', '/assets/input/ga.jpg');
    const gb = media('gb', 'image', '/assets/input/gb.jpg');
    const single2 = media('single2', 'image', '/assets/input/single2.jpg');
    const tx = textNode('t0', '任务');
    const tableData = plain('多维表格', ['提示词', '参考图'], [['镜头一', '/assets/input/ga.jpg'], ['镜头二', '']], { inputModes: { 'input-1': 'sequence', 'input-2': 'shared' } });
    const docBatch = {
        nodes: [ga, gb, single2, tx, group('grp', ['ga', 'gb']), tableNode('tb', tableData), { id: 'gx', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: '批量', prompt: '', params: {}, hist: [], hi: 0, order: [] } } }],
        edges: [edge('b1', 'grp', 'tb'), edge('b2', 'single2', 'tb'), edge('b3', 'tb', 'gx')],
    };
    const rows = table.batchRows(docBatch, 'gx');
    eq(rows[0].media.map((x) => x.url), ['/assets/input/ga.jpg', '/assets/input/single2.jpg'], '第 1 行 = 逐行通道第 1 张 + 沿用通道那张；同一张图不重复');
    eq(rows[0].media[0].as, 'ref', '数据列手动图与通道同图时保留带 as 的那条');
    eq(rows[1].media.map((x) => x.url), ['/assets/input/gb.jpg', '/assets/input/single2.jpg'], '第 2 行 = 逐行通道第 2 张 + 沿用通道仍是那张');
    eq(rows[0].text.split('\n')[0], '提示词：镜头一', '数据列文字仍进该行提示词');

    // 全部模式的通道：每行都带整列
    const allTable = plain('多维表格', ['提示词'], [['一'], ['二']], { inputModes: { 'input-1': 'all' } });
    const docAll = { nodes: [ga, gb, group('grp', ['ga', 'gb']), tableNode('tb', allTable), { id: 'gx', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: '批量', prompt: '', params: {}, hist: [], hi: 0, order: [] } } }], edges: [edge('c1', 'grp', 'tb'), edge('c2', 'tb', 'gx')] };
    eq(table.batchRows(docAll, 'gx')[1].media.map((x) => x.url), ['/assets/input/ga.jpg', '/assets/input/gb.jpg'], '全部模式每行带整列');

    // 首帧 / 尾帧单元格同 url 的两个角色都要留
    const vt = plain('多维表格', ['提示词', '首帧', '尾帧'], [['镜头一', '/assets/f.jpg', '/assets/l.jpg']]);
    const docV = { nodes: [media('vf', 'image', '/assets/f.jpg'), tableNode('tb', vt), { id: 'gv', kind: 'video', x: 0, y: 0, w: 320, h: 180, text: '', data: { gen: { title: '视频', prompt: '', params: {}, hist: [], hi: 0, order: [] } } }], edges: [edge('v1', 'vf', 'tb'), edge('v2', 'tb', 'gv')] };
    const vr = table.batchRows(docV, 'gv')[0];
    eq(vr.media.map((x) => x.as), ['first', 'last'], '首帧 / 尾帧角色都在');
    eq(vr.media.map((x) => x.url), ['/assets/f.jpg', '/assets/l.jpg'], '同图只出现一次，没有重复 url');

    /* ---------- [8] 出表按 inputGroups 规划 + 行数对齐 ---------- */
    console.log('[8] inputGroups 规划与补行');
    const ask = table.tablePrompt('任务', 'table', 7, [{ name: '静物图', count: 3 }, { name: '白底多角度', count: 4 }]);
    ok(ask.includes('inputGroups'), '提示词里有 inputGroups 契约');
    ok(ask.includes('per-row') && ask.includes('every-row'), '提示词里解释 per-row / every-row');
    ok(ask.includes('第 1 组（输入 1）「静物图」3 张') && ask.includes('第 2 组（输入 2）「白底多角度」4 张'), '提示词列出每组编号 / 组名 / 张数');
    ok(ask.includes('默认「沿用」') && ask.includes('沿用最后一张'), '提示词写明默认沿用（每行取一张、超出沿用最后一张）');
    ok(ask.includes('不要为了保险') && ask.includes('都声明成 every-row'), '提示词说明 every-row 不要滥用');
    ok(ask.includes('表格行数按用户要求确定') && ask.includes('只有实在判断不了时才用素材最多那组的张数'), '提示词写明行数按用户要求（逐行组张数），不再只看素材最多那组');
    eq(table.parseInputGroups([{ group: 1, rowMode: 'per_row' }, { group: '2', rowMode: 'every-row' }, { group: 0, rowMode: 'per-row' }, { group: 3, rowMode: 'bogus' }]),
        [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }], 'inputGroups 解析：组号从 1、兼容下划线写法、脏值丢弃');
    const chOf = (mode, n) => ({ id: 'input-1', sourceId: 's', title: 't', mode, items: Array.from({ length: n }, (_, i) => ({ nodeId: 'n' + i, kind: 'image', title: 't', src: '/assets/n' + i + '.jpg', url: '/assets/n' + i + '.jpg' })) });
    // 行数只由 per-row 的组决定（沿用 / 全部都不算）
    eq(table.perRowRowCount([chOf('sequence', 2), chOf('all', 5)], [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }]), 2, '行数 = per-row 组张数（every-row 5 张不参与）');
    eq(table.perRowRowCount([chOf('sequence', 2), chOf('sequence', 4)], [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'per-row' }]), 4, '多个 per-row 组取最大张数');
    eq(table.perRowRowCount([chOf('shared', 5), chOf('all', 3)], []), 0, '没有 per-row 组 → N = 0（不补不裁）');
    eq(table.perRowRowCount([chOf('shared', 5)], [{ group: 2, rowMode: 'per-row' }]), 0, 'plan 组号和通道对不上 → 0');
    eq(table.trimTableRows(plain('t', ['a'], [['1'], ['2'], ['3'], ['4'], ['5']]), 2).rows.length, 2, '超出 N 裁到 N 行');
    eq(table.trimTableRows(plain('t', ['a'], [['1'], ['2']]), 0).rows.length, 2, 'N = 0 时不裁');
    eq(table.trimTableRows(plain('t', ['a'], [['1']]), 2).rows.length, 1, '不足 N 时 trim 不动');
    eq(table.plannedChannelMode(1, [{ group: 1, rowMode: 'per-row' }]), 'sequence', 'per-row → 逐行');
    eq(table.plannedChannelMode(2, [{ group: 2, rowMode: 'every-row' }]), 'all', 'every-row → 全部');
    eq(table.plannedChannelMode(1, []), '', '没声明 → 不写模式（回落沿用）');
    eq(table.inputCellShown(12), 9, '超过 9 张才折叠');
    ok(table.inputCellHeight(5) > table.inputCellHeight(2), '素材越多行越高');
    ok(table.inputCellHeight(5) > 84, '5 张不再挤在 84px 固定行高里');

    // 模型声明 inputGroups → 通道模式照它（per-row / every-row 各一条）
    const mkGroupNodes = (prefix, n) => Array.from({ length: n }, (_, i) => media(prefix + i, 'image', '/assets/input/' + prefix + i + '.jpg'));
    const perRowNodes = mkGroupNodes('pr', 2), everyNodes = mkGroupNodes('ev', 5);
    const tn9 = textNode('t1', '商品图', { prompt: '按参考图出图', output: 'table' });
    const planJson = JSON.stringify({
        kind: 'table', version: 1,
        inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }],
        columns: ['画面'], rows: [['第 1 张'], ['第 2 张']],
    });
    const out9 = await runToTable({
        nodes: [...perRowNodes, ...everyNodes, tn9, group('gA', perRowNodes.map((n) => n.id), { text: '静物图' }), group('gB', everyNodes.map((n) => n.id), { text: '白底多角度' })],
        edges: [edge('p1', 'gA', 't1'), edge('p2', 'gB', 't1')],
    }, 'table', [planJson]);
    const tbl9 = out9.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tbl9).inputModes, { 'input-1': 'sequence', 'input-2': 'all' }, '模型声明 per-row / every-row → 通道逐行 / 全部');
    eq(table.tableOf(tbl9).rows.length, 2, '行数够（= per-row 张数）时不补行');

    // 老板截图场景：输入 1 两张 + 输入 2 五张，模型不声明 inputGroups → 默认沿用，5 行、每行两张
    const sharedJson = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['1'], ['2'], ['3'], ['4'], ['5']] });
    const storeS = new FakeStore({
        nodes: [...perRowNodes, ...everyNodes, textNode('t1', '商品图', { prompt: '按参考图出图' }),
            group('gA', perRowNodes.map((n) => n.id), { text: '静物图' }), group('gB', everyNodes.map((n) => n.id), { text: '白底多角度' })],
        edges: [edge('p1', 'gA', 't1'), edge('p2', 'gB', 't1')], comments: [],
    }, textSpec);
    storeS.backend = storeS.backendFor(sharedJson);
    ok(await engine.runTextToTable(storeS, 't1'), '默认沿用也能出表');
    const tblS = storeS.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblS).rows.length, 5, '默认沿用：行数 = 素材最多那组的张数（5）');
    eq(table.tableOf(tblS).inputModes, undefined, '没声明就不写 inputModes（默认值不会被锁死）');
    eq(table.tableChannels(storeS.state.doc, tblS.id).map((c) => c.mode), ['shared', 'shared'], '两条通道都是沿用');
    const gxS = { id: 'gxS', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: '批量', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
    storeS.state = { ...storeS.state, doc: { ...storeS.state.doc, nodes: [...storeS.state.doc.nodes, gxS], edges: [...storeS.state.doc.edges, edge('t2gS', tblS.id, 'gxS')] } };
    const rowsS = table.batchRows(storeS.state.doc, 'gxS');
    eq(rowsS.map((r) => r.media.length), [2, 2, 2, 2, 2], '每行只带两张（每组各一张），不是 7 张');
    eq(rowsS[0].media.map((x) => x.url), ['/assets/input/pr0.jpg', '/assets/input/ev0.jpg'], '第 1 行取每组第 1 张');
    eq(rowsS[2].media.map((x) => x.url), ['/assets/input/pr1.jpg', '/assets/input/ev2.jpg'], '第 3 行：输入 1 只有两张 → 沿用第 2 张');

    // 重新出表：旧数据里存的「全部」被清掉，回落沿用
    const storeR = new FakeStore(out9, textSpec); storeR.backend = storeR.backendFor(sharedJson);
    ok(await engine.runTextToTable(storeR, 't1'), '重新出表成功');
    const tblR = storeR.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblR).inputModes, undefined, '重新出表会把旧的「全部」清掉');
    eq(table.tableChannels(storeR.state.doc, tblR.id).map((c) => c.mode), ['shared', 'shared'], '重出后默认沿用');

    // 模型给 5 行、逐行通道只有 2 张 → 裁到 2 行；输入 2（全部 5 张）每行照样带
    const fiveRowJson = JSON.stringify({
        kind: 'table', version: 1,
        inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }],
        columns: ['画面'], rows: [['一'], ['二'], ['三'], ['四'], ['五']],
    });
    const store5 = new FakeStore({
        nodes: [...perRowNodes, ...everyNodes, textNode('t1', '商品图', { prompt: '按参考图出图' }),
            group('gA', perRowNodes.map((n) => n.id), { text: '静物图' }), group('gB', everyNodes.map((n) => n.id), { text: '白底多角度' })],
        edges: [edge('p1', 'gA', 't1'), edge('p2', 'gB', 't1')], comments: [],
    }, textSpec);
    store5.backend = store5.backendFor(fiveRowJson);
    ok(await engine.runTextToTable(store5, 't1'), '多给行数也能出表');
    const tbl5 = store5.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tbl5).rows.length, 2, '行数只由逐行通道决定：模型给的 5 行裁到 2 行');
    ok(store5.toasts.join(' ').includes('按素材把行数对齐到 2 行'), 'toast 说明行数已按素材对齐');
    // 裁行后每行仍然带「全部」通道的 5 张
    const gx5 = { id: 'gx5', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: '批量', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
    store5.state = { ...store5.state, doc: { ...store5.state.doc, nodes: [...store5.state.doc.nodes, gx5], edges: [...store5.state.doc.edges, edge('t2g', tbl5.id, 'gx5')] } };
    const row5 = table.batchRows(store5.state.doc, 'gx5')[0];
    eq(row5.media.length, 6, '第 1 行 = 逐行通道 1 张 + 全部通道 5 张');
    eq(new Set(row5.media.map((x) => x.url)).size, 6, '行素材没有重复');

    // 只有「全部」通道 → 不补不裁，保持模型给的行数
    const everyOnlyJson = JSON.stringify({ kind: 'table', version: 1, inputGroups: [{ group: 1, rowMode: 'every-row' }], columns: ['画面'], rows: [['1'], ['2'], ['3'], ['4'], ['5']] });
    const store6 = new FakeStore({ nodes: [...everyNodes, textNode('t1', '商品图', { prompt: '每行都带整组' }), group('gE', everyNodes.map((n) => n.id), { text: '白底多角度' })], edges: [edge('e1', 'gE', 't1')], comments: [] }, textSpec);
    store6.backend = store6.backendFor(everyOnlyJson);
    ok(await engine.runTextToTable(store6, 't1'), '没有逐行通道也能出表');
    const tbl6 = store6.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tbl6).rows.length, 5, '只有全部 / 沿用通道时不动行数');
    ok(!store6.toasts.join(' ').includes('行数对齐'), '没有逐行通道时不给对齐提示');

    // 分镜表：行数 = 镜头数，永远不补不裁（哪怕通道声明成逐行）
    const sbRowsJson = JSON.stringify({ kind: 'table', version: 1, inputGroups: [{ group: 1, rowMode: 'per-row' }], columns: ['镜头', '画面'], rows: [['1', 'a'], ['2', 'b'], ['3', 'c'], ['4', 'd'], ['5', 'e']] });
    const store7 = new FakeStore({ nodes: [...perRowNodes, textNode('t1', '分镜表', { prompt: '分镜' }), group('gS', perRowNodes.map((n) => n.id), { text: '静物图' })], edges: [edge('f1', 'gS', 't1')], comments: [] }, textSpec);
    store7.backend = store7.backendFor(sbRowsJson);
    { const sn = store7.node('t1'); sn.data.gen.params = { ...sn.data.gen.params, output: 'storyboard' }; }
    ok(await engine.runTextToTable(store7, 't1'), '分镜表出表成功');
    const tbl7 = store7.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tbl7).rows.length, 5, '分镜表行数 = 镜头数，不被逐行通道张数裁掉');
    ok(!store7.toasts.join(' ').includes('行数对齐'), '分镜表不给行数对齐提示');

    // 行数不足：先发一次补行修复，修好后行数 = N
    const threeNodes = mkGroupNodes('r3', 3);
    const shortJson = JSON.stringify({ kind: 'table', version: 1, inputGroups: [{ group: 1, rowMode: 'per-row' }], columns: ['画面'], rows: [['一'], ['二']] });
    const fixedJson = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['一'], ['二'], ['三']] });
    const plan3Json = JSON.stringify({ rowCount: 3, inputGroups: [{ group: 1, rowMode: 'per-row' }] });
    const store3 = new FakeStore({ nodes: [...threeNodes, textNode('t1', '商品图', { prompt: '逐张出图' }), group('gC', threeNodes.map((n) => n.id), { text: '静物图' })], edges: [edge('q1', 'gC', 't1')], comments: [] }, textSpec);
    store3.backend = store3.backendFor(plan3Json, shortJson, fixedJson);
    ok(await engine.runTextToTable(store3, 't1'), '行数不足时出表仍成功');
    const tbl10 = store3.state.doc.nodes.find((n) => n.kind === 'table');
    eq(store3.backend.prompts.length, 3, '规划 + 生成 + 一次补行修复');
    ok(store3.backend.prompts[2].includes('行数不足：素材共 3 张'), '补行提示词写明素材张数');
    eq(table.tableOf(tbl10).rows.length, 3, '修复后行数 = 素材张数');
    ok(!store3.toasts.join(' ').includes('已按素材补到'), '模型补齐时不提示手动补行');

    // 修复仍不足 → 补空行到 N，并提示手动补
    const store4 = new FakeStore({ nodes: [...threeNodes, textNode('t1', '商品图', { prompt: '逐张出图' }), group('gD', threeNodes.map((n) => n.id))], edges: [edge('s1', 'gD', 't1')], comments: [] }, textSpec);
    store4.backend = store4.backendFor(plan3Json, shortJson, shortJson);
    ok(await engine.runTextToTable(store4, 't1'), '修复没补齐也能出表');
    const tbl11 = store4.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tbl11).rows.length, 3, '修复失败 → 按素材补空行到 3 行');
    ok(store4.toasts.join(' ').includes('已按素材补到 3 行，空的提示词列请手动补'), 'toast 说明已按素材补行');

    /* ---------- [8b] 规划遍（产品替换） ---------- */
    console.log('[8b] 规划遍与产品替换');
    const planAsk = table.planPrompt('把参考图里的产品替换成白底图的产品', 'table', [{ name: '参考图', count: 2 }, { name: '白底多角度', count: 5 }]);
    ok(planAsk.includes('per-row') && planAsk.includes('每行各一个不同主体'), '规划遍：per-row = 每行一个不同主体 / 物品');
    ok(planAsk.includes('同一个产品的多角度照片') && planAsk.includes('白底多角度'), '规划遍：every-row = 同一产品的白底多角度图');
    ok(planAsk.includes('每一行都要用上整组'), '规划遍：every-row 整组每行都带');
    ok(planAsk.includes('行的数量由 per-row 的组决定'), '规划遍：行数由 per-row 的组决定');
    ok(planAsk.includes('rowCount') && planAsk.includes('inputGroups') && planAsk.includes('不要输出最终 rows'), '规划遍：只返回 rowCount + inputGroups，不出 rows');
    ok(planAsk.includes('第 1 组（输入 1）「参考图」2 张'), '规划遍：列出输入编号 / 组名 / 张数');
    // 产品替换判据（真实模型实测：两组都以「分组」命名时，模型会把白底图也判成 per-row）
    ok(planAsk.includes('产品替换') && planAsk.includes('every-row'), '规划遍：产品替换判据（A 组 per-row / B 组 every-row）');
    ok(planAsk.includes('rowCount 必须等于 per-row 组的张数'), '规划遍：rowCount 必须等于 per-row 组的张数');
    ok(planAsk.includes('绝不因为 B 组张数多就增加行数'), '规划遍：白底图再多也只当 every-row，不增加行数');
    ok(table.tablePrompt('任务', 'table', 7, [{ name: '参考图', count: 2 }]).includes('产品替换'), '生成遍也有产品替换规则，免得又按 per-row 写');
    eq(table.parseListPlan('抱歉，我不能给出 JSON 规划'), null, '规划解析失败 → null（调用方退回单遍）');
    const parsedPlan = table.parseListPlan(JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }] }));
    eq(parsedPlan, { inputGroups: [{ group: 1, rowMode: 'per-row' }, { group: 2, rowMode: 'every-row' }], rowCount: 2 }, '规划解析');
    ok(table.planTextOf(parsedPlan, [{ name: '参考图', count: 2 }, { name: '白底多角度', count: 5 }]).includes('第 2 组（输入 2）「白底多角度」5 张：全部（每行都带整组）'), '规划文本写清每组怎么用');

    // 产品替换：参考 2 张（逐行）+ 白底 5 张（全部）→ 2 行，每行 1 张参考 + 5 张白底
    const productPlan = JSON.stringify({ rowCount: 2, inputGroups: [{ group: 1, rowMode: 'per-row', role: '参考图' }, { group: 2, rowMode: 'every-row', role: '白底多角度' }] });
    const rows2Json = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['一'], ['二']] });
    const productNodes = { nodes: [...perRowNodes, ...everyNodes, textNode('t1', '商品图', { prompt: '把参考图里的产品替换成白底图的产品', output: 'table' }), group('gA', perRowNodes.map((n) => n.id), { text: '参考图' }), group('gB', everyNodes.map((n) => n.id), { text: '白底多角度' })], edges: [edge('p1', 'gA', 't1'), edge('p2', 'gB', 't1')] };
    const storeP = new FakeStore({ ...productNodes, comments: [] }, textSpec);
    storeP.backend = storeP.backendFor(productPlan, rows2Json);
    ok(await engine.runTextToTable(storeP, 't1'), '规划遍 + 生成遍出表成功');
    eq(storeP.backend.prompts.length, 2, '先规划（1 次）再生成（1 次）');
    ok(storeP.backend.prompts[0].includes('只做规划'), '第一次请求是规划遍');
    ok(storeP.backend.prompts[1].includes('已确认的规划') && storeP.backend.prompts[1].includes('全部（每行都带整组）'), '生成遍带上规划结果');
    const tblP = storeP.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblP).rows.length, 2, '行数 = per-row 组张数（2）');
    eq(table.tableOf(tblP).inputModes, { 'input-1': 'sequence', 'input-2': 'all' }, '参考组逐行、白底组全部');
    const gxP = { id: 'gxP', kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: '批量', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
    storeP.state = { ...storeP.state, doc: { ...storeP.state.doc, nodes: [...storeP.state.doc.nodes, gxP], edges: [...storeP.state.doc.edges, edge('t2gP', tblP.id, 'gxP')] } };
    const rowsP = table.batchRows(storeP.state.doc, 'gxP');
    eq(rowsP.map((r) => r.media.length), [6, 6], '每行 = 1 张参考 + 5 张白底');
    eq(new Set(rowsP[0].media.map((x) => x.url)).size, 6, '行素材没有重复');
    eq(rowsP[0].media.map((x) => x.url.replace('/assets/input/', '')), ['pr0.jpg', 'ev0.jpg', 'ev1.jpg', 'ev2.jpg', 'ev3.jpg', 'ev4.jpg'], '第 1 行 = 参考 1 + 白底整组');
    eq(rowsP[1].media.map((x) => x.url.replace('/assets/input/', '')), ['pr1.jpg', 'ev0.jpg', 'ev1.jpg', 'ev2.jpg', 'ev3.jpg', 'ev4.jpg'], '第 2 行 = 参考 2 + 白底整组');

    // 模型给 5 行但 per-row 只有 2 张 → 裁到 2 行
    const rows5Product = JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['1'], ['2'], ['3'], ['4'], ['5']] });
    const storeP5 = new FakeStore({ ...productNodes, comments: [] }, textSpec);
    storeP5.backend = storeP5.backendFor(productPlan, rows5Product);
    ok(await engine.runTextToTable(storeP5, 't1'), '模型多给行数也能出表');
    const tblP5 = storeP5.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblP5).rows.length, 2, 'per-row 2 张 → 裁到 2 行');
    ok(storeP5.toasts.join(' ').includes('按素材把行数对齐到 2 行'), 'toast 说明行数对齐');

    // 规划遍失败 → 退回单遍，模式回落沿用，不崩
    const storeF = new FakeStore({ ...productNodes, comments: [] }, textSpec);
    storeF.backend = storeF.backendFor('抱歉，我无法给出 JSON 规划', JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['一'], ['二'], ['三'], ['四']] }));
    ok(await engine.runTextToTable(storeF, 't1'), '规划失败也能出表');
    eq(storeF.backend.prompts.length, 3, '规划失败后重试一次规划（只要 JSON），再走单遍（规划 + 重试 + 生成）');
    const tblF = storeF.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblF).rows.length, 4, '没有 plan → 不补不裁，按模型行数');
    ok(!table.tableOf(tblF).inputModes, '没有 plan → 不写模式，回落沿用');
    eq(table.tableChannels(storeF.state.doc, tblF.id).map((c) => c.mode), ['shared', 'shared'], '规划失败 → 沿用');

    // 只有 every-row 的 plan → 没有 per-row 组，不补不裁
    const everyPlan = JSON.stringify({ rowCount: 5, inputGroups: [{ group: 2, rowMode: 'every-row' }] });
    const storeE = new FakeStore({ ...productNodes, comments: [] }, textSpec);
    storeE.backend = storeE.backendFor(everyPlan, JSON.stringify({ kind: 'table', version: 1, columns: ['画面'], rows: [['1'], ['2'], ['3']] }));
    ok(await engine.runTextToTable(storeE, 't1'), '只有 every-row 也能出表');
    const tblE = storeE.state.doc.nodes.find((n) => n.kind === 'table');
    eq(table.tableOf(tblE).rows.length, 3, '没有 per-row 组 → 不动行数');
    eq(table.tableOf(tblE).inputModes, { 'input-2': 'all' }, 'every-row 组写全部');
    ok(!storeE.toasts.join(' ').includes('行数对齐'), '没有 per-row → 不给对齐提示');

    /* ---------- [9] 接线 ---------- */
    console.log('[9] 接线断言');
    const tableNodeSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx'), 'utf8');
    ok(tableNodeSrc.includes('tableChannels(') && tableNodeSrc.includes('channelItemsForRow('), 'TableNode 走 tableChannels / channelItemsForRow');
    ok(!tableNodeSrc.includes('tableMedia(') && !tableNodeSrc.includes('mediaForRow('), 'TableNode 不再用单列模型');
    ok(tableNodeSrc.includes('inputModes'), '表头切换写进 inputModes');
    ok(tableNodeSrc.includes('broken') && tableNodeSrc.includes('onError'), '图片打不开时回落成文字，不留裂图');
    const engineSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/engine.ts'), 'utf8');
    ok(engineSrc.includes('tableAutoSize(table, finalChannels)'), '出表宽度 / 高度按通道最终模式算');
    ok(!engineSrc.includes('fillGroupColumns('), 'engine 不再调用 fillGroupColumns');
    ok(engineSrc.includes('ensureSourceEdges') && engineSrc.includes('tableChannels('), 'engine 把素材来源直连表格并按通道写模式');
    ok(engineSrc.includes('parseTableReply(') && engineSrc.includes('growRowsPrompt(') && engineSrc.includes('padTableRows('), '出表读 inputGroups 并在行数不足时补行');
    ok(engineSrc.includes('perRowRowCount(') && engineSrc.includes('trimTableRows('), '行数只由 per-row 组对齐（不足补 / 超出裁）');
    ok(engineSrc.includes('planPrompt(') && engineSrc.includes('parseListPlan(') && engineSrc.includes('planTextOf('), '出表前先走规划遍，规划内容进生成遍');
    ok(!engineSrc.includes('channelRowCount('), '旧的「非全部通道」行数口径已撤掉');
    ok(engineSrc.includes('delete inputModes[ch.id]'), '没声明的通道清掉旧模式，回落沿用');
    ok(engineSrc.includes('mode === "table" && need > 0'), '分镜表永远不补不裁');
    ok(tableNodeSrc.includes('tin-top') && tableNodeSrc.includes('TABLE_INPUT_COL_W'), '通道表头两行布局，列宽走常量');
    ok(!tableNodeSrc.includes('items.slice(0, 4)'), '输入列不再把第 5 张折叠掉');
    ok(tableNodeSrc.includes('TABLE_INPUT_MAX_SHOWN') && tableNodeSrc.includes('inputCellHeight'), '输入列按素材数显示并撑高行');
    const tableCss = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
    ok(tableCss.includes('th.tin,.cn-root .tgrid td.tin{width:112px}'), 'CSS 输入列宽 112px');
    ok(tableCss.includes('th.tin .h{flex-direction:column'), '通道表头竖排两行');
    ok(/\.tgrid\{flex:1;min-height:0;overflow:auto/.test(tableCss), '超宽表格靠 .tgrid 横向滚动');

    /* ---------- [10] 表格缩略图走 media-preview（不再挂 <video>） ---------- */
    console.log('[10] media-preview 缩略图');
    eq(table.previewThumbUrl('/assets/input/a.jpg', 96), '/api/media-preview?w=96&url=%2Fassets%2Finput%2Fa.jpg', '本地素材拼 media-preview');
    eq(table.previewThumbUrl('/output/ai/b.mp4', 192), '/api/media-preview?w=192&url=%2Foutput%2Fai%2Fb.mp4', '视频同样走 media-preview（后端抽帧当封面）');
    eq(table.previewThumbUrl('https://x/y.png', 96), 'https://x/y.png', 'http 地址原样');
    eq(table.previewThumbUrl('openarc-asset:abc', 96), 'openarc-asset:abc', 'openarc-asset 引用原样');
    eq(table.previewThumbUrl('data:image/png;base64,xx', 96), 'data:image/png;base64,xx', 'data URL 原样');
    eq(table.previewThumbUrl('/assets/a.jpg', 5000), '/api/media-preview?w=2048&url=%2Fassets%2Fa.jpg', '宽度夹在 64~2048');
    eq(table.TABLE_INPUT_PREVIEW_W, 96, '输入列缩略图宽 96');
    eq(table.TABLE_CELL_PREVIEW_W, 192, '数据列图片格缩略图宽 192');
    const thumbSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/thumb.tsx'), 'utf8');
    ok(thumbSrc.includes('/api/media-preview'), 'PreviewImg 走 media-preview');
    ok(thumbSrc.includes('loading="lazy"') && thumbSrc.includes('decoding="async"'), '缩略图懒加载 + 异步解码');
    ok(!tableNodeSrc.includes('<video'), '表格里不再挂 <video> 元素');
    ok(tableNodeSrc.includes('PreviewImg') && tableNodeSrc.includes('TABLE_INPUT_PREVIEW_W') && tableNodeSrc.includes('TABLE_CELL_PREVIEW_W'), '输入列 / 数据列都走 PreviewImg');
    ok(tableNodeSrc.includes('useMemo') && /tableChannels\(doc, node\.id\), \[doc, node\.id\]/.test(tableNodeSrc), 'tableChannels 用 useMemo 按 [doc, node.id] 缓存');
    ok(tableNodeSrc.includes('PLAY_BADGE'), '视频缩略图有播放角标');
    ok(tableNodeSrc.includes('kind === "audio"'), '音频只显示图标（不发预览请求）');

    console.log('[PASS] 多维表格输入通道：一个来源一列「输入 N」+ 逐行 / 全部 / 沿用 + 出表直连素材来源');
})().catch((err) => { console.error(err); process.exit(1); });
