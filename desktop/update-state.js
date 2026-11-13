'use strict';

// 更新链路的纯逻辑（不 require electron）：状态文件读写、启动自检判定、回滚/安装判定、更新说明过滤。
// desktop/__tests__/test_update_state.js 直接 require 本文件做单测。

const fs = require('fs');
const path = require('path');

const STATE_FILE = 'update-state.json';
// 连续两次启动都没走到「界面加载完成」就认为新版起不来，可以回滚。
const BOOT_ROLLBACK_THRESHOLD = 2;
// 安装触发两次都没成功（下次启动版本仍是旧的）就放弃自动安装，避免每次退出都重试。
const INSTALL_GIVE_UP = 2;
const NOTE_TYPES = ['feature', 'fix', 'improve'];
const MEDIA_TYPES = ['image', 'gif', 'video'];
const MAX_NOTE_ITEMS = 12;
const MAX_NOTE_TEXT = 200;

function toText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function toCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function defaultState() {
    return {
        lastRunVersion: '',
        pendingVersion: '',
        backupDir: '',
        bootAttempts: 0,
        notesSeenVersion: '',
        backupVersion: '',
        installAttempts: 0,
        lastInstallError: '',
        rolledBackFrom: '',
    };
}

function sanitizeState(raw) {
    const state = defaultState();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
    state.lastRunVersion = toText(raw.lastRunVersion);
    state.pendingVersion = toText(raw.pendingVersion);
    state.backupDir = toText(raw.backupDir);
    state.bootAttempts = toCount(raw.bootAttempts);
    state.notesSeenVersion = toText(raw.notesSeenVersion);
    state.backupVersion = toText(raw.backupVersion);
    state.installAttempts = toCount(raw.installAttempts);
    state.lastInstallError = toText(raw.lastInstallError);
    state.rolledBackFrom = toText(raw.rolledBackFrom);
    return state;
}

function stateFilePath(dir) {
    return path.join(String(dir || ''), STATE_FILE);
}

function readState(dir) {
    if (!dir) return defaultState();
    try {
        const text = fs.readFileSync(stateFilePath(dir), 'utf8');
        return sanitizeState(JSON.parse(text));
    } catch (_) {
        // 状态文件损坏/不存在都当成第一次启动，绝不能因此让桌面端起不来。
        return defaultState();
    }
}

function writeState(dir, state) {
    const safe = sanitizeState(state);
    if (!dir) return safe;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const file = stateFilePath(dir);
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    } catch (_) {
        // 状态写不进去不阻塞启动/更新，下次重新推断即可。
    }
    return safe;
}

function patchState(dir, patch) {
    const next = Object.assign(readState(dir), patch || {});
    return writeState(dir, next);
}

function versionParts(value) {
    const text = toText(value).replace(/^v/i, '');
    const dash = text.indexOf('-');
    const core = dash >= 0 ? text.slice(0, dash) : text;
    return {
        nums: core.split('.').map((part) => Number(part) || 0),
        pre: dash >= 0 ? text.slice(dash + 1) : '',
    };
}

// 发布脚本里的版本号会补零（2.0.07），package.json 里是 2.0.7，按数字段比较才不会漏掉更新说明。
function versionEquals(left, right) {
    if (!toText(left) || !toText(right)) return false;
    const a = versionParts(left);
    const b = versionParts(right);
    if (a.pre !== b.pre) return false;
    const length = Math.max(a.nums.length, b.nums.length);
    for (let i = 0; i < length; i += 1) {
        if ((a.nums[i] || 0) !== (b.nums[i] || 0)) return false;
    }
    return true;
}

function isApplied(previousVersion, currentVersion) {
    const previous = toText(previousVersion);
    const current = toText(currentVersion);
    return !!previous && !!current && previous !== current;
}

// 启动时推进自检状态：upgrade 首启清 pending 并记录新版本，其余情况累加 bootAttempts。
function beginBoot(state, currentVersion) {
    const input = sanitizeState(state);
    const current = toText(currentVersion);
    const next = Object.assign({}, input);
    const previousVersion = input.lastRunVersion;
    const applied = isApplied(previousVersion, current);
    const result = {
        state: next,
        applied: applied,
        previousVersion: previousVersion,
        rollback: false,
        pendingStale: false,
        giveUp: false,
    };
    if (applied) {
        next.lastRunVersion = current;
        next.pendingVersion = '';
        next.bootAttempts = 0;
        next.installAttempts = 0;
        next.lastInstallError = '';
        next.rolledBackFrom = '';
        return result;
    }
    next.bootAttempts = input.bootAttempts + 1;
    result.pendingStale = !!next.pendingVersion && next.pendingVersion !== current;
    result.giveUp = input.installAttempts >= INSTALL_GIVE_UP;
    // 只有「当前跑的版本比备份新」才值得回滚；旧版本偶发崩溃别去动它。
    result.rollback = next.bootAttempts >= BOOT_ROLLBACK_THRESHOLD
        && !!next.backupDir
        && !!next.backupVersion
        && next.backupVersion !== current;
    return result;
}

// 已经下载好、还没装：退出时要静默安装。已经在跑这个版本 / 重试次数用完就不再装。
function shouldInstallOnQuit(state, currentVersion) {
    const safe = sanitizeState(state);
    const current = toText(currentVersion);
    if (!safe.pendingVersion) return false;
    if (safe.pendingVersion === current) return false;
    if (safe.installAttempts >= INSTALL_GIVE_UP) return false;
    return true;
}

// 打包后 build.files 里的 js 都进了 app.asar，回滚只要还原 asar + 可执行文件。
function backupPlan(options) {
    const opts = options || {};
    const items = [];
    const resourcesPath = toText(opts.resourcesPath);
    const exePath = toText(opts.exePath);
    if (resourcesPath) items.push({ name: 'app.asar', live: path.join(resourcesPath, 'app.asar') });
    if (exePath) items.push({ name: 'executable' + path.extname(exePath), live: exePath });
    return items;
}

function noteTypeOf(text) {
    const value = String(text || '');
    if (/修复|修正|解决|崩溃|闪退|\bfix|\bbug|\bcrash/i.test(value)) return 'fix';
    if (/优化|提升|性能|体验|改进|\bimprov|\bperf|\bpolish/i.test(value)) return 'improve';
    return 'feature';
}

function stripNoteLine(line) {
    return String(line || '')
        .replace(/^[\s>]*([-*+]|\d+[.)])\s+/, '')
        .replace(/^#+\s*/, '')
        .replace(/[*_`]/g, '')
        .trim();
}

function textToNoteItems(text) {
    const lines = String(text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .split(/\r?\n/);
    const items = [];
    for (let i = 0; i < lines.length && items.length < MAX_NOTE_ITEMS; i += 1) {
        const cleaned = stripNoteLine(lines[i]);
        if (!cleaned) continue;
        if (/^(what'?s changed|full changelog|更新内容|更新说明|更新日志)$/i.test(cleaned)) continue;
        items.push({ type: noteTypeOf(cleaned), text: cleaned.slice(0, MAX_NOTE_TEXT) });
    }
    return items;
}

function normalizeNoteMedia(media) {
    if (!media || typeof media !== 'object' || Array.isArray(media)) return null;
    const type = String(media.type || '');
    const src = toText(media.src);
    if (!MEDIA_TYPES.includes(type) || !src) return null;
    const result = { type: type, src: src };
    const caption = toText(media.caption);
    if (caption) result.caption = caption.slice(0, 80);
    return result;
}

// 把 electron-updater 的 releaseNotes / 本地 update-notes.json 收敛成 IPC 契约里的 notes。
function normalizeNotes(version, raw) {
    const ver = toText(version);
    if (!ver || raw == null) return null;
    const items = [];
    const seen = new Set();
    let updatedAt = '';

    const pushItem = (item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const type = NOTE_TYPES.includes(String(item.type || '')) ? String(item.type) : 'feature';
        const text = toText(item.text || item.title || item.note).slice(0, MAX_NOTE_TEXT);
        if (!text || seen.has(text)) return;
        seen.add(text);
        const entry = { type: type, text: text };
        const media = normalizeNoteMedia(item.media);
        if (media) entry.media = media;
        items.push(entry);
    };

    const pushText = (text) => {
        textToNoteItems(text).forEach(pushItem);
    };

    if (typeof raw === 'string') {
        pushText(raw);
    } else if (Array.isArray(raw)) {
        const matched = raw.filter((entry) => entry && typeof entry === 'object'
            && versionEquals(entry.version, ver)
            && (entry.note || entry.text || entry.body || Array.isArray(entry.items)));
        const source = matched.length ? matched : raw;
        for (let i = 0; i < source.length && items.length < MAX_NOTE_ITEMS; i += 1) {
            const entry = source[i];
            if (typeof entry === 'string') { pushText(entry); continue; }
            if (!entry || typeof entry !== 'object') continue;
            if (entry.version && !versionEquals(entry.version, ver)) continue;
            if (Array.isArray(entry.items)) entry.items.forEach(pushItem);
            else pushText(entry.note || entry.text || entry.body || '');
        }
    } else if (typeof raw === 'object') {
        if (Array.isArray(raw.versions)) {
            // 根 update-notes.json 的发版格式：{ versions: [{ version, date, changes }] }
            const versionEntry = raw.versions.find((entry) => entry && versionEquals(entry.version, ver));
            if (!versionEntry) return null;
            updatedAt = toText(versionEntry.date);
            const changes = Array.isArray(versionEntry.changes) ? versionEntry.changes : [];
            changes.forEach((change) => {
                if (typeof change === 'string') { pushText(change); return; }
                if (!change || typeof change !== 'object') return;
                const media = normalizeNoteMedia(change.media);
                pushItem({ type: change.type || 'feature', text: change.text || change.note || '', media: media || undefined });
            });
        } else {
            if (raw.version && !versionEquals(raw.version, ver)) return null;
            updatedAt = toText(raw.updated_at);
            if (Array.isArray(raw.items)) raw.items.forEach(pushItem);
            else pushText(raw.note || raw.text || raw.body || '');
        }
    }

    if (!items.length) return null;
    const notes = { version: ver, items: items.slice(0, MAX_NOTE_ITEMS) };
    if (updatedAt) notes.updated_at = updatedAt;
    return notes;
}

function shouldShowNotes(notes, seenVersion) {
    if (!notes || !Array.isArray(notes.items) || !notes.items.length) return false;
    return toText(seenVersion) !== toText(notes.version);
}

module.exports = {
    STATE_FILE,
    BOOT_ROLLBACK_THRESHOLD,
    INSTALL_GIVE_UP,
    NOTE_TYPES,
    defaultState,
    sanitizeState,
    stateFilePath,
    readState,
    writeState,
    patchState,
    versionEquals,
    isApplied,
    beginBoot,
    shouldInstallOnQuit,
    backupPlan,
    normalizeNotes,
    shouldShowNotes,
};
