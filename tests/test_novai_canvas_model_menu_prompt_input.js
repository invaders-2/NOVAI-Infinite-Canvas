#!/usr/bin/env node
/* 2026-11-08：画布助手 / 首页「选择模型」子菜单改成 HextaUI Prompt Input 版式。
   契约：两级结构不变；二级去 header / 去能力副文案 / >8 才出搜索 / 行 38px·13px / 选中只留右侧 14px 线性对勾；
   一级供应商面板（304 / 300，给模型强度滑块留位）· 行 36px · 计数 11px · 线性 chevron；
   画布两级面板是磨砂玻璃底（一级 86% / 二级 84% + blur(42px) saturate(180%)）+ 统一柔和投影，
   零 border / 零发丝线 / 零 inset 描边；首页一级/二级同样磨砂（86% + blur(42px) saturate(180%)），
   首页一级供应商面板始终保留，二级是贴在一级左侧的子菜单浮层（absolute / right:100%，无间隙），
   top 跟随当前供应商行（划过别的供应商自动切换内容），无返回按钮 / 无 header。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const agentPanel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
const home = read('web/src/pages/home/HomePage.vue');
const canvasHtml = read('static/canvas.html');

// ---- 画布助手：两级结构 / 触发与选中契约保留 ----
assert.ok(agentPanel.includes('function AgentModelMenu('), '仍有两个供应商→模型的 AgentModelMenu');
assert.ok(agentPanel.includes('data-agent-vendor={vendor}'), '一级供应商行保留 data-agent-vendor');
assert.ok(agentPanel.includes('aria-haspopup="menu"') && agentPanel.includes('onPointerEnter={(e) => show(vendor, e.currentTarget)}'), '一级 hover / aria 契约保留');
assert.ok(agentPanel.includes('itemAttrs={(m) => ({ "data-agent-model": m.id })}'), '二级模型行保留 data-agent-model');
assert.ok(agentPanel.includes('onPick={(m) => { close(); onChoose(m.id); }}'), '选中回调 onPick / onChoose 保留');
assert.ok(agentPanel.includes('onEscape={hide}'), 'Esc 只关二级的 onEscape 保留');
assert.ok(agentPanel.includes('placePopover({') && agentPanel.includes('document.querySelector(".cn-root") || document.body'), 'portal 定位 placePopover 保留');
assert.ok(agentPanel.includes('createPortal(') && agentPanel.includes('model-flyout-portal'), '二级仍 portal 到 .cn-root');
assert.ok(agentPanel.includes('searchPlaceholder="搜索模型"'), '搜索占位文案保留');

// ---- 二级：去 header / 去副文案 / 搜索只在 >8 时出现 ----
const comboBlock = (agentPanel.match(/<ComboMenu[\s\S]*?\/>/) || [''])[0];
assert.ok(comboBlock, 'AgentModelMenu 仍用 ComboMenu');
assert.ok(!/header=\{/.test(comboBlock), '二级不再传 header（去掉「供应商 · 选择模型」标题）');
assert.ok(!/header=\{<div className="mh">/.test(agentPanel), '没有「供应商 · 选择模型」标题块');
assert.ok(!agentPanel.includes('能读图') && !agentPanel.includes('只读文字'), '去掉「能读图 / 只读文字」副文案');
assert.ok(comboBlock.includes('renderItem={(m) => <span className="nm">{m.name}</span>}'), '二级行内只有模型名');
assert.ok(comboBlock.includes('searchable={optionsOf(active.vendor).length > 8}'), '搜索框只在当前供应商 >8 个模型时显示');
assert.ok(!/searchable\s*$/m.test(comboBlock), '不再无条件 searchable');

// ---- 一级：供应商名 + 计数 + 线性 chevron ----
assert.ok(agentPanel.includes('<span className="nm">{vendor}</span><span className="n">{options.length} 个模型</span><Icon name="right" size="s" />'), '一级行 = 名字 + N 个模型 + 线性 chevron');
assert.ok(agentPanel.includes('<div className="mh">选择供应商</div>'), '一级标题收敛成「选择供应商」小字');
assert.ok(!agentPanel.includes('画布助手 · 选择供应商'), '一级标题不再带「画布助手 ·」前缀');

// ---- 二级 CSS：紧凑浮层 308 / 14 / 6 / 84% 磨砂底，行 38·13，选中不铺底只出 14px 对勾 ----
const flyRule = [...css.matchAll(/\.cn-root \.model-flyout\.model-flyout-portal\{[^}]*\}/g)].map((m) => m[0]).find((r) => /width:308px/.test(r)) || '';
assert.ok(flyRule && flyRule.includes('color-mix(in srgb,var(--panel) 84%,transparent)'), '二级浮层有最终覆盖块（84% 磨砂玻璃底）');
assert.ok(/width:308px/.test(flyRule) && /border-radius:14px/.test(flyRule) && /padding:6px/.test(flyRule), '浮层 308px / 14px 圆角 / 6px 内距');
assert.ok(/border:0/.test(flyRule) && !/inset/.test(flyRule), '浮层零 border / 零 inset 描边');
assert.ok(/-webkit-backdrop-filter:blur\(42px\) saturate\(180%\);backdrop-filter:blur\(42px\) saturate\(180%\)/.test(flyRule), '二级浮层磨砂（blur 42px / saturate 180%，含 -webkit-）');
assert.ok(/box-shadow:var\(--glass-shadow\)/.test(flyRule), '二级浮层用统一 glass-shadow（深浅色自动适配）');
assert.ok(css.includes('.cn-root .model-flyout-portal .combo .mi.combo-item{\n  min-height:38px;padding:0 10px;border-radius:9px'), '二级行 38px / 9px 圆角');
assert.ok(/\.cn-root \.model-flyout-portal \.combo \.mi\.combo-item\{[^}]*font-size:13px/.test(css), '二级行文字 13px');
assert.ok(/\.cn-root \.model-flyout-portal \.combo \.combo-item\.on\{background:transparent;color:var\(--fg\);font-weight:600\}/.test(css), '选中行不铺底 + 字重 600');
assert.ok(/\.cn-root \.model-flyout-portal \.combo \.combo-item\.on::before\{content:none\}/.test(css), '选中行没有铺底伪元素');
assert.ok(/\.cn-root \.model-flyout-portal \.combo \.combo-item\.on:after\{width:14px;height:14px;margin-left:auto\}/.test(css), '选中行右侧 14px 对勾');
const flySearch = (css.match(/\.cn-root \.model-flyout-portal \.combo-s\{[^}]*\}/) || [''])[0];
assert.ok(/height:32px/.test(flySearch) && /border-radius:10px/.test(flySearch) && /var\(--sunken\)/.test(flySearch), '搜索框 32px / 10px / 软底');
assert.ok(/\.cn-root \.model-flyout-portal \.combo-in\{font-size:12px\}/.test(css), '搜索输入 12px');
assert.ok(/\.cn-root \.model-flyout-portal \.combo-empty\{padding:0;/.test(css), '空态不占位（首行紧贴搜索框）');

// ---- 一级 CSS：304 / 14 / 6 / 86% 磨砂底，行 36·13，计数 11px，软底不铺深块 ----
const popRule = [...css.matchAll(/\.cn-root #pop\.model-pop\{[^}]*\}/g)].map((m) => m[0]).filter((r) => /width:304px/.test(r));
assert.strictEqual(popRule.length, 1, '一级面板有最终覆盖块（304 宽 / 86% 磨砂玻璃底）');
assert.ok(popRule[0].includes('color-mix(in srgb,var(--panel) 86%,transparent)'), '一级面板 86% 磨砂玻璃底');
assert.ok(/width:304px/.test(popRule[0]) && /border-radius:14px/.test(popRule[0]) && /padding:6px/.test(popRule[0]), '一级面板 304px / 14px / 6px');
assert.ok(/border:0/.test(popRule[0]) && !/inset/.test(popRule[0]), '一级面板零 border / 零 inset');
assert.ok(/-webkit-backdrop-filter:blur\(42px\) saturate\(180%\);backdrop-filter:blur\(42px\) saturate\(180%\)/.test(popRule[0]), '一级面板磨砂（blur 42px / saturate 180%，含 -webkit-）');
assert.ok(/box-shadow:var\(--glass-shadow\)/.test(popRule[0]), '一级面板用统一 glass-shadow（深浅色自动适配）');
assert.ok(/\.cn-root #pop\.model-pop \.model-menu \.mi\{\n  min-height:36px;padding:0 8px;border-radius:9px/.test(css), '一级行 36px');
assert.ok(/\.cn-root #pop\.model-pop \.model-menu \.mi \.n\{[^}]*font-size:11px/.test(css), '计数 11px');
assert.ok(/\.cn-root #pop\.model-pop \.model-menu \.mi \.nm\{[^}]*flex:1/.test(css), '供应商名占满左侧');
assert.ok(/\.cn-root #pop\.model-pop \.model-menu \.mi\{[^}]*font-size:13px/.test(css), '供应商名 13px');
assert.ok(/\.cn-root #pop\.model-pop \.model-menu \.mi\.open:not\(:disabled\)/.test(css) && /rgba\(var\(--ink\),\.07\)/.test(css), '展开 / hover 用半透明软底');
assert.ok(!/\.cn-root #pop\.model-pop \.model-menu[^{]*\{[^}]*border:1px/.test(css), '一级行不画边框');

// ---- 首页：一级 300 / 二级 300 / 行 36·38 / 13px / 无 header / >8 才搜索 ----
assert.ok(/\.hp-mpanel \{\n    width: 300px; padding: 6px; border-radius: 14px; border: 0;\n    background: color-mix\(in srgb, var\(--hp-pop\) 86%, transparent\);/.test(home), '首页一级面板 300 / 6 / 14 / 无 border / 磨砂底 86%');
assert.ok(home.includes('-webkit-backdrop-filter: blur(42px) saturate(180%);') && home.includes('backdrop-filter: blur(42px) saturate(180%);'), '首页面板磨砂（blur 42px / saturate 180%，含 -webkit-）');
assert.ok(!home.includes('-webkit-backdrop-filter: none;') && !home.includes('var(--hp-pop) 98%, transparent'), '首页面板不再 98% 近不透明 / 不再去磨砂');
assert.ok(/\.hp-mpanel-models \{ position: absolute; top: 0; right: 100%; width: 300px; display: flex; flex-direction: column; z-index: 2; \}/.test(home), '首页二级 300px / absolute / right:100%（贴一级左缘、中间不留缝）/ z-index 2');
assert.ok(!/\.hp-mpanel-models \{[^}]*right: calc/.test(home), '首页二级不再用 right:calc(100% + 6px) 留 6px 缝');
assert.ok(!home.includes('v-if="!modelVendor"') && home.includes('<div class="hp-mpanel hp-mpanel-vendors">'), '首页一级供应商面板始终保留（不再 v-if 移除 / 替换）');
assert.ok(home.includes('<div v-if="modelVendor && activeVendor" class="hp-mpanel hp-mpanel-models" :style="{ top: modelTop + \'px\' }">') && home.includes(':style="{ top: modelTop + \'px\' }"'), '首页二级子菜单浮层带动态 top（跟随当前供应商行）');
assert.ok(!/class="hp-pop hp-model-wrap"[^>]*@pointerleave/.test(home), '外层不再用 @pointerleave 关二级（移到模型不消失）');
assert.ok(!home.includes('scheduleFlyoutClose') && !home.includes('cancelFlyoutClose') && !home.includes('modelCloseTimer'), '不靠关闭定时器（划过供应商自动切换）');
assert.ok(/\.hp-mv \{ min-height: 36px;/.test(home) && /font: 400 13px\/1 var\(--font-sans\)/.test(home), '首页一级行 36px / 13px');
assert.ok(/\.hp-mpanel-hd b \{ font: 400 11px\/1\.2 var\(--font-sans\); color: var\(--ink-3\); \}/.test(home), '首页一级标题小字');
assert.ok(/\.hp-mpanel-models \.hp-it \{ min-height: 38px; padding: 0 10px; border-radius: 9px;/.test(home), '首页二级行 38px');
assert.ok(/\.hp-mpanel-models \.hp-it b \{ font-size: 13px; font-weight: 400;/.test(home), '首页二级 13px');
assert.ok(/\.hp-mpanel-models \.hp-it\.cur \{ background: transparent; \}/.test(home) && /\.hp-mpanel-models \.hp-it\.cur b \{ font-weight: 600; \}/.test(home), '首页选中不铺底 + 600');
assert.ok(/\.hp-mpanel-models \.hp-it \.chk \{ width: 14px; height: 14px;/.test(home), '首页选中行 14px 对勾');
const modelPanel = (home.match(/<div v-if="modelVendor && activeVendor" class="hp-mpanel hp-mpanel-models"[\s\S]*?<\/Transition>/) || [''])[0];
assert.ok(modelPanel, '首页二级面板模板还在');
assert.ok(!modelPanel.includes('hp-models-hd') && !modelPanel.includes('hp-models-back') && !modelPanel.includes('name="chevl"') && !modelPanel.includes('aria-label="返回供应商列表"'), '二级无 header / 无返回按钮（没有返回行）');
assert.ok(!home.includes('hp-models-hd') && !home.includes('hp-models-back'), '首页模板 + 样式都不再有二级 header / 返回按钮');
assert.ok(home.includes('@pointerenter="showVendor(g.id, $event)" @click="clickVendor(g.id, $event)"') && home.includes('function showVendor(id, event)') && /function clickVendor\(id, event\) \{\s*showVendor\(id, event\);/.test(home), '一级行 hover / click 都把 event 传给 showVendor');
assert.ok(home.includes('const rr = event.currentTarget.getBoundingClientRect();') && home.includes('const wr = modelPopEl.value.getBoundingClientRect();') && home.includes('modelTop.value = Math.max(0, Math.round(rr.top - wr.top));'), 'showVendor 用供应商行 rect - wrap rect 算 modelTop（Math.max(0, ...)）');
assert.ok(!home.includes('能读图') && !home.includes('只读文字'), '首页也去掉了能力副文案');
assert.ok(modelPanel.includes('v-if="activeVendor.models.length > 8"'), '首页搜索框只在 >8 个模型时渲染');
assert.ok(!/class="hp-search"[^>]*input v-model="modelQ"/.test(modelPanel.replace(/\s+/g, ' ')), '首页搜索框不再无条件渲染');
assert.ok(home.includes('class="hp-mv" :class="{ on: modelVendor === g.id }"') && home.includes('<span class="n">{{ g.models.length }} 个模型</span>') && home.includes('<NvIcon name="chevr" class="ar" />'), '首页一级行保留计数 + 线性 chevron');

// ---- 缓存版本号两处一致 ----
const versions = [...canvasHtml.matchAll(/\/static\/novai-canvas\/canvas\.(?:css|js)\?v=([\w.]+)/g)].map((m) => m[1]);
assert.strictEqual(versions.length, 2, 'canvas.html 里 canvas.css / canvas.js 各一处 ?v=');
assert.strictEqual(versions[0], versions[1], 'canvas.css / canvas.js 的 ?v= 一致');

console.log('[PASS] 选择模型子菜单 Prompt Input 版式：二级去副文案/>8 才搜索/38px 行/14px 对勾；一级 304·300 / 36px / 计数 11px；画布两级磨砂玻璃（86%/84% + 42px blur）、零 border / 零 inset；首页一级始终保留 + 二级贴左子菜单浮层（absolute / right:100% / 动态 top 跟随供应商行）+ 无返回按钮/header + 86% 磨砂；首页只改 HomePage.vue');
