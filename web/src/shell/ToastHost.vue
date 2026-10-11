<script setup>
import NvIcon from '../components/NvIcon.vue';
import { state, dismissToast } from '../lib/store.js';
function click(t) { if (t.onClick) { t.onClick(); dismissToast(t.id); } }
</script>

<template>
    <div class="th" aria-live="polite">
        <TransitionGroup name="toast">
            <div v-for="t in state.toasts" :key="t.id" class="toast" :class="{ danger: t.danger, clickable: !!t.onClick }" @click="click(t)">
                <NvIcon v-if="t.icon" :name="t.icon" />
                <span>{{ t.text }}</span>
            </div>
        </TransitionGroup>
    </div>
</template>

<style scoped>
.th { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 3000; display: flex; flex-direction: column-reverse; align-items: center; gap: 8px; pointer-events: none; }
.toast { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font: 400 13px/1 var(--font-sans); box-shadow: var(--shadow-lift); white-space: nowrap; }
.toast.clickable { pointer-events: auto; cursor: pointer; }
.toast.danger { background: var(--solid); color: var(--ink); }
.toast.danger .nv-i { color: var(--danger); }
.toast .nv-i { width: 14px; height: 14px; }
.toast-enter-active { transition: opacity 240ms var(--ease-out), transform 320ms var(--ease-out), filter 240ms var(--ease-out); }
.toast-leave-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.toast-enter-from { opacity: 0; transform: translateY(10px) scale(.96); filter: blur(4px); }
.toast-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
