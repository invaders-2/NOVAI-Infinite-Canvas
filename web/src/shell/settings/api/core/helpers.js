// API 设置：纯函数工具（逻辑照搬旧 api-settings.js，只把 DOM 依赖改成参数）
import {
    CLI_PROTOCOLS, JIMENG_DEFAULT_IMAGE_MODELS, JIMENG_DEFAULT_VIDEO_MODELS, JIMENG_LEGACY_IMAGE_MODELS, JIMENG_LEGACY_VIDEO_MODELS,
    CODEX_DEFAULT_IMAGE_MODELS, CODEX_DEFAULT_CHAT_MODELS, GEMINI_CLI_DEFAULT_IMAGE_MODELS, GEMINI_CLI_DEFAULT_CHAT_MODELS,
    LOVART_DEFAULT_BASE_URL, LOVART_DEFAULT_CHAT_MODELS, LOVART_DEFAULT_IMAGE_MODELS, LOVART_DEFAULT_VIDEO_MODELS,
    RECOMMENDED_APIS, LOCKED_RECOMMENDED_PROTOCOL_IDS, FIXED_PROTOCOL_PROVIDER_IDS, RH_KNOWN_MODEL_LABELS, VIDEO_VENDOR_RULES, ONBOARDING_GUIDES,
} from './constants.js';

export function unique(values) {
    const seen = new Set();
    return (values || []).map(v => String(v || '').trim()).filter(v => v && !seen.has(v) && seen.add(v));
}
export function normalizeId(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-').slice(0, 40);
}
// 平台 Key 按 ID 写入 API/.env；ID 一旦创建就保持稳定，避免改名或中文名称导致 Key 看起来丢失
export function deriveIdFromName(name, existingId, providers) {
    if (existingId) return existingId;
    let id = normalizeId(name);
    if (!id) id = 'api-' + Math.random().toString(36).slice(2, 8);
    let candidate = id, i = 2;
    while ((providers || []).some(p => p.id === candidate)) candidate = `${id}-${i++}`;
    return candidate;
}
export function normalizeMaxConcurrency(value) { const n = parseInt(value, 10); return Number.isFinite(n) ? Math.max(0, Math.min(16, n)) : 0; }
export function normalizeUseProxy(value) { const v = String(value || '').toLowerCase(); return v === 'on' || v === 'off' ? v : 'auto'; }
export function normalizeImageRequestMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return ['openai', 'openai-json', 'openai-video-proxy', 'openai-responses'].includes(mode) ? mode : 'openai';
}
export function normalizeImageEditRoute(value) {
    const route = String(value || '').trim().toLowerCase();
    return ['general', 'auto', 'chat'].includes(route) ? route : 'general';
}
export function imageRequestModeLabel(mode) {
    const m = normalizeImageRequestMode(mode);
    if (m === 'openai-json') return 'OpenAI JSON';
    if (m === 'openai-video-proxy') return 'OpenAI 中转';
    if (m === 'openai-responses') return 'OpenAI RS';
    return 'OpenAI 标准';
}
export function normalizeLoraStrength(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.8;
    return Math.max(0, Math.min(2, n));
}
export function isCliProtocol(p) { return CLI_PROTOCOLS.has(String(p || '').toLowerCase()); }
// 即梦 CLI 不是固定平台：可删除、可排序，未添加则不存在
export function isFixedProvider(itemOrId) {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId && itemOrId.id;
    return id === 'modelscope' || id === 'runninghub' || id === 'volcengine' || id === 'lovart';
}
export function isLovartContext(item, protocol = '') {
    if (!item) return false;
    if (item.id === 'lovart') return true;
    return String(protocol || item.protocol || '').toLowerCase() === 'lovart';
}
export function isVolcengineProvider(item) { return String((item && item.protocol) || '').toLowerCase() === 'volcengine'; }
export function isRunningHubContext(item, protocol, baseUrl) {
    const p = String(protocol || (item && item.protocol) || '').trim().toLowerCase();
    const url = String(baseUrl || (item && item.base_url) || '').trim().toLowerCase();
    return (item && item.id === 'runninghub') || p === 'runninghub' || url.includes('runninghub.cn') || url.includes('runninghub.ai');
}
export function isRunningHubLike(item) {
    const base = String((item && item.base_url) || '').toLowerCase();
    return (item && item.id === 'runninghub') || String((item && item.protocol) || '').toLowerCase() === 'runninghub' || base.includes('runninghub.cn');
}
export function hasUsableKey(item) {
    return !!(item && (item.has_key || item.has_wallet_key || isCliProtocol(item.protocol)));
}
export function providerSupportsModelProtocol(item) { return !!item && !FIXED_PROTOCOL_PROVIDER_IDS.has(item.id); }

function jimengModels(item) {
    item.image_models = unique([...(item.image_models || []).filter(m => !JIMENG_LEGACY_IMAGE_MODELS.has(String(m || '').trim())), ...JIMENG_DEFAULT_IMAGE_MODELS]);
    item.video_models = unique([...(item.video_models || []).filter(m => !JIMENG_LEGACY_VIDEO_MODELS.has(String(m || '').trim())), ...JIMENG_DEFAULT_VIDEO_MODELS]);
}
export function applyJimengModels(item) { jimengModels(item); }
export function applyCliProtocolDefaults(item, protocol) {
    if (!item) return;
    const value = String(protocol || item.protocol || '').toLowerCase();
    if (!CLI_PROTOCOLS.has(value)) return;
    item.base_url = '';
    item.protocol = value;
    if (value === 'jimeng') {
        jimengModels(item);
        item.chat_models = unique(item.chat_models || []);
    } else if (value === 'codex') {
        item.image_models = unique([...(item.image_models || []).filter(m => String(m || '').trim().toLowerCase() !== '$imagegen'), ...CODEX_DEFAULT_IMAGE_MODELS]);
        item.chat_models = unique([...(item.chat_models || []), ...CODEX_DEFAULT_CHAT_MODELS]);
        item.video_models = [];
    } else if (value === 'gemini-cli') {
        item.image_models = unique([...(item.image_models || []), ...GEMINI_CLI_DEFAULT_IMAGE_MODELS]);
        item.chat_models = unique([...(item.chat_models || []), ...GEMINI_CLI_DEFAULT_CHAT_MODELS]);
        item.video_models = [];
    }
}
// reset 只在用户主动把协议切到 Lovart 时为 true：网关回官方地址并合并预置工具清单。
// 被动渲染/保存时只补空值，避免覆盖已配置的网关、避免用户删掉的模型被反复加回来。
export function applyLovartProtocolDefaults(item, reset = false) {
    if (!item) return;
    item.protocol = 'lovart';
    item.base_url = reset ? LOVART_DEFAULT_BASE_URL : (item.base_url || LOVART_DEFAULT_BASE_URL);
    item.image_request_mode = 'openai';
    item.image_edit_route = 'general';
    if (reset || !(item.chat_models || []).length) item.chat_models = unique([...(item.chat_models || []), ...LOVART_DEFAULT_CHAT_MODELS]);
    if (reset || !(item.image_models || []).length) item.image_models = unique([...(item.image_models || []), ...LOVART_DEFAULT_IMAGE_MODELS]);
    if (reset || !(item.video_models || []).length) item.video_models = unique([...(item.video_models || []), ...LOVART_DEFAULT_VIDEO_MODELS]);
}

/* 供应商注册表（后端 /api/providers 的 registry_presets）是请求地址 / 协议 / 模型清单的唯一真值源：
   推荐卡片只保留文案与标签，配置项按 id 从注册表补进来（注册表不含密钥；密钥仍走 API/.env 的 key_env）。
   注册表取不到时卡片照样能打开，由用户手填或用「拉取模型」补齐，不写死任何供应商默认值。 */
const registryPresets = {};
export function registryPreset(id) {
    return registryPresets[String(id || '').trim().toLowerCase()] || null;
}
export function applyRegistryPresets(list) {
    (Array.isArray(list) ? list : []).forEach(entry => {
        const id = String((entry && entry.id) || '').trim().toLowerCase();
        if (!id) return;
        registryPresets[id] = entry;
        const api = RECOMMENDED_APIS.find(item => String(item.id || '').toLowerCase() === id);
        if (api) {
            if (entry.base_url) api.base_url = entry.base_url;
            if (entry.protocol) api.protocol = entry.protocol;
            if (entry.image_request_mode) api.image_request_mode = entry.image_request_mode;
            if (entry.register_url) api.register_url = entry.register_url;
            if (entry.docs_url) api.docs_url = entry.docs_url;
            const models = entry.default_models || {};
            ['image', 'chat', 'video'].forEach(kind => {
                if (Array.isArray(models[kind])) api[kind + '_models'] = [...models[kind]];
            });
        }
        const guide = ONBOARDING_GUIDES[id];
        if (guide && entry.register_url) guide.primaryUrl = entry.register_url;
    });
}
function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; } }
export function lockedRecommendedApi(itemOrId) {
    const isStr = typeof itemOrId === 'string';
    const id = String((isStr ? itemOrId : itemOrId && itemOrId.id) || '').trim().toLowerCase();
    const name = String((isStr ? '' : itemOrId && itemOrId.name) || '').trim().toLowerCase();
    const base = String((isStr ? '' : itemOrId && itemOrId.base_url) || '').trim().replace(/\/+$/, '').toLowerCase();
    const host = hostOf(base);
    return RECOMMENDED_APIS.find(api => {
        if (!LOCKED_RECOMMENDED_PROTOCOL_IDS.has(api.id)) return false;
        const apiBase = String(api.base_url || '').trim().replace(/\/+$/, '').toLowerCase();
        const apiHost = hostOf(apiBase);
        return id === api.id || name === String(api.name || '').trim().toLowerCase() || (apiBase && base === apiBase) || (apiHost && host === apiHost);
    }) || null;
}
export function applyLockedRecommendedProtocol(item) {
    const api = lockedRecommendedApi(item);
    if (!item || !api) return false;
    item.protocol = String(api.protocol || 'openai').toLowerCase();
    item.image_request_mode = normalizeImageRequestMode(api.image_request_mode);
    return true;
}

/* —— 模型显示名（RunningHub 的模型 ID 很长，转成可读名） —— */
function rhActionLabel(text) {
    const value = String(text || '').toLowerCase().replace(/[_/-]+/g, ' ');
    if (/start\s+end\s+to\s+video/.test(value)) return '首尾帧视频';
    if (/multimodal\s+video/.test(value)) return '多模态视频';
    if (/image\s+to\s+video|图生视频/.test(value)) return '图生视频';
    if (/text\s+to\s+video|文生视频/.test(value)) return '文生视频';
    if (/image\s+to\s+image|image\s+edit|edit|图生图|图片编辑/.test(value)) return '图片编辑';
    if (/text\s+to\s+image|文生图/.test(value)) return '文生图';
    return '';
}
function runningHubReadableModelName(model, item, fetchedNames) {
    const raw = String(model || '').trim();
    if (!raw) return '';
    const saved = item && item.model_names && typeof item.model_names === 'object' ? item.model_names[raw] : '';
    if (saved && saved !== raw) return saved;
    const fetched = fetchedNames && fetchedNames[raw];
    if (fetched && fetched !== raw) return fetched;
    if (RH_KNOWN_MODEL_LABELS[raw]) return RH_KNOWN_MODEL_LABELS[raw];
    const lower = raw.toLowerCase();
    const action = rhActionLabel(raw);
    const act = action ? ' · ' + action : '';
    const normalized = raw.replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (lower.includes('alibaba') || lower.includes('wan-') || lower.includes('wan ')) {
        const version = (normalized.match(/wan\s*(\d+(?:\.\d+)?)/i) || [])[1];
        return `阿里 · 万相${version ? ' ' + version : ''}${act}`;
    }
    if (lower.includes('bytedance') || lower.includes('jimeng')) {
        const version = (normalized.match(/jimeng\s*(\d+(?:\.\d+)?)/i) || [])[1];
        return `字节 · 即梦${version ? ' ' + version : ''}${act}`;
    }
    if (lower.includes('seedance')) {
        const version = (normalized.match(/seedance\s*(\d+(?:\.\d+)?)/i) || [])[1];
        return `Seedance${version ? ' · ' + version : ''}${/fast/i.test(raw) ? ' · Fast' : ''}${act}`;
    }
    if (lower.includes('kling')) { const n = normalized.match(/\d+(?:\.\d+)?/); return `可灵${n ? ' ' + n[0] : ''}${/standard/i.test(raw) ? ' 标准版' : ''}${act}`; }
    if (lower.includes('hailuo')) return `海螺${act}`;
    const tr = s => s.replace(/\bimage edit\b/i, '图片编辑').replace(/\bimage to video\b/i, '图生视频').replace(/\btext to video\b/i, '文生视频');
    if (lower.includes('luma')) return tr(normalized.replace(/^luma/i, 'Luma'));
    if (lower.includes('vidu')) return tr(normalized.replace(/^vidu/i, 'Vidu'));
    if (lower.includes('gpt-image-2')) return `全能图片G2${act}`;
    if (lower.includes('nano-banana-pro')) return `全能图片Pro${act}`;
    if (lower.includes('nano-banana')) return `全能图片${act}`;
    if (lower.includes('qwen-image')) return `通义千问图像${lower.includes('pro') ? ' Pro' : ''}${act}`;
    if (lower.includes('seedream')) return `即梦 Seedream${act}`;
    return raw;
}
export function modelDisplayName(model, item, fetchedNames) {
    return isRunningHubLike(item) ? runningHubReadableModelName(model, item, fetchedNames) : String(model || '');
}
// 选择模型弹窗里的厂商角标：RunningHub 沿用旧规则；其他平台按模型系列取一个短标（效果图同款）
export function modelBadge(model, label, item) {
    const text = `${model || ''} ${label || ''}`.toLowerCase();
    if (isRunningHubLike(item)) {
        if (text.includes('gpt-image')) return 'G';
        if (text.includes('nano')) return 'N';
        if (text.includes('qwen')) return 'Q';
        if (text.includes('seedream')) return 'S';
        if (text.includes('seedance')) return 'SD';
        if (text.includes('wan') || text.includes('万相')) return 'W';
        if (text.includes('jimeng') || text.includes('即梦')) return 'J';
        if (text.includes('luma')) return 'L';
        if (text.includes('vidu')) return 'V';
        if (text.includes('alibaba') || text.includes('阿里')) return 'A';
        if (text.includes('bytedance') || text.includes('字节')) return 'B';
        return 'RH';
    }
    const families = [['gemini', 'GEMINI'], ['nano', 'NANO'], ['gpt', 'GPT'], ['claude', 'CLAUDE'], ['seedream', 'SEED'], ['seedance', 'SEED'], ['doubao', 'DOUBAO'], ['veo', 'VEO'], ['kling', 'KLING'], ['qwen', 'QWEN'], ['flux', 'FLUX'], ['deepseek', 'DEEPSEEK'], ['grok', 'GROK'], ['sora', 'SORA'], ['wan', 'WAN'], ['vidu', 'VIDU'], ['hailuo', 'HAILUO'], ['minimax', 'MINIMAX'], ['o1', 'GPT'], ['o3', 'GPT'], ['o4', 'GPT']];
    const hit = families.find(([k]) => text.includes(k));
    if (hit) return hit[1];
    const seg = String(model || '').split(/[\/:]/).pop().split(/[-_.\s]/)[0] || '';
    return seg.slice(0, 6).toUpperCase() || '—';
}

/* —— 单模型协议覆盖 / 视频厂商 —— */
// Gemini 图像模型名：只认「gemini + image」组合，Gemini 文本模型走 OpenAI 兼容 chat 路径
export function looksLikeGeminiImageModel(model) {
    const name = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return name.indexOf('gemini') === 0 && name.indexOf('image') >= 0;
}
export function inferredModelProtocol(kind, model) { return kind === 'image' && looksLikeGeminiImageModel(model) ? 'gemini' : ''; }
export function inferVideoVendor(model) {
    const name = String(model || '').trim().toLowerCase();
    if (!name) return '';
    const hit = VIDEO_VENDOR_RULES.find(rule => rule[1].test(name));
    return hit ? hit[0] : '';
}
export function modelStillUsed(item, name) {
    if (!item || !name) return false;
    return ['image_models', 'chat_models', 'video_models'].some(k => Array.isArray(item[k]) && item[k].includes(name));
}

/* —— RunningHub 应用 / 工作流条目规整（保存时用，与旧 normalizeRhEntries 一致） —— */
export function parseRunningHubRunRef(value) {
    const text = String(value || '').trim();
    const match = text.match(/\/run\/(ai-app|workflow)\/([0-9A-Za-z_-]+)/i);
    if (match) return { type: match[1].toLowerCase() === 'ai-app' ? 'app' : 'workflow', id: match[2] };
    if (/^[0-9]{8,}$/.test(text)) return { type: 'workflow', id: text };
    return null;
}
const RH_EDITOR_KNOWN_FIELD_OPTIONS = {
    sampler_name: ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'uni_pc'],
    sampler: ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'uni_pc'],
    scheduler: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'],
    ratio: ['1:1', '16:9', '9:16', '21:9', '9:21', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'],
    aspectRatio: ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'],
    resolution: ['512', '768', '1024', '1280', '1536', '2048', '1k', '2k', '4k'],
    size: ['512', '768', '1024', '1280', '1536', '2048'],
    ckpt_name: [], unet_name: [], lora_name: [],
};
function rhKnownOptionsForField(field) {
    const name = String((field && field.fieldName) || '').trim();
    if (!name) return [];
    if (RH_EDITOR_KNOWN_FIELD_OPTIONS[name]) return RH_EDITOR_KNOWN_FIELD_OPTIONS[name].map(String);
    const hit = Object.keys(RH_EDITOR_KNOWN_FIELD_OPTIONS).find(k => k.toLowerCase() === name.toLowerCase());
    return hit ? RH_EDITOR_KNOWN_FIELD_OPTIONS[hit].map(String) : [];
}
function rhWorkflowFieldKind(field) {
    const type = String((field && field.fieldType) || '').toUpperCase();
    if (['IMAGE', 'VIDEO', 'AUDIO', 'BOOLEAN', 'NUMBER', 'FLOAT', 'INT', 'INTEGER', 'TEXT', 'SLIDER'].includes(type)) {
        return type === 'FLOAT' || type === 'INT' || type === 'INTEGER' ? 'NUMBER' : type;
    }
    const key = `${(field && field.fieldName) || ''} ${(field && field.fieldValue) || ''}`.toLowerCase();
    if (/image|img|mask|png|jpg|jpeg|webp/.test(key)) return 'IMAGE';
    if (/video|mp4|webm|mov/.test(key)) return 'VIDEO';
    if (/audio|wav|mp3|voice|sound/.test(key)) return 'AUDIO';
    if (/true|false/.test(key)) return 'BOOLEAN';
    if (/^-?\d+(\.\d+)?$/.test(String((field && field.fieldValue) || '').trim())) return 'NUMBER';
    return 'TEXT';
}
// 与旧 normalizeRhWorkflowField 一致（保存时把字段规整成后端要的形状）
function normalizeRhWorkflowField(field) {
    const f = field || {};
    const options = Array.isArray(f.options)
        ? f.options.map(o => String(o ?? '').trim()).filter(Boolean)
        : String(f.options || '').split(/\r?\n|,/).map(o => o.trim()).filter(Boolean);
    const knownOptions = options.length ? options : rhKnownOptionsForField(f);
    const fieldType = String(f.fieldType || rhWorkflowFieldKind(f));
    const normalizedType = fieldType.toUpperCase();
    const savedSource = f.sourceFromUpstream;
    return {
        id: String(f.id || `${f.nodeId || ''}::${f.fieldName || ''}`),
        nodeId: String(f.nodeId || ''),
        fieldName: String(f.fieldName || ''),
        fieldValue: f.fieldValue == null ? '' : String(f.fieldValue),
        fieldType: knownOptions.length && !['IMAGE', 'VIDEO', 'AUDIO', 'SLIDER'].includes(normalizedType) ? 'SELECT' : fieldType,
        label: String(f.label || f.fieldName || ''),
        enabled: f.enabled === true,
        sourceFromUpstream: savedSource === undefined ? false : savedSource !== false,
        group: String(f.group || ''),
        note: String(f.note || ''),
        options: knownOptions,
        random_enabled: f.random_enabled === true,
        min: f.min ?? '',
        max: f.max ?? '',
        step: f.step ?? '',
        imageOrder: Number(f.imageOrder || f.image_order || 0) || 0,
        required: f.required === true,
    };
}
export function normalizeRhEntries(values, kind) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(raw => {
        const parsed = parseRunningHubRunRef((raw && (raw.appId || raw.workflowId || raw.id)) || '');
        const id = String((parsed && parsed.id) || (raw && (raw.id || raw.appId || raw.workflowId)) || '').trim();
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
        else { entry.workflowId = id; entry.optionalImageMode = String(raw.optionalImageMode || 'prune-workflow'); }
        return entry;
    }).filter(Boolean);
}

export function runninghubModelSourceNote(data) {
    const raw = (data && data.raw) || {};
    const source = String(raw.source || '').toLowerCase();
    const label = { openapi: '官方 OpenAPI', github: 'GitHub 注册表', local: '本地注册表', llm: 'LLM 网关', fallback: '内置兜底' }[source] || '';
    const parts = [];
    if (label) parts.push(`来源：${label}`);
    if (raw.openapi_count !== undefined) parts.push(`直连 ${Number(raw.openapi_count || 0)}`);
    if (raw.llm_count !== undefined) parts.push(`LLM ${Number(raw.llm_count || 0)}`);
    const text = parts.join(' · ');
    return text ? ` · ${text}${source === 'fallback' ? ' · 官方模型列表未拉到完整数据' : ''}` : '';
}
export function hostOfUrl(url) { try { return new URL(url).host; } catch (e) { return url || ''; } }
