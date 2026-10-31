// 新外壳 ↔ 旧页面（iframe）桥接：沿用旧 index.html 的全部消息协议，旧页面不用改一行就能嵌进来。
//   外壳 → 页面：studio-theme / studio-lang / studio-ui-scale / studio-ui-scale-pause / canvas-focus / open-canvas
//               providers-changed / workflows-changed / comfy-instances-changed（设置变更转发）
//               cloud_status / canvas_updated（发给当前页）/ asset_library_updated（发给所有页）
//   页面 → 外壳：navigate {route, canvasId?} / settings-iframe-overlay {open}
import { state, PAGE_IDS, rememberActive } from './store.js';

const listeners = { overlay: [] };
export function onSettingsOverlay(fn) { listeners.overlay.push(fn); }

export function frameEl(id) { return document.getElementById('frame-' + id); }
function allFrames() { return Array.from(document.querySelectorAll('iframe')); }
function post(frame, data) { try { frame && frame.contentWindow && frame.contentWindow.postMessage(data, '*'); } catch (e) {} }

// 回给画布 iframe 当前视口尺寸（素材浏览器面板切左右布局时要用）
function replyViewport(source) {
    const target = source && typeof source.postMessage === 'function' ? source : null;
    if (!target) return;
    try {
        target.postMessage({ type: 'novai:viewport', width: window.innerWidth, height: window.innerHeight }, '*');
    } catch (e) {}
}

export function syncFrame(frame) {
    const theme = window.StudioTheme ? window.StudioTheme.get() : state.theme;
    post(frame, { type: 'studio-theme', theme });
    if (window.StudioI18n) post(frame, { type: 'studio-lang', lang: window.StudioI18n.lang() });
    const mode = window.StudioScale ? window.StudioScale.getMode() : 'auto';
    const css = Number(getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale'));
    const scale = Number.isFinite(css) && css > 0 ? css : (window.StudioScale ? window.StudioScale.getScale() : 1);
    post(frame, { type: 'studio-ui-scale', mode, scale });
}
export function broadcast(data) { allFrames().forEach(f => post(f, data)); }
export function pauseScale(duration = 650) { broadcast({ type: 'studio-ui-scale-pause', duration }); }

export function navigate(id, opts = {}) {
    if (!PAGE_IDS.includes(id)) id = 'home';
    // API 设置 / 工作流设置已并入设置弹窗
    if (id === 'api-settings' || id === 'comfyui-settings') { state.settingsTab = id; state.settingsOpen = true; return; }
    const wasVisited = !!state.visited[id];
    state.visited[id] = true;
    state.active = id;
    if (!opts.skipRemember) rememberActive(id);
    // 与旧外壳一致：切回画布 / 首页时让它们刷新列表
    if (wasVisited && id === 'canvas') {
        if (state.canvasOpen) post(frameEl('canvas'), { type: 'canvas-focus' });
        else window.dispatchEvent(new CustomEvent('novai-canvas-focus'));
    }
    // 与旧外壳一致：切回首页时让它刷新最近项目
    if (wasVisited && id === 'home') post(frameEl('home'), { type: 'canvas-focus' });
    // Vue 页面切回时刷新数据（各页监听 novai-page-focus）
    if (wasVisited) window.dispatchEvent(new CustomEvent('novai-page-focus', { detail: { id } }));
}

// 直接把「画布」页的 iframe 指到某张画布（首页、素材库「定位」都会用）
export function openCanvasUrl(url) {
    state.canvasOpen = true;
    navigate('canvas');
    state.frameSrc.canvas = url;
}

// 回到画布列表（编辑器里点「画布列表」会把 iframe 指回旧列表页，LegacyStage 检测到后调用这里）
export function closeCanvas() {
    state.canvasOpen = false;
    const el = frameEl('canvas');
    if (el) { el.removeAttribute('src'); try { el.contentWindow.location.replace('about:blank'); } catch (e) {} }
    window.dispatchEvent(new CustomEvent('novai-canvas-focus'));
}

export function openLegacyWithCanvasId(route, canvasId) {
    if (route === 'canvas') { window.dispatchEvent(new CustomEvent('novai-open-canvas-id', { detail: { canvasId } })); return; }
    setTimeout(() => post(frameEl(route), { type: 'open-canvas', canvasId }), 300);
}

function forwardStudioApiChange(data) {
    if (!data || !['providers-changed', 'workflows-changed', 'comfy-instances-changed'].includes(data.type)) return;
    broadcast(data);
}

function onMessage(event) {
    if (event.origin && event.origin !== location.origin) return;
    const d = event.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'navigate' && d.route) {
        if (!PAGE_IDS.includes(d.route)) return;
        navigate(d.route);
        if (d.canvasId) openLegacyWithCanvasId(d.route, d.canvasId);
        return;
    }
    if (d.type === 'open-settings') {
        state.settingsTab = typeof d.tab === 'string' ? d.tab : 'general';
        state.settingsOpen = true;
        return;
    }
    if (d.type === 'settings-iframe-overlay') {
        listeners.overlay.forEach(fn => fn(!!d.open, event.source));
        return;
    }
    // 画布里的素材浏览器面板开合：打开时外壳隐藏左侧导航、画布铺满；只在画布页生效
    if (d.type === 'novai:source-browser-panel') {
        const onCanvas = state.active === 'canvas' && state.canvasOpen;
        state.sourcePanelOpen = onCanvas ? !!d.open : false;
        replyViewport(event.source);
        // 侧栏淡出 180ms，落定后再回一次最终视口
        setTimeout(() => replyViewport(event.source), 260);
        return;
    }
    if (d.type === 'novai:request-viewport') {
        replyViewport(event.source);
        return;
    }
    forwardStudioApiChange(d);
}

// 旧页面会直接操作 parent.document.getElementById('frame-canvas').src 来打开画布（首页、素材库）；
// iframe 沿用 frame-<id> 的 id，所以这条路径在新外壳里照样成立。

function clientId() {
    let cid = null;
    try { cid = localStorage.getItem('client_id'); } catch (e) {}
    if (!cid) {
        cid = (crypto.randomUUID && crypto.randomUUID()) || ('c' + Date.now() + Math.random().toString(16).slice(2));
        try { localStorage.setItem('client_id', cid); } catch (e) {}
    }
    return cid;
}

async function syncQueue(cid) {
    try {
        const res = await fetch(`/api/queue_status?client_id=${encodeURIComponent(cid)}`);
        const data = await res.json();
        state.queue.position = data.position || 0;
        state.queue.total = data.total || 0;
    } catch (e) {}
}

function openStatsSocket(cid) {
    if (!location.host) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/ws/stats?client_id=${encodeURIComponent(cid)}`); } catch (e) { return; }
    ws.onmessage = ev => {
        let data; try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data.type === 'stats') state.online = data.online_count || 0;
        else if (data.type === 'cloud_status' || data.type === 'canvas_updated') { post(frameEl(state.active), data); window.postMessage(data, location.origin); }
        else if (data.type === 'asset_library_updated') { broadcast(data); window.postMessage(data, location.origin); }
    };
    ws.onclose = () => setTimeout(() => openStatsSocket(cid), 5000);
}

export function initBridge() {
    window.addEventListener('message', onMessage);
    try {
        const ch = new BroadcastChannel('studio-api');
        ch.onmessage = e => forwardStudioApiChange(e.data);
    } catch (e) {}
    window.addEventListener('studio-ui-scale-change', () => allFrames().forEach(syncFrame));
    window.addEventListener('studio-lang-change', () => allFrames().forEach(syncFrame));
    const cid = clientId();
    openStatsSocket(cid);
    syncQueue(cid);
    setInterval(() => syncQueue(cid), 2000);
}
