<script setup>
// 还没重写的页面：每页一个 iframe（id 仍是 frame-<id>，旧页面里直接找 parent 的 frame-canvas 的写法照样可用），
// 首次进入才加载，之后常驻只切显示，和旧外壳一样保留各页状态。
import { watch, onMounted, onBeforeUnmount, reactive, nextTick } from 'vue';
import { state, PAGES } from '../lib/store.js';
import { syncFrame, frameEl, closeCanvas } from '../lib/bridge.js';
import { translateFrame } from '../lib/autoTranslate.js';

const legacy = PAGES.filter(p => p.legacy || p.frame);
const loading = reactive({});
const BOOT = Date.now().toString(36);

function srcOf(p) {
    const sep = p.legacy.includes('?') ? '&' : '?';
    return p.legacy + sep + 'shell=v2&t=' + BOOT;
}
function load(id, url) {
    const el = frameEl(id);
    if (!el) return;
    loading[id] = true;
    el.src = url;
}
// 画布页的 iframe 只承载编辑器：加载完看它现在是什么——回到了旧列表页就切回 Vue 列表，是编辑器就显示
function canvasPath(el) { try { return el.contentWindow.location.pathname || ''; } catch (e) { return ''; } }
function onLoad(id) {
    loading[id] = false;
    const el = frameEl(id);
    if (id === 'canvas') {
        const path = canvasPath(el);
        if (!el.getAttribute('src') || !path || path === 'blank' || /canvas-list\.html$/.test(path)) { if (state.canvasOpen && /canvas-list\.html$/.test(path)) closeCanvas(); return; }
        state.canvasOpen = true;
    }
    syncFrame(el);
    if (id === 'canvas') syncInset();
    // 首页 home.html 自己没有接 i18n：英文模式下用外壳的自动翻译接管（同源 iframe）
    if (id === 'home' && el && el.getAttribute('src')) translateFrame(el);
}
function ensure() {
    legacy.forEach(p => {
        if (!state.visited[p.id] || !p.legacy) return;
        const el = frameEl(p.id);
        if (el && !el.getAttribute('src')) load(p.id, state.frameSrc[p.id] || srcOf(p));
    });
}
// 画布页：左侧导航浮在画布上，告诉画布左边要让出多少
// 同旧外壳 syncCanvasSidebarInset：按侧栏实际右边缘算画布左侧要让出的宽度
function canvasEditorOpen() {
    return state.active === 'canvas' && state.canvasOpen;
}
function syncInset() {
    const el = frameEl('canvas');
    if (!el) return;
    const s = Number(getComputedStyle(document.documentElement).getPropertyValue("--studio-ui-scale")) || 1;
    let inset = 0;
    // 画布编辑态外壳会隐藏左侧导航（App.vue 的 hideSidebar = isCanvas），画布不再给导航留白
    if (!canvasEditorOpen()) {
        const sb = document.querySelector('.sidebar');
        if (sb) inset = Math.max(16, Math.round(sb.getBoundingClientRect().right - el.getBoundingClientRect().left + 34));
    }
    try { el.contentDocument && el.contentDocument.documentElement.style.setProperty('--studio-sidebar-inset', (inset / s) + 'px'); } catch (e) {}
}
watch(() => [state.pinned, state.canvasOpen, state.active], () => nextTick(() => setTimeout(syncInset, 320)));
// 进出画布编辑态：导航在 180ms 内收起/展开，立刻改一次让画布控件跟手，过渡结束再对一次
watch(canvasEditorOpen, () => nextTick(() => { syncInset(); setTimeout(syncInset, 240); }));
// 旧页面（首页、素材库）会直接改 frame-canvas 的 src 打开画布：一改就切到「编辑器」状态并显示骨架
function watchCanvasSrc() {
    const el = frameEl('canvas');
    if (!el || typeof MutationObserver === 'undefined') return;
    new MutationObserver(() => {
        const src = el.getAttribute('src') || '';
        if (src && !/about:blank|canvas-list\.html/.test(src)) { state.canvasOpen = true; loading.canvas = true; }
    }).observe(el, { attributes: true, attributeFilter: ['src'] });
}
// 第 20 轮改 syncInset 时误删了下面两条（导致从 Vue 画布列表 / 新建打开画布没反应），第 25 轮补回
watch(() => ({ ...state.visited }), () => nextTick(ensure), { deep: true });
watch(() => state.frameSrc.canvas, url => { if (url) { load('canvas', url); state.frameSrc.canvas = ''; } });
watch(() => state.active, () => nextTick(() => { const el = frameEl(state.active); if (el && el.getAttribute('src')) syncFrame(el); }));
let insetObserver = null;
onMounted(() => {
    ensure();
    watchCanvasSrc();
    // 侧栏 hover 展开是改宽度（72→220），旧外壳靠这两条重算让画布左侧控件跟着动，移植时漏了
    const sb = document.querySelector('.sidebar');
    if (sb && typeof ResizeObserver !== 'undefined') {
        insetObserver = new ResizeObserver(() => syncInset());
        insetObserver.observe(sb);
    }
    window.addEventListener('resize', syncInset);
});
onBeforeUnmount(() => {
    if (insetObserver) insetObserver.disconnect();
    window.removeEventListener('resize', syncInset);
});
</script>

<template>
    <div class="ls">
        <iframe v-for="p in legacy" :key="p.id" :id="'frame-' + p.id" class="ls-frame" :class="{ 'is-on': state.active === p.id && (p.id !== 'canvas' || state.canvasOpen) }"
                :title="p.label" allow="clipboard-read; clipboard-write; fullscreen" @load="onLoad(p.id)"></iframe>
        <div v-if="loading[state.active] && (state.active !== 'canvas' || state.canvasOpen)" class="ls-skel" aria-hidden="true">
            <div class="nv-skel" style="width: 42%; height: 34px"></div>
            <div class="nv-skel" style="width: 62%; height: 12px; margin-top: 18px"></div>
            <div class="nv-skel" style="width: 48%; height: 12px; margin-top: 10px"></div>
            <div class="grid"><div class="nv-skel" v-for="i in 4" :key="i"></div></div>
        </div>
    </div>
</template>

<style scoped>
.ls { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.ls-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: transparent; visibility: hidden; opacity: 0; pointer-events: none; transition: opacity var(--duration-base) var(--ease-out); }
.ls-frame.is-on { visibility: visible; opacity: 1; pointer-events: auto; }
.ls-skel { position: absolute; inset: 0; pointer-events: auto; padding: 96px 100px; background: var(--bg); display: flex; flex-direction: column; animation: fade-in var(--duration-base) var(--ease-out) 180ms both; }
.ls-skel .grid { margin-top: 48px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.ls-skel .grid .nv-skel { aspect-ratio: 4 / 3; }
@keyframes fade-in { from { opacity: 0; } }
</style>
