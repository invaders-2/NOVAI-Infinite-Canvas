#!/usr/bin/env node
/* 经典画布群组自由缩放回归（C1）：
   C1-1 拖把手时 arrangeCanvasGroupMembers 收到 fitBox：框由手势决定，成员缩进框里，不把分组撑回去；
   C1-2 极小框（220x96）里 8 个极端比例成员也零越界、零重叠；
   C1-3 反复重排收敛、顺序稳定；
   C1-4 其它调用方（整理按钮等）保持旧行为：放不下时把分组撑到刚好装下。
   跑法：node tests/test_canvas_group_fit_box.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/canvas.js'), 'utf8');

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

console.log('[1] 静态接线');
ok(/arrangeCanvasGroupMembers\(resizeNode\.node, \{fitBox:true\}\)/.test(js), '拖把手时传 fitBox:true');
const arrange = topLevelFunction(js, 'arrangeCanvasGroupMembers');
ok(/options\.fitBox \? Math\.max\(1, Math\.round\(Number\(group\.w\)/.test(arrange), 'fitBox 按真实框宽排（不套 220 下限）');
ok(/options\.fitBox \? Math\.max\(1, Math\.round\(Number\(group\.h\)/.test(arrange), 'fitBox 按真实框高排（不套 180 下限）');
ok(/if\(!chosen && options\.fitBox\) chosen = canvasGroupTightLayout\(/.test(arrange), 'fitBox 放不下时走收窄兜底');
ok(/const gapX = Number\.isFinite\(chosen\.gapX\)/.test(arrange) && /const gapY = Number\.isFinite\(chosen\.gapY\)/.test(arrange), '落位使用兜底排布的收窄间距');
ok(topLevelFunction(js, 'canvasGroupTightLayout') !== '', '存在 canvasGroupTightLayout');

console.log('[2] 行为：成员缩进框里');
const sandboxSrc = [
    'let nodes=[];',
    'let nodesEl={querySelector:()=>null};',
    'const CSS={escape:s=>String(s)};',
    'function nodeRect(n){return {x:Number(n.x)||0,y:Number(n.y)||0,width:(n.w!==undefined&&n.w!==null)?Number(n.w):120,height:(n.h!==undefined&&n.h!==null)?Number(n.h):120};}',
    'function syncCanvasNodeBox(){}',
    topLevelFunction(js, 'canvasGroupMemberAspect'),
    topLevelFunction(js, 'canvasGroupTightLayout'),
    arrange,
    'globalThis.__api={arrange:arrangeCanvasGroupMembers,setNodes:ns=>{nodes=ns;}};',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox);
const api = sandbox.__api;

const SHAPES = [[1600,100],[100,1600],[2000,300],[300,2000],[1200,800],[800,1200],[2000,100],[100,2000]];
function buildMembers(n){
    return Array.from({length:n}, (_, i) => {
        const s = SHAPES[i % SHAPES.length];
        return {id:'m' + i, type:'image', x:0, y:0, w:s[0], h:s[1], url:'m' + i + '.png'};
    });
}
const inside = (g, m) => m.x >= g.x && m.y >= g.y && m.x + m.w <= g.x + g.w && m.y + m.h <= g.y + g.h;
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const readOrder = list => list.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x)).map(m => m.id);

for(const size of [[560,380],[220,96],[400,150],[900,600],[260,700]]){
    const members = buildMembers(8);
    const g = {id:'g', type:'group', x:100, y:100, w:size[0], h:size[1], items:members.map(m => m.id)};
    api.setNodes([g, ...members]);
    api.arrange(g, {fitBox:true});
    ok(g.w === size[0] && g.h === size[1], 'fitBox ' + size.join('x') + ' 不改分组框（实测 ' + g.w + 'x' + g.h + '）');
    ok(members.every(m => inside(g, m)), 'fitBox ' + size.join('x') + ' 成员全部在框内');
    let overlaps = 0;
    for(let i = 0; i < members.length; i += 1) for(let j = i + 1; j < members.length; j += 1){
        if(overlap(members[i], members[j])) overlaps += 1;
    }
    ok(overlaps === 0, 'fitBox ' + size.join('x') + ' 成员零重叠（实测 ' + overlaps + '）');
    ok(members.every(m => m.w >= 1 && m.h >= 1), 'fitBox ' + size.join('x') + ' 成员尺寸有效');
    const order = readOrder(members);
    let drift = Infinity;
    for(let round = 0; round < 5 && drift > 0; round += 1){
        const before = members.map(m => ({x:m.x, y:m.y, w:m.w, h:m.h}));
        api.arrange(g, {fitBox:true});
        drift = members.reduce((max, m, i) => Math.max(max, Math.abs(m.x - before[i].x), Math.abs(m.y - before[i].y), Math.abs(m.w - before[i].w), Math.abs(m.h - before[i].h)), 0);
    }
    ok(drift === 0, 'fitBox ' + size.join('x') + ' 反复重排收敛（最大漂移 ' + drift + 'px）');
    ok(JSON.stringify(readOrder(members)) === JSON.stringify(order), 'fitBox ' + size.join('x') + ' 反复重排顺序不变');
}

console.log('[3] 其它调用方保持旧行为');
(function growStillWorks(){
    const members = buildMembers(8);
    const g = {id:'g2', type:'group', x:100, y:100, w:220, h:96, items:members.map(m => m.id)};
    api.setNodes([g, ...members]);
    api.arrange(g, {});
    ok(g.w > 220 || g.h > 96, '不带 fitBox：放不下时仍把分组撑到刚好装下（旧行为）');
})();

console.log('');
console.log('经典画布群组 fitBox 回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
