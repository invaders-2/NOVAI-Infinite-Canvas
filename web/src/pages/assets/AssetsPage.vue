<script setup>
// 素材库（页面 id: asset-manager，替换旧 static/asset-manager.html + js/asset-manager.js + image-preview.js）。
// 结构：页头（状态 / 偏好设置 / 刷新）→ 标签（素材 / 提示词库 / 工作流，素材下再分 资产库 / 画布里的 / 本地上传）
//      → 三栏（树 / 内容 / 详情）→ 底部素材保存路径；弹层：偏好设置、大图预览、确认 / 输入框。
// 共享文件夹整套（registerSharedFolder 等）按确认不再实现。
import './assets.css';
import { computed, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import LibraryPane from './panes/LibraryPane.vue';
import CanvasPane from './panes/CanvasPane.vue';
import LocalPane from './panes/LocalPane.vue';
import PromptsPane from './panes/PromptsPane.vue';
import WorkflowsPane from './panes/WorkflowsPane.vue';
import PrefsModal from './parts/PrefsModal.vue';
import Lightbox from './parts/Lightbox.vue';
import AskDialog from './parts/AskDialog.vue';
import StoragePathBar from './parts/StoragePathBar.vue';
import { S, MEDIA_TABS, setTab, lastMediaTab, loadAll, softReload, loadProviders, run } from './lib/state.js';
import { L, resetToDefault, libraries as assetLibraries } from './lib/library.js';
import { U, afterLoad as localAfterLoad } from './lib/local.js';
import { C, uniqueItems, afterLoad as canvasAfterLoad } from './lib/canvas.js';
import { P } from './lib/prompts.js';
import { W, resetToDefault as resetWorkflows } from './lib/workflows.js';

const isMedia = computed(() => MEDIA_TABS.includes(S.tab));
const busy = computed(() => /(\.\.\.|…)$/.test(S.status));
const counts = computed(() => ({
    assets: assetLibraries().reduce((n, lib) => n + (lib.categories || []).reduce((m, c) => m + (c.items || []).length, 0), 0),
    'canvas-assets': uniqueItems().length,
    local: (S.localAssets || []).length,
}));
const SOURCES = [
    { id: 'assets', label: '资产库', title: '自己整理的资产库：分组、智能分类' },
    { id: 'canvas-assets', label: '画布里的', title: '所有画布里用到的图片、视频、音频' },
    { id: 'local', label: '本地上传', title: '上传到本机素材目录的文件' },
];

function clearSelections() { L.ids.clear(); U.ids.clear(); C.ids.clear(); P.ids.clear(); W.ids.clear(); }
async function refresh() {
    await run(loadAll(), '加载失败');
    // 与旧版一致：刷新后资产库 / 工作流回到「默认资产库」，清空所有多选
    resetToDefault();
    resetWorkflows();
    canvasAfterLoad();
    clearSelections();
}
function pruneAfterSoft() {
    canvasAfterLoad();
    L.ids = new Set([...L.ids].filter(id => assetLibraries().some(lib => (lib.categories || []).some(c => (c.items || []).some(i => i.id === id)))));
}
let softTimer = 0;
function scheduleSoft(parts) {
    clearTimeout(softTimer);
    softTimer = setTimeout(() => softReload(parts).then(pruneAfterSoft), 300);
}
// 外壳转发的消息：asset_library_updated（后端广播）/ canvas_updated / providers-changed
function onMessage(e) {
    if (e.origin && e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'asset_library_updated') scheduleSoft(['assets']);
    else if (d.type === 'canvas_updated') scheduleSoft(['canvas']);
    else if (d.type === 'providers-changed') loadProviders();
}
function onFocus(e) {
    if (!e.detail || e.detail.id !== 'asset-manager' || !S.loaded) return;
    scheduleSoft(['assets', 'canvas', 'local']);
    loadProviders();
}
let channel = null;
onMounted(() => {
    refresh();
    window.addEventListener('message', onMessage);
    window.addEventListener('novai-page-focus', onFocus);
    window.addEventListener('am-clear-selection', clearSelections);
    window.addEventListener('am-local-loaded', localAfterLoad);
    try { channel = new BroadcastChannel('studio-api'); channel.onmessage = ev => { if (ev.data && ev.data.type === 'providers-changed') loadProviders(); }; } catch (err) { channel = null; }
});
onBeforeUnmount(() => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('novai-page-focus', onFocus);
    window.removeEventListener('am-clear-selection', clearSelections);
    window.removeEventListener('am-local-loaded', localAfterLoad);
    if (channel) channel.close();
    clearTimeout(softTimer);
});
</script>

<template>
    <div class="am">
        <header class="am-head">
            <h1>素材库</h1>
            <span class="am-st" :title="S.status"><span class="am-dot" :class="{ busy }"></span>{{ S.status }}</span>
            <button type="button" class="nv-btn sm" @click="S.prefsOpen = true"><NvIcon name="settings" />偏好设置</button>
            <button type="button" class="nv-btn sm" @click="refresh"><NvIcon name="refresh" />刷新</button>
        </header>
        <div class="am-tabsrow">
            <div class="nv-tabs" role="tablist">
                <button type="button" class="nv-tab" :class="{ 'is-on': isMedia }" role="tab" :aria-selected="isMedia" @click="!isMedia && setTab(lastMediaTab())">素材</button>
                <button type="button" class="nv-tab" :class="{ 'is-on': S.tab === 'prompts' }" role="tab" :aria-selected="S.tab === 'prompts'" @click="setTab('prompts')">提示词库</button>
                <button type="button" class="nv-tab" :class="{ 'is-on': S.tab === 'workflows' }" role="tab" :aria-selected="S.tab === 'workflows'" @click="setTab('workflows')">工作流</button>
            </div>
            <div v-if="isMedia" class="nv-seg static" role="group" aria-label="素材来源">
                <button v-for="s in SOURCES" :key="s.id" type="button" :class="{ 'is-on': S.tab === s.id }" :title="s.title" :aria-pressed="S.tab === s.id" @click="setTab(s.id)">
                    {{ s.label }}<em v-if="counts[s.id]">{{ counts[s.id] }}</em>
                </button>
            </div>
        </div>

        <LibraryPane v-if="S.tab === 'assets'" />
        <CanvasPane v-else-if="S.tab === 'canvas-assets'" />
        <LocalPane v-else-if="S.tab === 'local'" />
        <PromptsPane v-else-if="S.tab === 'prompts'" />
        <WorkflowsPane v-else />

        <StoragePathBar />
        <PrefsModal />
        <Lightbox />
        <AskDialog />
    </div>
</template>
