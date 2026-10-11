<script setup>
// SVG 节点图：按拓扑分层排布，「N 已用」= 已暴露字段数；拖拽空白平移、滚轮缩放、缩放按钮 / 适应窗口；点节点开弹层
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import NodePopup from './NodePopup.vue';
import { t } from '../../../lib/store.js';
import { nodeLabel, computeLayers, tf } from './nodeInfo.js';
import { wf } from './wfStore.js';

const NODE_W = 140, NODE_H = 50, X_GAP = 30, Y_GAP = 20, PAD = 16;
const wrap = ref(null);
const view = ref({ k: 1, x: 0, y: 0 });
const panning = ref(false);
const popPos = ref({ left: 0, top: 0, maxH: 400 });
let pan = null;

const layout = computed(() => {
    const w = wf.workflow;
    if (!w || !Object.keys(w).length) return { nodes: [], edges: [], w: 0, h: 0 };
    const { buckets } = computeLayers(w);
    const pos = {};
    const levels = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    let maxRows = 0;
    levels.forEach(lv => {
        const ids = buckets[lv].slice().sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        ids.forEach((id, i) => { pos[id] = { x: lv * (NODE_W + X_GAP) + PAD, y: i * (NODE_H + Y_GAP) + PAD }; });
        maxRows = Math.max(maxRows, ids.length);
    });
    const edges = [];
    Object.keys(w).forEach(toId => {
        const seen = new Set();
        Object.values((w[toId] && w[toId].inputs) || {}).forEach(v => {
            if (!(Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && pos[v[0]]) || seen.has(v[0])) return;
            seen.add(v[0]);
            const a = pos[v[0]], b = pos[toId];
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, cx = (x1 + x2) / 2;
            edges.push({ key: v[0] + '>' + toId, d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}` });
        });
    });
    const fields = (wf.config && wf.config.fields) || [];
    const nodes = Object.entries(w).map(([id, node]) => {
        const label = nodeLabel(node), sub = node.class_type || '';
        return {
            id, x: pos[id].x, y: pos[id].y,
            label: label.length > 12 ? label.slice(0, 12) + '…' : label,
            sub: sub.length > 16 ? sub.slice(0, 16) + '…' : sub,
            used: fields.filter(f => f.node === id).length,
        };
    });
    return { nodes, edges, w: levels.length * (NODE_W + X_GAP) + PAD, h: maxRows * (NODE_H + Y_GAP) + PAD };
});

const zoomText = computed(() => Math.round(view.value.k * 100) + '%');
function zoomAt(newK, cx, cy) {
    const v = view.value;
    view.value = { k: newK, x: cx - (cx - v.x) * (newK / v.k), y: cy - (cy - v.y) * (newK / v.k) };
}
function zoom(dir) {
    const el = wrap.value; if (!el) return;
    const k = Math.max(0.2, Math.min(3, view.value.k * (dir > 0 ? 1.2 : 1 / 1.2)));
    zoomAt(k, el.clientWidth / 2, el.clientHeight / 2);
}
function fit() {
    const el = wrap.value, L = layout.value;
    if (!el || !L.w) return;
    const pad = 20;
    const k = Math.max(0.2, Math.min(2, Math.min((el.clientWidth - pad * 2) / L.w, (el.clientHeight - pad * 2) / L.h)));
    view.value = { k, x: (el.clientWidth - L.w * k) / 2, y: (el.clientHeight - L.h * k) / 2 };
}
function onWheel(e) {
    const el = wrap.value; if (!el) return;
    const k = Math.max(0.2, Math.min(3, view.value.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const r = el.getBoundingClientRect();
    zoomAt(k, e.clientX - r.left, e.clientY - r.top);
}
function onDown(e) {
    if (e.button !== 0 || e.target.closest('.gnode') || e.target.closest('.gctl')) return;
    e.preventDefault();
    pan = { sx: e.clientX, sy: e.clientY, ox: view.value.x, oy: view.value.y };
    panning.value = true;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}
function onMove(e) { if (pan) view.value = { ...view.value, x: pan.ox + e.clientX - pan.sx, y: pan.oy + e.clientY - pan.sy }; }
function onUp() { pan = null; panning.value = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }

// 弹层：尽量贴在节点右侧；放不下放左侧；防止溢出底部
function openPopup(id, ev) {
    wf.popupNodeId = id;
    const el = wrap.value;
    const wr = el.getBoundingClientRect(), gr = ev.currentTarget.getBoundingClientRect();
    const POP_W = 380;
    const maxH = Math.min(el.clientHeight - 40, innerHeight * 0.7);
    let left = gr.right - wr.left + 12;
    if (left + POP_W > el.clientWidth - 8) left = gr.left - wr.left - POP_W - 12;
    if (left < 8) left = 8;
    let top = gr.top - wr.top;
    const maxTop = el.clientHeight - maxH - 8;
    if (top > maxTop) top = Math.max(8, maxTop);
    if (top < 8) top = 8;
    popPos.value = { left, top, maxH };
}
function closePopup() { wf.popupNodeId = null; }
function onKey(e) {
    if (e.key === 'Escape' && wf.popupNodeId && !wf.lightbox && !document.querySelector('.wfd-scrim, .wsel-menu')) {
        e.stopImmediatePropagation(); e.preventDefault(); closePopup();
    }
}
watch(() => wf.fitTick, () => { view.value = { k: 1, x: 0, y: 0 }; nextTick(() => setTimeout(fit, 50)); });
onMounted(() => { window.addEventListener('keydown', onKey, true); nextTick(() => setTimeout(fit, 50)); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true); onUp(); });
defineExpose({ fit });
</script>

<template>
    <div ref="wrap" class="graph" :class="{ panning }" @wheel.prevent="onWheel" @mousedown="onDown">
        <svg class="gsvg" aria-label="节点图">
            <g :transform="`translate(${view.x},${view.y}) scale(${view.k})`">
                <path v-for="e in layout.edges" :key="e.key" class="gedge" :d="e.d" />
                <g v-for="n in layout.nodes" :key="n.id" class="gnode" :class="{ x: n.used > 0, on: wf.popupNodeId === n.id }" :transform="`translate(${n.x},${n.y})`" role="button" tabindex="0" :aria-label="n.label" @click="openPopup(n.id, $event)" @keydown.enter.prevent="openPopup(n.id, $event)">
                    <rect :width="NODE_W" :height="NODE_H" rx="9" />
                    <text class="t" x="11" y="21">{{ n.label }}</text>
                    <text class="s" x="11" y="37">{{ n.sub }}</text>
                    <text class="s" :x="NODE_W - 9" y="21" text-anchor="end">#{{ n.id }}</text>
                    <text v-if="n.used > 0" class="b" :x="NODE_W - 9" y="40" text-anchor="end">{{ tf('comfy.usedCount', { count: n.used }, '{count} 已用') }}</text>
                </g>
            </g>
        </svg>
        <div class="gctl" @mousedown.stop @wheel.stop>
            <button type="button" :title="t('canvas.decrease', '缩小')" :aria-label="t('canvas.decrease', '缩小')" @click="zoom(-1)"><NvIcon name="minus" /></button>
            <span>{{ zoomText }}</span>
            <button type="button" :title="t('canvas.increase', '放大')" :aria-label="t('canvas.increase', '放大')" @click="zoom(1)"><NvIcon name="plus" /></button>
            <button type="button" title="适应窗口" aria-label="适应窗口" @click="fit"><NvIcon name="fit" /></button>
        </div>
        <div v-if="wf.popupNodeId" class="bd" @mousedown.stop @click="closePopup"></div>
        <NodePopup v-if="wf.popupNodeId" :pos="popPos" @close="closePopup" />
    </div>
</template>

<style scoped>
.graph { position: relative; height: 520px; border-radius: 14px; background-color: var(--canvas); background-image: radial-gradient(var(--canvas-grid) 1px, transparent 1.1px); background-size: 18px 18px; overflow: hidden; cursor: grab; user-select: none; }
.graph.panning { cursor: grabbing; }
.gsvg { position: absolute; inset: 0; width: 100%; height: 100%; }
.gedge { fill: none; stroke: var(--ink-4); stroke-width: 1.3; }
.gnode { cursor: pointer; outline: none; }
.gnode rect { fill: var(--solid); filter: drop-shadow(0 1px 2px rgba(0,0,0,.08)); transition: filter var(--duration-fast); }
.gnode:hover rect, .gnode:focus-visible rect { filter: drop-shadow(0 4px 10px rgba(0,0,0,.14)); }
.gnode.x rect { stroke: var(--ink); stroke-width: 1.2; }
.gnode.on rect { stroke: var(--ink); stroke-width: 2; }
.gnode .t { font: 500 11.5px var(--font-sans); fill: var(--ink); }
.gnode .s { font: 400 9.5px var(--font-mono); fill: var(--ink-3); }
.gnode .b { font: 500 9.5px var(--font-sans); fill: var(--ink); }
.gctl { position: absolute; right: 12px; bottom: 12px; z-index: 5; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 99px; background: var(--glass-strong); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--shadow-rim), var(--shadow-float); cursor: default; }
.gctl button { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 99px; background: transparent; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); cursor: pointer; }
.gctl button:hover { background: var(--fill-2); color: var(--ink); }
.gctl .nv-i { width: 14px; height: 14px; }
.gctl span { min-width: 40px; text-align: center; font: 400 11px/1 var(--font-mono); color: var(--ink-2); }
.bd { position: absolute; inset: 0; z-index: 8; cursor: default; }
</style>
