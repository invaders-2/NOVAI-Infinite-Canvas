<script setup>
defineProps({ label: String, desc: String, stack: Boolean });
</script>
<template>
    <div class="sr" :class="{ stack }">
        <div class="sr-t"><div class="l">{{ label }}</div><div v-if="desc || $slots.desc" class="d"><slot name="desc">{{ desc }}</slot></div></div>
        <div class="sr-c"><slot /></div>
    </div>
</template>
<style scoped>
.sr { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 74px; padding: 10px 0; }
.sr + .sr { box-shadow: 0 -1px 0 var(--separator); }
.sr.stack { flex-direction: column; align-items: stretch; gap: 10px; }
.sr-t .l { font: 400 13px/18px var(--font-sans); color: var(--ink); }
.sr-t .d { margin-top: 2px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.sr-c { display: flex; align-items: center; gap: 8px; flex: none; }
.sr.stack .sr-c { flex-wrap: wrap; }
</style>
