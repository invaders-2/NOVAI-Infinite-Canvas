<script setup>
// 大图预览（旧 showDetailPreview + image-preview.js 的缩放平移）：滚轮以指针为锚点缩放（25%–800%），
// 放大后拖动平移，双击复位；底部 HUD 有缩小 / 放大 / 1:1 按钮；视频用原生控件自动播放；点遮罩或 Esc 关闭
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { S } from '../lib/state.js';

const scale = ref(1), x = ref(0), y = ref(0), dragging = ref(false);
const stage = ref(null);
let pan = null;
const p = computed(() => S.preview);
const pct = computed(() => Math.round(scale.value * 100) + '%');
const imgStyle = computed(() => ({ transform: `translate(${x.value}px, ${y.value}px) scale(${scale.value})` }));
watch(p, () => reset());

function reset() { scale.value = 1; x.value = 0; y.value = 0; pan = null; dragging.value = false; }
function close() { S.preview = null; reset(); }
function zoomTo(next, ax = 0, ay = 0) {
    next = Math.max(0.25, Math.min(8, next));
    const ratio = next / scale.value;
    if (next <= 1.01) { x.value = 0; y.value = 0; } else { x.value = ax - ratio * (ax - x.value); y.value = ay - ratio * (ay - y.value); }
    scale.value = next;
}
function anchor(e) {
    const r = stage.value.getBoundingClientRect();
    return [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
}
function wheel(e) {
    if (!p.value || p.value.kind !== 'image') return;
    e.preventDefault();
    const [ax, ay] = anchor(e);
    zoomTo(scale.value * (e.deltaY < 0 ? 1.15 : 0.87), ax, ay);
}
function down(e) {
    if (scale.value <= 1.01 || e.button !== 0) return;
    e.preventDefault();
    pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x.value, oy: y.value };
    e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    dragging.value = true;
}
function move(e) { if (!pan || e.pointerId !== pan.id) return; x.value = pan.ox + e.clientX - pan.sx; y.value = pan.oy + e.clientY - pan.sy; }
function up(e) { if (!pan || e.pointerId !== pan.id) return; pan = null; dragging.value = false; }
function onKey(e) {
    if (!p.value) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (p.value.kind === 'image' && (e.key === '+' || e.key === '=')) zoomTo(scale.value * 1.25);
    else if (p.value.kind === 'image' && e.key === '-') zoomTo(scale.value / 1.25);
    else if (p.value.kind === 'image' && e.key === '0') reset();
}
onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="am-lb">
            <div v-if="p" class="am-lb" role="dialog" aria-modal="true" :aria-label="p.kind === 'video' ? '视频预览' : '图片预览'" @click.self="close">
                <button type="button" class="cl" title="关闭（Esc）" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
                <div ref="stage" class="stage" :class="{ zoomed: scale > 1.01, dragging }" @click.self="close" @wheel="wheel">
                    <video v-if="p.kind === 'video'" class="media" :src="p.url" controls autoplay playsinline preload="metadata"></video>
                    <img v-else class="media img" :src="p.url" :alt="p.name" draggable="false" :style="imgStyle"
                         @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @dblclick="reset">
                </div>
                <div v-if="p.kind === 'image'" class="hud">
                    <button type="button" title="缩小" aria-label="缩小" @click="zoomTo(scale / 1.25)"><NvIcon name="minus" /></button>
                    <span class="pc">{{ pct }}</span>
                    <button type="button" title="放大" aria-label="放大" @click="zoomTo(scale * 1.25)"><NvIcon name="plus" /></button>
                    <button type="button" title="适应窗口" aria-label="适应窗口" @click="reset"><NvIcon name="fit" /></button>
                    <i class="s"></i><span>滚轮缩放</span><i class="s"></i><span>放大后拖动平移</span><i class="s"></i><span>点遮罩 / Esc 关闭</span>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
/* 预览遮罩固定为暗底（看图专用，深浅色一致），上面的控件用白字 */
.am-lb { position: fixed; inset: 0; z-index: 2350; background: rgba(10,10,10,.82); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); display: flex; align-items: center; justify-content: center; }
.stage { position: absolute; inset: 64px 48px 84px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.media { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 40px 100px -30px rgba(0,0,0,.8); user-select: none; }
.img { transition: transform .12s ease-out; cursor: zoom-in; touch-action: none; }
.zoomed .img { cursor: grab; }
.dragging .img { cursor: grabbing; transition: none; }
.cl { position: absolute; right: 24px; top: 20px; z-index: 2; width: 36px; height: 36px; border: 0; border-radius: 99px; background: rgba(255,255,255,.12); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-fast); }
.cl:hover { background: rgba(255,255,255,.22); }
.cl .nv-i { width: 16px; height: 16px; }
.hud { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2; display: inline-flex; align-items: center; gap: 10px; height: 36px; padding: 0 12px 0 6px; border-radius: 99px; background: rgba(20,20,20,.72); color: rgba(255,255,255,.86); font: 400 11.5px/1 var(--font-sans); white-space: nowrap; }
.hud button { width: 26px; height: 26px; border: 0; border-radius: 99px; background: transparent; color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.hud button:hover { background: rgba(255,255,255,.14); }
.hud button .nv-i { width: 14px; height: 14px; }
.hud .pc { min-width: 40px; text-align: center; font: 400 11px/1 var(--font-mono); color: #fff; }
.hud .s { width: 3px; height: 3px; border-radius: 50%; background: rgba(255,255,255,.35); }
.am-lb-enter-active, .am-lb-leave-active { transition: opacity 200ms var(--ease-out); }
.am-lb-enter-active .media { transition: transform 320ms var(--ease-sheet), opacity 200ms; }
.am-lb-enter-from, .am-lb-leave-to { opacity: 0; }
.am-lb-enter-from .media { transform: scale(.98) translateY(10px); }
@media (max-width: 760px) { .hud span:not(.pc), .hud .s { display: none; } }
</style>
