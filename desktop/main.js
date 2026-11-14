// NOVAI Desktop — Electron 主进程
// 职责：
//  1. 拉起 FastAPI 后端（python main.py 或 bundled 二进制）并等待端口就绪
//  2. 创建窗口加载本地页面（无边框 + 系统托盘，对齐现有 pywebview 桌面版体验）
//  3. 通过 IPC 提供 pywebview 兼容桥（原生对话框/窗口控制/数据目录/自启/主题）
//  4. 退出时确保结束后端进程，避免残留占用端口
//  5. iframe 子页面注入迷你桥（postMessage 转发），前端零改动获得完整桌面能力

const { app, BrowserWindow, WebContentsView, session, shell, dialog, ipcMain, Tray, Menu, screen, desktopCapturer, nativeImage, net, Notification, nativeTheme } = require('electron');
const { spawn, spawnSync, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const macUpdater = require('./mac-updater');
const { resolveBaseUrl } = require('./cloud-config');
const { trayIconCandidates, firstExistingTrayIcon } = require('./tray-icon');
const updateState = require('./update-state');

// 后端端口：与正式版一致使用 3000（数据目录也相同，Electron 版就是正式版的桌面壳）。
// 若 3000 上已有 NOVAI 后端在跑（正式版/网页版），直接复用而不重复启动；
// 若被无关程序占用，resolvePort 自动顺延到 3001+。
const DEFAULT_PORT = 3000;
let backendProc = null;
// 后端实际使用的端口（自己 spawn 或复用已有进程都记录），更新前靠它释放端口。
let backendPort = 0;
let mainWindow = null;
let tray = null;
// 最近一次确定的应用地址：窗口被销毁后（托盘/二次启动）靠它重建窗口。
let appBaseUrl = '';
let isQuitting = false;
// 主动停后端（更新重启/正常退出）期间不把退出当崩溃报错；每次 startBackend 都会复位。
let backendStopExpected = false;
// 后端进程树已经杀过（退出钩子跑了两次：before-quit + will-quit）。
let backendStopped = false;
let backendLog = [];
let dataDir = '';

// ---------- 后端 pid 记账 ----------
// 后端由本进程 spawn 时把 pid 记到 userData：正常退出会 taskkill 整棵树，
// 但壳被强杀 / 崩溃 / 更新异常时退出钩子跑不到，下次启动只能靠这份记录认出「这是自己的残留」。
function backendPidFile() {
  try { return path.join(app.getPath('userData'), 'backend.pid'); } catch (_) { return ''; }
}

function rememberBackendPid(pid) {
  const file = backendPidFile();
  if (!file || !pid) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: Number(pid), port: Number(backendPort) || 0, at: Date.now() }));
  } catch (err) {
    clog('boot', '记录后端 pid 失败（不影响运行）: ' + ((err && err.message) || err));
  }
}

function readBackendPid() {
  const file = backendPidFile();
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(raw && raw.pid);
    if (!pid) return null;
    return { pid: pid, port: Number(raw && raw.port) || 0 };
  } catch (_) {
    return null;
  }
}

function forgetBackendPid() {
  const file = backendPidFile();
  if (!file) return;
  try { fs.unlinkSync(file); } catch (_) {}
}

// ---------- 日志文件（便于真机排查） ----------
let logFile = '';
function logToFile(msg) {
  try {
    if (!logFile) {
      const dir = app.isPackaged
        ? (process.env.APPDATA || app.getPath('appData'))
        : require('os').tmpdir();
      logFile = path.join(dir, 'novai-electron.log');
    }
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + String.fromCharCode(10));
  } catch (_) {}
}
function clog(area, msg) {
  console.log('[' + area + ']', msg);
  logToFile('[' + area + '] ' + msg);
}

// 把渲染进程（含子 frame）的 console 转发到主进程日志，画布 iframe 的 console.log 也能远程排查。
function attachRendererConsole(webContents, tag) {
  if (!webContents || typeof webContents.on !== 'function') return;
  webContents.on('console-message', (event, level, message, line, sourceId) => {
    const info = event && typeof event === 'object' && event.message !== undefined
      ? { message: event.message, sourceId: event.sourceId, line: event.lineNumber }
      : { message: message, sourceId: sourceId, line: line };
    const text = String(info.message === undefined || info.message === null ? '' : info.message).slice(0, 800);
    const where = info.sourceId ? ' (' + info.sourceId + (info.line !== undefined && info.line !== null ? ':' + info.line : '') + ')' : '';
    clog('renderer', '[' + tag + '] ' + text + where);
  });
}

// ---------- 路径解析 ----------
function resolveMainPy() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'backend', 'main.py') : null,
    path.join(__dirname, '..', 'main.py'),
    path.join(process.cwd(), 'main.py'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function resolveBackendBinary() {
  if (app.isPackaged) {
    // 只检查 Resources/backend 下的 bundled 后端二进制。
    // 绝不能查 path.dirname(process.execPath)：那是 Electron 主程序自身所在目录，
    // 里面有一个叫 NOVAI 的可执行文件（就是本 app），误查会导致“把自己当后端 spawn 自己”。
    const binNames = process.platform === 'win32' ? ['NOVAI.exe', 'NOAI.exe'] : ['NOVAI', 'NOVAI.app'];
    const base = process.resourcesPath ? path.join(process.resourcesPath, 'backend') : null;
    if (!base) return null;
    for (const name of binNames) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Windows 安装包内置 GPL 静态版 ffmpeg/ffprobe（打包后位于 resources/bin/win；含 libx264，压缩 / 导出可用）。
// 参数可注入，便于 node 单测（tests/test_desktop_bundled_ffmpeg.js）；平台不匹配一律返回 null。
function resolveBundledFfmpeg(platform, resourcesPath) {
  if ((platform || process.platform) !== 'win32') return null;
  const root = resourcesPath === undefined ? process.resourcesPath : resourcesPath;
  if (!root) return null;
  const dir = path.join(root, 'bin', 'win');
  const ffmpeg = path.join(dir, 'ffmpeg.exe');
  const ffprobe = path.join(dir, 'ffprobe.exe');
  try {
    if (!fs.existsSync(ffmpeg)) return null;
    return { ffmpeg, ffprobe: fs.existsSync(ffprobe) ? ffprobe : null };
  } catch (_) {
    return null;
  }
}

// 把内置 ffmpeg 写进后端环境变量：只 win32；用户显式设置的 FFMPEG_PATH 优先（便于换自编译版本）。
function applyBundledFfmpegEnv(backendEnv, platform, resourcesPath) {
  if ((platform || process.platform) !== 'win32') return null;
  const explicit = String(backendEnv.FFMPEG_PATH || '').trim();
  if (explicit) {
    return { ffmpeg: explicit, ffprobe: String(backendEnv.FFPROBE_PATH || '').trim() || null, keptExisting: true };
  }
  const bundled = resolveBundledFfmpeg(platform, resourcesPath);
  if (!bundled) return null;
  backendEnv.FFMPEG_PATH = bundled.ffmpeg;
  if (bundled.ffprobe) backendEnv.FFPROBE_PATH = bundled.ffprobe;
  return bundled;
}

// 版本探测只写日志：异步执行，失败不影响后端启动。
function logFfmpegVersion(binary) {
  execFile(binary, ['-version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
    if (err) {
      clog('boot', 'ffmpeg 版本探测失败: ' + (err.message || err));
      return;
    }
    const firstLine = String(stdout || '').split(/\r?\n/)[0].trim();
    if (firstLine) clog('boot', 'ffmpeg 版本: ' + firstLine);
  });
}

// 稳定配置：与后端 main.py 的口径完全一致（Windows = %APPDATA%\NOVAI\config.json，
// macOS/Linux = ~/.NOVAI/config.json）。它必须放在数据目录之外——用户把数据搬到别的盘后，
// 下次启动要靠它找回"数据在哪"，否则又会回到旧目录。NOVAI_CONFIG_DIR 只给验收/隔离用。
function stableConfigFile() {
  if (process.env.NOVAI_CONFIG_DIR) return path.join(process.env.NOVAI_CONFIG_DIR, 'config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || require('os').homedir(), 'NOVAI', 'config.json');
  return path.join(require('os').homedir(), '.NOVAI', 'config.json');
}

// 读用户设置的存储位置；不存在/坏了/盘没插一律返回空串（回落到默认目录，绝不挡住启动）。
function readConfiguredDataDir() {
  try {
    const file = stableConfigFile();
    if (!fs.existsSync(file)) return '';
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = String((cfg && cfg.data_root) || '').trim();
    if (!raw) return '';
    const abs = path.resolve(raw.replace(/^~(?=$|[\\/])/, require('os').homedir()));
    if (!fs.existsSync(abs)) {
      clog('boot', '存储位置配置不可用（磁盘未连接？）: ' + abs + '，本次使用默认数据目录');
      return '';
    }
    return abs;
  } catch (err) {
    clog('boot', '读取存储位置配置失败: ' + ((err && err.message) || err));
    return '';
  }
}

// ── 默认数据根：与 main.py default_data_root() / launcher.py 同口径 ──
// 新装且安装目录可写 → 安装目录（程序装在哪，数据就在哪：data/ assets/ output/ history.json）；
// 用户目录里已经有数据（老用户）、安装目录只读（AppImage / deb 装到 /usr、/opt、Windows 的
// Program Files）、macOS 一律用用户目录（Windows %APPDATA%\NOVAI，其它 ~/NOVAI）。
// 改规则要三处一起改。
function userDataRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || require('os').homedir(), 'NOVAI');
  }
  return path.join(require('os').homedir(), 'NOVAI');
}

// 目录可写探测：建一个探针文件再删掉（安装目录权限 / 只读挂载都靠它兜底）。
function dirWritable(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const probe = path.join(dir, '.novai-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function pathWithin(target, root) {
  try {
    const rel = path.relative(root, target);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (_) {
    return false;
  }
}

function installDirReadonly(dir) {
  if (!dir) return true;
  if (String(process.env.APPIMAGE || '').trim()) return true;
  const systemDirs = [];
  if (process.platform === 'win32') {
    ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432'].forEach((key) => {
      if (process.env[key]) systemDirs.push(process.env[key]);
    });
  } else {
    systemDirs.push('/usr', '/opt', '/snap');
  }
  if (systemDirs.some((root) => pathWithin(dir, root))) return true;
  return !dirWritable(dir);
}

// 用户目录里是否已经有 NOVAI 数据。信号宁宽勿窄：认成老用户最多继续用旧位置；
// 认成新用户却把账号库/画布/素材切到安装目录，老用户看到的就是「数据全没了」。
function userRootHasData(root) {
  if (!root) return false;
  try {
    if (!fs.existsSync(root)) return false;
    const files = [path.join(root, 'data', 'users.db'), path.join(root, 'data', 'settings.json'), path.join(root, 'history.json')];
    if (files.some((file) => fs.existsSync(file))) return true;
    return ['data/canvases', 'assets', 'output'].some((rel) => {
      try { return fs.readdirSync(path.join(root, rel)).length > 0; } catch (_) { return false; }
    });
  } catch (_) {
    return false;
  }
}

function decideDefaultDataDir() {
  const userRoot = userDataRoot();
  if (process.platform === 'darwin') return { dir: userRoot, origin: 'user' };
  let installDir = String(process.env.NOVAI_INSTALL_DIR || '').trim();
  if (!installDir) {
    try { installDir = process.execPath ? path.dirname(process.execPath) : ''; } catch (_) { installDir = ''; }
  }
  if (installDirReadonly(installDir)) return { dir: userRoot, origin: 'user' };
  if (userRootHasData(userRoot)) return { dir: userRoot, origin: 'user' };
  return { dir: installDir, origin: 'install' };
}

// 首次判定写进稳定配置并记来源（已有 data_root 不覆盖）。老用户的数据根已经在用户目录且
// 有数据时不写：写了会被当成「用户自己选过位置」，挡掉首次启动的「迁到安装目录」提示。
function persistDataRoot(dir, origin) {
  try {
    if (!dir) return;
    if (origin === 'user' && userRootHasData(dir)) return;
    const file = stableConfigFile();
    let cfg = {};
    if (fs.existsSync(file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (loaded && typeof loaded === 'object') cfg = loaded;
      } catch (_) { cfg = {}; }
    }
    if (String(cfg.data_root || '').trim()) return;
    cfg.data_root = dir;
    cfg.data_root_origin = origin;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再替换：写一半崩掉会让下次启动读不到 data_root，数据根翻回用户目录
    const tmpFile = file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmpFile, file);
    clog('boot', '默认数据目录 ' + dir + '（来源 ' + origin + '）已写入 ' + file);
  } catch (err) {
    clog('boot', '记录默认数据目录失败（不影响启动）: ' + ((err && err.message) || err));
  }
}

// 数据目录：env > 稳定配置 data_root > 默认判定（见 decideDefaultDataDir）。
// 与正式版 launcher.py / main.py 同口径，切换安装方式仍共享同一份用户数据。
// 独立于 .app 包内部（可写、非只读、升级不丢）。
function resolveDataDir() {
  // 显式给的数据目录优先：隔离验收或自定义部署时，别把探针拖出来的节点写进日常数据
  if (process.env.NOVAI_DATA_DIR) return process.env.NOVAI_DATA_DIR;
  // 设置 → 通用 → 存储位置 里选过目录的话，后端把 data_root 写进稳定配置，这里必须读同一份，
  // 否则安装版用户改完设置一重启又回到旧目录（后端拿到的 NOVAI_DATA_DIR 还是旧的）。
  const configured = readConfiguredDataDir();
  if (configured) return configured;
  if (!app.isPackaged) return path.join(__dirname, '..', 'data');
  const decided = decideDefaultDataDir();
  persistDataRoot(decided.dir, decided.origin);
  clog('boot', '默认数据目录: ' + decided.dir + '（来源 ' + decided.origin + '）');
  // 兼容早期 Electron 测试版（数据曾写到系统 appData/NOVAI，macOS 上与正式版不一致）：
  // 正式目录不存在而旧目录存在时整体搬迁，避免老测试用户数据"消失"。
  if (decided.origin === 'user') {
    try {
      const legacy = path.join(app.getPath('appData'), 'NOVAI');
      if (legacy !== decided.dir && !fs.existsSync(decided.dir) && fs.existsSync(legacy)) {
        fs.renameSync(legacy, decided.dir);
        clog('boot', '已迁移旧版 Electron 数据目录: ' + legacy + ' -> ' + decided.dir);
      }
    } catch (_) {}
  }
  return decided.dir;
}

// ---------- 后端日志 ----------
function logBackend(line) {
  const s = String(line || '').trimEnd();
  if (s) {
    backendLog.push(s);
    if (backendLog.length > 500) backendLog.shift();
    console.log('[backend]', s);
    logToFile('[backend] ' + s);
  }
}

// ---------- 等待后端就绪 ----------
function waitForServer(url, timeoutMs = 180000, intervalMs = 400) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(2000, () => req.destroy());
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('等待后端服务启动超时'));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}

// ---------- 端口占用检测 ----------
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = require('net').connect({ host: '127.0.0.1', port, timeout: 800 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
  });
}

async function resolvePort(preferred) {
  if (!(await isPortInUse(preferred))) return preferred;
  for (let p = preferred + 1; p < preferred + 50; p++) {
    if (!(await isPortInUse(p))) return p;
  }
  return preferred;
}

// 判断指定端口上跑的是不是 NOVAI 后端（而非碰巧占端口的无关程序）。
// 依据：/static/update-notes.json 是 NOVAI 特有的接口，返回含 version 字段的 JSON。
function looksLikeNovaiBackend(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/static/update-notes.json', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(!!(data && data.version));
        } catch (_) { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 后端 Python 解释器选择：PATH 里的 python3 可能是别的工具链（如 agent venv），
// 缺 onnxruntime/cv2 时拆分图层会退化成矩形裁切。优先用自带 venv / 用户数据目录 venv。
function resolvesPythonDeps(cmd, spec) {
  try {
    const result = spawnSync(cmd, ['-c', 'import ' + spec], { timeout: 8000, encoding: 'utf8' });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function resolvePython(cwd, backendEnv) {
  const candidates = [];
  const push = (value) => {
    if (value && candidates.indexOf(value) < 0 && (value.indexOf('/') < 0 && value.indexOf('\\\\') < 0 || fs.existsSync(value))) {
      candidates.push(value);
    }
  };
  if (process.env.NOVAI_PYTHON) push(process.env.NOVAI_PYTHON);
  const win = process.platform === 'win32';
  if (cwd) {
    push(path.join(cwd, 'venv', win ? 'Scripts\\python.exe' : 'bin/python3'));
    push(path.join(cwd, '.venv', win ? 'Scripts\\python.exe' : 'bin/python3'));
  }
  const dataDir = backendEnv && backendEnv.NOVAI_DATA_DIR;
  if (dataDir) {
    push(path.join(dataDir, 'venv', win ? 'Scripts\\python.exe' : 'bin/python3'));
  }
  if (process.resourcesPath) {
    push(path.join(process.resourcesPath, 'backend', 'venv', win ? 'Scripts\\python.exe' : 'bin/python3'));
  }
  push(win ? 'python' : 'python3');

  let fallback = null;
  for (const cmd of candidates) {
    const core = resolvesPythonDeps(cmd, 'fastapi, uvicorn');
    if (!core) continue;
    if (!fallback) fallback = cmd;
    if (resolvesPythonDeps(cmd, 'cv2, onnxruntime')) {
      clog('boot', '选择后端 Python（含本地拆分组件）: ' + cmd);
      return cmd;
    }
  }
  if (fallback) {
    clog('boot', '警告：没有找到带 cv2/onnxruntime 的 Python，拆分图层会退化为矩形裁切；已用 ' + fallback);
    return fallback;
  }
  clog('boot', '警告：没有找到可用 Python（缺 fastapi），后端可能起不来');
  return win ? 'python' : 'python3';
}

// ---------- 启动后端 ----------
function startBackend(port) {
  return new Promise(async (resolve, reject) => {
    backendStopExpected = false;
    backendStopped = false;
    backendPort = port;
    const mainPy = resolveMainPy();
    const binary = resolveBackendBinary();

    // 后端环境：数据/输出/素材写入用户数据目录（可写、独立于 .app、升级不丢）；
    // 资源目录（static/workflows）按 NOVAI_APP_DIR 定位（打包后为 app 内 backend 目录）。
    const backendEnv = Object.assign({}, process.env, {
      NOVAI_DATA_DIR: resolveDataDir(),
      NOVAI_APP_DIR: app.isPackaged
        ? path.dirname(mainPy || binary || '')
        : path.dirname(mainPy || ''),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      // 后端自带看门狗：壳一消失（强杀/崩溃/kill 漏掉）就自杀，Windows 上不会再留 NOVAI.exe。
      NOVAI_PARENT_PID: String(process.pid),
    });
    // Win/Linux 安装根目录传给后端：新装且安装目录可写时数据根就是安装目录（程序装在哪，
    // 数据就在哪）；只读安装目录（AppImage / deb 装到 /usr）由后端按同一规则回落用户目录。
    // macOS 不传：.app 包内只读、升级整体替换，数据只能留在 ~/NOVAI。
    if (app.isPackaged && process.platform !== 'darwin') {
      backendEnv.NOVAI_INSTALL_DIR = path.dirname(process.execPath);
    }
    // Windows 安装包自带 ffmpeg/ffprobe（resources/bin/win）：注入给后端，不依赖用户机器预装。
    // macOS/Linux 不设置，后端继续用系统 PATH 里的 ffmpeg，行为不变。
    const bundledFfmpeg = applyBundledFfmpegEnv(backendEnv, process.platform, process.resourcesPath);
    if (bundledFfmpeg) {
      clog('boot', (bundledFfmpeg.keptExisting ? '沿用已设置的 FFMPEG_PATH: ' : '内置 ffmpeg: ')
        + bundledFfmpeg.ffmpeg + (bundledFfmpeg.ffprobe ? '（含 ffprobe）' : '（缺少 ffprobe，后端会回退到 PATH）'));
      if (!bundledFfmpeg.keptExisting) logFfmpegVersion(bundledFfmpeg.ffmpeg);
    } else if (process.platform === 'win32') {
      clog('boot', '未发现内置 ffmpeg，后端将使用系统 PATH 里的 ffmpeg');
    }
    // Windows 从开始菜单/桌面快捷方式启动时，进程 PATH 里没有 npm 全局目录和 OpenClaw 私有 Node，
    // 后端就找不到 openclaw.cmd / node.exe，扩展里的 openclaw 恒为不可用。
    if (process.platform === 'win32') {
      const winBinDirs = [];
      if (process.env.APPDATA) {
        winBinDirs.push(path.join(process.env.APPDATA, 'npm'));
        winBinDirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '.bin'));
      }
      if (process.env.LOCALAPPDATA) {
        winBinDirs.push(path.join(process.env.LOCALAPPDATA, 'OpenClaw', 'deps', 'portable-node'));
      }
      // Windows 环境块大小写不敏感，Node 常把键暴露成 "Path"；同时留 PATH 和 Path 两个键
      // 谁生效取决于遍历顺序，这里先合并成一个键再写回。
      const pathKeys = Object.keys(backendEnv).filter((key) => key.toLowerCase() === 'path');
      const pathKey = pathKeys[0] || 'Path';
      const currentPath = pathKeys.map((key) => backendEnv[key]).filter(Boolean).join(';');
      pathKeys.forEach((key) => { delete backendEnv[key]; });
      const pathParts = currentPath.split(';').filter(Boolean);
      winBinDirs.forEach((dir) => {
        if (fs.existsSync(dir) && pathParts.indexOf(dir) < 0) pathParts.unshift(dir);
      });
      backendEnv[pathKey] = pathParts.join(';');
    }
    // macOS 从 Finder/Launchpad 启动时进程 PATH 只有系统默认目录（没有 /opt/homebrew/bin），
    // 后端就找不到 Homebrew 装的 tesseract 等命令，拆分图层的文字层会被跳过。
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const posixBinDirs = process.platform === 'darwin'
        ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
        : ['/usr/local/bin'];
      const pathKeys = Object.keys(backendEnv).filter((key) => key.toLowerCase() === 'path');
      const pathKey = pathKeys[0] || 'PATH';
      const currentPath = pathKeys.map((key) => backendEnv[key]).filter(Boolean).join(':');
      pathKeys.forEach((key) => { delete backendEnv[key]; });
      const pathParts = currentPath.split(':').filter(Boolean);
      const prependDirs = posixBinDirs.filter((dir) => fs.existsSync(dir) && pathParts.indexOf(dir) < 0);
      backendEnv[pathKey] = prependDirs.concat(pathParts).join(':');
      clog('boot', prependDirs.length
        ? '补充后端 PATH: ' + prependDirs.join(' ')
        : '后端 PATH 无需补充（这些目录不存在或已在 PATH 中）');
    }
    if (app.isPackaged) {
      try { fs.mkdirSync(backendEnv.NOVAI_DATA_DIR, { recursive: true }); } catch (_) {}
    }

    if (binary) {
      const cwd = path.dirname(binary);
      backendProc = spawn(binary, ['--port', String(port)], { cwd, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      backendProc.stdout.on('data', logBackend);
      backendProc.stderr.on('data', logBackend);
      backendProc.on('exit', (code, signal) => {
        clog('boot', 'bundled 后端进程退出，code = ' + code + ', signal = ' + signal);
        if (backendStopExpected || isQuitting) return;
        if (app.isPackaged && code !== 0 && code !== null) {
          dialog.showErrorBox("NOVAI 后端异常退出", "后端进程已退出（code " + code + "）。日志：" + (logFile || "") + (backendLog.length ? String.fromCharCode(10) + backendLog.slice(-12).join(String.fromCharCode(10)) : ""));
        }
      });
      clog('boot', '启动 bundled 后端: ' + binary + ' port ' + port + ' dataDir ' + backendEnv.NOVAI_DATA_DIR);
      rememberBackendPid(backendProc.pid);
      return resolve(backendProc);
    }

    if (!mainPy) {
      return reject(new Error('未找到后端入口 main.py，且没有 bundled 后端二进制。'));
    }

    const cwd = path.dirname(mainPy);
    const pythonCmd = resolvePython(cwd, backendEnv);
    const args = [mainPy, String(port)];
    backendProc = spawn(pythonCmd, args, { cwd, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    backendProc.stdout.on('data', logBackend);
    backendProc.stderr.on('data', logBackend);
    backendProc.on('exit', (code, signal) => {
      clog('boot', '后端进程退出，code = ' + code + ', signal = ' + signal);
      if (backendStopExpected || isQuitting) return;
      if (app.isPackaged && code !== 0 && code !== null) {
        dialog.showErrorBox('NOVAI 后端异常退出', 'Python 后端未能启动，请确认已安装 Python 3.10+ 及依赖。');
      }
    });
    clog('boot', '启动 Python 后端: ' + pythonCmd + ' ' + mainPy + ' port ' + port + ' cwd ' + cwd + ' dataDir ' + backendEnv.NOVAI_DATA_DIR);
    rememberBackendPid(backendProc.pid);
    resolve(backendProc);
  });
}

// ---------- 清理 ----------
// Windows 上 PyInstaller 是“引导进程 + 同名子进程”，只 kill 父进程会留下子进程占住安装目录里的 exe。
function killProcessTree(pid) {
  const target = Number(pid);
  if (!target) return false;
  try {
    if (process.platform === 'win32') {
      // 必须同步：退出钩子里异步 spawn 的 taskkill 有可能在壳退出之后才轮到它，
      // 一旦失败（权限/时序）就再没人收拾，任务管理器里就会一直挂着 NOVAI.exe。
      const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(target)], { windowsHide: true, timeout: 8000 });
      if (result.error) clog('boot', 'taskkill ' + target + ' 失败: ' + (result.error.message || result.error));
      return !result.error;
    }
    process.kill(target, 'SIGKILL');
    return true;
  } catch (err) {
    clog('boot', '结束后端进程 ' + target + ' 失败: ' + ((err && err.message) || err));
    return false;
  }
}

// 退出/更新前结束自己 spawn 的后端进程树。幂等：可重复调用（before-quit + will-quit 都会走）。
function shutdownBackend() {
  backendStopExpected = true;
  if (backendStopped) return true;
  if (!backendProc || backendProc.killed) return false;
  const pid = backendProc.pid;
  if (!pid) return false;
  // 先杀干净再删记录：杀失败时保留 pid 文件，下次启动 cleanupStaleBackend 还能认出来。
  if (!killProcessTree(pid)) return false;
  backendStopped = true;
  forgetBackendPid();
  return true;
}

// 从 Windows netstat -ano 输出里解析在指定端口 LISTENING 的 PID。
// 中文系统只有表头不同，状态列仍是 LISTENING；解析不到一律返回空数组，不抛错。
function parseNetstatListenPids(text, port) {
  try {
    const target = Number(port);
    if (!text || !Number.isFinite(target)) return [];
    const pids = [];
    const seen = new Set();
    String(text).split(/\r?\n/).forEach((line) => {
      const match = /^\s*TCP(?:v6)?\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (!match) return;
      const pid = Number(match[2]);
      if (!pid || seen.has(pid)) return;
      const local = match[1];
      const sep = local.lastIndexOf(':');
      if (sep < 0 || Number(local.slice(sep + 1)) !== target) return;
      seen.add(pid);
      pids.push(pid);
    });
    return pids;
  } catch (_) {
    return [];
  }
}

// 安装前彻底释放后端端口：backendProc 为空（复用外部/上次残留的后端）时，
// 这个外部 Python 进程同样会占住安装目录里的文件，导致 Windows 安装器覆盖失败。
function freeBackendPort(timeoutMs, portOverride) {
  const limit = timeoutMs || 8000;
  // 启动早期清理残留时 backendPort 还没赋值，端口由调用方显式给。
  const port = Number(portOverride) || backendPort;
  if (process.platform !== 'win32') return Promise.resolve(true);
  if (!port) {
    clog('updater', '本次没有使用本地后端端口，跳过端口释放');
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let startedAt = 0;
    const finish = (freed) => {
      if (settled) return;
      settled = true;
      resolve(freed);
    };
    const waitForRelease = () => {
      if (!startedAt) startedAt = Date.now();
      isPortInUse(port).then((inUse) => {
        if (!inUse) {
          clog('updater', '后端端口 ' + port + ' 已释放');
          return finish(true);
        }
        if (Date.now() - startedAt >= limit) {
          clog('updater', '后端端口 ' + port + ' 在 ' + limit + 'ms 内仍未释放，继续安装（安装器可能因文件占用失败）');
          return finish(false);
        }
        setTimeout(waitForRelease, 300);
      }).catch((err) => {
        clog('updater', '检查端口 ' + port + ' 是否释放失败: ' + (err && err.message || err));
        finish(false);
      });
    };
    execFile('netstat', ['-ano'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) clog('updater', 'netstat -ano 执行失败，直接轮询端口: ' + (err && err.message || err));
      const pids = err ? [] : parseNetstatListenPids(stdout, port);
      if (!pids.length) {
        clog('updater', 'netstat 未发现监听 ' + port + ' 的进程');
        return waitForRelease();
      }
      clog('updater', '端口 ' + port + ' 被 PID ' + pids.join(', ') + ' 占用，逐个结束');
      let index = 0;
      const killNext = () => {
        if (index >= pids.length) return waitForRelease();
        const pid = pids[index];
        index += 1;
        execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 10000, windowsHide: true }, (killErr, killOut, killErrOut) => {
          const detail = String(killOut || killErrOut || '').trim().replace(/\s+/g, ' ');
          clog('updater', 'taskkill /F /T /PID ' + pid + ' → ' + (killErr ? '失败: ' + (killErr.message || killErr) : '成功') + (detail ? '（' + detail + '）' : ''));
          killNext();
        });
      };
      killNext();
    });
  });
}

// 安装新版前必须先让后端彻底退出，否则 Windows 安装程序覆盖 NOVAI.exe 会被占用中的文件挡住。
function stopBackendForUpdate(timeoutMs) {
  const limit = timeoutMs || 15000;
  const stopOwnedProc = new Promise((resolve) => {
    const proc = backendProc;
    if (!proc || proc.killed || !proc.pid) return resolve();
    backendStopExpected = true;
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    // 超时兜底：拿不到退出事件也要放行安装，避免更新流程卡死。
    timer = setTimeout(finish, limit);
    proc.once('exit', finish);
    try {
      if (process.platform === 'win32') {
        // PyInstaller onefile 是“引导进程 + 同名子进程”，只 kill 引导进程会留下子进程占住 exe
        spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } else {
        proc.kill();
      }
    } catch (err) {
      clog('updater', '停止后端进程失败: ' + (err && err.message || err));
      try { proc.kill(); } catch (_) {}
    }
  });
  // 即使 backendProc 为空（复用了外部/残留后端）也必须释放端口，这是 Windows 覆盖安装的前提。
  return stopOwnedProc.then(() => freeBackendPort(Math.min(limit, 8000)));
}

// 上一次运行被强杀 / 崩溃 / 更新异常时，自己 spawn 的后端可能还活着并占着端口。
// 不清掉它，这一轮就会「复用」它：它不归本次进程所有，退出时也不杀，于是永远关不干净。
// 只处理 pid 文件记着、且确实是该端口上的 NOVAI 后端 —— 用户自己起的服务（没有 pid 记录）一律不动。
function cleanupStaleBackend() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const record = readBackendPid();
    forgetBackendPid();
    if (!record || !record.pid || !record.port) return resolve(false);
    if (record.pid === process.pid) return resolve(false);
    clog('boot', '发现上次残留的后端记录：PID ' + record.pid + ' 端口 ' + record.port + '，先确认再清理');
    isPortInUse(record.port).then((inUse) => {
      if (!inUse) {
        clog('boot', '残留记录对应的端口 ' + record.port + ' 已空闲，无需清理');
        return resolve(false);
      }
      return looksLikeNovaiBackend(record.port).then((isNovai) => {
        if (!isNovai) {
          clog('boot', '端口 ' + record.port + ' 上的服务不是 NOVAI 后端，保留不动');
          return resolve(false);
        }
        execFile('netstat', ['-ano'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
          const listenPids = err ? [] : parseNetstatListenPids(stdout, record.port);
          // PID 会被系统复用：只有「记录里的 pid 正好是那个端口的监听者」才敢杀，宁可留着也不误杀。
          if (listenPids.indexOf(record.pid) < 0) {
            clog('boot', '端口 ' + record.port + ' 的监听进程不是记录的 PID ' + record.pid + '（' + listenPids.join(',') + '），不清理');
            return resolve(false);
          }
          clog('boot', '清理上次残留的后端进程树 PID ' + record.pid);
          freeBackendPort(6000, record.port).then(() => resolve(true));
        });
      });
    }).catch((err) => {
      clog('boot', '检查残留后端失败（不影响启动）: ' + ((err && err.message) || err));
      resolve(false);
    });
  });
}

// ---------- 托盘 ----------
function trayIconDirs() {
  const dirs = [];
  // 打包后图标在 Resources/icons（extraResources，asar 之外）；开发时在 desktop/icons。
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'icons'));
  dirs.push(path.join(__dirname, 'icons'));
  return dirs;
}

function loadTrayImage() {
  const dirs = trayIconDirs();
  const probe = (candidatePath) => {
    // 用和真正加载一样的路径探测：文件在但解不出图（损坏/格式不支持）时继续回退到下一个候选
    try {
      const image = nativeImage.createFromPath(candidatePath);
      return !!image && !image.isEmpty();
    } catch (_) {
      return false;
    }
  };
  const found = firstExistingTrayIcon(process.platform, dirs, probe);
  if (!found) {
    const tried = trayIconCandidates(process.platform, dirs).map((item) => item.path).join(' | ');
    clog('tray', '找不到可用托盘图标，已尝试: ' + tried);
    return null;
  }
  let image = nativeImage.createFromPath(found.path);
  if (found.template) {
    // macOS 模板图：系统按菜单栏明暗自动反色；@2x 同目录存在就补一层，Retina 下不糊
    try {
      const hi = nativeImage.createFromPath(found.path.replace(/\.png$/i, '@2x.png'));
      if (hi && !hi.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
    } catch (_) {}
    try { image.setTemplateImage(true); } catch (_) {}
  } else if (found.resize) image = image.resize({ width: found.resize, height: found.resize });
  clog('tray', '托盘图标: ' + found.path + (found.template ? '（macOS 菜单栏模板图）' : found.resize ? '（缩放到 ' + found.resize + 'px）' : ''));
  return image;
}

function createTray() {
  if (tray) return true;
  const image = loadTrayImage();
  if (!image) {
    clog('tray', '托盘不可用：图标加载失败（此时关闭窗口会直接退出应用）');
    return false;
  }
  try {
    tray = new Tray(image);
    tray.setToolTip('NOVAI — 无限画布');
    const menu = Menu.buildFromTemplate([
      { label: '显示主界面', click: () => { showMainWindow(); } },
      { type: 'separator' },
      {
        label: '退出 NOVAI',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    // macOS 状态栏图标：左键直接打开主界面（用户预期），菜单放到右键 / Control+点击。
    // 设了 setContextMenu 时 AppKit 会把左键也变成「弹菜单」，点一下打不开窗口。
    if (process.platform === 'darwin') {
      tray.on('click', () => { showMainWindow(); });
      tray.on('right-click', () => { try { tray.popUpContextMenu(menu); } catch (_) { /* 菜单弹出失败不影响打开窗口 */ } });
    } else {
      tray.setContextMenu(menu);
      tray.on('click', () => showMainWindow());
      // Windows 用户习惯双击托盘图标回到主界面
      tray.on('double-click', () => showMainWindow());
    }
    clog('tray', '托盘已创建');
    return true;
  } catch (err) {
    tray = null;
    clog('tray', '托盘创建失败: ' + (err && err.message || err));
    return false;
  }
}

function ensureTray() {
  if (tray) return true;
  return createTray();
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin' && app.dock && typeof app.dock.show === 'function') {
      try { app.dock.show(); } catch (_) {}
    }
    return true;
  }
  // 窗口已被销毁（例如关窗后进程仍在跑）：用最近一次的地址重建，而不是「点了没反应」
  if (appBaseUrl) {
    clog('win', '窗口不存在，重建窗口: ' + appBaseUrl);
    createWindow(appBaseUrl);
    return true;
  }
  clog('win', '没有可显示的窗口，且应用地址尚未确定（可能仍在启动）');
  return false;
}

// ---------- iframe 子页面迷你桥注入 ----------
const IFRAME_SHIM = `(function(){
  if (window.__novaiShimInjected) return;
  window.__novaiShimInjected = true;
  var pending = {};
  var seq = 0;
  window.addEventListener('message', function(e){
    if (!e.data || e.data.__novaiRes !== true) return;
    var p = pending[e.data.seq];
    if (p) { delete pending[e.data.seq]; p.resolve(e.data.result); }
  });
  // 被动事件通道：main preload 广播 { type:'novai:source-*', payload }，
  // 这里转成 document 上的 CustomEvent，画布页可 document.addEventListener(type) 监听。
  window.addEventListener('message', function(e){
    if (!e.data || typeof e.data.type !== 'string' || e.data.type.indexOf('novai:source-') !== 0) return;
    try { document.dispatchEvent(new CustomEvent(e.data.type, { detail: e.data.payload })); } catch(_) {}
  });
  function call(method, payload) {
    return new Promise(function(resolve){
      var id = ++seq;
      pending[id] = { resolve: resolve };
      try {
        (window.parent.postMessage || function(){})({ __novaiReq: true, seq: id, method: method, payload: payload }, '*');
      } catch(err) { resolve(null); }
    });
  }
  window.pywebview = {
    api: {
      minimize: function(){ return call('window', {action:'minimize'}); },
      maximize: function(){ return call('window', {action:'maximize'}); },
      close: function(){ return call('window', {action:'close'}); },
      quit_app: function(){ return call('window', {action:'quit'}); },
      save_file: function(d,f){ return call('save-file', {dataUrl:d, filename:f}); },
      select_directory: function(){ return call('select-directory'); },
      get_screen_sources: function(){ return call('recording-sources'); },
      select_screen_source: function(id){ return call('recording-select-source', {sourceId: id}); },
      open_data_dir: function(){ return call('open-data-dir'); },
      get_data_dir: function(){ return call('get-data-dir'); },
      set_auto_start: function(v){ return call('set-auto-start', {value: v}); },
      get_app_info: function(){ return call('get-app-info'); },
      open_source_view: function(s, r){
        if (s && typeof s === 'object') return call('source-view', Object.assign({action:'open'}, s, r ? {rect: r} : {}));
        return call('source-view', {action:'open', source: s, rect: r});
      },
      set_source_view_bounds: function(r){ return call('source-view', {action:'setBounds', rect: r}); },
      close_source_view: function(){ return call('source-view', {action:'close'}); },
      get_source_view_state: function(){ return call('source-view', {action:'state'}); },
      reload_source_view: function(){ return call('source-view', {action:'reload'}); },
      get_source_view_page_html: function(){ return call('source-view', {action:'page-html'}); },
      get_source_view_fetch_bytes: function(u, m){ return call('source-view', (typeof u === 'string' ? {action:'fetch-bytes', url: u, maxBytes: m} : Object.assign({action:'fetch-bytes'}, u || {}))); },
      get_last_guest_drag: function(){ return call('source-view', {action:'last-drag'}); },
      get_guest_drag_bytes: function(){ return call('source-view', {action:'guest-drag-bytes'}); },
      get_guest_drag_original: function(){ return call('source-view', {action:'guest-drag-original'}); },
      get_recent_source_media: function(){ return call('source-view', {action:'recent-media'}); },
      get_recent_custom_source_urls: function(){ return call('source-view', {action:'custom-urls'}); },
      set_source_zoom: function(m, v){ return call('source-view', {action:'source-zoom', mode: m, value: v}); },
      source_zoom_in: function(){ return call('source-view', {action:'source-zoom', mode:'in'}); },
      source_zoom_out: function(){ return call('source-view', {action:'source-zoom', mode:'out'}); },
      source_zoom_reset: function(){ return call('source-view', {action:'source-zoom', mode:'reset'}); },
      source_go_back: function(){ return call('source-view', {action:'source-nav', nav:'back'}); },
      source_go_forward: function(){ return call('source-view', {action:'source-nav', nav:'forward'}); },
      source_reload: function(){ return call('source-view', {action:'source-nav', nav:'reload'}); },
      set_source_ui_theme: function(theme){ return call('source-view', {action:'source-ui-theme', theme: theme}); },
      switch_source_site: function(site){ return call('source-view', {action:'source-site', site: site}); },
      fetch_source_url: function(u, r){ return call('source-view', (typeof u === 'string' ? {action:'fetch-url', url: u, referer: r} : Object.assign({action:'fetch-url'}, u || {}))); },
      open_source_browser: function(s){ return call('source-view', {action:'open', source: s}); },
      close_source_browser: function(){ return call('source-view', {action:'close'}); },
      get_source_browser_state: function(){ return call('source-view', {action:'state'}); },
    }
  };
  // 桌面版更新桥：iframe 里的页面也能转交给主进程的 electron-updater
  window.novaiUpdater = {
    checkNow: function(){ return call('update-check'); },
    downloadAndInstall: function(){ return call('update-install'); }
  };
  try { window.dispatchEvent(new Event('pywebviewready')); } catch(_) {}
})();`;

function injectIframeShims(webContents) {
  const injectFrame = async (frame) => {
    if (!frame || frame === webContents.mainFrame) return;
    try {
      if (frame.detached) return;
      const url = frame.url || '';
      if (!(url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost'))) return;
      await frame.executeJavaScript(IFRAME_SHIM, true);
    } catch (err) {
      // frame 已销毁 / 正在导航：静默，不打断页面
    }
  };
  // 递归收集所有子 frame（含嵌套 iframe），避开主 frame（主窗口自带 preload）。
  const injectChildFrames = () => {
    try {
      const all = [];
      const walk = (frame) => {
        const children = frame && frame.frames ? frame.frames : [];
        children.forEach((child) => {
          all.push(child);
          walk(child);
        });
      };
      walk(webContents.mainFrame);
      all.forEach((frame) => { injectFrame(frame); });
    } catch (err) {
      // 静默
    }
  };
  webContents.on('frame-created', (event, details) => {
    injectFrame(details && details.frame);
  });
  // 画布等 iframe 是 data-src 懒加载：frame-created 时 URL 还是 about:blank，之后真正
  // 导航到 /static/*.html 不会再触发 frame-created，shim 就永远缺失（iframe 里判定成网页版）。
  // 每个子 frame 加载完成后再扫一遍注入；shim 自带 __novaiShimInjected 守卫，重复执行安全。
  webContents.on('did-frame-finish-load', (event, isMainFrame) => {
    if (isMainFrame === true) return;
    injectChildFrames();
  });
  webContents.on('did-finish-load', () => {
    injectChildFrames();
  });
}

// ---------- 素材源内嵌浏览器（WebContentsView 叠层） ----------
// <webview> 在画布所在同源 iframe 内实测不附着（SMOKE_WEBVIEW inIframe=false），所以改用
// 主进程 WebContentsView 叠在主窗口上：画布 iframe 只画 UI 并上报面板 rect，浏览器本体在这里挂载。
const SOURCE_BROWSER_PARTITION = 'persist:novai-source-browser';
const SOURCE_BROWSERS = {
  pinterest: { label: 'Pinterest', url: 'https://www.pinterest.com/' },
  huaban: { label: '花瓣', url: 'https://huaban.com/' },
  xiaohongshu: { label: '小红书', url: 'https://www.xiaohongshu.com/explore' },
};

let sourceView = null;
let sourceViewSource = null;
let sourceViewLoaded = false;
let sourceViewAttached = false;   // view 是否挂在 contentView 上
let sourceViewVisible = false;    // 面板是否打开（关闭面板只是隐藏，view 保活）
let lastSourceViewRect = null;    // 上次面板 rect：关闭/重开时复用，前端传了 rect 则以其为准
let lastGuestDrag = null;         // 最近一次被拖拽元素的记录（来自 source-drag-preload）
// 自定义来源：最近 5 条用户手动输入的 http(s) 地址（main 侧为权威，内存即可）
const CUSTOM_SOURCE_KEY = 'custom';
const CUSTOM_URL_LIMIT = 5;
let lastCustomSourceUrls = [];
let lastSourceBoundsLogAt = 0;
let sourceBoundsReapplyTimer = null;  // setBounds 后 100ms 兜底重放，抵消拖动尾帧丢失
const SOURCE_ZOOM_MIN = 0.5;
const SOURCE_ZOOM_MAX = 3;
const SOURCE_ZOOM_STEP = 1.1;
const SOURCE_DEFAULT_ZOOM = 0.75;  // 在线素材默认 75%（打开/切换站点/重置都回到这里）
let sourceZoomShortcutsAttached = false;
// 双指滑动返回/前进：preload 的 wheel 与 Electron 原生 swipe 共用一个 300ms 去抖窗口。
// 注：macOS Chromium 自身可能还会触发 overscroll 导航；若真机出现双跳，可把该值调大或关闭原生 swipe。
const SOURCE_SWIPE_DEBOUNCE_MS = 300;
let lastSourceSwipeAt = 0;
// 注入式悬浮控件开关：默认开启（方案 A：悬停唤起）。设 NOVAI_INJECTED_SOURCE_CONTROLS=0 可关闭。
const SOURCE_INJECTED_CONTROLS = process.env.NOVAI_INJECTED_SOURCE_CONTROLS !== '0';
// 注入到内嵌页面的悬浮控件样式：webContents.insertCSS(user origin) 注入，不用 <style>（CSP 会拦）
const SOURCE_CONTROLS_CSS = [
  'img, picture, [style*="background-image"] { -webkit-user-drag: element !important; }',
  '#novai-source-controls { position: fixed !important; inset: 0 !important; z-index: 2147483000 !important; pointer-events: none !important; --novai-ui-compensate: 1; opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility .2s ease !important; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif !important; }',
  '#novai-source-controls[data-visible="true"] { opacity: 1 !important; visibility: visible !important; }',
  '#novai-source-controls .novai-controls-bottom { position: fixed !important; left: 50% !important; bottom: 16px !important; transform: translateX(-50%) scale(var(--novai-ui-compensate)) !important; transform-origin: center bottom !important; display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: center !important; gap: 6px !important; height: 38px !important; max-width: calc(100vw - 24px) !important; padding: 0 10px !important; box-sizing: border-box !important; pointer-events: none !important; }',
  '#novai-source-controls .novai-controls-group { display: flex !important; align-items: center !important; gap: 4px !important; position: static !important; transform: none !important; pointer-events: none !important; }',
  '#novai-source-controls[data-visible="true"] .novai-controls-bottom { pointer-events: auto !important; }',
  '#novai-source-controls[data-visible="true"] .novai-controls-group { pointer-events: auto !important; }',
  '#novai-source-controls[data-visible="false"] .novai-controls-btn { pointer-events: none !important; }',
  '#novai-source-controls .novai-controls-btn { appearance: none !important; -webkit-appearance: none !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; width: 27px !important; height: 27px !important; padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 999px !important; background: rgba(20, 20, 20, 0.72) !important; color: #ffffff !important; backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important; cursor: pointer !important; pointer-events: auto !important; font-size: 13px !important; line-height: 1 !important; transition: background .16s ease, transform .16s ease, opacity .16s ease !important; }',
  '#novai-source-controls .novai-controls-btn:hover { background: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), rgba(20, 20, 20, 0.72) !important; transform: scale(1.04) !important; }',
  '#novai-source-controls .novai-controls-btn:disabled { opacity: 0.45 !important; cursor: default !important; }',
  '#novai-source-controls svg { width: 14px !important; height: 14px !important; display: block !important; }',
  '#novai-source-controls .novai-zoom-cluster { display: inline-flex !important; align-items: center !important; gap: 0 !important; border-radius: 999px !important; background: rgba(20, 20, 20, 0.72) !important; backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important; overflow: hidden !important; }',
  '#novai-source-controls .novai-zoom-cluster .novai-controls-btn { width: 26px !important; height: 26px !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }',
  '#novai-source-controls .novai-zoom-cluster .novai-controls-btn:hover { background: rgba(255, 255, 255, 0.14) !important; }',
  '#novai-source-controls .novai-zoom-cluster .novai-zoom-value-btn { width: auto !important; min-width: 42px !important; padding: 0 4px !important; font-size: 11px !important; font-weight: 600 !important; letter-spacing: 0.2px !important; }',
  '#novai-source-controls .novai-zoom-value { color: #ffffff !important; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; font-variant-numeric: tabular-nums !important; }',
  '@media (max-width: 560px) { #novai-source-controls .novai-controls-bottom { gap: 4px !important; padding: 0 8px !important; } }',
  '#novai-source-controls[data-theme="light"] .novai-controls-btn, #novai-source-controls[data-theme="light"] .novai-zoom-cluster { background: rgba(250, 250, 250, 0.88) !important; color: #111111 !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-controls-btn:hover { background: linear-gradient(rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.06)), rgba(250, 250, 250, 0.88) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-zoom-cluster .novai-controls-btn { background: transparent !important; }',
  '#novai-source-controls[data-theme="light"] .novai-zoom-cluster .novai-controls-btn:hover { background: rgba(0, 0, 0, 0.06) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-zoom-value { color: #111111 !important; }',
].join('\n');
let sourceUiTheme = 'dark';
let sourceControlsCssKeys = [];
let sourceControlsCssOk = false;
let sourceControlsGuestOk = false;
let sourceControlsFallback = false;

let lastGuestPointerLogAt = 0;    // guest-pointer 诊断日志限流（每 2s 最多一条）

// 冒烟模式：只由 NOVAI_SMOKE_SOURCE=1 触发（自动验收用），正常启动完全不受影响。
function isSmokeMode() {
  return process.env.NOVAI_SMOKE_SOURCE === '1';
}

// 主窗口的 UA 被改成了 'Electron pywebview'，站点会拦；内嵌浏览器必须像普通 Chrome。
function sourceBrowserUserAgent() {
  const chrome = process.versions.chrome || '140.0.0.0';
  const platformToken = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return 'Mozilla/5.0 (' + platformToken + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
}

// 登录态保活：面板关闭只隐藏 view（不 close webContents），只有退出 / 切换来源 / 显式 reset 才销毁。
function isSourceViewAlive() {
  return !!(sourceView && sourceView.webContents && !sourceView.webContents.isDestroyed());
}

function isSourceViewVisible() {
  return sourceViewAttached && sourceViewVisible && isSourceViewAlive();
}

// 兼容旧调用：open 表示面板当前可见（隐藏中的 view 仍保活）
function isSourceViewOpen() {
  return isSourceViewVisible();
}

// 视图到底挂没挂在主窗口 contentView 上：以 Electron 的 children 为准（removeChildView 对非子视图是 no-op），
// 不信任自己记的 sourceViewAttached —— 前端重载、主窗口重建、异常路径都会让两者对不上。
function contentViewContainsView(view) {
  if (!view) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const contentView = mainWindow.contentView;
    if (!contentView) return false;
    const children = contentView.children;
    if (Array.isArray(children)) return children.indexOf(view) !== -1;
  } catch (_) {}
  return null; // 拿不到 children：未知
}

function isSourceViewAttachedToWindow() {
  const attached = contentViewContainsView(sourceView);
  return attached === null ? sourceViewAttached : attached;
}

// 摘除视图并回读真实状态。removeChildView 本身对非子视图是 no-op，不会抛；
// 回读仍挂在树上时返回 false，交给 hideSourceView 兜底销毁。
function contentViewRemoveView(view) {
  if (!view) return true;
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  try {
    const contentView = mainWindow.contentView;
    if (!contentView) return true;
    if (typeof contentView.removeChildView === 'function') contentView.removeChildView(view);
    const stillAttached = contentViewContainsView(view);
    return stillAttached === null ? true : stillAttached === false;
  } catch (err) {
    clog('source-view', '摘除视图失败: ' + (err && err.message || err));
    return false;
  }
}

function sourceViewState() {
  const open = isSourceViewVisible();
  let url = '';
  try { if (open && sourceView) url = String(sourceView.webContents.getURL() || ''); } catch (_) {}
  const zoomFactor = isSourceViewAlive() ? currentSourceZoom() : 1;
  const history = sourceHistoryState();
  return {
    ok: true,
    open: open,
    attached: isSourceViewAttachedToWindow(),
    source: open ? sourceViewSource : null,
    url: url,
    bounds: lastSourceViewRect,
    recentCustomUrls: lastCustomSourceUrls.slice(),
    zoomFactor: zoomFactor,
    zoomPercent: Math.round(zoomFactor * 100),
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
    theme: sourceUiTheme,
    controlsFallback: sourceControlsFallback,
    controlsMode: sourceControlsFallback ? 'main-window' : 'injected',
  };
}

// 关闭面板时把登录 cookie 刷到磁盘，下次启动不用重新登录
function flushSourceCookies() {
  try {
    session.fromPartition(SOURCE_BROWSER_PARTITION).cookies.flushStore().catch(() => {});
  } catch (_) {}
}

// ---------- 内嵌浏览器网络媒体请求捕获 ----------
// 小红书等站点的 <video> src 是 blob(MediaSource)，页面里 fetch 不到字节；
// 改从网络请求里拿到真实媒体地址，再用主进程 session.fetch 带 cookie/Referer 拉取。
// 只收视频类请求：避免 xhscdn 头像/图片把缓冲挤满（之前按域名收全放进来了）。
const MEDIA_BUFFER_LIMIT = 200;
const MEDIA_BUFFER_WINDOW_MS = 120000;
const MEDIA_URL_RE = /\.mp4|\.m3u8|\.m4s|\.ts(\?|$)/i;
const MEDIA_PATH_HINTS = ['/video/', '/stream/', '/media/', '/play/'];
const IMAGE_URL_RE = /\.(jpg|jpeg|png|webp|gif|avif|bmp)(\?|#|$)/i;

let recentMediaRequests = [];

function shouldCaptureMediaRequest(url, resourceType) {
  try {
    const type = String(resourceType || '').toLowerCase();
    const text = String(url || '');
    if (type === 'media') return true;
    if (MEDIA_URL_RE.test(text)) return true;
    if ((type === 'xhr' || type === 'fetch') && MEDIA_PATH_HINTS.some((hint) => text.toLowerCase().indexOf(hint) >= 0)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function headerContentType(headers) {
  try {
    const raw = headers && (headers['Content-Type'] || headers['content-type'] || headers['Content-type']);
    if (Array.isArray(raw)) return String(raw[0] || '');
    return String(raw || '');
  } catch (_) {
    return '';
  }
}

function isVideoContentType(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  if (text.indexOf('video/') === 0) return true;
  return text.indexOf('application/vnd.apple.mpegurl') >= 0
    || text.indexOf('application/x-mpegurl') >= 0
    || text.indexOf('application/mpegurl') >= 0;
}

function classifyMediaKind(url, contentType) {
  const ctype = String(contentType || '').toLowerCase();
  if (ctype) {
    if (isVideoContentType(ctype)) return 'video';
    if (ctype.indexOf('image/') === 0) return 'image';
    return 'other';
  }
  const text = String(url || '');
  if (MEDIA_URL_RE.test(text)) return 'video';
  if (IMAGE_URL_RE.test(text)) return 'image';
  return 'other';
}

// 最近 200 条环形缓冲（同 URL 去重并刷新时间，contentType 后到时补上），只留最近 120 秒
function recordMediaRequest(url, resourceType, pageUrl, contentType, force) {
  try {
    if (!url) return;
    const target = String(url);
    const type = String(contentType || '');
    if (force) {
      if (!type) return;
    } else if (!shouldCaptureMediaRequest(target, resourceType)) {
      return;
    }
    const kind = classifyMediaKind(target, type);
    const existing = recentMediaRequests.find((item) => item && item.url === target);
    if (existing) {
      existing.resourceType = String(resourceType || existing.resourceType || '');
      existing.pageUrl = String(pageUrl || existing.pageUrl || '');
      existing.time = Date.now();
      if (type) existing.contentType = type;
      existing.kind = classifyMediaKind(target, existing.contentType);
    } else {
      recentMediaRequests.push({
        url: target,
        resourceType: String(resourceType || ''),
        contentType: type,
        kind: kind,
        time: Date.now(),
        pageUrl: String(pageUrl || ''),
      });
      while (recentMediaRequests.length > MEDIA_BUFFER_LIMIT) recentMediaRequests.shift();
    }
    if (kind === 'video') {
      clog('source-view', '视频请求 ' + (type || '-') + ' ' + target.slice(0, 160));
    } else if (!existing) {
      clog('source-view', '媒体请求 ' + String(resourceType || '') + ' ' + target.slice(0, 160));
    }
  } catch (_) {}
}

function attachMediaRequestProbe(webContents) {
  try {
    const ses = (webContents && webContents.session) || session.fromPartition(SOURCE_BROWSER_PARTITION);
    const readPageUrl = () => {
      try { return webContents && !webContents.isDestroyed() ? webContents.getURL() : ''; } catch (_) { return ''; }
    };
    try { ses.webRequest.onBeforeRequest(null); } catch (_) {}
    try { ses.webRequest.onHeadersReceived(null); } catch (_) {}
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        if (details && details.url) recordMediaRequest(details.url, details.resourceType, readPageUrl(), '', false);
      } catch (_) {}
      try { callback({}); } catch (_) {}
    });
    // 以 response content-type 为准：video/*（含 mpegurl）才记，且这类记录优先返回
    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        if (details && details.url) {
          const type = headerContentType(details.responseHeaders);
          if (isVideoContentType(type)) recordMediaRequest(details.url, details.resourceType, readPageUrl(), type, true);
        }
      } catch (_) {}
      try { callback({}); } catch (_) {}
    });
  } catch (_) {}
}

function detachMediaRequestProbe() {
  try {
    const webRequest = session.fromPartition(SOURCE_BROWSER_PARTITION).webRequest;
    try { webRequest.onBeforeRequest(null); } catch (_) {}
    try { webRequest.onHeadersReceived(null); } catch (_) {}
  } catch (_) {}
}

// 渲染端没给 rect 时的兜底位置：贴主窗口右侧（主窗口隐藏时也能算）。
function defaultSourceViewRect() {
  const bounds = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getContentBounds()
    : { width: 1440, height: 900 };
  const width = Math.min(440, Math.max(320, bounds.width - 80));
  const height = Math.min(620, Math.max(320, bounds.height - 160));
  return { x: Math.max(16, bounds.width - width - 24), y: 96, width: width, height: height };
}

function normalizeSourceViewRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(80, Math.round(width)),
    height: Math.max(80, Math.round(height)),
  };
}

// 主窗口内容区尺寸（DIP）。所有 bounds 都要收敛进这块矩形：WebContentsView 是原生叠层，
// 一旦 bounds 越出窗口就会盖住窗口外的区域，甚至整窗铺满面板自己的关闭按钮。
function mainWindowContentSize() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getContentBounds();
      const width = Math.max(0, Math.round(Number(bounds.width) || 0));
      const height = Math.max(0, Math.round(Number(bounds.height) || 0));
      if (width > 0 && height > 0) return { width: width, height: height };
    }
  } catch (_) {}
  return { width: 0, height: 0 };
}

// 形变期间画布侧把原生视图挪出窗口用的哨兵坐标（source-browser.js 的 HIDDEN_RECT）
const SOURCE_VIEW_HIDDEN_SENTINEL = -10000;

function isHiddenSourceRect(rect) {
  const bounds = normalizeSourceViewRect(rect);
  return !!bounds && (bounds.x <= SOURCE_VIEW_HIDDEN_SENTINEL || bounds.y <= SOURCE_VIEW_HIDDEN_SENTINEL);
}

// 把渲染端 rect 夹回主窗口内容区：越界收缩、偏移挪回，窗口尺寸变化后也不会留一个越界/铺满的视图。
// 哨兵坐标（隐藏用）原样放行，但宽高压到 80，避免把“隐藏”变成一块大视图。
function clampSourceViewRectToWindow(rect, winSize) {
  const bounds = normalizeSourceViewRect(rect);
  if (!bounds) return null;
  if (bounds.x <= SOURCE_VIEW_HIDDEN_SENTINEL || bounds.y <= SOURCE_VIEW_HIDDEN_SENTINEL) {
    return { x: bounds.x, y: bounds.y, width: Math.min(bounds.width, 80), height: Math.min(bounds.height, 80) };
  }
  const win = winSize && Number(winSize.width) > 0 && Number(winSize.height) > 0 ? winSize : null;
  if (!win) return bounds;
  const x = Math.max(0, Math.min(bounds.x, win.width - 1));
  const y = Math.max(0, Math.min(bounds.y, win.height - 1));
  return {
    x: x,
    y: y,
    width: Math.max(1, Math.min(bounds.width, win.width - x)),
    height: Math.max(1, Math.min(bounds.height, win.height - y)),
  };
}

function applySourceViewBounds(rect) {
  if (!isSourceViewOpen()) return false;
  const bounds = clampSourceViewRectToWindow(rect, mainWindowContentSize());
  if (!bounds) return false;
  // 控件已移到画布页：rect 由画布侧算好（工具栏下方），这里只做窗口内收敛后 setBounds
  try {
    sourceView.setBounds(bounds);
    // 隐藏哨兵不能写进 lastSourceViewRect：关闭/切站之后重开按它会开到窗口外
    if (!isHiddenSourceRect(bounds)) lastSourceViewRect = bounds;
    const now = Date.now();
    if (now - lastSourceBoundsLogAt >= 150) {
      lastSourceBoundsLogAt = now;
      clog('source-view', 'bounds ' + JSON.stringify(bounds));
    }
    return true;
  } catch (err) {
    clog('source-view', 'setBounds 失败: ' + (err && err.message || err));
    return false;
  }
}

function setSourceViewBounds(rect) {
  return applySourceViewBounds(rect);
}

// ---------- 在线素材：内嵌网页缩放（Ctrl/Cmd +/-/0） ----------
function currentSourceZoom() {
  try {
    const factor = Number(sourceView.webContents.getZoomFactor());
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch (_) {
    return 1;
  }
}

function setSourceZoom(mode, value) {
  if (!isSourceViewAlive()) {
    return { ok: false, open: false, source: null, error: 'no-view', zoomFactor: 1, percent: 100 };
  }
  const op = String(mode || '').toLowerCase();
  const current = currentSourceZoom();
  let factor = current;
  if (op === 'in') factor = current * SOURCE_ZOOM_STEP;
  else if (op === 'out') factor = current / SOURCE_ZOOM_STEP;
  else if (op === 'reset') factor = SOURCE_DEFAULT_ZOOM;
  else if (op === 'set') factor = Number(value);
  else {
    return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: 'bad-zoom-action: ' + String(mode), zoomFactor: current, percent: Math.round(current * 100) };
  }
  if (!Number.isFinite(factor)) factor = current;
  factor = Math.min(SOURCE_ZOOM_MAX, Math.max(SOURCE_ZOOM_MIN, Math.round(factor * 1000) / 1000));
  try {
    sourceView.webContents.setZoomFactor(factor);
  } catch (err) {
    return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: String(err && err.message || err), zoomFactor: current, percent: Math.round(current * 100) };
  }
  const percent = Math.round(factor * 100);
  clog('source-view', 'zoom ' + percent + '%');
  sendSourceUiState();
  return { ok: true, open: isSourceViewOpen(), source: sourceViewSource, zoomFactor: factor, percent: percent };
}

function resetSourceZoom() {
  try {
    if (isSourceViewAlive()) sourceView.webContents.setZoomFactor(SOURCE_DEFAULT_ZOOM);
  } catch (_) {}
}

function sourceZoomKeyAction(input) {
  const key = String((input && input.key) || '');
  const code = String((input && input.code) || '');
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return 'in';
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return '';
}

function handleSourceZoomShortcut(event, input) {
  try {
    if (!input || input.type !== 'keyDown') return;
    if (!(input.control || input.meta)) return;
    if (!isSourceViewAlive() || !sourceView.webContents.isFocused()) return;
    const action = sourceZoomKeyAction(input);
    if (!action) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setSourceZoom(action);
  } catch (_) {}
}

// 内嵌页面有焦点时画布页收不到 keydown（键盘事件被原生视图吃掉），Esc 只能在这里兜底：
// 视图万一盖住了画布面板的 ×，这是用户一定还能用的关闭入口。
function handleSourceEscapeKey(event, input) {
  try {
    if (!input || input.type !== 'keyDown') return;
    if (String(input.key || '') !== 'Escape') return;
    if (!isSourceViewOpen()) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    hideSourceView();
    const closedState = sourceViewState();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novai:source-view-closed', closedState);
    } catch (_) {}
    clog('source-view', 'Esc 关闭面板');
  } catch (_) {}
}

function sourceHistoryState() {
  if (!isSourceViewAlive()) return { canGoBack: false, canGoForward: false };
  const wc = sourceView.webContents;
  try {
    if (wc.navigationHistory) {
      return {
        canGoBack: typeof wc.navigationHistory.canGoBack === 'function' ? !!wc.navigationHistory.canGoBack() : false,
        canGoForward: typeof wc.navigationHistory.canGoForward === 'function' ? !!wc.navigationHistory.canGoForward() : false,
      };
    }
    return {
      canGoBack: typeof wc.canGoBack === 'function' ? !!wc.canGoBack() : false,
      canGoForward: typeof wc.canGoForward === 'function' ? !!wc.canGoForward() : false,
    };
  } catch (_) {
    return { canGoBack: false, canGoForward: false };
  }
}

function navigateSourceView(action) {
  if (!isSourceViewAlive()) {
    return { ok: false, open: false, source: null, error: 'no-view', canGoBack: false, canGoForward: false };
  }
  const wc = sourceView.webContents;
  const op = String(action || '').toLowerCase();
  try {
    if (op === 'back') {
      if (wc.navigationHistory && typeof wc.navigationHistory.goBack === 'function') wc.navigationHistory.goBack();
      else if (typeof wc.canGoBack === 'function' && wc.canGoBack()) wc.goBack();
      else return Object.assign({ ok: false, error: 'cannot-go-back', open: isSourceViewOpen(), source: sourceViewSource }, sourceHistoryState());
    } else if (op === 'forward') {
      if (wc.navigationHistory && typeof wc.navigationHistory.goForward === 'function') wc.navigationHistory.goForward();
      else if (typeof wc.canGoForward === 'function' && wc.canGoForward()) wc.goForward();
      else return Object.assign({ ok: false, error: 'cannot-go-forward', open: isSourceViewOpen(), source: sourceViewSource }, sourceHistoryState());
    } else if (op === 'reload') {
      wc.reload();
    } else {
      return Object.assign({ ok: false, error: 'bad-nav-action', open: isSourceViewOpen(), source: sourceViewSource }, sourceHistoryState());
    }
  } catch (err) {
    return Object.assign({ ok: false, error: String(err && err.message || err), open: isSourceViewOpen(), source: sourceViewSource }, sourceHistoryState());
  }
  const state = sourceHistoryState();
  setTimeout(sendSourceUiState, 80);
  return { ok: true, open: isSourceViewOpen(), source: sourceViewSource, canGoBack: state.canGoBack, canGoForward: state.canGoForward };
}

function handleSourceSwipe(direction) {
  const now = Date.now();
  if (now - lastSourceSwipeAt < SOURCE_SWIPE_DEBOUNCE_MS) {
    return { ok: false, debounced: true, direction: direction };
  }
  const navAction = direction === 'back' ? 'back' : direction === 'forward' ? 'forward' : '';
  if (!navAction) return { ok: false, error: 'bad-swipe-direction', direction: direction };
  lastSourceSwipeAt = now;
  return navigateSourceView(navAction);
}

function sourceUiStatePayload() {
  const history = sourceHistoryState();
  const zoomFactor = isSourceViewAlive() ? currentSourceZoom() : 1;
  return {
    theme: sourceUiTheme,
    site: sourceViewSource || '',
    zoomPercent: Math.round(zoomFactor * 100),
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
    recentCustomUrls: lastCustomSourceUrls.slice(0, 5),
    controlsFallback: sourceControlsFallback,
  };
}

function sendSourceTheme() {
  if (!isSourceViewAlive()) return;
  try { sourceView.webContents.send('novai:source-theme', { theme: sourceUiTheme }); } catch (_) {}
}

function sendSourceUiState() {
  if (!isSourceViewAlive()) return;
  try { sourceView.webContents.send('novai:source-ui-state', sourceUiStatePayload()); } catch (_) {}
}

function setSourceControlsFallback(fallback, reason) {
  if (!SOURCE_INJECTED_CONTROLS) {
    sourceControlsFallback = false;
    return;
  }
  const next = Boolean(fallback);
  if (next === sourceControlsFallback) return;
  sourceControlsFallback = next;
  if (next) {
    clog('source-view', '悬浮控件注入失效，回退主窗口 HTML 控件 + 缩小 view 高度: ' + String(reason || ''));
  } else {
    clog('source-view', '悬浮控件注入恢复');
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('novai:source-controls-fallback', { fallback: next, reason: String(reason || '') });
    }
  } catch (_) {}
  // fallback 切换会改变可用高度：按上次 rect 重新应用一次
  if (lastSourceViewRect) applySourceViewBounds(lastSourceViewRect);
  sendSourceUiState();
}

function applySourceControlsCss() {
  if (!SOURCE_INJECTED_CONTROLS) return;  // 默认关闭：不注入控件 CSS
  if (!isSourceViewAlive()) return;
  const wc = sourceView.webContents;
  const previous = sourceControlsCssKeys.slice();
  sourceControlsCssKeys = [];
  previous.forEach((key) => {
    try { wc.removeInsertedCSS(key).catch(() => {}); } catch (_) {}
  });
  try {
    wc.insertCSS(SOURCE_CONTROLS_CSS, { cssOrigin: 'user' }).then((key) => {
      sourceControlsCssKeys.push(key);
      sourceControlsCssOk = true;
      if (!sourceControlsGuestOk && !sourceControlsFallback) {
        // guest 还没回报：先不判失败，等 guest-ready / 超时
      }
      if (sourceControlsFallback && sourceControlsGuestOk) setSourceControlsFallback(false, 'css-ok');
      sendSourceUiState();
    }).catch((err) => {
      sourceControlsCssOk = false;
      clog('source-view', 'insertCSS 失败: ' + String(err && err.message || err));
      setSourceControlsFallback(true, 'insertCSS-failed');
    });
  } catch (err) {
    sourceControlsCssOk = false;
    clog('source-view', 'insertCSS 抛错: ' + String(err && err.message || err));
    setSourceControlsFallback(true, 'insertCSS-threw');
  }
}

async function handleGuestControl(payload) {
  const action = String(payload && payload.action || '');
  if (action === 'back' || action === 'forward') return navigateSourceView(action);
  if (action === 'zoom') return setSourceZoom(payload && payload.mode, payload && payload.value);
  if (action === 'refresh') {
    if (isSourceViewAlive()) {
      try { sourceView.webContents.reload(); } catch (_) {}
    }
    return { ok: true, open: isSourceViewOpen(), source: sourceViewSource };
  }
  if (action === 'close') {
    clog('source-view', '关闭面板（来自内嵌控件）');
    hideSourceView();
    const closedState = sourceViewState();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novai:source-view-closed', closedState);
    } catch (_) {}
    return { ok: true, open: false, source: null, state: closedState };
  }
  if (action === 'site') {
    const site = String(payload && payload.site || '');
    if (site === 'custom') {
      // 自定义：优先用本次传入的 URL（覆盖历史），历史只用于预填
      const explicitUrl = normalizeCustomSourceUrl(payload && payload.url);
      if (explicitUrl) {
        return await openSourceView('custom', lastSourceViewRect, { url: explicitUrl, sourceKey: 'custom' });
      }
      const lastCustomUrl = lastCustomSourceUrls[0] || '';
      if (lastCustomUrl) {
        return await openSourceView('custom', lastSourceViewRect, { url: lastCustomUrl, sourceKey: 'custom' });
      }
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novai:source-custom-request', { reason: 'no-custom-url' });
      } catch (_) {}
      clog('source-view', '自定义站点：还没有历史地址，已通知画布弹输入');
      return { ok: false, error: 'custom-url-required', needUrl: true };
    }
    if (!SOURCE_BROWSERS[site]) return { ok: false, error: 'bad-site: ' + site };
    return await openSourceView(site, lastSourceViewRect);
  }
  return { ok: false, error: 'bad-control: ' + action };
}

function attachSourceZoomShortcuts(webContents) {
  try {
    if (webContents && typeof webContents.on === 'function') {
      webContents.on('before-input-event', handleSourceZoomShortcut);
    }
  } catch (_) {}
}

// 外站首屏可能很慢，8s 超时按成功处理（慢 ≠ 失败）；只有明确的、非 -3 主框架错误才算失败。
// 花瓣这类站点首页会自己 location.href 自刷新，Chromium 用 ERR_ABORTED(-3) 中断旧导航，
// 这不是失败——继续等新的 did-finish-load（谁先到谁结算，只结算一次）。
function loadSourceViewUrl(webContents, loadFn, url) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    function finish(errMsg) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        webContents.removeListener('did-finish-load', onFinish);
        webContents.removeListener('did-fail-load', onFail);
      } catch (_) {}
      resolve(errMsg);
    }
    function onFinish() {
      finish(null);
    }
    function onFail(e, code, desc, validatedURL, isMainFrame) {
      if (isMainFrame === false) return;
      if (code === -3) {
        clog('source-view', '导航被站点替换（ERR_ABORTED），继续等待: ' + (validatedURL || url));
        return;
      }
      const msg = (desc || '加载失败') + ' (' + code + ')';
      clog('source-view', '加载失败 ' + (validatedURL || url) + ': ' + msg);
      finish(msg);
    }
    timer = setTimeout(() => {
      clog('source-view', '等待加载超时，按成功处理: ' + url);
      finish(null);
    }, 8000);
    webContents.once('did-finish-load', onFinish);
    webContents.on('did-fail-load', onFail);
    try {
      // loadURL 的 rejection 也包含被自刷新打断的 ERR_ABORTED，统一交给上面的 did-fail-load 判定。
      const navigation = loadFn();
      if (navigation && typeof navigation.catch === 'function') navigation.catch(() => {});
    } catch (err) {
      const msg = String(err && err.message || err);
      clog('source-view', '加载失败 ' + url + ': ' + msg);
      finish(msg);
    }
  });
}

function createSourceView() {
  const userAgent = sourceBrowserUserAgent();
  // 持久化 partition：登录态只写在本机，退出不丢，也不会上传。
  try { session.fromPartition(SOURCE_BROWSER_PARTITION).setUserAgent(userAgent); } catch (_) {}
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SOURCE_BROWSER_PARTITION,
      // 只负责记录拖拽元素（真实媒体地址），不注入 UI、不改页面
      preload: path.join(__dirname, 'source-drag-preload.js'),
    },
  });
  const wc = view.webContents;
  // 深色底：缩放/拖动面板时新暴露的区域先铺底色，避免闪白
  try { view.setBackgroundColor('#0f0f0f'); } catch (_) {}
  wc.setUserAgent(userAgent);
  attachRendererConsole(wc, 'source-view');
  attachMediaRequestProbe(wc);
  // Ctrl/Cmd +/-/0：主窗口与内嵌 view 都挂 before-input-event（view 有自己的焦点）
  attachSourceZoomShortcuts(wc);
  // Esc 关闭面板：页面焦点在内嵌视图里时，画布页的 Esc 收不到
  wc.on('before-input-event', handleSourceEscapeKey);
  // macOS 触控板原生 swipe（三指/部分触控板）；right → back，left → forward，与 wheel 共用去抖
  // 页面每次 dom-ready 都重注入控件 CSS（导航/站点重写后可能丢）
  wc.on('dom-ready', () => {
    if (!SOURCE_INJECTED_CONTROLS) {
      sendSourceTheme();
      setTimeout(sendSourceUiState, 40);
      return;
    }
    sourceControlsGuestOk = false;
    applySourceControlsCss();
    sendSourceTheme();
    setTimeout(sendSourceUiState, 40);
    setTimeout(() => {
      // guest preload 没回报控件状态 → 认为注入失效，走 fallback
      if (!sourceControlsGuestOk && !sourceControlsCssOk) setSourceControlsFallback(true, 'guest-timeout');
    }, 2500);
  });
  wc.on('swipe', (event, direction) => {
    try { if (event && typeof event.preventDefault === 'function') event.preventDefault(); } catch (_) {}
    const mapped = direction === 'right' ? 'back' : direction === 'left' ? 'forward' : '';
    if (mapped) handleSourceSwipe(mapped);
  });
  if (!sourceZoomShortcutsAttached && mainWindow && !mainWindow.isDestroyed()) {
    attachSourceZoomShortcuts(mainWindow.webContents);
    sourceZoomShortcutsAttached = true;
  }
  wc.on('did-finish-load', () => { sourceViewLoaded = true; });
  wc.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame === false) return;
    if (code === -3) {
      clog('source-view', '导航被站点替换（ERR_ABORTED），继续等待: ' + (validatedURL || ''));
      return;
    }
    clog('source-view', 'did-fail-load ' + code + ' ' + desc + ' ' + (validatedURL || ''));
  });
  // 域名白名单只约束初始入口（openSourceView 里校验）。用户在视图内的导航允许任意
  // http(s)：Google/Facebook/Apple 登录、点进 pin 原图站点都要能走，只拦 file:/javascript:/data: 等。
  wc.on('will-navigate', (event, target) => {
    if (!/^https?:/i.test(String(target || ''))) {
      event.preventDefault();
      clog('source-view', '拦截非 http(s) 导航: ' + String(target || ''));
    }
  });
  // 登录弹窗也放回同一个 view，保住 session；只接受 http(s)，其余拒绝。
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(String(target || ''))) {
      loadSourceViewUrl(wc, () => wc.loadURL(target), target).catch(() => {});
    } else {
      clog('source-view', '拦截非 http(s) 弹窗: ' + String(target || ''));
    }
    return { action: 'deny' };
  });
  return view;
}

function normalizeCustomSourceUrl(target) {
  try {
    const parsed = new URL(String(target || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function rememberCustomSourceUrl(url) {
  const value = String(url || '').trim();
  if (!value) return;
  lastCustomSourceUrls = [value].concat(lastCustomSourceUrls.filter((item) => item !== value)).slice(0, CUSTOM_URL_LIMIT);
}

async function openSourceView(source, rect, options) {
  const opts = options || {};
  const requestedKey = String(opts.sourceKey || source || '');
  const customUrl = normalizeCustomSourceUrl(opts.url);
  // 自定义来源：任意 http(s)（仅用户手动输入地址）；file:/javascript: 一律拒绝
  const isCustom = requestedKey === CUSTOM_SOURCE_KEY || (!SOURCE_BROWSERS[requestedKey] && !!customUrl);
  let preset = SOURCE_BROWSERS[requestedKey];
  let url = '';
  if (isCustom) {
    if (!customUrl) {
      const error = '自定义来源地址无效（仅支持 http/https）: ' + String(opts.url || '');
      clog('source-view', error);
      return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: error };
    }
    preset = { label: '自定义', url: customUrl };
    url = customUrl;
  } else {
    if (!preset) {
      const error = '不支持的素材来源: ' + String(source);
      clog('source-view', error);
      return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: error };
    }
    url = String(opts.url || preset.url);
    if (!isAllowedWebviewUrl(url)) {
      const error = '素材来源不在白名单: ' + url;
      clog('source-view', error);
      return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: error };
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, open: false, source: null, error: '主窗口不可用' };
  }
  const effectiveSourceKey = isCustom ? CUSTOM_SOURCE_KEY : requestedKey;
  // 切换来源站点：不同站点不共用 view，旧 view 销毁；同站重开则复用
  if (isSourceViewAlive() && sourceViewSource && sourceViewSource !== effectiveSourceKey) destroySourceView();
  const currentUrl = isSourceViewAlive() ? String(sourceView.webContents.getURL() || '') : '';
  const sameSource = isSourceViewAlive() && sourceViewSource === effectiveSourceKey && !!currentUrl && (!isCustom || currentUrl === url);
  if (!isSourceViewAlive()) {
    sourceView = createSourceView();
    sourceViewLoaded = false;
    sourceViewAttached = false;
  }
  const view = sourceView;
  sourceViewSource = effectiveSourceKey;
  if (isCustom) rememberCustomSourceUrl(url);
  // 保活：面板重新打开时把同一个 view 挂回窗口，不重建、不重新登录。
  // 以窗口 children 为准：前端重载/异常后 sourceViewAttached 可能与实际不符，漏挂会让视图永远不出现。
  if (!isSourceViewAttachedToWindow()) {
    try {
      mainWindow.contentView.addChildView(view);
      sourceViewAttached = true;
    } catch (err) {
      const msg = String(err && err.message || err);
      clog('source-view', '挂载失败: ' + msg);
      destroySourceView();
      return { ok: false, open: false, source: null, error: msg };
    }
  } else {
    // children 回读已挂着、本地 flag 却是 false（重载/异常后）：先把状态对齐，
    // 否则 isSourceViewOpen() 一直为 false，后面的 bounds 会被整段丢掉。
    sourceViewAttached = true;
  }
  try { view.setVisible(true); } catch (_) {}
  sourceViewVisible = true;
  // 每次打开/切站都强制回到默认 75%（Boss 要求，不沿用上次手动缩放）
  try { view.webContents.setZoomFactor(SOURCE_DEFAULT_ZOOM); } catch (_) {}
  // 前端传 rect 则以其为准；没传时复现上次面板尺寸（关闭/重开保持宽度）
  applySourceViewBounds(rect || lastSourceViewRect || defaultSourceViewRect());
  if (sameSource) {
    sendSourceTheme();
    sendSourceUiState();
    return { ok: true, open: true, source: sourceViewSource, url: currentUrl, bounds: lastSourceViewRect };
  }
  const error = await loadSourceViewUrl(view.webContents, () => view.webContents.loadURL(url), url);
  if (error) return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: error };
  // 打开请求可能要等首屏好几秒；这期间面板被关掉 / 切了站点时，不能再把状态翻回“可见”，也
  // 不能把视图留在窗口上（前端此刻的 nativeOpen 还是 false，靠它会漏发关闭命令）。
  if (sourceView !== view) {
    // 这次打开已被切站取代：告诉前端别用这个结果改状态（新站点自己有并行的打开流程）
    return { ok: true, open: false, superseded: true, source: null, url: url, bounds: lastSourceViewRect };
  }
  if (!sourceViewVisible) {
    hideSourceView();
    return { ok: true, open: false, superseded: true, source: null, url: url, bounds: lastSourceViewRect };
  }
  sendSourceTheme();
  sendSourceUiState();
  return { ok: true, open: isSourceViewOpen(), source: sourceViewSource, url: url, bounds: lastSourceViewRect };
}

// 关闭面板：只隐藏 view，不销毁 webContents —— 页面状态和登录态都保留。
// 幂等：状态是否同步、调几次都行；每次都以“窗口上确实没有这个视图”为结束条件。
function hideSourceView() {
  sourceViewVisible = false;
  // 关闭面板时把缩放复位到默认 75%（下次打开强制默认）
  if (sourceBoundsReapplyTimer) { clearTimeout(sourceBoundsReapplyTimer); sourceBoundsReapplyTimer = null; }
  if (!isSourceViewAlive()) {
    if (sourceView) contentViewRemoveView(sourceView);
    sourceViewAttached = false;
    return;
  }
  // 先整块隐藏：即使摘除失败，也不让它继续挡在画布上（setVisible 是原生层的最后一道保险）
  try { sourceView.setVisible(false); } catch (_) {}
  const removed = contentViewRemoveView(sourceView);
  sourceViewAttached = false;
  if (!removed && isSourceViewAlive()) {
    // 回读仍挂在窗口上（父视图异常）：直接销毁。少一个登录态，总比关不掉的页面强。
    clog('source-view', '视图摘除后仍在窗口上，改为销毁视图');
    destroySourceView();
    sourceViewVisible = false;
    sourceViewAttached = false;
    return;
  }
  resetSourceZoom();
  flushSourceCookies();
}

// 真正销毁：只用于应用退出 / 切换来源站点 / 显式 reset
function destroySourceView() {
  const view = sourceView;
  sourceView = null;
  sourceViewSource = null;
  sourceViewLoaded = false;
  sourceViewAttached = false;
  sourceViewVisible = false;
  lastGuestDrag = null;
  if (sourceBoundsReapplyTimer) { clearTimeout(sourceBoundsReapplyTimer); sourceBoundsReapplyTimer = null; }
  detachMediaRequestProbe();
  if (!view) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  } catch (_) {}
  flushSourceCookies();
  try {
    view.webContents.close();
  } catch (err) {
    clog('source-view', '销毁失败: ' + (err && err.message || err));
    try { view.webContents.destroy(); } catch (_) {}
  }
}

// 统一处理 source-view / source-browser 两个 channel（旧的 source-browser 保留做前端兼容）。
async function handleSourceViewAction(payload) {
  const action = payload && payload.action;
  try {
    if (action === 'open') {
      return await openSourceView(payload.source, payload.rect, { url: payload.url, sourceKey: payload.sourceKey });
    }
    if (action === 'setBounds') {
      const ok = setSourceViewBounds(payload.rect);
      const retryRect = normalizeSourceViewRect(payload.rect);
      // 拖动尾帧偶尔丢：100ms 后用同一 rect 兜底再应用一次（防抖，只保留最后一次）
      if (ok && retryRect) {
        if (sourceBoundsReapplyTimer) clearTimeout(sourceBoundsReapplyTimer);
        sourceBoundsReapplyTimer = setTimeout(() => {
          sourceBoundsReapplyTimer = null;
          if (!isSourceViewAlive()) return;
          // 走同一条夹取路径：重放的 rect 也要收敛进窗口，不能绕开窗口边界
          applySourceViewBounds(retryRect);
        }, 100);
      }
      return { ok: ok, open: isSourceViewOpen(), source: sourceViewSource, bounds: lastSourceViewRect };
    }
    if (action === 'source-ui-theme') {
      sourceUiTheme = String(payload.theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
      sendSourceTheme();
      sendSourceUiState();
      return { ok: true, theme: sourceUiTheme };
    }
    if (action === 'source-close') {
      clog('source-view', '关闭面板（来自内嵌控件）');
      hideSourceView();
      const closedState = sourceViewState();
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novai:source-view-closed', closedState);
      } catch (_) {}
      return { ok: true, open: false, source: null, state: closedState };
    }
    if (action === 'source-site') {
      const site = String(payload.site || payload.source || '');
      if (site === 'custom') {
        const explicitUrl = normalizeCustomSourceUrl(payload.url);
        if (explicitUrl) {
          return await openSourceView('custom', lastSourceViewRect, { url: explicitUrl, sourceKey: 'custom' });
        }
      }
      if (!SOURCE_BROWSERS[site]) return { ok: false, error: 'bad-site: ' + site };
      return await openSourceView(site, lastSourceViewRect);
    }
    if (action === 'source-nav') {
      const nav = payload.nav || payload.mode || payload.direction || payload.navAction || '';
      return navigateSourceView(nav);
    }
    if (action === 'source-zoom') {
      const mode = payload.mode || payload.zoomAction || payload.zoom || payload.direction || (payload.value !== undefined ? 'set' : '');
      const value = payload.value !== undefined ? payload.value : payload.factor;
      return setSourceZoom(mode, value);
    }
    if (action === 'custom-urls') {
      return { ok: true, items: lastCustomSourceUrls.slice() };
    }
    if (action === 'close') {
      // 关闭面板 = 隐藏（保活登录态），不销毁 view
      hideSourceView();
      return { ok: true, open: false, source: null };
    }
    if (action === 'reset') {
      // 退出登录 / 重置：真正销毁当前 view
      destroySourceView();
      return { ok: true, open: false, source: null };
    }
    if (action === 'reload') {
      if (!isSourceViewAlive()) return { ok: true, open: false, source: null };
      try {
        sourceView.webContents.reload();
      } catch (err) {
        const msg = String(err && err.message || err);
        clog('source-view', 'reload 失败: ' + msg);
        return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: msg };
      }
      return { ok: true, open: true, source: sourceViewSource };
    }
    // 内嵌站点抓不到（服务端抓会被反爬拦）：把已加载页面 HTML 交给后端解析
    if (action === 'page-html') {
      if (!isSourceViewAlive()) return { ok: true, url: '', title: '', html: '' };
      try {
        const page = await sourceView.webContents.executeJavaScript(
          "({ url: location.href, title: document.title, html: document.documentElement.outerHTML.slice(0, 1.8 * 1024 * 1024) })",
          true
        );
        return {
          ok: true,
          url: String((page && page.url) || ''),
          title: String((page && page.title) || ''),
          html: String((page && page.html) || ''),
        };
      } catch (err) {
        const msg = String(err && err.message || err);
        clog('source-view', 'page-html 失败: ' + msg);
        return { ok: false, error: msg };
      }
    }
    // 兜底通道：在页面上下文里带登录态抓二进制；跨域仍受站点 CORS 限制
    if (action === 'fetch-bytes') {
      if (!isSourceViewAlive()) return { ok: false, error: 'no-view' };
      // 上限压到 30MB：视频等大文件超限直接 too-large，别把 Electron 拖死
      const requestedBytes = Number(payload.maxBytes);
      const maxBytes = Number.isFinite(requestedBytes) && requestedBytes > 0
        ? Math.min(30 * 1024 * 1024, Math.max(1, Math.floor(requestedBytes)))
        : 25 * 1024 * 1024;
      const targetUrl = String(payload.url || '');
      const script = `(function(){
        var url = ${JSON.stringify(targetUrl)};
        var maxBytes = ${maxBytes};
        function readOnce(credentials) {
          return fetch(url, { credentials: credentials }).then(function(r){
            if (!r.ok) return { ok: false, status: r.status };
            return r.blob().then(function(b){
              if (b.size > maxBytes) return { ok: false, error: 'too-large', size: b.size };
              return b.arrayBuffer().then(function(buf){
                var s = '';
                var u8 = new Uint8Array(buf);
                var CH = 0x8000;
                for (var i = 0; i < u8.length; i += CH) {
                  s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
                }
                var type = r.headers.get('content-type') || b.type || 'application/octet-stream';
                return { ok: true, contentType: r.headers.get('content-type') || b.type || '', size: b.size, dataUrl: 'data:' + type + ';base64,' + btoa(s) };
              });
            });
          });
        }
        // 公共 CDN（i.pinimg.com 等）返回 ACAO:* + ACAC:false：带凭据必被 CORS 挡，去掉凭据就放行
        return readOnce('include').then(function(first){
          if (first.ok) return first;
          return readOnce('omit');
        }).catch(function(){ return readOnce('omit'); }).catch(function(e){ return { ok: false, error: String(e && e.message || e) }; });
      })()`;
      try {
        return await sourceView.webContents.executeJavaScript(script, true);
      } catch (err) {
        const msg = String(err && err.message || err);
        clog('source-view', 'fetch-bytes 失败: ' + msg);
        return { ok: false, error: msg };
      }
    }
    if (action === 'recent-media') {
      // 只返回最近 120 秒内抓到的媒体请求；补上 kind 且视频优先（前端只取 kind==='video'）
      try {
        const now = Date.now();
        const fresh = (recentMediaRequests || [])
          .filter((item) => item && (now - item.time) <= MEDIA_BUFFER_WINDOW_MS)
          .map((item) => ({
            url: item.url,
            resourceType: item.resourceType || '',
            contentType: item.contentType || '',
            kind: classifyMediaKind(item.url, item.contentType),
            time: item.time,
            pageUrl: item.pageUrl || '',
          }));
        const videos = fresh.filter((item) => item.kind === 'video');
        const others = fresh.filter((item) => item.kind !== 'video');
        return { ok: true, items: videos.concat(others) };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }
    if (action === 'fetch-url') {
      // 主进程 session.fetch：不受 CORS 限制、带 partition 里的登录 cookie；限制 30MB
      // 不设置 Referer（Chromium 会把带 Referer 的 session.fetch 拦成 ERR_BLOCKED_BY_CLIENT）
      const targetUrl = String(payload.url || '');
      const maxBytes = 30 * 1024 * 1024;
      try {
        const headers = { 'User-Agent': sourceBrowserUserAgent() };
        const response = await session.fromPartition(SOURCE_BROWSER_PARTITION).fetch(targetUrl, { headers: headers });
        const status = response.status;
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
          clog('source-view', 'fetch-url ' + targetUrl.slice(0, 160) + ' -> ' + status);
          return { ok: false, status: status };
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
          clog('source-view', 'fetch-url too-large ' + targetUrl.slice(0, 160) + ' -> ' + buffer.length + 'B');
          return { ok: false, error: 'too-large', size: buffer.length };
        }
        const dataUrl = 'data:' + (contentType || 'application/octet-stream') + ';base64,' + buffer.toString('base64');
        clog('source-view', 'fetch-url ' + targetUrl.slice(0, 160) + ' -> ' + status + ' ' + (contentType || '') + ' ' + buffer.length + 'B');
        return { ok: true, status: status, contentType: contentType, size: buffer.length, dataUrl: dataUrl };
      } catch (err) {
        const msg = String(err && err.message || err);
        clog('source-view', 'fetch-url 失败 ' + targetUrl.slice(0, 160) + ': ' + msg);
        return { ok: false, error: msg };
      }
    }
    if (action === 'guest-drag-bytes') {
      const record = lastGuestDrag;
      if (!record) return { ok: false, error: 'no-drag' };
      if (!record.bytesPromise) return { ok: false, error: 'no-image-prefetch' };
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), GUEST_DRAG_PREFETCH_TIMEOUT_MS));
      const result = await Promise.race([record.bytesPromise, timeout]);
      if (!result) return { ok: false, error: '等待图片预取超时（20s）' };
      if (!result.ok) return { ok: false, error: result.error || '图片预取失败' };
      return result;
    }
    if (action === 'guest-drag-original') {
      const record = lastGuestDrag;
      if (!record) return { ok: false, error: 'no-drag' };
      if (!record.originalPromise) return { ok: false, error: 'no-image-prefetch' };
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 60000));
      const result = await Promise.race([record.originalPromise, timeout]);
      if (!result) return { ok: false, error: '等待原图超时（60s）' };
      if (!result.ok) return { ok: false, error: result.error || '原图下载失败' };
      return result;
    }
    if (action === 'last-drag') {
      // 超过 60 秒视为过期，避免把很久以前拖过的元素当成本次拖拽
      const entry = lastGuestDrag && (Date.now() - lastGuestDrag.receivedAt) <= 60000 ? lastGuestDrag : null;
      return { ok: true, drag: entry ? entry.payload : null };
    }
    if (action === 'state') return sourceViewState();
    return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: '未知 action: ' + String(action) };
  } catch (err) {
    const msg = String(err && err.message || err);
    clog('source-view', 'IPC 处理失败（' + String(action) + '）: ' + msg);
    return { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: msg };
  }
}

// ---------- 冒烟模式（NOVAI_SMOKE_SOURCE=1）：自动验收用，正常启动不会走到 ----------
function waitForSourceViewLoaded(timeoutMs) {
  return new Promise((resolve) => {
    if (!isSourceViewAlive()) return resolve(false);
    if (sourceViewLoaded) return resolve(true);
    const wc = sourceView.webContents;
    let done = false;
    const timer = setTimeout(() => finish(sourceViewLoaded), timeoutMs);
    function finish(loaded) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { wc.removeListener('did-finish-load', onLoad); } catch (_) {}
      resolve(!!loaded);
    }
    function onLoad() {
      finish(true);
    }
    wc.once('did-finish-load', onLoad);
  });
}

// 面板 UI 集成检查：用与主窗口相同的 webPreferences（含 preload）起一个隐藏窗口加载智能画布，
// 真实点击来源按钮 / 花瓣 tab（morphing tabs，激活态看 aria-selected），证明面板与桥都正常。只在冒烟模式调用。
function sourceBrowserUiProbe() {
  return `(async function(){
    try {
      const btn = document.getElementById('sourceBrowserToggle');
      const panel = document.getElementById('sourceBrowserPanel');
      const tabsEl = document.getElementById('sourceBrowserTabs');
      const bridgeApi = window.pywebview && window.pywebview.api;
      const bridge = !!(bridgeApi && (typeof bridgeApi.open_source_view === 'function' || typeof bridgeApi.open_source_browser === 'function'));
      const rows = tabsEl ? tabsEl.querySelectorAll('[data-source-key]').length : 0;
      btn.click();
      const opened = panel.classList.contains('open');
      // morphing tabs：选中态是 .source-browser-tab 的 aria-selected="true"（glide 滑块只是视觉）
      const huabanTab = tabsEl ? tabsEl.querySelector('[data-source-key="huaban"]') : null;
      huabanTab.click();
      await new Promise(function(r){ setTimeout(r, 1200); });
      const tabActive = huabanTab.getAttribute('aria-selected') === 'true';

      // 拖放落节点证据：用站内真实可下载文件，避免"先落地本地"逻辑把假 URL 判失败
      const shell = document.getElementById('shell') || document.querySelector('.shell') || document.body;
      const imageUrl = window.location.origin + '/static/images/logo.png';
      const nodesBefore = document.querySelectorAll('.image-node').length;
      const imageTransfer = new DataTransfer();
      imageTransfer.setData('text/uri-list', imageUrl);
      imageTransfer.setData('text/html', '<img src="' + imageUrl + '">');
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: imageTransfer, clientX: 520, clientY: 360 }));
      await new Promise(function(r){ setTimeout(r, 800); });
      const nodesAfter = document.querySelectorAll('.image-node').length;

      const videoUrl = window.location.origin + '/static/images/templates/product-video.mp4';
      const videoTransfer = new DataTransfer();
      videoTransfer.setData('text/uri-list', videoUrl);
      videoTransfer.setData('text/html', '<video src="' + videoUrl + '"></video>');
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: videoTransfer, clientX: 560, clientY: 400 }));
      await new Promise(function(r){ setTimeout(r, 800); });
      // 视频落点不做过度断言：节点数继续增加，或节点里出现 video 元素，都算成功
      const videoNodesAfter = document.querySelectorAll('.image-node').length;
      const videoNodeAdded = videoNodesAfter > nodesAfter || !!document.querySelector('.image-node video');

      // 预取通道回归点：主进程已备好字节时，drop 必须秒出节点且不碰网络。
      // 桥名再写错一次（本次 Pinterest 事故），这里拿不到 dataUrl，drop 只能走网络，判失败。
      const dropLogs = [];
      const probeLog = console.log;
      console.log = function(){
        try {
          dropLogs.push(Array.prototype.map.call(arguments, function(v){
            if (typeof v === 'string') return v;
            try { return JSON.stringify(v); } catch (e) { return String(v); }
          }).join(' '));
        } catch (e) {}
        return probeLog.apply(console, arguments);
      };
      const nodesBeforePrefetch = document.querySelectorAll('.image-node').length;
      const pinUrl = 'https://i.pinimg.com/originals/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg';
      const pinTransfer = new DataTransfer();
      pinTransfer.setData('text/uri-list', pinUrl);
      pinTransfer.setData('text/html', '<img src="' + pinUrl + '">');
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: pinTransfer, clientX: 900, clientY: 620 }));
      await new Promise(function(r){ setTimeout(r, 1500); });
      console.log = probeLog;
      const prefetchNodesAfter = document.querySelectorAll('.image-node').length;
      const dropText = dropLogs.join('\\n');
      const prefetchResult = {
        hit: /medium hit bytes=/.test(dropText),
        nodeAdded: prefetchNodesAfter > nodesBeforePrefetch,
        bridgeHit: /guest_drag_bytes: .*hit/.test(dropText),
        bridgeMissing: /guest_drag_bytes bridge: missing/.test(dropText),
        garbageCandidate: dropText.indexOf('[object Object]') !== -1,
        networkFallback: /(?:import-urls count0|fetch-url:fail|fetch-url fail)/.test(dropText),
        nodesBefore: nodesBeforePrefetch,
        nodesAfter: prefetchNodesAfter,
        // 留几条原文，方便下次直接看出走了哪个通道
        samples: dropLogs.filter(function(line){
          return line.indexOf('guest_drag_bytes') !== -1 || line.indexOf('medium hit') !== -1
            || line.indexOf('prefetch-bytes') !== -1 || line.indexOf('candidate[') !== -1;
        }).slice(0, 6).map(function(line){ return line.slice(0, 180); })
      };

      const uiResult = {
        bridge: bridge,
        rows: rows,
        opened: opened,
        // rowOpen 保留旧字段名，语义已改为 tabActive（aria-selected）
        rowOpen: tabActive,
        tabActive: tabActive,
        unsupported: !document.getElementById('sourceBrowserUnsupported').hidden,
        nodesBefore: nodesBefore,
        nodesAfter: nodesAfter,
        nodeAdded: nodesAfter > nodesBefore,
        videoNodeAdded: videoNodeAdded
      };

      // 真实 iframe 路径：画布嵌在外壳的 #frame-canvas（data-src 懒加载）里，桥靠
      // injectIframeShims 在子 frame 加载完成后注入。这里动态建一个同源 iframe 复现该路径。
      let frameResult;
      try {
        frameResult = await new Promise(function(resolve){
          const frame = document.createElement('iframe');
          frame.style.position = 'fixed';
          frame.style.left = '0';
          frame.style.top = '0';
          frame.style.width = '100%';
          frame.style.height = '100%';
          frame.style.zIndex = '99999';
          frame.onload = function(){
            setTimeout(async function(){
              try {
                const inner = frame.contentWindow;
                const doc = frame.contentDocument;
                const api = inner.pywebview && inner.pywebview.api;
                const frameBridge = !!(api && (typeof api.open_source_view === 'function' || typeof api.open_source_browser === 'function'));
                const frameToggle = doc.getElementById('sourceBrowserToggle');
                frameToggle.click();
                const framePanel = doc.getElementById('sourceBrowserPanel');
                const frameOpened = framePanel.classList.contains('open');
                const frameTabsEl = doc.getElementById('sourceBrowserTabs');
                const frameHuabanTab = frameTabsEl ? frameTabsEl.querySelector('[data-source-key="huaban"]') : null;
                frameHuabanTab.click();
                await new Promise(function(r){ setTimeout(r, 1200); });
                const frameTabActive = frameHuabanTab.getAttribute('aria-selected') === 'true';
                const frameUnsupportedEl = doc.getElementById('sourceBrowserUnsupported');
                resolve({
                  bridge: frameBridge,
                  opened: frameOpened,
                  // rowOpen 保留旧字段名，语义已改为 tabActive（aria-selected）
                  rowOpen: frameTabActive,
                  tabActive: frameTabActive,
                  unsupported: !frameUnsupportedEl.hidden
                });
              } catch (err) {
                resolve({ error: String(err && err.message || err) });
              }
            }, 1500);
          };
          frame.src = '/static/smart-canvas.html';
          document.body.appendChild(frame);
        });
      } catch (err) {
        frameResult = { error: String(err && err.message || err) };
      }
      return JSON.stringify(uiResult) + '\\n' + JSON.stringify(frameResult) + '\\n' + JSON.stringify(prefetchResult);
    } catch (err) {
      return JSON.stringify({ error: String(err && err.message || err) });
    }
  })()`;
}

// 冒烟专用：伪造一条"内嵌页面拖拽"记录（预取字节直接给定），落图过程不依赖任何网络。
// 探针随后丢一次 i.pinimg.com 的 drop：字节预取走通才算过——桥名写错的回归就卡在这里。
function installSmokeGuestDrag() {
  const url = 'https://i.pinimg.com/1200x/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg';
  const originalUrl = 'https://i.pinimg.com/originals/d8/b7/52/d8b7528ce0b1b78e177d6314c7248321.jpg';
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  lastGuestDrag = {
    payload: {
      tagName: 'IMG',
      tag: 'IMG',
      src: url,
      bestUrl: originalUrl,
      mediaUrl: originalUrl,
      // 对象形态（{url,w}）跟真机 source-drag-preload 一致，顺带覆盖画布侧的候选归一
      imageCandidates: [{ url: originalUrl, w: 0 }, { url: url, w: 0 }],
      videoCandidates: [],
      pageUrl: 'https://www.pinterest.com/pin/123456789/',
      at: Date.now(),
    },
    receivedAt: Date.now(),
    bytesPromise: Promise.resolve({ ok: true, url: url, dataUrl: dataUrl, contentType: 'image/png', size: 101940, originalUrl: originalUrl }),
    bytesResult: null,
    originalPromise: Promise.resolve({ ok: false, error: 'smoke-no-original' }),
    originalUrl: originalUrl,
  };
}

async function runSourceBrowserUiCheck() {
  let origin = 'http://127.0.0.1:3000';
  try {
    const mainUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
    if (mainUrl) origin = new URL(mainUrl).origin;
  } catch (_) {}
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
    },
  });
  // 与主窗口一致：探针窗口也要挂 iframe shim 注入，才能复现画布 #frame-canvas 的真实路径。
  injectIframeShims(win.webContents);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('did-finish-load 超时')), 15000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      const navigation = win.loadURL(origin + '/static/smart-canvas.html');
      if (navigation && typeof navigation.catch === 'function') navigation.catch(() => {});
    });
    const result = await win.webContents.executeJavaScript(sourceBrowserUiProbe(), true);
    const uiText = typeof result === 'string' ? result : JSON.stringify(result || {});
    let webviewText = '';
    try {
      webviewText = await runWebviewFeasibilityCheck(win);
    } catch (err) {
      webviewText = JSON.stringify({ error: String(err && err.message || err) });
    }
    return uiText + '\n' + webviewText;
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  }
}

// ---------- 冒烟：webview 可行性探针（决定产品形态） ----------
// 画布页嵌在外壳的同源 iframe 里：验证 webviewTag 开启后 <webview> 在顶层文档和同源子 iframe
// 里能否真正附着 guest（renderer 侧 getWebContentsId + 主进程 did-attach-webview 双侧证据）。
function sourceBrowserWebviewProbe() {
  return `(async function(){
    const out = { inTopDoc: false, inIframe: false };
    function isAttached(el) {
      try {
        return typeof el.getWebContentsId === 'function' && el.getWebContentsId() > 0;
      } catch (err) {
        return false;
      }
    }
    function makeWebview(doc) {
      const wv = doc.createElement('webview');
      wv.setAttribute('src', 'https://huaban.com/');
      wv.setAttribute('partition', 'persist:novai-source-browser');
      wv.style.width = '160px';
      wv.style.height = '120px';
      return wv;
    }
    try {
      const topWv = makeWebview(document);
      document.body.appendChild(topWv);
      await new Promise(function(r){ setTimeout(r, 2000); });
      out.inTopDoc = isAttached(topWv);
    } catch (err) {
      out.inTopDoc = false;
    }
    try {
      const frame = document.createElement('iframe');
      frame.style.width = '180px';
      frame.style.height = '140px';
      document.body.appendChild(frame);
      const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
      const frameWv = makeWebview(doc);
      doc.body.appendChild(frameWv);
      await new Promise(function(r){ setTimeout(r, 2000); });
      out.inIframe = isAttached(frameWv);
    } catch (err) {
      out.inIframe = false;
    }
    return JSON.stringify(out);
  })()`;
}

function runWebviewFeasibilityCheck(win) {
  return new Promise((resolve) => {
    let attachCount = 0;
    const onAttach = () => { attachCount += 1; };
    try {
      win.webContents.on('did-attach-webview', onAttach);
    } catch (_) {
      return resolve(JSON.stringify({ error: '无法监听 did-attach-webview' }));
    }
    const finish = (payload) => {
      try { win.webContents.removeListener('did-attach-webview', onAttach); } catch (_) {}
      resolve(JSON.stringify(payload));
    };
    win.webContents.executeJavaScript(sourceBrowserWebviewProbe(), true).then((raw) => {
      let renderer = {};
      try { renderer = JSON.parse(String(raw || '{}')); } catch (_) {}
      // 给 did-attach-webview 一点时间到齐，再合并主进程侧证据
      setTimeout(() => {
        finish({
          inTopDoc: !!(renderer && renderer.inTopDoc),
          inIframe: !!(renderer && renderer.inIframe),
          attached: attachCount > 0,
        });
      }, 500);
    }).catch((err) => {
      finish({ error: String(err && err.message || err) });
    });
  });
}

async function runSourceBrowserSmoke() {
  const source = process.env.NOVAI_SMOKE_SOURCE_KEY || 'huaban';
  const preset = SOURCE_BROWSERS[source] || SOURCE_BROWSERS.huaban;
  const url = process.env.NOVAI_SMOKE_SOURCE_URL || preset.url;
  const smokeRect = { x: 40, y: 80, width: 420, height: 560 };
  let openResult;
  try {
    openResult = await openSourceView(source, smokeRect, url);
  } catch (err) {
    openResult = { ok: false, open: isSourceViewOpen(), source: sourceViewSource, error: String(err && err.message || err) };
  }
  const loaded = await waitForSourceViewLoaded(8000);
  const state = sourceViewState();
  // 取内嵌视图真实的 navigator.userAgent，用来证明站点看到的是干净 Chrome UA。
  let smokeUa = '';
  try {
    if (isSourceViewOpen()) {
      smokeUa = await sourceView.webContents.executeJavaScript('navigator.userAgent', true);
    }
  } catch (_) {}
  // 挑战页反复自刷新会让 isLoading() 一直 true，SMOKE_LOADED / SMOKE_URL 只作信息项，不参与判定。
  let smokeUrl = '';
  try {
    if (isSourceViewOpen()) smokeUrl = sourceView.webContents.getURL();
  } catch (_) {}
  let smokeViewBounds = null;
  try {
    if (isSourceViewOpen()) smokeViewBounds = sourceView.getBounds();
  } catch (_) {}
  // 页面信息：判断花瓣的 EdgeOne 挑战页在 Electron 里到底过没过（标题/正文长度/挑战标记）
  let smokePage = { title: '', bodyLen: 0, isChallenge: false };
  try {
    if (isSourceViewOpen()) {
      const pageInfo = await Promise.race([
        sourceView.webContents.executeJavaScript(
          "({ title: document.title, bodyLen: document.body ? document.body.innerText.length : 0, isChallenge: /EO_Bot|__tst_status|challenge/i.test(document.documentElement.innerHTML.slice(0, 3000)) })",
          true
        ),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (pageInfo && typeof pageInfo === 'object') {
        smokePage = {
          title: String(pageInfo.title || ''),
          bodyLen: Number(pageInfo.bodyLen) || 0,
          isChallenge: !!(pageInfo && pageInfo.isChallenge),
        };
      } else {
        smokePage.error = '页面信息读取超时';
      }
    }
  } catch (err) {
    smokePage.error = String(err && err.message || err);
  }
  let smokeUi = '';
  let smokeUiFrame = '';
  let smokeWebview = '';
  let smokeDropPrefetch = { hit: false, nodeAdded: false, error: '探针未执行' };
  try {
    // 先备好预取记录，探针的 drop 才能走"秒出图"通道（失败信息落在 SMOKE_DROP_PREFETCH 里）
    installSmokeGuestDrag();
    const uiResult = String((await runSourceBrowserUiCheck()) || '');
    // 探针返回四行 JSON：主窗口面板 / 真实 iframe 路径 / 预取落图 / webview 可行性
    const parts = uiResult.split('\n');
    smokeUi = parts[0] || '';
    smokeUiFrame = parts[1] || JSON.stringify({ error: 'iframe 探针未返回结果' });
    if (parts[2]) {
      try {
        smokeDropPrefetch = JSON.parse(parts[2]);
      } catch (_) {
        smokeDropPrefetch = { hit: false, nodeAdded: false, error: '预取探针结果无法解析：' + String(parts[2]).slice(0, 200) };
      }
    } else {
      smokeDropPrefetch = { hit: false, nodeAdded: false, error: '预取探针未返回结果' };
    }
    smokeWebview = parts[3] || JSON.stringify({ error: 'webview 探针未返回结果' });
  } catch (err) {
    smokeUi = JSON.stringify({ error: String(err && err.message || err) });
    smokeUiFrame = smokeUi;
    smokeWebview = smokeUi;
  }
  // 登录态保活证据：种 cookie → close（隐藏）→ open 复用同一个 view，cookie 仍在
  const smokeCookie = { set: false, afterHide: false, afterReopen: false };
  let smokeViewReuse = false;
  try {
    if (isSourceViewAlive()) {
      const cookieSession = session.fromPartition(SOURCE_BROWSER_PARTITION);
      const cookieUrl = sourceView.webContents.getURL() || url;
      const readCookie = async () => {
        try {
          const list = await cookieSession.cookies.get({ name: 'novai_smoke_auth' });
          return Array.isArray(list) && list.length > 0;
        } catch (_) { return false; }
      };
      await cookieSession.cookies.set({
        url: cookieUrl,
        name: 'novai_smoke_auth',
        value: '1',
        path: '/',
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
      smokeCookie.set = await readCookie();
      const viewIdBefore = sourceView.webContents.id;
      await handleSourceViewAction({ action: 'close' });
      smokeCookie.afterHide = await readCookie();
      const reopen = await openSourceView(source, smokeRect, url);
      smokeCookie.afterReopen = !!(reopen && reopen.ok) && (await readCookie());
      smokeViewReuse = !!(isSourceViewAlive() && sourceView.webContents.id === viewIdBefore);
      try { await cookieSession.cookies.remove(cookieUrl, 'novai_smoke_auth'); } catch (_) {}
    }
  } catch (err) {
    clog('source-view', '冒烟 cookie/复用检查失败: ' + (err && err.message || err));
  }
  const ok = !!(openResult && openResult.ok && state.open && smokeDropPrefetch && smokeDropPrefetch.hit && smokeDropPrefetch.nodeAdded);
  console.log('[smoke] SMOKE_OPEN=' + JSON.stringify(openResult));
  console.log('[smoke] SMOKE_STATE=' + JSON.stringify(state));
  console.log('[smoke] SMOKE_UA=' + String(smokeUa || ''));
  console.log('[smoke] SMOKE_LOADED=' + (loaded ? 'true' : 'false'));
  console.log('[smoke] SMOKE_URL=' + String(smokeUrl || ''));
  console.log('[smoke] SMOKE_VIEW=' + JSON.stringify({ created: isSourceViewAlive(), loaded: !!loaded, bounds: smokeViewBounds, page: smokePage }));
  console.log('[smoke] SMOKE_COOKIE=' + JSON.stringify(smokeCookie));
  console.log('[smoke] SMOKE_VIEW_REUSE=' + (smokeViewReuse ? 'true' : 'false'));
  console.log('[smoke] SMOKE_UI=' + smokeUi);
  console.log('[smoke] SMOKE_UI_FRAME=' + smokeUiFrame);
  console.log('[smoke] SMOKE_DROP_PREFETCH=' + JSON.stringify(smokeDropPrefetch));
  console.log('[smoke] SMOKE_WEBVIEW=' + smokeWebview);
  console.log('[smoke] SMOKE_RESULT=' + (ok ? 'ok' : 'fail'));
  try { destroySourceView(); } catch (_) {}
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  } catch (_) {}
  isQuitting = true;
  app.quit();
  // 兜底：退出流程若被卡住（如后端未响应），5s 后强制收尾，避免自动验收挂死。
  setTimeout(() => {
    try { shutdownBackend(); } catch (_) {}
    app.exit(0);
  }, 5000);
}

// ---------- IPC：pywebview 兼容桥 ----------
// 拖拽预取：dragstart 时并行下载图片字节，画布落点直接用（上限 30MB / 20s）
const GUEST_DRAG_MAX_BYTES = 30 * 1024 * 1024;
const GUEST_DRAG_PREFETCH_TIMEOUT_MS = 20000;

// 与 fetch-url action 完全一致的下载路径：session.fetch + UA（不设置 Referer）。
// 真机实测：给 session.fetch 设置 Referer 会被 Chromium 拦成 net::ERR_BLOCKED_BY_CLIENT。
async function fetchImageBytesViaSourceSession(url, referer) {
  try {
    const headers = { 'User-Agent': sourceBrowserUserAgent() };
    const response = await session.fromPartition(SOURCE_BROWSER_PARTITION).fetch(url, { headers: headers });
    const status = response.status;
    const contentType = String(response.headers.get('content-type') || '');
    if (!response.ok) return { ok: false, error: 'HTTP ' + status, status: status, code: 'HTTP_' + status };
    if (!/^image\//i.test(contentType)) return { ok: false, error: '非图片内容（' + contentType + '）', status: status, code: 'NOT_IMAGE' };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > GUEST_DRAG_MAX_BYTES) return { ok: false, error: '文件过大（' + buffer.length + 'B > 30MB）', status: status, code: 'TOO_LARGE' };
    const dataUrl = 'data:' + (contentType || 'application/octet-stream') + ';base64,' + buffer.toString('base64');
    return { ok: true, url: url, dataUrl: dataUrl, contentType: contentType, size: buffer.length, status: status };
  } catch (err) {
    const code = String(err && err.code || '');
    const message = String(err && err.message || err);
    return { ok: false, error: '下载异常：' + (code ? code + ' ' : '') + message, code: code || 'FETCH_ERROR', message: message };
  }
}

async function fetchGuestImageBytes(url, payload, label, timeoutMs) {
  const startedAt = Date.now();
  clog('source-view', label + ' 预取开始（no-referer） ' + url.slice(0, 160));
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: '请求超时（' + timeoutMs + 'ms）', code: 'TIMEOUT' }), timeoutMs);
  });
  try {
    const result = await Promise.race([fetchImageBytesViaSourceSession(url, payload && payload.pageUrl), timeoutPromise]);
    if (result.ok) {
      clog('source-view', label + ' 预取完成 ' + (Date.now() - startedAt) + 'ms ' + result.size + 'B ' + url.slice(0, 120));
    } else {
      clog('source-view', label + ' 预取失败 ' + result.error + (result.code ? ' code=' + result.code : '') + ' ' + url.slice(0, 160));
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGuestImageBytesWithRetry(url, payload, label, timeoutMs) {
  const first = await fetchGuestImageBytes(url, payload, label, timeoutMs);
  if (first && first.ok) return first;
  // drag 进行中请求可能被 Chromium 短暂阻断：等 600ms 再用 fetch-url 同路径重试一次
  clog('source-view', label + ' 首次失败（' + String(first && first.error || '未知') + ' code=' + String(first && first.code || '') + '），600ms 后用 fetch-url 同路径重试');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const second = await fetchGuestImageBytes(url, payload, label + ' retry', timeoutMs);
  if (second && second.ok) return second;
  return Object.assign({}, second || first || { ok: false, error: '预取失败' }, { firstError: first && first.error });
}

// 秒出图：medium（736x/474x）优先返回；原图在后台继续下载，画布可稍后换高清。
function prefetchGuestDragImage(payload) {
  const noUrl = { ok: false, error: '没有可预取的图片 URL' };
  const empty = { mediumPromise: Promise.resolve(noUrl), originalPromise: Promise.resolve(noUrl), originalUrl: '' };
  try {
    if (!isSourceViewAlive()) {
      const offline = { ok: false, error: '内嵌浏览器未打开' };
      return { mediumPromise: Promise.resolve(offline), originalPromise: Promise.resolve(offline), originalUrl: '' };
    }
    const tag = String(payload && payload.tagName || '').toUpperCase();
    if (tag === 'VIDEO') {
      const video = { ok: false, error: '视频不预取' };
      return { mediumPromise: Promise.resolve(video), originalPromise: Promise.resolve(video), originalUrl: '' };
    }
    const candidates = Array.isArray(payload && payload.imageCandidates) ? payload.imageCandidates : [];
    // 触发条件放宽：bestUrl > uriList > url 任一存在即预取（不再要求 imageCandidates）
    const chosenUrl = String((payload && (payload.bestUrl || payload.uriList || payload.url)) || '').trim();
    const primaryUrl = String((candidates[0] && candidates[0].url) || '').trim();
    const originalUrl = primaryUrl || chosenUrl;
    if (!/^https?:/i.test(originalUrl)) return empty;
    let mediumUrl = originalUrl;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const value = String(candidate && candidate.url || '').trim();
      if (/(?:736x|474x)\//i.test(value) && /^https?:/i.test(value)) {
        mediumUrl = value;
        break;
      }
    }
    const mediumPromise = fetchGuestImageBytesWithRetry(mediumUrl, payload, 'medium', GUEST_DRAG_PREFETCH_TIMEOUT_MS)
      .then((result) => (result && result.ok ? Object.assign(result, { originalUrl: originalUrl }) : result));
    const originalPromise = mediumUrl === originalUrl
      ? mediumPromise
      : fetchGuestImageBytesWithRetry(originalUrl, payload, 'original', 60000);
    return { mediumPromise: mediumPromise, originalPromise: originalPromise, originalUrl: originalUrl };
  } catch (_) {
    return empty;
  }
}

// ---------- 保存文件：对话框过滤器 / 落盘路径 ----------
// macOS 保存面板会用「当前选中的过滤器扩展名」去补全文件名：过滤器写死成图片时，
// video_xxx.mp4 会被存成 video_xxx.mp4.png（Format 还显示「图片」）。
// 过滤器必须跟真实媒体类型走，落盘前再把扩展名纠回原样兜底。

const SAVE_FILE_KINDS = [
  { name: '视频', mime: 'video/', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'] },
  { name: '音频', mime: 'audio/', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] },
  { name: '图片', mime: 'image/', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
];

function fileExtension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || '').split(/[?#]/)[0]);
  return match ? match[1].toLowerCase() : '';
}

function saveFileKind(filename, dataUrl) {
  // 先看文件名：保存面板判断「扩展名在不在过滤器里」用的是文件名，
  // 过滤器跟文件名不一致本身就会再造出一个 xxx.mp4.png。
  const ext = fileExtension(filename);
  const byExt = SAVE_FILE_KINDS.find((kind) => kind.extensions.indexOf(ext) >= 0);
  if (byExt) return byExt;
  const mime = (/^data:([^;,]+)/i.exec(String(dataUrl || '')) || [])[1] || '';
  const type = mime.toLowerCase();
  return SAVE_FILE_KINDS.find((kind) => type.indexOf(kind.mime) === 0) || null;
}

function saveDialogFilters(filename, dataUrl) {
  const kind = saveFileKind(filename, dataUrl);
  const filters = kind ? [{ name: kind.name, extensions: kind.extensions.slice() }] : [];
  filters.push({ name: '全部文件', extensions: ['*'] });
  return filters;
}

function correctSavedFilePath(filePath, filename) {
  const target = String(filePath || '');
  const originalExt = fileExtension(filename);
  if (!target || !originalExt) return target;
  const suffix = '.' + originalExt;
  // 保存面板可能在原扩展名后面又追加了一段（video.mp4 → video.mp4.png），
  // 用户也可能手动改成别的类型：都按原始扩展名纠正，避免存出打不开的文件。
  let current = target;
  for (;;) {
    if (current.toLowerCase().endsWith(suffix)) return current;
    const ext = fileExtension(current);
    if (!ext) return current + suffix;
    current = current.slice(0, current.length - ext.length - 1);
  }
}

// 单测（desktop/__tests__/test_save_file.js）只 require 这两个纯函数；
// 带了这个开关就不再往下走 Electron 生命周期，正常启动完全不受影响。
if (process.env.NOVAI_MAIN_LIB_ONLY === '1') {
  module.exports = { saveDialogFilters, correctSavedFilePath };
  return;
}

function registerIpc() {
  // 内嵌站点拖拽时由 source-drag-preload 回传被拖元素；只接受当前 source view 的消息
  ipcMain.on('novai:guest-drag', (event, payload) => {
    try {
      if (!isSourceViewAlive() || !event || !event.sender || event.sender !== sourceView.webContents) return;
      if (!payload || typeof payload !== 'object') return;
      const record = { payload: payload, receivedAt: Date.now(), bytesPromise: null, bytesResult: null, originalPromise: null, originalUrl: '' };
      lastGuestDrag = record;
      clog('source-view', '记录拖拽元素 <' + String(payload.tagName || '') + '> hitMethod=' + String(payload.hitMethod || '')
        + ' sourceTag=' + String(payload.sourceTag || '') + ' pointerGuard=' + Boolean(payload.pointerGuard) + ' stack=' + JSON.stringify(payload.elementsStack || []));
      // 只对图片并行预取（视频走现有网络捕获/流式）
      const prefetch = prefetchGuestDragImage(payload);
      record.originalPromise = prefetch.originalPromise;
      record.originalUrl = prefetch.originalUrl;
      record.bytesPromise = prefetch.mediumPromise.then((result) => {
        record.bytesResult = result;
        return result;
      });
    } catch (_) {}
  });

  // 诊断：页面上 mousedown 命中 video（拖拽起不来时用来判断事件到底有没有到视频上），每 2s 最多一条
  ipcMain.on('novai:guest-pointer', (event, payload) => {
    try {
      if (!isSourceViewAlive() || !event || !event.sender || event.sender !== sourceView.webContents) return;
      const now = Date.now();
      if (now - lastGuestPointerLogAt < 2000) return;
      lastGuestPointerLogAt = now;
      clog('source-view', 'guest-pointer targetTag=' + String((payload && payload.targetTag) || (payload && payload.tag) || '')
        + ' foundVideo=' + Boolean(payload && payload.foundVideo));
    } catch (_) {}
  });

  ipcMain.handle('novai:window', async (e, { action }) => {
    if (!mainWindow) return null;
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'maximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        break;
      case 'close':
        // 标题栏自绘关闭按钮走同一条「关闭到托盘」路径，和系统关闭按钮行为一致
        if (isQuitting) break;
        if (ensureTray()) {
          mainWindow.hide();
          clog('win', '已收进托盘（进程保持运行，可从托盘重新打开）');
        } else {
          clog('win', '关闭窗口：托盘不可用，按普通关闭处理');
          mainWindow.close();
        }
        break;
      case 'quit': isQuitting = true; app.quit(); break;
      case 'start-drag': startWindowDrag(); break;
      case 'end-drag': stopWindowDrag(); break;
      default: break;
    }
    return true;
  });

  ipcMain.handle('novai:save-file', async (e, { dataUrl, filename }) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
      const result = await dialog.showSaveDialog(win, {
        title: '保存文件',
        defaultPath: filename || 'download.png',
        filters: saveDialogFilters(filename, dataUrl),
      });
      if (result.canceled || !result.filePath) return { ok: true, saved: false };
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
      if (!m) return { ok: true, saved: false };
      const savedPath = correctSavedFilePath(result.filePath, filename);
      fs.writeFileSync(savedPath, Buffer.from(m[2], 'base64'));
      return { ok: true, saved: true, path: savedPath };
    } catch (err) {
      return { ok: false, saved: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('novai:select-directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  let requestedDisplaySourceId = '';
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sourceId = requestedDisplaySourceId;
    requestedDisplaySourceId = '';
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const source = sources.find((item) => item.id === sourceId);
      callback(source ? { video: source, audio: false } : {});
    } catch (err) {
      clog('recording', '选择屏幕来源失败: ' + String(err && err.message || err));
      callback({});
    }
  });

  // 画布助手的语音输入要录音，而渲染进程只加载本机后端页面：media 权限只对本机来源放行，
  // 其它权限保持默认放行，免得剪贴板、通知、全屏这些既有能力被一起拦掉。
  function isLocalAppOrigin(url) {
    try {
      const host = new URL(url).hostname;
      return host === '127.0.0.1' || host === 'localhost';
    } catch (_) {
      return false;
    }
  }
  function isMediaPermissionAllowed(details) {
    const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : [];
    return types.length > 0 && types.every((type) => type === 'audio' || type === 'video');
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return; }
    callback(isLocalAppOrigin(wc.getURL()) && isMediaPermissionAllowed(details));
  });
  // navigator.permissions 查询走这条：本机来源的 media 直接放行；其它权限维持默认放行
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (permission !== 'media') return true;
    return isLocalAppOrigin(requestingOrigin || (wc && wc.getURL()) || '');
  });

  ipcMain.handle('novai:recording-select-source', (_event, { sourceId }) => {
    requestedDisplaySourceId = String(sourceId || '');
    return Boolean(requestedDisplaySourceId);
  });

  ipcMain.handle('novai:recording-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '',
      }));
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('novai:get-data-dir', () => dataDir);
  ipcMain.handle('novai:open-data-dir', () => {
    if (dataDir && fs.existsSync(dataDir)) shell.openPath(dataDir);
    return true;
  });

  ipcMain.handle('novai:set-auto-start', (e, { value }) => {
    try { app.setLoginItemSettings({ openAtLogin: !!value }); } catch (_) {}
    return true;
  });

  ipcMain.handle('novai:set-titlebar-theme', (e, { r, g, b }) => {
    if (mainWindow && process.platform === 'darwin') {
      try { mainWindow.setBackgroundColor(`rgb(${r}, ${g}, ${b})`); } catch (_) {}
    }
    return true;
  });

  ipcMain.handle('novai:get-app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
  }));

  // 素材源内嵌浏览器（WebContentsView 叠层）：画布面板只画 UI，浏览器由主进程挂载。
  ipcMain.handle('novai:source-view', (e, payload) => handleSourceViewAction(payload));
  // guest preload 悬浮控件点击/状态回报
  ipcMain.on('novai:guest-control', (event, payload) => {
    handleGuestControl(payload).catch((err) => clog('source-view', 'guest-control 失败: ' + String(err && err.message || err)));
  });
  ipcMain.on('novai:guest-controls-ready', (event, payload) => {
    if (!SOURCE_INJECTED_CONTROLS) return;
    sourceControlsGuestOk = Boolean(payload && payload.ok);
    if (!sourceControlsGuestOk) {
      setSourceControlsFallback(true, payload && payload.reason || 'guest-report');
    } else if (sourceControlsCssOk) {
      setSourceControlsFallback(false, 'guest-ok');
    }
    sendSourceUiState();
  });
  // guest preload 的双指滑动：novai:guest-swipe { direction: 'back'|'forward' }
  ipcMain.on('novai:guest-swipe', (event, payload) => {
    const direction = payload && payload.direction;
    if (direction === 'back' || direction === 'forward') handleSourceSwipe(direction);
  });
  // 独立导航通道：invoke('novai:source-nav', { action: 'back'|'forward'|'reload' })
  ipcMain.handle('novai:source-nav', (e, payload) => {
    const data = payload || {};
    return navigateSourceView(data.action || data.nav || data.mode || data.direction);
  });
  // 独立缩放通道：前端可直接 invoke('novai:source-zoom', { action: 'in' }) 
  ipcMain.handle('novai:source-zoom', (e, payload) => {
    const data = payload || {};
    const mode = data.action || data.mode || data.zoomAction || data.zoom || (data.value !== undefined ? 'set' : '');
    return setSourceZoom(mode, data.value !== undefined ? data.value : data.factor);
  });
  // 兼容旧前端：原来的伴生窗口通道内部转到 source-view。
  ipcMain.handle('novai:source-browser', (e, payload) => handleSourceViewAction(payload));

  // 网页端「一键更新」在桌面版转交到这里（见 preload 的 window.novaiUpdater）。
  registerUpdaterIpc();
}

// ---------- 自动更新 ----------
let autoUpdater = null;
// idle | checking | available | downloading | downloaded | installing
// 静默下载、前端卡片和网页端「一键更新」共用这一份状态，避免重复检查 / 重复下载。
let updateStage = 'idle';
let pendingUpdateInfo = null;
// 手动触发的检查结束（且没新版本）时要给用户一句反馈；启动自动检查不打扰
let manualUpdateCheck = false;

// 新版客户端 IPC 契约 v1：主进程 → 渲染进程只用这一个通道推更新阶段。
const UPDATE_STAGE_CHANNEL = 'novai:update-stage';

// 本次下载的版本（进度事件里只有百分比，版本号要自己带上）
let stageVersion = '';
let pendingNotes = null;
let notifiedDownloadVersion = '';
// macOS 下载/安装分两步：下载好的 zip 留着，等用户点「立即重启」或退出时再替换
let macPreparedUpdate = null;
let macDownloadingVersion = '';
let macDownloadRunning = false;
let downloadProgressTimer = null;
let lastDownloadProgress = null;
let updatePersist = updateState.defaultState();
let appliedStage = null;
let bootSettled = false;
let pendingReinstallWanted = false;
let pendingReinstallTimer = null;
let quitInstallTriggered = false;
let updateSimDone = false;
let installFailureNotice = '';

function isDevMode() {
  return !app.isPackaged || process.argv.indexOf('--dev') >= 0;
}

function updateStateDir() {
  try { return app.getPath('userData'); } catch (_) { return ''; }
}

function readUpdateState() {
  return updateState.readState(updateStateDir());
}

function saveUpdateState(patch) {
  if (!app.isPackaged) return updatePersist;
  updatePersist = updateState.writeState(updateStateDir(), Object.assign({}, updatePersist, patch || {}));
  return updatePersist;
}

function sendUpdateStage(payload) {
  const data = Object.assign({}, payload || {});
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(UPDATE_STAGE_CHANNEL, data);
  } catch (_) {}
  if (data.stage !== 'downloading') clog('updater', 'stage → ' + JSON.stringify(data));
}

function updateNotesCachePath() {
  return path.join(updateStateDir(), 'update-notes.json');
}

function readCachedUpdateNotes() {
  try {
    const raw = JSON.parse(fs.readFileSync(updateNotesCachePath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return updateState.normalizeNotes(raw.version, raw.notes || raw);
  } catch (_) {
    return null;
  }
}

function writeCachedUpdateNotes(notes) {
  if (!notes) return;
  try { fs.writeFileSync(updateNotesCachePath(), JSON.stringify(notes), 'utf8'); } catch (_) {}
}

// 打包时可以把 update-notes.json 放进 resources，用来给没有 Release 正文的更新源补说明。
function readBundledUpdateNotes(version) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'update-notes.json') : '',
    // 安装包会把 ../static 同步到 Resources/backend/static，更新说明顺手从那里读。
    process.resourcesPath ? path.join(process.resourcesPath, 'backend', 'static', 'update-notes.json') : '',
    path.join(__dirname, 'update-notes.json'),
    path.join(__dirname, '..', 'static', 'update-notes.json'),
    path.join(__dirname, '..', 'update-notes.json'),
  ].filter(Boolean);
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
      const list = Array.isArray(raw) ? raw : [raw];
      for (let j = 0; j < list.length; j += 1) {
        const notes = updateState.normalizeNotes(version, list[j]);
        if (notes) return notes;
      }
    } catch (_) {}
  }
  return null;
}

function resolveUpdateNotes(version, info) {
  const ver = String(version || '');
  if (!ver) return null;
  const cached = readCachedUpdateNotes();
  if (cached && updateState.versionEquals(cached.version, ver)) return cached;
  const bundled = readBundledUpdateNotes(ver);
  if (bundled) { writeCachedUpdateNotes(bundled); return bundled; }
  const fromInfo = updateState.normalizeNotes(ver, info && info.releaseNotes);
  if (fromInfo) { writeCachedUpdateNotes(fromInfo); return fromInfo; }
  return null;
}

function notifyUpdateDownloaded(version) {
  const label = 'v' + String(version || '');
  const body = label + ' 已下载完成，退出应用后会自动安装；回到窗口点「立即重启」可以马上装。';
  try {
    if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      const notice = new Notification({ title: 'NOVAI 更新已就绪', body: body });
      notice.on('click', () => { showMainWindow(); });
      notice.show();
      clog('updater', '窗口不可见，已发送系统通知提示下载完成');
      return;
    }
  } catch (err) {
    clog('updater', '系统通知失败（忽略）: ' + (err && err.message || err));
  }
  try {
    if (tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({ title: 'NOVAI 更新已就绪', content: body });
    }
  } catch (_) {}
}

// 下载完成后的空闲时段备份旧版关键文件：回滚只认 app.asar + 可执行文件（打包后 js 都在 asar 里）。
async function createUpdateBackup(version) {
  if (!app.isPackaged) return false;
  const plan = updateState.backupPlan({
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    exePath: process.execPath,
  });
  if (!plan.length) return false;
  const dir = path.join(updateStateDir(), 'update-backup');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let copied = 0;
    for (let i = 0; i < plan.length; i += 1) {
      const item = plan[i];
      try {
        if (!fs.existsSync(item.live)) continue;
        await fs.promises.copyFile(item.live, path.join(dir, item.name));
        copied += 1;
      } catch (err) {
        clog('updater', '备份 ' + item.name + ' 失败（不影响更新）: ' + (err && err.message || err));
      }
    }
    if (!copied) return false;
    // 备份的是「现在正在跑的旧版本」，回滚判定要靠它和新版本号区分。
    saveUpdateState({ backupDir: dir, backupVersion: app.getVersion() });
    clog('updater', '已备份当前版本关键文件到 ' + dir + '（' + copied + ' 个）');
    return true;
  } catch (err) {
    clog('updater', '更新备份失败（不影响更新）: ' + (err && err.message || err));
    return false;
  }
}

// 启动自检失败：把备份拷回原位后重启；全都拷不回去才提示用户手动下载。
async function performUpdateRollback() {
  const backupDir = String(updatePersist.backupDir || '');
  const backupVersion = String(updatePersist.backupVersion || '');
  const plan = updateState.backupPlan({
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    exePath: process.execPath,
  });
  const errors = [];
  let copied = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i];
    const source = path.join(backupDir, item.name);
    try {
      if (!backupDir || !fs.existsSync(source)) { errors.push(item.name + ' 备份缺失'); continue; }
      fs.copyFileSync(source, item.live);
      copied += 1;
    } catch (err) {
      errors.push(item.name + ': ' + (err && err.message || err));
    }
  }
  if (errors.length) clog('updater', '回滚时部分文件没还原: ' + errors.join('；'));
  if (!errors.length && copied > 0) {
    saveRollbackState(backupVersion);
    clog('updater', '启动自检失败，已从备份回滚到 v' + (backupVersion || '旧版') + '，重启应用');
    try { await stopBackendForUpdate(5000); } catch (_) {}
    try { app.relaunch(); } catch (_) {}
    app.exit(0);
    return;
  }
  // Windows 上运行中的 exe/asar 常被占用，直接覆盖会失败；改成等进程退出后再还原并重启。
  if (errors.length && spawnUpdateRollbackScript(backupDir, plan)) {
    saveRollbackState(backupVersion);
    clog('updater', '回滚文件被占用，已交给分离脚本在退出后还原并重启');
    try { await stopBackendForUpdate(5000); } catch (_) {}
    app.exit(0);
    return;
  }
  const message = '自动回滚没有成功（备份不可用）。请到发布页手动下载安装包覆盖安装，用户数据不会丢失。';
  saveUpdateState({ bootAttempts: 0, pendingVersion: '', lastInstallError: message });
  clog('updater', '回滚失败: ' + (errors.join('；') || '没有可用的备份'));
  try {
    dialog.showErrorBox('更新回滚失败', message + (errors.length ? String.fromCharCode(10) + String.fromCharCode(10) + errors.join(String.fromCharCode(10)) : ''));
  } catch (_) {}
}

function saveRollbackState(backupVersion) {
  saveUpdateState({
    bootAttempts: 0,
    pendingVersion: '',
    rolledBackFrom: app.getVersion(),
    lastRunVersion: backupVersion,
    installAttempts: 0,
    lastInstallError: '',
    backupDir: '',
    backupVersion: '',
  });
}

function spawnUpdateRollbackScript(backupDir, plan) {
  if (!backupDir) return false;
  const quoteSh = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const quotePs = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  try {
    if (process.platform === 'win32') {
      const scriptPath = path.join(updateStateDir(), 'update-rollback.ps1');
      const lines = [
        '$ErrorActionPreference = "SilentlyContinue"',
        'for ($i = 0; $i -lt 180; $i++) {',
        '  if (-not (Get-Process -Id ' + process.pid + ' -ErrorAction SilentlyContinue)) { break }',
        '  Start-Sleep -Milliseconds 500',
        '}',
      ];
      plan.forEach((item) => {
        lines.push('Copy-Item -LiteralPath ' + quotePs(path.join(backupDir, item.name)) + ' -Destination ' + quotePs(item.live) + ' -Force');
      });
      lines.push('Start-Process -FilePath ' + quotePs(process.execPath));
      fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    const scriptPath = path.join(updateStateDir(), 'update-rollback.sh');
    const lines = [
      '#!/bin/sh',
      'for i in $(seq 1 180); do',
      '  if ! kill -0 ' + process.pid + ' 2>/dev/null; then break; fi',
      '  sleep 0.5',
      'done',
    ];
    plan.forEach((item) => {
      lines.push('cp -f ' + quoteSh(path.join(backupDir, item.name)) + ' ' + quoteSh(item.live) + ' 2>/dev/null');
    });
    const macApp = process.platform === 'darwin' ? macUpdater.appBundleFromExe(process.execPath) : '';
    lines.push(macApp ? 'open ' + quoteSh(macApp) : quoteSh(process.execPath) + ' >/dev/null 2>&1 &');
    fs.writeFileSync(scriptPath, lines.join('\n'), { encoding: 'utf8', mode: 0o755 });
    try { fs.chmodSync(scriptPath, 0o755); } catch (_) {}
    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (err) {
    clog('updater', '启动回滚脚本失败: ' + (err && err.message || err));
    return false;
  }
}

function beginUpdateBoot() {
  if (!app.isPackaged) {
    updatePersist = updateState.defaultState();
    return { applied: false, rollback: false, pendingStale: false, previousVersion: '' };
  }
  const boot = updateState.beginBoot(readUpdateState(), app.getVersion());
  updatePersist = updateState.writeState(updateStateDir(), boot.state);
  if (boot.applied) {
    const notes = resolveUpdateNotes(app.getVersion(), null);
    appliedStage = { stage: 'applied', version: app.getVersion(), previousVersion: boot.previousVersion };
    if (notes) appliedStage.notes = notes;
    clog('updater', '检测到升级完成: v' + boot.previousVersion + ' → v' + app.getVersion());
  }
  if (boot.pendingStale) {
    pendingReinstallWanted = true;
    clog('updater', '上次退出时更新没装成（pending=' + updatePersist.pendingVersion + '），本次启动继续补装');
  }
  if (boot.giveUp) {
    installFailureNotice = String(updatePersist.lastInstallError || '自动安装多次未成功，请到发布页手动下载安装包覆盖安装（用户数据不会丢失）。');
    saveUpdateState({ pendingVersion: '' });
    clog('updater', '自动安装重试次数已用完，本次启动不再自动安装');
  }
  return boot;
}

function markBootSuccess() {
  if (bootSettled) return;
  bootSettled = true;
  if (!app.isPackaged) return;
  saveUpdateState({ bootAttempts: 0, lastRunVersion: app.getVersion() });
  clog('updater', '主界面已加载，启动自检通过（bootAttempts 清零）');
  if (pendingReinstallWanted) schedulePendingReinstall();
}

function flushAppliedStage() {
  if (!appliedStage) return;
  const payload = appliedStage;
  appliedStage = null;
  sendUpdateStage(payload);
}

// 上次关机打断安装：本次启动静默重查一次，重新下好包，下次退出时自动装。
function schedulePendingReinstall() {
  if (!app.isPackaged || !pendingReinstallWanted || pendingReinstallTimer) return;
  pendingReinstallTimer = setTimeout(() => {
    pendingReinstallTimer = null;
    if (!updaterSupported() || updateStage !== 'idle') return;
    clog('updater', '后台重查未完成的更新（pending=' + String(updatePersist.pendingVersion || '') + '）');
    manualUpdateCheck = false;
    updateStage = 'checking';
    try {
      const task = autoUpdater.checkForUpdates();
      if (task && typeof task.catch === 'function') task.catch(() => {});
    } catch (_) {
      updateStage = 'idle';
    }
  }, 20000);
}

function flushInstallFailureNotice() {
  if (!installFailureNotice) return;
  const message = installFailureNotice;
  installFailureNotice = '';
  sendUpdateStage({ stage: 'error', phase: 'install', message: message });
}

function onMainWindowLoaded() {
  markBootSuccess();
  if (appliedStage) setTimeout(flushAppliedStage, 1200);
  setTimeout(flushInstallFailureNotice, 1400);
  setTimeout(maybeSimulateUpdateEvent, 1500);
}

function updateInstallBlockedDir() {
  // AppImage 的 execPath 在只读挂载点里，真正要写的是 $APPIMAGE 文件本身所在目录。
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    const appImageDir = path.dirname(process.env.APPIMAGE);
    try { fs.accessSync(appImageDir, fs.constants.W_OK); } catch (_) { return appImageDir; }
    return '';
  }
  const dirs = [];
  try { dirs.push(path.dirname(process.execPath)); } catch (_) {}
  if (process.resourcesPath) dirs.push(process.resourcesPath);
  for (let i = 0; i < dirs.length; i += 1) {
    try {
      fs.accessSync(dirs[i], fs.constants.W_OK);
    } catch (_) {
      return dirs[i];
    }
  }
  return '';
}

// 下载完成：更新状态文件、推 downloaded、必要时系统通知一次、空闲时备份旧版。
async function onUpdatePackageReady(version, info) {
  const ver = String(version || stageVersion || '');
  if (!ver) return;
  stopDownloadProgressTicker();
  stageVersion = ver;
  updateStage = 'downloaded';
  pendingNotes = resolveUpdateNotes(ver, info);
  saveUpdateState({ pendingVersion: ver, lastInstallError: '' });
  const payload = { stage: 'downloaded', version: ver };
  if (pendingNotes) payload.notes = pendingNotes;
  sendUpdateStage(payload);
  const hidden = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized();
  if (hidden && notifiedDownloadVersion !== ver) {
    notifiedDownloadVersion = ver;
    notifyUpdateDownloaded(ver);
  }
  setTimeout(() => { createUpdateBackup(ver).catch(() => {}); }, 2000);
}

async function applyUpdateNow() {
  if (!app.isPackaged) return { ok: false, supported: false, phase: 'install', reason: 'dev' };
  if (process.platform === 'darwin') {
    if (macPreparedUpdate) return await installMacPreparedUpdate(macPreparedUpdate, { quitAfter: true });
    if (pendingUpdateInfo) return await startMacSelfUpdate(pendingUpdateInfo, true);
    return { ok: false, supported: true, phase: 'install', reason: 'not-ready' };
  }
  if (updateStage !== 'downloaded') return { ok: false, supported: true, phase: 'install', reason: 'not-ready', stage: updateStage };
  const blocked = updateInstallBlockedDir();
  if (blocked) {
    const message = '安装目录不可写，无法自动安装：' + blocked;
    saveUpdateState({ lastInstallError: message, installAttempts: (Number(updatePersist.installAttempts) || 0) + 1 });
    sendUpdateStage({ stage: 'error', phase: 'install', message: message });
    return { ok: false, supported: true, phase: 'install', reason: message };
  }
  const version = String(updatePersist.pendingVersion || stageVersion || (pendingUpdateInfo && pendingUpdateInfo.version) || '');
  stopDownloadProgressTicker();
  updateStage = 'installing';
  quitInstallTriggered = true;
  saveUpdateState({ installAttempts: (Number(updatePersist.installAttempts) || 0) + 1 });
  sendUpdateStage({ stage: 'installing', version: version });
  try {
    await stopBackendForUpdate();
  } catch (err) {
    clog('updater', '安装前停止后端失败（继续安装）: ' + (err && err.message || err));
  }
  try {
    if (process.platform === 'win32') autoUpdater.quitAndInstall(true, true);
    else autoUpdater.quitAndInstall();
    return { ok: true, supported: true, phase: 'install', stage: 'installing' };
  } catch (err) {
    const message = String(err && err.message || err);
    saveUpdateState({ lastInstallError: message });
    sendUpdateStage({ stage: 'error', phase: 'install', message: message });
    return { ok: false, supported: true, phase: 'install', reason: message };
  }
}

// 退出时收敛更新状态：mac 启动自替换脚本，Win/Linux 交给 electron-updater 的退出安装。
function convergeUpdateOnQuit() {
  if (!app.isPackaged || quitInstallTriggered) return;
  const current = app.getVersion();
  if (updatePersist.pendingVersion && updatePersist.pendingVersion === current) {
    saveUpdateState({ pendingVersion: '' });
    return;
  }
  if (!updateState.shouldInstallOnQuit(updatePersist, current)) return;
  stopDownloadProgressTicker();
  if (process.platform === 'darwin') {
    if (!macPreparedUpdate) return;
    quitInstallTriggered = true;
    saveUpdateState({ installAttempts: (Number(updatePersist.installAttempts) || 0) + 1 });
    sendUpdateStage({ stage: 'installing', version: String(macPreparedUpdate.version || updatePersist.pendingVersion) });
    installMacPreparedUpdate(macPreparedUpdate, { quitAfter: false }).catch((err) => {
      clog('updater', '退出时启动 mac 安装脚本失败: ' + (err && err.message || err));
    });
    return;
  }
  if (updateStage !== 'downloaded') return;
  quitInstallTriggered = true;
  saveUpdateState({ installAttempts: (Number(updatePersist.installAttempts) || 0) + 1 });
  sendUpdateStage({ stage: 'installing', version: String(updatePersist.pendingVersion || stageVersion) });
}

// 调试开关：dev 模式设置 NOVAI_UPDATE_SIM=downloaded|applied|error 模拟对应事件，例如 NOVAI_UPDATE_SIM=applied npm run dev
function maybeSimulateUpdateEvent() {
  const sim = String(process.env.NOVAI_UPDATE_SIM || '').trim();
  if (!sim || !isDevMode() || updateSimDone) return;
  updateSimDone = true;
  const fake = '9.9.9';
  if (sim === 'downloaded') {
    const notes = updateState.normalizeNotes(fake, {
      version: fake,
      items: [
        { type: 'feature', text: '模拟：右下角出现「新版本已下载」卡片' },
        { type: 'fix', text: '模拟：退出应用时静默安装' },
      ],
    });
    sendUpdateStage({ stage: 'downloaded', version: fake, notes: notes || undefined });
    clog('updater', '[SIM] downloaded 已模拟（NOVAI_UPDATE_SIM=downloaded）');
    return;
  }
  if (sim === 'applied') {
    sendUpdateStage({ stage: 'applied', version: fake, previousVersion: app.getVersion() });
    clog('updater', '[SIM] applied 已模拟（NOVAI_UPDATE_SIM=applied）');
    return;
  }
  if (sim === 'error') {
    sendUpdateStage({ stage: 'error', phase: 'download', message: '模拟下载失败（NOVAI_UPDATE_SIM=error）' });
    clog('updater', '[SIM] error 已模拟（NOVAI_UPDATE_SIM=error）');
    return;
  }
  clog('updater', '[SIM] 未知的 NOVAI_UPDATE_SIM 值: ' + sim);
}

// ---------- 启动动画 ----------
let splashWindow = null;
let splashReady = false;
let splashClosed = false;
let splashTimedOut = false;
let splashStagePending = null;

function setSplashStage(stage, percent) {
  splashStagePending = { stage: stage, percent: percent };
  if (!splashWindow || splashWindow.isDestroyed()) return;
  flushSplashStage();
}

function flushSplashStage() {
  if (!splashReady || !splashWindow || splashWindow.isDestroyed() || !splashStagePending) return;
  const stage = JSON.stringify(String(splashStagePending.stage || ''));
  const percent = Number(splashStagePending.percent) || 0;
  try {
    const task = splashWindow.webContents.executeJavaScript(
      'window.__novaiSplash && window.__novaiSplash.setStage(' + stage + ',' + percent + ')'
    );
    if (task && typeof task.catch === 'function') task.catch(() => {});
  } catch (_) {}
}

function closeSplash() {
  splashClosed = true;
  splashReady = false;
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.destroy(); } catch (_) {}
  }
  splashWindow = null;
}

function createSplashWindow(boot) {
  if (isDevMode() || isSmokeMode() || splashWindow) return;
  splashClosed = false;
  splashTimedOut = false;
  try {
    splashWindow = new BrowserWindow({
      width: 420,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      // 窗口底色与 splash 品牌底色一致，避免窗口出现瞬间闪一下透明/黑。
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#fafafa',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => {});
    splashWindow.webContents.on('did-finish-load', () => {
      splashReady = true;
      flushSplashStage();
    });
    splashWindow.once('ready-to-show', () => {
      if (splashClosed || !splashWindow || splashWindow.isDestroyed()) return;
      try { splashWindow.showInactive(); } catch (_) {
        try { splashWindow.show(); } catch (_) {}
      }
    });
    splashWindow.on('closed', () => {
      splashWindow = null;
      splashReady = false;
    });
    const title = boot && boot.applied ? '正在应用新版本' : (boot && boot.pendingStale ? '正在完成更新' : '正在启动');
    setSplashStage(title, boot && boot.applied ? 16 : 8);
    clog('splash', '启动动画已显示');
    // 后端/界面一直没就绪也不能把用户卡在启动画面上。
    setTimeout(() => {
      if (splashClosed) return;
      splashTimedOut = true;
      clog('splash', '启动动画 15s 超时，直接进入界面');
      closeSplash();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.show(); } catch (_) {}
      }
    }, 15000);
  } catch (err) {
    splashWindow = null;
    clog('splash', '启动动画创建失败（忽略，直接进界面）: ' + (err && err.message || err));
  }
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isSmokeMode()) { closeSplash(); return; }
  if (!splashWindow || splashWindow.isDestroyed()) {
    try { mainWindow.show(); } catch (err) { clog('win', 'show error: ' + err.message); }
    return;
  }
  setSplashStage('就绪', 100);
  setTimeout(() => {
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.show(); } catch (err) { clog('win', 'show error: ' + err.message); }
    }
  }, 260);
}

// 镜像更新地址：CI 把产物同步到 bllack/NOVAI-releases 模型仓库的 electron-release/ 目录。
const UPDATE_MIRROR_URL = 'https://modelscope.cn/models/bllack/NOVAI-releases/resolve/master/electron-release';
const MAC_MIRROR_MANIFEST_URL = UPDATE_MIRROR_URL + '/latest-mac.yml';
const UPDATE_GITHUB_FEED = { provider: 'github', owner: 'invaders-2', repo: 'NOVAI-Infinite-Canvas' };

function updaterSupported() {
  return !!(app.isPackaged && autoUpdater);
}


// ---------- macOS 自替换更新（不依赖 Developer ID） ----------
// 检查更新仍走 electron-updater；发现新版本后自己下载 zip → 校验 sha512 → ditto 解压 →
// 生成 install.sh，退出应用后由分离的 shell 脚本替换 .app、清 quarantine、ad-hoc 重签并重新打开。
// 两个环境变量只用于离线自测（tests/e2e_mac_updater.js），正常安装包不会设置它们：
//   NOVAI_UPDATE_ZIP   直接使用本地 zip，跳过下载（sha512 仍按文件校验）
//   NOVAI_UPDATE_TARGET 直接指定要替换的 .app（默认由 app.getPath('exe') 反推）
//   NOVAI_UPDATE_WAIT  替换脚本等待主进程退出的秒数（默认 120）
const MAC_UPDATE_ZIP_OVERRIDE = process.env.NOVAI_UPDATE_ZIP || '';
const MAC_UPDATE_TARGET_OVERRIDE = process.env.NOVAI_UPDATE_TARGET || '';
const MAC_UPDATE_WAIT_SECONDS = Number(process.env.NOVAI_UPDATE_WAIT) > 0 ? Math.floor(Number(process.env.NOVAI_UPDATE_WAIT)) : 120;
let macUpdateRunning = false;

function macUpdatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function sendUpdateProgress(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novai:update-progress', payload || {});
  } catch (_) {}
}

function pushDownloadProgress(version, percent, transferred, total) {
  lastDownloadProgress = {
    version: String(version || stageVersion || ''),
    percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
    transferred: Number(transferred) || 0,
    total: Number(total) || 0,
  };
}

function emitDownloadProgressStage() {
  if (!lastDownloadProgress) return;
  sendUpdateStage({
    stage: 'downloading',
    version: lastDownloadProgress.version,
    percent: lastDownloadProgress.percent,
    transferred: lastDownloadProgress.transferred,
    total: lastDownloadProgress.total,
  });
}

// 前端靠 500ms 内有进度判断下载还活着；electron-updater 原生回调间隔不固定，这里固定节拍补发。
function startDownloadProgressTicker(version) {
  pushDownloadProgress(version, 0, 0, 0);
  emitDownloadProgressStage();
  if (downloadProgressTimer) return;
  downloadProgressTimer = setInterval(emitDownloadProgressStage, 400);
}

function stopDownloadProgressTicker() {
  if (downloadProgressTimer) {
    clearInterval(downloadProgressTimer);
    downloadProgressTimer = null;
  }
  lastDownloadProgress = null;
}

// macOS 老链路（自己下 zip）的进度：旧通道给老前端，新通道由 ticker 统一按节拍发。
function sendDownloadProgress(percent, transferred, total, extra) {
  const payload = Object.assign({ stage: 'downloading', percent: percent, transferred: transferred, total: total }, extra || {});
  sendUpdateProgress(payload);
  pushDownloadProgress(macDownloadingVersion || stageVersion || String(updatePersist.pendingVersion || ''), percent, transferred, total);
}

function macZipSizeMb(info) {
  try {
    const zipFile = macUpdater.pickMacZipFile(info && info.files);
    const bytes = Number(zipFile && zipFile.size);
    if (bytes > 0) return Math.max(1, Math.round(bytes / 1024 / 1024));
  } catch (_) {}
  return 210;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs || 0, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || err).trim().slice(0, 400);
        return reject(new Error(command + ' 执行失败: ' + detail));
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// 用 Chromium 网络栈下载（会自动跟随 GitHub 302 到 objects.githubusercontent.com）。
// 边下边算 sha512，落盘前校验；不匹配就删掉临时文件。
function downloadMacUpdateZip(url, dest, expectedSha512, expectedSize) {
  return new Promise((resolve, reject) => {
    let parsed = null;
    try { parsed = new URL(url); } catch (_) { return reject(new Error('安装包地址无效')); }
    if (parsed.protocol !== 'https:') return reject(new Error('安装包地址必须是 https'));
    const partPath = dest + '.part';
    let settled = false;
    let transferred = 0;
    let total = Number(expectedSize) || 0;
    let lastSentAt = 0;
    const hash = crypto.createHash('sha512');
    let outFile = null;
    try { outFile = fs.createWriteStream(partPath); } catch (err) { return reject(err); }
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { if (outFile) outFile.destroy(); } catch (_) {}
      try { fs.rmSync(partPath, { force: true }); } catch (_) {}
      reject(err);
    };
    outFile.on('error', fail);
    const request = net.request({ url: url, method: 'GET', redirect: 'follow' });
    request.on('response', (response) => {
      const status = Number(response.statusCode) || 0;
      if (status < 200 || status >= 300) {
        try { response.destroy(); } catch (_) {}
        return fail(new Error('下载失败 HTTP ' + status));
      }
      const contentLength = Number(response.headers && response.headers['content-length']);
      if (contentLength > 0) total = contentLength;
      sendDownloadProgress(0, 0, total);
      response.on('data', (chunk) => {
        if (settled) return;
        transferred += chunk.length;
        hash.update(chunk);
        outFile.write(chunk);
        const now = Date.now();
        if (now - lastSentAt >= 300) {
          lastSentAt = now;
          const percent = total > 0 ? Math.min(100, Math.round((transferred * 1000) / total) / 10) : 0;
          sendDownloadProgress(percent, transferred, total);
        }
      });
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        outFile.end(() => {
          if (settled) return;
          const digest = hash.digest('base64');
          if (expectedSha512 && digest !== String(expectedSha512)) {
            return fail(new Error('安装包 sha512 校验失败'));
          }
          try { fs.renameSync(partPath, dest); } catch (err) { return fail(err); }
          settled = true;
          sendDownloadProgress(100, transferred, total);
          resolve(dest);
        });
      });
    });
    request.on('error', fail);
    request.end();
  });
}

// 版本比较：2.0.5 > 2.0.4；正式版比同号预发布版新。
function compareUpdateVersions(a, b) {
  const parse = (value) => {
    const text = String(value || '').trim().replace(/^v/i, '');
    const dash = text.indexOf('-');
    const core = dash >= 0 ? text.slice(0, dash) : text;
    return { nums: core.split('.').map((part) => Number(part) || 0), pre: dash >= 0 ? text.slice(dash + 1) : '' };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

// latest-mac.yml 是 electron-builder 固定结构，复用 mac-updater 的行解析，不引 yaml 依赖。
function parseMirrorMacManifest(text) {
  const yml = macUpdater.parseLatestMacYml(text);
  const version = String(yml.version || '').trim();
  if (!version) return { ok: false, reason: 'manifest-without-version' };
  const zipFile = macUpdater.pickMacZipFile(yml.files);
  if (!zipFile || !zipFile.url) return { ok: false, reason: 'manifest-without-zip' };
  return {
    ok: true,
    version: version,
    url: String(zipFile.url).trim(),
    sha512: String(zipFile.sha512 || '').trim(),
    size: Number(zipFile.size) || 0,
  };
}

function resolveMirrorAssetUrl(fileUrl, mirrorBase) {
  const raw = String(fileUrl || '').trim();
  if (!raw) throw new Error('镜像安装包地址为空');
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error('镜像安装包地址必须是 https: ' + raw.slice(0, 120));
  return String(mirrorBase || '').replace(/\/+$/, '') + '/' + raw.replace(/^\/+/, '');
}

// 纯函数：镜像 manifest → 可用更新。字段缺失 / 版本不新都返回 ok:false，由调用方回退 GitHub。
function pickMirrorMacUpdate(manifestText, currentVersion, mirrorBase) {
  const manifest = parseMirrorMacManifest(manifestText);
  if (!manifest.ok) return manifest;
  if (compareUpdateVersions(manifest.version, currentVersion) <= 0) {
    return { ok: false, reason: 'mirror-not-newer: ' + manifest.version + ' <= ' + String(currentVersion || ''), version: manifest.version };
  }
  try {
    return {
      ok: true,
      version: manifest.version,
      url: resolveMirrorAssetUrl(manifest.url, mirrorBase),
      sha512: manifest.sha512,
      size: manifest.size,
    };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
}

function fetchUpdateManifest(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const limit = Math.max(1000, Number(timeoutMs) || 15000);
    let settled = false;
    let timer = null;
    let request = null;
    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (err) reject(err);
      else resolve(text);
    };
    try { request = net.request({ url: url, method: 'GET', redirect: 'follow', cache: false }); } catch (err) { return finish(err); }
    timer = setTimeout(() => {
      try { request.abort(); } catch (_) {}
      finish(new Error('镜像 manifest 请求超时'));
    }, limit);
    request.on('response', (response) => {
      const status = Number(response.statusCode) || 0;
      const chunks = [];
      response.on('data', (chunk) => { if (!settled) chunks.push(chunk); });
      response.on('end', () => {
        if (status < 200 || status >= 300) return finish(new Error('HTTP ' + status));
        finish(null, Buffer.concat(chunks).toString('utf8'));
      });
      response.on('error', (err) => finish(err));
    });
    request.on('error', (err) => finish(err));
    request.end();
  });
}

async function resolveMirrorMacUpdate(currentVersion) {
  const text = await fetchUpdateManifest(MAC_MIRROR_MANIFEST_URL, 15000);
  const picked = pickMirrorMacUpdate(text, currentVersion, UPDATE_MIRROR_URL);
  if (picked.ok) clog('updater', '镜像 latest-mac.yml 可用: v' + picked.version + ' → ' + picked.url);
  else clog('updater', '镜像 latest-mac.yml 不可用: ' + picked.reason);
  return picked;
}

// 先镜像后 GitHub：镜像 manifest / 下载 / 校验任何一步失败都回退 GitHub 原逻辑，
// 抛错只可能来自 GitHub 分支。
async function withMacUpdateSource(mirrorAttempt, githubAttempt) {
  let reason = '';
  try {
    const mirror = await mirrorAttempt();
    if (mirror && mirror.ok) return mirror;
    reason = (mirror && mirror.reason) || 'mirror-unavailable';
  } catch (err) {
    reason = String(err && err.message || err);
  }
  clog('updater', '镜像更新不可用，回退 GitHub: ' + reason);
  const github = await githubAttempt();
  return Object.assign({ source: 'github' }, github || {});
}

// 下载并校验一个来源的 zip（镜像和 GitHub 共用），校验失败抛错由上层决定是否回退。
async function prepareMacZip(opts) {
  const options = opts || {};
  const source = options.source || 'github';
  const version = String(options.version || '');
  const zipUrl = String(options.zipUrl || '');
  const updatesDir = macUpdatesDir();
  fs.mkdirSync(updatesDir, { recursive: true });
  const fileName = path.basename(new URL(zipUrl).pathname) || ('NOVAI-' + version + '-arm64-mac.zip');
  const zipPath = path.join(updatesDir, fileName);
  const expectedSha = String(options.sha512 || '');
  const expectedSize = Number(options.size) || 0;
  const attemptUrls = [zipUrl].concat((options.altUrls || []).filter((item) => item && item !== zipUrl));
  const cached = fs.existsSync(zipPath)
    && (!expectedSize || fs.statSync(zipPath).size === expectedSize)
    && (!expectedSha || await macUpdater.verifySha512(zipPath, expectedSha));
  if (cached) {
    clog('updater', '复用已下载的安装包（源=' + source + '）: ' + zipPath);
    sendDownloadProgress(100, expectedSize, expectedSize, { cached: true });
    return zipPath;
  }
  updateStage = 'downloading';
  try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
  clog('updater', '开始下载 macOS 更新包（源=' + source + '，版本=' + version + '）: ' + attemptUrls[0]);
  for (let attempt = 0; attempt < attemptUrls.length; attempt += 1) {
    if (attempt > 0) clog('updater', '改用备用地址重试(' + attempt + '/' + (attemptUrls.length - 1) + '): ' + attemptUrls[attempt]);
    try {
      await downloadMacUpdateZip(attemptUrls[attempt], zipPath, expectedSha, expectedSize);
      clog('updater', '更新包下载完成（源=' + source + '）: ' + attemptUrls[attempt]);
      break;
    } catch (err) {
      const message = String(err && err.message || err);
      clog('updater', '下载失败(' + (attempt + 1) + '/' + attemptUrls.length + '，源=' + source + '): ' + attemptUrls[attempt] + ' → ' + message);
      if (!/HTTP \d+/.test(message) || attempt === attemptUrls.length - 1) throw err;
    }
  }
  if (expectedSha && !(await macUpdater.verifySha512(zipPath, expectedSha))) {
    try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
    throw new Error('安装包 sha512 校验失败（源=' + source + '）');
  }
  if (expectedSize) {
    const actualSize = fs.statSync(zipPath).size;
    if (actualSize !== expectedSize) {
      try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
      throw new Error('安装包大小校验失败（源=' + source + '）: ' + actualSize + ' != ' + expectedSize);
    }
  }
  return zipPath;
}

// macOS 第一阶段：只把 zip 下好并校验，不退出应用，留给用户决定什么时候装。
async function prepareMacUpdate(info) {
  if (process.platform !== 'darwin') return { ok: false, supported: false, reason: 'not-darwin' };
  fs.mkdirSync(macUpdatesDir(), { recursive: true });
  if (MAC_UPDATE_ZIP_OVERRIDE) {
    const overrideZip = MAC_UPDATE_ZIP_OVERRIDE;
    if (!fs.existsSync(overrideZip)) throw new Error('测试钩子指定的 zip 不存在: ' + overrideZip);
    return {
      ok: true,
      source: 'override',
      version: process.env.NOVAI_UPDATE_VERSION || macUpdater.versionFromZipName(overrideZip),
      zipPath: overrideZip,
    };
  }
  // 先试国内镜像（github.com 常被 reset），镜像任何一步失败都回退现有 GitHub 逻辑。
  const prepared = await withMacUpdateSource(async () => {
    const mirror = await resolveMirrorMacUpdate(app.getVersion());
    if (!mirror.ok) return mirror;
    const mirrorZip = await prepareMacZip({
      source: 'mirror',
      version: mirror.version,
      zipUrl: mirror.url,
      sha512: mirror.sha512,
      size: mirror.size,
    });
    return { ok: true, source: 'mirror', version: mirror.version, zipPath: mirrorZip };
  }, async () => {
    if (!info) throw new Error('缺少更新信息');
    const githubVersion = String(info.version || '');
    const updateTag = info && info.tag;   // electron-updater 给的真实 Release tag，如 v2.0.03
    const zipFile = macUpdater.pickMacZipFile(info && info.files);
    if (!zipFile) throw new Error('更新信息里没有 zip 安装包');
    const zipUrl = macUpdater.resolveMacZipUrl(zipFile.url, githubVersion, updateTag);
    // 主地址用真实 tag；下载返回非 2xx 时，再用「版本号补零」的 tag 兜底试一次
    const altUrls = [];
    const altTag = macUpdater.releaseTagFromVersion(githubVersion);
    if (altTag) {
      const altUrl = macUpdater.resolveMacZipUrl(zipFile.url, githubVersion, altTag);
      if (altUrl && altUrl !== zipUrl) altUrls.push(altUrl);
    }
    const githubZip = await prepareMacZip({
      source: 'github',
      version: githubVersion,
      zipUrl: zipUrl,
      altUrls: altUrls,
      sha512: zipFile.sha512,
      size: zipFile.size,
    });
    return { ok: true, source: 'github', version: githubVersion, zipPath: githubZip };
  });
  const version = String(prepared.version || '');
  const zipPath = String(prepared.zipPath || '');
  clog('updater', '本次 macOS 更新源=' + prepared.source + '，版本=' + (version || '') + '，安装包=' + zipPath);
  return { ok: true, source: prepared.source, version: version, zipPath: zipPath };
}

// macOS 第二阶段：解压 → 校验 .app → 生成 install.sh → 分离脚本等本进程退出后替换。
async function installMacPreparedUpdate(prepared, options) {
  if (process.platform !== 'darwin') return { ok: false, supported: false, reason: 'not-darwin' };
  const opts = options || {};
  const updatesDir = macUpdatesDir();
  const version = String(prepared && prepared.version || '');
  const zipPath = String(prepared && prepared.zipPath || '');
  let tmpDir = '';
  try {
    if (!zipPath || !fs.existsSync(zipPath)) throw new Error('安装包不存在: ' + zipPath);
    fs.mkdirSync(updatesDir, { recursive: true });
    stopDownloadProgressTicker();
    updateStage = 'installing';
    // 这里还不能算 install 已开始（后面解压/校验仍可能失败），final 等脚本真正启动再发。
    sendUpdateStage({ stage: 'installing', version: version || stageVersion });
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'novai-update-'));
    clog('updater', '解压更新包: ' + zipPath + ' → ' + tmpDir);
    await runCommand('ditto', ['-x', '-k', zipPath, tmpDir], 10 * 60 * 1000);
    const newApp = macUpdater.findAppBundleInDir(tmpDir);
    if (!newApp) throw new Error('安装包里没有找到 .app');
    const expectedVersion = process.env.NOVAI_UPDATE_VERSION || version || '';
    const appCheck = macUpdater.validateAppBundle(newApp, expectedVersion);
    if (!appCheck.ok) throw new Error('新版本校验失败: ' + appCheck.reason);

    const targetApp = MAC_UPDATE_TARGET_OVERRIDE || macUpdater.appBundleFromExe(app.getPath('exe'));
    if (!targetApp) throw new Error('无法从可执行路径反推 .app 位置');
    if (!fs.existsSync(path.join(targetApp, 'Contents', 'Info.plist'))) throw new Error('目标不是完整的 .app: ' + targetApp);
    try {
      fs.accessSync(path.dirname(targetApp), fs.constants.W_OK);
    } catch (_) {
      throw new Error('目标目录不可写: ' + path.dirname(targetApp));
    }

    const logPath = path.join(updatesDir, 'install.log');
    const scriptPath = path.join(updatesDir, 'install.sh');
    const script = macUpdater.buildInstallScript({
      pid: process.pid,
      targetApp: targetApp,
      newApp: newApp,
      tmpDir: tmpDir,
      logPath: logPath,
      waitSeconds: MAC_UPDATE_WAIT_SECONDS,
    });
    fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    try { fs.chmodSync(scriptPath, 0o755); } catch (_) {}
    try { fs.writeFileSync(logPath, '[' + new Date().toISOString() + '] 安装脚本已生成，等待进程 ' + process.pid + ' 退出\n'); } catch (_) {}

    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    clog('updater', 'mac 自替换脚本已启动: ' + scriptPath + ' target=' + targetApp + ' version=' + (version || appCheck.version || ''));
    sendUpdateStage({ stage: 'installing', version: version || appCheck.version || stageVersion });
    updateStage = 'installing';
    macPreparedUpdate = null;
    quitInstallTriggered = true;
    if (opts.quitAfter !== false) {
      // 先让后端收尾再退：直接 app.exit 会留下半截进程/端口，替换脚本也可能被占用。
      setTimeout(() => {
        stopBackendForUpdate().then(() => { app.quit(); });
      }, 300);
    }
    return { ok: true, supported: true, phase: 'install', stage: 'installing', version: version || appCheck.version };
  } catch (err) {
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    updateStage = 'available';
    const reason = String(err && err.message || err);
    clog('updater', 'mac 自替换更新失败: ' + reason);
    saveUpdateState({ lastInstallError: reason, installAttempts: (Number(updatePersist.installAttempts) || 0) + 1 });
    sendUpdateStage({ stage: 'error', phase: 'install', message: reason });
    return { ok: false, supported: true, phase: 'install', reason: reason };
  }
}

// 显式安装（前端「一键更新」/托盘操作）：没有现成 zip 就先下载，再走替换。
async function startMacSelfUpdate(info, skipPrompt) {
  if (process.platform !== 'darwin') return { ok: false, supported: false, reason: 'not-darwin' };
  if (macUpdateRunning) return { ok: true, supported: true, stage: updateStage };
  macUpdateRunning = true;
  try {
    let prepared = macPreparedUpdate;
    if (!prepared) {
      startDownloadProgressTicker(String((info && info.version) || (pendingUpdateInfo && pendingUpdateInfo.version) || stageVersion || ''));
      prepared = await prepareMacUpdate(info || pendingUpdateInfo);
      if (!prepared.ok) throw new Error(prepared.reason || '下载更新包失败');
      macPreparedUpdate = prepared;
    }
    if (info) pendingUpdateInfo = info;
    return await installMacPreparedUpdate(prepared, { quitAfter: true });
  } catch (err) {
    updateStage = 'available';
    const reason = String(err && err.message || err);
    clog('updater', 'mac 自动更新失败: ' + reason);
    saveUpdateState({ lastInstallError: reason });
    sendUpdateStage({ stage: 'error', phase: 'download', message: reason });
    return { ok: false, supported: true, phase: 'download', reason: reason };
  } finally {
    macUpdateRunning = false;
  }
}

// 发现新版本后 macOS 也静默下载，下载完只发 downloaded，不打断用户。
async function startMacSilentDownload(info) {
  if (process.platform !== 'darwin' || macDownloadRunning || macUpdateRunning) return;
  const version = String(info && info.version || '');
  if (!version || version === app.getVersion()) return;
  macDownloadRunning = true;
  macDownloadingVersion = version;
  stageVersion = version;
  updateStage = 'downloading';
  const totalBytes = macZipSizeMb(info) * 1024 * 1024;
  startDownloadProgressTicker(version);
  pushDownloadProgress(version, 0, 0, totalBytes);
  emitDownloadProgressStage();
  try {
    const prepared = await prepareMacUpdate(info);
    macPreparedUpdate = prepared;
    macDownloadingVersion = '';
    clog('updater', 'macOS 更新包已静默下载完成: v' + (prepared.version || version));
    await onUpdatePackageReady(prepared.version || version, info);
  } catch (err) {
    macDownloadingVersion = '';
    updateStage = 'available';
    const reason = String(err && err.message || err);
    clog('updater', 'macOS 静默下载更新失败: ' + reason);
    saveUpdateState({ lastInstallError: reason });
    sendUpdateStage({ stage: 'error', phase: 'download', message: reason });
  } finally {
    macDownloadRunning = false;
  }
}

// 发现新版本后不弹窗，直接开始后台下载；Windows/Linux 与 macOS 各自走自己的下载链路。
function startUpdateDownload(info) {
  if (process.platform === 'darwin') {
    startMacSilentDownload(info);
    return;
  }
  const version = String(info && info.version || '');
  if (version) stageVersion = version;
  updateStage = 'downloading';
  startDownloadProgressTicker(stageVersion);
  try {
    const task = autoUpdater.downloadUpdate();
    if (task && typeof task.catch === 'function') task.catch(() => {});
  } catch (err) {
    updateStage = 'idle';
    const message = String(err && err.message || err);
    clog('updater', '下载更新包失败: ' + message);
    sendUpdateStage({ stage: 'error', phase: 'download', message: message });
  }
}

function sendDownloadedStageOnce() {
  const version = String(updatePersist.pendingVersion || stageVersion || (pendingUpdateInfo && pendingUpdateInfo.version) || '');
  if (!version) return;
  if (!pendingNotes) pendingNotes = resolveUpdateNotes(version, pendingUpdateInfo);
  const payload = { stage: 'downloaded', version: version };
  if (pendingNotes) payload.notes = pendingNotes;
  sendUpdateStage(payload);
}

function startManualUpdateCheck() {
  stopDownloadProgressTicker();
  manualUpdateCheck = true;
  updateStage = 'checking';
  try {
    const task = autoUpdater.checkForUpdates();
    if (task && typeof task.catch === 'function') task.catch(() => {});
  } catch (err) {
    manualUpdateCheck = false;
    updateStage = 'idle';
    return { ok: false, supported: true, phase: 'check', reason: String(err && err.message || err) };
  }
  return { ok: true, supported: true, phase: 'check', stage: 'checking' };
}

// 网页端「一键更新」在桌面版转交到这里：只复用桌面更新链路。
// 绝不能回落到后端 /api/update-from-github——那会让后端自重启，主进程会当成后端崩溃弹窗。
function registerUpdaterIpc() {
  ipcMain.handle('novai:update-check', async () => {
    if (!updaterSupported()) return { ok: false, supported: false, reason: 'unavailable' };
    // 已经下好：把 downloaded 再推一次，绝不再下一次
    if (updateStage === 'downloaded') {
      sendDownloadedStageOnce();
      return { ok: true, supported: true, stage: updateStage };
    }
    if (updateStage === 'downloading' || updateStage === 'installing' || updateStage === 'checking') {
      return { ok: true, supported: true, stage: updateStage };
    }
    if (updateStage === 'available') {
      startUpdateDownload(pendingUpdateInfo);
      return { ok: true, supported: true, stage: 'downloading' };
    }
    return startManualUpdateCheck();
  });

  // 兼容旧前端「立即更新」按钮：有包就直接装，没有就先静默下载。
  ipcMain.handle('novai:update-install', async () => {
    if (!updaterSupported()) return { ok: false, supported: false, reason: 'unavailable' };
    if (process.platform === 'darwin') {
      // 测试钩子：直接拿本地 zip 走完解压/替换，不需要先 check 到新版本
      if (MAC_UPDATE_ZIP_OVERRIDE) return await startMacSelfUpdate(null, true);
      if (updateStage === 'downloaded') return await applyUpdateNow();
      if (updateStage === 'downloading' || updateStage === 'installing') return { ok: true, supported: true, stage: updateStage };
      if (updateStage === 'available') {
        startUpdateDownload(pendingUpdateInfo);
        return { ok: true, supported: true, stage: 'downloading' };
      }
      return startManualUpdateCheck();
    }
    if (updateStage === 'downloaded') return await applyUpdateNow();
    if (updateStage === 'downloading' || updateStage === 'checking' || updateStage === 'installing') {
      return { ok: true, supported: true, stage: updateStage };
    }
    if (updateStage === 'available') {
      startUpdateDownload(pendingUpdateInfo);
      return { ok: true, supported: true, stage: 'downloading' };
    }
    return startManualUpdateCheck();
  });

  ipcMain.handle('novai:update-restart', async () => {
    if (!app.isPackaged) return { ok: false, supported: false, phase: 'install', reason: 'dev' };
    return await applyUpdateNow();
  });

  ipcMain.handle('novai:update-later', async () => {
    const version = String((pendingUpdateInfo && pendingUpdateInfo.version)
      || updatePersist.pendingVersion || stageVersion || '');
    const downloaded = updateStage === 'downloaded' || !!(process.platform === 'darwin' && macPreparedUpdate);
    if (!version) return { ok: false, phase: 'install', reason: 'no-pending-version' };
    if (!downloaded) return { ok: false, phase: 'download', reason: 'not-downloaded', version: version };
    if (app.isPackaged) saveUpdateState({ pendingVersion: version });
    return { ok: true, phase: 'install', version: version };
  });

  ipcMain.handle('novai:update-notes-seen', async (event, payload) => {
    const version = String(typeof payload === 'string' ? payload : (payload && payload.version) || '');
    if (version && app.isPackaged) saveUpdateState({ notesSeenVersion: version });
    return { ok: true, version: version };
  });

  ipcMain.handle('novai:update-retry', async () => {
    if (!updaterSupported()) return { ok: false, supported: false, phase: 'check', reason: 'unavailable' };
    macPreparedUpdate = null;
    pendingReinstallWanted = false;
    saveUpdateState({ lastInstallError: '', installAttempts: 0 });
    // 用户主动重试：重新允许退出时安装，否则 setupAutoUpdate 里放弃过的开关会继续拦着。
    if (autoUpdater) autoUpdater.autoInstallOnAppQuit = true;
    updateStage = 'idle';
    return startManualUpdateCheck();
  });
}

function ensureAppUpdateConfig() {
  if (!app.isPackaged) return;
  const target = path.join(process.resourcesPath, 'app-update.yml');
  if (fs.existsSync(target)) return;
  const config = [
    'provider: github',
    'owner: invaders-2',
    'repo: NOVAI-Infinite-Canvas',
    'updaterCacheDirName: novai-desktop-updater',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(target, config, { encoding: 'utf8', flag: 'wx' });
    clog('updater', '已补齐缺失的 app-update.yml');
  } catch (err) {
    if (!fs.existsSync(target)) clog('updater', '无法补齐 app-update.yml: ' + (err && err.message || err));
  }
}

// 更新源顺序：Windows 上 GitHub Releases 常被 reset、镜像里的 exe 也可能没同步，
// 镜像优先、失败回退 GitHub；其它平台保持原来的 GitHub 优先。
function updateFeedOrder(platform) {
  const mirror = { source: 'mirror', label: '国内镜像', config: { provider: 'generic', url: UPDATE_MIRROR_URL } };
  const github = { source: 'github', label: 'GitHub', config: UPDATE_GITHUB_FEED };
  return platform === 'win32' ? [mirror, github] : [github, mirror];
}

// 返回下一个还没试过的更新源（null = 都试过了）。每个源最多切一次，避免死循环。
function nextUntriedFeed(order, attemptedSources) {
  const list = Array.isArray(order) ? order : [];
  for (let i = 0; i < list.length; i += 1) {
    if (!attemptedSources || !attemptedSources.has(list[i].source)) return list[i];
  }
  return null;
}

function applyUpdateFeed(feed) {
  autoUpdater.setFeedURL(feed.config);
  clog('updater', '更新源=' + feed.label + '（' + feed.source + '）' + (feed.config.url ? ': ' + feed.config.url : ''));
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  ensureAppUpdateConfig();
  try {
    autoUpdater = autoUpdater || require('electron-updater').autoUpdater;
    if (!autoUpdater) return;
  } catch (err) { clog('updater', 'electron-updater 初始化失败: ' + (err && err.message || err)); return; }
  autoUpdater.autoDownload = false;
  // 下好的包等用户点「立即重启」，或者退出应用时静默装完（mac 走自替换脚本，见 convergeUpdateOnQuit）。
  autoUpdater.autoInstallOnAppQuit = true;
  if (updatePersist.installAttempts >= updateState.INSTALL_GIVE_UP) {
    autoUpdater.autoInstallOnAppQuit = false;
    saveUpdateState({ pendingVersion: '' });
    clog('updater', '自动安装已连续失败 ' + updatePersist.installAttempts + ' 次，本次启动不再退出安装');
  }
  updateStage = 'checking';
  // 测试版（版本号含 -，如 1.0.112-beta.1）允许接收 prerelease 更新；正式版只看正式 Release。
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  const feedOrder = updateFeedOrder(process.platform);
  const attemptedSources = new Set();
  let currentFeed = feedOrder[0];
  attemptedSources.add(currentFeed.source);
  try {
    applyUpdateFeed(currentFeed);
  } catch (err) {
    clog('updater', '更新源初始化失败: ' + (err && err.message || err));
  }
  autoUpdater.on('checking-for-update', () => { updateStage = 'checking'; });
  autoUpdater.on('update-not-available', () => {
    updateStage = 'idle';
    stopDownloadProgressTicker();
    // 远端已经没有待装版本（下架/回滚）→ 清掉本地 pending，避免每次启动/退出都重试。
    const stalePending = String(updatePersist.pendingVersion || '');
    if (pendingReinstallWanted) {
      pendingReinstallWanted = false;
      if (stalePending && stalePending !== app.getVersion()) {
        saveUpdateState({ pendingVersion: '' });
        clog('updater', '远端已没有 v' + stalePending + '，清除本地 pending');
      }
    }
    // 只有用户主动点「一键更新」才提示「已是最新版本」，启动时的自动检查保持安静
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '已是最新版本',
      message: '当前已是最新版本 v' + app.getVersion(),
    }).catch(() => {});
  });
  autoUpdater.on('update-available', (info) => {
    manualUpdateCheck = false;
    const next = info && info.version;
    // 版本号相同（镜像/缓存回放）不算更新，否则会一直停在 available 反复下载
    if (!next || next === app.getVersion()) { updateStage = 'idle'; return; }
    updateStage = 'available';
    pendingUpdateInfo = info;
    pendingReinstallWanted = false;
    // 发现新版本不弹窗，直接后台静默下载；下载完成后再由前端卡片问用户是否重启。
    startUpdateDownload(info);
  });
  autoUpdater.on('download-progress', (p) => {
    updateStage = 'downloading';
    // macOS 走自替换链路，进度由下载函数自己发；Windows/Linux 在这里转发给界面
    if (process.platform === 'darwin') return;
    const info = p || {};
    const percent = Math.round(info.percent || 0);
    const transferred = info.transferred || 0;
    const total = info.total || 0;
    sendUpdateProgress({ stage: 'downloading', percent: percent, transferred: transferred, total: total });
    pushDownloadProgress(stageVersion || String((pendingUpdateInfo && pendingUpdateInfo.version) || ''), percent, transferred, total);
  });
  autoUpdater.on('update-downloaded', (info) => {
    manualUpdateCheck = false;
    const version = String(info && info.version || stageVersion || '');
    onUpdatePackageReady(version, info).catch((err) => {
      clog('updater', '处理下载完成事件失败: ' + (err && err.message || err));
    });
  });
  autoUpdater.on('error', (err) => {
    // 后面还要按失败阶段选文案，先把阶段存下来（错误处理里会复位状态）
    const failedStage = updateStage;
    const stageLabel = { checking: '检查更新', available: '检查更新', downloading: '下载更新包', downloaded: '安装更新', installing: '安装更新' }[failedStage] || '检查更新';
    const installPhase = failedStage === 'downloaded' || failedStage === 'installing';
    const rawError = String(err && err.message || err);
    clog('updater', '[' + stageLabel + '] 更新失败（源=' + currentFeed.label + '）: ' + rawError);
    // 当前源失败时切到下一个还没试过的源再试一次（每个源只切一次，避免死循环）；
    // 安装阶段失败时包已下好，重试下载没有意义。
    if (!installPhase) {
      const next = nextUntriedFeed(feedOrder, attemptedSources);
      if (next) {
        attemptedSources.add(next.source);
        try {
          clog('updater', '更新源 ' + currentFeed.label + ' 失败，切换到 ' + next.label + ' 重试一次');
          currentFeed = next;
          applyUpdateFeed(next);
          updateStage = 'checking';
          const task = autoUpdater.checkForUpdates();
          if (task && typeof task.catch === 'function') task.catch(() => {});
          return;
        } catch (e) {
          currentFeed = next;
          clog('updater', '切换更新源到 ' + next.label + ' 失败: ' + (e && e.message || e));
        }
      }
      clog('updater', '所有更新源均失败（已尝试: ' + Array.from(attemptedSources).join(', ') + '）');
    }
    manualUpdateCheck = false;
    stopDownloadProgressTicker();
    // 安装阶段失败保持 downloaded：包还在，用户可以重试安装；其它阶段回到 idle 可重新检查。
    updateStage = installPhase ? 'downloaded' : 'idle';
    saveUpdateState({ lastInstallError: installPhase ? rawError : '' });
    sendUpdateStage({
      stage: 'error',
      phase: installPhase ? 'install' : (failedStage === 'downloading' ? 'download' : 'check'),
      message: rawError,
    });
  });
  setTimeout(() => {
    try {
      const task = autoUpdater.checkForUpdates();
      if (task && typeof task.catch === 'function') task.catch(() => {});
    } catch (_) {}
  }, 8000);
}

// ---------- 内嵌 webview 安全策略 ----------
// 面板已改用 WebContentsView；<webview> 仅作安全兜底：参数一律不信任，
// will-attach-webview 里先强制安全偏好，再按来源域名决定是否放行。
// WEBVIEW_ALLOWED_DOMAINS 只用于「在线素材初始入口 URL」；用户在视图内的导航
// 不受域名限制，只拦非 http(s)（见 createSourceView）。
const WEBVIEW_ALLOWED_DOMAINS = [
  'pinterest.com',
  'pinimg.com',
  'huaban.com',
  'huabanimg.com',
  'xiaohongshu.com',
  'xhscdn.com',
];

function isAllowedWebviewUrl(target) {
  let parsed = null;
  try {
    parsed = new URL(String(target || ''));
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return WEBVIEW_ALLOWED_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain));
}

function handleWillAttachWebview(event, webPreferences, params) {
  // 先强制安全偏好（页面传什么都覆盖），再判断域名。
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.partition = SOURCE_BROWSER_PARTITION;
  const target = String((params && params.src) || '');
  if (!isAllowedWebviewUrl(target)) {
    event.preventDefault();
    clog('webview', '拒绝挂载非白名单 webview: ' + target);
  }
}

function installWebviewSecurityPolicy() {
  app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', handleWillAttachWebview);
  });
}

// ---------- 窗口拖动（Windows 自绘标题栏兜底） ----------
// 自绘标题栏的 -webkit-app-region: drag 在部分 Windows 环境下不生效，
// 前端 mousedown 同时会桥到这里按光标差量挪窗口，保证标题栏一定拖得动。
let dragTimer = null;
let dragAnchor = null;
function stopWindowDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragAnchor = null;
}
function startWindowDrag() {
  stopWindowDrag();
  // mac/linux 有原生标题栏且 app-region 可用，保持原有行为不接管拖动
  if (process.platform !== 'win32') return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 最大化时窗口位置由系统摆放，跟随会抖飞，直接忽略本次拖动
  if (mainWindow.isMaximized()) { clog('win', '最大化状态下忽略标题栏拖动'); return; }
  const point = screen.getCursorScreenPoint();
  const [winX, winY] = mainWindow.getPosition();
  dragAnchor = { mouseX: point.x, mouseY: point.y, winX: winX, winY: winY };
  dragTimer = setInterval(() => {
    if (!dragAnchor || !mainWindow || mainWindow.isDestroyed()) { stopWindowDrag(); return; }
    const cur = screen.getCursorScreenPoint();
    mainWindow.setPosition(
      Math.round(dragAnchor.winX + cur.x - dragAnchor.mouseX),
      Math.round(dragAnchor.winY + cur.y - dragAnchor.mouseY)
    );
  }, 16);
}

// ---------- 窗口 ----------
// 主窗口尺寸不能写死 1440x900：1366x768、1080p@125%/150% 等机器的工作区比它小，
// 窗口会被系统摆到屏幕外，右侧窗口三键与右上工具栏看起来像“错位”。
// workArea 用 Electron 的 screen（已是 DIP，高 DPI 自动换算），四周各留 20px 边距并居中。
function computeWindowBounds(workArea) {
  if (!workArea || !Number(workArea.width) || !Number(workArea.height)) {
    // 拿不到工作区（screen 未就绪等）：退回原来的默认值，位置交给系统
    return { width: 1440, height: 900, minWidth: 900, minHeight: 600 };
  }
  const area = workArea;
  const areaW = Math.max(640, Math.round(Number(area.width) || 1440));
  const areaH = Math.max(480, Math.round(Number(area.height) || 900));
  const areaX = Math.round(Number(area.x) || 0);
  const areaY = Math.round(Number(area.y) || 0);
  const width = Math.max(320, Math.min(1440, areaW - 40));
  const height = Math.max(240, Math.min(900, areaH - 40));
  return {
    width,
    height,
    minWidth: Math.max(320, Math.min(900, areaW)),
    minHeight: Math.max(240, Math.min(600, areaH)),
    x: Math.round(areaX + Math.max(0, (areaW - width) / 2)),
    y: Math.round(areaY + Math.max(0, (areaH - height) / 2)),
  };
}

// 平台窗口 chrome：标题栏样式 + macOS 原生红绿灯位置。抽成纯函数方便 node 单测。
// mac 的网页标题栏 / 画布顶栏都按 52px 高设计（垂直中心 26px），launcher.py 把灯中心也对齐到 26：
// Electron 的 trafficLightPosition 是按钮到窗口顶/左的 margin，y=20 + 12px 按钮高 ≈ 中心 26；
// x=20 与 TapNow / launcher.py 的灯左缘一致（三灯右缘约 72，标题栏左让 80 / 画布 pill 84 都不会压到）。
// 不设时 Electron 默认灯位更贴边（左缘约 12），Boss 对照 TapNow（左缘约 19.5）指出偏左。Windows/Linux 不传。
function platformWindowChrome(platform) {
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const chrome = {
    // Windows 自绘标题栏走官方路径：titleBarStyle 'hidden' 下 -webkit-app-region: drag 才可靠，
    // 且不画系统标题栏（frame:false 在部分 Windows 环境下 drag 区域会失效）。
    titleBarStyle: isWindows ? 'hidden' : (isMac ? 'hiddenInset' : 'default'),
  };
  if (isMac) chrome.trafficLightPosition = { x: 20, y: 20 };
  return chrome;
}

// Electron 默认菜单（尤其 macOS 的 View）带 Zoom In / Zoom Out / Actual Size 的 role；
// 这些加速键由主进程菜单处理，不一定会触发 webContents 的 zoom-changed，页面缩放会被持久化。
// app ready 后取默认菜单，递归移除这三个 role，其它菜单（Edit / Window / Help 等）原样保留。
function menuTemplateWithoutZoom(menu) {
  const zoomRoles = ['zoomin', 'zoomout', 'resetzoom'];
  if (!menu || !Array.isArray(menu.items)) return [];
  const out = [];
  for (const item of menu.items) {
    if (!item) continue;
    const role = String(item.role || '').toLowerCase();
    if (zoomRoles.includes(role)) continue;
    if (item.submenu) {
      const submenu = menuTemplateWithoutZoom(item.submenu);
      if (submenu.length) out.push({ label: item.label, submenu });
      continue;
    }
    if (item.type === 'separator') { out.push({ type: 'separator' }); continue; }
    const entry = {};
    if (item.label != null) entry.label = item.label;
    if (item.role != null) entry.role = item.role;
    if (item.type != null) entry.type = item.type;
    if (item.accelerator != null) entry.accelerator = item.accelerator;
    if (item.enabled === false) entry.enabled = false;
    if (item.click) entry.click = item.click;
    out.push(entry);
  }
  return out;
}

function installApplicationMenuWithoutZoom() {
  try {
    const current = Menu.getApplicationMenu();
    if (!current) return false;
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplateWithoutZoom(current)));
    clog('menu', '应用菜单已移除 Zoom In/Out/Actual Size（页面缩放固定 100%）');
    return true;
  } catch (err) {
    clog('menu', '移除缩放菜单失败: ' + (err && err.message || err));
    return false;
  }
}

function createWindow(url) {
  appBaseUrl = url;
  clog('win', '创建窗口，加载 ' + url);
  const chrome = platformWindowChrome(process.platform);
  let workArea = null;
  try { workArea = screen.getPrimaryDisplay().workArea; } catch (err) { clog('win', '读取屏幕工作区失败: ' + (err && err.message || err)); }
  const bounds = computeWindowBounds(workArea);
  clog('win', '主窗口尺寸 ' + bounds.width + 'x' + bounds.height + ' @(' + bounds.x + ',' + bounds.y + ') min ' + bounds.minWidth + 'x' + bounds.minHeight + ' workArea=' + JSON.stringify(workArea));
  mainWindow = new BrowserWindow({
    ...bounds,
    title: 'NOVAI — 无限画布',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    ...chrome,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // 画布面板内嵌素材站点需要 <webview>；安全参数由 will-attach-webview 强制。
      webviewTag: true,
    },
  });

  // 应用自己已有「界面缩放」设置（StudioScale 手动档）；Chromium 的页面缩放（Cmd +/-、触控板 pinch）
  // 会持久化到同一台机器，不同人看到 100%/110%/125% 不一，所以这里统一锁回 100%。
  // 注意只管页面缩放，不碰 StudioScale 的 --studio-ui-scale。
  const resetPageZoom = (reason) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.setZoomFactor(1); } catch (err) { clog('zoom', '重置页面缩放倍率失败（' + reason + '）: ' + (err && err.message || err)); }
    try { mainWindow.webContents.setZoomLevel(0); } catch (err) { clog('zoom', '重置页面缩放级别失败（' + reason + '）: ' + (err && err.message || err)); }
  };
  try {
    const limiter = mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    if (limiter && typeof limiter.catch === 'function') limiter.catch(() => {});
  } catch (err) { clog('zoom', '禁用 pinch 缩放失败: ' + (err && err.message || err)); }

  mainWindow.webContents.setUserAgent(
    mainWindow.webContents.getUserAgent().replace('Electron', 'Electron pywebview')
  );
  attachRendererConsole(mainWindow.webContents, 'main');

  mainWindow.loadURL(url).then(() => {
    clog('win', 'loadURL resolved');
    if (isSmokeMode()) runSourceBrowserSmoke();
  }).catch((err) => {
    clog('win', 'loadURL failed: ' + (err && err.message || err));
  });

  // 页面加载完成 / 用户按 Cmd +/- 或 pinch 时都立刻回到 100%，避免 Chromium 把缩放持久化
  mainWindow.webContents.on('did-finish-load', () => {
    resetPageZoom('did-finish-load');
    onMainWindowLoaded();
  });
  mainWindow.webContents.on('zoom-changed', () => resetPageZoom('zoom-changed'));
  // 菜单 role 已移除，但 Cmd/Ctrl +/-/0 的键盘快捷键仍可能绕过 zoom-changed（尤其数字键盘），
  // 这里在按键进页面之前拦掉，并顺手复位，保证页面缩放永远 100%（不影响 StudioScale）。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (!modifier || input.alt) return;
    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '');
    const zoomKeys = ['+', '=', '-', '_', '0'];
    const zoomCodes = ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0', 'NumpadEqual'];
    if (!zoomKeys.includes(key) && !zoomCodes.includes(code)) return;
    event.preventDefault();
    resetPageZoom('before-input-event');
  });

  mainWindow.webContents.once('ready-to-show', () => {
    if (isSmokeMode()) {
      clog('win', '冒烟模式：主窗口不显示');
      closeSplash();
      return;
    }
    clog('win', 'ready-to-show, 界面已就绪');
    revealMainWindow();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    clog('win', 'did-fail-load ' + code + ' ' + desc);
  });

  mainWindow.on('show', () => clog('win', '窗口已显示'));
  mainWindow.on('hide', () => clog('win', '窗口已隐藏'));
  mainWindow.on('blur', stopWindowDrag);
  mainWindow.on('maximize', stopWindowDrag);
  // 窗口尺寸变了就把已挂着的原生视图重新夹回内容区：画布若因为重载/切页没发新 bounds，
  // 也不会留下一个越界（铺满）的视图把面板关闭按钮盖住。
  mainWindow.on('resize', () => {
    try {
      if (!isSourceViewOpen() || !lastSourceViewRect) return;
      const clamped = clampSourceViewRectToWindow(lastSourceViewRect, mainWindowContentSize());
      if (!clamped) return;
      if (clamped.x === lastSourceViewRect.x && clamped.y === lastSourceViewRect.y
        && clamped.width === lastSourceViewRect.width && clamped.height === lastSourceViewRect.height) return;
      applySourceViewBounds(clamped);
    } catch (_) {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target && target.startsWith('http')) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, target) => {
    const allowed = target.startsWith(url.split('/').slice(0, 3).join('/'));
    if (!allowed) { e.preventDefault(); shell.openExternal(target); }
  });

  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    // 关窗 = 收进托盘（进程继续跑）；只有托盘真的不可用时才按普通关闭处理，
    // 否则窗口会「藏到一个不存在的托盘里」，用户既关不掉也打不开。
    if (!ensureTray()) {
      clog('win', '关闭窗口：托盘不可用，按普通关闭处理');
      return;
    }
    e.preventDefault();
    mainWindow.hide();
    clog('win', '已收进托盘（进程保持运行，可从托盘重新打开）');
  });

  mainWindow.on('closed', () => {
    // 主窗口销毁前真正销毁内嵌浏览器视图，避免 WebContents 残留。
    try { destroySourceView(); } catch (_) {}
    mainWindow = null;
  });

  createTray();
  injectIframeShims(mainWindow.webContents);
}

// ---------- 生命周期 ----------
// Windows 用 AppUserModelID 归组任务栏/托盘图标；缺省会落到 electron.exe 的标识上，图标与通知都错。
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.novai.desktop'); } catch (_) {}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  clog('lock', '已有实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户又双击了一次图标：隐藏的窗口要 show/focus，已被销毁的要重建。
    clog('lock', '收到第二次启动请求，唤起已有实例');
    if (!showMainWindow()) clog('lock', '第二次启动时还没有可用窗口（应用可能仍在启动中）');
  });

  app.whenReady().then(async () => {
    dataDir = resolveDataDir();
    // 启动自检：升级后首启标记 applied、累加 bootAttempts、判断要不要回滚；新版起不来时先回滚再继续。
    const boot = beginUpdateBoot();
    if (boot && boot.rollback) await performUpdateRollback();
    createSplashWindow(boot);
    // 默认菜单里的 Zoom role 先移除：即使上次会话把页面缩放到 125%，新版本启动时
    // did-finish-load 会复位到 100%，在线素材 native 视图 / API 弹窗按设计尺寸显示。
    installApplicationMenuWithoutZoom();
    installWebviewSecurityPolicy();
    registerIpc();
    // 托盘不依赖窗口与后端：先建好，窗口创建失败/被关闭时用户仍能打开或退出应用。
    createTray();

    const requested = Number(process.env.NOVAI_PORT) || DEFAULT_PORT;
    // 云端模式：NOVAI_URL 或 <userData>/novai-cloud.json 指向合法 http(s) 地址时，
    // 桌面端只做窗口壳，不再拉起/探测本地后端（NOVAI_LOCAL_BACKEND=1 可强制回本地）。
    // 两个都查：NOVAI 数据目录（用户能点「打开数据目录」看到）优先，其次 Electron 的 userData。
    const configDirs = [dataDir];
    try {
      const electronDataDir = app.getPath('userData');
      if (electronDataDir && electronDataDir !== dataDir) configDirs.push(electronDataDir);
    } catch (_) {}
    const target = resolveBaseUrl({
      env: process.env,
      userDataDirs: configDirs,
      localUrl: `http://127.0.0.1:${requested}`,
    });
    if (target.source !== 'local') {
      clog('boot', '使用云端地址(' + target.source + '): ' + target.baseUrl + '，跳过本地后端');
      setSplashStage('准备界面', 60);
      createWindow(target.baseUrl);
      setupAutoUpdate();
      setSplashStage('检查更新', 85);
      app.on('activate', () => { showMainWindow(); });
      return;
    }

    // 先收拾上一次运行留下的、属于自己的后端，避免这一轮「复用」一个没人管的残留进程。
    await cleanupStaleBackend();

    // 端口 3000 上若已有 NOVAI 后端（正式版/网页版正在运行）则直接复用——
    // 数据目录相同，再起一个后端写同一数据目录会互相踩踏。
    let port = requested;
    let reuseExisting = false;
    if (await isPortInUse(requested)) {
      reuseExisting = await looksLikeNovaiBackend(requested);
      if (!reuseExisting) port = await resolvePort(requested);
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      clog('boot', '数据目录: ' + dataDir);
      if (reuseExisting) {
        backendPort = port;
        clog('boot', '端口 ' + port + ' 已有 NOVAI 后端运行，直接复用（不重复启动）');
        setSplashStage('准备界面', 60);
        createWindow(baseUrl);
        setupAutoUpdate();
        setSplashStage('检查更新', 85);
      } else {
        clog('boot', '开始启动后端, 端口 ' + port);
        setSplashStage('正在预热', 30);
        await startBackend(port);
        clog('boot', '后端进程已启动');
        setSplashStage('正在预热', 45);
        await waitForServer(baseUrl + '/');
        clog('boot', '后端服务就绪: ' + baseUrl);
        setSplashStage('准备界面', 60);
        createWindow(baseUrl);
        setupAutoUpdate();
        setSplashStage('检查更新', 85);
      }
    } catch (err) {
      clog('boot', '启动失败: ' + err.message);
      clog('boot', '后端日志: ' + backendLog.join(' | '));
      console.error('启动失败:', err.message, String.fromCharCode(10) + '后端日志:' + String.fromCharCode(10) + backendLog.join(String.fromCharCode(10)));
      const _bundled = !!resolveBackendBinary();
      const _hint = _bundled
        ? ("这是安装包内置的后端，不需要安装 Python。完整日志：" + (logFile || "见 %APPDATA%\\novai-electron.log"))
        : "请确认已安装 Python 3.10+ 并已安装依赖。";
      const _tail = backendLog.slice(-12).join(String.fromCharCode(10));
      dialog.showErrorBox("NOVAI 启动失败",
        "无法启动后端服务：" + String.fromCharCode(10) + String.fromCharCode(10) + err.message +
        String.fromCharCode(10) + String.fromCharCode(10) + _hint +
        (_tail ? String.fromCharCode(10) + String.fromCharCode(10) + "--- 后端日志（末尾） ---" + String.fromCharCode(10) + _tail : ""));
      app.quit();
      return;
    }

    app.on('activate', () => { showMainWindow(); });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    closeSplash();
    // 退出前收敛更新状态：已经下好的包装在退出时静默装掉，mac 先起替换脚本。
    // 用 try 包住：这里任何一个动作抛错都会中断整个退出钩子，后端就没人杀了。
    try { convergeUpdateOnQuit(); } catch (err) {
      clog('lifecycle', '退出时收敛更新状态失败: ' + ((err && err.message) || err));
    }
    try { destroySourceView(); } catch (err) {
      clog('lifecycle', '退出时销毁内嵌视图失败: ' + ((err && err.message) || err));
    }
    const stopped = shutdownBackend();
    clog('lifecycle', stopped ? '退出：后端进程树已结束' : '退出：没有本进程管理的后端（复用的外部后端保持运行）');
  });

  // 兜底：before-quit 之后如果还有窗口没关（异步 destroy 卡住），Electron 仍会走 will-quit。
  // 这里再确认一次后端已经死透，避免「托盘退出后还挂着 NOVAI.exe」。
  app.on('will-quit', () => {
    isQuitting = true;
    if (backendProc && !backendProc.killed && !backendStopped) {
      clog('lifecycle', 'will-quit：后端仍在，再结束一次 PID ' + backendProc.pid);
      shutdownBackend();
    }
  });
  app.on('window-all-closed', () => {
    // macOS 本来就常驻；Windows/Linux 只要托盘还在就保持进程，用户能从托盘再次打开。
    if (process.platform === 'darwin') return;
    if (tray) {
      clog('lifecycle', '窗口已全部关闭，托盘可用：保持进程运行');
      return;
    }
    clog('lifecycle', '窗口已全部关闭且托盘不可用：退出进程');
    app.quit();
  });
}
