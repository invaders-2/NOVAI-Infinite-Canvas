<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvLogo from '../components/NvLogo.vue';
import GooeyNav from './GooeyNav.vue';
import { state, t } from '../lib/store.js';
import { navigate, closeCanvas } from '../lib/bridge.js';
import { pyApi, getGeneralSettings } from '../lib/env.js';

// 2026-11 重做：侧栏下线，主导航放进标题栏正中（首页 / 画布 / 素材库 / 应用市场 / 我的）
// 账户拆成两块：身份资料进「我的」页，主题 / 设置留在标题栏右上角
const NAV = [
    { id: 'home', i18n: 'nav.home', label: '首页', icon: 'home' },
    { id: 'canvas', i18n: 'nav.canvas', label: '画布', icon: 'canvas' },
    { id: 'asset-manager', i18n: 'nav.assetManager', label: '素材库', icon: 'library' },
    { id: 'store', i18n: 'nav.store', label: '应用市场', icon: 'bag' },
    { id: 'me', i18n: 'nav.me', label: '我的', icon: 'user' },
];
// 文案解析好交给 GooeyNav：它只认「导航项数组」，i18n 变了数组跟着重算，胶囊会重新量宽度
const navItems = computed(() => NAV.map(it => ({ id: it.id, icon: it.icon, label: t(it.i18n, it.label) })));
// 平台：mac 原生透明标题栏（左上留给红绿灯，不放 Logo）· windows 无边框（Logo + 窗口按钮）· web 普通网页（Logo）
const kind = computed(() => state.desktop === 'mac' ? 'mac' : state.desktop === 'windows' ? 'windows' : 'web');
// 画布编辑器打开时再点一次「画布」= 回到画布列表（和编辑器里的「画布列表」按钮一样）
function go(id) {
    if (id === 'canvas' && state.active === 'canvas' && state.canvasOpen) { closeCanvas(); return; }
    navigate(id);
}

// 主题走 StudioTheme（负责持久化 + 广播给 iframe，state.theme 由 studio-theme-change 同步回来）；
// 旧页面没加载 theme.js 时退回直接改 state + html class
function toggleTheme() {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    try {
        if (window.StudioTheme) { window.StudioTheme.set(next); return; }
    } catch (e) {}
    state.theme = next;
    document.documentElement.classList.toggle('theme-dark', next === 'dark');
}
function openSettings() {
    state.settingsTab = 'general';
    state.settingsOpen = true;
}

function call(name, ...args) { const a = pyApi(); if (a && typeof a[name] === 'function') { try { a[name](...args); } catch (e) {} } }
function closeWindow() {
    const a = pyApi(); if (!a) return;
    // 关窗行为跟随「通用 · 关闭时最小化到托盘」
    if (getGeneralSettings().closeToTray !== false) call('close'); else call('quit_app');
}
// pywebview 下 -webkit-app-region 不生效：mousedown 走原生桥拖窗口
function dragStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    // macOS 红绿灯区域留给原生按钮（与 launcher.py 灯位常数一致）
    if (state.desktop === 'mac' && e.clientX >= 1 && e.clientX <= 65 && e.clientY >= 14 && e.clientY <= 38) return;
    const a = pyApi();
    if (a && typeof a.start_window_drag === 'function') {
        e.preventDefault();
        try { a.start_window_drag(); } catch (err) {}
        // Electron 主进程靠定时器跟随光标，必须 mouseup 收尾，否则松手后窗口还会继续跟
        if (typeof a.end_window_drag === 'function') {
            const stop = () => { window.removeEventListener('mouseup', stop); try { a.end_window_drag(); } catch (err) {} };
            window.addEventListener('mouseup', stop);
        }
    }
}

// Windows 无边框：WebView2 吞掉边框命中，用 8px 边缘条 + 拖动期遮罩 + js_api 桥缩放
const resizing = ref('');
let sx = 0, sy = 0, dx = 0, dy = 0, raf = false;
function resizeDown(dir, e) {
    if (e.button !== 0) return;
    const a = pyApi(); if (!a || typeof a.begin_frameless_resize !== 'function') return;
    e.preventDefault(); e.stopPropagation();
    resizing.value = dir; sx = e.screenX; sy = e.screenY; dx = 0; dy = 0;
    call('begin_frameless_resize', dir);
}
function onMove(e) {
    if (!resizing.value) return;
    dx = e.screenX - sx; dy = e.screenY - sy;
    if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; call('update_frameless_resize', dx, dy); }); }
}
function onUp() { if (!resizing.value) return; resizing.value = ''; call('end_frameless_resize'); }
onMounted(() => { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); });
onBeforeUnmount(() => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); });
const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
</script>

<template>
    <header class="tb" :class="'is-' + kind" @mousedown="dragStart">
        <div v-if="kind !== 'mac'" class="tb-brand"><NvLogo /><span>NOVAI</span></div>
        <GooeyNav :items="navItems" :active="state.active" @select="go" />
        <div class="tb-actions">
            <template v-if="kind === 'windows'">
                <span class="tb-gap"></span>
                <button type="button" class="tb-btn" title="最小化" @click="call('minimize')"><NvIcon name="winmin" /></button>
                <button type="button" class="tb-btn" title="最大化" @click="call('maximize')"><NvIcon name="winmax" /></button>
                <button type="button" class="tb-btn close" title="关闭" @click="closeWindow"><NvIcon name="x" /></button>
            </template>
        </div>
        <!-- 2026-11：主题 / 设置回到标题栏右上角（Windows 让开窗口按钮，mac 贴右侧，网页版留 16px） -->
        <div class="tb-right">
            <button type="button" class="tb-btn" :title="state.theme === 'dark' ? '切换浅色' : '切换深色'" :aria-label="state.theme === 'dark' ? '切换浅色' : '切换深色'" @click="toggleTheme">
                <NvIcon :name="state.theme === 'dark' ? 'moon' : 'sun'" />
            </button>
            <button type="button" class="tb-btn" title="设置" aria-label="设置" @click="openSettings"><NvIcon name="settings" /></button>
        </div>
    </header>
    <template v-if="state.desktop === 'windows'">
        <div v-for="d in DIRS" :key="d" class="rs" :class="'rs-' + d" @mousedown="resizeDown(d, $event)"></div>
        <div v-if="resizing" class="rs-overlay" :class="'rs-' + resizing"></div>
    </template>
</template>

<style scoped>
/* 标题栏浮在内容上（App.vue 把它绝对定位到顶部），背景由 App.vue 的渐变磨砂层提供，这里本身透明 */
.tb { position: absolute; left: 0; right: 0; top: 0; z-index: 60; height: var(--tbh); display: flex; align-items: center; gap: 6px; user-select: none; -webkit-user-select: none; -webkit-app-region: drag; }
.tb.is-windows { padding: 0 8px 0 16px; }
.tb.is-mac { padding: 0 14px 0 80px; }
.tb.is-web { padding: 0 16px 0 20px; }
.tb-brand { display: flex; align-items: center; gap: 8px; font: 600 13px/1 var(--font-sans); letter-spacing: .02em; color: var(--ink); }
.tb-brand :deep(svg) { width: 18px; height: 18px; }
/* 主导航搬进 GooeyNav.vue（液体胶囊层 + 导航项都在那边） */
.tb-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
/* 主题 / 设置：垂直居中在 --tbh 里，Windows 右移 120px 让开最小化 / 最大化 / 关闭 */
.tb-right { position: absolute; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 2px; z-index: 4; -webkit-app-region: no-drag; }
.tb.is-mac .tb-right { right: 14px; }
.tb.is-windows .tb-right { right: 120px; }
.tb.is-web .tb-right { right: 16px; }
.tb-btn { width: 30px; height: 30px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-instant); }
.tb-btn .nv-i { width: 15px; height: 15px; }
.tb-btn:hover { background: var(--fill-1); color: var(--ink); }
.tb-btn:active { transform: scale(.94); }
.tb-btn.close:hover { background: var(--danger); color: #fff; }
.tb-gap { width: 8px; }
/* 窄窗口：导航只留图标 */
@media (max-width: 760px) { .tb-brand span { display: none; } }
.rs { position: fixed; z-index: 2090; }
.rs-n { top: 0; left: 8px; right: 8px; height: 5px; cursor: n-resize; }
.rs-s { bottom: 0; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
.rs-e { right: 0; top: 8px; bottom: 8px; width: 6px; cursor: e-resize; }
.rs-w { left: 0; top: 8px; bottom: 8px; width: 6px; cursor: w-resize; }
.rs-ne { right: 0; top: 0; width: 10px; height: 10px; cursor: ne-resize; }
.rs-nw { left: 0; top: 0; width: 10px; height: 10px; cursor: nw-resize; }
.rs-se { right: 0; bottom: 0; width: 12px; height: 12px; cursor: se-resize; }
.rs-sw { left: 0; bottom: 0; width: 12px; height: 12px; cursor: sw-resize; }
.rs-overlay { position: fixed; inset: 0; z-index: 2100; }
.rs-overlay.rs-n, .rs-overlay.rs-s { cursor: ns-resize; } .rs-overlay.rs-e, .rs-overlay.rs-w { cursor: ew-resize; }
.rs-overlay.rs-ne, .rs-overlay.rs-sw { cursor: nesw-resize; } .rs-overlay.rs-nw, .rs-overlay.rs-se { cursor: nwse-resize; }
</style>
