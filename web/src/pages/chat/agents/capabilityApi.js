// 能力（智能体 / 技能）API 客户端：列表 / 详情 / 在会话里发起运行 / 运行详情 / SSE 进度。
// 契约（冻结，字段名不改）：
//   GET  /api/capabilities                -> {capabilities:[{id,kind,name,category,icon,description,tags,deliverables,enabled,available}]}
//   GET  /api/capabilities/{id}           -> {capability:{...含 input_schema}}
//   POST /api/conversations/{cid}/capabilities/{id}/run
//        multipart: file(可多个) + params(JSON 字符串，可含 provider/model) -> {run_id,conversation_id,user_message_id,assistant_message_id}
//   GET  /api/agents/runs/{run_id}        -> {run:{...,conversation_id,capability_id,capability_name,status,steps,artifacts}}
//   GET  /api/agents/runs/{run_id}/stream -> SSE（event: run_start/plan/step_start/step_result/done/error）
//   GET  /api/agents/runs/{run_id}/files/{name}
// 这里只做请求与字段归一化：失败一律返回 {ok:false,error}，不抛给组件、不伪造数据 —— 界面据此给空态 / 错误态。
import { readSSE } from '../sse.js';

const api = (() => {
    const KINDS = ['agent', 'skill'];

    function text(v) { return v == null ? '' : String(v); }
    function strList(v) {
        const list = Array.isArray(v) ? v : (v ? [v] : []);
        return list.map(text).map(s => s.trim()).filter(Boolean);
    }
    async function jsonBody(res) {
        try { return await res.json(); } catch (e) { return null; }
    }
    function detailOf(data) {
        const d = data && (data.detail || data.error || data.message);
        return text(d).trim();
    }
    async function failure(stage, res) {
        const data = await jsonBody(res);
        const detail = detailOf(data);
        if (!res) return { ok: false, error: '无法连接能力服务' };
        if (detail && !/^not found$/i.test(detail)) return { ok: false, error: detail };
        return { ok: false, error: stage + '（HTTP ' + res.status + '）' };
    }
    function kindOf(v) {
        const k = text(v).toLowerCase();
        return KINDS.includes(k) ? k : 'agent';
    }

    /* ───────── 交付物 / 产物 ───────── */
    function normalizeDeliverables(v) {
        const list = Array.isArray(v) ? v : (v ? [v] : []);
        const out = [];
        list.forEach(item => {
            if (item && typeof item === 'object') {
                const kind = text(item.kind || item.type || item.format).toLowerCase();
                const label = text(item.label || item.name) || kind;
                const name = text(item.name || item.label) || label;
                if (label) out.push({ kind: kind, name: name, label: label });
            } else {
                const label = text(item);
                if (label) out.push({ kind: label.toLowerCase(), name: label, label: label });
            }
        });
        return out;
    }

    function filesUrl(runId, name) {
        return '/api/agents/runs/' + encodeURIComponent(runId) + '/files/' + encodeURIComponent(name);
    }
    // 后端可能只给文件名不给 url：按命名接口补出可下载地址
    function normalizeArtifacts(v, runId) {
        const list = Array.isArray(v) ? v : (v ? [v] : []);
        const out = [];
        const seen = new Set();
        list.forEach(a => {
            const o = a && typeof a === 'object' ? a : { url: a };
            let url = text(o.url || o.download_url || o.href);
            const name = text(o.name || o.filename || o.label) || '产物';
            if (!url && runId && name) url = filesUrl(runId, name);
            if (!url || seen.has(url)) return;
            seen.add(url);
            out.push({
                kind: text(o.kind || o.type || o.format).toLowerCase(),
                name: name,
                label: text(o.label || o.name) || name,
                url: url,
            });
        });
        return out;
    }

    /* ───────── 能力 ───────── */
    function normalizeCapability(raw) {
        const a = raw && typeof raw === 'object' ? raw : {};
        const id = text(a.id || a.capability_id || a.slug);
        return {
            id: id,
            kind: kindOf(a.kind || a.type),
            name: text(a.name || a.title) || id || '未命名能力',
            category: text(a.category || a.group),
            icon: text(a.icon),
            description: text(a.description || a.desc),
            tags: strList(a.tags),
            deliverables: normalizeDeliverables(a.deliverables),
            enabled: a.enabled !== false,
            available: a.available !== false,
            input_schema: a.input_schema || a.inputSchema || null,
        };
    }

    /* ───────── input_schema.params → 界面字段 ───────── */
    function optionList(v) {
        if (Array.isArray(v)) {
            return v.map(item => {
                if (item && typeof item === 'object') {
                    const value = item.value != null ? item.value : (item.const != null ? item.const : (item.id != null ? item.id : item.key));
                    return { value: value == null ? '' : value, label: text(item.label || item.title || item.name || value) };
                }
                return { value: item, label: text(item) };
            }).filter(o => text(o.label) !== '');
        }
        if (v && typeof v === 'object') return Object.keys(v).map(k => ({ value: k, label: text(v[k]) || k }));
        return [];
    }

    function isFileSpec(o) {
        if (!o || typeof o !== 'object') return false;
        const t = text(o.type).toLowerCase();
        const f = text(o.format).toLowerCase();
        return t === 'file' || t === 'files' || t === 'binary' || f === 'binary' || f === 'file' || !!o.accept;
    }

    function normalizeParam(raw, key) {
        const o = raw && typeof raw === 'object' ? raw : {};
        const name = text(o.name || o.key || o.id) || key;
        const options = optionList(o.options || o.enum || o.choices);
        let type = text(o.type || o.kind).toLowerCase();
        if (type === 'boolean' || type === 'bool' || typeof o.default === 'boolean') type = 'boolean';
        else if (options.length) type = 'select';
        else if (['number', 'integer', 'int', 'float', 'decimal'].includes(type)) type = 'number';
        else if (type === 'textarea' || o.multiline) type = 'textarea';
        else type = 'text';
        let def = o.default != null ? o.default : (o.value != null ? o.value : '');
        if (type === 'boolean') def = def === true || def === 'true' || def === 1 || def === '1';
        return {
            name: name,
            label: text(o.label || o.title) || name,
            type: type,
            required: o.required === true,
            placeholder: text(o.placeholder),
            hint: text(o.hint || o.description),
            options: options,
            def: type === 'boolean' ? !!def : text(def),
        };
    }

    // 只取 input_schema 里的 params（文件沿用 Composer 的附件能力，不走 schema）
    function paramsOf(schema) {
        const s = schema && typeof schema === 'object' ? schema : {};
        const rawParams = [];
        const route = (o, k) => { if (!isFileSpec(o)) rawParams.push(Object.assign({}, o && typeof o === 'object' ? o : {}, { name: (o && o.name) || k })); };
        const ps = s.params || s.fields || s.arguments;
        if (Array.isArray(ps)) ps.forEach((x, i) => route(x, 'param' + (i + 1)));
        else if (ps && typeof ps === 'object') Object.keys(ps).forEach(k => route(ps[k], k));
        if (s.properties && typeof s.properties === 'object') Object.keys(s.properties).forEach(k => route(s.properties[k], k));
        const seen = new Set();
        const out = [];
        rawParams.forEach((p, i) => {
            const item = normalizeParam(p, 'param' + (i + 1));
            if (!item.name || seen.has(item.name)) return;
            seen.add(item.name);
            out.push(item);
        });
        return out;
    }

    /* ───────── 运行 ───────── */
    function normalizeStep(s, i) {
        if (s && typeof s === 'object') {
            return {
                index: s.index == null ? i : s.index,
                tool: text(s.tool),
                status: text(s.status || s.state).toLowerCase(),
                summary: text(s.summary || s.detail || s.label || s.message),
            };
        }
        return { index: i, tool: '', status: '', summary: text(s) };
    }

    function normalizeRun(raw) {
        const o = raw && typeof raw === 'object' ? raw : {};
        const runId = text(o.run_id || o.runId || o.id);
        const list = Array.isArray(o.steps) ? o.steps : [];
        return {
            run_id: runId,
            conversation_id: text(o.conversation_id || o.conversationId),
            capability_id: text(o.capability_id || o.capabilityId || o.agent_id),
            capability_name: text(o.capability_name || o.capabilityName || o.agent_name),
            status: text(o.status || o.state).toLowerCase() || 'queued',
            steps: list.map(normalizeStep).filter(s => s.tool || s.summary),
            artifacts: normalizeArtifacts(o.artifacts, runId),
            error: text(o.error || o.detail),
            created_at: o.created_at || o.createdAt || '',
            updated_at: o.updated_at || o.updatedAt || '',
        };
    }

    function isTerminal(status) {
        return ['done', 'success', 'succeeded', 'completed', 'complete', 'ok', 'error', 'failed', 'aborted', 'cancelled', 'canceled'].includes(text(status).toLowerCase());
    }
    function isFailed(status) {
        return ['error', 'failed', 'cancelled', 'canceled'].includes(text(status).toLowerCase());
    }

    /* ───────── 接口 ───────── */
    async function listCapabilities() {
        let res;
        try { res = await fetch('/api/capabilities', { headers: { Accept: 'application/json' } }); }
        catch (e) { return { ok: false, error: '无法连接能力服务' }; }
        if (!res.ok) return failure('能力列表加载失败', res);
        const data = await jsonBody(res);
        const list = data && Array.isArray(data.capabilities) ? data.capabilities : null;
        if (!list) return { ok: false, error: '能力列表返回格式不正确' };
        return { ok: true, capabilities: list.map(normalizeCapability).filter(a => a.id && a.enabled) };
    }

    async function getCapability(id) {
        if (!id) return { ok: false, error: '缺少能力 id' };
        let res;
        try { res = await fetch('/api/capabilities/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } }); }
        catch (e) { return { ok: false, error: '无法连接能力服务' }; }
        if (!res.ok) return failure('能力详情加载失败', res);
        const data = await jsonBody(res);
        const raw = data && (data.capability || data);
        if (!raw || typeof raw !== 'object') return { ok: false, error: '能力详情返回格式不正确' };
        return { ok: true, capability: normalizeCapability(raw) };
    }

    // files: [{file|raw: File, name}]；params: {category/goal/product..., provider/model}
    async function runCapability(conversationId, capabilityId, files, params, message, signal) {
        if (!conversationId) return { ok: false, error: '缺少会话 id' };
        if (!capabilityId) return { ok: false, error: '缺少能力 id' };
        const form = new FormData();
        (files || []).forEach(item => {
            const file = item && (item.file || item.raw || (typeof File !== 'undefined' && item instanceof File ? item : null));
            if (!file) return;
            // 后端契约固定读 multipart 字段 file（可重复）
            form.append('file', file, file.name || text(item.name) || 'file');
        });
        const payload = Object.assign({}, params || {});
        const msg = text(message).trim();
        if (msg) payload.message = msg;
        form.append('params', JSON.stringify(payload));
        if (msg) form.append('message', msg);
        let res;
        try { res = await fetch('/api/conversations/' + encodeURIComponent(conversationId) + '/capabilities/' + encodeURIComponent(capabilityId) + '/run', { method: 'POST', body: form, signal: signal }); }
        catch (e) {
            if (e && e.name === 'AbortError') return { ok: false, aborted: true, error: '已停止' };
            return { ok: false, error: '无法连接能力服务' };
        }
        if (!res.ok) return failure('运行请求失败', res);
        const data = await jsonBody(res);
        const runId = text(data && (data.run_id || data.runId));
        if (!runId) return { ok: false, error: '运行接口没有返回 run_id' };
        return {
            ok: true,
            runId: runId,
            conversationId: text(data.conversation_id) || conversationId,
            userMessageId: text(data.user_message_id),
            assistantMessageId: text(data.assistant_message_id),
        };
    }

    async function getRun(runId) {
        if (!runId) return { ok: false, error: '缺少运行 id' };
        let res;
        try { res = await fetch('/api/agents/runs/' + encodeURIComponent(runId), { headers: { Accept: 'application/json' } }); }
        catch (e) { return { ok: false, error: '无法连接能力服务' }; }
        if (!res.ok) return failure('运行状态获取失败', res);
        const data = await jsonBody(res);
        const raw = data && (data.run || data);
        if (!raw || typeof raw !== 'object') return { ok: false, error: '运行状态返回格式不正确' };
        return { ok: true, run: normalizeRun(raw) };
    }

    // SSE：解析复用 sse.js；事件名（run_start/plan/step_start/step_result/done/error）随第二个参数回传，也并进事件体 type。
    async function streamRun(runId, onEvent, signal) {
        if (!runId) throw new Error('缺少运行 id');
        const res = await fetch('/api/agents/runs/' + encodeURIComponent(runId) + '/stream', {
            headers: { Accept: 'text/event-stream' },
            signal: signal,
        });
        if (!res.ok || !res.body) throw new Error('进度流不可用（HTTP ' + res.status + '）');
        await readSSE(res, (ev, name) => {
            const body = ev && typeof ev === 'object' ? ev : { value: ev };
            return onEvent(Object.assign({ type: name || '' }, body), name);
        });
    }

    return {
        listCapabilities, getCapability, runCapability, getRun, streamRun,
        normalizeCapability, paramsOf, normalizeArtifacts, normalizeRun,
        isTerminal, isFailed, filesUrl,
    };
})();

export const {
    listCapabilities, getCapability, runCapability, getRun, streamRun,
    normalizeCapability, paramsOf, normalizeArtifacts, normalizeRun,
    isTerminal, isFailed, filesUrl,
} = api;
