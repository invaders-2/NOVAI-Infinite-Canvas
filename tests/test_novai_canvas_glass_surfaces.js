#!/usr/bin/env node
/* task-24：弹窗/子菜单统一磨砂玻璃（color-mix 底 + blur/saturate + 无 1px 描边）。
   可读性底线：--glass-bg 透明度 <=30%（70%/78% 实底），blur 失效仍可读。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
const editors = read('novai-canvas-ui/src/canvas/canvas-next/ui/editors/editors.css');
const agentPanel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');

// ---- 变量收口 ----
assert.ok(css.includes('--glass-bg:color-mix(in srgb,var(--panel) 70%,transparent)'), '深色玻璃底 = panel 70%');
assert.ok(css.includes('--glass-bg:color-mix(in srgb,var(--panel) 78%,transparent)'), '浅色玻璃底 = panel 78%');
assert.ok(css.includes('--menu:var(--glass-bg)') && css.includes('--modal:var(--glass-bg)') && css.includes('--glass:var(--glass-bg)'), 'menu/modal/glass 统一走 glass-bg');
assert.ok(css.includes('--glass-blur:blur(44px) saturate(190%)') && css.includes('--glass-shadow:'), 'blur + 柔和双层投影变量');
assert.ok(!/--menu:rgba\(255,255,255,\.9[0-9]\)/.test(css) && !/--modal:rgba\(255,255,255,\.9[0-9]\)/.test(css) && !/--modal:rgba\(36,36,38,\.9[0-9]\)/.test(css), '近实底变量已清理');

// ---- 覆盖容器 ----
const group = (css.match(/\/\* 2026-11 用户统一要求[\s\S]*?\}/) || [''])[0];
assert.ok(group, '有统一磨砂玻璃覆盖块');
for (const selector of ['#pop', '#ctx', '.modal:not(.tpl-panel)', '.drawer', '.plan', '.model-flyout', '.tpl', '.tpl-lib-box', '.campop .cam-card', '.style-dlg', '.pm-menu', '.textdoc .td-panel']) {
  assert.ok(group.includes(selector), '覆盖 ' + selector);
}
const groupNorm = group.replace(/\s+/g, ' ');
assert.ok(groupNorm.includes('var(--glass-bg)') && groupNorm.includes('var(--glass-tint)') && groupNorm.includes('backdrop-filter:var(--glass-blur)') && groupNorm.includes('-webkit-backdrop-filter:var(--glass-blur)'), '统一玻璃底 + 双前缀 blur');
assert.ok(groupNorm.includes('border:0') && groupNorm.includes('box-shadow:var(--glass-shadow)'), '去掉 1px 描边，用双层柔和投影');
assert.ok(!group.includes('inset'), '统一覆盖块不再用 inset 发丝线');
assert.ok(editors.includes('background:var(--glass-bg)') && editors.includes('backdrop-filter:var(--glass-blur)'), '图片编辑素材选择器也是玻璃');
assert.ok(!/近乎不透明实底|厚底例外/.test(editors), '去掉旧的近实底例外注释');

// ---- 画布节点参数编辑器 #gp：磨砂玻璃（88% 主题底 + 44px blur，无 inset 描边） ----
const gpRule = (css.match(/\.cn-root #gp\{[^}]*\}/) || [''])[0];
assert.ok(gpRule, '#gp 规则存在');
assert.ok(/background:color-mix\(in srgb,var\(--panel\) 88%,transparent\)/.test(gpRule), '#gp 磨砂玻璃底 88% 主题面板');
assert.ok(/-webkit-backdrop-filter:blur\(44px\) saturate\(190%\)/.test(gpRule) && /backdrop-filter:blur\(44px\) saturate\(190%\)/.test(gpRule), '#gp blur(44px) saturate(190%)，含 -webkit-');
assert.ok(/box-shadow:var\(--glass-shadow\)/.test(gpRule), '#gp 用统一 glass-shadow（深浅色自动适配）');
assert.ok(!/inset/.test(gpRule) && !/background:var\(--s1\)/.test(gpRule), '#gp 去掉旧 s1 实底与 inset 描边');
assert.ok(!/\.cn-root\[data-theme=light\][^{}]*#gp[^{}]*\{[^}]*inset/.test(css), '浅色主题不给 #gp 加发丝线 / inset');

// ---- 方案卡窄面板不横向溢出 ----
const planRule = (css.match(/\.cn-root \.plan\{[^}]*\}/) || [''])[0];
const stepRule = (css.match(/\.cn-root \.plan \.cgrid \.plan-step\{[^}]*\}/) || [''])[0];
const paramsRule = (css.match(/\.cn-root \.plan \.plan-params\{[^}]*\}/) || [''])[0];
const selectRule = (css.match(/\.cn-root \.plan \.plan-params select\{[^}]*\}/) || [''])[0];
assert.ok(/max-width:100%/.test(planRule) && /min-width:0/.test(planRule), '方案卡限制在消息列宽内');
assert.ok(/grid-template-columns:minmax\(0,1fr\)/.test(css) && /min-width:0/.test(stepRule), '方案卡网格/步骤可收缩');
assert.ok(/min-width:0/.test(paramsRule) && /width:0/.test(selectRule) && /min-width:0/.test(selectRule), '参数行控件可收缩，长模型名省略');
// ---- 画布助手面板玻璃 ----
const agentRule = [...css.matchAll(/\.cn-root #agent\{[^}]*\}/g)].map((m) => m[0]).find((r) => r.includes('--glass-bg')) || '';
const agentAi = [...css.matchAll(/\.cn-root #agent \.ai\{[^}]*\}/g)].pop()?.[0] || '';
assert.ok(/var\(--glass-bg\)/.test(agentRule) && /backdrop-filter:var\(--glass-blur\)/.test(agentRule) && /border:0/.test(agentRule), '助手面板复用 glass-bg / glass-blur / 无描边');
assert.ok(!/backdrop-filter/.test(agentAi), '输入区内层不再重复 44px blur');
assert.ok(/\.cn-root #agent \.ab\{[^}]*scrollbar-width:none/.test(css) && /\.cn-root #agent \.ab::-webkit-scrollbar\{[^}]*display:none/.test(css), '助手滚动区滚动条仍隐藏');
// ---- 助手内部弹层：agent-pop + 取消面板嵌套 backdrop root ----
const overlay = read('novai-canvas-ui/src/canvas/canvas-next/ui/overlay.tsx');
const menusCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
assert.ok(overlay.includes('closest("#agent")') && overlay.includes('agent-pop'), '#pop 按来源标记 agent-pop');
assert.ok(overlay.includes('agent-layer-open') && overlay.includes('syncOverlayBlur'), '弹层开合切换面板 blur 状态');
assert.ok(menusCss.includes('html.agent-layer-open .cn-root #agent') && /html\.agent-layer-open \.cn-root #agent\{[^}]*backdrop-filter:none/.test(menusCss), '弹层打开时 #agent 去掉 backdrop-filter');
assert.ok(/\.cn-root #pop\.agent-pop[^{]*\{[^}]*var\(--glass-bg\)/.test(menusCss), '助手内部 #pop 仍是 glass-bg');
assert.ok(agentPanel.includes('createPortal') && agentPanel.includes('model-flyout-portal') && agentPanel.includes('document.querySelector(".cn-root")'), '二级模型 flyout portal 到 .cn-root 根级');
assert.ok(overlay.includes('model-flyout'), 'portal flyout 不触发外部点击关闭');
assert.ok(menusCss.includes('.cn-root .model-flyout.model-flyout-portal') && menusCss.includes('position:fixed') && menusCss.includes('z-index:61') && menusCss.includes('blur(42px) saturate(180%)') && menusCss.includes('color-mix(in srgb,var(--panel) 84%,transparent)'), '二级 flyout 独立 backdrop root + 84% 底 + 42px blur');
assert.ok(menusCss.includes('color-mix(in srgb,var(--panel) 86%,transparent)') && menusCss.includes('color-mix(in srgb,var(--panel) 82%,transparent)'), '一级/think 磨砂 86%；旧的 .model-flyout 82% 兜底仍保留');
assert.ok(menusCss.includes('.cn-root .model-flyout.model-flyout-portal') && /inset 0 1px 0 rgba\(255,255,255,\.06\)/.test(menusCss), '二级 flyout 内高光');
assert.ok(/\.cn-root #pop\.model-pop \.mi\.on/.test(menusCss) && /color-mix\(in srgb,var\(--ink\) 9%,transparent\)/.test(menusCss), '选中/悬停用半透明软底');
assert.ok(menusCss.includes('border:0') && menusCss.includes("model-flyout-portal") , '两级模型弹窗无 1px 描边');
assert.ok(/\.cn-root #agent \.confirm:not\(\.plan\)\{[^}]*border:0/.test(menusCss), '技能安装/确认提问卡无 1px 描边');
assert.ok(/\.cn-root #modal \.modal\{[^}]*var\(--glass-bg\)/.test(menusCss), '记忆/技能管理弹窗用玻璃底');
console.log('[PASS] 弹窗/子菜单磨砂玻璃 + 助手面板 + 内部弹层：变量 / 去嵌套 root / 无描边 / 面板玻璃');