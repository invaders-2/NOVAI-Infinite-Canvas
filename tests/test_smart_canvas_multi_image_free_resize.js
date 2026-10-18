#!/usr/bin/env node
/* 多图节点 / 批量结果群组自由宽高回归：
   M1 拖把手时宽高各自跟手（复用 smartGroupFreeResizeBox），多图 / 多视频 / 批量结果都走同一条；
   M2 单图 / 单视频 / 宫格拆分仍走原有等比路径（Boss 硬规则、不改其它节点类型）；
   M3 手动尺寸下的网格拟合：任意框 + 极端比例，格子整体落进框里（零越界、零重叠、可复现）；
   M4 网格毛边：拖动过程同步间距（--thumb-gap-x/y），不然松手才对齐。
   跑法：node tests/test_smart_canvas_multi_image_free_resize.js */
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
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

console.log('[1] 静态接线：多图 / 批量结果群组走自由宽高');
ok(/const freeGridResize = isSmartMediaNode\(node\) && !hasGridSplit/.test(js), '多图媒体节点有自己的自由缩放分支');
ok(/mediaItems\.length > 1[\s\S]{0,220}pendingSlotsForNode\(node\) > 1[\s\S]{0,160}batchRowOrder/.test(js), '多图 / 批量进行中 / 批量结果都算网格');
ok(/if\(freeGridResize\)\{[\s\S]*?smartGroupFreeResizeBox\(resizeState\.startW, resizeState\.startH, dx, dy, minW, minH\)/.test(js), '复用分组同一套自由宽高');
ok((js.match(/smartGroupFreeResizeBox\(resizeState\.startW, resizeState\.startH, dx, dy, minW, minH\)/g) || []).length >= 2, '分组与多图共用同一实现');
ok(/hasGridSplit = mediaItems\.some\(item => item\?\.grid\?\.type === 'grid-split'\)/.test(js), '宫格拆分保持原有路径');
ok(/fitManualMediaGridLayout\(count, explicitW, explicitH, cellAspects, PAD\)/.test(js), '手动尺寸网格用 fitManualMediaGridLayout');
ok(!/minThumb = 6/.test(topLevelFunction(js, 'fittedMediaGridLayout')), '旧的手动收缩循环已移除');
ok(/--thumb-gap-x/.test(topLevelFunction(js, 'thumbGridHtml')) && /--thumb-gap-x/.test(topLevelFunction(js, 'batchRowGridHtml')), '两种网格都带间距变量');
ok(/grid\.style\.setProperty\('--thumb-gap-x'/.test(topLevelFunction(js, 'updateNodeElementDuringResize')), '拖动过程同步网格间距');
ok(/column-gap:var\(--thumb-gap-x, 8px\); row-gap:var\(--thumb-gap-y, 8px\)/.test(css), 'CSS 读动态间距');

console.log('[2] 行为：自由宽高（复用分组同一函数）');
const boxSrc = topLevelFunction(js, 'smartGroupFreeResizeBox');
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(boxSrc + '\nglobalThis.__box = smartGroupFreeResizeBox;', sandbox);
const freeBox = (sw, sh, dx, dy) => sandbox.__box(sw, sh, dx, dy, 48, 48);
eq(freeBox(520, 360, 280, 0), {w:800, h:360}, '多图只拉宽：高不变');
eq(freeBox(520, 360, 0, 250), {w:520, h:610}, '多图只拉高：宽不变');
eq(freeBox(520, 360, 180, 120), {w:700, h:480}, '多图对角拖动：两边各自变');
eq(freeBox(520, 360, -2000, 0), {w:48, h:360}, '多图向左拖过头：宽夹最小、高不变');
eq(freeBox(520, 360, 0, -2000), {w:520, h:48}, '多图向上拖过头：高夹最小、宽不变');

console.log('[3] 行为：手动网格在任意框内不越界、不重叠、可复现');
const fitSrc = topLevelFunction(js, 'fitManualMediaGridLayout');
if(!fitSrc) throw new Error('missing fitManualMediaGridLayout');
const fitSandbox = {console};
vm.createContext(fitSandbox);
vm.runInContext(fitSrc + '\nglobalThis.__fit = fitManualMediaGridLayout;', fitSandbox);
const fit = fitSandbox.__fit;
const PAD = 32, GAP = 8;
const SHAPES = [[1600,100],[100,1600],[1200,800],[800,1200],[2000,300],[300,2000]];
function aspectsFor(count){
    return Array.from({length:count}, (_, i) => {
        const s = SHAPES[i % SHAPES.length];
        return Math.min(4, Math.max(0.25, s[0] / s[1]));
    });
}
function geometry(f, aspects){
    const rows = Math.ceil(aspects.length / f.cols);
    const samples = [];
    for(let r = 0; r < rows; r += 1){
        const rowAspects = aspects.slice(r * f.cols, r * f.cols + f.cols);
        const rowH = f.thumb / Math.min(...rowAspects);
        samples.push(rowH);
    }
    const contentH = samples.reduce((a, b) => a + b, 0) + (rows - 1) * f.gapY;
    const gridW = f.cols * f.thumb + (f.cols - 1) * f.gapX;
    return {rows, contentH, gridW};
}
const SIZES = [[520,360],[900,600],[1200,420],[420,900],[1500,240],[760,540],[300,300],[200,700],[700,200],[48,48],[60,600],[600,60]];
let checked = 0;
for(const count of [2,3,4,6,9]){
    const aspects = aspectsFor(count);
    for(const [W,H] of SIZES){
        const f = fit(count, W, H, aspects, PAD, GAP);
        const g = geometry(f, aspects);
        checked += 1;
        ok(g.gridW <= Math.max(1, W - PAD) + 0.02, count + '图 ' + W + 'x' + H + ' 横向不越界（' + g.gridW.toFixed(2) + ' <= ' + (W - PAD) + '）');
        ok(g.contentH <= Math.max(1, H - PAD) + 0.02, count + '图 ' + W + 'x' + H + ' 纵向不越界（' + g.contentH.toFixed(2) + ' <= ' + (H - PAD) + '）');
        ok(f.cols * f.rows >= count, count + '图 ' + W + 'x' + H + ' 格子数够放');
        ok(f.gapX >= 0 && f.gapY >= 0 && f.thumb > 0, count + '图 ' + W + 'x' + H + ' 间距/格子有效');
        const again = fit(count, W, H, aspects, PAD, GAP);
        eq(again, f, count + '图 ' + W + 'x' + H + ' 反复计算一致');
    }
}
ok(checked === SIZES.length * 5, '矩阵覆盖 5 种张数 × ' + SIZES.length + ' 种框');
// 极端框：一列都放不下时允许亚像素，但绝不越界
const tiny = fit(6, 48, 48, aspectsFor(6), PAD, GAP);
ok(tiny.thumb > 0 && tiny.thumb <= 4, '极小框允许缩到极小格子（' + tiny.thumb + 'px）');
const wide = fit(4, 1200, 48, aspectsFor(4), PAD, GAP);
ok(wide.cols === 4 && wide.rows === 1, '极扁框自动排成一行');
const tall = fit(4, 60, 900, aspectsFor(4), PAD, GAP);
ok(tall.cols === 1 && tall.rows === 4, '极窄框自动排成一列');

console.log('');
console.log('多图自由宽高回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
