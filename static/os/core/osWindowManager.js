// ============================================================================
// NOVAI OS · Window Manager (osWindowManager.js)
// Phase 3 核心：**唯一写入口**。
//
// 数据流（单向，禁止反向）：
//   UI 点击 / 未来 AI Action
//        ↓  都调同一个 API
//   osWindowManager  ──►  FocusManager（决策）+ LayerPolicy（分层/几何）
//        ↓  写
//   osWindowStore（唯一真相）
//        ↓  store:change
//   osWindowHost → osWindowFrame（纯渲染，不再持有状态）
//
// ⛔ 硬性规则
//   1. 除本文件外，任何模块不得写 Store（Drag / Resize / Frame 只能回调本文件的 API）
//   2. 每个操作先写 Store，再发语义事件（事件代表"已发生"，不是"将要发生"）
//   3. 每个操作只触发一次 store:change（全部包在 store.batch 内）
//
// 未来 AI Assistant 映射（Phase 3 不实现 AI，但 API 已对齐）：
//   os.window.open(app)  os.window.focus(id)   os.window.move(id,x,y)
//   os.window.resize(id,rect) os.window.minimize(id) os.window.maximize(id)
//   os.window.restore(id) os.window.close(id)  os.window.closeActive()
//   → 见文件末尾 windowApi
//
// Event Contract（统一 payload，见 payload()）：
//   window:opened / focused / blurred / moved / resized /
//   minimized / maximized / restored / closed / changed
// ============================================================================
import { emit } from "./osBus.js";
import * as store from "./osWindowStore.js";
import * as focusPolicy from "./osFocusManager.js";
import {
  compact,
  clampRect,
  clampPosition,
  workAreaRect,
} from "./osLayerPolicy.js";

const DEFAULT_SIZE = { width: 880, height: 560 };
const MIN_SIZE = { width: 360, height: 240 };
/** 新建窗口相对 workArea 的内缩与错开（不是 snapping，只是默认摆放） */
const SPAWN_INSET = 24;
const CASCADE_STEP = 28;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** 统一事件 payload —— Event Contract 的唯一形状 */
function payload(win, source) {
  return {
    id: win.id,
    appId: win.appId,
    title: win.title,
    state: win.state,
    rect: { ...win.rect },
    z: win.z,
    focused: store.getFocusedId() === win.id,
    ts: Date.now(),
    source: source || "system", // 'user' | 'ai' | 'system'
  };
}

/** 窗口初始化几何：居中偏左上 + 轻微错开 */
function nextRect() {
  const wa = store.getWorkArea();
  const count = store.all().length;
  const step = (count % 6) * CASCADE_STEP;

  const width = Math.min(
    DEFAULT_SIZE.width,
    Math.max(MIN_SIZE.width, wa.width - SPAWN_INSET * 2)
  );
  const height = Math.min(
    DEFAULT_SIZE.height,
    Math.max(MIN_SIZE.height, wa.height - SPAWN_INSET * 2)
  );
  const x = clamp(
    wa.x + SPAWN_INSET + step,
    wa.x,
    Math.max(wa.x, wa.x + wa.width - width)
  );
  const y = clamp(
    wa.y + SPAWN_INSET + step,
    wa.y,
    Math.max(wa.y, wa.y + wa.height - height)
  );
  return { x, y, width, height };
}

/** z 压缩（层内 1..N，保持连续） */
function compactZ() {
  const map = compact(store.all());
  for (const [id, z] of map) {
    store.update(id, { z });
  }
}

/* ---------------- 生命周期 API ---------------- */

/**
 * 打开（或激活）一个 App 的窗口。
 * singleton 语义：同一 appId 同时只有一个实例；
 *   - 已开 normal    → 只聚焦
 *   - 已开 minimized → restore + 聚焦
 *   - 未开 / 已关闭  → 创建**新的**窗口实例（新 id）
 * @param {{id:string,name?:string}} app
 * @param {'user'|'ai'|'system'} source
 */
export function open(app, source = "user") {
  if (!app || !app.id) return null;

  const existing = store.byAppId(app.id);
  if (existing) {
    if (existing.state === "minimized") return restore(existing.id, source);
    return focusWindow(existing.id, source);
  }

  let win = null;
  store.batch(() => {
    const id = store.createId();
    win = {
      id,
      appId: app.id,
      title: app.name || app.id,
      state: "normal",
      rect: nextRect(),
      prevRect: null,
      minSize: { ...MIN_SIZE },
      z: store.nextZ(),
      singleton: true,
      createdAt: Date.now(),
    };
    store.insert(win);
    compactZ();
    focusPolicy.focus(id);
  });

  emit("window:opened", payload(win, source));
  emit("window:focused", payload(win, source));
  emit("window:changed", payload(win, source));
  return win;
}

/** 聚焦（z 置顶）。minimized 窗口不响应聚焦 —— 请先 restore */
/** focus 别名：对外 API 用 focus（未来 os.window.focus） */
export function focusWindow(id, source = "user") {
  if (!id) return null;
  let win = null;
  const before = store.getFocusedId();

  store.batch(() => {
    win = store.byId(id);
    if (!win || win.state === "minimized") {
      win = null;
      return;
    }
    if (before && before !== id) {
      const prev = store.byId(before);
      if (prev) emit("window:blurred", { ...payload(prev, source), focused: false });
    }
    store.update(id, { z: store.nextZ() });
    compactZ();
    focusPolicy.focus(id);
  });

  if (!win) return null;
  if (before !== id) emit("window:focused", payload(win, source));
  emit("window:changed", payload(win, source));
  return win;
}

/** 清空焦点（点击桌面空白）。无焦点时什么也不做 */
export function blur(source = "user") {
  const id = store.getFocusedId();
  if (!id) return null;
  let win = null;
  store.batch(() => {
    win = store.byId(id);
    focusPolicy.blurAll();
  });
  if (!win) return null;
  emit("window:blurred", { ...payload(win, source), focused: false });
  return win;
}

/**
 * 移动窗口到指定位置（提交一次移动）。
 * 拖拽过程中的实时预览由 Frame 自行改 style，不进 Store，
 * 松手时才调用这里，因此 window:moved 表示"一次移动完成"。
 */
export function move(id, x, y, source = "user") {
  let win = null;
  store.batch(() => {
    win = store.byId(id);
    if (!win || win.state === "maximized") {
      win = null;
      return;
    }
    const pos = clampPosition(x, y, win.rect, store.getWorkArea());
    store.update(id, { rect: { ...win.rect, ...pos } });
  });
  if (!win) return null;
  emit("window:moved", payload(win, source));
  emit("window:changed", payload(win, source));
  return win;
}

/** 调整窗口尺寸（提交一次 resize）。maximized 状态下不接受 resize */
export function resize(id, rect, source = "user") {
  let win = null;
  store.batch(() => {
    win = store.byId(id);
    if (!win || win.state === "maximized") {
      win = null;
      return;
    }
    store.update(id, {
      rect: clampRect(rect, win.minSize, store.getWorkArea()),
    });
  });
  if (!win) return null;
  emit("window:resized", payload(win, source));
  emit("window:changed", payload(win, source));
  return win;
}

/** 最小化。App Runtime 继续运行 —— iframe 不卸载，Dock 仍显示运行 */
export function minimize(id, source = "user") {
  let win = null;
  let nextId = null;

  store.batch(() => {
    win = store.byId(id);
    if (!win || win.state === "minimized") {
      win = null;
      return;
    }
    // maximized 直接最小化：先回到 normal 几何再最小化，保证还原时尺寸合理
    if (win.state === "maximized" && win.prevRect) {
      store.update(id, { rect: { ...win.prevRect } });
    }
    store.update(id, { state: "minimized", prevRect: null });

    if (store.getFocusedId() === id) {
      nextId = focusPolicy.pickNextAfter(id);
      store.setFocusedId(nextId);
      if (nextId) {
        store.update(nextId, { z: store.nextZ() });
        compactZ();
      }
    }
  });

  if (!win) return null;
  emit("window:minimized", { ...payload(win, source), focused: false });
  if (nextId) {
    const next = store.byId(nextId);
    if (next) emit("window:focused", payload(next, source));
  }
  emit("window:changed", { ...payload(win, source), focused: false });
  return win;
}

/**
 * 最大化：占满 NOVAI OS Desktop 可用工作区（不是浏览器 Fullscreen）。
 * 工作区由 Desktop 测量（System Bar 下沿 → Dock 上沿，含安全边距）。
 */
export function maximize(id, source = "user") {
  let win = null;
  store.batch(() => {
    win = store.byId(id);
    if (!win || win.state === "maximized") {
      win = null;
      return;
    }
    // 从 minimized 直接最大化：prevRect 取当前 rect（maximize 优先）
    const prev = { ...win.rect };
    store.update(id, {
      prevRect: prev,
      rect: workAreaRect(store.getWorkArea()),
      state: "maximized",
      z: store.nextZ(),
    });
    compactZ();
    focusPolicy.focus(id);
  });
  if (!win) return null;
  emit("window:maximized", payload(win, source));
  emit("window:focused", payload(win, source));
  emit("window:changed", payload(win, source));
  return win;
}

/** 还原：minimized | maximized → normal，并聚焦 */
export function restore(id, source = "user") {
  let win = null;
  store.batch(() => {
    win = store.byId(id);
    if (!win || win.state === "normal") {
      win = null;
      return;
    }
    const nextRectValue =
      win.state === "maximized" && win.prevRect ? { ...win.prevRect } : { ...win.rect };
    store.update(id, {
      state: "normal",
      rect: clampRect(nextRectValue, win.minSize, store.getWorkArea()),
      prevRect: null,
      z: store.nextZ(),
    });
    compactZ();
    focusPolicy.focus(id);
  });
  if (!win) return null;
  emit("window:restored", payload(win, source));
  emit("window:focused", payload(win, source));
  emit("window:changed", payload(win, source));
  return win;
}

/** 最大化 / 还原切换（标题栏按钮用） */
export function toggleMaximize(id, source = "user") {
  const win = store.byId(id);
  if (!win) return null;
  return win.state === "maximized" ? restore(id, source) : maximize(id, source);
}

/** 关闭：Store 移除 → Host 移除 → Dock 运行态更新 → 焦点重算（渲染层自动跟随） */
export function close(id, source = "user") {
  let win = null;
  let nextId = null;

  store.batch(() => {
    win = store.byId(id);
    if (!win) return;
    const wasFocused = store.getFocusedId() === id;
    nextId = wasFocused ? focusPolicy.pickNextAfter(id) : null;

    store.drop(id);
    if (wasFocused) {
      store.setFocusedId(nextId);
      if (nextId) {
        store.update(nextId, { z: store.nextZ() });
      }
    }
    compactZ();
  });

  if (!win) return null;
  emit("window:closed", { ...payload(win, source), focused: false });
  if (nextId) {
    const next = store.byId(nextId);
    if (next) emit("window:focused", payload(next, source));
  }
  return win;
}

/**
 * 关闭当前焦点窗口。
 * ⚠️ 无焦点时的语义是"不操作"，而不是猜一个窗口去关 —— 这是明确约定。
 */
export function closeActive(source = "user") {
  const id = store.getFocusedId();
  if (!id) return null;
  return close(id, source);
}

/* ---------------- 环境 / 查询 ---------------- */

/** Desktop 测量后下发可用工作区；已存在的窗口会被重新收敛 */
export function setWorkArea(area) {
  store.batch(() => {
    store.setWorkArea(area);
    const wa = store.getWorkArea();
    for (const win of store.all()) {
      if (win.state === "maximized") {
        store.update(win.id, { rect: workAreaRect(wa) });
      } else {
        const base = win.state === "minimized" ? win.rect : win.rect;
        store.update(win.id, { rect: clampRect(base, win.minSize, wa) });
      }
    }
  });
  return store.getWorkArea();
}

export const focus = focusWindow;

export function getWorkArea() {
  return store.getWorkArea();
}

export function getState() {
  return store.snapshot();
}

export function list() {
  return store.all();
}

export function get(id) {
  return store.byId(id);
}

export function getActiveId() {
  return store.getFocusedId();
}

/** 供 Dock / Launcher 判断：某 App 当前是否在跑（含 minimized） */
export function isRunning(appId) {
  return store.runningAppIds().has(appId);
}

/* ---------------- AI Action 兼容面 ----------------
 * Phase 3 不实现 AI Assistant，但把 API 收敛到这里，
 * 未来 os.window.* 直接映射，不需要回头改 UI 调用点。
 */
export const windowApi = Object.freeze({
  open,
  focus: focusWindow,
  blur,
  move,
  resize,
  minimize,
  maximize,
  restore,
  toggleMaximize,
  close,
  closeActive,
  getState,
  list,
  get,
  getActiveId,
  getWorkArea,
  setWorkArea,
  isRunning,
});

export default windowApi;
