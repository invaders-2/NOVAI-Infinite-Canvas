#!/usr/bin/env node
/* 助手批量节点：smart-batch / 上游是 table 的生成节点都要纳入 autorun 并走 runTableBatch（不真生成）
   跑法：node tests/test_novai_canvas_agent_run_target.js */
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
const { agentRunTarget, hasBatchData, smartBatchMediaKind } = load('novai-canvas-ui/src/canvas/canvas-next/agent/runTarget.ts');

assert.strictEqual(agentRunTarget('image', true), 'batch', '上游是表格的图片节点 → 批量（旧行为）');
// 按能力识别：smart-image / 非标准 kind，只要有 data.batch + 上游表格也走批量
assert.strictEqual(agentRunTarget('image', true, true), 'batch', 'image + data.batch + 表格 → 批量');
assert.strictEqual(agentRunTarget('smart-image', true, true), 'batch', 'smart-image（字面非 gen）+ data.batch + 表格 → 批量');
assert.strictEqual(agentRunTarget('image', false, true), 'single', '有 data.batch 但没表格 → 不走批量');
assert.strictEqual(hasBatchData({ batch: {} }), true, 'data.batch 识别');
assert.strictEqual(hasBatchData({}), false, '没有 data.batch');
assert.strictEqual(hasBatchData(null), false, '空 data');
assert.strictEqual(agentRunTarget('video', true), 'batch', '上游是表格的视频节点 → 批量');
assert.strictEqual(agentRunTarget('smart-batch', true), 'batch', 'smart-batch + 上游表格 → 批量');
assert.strictEqual(agentRunTarget('smart-batch', false), 'smart-batch', 'smart-batch 没有表格时单独处理');
assert.strictEqual(agentRunTarget('image', false), 'single', '普通图片节点 → 单次生成');
assert.strictEqual(agentRunTarget('timeline', false), 'timeline', '剪辑时间线');
assert.strictEqual(agentRunTarget('table', true), null, '表格节点本身不执行');
assert.strictEqual(agentRunTarget('note', false), null, '便签不执行');
assert.strictEqual(smartBatchMediaKind({}), 'image', 'smart-batch 默认图片');
assert.strictEqual(smartBatchMediaKind({ tableBatchVideo: true }), 'video', 'tableBatchVideo → 视频');
assert.strictEqual(smartBatchMediaKind({ runSettings: { apiKind: 'video' } }), 'video', 'runSettings.apiKind=video → 视频');

const src = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/autorun.ts'), 'utf8');
assert.ok(src.includes('n.kind === "smart-batch"'), 'queuedOf 纳入 smart-batch');
assert.ok(src.includes('if (n0?.kind === "smart-batch")') && src.includes('store.updateNode(id') && src.includes('kind: media'), 'smart-batch 先迁成 BEAT 批量节点再跑');
assert.ok(src.includes('runTableBatch(store, id)'), '批量分支调用 runTableBatch');
assert.ok(src.includes('表格没有可执行的行') && src.includes('markDone(store, id, { ok: false'), '空表/无行也会 markDone 失败（不静默）');
assert.ok(src.includes('hasBatchData(n.data)') && src.includes('const hasTable = inputsOf('), '按能力识别批量节点（data.batch + 上游表格）');
assert.ok(src.includes('w.__autorunLog = [{ stage: "boot"') && !src.includes('debugAutorun") === "1"\n    const w'), '模块加载即挂 window.__autorunLog（boot，不依赖 debug 参数）');
const app = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/CanvasApp.tsx'), 'utf8');
assert.ok(app.includes('stage: "canvas-load"') && app.includes('window.setTimeout(kick, 1500)'), 'CanvasApp 载入后兜底调度 autorun 并记录 canvas-load');
assert.ok(src.includes('stage: "cycle"') && src.includes('stage: "skip"'), '每轮记录 cycle / skip（含跳过原因）');
assert.ok(src.includes('stage: "queued", nodeId:') && src.includes('stage: "branch", nodeId:'), 'queued / branch 都带 nodeId 与 target/reason');
assert.ok(src.includes('store.defaultModel(n0.kind)') && src.includes('fallback.id'), '批量节点缺模型时补默认模型（不再每行无法组装请求）');
assert.ok(src.includes('批量节点没有可用的'), '没有可用模型也会 markDone 说明原因');

console.log('[PASS] 批量 autorun：目标判定 8 条 + media 3 条 + 源码接线 5 条 全部通过');
