#!/usr/bin/env node
/* 挑图（并排对比）打开闪屏回归：
   F1 入场期间不能挂 backdrop-filter（整屏模糊每帧重算，实测单帧 70-80ms），只挂纯色遮罩；
   F2 面板动画不淡入（opacity 会让面板半透明、透出画布和工具条）；
   F3 打开时先把内容建好、首屏缩略图就绪再显示（不出现"空卡片 → 图片突然出现"）；
   F4 标星 / 淘汰 / 光标 / 放大切换不重建 DOM（不重载图片）。
   跑法：node tests/test_smart_canvas_pick_flash.js */
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
function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    if(at < 0) return '';
    const end = css.indexOf('}', at);
    return css.slice(at, end + 1);
};

console.log('[F1] 入场期间不挂整屏 backdrop-filter');
const pickRule = rule('.nv-pick');
ok(pickRule !== '', '存在 .nv-pick 基础规则');
ok(!/backdrop-filter/.test(pickRule), '.nv-pick 基础规则里没有 backdrop-filter（入场不掉帧）');
const settledRule = rule('.nv-pick.nv-pick-settled');
ok(/backdrop-filter:blur\(28px\)/.test(settledRule), '磨砂只在 .nv-pick-settled 上（动画结束后再开）');
ok(/-webkit-backdrop-filter:blur\(28px\)/.test(settledRule), '保留 -webkit- 前缀');
ok(/background:rgba\(250,250,250,\.42\)/.test(pickRule), '最终玻璃底色仍是 rgba(250,250,250,.42)');
ok(/rgba\(6,6,6,\.58\)/.test(css), '深色最终底色仍是 rgba(6,6,6,.58)');
const openRule = rule('.nv-pick.open');
ok(/display:flex/.test(openRule) && !/animation/.test(openRule), '.nv-pick.open 只负责 display，不再整体淡入');
const scrimRule = rule('.nv-pick.open:not(.nv-pick-settled)');
ok(/background:rgba\(250,250,250,\.74\)/.test(scrimRule), '入场期间用更实的纯色遮罩兜住画布');
ok(/rgba\(8,8,8,\.72\)/.test(rule('.theme-dark .nv-pick.open:not(.nv-pick-settled)')), '深色入场遮罩同样加厚');
ok(!/nvPickIn/.test(css), '删掉了整屏淡入的 nvPickIn 动画');

console.log('[F2] 面板不淡入');
const panelKeyframes = rule('@keyframes nvPickPanel'.replace(' {', ''));
ok(panelKeyframes === '' ? /@keyframes nvPickPanel \{[^}]*\}/.test(css) : true, '存在 nvPickPanel 动画');
ok(!/@keyframes nvPickPanel \{[^}]*opacity/.test(css), 'nvPickPanel 不再改 opacity（面板始终不透明）');
ok(/@keyframes nvPickPanel \{[^}]*transform:translateY\(10px\)/.test(css), '保留位移入场');

console.log('[F3] 先建内容 / 预载缩略图，再显示');
const open = topLevelFunction(js, 'openSmartPickViewer');
const preload = topLevelFunction(js, 'preloadSmartPickCards');
const settle = topLevelFunction(js, 'settleSmartPickBlur');
ok(open !== '' && preload !== '' && settle !== '', '三个函数都在');
const iRender = open.indexOf('renderSmartPickViewer()');
const iAddOpen = open.indexOf("classList.add('open')");
ok(iRender >= 0 && iAddOpen > iRender, 'renderSmartPickViewer 在 classList.add(\'open\') 之前');
ok(/preloadSmartPickCards\(el\)\.then\(/.test(open), '显示前等首屏缩略图就绪');
ok(/if\(smartPickState !== st\) return;/.test(open), '预载期间被关掉就不显示');
ok(/alreadyOpen/.test(open), '已打开时复用（不重复入场动画）');
ok(/classList\.remove\('nv-pick-settled'\)/.test(open), '每次重新入场先摘掉 settled');
ok(/img\.decode/.test(preload), '预载等到 decode 完成（第一帧就有像素）');
ok(/Promise\.race\(\[Promise\.all\(ready\), sleep\(SMART_PICK_PRELOAD_MS\)\]\)/.test(preload), '预载有超时兜底，不会一直不显示');
const card = topLevelFunction(js, 'smartPickCardHtml');
ok(/decoding="async"/.test(card), '卡片图带 decoding="async"');
ok(!/loading="lazy"/.test(card), '卡片图不再 loading="lazy"（display:none 里懒加载不发请求，会出现空卡片）');
ok(/\.nv-pick-img \{[^}]*background:var\(--soft\)/.test(css), '卡片图占位底色是 --soft（不闪白）');
const close = topLevelFunction(js, 'closeSmartPickViewer');
ok(/clearTimeout\(smartPickBlurTimer\)/.test(close), '关闭时清掉 blur 定时器');
ok(/nv-pick-settled/.test(close), '关闭时摘掉 settled');

console.log('[F4] 标星 / 淘汰 / 切换不重建 DOM');
const render = topLevelFunction(js, 'renderSmartPickViewer');
const sync = topLevelFunction(js, 'syncSmartPickViewer');
const mark = topLevelFunction(js, 'setSmartPickMark');
const move = topLevelFunction(js, 'moveSmartPick');
ok(render !== '' && sync !== '', 'render / sync 都在');
ok(/el\.dataset\.pickKey !== key/.test(render), '只有图片集合变化（pickKey 变了）才重建骨架');
ok(/syncSmartPickViewer\(\)/.test(render), 'render 之后走增量 sync');
ok(!/innerHTML/.test(sync), 'sync 里没有 innerHTML（只改 class / 属性）');
ok(/classList\.toggle\('is-star'/.test(sync) && /classList\.toggle\('is-reject'/.test(sync), '标星 / 淘汰用 classList 切换');
ok(/stage\.appendChild/.test(sync), '放大态把卡片节点搬进 stage（不重建）');
ok(/grid\.insertBefore/.test(sync), '退出放大态按原顺序搬回网格');
ok(!/innerHTML/.test(mark) && /renderSmartPickViewer\(\)/.test(mark), 'setSmartPickMark 走增量路径');
ok(!/innerHTML/.test(move), '上下切换不重建 DOM');
ok(/\.nv-pick\.is-focus \.nv-pick-grid \{ display:none; \}/.test(css), '放大态用 class 切换可见性');
ok(/\.nv-pick:not\(\.is-focus\) \.nv-pick-focus, \.nv-pick:not\(\.is-focus\) \.nv-pick-back \{ display:none; \}/.test(css), '网格态隐藏放大容器和返回按钮');

console.log('[F5] 纯函数行为');
const sandboxSrc = [
    topLevelFunction(js, 'smartPickCols'),
    topLevelFunction(js, 'smartPickEntryKey'),
    'globalThis.__api = {cols: smartPickCols, key: smartPickEntryKey};',
].join('\n');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(sandboxSrc, sandbox);
const api = sandbox.__api;
ok(api.cols(2) === 2 && api.cols(4) === 4, '2-4 张按张数分列');
ok(api.cols(5) === 3 && api.cols(6) === 3, '5-6 张 3 列');
ok(api.cols(7) === 4 && api.cols(12) === 4, '7-12 张 4 列');
ok(api.cols(13) === 5 && api.cols(40) === 5, '13+ 张 5 列');
const entry = (nodeId, index, url) => ({node: {id: nodeId}, index: index, raw: {url: url || ''}});
ok(api.key([entry('n1', 0, 'a.png'), entry('n1', 1, 'b.png')]) === 'n1#0@a.png|n1#1@b.png', 'pickKey 按节点 + 序号 + 原图地址');
ok(api.key([entry('n1', 1), entry('n1', 0)]) !== api.key([entry('n1', 0), entry('n1', 1)]), '顺序变化也算内容变化');
ok(api.key([entry('n1', 0)]) !== api.key([entry('n1', 1)]), '同一节点删图后 key 会变（触发重建）');
ok(api.key([entry('n1', 0, 'a.png')]) !== api.key([entry('n1', 0, 'z.png')]), '同位置换图也会触发重建');
ok(api.key([{node: {id: 'n1'}, index: 0}]) === 'n1#0@', '缺失 raw 时 key 仍可用（不抛错）');

console.log('');
if(fails.length){
    console.log('FAILED ' + fails.length + ' / ' + (pass + fails.length));
    fails.forEach(name => console.log('  - ' + name));
    process.exit(1);
}
console.log('ok ' + pass + ' 项断言全过');
