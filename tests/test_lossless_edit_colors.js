#!/usr/bin/env node
/* 「无损改图」内置工具颜色对齐宿主 NOVAI 设计语言的源码级回归断言。
   权威色值：static/css/marvis-shared.css（浅色 :root / 深色 html.theme-dark）。
   被检页面：static/tools/lossless-edit/index.html（深色 :root + html.novai-light）。
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
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const flat = s => String(s).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
const eq = (a, b, m) => ok(a === b, m + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a));
const eqT = (a, b, m) => eq(flat(a), flat(b), m);

const block = (src, re) => (src.match(re) || ['', ''])[1];
const marvisLight = block(shared, /:root\s*\{([\s\S]*?)\n\}/);
const marvisDark = block(shared, /html\.theme-dark,[\s\S]*?\{([\s\S]*?)\n\}/);
const toolDark = block(page, /:root\s*\{([\s\S]*?)\n\}/);
const toolLight = block(page, /html\.novai-light\s*\{([\s\S]*?)\n\}/);
const tok = (src, name) => { const m = new RegExp('--' + name + '\\s*:\\s*([^;\\n]+);').exec(src); return m ? m[1].trim() : ''; };
const toolVar = name => tok(toolDark, name);
const toolLit = name => tok(toolLight, name);

console.log('[1] 权威文件与两个变量块都取得到');
ok(marvisLight.length > 500 && marvisDark.length > 500, 'marvis-shared.css 浅/深 token 块可解析');
ok(toolDark.length > 100 && toolLight.length > 100, '工具页 :root / html.novai-light 两个变量块可解析');
eqT(tok(marvisLight, 'accent'), '#171717', 'marvis 浅色 --accent');
eqT(tok(marvisDark, 'accent'), '#fafafa', 'marvis 深色 --accent（中性近白）');

console.log('[2] 深色 :root 逐 token 等于 marvis 深色值');
const map = [
  ['bg','bg'], ['stage','stage-bg'], ['panel','surface'], ['raise','surface-2'], ['raise-2','elevated'],
  ['line','border'], ['line-2','border-2'], ['text','text'], ['muted','text-2'], ['faint','text-3'],
  ['accent','accent'], ['accent-soft','accent-subtle'], ['danger','danger'], ['ok','success'], ['warn','warning'],
];
map.forEach(([tool, m]) => eqT(toolVar(tool), tok(marvisDark, m), '深色 --' + tool + ' = marvis --' + m));
// 阴影清理（no-shadow）：--pop 已整体删除，深色/浅色两处都不再有定义
ok(toolVar('pop') === '' && toolLit('pop') === '', '--pop 阴影变量已删除（深色/浅色均无定义）');
ok(toolVar('accent') !== '#6b8cff', '深色 --accent 不再是蓝色 #6b8cff');

console.log('[3] 浅色 html.novai-light 逐 token 等于 marvis 浅色值');
map.forEach(([tool, m]) => eqT(toolLit(tool), tok(marvisLight, m), '浅色 --' + tool + ' = marvis --' + m));
eqT(toolLit('accent'), '#171717', '浅色 --accent = #171717（中性）');

console.log('[4] style 块里没有遗留的旧调色板字面量');
['#6b8cff','107,140,255','#3b6ef5','#ededf0','#d6dfff','#151518','#0e0e11','#0c0c0e','#131316','#1b1b20','#23232a','#8c8c96','#5b5b64','#3ccf8e','#ff5c6c','#f5b342','#dcdce0','#f3f3f5','#ffe4e6','#248a3d','#f0f0f0']  // #c8102e 是刻意保留的功能色（蒙版红），不在此列
    .forEach(bad => ok(style.indexOf(bad) < 0, 'style 里不再出现 ' + bad));

console.log('[5] button.on：accent-subtle / accent / text-on-accent 角色');
ok(/button\.on\{background:var\(--accent-soft\);border-color:var\(--accent\);color:#0a0a0a\}/.test(style),
   'button.on 底色 --accent-soft、描边 --accent、文字用 text-on-accent 深色值 #0a0a0a');

console.log('[6] 主按钮系列按 accent / accent-hover / accent-pressed / accent-text');
ok(/button\.primary\{background:#fafafa;border-color:#fafafa;color:#0a0a0a;/.test(style), '深色主按钮 = accent #fafafa + accent-text #0a0a0a');
ok(/button\.primary:hover\{background:#ffffff;border-color:#ffffff\}/.test(style), '深色主按钮 hover = accent-hover #ffffff');
ok(/button\.primary:active\{background:#d4d4d4\}/.test(style), '深色主按钮 active = accent-pressed #d4d4d4');
ok(/html\.novai-light button\.primary\{background:#171717;border-color:#171717;color:#fafafa[;}]/.test(style), '浅色主按钮 = accent #171717 + accent-text #fafafa');
ok(/html\.novai-light button\.primary:hover\{background:#2b2b2b;border-color:#2b2b2b\}/.test(style), '浅色主按钮 hover = accent-hover #2b2b2b');
ok(/html\.novai-light button\.primary:active\{background:#0a0a0a\}/.test(style), '浅色主按钮 active = accent-pressed #0a0a0a');

console.log('[7] 拖放区渐变/悬停改用中性 token');
ok(/\.dz\{[^}]*linear-gradient\(180deg,rgba\(250,250,250,0\.12\),rgba\(255,255,255,0\.06\)\)/.test(style),
   '.dz 底色为 accent-subtle / nav-hover-bg 中性叠加');
ok(/\.dz:hover,\.dz\.over\{border-color:var\(--accent\);background:linear-gradient\(180deg,var\(--accent-soft\),var\(--accent-soft\)\)/.test(style),
   '.dz 悬停描边 --accent、底色为同一中性叠加 --accent-soft');
ok(/\.dz:hover em,\.dz\.over em\{[^}]*color:#0a0a0a\}/.test(style), '深色高亮胶囊文字用 text-on-accent 值');
ok(/html\.novai-light \.dz:hover em,html\.novai-light \.dz\.over em\{color:#fafafa\}/.test(style),
   '浅色补一条等价覆盖（浅色下不在 accent 底上白字）');

console.log('[8] #bar 渐变保留 / 投影已移除');
ok(/linear-gradient\(180deg,#1a1a1a,var\(--panel\)\)/.test(style), '#bar 顶部 = elevated #1a1a1a、底部 = --panel');
ok(!/#bar\{[^}]*box-shadow/.test(style), '#bar 投影已移除');
ok(/html\.novai-light #bar\{background:linear-gradient\(180deg,#ffffff,var\(--panel\)\)/.test(style), '浅色 #bar 顶部仍是 surface 白');

console.log('[9] 浮层底色映射到 elevated / scrim / surface');
['#hint','#toast','#chip','#adv'].forEach(id => {
    const re = new RegExp('\\' + id + '\\{[^}]*background:#1a1a1a;');
    ok(re.test(style), id + ' 底色 = elevated #1a1a1a');
});
ok(/#busy\{[^}]*background:rgba\(0,0,0,0\.62\)/.test(style), '#busy 遮罩 = scrim rgba(0,0,0,0.62)');
ok(/\.readout\{[^}]*background:#0f0f0f/.test(style) && /\.seg\{[^}]*background:#0f0f0f/.test(style), '控件凹槽底 = surface #0f0f0f');

console.log('[10] logo SVG 跟随主题（只改颜色属性）');
const svg = (page.match(/<svg viewBox="0 0 34 34"[\s\S]*?<\/svg>/) || [''])[0];
ok(svg.length > 0, '取到 logo SVG');
ok(/stroke="currentColor"/.test(svg) && /fill="currentColor"/.test(svg), 'SVG 描边/填充改用 currentColor');
ok(/stroke="#8a8a8a"/.test(svg), '底部横线 = text-3 #8a8a8a');
ok(!/stroke="#ededf0"|fill="#6b8cff"|stroke="#5b5b64"/.test(svg), 'SVG 不再有旧深色字面量');
eq((svg.match(/width="24" height="16"/g) || []).length, 1, 'SVG 结构/尺寸未改（24x16 矩形仍为 1 个）');

console.log('[11] 内联脚本可解析（确认没碰到 JS）');
try { new Function((page.match(/<script>([\s\S]*?)<\/script>/) || ['', ''])[1]); ok(true, '内联脚本可解析'); }
catch (e) { ok(false, '内联脚本可解析：' + e.message); }

console.log('');
if (fails.length) {
    fails.forEach(f => console.log('  ✗ ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
