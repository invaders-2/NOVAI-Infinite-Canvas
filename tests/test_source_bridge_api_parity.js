#!/usr/bin/env node
/* 桌面桥方法一致性回归：
   前端调用的 window.pywebview.api.X / <api 别名>.X 必须真的存在于
   desktop/preload.js 的 api 表或 desktop/main.js 注入 iframe 的 IFRAME_SHIM 里，
   否则 typeof 特性检测恒 false，整条功能通道静默失效。
   Pinterest 拖图不出节点就是这类：画布调用 guest_drag_bytes，桥上的真名是 get_guest_drag_bytes。
   跑法：node tests/test_source_bridge_api_parity.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walkJs(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkJs(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/* 桥上的全部方法名：主 frame 的 preload 表 + 注入 iframe 的 shim 表 */
function collectBridgeMethods() {
    const methods = new Set();
    const preload = fs.readFileSync(path.join(root, 'desktop/preload.js'), 'utf8');
    const apiStart = preload.indexOf('const api = {');
    ok(apiStart >= 0, 'preload.js 里能找到 const api = {');
    const apiEnd = apiStart >= 0 ? preload.indexOf('\n};', apiStart) : -1;
    ok(apiEnd > apiStart, 'preload.js 的 api 表能界定范围');
    if (apiStart >= 0 && apiEnd > apiStart) {
        const block = preload.slice(apiStart, apiEnd);
        for (const m of block.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[:(]/gm)) methods.add(m[1]);
    }
    const desktopMain = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');
    const shimStart = desktopMain.indexOf('const IFRAME_SHIM = `');
    const shimEnd = shimStart >= 0 ? desktopMain.indexOf('`;', shimStart) : -1;
    ok(shimStart >= 0 && shimEnd > shimStart, 'main.js 里能找到 IFRAME_SHIM');
    const shim = shimStart >= 0 && shimEnd > shimStart ? desktopMain.slice(shimStart, shimEnd) : '';
    const pyStart = shim.indexOf('window.pywebview = {');
    const pyEnd = pyStart >= 0 ? shim.indexOf('\n  };', pyStart) : -1;
    ok(pyStart >= 0 && pyEnd > pyStart, 'IFRAME_SHIM 里能找到 window.pywebview 表');
    if (pyStart >= 0 && pyEnd > pyStart) {
        const block = shim.slice(pyStart, pyEnd);
        for (const m of block.matchAll(/^ {6}([A-Za-z_$][\w$]*)\s*:\s*function/gm)) methods.add(m[1]);
    }
    return methods;
}

/* 文件里哪些标识符装的是 pywebview api：直接赋值、返回桥的 getter（rawApi），以及 getter 的结果（const api = rawApi()） */
function bridgeAliases(src) {
    const names = new Set();
    const getters = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*pywebview[^;\n]*\.api\b/g)) names.add(m[1]);
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^}]{0,400}?return\b[^;]{0,200}pywebview[^;]{0,80}\.api\b/g)) getters.add(m[1]);
    // 只认"返回桥的 getter"的结果（const api = rawApi()）；别的 xxx() 可能是任何局部对象
    if (getters.size) {
        const getterCall = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(*\\s*(?:' + [...getters].map(escapeRe).join('|') + ')\\s*\\(', 'g');
        for (const m of src.matchAll(getterCall)) names.add(m[1]);
    }
    getters.forEach(name => names.add(name));
    return names;
}

function lineOf(src, index) {
    return src.slice(0, index).split('\n').length;
}

/* 抽出所有"疑似桥调用"：window.pywebview.api.X 与 <别名>.X */
function bridgeUsages(src) {
    const hits = [];
    const push = (m, alias, method) => hits.push({ alias, method, line: lineOf(src, m.index) });
    for (const m of src.matchAll(/window\.pywebview\s*(?:\?\.|\.)\s*api\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)) {
        push(m, 'window.pywebview.api', m[1]);
    }
    const aliases = [...bridgeAliases(src)];
    if (!aliases.length) return hits;
    const aliasRe = new RegExp('(?:^|[^.\\w$])(' + aliases.map(escapeRe).join('|') + ')\\.([A-Za-z_$][\\w$]*)', 'g');
    for (const m of src.matchAll(aliasRe)) push(m, m[1], m[2]);
    return hits;
}

/* 已知误报：这些名字不是"桌面桥方法"，逐个注明原因；出现死条目（代码里已经没有了）会报错提醒删掉。
   注意：guest_* / get_guest_* 绝不允许进白名单——它们正是本事故要守住的桥方法。 */
const WHITELIST = new Map([
    ['static/js/smart-canvas.js::api.PILL_CLASS', 'window.NovaGlide 滑块组件的样式类名，不是桥'],
    ['static/js/smart-canvas.js::api.attach', 'window.NovaGlide.attach：给弹层接线滑块，不是桥'],
    ['static/js/smart-canvas.js::api.workMs', 'window.NovaiAgentSession.workMs：会话计时，不是桥'],
    ['static/js/smart-canvas.js::api.applyEvent', 'window.NovaiAgentSession.applyEvent：思考流状态机，不是桥'],
    ['static/js/smart-canvas.js::api.mergeThinking', 'window.NovaiAgentSession.mergeThinking：同上，不是桥'],
    ['static/js/smart-canvas.js::api.isTerminal', 'window.NovaiAgentSession.isTerminal：会话状态判断，不是桥'],
    ['static/js/smart-canvas.js::api.isWaiting', 'window.NovaiAgentSession.isWaiting：会话状态判断，不是桥'],
    ['static/js/smart-canvas.js::api.map', '「我的 API 平台」下拉渲染里的局部数组 helper，不是桥'],
    ['static/js/smart-canvas.js::api.generatorUpstreamTables', '表格批处理模块（ensureTableApi）的方法，不是桥'],
    ['static/js/smart-canvas.js::api.llmMediaGroups', '表格/媒体分组渲染 helper，不是桥'],
    ['static/js/smart-canvas.js::api.materializeLlmTable', '表格批处理模块的方法，不是桥'],
    ['static/js/smart-canvas.js::api.paintTableBatchPanel', '表格批处理模块的面板重绘，不是桥'],
    ['static/js/smart-canvas.js::api.renderTableBatchPanel', '表格批处理模块的面板渲染，不是桥'],
    ['static/js/smart-canvas.js::api.renderTableBody', '表格批处理模块的表格渲染，不是桥'],
    ['static/js/smart-canvas.js::api.runTableBatch', '表格批处理模块的开跑入口，不是桥'],
    ['static/js/source-browser.js::api.source_nav', '旧桥名的兼容探测（typeof 守卫），现桥只有 source_go_back/forward'],
    ['static/js/source-browser.js::api.set_source_nav', '旧桥名的兼容探测（typeof 守卫），现桥只有 source_go_back/forward'],
    ['static/js/canvas-rail.js::api.navigate', '外壳路由桥：preload 未实现，调用前有 typeof 守卫，postMessage 是兜底'],
]);

function scanRepo() {
    const methods = collectBridgeMethods();
    const usedKeys = new Set();
    const missing = [];
    const files = walkJs(path.join(root, 'static/js')).sort();
    for (const file of files) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        const src = fs.readFileSync(file, 'utf8');
        for (const usage of bridgeUsages(src)) {
            if (methods.has(usage.method)) continue;
            const key = rel + '::' + usage.alias + '.' + usage.method;
            if (WHITELIST.has(key)) { usedKeys.add(key); continue; }
            missing.push(key + ' (line ' + usage.line + ')');
        }
    }
    return { methods, missing, usedKeys };
}

console.log('[1] 桥表解析');
const bridgeMethods = collectBridgeMethods();
ok(bridgeMethods.size > 30, '桥方法表解析到足够多的方法（实际 ' + bridgeMethods.size + ' 个）');
['get_guest_drag_bytes', 'get_guest_drag_original', 'get_last_guest_drag', 'get_source_view_fetch_bytes', 'fetch_source_url']
    .forEach(name => ok(bridgeMethods.has(name), '桥表包含 ' + name));
ok(!bridgeMethods.has('guest_drag_bytes'), '桥表里没有旧名 guest_drag_bytes（真名带 get_ 前缀）');

console.log('[2] 扫描器确实能抓住本次这类拼错');
const badSample = 'async function drop(){ const prefetchApi = window.pywebview && window.pywebview.api; return prefetchApi.guest_drag_bytes(); }';
const badUsages = bridgeUsages(badSample).filter(usage => !bridgeMethods.has(usage.method));
ok(badUsages.some(usage => usage.method === 'guest_drag_bytes'), '别名对象上调 guest_drag_bytes 会被判为缺失');
const goodSample = 'async function drop(){ const api = window.pywebview && window.pywebview.api; return api.get_guest_drag_bytes(); }';
ok(!bridgeUsages(goodSample).some(usage => !bridgeMethods.has(usage.method)), '真名 get_guest_drag_bytes 不会被误报');
const aliasSample = 'function rawApi(){ return (window.pywebview && window.pywebview.api) || null; } const api = rawApi(); const x = api.navigate("a");';
ok(bridgeUsages(aliasSample).some(usage => usage.method === 'navigate' && usage.alias === 'api'), '经 getter 转一手的 api.X 用法能被扫到');

console.log('[3] 全仓扫描 static/js/**/*.js');
const scan = scanRepo();
ok(scan.methods.size === bridgeMethods.size, '两次解析桥表结果一致');
ok(scan.missing.length === 0, '没有调用不存在的桥方法' + (scan.missing.length ? ('：' + scan.missing.join(' / ')) : ''));
const stale = [...WHITELIST.keys()].filter(key => !scan.usedKeys.has(key));
ok(stale.length === 0, '白名单里没有死条目' + (stale.length ? ('：' + stale.join(' / ')) : ''));
ok(![...WHITELIST.keys()].some(key => /guest_/.test(key)), '白名单没有放过 guest_* 桥方法');

console.log('');
console.log('桌面桥方法一致性：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(label => console.log('  ✗ ' + label));
if(fails.length) process.exit(1);
