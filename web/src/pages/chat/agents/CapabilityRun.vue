<script setup>
// 对话里的能力运行消息（type:'capability'）：状态 + 步骤列表（实时推进）+ 产物卡片。
// HTML 产物点击在浏览器里渲染打开，xlsx / csv 走下载；刷新后由服务端会话里的同一条消息重建。
import { computed } from 'vue';
import ChIcon from '../ChIcon.vue';
import MdView from '../MdView.vue';
import { ICONS } from '../../../lib/icons.js';
import { agentById } from './capState.js';
import { openArtifact, isSheet, kindLabel } from './artifacts.js';

const props = defineProps({ msg: { type: Object, required: true } });
const m = computed(() => props.msg);

const status = computed(() => String(m.value.status || '').toLowerCase());
const failed = computed(() => ['error', 'failed', 'cancelled', 'canceled'].includes(status.value));
const done = computed(() => ['done', 'success', 'succeeded', 'completed', 'complete', 'ok'].includes(status.value));
const stopped = computed(() => !!m.value.stopped || status.value === 'aborted');
const running = computed(() => !failed.value && !done.value && !stopped.value);

const label = computed(() => {
    if (failed.value) return '已失败';
    if (running.value) return '执行中';
    if (stopped.value) return '已停止等待';
    return '已完成';
});
const iconKey = computed(() => {
    const c = agentById(m.value.capability_id);
    const k = String((c && c.icon) || '').trim();
    return ICONS[k] ? k : '';
});
const charIcon = computed(() => {
    const c = agentById(m.value.capability_id);
    const k = String((c && c.icon) || '').trim();
    return k && !ICONS[k] && k.length <= 2 ? k : '';
});
const title = computed(() => m.value.capability_name || (agentById(m.value.capability_id) || {}).name || '能力运行');
const steps = computed(() => (Array.isArray(m.value.steps) ? m.value.steps : []).filter(s => s && (s.tool || s.summary)));
const artifacts = computed(() => (Array.isArray(m.value.artifacts) ? m.value.artifacts : []));
function stepClass(s) {
    const k = String((s && s.status) || '').toLowerCase();
    if (k === 'error' || k === 'failed') return 'bad';
    if (k === 'done' || k === 'success' || k === 'succeeded' || k === 'ok') return 'ok';
    if (k === 'running') return 'run';
    return 'wait';
}
</script>

<template>
    <section class="cr" :data-run-id="m.run_id || ''" :data-status="status">
        <header class="ch">
            <span class="ic">
                <ChIcon v-if="iconKey" :name="iconKey" />
                <em v-else-if="charIcon">{{ charIcon }}</em>
                <ChIcon v-else name="sparkles" />
            </span>
            <span class="tt">
                <b>{{ title }}</b>
                <em>{{ steps.length ? steps.length + ' 个步骤' : '能力运行' }}</em>
            </span>
            <span class="st" :class="{ bad: failed, run: running, stop: stopped }">
                <span v-if="running" class="spin"></span>
                <span v-else class="dot"></span>
                {{ label }}
            </span>
        </header>

        <div v-if="!steps.length" class="wait-line">
            <span v-if="running" class="shine">正在执行，请稍候…</span>
            <span v-else-if="failed" class="bad">{{ m.error || '运行失败' }}</span>
            <span v-else>没有可展示的步骤</span>
        </div>
        <ol v-else class="steps">
            <li v-for="(s, i) in steps" :key="(s.index == null ? i : s.index) + '-' + (s.tool || '')" :class="stepClass(s)">
                <span class="sd"></span>
                <span class="sx">
                    <b v-if="s.tool">{{ s.tool }}</b>
                    <em v-if="s.summary">{{ s.summary }}</em>
                </span>
            </li>
        </ol>

        <p v-if="failed && steps.length && m.error" class="err">{{ m.error }}</p>
        <p v-else-if="stopped && !done" class="note">{{ m.error || '已停止等待，任务在服务端继续运行。' }}</p>

        <div v-if="artifacts.length" class="arts">
            <button v-for="a in artifacts" :key="a.url" type="button" class="art" :title="a.name" @click="openArtifact(a)">
                <span class="ai"><ChIcon :name="isSheet(a) ? 'table' : 'doc'" /></span>
                <span class="at">
                    <b>{{ a.name }}</b>
                    <em>{{ kindLabel(a) }} · {{ isSheet(a) ? '点击下载' : '新窗口打开' }}</em>
                </span>
                <span class="aa"><ChIcon :name="isSheet(a) ? 'download' : 'ext'" /></span>
            </button>
        </div>

        <MdView v-if="m.content && done" :text="m.content" />
    </section>
</template>

<style scoped>
.cr { align-self: flex-start; width: 100%; max-width: min(600px, 100%); padding: 14px 16px; border-radius: 16px; display: flex; flex-direction: column; gap: 12px;
    background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-rim), var(--shadow-float); }
.ch { display: flex; align-items: center; gap: 10px; }
.ch .ic { flex: none; width: 30px; height: 30px; border-radius: 9px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; }
.ch .ic .nv-i { width: 15px; height: 15px; }
.ch .ic em { font-style: normal; font: 500 14px/1 var(--font-sans); }
.ch .tt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ch .tt b { font: 500 13.5px/18px var(--font-sans); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch .tt em { font-style: normal; font: 400 10.5px/1 var(--font-mono); letter-spacing: .02em; color: var(--ink-4); }
.ch .st { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; background: var(--fill-1); color: var(--ink-2); font: 500 11.5px/1 var(--font-sans); }
.ch .st .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.ch .st.run { background: var(--fill-2); color: var(--ink); }
.ch .st.bad { background: var(--danger-fill); color: var(--danger); }
.ch .st.stop { color: var(--ink-3); }
.ch .st .spin { width: 11px; height: 11px; }
.wait-line { font: 400 12.5px/18px var(--font-sans); color: var(--ink-3); }
.wait-line .bad { color: var(--danger); }
.shine { background: linear-gradient(90deg, var(--ink-3) 0%, var(--ink) 45%, var(--ink-3) 90%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: cr-shine 1.8s linear infinite; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.steps li { display: flex; gap: 10px; align-items: flex-start; }
.steps .sd { flex: none; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%; background: var(--ink-4); }
.steps li.run .sd { background: var(--ink); animation: cr-pulse 1.1s var(--ease-in-out) infinite; }
.steps li.ok .sd { background: var(--ink-2); }
.steps li.bad .sd { background: var(--danger); }
.steps .sx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.steps .sx b { font: 400 11.5px/15px var(--font-mono); letter-spacing: .01em; color: var(--ink-3); }
.steps .sx em { font-style: normal; font: 400 12.5px/18px var(--font-sans); color: var(--ink-2); overflow-wrap: anywhere; }
.steps li.bad .sx em { color: var(--danger); }
.err { margin: 0; padding: 9px 12px; border-radius: 10px; background: var(--danger-fill); color: var(--danger); font: 400 12px/18px var(--font-sans); }
.note { margin: 0; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.arts { display: flex; flex-direction: column; gap: 6px; }
.art { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border: 0; border-radius: 12px; background: var(--fill-1); color: var(--ink); text-align: left; cursor: pointer; transition: background var(--duration-fast); }
.art:hover { background: var(--fill-2); }
.art .ai { flex: none; width: 32px; height: 32px; border-radius: 10px; background: var(--solid); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; box-shadow: var(--shadow-float); }
.art .ai .nv-i { width: 15px; height: 15px; }
.art .at { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.art .at b { font: 500 12.5px/17px var(--font-sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.art .at em { font-style: normal; font: 400 10.5px/14px var(--font-mono); color: var(--ink-4); }
.art .aa { flex: none; color: var(--ink-4); }
.art .aa .nv-i { width: 15px; height: 15px; }
@keyframes cr-shine { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@keyframes cr-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .shine, .steps li.run .sd { animation: none; } }
</style>
