<script setup>
import NvIcon from '../components/NvIcon.vue';
import { upd, versionLabel, dismissReminder, openUpdateModal } from '../lib/update.js';
function go() { upd.reminder = ''; openUpdateModal(); }
</script>
<template>
    <Transition name="rem">
        <div v-if="upd.reminder" class="rem" role="status" aria-live="polite">
            <div class="top"><b>发现新版本 {{ versionLabel(upd.reminder) }}</b><button type="button" class="nv-icon-btn sm" title="忽略此版本" @click="dismissReminder"><NvIcon name="x" /></button></div>
            <p>新版本已就绪，可以立即安装。</p>
            <button type="button" class="nv-btn sm primary" @click="go">立即更新</button>
        </div>
    </Transition>
</template>
<style scoped>
.rem { position: fixed; right: 24px; bottom: 24px; z-index: 2400; width: 300px; padding: 14px 16px 16px; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-pop); }
.top { display: flex; align-items: center; justify-content: space-between; }
.top b { font: 500 13.5px/20px var(--font-sans); }
p { margin: 4px 0 12px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.rem-enter-active { transition: opacity 320ms var(--ease-out), transform 420ms var(--ease-out); }
.rem-leave-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.rem-enter-from { opacity: 0; transform: translateY(12px) scale(.98); }
.rem-leave-to { opacity: 0; transform: translateY(6px); }
</style>
