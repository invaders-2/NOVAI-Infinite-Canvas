// API 设置：测试连接 / 协议探测 / 拉取模型 / 推荐 API 一键添加（接口与请求体字段照旧）
import { toast, t } from '../../../../lib/store.js';
import { API_PROTOCOLS, FIXED_PROTOCOL_PROVIDER_IDS, RECOMMENDED_APIS, RH_DEFAULT_BASE_URL, VOLCENGINE_DEFAULT_PROJECT_NAME, VOLCENGINE_DEFAULT_REGION, PROTOCOL_LABELS } from './constants.js';
import {
    unique, normalizeId, normalizeUseProxy, normalizeImageRequestMode, normalizeImageEditRoute, imageRequestModeLabel, isCliProtocol,
    isLovartContext, isRunningHubContext, isVolcengineProvider, applyCliProtocolDefaults, applyLockedRecommendedProtocol, lockedRecommendedApi,
    runninghubModelSourceNote,
} from './helpers.js';

async function postJson(url, body, failText) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || failText);
    return r.json();
}

export function installNetwork(api) {
    const { S, provider, setProtocol } = api;
    const f = S.form;

    // RunningHub 优先用账户余额 Key 验证 / 拉取
    function currentApiKey(it) {
        if (it && it.id === 'runninghub') return f.rhWallet.trim() || f.rhFree.trim() || '';
        return f.key.trim();
    }
    function recordConn(id, result) { if (id) S.connResults[id] = { ...result, at: Date.now() }; }
    function setFetched(data) {
        S.fetched = {
            all: Array.isArray(data && data.all) ? data.all : [],
            suggestion: { image: new Set((data && data.image_models) || []), chat: new Set((data && data.chat_models) || []), video: new Set((data && data.video_models) || []), audio: new Set((data && data.audio_models) || []) },
            names: (data && data.model_names && typeof data.model_names === 'object') ? { ...data.model_names } : {},
        };
    }

    function applyDetectedImageRequestMode(mode) {
        const it = provider(); if (!it) return false;
        if (applyLockedRecommendedProtocol(it)) { f.protocol = it.protocol; f.imageMode = it.image_request_mode; return false; }
        const detected = normalizeImageRequestMode(mode);
        const changed = normalizeImageRequestMode(it.image_request_mode) !== detected || normalizeImageRequestMode(f.imageMode) !== detected;
        f.imageMode = detected;
        it.image_request_mode = detected;
        return changed;
    }
    function applyDetectedProtocol(protocol) {
        const it = provider();
        const detected = String(protocol || '').toLowerCase();
        if (!it || !API_PROTOCOLS.includes(detected)) return false;
        if (applyLockedRecommendedProtocol(it)) { f.protocol = it.protocol; f.imageMode = it.image_request_mode; return false; }
        if (String(f.protocol || '').toLowerCase() === detected && String(it.protocol || '').toLowerCase() === detected) return false;
        it.protocol = detected;
        it.base_url = isCliProtocol(detected) ? '' : (f.base.trim() || it.base_url || '');
        if (detected === 'volcengine') {
            it.video_models = unique(it.video_models || []);
            it.volcengine_project_name = it.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME;
            it.volcengine_region = it.volcengine_region || VOLCENGINE_DEFAULT_REGION;
        }
        if (detected === 'runninghub') {
            it.base_url = it.base_url || RH_DEFAULT_BASE_URL;
            ['image_models', 'chat_models', 'video_models', 'audio_models'].forEach(k => { it[k] = unique(it[k] || []); });
        }
        applyCliProtocolDefaults(it, detected);
        setProtocol(detected);
        return true;
    }

    // 协议探测（旧 probeAsync）：结果追加在 prefix 之后
    async function probeAsync(prefix = []) {
        const it = provider(); if (!it) return;
        const baseUrl = f.base.trim();
        const show = (blocks, raw = null, state = '') => { S.verify = { state, blocks: [...prefix, ...blocks], raw }; };
        if (!baseUrl && !isCliProtocol(f.protocol || it.protocol)) { toast('请先填写请求地址', { danger: true, icon: 'alert' }); return; }
        show([{ tone: 'muted', text: '正在检测协议类型...' }], null, 'ok');
        const currentProtocol = String(f.protocol || it.protocol || 'openai').toLowerCase();
        const keepManual = ['gemini', 'volcengine', 'jimeng', 'codex', 'gemini-cli'].includes(currentProtocol);
        try {
            const apiKey = currentApiKey(it);
            if (isRunningHubContext(it, f.protocol, baseUrl)) {
                const data = await postJson('/api/providers/test-connection', { base_url: baseUrl, api_key: apiKey, provider_id: 'runninghub', protocol: 'runninghub', image_request_mode: 'openai', use_proxy: normalizeUseProxy(f.useProxy || it.use_proxy) }, '请求失败');
                applyDetectedProtocol('runninghub');
                setFetched(data);
                S.pickerReady = true;
                show([{ tone: 'ok', text: `RunningHub OpenAPI 验证通过 · 找到 ${data.model_count || data.total || 0} 个模型${runninghubModelSourceNote(data)}` }], null, 'ok');
                return;
            }
            const data = await postJson('/api/providers/probe-async', { base_url: baseUrl, api_key: apiKey, provider_id: it.id, protocol: currentProtocol, image_request_mode: f.imageMode || it.image_request_mode || 'openai', use_proxy: normalizeUseProxy(f.useProxy || it.use_proxy) }, '请求失败');
            const detected = String(data.protocol || '').toLowerCase();
            const isAsync = data.ok === true && detected === 'apimart';
            if (!keepManual) applyDetectedProtocol(detected || (isAsync ? 'apimart' : 'openai'));
            if (data.image_request_mode) applyDetectedImageRequestMode(data.image_request_mode);
            const message = String(data.message || '');
            const good = isAsync || data.ok === true;
            const proto = detected === 'volcengine' ? '方舟/Ark 任务协议' : isAsync ? 'APIMart 异步' : detected === 'openai' ? 'OpenAI 兼容'
                : keepManual ? (currentProtocol === 'gemini' ? 'Gemini' : currentProtocol.toUpperCase()) : 'OpenAI 兼容';
            const blocks = [];
            if (!message.includes('/v1/tasks/')) blocks.push({ tone: good ? 'ok' : data.ok === null ? 'warn' : 'muted', text: message });
            blocks.push({ tone: 'muted', text: `${keepManual ? '协议已验证为' : '协议已自动设置为'}：${proto} · 图片接口：${imageRequestModeLabel(f.imageMode || it.image_request_mode)}` });
            let rawJson = '';
            try { rawJson = JSON.stringify(data.raw, null, 2); } catch (e) { rawJson = String(data.raw || ''); }
            show(blocks, { code: data.status_code, json: rawJson }, 'ok');
        } catch (e) {
            if (!keepManual) setProtocol('openai');
            show([{ tone: 'warn', text: `${(e && e.message) || e}${keepManual ? '，已保留当前手动选择的协议' : '，协议已设为 OpenAI 兼容'}` }], null, 'warn');
        }
    }

    // 验证地址与 Key（旧 testConnection）
    async function testConnection() {
        const it = provider(); if (!it) return false;
        const baseUrl = f.base.trim();
        const currentProtocol = String(f.protocol || it.protocol || '').toLowerCase();
        const isJimeng = f.protocol === 'jimeng';
        const isCli = isCliProtocol(currentProtocol);
        const isLovart = isLovartContext(it, currentProtocol);
        if (!baseUrl && !isJimeng && !isCli) { toast('请先填写请求地址', { danger: true, icon: 'alert' }); return false; }
        S.verify = { state: '', loading: true, blocks: [{ tone: 'muted', text: '验证中...' }], raw: null };
        try {
            const rhContext = isRunningHubContext(it, f.protocol, baseUrl);
            const started = performance.now();
            const data = await postJson('/api/providers/test-connection', {
                base_url: baseUrl,
                api_key: currentApiKey(it),
                provider_id: isLovart ? 'lovart' : rhContext ? 'runninghub' : it.id,
                protocol: isLovart ? 'lovart' : rhContext ? 'runninghub' : (f.protocol || 'openai'),
                image_request_mode: f.imageMode || it.image_request_mode || 'openai',
                use_proxy: normalizeUseProxy(f.useProxy || it.use_proxy),
                // LovartPanel 把输入中的 AK / SK 写在 provider.lovart_access_key / lovart_secret_key 上
                lovart_access_key: isLovart ? String(it.lovart_access_key || '').trim() : '',
                lovart_secret_key: isLovart ? String(it.lovart_secret_key || '').trim() : '',
            }, t('api.urlInvalid', '验证失败'));
            if (data.ok) {
                const detected = String(data.protocol || '').toLowerCase();
                if (detected && detected !== String(f.protocol || '').toLowerCase()) applyDetectedProtocol(detected);
                if (data.image_request_mode) applyDetectedImageRequestMode(data.image_request_mode);
                // 存入选择器状态并启用「选择模型」，但不自动弹出
                S.fetched = {
                    all: data.all || [],
                    suggestion: { image: new Set(data.image_models || []), chat: new Set(data.chat_models || []), video: new Set(data.video_models || []), audio: new Set(data.audio_models || []) },
                    names: S.fetched.names || {},
                };
                if (!isLovart) S.pickerReady = true;
                const rhNow = rhContext || detected === 'runninghub';
                const volcNow = !rhNow && (detected === 'volcengine' || isVolcengineProvider(it));
                const ms = Math.max(1, Math.round(performance.now() - started));
                recordConn(it.id, { state: 'ok', ms, count: isLovart ? null : (data.model_count || 0), protocol: String(data.protocol || f.protocol || '') });
                const extra = rhNow ? ` · RunningHub OpenAPI${runninghubModelSourceNote(data)}` : ` · 图片接口：${imageRequestModeLabel(f.imageMode || it.image_request_mode)}`;
                const blocks = [{ tone: 'ok', text: isLovart ? `Lovart 签名密钥验证通过 · ${ms}ms` : `已连通 · 找到 ${data.model_count} 个模型${extra} · ${ms}ms` }];
                if (volcNow) blocks.push({ tone: 'note', text: `${detected === 'volcengine' ? '已自动识别为方舟/Ark 任务协议。' : ''}火山协议提示：模型列表只代表可见模型，聊天模型建议填写你在方舟控制台创建的 ep-... 推理接入点。` });
                if (isJimeng) blocks.push({ tone: 'note', text: '即梦 CLI 已可用，可在画布里选择“即梦 CLI”生成。' });
                if (currentProtocol === 'codex') blocks.push({ tone: 'note', text: 'OpenAI Codex CLI 已可用，可在画布里选择“OpenAI CLI”聊天或生成图片。' });
                if (currentProtocol === 'gemini-cli') blocks.push({ tone: 'note', text: 'Antigravity CLI 已可用，可在画布里选择“Antigravity CLI”聊天或测试生图。' });
                if (isLovart) blocks.push({ tone: 'note', text: 'Lovart 密钥可用，可在画布里选择 Lovart 设计代理出图或出视频。' });
                S.verify = { state: 'ok', blocks, raw: null };
                return true;
            }
            recordConn(it.id, { state: 'warn', text: `地址验证未通过（HTTP ${data.status}）` });
            S.verify = { state: 'warn', blocks: [{ tone: 'warn', text: `地址验证未通过 (HTTP ${data.status})` }, { tone: 'muted', text: String(data.message || '').slice(0, 200) }], raw: null };
        } catch (e) {
            const msg = String((e && e.message) || e);
            recordConn(it.id, { state: 'warn', text: msg.slice(0, 80) });
            S.verify = { state: 'warn', blocks: [{ tone: 'warn', text: msg }], raw: null };
        }
        return false;
    }

    // 「测试连接」：先验证地址与 Key，通过后对 OpenAI / 异步协议再自动识别一次协议类型，结果合并展示
    async function testProviderConnection() {
        const it = provider();
        if (!it || S.testing) return false;
        S.testing = true;
        try {
            const ok = await testConnection();
            if (S.verify) S.verify.state = ok ? 'ok' : 'warn';
            const protocol = String(f.protocol || it.protocol || '').toLowerCase();
            const shouldProbe = ok && ['openai', 'apimart'].includes(protocol)
                && !isLovartContext(it, protocol) && !isRunningHubContext(it, f.protocol, f.base.trim())
                && !FIXED_PROTOCOL_PROVIDER_IDS.has(it.id) && !lockedRecommendedApi(it);
            if (shouldProbe) await probeAsync((S.verify && S.verify.blocks) || []);
            return ok;
        } finally { S.testing = false; }
    }

    // 拉取模型（旧 fetchModels）：成功后直接打开「选择模型」
    async function fetchModels() {
        const it = provider(); if (!it || S.fetching) return;
        api.syncEditor();
        const baseUrl = f.base.trim();
        const isJimeng = f.protocol === 'jimeng';
        if (!baseUrl && !isJimeng && !isCliProtocol(f.protocol || it.protocol)) { toast('请先填写请求地址', { danger: true, icon: 'alert' }); return; }
        S.fetching = true;
        try {
            const rhContext = isRunningHubContext(it, f.protocol, baseUrl);
            const data = await postJson('/api/providers/fetch-models', {
                base_url: baseUrl,
                api_key: currentApiKey(it),
                provider_id: rhContext ? 'runninghub' : it.id,
                protocol: rhContext ? 'runninghub' : (f.protocol || 'openai'),
                image_request_mode: f.imageMode || it.image_request_mode || 'openai',
            }, t('api.urlInvalid', '拉取失败'));
            setFetched(data);
            const detected = String(data.protocol || '').toLowerCase();
            if (detected && detected !== String(f.protocol || '').toLowerCase()) applyDetectedProtocol(detected);
            if (data.image_request_mode) applyDetectedImageRequestMode(data.image_request_mode);
            S.pickerReady = true;
            const im = (data.image_models || []).length, ch = (data.chat_models || []).length, vi = (data.video_models || []).length, au = (data.audio_models || []).length;
            S.fetchHint = { kind: 'ok', text: `已从上游拉取 ${data.total} 个模型（图像 ${im} / 对话 ${ch} / 视频 ${vi} / 音频 ${au}），点「选择模型」勾选后应用。` };
            if (rhContext || detected === 'runninghub' || it.id === 'runninghub') S.fetchHint.text += runninghubModelSourceNote(data);
            else if (detected === 'volcengine' || isVolcengineProvider(it)) S.fetchHint.text += ' 已识别方舟协议，火山聊天建议改填 ep-... 接入点。';
            if (normalizeImageRequestMode(f.imageMode || it.image_request_mode) === 'openai-json') S.fetchHint.text += ' 图片接口已设为 OpenAI JSON。';
            openPicker();
        } catch (e) {
            S.fetchHint = { kind: 'error', text: `拉取失败：${(e && e.message) || e}。已保留当前模型列表，可检查请求地址和 Key 后重试。` };
        } finally { S.fetching = false; }
    }
    function openPicker() {
        if (!provider() || !S.fetched.all.length) { toast('没有拉取到模型', { danger: true, icon: 'alert' }); return; }
        S.pickerOpen = true;
    }

    /* ── 推荐 API ── */
    function existingProviderForApi(apiDef) {
        return S.providers.find(p => (apiDef.id && String(p.id || '').toLowerCase() === String(apiDef.id).toLowerCase())
            || String(p.name || '').toLowerCase() === String(apiDef.name || '').toLowerCase()) || null;
    }
    function recommendedProviderForApi(apiDef) {
        let it = existingProviderForApi(apiDef);
        if (it) {
            it.base_url = apiDef.base_url || it.base_url || '';
            it.protocol = apiDef.protocol || it.protocol || 'openai';
            it.image_request_mode = normalizeImageRequestMode(apiDef.image_request_mode || it.image_request_mode);
            it.image_edit_route = normalizeImageEditRoute(apiDef.image_edit_route || it.image_edit_route);
            if (Array.isArray(apiDef.video_models)) it.video_models = [...apiDef.video_models];
            if (Array.isArray(apiDef.audio_models)) it.audio_models = [...apiDef.audio_models];
            if (apiDef.empty_models_on_save) { it.image_models = []; it.chat_models = []; it.video_models = []; it.audio_models = []; it.model_protocols = {}; }
            return it;
        }
        const baseId = normalizeId(apiDef.id || apiDef.name) || 'custom-api';
        let id = baseId, n = 2;
        while (S.providers.some(p => p.id === id)) id = `${baseId}-${n++}`;
        const empty = !!apiDef.empty_models_on_save;
        S.providers.push({
            id, name: apiDef.name, base_url: apiDef.base_url, protocol: apiDef.protocol,
            image_request_mode: normalizeImageRequestMode(apiDef.image_request_mode),
            image_edit_route: normalizeImageEditRoute(apiDef.image_edit_route),
            image_generation_endpoint: '', image_edit_endpoint: '', enabled: true, primary: false,
            image_models: empty ? [] : (Array.isArray(apiDef.image_models) ? [...apiDef.image_models] : []),
            chat_models: empty ? [] : (Array.isArray(apiDef.chat_models) ? [...apiDef.chat_models] : []),
            video_models: empty ? [] : (Array.isArray(apiDef.video_models) ? [...apiDef.video_models] : []),
            audio_models: empty ? [] : (Array.isArray(apiDef.audio_models) ? [...apiDef.audio_models] : []),
            model_protocols: empty ? {} : ((apiDef.model_protocols && typeof apiDef.model_protocols === 'object') ? { ...apiDef.model_protocols } : {}),
            has_key: false, key_preview: '',
        });
        return S.providers[S.providers.length - 1];
    }
    async function saveRecommendedApi(index, key) {
        const apiDef = RECOMMENDED_APIS[index]; if (!apiDef) return false;
        const k = String(key || '').trim();
        if (!k) { toast(t('api.enterApiKey', '请输入 API Key'), { danger: true, icon: 'alert' }); return false; }
        const it = recommendedProviderForApi(apiDef);
        if (it.id !== S.selectedId) api.resetFetched();
        S.selectedId = it.id;
        S.view = 'provider';
        S.recommendOpen = -1;
        api.loadForm();
        f.key = k;
        setProtocol(apiDef.protocol);
        api.setImageMode(normalizeImageRequestMode(apiDef.image_request_mode));
        api.syncEditor();
        const ok = await api.save();
        if (ok) toast(t('api.recommendSaved', '已保存 {name}，当前显示该平台配置。').replaceAll('{name}', apiDef.name), { icon: 'check' });
        return ok;
    }

    Object.assign(api, {
        testProviderConnection, testConnection, probeAsync, fetchModels, openPicker,
        existingProviderForApi, saveRecommendedApi, PROTOCOL_LABELS,
    });
}
