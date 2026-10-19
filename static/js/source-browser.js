/* 素材浏览器（画布右上角入口 → 画布内的大面板，内容区接主进程 WebContentsView 叠层）。
   - 顶部三个来源 tab：选中滑块交给 shared/glide.js（.nv-glide-pill / --nv-glide-bg / --nv-glide-ms）；
     点 tab 时把选中胶囊用 FLIP（transform + border-radius）形变成下面的内容区，
     位移/尺寸全走 transform，不逐帧改宽高；prefers-reduced-motion 下只做淡入。
   - 内容区不再放 <webview>：量 #sourceBrowserView 的窗口坐标矩形，通知主进程把原生 WebContentsView 叠上来；
     形变期间先把原生视图挪出窗口（hide），落定后再 open/setBounds 对齐，避免原生层盖住形变过程。
   - 老 preload（只有伴生窗口的 open_source_browser）在本模块里 polyfill 成新方法名，退化为独立窗口；
     接口完全没有（网页版）时禁用 tab 并提示。
   - 开合进画布现有互斥体系：开自己时调 window.__novaCloseSmartSidePanels('source-browser')，
     其它面板打开时由 smart-canvas.js 的 closeSmartSidePanels() 调 window.__novaSourceBrowser.close()。 */
(function(){
    'use strict';
    const SOURCE_KEYS = ['pinterest', 'huaban', 'xiaohongshu', 'custom'];
    /* 「在系统浏览器打开」兜底用的来源地址（视图全白时用户能跳出去） */
    const SOURCE_URLS = {
        pinterest: 'https://www.pinterest.com/',
        huaban: 'https://huaban.com/',
        xiaohongshu: 'https://www.xiaohongshu.com/explore'
    };
    const FALLBACK_NAMES = { pinterest: 'Pinterest', huaban: '花瓣', xiaohongshu: '小红书', custom: '自定义' };
    const CUSTOM_RECENT_KEY = 'novai-source-custom-recent';
    const CUSTOM_RECENT_MAX = 5;
    const FALLBACK_UNSUPPORTED = '网页版不支持内置浏览器，请使用桌面客户端，或直接把图片从浏览器拖进画布';
    const FALLBACK_OPEN_FAILED = '打开素材浏览器失败';
    const FALLBACK_LOAD_FAILED = '页面加载失败';
    const FALLBACK_LOADING = '正在打开 {name}…';
    const FALLBACK_EXTERNAL_TIP = '{name} 已在独立窗口打开，把图片拖进画布即可';
    const FALLBACK_RELOAD_FAILED = '刷新失败';
    const MORPH_MS_FALLBACK = 260;
    const PANEL_MIN_WIDTH = 380;
    const PANEL_MAX_WIDTH = 900;
    const PANEL_WIDTH_KEY = 'novai-source-panel-width';
    const PANEL_MIN_HEIGHT = 400;
    const PANEL_HEIGHT_KEY = 'novai-source-panel-height';
    /* 形变期间把原生视图挪到窗口外：WebContentsView 是合成层，CSS 藏不住，只能改 bounds */
    const HIDDEN_RECT = { x: -20000, y: -20000, width: 8, height: 8 };
    const FULLSCREEN_MODE = false;

    let panel = null;
    let toggleBtn = null;
    let closeBtn = null;
    let tabsEl = null;
    let stageEl = null;
    let morphEl = null;
    let viewAnchorEl = null;
    let statusEl = null;
    let statusTextEl = null;
    let retryBtn = null;
    let reloadBtn = null;
    let externalBtn = null;
    let resizeHandle = null;
    let bottomResizeHandle = null;
    let cornerResizeHandle = null;
    let navGroupEl = null;
    let navBackBtn = null;
    let navForwardBtn = null;
    let navTimer = 0;
    let zoomGroupEl = null;
    let zoomPercentEl = null;
    let zoomOutBtn = null;
    let zoomInBtn = null;
    let zoomResetBtn = null;
    let customBarEl = null;
    let customUrlInput = null;
    let customOpenBtn = null;
    let customRecentEl = null;
    let placeholderEl = null;
    let unsupportedEl = null;

    let panelOpen = false;
    let closeSubscribed = false;
    let pendingOpenTimer = 0;
    let selectedKey = SOURCE_KEYS[0];
    let stageState = 'placeholder';
    let stageDetail = '';
    let externalOpenSource = '';
    let glideController = null;
    let morphAnim = null;
    let morphTimer = 0;
    let morphBusy = false;
    let toastTimer = 0;
    let boundsFrame = 0;
    let resizeObserver = null;
    let realignFrame = 0;
    let resizeSettleTimers = [];
    /* 正在跑的形变用的 tab/stage 矩形：布局变了才重开，否则每次对齐都会重播动画 */
    let morphRects = null;
    /* 用户拖出来的宽度偏好（px）；0 = 还没拖过，走 CSS 默认宽度 */
    let panelWidthPref = 0;
    let panelHeightPref = 0;
    let panelDragging = false;
    let customUrl = '';

    /* viewOverlay=true：主进程 WebContentsView 叠层；false：polyfill 出来的独立伴生窗口 */
    let viewApi = null;
    let viewOverlay = false;
    let nativeOpen = false;
    let nativeSource = '';
    let busy = false;

    function t(key, fallback){
        const value = window.StudioI18n && typeof window.StudioI18n.t === 'function' ? window.StudioI18n.t(key) : '';
        return value && value !== key ? value : fallback;
    }

    function rawApi(){
        return (window.pywebview && window.pywebview.api) || null;
    }

    /* 新 preload 有 open_source_view；老 preload 只有伴生窗口那套。
       contextBridge 暴露的对象是只读的，polyfill 只在本模块内包一层，不往原对象上挂属性。 */
    function resolveViewApi(){
        const api = rawApi();
        if(!api){
            viewApi = null;
            viewOverlay = false;
            return null;
        }
        if(typeof api.open_source_view === 'function'){
            viewOverlay = true;
            /* preload 签名：open_source_view(source, rect) / set_source_view_bounds(rect) */
            viewApi = {
                open: payload => api.open_source_view(payload.source, payload.rect, payload.url || ''),
                bounds: payload => (typeof api.set_source_view_bounds === 'function'
                    ? api.set_source_view_bounds(payload.rect)
                    : Promise.resolve({ ok: true })),
                close: () => (typeof api.close_source_view === 'function'
                    ? api.close_source_view()
                    : Promise.resolve({ ok: true, open: false })),
                state: () => (typeof api.get_source_view_state === 'function'
                    ? api.get_source_view_state()
                    : Promise.resolve({ ok: true, open: false }))
            };
            return viewApi;
        }
        if(typeof api.open_source_browser === 'function'){
            viewOverlay = false;
            viewApi = {
                open: payload => api.open_source_browser(payload && payload.source),
                bounds: () => Promise.resolve({ ok: true }),
                close: () => (typeof api.close_source_browser === 'function'
                    ? api.close_source_browser()
                    : Promise.resolve({ ok: true, open: false })),
                state: () => (typeof api.get_source_browser_state === 'function'
                    ? api.get_source_browser_state()
                    : Promise.resolve({ ok: true, open: false }))
            };
            return viewApi;
        }
        viewApi = null;
        viewOverlay = false;
        return null;
    }

    function tabs(){
        return tabsEl ? Array.from(tabsEl.querySelectorAll('[data-source-key]')) : [];
    }

    function tabEl(key){
        return tabs().find(tab => tab.dataset.sourceKey === key) || null;
    }

    function sourceName(key){
        return t('source.' + key, FALLBACK_NAMES[key] || key);
    }

    function reducedMotion(){
        return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function glideDuration(){
        try {
            const value = getComputedStyle(panel).getPropertyValue('--nv-glide-ms').trim();
            const parsed = parseFloat(value);
            if(Number.isFinite(parsed) && parsed > 0) return parsed;
        } catch(_) {}
        return MORPH_MS_FALLBACK;
    }

    function frameElement(){
        try { return window.frameElement || null; } catch(_) { return null; }
    }

    /* 父窗口（Vue 外壳）回给我们的可视区尺寸：帧内坐标只有换算到父窗口才准，越界时还要靠它收缩 */
    let parentViewport = { width: 0, height: 0 };

    function parentViewportSize(hasFrame){
        if(parentViewport.width > 0 && parentViewport.height > 0) return parentViewport;
        const width = Number(window.innerWidth) || 0;
        const height = Number(window.innerHeight) || 0;
        if(!hasFrame && width > 0 && height > 0) return { width, height };
        return { width, height };
    }

    /* 原生视图是叠在窗口最上层的，rect 一旦越界就会盖到侧栏/工具栏外面，所以先夹回可视区（越界收缩宽高） */
    function clampViewRect(rect, hasFrame){
        const viewport = parentViewportSize(hasFrame);
        if(!viewport.width || !viewport.height) return rect;
        const x = Math.max(0, Math.min(rect.x, Math.max(0, viewport.width - 1)));
        const y = Math.max(0, Math.min(rect.y, Math.max(0, viewport.height - 1)));
        return {
            x,
            y,
            width: Math.max(0, Math.min(rect.width, viewport.width - x)),
            height: Math.max(0, Math.min(rect.height, viewport.height - y))
        };
    }

    /* 内容区在「父窗口坐标系」里的矩形：画布本身在 iframe 里，要叠上 frameElement 的偏移，
       并且 iframe 被祖先 CSS 缩放过时，帧内 CSS px 不等于窗口 px，要乘 scale=fr.width/offsetWidth。 */
    function viewRect(){
        if(FULLSCREEN_MODE){
            const hasFrame = Boolean(frameElement());
            const viewport = parentViewportSize(hasFrame);
            const width = viewport.width || Number(window.innerWidth) || 0;
            const height = viewport.height || Number(window.innerHeight) || 0;
            return { x: 0, y: 0, width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) };
        }
        if(!viewAnchorEl) return { x: 0, y: 0, width: 0, height: 0 };
        const r = viewAnchorEl.getBoundingClientRect();
        const frame = frameElement();
        const hasFrame = Boolean(frame && typeof frame.getBoundingClientRect === 'function');
        let scale = 1;
        let x = r.left;
        let y = r.top;
        if(hasFrame){
            const fr = frame.getBoundingClientRect();
            const offsetWidth = Number(frame.offsetWidth) || 0;
            if(offsetWidth > 0){
                const computed = fr.width / offsetWidth;
                if(Number.isFinite(computed) && computed > 0) scale = computed;
            }
            x = fr.left + r.left * scale;
            y = fr.top + r.top * scale;
        }
        return clampViewRect({
            x: Math.round(x),
            y: Math.round(y),
            width: Math.max(0, Math.round(r.width * scale)),
            height: Math.max(0, Math.round(r.height * scale))
        }, hasFrame);
    }

    /* 外壳据此隐藏/恢复左侧导航；同时要一份父窗口可视区尺寸来夹 rect */
    function postToParent(payload){
        try {
            if(window.parent && window.parent !== window){
                window.parent.postMessage(payload, '*');
            }
        } catch(_) {}
    }

    function notifyParentOpen(open){
        postToParent({ type: 'novai:source-browser-panel', open: Boolean(open) });
    }

    function requestParentViewport(){
        postToParent({ type: 'novai:request-viewport' });
    }

    /* ── 面板宽度：拖右缘调整，夹在 [360, min(880, 78vw)]，松手记忆 ── */
    function viewportWidth(){
        if(parentViewport.width > 0) return parentViewport.width;
        return Number(window.innerWidth) || 0;
    }

    function panelMaxWidth(){
        const width = viewportWidth();
        const max = width > 0 ? Math.min(PANEL_MAX_WIDTH, width * 0.9) : PANEL_MAX_WIDTH;
        return Math.max(PANEL_MIN_WIDTH, Math.round(max));
    }

    function clampPanelWidth(width){
        const value = Number(width) || 0;
        return Math.min(Math.max(Math.round(value), PANEL_MIN_WIDTH), panelMaxWidth());
    }

    function currentPanelWidth(){
        if(!panel) return 0;
        const rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
        const width = rect && rect.width ? Math.round(rect.width) : 0;
        return width || panelWidthPref || PANEL_MIN_WIDTH;
    }

    function applyPanelWidth(width){
        if(FULLSCREEN_MODE || !panel) return 0;
        const clamped = clampPanelWidth(width);
        panelWidthPref = clamped;
        panel.style.setProperty('--source-browser-width', clamped + 'px');
        return clamped;
    }

    function loadPanelWidth(){
        if(FULLSCREEN_MODE) return;
        try {
            const saved = parseInt(window.localStorage && window.localStorage.getItem(PANEL_WIDTH_KEY), 10);
            if(Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH) applyPanelWidth(saved);
        } catch(_) {}
    }

    function savePanelWidth(){
        if(FULLSCREEN_MODE) return;
        try {
            if(window.localStorage) window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(panelWidthPref || currentPanelWidth())));
        } catch(_) {}
    }

    function panelMaxHeight(){
        const height = (parentViewportSize(Boolean(frameElement())).height) || Number(window.innerHeight) || 0;
        return height > 0 ? Math.min(1200, Math.max(PANEL_MIN_HEIGHT, Math.round(height * 0.9))) : PANEL_MIN_HEIGHT;
    }

    function currentPanelHeight(){
        if(!panel) return 0;
        const rect = panel.getBoundingClientRect();
        return Math.round(rect.height) || panelHeightPref || PANEL_MIN_HEIGHT;
    }

    function applyPanelHeight(height){
        if(FULLSCREEN_MODE || !panel) return 0;
        const clamped = Math.min(Math.max(Math.round(Number(height) || 0), PANEL_MIN_HEIGHT), panelMaxHeight());
        panelHeightPref = clamped;
        panel.style.setProperty('--source-browser-height', clamped + 'px');
        return clamped;
    }

    function loadPanelHeight(){
        if(FULLSCREEN_MODE) return;
        try {
            const saved = parseInt(window.localStorage && window.localStorage.getItem(PANEL_HEIGHT_KEY), 10);
            if(Number.isFinite(saved) && saved >= PANEL_MIN_HEIGHT) applyPanelHeight(saved);
        } catch(_) {}
    }

    function savePanelHeight(){
        if(FULLSCREEN_MODE) return;
        try {
            if(window.localStorage) window.localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(panelHeightPref || currentPanelHeight())));
        } catch(_) {}
    }

    /* ── 自定义网页：http(s) 校验、最近地址（localStorage，最多 5 条）、打开内嵌浏览器 ── */
    function normalizeHttpUrl(value){
        const text = String(value || '').trim();
        if(!text || /\s/.test(text)) return '';
        const withScheme = /^[a-z]+:\/\//i.test(text) ? text : 'https://' + text;
        try {
            const parsed = new URL(withScheme);
            if(!/^https?:$/i.test(parsed.protocol)) return '';
            const host = parsed.hostname || '';
            if(!host || (!host.includes('.') && host !== 'localhost')) return '';
            return parsed.toString();
        } catch(_) {
            return '';
        }
    }

    function recentCustomUrls(){
        try {
            const raw = window.localStorage && window.localStorage.getItem(CUSTOM_RECENT_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list.filter(url => normalizeHttpUrl(url)) : [];
        } catch(_) {
            return [];
        }
    }

    function saveCustomUrl(url){
        const normalized = normalizeHttpUrl(url);
        if(!normalized) return;
        const list = [normalized].concat(recentCustomUrls().filter(item => item !== normalized)).slice(0, CUSTOM_RECENT_MAX);
        try {
            if(window.localStorage) window.localStorage.setItem(CUSTOM_RECENT_KEY, JSON.stringify(list));
        } catch(_) {}
        renderCustomRecent();
    }

    function renderCustomRecent(){
        if(!customRecentEl) return;
        const list = recentCustomUrls();
        customRecentEl.hidden = !list.length;
        customRecentEl.innerHTML = list.map(url => '<button type="button" class="source-browser-custom-recent-item" data-custom-url="' + url.replace(/"/g, '&quot;') + '" title="' + url.replace(/"/g, '&quot;') + '">' + url.replace(/^https?:\/\//, '').slice(0, 42) + '</button>').join('');
    }

    function showCustomBar(show){
        if(customBarEl) customBarEl.hidden = !show;
        if(show) renderCustomRecent();
    }

    function openCustomUrl(){
        const inputValue = customUrlInput ? customUrlInput.value : customUrl;
        const normalized = normalizeHttpUrl(inputValue);
        if(!normalized){
            toast(t('source.customInvalid', '地址无效，请输入 http(s) 网页地址'));
            if(customUrlInput) customUrlInput.focus();
            return;
        }
        customUrl = normalized;
        if(customUrlInput) customUrlInput.value = normalized;
        saveCustomUrl(normalized);
        resolveViewApi();
        if(viewOverlay){
            openNativeView('custom', normalized);
            return;
        }
        if(viewApi){
            try { window.open(normalized, '_blank'); } catch(_) {}
            return;
        }
        setStage('unsupported');
    }

    /* 窗口/可视区尺寸变了：已拖过的宽度重新夹一遍（最大宽度 = min(900, 90vw)） */
    function refreshPanelWidthForViewport(){
        if(FULLSCREEN_MODE) return;
        if(panelWidthPref > 0) applyPanelWidth(panelWidthPref);
    }

    /* tab 的字体/品牌图加载完、面板宽度变化后：tab 实际 rect 会变，
       选中白底（glide 滑块）和形变起点都要按最新 rect 重算一次，否则白底会比 tab 宽/图标看起来偏左。 */
    function realignTabs(){
        if(!panel || !tabsEl) return;
        if(glideController && typeof glideController.refresh === 'function'){
            try { glideController.refresh(); } catch(_) {}
        }
        const active = tabEl(selectedKey);
        if(active && glideController && typeof glideController.setActive === 'function'){
            try { glideController.setActive(active, { instant: true }); } catch(_) {}
        }
        if(panelOpen && morphBusy && morphRectsChanged()){
            /* 形变正跑着且 tab/stage rect 真变了（字体/logo/宽度/窗口尺寸）：按最新 rect 重来一次，避免终点对不上 */
            runMorph();
        }
    }

    function morphRectsChanged(){
        if(!morphRects || !morphEl || !stageEl) return false;
        const active = tabEl(selectedKey);
        if(!active) return false;
        const stageRect = stageEl.getBoundingClientRect();
        const tabRect = active.getBoundingClientRect();
        if(stageRect.width <= 0 || tabRect.width <= 0) return false;
        const near = (a, b) => Math.abs(a - b) < 0.5;
        return !(
            near(tabRect.left, morphRects.tabLeft) && near(tabRect.top, morphRects.tabTop)
            && near(tabRect.width, morphRects.tabWidth) && near(tabRect.height, morphRects.tabHeight)
            && near(stageRect.left, morphRects.stageLeft) && near(stageRect.top, morphRects.stageTop)
            && near(stageRect.width, morphRects.stageWidth) && near(stageRect.height, morphRects.stageHeight)
        );
    }

    function scheduleRealignTabs(){
        if(realignFrame) return;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
        realignFrame = raf(() => {
            realignFrame = 0;
            realignTabs();
        });
    }

    /* resize 后布局可能分几拍落定：延迟再对几次原生视图 bounds（和 tab 对齐） */
    function settleBrowserGeometry(){
        resizeSettleTimers.forEach(id => clearTimeout(id));
        resizeSettleTimers = [120, 320, 640].map(delay => setTimeout(() => {
            scheduleRealignTabs();
            syncBounds();
        }, delay));
    }

    function setActiveTab(key, opts={}){
        const active = tabEl(key);
        tabs().forEach(tab => {
            const on = tab === active;
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
            tab.tabIndex = on ? 0 : -1;
        });
        if(glideController && active){
            try { glideController.setActive(active, { instant: Boolean(opts.instant) }); } catch(_) {}
        }
    }

    /* 与 smart-canvas.js 的 toast() 同一颗 #toast，同款显示时长 */
    function toast(text){
        const el = document.getElementById('toast');
        if(!el) return;
        el.textContent = String(text || '');
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function stageText(state){
        if(state === 'loading'){
            return t('source.loading', FALLBACK_LOADING).replace('{name}', sourceName(selectedKey));
        }
        if(state === 'failed') return stageDetail || t('source.loadFailed', FALLBACK_LOAD_FAILED);
        if(state === 'external'){
            return t('source.externalOpenTip', FALLBACK_EXTERNAL_TIP).replace('{name}', sourceName(externalOpenSource || selectedKey));
        }
        return '';
    }

    function setStage(state, detail=''){
        stageState = state;
        stageDetail = detail || '';
        if(!panel) return;
        if(placeholderEl) placeholderEl.hidden = state !== 'placeholder';
        if(unsupportedEl) unsupportedEl.hidden = state !== 'unsupported';
        if(statusEl){
            statusEl.hidden = !(state === 'loading' || state === 'failed' || state === 'external');
            statusEl.classList.toggle('is-loading', state === 'loading');
        }
        if(statusTextEl) statusTextEl.textContent = stageText(state);
        if(retryBtn) retryBtn.hidden = state !== 'failed';
        panel.classList.toggle('has-native-view', state === 'ready' && viewOverlay);
    }

    function revealSurface(){
        if(panel) panel.classList.add('is-revealed');
    }

    /* 形变期间隐藏原生视图（挪出窗口），落定后再由 onMorphSettled 打开/对齐 */
    function hideNativeView(){
        if(!viewOverlay || !nativeOpen || !viewApi) return;
        try {
            const pending = viewApi.bounds({ rect: HIDDEN_RECT });
            if(pending && pending.catch) pending.catch(() => {});
        } catch(_) {}
    }

    function syncBounds(){
        if(!viewOverlay || !nativeOpen || !viewApi || !panelOpen) return;
        const rect = viewRect();
        if(rect.width <= 0 || rect.height <= 0) return;
        try {
            const pending = viewApi.bounds({ rect });
            if(pending && pending.catch) pending.catch(() => {});
        } catch(_) {}
    }

    function scheduleSyncBounds(){
        if(boundsFrame) return;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
        boundsFrame = raf(() => {
            boundsFrame = 0;
            if(morphBusy) return;   /* 落定后 onMorphSettled 会再对一次 */
            syncBounds();
        });
    }

    async function openNativeView(key, url=''){
        if(!viewApi || !viewOverlay) return;
        if(busy) return;
        const rect = viewRect();
        if(rect.width <= 0 || rect.height <= 0) return;
        busy = true;
        setStage('loading');
        try {
            const result = await viewApi.open({ source: key, rect, url });
            if(result && result.open !== false){
                nativeOpen = true;
                nativeSource = String(result.source || key);
                setStage('ready');
                refreshNavState();
                if(result.error) console.debug('[source-browser] 原生视图已打开，首屏加载告警：' + result.error);
                syncBounds();   /* 形变结束再对一次，避免和打开过程错位 */
            } else {
                nativeOpen = false;
                nativeSource = '';
                const message = (result && result.error) || t('source.openFailed', FALLBACK_OPEN_FAILED);
                setStage('failed', message);
                toast(message);
            }
        } catch(error){
            nativeOpen = false;
            nativeSource = '';
            const message = error && error.message ? String(error.message) : t('source.openFailed', FALLBACK_OPEN_FAILED);
            setStage('failed', message);
            toast(message);
        } finally {
            busy = false;
        }
    }

    function closeNativeView(){
        const wasOpen = nativeOpen;
        nativeOpen = false;
        nativeSource = '';
        if(!wasOpen || !viewApi || !viewOverlay) return;
        try {
            const pending = viewApi.close();
            if(pending && pending.catch) pending.catch(() => {});
        } catch(_) {}
    }

    /* 老 preload 的退路：伴生窗口（task-7/task-8 那条链路） */
    async function openExternal(key){
        const api = rawApi();
        if(!api || typeof api.open_source_browser !== 'function'){ setStage('unsupported'); return; }
        if(busy) return;
        busy = true;
        setStage('loading');
        try {
            const result = await api.open_source_browser(key);
            if(result && result.open !== false){
                externalOpenSource = String(result.source || key);
                if(SOURCE_KEYS.indexOf(externalOpenSource) >= 0 && externalOpenSource !== selectedKey){
                    selectedKey = externalOpenSource;
                    setActiveTab(selectedKey);
                }
                setStage('external');
                if(result.error) console.debug('[source-browser] 窗口已打开，首屏加载告警：' + result.error);
            } else {
                const message = (result && result.error) || t('source.openFailed', FALLBACK_OPEN_FAILED);
                setStage('failed', message);
                toast(message);
            }
        } catch(error){
            const message = error && error.message ? String(error.message) : t('source.openFailed', FALLBACK_OPEN_FAILED);
            setStage('failed', message);
            toast(message);
        } finally {
            busy = false;
        }
    }

    function refreshExternalState(){
        const api = rawApi();
        if(!api || typeof api.get_source_browser_state !== 'function') return;
        api.get_source_browser_state().then(state => {
            if(!state || state.ok === false) return;
            if(state.open && state.source){
                externalOpenSource = String(state.source);
                if(SOURCE_KEYS.indexOf(externalOpenSource) >= 0 && externalOpenSource !== selectedKey){
                    selectedKey = externalOpenSource;
                    setActiveTab(selectedKey, { instant: true });
                }
                setStage('external');
                return;
            }
            externalOpenSource = '';
            if(!viewOverlay) setStage('placeholder');
        }).catch(() => {});
    }

    function syncEnvironment(){
        resolveViewApi();
        const supported = Boolean(viewApi);
        tabs().forEach(tab => { tab.disabled = !supported && tab.dataset.sourceKey !== 'custom'; });
        if(!supported){
            setStage('unsupported');
            return;
        }
        if(viewOverlay){
            if(nativeOpen && nativeSource === selectedKey) setStage('ready');
            else if(stageState === 'ready' || stageState === 'failed') setStage('placeholder');
            return;
        }
        setStage(externalOpenSource ? 'external' : 'placeholder');
    }

    /* tab 胶囊 → 内容区的 shared morph：幽灵块按内容区尺寸放好，
       用 transform 反向映射回被点的 tab 矩形，再动画回 identity；border-radius 同步从胶囊圆角过渡到面板圆角。 */
    function runMorph(){
        if(!panel || !panelOpen) return;
        morphBusy = true;
        if(viewOverlay && nativeOpen) hideNativeView();
        clearTimeout(morphTimer);
        const wait = reducedMotion() ? 0 : glideDuration();
        morphTimer = setTimeout(() => {
            morphTimer = 0;
            morphBusy = false;
            onMorphSettled();
        }, wait + 16);
        if(!morphEl || !stageEl) return;
        const active = tabEl(selectedKey);
        if(!active) return;
        if(reducedMotion() || typeof morphEl.animate !== 'function'){
            morphEl.style.opacity = '0';
            return;
        }
        const stageRect = stageEl.getBoundingClientRect();
        const tabRect = active.getBoundingClientRect();
        if(stageRect.width <= 0 || stageRect.height <= 0 || tabRect.width <= 0 || tabRect.height <= 0) return;
        morphRects = {
            tabLeft: tabRect.left, tabTop: tabRect.top, tabWidth: tabRect.width, tabHeight: tabRect.height,
            stageLeft: stageRect.left, stageTop: stageRect.top, stageWidth: stageRect.width, stageHeight: stageRect.height
        };
        const sx = tabRect.width / stageRect.width;
        const sy = tabRect.height / stageRect.height;
        const dx = tabRect.left - stageRect.left;
        const dy = tabRect.top - stageRect.top;
        let radius = '16px';
        try { radius = getComputedStyle(stageEl).borderRadius || radius; } catch(_) {}
        if(morphAnim && typeof morphAnim.cancel === 'function'){
            try { morphAnim.cancel(); } catch(_) {}
        }
        morphEl.style.opacity = '1';
        const anim = morphEl.animate([
            { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')', borderRadius: '999px' },
            { transform: 'translate(0px, 0px) scale(1, 1)', borderRadius: radius }
        ], {
            duration: glideDuration(),
            easing: 'cubic-bezier(.23, 1, .32, 1)',
            fill: 'both'
        });
        morphAnim = anim;
        anim.onfinish = () => {
            if(morphAnim !== anim) return;
            morphAnim = null;
            morphEl.style.opacity = '0';
        };
    }

    /* 形变落定：原生视图该开的开、已开的再对一次 rect */
    function onMorphSettled(){
        if(!panelOpen) return;
        if(selectedKey === 'custom'){
            showCustomBar(true);
            setStage('placeholder');
            return;
        }
        if(!viewApi) resolveViewApi();
        if(!viewApi) return;
        if(!viewOverlay) return;
        if(nativeOpen && nativeSource === selectedKey){
            syncBounds();
            return;
        }
        openNativeView(selectedKey);
    }

    function selectSource(key){
        const tab = tabEl(key);
        if(!panel || !tab || tab.disabled) return;
        selectedKey = key;
        setActiveTab(key);
        showCustomBar(key === 'custom');
        if(!panelOpen) return;
        resolveViewApi();
        revealSurface();
        if(key === 'custom'){
            setStage('placeholder');
            return;
        }
        if(viewOverlay){
            if(nativeOpen && nativeSource === key){ syncBounds(); return; }
            const api = rawApi();
            if(nativeOpen && api && typeof api.switch_source_site === 'function'){
                try {
                    Promise.resolve(api.switch_source_site(key)).then(result => {
                        if(result && result.ok === false){ openNativeView(key); return; }
                        nativeSource = key;
                        setStage('ready');
                        syncBounds();
                        setTimeout(refreshNavState, 260);
                    }).catch(() => openNativeView(key));
                    return;
                } catch(_) {}
            }
            openNativeView(key);
            return;
        }
        if(viewApi){ openExternal(key); return; }
        setStage('unsupported');
    }

    function retrySelectedSource(){
        if(selectedKey === 'custom'){ openCustomUrl(); return; }
        resolveViewApi();
        if(!viewApi){ setStage('unsupported'); return; }
        if(viewOverlay){ openNativeView(selectedKey); return; }
        openExternal(selectedKey);
    }

    /* 刷新按钮只在 main/preload 提供 reload_source_view 时出现（老版本没有就隐藏） */
    function syncHeaderActions(){
        const api = rawApi();
        if(reloadBtn) reloadBtn.hidden = !(api && (typeof api.source_reload === 'function' || typeof api.reload_source_view === 'function'));
        if(zoomGroupEl) zoomGroupEl.hidden = !canControlZoom();
        const navApi = rawApi();
        if(navGroupEl) navGroupEl.hidden = false;
        if(canNavigate() && navApi && typeof navApi.get_source_view_state === 'function'){
            refreshNavState();
        } else if(navBackBtn || navForwardBtn){
            if(navBackBtn) navBackBtn.disabled = true;
            if(navForwardBtn) navForwardBtn.disabled = true;
        }
    }

    async function reloadNativeView(){
        const api = rawApi();
        const reload = api && (typeof api.source_reload === 'function' ? api.source_reload : (typeof api.reload_source_view === 'function' ? api.reload_source_view : null));
        if(!reload) return;
        try {
            const result = await reload.call(api);
            if(result && result.ok === false){
                toast(result.error || t('source.reloadFailed', FALLBACK_RELOAD_FAILED));
            }
            setTimeout(refreshNavState, 300);
        } catch(error){
            toast(error && error.message ? String(error.message) : t('source.reloadFailed', FALLBACK_RELOAD_FAILED));
        }
    }

    /* 网页缩放：主进程 IPC action=source-zoom（in/out/reset），percent 以返回值为准 */
    /* 前进/后退：状态来自 get_source_view_state().canGoBack/canGoForward；跳转后轮询刷新 */
    function canNavigate(){
        const api = rawApi();
        return Boolean(api && (typeof api.source_go_back === 'function' || typeof api.source_go_forward === 'function' || typeof api.set_source_nav === 'function' || typeof api.source_nav === 'function'));
    }

    function applyNavState(state){
        const canBack = Boolean(state && state.canGoBack);
        const canForward = Boolean(state && state.canGoForward);
        if(navBackBtn) navBackBtn.disabled = !canBack;
        if(navForwardBtn) navForwardBtn.disabled = !canForward;
    }

    function refreshNavState(){
        const api = rawApi();
        if(!api || typeof api.get_source_view_state !== 'function') return Promise.resolve();
        return Promise.resolve(api.get_source_view_state()).then(state => {
            if(state && state.ok === false) return;
            applyNavState(state);
            return state;
        }).catch(() => {});
    }

    function navigateSource(action){
        if(!canNavigate()) return;
        const api = rawApi();
        let pending = null;
        try {
            if(action === 'back' && typeof api.source_go_back === 'function') pending = api.source_go_back();
            else if(action === 'forward' && typeof api.source_go_forward === 'function') pending = api.source_go_forward();
            else if(typeof api.set_source_nav === 'function') pending = api.set_source_nav(action);
            else if(typeof api.source_nav === 'function') pending = api.source_nav(action);
        } catch(_) { return; }
        Promise.resolve(pending).then(() => setTimeout(refreshNavState, 220)).catch(() => {});
    }

    function startNavPolling(){
        if(navTimer || !canNavigate()) return;
        navTimer = setInterval(() => {
            if(panelOpen) refreshNavState();
        }, 1200);
    }

    function stopNavPolling(){
        if(navTimer){ clearInterval(navTimer); navTimer = 0; }
    }

    function canControlZoom(){
        const api = rawApi();
        return Boolean(api && (typeof api.set_source_zoom === 'function' || typeof api.source_zoom_in === 'function' || typeof api.source_zoom_out === 'function'));
    }

    function applySourceZoom(action){
        const api = rawApi();
        if(!api) return;
        let pending = null;
        try {
            if(typeof api.set_source_zoom === 'function') pending = api.set_source_zoom(action);
            else if(action === 'in' && typeof api.source_zoom_in === 'function') pending = api.source_zoom_in();
            else if(action === 'out' && typeof api.source_zoom_out === 'function') pending = api.source_zoom_out();
            else if(action === 'reset' && typeof api.source_zoom_reset === 'function') pending = api.source_zoom_reset();
        } catch(error){
            console.debug('[source-browser] source zoom failed: ' + (error && error.message ? error.message : error));
            return;
        }
        Promise.resolve(pending).then(result => {
            if(result && result.ok === false) return;
            if(zoomPercentEl && result && result.percent !== undefined){
                zoomPercentEl.textContent = Math.round(Number(result.percent) || 100) + '%';
            }
        }).catch(error => {
            console.debug('[source-browser] source zoom failed: ' + (error && error.message ? error.message : error));
        });
    }

    /* 视图内白屏/登录卡住时的兜底：直接在新窗口打开来源站点（Electron 会转给系统浏览器） */
    function openInSystemBrowser(){
        const url = selectedKey === 'custom' ? (normalizeHttpUrl(customUrl || (customUrlInput && customUrlInput.value)) || '') : SOURCE_URLS[selectedKey];
        if(!url) return;
        try {
            window.open(url, '_blank');
        } catch(error){
            console.debug('[source-browser] 系统浏览器打开失败：' + (error && error.message ? error.message : error));
        }
    }

    function openPanel(){
        if(!panel || panelOpen) return;
        resolveViewApi();
        panelOpen = true;
        /* 先落状态再收其它面板：closeSmartSidePanels 会跳过 source-browser 自己 */
        if(typeof window.__novaCloseSmartSidePanels === 'function'){
            window.__novaCloseSmartSidePanels('source-browser');
        }
        panel.classList.add('open');
        if(toggleBtn){
            toggleBtn.classList.add('active');
            toggleBtn.setAttribute('aria-expanded', 'true');
        }
        if(SOURCE_KEYS.indexOf(selectedKey) < 0) selectedKey = SOURCE_KEYS[0];
        if(document.body){
            document.body.classList.add('source-browser-open');
            if(FULLSCREEN_MODE) document.body.classList.add('source-fullscreen');
        }
        panel.classList.toggle('is-fullscreen', FULLSCREEN_MODE);
        panel.classList.toggle('is-fallback', !viewOverlay);
        notifyParentOpen(true);
        requestParentViewport();
        setActiveTab(selectedKey, { instant: true });
        showCustomBar(selectedKey === 'custom');
        startNavPolling();
        refreshNavState();
        syncEnvironment();
        panel.classList.remove('is-revealed');
        requestAnimationFrame(() => {
            if(!panelOpen) return;
            revealSurface();
            if(viewOverlay){
                /* 等 .open 的位移动画落定再量 rect，否则首次 bounds 会按滑动中的位置算 */
                setStage('loading');
                if(pendingOpenTimer) clearTimeout(pendingOpenTimer);
                pendingOpenTimer = setTimeout(() => {
                    pendingOpenTimer = 0;
                    if(!panelOpen) return;
                    openNativeView(selectedKey);
                    syncBounds();
                    scheduleSyncBounds();
                }, 240);
            } else if(!viewApi){
                setStage('unsupported');
            } else {
                refreshExternalState();
                syncBounds();
                scheduleSyncBounds();
            }
        });
    }

    function closePanel(){
        if(!panel || !panelOpen) return;
        stopNavPolling();
        if(pendingOpenTimer){ clearTimeout(pendingOpenTimer); pendingOpenTimer = 0; }
        panelOpen = false;
        if(morphTimer){ clearTimeout(morphTimer); morphTimer = 0; }
        morphBusy = false;
        closeNativeView();
        if(document.body){
            document.body.classList.remove('source-browser-open');
            document.body.classList.remove('source-fullscreen');
        }
        notifyParentOpen(false);
        panel.classList.remove('open');
        panel.classList.remove('is-fullscreen');
        panel.classList.remove('is-fallback');
        panel.classList.remove('is-revealed');
        panel.classList.remove('has-native-view');
        if(toggleBtn){
            toggleBtn.classList.remove('active');
            toggleBtn.setAttribute('aria-expanded', 'false');
        }
        if(morphAnim && typeof morphAnim.cancel === 'function'){
            try { morphAnim.cancel(); } catch(_) {}
        }
        morphAnim = null;
        if(morphEl) morphEl.style.opacity = '0';
    }

    function togglePanel(){
        if(panelOpen) closePanel();
        else openPanel();
    }

    /* 主进程注入的 × 按钮：优先订阅 pywebview 事件；closePanel 自带 panelOpen 防重入 */
    function bindSourceViewClosedSubscription(){
        const api = rawApi();
        if(closeSubscribed || !api || typeof api.on_source_view_closed !== 'function') return;
        try {
            api.on_source_view_closed(payload => {
                if(payload && payload.open === true) return;
                closePanel();
            });
            closeSubscribed = true;
        } catch(error){
            console.debug('[source-browser] on_source_view_closed subscribe failed: ' + (error && error.message ? error.message : error));
        }
    }

    /* 全窗口模式：主进程注入的 × 按钮通过 IPC/消息回调关闭面板 */
    window.__novaSourceBrowserClose = function(){ closePanel(); };
    window.addEventListener('message', event => {
        const data = event && event.data;
        if(!data || typeof data !== 'object') return;
        if(data.type === 'novai:source-view-closed' || data.type === 'source-view-closed' || data.type === 'novai:source-view-close' || data.type === 'source-view-close' || data.type === 'novai:source-close'){
            closePanel();
        }
    });
    document.addEventListener('novai:source-view-close', function(){ closePanel(); });

    /* 面板尺寸/位置变化：窗口 resize（顺带重问父窗口尺寸）+ 面板/内容区尺寸变化都重新 setBounds */
    function onViewportChanged(){
        requestParentViewport();
        refreshPanelWidthForViewport();
        scheduleRealignTabs();
        scheduleSyncBounds();
        settleBrowserGeometry();
    }

    function bindBoundsSync(){
        window.addEventListener('resize', onViewportChanged);
        /* 移动端/缩放场景 visualViewport 比 window.resize 更准 */
        if(window.visualViewport && typeof window.visualViewport.addEventListener === 'function'){
            window.visualViewport.addEventListener('resize', onViewportChanged);
        }
        if(typeof ResizeObserver !== 'function' || !viewAnchorEl) return;
        resizeObserver = new ResizeObserver(() => {
            if(!panelOpen) return;
            if(morphBusy) return;
            scheduleRealignTabs();
            scheduleSyncBounds();
        });
        resizeObserver.observe(viewAnchorEl);
        if(panel) resizeObserver.observe(panel);
    }

    /* 父窗口回可视区尺寸：收到后重新夹 rect、夹面板宽度，并重新对齐 tab */
    function bindParentMessages(){
        window.addEventListener('message', event => {
            const data = event && event.data;
            if(!data || data.type !== 'novai:viewport') return;
            parentViewport = {
                width: Math.max(0, Number(data.width) || 0),
                height: Math.max(0, Number(data.height) || 0)
            };
            refreshPanelWidthForViewport();
            scheduleRealignTabs();
            scheduleSyncBounds();
        });
    }

    /* 右缘拖拽（6px 透明热区）：左右拖改宽度，拖动期间原生视图实时跟手，松手记忆 */
    function bindPanelResize(){
        if(FULLSCREEN_MODE) return;
        if(!resizeHandle || !panel) return;
        let drag = null;
        const onMove = event => {
            if(!drag) return;
            const next = drag.startWidth + (Number(event.clientX) - drag.startX);
            applyPanelWidth(next);
            scheduleRealignTabs();
            syncBounds();
        };
        const onEnd = () => {
            if(!drag) return;
            drag = null;
            panel.classList.remove('is-resizing');
            if(document.body) document.body.style.userSelect = '';
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onEnd, true);
            window.removeEventListener('pointercancel', onEnd, true);
            savePanelWidth();
            scheduleRealignTabs();
            syncBounds();
        };
        const onStart = event => {
            if(event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            drag = { startX: Number(event.clientX) || 0, startWidth: currentPanelWidth() };
            panel.classList.add('is-resizing');
            if(document.body) document.body.style.userSelect = 'none';
            try {
                if(resizeHandle.setPointerCapture && event.pointerId !== undefined){
                    resizeHandle.setPointerCapture(event.pointerId);
                }
            } catch(_) {}
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onEnd, true);
            window.addEventListener('pointercancel', onEnd, true);
        };
        resizeHandle.addEventListener('pointerdown', onStart);
    }

    /* 底边拖拽：上下拖改高度，拖动期间同步原生视图 bounds，松手记忆 */
    function bindPanelHeightResize(){
        if(FULLSCREEN_MODE) return;
        if(!bottomResizeHandle || !panel) return;
        let drag = null;
        const onMove = event => {
            if(!drag) return;
            const next = drag.startHeight + (Number(event.clientY) - drag.startY);
            applyPanelHeight(next);
            scheduleRealignTabs();
            syncBounds();
        };
        const onEnd = () => {
            if(!drag) return;
            drag = null;
            panel.classList.remove('is-resizing-height');
            if(document.body) document.body.style.userSelect = '';
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onEnd, true);
            window.removeEventListener('pointercancel', onEnd, true);
            savePanelHeight();
            scheduleRealignTabs();
            syncBounds();
        };
        const onStart = event => {
            if(event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            drag = { startY: Number(event.clientY) || 0, startHeight: currentPanelHeight() };
            panel.classList.add('is-resizing-height');
            if(document.body) document.body.style.userSelect = 'none';
            try {
                if(bottomResizeHandle.setPointerCapture && event.pointerId !== undefined){
                    bottomResizeHandle.setPointerCapture(event.pointerId);
                }
            } catch(_) {}
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onEnd, true);
            window.addEventListener('pointercancel', onEnd, true);
        };
        bottomResizeHandle.addEventListener('pointerdown', onStart);
    }

    /* 右下角 20×20 手柄：同时改宽高（最小 380×400，最大 min(90vw,900) × min(90vh,1200)） */
    function bindPanelCornerResize(){
        if(FULLSCREEN_MODE) return;
        if(!cornerResizeHandle || !panel) return;
        let drag = null;
        const onMove = event => {
            if(!drag) return;
            applyPanelWidth(drag.startWidth + (Number(event.clientX) - drag.startX));
            applyPanelHeight(drag.startHeight + (Number(event.clientY) - drag.startY));
            scheduleRealignTabs();
            syncBounds();
        };
        const onEnd = () => {
            if(!drag) return;
            drag = null;
            panel.classList.remove('is-resizing-corner');
            if(document.body) document.body.style.userSelect = '';
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onEnd, true);
            window.removeEventListener('pointercancel', onEnd, true);
            savePanelWidth();
            savePanelHeight();
            scheduleRealignTabs();
            syncBounds();
        };
        const onStart = event => {
            if(event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            drag = { startX: Number(event.clientX) || 0, startY: Number(event.clientY) || 0, startWidth: currentPanelWidth(), startHeight: currentPanelHeight() };
            panel.classList.add('is-resizing-corner');
            if(document.body) document.body.style.userSelect = 'none';
            try {
                if(cornerResizeHandle.setPointerCapture && event.pointerId !== undefined) cornerResizeHandle.setPointerCapture(event.pointerId);
            } catch(_) {}
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onEnd, true);
            window.addEventListener('pointercancel', onEnd, true);
        };
        cornerResizeHandle.addEventListener('pointerdown', onStart);
    }

    function init(){
        panel = document.getElementById('sourceBrowserPanel');
        toggleBtn = document.getElementById('sourceBrowserToggle');
        if(!panel || !toggleBtn) return;
        closeBtn = document.getElementById('sourceBrowserCloseBtn');
        tabsEl = document.getElementById('sourceBrowserTabs');
        stageEl = document.getElementById('sourceBrowserStage');
        morphEl = document.getElementById('sourceBrowserMorph');
        viewAnchorEl = document.getElementById('sourceBrowserView');
        statusEl = document.getElementById('sourceBrowserStatus');
        statusTextEl = document.getElementById('sourceBrowserStatusText');
        retryBtn = document.getElementById('sourceBrowserRetryBtn');
        reloadBtn = document.getElementById('sourceBrowserReloadBtn');
        externalBtn = document.getElementById('sourceBrowserExternalBtn');
        resizeHandle = document.getElementById('sourceBrowserResizeHandle');
        bottomResizeHandle = document.getElementById('sourceBrowserBottomResize');
        cornerResizeHandle = document.getElementById('sourceBrowserCornerResize');
        navGroupEl = document.getElementById('sourceBrowserNav');
        navBackBtn = document.getElementById('sourceBrowserBack');
        navForwardBtn = document.getElementById('sourceBrowserForward');
        zoomGroupEl = document.getElementById('sourceBrowserZoom');
        zoomPercentEl = document.getElementById('sourceBrowserZoomPercent');
        zoomOutBtn = document.getElementById('sourceBrowserZoomOut');
        zoomInBtn = document.getElementById('sourceBrowserZoomIn');
        zoomResetBtn = document.getElementById('sourceBrowserZoomReset');
        customBarEl = document.getElementById('sourceBrowserCustomBar');
        customUrlInput = document.getElementById('sourceBrowserCustomUrl');
        customOpenBtn = document.getElementById('sourceBrowserCustomOpen');
        customRecentEl = document.getElementById('sourceBrowserCustomRecent');
        placeholderEl = document.getElementById('sourceBrowserPlaceholder');
        unsupportedEl = document.getElementById('sourceBrowserUnsupported');

        /* tab 选中滑块复用 shared/glide.js；pin 用 setActive 维护，悬停临时跟手，移开回到选中项 */
        if(tabsEl && window.NovaGlide && typeof window.NovaGlide.attach === 'function'){
            glideController = window.NovaGlide.attach(tabsEl, {
                item: '.source-browser-tab',
                orientation: 'horizontal',
                duration: MORPH_MS_FALLBACK
            });
        }
        tabs().forEach(tab => {
            tab.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                selectSource(tab.dataset.sourceKey);
            });
        });
        toggleBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            togglePanel();
        });
        if(closeBtn) closeBtn.addEventListener('click', event => {
            event.preventDefault();
            closePanel();
        });
        if(retryBtn) retryBtn.addEventListener('click', event => {
            event.preventDefault();
            retrySelectedSource();
        });
        if(reloadBtn) reloadBtn.addEventListener('click', event => {
            event.preventDefault();
            reloadNativeView();
        });
        if(externalBtn) externalBtn.addEventListener('click', event => {
            event.preventDefault();
            openInSystemBrowser();
        });
        if(navBackBtn) navBackBtn.addEventListener('click', event => { event.preventDefault(); navigateSource('back'); });
        if(navForwardBtn) navForwardBtn.addEventListener('click', event => { event.preventDefault(); navigateSource('forward'); });
        if(zoomOutBtn) zoomOutBtn.addEventListener('click', event => { event.preventDefault(); applySourceZoom('out'); });
        if(zoomInBtn) zoomInBtn.addEventListener('click', event => { event.preventDefault(); applySourceZoom('in'); });
        if(zoomResetBtn) zoomResetBtn.addEventListener('click', event => { event.preventDefault(); applySourceZoom('reset'); });
        if(customOpenBtn) customOpenBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openCustomUrl();
        });
        if(customUrlInput) customUrlInput.addEventListener('keydown', event => {
            if(event.key !== 'Enter') return;
            event.preventDefault();
            openCustomUrl();
        });
        if(customRecentEl) customRecentEl.addEventListener('click', event => {
            const item = event.target.closest('[data-custom-url]');
            if(!item) return;
            event.preventDefault();
            if(customUrlInput) customUrlInput.value = item.dataset.customUrl || '';
            openCustomUrl();
        });
        /* 面板内操作不要穿透到画布（与 #assetPanel 一致） */
        ['pointerdown', 'mousedown', 'click', 'wheel'].forEach(type => {
            panel.addEventListener(type, event => event.stopPropagation());
        });
        window.addEventListener('keydown', event => {
            if(!panelOpen) return;
            if((event.ctrlKey || event.metaKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')){
                event.preventDefault();
                event.stopImmediatePropagation();
                navigateSource(event.key === 'ArrowLeft' ? 'back' : 'forward');
                return;
            }
            if((event.ctrlKey || event.metaKey) && ['=', '+', '-', '_', '0'].indexOf(event.key) >= 0){
                event.preventDefault();
                event.stopImmediatePropagation();
                applySourceZoom(event.key === '-' || event.key === '_' ? 'out' : (event.key === '0' ? 'reset' : 'in'));
                return;
            }
            if(event.key !== 'Escape') return;
            event.stopImmediatePropagation();
            closePanel();
        });
        window.addEventListener('pywebviewready', () => {
            resolveViewApi();
            bindSourceViewClosedSubscription();
            syncHeaderActions();
            syncEnvironment();
            if(!panelOpen) return;
            if(viewOverlay){
                if(nativeOpen) syncBounds();
                else runMorph();
            } else if(viewApi){
                refreshExternalState();
            }
        });
        window.addEventListener('studio-lang-change', () => setStage(stageState, stageDetail));
        bindBoundsSync();
        bindParentMessages();
        bindSourceViewClosedSubscription();
        if(!FULLSCREEN_MODE){
            loadPanelWidth();
            loadPanelHeight();
            bindPanelResize();
            bindPanelHeightResize();
            bindPanelCornerResize();
        }
        renderCustomRecent();
        if(document.body) document.body.classList.remove('source-browser-open');
        setActiveTab(selectedKey, { instant: true });
        syncEnvironment();
        syncHeaderActions();
        /* 字体/品牌 logo 加载完 tab rect 才稳定：重新对齐一次滑块与形变起点 */
        if(document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function'){
            document.fonts.ready.then(() => { scheduleRealignTabs(); syncBounds(); }).catch(() => {});
        }
        window.addEventListener('load', () => {
            if(!panelOpen) return;
            scheduleRealignTabs();
            syncBounds();
        });
    }

    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.__novaSourceBrowser = {
        open: openPanel,
        close: closePanel,
        toggle: togglePanel,
        isOpen: () => panelOpen,
        rect: () => viewRect(),
        sources: SOURCE_KEYS.slice()
    };
})();
