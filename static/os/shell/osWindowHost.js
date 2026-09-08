// ============================================================================
// NOVAI OS · Window Host (osWindowHost.js)
// Phase 3 瘦身版：**只做集合层**。
//
//   mount / prune / sync / remove / destroy —— 管"哪些窗口该存在"
//   单个窗口长什么样、怎么拖拽 —— 全部交给 osWindowFrame.js
//
// 为什么拆：Phase 2 时 Host 同时管集合与单窗口渲染，加完 Drag / Resize /
//   Controls / IframeBridge 会堆到 600+ 行，集合调度与单窗口渲染混在一起
//   定位困难，也不利于 Dialog / Menu 复用 Frame。
//
// 数据流：Store 快照 → Host.sync() → Frame.update()（纯渲染）
// ⛔ Store 是唯一真相来源：Host 不判断"该不该开窗口"，只按快照挂载/卸载。
// ============================================================================
import { createWindowFrame } from "./osWindowFrame.js";

/**
 * @param {Object} options
 * @param {object} options.wm osWindowManager（传给 Frame，供其回调）
 * @param {(appId: string) => object|null} options.getApp
 * @returns {{ node: HTMLElement, sync: Function, mount: Function, remove: Function, prune: Function, ids: Function, getFrame: Function, destroy: Function }}
 */
export function createWindowHost({ wm = null, getApp = null } = {}) {
  const layer = document.createElement("div");
  layer.className = "os-window-layer";
  layer.setAttribute("role", "region");
  layer.setAttribute("aria-label", "NOVAI OS windows");

  /** @type {Map<string, object>} id → frame */
  const frames = new Map();

  function mount(win, focusedId) {
    let frame = frames.get(win.id);
    if (!frame) {
      frame = createWindowFrame({
        win,
        app: getApp ? getApp(win.appId) : null,
        wm,
      });
      frames.set(win.id, frame);
      layer.appendChild(frame.node);
    }
    frame.update(win, focusedId);
    return frame;
  }

  function remove(id) {
    const frame = frames.get(id);
    if (!frame) return false;
    frame.destroy();
    frames.delete(id);
    return true;
  }

  /** 移除所有不在 validIds 中的窗口（Store 是唯一真相来源） */
  function prune(validIds) {
    const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
    for (const id of Array.from(frames.keys())) {
      if (!valid.has(id)) remove(id);
    }
  }

  /**
   * 按 Store 快照同步。
   * @param {{windows: Array, focusedId: string|null}} snapshot
   */
  function sync(snapshot) {
    const windows = (snapshot && snapshot.windows) || [];
    const focusedId = snapshot ? snapshot.focusedId : null;
    prune(new Set(windows.map((w) => w.id)));
    for (const win of windows) mount(win, focusedId);
  }

  function ids() {
    return Array.from(frames.keys());
  }

  function getFrame(id) {
    return frames.get(id) || null;
  }

  function destroy() {
    for (const id of ids()) remove(id);
    layer.remove();
  }

  return { node: layer, sync, mount, remove, prune, ids, getFrame, destroy };
}

export default createWindowHost;
