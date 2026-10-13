<script setup>
// 设置弹窗之上的二级弹窗：nv-scrim + 圆角 20px 白卡，挂到 body（设置弹窗本身是 fixed z 2200）
import { watch, onBeforeUnmount } from 'vue';
const props = defineProps({
    open: Boolean,
    width: { type: String, default: '560px' },
    height: { type: String, default: '' },
    label: String,
    top: Boolean,          // 叠在另一个 ApiDialog 之上（例如编辑器里的确认）
    closable: { type: Boolean, default: true },
});
const emit = defineEmits(['close']);
function onKey(e) { if (e.key === 'Escape' && props.closable) { e.stopPropagation(); emit('close'); } }
watch(() => props.open, v => {
    if (v) window.addEventListener('keydown', onKey, true);
    else window.removeEventListener('keydown', onKey, true);
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="apid">
            <div v-if="open" class="nv-scrim apid-scrim" :class="{ top }" @mousedown.self="closable && emit('close')">
                <div class="apid" role="dialog" aria-modal="true" :aria-label="label" :style="{ width, height: height || null }">
                    <slot />
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.apid-scrim { position: fixed; inset: 0; z-index: 2300; padding: 16px; font-family: var(--font-sans); color: var(--ink); -webkit-font-smoothing: antialiased; }
.apid-scrim.top { z-index: 2320; }
.apid { position: relative; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.apid-enter-active { animation: nv-fade var(--duration-slow) var(--ease-out) both; }
.apid-enter-active .apid { animation: apid-in 320ms var(--ease-sheet) both; }
.apid-leave-active { transition: opacity var(--duration-fast) var(--ease-out); }
.apid-leave-to { opacity: 0; }
@keyframes apid-in { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .apid-enter-active, .apid-enter-active .apid { animation: none; } }
</style>
