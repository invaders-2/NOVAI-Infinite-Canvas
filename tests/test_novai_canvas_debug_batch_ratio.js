#!/usr/bin/env node
/* ?debugBatchRatio=1 建出来的验证数据必须合法（不跑生成）：
   group 成员是两张图片、表格只有 input-1 一个通道且 sequence、批量节点 ratio=auto / 2K / agnes 模型
   跑法：node tests/test_novai_canvas_debug_batch_ratio.js */
'use strict';
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
const { buildDebugBatchRatio } = load('novai-canvas-ui/src/canvas/canvas-next/agent/debugBatchRatio.ts');
const tables = load('novai-canvas-ui/src/canvas/canvas-next/table.ts');

const nodes = []; const edges = [];
const store = { addNodes(ns, es = []) { nodes.push(...ns); edges.push(...es); } };
const ids = buildDebugBatchRatio(store);

assert.strictEqual(nodes.length, 5, '建出 5 个节点（2 素材 + group + 表格 + 批量）');
const byId = new Map(nodes.map((n) => [n.id, n]));
const group = byId.get(ids.groupId); const tableNode = byId.get(ids.tableId); const batch = byId.get(ids.batchId);
assert.ok(group && group.kind === 'group', '有 group 节点');
assert.deepStrictEqual(group.children.slice().sort(), ids.imageIds.slice().sort(), 'group 成员就是两张图片节点');
assert.ok(ids.imageIds.every((id) => byId.get(id).kind === 'image'), '成员都是图片节点');
const sizes = ids.imageIds.map((id) => { const h = byId.get(id).data.gen.hist[0]; return [h.w, h.h]; });
assert.deepStrictEqual(sizes, [[800, 600], [600, 1067]], '两张素材尺寸 800×600 / 600×1067');
assert.ok(ids.imageIds.every((id) => String(byId.get(id).data.gen.hist[0].url).startsWith('data:image/png;base64,')), '素材用真实 PNG data URL（bridge 能解码）');

const doc = { nodes, edges };
const channels = tables.tableChannels(doc, ids.tableId);
assert.strictEqual(channels.length, 1, '表格只有一条输入通道（group 是一条入边）');
assert.strictEqual(channels[0].items.length, 2, 'input-1 里有 2 张图');
assert.strictEqual(channels[0].mode, 'sequence', 'input-1 是逐行（sequence）');
const t = tables.tableOf(tableNode);
assert.deepStrictEqual(t.columns, ['镜头', '画面提示词'], '表格列');
assert.strictEqual(t.rows.length, 2, '表格 2 行');
assert.strictEqual(t.rows.flat().every((v) => typeof v === 'string'), true, '单元格是字符串（schema 合法）');
assert.deepStrictEqual(t.inputModes, { 'input-1': 'sequence' }, 'inputModes 写在表格数据里');

const params = batch.data.gen.params;
assert.strictEqual(params.ratio, 'auto', '批量节点 ratio=auto（原图比例）');
assert.strictEqual(params.resolution, '2K', '批量节点 2K');
assert.strictEqual(params.model, 'agnes-ai::agnes-image-2.0-flash', '批量节点模型是完整 provider::model');
assert.ok(edges.some((e) => e.from === ids.groupId && e.to === ids.tableId), 'group → 表格 连线');
assert.ok(edges.some((e) => e.from === ids.tableId && e.to === ids.batchId), '表格 → 批量 连线');

console.log('[PASS] debugBatchRatio：节点 5 条 + group 成员 3 条 + 表格通道/行 5 条 + 批量参数/连线 4 条 全部通过');
