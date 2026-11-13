<script setup>
import { computed } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import {
    upd, versionLabel, dismissReminder, openUpdateModal,
    restartUpdateNow, snoozeUpdateCard, dismissUpdateCard, retryUpdateInstall,
} from '../lib/update.js';

/* 新版桌面端（静默下载已完成）与老链路（发现新版本）共用这张卡片，状态由 upd.card 决定。 */
const cardTitle = computed(() => {
    if (upd.card === 'installing') return '正在重启安装…';
    if (upd.card === 'error') return '更新没有完成';
    return '新版本 ' + versionLabel(upd.cardVersion) + ' 已下载完成';
});
const cardMsg = computed(() => {
    if (upd.card === 'installing') return '装好后应用会自动重新打开。';
    if (upd.card === 'error') return upd.cardError || '稍后可以再试一次。';
    return '现在重启安装？';
});
const closeTitle = computed(() => (upd.card === 'downloaded' ? '稍后' : '关闭'));
function onClose() {
    if (upd.card === 'downloaded') snoozeUpdateCard();
    else dismissUpdateCard();
}
function go() { upd.reminder = ''; openUpdateModal(); }
</script>

<template>
    <Transition name="rem">
        <div v-if="upd.card" class="rem" role="status" aria-live="polite">
            <div class="hd">
                <span v-if="upd.card === 'installing'" class="spin lead"></span>
                <span v-else class="dot" :class="upd.card"></span>
                <b>{{ cardTitle }}</b>
                <button v-if="upd.card !== 'installing'" type="button" class="nv-icon-btn sm" :title="closeTitle" @click="onClose"><NvIcon name="x" /></button>
            </div>
            <p>{{ cardMsg }}</p>
            <div v-if="upd.card !== 'installing'" class="acts">
                <template v-if="upd.card === 'downloaded'">
                    <button type="button" class="nv-btn sm ghost" @click="snoozeUpdateCard">稍后</button>
                    <button type="button" class="nv-btn sm primary" @click="restartUpdateNow">立即重启</button>
                </template>
                <template v-else>
                    <button type="button" class="nv-btn sm ghost" @click="dismissUpdateCard">关闭</button>
                    <button type="button" class="nv-btn sm primary" @click="retryUpdateInstall">重试</button>
                </template>
            </div>
        </div>
        <div v-else-if="upd.reminder" class="rem" role="status" aria-live="polite">
            <div class="hd">
                <b>发现新版本 {{ versionLabel(upd.reminder) }}</b>
                <button type="button" class="nv-icon-btn sm" title="忽略此版本" @click="dismissReminder"><NvIcon name="x" /></button>
            </div>
            <p>新版本已就绪，可以立即安装。</p>
            <div class="acts">
                <button type="button" class="nv-btn sm primary" @click="go">立即更新</button>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
.rem { position: fixed; right: 24px; bottom: 24px; z-index: 2400; width: 320px; padding: 14px 16px 16px; border-radius: 16px;
    background: color-mix(in srgb, var(--solid) 96%, transparent);
    backdrop-filter: blur(32px) saturate(180%); -webkit-backdrop-filter: blur(32px) saturate(180%);
    box-shadow: var(--shadow-pop); }
.hd { display: flex; align-items: center; gap: 8px; }
.hd b { flex: 1; min-width: 0; font: 500 13.5px/20px var(--font-sans); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ink); }
.dot.error { background: var(--danger); }
.dot.installing { animation: nv-breathe 1.6s var(--ease-in-out) infinite; }
p { margin: 6px 0 12px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.acts { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.spin.lead { width: 13px; height: 13px; flex: none; color: var(--ink-2); }
.rem-enter-active { transition: opacity 320ms var(--ease-out), transform 380ms var(--ease-out); }
.rem-leave-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.rem-enter-from { opacity: 0; transform: translateY(10px); }
.rem-leave-to { opacity: 0; transform: translateY(4px); }
@media (prefers-reduced-motion: reduce) { .rem-enter-active, .rem-leave-active { transition: none; } }
</style>
