#!/usr/bin/env node
/* macOS 自替换更新器回归（纯 node，不启动 Electron）：
   E1. latest-mac.yml 解析：拿到 arm64 zip 的 url / sha512；
   E2. sha512 校验：正确通过、错误拒绝；
   E3. install.sh 内容：等 PID、备份、ditto、xattr、codesign、open、回滚；
   E4. 真跑安装脚本：假 .app + sleep 进程模拟 PID，断言替换成功且旧目录被清理；
   E5. 真跑回滚：新版本不存在时 ditto 失败，旧版本必须还在；
   E6. 主进程 / preload / update.js 的接线（darwin 分支、进度事件、测试钩子）。
   跑法：node tests/test_desktop_mac_updater.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const mac = require(path.join(root, 'desktop/mac-updater.js'));

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

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

function makeFakeApp(dir, version, marker) {
    writeInfoPlist(dir, version);
    fs.writeFileSync(path.join(dir, 'Contents', marker), marker, 'utf8');
    return dir;
}

const workDirs = [];
function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    workDirs.push(dir);
    return dir;
}

function makeStubBin(dir) {
    fs.mkdirSync(dir, { recursive: true });
    ['open', 'codesign'].forEach((name) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, '#!/bin/sh\nprintf "[stub] ' + name + ' %s\\n" "$*" >> "' + path.join(dir, 'stub.log') + '"\nexit 0\n', 'utf8');
        fs.chmodSync(file, 0o755);
    });
    return dir;
}

const SAMPLE_YML = [
    'version: 2.0.3',
    'files:',
    '  - url: NOVAI-2.0.3-x64-mac.zip',
    '    sha512: x64SHA==',
    '    size: 111',
    '  - url: NOVAI-2.0.3-arm64-mac.zip',
    '    sha512: arm64SHA==',
    '    size: 222',
    'path: NOVAI-2.0.3-arm64-mac.zip',
    'sha512: arm64SHA==',
    "releaseDate: '2026-11-07T13:10:06.877Z'",
    '',
].join('\n');

console.log('[1] latest-mac.yml 解析');
const parsed = mac.parseLatestMacYml(SAMPLE_YML);
ok(parsed.version === '2.0.3', '解析 version');
ok(Array.isArray(parsed.files) && parsed.files.length === 2, '解析 files 两条');
const armZip = mac.pickMacZipFile(parsed.files);
ok(armZip && armZip.url === 'NOVAI-2.0.3-arm64-mac.zip', '优先取 arm64 zip');
ok(armZip && armZip.sha512 === 'arm64SHA==', 'arm64 zip 带 sha512');
ok(parsed.path === 'NOVAI-2.0.3-arm64-mac.zip' && parsed.sha512 === 'arm64SHA==', '解析顶层 path/sha512');
const absUrl = mac.resolveMacZipUrl('https://example.com/a/NOVAI-2.0.3-arm64-mac.zip', '2.0.3');
ok(absUrl === 'https://example.com/a/NOVAI-2.0.3-arm64-mac.zip', '绝对 https 地址原样使用');
const relUrl = mac.resolveMacZipUrl('NOVAI-2.0.3-arm64-mac.zip', '2.0.3');
ok(relUrl === 'https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases/download/v2.0.3/NOVAI-2.0.3-arm64-mac.zip', '相对地址拼到 Release 下载目录');
const tagUrl = mac.resolveMacZipUrl('NOVAI-2.0.3-arm64-mac.zip', '2.0.3', 'v2.0.03');
ok(tagUrl === 'https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases/download/v2.0.03/NOVAI-2.0.3-arm64-mac.zip', '带真实 tag 时优先用 tag（v2.0.03），不拼 yml 里的 2.0.3');
const tagNoV = mac.resolveMacZipUrl('NOVAI-2.0.3-arm64-mac.zip', '2.0.3', '2.0.03');
ok(tagNoV === tagUrl, 'tag 不带 v 时自动补 v');
const tagEmpty = mac.resolveMacZipUrl('NOVAI-2.0.3-arm64-mac.zip', '2.0.3', '');
ok(tagEmpty === 'https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases/download/v2.0.3/NOVAI-2.0.3-arm64-mac.zip', 'tag 为空回退旧行为（v<version>）');
ok(mac.releaseTagFromVersion('2.0.3') === 'v2.0.03' && mac.releaseTagFromVersion('1.0.143') === 'v1.0.143', '兜底 tag 按展示版本补零（2.0.3 → v2.0.03）');
let httpRejected = false;
try { mac.resolveMacZipUrl('http://example.com/a.zip', '2.0.3'); } catch (_) { httpRejected = true; }
ok(httpRejected, '拒绝非 https 地址');
ok(mac.appBundleFromExe('/Applications/NOVAI.app/Contents/MacOS/NOVAI') === '/Applications/NOVAI.app', '从 exe 反推 .app');
ok(mac.appBundleFromExe('/usr/local/bin/NOVAI') === '', '非 .app 内运行返回空串');
ok(mac.versionFromZipName('/x/NOVAI-2.0.3-arm64-mac.zip') === '2.0.3', '从 zip 名解析版本');
ok(mac.versionFromZipName('/x/NOVAI-2.0.3-beta.1-arm64-mac.zip') === '2.0.3-beta.1', '预发布版本也解析正确');

console.log('[2] sha512 校验');
const hashDir = tmpDir('novai-sha512-');
const hashFile = path.join(hashDir, 'payload.bin');
fs.writeFileSync(hashFile, Buffer.from('novai-self-update-fixture'));
const goodSha = crypto.createHash('sha512').update(fs.readFileSync(hashFile)).digest('base64');
(async () => {
    ok(await mac.verifySha512(hashFile, goodSha), '正确的 sha512 通过');
    ok(!(await mac.verifySha512(hashFile, 'AAAA' + goodSha.slice(4))), '错误的 sha512 被拒绝');
    ok(!(await mac.verifySha512(path.join(hashDir, 'missing.bin'), goodSha)), '文件不存在时拒绝');

    console.log('[3] install.sh 内容');
    const scriptDir = tmpDir('novai-script-');
    const script = mac.buildInstallScript({
        pid: 4321,
        targetApp: path.join(scriptDir, 'NOVAI.app'),
        newApp: path.join(scriptDir, 'new', 'NOVAI.app'),
        tmpDir: scriptDir,
        logPath: path.join(scriptDir, 'install.log'),
        waitSeconds: 2,
    });
    ok(script.startsWith('#!/bin/sh'), '脚本带 shebang');
    ok(/WAIT_ATTEMPTS=4/.test(script), '等待超时按秒数换算成 0.5s 次数');
    ok(/while kill -0 "\$PID" 2>\/dev\/null; do/.test(script), '等待进程退出（kill -0 PID）');
    ok(/mv "\$TARGET" "\$BACKUP"/.test(script), 'mv 备份旧版本');
    ok(/ditto "\$NEW_APP" "\$TARGET"/.test(script), 'ditto 复制新版本');
    ok(/xattr -dr com\.apple\.quarantine "\$TARGET"/.test(script), '清 quarantine');
    ok(/codesign --force --deep --sign - "\$TARGET"/.test(script), 'ad-hoc 重签');
    ok(/open "\$TARGET"/.test(script), '重新打开');
    ok(/mv "\$BACKUP" "\$TARGET"/.test(script), 'ditto 失败时回滚分支');
    ok(/rm -rf "\$BACKUP"/.test(script) && /rm -rf "\$TMP_DIR"/.test(script), '成功后清理备份与解压目录');
    ok(!/^TARGET=\$/m.test(script), '路径变量用 shell 引号包裹');

    console.log('[4] 真跑安装脚本：替换 + 清理');
    const runDir = tmpDir('novai-run-');
    const targetApp = makeFakeApp(path.join(runDir, 'target', 'NOVAI.app'), '2.0.2', 'old-marker');
    const newApp = makeFakeApp(path.join(runDir, 'staging', 'NOVAI.app'), '2.0.3', 'new-marker');
    const extractDir = tmpDir('novai-extract-');
    const runLog = path.join(runDir, 'install.log');
    const sleepProc = spawn('sleep', ['30'], { stdio: 'ignore' });
    let runOk = true;
    try {
        const runScript = mac.buildInstallScript({
            pid: sleepProc.pid,
            targetApp,
            newApp,
            tmpDir: extractDir,
            logPath: runLog,
            waitSeconds: 2,
        });
        const scriptPath = path.join(runDir, 'install.sh');
        fs.writeFileSync(scriptPath, runScript, { encoding: 'utf8', mode: 0o755 });
        const stubBin = makeStubBin(path.join(runDir, 'bin'));
        const startedAt = Date.now();
        execFileSync('/bin/sh', [scriptPath], {
            timeout: 30000,
            stdio: 'ignore',
            env: Object.assign({}, process.env, { PATH: stubBin + ':' + process.env.PATH }),
        });
        const elapsed = Date.now() - startedAt;
        ok(fs.existsSync(path.join(targetApp, 'Contents', 'new-marker')), '目标 .app 已替换成新版本');
        ok(!fs.existsSync(path.join(targetApp, 'Contents', 'old-marker')), '旧版本文件已被覆盖');
        ok(!fs.existsSync(targetApp + '.old-' + sleepProc.pid), '旧版本备份目录已清理');
        ok(!fs.existsSync(extractDir), '解压目录已清理');
        ok(elapsed >= 1500, '脚本确实等过进程（超时分支生效）');
        const runLogText = fs.readFileSync(runLog, 'utf8');
        ok(runLogText.includes('install done'), 'install.log 记录安装完成');
    } catch (err) {
        runOk = false;
        console.error('  替换脚本执行失败：', err && err.message);
    } finally {
        try { sleepProc.kill('SIGKILL'); } catch (_) {}
    }
    ok(runOk, '安装脚本正常退出');

    console.log('[5] 真跑安装脚本：ditto 失败自动回滚');
    const rollbackDir = tmpDir('novai-rollback-');
    const rollbackTarget = makeFakeApp(path.join(rollbackDir, 'target', 'NOVAI.app'), '2.0.2', 'keep-marker');
    const missingNewApp = path.join(rollbackDir, 'staging', 'NOVAI.app');
    const rollbackLog = path.join(rollbackDir, 'install.log');
    const sleepProc2 = spawn('sleep', ['30'], { stdio: 'ignore' });
    let rollbackExit = 0;
    try {
        const rollbackScript = mac.buildInstallScript({
            pid: sleepProc2.pid,
            targetApp: rollbackTarget,
            newApp: missingNewApp,
            tmpDir: tmpDir('novai-rollback-extract-'),
            logPath: rollbackLog,
            waitSeconds: 1,
        });
        const rollbackScriptPath = path.join(rollbackDir, 'install.sh');
        fs.writeFileSync(rollbackScriptPath, rollbackScript, { encoding: 'utf8', mode: 0o755 });
        const stubBin = makeStubBin(path.join(rollbackDir, 'bin'));
        try {
            execFileSync('/bin/sh', [rollbackScriptPath], {
                timeout: 30000,
                stdio: 'ignore',
                env: Object.assign({}, process.env, { PATH: stubBin + ':' + process.env.PATH }),
            });
        } catch (err) {
            rollbackExit = err && typeof err.status === 'number' ? err.status : 1;
        }
        ok(rollbackExit !== 0, 'ditto 失败时脚本以非零退出');
        ok(fs.existsSync(path.join(rollbackTarget, 'Contents', 'keep-marker')), '回滚后旧版本内容还在');
        ok(!fs.existsSync(rollbackTarget + '.old-' + sleepProc2.pid), '回滚后备份目录已挪回（不再残留）');
        const rollbackLogText = fs.readFileSync(rollbackLog, 'utf8');
        ok(rollbackLogText.includes('回滚完成') || rollbackLogText.includes('回滚'), 'install.log 记录回滚');
    } finally {
        try { sleepProc2.kill('SIGKILL'); } catch (_) {}
    }

    console.log('[6] 主进程 / preload / update.js 接线');
    const main = read('desktop/main.js');
    const preload = read('desktop/preload.js');
    const updateJs = read('web/src/lib/update.js');
    ok(/const macUpdater = require\('\.\/mac-updater'\)/.test(main), '主进程 require mac-updater');
    ok(/autoUpdater\.on\('update-available'[\s\S]{0,400}showMacUpdateAvailablePrompt\(info\)/.test(main), 'update-available 在 darwin 走自替换确认框');
    ok(/message: '发现新版本 v' \+ next/.test(main) && /自动替换安装/.test(main), '确认框文案（下载并自动替换）');
    ok(/net\.request\(\{ url: url, method: 'GET', redirect: 'follow' \}\)/.test(main), '下载使用 Electron net（跟随 302）');
    ok(/createHash\('sha512'\)/.test(main) && /sha512 校验失败/.test(main), '下载同时校验 sha512');
    ok(/runCommand\('ditto', \['-x', '-k'/.test(main), 'ditto 解压');
    ok(/validateAppBundle\(newApp/.test(main), '解压后校验 .app（bundle id / 版本）');
    ok(/appBundleFromExe\(app\.getPath\('exe'\)\)/.test(main), '目标路径由 app.getPath(exe) 反推');
    ok(/buildInstallScript\(/.test(main) && /install\.sh/.test(main), '生成 install.sh');
    ok(/spawn\('\/bin\/sh', \[scriptPath\], \{ detached: true, stdio: 'ignore' \}\)/.test(main), '分离启动安装脚本');
    ok(/stopBackendForUpdate\(\)\.then\(\(\) => \{ app\.quit\(\); \}\)/.test(main), '先停后端再 app.quit（不用 app.exit）');
    ok(/NOVAI_UPDATE_ZIP/.test(main) && /NOVAI_UPDATE_TARGET/.test(main), '保留离线测试钩子（zip / target）');
    ok(/const updateTag = info && info\.tag/.test(main), '从 updateInfo.tag 取真实 Release tag');
    ok(/macUpdater\.resolveMacZipUrl\(zipFile\.url, githubVersion, updateTag\)/.test(main), '解析下载地址时把 tag 传进去');
    ok(/releaseTagFromVersion\(githubVersion\)/.test(main) && /altUrls\.push\(altUrl\)/.test(main), '非 2xx 时用补零 tag 再试一次');
    ok(/改用备用地址重试/.test(main) && /下载失败\(/.test(main), '两次尝试都写日志');
    ok(/novai:update-progress/.test(main) && /sendUpdateProgress/.test(main), '主进程发进度事件');
    ok(/onProgress: \(cb\) =>/.test(preload) && /novai:update-progress/.test(preload), 'preload 暴露 onProgress 订阅');
    ok(/desktop\.onProgress\(/.test(updateJs) && /upd\.progress = \{/.test(updateJs), 'update.js 把进度写进 upd.progress');
    ok(/installing: '正在替换安装'/.test(updateJs), '进度阶段文案包含替换安装');
    const pkg = JSON.parse(read('desktop/package.json'));
    ok(Array.isArray(pkg.build.files) && pkg.build.files.includes('mac-updater.js'), '打包 files 里包含 mac-updater.js');
    const ipcInstall = (main.match(/ipcMain\.handle\('novai:update-install'[\s\S]*?\n  \}\);/g) || [''])[0];
    ok(/process\.platform === 'darwin'\) \{/.test(ipcInstall) && /startMacSelfUpdate\(pendingUpdateInfo, true\)/.test(ipcInstall), 'renderer 点「立即更新」在 darwin 直接进入自替换');
    ok(/if \(process\.platform === 'darwin'\) return;[\s\S]{0,200}showUpdateInstallPrompt\(\);/.test(main), 'darwin 不再弹旧的「手动覆盖安装」对话框');

    console.log('[6] 镜像 latest-mac.yml 解析与「镜像失败回退 GitHub」');
    function mainFunction(name) {
        const lines = read('desktop/main.js').split('\n');
        const start = lines.findIndex((line) => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
        if (start < 0) return '';
        for (let i = start + 1; i < lines.length; i += 1) {
            if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
        }
        return '';
    }
    const mirrorBase = 'https://mirror.example/electron-release';
    const helperSrc = ['compareUpdateVersions', 'parseMirrorMacManifest', 'resolveMirrorAssetUrl', 'pickMirrorMacUpdate']
        .map(mainFunction)
        .join('\n');
    const helper = vm.runInNewContext(helperSrc + '\n;({ compareUpdateVersions, parseMirrorMacManifest, resolveMirrorAssetUrl, pickMirrorMacUpdate })', { macUpdater: mac });
    const mirrorYml = [
        'version: 2.0.5',
        'files:',
        '  - url: NOVAI-2.0.5-arm64-mac.zip',
        '    sha512: mirrorSHA==',
        '    size: 333',
        'path: NOVAI-2.0.5-arm64-mac.zip',
        'sha512: mirrorSHA==',
        "releaseDate: '2026-11-08T03:00:00.000Z'",
        '',
    ].join('\n');
    const mirrorCandidate = helper.pickMirrorMacUpdate(mirrorYml, '2.0.4', mirrorBase);
    ok(mirrorCandidate.ok === true && mirrorCandidate.version === '2.0.5', '镜像 manifest 解析出版本');
    ok(mirrorCandidate.url === mirrorBase + '/NOVAI-2.0.5-arm64-mac.zip', '镜像相对路径补成完整地址');
    ok(mirrorCandidate.sha512 === 'mirrorSHA==' && mirrorCandidate.size === 333, '带出 sha512 / size');
    ok(helper.pickMirrorMacUpdate(mirrorYml, '2.0.5', mirrorBase).ok === false, '版本相等时不走镜像');
    ok(helper.pickMirrorMacUpdate(mirrorYml, '2.0.6', mirrorBase).ok === false, '当前版本更新时不走镜像');
    ok(helper.pickMirrorMacUpdate('files:\n  - url: NOVAI-2.0.5-arm64-mac.zip\n', '2.0.4', mirrorBase).reason === 'manifest-without-version', '缺 version 明确失败');
    ok(helper.pickMirrorMacUpdate('version: 2.0.5\n', '2.0.4', mirrorBase).reason === 'manifest-without-zip', '缺 files/zip 明确失败');
    const noHash = helper.pickMirrorMacUpdate('version: 2.0.5\nfiles:\n  - url: NOVAI-2.0.5-arm64-mac.zip\n', '2.0.4', mirrorBase);
    ok(noHash.ok === true && noHash.sha512 === '' && noHash.size === 0, '缺 sha512 / size 仍可用');
    ok(helper.pickMirrorMacUpdate('version: 2.0.5\nfiles:\n  - url: https://cdn.example/NOVAI-2.0.5-arm64-mac.zip\n', '2.0.4', mirrorBase).url === 'https://cdn.example/NOVAI-2.0.5-arm64-mac.zip', '绝对 https 地址原样用');
    ok(helper.compareUpdateVersions('2.0.10', '2.0.9') === 1 && helper.compareUpdateVersions('2.0.5-beta.1', '2.0.5') === -1 && helper.compareUpdateVersions('2.0.5', '2.0.5') === 0, '版本比较');

    const fallbackLogs = [];
    const withSource = vm.runInNewContext(mainFunction('withMacUpdateSource') + '\nwithMacUpdateSource', {
        clog: (area, msg) => fallbackLogs.push(area + ':' + msg),
    });
    const mirrorOk = await withSource(async () => ({ ok: true, source: 'mirror', version: '2.0.5', zipPath: '/tmp/m.zip' }), async () => { throw new Error('不该走 GitHub'); });
    ok(mirrorOk.source === 'mirror' && mirrorOk.version === '2.0.5', '镜像可用时不回退 GitHub');
    let githubCalled = 0;
    const notNewer = await withSource(async () => ({ ok: false, reason: 'mirror-not-newer: 2.0.5 <= 2.0.5' }), async () => { githubCalled += 1; return { ok: true, version: '2.0.5', zipPath: '/tmp/g.zip' }; });
    ok(notNewer.source === 'github' && githubCalled === 1, '镜像版本不新时回退 GitHub');
    ok(fallbackLogs.some((m) => m.indexOf('回退 GitHub') >= 0), '回退 GitHub 写日志');
    let githubCalls = 0;
    const threw = await withSource(async () => { throw new Error('HTTP 404'); }, async () => { githubCalls += 1; return { ok: true, version: '2.0.5', zipPath: '/tmp/g.zip' }; });
    ok(threw.source === 'github' && githubCalls === 1, '镜像 manifest/下载抛错时回退 GitHub');
    let githubError = '';
    try {
        await withSource(async () => ({ ok: false, reason: 'manifest 404' }), async () => { throw new Error('GitHub reset'); });
    } catch (err) { githubError = err.message; }
    ok(githubError === 'GitHub reset', 'GitHub 也失败时把 GitHub 错误抛给上层（走原有失败提示）');

    const startFn = mainFunction('startMacSelfUpdate');
    ok(/withMacUpdateSource\(/.test(startFn), 'startMacSelfUpdate 先镜像后 GitHub');
    ok(/resolveMirrorMacUpdate\(app\.getVersion\(\)\)/.test(startFn), '镜像 manifest 用当前版本判断');
    ok(/source: 'mirror'/.test(startFn) && /source: 'github'/.test(startFn), '两个来源都传给 prepareMacZip');
    ok(/本次 macOS 更新源=/.test(startFn), '日志记录最终使用的更新源');
    const prepFn = mainFunction('prepareMacZip');
    ok(/downloadMacUpdateZip\(attemptUrls\[attempt\], zipPath, expectedSha, expectedSize\)/.test(prepFn), '镜像和 GitHub 复用 downloadMacUpdateZip');
    ok(/verifySha512\(zipPath, expectedSha\)/.test(prepFn) && /大小校验失败/.test(prepFn), '下载后校验 sha512 / size');
    ok(/MAC_MIRROR_MANIFEST_URL/.test(read('desktop/main.js')), '镜像 manifest 地址已定义');

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
}).finally(() => {
    workDirs.forEach((dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
});
