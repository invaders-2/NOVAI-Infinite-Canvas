<script setup>
// 社区点赞胶囊：点赞时心形压扁回弹、描边空心变实心、数字滚一位（用户要求去掉喷发粒子，只留这三样）。
// 动画只由 liked 驱动（服务端覆盖 / 失败回滚时状态也对得上），减少动效偏好下只切颜色和数字。
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
    liked: { type: Boolean, default: false },
    count: { type: Number, default: 0 },
    disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['toggle']);

// 与 web/src/lib/icons.js 的 lucide heart 同一条 path；这里要单独控制填充色，所以不走 NvIcon
const HEART_PATH = 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z';

const squashing = ref(false);
let squashTimer = 0;

const fmt = value => String(Math.max(0, Math.round(Number(value) || 0)));
// 两行数字：第一行未点赞值、第二行点赞值；点赞上滚一行，取消滚回第一行
const topNum = computed(() => fmt(props.liked ? Math.max(0, props.count - 1) : props.count));
const bottomNum = computed(() => fmt(props.liked ? props.count : props.count + 1));
const digits = computed(() => Math.max(topNum.value.length, bottomNum.value.length));
const numStyle = computed(() => ({ width: digits.value + 'ch' }));

function prefersReducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
watch(() => props.liked, (next, prev) => {
    clearTimeout(squashTimer);
    // 只在「未点赞 → 点赞」时压一下；取消和初始挂载都不动
    if (next && !prev && !prefersReducedMotion()) {
        squashing.value = true;
        squashTimer = setTimeout(() => { squashing.value = false; }, 400);
    } else {
        squashing.value = false;
    }
});
onBeforeUnmount(() => clearTimeout(squashTimer));

function onClick() {
    if (props.disabled) return;
    emit('toggle');
}
</script>

<template>
    <button
        type="button"
        class="lb"
        :class="{ on: liked, squash: squashing }"
        :aria-pressed="liked"
        :aria-label="liked ? '取消点赞' : '点赞'"
        :title="liked ? '取消点赞' : '点赞'"
        :disabled="disabled"
        @click="onClick"
    >
        <span class="lb-heart">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="HEART_PATH" /></svg>
        </span>
        <span class="lb-num" aria-hidden="true" :style="numStyle">
            <span class="lb-track" :style="{ transform: liked ? 'translateY(-100%)' : 'translateY(0)' }">
                <span>{{ topNum }}</span><span>{{ bottomNum }}</span>
            </span>
        </span>
    </button>
</template>

<style scoped>
.lb {
    --lb-heart: #ff4d6d;
    --lb-spring: cubic-bezier(.34, 1.56, .64, 1);
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 12px 0 11px;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--fill-1);
    color: var(--ink-2);
    font: 500 12.5px/1 var(--font-sans);
    cursor: pointer;
    transition: background .18s var(--ease-out), color .18s var(--ease-out);
    -webkit-tap-highlight-color: transparent;
}
.lb:hover:not(:disabled) { background: var(--fill-2); color: var(--ink); }
.lb.on { background: var(--fill-3); color: var(--ink); }
.lb:disabled { opacity: .4; cursor: not-allowed; }
.lb:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--lb-heart) 26%, transparent); }

.lb-heart { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
.lb-heart svg { width: 16px; height: 16px; display: block; transform-origin: 50% 55%; }
.lb-heart path {
    fill: transparent;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: fill .26s var(--lb-spring), stroke .26s var(--lb-spring);
}
.lb.on .lb-heart { color: var(--lb-heart); }
.lb.on .lb-heart path { fill: var(--lb-heart); stroke: var(--lb-heart); }

/* 先压扁再弹回，带回弹曲线 */
.lb.squash .lb-heart svg { animation: lbSquash .38s var(--lb-spring); }
@keyframes lbSquash {
    0% { transform: scale(1); }
    26% { transform: scale(.78, 1.16); }
    62% { transform: scale(1.12, .94); }
    100% { transform: scale(1); }
}

.lb-num {
    display: inline-block;
    height: 1em;
    overflow: hidden;
    font: 500 12.5px/1 var(--font-mono);
    font-variant-numeric: tabular-nums;
    transition: width .32s var(--lb-spring);
}
.lb-track { display: block; height: 1em; transition: transform .34s var(--lb-spring); will-change: transform; }
.lb-track > span { display: flex; align-items: center; justify-content: center; height: 1em; }

@media (prefers-reduced-motion: reduce) {
    .lb, .lb-num, .lb-track, .lb-heart path { transition-duration: .01s; }
    .lb.squash .lb-heart svg { animation: none; }
}
</style>
