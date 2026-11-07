<script setup>
// 模板预览：居中弹窗里的只读画布。节点按模板定义（templates.js 的 nodes：col 列号 + inputs 上游）真实铺开，
// 可平移 / 缩放 / 点选；选中生成节点时下方显示它的提示词与参数（只读，「用这个模板」新建画布后才能运行）。
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import NvIcon from '../../components/NvIcon.vue';

const props = defineProps({ template: { type: Object, required: true }, busy: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'use', 'agent']);

/* ───────── 把模板节点排成画布 ───────── */
const RATIO = { square: [260, 260], portrait43: [240, 320], wide: [320, 180], '16:9': [320, 180], '9:16': [200, 356], '3:4': [240, 320], '4:3': [300, 225], '': [260, 260] };
const RATIO_TEXT = { square: '1:1', portrait43: '3:4', wide: '16:9', '16:9': '16:9', '9:16': '9:16', '3:4': '3:4', '4:3': '4:3' };
// 示例效果图：带 preview 的模板（第一个生成节点是 16:9）用横版图，没写就回落到卡片封面
const exampleSrc = computed(() => props.template.preview || props.template.media);
function sizeOf(n) {
    if (n.type === 'label') return [160, 34];
    if (n.type === 'image') return [220, 180];
    if (n.type === 'group') return [240, 190];
    if (n.type === 'text') return [240, n.text && n.text.length > 120 ? 220 : 150];
    if (n.type === 'table') return [300, 190];
    if (n.type === 'batch') return [260, 170];
    return RATIO[n.ratio] || RATIO[''];
}
const COL_W = 360, GAP = 54;
const graph = computed(() => {
    const t = props.template;
    const cols = {};
    let firstGen = null;
    const nodes = (t.nodes || []).map((n, i) => {
        const [w, h] = sizeOf(n);
        const col = Number(n.col) || 0;
        const out = { ...n, idx: i, w, h, col };
        if (n.type === 'gen' && !firstGen) { firstGen = out; out.example = true; }
        (cols[col] = cols[col] || []).push(out);
        return out;
    });
    // 每列竖着排，整体垂直居中
    const heights = Object.keys(cols).map(c => cols[c].reduce((s, n) => s + n.h + GAP + 22, -GAP));
    const maxH = Math.max(...heights, 0);
    Object.keys(cols).forEach(c => {
        const list = cols[c];
        let y = (maxH - list.reduce((s, n) => s + n.h + GAP + 22, -GAP)) / 2;
        list.forEach(n => { n.x = Number(c) * COL_W + (c > 0 ? 40 : 0); n.y = y + 22; y += n.h + GAP + 22; });
    });
    const byKey = {};
    nodes.forEach(n => { if (n.key) byKey[n.key] = n; });
    const edges = [];
    nodes.forEach(n => (n.inputs || []).forEach(k => { if (byKey[k]) edges.push([byKey[k], n]); }));
    return { nodes, edges };
});
const numbered = computed(() => {
    let i = 0;
    const map = {};
    graph.value.nodes.forEach(n => { if (n.type !== 'label') map[n.idx] = ++i; });
    return map;
});
function titleOf(n) {
    if (n.type === 'text') return n.brief ? '你的需求' : (n.title || '说明');
    if (n.type === 'image') return n.title || (n.ref ? '参考图' : '素材');
    if (n.type === 'group') return n.title || '素材组';
    if (n.type === 'table') return n.title || '多维表格';
    if (n.type === 'batch') return n.title || '批量生成';
    return n.title || (n.video ? '视频' : '图片');
}
function iconOf(n) { return n.type === 'text' ? 'type' : n.type === 'table' ? 'table' : n.type === 'batch' ? 'layers' : n.type === 'group' ? 'group' : n.video ? 'video' : 'image'; }
function edgePath(a, b) { const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, dx = Math.max(40, (x2 - x1) / 2); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; }

/* ───────── 视口：平移 / 缩放 ───────── */
const view = reactive({ x: 0, y: 0, z: 1 });
const selIdx = ref(-1);
const sel = computed(() => graph.value.nodes.find(n => n.idx === selIdx.value) || null);
const stage = ref(null);
const showTip = ref(true);
function zoomAt(z, cx, cy) { z = Math.min(2, Math.max(0.25, z)); view.x = cx - (cx - view.x) * z / view.z; view.y = cy - (cy - view.y) * z / view.z; view.z = z; }
function fit() {
    const el = stage.value; if (!el) return;
    const r = el.getBoundingClientRect();
    const N = graph.value.nodes;
    if (!N.length) return;
    const minX = Math.min(...N.map(n => n.x)), maxX = Math.max(...N.map(n => n.x + n.w)), minY = Math.min(...N.map(n => n.y)) - 26, maxY = Math.max(...N.map(n => n.y + n.h));
    const aw = r.width - 100, ah = r.height - (sel.value && sel.value.type === 'gen' ? 230 : 110);
    const z = Math.min(1.1, Math.max(0.3, Math.min(aw / (maxX - minX), ah / (maxY - minY))));
    view.z = z; view.x = 50 + (aw - (maxX - minX) * z) / 2 - minX * z; view.y = 40 + (ah - (maxY - minY) * z) / 2 - minY * z;
}
let pan = null;
function onDown(e) {
    if (e.button !== 0 || e.target.closest('.tp-panel, .tp-zoom, .tp-vbar')) return;
    pan = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false, node: e.target.closest('[data-idx]') };
    stage.value.setPointerCapture(e.pointerId);
}
function onMove(e) {
    if (!pan) return;
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    if (pan.moved) { view.x = pan.ox + dx; view.y = pan.oy + dy; }
}
function onUp() {
    if (pan && !pan.moved) {
        const idx = pan.node ? Number(pan.node.dataset.idx) : -1;
        selIdx.value = idx;
    }
    pan = null;
}
function onWheel(e) {
    e.preventDefault();
    const r = stage.value.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) >= 40 && !e.deltaX)) zoomAt(view.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    else { view.x -= e.deltaX; view.y -= e.deltaY; }
}
function zoomTo(p) { const r = stage.value.getBoundingClientRect(); zoomAt(p / 100, r.width / 2, r.height / 2); }
const pct = computed(() => Math.round(view.z * 100));
const hot = n => n.idx === selIdx.value;
const edgeHot = (a, b) => a.idx === selIdx.value || b.idx === selIdx.value;

/* 选中生成节点：下方弹出它的提示词与参数（位置跟着节点走） */
const panelStyle = computed(() => {
    const n = sel.value; const el = stage.value;
    if (!n || n.type !== 'gen' || !el) return null;
    const r = el.getBoundingClientRect();
    const w = Math.min(520, r.width - 32);
    let left = view.x + (n.x + n.w / 2) * view.z - w / 2;
    left = Math.max(16, Math.min(r.width - w - 16, left));
    const top = Math.min(r.height - 176, view.y + (n.y + n.h) * view.z + 14);
    return { left: left + 'px', top: top + 'px', width: w + 'px' };
});
const upstream = computed(() => graph.value.edges.filter(([, b]) => b.idx === selIdx.value).map(([a]) => a));

/* 示例视频 */
const vid = ref(null);
const playing = ref(false);
const vt = reactive({ cur: 0, dur: 0 });
function videoEl() { const v = vid.value; return Array.isArray(v) ? v[0] : v; }
function togglePlay() { const v = videoEl(); if (!v) return; if (v.paused) { v.play(); playing.value = true; } else { v.pause(); playing.value = false; } }
function onTime() { const v = videoEl(); if (v) { vt.cur = v.currentTime; vt.dur = v.duration || 0; } }

function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => {
    document.addEventListener('keydown', onKey);
    nextTick(() => requestAnimationFrame(fit));
    setTimeout(() => { showTip.value = false; }, 3200);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="tp-scrim" @click="emit('close')"></div>
        <div class="tp" role="dialog" aria-modal="true" :aria-label="template.title + ' 模板预览'">
            <div class="tp-h">
                <h3>{{ template.title }}</h3><span class="tp-badge">{{ template.cat }}</span>
                <span class="sp"></span>
                <span class="ro">只读预览，想改就用它新建一张画布</span>
                <button type="button" class="tp-btn" :disabled="busy" @click="emit('agent')"><NvIcon name="spark" />交给画布助手</button>
                <button type="button" class="tp-btn pri" :disabled="busy" @click="emit('use')">用这个模板<NvIcon name="chevr" /></button>
                <button type="button" class="tp-x" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
            </div>
            <div ref="stage" class="tp-c" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel">
                <div class="tp-world" :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }">
                    <svg class="tp-edges" width="1" height="1"><path v-for="(e, i) in graph.edges" :key="i" :class="{ hot: edgeHot(e[0], e[1]) }" :d="edgePath(e[0], e[1])" /></svg>
                    <div v-for="n in graph.nodes" :key="n.idx" class="tp-nd" :class="['t-' + n.type, { on: hot(n) }]" :data-idx="n.idx"
                         :style="{ left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }">
                        <template v-if="n.type === 'label'"><span class="lbl">{{ n.text }}</span></template>
                        <template v-else>
                            <div class="al"><NvIcon :name="iconOf(n)" />[{{ numbered[n.idx] }}] {{ titleOf(n) }}<span v-if="n.example" class="ex">示例效果</span></div>
                            <!-- 生成节点：第一个放模板的示例效果，其它显示提示词草稿 -->
                            <template v-if="n.type === 'gen'">
                                <div v-if="n.example" class="im">
                                    <video v-if="template.video" ref="vid" :src="template.video" :poster="exampleSrc" muted loop playsinline preload="metadata" @loadedmetadata="onTime" @timeupdate="onTime"></video>
                                    <img v-else :src="exampleSrc" alt="" draggable="false" />
                                    <div v-if="template.video" class="tp-vbar" @pointerdown.stop>
                                        <button type="button" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay"><NvIcon :name="playing ? 'pause' : 'play'" /></button>
                                        <span>{{ vt.cur.toFixed(1) }}s</span><span class="trk"><i :style="{ width: (vt.dur ? vt.cur / vt.dur * 100 : 0) + '%' }"></i></span><span>{{ vt.dur ? vt.dur.toFixed(1) + 's' : '' }}</span>
                                    </div>
                                </div>
                                <div v-else class="draft"><NvIcon :name="n.video ? 'video' : 'image'" /><p>{{ n.prompt }}</p><span>{{ RATIO_TEXT[n.ratio] || '自动比例' }}</span></div>
                            </template>
                            <div v-else-if="n.type === 'text'" class="txt">{{ n.brief ? '在首页输入框里写的需求会放在这里，例如卖点、风格、使用场景。' : n.text }}</div>
                            <div v-else-if="n.type === 'image'" class="drop"><NvIcon name="upload" /><span>{{ n.ref ? '首页上传的参考图会放在这里' : '把图片拖进来' }}</span></div>
                            <div v-else-if="n.type === 'group'" class="drop"><NvIcon name="group" /><span>把多张图片一起拖进来</span></div>
                            <div v-else-if="n.type === 'table'" class="tbl"><i v-for="k in 12" :key="k"></i></div>
                            <div v-else class="drop"><NvIcon name="layers" /><span>表格每一行生成一张</span></div>
                            <span class="pt l"><NvIcon name="plus" /></span><span class="pt r"><NvIcon name="plus" /></span>
                        </template>
                    </div>
                </div>

                <Transition name="tp-fade"><div v-if="showTip" class="tp-tip">拖动空白处平移 · 滚轮缩放 · 点节点看详情</div></Transition>

                <div v-if="panelStyle" class="tp-panel" :style="panelStyle">
                    <div class="refs">
                        <span v-for="u in upstream" :key="u.idx" class="ref"><NvIcon :name="iconOf(u)" />{{ titleOf(u) }}</span>
                        <span v-if="!upstream.length" class="ref muted">没有上游输入</span>
                    </div>
                    <p class="prompt">{{ sel.prompt || '（运行时按上游输入生成）' }}</p>
                    <div class="bar">
                        <span class="mdl"><NvIcon :name="sel.video ? 'video' : 'image'" />自动</span>
                        <span class="prm">{{ sel.video ? '视频' : '图片' }} · {{ RATIO_TEXT[sel.ratio] || '自动比例' }}</span>
                        <span class="sp"></span>
                        <button type="button" class="run" disabled title="只读预览：用这个模板新建画布后才能运行"><NvIcon name="up" /></button>
                    </div>
                </div>

                <div class="tp-zoom" @pointerdown.stop>
                    <button type="button" title="适应画布" aria-label="适应画布" @click="fit"><NvIcon name="fit" /></button>
                    <input type="range" min="25" max="200" :value="pct" aria-label="缩放" @input="e => zoomTo(+e.target.value)" />
                    <button type="button" title="重置为 100%" @click="zoomTo(100)">{{ pct }}%</button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style>
/* teleport 到 #nv-layer：不用 scoped */
.tp-scrim { position: fixed; inset: 0; z-index: 80; background: var(--scrim); animation: tpFade .2s ease; }
.tp { position: fixed; left: 50%; top: 50%; z-index: 81; width: min(1080px, calc(100vw - 64px)); height: min(700px, calc(100vh - 80px)); transform: translate(-50%, -50%);
    display: flex; flex-direction: column; border-radius: 20px; overflow: hidden; background: var(--shell-bg, var(--bg)); box-shadow: var(--shadow-dialog); color: var(--ink); font-family: var(--font-sans);
    animation: tpIn .24s var(--ease-out); --tp-node: var(--solid); --tp-card: var(--fill-1); --tp-line: var(--ink-4); }
@keyframes tpIn { from { opacity: 0; transform: translate(-50%, -48%) scale(.98); } }
@keyframes tpFade { from { opacity: 0; } }
html:not(.theme-dark) .tp { --shell-bg: #f5f5f7; }
html.theme-dark .tp { --shell-bg: #0c0c0c; --tp-node: #1c1c1e; }
.tp-h { display: flex; align-items: center; gap: 10px; padding: 12px 14px 12px 20px; box-shadow: inset 0 -.5px 0 var(--separator); flex-wrap: wrap; }
.tp-h h3 { margin: 0; font: 600 15px/1.3 var(--font-sans); }
.tp-h .sp { flex: 1; }
.tp-h .ro { font-size: 12px; color: var(--ink-3); }
.tp-badge { height: 20px; padding: 0 8px; border-radius: 10px; background: var(--fill-2); font-size: 11px; color: var(--ink-3); display: inline-flex; align-items: center; }
.tp-btn { height: 30px; padding: 0 12px; border: 0; border-radius: 15px; background: var(--fill-2); color: var(--ink); font: 500 12px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.tp-btn .nv-i { width: 13px; height: 13px; }
.tp-btn.pri { background: var(--accent); color: var(--on-accent); }
.tp-btn:disabled { opacity: .5; cursor: default; }
.tp-x { width: 30px; height: 30px; border: 0; border-radius: 15px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.tp-x:hover { background: var(--fill-1); color: var(--ink); }
.tp-x .nv-i { width: 16px; height: 16px; }
.tp-c { position: relative; flex: 1; overflow: hidden; cursor: default; touch-action: none; }
.tp-c:active { cursor: grabbing; }
.tp-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.tp-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.tp-edges path { fill: none; stroke: var(--tp-line); stroke-width: 1.6; }
.tp-edges path.hot { stroke: var(--ink); }
.tp-nd { position: absolute; border-radius: 16px; background: var(--tp-node); box-shadow: var(--shadow-float); cursor: pointer; user-select: none; }
.tp-nd.on { box-shadow: 0 0 0 1.5px var(--ink), var(--shadow-lift); }
.tp-nd.t-label { background: transparent; box-shadow: none; }
.tp-nd .lbl { display: inline-flex; align-items: center; height: 30px; padding: 0 14px; border-radius: 15px; background: var(--fill-2); font-size: 13px; font-weight: 600; }
.tp-nd .al { position: absolute; left: 2px; top: -21px; display: flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500; color: var(--ink-2); white-space: nowrap; }
.tp-nd .al .nv-i { width: 12px; height: 12px; }
.tp-nd .al .ex { margin-left: 4px; height: 17px; padding: 0 6px; border-radius: 9px; background: var(--fill-2); font-size: 10.5px; color: var(--ink-3); display: inline-flex; align-items: center; }
.tp-nd .im { position: absolute; inset: 0; border-radius: 16px; overflow: hidden; background: var(--fill-1); }
.tp-nd .im img, .tp-nd .im video { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.tp-nd .txt { height: 100%; overflow: hidden; padding: 14px 16px; font-size: 12px; line-height: 1.65; color: var(--ink-2); white-space: pre-wrap; }
.tp-nd .draft { height: 100%; padding: 14px; display: flex; flex-direction: column; gap: 8px; color: var(--ink-3); }
.tp-nd .draft .nv-i { width: 16px; height: 16px; }
.tp-nd .draft p { margin: 0; flex: 1; overflow: hidden; font-size: 12px; line-height: 1.6; color: var(--ink-2); }
.tp-nd .draft span { align-self: flex-start; height: 20px; padding: 0 7px; border-radius: 10px; background: var(--fill-2); font-size: 11px; display: inline-flex; align-items: center; }
.tp-nd .drop { height: 100%; margin: 0; border-radius: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--ink-4); font-size: 11.5px; text-align: center; padding: 0 16px; }
.tp-nd .drop .nv-i { width: 20px; height: 20px; }
.tp-nd .tbl { height: 100%; padding: 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.tp-nd .tbl i { border-radius: 4px; background: var(--fill-1); }
.tp-nd .tbl i:nth-child(-n+3) { background: var(--fill-2); }
.tp-nd .pt { position: absolute; top: 50%; width: 18px; height: 18px; margin-top: -9px; border-radius: 50%; background: var(--solid); box-shadow: 0 0 0 1px var(--fill-3); display: flex; align-items: center; justify-content: center; color: var(--ink-3); opacity: 0; transition: opacity .14s; }
.tp-nd .pt .nv-i { width: 11px; height: 11px; }
.tp-nd .pt.l { left: -9px; } .tp-nd .pt.r { right: -9px; }
.tp-nd:hover .pt, .tp-nd.on .pt { opacity: 1; }
.tp-vbar { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 26px; border-radius: 13px; background: rgba(0,0,0,.42); backdrop-filter: blur(10px); display: flex; align-items: center; gap: 8px; padding: 0 10px; color: #fff; font-size: 10.5px; font-variant-numeric: tabular-nums; cursor: default; }
.tp-vbar button { border: 0; background: transparent; color: #fff; padding: 0; display: flex; cursor: pointer; }
.tp-vbar .nv-i { width: 13px; height: 13px; }
.tp-vbar .trk { flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,.3); position: relative; }
.tp-vbar .trk i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: #fff; }
.tp-tip { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 4; height: 30px; padding: 0 12px; border-radius: 15px; background: var(--glass-strong); backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); font-size: 11.5px; color: var(--ink-3); display: flex; align-items: center; white-space: nowrap; }
.tp-fade-leave-active { transition: opacity .4s; } .tp-fade-leave-to { opacity: 0; }
.tp-panel { position: absolute; z-index: 5; border-radius: 18px; background: var(--solid); box-shadow: var(--shadow-pop); padding: 12px 14px; cursor: default; }
.tp-panel .refs { display: flex; flex-wrap: wrap; gap: 6px; }
.tp-panel .ref { height: 24px; padding: 0 9px; border-radius: 12px; background: var(--fill-1); font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px; color: var(--ink-2); }
.tp-panel .ref .nv-i { width: 12px; height: 12px; }
.tp-panel .ref.muted { color: var(--ink-4); }
.tp-panel .prompt { margin: 10px 2px 12px; font-size: 13px; line-height: 1.6; color: var(--ink-2); max-height: 64px; overflow: auto; }
.tp-panel .bar { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.tp-panel .bar .sp { flex: 1; }
.tp-panel .mdl { display: flex; align-items: center; gap: 5px; font-weight: 600; }
.tp-panel .mdl .nv-i { width: 14px; height: 14px; }
.tp-panel .prm { color: var(--ink-3); }
.tp-panel .run { width: 30px; height: 30px; border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; opacity: .3; cursor: not-allowed; }
.tp-panel .run .nv-i { width: 15px; height: 15px; }
.tp-zoom { position: absolute; left: 15px; bottom: 15px; z-index: 5; height: 40px; padding: 0 8px; border-radius: 20px; background: var(--glass-strong); backdrop-filter: var(--material-thick); box-shadow: var(--shadow-float); display: flex; align-items: center; gap: 4px; }
.tp-zoom button { height: 32px; min-width: 32px; padding: 0 6px; border: 0; border-radius: 16px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; font: 400 12px/1 var(--font-sans); font-variant-numeric: tabular-nums; cursor: pointer; }
.tp-zoom button:hover { background: var(--fill-1); color: var(--ink); }
.tp-zoom .nv-i { width: 15px; height: 15px; }
.tp-zoom input { width: 96px; accent-color: var(--ink); }
@media (max-width: 720px) { .tp { width: calc(100vw - 16px); height: calc(100vh - 32px); border-radius: 16px; } .tp-h .ro { display: none; } .tp-zoom input { display: none; } }
</style>
