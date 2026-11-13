#!/usr/bin/env node
/* K2：线程历史还原思考 / 时长 / 自检 / 待生成卡片（刷新页面后卡片还在、时长不是 0.0s）
   跑法：node tests/test_novai_canvas_history_restore.js（run-all 会自动带上） */
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
const { historyMessage } = load('novai-canvas-ui/src/canvas/canvas-next/agent/state.ts');

/* 1) 思考内容 + 时长：刷新后仍是 12.6s，不是 0.0s */
const thinking = historyMessage({
    role: 'assistant', content: '节点已经建好', at: 1700000000, took: 12.6,
    think: { lines: ['先看画布', '再建节点'], kinds: ['thought', 'roadmap'], secs: '12.6' },
}, 0);
assert.strictEqual(thinking.took, 12.6, '思考时长要还原');
assert.deepStrictEqual(thinking.think.lines, ['先看画布', '再建节点'], '思考内容要还原');
assert.deepStrictEqual(thinking.think.kinds, ['thought', 'roadmap'], '反思/方案标记要还原');
assert.strictEqual(thinking.think.live, false, '历史里的思考不是进行中');
assert.strictEqual(thinking.think.secs, '12.6');

/* 2) 自检结果（含 pending 待核对项） */
const checked = historyMessage({
    role: 'assistant', content: '已完成', took: 3.2,
    self_check: { round: 2, passed: false, items: [
        { text: '字数：要求不超过 30 字，实际 50 字', ok: false },
        { text: '阶段验收：风格统一（待核对）', ok: false, status: 'pending' },
    ] },
}, 1);
assert.strictEqual(checked.selfCheck.passed, false);
assert.strictEqual(checked.selfCheck.items.length, 2);
assert.strictEqual(checked.selfCheck.items[1].status, 'pending', '待核对项的状态要保留');

/* 3) 待生成卡片：刷新后还在，taskId 指向原 run（点「执行生成」复用同一份方案） */
const plan = {
    kind: 'generation', requires_confirmation: true, summary: '待生成 1 张',
    steps: [{ tool: 'run_generation', args: { node_id: 'n1' } }],
    nodes: [{ node_id: 'n1', title: '图片1', kind: 'image', prompt: '白底产品图' }],
};
const pending = historyMessage({ role: 'assistant', content: '待生成', run_id: 'run_abc', plan }, 2);
assert.ok(pending.task, '有持久化方案就要还原出任务卡');
assert.strictEqual(pending.task.status, 'SUCCEEDED', '历史方案是已结束状态，卡片才会渲染');
assert.strictEqual(pending.task.taskId, 'run_abc', '「执行生成」要打回原 run');
assert.strictEqual(pending.task.plan.kind, 'generation');
assert.strictEqual(pending.task.plan.nodes[0].prompt, '白底产品图', '卡片里的提示词要能改');

/* 4) 已批准 / 已执行的方案不再给执行入口 */
const approved = historyMessage({ role: 'assistant', content: '已执行', run_id: 'run_abc', plan, plan_status: 'approved' }, 3);
assert.strictEqual(approved.task.plan, null, '已批准的方案不能重复执行');

/* 5) 老数据 / 用户消息：不长出空壳 */
const plain = historyMessage({ role: 'assistant', content: '旧消息' }, 4);
assert.strictEqual(plain.think, undefined);
assert.strictEqual(plain.selfCheck, undefined);
assert.strictEqual(plain.task, undefined);
assert.strictEqual(historyMessage({ role: 'user', content: '记住：主色是墨绿色' }, 5).think, undefined);

console.log('history-restore ok：5 组断言通过');
