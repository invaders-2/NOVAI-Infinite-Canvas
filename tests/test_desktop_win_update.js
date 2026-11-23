#!/usr/bin/env node
/* Windows 端更新回归（纯 node，不启动 Electron）：
   W1. parseNetstatListenPids：IPv4/IPv6、重复 PID、3000 不误匹配 30001、空文本、中文表头；
   W2. freeBackendPort：win32 下 netstat -ano → taskkill /F /T → 轮询端口释放；非 win32 直接放行；
   W3. stopBackendForUpdate：backendProc 为空（复用外部/残留后端）也必须释放端口；
   W4. Windows 静默安装 quitAndInstall(true, true)，macOS 保持 quitAndInstall()；
   W5. download-progress / update-downloaded 把进度转发给界面。
   跑法：node tests/test_desktop_win_update.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const fails = [];
/* 环境缺省导致的跳过（例如 CI 没装 desktop/node_modules）：既不算 passed，也不算 failed。 */
const skips = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };
const samePids = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

function topLevelFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex((line) => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if (start < 0) return '';
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

/* 抽出 applyUpdateNow 真跑安装决策：验证停后端 → 发 installing → quitAndInstall 的顺序与失败分支。 */
function loadApplyUpdateNow(options) {
    const opts = options || {};
    const order = [];
    const sandbox = {
        app: { isPackaged: true, getVersion: () => '2.0.6' },
        process: { platform: opts.platform || 'win32' },
        autoUpdater: {
            quitAndInstall: (silent, force) => { order.push(['quitAndInstall', silent, force]); },
        },
        macPreparedUpdate: opts.macPreparedUpdate || null,
        pendingUpdateInfo: { version: '2.0.7' },
        pendingNotes: null,
        stageVersion: '2.0.7',
        updateStage: opts.updateStage || 'downloaded',
        updatePersist: { pendingVersion: '2.0.7', installAttempts: 0, lastInstallError: '' },
        quitInstallTriggered: false,
        updateInstallBlockedDir: () => opts.blockedDir || '',
        stopBackendForUpdate: async () => { order.push(['stopBackendForUpdate']); },
        stopDownloadProgressTicker: () => { order.push(['stopDownloadProgressTicker']); },
        saveUpdateState: (patch) => { order.push(['saveUpdateState', patch]); },
        sendUpdateStage: (payload) => { order.push(['sendUpdateStage', payload]); },
        startMacSelfUpdate: async () => { order.push(['startMacSelfUpdate']); return { ok: true, supported: true, phase: 'download' }; },
        installMacPreparedUpdate: async () => { order.push(['installMacPreparedUpdate']); return { ok: true, supported: true, phase: 'install' }; },
        clog: () => {},
    };
    const fn = vm.runInNewContext(topLevelFunction(main, 'applyUpdateNow') + '\napplyUpdateNow', sandbox);
    return { run: fn, order, sandbox };
}

const main = read('desktop/main.js');
const parseSrc = topLevelFunction(main, 'parseNetstatListenPids');
ok(!!parseSrc, 'main.js 里有 parseNetstatListenPids');
const parse = vm.runInNewContext(parseSrc + '\nparseNetstatListenPids', {});

console.log('[1] parseNetstatListenPids：IPv4 / IPv6 / 重复 PID');
const ipv4Only = '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242';
ok(samePids(parse(ipv4Only, 3000), [4242]), 'IPv4 LISTENING 解析出 PID');
const v6AndDup = [
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
    '  TCP    [::]:3000              [::]:0                 LISTENING       5151',
    '  TCP    [::1]:3000             [::]:0                 LISTENING       5151',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
].join('\r\n');
ok(samePids(parse(v6AndDup, 3000), [4242, 5151]), 'IPv4 + IPv6 去重后按出现顺序返回');
ok(samePids(parse('TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 7001', 3000), [7001]), '无前导空格也能解析');
ok(samePids(parse('\tTCP\t[::]:3000\t[::]:0\tLISTENING\t7002', 3000), [7002]), 'Tab 分隔也能解析');
ok(samePids(parse('  TCPv6  [::]:3000  [::]:0  LISTENING  7003', 3000), [7003]), '兼容 TCPv6 协议名');

console.log('[2] 端口精确匹配 / 空文本 / 中文表头');
const prefixLines = [
    '  TCP    0.0.0.0:30001          0.0.0.0:0              LISTENING       9001',
    '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       9002',
    '  TCP    0.0.0.0:13000          0.0.0.0:0              LISTENING       9003',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
].join('\n');
ok(samePids(parse(prefixLines, 3000), [4242]), '3000 不误匹配 30000 / 30001 / 13000');
ok(samePids(parse('  TCP    0.0.0.0:30001  0.0.0.0:0  LISTENING  9001', 3000), []), '只有 30001 时端口 3000 返回空');
ok(samePids(parse(prefixLines, '3000'), [4242]), '端口传字符串也能匹配');
ok(samePids(parse('', 3000), []) && samePids(parse(null, 3000), []) && samePids(parse(undefined, 3000), []), '空文本 / null / undefined 返回空数组');
ok(samePids(parse('   \r\n\r\n', 3000), []), '纯空白文本返回空数组');
let threw = false;
try { parse({ not: 'text' }, 3000); parse(Symbol('x'), 3000); } catch (_) { threw = true; }
ok(!threw, '非字符串输入不抛错');

const zhOutput = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
    '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       4243',
    '  TCP    0.0.0.0:3000           127.0.0.1:62831        ESTABLISHED     4242',
    '',
].join('\r\n');
ok(samePids(parse(zhOutput, 3000), [4242]), '中文表头不影响解析，ESTABLISHED 不误杀');

console.log('[3] freeBackendPort：netstat → taskkill → 轮询释放');
const freeSrc = topLevelFunction(main, 'freeBackendPort');
ok(!!freeSrc, 'main.js 里有 freeBackendPort');
function loadFreeBackendPort(options) {
    const calls = [];
    const logs = [];
    const sandbox = {
        backendPort: options.backendPort,
        process: { platform: options.platform || 'win32' },
        clog: (area, msg) => logs.push('[' + area + '] ' + msg),
        execFile: (cmd, args, opts, cb) => {
            calls.push([cmd].concat(args));
            if (cmd === 'netstat') return cb(options.netstatError || null, options.netstat || '', '');
            return cb(null, 'SUCCESS: The process has been terminated.', '');
        },
        isPortInUse: () => Promise.resolve(!!options.portInUse),
        setTimeout: (fn) => { fn(); return 0; },
        clearTimeout: () => {},
        console: { log() {}, error() {} },
    };
    if (options.fakeClock) {
        let clock = 0;
        sandbox.Date = { now: () => { clock += 400; return clock; } };
    }
    const fn = vm.runInNewContext(parseSrc + '\n' + freeSrc + '\nfreeBackendPort', sandbox);
    return { fn, calls, logs };
}

(async () => {
    const netstat = [
        '  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    4242',
        '  TCP    [::]:3000       [::]:0       LISTENING    5151',
    ].join('\r\n');
    const runner = loadFreeBackendPort({ backendPort: 3000, netstat });
    const freed = await runner.fn(2000);
    const kills = runner.calls.filter((call) => call[0] === 'taskkill');
    ok(freed === true, '端口已释放时 resolve(true)');
    ok(runner.calls[0] && runner.calls[0][0] === 'netstat' && runner.calls[0][1] === '-ano', '先执行 netstat -ano');
    ok(kills.length === 2 && kills[0].join(' ') === 'taskkill /F /T /PID 4242' && kills[1].join(' ') === 'taskkill /F /T /PID 5151', '对每个 PID 执行 taskkill /F /T /PID');
    ok(runner.logs.some((m) => m.indexOf('4242') >= 0), '日志记录占用端口的 PID');
    ok(runner.logs.some((m) => m.indexOf('已释放') >= 0), '日志记录端口是否已释放');

    const mac = loadFreeBackendPort({ platform: 'darwin', backendPort: 3000, netstat });
    ok((await mac.fn(2000)) === true && mac.calls.length === 0, '非 win32 直接放行，不跑 netstat/taskkill（mac 行为不变）');

    const cloud = loadFreeBackendPort({ platform: 'win32', backendPort: 0, netstat });
    ok((await cloud.fn(2000)) === true && cloud.calls.length === 0, '没有本地后端端口（云端模式）时不碰任何进程');

    const noListen = loadFreeBackendPort({ platform: 'win32', backendPort: 3000, netstat: '  协议  本地地址  外部地址  状态  PID', portInUse: false });
    const noListenResult = await noListen.fn(2000);
    ok(noListenResult === true && noListen.calls.length === 1 && !noListen.calls.some((call) => call[0] === 'taskkill'), 'netstat 没发现监听进程时不 taskkill，仍轮询端口');

    const stuck = loadFreeBackendPort({ platform: 'win32', backendPort: 3000, netstat, portInUse: true, fakeClock: true });
    const stuckResult = await stuck.fn(1000);
    ok(stuckResult === false, '端口始终不释放时 resolve(false)，不阻塞安装');
    ok(stuck.logs.some((m) => m.indexOf('仍未释放') >= 0), '端口未释放写日志（含超时毫秒数）');

    const netstatFailed = loadFreeBackendPort({ platform: 'win32', backendPort: 3000, netstatError: new Error('netstat failed'), portInUse: false });
    const failedResult = await netstatFailed.fn(2000);
    ok(failedResult === true && !netstatFailed.calls.some((call) => call[0] === 'taskkill'), 'netstat 执行失败时降级为轮询端口，不误杀进程');
    ok(netstatFailed.logs.some((m) => m.indexOf('netstat -ano 执行失败') >= 0), 'netstat 失败写日志');

    console.log('[4] stopBackendForUpdate / shutdownBackend 接线');
    const stopSrc = topLevelFunction(main, 'stopBackendForUpdate');
    const stopCalls = [];
    const stopLogs = [];
    const stopRunner = vm.runInNewContext([parseSrc, freeSrc, stopSrc, 'stopBackendForUpdate'].join('\n'), {
        backendProc: null,
        backendPort: 3000,
        backendStopExpected: false,
        process: { platform: 'win32' },
        clog: (area, msg) => stopLogs.push('[' + area + '] ' + msg),
        spawn: (cmd, args) => { stopCalls.push([cmd].concat(args)); return { once() {}, killed: false }; },
        execFile: (cmd, args, opts, cb) => {
            stopCalls.push([cmd].concat(args));
            if (cmd === 'netstat') return cb(null, netstat, '');
            return cb(null, 'SUCCESS', '');
        },
        isPortInUse: () => Promise.resolve(false),
        setTimeout: (fn) => { fn(); return 0; },
        clearTimeout: () => {},
        console: { log() {}, error() {} },
    });
    const stopFreed = await stopRunner(2000);
    ok(stopFreed === true, 'backendProc 为空时仍会完成端口释放（核心修复）');
    ok(stopCalls.some((call) => call[0] === 'netstat') && stopCalls.some((call) => call[0] === 'taskkill'), 'backendProc 为空时实际执行 netstat + taskkill');
    ok(stopLogs.some((m) => m.indexOf('已释放') >= 0), 'backendProc 为空时也记录端口释放结果');
    ok(/return stopOwnedProc\.then\(\(\) => freeBackendPort\(/.test(stopSrc), '先停自己 spawn 的进程，完成后再释放端口');
    ok(/freeBackendPort\(Math\.min\(limit, 8000\)\)/.test(stopSrc), '端口释放有独立超时上限');
    ok(/if \(!proc \|\| proc\.killed \|\| !proc\.pid\) return resolve\(\);/.test(stopSrc), 'backendProc 为空只跳过第一步，不跳过端口释放');
    ok(/spawn\('taskkill', \['\/F', '\/T', '\/PID', String\(proc\.pid\)\]/.test(stopSrc), 'Windows 先按进程树结束自己 spawn 的后端');
    const shutdownFn = topLevelFunction(main, 'shutdownBackend');
    const killTreeFn = topLevelFunction(main, 'killProcessTree');
    ok(/killProcessTree\(pid\)/.test(shutdownFn), 'shutdownBackend 统一交给 killProcessTree 结束整棵进程树');
    ok(/if \(backendStopped\) return true;/.test(shutdownFn), 'shutdownBackend 幂等（before-quit + will-quit 都走）');
    ok(/forgetBackendPid\(\)/.test(shutdownFn) && shutdownFn.indexOf('killProcessTree') < shutdownFn.indexOf('forgetBackendPid'), '杀成功后才删 pid 记录（失败留给下次启动清理）');
    ok(/process\.platform === 'win32'/.test(killTreeFn), 'killProcessTree 区分 Windows');
    ok(/spawnSync\('taskkill', \['\/F', '\/T', '\/PID', String\(target\)\]/.test(killTreeFn), 'Windows 退出按进程树同步结束（异步 spawn 来不及跑，会留下 PyInstaller 子进程）');
    ok(/process\.kill\(target, 'SIGKILL'\)/.test(killTreeFn), '其它平台仍是 SIGKILL');
    const startFn = topLevelFunction(main, 'startBackend');
    ok(/backendPort = port;/.test(startFn), '启动后端时记录 backendPort');
    const reuseAt = main.indexOf('if (reuseExisting) {');
    ok(reuseAt >= 0 && /backendPort = port;/.test(main.slice(reuseAt, reuseAt + 200)), '复用外部后端时也记录 backendPort');

    console.log('[5] 静默安装 / 下载进度 / 打包配置');
    const winApply = loadApplyUpdateNow({ platform: 'win32' });
    const winResult = await winApply.run();
    const stopAt = winApply.order.findIndex((item) => item[0] === 'stopBackendForUpdate');
    const quitAt = winApply.order.findIndex((item) => item[0] === 'quitAndInstall');
    ok(stopAt >= 0 && quitAt > stopAt, '安装前先 stopBackendForUpdate 再 quitAndInstall');
    const quitCall = winApply.order[quitAt];
    ok(quitCall && quitCall[1] === true && quitCall[2] === true, 'Windows 静默安装 quitAndInstall(true, true)');
    ok(winResult && winResult.ok === true && winResult.phase === 'install', 'restartNow 安装受理返回 {ok:true, phase:"install"}');
    const installStageAt = winApply.order.findIndex((item) => item[0] === 'sendUpdateStage' && item[1].stage === 'installing');
    ok(installStageAt >= 0 && installStageAt < quitAt, '真正安装前先发 installing（前端 watchdog 不会空等）');

    const macApply = loadApplyUpdateNow({ platform: 'darwin', macPreparedUpdate: { version: '2.0.7', zipPath: '/tmp/a.zip' } });
    const macResult = await macApply.run();
    ok(macApply.order.some((item) => item[0] === 'installMacPreparedUpdate'), 'macOS 走自替换安装链路');
    ok(!macApply.order.some((item) => item[0] === 'quitAndInstall'), 'macOS 不走 electron-updater quitAndInstall');
    ok(macResult && macResult.phase === 'install', 'mac 安装受理返回 phase install');

    const blockedApply = loadApplyUpdateNow({ platform: 'win32', blockedDir: '/Program Files/NOVAI' });
    const blockedResult = await blockedApply.run();
    const blockedError = blockedApply.order.find((item) => item[0] === 'sendUpdateStage' && item[1].stage === 'error');
    ok(blockedResult && blockedResult.ok === false, '安装目录不可写时返回 ok:false');
    ok(blockedError && blockedError[1].phase === 'install' && /不可写/.test(blockedError[1].message), '安装目录不可写时发 error(phase:"install")');
    ok(!blockedApply.order.some((item) => item[0] === 'quitAndInstall'), '安装目录不可写时不会退出应用');
    ok(blockedApply.order.some((item) => item[0] === 'saveUpdateState' && item[1].lastInstallError), '安装目录不可写时记录 lastInstallError');

    const setupFn = topLevelFunction(main, 'setupAutoUpdate');
    const progressAt = setupFn.indexOf("autoUpdater.on('download-progress'");
    const downloadedAt = setupFn.indexOf("autoUpdater.on('update-downloaded'");
    const progressBlock = progressAt >= 0 && downloadedAt > progressAt ? setupFn.slice(progressAt, downloadedAt) : '';
    ok(/sendUpdateProgress\(\{ stage: 'downloading'/.test(progressBlock), 'download-progress 仍向旧 onProgress 通道发进度（老前端兼容）');
    ok(/Math\.round\(info\.percent \|\| 0\)/.test(progressBlock), '原生进度百分比四舍五入');
    ok(/transferred: transferred/.test(progressBlock) && /total: total/.test(progressBlock), '旧 onProgress 通道仍转发 transferred / total');
    ok(/pushDownloadProgress\(/.test(progressBlock), '原生进度写入节拍器最新值，由节拍器统一发 downloading');
    ok(/setInterval\(emitDownloadProgressStage, 400\)/.test(topLevelFunction(main, 'startDownloadProgressTicker')), '按 400ms 固定节拍发 downloading（≤500ms）');
    ok(/process\.platform === 'darwin'\) return;/.test(progressBlock), 'macOS 不重复发进度（自替换链路自己发）');
    const downloadedBlock = downloadedAt >= 0 ? setupFn.slice(downloadedAt, setupFn.indexOf("autoUpdater.on('error'", downloadedAt)) : '';
    ok(/onUpdatePackageReady\(version, info\)/.test(downloadedBlock), '下载完成转交 onUpdatePackageReady');
    ok(!/showUpdateInstallPrompt|dialog\.showMessageBox/.test(downloadedBlock), '下载完成不再弹安装确认框');
    const readyFn = topLevelFunction(main, 'onUpdatePackageReady');
    ok(/stage: 'downloaded', version: ver/.test(readyFn) && /payload\.notes = pendingNotes/.test(readyFn), '推 downloaded 事件（version + notes）');
    const pkg = JSON.parse(read('desktop/package.json'));
    ok(pkg.build.nsis.oneClick === false, 'NSIS 使用向导式安装（能选安装目录）');
    ok(pkg.build.nsis.allowToChangeInstallationDirectory === true, '向导里允许改安装目录');
    ok(pkg.build.nsis.perMachine === false, 'NSIS 仍装到当前用户（不要求管理员）');
    ok(pkg.build.nsis.allowElevation === false, '安装程序不申请 UAC 提权（锁死当前用户安装）');
    ok(pkg.build.nsis.createDesktopShortcut === true && pkg.build.nsis.shortcutName === 'NOVAI', '保留桌面快捷方式与名称');
    const nsi = read('installer.nsi');
    ok(/!insertmacro MUI_PAGE_DIRECTORY/.test(nsi), '传统 installer.nsi 也有目录页（同样可选目录）');
    ok(String(pkg.build.win.artifactName).indexOf('NOVAI-Electron-Setup-') === 0, 'artifactName 不变');

    console.log('[6] Windows 更新源顺序：镜像 → GitHub，且只切一次');
    const feedSrc = ['updateFeedOrder', 'nextUntriedFeed', 'applyUpdateFeed'].map((name) => topLevelFunction(main, name)).join('\n');
    const feedLogs = [];
    let lastFeed = null;
    const feedApi = vm.runInNewContext(feedSrc + '\n;({ updateFeedOrder, nextUntriedFeed, applyUpdateFeed })', {
        UPDATE_MIRROR_URL: 'https://mirror.example/electron-release',
        UPDATE_GITHUB_FEED: { provider: 'github', owner: 'invaders-2', repo: 'NOVAI-Infinite-Canvas' },
        autoUpdater: { setFeedURL: (config) => { lastFeed = config; } },
        clog: (area, msg) => feedLogs.push(area + ':' + msg),
    });
    const winFeeds = feedApi.updateFeedOrder('win32');
    ok(winFeeds.length === 2 && winFeeds[0].source === 'mirror' && winFeeds[0].config.provider === 'generic', 'win32 先试镜像 generic feed');
    ok(winFeeds[0].config.url === 'https://mirror.example/electron-release', '镜像 feed 地址指向 electron-release');
    ok(winFeeds[1].source === 'github' && winFeeds[1].config.provider === 'github' && winFeeds[1].config.owner === 'invaders-2', 'win32 失败回退 GitHub');
    const macFeeds = feedApi.updateFeedOrder('darwin');
    ok(macFeeds[0].source === 'github' && macFeeds[1].source === 'mirror', '其它平台保持 GitHub 优先');
    const attempted = new Set(['mirror']);
    ok(feedApi.nextUntriedFeed(winFeeds, attempted) === winFeeds[1], '镜像失败后下一个是 GitHub');
    attempted.add('github');
    ok(feedApi.nextUntriedFeed(winFeeds, attempted) === null, '两个源都试过后不再切换（防死循环）');
    ok(feedApi.nextUntriedFeed(winFeeds, new Set()) === winFeeds[0], '空集合返回第一个源');
    feedApi.applyUpdateFeed(winFeeds[0]);
    ok(lastFeed === winFeeds[0].config && feedLogs.some((m) => m.indexOf('更新源=国内镜像') >= 0 && m.indexOf('mirror.example') >= 0), '切换 feed 时记录源与地址');

    const setupSrc = topLevelFunction(main, 'setupAutoUpdate');
    ok(/updateFeedOrder\(process\.platform\)/.test(setupSrc), 'setupAutoUpdate 按平台取更新源顺序');
    ok(/attemptedSources\.add\(currentFeed\.source\)/.test(setupSrc) && /nextUntriedFeed\(feedOrder, attemptedSources\)/.test(setupSrc), '用 attemptedSources 记录已试源');
    ok(!/switchedToMirror/.test(setupSrc), '不再使用「切了就不回退」的布尔开关');
    ok(/更新失败（源=/.test(setupSrc), '失败日志写明是哪个源');
    ok(/切换到 ' \+ next\.label \+ ' 重试一次/.test(setupSrc), '切换日志写明目标源');
    ok(/所有更新源均失败/.test(setupSrc), '两个源都失败时记录汇总日志');
    const availableBlock = setupSrc.slice(setupSrc.indexOf("autoUpdater.on('update-available'"), setupSrc.indexOf("autoUpdater.on('download-progress'"));
    ok(/startUpdateDownload\(info\)/.test(availableBlock), '切源后重新发现更新会自动续下（不再让用户点一次）');

    console.log('[7] 静默升级装回当前程序目录（NsisUpdater /D=）');
    const installDirSrc = topLevelFunction(main, 'windowsUpdateInstallDir');
    const applyDirSrc = topLevelFunction(main, 'applyUpdateInstallDir');
    ok(!!installDirSrc, 'main.js 里有 windowsUpdateInstallDir');
    ok(!!applyDirSrc, 'main.js 里有 applyUpdateInstallDir');
    ok(!/require\(/.test(installDirSrc) && !/require\(/.test(applyDirSrc), '两个函数用模块顶层 path/fs，函数内不 require（回归测试可注入）');

    /* 抽出两个函数真跑：path 用 win32 变体注入，platform / execPath / app.isPackaged / 可写性都可控。 */
    function loadInstallDir(options) {
        const opts = options || {};
        const sandbox = {
            path: opts.path || path.win32,
            process: {
                platform: opts.platform || 'win32',
                execPath: opts.execPath === undefined ? 'D:\\NOVAI\\NOVAI.exe' : opts.execPath,
            },
            app: opts.app === undefined ? { isPackaged: true } : opts.app,
            fs: opts.fs || { accessSync() {}, constants: { W_OK: 2 } },
        };
        return vm.runInNewContext(
            [installDirSrc, applyDirSrc, '({ windowsUpdateInstallDir: windowsUpdateInstallDir, applyUpdateInstallDir: applyUpdateInstallDir })'].join('\n'),
            sandbox,
        );
    }

    const winDirApi = loadInstallDir({});
    ok(winDirApi.windowsUpdateInstallDir() === 'D:\\NOVAI', 'win32 + 已打包 + 目录可写 → 返回当前程序目录 D:\\NOVAI');

    const devDirApi = loadInstallDir({ app: { isPackaged: false } });
    ok(devDirApi.windowsUpdateInstallDir() === '', 'app.isPackaged 明确为 false 时返回空串（开发态不指定目录）');

    const macDirApi = loadInstallDir({
        platform: 'darwin',
        path: path.posix,
        execPath: '/Applications/NOVAI.app/Contents/MacOS/NOVAI',
    });
    ok(macDirApi.windowsUpdateInstallDir() === '', 'platform=darwin 返回空串（mac 不走 NSIS /D=）');

    const noExecApi = loadInstallDir({ execPath: '' });
    ok(noExecApi.windowsUpdateInstallDir() === '', 'process.execPath 取不到时返回空串');

    const readOnlyApi = loadInstallDir({ fs: { accessSync() { throw new Error('EACCES'); }, constants: { W_OK: 2 } } });
    ok(readOnlyApi.windowsUpdateInstallDir() === '', '目录不可写（accessSync 抛错）返回空串，交给 updateInstallBlockedDir 报错');

    let dirThrew = false;
    let dirThrewResult = 'x';
    try {
        dirThrewResult = vm.runInNewContext(installDirSrc + '\nwindowsUpdateInstallDir', {
            path: { dirname() { throw new Error('boom'); } },
            process: { platform: 'win32', execPath: 'D:\\NOVAI\\NOVAI.exe' },
            app: { isPackaged: true },
            fs: { accessSync() {}, constants: { W_OK: 2 } },
        })();
    } catch (_) { dirThrew = true; }
    ok(!dirThrew && dirThrewResult === '', '任何异常都吞掉返回空串，绝不抛');

    const winApplyDirApi = loadInstallDir({});
    const winUpdater = {};
    const appliedWinDir = winApplyDirApi.applyUpdateInstallDir(winUpdater);
    ok(appliedWinDir === 'D:\\NOVAI' && winUpdater.installDirectory === 'D:\\NOVAI', 'applyUpdateInstallDir 把当前程序目录写进 updater.installDirectory 并返回');

    const macUpdaterStub = {};
    const macApplyDirApi = loadInstallDir({
        platform: 'darwin',
        path: path.posix,
        execPath: '/Applications/NOVAI.app/Contents/MacOS/NOVAI',
    });
    const appliedMacDir = macApplyDirApi.applyUpdateInstallDir(macUpdaterStub);
    ok(appliedMacDir === '' && macUpdaterStub.installDirectory === undefined, '非 win32 不设置 installDirectory（保持 undefined）');
    ok(winApplyDirApi.applyUpdateInstallDir(null) === '', 'updater 为空返回空串，不抛');

    const setupWithDir = topLevelFunction(main, 'setupAutoUpdate');
    const applyCallAt = setupWithDir.indexOf('applyUpdateInstallDir(');
    const checkingAt = setupWithDir.indexOf("updateStage = 'checking'");
    const autoQuitAt = setupWithDir.indexOf('autoUpdater.autoInstallOnAppQuit = true;');
    ok(applyCallAt >= 0, 'setupAutoUpdate 里调用了 applyUpdateInstallDir');
    ok(autoQuitAt >= 0 && applyCallAt > autoQuitAt, '安装目录在设完 autoInstallOnAppQuit 之后设置');
    ok(applyCallAt >= 0 && checkingAt > applyCallAt, '安装目录在 updateStage = checking 之前设置');
    ok(/if \(updateInstallDir\) clog\('updater', '静默升级安装目录=' \+ updateInstallDir\);/.test(setupWithDir), '拿到目录才写日志（mac / dev 不刷屏）');

    const nsisUpdaterFile = 'desktop/node_modules/electron-updater/out/NsisUpdater.js';
    if (fs.existsSync(path.join(root, nsisUpdaterFile))) {
        const nsisUpdaterSrc = read(nsisUpdaterFile);
        ok(nsisUpdaterSrc.indexOf('installDirectory') >= 0, 'electron-updater 仍支持 installDirectory');
        ok(nsisUpdaterSrc.indexOf('/D=${this.installDirectory}') >= 0, 'electron-updater 仍把 installDirectory 拼成 /D=（依赖升级改掉这行 → 本修复会静默失效，这条负责红灯）');
    } else {
        skips.push('读不到 ' + nsisUpdaterFile);
        console.log('  [skip] 本机没装 desktop/node_modules/electron-updater，跳过对 NsisUpdater 源码的断言（CI 就是这样）');
    }

    console.log('[8] 安装向导默认目录：启动时校正 InstallLocation 登记');
    const syncSrc = topLevelFunction(main, 'syncInstallLocationRegistry');
    const keyConstSrc = (main.match(/^const NSIS_INSTALL_REGISTRY_KEY = '[^']*';$/m) || [''])[0];
    ok(!!syncSrc, 'main.js 里有 syncInstallLocationRegistry');
    ok(!!keyConstSrc, 'main.js 里有 NSIS_INSTALL_REGISTRY_KEY 顶层常量');
    ok(!!syncSrc && !/require\(/.test(syncSrc), '函数内不 require（回归测试可注入 spawnSync）');

    let uuidLib = null;
    try { uuidLib = require(path.join(root, 'desktop/node_modules/builder-util-runtime')); } catch (_) {}
    const uuidAvailable = !!(uuidLib && uuidLib.UUID);
    if (uuidAvailable) {
        ok(!!(uuidLib && uuidLib.UUID), '能加载 builder-util-runtime 的 UUID（校验 NSIS GUID 用）');
    } else {
        skips.push('读不到 desktop/node_modules/builder-util-runtime');
        console.log('  [skip] 本机没装 desktop/node_modules/builder-util-runtime，跳过 UUID v5 相关断言（CI 就是这样）');
    }
    let expectedGuid = '';
    try {
        if (uuidLib && uuidLib.UUID && pkg.build && pkg.build.appId) {
            expectedGuid = String(uuidLib.UUID.v5(pkg.build.appId, uuidLib.UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
        }
    } catch (_) {}
    const expectedKey = 'Software\\' + expectedGuid;
    const constValue = keyConstSrc ? vm.runInNewContext(keyConstSrc + '\nNSIS_INSTALL_REGISTRY_KEY', {}) : '';
    if (uuidAvailable) {
        ok(!!expectedGuid && constValue === expectedKey, 'NSIS_INSTALL_REGISTRY_KEY 等于 appId 现算的 UUID v5（appId 一改就红灯）');
    }

    /* 真跑 syncInstallLocationRegistry：path/process/app/fs/spawnSync/clog 全注入，reg 调用序列与参数可断言。 */
    function loadSyncRegistry(options) {
        const opts = options || {};
        const calls = [];
        const timeouts = [];
        const logs = [];
        const responses = (opts.responses || []).slice();
        const sandbox = {
            path: opts.path || path.win32,
            process: {
                platform: opts.platform || 'win32',
                execPath: opts.execPath === undefined ? 'D:\\NOVAI\\NOVAI.exe' : opts.execPath,
            },
            app: opts.app === undefined ? { isPackaged: true } : opts.app,
            fs: opts.fs || { accessSync() {}, constants: { W_OK: 2 } },
            spawnSync: (cmd, args, spawnOpts) => {
                calls.push([cmd].concat(args));
                timeouts.push(spawnOpts && spawnOpts.timeout);
                if (opts.spawnThrows) throw new Error('spawnSync reg ENOENT');
                if (responses.length) return responses.shift();
                return { status: 1, stdout: '', stderr: '' };
            },
            clog: (area, msg) => logs.push('[' + area + '] ' + msg),
        };
        const api = vm.runInNewContext(
            [keyConstSrc, installDirSrc, syncSrc, '({ run: syncInstallLocationRegistry, key: NSIS_INSTALL_REGISTRY_KEY })'].join('\n'),
            sandbox,
        );
        return { run: api.run, key: api.key, calls, timeouts, logs };
    }

    const fresh = loadSyncRegistry({
        responses: [{ status: 1, stdout: '' }, { status: 1, stdout: '' }, { status: 0, stdout: 'SUCCESS: The specified value was written.' }],
    });
    const freshResult = fresh.run();
    ok(freshResult === true, 'HKLM/HKCU 都没登记：写入成功返回 true');
    ok(fresh.calls.length === 3, '依次执行 HKLM 查询 → HKCU 查询 → reg add');
    ok(fresh.calls[0][0] === 'reg' && fresh.calls[0][1] === 'query' && fresh.calls[0][2] === 'HKLM\\' + constValue, '先查 HKLM 的 InstallLocation');
    ok(fresh.calls[1][0] === 'reg' && fresh.calls[1][1] === 'query' && fresh.calls[1][2] === 'HKCU\\' + constValue, '再查 HKCU 的同一个值');
    const addCall = fresh.calls[2] || [];
    ok(addCall[1] === 'add' && addCall[2] === 'HKCU\\' + constValue, 'reg add 写 HKCU 同一个键');
    ok(addCall.indexOf('/d') >= 0 && addCall[addCall.indexOf('/d') + 1] === 'D:\\NOVAI' && addCall.indexOf('/f') >= 0, 'add 参数带当前程序目录 D:\\NOVAI 与 /f');
    ok(fresh.logs.some((m) => m.indexOf('安装位置登记已校正') >= 0 && m.indexOf('D:\\NOVAI') >= 0), '写入成功写日志');
    ok(fresh.timeouts.length === 3 && fresh.timeouts.every((t) => t === 5000), '每个 reg 调用都带 timeout: 5000');

    const allUsers = loadSyncRegistry({
        responses: [{ status: 0, stdout: 'HKEY_LOCAL_MACHINE\\Software\\guid\r\n    InstallLocation    REG_SZ    C:\\Program Files\\NOVAI' }],
    });
    ok(allUsers.run() === false, 'HKLM 已登记（所有用户安装）返回 false');
    ok(allUsers.calls.length === 1 && !allUsers.calls.some((c) => c[1] === 'add'), '所有用户安装不动 HKCU：没有 reg add');

    const macSync = loadSyncRegistry({ platform: 'darwin', path: path.posix, execPath: '/Applications/NOVAI.app/Contents/MacOS/NOVAI' });
    ok(macSync.run() === false && macSync.calls.length === 0, 'platform=darwin 一次 spawnSync 都没有');

    const readOnlySync = loadSyncRegistry({ fs: { accessSync() { throw new Error('EACCES'); }, constants: { W_OK: 2 } } });
    ok(readOnlySync.run() === false && readOnlySync.calls.length === 0, '安装目录不可写：一次 spawnSync 都没有');

    const already = loadSyncRegistry({
        responses: [{ status: 1 }, { status: 0, stdout: 'HKEY_CURRENT_USER\\... InstallLocation REG_SZ D:\\NOVAI' }],
    });
    ok(already.run() === true, 'HKCU 已登记成同一个目录：返回 true');
    ok(already.calls.length === 2 && !already.calls.some((c) => c[1] === 'add'), 'HKCU 一致时不重复写注册表');

    const alreadyLoose = loadSyncRegistry({
        responses: [{ status: 1 }, { status: 0, stdout: 'InstallLocation REG_SZ "d:\\novai\\\\"' }],
    });
    ok(alreadyLoose.run() === true && alreadyLoose.calls.length === 2, '大小写 / 引号 / 结尾反斜杠不同也判定已登记（不重复写）');

    const addFailed = loadSyncRegistry({
        responses: [{ status: 1 }, { status: 1 }, { status: 1, stdout: '', stderr: '拒绝访问。' }],
    });
    let addThrew = false;
    let addResult = null;
    try { addResult = addFailed.run(); } catch (_) { addThrew = true; }
    ok(!addThrew && addResult === false, 'reg add 返回 status 1：函数返回 false，不抛');
    ok(addFailed.logs.some((m) => m.indexOf('安装位置登记写入失败（不影响使用）') >= 0 && m.indexOf('拒绝访问') >= 0), '写入失败写日志（含简短原因）');

    const devSync = loadSyncRegistry({ app: { isPackaged: false } });
    ok(devSync.run() === false && devSync.calls.length === 0, '开发态（未打包）一次 spawnSync 都没有');

    const noReg = loadSyncRegistry({ spawnThrows: true });
    let noRegThrew = false;
    let noRegResult = null;
    try { noRegResult = noReg.run(); } catch (_) { noRegThrew = true; }
    ok(!noRegThrew && noRegResult === false, 'reg 不存在 / 被杀软拦（spawnSync 抛错）：不抛，返回 false');

    const readyAt = main.indexOf('app.whenReady().then(async () => {');
    const dataDirAt = main.indexOf('dataDir = resolveDataDir();', readyAt);
    const syncLine = /^ {4}syncInstallLocationRegistry\(\);$/m.exec(main);
    ok(readyAt >= 0 && dataDirAt > readyAt && !!syncLine && syncLine.index > dataDirAt, 'whenReady 引导里在 dataDir = resolveDataDir() 之后调用 syncInstallLocationRegistry()');
    ok(!/await\s+syncInstallLocationRegistry/.test(main), '调用不 await（启动不被注册表查询拖住）');
    ok(!!syncLine && syncLine.index < main.indexOf('createSplashWindow(boot)', readyAt), '启动动画之前就完成校正（不阻塞窗口）');

    console.log('');
    const skipNote = skips.length ? '，跳过 ' + skips.length + ' 处（' + skips.join('；') + '）' : '';
    if (fails.length) {
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach((f) => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项' + skipNote);
        process.exit(1);
    }
    console.log('全部通过（' + pass + ' 项' + skipNote + '）');
})().catch((err) => {
    console.error('测试异常：', err && err.stack || err);
    process.exit(1);
});
