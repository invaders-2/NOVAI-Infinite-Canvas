#!/usr/bin/env node
'use strict';
/*
 * 表格审查（tableReview.ts）纯函数 + 接线回归。
 * 覆盖：干净表通过 / 行数≠逐行通道张数 / 行文本「输入 6」越界 / 0 素材通道 /
 *      每行素材 vs 下游 maxRefs（点名被截通道）/ journal 失败行 / inputModes 残留 /
 *      空行与无提示词行 / UI 与 autorun 接线。
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
const review = load('novai-canvas-ui/src/canvas/canvas-next/tableReview.ts');
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

/* ---------- 构造 ---------- */
const media = (id, url) => ({ id, kind: 'image', x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: id, prompt: '', params: {}, order: [], hi: 0, hist: [{ url: url || '/assets/input/' + id + '.jpg' }] } } });
const emptyImage = (id) => ({ id, kind: 'image', x: 0, y: 0, w: 200, h: 200, text: '', data: { gen: { title: id, prompt: '', params: {}, order: [], hi: 0, hist: [] } } });
const group = (id, children, text) => ({ id, kind: 'group', x: 0, y: 0, w: 300, h: 300, text, children });
const textNode = (id) => ({ id, kind: 'text', x: 0, y: 0, w: 280, h: 200, text: '', data: { gen: { title: id, prompt: '每行一个场景', params: { output: 'table', model: 'm' }, hist: [{ text: '正文' }], hi: 0, order: [] } } });
const tableNode = (id, t) => ({ id, kind: 'table', x: 0, y: 0, w: 400, h: 300, text: t.title, data: { table: t, gen: { title: t.title, prompt: '', params: {}, hist: [], hi: 0, order: [] } } });
const genNode = (id, extra = {}) => ({ id, kind: 'image', x: 0, y: 0, w: 240, h: 240, text: '', data: { gen: { title: id, prompt: '', params: {}, hist: [], hi: 0, order: [] }, ...extra } });
const edge = (id, from, to) => ({ id, from, to });
const plain = (title, columns, rows, extra = {}) => ({ kind: 'table', version: 1, title, columns, rows, ...extra });
const row = (i) => '场景 ' + i + '：输入 1 第 ' + i + ' 张；人物输入 2 整组；姿势输入 3 整组；产品输入 4 整组';
const clone = (x) => JSON.parse(JSON.stringify(x));

function world(opts = {}) {
    const scene = [0, 1, 2].map((i) => media('sc' + i));
    const person = [0, 1, 2].map((i) => media('pe' + i));
    const pose = [media('po0')];
    const product = [0, 1, 2, 3].map((i) => media('pr' + i));
    const t = plain('多维表格', ['画面'], [[row(1)], [row(2)], [row(3)]], {
        sourceId: 't1',
        inputModes: opts.inputModes || { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'all', 'input-4': 'all' },
    });
    const tb = tableNode('tb', t);
    const gx = genNode('gx', opts.genExtra || {});
    const nodes = [...scene, ...person, ...pose, ...product,
        group('gScene', scene.map((n) => n.id), '场景图'),
        group('gPerson', person.map((n) => n.id), '人物三视图'),
        group('gPose', pose.map((n) => n.id), '模特姿势'),
        group('gProduct', product.map((n) => n.id), '产品多角度'),
        textNode('t1'), tb, gx];
    if (opts.extraNodes) nodes.push(...opts.extraNodes);
    const edges = [edge('p1', 'gScene', 't1'), edge('p2', 'gPerson', 't1'), edge('p3', 'gPose', 't1'), edge('p4', 'gProduct', 't1'),
        edge('e1', 'gScene', 'tb'), edge('e2', 'gPerson', 'tb'), edge('e3', 'gPose', 'tb'), edge('e4', 'gProduct', 'tb'),
        edge('e0', 't1', 'tb'), edge('g0', 'tb', 'gx')];
    if (opts.extraEdges) edges.push(...opts.extraEdges);
    return { nodes, edges };
}
const texts = (rv) => rv.findings.map((f) => f.text).join('\n');

(async () => {
    /* ---------- [1] 干净表 ---------- */
    console.log('[1] 干净表通过');
    {
        const doc = world();
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14, modelName: '图片模型' });
        ok(rv.ok, '干净表 ok=true');
        eq(rv.findings, [], '干净表没有 findings');
        ok(rv.summary.includes('3 行') && rv.summary.includes('4 输入'), 'summary 说明行数 / 输入数：' + rv.summary);
        eq(rv.stats.channels.map((c) => [c.index, c.title, c.count, c.mode]), [[1, '场景图', 3, 'sequence'], [2, '人物三视图', 3, 'all'], [3, '模特姿势', 1, 'all'], [4, '产品多角度', 4, 'all']], 'stats 列出每通道张数 / 模式');
        eq(rv.stats.rows, 3, 'stats 行数');
        eq(rv.stats.columns, 1, 'stats 列数');
        eq(rv.stats.totalMedia, 11, 'stats 素材总数');
    }

    /* ---------- [2] 行数 ≠ 逐行通道张数 ---------- */
    console.log('[2] 行数不一致');
    {
        const doc = world();
        const tb = doc.nodes.find((n) => n.id === 'tb');
        tb.data.table = { ...tb.data.table, rows: [[row(1)], [row(2)], [row(3)], [row(1)], [row(2)]] };
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(!rv.ok, '行数不一致 ok=false');
        ok(texts(rv).includes('表格有 5 行，逐行通道要求 3 行') && texts(rv).includes('场景图'), '错误点名逐行通道：' + texts(rv));
    }

    /* ---------- [3] 行文本「输入 6」越界 ---------- */
    console.log('[3] 输入编号越界');
    {
        const doc = world();
        const tb = doc.nodes.find((n) => n.id === 'tb');
        tb.data.table = { ...tb.data.table, rows: [['输入 6 整组'], [row(2)], [row(3)]] };
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(!rv.ok, '越界输入 ok=false');
        ok(texts(rv).includes('「输入 6」') && texts(rv).includes('只有 4 条输入通道'), '和 tableInputWarnings 同口径点名输入 6：' + texts(rv));
        eq(rv.findings.filter((f) => f.text.includes('输入 6')).length, 1, '同一条越界只报一次（不重复）');
    }

    /* ---------- [4] 0 素材通道 ---------- */
    console.log('[4] 0 素材通道');
    {
        const doc = world({ extraNodes: [group('gEmpty', ['missing1'], '空白产品组'), emptyImage('missing1')], extraEdges: [edge('x1', 'gEmpty', 'tb')] });
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(rv.findings.some((f) => f.level === 'warn' && f.text.includes('输入 5') && f.text.includes('没有素材')), '空通道给 warn 并点名输入 5：' + texts(rv));
        ok(rv.findings.some((f) => f.text.includes('空白产品组')), '空通道带组名');
        ok(rv.ok, '只有 warn 时 ok 仍为 true');
    }

    /* ---------- [5] 每行素材 vs maxRefs：点名被截通道 ---------- */
    console.log('[5] maxRefs 截断点名');
    {
        const doc = world();
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 7, modelName: 'gpt-image-x' });
        ok(!rv.ok, '超上限 ok=false');
        const hit = rv.findings.find((f) => f.text.includes('第 1 行要发 9 张参考图'));
        ok(hit && hit.text.includes('gpt-image-x') && hit.text.includes('上限 7 张'), '错误说明每行张数 / 模型 / 上限：' + (hit && hit.text));
        ok(hit && hit.text.includes('「产品多角度」4 张只发送 2 张'), '截断点名产品多角度 4 张只发送 2 张：' + (hit && hit.text));
        const none = review.reviewTable(doc, 'tb', { maxRefs: 0, modelName: 'no-ref' });
        ok(none.findings.some((f) => f.text.includes('不支持参考图')), 'maxRefs=0 说明不支持参考图');
    }

    /* ---------- [6] 下游 journal 失败行 ---------- */
    console.log('[6] journal 失败行');
    {
        const doc = world({ genExtra: { batch: { settings: { concurrency: 2 }, journal: { runId: 'r1', rows: [{ row: 1, status: 'failed', error: '超时' }, { row: 2, status: 'completed' }] } } } });
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(!rv.ok, 'journal 有失败行 ok=false');
        ok(texts(rv).includes('下游批量') && texts(rv).includes('第 1 行（超时）'), '错误汇总失败行与错误：' + texts(rv));
    }

    /* ---------- [7] inputModes 残留未连接通道 ---------- */
    console.log('[7] inputModes 残留');
    {
        const doc = world({ inputModes: { 'input-1': 'sequence', 'input-6': 'all' } });
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(rv.findings.some((f) => f.level === 'warn' && f.text.includes('input-6')), '残留 inputModes 给 warn：' + texts(rv));
    }

    /* ---------- [8] 空行 / 没有提示词文字 ---------- */
    console.log('[8] 空行 / 空提示词');
    {
        const doc = world();
        const tb = doc.nodes.find((n) => n.id === 'tb');
        tb.data.table = { ...tb.data.table, columns: ['画面', '时长'], rows: [['', '5s'], ['', ''], [row(3), '5s']] };
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(texts(rv).includes('第 1 行没有提示词文字'), '只有参数没有提示词的行给 warn：' + texts(rv));
        ok(texts(rv).includes('第 2 行是空行'), '全空行给 warn：' + texts(rv));
    }

    /* ---------- [9] 行文本说整组 / 全部，但通道是「沿用」 ---------- */
    console.log('[9] 行文本要求整组但模式沿用');
    {
        const doc = world({ inputModes: { 'input-1': 'sequence', 'input-2': 'shared', 'input-3': 'all', 'input-4': 'all' } });
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        ok(!rv.ok, '行文本说整组、通道沿用 → ok=false');
        const hit = rv.findings.find((f) => f.text.includes('行文本要求「输入 2」'));
        ok(hit && hit.level === 'error', '给 error 并点名输入 2：' + (hit && hit.text));
        ok(hit && hit.text.includes('「沿用」') && hit.text.includes('每行只会发 1 张') && hit.text.includes('改成「全部」'), '说明只会发 1 张并给出改法');
        // 只有 1 张的通道：沿用和整组效果一样，不误报
        const one = world({ inputModes: { 'input-1': 'sequence', 'input-2': 'all', 'input-3': 'shared', 'input-4': 'all' } });
        const rvOne = review.reviewTable(one, 'tb', { maxRefs: 14 });
        ok(!rvOne.findings.some((f) => f.text.includes('行文本要求「输入 3」')), '1 张的通道不误报（沿用 = 整组）');
    }

    /* ---------- [10] 所有通道都沿用 + 张数不一致 ---------- */
    console.log('[10] 全沿用提示');
    {
        const doc = world({ inputModes: { 'input-1': 'shared', 'input-2': 'shared', 'input-3': 'shared', 'input-4': 'shared' } });
        const rv = review.reviewTable(doc, 'tb', { maxRefs: 14 });
        const warn = rv.findings.find((f) => f.level === 'warn' && f.text.includes('所有输入通道都是「沿用」'));
        ok(warn, '全沿用 + 张数不同 → warn：' + rv.findings.map((f) => f.text).join(' | '));
        ok(warn && warn.text.includes('每行每组只发 1 张') && warn.text.includes('设为「全部」'), 'warn 说明后果和改法');

        const a = [media('a1'), media('a2')]; const b = [media('b1'), media('b2')];
        const sameTable = plain('表', ['画面'], [['一'], ['二']], { inputModes: { 'input-1': 'shared', 'input-2': 'shared' } });
        const sameDoc = { nodes: [...a, ...b, group('gA', ['a1', 'a2'], '甲'), group('gB', ['b1', 'b2'], '乙'), tableNode('tbSame', sameTable)],
            edges: [edge('sa', 'gA', 'tbSame'), edge('sb', 'gB', 'tbSame')] };
        const rvSame = review.reviewTable(sameDoc, 'tbSame', { maxRefs: 14 });
        ok(!rvSame.findings.some((f) => f.text.includes('所有输入通道都是「沿用」')), '张数相同不提示');

        const oneRowDoc = clone(sameDoc);
        oneRowDoc.nodes.find((n) => n.id === 'tbSame').data.table.rows = [['一']];
        const rvOne = review.reviewTable(oneRowDoc, 'tbSame', { maxRefs: 14 });
        ok(!rvOne.findings.some((f) => f.text.includes('所有输入通道都是「沿用」')), '只有 1 行不提示');
    }

    /* ---------- [11] 接线 ---------- */
    console.log('[11] UI / autorun 接线');
    {
        const tableNodeSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/TableNode.tsx'), 'utf8');
        ok(tableNodeSrc.includes('data-act="table-review"'), 'TableNode 有「审查」按钮');
        ok(tableNodeSrc.includes('reviewTable(') && tableNodeSrc.includes('reviewTable(d'), 'TableNode 调 reviewTable');
        ok(tableNodeSrc.includes('tbl-review'), 'TableNode 渲染审查弹层');
        ok(tableNodeSrc.includes('maxRefs: m?.maxRefs'), '审查把下游模型 maxRefs 传进去');
        const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
        ok(css.includes('.tbl-review') && css.includes('.tbl-review .tr-item'), '审查弹层有样式');
        ok(!/\.tbl-review[^{]*\{[^}]*border\s*:/i.test(css), '审查样式不用可见 border');
        const autorunSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/autorun.ts'), 'utf8');
        ok(autorunSrc.includes('runTableBatch') && autorunSrc.includes('runTableBatch(store, id)'), 'autorun 对表格批量节点调用 runTableBatch');
        ok(autorunSrc.includes('batchOf') && autorunSrc.includes('journal'), 'autorun 读 batch.journal');
        ok(autorunSrc.indexOf('runTableBatch') < autorunSrc.indexOf('runNode(store, id, { inPlace: true'), '表格批量分支在单次 runNode 之前');
    }

    console.log('[PASS] 表格审查：干净表 / 行数 / 输入越界 / 空通道 / maxRefs 截断 / journal 失败 / 接线');
})().catch((err) => { console.error(err); process.exit(1); });
