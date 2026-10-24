#!/usr/bin/env node
/* 智能分组：拉大/拉小分组时的成员重排（B8）：
   B8-1 成员的格子比例取素材原始比例（不再沿用被压扁的成员框 → 不裁切）；
   B8-2 列数跟着分组的形状走：拉宽变多列、拉窄回一列（自动排序）；
   B8-3 反复缩放收敛、顺序稳定、成员始终在框内且不重叠；
   B8-4 多图成员（批量结果群组）可以按分组给的框铺满（监听 w/h）；
   B8-5 多图媒体节点是「容器」：最后一张图片也允许拖出。
   跑法：node tests/test_smart_canvas_group_frame_reflow.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'static/css/smart-canvas.css'), 'utf8');

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

console.log('[1] 静态接线：重排复用多图网格拟合 + 成员比例取素材原始比例');
const frameFn = topLevelFunction(js, 'arrangeSmartGroupMembersInFrame');
ok(/fitManualMediaGridLayout\(count, innerW, innerH, aspects, 0, gap\)/.test(frameFn), '列数由 fitManualMediaGridLayout 按框形状拟合');
ok(/smartGroupMemberFrameAspect/.test(frameFn), '成员比例走 smartGroupMemberFrameAspect');
const aspectFn = topLevelFunction(js, 'smartGroupMemberFrameAspect');
ok(/mediaLayoutSize\(items\[0\]\)/.test(aspectFn) && /mediaCellAspect\(items\[0\]\)/.test(aspectFn), '单张媒体按素材真实比例，不按成员框比例');
ok(!/s\.w \* fit|s\.h \* fit/.test(frameFn), '不再用成员当前 w/h 当缩放基准');
const layoutFn = topLevelFunction(js, 'imageLayout');
ok(/fitManualMediaGridLayout\(memberItems\.length, memberW, memberH/.test(layoutFn), '多图成员按分组给的框铺满内部格子');
ok(/healSmartGroupMemberFrames\(\)/.test(js), '载入时自愈比例不对的成员框');
ok(/smart-group-media-member/.test(js), '分组内媒体成员带独立 class');
ok(/\.image-node\.smart-group-media-member \.node-img/.test(css) && /object-fit:contain/.test(css), '分组内媒体用 contain 显示（不裁切）');

console.log('[2] 行为：成员按素材比例排、拉宽自动分列');
const constNames = ['SMART_GROUP_MIN_WIDTH','SMART_GROUP_MIN_HEIGHT','SMART_GROUP_DEFAULT_WIDTH','SMART_GROUP_DEFAULT_HEIGHT','SMART_GROUP_ARRANGE_PADDING','SMART_GROUP_ARRANGE_GAP','SMART_GROUP_ARRANGE_HEADER'];
const fnNames = ['smartGroupMembers','smartGroupCompactMembers','smartGroupMemberImageNodes','mediaLayoutSize','mediaCellAspect','smartGroupMemberFrameAspect','fitManualMediaGridLayout','arrangeSmartGroupMembersInFrame','smartGroupReadingRowTolerance','smartGroupReadingOrder'];
let src = constNames.map(c => constant(js, c)).filter(Boolean).join('\n') + '\n';
src += 'let nodes=[];\n';
src += 'function isSmartGroupNode(n){return Boolean(n&&n.type==="smart-group");}\n';
src += 'function isSmartMediaNode(n){return Boolean(n&&(n.type==="smart-image"||n.type==="smart-video"));}\n';
src += 'function nodeRect(n){return {x:Number(n.x)||0,y:Number(n.y)||0,width:Number(n.w)||120,height:Number(n.h)||120};}\n';
src += 'function pushUndo(){}\nfunction syncSmartGroupMemberElements(){}\n';
src += 'function smartGroupCardImageRefs(){return [];}\n';
for(const name of fnNames){ const fn = topLevelFunction(js, name); if(!fn) throw new Error('missing ' + name); src += fn + '\n'; }
src += 'globalThis.__api={' + fnNames.map(name => name + ':' + name).join(',') + ',setNodes:list=>{nodes=list;}};\n';
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const api = sandbox.__api;

const media = (url, w, h) => ({url, kind:'image', natural_w:w, natural_h:h});
const inside = (group, member, tol=1) => member.x >= group.x - tol && member.y >= group.y - tol
    && member.x + member.w <= group.x + group.w + tol && member.y + member.h <= group.y + group.h + tol;
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const rectOf = n => ({x:n.x, y:n.y, w:n.w, h:n.h});

(function naturalAspectBeatsStaleBox(){
    const m1 = {id:'m1', type:'smart-image', x:0, y:0, w:260, h:180, images:[media('portrait.png', 600, 900)]};
    const m2 = {id:'m2', type:'smart-image', x:0, y:0, w:260, h:146, images:[media('landscape.png', 1200, 675)]};
    const group = {id:'g', type:'smart-group', x:100, y:100, w:900, h:600, items:['m1','m2']};
    api.setNodes([group, m1, m2]);
    api.arrangeSmartGroupMembersInFrame(group, {});
    ok(Math.abs((m1.w / m1.h) - (600 / 900)) < 0.02, '竖图成员的框回到 2:3（实测 ' + (m1.w / m1.h).toFixed(3) + '）');
    ok(Math.abs((m2.w / m2.h) - (1200 / 675)) < 0.02, '横图成员的框回到 16:9（实测 ' + (m2.w / m2.h).toFixed(3) + '）');
    ok(m1.w === m2.w, '同一行成员格宽一致（不再出现一张图被挤成细条）');
    ok(m1.y === m2.y && m1.x < m2.x, '拉宽后两张并排（自动分列）');
    ok(inside(group, m1) && inside(group, m2), '成员都在分组框内');
    ok(!overlap(rectOf(m1), rectOf(m2)), '成员不重叠');
})();

(function narrowGroupUsesSingleColumn(){
    const m1 = {id:'m1', type:'smart-image', x:0, y:0, w:260, h:390, images:[media('portrait.png', 600, 900)]};
    const m2 = {id:'m2', type:'smart-image', x:0, y:0, w:260, h:146, images:[media('landscape.png', 1200, 675)]};
    const group = {id:'g', type:'smart-group', x:100, y:100, w:320, h:640, items:['m1','m2']};
    api.setNodes([group, m1, m2]);
    api.arrangeSmartGroupMembersInFrame(group, {});
    ok(m1.x === m2.x && m1.y < m2.y, '拉高后上下排（一列）');
    ok(inside(group, m1) && inside(group, m2), '窄框里成员仍在框内');
    ok(!overlap(rectOf(m1), rectOf(m2)), '窄框里成员不重叠');
})();

(function extremeAspectIsClamped(){
    const m1 = {id:'m1', type:'smart-image', x:0, y:0, w:260, h:180, images:[media('strip.png', 100, 2000)]};
    const m2 = {id:'m2', type:'smart-image', x:0, y:0, w:260, h:180, images:[media('square.png', 800, 800)]};
    const group = {id:'g', type:'smart-group', x:100, y:100, w:700, h:520, items:['m1','m2']};
    api.setNodes([group, m1, m2]);
    api.arrangeSmartGroupMembersInFrame(group, {});
    ok((m1.w / m1.h) >= 0.24, '极端长图的比例夹在 0.25 以上（实测 ' + (m1.w / m1.h).toFixed(3) + '）');
    ok(m1.w > 24 && m1.h > 24, '极端长图仍有可点选的尺寸（' + m1.w + 'x' + m1.h + '）');
    ok(inside(group, m1) && inside(group, m2), '极端长图仍在框内');
})();

(function repeatedResizeConverges(){
    const m1 = {id:'m1', type:'smart-image', x:0, y:0, w:260, h:390, images:[media('portrait.png', 600, 900)]};
    const m2 = {id:'m2', type:'smart-image', x:0, y:0, w:260, h:146, images:[media('landscape.png', 1200, 675)]};
    const m3 = {id:'m3', type:'smart-prompt', x:0, y:0, w:300, h:200};
    const group = {id:'g', type:'smart-group', x:100, y:100, w:760, h:520, items:['m1','m2','m3']};
    api.setNodes([group, m1, m2, m3]);
    const sizes = [[760, 520], [380, 900], [1200, 320], [150, 130], [760, 520]];
    let firstSnapshot = null;
    for(const size of sizes){
        group.w = size[0]; group.h = size[1];
        api.arrangeSmartGroupMembersInFrame(group, {});
        ok([m1, m2, m3].every(n => inside(group, n)), size.join('x') + '：成员全部在框内');
        if(!firstSnapshot) firstSnapshot = [m1, m2, m3].map(n => ({...rectOf(n)}));
    }
    const backSnapshot = [m1, m2, m3].map(n => ({...rectOf(n)}));
    eq(backSnapshot, firstSnapshot, '缩到最小再拉回原尺寸，成员位置/尺寸完全还原（可逆）');
    api.arrangeSmartGroupMembersInFrame(group, {});
    const again = [m1, m2, m3].map(n => ({...rectOf(n)}));
    eq(again, backSnapshot, '同一尺寸反复整理不再漂移');
})();

console.log('[3] 多图媒体容器：最后一张也允许拖出');
const helper = topLevelFunction(js, 'smartMediaNodeIsGroupContainer');
ok(helper !== '', '存在 smartMediaNodeIsGroupContainer');
const helperSandbox = {
    console,
    isSmartMediaNode: n => Boolean(n && ['smart-image','smart-video','smart-audio'].includes(n.type)),
    isHistoryGroupNode: n => Boolean(n && (n.isHistoryGroup || n.historyFor))
};
vm.createContext(helperSandbox);
vm.runInContext(helper + '\nglobalThis.__isGroupContainer = smartMediaNodeIsGroupContainer;', helperSandbox);
const isGroupContainer = helperSandbox.__isGroupContainer;
ok(isGroupContainer({type:'smart-image', images:[{url:'a'},{url:'b'}]}) === true, '多了两张图 = 容器');
ok(isGroupContainer({type:'smart-image', images:[{url:'a'}]}) === false, '普通单图节点不是容器');
ok(isGroupContainer({type:'smart-image', images:[{url:'a'}], mediaGroup:true}) === true, '拖剩一张后仍是容器（可继续拖出）');
ok(isGroupContainer({type:'smart-image', images:[], isHistoryGroup:true}) === true, '历史分组是容器');
ok(isGroupContainer({type:'smart-prompt', images:[]}) === false, '提示词节点不是媒体容器');

const detachBlock = js.slice(js.indexOf('const canDetachThumb'), js.indexOf('const point = screenToWorld(e)'));
ok(/\[\]\)\.length === 1 && smartMediaNodeIsGroupContainer\(source\) && !isHistoryGroupNode\(source\)/.test(detachBlock), '多图容器拖出最后一张也放行（历史分组保持节点拖动）');
ok(/wasGroupContainer\) source\.mediaGroup = true/.test(detachBlock), '拖出后记住容器身份');
ok(/if\(wasGroupContainer && !source\.images\.length/.test(js) && /rerouteSmartConnections\(source\.id, newNode\.id\)/.test(js), '最后一张拖出后移除空容器并把连线接到新节点');
ok(/delete source\.batchRowOrder/.test(detachBlock), '拖出后清掉批量进度格（不残留空占位）');
ok(/\.image-wrap\[data-image-index\]/.test(js), '只剩一张时也给 .image-wrap 绑拖出');
ok(/isSmartMediaNode\(node\) && \(node\.images \|\| \[\]\)\.length > 1\) node\.mediaGroup = true/.test(js), '载入迁移：多图节点标记为容器');

console.log('');
console.log('分组缩放重排回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
