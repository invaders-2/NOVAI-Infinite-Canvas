#!/usr/bin/env node
/* 画布外壳安全区回归（mac 顶栏上边距对齐 TapNow）：
   I1. bridge.js canvasChromeInsets：mac {left:84,right:0,top:12}、windows {0,112,16}、普通浏览器 {0,0,16}；
   I2. 只有 mac 改了 top（Windows 16 不动），注释同步说明 TapNow 对照；
   I3. 构建产物 static/v2 里能 grep 到 mac 的 top:12（改了源码没 build 会挡住）。
   跑法：node tests/test_canvas_chrome_insets.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bridge = read('web/src/lib/bridge.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[I1] canvasChromeInsets 三套值');
ok(/if \(state\.desktop === 'windows'\) return \{ left: 0, right: 112, top: 16 \};/.test(bridge), 'windows：right 112 / top 16（未变）');
ok(/if \(state\.desktop === 'mac'\) return \{ left: 84, right: 0, top: 12 \};/.test(bridge), 'mac：left 84 / top 12（TapNow 对齐）');
ok(/return \{ left: 0, right: 0, top: 16 \};/.test(bridge), '普通浏览器：0/0/16（未变）');
ok(!/left: 84, right: 0, top: 6 \}/.test(bridge), 'mac 旧 top:6 已不存在');
ok(/TapNow/.test(bridge) && /中心 32/.test(bridge), '注释写明 TapNow 对照（距顶约 12 / 中心 32）');

console.log('[I2] 构建产物已同步');
const assetsDir = path.join(root, 'static/v2/assets');
const jsFiles = fs.readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name));
const bundles = jsFiles.map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8'));
ok(jsFiles.length > 0, 'static/v2 有入口 JS（' + jsFiles.join(', ') + '）');
ok(bundles.some((src) => /left:84,right:0,top:12/.test(src)), '构建产物包含 mac {left:84,right:0,top:12}');
ok(bundles.every((src) => !/left:84,right:0,top:6\b/.test(src)), '构建产物没有旧 mac top:6');

console.log('[I3] 画布侧按变量落位');
const canvasCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
ok(/#tl\{left:max\(16px,var\(--cn-chrome-left,0px\)\);top:calc\(var\(--cn-chrome-top,16px\)/.test(canvasCss), '#tl 用 --cn-chrome-top 定位');
ok(/#tr\{right:max\(16px,calc\(16px \+ var\(--cn-chrome-right,0px\)\)\);top:calc\(var\(--cn-chrome-top,16px\)/.test(canvasCss), '#tr 用 --cn-chrome-top 定位');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
