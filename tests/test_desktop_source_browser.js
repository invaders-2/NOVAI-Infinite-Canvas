#!/usr/bin/env node
/* 素材源内嵌浏览器回归（task-11：WebContentsView 叠层，替代弹窗窗口）：
   E1. 主进程 novai:source-view IPC（open/setBounds/close/state 契约）+ 旧 channel 兼容；
   E2. 三个来源预设、WebContentsView 配置（沙箱/无 preload/持久化 partition/干净 UA/挂到 contentView）；
   E3. 视图生命周期：复用/切换、按渲染端 rect 定位、关闭摘除、主窗口关闭与退出清理；
   E4. 白名单导航（仅 http(s)+来源域名）、加载容错（-3 忽略、8s 超时按成功）；
   E5. preload 与 IFRAME_SHIM 的新旧方法；
   E6. 冒烟 SMOKE_VIEW / SMOKE_UI / SMOKE_UI_FRAME / SMOKE_WEBVIEW 与真实拖放 URL；
   E7. iframe shim 注入、webview 安全策略、真实静态资源存在。
   跑法：node tests/test_desktop_source_browser.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const main = read('desktop/main.js');
const preload = read('desktop/preload.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };
function topLevelFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if (start < 0) return '';
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
const BACKTICK = String.fromCharCode(96);

console.log('[1] source-view IPC 契约与旧 channel 兼容');
ok(/ipcMain\.handle\('novai:source-view'/.test(main), '注册 novai:source-view');
ok(/ipcMain\.handle\('novai:source-browser'[^\n]*handleSourceViewAction/.test(main), '旧 novai:source-browser 内部转到 source-view');
const handleFn = topLevelFunction(main, 'handleSourceViewAction');
ok(!!handleFn, 'handleSourceViewAction 存在');
ok(/action === 'open'/.test(handleFn), 'open 动作');
ok(/action === 'setBounds'/.test(handleFn), 'setBounds 动作');
ok(/action === 'close'/.test(handleFn), 'close 动作');
ok(/action === 'state'/.test(handleFn), 'state 动作');
ok(/return await openSourceView\(payload\.source, payload\.rect, \{ url: payload\.url, sourceKey: payload\.sourceKey \}\)/.test(handleFn), 'open 透传 source + rect + url/sourceKey');
ok(/return \{ ok: ok, open: isSourceViewOpen\(\), source: sourceViewSource, bounds: lastSourceViewRect \}/.test(handleFn), 'setBounds 返回 {ok,open,source,bounds}');
ok(/\{ ok: true, open: false, source: null \}/.test(handleFn), 'close 返回 {ok:true,open:false,source:null}');
ok(/action === 'reset'/.test(handleFn), 'reset 动作（退出登录/重置）');
ok(/hideSourceView\(\);/.test(handleFn), 'close 只隐藏视图（保活登录态）');
ok(/destroySourceView\(\);/.test(handleFn), 'reset 真正销毁视图');
ok(/return sourceViewState\(\)/.test(handleFn), 'state 返回统一状态对象');
ok(/action === 'reload'/.test(handleFn), 'reload 动作');
ok(/if \(!isSourceViewAlive\(\)\) return \{ ok: true, open: false, source: null \}/.test(handleFn), '没有 view 时 reload 返回 ok:true open:false');
ok(/sourceView\.webContents\.reload\(\)/.test(handleFn), 'reload 重新加载当前 view');
ok(/return \{ ok: true, open: true, source: sourceViewSource \}/.test(handleFn), 'reload 返回 {ok:true,open:true,source}');
ok(/action === 'page-html'/.test(handleFn), 'page-html 动作');
ok(/url: location\.href/.test(handleFn) && /title: document\.title/.test(handleFn), 'page-html 取 location.href / document.title');
ok(/document\.documentElement\.outerHTML\.slice\(0, 1\.8 \* 1024 \* 1024\)/.test(handleFn), 'page-html 的 HTML 截断到 1.8MB');
ok(/if \(!isSourceViewAlive\(\)\) return \{ ok: true, url: '', title: '', html: '' \}/.test(handleFn), '没有 view 时 page-html 返回空字符串');
ok(/return \{ ok: false, error: msg \}/.test(handleFn), 'page-html 异常返回 {ok:false,error}');
ok(/action === 'fetch-bytes'/.test(handleFn), 'fetch-bytes 动作');
ok(/return \{ ok: false, error: 'no-view' \}/.test(handleFn), '没有 view 时 fetch-bytes 返回 no-view');
ok(/fetch\(url, \{ credentials: credentials \}\)/.test(handleFn) && /readOnce\('include'\)/.test(handleFn), '页面上下文先带登录态 fetch（credentials:include）');
ok(/readOnce\('omit'\)/.test(handleFn), '公共 CDN（ACAO:* + ACAC:false）被 CORS 拒后去掉凭据重试');
ok(/b\.size > maxBytes/.test(handleFn) && /error: 'too-large'/.test(handleFn), '超过 maxBytes 返回 too-large');
ok(/25 \* 1024 \* 1024/.test(handleFn), 'maxBytes 默认 25MB');
ok(/Math\.min\(30 \* 1024 \* 1024/.test(handleFn), '主进程侧把上限压到 30MB（超了返回 too-large）');
ok(/b\.arrayBuffer\(\)/.test(handleFn) && /new Uint8Array\(buf\)/.test(handleFn), 'arrayBuffer + Uint8Array 分块读取');
ok(/CH = 0x8000/.test(handleFn) && /btoa\(s\)/.test(handleFn), '0x8000 分块转 binary 再 base64');
ok(/dataUrl: 'data:'/.test(handleFn) && /contentType/.test(handleFn), '返回 dataUrl / contentType');
ok(/return await sourceView\.webContents\.executeJavaScript\(script, true\)/.test(handleFn), '主进程原样返回页面上下文结果');

console.log('[2] 三个来源预设 + WebContentsView 配置');
const sbAt = main.indexOf('// ---------- 素材源内嵌浏览器');
const smokeAt = main.indexOf('// ---------- 冒烟模式（NOVAI_SMOKE_SOURCE=1）');
ok(sbAt > 0 && smokeAt > sbAt, '内嵌浏览器 / 冒烟模式分段存在');
const sbSection = main.slice(sbAt, smokeAt);
ok(/pinterest: \{ label: '[^']+', url: 'https:\/\/www\.pinterest\.com\/' \}/.test(sbSection), 'pinterest 预设');
ok(/huaban: \{ label: '[^']+', url: 'https:\/\/huaban\.com\/' \}/.test(sbSection), 'huaban 预设');
ok(/xiaohongshu: \{ label: '[^']+', url: 'https:\/\/www\.xiaohongshu\.com\/explore' \}/.test(sbSection), 'xiaohongshu 预设');
const presetBlock = (sbSection.match(/const SOURCE_BROWSERS = \{[\s\S]*?\n\};/) || [''])[0];
ok((presetBlock.match(/label:/g) || []).length === 3, '预设只有三个来源');
ok(/'persist:novai-source-browser'/.test(main), '持久化 partition persist:novai-source-browser');
ok(/WebContentsView/.test(main.split('\n')[8] || ''), '引入了 WebContentsView');
const createView = topLevelFunction(main, 'createSourceView');
ok(!!createView, 'createSourceView 存在');
ok(/new WebContentsView\(\{/.test(createView), '用 WebContentsView 创建内嵌浏览器');
ok(/contextIsolation: true/.test(createView), 'contextIsolation:true');
ok(/nodeIntegration: false/.test(createView), 'nodeIntegration:false');
ok(/sandbox: true/.test(createView), 'sandbox:true');
ok(/partition: SOURCE_BROWSER_PARTITION/.test(createView), '持久化 partition');
ok(/preload: path\.join\(__dirname, 'source-drag-preload\.js'\)/.test(createView), '挂拖拽记录 preload（source-drag-preload.js）');
ok(!/preload: path\.join\(__dirname, 'preload\.js'\)/.test(createView), '不挂主窗口 preload');
ok(/setUserAgent\(userAgent\)/.test(createView), '设置干净 UA');
const openView = topLevelFunction(main, 'openSourceView');
ok(!!openView, 'openSourceView 存在');
ok(/mainWindow\.contentView\.addChildView\(view\)/.test(openView), '挂到 mainWindow.contentView');
ok(/applySourceViewBounds\(rect \|\| lastSourceViewRect \|\| defaultSourceViewRect\(\)\)/.test(openView), '按渲染端 rect 定位（缺省复用上次尺寸 / 兜底 rect）');
ok(/isAllowedWebviewUrl\(url\)/.test(openView), '初始 URL 走域名白名单');
ok(/loadSourceViewUrl\(view\.webContents, \(\) => view\.webContents\.loadURL\(url\), url\)/.test(openView), '用容错加载器加载');

console.log('[3] 干净 UA（按平台生成，无 Electron/应用名）');
const uaSrc = topLevelFunction(main, 'sourceBrowserUserAgent');
ok(!!uaSrc, 'sourceBrowserUserAgent 是可抽取的顶层纯函数');
let uaFor = null;
try {
    uaFor = (platform, chrome) => new Function('process', 'return (' + uaSrc + ');')({ platform: platform, versions: { chrome: chrome } })();
} catch (_) {}
ok(typeof uaFor === 'function', 'UA 函数可在 node 里直接执行');
if (typeof uaFor === 'function') {
    const mac = uaFor('darwin', '130.0.6723.44');
    const win = uaFor('win32', '130.0.6723.44');
    const linux = uaFor('linux', '130.0.6723.44');
    ok(/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/130\.0\.6723\.44 Safari\/537\.36$/.test(mac), 'macOS 标准 Chrome UA');
    ok(/Windows NT 10\.0; Win64; x64/.test(win), 'Windows 标准 Chrome UA');
    ok(/X11; Linux x86_64/.test(linux), 'Linux 标准 Chrome UA');
    ok(!/electron|novai|pywebview/i.test(mac + win + linux), 'UA 不含 Electron/应用名/pywebview');
}

console.log('[4] 视图生命周期：保活 / 复用 / 定位 / 销毁');
ok(/const sameSource = isSourceViewAlive\(\) && sourceViewSource === effectiveSourceKey && !!currentUrl/.test(openView), '同来源复用不重复加载');
ok(/if \(sameSource\) \{[\s\S]{0,200}return \{ ok: true, open: true, source: sourceViewSource, url: currentUrl, bounds: lastSourceViewRect \}/.test(openView), '复用直接返回 ok + url/bounds');
ok(/if \(isSourceViewAlive\(\) && sourceViewSource && sourceViewSource !== effectiveSourceKey\) destroySourceView\(\)/.test(openView), '切换来源站点时才销毁旧 view');
ok(/if \(!sourceViewAttached\)/.test(openView) && /addChildView\(view\)/.test(openView), '重新打开时把保活的 view 挂回窗口');
ok(/sourceViewVisible = true/.test(openView), 'open 后标记可见');
const hideView = topLevelFunction(main, 'hideSourceView');
ok(!!hideView, 'hideSourceView 存在');
ok(/removeChildView\(sourceView\)/.test(hideView), '关闭面板 removeChildView');
ok(!/webContents\.close\(\)/.test(hideView), '关闭面板不 close webContents（保活登录态）');
ok(/flushSourceCookies\(\)/.test(hideView), '关闭面板时 flushStore 落盘 cookie');
const destroyView = topLevelFunction(main, 'destroySourceView');
ok(!!destroyView, 'destroySourceView 存在');
ok(/webContents\.close\(\)/.test(destroyView), '销毁时才 webContents.close()');
ok(/flushSourceCookies\(\)/.test(destroyView), '销毁前也 flush cookie');
ok(/sourceViewVisible = false/.test(destroyView) && /sourceViewAttached = false/.test(destroyView), '销毁后状态回落');
ok((main.match(/webContents\.close\(\)/g) || []).length === 1, '只有 destroySourceView 会真正 close webContents');
const flushFn = topLevelFunction(main, 'flushSourceCookies');
ok(!!flushFn && /cookies\.flushStore\(\)/.test(flushFn) && /catch\(\(\) => \{\}\)/.test(flushFn), 'flushStore 异常被 catch 掉');
const createWinFn = topLevelFunction(main, 'createWindow');
ok(/mainWindow\.on\('closed'[\s\S]{0,240}destroySourceView\(\)/.test(createWinFn), '主窗口关闭时销毁视图');
ok(/before-quit[\s\S]{0,140}destroySourceView\(\)/.test(main), '退出时销毁视图');
const setBoundsFn = topLevelFunction(main, 'setSourceViewBounds');
ok(!!setBoundsFn && /applySourceViewBounds\(rect\)/.test(setBoundsFn), 'setBounds 动作走 applySourceViewBounds');
const normFn = topLevelFunction(main, 'normalizeSourceViewRect');
ok(!!normFn, 'normalizeSourceViewRect 存在');
let norm = null;
try { norm = new Function('return (' + normFn + ')')(); } catch (_) {}
ok(typeof norm === 'function', 'rect 归一化函数可独立执行');
if (typeof norm === 'function') {
    const b = norm({ x: 10.4, y: 20.6, width: 300, height: 400 });
    ok(b && b.x === 10 && b.y === 21 && b.width === 300, 'rect 取整');
    const tiny = norm({ x: 0, y: 0, width: -5, height: 0 });
    ok(tiny && tiny.width === 80 && tiny.height === 80, 'rect 最小尺寸兜底');
    ok(norm(null) === null && norm({ x: 'a' }) === null, '非法 rect 返回 null');
}

console.log('[4b] 加载判定：ERR_ABORTED(-3) 不算失败，8s 超时按成功');
const loadFn = topLevelFunction(main, 'loadSourceViewUrl');
ok(!!loadFn, 'loadSourceViewUrl 存在');
ok(/code === -3/.test(loadFn) && /ERR_ABORTED/.test(loadFn), 'did-fail-load code -3 视为导航被站点替换');
ok(/if \(code === -3\) \{[\s\S]{0,200}return;/.test(loadFn), '-3 不结算、继续等待');
ok(/webContents\.once\('did-finish-load'/.test(loadFn), '监听 did-finish-load');
ok(/webContents\.on\('did-fail-load'/.test(loadFn), '监听 did-fail-load');
ok(/removeListener\('did-finish-load'/.test(loadFn) && /removeListener\('did-fail-load'/.test(loadFn), '先到先结算并移除监听');
ok(/timer = setTimeout\(\(\) => \{[\s\S]{0,160}finish\(null\)/.test(loadFn), '超时按成功处理');
ok(/8000/.test(loadFn), '超时 8s');
ok(/navigation\.catch\(\(\) => \{\}\)/.test(loadFn), 'loadURL rejection 交给事件判定');
ok(/finish\(msg\)/.test(loadFn) && /加载失败/.test(loadFn), '明确的非 -3 主框架错误才回传 error');

console.log('[5] preload.js 新旧方法');
ok(/open_source_view: \(source, rect\) => \{[\s\S]{0,260}typeof source === 'object'/.test(preload), 'open_source_view（位置参数/对象参数）');
ok(/set_source_view_bounds: \(rect\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'setBounds', rect \}\)/.test(preload), 'set_source_view_bounds');
ok(/close_source_view: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'close' \}\)/.test(preload), 'close_source_view');
ok(/get_source_view_state: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'state' \}\)/.test(preload), 'get_source_view_state');
ok(/reload_source_view: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'reload' \}\)/.test(preload), 'reload_source_view（面板刷新按钮）');
ok(/get_source_view_page_html: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'page-html' \}\)/.test(preload), 'get_source_view_page_html（把已加载 HTML 交给后端）');
ok(/get_source_view_fetch_bytes: \(a, b\) => ipcRenderer\.invoke\('novai:source-view',/.test(preload), 'preload 暴露 get_source_view_fetch_bytes');
ok(/get_last_guest_drag: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'last-drag' \}\)/.test(preload), 'preload 暴露 get_last_guest_drag');
ok(/typeof a === 'string'[\s\S]{0,140}maxBytes: b[\s\S]{0,140}Object\.assign\(\{ action: 'fetch-bytes' \}, a \|\| \{\}\)/.test(preload), '兼容 (url, maxBytes) 与 ({url,maxBytes}) 两种调用');
let fetchBridge = null;
try {
    const at = preload.indexOf('get_source_view_fetch_bytes:');
    const endMark = 'a || {}))';
    const endAt = preload.indexOf(endMark, at) + endMark.length;
    const expr = preload.slice(at, endAt).replace('get_source_view_fetch_bytes:', '').replace(/,\s*$/, '');
    fetchBridge = new Function('ipcRenderer', 'return (' + expr + ')')({ invoke: (channel, payload) => ({ channel: channel, payload: payload }) });
} catch (_) {}
ok(typeof fetchBridge === 'function', 'fetch-bytes 桥可独立执行');
if (typeof fetchBridge === 'function') {
    const positional = fetchBridge('https://i.pinimg.com/a.jpg', 2048);
    ok(positional.channel === 'novai:source-view' && positional.payload.action === 'fetch-bytes' && positional.payload.url === 'https://i.pinimg.com/a.jpg' && positional.payload.maxBytes === 2048, '位置参数 (url, maxBytes) 正确映射');
    const objectArg = fetchBridge({ url: 'https://i.pinimg.com/b.mp4', maxBytes: 4096 });
    ok(objectArg.payload.action === 'fetch-bytes' && objectArg.payload.url === 'https://i.pinimg.com/b.mp4' && objectArg.payload.maxBytes === 4096, '对象参数 ({url,maxBytes}) 正确映射');
}
ok(/open_source_browser: \(source\) => ipcRenderer\.invoke\('novai:source-view'/.test(preload), '旧 open_source_browser 转发 source-view');
ok(/close_source_browser: \(\) => ipcRenderer\.invoke\('novai:source-view'/.test(preload), '旧 close_source_browser 转发 source-view');
ok(/get_source_browser_state: \(\) => ipcRenderer\.invoke\('novai:source-view'/.test(preload), '旧 get_source_browser_state 转发 source-view');
ok(/ipcRenderer\.invoke\('novai:' \+ method, payload\)/.test(preload), 'iframe 转发仍走通用 novai: 前缀');

console.log('[6] IFRAME_SHIM 新旧方法');
const shimAt = main.indexOf('const IFRAME_SHIM = ' + BACKTICK);
const shimEnd = main.indexOf(BACKTICK + ';', shimAt);
const shim = shimAt >= 0 ? main.slice(shimAt, shimEnd) : '';
ok(shimAt >= 0 && shim.length > 0, '找到 IFRAME_SHIM 常量');
ok(/open_source_view: function\(s, r\)\{[\s\S]{0,160}typeof s === 'object'/.test(shim), 'shim open_source_view（位置参数/对象参数）');
ok(/set_source_view_bounds: function\(r\)\{ return call\('source-view', \{action:'setBounds', rect: r\}\); \}/.test(shim), 'shim set_source_view_bounds');
ok(/close_source_view: function\(\)\{ return call\('source-view', \{action:'close'\}\); \}/.test(shim), 'shim close_source_view');
ok(/get_source_view_state: function\(\)\{ return call\('source-view', \{action:'state'\}\); \}/.test(shim), 'shim get_source_view_state');
ok(/reload_source_view: function\(\)\{ return call\('source-view', \{action:'reload'\}\); \}/.test(shim), 'shim reload_source_view');
ok(/get_source_view_page_html: function\(\)\{ return call\('source-view', \{action:'page-html'\}\); \}/.test(shim), 'shim get_source_view_page_html');
ok(/get_source_view_fetch_bytes: function\(u, m\)\{[\s\S]{0,300}typeof u === 'string'[\s\S]{0,300}Object\.assign\(\{action:'fetch-bytes'\}, u \|\| \{\}\)/.test(shim), 'shim get_source_view_fetch_bytes（位置参数与对象参数都支持）');
ok(/get_last_guest_drag: function\(\)\{ return call\('source-view', \{action:'last-drag'\}\); \}/.test(shim), 'shim get_last_guest_drag');
ok(/open_source_browser: function\(s\)\{ return call\('source-view', \{action:'open', source: s\}\); \}/.test(shim), 'shim 旧 open_source_browser 转发');
ok(/close_source_browser: function\(\)\{ return call\('source-view', \{action:'close'\}\); \}/.test(shim), 'shim 旧 close_source_browser 转发');
ok(/get_source_browser_state: function\(\)\{ return call\('source-view', \{action:'state'\}\); \}/.test(shim), 'shim 旧 get_source_browser_state 转发');

console.log('[7] 冒烟模式（NOVAI_SMOKE_SOURCE=1）');
const smokeSection = main.slice(smokeAt, main.indexOf('// ---------- IPC：pywebview 兼容桥'));
ok(/process\.env\.NOVAI_SMOKE_SOURCE === '1'/.test(main), '仅环境变量 NOVAI_SMOKE_SOURCE=1 触发');
ok(/process\.env\.NOVAI_SMOKE_SOURCE_KEY \|\| 'huaban'/.test(smokeSection), '默认来源 huaban，可用 NOVAI_SMOKE_SOURCE_KEY 覆盖');
ok(/process\.env\.NOVAI_SMOKE_SOURCE_URL \|\| preset\.url/.test(smokeSection), 'URL 可用 NOVAI_SMOKE_SOURCE_URL 覆盖');
ok(/openSourceView\(source, smokeRect, url\)/.test(smokeSection), '冒烟直接开 WebContentsView（无伴生窗口）');
ok(/'\[smoke\] SMOKE_VIEW=' \+ JSON\.stringify\(\{ created: isSourceViewAlive\(\), loaded: !!loaded, bounds: smokeViewBounds, page: smokePage \}\)/.test(smokeSection), '打印 SMOKE_VIEW（含 page）');
ok(/created: isSourceViewAlive\(\)/.test(smokeSection) && /bounds: smokeViewBounds/.test(smokeSection) && /page: smokePage/.test(smokeSection), 'SMOKE_VIEW 含 created / loaded / bounds / page');
ok(/document\.title/.test(smokeSection) && /bodyLen: document\.body \? document\.body\.innerText\.length : 0/.test(smokeSection), 'page 取标题与正文长度');
ok(/EO_Bot\|__tst_status\|challenge\/i\.test\(document\.documentElement\.innerHTML\.slice\(0, 3000\)\)/.test(smokeSection), 'page.isChallenge 用 EdgeOne 挑战标记判定');
ok(/Promise\.race/.test(smokeSection), '页面信息读取有超时兜底');
ok(/destroySourceView\(\)/.test(smokeSection), '冒烟结束销毁视图');
ok(/'\[smoke\] SMOKE_COOKIE=' \+ JSON\.stringify\(smokeCookie\)/.test(smokeSection), '打印 SMOKE_COOKIE');
ok(/'\[smoke\] SMOKE_VIEW_REUSE=' \+ \(smokeViewReuse \? 'true' : 'false'\)/.test(smokeSection), '打印 SMOKE_VIEW_REUSE');
ok(/const smokeCookie = \{ set: false, afterHide: false, afterReopen: false \}/.test(smokeSection), 'SMOKE_COOKIE 三个字段齐全');
ok(/cookies\.set\(\{[\s\S]{0,260}novai_smoke_auth/.test(smokeSection), '在 view 所在 session 里种测试 cookie');
ok(/handleSourceViewAction\(\{ action: 'close' \}\)/.test(smokeSection), '调 close（隐藏）后检查 cookie');
ok(/const viewIdBefore = sourceView\.webContents\.id/.test(smokeSection) && /sourceView\.webContents\.id === viewIdBefore/.test(smokeSection), '用 webContents.id 比对 close→open 是否复用同一个 view');
ok(/waitForSourceViewLoaded\(8000\)/.test(smokeSection) && /did-finish-load/.test(smokeSection), '等视图 did-finish-load 或 8s 超时');
ok(/'\[smoke\] SMOKE_OPEN=' \+ JSON\.stringify\(openResult\)/.test(smokeSection), '打印 SMOKE_OPEN');
ok(/'\[smoke\] SMOKE_STATE=' \+ JSON\.stringify\(state\)/.test(smokeSection), '打印 SMOKE_STATE');
ok(/'\[smoke\] SMOKE_UA=' \+ String\(smokeUa \|\| ''\)/.test(smokeSection), '打印 SMOKE_UA');
ok(/'\[smoke\] SMOKE_LOADED=' \+ \(loaded \? 'true' : 'false'\)/.test(smokeSection), '打印 SMOKE_LOADED');
ok(/'\[smoke\] SMOKE_URL=' \+ String\(smokeUrl \|\| ''\)/.test(smokeSection), '打印 SMOKE_URL');
ok(/'\[smoke\] SMOKE_UI=' \+ smokeUi/.test(smokeSection), '打印 SMOKE_UI');
ok(/'\[smoke\] SMOKE_UI_FRAME=' \+ smokeUiFrame/.test(smokeSection), '打印 SMOKE_UI_FRAME');
ok(/'\[smoke\] SMOKE_WEBVIEW=' \+ smokeWebview/.test(smokeSection), '打印 SMOKE_WEBVIEW');
ok(/'\[smoke\] SMOKE_RESULT=' \+ \(ok \? 'ok' : 'fail'\)/.test(smokeSection), '打印 SMOKE_RESULT');
ok(/const ok = !!\(openResult && openResult\.ok && state\.open && smokeDropPrefetch && smokeDropPrefetch\.hit && smokeDropPrefetch\.nodeAdded\)/.test(smokeSection), 'SMOKE_RESULT 还要预取通道命中且落图加了节点');
ok(/ready-to-show[\s\S]{0,220}isSmokeMode\(\)/.test(main), '冒烟模式主窗口不弹给用户');
ok(/loadURL\(url\)\.then[\s\S]{0,220}runSourceBrowserSmoke\(\)/.test(main), '主窗口加载完成后自动跑冒烟');

console.log('[8] UI 探针：面板 / 真实 iframe / 真实可下载拖放 URL');
const uiFn = topLevelFunction(main, 'runSourceBrowserUiCheck');
ok(!!uiFn, 'runSourceBrowserUiCheck 存在');
ok(/show: false/.test(uiFn), 'UI 探针窗口隐藏');
ok(/preload: path\.join\(__dirname, 'preload\.js'\)/.test(uiFn), '与主窗口相同 webPreferences（含 preload.js）');
ok(/injectIframeShims\(win\.webContents\)/.test(uiFn), 'UI 探针窗口也挂 iframe 注入');
ok(/\/static\/smart-canvas\.html/.test(uiFn), '加载 smart-canvas.html');
ok(/executeJavaScript\(sourceBrowserUiProbe\(\)/.test(uiFn), '执行面板探针');
ok(/runWebviewFeasibilityCheck\(win\)/.test(uiFn), '执行 webview 可行性探针');
const probe = topLevelFunction(main, 'sourceBrowserUiProbe');
ok(!!probe, 'sourceBrowserUiProbe 存在');
ok(/sourceBrowserToggle/.test(probe) && /sourceBrowserPanel/.test(probe), '探针点击来源按钮并读面板');
ok(/sourceBrowserTabs/.test(probe) && /\[data-source-key="huaban"\]/.test(probe) && /tabsEl/.test(probe), '点的是 #sourceBrowserTabs 里的花瓣 tab（新 morphing tabs）');
ok(/aria-selected/.test(probe) && /rowOpen: tabActive/.test(probe) && /tabActive: tabActive/.test(probe), 'tab 激活态看 aria-selected，rowOpen 语义改为 tabActive');
ok(/open_source_view/.test(probe), '桥检查包含 open_source_view');
ok(/frameTabsEl/.test(probe) && /frameTabActive/.test(probe) && /rowOpen: frameTabActive/.test(probe), 'iframe 内同样按 tab + aria-selected 判断');
ok(/document\.createElement\('iframe'\)/.test(probe) && /frame\.contentDocument/.test(probe), '探针动态建同源 iframe 并读文档');
ok(/inner\.pywebview/.test(probe), 'iframe 内检查 pywebview.api');
ok(/querySelectorAll\('\.image-node'\)/.test(probe), '拖放前后统计 .image-node 数量');
ok(/new DataTransfer\(\)/.test(probe) && /'text\/uri-list'/.test(probe) && /'text\/html'/.test(probe), '构造 DataTransfer（uri-list + html）');
ok(/new DragEvent\('drop', \{ bubbles: true, cancelable: true, dataTransfer: imageTransfer, clientX: 520, clientY: 360 \}\)/.test(probe), '真实 DropEvent 拖入图片');
ok(/window\.location\.origin \+ '\/static\/images\/logo\.png'/.test(probe), '图片用站内真实 URL /static/images/logo.png');
ok(/window\.location\.origin \+ '\/static\/images\/templates\/product-video\.mp4'/.test(probe), '视频用站内真实 URL /static/images/templates/product-video.mp4');
ok(/nodeAdded: nodesAfter > nodesBefore/.test(probe) && /videoNodeAdded: videoNodeAdded/.test(probe), '返回 nodeAdded / videoNodeAdded');
let probeText = '';
let probeCompiles = false;
try {
    probeText = new Function('return (' + probe + ')')()();
    new Function('return ' + probeText);
    probeCompiles = true;
} catch (_) {}
ok(probeCompiles, '面板探针脚本可被 JS 引擎解析');
ok(fs.existsSync(path.join(root, 'static/images/logo.png')), '拖放图片真实存在：static/images/logo.png');
ok(fs.existsSync(path.join(root, 'static/images/templates/product-video.mp4')), '拖放视频真实存在：static/images/templates/product-video.mp4');

console.log('[9] iframe shim 注入（data-src 懒加载 frame）');
const injectFn = topLevelFunction(main, 'injectIframeShims');
ok(!!injectFn, 'injectIframeShims 存在');
ok(/'frame-created'/.test(injectFn), '保留 frame-created 注入');
ok(/'did-frame-finish-load'/.test(injectFn) && /'did-finish-load'/.test(injectFn), '子 frame 加载完成后重新注入');
ok(/isMainFrame === true/.test(injectFn), '主 frame 跳过（主窗口自带 preload）');
ok(/walk\(webContents\.mainFrame\)/.test(injectFn) && /\.frames/.test(injectFn) && /walk\(child\)/.test(injectFn), '递归遍历 mainFrame 下所有子 frame');
ok(/frame\.detached/.test(injectFn), 'frame 已销毁时跳过');
ok(/executeJavaScript\(IFRAME_SHIM, true\)/.test(injectFn), '注入 IFRAME_SHIM');
ok(/__novaiShimInjected/.test(main), 'shim 自带幂等守卫');

console.log('[10] webview 安全策略（will-attach-webview）');
ok(/webviewTag: true/.test(createWinFn), '主窗口开启 webviewTag');
ok(/installWebviewSecurityPolicy\(\);/.test(main), 'whenReady 里安装 webview 安全策略');
ok(/app\.on\('web-contents-created'[\s\S]{0,200}will-attach-webview/.test(main), '对所有 webContents 挂 will-attach-webview');
const attachFn = topLevelFunction(main, 'handleWillAttachWebview');
ok(!!attachFn, 'handleWillAttachWebview 存在');
ok(/delete webPreferences\.preload/.test(attachFn) && /delete webPreferences\.preloadURL/.test(attachFn), '强制清掉 preload / preloadURL');
ok(/webPreferences\.nodeIntegration = false/.test(attachFn) && /webPreferences\.contextIsolation = true/.test(attachFn) && /webPreferences\.sandbox = true/.test(attachFn), '强制 nodeIntegration:false / contextIsolation:true / sandbox:true');
ok(/webPreferences\.webviewTag = false/.test(attachFn), 'guest 内禁止再嵌 webview');
ok(/webPreferences\.partition = SOURCE_BROWSER_PARTITION/.test(attachFn), '强制 partition');
ok(/event\.preventDefault\(\)/.test(attachFn), '非白名单 event.preventDefault()');
const wvDomains = ['pinterest.com', 'pinimg.com', 'huaban.com', 'huabanimg.com', 'xiaohongshu.com', 'xhscdn.com'];
ok(wvDomains.every(d => main.indexOf("'" + d + "'") >= 0), '六个来源域名都在白名单');
let allowFn = null;
try {
    const domainsAt = main.indexOf('const WEBVIEW_ALLOWED_DOMAINS');
    const domainsEnd = main.indexOf('];', domainsAt) + 2;
    const domainsSrc = main.slice(domainsAt, domainsEnd);
    const allowSrc = topLevelFunction(main, 'isAllowedWebviewUrl');
    allowFn = new Function(domainsSrc + '\n' + allowSrc + '\nreturn isAllowedWebviewUrl;')();
} catch (_) {}
ok(typeof allowFn === 'function', 'isAllowedWebviewUrl 可独立执行');
if (typeof allowFn === 'function') {
    ok(allowFn('https://www.pinterest.com/') === true, '放行 www.pinterest.com');
    ok(allowFn('https://i.pinimg.com/736x/a.jpg') === true, '放行子域 i.pinimg.com');
    ok(allowFn('https://huaban.com/') === true, '放行 huaban.com');
    ok(allowFn('https://www.xiaohongshu.com/explore') === true, '放行 xiaohongshu.com');
    ok(allowFn('http://huaban.com/') === true, 'http(s) 都允许');
    ok(allowFn('https://evil.example/') === false, '拒绝非白名单域名');
    ok(allowFn('https://huaban.com.evil.example/') === false, '拒绝后缀欺骗域名');
    ok(allowFn('javascript:alert(1)') === false, '拒绝非 http(s) 协议');
    ok(allowFn('') === false, '拒绝空 src');
    const navGuard = /will-navigate[\s\S]{0,260}\^https\?:[\s\S]{0,200}preventDefault/.test(createView);
    ok(navGuard, '视图内导航允许任意 http(s)，只拦非 http(s) 协议');
    ok(!/will-navigate[\s\S]{0,260}isAllowedWebviewUrl/.test(createView), '视图内导航不再受域名白名单限制');
    const popupGuard = /setWindowOpenHandler[\s\S]{0,400}\^https\?:[\s\S]{0,240}action: 'deny'/.test(createView);
    ok(popupGuard, '弹窗 http(s) 在同一 view 内打开，非 http(s) 拒绝');
}
let attachHandler = null;
try {
    const src = topLevelFunction(main, 'handleWillAttachWebview');
    attachHandler = new Function('SOURCE_BROWSER_PARTITION', 'isAllowedWebviewUrl', 'clog', 'return (' + src + ');')('persist:novai-source-browser', allowFn || function () { return false; }, function () {});
} catch (_) {}
ok(typeof attachHandler === 'function', 'handleWillAttachWebview 可独立执行');
if (typeof attachHandler === 'function') {
    const prefs = { preload: '/evil.js', preloadURL: 'file:///evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false, partition: 'default', webviewTag: true };
    const allowed = { prevented: false, preventDefault: function () { this.prevented = true; } };
    attachHandler(allowed, prefs, { src: 'https://huaban.com/' });
    ok(prefs.preload === undefined && prefs.preloadURL === undefined, '挂载时清空 preload / preloadURL');
    ok(prefs.nodeIntegration === false && prefs.contextIsolation === true && prefs.sandbox === true, '挂载时强制安全偏好');
    ok(prefs.partition === 'persist:novai-source-browser', '挂载时强制 partition');
    ok(prefs.webviewTag === false, 'guest 内关闭 webviewTag');
    ok(allowed.prevented === false, '白名单域名放行');
    const denied = { prevented: false, preventDefault: function () { this.prevented = true; } };
    attachHandler(denied, { preload: '/evil.js' }, { src: 'https://evil.example/' });
    ok(denied.prevented === true, '非白名单域名被 preventDefault');
}

console.log('[11] 渲染进程 console 诊断转发');
const consoleFn = topLevelFunction(main, 'attachRendererConsole');
ok(!!consoleFn, 'attachRendererConsole 存在');
ok(/'console-message'/.test(consoleFn), '监听 console-message');
ok(/slice\(0, 800\)/.test(consoleFn), 'message 截断到 800 字符');
ok(/clog\('renderer'/.test(consoleFn), '写入 clog(renderer, ...)');
ok(/event\.message !== undefined/.test(consoleFn), '兼容新旧 console-message 事件签名');
ok(/attachRendererConsole\(mainWindow\.webContents, 'main'\)/.test(main), '主窗口挂 console 转发（画布 iframe 子 frame 也能进日志）');
ok(/attachRendererConsole\(wc, 'source-view'\)/.test(main), '内嵌浏览器 view 挂 console 转发');

console.log('[12] 内嵌浏览器拖拽元素记录（source-drag-preload）');
const dragPreloadPath = path.join(root, 'desktop/source-drag-preload.js');
ok(fs.existsSync(dragPreloadPath), 'desktop/source-drag-preload.js 存在');
const dragPreload = fs.existsSync(dragPreloadPath) ? fs.readFileSync(dragPreloadPath, 'utf8') : '';
ok(/require\('electron'\)/.test(dragPreload) && /ipcRenderer/.test(dragPreload), 'preload 只用 electron ipcRenderer');
ok(/addEventListener\('dragstart', handleDragStart, true\)/.test(dragPreload), '捕获阶段监听 dragstart');
ok(/ipcRenderer\.send\('novai:guest-drag', payload\)/.test(dragPreload), '把 payload 发给主进程');
['currentSrc', 'srcset', 'data-src', 'data-original', 'poster'].forEach(name => ok(dragPreload.indexOf(name) >= 0, '采集 ' + name));
ok(/querySelectorAll\('source'\)/.test(dragPreload), 'video 取 <source> 的 src');
ok(/closest\('a'\)/.test(dragPreload), '向上取 a[href]');
ok(/dt\.types/.test(dragPreload), '记录 dataTransfer.types');
ok(/getData\('text\/uri-list'\)/.test(dragPreload) && /slice\(0, 4000\)/.test(dragPreload), '记录 text/uri-list（截断 4000）');
ok(/getData\('text\/html'\)/.test(dragPreload), '记录 text/html');
ok(/location\.href/.test(dragPreload) && /document\.title/.test(dragPreload) && /Date\.now\(\)/.test(dragPreload), '附带页面 URL / 标题 / 时间');
ok(/catch \(_\)/.test(dragPreload) && !/(insertAdjacentHTML|removeChild)/.test(dragPreload), '异常全吞、不破坏页面结构（仅注入控件节点）');
ok(/preload: path\.join\(__dirname, 'source-drag-preload\.js'\)/.test(createView), '视图 webPreferences 挂 source-drag-preload');
const desktopPkg = JSON.parse(read('desktop/package.json'));
ok(desktopPkg.build && Array.isArray(desktopPkg.build.files) && desktopPkg.build.files.includes('source-drag-preload.js'), '打包 files 包含 source-drag-preload.js（否则安装包会缺 preload）');
ok(/sandbox: true/.test(createView) && /contextIsolation: true/.test(createView) && /nodeIntegration: false/.test(createView) && /partition: SOURCE_BROWSER_PARTITION/.test(createView), '安全参数保持不变');
ok(/ipcMain\.on\('novai:guest-drag'/.test(main), '主进程监听 novai:guest-drag');
ok(/event\.sender !== sourceView\.webContents/.test(main), '校验 sender 是当前 source view');
ok(/const record = \{ payload: payload, receivedAt: Date\.now\(\), bytesPromise: null, bytesResult: null, originalPromise: null, originalUrl: '' \}/.test(main) && /lastGuestDrag = record/.test(main), '存到 lastGuestDrag（带接收时间/medium+original promise）');
ok(/action === 'last-drag'/.test(handleFn), 'last-drag 动作');
ok(/Date\.now\(\) - lastGuestDrag\.receivedAt\) <= 60000/.test(handleFn), 'last-drag 超过 60s 视为 null');
ok(/return \{ ok: true, drag: entry \? entry\.payload : null \}/.test(handleFn), 'last-drag 返回 {ok:true,drag}');
ok(/lastGuestDrag = null;/.test(destroyView), 'reset / 销毁时清空 lastGuestDrag');
ok(/function findMedia\(target, event\)/.test(dragPreload) && /document\.elementFromPoint/.test(dragPreload), '按 elementFromPoint 坐标命中媒体');
ok(/elementsFromPoint/.test(dragPreload) && /findMediaInStack/.test(dragPreload) && /hitMethod/.test(dragPreload), 'elementsFromPoint 穿透覆盖层，记录 hitMethod');
ok(/targetTag/.test(dragPreload) && /linkHref/.test(dragPreload) && /sourceTag/.test(dragPreload), '新增 targetTag / linkHref / sourceTag 字段');
ok(/findMedia\(target, event\)/.test(dragPreload) && /const el = media \|\| \(bgMedia && bgMedia\.el\) \|\| target/.test(dragPreload), '解析出媒体元素后按原字段采集');
ok(/mediaUrl: mediaUrl\(el\)/.test(dragPreload) && /src: attr\(el, 'src'\)/.test(dragPreload), '采集字段来自解析出的媒体元素');
// 实际执行 preload：模拟小红书「A 包 IMG」的拖拽
let dragSent = null;
let dragHandler = null;
try {
    const fakeDocument = {
        title: '小红书',
        elementFromPoint: function () { return globalThis.__novaiTestPoint || null; },
        addEventListener: function (type, fn, capture) { if (type === 'dragstart') dragHandler = fn; return capture; },
    };
    const fakeLocation = { href: 'https://www.xiaohongshu.com/explore' };
    const fakeRequire = function (name) {
        if (name !== 'electron') throw new Error('unexpected require ' + name);
        return { ipcRenderer: { send: function (channel, payload) { dragSent = { channel: channel, payload: payload }; } } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, fakeLocation);
} catch (_) {}
ok(typeof dragHandler === 'function', 'preload 注册了 dragstart 监听');
if (typeof dragHandler === 'function') {
    const makeEl = function (tagName, attrs, extra) {
        return {
            tagName: tagName,
            href: '',
            currentSrc: '',
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(attrs || {}, name) ? attrs[name] : null; },
            querySelector: function () { return (extra && extra.down) || null; },
            querySelectorAll: function () { return (extra && extra.sources) || []; },
            closest: function () { return (extra && extra.anchor) || null; },
            parentElement: (extra && extra.parent) || null,
        };
    };
    const anchor = makeEl('A', { href: '/explore/123' });
    anchor.href = 'https://www.xiaohongshu.com/explore/123';
    const img = makeEl('IMG', { src: 'https://sns-img.xhscdn.com/abc.jpg', srcset: 'https://sns-img.xhscdn.com/abc.jpg 1x, https://sns-img.xhscdn.com/abc@2x.jpg 2x' }, { anchor: anchor });
    img.currentSrc = 'https://sns-img.xhscdn.com/abc.jpg';
    const aEl = makeEl('A', { href: '/explore/123' }, { down: img });
    aEl.href = 'https://www.xiaohongshu.com/explore/123';
    globalThis.__novaiTestPoint = img;
    dragHandler({ target: aEl, clientX: 100, clientY: 200, dataTransfer: { types: ['text/uri-list'], setData: function () {}, getData: function () { return ''; } } });
    const payload = dragSent && dragSent.payload;
    ok(dragSent && dragSent.channel === 'novai:guest-drag', 'A 包图片时仍然回传 novai:guest-drag');
    ok(payload && payload.tagName === 'IMG', 'tagName 解析为被包裹的 IMG');
    ok(payload && payload.targetTag === 'A', 'targetTag 保留原始被拖元素 A');
    ok(payload && payload.mediaUrl === 'https://sns-img.xhscdn.com/abc.jpg', 'mediaUrl 取到图片真实地址');
    ok(payload && payload.linkHref === 'https://www.xiaohongshu.com/explore/123', 'linkHref 记录 A 的 href');
    ok(payload && payload.srcset === 'https://sns-img.xhscdn.com/abc.jpg', 'srcset 取第一个候选');
    ok(payload && payload.pageUrl === 'https://www.xiaohongshu.com/explore' && payload.pageTitle === '小红书', '附带页面信息');
}

console.log('[12b] <video> 默认不可拖：补 draggable + videoUrls');
ok(/setAttribute\('draggable', 'true'\)/.test(dragPreload), '给 <video> 补 draggable="true"');
ok(/MutationObserver/.test(dragPreload) && /childList: true, subtree: true/.test(dragPreload), 'MutationObserver 持续补新 video');
ok(/scanVideos\(document\)/.test(dragPreload) && /scanVideos\(node\)/.test(dragPreload), '初始扫一遍 + 新增节点也扫');
ok(/videoUrls/.test(dragPreload) && /data-video-url/.test(dragPreload), '新增 videoUrls 字段与 data-video-url 采集');
ok(/tagOf\(el\) === 'VIDEO'/.test(dragPreload) && /payload\.videoUrls = videoUrls\(el\)/.test(dragPreload), 'VIDEO 分支采集 videoUrls');
ok(/tag === 'VIDEO'/.test(dragPreload) && /candidates\.push\(attr\(el, 'poster'\)\)/.test(dragPreload), 'poster 只作信息（不进视频媒体地址）');
ok(/setProperty\('-webkit-user-drag', 'element'\)/.test(dragPreload), '设置 -webkit-user-drag:element');
ok(/addEventListener\('pointerdown', handlePointer, true\)/.test(dragPreload), '捕获阶段监听 pointerdown');
ok(/addEventListener\('mousedown', handlePointer, true\)/.test(dragPreload), '捕获阶段监听 mousedown');
ok(/stopImmediatePropagation\(\)/.test(dragPreload), 'pointerdown 用 stopImmediatePropagation 拦截站点处理器（mousedown 不 preventDefault 由动态用例验证）');
ok(/resolveVideoContext\(target, event\)/.test(dragPreload) && /depth < 4/.test(dragPreload), '向上最多 4 层找视频上下文');
ok(/querySelector\('video'\)/.test(dragPreload) && /getBoundingClientRect\(\)/.test(dragPreload) && /x >= rect\.left && x <= rect\.right/.test(dragPreload), '祖先后代含 video 且 rect 包含点击点');
ok(/markDraggableEl\(ctx\.container\)/.test(dragPreload), '给视频覆盖容器也设 draggable');
ok(/lastPointerVideo = ctx\.video/.test(dragPreload) && /lastPointerAt = Date\.now\(\)/.test(dragPreload), '记录 lastPointerVideo / lastPointerAt');
ok(/Date\.now\(\) - lastPointerAt\) <= 5000/.test(dragPreload) && /media = lastPointerVideo/.test(dragPreload), 'dragstart 5s 内回退到 lastPointerVideo');
ok(/'novai:guest-pointer'/.test(dragPreload) && /targetTag: tagOf\(target\)/.test(dragPreload) && /foundVideo: Boolean\(ctx\.video\)/.test(dragPreload), 'guest-pointer 带 targetTag / foundVideo');
ok(/ipcMain\.on\('novai:guest-pointer'/.test(main), '主进程监听 novai:guest-pointer');
ok(/lastGuestPointerLogAt/.test(main) && /now - lastGuestPointerLogAt < 2000/.test(main), 'guest-pointer 日志每 2s 最多一条');
ok(/novai:guest-pointer'[\s\S]{0,400}event\.sender !== sourceView\.webContents/.test(main), 'guest-pointer 也校验 sender 是当前 view');
ok(/guest-pointer targetTag='/.test(main) && /foundVideo='/.test(main), 'guest-pointer 日志带 targetTag / foundVideo');

let videoSent = null;
let videoHandler = null;
let mouseHandler = null;
let videoSends = [];
let videoEl = null;
try {
    const makeVideoEl = function (tagName, attrs, extra) {
        const store = Object.assign({}, attrs || {});
        return {
            tagName: tagName,
            href: '',
            currentSrc: '',
            attrs: store,
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null; },
            setAttribute: function (name, value) { store[name] = String(value); },
            style: { props: {}, setProperty: function (name, value) { this.props[name] = String(value); } },
            querySelector: function () { return (extra && extra.down) || null; },
            querySelectorAll: function (selector) { return selector === 'source' ? ((extra && extra.sources) || []) : []; },
            closest: function () { return (extra && extra.anchor) || null; },
            parentElement: (extra && extra.parent) || null,
        };
    };
    const sourceEl = makeVideoEl('SOURCE', { src: 'https://sns-video.xhscdn.com/c.mp4' });
    videoEl = makeVideoEl('VIDEO', {
        'data-src': 'https://sns-video.xhscdn.com/a.mp4',
        'data-video-url': 'https://sns-video.xhscdn.com/b.mp4',
        poster: 'https://sns-img.xhscdn.com/p.jpg',
    }, { sources: [sourceEl] });
    videoEl.currentSrc = 'blob:https://www.xiaohongshu.com/abc';
    const fakeDocument = {
        title: '小红书',
        readyState: 'complete',
        documentElement: {},
        querySelectorAll: function (selector) { return selector === 'video' ? [videoEl] : []; },
        addEventListener: function (type, fn) {
            if (type === 'dragstart') videoHandler = fn;
            if (type === 'mousedown') mouseHandler = fn;
        },
    };
    const fakeRequire = function () {
        return { ipcRenderer: { send: function (channel, payload) {
            videoSent = { channel: channel, payload: payload };
            videoSends.push({ channel: channel, payload: payload });
        } } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://www.xiaohongshu.com/explore' });
} catch (_) {}
ok(videoEl && videoEl.attrs.draggable === 'true', '加载时把已有 <video> 设为 draggable');
ok(videoEl && videoEl.style && videoEl.style.props['-webkit-user-drag'] === 'element', '同时设置 -webkit-user-drag:element（真正允许拖拽）');
if (typeof videoHandler === 'function' && videoEl) {
    videoHandler({ target: videoEl, dataTransfer: { types: [], getData: function () { return ''; } } });
    const videoPayload = videoSent && videoSent.payload;
    ok(videoSent && videoSent.channel === 'novai:guest-drag', 'VIDEO 拖拽回传 novai:guest-drag');
    ok(videoPayload && videoPayload.tagName === 'VIDEO', 'VIDEO 分支采集 tagName');
    ok(videoPayload && videoPayload.videoUrls.indexOf('blob:https://www.xiaohongshu.com/abc') >= 0, 'videoUrls 保留 blob: 地址');
    ok(videoPayload && videoPayload.videoUrls.indexOf('https://sns-video.xhscdn.com/c.mp4') >= 0, 'videoUrls 含 <source src>');
    ok(videoPayload && videoPayload.videoUrls.indexOf('https://sns-video.xhscdn.com/a.mp4') >= 0 && videoPayload.videoUrls.indexOf('https://sns-video.xhscdn.com/b.mp4') >= 0, 'videoUrls 含 data-src / data-video-url');
    ok(videoPayload && videoPayload.mediaUrl === 'blob:https://www.xiaohongshu.com/abc', 'mediaUrl 优先 currentSrc（blob 原样保留）');
    ok(videoPayload && videoPayload.poster === 'https://sns-img.xhscdn.com/p.jpg' && videoPayload.videoUrls.indexOf(videoPayload.poster) < 0, 'poster 只作信息、不进视频媒体地址');
    ok(videoPayload && Array.isArray(videoPayload.videoCandidates) && videoPayload.videoCandidates.length === videoPayload.videoUrls.length, 'videoCandidates 与 videoUrls 一一对应');
    ok(videoPayload && videoPayload.url === videoPayload.mediaUrl, 'payload.url 与 mediaUrl 保持一致（兼容旧逻辑）');
}
ok(typeof mouseHandler === 'function', 'preload 注册了捕获阶段 mousedown');
if (typeof mouseHandler === 'function' && videoEl) {
    let stopped = 0;
    let prevented = 0;
    mouseHandler({ target: videoEl, stopImmediatePropagation: function () { stopped += 1; }, preventDefault: function () { prevented += 1; } });
    ok(stopped === 1, 'mousedown 命中 video 时 stopImmediatePropagation');
    ok(prevented === 0, 'mousedown 不调用 preventDefault（保留浏览器默认拖拽）');
    const pointers = videoSends.filter(item => item.channel === 'novai:guest-pointer');
    ok(pointers.length === 1, '发出 novai:guest-pointer 诊断');
    ok(pointers.length === 1 && pointers[0].payload.tag === 'VIDEO' && typeof pointers[0].payload.at === 'number', 'guest-pointer 带 tag / at');
    stopped = 0;
    prevented = 0;
    const divEl = { tagName: 'DIV', getAttribute: function () { return null; }, closest: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
    mouseHandler({ target: divEl, stopImmediatePropagation: function () { stopped += 1; }, preventDefault: function () { prevented += 1; } });
    ok(stopped === 0 && prevented === 0, '非 video target 不拦截');
}

console.log('[12c] pointerdown 视频上下文（覆盖层）与 dragstart 回退');
let pointerHandler = null;
let pointerDragHandler = null;
let pointerSends = [];
let pointerStopped = 0;
let pointerPrevented = 0;
try {
    const makeNode = function (tagName, attrs, extra) {
        const store = Object.assign({}, attrs || {});
        return {
            tagName: tagName,
            href: '',
            currentSrc: '',
            attrs: store,
            style: { props: {}, setProperty: function (name, value) { this.props[name] = String(value); } },
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null; },
            setAttribute: function (name, value) { store[name] = String(value); },
            querySelector: function (selector) { return (extra && extra.pick && extra.pick[selector]) || null; },
            querySelectorAll: function (selector) { return (extra && extra.pickAll && extra.pickAll[selector]) || []; },
            closest: function () { return (extra && extra.closest) || null; },
            parentElement: (extra && extra.parent) || null,
            getBoundingClientRect: function () { return (extra && extra.rect) || { left: 0, top: 0, right: 0, bottom: 0 }; },
        };
    };
    const videoNode = makeNode('VIDEO', {
        src: '',
        'data-src': 'https://sns-video.xhscdn.com/a.mp4',
        poster: 'https://sns-img.xhscdn.com/p.jpg',
    }, { pickAll: { source: [] }, closest: null });
    videoNode.currentSrc = 'blob:https://www.xiaohongshu.com/abc';
    const container = makeNode('DIV', {}, {
        pick: { video: videoNode },
        rect: { left: 0, top: 0, right: 500, bottom: 400 },
        parent: null,
    });
    const overlay = makeNode('DIV', {}, { parent: container, closest: null });
    const fakeDocument = {
        title: '小红书',
        querySelectorAll: function (selector) { return selector === 'video' ? [videoNode] : []; },
        addEventListener: function (type, fn) {
            if (type === 'dragstart') pointerDragHandler = fn;
            if (type === 'pointerdown') pointerHandler = fn;
        },
    };
    const fakeRequire = function () {
        return { ipcRenderer: { send: function (channel, payload) { pointerSends.push({ channel: channel, payload: payload }); } } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://www.xiaohongshu.com/explore' });
    pointerHandler({
        target: overlay,
        clientX: 250,
        clientY: 200,
        stopImmediatePropagation: function () { pointerStopped += 1; },
        preventDefault: function () { pointerPrevented += 1; },
    });
    const pointerEvent = pointerSends.filter(item => item.channel === 'novai:guest-pointer').pop();
    ok(pointerStopped === 1, 'pointerdown 命中覆盖层时 stopImmediatePropagation');
    ok(pointerPrevented === 0, 'pointerdown 不调用 preventDefault');
    ok(container.attrs.draggable === 'true' && container.style.props['-webkit-user-drag'] === 'element', '给覆盖容器设 draggable + -webkit-user-drag');
    ok(videoNode.attrs.draggable === 'true' && videoNode.style.props['-webkit-user-drag'] === 'element', 'video 本身也设 draggable');
    ok(pointerEvent && pointerEvent.payload.foundVideo === true && pointerEvent.payload.targetTag === 'DIV', 'guest-pointer 记录 targetTag / foundVideo=true');
    pointerDragHandler({ target: overlay, dataTransfer: { types: [], getData: function () { return ''; } } });
    const fallbackPayload = pointerSends.filter(item => item.channel === 'novai:guest-drag').pop();
    const fallback = fallbackPayload && fallbackPayload.payload;
    ok(fallback && fallback.tagName === 'VIDEO' && fallback.targetTag === 'DIV', 'dragstart target 是覆盖层时回退到 lastPointerVideo');
    ok(fallback && fallback.mediaUrl === 'blob:https://www.xiaohongshu.com/abc' && fallback.videoUrls.indexOf('blob:https://www.xiaohongshu.com/abc') >= 0, '回退后 mediaUrl / videoUrls 从视频采集');
    const plainDiv = makeNode('DIV', {}, { parent: null, closest: null });
    let plainStopped = 0;
    pointerHandler({ target: plainDiv, clientX: 1, clientY: 1, stopImmediatePropagation: function () { plainStopped += 1; }, preventDefault: function () {} });
    const plainEvent = pointerSends.filter(item => item.channel === 'novai:guest-pointer').pop();
    ok(plainStopped === 0 && plainEvent && plainEvent.payload.foundVideo === false, '非视频上下文不拦截且 foundVideo=false');
} catch (_) {}

console.log('[12d] watchVideos 在 documentElement 未就绪时不放弃');
ok(/document\.addEventListener\('DOMContentLoaded', watchVideos, \{ once: true \}\)/.test(dragPreload), 'loading 时等 DOMContentLoaded 再挂 observer');
ok(/VIDEO_WATCH_MAX_RETRIES/.test(dragPreload) && /videoWatchRetries < VIDEO_WATCH_MAX_RETRIES/.test(dragPreload), '非 loading 时短延时重试且最多几次');
ok(/setTimeout\(\(\) => \{ videoWatchScheduled = false; watchVideos\(\); \}, 50\)/.test(dragPreload), '50ms 后重试（有防重入标记）');
ok(/observer\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)[\s\S]{0,240}scanVideos\(document\)/.test(dragPreload), 'observer 挂上后立即再扫一次');
ok(/!document\.documentElement/.test(dragPreload), '先判断 documentElement 是否存在');
let domReadyHandler = null;
let domReadyVideos = [];
try {
    const makeDomVideo = function () {
        const store = {};
        return {
            tagName: 'VIDEO',
            attrs: store,
            style: { props: {}, setProperty: function (name, value) { this.props[name] = String(value); } },
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null; },
            setAttribute: function (name, value) { store[name] = String(value); },
        };
    };
    const domVideo = makeDomVideo();
    const fakeDocument = {
        title: '小红书',
        readyState: 'loading',
        documentElement: null,
        querySelectorAll: function (selector) { return selector === 'video' ? domReadyVideos : []; },
        addEventListener: function (type, fn) {
            if (type === 'DOMContentLoaded') domReadyHandler = fn;
        },
    };
    const fakeRequire = function () { return { ipcRenderer: { send: function () {} } }; };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://www.xiaohongshu.com/explore' });
    ok(typeof domReadyHandler === 'function', 'documentElement 为空且 loading 时注册 DOMContentLoaded');
    ok(domVideo.attrs.draggable === undefined, 'DOM 就绪前不会误标（此时还没有 DOM）');
    domReadyVideos = [domVideo];
    fakeDocument.documentElement = {};
    fakeDocument.readyState = 'interactive';
    domReadyHandler();
    ok(domVideo.attrs.draggable === 'true' && domVideo.style.props['-webkit-user-drag'] === 'element', 'DOMContentLoaded 后立即扫描并标记 video');
} catch (_) {}

console.log('[12e] 图片候选最高清优先 + 花瓣原图 + CDN 去缩略参数');
(function () {
    function makeImg(attrs, currentSrc) {
        const store = Object.assign({}, attrs || {});
        return {
            tagName: 'IMG',
            currentSrc: currentSrc || '',
            href: '',
            attrs: store,
            style: { props: {}, setProperty: function (n, v) { this.props[n] = String(v); } },
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null; },
            setAttribute: function (name, value) { store[name] = String(value); },
            closest: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            parentElement: null,
        };
    }
    function dragPayload(attrs, currentSrc) {
        let handler = null;
        let sent = null;
        const img = makeImg(attrs, currentSrc);
        const fakeDocument = {
            title: '花瓣',
            readyState: 'complete',
            documentElement: {},
            querySelectorAll: function () { return []; },
            addEventListener: function (type, fn) { if (type === 'dragstart') handler = fn; },
        };
        const fakeRequire = function () {
            return { ipcRenderer: { send: function (channel, payload) { sent = payload; } } };
        };
        new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://huaban.com/pins/1' });
        if (typeof handler === 'function') handler({ target: img, dataTransfer: { types: [], getData: function () { return ''; } } });
        return sent;
    }
    let payload = dragPayload({ srcset: 'https://img.example.com/a.jpg 1x, https://img.example.com/a-3x.jpg 3x', src: 'https://img.example.com/a-fallback.jpg' });
    ok(payload && payload.imageCandidates && payload.imageCandidates[0].url === 'https://img.example.com/a-3x.jpg', 'srcset 取 descriptor 最大项作为首选');
    ok(payload && payload.url === payload.mediaUrl && payload.mediaUrl === 'https://img.example.com/a-3x.jpg', '图片 mediaUrl/url 用最高清候选');
    ok(payload && payload.imageCandidates.some(function (item) { return item.url === 'https://img.example.com/a.jpg'; }), 'imageCandidates 保留其它 srcset 备选');
    ok(payload && payload.imageCandidates.every(function (item) { return typeof item.w === 'number'; }), 'imageCandidates 每项带 w');

    payload = dragPayload({ 'data-original': 'https://hbimg.huabanimg.com/abc_fw658.jpg', src: 'https://hbimg.huabanimg.com/abc_sq235.jpg' });
    ok(payload && payload.imageCandidates[0].url === 'https://hbimg.huabanimg.com/abc.jpg', '花瓣 _fw/_sq 后缀升级为原图且置顶');
    ok(payload && payload.imageCandidates[0].url.indexOf('_fw') < 0 && payload.imageCandidates[0].url.indexOf('_sq') < 0, '原图候选不含缩略后缀');

    payload = dragPayload({ src: 'https://hbimg.huabanimg.com/foo/236x/bar.jpg' });
    ok(payload && payload.imageCandidates[0].url === 'https://hbimg.huabanimg.com/foo/originals/bar.jpg', '花瓣 /236x/ 段替换为 /originals/ 且置顶');

    payload = dragPayload({ src: 'https://sns-img.xhscdn.com/a.jpg?imageView2/2/w/1080/quality/90' });
    const stripped = payload && payload.imageCandidates.filter(function (item) { return item.url.indexOf('imageView2') < 0; });
    ok(stripped && stripped.length > 0 && stripped[0].url.indexOf('?') < 0, '小红书缩略参数去参后作为候选');

    payload = dragPayload({ src: 'https://sns-img.xhscdn.com/b.jpg!h5' });
    ok(payload && payload.imageCandidates.some(function (item) { return item.url === 'https://sns-img.xhscdn.com/b.jpg'; }), '小红书 !h5 后缀去参候选');

    payload = dragPayload({ src: 'https://sns-webpic-qc.xhscdn.com/a!nd_dft_wlteh_webp_3' });
    ok(payload && payload.imageCandidates.some(function (item) { return item.url === 'https://sns-webpic-qc.xhscdn.com/a'; }), '小红书 webpic 缩略后缀去参候选');
})();

console.log('[14] 面板尺寸跟随 / 背景色 / 自定义来源');
ok(/view\.setBackgroundColor\('#0f0f0f'\)/.test(main), 'WebContentsView 设置深色背景避免缩放闪白');
ok(/rect \|\| lastSourceViewRect \|\| defaultSourceViewRect\(\)/.test(main), '重开面板复用上次尺寸（前端 rect 优先）');
ok(/action === 'setBounds'/.test(handleFn) && /sourceView\.setBounds\(layoutBounds\)/.test(main), '连续拖动 setBounds 直接应用');
ok(/bounds ' \+ JSON\.stringify\(bounds\)/.test(main), 'bounds 日志用于核对跟随');
const applyBoundsSrc = topLevelFunction(main, 'applySourceViewBounds');
const normRectSrc = topLevelFunction(main, 'normalizeSourceViewRect');
ok(!!applyBoundsSrc && !!normRectSrc, 'applySourceViewBounds / normalizeSourceViewRect 存在');
const appliedBounds = [];
const boundsLogs = [];
let boundsHarness = null;
try {
    boundsHarness = new Function(
        'sourceView', 'isSourceViewOpen', 'normalizeSourceViewRect', 'clog', 'initialRect', 'initialLogAt', 'sourceControlsFallback', 'SOURCE_CONTROLS_FALLBACK_HEIGHT',
        'let lastSourceViewRect = initialRect; let lastSourceBoundsLogAt = initialLogAt;' +
        'const apply = (' + applyBoundsSrc + ');' +
        'return { apply: apply, state: function () { return { rect: lastSourceViewRect, logAt: lastSourceBoundsLogAt }; } };'
    )(
        { setBounds: function (rect) { appliedBounds.push(rect); } },
        function () { return true; },
        new Function('return (' + normRectSrc + ')')(),
        function (area, msg) { boundsLogs.push(msg); },
        null, 0, false, 56
    );
} catch (_) {}
ok(!!boundsHarness, 'bounds 逻辑可独立执行');
if (boundsHarness) {
    for (let index = 0; index < 30; index += 1) {
        boundsHarness.apply({ x: index * 4, y: 10, width: 520 + index, height: 600 });
    }
    ok(appliedBounds.length === 30, '连续 30 次 setBounds 全部立即透传（无节流丢帧）');
    ok(appliedBounds[29] && appliedBounds[29].width === 549 && appliedBounds[29].x === 116, '最后一次 bounds 与输入一致（跟随不滞后）');
    ok(boundsHarness.state().rect && boundsHarness.state().rect.width === 549, 'lastSourceViewRect 记录上次尺寸');
    ok(boundsLogs.length >= 1 && boundsLogs.length <= 3, 'bounds 日志有输出且按 150ms 限流');
}
const normCustomSrc = topLevelFunction(main, 'normalizeCustomSourceUrl');
ok(!!normCustomSrc, 'normalizeCustomSourceUrl 存在');
let normCustom = null;
try { normCustom = new Function('URL', 'return (' + normCustomSrc + ')')(URL); } catch (_) {}
ok(typeof normCustom === 'function', 'normalizeCustomSourceUrl 可独立执行');
if (typeof normCustom === 'function') {
    ok(normCustom('http://example.com/a') === 'http://example.com/a', '自定义来源允许 http://');
    ok(normCustom('https://example.com/a?x=1') === 'https://example.com/a?x=1', '自定义来源允许 https://');
    ok(normCustom('file:///etc/passwd') === '' && normCustom('javascript:alert(1)') === '', '拒绝 file:// 与 javascript:');
}
ok(/CUSTOM_SOURCE_KEY = 'custom'/.test(main) && /requestedKey === CUSTOM_SOURCE_KEY/.test(main), 'open_source_view 支持 sourceKey:custom');
ok(/const isCustom = requestedKey === CUSTOM_SOURCE_KEY/.test(main) && /isAllowedWebviewUrl\(url\)/.test(main), '已知站点仍走白名单，自定义绕过');
const stateViewSrc = topLevelFunction(main, 'sourceViewState');
ok(/action === 'custom-urls'/.test(handleFn) && !!stateViewSrc && /recentCustomUrls/.test(stateViewSrc), '最近自定义 URL 可读');
ok(/slice\(0, CUSTOM_URL_LIMIT\)/.test(main), '自定义 URL 最多保留 5 条');
ok(/get_recent_custom_source_urls: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'custom-urls' \}\)/.test(preload), 'preload 暴露最近自定义 URL');
ok(/get_recent_custom_source_urls: function\(\)\{ return call\('source-view', \{action:'custom-urls'\}\); \}/.test(shim), 'shim 暴露最近自定义 URL');
ok(/open_source_view: \(source, rect\) => \{[\s\S]{0,260}typeof source === 'object'/.test(preload), 'preload open_source_view 支持对象参数');
ok(/typeof s === 'object'[\s\S]{0,120}Object\.assign\(\{action:'open'\}/.test(shim), 'iframe shim open_source_view 支持对象参数');

console.log('[15] 在线素材缩放（Ctrl/Cmd +/-/0）+ 右下角把手兜底');
ok(!/素材浏览器/.test(main + preload + dragPreload), '桌面端文案统一为「在线素材」');
ok(/SOURCE_ZOOM_MIN = 0\.5/.test(main) && /SOURCE_ZOOM_MAX = 3/.test(main) && /SOURCE_ZOOM_STEP = 1\.1/.test(main), '缩放范围 0.5~3、步进 1.1');
ok(/"source-zoom"/.test(handleFn) || /'source-zoom'/.test(handleFn), 'source-view 支持 source-zoom action');
ok(/ipcMain\.handle\('novai:source-zoom'/.test(main), '另有独立 novai:source-zoom 通道');
ok(/sourceView\.webContents\.setZoomFactor\(factor\)/.test(main), '主进程调用 setZoomFactor');
ok(/percent: percent/.test(main) && /zoomFactor: factor/.test(main), '返回 {ok, zoomFactor, percent}');
const stateViewSrc2 = topLevelFunction(main, 'sourceViewState');
ok(/zoomFactor: zoomFactor/.test(stateViewSrc2) && /zoomPercent: Math\.round\(zoomFactor \* 100\)/.test(stateViewSrc2), 'state 带 zoomFactor / zoomPercent');
const hideViewSrc = topLevelFunction(main, 'hideSourceView');
ok(/resetSourceZoom\(\)/.test(hideViewSrc), '关闭面板时缩放复位 100%');
ok(/before-input-event/.test(main) && /input\.control \|\| input\.meta/.test(main), 'before-input-event 监听 Ctrl/Cmd');
ok(/sourceView\.webContents\.isFocused\(\)/.test(main), '仅当焦点在内嵌 view 时响应快捷键');
ok(/event\.preventDefault\(\)/.test(main), '快捷键 preventDefault');
ok(/sourceBoundsReapplyTimer/.test(main) && /sourceBoundsReapplyTimer = setTimeout\([\s\S]{0,320}, 100\)/.test(main), 'setBounds 后 100ms 兜底重放');
ok(/set_source_zoom: \(mode, value\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'source-zoom', mode, value \}\)/.test(preload), 'preload 暴露 set_source_zoom');
ok(/set_source_zoom: function\(m, v\)\{ return call\('source-view', \{action:'source-zoom', mode: m, value: v\}\); \}/.test(shim), 'shim 暴露 set_source_zoom');

const zoomFnSrc = topLevelFunction(main, 'setSourceZoom');
const zoomKeySrc = topLevelFunction(main, 'sourceZoomKeyAction');
ok(!!zoomFnSrc && !!zoomKeySrc, 'setSourceZoom / sourceZoomKeyAction 存在');
let zoomHarness = null;
const zoomLogs = [];
try {
    const fakeWc = { factor: 1, getZoomFactor: function () { return this.factor; }, setZoomFactor: function (value) { this.factor = value; } };
    zoomHarness = new Function(
        'SOURCE_ZOOM_MIN', 'SOURCE_ZOOM_MAX', 'SOURCE_ZOOM_STEP', 'SOURCE_DEFAULT_ZOOM',
        'sourceView', 'isSourceViewAlive', 'isSourceViewOpen', 'sourceViewSource', 'clog', 'currentSourceZoom', 'sendSourceUiState',
        'return { set: (' + zoomFnSrc + ') };'
    )(0.5, 3, 1.1, 0.75, { webContents: fakeWc }, function () { return true; }, function () { return true; }, 'huaban', function (area, msg) { zoomLogs.push(msg); }, function () { return Number(fakeWc.getZoomFactor()) || 1; }, function () {});
} catch (_) {}
ok(!!zoomHarness, '缩放逻辑可独立执行');
if (zoomHarness) {
    let result = zoomHarness.set('reset');
    ok(result.ok && result.percent === 75 && result.zoomFactor === 0.75, 'reset → 75%（默认）');
    result = zoomHarness.set('in');
    ok(result.percent === 83, 'in → 83%');
    result = zoomHarness.set('in');
    ok(result.percent === 91, 'in → 91%');
    result = zoomHarness.set('out');
    ok(result.percent === 83, 'out → 83%');
    for (let index = 0; index < 20; index += 1) result = zoomHarness.set('in');
    ok(result.percent === 300, '连续放大封顶 300%');
    for (let index = 0; index < 40; index += 1) result = zoomHarness.set('out');
    ok(result.percent === 50, '连续缩小封底 50%');
    result = zoomHarness.set('set', 2.5);
    ok(result.percent === 250, 'set 2.5 → 250%');
    result = zoomHarness.set('set', 99);
    ok(result.percent === 300, 'set 越界收敛到 300%');
    result = zoomHarness.set('set', 0.01);
    ok(result.percent === 50, 'set 越界收敛到 50%');
    result = zoomHarness.set('bogus');
    ok(result.ok === false && /bad-zoom-action/.test(result.error), '非法缩放动作返回错误');
    ok(zoomLogs.some(function (msg) { return /zoom \d+%/.test(msg); }), '缩放命中写日志');
}
let zoomKeyFn = null;
try { zoomKeyFn = new Function('return (' + zoomKeySrc + ');')(); } catch (_) {}
ok(typeof zoomKeyFn === 'function', 'sourceZoomKeyAction 可独立执行');
if (typeof zoomKeyFn === 'function') {
    ok(zoomKeyFn({ key: '=', code: 'Equal' }) === 'in', "'=' → 放大");
    ok(zoomKeyFn({ key: '+' }) === 'in', "'+' → 放大");
    ok(zoomKeyFn({ key: '-', code: 'Minus' }) === 'out', "'-' → 缩小");
    ok(zoomKeyFn({ key: '0', code: 'Digit0' }) === 'reset', "'0' → 复位");
    ok(zoomKeyFn({ key: 'a', code: 'KeyA' }) === '', '其他键不处理');
}
const shortcutSrc = topLevelFunction(main, 'handleSourceZoomShortcut');
ok(!!shortcutSrc, 'handleSourceZoomShortcut 存在');
let shortcutHarness = null;
try {
    const focusedWc = { focused: true, isFocused: function () { return this.focused; } };
    const fakeView = { webContents: focusedWc };
    const fakeCounter = { value: 0 };
    shortcutHarness = new Function(
        'sourceView', 'isSourceViewAlive', 'isSourceViewOpen', 'sourceViewSource', 'clog',
        'sourceZoomKeyAction', 'setSourceZoom', 'counter',
        'return { handler: (' + shortcutSrc + '), wc: sourceView.webContents, calls: function () { return counter.value; } };'
    )(
        fakeView, function () { return true; }, function () { return true; }, 'huaban', function () {},
        function (input) { return zoomKeyFn(input); },
        function () { fakeCounter.value += 1; return { ok: true }; },
        fakeCounter
    );
} catch (_) {}
ok(!!shortcutHarness, '快捷键处理可独立执行');
if (shortcutHarness) {
    let prevented = 0;
    const event = { preventDefault: function () { prevented += 1; } };
    shortcutHarness.handler(event, { type: 'keyDown', key: '=', control: true });
    ok(prevented === 1 && shortcutHarness.calls() === 1, 'Ctrl/Cmd+= 拦截并缩放');
    prevented = 0;
    shortcutHarness.wc.focused = false;
    shortcutHarness.handler(event, { type: 'keyDown', key: '=', control: true });
    ok(prevented === 0 && shortcutHarness.calls() === 1, '焦点不在内嵌 view 时不拦截');
    shortcutHarness.wc.focused = true;
    prevented = 0;
    shortcutHarness.handler(event, { type: 'keyDown', key: '=', control: false });
    ok(prevented === 0 && shortcutHarness.calls() === 1, '没有 Ctrl/Cmd 修饰键不拦截');
}

console.log('[16] Pinterest/小红书图片可拖 + 背景图候选 + 导航 back/forward');
ok(/SOURCE_CONTROLS_CSS/.test(main) && /-webkit-user-drag: element !important/.test(main), '拖拽样式改由主进程 insertCSS 注入');
ok(/INSERT_CSS_PLACEHOLDER\(\)/.test('') || /wc\.insertCSS\(SOURCE_CONTROLS_CSS, \{ cssOrigin: 'user' \}\)/.test(main), 'insertCSS(user origin) 注入，不用 <style>');
ok(/'img, picture, \[style\*="background-image"\] \{ -webkit-user-drag: element !important; \}'/.test(main), '拖拽样式规则包含 img/picture/背景图');
ok(/attributeFilter: \['draggable', 'style', 'src', 'srcset', 'data-src', 'data-original'\]/.test(dragPreload), 'MutationObserver 监听新增节点与属性变化');
ok(/addEventListener\('load', function \(\) \{ markImageEl\(el\); \}\)/.test(dragPreload), '懒加载图片 load 后重新标记');
ok(/pinterestOriginalUrl/.test(dragPreload) && /\/originals\//.test(dragPreload) && /236x\|474x\|736x\|75x75/.test(dragPreload), 'Pinterest 尺寸段升级为 originals');
ok(/backgroundImageUrls/.test(dragPreload) && /findBackgroundMedia/.test(dragPreload) && /rect\.width > 120 && rect\.height > 120/.test(dragPreload), '背景图候选仅取 >120×120');
ok(/setData\('text\/uri-list', bestUrl\)/.test(dragPreload) && /setData\('text\/plain', bestUrl\)/.test(dragPreload) && /payload\.bestUrl = bestUrl/.test(dragPreload), 'dragstart 把最高清 URL 写进 dataTransfer（不 preventDefault）');

function makeFakeStyle(initial) {
    const props = Object.assign({}, initial || {});
    return {
        props: props,
        getPropertyValue: function (name) { return props[name] || ''; },
        removeProperty: function (name) { delete props[name]; },
        setProperty: function (name, value) { props[name] = String(value); },
        get backgroundImage() { return props.backgroundImage || ''; },
        set backgroundImage(value) { props.backgroundImage = String(value); },
    };
}
function makeFakeImg(attrs, styleProps) {
    const store = Object.assign({}, attrs || {});
    return {
        tagName: 'IMG',
        currentSrc: '',
        href: '',
        attrs: store,
        style: makeFakeStyle(styleProps),
        loadHandler: null,
        getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null; },
        setAttribute: function (name, value) { store[name] = String(value); },
        addEventListener: function (type, fn) { if (type === 'load') this.loadHandler = fn; },
        closest: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        parentElement: null,
    };
}
let markerStyle = null;
let markedImgs = [];
function bootPreload(images, extraNodes) {
    let dragHandler = null;
    const sent = [];
    const fakeDocument = {
        title: 'Pinterest',
        readyState: 'complete',
        documentElement: {},
        head: { appendChild: function () {} },
        getElementById: function () { return null; },
        createElement: function (tagName) {
            markerStyle = { tagName: tagName, id: '', textContent: '', appendChild: function () {} };
            return markerStyle;
        },
        elementFromPoint: function () { return fakeDocument.__pointElement || null; },
        querySelectorAll: function (selector) {
            if (String(selector).indexOf('background-image') >= 0) return (images || []).concat(extraNodes || []);
            if (String(selector).indexOf('img, picture') >= 0) return images || [];
            return [];
        },
        addEventListener: function (type, fn) {
            if (type === 'dragstart') dragHandler = fn;
        },
    };
    const fakeRequire = function () {
        return { ipcRenderer: { send: function (channel, payload) { if (channel === 'novai:guest-drag') sent.push(payload); } } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://www.pinterest.com/pin/1' });
    const transfers = [];
    return {
        drag: function (target, extras) {
            if (typeof dragHandler !== 'function') return;
            const dataTransfer = {
                types: [],
                data: {},
                setData: function (name, value) {
                    this.data[name] = String(value);
                    if (this.types.indexOf(name) < 0) this.types.push(name);
                },
                getData: function (name) { return this.data[name] || ''; },
            };
            const event = { target: target, dataTransfer: dataTransfer };
            Object.assign(event, extras || {});
            dragHandler(event);
            transfers.push(dataTransfer);
        },
        sent: sent,
        transfers: transfers,
        document: fakeDocument,
    };
}
let boot = null;
const initialImg = makeFakeImg({ draggable: 'false', src: 'https://i.pinimg.com/474x/aa/bb/cc.jpg' }, { '-webkit-user-drag': 'none' });
boot = bootPreload([initialImg], []);
markedImgs = [initialImg];
ok(initialImg.attrs.draggable === 'true', '遍历 img 把 draggable 设为 true');
ok(initialImg.style.props['-webkit-user-drag'] === 'element', '去掉内联 -webkit-user-drag:none 并设为 element');
ok(!/createElement\('style'\)/.test(dragPreload), '控件/拖拽样式不用 <style> 标签');
if (initialImg.loadHandler) {
    initialImg.attrs.draggable = 'false';
    initialImg.style.props['-webkit-user-drag'] = 'none';
    initialImg.loadHandler();
    ok(initialImg.attrs.draggable === 'true' && initialImg.style.props['-webkit-user-drag'] === 'element', 'load 事件后重新标记（懒加载）');
}
boot = bootPreload([initialImg], []);
let prevented = 0;
let stopped = 0;
boot.drag(initialImg, { preventDefault: function () { prevented += 1; }, stopPropagation: function () { stopped += 1; }, stopImmediatePropagation: function () {} });
const pinPayload = boot.sent[0];
const pinTransfer = boot.transfers[0];
ok(prevented === 0 && stopped === 1, 'img dragstart 不 preventDefault（原生拖拽能启动）');
ok(pinTransfer && pinTransfer.data['text/uri-list'] === 'https://i.pinimg.com/originals/aa/bb/cc.jpg' && pinTransfer.data['text/plain'] === 'https://i.pinimg.com/originals/aa/bb/cc.jpg', 'dataTransfer 写入最高清 URL（uri-list + text/plain）');
ok(pinPayload && pinPayload.imageCandidates && pinPayload.imageCandidates[0].url === 'https://i.pinimg.com/originals/aa/bb/cc.jpg', 'pinimg 原图作为 candidates[0]');
ok(pinPayload && pinPayload.imageCandidates.some(function (item) { return item.url === 'https://i.pinimg.com/474x/aa/bb/cc.jpg'; }), 'candidates 保留缩略图备选');
ok(pinPayload && pinPayload.url === pinPayload.mediaUrl && pinPayload.mediaUrl === pinPayload.imageCandidates[0].url, 'url/mediaUrl 指向最高清候选');

const innerImg = makeFakeImg({ src: 'https://i.pinimg.com/236x/dd/ee/ff.jpg' });
const anchor = {
    tagName: 'A',
    href: 'https://www.pinterest.com/pin/1/',
    attrs: {},
    style: makeFakeStyle({}),
    getAttribute: function () { return null; },
    querySelector: function (selector) { return selector === 'img, video' ? innerImg : null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    parentElement: null,
};
boot = bootPreload([], []);
boot.document.__pointElement = innerImg;
prevented = 0;
boot.drag(anchor, { clientX: 120, clientY: 240, preventDefault: function () { prevented += 1; }, stopPropagation: function () {} });
const linkPayload = boot.sent[0];
const linkTransfer = boot.transfers[0];
ok(prevented === 0 && linkPayload && linkPayload.imageCandidates[0].url === 'https://i.pinimg.com/originals/dd/ee/ff.jpg', '<a> 内图片不 preventDefault，按坐标命中原图回传');
ok(linkTransfer && linkTransfer.data['text/uri-list'] === 'https://i.pinimg.com/originals/dd/ee/ff.jpg', '<a> 内图片 dataTransfer 写入原图 URL');
ok(linkPayload && linkPayload.hitMethod === 'point' && linkPayload.sourceTag === 'IMG', 'payload 记录 hitMethod=point / sourceTag');

// 同一祖先里有多张图时，按 elementFromPoint 命中，而不是祖先里第一张
const wrongImg = makeFakeImg({ src: 'https://i.pinimg.com/474x/00/00/wrong.jpg' });
const rightImg = makeFakeImg({ src: 'https://i.pinimg.com/474x/11/11/right.jpg' });
boot = bootPreload([], []);
boot.document.__pointElement = rightImg;
boot.drag(anchor, { clientX: 50, clientY: 60, preventDefault: function () {}, stopPropagation: function () {} });
const rightPayload = boot.sent[0];
ok(rightPayload && rightPayload.imageCandidates[0].url === 'https://i.pinimg.com/originals/11/11/right.jpg', '坐标命中哪张就拖哪张（不抓祖先第一张）');
ok(wrongImg && rightImg, '两张候选图构造完成');

// background-image 卡片：>120×120 也要标 draggable + -webkit-user-drag
function makeFakeBg(url) {
    const store = {};
    return {
        tagName: 'DIV',
        attrs: store,
        style: Object.assign(makeFakeStyle({ backgroundImage: 'url("' + url + '")' }), {}),
        getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null; },
        setAttribute: function (name, value) { store[name] = String(value); },
        getBoundingClientRect: function () { return { width: 220, height: 180, left: 0, right: 220, top: 0, bottom: 180 }; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        closest: function () { return null; },
        addEventListener: function () {},
        parentElement: null,
    };
}
const bgCard = makeFakeBg('https://i.pinimg.com/736x/22/33/44.jpg');
boot = bootPreload([], [bgCard]);
ok(bgCard.attrs.draggable === 'true' && bgCard.style.props['-webkit-user-drag'] === 'element', 'background-image 大卡片也标 draggable/-webkit-user-drag');
boot.document.__pointElement = bgCard;
boot.drag({ tagName: 'DIV', parentElement: null, getAttribute: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, style: makeFakeStyle({}) }, { clientX: 40, clientY: 60, preventDefault: function () {} });
const bgCardPayload = boot.sent[0];
ok(bgCardPayload && bgCardPayload.hitMethod === 'background-point' && bgCardPayload.imageCandidates[0].url === 'https://i.pinimg.com/originals/22/33/44.jpg', '背景图卡片按坐标命中并升级原图');

const bgStyle = makeFakeStyle({ backgroundImage: 'url("https://i.pinimg.com/736x/11/22/33.jpg")' });
const bgDiv = {
    tagName: 'DIV',
    style: bgStyle,
    getAttribute: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    getBoundingClientRect: function () { return { width: 220, height: 180 }; },
    parentElement: null,
};
boot = bootPreload([], []);
boot.drag(bgDiv, { preventDefault: function () {} });
const bgPayload = boot.sent[0];
ok(bgPayload && bgPayload.imageCandidates[0].url === 'https://i.pinimg.com/originals/11/22/33.jpg', '背景图 url() 解析并升级为原图候选');
const smallBg = Object.assign({}, bgDiv, { getBoundingClientRect: function () { return { width: 80, height: 80 }; } });
boot = bootPreload([], []);
boot.drag(smallBg, { preventDefault: function () {} });
ok(boot.sent.length === 1 && boot.sent[0].imageCandidates.length === 0, '小尺寸背景图（<120×120）不作为候选');

const histSrc = topLevelFunction(main, 'sourceHistoryState');
const navSrc = topLevelFunction(main, 'navigateSourceView');
ok(!!histSrc && !!navSrc, 'sourceHistoryState / navigateSourceView 存在');
const navCalls = { back: 0, forward: 0, reload: 0 };
const fakeNavView = {
    webContents: {
        navigationHistory: {
            canGoBack: function () { return true; },
            canGoForward: function () { return false; },
            goBack: function () { navCalls.back += 1; },
            goForward: function () { navCalls.forward += 1; },
        },
        reload: function () { navCalls.reload += 1; },
    },
};
const histHarness = new Function('sourceView', 'isSourceViewAlive', 'return (' + histSrc + ')')(fakeNavView, function () { return true; });
const navHarness = new Function('sourceView', 'isSourceViewAlive', 'isSourceViewOpen', 'sourceViewSource', 'sourceHistoryState', 'sendSourceUiState', 'return (' + navSrc + ')')(fakeNavView, function () { return true; }, function () { return true; }, 'pinterest', histHarness, function () {});
const navBack = navHarness('back');
const navForward = navHarness('forward');
const navReload = navHarness('reload');
const navBad = navHarness('bogus');
ok(navBack.ok && navCalls.back === 1 && navBack.canGoBack === true && navBack.canGoForward === false, 'navigationHistory.goBack + canGoBack 状态');
ok(navForward.ok && navCalls.forward === 1, 'navigationHistory.goForward');
ok(navReload.ok && navCalls.reload === 1, 'reload');
ok(navBad.ok === false && /bad-nav-action/.test(navBad.error), '非法导航动作返回错误');
const legacyCalls = { back: 0 };
const legacyView = {
    webContents: {
        canGoBack: function () { return true; },
        canGoForward: function () { return false; },
        goBack: function () { legacyCalls.back += 1; },
        goForward: function () {},
    },
};
const legacyHist = new Function('sourceView', 'isSourceViewAlive', 'return (' + histSrc + ')')(legacyView, function () { return true; });
const legacyNav = new Function('sourceView', 'isSourceViewAlive', 'isSourceViewOpen', 'sourceViewSource', 'sourceHistoryState', 'sendSourceUiState', 'return (' + navSrc + ')')(legacyView, function () { return true; }, function () { return true; }, 'pinterest', legacyHist, function () {});
ok(legacyNav('back').ok && legacyCalls.back === 1, '无 navigationHistory 时回退 canGoBack/goBack');
ok(/action === 'source-nav'/.test(handleFn), 'source-view 支持 source-nav action');
ok(/ipcMain\.handle\('novai:source-nav'/.test(main), '独立 novai:source-nav 通道');
ok(/canGoBack: history\.canGoBack/.test(stateViewSrc2) && /canGoForward: history\.canGoForward/.test(stateViewSrc2), 'state 返回 canGoBack/canGoForward');
ok(/source_go_back: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'source-nav', nav: 'back' \}\)/.test(preload), 'preload 暴露 source_go_back');
ok(/source_go_forward: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'source-nav', nav: 'forward' \}\)/.test(preload), 'preload 暴露 source_go_forward');
ok(/source_reload: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'source-nav', nav: 'reload' \}\)/.test(preload), 'preload 暴露 source_reload');
ok(/source_go_back: function\(\)\{ return call\('source-view', \{action:'source-nav', nav:'back'\}\); \}/.test(shim), 'shim 暴露 source_go_back');
ok(/source_go_forward: function\(\)\{ return call\('source-view', \{action:'source-nav', nav:'forward'\}\); \}/.test(shim), 'shim 暴露 source_go_forward');
ok(/source_reload: function\(\)\{ return call\('source-view', \{action:'source-nav', nav:'reload'\}\); \}/.test(shim), 'shim 暴露 source_reload');

console.log('[17] macOS 双指滑动返回/前进（wheel + 原生 swipe 去抖）');
ok(/SWIPE_THRESHOLD = 120/.test(dragPreload), '触发阈值 120');
ok(/SWIPE_DECAY_MS = 200/.test(dragPreload), '200ms 衰减窗口');
ok(/SWIPE_COOLDOWN_MS = 300/.test(dragPreload), '300ms 冷却去抖');
ok(/addEventListener\('wheel', handleWheel, \{ passive: false, capture: true \}\)/.test(dragPreload), 'wheel 监听 passive:false + capture:true');
ok(/Math\.abs\(deltaX\) > Math\.abs\(deltaY \|\| 0\)/.test(dragPreload) || /Math\.abs\(deltaX\) <= Math\.abs\(deltaY \|\| 0\)/.test(dragPreload), '只处理横向位移（|dx|>|dy|）');
ok(/isInHorizontalScroller/.test(dragPreload) && /scrollWidth > clientWidth \+ 2/.test(dragPreload), '横向滚动容器内不拦截');
ok(/ipcRenderer\.send\('novai:guest-swipe', \{ direction: direction, at: now \}\)/.test(dragPreload), '发送 novai:guest-swipe IPC');
ok(/handleSourceSwipe/.test(main) && /SOURCE_SWIPE_DEBOUNCE_MS = 300/.test(main), 'main 侧 300ms 去抖');
ok(/wc\.on\('swipe'/.test(main) && /navigationHistory/.test(main), '接原生 swipe → navigationHistory');
ok(/ipcMain\.on\('novai:guest-swipe'/.test(main), 'main 监听 novai:guest-swipe');
ok(/direction === 'right' \? 'back' : direction === 'left' \? 'forward' : ''/.test(main), 'native swipe right=back / left=forward');

let wheelHandler = null;
let swipeSent = [];
let wheelPrevented = 0;
const wheelDocument = {
    title: 'Pinterest',
    readyState: 'complete',
    documentElement: {},
    head: { appendChild: function () {} },
    getElementById: function () { return null; },
    createElement: function () { return { id: '', textContent: '', appendChild: function () {} }; },
    querySelectorAll: function () { return []; },
    addEventListener: function (type, fn) { if (type === 'wheel') wheelHandler = fn; },
};
try {
    const fakeRequire = function () {
        return { ipcRenderer: { send: function (channel, payload) { if (channel === 'novai:guest-swipe') swipeSent.push(payload); } } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, wheelDocument, { href: 'https://www.pinterest.com/' });
} catch (_) {}
ok(typeof wheelHandler === 'function', 'wheel 监听已注册');
const realNow = Date.now;
let fakeNow = 100000;
let wheelTestsOk = true;
try {
    Date.now = function () { return fakeNow; };
    function emitWheel(deltaX, deltaY, target) {
        wheelHandler({
            deltaX: deltaX,
            deltaY: deltaY || 0,
            target: target || { parentElement: null },
            preventDefault: function () { wheelPrevented += 1; },
        });
    }
    for (let index = 0; index < 5; index += 1) { emitWheel(30, 1); fakeNow += 10; }
    ok(swipeSent.length === 1 && swipeSent[0].direction === 'back', '右滑累积 >120 → back 触发一次');
    ok(wheelPrevented >= 1, '触发时 preventDefault 阻止页面 overscroll');
    emitWheel(150, 1);
    ok(swipeSent.length === 1, '冷却期内不重复触发（去抖）');
    fakeNow += 400;
    for (let index = 0; index < 5; index += 1) { emitWheel(-30, 1); fakeNow += 10; }
    ok(swipeSent.length === 2 && swipeSent[1].direction === 'forward', '左滑累积 → forward 触发');
    fakeNow += 400;
    emitWheel(200, 1, { scrollWidth: 800, clientWidth: 400, scrollLeft: 100, parentElement: null });
    ok(swipeSent.length === 2, '横向可滚容器内不拦截');
    fakeNow += 400;
    emitWheel(100, 1);
    fakeNow += 250; // 超过 200ms 衰减窗口
    emitWheel(100, 1);
    ok(swipeSent.length === 2, '200ms 衰减后累积清零，不误触发');
    fakeNow += 400;
    emitWheel(300, 400);
    ok(swipeSent.length === 2, '纵向滚动不触发');
    emitWheel(1, 0);
    ok(swipeSent.length === 2, '微小横向位移不触发');
} catch (_) {
    wheelTestsOk = false;
} finally {
    Date.now = realNow;
}
ok(wheelTestsOk, 'wheel 序列测试执行成功');

const swipeFnSrc = topLevelFunction(main, 'handleSourceSwipe');
ok(!!swipeFnSrc, 'handleSourceSwipe 存在');
let swipeHarness = null;
try {
    swipeHarness = new Function(
        'navigateSourceView', 'initialAt', 'SOURCE_SWIPE_DEBOUNCE_MS',
        'return (function(){ let lastSourceSwipeAt = initialAt; return (' + swipeFnSrc + '); })();'
    )(function (action) { navActions.push(action); return { ok: true, action: action }; }, 0, 300);
} catch (_) {}
const navActions = [];
ok(!!swipeHarness, 'handleSourceSwipe 可独立执行');
if (swipeHarness) {
    const realNow2 = Date.now;
    let swipeNow = 500000;
    try {
        Date.now = function () { return swipeNow; };
        const first = swipeHarness('back');
        const afterFirst = navActions.length;
        const second = swipeHarness('forward');
        const afterSecond = navActions.length;
        swipeNow += 301;
        const third = swipeHarness('forward');
        const afterThird = navActions.length;
        swipeNow += 301;
        const bad = swipeHarness('up');
        ok(first.ok && first.action === 'back' && afterFirst === 1, '首次 swipe → back');
        ok(second.ok === false && second.debounced === true && afterSecond === 1, '300ms 内第二次被去抖');
        ok(third.ok && third.action === 'forward' && afterThird === 2, '超过 300ms 后可再次触发');
        ok(bad.ok === false && /bad-swipe-direction/.test(bad.error), '非法方向返回错误');
    } finally {
        Date.now = realNow2;
    }
}

console.log('[18] 注入式悬浮控件：默认隐藏 + 悬停唤起 + 深浅主题');
ok(/const SOURCE_INJECTED_CONTROLS = process\.env\.NOVAI_INJECTED_SOURCE_CONTROLS !== '0'/.test(main), '主进程开关默认开启（设 0 可关）');
ok(/const INJECTED_CONTROLS_ENABLED = true;/.test(dragPreload), 'guest preload 开关默认 true');
ok(/\[data-visible="true"\] \{ opacity: 1 !important; visibility: visible !important; \}/.test(main), '显示态 data-visible=true → opacity 1 / visible');
ok(/opacity: 0; visibility: hidden; transition: opacity \.2s ease, visibility \.2s ease !important/.test(main), '默认 opacity:0 / visibility:hidden（200ms 过渡）');
ok(/\[data-visible="false"\] \.novai-controls-btn, #novai-source-controls\[data-visible="false"\] \.novai-site-item \{ pointer-events: none !important; \}/.test(main), '隐藏时 pointer-events:none，不影响页面点击');
ok(/CONTROLS_BOTTOM_ZONE = 96/.test(dragPreload) && !/CONTROLS_TOP_ZONE/.test(dragPreload), '唤醒热区仅底部 96px（顶部热区已去掉）');
ok(/novai-controls-bottom/.test(main) && /flex-direction: row !important/.test(main), '底部一行布局 CSS');
ok(/bottom: 16px !important/.test(main) && /height: 38px !important/.test(main) && /max-width: calc\(100vw - 24px\) !important/.test(main), '贴底 16px、高 38、限宽不溢出');
ok(/width: 27px !important; height: 27px !important/.test(main), '按钮 27px');
ok(/#novai-source-controls \.novai-site-item \{[^}]*font-size: 12px !important/.test(main) && /height: 26px !important/.test(main), '站点项 26px / 12px');
ok(!/novai-controls-left \{ top: 14px/.test(main) && !/novai-controls-right \{ top: 14px/.test(main), '去掉顶部两组控件定位');
ok(/CONTROLS_HIDE_DELAY = 1500/.test(dragPreload) && /scheduleControlsHide/.test(dragPreload), '离开后 1500ms 淡出');
ok(/pointerInControls/.test(dragPreload) && /querySelectorAll\('\.novai-controls-group, \.novai-controls-site-wrap, \.novai-controls-url'\)/.test(dragPreload), '指针进入控件区域保持显示（含 URL 输入行）');
ok(/document\.addEventListener\('mousemove', handleControlsHover, true\)/.test(dragPreload), 'mousemove capture:true');
ok(/background: rgba\(20, 20, 20, 0\.72\) !important/.test(main) && /color: #ffffff !important/.test(main), '深色：rgba(20,20,20,.72) + 白图标');
ok(/rgb\(250, 250, 250, 0\.88\)|rgba\(250, 250, 250, 0\.88\)/.test(main) && /data-theme="light"/.test(main), '浅色：白玻璃 + 深色图标分支');
ok(/data-theme="light"\] \.novai-zoom-value \{ color: #111111 !important; \}/.test(main), '浅色缩放下百分比 #111');
ok(/\[data-theme="light"\] \.novai-site-item\[data-active="true"\]/.test(main), '浅色选中站点高亮');
ok(/--novai-ui-compensate/.test(dragPreload) && /100 \/ Number\(controlsState\.zoomPercent\)/.test(dragPreload), 'zoom 补偿保留');
ok(/action: 'site', site: site/.test(dragPreload) && /control === 'back' \|\| control === 'forward' \|\| control === 'refresh' \|\| control === 'close'/.test(dragPreload), '切站/关闭 IPC 不变');
ok(/host\.setAttribute\('data-visible', 'false'\)/.test(dragPreload), 'buildControls 默认隐藏');
let injected = null;
try {
    function makeEl(tagName) {
        const el = {
            tagName: String(tagName || 'div').toUpperCase(),
            id: '', className: '', textContent: '', innerHTML: '',
            children: [], attrs: {},
            style: { props: {}, setProperty: function (name, value) { this.props[name] = String(value); } },
            clickHandler: null, _label: null,
            setAttribute: function (name, value) { this.attrs[name] = String(value); },
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
            appendChild: function (child) { this.children.push(child); child.parentElement = this; return child; },
            addEventListener: function (type, fn) { if (type === 'click') this.clickHandler = fn; },
            querySelector: function (selector) {
                if (selector === '.novai-zoom-value') { if (!this._label) this._label = { textContent: '' }; return this._label; }
                return null;
            },
            querySelectorAll: function () { return []; },
            closest: function (selector) {
                if (selector === '[data-site]' && this.getAttribute && this.getAttribute('data-site')) return this;
                if (selector === '[data-novai-control]' && this.getAttribute && this.getAttribute('data-novai-control')) return this;
                return null;
            },
            getBoundingClientRect: function () { return { left: 0, right: 0, top: 0, bottom: 0 }; },
            parentElement: null,
        };
        return el;
    }
    const fakeBody = makeEl('body');
    const fakeHandlers = {};
    const fakeSends = [];
    const fakeDocument = {
        title: 'Pinterest', readyState: 'complete',
        documentElement: Object.assign(makeEl('html'), { clientHeight: 800 }),
        body: fakeBody, head: makeEl('head'),
        createElement: makeEl,
        getElementById: function (id) {
            function find(el) {
                if (el.id === id) return el;
                for (let index = 0; index < (el.children || []).length; index += 1) {
                    const hit = find(el.children[index]);
                    if (hit) return hit;
                }
                return null;
            }
            return find(fakeBody);
        },
        querySelectorAll: function () { return []; },
        addEventListener: function (type, fn) { fakeHandlers[type] = fn; },
    };
    const fakeRequire = function () {
        return { ipcRenderer: {
            send: function (channel, payload) { fakeSends.push({ channel: channel, payload: payload }); },
            on: function (channel, fn) { fakeHandlers[channel] = fn; },
        } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://www.pinterest.com/' });
    injected = {
        host: fakeDocument.getElementById('novai-source-controls'),
        handlers: fakeHandlers,
        sends: fakeSends,
    };
} catch (_) {}
ok(injected && injected.host, '默认开启时注入 #novai-source-controls');
if (injected && injected.host) {
    const host = injected.host;
    ok(host.getAttribute('data-visible') === 'false', '初始 data-visible=false（默认隐藏）');
    ok(host.getAttribute('data-theme') === 'dark', '默认深色主题');
    const all = [];
    (function walk(el) { all.push(el); (el.children || []).forEach(walk); })(host);
    const controls = all.map(function (el) { return el.getAttribute ? el.getAttribute('data-novai-control') : null; }).filter(Boolean);
    ok(controls.indexOf('back') >= 0 && controls.indexOf('zoom-reset') >= 0 && controls.indexOf('close') >= 0, '三组控件 DOM 仍在');
    const siteItems = all.filter(function (el) { return el.getAttribute && el.getAttribute('data-site'); });
    ok(siteItems.length === 4, '站点 pill 4 项仍在');
    const hoverHandler = injected.handlers['mousemove'];
    if (typeof hoverHandler === 'function') {
        hoverHandler({ clientX: 200, clientY: 20 });
        ok(host.getAttribute('data-visible') === 'false', '顶部区域不再唤起（按钮已移到底部）');
        hoverHandler({ clientX: 300, clientY: 780 });
        ok(host.getAttribute('data-visible') === 'true', '指针进入底部 96px → 显示');
        hoverHandler({ clientX: 600, clientY: 400 });
        ok(host.getAttribute('data-visible') === 'true', '离开后 1.5s 内仍显示（等待淡出）');
    }
    const stateHandler = injected.handlers['novai:source-ui-state'];
    if (typeof stateHandler === 'function') {
        stateHandler({}, { theme: 'light', site: 'huaban', zoomPercent: 200, canGoBack: true, canGoForward: false });
        ok(host.getAttribute('data-theme') === 'light', '主题切到浅色 data-theme=light');
        ok(host.style.props['--novai-ui-compensate'] === '0.5', 'zoom 200% 时 1/zoom 补偿');
        const activeSite = all.filter(function (el) { return el.getAttribute && el.getAttribute('data-site') === 'huaban'; })[0];
        ok(activeSite && activeSite.getAttribute('data-active') === 'true', '当前站点高亮');
        const backBtn = all.filter(function (el) { return el.getAttribute && el.getAttribute('data-novai-control') === 'back'; })[0];
        ok(backBtn && backBtn.disabled === false, 'canGoBack=true 后退可用');
    }
    const huabanItem = siteItems.filter(function (el) { return el.getAttribute('data-site') === 'huaban'; })[0];
    if (host.clickHandler && huabanItem) {
        host.clickHandler({ target: huabanItem, stopPropagation: function () {}, preventDefault: function () {} });
        const sentSite = injected.sends.filter(function (item) { return item.channel === 'novai:guest-control'; }).pop();
        ok(sentSite && sentSite.payload.action === 'site' && sentSite.payload.site === 'huaban', '点站点 item 直接发对应 site');
    }
    // 自定义站点：点 pill → 弹出 URL 输入行 → 预填/校验/IPC
    const urlRow = all.filter(function (el) { return el.className && String(el.className).indexOf('novai-controls-url') >= 0; })[0];
    const urlInput = all.filter(function (el) { return el.className && String(el.className).indexOf('novai-url-input') >= 0; })[0];
    const urlError = all.filter(function (el) { return el.className && String(el.className).indexOf('novai-url-error') >= 0; })[0];
    const urlButtons = all.filter(function (el) { return el.className && String(el.className).indexOf('novai-url-btn') >= 0; });
    ok(urlRow && urlInput && urlError && urlButtons.length === 2, 'URL 输入行 DOM（输入框 + 打开/取消 + 错误提示）');
    if (urlRow && urlInput && urlError && urlButtons.length === 2 && host.clickHandler) {
        if (typeof stateHandler === 'function') stateHandler({}, { recentCustomUrls: ['https://old.example.com'] });
        const customItem = siteItems.filter(function (el) { return el.getAttribute('data-site') === 'custom'; })[0];
        const siteSendsBefore = injected.sends.filter(function (item) { return item.channel === 'novai:guest-control' && item.payload.action === 'site'; }).length;
        host.clickHandler({ target: customItem, stopPropagation: function () {}, preventDefault: function () {} });
        ok(urlRow.getAttribute('data-open') === 'true', '点「自定义」→ 输入行弹出');
        ok(urlInput.value === 'https://old.example.com', '输入框预填上次自定义 URL');
        urlInput.value = 'abc';
        urlButtons[0].clickHandler({ stopPropagation: function () {}, preventDefault: function () {} });
        ok(urlError.getAttribute('data-show') === 'true', '非法地址显示「地址无效」');
        ok(injected.sends.filter(function (item) { return item.channel === 'novai:guest-control' && item.payload.action === 'site'; }).length === siteSendsBefore, '非法地址不切换站点');
        host.clickHandler({ target: customItem, stopPropagation: function () {}, preventDefault: function () {} });
        urlInput.value = 'https://www.baidu.com';
        urlButtons[0].clickHandler({ stopPropagation: function () {}, preventDefault: function () {} });
        const customSends = injected.sends.filter(function (item) { return item.channel === 'novai:guest-control' && item.payload.action === 'site' && item.payload.site === 'custom'; });
        const lastCustom = customSends[customSends.length - 1];
        ok(lastCustom && lastCustom.payload.url === 'https://www.baidu.com', '合法 URL 发 site=custom+url');
        ok(urlRow.getAttribute('data-open') === 'false', '提交后输入行收起');
        urlButtons[1].clickHandler({ stopPropagation: function () {}, preventDefault: function () {} });
        ok(urlRow.getAttribute('data-open') === 'false', '取消后输入行收起且不切站');
    }
}

console.log('[22] 自定义站点 URL 输入行（静态）');
ok(/novai-controls-url/.test(dragPreload) && /novai-url-input/.test(dragPreload) && /novai-url-btn/.test(dragPreload) && /novai-url-error/.test(dragPreload), '注入 URL 输入行 DOM');
ok(/输入网址（https:\/\/\.\.\.）/.test(dragPreload) || /输入网址（https:\/\//.test(dragPreload), '输入框 placeholder 提示 https://');
ok(/function isValidCustomUrl/.test(dragPreload) && /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/.test(dragPreload), '只接受 http(s) 地址');
ok(/action: 'site', site: 'custom', url: value/.test(dragPreload), '合法后 IPC 发 site=custom+url');
ok(/if \(site === 'custom'\) \{[\s\S]{0,80}showCustomUrlInput\(\)/.test(dragPreload), '点自定义弹出输入行（不直接切站）');
ok(/controlsState\.recentCustomUrls/.test(dragPreload) && /urlInput\.value = preset/.test(dragPreload), '用最近自定义 URL 预填');
ok(/recentCustomUrls: lastCustomSourceUrls\.slice\(0, 5\)/.test(main), 'state 把最近自定义 URL 发给 guest');
ok(/const explicitUrl = normalizeCustomSourceUrl\(payload && payload\.url\)/.test(main), 'guest-control site 支持 payload.url');
ok(/if \(site === 'custom'\) \{[\s\S]{0,220}openSourceView\('custom'[\s\S]{0,120}url: explicitUrl/.test(main), 'source-site 支持 payload.url 并打开自定义地址');
ok(/novai-controls-url[^}]*width: 300px/.test(main) && /font-size: 13px/.test(main) && /border-radius: 12px/.test(main), '输入行宽 300 / 圆角 12 / 字号 13');

console.log('[18b] 关闭链路（内嵌控件 ×）与站点 pill 代码保留');
ok(/clog\('source-view', '关闭面板（来自内嵌控件）'\)/.test(main), '关闭控件点击写日志');
ok(/const closedState = sourceViewState\(\)/.test(main) && /'novai:source-view-closed', closedState/.test(main), '关闭发送 novai:source-view-closed（payload=sourceViewState）');
ok(/on_source_view_closed/.test(preload) && /novai:source-view-closed/.test(preload), 'preload 暴露关闭事件订阅');
ok(/action === 'source-close'/.test(handleFn) && /\{ ok: true, open: false, source: null, state: closedState \}/.test(handleFn), 'source-close 返回 open:false + state');
ok(/site === 'custom'/.test(main) && /lastCustomSourceUrls\[0\]/.test(main), 'custom pill 切到上次自定义地址');
ok(/novai:source-custom-request/.test(main) && /on_source_custom_request/.test(preload), '没有历史自定义地址时通知画布弹输入');
ok(/data-site/.test(dragPreload) && /action: 'site', site: site/.test(dragPreload), 'pill item 直接发被点击的 site（代码保留）');
ok(!/nextSite\(/.test(dragPreload), '不再循环切站');
ok(/data-active/.test(main) && /novai-site-active/.test(main), 'CSS 支持当前站点高亮（保留）');

console.log('[18c] 关闭/自定义站点事件 → iframe 桥转发');
ok(/function forwardSourceEvent\(ipcChannel, messageType\)/.test(preload), 'preload 定义通用事件转发函数');
ok(/forwardSourceEvent\('novai:source-view-closed', 'novai:source-view-close'\)/.test(preload), '转发 source-view-closed → novai:source-view-close');
ok(/forwardSourceEvent\('novai:source-custom-request', 'novai:source-custom-request'\)/.test(preload), '转发 source-custom-request');
ok(/window\.dispatchEvent\(new CustomEvent\(messageType, \{ detail: payload \}\)\)/.test(preload), '主 frame 同时派发 CustomEvent');
ok(/querySelectorAll\('iframe'\)/.test(preload) && /frameWindow\.postMessage\(\{ type: messageType, payload: payload \}, '\*'\)/.test(preload), '遍历所有 iframe postMessage 广播');
ok(/e\.data\.type\.indexOf\('novai:source-'\) !== 0/.test(shim), 'shim 只透传 novai:source-* 被动事件');
ok(/document\.dispatchEvent\(new CustomEvent\(e\.data\.type, \{ detail: e\.data\.payload \}\)\)/.test(shim), 'shim 转成 document CustomEvent');
const forwardSrc = (preload.match(/function forwardSourceEvent\([\s\S]*?\n\}/) || [''])[0];
ok(!!forwardSrc, 'forwardSourceEvent 源码可抽取');
let forwardHarness = null;
try {
    const ipcHandlers = {};
    const windowEvents = [];
    const framePosts = [];
    const fakeWindow = { dispatchEvent: function (event) { windowEvents.push(event); } };
    const fakeFrame = { contentWindow: { postMessage: function (message, origin) { framePosts.push({ message: message, origin: origin }); } } };
    const fakeDocument = { querySelectorAll: function (selector) { return selector === 'iframe' ? [fakeFrame, fakeFrame] : []; } };
    class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    const forwardFn = new Function('ipcRenderer', 'window', 'document', 'CustomEvent', 'return (' + forwardSrc + ');')(
        { on: function (channel, handler) { ipcHandlers[channel] = handler; } },
        fakeWindow,
        fakeDocument,
        FakeCustomEvent
    );
    forwardFn('novai:source-view-closed', 'novai:source-view-close');
    forwardFn('novai:source-custom-request', 'novai:source-custom-request');
    if (typeof ipcHandlers['novai:source-view-closed'] === 'function') {
        ipcHandlers['novai:source-view-closed']({}, { open: false, source: null });
    }
    forwardHarness = { windowEvents: windowEvents, framePosts: framePosts, ipcHandlers: ipcHandlers };
} catch (_) {}
ok(forwardHarness && forwardHarness.windowEvents.length === 1 && forwardHarness.windowEvents[0].type === 'novai:source-view-close' && forwardHarness.windowEvents[0].detail.open === false, '主 frame 收到关闭 IPC 后派发 CustomEvent');
ok(forwardHarness && forwardHarness.framePosts.length === 2 && forwardHarness.framePosts[0].message.type === 'novai:source-view-close' && forwardHarness.framePosts[0].message.payload.open === false && forwardHarness.framePosts[0].origin === '*', '广播到所有 iframe（2 个 frame 各一条）');
ok(forwardHarness && typeof forwardHarness.ipcHandlers['novai:source-custom-request'] === 'function', '自定义站点请求也注册转发监听');

console.log('[19] 拖拽预取：medium 秒出 + original 后台换高清');
ok(/GUEST_DRAG_MAX_BYTES = 30 \* 1024 \* 1024/.test(main) && /GUEST_DRAG_PREFETCH_TIMEOUT_MS = 20000/.test(main), '预取上限 30MB / medium 超时 20s');
ok(/function prefetchGuestDragImage\(payload\)/.test(main), 'prefetchGuestDragImage 存在');
ok(/视频不预取/.test(main) && /tag === 'VIDEO'/.test(main), '只预取图片（视频跳过）');
ok(/736x\|474x/.test(main), '优先选 736x/474x 中等尺寸候选');
ok(/mediumPromise/.test(main) && /originalPromise/.test(main) && /originalUrl: originalUrl/.test(main), 'medium 优先返回 + original 后台下载');
ok(/fetchGuestImageBytesWithRetry\(originalUrl, payload, 'original', 60000\)/.test(main), 'original 后台 60s 超时下载');
ok(/record\.bytesPromise = prefetch\.mediumPromise/.test(main) && /record\.originalPromise = prefetch\.originalPromise/.test(main), 'guest-drag 同时挂 medium/original promise');
ok(/action === 'guest-drag-bytes'/.test(handleFn) && /Promise\.race\(\[record\.bytesPromise, timeout\]\)/.test(handleFn), 'guest-drag-bytes 等待 medium');
ok(/action === 'guest-drag-original'/.test(handleFn) && /60000/.test(handleFn), 'guest-drag-original 等待 original（最多 60s）');
ok(/get_guest_drag_bytes: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'guest-drag-bytes' \}\)/.test(preload), 'preload 暴露 get_guest_drag_bytes');
ok(/get_guest_drag_original: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'guest-drag-original' \}\)/.test(preload), 'preload 暴露 get_guest_drag_original');
ok(/get_guest_drag_original: function\(\)\{ return call\('source-view', \{action:'guest-drag-original'\}\); \}/.test(shim), 'shim 暴露 get_guest_drag_original');
ok(/label \+ ' 预取开始（no-referer） '/.test(main) && /label \+ ' 预取完成 '/.test(main) && /fetchGuestImageBytesWithRetry\(mediumUrl, payload, 'medium'/.test(main) && /fetchGuestImageBytesWithRetry\(originalUrl, payload, 'original'/.test(main), 'medium/original 各自记录耗时日志（no-referer）');
ok(!/headers\.Referer/.test(main), '全文件不再通过 fetch headers 设置 Referer');
ok(/const chosenUrl = String\(\(payload && \(payload\.bestUrl \|\| payload\.uriList \|\| payload\.url\)\)/.test(main), '触发放宽：bestUrl/uriList/url 任一存在即预取');
ok(/const originalUrl = primaryUrl \|\| chosenUrl/.test(main), 'URL 优先级 imageCandidates[0] > bestUrl > uriList > url');
ok(/async function fetchGuestImageBytesWithRetry/.test(main) && /600ms 后用 fetch-url 同路径重试/.test(main), '失败后延迟 600ms 用 fetch-url 同路径重试');
ok(/HTTP ' \+ status/.test(main) && /请求超时（/.test(main) && /下载异常：/.test(main) && /非图片内容/.test(main) && /code=/.test(main), '失败原因可读（状态码/超时/异常/非图片/错误码）');
ok(/等待图片预取超时（20s）/.test(handleFn) && /result\.error \|\| '图片预取失败'/.test(handleFn), 'guest-drag-bytes 返回可读 error');
ok(/session\.fromPartition\(SOURCE_BROWSER_PARTITION\)\.fetch\(targetUrl, \{ headers: headers \}\)/.test(handleFn), 'fetch-url 走同一 session 网络栈（可兜底 pinimg）');
ok(/'text\/uri-list'/.test(dragPreload) && /bestUrl/.test(dragPreload), 'dragstart 回传 bestUrl');
ok(/sourceTag/.test(dragPreload) && /hitMethod/.test(dragPreload), 'payload 带 sourceTag / hitMethod');
ok(/window\.addEventListener\) \? window : document/.test(dragPreload) && /dragRoot\.addEventListener\('dragstart', handleDragStart, true\)/.test(dragPreload), 'window 级 capture dragstart');
ok(/background-image/.test(dragPreload) && /markBackgroundEl/.test(dragPreload) && /querySelectorAll\('img, picture, \[style\*="background-image"\]'\)/.test(dragPreload), 'background-image 大卡片也标记 draggable');
ok(/elementFromPoint/.test(dragPreload) && /hitMethod = media/.test(dragPreload), '按坐标命中媒体（hitMethod）');

const prefetchSrc = topLevelFunction(main, 'prefetchGuestDragImage');
const fetchBytesSrc = topLevelFunction(main, 'fetchGuestImageBytes');
const fetchViaSrc = topLevelFunction(main, 'fetchImageBytesViaSourceSession');
ok(!!prefetchSrc && !!fetchBytesSrc && !!fetchViaSrc, 'prefetch/下载/重试函数可抽取');
ok(/SOURCE_BROWSER_PARTITION/.test(fetchViaSrc) && /response\.arrayBuffer\(\)/.test(fetchViaSrc), '与 fetch-url 相同的 session.fetch + arrayBuffer');
ok(!/AbortController/.test(fetchViaSrc) && !/AbortController/.test(fetchBytesSrc), '不用 AbortController（避免 dragstart 中 ERR_BLOCKED_BY_CLIENT）');
ok(/Promise\.race\(\[fetchImageBytesViaSourceSession\(url, payload && payload\.pageUrl\), timeoutPromise\]\)/.test(fetchBytesSrc) && /setTimeout\(\(\) => resolve\(\{ ok: false, error: '请求超时/.test(fetchBytesSrc), '超时只提前返回、不 abort 请求');
ok(/Buffer\.from\(await response\.arrayBuffer\(\)\)/.test(fetchViaSrc) && /data:' \+ \(contentType/.test(fetchViaSrc), '返回 dataUrl（base64）');

console.log('[20] 默认 zoom 75% / XHS 覆盖层媒体 / 日志字段');
ok(/const SOURCE_DEFAULT_ZOOM = 0\.75;/.test(main), '默认缩放常量 0.75');
ok(/sourceView\.webContents\.setZoomFactor\(SOURCE_DEFAULT_ZOOM\)/.test(main) || /view\.webContents\.setZoomFactor\(SOURCE_DEFAULT_ZOOM\)/.test(main), '打开/切站强制 setZoomFactor(0.75)');
ok(/else if \(op === 'reset'\) factor = SOURCE_DEFAULT_ZOOM/.test(main), 'reset 回到 75%');
ok(/setZoomFactor\(SOURCE_DEFAULT_ZOOM\)/.test(main), '关闭面板复位到 75%');
ok(/payload\.elementsStack = stack/.test(dragPreload), 'payload 带 elementsStack（前 3 个 tag/class）');
ok(/hitMethod=' \+ String\(payload\.hitMethod/.test(main) && /JSON\.stringify\(payload\.elementsStack/.test(main), 'main 日志带 hitMethod/sourceTag/elementsStack');
ok(/markDraggableEl\(picked\)/.test(dragPreload) && /markDraggableEl\(node\)/.test(dragPreload), 'pointerdown 把最上层覆盖元素标可拖');
ok(/draggable'\) !== 'true'/.test(dragPreload) && /removeProperty\('-webkit-user-drag'\)/.test(dragPreload), '强制清掉内联 draggable=false / -webkit-user-drag:none');
ok(/document\.elementsFromPoint/.test(dragPreload) && /findMediaInStack/.test(dragPreload) && /findBackgroundInStack/.test(dragPreload), 'elementsFromPoint 栈解析 img/video/背景图');
ok(/get_guest_drag_original: \(\) => ipcRenderer\.invoke/.test(preload), 'preload 暴露 original');

console.log('[21] 小红书 pointerdown 守卫：媒体命中只 stopImmediatePropagation');
ok(/dragRoot\.addEventListener\('pointerdown', handleMediaPointerGuard, true\)/.test(dragPreload), 'window capture pointerdown 守卫');
ok(/dragRoot\.addEventListener\('mousedown', handleMediaPointerGuard, true\)/.test(dragPreload), 'window capture mousedown 守卫');
ok(/dragRoot\.addEventListener\('touchstart', handleMediaPointerGuard, \{ capture: true, passive: true \}\)/.test(dragPreload), 'window capture touchstart 守卫（passive）');
ok(/function handleMediaPointerGuard\(event\)/.test(dragPreload) && /event\.stopImmediatePropagation\(\)/.test(dragPreload), '媒体命中调用 stopImmediatePropagation');
const guardSrc = (dragPreload.match(/function handleMediaPointerGuard\(event\) \{[\s\S]*?\n  \}/) || [''])[0];
ok(!!guardSrc && !/preventDefault/.test(guardSrc), '守卫绝不调用 preventDefault');
ok(/if \(!picked\) return/.test(guardSrc), '只对媒体命中拦截（其它区域放行）');
ok(/pointerGuard: Boolean\(lastPointerGuardAt/.test(dragPreload), 'payload 带 pointerGuard=true');
ok(/pointerGuard=' \+ Boolean\(payload\.pointerGuard\)/.test(main), 'main 日志记录 pointerGuard');
let guardHarness = null;
try {
    function makeNode(tagName) {
        const attrs = {};
        return {
            tagName: String(tagName).toUpperCase(),
            attrs: attrs,
            style: { props: {}, getPropertyValue: function (name) { return this.props[name] || ''; }, removeProperty: function (name) { delete this.props[name]; }, setProperty: function (name, value) { this.props[name] = String(value); } },
            children: [],
            getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
            setAttribute: function (name, value) { attrs[name] = String(value); },
            addEventListener: function () {},
            appendChild: function (child) { this.children.push(child); child.parentElement = this; return child; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            closest: function (selector) { return selector === '[data-site]' && this.getAttribute('data-site') ? this : null; },
            contains: function (node) { return node === this || this.children.indexOf(node) >= 0; },
            getBoundingClientRect: function () { return { left: 0, top: 0, right: 220, bottom: 180, width: 220, height: 180 }; },
            parentElement: null,
        };
    }
    const img = makeNode('IMG');
    img.currentSrc = 'https://i.pinimg.com/474x/aa/bb/cc.jpg';
    const overlay = makeNode('DIV');
    overlay.children.push(img);
    const handlers = {};
    const sends = [];
    const body = makeNode('BODY');
    const fakeDocument = {
        title: '小红书',
        readyState: 'complete',
        documentElement: makeNode('HTML'),
        body: body,
        head: makeNode('HEAD'),
        createElement: makeNode,
        getElementById: function () { return null; },
        elementsFromPoint: function () { return [overlay, img]; },
        elementFromPoint: function () { return overlay; },
        querySelectorAll: function () { return []; },
        addEventListener: function (type, fn) { handlers[type] = handlers[type] || []; handlers[type].push(fn); },
    };
    const fakeRequire = function () {
        return { ipcRenderer: {
            send: function (channel, payload) { sends.push({ channel: channel, payload: payload }); },
            on: function (channel, fn) { handlers[channel] = fn; },
        } };
    };
    new Function('require', 'document', 'location', dragPreload)(fakeRequire, fakeDocument, { href: 'https://www.xiaohongshu.com/explore/1' });
    guardHarness = { handlers: handlers, sends: sends, img: img, overlay: overlay };
} catch (_) {}
ok(guardHarness && guardHarness.handlers.pointerdown && guardHarness.handlers.pointerdown.length > 0, 'preload 注册了 pointerdown 守卫');
if (guardHarness && guardHarness.handlers.pointerdown && guardHarness.handlers.pointerdown.length > 0) {
    const handlers = guardHarness.handlers;
    const guard = handlers.pointerdown[0];
    let stopped = 0;
    let prevented = 0;
    const event = {
        target: guardHarness.overlay,
        clientX: 80,
        clientY: 120,
        stopImmediatePropagation: function () { stopped += 1; },
        preventDefault: function () { prevented += 1; },
    };
    guard(event);
    ok(stopped === 1, 'pointerdown 命中媒体 → stopImmediatePropagation（页面 handler 不执行）');
    ok(prevented === 0 && event.defaultPrevented !== true, '守卫不 preventDefault（defaultPrevented=false）');
    ok(guardHarness.img.attrs.draggable === 'true' && guardHarness.img.style.props['-webkit-user-drag'] === 'element', '命中媒体补 draggable/-webkit-user-drag');
    const overlayMarked = guardHarness.overlay.attrs.draggable === 'true';
    ok(overlayMarked, '最上层包含媒体的元素也可拖');
    const pointerSends = guardHarness.sends.filter(function (item) { return item.channel === 'novai:guest-pointer'; });
    ok(pointerSends.length > 0 && pointerSends[pointerSends.length - 1].payload.pointerGuard === true, 'guest-pointer 带 pointerGuard=true');
    // 再触发 dragstart：dataTransfer 有 uri-list，payload.pointerGuard=true
    if (handlers.dragstart && handlers.dragstart[0]) {
        const dataTransfer = { types: [], data: {}, setData: function (name, value) { this.data[name] = value; if (this.types.indexOf(name) < 0) this.types.push(name); }, getData: function (name) { return this.data[name] || ''; } };
        handlers.dragstart[0]({ target: guardHarness.overlay, clientX: 80, clientY: 120, dataTransfer: dataTransfer, preventDefault: function () {}, stopPropagation: function () {}, stopImmediatePropagation: function () {} });
        const dragSends = guardHarness.sends.filter(function (item) { return item.channel === 'novai:guest-drag'; });
        const payload = dragSends[dragSends.length - 1] && dragSends[dragSends.length - 1].payload;
        ok(payload && payload.pointerGuard === true, 'drag payload.pointerGuard=true');
        ok(dataTransfer.data['text/uri-list'] === 'https://i.pinimg.com/originals/aa/bb/cc.jpg', 'dragstart 写入 dataTransfer uri-list');
    }
}

console.log('[13] 网络媒体请求捕获（只收视频）+ session.fetch 兜底');
const captureFnSrc = topLevelFunction(main, 'shouldCaptureMediaRequest');
ok(!!captureFnSrc, 'shouldCaptureMediaRequest 存在');
let captureFilter = null;
try {
    const urlReSrc = main.match(/const MEDIA_URL_RE = (\/.*\/i);/)[1];
    const hintsSrc = main.match(/const MEDIA_PATH_HINTS = (\[[^\]]*\]);/)[1];
    captureFilter = new Function('MEDIA_URL_RE', 'MEDIA_PATH_HINTS', 'return (' + captureFnSrc + ');')(eval(urlReSrc), eval(hintsSrc));
} catch (_) {}
ok(typeof captureFilter === 'function', 'shouldCaptureMediaRequest 可独立执行');
if (typeof captureFilter === 'function') {
    ok(captureFilter('https://sns-video.xhscdn.com/stream/abc', 'media') === true, 'resourceType=media 命中');
    ok(captureFilter('https://sns-video.xhscdn.com/a.mp4?x=1', 'xhr') === true, 'URL 命中 .mp4');
    ok(captureFilter('https://sns-video.xhscdn.com/a.m3u8', 'xhr') === true, 'URL 命中 .m3u8');
    ok(captureFilter('https://sns-video.xhscdn.com/a.m4s', 'xhr') === true, 'URL 命中 .m4s');
    ok(captureFilter('https://sns-video.xhscdn.com/a.ts?t=1', 'xhr') === true, 'URL 命中 .ts?');
    ok(captureFilter('https://www.xiaohongshu.com/api/video/abc', 'xhr') === true, 'xhr /video/ 路径命中');
    ok(captureFilter('https://www.xiaohongshu.com/api/stream/abc', 'fetch') === true, 'fetch /stream/ 路径命中');
    ok(captureFilter('https://www.xiaohongshu.com/api/media/abc', 'xhr') === true, 'xhr /media/ 路径命中');
    ok(captureFilter('https://www.xiaohongshu.com/api/play/abc', 'xhr') === true, 'xhr /play/ 路径命中');
    ok(captureFilter('https://sns-avatar-qc.xhscdn.com/avatar/abc.jpg', 'image') === false, 'xhscdn 头像图片不再进缓冲');
    ok(captureFilter('https://i.pinimg.com/736x/abc.jpg', 'image') === false, 'pinimg 图片不再进缓冲');
    ok(captureFilter('https://www.xiaohongshu.com/api/feed', 'xhr') === false, '无视频路径的 xhr 不命中');
    ok(captureFilter('not a url', 'image') === false, '非法 URL 不抛错且不命中');
}
const videoTypeSrc = topLevelFunction(main, 'isVideoContentType');
const kindSrc = topLevelFunction(main, 'classifyMediaKind');
ok(!!videoTypeSrc && !!kindSrc, 'isVideoContentType / classifyMediaKind 存在');
let videoTypeFn = null;
let kindFn = null;
try {
    videoTypeFn = new Function('return (' + videoTypeSrc + ');')();
    const urlReSrc2 = main.match(/const MEDIA_URL_RE = (\/.*\/i);/)[1];
    const imageReSrc = main.match(/const IMAGE_URL_RE = (\/.*\/i);/)[1];
    kindFn = new Function('MEDIA_URL_RE', 'IMAGE_URL_RE', 'isVideoContentType', 'return (' + kindSrc + ');')(eval(urlReSrc2), eval(imageReSrc), videoTypeFn);
} catch (_) {}
ok(typeof videoTypeFn === 'function', 'isVideoContentType 可独立执行');
if (typeof videoTypeFn === 'function') {
    ok(videoTypeFn('video/mp4') === true, 'video/mp4 命中');
    ok(videoTypeFn('video/mp2t') === true, 'video/mp2t 命中');
    ok(videoTypeFn('application/vnd.apple.mpegurl') === true, 'm3u8 的 content-type 命中');
    ok(videoTypeFn('image/jpeg') === false && videoTypeFn('text/html') === false && videoTypeFn('') === false, '图片/普通类型不算 video');
}
ok(typeof kindFn === 'function', 'classifyMediaKind 可独立执行');
if (typeof kindFn === 'function') {
    ok(kindFn('https://x/a', 'video/mp4') === 'video', '按 contentType 判 video');
    ok(kindFn('https://x/a', 'image/jpeg') === 'image', '按 contentType 判 image');
    ok(kindFn('https://x/a', 'text/plain') === 'other', '其它 contentType 判 other');
    ok(kindFn('https://x/a.mp4', '') === 'video', '无 contentType 时按 URL 判 video');
    ok(kindFn('https://sns-avatar-qc.xhscdn.com/avatar/abc.jpg', '') === 'image', '头像 URL 判 image');
    ok(kindFn('https://x/api/feed', '') === 'other', '无后缀无类型判 other');
}
ok(/MEDIA_BUFFER_LIMIT = 200/.test(main) && /while \(recentMediaRequests\.length > MEDIA_BUFFER_LIMIT\) recentMediaRequests\.shift\(\)/.test(main), '环形缓冲扩大到 200');
ok(/find\(\(item\) => item && item\.url === target\)/.test(main), '同 URL 去重（并补 contentType）');
ok(/clog\('source-view', '视频请求 ' \+ \(type \|\| '-'\) \+ ' ' \+ target\.slice\(0, 160\)\)/.test(main), '视频请求单独日志（截断 160）');
ok(/onBeforeRequest\(\{ urls: \['\*:\/\/\*\/\*'\] \}/.test(main), 'webRequest.onBeforeRequest 挂载');
ok(/onHeadersReceived\(\{ urls: \['\*:\/\/\*\/\*'\] \}/.test(main), 'webRequest.onHeadersReceived 挂载');
ok(/headerContentType\(details\.responseHeaders\)/.test(main) && /isVideoContentType\(type\)/.test(main), 'headersReceived 按 content-type 判断');
ok(/attachMediaRequestProbe\(wc\);/.test(main), 'createSourceView 里挂 webRequest 监听');
ok(/detachMediaRequestProbe\(\);/.test(main) && /onHeadersReceived\(null\)/.test(main), '销毁时摘掉两个 webRequest 监听');
ok(/action === 'recent-media'/.test(handleFn) && /\(now - item\.time\) <= MEDIA_BUFFER_WINDOW_MS/.test(handleFn), 'recent-media 只返回 120 秒内');
ok(/kind: classifyMediaKind\(item\.url, item\.contentType\)/.test(handleFn), 'recent-media 补 kind 字段');
ok(/const videos = fresh\.filter\(\(item\) => item\.kind === 'video'\)/.test(handleFn) && /return \{ ok: true, items: videos\.concat\(others\) \}/.test(handleFn), '视频记录优先返回');
ok(/action === 'fetch-url'/.test(handleFn), 'fetch-url 动作');
ok(/session\.fromPartition\(SOURCE_BROWSER_PARTITION\)\.fetch\(targetUrl, \{ headers: headers \}\)/.test(handleFn), '主进程 session.fetch 拉取');
ok(/'User-Agent': sourceBrowserUserAgent\(\)/.test(handleFn) && !/headers\.Referer/.test(handleFn), '带干净 UA、不设置 Referer（Chromium 会拦成 ERR_BLOCKED_BY_CLIENT）');
ok(/30 \* 1024 \* 1024/.test(handleFn) && /too-large/.test(handleFn), '限制 30MB，超了 too-large');
ok(/buffer\.toString\('base64'\)/.test(handleFn) && /'data:' \+ \(contentType \|\| 'application\/octet-stream'\)/.test(handleFn), '返回 dataUrl（base64）');
ok(/if \(!response\.ok\)/.test(handleFn) && /return \{ ok: false, status: status \}/.test(handleFn), '非 2xx 返回 status');
ok(/fetch-url ' \+ targetUrl\.slice\(0, 160\)/.test(handleFn), 'fetch-url 结果写日志（截断 160）');
ok(/get_recent_source_media: \(\) => ipcRenderer\.invoke\('novai:source-view', \{ action: 'recent-media' \}\)/.test(preload), 'preload 暴露 get_recent_source_media');
ok(/get_recent_source_media: function\(\)\{ return call\('source-view', \{action:'recent-media'\}\); \}/.test(shim), 'shim get_recent_source_media');
ok(/fetch_source_url: \(a, b\) => ipcRenderer\.invoke\('novai:source-view',/.test(preload), 'preload 暴露 fetch_source_url');
ok(/fetch_source_url: function\(u, r\)\{[\s\S]{0,260}typeof u === 'string'[\s\S]{0,260}Object\.assign\(\{action:'fetch-url'\}, u \|\| \{\}\)/.test(shim), 'shim fetch_source_url（位置/对象两种入参）');
let sourceUrlBridge = null;
try {
    const at = preload.indexOf('fetch_source_url:');
    const endMark = 'a || {}))';
    const endAt = preload.indexOf(endMark, at) + endMark.length;
    const expr = preload.slice(at, endAt).replace('fetch_source_url:', '').replace(/,\s*$/, '');
    sourceUrlBridge = new Function('ipcRenderer', 'return (' + expr + ')')({ invoke: (channel, payload) => ({ channel: channel, payload: payload }) });
} catch (_) {}
ok(typeof sourceUrlBridge === 'function', 'fetch_source_url 桥可独立执行');
if (typeof sourceUrlBridge === 'function') {
    const positional = sourceUrlBridge('https://sns-video.xhscdn.com/a.mp4', 'https://www.xiaohongshu.com/explore');
    ok(positional.channel === 'novai:source-view' && positional.payload.action === 'fetch-url' && positional.payload.url === 'https://sns-video.xhscdn.com/a.mp4' && positional.payload.referer === 'https://www.xiaohongshu.com/explore', '位置参数 (url, referer) 正确映射');
    const objectArg = sourceUrlBridge({ url: 'https://sns-video.xhscdn.com/b.m3u8', referer: 'https://www.xiaohongshu.com/explore' });
    ok(objectArg.payload.action === 'fetch-url' && objectArg.payload.url === 'https://sns-video.xhscdn.com/b.m3u8', '对象参数 ({url, referer}) 正确映射');
}
console.log('');
console.log('素材源内嵌浏览器回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if (fails.length) process.exit(1);
