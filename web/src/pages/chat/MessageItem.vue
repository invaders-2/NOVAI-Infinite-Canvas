<script setup>
// 一条消息。用户：能力 chip（挂了智能体 / 技能时）+ 附件（图片缩略 / 文件卡片）+ 深色气泡 + 时间。
// 助手：能力运行消息（type:'capability' → 状态 / 步骤 / 产物）或 思考块 → Markdown 正文 → 生成图网格 →
//       徽标行（模型短名 · 图片实际像素 · 时间 · 复制 / 重新生成）。
import { ref, computed, watch } from 'vue';
import ChIcon from './ChIcon.vue';
import MdView from './MdView.vue';
import ThoughtBlock from './ThoughtBlock.vue';
import CapabilityRun from './agents/CapabilityRun.vue';
import { C, isImageRef, attachmentName, imageUrlsOf, regenerate, thoughtDurations } from './session.js';
import { agentById } from './agents/capState.js';
import { ICONS } from '../../lib/icons.js';
import { thoughtTraceEntries } from './thought.js';
import { copyText } from './copy.js';
import { t, toast } from '../../lib/store.js';

const props = defineProps({ msg: { type: Object, required: true }, time: { type: String, default: '' } });
const emit = defineEmits(['preview']);
const m = computed(() => props.msg);
const isUser = computed(() => m.value.role === 'user');
const images = computed(() => imageUrlsOf(m.value));
const body = computed(() => (m.value.type === 'image' ? (m.value.agent_reply || t('chat.generated', '生成完成')) : (m.value.content || '')));
const isCap = computed(() => m.value.type === 'capability');
const capName = computed(() => {
    if (m.value.capability_name) return m.value.capability_name;
    const known = (agentById(m.value.capability_id) || {}).name;
    if (known) return known;
    const type = m.value.capability && m.value.capability.type;
    return type === 'generate-image' ? 'AI生图' : (m.value.capability_id || '能力');
});
const capIcon = computed(() => {
    const c = agentById(m.value.capability_id);
    const k = String((c && c.icon) || '').trim();
    if (ICONS[k]) return k;
    if (m.value.capability && m.value.capability.type === 'generate-image') return 'image';
    return 'sparkles';
});

const thought = computed(() => {
    if (m.value.thought) return m.value.thought;
    if (!m.value.reasoning) return null;
    const ds = thoughtDurations.get(m.value.id);
    return { live: false, settled: true, open: false, entries: thoughtTraceEntries(m.value.reasoning), tenths: ds === undefined ? null : ds };
});
const modelShort = computed(() => (m.value.model ? String(m.value.model).split('/').pop().split(':')[0] : ''));

// 生成图的实际像素（部分上游不按请求分辨率出图，这里标真实尺寸）
const dims = ref('');
watch(images, list => {
    dims.value = '';
    if (!list.length || !m.value.model || typeof Image === 'undefined') return;
    const probe = new Image();
    probe.onload = () => { dims.value = `${probe.naturalWidth}×${probe.naturalHeight}`; };
    probe.src = list[0];
}, { immediate: true });

async function copy() {
    const text = body.value || images.value.join('\n');
    const ok = await copyText(text);
    toast(ok ? '已复制' : '复制失败', { icon: ok ? 'check' : 'alert', danger: !ok });
}
const showFoot = computed(() => !isUser.value && !m.value.live);
</script>

<template>
    <div class="row" :class="isUser ? 'u' : 'a'">
        <template v-if="isUser">
            <span v-if="m.capability_id || m.capability_name || m.capability" class="ucap">
                <ChIcon :name="capIcon" />
                <span>{{ capName }}</span>
            </span>
            <div v-if="m.attachments && m.attachments.length" class="att">
                <template v-for="(r, i) in m.attachments" :key="i">
                    <img v-if="isImageRef(r)" class="im" :src="r.url" :title="attachmentName(r)" alt="" @click="emit('preview', r.url)" />
                    <span v-else class="fl" :title="attachmentName(r)"><ChIcon name="file" /><span>{{ attachmentName(r) }}</span></span>
                </template>
            </div>
            <div class="bu">{{ m.content }}</div>
            <span class="tm">{{ time }}</span>
        </template>
        <template v-else>
            <CapabilityRun v-if="isCap" :msg="m" />
            <template v-else>
                <ThoughtBlock v-if="thought" :thought="thought" />
                <div v-if="m.pending" class="pend">{{ body }}</div>
                <div v-else-if="m.error" class="err">{{ body }}</div>
                <MdView v-else-if="body" :text="body" />
            </template>
            <div v-if="images.length" class="gen" :class="'n' + Math.min(images.length, 4)">
                <button v-for="(u, i) in images" :key="u + i" type="button" class="gi" @click="emit('preview', u)">
                    <img :src="u" alt="" loading="lazy" />
                    <span class="zm"><ChIcon name="maximize" /></span>
                </button>
            </div>
            <div v-if="showFoot" class="mb">
                <template v-if="modelShort"><span>{{ modelShort }}<template v-if="dims"> · {{ dims }}</template></span><span class="sep"></span></template>
                <span>{{ time }}</span>
                <span v-if="m.stopped" class="stopped">已停止</span>
                <span class="acts">
                    <button type="button" class="ib" title="复制" aria-label="复制" @click="copy"><ChIcon name="copy" /></button>
                    <button v-if="!isCap" type="button" class="ib" title="重新生成" aria-label="重新生成" :disabled="C.busy" @click="regenerate(m)"><ChIcon name="refresh" /></button>
                </span>
            </div>
        </template>
    </div>
</template>

<style scoped>
.row { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.row.u { align-items: flex-end; }
.bu { max-width: min(540px, 86%); padding: 10px 14px; border-radius: 18px 18px 6px 18px; background: var(--accent); color: var(--on-accent); font: 400 13.5px/22px var(--font-sans); white-space: pre-wrap; overflow-wrap: anywhere; }
.tm { font: 400 10.5px/1 var(--font-mono); color: var(--ink-4); letter-spacing: .03em; }
.ucap { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--fill-1); color: var(--ink-2); font: 500 11.5px/1 var(--font-sans); }
.ucap .nv-i { width: 13px; height: 13px; }
.att { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: min(540px, 86%); }
.att .im { width: 56px; height: 56px; border-radius: 10px; object-fit: cover; cursor: zoom-in; background: var(--fill-1); transition: transform var(--duration-base) var(--ease-out); }
.att .im:hover { transform: translateY(-1px); }
.att .fl { max-width: 220px; height: 56px; padding: 0 14px 0 12px; border-radius: 10px; background: var(--fill-1); display: inline-flex; align-items: center; gap: 10px; font: 400 12px/16px var(--font-sans); color: var(--ink-2); }
.att .fl span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att .fl .nv-i { width: 18px; height: 18px; color: var(--ink-3); flex: none; }
.pend { font: 400 13.5px/23px var(--font-sans); background: linear-gradient(90deg, var(--ink-3) 0%, var(--ink) 45%, var(--ink-3) 90%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: mi-shine 1.8s linear infinite; align-self: flex-start; }
.err { align-self: flex-start; padding: 10px 14px; border-radius: 12px; background: var(--danger-fill); color: var(--danger); font: 400 13px/21px var(--font-sans); white-space: pre-wrap; overflow-wrap: anywhere; }
.gen { display: grid; grid-template-columns: repeat(2, minmax(0, 240px)); gap: 8px; }
.gen.n1 { grid-template-columns: minmax(0, 360px); }
.gen.n3 { grid-template-columns: repeat(3, minmax(0, 200px)); }
.gi { position: relative; padding: 0; border: 0; border-radius: 12px; overflow: hidden; background: var(--fill-1); cursor: zoom-in; display: block; }
.gi img { display: block; width: 100%; height: auto; max-height: 420px; object-fit: cover; transition: transform 500ms var(--ease-out); }
.gi:hover img { transform: scale(1.02); }
.zm { position: absolute; left: 8px; top: 8px; width: 26px; height: 26px; border-radius: 99px; background: rgba(10,10,10,.42); color: #fff; display: inline-flex; align-items: center; justify-content: center;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); opacity: 0; transition: opacity var(--duration-fast); }
.zm .nv-i { width: 13px; height: 13px; }
.gi:hover .zm, .gi:focus-visible .zm { opacity: 1; }
.mb { display: flex; align-items: center; gap: 8px; min-height: 24px; font: 400 11px/1 var(--font-mono); letter-spacing: .06em; color: var(--ink-4); text-transform: uppercase; }
.mb .sep { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-4); }
.stopped { padding: 3px 6px; border-radius: 5px; background: var(--fill-1); color: var(--ink-3); text-transform: none; letter-spacing: 0; font-family: var(--font-sans); }
.acts { display: flex; gap: 2px; margin-left: 4px; }
.ib { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--ink-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background var(--duration-fast), color var(--duration-fast); }
.ib:hover:not(:disabled) { background: var(--fill-1); color: var(--ink); }
.ib:disabled { color: var(--ink-4); cursor: default; }
.ib .nv-i { width: 13px; height: 13px; }
@keyframes mi-shine { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .pend { animation: none; } }
</style>
