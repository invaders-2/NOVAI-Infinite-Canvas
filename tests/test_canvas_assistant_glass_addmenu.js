#!/usr/bin/env node
/* task-26 旧智能画布助手玻璃 + task-27 添加节点菜单位置 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
function load(entry) {
  const r = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

// ---- task-26：旧助手玻璃 ----
const srcCss = read('canvas-ui/src/styles/index.css');
const builtCss = read('static/canvas-assistant/assistant-ui.css');
assert.ok(srcCss.includes('--nvca-glass-bg: color-mix(in srgb, var(--nvca-panel) 78%, transparent)'), '浅色玻璃底复用 panel 78%');
assert.ok(srcCss.includes('--nvca-glass-bg: color-mix(in srgb, var(--nvca-panel) 70%, transparent)'), '深色玻璃底 panel 70%');
assert.ok(srcCss.includes('--nvca-glass-blur: blur(44px) saturate(190%)'), '旧助手 blur 配方');
assert.ok(/#canvasAssistantPanel\.canvas-assistant\.open[\s\S]*?backdrop-filter: var\(--nvca-glass-blur\)/.test(srcCss), '助手面板本体玻璃');
assert.ok(/\.nvca-tap-menu,[\s\S]*?\.nvca-dialog,[\s\S]*?backdrop-filter: var\(--nvca-glass-blur\)/.test(srcCss), '菜单/弹层也玻璃');
assert.ok(/\.nvca-tool-card,[\s\S]*?\.nvca-question \{[\s\S]*?border: 0/.test(srcCss), '工具卡/气泡去 1px 描边');
assert.ok(srcCss.includes('#canvasAssistantPanel.canvas-assistant.is-model-open') && srcCss.includes('backdrop-filter:none'), '旧助手模型菜单打开时去掉宿主面板 blur');
assert.ok(srcCss.includes('color-mix(in srgb,var(--nvca-panel) 92%,transparent)') && srcCss.includes('color-mix(in srgb,var(--nvca-panel) 84%,transparent)'), '旧助手模型菜单 88%/84% 防透字');
assert.ok(/#canvasAssistantPanel \.nvca-tap-menu\.is-model\{[^}]*blur\(42px\) saturate\(180%\)/.test(srcCss), '旧助手模型菜单 42px 玻璃');
assert.ok(builtCss.includes('--nvca-glass-bg') && builtCss.includes('#canvasAssistantPanel.canvas-assistant.open'), '构建产物包含玻璃规则');

const jsPath = path.join(root, 'static/canvas-assistant/assistant-ui.js');
assert.ok(fs.existsSync(jsPath) && fs.existsSync(path.join(root, 'static/canvas-assistant/assistant-ui.css')), '助手产物存在');
const stamp = Math.floor(fs.statSync(jsPath).mtimeMs / 1000);
const bridge = read('static/js/canvas-assistant-bridge.js');
assert.ok(bridge.includes("ASSET_VERSION = '1.0.137." + stamp + "'"), 'bridge 缓存版本跟随 assistant-ui.js mtime');

// ---- task-27：添加节点菜单 ----
const placement = load('novai-canvas-ui/src/canvas/canvas-next/ui/placement.ts');
const at = { x: 22, y: 295, width: 40, height: 40 };
const pop = { x: 0, y: 0, width: 307, height: 579 };
for (const vw of [1440, 1680]) {
  const p = placement.placePopover({ anchor: at, popup: pop, viewport: { width: vw, height: 900 }, dir: 'right', align: 'left', margin: 8, gap: 8 });
  assert.strictEqual(p.x, 70, '菜单在 + 按钮右侧（' + vw + '）');
  assert.strictEqual(p.y, 295, '菜单顶对齐 + 按钮（' + vw + '）');
  assert.ok(p.x + pop.width <= vw - 8 && p.y + pop.height <= 900 - 8, '菜单不越界（' + vw + '）');
}
const fallback = placement.placePopover({ anchor: { x: 1200, y: 400, width: 40, height: 40 }, popup: pop, viewport: { width: 1440, height: 900 }, dir: 'right', align: 'left', margin: 8, gap: 8 });
assert.ok(fallback.x < 1000, '右侧空间不足时翻到按钮左侧');
const menus = read('novai-canvas-ui/src/canvas/canvas-next/ui/menus.tsx');
assert.ok(menus.includes('"right", "left", "add-menu-pop"'), '添加节点菜单向右、顶对齐，并带专用 class');
const overlay = read('novai-canvas-ui/src/canvas/canvas-next/ui/overlay.tsx');
assert.ok(overlay.includes('maxHeight: pos?.scrollY ? pos.maxHeight : undefined'), '不滚动时不用测量高度钳死弹层');
const canvasCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
assert.ok(canvasCss.includes('#pop.add-menu-pop{max-height:calc(100vh - 24px)'), '添加节点菜单允许用满视口高度');
assert.ok(canvasCss.includes('#pop.add-menu-pop .mi{padding-top:3px;padding-bottom:3px;}'), '菜单压缩行高，11 项在 900 高内全部可见');

console.log('[PASS] 旧助手玻璃 + 添加节点菜单定位：玻璃变量/面板/菜单/气泡/版本 + 右侧顶对齐/翻边/不裁切');