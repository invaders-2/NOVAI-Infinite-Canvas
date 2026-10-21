// NOVAI Desktop — Electron 主进程
// 职责：
//  1. 拉起 FastAPI 后端（python main.py 或 bundled 二进制）并等待端口就绪
//  2. 创建窗口加载本地页面（无边框 + 系统托盘，对齐现有 pywebview 桌面版体验）
//  3. 通过 IPC 提供 pywebview 兼容桥（原生对话框/窗口控制/数据目录/自启/主题）
//  4. 退出时确保结束后端进程，避免残留占用端口
//  5. iframe 子页面注入迷你桥（postMessage 转发），前端零改动获得完整桌面能力

const { app, BrowserWindow, WebContentsView, session, shell, dialog, ipcMain, Tray, Menu, screen } = require('electron');
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
// 主动停后端（更新重启/正常退出）期间不把退出当崩溃报错；每次 startBackend 都会复位。
let backendStopExpected = false;
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

// ---------- 启动后端 ----------
function startBackend(port) {
  return new Promise(async (resolve, reject) => {
    backendStopExpected = false;
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
    });
    // Win 安装根目录传给后端：素材默认跟随安装目录（用户安装时选的大容量盘）。
    // 仅 win32 设置——mac 的 .app 包内只读、linux AppImage 挂载只读，
    // 后端写探测失败会自动回落到数据目录（~/NOVAI 或 APPDATA/NOVAI）。
    if (app.isPackaged && process.platform === 'win32') {
      backendEnv.NOVAI_INSTALL_DIR = path.dirname(process.execPath);
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
    backendProc.on('exit', (code, signal) => {
      clog('boot', '后端进程退出，code = ' + code + ', signal = ' + signal);
      if (backendStopExpected || isQuitting) return;
      if (app.isPackaged && code !== 0 && code !== null) {
        dialog.showErrorBox('NOVAI 后端异常退出', 'Python 后端未能启动，请确认已安装 Python 3.10+ 及依赖。');
      }
    });
    clog('boot', '启动 Python 后端: ' + pythonCmd + ' ' + mainPy + ' port ' + port + ' cwd ' + cwd + ' dataDir ' + backendEnv.NOVAI_DATA_DIR);
    resolve(backendProc);
  });
}

// ---------- 清理 ----------
function shutdownBackend() {
  backendStopExpected = true;
  if (backendProc && !backendProc.killed) {
    try { backendProc.kill(); } catch (_) {}
  }
}

// 安装新版前必须先让后端彻底退出，否则 Windows 安装程序覆盖 NOVAI.exe 会被占用中的文件挡住。
function stopBackendForUpdate(timeoutMs) {
  const limit = timeoutMs || 15000;
  return new Promise((resolve) => {
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
  '#novai-source-controls .novai-controls-group, #novai-source-controls .novai-controls-site-wrap { display: flex !important; align-items: center !important; gap: 4px !important; position: static !important; transform: none !important; pointer-events: none !important; }',
  '#novai-source-controls .novai-controls-site-wrap { flex: 0 1 auto !important; min-width: 0 !important; }',
  '#novai-source-controls[data-visible="true"] .novai-controls-bottom { pointer-events: auto !important; }',
  '#novai-source-controls[data-visible="true"] .novai-controls-group, #novai-source-controls[data-visible="true"] .novai-controls-site-wrap { pointer-events: auto !important; }',
  '#novai-source-controls[data-visible="false"] .novai-controls-btn, #novai-source-controls[data-visible="false"] .novai-site-item { pointer-events: none !important; }',
  '#novai-source-controls .novai-controls-btn { appearance: none !important; -webkit-appearance: none !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; width: 27px !important; height: 27px !important; padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 999px !important; background: rgba(20, 20, 20, 0.72) !important; color: #ffffff !important; backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important; cursor: pointer !important; pointer-events: auto !important; font-size: 13px !important; line-height: 1 !important; transition: background .16s ease, transform .16s ease, opacity .16s ease !important; }',
  '#novai-source-controls .novai-controls-btn:hover { background: linear-gradient(rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.14)), rgba(20, 20, 20, 0.72) !important; transform: scale(1.04) !important; }',
  '#novai-source-controls .novai-controls-btn:disabled { opacity: 0.45 !important; cursor: default !important; }',
  '#novai-source-controls svg { width: 14px !important; height: 14px !important; display: block !important; }',
  '#novai-source-controls .novai-zoom-cluster { display: inline-flex !important; align-items: center !important; gap: 0 !important; border-radius: 999px !important; background: rgba(20, 20, 20, 0.72) !important; backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important; overflow: hidden !important; }',
  '#novai-source-controls .novai-zoom-cluster .novai-controls-btn { width: 26px !important; height: 26px !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }',
  '#novai-source-controls .novai-zoom-cluster .novai-controls-btn:hover { background: rgba(255, 255, 255, 0.14) !important; }',
  '#novai-source-controls .novai-zoom-cluster .novai-zoom-value-btn { width: auto !important; min-width: 42px !important; padding: 0 4px !important; font-size: 11px !important; font-weight: 600 !important; letter-spacing: 0.2px !important; }',
  '#novai-source-controls .novai-zoom-value { color: #ffffff !important; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; font-variant-numeric: tabular-nums !important; }',
  '#novai-source-controls .novai-controls-site { display: inline-flex !important; align-items: center !important; gap: 2px !important; padding: 3px !important; border-radius: 999px !important; background: rgba(20, 20, 20, 0.72) !important; backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important; }',
  '#novai-source-controls .novai-site-item { appearance: none !important; -webkit-appearance: none !important; border: 0 !important; display: inline-flex !important; align-items: center !important; gap: 4px !important; height: 26px !important; padding: 0 7px !important; border-radius: 999px !important; background: transparent !important; color: rgba(255, 255, 255, 0.72) !important; cursor: pointer !important; font-size: 12px !important; line-height: 1 !important; white-space: nowrap !important; }',
  '#novai-source-controls .novai-site-item:hover { color: #ffffff !important; background: rgba(255, 255, 255, 0.10) !important; }',
  '#novai-source-controls .novai-site-item[data-active="true"], #novai-source-controls .novai-site-item.novai-site-active { background: rgba(255, 255, 255, 0.92) !important; color: #111111 !important; font-weight: 600 !important; }',
  '#novai-source-controls .novai-site-icon { display: inline-flex !important; width: 14px !important; height: 14px !important; }',
  '#novai-source-controls .novai-site-icon svg { width: 14px !important; height: 14px !important; }',
  '#novai-source-controls .novai-site-label { font-size: 12px !important; font-weight: inherit !important; white-space: nowrap !important; }',
  '#novai-source-controls .novai-controls-url { position: fixed !important; left: 50% !important; bottom: 62px !important; transform: translateX(-50%) scale(var(--novai-ui-compensate)) !important; transform-origin: center bottom !important; display: none !important; flex-direction: column !important; gap: 4px !important; width: 300px !important; max-width: calc(100vw - 24px) !important; padding: 6px 8px !important; border-radius: 12px !important; background: rgba(20, 20, 20, 0.72) !important; backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important; pointer-events: auto !important; }',
  '#novai-source-controls .novai-controls-url[data-open="true"] { display: flex !important; }',
  '#novai-source-controls .novai-url-line { display: flex !important; align-items: center !important; gap: 6px !important; width: 100% !important; }',
  '#novai-source-controls .novai-url-input { flex: 1 1 auto !important; min-width: 0 !important; height: 24px !important; border: 0 !important; border-radius: 8px !important; padding: 0 8px !important; font-size: 13px !important; background: rgba(255, 255, 255, 0.12) !important; color: #ffffff !important; outline: none !important; }',
  '#novai-source-controls .novai-url-input::placeholder { color: rgba(255, 255, 255, 0.45) !important; }',
  '#novai-source-controls .novai-url-btn { height: 24px !important; padding: 0 8px !important; border: 0 !important; border-radius: 8px !important; background: rgba(255, 255, 255, 0.16) !important; color: #ffffff !important; font-size: 12px !important; cursor: pointer !important; }',
  '#novai-source-controls .novai-url-error { display: none !important; color: #ff6b6b !important; font-size: 11px !important; line-height: 1.2 !important; }',
  '#novai-source-controls .novai-url-error[data-show="true"] { display: block !important; }',
  '#novai-source-controls[data-theme="light"] .novai-controls-url { background: rgba(250, 250, 250, 0.88) !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-url-input { background: rgba(0, 0, 0, 0.06) !important; color: #111111 !important; }',
  '#novai-source-controls[data-theme="light"] .novai-url-input::placeholder { color: rgba(17, 17, 17, 0.45) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-url-btn { background: rgba(0, 0, 0, 0.10) !important; color: #111111 !important; }',
  '#novai-source-controls[data-theme="light"] .novai-url-error { color: #d93025 !important; }',
  '@media (max-width: 560px) { #novai-source-controls .novai-site-icon { display: none !important; } #novai-source-controls .novai-site-item { padding: 0 6px !important; font-size: 11px !important; } #novai-source-controls .novai-controls-bottom { gap: 4px !important; padding: 0 8px !important; } }',
  '#novai-source-controls[data-theme="light"] .novai-controls-btn, #novai-source-controls[data-theme="light"] .novai-zoom-cluster, #novai-source-controls[data-theme="light"] .novai-controls-site { background: rgba(250, 250, 250, 0.88) !important; color: #111111 !important; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-controls-btn:hover { background: linear-gradient(rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.06)), rgba(250, 250, 250, 0.88) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-zoom-cluster .novai-controls-btn { background: transparent !important; }',
  '#novai-source-controls[data-theme="light"] .novai-zoom-cluster .novai-controls-btn:hover { background: rgba(0, 0, 0, 0.06) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-zoom-value { color: #111111 !important; }',
  '#novai-source-controls[data-theme="light"] .novai-site-item { color: rgba(17, 17, 17, 0.62) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-site-item:hover { color: #111111 !important; background: rgba(0, 0, 0, 0.06) !important; }',
  '#novai-source-controls[data-theme="light"] .novai-site-item[data-active="true"], #novai-source-controls[data-theme="light"] .novai-site-item.novai-site-active { background: rgba(17, 17, 17, 0.88) !important; color: #ffffff !important; }',
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

function sourceViewState() {
  const open = isSourceViewVisible();
  let url = '';
  try { if (open && sourceView) url = String(sourceView.webContents.getURL() || ''); } catch (_) {}
  const zoomFactor = isSourceViewAlive() ? currentSourceZoom() : 1;
  const history = sourceHistoryState();
  return {
    ok: true,
    open: open,
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

function applySourceViewBounds(rect) {
  if (!isSourceViewOpen()) return false;
  const bounds = normalizeSourceViewRect(rect);
  if (!bounds) return false;
  // 控件已移到画布页：rect 由画布侧算好（工具栏下方），这里按传入值原样 setBounds
  const layoutBounds = bounds;
  try {
    sourceView.setBounds(layoutBounds);
    lastSourceViewRect = bounds;
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
  // 保活：面板重新打开时把同一个 view 挂回窗口，不重建、不重新登录
  if (!sourceViewAttached) {
    try {
      mainWindow.contentView.addChildView(view);
      sourceViewAttached = true;
    } catch (err) {
      const msg = String(err && err.message || err);
      clog('source-view', '挂载失败: ' + msg);
      destroySourceView();
      return { ok: false, open: false, source: null, error: msg };
    }
  }
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
  sendSourceTheme();
  sendSourceUiState();
  return { ok: true, open: true, source: sourceViewSource, url: url, bounds: lastSourceViewRect };
}

// 关闭面板：只隐藏 view，不销毁 webContents —— 页面状态和登录态都保留
function hideSourceView() {
  if (!isSourceViewAlive()) {
    sourceViewVisible = false;
    sourceViewAttached = false;
    return;
  }
  if (sourceViewAttached) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(sourceView);
    } catch (_) {}
    sourceViewAttached = false;
  }
  sourceViewVisible = false;
  // 关闭面板时把缩放复位到默认 75%（下次打开强制默认）
  if (sourceBoundsReapplyTimer) { clearTimeout(sourceBoundsReapplyTimer); sourceBoundsReapplyTimer = null; }
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
          try {
            sourceView.setBounds(retryRect);
            lastSourceViewRect = retryRect;
          } catch (_) {}
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
        return fetch(url, { credentials: 'include' }).then(function(r){
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
        }).catch(function(e){ return { ok: false, error: String(e && e.message || e) }; });
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
      return JSON.stringify(uiResult) + '\\n' + JSON.stringify(frameResult);
    } catch (err) {
      return JSON.stringify({ error: String(err && err.message || err) });
    }
  })()`;
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
  try {
    const uiResult = String((await runSourceBrowserUiCheck()) || '');
    // 探针返回三行 JSON：主窗口面板 / 真实 iframe 路径 / webview 可行性
    const parts = uiResult.split('\n');
    smokeUi = parts[0] || '';
    smokeUiFrame = parts[1] || JSON.stringify({ error: 'iframe 探针未返回结果' });
    smokeWebview = parts[2] || JSON.stringify({ error: 'webview 探针未返回结果' });
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
  const ok = !!(openResult && openResult.ok && state.open);
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
        mainWindow.hide();
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
  let updateStage = 'checking';
  // 测试版（版本号含 -，如 1.0.112-beta.1）允许接收 prerelease 更新；正式版只看正式 Release。
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  // 国内用户访问 GitHub Releases 常被阻断：检查失败时自动切换到该
  // generic 更新地址，产物由 CI 同步到 bllack/NOVAI-releases 模型仓库的
  // electron-release/ 目录。
  const MIRROR_UPDATE_URL = 'https://modelscope.cn/models/bllack/NOVAI-releases/resolve/master/electron-release';
  let switchedToMirror = false;
  autoUpdater.on('update-available', (info) => {
    updateStage = 'available';
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
  autoUpdater.on('download-progress', () => { updateStage = 'downloading'; });
  autoUpdater.on('update-downloaded', () => {
    updateStage = 'downloaded';
    if (process.platform === 'darwin') {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '更新已就绪',
        message: '新版本已下载完成，但 macOS 未签名构建不支持自动安装，请手动下载安装包覆盖安装（数据不会丢失）。',
        buttons: ['打开发布页', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) shell.openExternal('https://gitee.com/invaders/novai/releases');
      }).catch(() => {});
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已就绪',
      message: '新版本已下载完成，是否立即重启安装？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        stopBackendForUpdate().then(() => autoUpdater.quitAndInstall());
      }
    }).catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    const stageLabel = { checking: '检查更新', available: '检查更新', downloading: '下载更新包', downloaded: '安装更新' }[updateStage] || '检查更新';
    clog('updater', '[' + stageLabel + '] 更新失败: ' + (err && err.message || err));
    // GitHub 不通时切换到国内镜像重试一次（仅切换一次，避免死循环）；安装阶段重试下载没有意义
    if (!switchedToMirror && updateStage !== 'downloaded') {
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
    const rawError = String(err && err.message || err);
    if (updateStage === 'downloaded') {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '自动更新未能安装',
        message: '新版安装包已下载完成，但安装阶段失败',
        detail: '原始错误：' + rawError + '\n可尝试以管理员身份运行 NOVAI 后重试自动更新，或到发布页手动下载安装包覆盖安装（用户数据不会丢失）。',
        buttons: ['前往下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) shell.openExternal('https://gitee.com/invaders/novai/releases');
      }).catch(() => {});
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '自动更新不可用',
      message: '新版本已发布，但自动更新未能完成',
      detail: '可能是网络无法连接更新服务器，或 macOS 未签名构建不支持自动安装。可前往发布页手动下载最新安装包覆盖安装，数据不会丢失。\n原始错误：' + rawError,
      buttons: ['前往下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) shell.openExternal('https://gitee.com/invaders/novai/releases');
    }).catch(() => {});
  });
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 8000);
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
function createWindow(url) {
  clog('win', '创建窗口，加载 ' + url);
  const isWindows = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'NOVAI — 无限画布',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    // Windows 自绘标题栏走官方路径：titleBarStyle 'hidden' 下 -webkit-app-region: drag 才可靠，
    // 且不画系统标题栏（frame:false 在部分 Windows 环境下 drag 区域会失效）。
    titleBarStyle: isWindows ? 'hidden' : (process.platform === 'darwin' ? 'hiddenInset' : 'default'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // 画布面板内嵌素材站点需要 <webview>；安全参数由 will-attach-webview 强制。
      webviewTag: true,
    },
  });

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

  mainWindow.webContents.once('ready-to-show', () => {
    if (isSmokeMode()) {
      clog('win', '冒烟模式：主窗口不显示');
      return;
    }
    clog('win', 'ready-to-show, 显示窗口');
    try { mainWindow.show(); } catch (err) { clog('win', 'show error: ' + err.message); }
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    clog('win', 'did-fail-load ' + code + ' ' + desc);
  });

  mainWindow.on('show', () => clog('win', '窗口已显示'));
  mainWindow.on('hide', () => clog('win', '窗口已隐藏'));
  mainWindow.on('blur', stopWindowDrag);
  mainWindow.on('maximize', stopWindowDrag);

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

  mainWindow.on('closed', () => {
    // 主窗口销毁前真正销毁内嵌浏览器视图，避免 WebContents 残留。
    try { destroySourceView(); } catch (_) {}
    mainWindow = null;
  });

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
    installWebviewSecurityPolicy();
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(baseUrl);
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    destroySourceView();
    shutdownBackend();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
