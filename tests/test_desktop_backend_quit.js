#!/usr/bin/env node
/* 退出后不留残进程回归（纯 node，不启动 Electron）：
   Q1. killProcessTree：win32 走同步 taskkill /F /T /PID，其它平台 kill('SIGKILL')；
   Q2. shutdownBackend：幂等、杀成功才删 pid 记录、杀失败保留记录；
   Q3. cleanupStaleBackend：只清「pid 记录 = 该端口监听者 + 确实是 NOVAI 后端」的残留，其它一律不动；
   Q4. 接线断言：壳把 NOVAI_PARENT_PID 传给后端、后端看门狗读它、传统版托盘退出强制退进程；
   Q5. 看门狗真跑：父进程死掉后 python 子进程自己退出（不依赖 taskkill）。
   跑法：node tests/test_desktop_backend_quit.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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

const main = read('desktop/main.js');
const killSrc = topLevelFunction(main, 'killProcessTree');
const shutdownSrc = topLevelFunction(main, 'shutdownBackend');
const cleanupSrc = topLevelFunction(main, 'cleanupStaleBackend');
const pidFileSrc = [
    topLevelFunction(main, 'backendPidFile'),
    topLevelFunction(main, 'rememberBackendPid'),
    topLevelFunction(main, 'readBackendPid'),
    topLevelFunction(main, 'forgetBackendPid'),
].join('\n');

console.log('[1] killProcessTree：同步结束整棵进程树');
function loadKill(options) {
    const calls = [];
    const logs = [];
    const sandbox = {
        process: { platform: options.platform || 'win32', pid: 100 },
        spawnSync: (cmd, args, opts) => {
            calls.push([cmd].concat(args));
            return options.spawnError ? { error: options.spawnError } : { error: null, status: 0 };
        },
        process_kill: null,
        console: { log() {}, error() {} },
        clog: (area, msg) => logs.push('[' + area + '] ' + msg),
    };
    sandbox.process.kill = (pid, sig) => { calls.push(['process.kill', pid, sig]); };
    const fn = vm.runInNewContext(killSrc + '\nkillProcessTree', sandbox);
    return { fn, calls, logs };
}

const win = loadKill({ platform: 'win32' });
ok(win.fn(4242) === true, 'win32 杀成功返回 true');
ok(win.calls.length === 1 && win.calls[0].join(' ') === 'taskkill /F /T /PID 4242', 'win32 用 taskkill /F /T /PID 结束整棵树');
const winFail = loadKill({ platform: 'win32', spawnError: new Error('access denied') });
ok(winFail.fn(4242) === false && winFail.logs.some((m) => m.indexOf('taskkill') >= 0), 'taskkill 失败返回 false 并记日志');
const mac = loadKill({ platform: 'darwin' });
ok(mac.fn(4242) === true && mac.calls[0].join(' ') === 'process.kill 4242 SIGKILL', '非 win32 用 SIGKILL，行为不变');
ok(win.fn(0) === false && win.fn(null) === false, '没有 pid 时不动系统进程');

console.log('[2] shutdownBackend：幂等 + pid 记录');
function loadShutdown(options) {
    const calls = [];
    const sandbox = {
        backendProc: options.proc,
        backendStopped: !!options.stopped,
        backendStopExpected: false,
        killProcessTree: (pid) => { calls.push(pid); return options.killOk !== false; },
        forgetBackendPid: () => calls.push('forget'),
        clog: () => {},
        Number: Number,
    };
    const fn = vm.runInNewContext(shutdownSrc + '\nshutdownBackend', sandbox);
    return { fn, calls };
}

const own = loadShutdown({ proc: { pid: 4242, killed: false } });
ok(own.fn() === true && own.calls[0] === 4242, '结束自己 spawn 的后端进程树');
ok(own.calls.indexOf('forget') > 0, '杀成功后才删 pid 记录');
const first = loadShutdown({ proc: { pid: 4242, killed: false, killedFlag: true } });
first.fn();
const killedCount = first.calls.filter((c) => c === 4242).length;
ok(first.fn() === true && first.calls.filter((c) => c === 4242).length === killedCount, '重复调用不再杀第二次（before-quit + will-quit 都走）');
ok(first.fn('again') !== undefined, '重复调用有返回值，不抛错');
const fail = loadShutdown({ proc: { pid: 4242, killed: false }, killOk: false });
ok(fail.fn() === false && fail.calls.indexOf('forget') < 0, '杀失败返回 false，保留 pid 记录供下次启动清理');
const none = loadShutdown({ proc: null });
ok(none.fn() === false && none.calls.length === 0, '没有自己的后端（复用外部）时不动任何进程');
const already = loadShutdown({ proc: { pid: 4242, killed: true } });
ok(already.fn() === false && already.calls.length === 0, '已经杀过的后端不重复处理');

console.log('[3] cleanupStaleBackend：只清自己留下的残留');
function loadCleanup(options) {
    const calls = [];
    const logs = [];
    const record = options.record === undefined ? { pid: 4242, port: 3000 } : options.record;
    const sandbox = {
        process: { platform: options.platform || 'win32', pid: options.selfPid || 100 },
        readBackendPid: () => record,
        forgetBackendPid: () => calls.push('forget'),
        isPortInUse: () => Promise.resolve(options.portInUse !== false),
        looksLikeNovaiBackend: () => Promise.resolve(options.isNovai !== false),
        execFile: (cmd, args, opts, cb) => {
            calls.push([cmd].concat(args));
            cb(options.netstatError || null, options.netstat || '', '');
        },
        parseNetstatListenPids: () => options.listenPids || [4242],
        freeBackendPort: (limit, portOverride) => { calls.push(['freeBackendPort', limit, portOverride]); return Promise.resolve(true); },
        setTimeout: (fn) => { fn(); return 0; },
        Date: { now: () => 0 },
        clog: (area, msg) => logs.push('[' + area + '] ' + msg),
        Promise: Promise,
        console: { log() {}, error() {} },
    };
    const fn = vm.runInNewContext(cleanupSrc + '\ncleanupStaleBackend', sandbox);
    return { fn, calls, logs };
}

(async () => {
    const hit = loadCleanup({});
    ok((await hit.fn()) === true, 'pid 记录对得上时清理残留');
    ok(hit.calls.indexOf('forget') === 0, '读完记录立刻删掉，避免误杀后重复尝试');
    const freeCall = hit.calls.find((c) => Array.isArray(c) && c[0] === 'freeBackendPort');
    ok(!!freeCall, '交给 freeBackendPort 结束进程树并等端口释放');
    ok(freeCall && freeCall[2] === 3000, '清理时把 pid 记录里的端口显式传过去（启动早期 backendPort 还是 0）');
    ok(hit.calls.some((c) => Array.isArray(c) && c[0] === 'netstat'), '用 netstat 确认监听者就是记录里的 PID');

    const macOs = loadCleanup({ platform: 'darwin' });
    ok((await macOs.fn()) === false && macOs.calls.length === 0, '非 win32 不清理（mac 靠进程直接 kill，行为不变）');

    const empty = loadCleanup({ record: null });
    ok((await empty.fn()) === false && !empty.calls.some((c) => Array.isArray(c) && c[0] === 'freeBackendPort'), '没有 pid 记录时不动任何进程');

    const self = loadCleanup({ selfPid: 4242 });
    ok((await self.fn()) === false && !self.calls.some((c) => Array.isArray(c) && c[0] === 'freeBackendPort'), '记录里的 PID 是自己时不动');

    const freePort = loadCleanup({ portInUse: false });
    ok((await freePort.fn()) === false && !freePort.calls.some((c) => Array.isArray(c) && c[0] === 'freeBackendPort'), '端口已空闲时不杀进程');

    const notNovai = loadCleanup({ isNovai: false });
    ok((await notNovai.fn()) === false && !notNovai.calls.some((c) => Array.isArray(c) && c[0] === 'freeBackendPort'), '端口上不是 NOVAI 后端时不杀（可能用户自己起的服务）');

    const reusedPid = loadCleanup({ listenPids: [7777] });
    ok((await reusedPid.fn()) === false && !reusedPid.calls.some((c) => Array.isArray(c) && c[0] === 'freeBackendPort'), 'PID 被系统复用（监听者不是记录 PID）时不杀');

    console.log('[4] pid 记录读写');
    const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'novai-pidtest-'));
    const pidSandbox = {
        path: path,
        fs: fs,
        backendPort: 3001,
        app: { getPath: () => tmpUser },
        clog: () => {},
        JSON: JSON,
        Number: Number,
        Date: { now: () => 111 },
    };
    const pidApi = vm.runInNewContext(pidFileSrc + '\n({backendPidFile, rememberBackendPid, readBackendPid, forgetBackendPid})', pidSandbox);
    ok(pidApi.readBackendPid() === null, '没有记录时读出 null');
    pidApi.rememberBackendPid(4242);
    const rec = pidApi.readBackendPid();
    ok(rec && rec.pid === 4242 && rec.port === 3001, '写入后读回 pid 与端口');
    fs.writeFileSync(path.join(tmpUser, 'backend.pid'), '{bad json');
    ok(pidApi.readBackendPid() === null, '记录损坏时读出 null，不抛错');
    pidApi.rememberBackendPid(4243);
    pidApi.forgetBackendPid();
    ok(pidApi.readBackendPid() === null && !fs.existsSync(path.join(tmpUser, 'backend.pid')), '清理后记录文件消失');
    fs.rmSync(tmpUser, { recursive: true, force: true });

    console.log('[5] 接线：壳 → 后端看门狗 / 传统版托盘退出');
    ok(/NOVAI_PARENT_PID: String\(process\.pid\)/.test(main), 'Electron 启动后端时把 NOVAI_PARENT_PID 传给后端');
    ok(/rememberBackendPid\(backendProc\.pid\)/.test(main), 'spawn 后端后记录 pid');
    ok(/await cleanupStaleBackend\(\);/.test(main), '启动时先清理上一轮残留的后端');
    ok(/app\.on\('will-quit'/.test(main), 'will-quit 再兜底结束一次后端');

    const py = read('main.py');
    ok(/def _start_parent_watchdog\(parent_pid: int\)/.test(py), 'main.py 有父进程看门狗');
    ok(/if _parent_pid > 0 and _parent_pid != os\.getpid\(\):\s*\n\s*_start_parent_watchdog\(_parent_pid\)/.test(py), 'main.py 在 __main__ 里按 NOVAI_PARENT_PID 启动看门狗');

    const launcher = read('launcher.py');
    const quitBlock = launcher.split('\n').slice(launcher.split('\n').findIndex((line) => line.indexOf('def on_quit(icon, item)') >= 0)).slice(0, 24).join('\n');
    ok(quitBlock.indexOf('os._exit(0)') >= 0, '传统安装版托盘「退出 NOVAI」强制结束进程');
    ok(quitBlock.indexOf('icon.stop()') >= 0, '传统版托盘退出仍然先停托盘图标');

    console.log('[6] 看门狗真跑：父进程消失后后端自己退出');
    const pyExe = process.platform === 'win32' ? 'python' : 'python3';
    const hasPython = await new Promise((resolve) => {
        let child;
        try { child = spawn(pyExe, ['-c', 'print(1)'], { stdio: 'ignore' }); } catch (_) { return resolve(false); }
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
    });
    if (!hasPython) {
        ok(true, '没有 python，跳过看门狗真跑（其余断言已覆盖接线）');
    } else {
        const start = py.indexOf('def _start_parent_watchdog(');
        const end = py.indexOf('\nif __name__ == "__main__":', start);
        const watchdogSrc = py.slice(start, end);
        const tmpPy = path.join(os.tmpdir(), 'novai-watchdog-' + process.pid + '.py');
        fs.writeFileSync(tmpPy, watchdogSrc + '\n' + [
            'import os, sys, time',
            'ppid = int(os.environ["TEST_PARENT_PID"])',
            '_start_parent_watchdog(ppid)',
            'time.sleep(120)',
        ].join('\n'));

        const parent = spawn(pyExe, ['-c', 'import time; time.sleep(120)'], { stdio: 'ignore' });
        const child = spawn(pyExe, [tmpPy], { env: Object.assign({}, process.env, { TEST_PARENT_PID: String(parent.pid) }), stdio: 'ignore' });
        let childExited = null;
        child.on('exit', (code, signal) => { childExited = { code: code, signal: signal }; });

        await new Promise((resolve) => setTimeout(resolve, 3000));
        ok(childExited === null, '父进程还在时后端保持运行（不误退）');
        parent.kill('SIGKILL');
        const deadline = Date.now() + 8000;
        while (childExited === null && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        ok(!!childExited, '父进程被强杀后后端自己退出（不依赖 taskkill）');
        try { child.kill('SIGKILL'); } catch (_) {}
        try { fs.unlinkSync(tmpPy); } catch (_) {}
    }

    console.log('');
    if (fails.length) {
        console.log('FAIL ' + fails.length + ' / PASS ' + pass);
        fails.forEach((label) => console.log('  ✗ ' + label));
        process.exit(1);
    }
    console.log('PASS ' + pass + ' / FAIL 0');
})();
