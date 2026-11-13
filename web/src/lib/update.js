// 版本与更新：检查新版本（后端优先，浏览器兜底）、一键更新进度与自动重启、重启后的更新日志。
// 界面只展示「版本 + 更新内容 + 进度」；HTTP 状态码、异常名这类技术细节只进 console。
import { reactive } from 'vue';
import { state, toast } from './store.js';

const SOURCE_KEY = 'studio_update_source';
const DISMISSED_KEY = 'novai.update.dismissedVersion';
/* 更新成功、重启之前写入目标版本；重启后据此弹一次「已更新到 vX.Y.Z」 */
const UPDATED_TO_KEY = 'novai.updatedTo';
/* 卡片点了「稍后 / ×」记下版本，同版本不再打扰；出现更高版本才会重新提醒 */
const CARD_SNOOZE_KEY = 'novai.update.cardSnoozed';
const PREVIEW_PARAM = 'novaiUpdatePreview';
const PROJECT_URL = 'https://github.com/invaders-2/NOVAI-Infinite-Canvas';
const RELEASE_LATEST_URL = 'https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases/latest';

function readLS(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// Electron 桌面版才注入：更新由主进程的 electron-updater 负责，不能走后端自更新（后端自重启会被当成崩溃）
function desktopUpdater() {
    const u = typeof window !== 'undefined' ? window.novaiUpdater : null;
    return u && typeof u.downloadAndInstall === 'function' ? u : null;
}

/* 新版桌面端（IPC 契约 v1）：主进程后台静默下载，只用 novai:update-stage 推事件。
   没有 onStage 的（浏览器 / 老桌面端）返回 null，调用方继续走「发现新版本 → 手动点更新」。 */
function stageBridge() {
    const u = typeof window !== 'undefined' ? window.novaiUpdater : null;
    return u && typeof u.onStage === 'function' ? u : null;
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
    card: '',              // 右下角卡片：'' | 'downloaded' | 'installing' | 'error'
    cardVersion: '',
    cardError: '',
});
export const updDone = reactive({ open: false, version: '', previous: '', notes: null });
let abortCtl = null;
/* 桌面版进度订阅：Windows 的下载在 downloadAndInstall 返回之后才开始，
   Promise 结束时不能退订；保留到终态、用户关弹窗或 30 分钟超时。 */
const DESKTOP_PROGRESS_TIMEOUT = 30 * 60 * 1000;
let desktopProgressOff = null;
let desktopProgressTimer = null;

function releaseDesktopProgress() {
    if (desktopProgressTimer) { clearTimeout(desktopProgressTimer); desktopProgressTimer = null; }
    if (desktopProgressOff) {
        const off = desktopProgressOff;
        desktopProgressOff = null;
        try { off(); } catch (e) {}
    }
}
function applyDesktopProgress(payload) {
    const p = payload || {};
    const stage = p.stage || 'downloading';
    if (stage === 'error') {
        upd.running = false;
        upd.phase = 'error';
        upd.error = '自动更新没有完成，请稍后重试';
        releaseDesktopProgress();
        return;
    }
    upd.progress = {
        stage,
        percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
        transferred: Number(p.transferred) || 0,
        total: Number(p.total) || 0,
    };
    /* final 只由主进程「真正开始安装」时发；installing 也可能只是下载完成等待确认 */
    if (stage === 'done' || p.final === true || p.restarting === true) {
        upd.running = false;
        upd.phase = stage === 'done' ? 'done' : 'restarting';
        releaseDesktopProgress();
        return;
    }
    upd.running = true;
    upd.phase = 'running';
}
function ensureDesktopProgress(desktop) {
    if (desktopProgressOff || !desktop || typeof desktop.onProgress !== 'function') return;
    desktopProgressOff = desktop.onProgress(applyDesktopProgress);
    if (desktopProgressTimer) clearTimeout(desktopProgressTimer);
    desktopProgressTimer = setTimeout(() => {
        desktopProgressTimer = null;
        if (upd.running && !upd.progress) { upd.running = false; upd.phase = 'idle'; }
        releaseDesktopProgress();
    }, DESKTOP_PROGRESS_TIMEOUT);
}
/* 桌面更新弹窗关闭 / 组件卸载时由界面调用 */
export function stopDesktopUpdateProgress() { releaseDesktopProgress(); }

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
            /* 新版桌面端由主进程静默下载，前端不再弹「发现新版本」 */
            if (!manual && !stageBridge()) maybeRemind(best.version);
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
    else {
        /* 关弹窗时退订了；重新打开时恢复订阅（主进程下载还在继续） */
        const desktop = desktopUpdater();
        if (desktop) ensureDesktopProgress(desktop);
    }
    upd.modalOpen = true;
    fetch('/api/changelog').then(r => (r.ok ? r.json() : null)).then(d => { if (d && Array.isArray(d.items) && d.items.length) upd.notes = d; }).catch(() => {});
}
export function closeUpdateModal() {
    if (upd.running) { try { abortCtl && abortCtl.abort(); } catch (e) {} }
    releaseDesktopProgress();
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
    return ({ preparing: '准备下载', downloading: '下载中', backup: '正在备份', applying: '正在安装', installing: '正在替换安装', restarting: '正在重启', done: '更新完成', error: '更新失败' })[s] || '正在准备';
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
        if (!upd.running) { upd.phase = 'idle'; upd.progress = null; }
        /* 进度由主进程的 novai:update-progress 推送。Windows 的下载在
           downloadAndInstall 返回后才开始，订阅必须留到终态 / 关弹窗 / 超时。 */
        ensureDesktopProgress(desktop);
        try {
            const res = await desktop.downloadAndInstall();
            if (res && res.supported === false) {
                console.warn('[update] 桌面更新不可用', res.reason);
                releaseDesktopProgress();
                toast('当前桌面版不支持在线更新，点这里去下载新版本', { danger: true, icon: 'alert', onClick: () => window.open(RELEASE_LATEST_URL, '_blank', 'noopener') });
            } else if (res && res.ok === false) {
                releaseDesktopProgress();
                upd.running = false;
                upd.phase = 'error';
                upd.error = '自动更新没有完成，请稍后重试';
                toast('桌面版更新没有完成，请稍后重试', { danger: true, icon: 'alert' });
            } else {
                /* 还没有进度事件时不要显示一个假的 0%；事件到了再进入 running */
                if (!upd.progress) { upd.running = false; upd.phase = 'idle'; }
                toast('已转交桌面版更新，请按弹窗提示操作', { icon: 'arrowup' });
            }
        } catch (e) {
            console.error('[update] 转交桌面版更新失败：', e);
            releaseDesktopProgress();
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

/* ───────── 更新说明（重启后 / applied 事件共用） ───────── */
const MEDIA_TYPES = ['image', 'gif', 'video'];
const TYPE_LABELS = { feature: '新功能', fix: '修复', improve: '优化' };
export function noteTypeLabel(type) { return TYPE_LABELS[String(type || '')] || ''; }

function pickMedia(media) {
    if (!media || typeof media !== 'object') return null;
    const type = String(media.type || '').toLowerCase();
    const src = String(media.src || '').trim();
    if (!MEDIA_TYPES.includes(type) || !src) return null;
    const caption = String(media.caption || '').trim();
    return caption ? { type, src, caption } : { type, src };
}
/* 更新说明兼容两种数据：带 media 的新结构和只有字符串的旧结构 */
export function normalizeNotes(notes) {
    if (!notes || typeof notes !== 'object' || !Array.isArray(notes.items)) return null;
    const items = [];
    for (const raw of notes.items) {
        if (raw == null) continue;
        if (typeof raw === 'string') {
            const text = raw.trim();
            if (text) items.push({ type: '', text });
            continue;
        }
        if (typeof raw !== 'object') continue;
        const text = String(raw.text || raw.title || '').trim();
        if (!text) continue;
        const item = { type: String(raw.type || '').trim(), text };
        const media = pickMedia(raw.media);
        if (media) item.media = media;
        items.push(item);
    }
    if (!items.length) return null;
    return {
        version: String(notes.version || '').trim(),
        updated_at: String(notes.updated_at || notes.date || '').trim(),
        items,
    };
}
function fetchChangelogNotes(into) {
    fetch('/api/changelog').then(r => (r.ok ? r.json() : null)).then(d => {
        const notes = normalizeNotes(d);
        if (notes) into.notes = notes;
    }).catch(() => {});
}
/* applied 事件与 localStorage 标记两条链路都走这里：同一版本一次会话只弹一次。
   applied 携带的说明更完整（含 media），已弹出时用它升级内容而不是再弹一次。 */
let doneShownFor = '';
function upgradeNotes(notes) {
    const next = normalizeNotes(notes);
    if (!next) return null;
    if (!updDone.notes) return next;
    const nextHasMedia = next.items.some(it => it.media);
    const curHasMedia = (updDone.notes.items || []).some(it => it && it.media);
    return nextHasMedia || !curHasMedia ? next : null;
}
function openUpdateDone(version, notes, previous) {
    const v = String(version || '').trim();
    if (v && doneShownFor && compareVersions(v, doneShownFor) === 0) {
        if (!updDone.open) return;
        const next = upgradeNotes(notes);
        if (next) updDone.notes = next;
        if (previous) updDone.previous = String(previous).trim();
        return;
    }
    if (v) doneShownFor = v;
    updDone.version = v;
    updDone.previous = String(previous || '').trim();
    updDone.notes = normalizeNotes(notes) || normalizeNotes(upd.notes);
    updDone.open = true;
    if (!updDone.notes) fetchChangelogNotes(updDone);
}
/* 标记与当前版本对不上（用户又换了版本）就静默清掉，不打扰用户 */
export async function checkUpdateDone() {
    const target = readLS(UPDATED_TO_KEY);
    if (!target) return;
    if (!state.version) await loadInfo();
    if (!state.version) return;   // 拿不到当前版本就先留着标记，下次启动再判断
    if (compareVersions(target, state.version) !== 0) { writeLS(UPDATED_TO_KEY, ''); return; }
    openUpdateDone(target, upd.notes, '');
}
export function closeUpdateDone() {
    const v = updDone.version;
    updDone.open = false;
    writeLS(UPDATED_TO_KEY, '');
    const desktop = stageBridge();
    if (v && desktop && typeof desktop.markNotesSeen === 'function') {
        try { desktop.markNotesSeen(v); } catch (e) {}
    }
}

/* ───────── 新版桌面端：静默下载 → 右下角卡片 → 重启安装 ───────── */
const STAGE_ERROR_TEXT = {
    check: '没能检查到新版本，稍后会自动再试',
    download: '新版本没有下载成功，请检查网络后重试',
    install: '安装没有完成，点重试再试一次',
};
function stageErrorText(phase) { return STAGE_ERROR_TEXT[String(phase || '')] || '更新没有完成，点重试再试一次'; }
/* 「稍后 / ×」记过这个版本就静默，出现更高版本才会再提醒 */
function cardSnoozed(version) {
    const v = readLS(CARD_SNOOZE_KEY);
    return !!(v && version && compareVersions(version, v) <= 0);
}
let installWatchdog = null;
function clearInstallWatchdog() { if (installWatchdog) { clearTimeout(installWatchdog); installWatchdog = null; } }
/* 点了「立即重启」后主进程要退出重装；迟迟没退出说明卡住了，退回可重试的失败态 */
function armInstallWatchdog() {
    clearInstallWatchdog();
    installWatchdog = setTimeout(() => {
        installWatchdog = null;
        if (upd.card !== 'installing') return;
        upd.card = 'error';
        upd.cardError = '安装没有开始，点重试再试一次';
    }, 25000);
}
function applyUpdateStage(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const version = String(p.version || '').trim();
    switch (p.stage) {
        case 'downloading': {
            const total = Number(p.total) || 0;
            const transferred = Number(p.transferred) || 0;
            const percent = Number.isFinite(Number(p.percent)) ? Number(p.percent) : (total ? (transferred / total) * 100 : 0);
            upd.progress = { stage: 'downloading', percent: Math.max(0, Math.min(100, percent)), transferred, total };
            upd.running = true;
            upd.phase = 'running';
            upd.card = '';   // 后台静默下载，不弹卡片
            clearInstallWatchdog();
            return;
        }
        case 'downloaded': {
            clearInstallWatchdog();
            upd.running = false;
            upd.phase = 'idle';
            upd.progress = null;
            if (version) { upd.remote = version; state.remoteVersion = version; }
            if (p.notes) upd.notes = normalizeNotes(p.notes) || upd.notes;
            upd.cardVersion = version || upd.remote || '';
            upd.cardError = '';
            upd.card = cardSnoozed(upd.cardVersion) ? '' : 'downloaded';
            return;
        }
        case 'installing': {
            upd.cardVersion = version || upd.cardVersion;
            upd.cardError = '';
            upd.card = 'installing';
            armInstallWatchdog();
            return;
        }
        case 'error': {
            clearInstallWatchdog();
            upd.running = false;
            upd.phase = 'error';
            upd.progress = null;
            upd.error = stageErrorText(p.phase);
            console.warn('[update] 桌面更新失败：', p.phase || '', p.message || '');
            upd.cardVersion = version || upd.cardVersion || upd.remote || '';
            upd.cardError = upd.error;
            upd.card = cardSnoozed(upd.cardVersion) ? '' : 'error';
            return;
        }
        case 'applied': {
            clearInstallWatchdog();
            upd.running = false;
            upd.phase = 'done';
            writeLS(UPDATED_TO_KEY, '');   // applied 已接管，旧链路不能再弹第二次
            openUpdateDone(version, p.notes, p.previousVersion);
            return;
        }
    }
}
export async function restartUpdateNow() {
    const desktop = stageBridge();
    if (!desktop || typeof desktop.restartNow !== 'function') return;
    upd.cardError = '';
    upd.card = 'installing';
    armInstallWatchdog();
    try {
        const res = await desktop.restartNow();
        if (res && res.ok === false) {
            clearInstallWatchdog();
            upd.card = 'error';
            upd.cardError = stageErrorText(res.phase || 'install');
            console.warn('[update] 主进程没受理重启安装：', res.reason || '');
        }
    } catch (e) {
        console.error('[update] 重启安装失败：', e);
        clearInstallWatchdog();
        upd.card = 'error';
        upd.cardError = '没能启动安装，点重试再试一次';
    }
}
/* 稍后：登记成「退出时安装」，本次会话不再打扰 */
export function snoozeUpdateCard() {
    const desktop = stageBridge();
    if (desktop && typeof desktop.installOnQuit === 'function') {
        try { desktop.installOnQuit(); } catch (e) { console.error('[update] 登记退出时安装失败：', e); }
    }
    if (upd.cardVersion) writeLS(CARD_SNOOZE_KEY, upd.cardVersion);
    clearInstallWatchdog();
    upd.card = '';
}
export function dismissUpdateCard() {
    if (upd.cardVersion) writeLS(CARD_SNOOZE_KEY, upd.cardVersion);
    clearInstallWatchdog();
    upd.card = '';
}
export async function retryUpdateInstall() {
    const desktop = stageBridge();
    if (!desktop) return;
    if (typeof desktop.retryInstall !== 'function') { restartUpdateNow(); return; }
    upd.cardError = '';
    upd.card = '';   // 重试后回到静默，等主进程重新推事件
    clearInstallWatchdog();
    try {
        const res = await desktop.retryInstall();
        if (res && res.ok === false) {
            upd.card = 'error';
            upd.cardError = stageErrorText(res.phase || 'download');
        }
    } catch (e) {
        console.error('[update] 重试更新失败：', e);
        upd.card = 'error';
        upd.cardError = '重试没有成功，稍后再试一次';
    }
}

/* 调试开关：?novaiUpdatePreview=downloaded|applied|error
   没有 Electron 桥时才生效，注入假桥播一次事件；给截图验证用，真实桌面端不受影响。 */
function previewMode() {
    if (typeof window === 'undefined') return '';
    if (stageBridge()) return '';
    try {
        const mode = new URLSearchParams(window.location.search).get(PREVIEW_PARAM) || '';
        return ['downloaded', 'applied', 'error'].includes(mode) ? mode : '';
    } catch (e) {
        return '';
    }
}
function previewNotes() {
    return {
        version: '2.0.7',
        updated_at: '2026-11-10T12:00:00+08:00',
        items: [
            { type: 'feature', text: '画布支持框选多个节点后一键对齐，间距可调', media: { type: 'gif', src: '/static/images/modelscope.gif', caption: '一键对齐演示' } },
            { type: 'feature', text: '首页导航换成液态玻璃，选中块跟随指针滑动', media: { type: 'image', src: '/static/images/logo.png', caption: '新的导航选中态' } },
            { type: 'improve', text: '视频预览改为静音循环播放', media: { type: 'video', src: '/static/images/templates/video-relay.mp4', caption: '视频循环预览' } },
            { type: 'fix', text: '修复更新下载到一半断网后进度停在原地的问题' },
            { type: 'fix', text: '修复深色模式下右下角卡片发灰的问题' },
        ],
    };
}
function installPreviewBridge(mode) {
    if (typeof window === 'undefined') return;
    const listeners = [];
    window.novaiUpdater = {
        checkNow: async () => ({ ok: true, version: '2.0.7' }),
        downloadAndInstall: async () => ({ ok: true }),
        onProgress: () => () => {},
        onStage: (cb) => {
            if (typeof cb !== 'function') return () => {};
            listeners.push(cb);
            return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
        },
        restartNow: async () => ({ ok: true }),
        installOnQuit: async () => ({ ok: true }),
        markNotesSeen: async () => ({ ok: true }),
        retryInstall: async () => ({ ok: true }),
    };
    const emit = (p) => listeners.slice().forEach(fn => { try { fn(p); } catch (e) {} });
    setTimeout(() => {
        if (mode === 'downloaded') emit({ stage: 'downloaded', version: '2.0.7', notes: previewNotes() });
        else if (mode === 'applied') emit({ stage: 'applied', version: '2.0.7', previousVersion: '2.0.6', notes: previewNotes() });
        else emit({ stage: 'error', phase: 'download', message: 'preview' });
    }, 700);
}
let stageOff = null;
/* 接上新版桌面端返回 true；有桥就完全交给主进程，前端不再主动查更新、不弹「发现新版本」 */
export function initUpdateStage() {
    const preview = previewMode();
    if (preview) installPreviewBridge(preview);
    const desktop = stageBridge();
    if (!desktop) return false;
    if (!stageOff) {
        try { stageOff = desktop.onStage(applyUpdateStage) || null; } catch (e) { stageOff = null; console.error('[update] 订阅桌面更新事件失败：', e); }
    }
    return true;
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
    /* 新版桌面端：主进程自己查 + 后台下载，前端只等 novai:update-stage */
    if (initUpdateStage()) loadInfo();
    else if (s.autoCheckUpdate !== false) checkForUpdates(false);
    else loadInfo();
    checkUpdateDone();
}
