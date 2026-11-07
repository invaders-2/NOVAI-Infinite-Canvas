<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Titlebar from './shell/Titlebar.vue';
import LegacyStage from './shell/LegacyStage.vue';
import ToastHost from './shell/ToastHost.vue';
import SettingsModal from './shell/SettingsModal.vue';
import CanvasListPage from './pages/canvas/CanvasListPage.vue';
import HomePage from './pages/home/HomePage.vue';
import AssetsPage from './pages/assets/AssetsPage.vue';
import MarketPage from './pages/market/MarketPage.vue';
import MePage from './pages/me/MePage.vue';
import UpdateModal from './shell/UpdateModal.vue';
import UpdateDone from './shell/UpdateDone.vue';
import UpdateReminder from './shell/UpdateReminder.vue';
import Welcome from './shell/Welcome.vue';
import AuthDialog from './shell/AuthDialog.vue';
import { auth, loadAuth, standaloneView } from './lib/auth.js';
import { initUpdates } from './lib/update.js';
import { state } from './lib/store.js';

const isCanvas = computed(() => state.active === 'canvas' && state.canvasOpen);
// 2026-11 重做：左侧导航下线，主导航进标题栏。网页版进画布编辑器时不显示标题栏（编辑器自带返回 / 标题胶囊），
// 桌面端始终显示（要给红绿灯 / 窗口按钮留位置）
const showBar = computed(() => !(isCanvas.value && !state.desktop));
const isHome = computed(() => state.active === 'home');
// 首页 / 画布列表 / 素材库 / 应用市场 / 我的：页面铺满整窗，内容从标题栏下面滚过，标题栏统一用渐变磨砂（画布编辑器除外）
const FULL = ['home', 'canvas', 'asset-manager', 'store', 'me'];
const isFull = computed(() => !isCanvas.value && FULL.includes(state.active));
// 离开画布时清掉素材面板标记，避免再次进入时残留状态
watch(isCanvas, on => { if (!on) state.sourcePanelOpen = false; });

// 只有首访且落在首页才出欢迎层；深链/记住的 native 页不能先被欢迎层盖住
const intro = ref((() => { try { return localStorage.getItem('novai-visited') || state.active !== 'home' ? '' : 'welcome'; } catch (e) { return ''; } })());
watch(() => state.active, id => { if (id !== 'home' && intro.value === 'welcome') intro.value = ''; });
// /login、/reset：只显示登录 / 找回密码界面（必须登录模式下没登录会被送到这里），不加载外壳
const standalone = standaloneView();
onMounted(() => {
    document.documentElement.classList.remove('studio-route-booting');
    if (standalone) return;
    initUpdates();
    loadAuth();
});
</script>

<template>
    <AuthDialog v-if="standalone" page :initial="standalone" />
    <div v-else class="shell" :class="['desk-' + (state.desktop || 'web'), { 'route-canvas': isCanvas, 'route-home': isHome, 'route-full': isFull, 'no-bar': !showBar }]">
        <!-- 标题栏的渐变磨砂：三层模糊由强到弱向下淡出 + 一层底色渐变；首页 / 画布列表 / 素材库 / 应用市场 / 我的都有（内容会从标题栏下面滚过） -->
        <div v-if="showBar && isFull" class="tb-fx" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <Titlebar v-if="showBar" />
        <div class="body">
            <main class="stage">
                <HomePage v-if="state.visited.home" v-show="isHome" class="stage-page home-page" />
                <CanvasListPage v-show="state.active === 'canvas' && !state.canvasOpen" />
                <AssetsPage v-if="state.visited['asset-manager']" v-show="state.active === 'asset-manager'" class="stage-page" />
                <MarketPage v-if="state.visited.store" v-show="state.active === 'store'" class="stage-page" />
                <MePage v-if="state.visited.me" v-show="state.active === 'me'" class="stage-page" />
                <LegacyStage />
            </main>
        </div>
        <div v-if="isFull" class="bt-fx" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <SettingsModal @quickstart="intro = 'quickstart'" />
        <UpdateModal />
        <UpdateDone />
        <UpdateReminder />
        <Welcome :mode="intro" @close="intro = ''" />
        <AuthDialog v-if="auth.dialog" />
        <ToastHost />
    </div>
</template>

<style scoped>
/* 标题栏高度：mac 52（红绿灯垂直居中在 26px）· windows 44 · 网页 52 */
.shell { position: relative; height: 100%; display: flex; flex-direction: column; background: var(--shell-bg); --shell-bg: #f5f5f7; --stage-bg: #ffffff; --tbh: 52px; --tb-tint: rgba(245,245,247,.82); }
.shell.desk-windows { --tbh: 44px; }
.shell.no-bar { --tbh: 0px; }

/* 内容区：标题栏浮在上面，其它页从标题栏下沿开始；首页铺满整窗，内容从标题栏下面滚过 */
.body { position: relative; flex: 1; min-height: 0; display: flex; padding: var(--tbh) 15px 15px; box-sizing: border-box; }
.route-home .body, .route-full .body { padding: 0; }
.stage { position: relative; flex: 1; min-width: 0; border-radius: 20px; overflow: hidden; background: transparent; }
.route-home .stage, .route-full .stage { border-radius: 0; }
/* 重写过的 native 页永远压在 LegacyStage 的 iframe 层之上；非激活页由 v-show 置 none */
.stage-page { position: absolute; inset: 0; z-index: 1; }
.home-page { position: absolute; inset: 0; }
/* 画布编辑器：画布铺满标题栏以下的整块区域（去掉留白和圆角） */
.route-canvas .body { padding: var(--tbh) 0 0; }
.route-canvas .stage { border-radius: 0; box-shadow: none; }

/* 渐变磨砂（参照 Apple Music 顶栏）：没有硬边，越往下越清楚 */
.tb-fx { position: absolute; left: 0; right: 0; top: 0; height: calc(var(--tbh) + 36px); z-index: 59; pointer-events: none; }
.tb-fx i { position: absolute; inset: 0; display: block; }
.tb-fx i:nth-child(1) { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); -webkit-mask: linear-gradient(#000 55%, transparent); mask: linear-gradient(#000 55%, transparent); }
.tb-fx i:nth-child(2) { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); -webkit-mask: linear-gradient(#000 40%, transparent 80%); mask: linear-gradient(#000 40%, transparent 80%); }
.tb-fx i:nth-child(3) { backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); -webkit-mask: linear-gradient(#000 25%, transparent 62%); mask: linear-gradient(#000 25%, transparent 62%); }
.tb-fx i:nth-child(4) { background: linear-gradient(var(--tb-tint), transparent); }
/* 底部同款，方向反过来 */
.bt-fx { position: absolute; left: 0; right: 0; bottom: 0; height: 72px; z-index: 59; pointer-events: none; }
.bt-fx i { position: absolute; inset: 0; display: block; }
.bt-fx i:nth-child(1) { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); -webkit-mask: linear-gradient(to top, #000 45%, transparent); mask: linear-gradient(to top, #000 45%, transparent); }
.bt-fx i:nth-child(2) { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); -webkit-mask: linear-gradient(to top, #000 30%, transparent 75%); mask: linear-gradient(to top, #000 30%, transparent 75%); }
.bt-fx i:nth-child(3) { backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); -webkit-mask: linear-gradient(to top, #000 15%, transparent 55%); mask: linear-gradient(to top, #000 15%, transparent 55%); }
.bt-fx i:nth-child(4) { background: linear-gradient(to top, var(--tb-tint), transparent 85%); }
</style>

<style>
/* 深色 / 桌面端覆盖：放在非 scoped 块里（Vue scoped 的 :global(a) .b 会把整个选择器编译成 a，规则失效） */
html.theme-dark .shell { --shell-bg: #0c0c0c; --stage-bg: #141416; --tb-tint: rgba(12,12,13,.78); }
</style>
