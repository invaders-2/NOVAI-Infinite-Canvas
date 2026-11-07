// macOS 自替换更新器（纯 Node，不 require electron）。
// 主进程用这里解析 latest-mac.yml、校验 sha512、生成安装脚本并检查 .app；
// tests/test_desktop_mac_updater.js 也直接 require 本文件做纯 node 测试。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// 发布产物固定在这个仓库的 Release 下；相对路径的 zip 用它补全。
const RELEASE_DOWNLOAD_BASE = 'https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases/download/';
const EXPECTED_BUNDLE_ID = 'com.novai.desktop';

function unquote(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text.length >= 2 && ((text[0] === "'" && text[text.length - 1] === "'") || (text[0] === '"' && text[text.length - 1] === '"'))) {
        return text.slice(1, -1);
    }
    return text;
}

// 只解析 electron-builder 生成的 latest-mac.yml 需要的那几个字段，
// 不引入 yaml 依赖（桌面包里不装 devDependencies）。
function parseLatestMacYml(text) {
    const out = { version: '', path: '', sha512: '', files: [] };
    let inFiles = false;
    let current = null;
    String(text || '').split(/\r?\n/).forEach((rawLine) => {
        if (!rawLine.trim() || /^\s*#/.test(rawLine)) return;
        const indent = (rawLine.match(/^\s*/) || [''])[0].length;
        const line = rawLine.trim();
        if (indent === 0) {
            inFiles = false;
            current = null;
            const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
            if (!top) return;
            if (top[1] === 'files') { inFiles = true; return; }
            if (top[1] === 'version' || top[1] === 'path' || top[1] === 'sha512') out[top[1]] = unquote(top[2]);
            return;
        }
        if (!inFiles) return;
        const item = /^-\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (item) {
            current = {};
            out.files.push(current);
            current[item[1]] = unquote(item[2]);
            return;
        }
        const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (field && current) current[field[1]] = unquote(field[2]);
    });
    return out;
}

// 优先取 arm64 的 zip（Apple Silicon 包），没有就退回第一个 zip。
function pickMacZipFile(files) {
    const list = Array.isArray(files) ? files : [];
    const usable = list.filter((item) => item && /\.zip$/i.test(String(item.url || '')));
    const arm64 = usable.filter((item) => /(^|[.-])arm64([.-]|$)/i.test(String(item.url || '')));
    return arm64[0] || usable[0] || null;
}

// GitHub Release 的 tag 是展示版本（v2.0.03，和 VERSION 一致），
// 而 latest-mac.yml 里的 version 是 electron-builder 归一化后的 2.0.3，两者不能混用。
function normalizeReleaseTag(tag) {
    const raw = String(tag || '').trim();
    if (!raw || !/^v?\d/.test(raw)) return '';
    return /^v/i.test(raw) ? raw : 'v' + raw;
}

// 兜底 tag：把展示版本按仓库历史格式补零（2.0.3 → v2.0.03；1.0.143 不变）。
function releaseTagFromVersion(version) {
    const clean = String(version || '').trim().replace(/^v/i, '');
    if (!clean) return '';
    const dashAt = clean.indexOf('-');
    const core = dashAt >= 0 ? clean.slice(0, dashAt) : clean;
    const suffix = dashAt >= 0 ? clean.slice(dashAt) : '';
    const parts = core.split('.');
    if (!parts.length || !parts.every((part) => /^\d+$/.test(part))) return '';
    return 'v' + parts.map((part, index) => (index === parts.length - 1 ? part.padStart(2, '0') : part)).join('.') + suffix;
}

// tag 优先（electron-updater 的 updateInfo.tag 是真实 Release tag）；
// tag 缺失时才回退用 version 拼，保持旧行为。
function resolveMacZipUrl(fileUrl, version, tag) {
    const raw = String(fileUrl || '').trim();
    if (!raw) throw new Error('安装包地址为空');
    if (/^https:\/\//i.test(raw)) return raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error('只接受 https 安装包地址: ' + raw.slice(0, 120));
    const name = raw.split('/').filter(Boolean).pop() || '';
    if (!name || !/\.zip$/i.test(name)) throw new Error('安装包文件名无效: ' + raw.slice(0, 120));
    const releaseTag = normalizeReleaseTag(tag);
    if (releaseTag) return RELEASE_DOWNLOAD_BASE + releaseTag + '/' + name;
    const ver = String(version || '').trim();
    if (!ver) throw new Error('缺少目标版本号，无法拼出下载地址');
    return RELEASE_DOWNLOAD_BASE + 'v' + ver + '/' + name;
}

function sha512Base64OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('base64')));
    });
}

async function verifySha512(filePath, expectedBase64) {
    const expected = String(expectedBase64 || '').trim();
    if (!expected) return false;
    try {
        const actual = await sha512Base64OfFile(filePath);
        return actual === expected;
    } catch (_) {
        return false;
    }
}

// 从 .../NOVAI.app/Contents/MacOS/NOVAI 反推 .../NOVAI.app；不是 .app 内运行就返回空串。
function appBundleFromExe(exePath) {
    const value = String(exePath || '');
    const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/i.exec(value);
    return match ? match[1] : '';
}

// Electron 打包的 Info.plist 一般是 XML；遇到二进制 plist 用 plutil 转一次。
function readInfoPlistText(plistPath) {
    const buffer = fs.readFileSync(plistPath);
    if (buffer.length >= 6 && buffer.slice(0, 6).toString('latin1') === 'bplist') {
        return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', plistPath], { encoding: 'utf8' });
    }
    return buffer.toString('utf8');
}

function plistValue(text, key) {
    const pattern = new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>');
    const match = pattern.exec(String(text || ''));
    return match ? match[1] : '';
}

function readInfoPlistValues(appPath) {
    const plistPath = path.join(String(appPath || ''), 'Contents', 'Info.plist');
    if (!fs.existsSync(plistPath)) return { ok: false, reason: 'missing-info-plist', bundleId: '', version: '' };
    try {
        const text = readInfoPlistText(plistPath);
        return { ok: true, reason: '', bundleId: plistValue(text, 'CFBundleIdentifier'), version: plistValue(text, 'CFBundleShortVersionString') };
    } catch (err) {
        return { ok: false, reason: 'info-plist-unreadable: ' + String(err && err.message || err), bundleId: '', version: '' };
    }
}

function validateAppBundle(appPath, expectedVersion) {
    const info = readInfoPlistValues(appPath);
    if (!info.ok) return info;
    if (info.bundleId !== EXPECTED_BUNDLE_ID) {
        return { ok: false, reason: 'unexpected-bundle-id: ' + info.bundleId, bundleId: info.bundleId, version: info.version };
    }
    const expected = String(expectedVersion || '').trim().replace(/^v/i, '');
    if (expected && info.version !== expected) {
        return { ok: false, reason: 'unexpected-version: ' + info.version + ' (want ' + expected + ')', bundleId: info.bundleId, version: info.version };
    }
    return { ok: true, reason: '', bundleId: info.bundleId, version: info.version };
}

function findAppBundleInDir(dir) {
    try {
        const hit = fs.readdirSync(String(dir || '')).find((name) => /\.app$/i.test(name));
        return hit ? path.join(dir, hit) : '';
    } catch (_) {
        return '';
    }
}

// 版本号兜底：NOVAI-2.0.3-arm64-mac.zip → 2.0.3（测试钩子只给 zip 时用）。
function versionFromZipName(zipPath) {
    const name = path.basename(String(zipPath || ''));
    if (!/^NOVAI-.*-mac\.zip$/i.test(name)) return '';
    const core = name.replace(/^NOVAI-/i, '').replace(/-mac\.zip$/i, '').replace(/-(?:arm64|x64|universal)$/i, '');
    return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(core) ? core : '';
}

function shellQuote(value) {
    return "'" + String(value === undefined || value === null ? '' : value).replace(/'/g, "'\\''") + "'";
}

function buildInstallScript(opts) {
    const options = opts || {};
    const pid = Number(options.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('安装脚本需要有效的进程 pid: ' + options.pid);
    const targetApp = String(options.targetApp || '');
    const newApp = String(options.newApp || '');
    const tmpDir = String(options.tmpDir || '');
    const logPath = String(options.logPath || '');
    if (!path.isAbsolute(targetApp) || !/\.app\/?$/i.test(targetApp)) throw new Error('目标不是 .app 路径: ' + targetApp);
    if (!path.isAbsolute(newApp) || !/\.app\/?$/i.test(newApp)) throw new Error('新版本不是 .app 路径: ' + newApp);
    if (!path.isAbsolute(logPath)) throw new Error('日志路径必须是绝对路径: ' + logPath);
    const waitSeconds = Math.max(1, Math.floor(Number(options.waitSeconds) || 120));
    const waitAttempts = waitSeconds * 2;
    const scriptLines = [
        '#!/bin/sh',
        '# NOVAI macOS 自替换安装脚本（由主进程生成，请勿手动执行）',
        'set -u',
        'PID=' + pid,
        'WAIT_ATTEMPTS=' + waitAttempts,
        'TARGET=' + shellQuote(targetApp),
        'NEW_APP=' + shellQuote(newApp),
        'TMP_DIR=' + shellQuote(tmpDir),
        'LOG=' + shellQuote(logPath),
        'BACKUP="$TARGET.old-$PID"',
        '',
        'log() { printf \'[%s] %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$*" >> "$LOG" 2>/dev/null || true; }',
        'log "install start: pid=$PID target=$TARGET"',
        '',
        '# 1) 等当前 NOVAI 进程退出（每 0.5s 探一次，最多 WAIT_ATTEMPTS 次）',
        'i=0',
        'while kill -0 "$PID" 2>/dev/null; do',
        '    i=$((i + 1))',
        '    if [ "$i" -ge "$WAIT_ATTEMPTS" ]; then',
        '        log "等待进程退出超时（$((WAIT_ATTEMPTS / 2))s），继续安装"',
        '        break',
        '    fi',
        '    sleep 0.5',
        'done',
        '',
        'if [ ! -d "$TARGET" ]; then',
        '    log "目标不存在，放弃：$TARGET"',
        '    exit 1',
        'fi',
        '',
        '# 2) 备份旧版本',
        'if ! mv "$TARGET" "$BACKUP"; then',
        '    log "备份旧版本失败，放弃"',
        '    exit 1',
        'fi',
        'log "旧版本已备份：$BACKUP"',
        '',
        '# 3) 复制新版本；任何一步失败都回滚',
        'if ! ditto "$NEW_APP" "$TARGET"; then',
        '    log "ditto 复制失败，开始回滚"',
        '    rm -rf "$TARGET"',
        '    mv "$BACKUP" "$TARGET"',
        '    log "回滚完成"',
        '    exit 1',
        'fi',
        '',
        'if [ ! -f "$TARGET/Contents/Info.plist" ]; then',
        '    log "新版本缺少 Contents/Info.plist，开始回滚"',
        '    rm -rf "$TARGET"',
        '    mv "$BACKUP" "$TARGET"',
        '    log "回滚完成"',
        '    exit 1',
        'fi',
        '',
        '# 4) 清 quarantine + ad-hoc 重签（失败只记录，不阻断）',
        'xattr -dr com.apple.quarantine "$TARGET" >>"$LOG" 2>&1 || log "清除 quarantine 失败（忽略）"',
        'codesign --force --deep --sign - "$TARGET" >>"$LOG" 2>&1 || log "ad-hoc 签名失败（忽略）"',
        '',
        '# 5) 重新打开新版本',
        'open "$TARGET" >>"$LOG" 2>&1 || log "重新打开失败（忽略）"',
        '',
        '# 6) 清理备份与解压目录',
        'rm -rf "$BACKUP" 2>/dev/null || log "清理备份失败（忽略）：$BACKUP"',
        'rm -rf "$TMP_DIR" 2>/dev/null || log "清理解压目录失败（忽略）：$TMP_DIR"',
        'log "install done"',
        'exit 0',
        '',
    ];
    return scriptLines.join('\n');
}

module.exports = {
    RELEASE_DOWNLOAD_BASE,
    EXPECTED_BUNDLE_ID,
    parseLatestMacYml,
    pickMacZipFile,
    normalizeReleaseTag,
    releaseTagFromVersion,
    resolveMacZipUrl,
    sha512Base64OfFile,
    verifySha512,
    appBundleFromExe,
    readInfoPlistValues,
    validateAppBundle,
    findAppBundleInDir,
    versionFromZipName,
    buildInstallScript,
};
