<script>
// tooltip id 由模块级计数器生成，不依赖 Vue 版本 / SFC 编译细节
let tipSeq = 0;
</script>

<script setup>
// 模型强度滑块（HextaUI Prompt Input Effort 版式，首页 Vue 构建）：
// 标题行「模型强度 + 当前档位 + 说明」→「更快 / 更强」→ 28px 胶囊轨道（动态流体渐变 + 档位圆点 + 38×24 白色胶囊拇指）
// → 推荐小字 →（有显式档位时）「恢复默认」。档位来自 /api/config 的 provider.model_caps[模型].think，
// 空串 = 默认（滑块停在推荐档，标题显示「默认」），和画布助手共用 localStorage canvas-next:agent:think。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createEffortFill, effortFallback } from '../lib/effortFill.js';

const LEVEL_LABEL = { low: '低', mid: '中', high: '高', xhigh: '极高', max: 'Max' };
const THUMB = 38;
const PAD = THUMB / 2;

const props = defineProps({
    levels: { type: Array, default: () => [] },
    value: { type: String, default: '' },
    recommended: { type: String, default: 'mid' },
    label: { type: String, default: '模型强度' },
    hint: { type: String, default: '越高越慢，推理越深' },
});
const emit = defineEmits(['update:value']);

const trackEl = ref(null);
const fillHost = ref(null);
const dragging = ref(false);
const dragShare = ref(null);
const failed = ref(false);
const tipOpen = ref(false);
const tipId = 'eff-tip-' + (++tipSeq);
let handle = null;
let canvasEl = null;

const levels = computed(() => (Array.isArray(props.levels) ? props.levels.filter(Boolean) : []));
const visible = computed(() => levels.value.length > 1);
const last = computed(() => Math.max(0, levels.value.length - 1));
const explicit = computed(() => Boolean(props.value) && levels.value.includes(props.value));
const recommendedIndex = computed(() => {
    if (levels.value.length < 2) return -1;
    const hit = props.recommended ? levels.value.indexOf(props.recommended) : -1;
    return hit >= 0 ? hit : 1;
});
const index = computed(() => (explicit.value ? levels.value.indexOf(props.value) : Math.max(0, recommendedIndex.value)));
const progress = computed(() => (last.value > 0 ? index.value / last.value : 0));
const share = computed(() => (dragShare.value === null ? progress.value : dragShare.value));
const recShare = computed(() => (recommendedIndex.value >= 0 && last.value > 0 ? recommendedIndex.value / last.value : 0));
const labelOf = (level) => LEVEL_LABEL[level] || level;
const title = computed(() => (explicit.value ? labelOf(props.value) : '默认'));
// 两端各留 2px：行程 = W - (38 + 2×2) = W - 42；拇指 left = 2 + share·(W-42)，
// 圆心 = 2 + 19 + share·(W-42) = 21 + share·(W-42)，与档位圆点中心 / 推荐小字同一条线。
// 填充 = 42 + share·(W-42)：右缘总在拇指右缘 + 2px（拇指四周各露 2px 渐变），Max 时 = W 填满轨道。
const vars = computed(() => ({
    '--eff-thumb': 'calc((100% - 42px) * ' + share.value + ' + 2px)',
    '--eff-fill': 'calc((100% - 42px) * ' + share.value + ' + 42px)',
    '--eff-rec': 'calc((100% - 42px) * ' + recShare.value + ' + 21px)',
}));

function trySetup() {
    if (!visible.value || handle || !fillHost.value) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'eff-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    fillHost.value.appendChild(canvas);
    canvasEl = canvas;
    handle = createEffortFill(canvas, progress.value, {
        onLost: () => {
            handle = null;
            teardown();
            failed.value = true;
        },
    });
    if (!handle) {
        canvas.remove();
        canvasEl = null;
        failed.value = true;
    }
}
function teardown() {
    if (handle) {
        handle.destroy();
        handle = null;
    }
    if (canvasEl) {
        canvasEl.remove();
        canvasEl = null;
    }
}
onMounted(() => { nextTick(() => { failed.value = false; trySetup(); }); });
watch(visible, () => {
    nextTick(() => {
        teardown();
        failed.value = false;
        trySetup();
    });
});
watch(progress, (value) => { if (handle) handle.setLevel(value); });
onBeforeUnmount(teardown);

const commit = (next) => {
    const clamped = Math.min(last.value, Math.max(0, next));
    if (explicit.value && clamped === index.value) return;
    emit('update:value', levels.value[clamped]);
};
const shareAt = (clientX) => {
    const track = trackEl.value;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left - PAD) / Math.max(1, rect.width - THUMB)));
};
const follow = (clientX) => {
    const next = shareAt(clientX);
    dragShare.value = next;
    commit(Math.round(next * last.value));
};
function onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.value = true;
    follow(event.clientX);
}
function onPointerMove(event) {
    if (!dragging.value) return;
    follow(event.clientX);
}
function endDrag() {
    dragging.value = false;
    dragShare.value = null;
}
function onKeyDown(event) {
    let next = index.value;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = index.value + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = index.value - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last.value;
    else return;
    event.preventDefault();
    commit(next);
}
function reset() { emit('update:value', ''); }
</script>

<template>
    <div v-if="visible" class="eff-slider" data-effort-slider :data-think-level="value || 'default'" :style="vars">
        <div class="eff-head">
            <span class="eff-label">{{ label }}</span>
            <span class="eff-value" :class="{ 'is-on': explicit }">{{ title }}</span>
            <span class="eff-info-wrap" @mouseenter="tipOpen = true" @mouseleave="tipOpen = false">
                <button type="button" class="eff-info" :aria-describedby="tipId" :aria-label="'说明：' + hint"
                        @focus="tipOpen = true" @blur="tipOpen = false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                        <path d="M12 17h.01" />
                    </svg>
                </button>
                <span :id="tipId" role="tooltip" class="eff-tip" :data-show="tipOpen ? '' : undefined">{{ hint }}</span>
            </span>
        </div>
        <div class="eff-caption" aria-hidden="true"><span>更快</span><span>更强</span></div>
        <div ref="trackEl" class="eff-track" role="slider" tabindex="0" :aria-label="label"
             :aria-valuemin="0" :aria-valuemax="last" :aria-valuenow="index" :aria-valuetext="labelOf(levels[index])"
             :data-dragging="dragging ? '' : undefined"
             @pointerdown="onPointerDown" @pointermove="onPointerMove"
             @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag"
             @keydown="onKeyDown">
            <span class="eff-fill-wrap">
                <span ref="fillHost" class="eff-fill" aria-hidden="true" :data-webgl="failed ? '0' : '1'">
                    <span v-if="failed" class="eff-fill-grad" :style="{ background: effortFallback(progress) }"></span>
                </span>
            </span>
            <span class="eff-dots" aria-hidden="true">
                <span v-for="(item, position) in levels" :key="item" class="eff-dot" :data-think="item"
                      :data-on="position <= index ? '' : undefined"></span>
            </span>
            <span class="eff-thumb" aria-hidden="true"></span>
        </div>
        <div v-if="recommendedIndex >= 0" class="eff-rec" aria-hidden="true"><span>推荐</span></div>
        <div v-if="explicit" class="eff-restore"><button type="button" @click="reset">恢复默认</button></div>
    </div>
</template>

<style>
/* 零 border / 零发丝线 / 零 inset 描边：层级靠 28px 胶囊软底轨道、流体渐变、柔和投影与间距。 */
.eff-slider {
    --eff-spring: cubic-bezier(.34, 1.42, .62, 1);
    --eff-drop: rgba(15, 23, 42, .14);
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
    padding: 0 6px;
    box-sizing: border-box;
    user-select: none;
    -webkit-user-select: none;
}
.eff-head { display: flex; align-items: center; gap: 6px; min-height: 18px; }
.eff-label { font: 400 11px/1.2 var(--font-sans); color: var(--ink-3); }
.eff-value { font: 400 13px/1.2 var(--font-sans); color: var(--ink-2); transition: color var(--duration-fast) var(--ease-out); }
.eff-value.is-on { color: var(--ink); font-weight: 500; }
/* 「?」外层：承接右对齐，tooltip 以它为定位基准 */
.eff-info-wrap { position: relative; display: inline-flex; flex: none; margin-left: auto; }
.eff-info {
    flex: none;
    width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px;
    display: grid; place-items: center;
    background: transparent; color: var(--ink-3); cursor: help;
    transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.eff-info:hover { background: var(--fill-2); color: var(--ink-2); }
.eff-info svg { width: 14px; height: 14px; }
/* 说明：hover / focus 出的项目内 tooltip（原生 title 已移除），定位在图标右上方；
   底色走 .hp-model-wrap 的 --hp-pop（暗色自动 #1e1e20），零 border / 零 inset。 */
.eff-tip {
    position: absolute;
    right: -2px;
    bottom: calc(100% + 8px);
    z-index: 6;
    width: max-content;
    max-width: 220px;
    padding: 7px 9px;
    border: 0;
    border-radius: 9px;
    background: var(--hp-pop, #fff);
    color: var(--ink);
    font-size: 11.5px;
    line-height: 1.5;
    font-weight: 400;
    text-align: left;
    white-space: normal;
    box-shadow: var(--shadow-pop, 0 8px 24px rgba(0, 0, 0, .18));
    opacity: 0;
    visibility: hidden;
    transform: translateY(2px);
    pointer-events: none;
    transition: opacity .12s var(--ease-out), transform .12s var(--ease-out), visibility .12s var(--ease-out);
}
.eff-tip[data-show] { opacity: 1; visibility: visible; transform: translateY(0); }
.eff-caption { display: flex; justify-content: space-between; font: 400 11px/1.2 var(--font-sans); color: var(--ink-3); }

.eff-track {
    position: relative;
    height: 28px;
    border-radius: 999px;
    border: 0;
    background: var(--fill-2);
    touch-action: none;
    cursor: grab;
    outline: none;
}
.eff-track[data-dragging] { cursor: grabbing; }
.eff-track:focus-visible { outline: 2px solid var(--ink-3); outline-offset: 2px; }

.eff-fill-wrap {
    position: absolute; top: 0; bottom: 0; left: 0;
    width: min(var(--eff-fill), 100%);
    border-radius: 999px;
    overflow: hidden;
    pointer-events: none;
    transition: width .5s var(--eff-spring);
}
.eff-track[data-dragging] .eff-fill-wrap { transition: none; }
.eff-fill { position: absolute; inset: 0; display: block; }
.eff-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
.eff-fill-grad { position: absolute; inset: 0; display: block; }

/* 点中心 = 21 + i·(W-42)/(n-1)：4px 点中心比外框左缘多 2px，圆点层左右各放宽 2px，
   padding 21px 让内容盒回到 19px（首点中心 21 / 末点中心 W-21），不再用负外边距。 */
.eff-dots {
    position: absolute; inset: 0 -2px;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 21px;
    pointer-events: none;
}
.eff-dot {
    width: 4px; height: 4px; flex: none; border-radius: 50%;
    background: var(--fill-3);
    transition: background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--eff-spring);
}
.eff-dot[data-on] { background: #fff; }

/* 拇指：38×24 白色胶囊（上下各留 2px）/ 只有轻投影（不画 border / ring / inset / 外层雾圈）；
   min() 把最大档收敛到右缘留 2px（left = W-40、右缘 = W-2），不贴边也不出轨。 */
.eff-thumb {
    position: absolute; top: 2px;
    left: min(var(--eff-thumb), calc(100% - 40px));
    width: 38px; height: 24px;
    border-radius: 999px; border: 0;
    background: #fff;
    box-shadow: 0 2px 6px var(--eff-drop);
    pointer-events: none;
    transition: left .5s var(--eff-spring), box-shadow var(--duration-fast) var(--ease-out);
}
.eff-track[data-dragging] .eff-thumb { transition: none; box-shadow: 0 3px 10px var(--eff-drop); }
.eff-track:hover:not([data-dragging]) .eff-thumb { box-shadow: 0 2px 8px var(--eff-drop); }
/* 暗色主题：白拇指 + 更深的投影，保证在深底上看得见（无 ring / 无蓝边） */
html.theme-dark .eff-slider, [data-theme=dark] .eff-slider {
    --eff-drop: rgba(0, 0, 0, .42);
}
html.theme-dark .eff-thumb { background: rgba(245, 245, 247, .96); }

.eff-rec { position: relative; height: 14px; font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.eff-rec span { position: absolute; left: var(--eff-rec); transform: translateX(-50%); white-space: nowrap; }

.eff-restore { display: flex; justify-content: flex-end; margin-top: -1px; }
.eff-restore button {
    border: 0; background: transparent; padding: 0;
    color: var(--ink-3); font: 400 11px/1.4 var(--font-sans); cursor: pointer;
    transition: color var(--duration-fast) var(--ease-out);
}
.eff-restore button:hover { color: var(--ink-2); }

@media (prefers-reduced-motion: reduce) {
    .eff-fill-wrap,
    .eff-thumb,
    .eff-dot,
    .eff-value,
    .eff-tip { transition: none; }
}
</style>
