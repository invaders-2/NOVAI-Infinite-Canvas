// ============================================================================
// NOVAI OS · App Runtime (osAppRuntime.js)
// Phase 4 App 生命周期**唯一写入口**。
//
// 数据流（单向）：
//   UI / Dock / Launcher / 未来 AI
//        ↓  launch(appId, source)
//   osAppRuntime  ──►  osAppStore（实例 SSOT）
//        ↓  adapter.createWindowSpec
//   osWindowManager.open({ instanceId })  ──►  osWindowStore（窗口 SSOT）
//        ↓  store:change
//   渲染层（Host / Frame / Dock / System Bar）
//
// Runtime 订阅 window:* 事件，反向驱动实例状态：
//   - window:opened  → 实例 running（记录 windowId）
//   - window:closed  → 若最后窗口关闭：ephemeral→stop / session|always→background
//   - window:focused → 更新 lastActiveAt；background→running
//
// ⚠️ keepAlive 保活的是 AppInstance（元数据 + 复用资格），不是强制保活 iframe DOM。
//    Close 最后一个 window（session/always）后 iframe/window 正常释放，实例仅保留元数据；
//    再次 launch 复用同一 instanceId，重建 window/iframe，state 回到 running。
//
// ⛔ 除本文件外，任何模块不得写 osAppStore。
// ============================================================================
import { on, emit } from "./osBus.js";
import * as store from "./osAppStore.js";
import { getApp } from "./osAppRegistry.js";
import * as wm from "./osWindowManager.js";
import { getAdapter } from "./osAppAdapter.js";

/** appId → 在途实例（singleton 并发去重；Entry Validation 异步在途期间真正生效） */
const pending = new Map();

function ts() {
  return Date.now();
}

function emitApp(type, inst, extra = {}) {
  emit(type, {
    appId: inst.appId,
    instanceId: inst.instanceId,
    state: inst.state,
    windowIds: [...inst.windowIds],
    ts: ts(),
    source: extra.source || "system",
    ...extra,
  });
}

function makeInstance(def, source) {
  const instanceId = store.createId();
  const inst = {
    instanceId,
    appId: def.id,
    def,
    state: "registered",
    windowIds: [],
    singleton: !!def.singleton,
    keepAliveMode: def.keepAliveMode || "session",
    keepAliveOnWindowClose: def.keepAliveMode ? def.keepAliveMode !== "ephemeral" : true,
    createdAt: ts(),
    launchedAt: null,
    lastActiveAt: null,
    launchLock: null,
    error: null,
  };
  return inst;
}

/**
 * 为某实例打开（或重建）窗口。
 *
 * ⚠️ 异步：Entry Validation（adapter.prepare）**必须先于 Window 创建**完成。
 *    ⛔ 校验失败 → 不调用 wm.open → 实例落 state:'error' + emit app:error。
 *    由于 osAppStore.aliveAppIds() / runningAppIds() / byAppId() 均排除 'error'，
 *    Dock 运行指示不会误亮（无 ghost Dock），且下次 launch 可干净重试。
 *
 * @param {Object} inst AppInstance
 * @param {Object} def AppDefinition
 * @param {string} source
 * @returns {Promise<Object>} AppInstance
 */
async function openWindowFor(inst, def, source) {
  const adapter = getAdapter("iframe");

  // Entry Validation（同源 + 可达）——在建窗之前
  let prepared;
  try {
    prepared = await adapter.prepare(def);
  } catch (err) {
    // preflight 自身抛错（不应发生）→ 归一成 Runtime Error，同样不建窗
    prepared = {
      ok: false,
      error: {
        code: "ENTRY_PREFLIGHT_FAIL",
        message: String((err && err.message) || err),
        appId: def && def.id,
        entry: def && def.entry,
        status: 0,
      },
    };
  }

  if (!prepared || !prepared.ok) {
    const error = (prepared && prepared.error) || {
      code: "ENTRY_PREFLIGHT_FAIL",
      message: "Entry 预检失败",
    };
    store.update(inst.instanceId, { state: "error", error });
    emitApp("app:error", inst, {
      code: error.code,
      message: error.message,
      entry: error.entry,
      status: error.status,
      source,
    });
    return inst;
  }

  store.update(inst.instanceId, { state: "launching", launchedAt: ts() });
  emitApp("app:launching", inst, { source });

  const spec = adapter.createWindowSpec(def, inst);
  try {
    wm.open(
      { id: def.id, name: def.name, entry: spec.entry },
      { instanceId: inst.instanceId, source }
    );
  } catch (err) {
    const message = String((err && err.message) || err);
    store.update(inst.instanceId, {
      state: "error",
      error: { code: "LAUNCH_FAIL", message },
    });
    emitApp("app:error", inst, { code: "LAUNCH_FAIL", message, source });
  }
  return inst;
}

/**
 * 启动 App。
 * singleton：若已有非 stopped/error 实例 → 复用（有窗口则聚焦；background 则重建窗口）。
 * ⚠️ 异步（Entry Validation 在建窗前 await）。调用方若不关心结果可 fire-and-forget，
 *   结果通过 app:launched / app:error 事件与 app-store:change 收敛到 UI。
 * @param {string} appId
 * @param {'user'|'ai'|'system'} [source]
 * @returns {Promise<Object|null>} AppInstance 或 null
 */
export async function launch(appId, source = "user") {
  const def = getApp(appId);
  if (!def) {
    emit("app:error", {
      appId,
      instanceId: null,
      code: "NO_DEF",
      message: "AppDefinition 缺失",
      ts: ts(),
      source,
    });
    return null;
  }

  if (def.singleton) {
    const existing = store.byAppId(appId);
    if (existing) {
      if (existing.windowIds.length > 0) {
        wm.focus(existing.windowIds[existing.windowIds.length - 1], source);
        store.update(existing.instanceId, { lastActiveAt: ts() });
        return existing;
      }
      if (existing.state === "background") {
        // 复用同 instanceId 重建窗口；preflight 异步在途期间用 pending 防连点双开
        if (pending.has(appId)) return pending.get(appId);
        pending.set(appId, existing);
        try {
          return await openWindowFor(existing, def, source);
        } finally {
          pending.delete(appId);
        }
      }
      // registered / launching 中 → 正在启动（Entry Validation 在途），不重复开窗口
      return existing;
    }
    if (pending.has(appId)) return pending.get(appId); // 并发去重
  }

  const inst = makeInstance(def, source);
  store.insert(inst);
  emitApp("app:registered", inst, { source });

  if (def.singleton) pending.set(appId, inst);
  try {
    await openWindowFor(inst, def, source);
  } finally {
    if (def.singleton) pending.delete(appId);
  }
  return inst;
}

/**
 * 激活实例：聚焦其窗口；background 则重建窗口回到 running。
 * @param {string} instanceId
 */
export async function activate(instanceId, source = "user") {
  const inst = store.byInstanceId(instanceId);
  if (!inst) return null;
  if (inst.windowIds.length > 0) {
    wm.focus(inst.windowIds[inst.windowIds.length - 1], source);
    store.update(instanceId, { lastActiveAt: ts() });
  } else if (inst.state === "background") {
    return openWindowFor(inst, inst.def, source);
  }
  return inst;
}

/**
 * 停止实例（不论 keepAlive）。关闭所有窗口并丢弃实例元数据。
 * @param {string} instanceId
 * @param {string} [reason]
 */
export function stop(instanceId, reason = "user", source = "user") {
  const inst = store.byInstanceId(instanceId);
  if (!inst) return null;
  store.update(instanceId, { state: "stopping" });
  emitApp("app:stopping", inst, { reason, source });
  // wm.close 同步触发 window:closed：此时实例 state=stopping → handler 幂等 no-op
  for (const wid of [...inst.windowIds]) wm.close(wid, source);
  store.drop(instanceId);
  emit("app:stopped", {
    appId: inst.appId,
    instanceId,
    reason,
    ts: ts(),
    source,
  });
  return inst;
}

/** stop + 重新 launch */
export async function restart(instanceId, source = "user") {
  const inst = store.byInstanceId(instanceId);
  if (!inst) return null;
  const appId = inst.appId;
  stop(instanceId, "restart", source);
  return launch(appId, source);
}

/* ---------------- 订阅 Window 事件，驱动实例状态 ---------------- */

on("window:opened", ({ id, instanceId }) => {
  if (!instanceId) return;
  const inst = store.byInstanceId(instanceId);
  if (!inst) return;
  if (inst.state === "stopping" || inst.state === "stopped") return; // 正在 stop，忽略
  if (!inst.windowIds.includes(id)) {
    inst.windowIds.push(id);
    store.linkWindow(instanceId, id);
  }
  if (inst.state !== "running") {
    store.update(instanceId, { state: "running", lastActiveAt: ts() });
    emitApp("app:launched", inst);
  }
  emitApp("app:window-attached", inst, { windowId: id });
});

on("window:closed", ({ id, instanceId }) => {
  if (!instanceId) return;
  const inst = store.byInstanceId(instanceId);
  if (!inst) return; // 已被 stop 丢弃 → 幂等
  if (inst.state === "stopping" || inst.state === "stopped") {
    store.unlinkWindow(id);
    return;
  }
  inst.windowIds = inst.windowIds.filter((w) => w !== id);
  store.unlinkWindow(id);

  if (inst.windowIds.length === 0) {
    if (inst.keepAliveOnWindowClose) {
      // session / always → background：iframe/window 已由 WM dispose，不 stash
      store.update(instanceId, { state: "background" });
      emitApp("app:backgrounded", inst);
    } else {
      // ephemeral → stop
      store.update(instanceId, { state: "stopping" });
      emitApp("app:stopping", inst, { reason: "last-window-closed" });
      store.drop(instanceId);
      emit("app:stopped", {
        appId: inst.appId,
        instanceId,
        reason: "last-window-closed",
        ts: ts(),
        source: "system",
      });
    }
  } else {
    store.update(instanceId, { windowIds: inst.windowIds });
    emitApp("app:window-detached", inst, { windowId: id });
  }
});

on("window:focused", ({ instanceId }) => {
  if (!instanceId) return;
  const inst = store.byInstanceId(instanceId);
  if (!inst) return;
  store.update(instanceId, { lastActiveAt: ts() });
  if (inst.state === "background") {
    store.update(instanceId, { state: "running" });
    emitApp("app:activated", inst);
  }
});

/* ---------------- 查询 / Future AI API 映射 ---------------- */

export function getAppInstance(instanceId) {
  return store.byInstanceId(instanceId);
}
export function listInstances() {
  return store.all();
}
export function getAliveAppIds() {
  return store.aliveAppIds();
}
export function getRunningAppIds() {
  return store.runningAppIds();
}
export function getBackgroundAppIds() {
  return store.backgroundAppIds();
}

/**
 * Capabilities 查询（Runtime-Query 层）。
 *   declared   —— manifest 声明的元数据：只代表"宣称有"，**不代表可调用**
 *   executable —— 当前已真正绑定 Action / Adapter handler 的能力
 *
 * Phase 5 尚无 Action System → executable 恒为 []（如 chat.ask 仅 declared）。
 * ⛔ 调用方不得把 declared 当作可执行依据。
 * @param {string} appId
 * @returns {{declared: Array, executable: Array}}
 */
export function getAppCapabilities(appId) {
  const def = getApp(appId);
  if (!def) return { declared: [], executable: [] };
  return {
    declared: def.declaredCapabilities || def.capabilities || [],
    executable: def.executableCapabilities || [],
  };
}

/** 某能力当前是否真正可执行（只看 executable） */
export function canExecute(appId, capabilityId) {
  const { executable } = getAppCapabilities(appId);
  return executable.some((c) => c && c.id === capabilityId);
}

/** 冻结的 AI Action 面（与 windowApi 同级，未来 os.app.* 直接映射） */
export const appApi = Object.freeze({
  list: listInstances,
  get: getAppInstance,
  launch,
  activate,
  stop,
  restart,
  capabilities: getAppCapabilities,
  canExecute,
});

export default appApi;
