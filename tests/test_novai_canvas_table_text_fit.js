#!/usr/bin/env node
'use strict';
/*
 * 多维表格单元格文字完整显示静态回归（task-15 修复）。
 *
 * 覆盖真实行为点：
 *   1. Cell 不再靠写死 rows=2 + overflow:hidden：按内容 scrollHeight 撑高，触顶时收成整行（不露半行），
 *      节点视图上限 240、全屏编辑上限 480；
 *   2. 单元格 CSS 必须 pre-wrap + overflow-wrap:anywhere（长串数字/英文才能换行、不横向溢出）；
 *   3. 行高估算 estimateLines 按 ~10 汉字/行、封顶 240，图片格仍按 84 底、输入通道缩略图行高不回退；
 *   4. 全屏编辑用同一套 Cell（maxH 480）；
 *   5. 构建产物 static/novai-canvas/canvas.css 里带着这组换行规则。
 *
 * 跑法：node tests/test_novai_canvas_table_text_fit.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const tableDir = 'novai-canvas-ui/src/canvas/canvas-next/';
const nodeSrc = read(tableDir + 'ui/TableNode.tsx');
const tableSrc = read(tableDir + 'table.ts');
const css = read(tableDir + 'ui/canvas-next.css');

console.log('[1] Cell 按内容撑高（不再裁第 3 行）');
ok(/const lineH = parseFloat\(cs\.lineHeight\) \|\| 18/.test(nodeSrc), 'Cell 读取真实 line-height');
ok(/const padY = \(parseFloat\(cs\.paddingTop\) \|\| 0\) \+ \(parseFloat\(cs\.paddingBottom\) \|\| 0\)/.test(nodeSrc), 'Cell 扣掉上下 padding');
ok(/el\.style\.height = "auto";[\s\S]{0,120}const want = el\.scrollHeight/.test(nodeSrc), '先把高度归 auto 再量 scrollHeight（量的是内容真实高度）');
ok(/const cap = Math\.max\(lineH \+ padY, Math\.floor\(\(maxH - padY\) \/ lineH\) \* lineH \+ padY\)/.test(nodeSrc),
    '触顶高度按整行计算（floor((maxH-padY)/lineH)*lineH+padY，不会露半行）');
ok(/const next = Math\.min\(want, cap\)/.test(nodeSrc) && /el\.style\.height = next \+ "px"/.test(nodeSrc), '可见高度 = min(内容高, 上限)');
ok(/el\.style\.overflowY = want > next \+ 1 \? "auto" : "hidden"/.test(nodeSrc), '超上限才切格内滚动，否则不滚');
ok(/const CELL_MAX = \{ node: 240, full: 480 \}/.test(nodeSrc), '节点视图上限 240 / 全屏编辑 480');
ok(/maxH=\{full \? CELL_MAX\.full : CELL_MAX\.node\}/.test(nodeSrc), '全屏编辑走同一套 Cell，上限 480');
ok(!/overflow:\s*hidden[\s\S]{0,80}rows=\{2\}/.test(nodeSrc), '没有再靠 overflow:hidden 裁字');
ok(/"data-cell": cellKey/.test(nodeSrc), '单元格仍带 data-cell（可定位、可测试）');

console.log('[2] 单元格 CSS：pre-wrap + overflow-wrap:anywhere');
const rule = (css.match(/\.cn-root \.tgrid td textarea\{[^}]*\}/) || [''])[0];
ok(!!rule, 'canvas-next.css 有 .tgrid td textarea 规则');
ok(/white-space:pre-wrap/.test(rule), 'white-space:pre-wrap（保留换行、按容器换行）');
ok(/overflow-wrap:anywhere/.test(rule), 'overflow-wrap:anywhere（长串数字/英文强制换行）');
ok(/word-break:break-word/.test(rule), 'word-break:break-word 兜底');
ok(/line-height:1\.5/.test(rule) && /min-height:40px/.test(rule), '行高 1.5（12px × 1.5 = 18px）、最小 40px');

console.log('[3] 行高估算 estimateLines / 输入通道缩略图');
ok(/const ROW_LINE_H = 18, ROW_CHARS_PER_LINE = 10/.test(tableSrc), '按 ~10 汉字/行、行高 18px 估算');
ok(/function estimateLines\(text: string\): number/.test(tableSrc), 'estimateLines 存在');
ok(/\\u2e80-\\u9fff/.test(tableSrc) && /0\.55/.test(tableSrc), '汉字算 1、英文/数字算 0.55 宽（长串数字不会被低估行数）');
ok(/return Math\.min\(240, Math\.max\(hasMedia \|\| img \? 84 : 40, 20 \+ lines \* ROW_LINE_H\)\)/.test(tableSrc),
    'rowHeight 封顶 240、图片格底 84、文字格底 40');
ok(/Math\.max\(1, \.\.\.cells\.map\(\(c\) => \(isMediaRef\(c\) \? 1 : estimateLines\(c \|\| ""\)\)\)\)/.test(tableSrc), '图片引用串不参与行数估算');
ok(/export function inputCellHeight\(count: number\): number/.test(tableSrc), '输入通道缩略图高度逻辑还在');
ok(/Math\.ceil\(shown \/ TABLE_INPUT_PER_LINE\) \* \(TABLE_INPUT_THUMB \+ 4\) \+ 12/.test(tableSrc), '输入格高度 = 行数 × (40+4) + 12（2 张 / 5 张按实际张数算）');
ok(/TABLE_INPUT_PER_LINE = 2, TABLE_INPUT_MAX_SHOWN = 9/.test(tableSrc), '每行 2 张、最多显示 9 张');
ok(/style=\{\{ height: Math\.max\(rowHeight\(row, channels\.length > 0\), inputCellHeight\(mostItems\)\) \}\}/.test(nodeSrc),
    '行高 = max(文字行高, 输入缩略图高度)（图片多时不会撑破行）');

console.log('[4] 构建产物');
const builtCss = read('static/novai-canvas/canvas.css');
const builtRule = (builtCss.match(/\.cn-root \.tgrid td textarea\{[^}]*\}/) || [''])[0];
ok(!!builtRule, '构建产物 canvas.css 有 .tgrid td textarea 规则');
ok(/white-space:pre-wrap/.test(builtRule) && /overflow-wrap:anywhere/.test(builtRule), '构建产物带着 pre-wrap + overflow-wrap:anywhere');
const builtJs = read('static/novai-canvas/canvas.js');
ok(builtJs.includes('scrollHeight'), '构建产物 canvas.js 里有 scrollHeight 量高逻辑');
ok(builtJs.includes('pre-wrap'), '构建产物 canvas.js 内联样式里也带 pre-wrap（内联覆盖 CSS 时同样换行）');

console.log('');
console.log('多维表格单元格文字完整显示（静态）：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach((f) => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
process.exit(0);
