<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Titlebar from './shell/Titlebar.vue';
import Sidebar from './shell/Sidebar.vue';
import LegacyStage from './shell/LegacyStage.vue';
import ToastHost from './shell/ToastHost.vue';
import SettingsModal from './shell/SettingsModal.vue';
import CanvasListPage from './pages/canvas/CanvasListPage.vue';
import OnlinePage from './pages/online/OnlinePage.vue';
import ZImagePage from './pages/online/ZImagePage.vue';
import ChatPage from './pages/chat/ChatPage.vue';
import AssetsPage from './pages/assets/AssetsPage.vue';
import UpdateModal from './shell/UpdateModal.vue';
import UpdateDone from './shell/UpdateDone.vue';
import UpdateReminder from './shell/UpdateReminder.vue';
import Welcome from './shell/Welcome.vue';
import { initUpdates, openUpdateModal } from './lib/update.js';
import { state } from './lib/store.js';

const isCanvas = computed(() => state.active === 'canvas' && state.canvasOpen);
// 画布编辑态：始终隐藏左侧导航，让画布真正铺满（素材面板打开只是其中一种情况）；退出画布自动恢复
const hideSidebar = computed(() => isCanvas.value);
// 离开画布时清掉素材面板标记，避免再次进入时残留状态
watch(isCanvas, on => { if (!on) state.sourcePanelOpen = false; });
function openSettings(tab) { state.settingsTab = typeof tab === 'string' ? tab : 'general'; state.settingsOpen = true; }

const intro = ref((() => { try { return localStorage.getItem('novai-visited') ? '' : 'welcome'; } catch (e) { return ''; } })());
onMounted(() => {
    document.documentElement.classList.remove('studio-route-booting');
    initUpdates();
});
</script>

<template>
    <div class="shell" :class="['desk-' + (state.desktop || 'web'), { 'route-canvas': isCanvas, 'sidebar-hidden': hideSidebar, pinned: state.pinned }]">
        <Titlebar @open-settings="openSettings" />
        <div class="body">
            <Sidebar @open-settings="openSettings" @open-update="openUpdateModal" />
            <main class="stage">
                <CanvasListPage v-show="state.active === 'canvas' && !state.canvasOpen" />
                <OnlinePage v-if="state.visited.online" v-show="state.active === 'online'" />
                <ZImagePage v-if="state.visited.zimage" v-show="state.active === 'zimage'" />
                <ChatPage v-if="state.visited['gpt-chat']" v-show="state.active === 'gpt-chat'" />
                <AssetsPage v-if="state.visited['asset-manager']" v-show="state.active === 'asset-manager'" />
                <LegacyStage />
            </main>
        </div>
        <SettingsModal @quickstart="intro = 'quickstart'" />
        <UpdateModal />
        <UpdateDone />
        <UpdateReminder />
        <Welcome :mode="intro" @close="intro = ''" />
        <ToastHost />
    </div>
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; background: var(--shell-bg); --shell-bg: #f5f5f7; --stage-bg: #ffffff; }

/* 外壳布局还原旧版：四周 15px 留白，左侧圆角浮卡导航；右侧内容区不要底框背景（用户要求），直接落在外壳底色上 */
.body { position: relative; flex: 1; min-height: 0; display: flex; padding: 15px; box-sizing: border-box; }
.stage { position: relative; flex: 1; min-width: 0; margin-left: 10px; border-radius: 20px; overflow: hidden; background: transparent; transition: margin-left .3s ease-out; }
/* 画布页：画布铺满整个窗口（去掉留白和圆角），侧栏保持 15px 内缩浮在画布上 */
.route-canvas .body { padding: 0; }
.route-canvas .stage { position: absolute; inset: 0; margin: 0; border-radius: 0; box-shadow: none; }
.route-canvas :deep(.sidebar) { margin: 15px 0 15px 15px; height: calc(100% - 30px); }
/* 画布编辑态：左侧导航平滑收起（约 180ms），画布铺满整宽；退出画布（回列表）自动恢复 */
.route-canvas.sidebar-hidden :deep(.sidebar) {
    width: 0; min-width: 0; max-width: 0; margin: 0; padding-left: 0; padding-right: 0;
    opacity: 0; transform: translateX(-12px); pointer-events: none;
    transition: width .18s ease-out, min-width .18s ease-out, max-width .18s ease-out, margin .18s ease-out, opacity .18s ease-out, transform .18s ease-out;
}
</style>

<style>
/* 深色 / 桌面端覆盖：放在非 scoped 块里（Vue scoped 的 :global(a) .b 会把整个选择器编译成 a，规则失效） */
html.theme-dark .shell { --shell-bg: #0c0c0c; --stage-bg: #141416; }
</style>
