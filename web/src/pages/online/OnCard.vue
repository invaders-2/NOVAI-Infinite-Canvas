<script setup>
// 设置栏可折叠卡片（替换旧 <details class="nv-card">）：标题行点击折叠 / 展开
import { ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';

defineProps({ icon: { type: String, default: '' }, title: { type: String, default: '' } });
const open = ref(true);
</script>

<template>
    <section class="occ" :class="{ closed: !open }">
        <button type="button" class="hd" :aria-expanded="open" @click="open = !open">
            <NvIcon v-if="icon" :name="icon" class="ic" /><span class="tt">{{ title }}</span>
            <NvIcon name="chev" class="cv" />
        </button>
        <div v-show="open" class="bd"><slot /></div>
    </section>
</template>

<style scoped>
.occ { flex: none; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-float); }
.hd { display: flex; align-items: center; gap: 8px; width: 100%; height: 44px; padding: 0 14px 0 16px; border: 0; border-radius: 16px; background: transparent; color: var(--ink); font: 500 13px/1 var(--font-sans); cursor: pointer; text-align: left; transition: background var(--duration-fast) var(--ease-out); }
.hd:hover { background: var(--fill-1); }
.occ:not(.closed) .hd { border-radius: 16px 16px 0 0; }
.hd .ic { width: 15px; height: 15px; color: var(--ink-3); }
.hd .tt { flex: 1; }
.hd .cv { width: 14px; height: 14px; color: var(--ink-4); transition: transform var(--duration-base) var(--ease-out); }
.occ.closed .hd .cv { transform: rotate(-90deg); }
.bd { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 10px; }
</style>
