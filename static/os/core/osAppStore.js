// ============================================================================
// NOVAI OS · App Store (osAppStore.js)
// Phase 4 App Runtime 的**实例唯一真相来源（SSOT）**。
//
// 与 osWindowStore 平行：本文件只持有 AppInstance（App 运行副本的元数据），
// 不碰窗口几何、不持有 live iframe。
//
// ⛔ 硬性规则：除 osAppRuntime.js 外，任何模块不得调用 insert / update / drop /
//   linkWindow / unlinkWindow / reset。本文件只提供最低限度原语 + 广播。
//
// AppInstance 字段（与 osAppRuntime 约定）：
//   instanceId        string  实例 id（appinst-<seq>），≠ appId
//   appId             string  所属 App
//   def               object  AppDefinition 引用
//   state             'registered'|'launching'|'running'|'background'|'stopping'|'stopped'|'error'
//   windowIds         string[] 本实例拥有的窗口 id（background 态为空）
//   singleton         boolean
//   keepAliveMode     'always'|'session'|'ephemeral'   ★ 唯一真实保活字段
//   keepAliveOnWindowClose boolean  派生
//   createdAt/launchedAt/lastActiveAt number
//   launchLock        Promise|null
//   error             null | { code, message, ts }
//
// 不变式：I1 同一 appId 的 singleton 实例同时至多 1 个非 stopped/error；
//        I2 windowToInstance 与实例 windowIds 双向一致；
//        I3 只有 osAppRuntime 写入本 Store。
// ============================================================================
import { emit } from "./osBus.js";

/** @type {Map<string, object>} instanceId → AppInstance */
const instances = new Map();
/** @type {Map<string, string>} windowId → instanceId */
const windowToInstance = new Map();

let seq = 0;
let batchDepth = 0;

function publish() {
  if (batchDepth > 0) return;
  emit("app-store:change", snapshot());
}

/**
 * 批量写入。Runtime 的每个操作都应包在 batch 内，
 * 保证一次动作只触发一次 app-store:change。
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

export function isBatching() {
  return batchDepth > 0;
}

/* ---------------- 写入原语（仅供 osAppRuntime 调用） ---------------- */

export function createId() {
  seq += 1;
  return `appinst-${seq}`;
}

export function insert(inst) {
  instances.set(inst.instanceId, inst);
  publish();
  return inst;
}

export function update(id, patch) {
  const inst = instances.get(id);
  if (!inst) return null;
  Object.assign(inst, patch || {});
  publish();
  return inst;
}

export function drop(id) {
  const ok = instances.delete(id);
  if (ok) {
    for (const [wid, iid] of windowToInstance) {
      if (iid === id) windowToInstance.delete(wid);
    }
    publish();
  }
  return ok;
}

export function linkWindow(instanceId, windowId) {
  windowToInstance.set(windowId, instanceId);
}

export function unlinkWindow(windowId) {
  windowToInstance.delete(windowId);
}

/* ---------------- 读取 / 索引 ---------------- */

export function byInstanceId(id) {
  return instances.get(id) || null;
}

export function byWindowId(windowId) {
  const iid = windowToInstance.get(windowId);
  return iid ? instances.get(iid) || null : null;
}

/** 返回第一个非 stopped / 非 error 实例（singleton 复用判定用） */
export function byAppId(appId) {
  for (const inst of instances.values()) {
    if (inst.appId === appId && inst.state !== "stopped" && inst.state !== "error") return inst;
  }
  return null;
}

export function all() {
  return Array.from(instances.values());
}

/** 所有非 stopped / 非 error 实例的 appId（Dock 运行指示，含 background） */
export function aliveAppIds() {
  const s = new Set();
  for (const inst of instances.values()) {
    if (inst.state !== "stopped" && inst.state !== "error") s.add(inst.appId);
  }
  return s;
}

/** 有 ≥1 窗口的 appId 集合 */
export function runningAppIds() {
  const s = new Set();
  for (const inst of instances.values()) {
    if (inst.state !== "stopped" && inst.state !== "error" && inst.windowIds.length > 0) {
      s.add(inst.appId);
    }
  }
  return s;
}

/** state=background 且 windowIds 为空的 appId 集合 */
export function backgroundAppIds() {
  const s = new Set();
  for (const inst of instances.values()) {
    if (inst.state === "background" && inst.windowIds.length === 0) s.add(inst.appId);
  }
  return s;
}

export function snapshot() {
  return { instances: all(), windowToInstance: new Map(windowToInstance) };
}

export function reset() {
  instances.clear();
  windowToInstance.clear();
  seq = 0;
  publish();
}

export default {
  batch,
  isBatching,
  createId,
  insert,
  update,
  drop,
  linkWindow,
  unlinkWindow,
  byInstanceId,
  byWindowId,
  byAppId,
  all,
  aliveAppIds,
  runningAppIds,
  backgroundAppIds,
  snapshot,
  reset,
};
