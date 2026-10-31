#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'static/js/smart-canvas.js'), 'utf8');
function fn(name) {
    const match = new RegExp('\\n(async )?function ' + name + '\\(').exec(src);
    assert(match, '缺少函数 ' + name);
    const start = match.index + 1;
    const end = src.indexOf('\n}', start);
    assert(end > start, '缺少函数结尾 ' + name);
    return src.slice(start, end + 2);
}

assert(src.includes("fetch('/api/canvas-video?async=1'"), '视频必须异步提交，生成中才能取消');
assert(src.includes('activeSmartGenerationTaskIds.set(taskId, smartNodeStopContextId(node))'), '视频任务登记停止上下文');
assert(src.indexOf('stopSmartGenerationForDelete(nodes.find(node => node.id === id));') < src.indexOf('pushUndo();', src.indexOf('function deleteNode(id)')), '删除节点先取消再撤销/移除');

const sandbox = {
    console,
    nodes: [],
    activeSmartGenerationTaskIds: new Map(),
    activeSmartTaskPolls: new Map(),
    smartStopRequestedNodeIds: new Set(),
    cancelled: [],
    fetch: async url => {
        sandbox.cancelled.push(url);
        return { ok: true, json: async () => ({}) };
    },
    setTimeout: resolve => resolve(),
    tr: key => key,
};
vm.createContext(sandbox);
vm.runInContext([
    fn('smartNodeHasDisplayResult'),
    fn('smartNodeHasCompletedResult'),
    fn('smartNodeInFlight'),
    fn('smartNodeStopContextId'),
    fn('smartStopContextActive'),
    fn('smartNodeRunActive'),
    fn('smartPendingTasks'),
    fn('smartGenerationStopRequestedFor'),
    fn('smartGenerationStoppedError'),
    fn('cancelSmartTask'),
    fn('cancelSmartGenerationTasks'),
    fn('stopSmartGenerationForDelete'),
    fn('pollSmartVideoTask'),
    'globalThis.api = { cancelSmartGenerationTasks, stopSmartGenerationForDelete, pollSmartVideoTask };',
].join('\n'), sandbox);

sandbox.nodes = [
    { id: 'n1', running: true, pendingTasks: [{ taskId: 'persisted-1' }], jimengPending: { taskId: 'jimeng-1' } },
    { id: 'n2', running: true, pendingTasks: [{ taskId: 'other-node' }] },
];
sandbox.activeSmartGenerationTaskIds.set('active-1', 'n1');
sandbox.activeSmartGenerationTaskIds.set('active-2', 'n2');
sandbox.api.cancelSmartGenerationTasks('n1');
assert.deepStrictEqual(new Set(sandbox.cancelled), new Set([
    '/api/tasks/active-1/cancel',
    '/api/tasks/persisted-1/cancel',
    '/api/tasks/jimeng-1/cancel',
]), '当前节点的三类任务全部取消');
assert(!sandbox.cancelled.includes('/api/tasks/active-2/cancel'), '其它节点的内存任务不受影响');
assert(!sandbox.cancelled.includes('/api/tasks/other-node/cancel'), '其它节点的持久化任务不受影响');

sandbox.api.stopSmartGenerationForDelete(sandbox.nodes[0]);
assert.strictEqual(sandbox.activeSmartGenerationTaskIds.has('active-1'), false, '取消后移除任务上下文');

(async () => {
    sandbox.fetch = async () => ({ ok: true, json: async () => ({ status: 'cancelled' }) });
    await assert.rejects(
        sandbox.api.pollSmartVideoTask('video-1', { id: 'n1' }),
        error => error && error.smartGenerationStopped === true,
        '视频取消状态按停止收尾',
    );
    console.log('[PASS] 停止/删除取消任务、节点隔离、视频异步取消');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
