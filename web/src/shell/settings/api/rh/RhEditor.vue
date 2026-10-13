<script setup>
// RunningHub 工作流 / AI 应用编辑器（旧 #rhWorkflowEditorOverlay）：
// 左：名称、备注、统计、画布节点效果预览 + 测试；右：工作流节点图（点节点弹出字段）或 AI 应用参数卡片（点卡片弹出字段）
import { ref, computed, watch, nextTick } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import ExtIcon from '../kit/ExtIcon.vue';
import ApiDialog from '../kit/ApiDialog.vue';
import RhGraph from './RhGraph.vue';
import RhPreview from './RhPreview.vue';
import RhFieldEditor from './RhFieldEditor.vue';
import { toast } from '../../../../lib/store.js';
import { broadcastStudioApiChange } from '../kit/kit.js';
import { rhWorkflowFieldKey, rhWorkflowFieldKind, normalizeRhWorkflowField, normalizeFetchedRhWorkflowField, normalizeRhWorkflowConfig, normalizeRhAppConfig, applyRhImageSlotDefaults, rhAppFieldSourceList, normalizeFetchedRhAppField } from './rh-utils.js';

const props = defineProps({
    open: Boolean,
    mode: { type: String, default: 'workflow' },   // 'workflow' | 'app'
    entry: Object,
    commit: Function,                             // (mode, entryId, patch) => Promise<boolean>：把结果写回 provider 并保存平台
});
const emit = defineEmits(['close']);

const config = ref(null);
const loadingText = ref('');
const name = ref('');
const note = ref('');
const activeNodeId = ref('');
const popKey = ref('');          // app 模式：当前弹出的字段 key
const saveState = ref('idle');   // idle | saving | saved
const session = ref(0);
const graph = ref(null);
const isApp = computed(() => props.mode === 'app');
const entryId = computed(() => String((props.entry && (isApp.value ? (props.entry.appId || props.entry.id) : (props.entry.workflowId || props.entry.id))) || '').trim());
const headTitle = computed(() => (config.value && config.value.title) || (props.entry && props.entry.title) || (isApp.value ? 'RunningHub AI 应用' : 'RunningHub 工作流'));
const headSub = computed(() => (isApp.value ? `/run/ai-app/${entryId.value}` : `/run/workflow/${entryId.value}`));

const summary = computed(() => {
    const c = config.value;
    if (!c) return null;
    const fields = c.fields || [];
    const images = fields.filter(f => f.enabled === true && rhWorkflowFieldKind(f) === 'IMAGE');
    return {
        nodes: isApp.value ? 1 : Object.keys(c.workflowJson || {}).length,
        enabled: fields.filter(f => f.enabled === true).length,
        total: fields.length,
        optional: images.filter(f => f.required !== true).length,
        images: images.length,
    };
});
const nodeFields = computed(() => (config.value && activeNodeId.value ? (config.value.fields || []).filter(f => String(f.nodeId) === activeNodeId.value) : []));
const nodeTitle = computed(() => {
    const id = activeNodeId.value;
    const node = (config.value && config.value.workflowJson && config.value.workflowJson[id]) || {};
    return ((node._meta && node._meta.title) || node.class_type || (nodeFields.value[0] && nodeFields.value[0].group) || `Node #${id}`).toString();
});
const popField = computed(() => (config.value && popKey.value ? (config.value.fields || []).find(f => rhWorkflowFieldKey(f) === popKey.value) : null));

function setConfig(c) {
    config.value = c;
    name.value = c.title || '';
    note.value = c.description || '';
    loadingText.value = '';
    nextTick(() => setTimeout(() => graph.value && graph.value.fit(), 50));
}
function showLoading(text) {
    loadingText.value = text;
    config.value = null;
}

async function fetchApp(force) {
    const entry = props.entry || {};
    const appId = String(entry.appId || entry.id || '').trim();
    if (!appId) throw new Error('appId 为空');
    if (force) showLoading('正在重新拉取...');
    const res = await fetch(`/api/runninghub/app-info?webappId=${encodeURIComponent(appId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.detail || '拉取应用参数失败');
    setConfig({
        appId,
        title: name.value.trim() || entry.title || `AI 应用 ${appId.slice(-6)}`,
        description: note.value.trim() || entry.note || '',
        fields: rhAppFieldSourceList(data).map(normalizeFetchedRhAppField),
        raw: data.data || data,
    });
}
async function fetchWorkflow(force) {
    const entry = props.entry || {};
    const workflowId = String(entry.workflowId || entry.id || '').trim();
    if (!workflowId) throw new Error('workflowId 为空');
    if (force) showLoading('正在重新拉取...');
    const res = await fetch('/api/runninghub/workflows/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId, title: name.value.trim() || entry.title || workflowId, description: note.value.trim() || entry.note || '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.detail || '拉取工作流失败');
    const d = data.data || {};
    setConfig(normalizeRhWorkflowConfig({
        workflowId: d.workflowId, title: d.title, description: d.description,
        fields: (d.fields || []).map(normalizeFetchedRhWorkflowField),
        workflowJson: d.workflowJson || {},
        optionalImageMode: entry.optionalImageMode || 'prune-workflow',
        raw: d.raw || {},
    }, entry));
}
async function refetch() {
    const s = session.value;
    try { await (isApp.value ? fetchApp(true) : fetchWorkflow(true)); }
    catch (e) { if (s === session.value) { loadingText.value = e.message || '拉取失败'; toast(loadingText.value, { danger: true, icon: 'alert' }); } }
}
async function load() {
    const s = ++session.value;
    const entry = props.entry || {};
    config.value = null;
    activeNodeId.value = isApp.value ? 'app' : '';
    popKey.value = '';
    saveState.value = 'idle';
    name.value = entry.title || '';
    note.value = entry.note || '';
    loadingText.value = isApp.value ? '正在加载应用参数...' : '正在加载工作流...';
    try {
        if (isApp.value) {
            const c = normalizeRhAppConfig(entry);
            if (!c.fields.length) await fetchApp(false); else setConfig(c);
            return;
        }
        if (!entryId.value) throw new Error('workflowId 为空');
        const r = await fetch(`/api/runninghub/workflows/${encodeURIComponent(entryId.value)}`);
        let existing = null;
        if (r.status !== 404) {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.detail || '读取工作流配置失败');
            existing = data.workflow || null;
        }
        if (s !== session.value) return;
        if (existing) setConfig(normalizeRhWorkflowConfig(existing, entry));
        else await fetchWorkflow(false);
    } catch (e) {
        if (s === session.value) loadingText.value = e.message || (isApp.value ? '应用参数加载失败' : '工作流加载失败');
    }
}
watch(() => props.open, v => { if (v) load(); else session.value++; }, { immediate: true });

function onName(v) { name.value = v; if (config.value) config.value.title = v; }
function onNote(v) { note.value = v; if (config.value) config.value.description = v; }
function toggleField(field) { field.enabled = field.enabled !== true; }
function updateField(field, prop, value) {
    field[prop] = prop === 'imageOrder' ? Math.max(1, Number(value) || 1) : prop === 'required' ? Boolean(value) : value;
    if (prop === 'fieldType' || prop === 'required' || prop === 'imageOrder') applyRhImageSlotDefaults(config.value);
}
function pickNode(id) {
    activeNodeId.value = id;
}
function closePop() { if (isApp.value) popKey.value = ''; else activeNodeId.value = ''; }

async function save() {
    const c = config.value;
    if (!c) { toast(isApp.value ? '请先加载应用参数' : '请先加载工作流', { danger: true, icon: 'alert' }); return; }
    saveState.value = 'saving';
    c.title = name.value.trim() || c.title || c.workflowId;
    c.description = note.value.trim() || c.description || '';
    try {
        if (isApp.value) {
            if (props.commit) await props.commit('app', entryId.value, {
                title: c.title || (props.entry && props.entry.title), note: c.description || '',
                fields: (c.fields || []).map(normalizeRhWorkflowField), raw: c.raw || {},
            });
            toast('应用参数配置已保存', { icon: 'check' });
            broadcastStudioApiChange('providers-changed');
        } else {
            const res = await fetch(`/api/runninghub/workflows/${encodeURIComponent(c.workflowId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workflowId: c.workflowId, title: c.title, description: c.description,
                    fields: (c.fields || []).map(normalizeRhWorkflowField),
                    workflowJson: c.workflowJson || {},
                    optionalImageMode: c.optionalImageMode || 'prune-workflow',
                    raw: c.raw || {},
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) throw new Error(data.detail || '保存失败');
            const next = normalizeRhWorkflowConfig(data.workflow || c, props.entry);
            config.value = next;
            if (props.commit) await props.commit('workflow', entryId.value, {
                title: next.title, note: next.description,
                fields: (next.fields || []).map(normalizeRhWorkflowField),
                workflowJson: next.workflowJson || {},
                optionalImageMode: next.optionalImageMode || 'prune-workflow',
                raw: next.raw || {},
                updatedAt: Number((data.workflow && data.workflow.updatedAt) || Date.now()),
            });
            toast('工作流配置已保存', { icon: 'check' });
            broadcastStudioApiChange('workflows-changed');
        }
        saveState.value = 'saved';
        setTimeout(() => { if (saveState.value === 'saved') saveState.value = 'idle'; }, 1600);
    } catch (err) {
        saveState.value = 'idle';
        toast((err && err.message) || '保存失败', { danger: true, icon: 'alert' });
    }
}
</script>

<template>
    <ApiDialog :open="open" width="min(1180px, calc(100vw - 32px))" height="min(780px, calc(100vh - 32px))" :label="headTitle" @close="emit('close')">
        <div class="ed-head">
            <div class="ed-t"><b>{{ headTitle }}</b><span>{{ headSub }}</span></div>
            <button type="button" class="nv-btn sm" @click="refetch"><NvIcon name="refresh" />重新拉取</button>
            <button type="button" class="nv-btn sm primary ed-save" :disabled="saveState === 'saving'" @click="save">
                <span v-if="saveState === 'saving'" class="spin sm"></span><NvIcon v-else :name="saveState === 'saved' ? 'check' : 'save'" />
                {{ saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中...' : '保存' }}
            </button>
            <button type="button" class="nv-icon-btn round" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
        </div>
        <div class="ed-body">
            <aside class="ed-side">
                <label class="ed-fld"><span>名称</span><input class="ed-inp" :value="name" @input="onName($event.target.value)"></label>
                <label class="ed-fld"><span>备注</span><textarea class="ed-inp ed-txa" rows="3" :value="note" @input="onNote($event.target.value)"></textarea></label>
                <div v-if="loadingText" class="ed-empty">{{ loadingText }}</div>
                <template v-else-if="summary">
                    <div class="ed-sum" :class="{ two: isApp }">
                        <div><span>{{ isApp ? '应用' : '节点' }}</span><strong>{{ summary.nodes }}</strong></div>
                        <div><span>字段</span><strong>{{ summary.enabled }} / {{ summary.total }}</strong></div>
                        <div v-if="!isApp"><span>可选图</span><strong>{{ summary.optional }} / {{ summary.images }}</strong></div>
                    </div>
                    <RhPreview :key="session + ':' + entryId" :config="config" :mode="mode" @mode="config.optionalImageMode = $event" />
                </template>
            </aside>
            <section class="ed-main">
                <div v-if="loadingText && !config" class="ed-pane ed-pane-empty"><span v-if="/^正在/.test(loadingText)" class="spin"></span>{{ loadingText }}</div>
                <RhGraph v-else-if="!isApp && config" ref="graph" :workflow="config.workflowJson" :fields="config.fields" :active-node-id="activeNodeId" @pick="pickNode" @blank="activeNodeId = ''">
                    <Transition name="pop">
                        <div v-if="nodeFields.length" :key="activeNodeId" class="ed-pop nv-glass-pop" @wheel.stop @mousedown.stop>
                            <div class="ed-poph">
                                <span class="ic"><ExtIcon name="sliders" /></span>
                                <div class="tx"><b>{{ nodeTitle }}</b><span>#{{ activeNodeId }} · {{ nodeFields.length }}</span></div>
                                <button type="button" class="nv-icon-btn sm round" aria-label="关闭" @click="closePop"><NvIcon name="x" /></button>
                            </div>
                            <div class="ed-popb">
                                <RhFieldEditor v-for="f in nodeFields" :key="f.nodeId + '::' + f.fieldName" :field="f" :mode="mode" @toggle="toggleField(f)" @update="(p, v) => updateField(f, p, v)" />
                            </div>
                        </div>
                    </Transition>
                </RhGraph>
                <div v-else-if="config" class="ed-pane ed-apps">
                    <div v-if="!(config.fields || []).length" class="ed-pane-empty">没有拉取到应用参数</div>
                    <div v-else class="ed-afl">
                        <div v-for="f in config.fields" :key="f.nodeId + '::' + f.fieldName" class="afc" :class="{ on: f.enabled === true, open: popKey === f.nodeId + '::' + f.fieldName }"
                             role="button" tabindex="0" @click="popKey = f.nodeId + '::' + f.fieldName" @keydown.enter="popKey = f.nodeId + '::' + f.fieldName">
                            <button type="button" class="afc-chk" :class="{ on: f.enabled === true }" role="checkbox" :aria-checked="f.enabled === true" :aria-label="'暴露 ' + (f.label || f.fieldName)" @click.stop="toggleField(f)"><NvIcon v-if="f.enabled === true" name="check" /></button>
                            <div class="afc-t"><b>{{ f.label || f.fieldName }}</b><span>{{ f.fieldName }} · {{ rhWorkflowFieldKind(f) }}</span></div>
                            <ExtIcon name="sliders" class="afc-i" />
                        </div>
                    </div>
                    <Transition name="pop">
                        <div v-if="popField" :key="popKey" class="ed-pop nv-glass-pop" @wheel.stop>
                            <div class="ed-poph">
                                <span class="ic"><ExtIcon name="sliders" /></span>
                                <div class="tx"><b>{{ popField.label || popField.fieldName }}</b><span>{{ popField.fieldName }}</span></div>
                                <button type="button" class="nv-icon-btn sm round" aria-label="关闭" @click="closePop"><NvIcon name="x" /></button>
                            </div>
                            <div class="ed-popb"><RhFieldEditor :field="popField" :mode="mode" @toggle="toggleField(popField)" @update="(p, v) => updateField(popField, p, v)" /></div>
                        </div>
                    </Transition>
                </div>
            </section>
        </div>
    </ApiDialog>
</template>

<style scoped>
.ed-head { display: flex; align-items: center; gap: 8px; padding: 16px 16px 12px 22px; }
.ed-t { flex: 1; min-width: 0; }
.ed-t b { display: block; font: 500 15px/20px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-t span { display: block; font: 400 11px/15px var(--font-mono); color: var(--ink-3); }
.ed-save { min-width: 76px; }
.spin.sm { width: 12px; height: 12px; }
.ed-body { flex: 1; min-height: 0; display: flex; }
.ed-side { width: 300px; flex: none; padding: 4px 16px 16px 22px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.ed-fld { display: flex; flex-direction: column; gap: 6px; }
.ed-fld > span { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.ed-inp { min-width: 0; height: 32px; border: 0; outline: 0; border-radius: var(--radius-md); padding: 0 12px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/1 var(--font-sans); transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.ed-inp:hover { background: var(--fill-2); }
.ed-inp:focus { background: var(--fill-2); box-shadow: none; }
.ed-txa { height: auto; padding: 8px 12px; line-height: 18px; resize: vertical; }
.ed-empty { padding: 18px; border-radius: 12px; background: var(--fill-1); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; overflow-wrap: anywhere; }
.ed-sum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.ed-sum.two { grid-template-columns: repeat(2, 1fr); }
.ed-sum div { padding: 8px 10px; border-radius: 10px; background: var(--fill-1); display: flex; flex-direction: column; gap: 2px; }
.ed-sum span { font: 400 10.5px/14px var(--font-sans); color: var(--ink-3); }
.ed-sum strong { font: 500 14px/18px var(--font-mono); }
.ed-main { flex: 1; min-width: 0; display: flex; margin: 0 14px 14px 0; }
.ed-pane { position: relative; flex: 1; min-width: 0; border-radius: 14px; background-color: var(--canvas); background-image: radial-gradient(var(--canvas-grid) 1px, transparent 1.1px); background-size: 18px 18px; overflow: hidden; }
.ed-pane-empty { display: flex; align-items: center; justify-content: center; gap: 8px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); padding: 24px; text-align: center; }
.ed-pane.ed-pane-empty { flex: 1; }
.ed-apps .ed-pane-empty { position: absolute; inset: 0; }
.ed-afl { position: absolute; inset: 0; overflow-y: auto; padding: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; align-content: start; }
.afc { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-float); cursor: pointer; transition: box-shadow var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out); }
.afc:hover { transform: translateY(-1px); }
.afc.on { background: var(--solid); box-shadow: var(--shadow-float); }
.afc-chk { width: 16px; height: 16px; flex: none; border: 0; padding: 0; border-radius: 5px; background: transparent; box-shadow: inset 0 0 0 1.2px var(--ink-4); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.afc-chk.on { background: var(--accent); box-shadow: none; }
.afc-chk .nv-i { width: 11px; height: 11px; stroke-width: 2; }
.afc-t { flex: 1; min-width: 0; }
.afc-t b { display: block; font: 500 12.5px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afc-t span { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afc-i { width: 14px; height: 14px; color: var(--ink-3); }
.ed-pop { position: absolute; top: 14px; right: 14px; width: 380px; max-width: calc(100% - 28px); max-height: calc(100% - 28px); display: flex; flex-direction: column; background: var(--solid); border-radius: 16px; box-shadow: var(--shadow-pop); z-index: 5; cursor: default; }
.ed-poph { display: flex; align-items: center; gap: 10px; padding: 12px 12px 8px 14px; flex: none; }
.ed-poph .ic { width: 28px; height: 28px; border-radius: 8px; background: var(--fill-1); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ed-poph .ic .nv-i { width: 14px; height: 14px; }
.ed-poph .tx { flex: 1; min-width: 0; }
.ed-poph b { display: block; font: 500 13px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-poph .tx span { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); }
.ed-popb { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.pop-enter-active { transition: opacity 140ms var(--ease-out), transform 140ms var(--ease-out); }
.pop-leave-active { transition: opacity 100ms var(--ease-out); }
.pop-enter-from { opacity: 0; transform: translateY(-4px); }
.pop-leave-to { opacity: 0; }
</style>
