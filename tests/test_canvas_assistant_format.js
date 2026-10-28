#!/usr/bin/env node
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const esbuild = require('../canvas-ui/node_modules/esbuild');

function loadTs(name) {
    const outfile = path.join(os.tmpdir(), 'novai-' + name + '-' + process.pid + '.cjs');
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, '../canvas-ui/src/assistant/' + name + '.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        outfile,
        logLevel: 'silent',
    });
    return require(outfile);
}

const { deriveRun, runSummary, liveToolLabel, messageNodeRefs } = loadTs('format');
const { createSession, applyEvent } = loadTs('session');

const message = {
    id: 'm1', role: 'assistant', status: 'completed', activeWorkMs: 1000, createdAt: 1,
    parts: [
        { type: 'vision', id: 'v1', mode: 'direct', labels: ['图1', '图2'], text: '' },
        { type: 'vision', id: 'v2', mode: 'caption', labels: ['图2'], text: '' },
        { type: 'tool_event', id: 's1', kind: 'step', tool: 'read_file', title: '读取文档', status: 'done', message: '', args: {} },
        { type: 'tool_event', id: 's2', kind: 'step', tool: 'generate_image', title: '生成图片', status: 'done', message: '', args: { node_id: 'node-1' }, result: { node: { id: 'node-2', alias: '图2' } } },
        { type: 'tool_event', id: 's3', kind: 'step', tool: 'create_node', title: '新建节点', status: 'done', message: '', args: { node_id: 'node-1' } },
    ],
};
const run = deriveRun(message);
assert.strictEqual(runSummary(run), '看了 2 张图，修改画布 1 次，读了 1 个文档，提交了 1 个生成');
assert.deepStrictEqual(messageNodeRefs(message), [
    { id: 'node-1', label: 'node-1' },
    { id: 'node-2', label: '图2' },
]);

const deleteRun = deriveRun({
    id: 'm2', role: 'assistant', status: 'completed', activeWorkMs: 1000, createdAt: 2,
    parts: [{ type: 'tool_event', id: 'd1', kind: 'step', tool: 'delete_node', title: '删除节点', status: 'done', message: '' }],
});
assert.strictEqual(runSummary(deleteRun), '编辑了画布', '删除任务使用 TapNow 的独立摘要');
const connectRun = deriveRun({
    id: 'm3', role: 'assistant', status: 'completed', activeWorkMs: 1000, createdAt: 3,
    parts: [
        { type: 'tool_event', id: 'c1', kind: 'step', tool: 'get_canvas', title: '读取画布', status: 'done', message: '' },
        { type: 'tool_event', id: 'c2', kind: 'step', tool: 'connect_nodes', title: '连接节点', status: 'running', message: '' },
    ],
});
assert.strictEqual(runSummary(connectRun), '查看画布 1 次');
assert.strictEqual(liveToolLabel(connectRun), '读取节点');

const state = createSession();
applyEvent(state, { type: 'vision', data: { mode: 'direct', labels: ['图1'], text: '已看图' } });
applyEvent(state, { type: 'run_start', data: { run_id: 'run-1' } });
assert.strictEqual(state.messages.length, 1, 'vision 后再 run_start 不应产生重复运行卡');
assert.strictEqual(state.messages[0].runId, 'run-1');
assert.strictEqual(state.messages[0].parts.filter((part) => part.type === 'vision').length, 1);
assert.strictEqual(runSummary(deriveRun(state.messages[0])), '看了 1 张图', '看图可实时显示，但不提前虚报操作数');

console.log('[PASS] 画布助手运行摘要、节点引用与 vision 事件顺序');
