<script setup>
// 在线生图（页面 id: online，替换旧 static/online.html）。
// 左栏：提示词 / 参考图片（Main·Aux A·Aux B，点击 / 拖入 / 粘贴）/ 模型与尺寸 三张可折叠卡片 + 吸底「生成」；
// 右栏：结果区（画布就绪 / 生成中 / 结果图 + 下载，点图看大图）+ 历史归档（加载更多、管理模式、批量导出 / 删除）；
// 大图预览：缩放平移、上一张 / 下一张、下载、复用（填回提示词 + 参考图 + 尺寸）。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import OnCard from './OnCard.vue';
import RefSlots from './RefSlots.vue';
import ModelSizeCard from './ModelSizeCard.vue';
import ArchiveGrid from './ArchiveGrid.vue';
import ImageLightbox from './ImageLightbox.vue';
import { state, t, toast } from '../../lib/store.js';
import { downloadUrl, extOf } from './download.js';
import { S, visibleHistory, hasMore, initModels, loadPolicy, setRatio, setResolution, scheduleProviderRefresh, handleFile, clearSlot, firstEmptySlot, submit, applySameStyle, loadHistory, loadMore, removeHistory } from './useOnline.js';

const side = ref(null);
const promptEl = ref(null);
const lbIndex = ref(-1);

// 多图结果（×N）在大图里逐张可翻
const entries = computed(() => visibleHistory.value.flatMap(item => (item.images || []).filter(Boolean).map((url, i) => ({
    url, prompt: item.prompt || '', size: (item.params && item.params.size) || '', item, sub: i,
}))));
function openItem(item, sub = 0) {
    const i = entries.value.findIndex(e => e.item === item && e.sub === sub);
    if (i >= 0) lbIndex.value = i;
}
function zoomResult() {
    if (!S.result) return;
    const item = visibleHistory.value.find(h => String(h.timestamp) === String(S.result.timestamp));
    if (item) openItem(item);
}
const slotViews = computed(() => S.slots.map(s => ({ preview: s.preview, uploading: s.uploading })));

async function save(url, failText) {
    if (!url) return;
    try { await downloadUrl(url, `online-image-${Date.now()}.${extOf(url)}`); }
    catch (e) { toast(failText, { danger: true, icon: 'alert' }); }
}
function onReuse(entry) {
    applySameStyle(entry.item);
    lbIndex.value = -1;
    nextTick(() => { if (side.value) side.value.scrollTo({ top: 0, behavior: 'smooth' }); autoResize(); });
}

// 提示词自动增高（80–300px）
function autoResize() {
    const el = promptEl.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(80, Math.min(el.scrollHeight, 300)) + 'px';
}
watch(() => S.prompt, () => nextTick(autoResize));

/* ───────── 外部事件 ───────── */
function onMessage(e) {
    const type = e && e.data && e.data.type;
    if (type === 'providers-changed' || type === 'workflows-changed') scheduleProviderRefresh();
}
function onFocus(e) { if (e.detail && e.detail.id === 'online') scheduleProviderRefresh(); }
function onVisible() { if (!document.hidden && state.active === 'online') scheduleProviderRefresh(); }
// 粘贴图片 → 第一个空的参考图格（只在本页激活、没有弹层时接）
function onPaste(e) {
    if (state.active !== 'online' || lbIndex.value >= 0) return;
    const item = [...((e.clipboardData && e.clipboardData.items) || [])].find(x => x.kind === 'file' && x.type.startsWith('image/'));
    if (item) handleFile(firstEmptySlot(), item.getAsFile());
}
let channel = null;

onMounted(async () => {
    window.addEventListener('message', onMessage);
    window.addEventListener('novai-page-focus', onFocus);
    window.addEventListener('paste', onPaste);
    document.addEventListener('visibilitychange', onVisible);
    try { channel = new BroadcastChannel('studio-api'); channel.onmessage = () => scheduleProviderRefresh(); } catch (e) {}
    autoResize();
    loadPolicy();
    setRatio('square'); setResolution('1k');
    await initModels();
    loadHistory();
});
onBeforeUnmount(() => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('novai-page-focus', onFocus);
    window.removeEventListener('paste', onPaste);
    document.removeEventListener('visibilitychange', onVisible);
    if (channel) channel.close();
});
</script>

<template>
    <div class="olp">
        <aside ref="side" class="side">
            <OnCard icon="type" :title="t('online.promptLabel', '提示词')">
                <textarea ref="promptEl" v-model="S.prompt" class="ta" rows="3" :placeholder="t('online.promptPlaceholder', '输入想生成或编辑的画面...')" @input="autoResize"></textarea>
            </OnCard>
            <OnCard icon="image" :title="t('online.referenceImages', '参考图片')">
                <RefSlots :slots="slotViews" @file="handleFile" @clear="clearSlot" />
            </OnCard>
            <OnCard icon="settings" :title="t('online.model', '模型')">
                <ModelSizeCard />
            </OnCard>
            <span class="grow"></span>
            <button type="button" class="gen" :class="{ busy: S.generating }" :disabled="S.generating" @click="submit">
                <span v-if="S.generating" class="spin"></span><NvIcon v-else name="bolt" />
                {{ S.generating ? t('online.generating', '生成中') : t('online.generate', '生成') }}
            </button>
        </aside>

        <main class="main">
            <div class="inner">
                <div class="res">
                    <Transition name="ofade" mode="out-in">
                        <div v-if="S.generating" key="ld" class="ph"><span class="spin big"></span><p>{{ t('online.generating', '生成中') }}</p></div>
                        <img v-else-if="S.result && S.result.images && S.result.images[0]" key="img" :src="S.result.images[0]" class="out" alt="生成结果" @click="zoomResult" />
                        <div v-else key="ph" class="ph idle"><NvIcon name="tpl" /><p>{{ t('online.canvasReady', '画布就绪') }}</p></div>
                    </Transition>
                    <button v-if="!S.generating && S.result && S.result.images && S.result.images[0]" type="button" class="dl" title="下载" aria-label="下载"
                        @click.stop="save(S.result.images[0], '保存失败：无法下载图片')"><NvIcon name="download" /></button>
                </div>

                <ArchiveGrid :items="visibleHistory" :has-more="hasMore" :status="S.status"
                    :title="t('online.archives', '归档')" :fallback-prompt="t('online.onlineImageFallback', '在线生图')"
                    @open="openItem" @load-more="loadMore" @removed="removeHistory">
                    <template #badge="{ item }">
                        <span v-if="item.images.length > 1" class="nv-badge on-image cn">×{{ item.images.length }}</span>
                    </template>
                </ArchiveGrid>
            </div>
        </main>

        <ImageLightbox v-model="lbIndex" :entries="entries" prompt-label="Prompt" :reuse-label="t('online.reuse', '复用')" reuse-hint="填回提示词 + 参考图"
            @reuse="onReuse" @download="e => save(e.url, '下载失败')" />
    </div>
</template>

<style scoped>
.olp { position: absolute; inset: 0; display: flex; overflow: hidden; background: transparent; color: var(--ink); font-family: var(--font-sans); }
.side { box-sizing: border-box; width: clamp(300px, 30vw, 360px); flex: none; height: 100%; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 24px 16px 24px 24px; scrollbar-width: none; }
.side::-webkit-scrollbar { display: none; }
.grow { flex: 1; min-height: 4px; }
.ta { display: block; width: 100%; min-height: 80px; padding: 9px 11px; border: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/19px var(--font-sans); resize: none; outline: none; transition: height .15s ease-out, background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.ta::placeholder { color: var(--ink-4); }
.ta:focus { background: var(--fill-2); box-shadow: none; }
.gen { position: sticky; bottom: 0; flex: none; width: 100%; height: 52px; border: 0; border-radius: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--accent); color: var(--on-accent); font: 500 14px/1 var(--font-sans); box-shadow: var(--shadow-lift); cursor: pointer; }
.gen { position: sticky; isolation: isolate; overflow: hidden; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.gen:not(.busy):hover { transform: translateY(-1px); }
.gen:not(.busy):active { transform: scale(.99); }
/* 生成按钮的扫光（ds.css .nv-btn.generate 同款，单色：动效就是提示） */
.gen:not(.busy)::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: linear-gradient(105deg, transparent 35%, var(--shimmer) 50%, transparent 65%); background-size: 250% 100%; background-position: 130% 0; opacity: .35; animation: nv-sweep 3.2s var(--ease-in-out) infinite; }
.gen:not(.busy):hover::after { opacity: .6; }
.gen .nv-i { width: 16px; height: 16px; }
.gen.busy { background: var(--fill-2); color: var(--ink-2); box-shadow: none; cursor: progress; backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); }
.main { flex: 1; min-width: 0; height: 100%; overflow-y: auto; scrollbar-width: none; }
.main::-webkit-scrollbar { display: none; }
.inner { max-width: 1080px; margin: 0 auto; padding: 24px 24px 48px 8px; display: flex; flex-direction: column; gap: 40px; }
.res { position: relative; height: clamp(420px, 58vh, 720px); border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-float); overflow: hidden; display: flex; align-items: center; justify-content: center; }
.res .out { width: 100%; height: 100%; object-fit: contain; padding: 24px; cursor: zoom-in; }
.res .ph { display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--ink-3); }
.res .ph p { margin: 0; font: 400 12px/1 var(--font-sans); }
.res .ph.idle .nv-i { width: 24px; height: 24px; color: var(--ink-4); }
.res .spin.big { width: 22px; height: 22px; }
.res .dl { position: absolute; right: 16px; bottom: 16px; width: 36px; height: 36px; border: 0; border-radius: 99px; background: var(--glass-strong); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--shadow-pop); display: inline-flex; align-items: center; justify-content: center; color: var(--ink); cursor: pointer; transition: transform var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out); }
.res .dl:hover { transform: translateY(-1px); background: var(--solid); }
.res .dl .nv-i { width: 16px; height: 16px; }
.cn { position: absolute; right: 10px; top: 10px; z-index: 2; pointer-events: none; }
.ofade-enter-active, .ofade-leave-active { transition: opacity 240ms var(--ease-out); }
.ofade-enter-from, .ofade-leave-to { opacity: 0; }
@media (max-width: 768px) {
    .olp { flex-direction: column; overflow-y: auto; }
    .side { width: 100%; height: auto; overflow: visible; padding: 16px; }
    .main { height: auto; overflow: visible; }
    .inner { padding: 8px 16px 48px; }
    .res { height: auto; min-height: 320px; }
    .gen { position: static; }
}
</style>
