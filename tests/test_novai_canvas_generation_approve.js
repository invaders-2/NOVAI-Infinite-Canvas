#!/usr/bin/env node
/* M2 / L6：刷新后的待生成卡片 —— 选模型 → 「执行生成」可点 → 产出真正开始生成的步骤。
   跑法：node tests/test_novai_canvas_generation_approve.js（run-all 会自动带上）

   用例：
   1) 可点门槛：没选模型 / 一个都没勾 → 不能点；选了模型 → 可点
   2) 执行步骤：可点后产出 run_generation，选中的模型 / 比例 / 张数写进执行参数
   3) 提示词回写：卡片里改过提示词 → 先 update_node 再生成
   4) 批量拆分：模型一次 1 张、请求 2 张 → 拆成两次执行
   5) 刷新还原链路：线程历史里的 plan → 选模型 → 可点 → 产出执行步骤
   6) 面板接线：按钮按 allReady 置灰、点击走 approve、批准后 approveAgentTask + watchTask
*/
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const cases = [];
function running(name) { cases.push(name); process.stdout.write('[' + cases.length + '] ' + name + ' ... '); }
function pass() { process.stdout.write('PASS\n'); }

const plan = load('novai-canvas-ui/src/canvas/canvas-next/agent/planParams.ts');
const { historyMessage } = load('novai-canvas-ui/src/canvas/canvas-next/agent/state.ts');
const cardSource = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/GenerationCard.tsx'), 'utf8');
const panelSource = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');

const models = [{ id: 'comfly::m', name: 'm', vendor: 'comfly', kind: 'image', tags: [], secs: 10, batch: [1] }];
const nodes = [{ node_id: 'n1', title: '海报', kind: 'image', prompt: '白底产品图' }];
const steps = [{ tool: 'run_generation', args: { canvas_id: 'c1', node_id: 'n1', type: 'image' }, description: '生成「海报」' }];
const row = (extra = {}) => ({ on: true, modelId: 'comfly::m', ratio: '1:1', resolution: '1k', count: 1, duration: 5, mode: '', prompt: '白底产品图', ...extra });

running('可点门槛：没选模型 / 一个都没勾不能点，选了模型可点');
assert.strictEqual(plan.generationReady([row({ modelId: '' })], ['image']), false, '没选模型不能执行');
assert.strictEqual(plan.generationReady([row({ on: false })], ['image']), false, '一个都没勾不能执行');
assert.strictEqual(plan.generationReady([row()], ['image']), true, '选了模型就可以执行');
assert.strictEqual(plan.generationReady([row({ modelId: '' })], ['audio']), true, '配音不需要选模型');
pass();

running('执行步骤：选中的模型 / 比例 / 张数写进 run_generation');
const out = plan.buildGenerationApproveSteps(steps, [row()], models, nodes);
assert.strictEqual(out.length, 1);
assert.strictEqual(out[0].tool, 'run_generation');
assert.strictEqual(out[0].args.node_id, 'n1');
assert.strictEqual(out[0].args.canvas_id, 'c1');
const settings = out[0].args.settings || {};
assert.ok(JSON.stringify(settings).includes('m'), '模型要写进执行参数：' + JSON.stringify(settings));
assert.strictEqual(settings.count, 1);
pass();

running('提示词回写：卡片里改过提示词 → 先 update_node');
const edited = plan.buildGenerationApproveSteps(steps, [row({ prompt: '白底产品图，居中，留白' })], models, nodes);
assert.strictEqual(edited.length, 2);
assert.strictEqual(edited[0].tool, 'update_node');
assert.ok(String(edited[0].args.prompt).includes('居中'));
pass();

running('批量拆分：模型一次 1 张、请求 2 张 → 两次执行');
const two = plan.buildGenerationApproveSteps(
    [{ tool: 'run_generation', args: { canvas_id: 'c1', node_id: 'n1', type: 'image' } }],
    [row({ count: 2 })], models, nodes);
assert.strictEqual(two.length, 2);
pass();

running('刷新还原链路：线程历史 plan → 选模型 → 可点 → 产出执行步骤');
const savedPlan = {
    kind: 'generation', requires_confirmation: true, summary: '待生成 1 张',
    steps: [{ tool: 'run_generation', args: { canvas_id: 'c1', node_id: 'n1', type: 'image' } }],
    nodes: [{ node_id: 'n1', title: '海报', kind: 'image', prompt: '白底产品图' }],
};
const restored = historyMessage({ role: 'assistant', content: '待生成', run_id: 'run_42', plan: savedPlan }, 0);
assert.ok(restored.task && restored.task.plan, '刷新后要从历史还原出待生成卡片');
assert.strictEqual(restored.task.taskId, 'run_42', '「执行生成」打回原 run');
assert.strictEqual(restored.task.plan.kind, 'generation');
assert.strictEqual(restored.task.plan.steps.length, 1);
// 用户还没选模型：卡片上「执行生成」是灰的
assert.strictEqual(plan.generationReady([row({ modelId: '' })], ['image']), false);
// 用户选了模型（卡片里选完就是 modelId 有值）：「执行生成」可点
assert.strictEqual(plan.generationReady([row()], ['image']), true);
// 点下去产出真正的执行步骤（面板随后交给后端 approveAgentTask → watchTask）
const chainSteps = plan.buildGenerationApproveSteps(restored.task.plan.steps, [row()], models, restored.task.plan.nodes);
assert.strictEqual(chainSteps[0].tool, 'run_generation');
assert.ok(JSON.stringify(chainSteps[0].args.settings).includes('m'));
pass();

running('面板接线：按钮置灰 / 点击 approve / 后端 approveAgentTask + watchTask');
assert.ok(/disabled=\{busy \|\| !allReady\}/.test(cardSource), '「执行生成」按钮必须按 allReady 置灰');
assert.ok(/const approve = \(\) => onApprove\(buildGenerationApproveSteps\(steps, rows, models, nodes\)\)/.test(cardSource));
assert.ok(/approveAgentTask\(task\.taskId, steps\)/.test(panelSource));
assert.ok(/watchTask\(m, res\.taskId/.test(panelSource));
pass();

console.log('generation-approve ok：' + cases.length + ' 个用例全部通过');
