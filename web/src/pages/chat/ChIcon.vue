<script setup>
// 对话页图标：先查本页补充的几枚（效果图里有、全局 ICONS 里没有），再回落到 lib/icons.js
import { computed } from 'vue';
import { ICONS } from '../../lib/icons.js';
const EXTRA = {
    newchat: '<path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12"/><path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7L12 14.9l-3.6.9.9-3.6z"/>',
    size: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7 10v4M17 10v4"/>',
    terminal: '<path d="m5 8 4 4-4 4M12 17h7"/>',
    doc: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/>',
    zoomin: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8.5v5M8.5 11h5"/>',
    zoomout: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5"/>',
};
const props = defineProps({ name: { type: String, required: true } });
const svg = computed(() => EXTRA[props.name] || ICONS[props.name] || '');
</script>

<template>
    <svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true" v-html="svg"></svg>
</template>
