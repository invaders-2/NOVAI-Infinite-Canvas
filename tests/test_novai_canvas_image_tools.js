#!/usr/bin/env node
/* 图片节点的编辑入口回归：2.0.08 收窄工具条时把「裁剪 / 涂鸦」的入口漏了（编辑器一直在，只是没按钮）。
   覆盖：MoreMenu 里 crop / markup 两个入口 + 走 openEditor 路由 + 线性图标；
        工具条 / 更多菜单的图片工具并集不缺失；构建产物里能找到对应文案。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const registry = read('novai-canvas-ui/src/canvas/canvas-next/ui/editors/registry.tsx');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');

// ---- 1. MoreMenu 区域（从 function MoreMenu 到下一个顶层注释） ----
const moreStart = registry.indexOf('function MoreMenu');
assert(moreStart > 0, '找得到 MoreMenu');
const moreEnd = registry.indexOf('/**', moreStart);
const more = registry.slice(moreStart, moreEnd > moreStart ? moreEnd : registry.length);

assert(/"crop"{[^}]*openEditor\(ctl, "crop", id\)/.test(more) || /data-k="crop"[\s\S]{0,220}openEditor\(ctl, "crop", id\)/.test(more),
    '更多菜单有「裁剪」入口，且走 openEditor(ctl, "crop", id)');
assert(/data-k="markup"[\s\S]{0,220}openEditor\(ctl, "markup", id\)/.test(more),
    '更多菜单有「涂鸦」入口，且走 openEditor(ctl, "markup", id)');
assert(/<Icon name="crop" size="s" \/>裁剪/.test(more), '裁剪用现有线性 crop 图标');
assert(/<Icon name="pencil" size="s" \/>涂鸦/.test(more), '涂鸦用线性 pencil 图标');
// 位置在菜单前部：两个入口都要出现在「增强 / 调整像素 / 抠图 / 旋转」之前
assert(more.indexOf('data-k="crop"') < more.indexOf('data-k="enhance-menu"'), '裁剪在菜单前部（增强之前）');
assert(more.indexOf('data-k="markup"') < more.indexOf('ResizeModal'), '涂鸦在菜单前部（调整像素之前）');

// 编辑器本身还在（不是只补了按钮）
assert(/if \(kind === "crop"\) return setEd\(\{ type: "crop", id \}\)/.test(registry), '裁剪编辑器路由仍在');
assert(/if \(kind === "markup"\) return setEd\(\{ type: "markup", id \}\)/.test(registry), '涂鸦编辑器路由仍在');

// ---- 2. 图片工具并集（0b4516ca^ 的条上按钮 vs 现在条上 + 更多） ----
const imageLine = panel.split('\n').find((line) => line.includes('else if (node.kind === "image") items ='));
assert(imageLine, '找得到图片工具条');
for (const key of ['mask', 'adjust', 'lossless', 'more']) {
    assert(imageLine.includes('B("' + key + '"'), '图片工具条仍有 ' + key);
}
for (const key of ['open-outpaint', 'crop', 'markup', 'angle', 'relight', 'whitemodel', 'enhance-menu',
    'cutout', 'rotate-menu', 'split-menu', 'layersplit-menu']) {
    assert(more.includes('data-k="' + key + '"'), '更多菜单缺 ' + key);
}
// 旧条上的「拆分图层 / 多角度 / 重打光 / 白膜 / 局部重绘 / 调色 / 无损改图」都有去处
assert(panel.includes('B("mask", "brush", "局部重绘")') || registry.includes('"redraw"'), '局部重绘仍在');
assert(/拆分图层/.test(more) && /多角度/.test(more) && /重打光/.test(more) && /白膜处理/.test(more),
    '拆分图层 / 多角度 / 重打光 / 白膜都在更多菜单里');

// ---- 3. 构建产物：文案真的进了 static/novai-canvas ----
const built = read('static/novai-canvas/canvas.js');
assert(built.includes('裁剪 / 旋转'), '构建产物含「裁剪 / 旋转」');
assert(built.includes('涂鸦 / 文字 / 马赛克'), '构建产物含「涂鸦 / 文字 / 马赛克」');

console.log('[image-tools] 全部通过（裁剪 / 涂鸦入口 + 图片工具并集 + 构建产物文案）');
