#!/usr/bin/env node
/* 收起态「设置」齿轮与 logo / 导航图标同列的源码级回归断言。

   背景：.side-pill 是 <button>，UA 默认 padding-right 6px；收起态里 .side-pill-text 虽被压成
   width:0，仍作为 flex item 占 gap:8px。justify-content:center 在内容盒里居中，两点叠加把齿轮
   svg 推左（1440x900 实测齿轮中心 42.11 vs logo/nav 48.81，差 6.7px）。
   修法：只在收起态选择器 .sidebar:not(:hover):not(.is-pinned) .side-pill 里把左右内边距与 gap
   归零；base padding 与展开/固定态（padding-left:14px + gap:8px）一字不动。

   跑法：node tests/test_shell_sidebar_gear_align.js */

'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const sidebar = read('web/src/shell/Sidebar.vue');
const scoped = (sidebar.match(/<style scoped>([\s\S]*?)<\/style>/) || ['', ''])[1];
const basePill = (scoped.match(/(?:^|\n)\.side-pill\s*\{([^}]*)\}/) || [])[1] || '';
const collapsed = (scoped.match(/\.sidebar:not\(:hover\):not\(\.is-pinned\)\s+\.side-pill\s*\{([^}]*)\}/) || [])[1] || '';
const hoverPill = (scoped.match(/\.sidebar:hover\s+\.side-pill\s*\{([^}]*)\}/) || [])[1] || '';
const pinnedPill = (scoped.match(/\.sidebar\.is-pinned\s+\.side-pill\s*\{([^}]*)\}/) || [])[1] || '';

console.log('[1] 收起态覆盖：横向内边距与 gap 归零（齿轮居中）');
ok(!!collapsed, '找到 .sidebar:not(:hover):not(.is-pinned) .side-pill 规则');
ok(/padding-left\s*:\s*0/.test(collapsed), '收起态 padding-left: 0');
ok(/padding-right\s*:\s*0/.test(collapsed), '收起态 padding-right: 0（压掉 UA 按钮默认右内边距）');
ok(/gap\s*:\s*0/.test(collapsed), '收起态 gap: 0（隐藏文字不再占位推左）');

console.log('[2] base 与展开 / 固定态保持原样');
ok(/padding-left\s*:\s*0/.test(basePill), 'base .side-pill 仍是 padding-left: 0');
ok(!/padding-right/.test(basePill), 'base .side-pill 未新增 padding-right（只加收起态覆盖）');
ok(/padding-left\s*:\s*14px/.test(hoverPill) && /gap\s*:\s*8px/.test(hoverPill), 'hover 展开态仍是 padding-left:14px + gap:8px');
ok(/padding-left\s*:\s*14px/.test(pinnedPill) && /gap\s*:\s*8px/.test(pinnedPill), '固定态仍是 padding-left:14px + gap:8px');
ok(!/side-pill[^{]*\{[^}]*!important/.test(scoped), '侧栏样式块没有用 !important');

console.log('[3] 构建产物（static/v2）带上该规则，展开态规则未变');
const indexHtml = read('static/v2/index.html');
const cssHref = (indexHtml.match(/href="(\/static\/v2\/assets\/[^"]+\.css)"/) || [])[1];
ok(!!cssHref, 'static/v2/index.html 引用了构建 CSS');
if (cssHref) {
    const css = read(cssHref.replace(/^\//, ''));
    ok(/\.sidebar:not\(:hover\):not\(\.is-pinned\) \.side-pill\[[^\]]+\]\{padding-left:0;padding-right:0;gap:0\}/.test(css),
        '构建 CSS 含收起态归零规则');
    ok(/\.sidebar:hover \.side-pill\[[^\]]+\]\{[^}]*padding-left:14px/.test(css) && /\.sidebar\.is-pinned \.side-pill\[[^\]]+\]\{[^}]*padding-left:14px/.test(css),
        '构建 CSS 的 hover / 固定展开态仍 padding-left:14px');
}

console.log('');
if (fails.length) {
    fails.forEach(f => console.log('  \u2717 ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
