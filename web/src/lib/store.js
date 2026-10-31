import { reactive } from 'vue';

// 页面注册表：native = 已用 Vue 重写；legacy = 还没重写，用 iframe 承载旧页面（逐页替换时改这里）
export const PAGES = [
    // 首页：按用户要求继续用原先的 home.html（iframe 承载）；Vue 版 pages/home/HomePage.vue 保留未挂载
    { id: 'home', label: '首页', i18n: 'nav.home', icon: 'home', legacy: '/static/home.html' },
    // 画布：列表已用 Vue 重写（native），打开某张画布时仍用 iframe 承载旧编辑器（frame）
    { id: 'canvas', label: '智能画布BEAT', i18n: 'nav.canvas', icon: 'workflow', native: true, frame: true },
    { id: 'online', label: '在线生图', i18n: 'nav.online', icon: 'globe', native: true },
    { id: 'gpt-chat', label: 'GPT 对话', i18n: 'nav.gpt', icon: 'chat', native: true },
    { id: 'asset-manager', label: '素材库', i18n: 'nav.assetManager', icon: 'library', native: true },
    { id: 'store', label: '应用市场', i18n: 'nav.store', icon: 'grid9', native: true },
    // 不在侧栏，但旧页面会 navigate 过来
    { id: 'zimage', label: 'Z-Image', icon: 'image', native: true, hidden: true },
    // 旧页面 navigate 到这两个 id 时改为打开设置弹窗对应页（bridge.navigate 里处理）
    { id: 'api-settings', label: 'API 设置', icon: 'key', settingsTab: true, hidden: true },
    { id: 'comfyui-settings', label: '工作流设置', icon: 'workflow', settingsTab: true, hidden: true },
];
export const PAGE_IDS = PAGES.map(p => p.id);
export const DEFAULT_PAGE = 'home';

const ACTIVE_KEY = 'studio_active_page';
const PINNED_KEY = 'studio_sidebar_pinned';

function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function write(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }

const saved = read(ACTIVE_KEY);

export const state = reactive({
    active: PAGE_IDS.includes(saved) ? saved : DEFAULT_PAGE,
    visited: {},            // 已经加载过的 legacy 页面（iframe 懒加载）
    frameSrc: {},           // 某页 iframe 被指到别的地址（例如直接打开某张画布）
    canvasOpen: false,      // 画布页当前是否打开了某张画布（否则显示 Vue 画布列表）
    sourcePanelOpen: false, // 画布里的素材浏览器面板是否打开（打开时外壳隐藏左侧导航）
    pinned: read(PINNED_KEY) === '1',
    theme: document.documentElement.classList.contains('theme-dark') ? 'dark' : 'light',
    lang: (window.StudioI18n && window.StudioI18n.lang && window.StudioI18n.lang()) || 'zh',
    settingsOpen: false,
    settingsTab: 'general',
    desktop: '',            // '' 网页 | 'windows' 无边框 | 'mac' 原生透明标题栏
    queue: { position: 0, total: 0 },
    online: 0,
    version: '',
    remoteVersion: '',
    toasts: [],
});
state.visited[state.active] = true;

export function setPinned(v) { state.pinned = v; write(PINNED_KEY, v ? '1' : '0'); }
export function rememberActive(id) { write(ACTIVE_KEY, id); }

let toastSeq = 0;
export function toast(text, opts = {}) {
    const id = ++toastSeq;
    state.toasts.push({ id, text, icon: opts.icon || '', danger: !!opts.danger, onClick: opts.onClick || null });
    setTimeout(() => dismissToast(id), opts.duration || (opts.onClick ? 4000 : 2600));
    return id;
}

export function dismissToast(id) { state.toasts = state.toasts.filter(t => t.id !== id); }

export function t(key, fallback) {
    void state.lang; // 让模板对语言切换有反应
    try {
        const v = window.StudioI18n && window.StudioI18n.t(key);
        if (v && v !== key) return v;
    } catch (e) {}
    return fallback != null ? fallback : key;
}
