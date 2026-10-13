// API 设置的状态与动作（对应旧 api-settings.js 的 providers / selectedId / 表单输入框 / renderEditor / syncEditor / saveProviders …）。
// 旧代码把表单输入框当作「草稿」，保存或切换平台时 syncEditor 写回 provider 对象；这里用 form 对象保留同样的语义。
import { reactive, computed, watch } from 'vue';
import { toast, t } from '../../../../lib/store.js';
import { broadcast } from '../../../../lib/bridge.js';
import {
    API_PROTOCOLS, BUILTIN_IDS, CLI_PROVIDER_PRESETS, FIXED_PROTOCOL_PROVIDER_IDS, MS_BUILTIN_IMAGE_MODELS,
    RH_DEFAULT_BASE_URL, VOLCENGINE_DEFAULT_BASE_URL, VOLCENGINE_DEFAULT_PROJECT_NAME, VOLCENGINE_DEFAULT_REGION, ONBOARDING_GUIDES,
    modelListKey,
} from './constants.js';
import {
    unique, normalizeId, deriveIdFromName, normalizeMaxConcurrency, normalizeUseProxy, normalizeImageRequestMode, normalizeImageEditRoute,
    normalizeLoraStrength, isCliProtocol, isFixedProvider, isLovartContext, applyCliProtocolDefaults, applyLovartProtocolDefaults,
    applyJimengModels, lockedRecommendedApi, applyLockedRecommendedProtocol, normalizeRhEntries, modelDisplayName, modelStillUsed,
    applyRegistryPresets,
} from './helpers.js';
import { installNetwork } from './apiNetwork.js';

// 与旧 broadcastStudioApiChange 一致：BroadcastChannel + 外壳转发给所有旧页面 iframe
export function broadcastStudioApiChange(type = 'providers-changed') {
    const message = { type, updated_at: Date.now() };
    try { new BroadcastChannel('studio-api').postMessage(message); } catch (e) {}
    try { broadcast(message); } catch (e) {}
}

const ORDER = ['modelscope', 'runninghub', 'volcengine', 'lovart'];
export function providerGroupOf(item) { return isFixedProvider(item) ? 'builtin' : isCliProtocol(item.protocol) ? 'cli' : 'custom'; }

export function createApiStore() {
    const S = reactive({
        providers: [],
        selectedId: '',
        loaded: false,
        loadFailed: false,
        view: 'provider',          // provider | recommend | storage
        form: { name: '', base: '', protocol: 'openai', imageMode: 'openai', maxConc: 0, useProxy: 'auto', key: '', rhFree: '', rhWallet: '' },
        keyRevealed: false,
        verify: null,              // { state, loading, blocks:[{tone,text}], raw:{code,json} }
        connResults: {},           // { [providerId]: { state, ms, count, protocol, text } }
        testing: false,
        fetching: false,
        saving: false,
        fetched: { all: [], suggestion: null, names: {} },
        pickerReady: false,
        pickerOpen: false,
        fetchHint: null,           // { kind:'ok'|'error', text }
        modelGroup: 'all',
        modelSearch: '',
        recommendFilter: 'all',
        recommendOpen: -1,
        switcherOpen: false,
        stuck: false,              // 内容滚动后页头吸顶样式
        cliFlash: 0,               // 「新增平台 → 本机 CLI」时闪一下 CLI 快捷按钮
        focusName: 0,              // 新建平台后聚焦平台名称输入框
        dirty: false,
        childDirty: false,
        confirm: null,             // { title, desc, ok, danger, resolve }
    });

    /* ── 选中平台 / 派生状态 ── */
    const visibleProviders = () => S.providers || [];
    const provider = () => visibleProviders().find(p => p.id === S.selectedId) || visibleProviders()[0] || S.providers[0] || null;
    const item = computed(() => provider());
    function sortedProviders() {
        return [...visibleProviders()].sort((a, b) => {
            const ai = ORDER.indexOf(a.id), bi = ORDER.indexOf(b.id);
            if (ai === -1 && bi === -1) return 0;
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    }
    const protocolNow = computed(() => String(S.form.protocol || (item.value && item.value.protocol) || '').toLowerCase());
    const flags = computed(() => {
        const it = item.value;
        const p = protocolNow.value;
        const locked = it ? lockedRecommendedApi(it) : null;
        const isLovart = isLovartContext(it, S.form.protocol);
        const isCli = isCliProtocol(p);
        const id = it && it.id;
        return {
            locked,
            isLovart,
            isCli,
            isMs: id === 'modelscope',
            isRh: id === 'runninghub',
            isVolc: id === 'volcengine' || p === 'volcengine',
            isJimeng: p === 'jimeng',
            isCodex: p === 'codex',
            isGeminiCli: p === 'gemini-cli',
            protocolLocked: !!it && (FIXED_PROTOCOL_PROVIDER_IDS.has(id) || !!locked),
            protocolTitle: locked ? '推荐平台使用固定协议' : (it && FIXED_PROTOCOL_PROVIDER_IDS.has(id) ? '内置平台使用固定协议' : ''),
            imageModeLocked: !!locked || id === 'modelscope' || id === 'runninghub' || id === 'volcengine' || isLovart || isCli,
            imageModeTitle: locked ? '推荐平台使用固定图片协议' : '',
            showKeyTile: !isCli && !isLovart,
            deletable: !!it && !isFixedProvider(it),
        };
    });
    // 新用户引导：内置 ModelScope / RunningHub 还没填 Key 时用引导卡替代完整设置
    const onboarding = computed(() => {
        const it = item.value;
        if (!it || S.view !== 'provider' || !ONBOARDING_GUIDES[it.id]) return '';
        if (it.id === 'modelscope' && !it.has_key) return 'modelscope';
        if (it.id === 'runninghub' && !it.has_key && !it.has_wallet_key) return 'runninghub';
        return '';
    });

    /* ── 确认弹窗（替代旧 confirm()） ── */
    function ask(opts) { return new Promise(resolve => { S.confirm = { ok: '确认', danger: true, ...opts, resolve }; }); }
    function answer(v) { const c = S.confirm; S.confirm = null; if (c) c.resolve(!!v); }

    /* ── 未保存标记（旧 providersFormSignature：平台数据 + 表单输入） ── */
    let cleanSig = '';
    let dirtyTimer = 0;
    const signature = () => { try { return JSON.stringify(S.providers) + '|' + JSON.stringify(S.form); } catch (e) { return ''; } };
    function markClean() { cleanSig = signature(); S.dirty = false; S.childDirty = false; }
    watch(() => signature(), () => {
        clearTimeout(dirtyTimer);
        dirtyTimer = setTimeout(() => { if (cleanSig) S.dirty = signature() !== cleanSig; }, 180);
    });

    /* ── renderEditor：把当前平台写进表单，并补协议默认值 ── */
    function loadForm() {
        const it = provider();
        if (!it) return;
        const f = S.form;
        f.name = it.name || '';
        f.base = it.base_url || '';
        const locked = lockedRecommendedApi(it);
        if (locked) applyLockedRecommendedProtocol(it);
        f.protocol = it.id === 'runninghub' ? 'runninghub' : it.id === 'volcengine' ? 'volcengine' : it.id === 'lovart' ? 'lovart' : (it.protocol || 'openai');
        f.maxConc = normalizeMaxConcurrency(it.max_concurrency);
        f.useProxy = normalizeUseProxy(it.use_proxy);
        f.imageMode = normalizeImageRequestMode(it.image_request_mode);
        f.key = ''; f.rhFree = ''; f.rhWallet = '';
        S.keyRevealed = false;
        S.verify = null;
        const p = String(f.protocol || '').toLowerCase();
        if (it.id === 'runninghub') ensureRunningHubLists(it);
        if (it.id === 'volcengine' || p === 'volcengine') {
            it.base_url = it.base_url || VOLCENGINE_DEFAULT_BASE_URL;
            it.protocol = 'volcengine';
            it.volcengine_project_name = it.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME;
            it.volcengine_region = it.volcengine_region || VOLCENGINE_DEFAULT_REGION;
            f.base = f.base || it.base_url;
        }
        if (p === 'jimeng') { it.base_url = ''; it.protocol = 'jimeng'; applyJimengModels(it); }
        if (p === 'codex') applyCliProtocolDefaults(it, 'codex');
        if (p === 'gemini-cli') applyCliProtocolDefaults(it, 'gemini-cli');
        if (isLovartContext(it, f.protocol)) { applyLovartProtocolDefaults(it); f.base = it.base_url; }
    }
    function ensureRunningHubLists(it) {
        if (!it) return;
        it.rh_apps = normalizeRhEntries(it.rh_apps || [], 'app');
        it.rh_workflows = normalizeRhEntries(it.rh_workflows || [], 'workflow');
    }

    /* ── syncEditor：表单写回当前平台 ── */
    function syncEditor() {
        const it = provider();
        if (!it) return;
        const f = S.form;
        const oldId = it.id;
        it.id = BUILTIN_IDS.has(it.id) ? it.id : deriveIdFromName(f.name, it.id, S.providers);
        if (oldId !== it.id) S.selectedId = it.id;
        it.name = f.name.trim() || it.id;
        const locked = lockedRecommendedApi(it);
        const proto = locked ? locked.protocol
            : it.id === 'modelscope' ? 'openai'
            : it.id === 'runninghub' ? 'runninghub'
            : it.id === 'volcengine' ? 'volcengine'
            : it.id === 'lovart' ? 'lovart'
            : (f.protocol || 'openai');
        it.base_url = isCliProtocol(proto) ? '' : f.base.trim();
        it.protocol = proto;
        const isLovart = isLovartContext(it, proto);
        const fixedMode = it.id === 'modelscope' || it.id === 'runninghub' || it.id === 'volcengine' || isLovart || isCliProtocol(proto);
        it.image_request_mode = normalizeImageRequestMode(fixedMode ? 'openai' : locked ? locked.image_request_mode : (f.imageMode || it.image_request_mode));
        it.image_edit_route = normalizeImageEditRoute(fixedMode ? 'general' : it.image_edit_route);
        it.image_generation_endpoint = '';
        it.image_edit_endpoint = '';
        it.max_concurrency = normalizeMaxConcurrency(f.maxConc);
        it.use_proxy = normalizeUseProxy(f.useProxy);
        it.rh_apps = normalizeRhEntries(it.rh_apps || [], 'app');
        it.rh_workflows = normalizeRhEntries(it.rh_workflows || [], 'workflow');
        const key = f.key.trim();
        if (key) it.api_key = key;
        if (it.id === 'runninghub') {
            if (f.rhFree.trim()) it.api_key = f.rhFree.trim();
            if (f.rhWallet.trim()) it.wallet_api_key = f.rhWallet.trim();
        }
        if (it.id === 'volcengine') {
            it.volcengine_project_name = it.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME;
            it.volcengine_region = it.volcengine_region || VOLCENGINE_DEFAULT_REGION;
        }
        // Lovart 的 AK / SK / 自动确认由 LovartPanel 直接写到 provider 对象上（lovart_access_key 等）
        if (isLovart) applyLovartProtocolDefaults(it);
    }

    /* ── 协议 / 图片接口 / 并发 / 代理 ── */
    function setProtocol(value) {
        const it = provider();
        if (!it || it.id === 'modelscope' || it.id === 'runninghub' || it.id === 'volcengine') return;
        S.form.protocol = value;
        if (applyLockedRecommendedProtocol(it)) { S.form.protocol = it.protocol; S.form.imageMode = it.image_request_mode; return; }
        const v = String(value || 'openai').toLowerCase();
        it.protocol = API_PROTOCOLS.includes(v) ? v : 'openai';
        if (isCliProtocol(it.protocol)) it.base_url = '';
        applyCliProtocolDefaults(it, it.protocol);
        if (it.protocol === 'lovart') applyLovartProtocolDefaults(it, true);
        // 协议会改变整个表单（CLI 面板、默认模型、Key 占位）：重载表单，但保留已输入的 Key / 名称 / 地址
        const keep = { key: S.form.key, rhFree: S.form.rhFree, rhWallet: S.form.rhWallet, name: S.form.name, base: S.form.base };
        loadForm();
        Object.assign(S.form, { key: keep.key, rhFree: keep.rhFree, rhWallet: keep.rhWallet, name: keep.name });
        if (!isCliProtocol(it.protocol) && it.protocol !== 'lovart') S.form.base = keep.base;
    }
    function setImageMode(value) {
        const it = provider();
        if (!it) return;
        if (applyLockedRecommendedProtocol(it)) { S.form.protocol = it.protocol; S.form.imageMode = it.image_request_mode; return; }
        S.form.imageMode = normalizeImageRequestMode(value);
        it.image_request_mode = S.form.imageMode;
    }
    function setMaxConc(n) { S.form.maxConc = normalizeMaxConcurrency(n); const it = provider(); if (it) it.max_concurrency = S.form.maxConc; }
    function setUseProxy(v) { S.form.useProxy = normalizeUseProxy(v); const it = provider(); if (it) it.use_proxy = S.form.useProxy; }

    /* ── 载入 / 保存 ── */
    async function load() {
        try {
            const data = await fetch('/api/providers').then(r => r.json());
            applyRegistryPresets(data.registry_presets);
            S.providers = data.providers || [];
            S.selectedId = (sortedProviders()[0] || {}).id || '';
            loadForm();
            S.view = 'recommend';     // 旧页面进入时默认展示推荐 API
            S.loaded = true; S.loadFailed = false;
            markClean();
        } catch (e) {
            S.loadFailed = true;
            toast(t('api.loadFailed', 'API 平台加载失败'), { danger: true, icon: 'alert' });
        }
    }
    // 子面板（RunningHub / CLI / Lovart）emit changed：重新拉取平台列表，保持当前选中
    async function reload() {
        try {
            const data = await fetch('/api/providers').then(r => r.json());
            applyRegistryPresets(data.registry_presets);
            const keep = S.selectedId;
            S.providers = data.providers || [];
            S.selectedId = S.providers.some(p => p.id === keep) ? keep : ((sortedProviders()[0] || {}).id || '');
            const view = S.view;
            loadForm();
            S.view = view;
            markClean();
        } catch (e) { toast(t('api.loadFailed', 'API 平台加载失败'), { danger: true, icon: 'alert' }); }
    }
    function payloadOf(p) {
        const lovart = isLovartContext(p, p.protocol);
        return {
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            protocol: p.id === 'modelscope' ? 'openai' : p.id === 'runninghub' ? 'runninghub' : p.id === 'volcengine' ? 'volcengine' : p.id === 'lovart' ? 'lovart' : (p.protocol || 'openai'),
            image_request_mode: p.image_request_mode || 'openai',
            image_edit_route: p.image_edit_route || 'general',
            image_generation_endpoint: p.image_generation_endpoint || '',
            image_edit_endpoint: p.image_edit_endpoint || '',
            max_concurrency: normalizeMaxConcurrency(p.max_concurrency),
            use_proxy: normalizeUseProxy(p.use_proxy),
            enabled: p.enabled !== false,
            // 旧页面固定发 false（会清掉首选）；现在补了「设为首选」入口，按真实标记发送，后端保证最多一个
            primary: p.primary === true,
            image_models: p.image_models || [],
            chat_models: p.chat_models || [],
            video_models: p.video_models || [],
            model_names: (p.model_names && typeof p.model_names === 'object') ? p.model_names : {},
            model_protocols: (p.model_protocols && typeof p.model_protocols === 'object') ? p.model_protocols : {},
            ms_loras: p.id === 'modelscope' ? (p.ms_loras || []) : [],
            ms_defaults_version: p.id === 'modelscope' ? (p.ms_defaults_version || 1) : 0,
            rh_apps: p.id === 'runninghub' ? (p.rh_apps || []) : [],
            rh_workflows: p.id === 'runninghub' ? (p.rh_workflows || []) : [],
            volcengine_project_name: p.id === 'volcengine' ? (p.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME) : '',
            volcengine_region: p.id === 'volcengine' ? (p.volcengine_region || VOLCENGINE_DEFAULT_REGION) : '',
            volcengine_access_key_id: p.volcengine_access_key_id || undefined,
            volcengine_secret_access_key: p.volcengine_secret_access_key || undefined,
            lovart_auto_confirm: lovart ? p.lovart_auto_confirm === true : false,
            lovart_project_id: lovart ? (p.lovart_project_id || '') : '',
            lovart_access_key: lovart ? (p.lovart_access_key || undefined) : undefined,
            lovart_secret_key: lovart ? (p.lovart_secret_key || undefined) : undefined,
            api_key: p.api_key || undefined,
            wallet_api_key: p.wallet_api_key || undefined,
            clear_key: p._clearKey === true,
            clear_wallet_key: p._clearWalletKey === true,
            clear_volcengine_access_key_id: p._clearVolcengineAccessKey === true,
            clear_volcengine_secret_access_key: p._clearVolcengineSecretKey === true,
            clear_lovart_access_key: lovart && p._clearLovartAccessKey === true,
            clear_lovart_secret_key: lovart && p._clearLovartSecretKey === true,
        };
    }
    function normalizeBeforeSave(p) {
        p.id = normalizeId(p.id);
        applyLockedRecommendedProtocol(p);
        p.protocol = p.id === 'runninghub' ? 'runninghub' : p.id === 'volcengine' ? 'volcengine'
            : API_PROTOCOLS.includes(String(p.protocol || '').toLowerCase()) ? String(p.protocol).toLowerCase() : 'openai';
        const cli = isCliProtocol(p.protocol);
        const lovart = isLovartContext(p, p.protocol);
        const fixed = p.id === 'modelscope' || p.id === 'runninghub' || p.id === 'volcengine' || lovart || cli;
        p.image_request_mode = normalizeImageRequestMode(fixed ? 'openai' : p.image_request_mode);
        p.image_edit_route = normalizeImageEditRoute(fixed ? 'general' : p.image_edit_route);
        if (cli) applyCliProtocolDefaults(p, p.protocol);
        if (lovart) applyLovartProtocolDefaults(p);
        if (p.id === 'runninghub') p.base_url = p.base_url || RH_DEFAULT_BASE_URL;
        p.image_generation_endpoint = '';
        p.image_edit_endpoint = '';
        p.image_models = unique(p.image_models || []);
        p.chat_models = unique(p.chat_models || []);
        p.video_models = unique(p.video_models || []);
        const src = (p.model_names && typeof p.model_names === 'object') ? p.model_names : {};
        const names = {};
        [...p.image_models, ...p.chat_models, ...p.video_models].forEach(m => {
            const raw = String(m || '').trim();
            const label = String(src[raw] || modelDisplayName(raw, p, S.fetched.names) || '').trim();
            if (raw && label && label !== raw) names[raw] = label;
        });
        p.model_names = names;
        p.rh_apps = normalizeRhEntries(p.rh_apps || [], 'app');
        p.rh_workflows = normalizeRhEntries(p.rh_workflows || [], 'workflow');
        p.ms_loras = (Array.isArray(p.ms_loras) ? p.ms_loras : []).map(l => ({
            id: String(l.id || '').trim(),
            name: String(l.name || l.id || '').trim(),
            target_model: String(l.target_model || '').trim(),
            strength: normalizeLoraStrength(l.strength ?? 0.8),
            enabled: l.enabled !== false,
            note: String(l.note || '').trim(),
        })).filter(l => l.id && l.target_model);
    }
    async function save() {
        syncEditor();
        S.providers.forEach(normalizeBeforeSave);
        if (new Set(S.providers.map(p => p.id)).size !== S.providers.length) {
            toast(t('api.duplicateId', '平台 ID 不能重复'), { danger: true, icon: 'alert' });
            return false;
        }
        S.saving = true;
        try {
            const res = await fetch('/api/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.providers.map(payloadOf)) });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || t('api.saveFailed', '保存失败'));
            const data = await res.json();
            const view = S.view;
            S.providers = data.providers || S.providers;
            S.selectedId = (provider() || S.providers[0] || {}).id || '';
            loadForm();
            S.view = view;
            markClean();
            toast(t('api.saved', '保存成功'), { icon: 'check' });
            // 广播变更：画布等其他页面立即重新拉取最新平台 / 模型列表
            broadcastStudioApiChange('providers-changed');
            return true;
        } catch (e) {
            toast((e && e.message) || t('api.saveFailed', '保存失败'), { danger: true, icon: 'alert' });
            return false;
        } finally { S.saving = false; }
    }

    /* ── Key ── */
    async function saveKeyOnly() {
        const it = provider(); if (!it) return;
        const key = S.form.key.trim();
        if (!key) { toast(t('api.enterKeyAlert', '请输入 Key'), { danger: true, icon: 'alert' }); return; }
        it.api_key = key;
        if (await save()) S.form.key = '';
    }
    async function clearKeyOnly() {
        const it = provider(); if (!it) return;
        if (!it.has_key && !S.form.key) return;
        if (!(await ask({ title: t('api.clearKeyTitle', '清除 Key'), desc: t('api.confirmClearKey', '确认清除当前 Key？'), ok: '清除' }))) return;
        it._clearKey = true;
        if (await save()) S.form.key = '';
    }
    async function saveRhKeyOnly(kind) {
        const it = provider(); if (!it || it.id !== 'runninghub') return;
        const key = (kind === 'wallet' ? S.form.rhWallet : S.form.rhFree).trim();
        if (!key) { toast('请输入 Key', { danger: true, icon: 'alert' }); return; }
        syncEditor();
        if (await save()) { if (kind === 'wallet') S.form.rhWallet = ''; else S.form.rhFree = ''; }
    }
    async function clearRhKeyOnly(kind) {
        const it = provider(); if (!it || it.id !== 'runninghub') return;
        if (!(await ask({ title: t('api.clearKeyTitle', '清除 Key'), desc: t('api.confirmClearKey', '确认清除当前 Key？'), ok: '清除' }))) return;
        if (kind === 'wallet') it._clearWalletKey = true; else it._clearKey = true;
        if (await save()) { if (kind === 'wallet') S.form.rhWallet = ''; else S.form.rhFree = ''; }
    }
    async function saveOnboardingRunningHubKey() {
        if (!S.form.rhFree.trim()) { toast(t('api.rhEnterCoinAlert', '请输入 RH币 API Key'), { danger: true, icon: 'alert' }); return; }
        const it = provider(); if (!it || it.id !== 'runninghub') return;
        syncEditor();
        if (await save()) { S.form.rhFree = ''; S.form.rhWallet = ''; }
    }
    async function pasteKey() {
        try {
            const text = String(await navigator.clipboard.readText() || '').trim();
            if (!text) { toast('剪贴板是空的', { danger: true, icon: 'alert' }); return ''; }
            S.form.key = text;
            return text;
        } catch (e) { toast('无法读取剪贴板，请直接按 ⌘/Ctrl + V 粘贴', { danger: true, icon: 'alert' }); return ''; }
    }

    /* ── 平台切换 / 新增 / 删除 / 排序 / 首选 ── */
    function resetFetched() { S.fetched = { all: [], suggestion: null, names: {} }; S.pickerReady = false; S.fetchHint = null; }
    function select(id) {
        if (!S.providers.some(p => p.id === id)) return;
        S.switcherOpen = false;
        S.view = 'provider';
        syncEditor();
        if (id !== S.selectedId) resetFetched();
        S.selectedId = id;
        loadForm();
        if (!S.dirty) markClean();
    }
    function addProvider() {
        S.switcherOpen = false;
        S.view = 'provider';
        syncEditor();
        let id = 'custom-api', i = 2;
        while (S.providers.some(p => p.id === id)) id = `custom-api-${i++}`;
        S.providers.push({ id, name: 'API', base_url: '', protocol: 'openai', image_request_mode: 'openai', image_edit_route: 'general', image_generation_endpoint: '', image_edit_endpoint: '', enabled: true, primary: false, image_models: [], chat_models: [], video_models: [], has_key: false, key_preview: '' });
        resetFetched();
        S.selectedId = id;
        loadForm();
    }
    function chooseAddProvider(kind) {
        if (kind === 'recommend') { openRecommend(); return; }
        if (kind === 'cli') { S.cliFlash++; return; }
        addProvider();
        if (kind === 'apimart') setProtocol('apimart');
        S.focusName++;
    }
    async function addCliProvider(kind) {
        const preset = CLI_PROVIDER_PRESETS[kind];
        if (!preset) return;
        S.switcherOpen = false;
        S.view = 'provider';
        syncEditor();
        let it = S.providers.find(p => p.id === preset.id) || S.providers.find(p => String(p.protocol || '').toLowerCase() === preset.protocol);
        if (!it) {
            S.providers.push({ id: preset.id, name: preset.name, base_url: '', protocol: preset.protocol, image_request_mode: 'openai', image_edit_route: 'general', image_generation_endpoint: '', image_edit_endpoint: '', enabled: true, primary: false, image_models: [], chat_models: [], video_models: [], model_protocols: {}, has_key: false, key_preview: '' });
            it = S.providers[S.providers.length - 1];
        }
        it.id = preset.id;
        it.name = it.name || preset.name;
        it.base_url = '';
        it.protocol = preset.protocol;
        if (preset.protocol === 'jimeng') { applyJimengModels(it); it.chat_models = unique(it.chat_models || []); }
        else applyCliProtocolDefaults(it, preset.protocol);
        resetFetched();
        S.selectedId = it.id;
        loadForm();
        S.form.protocol = preset.protocol;
        if (await save()) {
            S.selectedId = preset.id;
            loadForm();
            S.form.protocol = preset.protocol;
            toast(`${preset.name} 已添加，使用本机登录态，无需填写 API Key。`, { icon: 'check' });
        }
    }
    async function deleteProvider() {
        const it = provider(); if (!it) return;
        if (isFixedProvider(it)) { toast(t('api.defaultNoDelete', '默认平台不能删除'), { danger: true, icon: 'alert' }); return; }
        if (S.providers.length <= 1) { toast(t('api.keepOne', '至少保留一个 API 平台'), { danger: true, icon: 'alert' }); return; }
        const ok = await ask({ title: `删除「${it.name || it.id}」？`, desc: '平台配置和模型列表会一起删除，已保存在后端 env 的 Key 不受影响。此操作会立即保存。', ok: '删除' });
        if (!ok) return;
        S.providers = S.providers.filter(p => p.id !== it.id);
        resetFetched();
        S.selectedId = (S.providers[0] || {}).id || '';
        loadForm();
        await save();
    }
    // 拖拽排序（只在自定义 / CLI 平台之间），放下后立即保存
    function moveProvider(sourceId, targetId) {
        if (!sourceId || sourceId === targetId || isFixedProvider(sourceId) || isFixedProvider(targetId)) return;
        const from = S.providers.findIndex(p => p.id === sourceId);
        if (from < 0 || S.providers.findIndex(p => p.id === targetId) < 0) return;
        const [moved] = S.providers.splice(from, 1);
        S.providers.splice(S.providers.findIndex(p => p.id === targetId), 0, moved);
        save();
    }
    // 设为首选平台：后端 get_primary_provider_id 优先用 primary=true 的平台；保存时后端保证最多一个
    async function setPrimary(id) {
        const target = S.providers.find(p => p.id === id);
        if (!target || target.primary === true) return;
        S.providers.forEach(p => { p.primary = p.id === id; });
        if (await save()) toast(`已将「${target.name || target.id}」设为首选平台`, { icon: 'check' });
    }
    /* ── 视图切换 ── */
    function openRecommend() { S.switcherOpen = false; S.view = 'recommend'; }
    function closeRecommend() { S.view = 'provider'; loadForm(); }
    function showStorage() { S.switcherOpen = false; S.view = 'storage'; }
    /* ── 模型列表 ── */
    let uid = 0;
    const rowIds = new Map();
    function rowKeys(it, kind) {
        const list = it[modelListKey(kind)] || [];
        const k = it.id + '|' + kind;
        let arr = rowIds.get(k);
        if (!arr || arr.length !== list.length) { arr = list.map(() => ++uid); rowIds.set(k, arr); }
        return arr;
    }
    function addModel(kind) {
        const it = provider(); if (!it) return;
        const key = modelListKey(kind);
        rowKeys(it, kind).push(++uid);
        it[key] = [...(it[key] || []), ''];
    }
    function updateModel(kind, index, value) {
        const it = provider(); if (!it) return;
        const key = modelListKey(kind);
        const oldName = String(it[key][index] || '').trim();
        const newName = String(value || '').trim();
        it[key][index] = value;
        if (!oldName || oldName === newName) return;
        // 重命名时迁移该模型的协议覆盖 / 展示名
        if (it.model_protocols && typeof it.model_protocols === 'object' && Object.prototype.hasOwnProperty.call(it.model_protocols, oldName)) {
            const proto = it.model_protocols[oldName];
            const elsewhere = ['image_models', 'chat_models', 'video_models'].some(k => Array.isArray(it[k]) && it[k].some((m, i) => !(k === key && i === index) && String(m || '').trim() === oldName));
            if (!elsewhere) delete it.model_protocols[oldName];
            if (newName) it.model_protocols[newName] = proto;
        }
        if (it.model_names && typeof it.model_names === 'object' && Object.prototype.hasOwnProperty.call(it.model_names, oldName)) {
            const label = it.model_names[oldName];
            if (!modelStillUsed(it, oldName)) delete it.model_names[oldName];
            if (newName && label && label !== newName) it.model_names[newName] = label;
        }
    }
    function updateModelProtocol(kind, index, value) {
        const it = provider(); if (!it) return;
        const name = String((it[modelListKey(kind)] || [])[index] || '').trim();
        if (!name) return;
        if (!it.model_protocols || typeof it.model_protocols !== 'object') it.model_protocols = {};
        const proto = String(value || '').trim().toLowerCase();
        if (proto === 'openai' || proto === 'gemini') it.model_protocols[name] = proto;
        else delete it.model_protocols[name];
    }
    function removeModel(kind, index) {
        const it = provider(); if (!it) return;
        const key = modelListKey(kind);
        const model = String((it[key] || [])[index] ?? '');
        const id = model.trim();
        const snap = { providerId: it.id, key, kind, index, model, protocol: it.model_protocols && it.model_protocols[id], name: it.model_names && it.model_names[id] };
        rowKeys(it, kind).splice(index, 1);
        it[key].splice(index, 1);
        if (id && it.model_protocols && typeof it.model_protocols === 'object' && !modelStillUsed(it, id)) delete it.model_protocols[id];
        if (id && it.model_names && typeof it.model_names === 'object' && !modelStillUsed(it, id)) delete it.model_names[id];
        toast(`已删除 ${model || '模型'} · 点此撤销`, { icon: 'undo', duration: 5000, onClick: () => restoreModel(snap) });
    }
    function restoreModel(snap) {
        const it = S.providers.find(p => p.id === snap.providerId); if (!it) return;
        it[snap.key] = it[snap.key] || [];
        const at = Math.min(snap.index, it[snap.key].length);
        rowKeys(it, snap.kind).splice(at, 0, ++uid);
        it[snap.key].splice(at, 0, snap.model);
        const id = snap.model.trim();
        if (id && snap.protocol !== undefined) { it.model_protocols = it.model_protocols || {}; it.model_protocols[id] = snap.protocol; }
        if (id && snap.name !== undefined) { it.model_names = it.model_names || {}; it.model_names[id] = snap.name; }
    }
    function applyPicker(image, chat, video, names) {
        const it = provider(); if (!it) return;
        it.image_models = image; it.chat_models = chat; it.video_models = video; it.model_names = names;
        S.pickerOpen = false;
        toast(`已应用 · 生图 ${image.length} / LLM ${chat.length} / 视频 ${video.length}，点保存生效`, { icon: 'check' });
    }
    /* ── ModelScope LoRA ── */
    function addLora() {
        const it = provider(); if (!it || it.id !== 'modelscope') return;
        if (!Array.isArray(it.ms_loras)) it.ms_loras = [];
        it.ms_loras.push({ id: '', name: '', target_model: (it.image_models || [])[0] || MS_BUILTIN_IMAGE_MODELS[0], strength: 0.8, enabled: true, note: '' });
    }
    function updateLora(index, field, value) {
        const it = provider(); if (!it || it.id !== 'modelscope' || !Array.isArray(it.ms_loras)) return;
        const l = it.ms_loras[index]; if (!l) return;
        if (field === 'strength') l.strength = normalizeLoraStrength(value); else l[field] = value;
    }
    function removeLora(index) {
        const it = provider(); if (!it || it.id !== 'modelscope' || !Array.isArray(it.ms_loras)) return;
        it.ms_loras.splice(index, 1);
    }

    const api = {
        S, item, flags, onboarding, protocolNow,
        provider, sortedProviders, visibleProviders,
        ask, answer, markClean,
        loadForm, syncEditor, setProtocol, setImageMode, setMaxConc, setUseProxy,
        load, reload, save,
        saveKeyOnly, clearKeyOnly, saveRhKeyOnly, clearRhKeyOnly, saveOnboardingRunningHubKey, pasteKey,
        select, addProvider, chooseAddProvider, addCliProvider, deleteProvider, moveProvider, setPrimary,
        openRecommend, closeRecommend, showStorage,
        rowKeys, addModel, updateModel, updateModelProtocol, removeModel, applyPicker,
        addLora, updateLora, removeLora, resetFetched,
    };
    installNetwork(api);
    return api;
}
