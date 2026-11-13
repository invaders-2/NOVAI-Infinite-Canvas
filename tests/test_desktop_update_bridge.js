#!/usr/bin/env node
/* Electron 桌面版「一键更新」回归：
   E1. preload 暴露 window.novaiUpdater（checkNow / downloadAndInstall → IPC）；
   E2. main.js 注册 novai:update-check / novai:update-install，复用 electron-updater，
       已 downloaded 时只弹「立即重启」、不重复下载，安装前先 stopBackendForUpdate；
   E3. iframe shim 也带上更新桥（旧页面被 iframe 承载时同样转交桌面更新）；
   E4. web/src/lib/update.js：Electron 环境下 startUpdate 不发 /api/update-from-github、
       不写 novai.updatedTo、只 toast 转交；浏览器版保持原逻辑；回滚在桌面版不自重启后端；
   E5. 旧外壳 static/index.html 的两处自重启入口在桌面版改走桌面更新；
   E6. static/v2 构建产物里带上桌面分支。
   跑法：node tests/test_desktop_update_bridge.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const updateStore = require('../desktop/update-state');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

function topLevelFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if (start < 0) return '';
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

function sliceBetween(src, startText, endText) {
    const start = src.indexOf(startText);
    if (start < 0) return '';
    const end = endText ? src.indexOf(endText, start) : -1;
    return end > start ? src.slice(start, end) : src.slice(start);
}

/* 抽出 preload 的更新块，用假 ipcRenderer/contextBridge 真跑订阅逻辑（不启动 Electron）。 */
function loadPreloadUpdater(preloadSrc) {
    const start = preloadSrc.indexOf('const updateStageListeners');
    const end = preloadSrc.indexOf('// 低层桥', start);
    const block = preloadSrc.slice(start, end > start ? end : undefined);
    const handlers = {};
    const exposed = {};
    const invokes = [];
    const sandbox = {
        ipcRenderer: {
            on: (channel, fn) => { handlers[channel] = fn; },
            invoke: (channel, payload) => { invokes.push({ channel, payload }); return Promise.resolve({ ok: true }); },
        },
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        console: { log() {}, warn() {}, error() {} },
    };
    vm.runInNewContext(block, sandbox, { filename: 'desktop/preload-updater.js' });
    return { updater: exposed.novaiUpdater, handlers, invokes };
}

/* 抽出 registerUpdaterIpc 真跑四个新 IPC；saveUpdateState 落到真实 update-state.json。 */
function loadUpdaterIpc(mainSrc, options) {
    const opts = options || {};
    const handlers = {};
    const calls = { save: [], stages: [], download: 0, downloadedStage: 0 };
    let updatePersist = updateStore.defaultState();
    let stateDir = '';
    const sandbox = {
        ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
        app: { isPackaged: opts.appIsPackaged !== false, getVersion: () => '2.0.6' },
        process: { platform: opts.platform || 'win32' },
        MAC_UPDATE_ZIP_OVERRIDE: '',
        autoUpdater: opts.autoUpdater || {},
        updaterSupported: () => true,
        pendingUpdateInfo: opts.pendingUpdateInfo === undefined ? { version: '2.0.7' } : opts.pendingUpdateInfo,
        updateStage: opts.updateStage || 'downloaded',
        stageVersion: '2.0.7',
        pendingNotes: null,
        macPreparedUpdate: opts.macPreparedUpdate || null,
        pendingReinstallWanted: true,
        updatePersist: updatePersist,
        saveUpdateState: (patch) => {
            calls.save.push(patch);
            updatePersist = updateStore.writeState(stateDir, Object.assign({}, updatePersist, patch));
            sandbox.updatePersist = updatePersist;
            return updatePersist;
        },
        sendUpdateStage: (payload) => { calls.stages.push(payload); },
        sendDownloadedStageOnce: () => { calls.downloadedStage += 1; },
        startUpdateDownload: (info) => { calls.download += 1; calls.lastDownloadInfo = info; },
        startManualUpdateCheck: () => ({ ok: true, supported: true, phase: 'check', stage: 'checking' }),
        startMacSelfUpdate: async () => ({ ok: true, supported: true, phase: 'download' }),
        applyUpdateNow: async () => ({ ok: true, supported: true, phase: 'install', stage: 'installing' }),
    };
    if (opts.stateDir) stateDir = opts.stateDir;
    const fn = vm.runInNewContext(topLevelFunction(mainSrc, 'registerUpdaterIpc') + '\nregisterUpdaterIpc', sandbox);
    fn();
    return { handlers, calls, sandbox, readState: () => updateStore.readState(stateDir) };
}

/* 退出时收敛只跑一次：第二次调用不能再触发安装。 */
function loadConverge(mainSrc, options) {
    const opts = options || {};
    const calls = { save: [], stages: [], install: 0 };
    const sandbox = {
        app: { isPackaged: true, getVersion: () => opts.currentVersion || '2.0.6' },
        process: { platform: opts.platform || 'win32' },
        updatePersist: updateStore.sanitizeState(opts.state || { pendingVersion: '2.0.7' }),
        updateStage: opts.updateStage || 'downloaded',
        macPreparedUpdate: opts.macPreparedUpdate || null,
        quitInstallTriggered: false,
        updateState: updateStore,
        stopDownloadProgressTicker: () => {},
        saveUpdateState: (patch) => {
            calls.save.push(patch);
            sandbox.updatePersist = Object.assign({}, sandbox.updatePersist, patch);
        },
        sendUpdateStage: (payload) => { calls.stages.push(payload); },
        installMacPreparedUpdate: async () => { calls.install += 1; return { ok: true }; },
        clog: () => {},
    };
    const fn = vm.runInNewContext(topLevelFunction(mainSrc, 'convergeUpdateOnQuit') + '\nconvergeUpdateOnQuit', sandbox);
    fn();
    fn();
    return { calls, sandbox };
}

/* 启动自检通过：bootAttempts 清零且只写一次。 */
function loadMarkBootSuccess(mainSrc) {
    const calls = [];
    const sandbox = {
        app: { isPackaged: true, getVersion: () => '2.0.7' },
        bootSettled: false,
        pendingReinstallWanted: false,
        saveUpdateState: (patch) => { calls.push(patch); },
        clog: () => {},
    };
    const fn = vm.runInNewContext(topLevelFunction(mainSrc, 'markBootSuccess') + '\nmarkBootSuccess', sandbox);
    fn();
    fn();
    return { calls, sandbox };
}

/* ── 把 ESM 版 update.js 剥成脚本，在 vm 里跑真实 startUpdate / rollback ── */
class FakeAbortController {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
}

function loadUpdateModule(novaiUpdater, responseFor) {
    let src = read('web/src/lib/update.js');
    src = src.replace(/^import .*$/gm, '');
    src = src.replace(/^export /gm, '');
    const calls = [];
    const toasts = [];
    const store = new Map();
    const timers = new Map();
    let timerSeq = 0;
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        reactive: v => v,
        state: {},
        toast: (text, opts) => { toasts.push({ text, opts }); return toasts.length; },
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: k => { store.delete(k); },
        },
        fetch: (url, opts) => { calls.push({ url, opts }); return responseFor(url, opts); },
        setTimeout: (fn, ms) => { timerSeq += 1; timers.set(timerSeq, { fn, ms }); return timerSeq; },
        clearTimeout: (id) => { timers.delete(id); },
        setInterval: () => 0,
        clearInterval: () => {},
        AbortController: FakeAbortController,
        window: { novaiUpdater },
    };
    const ctx = vm.createContext(sandbox);
    const exported = vm.runInContext(
        src + '\n;({ upd, startUpdate, rollback, compareVersions, closeUpdateModal, openUpdateModal, stopDesktopUpdateProgress })',
        ctx,
        { filename: 'web/src/lib/update.js' }
    );
    return { ...exported, calls, toasts, store, timers };
}

const okResponse = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const noResponse = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });

(async () => {
    console.log('[1] preload 暴露 window.novaiUpdater');
    const preload = read('desktop/preload.js');
    ok(/exposeInMainWorld\('novaiUpdater'/.test(preload), 'preload 暴露 novaiUpdater');
    ok(/checkNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('novai:update-check'\)/.test(preload), 'checkNow → novai:update-check');
    ok(/downloadAndInstall:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('novai:update-install'\)/.test(preload), 'downloadAndInstall → novai:update-install');

    const preloadStage = loadPreloadUpdater(preload);
    ok(!!preloadStage.updater && typeof preloadStage.updater.onStage === 'function', 'preload 暴露 onStage');
    // 页面的 onStage 在 DOM 之后才订阅，applied 可能先到：必须缓存并补发一次
    preloadStage.handlers['novai:update-stage'](null, { stage: 'applied', version: '2.0.7', previousVersion: '2.0.6' });
    const replayed = [];
    const off = preloadStage.updater.onStage((payload) => replayed.push(payload));
    ok(replayed.length === 1 && replayed[0].stage === 'applied' && replayed[0].version === '2.0.7', 'onStage 首次订阅补发未消费的 applied');
    ok(typeof off === 'function', 'onStage 返回 off() 取消订阅函数');
    const secondListener = [];
    preloadStage.updater.onStage((payload) => secondListener.push(payload));
    ok(secondListener.length === 0, '同一次 applied 只补发一次，不重复弹更新说明');
    off();
    preloadStage.handlers['novai:update-stage'](null, { stage: 'downloaded', version: '2.0.7' });
    ok(replayed.length === 1, 'off() 之后不再接收更新事件');

    await preloadStage.updater.restartNow();
    await preloadStage.updater.installOnQuit();
    await preloadStage.updater.markNotesSeen('2.0.7');
    await preloadStage.updater.retryInstall();
    ok(preloadStage.invokes.map((item) => item.channel).join(',') === 'novai:update-restart,novai:update-later,novai:update-notes-seen,novai:update-retry', '四个新 invoke 通道名与契约一致');
    ok(preloadStage.invokes[2].payload && preloadStage.invokes[2].payload.version === '2.0.7', 'markNotesSeen 带 version 参数');

    console.log('[2] main.js 的 electron-updater 复用逻辑');
    const main = read('desktop/main.js');
    const registerIpc = topLevelFunction(main, 'registerIpc');
    ok(/registerUpdaterIpc\(\)/.test(registerIpc), 'registerIpc 里注册更新 IPC');
    ok(/ipcMain\.handle\('novai:update-check'/.test(main), '注册 novai:update-check');
    ok(/ipcMain\.handle\('novai:update-install'/.test(main), '注册 novai:update-install');

    const installHandler = (main.match(/ipcMain\.handle\('novai:update-install'[\s\S]*?\n  \}\);/g) || [''])[0];
    ok(!!installHandler, '能取到 update-install 处理器');
    const downloadedBranch = (installHandler.match(/if \(updateStage === 'downloaded'\)[^\n]*/) || [''])[0];
    ok(/applyUpdateNow\(\)/.test(downloadedBranch), '已 downloaded 时直接走安装（不再弹原生确认框）');
    ok(!/downloadUpdate\(/.test(downloadedBranch), '已 downloaded 时不再调用 downloadUpdate');

    const applyFn = topLevelFunction(main, 'applyUpdateNow');
    ok(/await stopBackendForUpdate\(\)/.test(applyFn), '安装前先停后端');
    ok(applyFn.indexOf('stopBackendForUpdate') < applyFn.indexOf('quitAndInstall'), '先 stopBackendForUpdate 再 quitAndInstall');
    ok(/if \(process\.platform === 'win32'\) autoUpdater\.quitAndInstall\(true, true\);/.test(applyFn), 'Windows 静默安装参数仍是 quitAndInstall(true, true)');
    ok(/else autoUpdater\.quitAndInstall\(\);/.test(applyFn), '其它平台保持 quitAndInstall()');
    ok(/stopDownloadProgressTicker\(\)/.test(applyFn) && /stage: 'installing'/.test(applyFn), '真正安装前先发 installing，再静默退出');

    const setupFn = topLevelFunction(main, 'setupAutoUpdate');
    const availableBlock = sliceBetween(setupFn, "autoUpdater.on('update-available'", "autoUpdater.on('download-progress'");
    ok(!!availableBlock, '取到 update-available 处理块');
    ok(!/dialog\.showMessageBox|showUpdateAvailablePrompt|showMacUpdateAvailablePrompt/.test(availableBlock), 'update-available 不再弹任何原生窗口（旧行为）');
    ok(/startUpdateDownload\(info\)/.test(availableBlock), 'update-available 直接后台静默下载');
    const downloadedBlock = sliceBetween(setupFn, "autoUpdater.on('update-downloaded'", "autoUpdater.on('error'");
    ok(!!downloadedBlock, '取到 update-downloaded 处理块');
    ok(!/showUpdateInstallPrompt|dialog\.showMessageBox/.test(downloadedBlock), 'update-downloaded 不再弹安装确认框（旧行为）');
    ok(/onUpdatePackageReady\(version, info\)/.test(downloadedBlock), 'update-downloaded 转交 onUpdatePackageReady 发 downloaded 事件');
    const readyFn = topLevelFunction(main, 'onUpdatePackageReady');
    ok(/stage: 'downloaded', version: ver/.test(readyFn), 'downloaded 事件带 version');
    ok(/payload\.notes = pendingNotes/.test(readyFn), 'downloaded 事件带 notes（拿得到才给）');
    ok(/setTimeout\(\(\) => \{ createUpdateBackup\(ver\)/.test(readyFn), '下载完成后空闲时段备份旧版');
    ok(/manualUpdateCheck/.test(main), '手动检查才有「已是最新版本」提示（启动自动检查保持安静）');
    ok(/startDownloadProgressTicker\(stageVersion\)/.test(main) && /setInterval\(emitDownloadProgressStage, 400\)/.test(main), '下载进度按 400ms 固定节拍推送（≤500ms）');

    const configFn = topLevelFunction(main, 'ensureAppUpdateConfig');
    ok(!!configFn, '启动更新器前有 app-update.yml 缺失兜底');
    ok(/ensureAppUpdateConfig\(\);[\s\S]*require\('electron-updater'\)/.test(topLevelFunction(main, 'setupAutoUpdate')), '先补配置再加载 electron-updater');
    const configDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'novai-updater-config-'));
    vm.runInNewContext(configFn + '\nensureAppUpdateConfig();', {
        app: { isPackaged: true }, process: { resourcesPath: configDir }, path, fs, clog() {},
    });
    const configPath = path.join(configDir, 'app-update.yml');
    const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    ok(configText.includes('provider: github') && configText.includes('owner: invaders-2') && configText.includes('repo: NOVAI-Infinite-Canvas'), '运行时能生成正确的 GitHub 更新配置');
    fs.rmSync(configDir, { recursive: true, force: true });
    const pkg = JSON.parse(read('desktop/package.json'));
    ok(pkg.build.extraResources.some(item => item.from === 'resources/app-update.yml' && item.to === 'app-update.yml'), '安装包把 app-update.yml 放到 Resources 根目录');
    const packagedConfig = read('desktop/resources/app-update.yml');
    ok(packagedConfig.includes('provider: github') && packagedConfig.includes('repo: NOVAI-Infinite-Canvas'), '默认更新配置已入仓');

    console.log('[3] iframe shim 也暴露 novaiUpdater');
    ok(/window\.novaiUpdater = \{/.test(main), 'shim 里挂 novaiUpdater');
    ok(/call\('update-check'\)/.test(main) && /call\('update-install'\)/.test(main), 'shim 走 postMessage 转发到同一 IPC');

    console.log('[4] update.js：桌面版不调后端自更新');
    const desktopCalls = [];
    const desktopMod = loadUpdateModule({
        checkNow: () => { desktopCalls.push('checkNow'); return Promise.resolve({ ok: true }); },
        downloadAndInstall: () => { desktopCalls.push('downloadAndInstall'); return Promise.resolve({ ok: true, supported: true, stage: 'checking' }); },
    }, () => { throw new Error('桌面模式下不应发任何 fetch'); });
    await desktopMod.startUpdate();
    ok(desktopCalls.length === 1 && desktopCalls[0] === 'downloadAndInstall', '桌面版只调用 downloadAndInstall');
    ok(desktopMod.calls.length === 0, '桌面版 startUpdate 不发 fetch（含 /api/update-from-github 与进度轮询）');
    ok(!desktopMod.store.has('novai.updatedTo'), '桌面版不写 novai.updatedTo 标记');
    ok(desktopMod.upd.running === false && desktopMod.upd.phase === 'idle', '桌面版不进入 running/轮询状态');
    ok(desktopMod.toasts.length === 1 && desktopMod.toasts[0].text.includes('已转交桌面版更新'), 'toast 提示已转交桌面版更新');

    const unsupportedMod = loadUpdateModule({
        downloadAndInstall: () => Promise.resolve({ ok: false, supported: false, reason: 'unavailable' }),
    }, () => { throw new Error('桌面模式下不应发任何 fetch'); });
    await unsupportedMod.startUpdate();
    ok(unsupportedMod.calls.length === 0, '桌面版不支持时也不回落到后端自更新');
    ok(unsupportedMod.toasts.length === 1 && unsupportedMod.toasts[0].text.includes('不支持在线更新') && typeof unsupportedMod.toasts[0].opts.onClick === 'function', '桌面版不支持时提示可点下载新版本');

    console.log('[5] update.js：浏览器版保持原逻辑');
    const browserMod = loadUpdateModule(null, (url) => (url === '/api/update-from-github'
        ? okResponse({ version: '1.0.136', restart_scheduled: false })
        : noResponse()));
    await browserMod.startUpdate();
    const backendCall = browserMod.calls.find(c => c.url === '/api/update-from-github');
    ok(!!backendCall, '浏览器版仍调用 /api/update-from-github');
    ok(!!backendCall && backendCall.opts.method === 'POST' && JSON.parse(backendCall.opts.body).auto_restart === true, '浏览器版仍带 auto_restart: true');
    ok(browserMod.store.get('novai.updatedTo') === '1.0.136', '浏览器版仍写「已更新」标记');
    ok(browserMod.upd.phase === 'done', '浏览器版更新完成状态正常');

    console.log('[6] update.js：桌面版回滚不让后端自重启');
    const desktopRollback = loadUpdateModule({ downloadAndInstall: () => Promise.resolve({}) }, () => okResponse({ count: 2, restart_scheduled: false }));
    const dr = await desktopRollback.rollback('20260101-000000');
    const drBody = JSON.parse(desktopRollback.calls[0].opts.body);
    ok(dr.count === 2 && drBody.auto_restart === false, '桌面版回滚 auto_restart: false');
    const browserRollback = loadUpdateModule(null, () => okResponse({ count: 2, restart_scheduled: false }));
    await browserRollback.rollback('20260101-000000');
    ok(JSON.parse(browserRollback.calls[0].opts.body).auto_restart === true, '浏览器版回滚仍自动重启后端');

    console.log('[7] 旧外壳 static/index.html 的两处自重启入口');
    const legacy = read('static/index.html');
    const confirmFn = (legacy.match(/async function confirmProjectUpdate\(\) \{[\s\S]*?\n        \}/) || [''])[0];
    ok(!!confirmFn, '取到 confirmProjectUpdate');
    const desktopGuard = confirmFn.indexOf('window.novaiUpdater');
    const backendCallIdx = confirmFn.indexOf("fetch('/api/update-from-github'");
    ok(desktopGuard > 0 && backendCallIdx > desktopGuard, '一键更新先判断桌面版，桌面版在请求后端口之前就 return');
    ok(/window\.novaiUpdater\.downloadAndInstall\(\)/.test(confirmFn), '旧外壳一键更新调用桌面更新接口');
    ok(/auto_restart:!isDesktop/.test(legacy), '旧外壳回滚在桌面版不自重启后端');

    console.log('[8] 构建产物带上桌面分支');
    const indexHtml = read('static/v2/index.html');
    const jsHref = (indexHtml.match(/src="(\/static\/v2\/assets\/[^"]+\.js)"/) || [])[1];
    ok(!!jsHref && fs.existsSync(path.join(root, jsHref.replace(/^\//, ''))), 'static/v2/index.html 引用的构建 JS 存在');
    if (jsHref) {
        const bundle = read(jsHref.replace(/^\//, ''));
        ok(bundle.includes('已转交桌面版更新'), '构建产物包含桌面版转交分支');
        ok(bundle.includes('novaiUpdater'), '构建产物包含 window.novaiUpdater 检测');
    }

    console.log('[9] 桌面版进度订阅生命周期');
    ok(/sendUpdateStage\(\{ stage: 'installing'/.test(main), '主进程真正开始安装时先发 installing（新契约，前端据此切卡片）');
    const makeDesktop = (label) => {
        const handlers = [];
        const offs = [];
        return {
            handlers,
            offs,
            updater: {
                onProgress: (cb) => { handlers.push(cb); return () => offs.push(label + ':off'); },
                downloadAndInstall: () => Promise.resolve({ ok: true, supported: true, stage: 'checking' }),
            },
        };
    };

    const live = makeDesktop('live');
    const liveMod = loadUpdateModule(live.updater, () => { throw new Error('桌面模式下不应发 fetch'); });
    await liveMod.startUpdate();
    ok(liveMod.upd.running === false && liveMod.upd.progress === null, '没有进度事件时不显示 0% 假进度');
    ok(live.handlers.length === 1 && live.offs.length === 0, 'downloadAndInstall 返回后订阅仍在（修复前 finally 里已退订）');
    live.handlers[0]({ stage: 'downloading', percent: 42, transferred: 42, total: 100 });
    ok(liveMod.upd.running === true && liveMod.upd.phase === 'running', 'Promise 结束后收到的进度进入 running');
    ok(liveMod.upd.progress && liveMod.upd.progress.percent === 42, 'Promise 结束后进度百分比仍更新到弹窗');
    live.handlers[0]({ stage: 'installing', percent: 100 });
    ok(live.offs.length === 0 && liveMod.upd.running === true, 'installing（等待用户确认）不提前退订');
    live.handlers[0]({ stage: 'installing', percent: 100, final: true });
    ok(live.offs.length === 1 && liveMod.upd.phase === 'restarting', '真正开始安装后自动退订并进入 restarting');

    const failing = makeDesktop('error');
    const failMod = loadUpdateModule(failing.updater, () => { throw new Error('桌面模式下不应发 fetch'); });
    await failMod.startUpdate();
    failing.handlers[0]({ stage: 'error', error: 'HTTP 404' });
    ok(failing.offs.length === 1 && failMod.upd.phase === 'error' && failMod.upd.running === false, 'error 终态退订并显示失败');

    const closing = makeDesktop('close');
    const closeMod = loadUpdateModule(closing.updater, () => noResponse());
    await closeMod.startUpdate();
    closing.handlers[0]({ stage: 'downloading', percent: 10 });
    closeMod.closeUpdateModal();
    ok(closing.offs.length === 1, '关闭弹窗后退订（不再收进度）');
    closeMod.openUpdateModal();
    ok(closing.handlers.length === 2, '重新打开弹窗时恢复订阅');
    closeMod.closeUpdateModal();
    ok(closing.offs.length === 2, '再次关闭后退订');

    const timeout = makeDesktop('timeout');
    const timeoutMod = loadUpdateModule(timeout.updater, () => { throw new Error('桌面模式下不应发 fetch'); });
    await timeoutMod.startUpdate();
    const pending = Array.from(timeoutMod.timers.values()).filter((item) => item.ms === 30 * 60 * 1000);
    ok(pending.length === 1 && timeout.offs.length === 0, '订阅时挂了 30 分钟超时');
    pending[0].fn();
    ok(timeout.offs.length === 1, '30 分钟超时后退订');

    console.log('[10] IPC 契约 v1：四个新 invoke 的真实行为');
    const ipcDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'novai-updater-ipc-'));
    const ipc = loadUpdaterIpc(main, { stateDir: ipcDir, updateStage: 'downloaded', platform: 'win32' });
    ok(!!ipc.handlers['novai:update-restart'], '注册 novai:update-restart');
    ok(!!ipc.handlers['novai:update-later'], '注册 novai:update-later');
    ok(!!ipc.handlers['novai:update-notes-seen'], '注册 novai:update-notes-seen');
    ok(!!ipc.handlers['novai:update-retry'], '注册 novai:update-retry');

    const later = await ipc.handlers['novai:update-later']();
    ok(later && later.ok === true && later.phase === 'install', 'installOnQuit 返回 {ok:true, phase:"install"}');
    ok(ipc.readState().pendingVersion === '2.0.7', 'installOnQuit 把 pendingVersion 真写进 update-state.json');

    const notesSeen = await ipc.handlers['novai:update-notes-seen'](null, { version: '2.0.7' });
    ok(notesSeen && notesSeen.ok === true, 'markNotesSeen 返回 ok:true');
    ok(ipc.readState().notesSeenVersion === '2.0.7', 'markNotesSeen 记录已看版本');

    ipc.sandbox.autoUpdater = { autoInstallOnAppQuit: false };
    const retried = await ipc.handlers['novai:update-retry']();
    ok(retried && retried.ok === true && retried.phase === 'check', 'retryInstall 返回 {ok:true, phase:"check"} 并重新检查');
    ok(ipc.sandbox.autoUpdater.autoInstallOnAppQuit === true, '重试后重新允许退出时安装');
    ok(ipc.calls.save.some((patch) => patch.installAttempts === 0 && patch.lastInstallError === ''), '重试清除失败状态');

    const idleIpc = loadUpdaterIpc(main, { stateDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'novai-updater-idle-')), updateStage: 'idle' });
    const notReady = await idleIpc.handlers['novai:update-later']();
    ok(notReady && notReady.ok === false && notReady.phase === 'download', '没下载完时 installOnQuit 不会假装成功');

    const devIpc = loadUpdaterIpc(main, { stateDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'novai-updater-dev-')), appIsPackaged: false });
    const devRestart = await devIpc.handlers['novai:update-restart']();
    ok(devRestart && devRestart.ok === false && devRestart.phase === 'install' && devRestart.reason === 'dev', 'dev 下 restartNow 明确返回 ok:false（不静默退出）');
    [ipcDir].forEach((dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

    console.log('[11] 退出收敛只执行一次 / 启动自检清零');
    const converge = loadConverge(main, { state: { pendingVersion: '2.0.7', installAttempts: 0 }, updateStage: 'downloaded', platform: 'win32' });
    ok(converge.calls.save.length === 1 && converge.calls.save[0].installAttempts === 1, 'before-quit 收敛只触发一次安装');
    ok(converge.calls.stages.filter((payload) => payload.stage === 'installing').length === 1, '只发一次 installing，重复调用不再装');
    const alreadyNew = loadConverge(main, { state: { pendingVersion: '2.0.6', installAttempts: 0 }, currentVersion: '2.0.6', updateStage: 'downloaded' });
    ok(alreadyNew.calls.save.length === 1 && alreadyNew.calls.save[0].pendingVersion === '' && alreadyNew.calls.stages.length === 0, '当前已是待装版本时只清 pending，不重复安装');
    const gaveUp = loadConverge(main, { state: { pendingVersion: '2.0.7', installAttempts: 2 }, updateStage: 'downloaded' });
    ok(gaveUp.calls.save.length === 0 && gaveUp.calls.stages.length === 0, '安装重试次数用完不再自动装');

    const boot = loadMarkBootSuccess(main);
    ok(boot.calls.length === 1 && boot.calls[0].bootAttempts === 0 && boot.calls[0].lastRunVersion === '2.0.7', '主窗口加载完成后 bootAttempts 清零');
    ok(boot.sandbox.bootSettled === true, '重复加载不会重复写状态');
    const didFinish = sliceBetween(main, "mainWindow.webContents.on('did-finish-load'", "mainWindow.webContents.on('zoom-changed'");
    ok(/onMainWindowLoaded\(\)/.test(didFinish), 'did-finish-load 触发启动自检清零');
    ok(/markBootSuccess\(\)/.test(topLevelFunction(main, 'onMainWindowLoaded')), '启动自检通过走 markBootSuccess');

    console.log('');
    if (fails.length) {
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach(f => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('全部通过（' + pass + ' 项）');
})().catch((err) => {
    console.error('测试异常：', err && err.stack || err);
    process.exit(1);
});
