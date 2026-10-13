// RunningHub 纯函数：从旧 static/js/api-settings.js 原样移植（字段名、默认值、正则都不变）。
// 主面板保存时也要用 normalizeRhEntries 规整 rh_apps / rh_workflows（旧 syncEditor / saveProviders 里的逻辑）。

export const RH_DEFAULT_BASE_URL = 'https://www.runninghub.cn';

export function parseRunningHubRunRef(value) {
    const text = String(value || '').trim();
    const match = text.match(/\/run\/(ai-app|workflow)\/([0-9A-Za-z_-]+)/i);
    if (match) return { type: match[1].toLowerCase() === 'ai-app' ? 'app' : 'workflow', id: match[2] };
    const numeric = text.match(/^[0-9]{8,}$/);
    if (numeric) return { type: 'workflow', id: text };
    return null;
}

export function workflowNodeTitle(node) {
    return ((node && node._meta && node._meta.title) || (node && (node.class_type || node._class || node.type)) || 'Node').toString();
}
export function workflowNodeClass(node) {
    return ((node && (node.class_type || node._class || node.type)) || '').toString();
}
export function workflowNodeCategory(node) {
    const text = `${workflowNodeTitle(node)} ${workflowNodeClass(node)}`.toLowerCase();
    if (/text|prompt|clip/.test(text)) return 'prompt';
    if (/lora/.test(text)) return 'lora';
    if (/ksampler|k sampler|sampler|scheduler|guid|cfg/.test(text)) return 'sampler';
    if (/video|movie|mp4|webm|frame/.test(text)) return 'video';
    if (/audio|sound|voice|music|wav|mp3/.test(text)) return 'audio';
    if (/image|mask|resize|scale|crop|photo|picture|preview|save/.test(text)) return 'image';
    return 'misc';
}

export function rhWorkflowFieldKey(field) {
    return `${(field && field.nodeId) || ''}::${(field && field.fieldName) || ''}`;
}
export function rhWorkflowFieldKind(field) {
    const type = String((field && field.fieldType) || '').toUpperCase();
    if (['IMAGE', 'VIDEO', 'AUDIO', 'BOOLEAN', 'NUMBER', 'FLOAT', 'INT', 'INTEGER', 'TEXT', 'SLIDER'].includes(type)) {
        if (type === 'FLOAT' || type === 'INT' || type === 'INTEGER') return 'NUMBER';
        return type;
    }
    const key = `${(field && field.fieldName) || ''} ${(field && field.fieldValue) || ''}`.toLowerCase();
    if (/image|img|mask|png|jpg|jpeg|webp/.test(key)) return 'IMAGE';
    if (/video|mp4|webm|mov/.test(key)) return 'VIDEO';
    if (/audio|wav|mp3|voice|sound/.test(key)) return 'AUDIO';
    if (/true|false/.test(key)) return 'BOOLEAN';
    if (/^-?\d+(\.\d+)?$/.test(String((field && field.fieldValue) || '').trim())) return 'NUMBER';
    return 'TEXT';
}
export const RH_FIELD_TYPES = ['TEXT', 'NUMBER', 'SLIDER', 'BOOLEAN', 'SELECT', 'IMAGE', 'VIDEO', 'AUDIO'];
export function rhWorkflowFieldTypeLabel(type) {
    return ({ TEXT: '文本', NUMBER: '数字', SLIDER: '滑块', BOOLEAN: '开关', SELECT: '下拉', IMAGE: '图片', VIDEO: '视频', AUDIO: '音频' })[String(type || '').toUpperCase()] || type;
}
const SAMPLERS = ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'uni_pc'];
const RH_EDITOR_KNOWN_FIELD_OPTIONS = {
    sampler_name: SAMPLERS,
    sampler: SAMPLERS,
    scheduler: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'],
    ratio: ['1:1', '16:9', '9:16', '21:9', '9:21', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'],
    aspectRatio: ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'],
    resolution: ['512', '768', '1024', '1280', '1536', '2048', '1k', '2k', '4k'],
    size: ['512', '768', '1024', '1280', '1536', '2048'],
    ckpt_name: [],
    unet_name: [],
    lora_name: [],
};
export function rhKnownOptionsForField(field) {
    const name = String((field && field.fieldName) || '').trim();
    if (!name) return [];
    if (RH_EDITOR_KNOWN_FIELD_OPTIONS[name]) return RH_EDITOR_KNOWN_FIELD_OPTIONS[name].map(String);
    const hit = Object.keys(RH_EDITOR_KNOWN_FIELD_OPTIONS).find(key => key.toLowerCase() === name.toLowerCase());
    return hit ? RH_EDITOR_KNOWN_FIELD_OPTIONS[hit].map(String) : [];
}
export function normalizeRhWorkflowField(field) {
    field = field || {};
    const options = Array.isArray(field.options)
        ? field.options.map(option => String(option ?? '').trim()).filter(Boolean)
        : String(field.options || '').split(/\r?\n|,/).map(option => option.trim()).filter(Boolean);
    const knownOptions = options.length ? options : rhKnownOptionsForField(field);
    const fieldType = String(field.fieldType || rhWorkflowFieldKind(field));
    const normalizedType = fieldType.toUpperCase();
    const savedSource = field.sourceFromUpstream;
    return {
        id: String(field.id || rhWorkflowFieldKey(field)),
        nodeId: String(field.nodeId || ''),
        fieldName: String(field.fieldName || ''),
        fieldValue: field.fieldValue == null ? '' : String(field.fieldValue),
        fieldType: knownOptions.length && !['IMAGE', 'VIDEO', 'AUDIO', 'SLIDER'].includes(normalizedType) ? 'SELECT' : fieldType,
        label: String(field.label || field.fieldName || ''),
        enabled: field.enabled === true,
        sourceFromUpstream: savedSource === undefined ? false : savedSource !== false,
        group: String(field.group || ''),
        note: String(field.note || ''),
        options: knownOptions,
        random_enabled: field.random_enabled === true,
        min: field.min ?? '',
        max: field.max ?? '',
        step: field.step ?? '',
        imageOrder: Number(field.imageOrder || field.image_order || 0) || 0,
        required: field.required === true,
    };
}
export function normalizeFetchedRhWorkflowField(field) {
    return { ...normalizeRhWorkflowField(field), enabled: true };
}
export function rhEditorSortedFields(fields) {
    return [...(fields || [])].sort((a, b) => {
        const ak = rhWorkflowFieldKind(a);
        const bk = rhWorkflowFieldKind(b);
        if (ak === 'IMAGE' && bk === 'IMAGE') {
            const ao = Number(a.imageOrder) || 9999;
            const bo = Number(b.imageOrder) || 9999;
            if (ao !== bo) return ao - bo;
        }
        if (ak === 'IMAGE' && bk !== 'IMAGE') return -1;
        if (ak !== 'IMAGE' && bk === 'IMAGE') return 1;
        return String(a.nodeId || '').localeCompare(String(b.nodeId || ''), undefined, { numeric: true }) || String(a.fieldName || '').localeCompare(String(b.fieldName || ''));
    });
}

export function normalizeRhEntries(values, kind) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(raw => {
        raw = raw || {};
        const parsed = parseRunningHubRunRef(raw.appId || raw.workflowId || raw.id || '');
        const id = String((parsed && parsed.id) || raw.id || raw.appId || raw.workflowId || '').trim();
        if (!id || seen.has(id)) return null;
        seen.add(id);
        const fallback = kind === 'app' ? `AI 应用 ${id.slice(-6)}` : `工作流 ${id.slice(-6)}`;
        const entry = {
            id,
            title: String(raw.title || raw.name || fallback).trim(),
            note: String(raw.note || raw.description || '').trim(),
            thumbnail: String(raw.thumbnail || '').trim(),
            enabled: raw.enabled !== false,
        };
        if (raw.hidden === true) entry.hidden = true;
        if (Array.isArray(raw.fields)) entry.fields = raw.fields.map(normalizeRhWorkflowField);
        if (raw.workflowJson && typeof raw.workflowJson === 'object') entry.workflowJson = raw.workflowJson;
        if (raw.raw && typeof raw.raw === 'object') entry.raw = raw.raw;
        const updatedAt = Number(raw.updatedAt || 0);
        if (updatedAt > 0) entry.updatedAt = updatedAt;
        if (kind === 'app') entry.appId = id;
        else {
            entry.workflowId = id;
            entry.optionalImageMode = String(raw.optionalImageMode || 'prune-workflow');
        }
        return entry;
    }).filter(Boolean);
}
export function ensureRunningHubLists(item) {
    if (!item) return;
    item.rh_apps = normalizeRhEntries(item.rh_apps || [], 'app');
    item.rh_workflows = normalizeRhEntries(item.rh_workflows || [], 'workflow');
}

// 内置模板（随 /api/providers 合并返回完整字段）删除时只隐藏，手动粘贴的才真正移除
export function isStaticRunningHubEntry(kind, entry) {
    const id = String((kind === 'app' ? (entry && (entry.appId || entry.id)) : (entry && (entry.workflowId || entry.id))) || '').trim();
    const thumb = String((entry && entry.thumbnail) || '');
    if (thumb.includes('/static/runninghub/')) return true;
    if (id && thumb.includes(`${kind === 'app' ? 'app' : 'workflow'}-${id}`)) return true;
    return Array.isArray(entry && entry.fields) || !!(entry && entry.workflowJson && typeof entry.workflowJson === 'object') || !!(entry && entry.raw && typeof entry.raw === 'object');
}

export function rhEntryThumbnailCandidates(kind, entry) {
    const id = String((kind === 'workflow' ? (entry && (entry.workflowId || entry.id)) : (entry && (entry.appId || entry.id))) || '').trim().replace(/[^0-9A-Za-z_-]/g, '');
    if (!id) return [];
    const prefix = kind === 'workflow' ? 'workflow' : 'app';
    const urls = [];
    [`${prefix}-${id}`, id].forEach(name => ['/static/runninghub/thumbnails', '/static/runninghub'].forEach(root => urls.push(`${root}/${name}.jpg`)));
    return urls;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
        reader.readAsDataURL(file);
    });
}
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = src;
    });
}
export async function createRhThumbnailDataUrl(file) {
    const original = await readFileAsDataUrl(file);
    try {
        const img = await loadImage(original);
        const maxSide = 360;
        const w0 = img.naturalWidth || img.width || 1, h0 = img.naturalHeight || img.height || 1;
        const scale = Math.min(1, maxSide / Math.max(w0, h0));
        const width = Math.max(1, Math.round(w0 * scale));
        const height = Math.max(1, Math.round(h0 * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL('image/jpeg', 0.78);
    } catch (e) {
        return original;
    }
}
export function pickFile(accept) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = () => resolve((input.files && input.files[0]) || null);
        input.click();
    });
}

/* ── 编辑器配置 ── */
export function applyRhImageSlotDefaults(config) {
    const imageFields = (config.fields || []).filter(field => rhWorkflowFieldKind(field) === 'IMAGE');
    imageFields.forEach((field, index) => {
        if (!Number(field.imageOrder)) field.imageOrder = index + 1;
        if (field.required !== true && field.required !== false) field.required = index === 0;
        if (index === 0 && field.required !== false) field.required = true;
    });
    config.optionalImageMode = config.optionalImageMode || 'prune-workflow';
    return config;
}
export function normalizeRhWorkflowConfig(config, entry) {
    config = config || {};
    entry = entry || {};
    const workflowId = String(config.workflowId || entry.workflowId || entry.id || '').trim();
    return applyRhImageSlotDefaults({
        workflowId,
        title: String(config.title || entry.title || workflowId),
        description: String(config.description || entry.note || ''),
        fields: (Array.isArray(config.fields) ? config.fields : []).map(normalizeRhWorkflowField),
        workflowJson: config.workflowJson || {},
        optionalImageMode: String(config.optionalImageMode || entry.optionalImageMode || 'prune-workflow'),
        raw: config.raw || {},
    });
}
export function normalizeRhAppConfig(entry) {
    entry = entry || {};
    const appId = String(entry.appId || entry.id || '').trim();
    return {
        appId,
        title: String(entry.title || `AI 应用 ${appId.slice(-6)}` || appId),
        description: String(entry.note || ''),
        fields: (Array.isArray(entry.fields) ? entry.fields : []).map(normalizeRhWorkflowField),
        raw: entry.raw || {},
    };
}
export function rhAppFieldSourceList(raw) {
    const data = raw && raw.data && typeof raw.data === 'object' ? raw.data : (raw || {});
    const candidates = [
        data.nodeInfoList, data.fields, data.inputs, data.inputList, data.formItems, data.forms, data.params, data.parameters, data.apiParams,
        data.config && data.config.fields, data.webapp && data.webapp.fields, data.webapp && data.webapp.inputs,
    ];
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) return candidate;
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate).length) {
            return Object.entries(candidate).map(([key, value]) => ({ fieldName: key, fieldValue: value }));
        }
    }
    return [];
}
function extractRhEditorFieldOptions(field) {
    const candidates = [field.options, field.optionList, field.values, field.enum, field.choices, field.items, field.list, field.selectOptions, field.fieldData];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate) || !candidate.length) continue;
        return candidate.map(item => (item && typeof item === 'object' ? (item.value ?? item.label ?? item.name ?? item.title) : item))
            .filter(item => item !== undefined && item !== null).map(String);
    }
    return rhKnownOptionsForField(field);
}
export function normalizeFetchedRhAppField(field, index = 0) {
    field = field || {};
    const name = field.fieldName || field.inputName || field.name || field.key || field.paramName || field.id || `field_${index + 1}`;
    const nodeId = field.nodeId || field.node_id || field.groupId || 'app';
    let value = field.fieldValue;
    if (value === undefined) value = field.defaultValue;
    if (value === undefined) value = field.value;
    if (value === undefined) value = field.default;
    if (value === undefined || value === null) value = '';
    if (typeof value === 'object') value = JSON.stringify(value);
    const options = extractRhEditorFieldOptions(field);
    return normalizeRhWorkflowField({
        id: field.id || `${nodeId}::${name}`,
        nodeId,
        fieldName: name,
        fieldValue: value,
        fieldType: field.fieldType || field.type || field.valueType || (options.length ? 'SELECT' : ''),
        label: field.label || field.title || field.name || name,
        enabled: true,
        group: field.group || field.category || field.title || 'AI 应用参数',
        note: field.note || field.description || '',
        options,
        min: field.min ?? '',
        max: field.max ?? '',
        step: field.step ?? '',
    });
}

/* ── 图布局（节点按依赖分层） ── */
export function computeRhWorkflowEditorLayers(workflow) {
    const ids = Object.keys(workflow || {});
    const incoming = {}, outgoing = {};
    ids.forEach(id => { incoming[id] = new Set(); outgoing[id] = new Set(); });
    ids.forEach(id => {
        Object.values((workflow[id] && workflow[id].inputs) || {}).forEach(value => {
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && workflow[value[0]]) {
                incoming[id].add(value[0]);
                outgoing[value[0]].add(id);
            }
        });
    });
    const layer = {};
    const visiting = new Set();
    function dfs(id, lv) {
        if (visiting.has(id)) return;
        layer[id] = Math.max(layer[id] || 0, lv);
        visiting.add(id);
        outgoing[id].forEach(child => dfs(child, lv + 1));
        visiting.delete(id);
    }
    ids.forEach(id => { if (incoming[id].size === 0) dfs(id, 0); });
    ids.forEach(id => { if (!(id in layer)) layer[id] = 0; });
    const buckets = {};
    ids.forEach(id => { (buckets[layer[id]] = buckets[layer[id]] || []).push(id); });
    return { buckets };
}

/* ── 测试运行 ── */
export function rhPreviewRandomValue(field) {
    const isFloat = Number(field.step) > 0 && Number(field.step) < 1;
    let min = Number.isFinite(Number(field.min)) ? Number(field.min) : null;
    let max = Number.isFinite(Number(field.max)) ? Number(field.max) : null;
    const name = `${field.fieldName || ''} ${field.label || ''}`.toLowerCase();
    const looksSeed = name.includes('seed') || name.includes('noise') || name.includes('随机') || name.includes('种子');
    if (min === null) min = looksSeed ? 1 : 0;
    if (max === null || max <= min) max = looksSeed ? 4294967295 : 999999;
    if (looksSeed) max = Math.min(max, 4294967295);
    const value = min + Math.random() * (max - min);
    if (isFloat) {
        const precision = Math.min(8, Math.max(1, (String(field.step).split('.')[1] || '').length || 2));
        return Number(value.toFixed(precision));
    }
    return Math.floor(value);
}
export function mediaAcceptForRhKind(kind) {
    if (kind === 'VIDEO') return 'video/*';
    if (kind === 'AUDIO') return 'audio/*';
    return 'image/*';
}
export function outputKind(url) {
    const s = String(url || '');
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(s)) return 'video';
    if (/\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i.test(s)) return 'audio';
    return 'image';
}
