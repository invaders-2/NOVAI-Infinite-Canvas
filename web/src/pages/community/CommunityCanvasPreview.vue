<script setup>
// 只读画布预览（社区作品详情左侧）：按真实节点坐标铺开，可拖动平移、滚轮缩放；
// 图片/视频直接显示，文本显示正文，其它节点显示标题 + 线框图标。只读，不写回任何东西。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { mediaUrl } from '../../lib/community.js';

const props = defineProps({ payload: { type: Object, default: () => ({}) }, tip: { type: String, default: '只读预览 · 可拖动缩放' } });

const stage = ref(null);
const view = reactive({ x: 0, y: 0, z: 1 });
const nodes = computed(() => (Array.isArray(props.payload && props.payload.nodes) ? props.payload.nodes : []));
const connections = computed(() => (Array.isArray(props.payload && props.payload.connections) ? props.payload.connections : []));
const byId = computed(() => {
    const map = {};
    nodes.value.forEach(n => { if (n && n.id) map[n.id] = n; });
    return map;
});
const edges = computed(() => connections.value
    .map(e => {
        const from = byId.value[e && (e.from || e.source)];
        const to = byId.value[e && (e.to || e.target)];
        return from && to ? { from, to } : null;
    })
    .filter(Boolean));

function num(n, key, fallback) { const v = Number(n && n[key]); return Number.isFinite(v) ? v : fallback; }
const rectOf = n => ({ x: num(n, 'x', 0), y: num(n, 'y', 0), w: num(n, 'w', 260), h: num(n, 'h', 200) });
function rectStyle(n) {
    const r = rectOf(n);
    return { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' };
}
function edgePath(edge) {
    const a = rectOf(edge.from);
    const b = rectOf(edge.to);
    const ay = a.y + a.h / 2, by = b.y + b.h / 2;
    const ax = a.x + a.w / 2, bx = b.x + b.w / 2;
    const dx = Math.max(60, Math.abs(bx - ax) / 2);
    const sx = bx >= ax ? ax + a.w / 2 : ax - a.w / 2;
    const ex = bx >= ax ? bx - b.w / 2 : bx + b.w / 2;
    const c1 = sx + (bx >= ax ? dx : -dx);
    const c2 = ex + (bx >= ax ? -dx : dx);
    return 'M' + (a.x + a.w / 2) + ',' + ay + ' C' + c1 + ',' + ay + ' ' + c2 + ',' + by + ' ' + (b.x + b.w / 2) + ',' + by;
}

const mediaOf = n => {
    if (!n) return '';
    if (typeof n.url === 'string' && n.url) return mediaUrl(n.url);
    const gen = (n.data && n.data.gen) || {};
    const hist = Array.isArray(gen.hist) ? gen.hist : [];
    const index = Number.isFinite(Number(gen.hi)) ? Number(gen.hi) : hist.length - 1;
    const picked = hist[index] || hist[hist.length - 1];
    return picked && picked.url ? mediaUrl(picked.url) : '';
};
const isVideo = url => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(url || ''));
const titleOf = n => {
    const gen = (n && n.data && n.data.gen) || {};
    return String((gen && gen.title) || (n && n.title) || (n && n.kind) || '节点');
};
const textOf = n => String((n && n.text) || '');
const promptOf = n => String(((n && n.data && n.data.gen && n.data.gen.prompt) || '') || '');
const kindIcon = n => {
    const kind = String((n && n.kind) || '');
    if (kind === 'text') return 'type';
    if (kind === 'video') return 'video';
    if (kind === 'table') return 'table';
    if (kind === 'group') return 'group';
    return 'image';
};

/* ───────── 视口 ───────── */
function fit() {
    const el = stage.value;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (!nodes.value.length) { view.z = 1; view.x = box.width / 2; view.y = box.height / 2; return; }
    const rects = nodes.value.map(rectOf);
    const minX = Math.min(...rects.map(r => r.x));
    const maxX = Math.max(...rects.map(r => r.x + r.w));
    const minY = Math.min(...rects.map(r => r.y));
    const maxY = Math.max(...rects.map(r => r.y + r.h));
    const padX = 80, padY = 80;
    const z = Math.min(1.15, Math.max(0.15, Math.min((box.width - padX) / Math.max(1, maxX - minX), (box.height - padY) / Math.max(1, maxY - minY))));
    view.z = z;
    view.x = (box.width - (maxX - minX) * z) / 2 - minX * z;
    view.y = (box.height - (maxY - minY) * z) / 2 - minY * z;
}
function zoomAt(z, cx, cy) {
    const next = Math.min(2, Math.max(0.1, z));
    view.x = cx - (cx - view.x) * next / view.z;
    view.y = cy - (cy - view.y) * next / view.z;
    view.z = next;
}
function zoomTo(percent) {
    const el = stage.value;
    if (!el) return;
    const box = el.getBoundingClientRect();
    zoomAt(percent / 100, box.width / 2, box.height / 2);
}
let pan = null;
function onDown(event) {
    if (event.button !== 0 || event.target.closest('.cv-zoom')) return;
    pan = { sx: event.clientX, sy: event.clientY, ox: view.x, oy: view.y, moved: false };
    stage.value.setPointerCapture(event.pointerId);
}
function onMove(event) {
    if (!pan) return;
    const dx = event.clientX - pan.sx, dy = event.clientY - pan.sy;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    if (pan.moved) { view.x = pan.ox + dx; view.y = pan.oy + dy; }
}
function onUp() { pan = null; }
function onWheel(event) {
    event.preventDefault();
    const box = stage.value.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey || (Math.abs(event.deltaY) >= 40 && !event.deltaX)) {
        zoomAt(view.z * Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
    } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
    }
}
const pct = computed(() => Math.round(view.z * 100));

let observer = null;
onMounted(() => {
    nextTick(() => requestAnimationFrame(fit));
    if (typeof ResizeObserver !== 'undefined' && stage.value) {
        observer = new ResizeObserver(() => fit());
        observer.observe(stage.value);
    }
});
onBeforeUnmount(() => { if (observer) observer.disconnect(); });
watch(() => props.payload, () => nextTick(() => requestAnimationFrame(fit)), { deep: false });
</script>

<template>
    <div ref="stage" class="cpr" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel">
        <div class="cpr-world" :style="{ transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.z + ')' }">
            <svg class="cpr-edges" width="1" height="1">
                <path v-for="(edge, i) in edges" :key="i" :d="edgePath(edge)" />
            </svg>
            <div v-for="n in nodes" :key="n.id" class="cpr-node" :class="'k-' + (n.kind || 'image')" :style="rectStyle(n)" :title="titleOf(n)">
                <span class="al"><NvIcon :name="kindIcon(n)" />{{ titleOf(n) }}</span>
                <template v-if="n.kind === 'text'">
                    <div class="tx">{{ textOf(n) }}</div>
                </template>
                <template v-else-if="mediaOf(n)">
                    <video v-if="isVideo(mediaOf(n))" :src="mediaOf(n)" muted loop playsinline preload="metadata"></video>
                    <img v-else :src="mediaOf(n)" alt="" draggable="false" loading="lazy" />
                </template>
                <template v-else>
                    <div class="ph"><NvIcon :name="kindIcon(n)" /><span>{{ promptOf(n) || titleOf(n) }}</span></div>
                </template>
            </div>
        </div>
        <span v-if="tip" class="cpr-tip"><NvIcon name="eye" />{{ tip }}</span>
        <div class="cv-zoom" @pointerdown.stop>
            <button type="button" title="适应画布" aria-label="适应画布" @click="fit"><NvIcon name="fit" /></button>
            <input type="range" min="10" max="200" :value="pct" aria-label="缩放" @input="zoomTo(+$event.target.value)" />
            <button type="button" title="重置为 100%" @click="zoomTo(100)">{{ pct }}%</button>
        </div>
    </div>
</template>

<style scoped>
.cpr { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--canvas); cursor: grab; touch-action: none; }
.cpr:active { cursor: grabbing; }
.cpr-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.cpr-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.cpr-edges path { fill: none; stroke: var(--ink-4); stroke-width: 1.6; }
.cpr-node { position: absolute; border-radius: 14px; background: var(--solid); box-shadow: var(--shadow-float); overflow: hidden; }
.cpr-node .al { position: absolute; left: 2px; top: -19px; z-index: 2; display: flex; align-items: center; gap: 4px; font: 500 11px/1 var(--font-sans); color: var(--ink-2); white-space: nowrap; }
.cpr-node .al .nv-i { width: 12px; height: 12px; }
.cpr-node img, .cpr-node video { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.cpr-node.k-text { background: var(--solid); }
.cpr-node.k-text .tx { height: 100%; overflow: hidden; padding: 14px 16px; font: 400 12px/1.65 var(--font-sans); color: var(--ink-2); white-space: pre-wrap; }
.cpr-node .ph { height: 100%; padding: 14px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; color: var(--ink-3); }
.cpr-node .ph .nv-i { width: 18px; height: 18px; flex: none; }
.cpr-node .ph span { font: 400 11.5px/1.6 var(--font-sans); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; }
.cpr-tip { position: absolute; left: 14px; top: 14px; z-index: 3; height: 28px; padding: 0 10px; border-radius: 14px; display: inline-flex; align-items: center; gap: 5px; background: var(--glass-strong); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.cpr-tip .nv-i { width: 12px; height: 12px; }
.cv-zoom { position: absolute; left: 14px; bottom: 14px; z-index: 3; height: 36px; padding: 0 6px; border-radius: 18px; display: flex; align-items: center; gap: 4px; background: var(--glass-strong); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick); box-shadow: var(--shadow-float); }
.cv-zoom button { height: 28px; min-width: 28px; padding: 0 5px; border: 0; border-radius: 14px; background: transparent; color: var(--ink-3); font: 400 12px/1 var(--font-sans); display: flex; align-items: center; justify-content: center; cursor: pointer; font-variant-numeric: tabular-nums; }
.cv-zoom button:hover { background: var(--fill-1); color: var(--ink); }
.cv-zoom .nv-i { width: 14px; height: 14px; }
.cv-zoom input { width: 88px; accent-color: var(--ink); }
@media (max-width: 720px) { .cv-zoom input { display: none; } }
</style>
