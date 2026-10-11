<script setup>
// 弹窗：确认（删除后端 / 删除工作流）与命名（上传工作流时取名，替代旧 window.prompt）
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';

const props = defineProps({
    open: Boolean,
    title: String,
    desc: String,
    confirmText: { type: String, default: '确定' },
    cancelText: { type: String, default: '取消' },
    danger: Boolean,
    busy: Boolean,
    input: { type: Boolean, default: false },   // 命名模式：带一个输入框
    inputValue: { type: String, default: '' },
    inputPlaceholder: String,
});
const emit = defineEmits(['confirm', 'cancel']);
const val = ref('');
const inp = ref(null);
const okBtn = ref(null);
const cancelBtn = ref(null);

function onKey(e) {
    if (!props.open) return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); if (!props.busy) emit('cancel'); }
}
watch(() => props.open, o => {
    if (o) {
        val.value = props.inputValue || '';
        window.addEventListener('keydown', onKey, true);
        nextTick(() => { if (props.input && inp.value) { inp.value.focus(); inp.value.select(); } else if (cancelBtn.value) cancelBtn.value.focus(); });
    } else window.removeEventListener('keydown', onKey, true);
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
function ok() {
    if (props.busy) return;
    if (props.input) { const v = val.value.trim(); if (!v) { inp.value && inp.value.focus(); return; } emit('confirm', v); }
    else emit('confirm');
}
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="wfd">
            <div v-if="open" class="wfd-scrim" @mousedown.self="!busy && emit('cancel')">
                <div class="wfd" :role="danger ? 'alertdialog' : 'dialog'" aria-modal="true">
                    <h2 class="wfd-t">{{ title }}</h2>
                    <p v-if="desc" class="wfd-d">{{ desc }}</p>
                    <div v-if="input" class="nv-field wfd-f"><input ref="inp" v-model="val" type="text" :placeholder="inputPlaceholder" @keydown.enter.prevent="ok" /></div>
                    <div class="wfd-a">
                        <button ref="cancelBtn" type="button" class="nv-btn sm ghost" :disabled="busy" @click="emit('cancel')">{{ cancelText }}</button>
                        <button ref="okBtn" type="button" class="nv-btn sm" :class="danger ? 'danger' : 'primary'" :disabled="busy || (input && !val.trim())" @click="ok"><span v-if="busy" class="spin wfd-spin"></span>{{ confirmText }}</button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style>
.wfd-scrim { position: fixed; inset: 0; z-index: 2500; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.wfd { width: 100%; max-width: 400px; padding: 22px 22px 18px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); display: flex; flex-direction: column; gap: 6px; font-family: var(--font-sans); color: var(--ink); }
.wfd-t { margin: 0; font: 500 15px/22px var(--font-sans); letter-spacing: -.01em; }
.wfd-d { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); word-break: break-all; }
.wfd-f { margin-top: 8px; }
.wfd-a { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.wfd-spin { width: 12px; height: 12px; }
.wfd-enter-active { transition: opacity 240ms var(--ease-out); }
.wfd-enter-active .wfd { transition: transform 320ms var(--ease-sheet), opacity 320ms var(--ease-sheet); }
.wfd-leave-active { transition: opacity 160ms var(--ease-out); }
.wfd-enter-from { opacity: 0; }
.wfd-enter-from .wfd { opacity: 0; transform: translateY(10px) scale(.98); }
.wfd-leave-to { opacity: 0; }
</style>
