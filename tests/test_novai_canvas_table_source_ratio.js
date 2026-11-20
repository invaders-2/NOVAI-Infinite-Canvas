#!/usr/bin/env node
/* 多维表格 → 图片节点：「原图比例」要有源图（按第一行第一张图算），纯文本表仍然没有源图
   跑法：node tests/test_novai_canvas_table_source_ratio.js */
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const ratio = load('novai-canvas-ui/src/canvas/canvas-next/originalRatio.ts');

const imageNode = (id, url, w, h, extra) => ({
    id, kind: 'image', x: 0, y: 0, w: 200, h: 200,
    data: { gen: { title: id, prompt: '', params: {}, hist: url ? [{ url, w, h }] : [], hi: 0, order: [], ...(extra || {}) } },
});
const tableNode = (id, columns, rows, extra) => ({
    id, kind: 'table', x: 0, y: 0, w: 640, h: 320,
    data: { table: { kind: 'table', version: 1, title: '表', columns, rows, ...(extra || {}) } },
});
const groupNode = (id, children) => ({ id, kind: 'group', x: 0, y: 0, w: 200, h: 200, children });
const edge = (from, to) => ({ id: 'e-' + from + '-' + to, from, to });

/* ① 一行一图：表格 → 图片节点，源图 = 第一行第一张（像素从上游素材节点的结果来） */
{
    const src = imageNode('src1', '/a.png', 800, 600);
    const table = tableNode('t1', ['提示词'], [['雨夜天台，冷白光']]);
    const target = imageNode('g1');
    const doc = { nodes: [src, table, target], edges: [edge('src1', 't1'), edge('t1', 'g1')] };
    const box = ratio.sourceBoxInDoc(doc, target, 'image');
    assert.ok(box, '表格里第一行有图 → 拿得到源图（面板不再禁用原图比例）');
    assert.strictEqual(box.url, '/a.png', '源图是表格第一行第一张图');
    assert.strictEqual(box.w, 800, '宽取上游素材结果的真实像素');
    assert.strictEqual(box.h, 600, '高取上游素材结果的真实像素');
    assert.strictEqual(ratio.sourceSizeForTier(box, '2K'), '2048x1536', '2K 档按表格源图算显式 WxH');
    assert.strictEqual(ratio.sourceSizeForTier(box, '1K'), '1024x768', '1K 档同样按源图比例');
    const want = ratio.wantedRatio(doc, target, 'image', { ratio: '自适应' });
    assert.ok(want && Math.abs(want - 4 / 3) < 1e-6, '面板写着原图比例时，比例来自表格第一张图（4:3）');
    const size = ratio.wantedRatio(doc, target, 'image', { ratio: '自适应', sourceSize: '2048x1536' });
    assert.ok(size && Math.abs(size - 4 / 3) < 1e-6, '显式 WxH 备忘优先，结果一致');
}

/* ② 多行不同比例：取第一行第一张；每行自己的图仍由 engine 的 batchSourceSize 单独算 */
{
    const wide = imageNode('wide', '/wide.png', 1200, 600);
    const tall = imageNode('tall', '/tall.png', 600, 1200);
    tall.y = 300;
    const grouped = groupNode('grp', ['wide', 'tall']);
    const table = tableNode('t2', ['提示词'], [['第一行'], ['第二行']], { inputModes: { 'input-1': 'sequence' } });
    const target = imageNode('g2');
    const doc = { nodes: [wide, tall, grouped, table, target], edges: [edge('grp', 't2'), edge('t2', 'g2')] };
    const box = ratio.sourceBoxInDoc(doc, target, 'image');
    assert.ok(box && box.url === '/wide.png', '多行不同比例：面板按第一行第一张（2:1）');
    assert.strictEqual(ratio.sourceSizeForTier(box, '2K'), '2048x1024', '2K 档 2:1');
    const want = ratio.wantedRatio(doc, target, 'image', { ratio: 'auto' });
    assert.ok(want && Math.abs(want - 2) < 1e-6, '比例 2:1');
}

/* ③ 纯文本表（一行图都没有）→ 没有源图，原图比例继续禁用，不瞎猜 1:1 */
{
    const table = tableNode('t3', ['提示词'], [['只写提示词'], ['第二行']]);
    const target = imageNode('g3');
    const doc = { nodes: [table, target], edges: [edge('t3', 'g3')] };
    assert.strictEqual(ratio.sourceBoxInDoc(doc, target, 'image'), null, '纯文本表 → null（面板禁用原图比例）');
    assert.strictEqual(ratio.wantedRatio(doc, target, 'image', { ratio: '自适应' }), null, '没有源图就不给比例');
}

/* ④ 优先级：节点自己的结果 / 直接连的图片节点优先于表格 */
{
    const own = imageNode('g4', '/own.png', 300, 300);
    const src = imageNode('src4', '/up.png', 800, 600);
    const table = tableNode('t4', ['提示词'], [['x']]);
    const doc = { nodes: [own, src, table], edges: [edge('src4', 't4'), edge('t4', 'g4')] };
    const box = ratio.sourceBoxInDoc(doc, own, 'image');
    assert.strictEqual(box.url, '/own.png', '节点自己的结果优先于表格');
    const target = imageNode('g5');
    const doc2 = { nodes: [src, table, target], edges: [edge('src4', 't4'), edge('t4', 'g5'), edge('src4', 'g5')] };
    const box2 = ratio.sourceBoxInDoc(doc2, target, 'image');
    assert.strictEqual(box2.url, '/up.png', '直接连的图片节点优先于表格');
}

/* ⑤ 视频节点行为不变：表格来源不参与 */
{
    const src = imageNode('src6', '/v.png', 800, 600);
    const table = tableNode('t6', ['提示词'], [['x']]);
    const video = { id: 'v6', kind: 'video', x: 0, y: 0, w: 320, h: 180, data: { gen: { title: 'v6', prompt: '', params: {}, hist: [], hi: 0, order: [] } } };
    const doc = { nodes: [src, table, video], edges: [edge('src6', 't6'), edge('t6', 'v6')] };
    assert.strictEqual(ratio.sourceBoxInDoc(doc, video, 'video'), null, '视频不吃表格来源（逐行视频比例路径保持原样）');
}

/* ⑥ 图片列的单元格里放图（没有输入通道）：源图是那张图，尺寸为 0 交给面板量 */
{
    const table = tableNode('t7', ['首帧', '提示词'], [['/assets/cell.png', '雨夜天台']]);
    const target = imageNode('g7');
    const doc = { nodes: [table, target], edges: [edge('t7', 'g7')] };
    const box = ratio.sourceBoxInDoc(doc, target, 'image');
    assert.ok(box && box.url === '/assets/cell.png', '图片列单元格里的图也能当源图');
    assert.strictEqual(box.w, 0, '单元格图没有节点像素：宽为 0，面板异步量');
    assert.strictEqual(box.h, 0, '单元格图没有节点像素：高为 0，面板异步量');
}

/* ⑥b 多张表：第一张纯文本、第二张有图 → 取第二张的第一行第一张 */
{
    const src = imageNode('src8', '/b.png', 600, 1200);
    const textOnly = tableNode('t8a', ['提示词'], [['只有文字']]);
    const withImage = tableNode('t8b', ['提示词'], [['有图的行']]);
    const target = imageNode('g8');
    const doc = { nodes: [src, textOnly, withImage, target], edges: [edge('src8', 't8b'), edge('t8a', 'g8'), edge('t8b', 'g8')] };
    const box = ratio.sourceBoxInDoc(doc, target, 'image');
    assert.ok(box && box.url === '/b.png', '多表：跳过纯文本表，取第一张有图的表的第一行第一张');
    assert.strictEqual(ratio.sourceSizeForTier(box, '2K'), '1024x2048', '2K 档按竖图算');
}

/* ⑦ 面板仍以 hasSource 决定禁用（接线断言） */
{
    const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx'), 'utf8');
    assert.ok(panel.includes('useSourceBox(node, "image")'), '比例弹层用 useSourceBox 取源图');
    assert.ok(panel.includes('const needSource = r === "自适应" && !hasSource'), '原图比例仍然在没有源图时禁用');
    assert.ok(panel.includes('sourceSizeForTier(source, p.size)'), '选中原图比例时按源图 + 档位写显式 WxH');
    const src = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/originalRatio.ts'), 'utf8');
    assert.ok(src.includes('function tableSourceBox'), 'originalRatio 里有表格来源回退');
    assert.ok(src.includes('return kind === "image" ? tableSourceBox(doc, node) : null'), '表格来源只对图片节点生效');
}

console.log('[PASS] 表格来源的原图比例：一行一图 / 多行取首行 / 纯文本表禁用 / 优先级 / 视频不变 / 单元格图 / 面板接线 全部通过');
