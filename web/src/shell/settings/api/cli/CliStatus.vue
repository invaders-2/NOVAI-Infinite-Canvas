<script setup>
// CLI 状态胶囊：ok=true 实心（已登录 / 已安装），ok=false 危险色（失败 / 未登录），null 中性
defineProps({ text: String, ok: { type: Boolean, default: null } });
</script>

<template>
    <span class="cs" :class="{ ok: ok === true, bad: ok === false }" role="status"><i class="dot"></i>{{ text || '未检测' }}</span>
</template>

<style scoped>
.cs { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 99px; background: var(--solid); font: 400 11px/1 var(--font-sans); color: var(--ink-2); box-shadow: var(--shadow-float); white-space: nowrap; flex: none; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--ink-4); }
.cs.ok { background: var(--accent); color: var(--on-accent); box-shadow: none; }
.cs.ok .dot { background: var(--on-accent); }
.cs.bad { color: var(--danger); }
.cs.bad .dot { background: var(--danger); }
</style>
