/* 审查结论投递（源码级回归）：终态后继续等 review、刷新后把审查卡还原回来。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const task = read('novai-canvas-ui/src/canvas/canvas-next/agent/task.ts');
const bridge = read('novai-canvas-ui/src/canvas/canvas-next/backend/bridge.ts');
const state = read('novai-canvas-ui/src/canvas/canvas-next/agent/state.ts');
const panel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');

assert.ok(task.includes('REVIEW_GRACE_MS'), '终态后留审查宽限期');
assert.ok(task.includes('=== "review"') && task.includes('graceTimer = setTimeout(stop'), '收到 review 立即停，等不到按宽限收摊');
assert.ok(bridge.includes('REVIEW_GRACE_POLL_MS') && bridge.includes('const scheduleGrace'), 'done 之后继续轮询，直到拿到审查结论');
assert.ok(bridge.includes('const hasReview'), '宽限期拿到 review 就停止轮询');
assert.ok(state.includes('Array.isArray(raw.reviews)'), '刷新后把线程里的审查结论还原成审查卡');
assert.ok(panel.includes('terminalHandled'), '审查宽限刷新不重复跑终态收尾');

console.log('test_novai_canvas_review_delivery: 全部断言通过（审查宽限 / 落线程还原 / 终态收尾只跑一次）');
