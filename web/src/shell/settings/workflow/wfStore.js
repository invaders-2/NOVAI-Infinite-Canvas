// 工作流设置的页面状态与动作（一页只有一个实例，用模块级 reactive）
// 接口、请求体、广播消息与旧 static/js/comfyui-settings.js 完全一致。
import { reactive } from 'vue';
import { toast, t } from '../../../lib/store.js';
import { broadcast } from '../../../lib/bridge.js';
import {
    inputLabel, guessType, fieldKind, mediaAccept, mediaUploadFailedText, randomValueForField, fieldSupportsRandom,
    defaultMiniCards, defaultMiniTestNodes, tf,
} from './nodeInfo.js';

export const wf = reactive({
    workflows: [],
    listLoading: false,
    selectedName: '',
    opening: false,
    workflow: null,            // 原始 JSON
    config: null,              // { title, fields:[...], mini_cards }
    isBuiltin: false,
    previewValues: {},         // field_id -> 发给后端的值（媒体：comfy 文件名）
    previewRandomActive: {},   // field_id -> 筛子是否激活；未设置时默认激活
    previewImageUrls: {},      // field_id -> 浏览器可显示的本地 URL
    runResult: null,
    running: false,
    saving: false,
    uploading: false,
    deleting: false,
    mode: 'graph',             // graph | canvas
    miniTestNodes: [],
    popupNodeId: null,
    lightbox: '',
    fitTick: 0,                // 选中新工作流后让节点图自适应
});

export function notifyChange(type) {
    const msg = { type };
    try { new BroadcastChannel('studio-api').postMessage(msg); } catch (e) {}
    broadcast(msg);
}
async function errDetail(res, fallback) {
    try { const d = await res.json(); return (d && d.detail) || fallback; } catch (e) { return fallback; }
}
function revokeAll() {
    Object.values(wf.previewImageUrls).forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    wf.previewImageUrls = {};
    wf.miniTestNodes.forEach(n => { if (n.url && n.url.startsWith('blob:')) { try { URL.revokeObjectURL(n.url); } catch (e) {} } });
}

export async function loadList() {
    wf.listLoading = true;
    try {
        const data = await fetch('/api/workflows').then(r => r.json());
        wf.workflows = data.workflows || [];
        const stillExists = wf.selectedName && wf.workflows.some(w => w.name === wf.selectedName);
        if (!stillExists && wf.workflows.length) await selectWorkflow(wf.workflows[0].name);
    } catch (e) {
        console.error(e);
        toast(t('comfy.loadFailed', '加载失败'), { danger: true, icon: 'alert' });
    } finally { wf.listLoading = false; }
}

export async function selectWorkflow(name) {
    wf.selectedName = name;
    wf.opening = true;
    try {
        const data = await fetch(`/api/workflows/${encodeURIComponent(name)}`).then(r => r.json());
        const config = data.config || { title: name.replace('.json', ''), fields: [] };
        if (!config.fields) config.fields = [];
        if (!config.mini_cards) config.mini_cards = {};
        config.mini_cards = { ...defaultMiniCards(), ...config.mini_cards };
        revokeAll();
        wf.popupNodeId = null;
        wf.workflow = data.workflow;
        wf.config = config;
        wf.isBuiltin = !!data.builtin;
        const values = {};
        config.fields.forEach(f => { if (f.default !== undefined && f.default !== null) values[f.id] = f.default; });
        wf.previewValues = values;
        wf.previewRandomActive = {};
        wf.runResult = null;
        wf.miniTestNodes = defaultMiniTestNodes();
        wf.fitTick++;
    } catch (e) {
        console.error(e);
        toast(t('comfy.openFailed', '打开失败'), { danger: true, icon: 'alert' });
    } finally { wf.opening = false; }
}

export function resetAll() {
    revokeAll();
    Object.assign(wf, { workflows: [], selectedName: '', workflow: null, config: null, isBuiltin: false, previewValues: {}, previewRandomActive: {}, runResult: null, running: false, mode: 'graph', miniTestNodes: [], popupNodeId: null, lightbox: '' });
}

/* —— 字段 —— */
export function fieldFor(node, input) { return wf.config ? wf.config.fields.find(f => f.node === node && f.input === input) : null; }
function makeFieldId() { return 'f_' + Math.random().toString(36).slice(2, 9); }

export function toggleField(node, input) {
    const existing = fieldFor(node, input);
    if (existing) {
        wf.config.fields = wf.config.fields.filter(f => f !== existing);
        delete wf.previewValues[existing.id];
        delete wf.previewRandomActive[existing.id];
        return;
    }
    const rawValue = wf.workflow[node] && wf.workflow[node].inputs ? wf.workflow[node].inputs[input] : undefined;
    const type = guessType(rawValue, input);
    const f = { id: makeFieldId(), node, input, name: inputLabel(input), type, default: typeof rawValue === 'object' ? null : rawValue, options: [] };
    if (type === 'slider' || type === 'number') {
        if (typeof rawValue === 'number') {
            f.min = 0;
            f.max = Math.max(rawValue * 2, 10);
            f.step = rawValue > 0 && rawValue < 5 ? 0.1 : 1;
        }
        if (type === 'number') f.random_enabled = false;
    }
    wf.config.fields.push(f);
    if (f.default !== undefined && f.default !== null) wf.previewValues[f.id] = f.default;
}

export function updateField(fieldId, key, value) {
    const f = wf.config && wf.config.fields.find(x => x.id === fieldId);
    if (!f) return;
    f[key] = value;
    if (key === 'type') {
        wf.previewValues[fieldId] = value === 'boolean' ? false : (value === 'number' || value === 'slider' ? 0 : '');
        f.random_enabled = value === 'number' ? !!f.random_enabled : false;
        delete wf.previewRandomActive[fieldId];
    }
    if (key === 'random_enabled') delete wf.previewRandomActive[fieldId];
}
export function addDropdownOption(f) { f.options = [...(f.options || []), '']; }
export function removeDropdownOption(f, index) { f.options = (f.options || []).filter((_, i) => i !== index); }
export function updateDropdownOption(f, index, value) { f.options = f.options || []; f.options[index] = value; }

export function updateWorkflowTitle(value) {
    if (!wf.config) return;
    wf.config.title = value;
    const item = wf.workflows.find(w => w.name === wf.selectedName);
    if (item) item.title = value || wf.selectedName.replace('.json', '');
}

/* —— 预览值 / 随机 —— */
export function previewValue(f) {
    const v = wf.previewValues[f.id];
    if (v !== undefined && v !== null) return v;
    if (f.default !== undefined && f.default !== null) return f.default;
    return f.type === 'boolean' ? false : (f.type === 'number' || f.type === 'slider' ? 0 : '');
}
export function setPreviewValue(id, value) { wf.previewValues[id] = value; }
export function isPreviewRandomActive(id) { return wf.previewRandomActive[id] !== false; }
export function togglePreviewRandom(f) {
    if (!fieldSupportsRandom(f)) return;
    wf.previewRandomActive[f.id] = !isPreviewRandomActive(f.id);
}
function applyActiveRandomValues(fields) {
    const out = { ...fields };
    ((wf.config && wf.config.fields) || []).forEach(f => {
        if (fieldSupportsRandom(f) && isPreviewRandomActive(f.id)) {
            const value = randomValueForField(f);
            out[f.id] = value;
            wf.previewValues[f.id] = value;
        }
    });
    return out;
}
export function mediaDisplayUrl(f) {
    const v = previewValue(f);
    return wf.previewImageUrls[f.id] || (typeof v === 'string' && /^(\/|https?:|blob:|data:)/.test(v) ? v : '');
}

/* —— 上传媒体 —— */
function chooseFile(accept) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = () => resolve((input.files && input.files[0]) || null);
        input.click();
    });
}
async function uploadToComfy(file) {
    const form = new FormData();
    form.append('files', file);
    const data = await fetch('/api/upload', { method: 'POST', body: form }).then(r => r.json());
    return (data.files && data.files[0] && (data.files[0].comfy_name || data.files[0].filename)) || file.name;
}
export async function pickImage(fieldId) {
    const field = wf.config.fields.find(f => f.id === fieldId);
    const kind = fieldKind(field || { type: 'image' });
    const file = await chooseFile(mediaAccept(kind));
    if (!file) return;
    if (wf.previewImageUrls[fieldId]) URL.revokeObjectURL(wf.previewImageUrls[fieldId]);
    wf.previewImageUrls[fieldId] = URL.createObjectURL(file);
    try { wf.previewValues[fieldId] = await uploadToComfy(file); }
    catch (e) { toast(mediaUploadFailedText(kind), { danger: true, icon: 'alert' }); }
}
export async function pickMiniImage(nodeId) {
    const node = wf.miniTestNodes.find(n => n.id === nodeId);
    if (!node) return;
    const file = await chooseFile(mediaAccept(node.type || 'image'));
    if (!file) return;
    if (node.url && node.url.startsWith('blob:')) URL.revokeObjectURL(node.url);
    node.url = URL.createObjectURL(file);
    node.name = file.name;
    try { node.value = await uploadToComfy(file); }
    catch (e) { toast(mediaUploadFailedText(node.type), { danger: true, icon: 'alert' }); }
}

/* —— 测试画布节点 —— */
export function addMiniNode(type) {
    const count = wf.miniTestNodes.filter(n => n.type === type).length;
    wf.miniTestNodes.push({
        id: `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        type, x: 42 + count * 26, y: type === 'prompt' ? 86 + count * 170 : 286 + count * 170, text: '', url: '', value: '',
    });
}
export function removeMiniNode(id) {
    const n = wf.miniTestNodes.find(x => x.id === id);
    if (n && n.url && n.url.startsWith('blob:')) { try { URL.revokeObjectURL(n.url); } catch (e) {} }
    wf.miniTestNodes = wf.miniTestNodes.filter(x => x.id !== id);
}
function fieldsFromMiniCanvas() {
    const fields = { ...wf.previewValues };
    const promptFields = wf.config.fields.filter(f => fieldKind(f) === 'prompt');
    const prompt = wf.miniTestNodes.filter(n => n.type === 'prompt').map(n => n.text || '').filter(Boolean).join('\n\n');
    ['image', 'video', 'audio'].forEach(kind => {
        const mediaFields = wf.config.fields.filter(f => fieldKind(f) === kind);
        const mediaNodes = wf.miniTestNodes.filter(n => n.type === kind && n.value);
        mediaFields.forEach((f, i) => { fields[f.id] = (mediaNodes[i] && mediaNodes[i].value) || fields[f.id] || ''; });
    });
    promptFields.forEach(f => { fields[f.id] = prompt || fields[f.id] || ''; });
    return fields;
}

/* —— 运行 / 保存 / 删除 / 上传 —— */
export async function runTest() {
    if (!wf.selectedName || !wf.config || wf.running) return;
    wf.running = true;
    try {
        const baseFields = wf.mode === 'canvas' ? fieldsFromMiniCanvas() : { ...wf.previewValues };
        const runFields = applyActiveRandomValues(baseFields);
        const res = await fetch(`/api/workflows/${encodeURIComponent(wf.selectedName)}/run`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: runFields, config: wf.config, client_id: 'workflow-test' }),
        });
        if (!res.ok) throw new Error(await errDetail(res, t('comfy.runFailed', '运行失败')));
        const data = await res.json();
        wf.runResult = (data.images && data.images[0]) || null;
        toast(t('comfy.runSuccess', '运行成功'), { icon: 'check' });
    } catch (e) {
        const fail = t('comfy.runFailed', '运行失败');
        const msg = (e && e.message) || fail;
        toast(msg === fail ? fail : fail + '：' + msg, { danger: true, icon: 'alert', duration: 4000 });
    } finally { wf.running = false; }
}

export async function saveConfig() {
    if (!wf.selectedName || !wf.config || wf.saving) return;
    for (const f of wf.config.fields) {
        if (!f.name || !String(f.name).trim()) { toast(tf('comfy.saveMissingName', { field: f.input }, '字段 "{field}" 缺少显示名称'), { danger: true, icon: 'alert' }); return; }
    }
    wf.saving = true;
    try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(wf.selectedName)}/config`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wf.config),
        });
        if (!res.ok) throw new Error(await errDetail(res, t('comfy.saveFailed', '保存失败')));
        toast(t('comfy.saved', '已保存'), { icon: 'check' });
        await loadList();
        notifyChange('workflows-changed');
    } catch (e) { toast((e && e.message) || t('comfy.saveFailed', '保存失败'), { danger: true, icon: 'alert' }); }
    finally { wf.saving = false; }
}

export async function deleteWorkflow() {
    if (!wf.selectedName || wf.isBuiltin) return;
    wf.deleting = true;
    try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(wf.selectedName)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await errDetail(res, t('comfy.deleteFailed', '删除失败')));
        revokeAll();
        Object.assign(wf, { selectedName: '', workflow: null, config: null, isBuiltin: false, previewValues: {}, previewRandomActive: {}, runResult: null, popupNodeId: null });
        await loadList();
        notifyChange('workflows-changed');
        toast('工作流已删除', { icon: 'check' });
    } catch (e) { toast((e && e.message) || t('comfy.deleteFailed', '删除失败'), { danger: true, icon: 'alert' }); }
    finally { wf.deleting = false; }
}

// 第一步：读 JSON；返回 { workflow, baseName } 或 null（无效时已提示）
export async function readWorkflowFile(file) {
    let workflow;
    try { workflow = JSON.parse(await file.text()); }
    catch (e) { toast(t('comfy.invalidJson', '不是有效的 JSON 文件'), { danger: true, icon: 'alert' }); return null; }
    return { workflow, baseName: file.name.replace(/\.json$/i, '') };
}
// 第二步：命名后上传
export async function uploadWorkflow(name, workflow) {
    wf.uploading = true;
    try {
        const res = await fetch('/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, workflow }) });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.detail || t('comfy.uploadFailed', '上传失败'));
        await loadList();
        await selectWorkflow(result.name);
        toast(t('comfy.uploaded', '已上传：') + result.name, { icon: 'check' });
        notifyChange('workflows-changed');
        return true;
    } catch (e) {
        toast((e && e.message) || t('comfy.uploadFailed', '上传失败'), { danger: true, icon: 'alert' });
        return false;
    } finally { wf.uploading = false; }
}
