#!/usr/bin/env node
/* 「无损改图」内置工具去阴影（no-shadow）的源码级回归断言。
   被检页面：static/tools/lossless-edit/index.html
   规则：该页不出现任何 box-shadow / text-shadow / drop-shadow，也不再有只服务阴影的 --pop 变量。
   只验阴影相关，颜色/尺寸/圆角/边框/布局不在本测试范围（颜色见 test_lossless_edit_colors.js）。
   跑法：node tests/test_lossless_edit_no_shadow.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'static/tools/lossless-edit/index.html'), 'utf8');
const style = (page.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
const script = (page.match(/<script>([\s\S]*?)<\/script>/) || ['', ''])[1];
const dark = (page.match(/:root\s*\{([\s\S]*?)\n\}/) || ['', ''])[1];
const light = (page.match(/html\.novai-light\s*\{([\s\S]*?)\n\}/) || ['', ''])[1];

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };

console.log('[1] style 块里没有任何阴影声明');
ok(!/box-shadow/i.test(style), 'style 里不再出现 box-shadow');
ok(!/text-shadow/i.test(style), 'style 里不再出现 text-shadow');
ok(!/drop-shadow/i.test(style), 'style 里不再出现 drop-shadow');

console.log('[2] 整页（含内联脚本）没有任何阴影写法');
ok(!/box-shadow/i.test(page), '整页不再出现 box-shadow');
ok(!/text-shadow/i.test(page), '整页不再出现 text-shadow');
ok(!/drop-shadow/i.test(page), '整页不再出现 drop-shadow');
ok(!/boxShadow/.test(page), '内联脚本里不再有 style.boxShadow');

console.log('[3] --pop 阴影变量已彻底移除，无悬空引用');
ok(!/--pop\b/.test(dark), '深色 :root 不再定义 --pop');
ok(!/--pop\b/.test(light), '浅色 html.novai-light 不再定义 --pop');
ok(page.indexOf('var(--pop)') < 0, '不再有任何 var(--pop) 引用');
ok(page.indexOf('--pop') < 0, '整页不再出现 --pop');

console.log('[4] 承担分隔/抬升的阴影已删，但同规则的其它属性保留');
ok(/\.dz:hover,\.dz\.over\{[^}]*transform:translateY\(-2px\)/.test(style), '.dz:hover 保留位移抬升 transform');
ok(/#bar\{[^}]*border-top:1px solid var\(--line\)/.test(style), '#bar 保留顶部边框分隔线');
ok(/#bar\{[^}]*background:linear-gradient\(180deg,#1a1a1a,var\(--panel\)\)/.test(style), '#bar 保留底色渐变');
ok(/\.slot img\{[^}]*border-radius:8px/.test(style), '.slot img 保留圆角/其它属性');

console.log('[5] 只服务阴影的规则已整体删除（不留空规则）');
ok(style.indexOf('.slot.has:hover img{') < 0, '.slot.has:hover img 纯阴影规则已删除');
ok(style.indexOf('input[type=range]:active::-webkit-slider-thumb{') < 0, 'range active 纯阴影规则已删除');
ok(style.indexOf('input[type=range]:focus-visible::-webkit-slider-thumb{') < 0, 'range focus-visible 纯阴影规则已删除');
ok(!/\{\}/.test(style), 'style 里没有留下空规则 {}');

console.log('[6] 内联脚本可解析（确认没碰到 JS 非阴影部分）');
try { new Function(script); ok(true, '内联脚本可解析'); }
catch (e) { ok(false, '内联脚本可解析：' + e.message); }

console.log('[7] 原承担聚焦/悬停/压边指示环的三处已改用 outline 补回（仍无阴影）');
ok(/input\[type=range\]:focus-visible\{outline:2px solid var\(--accent\);outline-offset:2px\}/.test(style),
   '滑块键盘焦点：input[type=range]:focus-visible 用 2px outline 环');
ok(/input\[type=range\]:focus-visible\{[^}]*outline:(?!none)/.test(style),
   'input[type=range] 聚焦规则含 :focus-visible 且 outline 非 none');
ok(/\.slot\.has:hover img,\.slot\.has:focus-visible img\{outline:2px solid var\(--accent\);outline-offset:-2px\}/.test(style),
   '已填素材槽悬停/聚焦：图片用 2px outline 内压环');
ok(/\.slot img\{[^}]*outline:1px solid var\(--line-2\);outline-offset:-1px/.test(style),
   '素材缩略图压边：.slot img 用 1px outline 细环');
ok(style.indexOf('input[type=range]:focus-visible{outline:none}') < 0, '滑块聚焦不再被 outline:none 抹掉反馈');

console.log('');
if (fails.length) {
    fails.forEach(f => console.log('  \u2717 ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
