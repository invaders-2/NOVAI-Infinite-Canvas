#!/usr/bin/env node
'use strict';
/*
 * 画布助手「待发送」消息队列：queue.ts 纯逻辑 + AgentPanel / agent-panel-v2.css 源码字面量。
 * 队列是纯前端内存结构（切线程清空），所以这里不碰后端。
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

const queue = load('novai-canvas-ui/src/canvas/canvas-next/agent/queue.ts');
const { QUEUE_MAX, enqueue, removeQueued, takeFirst, markUrgent, prependUrgent } = queue;

const snap = (text) => ({ text, skill: null, pinned: [], selected: [], refs: [], webPlugin: false });
const item = (n) => ({ id: 'q' + n, label: '消息 ' + n, snap: snap('消息 ' + n) });

// 1) 上限 5：第 6 条被拒，原列表一条不少
assert.strictEqual(QUEUE_MAX, 5, '队列上限必须是 5');
let list = [];
for (let i = 1; i <= QUEUE_MAX; i += 1) {
    const added = enqueue(list, item(i));
    assert.strictEqual(added.ok, true, '第 ' + i + ' 条应该能入队');
    list = added.list;
}
assert.strictEqual(list.length, 5);
const rejected = enqueue(list, item(6));
assert.strictEqual(rejected.ok, false, '第 6 条必须被拒');
assert.strictEqual(rejected.list.length, 5, '被拒时不能丢掉已有的 5 条');

// 2) FIFO：先入先出，取走的那条不在剩余列表里
const first = takeFirst(list);
assert.strictEqual(first.first.id, 'q1', '应取队首');
assert.deepStrictEqual(first.rest.map((x) => x.id), ['q2', 'q3', 'q4', 'q5'], '取首条后顺序不变');
assert.strictEqual(list.length, 5, 'takeFirst 不能改原数组');

// 3) 删除：按 id 移除，其它顺序不变
const removed = removeQueued(list, 'q3');
assert.deepStrictEqual(removed.map((x) => x.id), ['q1', 'q2', 'q4', 'q5']);
assert.strictEqual(removeQueued(removed, 'nope').length, 4, '删不存在的 id 不改变长度');

// 4) 「立即优先」插队：takeFirst 先取 urgent，即使它在队尾
const urgent = markUrgent(list, 'q4');
assert.strictEqual(takeFirst(urgent).first.id, 'q4', '立即优先应该先发');
assert.strictEqual(takeFirst(list).first.id, 'q1', 'markUrgent 不能改原数组');

// 5) 空队列
assert.deepStrictEqual(takeFirst([]), { first: null, rest: [] });

// 6) 忙碌时连点两条「立即发送」：第一条在 pendingUrgent 等空闲，第二条标 urgent 插到队首，两条都不丢
const waiting = item(1);
const behind = [item(2), item(3)];
const promoted = prependUrgent(behind, item(4));
assert.deepStrictEqual(promoted.map((x) => x.id), ['q4', 'q2', 'q3'], '新点的那条插到队首');
assert.strictEqual(promoted[0].urgent, true, '新点的那条标 urgent');
assert.strictEqual(promoted[1].urgent, undefined, '其余条目不受影响');
assert.strictEqual(waiting.urgent, undefined, '已在等空闲的 pendingUrgent 不被改写');
assert.deepStrictEqual(behind.map((x) => x.id), ['q2', 'q3'], 'prependUrgent 不改入参');
const afterPending = takeFirst(promoted);
assert.strictEqual(afterPending.first.id, 'q4', 'pendingUrgent 发完后先发第二条点击的');
assert.deepStrictEqual(afterPending.rest.map((x) => x.id), ['q2', 'q3'], '再之后才是原队列');
assert.deepStrictEqual(prependUrgent(promoted, item(2)).map((x) => x.id), ['q2', 'q4', 'q3'], '重复插入按 id 去重');
assert.deepStrictEqual(behind.map((x) => x.id), ['q2', 'q3'], '重复插入同样不改入参');

// ── 源码字面量：UI 结构 / 交互 / 样式 ───────────────────────────────
const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
const state = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/state.ts'), 'utf8');
const cssFile = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css'), 'utf8');

const at = (needle) => {
    const i = panel.indexOf(needle);
    assert.ok(i >= 0, 'AgentPanel.tsx 缺少：' + needle);
    return i;
};

// 队列容器在 .ap2-composer 内、输入框与 ctxrow 之前
const composerAt = at('className="ai ap2-composer"');
const queueAt = at('id="aQueue"');
const ctxAt = at('id="aCtx"');
const inputAt = at('id="aiInput"');
assert.ok(composerAt < queueAt, '队列必须放在 .ap2-composer 内');
assert.ok(queueAt < ctxAt, '队列必须在 .ctxrow 之前');
assert.ok(queueAt < inputAt, '队列必须在输入框之前');
assert.ok(panel.includes('className="ap2-queue"'), '队列容器 class 用 ap2-queue');
assert.ok(panel.includes('待发送'), '队列头部文案「待发送」');
assert.ok(panel.includes('助手结束后自动发送'), '队列头部小字');
assert.ok(panel.includes('{a.queue.length}/{QUEUE_MAX}'), '计数 n/5');

// 每行三个动作：编辑 / 立即发送 / 删除
const editAt = at('aria-label="编辑排队消息"');
const sendAt = at('aria-label="立即发送"');
const deleteAt = at('aria-label="删除排队消息"');
assert.ok(editAt < sendAt && sendAt < deleteAt, '三个动作顺序：编辑 / 立即发送 / 删除');
for (const icon of ['name="pencil"', 'name="send"', 'name="x"']) {
    assert.ok(panel.includes(icon), '队列按钮缺少线性图标：' + icon);
}
assert.ok(panel.includes('title={item.label}'), '文本 title 显示全文');

// 上限 + 不丢输入
assert.ok(panel.includes('队列最多 " + QUEUE_MAX + " 条，等前面的发完再加'), '队列满的提示');
const enqueueBody = panel.slice(at('const enqueueDraft = () => {'), at('const editQueued ='));
assert.ok(enqueueBody.includes('if (!added.ok)'), '满了必须在清空输入前返回');
assert.ok(enqueueBody.includes('a.draft = ""'), '入队后清空输入框');
assert.ok(enqueueBody.includes('a.pinned = []; a.refs = []; a.skill = null; setWebPlugin(false);'), '入队后清空胶囊 / 技能 / 联网');
assert.ok(enqueueBody.includes('已加入队列（第 " + a.queue.length + " 条）'), '入队 toast');
assert.ok(enqueueBody.includes('pinned: [...a.pinned]') && enqueueBody.includes('selected: [...store.state.ui.sel]'), '快照带 pinned / selected');
assert.ok(enqueueBody.includes('webPlugin'), '快照带本轮联网开关');

// 忙碌时 Enter 入队，空闲时照旧发送
assert.ok(panel.includes('onEnter={() => { if (a.busy) enqueueDraft(); else void send(); }}'), 'Enter 分支：忙入队 / 闲发送');
assert.ok(panel.includes('助手执行中 · 按 Enter 加入队列'), '全屏忙碌 placeholder');
assert.ok(panel.includes('"Enter 加入队列"'), '窄面板忙碌 placeholder');

// 自动发送：空闲 + 260ms + takeFirst
const flushBody = panel.slice(at('const flushQueue = async () => {'), at('// 助手刚由忙转闲'));
assert.ok(flushBody.includes('takeFirst(a.queue)'), '自动发送取队首');
assert.ok(flushBody.includes('a.queue = taken.rest; a.emit();'), '发之前先从队列移除');
assert.ok(panel.includes('window.setTimeout(() => { flushTimer.current = 0; void flushQueue(); }, 260)'), '空闲后 260ms 自动发');
assert.ok(panel.includes('const becameIdle = wasBusy.current && !a.busy;'), '只认忙变闲这一下，不抽空虚队列');
assert.ok(panel.includes('if (!becameIdle || flushTimer.current) return;'), '忙碌 / 空队列不触发');
assert.ok(panel.includes('flushTimer.current = window.setTimeout(() => { flushTimer.current = 0; void flushQueue(); }, 260);'), '定时器放 ref，动队列不取消自动发送');

// 编辑还原 + 立即发送 + 切线程清空
const editBody = panel.slice(at('const editQueued = (item: QueuedMsg) => {'), at('const deleteQueued ='));
assert.ok(editBody.includes('a.draft = item.snap.text'), '编辑还原原始文本（含 @ 记号）');
assert.ok(editBody.includes('setWebPlugin(item.snap.webPlugin)'), '编辑还原联网开关');
assert.ok(editBody.includes('edRef.current?.focus()'), '编辑后聚焦输入框');
assert.ok(editBody.includes('已放回输入框，改完再发'), '编辑 toast');
const nowBody = panel.slice(at('const sendQueuedNow = (item: QueuedMsg) => {'), at('const flushQueue ='));
assert.ok(nowBody.includes('setPendingUrgent(item)') && nowBody.includes('stopTask()'), '忙碌时立即发送先停当前任务再优先发');
assert.ok(nowBody.includes('已停止当前任务，马上发送这条'), '立即发送 toast');
assert.ok(nowBody.includes('if (!a.busy) { void send(false, item.snap); return; }'), '空闲时立即发送直接发');
assert.ok(nowBody.includes('if (pendingUrgent) {'), '忙碌时已有 pendingUrgent 走独立分支');
const pendingBranch = nowBody.slice(nowBody.indexOf('if (pendingUrgent) {'), nowBody.indexOf('setPendingUrgent(item)'));
assert.ok(pendingBranch.includes('prependUrgent(a.queue, item)'), '第二条立即发送插到优先队首');
assert.ok(pendingBranch.includes('a.queue = prependUrgent(a.queue, item); a.emit();'), '插队后刷新队列');
assert.ok(pendingBranch.includes('return;'), '这一分支直接返回，不再 setPendingUrgent 覆盖前一条');
assert.ok(pendingBranch.includes('当前任务结束后马上发这条'), '第二条的 toast 说明当前任务结束后发');
assert.ok(/import \{[^}]*prependUrgent[^}]*\} from "\.\.\/canvas-next\/agent\/queue"/.test(panel), 'AgentPanel 从 queue 引入 prependUrgent');

assert.ok(state.includes('queue: import("./queue").QueuedMsg[] = [];'), 'AgentState 增加 queue 字段');
const switchBody = state.slice(state.indexOf('async switchThread'), state.indexOf('async newThread'));
assert.ok(switchBody.includes('this.queue = [];'), '切线程清空队列');
const newBody = state.slice(state.indexOf('async newThread'), state.indexOf('async ensureThread'));
assert.ok(newBody.includes('this.queue = [];'), '新建对话清空队列');

assert.ok(panel.includes('send(fromQa = false, outgoing?: QueuedMsg["snap"])'), 'send 增加 outgoing 快照参数');
assert.ok(panel.includes('ctxNodes(outgoing ? { pinned: outgoing.pinned, selected: outgoing.selected } : undefined)'), 'ctxNodes 支持快照覆盖');
assert.ok(panel.includes('if (!outgoing) { a.draft = "";'), '发排队消息不清空当前草稿');

// 验收口
assert.ok(panel.includes('debugQueue') && panel.includes('debugBusy'), '调试口 debugQueue / debugBusy');
assert.ok(panel.includes('function debugQueueItems'), '调试队列注入');

// ── 样式：软底、无描边、窄面板不横向溢出 ─────────────────────────────
const cssStart = cssFile.indexOf('/* ── 待发送消息队列');
const cssEnd = cssFile.indexOf('.cn-root #agent.ap2-agent .ap2-ctxrow');
assert.ok(cssStart >= 0 && cssEnd > cssStart, 'agent-panel-v2.css 缺少队列样式段');
const queueCss = cssFile.slice(cssStart, cssEnd);
assert.ok(/\.ap2-queue\s*\{[^}]*border-radius:\s*14px/.test(queueCss), '队列圆角 14px');
assert.ok(/\.ap2-queue\s*\{[^}]*color-mix\(in srgb, var\(--fg\) 5%, transparent\)/.test(queueCss), '队列软底用 color-mix');
assert.ok(!/border:\s*1px/.test(queueCss), '队列样式不允许 1px 描边');
assert.ok(!/inset 0 0 0 1px/.test(queueCss), '队列样式不允许 inset 发丝线');
assert.ok(/\.ap2-queue-list\s*\{[^}]*max-height:\s*140px[^}]*overflow-y:\s*auto/.test(queueCss), '列表最大高度 + 内部滚动');
assert.ok(/\.ap2-queue-row\s*\{[^}]*min-height:\s*27px/.test(queueCss), '行高 27px');
assert.ok(/\.ap2-queue-row:hover\s*\{\s*background:\s*var\(--hover\)/.test(queueCss), '行 hover 软底');
assert.ok(/\.ap2-queue-text\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/.test(queueCss), '文本单行省略');
assert.ok(/\.ap2-queue-acts\s*\{[^}]*opacity:\s*0\.55/.test(queueCss), '按钮默认半透明');
assert.ok(/\.ap2-queue-row:focus-within \.ap2-queue-acts\s*\{\s*opacity:\s*1/.test(queueCss), 'focus-within 恢复不透明');
assert.ok(/\.ap2-queue-btn\s*\{[^}]*width:\s*23px[^}]*border-radius:\s*8px/.test(queueCss), '按钮 23px / 8px 圆角');
assert.ok(/\.ap2-queue-hd\s*\{[^}]*font-size:\s*11px/.test(queueCss), '头部 11px');

console.log('test_novai_canvas_agent_queue: 全部断言通过（' + QUEUE_MAX + ' 条上限 / FIFO / 编辑 / 立即发送 / 自动发送 / 切线程清空 / 样式）');