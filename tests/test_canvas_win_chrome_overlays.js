#!/usr/bin/env node
/* 图片大图 / 右上浮层与 Windows 三键的静态回归（纯 node，不启动浏览器）：
   C1. StudioLightbox 不再有右上关闭按钮（.studio-lb-close 源码 / 构建产物都不要）；
   C2. 大图改为「点空白关闭」：ImageStudio 的 closeOnBlank 排除图片 / 视频 / 信息栏 / 按钮；
   C3. .md-lb-x、.lightbox .close 的 --cn-chrome-right 让位保留；
   C4. CanvasApp 把 --cn-chrome-right 也写到 <html>（body 直挂的 .md-lb-x 才继承得到）；
   C5. 构建产物已同步 + static/canvas.html 用 ?v= 引 canvas.css / canvas.js。
  跑法：node tests/test_canvas_win_chrome_overlays.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { checkStaticCacheVersions } = require('./static-cache-version');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] 大图不再有关闭按钮');
const studioTsx = read('novai-canvas-ui/src/canvas/canvas-next/agent/ImageStudio.tsx');
const studioCss = read('novai-canvas-ui/src/canvas/canvas-next/agent/image-studio.css');
ok(!studioTsx.includes('studio-lb-close'), 'ImageStudio.tsx 不再渲染 .studio-lb-close');
ok(!studioCss.includes('studio-lb-close'), 'image-studio.css 里没有 .studio-lb-close 残留（含上一轮的三键让位）');
ok(/className="studio-lb-stage"/.test(studioTsx), '舞台空处保留');
ok(/aria-label="上一张"/.test(studioTsx) && /aria-label="下一张"/.test(studioTsx), '左右切换按钮保留');

console.log('[2] 点空白关闭，点图 / 信息栏 / 按钮不关闭');
ok(/const closeOnBlank = \(event: MouseEvent<HTMLDivElement>\)/.test(studioTsx), '有 closeOnBlank 处理函数');
ok(/closest\("img, video, canvas, a, button, \.studio-lb-bar"\)/.test(studioTsx), '排除图片 / 视频 / 链接 / 按钮 / 信息栏');
ok(/onClick=\{closeOnBlank\}/.test(studioTsx), '大图遮罩根节点挂 closeOnBlank');
ok(/event\.key === "Escape"/.test(studioTsx), 'Esc 仍然关闭');
ok(/Esc 或点空白处关闭/.test(studioTsx), '提示文案改成点空白处关闭');

console.log('[3] 其它查看器的三键让位保留');
const next = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
ok(/\.cn-root\.has-win-controls \.lightbox \.close\s*\{[^}]*--cn-chrome-right/.test(next), '.lightbox .close 在 has-win-controls 下内缩');
ok(/\.md-lb-x\{[^}]*right:calc\(18px \+ var\(--cn-chrome-right,0px\)\)/.test(next), '.md-lb-x 用 calc(18px + --cn-chrome-right)');

console.log('[4] 变量下发：<html> 也要写');
const app = read('novai-canvas-ui/src/canvas/canvas-next/CanvasApp.tsx');
ok(/document\.documentElement\.style\.setProperty\("--cn-chrome-right"/.test(app), '<html> 上也写 --cn-chrome-right');
ok(/classList\.toggle\("has-win-controls", Number\(d\.right\) > 0\)/.test(app), 'right>0 才挂 has-win-controls（mac/浏览器不挂）');

console.log('[5] 构建产物 / 缓存串');
const built = read('static/novai-canvas/canvas.css');
const builtJs = read('static/novai-canvas/canvas.js');
ok(!built.includes('studio-lb-close'), 'canvas.css 里没有 .studio-lb-close');
ok(!builtJs.includes('studio-lb-close'), 'canvas.js 里没有关闭按钮');
ok(/has-win-controls \.lightbox \.close\{right:calc\(20px \+ var\(--cn-chrome-right,0px\)\)\}/.test(built), 'canvas.css 保留 .lightbox .close 让位');
ok(/\.md-lb-x\{[^}]*right:calc\(18px \+ var\(--cn-chrome-right,0px\)\)/.test(built), 'canvas.css 保留 .md-lb-x 让位');
ok(/img, video, canvas, a, button, \.studio-lb-bar/.test(builtJs), 'canvas.js 里有 closeOnBlank 的排除选择器');
const html = read('static/canvas.html');
const cache = checkStaticCacheVersions({ root, page: 'static/canvas.html' });
ok(cache.ok, 'canvas.html 的 ?v= 满足：VERSION 前缀 / 10 位 mtime / 无裸链接 / 多处一致' + (cache.problems.length ? '：' + cache.problems.join('；') : ''));
ok(cache.refs.has('/static/novai-canvas/canvas.css'), 'canvas.css 带 ?v=（' + (cache.refs.get('/static/novai-canvas/canvas.css') || '无') + '）');
ok(cache.refs.has('/static/novai-canvas/canvas.js'), 'canvas.js 带 ?v=（' + (cache.refs.get('/static/novai-canvas/canvas.js') || '无') + '）');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
