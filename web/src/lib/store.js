import { reactive } from 'vue';

// 页面注册表：native = 已用 Vue 重写；legacy = 还没重写，用 iframe 承载旧页面（逐页替换时改这里）
export const PAGES = [
    // 首页：2026-11 重做为 Vue 版（pages/home/HomePage.vue）；旧 home.html 保留作回退，不再挂载
    { id: 'home', label: '首页', i18n: 'nav.home', icon: 'home', native: true },
    // 画布：列表已用 Vue 重写（native），打开某张画布时仍用 iframe 承载旧编辑器（frame）
    { id: 'canvas', label: '智能画布', i18n: 'nav.canvas', icon: 'workflow', native: true, frame: true },
    { id: 'asset-manager', label: '素材库', i18n: 'nav.assetManager', icon: 'library', native: true },
    // 应用市场：2026-11 按原型重做（pages/market/MarketPage.vue），数据走 /api/store/* + /api/skills + MCP
    { id: 'store', label: '应用市场', i18n: 'nav.store', icon: 'bag', native: true },
    // 我的：个人中心（pages/me/MePage.vue），资料 / 好友 / 账户原来在右上角头像菜单里，2026-11 拆出来独立成页
    { id: 'me', label: '我的', i18n: 'nav.me', icon: 'user', native: true },
    // 在线生图 / GPT 对话 / Z-Image 已下线（2026-11）：旧页面 navigate 过来时 bridge 会回落到首页；后端接口保留，画布仍在用
    // 旧页面 navigate 到这两个 id 时改为打开设置弹窗对应页（bridge.navigate 里处理）
    { id: 'api-settings', label: 'API 设置', icon: 'key', settingsTab: true, hidden: true },
    { id: 'comfyui-settings', label: '工作流设置', icon: 'workflow', settingsTab: true, hidden: true },
];
export const PAGE_IDS = PAGES.map(p => p.id);
export const DEFAULT_PAGE = 'home';

// 只记录会话内切页（rememberActive），启动不再读它恢复上次停留页
const ACTIVE_KEY = 'studio_active_page';
const PINNED_KEY = 'studio_sidebar_pinned';

function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function write(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }

export const state = reactive({
    // 启动一律回首页：用户要求关掉重开后回到首页，不再恢复上次停留页
    active: DEFAULT_PAGE,
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
