<script setup>
// 设置：通用 / API 设置 / 工作流设置 / 数据备份 / 外观 / 关于。
// 六页都已用 Vue 重写（API 设置 / 工作流设置在第 20 轮从 iframe 换成 Vue）；tab.frame 机制保留备用。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import GeneralPanel from './settings/GeneralPanel.vue';
import BackupPanel from './settings/BackupPanel.vue';
import AppearancePanel from './settings/AppearancePanel.vue';
import AboutPanel from './settings/AboutPanel.vue';
import ApiSettingsPanel from './settings/ApiSettingsPanel.vue';
import WorkflowSettingsPanel from './settings/WorkflowSettingsPanel.vue';
import MemoryPanel from './settings/MemoryPanel.vue';
import { state, t } from '../lib/store.js';
import { versionLabel } from '../lib/update.js';
import { onSettingsOverlay, syncFrame } from '../lib/bridge.js';

const emit = defineEmits(['quickstart']);
const TABS = [
    { id: 'general', icon: 'monitor', i18n: 'common.general', label: '通用', desc: '管理 NOVAI 的常用偏好与入口。', descKey: 'common.generalDesc' },
    { id: 'memory', icon: 'brain', i18n: 'common.memory', label: '记忆', desc: '管理长期记忆，会由服务端自动注入到对话与生成请求里。', descKey: 'common.memoryDesc' },
    { id: 'api-settings', icon: 'key', i18n: 'common.apiSettings', label: 'API 设置', desc: '管理平台地址、模型列表和 Key。', descKey: 'api.subtitle' },
    { id: 'comfyui-settings', icon: 'workflow', i18n: 'common.comfyuiSettings', label: '工作流设置', desc: '管理 ComfyUI 后端与工作流。', descKey: 'comfy.subtitle' },
    { id: 'backup', icon: 'box', i18n: 'common.backup', label: '数据备份', desc: '备份画布、素材和设置，换电脑时一键导回。', descKey: 'common.backupDesc' },
    { id: 'appearance', icon: 'palette', i18n: 'common.appearance', label: '外观', desc: '主题、语言与界面缩放。', descKey: 'common.appearanceDesc' },
    { id: 'about', icon: 'badge', i18n: 'common.about', label: '关于', desc: '版本、更新与回滚。', descKey: 'common.aboutDesc' },
];
const tab = computed(() => TABS.find(x => x.id === state.settingsTab) || TABS[0]);
const frameEl = ref(null);
const frameSrc = ref('');
const veil = ref(false);
const panelEl = ref(null);
const tabsEl = ref(null);
const pill = ref({ y: 0, h: 0 });

watch(() => [state.settingsOpen, state.settingsTab], ([open]) => {
    veil.value = false;
    if (!open) return;
    frameSrc.value = tab.value.frame ? tab.value.frame + '?embed=1&t=' + Date.now() : '';
    nextTick(() => { restoreSize(); placePill(); });
}, { immediate: true });
function onFrameLoad() { if (frameEl.value) syncFrame(frameEl.value); }
function close() { state.settingsOpen = false; }
function pickTab(id) { state.settingsTab = id; }
function placePill() {
    const el = tabsEl.value && tabsEl.value.querySelector('.tab.is-on');
    if (el) pill.value = { y: el.offsetTop, h: el.offsetHeight };
}
onSettingsOverlay((open, source) => { if (frameEl.value && source === frameEl.value.contentWindow) veil.value = open; });

/* 右下角拖拽调整大小，记住尺寸（与旧外壳同一个 key） */
const SIZE_KEY = 'studio_settings_modal_size';
const MIN_W = 960, MIN_H = 640;
function clampSize(w, h) { return [Math.max(Math.min(MIN_W, innerWidth - 32), Math.min(innerWidth - 32, w)), Math.max(Math.min(MIN_H, innerHeight - 32), Math.min(innerHeight - 32, h))]; }
function restoreSize() {
    const p = panelEl.value; if (!p) return;
    try {
        const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (s && s.w && s.h) { const [w, h] = clampSize(s.w, s.h); p.style.width = w + 'px'; p.style.height = h + 'px'; }
    } catch (e) {}
}
let rs = null;
function rsDown(e) {
    const p = panelEl.value; if (!p) return;
    e.preventDefault();
    rs = { x: e.clientX, y: e.clientY, w: p.offsetWidth, h: p.offsetHeight };
    e.target.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'nwse-resize';
}
function rsMove(e) {
    if (!rs) return;
    const [w, h] = clampSize(rs.w + (e.clientX - rs.x), rs.h + (e.clientY - rs.y));
    panelEl.value.style.width = w + 'px'; panelEl.value.style.height = h + 'px';
}
function rsUp() {
    if (!rs) return; rs = null; document.body.style.cursor = '';
    try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: panelEl.value.offsetWidth, h: panelEl.value.offsetHeight })); } catch (e) {}
}
function onKey(e) { if (e.key === 'Escape' && state.settingsOpen) close(); }
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
    <Transition name="modal">
        <div v-if="state.settingsOpen" class="scrim" @mousedown.self="close">
            <div ref="panelEl" class="smodal" :class="{ veiled: veil }" role="dialog" aria-modal="true" aria-labelledby="sm-title">
                <aside class="aside">
                    <div class="aside-top"><h2 id="sm-title">{{ t('common.settings', '设置') }}</h2><span class="mono">{{ versionLabel(state.version) }}</span></div>
                    <div ref="tabsEl" class="tabs" role="tablist" aria-label="设置分类">
                        <span class="tab-pill" :style="{ transform: `translateY(${pill.y}px)`, height: pill.h + 'px' }"></span>
                        <button v-for="x in TABS" :key="x.id" type="button" role="tab" class="tab" :class="{ 'is-on': x.id === state.settingsTab }" :aria-selected="x.id === state.settingsTab" @click="pickTab(x.id)">
                            <NvIcon :name="x.icon" />{{ t(x.i18n, x.label) }}
                        </button>
                    </div>
                </aside>
                <section class="content">
                    <header class="c-head" :class="{ slim: tab.id === 'api-settings' }">
                        <div v-if="tab.id !== 'api-settings'"><h3>{{ t(tab.i18n, tab.label) }}</h3><p>{{ t(tab.descKey, tab.desc) }}</p></div>
                        <button type="button" class="nv-icon-btn sm round close" title="关闭" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
                    </header>
                    <div v-if="tab.id === 'api-settings'" class="c-frame"><ApiSettingsPanel /></div>
                    <div v-else-if="tab.frame" class="c-frame">
                        <iframe ref="frameEl" :key="frameSrc" :src="frameSrc" :title="tab.label" allow="fullscreen; clipboard-read; clipboard-write" @load="onFrameLoad"></iframe>
                    </div>
                    <div v-else class="c-body">
                        <Transition name="panel" mode="out-in">
                            <GeneralPanel v-if="tab.id === 'general'" />
                            <MemoryPanel v-else-if="tab.id === 'memory'" />
                            <BackupPanel v-else-if="tab.id === 'backup'" />
                            <AppearancePanel v-else-if="tab.id === 'appearance'" />
                            <AboutPanel v-else-if="tab.id === 'about'" @quickstart="emit('quickstart')" />
                            <WorkflowSettingsPanel v-else-if="tab.id === 'comfyui-settings'" />
                        </Transition>
                    </div>
                </section>
                <div class="rs" title="拖拽调整大小" aria-hidden="true" @pointerdown="rsDown" @pointermove="rsMove" @pointerup="rsUp"></div>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
/* 全屏 backdrop-filter 在 Electron/macOS 上会逐帧重采样下层（表现为闪烁），提独立合成层隔离；transform 不影响 flex 居中 */
.scrim { position: fixed; inset: 0; z-index: 2200; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 16px; transform: translateZ(0); will-change: transform; isolation: isolate; }
.smodal { position: relative; width: min(1180px, calc(100vw - 32px)); height: min(800px, calc(100vh - 32px)); display: flex; border-radius: 22px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
/* 内嵌页打开浮层时，整块设置界面一起压暗，避免只有 iframe 那块变暗 */
.smodal.veiled::after { content: ""; position: absolute; inset: 0; background: var(--scrim); pointer-events: none; z-index: 1; }
.smodal.veiled .c-frame { z-index: 2; }
.aside { width: 200px; flex: none; padding: 26px 12px; background: var(--fill-1); display: flex; flex-direction: column; }
.aside-top { display: flex; align-items: baseline; justify-content: space-between; padding: 0 10px 18px; }
.aside-top h2 { margin: 0; font: 500 16px/22px var(--font-sans); letter-spacing: -.01em; }
.aside-top .mono { font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.tabs { position: relative; display: flex; flex-direction: column; gap: 2px; }
.tab-pill { position: absolute; left: 0; right: 0; top: 0; border-radius: 10px; background: var(--solid); box-shadow: var(--shadow-float); transition: transform 220ms cubic-bezier(.23,1,.32,1), height 220ms cubic-bezier(.23,1,.32,1); }
.tab { position: relative; z-index: 1; height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--ink-2); font: 400 13px/1 var(--font-sans); text-align: left; transition: color var(--duration-fast); }
.tab:hover { color: var(--ink); }
.tab.is-on { color: var(--ink); font-weight: 500; }
.content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.c-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 26px 32px 18px; flex: none; }
/* API 设置页的吸顶页头 z-index 是 30，关闭按钮要压在它上面，不然左半边被挡住 */
.c-head.slim { position: absolute; right: 0; top: 0; z-index: 50; padding: 14px 16px; }
.c-head h3 { margin: 0; font: 500 18px/26px var(--font-sans); letter-spacing: -.015em; }
.c-head p { margin: 2px 0 0; font: 400 12.5px/18px var(--font-sans); color: var(--ink-3); }
/* 关闭按钮只留图标不画底框；用复合选择器压过共用的 .nv-icon-btn:hover 底色，不动其它图标按钮 */
.nv-icon-btn.close, .nv-icon-btn.close:hover { background: transparent; }
.c-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 32px 36px; }
.c-frame { position: relative; flex: 1; min-height: 0; }
.c-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: transparent; }
.rs { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; z-index: 4; }
.rs::after { content: ""; position: absolute; right: 6px; bottom: 6px; width: 7px; height: 7px; border-right: 1.5px solid var(--ink-4); border-bottom: 1.5px solid var(--ink-4); border-bottom-right-radius: 2px; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .smodal { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.panel-enter-active, .panel-leave-active { transition: opacity 160ms var(--ease-out), transform 200ms var(--ease-out), filter 160ms var(--ease-out); }
.panel-enter-from { opacity: 0; transform: translateY(6px); filter: blur(2px); }
.panel-leave-to { opacity: 0; }
</style>
