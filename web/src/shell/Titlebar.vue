<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvLogo from '../components/NvLogo.vue';
import { state } from '../lib/store.js';
import { pyApi, getGeneralSettings } from '../lib/env.js';

const emit = defineEmits(['open-settings']);

function toggleTheme() {
    const cur = window.StudioTheme ? window.StudioTheme.get() : state.theme;
    if (window.StudioTheme) window.StudioTheme.set(cur === 'dark' ? 'light' : 'dark');
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
    if (a && typeof a.start_window_drag === 'function') { e.preventDefault(); try { a.start_window_drag(); } catch (err) {} }
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
    <header v-if="state.desktop" class="tb" :class="'is-' + state.desktop" @mousedown="dragStart">
        <div v-if="state.desktop === 'windows'" class="tb-brand"><NvLogo /><span>NOVAI</span></div>
        <div class="tb-actions">
            <button type="button" class="tb-btn" :title="state.theme === 'dark' ? '浅色' : '深色'" @click="toggleTheme"><NvIcon :name="state.theme === 'dark' ? 'sun' : 'moon'" /></button>
            <button type="button" class="tb-btn" title="设置" @click="emit('open-settings')"><NvIcon name="settings" /></button>
            <template v-if="state.desktop === 'windows'">
                <span class="tb-gap"></span>
                <button type="button" class="tb-btn" title="最小化" @click="call('minimize')"><NvIcon name="winmin" /></button>
                <button type="button" class="tb-btn" title="最大化" @click="call('maximize')"><NvIcon name="winmax" /></button>
                <button type="button" class="tb-btn close" title="关闭" @click="closeWindow"><NvIcon name="x" /></button>
            </template>
        </div>
    </header>
    <template v-if="state.desktop === 'windows'">
        <div v-for="d in DIRS" :key="d" class="rs" :class="'rs-' + d" @mousedown="resizeDown(d, $event)"></div>
        <div v-if="resizing" class="rs-overlay" :class="'rs-' + resizing"></div>
    </template>
</template>

<style scoped>
.tb { flex: none; display: flex; align-items: center; user-select: none; -webkit-user-select: none; -webkit-app-region: drag; position: relative; z-index: 60; }
.tb.is-windows { height: 44px; padding: 0 8px 0 16px; }
.tb.is-mac { height: 40px; padding: 0 14px 0 80px; }
.tb-brand { display: flex; align-items: center; gap: 8px; font: 500 13px/1 var(--font-sans); letter-spacing: .02em; color: var(--ink); }
.tb-brand :deep(svg) { width: 18px; height: 18px; }
.tb-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
.tb.is-mac .tb-actions { margin-top: 12px; }
.tb-btn { width: 28px; height: 28px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-instant); }
.tb-btn .nv-i { width: 15px; height: 15px; }
.tb-btn:hover { background: var(--fill-1); color: var(--ink); }
.tb-btn:active { transform: scale(.94); }
.tb-btn.close:hover { background: var(--danger); color: #fff; }
.tb-gap { width: 8px; }
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
