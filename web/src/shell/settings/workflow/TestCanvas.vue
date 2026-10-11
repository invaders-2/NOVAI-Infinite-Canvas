<script setup>
// 测试画布：可加 提示词 / 图片 / 视频 / 音频 节点，拖拽卡片头移动、拖空白平移、滚轮缩放；
// 连到 Comfy 节点（其他暴露字段在 Comfy 卡里调）→ 运行测试 → 输出节点显示结果
import { ref, computed, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import PreviewField from './PreviewField.vue';
import MediaView from './MediaView.vue';
import { t } from '../../../lib/store.js';
import { fieldKind, mediaFieldLabel, typeLabel, defaultMiniTestNodes } from './nodeInfo.js';
import { wf, runTest, addMiniNode, removeMiniNode, pickMiniImage } from './wfStore.js';

const W = { prompt: 210, image: 210, video: 210, audio: 210, comfy: 230, output: 180 };
const PORT_Y = 56;
const view = ref({ k: 1, x: 0, y: 0 });
const panning = ref(false);
const canvas = ref(null);
let drag = null;

const fields = computed(() => (wf.config && wf.config.fields) || []);
const count = kind => fields.value.filter(f => fieldKind(f) === kind).length;
const settingFields = computed(() => fields.value.filter(f => fieldKind(f) === 'setting'));
const prompts = computed(() => wf.miniTestNodes.filter(n => n.type === 'prompt'));
const media = computed(() => wf.miniTestNodes.filter(n => ['image', 'video', 'audio'].includes(n.type)));
const comfy = computed(() => wf.miniTestNodes.find(n => n.type === 'comfy') || defaultMiniTestNodes().find(n => n.type === 'comfy'));
const output = computed(() => wf.miniTestNodes.find(n => n.type === 'output') || defaultMiniTestNodes().find(n => n.type === 'output'));
const title = computed(() => (wf.config && wf.config.title) || wf.selectedName.replace('.json', ''));
const summary = computed(() => `${mediaFieldLabel('image', count('image'))} · ${mediaFieldLabel('video', count('video'))} · ${mediaFieldLabel('audio', count('audio'))} · ${count('prompt') ? t('comfy.acceptsPrompt', '接收提示词') : t('comfy.noPromptField', '无提示词字段')}`);
function mediaIndex(n) { return media.value.filter(m => m.type === n.type).indexOf(n) + 1; }
function mediaIcon(type) { return type === 'video' ? 'video' : type === 'audio' ? 'music' : 'image'; }

function wire(a, b) {
    if (!a || !b) return '';
    const x1 = a.x + (W[a.type] || 210), y1 = a.y + PORT_Y, x2 = b.x, y2 = b.y + PORT_Y;
    const c = Math.max(30, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
}
const wires = computed(() => [...prompts.value, ...media.value].map(n => ({ id: n.id, d: wire(n, comfy.value) })).concat([{ id: 'out', d: wire(comfy.value, output.value) }]));

function onWheel(e) {
    const old = view.value.k;
    const next = Math.max(0.45, Math.min(1.8, old * (e.deltaY > 0 ? 0.9 : 1.1)));
    const r = canvas.value.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    view.value = { k: next, x: mx - (mx - view.value.x) * (next / old), y: my - (my - view.value.y) * (next / old) };
}
function zoom(dir) {
    const el = canvas.value; const old = view.value.k;
    const next = Math.max(0.45, Math.min(1.8, old * (dir > 0 ? 1.1 : 0.9)));
    const mx = el.clientWidth / 2, my = el.clientHeight / 2;
    view.value = { k: next, x: mx - (mx - view.value.x) * (next / old), y: my - (my - view.value.y) * (next / old) };
}
function resetView() { view.value = { k: 1, x: 0, y: 0 }; }
function onDown(e) {
    if (e.button !== 0 || e.target.closest('textarea,input,select,button,[role=button],.mtb,.gctl,audio,video')) return;
    const card = e.target.closest('.mc');
    if (card) {
        if (!e.target.closest('.mhd')) return;
        const node = wf.miniTestNodes.find(n => n.id === card.dataset.node);
        if (!node) return;
        drag = { type: 'card', node, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    } else {
        drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: view.value.x, oy: view.value.y };
        panning.value = true;
    }
    e.preventDefault();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}
function onMove(e) {
    if (!drag) return;
    if (drag.type === 'pan') view.value = { ...view.value, x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy };
    else { drag.node.x = drag.ox + (e.clientX - drag.sx) / view.value.k; drag.node.y = drag.oy + (e.clientY - drag.sy) / view.value.k; }
}
function onUp() { drag = null; panning.value = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
onBeforeUnmount(onUp);
</script>

<template>
    <div ref="canvas" class="mcv" :class="{ panning }" @wheel.prevent="onWheel" @mousedown="onDown">
        <div class="mtb">
            <button type="button" @click="addMiniNode('prompt')"><NvIcon name="type" />{{ t('comfy.addPrompt', '提示词') }}</button>
            <button type="button" @click="addMiniNode('image')"><NvIcon name="image" />{{ t('comfy.addImage', '图片') }}</button>
            <button type="button" @click="addMiniNode('video')"><NvIcon name="video" />{{ typeLabel('video') }}</button>
            <button type="button" @click="addMiniNode('audio')"><NvIcon name="music" />{{ typeLabel('audio') }}</button>
        </div>
        <div class="world" :style="{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }">
            <svg class="wires" width="1" height="1"><path v-for="w in wires" :key="w.id" :d="w.d" /></svg>
            <TransitionGroup name="mc">
                <div v-for="(n, i) in prompts" :key="n.id" class="mc" :data-node="n.id" :style="{ left: n.x + 'px', top: n.y + 'px', width: W.prompt + 'px' }">
                    <span class="port o"></span>
                    <div class="mhd"><NvIcon name="type" /><span class="tt">{{ t('comfy.promptNode', '提示词') }} {{ i + 1 }}</span>
                        <button type="button" class="x" :title="t('common.delete', '删除')" :aria-label="t('common.delete', '删除')" @click="removeMiniNode(n.id)"><NvIcon name="x" /></button></div>
                    <div class="mbd"><textarea v-model="n.text" class="mta" :placeholder="t('comfy.promptPlaceholder', '输入提示词')"></textarea></div>
                </div>
                <div v-for="n in media" :key="n.id" class="mc" :data-node="n.id" :style="{ left: n.x + 'px', top: n.y + 'px', width: W[n.type] + 'px' }">
                    <span class="port o"></span>
                    <div class="mhd"><NvIcon :name="mediaIcon(n.type)" /><span class="tt">{{ typeLabel(n.type) }} {{ mediaIndex(n) }}</span>
                        <button type="button" class="x" :title="t('common.delete', '删除')" :aria-label="t('common.delete', '删除')" @click="removeMiniNode(n.id)"><NvIcon name="x" /></button></div>
                    <div class="mbd"><MediaView :kind="n.type" :url="n.url" :name="n.name || n.value" compact class="fill" @pick="pickMiniImage(n.id)" /></div>
                </div>
            </TransitionGroup>
            <div class="mc comfy" :data-node="comfy.id" :style="{ left: comfy.x + 'px', top: comfy.y + 'px', width: W.comfy + 'px' }">
                <span class="port i"></span><span class="port o"></span>
                <div class="mhd"><NvIcon name="workflow" /><span class="tt">{{ title }} · {{ t('canvas.comfyCustom', '自定义') }}</span></div>
                <div class="mbd">
                    <span class="cap">{{ t('comfy.inputs', 'Inputs') }}</span>
                    <div class="sum">{{ summary }}</div>
                    <div v-if="!settingFields.length" class="sum c">{{ t('comfy.otherParamsHere', '其他暴露字段会在这里调整') }}</div>
                    <PreviewField v-for="f in settingFields" :key="f.id" :field="f" compact />
                    <button type="button" class="run" :disabled="wf.running" @click="runTest"><span v-if="wf.running" class="spin s12"></span><NvIcon v-else name="play" />{{ wf.running ? t('comfy.runningTest', '运行中...') : t('comfy.runTest', '运行测试') }}</button>
                </div>
            </div>
            <div class="mc" :data-node="output.id" :style="{ left: output.x + 'px', top: output.y + 'px', width: W.output + 'px' }">
                <span class="port i"></span>
                <div class="mhd"><NvIcon name="target" /><span class="tt">{{ t('comfy.output', '输出') }}</span></div>
                <div class="mbd">
                    <template v-if="wf.runResult">
                        <button type="button" class="res" title="点击放大预览" @click="wf.lightbox = wf.runResult"><img :src="wf.runResult" alt="运行结果" /></button>
                        <span class="ok"><NvIcon name="check" />{{ t('comfy.runSuccess', '运行成功') }}</span>
                    </template>
                    <div v-else class="sum c">{{ t('comfy.resultHere', '运行后显示结果') }}</div>
                </div>
            </div>
        </div>
        <div class="gctl" @mousedown.stop @wheel.stop>
            <button type="button" title="缩小" aria-label="缩小" @click="zoom(-1)"><NvIcon name="minus" /></button>
            <span>{{ Math.round(view.k * 100) }}%</span>
            <button type="button" title="放大" aria-label="放大" @click="zoom(1)"><NvIcon name="plus" /></button>
            <button type="button" title="重置视图" aria-label="重置视图" @click="resetView"><NvIcon name="fit" /></button>
        </div>
    </div>
</template>

<style scoped>
.mcv { position: relative; height: 600px; border-radius: 14px; background-color: var(--canvas); background-image: radial-gradient(var(--canvas-grid) 1px, transparent 1.1px); background-size: 18px 18px; overflow: hidden; cursor: grab; user-select: none; }
.mcv.panning { cursor: grabbing; }
.mtb { position: absolute; left: 12px; top: 12px; z-index: 5; display: flex; gap: 2px; padding: 3px; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-float); cursor: default; }
.mtb button { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--ink-2); font: 400 12px/1 var(--font-sans); cursor: pointer; }
.mtb button:hover { background: var(--fill-1); color: var(--ink); }
.mtb .nv-i { width: 13px; height: 13px; }
.world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.wires { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.wires path { fill: none; stroke: var(--ink-3); stroke-width: 1.3; }
.mc { position: absolute; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-float); user-select: text; }
.port { position: absolute; top: 51.5px; width: 9px; height: 9px; border-radius: 50%; background: var(--solid); box-shadow: 0 0 0 1.5px var(--ink-3); }
.port.o { right: -4.5px; }
.port.i { left: -4.5px; }
.mhd { display: flex; align-items: center; gap: 6px; padding: 9px 10px 6px; font: 500 11.5px/14px var(--font-sans); cursor: move; user-select: none; }
.mhd .nv-i { width: 13px; height: 13px; color: var(--ink-3); flex: none; }
.mhd .tt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mhd .x { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px; background: transparent; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-4); cursor: pointer; }
.mhd .x:hover { background: var(--fill-1); color: var(--ink); }
.mhd .x .nv-i { width: 11px; height: 11px; }
.mbd { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.mta { width: 100%; min-height: 64px; padding: 9px 11px; border: 0; outline: 0; border-radius: 9px; background: var(--fill-1); color: var(--ink); font: 400 12px/18px var(--font-sans); resize: vertical; }
.mta:focus { background: var(--fill-2); }
.fill { background: var(--fill-1); }
.cap { font: 400 10.5px/14px var(--font-mono); letter-spacing: .05em; color: var(--ink-3); text-transform: uppercase; }
.sum { padding: 8px 10px; border-radius: 9px; background: var(--fill-1); font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.sum.c { text-align: center; padding: 14px 10px; }
.run { height: 32px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; gap: 6px; font: 500 12px/1 var(--font-sans); cursor: pointer; }
.run:disabled { opacity: .7; cursor: default; }
.run .nv-i { width: 12px; height: 12px; }
.s12 { width: 12px; height: 12px; }
.res { padding: 0; border: 0; border-radius: 9px; overflow: hidden; background: var(--fill-1); cursor: zoom-in; }
.res img { display: block; width: 100%; max-height: 180px; object-fit: contain; }
.ok { display: flex; align-items: center; gap: 5px; font: 400 11px/14px var(--font-sans); color: var(--ink-2); }
.ok .nv-i { width: 12px; height: 12px; }
.gctl { position: absolute; right: 12px; bottom: 12px; z-index: 5; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 99px; background: var(--glass-strong); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--shadow-rim), var(--shadow-float); cursor: default; }
.gctl button { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 99px; background: transparent; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); cursor: pointer; }
.gctl button:hover { background: var(--fill-2); color: var(--ink); }
.gctl .nv-i { width: 14px; height: 14px; }
.gctl span { min-width: 40px; text-align: center; font: 400 11px/1 var(--font-mono); color: var(--ink-2); }
.mc-enter-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.mc-leave-active { transition: opacity 140ms var(--ease-out); }
.mc-enter-from { opacity: 0; transform: translateY(-4px); }
.mc-leave-to { opacity: 0; }
</style>
