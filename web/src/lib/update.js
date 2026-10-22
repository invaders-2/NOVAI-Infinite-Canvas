// 版本与更新：检查新版本（后端优先，浏览器兜底）、一键更新进度与自动重启、重启后的更新日志。
// 界面只展示「版本 + 更新内容 + 进度」；HTTP 状态码、异常名这类技术细节只进 console。
import { reactive } from 'vue';
import { state, toast } from './store.js';

const SOURCE_KEY = 'studio_update_source';
const DISMISSED_KEY = 'novai.update.dismissedVersion';
/* 更新成功、重启之前写入目标版本；重启后据此弹一次「已更新到 vX.Y.Z」 */
const UPDATED_TO_KEY = 'novai.updatedTo';
const PROJECT_URL = 'https://github.com/invaders-2/NOVAI-Infinite-Canvas';

function readLS(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// Electron 桌面版才注入：更新由主进程的 electron-updater 负责，不能走后端自更新（后端自重启会被当成崩溃）
function desktopUpdater() {
    const u = typeof window !== 'undefined' ? window.novaiUpdater : null;
    return u && typeof u.downloadAndInstall === 'function' ? u : null;
}

export const upd = reactive({
    info: { version: '', repo_url: PROJECT_URL },
    remote: '',            // 最新版本（有更新时）
    notes: null,           // { version, items }
    source: ['github', 'gitee', 'modelscope'].includes(readLS(SOURCE_KEY)) ? readLS(SOURCE_KEY) : 'github',
    modalOpen: false,
    reminder: '',          // 右下角提醒的版本
    checking: false,
    running: false,
    progress: null,        // { stage, percent, current_file, files_done, files_total }
    phase: 'idle',         // idle | running | restarting | done | error
    error: '',             // 给用户看的一句人话
});
export const updDone = reactive({ open: false, version: '', notes: null });
let abortCtl = null;

export function versionLabel(v, mode = 'full') {
    const text = String(v || '').trim();
    if (!text) return 'v-';
    if (mode === 'compact') { const p = text.match(/\d+/g) || []; return 'v' + (p.length >= 3 ? `${p[1]}.${p[2]}` : text.replace(/^v/i, '')); }
    return 'v' + text.replace(/^v/i, '');
}
function parts(v) { return (String(v || '').match(/\d+/g) || []).map(Number); }
export function compareVersions(a, b) {
    const ca = parts(String(a || '').split('-')[0]), cb = parts(String(b || '').split('-')[0]);
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) { const d = (ca[i] || 0) - (cb[i] || 0); if (d) return d; }
    const pa = String(a || '').includes('-'), pb = String(b || '').includes('-');
    if (pa !== pb) return pb ? 1 : -1;
    const aa = parts(a), bb = parts(b);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) { const d = (aa[i] || 0) - (bb[i] || 0); if (d) return d; }
    return String(a || '').trim() === String(b || '').trim() ? 0 : 1;
}
export const hasUpdate = () => !!(upd.remote && state.version && compareVersions(upd.remote, state.version) > 0);

export function setSource(s) {
    upd.source = ['github', 'gitee', 'modelscope'].includes(s) ? s : 'github';
    writeLS(SOURCE_KEY, upd.source);
}

async function loadInfo() {
    const info = await fetch('/api/app-info', { cache: 'no-store' }).then(r => r.json()).catch(() => ({}));
    upd.info = { ...upd.info, ...info };
    state.version = String(upd.info.version || '').trim();
    return !!state.version;
}

export async function checkForUpdates(manual = false) {
    upd.checking = true;
    try {
        await loadInfo();
        let current = state.version;
        let best = null, reachable = false, serverChecked = false;
        try {
            const r = await fetch('/api/check-update', { cache: 'no-store' });
            if (r.ok) {
                const d = await r.json();
                serverChecked = true; reachable = !!d.reachable;
                if (d.current) { current = String(d.current).trim(); state.version = current; }
                if (d.latest && d.latest.version) best = { source: d.latest.source, version: d.latest.version, notes: d.latest.update_notes || d.update_notes || null };
            }
        } catch (e) {}
        if (!serverChecked || !best) {
            const src = upd.info.sources || {};
            const cands = [
                { source: 'github', url: (src.github && src.github.version_url) || upd.info.version_url || '' },
                { source: 'gitee', url: (src.gitee && src.gitee.version_url) || '' },
            ].filter(x => x.url);
            for (const c of cands) {
                try {
                    const txt = await fetch(`${c.url}${c.url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' }).then(r => (r.ok ? r.text() : ''));
                    const remote = String(txt || '').trim().split(/\r?\n/)[0].trim();
                    if (remote) { reachable = true; if (!best || compareVersions(remote, best.version) > 0) best = { source: c.source, version: remote }; }
                } catch (e) {}
            }
        }
        const found = !!(current && best && best.version && compareVersions(best.version, current) > 0);
        if (found) {
            upd.remote = best.version;
            state.remoteVersion = best.version;
            if (best.notes) upd.notes = best.notes;
            if (!manual) maybeRemind(best.version);
        }
        if (manual) {
            if (found) { toast(`发现新版本 ${versionLabel(best.version)}，点击查看更新`, { icon: 'arrowup', onClick: openUpdateModal }); openUpdateModal(); }
            else if (reachable) toast(`已是最新版本（${versionLabel(current)}）`, { icon: 'check' });
            else toast('暂时连不上更新服务器，稍后再试', { danger: true, icon: 'alert' });
        }
    } catch (e) {
        console.error('[update] 检查更新失败：', e);
        if (manual) toast('暂时连不上更新服务器，稍后再试', { danger: true, icon: 'alert' });
    } finally {
        upd.checking = false;
    }
}

function maybeRemind(v) {
    const dismissed = readLS(DISMISSED_KEY);
    if (dismissed && compareVersions(v, dismissed) <= 0) return;
    upd.reminder = v;
}
export function dismissReminder() { if (upd.reminder) writeLS(DISMISSED_KEY, upd.reminder); upd.reminder = ''; }

export function openUpdateModal() {
    if (!upd.running) { upd.phase = 'idle'; upd.error = ''; }
    upd.modalOpen = true;
    fetch('/api/changelog').then(r => (r.ok ? r.json() : null)).then(d => { if (d && Array.isArray(d.items) && d.items.length) upd.notes = d; }).catch(() => {});
}
export function closeUpdateModal() {
    if (upd.running) { try { abortCtl && abortCtl.abort(); } catch (e) {} }
    upd.modalOpen = false;
}

/* ───────── 一键更新 ───────── */
let pollTimer = null, pollSeq = 0;
function stopPoll() { pollSeq++; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
async function poll() {
    const my = ++pollSeq;
    try {
        const res = await fetch('/api/update-progress', { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        if (my !== pollSeq) return;
        upd.progress = d;
        if (!d.running && ['done', 'error', 'restarting'].includes(d.stage)) stopPoll();
    } catch (e) {}
}
/* 进度只说人话：具体在传哪个文件对用户没意义 */
export function stageText(p) {
    const s = (p && p.stage) || '';
    return ({ downloading: '下载中', backup: '正在备份', applying: '正在安装', restarting: '正在重启', done: '更新完成', error: '更新失败' })[s] || '正在准备';
}
async function waitAndReload() {
    const deadline = Date.now() + 90000;
    await new Promise(r => setTimeout(r, 4000));
    while (Date.now() < deadline) {
        try { const r = await fetch('/api/app-info', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch (e) {}
        await new Promise(r => setTimeout(r, 1500));
    }
}
export async function startUpdate() {
    if (upd.running) return;
    /* 桌面版：只把点击转交 electron-updater，不调 /api/update-from-github、
       不轮询后端进度、也不写「已更新」标记（重启由主进程 quitAndInstall 负责）。 */
    const desktop = desktopUpdater();
    if (desktop) {
        upd.error = '';
        try {
            const res = await desktop.downloadAndInstall();
            if (res && res.supported === false) {
                toast('当前桌面版不支持自动更新，请到发布页下载安装包覆盖安装', { danger: true, icon: 'alert' });
            } else {
                toast('已转交桌面版更新，请按弹窗提示操作', { icon: 'arrowup' });
            }
        } catch (e) {
            console.error('[update] 转交桌面版更新失败：', e);
            toast('桌面版更新暂时不可用，请稍后重试', { danger: true, icon: 'alert' });
        }
        return;
    }
    upd.running = true;
    upd.phase = 'running';
    upd.error = '';
    stopPoll(); upd.progress = { stage: '', percent: 0 }; poll(); pollTimer = setInterval(poll, 1000);
    abortCtl = new AbortController();
    const killer = setTimeout(() => abortCtl.abort(), 300000);
    try {
        const res = await fetch('/api/update-from-github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_restart: true, restart_delay: 3, source: upd.source, fallback: true }), signal: abortCtl.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data && data.detail) || `HTTP ${res.status}`);
        if (data.update_notes) upd.notes = data.update_notes;
        /* 重启后要弹的更新日志：版本从响应里取，取不到用检查到的远端版本 */
        const target = String(data.version || state.remoteVersion || upd.remote || '').trim();
        if (target) writeLS(UPDATED_TO_KEY, target);
        upd.remote = ''; state.remoteVersion = '';
        if (data.version) state.version = data.version;
        upd.phase = data.restart_scheduled ? 'restarting' : 'done';
        if (data.restart_scheduled) waitAndReload();
    } catch (e) {
        console.error('[update] 更新失败：', e);
        upd.phase = 'error';
        upd.error = '更新失败，请检查网络后重试';
    } finally {
        clearTimeout(killer); abortCtl = null; stopPoll(); upd.running = false;
    }
}

/* ───────── 重启后的「已更新到 vX.Y.Z」 ───────── */
/* 标记与当前版本对不上（用户又换了版本）就静默清掉，不打扰用户 */
export async function checkUpdateDone() {
    const target = readLS(UPDATED_TO_KEY);
    if (!target) return;
    if (!state.version) await loadInfo();
    if (!state.version) return;   // 拿不到当前版本就先留着标记，下次启动再判断
    if (compareVersions(target, state.version) !== 0) { writeLS(UPDATED_TO_KEY, ''); return; }
    updDone.version = target;
    updDone.notes = (upd.notes && Array.isArray(upd.notes.items) && upd.notes.items.length) ? upd.notes : null;
    updDone.open = true;
    if (!updDone.notes) {
        fetch('/api/changelog').then(r => (r.ok ? r.json() : null)).then(d => { if (d && Array.isArray(d.items) && d.items.length) updDone.notes = d; }).catch(() => {});
    }
}
export function closeUpdateDone() {
    updDone.open = false;
    writeLS(UPDATED_TO_KEY, '');
}

/* ───────── 回滚（旧版只有函数没有按钮，这里补上入口） ───────── */
export async function listUpdateBackups() {
    const d = await fetch('/api/update-backups', { cache: 'no-store' }).then(r => r.json());
    return d.backups || [];
}
export async function rollback(name) {
    /* 桌面版不让后端自重启（同样会被主进程当成崩溃），还原后提示用户重开应用 */
    const autoRestart = !desktopUpdater();
    const res = await fetch('/api/update-rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, auto_restart: autoRestart, restart_delay: 3 }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || '回滚失败');
    if (data.restart_scheduled) waitAndReload();
    return data;
}

export function initUpdates() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('studio_general_settings') || '{}') || {}; } catch (e) {}
    if (s.autoCheckUpdate !== false) checkForUpdates(false);
    else loadInfo();
    checkUpdateDone();
}
