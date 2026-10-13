<script setup>
// 线性图标：先用全局 ICONS，缺的几个在这里补（笔画规格与 lib/icons.js 一致：24 网格、1.5 描边、圆角）
import { computed } from 'vue';
import { ICONS } from '../../../../lib/icons.js';
const EXTRA = {
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    radar: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l5-5"/>',
    grip: '<circle cx="9" cy="6" r=".6"/><circle cx="15" cy="6" r=".6"/><circle cx="9" cy="12" r=".6"/><circle cx="15" cy="12" r=".6"/><circle cx="9" cy="18" r=".6"/><circle cx="15" cy="18" r=".6"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/>',
    coins: '<ellipse cx="9" cy="7" rx="5" ry="2.5"/><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7"/><path d="M10 15.4c.9 1.2 2.9 2.1 5 2.1 2.8 0 5-1.1 5-2.5v-4c0-1.2-1.6-2.2-3.8-2.4"/>',
    paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 14h6"/>',
    plug: '<path d="M9 3v4M15 3v4"/><path d="M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
    cloudown: '<path d="M7 17a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4 4 0 0 1 .5 7.97"/><path d="M12 11v9M9 17l3 3 3-3"/>',
    listcheck: '<path d="M11 6h9M11 12h9M11 18h9"/><path d="M4 6l1.5 1.5L8 5"/><path d="M4 12l1.5 1.5L8 11"/><path d="M4 18l1.5 1.5L8 17"/>',
};
const props = defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: null } });
const html = computed(() => EXTRA[props.name] || ICONS[props.name] || '');
const style = computed(() => (props.size ? { width: props.size + 'px', height: props.size + 'px' } : null));
</script>

<template>
    <svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true" :style="style" v-html="html"></svg>
</template>
