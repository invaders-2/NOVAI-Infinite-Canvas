#!/usr/bin/env node
/* 结果群组（批量生成的下游节点）与多图节点的显示/排列：
   1) 批量结果群里「已出的产出」也要按素材自己的比例占格（以前一律正方形 → 视频/竖图缩在方格里）；
   2) 节点高度与网格可视高度按格子真实高度算（竖图那一行不再被 max-height 裁掉 / 溢出节点框）；
   3) 分组单图带显式尺寸时按素材比例等比缩放（object-fit:cover 不再裁掉画面）；
   4) 格子顺序仍是原顺序（不重排、不重叠）。
   跑法：node tests/test_smart_canvas_group_media_layout.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '（实际 ' + JSON.stringify(a) + '）');
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（实际 ' + a + '，期望 ' + b + '）');

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

// ---- 静态断言 ----
const batchThumb = topLevelFunction(code, 'batchRowThumbHtml');
ok(/--thumb-aspect/.test(batchThumb), '批量结果的缩略图带 --thumb-aspect（跟着素材自己的比例）');
ok(/mediaCellAspect\(img\)/.test(batchThumb), '比例来自 mediaCellAspect（真实尺寸），不是写死 1');
const batchGrid = topLevelFunction(code, 'batchRowGridHtml');
ok(/layout\.visibleH|layout\.contentH/.test(batchGrid), '批量网格的 max-height 用布局算出的真实高度');
const thumbGrid = topLevelFunction(code, 'thumbGridHtml');
ok(/layout\.visibleH|layout\.contentH/.test(thumbGrid), '多图网格的 max-height 用布局算出的真实高度');
const imageLayoutSrc = topLevelFunction(code, 'imageLayout');
ok(/mediaGridCellAspects\(node, images, gridCount\)/.test(imageLayoutSrc), '多图布局按每张素材的比例算格子');
ok(/thumbGridRowHeights\(aspects, cols, thumb\)/.test(imageLayoutSrc), '多图布局按行高求整块高度');
const fittedSrc = topLevelFunction(code, 'fittedMediaGridLayout');
ok(/thumbGridRowHeights\(/.test(fittedSrc) && /visibleH/.test(fittedSrc), '显式尺寸分支同样按行高算可见高度');
ok(/smartGroupSingleInnerBox\(refs\[0\]\.item/.test(code), '分组单图按素材比例求内框（不再直接铺满内框被 cover 裁切）');

// ---- 行为断言 ----
const sandboxSrc = [
    'const tr = k => k;',
    'const escapeHtml = t => String(t == null ? "" : t);',
    'const escapeAttr = escapeHtml;',
    'const selectedImage = {nodeId:"", index:-1};',
    'const MEDIA_GROUP_MAX_VISIBLE_ROWS = 3;',
    'let pendingRequestBox = null;',
    'function pendingRequestBoxForNode(){ return pendingRequestBox; }',
    'function batchPendingSlotKinds(node, slots){ return {running:slots, queued:0}; }',
    'function thumbMediaHtml(img){ return "THUMB:" + String(img.url || ""); }',
    'function imageNameBadgeHtml(){ return ""; }',
    'function imageResolutionBadgeHtml(){ return ""; }',
    'function mediaKindForItem(i){ return (i && i.kind) || "image"; }',
    topLevelFunction(code, 'mediaLayoutSize'),
    topLevelFunction(code, 'mediaCellAspect'),
    topLevelFunction(code, 'pendingCellAspect'),
    topLevelFunction(code, 'thumbGridRowsHeight'),
    topLevelFunction(code, 'thumbGridRowHeights'),
    topLevelFunction(code, 'mediaGridCellAspects'),
    topLevelFunction(code, 'smartGroupSingleInnerBox'),
    batchGrid,
    batchThumb,
    topLevelFunction(code, 'batchRowSlotHtml'),
    thumbGrid,
    'globalThis.__api = {',
    '    batchThumb: (img, index) => batchRowThumbHtml({id:"g1"}, img, index),',
    '    batchGrid: (node, imgs, layout, order) => batchRowGridHtml(node, imgs, layout, order),',
    '    thumbGrid: (node, imgs, layout, p, f) => thumbGridHtml(node, imgs, layout, p || 0, f || 0),',
    '    rowHeights: (aspects, cols, thumb) => thumbGridRowHeights(aspects, cols, thumb),',
    '    cellAspects: (node, imgs, total) => mediaGridCellAspects(node, imgs, total),',
    '    singleInner: (item, w, h) => smartGroupSingleInnerBox(item, w, h),',
    '    setPendingBox: box => { pendingRequestBox = box; },',
    '};',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox, {filename: 'group-media-layout-sandbox.js'});
const api = sandbox.__api;
const media = (url, w, h, kind) => ({url, kind:kind || 'image', natural_w:w, natural_h:h});

console.log('[1] 批量结果的缩略图按素材自己的比例占格');
const wide = media('/output/w.png', 1600, 900);
const tall = media('/output/t.png', 900, 1600);
const video = media('/output/v.mp4', 720, 1280, 'video');
ok(api.batchThumb(wide, 0).includes('--thumb-aspect:1.777'), '16:9 → 1.777');
ok(api.batchThumb(tall, 1).includes('--thumb-aspect:0.5625'), '9:16 → 0.5625');
ok(api.batchThumb(video, 2).includes('--thumb-aspect:0.5625'), '竖版视频同样按自身比例');
ok(api.batchThumb({url:'/output/x.png'}, 3).includes('--thumb-aspect:1'), '量不到尺寸退回正方形');
ok(api.batchThumb(tall, 1).includes('data-image-index="1"'), '下标照旧（选中/删除靠它）');

console.log('[2] 网格可视高度 = 各行真实高度（竖图那一行不再被裁掉）');
const mixed = api.rowHeights([16 / 9, 9 / 16, 1], 2, 224);
eq(mixed.rowHeights, [Math.round(224 / (9 / 16)), 224], '第一行取该行最高的一格，第二行是方图');
eq(mixed.contentH, mixed.rowHeights[0] + 8 + 224, '整块内容高度 = 各行 + 间距');
const squares = api.rowHeights([1, 1, 1, 1], 2, 224);
eq(squares.rowHeights, [224, 224], '全是方图时 = 老口径（每行 224），不引入回归');
eq(squares.contentH, 224 + 8 + 224, '方图整块高度 = 2 行 + 1 个间距');

console.log('[3] 网格 max-height 用布局给的 visibleH / contentH');
const nodeP = {id:'n1', type:'smart-image'};
const layout = {cols:2, rows:2, visibleRows:2, thumb:224, visibleH:640, contentH:900};
let html = api.thumbGrid(nodeP, [wide, tall, media('/output/s.png', 1000, 1000)], layout, 0, 0);
ok(html.includes('--thumb-max-height:640px'), '自适应：可视高度取 visibleH（不是按正方形算的 456）');
html = api.thumbGrid(Object.assign({}, nodeP, {sizeUserSet:true}), [wide, tall], layout, 0, 0);
ok(html.includes('--thumb-max-height:900px'), '手动拖过尺寸：整框可用（contentH），还能滚动查看');
eq((html.match(/--thumb-aspect:1\.777/g) || []).length, 1, '每个格子各自带比例');

console.log('[4] 批量结果群：进度格用行比例，已出的图用素材比例，顺序不变');
const batchNode = {id:'b1', batchRowOrder:[1, 2], batchRowStates:{1:'completed', 2:'running'}, batchRowAspects:{1:16 / 9}};
const batchImgs = [Object.assign(media('/output/a.png', 1600, 900), {rowNumber:1})];
const batchLayout = {cols:2, rows:1, visibleRows:1, thumb:224, visibleH:126, contentH:126};
const batchHtml = api.batchGrid(batchNode, batchImgs, batchLayout, [1, 2]);
ok(batchHtml.includes('--thumb-aspect:1.777'), '第 1 行的产出按自身比例');
ok(batchHtml.indexOf('/output/a.png') < batchHtml.indexOf('data-pending-slot'), '产出在前、进度格在后（行序不变）');
ok(batchHtml.includes('--thumb-max-height:126px'), 'max-height 用布局的真实高度');

console.log('[5] 还没出图的格子用本次请求 / 按行比例');
api.setPendingBox({w: 1600, h: 900});
eq(api.cellAspects({}, [], 2), [16 / 9, 16 / 9], '没有产出时按请求比例铺进度格');
api.setPendingBox(null);
eq(api.cellAspects({batchRowAspect:9 / 16}, [], 2), [9 / 16, 9 / 16], '没有请求比例时用按行比例');
eq(api.cellAspects({}, [wide, tall], 2), [16 / 9, 9 / 16], '有产出时用素材自己的比例');

console.log('[6] 分组单图：显式尺寸下按素材比例等比缩放（不裁切）');
const inner = api.singleInner(wide, 568, 440);
near(inner.width / inner.height, 16 / 9, 0.02, '内框比例 = 素材比例');
ok(inner.width <= 568 && inner.height <= 440, '内框不超过可用区域（' + inner.width + 'x' + inner.height + '）');
eq(inner, {width:568, height:Math.round(568 * 9 / 16)}, '按宽度贴合');
const innerTall = api.singleInner(tall, 568, 440);
ok(innerTall.height <= 440 && innerTall.width <= 568, '竖图按高度贴合（' + innerTall.width + 'x' + innerTall.height + '）');
near(innerTall.width / innerTall.height, 9 / 16, 0.02, '竖图内框比例同样是素材比例');
eq(api.singleInner({url:'/x.png'}, 300, 200), {width:300, height:200}, '量不到尺寸退回整个内框（老行为）');

console.log('[7] 批量结果群组：按行保留产出（同一张图来自两行也不能被并成一张）');
const appendSrc = topLevelFunction(code, 'appendBatchResultImages');
const appendSandboxSrc = [
    'const tr = k => k;',
    topLevelFunction(code, 'nonPreviewOutputImages'),
    'function stripImageGenerationMeta(i){ return i; }',
    'function liveSmartNode(n){ return n; }',
    'function mediaLayoutSize(){ return {width:0, height:0}; }',
    'function mediaNodeDefaultScale(){ return 1; }',
    'function markSmartNodeComplete(){ globalThis.__done = true; }',
    appendSrc,
    'globalThis.__append = (node, additions, kind) => appendBatchResultImages(node, additions, null, kind || "image");',
    'globalThis.__newNode = () => ({id:"o1", type:"smart-image", images:[], pending:2, batchRunOrder:[1,2], batchRowStates:{}});',
].join('\n');
const appendSandbox = {console};
vm.createContext(appendSandbox);
vm.runInContext(appendSandboxSrc, appendSandbox, {filename: 'append-batch-result-sandbox.js'});
const appendTo = (additions, kind) => {
    const node = appendSandbox.__newNode();
    appendSandbox.__append(node, additions, kind);
    return node;
};
const sameUrl = [{url:'/output/same.png', kind:'image', rowNumber:1}, {url:'/output/same.png', kind:'image', rowNumber:2}];
let groupNode = appendTo(sameUrl);
eq(groupNode.images.length, 2, '两行回了同一张图 → 仍然是 2 条产出');
eq(groupNode.title, 'Group', '两行 → 标题仍是 Group（自动群组没被取消）');
eq(groupNode.images.map(i => i.rowNumber), [1, 2], '行号保留（逐行进度格按它归位）');
groupNode = appendTo([{url:'/output/a.png', rowNumber:1}, {url:'/output/a.png', rowNumber:1}]);
eq(groupNode.images.length, 1, '同一行重复产出仍然去重');
groupNode = appendTo([{url:'/output/a.png'}, {url:'/output/a.png'}]);
eq(groupNode.images.length, 1, '非批量（没有行号）仍然按 url 去重，行为不变');
eq(groupNode.title, 'Image', '非批量单张 → Image');
groupNode = appendTo([{url:'/output/v1.mp4', kind:'video', rowNumber:1}, {url:'/output/v2.mp4', kind:'video', rowNumber:2}], 'video');
eq(groupNode.title, 'Videos', '批量视频多行 → Videos');
eq(appendSandbox.__done, undefined, '还有行没跑完时不提前收尾（pending 归零才收）');



console.log(label + '：' + pass + ' 项通过');
if(fails.length){ fails.forEach(msg => console.error('  ✗ ' + msg)); console.error('失败 ' + fails.length + ' 项'); process.exit(1); }
console.log('全部通过');
