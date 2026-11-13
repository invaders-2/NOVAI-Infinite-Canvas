<script setup>
// 更新说明：标题「已更新到 vX」+ 逐条列出本次改动；条目带 media 时给出动态演示，
// 点条目或按 ← → 切换主展示区；一条 media 都没有就退回纯文字列表。
import { computed, nextTick, ref, watch } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvUpdateMedia from '../components/NvUpdateMedia.vue';
import { updDone, closeUpdateDone, versionLabel, noteTypeLabel } from '../lib/update.js';

const dialog = ref(null);
const active = ref(0);
const items = computed(() => (updDone.notes && Array.isArray(updDone.notes.items) ? updDone.notes.items : []));
const hasMedia = computed(() => items.value.some(it => it && it.media));
const current = computed(() => items.value[active.value] || items.value[0] || null);
const title = computed(() => (updDone.version ? '已更新到 ' + versionLabel(updDone.version) : '更新完成'));
const sub = computed(() => (updDone.previous
    ? '从 ' + versionLabel(updDone.previous) + ' 更新而来，这次改了这些。'
    : '更新已完成，这次改了这些。'));

watch(() => updDone.open, async open => {
    if (!open) return;
    const first = items.value.findIndex(it => it && it.media);
    active.value = first < 0 ? 0 : first;
    await nextTick();
    if (dialog.value) dialog.value.focus();
});

/* applied 事件可能在弹窗已打开后才把带 media 的完整说明送进来 */
watch(() => updDone.notes, () => {
    const first = items.value.findIndex(it => it && it.media);
    const cur = items.value[active.value];
    if (first >= 0 && (!cur || !cur.media)) { active.value = first; return; }
    if (active.value >= items.value.length) active.value = 0;
});

function step(delta) {
    const total = items.value.length;
    if (!hasMedia.value || total < 2) return;
    active.value = (active.value + delta + total) % total;
}
</script>

<template>
    <Transition name="modal">
        <div v-if="updDone.open" class="scrim" @mousedown.self="closeUpdateDone" @keydown.esc="closeUpdateDone">
            <div
                ref="dialog"
                class="ud"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ud-title"
                tabindex="-1"
                @keydown.left.prevent="step(-1)"
                @keydown.right.prevent="step(1)"
            >
                <header class="ud-h">
                    <span class="mark"><NvIcon name="check" /></span>
                    <div class="hx">
                        <h3 id="ud-title">{{ title }}</h3>
                        <p class="sub">{{ sub }}</p>
                    </div>
                    <button type="button" class="nv-icon-btn sm" title="关闭" @click="closeUpdateDone"><NvIcon name="x" /></button>
                </header>
                <div v-if="items.length" class="ud-b" :class="{ split: hasMedia }">
                    <template v-if="hasMedia">
                        <div class="stage">
                            <NvUpdateMedia v-if="current && current.media" :key="'m' + active" :media="current.media" />
                            <p v-else class="slide">{{ current && current.text }}</p>
                        </div>
                        <ul class="list">
                            <li v-for="(it, i) in items" :key="i">
                                <button type="button" class="row" :class="{ on: i === active }" @click="active = i">
                                    <span v-if="noteTypeLabel(it.type)" class="tag">{{ noteTypeLabel(it.type) }}</span>
                                    <span class="txt">{{ it.text }}</span>
                                    <span v-if="it.media" class="mi"><NvIcon :name="it.media.type === 'video' ? 'film' : 'image'" /></span>
                                </button>
                            </li>
                        </ul>
                    </template>
                    <ul v-else class="plain">
                        <li v-for="(it, i) in items" :key="i">
                            <span v-if="noteTypeLabel(it.type)" class="tag">{{ noteTypeLabel(it.type) }}</span>
                            <span class="txt">{{ it.text }}</span>
                        </li>
                    </ul>
                </div>
                <p v-else class="muted">这次没有单独的更新说明。</p>
                <footer class="ud-f">
                    <span v-if="hasMedia && items.length > 1" class="hint">点条目切换演示 · ← →</span>
                    <button type="button" class="nv-btn primary" @click="closeUpdateDone">知道了</button>
                </footer>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
/* 全屏 backdrop-filter 在 Electron/macOS 上会逐帧重采样下层（表现为闪烁），提独立合成层隔离；transform 不影响 flex 居中 */
.scrim { position: fixed; inset: 0; z-index: 2500; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; transform: translateZ(0); will-change: transform; isolation: isolate; }
.ud { width: min(760px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; outline: none; }
.ud-h { display: flex; align-items: flex-start; gap: 14px; padding: 22px 24px 6px; }
.mark { width: 36px; height: 36px; border-radius: 50%; background: var(--fill-1); display: flex; align-items: center; justify-content: center; flex: none; }
.mark .nv-i { width: 18px; height: 18px; color: var(--ink); }
.hx { flex: 1; min-width: 0; padding-top: 1px; }
.ud-h h3 { margin: 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.sub { margin: 3px 0 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.ud-b { padding: 14px 24px 6px; overflow: hidden; display: flex; flex-direction: column; gap: 12px; }
.ud-b.split { display: grid; grid-template-columns: minmax(0, 1fr) 264px; gap: 20px; align-items: start; }
.stage { min-width: 0; }
.slide { margin: 0; min-height: 180px; display: flex; align-items: center; padding: 22px; border-radius: 14px; background: var(--fill-1); font: 400 13px/21px var(--font-sans); color: var(--ink-2); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: min(46vh, 340px); overflow-y: auto; }
.row { width: 100%; display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--ink-2); font: 400 12px/18px var(--font-sans); text-align: left; cursor: pointer; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.row:hover { background: var(--fill-1); }
.row.on { background: var(--fill-1); color: var(--ink); font-weight: 500; }
.row .txt { flex: 1; min-width: 0; }
.mi { flex: none; display: inline-flex; margin-top: 2px; color: var(--ink-4); }
.mi .nv-i { width: 12px; height: 12px; }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; max-height: min(46vh, 340px); overflow-y: auto; }
.plain li { display: flex; align-items: flex-start; gap: 8px; font: 400 12.5px/21px var(--font-sans); color: var(--ink-2); }
.tag { flex: none; margin-top: 2px; padding: 0 5px; border-radius: 4px; background: var(--fill-2); color: var(--ink-3); font: 400 10px/16px var(--font-mono); letter-spacing: .02em; }
.muted { margin: 0; padding: 10px 24px 6px; font: 400 12.5px/19px var(--font-sans); color: var(--ink-3); }
.ud-f { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 14px 24px 22px; }
.hint { margin-right: auto; font: 400 11px/16px var(--font-mono); color: var(--ink-4); }
@media (max-width: 720px) { .ud-b.split { grid-template-columns: minmax(0, 1fr); } }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .ud { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
