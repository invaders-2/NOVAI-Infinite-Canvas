<script setup>
import { computed } from 'vue';
import { ICONS } from '../lib/icons.js';
const props = defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: null } });
const style = computed(() => (props.size ? { width: props.size + 'px', height: props.size + 'px' } : null));
</script>

<template>
    <svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true" :style="style" v-html="ICONS[name] || ''"></svg>
</template>
