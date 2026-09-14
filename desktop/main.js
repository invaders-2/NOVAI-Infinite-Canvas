// NOVAI Desktop — Electron 主进程
// 职责：
//  1. 拉起 FastAPI 后端（python main.py 或 bundled 二进制）并等待端口就绪
//  2. 创建窗口加载本地页面（无边框 + 系统托盘，对齐现有 pywebview 桌面版体验）
//  3. 通过 IPC 提供 pywebview 兼容桥（原生对话框/窗口控制/数据目录/自启/主题）
//  4. 退出时确保结束后端进程，避免残留占用端口
//  5. iframe 子页面注入迷你桥（postMessage 转发），前端零改动获得完整桌面能力

const { app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// 后端端口：与正式版一致使用 3000（数据目录也相同，Electron 版就是正式版的桌面壳）。
// 若 3000 上已有 NOVAI 后端在跑（正式版/网页版），直接复用而不重复启动；
// 若被无关程序占用，resolvePort 自动顺延到 3001+。
const DEFAULT_PORT = 3000;
let backendProc = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let backendLog = [];
let dataDir = '';

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

// 数据目录：与正式版 launcher.py 完全一致（Windows = APPDATA/NOVAI，macOS/Linux = ~/NOVAI），
// 确保 Electron 版与正式版共享同一份用户数据（画布/配置/对话）——
// 用户从正式版换到 Electron 版无需迁移、无需重新下载任何数据。
// 独立于 .app 包内部（可写、非只读、升级不丢）。
function resolveDataDir() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'data');
  const dir = path.join(process.env.APPDATA || require('os').homedir(), 'NOVAI');
  // 兼容早期 Electron 测试版（数据曾写到系统 appData/NOVAI，macOS 上与正式版不一致）：
  // 正式目录不存在而旧目录存在时整体搬迁，避免老测试用户数据"消失"。
  try {
    const legacy = path.join(app.getPath('appData'), 'NOVAI');
    if (legacy !== dir && !fs.existsSync(dir) && fs.existsSync(legacy)) {
      fs.renameSync(legacy, dir);
      clog('boot', '已迁移旧版 Electron 数据目录: ' + legacy + ' -> ' + dir);
    }
  } catch (_) {}
  return dir;
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
function waitForServer(url, timeoutMs = 60000, intervalMs = 400) {
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

// ---------- 启动后端 ----------
function startBackend(port) {
  return new Promise(async (resolve, reject) => {
    const mainPy = resolveMainPy();
    const binary = resolveBackendBinary();

    // 后端环境：数据/输出/素材写入用户数据目录（可写、独立于 .app、升级不丢）；
    // 资源目录（static/workflows）按 NOVAI_APP_DIR 定位（打包后为 app 内 backend 目录）。
    const backendEnv = Object.assign({}, process.env, {
      NOVAI_DATA_DIR: resolveDataDir(),
      NOVAI_APP_DIR: app.isPackaged
        ? path.dirname(mainPy || binary || '')
        : path.dirname(mainPy || ''),
    });
    // Win 安装根目录传给后端：素材默认跟随安装目录（用户安装时选的大容量盘）。
    // 仅 win32 设置——mac 的 .app 包内只读、linux AppImage 挂载只读，
    // 后端写探测失败会自动回落到数据目录（~/NOVAI 或 APPDATA/NOVAI）。
    if (app.isPackaged && process.platform === 'win32') {
      backendEnv.NOVAI_INSTALL_DIR = path.dirname(process.execPath);
    }
    if (app.isPackaged) {
      try { fs.mkdirSync(backendEnv.NOVAI_DATA_DIR, { recursive: true }); } catch (_) {}
    }

    if (binary) {
      const cwd = path.dirname(binary);
      backendProc = spawn(binary, ['--port', String(port)], { cwd, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      backendProc.stdout.on('data', logBackend);
      backendProc.stderr.on('data', logBackend);
      backendProc.on('exit', (code) => {
        if (app.isPackaged && code !== 0) {
          dialog.showErrorBox('NOVAI 后端异常退出', '后端进程已退出，请查看日志。');
        }
      });
      clog('boot', '启动 bundled 后端: ' + binary + ' port ' + port + ' dataDir ' + backendEnv.NOVAI_DATA_DIR);
      return resolve(backendProc);
    }

    if (!mainPy) {
      return reject(new Error('未找到后端入口 main.py，且没有 bundled 后端二进制。'));
    }

    const cwd = path.dirname(mainPy);
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const args = [mainPy, String(port)];
    backendProc = spawn(pythonCmd, args, { cwd, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    backendProc.stdout.on('data', logBackend);
    backendProc.stderr.on('data', logBackend);
    backendProc.on('exit', (code) => {
      clog('boot', '后端进程退出，code = ' + code);
      if (app.isPackaged && code !== 0) {
        dialog.showErrorBox('NOVAI 后端异常退出', 'Python 后端未能启动，请确认已安装 Python 3.10+ 及依赖。');
      }
    });
    clog('boot', '启动 Python 后端: ' + pythonCmd + ' ' + mainPy + ' port ' + port + ' cwd ' + cwd + ' dataDir ' + backendEnv.NOVAI_DATA_DIR);
    resolve(backendProc);
  });
}

// ---------- 清理 ----------
function shutdownBackend() {
  if (backendProc && !backendProc.killed) {
    try { backendProc.kill(); } catch (_) {}
  }
}

// ---------- 托盘 ----------
function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'icons', 'icon.png');
    tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, 'icons', 'icon.png'));
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
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
  } catch (err) {
    clog('tray', '托盘创建失败: ' + err.message);
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
      open_data_dir: function(){ return call('open-data-dir'); },
      get_data_dir: function(){ return call('get-data-dir'); },
      set_auto_start: function(v){ return call('set-auto-start', {value: v}); },
      get_app_info: function(){ return call('get-app-info'); },
    }
  };
  try { window.dispatchEvent(new Event('pywebviewready')); } catch(_) {}
})();`;

function injectIframeShims(webContents) {
  const frameHandler = async (event, details) => {
    const frame = details.frame;
    if (!frame || frame === webContents.mainFrame) return;
    try {
      const url = frame.url || '';
      if (!(url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost'))) return;
      await frame.executeJavaScript(IFRAME_SHIM, true);
    } catch (err) {
      // 注入失败静默
    }
  };
  webContents.on('frame-created', frameHandler);
}

// ---------- IPC：pywebview 兼容桥 ----------
function registerIpc() {
  ipcMain.handle('novai:window', async (e, { action }) => {
    if (!mainWindow) return null;
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'maximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        break;
      case 'close':
        mainWindow.hide();
        break;
      case 'quit': isQuitting = true; app.quit(); break;
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
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { ok: true, saved: false };
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
      if (!m) return { ok: true, saved: false };
      fs.writeFileSync(result.filePath, Buffer.from(m[2], 'base64'));
      return { ok: true, saved: true, path: result.filePath };
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
}

// ---------- 自动更新 ----------
let autoUpdater = null;
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = autoUpdater || require('electron-updater').autoUpdater;
    if (!autoUpdater) return;
  } catch (_) { return; }
  autoUpdater.autoDownload = false;
  // 测试版（版本号含 -，如 1.0.112-beta.1）允许接收 prerelease 更新；正式版只看正式 Release。
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  // 国内用户访问 GitHub Releases 常被阻断：检查失败时自动切换到
  // ModelScope 国内镜像（generic provider，构建流水线会把安装包同步到
  // studio/bllack/NOVAI 的 electron-release/ 目录）。
  const MIRROR_UPDATE_URL = 'https://modelscope.cn/studios/bllack/NOVAI/resolve/master/electron-release';
  let switchedToMirror = false;
  autoUpdater.on('update-available', (info) => {
    const current = app.getVersion();
    const next = info && info.version;
    if (!next || next === current) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `NOVAI 有新版本可用：v${next}（当前 v${current}）`,
      detail: '是否现在下载并安装？下载完成后需重启应用。',
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    }).catch(() => {});
  });
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已就绪',
      message: '新版本已下载完成，是否立即重启安装？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    }).catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    clog('updater', '检查更新失败: ' + (err && err.message || err));
    // GitHub 不通时切换到国内镜像重试一次（仅切换一次，避免死循环）
    if (!switchedToMirror) {
      switchedToMirror = true;
      try {
        autoUpdater.setFeedURL({ provider: 'generic', url: MIRROR_UPDATE_URL });
        clog('updater', '已切换到国内镜像更新源: ' + MIRROR_UPDATE_URL);
        autoUpdater.checkForUpdates();
        return;
      } catch (e) {
        clog('updater', '镜像更新源切换失败: ' + (e && e.message || e));
      }
    }
    // 镜像也失败，或 macOS 未签名构建无法自动安装（Squirrel 要求签名）→
    // 引导手动下载覆盖安装，数据目录独立不受影响。
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '自动更新不可用',
      message: '新版本已发布，但自动更新未能完成',
      detail: '可能是网络无法连接更新服务器，或 macOS 未签名构建不支持自动安装。可前往发布页手动下载最新安装包覆盖安装，数据不会丢失。',
      buttons: ['前往下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) shell.openExternal('https://gitee.com/invaders/novai/releases');
    }).catch(() => {});
  });
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 8000);
}

// ---------- 窗口 ----------
function createWindow(url) {
  clog('win', '创建窗口，加载 ' + url);
  const useFrameless = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'NOVAI — 无限画布',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    frame: !useFrameless,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 15, y: 18 } : undefined,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setUserAgent(
    mainWindow.webContents.getUserAgent().replace('Electron', 'Electron pywebview')
  );

  mainWindow.loadURL(url).then(() => {
    clog('win', 'loadURL resolved');
  }).catch((err) => {
    clog('win', 'loadURL failed: ' + (err && err.message || err));
  });

  mainWindow.webContents.once('ready-to-show', () => {
    clog('win', 'ready-to-show, 显示窗口');
    try { mainWindow.show(); } catch (err) { clog('win', 'show error: ' + err.message); }
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    clog('win', 'did-fail-load ' + code + ' ' + desc);
  });

  mainWindow.on('show', () => clog('win', '窗口已显示'));
  mainWindow.on('hide', () => clog('win', '窗口已隐藏'));

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target && target.startsWith('http')) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, target) => {
    const allowed = target.startsWith(url.split('/').slice(0, 3).join('/'));
    if (!allowed) { e.preventDefault(); shell.openExternal(target); }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  createTray();
  injectIframeShims(mainWindow.webContents);
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  clog('lock', '已有实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { showMainWindow(); }
  });

  app.whenReady().then(async () => {
    dataDir = resolveDataDir();
    registerIpc();

    const requested = Number(process.env.NOVAI_PORT) || DEFAULT_PORT;
    // 端口 3000 上若已有 NOVAI 后端（正式版/网页版正在运行）则直接复用——
    // 数据目录相同，再起一个后端写同一数据目录会互相踩踏。
    let port = requested;
    let reuseExisting = false;
    if (await isPortInUse(requested)) {
      reuseExisting = await looksLikeNovaiBackend(requested);
      if (!reuseExisting) port = await resolvePort(requested);
    }
    const baseUrl = process.env.NOVAI_URL || `http://127.0.0.1:${port}`;

    try {
      clog('boot', '数据目录: ' + dataDir);
      if (reuseExisting) {
        clog('boot', '端口 ' + port + ' 已有 NOVAI 后端运行，直接复用（不重复启动）');
        createWindow(baseUrl);
        setupAutoUpdate();
      } else {
        clog('boot', '开始启动后端, 端口 ' + port);
        await startBackend(port);
        clog('boot', '后端进程已启动');
        await waitForServer(baseUrl + '/');
        clog('boot', '后端服务就绪: ' + baseUrl);
        createWindow(baseUrl);
        setupAutoUpdate();
      }
    } catch (err) {
      clog('boot', '启动失败: ' + err.message);
      clog('boot', '后端日志: ' + backendLog.join(' | '));
      console.error('启动失败:', err.message, String.fromCharCode(10) + '后端日志:' + String.fromCharCode(10) + backendLog.join(String.fromCharCode(10)));
      dialog.showErrorBox('NOVAI 启动失败', '无法启动后端服务：' + String.fromCharCode(10) + String.fromCharCode(10) + err.message + String.fromCharCode(10) + String.fromCharCode(10) + '请确认环境已安装 Python 3.10+ 并已安装依赖。');
      app.quit();
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(baseUrl);
    });
  });

  app.on('before-quit', () => { isQuitting = true; shutdownBackend(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
