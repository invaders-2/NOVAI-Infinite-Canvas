#!/usr/bin/env node
// 深色主题可读性静态检查（canvas.css）。
//
// 背景：--text / --accent 在深色下都是近白（#fafafa）。一条深色规则里同时写
//   background:var(--text); color:var(--text);
// 就是白底白字 —— 下拉弹层「看不到文字」、生成占位卡变成白块、旋转动效
// 因为底圈和亮段同色而看不出在转，都是这个写法造成的。
// 这个检查只针对静态可判定的一类：单行规则块。运行：node tests/test_dark_mode_canvas.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };

const file = path.join(__dirname, '../static/css/canvas.css');
const css = fs.readFileSync(file, 'utf8');
const label = 'static/css/canvas.css';

const NEAR_WHITE_BG = /background\s*:\s*var\(--(?:text|accent)\)/;
const SAME_TEXT = /color\s*:\s*var\(--(?:text|accent)\)/;

/* 只扫单行规则：选择器 + { 声明 } 同一行（这个文件基本都这么写）。
   多行选择器的最后一行也带 { 并含 theme-dark，同样会被覆盖到。 */
const bad = [];
css.split('\n').forEach((raw, i) => {
    const text = raw.trim();
    if(!text.includes('{') || !text.includes('}')) return;
    const selector = text.slice(0, text.indexOf('{'));
    if(!/theme-dark/.test(selector)) return;
    if(NEAR_WHITE_BG.test(text) && SAME_TEXT.test(text)) bad.push({line: i + 1, text});
});
ok(!bad.length, '深色规则里没有「背景与文字同为近白 token」的写法'
    + (bad.length ? '：' + bad.map(b => label + ':' + b.line + ' ' + b.text.slice(0, 80)).join(' | ') : ''));

// 旋转动效：底圈和亮段必须不同色，否则只是一个静止的圆环
const spinner = /\.theme-dark \.output-spinner[^{]*\{([^}]*)\}/.exec(css);
ok(Boolean(spinner), '找到深色下的 .output-spinner 规则');
if(spinner){
    const top = /border-top-color\s*:\s*([^;]+)/.exec(spinner[1]);
    const ring = /border-color\s*:\s*([^;]+)/.exec(spinner[1]);
    ok(Boolean(top), '.output-spinner 指定 border-top-color（转圈要有对比段）');
    ok(!top || !ring || top[1].trim() !== ring[1].trim(), '底圈与亮段不同色（同色 = 旋转看不见）');
}

// 生成中的占位卡不能是白块
const loading = /\.theme-dark \.output-img-wrap\.loading-wrap[^{]*\{([^}]*)\}/.exec(css);
ok(Boolean(loading), '找到深色下的 .output-img-wrap.loading-wrap 规则');
if(loading) ok(!/background\s*:\s*var\(--text\)/.test(loading[1]), '占位卡背景不能用 var(--text)（深色下是白的）');

// 原生下拉弹层：option 背景必须是深色表面，--accent 在深色下是 #fafafa
const option = /\.theme-dark \.select-lite option\s*\{([^}]*)\}/.exec(css);
ok(Boolean(option), '找到深色下的 .select-lite option 规则');
if(option) ok(!/background\s*:\s*var\(--accent\)/.test(option[1]), 'option 背景不能用 --accent（深色下是白的）');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
