// 配置/协议可更新：拉取 /api/providers/protocol-updates，一键 apply 增量更新，成功后自动跑一次连接验证。
// 接口未就绪（404）或请求失败都静默降级：设置页照常可用，只是不出现更新提醒。
import { toast } from '../../../../lib/store.js';
import { normalizeImageRequestMode, normalizeUseProxy, hasUsableKey, isCliProtocol } from './helpers.js';
import { broadcastStudioApiChange } from '../kit/kit.js';

const LIST_URL = '/api/providers/protocol-updates';
const APPLY_URL = '/api/providers/protocol-update/apply';
const VERIFY_URL = '/api/providers/test-connection';
const MODEL_GROUPS = ['chat', 'image', 'video', 'audio'];

async function requestJson(url, { method = 'GET', body = null, timeoutMs = 30000, failText = '请求失败' } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    try {
        const res = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller ? controller.signal : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error((data && typeof data.detail === 'string' && data.detail) || failText);
            err.status = res.status;
            throw err;
        }
        return data || {};
    } catch (e) {
        if (e && e.name === 'AbortError') {
            const err = new Error('请求超时，请稍后重试');
            err.timeout = true;
            throw err;
        }
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function errText(e) {
    if (!e) return '未知错误';
    if (e.status === 404) return '后端还没有提供这个接口，稍后再试';
    return String(e.message || e);
}

function countModels(added) {
    return MODEL_GROUPS.reduce((n, key) => n + ((Array.isArray(added && added[key]) ? added[key].length : 0)), 0);
}

export function installProtocolUpdates(api) {
    const S = api.S;
    let applying = false;

    function items() {
        const list = S.protocolUpdates && S.protocolUpdates.items;
        return Array.isArray(list) ? list : [];
    }
    // 只有 available=true 才算「可更新」；模型不支持、版本已对齐的平台不下发提醒
    function updateOf(providerId) {
        const id = String(providerId || '');
        if (!id) return null;
        return items().find(it => it && String(it.provider_id || '') === id && it.available === true) || null;
    }
    function hasAnyUpdate() {
        return items().some(it => it && it.available === true);
    }

    async function loadProtocolUpdates() {
        S.protocolUpdates.loading = true;
        try {
            const data = await requestJson(LIST_URL, { timeoutMs: 20000, failText: '没有拿到更新信息' });
            S.protocolUpdates.items = Array.isArray(data.items) ? data.items : [];
            S.protocolUpdates.failed = false;
            S.protocolUpdates.error = '';
        } catch (e) {
            S.protocolUpdates.items = [];
            S.protocolUpdates.failed = true;
            S.protocolUpdates.error = errText(e);
        } finally {
            S.protocolUpdates.loaded = true;
            S.protocolUpdates.loading = false;
        }
        return S.protocolUpdates;
    }

    function openUpdate(providerId) {
        if (!updateOf(providerId)) return false;
        S.updateDlg = String(providerId);
        return true;
    }
    function closeUpdate() { S.updateDlg = ''; }

    function mergeProvider(fresh) {
        if (!fresh || !fresh.id) return;
        const at = S.providers.findIndex(p => String(p.id) === String(fresh.id));
        if (at >= 0) S.providers.splice(at, 1, { ...S.providers[at], ...fresh });
        else S.providers.push(fresh);
    }
    // 刷新平台列表：有未保存的改动时只合并这一个平台，别冲掉用户正在编辑的其它平台
    async function refreshProvidersAfterApply(providerId, freshProvider) {
        if (freshProvider) mergeProvider(freshProvider);
        if (S.dirty || S.childDirty) return;
        await api.reload();
    }

    // 用该平台已保存的 Key 验证：不传 api_key，后端按 provider_id 取已存的 Key
    async function verifyProvider(it) {
        if (!it) return { state: 'fail', text: '平台列表里找不到这个平台，可能已被删除' };
        const protocol = String(it.protocol || 'openai').toLowerCase();
        if (!isCliProtocol(protocol) && !hasUsableKey(it)) {
            return { state: 'skip', text: '未配置 Key，跳过验证' };
        }
        try {
            const data = await requestJson(VERIFY_URL, {
                method: 'POST',
                timeoutMs: 30000,
                failText: '验证失败',
                body: {
                    base_url: it.base_url || '',
                    provider_id: it.id,
                    protocol,
                    image_request_mode: normalizeImageRequestMode(it.image_request_mode),
                    use_proxy: normalizeUseProxy(it.use_proxy),
                },
            });
            if (data.ok === true) return { state: 'ok', count: Number(data.model_count || 0) || 0 };
            const status = data.status ? `HTTP ${data.status} · ` : '';
            return { state: 'fail', text: `${status}${String(data.message || '地址验证未通过').slice(0, 200)}` };
        } catch (e) {
            return { state: 'fail', text: errText(e) };
        }
    }

    // report 是调用方给的 reactive 对象，进度和结果都写回它，弹窗直接渲染
    async function applyUpdate(providerId, report = {}) {
        const r = report;
        if (applying) return false;
        applying = true;
        Object.assign(r, { phase: 'applying', error: '', applied: null, changes: [], params: [], addedTotal: 0, verify: null });
        try {
            let data;
            try {
                data = await requestJson(APPLY_URL, { method: 'POST', body: { provider_id: String(providerId || '') }, timeoutMs: 60000, failText: '更新失败' });
            } catch (e) {
                Object.assign(r, { phase: 'failed', error: errText(e) });
                return false;
            }
            const applied = (data.applied && typeof data.applied === 'object') ? data.applied : {};
            Object.assign(r, {
                phase: 'refreshing',
                applied,
                addedTotal: countModels(applied.added_models),
                changes: Array.isArray(applied.protocol_changes) ? applied.protocol_changes : [],
                // 本次写入的模型参数改动：以 applied.parameter_changes 为准
                params: Array.isArray(applied.parameter_changes) ? applied.parameter_changes : [],
            });
            await refreshProvidersAfterApply(providerId, data.provider);
            broadcastStudioApiChange('providers-changed');
            await loadProtocolUpdates();

            const it = S.providers.find(p => String(p.id) === String(providerId)) || (data.provider && data.provider.id ? data.provider : null);
            Object.assign(r, { phase: 'verifying' });
            r.verify = await verifyProvider(it);
            r.phase = 'done';
            const name = (it && (it.name || it.id)) || providerId;
            if (r.verify.state === 'ok') toast(`${name} 已更新 · 验证通过（${r.verify.count} 个模型）`, { icon: 'check' });
            else if (r.verify.state === 'skip') toast(`${name} 已更新 · 未配置 Key，跳过验证`, { icon: 'check' });
            else toast(`${name} 已更新 · 验证未通过`, { danger: true, icon: 'alert' });
            return true;
        } finally {
            applying = false;
        }
    }

    Object.assign(api, { loadProtocolUpdates, updateOf, hasAnyUpdate, openUpdate, closeUpdate, applyUpdate });
}
