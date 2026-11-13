#!/usr/bin/env node
/* Electron 桌面壳的数据目录：必须读「设置 → 存储位置」写下的稳定配置，
   否则安装版用户改完存储位置，重启又被塞回旧的 NOVAI_DATA_DIR（Bug4 的根因之一）。
   D1. stableConfigFile：Windows = %APPDATA%\\NOVAI\\config.json；mac/Linux = ~/.NOVAI/config.json；NOVAI_CONFIG_DIR 可覆盖（验收隔离用）；
   D2. readConfiguredDataDir：读 data_root、展开 ~、目录不在时返回空串并打日志（磁盘没插也不能挡住启动）；
   D3. resolveDataDir：NOVAI_DATA_DIR 显式注入仍然最优先 → 然后是配置 → 再是默认目录；
   D4. main.js 里 resolveDataDir 真的调用了 readConfiguredDataDir（防止函数写了却没接线）；
   D6. 默认数据根判定（与 main.py default_data_root() / launcher.py 同口径）：新装且安装目录可写 →
       安装目录；用户目录已有数据（老用户）、只读安装目录（Program Files / AppImage / deb 的
       /opt）、macOS → 用户目录；
   D7. 首次判定写进稳定配置并记 data_root_origin，已有 data_root 一律不覆盖；
   D8. launcher.py 有同一套判定，并把安装目录（NOVAI_INSTALL_DIR）传给后端；main.js 只给 Win/Linux 传；
   D5. launcher.py（pywebview 正式版）读同一份稳定配置，且目录规则与 main.py stable_config_dir() 一致：
       NOVAI_CONFIG_DIR → Windows %APPDATA%/NOVAI → 其它 ~/.NOVAI；绝不能拿 data_dir 拼
       （mac 默认数据目录是 ~/NOVAI，稳定配置却是 ~/.NOVAI，拼错就永远读不到用户设置）。
   跑法：node tests/test_desktop_data_dir_config.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

function topLevelFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex((line) => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if (start < 0) return '';
    let depth = 0;
    for (let i = start; i < lines.length; i += 1) {
        const opens = (lines[i].match(/{/g) || []).length;
        const closes = (lines[i].match(/}/g) || []).length;
        depth += opens - closes;
        if (i > start && depth === 0) return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

const fnNames = ['stableConfigFile', 'readConfiguredDataDir', 'userDataRoot', 'dirWritable', 'pathWithin',
    'installDirReadonly', 'userRootHasData', 'decideDefaultDataDir', 'persistDataRoot', 'resolveDataDir'];
const fnSources = fnNames.map((name) => {
    const src = topLevelFunction(mainSrc, name);
    ok(!!src, 'main.js 里有 ' + name);
    return src;
}).join('\n\n');

function loadApi(opts) {
    const options = opts || {};
    const logs = [];
    const files = Object.assign({}, options.files || {});
    const dirs = options.dirs || [];
    const notWritable = options.notWritable || [];
    const readdir = options.readdir || {};
    const exists = (p) => files[p] !== undefined || dirs.indexOf(p) >= 0;
    const sandbox = {
        path: options.pathModule || path,
        __dirname: options.dirname || path.join(root, 'desktop'),
        fs: {
            existsSync: exists,
            readFileSync: (p) => { if (files[p] === undefined) throw new Error('ENOENT ' + p); return files[p]; },
            writeFileSync: (p, data) => {
                if (notWritable.some((dir) => String(p).indexOf(dir) === 0)) throw new Error('EACCES ' + p);
                files[p] = String(data);
            },
            unlinkSync: (p) => { delete files[p]; },
            renameSync: (from, to) => {
                if (files[from] !== undefined) { files[to] = files[from]; delete files[from]; }
            },
            mkdirSync: () => {},
            readdirSync: (p) => readdir[p] || [],
        },
        process: {
            env: options.env || {},
            platform: options.platform || 'darwin',
            resourcesPath: '/app/Resources',
            execPath: options.execPath,
        },
        require: (name) => {
            if (name === 'os') return { homedir: () => options.homedir || '/Users/tester' };
            if (name === 'net') return {};
            throw new Error('unexpected require ' + name);
        },
        app: { isPackaged: options.packaged !== false, getPath: () => '/Users/tester/Library/Application Support' },
        clog: (area, msg) => logs.push(area + ': ' + msg),
        console: { log: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSources, sandbox);
    sandbox.__logs = logs;
    sandbox.__files = files;
    return sandbox;
}

const POSIX = path;
const WIN = path.win32;
const macConfig = POSIX.join('/Users/tester', '.NOVAI', 'config.json');
const winConfig = WIN.join('C:\\Users\\tester\\AppData\\Roaming', 'NOVAI', 'config.json');
const macDefault = POSIX.join('/Users/tester', 'NOVAI');
const winDefault = WIN.join('C:\\Users\\tester\\AppData\\Roaming', 'NOVAI');

console.log('[1] stableConfigFile：mac / windows / NOVAI_CONFIG_DIR');
let api = loadApi({});
ok(api.stableConfigFile() === macConfig, 'mac 稳定配置路径 = ~/.NOVAI/config.json，实际 ' + api.stableConfigFile());
api = loadApi({ platform: 'win32', pathModule: WIN, env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' } });
ok(api.stableConfigFile() === winConfig, 'windows 稳定配置路径 = %APPDATA%\\NOVAI\\config.json，实际 ' + api.stableConfigFile());
api = loadApi({ platform: 'win32', pathModule: WIN, env: { NOVAI_CONFIG_DIR: 'D:\\tmp\\cfg' } });
ok(api.stableConfigFile() === WIN.join('D:\\tmp\\cfg', 'config.json'), 'NOVAI_CONFIG_DIR 覆盖生效，实际 ' + api.stableConfigFile());

console.log('[2] readConfiguredDataDir：正常 / ~ 展开 / 目录不在 / 坏 JSON');
api = loadApi({ files: { [macConfig]: JSON.stringify({ data_root: '/Volumes/Data/NOVAI' }) }, dirs: ['/Volumes/Data/NOVAI'] });
ok(api.readConfiguredDataDir() === '/Volumes/Data/NOVAI', '读到设置的新位置');
api = loadApi({ files: { [macConfig]: JSON.stringify({ data_root: '~/NOVAI2' }) }, dirs: ['/Users/tester/NOVAI2'] });
ok(api.readConfiguredDataDir() === '/Users/tester/NOVAI2', '~ 展开为 home，实际 ' + api.readConfiguredDataDir());
api = loadApi({ files: { [macConfig]: JSON.stringify({ data_root: '/Volumes/Gone/NOVAI' }) } });
ok(api.readConfiguredDataDir() === '', '目录不在时返回空串（回落默认，不挡启动）');
ok(api.__logs.some((line) => line.indexOf('存储位置配置不可用') >= 0), '目录不在时打了日志');
api = loadApi({ files: { [macConfig]: '{ not json' } });
ok(api.readConfiguredDataDir() === '', '坏 JSON 返回空串');
ok(api.__logs.some((line) => line.indexOf('读取存储位置配置失败') >= 0), '坏 JSON 打了日志');
api = loadApi({});
ok(api.readConfiguredDataDir() === '', '没有配置文件返回空串');

console.log('[3] resolveDataDir：env > 配置 > 默认');
api = loadApi({ env: { NOVAI_DATA_DIR: '/tmp/novai-explicit' } });
ok(api.resolveDataDir() === '/tmp/novai-explicit', 'NOVAI_DATA_DIR 显式注入仍然最优先');
api = loadApi({ files: { [macConfig]: JSON.stringify({ data_root: '/Volumes/Data/NOVAI' }) }, dirs: ['/Volumes/Data/NOVAI'] });
ok(api.resolveDataDir() === '/Volumes/Data/NOVAI', '打包版读配置里的新位置，而不是默认目录 ' + api.resolveDataDir());
api = loadApi({});
ok(api.resolveDataDir() === macDefault, '没有配置时回落 ~/NOVAI，实际 ' + api.resolveDataDir());
api = loadApi({ packaged: false, dirname: '/repo/desktop' });
ok(api.resolveDataDir() === POSIX.join('/repo/desktop', '..', 'data'), '未打包（源码）仍是仓库 data 目录，实际 ' + api.resolveDataDir());
api = loadApi({
    platform: 'win32', pathModule: WIN, env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    files: { [winConfig]: JSON.stringify({ data_root: 'D:\\NOVAI' }) }, dirs: ['D:\\NOVAI'],
});
ok(api.resolveDataDir() === 'D:\\NOVAI', 'Windows 打包版读配置里的 D:\\NOVAI，实际 ' + api.resolveDataDir());

console.log('[4] resolveDataDir 真的接线了 readConfiguredDataDir');
const resolveSrc = topLevelFunction(mainSrc, 'resolveDataDir');
ok(/readConfiguredDataDir\(/.test(resolveSrc), 'resolveDataDir 调用了 readConfiguredDataDir');
const envIndex = resolveSrc.indexOf('process.env.NOVAI_DATA_DIR');
const cfgIndex = resolveSrc.indexOf('readConfiguredDataDir(');
ok(envIndex >= 0 && cfgIndex > envIndex, '显式环境变量判断在配置读取之前');

console.log('[5] launcher.py：稳定配置目录与 main.py 一致（不再用 data_dir 拼）');
const launcherSrc = fs.readFileSync(path.join(root, 'launcher.py'), 'utf8');
const launcherAt = launcherSrc.indexOf('NOVAI_CONFIG_DIR');
ok(launcherAt > 0, 'launcher.py 里读了稳定配置');
const launcherBlock = launcherSrc.slice(launcherAt, launcherAt + 1400);
ok(/os\.name\s*==\s*["']nt["']/.test(launcherBlock), 'launcher 按平台分支（os.name == "nt"）');
ok(/APPDATA/.test(launcherBlock), 'launcher Windows 分支用 %APPDATA%');
ok(launcherBlock.indexOf('~/.NOVAI') >= 0, 'launcher 非 Windows 分支用 ~/.NOVAI');
ok(/config_file\s*=\s*os\.path\.join\(config_dir,\s*["']config\.json["']\)/.test(launcherBlock), 'launcher 用 config_dir 拼 config.json');
ok(!/NOVAI_CONFIG_DIR["']?\)?\s*or\s*data_dir/.test(launcherBlock), 'launcher 不再用 data_dir 兜底拼配置目录');
const mainSrcForCfg = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
const stableAt = mainSrcForCfg.indexOf('def stable_config_dir');
ok(stableAt > 0, 'main.py 有 stable_config_dir()');
const stableBlock = mainSrcForCfg.slice(stableAt, stableAt + 800);
ok(/expanduser\(\s*["']~\.NOVAI["']\s*\)|~\/\.NOVAI/.test(stableBlock), 'main.py 非 Windows 用 ~/.NOVAI');
ok(/APPDATA/.test(stableBlock), 'main.py Windows 用 %APPDATA%');
ok(/NOVAI_CONFIG_DIR/.test(stableBlock), 'main.py 与 launcher 都认 NOVAI_CONFIG_DIR 覆盖');

console.log('[6] Electron 默认数据根：新装可写 → 安装目录；老数据 / 只读 / macOS → 用户目录');
const winHome = 'C:\\Users\\tester';
const winInstall = 'C:\\Users\\tester\\AppData\\Local\\Programs\\NOVAI';
const winUserRoot = WIN.join('C:\\Users\\tester\\AppData\\Roaming', 'NOVAI');
const winProgramFiles = 'C:\\Program Files\\NOVAI';
const winEnv = { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' };

function winApi(extra) {
    return loadApi(Object.assign({
        platform: 'win32', pathModule: WIN, env: Object.assign({}, winEnv), homedir: winHome,
        execPath: WIN.join(winInstall, 'NOVAI.exe'), dirs: [winInstall],
    }, extra || {}));
}

let decided = winApi().decideDefaultDataDir();
ok(decided.dir === winInstall && decided.origin === 'install',
    'win 新装 + 安装目录可写 → 安装目录，实际 ' + JSON.stringify(decided));

api = winApi({ dirs: [winInstall, winUserRoot, WIN.join(winUserRoot, 'data', 'canvases')], files: { [WIN.join(winUserRoot, 'data', 'users.db')]: 'db' } });
decided = api.decideDefaultDataDir();
ok(decided.dir === winUserRoot, 'win 用户目录已有 users.db → 用户目录（老用户不切），实际 ' + decided.dir);

api = winApi({ dirs: [winInstall, winUserRoot, WIN.join(winUserRoot, 'assets')], readdir: { [WIN.join(winUserRoot, 'assets')]: ['a.png'] } });
ok(api.decideDefaultDataDir().dir === winUserRoot, 'win 用户目录 assets 非空 → 用户目录');

api = winApi({ env: Object.assign({}, winEnv, { PROGRAMFILES: 'C:\\Program Files' }), execPath: WIN.join(winProgramFiles, 'NOVAI.exe'), dirs: [winProgramFiles], notWritable: ['C:\\Program Files'] });
ok(api.installDirReadonly(winProgramFiles), 'Program Files 被判为不可写安装目录');
ok(api.decideDefaultDataDir().dir === winUserRoot, 'Program Files 安装 → 用户目录');

api = winApi({ env: Object.assign({}, winEnv, { NOVAI_INSTALL_DIR: winInstall }) });
ok(api.decideDefaultDataDir().dir === winInstall, '显式 NOVAI_INSTALL_DIR 参与判定（不再只看 execPath）');

const linuxHome = '/home/tester';
function linuxApi(extra) {
    return loadApi(Object.assign({
        platform: 'linux', homedir: linuxHome, env: {}, execPath: '/tmp/.mount_NOVAI0/novai',
        dirs: ['/tmp/.mount_NOVAI0'],
    }, extra || {}));
}
ok(linuxApi({ dirs: ['/tmp/.mount_NOVAI0', '/home/tester/NOVAI/data/canvases'], files: { '/home/tester/NOVAI/data/users.db': 'db' }, env: { APPIMAGE: '/home/tester/NOVAI.AppImage' } }).decideDefaultDataDir().dir === '/home/tester/NOVAI',
    'AppImage（只读挂载）→ 用户目录');

const linuxPortable = '/home/tester/Apps/NOVAI';
ok(linuxApi({ execPath: linuxPortable + '/novai', dirs: [linuxPortable] }).decideDefaultDataDir().dir === linuxPortable,
    'Linux 解压/便携安装 + 可写 → 安装目录');
ok(linuxApi({ execPath: '/opt/NOVAI/novai', dirs: ['/opt/NOVAI'] }).decideDefaultDataDir().dir === '/home/tester/NOVAI',
    'deb 装到 /opt → 用户目录');
ok(linuxApi({ execPath: '/usr/lib/novai/novai', dirs: ['/usr/lib/novai'] }).decideDefaultDataDir().dir === '/home/tester/NOVAI',
    'deb 装到 /usr → 用户目录');

const macInstall = '/Applications/NOVAI.app/Contents/MacOS/NOVAI';
api = loadApi({ platform: 'darwin', homedir: '/Users/tester', execPath: macInstall, dirs: ['/Applications/NOVAI.app/Contents/MacOS'] });
ok(api.decideDefaultDataDir().dir === '/Users/tester/NOVAI', 'macOS .app 包内可写也必须用 ~/NOVAI');
ok(api.resolveDataDir() === '/Users/tester/NOVAI', 'macOS 打包版数据根仍是 ~/NOVAI，实际 ' + api.resolveDataDir());

console.log('[7] 首次判定写进稳定配置并记来源，已有 data_root 不覆盖');
api = winApi();
ok(api.resolveDataDir() === winInstall, 'win 新装 resolveDataDir 返回安装目录');
let written = api.__files[winConfig];
ok(!!written, '首次判定写进了 ' + winConfig);
let writtenCfg = {};
try { writtenCfg = JSON.parse(written || '{}'); } catch (_) {}
ok(writtenCfg.data_root === winInstall && writtenCfg.data_root_origin === 'install',
    '配置里记下 data_root + data_root_origin，实际 ' + JSON.stringify(writtenCfg));

api = winApi({ dirs: [winInstall, winUserRoot], files: { [winConfig]: JSON.stringify({ lan_token: 'abc' }), [WIN.join(winUserRoot, 'data', 'users.db')]: 'db' } });
ok(api.resolveDataDir() === winUserRoot, '老用户 resolveDataDir 用用户目录');
ok(!/data_root/.test(api.__files[winConfig] || ''), '老用户不写 data_root（否则挡掉「迁到安装目录」提示）');
ok(/lan_token/.test(api.__files[winConfig] || ''), '写配置时不动其它键');

api = loadApi({
    platform: 'win32', pathModule: WIN, env: winEnv, homedir: winHome, execPath: WIN.join(winInstall, 'NOVAI.exe'),
    files: { [winConfig]: JSON.stringify({ data_root: 'D:\\NOVAI' }) }, dirs: ['D:\\NOVAI'],
});
ok(api.resolveDataDir() === 'D:\\NOVAI', '配置里的 data_root 优先于默认判定');

console.log('[8] launcher.py 同口径 + main.js 只给 Win/Linux 传安装目录');
ok(/def default_data_root\(install_dir/.test(launcherSrc), 'launcher 有 default_data_root(install_dir)');
ok(/sys\.platform == "darwin"/.test(launcherSrc), 'launcher 对 macOS 单独判定（固定用户目录）');
ok(/APPIMAGE/.test(launcherSrc), 'launcher 认 AppImage（只读挂载）');
ok(/PROGRAMFILES/.test(launcherSrc), 'launcher 认 Windows Program Files');
ok(/data_root_origin/.test(launcherSrc), 'launcher 记录数据根来源');
ok(/os\.environ\.setdefault\("NOVAI_INSTALL_DIR", app_dir\)/.test(launcherSrc), 'launcher 把安装目录传给后端');
const installEnvAt = mainSrc.indexOf('NOVAI_INSTALL_DIR = path.dirname(process.execPath)');
ok(installEnvAt > 0, 'main.js 把安装根目录传给后端');
const installEnvBlock = mainSrc.slice(Math.max(0, installEnvAt - 420), installEnvAt + 100);
ok(/process\.platform !== 'darwin'/.test(installEnvBlock), 'main.js 只给 Win/Linux 传（macOS 排除）');
ok(/app\.isPackaged/.test(installEnvBlock), '仅打包态注入安装根目录');

console.log('');
if (fails.length) {
    console.error('FAIL：' + fails.length + ' 项');
    fails.forEach((item) => console.error('  - ' + item));
    process.exit(1);
}
console.log('PASS：' + pass + ' 项全部通过');
