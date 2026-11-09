#!/usr/bin/env node
/* Windows 安装包内置 ffmpeg 的定位/注入（纯 node，不启动 Electron）：
   B1. resolveBundledFfmpeg：只认 win32 + resources/bin/win/ffmpeg.exe，缺 ffprobe 时返回 null 字段；
   B2. applyBundledFfmpegEnv：win32 才写 FFMPEG_PATH/FFPROBE_PATH，显式设置的环境变量优先；
   B3. main.js 的 startBackend 真的调用了注入函数（防止函数写了却没接线）。
   跑法：node tests/test_desktop_bundled_ffmpeg.js */
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
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

const fnNames = ['resolveBundledFfmpeg', 'applyBundledFfmpegEnv'];
const fnSources = fnNames.map((name) => {
    const src = topLevelFunction(mainSrc, name);
    ok(!!src, 'main.js 里有 ' + name);
    return src;
}).join('\n\n');

// 用 win32 路径语义 + 可控的 fs/process 沙箱加载两个纯函数。
function loadApi(options) {
    const opts = options || {};
    const exists = opts.exists || (() => false);
    const sandbox = {
        path: path.win32,
        fs: { existsSync: exists },
        process: {
            platform: opts.platform || 'win32',
            resourcesPath: opts.resourcesPath === undefined ? 'C:\\NOVAI\\resources' : opts.resourcesPath,
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSources, sandbox);
    return sandbox;
}

const resources = 'C:\\NOVAI\\resources';
const binDir = path.win32.join(resources, 'bin', 'win');
const ffmpegPath = path.win32.join(binDir, 'ffmpeg.exe');
const ffprobePath = path.win32.join(binDir, 'ffprobe.exe');
const setOf = (items) => (p) => items.indexOf(p) >= 0;

console.log('[1] resolveBundledFfmpeg：只认 win32 的 resources/bin/win');
const both = loadApi({ exists: setOf([ffmpegPath, ffprobePath]) });
ok(both.resolveBundledFfmpeg('darwin', resources) === null, 'macOS 不解析内置 ffmpeg（保持系统 PATH 行为）');
ok(both.resolveBundledFfmpeg('linux', resources) === null, 'Linux 不解析内置 ffmpeg');
ok(both.resolveBundledFfmpeg('win32', '') === null, '没有 resourcesPath 时返回 null');
const fallbackByProcess = both.resolveBundledFfmpeg('win32', undefined);
ok(!!fallbackByProcess && fallbackByProcess.ffmpeg === ffmpegPath, 'resourcesPath 传 undefined 时按 process.resourcesPath 兜底');

const onlyFfmpeg = loadApi({ exists: setOf([ffmpegPath]) });
const onlyFfmpegResult = onlyFfmpeg.resolveBundledFfmpeg('win32', resources);
ok(!!onlyFfmpegResult && onlyFfmpegResult.ffmpeg === ffmpegPath, 'ffmpeg.exe 存在时返回其路径');
ok(!!onlyFfmpegResult && onlyFfmpegResult.ffprobe === null, 'ffprobe.exe 缺失时 ffprobe 字段为 null');

const withBoth = loadApi({ exists: setOf([ffmpegPath, ffprobePath]) }).resolveBundledFfmpeg('win32', resources);
ok(!!withBoth && withBoth.ffmpeg === ffmpegPath && withBoth.ffprobe === ffprobePath, '两个 exe 都在时都返回');

const missing = loadApi({ exists: () => false }).resolveBundledFfmpeg('win32', resources);
ok(missing === null, 'ffmpeg.exe 不存在时返回 null（后端回退 PATH）');

const throwing = loadApi({ exists: () => { throw new Error('EACCES'); } }).resolveBundledFfmpeg('win32', resources);
ok(throwing === null, 'existsSync 抛错时不崩，返回 null');

console.log('[2] applyBundledFfmpegEnv：win32 才注入，显式环境变量优先');
const macEnv = {};
const macApplied = loadApi({ exists: setOf([ffmpegPath, ffprobePath]) }).applyBundledFfmpegEnv(macEnv, 'darwin', resources);
ok(macApplied === null && macEnv.FFMPEG_PATH === undefined && macEnv.FFPROBE_PATH === undefined, 'macOS 不写后端环境变量');

const winEnv = {};
const winApplied = loadApi({ exists: setOf([ffmpegPath, ffprobePath]) }).applyBundledFfmpegEnv(winEnv, 'win32', resources);
ok(winEnv.FFMPEG_PATH === ffmpegPath, 'win32 写入 FFMPEG_PATH');
ok(winEnv.FFPROBE_PATH === ffprobePath, 'win32 写入 FFPROBE_PATH');
ok(!!winApplied && !winApplied.keptExisting, '返回值标记为内置路径');

const halfEnv = {};
loadApi({ exists: setOf([ffmpegPath]) }).applyBundledFfmpegEnv(halfEnv, 'win32', resources);
ok(halfEnv.FFMPEG_PATH === ffmpegPath && halfEnv.FFPROBE_PATH === undefined, '缺 ffprobe 时只写 FFMPEG_PATH');

const explicitEnv = { FFMPEG_PATH: 'D:\\tools\\ffmpeg.exe', FFPROBE_PATH: 'D:\\tools\\ffprobe.exe' };
const explicitApplied = loadApi({ exists: setOf([ffmpegPath, ffprobePath]) }).applyBundledFfmpegEnv(explicitEnv, 'win32', resources);
ok(explicitEnv.FFMPEG_PATH === 'D:\\tools\\ffmpeg.exe' && explicitEnv.FFPROBE_PATH === 'D:\\tools\\ffprobe.exe', '用户显式设置的 FFMPEG_PATH/FFPROBE_PATH 不被覆盖');
ok(!!explicitApplied && explicitApplied.keptExisting === true, '返回值标记为沿用已有配置');

const emptyEnv = {};
const noBundled = loadApi({ exists: () => false }).applyBundledFfmpegEnv(emptyEnv, 'win32', resources);
ok(noBundled === null && emptyEnv.FFMPEG_PATH === undefined, '没有内置文件时不写环境变量');

console.log('[3] main.js 接线：startBackend 真的调用注入函数');
ok(/applyBundledFfmpegEnv\(backendEnv, process\.platform, process\.resourcesPath\)/.test(mainSrc), 'startBackend 用 backendEnv 调 applyBundledFfmpegEnv');
ok(/logFfmpegVersion\(bundledFfmpeg\.ffmpeg\)/.test(mainSrc), '启动时探测一次 ffmpeg 版本（异步，不阻塞 spawn）');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
