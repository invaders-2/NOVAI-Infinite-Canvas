<script setup>
// 大图预览（在线生图 / Z-Image 共用，替换旧 image-preview.js 的 getLightbox + 页面里的 #lightbox）：
//   滚轮缩放 / 拖动平移 / 双击复位、分辨率标签、下载、提示词卡片 + 复用、点空白或 Esc 关闭；
//   新增：上一张 / 下一张按钮（← →）和缩放按钮条（− 百分比 + 复位，键盘 + − 0）。
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { usePanZoom } from './usePanZoom.js';

const props = defineProps({
    modelValue: { type: Number, default: -1 },        // 当前条目下标，-1 = 关闭
    entries: { type: Array, default: () => [] },       // [{ url, prompt, size }]
    promptLabel: { type: String, default: 'Prompt' },
    reuseLabel: { type: String, default: '复用' },
    reuseHint: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'reuse', 'download']);

const frame = ref(null);
const res = ref('...');
const pz = usePanZoom(frame);
const open = computed(() => props.modelValue >= 0 && props.modelValue < props.entries.length);
const entry = computed(() => (open.value ? props.entries[props.modelValue] : null));
const total = computed(() => props.entries.length);

function close() { emit('update:modelValue', -1); }
function go(step) {
    if (!open.value || total.value < 2) return;
    emit('update:modelValue', (props.modelValue + step + total.value) % total.value);
}
function onLoad(e) {
    const img = e.target;
    res.value = img.naturalWidth && img.naturalHeight ? img.naturalWidth + ' x ' + img.naturalHeight : ((entry.value && entry.value.size) || '--');
}
function onKey(e) {
    if (!open.value) return;
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === 'ArrowLeft') go(-1);
    else if (k === 'ArrowRight') go(1);
    else if (k === '+' || k === '=') pz.zoomBy(1.25);
    else if (k === '-' || k === '_') pz.zoomBy(0.8);
    else if (k === '0') pz.reset();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
}
watch(() => entry.value && entry.value.url, () => { pz.reset(); res.value = '...'; });
watch(open, v => {
    if (v) window.addEventListener('keydown', onKey, true);
    else { window.removeEventListener('keydown', onKey, true); pz.reset(); }
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="olb">
            <div v-if="open" class="olb" role="dialog" aria-modal="true" aria-label="大图预览" @click.self="close">
                <div class="olb-body" @click.self="close">
                    <div ref="frame" class="olb-frame" :class="{ panning: pz.panning.value, zoomed: pz.zoom.value > 1.001 }"
                        @wheel="pz.onWheel" @mousedown="pz.onDown" @dblclick="pz.onDblClick">
                        <img :key="entry.url" :src="entry.url" class="olb-img" alt="preview" draggable="false" :style="pz.style.value" @load="onLoad" />
                        <span class="olb-tag" data-no-pan>{{ res }}</span>
                        <template v-if="total > 1">
                            <button type="button" class="olb-nav l" title="上一张（←）" aria-label="上一张" @click.stop="go(-1)"><NvIcon name="arrowl" /></button>
                            <button type="button" class="olb-nav r" title="下一张（→）" aria-label="下一张" @click.stop="go(1)"><NvIcon name="arrowr" /></button>
                        </template>
                        <div class="olb-bar zoom" data-no-pan>
                            <button type="button" class="b" title="缩小（−）" aria-label="缩小" :disabled="pz.zoom.value <= pz.minZoom + 0.001" @click.stop="pz.zoomBy(0.8)"><NvIcon name="minus" /></button>
                            <button type="button" class="pct" title="复位（0）" @click.stop="pz.reset()">{{ pz.percent.value }}</button>
                            <button type="button" class="b" title="放大（+）" aria-label="放大" :disabled="pz.zoom.value >= pz.maxZoom - 0.001" @click.stop="pz.zoomBy(1.25)"><NvIcon name="plus" /></button>
                            <span v-if="total > 1" class="cnt">{{ modelValue + 1 }} / {{ total }}</span>
                        </div>
                        <div class="olb-bar dl" data-no-pan>
                            <button type="button" class="b" title="下载" aria-label="下载" @click.stop="emit('download', entry)"><NvIcon name="download" /></button>
                        </div>
                    </div>
                    <aside class="olb-card">
                        <span class="cap">{{ promptLabel }}</span>
                        <p>{{ entry.prompt || '—' }}</p>
                        <div class="row">
                            <button type="button" class="nv-btn primary sm" @click="emit('reuse', entry)"><NvIcon name="copy" />{{ reuseLabel }}</button>
                            <span v-if="reuseHint" class="hint">{{ reuseHint }}</span>
                        </div>
                    </aside>
                </div>
                <button type="button" class="olb-x" title="关闭（Esc）" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
            </div>
        </Transition>
    </Teleport>
</template>

<style>
/* 大图预览本身是图片遮罩：深色底在两种主题下一致（与效果图 CcOnlineLightbox 相同），按钮白字 */
.olb { position: fixed; inset: 0; z-index: 2400; display: flex; align-items: center; justify-content: center; padding: 48px 72px; background: rgba(10,10,10,.82); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
.olb-body { display: flex; align-items: flex-start; gap: 40px; width: 100%; max-width: 1280px; max-height: 100%; }
.olb-frame { position: relative; flex: 1; min-width: 0; height: min(820px, calc(100vh - 96px)); border-radius: 14px; overflow: hidden; background: rgba(255,255,255,.04); box-shadow: 0 40px 100px -30px rgba(0,0,0,.6); cursor: default; user-select: none; touch-action: none; }
.olb-frame.zoomed { cursor: grab; }
.olb-frame.panning { cursor: grabbing; }
.olb-img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; transition: transform .12s ease-out; -webkit-user-drag: none; }
.olb-frame.panning .olb-img { transition: none; }
.olb-tag { position: absolute; left: 14px; bottom: 14px; z-index: 3; height: 22px; padding: 0 8px; border-radius: 6px; background: rgba(10,10,10,.55); color: #fff; font: 400 10.5px/22px var(--font-mono); letter-spacing: .04em; }
.olb-nav { position: absolute; top: 50%; z-index: 3; width: 40px; height: 40px; margin-top: -20px; border: 0; border-radius: 99px; background: rgba(20,20,20,.5); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: .75; transition: opacity var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out); }
.olb-nav:hover { opacity: 1; background: rgba(20,20,20,.72); }
.olb-nav.l { left: 14px; } .olb-nav.r { right: 14px; }
.olb-nav .nv-i { width: 18px; height: 18px; }
.olb-bar { position: absolute; bottom: 12px; z-index: 3; display: inline-flex; align-items: center; gap: 2px; height: 38px; padding: 3px; border-radius: 99px; background: rgba(20,20,20,.62); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); color: #fff; }
.olb-bar.zoom { left: 50%; transform: translateX(-50%); }
.olb-bar.dl { right: 12px; }
.olb-bar .b { width: 32px; height: 32px; border: 0; border-radius: 99px; background: transparent; color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.olb-bar .b:hover:not(:disabled) { background: rgba(255,255,255,.14); }
.olb-bar .b:disabled { opacity: .35; cursor: default; }
.olb-bar .b .nv-i { width: 15px; height: 15px; }
.olb-bar .pct { min-width: 52px; height: 32px; border: 0; border-radius: 99px; background: transparent; color: #fff; font: 400 11px/1 var(--font-mono); cursor: pointer; }
.olb-bar .pct:hover { background: rgba(255,255,255,.14); }
.olb-bar .cnt { padding: 0 10px 0 6px; font: 400 11px/1 var(--font-mono); color: rgba(255,255,255,.7); }
.olb-card { width: 360px; flex: none; padding: 16px; border-radius: 16px; background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-rim), var(--shadow-pop); display: flex; flex-direction: column; gap: 12px; }
.olb-card .cap { font: 400 10.5px/14px var(--font-mono); letter-spacing: .05em; text-transform: uppercase; color: var(--ink-3); }
.olb-card p { margin: 0; max-height: 40vh; overflow-y: auto; font: 400 12.5px/20px var(--font-sans); color: var(--ink); white-space: pre-wrap; word-break: break-word; user-select: text; }
.olb-card .row { display: flex; align-items: center; gap: 8px; }
.olb-card .hint { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.olb-x { position: absolute; top: 24px; right: 24px; width: 38px; height: 38px; border: 0; border-radius: 99px; background: rgba(20,20,20,.62); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.olb-x:hover { background: rgba(255,255,255,.18); }
.olb-x .nv-i { width: 15px; height: 15px; }
.olb-enter-active { transition: opacity 240ms var(--ease-out); }
.olb-enter-active .olb-body { transition: transform 320ms var(--ease-sheet); }
.olb-leave-active { transition: opacity 160ms var(--ease-out); }
.olb-enter-from, .olb-leave-to { opacity: 0; }
.olb-enter-from .olb-body { transform: scale(.98) translateY(10px); }
@media (max-width: 900px) {
    .olb { padding: 64px 16px 16px; align-items: flex-start; overflow-y: auto; }
    .olb-body { flex-direction: column; }
    .olb-frame { width: 100%; flex: none; height: 60vh; }
    .olb-card { width: 100%; }
}
</style>
