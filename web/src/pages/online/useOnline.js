// 在线生图页面状态与动作（移植自 static/online.html 的主脚本）。页面只有一个实例，状态放模块级 reactive。
// 接口照旧：GET /api/config、POST /api/ai/upload（files）、POST /api/online-image、GET /api/history?type=online、
// GET /api/ai/size-policy（sizePolicy.load）。
import { reactive, computed } from 'vue';
import { t, toast } from '../../lib/store.js';
import { NovaSizePolicy } from './sizePolicy.js';
import { normalizeSize, computeSize, matchSize, resolutionOptions, supportedRatios } from './onlineSizes.js';
import { imageProviders, providerById, providerModels, protocolOf, runningHubEntries, entryKey, modelsFromConfig, PROTOCOL_BADGE, QUALITY_PROTOCOLS } from './providers.js';
import { fetchHistory } from './download.js';

export const PAGE_SIZE = 24;

export const S = reactive({
    apiProviders: [], models: { gpt: 'gpt-image-2', nano: 'nano-banana-pro' },
    provider: 'comfly', model: 'gpt-image-2', quality: 'auto', count: 1,
    ratio: 'square', resolution: '1k', customRatioWidth: '', customRatioHeight: '', customWidth: '', customHeight: '',
    notice: '', policyTick: 0,
    prompt: '',
    slots: [0, 1, 2].map(() => ({ ref: null, dim: null, preview: '', uploading: false, token: 0 })),
    generating: false, result: null,
    history: [], shown: 0, status: 'first',
});

/* ───────── 平台 / 模型 ───────── */
export const providers = computed(() => imageProviders(S.apiProviders, S.models));
export const currentProvider = computed(() => providerById(S.apiProviders, S.models, S.provider) || {});
export const protocol = computed(() => protocolOf(currentProvider.value));
export const isRunningHub = computed(() => protocol.value === 'runninghub');
export const showQuality = computed(() => QUALITY_PROTOCOLS.has(protocol.value));
export const badge = computed(() => { const b = PROTOCOL_BADGE[protocol.value] || PROTOCOL_BADGE.api; return t(b[0], b[1]); });

export const providerOptions = computed(() => providers.value.map(p => {
    const b = PROTOCOL_BADGE[protocolOf(p)] || PROTOCOL_BADGE.api;
    return { value: p.id, label: p.name || p.id, tag: t(b[0], b[1]) };
}));
export const modelOptions = computed(() => {
    if (isRunningHub.value) {
        return runningHubEntries(currentProvider.value).map(e => {
            const tag = e.kind === 'model' ? '模型 API' : e.kind === 'workflow' ? t('online.rhWorkflow', '工作流') : t('online.rhApp', '应用');
            return { value: entryKey(e), label: `[${tag}] ${e.title || e.id}` };
        });
    }
    return providerModels(S.apiProviders, S.models, S.provider).map(m => ({ value: m, label: m }));
});

// 对应旧 renderProviderControls + updateAdaptivePanel：平台 / 模型失效时回退，RunningHub 数量固定为 1
function syncControls() {
    const list = providers.value;
    if (!list.some(p => p.id === S.provider)) S.provider = (list[0] && list[0].id) || 'comfly';
    const keys = modelOptions.value.map(o => o.value);
    if (!keys.includes(S.model)) S.model = keys[0] || (isRunningHub.value ? '' : S.models.gpt);
    if (isRunningHub.value) S.count = 1;
}

async function readConfig() {
    const cfg = await fetch('/api/config').then(r => r.json());
    S.models = modelsFromConfig(cfg);
    S.apiProviders = Array.isArray(cfg.api_providers) ? cfg.api_providers : [];
}
export async function initModels() {
    try { await readConfig(); S.model = providerModels(S.apiProviders, S.models, S.provider)[0] || S.models.gpt; } catch (e) {}
    syncControls(); applySize();
}
// API 设置保存后（providers-changed / workflows-changed / studio-api 广播 / 页面重新可见）重新拉 /api/config，尽量保留当前选择
let refreshTimer = null;
export function scheduleProviderRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        try { await readConfig(); } catch (e) { return; }
        syncControls(); applySize();
    }, 150);
}

export function setProvider(id) {
    S.notice = '';
    S.provider = id;
    S.model = providerModels(S.apiProviders, S.models, id)[0] || S.model;
    syncControls(); applySize();
}
export function setModel(v) { S.notice = ''; S.model = v; applySize(); }
export function setQuality(v) { S.quality = v || 'auto'; }
export function setCount(v) { S.count = Math.max(1, Math.min(4, parseInt(v, 10) || 1)); }

/* ───────── 尺寸 ───────── */
function setNotice(text) { S.notice = text; if (text) toast(text, { icon: 'ruler' }); }
export function applySize() {
    const st = { model: S.model, ratio: S.ratio, resolution: S.resolution };
    const text = normalizeSize(st);
    S.ratio = st.ratio; S.resolution = st.resolution;
    if (text) setNotice(text);
}
export function setRatio(v, preferredSize = '') {
    S.notice = '';
    S.ratio = v;
    if (preferredSize) {
        const m = matchSize(S.model, preferredSize);
        if (m.ratio === v && m.resolution !== 'custom') S.resolution = m.resolution;
    }
    if (v !== 'custom') { S.customRatioWidth = ''; S.customRatioHeight = ''; }
    applySize();
}
export function setResolution(v) {
    S.notice = '';
    S.resolution = v;
    if (v === 'custom') S.ratio = '';
    else { S.customWidth = ''; S.customHeight = ''; if (S.ratio === '') S.ratio = 'square'; }
    applySize();
}
export function setCustomSize(w, h) { S.customWidth = w; S.customHeight = h; S.resolution = 'custom'; S.ratio = ''; applySize(); }
export function setCustomRatio(w, h) { S.customRatioWidth = w; S.customRatioHeight = h; S.ratio = 'custom'; applySize(); }
export const firstRefDim = computed(() => (S.slots.find(s => s.dim && s.dim.width && s.dim.height) || {}).dim || null);
export function fitToImage() {
    const d = firstRefDim.value;
    if (!d) return;
    S.resolution = 'custom'; S.ratio = ''; S.customWidth = d.width; S.customHeight = d.height;
    applySize();
}
export const ratioOptions = computed(() => {
    void S.policyTick;
    return [
        { value: '', label: t('online.emptyRatio', '比例为空'), shape: { w: 12, h: 12, dashed: true }, disabled: true },
        ...supportedRatios(S.model).map(r => ({ value: r.id, label: r.i18n ? t(r.i18n, r.label) : r.label, shape: { w: r.w, h: r.h } })),
        { value: 'custom', label: t('online.customRatio', '自定义比例'), shape: { w: 12, h: 12, dashed: true }, sep: true },
    ];
});
export const resOptions = computed(() => {
    void S.policyTick;
    return [...resolutionOptions(S.model, S.ratio), { value: 'custom', label: t('online.customSize', '自定义尺寸'), sep: true }];
});
export const currentSize = () => computeSize(S);
// 尺寸策略先拉起来（不 await）；到位后重刷尺寸（enum 模型的可用尺寸要等策略）
export function loadPolicy() { return NovaSizePolicy.load().then(() => { S.policyTick++; applySize(); }); }

/* ───────── 参考图 ───────── */
function imageDims(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = reject;
        img.src = src;
    });
}
export function clearSlot(i) { const s = S.slots[i]; s.ref = null; s.dim = null; s.preview = ''; s.uploading = false; s.token++; }
export function firstEmptySlot() { const i = S.slots.findIndex(s => !s.ref && !s.preview); return i < 0 ? 0 : i; }
export async function handleFile(i, file) {
    if (!file) return;
    const s = S.slots[i];
    const token = ++s.token;
    s.ref = null; s.uploading = true;
    const reader = new FileReader();
    reader.onload = e => {
        if (s.token !== token) return;
        s.preview = e.target.result;
        imageDims(s.preview).then(d => { if (s.token === token) s.dim = d; }).catch(() => {});
    };
    reader.readAsDataURL(file);
    try {
        const form = new FormData();
        form.append('files', file);
        const data = await fetch('/api/ai/upload', { method: 'POST', body: form }).then(r => r.json());
        if (s.token !== token) return;
        if (!data || !data.files || !data.files[0]) throw new Error('upload failed');
        s.ref = data.files[0];
    } catch (e) {
        if (s.token !== token) return;
        clearSlot(i);
        toast('参考图上传失败', { danger: true, icon: 'alert' });
    } finally { if (s.token === token) s.uploading = false; }
}
function setSlotFromRef(i, ref) {
    const s = S.slots[i];
    s.token++; s.ref = ref; s.preview = ref.url; s.uploading = false;
    const token = s.token;
    imageDims(ref.url).then(d => { if (s.token === token) s.dim = d; }).catch(() => {});
}

/* ───────── 生成 ───────── */
function addHistory(item, front) {
    if (!item || !item.images || !item.images[0]) return;
    if (S.history.some(h => String(h.timestamp) === String(item.timestamp))) return;
    if (front) { S.history.unshift(item); S.shown++; } else S.history.push(item);
}
export async function submit() {
    const prompt = S.prompt.trim();
    if (!prompt) { toast(t('online.promptRequired', '请输入提示词'), { danger: true, icon: 'alert' }); return; }
    if (S.slots.some(s => s.uploading)) { toast('参考图还在上传，请稍候', { icon: 'clock' }); return; }
    // 尺寸为空 = 当前「比例 + 档位」在该模型下没有合法尺寸，出声而不是拿别的尺寸顶替
    const size = currentSize();
    if (!size) { toast('当前比例在该分辨率下没有可用尺寸，请改选其它档位或比例', { danger: true, icon: 'alert' }); return; }
    S.generating = true; S.result = null;
    try {
        const body = { prompt, provider_id: S.provider, model: S.model, size, n: S.count, reference_images: S.slots.map(s => s.ref).filter(Boolean) };
        if (showQuality.value) body.quality = S.quality;
        const r = await fetch('/api/online-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) { let d = ''; try { d = (await r.json()).detail; } catch (e) {} throw new Error(typeof d === 'string' && d ? d : '生成失败'); }
        const result = await r.json();
        S.result = result;
        addHistory(result, true);
        if (result && result.size_notice) setNotice(result.size_notice);
    } catch (err) {
        toast((err && err.message) || '生成失败', { danger: true, icon: 'alert' });
    } finally { S.generating = false; }
}

// 「复用」：填回提示词、参考图（最多 3 张）和尺寸
export function applySameStyle(item) {
    if (!item) return;
    S.prompt = item.prompt || '';
    [0, 1, 2].forEach(clearSlot);
    const params = item.params || {};
    (params.reference_images || []).slice(0, 3).forEach((ref, i) => { if (ref && ref.url) setSlotFromRef(i, ref); });
    const m = matchSize(S.model, params.size || '1024x1024');
    if (m.resolution !== 'custom') { setRatio(m.ratio, params.size); setResolution(m.resolution); }
    else { setResolution('custom'); S.customWidth = m.customWidth; S.customHeight = m.customHeight; applySize(); }
}

/* ───────── 历史 ───────── */
export const visibleHistory = computed(() => S.history.slice(0, S.shown));
export const hasMore = computed(() => S.shown < S.history.length);
export async function loadHistory() {
    S.status = 'first';
    try {
        S.history = await fetchHistory('online');
        S.shown = Math.min(PAGE_SIZE, S.history.length);
        S.status = 'idle';
    } catch (e) { S.status = 'error'; }
}
export function loadMore() {
    if (S.status === 'error') { loadHistory(); return; }
    S.shown = Math.min(S.history.length, S.shown + PAGE_SIZE);
}
export function removeHistory(list) {
    const set = new Set(list.map(String));
    const before = S.history.length;
    S.history = S.history.filter(h => !set.has(String(h.timestamp)));
    S.shown = Math.max(0, S.shown - (before - S.history.length));
    if (S.result && set.has(String(S.result.timestamp))) S.result = null;
}
