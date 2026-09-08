// ============================================================================
// NOVAI OS · App Registry (osAppRegistry.js)
// 职责单一：builtinApps + GET /api/apps → normalize → merge → 统一输出。
//
// 数据来源：
//   1. builtinApps.js  —— Phase 2 内置第一方 App 描述符（迁移期临时）
//   2. GET /api/apps   —— 后端 AppRegistry（server/appRegistry.py）真实输出
//
// 冲突规则：**相同 id 时，真实 /api/apps manifest 优先**（内置描述符让位）。
// 这样 Phase 5 第一方 App manifest 化后，只要后端注册了同 id 的 App，
// 前端会自动切到真实数据，无需改前端代码。
//
// 注意：GET /api/apps 的返回形状（来自 AppRegistry.list_apps，Phase 5 起）是
//   { apps: [ {
//       id, title, description, version, state,
//       entry,            // 已解析为 /apps/<id>/<entry> 的可直连 URL
//       keepAlive,        // 'always' | 'session' | 'ephemeral'
//       singleton,        // bool
//       permissions,      // string[]
//       capabilities:[{id,risk,title}]
//   } ] }
// 第一方 App（如 chat）迁移到 registry 后，entry 由后端真实返回，
// normalizeRemote 直接采用，不再恒为 null，Window Host 正常加载 UI。
//
// 图标/类型等"OS 展示元数据"仍走 Normalize Layer：
//   契约 schema.icon 要求 /^\\/apps// 的 URL，与 OS 命名图标体系（osIcon.js）不兼容，
//   故 manifest 不带 icon，这里用 ICON_BY_ID 把 registry id 映射到命名图标。
// ============================================================================
import { BUILTIN_APPS } from "./builtinApps.js";
import { emit } from "./osBus.js";

const APPS_ENDPOINT = "/api/apps";

/** 归一化后的统一形状 */
// {
//   id, name, desc, icon, entry, source: 'builtin' | 'registry',
//   version, state, capabilities: [{ id, risk, title }], permissions: string[],
//   kind, singleton: boolean,
//   keepAliveMode: 'always' | 'session' | 'ephemeral',   // ★ 唯一真实保活字段
//   keepAliveOnWindowClose: boolean                        // ★ 派生：keepAliveMode !== 'ephemeral'
// }

function normalizeBuiltin(app) {
  // Phase 4：builtinApps.js 条目无 singleton / keepAlive，这里补默认。
  // keepAliveMode 是唯一真实字段（与后端 schema 枚举对齐）；keepAliveOnWindowClose 仅派生。
  const keepAliveMode = app.keepAliveMode || "session";
  return {
    id: app.id,
    name: app.name || app.id,
    desc: app.desc || "",
    icon: app.icon || "grid",
    entry: app.entry || null,
    source: "builtin",
    version: "builtin",
    state: "healthy",
    capabilities: [],
    permissions: Array.isArray(app.permissions) ? app.permissions : [],
    kind: app.kind || "app",
    singleton: app.singleton !== false, // 默认 true
    keepAliveMode,
    keepAliveOnWindowClose: keepAliveMode !== "ephemeral",
  };
}

// OS 展示元数据：registry id → 命名图标（osIcon.js 仅接受命名图标，
// 不接受 /apps/... URL，故 icon 不来自 manifest，而在此映射）。
const ICON_BY_ID = {
  chat: "chat",
  "image-generation": "image",
  "infinite-canvas": "canvas",
  assets: "grid",
};

function normalizeRemote(app) {
  // 后端 list_apps 现已返回 entry / keepAlive / singleton / permissions / description，
  // 这里直接采用真实值；缺失时回安全默认。
  const keepAliveMode = app.keepAlive || "session";
  return {
    id: app.id,
    name: app.title || app.id,
    desc: app.description || "",
    icon: ICON_BY_ID[app.id] || app.icon || "grid",
    entry: app.entry || null, // 后端已解析为 /apps/<id>/<entry> 可直连 URL
    source: "registry",
    version: String(app.version || "0.0.0"),
    state: app.state || "unknown",
    capabilities: Array.isArray(app.capabilities) ? app.capabilities : [],
    permissions: Array.isArray(app.permissions) ? app.permissions : [],
    kind: "app",
    singleton: app.singleton !== false,
    keepAliveMode,
    keepAliveOnWindowClose: keepAliveMode !== "ephemeral",
  };
}

/**
 * 合并：内置在前，远程覆盖同 id。
 * @param {Array} builtin
 * @param {Array} remote
 * @returns {Array} 按 id 升序稳定排序
 */
export function mergeApps(builtin, remote) {
  const map = new Map();
  for (const app of builtin) map.set(app.id, app);
  for (const app of remote) map.set(app.id, app); // 远程优先覆盖
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

let cache = [];
let remoteRaw = [];
let loadError = null;

async function fetchRemoteApps() {
  const res = await fetch(APPS_ENDPOINT, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${APPS_ENDPOINT} → ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data && Array.isArray(data.apps) ? data.apps : [];
  return list;
}

/**
 * 加载并合并 App 清单；加载完成后 emit('apps:loaded')。
 * 后端不可用时降级为"仅内置"，不抛错（保证桌面仍可用）。
 * @returns {Promise<Array>}
 */
export async function loadApps() {
  const builtin = BUILTIN_APPS.map(normalizeBuiltin);
  try {
    remoteRaw = await fetchRemoteApps();
    loadError = null;
  } catch (err) {
    remoteRaw = [];
    loadError = err;
    console.warn("[osAppRegistry] 后端 /api/apps 不可用，降级为仅内置 App", err);
  }
  cache = mergeApps(builtin, remoteRaw.map(normalizeRemote));
  emit("apps:loaded", {
    apps: cache,
    builtinCount: builtin.length,
    remoteCount: remoteRaw.length,
    error: loadError ? String(loadError.message || loadError) : null,
  });
  return cache;
}

/** 当前合并结果（未加载则返回空数组） */
export function getApps() {
  return cache;
}

/** 按 id 取 App */
export function getApp(id) {
  return cache.find((a) => a.id === id) || null;
}

/** 诊断信息：给验收/Shell 展示用 */
export function getDiagnostics() {
  return {
    total: cache.length,
    builtin: cache.filter((a) => a.source === "builtin").length,
    registry: cache.filter((a) => a.source === "registry").length,
    remoteRaw: remoteRaw.length,
    error: loadError ? String(loadError.message || loadError) : null,
  };
}

export default { loadApps, getApps, getApp, mergeApps, getDiagnostics };
