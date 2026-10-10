<script setup>
defineProps({ title: String, desc: String });
</script>
<template>
    <section class="sc">
        <header class="sc-h">
            <div><h4>{{ title }}</h4><p v-if="desc">{{ desc }}</p></div>
            <slot name="action" />
        </header>
        <div class="sc-b"><slot /></div>
    </section>
</template>
<style scoped>
.sc + .sc { margin-top: 28px; }
.sc-h { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.sc-h h4 { margin: 0; font: 500 14px/20px var(--font-sans); color: var(--ink); }
.sc-h p { margin: 2px 0 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.sc-b { padding: 4px 16px; border-radius: 14px; background: var(--fill-1); }
</style>
