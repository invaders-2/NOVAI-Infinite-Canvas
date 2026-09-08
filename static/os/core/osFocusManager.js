// ============================================================================
// NOVAI OS · Focus Manager (osFocusManager.js)
// Phase 3 Focus Policy —— 只做"谁该获得焦点"的决策，不做写入。
//
// 决策表（Focus Policy，Phase 3 正式定义）：
//
//   open App                 → 新窗口获得焦点（z 置顶）
//   点击窗口任意处           → 该窗口获得焦点（z 置顶）
//   点击窗口内 iframe        → 经 iframe Focus Bridge 上报 → 该窗口获得焦点
//   点击 Dock Item
//     ├ 未运行               → open → 焦点
//     ├ 运行中 normal        → 焦点（z 置顶）
//     └ 运行中 minimized     → restore → 焦点（z 置顶）
//   关闭焦点窗口             → 焦点自动落到"剩余非 minimized 中 z 最高"的窗口
//   最小化焦点窗口           → 同上
//   点击桌面空白             → **清空焦点**（focusedId = null）
//                              System Bar 显示 NOVAI OS 空态；
//                              无焦点时"关闭当前窗口"等动作 = 不操作。
//   点击 System Bar / Dock / Launcher → 不改变焦点
//   drag / resize 开始       → 该窗口获得焦点 + z 置顶
//
// 写入仍然只由 osWindowManager 执行：本模块提供判定 + 直接改 focusedId，
// 且**必须**在 store.batch() 内调用，避免多次广播。
// ============================================================================
import * as store from "./osWindowStore.js";

/** 当前焦点 id（可能为 null） */
export function current() {
  return store.getFocusedId();
}

/**
 * 尝试把焦点给某个窗口。
 * minimized 窗口不能被聚焦（必须先 restore）—— 返回 null 表示"未聚焦"。
 * @returns {string|null} 实际获得焦点的 id
 */
export function focus(id) {
  if (!id) {
    store.setFocusedId(null);
    return null;
  }
  const win = store.byId(id);
  if (!win) {
    store.setFocusedId(null);
    return null;
  }
  if (win.state === "minimized") return null;
  store.setFocusedId(id);
  return id;
}

/** 清空焦点（点击桌面空白） */
export function blurAll() {
  store.setFocusedId(null);
  return null;
}

/**
 * 在排除 goneId 之后，选出下一个合理焦点：
 * 剩余非 minimized 窗口中 z 最高的那个；没有则 null。
 */
export function pickNextAfter(goneId) {
  const candidates = store
    .all()
    .filter((w) => w.id !== goneId && w.state !== "minimized");
  if (!candidates.length) return null;
  return candidates[candidates.length - 1].id;
}

/** 非 minimized 窗口（可见窗口），z 升序 */
export function visibleWindows() {
  return store.all().filter((w) => w.state !== "minimized");
}

/**
 * 决策入口：给定事件，返回应该执行的动作描述。
 * 目前主要用于自检 / 未来 AI Action 复用；UI 路径直接调上面的具体函数。
 * @returns {{action:'focus'|'blur'|'none', id: string|null}}
 */
export function resolve(event) {
  const evt = event || {};
  switch (evt.type) {
    case "pointerdown:window":
      return { action: "focus", id: evt.id || null };
    case "pointerdown:desktop-blank":
      return { action: "blur", id: null };
    case "dock:activate":
      return { action: "focus", id: evt.id || null };
    default:
      return { action: "none", id: null };
  }
}

export default { current, focus, blurAll, pickNextAfter, visibleWindows, resolve };
