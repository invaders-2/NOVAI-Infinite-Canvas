<script setup>
import { computed } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvProgress from '../components/NvProgress.vue';
import { state } from '../lib/store.js';
import { upd, SOURCES, SOURCE_LABEL, versionLabel, setSource, sourceBadge, rowsFor, statusLabel, testConnectivity, startUpdate, closeUpdateModal, stageText } from '../lib/update.js';

const title = computed(() => (upd.remote ? '更新到 ' + versionLabel(upd.remote) : '一键更新'));
const copy = computed(() => `将从 ${SOURCE_LABEL[upd.source]} 下载并更新后端代码与页面资源。更新前会自动备份，更新完成后后端会自动重启。当前 ${versionLabel(state.version)}，最新 ${versionLabel(upd.remote || state.version)}。`);
const items = computed(() => ((upd.notes && upd.notes.items) || []).filter(Boolean).slice(0, 8).map(i => (typeof i === 'string' ? i : i.text)).filter(Boolean));
function onScrim(e) { if (e.target === e.currentTarget) closeUpdateModal(); }
</script>

<template>
    <Transition name="modal">
        <div v-if="upd.modalOpen" class="scrim" @mousedown="onScrim" @keydown.esc="closeUpdateModal">
            <div class="um" role="dialog" aria-modal="true" aria-labelledby="um-title">
                <header class="um-h">
                    <div><span class="eyebrow">发现更新</span><h3 id="um-title">{{ title }}</h3></div>
                    <button type="button" class="nv-icon-btn sm" title="关闭" @click="closeUpdateModal"><NvIcon name="x" /></button>
                </header>
                <div class="um-b">
                    <p class="copy">{{ copy }}</p>
                    <div v-if="upd.notes && (upd.notes.version || items.length)" class="notes">
                        <div class="nh"><b>本次更新内容</b><span class="mono">{{ upd.notes.version ? versionLabel(upd.notes.version) : '' }}</span></div>
                        <ul v-if="items.length"><li v-for="(it, i) in items" :key="i">{{ it }}</li></ul>
                        <div v-else class="muted">暂未获取到这个版本的更新说明。</div>
                    </div>
                    <div class="srcs">
                        <div v-for="s in SOURCES" :key="s.id" class="src" :class="{ on: upd.source === s.id }" role="button" tabindex="0" :aria-pressed="upd.source === s.id" @click="setSource(s.id)" @keydown.enter="setSource(s.id)">
                            <div class="src-h">
                                <span class="radio"></span>
                                <div class="src-t"><b>{{ s.title }}</b><span>{{ s.desc }}</span></div>
                                <span class="badge" :class="sourceBadge(s.id).state">{{ sourceBadge(s.id).text }}</span>
                            </div>
                            <div class="conn">
                                <div v-for="r in rowsFor(s.id)" :key="r.name" class="cr" :class="{ ok: r.ok && !r.pending && !r.untouched, fail: !r.ok && !r.pending && !r.untouched, pending: r.pending }">
                                    <span class="ind"></span>
                                    <span class="cn">{{ r.name }}</span>
                                    <span class="cs mono">{{ statusLabel(r) }}</span>
                                    <span v-if="r.error && !r.timed_out" class="ce">{{ String(r.error).slice(0, 200) }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="sum" :class="upd.summary.kind"><span class="d"></span><div><b>{{ upd.summary.title }}</b><span>{{ upd.summary.text }}</span></div></div>
                    <NvProgress v-if="upd.running && upd.progress" :stage="stageText(upd.progress)" :percent="Number(upd.progress.percent) || 0" :error="upd.progress.stage === 'error'" :detail="upd.progress.stage === 'downloading' && upd.progress.current_file ? '当前文件：' + upd.progress.current_file : ''" />
                </div>
                <footer class="um-f">
                    <button type="button" class="nv-btn sm" :disabled="upd.testing || upd.running" @click="testConnectivity"><span v-if="upd.testing" class="spin sm"></span><NvIcon v-else name="globe" />{{ upd.testing ? '检测中…' : upd.conn ? '重新测试' : '测试连通性' }}</button>
                    <span class="grow"></span>
                    <button type="button" class="nv-btn sm ghost" @click="closeUpdateModal">取消</button>
                    <button type="button" class="nv-btn sm primary" :disabled="upd.running" @click="startUpdate">{{ upd.running ? '更新中…' : '开始更新' }}</button>
                </footer>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 2500; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.um { width: min(620px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.um-h { display: flex; align-items: flex-start; justify-content: space-between; padding: 22px 24px 8px; }
.eyebrow { font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.um-h h3 { margin: 4px 0 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.um-b { padding: 6px 24px 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.copy { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.notes { padding: 12px 14px; border-radius: 12px; background: var(--fill-1); }
.nh { display: flex; justify-content: space-between; font: 500 12.5px/18px var(--font-sans); }
.nh .mono { font: 400 11px/18px var(--font-mono); color: var(--ink-3); }
.notes ul { margin: 6px 0 0; padding-left: 16px; font: 400 12px/19px var(--font-sans); color: var(--ink-2); }
.muted { font: 400 12px/18px var(--font-sans); color: var(--ink-3); margin-top: 4px; }
.srcs { display: flex; flex-direction: column; gap: 8px; }
.src { border-radius: 12px; background: var(--fill-1); padding: 12px 14px; cursor: pointer; transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast); }
.src:hover { background: var(--fill-2); }
.src.on { background: var(--solid); box-shadow: var(--shadow-float); }
.src-h { display: flex; align-items: center; gap: 10px; }
.radio { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--ink-4); flex: none; }
.src.on .radio { box-shadow: inset 0 0 0 4.5px var(--ink); }
.src-t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.src-t b { font: 500 13px/18px var(--font-sans); }
.src-t span { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.badge { height: 20px; padding: 0 8px; border-radius: 99px; background: var(--fill-2); font: 400 11px/20px var(--font-sans); color: var(--ink-3); flex: none; }
.badge.ok { background: var(--ink); color: var(--on-accent); }
.badge.bad { background: var(--danger-fill); color: var(--danger); }
.conn { display: none; margin-top: 8px; padding-left: 24px; }
.src.on .conn { display: flex; flex-direction: column; gap: 2px; }
.cr { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 8px; min-height: 22px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-2); }
.ind { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-4); }
.cr.ok .ind { background: var(--ink); } .cr.fail .ind { background: var(--danger); } .cr.pending .ind { animation: nv-breathe 1s infinite; }
.cs { font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.cr.fail .cs { color: var(--danger); }
.ce { grid-column: 2 / 4; font: 400 11px/15px var(--font-mono); color: var(--ink-3); word-break: break-all; }
.sum { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fill-1); }
.sum .d { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: var(--ink-3); }
.sum.ok .d { background: var(--ink); } .sum.fail .d { background: var(--danger); }
.sum b { display: block; font: 500 12.5px/18px var(--font-sans); }
.sum span { font: 400 12px/18px var(--font-sans); color: var(--ink-2); }
.um-f { display: flex; align-items: center; gap: 8px; padding: 14px 24px 20px; }
.grow { flex: 1; }
.spin.sm { width: 12px; height: 12px; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .um { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
