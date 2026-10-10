<script setup>
// 设置 → API 设置（重写自 static/api-settings.html + static/js/api-settings.js）。
// 三个视图：平台详情 / 推荐 API（进入时默认）/ 存储设置·输出目录；页头标题旁的下拉切换平台。
// 子面板（同事负责）：api/RunningHubPanel.vue、api/CliPanel.vue、api/LovartPanel.vue，
// props { provider, providers, save }（RunningHubPanel 另传 section="entries"，两把 RH Key 在本面板的 KeyTile 里），emit dirty（布尔，显示「未保存」）。
import { ref, provide, onMounted } from 'vue';
import ProviderView from './api/parts/ProviderView.vue';
import RecommendView from './api/parts/RecommendView.vue';
import StorageView from './api/parts/StorageView.vue';
import ApiConfirm from './api/parts/ApiConfirm.vue';
import { createApiStore } from './api/core/useApiStore.js';

const store = createApiStore();
const S = store.S;
const scroller = ref(null);

const childEvents = {
    // 子面板就地修改 provider，不会 emit changed；不要在这里 reload（会冲掉未保存的就地修改）
    dirty: v => { S.childDirty = !!v; },
};
provide('apiStore', store);
provide('apiChildEvents', childEvents);
provide('apiSettings', { save: store.save, reload: store.reload, setDirty: childEvents.dirty, store });

function onScroll() { const el = scroller.value; S.stuck = !!el && el.scrollTop > 4; }
function onViewEnter() { if (scroller.value) scroller.value.scrollTop = 0; }
onMounted(() => { store.load(); });
</script>

<template>
    <div ref="scroller" class="api nv-root" @scroll.passive="onScroll">
        <div v-if="!S.loaded" class="loading">
            <template v-if="S.loadFailed">
                <p>API 平台加载失败</p>
                <button type="button" class="nv-btn sm" @click="store.load()">重试</button>
            </template>
            <template v-else>
                <div class="nv-skel sk1"></div>
                <div class="skrow"><div class="nv-skel"></div><div class="nv-skel"></div></div>
                <div class="skrow"><div class="nv-skel"></div><div class="nv-skel"></div></div>
            </template>
        </div>
        <Transition v-else name="view" mode="out-in" @enter="onViewEnter">
            <RecommendView v-if="S.view === 'recommend'" key="recommend" />
            <StorageView v-else-if="S.view === 'storage'" key="storage" />
            <ProviderView v-else :key="'p:' + S.selectedId" />
        </Transition>
        <ApiConfirm :state="S.confirm" @done="store.answer" />
    </div>
</template>

<style scoped>
/* 挂载容器需要是 position:relative 且有确定高度（与旧 iframe 的 .c-frame 相同），这里自己滚动、页头吸顶 */
.api { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 36px 40px; color: var(--ink); background: var(--solid); scrollbar-width: thin; }
.loading { padding: 64px 0; display: flex; flex-direction: column; gap: 10px; }
.loading p { margin: 0 0 6px; font: 400 13px/18px var(--font-sans); color: var(--ink-2); }
.loading .nv-btn { align-self: flex-start; }
.sk1 { height: 54px; width: 40%; border-radius: 12px; }
.skrow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.skrow .nv-skel { height: 120px; border-radius: 14px; }
.view-enter-active { transition: opacity 180ms var(--ease-out), transform 220ms var(--ease-out); }
.view-leave-active { transition: opacity 120ms linear; }
.view-enter-from { opacity: 0; transform: translateY(6px); }
.view-leave-to { opacity: 0; }
@media (max-width: 760px) { .api { padding: 0 20px 32px; } }
@media (prefers-reduced-motion: reduce) { .view-enter-active, .view-leave-active { transition: none; } }
</style>
