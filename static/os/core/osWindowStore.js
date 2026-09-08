// ============================================================================
// NOVAI OS · Window Store (osWindowStore.js)
// Phase 2 只做**最小**状态，不做完整 Window Manager。
//
// 状态字段（最小化）：
//   id, appId, title, open, rect（默认值）, state, z
//
// z 的最小激活语义（仅此三条规定，不扩展）：
//   1. 新开窗口     → z++
//   2. 点击已打开 App / Dock Item → z++
//   3. highest z    = 当前前景窗口
//
// Phase 2 明确不做（留给 Phase 3 Window Manager）：
//   drag / resize / minimize / maximize / restore /
//   完整 focus policy / z 分层规则 / modal stacking /
//   always-on-top / snapping / Mission Control
// ============================================================================
import { emit } from "./osBus.js";

const DEFAULT_RECT = { x: 120, y: 96, width: 880, height: 560 };

/** 轻微错开，避免多个默认窗口完全重叠（不是 snapping，只是默认值偏移） */
const CASCADE_STEP = 28;

let seq = 0;
let zCounter = 0;
/** @type {Map<string, object>} */
const windows = new Map();

function nextZ() {
  zCounter += 1;
  return zCounter;
}

function cascadeOffset(index) {
  const step = (index % 6) * CASCADE_STEP;
  return { ...DEFAULT_RECT, x: DEFAULT_RECT.x + step, y: DEFAULT_RECT.y + step };
}

function publish(change) {
  emit("store:change", { windows: list(), activeId: getActiveId(), change });
}

/** 全部窗口（按 z 升序） */
export function list() {
  return Array.from(windows.values()).sort((a, b) => a.z - b.z);
}

/** 前台窗口 id（highest z） */
export function getActiveId() {
  const all = list();
  return all.length ? all[all.length - 1].id : null;
}

/** 按 id 取窗口 */
export function get(id) {
  return windows.get(id) || null;
}

/** 按 appId 取窗口（Phase 2 一个 App 最多一个窗口） */
export function getByAppId(appId) {
  return list().find((w) => w.appId === appId) || null;
}

/**
 * 打开或激活窗口。
 * 已打开 → 只 z++（激活）；未打开 → 创建。
 * @param {{ id: string, name?: string }} app
 * @returns {object} window
 */
export function openApp(app) {
  const existing = getByAppId(app.id);
  if (existing) {
    return activate(existing.id);
  }
  seq += 1;
  const win = {
    id: `win-${seq}`,
    appId: app.id,
    title: app.name || app.id,
    open: true,
    rect: cascadeOffset(seq - 1),
    state: "normal", // Phase 2 恒为 normal；minimize/maximize 属 Phase 3
    z: nextZ(),
  };
  windows.set(win.id, win);
  emit("window:open", { window: win });
  publish("open");
  return win;
}

/** 激活（z++）。返回更新后的窗口，不存在返回 null */
export function activate(id) {
  const win = windows.get(id);
  if (!win) return null;
  win.z = nextZ();
  emit("window:focus", { id });
  publish("focus");
  return win;
}

/** 关闭并移除。返回 true 表示确实关闭了一个窗口 */
export function close(id) {
  const win = windows.get(id);
  if (!win) return false;
  windows.delete(id);
  win.open = false;
  emit("window:close", { id, appId: win.appId });
  publish("close");
  return true;
}

/** 某 App 是否在运行（供 Dock 运行态） */
export function isRunning(appId) {
  return list().some((w) => w.appId === appId);
}

/**
 * 点击 App 的统一入口：未开 → 打开；已开 → 激活（z++）。
 * @param {{ id: string, name?: string }} app
 */
export function launchOrActivate(app) {
  return openApp(app);
}

/** 清空（测试 / 热重载用） */
export function resetStore() {
  windows.clear();
  seq = 0;
  zCounter = 0;
  publish("reset");
}

export default { list, get, getByAppId, getActiveId, openApp, activate, close, isRunning, launchOrActivate, resetStore };
