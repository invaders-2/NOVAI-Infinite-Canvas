<script setup>
// 线性图标：先用全局 ICONS，缺的几个（退出、钱包、终端、锁、缩放、雷达）在这里补，笔画规格与 lib/icons.js 一致
import { computed } from 'vue';
import { ICONS } from '../../../../lib/icons.js';
const EXTRA = {
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    zoomin: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/><path d="M11 8v6M8 11h6"/>',
    zoomout: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/><path d="M8 11h6"/>',
    radar: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l5-5"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};
const props = defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: null } });
const html = computed(() => EXTRA[props.name] || ICONS[props.name] || '');
const style = computed(() => (props.size ? { width: props.size + 'px', height: props.size + 'px' } : null));
</script>

<template>
    <svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true" :style="style" v-html="html"></svg>
</template>
