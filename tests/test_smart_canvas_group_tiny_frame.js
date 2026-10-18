#!/usr/bin/env node
/* 群组「极小框 + 多成员」回归（B6）：
   B6-1 frame 排布：150×130 这类极小分组 + 4/8/16/20 个极端比例成员。
        改前拟合出的单格 <40，却仍按 Math.max(40) 渲染，整格网格被顶出内框、成员两两重叠；
        改后必须「零越界 + 零重叠」，且分组框仍保持手势拖出来的尺寸。
   B6-2 缩略图网格：把图片成员吸收成 group.images（保存重载迁移）后，
        卡片里的缩略图网格也必须落在容器内（复用 groupImageGridLayout 的收窄逻辑）。
   跑法：node tests/test_smart_canvas_group_tiny_frame.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

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

console.log('[1] 静态接线：极小框不再被硬编码下限顶破');
const frameFn = topLevelFunction(js, 'arrangeSmartGroupMembersInFrame');
ok(frameFn !== '', '找得到 arrangeSmartGroupMembersInFrame');
ok(!/Math\.max\(40, Number\(r\.width\)/.test(frameFn), 'frame 排布不再用 Math.max(40) 当成员下限');
ok(!/Math\.max\(40, Math\.round\(s\.[wh] \* fit\)\)/.test(frameFn), 'frame 落位不再用 Math.max(40) 收尾');
ok(/const cellW = colW\.map/.test(frameFn) && /const budgetW = innerW/.test(frameFn), '格子按 fit 取整并收敛到内框');
ok(/function groupImageGridLayout\([^)]*minThumb=28\)/.test(js), 'groupImageGridLayout 增加 minThumb 参数（默认 28，其它调用点不变）');
ok(/groupImageGridLayout\(count, Math\.max\(72, innerW\), Math\.max\(56, innerH\), 100000, 0, gap, maxVisibleRows, 1\)/.test(js), '缩略图网格兜底允许格子收窄到 1px');
ok(!/const thumb = Math\.max\(24, Math\.round\(Number\(layout\.thumb\)/.test(js), '缩略图成员格不再硬撑 24px');
ok(!/const groupCellH = Math\.max\(24,/.test(js), '卡片缩略图格高不再硬撑 24px');
ok(/分组里的真实图片成员/.test(js) && /smartGroupContainingNode\(node\.id\)/.test(js), 'imageLayout 让分组图片成员听自己的 w/h（极小成员不再按自然尺寸重算顶破框）');

console.log('[2] 行为：真实函数在沙盒里跑确定性矩阵');
const constNames = ['SMART_GROUP_MIN_WIDTH','SMART_GROUP_MIN_HEIGHT','SMART_GROUP_DEFAULT_WIDTH','SMART_GROUP_DEFAULT_HEIGHT','SMART_GROUP_ARRANGE_PADDING','SMART_GROUP_ARRANGE_GAP','SMART_GROUP_ARRANGE_HEADER','SMART_GROUP_MAX_MEMBER_ZOOM','MEDIA_GROUP_THUMB_BASE','MEDIA_GROUP_DEFAULT_SCALE','SMART_GROUP_MAX_VISIBLE_ROWS','MEDIA_NODE_DEFAULT_SCALE','MEDIA_GROUP_MAX_VISIBLE_ROWS'];
const fnNames = ['smartGroupMembers','smartGroupCompactMembers','smartGroupMemberImageNodes','smartGroupCardImageRefs','mediaLayoutSize','mediaNodeDefaultScale','isAudioMediaItem','smartGroupSingleInnerBox','singleImageLayout','groupImageGridLayout','smartGroupThumbLayout','arrangeSmartGroupMembersInFrame','smartGroupReadingRowTolerance','smartGroupReadingOrder'];
let src = constNames.map(c => constant(js, c)).filter(Boolean).join('\n') + '\n';
src += 'let nodes=[];let canvas={connections:[]};\n';
src += 'function nodeRect(n){return {x:Number(n.x)||0,y:Number(n.y)||0,width:(n.w!==undefined&&n.w!==null)?Number(n.w):120,height:(n.h!==undefined&&n.h!==null)?Number(n.h):120};}\n';
src += 'function isSmartGroupNode(n){return Boolean(n&&n.type==="smart-group");}\n';
src += 'function isSmartMediaNode(n){return Boolean(n&&(n.type==="smart-image"||n.type==="smart-video"));}\n';
src += 'function imageForDisplay(x){return x;}\nfunction pushUndo(){}\nfunction syncSmartGroupMemberElements(){}\n';
for(const n of fnNames){ const f = topLevelFunction(js, n); if(!f) throw new Error('missing ' + n); src += f + '\n'; }
src += 'globalThis.__api={' + fnNames.map(n => n + ':' + n).join(',') + ',setNodes:ns=>{nodes=ns;}};\n';
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const api = sandbox.__api;

// 极端比例（含任务里点名的 1600×100 / 100×1600 / 2000×300）
const SHAPES = [[1600,100],[100,1600],[2000,300],[300,2000],[1200,800],[800,1200],[2000,100],[100,2000]];
const BOXES = [[150,130],[200,160],[260,200],[340,286],[500,400],[900,600],[150,400],[400,150],[150,150]];
function buildMembers(n){
    const list = [];
    for(let i = 0; i < n; i += 1){
        const s = SHAPES[i % SHAPES.length];
        list.push({id:'m' + i, type:'smart-image', x:0, y:0, w:s[0], h:s[1], images:[{url:'m' + i + '.png'}]});
    }
    return list;
}
const rectOf = m => ({x:m.x, y:m.y, w:m.w, h:m.h});
const inside = (box, r) => r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h;
const overlaps = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

for(const n of [4, 8, 16, 20]){
    const row = [];
    for(const box of BOXES){
        const members = buildMembers(n);
        const g = {id:'g', type:'smart-group', x:100, y:100, w:box[0], h:box[1], items:members.map(m => m.id)};
        api.setNodes([g, ...members]);
        api.arrangeSmartGroupMembersInFrame(g, {});
        const outer = {x:g.x, y:g.y, w:box[0], h:box[1]};
        const rects = members.map(rectOf);
        const outCount = rects.filter(r => !inside(outer, r)).length;
        let overlapCount = 0;
        for(let i = 0; i < rects.length; i += 1) for(let j = i + 1; j < rects.length; j += 1){
            if(overlaps(rects[i], rects[j])) overlapCount += 1;
        }
        row.push(box[0] + 'x' + box[1] + '=>' + outCount + '/' + overlapCount);
        ok(outCount === 0, n + ' 成员 @' + box[0] + 'x' + box[1] + ' 零越界（实测 ' + outCount + '）');
        ok(overlapCount === 0, n + ' 成员 @' + box[0] + 'x' + box[1] + ' 零重叠（实测 ' + overlapCount + '）');
        ok(g.w === box[0] && g.h === box[1], n + ' 成员 @' + box[0] + 'x' + box[1] + ' 分组框保持手势尺寸');
        ok(members.every(m => m.w >= 1 && m.h >= 1), n + ' 成员 @' + box[0] + 'x' + box[1] + ' 成员尺寸有效');
    }
    console.log('  N=' + String(n).padStart(2) + '  ' + row.join('  '));
}

(function normalFrameStillZooms(){
    const members = buildMembers(3).map(m => { m.w = 200; m.h = 200; return m; });
    const g = {id:'g2', type:'smart-group', x:100, y:100, w:900, h:600, items:members.map(m => m.id)};
    api.setNodes([g, ...members]);
    api.arrangeSmartGroupMembersInFrame(g, {});
    const outer = {x:100, y:100, w:900, h:600};
    ok(members.every(m => inside(outer, rectOf(m))), '常规大框：3 个 200×200 成员仍在框内');
    ok(members.every(m => m.w > 200 && m.h > 200), '常规大框：成员仍会跟着框放大（保留放大语义）');
})();

(function shrinkStillFits(){
    const members = buildMembers(2).map(m => { m.w = 240; m.h = 240; return m; });
    const g = {id:'g3', type:'smart-group', x:100, y:100, w:260, h:200, items:members.map(m => m.id)};
    api.setNodes([g, ...members]);
    api.arrangeSmartGroupMembersInFrame(g, {});
    const outer = {x:100, y:100, w:260, h:200};
    ok(members.every(m => inside(outer, rectOf(m))), '缩小分组：成员落在框内');
    ok(members.every(m => m.w >= 1 && m.h >= 1), '缩小分组：成员尺寸有效');
})();

console.log('[3] 行为：保存重载后的缩略图网格也在容器内');
const OUTER_PAD = 32;
const SUMMARY_SPACE = 28;
for(const n of [4, 8, 16, 20]){
    const images = [];
    for(let i = 0; i < n; i += 1){
        const s = SHAPES[i % SHAPES.length];
        images.push({url:'u' + i, natural_w:s[0], natural_h:s[1]});
    }
    // 迁移后的形态：成员被吸收进 group.images（卡片只画缩略图网格）
    const g = {id:'g' + n, type:'smart-group', x:100, y:100, w:150, h:130, items:[], images, sizeUserSet:true};
    api.setNodes([g]);
    const layout = api.smartGroupThumbLayout(g);
    const thumb = Math.max(1, Math.round(Number(layout.thumb) || 96));
    const cellH = Math.max(1, Math.round(Number(layout.thumbH) || thumb));
    const visibleRows = Math.max(1, Number(layout.visibleRows || layout.rows || 1));
    const gridW = layout.cols * thumb + Math.max(0, layout.cols - 1) * 8;
    const gridH = visibleRows * cellH + Math.max(0, visibleRows - 1) * 8;
    const innerW = 150 - OUTER_PAD;
    const innerH = 130 - OUTER_PAD - SUMMARY_SPACE;
    console.log('  N=' + String(n).padStart(2) + '  cols=' + layout.cols + ' rows=' + layout.rows + ' thumb=' + thumb + ' cellH=' + cellH + ' grid=' + gridW + 'x' + gridH + ' inner=' + innerW + 'x' + innerH);
    ok(gridW <= innerW, n + ' 图缩略图网格不超出容器宽（' + gridW + ' <= ' + innerW + '）');
    ok(gridH <= innerH, n + ' 图缩略图网格不超出容器高（' + gridH + ' <= ' + innerH + '）');
}

(function defaultMinThumbUnchanged(){
    const big = api.groupImageGridLayout(16, 900, 600, 96, 32, 8, 4);
    ok(big.thumb >= 28, 'groupImageGridLayout 默认最小格仍是 28px（其它调用点不受影响）');
    const tight = api.groupImageGridLayout(16, 118, 70, 100000, 0, 8, 4, 1);
    const usedW = tight.cols * tight.thumb + (tight.cols - 1) * 8;
    ok(usedW <= 118, 'groupImageGridLayout 传入 minThumb=1 时网格宽度落进容器');
})();

console.log('');
console.log('群组极小框回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
