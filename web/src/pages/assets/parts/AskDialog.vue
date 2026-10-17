<script setup>
// 应用内确认 / 输入弹窗（代替旧版的 window.prompt / confirm / alert），由 state.ask() 驱动
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { S } from '../lib/state.js';

const text = ref('');
const input = ref(null);
watch(() => S.ask, a => {
    if (!a) return;
    text.value = a.value || '';
    nextTick(() => { if (input.value) { input.value.focus(); input.value.select(); } });
});
function done(ok) {
    const a = S.ask;
    if (!a) return;
    S.ask = null;
    a.resolve(a.input ? (ok ? text.value : null) : ok);
}
function onKey(e) { if (S.ask && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false); } }
onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="am-sheet">
            <div v-if="S.ask" class="am-ask-scrim" @click.self="done(false)">
                <div class="am-ask" role="alertdialog" aria-modal="true" :aria-label="S.ask.title">
                    <h2>{{ S.ask.title }}</h2>
                    <p v-if="S.ask.desc">{{ S.ask.desc }}</p>
                    <input v-if="S.ask.input" ref="input" v-model="text" class="am-inp" type="text" :placeholder="S.ask.placeholder || ''" maxlength="200" @keydown.enter.prevent="done(true)">
                    <div class="acts">
                        <button v-if="S.ask.cancel" type="button" class="nv-btn ghost" @click="done(false)">{{ S.ask.cancel }}</button>
                        <button type="button" class="nv-btn" :class="S.ask.danger ? 'danger' : 'primary'" @click="done(true)">{{ S.ask.ok }}</button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.am-ask-scrim { position: fixed; inset: 0; z-index: 2360; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.am-ask { width: 380px; max-width: 100%; padding: 22px 24px 20px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); display: flex; flex-direction: column; gap: 10px; color: var(--ink); }
h2 { margin: 0; font: 500 16px/24px var(--font-sans); letter-spacing: -.01em; }
p { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); white-space: pre-line; }
.am-inp { height: 34px; font-size: 13px; margin-top: 4px; }
.acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.am-sheet-enter-active { transition: opacity 200ms var(--ease-out); }
.am-sheet-leave-active { transition: opacity 160ms var(--ease-out); }
.am-sheet-enter-from, .am-sheet-leave-to { opacity: 0; }
.am-sheet-enter-active .am-ask { transition: transform 320ms var(--ease-sheet), opacity 200ms var(--ease-out); }
.am-sheet-leave-active .am-ask { transition: transform 160ms var(--ease-out), opacity 160ms var(--ease-out); }
.am-sheet-enter-from .am-ask { transform: translateY(10px) scale(.98); opacity: 0; }
.am-sheet-leave-to .am-ask { transform: scale(.98); opacity: 0; }
</style>
