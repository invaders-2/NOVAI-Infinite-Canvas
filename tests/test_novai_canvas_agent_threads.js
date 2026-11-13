#!/usr/bin/env node
'use strict';
/*
 * 画布助手「多对话并行」：AgentState 的线程级 msgs / busy / stop / 历史缓存 + 消息归属。
 * 只测纯前端状态机（后端线程用可控假实现），不连服务、不碰 3000 端口。
 *
 * 产品约束：不同对话可以同时跑；同一对话内仍串行（一轮对话历史不能被并发写乱）。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

/* ── 假宿主桥：task 命令全在内存里，返回什么由用例决定 ── */
function makeBackend() {
    const state = {
        rows: [
            { id: 't1', title: '对话一', message_count: 2, updated_at: 100 },
            { id: 't2', title: '对话二', message_count: 1, updated_at: 200 },
        ],
        active: 't1',
        messages: {
            t1: [{ role: 'user', text: '旧问题', at: 1 }, { role: 'assistant', text: '旧回答', at: 2 }],
            t2: [{ role: 'user', text: '第二个对话的问题', at: 3 }],
        },
        messageCalls: {},
        seq: 2,
    };
    const command = async (request) => {
        const type = String((request && request.type) || '');
        const payload = (request && request.payload) || {};
        if (type === 'thread/list') return { ok: true, threads: state.rows.map((row) => ({ ...row })), active_id: state.active };
        if (type === 'thread/switch') { state.active = String(payload.threadId || ''); return { ok: true }; }
        if (type === 'thread/new') {
            state.seq += 1;
            const id = 't' + state.seq;
            state.rows.push({ id, title: '对话 ' + state.seq, message_count: 0, updated_at: 300 + state.seq });
            state.messages[id] = [];
            state.active = id;
            return { ok: true, thread: { id } };
        }
        if (type === 'thread/messages') {
            const id = String(payload.threadId || '');
            state.messageCalls[id] = (state.messageCalls[id] || 0) + 1;
            return { ok: true, messages: state.messages[id] || [], start: 0, has_more: false };
        }
        return { ok: false };
    };
    return { command, state };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i += 1) await tick(); };

global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const backend = makeBackend();
global.window = { novai: { task: { command: backend.command } } };

const { AgentState } = load('novai-canvas-ui/src/canvas/canvas-next/agent/state.ts');

(async () => {
    /* 1) 首次加载：没有选过对话时采用服务端 active_id，并把它近页消息读进这条线程 */
    const a = new AgentState('canvas-multi');
    await settle();
    assert.strictEqual(a.activeThreadId, 't1', '首次加载采用服务端 active_id');
    assert.strictEqual(await a.loadThreadMessages('t1'), true);
    assert.strictEqual(a.msgs.length, 2, '当前对话消息按线程落位');
    assert.strictEqual(a.historyStart, 0);
    assert.strictEqual(a.historyHasMore, false);

    /* 2) 线程级隔离：会话一在跑，新建 / 切到会话二不继承 busy，消息也各是各的 */
    a.setThreadBusy('t1', true);
    const running = { id: 'run-1', role: 'a', text: '', at: Date.now() };
    a.appendMessage(running, 't1');
    await a.switchThread('t2');
    assert.strictEqual(a.activeThreadId, 't2');
    assert.strictEqual(a.msgs.length, 1, '会话二只看到自己的消息');
    assert.strictEqual(a.busy, false, '会话二不继承会话一的 busy');
    assert.strictEqual(a.isThreadBusy('t1'), true, '会话一仍在跑');
    assert.strictEqual(a.threadMessages('t1').length, 3, '会话一消息留在自己的桶里');

    /* 3) 后台线程 patch 只改它自己：当前对话的消息数组不被替换 */
    const currentBefore = a.msgs;
    a.patchMessage(running, { text: '会话一的实时进度' });
    assert.strictEqual(a.msgs, currentBefore, '后台任务不替换当前对话的消息数组');
    assert.strictEqual(a.msgs.length, 1);
    assert.strictEqual(a.threadMessages('t1').slice(-1)[0].text, '会话一的实时进度', '进度写回它所属的会话');

    /* 4) goalBefore 按消息所属线程找上一句用户消息，不拿当前对话的提问 */
    const follow = { id: 'run-2', role: 'a', text: '' };
    a.appendMessage(follow, 't1');
    assert.strictEqual(a.goalBefore(follow), '旧问题');
    assert.strictEqual(a.goalBefore(a.msgs[0]), '', '会话二第一条之前没有用户消息');

    /* 5) 切回已加载的会话：直接用本地缓存，不拉服务端历史覆盖运行中消息 */
    const callsBefore = backend.state.messageCalls.t1;
    assert.ok(callsBefore >= 1);
    assert.strictEqual(await a.switchThread('t1'), true);
    assert.strictEqual(a.activeThreadId, 't1');
    assert.strictEqual(backend.state.messageCalls.t1, callsBefore, '切回已加载对话不再拉历史');
    assert.ok(a.msgs.some((m) => m.id === 'run-1'), '运行中的消息还在');
    assert.strictEqual(a.busy, true, '切回来能看到会话一还在跑');

    /* 6) loadThreadMessages 只写目标线程，不替换当前对话 */
    backend.state.messages.t3 = [{ role: 'user', text: '第三个对话', at: 5 }];
    const t1Msgs = a.msgs;
    assert.strictEqual(await a.loadThreadMessages('t3'), true);
    assert.strictEqual(a.msgs, t1Msgs, '加载别的对话不替换当前对话');
    assert.strictEqual(a.threadMessages('t3').length, 1, '消息写进了目标线程');

    /* 7) 多条对话可以同时忙：busy / stop 都按线程存，互不覆盖 */
    a.setThreadBusy('t3', true);
    assert.strictEqual(a.isThreadBusy('t1'), true);
    assert.strictEqual(a.isThreadBusy('t3'), true);
    a.setThreadStop('t3', true);
    assert.strictEqual(a.stop, false, '停的是会话三，会话一不被标记停止');
    a.setThreadStop('t1', true);
    assert.strictEqual(a.stop, true);

    /* 8) 新建对话：新对话忙闲 / 消息 / 历史 / 队列 / 草稿都从空开始，旧对话本地状态原样保留 */
    const queued = (id, text) => ({ id, label: text, snap: { text, skill: null, pinned: [], selected: [], refs: [], webPlugin: false } });
    a.queue = [queued('q1', '会话一的排队消息')];
    a.pendingUrgent = queued('q2', '会话一的立即发送');
    a.draft = '会话一没发出去的草稿';
    assert.strictEqual(await a.newThread(), true);
    const freshThread = a.activeThreadId;
    assert.notStrictEqual(freshThread, 't1');
    assert.strictEqual(a.busy, false, '新对话是空闲的');
    assert.strictEqual(a.msgs.length, 0, '新对话没有继承上一段的消息');
    assert.strictEqual(a.historyStart, 0);
    assert.strictEqual(a.historyHasMore, false);
    assert.strictEqual(a.isThreadBusy('t1'), true, '旧对话的 busy 仍在');
    assert.strictEqual(a.threadMessages('t1').length, 4, '旧对话的本地消息保留');
    assert.strictEqual(a.queue.length, 0, '新对话从空队列开始');
    assert.strictEqual(a.pendingUrgent, null, '新对话没有上一段的「立即发送」');
    assert.strictEqual(a.draft, '', '新对话从空草稿开始');
    assert.strictEqual(a.threadQueue('t1').length, 1, '旧对话的队列保留');
    assert.strictEqual(a.threadPendingUrgent('t1').id, 'q2', '旧对话的立即发送保留');
    assert.strictEqual(a.threadDraft('t1'), '会话一没发出去的草稿', '旧对话的草稿保留');

    /* 9) 后台任务结束触发的列表刷新不劫持当前对话 */
    backend.state.active = 't1';
    await a.loadThreads();
    assert.strictEqual(a.activeThreadId, freshThread, '服务端 active_id 变了也不切走用户正在看的对话');

    /* 10) 当前对话已不在列表里：这时才采用服务端 active_id */
    backend.state.rows = backend.state.rows.filter((row) => row.id !== freshThread);
    backend.state.active = 't1';
    await a.loadThreads();
    assert.strictEqual(a.activeThreadId, 't1', '当前对话不存在了才跟随服务端');
    assert.strictEqual(a.queue.length, 1, '切回会话一恢复队列');
    assert.strictEqual(a.pendingUrgent.id, 'q2', '切回会话一恢复「立即发送」');
    assert.strictEqual(a.draft, '会话一没发出去的草稿', '切回会话一恢复草稿');

    /* 11) 切换对话不丢队列 / 立即发送 / 草稿，各会话各存各的 */
    a.setThreadQueue('t3', [queued('q3', '会话三的排队消息')]);
    a.setThreadPendingUrgent('t3', queued('q4', '会话三的立即发送'));
    a.setThreadDraft('t3', '会话三的草稿');
    assert.strictEqual(await a.switchThread('t3'), true);
    assert.strictEqual(a.queue.length, 1);
    assert.strictEqual(a.queue[0].id, 'q3', '切到会话三只看到自己的队列');
    assert.strictEqual(a.pendingUrgent.id, 'q4', '切到会话三恢复自己的立即发送');
    assert.strictEqual(a.draft, '会话三的草稿');
    assert.strictEqual(a.threadQueue('t1').length, 1, '会话一的队列不受影响');
    assert.strictEqual(a.threadPendingUrgent('t1').id, 'q2');
    assert.strictEqual(a.threadDraft('t1'), '会话一没发出去的草稿');
    assert.strictEqual(await a.switchThread('t1'), true);
    assert.strictEqual(a.queue[0].id, 'q1', '切回会话一队列还在');
    assert.strictEqual(a.pendingUrgent.id, 'q2', '切回会话一立即发送还在');
    assert.strictEqual(a.draft, '会话一没发出去的草稿', '切回会话一草稿还在');

    /* 12) ensureThread 把 "__new__" 本地状态迁到新线程 id，消息不丢 */
    const second = makeBackend();
    second.state.rows = [];
    second.state.active = '';
    global.window.novai.task.command = second.command;
    const b = new AgentState('canvas-new');
    await settle();
    assert.strictEqual(b.activeThreadId, '', '没有服务端 active 时保持空线程');
    b.appendMessage({ id: 'first', role: 'u', text: '第一条消息' });
    b.draft = '还没发出去的话';
    b.queue = [queued('b1', '新画布排队消息')];
    b.pendingUrgent = queued('b2', '新画布立即发送');
    assert.strictEqual(b.msgs.length, 1, '__new__ 桶能先收消息');
    const created = await b.ensureThread();
    assert.ok(created, 'ensureThread 应建出线程 id');
    assert.strictEqual(b.activeThreadId, created);
    assert.strictEqual(b.msgs.length, 1, '迁移后消息不丢');
    assert.strictEqual(b.msgs[0].text, '第一条消息');
    assert.strictEqual(b.threadMessages(created).length, 1);
    assert.strictEqual(b.threadQueue(created).length, 1, '迁移后队列不丢');
    assert.strictEqual(b.threadPendingUrgent(created).id, 'b2', '迁移后「立即发送」不丢');
    assert.strictEqual(b.threadDraft(created), '还没发出去的话', '迁移后草稿不丢');

    /* 13) dispose / 账号切换清空线程缓存，不把上一个账号的对话带过去 */
    b.dispose();
    assert.strictEqual(b.activeThreadId, '');
    assert.strictEqual(b.msgs.length, 0);
    assert.strictEqual(b.isThreadBusy(created), false);
    assert.strictEqual(b.queue.length, 0, 'dispose 后当前对话队列为空');
    assert.strictEqual(b.threadQueue(created).length, 0, 'dispose 清空所有对话的队列缓存');

    /* ── 源码契约：面板的读写都要走线程级 API ── */
    const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
    const stateSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/state.ts'), 'utf8');

    assert.ok(stateSrc.includes('get msgs(): AgentMsg[]'), 'msgs 变成按线程取');
    assert.ok(stateSrc.includes('get busy(): boolean'), 'busy 变成按线程取');
    assert.ok(stateSrc.includes('get stop(): boolean'), 'stop 变成按线程取');
    assert.ok(stateSrc.includes('get historyHasMore(): boolean'), 'historyHasMore 变成按线程取');
    assert.ok(stateSrc.includes('threadMessages(threadId: string)'));
    assert.ok(stateSrc.includes('patchMessage(msg: AgentMsg, patch: Partial<AgentMsg>)'));
    assert.ok(stateSrc.includes('goalBefore(msg: AgentMsg)'));
    assert.ok(stateSrc.includes('setThreadBusy(threadId: string, busy: boolean)'));
    assert.ok(stateSrc.includes('setThreadStop(threadId: string, stop: boolean)'));
    assert.ok(stateSrc.includes('isThreadBusy(threadId: string)'));
    assert.ok(stateSrc.includes('get queue(): QueuedMsg[]'), '待发送队列按对话取');
    assert.ok(stateSrc.includes('get pendingUrgent(): QueuedMsg | null'), '立即发送按对话取');
    assert.ok(stateSrc.includes('get draft(): string'), '草稿按对话取');
    assert.ok(stateSrc.includes('queue: QueuedMsg[];'), 'ThreadLocal 里存队列');
    assert.ok(stateSrc.includes('pendingUrgent: QueuedMsg | null;'), 'ThreadLocal 里存立即发送');
    assert.ok(stateSrc.includes('draft: string;'), 'ThreadLocal 里存草稿');
    assert.ok(stateSrc.includes('threadQueue(threadId: string)'), '按对话读队列（后台自动发送用）');
    assert.ok(stateSrc.includes('setThreadQueue(threadId: string, list: QueuedMsg[])'));
    assert.ok(stateSrc.includes('threadPendingUrgent(threadId: string)'));
    assert.ok(stateSrc.includes('setThreadPendingUrgent(threadId: string, item: QueuedMsg | null)'));
    assert.ok(stateSrc.includes('threadDraft(threadId: string)'));
    assert.ok(stateSrc.includes('setThreadDraft(threadId: string, text: string)'));
    assert.ok(!stateSrc.includes('this.queue = [];'), '切换 / 新建对话不再清空共享队列');
    assert.ok(stateSrc.includes('value.queue = []; value.pendingUrgent = null; value.draft = "";'), '新建对话只初始化新会话的空队列 / 草稿');
    assert.ok(stateSrc.includes('value.queue = [...pending.queue, ...value.queue];'), 'ensureThread 迁移队列');
    assert.ok(stateSrc.includes('value.draft = pending.draft || value.draft;'), 'ensureThread 迁移草稿');
    assert.ok(stateSrc.includes('if (activeId && (!this.activeThreadId || !rows.some((row) => row.id === this.activeThreadId))) this.activeThreadId = activeId;'), 'loadThreads 不再无条件劫持 active');

    assert.ok(panel.includes('const patch = (m: AgentMsg, p: Partial<AgentMsg>) => a.patchMessage(m, p);'), '顶层 patch 走线程归属');
    assert.ok(panel.includes('const patch = (p: Partial<AgentMsg>) => a.patchMessage(m, p);'), '消息组件 patch 走线程归属');
    assert.ok(panel.includes('a.goalBefore(m)'), '问答卡用消息所属线程的上一句用户消息');
    assert.ok(!panel.includes('goalOf(m)'), '旧的全局 goalOf 已移除');
    assert.ok(panel.includes('async function send(fromQa = false, outgoing?: QueuedMsg["snap"], targetThreadId?: string)'), 'send 支持目标对话（后台队列自动发送）');
    assert.ok(panel.includes('let threadId = target || a.activeThreadId;'), 'send 一开始就捕获线程');
    assert.ok(panel.includes('a.appendMessage({ id: mid(), role: "u"'), '用户消息写进捕获的线程');
    assert.ok(panel.includes('a.appendMessage(m, tId)'), '助手消息写进捕获的线程');
    assert.ok(panel.includes('threadId: threadId || undefined, selectedNodeIds'), 'runAgentTask 带发起时的线程 id');
    assert.ok(panel.includes('watchTask(m, submitted.taskId, t0, tId)'), 'watchTask 绑定线程');
    assert.ok(panel.includes('watchTask(m2, res.taskId, t0, threadId)'), '重新生成同样绑定线程');
    assert.ok(panel.includes('watchTask(m, res.taskId, performance.now(), threadId)'), '方案执行同样绑定线程');
    assert.ok(panel.includes('function watchTask(m: AgentMsg, taskId: string, t0: number, threadId: string)'));
    assert.ok(panel.includes('a.setThreadBusy(threadId, !settled); a.setThreadStop(threadId, false); a.emit();'), '任务快照只改自己线程的忙闲');
    assert.ok(panel.includes('a.setThreadBusy(tId, false)'), '收尾只清自己线程的 busy');
    assert.ok(panel.includes('a.setThreadBusy(threadId, false)'), '方案 / 安装收尾按线程清 busy');
    assert.ok(panel.includes('a.pendingUrgent'), '立即发送挂在 AgentState 上');
    assert.ok(!panel.includes('setPendingUrgent'), '不再用组件内 useState 存立即发送');
    assert.ok(!/a\.busy\s*=\s*(true|false)/.test(panel), '面板不再直接写共享 busy');
    assert.ok(panel.includes('[a.busy, a.queue, a.pendingUrgent, a.activeThreadId, activeModelId]'), '自动发送 effect 依赖当前线程');
    assert.ok(panel.includes('if (!a.queue.length && !a.pendingUrgent)'), '自动发送用线程级立即发送判断');
    assert.ok(panel.includes('(target ? a.isThreadBusy(target) : a.busy)'), '后台发送检查目标对话的忙闲');
    assert.ok(panel.includes('async function flushThreadQueue(threadId: string)'), '自动发送按对话执行');
    assert.ok(panel.includes('a.threadPendingUrgent(tId)') && panel.includes('takeFirst(a.threadQueue(tId))'), '按目标对话取立即发送 / 队首');
    assert.ok(panel.includes('a.setThreadQueue(tId, taken.rest); a.emit();'), '从目标对话队列移除再发');
    assert.ok(panel.includes('await send(false, item.snap, tId)'), '自动发送用目标对话发送');
    assert.ok(panel.includes('queueFlushing.current.has(tId)') && panel.includes('queueFlushing.current.add(tId)'), 'queueFlushing 按对话隔离');
    assert.ok(panel.includes('function scheduleFlush(threadId: string)'), '按对话安排 260ms 自动发送');
    assert.ok(panel.includes('if (settled) { void a.loadThreads(); scheduleFlush(threadId); }'), '后台对话结束也安排自己的自动发送');
    assert.ok(panel.includes('const switched = !!lastThread.current && lastThread.current !== a.activeThreadId;'), '切对话后重新判断忙闲（首次加载不算）');
    assert.ok(panel.includes('if (!becameIdle && !(switched && !a.busy)) return;'), '切到空闲且有队列的对话也触发自动发送');
    assert.ok(panel.includes('scheduleFlush(a.activeThreadId);'), '当前对话兜底安排自动发送');
    assert.ok(panel.includes('flushTimers.current.forEach((timer) => window.clearTimeout(timer));'), '卸载时清掉所有对话的定时器');
    assert.ok(panel.includes('function debugSimulateSend(a: AgentState, text: string, skillName: string | null, ms: number, threadId?: string, onDone?: () => void)'), '调试模拟支持目标对话');
    assert.ok(panel.includes('onDone?.();'), '调试模拟结束继续跑该对话的队列');
    assert.ok(panel.includes('a.appendMessages([ask, reply], tId);'), '调试模拟只写目标对话');

    console.log('test_novai_canvas_agent_threads: 全部断言通过（线程级 msgs/busy 隔离 / 后台 patch 归属 / 切回不覆盖运行中消息 / 新建对话 / 队列·立即发送·草稿按会话隔离 / ensureThread 迁移 / 列表不改 active）');
})().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
