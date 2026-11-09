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
    ok(/process\.platform === 'win32'/.test(shutdownFn), 'shutdownBackend 区分 Windows');
    ok(/spawn\('taskkill', \['\/F', '\/T', '\/PID', String\(backendProc\.pid\)\]/.test(shutdownFn), 'Windows 退出按进程树结束（不留 PyInstaller 子进程）');
    const startFn = topLevelFunction(main, 'startBackend');
    ok(/backendPort = port;/.test(startFn), '启动后端时记录 backendPort');
    const reuseAt = main.indexOf('if (reuseExisting) {');
    ok(reuseAt >= 0 && /backendPort = port;/.test(main.slice(reuseAt, reuseAt + 200)), '复用外部后端时也记录 backendPort');

    console.log('[5] 静默安装 / 下载进度 / 打包配置');
    const promptFn = topLevelFunction(main, 'showUpdateInstallPrompt');
    ok(/autoUpdater\.quitAndInstall\(true, true\)/.test(promptFn), 'Windows 静默安装 quitAndInstall(true, true)');
    ok(/process\.platform === 'win32'/.test(promptFn), '只有 win32 走静默参数');
    ok(/autoUpdater\.quitAndInstall\(\);/.test(promptFn), 'macOS/其他平台保持 quitAndInstall()');
    const setupFn = topLevelFunction(main, 'setupAutoUpdate');
    const progressAt = setupFn.indexOf("autoUpdater.on('download-progress'");
    const downloadedAt = setupFn.indexOf("autoUpdater.on('update-downloaded'");
    const progressBlock = progressAt >= 0 && downloadedAt > progressAt ? setupFn.slice(progressAt, downloadedAt) : '';
    ok(/sendUpdateProgress\(\{/.test(progressBlock), 'download-progress 向界面发进度');
    ok(/percent: Math\.round\(info\.percent \|\| 0\)/.test(progressBlock), '转发 percent（四舍五入）');
    ok(/transferred: info\.transferred \|\| 0/.test(progressBlock) && /total: info\.total \|\| 0/.test(progressBlock), '转发 transferred / total');
    ok(/process\.platform === 'darwin'\) return;/.test(progressBlock), 'macOS 不重复发进度（自替换链路自己发）');
    const downloadedBlock = downloadedAt >= 0 ? setupFn.slice(downloadedAt, setupFn.indexOf("autoUpdater.on('error'", downloadedAt)) : '';
    ok(/stage: 'installing', percent: 100/.test(downloadedBlock), '下载完成发 installing 100');
    ok(/showUpdateInstallPrompt\(\)/.test(downloadedBlock), '非 macOS 仍弹安装确认');
    const pkg = JSON.parse(read('desktop/package.json'));
    ok(pkg.build.nsis.oneClick === true, 'NSIS 改成一键安装');
    ok(pkg.build.nsis.perMachine === false, 'NSIS 装到当前用户');
    ok(!('allowToChangeInstallationDirectory' in pkg.build.nsis), '去掉 allowToChangeInstallationDirectory');
    ok(pkg.build.nsis.createDesktopShortcut === true && pkg.build.nsis.shortcutName === 'NOVAI', '保留桌面快捷方式与名称');
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
    ok(/resumeDownloadAfterFeedSwitch/.test(setupSrc), '下载阶段失败会续下而不是让用户再点一次');

    console.log('');
    if (fails.length) {
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach((f) => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('全部通过（' + pass + ' 项）');
})().catch((err) => {
    console.error('测试异常：', err && err.stack || err);
    process.exit(1);
});
