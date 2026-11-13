#!/usr/bin/env node
/* 张数不静默降级：请求 4 张、模型一次最多 N 张 → 拆成 groups 次执行（task-25）
   跑法：node tests/test_novai_canvas_plan_count_groups.js（run-all 会自动带上） */
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
const plan = load('novai-canvas-ui/src/canvas/canvas-next/agent/planParams.ts');
const spec = (batch, extra = {}) => ({ id: 'comfly::m', name: 'm', vendor: 'comfly', kind: 'image', tags: [], secs: 10, batch, ...extra });
const step = (count, extra = {}) => ({ tool: 'run_generation', args: { node_id: 'n1', settings: { provider: 'comfly', model: 'm', count }, ...extra } });
const models = (s) => [s];

/* 1) groups 计算：4 张 + 不同 batch */
assert.deepStrictEqual(plan.countPlan(spec([1]), 4).sizes, [1, 1, 1, 1], 'batch=[1]：4 次每次 1 张');
assert.strictEqual(plan.countPlan(spec([1]), 4).groups, 4);
assert.deepStrictEqual(plan.countPlan(spec([1, 2]), 4).sizes, [2, 2], 'batch=[1,2]：2 次每次 2 张');
assert.deepStrictEqual(plan.countPlan(spec([1, 2, 4]), 4).sizes, [4], 'batch=[1,2,4]：1 次 4 张，不拆');
assert.strictEqual(plan.countPlan(spec([1, 2, 4]), 4).groups, 1);
assert.deepStrictEqual(plan.countPlan(spec([1]), 1).sizes, [1], '请求 1：1 次 1 张');
assert.deepStrictEqual(plan.countPlan(spec([4]), 4).sizes, [4], '模型本身支持 4：一次出 4，不拆');

/* 2) 批量未知：按一次 1 张 + 明确标记 */
const unknown = plan.countPlan({ ...spec(undefined), batchUnknown: true }, 4);
assert.deepStrictEqual(unknown.sizes, [1, 1, 1, 1]);
assert.strictEqual(unknown.batchUnknown, true, 'batchUnknown 要能被卡片识别并提示');
const missing = plan.countPlan(undefined, 3);
assert.strictEqual(missing.perGroup, 1);
assert.strictEqual(missing.unknownBatch, true, '没有模型 / 没声明 batch 也按 1 张处理');

/* 3) 执行展开：真的按 groups 生成多次（每次带自己的 count），不是一次带 4 张 */
const runSteps = () => plan.expandGenerationSteps([step(4)], models(spec([1])));
let out = runSteps();
assert.strictEqual(out.length, 4, 'batch=[1]：批准步骤展开成 4 次执行');
assert.deepStrictEqual(out.map((s) => s.args.settings.count), [1, 1, 1, 1], '每次 count=1');
assert.ok(out.every((s) => s.args.node_id === 'n1'), '同一个节点（由画布按现有规则落结果/开新结果节点）');
out = plan.expandGenerationSteps([step(4)], models(spec([1, 2])));
assert.deepStrictEqual(out.map((s) => s.args.settings.count), [2, 2], 'batch=[1,2]：2 次每次 2 张');
out = plan.expandGenerationSteps([step(4)], models(spec([1, 2, 4])));
assert.strictEqual(out.length, 1, 'batch=[1,2,4]：1 次');
assert.strictEqual(out[0].args.settings.count, 4, '一次出 4 张');
out = plan.expandGenerationSteps([step(1)], models(spec([1])));
assert.strictEqual(out.length, 1, '请求 1：不拆');
assert.strictEqual(out[0].args.settings.count, 1);

/* 4) 尾组不在模型合法档位：补到最近一档（不会发模型不支持的张数） */
out = plan.expandGenerationSteps([step(5)], models(spec([2])));
assert.deepStrictEqual(out.map((s) => s.args.settings.count), [2, 2, 2], '5 张 batch=[2]：补成 3 次每次 2（尾组补到 2）');

/* 5) readPlanParams 不再静默回落：请求 4 张就记 4 张（拆分在执行层） */
const read = plan.readPlanParams(step(4), 'image', models(spec([1])));
assert.strictEqual(read.count, 4, 'readPlanParams 保留用户要的 4 张（原来会静默回落成 1）');

/* 6) 端到端到 approve：卡片点执行时走的 patchPlanStep → expandGenerationSteps，不能在中途把 4 张夹回 1 */
for (const [batch, expected] of [[[1], [1, 1, 1, 1]], [[1, 2], [2, 2]], [[1, 2, 4], [4]]]) {
    const s = spec(batch);
    const patched = plan.patchPlanStep(step(4), 'image', [s], { modelConfigId: s.id, ratio: '3:4', resolution: '2K', count: 4 });
    assert.strictEqual(patched.args.settings.count, 4, 'patchPlanStep 不再把请求张数夹回 batch[0]（batch=' + JSON.stringify(batch) + '）');
    const approved = plan.expandGenerationSteps([patched], [s]);
    assert.deepStrictEqual(approved.map((x) => x.args.settings.count), expected, 'approve 展开：' + JSON.stringify(batch) + ' → ' + JSON.stringify(expected));
    assert.ok(approved.every((x) => x.tool === 'run_generation' && x.args.node_id === 'n1'), '每一步都是同一节点的 run_generation');
}

console.log('[PASS] 张数分组：countPlan 8 条 + expandGenerationSteps 6 条 + readPlanParams 不回退 + approve 端到端 3 组 全部通过');
