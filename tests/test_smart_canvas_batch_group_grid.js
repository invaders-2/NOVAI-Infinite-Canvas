#!/usr/bin/env node
// 多维表格批量生成 → 结果分组节点的缩略图网格：节点里已有的产出必须全部画出来（含最后一张）。
//
// 现象：结果分组节点里明明有 N 张图（含最后一张），卡片却少画一张（用户报的「群组无法拉取最后一张图」）。
// 成因：batchRowGridHtml 只按 batchRowOrder（本轮行号计划）铺格子，节点里不属于该计划的产出
//       （断点续跑换了行集、runId 取不到时结果节点按生成节点 id 复用等）会被静默丢掉；
//       退出/重进后 batchRowOrder 还会保留，于是这些图一直不显示。
// 本检查锁住修复：按行序铺完格子后，把没画过的产出补上；进度格（running/queued/failed）行为不变。
// 运行：node tests/test_smart_canvas_batch_group_grid.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');

const file = path.join(__dirname, '../static/js/smart-canvas.js');
const code = fs.readFileSync(file, 'utf8');
const label = 'static/js/smart-canvas.js';
function topLevelFunction(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
const gridFn = topLevelFunction(code, 'batchRowGridHtml');

// ---- 静态断言 ----
ok(/drawn\.has\(index\)/.test(gridFn), '渲染时记录了「已画过的产出」，用于兜底补画');
ok(/imgs\.forEach/.test(gridFn), '兜底会遍历节点里的全部产出');
const slotAt = gridFn.indexOf('batchRowSlotHtml(states[rowNumber]');
const fallbackAt = gridFn.indexOf('drawn.has(index)');
ok(slotAt >= 0 && fallbackAt > slotAt, '兜底补画排在按行序铺格子之后（进度格先占位）');
ok(!/\.slice\(0, *order\.length\)/.test(gridFn), '没有用 order.length 截断产出');

// ---- 行为断言：在沙箱里跑真实函数 ----
const sandboxSrc = [
    'const tr = k => k;',
    'const escapeHtml = t => String(t == null ? "" : t);',
    'const escapeAttr = escapeHtml;',
    'const selectedImage = {nodeId:"", index:-1};',
    'let MEDIA_GROUP_MAX_VISIBLE_ROWS = 3;',
    'function thumbMediaHtml(img){ return "THUMB:" + String(img.url || ""); }',
    'function imageNameBadgeHtml(){ return ""; }',
    'function imageResolutionBadgeHtml(){ return ""; }',
    'function mediaKindForItem(i){ return (i && i.kind) || "image"; }',
    topLevelFunction(code, 'mediaLayoutSize'),
    topLevelFunction(code, 'mediaCellAspect'),
    gridFn,
    topLevelFunction(code, 'batchRowThumbHtml'),
    topLevelFunction(code, 'batchRowSlotHtml'),
    'globalThis.__grid = function(order, rows, states){',
    '    const node = {id:"g1", batchRowOrder:order, batchRowStates:states || {}, sizeUserSet:true};',
    '    const imgs = rows.map(r => (r && typeof r === "object") ? r : ({url:"u" + r, kind:"image", rowNumber:r}));',
    '    node.images = imgs;',
    '    return batchRowGridHtml(node, imgs, {thumb:96, cols:2, rows:2, visibleRows:2}, order);',
    '};',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox, {filename: 'batch-group-grid-sandbox.js'});
const grid = sandbox.__grid;
const count = (html, token) => html.split(token).length - 1;

// ① 计划与产出一一对应：N 行 N 张，一张不少
const a = grid([1,2,3], [1,2,3], {1:'completed',2:'completed',3:'completed'});
eq(count(a, 'thumb-item'), 3, '计划 3 行 + 产出 3 张 → 3 张缩略图');
ok(a.includes('u3'), '最后一张（第 3 行）在卡片里');
eq(count(a, 'loading-cell'), 0, '全部完成时没有残留进度格');

// ② 回归：产出比「本轮行序」多（断点续跑换行集 / 结果节点被复用）—— 最后一张不能消失
const b = grid([1,2], [1,2,3], {1:'completed',2:'completed'});
eq(count(b, 'thumb-item'), 3, '计划 2 行但产出 3 张 → 3 张全画出来');
ok(b.includes('u3'), '计划外的最后一张也要画出来');

// ③ 计划里还没出图的行走进度格：进度行为不变
const c = grid([1,2,3], [1,2], {1:'completed',2:'completed',3:'running'});
eq(count(c, 'thumb-item'), 2, '出了 2 张就画 2 张缩略图');
eq(count(c, 'loading-cell'), 1, '第 3 行还在跑 → 保留 1 个进度格');
ok(c.includes('data-pending-slot="1"'), '进度格仍是「在跑」样式');

// ④ 计划与产出完全不重叠：进度格 + 兜底补画都在
const d = grid([1,2], [3,4], {1:'queued',2:'queued'});
eq(count(d, 'thumb-item'), 2, '计划外的 2 张产出照样画');
ok(d.includes('u3') && d.includes('u4'), '两张计划外产出都在');
eq(count(d, 'loading-cell'), 2, '计划里没出图的 2 行仍是进度格');

// ⑤ 没有行号的产出（老数据 / 单张产出）也必须显示
const e = grid([1,2], [{url:'x1', kind:'image'}, {url:'x2', kind:'image', rowNumber:2}], {1:'queued',2:'completed'});
ok(e.includes('x1') && e.includes('x2'), '没有行号的产出也要画出来');

// ⑥ 缩略图的 data-image-index 必须指向节点 images 里的真实下标（删除/选中靠它）
const f = grid([1], [1,2,3], {1:'completed'});
ok(f.includes('data-image-index="2"'), '兜底补画的那张保留真实下标 2');

console.log(label + '：' + pass + ' 项通过');
if(fails.length){ fails.forEach(msg => console.error('  ✗ ' + msg)); console.error('失败 ' + fails.length + ' 项'); process.exit(1); }
console.log('全部通过');
