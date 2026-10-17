// 素材库页的共享状态（单例）。旧 asset-manager.js 里一百多个 let 全局变量按「区域」收进这里，
// 组件 v-show 常驻，状态天然跨标签保留；各区域的动作在 library.js / local.js / prompts.js / workflows.js / canvas.js。
import { reactive } from 'vue';
import { apiJson } from './util.js';

export const MEDIA_TABS = ['assets', 'canvas-assets', 'local'];
const LAST_MEDIA_TAB_KEY = 'asset_manager_media_source_v1';
const LOCAL_CAPTION_SETTINGS_KEY = 'asset_manager_local_caption_settings_v1';

export function lastMediaTab() {
    try { const v = localStorage.getItem(LAST_MEDIA_TAB_KEY); return MEDIA_TABS.includes(v) ? v : 'assets'; } catch (e) { return 'assets'; }
}
function readCaptionSettings() {
    try { const d = JSON.parse(localStorage.getItem(LOCAL_CAPTION_SETTINGS_KEY) || '{}'); return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; }
}
const savedCaption = readCaptionSettings();

export const S = reactive({
    status: '准备就绪',
    loaded: false,
    tab: lastMediaTab(),
    // 类型筛选（'' = 全部）：三个媒体面板共用同一份，切换面板 / 来源时保持一致
    kind: '',
    assetLibrary: { libraries: [], categories: [] },
    promptLibrary: { libraries: [] },
    providers: [],
    canvasData: { categories: [], canvases: [], items: [] },
    localAssets: [],
    localTree: null,
    // 反推 / 智能分类的平台、模型、提示词（本机记忆，key 与旧版一致）
    caption: {
        provider: savedCaption.provider || '',
        model: savedCaption.model || '',
        prompt: savedCaption.captionPrompt || '描述图片',
        classifyPrompt: savedCaption.classifyPrompt || '',
    },
    preview: null,      // Lightbox：{ url, kind, name }
    ask: null,          // 应用内确认 / 输入弹窗（代替旧版 window.prompt / confirm / alert）
    prefsOpen: false,
});

export function setStatus(text = '准备就绪') { S.status = text || '准备就绪'; }
export function fail(err, fallback = '操作失败') { setStatus((err && err.message) || fallback); }

export function setTab(tab) {
    if (tab === S.tab) return;
    S.tab = tab;
    // 与旧版一致：切换标签清空所有多选
    window.dispatchEvent(new CustomEvent('am-clear-selection'));
    if (MEDIA_TABS.includes(tab)) { try { localStorage.setItem(LAST_MEDIA_TAB_KEY, tab); } catch (e) {} }
}

/* ───────── 反推 / 分类设置 ───────── */
export function writeCaptionSettings() {
    try {
        localStorage.setItem(LOCAL_CAPTION_SETTINGS_KEY, JSON.stringify({
            provider: S.caption.provider || '',
            model: S.caption.model || '',
            captionPrompt: S.caption.prompt || '描述图片',
            classifyPrompt: S.caption.classifyPrompt || '',
        }));
    } catch (e) {}
}
export function captionProviders() {
    return (S.providers || []).filter(p => p && p.enabled !== false && p.has_key !== false && Array.isArray(p.chat_models) && p.chat_models.length);
}
export function normalizeCaption() {
    const providers = captionProviders();
    const before = S.caption.provider + '|' + S.caption.model;
    if (!providers.length) {
        S.caption.provider = '';
        S.caption.model = '';
    } else {
        const p = providers.find(x => x.id === S.caption.provider) || providers[0];
        S.caption.provider = p.id || '';
        const models = (p.chat_models || []).filter(Boolean);
        if (!S.caption.model) S.caption.model = models[0] || '';
    }
    if (before !== S.caption.provider + '|' + S.caption.model) writeCaptionSettings();
}
export function captionModels() {
    const p = captionProviders().find(x => x.id === S.caption.provider);
    const models = (p?.chat_models || []).filter(Boolean);
    // 用户已选的模型可能不在当前平台列表里，前置显示并保持选中，避免被静默换掉
    return S.caption.model && !models.includes(S.caption.model) ? [S.caption.model, ...models] : models;
}
export function setCaptionProvider(id) {
    S.caption.provider = id || '';
    S.caption.model = '';
    normalizeCaption();
    writeCaptionSettings();
}
export function setCaptionModel(m) { S.caption.model = m || ''; writeCaptionSettings(); }
export function ensureCaptionModel() {
    normalizeCaption();
    if (!S.caption.provider || !S.caption.model) { setStatus('请先在 API 设置中配置可用的聊天/视觉模型'); return false; }
    return true;
}

/* ───────── 弹窗 / 预览 ───────── */
// ask({ title, desc, input: true, value, placeholder, ok, cancel, danger }) → 输入框返回字符串（取消为 null），否则返回 true/false
export function ask(opts) {
    return new Promise(resolve => {
        if (S.ask) S.ask.resolve(opts.input ? null : false);
        S.ask = { ok: '确定', cancel: '取消', ...opts, value: opts.value || '', resolve };
    });
}
export function notify(title, desc) { return ask({ title, desc, cancel: '' }); }
export function openPreview(url, kind, name) {
    if (!['image', 'video'].includes(kind)) { setStatus('仅图片和视频支持预览'); return; }
    if (!url) return;
    S.preview = { url, kind, name: name || 'preview' };
}

/* ───────── 加载 ───────── */
export async function loadProviders() {
    try { const d = await apiJson('/api/providers'); S.providers = Array.isArray(d.providers) ? d.providers : []; } catch (e) { /* 保留旧数据 */ }
    normalizeCaption();
}
export function setCanvasData(d) {
    S.canvasData = {
        categories: Array.isArray(d?.categories) ? d.categories : [],
        canvases: Array.isArray(d?.canvases) ? d.canvases : [],
        items: Array.isArray(d?.items) ? d.items : [],
    };
}
export async function loadLocalAssets() {
    try {
        const data = await apiJson('/api/local-assets');
        S.localAssets = Array.isArray(data.items) ? data.items : [];
        S.localTree = data.tree || { id: '__root__', path: '', name: '全部上传', count: S.localAssets.length, items: [], children: [] };
    } catch (err) {
        S.localAssets = [];
        S.localTree = { id: '__root__', path: '', name: '全部上传', count: 0, items: [], children: [] };
    }
    window.dispatchEvent(new CustomEvent('am-local-loaded'));
    return S.localAssets;
}
// 刷新：与旧版 loadAll 一致——四份数据并行拉，资产库回到「默认资产库」，清空多选
export async function loadAll() {
    setStatus('加载中...');
    const [assetData, promptData, providerData, canvasData] = await Promise.all([
        apiJson('/api/asset-library'),
        apiJson('/api/prompt-libraries'),
        apiJson('/api/providers').catch(() => ({ providers: [] })),
        apiJson('/api/canvas-assets').catch(() => ({ categories: [], canvases: [], items: [] })),
        loadLocalAssets(),
    ]);
    S.assetLibrary = assetData.library || { libraries: [], categories: [] };
    S.promptLibrary = promptData.library || { libraries: [] };
    S.providers = Array.isArray(providerData.providers) ? providerData.providers : [];
    setCanvasData(canvasData);
    normalizeCaption();
    S.loaded = true;
    window.dispatchEvent(new CustomEvent('am-reloaded'));
    setStatus('准备就绪');
}
// 静默刷新（外壳广播 asset_library_updated、切回本页时用）：只换数据，不重置当前位置和选择
export async function softReload(parts = ['assets', 'canvas', 'local']) {
    try {
        const jobs = [];
        if (parts.includes('assets')) jobs.push(apiJson('/api/asset-library').then(d => { if (d.library) S.assetLibrary = d.library; }));
        if (parts.includes('canvas')) jobs.push(apiJson('/api/canvas-assets').then(setCanvasData));
        if (parts.includes('local')) jobs.push(loadLocalAssets());
        if (parts.includes('prompts')) jobs.push(apiJson('/api/prompt-libraries').then(d => { if (d.library) S.promptLibrary = d.library; }));
        await Promise.all(jobs.map(j => j.catch(() => {})));
    } catch (e) {}
}

// 组件里调用异步动作的统一出口：出错写到状态栏（与旧版 handleClick(...).catch(setStatus) 一致）
export function run(job, fallback = '操作失败') {
    try { return Promise.resolve(typeof job === 'function' ? job() : job).catch(err => { fail(err, fallback); return false; }); }
    catch (err) { fail(err, fallback); return Promise.resolve(false); }
}
