#!/usr/bin/env node
/* 「系统提示词」弹层 .mini 全局绝对定位回归断言。
   背景：web/src/styles/ds.css 里 `.mini { position: absolute }` 曾是全局规则（本意只服务首页模板卡
   `HomePage.vue` 的 `.tpl-media .mini`），导致 Vue 版 GPT 对话弹层里的「添加 / 另存为 / 删除 / 保存 / 取消」
   被绝对定位后压到「全局 / 本对话」分段控件上。修复（方案 A）把基础规则限定回 `.tpl-media .mini`。
   本测试只锁源码选择器作用域，不验像素布局（布局见 tests/artifacts/syspop-mini-overlap 下的 Playwright 矩阵）。
   跑法：node tests/test_system_prompt_pop_layout.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'web/src/styles/ds.css'), 'utf8');
const pop = fs.readFileSync(path.join(root, 'web/src/pages/chat/SystemPromptPop.vue'), 'utf8');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };

console.log('[1] ds.css 里不再有未限定作用域的 `.mini` 基础规则');
ok(!/^\s*\.mini\s*\{/m.test(css), '没有任何以 .mini 开头的规则块（旧 \'.mini { position: absolute ... }\' 已移除）');
ok(!/^\s*\.mini\.gen\s*\{/m.test(css), '没有任何以 .mini.gen 开头的规则块');
// 兜底：逐块解析选择器，确认不存在「首段就是 .mini」且声明 position:absolute 的规则
const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = [];
for (const m of noComment.matchAll(/([^{}]+)\{([^{}]*)\}/g)) blocks.push({ sel: m[1], decl: m[2] });
const unscoped = blocks.filter(b =>
    b.sel.split(',').some(s => /^\.mini(?![-\w])/.test(s.trim())) && /position\s*:\s*absolute/.test(b.decl));
ok(unscoped.length === 0, '没有「选择器首段为 .mini + position:absolute」的规则（逐块扫描，命中 ' + unscoped.length + ' 条）');

console.log('[2] 首页模板卡需要的 `.tpl-media .mini` 绝对定位仍然保留');
ok(/^\.tpl-media \.mini \{[^}]*position: absolute/m.test(css), '.tpl-media .mini 仍声明 position: absolute');
ok(/^\.tpl-media \.mini \{[^}]*border-radius: 6px/m.test(css), '.tpl-media .mini 仍保留 border-radius: 6px');
ok(/^\.tpl-media \.mini \{[^}]*background: var\(--solid\)/m.test(css), '.tpl-media .mini 仍保留 --solid 底色');
ok(/^\.tpl-media \.mini \{[^}]*box-shadow: var\(--shadow-float\)/m.test(css), '.tpl-media .mini 仍保留 --shadow-float');
ok(/^\.tpl-media \.mini\.gen \{[^}]*background: var\(--fill-2\)/m.test(css), '.tpl-media .mini.gen 仍保留 --fill-2 底色');
ok(/\.tpl-media \.mini \{[^}]*transition: transform 400ms/m.test(css), '后续 .tpl-media .mini 动效规则仍在');

console.log('[3] 弹层内没有用 position:static / !important 做兜底掩盖根因');
ok(!/\.madd \.mini\s*,?[\s\S]{0,40}position:\s*static/.test(pop), '弹层未给 .madd .mini 单独写 position:static 兜底');
ok(!/\.mini[^{}]*\{[^}]*position:\s*(absolute|fixed)/.test(pop), '弹层 scoped .mini 规则不再自行声明绝对/固定定位');
ok(/\.madd \{ display: flex;/.test(pop), '.madd 仍是 flex 容器（添加按钮回到正常文档流后按 flex 排列）');

console.log('');
if (fails.length) {
    fails.forEach(f => console.log('  \u2717 ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
