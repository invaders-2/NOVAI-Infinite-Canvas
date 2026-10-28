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
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        AbortController: FakeAbortController,
        window: { novaiUpdater },
    };
    const ctx = vm.createContext(sandbox);
    const exported = vm.runInContext(
        src + '\n;({ upd, startUpdate, rollback, compareVersions })',
        ctx,
        { filename: 'web/src/lib/update.js' }
    );
    return { ...exported, calls, toasts, store };
}

const okResponse = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const noResponse = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });

(async () => {
    console.log('[1] preload 暴露 window.novaiUpdater');
    const preload = read('desktop/preload.js');
    ok(/exposeInMainWorld\('novaiUpdater'/.test(preload), 'preload 暴露 novaiUpdater');
    ok(/checkNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('novai:update-check'\)/.test(preload), 'checkNow → novai:update-check');
    ok(/downloadAndInstall:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('novai:update-install'\)/.test(preload), 'downloadAndInstall → novai:update-install');

    console.log('[2] main.js 的 electron-updater 复用逻辑');
    const main = read('desktop/main.js');
    const registerIpc = topLevelFunction(main, 'registerIpc');
    ok(/registerUpdaterIpc\(\)/.test(registerIpc), 'registerIpc 里注册更新 IPC');
    ok(/ipcMain\.handle\('novai:update-check'/.test(main), '注册 novai:update-check');
    ok(/ipcMain\.handle\('novai:update-install'/.test(main), '注册 novai:update-install');

    const installHandler = (main.match(/ipcMain\.handle\('novai:update-install'[\s\S]*?\n  \}\);/g) || [''])[0];
    ok(!!installHandler, '能取到 update-install 处理器');
    const downloadedBranch = (installHandler.match(/if \(updateStage === 'downloaded'\) \{[\s\S]*?\n    \}/) || [''])[0];
    ok(/showUpdateInstallPrompt\(\)/.test(downloadedBranch), '已 downloaded 时弹「立即重启」确认');
    ok(!/downloadUpdate\(/.test(downloadedBranch), '已 downloaded 时不再调用 downloadUpdate');

    const installPrompt = topLevelFunction(main, 'showUpdateInstallPrompt');
    ok(/stopBackendForUpdate\(\)\.then\(\(\) => autoUpdater\.quitAndInstall\(\)\)/.test(installPrompt), '安装前先 stopBackendForUpdate 再 quitAndInstall');
    ok(/showUpdateAvailablePrompt/.test(topLevelFunction(main, 'setupAutoUpdate')), 'update-available 复用同一个确认框');
    ok(/autoUpdater\.on\('update-downloaded'/.test(main) && /showUpdateInstallPrompt\(\)/.test(main), 'update-downloaded 复用同一个安装确认框');
    ok(/manualUpdateCheck/.test(main), '手动检查才有「已是最新版本」提示（启动自动检查保持安静）');

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
    ok(unsupportedMod.toasts.length === 1 && unsupportedMod.toasts[0].text.includes('不支持自动更新'), '桌面版不支持时明确提示手动覆盖安装');

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
