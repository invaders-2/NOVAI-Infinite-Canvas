// 版本与更新：检查新版本（后端优先，浏览器兜底）、三个下载源的连通性测试、一键更新进度、更新回滚。
// 逻辑与旧 index.html 一致，只是把状态收进一个 reactive 对象，界面各处共用。
import { reactive } from 'vue';
import { state, toast } from './store.js';

const SOURCE_KEY = 'studio_update_source';
const DISMISSED_KEY = 'novai.update.dismissedVersion';
const PROJECT_URL = 'https://github.com/invaders-2/NOVAI-Infinite-Canvas';

function readLS(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

export const SOURCES = [
    { id: 'modelscope', title: 'ModelScope 下载源', desc: 'ModelScope API / raw 文件，国内网络推荐，无需代理。' },
    { id: 'gitee', title: 'Gitee 下载源', desc: 'Gitee API / raw 文件，国内网络推荐，无需代理。' },
    { id: 'github', title: 'GitHub 下载源', desc: 'GitHub API / raw 文件 / GitHub 网页，Google 仅作外网参考。' },
];
export const SOURCE_LABEL = { github: 'GitHub', gitee: 'Gitee', modelscope: 'ModelScope' };

export const upd = reactive({
    info: { version: '', repo_url: PROJECT_URL },
    remote: '',            // 最新版本（有更新时）
    notes: null,           // { version, items }
    source: ['github', 'gitee', 'modelscope'].includes(readLS(SOURCE_KEY)) ? readLS(SOURCE_KEY) : 'github',
    modalOpen: false,
    reminder: '',          // 右下角提醒的版本
    checking: false,
    testing: false,
    conn: null,            // { results, sources, ok, backend_missing }
    live: null,            // 测试中的逐条结果
    running: false,
    progress: null,        // { stage, percent, current_file, files_done, files_total }
    summary: { kind: 'warn', title: '建议先测试连通性', text: '测试会检测 GitHub / Gitee 连通性。' },
});
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
    refreshSummary();
}

async function loadInfo() {
    const info = await fetch('/api/app-info', { cache: 'no-store' }).then(r => r.json()).catch(() => ({}));
    upd.info = { ...upd.info, ...info };
    state.version = String(upd.info.version || '').trim();
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
            else toast('无法连接更新源，请检查网络或代理后重试', { danger: true, icon: 'alert' });
        }
    } catch (e) {
        if (manual) toast('检测更新失败：' + String((e && e.message) || e).slice(0, 120), { danger: true, icon: 'alert' });
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
    upd.conn = null; upd.live = null;
    refreshSummary();
    upd.modalOpen = true;
    fetch('/api/changelog').then(r => (r.ok ? r.json() : null)).then(d => { if (d && Array.isArray(d.items) && d.items.length) upd.notes = d; }).catch(() => {});
}
export function closeUpdateModal() {
    if (upd.running) { try { abortCtl && abortCtl.abort(); } catch (e) {} }
    upd.modalOpen = false;
}

/* ───────── 连通性 ───────── */
export function targets() {
    const s = upd.info.sources || {}, gh = s.github || {}, ge = s.gitee || {}, ms = s.modelscope || {};
    return [
        { name: 'ModelScope 更新列表', url: ms.tree_url || 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=static/update-notes.json', source: 'modelscope', required: true },
        { name: 'ModelScope 版本文件', url: ms.version_url || 'https://modelscope.cn/api/v1/models/bllack/NOVAI-releases/repo?Revision=master&FilePath=VERSION', source: 'modelscope', required: true },
        { name: 'ModelScope 主页', url: 'https://modelscope.cn/models/bllack/NOVAI-releases', source: 'modelscope' },
        { name: 'Gitee 更新列表', url: ge.tree_url || 'https://gitee.com/api/v5/repos/invaders/novai/git/trees/main?recursive=1', source: 'gitee', required: true },
        { name: 'Gitee 版本文件', url: ge.version_url || 'https://gitee.com/invaders/novai/raw/main/VERSION', source: 'gitee', required: true },
        { name: 'Gitee 主页', url: 'https://gitee.com/', source: 'gitee' },
        { name: 'GitHub 更新列表', url: gh.tree_url || upd.info.tree_url || 'https://api.github.com/repos/invaders-2/NOVAI-Infinite-Canvas/git/trees/main?recursive=1', source: 'github', required: true },
        { name: 'GitHub 版本文件', url: gh.version_url || upd.info.version_url || 'https://raw.githubusercontent.com/invaders-2/NOVAI-Infinite-Canvas/main/VERSION', source: 'github', required: true },
        { name: 'GitHub 主页', url: 'https://github.com/', source: 'github' },
        { name: 'Google 连通性', url: 'https://www.google.com/generate_204', source: 'reference' },
    ];
}
export function rowsFor(source) {
    const all = upd.live || (upd.conn && upd.conn.results) || targets().map(t => ({ ...t, untouched: true }));
    return all.filter(i => i.source === source || (source === 'github' && i.source === 'reference'));
}
export function statusLabel(i) {
    if (i.untouched) return '待测试';
    if (i.pending) return '检测中…';
    if (i.ok) return `正常 · ${i.elapsed_ms || 0}ms`;
    if (i.timed_out) return '失败 · 超时';
    if (i.status) return `HTTP ${i.status}`;
    return '失败';
}
function stats(source, results) {
    const items = (results || []).filter(i => i.source === source);
    const req = items.filter(i => i.required);
    return { ok: req.length ? req.every(i => i.ok) : false, done: items.filter(i => !i.pending && !i.untouched).length, total: items.length };
}
export function sourceBadge(source) {
    if (upd.live) { const s = stats(source, upd.live); if (s.done < s.total) return { state: '', text: `检测中 ${s.done}/${s.total}` }; return { state: s.ok ? 'ok' : 'bad', text: s.ok ? '可用' : '不可用' }; }
    if (!upd.conn) return { state: '', text: '待测试' };
    const s = stats(source, upd.conn.results);
    return { state: s.ok ? 'ok' : 'bad', text: s.ok ? '可用' : '不可用' };
}
function best(conn) {
    const s = conn.sources || {};
    if (s.modelscope && s.modelscope.ok) return 'modelscope';
    if (s.gitee && s.gitee.ok) return 'gitee';
    return 'github';
}
function summarize(kind, title, text) { upd.summary = { kind, title, text }; }
export function refreshSummary() {
    const name = SOURCE_LABEL[upd.source] || 'GitHub';
    const c = upd.conn;
    if (upd.running) return;
    if (!c) return summarize('warn', '建议先测试连通性', '测试会检测 ModelScope / Gitee / GitHub 的连通性，并自动选出可用的下载源。');
    if (c.backend_missing) return summarize('fail', '需要重启后端', '当前页面已经更新，但后端仍是旧版本，所以找不到连通性测试接口。请重启服务后再试。');
    const ok = (c.sources || {})[upd.source] ? c.sources[upd.source].ok : (upd.source === 'github' && c.ok);
    if (ok) {
        const google = (c.results || []).find(i => i.name === 'Google 连通性');
        const fastest = (c.results || []).filter(i => i.source === upd.source && i.ok).sort((a, b) => (a.elapsed_ms || 1e6) - (b.elapsed_ms || 1e6))[0];
        return summarize(google && google.ok ? 'ok' : 'warn', `${name} 下载源可用`, fastest ? `${name} 可访问，最快节点约 ${fastest.elapsed_ms || 0}ms，可以开始更新。` : `${name} 更新节点可用，可以开始更新。`);
    }
    summarize('fail', `${name} 下载源不可用`, `当前网络无法访问 ${name} 必需节点。请切换下载源，或检查代理、DNS 后重试。`);
}
export async function testConnectivity() {
    if (upd.testing) return;
    upd.testing = true; upd.conn = null;
    const ts = targets();
    upd.live = ts.map(t => ({ ...t, pending: true }));
    let backendMissing = false;
    summarize('warn', '正在测试连通性', '正在逐条检测各节点，结果实时显示。');
    const apply = (name, patch) => { const i = upd.live.findIndex(x => x.name === name); if (i >= 0) upd.live[i] = { ...upd.live[i], pending: false, ...patch }; };
    const probe = async t => {
        const ac = new AbortController();
        const killer = setTimeout(() => ac.abort(), 6000);
        try {
            const res = await fetch(`/api/update-connectivity/probe?name=${encodeURIComponent(t.name)}`, { cache: 'no-store', signal: ac.signal });
            const data = await res.json().catch(() => ({}));
            if (res.status === 404 && (data.detail === 'Not Found' || data.detail === undefined)) { backendMissing = true; return; }
            if (res.ok) apply(t.name, { ok: !!data.ok, status: data.status || 0, elapsed_ms: data.elapsed_ms || 0, error: data.error || '', timed_out: !!data.timed_out });
            else apply(t.name, { ok: false, error: data.detail || '失败' });
        } catch (e) {
            apply(t.name, e && e.name === 'AbortError' ? { ok: false, timed_out: true, error: '连接超时（超过 5s）' } : { ok: false, error: '无法连接' });
        } finally { clearTimeout(killer); }
    };
    try {
        await Promise.all(ts.map(probe));
        if (backendMissing) {
            try {
                const res = await fetch('/api/update-connectivity', { cache: 'no-store' });
                const data = await res.json().catch(() => ({}));
                if (res.ok && Array.isArray(data.results)) { upd.conn = data; upd.live = null; setSource(best(data)); return; }
            } catch (e) {}
            const msg = '后端还没有加载新的连通性测试接口。请重启服务后再测试。';
            upd.conn = { ok: false, backend_missing: true, results: ts.map(t => ({ ...t, ok: false, elapsed_ms: 0, error: msg })) };
            upd.live = null;
            return;
        }
        const results = upd.live.map(({ pending, untouched, ...rest }) => rest);
        const sources = {};
        for (const s of ['github', 'gitee', 'modelscope']) { const req = results.filter(i => i.source === s && i.required); sources[s] = { ok: req.length > 0 && req.every(i => i.ok) }; }
        upd.conn = { results, sources, ok: sources.github.ok };
        upd.live = null;
        setSource(best(upd.conn));
    } finally {
        upd.testing = false;
        refreshSummary();
    }
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
export function stageText(p) {
    const s = (p && p.stage) || '';
    const done = Number((p && p.files_done) || 0), total = Number((p && p.files_total) || 0);
    return ({ downloading: total > 0 ? `下载中 ${done}/${total} 个文件` : '下载中…', backup: '备份中', applying: '应用中', restarting: '重启中', done: '更新完成', error: '更新失败' })[s] || '准备更新';
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
    const name = SOURCE_LABEL[upd.source] || 'GitHub';
    upd.running = true;
    summarize('warn', '正在更新', `正在从 ${name} 下载文件，并创建本地备份。`);
    stopPoll(); upd.progress = { stage: '', percent: 0 }; poll(); pollTimer = setInterval(poll, 1000);
    abortCtl = new AbortController();
    const killer = setTimeout(() => abortCtl.abort(), 300000);
    try {
        const res = await fetch('/api/update-from-github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_restart: true, restart_delay: 3, source: upd.source, fallback: true }), signal: abortCtl.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || '更新失败');
        if (data.update_notes) upd.notes = data.update_notes;
        const fb = data.fallback_used ? `（${name} 不可用，已自动切换到 ${data.source_label || 'GitHub'}）` : '';
        summarize('ok', '更新完成', (data.restart_scheduled ? `已更新 ${data.count || 0} 个文件。后端将在约 3 秒后自动重启，本页面会在恢复后自动刷新。` : `已更新 ${data.count || 0} 个文件。请重启后端，然后刷新页面。`) + fb);
        upd.remote = ''; state.remoteVersion = '';
        if (data.version) state.version = data.version;
        if (data.restart_scheduled) waitAndReload();
    } catch (e) {
        summarize('fail', '更新失败', e && e.name === 'AbortError' ? '更新超时。请切换下载源或检查网络后重试。' : (/fetch|network/i.test(String(e && e.message)) ? '无法连接当前选择的更新源。请检查网络、代理或 DNS 后重试。' : String((e && e.message) || '更新失败')));
    } finally {
        clearTimeout(killer); abortCtl = null; stopPoll(); upd.running = false;
    }
}

/* ───────── 回滚（旧版只有函数没有按钮，这里补上入口） ───────── */
export async function listUpdateBackups() {
    const d = await fetch('/api/update-backups', { cache: 'no-store' }).then(r => r.json());
    return d.backups || [];
}
export async function rollback(name) {
    const res = await fetch('/api/update-rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, auto_restart: true, restart_delay: 3 }) });
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
}
