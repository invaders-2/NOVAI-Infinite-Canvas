// API 设置三块子面板（RunningHub / CLI / Lovart）共用的小工具。
import { ref } from 'vue';
import { broadcast } from '../../../../lib/bridge.js';

// 与旧 api-settings.js broadcastStudioApiChange 完全一致：BroadcastChannel + 通知外壳（外壳再转发给所有旧页面 iframe）
export function broadcastStudioApiChange(type = 'providers-changed') {
    const message = { type, updated_at: Date.now() };
    try { new BroadcastChannel('studio-api').postMessage(message); } catch (e) {}
    try { broadcast(message); } catch (e) {}
}

export function prettyJson(value) {
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value || ''); }
}

// fetch → json；!ok 时抛 detail
export async function fetchJson(url, opts, failText = '请求失败') {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && typeof data.detail === 'string' && data.detail) || failText);
    return data;
}
export function postJson(url, body, failText) {
    return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }, failText);
}

// 替代旧 confirm()：const c = useConfirm(); if (!(await c.ask({ title, desc, ok }))) return;  模板里 <ApiConfirm :state="c.st.value" @done="c.done" />
export function useConfirm() {
    const st = ref(null);
    function ask(opts) { return new Promise(resolve => { st.value = { ok: '确认', danger: true, ...opts, resolve }; }); }
    function done(v) { const s = st.value; st.value = null; if (s) s.resolve(!!v); }
    return { st, ask, done };
}
