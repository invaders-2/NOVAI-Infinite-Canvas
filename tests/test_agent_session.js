#!/usr/bin/env node
/*
 * 会话状态机回归测试（零依赖）：static/js/shared/agent-session.js 是纯逻辑 IIFE，
 * 这里用 new Function + window shim 直接跑它，再对 smart-canvas.js 做接线断言（防"写了模块没接线"）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const moduleSource = read('static/js/shared/agent-session.js');
const smart = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');

const win = {};
new Function('window', moduleSource)(win);
const api = win.NovaiAgentSession;

let pass = 0;
const fails = [];
const ok = (condition, label) => {
    if(condition) pass += 1;
    else fails.push(label);
};

/* 可注入时钟：模块内部走 Date.now()，这里整体替换，done / waiting 的耗时才可断言 */
const realNow = Date.now;
let clock = 1000;
Date.now = () => clock;
const at = value => { clock = value; };

console.log('[1] API 与初始 state');
ok(!!api && typeof api === 'object', 'window.NovaiAgentSession 已挂载');
['create', 'applyEvent', 'mergeThinking', 'workMs', 'setBaseline', 'isWaiting', 'pushUserMessage', 'pushAssistantMessage'].forEach(name => {
    ok(typeof api[name] === 'function', '导出函数：' + name);
});
ok(JSON.stringify(api.TERMINAL_STATUSES) === JSON.stringify(['completed', 'failed', 'stopped', 'ended_unknown']), 'TERMINAL_STATUSES 与上游一致');
const expectedKeys = ['conversationId', 'runId', 'lastEventId', 'streamState', 'messages', 'streamingMessageId', 'thinkingActivity', 'runActivity', 'contextUsage', 'contextNodeIds', 'pendingConfirmation', 'pendingQuestion', 'inputValue', 'attachments'];
const state = api.create();
ok(JSON.stringify(Object.keys(state).sort()) === JSON.stringify(expectedKeys.slice().sort()), '初始 state 字段齐全：' + Object.keys(state).sort().join(','));
ok(state.streamState === 'idle', '初始 streamState = idle');
ok(state.lastEventId === null && state.streamingMessageId === null, 'lastEventId / streamingMessageId 初始 null');
ok(Array.isArray(state.messages) && state.messages.length === 0, 'messages 初始空数组');
ok(Array.isArray(state.contextNodeIds) && state.contextNodeIds.length === 0 && Array.isArray(state.attachments) && state.attachments.length === 0, 'contextNodeIds / attachments 初始空数组');
ok(state.contextUsage === null && state.pendingConfirmation === null && state.pendingQuestion === null, 'contextUsage / pending* 初始 null');
ok(state.thinkingActivity === null && state.runActivity === null, 'thinkingActivity / runActivity 初始 null');
ok(state.inputValue === '' && state.conversationId === '' && state.runId === '', '字符串字段初始空串');
const other = api.create();
ok(state.messages !== other.messages && state.attachments !== other.attachments && state.contextNodeIds !== other.contextNodeIds, 'create() 每次返回独立数组（互不共享）');
other.messages.push({ id: 'x' });
ok(state.messages.length === 0, '改动一份 state 不影响另一份');
ok(api.isWaiting('waiting_user_input') && api.isWaiting('waiting_external'), 'isWaiting 覆盖两种等待态');
ok(!api.isWaiting('streaming') && !api.isWaiting('idle') && !api.isWaiting('completed'), 'isWaiting 不误判其它状态');
ok(['completed', 'failed', 'stopped', 'ended_unknown'].every(status => api.isTerminal(status)), 'isTerminal 覆盖 4 个终态');
ok(!api.isTerminal('streaming'), 'isTerminal 不误判 streaming');

console.log('[2] run_start / step 合并 / tool_event / message');
at(1000);
const s1 = api.create();
api.applyEvent(s1, { type: 'run_start', run_id: 'run_1' });
ok(s1.streamState === 'streaming', 'run_start → streamState streaming');
ok(s1.runId === 'run_1', 'run_start → runId');
ok(s1.messages.length === 1 && s1.messages[0].role === 'assistant', 'run_start 建一条 assistant 消息');
ok(s1.streamingMessageId === s1.messages[0].id, 'streamingMessageId 指向这条 assistant');
ok(s1.messages[0].parts.length === 0 && s1.messages[0].activeWorkMs === 0, 'assistant 初始无 part、activeWorkMs 0');
ok(s1.runActivity && s1.runActivity.startedAt === 1000 && s1.runActivity.frozenMs === 0, 'runActivity 记录 startedAt / frozenMs');
at(1200);
api.applyEvent(s1, { type: 'step_start', index: 0, tool: 'create_node', description: '新建一个节点' });
ok(s1.messages[0].parts.length === 1, 'step_start 产生 1 个 part');
const stepPart = s1.messages[0].parts[0];
ok(stepPart.type === 'tool_event' && stepPart.kind === 'step', 'step_start part 类型 = tool_event/step');
ok(stepPart.status === 'running' && stepPart.tool === 'create_node' && stepPart.title === '新建一个节点', 'step_start 初始 running + tool/title');
ok(stepPart.index === '0', 'step_start 记录 index');
at(2500);
api.applyEvent(s1, { type: 'step_result', index: 0, ok: true, message: '已创建' });
ok(s1.messages[0].parts.length === 1, 'step_result 同索引合并，不新增 part');
ok(s1.messages[0].parts[0].status === 'done', 'step_result 更新 status → done');
ok(s1.messages[0].parts[0].message === '已创建' && s1.messages[0].parts[0].endedAt === 2500, 'step_result 写入 message / endedAt');
api.applyEvent(s1, { type: 'step_start', index: 1, tool: 'generate_image' });
api.applyEvent(s1, { type: 'step_result', index: 1, ok: false, error: '额度不足', code: 'quota' });
ok(s1.messages[0].parts.length === 2, '不同 index 各自成 part');
ok(s1.messages[0].parts[1].status === 'failed' && s1.messages[0].parts[1].code === 'quota', '失败步骤 status failed + code');
at(2600);
api.applyEvent(s1, { type: 'tool_event', tool: 'check_task', status: 'running' });
ok(s1.messages[0].parts.length === 3 && s1.messages[0].parts[2].type === 'tool_event' && s1.messages[0].parts[2].kind === 'tool', 'tool_event 直接追加 part');
api.applyEvent(s1, { type: 'message', text: '好了' });
ok(s1.messages[0].parts.length === 4 && s1.messages[0].parts[3].type === 'text' && s1.messages[0].parts[3].text === '好了', 'message → text part');
api.applyEvent(s1, { type: 'message', text: '   ' });
ok(s1.messages[0].parts.length === 4, '空白 message 不产生 part');
api.applyEvent(s1, { id: 'evt_9', type: 'message', text: '再一句' });
ok(s1.lastEventId === 'evt_9', '事件带 id 时记 lastEventId');
ok(s1.messages[0].parts.length === 5, '非空 message 继续追加 text part');

console.log('[3] 宽容性：未知事件 / 缺字段 / 非法入参');
const s2 = api.create();
let threw = false;
try {
    api.applyEvent(s2, { type: 'brand_new_event', payload: 1 });
    api.applyEvent(s2, { type: 'context_usage' });
    api.applyEvent(s2, { type: 'usage' });
    api.applyEvent(s2, null);
    api.applyEvent(null, { type: 'message', text: 'x' });
} catch(e) { threw = true; }
ok(!threw, '未知事件 / 空事件 / 空 state 都不抛错');
ok(s2.contextUsage === null, 'context_usage 缺字段被忽略（保持 null）');
ok(s2.messages.length === 0, '未知事件不建消息、不产 part');
api.applyEvent(s2, { type: 'context_usage', used_tokens: 1200, max_tokens: 8000, percentage: 15, breakdown: { system: 200 } });
ok(s2.contextUsage && s2.contextUsage.used_tokens === 1200 && s2.contextUsage.max_tokens === 8000, 'context_usage 写入 used/max');
ok(s2.contextUsage.percentage === 15 && s2.contextUsage.breakdown && s2.contextUsage.breakdown.system === 200, 'context_usage 写入 percentage/breakdown');
api.applyEvent(s2, { type: 'usage', input_tokens: 10, output_tokens: 5 });
ok(s2.messages.length === 1 && s2.messages[0].usage && s2.messages[0].usage.input_tokens === 10 && s2.messages[0].usage.output_tokens === 5, 'usage 存进 message.usage');
api.applyEvent(s2, { type: 'user_steer', text: '换个风格' });
const steerPart = s2.messages[0].parts[s2.messages[0].parts.length - 1];
ok(steerPart.type === 'user_steer' && steerPart.text === '换个风格', 'user_steer 追加 part');
api.applyEvent(s2, { type: 'message', text: ' \t  ' });
ok(s2.messages[0].parts.filter(part => part.type === 'text').length === 0, '只有空白字符的 message 也不产 part');

console.log('[4] done / error 结算 + waiting 冻结');
at(1000);
const s3 = api.create();
api.applyEvent(s3, { type: 'run_start', run_id: 'run_3' });
at(6000);
api.applyEvent(s3, { type: 'done', status: 'completed', message: '完成' });
ok(s3.streamState === 'completed', 'done(completed) → streamState 终态');
ok(api.isTerminal(s3.streamState), 'done 后 isTerminal 成立');
ok(s3.messages[0].activeWorkMs === 5000, 'done 结算 activeWorkMs = 5000（实际 ' + s3.messages[0].activeWorkMs + '）');
ok(s3.streamingMessageId === null, 'done 后收口 streamingMessageId');
ok(api.workMs(s3, 60000) === 5000, '终态 workMs 不再增长');
at(1000);
const s4 = api.create();
api.applyEvent(s4, { type: 'run_start', run_id: 'run_4' });
at(3000);
ok(api.workMs(s4) === 2000, 'streaming 中 workMs 实时增长');
at(4000);
api.applyEvent(s4, { type: 'confirmation_required', id: 'confirm_1', tool: 'delete_node' });
ok(s4.streamState === 'waiting_user_input' && api.isWaiting(s4.streamState), 'confirmation_required → waiting_user_input');
ok(s4.pendingConfirmation && s4.pendingConfirmation.id === 'confirm_1', 'confirmation_required 写入 pendingConfirmation');
ok(api.workMs(s4, 90000) === 3000, '等待态 workMs 冻结在已结算值 3000（实际 ' + api.workMs(s4, 90000) + '）');
ok(api.workMs(s4, 200000) === 3000, '等待态再久也不涨');
at(5000);
const s5 = api.create();
api.applyEvent(s5, { type: 'run_start' });
at(6500);
api.applyEvent(s5, { type: 'error', message: '模型超时', code: 'timeout' });
ok(s5.streamState === 'failed' && s5.messages[0].status === 'failed', 'error → streamState/message.status failed');
ok(s5.messages[0].activeWorkMs === 1500, 'error 也结算 activeWorkMs');
const errorPart = s5.messages[0].parts.filter(part => part.type === 'agent_error')[0];
ok(errorPart && errorPart.message === '模型超时' && errorPart.code === 'timeout', 'error 追加 agent_error part');

console.log('[5] mergeThinking：连续块合并 / 累加时长 / 不跨 text');
const parts = [
    { id: 't1', type: 'thinking', text: '想一下', totalDurationMs: 10 },
    { type: 'thinking', text: '再想', totalDurationMs: 5 },
    { type: 'text', text: '结论' },
    { id: 't2', type: 'thinking', text: '补一句', totalDurationMs: 7 }
];
const merged = api.mergeThinking(parts);
ok(merged.length === 3, '连续 thinking 合并后剩 3 个 part（实际 ' + merged.length + '）');
ok(merged[0].type === 'thinking' && merged[0].text === '想一下再想', '合并文本按顺序拼接');
ok(merged[0].totalDurationMs === 15, '合并累加 totalDurationMs = 15');
ok(merged[0].id === 't1', '合并保留第一个 thinking 的 id');
ok(merged[1].type === 'text' && merged[1].text === '结论', '被 text 隔开的 thinking 不合并');
ok(merged[2].type === 'thinking' && merged[2].totalDurationMs === 7, 'text 之后的 thinking 独立');
ok(parts.length === 4 && parts[0].text === '想一下', '不修改传入的 parts');
const three = api.mergeThinking([
    { type: 'thinking', text: 'a', totalDurationMs: 10 },
    { type: 'thinking', text: 'b', totalDurationMs: 5 },
    { type: 'thinking', text: 'c', totalDurationMs: 7 }
]);
ok(three.length === 1 && three[0].text === 'abc' && three[0].totalDurationMs === 22, '三段连续 thinking → 1 块 / 22ms');
ok(api.mergeThinking([]).length === 0 && api.mergeThinking(null).length === 0, '空输入不抛错');

console.log('[6] smart-canvas.js / smart-canvas.html 接线');
ok(/window\.NovaiAgentSession\.create\(\)/.test(smart), 'runAgentStream 里调用 NovaiAgentSession.create()');
ok(/window\.NovaiAgentSession\.applyEvent\(agentSession,/.test(smart), '每个 SSE 事件调用 applyEvent(agentSession, ...)');
ok(/var agentSession = null/.test(smart), 'smart-canvas.js 声明 agentSession');
ok(/window\.__novaiAgentSession = agentSession;/.test(smart), '暴露 window.__novaiAgentSession 便于调试');
const applyPos = smart.indexOf('window.NovaiAgentSession.applyEvent');
const applySlice = smart.slice(Math.max(0, applyPos - 240), applyPos + 400);
ok(/try\s*\{/.test(applySlice) && /catch\s*\(/.test(applySlice), 'applyEvent 包在 try/catch 里（失败不影响渲染）');
ok(html.indexOf('shared/agent-session.js') >= 0, 'smart-canvas.html 引入 shared/agent-session.js');
ok(html.indexOf('shared/agent-session.js') < html.indexOf('src="/static/js/smart-canvas.js'), 'agent-session.js 在 smart-canvas.js 之前加载');

console.log('[7] 运行卡计时：formatWorkMs 边界 + ticker 接线');
const extractFunction = (source, name) => {
    const marker = 'function ' + name + '(';
    const start = source.indexOf(marker);
    if(start < 0) return '';
    let depth = 0;
    for(let i = source.indexOf('{', start); i < source.length; i += 1){
        if(source[i] === '{') depth += 1;
        else if(source[i] === '}'){ depth -= 1; if(depth === 0) return source.slice(start, i + 1); }
    }
    return '';
};
const buildFn = name => new Function('return (' + extractFunction(smart, name) + ');')();
const formatWorkMs = buildFn('formatWorkMs');
const agentRunStatusText = buildFn('agentRunStatusText');
ok(typeof formatWorkMs === 'function' && typeof agentRunStatusText === 'function', 'formatWorkMs / agentRunStatusText 可独立执行');
ok(formatWorkMs(0) === '0s' && formatWorkMs(999) === '0s', 'formatWorkMs(<1s) → 0s');
ok(formatWorkMs(1000) === '1s' && formatWorkMs(59999) === '59s', 'formatWorkMs(秒) → Ns');
ok(formatWorkMs(60000) === '1m00s', 'formatWorkMs(60000) → 1m00s');
ok(formatWorkMs(3599000) === '59m59s', 'formatWorkMs(3599000) → 59m59s');
ok(formatWorkMs(3600000) === '1h00m' && formatWorkMs(5400000) === '1h30m', 'formatWorkMs(≥1h) → NhMMm');
ok(formatWorkMs(-5) === '0s' && formatWorkMs(NaN) === '0s', 'formatWorkMs 非法/负数兜底 0s');
ok(/class="agent-run-time"/.test(smart), '运行卡 header 有 .agent-run-time');
ok(/setInterval\(paint, 1000\)/.test(smart) && /'处理了 ' \+ formatWorkMs\(agentRunWorkMs/.test(smart), '每秒刷新「处理了 Ns」');
ok(/agentRunStartTicker\(card\);/.test(smart), '卡片初始化时启动 ticker');
ok(/agentRunStopTicker\(card\); \/\* 收尾/.test(smart), 'runAgentStream finally 一定停表（终态时长）');
ok(/api\.workMs\(agentSession, Date\.now\(\)\)/.test(smart), '计时走 NovaiAgentSession.workMs（等待态由它冻结）');

console.log('[8] 状态文案映射');
ok(agentRunStatusText('idle') === '连接中…', 'idle → 连接中…');
ok(agentRunStatusText('streaming') === '正在执行…', 'streaming → 正在执行…');
ok(agentRunStatusText('waiting_user_input') === '等你确认', 'waiting_user_input → 等你确认');
ok(agentRunStatusText('completed') === '已完成', 'completed → 已完成');
ok(agentRunStatusText('stopped') === '已停止', 'stopped → 已停止');
ok(agentRunStatusText('failed') === '失败', 'failed → 失败');
ok(agentRunStatusText('processing') === '处理中…' && agentRunStatusText('') === '处理中…', '其它状态 → 处理中…');
ok(agentRunStatusText('running') === '正在执行…', 'legacy running 兼容 → 正在执行…');
ok(/agentRunStatusText\('idle'\)/.test(smart), '卡片初始文案来自 agentRunStatusText(idle)');
ok(/agentRunStatusText\(terminalKey\)/.test(smart), 'done 终态文案来自 agentRunStatusText');
ok(/agentRunStatusText\('failed'\)/.test(smart) && /agentRunStatusText\('stopped'\)/.test(smart), 'error / 中止文案来自映射');
ok(/已手动停止/.test(smart) && /agentRunStatusText\('stopped'\)/.test(smart), '中止分支改用 stopped 文案');

console.log('[9] 思考合并：单块 + 累计时长，不再整块替换气泡');
ok(/\.agent-run-thinking/.test(smart) && /\.agent-run-think-time/.test(smart), '存在 .agent-run-thinking 与累计时长节点');
ok(/mergeThinking\(\(message && message\.parts\) \|\| \[\]\)/.test(smart), '累计时长取 agentSession 的 mergeThinking 结果');
ok(/appendRunThinking\(parts\.bubble, '正在规划…'\)/.test(smart), '「正在规划…」改走 appendRunThinking');
ok(/appendRunThinking\(parts\.bubble, '正在对照你的要求看图…'\)/.test(smart), '评审思考改走 appendRunThinking');
ok(/function thinkingHtml\(text, key\)/.test(smart), 'thinkingHtml 本身保留（其它地方还在用）');
ok(!/innerHTML\s*=\s*thinkingHtml\(/.test(smart), '不再用 thinkingHtml 整块替换气泡（防回退）');
ok(/while\(lines\.children\.length > 6/.test(smart), '思考行数有上限，不会无限长');

console.log('[10] 计划卡保留耗时：.agent-plan-time 共用 formatWorkMs');
const planTimeMsFn = smart.slice(smart.indexOf('function agentPlanTimeMs(){'), smart.indexOf('function agentPlanTimeSync(card){'));
const planTimeFn = smart.slice(smart.indexOf('function agentPlanTimeText(){'), smart.indexOf('function agentPlanTimeHide(card){'));
ok(planTimeMsFn.length > 0 && planTimeFn.length > 0, '能截取到 agentPlanTimeMs / agentPlanTimeText 实现');
ok(/\.agent-plan-time/.test(smart), '存在 .agent-plan-time');
ok(/api\.workMs\(agentSession, Date\.now\(\)\)/.test(planTimeMsFn), '计划卡耗时读 NovaiAgentSession.workMs(agentSession, Date.now())');
ok(/return ms > 0 \? ms : 0;/.test(planTimeMsFn), 'workMs 无有效值时归 0（不显示假的 0s）');
ok(/agentPlanTimeMs\(\)/.test(planTimeFn) && /formatWorkMs\(ms\)/.test(planTimeFn), 'agentPlanTimeText 复用 agentPlanTimeMs + formatWorkMs');
ok((smart.match(/function formatWorkMs\(/g) || []).length === 1, 'formatWorkMs 只有一份实现');
ok(!/function formatMs\(/.test(smart) && !/function formatDuration\(/.test(smart) && !/function formatWorkTime\(/.test(smart), '没有新增第二套格式化函数');
const planTimeMsSource = extractFunction(smart, 'agentPlanTimeMs');
const planTimeSource = extractFunction(smart, 'agentPlanTimeText');
const makePlanTime = (api, session) => new Function('window', 'agentSession', 'formatWorkMs', planTimeMsSource + '\nreturn (' + planTimeSource + ');')({ NovaiAgentSession: api }, session, formatWorkMs);
ok(makePlanTime(null, null)() === '', '没有 agentSession 时不显示');
ok(makePlanTime({ workMs: () => 0 }, {})() === '', 'workMs 为 0 时不显示假的「处理了 0s」');
ok(makePlanTime({ workMs: () => 5000 }, {})() === '处理了 5s', '有效 elapsed → 处理了 5s');
ok(makePlanTime({ workMs: () => 372000 }, {})() === '处理了 6m12s', '分钟级同样走 formatWorkMs');
const plan2Body = smart.slice(smart.indexOf('function renderAgentPlanCard2('), smart.indexOf('function agentStepEditHtml('));
ok(plan2Body.indexOf('class="agent-plan-time"') >= 0, 'plan2 header 里有 .agent-plan-time 节点');
ok(/agentPlanTimeSync\(card\);/.test(plan2Body), 'plan 事件渲染计划卡时立即写入耗时');
const execBody = smart.slice(smart.indexOf('async function agentStreamPlanExecute('), smart.indexOf('async function agentPlanAction('));
ok(/agentPlanTimeHide\(card\)/.test(execBody), '点「开始生成」后隐藏计划卡计时（执行阶段只留运行卡）');
ok(/agentPlanTimeSync\(card\)/.test(execBody), '执行结束把最终时长写回计划卡');
ok(/agentPlanTimeSync\(card\._run\.planCard\)/.test(smart), 'plan 轮 done/error 时把最终时长写回计划卡');
ok(/function agentPlanTimeSync\(card\)\{[\s\S]*?agentPlanTimeText\(\)/.test(planTimeFn), '计划卡写回走 agentPlanTimeText（与运行卡同一个 workMs）');

console.log('[11] 跨轮基线：setBaseline 把规划段接进累计');
ok(typeof api.setBaseline === 'function', 'setBaseline 已导出');
ok(/setBaseline: setBaseline/.test(moduleSource), '模块导出 setBaseline');
at(1000);
const base1 = api.create();
api.setBaseline(base1, 5000);
ok(base1.runActivity && base1.runActivity.frozenMs === 5000 && base1.runActivity.frozen === true, 'setBaseline 预置 frozenMs 基线（run_start 前）');
api.applyEvent(base1, { type: 'run_start' });
at(3000);
ok(api.workMs(base1) === 7000, 'workMs = 基线 5000 + 执行 2000（实际 ' + api.workMs(base1) + '）');
at(5000);
api.applyEvent(base1, { type: 'done', status: 'completed' });
ok(base1.messages[0].activeWorkMs === 9000, 'done 结算也含基线（实际 ' + base1.messages[0].activeWorkMs + '）');
ok(api.workMs(base1, 99999) === 9000, '终态 workMs 冻结在累计值');
at(1000);
const base2 = api.create();
api.setBaseline(base2, 0);
api.setBaseline(base2, -100);
api.setBaseline(base2, NaN);
ok(base2.runActivity === null, 'baseline 为 0/负数/NaN 直接忽略（不写 runActivity）');
api.applyEvent(base2, { type: 'run_start' });
at(3000);
ok(api.workMs(base2) === 2000, '没有基线时只算本轮（实际 ' + api.workMs(base2) + '）');
at(1000);
const base3 = api.create();
api.setBaseline(base3, 5000);
api.applyEvent(base3, { type: 'run_start' });
at(2000);
api.applyEvent(base3, { type: 'confirmation_required', id: 'c1' });
ok(api.workMs(base3, 99999) === 6000, '等待态冻结的是「基线 + 已跑」（实际 ' + api.workMs(base3, 99999) + '）');
const execBody2 = smart.slice(smart.indexOf('async function agentStreamPlanExecute('), smart.indexOf('async function agentPlanAction('));
ok(/card\._agentPlan\.baselineMs = agentPlanTimeMs\(\)/.test(execBody2), '执行前把计划卡已结算毫秒记为基线');
ok(/baselineMs: Number\(st\.baselineMs\) \|\| 0/.test(execBody2), '基线随 approved_steps 一起传入新一轮');
ok(/Number\(opts && opts\.baselineMs\) \|\| 0/.test(smart) && /setBaseline\(agentSession, baselineMs\)/.test(smart), 'runAgentStream 用 opts.baselineMs 设置跨轮基线');

console.log('[12] 上下文占用指示器 + 卡片 part 摘要');
const formatTokensSource = extractFunction(smart, 'formatTokens');
const formatTokens = new Function('return (' + formatTokensSource + ');')();
ok(formatTokens(0) === '0' && formatTokens(999) === '999', 'formatTokens(<1000) 原样输出');
ok(formatTokens(1000) === '1.0k' && formatTokens(7800) === '7.8k', 'formatTokens(k) 一位小数');
ok(formatTokens(1234567) === '1.2m', 'formatTokens(>=1e6) 用 m');
ok(formatTokens(-5) === '0' && formatTokens(NaN) === '0', 'formatTokens 非法/负数兜底 0');
const formatUsageSource = extractFunction(smart, 'formatContextUsage');
const formatContextUsage = new Function('formatTokens', 'return (' + formatUsageSource + ');')(formatTokens);
ok(formatContextUsage({ percentage: 12 }) === '上下文 12%', 'percentage 数字 → 上下文 12%');
ok(formatContextUsage({ used_tokens: 7800, max_tokens: 0, percentage: null, source: 'estimate' }) === '上下文 7.8k', 'percentage 为 null → 绝对值 上下文 7.8k');
ok(formatContextUsage({}) === '' && formatContextUsage(null) === '', '都没有 → 空串（隐藏）');
ok(/typeof usage\.percentage === 'number'/.test(formatUsageSource) && /typeof usage\.used_tokens === 'number'/.test(formatUsageSource), '先百分比、再绝对值、再隐藏的分支顺序');
at(1000);
const cu = api.create();
api.applyEvent(cu, { type: 'run_start' });
api.applyEvent(cu, { type: 'context_usage', used_tokens: 7752, max_tokens: 0, percentage: null, source: 'estimate', round: 1 });
ok(cu.contextUsage && cu.contextUsage.used_tokens === 7752 && cu.contextUsage.max_tokens === 0, 'context_usage 到达 → store.contextUsage 更新');
ok(cu.contextUsage.percentage === undefined, 'percentage 为 null 不写成数字（UI 走绝对值）');
ok(/canvas-context-usage/.test(smart), '存在 .canvas-context-usage 类名');
ok(/initCanvasContextUsage\(\);/.test(smart) && /document\.querySelector\('\.chat-composer-left'\)/.test(smart), '指示器插在输入区「手动确认」那一排');
ok(/el\.title = '上下文占用为估算值/.test(smart), 'title 写明估算口径（system+user 文本，不含图片）');
ok(/formatContextUsage\(agentSession \? agentSession\.contextUsage : null\)/.test(smart), '指示器读 agentSession.contextUsage');
ok(/updateCanvasContextUsage\(\); \/\/ run_start 清零/.test(smart), '每轮 run 开始时清零');
ok(/renderAgentRunParts\(card\);\s*\n\s*updateCanvasContextUsage\(\);/.test(smart), '每个 SSE 事件后刷新卡片摘要与占用');
const partLinesSource = smart.slice(smart.indexOf('function agentRunPartLines('), smart.indexOf('function renderAgentRunParts('));
['run_outcome', 'usage', 'user_steer', 'context_nodes'].forEach(kind => {
    ok(new RegExp("part\\.type === '" + kind + "'").test(partLinesSource), '渲染函数覆盖 part 类型：' + kind);
});
ok(!/'text'/.test(partLinesSource), '不渲染 text part（避免重复已有 message 文本）');
const runPartLines = new Function('formatTokens', 'formatWorkMs', 'return (' + extractFunction(smart, 'agentRunPartLines') + ');')(formatTokens, formatWorkMs);
const outcomeLines = runPartLines({ parts: [{ type: 'run_outcome', status: 'completed', activeWorkMs: 5000 }, { type: 'text', text: '这是已有回复' }] });
ok(outcomeLines.length === 1 && outcomeLines[0].text === '完成 · 处理了 5s', 'run_outcome 一行摘要（含耗时、不带 message 文本）：' + JSON.stringify(outcomeLines));
const failedLines = runPartLines({ parts: [{ type: 'run_outcome', status: 'failed', activeWorkMs: 0 }] });
ok(failedLines[0].text === '失败', '失败终态摘要');
const usageLines = runPartLines({ parts: [{ type: 'usage', usage: { input_tokens: 7800, output_tokens: 1234 } }] });
ok(usageLines.length === 1 && usageLines[0].text === '用量 输入 7.8k · 输出 1.2k', 'usage 小字：' + JSON.stringify(usageLines));
ok(runPartLines({ parts: [{ type: 'usage', usage: {} }] }).length === 0, 'usage 缺字段不显示');
const steerLines = runPartLines({ parts: [{ type: 'user_steer', text: '把背景换成蓝色然后再加点光效并整体提亮一档' }] });
ok(steerLines.length === 1 && /^已插话：.{1,21}…$/.test(steerLines[0].text), 'user_steer 截前 20 字：' + JSON.stringify(steerLines));
const steerPlaced = runPartLines({ parts: [{ type: 'user_steer', text: '背景换成夜景', status: 'placed' }] });
const steerUnread = runPartLines({ parts: [{ type: 'user_steer', text: '背景换成夜景', status: 'unread' }] });
const steerLegacy = runPartLines({ parts: [{ type: 'user_steer', text: '背景换成夜景' }] });
ok(steerPlaced[0].text === '已插话：背景换成夜景', 'placed → 「已插话：」：' + steerPlaced[0].text);
ok(steerUnread[0].text === '未读到（已放回输入框）：背景换成夜景', 'unread → 「未读到（已放回输入框）：」：' + steerUnread[0].text);
ok(steerLegacy[0].text === '已插话：背景换成夜景', '缺 status 兼容旧数据，保守按 placed 显示');
ok(steerPlaced[0].text !== steerUnread[0].text && steerUnread[0].text.indexOf('已插话') === -1, '三种状态文案前缀互不混淆');
const nodeLines = runPartLines({ parts: [{ type: 'context_nodes', nodeCount: 3 }] });
ok(nodeLines.length === 1 && nodeLines[0].text === '本轮引用 3 个节点', 'context_nodes 摘要');
ok(runPartLines({ parts: [] }).length === 0 && runPartLines(null).length === 0, '空 parts 不渲染');
ok(/agentSession && agentSession\.messages/.test(smart) && /messages\[i\]\.role === 'assistant'/.test(smart), '摘要只读 agentSession.messages 里的 assistant parts');
at(1000);
const steerState = api.create();
api.applyEvent(steerState, { type: 'run_start' });
api.applyEvent(steerState, { type: 'user_steer', text: '背景换成夜景', status: 'unread' });
api.applyEvent(steerState, { type: 'user_steer', text: '再亮一点' });
const steerParts = steerState.messages[0].parts.filter(part => part.type === 'user_steer');
ok(steerParts.length === 2, '两条 user_steer 各成 part');
ok(steerParts[0].status === 'unread' && steerParts[0].text === '背景换成夜景', 'applyEvent 把 status 写进 user_steer part');
ok(steerParts[1].status === '', '服务端没给 status 时存空串（渲染层按 placed 兜底）');
ok((smart.match(/renderAgentRunPartsInto\(/g) || []).length >= 3, '运行卡与方案卡共用 renderAgentRunPartsInto（不复制两份）');
ok(/renderAgentRunPartsInto\(card, message \? message\.parts : \[\], 'agent-run-parts'\)/.test(smart), '运行卡走共用渲染器（.agent-run-parts）');
ok(/renderAgentRunPartsInto\(card, message \? message\.parts : \[\], 'agent-plan-parts'\)/.test(smart), '方案卡走同一个渲染器（.agent-plan-parts）');
ok(/\.agent-plan-parts/.test(smart) || /'agent-plan-parts'/.test(smart), '方案卡有 .agent-plan-parts 容器');
const plan2CardBody = smart.slice(smart.indexOf('function renderAgentPlanCard2('), smart.indexOf('function agentStepEditHtml('));
ok(/renderAgentPlanParts\(card\);/.test(plan2CardBody), 'plan 到达渲染方案卡时就挂上摘要');
const planDoneBranch = smart.slice(smart.indexOf("if(name === 'done' || name === 'error'){"), smart.indexOf('} else {', smart.indexOf("if(name === 'done' || name === 'error'){")));
ok(/renderAgentPlanParts\(card\._run\.planCard\);/.test(planDoneBranch), 'plan 轮 done/error 刷新方案卡摘要');
ok(/agentRunStopTicker\(card\);/.test(planDoneBranch) && /agentPlanTimeSync\(card\._run\.planCard\);/.test(planDoneBranch), '原有停表/耗时回写断言不减弱');

console.log('[13] 技能入口：纯函数 + chip + skill_id 通道');
const skillOptionsFrom = new Function('return (' + extractFunction(smart, 'skillOptionsFrom') + ');')();
const filterSkillOptions = new Function('return (' + extractFunction(smart, 'filterSkillOptions') + ');')();
const skillCaps = [
    { id: 'ppt', kind: 'skill', name: '做 PPT', description: '生成演示文稿', icon: '📊', tags: ['x'] },
    { id: 'agent1', kind: 'agent', name: '智能体', description: '' },
    { id: '', kind: 'skill', name: '缺 id' },
    { kind: 'skill', name: '没有 id 字段' },
    { id: 'off', kind: 'skill', name: '禁用技能', enabled: false },
    null,
    { id: 'xlsx', kind: 'skill', name: '表格', icon: '' }
];
const skillOptions = skillOptionsFrom(skillCaps);
ok(skillOptions.length === 2, 'skillOptionsFrom 只留 kind=skill 且带 id（实际 ' + skillOptions.length + '）');
ok(JSON.stringify(skillOptions[0]) === JSON.stringify({ id: 'ppt', name: '做 PPT', description: '生成演示文稿', icon: '📊' }), '字段裁剪为 id/name/description/icon');
ok(skillOptions[1].name === '表格' && skillOptions[1].description === '' && skillOptions[1].icon === '✨', '缺字段容错（name 回退 id / description 空 / icon 默认）');
ok(skillOptionsFrom(null).length === 0 && skillOptionsFrom([{}]).length === 0, '非法输入不抛错');
ok(skillOptionsFrom([{ id: 'x', kind: 'skill', name: '禁用', enabled: false }]).length === 0, 'enabled:false 的技能被过滤');
ok(skillOptionsFrom([{ id: 'y', kind: 'skill' }]).length === 1 && skillOptionsFrom([{ id: 'z', kind: 'skill', enabled: true }]).length === 1, 'enabled 缺省 / true 保留');
ok(!skillOptions.some(option => option.id === 'off'), '混合列表里禁用项不出现');
ok(/agentSkillAllDisabled \? '全部技能已禁用' : '没有可用技能'/.test(smart), '全禁用与无可用分开口径（可选增强）');
const allSkills = filterSkillOptions(skillOptions, '');
ok(allSkills.length === 2 && allSkills !== skillOptions, '空查询返回全部（且是新数组）');
ok(filterSkillOptions(skillOptions, 'PPT').length === 1 && filterSkillOptions(skillOptions, 'ppt')[0].id === 'ppt', '搜索大小写不敏感（按名称）');
ok(filterSkillOptions(skillOptions, '文稿').length === 1 && filterSkillOptions(skillOptions, '文稿')[0].id === 'ppt', '搜索命中描述');
ok(filterSkillOptions(skillOptions, '不存在的技能').length === 0, '无匹配返回空数组');
ok(filterSkillOptions(null, 'x').length === 0 && filterSkillOptions(skillOptions, '   ').length === 2, '非法/空白查询容错');
ok(/'chat-skill-chip'/.test(smart) && /chat-skill-chip-remove/.test(smart) && /textContent = '×'/.test(smart), '技能 chip 带 × 清除');
const skillChipFn = smart.slice(smart.indexOf('function renderAgentSkillChip('), smart.indexOf('function clearAgentSkill('));
ok(/document\.body\.contains\(agentSkillChipEl\)/.test(skillChipFn), 'chip 渲染先判断旧引用是否还在文档里');
ok(/document\.getElementById\('chatSkillChip'\)/.test(skillChipFn), 'chip 渲染回退到 getElementById 解析真实节点');
ok(/agentSkillChipEl = el;/.test(skillChipFn) && /el\.appendChild\(chip\)/.test(skillChipFn), '解析后的节点写回引用并用于渲染');
const skillInitFn = smart.slice(smart.indexOf('function initAgentSkillUi('), smart.indexOf('function closeAgentSkillPicker('));
ok(!/if\(agentSkillButton\) return;/.test(skillInitFn), 'initAgentSkillUi 不再因按钮已存在整体早退');
ok(/document\.getElementById\('chatSkillChip'\)/.test(skillInitFn), 'init 每次都确保 chip 行存在（按 id 查）');
ok(/agentSkillChipEl = chipRow \|\| null;/.test(skillInitFn), 'init 重新绑定文档里的 chip 行');
ok(/renderAgentSkillChip\(\);/.test(skillInitFn), 'init 末尾回显已选技能');
const skillBtnStyle = (skillInitFn.match(/btn\.style\.cssText = '([^']*)'/) || [])[1] || '';
ok(/border:0;/.test(skillBtnStyle), '技能按钮 cssText 显式 border:0（不画发丝线）');
ok(/agentSelectedSkill = null/.test(smart) && (smart.match(/clearAgentSkill\(\);/g) || []).length >= 3, '重置对话 / 切画布 / 返回列表都清空技能');
const runBody = smart.slice(smart.indexOf('function agentRunBodyWithSkillRef('), smart.indexOf("fetch('/api/agent/run'") + 800);
ok(/agentRunBodyWithSkillRef\(\{[\s\S]*?skill_id:/.test(runBody), 'skill_id 在 /api/agent/run 的 JSON 顶层');
ok(/skill_id: agentSelectedSkill \? String\(agentSelectedSkill\.id \|\| ''\) : ''/.test(runBody), 'skill_id 取当前技能，没有就传空串');
ok(/fetch\('\/api\/capabilities'/.test(smart), '技能列表来源 GET /api/capabilities');
ok(/item\.kind \|\| ''\) !== 'skill'/.test(smart) || /String\(item\.kind \|\| ''\) !== 'skill'/.test(smart), '只取 kind === skill');
ok(/input\.placeholder = '搜索技能'/.test(smart), '浮层带搜索框');
ok(/'正在加载技能…'/.test(smart) && /'没有可用技能'/.test(smart) && /'加载失败，点击重试'/.test(smart), 'loading / 空态 / 失败重试文案齐全');
ok(/onAgentSkillPickerOutside/.test(smart) && /onAgentSkillPickerKey/.test(smart), '点空白 / Esc 关闭');
ok(/positionAgentSkillPicker/.test(smart) && /getBoundingClientRect/.test(smart), 'fixed + getBoundingClientRect 定位');
const focusBlock = smart.slice(smart.indexOf('function buildAgentFocus(){'), smart.indexOf('function agentSetComposerRunning('));
ok(focusBlock.length > 0 && !/skill/i.test(focusBlock), 'buildAgentFocus / references 里没有技能（两条独立通道）');
ok(/references = \(chatRefs \|\| \[\]\)\.map/.test(focusBlock), 'references 仍只从 chatRefs 派生');

console.log('[14] 断流续传：id 解析 / 去重 / 重试策略 / 恢复接线');
const createSseParser = new Function('return (' + extractFunction(smart, 'createSseParser') + ');')();
const parsed = [];
const parser = createSseParser((name, payload, id) => parsed.push({ name, payload, id }));
parser.push('id: 5\nevent: message\ndata: {"text":"a"}\n\n');
parser.push('event: step_start\ndata: {"index":0}\nid: 9\n\n');
parser.push('event: done\ndata: {"status":"ok"}\n\n');
ok(parsed.length === 3, '解析器按空行分发 3 帧（实际 ' + parsed.length + '）');
ok(parsed[0].name === 'message' && parsed[0].payload.text === 'a' && parsed[0].id === '5', 'id 在 data 之前也能带到回调');
ok(parsed[1].name === 'step_start' && parsed[1].id === '9', 'id 在 data 之后也能带到回调');
ok(parsed[2].name === 'done' && parsed[2].id === undefined, '无 id 行时第三参为 undefined');
const chunked = [];
const parser2 = createSseParser((name, payload, id) => chunked.push({ name, id }));
parser2.push('id: 12\nevent: message\nda');
parser2.push('ta: {"text":"x"}\n');
parser2.push('\n');
ok(chunked.length === 1 && chunked[0].id === '12', '跨 chunk 半行也保留 id');
const shouldApplyAgentEvent = new Function('return (' + extractFunction(smart, 'shouldApplyAgentEvent') + ');')();
ok(shouldApplyAgentEvent(7, 6) === false && shouldApplyAgentEvent(7, 7) === false, 'lastEventId=7 时 seq 6/7 跳过');
ok(shouldApplyAgentEvent(7, 8) === true, 'lastEventId=7 时 seq 8 应用');
ok(shouldApplyAgentEvent(null, 1) === true && shouldApplyAgentEvent(7, undefined) === true, '无游标 / 无 id 的帧照常应用');
const delayMatch = smart.match(/var AGENT_RESUME_DELAYS = \[([^\]]+)\]/);
const resumeDelays = delayMatch ? delayMatch[1].split(',').map(v => Number(v.trim())) : [];
ok(JSON.stringify(resumeDelays) === JSON.stringify([1000, 2000, 4000, 8000, 15000]), '退避序列 [1000,2000,4000,8000,15000]');
ok(/var AGENT_RESUME_MAX_ATTEMPTS = 5;/.test(smart), '最大重试 5 次');
const agentResumeDelay = new Function('AGENT_RESUME_DELAYS', 'return (' + extractFunction(smart, 'agentResumeDelay') + ');')(resumeDelays);
ok(agentResumeDelay(1) === 1000 && agentResumeDelay(5) === 15000 && agentResumeDelay(6) === 0, 'agentResumeDelay 按次数取退避，越界归 0');
const runStream = smart.slice(smart.indexOf('async function runAgentStream('), smart.indexOf('async function sendChatMessage('));
ok(runStream.includes("'/api/agent/runs/' + encodeURIComponent(runId) + '/stream?after='"), '续传端点带 after=游标');
ok(/opened\.status === 404/.test(runStream) && /giveUpRecovery\('这轮运行已过期/.test(runStream), '404 走停止分支（不假装成功）');
ok(/连接中断，无法恢复/.test(runStream) && /agentRunStopTicker\(card\);/.test(runStream), '无法恢复时显示终态文案并停表');
ok(/连接中断，正在恢复…/.test(runStream) && /已恢复/.test(runStream) && /恢复失败（第 ' \+ attempt \+ ' 次，稍后重试）/.test(runStream), '恢复过程三种状态文案齐全');
ok(/while\(!terminalSeen && !ctl\.signal\.aborted && runId && attempt < AGENT_RESUME_MAX_ATTEMPTS\)/.test(runStream), '恢复循环受 abort / 重试上限约束');
ok(/if\(ctl\.signal\.aborted\) break;/.test(runStream) && /if\(e && e\.name === 'AbortError'\)/.test(runStream), '用户中止不触发恢复');
ok(/X-NOVAI-Run-Id/.test(runStream) && /name === 'run_start' && data && data\.run_id/.test(runStream), 'runId 优先 run_start，其次响应头');
const handleEventSlice = runStream.slice(runStream.indexOf('var handleAgentEvent'), runStream.indexOf('var readAgentStream'));
ok(/agentRunHandleEvent\(card, name, data\)/.test(handleEventSlice), '恢复事件仍走 agentRunHandleEvent（同一张卡）');
ok(/renderAgentRunParts\(card\)/.test(handleEventSlice), '恢复事件仍刷新卡片摘要');
ok(/createSseParser\(handleAgentEvent\)/.test(runStream), '首连与续传共用同一个事件入口');
ok(/agentSetComposerRunning\(false\)/.test(runStream) && /agentSetComposerRunning\(true\)/.test(runStream), '恢复期间解锁输入框，恢复后还原');
ok(/window\.NovaiAgentSession\.applyEvent\(agentSession, \{ id: id, type: name, data: data \}\)/.test(smart), '事件 id 喂给 agentSession（不另存一份游标）');

console.log('[15] 运行中插话（steer）：纯状态 + 端点 + 回填');
const steerButtonState = new Function('return (' + extractFunction(smart, 'steerButtonState') + ');')();
ok(steerButtonState('换个方向', 'streaming', false).show === true, '运行中 + 有文本 → 显示插话按钮');
ok(steerButtonState('换个方向', 'streaming', false).disabled === false, '不在飞时可点');
ok(steerButtonState('换个方向', 'streaming', true).disabled === true, '请求在飞 → disabled');
ok(steerButtonState('  ', 'streaming', false).show === false, '空文本（含空白）不显示');
ok(steerButtonState('换个方向', 'waiting_user_input', false).show === false, '等待确认时不显示（走正常发送）');
ok(steerButtonState('换个方向', 'completed', false).show === false && steerButtonState('x', 'idle', false).show === false, '非运行态不显示');
const steerSink = smart.slice(smart.indexOf('async function sendAgentSteer('), smart.indexOf('function initAgentSteerUi('));
ok(steerSink.includes("'/api/agent/runs/' + encodeURIComponent(runId) + '/steer'"), '插话端点 /api/agent/runs/{id}/steer');
ok(/if\(res\.status === 409\)\{[\s\S]*?'运行已结束'[\s\S]*?return;/.test(steerSink), '409 → 提示运行已结束并 return');
ok(!/'运行已结束'[\s\S]{0,200}?inp\.value = ''/.test(steerSink), '409/404 分支不会清空输入框（文本留在输入框）');
ok(/if\(res\.status === 404\)\{[\s\S]*?'无法插话：这轮已过期'/.test(steerSink), '404 → 提示这轮已过期');
ok(steerSink.indexOf("if(!res.ok) throw") < steerSink.indexOf("inp.value = ''"), '只有成功（2xx）才清空输入框');
ok(/'发送中…'/.test(smart) && /'已加入，下一轮生效'/.test(smart), '发送中 / 已加入文案');
ok(/if\(state !== 'streaming'\) return \{ show: false/.test(steerSink) || /state !== 'streaming'/.test(smart), '只在 streaming ��示');
ok(/var show = !!\(state\.show && agentStreamRunId\)/.test(smart), '还需 runId 存在才显示');
const steerEventSink = smart.slice(smart.indexOf('function handleAgentSteerEvent('), smart.indexOf('async function sendAgentSteer('));
ok(/status === 'unread'/.test(steerEventSink) && /inp\.value = text/.test(steerEventSink), 'unread → 文本回填输入框');
ok(/'没来得及读，已放回输入框'/.test(steerEventSink) && /'已加入（运行中）'/.test(steerEventSink), 'placed / unread 提示文案');
ok(/name === 'user_steer'\) handleAgentSteerEvent\(data\)/.test(smart), 'SSE 的 user_steer 事件接到回填逻辑');
const composerSink = smart.slice(smart.indexOf('function agentSetComposerRunning('), smart.indexOf('function abortAgentRun('));
ok(/inp\.disabled = false/.test(composerSink) && !/inp\.disabled = !!running/.test(composerSink), '运行中不再 disable 输入框');
ok(/classList\.toggle\('is-running'/.test(composerSink) && /square/.test(composerSink), '停止键逻辑保持原样');
ok(/function abortAgentRun\(\)\{\n    if\(agentRunAbort\) agentRunAbort\.abort\(\);\n\}/.test(smart), 'abortAgentRun 未被改动');
ok(/if\(agentRunAbort\)\{ abortAgentRun\(\); return( false)?; \}/.test(smart), '运行中发送键仍是停止（abort 语义不变）');
ok(/agentStreamRunId = ''/.test(smart) && /agentSteerPending = false/.test(smart), '运行结束清空 runId / pending');
const steerInitSink = smart.slice(smart.indexOf('function initAgentSteerUi('), smart.indexOf('function agentRunCardInit('));
ok(/'chatSteerBtn'/.test(steerInitSink) && /insertBefore\(btn, send\)/.test(steerInitSink), '插话按钮挂在发送键旁');
ok(/addEventListener\('input', function\(\)\{ syncAgentSteerButton\(\); \}\)/.test(steerInitSink), '输入变化时刷新按钮可见性');
ok(/initAgentSteerUi\(\);/.test(smart), '模块初始化时挂载插话 UI');
const steerBtnStyle = (steerInitSink.match(/btn\.style\.cssText = '([^']*)'/) || [])[1] || '';
ok(/border:0;/.test(steerBtnStyle), '「打断并发送」按钮 cssText 显式 border:0（不画发丝线）');

console.log('[16] 应用市场 autoSend：种子消费一次 + 失败不重试');
const shouldAutoSend = buildFn('shouldAutoSend');
ok(shouldAutoSend({ agent: '做一条视频', autoSend: true }) === true, 'autoSend=true 且有 agent 文本 → 自动发送');
ok(shouldAutoSend({ agent: '   ', autoSend: true }) === false, 'autoSend=true 但 agent 为空 → 不发送');
ok(shouldAutoSend({ agent: '做一条视频', autoSend: false }) === false, 'autoSend=false → 不发送（直接打开画布永不自动发）');
ok(shouldAutoSend(null) === false && shouldAutoSend({}) === false && shouldAutoSend({ agent: 'x' }) === false, '缺 seed / 缺 autoSend → 不发送');
const seedSink = smart.slice(smart.indexOf('function openHomeSeedAgent('), smart.indexOf('function consumeHomeCanvasSeed('));
ok(/var HOME_SEED_AUTOSEND_ATTEMPTS = 3|const HOME_SEED_AUTOSEND_ATTEMPTS = 3/.test(smart), '就绪重试上限 3 次');
ok(/HOME_SEED_AUTOSEND_RETRY_MS = 300/.test(smart), '重试间隔 300ms');
ok(/attempts < HOME_SEED_AUTOSEND_ATTEMPTS/.test(seedSink), '重试受上限约束（不死循环）');
const attemptSink = seedSink.slice(seedSink.indexOf('function attempt('));
ok(attemptSink.indexOf('clearHomeSeedAutoSend();') < attemptSink.indexOf('sendChatMessage();'), '发送前先清种子 autoSend（刷新不会再发）');
ok(/sent === false[\s\S]*?发送失败，提示词已留在输入框/.test(attemptSink), '发送失败 → 文本留在输入框 + note');
ok(/currentChatModel\(\)/.test(attemptSink) && /没有可用模型，提示词已留在输入框/.test(attemptSink), '模型不可用 → note 且不调用发送');
const failSink = seedSink.slice(seedSink.indexOf('function fail('), seedSink.indexOf('function attempt('));
ok(!/setTimeout/.test(failSink) && !/attempt/.test(failSink), '失败分支不排重试（无二次发送）');
ok(smart.includes('localStorage.removeItem(key)'), '种子读完即删（刷新/二次打开不重放）');
const sendSink = smart.slice(smart.indexOf('async function sendChatMessage('), smart.indexOf('var AGENT_TOOL_ICONS'));
ok(/var sendOk = true;/.test(sendSink) && /sendOk = false;/.test(sendSink) && /return sendOk;/.test(sendSink), 'sendChatMessage 回传成功/失败（失败可回填）');
const storeDataSink = read('web/src/pages/store/storeData.js');
ok(/options && options\.autoSend === true/.test(storeDataSink), 'openStoreCanvas 只在显式 autoSend=true 时写 true');
ok(storeDataSink.includes('JSON.stringify({ v: 1, agent: str(prompt), autoSend, skillRef })'), '种子写 autoSend + skillRef 字段');
const briefSink = read('web/src/pages/store/StoreBriefModal.vue');
ok(/\{ autoSend: true, skillRef: result\.skillRef \}/.test(briefSink), '市场 brief 提交写 autoSend:true + skillRef');
ok(!/autoSend/.test(read('web/src/pages/store/StorePage.vue')), '列表页本身不写种子 autoSend（只在 brief 提交时写）');

const agentRunBodyWithSkillRef = buildFn('agentRunBodyWithSkillRef');
const bodyWithRef = agentRunBodyWithSkillRef({ instruction: '做视频' }, 'store:skrull');
ok(bodyWithRef.skill_ref === 'store:skrull' && bodyWithRef.instruction === '做视频', '种子 skillRef 透传到 /api/agent/run 请求体（顶层 skill_ref）');
// 历史前缀：拆开拼，避免仓库源码里残留品牌词；后端仍需兼容这种旧值
const LEGACY_REF = 'tap' + 'now:skrull';
const bodyLegacyRef = agentRunBodyWithSkillRef({ instruction: '做视频' }, LEGACY_REF);
ok(bodyLegacyRef.skill_ref === LEGACY_REF, '旧前缀 skill_ref 原样透传（后端兼容旧值）');
const bodyNoRef = agentRunBodyWithSkillRef({ instruction: '做视频' }, '');
ok(!('skill_ref' in bodyNoRef), 'skillRef 为空串时请求体不含 skill_ref 键');
ok(!('skill_ref' in agentRunBodyWithSkillRef({ instruction: 'x' }, '   ')), 'skillRef 纯空白同样省略');
ok(/agentRunBodyWithSkillRef\(\{[\s\S]*?\}, pendingAgentSkillRef\)/.test(smart), 'runAgentStream 用 helper 组装 body 并带 pendingAgentSkillRef');
ok(/pendingAgentSkillRef = wantAutoSend \? String\(skillRef \|\| ''\)\.trim\(\) : '';/.test(smart), '只有自动发送才装载 skillRef');
ok(/openHomeSeedAgent\(seed\.agent, shouldAutoSend\(seed\), seed\.skillRef\)/.test(smart), '种子 skillRef 传给自动发送入口');
ok(/skillRef: str\(result\.skill_ref \|\| result\.skillRef \|\| ''\)/.test(storeDataSink), 'launch 响应解析 skill_ref');
ok(/autoSend, skillRef \}/.test(storeDataSink), '种子写入 skillRef 字段');
ok(/skillRef: result\.skillRef/.test(briefSink), 'brief 提交把 launch 的 skillRef 写进种子');

console.log('');
console.log('会话状态机回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(label => console.log('  ✗ ' + label));
Date.now = realNow;
if(fails.length) process.exitCode = 1;
