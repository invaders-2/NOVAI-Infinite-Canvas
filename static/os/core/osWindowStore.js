// ============================================================================
// NOVAI OS · Window Store (osWindowStore.js)
// Phase 3 Window Manager 的**唯一真相来源（Single Source of Truth）**。
//
// 本文件只做三件事：
//   1. 持有窗口状态（windows / focusedId / workArea）
//   2. 提供最低限度的变更原语（insert / update / drop / setFocusedId / setWorkArea）
//   3. 变更后广播 store:change（渲染触发信号）
//
// ⛔ 业务语义一律不在本文件实现：open / focus / move / resize / minimize /
//    maximize / restore / close 全部属于 osWindowManager.js。
//   除 WM 之外，任何模块都不应调用 insert / update / drop / setFocusedId。
//
// Window 记录字段（Phase 3 完整模型）：
//   id          string  窗口实例 id（每次 open 都是新实例）
//   appId       string  所属 App
//   title       string  标题栏文案
//   state       'normal' | 'minimized' | 'maximized'
//   rect        {x,y,width,height}  当前生效几何（maximized 时 = workArea）
//   prevRect    null | {x,y,width,height}  maximized 之前的 normal 几何
//   minSize     {width,height}      最小尺寸下限
//   z           number  层内相对 z（1..N，压缩后连续）
//   singleton   boolean 同一 appId 同时只允许一个实例；关闭后可再开新实例
//   createdAt   number
//
// ⚠️ focused **不入记录**：focused 由 focusedId 派生（payload 里计算），
//    避免"记录里的 focused"与"focusedId"两套真相互相漂移。
//
// 不变式（Invariants，WM 每次写入后必须成立）：
//   I1 focusedId === 最高 z 的非 minimized 窗口 id，或 null
//   I2 z 唯一、连续、压缩在 1..N
//   I3 state === 'maximized' ⇒ prevRect 非 null
//   I4 rect 已被 clamp 进 workArea 且不小于 minSize
//   I5 只有 osWindowManager 写入本 Store
// ============================================================================
import { emit } from "./osBus.js";

/** @type {Map<string, object>} */
const windows = new Map();

let seq = 0;
let zCounter = 0;
let focusedId = null;
let workArea = { x: 0, y: 0, width: 1280, height: 720 };

/** 批量写入深度：>0 时抑制广播，退出到 0 时统一广播一次 */
let batchDepth = 0;

function fallbackWorkArea() {
  if (typeof window === "undefined") return workArea;
  return {
    x: 0,
    y: 0,
    width: Math.max(320, window.innerWidth || 1280),
    height: Math.max(320, window.innerHeight || 720),
  };
}

function publish() {
  if (batchDepth > 0) return;
  emit("store:change", snapshot());
}

/**
 * 批量写入。WM 的每个操作都应该包在 batch 里，
 * 保证一次用户动作只触发一次 store:change（避免渲染风暴）。
 */
export function batch(fn) {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) publish();
  }
}

/** 当前是否处于批量写入中（诊断用） */
export function isBatching() {
  return batchDepth > 0;
}

/* ---------------- 写入原语（仅供 osWindowManager 调用） ---------------- */

/** 生成新窗口 id */
export function createId() {
  seq += 1;
  return `win-${seq}`;
}

/** 取下一个单调递增 z（随后由 WM 调用 compact 压缩） */
export function nextZ() {
  zCounter += 1;
  return zCounter;
}

/** 插入窗口记录 */
export function insert(win) {
  windows.set(win.id, win);
  publish();
  return win;
}

/** 局部更新（浅合并）。返回更新后的记录，不存在返回 null */
export function update(id, patch) {
  const win = windows.get(id);
  if (!win) return null;
  Object.assign(win, patch || {});
  publish();
  return win;
}

/** 移除窗口记录。返回是否真的移除了 */
export function drop(id) {
  const ok = windows.delete(id);
  if (ok) publish();
  return ok;
}

/** 设置焦点窗口。null = 无焦点（点击桌面空白） */
export function setFocusedId(id) {
  focusedId = id && windows.has(id) ? id : null;
  publish();
  return focusedId;
}

/** 设置可用工作区（由 Desktop 测量后下发） */
export function setWorkArea(area) {
  workArea = { ...workArea, ...(area || {}) };
  publish();
  return { ...workArea };
}

/* ---------------- 读取 ---------------- */

/** 全部窗口（z 升序，最后一个 = 最上层） */
export function all() {
  return Array.from(windows.values()).sort((a, b) => a.z - b.z);
}

export function byId(id) {
  return windows.get(id) || null;
}

export function byAppId(appId) {
  return all().find((w) => w.appId === appId) || null;
}

/** 按 instanceId 查窗口（App Runtime 复用/聚焦实例时用；窗口关闭后返回 null） */
export function byInstanceId(instanceId) {
  return all().find((w) => w.instanceId === instanceId) || null;
}

/** 非 minimized 窗口中 z 最高的那个（焦点候选） */
export function topmost() {
  const visible = all().filter((w) => w.state !== "minimized");
  return visible.length ? visible[visible.length - 1] : null;
}

export function topmostId() {
  const win = topmost();
  return win ? win.id : null;
}

export function getFocusedId() {
  return focusedId;
}

export function getWorkArea() {
  return { ...workArea };
}

/** 正在运行的 appId 集合（含 minimized —— 最小化不等于停止运行） */
export function runningAppIds() {
  return new Set(all().map((w) => w.appId));
}

/** 处于 minimized 的 appId 集合（供 Dock 做弱化表达） */
export function minimizedAppIds() {
  return new Set(
    all()
      .filter((w) => w.state === "minimized")
      .map((w) => w.appId)
  );
}

/** 全量快照（渲染层唯一消费入口） */
export function snapshot() {
  return {
    windows: all(),
    focusedId,
    workArea: { ...workArea },
  };
}

/** 清空（测试 / 热重载） */
export function reset() {
  windows.clear();
  seq = 0;
  zCounter = 0;
  focusedId = null;
  workArea = fallbackWorkArea();
  publish();
}

/* ---------------- 向后兼容别名（Phase 2 时期命名） ----------------
 * 语义有变化的已标注。新代码一律用上面的正式命名。
 */
export const list = all;
export const get = byId;
export const getByAppId = byAppId;
export const getByInstanceId = byInstanceId;
/** ⚠️ Phase 2 语义 = "highest z"；Phase 3 语义 = "focusedId"（可能为空） */
export const getActiveId = getFocusedId;
export const resetStore = reset;

/** 某 App 是否有窗口（含 minimized） */
export function isRunning(appId) {
  return runningAppIds().has(appId);
}

export default {
  batch,
  isBatching,
  createId,
  nextZ,
  insert,
  update,
  drop,
  setFocusedId,
  setWorkArea,
  all,
  byId,
  byAppId,
  byInstanceId,
  topmost,
  topmostId,
  getFocusedId,
  getWorkArea,
  runningAppIds,
  minimizedAppIds,
  snapshot,
  reset,
  list,
  get,
  getByAppId,
  getActiveId,
  resetStore,
  isRunning,
};
