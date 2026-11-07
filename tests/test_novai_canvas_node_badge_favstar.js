#!/usr/bin/env node
/* task-31：节点左上不再显示模型名徽标；收藏星移到真正右上角。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const node = read('novai-canvas-ui/src/canvas/canvas-next/ui/NodeView.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');

assert.ok(!node.includes('data-badge="model"') && !node.includes('nb model'), '节点不再渲染模型名徽标');
assert.ok(node.includes('retryBlockedReason(g.errCode || "", !!p.modelName)'), '无模型时重试禁用原因仍使用 modelName');
assert.ok(node.includes('modelName?: string'), 'modelName prop 保留给逻辑使用');
assert.ok(node.includes('data-p="model"') || read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx').includes('data-p="model"'), '模型仍可在参数面板查看/切换');

const fav = (css.match(/\.cn-root \.favstar\{[^}]*\}/) || [''])[0];
assert.ok(/right:8px/.test(fav) && /top:8px/.test(fav) && !/top:34px/.test(fav), 'favstar 贴右上角');
assert.ok(/\.cn-root \.node:has\(\.favstar\) \.vstrip\{right:38px\}/.test(css), 'favstar 出现时版本条向左让位');
assert.ok(/\.node\.sel \.favstar,\.cn-root \.node:hover \.favstar,\.cn-root \.favstar\.on\{display:grid\}/.test(css), 'hover/选中/已收藏仍显示');
assert.ok(/z-index:4/.test(fav), 'favstar 在版本/替换控件之上');
// ---- task-32：替换按钮左上角 ----
const replaceBtn = (node.match(/<button className="node-replace"[\s\S]*?<\/button>/) || [''])[0];
const replaceCss = (css.match(/\.cn-root \.node-replace\{[^}]*\}/) || [''])[0];
assert.ok(replaceCss.includes('left:8px') && replaceCss.includes('top:8px') && replaceCss.includes('transform:none'), '替换按钮定位到左上角');
assert.ok(!/left:\s*"50%"|transform:\s*"translateX\(-50%\)"/.test(replaceBtn), '替换按钮 inline style 不再覆盖左上定位');
assert.ok(!node.includes('nbadges') && !node.includes('data-badge="version"'), '节点不再渲染重复的版本徽标');
assert.ok(!css.includes('.nbadges') && !css.includes('.nb.ver') && !css.includes('.nb{'), '只为版本徽标存在的样式已清理');
assert.ok(node.includes('className="vstrip tnum"') && css.includes('.cn-root .vstrip{'), '可交互版本切换条仍保留');
console.log('[PASS] 节点模型徽标移除 + favstar 右上角 + 替换按钮左上角/版本徽标让位');