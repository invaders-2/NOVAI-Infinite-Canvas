<script setup>
// 模型 / 平台供应商 logo：有品牌图标就画图标，没有就退回首字母方块
import { computed } from 'vue';
import { BRAND_ICONS, BRAND_COLORS, DARK_LOGO_BRANDS, resolveBrand, brandInitial } from '../lib/vendorIcons.js';

const props = defineProps({
    name: { type: String, default: '' },
    id: { type: String, default: '' },
    model: { type: String, default: '' },
    size: { type: Number, default: 18 }
});

const key = computed(() => resolveBrand(props));
const color = computed(() => DARK_LOGO_BRANDS.has(key.value) ? 'currentColor' : (BRAND_COLORS[key.value] || 'currentColor'));
const initial = computed(() => brandInitial(props));
const fbBg = computed(() => BRAND_COLORS[key.value] || 'var(--fill-2)');
const fbFg = computed(() => BRAND_COLORS[key.value] ? '#fff' : 'var(--ink-2)');
</script>

<template>
    <svg v-if="key && BRAND_ICONS[key]" class="vlogo" :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor"
        :style="{ color }" aria-hidden="true" v-html="BRAND_ICONS[key]"></svg>
    <span v-else class="vlogo fb" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * .52) + 'px', background: fbBg, color: fbFg }" aria-hidden="true">{{ initial }}</span>
</template>

<style scoped>
.vlogo { flex: none; display: block; }
.vlogo.fb { display: inline-flex; align-items: center; justify-content: center; border-radius: 22%; font: 600 1em/1 var(--font-sans); letter-spacing: 0; }
</style>
