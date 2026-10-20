<script setup>
// 更新弹窗：只留「版本 + 更新内容 + 进度 + 一个按钮」。下载源统一在「设置 → 通用 → 更新源」选，
// 连通性检测之类技术细节不在这里展示；失败也只说一句人话，技术原因在 console。
import { computed } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvProgress from '../components/NvProgress.vue';
import { state } from '../lib/store.js';
import { upd, versionLabel, startUpdate, closeUpdateModal, stageText } from '../lib/update.js';

const title = computed(() => (upd.remote ? '发现新版本 ' + versionLabel(upd.remote) : '软件更新'));
const versionLine = computed(() => (upd.remote
    ? `当前 ${versionLabel(state.version)} → 最新 ${versionLabel(upd.remote)}`
    : `当前 ${versionLabel(state.version)}`));
const items = computed(() => ((upd.notes && upd.notes.items) || []).filter(Boolean).slice(0, 6).map(i => (typeof i === 'string' ? i : i.text)).filter(Boolean));
const notesVersion = computed(() => (upd.notes && upd.notes.version ? versionLabel(upd.notes.version) : ''));
const phase = computed(() => (upd.running ? 'running' : upd.phase));
const progressStage = computed(() => stageText(upd.progress));
const progressPercent = computed(() => Number((upd.progress && upd.progress.percent) || 0));
function onScrim(e) { if (e.target === e.currentTarget) closeUpdateModal(); }
</script>

<template>
    <Transition name="modal">
        <div v-if="upd.modalOpen" class="scrim" @mousedown="onScrim" @keydown.esc="closeUpdateModal">
            <div class="um" role="dialog" aria-modal="true" aria-labelledby="um-title">
                <header class="um-h">
                    <div><h3 id="um-title">{{ title }}</h3><p class="ver">{{ versionLine }}</p></div>
                    <button type="button" class="nv-icon-btn sm" title="关闭" @click="closeUpdateModal"><NvIcon name="x" /></button>
                </header>
                <div class="um-b">
                    <div class="notes">
                        <div class="nh"><b>更新内容</b><span v-if="notesVersion" class="mono">{{ notesVersion }}</span></div>
                        <ul v-if="items.length"><li v-for="(it, i) in items" :key="i">{{ it }}</li></ul>
                        <p v-else class="muted">这次没有额外的更新说明。</p>
                    </div>
                    <NvProgress v-if="phase === 'running'" :stage="progressStage" :percent="progressPercent" />
                    <p v-else-if="phase === 'restarting'" class="msg"><span class="dot ok"></span>更新完成，正在重启…</p>
                    <p v-else-if="phase === 'done'" class="msg"><span class="dot ok"></span>更新完成。</p>
                    <p v-else-if="phase === 'error'" class="msg"><span class="dot bad"></span>{{ upd.error || '更新失败，请检查网络后重试' }}</p>
                </div>
                <footer class="um-f">
                    <span class="grow"></span>
                    <template v-if="phase === 'error'">
                        <button type="button" class="nv-btn sm ghost" @click="closeUpdateModal">关闭</button>
                        <button type="button" class="nv-btn sm primary" @click="startUpdate">重试</button>
                    </template>
                    <template v-else-if="phase === 'running'">
                        <button type="button" class="nv-btn sm primary" disabled>更新中…</button>
                    </template>
                    <template v-else-if="phase === 'restarting'">
                        <button type="button" class="nv-btn sm primary" disabled>正在重启…</button>
                    </template>
                    <template v-else-if="phase === 'done'">
                        <button type="button" class="nv-btn sm primary" @click="closeUpdateModal">知道了</button>
                    </template>
                    <template v-else>
                        <button type="button" class="nv-btn sm ghost" @click="closeUpdateModal">稍后</button>
                        <button type="button" class="nv-btn sm primary" @click="startUpdate">立即更新</button>
                    </template>
                </footer>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 2500; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.um { width: min(560px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.um-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 22px 24px 8px; }
.um-h h3 { margin: 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.ver { margin: 4px 0 0; font: 400 12px/18px var(--font-mono); color: var(--ink-3); }
.um-b { padding: 6px 24px 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.notes { padding: 14px 16px; border-radius: 12px; background: var(--fill-1); }
.nh { display: flex; justify-content: space-between; align-items: baseline; font: 500 12.5px/18px var(--font-sans); }
.nh .mono { font: 400 11px/18px var(--font-mono); color: var(--ink-3); }
.notes ul { margin: 8px 0 0; padding-left: 16px; font: 400 12px/20px var(--font-sans); color: var(--ink-2); }
.notes li + li { margin-top: 2px; }
.muted { font: 400 12px/18px var(--font-sans); color: var(--ink-3); margin: 6px 0 0; }
.msg { display: flex; align-items: center; gap: 8px; margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ink-4); }
.dot.ok { background: var(--ink); }
.dot.bad { background: var(--danger); }
.um-f { display: flex; align-items: center; gap: 8px; padding: 14px 24px 20px; }
.grow { flex: 1; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .um { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
