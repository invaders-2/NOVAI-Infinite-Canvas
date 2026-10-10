<script setup>
// 思考条 + 可折叠思考过程（旧 ThoughtLine）：
//   进行中：闪光图标 +「正在思考」微光 + 秒表，思考条目逐条长出（默认展开；最后一条是跳动圆点，之前打勾，后端动作是闪电）
//   收尾：秒表冻结 → 全部打勾 → 折叠成「已思考 x.xs」；没有任何思考内容就整块不显示
//   落盘的思考（刷新 / 切会话）：折叠态；本次会话里测到过耗时才显示「已思考 x.xs」，否则显示「思考过程」
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import ChIcon from './ChIcon.vue';
import { thoughtFmt } from './thought.js';
import { t } from '../../lib/store.js';

const props = defineProps({ thought: { type: Object, required: true } });
const th = computed(() => props.thought);
const open = ref(!!props.thought.open);
watch(() => props.thought.open, v => { open.value = !!v; });

const running = computed(() => th.value.live && !th.value.settled);
const now = ref(typeof performance !== 'undefined' ? performance.now() : 0);
let timer = 0;
watch(running, v => {
    clearInterval(timer);
    if (v) timer = setInterval(() => { now.value = performance.now(); }, 100);
}, { immediate: true });
onBeforeUnmount(() => clearInterval(timer));

const entries = computed(() => (th.value.entries || []).slice(-200));
const hasTrace = computed(() => entries.value.length > 0);
const hidden = computed(() => !running.value && !hasTrace.value);
const label = computed(() => {
    if (running.value) return t('chat.agentWorking', '正在思考');
    return th.value.tenths != null ? t('chat.thoughtDone', '已思考') : t('chat.thoughtTrace', '思考过程');
});
const time = computed(() => {
    if (running.value) return thoughtFmt(Math.max(0, Math.floor((now.value - th.value.start) / 100)));
    return th.value.tenths != null ? thoughtFmt(th.value.tenths) : '';
});
function toggle() { if (hasTrace.value) open.value = !open.value; }

// 思考过程区贴底跟随；用户自己往上翻就不拽回去
const trace = ref(null);
let pinned = true;
function onScroll() { const el = trace.value; if (el) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 8; }
function onWheel(e) { const el = trace.value; if (el && e.deltaY < 0 && el.scrollTop > 0) pinned = false; }
watch(() => entries.value.length + ':' + (entries.value[entries.value.length - 1] || ''), () => {
    nextTick(() => { const el = trace.value; if (el && pinned) el.scrollTop = el.scrollHeight; });
});
function mark(e, i) {
    if (running.value && i === entries.value.length - 1) return 'act';
    return typeof e === 'object' && e && e.status ? 'st' : 'done';
}
const textOf = e => (typeof e === 'string' ? e : (e && e.text) || '');
</script>

<template>
    <div v-if="!hidden" class="thk" :class="{ live: running, open: open && hasTrace }">
        <button type="button" class="line" :aria-expanded="open && hasTrace ? 'true' : 'false'" :title="hasTrace ? t('chat.thoughtTrace', '思考过程') : null" :disabled="!hasTrace" @click="toggle">
            <ChIcon name="sparkles" class="gl" />
            <span class="lb">{{ label }}</span>
            <span v-if="time" class="tm">{{ time }}</span>
            <ChIcon v-if="hasTrace" name="chev" class="cr" />
        </button>
        <div class="tr-wrap" :class="{ shut: !(open && hasTrace) }">
            <div ref="trace" class="trace" role="log" :aria-label="t('chat.thoughtTrace', '思考过程')" @scroll.passive="onScroll" @wheel.passive="onWheel">
                <div v-for="(e, i) in entries" :key="i" class="tr" :class="mark(e, i)">
                    <span class="mk">
                        <span v-if="mark(e, i) === 'act'" class="pulse"></span>
                        <ChIcon v-else :name="mark(e, i) === 'st' ? 'bolt' : 'check'" />
                    </span>
                    <span class="tx">{{ textOf(e) }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.thk { align-self: flex-start; display: flex; flex-direction: column; max-width: min(600px, 100%); }
.line { align-self: flex-start; display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px 0 8px; border: 0; border-radius: 999px; background: var(--fill-1);
    font: 400 12px/1 var(--font-sans); color: var(--ink-2); cursor: pointer; transition: background var(--duration-fast); }
.line:hover:not(:disabled) { background: var(--fill-2); }
.line:disabled { cursor: default; }
.line .nv-i { width: 14px; height: 14px; }
.live .gl { animation: thk-breath 1.6s var(--ease-in-out) infinite; }
.tm { font: 400 11px/1 var(--font-mono); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.cr { width: 12px !important; height: 12px !important; opacity: .6; transition: transform var(--duration-base) var(--ease-out); }
.open .cr { transform: rotate(180deg); }
.live .lb { background: linear-gradient(90deg, var(--ink-3) 0%, var(--ink) 45%, var(--ink-3) 90%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: thk-shine 1.8s linear infinite; }
.tr-wrap { display: grid; grid-template-rows: 1fr; transition: grid-template-rows var(--duration-base) var(--ease-out), opacity var(--duration-base); }
.tr-wrap.shut { grid-template-rows: 0fr; opacity: 0; }
.trace { min-height: 0; max-height: 240px; overflow-y: auto; margin: 8px 0 0 13px; padding: 2px 0 2px 16px; display: flex; flex-direction: column; gap: 7px; box-shadow: inset 1.5px 0 0 var(--fill-2); }
.tr-wrap.shut .trace { margin-top: 0; }
.tr { display: flex; gap: 9px; align-items: flex-start; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.tr .mk { width: 14px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3); }
.tr .mk .nv-i { width: 12px; height: 12px; }
.tr.st { color: var(--ink-2); }
.tr.act { color: var(--ink); }
.tr .tx { min-width: 0; overflow-wrap: anywhere; }
.pulse { width: 5px; height: 5px; border-radius: 50%; background: var(--ink); animation: thk-breath 1.05s var(--ease-in-out) infinite; }
@keyframes thk-breath { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes thk-shine { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .live .lb, .live .gl, .pulse { animation: none; } }
</style>
