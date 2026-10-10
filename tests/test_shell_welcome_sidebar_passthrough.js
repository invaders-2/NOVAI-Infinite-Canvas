#!/usr/bin/env node
/* 新外壳欢迎层不再拦截左侧导航的源码级回归断言。

   背景：首次访问时 Welcome.vue 的 .wel 是 position:fixed;inset:0;z-index:2600 的不透明整屏层，
   层级高于 .sidebar（z-index:50），鼠标全被它命中 —— document.elementFromPoint(侧栏中心) 返回 DIV.wel，
   侧栏 matches(':hover') 恒 false，悬停展不开。
   修法：只让欢迎层根元素退出鼠标命中（.wel { pointer-events:none }），把命中交回内容子元素
   （.wel-in { pointer-events:auto }），视觉与布局一律不动；不给侧栏加 z-index/!important 抬层。

   追加（Boss 口径：欢迎页上不要侧栏）：仅退出命中还不够 —— 侧栏不可见却仍能被盲点、盲 Tab。
   现在 Welcome.vue 在 mode==='welcome' 时给 .sidebar 加 inert（关闭时移除）：inert 同时挡住指针
   命中与焦点，侧栏彻底不可交互；关闭欢迎页后一切照旧。侧栏样式零改动，不加 !important。

   跑法：node tests/test_shell_welcome_sidebar_passthrough.js */

'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

const welcome = read('web/src/shell/Welcome.vue');
const sidebar = read('web/src/shell/Sidebar.vue');
const store = read('web/src/lib/store.js');
const scoped = (welcome.match(/<style scoped>([\s\S]*?)<\/style>/) || ['', ''])[1];
const wel = (scoped.match(/\.wel\s*\{([^}]*)\}/) || [])[1] || '';
const welIn = (scoped.match(/\.wel-in\s*\{([^}]*)\}/) || [])[1] || '';
const scrim = (scoped.match(/\.scrim\s*\{([^}]*)\}/) || [])[1] || '';

console.log('[1] .wel 根层退出鼠标命中，但视觉/层级参数保持原样');
ok(!!wel, '找到 .wel 规则');
ok(/pointer-events\s*:\s*none/.test(wel), '.wel 设了 pointer-events: none');
ok(/position\s*:\s*fixed/.test(wel), '.wel 仍是 position: fixed');
ok(/inset\s*:\s*0/.test(wel), '.wel 仍是 inset: 0');
ok(/z-index\s*:\s*2600/.test(wel), '.wel 仍是 z-index: 2600');
ok(/background\s*:\s*var\(--bg\)/.test(wel), '.wel 背景仍是 var(--bg)');

console.log('[2] 命中交回内容子元素');
ok(!!welIn, '找到 .wel-in 规则');
ok(/pointer-events\s*:\s*auto/.test(welIn), '.wel-in 恢复了 pointer-events: auto');
ok(!!scrim, '找到 .scrim 规则');
ok(!/pointer-events\s*:\s*none/.test(scrim), '「快速上手」弹层 scrim 仍拦截鼠标（不误伤）');

console.log('[3] 不用 !important / 不给侧栏抬层掩盖');
ok(scoped.indexOf('!important') < 0, 'Welcome 样式块没有 !important');
ok(!/z-index[^;]*!important/.test(sidebar), 'Sidebar 没有给 z-index 加 !important');
ok(/\.sidebar\s*\{[^}]*z-index\s*:\s*50/.test(sidebar), '.sidebar 的 z-index: 50 未改动');

console.log('[4] 侧栏行为契约保持：收起 72 / hover 220 / 固定 220 / Logo 切换');
ok(/\.sidebar:hover\s*\{[^}]*width\s*:\s*220px/.test(sidebar), '.sidebar:hover 仍展开到 220px');
ok(/\.sidebar\s*\{[^}]*width\s*:\s*72px/.test(sidebar), '.sidebar 收起仍是 72px');
ok(/\.sidebar\.is-pinned\s*\{[^}]*width\s*:\s*220px/.test(sidebar), '.sidebar.is-pinned 仍是 220px');
ok(/:aria-pressed="state\.pinned"/.test(sidebar), 'Logo 仍绑定 aria-pressed="state.pinned"');
ok(/@click="togglePin"/.test(sidebar) && /setPinned\(next\)/.test(sidebar), 'Logo 仍通过 setPinned 切换固定');
ok(/PINNED_KEY\s*=\s*'studio_sidebar_pinned'/.test(store), '固定态仍写 studio_sidebar_pinned');

console.log('[5] 构建产物（Boss 服务器直接吃 static/v2）也带上修复');
const indexHtml = read('static/v2/index.html');
const cssHref = (indexHtml.match(/href="(\/static\/v2\/assets\/[^"]+\.css)"/) || [])[1];
const jsSrc = (indexHtml.match(/src="(\/static\/v2\/assets\/[^"]+\.js)"/) || [])[1];
ok(!!cssHref, 'static/v2/index.html 引用了构建 CSS');
ok(!!jsSrc, 'static/v2/index.html 引用了构建 JS');
if (cssHref) {
    const css = read(cssHref.replace(/^\//, ''));
    const welRules = css.match(/\.wel\[[^\]]+\]\{[^}]*\}/g) || [];
    const welInRules = css.match(/\.wel-in\[[^\]]+\]\{[^}]*\}/g) || [];
    const builtWel = welRules.find(r => /pointer-events:none/.test(r)) || '';
    const builtWelIn = welInRules.find(r => /pointer-events:auto/.test(r)) || '';
    ok(!!builtWel, '构建 CSS 里存在 .wel 规则且含 pointer-events:none');
    ok(!!builtWelIn, '构建 CSS 里存在 .wel-in 规则且含 pointer-events:auto');
    ok(/position:fixed/.test(builtWel) && /z-index:2600/.test(builtWel), '构建 CSS 的 .wel 保持 fixed / z-index:2600');
}
if (jsSrc) ok(fs.existsSync(path.join(root, jsSrc.replace(/^\//, ''))), '构建 JS 文件存在');

console.log('[6] 欢迎页期间侧栏 inert：彻底不可交互，关闭后移除');
ok(/setAttribute\('inert'/.test(welcome), 'Welcome 在欢迎页期间给侧栏设 inert');
ok(/removeAttribute\('inert'/.test(welcome), 'Welcome 关闭欢迎页时移除侧栏 inert');
ok(/props\.mode === 'welcome'/.test(welcome), 'inert 只在 welcome 模式生效（quickstart 不误伤）');
ok(/watch\(\(\) => props\.mode/.test(welcome), 'mode 变化时同步 inert');
ok(/onBeforeUnmount\(\(\) => document\.querySelector\('\.sidebar'\)\?\.removeAttribute\('inert'\)\)/.test(welcome), '组件卸载兜底移除 inert');
ok(/class="sidebar"/.test(sidebar), '侧栏仍是 <aside class="sidebar">（Welcome 定位得到）');
ok(!/inert[^;]*!important/.test(sidebar) && !/\binert\b/.test(sidebar), '侧栏组件自身不加 inert/!important，状态只在 Welcome 管');
if (jsSrc) {
    const builtJs = read(jsSrc.replace(/^\//, ''));
    ok(/setAttribute\("inert",""\)|setAttribute\('inert'/.test(builtJs), '构建 JS 里带上给侧栏设 inert 的代码');
}

console.log('');
if (fails.length) {
    fails.forEach(f => console.log('  \u2717 ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
