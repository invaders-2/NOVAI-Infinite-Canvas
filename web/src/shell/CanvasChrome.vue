<script setup>
// 画布编辑器打开时整条标题栏隐藏（App.vue 的 showBar），窗口操作改由这一层接管：
// 顶部 12px 透明拖动带（mac / windows 都有）+ Windows 的悬浮三键与 8 条无边框缩放手柄（mac 红绿灯是系统原生的）
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import { state } from '../lib/store.js';
import { pyApi, getGeneralSettings } from '../lib/env.js';

const kind = computed(() => state.desktop === 'windows' ? 'windows' : 'mac');

function call(name, ...args) { const a = pyApi(); if (a && typeof a[name] === 'function') { try { a[name](...args); } catch (e) {} } }
function closeWindow() {
    const a = pyApi(); if (!a) return;
    // 关窗行为跟随「通用 · 关闭时最小化到托盘」
    if (getGeneralSettings().closeToTray !== false) call('close'); else call('quit_app');
}

// pywebview 下 -webkit-app-region 不生效：12px 顶部透明带 mousedown 走原生桥拖窗口
function dragStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
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

// Windows 无边框：WebView2 吞掉边框命中，用 8px 边缘条 + 拖动期遮罩 + js_api 桥缩放（同 Titlebar）
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
    <div class="cc" :class="'is-' + kind">
        <div class="cc-drag" @mousedown="dragStart"></div>
        <template v-if="kind === 'windows'">
            <div class="cc-win">
                <button type="button" class="cc-btn" title="最小化" @click="call('minimize')"><NvIcon name="winmin" /></button>
                <button type="button" class="cc-btn" title="最大化" @click="call('maximize')"><NvIcon name="winmax" /></button>
                <button type="button" class="cc-btn close" title="关闭" @click="closeWindow"><NvIcon name="x" /></button>
            </div>
            <div v-for="d in DIRS" :key="d" class="rs" :class="'rs-' + d" @mousedown="resizeDown(d, $event)"></div>
            <div v-if="resizing" class="rs-overlay" :class="'rs-' + resizing"></div>
        </template>
    </div>
</template>

<style scoped>
.cc { position: absolute; inset: 0; pointer-events: none; }
/* 透明拖动带：压在画布 iframe 上沿，只占一条，不挡画布操作。mac 画布工具行 top 6，带子也只占 6，别盖住胶囊 */
.cc-drag { position: fixed; left: 0; right: 0; top: 0; height: 12px; z-index: 60; pointer-events: auto; -webkit-app-region: drag; }
.cc.is-mac .cc-drag { height: 6px; }
/* Windows 悬浮三键：和画布右上那排图标同一行、同一尺寸（40 高的行里放 32 的按钮，中心 y=36） */
.cc-win { position: fixed; top: 16px; right: 16px; height: 40px; z-index: 62; display: flex; align-items: center; gap: 4px; pointer-events: auto; -webkit-app-region: no-drag; }
.cc-btn { width: 32px; height: 32px; border: 0; border-radius: 9px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-instant); }
.cc-btn .nv-i { width: 16px; height: 16px; }
.cc-btn:hover { background: var(--fill-1); color: var(--ink); }
.cc-btn:active { transform: scale(.94); }
.cc-btn.close:hover { background: var(--danger); color: #fff; }
.rs { position: fixed; z-index: 2090; pointer-events: auto; }
.rs-n { top: 0; left: 8px; right: 8px; height: 5px; cursor: n-resize; }
.rs-s { bottom: 0; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
.rs-e { right: 0; top: 8px; bottom: 8px; width: 6px; cursor: e-resize; }
.rs-w { left: 0; top: 8px; bottom: 8px; width: 6px; cursor: w-resize; }
.rs-ne { right: 0; top: 0; width: 10px; height: 10px; cursor: ne-resize; }
.rs-nw { left: 0; top: 0; width: 10px; height: 10px; cursor: nw-resize; }
.rs-se { right: 0; bottom: 0; width: 12px; height: 12px; cursor: se-resize; }
.rs-sw { left: 0; bottom: 0; width: 12px; height: 12px; cursor: sw-resize; }
.rs-overlay { position: fixed; inset: 0; z-index: 2100; pointer-events: auto; }
.rs-overlay.rs-n, .rs-overlay.rs-s { cursor: ns-resize; } .rs-overlay.rs-e, .rs-overlay.rs-w { cursor: ew-resize; }
.rs-overlay.rs-ne, .rs-overlay.rs-sw { cursor: nesw-resize; } .rs-overlay.rs-nw, .rs-overlay.rs-se { cursor: nwse-resize; }
</style>
