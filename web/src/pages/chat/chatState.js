// GPT 对话 · 设置状态：模式 / 平台与模型 / 尺寸 / 思考强度 / 系统提示词，全部按旧版的 localStorage 结构持久化。
//   gpt_chat_settings_v1（同旧版字段）、gpt_chat_think_level、gpt_chat_browser_user
// 平台列表只认「已配置」的：启用 + 已填 Key + 有对应模型列表；都没有时回落旧版单 Key 模式（comfly）。
import { reactive, computed } from 'vue';
import { RATIO_KEYS, LEVELS, getSizeOptionsForModel, normalizeChatCustomSize, sizeFor, RATIO_LABELS } from './sizes.js';
import { getThinkLevels } from './thought.js';

export const CHAT_SETTINGS_KEY = 'gpt_chat_settings_v1';
export const THINK_KEY = 'gpt_chat_think_level';
const USER_KEY = 'gpt_chat_browser_user';
const CHAT_SIZE_MODE_VERSION = 2;

function readJSON(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}
function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
export function uuid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'u-' + Math.random().toString(16).slice(2) + Date.now();
}

let uid = '';
export function userId() {
    if (uid) return uid;
    try { uid = localStorage.getItem(USER_KEY) || ''; } catch (e) {}
    if (!uid) uid = uuid();
    try { localStorage.setItem(USER_KEY, uid); } catch (e) {}
    return uid;
}

const saved = readJSON(CHAT_SETTINGS_KEY);
const savedRes = saved.chatSizeModeVersion === CHAT_SIZE_MODE_VERSION && ['auto', '1k', '2k', '4k', 'custom'].includes(saved.chatResolution) ? saved.chatResolution : 'auto';

export const S = reactive({
    // 旧版把 mode 写进设置却总以 agent 启动（页面上没有切换按钮）；现在有了按钮，就按保存的值恢复
    mode: ['chat', 'agent', 'image'].includes(saved.mode) ? saved.mode : 'agent',
    provider: saved.provider || 'comfly',
    msModel: saved.msModel || '',
    activeChatModel: saved.activeChatModel || '',
    activeImageProvider: saved.activeImageProvider || 'comfly',
    activeImageModel: saved.activeImageModel || '',
    systemPrompt: String(saved.systemPrompt || '').trim(),
    activePersonaId: String(saved.activePersonaId || ''),
    chatProviderModels: isObject(saved.chatProviderModels) ? saved.chatProviderModels : {},
    chatRatio: RATIO_KEYS.includes(saved.chatRatio) ? saved.chatRatio : 'square',
    chatResolution: savedRes,
    chatPresetResolution: LEVELS.includes(saved.chatPresetResolution) ? saved.chatPresetResolution : (savedRes === 'custom' || savedRes === 'auto' ? '1k' : savedRes),
    chatCustomSize: normalizeChatCustomSize(saved.chatCustomSize || '') || '1024x1024',
    modelPickerScope: saved.modelPickerScope === 'image' ? 'image' : 'chat',
    thinkLevel: (() => { try { return localStorage.getItem(THINK_KEY) || 'mid'; } catch (e) { return 'mid'; } })(),
    apiProviders: [],
    config: { chat_models: [], image_models: [], ms_chat_models: [], has_api_key: false },
});

export function saveSettings() {
    try {
        localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({
            mode: S.mode, provider: S.provider, msModel: S.msModel, activeChatModel: S.activeChatModel,
            activeImageProvider: S.activeImageProvider, activeImageModel: S.activeImageModel,
            systemPrompt: S.systemPrompt, activePersonaId: S.activePersonaId, chatProviderModels: S.chatProviderModels,
            chatRatio: S.chatRatio, chatResolution: S.chatResolution, chatPresetResolution: S.chatPresetResolution,
            chatCustomSize: S.chatCustomSize, modelPickerScope: S.modelPickerScope, chatSizeModeVersion: CHAT_SIZE_MODE_VERSION,
        }));
    } catch (e) {}
}
export function setThinkLevel(k) {
    S.thinkLevel = k;
    try { localStorage.setItem(THINK_KEY, k); } catch (e) {}
}

/* ───────── 平台 / 模型 ───────── */
export function uniqueModels(list) {
    const seen = new Set();
    return (list || []).map(x => String(x || '').trim()).filter(x => x && !seen.has(x) && seen.add(x));
}
function configuredProviders(kind) {
    const key = kind === 'image' ? 'image_models' : 'chat_models';
    return (S.apiProviders || []).filter(p => p.enabled !== false && p.has_key !== false && (p[key] || []).length);
}
function legacyComflyProviders(kind) {
    if (!S.config.has_api_key) return [];
    const models = uniqueModels(kind === 'image' ? S.config.image_models : S.config.chat_models);
    if (!models.length) return [];
    return [{ id: 'comfly', name: 'API', chat_models: kind === 'chat' ? models : [], image_models: kind === 'image' ? models : [] }];
}
export function providersOf(kind) {
    const list = configuredProviders(kind);
    return list.length ? list : legacyComflyProviders(kind);
}
export function providerById(id, kind = 'chat') {
    const list = providersOf(kind);
    return list.find(p => p.id === id) || list[0] || null;
}
export const pickerKind = computed(() => (S.mode === 'image' ? 'image' : (S.mode === 'agent' ? S.modelPickerScope : 'chat')));
export function currentProviderId(kind = pickerKind.value) { return kind === 'image' ? S.activeImageProvider : S.provider; }
export function modelsOf(pid, kind) {
    const p = providerById(pid, kind);
    return p ? uniqueModels(kind === 'image' ? p.image_models : p.chat_models) : [];
}
export function currentModel(kind = pickerKind.value) {
    return kind === 'image' ? S.activeImageModel : (S.provider === 'modelscope' ? (S.msModel || S.activeChatModel) : S.activeChatModel);
}
export function providerName(id, kind = pickerKind.value) {
    const p = providerById(id, kind);
    return p ? (p.name || p.id) : '未配置平台';
}
export function shortModelName(v) { return String(v || '').split('/').pop().split(':')[0] || 'Model'; }
// 对话请求里的 model 字段（modelscope 走 ms_model）
export function chatModelForRequest() { return S.provider === 'modelscope' ? (S.msModel || S.activeChatModel) : S.activeChatModel; }

// 旧 renderProviderControls 的状态部分：当前作用域的平台 / 模型不在列表里就回落到第一个
export function normalizeProviderControls() {
    const kind = pickerKind.value;
    const list = providersOf(kind);
    if (!list.some(p => p.id === currentProviderId(kind))) {
        if (kind === 'image') S.activeImageProvider = (list[0] && list[0].id) || '';
        else S.provider = (list[0] && list[0].id) || '';
    }
    const models = modelsOf(currentProviderId(kind), kind);
    if (kind === 'image' && !models.includes(S.activeImageModel)) S.activeImageModel = models[0] || '';
    if (kind !== 'image' && !models.includes(S.activeChatModel)) {
        const rem = S.chatProviderModels[S.provider];
        S.activeChatModel = rem && models.includes(rem) ? rem : (models[0] || '');
    }
    if (kind !== 'image' && S.provider === 'modelscope') S.msModel = S.activeChatModel;
}

function validateSavedProviderState() {
    const chatList = providersOf('chat');
    S.provider = chatList.some(p => p.id === S.provider) ? S.provider : ((chatList[0] && chatList[0].id) || '');
    const chatModels = modelsOf(S.provider, 'chat');
    const rem = S.chatProviderModels[S.provider];
    S.activeChatModel = chatModels.includes(S.activeChatModel) ? S.activeChatModel : (chatModels.includes(rem) ? rem : (chatModels[0] || ''));
    S.chatProviderModels[S.provider] = S.activeChatModel;
    if (S.provider === 'modelscope') S.msModel = S.activeChatModel;
    const imgList = providersOf('image');
    S.activeImageProvider = imgList.some(p => p.id === S.activeImageProvider) ? S.activeImageProvider : ((imgList[0] && imgList[0].id) || '');
    const imgModels = modelsOf(S.activeImageProvider, 'image');
    S.activeImageModel = imgModels.includes(S.activeImageModel) ? S.activeImageModel : (imgModels[0] || '');
    if (S.mode === 'chat') S.modelPickerScope = 'chat';
    if (S.mode === 'image') S.modelPickerScope = 'image';
}

export async function loadConfig() {
    try {
        const data = await fetch('/api/config').then(r => r.json());
        const cfg = { ...S.config, ...data };
        // 服务端下发的 chat_model / image_model 是遗留默认名，聊天页不拿它们做默认
        delete cfg.chat_model; delete cfg.image_model;
        S.config = cfg;
        S.apiProviders = Array.isArray(cfg.api_providers) ? cfg.api_providers : [];
        validateSavedProviderState();
        normalizeProviderControls();
        syncThinkToModel();
        normalizeSize();
        saveSettings();
    } catch (e) {}
}

export function setProvider(pid, kind = pickerKind.value) {
    if (kind === 'image') S.activeImageProvider = pid;
    else S.provider = pid;
    const models = modelsOf(pid, kind);
    if (kind === 'image') S.activeImageModel = models[0] || S.activeImageModel;
    else {
        const rem = S.chatProviderModels[S.provider];
        S.activeChatModel = rem && models.includes(rem) ? rem : (models[0] || S.activeChatModel);
        if (S.provider === 'modelscope') S.msModel = S.activeChatModel;
    }
    afterModelChange();
}
export function setActiveModel(model, kind = pickerKind.value) {
    if (kind === 'image') S.activeImageModel = model;
    else {
        S.activeChatModel = model;
        S.chatProviderModels[S.provider] = model;
        if (S.provider === 'modelscope') S.msModel = model;
    }
    afterModelChange();
}
function afterModelChange() { normalizeProviderControls(); syncThinkToModel(); normalizeSize(); saveSettings(); }

export function setModelPickerScope(kind) {
    S.modelPickerScope = kind === 'image' ? 'image' : 'chat';
    normalizeProviderControls();
    syncThinkToModel();
    saveSettings();
}
export function setMode(next) {
    S.mode = ['chat', 'agent', 'image'].includes(next) ? next : 'chat';
    if (S.mode === 'chat') S.modelPickerScope = 'chat';
    if (S.mode === 'image') S.modelPickerScope = 'image';
    normalizeProviderControls();
    syncThinkToModel();
    saveSettings();
}

/* ───────── 思考强度：仅支持推理的对话模型显示，档位按模型能力裁剪 ───────── */
export const thinkLevels = computed(() => getThinkLevels(S.activeChatModel, providersOf('chat')));
export function syncThinkToModel() {
    const levels = thinkLevels.value;
    if (levels && levels.length && !levels.includes(S.thinkLevel)) S.thinkLevel = levels[0];
}

/* ───────── 尺寸 ───────── */
export const sizeOpts = computed(() => getSizeOptionsForModel(S.activeImageModel));
export function sizeOf(label = S.chatResolution) { return sizeFor(sizeOpts.value, S.chatRatio, label, S.chatCustomSize); }
export const sizeLabel = computed(() => {
    if (S.chatResolution === 'auto') return '自动';
    if (S.chatResolution === 'custom') return '自定义 · ' + sizeOf();
    return `${RATIO_LABELS[S.chatRatio] || '1:1'} · ${S.chatPresetResolution.toUpperCase()} · ${sizeOf(S.chatPresetResolution)}`;
});
// 旧 updateChatResolutionUI 的状态部分：档位 / 自定义尺寸规整；当前模型不支持的比例自动换到可用的
export function normalizeSize() {
    if (!LEVELS.includes(S.chatPresetResolution)) S.chatPresetResolution = '1k';
    const custom = normalizeChatCustomSize(S.chatCustomSize) || '1024x1024';
    if (S.chatCustomSize !== custom) S.chatCustomSize = custom;
    const opts = sizeOpts.value;
    if (!opts[S.chatRatio]) S.chatRatio = opts.portrait ? 'portrait' : (opts.landscape ? 'landscape' : 'square');
}
export function setRatio(next) {
    S.chatRatio = next;
    if (S.chatResolution !== 'auto' && S.chatResolution !== 'custom') S.chatResolution = S.chatPresetResolution;
    normalizeSize();
    saveSettings();
}
export function setResolution(next) {
    const n = ['auto', '1k', '2k', '4k', 'custom'].includes(next) ? next : 'auto';
    if (LEVELS.includes(n)) S.chatPresetResolution = n;
    S.chatResolution = n;
    normalizeSize();
    saveSettings();
}
export function setResolutionScope(scope) {
    if (scope === 'auto') { S.chatResolution = 'auto'; normalizeSize(); saveSettings(); }
    else if (scope === 'custom') setResolution('custom');
    else {
        let r = S.chatPresetResolution || '1k';
        if (r === 'auto') r = '1k';
        S.chatResolution = r;
        S.chatPresetResolution = r;
        normalizeSize();
        saveSettings();
    }
}
// 返回 true = 已应用
export function applyCustomSize(w, h) {
    const n = normalizeChatCustomSize(`${w}x${h}`);
    if (!n) return false;
    S.chatCustomSize = n;
    setResolutionScope('custom');
    return true;
}
