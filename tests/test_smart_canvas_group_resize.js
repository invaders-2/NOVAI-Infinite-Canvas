#!/usr/bin/env node
/* 群组节点拖动改大小回归（B）：
   B1. 多图 smart-image 节点：手动拖过的尺寸不再被「内容变化（追加素材）」清掉；
   B2. smart-group：拖动把手时框随手势（不再被成员包围盒收紧回去），成员按框排进框内、不越界不重叠；
   B3. 智能分组容器整理仍复用 arrangeSmartGroupMembers；未拖拽的普通整理保持旧的「按内容收紧」。
   B4. createLoopNode 死代码已删除，smart-loop 的渲染与级联仍保留。
   跑法：node tests/test_smart_canvas_group_resize.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const js = read('static/js/smart-canvas.js');

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

console.log('[1] 静态接线：尺寸持久化 + 分组缩放分支');
const append = topLevelFunction(js, 'appendImagesToSmartNode');
ok(/if\(!node\.sizeUserSet\)\{ delete node\.w; delete node\.h; \}/.test(append), '追加素材时不丢用户手动尺寸（多图分支）');
ok(/if\(!node\.sizeUserSet\)\{ delete node\.w; delete node\.h; \} \}/.test(append), '追加素材时不丢用户手动尺寸（单图分支）');
const absorb = topLevelFunction(js, 'absorbImageNodeIntoSmartGroup');
ok(/if\(!group\.sizeUserSet\)\{ delete group\.w; delete group\.h; \}/.test(absorb), '图片收进分组时不丢用户手动尺寸');
const add = topLevelFunction(js, 'addNodeToSmartGroup');
ok(/mergedImages\.length && !group\.sizeUserSet/.test(add), '分组合并时不丢用户手动尺寸');
ok(/const manualSizable = [^\n]*isSmartGroupNode\(node\)/.test(js), 'smart-group 拖动把手也会标记 sizeUserSet（可持久化）');
ok(/arrangeSmartGroupMembers\(node, \{skipUndo:true, syncDom:true, frame:true\}\)/.test(js), 'smart-group 缩放分支用 frame 模式整理成员');
ok(!/resizeState\.members/.test(js) && !/resizeState\.contentFit/.test(js), '旧的「按成员包围盒收紧框」快照逻辑已移除');
const arrange = topLevelFunction(js, 'arrangeSmartGroupMembers');
ok(/options\.frame && !hasThumbImages\) return arrangeSmartGroupMembersInFrame/.test(arrange), '有缩略图走原网格；纯真实成员走 frame 排布');
const frameFn = topLevelFunction(js, 'arrangeSmartGroupMembersInFrame');
ok(/group\.w = boxW;/.test(frameFn) && /group\.h = boxH;/.test(frameFn), 'frame 排布保持分组框不变（框由手势决定）');

console.log('[2] 行为：frame 排布把成员排进框内');
const sandboxSrc = [
    'const SMART_GROUP_MIN_WIDTH=150;',
    'const SMART_GROUP_MIN_HEIGHT=130;',
    'const SMART_GROUP_DEFAULT_WIDTH=340;',
    'const SMART_GROUP_DEFAULT_HEIGHT=286;',
    'const SMART_GROUP_ARRANGE_PADDING=18;',
    'const SMART_GROUP_ARRANGE_GAP=16;',
    'const SMART_GROUP_ARRANGE_HEADER=44;',
    'const SMART_GROUP_MAX_MEMBER_ZOOM=4;',
    'let nodes=[];',
    'function isSmartGroupNode(n){return Boolean(n&&n.type==="smart-group");}',
    'function isSmartMediaNode(n){return Boolean(n&&(n.type==="smart-image"||n.type==="smart-video"));}',
    'function smartGroupMembers(g){const ids=Array.isArray(g.items)?g.items:[];return ids.map(id=>nodes.find(n=>n.id===id)).filter(m=>m&&!isSmartGroupNode(m));}',
    'function smartGroupCompactMembers(g){return smartGroupMembers(g).filter(m=>m.type==="smart-prompt"||m.type==="smart-loop");}',
    'function smartGroupMemberImageNodes(g){return smartGroupMembers(g).filter(m=>isSmartMediaNode(m)&&(m.images||[]).some(i=>i&&i.url));}',
    'function smartGroupReadingRowTolerance(a,b){const ra=nodeRect(a),rb=nodeRect(b);const minH=Math.min(Number(ra.height)||0,Number(rb.height)||0);return Math.max(2,Math.min(24,minH*0.5));}',
    'function smartGroupReadingOrder(a,b){const ra=nodeRect(a),rb=nodeRect(b);const dy=(Number(ra.y)||0)-(Number(rb.y)||0);if(Math.abs(dy)>smartGroupReadingRowTolerance(a,b))return dy;return (Number(ra.x)||0)-(Number(rb.x)||0);}',
    'function nodeRect(n){return {x:Number(n.x)||0,y:Number(n.y)||0,width:Number(n.w)||Number(n.rectW)||120,height:Number(n.h)||Number(n.rectH)||120};}',
    'function syncSmartGroupMemberElements(){}',
    'function pushUndo(){}',
    frameFn,
    'function smartGroupCardImageRefs(){return [];}',
    'function smartGroupThumbLayout(){return null;}',
    arrange,
    'globalThis.__api={frame:(g,o)=>arrangeSmartGroupMembersInFrame(g,o),arr:(g,o)=>arrangeSmartGroupMembers(g,o),setNodes:ns=>{nodes=ns;}};',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox);
const api = sandbox.__api;
const mkImg = id => ({id, type:'smart-image', x:0, y:0, images:[{url:id + '.png'}]});
const mkPrompt = id => ({id, type:'smart-prompt', x:0, y:0, images:[]});
const mkGroup = (w, h, members) => ({id:'g', type:'smart-group', x:100, y:100, w, h, items:members.map(m => m.id)});
const inside = (outer, r, tol=2) => r.x >= outer.x - tol && r.y >= outer.y - tol && r.x + r.w <= outer.x + outer.w + tol && r.y + r.h <= outer.y + outer.h + tol;
const rect = n => ({x:n.x, y:n.y, w:n.w, h:n.h});
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

(function caseFrameKeepsSize(){
    const g = mkGroup(900, 600, []);
    const m1 = mkImg('m1'), m2 = mkImg('m2'), m3 = mkImg('m3');
    for(const m of [m1, m2, m3]){ m.w = 200; m.h = 200; }
    g.items = ['m1', 'm2', 'm3']; g.x = 100; g.y = 100;
    api.setNodes([g, m1, m2, m3]);
    const changed = api.frame(g, {});
    ok(changed === true, 'frame 排布返回 true');
    ok(g.w === 900 && g.h === 600, 'frame 排布不改分组框（900x600 保持）');
    const box = {x:100, y:100, w:900, h:600};
    ok([m1, m2, m3].every(m => inside(box, rect(m))), '三个图片成员都在框内');
    ok(!overlap(rect(m1), rect(m2)) && !overlap(rect(m1), rect(m3)) && !overlap(rect(m2), rect(m3)), '成员两两不重叠');
    ok([m1, m2, m3].every(m => m.w > 0 && m.h > 0), '成员尺寸有效');
})();

(function caseShrink(){
    const g = mkGroup(260, 200, []);
    const m1 = mkImg('s1'), m2 = mkImg('s2');
    for(const m of [m1, m2]){ m.w = 240; m.h = 240; }
    g.items = ['s1', 's2']; g.x = 100; g.y = 100;
    api.setNodes([g, m1, m2]);
    api.frame(g, {});
    ok(g.w === 260 && g.h === 200, '缩小分组时框保持拖出来的大小');
    const box = {x:100, y:100, w:260, h:200};
    ok([m1, m2].every(m => inside(box, rect(m))), '缩小时成员仍落在框内');
    ok(!overlap(rect(m1), rect(m2)), '缩小时成员不重叠');
    ok(m1.w < 240 && m2.w < 240, '缩小时成员跟着缩小');
})();

(function casePromptMembers(){
    const g = mkGroup(700, 400, []);
    const p1 = mkPrompt('p1'), p2 = mkPrompt('p2');
    p1.w = 300; p1.h = 160; p2.w = 220; p2.h = 120;
    g.items = ['p1', 'p2'];
    api.setNodes([g, p1, p2]);
    api.frame(g, {});
    const box = {x:100, y:100, w:700, h:400};
    ok([p1, p2].every(m => inside(box, rect(m))), '提示词成员也在框内');
    ok(!overlap(rect(p1), rect(p2)), '提示词成员不重叠');
})();

(function casePlainArrangeStillFitsContent(){
    const g = mkGroup(900, 600, []);
    const m1 = mkImg('a1'), m2 = mkImg('a2');
    m1.w = 200; m1.h = 200; m2.w = 200; m2.h = 200;
    g.items = ['a1', 'a2']; g.x = 100; g.y = 100;
    api.setNodes([g, m1, m2]);
    api.arr(g, {});
    ok(g.w !== 900, '普通「整理」仍把框收紧到内容（未拖拽语义不变）');
})();

(function caseArrangeWithFrameKeepsSize(){
    const g = mkGroup(900, 600, []);
    const m1 = mkImg('f1'), m2 = mkImg('f2');
    m1.w = 200; m1.h = 200; m2.w = 200; m2.h = 200;
    g.items = ['f1', 'f2']; g.x = 100; g.y = 100;
    api.setNodes([g, m1, m2]);
    api.arr(g, {frame:true});
    ok(g.w === 900 && g.h === 600, '带 frame 的整理保持框不变');
})();

console.log('[3] 循环节点死代码');
ok(!/function createLoopNode\(/.test(js), 'createLoopNode 已删除（全仓零调用点）');
ok(/function smartLoopBodyHtml\(/.test(js), 'smart-loop 渲染保留');
ok(/function resolveSmartCascadeLoop\(/.test(js) && /async function runSmartCascade\(/.test(js), 'smart-loop 级联执行保留');

console.log('');
console.log('群组缩放回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
