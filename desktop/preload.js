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

// 触发 pywebviewready（与 pywebview 的真实事件名一致）
try {
  window.dispatchEvent(new Event('pywebviewready'));
} catch (_) {}
