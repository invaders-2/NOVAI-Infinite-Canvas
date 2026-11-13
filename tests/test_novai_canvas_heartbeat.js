#!/usr/bin/env node
/* 长任务心跳：解析 heartbeat 事件、done/error 清掉、面板渲染条件（不真生成）
   跑法：node tests/test_novai_canvas_heartbeat.js */
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
const { taskHeartbeat } = load('novai-canvas-ui/src/canvas/canvas-next/agent/task.ts');
const ev = (eventType, payload) => ({ eventType, safePayload: payload });
const snap = (events, status = 'RUNNING') => ({ events, status, taskId: 't', steps: [], calls: [], artifacts: [], verifications: [] });

/* 1) 解析阶段与秒数 */
let hb = taskHeartbeat(snap([ev('heartbeat', { stage: 'decide', elapsed_ms: 5000, kind: 'stream' })]));
assert.deepStrictEqual([hb.stage, hb.elapsedMs, hb.kind], ['decide', 5000, 'stream'], 'decide 阶段 + elapsed_ms');
hb = taskHeartbeat(snap([ev('heartbeat', { stage: 'review', elapsed_ms: 8000 })]));
assert.strictEqual(hb.stage, 'review', 'review 阶段');
hb = taskHeartbeat(snap([ev('heartbeat', { stage: 'tools', elapsed_ms: 9000 })]));
assert.strictEqual(hb.stage, 'tools', 'tools 阶段');
hb = taskHeartbeat(snap([ev('heartbeat', { stage: 'unknown', elapsed_ms: -5 })]));
assert.deepStrictEqual([hb.stage, hb.elapsedMs], ['decide', 0], '未知阶段回落 decide、负数归零');

/* 2) 多条心跳取最后一条；done/error 之后清掉 */
hb = taskHeartbeat(snap([ev('heartbeat', { stage: 'decide', elapsed_ms: 5000 }), ev('heartbeat', { stage: 'review', elapsed_ms: 12000 })]));
assert.strictEqual(hb.elapsedMs, 12000, '取最后一条心跳');
assert.strictEqual(taskHeartbeat(snap([ev('heartbeat', { stage: 'review', elapsed_ms: 8000 }), ev('done', { status: 'ok' })])), null, 'done 之后清掉');
assert.strictEqual(taskHeartbeat(snap([ev('heartbeat', { stage: 'decide', elapsed_ms: 8000 }), ev('error', { message: 'x' })])), null, 'error 之后清掉');
assert.strictEqual(taskHeartbeat(snap([ev('heartbeat', { stage: 'review', elapsed_ms: 8000 }), ev('done', {}), ev('heartbeat', { stage: 'review', elapsed_ms: 9000 })])), null, 'done 在中间也清掉（不复活）') ;
assert.strictEqual(taskHeartbeat(snap([ev('heartbeat', { stage: 'review', elapsed_ms: 8000 })], 'SUCCEEDED')), null, '任务已结束不显示');
assert.strictEqual(taskHeartbeat(snap([])), null, '没有心跳');

/* 3) 面板接线：一行轻状态、流式逐字时隐藏、settled 清掉、debug 口 */
const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
assert.ok(panel.includes('taskHeartbeat(snapshot)'), 'watchTask 解析心跳');
assert.ok(panel.includes('heartbeat: settled ? undefined : (heartbeat || m.heartbeat)'), 'settled 后清掉心跳');
assert.ok(panel.includes('{m.heartbeat && !m.streaming ? <HeartbeatLine'), '有内容增量（streaming）时不显示');
assert.ok(panel.includes('function HeartbeatLine(') && panel.includes('data-heartbeat'), '心跳行组件');
assert.ok(panel.includes('?debugHeartbeat') || panel.includes('"debugHeartbeat"'), '验收口 ?debugHeartbeat=1');
const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css'), 'utf8');
assert.ok(css.includes('.ap2-hb-line') && /\.ap2-hb-line[^{]*\{[^}]*border:\s*0/.test(css), '心跳行软底、无描边（类名避开头部按钮的 .ap2-hb）');

console.log('[PASS] 心跳：解析 6 条 + 清除 5 条 + 面板接线 6 条 全部通过');
