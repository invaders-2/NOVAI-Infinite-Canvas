<script setup>
// 弹窗外壳：nv-scrim 风格遮罩 + 圆角 20 的白卡；点遮罩 / Esc 关闭。挂到 body，盖住整个设置弹窗。
import { onMounted, onBeforeUnmount } from 'vue';
const props = defineProps({ open: Boolean, width: { type: [Number, String], default: 520 }, label: String });
const emit = defineEmits(['close']);
function onKey(e) { if (props.open && e.key === 'Escape') { e.stopPropagation(); emit('close'); } }
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="am">
            <div v-if="open" class="am-scrim" @mousedown.self="emit('close')">
                <div class="am-card" role="dialog" aria-modal="true" :aria-label="label" :style="{ width: typeof width === 'number' ? width + 'px' : width }">
                    <slot />
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.am-scrim { position: fixed; inset: 0; z-index: 2400; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.am-card { max-width: calc(100vw - 48px); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; color: var(--ink); font-family: var(--font-sans); }
.am-enter-active { transition: opacity 220ms var(--ease-out); }
.am-enter-active .am-card { transition: transform 320ms var(--ease-sheet), opacity 320ms var(--ease-sheet); }
.am-leave-active { transition: opacity 160ms var(--ease-out); }
.am-leave-active .am-card { transition: transform 160ms var(--ease-out), opacity 160ms var(--ease-out); }
.am-enter-from, .am-leave-to { opacity: 0; }
.am-enter-from .am-card { opacity: 0; transform: scale(.98) translateY(10px); }
.am-leave-to .am-card { opacity: 0; transform: scale(.99) translateY(4px); }
@media (prefers-reduced-motion: reduce) { .am-enter-active .am-card, .am-leave-active .am-card { transition: none; } }
</style>
