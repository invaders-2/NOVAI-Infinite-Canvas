#!/usr/bin/env node
/* 「无损改图」内置工具颜色对齐宿主 NOVAI 设计语言的源码级回归断言（自研实现版）。
   权威色值：static/css/marvis-shared.css（浅色 :root / 深色 html.theme-dark）。
   被检页面：static/tools/lossless-edit/index.html（深色 :root + html[data-theme="light"]）。
   规则：9 个颜色 token 在深/浅两套里都与 marvis 逐值一致，不设任何例外。
   跑法：node tests/test_lossless_edit_colors.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const shared = read('static/css/marvis-shared.css');
const page = read('static/tools/lossless-edit/index.html');
const style = (page.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass += 1 : fails.push(m); };
const flat = s => String(s).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
const eq = (a, b, m) => ok(flat(a) === flat(b), m + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a));
const block = (src, re) => (src.match(re) || ['', ''])[1];
const tok = (src, name) => {
    const m = new RegExp('--' + name + '\\s*:\\s*([^;\\n]+);').exec(src);
    return m ? m[1].trim() : '';
};

const TOKENS = [
    ['bg', 'bg'],
    ['surface', 'surface'],
    ['surface-2', 'surface-2'],
    ['text', 'text'],
    ['text-2', 'text-2'],
    ['text-3', 'text-3'],
    ['border', 'border'],
    ['border-2', 'border-2'],
    ['accent', 'accent'],
];

console.log('[1] 权威文件与工具页两个变量块都取得到');
const marvisLight = block(shared, /:root\s*\{([\s\S]*?)\n\}/);
const marvisDark = block(shared, /html\.theme-dark,[\s\S]*?\{([\s\S]*?)\n\}/);
const toolDark = block(page, /:root\s*\{([\s\S]*?)\n\}/);
const toolLight = block(page, /html\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
ok(marvisLight.length > 500 && marvisDark.length > 500, 'marvis-shared.css 浅/深 token 块可解析');
ok(toolDark.length > 100 && toolLight.length > 100, '工具页 :root / html[data-theme="light"] 两个变量块可解析');

console.log('[2] 深色 :root 逐 token 等于 marvis 深色值');
TOKENS.forEach(([tool, marvis]) => eq(tok(toolDark, tool), tok(marvisDark, marvis), '深色 --' + tool + ' = marvis --' + marvis));

console.log('[3] 浅色 html[data-theme="light"] 逐 token 等于 marvis 浅色值（无例外）');
TOKENS.forEach(([tool, marvis]) => eq(tok(toolLight, tool), tok(marvisLight, marvis), '浅色 --' + tool + ' = marvis --' + marvis));

console.log('[4] 页面结构：深色为默认，浅色变量块只有一套');
ok(!/html\.novai-light/.test(page), '不再使用旧 html.novai-light 选择器');
ok((page.match(/html\[data-theme="light"\]\s*\{/g) || []).length === 1, 'html[data-theme="light"] 变量块只出现一次');
ok(/<html lang="zh-CN" data-theme="dark">/.test(page), '默认深色（html data-theme="dark"）');
ok(!/#6b8cff|#3b6ef5|#ededf0/.test(style), 'style 块不含旧调色板字面量');

console.log('[5] token 被实际使用（不是只声明）');
ok(/background:\s*var\(--bg\)/.test(style), '页面底色用 var(--bg)');
ok(/border[^;]*var\(--border\)/.test(style), '边框用 var(--border)');
ok(/var\(--surface-2\)/.test(style), '凹槽/数值框用 var(--surface-2)');
const darkAccent = flat(tok(toolDark, 'accent'));
ok(/button\.primary[\s\S]{0,120}background:\s*var\(--accent\)/.test(style) && darkAccent === '#fafafa', '主按钮 background 用 var(--accent)（深色 #fafafa）');

console.log('');
if (fails.length) {
    fails.forEach(f => console.log('  ✗ ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
