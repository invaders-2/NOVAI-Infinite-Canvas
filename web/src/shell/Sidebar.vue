<script setup>
// 左侧导航：按用户要求还原旧外壳（static/index.html）的侧栏——
// 72px 磨砂圆角浮卡，悬停展开到 220px（推开舞台），图标 / 文字 / 选中态 / 设置 / 版本号的样式与动效照旧。
// 固定展开（studio_sidebar_pinned）沿用旧 key；点 Logo 切换固定（旧版 title 写着「固定导航栏」但没接事件，这里接上）。
import { computed, ref } from 'vue';
import { state, setPinned, t } from '../lib/store.js';
import { navigate, pauseScale } from '../lib/bridge.js';
import { hasUpdate as checkHasUpdate, versionLabel } from '../lib/update.js';

const emit = defineEmits(['open-settings', 'open-update']);

// 顺序、图标与旧侧栏一致
const ITEMS = [
    { id: 'home', i18n: 'nav.home', label: '首页', svg: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
    { id: 'online', i18n: 'nav.online', label: '在线生图', svg: '<path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
    { id: 'gpt-chat', i18n: 'nav.gpt', label: 'GPT 对话', svg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
    { id: 'canvas', i18n: 'nav.canvas', label: '无限画布', svg: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>' },
    { id: 'asset-manager', i18n: 'nav.assetManager', label: '素材库', svg: '<path d="M4 19.5V6.8A2.8 2.8 0 0 1 6.8 4h10.4A2.8 2.8 0 0 1 20 6.8v12.7"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h6"/>' },
];
const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.36 1.08V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.08-.36H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .36-1.08V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.22.38.58.69 1 .86.2.08.42.13.65.14H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/>';
const LOGO = 'M869.44,200.5L494.98,39.39c-98.45-42.36-208.12,29.86-208.12,137.03v14.48l82.33,35.42v-56.49c0-52.07,53.28-87.15,101.11-66.57l356.27,153.28c16.53,7.11,16.53,30.54,0,37.67l-48.96,21.05c-84.31,36.27-179.84,36.27-264.15,0l-267.88-115.26c-99.7-42.89-210.74,30.23-210.74,138.74v323.08c0,68.38,40.7,130.21,103.52,157.23l384.4,165.37c99.82,42.94,211.01-30.26,211.01-138.93v-2.62l-82.33-35.42v33.92c0,58.62-59.98,98.12-113.84,74.95l-345.18-148.51c-14.35-6.18-14.35-26.53,0-32.7l76.43-32.95c64.04-27.6,136.62-27.63,200.69-.07l278.94,120.01c113.84,48.98,240.66-34.51,240.66-158.45v-281.37c0-79.07-47.06-150.55-119.71-181.8ZM906.83,663.69c0,71.74-73.39,120.06-139.28,91.72l-33.77-14.53-82.33-35.42-155.17-66.76c-77.12-33.18-127.09-109.07-127.09-193.03v-91.04l-82.33-35.42v175.86c0,75.82-45.13,144.37-114.77,174.34l-24.08,10.36c-14.59,6.28-30.84-4.42-30.84-20.3v-326.53c0-53.75,54.99-89.95,104.37-68.7l298.17,128.27c79.94,34.39,131.73,113.06,131.73,200.08v85.91l82.33,35.42v-168.65c0-82.93,49.36-157.9,125.54-190.66l13.46-5.8c16.11-6.94,34.06,4.89,34.06,22.41v292.46Z';

const collapsing = ref(false);
const hasUpdate = computed(() => { void state.remoteVersion; void state.version; return checkHasUpdate(); });
const verText = computed(() => (state.version ? versionLabel(state.version) : 'v-'));
const verTitle = computed(() => (hasUpdate.value ? '有新版本，点击查看更新' : (state.version ? '当前版本：' + verText.value : '当前版本')));

function togglePin() {
    pauseScale();
    const next = !state.pinned;
    setPinned(next);
    if (!next) { collapsing.value = true; setTimeout(() => { collapsing.value = false; }, 360); }
}
function openVersion() { emit('open-update'); }
</script>

<template>
    <aside class="sidebar" :class="{ 'is-pinned': state.pinned, 'is-collapsing': collapsing }" @mouseenter="pauseScale()" @mouseleave="pauseScale()">
        <button class="logo-text" type="button" :title="state.pinned ? '收起导航栏' : '固定导航栏'" :aria-pressed="state.pinned" @click="togglePin">
            <svg class="sidebar-logo-img" viewBox="0 0 1024 1024" aria-hidden="true"><path fill="currentColor" :d="LOGO" /></svg>
            <span class="logo-text-label">NOVAI</span>
        </button>

        <nav aria-label="主导航">
            <div class="nav-divider"></div>
            <div v-for="it in ITEMS" :key="it.id" class="nav-item" :class="{ active: state.active === it.id }" role="button" tabindex="0"
                 :aria-current="state.active === it.id ? 'page' : null" @click="navigate(it.id)" @keydown.enter.prevent="navigate(it.id)" @keydown.space.prevent="navigate(it.id)">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="it.svg"></svg>
                <span class="nav-text">{{ t(it.i18n, it.label) }}</span>
            </div>
        </nav>

        <div class="side-actions">
            <button class="side-pill settings-toggle" :class="{ active: state.settingsOpen }" type="button" :title="t('common.settings', '设置')" @click="emit('open-settings')">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="GEAR"></svg>
                <span class="side-pill-text">{{ t('common.settings', '设置') }}</span>
            </button>
        </div>

        <div class="version-display clickable" :class="{ 'has-update': hasUpdate }" :title="verTitle" role="button" tabindex="0" @click="openVersion" @keydown.enter.prevent="openVersion">
            <span class="version-dot" aria-hidden="true"></span>
            <span class="version-text">{{ verText }}</span>
        </div>
    </aside>
</template>

<style scoped>
/* 旧外壳的侧栏变量（只在侧栏内用，深色跟随 html.theme-dark） */
.sidebar {
    --sb-bg: rgba(255,255,255,0.55); --sb-text: #1c1c1e; --sb-muted: #656569; --sb-hover-bg: rgba(0,0,0,0.04); --sb-hover: #ECECEC; --sb-active: #E9E9EA; --sb-page: #f5f5f7;
    --sb-focus: rgba(59,130,246,0.5); --sb-shadow-sm: 0 1px 2px rgba(0,0,0,0.03);
    --fluid-ease: cubic-bezier(0.22, 0.61, 0.36, 1); --sb-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --ease-hover: cubic-bezier(0.25, 0.1, 0.25, 1);
}


.sidebar {
    width: 72px; min-width: 72px; max-width: 220px; height: 100%; box-sizing: border-box;
    border-radius: 26px; background: var(--sb-bg);
    backdrop-filter: blur(40px) saturate(200%); -webkit-backdrop-filter: blur(40px) saturate(200%);
    transition: width 0.3s ease-out, min-width 0.3s ease-out, background 0.3s ease-out, backdrop-filter 0.3s ease-out, box-shadow 0.3s ease-out;
    display: flex; flex-direction: column; align-items: center; overflow: hidden; flex-shrink: 0; position: relative; z-index: 50;
    box-shadow: 0 8px 24px rgba(0,0,0,.08); margin: 0; padding: 16px 0 12px 0;
    font-family: var(--font-sans); color: var(--sb-text);
    animation: sidebar-enter 0.5s var(--fluid-ease);
}
.sidebar:hover { width: 220px; min-width: 220px; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
@keyframes sidebar-enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }

/* 桌面端（WebView）大面积 backdrop-filter 展开时会闪：悬停展开改实色（同旧外壳） */


/* Logo */
.logo-text {
    display: flex; font-size: 14px; font-weight: 600; letter-spacing: 0.06em; color: var(--sb-text); cursor: pointer; flex-shrink: 0;
    margin-bottom: 4px; padding: 4px 0 4px 14px; border-radius: 8px; transition: all 0.35s var(--sb-ease-out); white-space: nowrap; text-align: left;
    background: transparent; border: none; font-family: inherit; align-items: center; gap: 8px; justify-content: flex-start; width: 48px; box-sizing: border-box;
}
.sidebar:not(:hover) .logo-text { padding-left: 5px; justify-content: center; gap: 0; }
.sidebar:not(:hover):not(.is-pinned) .logo-text { padding-left: 0; margin-top: 10px; }
.sidebar-logo-img { width: 24px; height: 24px; flex-shrink: 0; border-radius: 4px; transition: all 0.35s var(--sb-ease-out); }
.logo-text-label { font-size: 17px; font-weight: 600; letter-spacing: 0.06em; color: var(--sb-text); opacity: 0; max-width: 0; overflow: hidden;
    transition: opacity 0.3s var(--sb-ease-out) 0.3s, max-width 0.3s var(--sb-ease-out) 0.3s; }
.sidebar:hover .sidebar-logo-img { width: 32px; height: 32px; }
.sidebar:hover .logo-text { font-size: 20px; width: 190px; }
.sidebar:hover .logo-text-label { opacity: 1; max-width: 100px; transition-delay: 0.1s; }

/* 导航 */
nav { width: 100%; min-height: 0; flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; display: flex; flex-direction: column; align-items: center; padding: 0 0 6px; overscroll-behavior: contain; }
nav::-webkit-scrollbar { display: none; }
nav > * { flex-shrink: 0; }
.nav-divider { width: 32px; height: 1px; background: transparent; margin: 8px auto; transition: width 0.35s var(--fluid-ease); }
.sidebar:hover .nav-divider { width: 160px; }
.nav-item {
    position: relative; width: 40px; height: 40px; flex: 0 0 40px; margin: 2px auto; display: flex; align-items: center; justify-content: center;
    border-radius: 12px; cursor: pointer; color: var(--sb-muted); overflow: hidden; padding-left: 0; box-sizing: border-box; outline: none;
    transition: background 0.2s var(--ease-hover), color 0.2s var(--ease-hover), transform 0.2s var(--ease-hover), box-shadow 0.2s var(--ease-hover), width 0.3s ease-out, margin 0.3s ease-out, height 0.3s ease-out, padding 0.3s ease-out;
}
.sidebar:hover .nav-item { width: 190px; height: 48px; flex: 0 0 48px; margin: 8px 0; justify-content: flex-start; padding-left: 14px; }
.nav-item svg, .side-pill svg { width: 24px; height: 24px; flex-shrink: 0; }
.sidebar:not(:hover):not(.is-pinned) .nav-item svg { width: 20px; height: 20px; }
.sidebar:not(:hover):not(.is-pinned) .nav-text { margin-left: 0; }
.nav-item:hover { background: var(--sb-hover); color: var(--sb-text); }
.nav-item:focus-visible { box-shadow: 0 0 0 3px var(--sb-focus); background: var(--sb-hover); color: var(--sb-text); }
.nav-item.active { background: var(--sb-active); color: var(--sb-text); box-shadow: none; }
.nav-item.active:hover { background: var(--sb-active); box-shadow: none; }
.sidebar:hover .nav-item:hover { background: var(--sb-hover-bg); color: var(--sb-text); transform: translateX(2px); }
.sidebar:hover .nav-item.active { background: var(--sb-text); color: var(--sb-page); box-shadow: var(--sb-shadow-sm), 0 4px 16px -2px rgba(0,0,0,0.12); }
.sidebar:hover .nav-item.active:hover { transform: translateX(0); box-shadow: var(--sb-shadow-sm), 0 6px 16px -2px rgba(0,0,0,0.2); }
.nav-text { margin-left: 16px; font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; opacity: 0; width: 0; transition: opacity 0.3s ease-out, width 0.3s ease-out; }
.sidebar:hover .nav-text { opacity: 1; width: auto; max-width: 200px; }

/* 设置 */
.side-actions { margin-top: auto; margin-bottom: 0; padding-bottom: 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; flex: 0 0 auto; }
.side-pill {
    width: 40px; height: 40px; flex: 0 0 40px; margin: 2px auto; border: 0; border-radius: 12px; background: transparent; color: var(--sb-muted);
    display: flex; align-items: center; justify-content: center; cursor: pointer; overflow: hidden; gap: 8px; min-width: 0; position: relative; padding-left: 0; box-sizing: border-box; font-family: inherit;
    transition: background-color 0.2s, color 0.2s, transform 0.2s, box-shadow 0.2s, width 0.3s ease-out, margin 0.3s ease-out;
}
.side-pill svg { width: 20px; height: 20px; flex: 0 0 auto; }
/* 收起态：文字虽隐藏仍占 gap，加上 UA 按钮默认的右内边距，齿轮会被推左；归零才与 logo / 导航图标同列 */
.sidebar:not(:hover):not(.is-pinned) .side-pill { padding-left: 0; padding-right: 0; gap: 0; }
.sidebar:hover .side-pill { width: 190px; height: 40px; flex: 0 0 40px; margin: 0; justify-content: flex-start; padding-left: 14px; gap: 8px; }
.side-pill:hover { background: var(--sb-hover); color: var(--sb-text); }
.sidebar:hover .side-pill:hover { background: var(--sb-hover-bg); color: var(--sb-text); transform: translateX(2px); }
.side-pill.active { background: var(--sb-active); color: var(--sb-text); }
.sidebar:hover .side-pill.active { background: var(--sb-text); color: var(--sb-page); box-shadow: 0 4px 16px -2px rgba(0,0,0,0.12); }
.side-pill-text { opacity: 0; width: 0; font-size: 14px; font-weight: 600; letter-spacing: .02em; white-space: nowrap; overflow: hidden; transition: opacity 0.3s ease-out, width 0.3s ease-out; }
.sidebar:hover .side-pill-text { opacity: 1; width: auto; max-width: 120px; }

/* 版本号 */
.version-display { flex-shrink: 0; display: flex; align-items: center; justify-content: flex-start; gap: 4px; padding: 4px 0 0 28px; margin-bottom: 8px; width: 100%; box-sizing: border-box; transition: color 0.2s ease; cursor: pointer; outline: none; }
.version-text { font-size: 10px; color: var(--sb-muted); font-weight: 500; letter-spacing: 0.02em; white-space: nowrap; opacity: 0; transition: color 0.2s ease, opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
.sidebar:hover .version-text, .sidebar.is-pinned .version-text { opacity: 1; }
.version-display:hover .version-text { color: var(--sb-text); }
.version-display.has-update .version-text { color: #22c55e; font-weight: 700; }
.version-display.has-update:hover .version-text { color: #16a34a; }
.version-dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; display: none; flex: 0 0 auto; }
.version-display.has-update .version-dot { display: block; }

/* 固定展开 */
.sidebar.is-pinned { width: 220px; min-width: 220px; box-shadow: 0 8px 32px rgba(0,0,0,0.12); transition-delay: 0s; }
.sidebar.is-pinned .nav-item { width: 190px; height: 48px; flex: 0 0 48px; margin: 8px 0; justify-content: flex-start; padding-left: 14px; transition-delay: 0s; }
.sidebar.is-pinned .nav-text { opacity: 1; width: auto; max-width: 200px; transition-delay: 0.1s; }
.sidebar.is-pinned .logo-text-label { opacity: 1; max-width: 100px; transition-delay: 0.1s; }
.sidebar.is-pinned .logo-text { width: 190px; justify-content: flex-start; gap: 8px; }
.sidebar.is-pinned .side-pill { width: 190px; margin: 0; justify-content: flex-start; padding-left: 14px; gap: 8px; transition-delay: 0s; }
.sidebar.is-pinned .side-pill-text { opacity: 1; width: auto; max-width: 120px; transition-delay: .15s; }
/* 取消固定的瞬间鼠标还在上面：先收文字，避免「打开又关闭」的闪 */
.sidebar.is-collapsing:hover { width: 220px; }
.sidebar.is-collapsing:hover .nav-text, .sidebar.is-collapsing:hover .side-pill-text { opacity: 0; width: 0; }
.sidebar.is-collapsing:hover .logo-text-label { opacity: 0; max-width: 0; }

@media (max-height: 760px) {
    .sidebar { padding: 18px 0 14px; }
    .nav-item { height: 42px; flex-basis: 42px; margin: 5px 0; border-radius: 15px; }
    .side-actions { margin-bottom: 6px; gap: 5px; padding-top: 14px; }
    .side-pill { height: 30px; flex-basis: 30px; width: 48px; }
}
@media (max-height: 660px) {
    .sidebar { padding: 12px 0; }
    .nav-item { height: 38px; flex-basis: 38px; margin: 3px 0; border-radius: 14px; }
    .side-actions { margin-bottom: 4px; gap: 4px; padding-top: 6px; }
    .side-pill { height: 30px; flex-basis: 30px; width: 48px; }
}
</style>

<style>
/* 深色 / 桌面端覆盖：放在非 scoped 块里（Vue scoped 的 :global(a) .b 会把整个选择器编译成 a，规则失效） */
html.theme-dark .sidebar, [data-theme=dark] .sidebar {
    --sb-bg: rgba(18,18,18,0.6); --sb-text: #f5f5f7; --sb-muted: #96969a; --sb-hover-bg: rgba(255,255,255,0.05); --sb-hover: #2A2A2E; --sb-active: #2F2F34; --sb-page: #0c0c0c;
    --sb-focus: rgba(96,165,250,0.5); --sb-shadow-sm: 0 1px 2px rgba(0,0,0,0.15);
}
.desk-mac .sidebar:hover, .desk-windows .sidebar:hover { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--sb-page); }
</style>
