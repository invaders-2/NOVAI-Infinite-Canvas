#!/usr/bin/env node
/* macOS 自替换更新：离线端到端测试（需要先打包 2.0.03）。
   用 Playwright 启动打好的 NOVAI.app，通过 NOVAI_UPDATE_ZIP / NOVAI_UPDATE_TARGET 钩子
   跳过真实下载，把 /tmp 里的假 .app 替换成打好的新版本，断言脚本生成、替换成功、旧版本清理。
   跑法：node tests/e2e_mac_updater.js
   （Playwright 从本机 node_modules 解析，必要时：NODE_PATH=$HOME/node_modules node tests/e2e_mac_updater.js） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'desktop', 'release');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
    try { return require('playwright'); } catch (_) {}
    const candidates = [
        path.join(os.homedir(), 'node_modules', 'playwright'),
        path.join(root, 'node_modules', 'playwright'),
        path.join(root, 'web', 'node_modules', 'playwright'),
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch (_) {}
    }
    return null;
}

function findBuiltApp() {
    const candidates = [
        path.join(releaseDir, 'mac-arm64', 'NOVAI.app'),
        path.join(releaseDir, 'mac', 'NOVAI.app'),
        path.join(releaseDir, 'mac-universal', 'NOVAI.app'),
    ];
    return candidates.find((p) => fs.existsSync(path.join(p, 'Contents', 'MacOS', 'NOVAI'))) || '';
}

function findZip() {
    if (!fs.existsSync(releaseDir)) return '';
    const zips = fs.readdirSync(releaseDir)
        .filter((name) => /^NOVAI-.*-arm64-mac\.zip$/.test(name) || /^NOVAI-.*-mac\.zip$/.test(name))
        .map((name) => ({ name, file: path.join(releaseDir, name), mtime: fs.statSync(path.join(releaseDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return zips[0] ? zips[0].file : '';
}

function writeInfoPlist(appPath, version, bundleId) {
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>' +
        '<key>CFBundleIdentifier</key><string>' + (bundleId || 'com.novai.desktop') + '</string>' +
        '<key>CFBundleShortVersionString</key><string>' + version + '</string>' +
        '</dict></plist>\n';
    fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), plist, 'utf8');
}

function plistVersion(appPath) {
    try {
        const text = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
        return m ? m[1] : '';
    } catch (_) {
        return '';
    }
}

function makeStubBin(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'stub.log');
    ['open', 'codesign'].forEach((name) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, '#!/bin/sh\nprintf "[stub] ' + name + ' %s\\n" "$*" >> "' + log + '"\nexit 0\n', 'utf8');
        fs.chmodSync(file, 0o755);
    });
    return dir;
}

function readTail(file, lines) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.split('\n').slice(-lines).join('\n');
    } catch (_) {
        return '';
    }
}

(async () => {
    const playwright = loadPlaywright();
    if (!playwright || !playwright._electron) {
        console.error('找不到 playwright，请先安装或设置 NODE_PATH 指向本机 node_modules');
        process.exit(2);
    }
    const builtApp = findBuiltApp();
    const zipPath = findZip();
    if (!builtApp) {
        console.error('没有找到打好的 app，请先执行：cd desktop && node scripts/sync-version.js && ./node_modules/.bin/electron-builder --mac zip');
        process.exit(2);
    }
    if (!zipPath) {
        console.error('没有找到 mac zip 安装包，请先打包');
        process.exit(2);
    }
    console.log('[e2e] app     = ' + builtApp);
    console.log('[e2e] zip     = ' + zipPath);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novai-e2e-update-'));
    const userDataDir = path.join(workDir, 'userdata');
    const targetApp = path.join(workDir, 'target', 'NOVAI.app');
    const stubBin = makeStubBin(path.join(workDir, 'bin'));
    fs.mkdirSync(userDataDir, { recursive: true });
    writeInfoPlist(targetApp, '2.0.2');
    fs.writeFileSync(path.join(targetApp, 'Contents', 'E2E-OLD-MARKER'), 'old', 'utf8');

    const env = Object.assign({}, process.env, {
        NOVAI_UPDATE_ZIP: zipPath,
        NOVAI_UPDATE_TARGET: targetApp,
        NOVAI_UPDATE_WAIT: '2',
        PATH: stubBin + ':' + process.env.PATH,
    });
    delete env.ELECTRON_RUN_AS_NODE;

    let electronApp = null;
    try {
        console.log('[e2e] 启动打好的包（隔离 user-data-dir）…');
        electronApp = await playwright._electron.launch({
            executablePath: path.join(builtApp, 'Contents', 'MacOS', 'NOVAI'),
            args: ['--user-data-dir=' + userDataDir, '--disable-gpu', '--no-sandbox'],
            env: env,
            timeout: 120000,
        });
        const page = await electronApp.firstWindow({ timeout: 120000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        const hasBridge = await page.evaluate(() => !!(window.novaiUpdater && typeof window.novaiUpdater.downloadAndInstall === 'function'));
        ok(hasBridge, '渲染层拿到 window.novaiUpdater');

        if (hasBridge) {
            console.log('[e2e] 调用 window.novaiUpdater.downloadAndInstall()（不等待返回值，主进程会自行退出）…');
            await page.evaluate(() => { window.novaiUpdater.downloadAndInstall(); return true; });
            const closed = await Promise.race([
                electronApp.waitForEvent('close').then(() => true).catch(() => true),
                sleep(45000).then(() => false),
            ]);
            ok(closed, '更新流程结束后应用自行退出（app.quit）');
        }

        const updatesDir = path.join(userDataDir, 'updates');
        const scriptPath = path.join(updatesDir, 'install.sh');
        const logPath = path.join(updatesDir, 'install.log');
        // 等安装脚本真正跑完（install.log 出现 install done），再断言替换结果（最多 180s）
        const deadline = Date.now() + 180000;
        let done = false;
        while (Date.now() < deadline) {
            if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').indexOf('install done') >= 0) { done = true; break; }
            await sleep(1000);
        }
        ok(done, '安装脚本执行完成（install.log: install done）');
        const hasExecutable = fs.existsSync(path.join(targetApp, 'Contents', 'MacOS', 'NOVAI'));
        const hasOldMarker = fs.existsSync(path.join(targetApp, 'Contents', 'E2E-OLD-MARKER'));
        ok(hasExecutable && !hasOldMarker, '目标 .app 已被替换成新版本（旧标记消失）');
        const zipVersion = path.basename(zipPath).replace(/^NOVAI-/, '').replace(/-arm64-mac\.zip$/, '').replace(/-mac\.zip$/, '');
        ok(plistVersion(targetApp) === zipVersion, '替换后的版本号来自新包: v' + (plistVersion(targetApp) || '?') + '（期望 v' + zipVersion + '）');
        ok(fs.existsSync(scriptPath), '生成 install.sh: ' + scriptPath);
        const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
        ok(/ditto "\$NEW_APP" "\$TARGET"/.test(script), 'install.sh 里是 ditto 替换');
        ok(/codesign --force --deep --sign -/.test(script), 'install.sh 里做 ad-hoc 重签');
        const logText = readTail(logPath, 20);
        ok(/install done/.test(logText), 'install.log 记录安装完成');
        const leftovers = fs.readdirSync(path.join(workDir, 'target')).filter((name) => name.indexOf('NOVAI.app.old-') === 0);
        ok(leftovers.length === 0, '旧版本备份目录已清理');
        const scripts = fs.existsSync(updatesDir) ? fs.readdirSync(updatesDir) : [];
        ok(scripts.indexOf('install.sh') >= 0, 'updates 目录里有安装脚本');

        console.log('[e2e] install.log 末尾：\n' + logText);
        console.log('[e2e] stub.log：' + readTail(path.join(stubBin, 'stub.log'), 5));
    } catch (err) {
        console.error('[e2e] 异常：', err && err.stack || err);
        fails.push('E2E 执行异常: ' + String(err && err.message || err));
    } finally {
        try { if (electronApp) await electronApp.close(); } catch (_) {}
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }

    console.log('');
    if (fails.length) {
        console.error('E2E 失败 ' + fails.length + ' 项：');
        fails.forEach((f) => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('E2E 全部通过（' + pass + ' 项）');
    process.exit(0);
})().catch((err) => {
    console.error('[e2e] 未捕获异常：', err && err.stack || err);
    process.exit(1);
});
