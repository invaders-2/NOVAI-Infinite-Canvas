#!/usr/bin/env node
/* task-17（BEAT）：
   1) 「NOVAI 任务」执行中卡片整体移除（终态/执行中都不出现），失败/阻塞文案仍在回复里；
   2) 菜单/弹层滚动条隐藏但保留滚动；
   3) 助手模型二级菜单不能被 #pop 的 overflow 裁掉（供应商→二级列表→选中）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const panel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
const task = read('novai-canvas-ui/src/canvas/canvas-next/agent/task.ts');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');

// ---- 1. 任务卡整体移除，失败/阻塞文案保留 ----
assert.ok(!panel.includes('NOVAI 任务'), '不再渲染「NOVAI 任务」卡');
assert.ok(!panel.includes('data-task-status') && !panel.includes('TASK_CARD_QUIET'), '执行中/终态都不出任务状态卡');
assert.ok(panel.includes('<TaskPlanCard plan={m.task.plan}'), '待确认方案卡仍在');
assert.ok(panel.includes('taskAnswer(snapshot, refreshOutcome)') && task.includes('任务失败') && task.includes('任务已阻塞'), '失败/阻塞信息仍由回复文案给出');

// ---- 2. 菜单/弹层滚动条隐藏但保留可滚动 ----
assert.ok(css.includes('scrollbar-width:none'), '菜单滚动条隐藏（Firefox/标准）');
assert.ok(css.includes('.cn-root #pop::-webkit-scrollbar') && css.includes('.cn-root #modal::-webkit-scrollbar') && css.includes('.cn-root .model-flyout::-webkit-scrollbar'), '主要弹层都覆盖 ::-webkit-scrollbar');
assert.ok(css.includes('display:none;width:0;height:0'), 'WebKit 滚动条 display:none');
assert.ok(!/#pop::-webkit-scrollbar\{width:6px/.test(css), '不再保留上一版可见细滚动条');
assert.ok(css.includes('.cn-root .model-providers::-webkit-scrollbar'), '模型供应商列表滚动条也隐藏');

// ---- 3. 助手模型二级菜单：整条交互链 + 不被 #pop 裁剪 ----
assert.ok(panel.includes('data-agent-vendor={vendor}') && panel.includes('onPointerEnter={(e) => show(vendor, e.currentTarget)}') && panel.includes('onClick={(e) => show(vendor, e.currentTarget, e.detail === 0)}'), '点供应商行会打开二级');
// 二级列表改由 Combobox 渲染：items 仍是 optionsOf(active.vendor)（按供应商过滤），行内容由 renderItem 给出
assert.ok(panel.includes('id="agent-model-options"') && panel.includes('role="group"') && panel.includes('optionsOf(active.vendor)'), '二级列表按供应商渲染');
// 选中仍走同一个回调，只是从行内 onClick 换成组合框的 onPick；data-agent-model 仍挂在每一项上
assert.ok(panel.includes('"data-agent-model": m.id') && panel.includes('onPick={(m) => { close(); onChoose(m.id); }}'), '二级模型项可选中并回调');
assert.ok(panel.includes('placePopover({ anchor: box(active.row)'), '二级 flyout 仍有视口夹取/翻边');
assert.ok(css.includes('.cn-root #pop.model-pop{overflow:visible}'), '模型菜单 #pop 不裁剪二级 flyout');
assert.ok(css.includes('.cn-root .model-providers{max-height:min(300px,calc(100vh - 320px));overflow-y:auto'), '供应商列表自己滚动（收紧到 300px，给模型强度滑块留位置）');

// ---- 4. F2 完成前自检「待核对」中性样式 + E5 授权卡「预计需要」 ----
const card = read('novai-canvas-ui/src/canvas/canvas-next/agent/AutonomyCard.tsx');
const ap2css = read('novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css');
assert.ok(task.includes('items: Array<{ text: string; ok: boolean;'), '自检条目类型仍保留 ok');
assert.ok(task.includes('status?: string'), '自检条目类型补 status（pending = 待核对）');
assert.ok(task.includes('ok: row?.ok === true') && task.includes('status: typeof row?.status === "string" ? row.status : undefined'), 'taskSelfCheck 把 status 原样透传且不丢 ok');
const selfcheck = panel.slice(panel.indexOf('function SelfCheckLine'), panel.indexOf('const isReflect'));
assert.ok(selfcheck.includes('item.status === "pending"'), 'SelfCheckLine 识别 pending 项');
assert.ok(selfcheck.includes('!item.ok && item.status !== "pending"'), '未满足统计排除 pending');
assert.ok(selfcheck.includes('" 项待核对"') && selfcheck.includes('待核对'), 'pending 文案是「待核对」');
assert.ok(selfcheck.includes('tone === "failed" ? " is-fail" : " is-pending"') && selfcheck.includes('const tone = check.passed ? "passed" : unmet.length ? "failed" : "pending"'), 'pending 走中性 is-pending，is-fail 只给真正未满足项');
assert.ok(!/const unmet = check\.items\.filter\(\(item\) => !item\.ok\);/.test(selfcheck), '不再把所有 !ok（含 pending）都算未满足');
assert.ok(selfcheck.includes('tone === "pending" ? "history" : "alert"'), 'pending 用中性图标，不用告警图标');
assert.ok(ap2css.includes('.ap2-selfcheck.is-pending') && ap2css.includes('.ap2-selfcheck-pending'), '中性样式覆盖待核对行与明细行');
// E5：requested 只展示，不做上限 / 预填
assert.ok(card.includes('requested?: Partial<Record<Kind, number>>'), 'AutonomyBudget 补 requested');
assert.ok(card.includes('data-requested') && card.includes('预计需要：'), '授权卡展示「预计需要」只读文案');
assert.ok(card.includes('initial?.requested?.[row.kind]') && card.includes('data-requested-kind={row.kind}'), '按模态展示预计次数');
const maxesBlock = card.slice(card.indexOf('const [maxes, setMaxes]'), card.indexOf('const setMax ='));
assert.ok(maxesBlock.length > 0 && !maxesBlock.includes('requested'), 'requested 不参与上限预填');
assert.ok(card.includes('max: normalize(maxes.image)'), '提交仍走用户输入的上限 max');

console.log('[PASS] 任务卡移除 / 菜单滚动条隐藏 / 助手二级模型菜单可点可选 / 自检待核对中性 / 授权卡预计需要（4 组）');
