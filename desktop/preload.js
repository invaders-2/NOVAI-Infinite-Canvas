// NOVAI Desktop — preload 脚本（contextIsolation）
// 职责：
//  1) 暴露 window.pywebview.api —— 兼容前端现有 pywebview 桥接约定（零前端改动）
//  2) 暴露 window.__novaiBridge 低层桥（供 iframe 注入脚本转发用）
//  3) 在主 frame 触发 pywebviewready 事件
const { contextBridge, ipcRenderer } = require('electron');

// ---------- pywebview 兼容 API ----------
// 与 launcher.py 暴露给前端的 js_api 方法名对齐
const api = {
  // 窗口控制
  minimize: () => ipcRenderer.invoke('novai:window', { action: 'minimize' }),
  maximize: () => ipcRenderer.invoke('novai:window', { action: 'maximize' }),
  close: () => ipcRenderer.invoke('novai:window', { action: 'close' }),
  quit_app: () => ipcRenderer.invoke('novai:window', { action: 'quit' }),
  start_window_drag: () => ipcRenderer.invoke('novai:window', { action: 'start-drag' }),
  end_window_drag: () => ipcRenderer.invoke('novai:window', { action: 'end-drag' }),
  begin_frameless_resize: (dir) => ipcRenderer.invoke('novai:window', { action: 'begin-resize', dir }),
  update_frameless_resize: (dx, dy) => ipcRenderer.invoke('novai:window', { action: 'update-resize', dx, dy }),
  end_frameless_resize: () => ipcRenderer.invoke('novai:window', { action: 'end-resize' }),

  // 对话框
  save_file: (dataUrl, filename) => ipcRenderer.invoke('novai:save-file', { dataUrl, filename }),
  select_directory: () => ipcRenderer.invoke('novai:select-directory'),

  // 数据目录 / 系统
  get_data_dir: () => ipcRenderer.invoke('novai:get-data-dir'),
  open_data_dir: () => ipcRenderer.invoke('novai:open-data-dir'),
  set_auto_start: (value) => ipcRenderer.invoke('novai:set-auto-start', { value }),

  // 素材源内嵌浏览器（WebContentsView 叠层，登录态由主进程持久化）
  open_source_view: (source, rect) => {
    // 两种用法：open_source_view('huaban', rect) / open_source_view({ url, sourceKey: 'custom', rect })
    if (source && typeof source === 'object') {
      return ipcRenderer.invoke('novai:source-view', Object.assign({ action: 'open' }, source, rect ? { rect: rect } : {}));
    }
    return ipcRenderer.invoke('novai:source-view', { action: 'open', source, rect });
  },
  set_source_view_bounds: (rect) => ipcRenderer.invoke('novai:source-view', { action: 'setBounds', rect }),
  close_source_view: () => ipcRenderer.invoke('novai:source-view', { action: 'close' }),
  get_source_view_state: () => ipcRenderer.invoke('novai:source-view', { action: 'state' }),
  reload_source_view: () => ipcRenderer.invoke('novai:source-view', { action: 'reload' }),
  get_source_view_page_html: () => ipcRenderer.invoke('novai:source-view', { action: 'page-html' }),
  // 前端两种调用都支持：(url, maxBytes) 位置参数 或 ({url, maxBytes}) 对象参数
  get_source_view_fetch_bytes: (a, b) => ipcRenderer.invoke('novai:source-view',
    typeof a === 'string'
      ? { action: 'fetch-bytes', url: a, maxBytes: b }
      : Object.assign({ action: 'fetch-bytes' }, a || {})),
  // 最近一次在内嵌浏览器里被拖拽的元素（真实媒体地址等）
  get_last_guest_drag: () => ipcRenderer.invoke('novai:source-view', { action: 'last-drag' }),
  get_guest_drag_bytes: () => ipcRenderer.invoke('novai:source-view', { action: 'guest-drag-bytes' }),
  get_guest_drag_original: () => ipcRenderer.invoke('novai:source-view', { action: 'guest-drag-original' }),
  // 内嵌浏览器网络里抓到的媒体请求（最近 120 秒）
  get_recent_source_media: () => ipcRenderer.invoke('novai:source-view', { action: 'recent-media' }),
  get_recent_custom_source_urls: () => ipcRenderer.invoke('novai:source-view', { action: 'custom-urls' }),
  // 内嵌网页缩放：mode = 'in' | 'out' | 'reset' | 'set'（set 时传 value）
  set_source_zoom: (mode, value) => ipcRenderer.invoke('novai:source-view', { action: 'source-zoom', mode, value }),
  source_zoom_in: () => ipcRenderer.invoke('novai:source-view', { action: 'source-zoom', mode: 'in' }),
  source_zoom_out: () => ipcRenderer.invoke('novai:source-view', { action: 'source-zoom', mode: 'out' }),
  source_zoom_reset: () => ipcRenderer.invoke('novai:source-view', { action: 'source-zoom', mode: 'reset' }),
  source_go_back: () => ipcRenderer.invoke('novai:source-view', { action: 'source-nav', nav: 'back' }),
  source_go_forward: () => ipcRenderer.invoke('novai:source-view', { action: 'source-nav', nav: 'forward' }),
  source_reload: () => ipcRenderer.invoke('novai:source-view', { action: 'source-nav', nav: 'reload' }),
  set_source_ui_theme: (theme) => ipcRenderer.invoke('novai:source-view', { action: 'source-ui-theme', theme: theme }),
  switch_source_site: (site) => ipcRenderer.invoke('novai:source-view', { action: 'source-site', site: site }),
  on_source_view_closed: (callback) => {
    const handler = (event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('novai:source-view-closed', handler);
    return () => { try { ipcRenderer.removeListener('novai:source-view-closed', handler); } catch (_) {} };
  },
  on_source_custom_request: (callback) => {
    const handler = (event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('novai:source-custom-request', handler);
    return () => { try { ipcRenderer.removeListener('novai:source-custom-request', handler); } catch (_) {} };
  },
  on_source_controls_fallback: (callback) => {
    const handler = (event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('novai:source-controls-fallback', handler);
    return () => { try { ipcRenderer.removeListener('novai:source-controls-fallback', handler); } catch (_) {} };
  },
  // 用主进程 session.fetch 拉取（不受 CORS 限制、带登录 cookie）：(url, referer) 或 ({url, referer})
  fetch_source_url: (a, b) => ipcRenderer.invoke('novai:source-view',
    typeof a === 'string'
      ? { action: 'fetch-url', url: a, referer: b }
      : Object.assign({ action: 'fetch-url' }, a || {})),
  // 旧方法保留，内部转到 source-view（前端可渐进迁移）
  open_source_browser: (source) => ipcRenderer.invoke('novai:source-view', { action: 'open', source }),
  close_source_browser: () => ipcRenderer.invoke('novai:source-view', { action: 'close' }),
  get_source_browser_state: () => ipcRenderer.invoke('novai:source-view', { action: 'state' }),

  // 标题栏主题（macOS）
  set_titlebar_theme: (r, g, b) => ipcRenderer.invoke('novai:set-titlebar-theme', { r, g, b }),

  // 信息
  get_app_info: () => ipcRenderer.invoke('novai:get-app-info'),
};

contextBridge.exposeInMainWorld('pywebview', {
  api,
});

// 低层桥：iframe 子页面注入脚本通过 window.parent.postMessage 转发到这里
contextBridge.exposeInMainWorld('__novaiBridge', {
  invoke: (method, payload) => ipcRenderer.invoke('novai:' + method, payload),
});

// ---------- iframe 子页面桥接：接收 postMessage 转发请求并回发结果 ----------
// iframe 内被注入了迷你 shim，调用 window.parent.postMessage({__novaiReq,...})；
// 主 frame 的 preload 在此监听、走 IPC 到主进程、再把结果 postMessage 回 iframe。
window.addEventListener('message', async (e) => {
  const data = e.data;
  if (!data || data.__novaiReq !== true) return;
  const { seq, method, payload } = data;
  try {
    const result = await ipcRenderer.invoke('novai:' + method, payload);
    if (e.source && typeof e.source.postMessage === 'function') {
      e.source.postMessage({ __novaiRes: true, seq, result }, '*');
    }
  } catch (err) {
    if (e.source && typeof e.source.postMessage === 'function') {
      e.source.postMessage({ __novaiRes: true, seq, result: null }, '*');
    }
  }
});

// ---------- 主进程事件 → 主窗口 + 所有 iframe 转发 ----------
// iframe 桥只有 request/response；关闭/自定义站点这类被动事件走 postMessage 广播，
// iframe 里的 shim 再转成 document 上的 CustomEvent 供画布页监听。
function forwardSourceEvent(ipcChannel, messageType) {
  ipcRenderer.on(ipcChannel, (event, payload) => {
    try { window.dispatchEvent(new CustomEvent(messageType, { detail: payload })); } catch (_) {}
    try {
      const frames = document.querySelectorAll ? document.querySelectorAll('iframe') : [];
      Array.prototype.forEach.call(frames, (frame) => {
        try {
          const frameWindow = frame && frame.contentWindow;
          if (frameWindow && typeof frameWindow.postMessage === 'function') {
            frameWindow.postMessage({ type: messageType, payload: payload }, '*');
          }
        } catch (_) {}
      });
    } catch (_) {}
  });
}
forwardSourceEvent('novai:source-view-closed', 'novai:source-view-close');
forwardSourceEvent('novai:source-custom-request', 'novai:source-custom-request');

// 触发 pywebviewready（与 pywebview 的真实事件名一致）
try {
  window.dispatchEvent(new Event('pywebviewready'));
} catch (_) {}
