#!/usr/bin/env node
/* L1：面板里说「记住：…」的入口接线 —— 必须带画布 / 线程给后端统一记忆入口。
   跑法：node tests/test_novai_canvas_remember_entry.js（run-all 会自动带上） */
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const panel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
const state = read('novai-canvas-ui/src/canvas/canvas-next/agent/state.ts');
const bridge = read('novai-canvas-ui/src/novaiBridge.ts');

/* 1) 面板：说「记住：…」时把这一轮（线程 + 原话）一起交给 addMemory，回复用服务端那句 */
assert.ok(/a\.addMemory\(scope, fact, \{ threadId: tId, userText: text \}\)/.test(panel),
    '面板 addMemory 要带 threadId / userText');
assert.ok(/saved\.reply \|\|/.test(panel), '面板显示服务端存的同一句回复');

/* 2) 状态层：addMemory 把 canvasId / threadId / userText 传下去，并把 deduplicated / reply 带回来 */
assert.ok(/attributes: \{ scope, canvasId: this\.canvasId, threadId: extra\?\.threadId \|\| "", userText: extra\?\.userText \|\| "" \}/.test(state),
    'state.addMemory 要传 canvasId / threadId / userText');
assert.ok(/deduplicated: result\.deduplicated === true, reply: String\(result\.reply \|\| ""\)/.test(state),
    'state.addMemory 要带回 deduplicated / reply');

/* 3) 桥：resource/create 走 POST /api/memories，并带上统一记忆入口需要的字段 */
assert.ok(/request\("\/api\/memories", json\(\{/.test(bridge), 'resource/create 仍走 POST /api/memories');
assert.ok(/canvas_id: String\(attrs\.canvasId \|\| ""\)/.test(bridge), '要带 canvas_id');
assert.ok(/thread_id: String\(attrs\.threadId \|\| ""\)/.test(bridge), '要带 thread_id');
assert.ok(/user_text: String\(attrs\.userText \|\| ""\)/.test(bridge), '要带 user_text');
assert.ok(/reply: String\(made\.reply \|\| ""\)/.test(bridge), '要把服务端回复带回来');

console.log('remember-entry ok：3 组断言通过');
