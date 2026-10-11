<script setup>
// 历史归档网格（在线生图 / Z-Image 共用，替换旧 renderImageCard + history-bulk-manager.js + loadMoreTrigger）：
//   常驻批量操作条（已选 n 张 / 全选·取消全选 / 删除所选 / 导出 / 管理·完成），管理模式下点卡片切换勾选；
//   pending 占位卡、悬停显示提示词、加载更多（进入视口自动加载 + 点击）、加载中 / 加载失败。
// 与旧版不同：「删除所有」改为只删勾选项，并弹二次确认（旧版会删掉页面上已加载的全部卡片）。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { t, toast } from '../../lib/store.js';
import { deleteHistory, exportUrls } from './download.js';

const props = defineProps({
    items: { type: Array, default: () => [] },          // [{ timestamp, images, prompt, type, ... }]
    pending: { type: Array, default: () => [] },        // [{ key, label }]
    hasMore: Boolean,
    status: { type: String, default: 'idle' },           // idle | first | more | error
    fallbackPrompt: { type: String, default: '' },
    title: { type: String, default: '归档' },
});
const emit = defineEmits(['open', 'load-more', 'removed']);

const selecting = ref(false);
const picked = ref(new Set());
const deleting = ref(false);
const exporting = ref(false);
const confirmOpen = ref(false);
const sentinel = ref(null);
let io = null;

const keyOf = it => String(it.timestamp);
const shown = computed(() => props.items.filter(it => it && Array.isArray(it.images) && it.images[0]));
const pickedItems = computed(() => shown.value.filter(it => picked.value.has(keyOf(it))));
const allPicked = computed(() => shown.value.length > 0 && pickedItems.value.length === shown.value.length);
const countText = computed(() => t('bulk.selectedCount', '已选 {n} 张').replace('{n}', pickedItems.value.length));

// 已经不在列表里的勾选项（被删 / 重新加载）自动剔除
watch(shown, list => {
    const keys = new Set(list.map(keyOf));
    const next = new Set([...picked.value].filter(k => keys.has(k)));
    if (next.size !== picked.value.size) picked.value = next;
});

function enter() { selecting.value = true; }
function exit() { selecting.value = false; picked.value = new Set(); }
function toggleAll() {
    if (!selecting.value) enter();
    picked.value = allPicked.value ? new Set() : new Set(shown.value.map(keyOf));
}
function toggle(it) {
    const next = new Set(picked.value);
    const k = keyOf(it);
    next.has(k) ? next.delete(k) : next.add(k);
    picked.value = next;
}
function onCard(it) { if (selecting.value) toggle(it); else emit('open', it); }

async function doDelete() {
    const targets = pickedItems.value.slice();
    if (!targets.length) return;
    const total = shown.value.length;
    deleting.value = true;
    const results = await Promise.allSettled(targets.map(it => deleteHistory(it.timestamp).then(() => it.timestamp)));
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failed = results.length - ok.length;
    deleting.value = false;
    confirmOpen.value = false;
    if (ok.length) emit('removed', ok);
    if (failed) toast(`${failed} / ${targets.length} 张删除失败`, { danger: true, icon: 'alert' });
    else toast(`已删除 ${ok.length} 张`, { icon: 'trash' });
    if (ok.length >= total) exit();
}

// 导出：优先导出选中的，未选中时导出全部已加载的
async function doExport() {
    if (!shown.value.length || exporting.value) return;
    const targets = pickedItems.value.length ? pickedItems.value : shown.value;
    exporting.value = true;
    const ok = await exportUrls(targets.map(it => it.images[0]));
    exporting.value = false;
    if (ok === 0) toast(t('bulk.exportFailed', '没有可导出的图片'), { danger: true, icon: 'alert' });
}

function more() { if (props.hasMore && props.status === 'idle') emit('load-more'); }
onMounted(() => {
    if (typeof IntersectionObserver === 'undefined' || !sentinel.value) return;
    io = new IntersectionObserver(entries => { if (entries[0].isIntersecting) more(); }, { threshold: 0.1 });
    io.observe(sentinel.value);
});
// 追加 / 删除后哨兵可能仍在视口里：重新 observe 一次让 IO 立刻再判一次
watch(() => [props.items.length, props.status], () => { if (io && sentinel.value) { io.unobserve(sentinel.value); io.observe(sentinel.value); } });
onBeforeUnmount(() => { if (io) io.disconnect(); });
defineExpose({ exit });
</script>

<template>
    <section class="oag">
        <div class="oag-head">
            <span class="eyebrow">{{ title }}</span>
            <span v-if="selecting" class="hint">管理中 · 点卡片切换勾选</span>
            <span class="sp"></span>
            <span class="cnt">{{ countText }}</span>
            <button type="button" class="b" :disabled="!shown.length" @click="toggleAll">{{ allPicked ? t('bulk.deselectAll', '取消全选') : t('bulk.selectAll', '全选') }}</button>
            <button type="button" class="b dng" :disabled="!pickedItems.length || deleting" @click="confirmOpen = true">
                <NvIcon name="trash" />{{ deleting ? t('bulk.deleting', '删除中…') : t('bulk.deleteSelected', '删除所选') }}
            </button>
            <button type="button" class="b" :disabled="!shown.length || exporting" @click="doExport">
                <NvIcon name="download" />{{ exporting ? t('bulk.exporting', '导出中…') : t('bulk.export', '导出') }}
            </button>
            <button v-if="selecting" type="button" class="b pri" @click="exit">{{ t('bulk.exit', '完成') }}</button>
            <button v-else type="button" class="b" :disabled="!shown.length" @click="enter">{{ t('bulk.manage', '管理') }}</button>
        </div>

        <TransitionGroup tag="div" name="oag-i" class="oag-grid" :class="{ selecting }">
            <div v-for="p in pending" :key="'p-' + p.key" class="oag-card pend">
                <span class="spin"></span><span class="lb">{{ p.label }}</span>
            </div>
            <div v-for="it in shown" :key="keyOf(it)" class="oag-card" :class="{ picked: selecting && picked.has(keyOf(it)) }"
                role="button" tabindex="0" :aria-pressed="selecting ? picked.has(keyOf(it)) : undefined"
                @click="onCard(it)" @keydown.enter.prevent="onCard(it)">
                <img :src="it.images[0]" loading="lazy" alt="" draggable="false" />
                <slot name="badge" :item="it"></slot>
                <span v-if="!selecting" class="hv">{{ it.prompt || fallbackPrompt }}</span>
                <span v-if="selecting" class="ck" :class="{ on: picked.has(keyOf(it)) }"><NvIcon v-if="picked.has(keyOf(it))" name="check" /></span>
            </div>
        </TransitionGroup>

        <div ref="sentinel" class="oag-foot">
            <span v-if="status === 'first'" class="st">{{ t('online.loadingArchives', '正在加载归档...') }}</span>
            <span v-else-if="status === 'more'" class="st"><span class="spin"></span>加载中...</span>
            <span v-else-if="status === 'error'" class="st err">{{ t('studio.errorHistory', '历史加载失败') }}<button type="button" class="more" @click="emit('load-more')"><NvIcon name="refresh" />重试</button></span>
            <button v-else-if="hasMore" type="button" class="more" @click="more"><NvIcon name="chev" />{{ t('online.loadMore', '加载更多归档') }}</button>
            <span v-else-if="!shown.length && !pending.length" class="st">还没有归档</span>
        </div>

        <ConfirmDialog :open="confirmOpen" :busy="deleting" danger :title="t('bulk.deleteSelected', '删除所选')"
            :desc="t('bulk.deleteConfirm', '确认删除选中的 {n} 张图片？此操作不可恢复。').replace('{n}', pickedItems.length)"
            ok-text="删除" @ok="doDelete" @cancel="confirmOpen = false" />
    </section>
</template>

<style scoped>
.oag { display: flex; flex-direction: column; gap: 16px; }
.oag-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 32px; }
.oag-head .hint { font: 400 11px/1 var(--font-sans); color: var(--ink-3); margin-left: 8px; }
.oag-head .sp { flex: 1; }
.oag-head .cnt { font: 400 11px/1 var(--font-mono); letter-spacing: .04em; color: var(--ink-2); margin-right: 4px; }
.oag-head .b { height: 32px; padding: 0 12px; border: 0; border-radius: 99px; display: inline-flex; align-items: center; gap: 6px; background: var(--fill-1); color: var(--ink); font: 500 12px/1 var(--font-sans); white-space: nowrap; cursor: pointer; transition: background var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out); }
.oag-head .b:hover:not(:disabled) { background: var(--fill-2); }
.oag-head .b .nv-i { width: 14px; height: 14px; }
.oag-head .b.pri { background: var(--accent); color: var(--on-accent); }
.oag-head .b.pri:hover { background: var(--accent); opacity: .88; }
.oag-head .b.dng { background: var(--danger-fill); color: var(--danger); }
.oag-head .b:disabled { color: var(--ink-4); background: var(--fill-1); cursor: default; }
.oag-grid { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 1100px) { .oag-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 768px) { .oag-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.oag-card { position: relative; aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: var(--fill-1); cursor: zoom-in; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.oag-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lift); }
.oag-grid.selecting .oag-card { cursor: pointer; }
.oag-card img { display: block; width: 100%; height: 100%; object-fit: cover; transition: transform 1s var(--ease-out); }
.oag-card:hover img { transform: scale(1.04); }
.oag-card .hv { position: absolute; left: 0; right: 0; bottom: 0; padding: 36px 12px 12px; background: linear-gradient(transparent, rgba(10,10,10,.72)); color: #fff; font: 400 11px/16px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; opacity: 0; transition: opacity var(--duration-fast) var(--ease-out); pointer-events: none; }
.oag-card:hover .hv { opacity: 1; }
.oag-card .ck { position: absolute; left: 10px; top: 10px; width: 22px; height: 22px; border-radius: 99px; background: rgba(10,10,10,.28); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.95); display: inline-flex; align-items: center; justify-content: center; color: #fff; }
.oag-card .ck .nv-i { width: 12px; height: 12px; }
.oag-card .ck.on { background: var(--accent); color: var(--on-accent); box-shadow: 0 0 0 1.5px var(--solid); }
.oag-card.picked { box-shadow: var(--shadow-lift); }
.oag-card.pend { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--ink-3); cursor: default; }
.oag-card.pend:hover { transform: none; box-shadow: none; }
.oag-card.pend .spin { width: 20px; height: 20px; position: relative; z-index: 1; }
.oag-card.pend .lb { position: relative; z-index: 1; font: 400 11px/1 var(--font-sans); }
.oag-card.pend::after { content: ""; position: absolute; inset: 0; background: linear-gradient(105deg, transparent 30%, var(--shimmer) 50%, transparent 70%); background-size: 250% 100%; animation: nv-sweep 1.6s var(--ease-in-out) infinite; }
.oag-foot { display: flex; justify-content: center; align-items: center; min-height: 72px; padding: 8px 0 24px; }
.oag-foot .st { display: inline-flex; align-items: center; gap: 8px; font: 400 12px/1 var(--font-sans); color: var(--ink-3); }
.oag-foot .st .spin { width: 12px; height: 12px; }
.oag-foot .st.err { color: var(--danger); }
.oag-foot .more { height: 32px; padding: 0 14px; border: 0; border-radius: 99px; display: inline-flex; align-items: center; gap: 6px; background: var(--fill-1); color: var(--ink-2); font: 500 12px/1 var(--font-sans); cursor: pointer; }
.oag-foot .more:hover { background: var(--fill-2); color: var(--ink); }
.oag-foot .more .nv-i { width: 13px; height: 13px; }
.oag-i-enter-active { transition: opacity 400ms var(--ease-out), transform 400ms var(--ease-out); }
.oag-i-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.oag-i-enter-from { opacity: 0; transform: translateY(8px); }
.oag-i-leave-to { opacity: 0; transform: scale(.96); }
.oag-i-move { transition: transform 320ms var(--ease-out); }
</style>
