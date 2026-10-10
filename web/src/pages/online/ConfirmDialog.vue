<script setup>
// 二次确认弹窗（替换旧页面里的 window.confirm）：Teleport 到 body，Esc / 点遮罩取消，Enter 确认
import { watch, onBeforeUnmount } from 'vue';

const props = defineProps({
    open: Boolean,
    title: { type: String, default: '' },
    desc: { type: String, default: '' },
    okText: { type: String, default: '确定' },
    danger: Boolean,
    busy: Boolean,
});
const emit = defineEmits(['ok', 'cancel']);

function onKey(e) {
    if (!props.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!props.busy) emit('cancel'); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if (!props.busy) emit('ok'); }
}
watch(() => props.open, v => {
    if (v) window.addEventListener('keydown', onKey, true);
    else window.removeEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="ocf">
            <div v-if="open" class="ocf" role="dialog" aria-modal="true" :aria-label="title" @click.self="!busy && emit('cancel')">
                <div class="ocf-card">
                    <h3>{{ title }}</h3>
                    <p v-if="desc">{{ desc }}</p>
                    <div class="act">
                        <button type="button" class="nv-btn" :disabled="busy" @click="emit('cancel')">取消</button>
                        <button type="button" class="nv-btn" :class="danger ? 'ocf-danger' : 'primary'" :disabled="busy" @click="emit('ok')">
                            <span v-if="busy" class="spin"></span>{{ okText }}
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style>
.ocf { position: fixed; inset: 0; z-index: 2450; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.ocf-card { width: 100%; max-width: 380px; padding: 24px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); display: flex; flex-direction: column; gap: 8px; }
.ocf-card h3 { margin: 0; font: 500 16px/24px var(--font-sans); color: var(--ink); }
.ocf-card p { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); }
.ocf-card .act { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.ocf-card .spin { width: 12px; height: 12px; }
.nv-btn.ocf-danger { background: var(--danger); color: var(--on-accent); }
.nv-btn.ocf-danger:hover { opacity: .9; }
.ocf-enter-active { transition: opacity 240ms var(--ease-out); }
.ocf-enter-active .ocf-card { transition: transform 320ms var(--ease-sheet); }
.ocf-leave-active { transition: opacity 160ms var(--ease-out); }
.ocf-enter-from, .ocf-leave-to { opacity: 0; }
.ocf-enter-from .ocf-card { transform: scale(.98) translateY(10px); }
</style>
