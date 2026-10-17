// OpenClaw 安装引导的对话页共享状态：检测结果 / 弹窗开关 / 安装进度。
// 刻意「按需」：不在应用启动时探测，只在用到 OpenClaw 的地方（智能体广场、挂了能力的输入框）调用 ensureStatus()。
// 检测失败不抛给组件、不刷屏，界面只降级为「检测不到」；安装必须用户显式点确认才会发请求。
import { reactive } from 'vue';
import { readSSE } from '../sse.js';
import {
    normalizeStatus, needsInstall, commandOf, canStartInstall, eventToLog,
} from './openclawSetupCore.js';

export const OC = reactive({
    checked: false,     // 是否已经探测过一次
    loading: false,
    error: '',
    status: null,
    modal: false,
    phase: 'confirm',   // confirm | running | done | partial | failed | cancelled
    logs: [],
    result: null,
    errorCode: '',      // 后端给的失败类型（如 permission_denied / init_incomplete），用于给明确指引
    permissionHint: '',
    initIncomplete: false,  // 包已安装但收尾未完成：独立终态，走 partial 结果页
    closing: false,
});

let controller = null;

export function loadStatus(force) {
    if (OC.loading) return Promise.resolve(OC.status);
    OC.loading = true;
    const url = '/api/openclaw/status' + (force ? '?force=1' : '');
    return fetch(url, { headers: { Accept: 'application/json' } })
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
            OC.loading = false;
            if (!data || typeof data !== 'object') { OC.error = '检测接口不可用'; return OC.status; }
            OC.status = normalizeStatus(data);
            OC.checked = true;
            OC.error = '';
            return OC.status;
        })
        .catch(() => {
            OC.loading = false;
            OC.error = '检测接口不可用';
            return OC.status;
        });
}

// 组件按需调用：已经探测过且不强制刷新就直接复用，避免每次开面板都打接口
export function ensureStatus(force) {
    if (OC.checked && !force) return Promise.resolve(OC.status);
    return loadStatus(force);
}

export function installNeeded() {
    return needsInstall(OC.status);
}

export function setupCommand() {
    return commandOf(OC.status);
}

export function readyToInstall() {
    return canStartInstall(OC.status);
}

export function openInstallModal() {
    OC.modal = true;
    if (OC.phase !== 'running') {
        OC.phase = 'confirm';
        OC.logs = [];
        OC.result = null;
        OC.initIncomplete = false;
    }
    ensureStatus(true);
}

export function closeInstallModal() {
    if (OC.phase === 'running') return false;
    OC.modal = false;
    return true;
}

function pushLog(entry) {
    if (entry && entry.text) OC.logs.push(entry);
    if (OC.logs.length > 400) OC.logs.splice(0, OC.logs.length - 400);
}

export async function startInstall() {
    if (OC.phase === 'running') return false;
    if (!readyToInstall()) {
        OC.phase = 'failed';
        OC.logs = [];
        pushLog({ kind: 'error', level: 'error', text: '安装命令未就绪：请检查 ' + ((OC.status && OC.status.config_source) || 'config/openclaw.json') });
        return false;
    }
    OC.phase = 'running';
    OC.logs = [];
    OC.result = null;
    OC.error = '';
    OC.errorCode = '';
    OC.permissionHint = '';
    OC.initIncomplete = false;
    controller = new AbortController();
    try {
        const res = await fetch('/api/openclaw/install', {
            method: 'POST',
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
        });
        if (!res.ok || !res.body) {
            let detail = '安装接口不可用（HTTP ' + res.status + '）';
            try { const data = await res.json(); if (data && data.detail) detail = String(data.detail); } catch (e) {}
            OC.phase = 'failed';
            pushLog({ kind: 'error', level: 'error', text: detail });
            return false;
        }
        await readSSE(res, (ev, name) => {
            const entry = eventToLog(ev, name);
            if (entry) pushLog(entry);
            if (entry && entry.kind === 'error') {
                OC.error = entry.text;
                if (entry.code) OC.errorCode = entry.code;
                if (entry.code === 'permission_denied') {
                    OC.permissionHint = entry.hint || ((OC.status && OC.status.setup && OC.status.setup.permission_hint) || '');
                }
            }
            if (entry && entry.kind === 'done') {
                if (!entry.ok) {
                    OC.error = entry.text;
                    if (entry.code) OC.errorCode = entry.code;
                }
                OC.result = normalizeStatus(ev && ev.result);
                OC.status = OC.result;
                OC.checked = true;
                OC.initIncomplete = entry.initIncomplete === true;
                if (entry.ok) OC.phase = 'done';
                else if (OC.initIncomplete) OC.phase = 'partial';
                else if (/取消/.test(entry.text)) OC.phase = 'cancelled';
                else OC.phase = 'failed';
            }
        });
        if (OC.phase === 'running') {
            // 流正常结束却没收到 done：如实标失败，不假装成功
            OC.phase = 'failed';
            pushLog({ kind: 'error', level: 'error', text: '安装流意外结束，未收到完成事件' });
        }
    } catch (err) {
        if (err && err.name === 'AbortError') {
            OC.phase = 'cancelled';
            pushLog({ kind: 'error', level: 'error', text: '安装已取消' });
        } else {
            OC.phase = 'failed';
            pushLog({ kind: 'error', level: 'error', text: '安装请求失败：' + ((err && err.message) || err) });
        }
    } finally {
        controller = null;
    }
    return OC.phase === 'done';
}

export async function cancelInstall() {
    if (controller) {
        try { controller.abort(); } catch (e) {}
        controller = null;
    }
    try {
        await fetch('/api/openclaw/install/cancel', { method: 'POST' });
    } catch (e) {}
    if (OC.phase === 'running') OC.phase = 'cancelled';
    // 取消后实测一次真实状态，避免界面停留在「运行中」
    await loadStatus(true);
    return true;
}

export function retryInstall() {
    OC.phase = 'confirm';
    OC.logs = [];
    OC.result = null;
    OC.initIncomplete = false;
    return startInstall();
}
