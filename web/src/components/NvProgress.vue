<script setup>
defineProps({ stage: String, percent: { type: Number, default: 0 }, error: Boolean, detail: String });
</script>
<template>
    <div class="pg" :class="{ err: error }">
        <div class="pg-h"><span class="st">{{ stage }}</span><span class="pc">{{ Math.round(percent) }}%</span></div>
        <div class="tr"><div class="bar" :style="{ width: Math.max(0, Math.min(100, percent)) + '%' }"></div></div>
        <div v-if="detail" class="dt">{{ detail }}</div>
    </div>
</template>
<style scoped>
.pg { padding: 12px 14px; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-float); }
.pg-h { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.st { font: 400 12.5px/18px var(--font-sans); color: var(--ink); }
.pc { font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.tr { height: 3px; border-radius: 3px; background: var(--fill-2); overflow: hidden; }
.bar { height: 100%; border-radius: 3px; background: var(--ink); transition: width 400ms var(--ease-out); }
.err .st { color: var(--danger); } .err .bar { background: var(--danger); }
.dt { margin-top: 6px; font: 400 11px/16px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
