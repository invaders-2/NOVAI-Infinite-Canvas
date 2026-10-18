#!/usr/bin/env node
/* 群组自由宽高回归（B7）：
   B7-1 图片分组和真实成员分组都走 smartGroupFreeResizeBox：只拉宽只变宽、只拉高只变高、
        对角两边都变，最小尺寸各夹各的；
   B7-2 图片分组的把手缩放不再走 resizeBoxWithAspect（单一缩放倍数 → 宽高联动）；
   B7-3 拖拽过程中同步分组格高 / 网格居中偏移（否则拖的时候缩略图还用上次的格高）；
   B7-4 按新框重排后：极端比例 + 图片/视频成员零越界、零重叠，阅读顺序稳定。
   跑法：node tests/test_smart_canvas_group_free_resize.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label + '（实际 ' + JSON.stringify(a) + '）');

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
function constant(src, name){
    const m = src.match(new RegExp('^const ' + name + '\\s*=\\s*([^;]+);', 'm'));
    return m ? 'const ' + name + ' = ' + m[1] + ';' : '';
}

console.log('[1] 静态接线：宽高各自跟手');
const free = topLevelFunction(js, 'smartGroupFreeResizeBox');
ok(free !== '', '存在 smartGroupFreeResizeBox');
ok(/w:Math\.max\(minW, Math\.round\(\(Number\(startW\) \|\| 0\) \+ dx\)\)/.test(free), '宽度只由 startW + dx 决定');
ok(/h:Math\.max\(minH, Math\.round\(\(Number\(startH\) \|\| 0\) \+ dy\)\)/.test(free), '高度只由 startH + dy 决定');
ok(/const sized = smartGroupFreeResizeBox\(resizeState\.startW, resizeState\.startH, dx, dy, minW, minH\)/.test(js), '分组把手分支用自由宽高');
ok(!/node\.type === 'smart-group' && smartGroupCardImageRefs\(node\)\.some/.test(js), '图片分组专用的等比分支已删除');
ok((js.match(/const sized = resizeBoxWithAspect\(node, resizeState/g) || []).length === 1, 'resizeBoxWithAspect 只剩媒体节点一处');
ok(/arrangeSmartGroupMembers\(node, \{skipUndo:true, syncDom:true, frame:true\}\)/.test(js), '分组按新框重排（frame 模式）');
const resizeFn = topLevelFunction(js, 'updateNodeElementDuringResize');
ok(/grid\.style\.setProperty\('--group-thumb-h'/.test(resizeFn), '拖拽中同步分组格高');
ok(/grid\.style\.marginTop =/.test(resizeFn), '拖拽中同步网格居中偏移');

console.log('[2] 行为：单方向拖动只改一个维度');
const constNames = ['SMART_GROUP_MIN_WIDTH','SMART_GROUP_MIN_HEIGHT','SMART_GROUP_DEFAULT_WIDTH','SMART_GROUP_DEFAULT_HEIGHT',
    'SMART_GROUP_ARRANGE_PADDING','SMART_GROUP_ARRANGE_GAP','SMART_GROUP_ARRANGE_HEADER','SMART_GROUP_MAX_MEMBER_ZOOM',
    'MEDIA_GROUP_THUMB_BASE','MEDIA_GROUP_DEFAULT_SCALE','SMART_GROUP_MAX_VISIBLE_ROWS','MEDIA_NODE_DEFAULT_SCALE','MEDIA_GROUP_MAX_VISIBLE_ROWS'];
const fnNames = ['smartGroupMembers','smartGroupCompactMembers','smartGroupMemberImageNodes','smartGroupCardImageRefs',
    'mediaLayoutSize','mediaNodeDefaultScale','isAudioMediaItem','isVideoMediaItem','smartGroupSingleInnerBox','singleImageLayout',
    'groupImageGridLayout','smartGroupThumbLayout','arrangeSmartGroupMembersInFrame','arrangeSmartGroupMembers','smartGroupFreeResizeBox',
    'smartGroupReadingRowTolerance','smartGroupReadingOrder'];
let src = constNames.map(c => constant(js, c)).filter(Boolean).join('\n') + '\n';
src += 'let nodes=[];let canvas={connections:[]};\n';
src += 'function nodeRect(n){return {x:Number(n.x)||0,y:Number(n.y)||0,width:(n.w!==undefined&&n.w!==null)?Number(n.w):120,height:(n.h!==undefined&&n.h!==null)?Number(n.h):120};}\n';
src += 'function isSmartGroupNode(n){return Boolean(n&&n.type==="smart-group");}\n';
src += 'function isSmartMediaNode(n){return Boolean(n&&(n.type==="smart-image"||n.type==="smart-video"));}\n';
src += 'function smartOriginalMediaUrl(i){return String(i&&i.url||"").toLowerCase();}\n';
src += 'function imageForDisplay(x){return x;}\nfunction pushUndo(){}\nfunction syncSmartGroupMemberElements(){}\n';
for(const n of fnNames){ const f = topLevelFunction(js, n); if(!f) throw new Error('missing ' + n); src += f + '\n'; }
src += 'globalThis.__api={' + fnNames.map(n => n + ':' + n).join(',') + ',setNodes:ns=>{nodes=ns;}};\n';
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const api = sandbox.__api;

const box = (sw, sh, dx, dy) => api.smartGroupFreeResizeBox(sw, sh, dx, dy, 150, 130);
eq(box(560, 380, 300, 0), {w:860, h:380}, '只拉宽：高完全不变');
eq(box(560, 380, 0, 250), {w:560, h:630}, '只拉高：宽完全不变');
eq(box(560, 380, 120, 90), {w:680, h:470}, '对角拖动：宽高同时变');
eq(box(560, 380, -600, 0), {w:150, h:380}, '向左拖过头：宽夹最小、高不变');
eq(box(560, 380, 0, -600), {w:560, h:130}, '向上拖过头：高夹最小、宽不变');
eq(box(150, 130, 100, 100), {w:250, h:230}, '从最小尺寸向外拖正常恢复');

console.log('[3] 行为：图片分组（卡片缩略图）按新框重排');
const SHAPES = [[1600,100],[100,1600],[2000,300],[300,2000],[1200,800],[800,1200]];
function cardImages(n){
    return Array.from({length:n}, (_, i) => {
        const s = SHAPES[i % SHAPES.length];
        return {url:'card' + i + '.png', natural_w:s[0], natural_h:s[1], kind:'image'};
    });
}
function thumbFits(group){
    const layout = api.smartGroupThumbLayout(group);
    const thumb = Math.max(1, Math.round(Number(layout.thumb) || 96));
    const cellH = Math.max(1, Math.round(Number(layout.thumbH) || thumb));
    const visibleRows = Math.max(1, Number(layout.visibleRows || layout.rows || 1));
    const gridW = layout.cols * thumb + Math.max(0, layout.cols - 1) * 8;
    const gridH = visibleRows * cellH + Math.max(0, visibleRows - 1) * 8;
    return {ok:gridW <= Math.max(1, group.w - 32) && gridH <= Math.max(1, group.h - 60), gridW, gridH, layout};
}
for(const size of [[900,600],[1200,420],[420,900],[340,286],[150,130],[1500,240]]){
    const g = {id:'gc', type:'smart-group', x:100, y:100, w:size[0], h:size[1], items:[], images:cardImages(6), sizeUserSet:true};
    api.setNodes([g]);
    api.arrangeSmartGroupMembers(g, {skipUndo:true, frame:true});
    const fit = thumbFits(g);
    ok(g.w === size[0] && g.h === size[1], '图片分组 ' + size.join('x') + ' 重排不改框');
    ok(fit.ok, '图片分组 ' + size.join('x') + ' 缩略图网格在框内（' + fit.gridW + 'x' + fit.gridH + '）');
}

console.log('[4] 行为：图片 + 视频真实成员按新框重排（零越界/零重叠）');
function buildMembers(){
    return [
        {id:'m1', type:'smart-image', x:0, y:0, w:240, h:160, images:[{url:'wide.png', natural_w:1600, natural_h:100}]},
        {id:'m2', type:'smart-video', x:0, y:0, w:200, h:200, images:[{url:'clip.mp4', natural_w:720, natural_h:1280, kind:'video'}]},
        {id:'m3', type:'smart-image', x:0, y:0, w:160, h:240, images:[{url:'tall.png', natural_w:100, natural_h:1600}]}
    ];
}
const inside = (g, m, tol=1) => m.x >= g.x - tol && m.y >= g.y - tol && m.x + m.w <= g.x + g.w + tol && m.y + m.h <= g.y + g.h + tol;
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
function readingOrder(members){
    return members.slice().sort(api.smartGroupReadingOrder).map(m => m.id);
}
for(const size of [[900,600],[560,380],[420,900],[1200,300],[150,130]]){
    const members = buildMembers();
    const g = {id:'gm', type:'smart-group', x:120, y:80, w:size[0], h:size[1], items:members.map(m => m.id), images:[], sizeUserSet:true};
    api.setNodes([g, ...members]);
    api.arrangeSmartGroupMembers(g, {skipUndo:true, frame:true});
    ok(g.w === size[0] && g.h === size[1], '成员分组 ' + size.join('x') + ' 重排不改框');
    ok(members.every(m => inside(g, m)), '成员分组 ' + size.join('x') + ' 成员全部在框内');
    let overlaps = 0;
    for(let i = 0; i < members.length; i += 1) for(let j = i + 1; j < members.length; j += 1){
        if(overlap(members[i], members[j])) overlaps += 1;
    }
    ok(overlaps === 0, '成员分组 ' + size.join('x') + ' 成员零重叠（实测 ' + overlaps + '）');
    eq(readingOrder(members), ['m1','m2','m3'], '成员分组 ' + size.join('x') + ' 阅读顺序稳定');
    const orderBefore = readingOrder(members);
    let drift = Infinity;
    for(let round = 0; round < 5 && drift > 0; round += 1){
        const before = members.map(m => ({x:m.x, y:m.y, w:m.w, h:m.h}));
        api.arrangeSmartGroupMembers(g, {skipUndo:true, frame:true});
        drift = members.reduce((max, m, i) => Math.max(max, Math.abs(m.x - before[i].x), Math.abs(m.y - before[i].y), Math.abs(m.w - before[i].w), Math.abs(m.h - before[i].h)), 0);
    }
    ok(drift === 0, '成员分组 ' + size.join('x') + ' 反复重排收敛（最大漂移 ' + drift + 'px）');
    eq(readingOrder(members), orderBefore, '成员分组 ' + size.join('x') + ' 反复重排顺序不变');
}

console.log('');
console.log('群组自由宽高回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
