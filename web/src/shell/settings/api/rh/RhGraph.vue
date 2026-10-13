<script setup>
// 工作流节点图（SVG）：按依赖分层排布，滚轮缩放、拖拽平移、缩放按钮 / 适应窗口；点节点弹出字段（默认插槽放弹层）
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import ExtIcon from '../kit/ExtIcon.vue';
import NvIcon from '../../../../components/NvIcon.vue';
import { computeRhWorkflowEditorLayers, workflowNodeTitle, workflowNodeClass, workflowNodeCategory } from './rh-utils.js';

const props = defineProps({ workflow: Object, fields: Array, activeNodeId: String });
const emit = defineEmits(['pick', 'blank']);

const NODE_W = 136, NODE_H = 52, X_GAP = 42, Y_GAP = 16;
const wrap = ref(null);
const g = reactive({ k: 1, x: 0, y: 0 });
const size = reactive({ w: 800, h: 520 });

const layout = computed(() => {
    const workflow = props.workflow || {};
    const ids = Object.keys(workflow);
    if (!ids.length) return { nodes: [], edges: [], w: 0, h: 0 };
    const { buckets } = computeRhWorkflowEditorLayers(workflow);
    const positions = {};
    const levels = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    let maxRows = 0;
    levels.forEach(lv => {
        const list = buckets[lv].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        list.forEach((id, idx) => { positions[id] = { x: lv * (NODE_W + X_GAP) + 18, y: idx * (NODE_H + Y_GAP) + 18 }; });
        maxRows = Math.max(maxRows, list.length);
    });
    const edges = [];
    ids.forEach(toId => {
        const seen = new Set();
        Object.values((workflow[toId] && workflow[toId].inputs) || {}).forEach(value => {
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && positions[value[0]] && positions[toId]) {
                if (seen.has(value[0])) return;
                seen.add(value[0]);
                const from = positions[value[0]], to = positions[toId];
                const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x, y2 = to.y + NODE_H / 2, cx = (x1 + x2) / 2;
                edges.push({ id: value[0] + '>' + toId, d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}` });
            }
        });
    });
    const enabled = (props.fields || []).filter(f => f.enabled === true);
    const nodes = ids.map(id => {
        const node = workflow[id];
        const title = workflowNodeTitle(node), klass = workflowNodeClass(node);
        const count = enabled.filter(f => String(f.nodeId) === String(id)).length;
        const hasFields = (props.fields || []).some(f => String(f.nodeId) === String(id));
        return {
            id, ...positions[id], count, hasFields, cat: workflowNodeCategory(node),
            title: title.length > 15 ? title.slice(0, 15) + '...' : title,
            klass: klass.length > 18 ? klass.slice(0, 18) + '...' : klass,
        };
    });
    return { nodes, edges, w: levels.length * (NODE_W + X_GAP) + 18, h: maxRows * (NODE_H + Y_GAP) + 18 };
});

function measure() { const el = wrap.value; if (el) { size.w = el.clientWidth || 800; size.h = el.clientHeight || 520; } }
function zoom(dir) {
    measure();
    const factor = dir > 0 ? 1.2 : 1 / 1.2;
    const k = Math.max(0.2, Math.min(3, g.k * factor));
    const cx = size.w / 2, cy = size.h / 2;
    g.x = cx - (cx - g.x) * (k / g.k);
    g.y = cy - (cy - g.y) * (k / g.k);
    g.k = k;
}
function fit() {
    measure();
    const { w, h } = layout.value;
    if (!w || !h) return;
    const pad = 24;
    const k = Math.max(0.2, Math.min(2, Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h)));
    g.k = k;
    g.x = (size.w - w * k) / 2;
    g.y = (size.h - h * k) / 2;
}
function reset() { g.k = 1; g.x = 0; g.y = 0; }
function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const k = Math.max(0.2, Math.min(3, g.k * factor));
    const rect = wrap.value.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    g.x = mx - (mx - g.x) * (k / g.k);
    g.y = my - (my - g.y) * (k / g.k);
    g.k = k;
}
let pan = null;
const panning = ref(false);
let moved = false;
function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    pan = { sx: e.clientX, sy: e.clientY, ox: g.x, oy: g.y };
    moved = false;
    panning.value = true;
}
function onMove(e) {
    if (!pan) return;
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    g.x = pan.ox + dx;
    g.y = pan.oy + dy;
}
function onUp() { pan = null; panning.value = false; }
function pick(id) { if (moved) return; emit('pick', String(id)); }
function blank() { if (!moved) emit('blank'); }

let ro = null;
onMounted(() => {
    measure();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    if (window.ResizeObserver && wrap.value) { ro = new ResizeObserver(measure); ro.observe(wrap.value); }
    nextTick(() => setTimeout(fit, 50));
});
onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (ro) ro.disconnect();
});
defineExpose({ fit, reset });
</script>

<template>
    <div ref="wrap" class="gr" :class="{ panning }" @wheel="onWheel">
        <svg class="gr-svg" :viewBox="`0 0 ${size.w} ${size.h}`" @mousedown="onDown" @click="blank">
            <text v-if="!layout.nodes.length" x="24" y="42" class="gr-empty">暂无工作流预览</text>
            <g :transform="`translate(${g.x},${g.y}) scale(${g.k})`">
                <path v-for="e in layout.edges" :key="e.id" class="gr-edge" :d="e.d" />
                <g v-for="n in layout.nodes" :key="n.id" class="gr-node" :class="['cat-' + n.cat, { x: n.count > 0, on: n.id === activeNodeId, dim: !n.hasFields }]"
                   :transform="`translate(${n.x},${n.y})`" @click.stop="pick(n.id)">
                    <rect :width="NODE_W" :height="NODE_H" rx="8" />
                    <text class="t" x="10" y="20">{{ n.title }}</text>
                    <text class="s" x="10" y="36">{{ n.klass }}</text>
                    <text class="s" :x="NODE_W - 8" y="20" text-anchor="end">#{{ n.id }}</text>
                    <text v-if="n.count" class="b" :x="NODE_W - 8" y="43" text-anchor="end">{{ n.count }} 已用</text>
                </g>
            </g>
        </svg>
        <div class="gr-ctl" @mousedown.stop>
            <button type="button" title="缩小" aria-label="缩小" @click="zoom(-1)"><ExtIcon name="zoomout" /></button>
            <span>{{ Math.round(g.k * 100) }}%</span>
            <button type="button" title="放大" aria-label="放大" @click="zoom(1)"><ExtIcon name="zoomin" /></button>
            <button type="button" title="适应窗口" aria-label="适应窗口" @click="fit"><NvIcon name="maximize" /></button>
        </div>
        <slot />
    </div>
</template>

<style scoped>
.gr { position: relative; flex: 1; min-width: 0; min-height: 0; border-radius: 14px; background-color: var(--canvas); background-image: radial-gradient(var(--canvas-grid) 1px, transparent 1.1px); background-size: 18px 18px; overflow: hidden; cursor: grab; }
.gr.panning { cursor: grabbing; }
.gr-svg { position: absolute; inset: 0; width: 100%; height: 100%; user-select: none; }
.gr-empty { font: 400 12px var(--font-sans); fill: var(--ink-3); }
.gr-edge { fill: none; stroke: var(--ink-4); stroke-width: 1.3; }
.gr-node { cursor: pointer; }
.gr-node rect { fill: var(--solid); filter: drop-shadow(0 1px 2px rgba(0,0,0,.08)); transition: stroke-width var(--duration-fast); }
.gr-node:hover rect { filter: drop-shadow(0 4px 10px rgba(0,0,0,.12)); }
.gr-node.x rect { stroke: var(--ink); stroke-width: 1.2; }
.gr-node.on rect { stroke: var(--ink); stroke-width: 2; }
.gr-node.dim { opacity: .62; }
.gr-node .t { font: 500 11.5px var(--font-sans); fill: var(--ink); }
.gr-node .s { font: 400 9.5px var(--font-mono); fill: var(--ink-3); }
.gr-node .b { font: 500 9.5px var(--font-sans); fill: var(--ink); }
.gr-ctl { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 99px; background: var(--glass-strong); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--shadow-rim), var(--shadow-float); cursor: default; z-index: 2; }
.gr-ctl button { width: 26px; height: 26px; border: 0; border-radius: 99px; background: transparent; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); cursor: pointer; transition: background var(--duration-fast); }
.gr-ctl button:hover { background: var(--fill-2); color: var(--ink); }
.gr-ctl .nv-i { width: 14px; height: 14px; }
.gr-ctl span { min-width: 40px; text-align: center; font: 400 11px/1 var(--font-mono); color: var(--ink-2); padding: 0 4px; }
</style>
