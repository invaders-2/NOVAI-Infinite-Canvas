<script setup>
// Hugeicons Animated 的 arrow-up-02（会动的发送箭头）：官方 registry 是 motion 版；
// 这里不引 motion，用浏览器原生 WAAPI 播同一套关键帧。
// 触发挂在最近的 button 上（鼠标进入 / 按下 / 键盘聚焦各播一次，先 cancel 再 play），
// prefers-reduced-motion: reduce 时完全不播。纯图标，颜色跟随按钮 currentColor。
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
    size: { type: [Number, String], default: 16 },
});

const KEYFRAMES = [
    { transform: 'translateY(0px) scaleX(1)' },
    { transform: 'translateY(-2.6px) scaleX(0.94)', offset: 0.25 },
    { transform: 'translateY(0.3px) scaleX(1.02)', offset: 0.5 },
    { transform: 'translateY(-0.45px) scaleX(0.99)', offset: 0.75 },
    { transform: 'translateY(0px) scaleX(1)', offset: 1 },
];
const TIMING = { duration: 500, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' };

const root = ref(null);
let host = null;
let current = null;

function play() {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const g = root.value && root.value.querySelector('g');
    if (!g || typeof g.animate !== 'function') return;
    if (current) current.cancel();
    current = g.animate(KEYFRAMES, TIMING);
}

onMounted(() => {
    host = (root.value && root.value.closest('button')) || root.value;
    if (!host) return;
    host.addEventListener('pointerenter', play);
    host.addEventListener('pointerdown', play);
    host.addEventListener('focusin', play);
});

onBeforeUnmount(() => {
    if (host) {
        host.removeEventListener('pointerenter', play);
        host.removeEventListener('pointerdown', play);
        host.removeEventListener('focusin', play);
    }
    if (current) current.cancel();
    current = null;
    host = null;
});
</script>

<template>
    <svg ref="root" class="nv-send-ic" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         :stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" overflow="visible" aria-hidden="true" focusable="false" data-icon="send-animated">
        <!-- 描边属性同时写在 <g> 上：外层 svg 只是继承来源，<g> 自己的声明才盖得过页面上的 svg { stroke-width } -->
        <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
            <path d="M12 5.5V19" />
            <path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11" />
        </g>
    </svg>
</template>

<style scoped>
.nv-send-ic {
    display: block;
    flex: none;
    overflow: visible;
}

/* 只给 WAAPI 的 <g> 提供变换基准，不参与按钮布局 */
.nv-send-ic > g {
    transform-box: view-box;
    transform-origin: center;
    stroke-width: 1.5;
}

@media (prefers-reduced-motion: reduce) {
    .nv-send-ic > g { animation: none !important; }
}
</style>
