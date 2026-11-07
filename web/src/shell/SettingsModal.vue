<script setup>
// 设置：通用 / API 设置 / 工作流设置 / 数据备份 / 外观 / 关于。
// 六页都已用 Vue 重写（API 设置 / 工作流设置在第 20 轮从 iframe 换成 Vue）；tab.frame 机制保留备用。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import GeneralPanel from './settings/GeneralPanel.vue';
import BackupPanel from './settings/BackupPanel.vue';
import AppearancePanel from './settings/AppearancePanel.vue';
import AboutPanel from './settings/AboutPanel.vue';
import ApiOverview from './settings/ApiOverview.vue';
import SkillsPanel from './settings/SkillsPanel.vue';
import WorkflowSettingsPanel from './settings/WorkflowSettingsPanel.vue';
import MemoryPanel from './settings/MemoryPanel.vue';
import PluginsPanel from './settings/PluginsPanel.vue';
import { state, t } from '../lib/store.js';
import { versionLabel } from '../lib/update.js';
import { onSettingsOverlay, syncFrame } from '../lib/bridge.js';

const emit = defineEmits(['quickstart']);
// 2026-11 按原型改为分组导航：常规 / 创作能力 / 数据；右侧数字是各页的现状（平台数、开启的插件数…）
const GROUPS = [
    { id: 'base', label: '常规', tabs: [
        { id: 'general', icon: 'monitor', i18n: 'common.general', label: '通用', desc: '窗口、启动、缓存、网络和更新。', descKey: 'common.generalDesc' },
        { id: 'appearance', icon: 'palette', i18n: 'common.appearance', label: '外观', desc: '主题、语言与界面缩放。', descKey: 'common.appearanceDesc' },
        { id: 'memory', icon: 'brain', i18n: 'common.memory', label: '记忆', desc: '长期记忆会由服务端自动带进对话与生成请求。', descKey: 'common.memoryDesc' },
    ] },
    { id: 'create', label: '创作能力', tabs: [
        { id: 'api-settings', icon: 'key', label: 'API 与模型', desc: '平台地址、Key 和模型列表。点一个平台打开管理窗口。' },
        { id: 'comfyui-settings', icon: 'workflow', i18n: 'common.comfyuiSettings', label: '工作流', desc: 'ComfyUI 后端与工作流。', descKey: 'comfy.subtitle' },
        { id: 'mcp', icon: 'plug', label: '插件', desc: '本机 MCP 服务与工具，给画布助手调用。' },
        { id: 'skills', icon: 'wand2', label: '技能', desc: '内置技能与自己导入的技能，画布助手按需调用。' },
    ] },
    { id: 'data', label: '数据', tabs: [
        { id: 'backup', icon: 'box', i18n: 'common.backup', label: '数据备份', desc: '备份画布、素材和设置，换电脑时一键导回。', descKey: 'common.backupDesc' },
        { id: 'about', icon: 'badge', i18n: 'common.about', label: '关于', desc: '版本、更新与回滚。', descKey: 'common.aboutDesc' },
    ] },
];
const TABS = GROUPS.flatMap(g => g.tabs);
/* API 设置只给管理员：auth 开启时按 /api/auth/me 的 role 判断；auth 关闭（本地单机）保持原样可见。
   meReady 之前一律先隐藏，避免非管理员看到一眼再消失。 */
const me = ref(null);
const authEnabled = ref(false);
const meReady = ref(false);
const canApi = computed(() => {
    if (!meReady.value) return false;
    if (!authEnabled.value) return true;
    return !!(me.value && me.value.role === 'admin');
});
const tabs = computed(() => (canApi.value ? TABS : TABS.filter(x => x.id !== 'api-settings')));
const q = ref('');
const groups = computed(() => {
    const n = q.value.trim().toLowerCase();
    return GROUPS.map(g => ({ ...g, tabs: g.tabs.filter(x => tabs.value.includes(x) && (!n || (x.label + x.desc).toLowerCase().includes(n))) })).filter(g => g.tabs.length);
});
/* 导航右侧的现状数字：打开设置时拉一次，失败就不显示 */
const stats = ref({});
async function loadStats() {
    const next = {};
    const get = url => fetch(url, { headers: { Accept: 'application/json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const [prov, mcp, skills] = await Promise.all([canApi.value ? get('/api/providers') : null, get('/api/mcp/servers'), get('/api/skills')]);
    if (prov && Array.isArray(prov.providers)) next['api-settings'] = prov.providers.length + ' 个平台';
    if (mcp && Array.isArray(mcp.servers)) next.mcp = mcp.servers.filter(x => x.enabled).length + ' 个开启';
    if (skills && Array.isArray(skills.skills)) next.skills = skills.skills.length + ' 个';
    stats.value = next;
}
function stat(x) { return x.id === 'about' ? (state.version ? versionLabel(state.version) : '') : (stats.value[x.id] || ''); }
const tab = computed(() => tabs.value.find(x => x.id === state.settingsTab) || tabs.value[0]);

function enforceAllowedTab() {
    if (!canApi.value && state.settingsTab === 'api-settings') state.settingsTab = tabs.value[0].id;
}
async function loadMe() {
    try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = res.ok ? await res.json() : {};
        authEnabled.value = !!(data && data.auth_enabled === true);
        me.value = data && data.role ? data : null;
    } catch (e) {
        authEnabled.value = false;
        me.value = null;
    }
    meReady.value = true;
    enforceAllowedTab();
}
const frameEl = ref(null);
const frameSrc = ref('');
const veil = ref(false);
const panelEl = ref(null);
const tabsEl = ref(null);
const pill = ref({ y: 0, h: 0 });

watch(() => [state.settingsOpen, state.settingsTab, q.value], ([open]) => {
    veil.value = false;
    enforceAllowedTab();
    if (!open) return;
    frameSrc.value = tab.value.frame ? tab.value.frame + '?embed=1&t=' + Date.now() : '';
    nextTick(() => { restoreSize(); placePill(); });
}, { immediate: true });
function onFrameLoad() { if (frameEl.value) syncFrame(frameEl.value); }
function close() { state.settingsOpen = false; }
function pickTab(id) {
    if (id === 'api-settings' && !canApi.value) return;
    state.settingsTab = id;
}
function placePill() {
    const el = tabsEl.value && tabsEl.value.querySelector('.tab.is-on');
    pill.value = el ? { y: el.offsetTop, h: el.offsetHeight } : { y: 0, h: 0 };
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
onMounted(() => {
    window.addEventListener('keydown', onKey);
    loadMe();
});
watch(canApi, () => enforceAllowedTab());
watch(() => state.settingsOpen, open => { if (open) { q.value = ''; loadStats(); } }, { immediate: true });
watch(() => state.settingsTab, (id, prev) => { if (prev === 'mcp' || prev === 'skills' || prev === 'api-settings') loadStats(); });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
    <Transition name="modal">
        <div v-if="state.settingsOpen" class="scrim" @mousedown.self="close">
            <div ref="panelEl" class="smodal" :class="{ veiled: veil }" role="dialog" aria-modal="true" aria-labelledby="sm-title">
                <aside class="aside">
                    <div class="aside-top"><h2 id="sm-title">{{ t('common.settings', '设置') }}</h2></div>
                    <label class="psearch"><NvIcon name="search" /><input v-model="q" type="search" placeholder="搜索设置" autocomplete="off" aria-label="搜索设置"></label>
                    <div ref="tabsEl" class="tabs" role="tablist" aria-label="设置分类">
                        <span class="tab-pill" :style="{ transform: `translateY(${pill.y}px)`, height: pill.h + 'px', opacity: pill.h ? 1 : 0 }"></span>
                        <template v-for="g in groups" :key="g.id">
                            <div class="grp">{{ g.label }}</div>
                            <button v-for="x in g.tabs" :key="x.id" type="button" role="tab" class="tab" :class="{ 'is-on': x.id === state.settingsTab }" :aria-selected="x.id === state.settingsTab" @click="pickTab(x.id)">
                                <NvIcon :name="x.icon" /><span class="lb">{{ x.i18n ? t(x.i18n, x.label) : x.label }}</span><span class="st">{{ stat(x) }}</span>
                            </button>
                        </template>
                        <div v-if="!groups.length" class="none">没有匹配「{{ q.trim() }}」的设置</div>
                    </div>
                </aside>
                <section class="content">
                    <header class="c-head">
                        <div><h3>{{ tab.i18n ? t(tab.i18n, tab.label) : tab.label }}</h3><p>{{ tab.descKey ? t(tab.descKey, tab.desc) : tab.desc }}</p></div>
                        <button type="button" class="nv-icon-btn sm round close" title="关闭" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
                    </header>
                    <div v-if="tab.frame" class="c-frame">
                        <iframe ref="frameEl" :key="frameSrc" :src="frameSrc" :title="tab.label" allow="fullscreen; clipboard-read; clipboard-write" @load="onFrameLoad"></iframe>
                    </div>
                    <div v-else class="c-body">
                        <Transition name="panel" mode="out-in">
                            <GeneralPanel v-if="tab.id === 'general'" />
                            <MemoryPanel v-else-if="tab.id === 'memory'" />
                            <ApiOverview v-else-if="tab.id === 'api-settings'" />
                            <PluginsPanel v-else-if="tab.id === 'mcp'" />
                            <SkillsPanel v-else-if="tab.id === 'skills'" />
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
.aside { width: 224px; flex: none; padding: 24px 10px 16px; background: var(--fill-1); display: flex; flex-direction: column; overflow-y: auto; }
.aside-top { display: flex; align-items: baseline; justify-content: space-between; padding: 0 8px 12px; }
.psearch { display: flex; align-items: center; gap: 8px; height: 32px; margin: 0 0 6px; padding: 0 10px; border-radius: 10px; background: var(--fill-2); color: var(--ink-3); flex: none; }
.psearch .nv-i { width: 14px; height: 14px; }
.psearch input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink); }
.psearch input::placeholder { color: var(--ink-4); }
.psearch input::-webkit-search-cancel-button { display: none; }
.grp { padding: 14px 10px 4px; font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.tab .lb { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab .st { font: 400 11px/1 var(--font-sans); color: var(--ink-4); white-space: nowrap; }
.tab .nv-i { width: 15px; height: 15px; }
.none { padding: 16px 10px; font: 400 12px/16px var(--font-sans); color: var(--ink-3); }
.aside-top h2 { margin: 0; font: 500 16px/22px var(--font-sans); letter-spacing: -.01em; }
.aside-top .mono { font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.tabs { position: relative; display: flex; flex-direction: column; gap: 2px; }
.tab-pill { position: absolute; left: 0; right: 0; top: 0; border-radius: 10px; background: var(--fill-3); transition: transform 220ms cubic-bezier(.23,1,.32,1), height 220ms cubic-bezier(.23,1,.32,1); }
.tab { position: relative; z-index: 1; height: 34px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--ink-2); font: 400 13px/1 var(--font-sans); text-align: left; transition: color var(--duration-fast), background var(--duration-fast); }
.tab:hover { background: var(--fill-2); color: var(--ink); }
.tab.is-on, .tab.is-on:hover { background: transparent; color: var(--ink); font-weight: 500; }
.content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.c-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 26px 32px 18px; flex: none; }
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
