#!/usr/bin/env node
/* 素材浏览器回归（左侧边栏 + 原生视图坐标 + 拖拽落地）：
   A. 面板是左侧边栏（贴画布左缘、顶到底、只留右侧圆角），开合给 body 加 class 并向父窗口 postMessage；
   B. 内容区用 #sourceBrowserView 量「父窗口坐标系」矩形（frameElement 偏移 + 祖先 scale 补偿 + 可视区夹取），
      通知主进程叠 WebContentsView；形变期间挪出窗口，落定后 open/setBounds；resize/尺寸变化重发；
   C. 外部拖拽落地：候选 URL 优先「像媒体」的，逐个 import-urls 落地；页面链接（text/html）
      回退 POST /api/local-assets/import-from-page 解析图片；失败不建节点并 toast。
   跑法：node tests/test_smart_canvas_source_browser.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('static/smart-canvas.html');
const js = read('static/js/source-browser.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');
const smart = read('static/js/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const count = (src, re) => (src.match(re) || []).length;
const SOURCES = ['pinterest', 'huaban', 'xiaohongshu', 'custom'];
function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

console.log('[1] 工具栏入口');
const toggleIdx = html.indexOf('id="sourceBrowserToggle"');
ok(toggleIdx > 0, '有 #sourceBrowserToggle');
const toggleTag = toggleIdx > 0
    ? html.slice(html.lastIndexOf('<button', toggleIdx), html.indexOf('</button>', toggleIdx) + '</button>'.length)
    : '';
ok(/class="asset-toggle source-browser-toggle"/.test(toggleTag), '按钮复用 .asset-toggle 药丸样式');
ok(/<i data-lucide="[a-z0-9-]+"><\/i>/.test(toggleTag) && toggleTag.indexOf('data-lucide') > 0, '图标是线性 lucide 图标');
ok(/<span data-i18n="source\.panelTitle">/.test(toggleTag), '按钮文案走 i18n');
ok(html.indexOf('id="canvasTopRight"') < toggleIdx && toggleIdx < html.indexOf('id="assetToggle"'), '按钮在右上同一排（素材浏览器最左）');

console.log('[2] 面板结构');
const panelIdx = html.indexOf('id="sourceBrowserPanel"');
ok(panelIdx > html.indexOf('id="assetPanel"'), '面板排在 #assetPanel 之后');
const panelHtml = panelIdx > 0
    ? html.slice(html.lastIndexOf('<aside', panelIdx), html.indexOf('</aside>', panelIdx) + '</aside>'.length)
    : '';
ok(/class="source-browser-panel"/.test(panelHtml), '面板是独立侧边栏容器');
ok(panelHtml.includes('id="sourceBrowserTabs"') && panelHtml.includes('role="tablist"'), '有 tab 条');
ok(count(panelHtml, /class="source-browser-tab"/g) === 4, '四个来源 tab（含自定义）');
ok(panelHtml.includes('id="sourceBrowserCustomBar"') && panelHtml.includes('id="sourceBrowserCustomUrl"'), '自定义网页地址栏');
ok(panelHtml.includes('id="sourceBrowserBottomResize"'), '底边高度拖拽把手');
SOURCES.forEach(key => ok(panelHtml.includes('data-source-key="' + key + '"'), 'tab 含 ' + key));
ok(panelHtml.includes('id="sourceBrowserStage"'), '有形变舞台');
ok(panelHtml.includes('id="sourceBrowserMorph"'), '有共享形变块');
ok(panelHtml.includes('id="sourceBrowserSurface"'), '有内容区容器');
ok(!html.includes('<webview'), '内容区不再放 <webview> 标签');
ok(/<div id="sourceBrowserView" class="source-browser-view"/.test(panelHtml), '#sourceBrowserView 是占位锚点 div');
ok(panelHtml.includes('id="sourceBrowserStatus"') && panelHtml.includes('id="sourceBrowserStatusText"'), '有加载/失败状态区');
ok(panelHtml.includes('id="sourceBrowserRetryBtn"'), '有重试按钮');
ok(panelHtml.includes('id="sourceBrowserPlaceholder"'), '有占位层（加载/空态文案）');
ok(panelHtml.includes('id="sourceBrowserUnsupported"') && /data-i18n="source\.unsupported"/.test(panelHtml), '有网页版不支持提示');
ok(panelHtml.includes('id="sourceBrowserFoot"') && /data-i18n="source\.hintDrag"/.test(panelHtml), '底部拖图提示保留');

console.log('[2b] 头部小按钮：刷新 / 在系统浏览器打开');
ok(panelHtml.includes('class="source-browser-head-actions"'), '头部右侧有按钮组');
ok(/<button id="sourceBrowserReloadBtn"[^>]*hidden/.test(panelHtml), '刷新按钮默认隐藏（没有 reload_source_view 时）');
ok(/<i data-lucide="refresh-cw"><\/i>/.test(panelHtml), '刷新按钮用线性 refresh-cw 图标');
ok(panelHtml.includes('data-i18n-title="source.reload"'), '刷新按钮文案走 i18n');
ok(/<button id="sourceBrowserExternalBtn"[^>]*data-i18n-title="source\.openExternal"/.test(panelHtml), '系统浏览器按钮带 i18n 提示');
ok(/<i data-lucide="external-link"><\/i>/.test(panelHtml), '系统浏览器按钮用线性 external-link 图标');
ok(panelHtml.includes('class="source-browser-mini-btn"'), '两个小按钮复用 mini 按钮类');
ok(/typeof api\.source_reload === 'function'/.test(js) && /typeof api\.reload_source_view === 'function'/.test(js) && /reload\.call\(api\)/.test(js), '刷新优先 source_reload()，兼容 reload_source_view()');
ok(/reloadBtn\.hidden = !\(api && \(typeof api\.source_reload === 'function' \|\| typeof api\.reload_source_view === 'function'\)\)/.test(js), '没有刷新能力时隐藏刷新按钮');
ok(/window\.open\(url, '_blank'\)/.test(js), '在系统浏览器打开走 window.open(..., "_blank")');
ok(/const SOURCE_URLS = \{/.test(js) && /pinterest: 'https:\/\/www\.pinterest\.com\/'/.test(js), '三个来源的系统浏览器兜底地址齐全');

console.log('[2b2] 前进/后退 + tab 等宽 + header 右侧留白');
ok(/id="sourceBrowserBack"/.test(panelHtml) && /id="sourceBrowserForward"/.test(panelHtml), '前进/后退按钮存在');
ok(/function refreshNavState\(/.test(js) && /get_source_view_state/.test(js) && /canGoBack/.test(js) && /canGoForward/.test(js), '状态读 get_source_view_state 的 canGoBack/canGoForward');
ok(/source_go_back/.test(js) && /source_go_forward/.test(js) && /source-nav|set_source_nav|source_nav/.test(js), '点击走 source-nav IPC');
ok(/event\.key === 'ArrowLeft'/.test(js) && /event\.key === 'ArrowRight'/.test(js), 'Cmd/Ctrl + ←/→ 键盘支持');
ok(/navGroupEl\.hidden = false/.test(js) && /navBackBtn\.disabled = true/.test(js), '前进后退始终显示，无 IPC 时置灰');
ok(/\.source-browser-tabs \.source-browser-tab \{[\s\S]*?flex: 1 1 0;/.test(css), '四个 tab 等宽 flex');
ok(/\.source-browser-head-actions \{ gap: 4px;/.test(css), 'header 右侧图标间距统一');

console.log('[2c] 三站品牌 logo');
const tabMarkup = [...panelHtml.matchAll(/<button class="source-browser-tab"[\s\S]*?<\/button>/g)].map(m => m[0]);
ok(tabMarkup.length === 4, '4 个 tab 各自独立');
const BRAND_LOGOS = [
    ['pinterest', '/static/images/brands/pinterest.svg'],
    ['huaban', '/static/images/brands/huaban.svg'],
    ['xiaohongshu', '/static/images/brands/xiaohongshu.png']
];
BRAND_LOGOS.forEach(([key, src]) => {
    const tab = tabMarkup.find(item => item.includes('data-source-key="' + key + '"')) || '';
    ok(tab.includes('<img class="source-browser-logo" src="' + src + '" alt="" draggable="false" loading="lazy">'), 'tab ' + key + ' 用品牌 logo');
    ok(fs.existsSync(path.join(root, src.replace(/^\//, ''))), '品牌资源存在：' + src);
    ok(/<span data-i18n="source\./.test(tab), 'tab ' + key + ' 保留文案 data-i18n');
    ok(/role="tab"/.test(tab) && /aria-selected=/.test(tab), 'tab ' + key + ' 保留 role/tab 语义');
});
ok(tabMarkup.filter(tab => !tab.includes('data-source-key="custom"')).every(tab => !/data-lucide=/.test(tab)), '老 tab 不残留通用 lucide 图标');
ok(tabMarkup.some(tab => tab.includes('data-source-key="custom"') && /data-lucide="earth"/.test(tab)), '自定义 tab 用 earth 图标');
ok(tabMarkup.every(tab => !/data-lucide="(image|layout-grid|bookmark-plus)"/.test(tab)), '已无 image / layout-grid / bookmark-plus 残留');

console.log('[2d] 浮层形态（全窗口关闭）');
ok(/const FULLSCREEN_MODE = false/.test(js), 'FULLSCREEN_MODE 关闭');
ok(/is-fallback/.test(js), '降级 fallback 状态保留');
ok(/window\.__novaSourceBrowserClose = function/.test(js) && /novai:source-view-close/.test(js), '主进程 × 关闭回调');
ok(/if\(!FULLSCREEN_MODE\)\{[\s\S]*?loadPanelWidth\(\);[\s\S]*?bindPanelResize\(\);[\s\S]*?bindPanelHeightResize\(\);[\s\S]*?bindPanelCornerResize\(\)/.test(js), '浮层下恢复宽高/角落拖拽');
ok(/pendingOpenTimer = setTimeout/.test(js), '等位移动画落定后再量 view rect');
ok(/openNativeView\(selectedKey\)/.test(js) && /scheduleSyncBounds/.test(js), '打开/变换后同步 view bounds');

console.log('[2e] 主进程关闭事件订阅');
ok(/api\.on_source_view_closed\(payload =>/.test(js), '订阅 on_source_view_closed');
ok(/payload && payload\.open === true\) return;[\s\S]*?closePanel\(\)/.test(js), 'open=false 时 closePanel');
ok(/bindSourceViewClosedSubscription\(\)/.test(js), 'init 里调用订阅');
ok(/let closeSubscribed = false/.test(js) && /if\(closeSubscribed \|\|/.test(js), '订阅只注册一次（防重复关闭）');
ok(/pywebviewready[\s\S]*?bindSourceViewClosedSubscription/.test(js), 'pywebviewready 后补订阅');
ok(/function closePanel\(\)\{[\s\S]*?if\(!panel \|\| !panelOpen\) return;/.test(js), 'closePanel 防重复关闭');
ok(/classList\.remove\('source-fullscreen'\)/.test(js), '关闭移除 body.source-fullscreen');

console.log('[2f] 面板内工具栏');
ok(/navGroupEl\.hidden = false/.test(js), '前进后退常显');
ok(/typeof api\.source_reload === 'function'/.test(js) && /reload\.call\(api\)/.test(js), '刷新接 source_reload');
ok(/switch_source_site/.test(js) && /openNativeView\(key\)/.test(js), '站点切换接 switch_source_site/open_source_view');
ok(/source_go_back/.test(js) && /source_go_forward/.test(js) && /set_source_zoom/.test(js), '返回/前进/缩放接现有 IPC');

console.log('[2g] 注入 × 事件别名');
ok(/novai:source-view-closed/.test(js) && /source-view-closed/.test(js), '兼容 novai:source-view-closed');
ok(/closePanel\(\)/.test(js), '收到事件后关闭面板');

console.log('[3] 形变与 tab 切换');
ok(/window\.NovaGlide\.attach\(/.test(js), 'tab 滑块复用 shared/glide.js');
ok(/orientation:\s*'horizontal'/.test(js), 'tab 滑块按水平方向');
ok(/getBoundingClientRect\(\)/.test(js) && /\.animate\(/.test(js), '形变走 getBoundingClientRect + FLIP 动画');
ok(/borderRadius:\s*'999px'/.test(js) && /borderRadius:\s*radius/.test(js), 'border-radius 从胶囊过渡到内容区圆角');
ok(/transform:\s*'translate\(0px, 0px\) scale\(1, 1\)'/.test(js), '位移/尺寸走 transform，不改宽高');
ok(/'--nv-glide-ms'/.test(js) && /getPropertyValue/.test(js), '时长复用 --nv-glide-ms');
ok(/prefers-reduced-motion/.test(js), '尊重 prefers-reduced-motion');
ok(/selectedKey/.test(js) && /aria-selected/.test(js), 'tab 选中态用 aria-selected');

console.log('[3b] 左侧边栏 + 开合联动');
ok(/document\.body\.classList\.add\('source-browser-open'\)/.test(js), '打开时给 body 加 source-browser-open');
ok(/document\.body\.classList\.remove\('source-browser-open'\)/.test(js), '关闭/初始化时移除 source-browser-open');
ok(/postToParent\(\{ type: 'novai:source-browser-panel', open: Boolean\(open\) \}\)/.test(js), '开合向父窗口 postMessage');
ok(/notifyParentOpen\(true\)/.test(js) && /notifyParentOpen\(false\)/.test(js), '打开/关闭各通知一次');
ok(/postToParent\(\{ type: 'novai:request-viewport' \}\)/.test(js), '向父窗口请求可视区尺寸');
ok(/data\.type !== 'novai:viewport'/.test(js) && /parentViewport = \{/.test(js), '接收父窗口回传的 viewport 并缓存');

console.log('[3c] 面板宽度拖拽 + tab 白底对齐');
ok(/id="sourceBrowserResizeHandle"/.test(panelHtml), '面板里有右缘拖拽热区');
ok(/class="source-browser-resize" role="separator" aria-orientation="vertical"/.test(panelHtml), '热区带 separator 语义（透明不画边框）');
ok(/PANEL_WIDTH_KEY = 'novai-source-panel-width'/.test(js), '宽度记忆 key = novai-source-panel-width');
ok(/PANEL_MIN_WIDTH = 380/.test(js) && /PANEL_MAX_WIDTH = 900/.test(js) && /PANEL_MIN_HEIGHT = 400/.test(js), '宽度范围 380~900 / 最小高度 400');
ok(/Math\.min\(PANEL_MAX_WIDTH, width \* 0\.9\)/.test(js), '最大宽度 = min(900px, 90vw)');
ok(/Math\.min\(Math\.max\(Math\.round\(value\), PANEL_MIN_WIDTH\), panelMaxWidth\(\)\)/.test(js), '拖动后的宽度被夹在范围内');
ok(/localStorage\.getItem\(PANEL_WIDTH_KEY\)/.test(js) && /localStorage\.setItem\(PANEL_WIDTH_KEY/.test(js), 'localStorage 读取/记忆宽度');
ok(/style\.setProperty\('--source-browser-width'/.test(js), '宽度写到 --source-browser-width');
ok(/addEventListener\('pointerdown'/.test(js) && /addEventListener\('pointermove'/.test(js) && /addEventListener\('pointerup'/.test(js), 'pointer 事件驱动拖拽');
ok(/setPointerCapture/.test(js), '拖拽时捕获指针');
ok(/drag\.startWidth \+ \(Number\(event\.clientX\) - drag\.startX\)/.test(js), '按鼠标水平位移改宽度');
ok(/applyPanelWidth\(next\);\s*scheduleRealignTabs\(\);\s*syncBounds\(\);/.test(js), '拖动过程中实时更新原生视图 bounds');
ok(/function realignTabs/.test(js) && /glideController\.refresh\(\)/.test(js) && /glideController\.setActive\(active, \{ instant: true \}\)/.test(js), '按最新 tab rect 重算白底滑块');
ok(/document\.fonts\.ready/.test(js), '字体加载完后重新对齐');
ok(/visualViewport/.test(js) && /settleBrowserGeometry/.test(js), 'visualViewport + resize 后延迟补 setBounds');
ok(/resizeObserver\.observe\(panel\)/.test(js) && /scheduleRealignTabs\(\)/.test(js), '面板尺寸变化纳入重算');
ok(/const active = tabEl\(selectedKey\);\s*\n\s*if\(!active\) return;/.test(js) && /tabRect = active\.getBoundingClientRect\(\)/.test(js), '形变起点取当前选中 tab 的实际 rect');

console.log('[4] WebContentsView 叠层接线 + 坐标换算');
ok(/typeof api\.open_source_view === 'function'/.test(js), '按 open_source_view 判断原生视图可用');
ok(/open_source_view\(payload\.source, payload\.rect, payload\.url/.test(js) && /set_source_view_bounds\(payload\.rect\)/.test(js) && /close_source_view\(\)/.test(js), '调用新 preload 四件套（open/setBounds/close）');
ok(/typeof api\.open_source_browser === 'function'/.test(js) && /open_source_browser\(payload && payload\.source\)/.test(js), '旧 preload 只有伴生窗口方法时 polyfill 一层');
ok(/viewOverlay = true;/.test(js) && /viewOverlay = false;/.test(js), '区分叠层 / 伴生窗口两种模式');
ok(/window\.frameElement/.test(js) && /fr\.left \+ r\.left \* scale/.test(js) && /fr\.top \+ r\.top \* scale/.test(js), 'rect 含 frameElement 偏移 + 祖先 scale 补偿');
ok(/fr\.width \/ offsetWidth/.test(js), 'scale = fr.width / frame.offsetWidth');
ok(/r\.width \* scale/.test(js) && /r\.height \* scale/.test(js), '宽高同样乘 scale');
ok(/Math\.round\(x\)/.test(js) && /Math\.round\(r\.width \* scale\)/.test(js), 'rect 全部取整');
ok(/function clampViewRect/.test(js) && /viewport\.width - x/.test(js) && /viewport\.height - y/.test(js), 'rect 夹在可视区内（越界收缩宽高）');
ok(/await viewApi\.open\(\{ source: key, rect, url \}\)/.test(js), 'open_source_view({source, rect, url})');
ok(/openCustomUrl/.test(js) && /normalizeHttpUrl/.test(js), '自定义网页地址校验与打开');
ok(/CUSTOM_RECENT_KEY/.test(js) && /localStorage\.setItem\(CUSTOM_RECENT_KEY/.test(js), '最近地址存 localStorage');
ok(/PANEL_HEIGHT_KEY/.test(js) && /bindPanelHeightResize/.test(js), '高度拖拽 + 记忆');
ok(/viewApi\.bounds\(\{ rect \}\)/.test(js), 'setBounds 重新对齐');
ok(/x: -20000/.test(js) && /function hideNativeView/.test(js), '形变期间把原生视图挪出窗口');
ok(/morphBusy = true;\s*if\(viewOverlay && nativeOpen\) hideNativeView\(\);/.test(js), '形变一开始就隐藏原生视图');
ok(/morphTimer = setTimeout\(\(\) => \{[\s\S]*?morphBusy = false;[\s\S]*?onMorphSettled\(\);[\s\S]*?\}, wait \+ 16\);/.test(js), '形变结束（260ms 后）再 open/对齐');
ok(/closeNativeView\(\);[\s\S]{0,160}classList\.remove\('source-browser-open'\)/.test(js), '关闭面板时 close_source_view');
ok(/new ResizeObserver/.test(js) && /window\.addEventListener\('resize'/.test(js), 'ResizeObserver + window resize 重新 setBounds');
ok(/resizeObserver\.observe\(panel\)/.test(js), '面板宽度变化也重新 setBounds');
ok(/rect: \(\) => viewRect\(\)/.test(js), '对外暴露 rect 计算便于校验');
ok(!/loadURL/.test(js) && !/did-fail-load/.test(js), '不再走 <webview> 的 loadURL / 事件');
ok(/setStage\('failed'/.test(js) && /retrySelectedSource/.test(js) && /openNativeView\(selectedKey\)/.test(js), 'open 失败显示文案 + 重试');
ok(/setStage\('unsupported'\)/.test(js), '接口不存在显示网页版不支持');

console.log('[5] 与其它右上角面板互斥');
ok(/if\(except !== 'source-browser'\) window\.__novaSourceBrowser\?\.close\(\);/.test(smart), 'closeSmartSidePanels 里有一行守卫调用');
ok(/window\.__novaCloseSmartSidePanels = closeSmartSidePanels;/.test(smart), '导出 closeSmartSidePanels 供反向调用');
ok(count(smart, /__novaSourceBrowser/g) >= 2 && /__novaSourceBrowser\.isOpen/.test(smart), '关闭与拖拽判定都读 __novaSourceBrowser');
ok(count(smart, /__novaCloseSmartSidePanels/g) === 1, 'smart-canvas.js 只碰一次 __novaCloseSmartSidePanels');
ok(/window\.__novaCloseSmartSidePanels\('source-browser'\)/.test(js), '开面板时先收掉其它面板');

console.log('[6] 脚本引入顺序');
const scriptTag = html.match(/<script defer src="\/static\/js\/source-browser\.js\?v=[\d.]+"><\/script>/);
ok(Boolean(scriptTag), '新脚本用 defer + ?v= 版本戳引入');
ok(scriptTag && html.indexOf(scriptTag[0]) < html.indexOf('/static/js/smart-canvas.js?v='), '在 smart-canvas.js 之前执行');
ok(scriptTag && html.indexOf('/static/js/shared/glide.js') > 0 && html.indexOf('/static/js/shared/glide.js') < html.indexOf(scriptTag[0]), 'glide.js 先于面板脚本加载');

console.log('[7] 样式：左侧边栏 + 硬规则');
const cssBlock = css.slice(css.indexOf('素材浏览器：左侧边栏'), css.indexOf('画布页 · 深色悬浮布局') > 0 ? css.indexOf('画布页 · 深色悬浮布局') : undefined);
ok(cssBlock.length > 500, '样式已更新');
ok(/left:\s*0/.test(cssBlock) && /top:\s*0/.test(cssBlock) && /bottom:\s*0/.test(cssBlock), '贴画布左缘、顶到底');
ok(/width:\s*var\(--source-browser-width, min\(560px, 52vw\)\)/.test(cssBlock), '默认宽度 min(560px, 52vw)，可被 --source-browser-width 覆盖');
ok(!/left:\s*50%/.test(cssBlock) && !/top:\s*74px/.test(cssBlock), '不再是居中大浮层');
ok(/border-radius:\s*0 var\(--radius-xl\) var\(--radius-xl\) 0/.test(cssBlock), '只保留右侧圆角');
ok(/transform:\s*translateX\(-100%\)/.test(cssBlock) && /\.source-browser-panel\.open \{[^}]*transform: translateX\(0\)/.test(cssBlock), '从左侧滑入');
ok(/color-mix\(in srgb, var\(--panel\) 78%, transparent\)/.test(cssBlock), '磨砂底色照抄 .asset-panel');
ok(/backdrop-filter:\s*blur\(44px\) saturate\(190%\)/.test(cssBlock), '磨砂 blur(44px) saturate(190%)');
ok(/box-shadow:[^;]*var\(--shadow\)[^;]*var\(--shadow\)/.test(cssBlock), '两层柔影');
const borderValues = [...cssBlock.matchAll(/border\s*:\s*([^;{}]+)/g)].map(m => m[1].trim());
ok(borderValues.every(value => /^0(px)?$/.test(value) || value === 'none'), '新样式不画边框（只用 border:0 归零）');
ok(!/inset\s+0\s+0\s+0\s+1px/.test(cssBlock), '不用 inset 1px 发丝描边');
ok(/--nv-glide-bg:/.test(cssBlock), 'tab 选中底复用 --nv-glide-bg');
ok(/\.source-browser-tabs\.nv-glide-host \.nv-glide-pill \{ border-radius: var\(--radius-full\)/.test(cssBlock), '滑块跟着 tab 做成胶囊圆角');
ok(/aria-selected="true"/.test(cssBlock), 'tab 选中态用软底/文字提亮（[aria-selected]）');
ok(/\.source-browser-logo \{\s*width: 16px;\s*height: 16px;\s*flex: 0 0 auto;\s*object-fit: contain;\s*border-radius: 4px;\s*display: inline-block;\s*\}/.test(cssBlock), '品牌 logo 有尺寸/圆角/object-fit 规则');
ok(!/\.source-browser-tab\[aria-selected="true"\]\s+(?:img|\.source-browser-logo)/.test(cssBlock), '选中态不给品牌 logo 换色');
ok(/\.source-browser-head-actions \{ display: flex/.test(cssBlock), '头部按钮组横排');
ok(/\.source-browser-close,\s*\n\.source-browser-mini-btn \{[\s\S]*?border: 0;/.test(cssBlock), 'mini 按钮复用无边框软底规则');
ok(/\.source-browser-view \{[\s\S]*?position: absolute/.test(cssBlock) && /pointer-events: none/.test(cssBlock), '原生视图锚点只负责量矩形');
ok(!/has-webview/.test(css), '清掉旧 webview 的 display 状态类');
ok(/@media \(max-width: 760px\)\{[\s\S]*?\.source-browser-panel \{ width: var\(--source-browser-width, min\(560px, 92vw\)\)/.test(cssBlock), '小屏侧栏宽度可覆盖');
ok(/@media \(max-width: 760px\)\{[\s\S]*?\.source-browser-tabs \{ flex-direction: column/.test(cssBlock), '小屏 tab 竖排');
ok(/@media \(max-width: 760px\)\{[\s\S]*?\.source-browser-tab \{ flex: 0 0 auto; justify-content: center/.test(cssBlock), '小屏 tab 内容仍水平居中');
ok(!/justify-content:\s*flex-start/.test(cssBlock), 'tab 内容不用 flex-start（保持居中）');
ok(/\.source-browser-resize \{[\s\S]*?position: absolute;[\s\S]*?right: 0;[\s\S]*?width: 6px;[\s\S]*?cursor: col-resize;[\s\S]*?\}/.test(cssBlock), '右缘 6px 透明拖拽热区 + col-resize');
ok(/background: transparent;\s*cursor: col-resize;/.test(cssBlock), '拖拽热区透明、不画可见边框');
ok(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\.source-browser-morph \{ display: none/.test(cssBlock), 'reduced-motion 关闭形变');

console.log('[8] i18n 中英成对');
const used = new Set();
[...html.matchAll(/data-i18n(?:-title)?="(source\.[a-zA-Z]+)"/g)].forEach(m => used.add(m[1]));
[...js.matchAll(/t\('(source\.[a-zA-Z]+)'/g)].forEach(m => used.add(m[1]));
ok(used.size >= 12, '引用了成套的 source.* key（' + used.size + ' 个）');
const missing = [];
used.forEach(key => {
    const esc = key.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
    const re = new RegExp('"' + esc + '"\\s*:\\s*\\{\\s*zh:\\s*"[^"]+"\\s*,\\s*en:\\s*"[^"]+"');
    if(!re.test(i18n)) missing.push(key);
});
ok(missing.length === 0, '每个 source.* 都有 zh + en 成对文案' + (missing.length ? '（缺：' + missing.join(', ') + '）' : ''));

console.log('[9] 拖拽落图：候选排序 + 页面兜底');
const payloadFn = topLevelFunction(smart, 'smartImageDropPayload');
ok(/const urls = uniqueSmartDropValues/.test(payloadFn) && /url:urls\[0\], urls/.test(payloadFn), '拖拽 payload 保留全部候选 URL');
const dropFn = topLevelFunction(smart, 'handleSmartImageDropPayload');
ok(Boolean(dropFn), 'handleSmartImageDropPayload 存在');
const urlBranch = dropFn ? dropFn.slice(dropFn.indexOf("payload.type === 'url'")) : '';
ok(/const IMAGE_EXT_RE =/.test(urlBranch) && /png\|jpe\?g\|webp\|gif/.test(urlBranch), '图片扩展名分类');
ok(/const VIDEO_EXT_RE =/.test(urlBranch) && /mp4\|webm\|mov\|m4v/.test(urlBranch), '视频扩展名分类');
ok(/const KNOWN_VIDEO_HOST_RE =/.test(urlBranch) && /pinimg/.test(urlBranch) && /xhscdn/.test(urlBranch), '已知视频 CDN 分类');
ok(/looksLikeVideoUrl/.test(urlBranch), '能判定视频候选');
ok(/const videos = mergeUnique\(candidates\.filter\(isVideoCandidate\)\)/.test(urlBranch), '视频候选优先级最高');
ok(/const images = mergeUnique\(candidates\.filter\(url => isImageCandidate\(url\) && !forcedImage\.has\(url\)\)\)/.test(urlBranch), '图片候选第二优先级');
ok(/const ordered = mergeUnique\(\[\]\.concat\(lead, videos, images, others, pages\)\)/.test(urlBranch), 'IMG 首候选 + 视频>图片>其它>页面（page 最后）');
ok(/const isCdnImageCandidate = url =>/.test(urlBranch) && /sns-webpic/.test(urlBranch) && /sns-img/.test(urlBranch) && /ci\\.xiaohongshu\\.com/.test(urlBranch), '新增 CDN 图片识别（sns-webpic*/sns-img*/ci.xiaohongshu.com）');
ok(/const isPageCandidate = url =>/.test(urlBranch) && /xiaohongshu\\.com\|pinterest\\.com\|huaban\\.com/.test(urlBranch) && /explore\|discovery\|pins\?\|boards\?\|search/.test(urlBranch), '新增页面识别（三站主站 + explore/discovery/pins/board/search 路由）');
ok(/const pages = mergeUnique\(candidates\.filter\(isPageCandidate\)\)/.test(urlBranch), 'page 候选单独成档');
ok(/tierOf\(url\)/.test(urlBranch) && /'page'/.test(urlBranch), '日志 tier 含 page');
ok(/get_last_guest_drag/.test(urlBranch) && /typeof guestApi\.get_last_guest_drag === 'function'/.test(urlBranch), '先读主进程记下的内嵌页面拖拽（无方法静默跳过）');
ok(urlBranch.indexOf('get_last_guest_drag') > 0 && urlBranch.indexOf('get_last_guest_drag') < urlBranch.indexOf('/api/local-assets/import-urls'), 'guest drag 在 import 尝试之前读取');
ok(/guestDrag target=' \+ \(tag \|\| '\?'\) \+ ' src=' \+ String\(firstSrc \|\| ''\)\.slice\(0, 200\)/.test(urlBranch), '日志 guestDrag target/src（截断 200）');
ok(/smartChooseGuestImageCandidate\(uriSource, imageCandidates\)/.test(urlBranch), 'uri-list 与 candidates 同主路径时才用高清候选');
ok(/uriSource \? uriChoice\.url : \(imageCandidates\[0\] \|\| rawDataSrc/.test(urlBranch), '无 uri-list 才用 imageCandidates[0]');
ok(/bestSrcsetUrl\(rawSrcset\)/.test(urlBranch) && /rawDataSrc/.test(urlBranch), 'srcset 取描述符最大项 + dataSrc 兜底');
ok(/drag\.tagName/.test(urlBranch) && /drag\.currentSrc/.test(urlBranch) && /drag\.mediaUrl/.test(urlBranch), '兼容 preload 扁平 drag 结构（tagName/currentSrc/mediaUrl）');
ok(/rawDataSrc \|\| bestSrcsetUrl\(rawSrcset\) \|\| rawSrc \|\| currentSrc \|\| mediaUrl/.test(urlBranch), 'IMG 候选优先级 dataSrc > srcset > src > currentSrc > mediaUrl');
ok(/tag === 'VIDEO'[\s\S]*?guestPriorityVideo\.push\(firstSrc\)/.test(urlBranch), 'VIDEO 取 target.src 作最高优先视频候选');
ok(/parsed\.videoSources\.forEach\(url => guestPriorityVideo\.push\(url\)\)/.test(urlBranch), '从 guest drag.html 解析 <source src> 进视频候选');
ok(/if\(tag === 'VIDEO'\)\{[\s\S]*?drag\.videoUrls[\s\S]*?guestPriorityVideo\.push\(value\)/.test(urlBranch), 'VIDEO 候选包含 drag.videoUrls');
ok(/const mediaUrl = String\(drag\.mediaUrl[\s\S]*?guestPriorityVideo\.push\(mediaUrl\)/.test(urlBranch), 'VIDEO 候选包含 drag.mediaUrl');
ok(/dropLog\('guestDrag videoUrls=' \+ videoUrls\.length/.test(urlBranch), '日志打印 videoUrls 数量');
ok(/drag\.videoUrls/.test(urlBranch) && /forcedVideo\.has\(url\)/.test(urlBranch), 'videoUrls 进 forcedVideo（强制按视频处理）');
ok(/guestParsed\.push\(\.\.\.parsed\.all, \.\.\.uriList\)/.test(urlBranch), 'drag.html + uriList 解析出的候选追加到列表');
ok(/const lead = guestImageNorm\.slice\(\)/.test(urlBranch), 'IMG 候选（归一化后）插入最前面');
ok(/const bestSrcsetUrl = value =>/.test(urlBranch) && /bestScore/.test(urlBranch) && /parseFloat\(match\[1\]\)/.test(urlBranch), 'srcset 取最大描述符而不是第一项');
ok(/const normalizeCandidateUrl = url =>/.test(urlBranch), '有候选归一化函数');
ok(urlBranch.indexOf('huaban\\.com') >= 0 && urlBranch.indexOf('huabanimg\\.com') >= 0 && urlBranch.indexOf('hbimg\\.cn') >= 0, '归一化覆盖花瓣系 CDN');
ok(/params\.delete\('x-oss-process'\)/.test(urlBranch) && /params\.delete\('imageView2'\)/.test(urlBranch), '花瓣去 x-oss-process / imageView2，保留其它 query');
ok(urlBranch.indexOf("'/originals/'") >= 0 && urlBranch.indexOf('\\d{1,4}x') >= 0, 'Pinterest 尺寸段换成 /originals/');
ok(urlBranch.indexOf('^https?:\\/\\/') >= 0, '只处理 http(s) 候选');
ok(/const normalizeList = list => mergeUnique\(\(list \|\| \[\]\)\.map\(normalizeCandidateUrl\)\)/.test(urlBranch), '归一化作用于全部候选来源');
ok(/dropLog\('normalize:', text\.slice\(0, 200\), '=>', normalized\.slice\(0, 200\)\)/.test(urlBranch) && count(urlBranch, /dropLog\('normalize:'/g) >= 1, '日志打印归一化前后（各截断 200）');
ok(!/target\.poster/.test(urlBranch), 'poster 不参与候选');
ok(/querySelectorAll\('img,video,source,a'\)/.test(urlBranch) && /data-original/.test(urlBranch) && /bestSrcsetUrl\(el\.getAttribute\('srcset'\)\)/.test(urlBranch), 'guest html 解析 src/srcset/data-original');
ok(urlBranch.includes('236x') && urlBranch.includes("'/originals/'"), '花瓣尺寸段 → originals');
ok(/_\(\?:fw\|sq\)/.test(urlBranch), '花瓣去掉 _fw/_sq 缩略后缀');
ok(/<\(img\|video\|source\|a\)/.test(urlBranch), '无 DOMParser 时用正则兜底解析');
const fragmentsFn = topLevelFunction(smart, 'smartDropTextFragments');
ok(/video\[src\],source\[src\]/.test(fragmentsFn), 'text/html 里解析 <video src> / <source src>');
ok(/<video|<source/.test(fragmentsFn), 'HTML 片段判断含 video/source');
ok(!/poster\]/.test(fragmentsFn), 'poster 不算视频候选');
const fallbackFn = topLevelFunction(smart, 'guestDropFallbackPayload');
ok(Boolean(fallbackFn) && /get_last_guest_drag/.test(fallbackFn), '有 dataTransfer 空时的 guestDropFallbackPayload（读 get_last_guest_drag）');
ok(/imageCandidates/.test(fallbackFn) && /videoCandidates/.test(fallbackFn) && /mediaUrl/.test(fallbackFn) && /target\.src \|\| drag\.src/.test(fallbackFn), '兜底读取 imageCandidates/videoCandidates/mediaUrl/src');
ok(/guestDropFallback tag='/.test(fallbackFn) && /candidates=' \+ unique\.length \+ ' best='/.test(fallbackFn), '日志打印 guestDropFallback candidates/best');
ok(/type:'url', url:best, urls:unique/.test(fallbackFn) && /imageCandidates, videoCandidates, fromGuest:true/.test(fallbackFn), '兜底构造 url payload（最佳候选优先）');
ok(/mergeGuestDropPayload\(await resolveSmartImageDropPayload/.test(smart) && count(smart, /mergeGuestDropPayload\(/g) >= 3, 'shell/节点 ondrop 合并 guest 候选与 dataTransfer URL');
ok(/const urls = uniqueSmartDropValues\(\[\]\.concat\(guest\.urls \|\| \[\], \[guest\.url\], payload\.url, payload\.urls \|\| \[\]\)\)/.test(smart), 'guest 候选在前、dataTransfer URL 去重追加');
ok(/mergeGuest candidates='/.test(smart), '合并日志 candidates/best');
ok(/const buildOrdered = \(\) =>/.test(urlBranch) && /const tierState = buildOrdered\(\)/.test(urlBranch) || /let tierState = buildOrdered\(\)/.test(urlBranch), '候选分档封装成 buildOrdered/tierState');
ok(/const runMediaPass = async \(\) =>/.test(urlBranch) && /for\(const candidate of tierState\.ordered\)/.test(urlBranch), '逐个媒体候选尝试（page 不进本轮）');
ok(/const fromBytes = await importFromFetchedBytes\(candidate\);/.test(urlBranch), '每个候选 import-urls 失败后单独 fetch-bytes');
ok(/const fromUrl = await importFromFetchedUrl\(candidate\);/.test(urlBranch), '视频网络地址再加 fetch-url 通道');
ok(urlBranch.indexOf("if((isVideoCandidate(candidate) || isImageCandidate(candidate)) && /^https?:\\/\\//i.test(candidate)){") >= 0, 'fetch-url 对图片候选同样生效（后端直连不通的站点只能靠主进程代理取图）');
ok(urlBranch.indexOf('importFromFetchedUrl(candidate)') > urlBranch.indexOf('importFromFetchedBytes(candidate)'), '通道顺序 import-urls → fetch-bytes → fetch-url');
ok(/trail\.concat\('done'\)\.join\(' > '\)/.test(urlBranch) && /trail\.join\(' > '\)/.test(urlBranch), '日志记录每个候选走了哪些通道');
ok(/const isBlobUrl = url =>/.test(urlBranch) && /const isM3u8Url = url =>/.test(urlBranch), '有 blob / m3u8 判定');
ok(/skip m3u8:/.test(urlBranch) && /dropLog\('skip m3u8:'/.test(urlBranch), 'm3u8 候选直接跳过并记日志');
ok(/candidates\.every\(isBlobUrl\)/.test(urlBranch) && /blobInCandidates/.test(urlBranch), '候选只有 blob 时走最近媒体兜底');
ok(/get_recent_source_media/.test(urlBranch) && /kind === 'video'/.test(urlBranch), '最近媒体新版按 kind === video 过滤');
ok(/hasKind \? kind === 'video' : isLegacyVideoUrl\(url\)/.test(urlBranch), '没有 kind 的旧版本才按扩展名兜底');
ok(/const isLegacyVideoUrl = url =>/.test(urlBranch) && /\.\(\?:mp4\|m3u8\|m4s\|ts\)/.test(urlBranch), '旧版本扩展名兜底保留 mp4/m3u8/m4s/ts');
ok(!/filter\(url => \/\.\(\?:mp4/.test(urlBranch), '不再无条件依赖扩展名判断视频');
ok(/recentMedia=' \+ entries\.length \+ ' \(video=' \+ urls\.length \+ '\)'/.test(urlBranch), '日志 recentMedia=N (video=M)');
ok(/recentMedia item\(' \+ item\.kind \+ '\):/.test(urlBranch) && /slice\(0, 160\)/.test(urlBranch), '日志打印每条候选的 kind + 160 截断');
ok(/mergeUnique\(\[\]\.concat\(recent, candidates\)\)/.test(urlBranch), '最近媒体地址插到候选最前面');
ok(/fetch_source_url/.test(urlBranch) && /referer:guestPageUrl/.test(urlBranch), 'fetch-url 带 Referer（guestPageUrl）');
ok(/dropLog\(channel \+ ':', fetched \?/.test(urlBranch) && /contentType:fetched\.contentType, size:fetched\.size/.test(urlBranch), 'fetch-url / fetch-bytes 日志含 status/contentType/size');
ok(urlBranch.indexOf('page fallback target') > urlBranch.indexOf('runMediaPass'), '页面兜底挪到所有候选尝试之后');
ok(!/pageFallbackTried/.test(urlBranch), '去掉「第一个候选失败就触发页面兜底」的旧逻辑');
ok(/\/api\/local-assets\/import-urls/.test(urlBranch) && /url:candidate/.test(urlBranch), '先 POST import-urls 落地本地');
ok(/if\(attempt\) await new Promise\(resolve => setTimeout\(resolve, 400\)\)/.test(urlBranch), '单个候选失败重试一次（约 400ms）');
ok(/\/api\/local-assets\/import-from-page/.test(urlBranch) && /body:JSON\.stringify\(pageBody\)/.test(urlBranch), '页面链接回退 import-from-page');
ok(/const api = window\.pywebview && window\.pywebview\.api/.test(urlBranch) && /get_source_view_page_html/.test(urlBranch), '优先取内嵌浏览器已加载的页面 HTML');
ok(/typeof api\.get_source_view_page_html === 'function'/.test(urlBranch), '没有 page-html 方法时跳过取 HTML');
ok(/html:pageHtml, base_url:pageBaseUrl, folder:localAssetFolderPath\(\)/.test(urlBranch), '有 HTML 时 body 带 {url, html, base_url, folder}');
ok(/const pageBody = pageHtml[\s\S]*?: \{url:pageTarget, folder:localAssetFolderPath\(\)\}/.test(urlBranch), '没有 HTML 时退回 {url} 方式（用 pageTarget）');
ok(/if\(!files\.length && !pageHtml\)/.test(urlBranch) && /页面被反爬拦截，试试直接拖图片/.test(urlBranch), '无 HTML 且被反爬时给可操作提示');
ok(/text\\\/html\|不是图片或视频资源/.test(urlBranch), '后端报 text/html 时才走页面解析');
ok(/正在把素材保存到本地…/.test(urlBranch) && /正在从页面里找图片…/.test(urlBranch), '落地中 / 页面解析中的提示文案');
ok(/\[source-browser\]\[drop\]/.test(urlBranch) && /dropLog\('types:'/.test(urlBranch), '日志输出 dataTransfer types');
ok(/String\(url\)\.slice\(0, 200\)/.test(urlBranch), '候选 URL 每条截断 200 字符');
ok(/dropLog\('import-urls HTTP', response\.status/.test(urlBranch) && /dropLog\('import-urls', response\.status/.test(urlBranch), 'import-urls 记录 HTTP 状态与 error');
ok(/dropLog\('import-from-page HTTP', response\.status/.test(urlBranch), 'import-from-page 记录 HTTP 状态与 error');
ok(/dropLog\(channel \+ ':', fetched \?/.test(urlBranch) && /contentType:fetched\.contentType, size:fetched\.size/.test(urlBranch), 'fetch-bytes/fetch-url 记录 ok/status/error/contentType/size');
ok(/get_source_view_fetch_bytes/.test(urlBranch), '每个候选 import 失败后用 get_source_view_fetch_bytes 取字节');
ok(urlBranch.indexOf('(?:https?:|blob:)') >= 0, 'fetch-bytes 允许 blob: 地址');
ok(urlBranch.indexOf("if(!/^https?:\\/\\//i.test(text)) return text") >= 0, 'blob: 不经过归一化（非 http(s) 原样返回）');
ok(/dropLog\('tiers:', 'videos=' \+ tierState\.videos\.length, 'images=' \+ tierState\.images\.length, 'pages=' \+ tierState\.pages\.length, 'others=' \+ tierState\.others\.length\)/.test(urlBranch), '日志打印各档计数（videos/images/pages/others）');
ok(/dropLog\('page fallback target:', String\(pageTarget\)\.slice\(0, 200\), 'untried:'/.test(urlBranch), '页面兜底日志打印未尝试的候选');
ok(/\{ url:candidate, maxBytes:DROP_FETCH_BYTES_MAX \}/.test(urlBranch) && /get_source_view_fetch_bytes\(candidate, DROP_FETCH_BYTES_MAX\)/.test(urlBranch), '对象 / 位置两种入参都兼容');
ok(/data:fetched\.dataUrl/.test(urlBranch) && /content_type:String\(fetched\.contentType/.test(urlBranch) && /name:smartImageNameFromUrl\(candidate\)/.test(urlBranch), '拿到 dataUrl 走 base64 通道（data/content_type/name）');
ok(/从内嵌浏览器取素材失败/.test(urlBranch) && /（HTTP ' \+ status \+ '）/.test(urlBranch), 'fetch-bytes 失败 toast 具体原因含 status');
ok(/if\(!files\.length\)\{\s*toast\(downloadFailed \? tr\('smart\.toastImageDownloadFail'[\s\S]*?lastError/.test(urlBranch), '全部失败不建节点、toast 明确下载失败原因');
ok(/if\(!opts\.skipUndo\) pushUndo\(\);\s*appendImagesToSmartNode\(files\.map/.test(urlBranch), '只有落地成功才 pushUndo + 建节点');
ok(/url:file\.url/.test(urlBranch) && /kind:file\.kind === 'video' \? 'video' : 'image'/.test(urlBranch), '用返回的站内 url + kind 建节点');
ok(/payload\.type === 'files'/.test(dropFn) && /payload\.type === 'localPaths'/.test(dropFn), 'files / localPaths 分支保持原样');
ok(count(urlBranch, /\/api\/local-assets\/import-urls/g) === 2, 'import-urls 两处：正常落地 + base64 兜底');
ok(count(urlBranch, /\/api\/local-assets\/import-from-page/g) === 1, 'import-from-page 回退只出现一次');

console.log('');
console.log('素材浏览器回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
