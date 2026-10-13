<script setup>
// 编辑器左侧「画布节点效果预览」：按已勾选字段渲染控件，可上传素材、填参数并提交一次真实测试任务
import { reactive, computed } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import NvSwitch from '../../../../components/NvSwitch.vue';
import ExtIcon from '../kit/ExtIcon.vue';
import KSelect from '../kit/KSelect.vue';
import { toast } from '../../../../lib/store.js';
import { rhEditorSortedFields, rhWorkflowFieldKind, rhWorkflowFieldKey, rhPreviewRandomValue, mediaAcceptForRhKind, pickFile, outputKind } from './rh-utils.js';

const props = defineProps({ config: Object, mode: String });
const emit = defineEmits(['mode']);

const st = reactive({ params: {}, running: false, status: '', outputs: [] });
const MEDIA = ['IMAGE', 'VIDEO', 'AUDIO'];
const enabledFields = computed(() => rhEditorSortedFields(((props.config && props.config.fields) || []).filter(f => f.enabled === true)));
const counts = computed(() => enabledFields.value.reduce((acc, f) => {
    const k = rhWorkflowFieldKind(f);
    if (k === 'IMAGE') acc.image += 1; else if (k === 'VIDEO') acc.video += 1; else if (k === 'AUDIO') acc.audio += 1; else acc.setting += 1;
    return acc;
}, { image: 0, video: 0, audio: 0, setting: 0 }));
const title = computed(() => (props.config && props.config.title) || (props.mode === 'app' ? 'RunningHub AI 应用' : 'RunningHub 工作流'));
const sub = computed(() => (props.mode === 'app' ? `/run/ai-app/${props.config.appId || ''}` : `/run/workflow/${props.config.workflowId || ''}`));
const OPTIONAL_MODES = [{ value: 'prune-workflow', label: '裁剪 workflow JSON' }, { value: 'skip', label: '不提交字段' }];

const rows = computed(() => enabledFields.value.map(field => {
    const key = rhWorkflowFieldKey(field);
    const kind = rhWorkflowFieldKind(field);
    const ps = st.params[key] || {};
    const value = ps.value ?? field.fieldValue ?? '';
    const options = Array.isArray(field.options) ? field.options : [];
    let ctl = 'text';
    if (field.sourceFromUpstream === false && !MEDIA.includes(kind)) ctl = 'keep';
    else if (MEDIA.includes(kind)) ctl = 'media';
    else if (kind === 'BOOLEAN') ctl = 'bool';
    else if (kind === 'SLIDER') ctl = 'slider';
    else if (options.length || kind === 'SELECT') ctl = 'select';
    const row = { key, kind, field, ps, value, ctl, label: field.label || field.fieldName };
    if (ctl === 'media') {
        row.slot = props.mode === 'workflow' && kind === 'IMAGE' ? `图 ${Number(field.imageOrder) || 1} · ${field.required === true ? '必选' : '可选'}` : '';
        row.icon = kind === 'VIDEO' ? 'video' : kind === 'AUDIO' ? 'music' : 'image';
    } else if (ctl === 'bool') {
        row.on = String(value).toLowerCase() === 'true';
    } else if (ctl === 'slider') {
        const min = Number.isFinite(Number(field.min)) ? Number(field.min) : 0;
        const max = Number.isFinite(Number(field.max)) && Number(field.max) > min ? Number(field.max) : 1;
        const step = Number.isFinite(Number(field.step)) && Number(field.step) > 0 ? Number(field.step) : 0.01;
        Object.assign(row, { min, max, step, num: Number.isFinite(Number(value)) ? Number(value) : min });
    } else if (ctl === 'select') {
        row.options = (options.length ? options : [value || '选项']).map(String);
    } else if (ctl === 'text') {
        row.randomBtn = kind === 'NUMBER' && field.random_enabled;
        row.randomActive = field.random_enabled === true && ps.randomActive !== false;
        row.numeric = kind === 'NUMBER';
    }
    return row;
}));

function setParam(key, patch) { st.params[key] = { ...(st.params[key] || {}), ...patch }; }
function updateValue(key, value) { setParam(key, { value, randomActive: false }); }
function toggleRandom(row) { setParam(row.key, { value: row.ps.value ?? row.field.fieldValue ?? '', randomActive: row.ps.randomActive === false }); }

async function pickMedia(row) {
    const file = await pickFile(mediaAcceptForRhKind(row.kind));
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    setParam(row.key, { url: localUrl, name: file.name, uploading: true });
    const form = new FormData();
    form.append('files', file);
    try {
        const r = await fetch('/api/ai/upload', { method: 'POST', body: form });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json.detail || '上传失败');
        const up = (json.files && json.files[0]) || {};
        setParam(row.key, { url: up.url || localUrl, name: up.name || file.name, kind: up.kind || row.kind.toLowerCase(), uploading: false });
    } catch (err) {
        setParam(row.key, { uploading: false });
        toast(err.message || '上传失败', { danger: true, icon: 'alert' });
    }
}

async function uploadValueIfNeeded(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text) && !text.startsWith('/output/') && !text.startsWith('/assets/')) return text;
    const res = await fetch('/api/runninghub/upload-asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: text }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.detail || data.error || 'RunningHub 素材上传失败');
    return (data.data && data.data.fileName) || text;
}
async function buildNodeInfoList() {
    const fields = enabledFields.value;
    const imageFields = fields.filter(f => rhWorkflowFieldKind(f) === 'IMAGE');
    const slotPreview = {}, indexPreview = {};
    imageFields.forEach((f, index) => {
        const pv = st.params[rhWorkflowFieldKey(f)] || {};
        const slot = Number(f.imageOrder) || 1;
        if ((pv.url || pv.value) && !slotPreview[slot]) slotPreview[slot] = pv;
        if ((pv.url || pv.value) && !indexPreview[index]) indexPreview[index] = pv;
    });
    const result = [];
    for (const field of fields) {
        const key = rhWorkflowFieldKey(field);
        const kind = rhWorkflowFieldKind(field);
        if (field.sourceFromUpstream === false && !MEDIA.includes(kind)) continue;
        const own = st.params[key] || {};
        const imageIndex = kind === 'IMAGE' ? imageFields.findIndex(f => rhWorkflowFieldKey(f) === key) : -1;
        const pv = kind === 'IMAGE' ? (own.url || own.value ? own : (slotPreview[Number(field.imageOrder) || 1] || indexPreview[imageIndex] || own)) : own;
        let value = pv.value ?? field.fieldValue ?? '';
        if (MEDIA.includes(kind)) {
            if (props.mode === 'workflow' && kind === 'IMAGE' && field.required !== true && !pv.url) continue;
            if (props.mode === 'workflow' && kind === 'IMAGE' && field.required === true && !pv.url && !value) throw new Error(`缺少必选图片：${field.label || field.fieldName}`);
            value = await uploadValueIfNeeded(pv.url || value);
        } else if (kind === 'NUMBER' && field.random_enabled === true && pv.randomActive !== false) {
            value = rhPreviewRandomValue(field);
        } else if (['NUMBER', 'SLIDER'].includes(kind) && String(value ?? '').trim() !== '' && !Number.isNaN(Number(value))) {
            value = Number(value);
        }
        // TEXT 自由文本保留换行；其它单值字段取第一行
        if (typeof value === 'string' && kind !== 'TEXT' && /[\r\n]/.test(value)) value = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
        result.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: value });
    }
    return result;
}
function pruneWorkflow(nodeInfoList) {
    const config = props.config;
    if (props.mode !== 'workflow' || (config.optionalImageMode || 'prune-workflow') !== 'prune-workflow') return null;
    const submitted = new Set((nodeInfoList || []).map(item => rhWorkflowFieldKey(item)));
    const missing = rhEditorSortedFields(config.fields || []).filter(f => f.enabled === true && rhWorkflowFieldKind(f) === 'IMAGE' && f.required !== true && !submitted.has(rhWorkflowFieldKey(f)));
    if (!missing.length || !config.workflowJson) return null;
    const workflow = JSON.parse(JSON.stringify(config.workflowJson));
    const removeIds = new Set();
    missing.forEach(f => {
        const node = workflow[String(f.nodeId)];
        if (node && node.inputs && Object.prototype.hasOwnProperty.call(node.inputs, f.fieldName)) delete node.inputs[f.fieldName];
        if (node && node.inputs && !Object.keys(node.inputs).length) removeIds.add(String(f.nodeId));
    });
    removeIds.forEach(id => delete workflow[id]);
    Object.values(workflow).forEach(node => {
        Object.entries((node && node.inputs) || {}).forEach(([name, value]) => {
            if (Array.isArray(value) && removeIds.has(String(value[0]))) delete node.inputs[name];
        });
    });
    return workflow;
}
async function getData(url, opts, failText) {
    const r = await fetch(url, opts);
    const json = await r.json().catch(() => ({}));
    if (!r.ok || json.success === false) throw new Error(json.detail || json.error || failText);
    return json.data || json;
}
async function runTest() {
    const config = props.config;
    if (!config || st.running) return;
    st.running = true;
    st.status = '正在提交 RunningHub 任务...';
    st.outputs = [];
    try {
        const nodeInfoList = await buildNodeInfoList();
        const workflow = pruneWorkflow(nodeInfoList);
        const isWf = props.mode === 'workflow';
        const body = isWf
            ? { workflowId: String(config.workflowId || '').trim(), nodeInfoList, ...(workflow ? { workflow } : {}) }
            : { webappId: String(config.appId || '').trim(), nodeInfoList };
        if (isWf && !body.workflowId) throw new Error('workflowId 为空');
        if (!isWf && !body.webappId) throw new Error('webappId 为空');
        const submit = await getData(isWf ? '/api/runninghub/workflow-submit' : '/api/runninghub/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'RunningHub 提交失败');
        const taskId = submit.taskId;
        if (!taskId) throw new Error('RunningHub 没有返回 taskId');
        st.status = `任务已提交：${taskId}`;
        let result = null;
        for (let i = 0; i < 720; i++) {
            await new Promise(resolve => setTimeout(resolve, 2500));
            const data = await getData(`/api/runninghub/query?taskId=${encodeURIComponent(taskId)}`, undefined, 'RunningHub 查询失败');
            if (data.status === 'SUCCESS') { result = data; break; }
            if (data.status === 'FAILED') throw new Error(data.failReason || 'RunningHub 任务失败');
            st.status = data.status === 'QUEUED' ? '排队中...' : '运行中...';
        }
        if (!result) throw new Error('RunningHub 任务超时');
        const outputs = result.urls || [];
        if (!outputs.length) throw new Error('RunningHub 没有返回产物');
        st.outputs = outputs;
        st.status = '测试完成';
        toast('RunningHub 测试完成', { icon: 'check' });
    } catch (err) {
        st.status = (err && err.message) || String(err);
        toast(st.status, { danger: true, icon: 'alert' });
    } finally {
        st.running = false;
    }
}
</script>

<template>
    <div class="pv">
        <div class="pv-h">
            <span class="pv-ic"><NvIcon :name="mode === 'app' ? 'sparkles' : 'workflow'" /></span>
            <div class="pv-t"><b>{{ title }}</b><span>{{ sub }}</span></div>
        </div>
        <div class="pv-stats">
            <span>图片 {{ counts.image }}</span><span>视频 {{ counts.video }}</span><span>音频 {{ counts.audio }}</span><span>参数 {{ counts.setting }}</span>
        </div>
        <div v-if="!rows.length" class="pv-empty">勾选右侧参数后，这里会显示画布节点上的效果</div>
        <div v-else class="pv-fields">
            <div v-for="r in rows" :key="r.key" class="pf" :class="{ wide: r.ctl !== 'media' }">
                <div class="pf-l"><span>{{ r.label }}</span><em v-if="r.slot">{{ r.slot }}</em><em v-if="r.ctl === 'slider'" class="num">{{ r.num }}</em></div>
                <div v-if="r.ctl === 'keep'" class="pf-keep"><ExtIcon name="lock" />保留工作流原设置</div>
                <button v-else-if="r.ctl === 'media'" type="button" class="pf-media" :class="{ has: r.ps.url }" @click="pickMedia(r)">
                    <template v-if="r.ps.url">
                        <video v-if="r.kind === 'VIDEO'" :src="r.ps.url" muted preload="metadata" playsinline controls></video>
                        <span v-else-if="r.kind === 'AUDIO'" class="pf-audio"><NvIcon name="music" />{{ r.ps.name || r.value || '音频' }}<audio :src="r.ps.url" controls preload="metadata"></audio></span>
                        <img v-else :src="r.ps.url" alt="">
                        <span v-if="r.ps.uploading" class="pf-up"><span class="spin sm"></span></span>
                    </template>
                    <template v-else><NvIcon name="upload" />点击上传</template>
                </button>
                <NvSwitch v-else-if="r.ctl === 'bool'" :model-value="r.on" disabled :label="r.label" />
                <input v-else-if="r.ctl === 'slider'" class="pf-slider" type="range" :min="r.min" :max="r.max" :step="r.step" :value="r.num" @input="updateValue(r.key, $event.target.value)">
                <KSelect v-else-if="r.ctl === 'select'" class="pf-sel" size="sm" :model-value="r.options[0]" :options="r.options" disabled :label="r.label" />
                <div v-else class="pf-num" :class="{ two: r.randomBtn }">
                    <input class="pf-inp" :type="r.numeric ? 'number' : 'text'" :value="r.value" :disabled="r.randomActive" :placeholder="r.numeric && r.randomActive ? '随机数' : ''" @input="updateValue(r.key, $event.target.value)">
                    <button v-if="r.randomBtn" type="button" class="pf-dice" :class="{ on: r.randomActive }" :title="r.randomActive ? '使用随机数' : '使用固定数'" :aria-label="r.randomActive ? '使用随机数' : '使用固定数'" @click="toggleRandom(r)"><NvIcon name="dice" /></button>
                </div>
            </div>
        </div>
        <div v-if="mode === 'workflow'" class="pv-mode">
            <span>空可选图</span>
            <KSelect class="pf-sel" size="sm" :model-value="config.optionalImageMode || 'prune-workflow'" :options="OPTIONAL_MODES" label="空可选图" @update:model-value="emit('mode', $event || 'prune-workflow')" />
            <small>仅工作流生效。可选图片为空时，裁剪模式会移除该图片输入及相关连接。</small>
        </div>
        <button type="button" class="pv-run" :disabled="st.running" @click="runTest">
            <span v-if="st.running" class="spin sm"></span><NvIcon v-else name="play" />{{ st.running ? '测试中...' : '测试' }}
        </button>
        <div v-if="st.status" class="pv-status">{{ st.status }}</div>
        <div v-if="st.outputs.length" class="pv-out">
            <template v-for="u in st.outputs" :key="u">
                <video v-if="outputKind(u) === 'video'" :src="u" controls muted playsinline preload="metadata"></video>
                <audio v-else-if="outputKind(u) === 'audio'" :src="u" controls preload="metadata"></audio>
                <img v-else :src="u" alt="">
            </template>
        </div>
    </div>
</template>

<style scoped>
.pv { border-radius: 14px; background: var(--fill-1); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.pv-h { display: flex; align-items: center; gap: 10px; }
.pv-ic { width: 30px; height: 30px; border-radius: 9px; background: var(--solid); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); flex: none; }
.pv-ic .nv-i { width: 14px; height: 14px; }
.pv-t { min-width: 0; }
.pv-t b { display: block; font: 500 12.5px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-t span { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-stats { display: flex; gap: 4px; flex-wrap: wrap; }
.pv-stats span { height: 20px; padding: 0 7px; border-radius: 6px; background: var(--solid); font: 400 10.5px/20px var(--font-sans); color: var(--ink-2); }
.pv-empty { padding: 14px 10px; border-radius: 10px; background: var(--solid); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
.pv-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 8px; }
.pf.wide { grid-column: 1 / -1; }
.pf { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pf-l { display: flex; align-items: baseline; gap: 6px; font: 400 11px/14px var(--font-sans); color: var(--ink-2); min-width: 0; }
.pf-l span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-l em { font-style: normal; font-size: 11px; color: var(--ink-4); white-space: nowrap; }
.pf-l em.num { margin-left: auto; font-family: var(--font-mono); color: var(--ink-3); }
.pf-keep { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: 8px; background: var(--solid); font: 400 11px/1 var(--font-sans); color: var(--ink-3); }
.pf-keep .nv-i { width: 12px; height: 12px; }
.pf-media { position: relative; height: 64px; border: 0; padding: 0; border-radius: 9px; background: var(--solid); display: flex; align-items: center; justify-content: center; gap: 6px; font: 400 11px/1 var(--font-sans); color: var(--ink-3); cursor: pointer; overflow: hidden; transition: background var(--duration-fast); }
.pf-media:hover { background: var(--fill-2); }
.pf-media .nv-i { width: 14px; height: 14px; }
.pf-media img, .pf-media video { width: 100%; height: 100%; object-fit: cover; display: block; }
.pf-audio { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px; width: 100%; overflow: hidden; }
.pf-audio audio { width: 100%; height: 24px; }
.pf-up { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.pf-slider { width: 100%; accent-color: var(--accent); }
.pf :deep(.pf-sel) { width: 100%; background: var(--solid); }
.pf-num { display: grid; grid-template-columns: 1fr; gap: 6px; }
.pf-num.two { grid-template-columns: 1fr 28px; }
.pf-inp { height: 28px; min-width: 0; border: 0; outline: 0; border-radius: 8px; padding: 0 8px; background: var(--solid); color: var(--ink); font: 400 12px/1 var(--font-mono); }
.pf-inp:disabled { color: var(--ink-4); }
.pf-inp:focus { background: var(--fill-2); box-shadow: none; }
.pf-dice { width: 28px; height: 28px; border: 0; border-radius: 8px; background: var(--solid); color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.pf-dice.on { background: var(--accent); color: var(--on-accent); }
.pf-dice .nv-i { width: 14px; height: 14px; }
.pv-mode { display: flex; flex-direction: column; gap: 5px; font: 400 11px/14px var(--font-sans); color: var(--ink-2); }
.pv-mode :deep(.pf-sel) { width: 100%; background: var(--solid); }
.pv-mode small { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.pv-run { height: 34px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; gap: 6px; font: 500 12.5px/1 var(--font-sans); cursor: pointer; transition: transform var(--duration-instant), box-shadow var(--duration-fast); }
.pv-run:hover:not(:disabled) { box-shadow: var(--shadow-lift); }
.pv-run:active:not(:disabled) { transform: scale(.98); }
.pv-run:disabled { opacity: .7; cursor: default; }
.pv-run .nv-i { width: 13px; height: 13px; }
.pv-status { font: 400 11.5px/17px var(--font-sans); color: var(--ink-2); overflow-wrap: anywhere; }
.pv-out { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.pv-out img, .pv-out video { width: 100%; border-radius: 8px; display: block; background: var(--solid); }
.pv-out audio { grid-column: 1 / -1; width: 100%; }
.spin.sm { width: 12px; height: 12px; }
</style>
