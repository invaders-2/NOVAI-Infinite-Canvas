// ============================================================================
// NOVAI OS · App Adapter (osAppAdapter.js)
// Phase 4 仅实现 IframeAppAdapter。
//
// iframe 生命周期归 WM / Frame 所有（Minimize 保留、Close 释放），**不做 stash**。
// 本 Adapter 负责：entry 预检（同源 + 可达）+ 产出 WindowSpec。
// 同时**预留** suspend/resume/serializeState/restoreState 与能力声明，
// 供 Phase 5 按 App 能力逐个落地状态恢复（不依赖隐藏 iframe hack）。
//
// ★ Entry Validation（Phase 5 Hardening）
//   prepare() 是**异步 preflight**，必须发生在 Window 创建之前：
//     launch → adapter.prepare → 同源校验 → 可达探测 → ok → createWindowSpec → WM open
//   失败则 Runtime 得不到 spec，不建窗 → app:error → 无幽灵窗口 / 无 ghost Dock。
//   仅校验同源（首方 App 均同源）；优先 HEAD，405 / 501 回退轻量 GET。
//   ⛔ 刻意不依赖 iframe.onerror：那是事后发现，届时空白幽灵窗口已经建出来了。
// ============================================================================

/**
 * 同源判定。首方 App entry 均为同源；跨域 entry 不在本 Phase 支持范围。
 * @param {string} url
 * @returns {boolean}
 */
function isSameOrigin(url) {
  try {
    const u = new URL(String(url), window.location.href);
    return u.origin === window.location.origin;
  } catch (err) {
    return false; // 非法 URL 视为不可达，交给上层落成 ENTRY_UNAVAILABLE
  }
}

/**
 * 探测 entry 可达性：优先 HEAD；405 / 501（方法未实现）回退 GET。
 * 网络层异常（DNS / 断网 / CORS）→ status 0。
 * @param {string} entry
 * @returns {Promise<{ok:boolean, status:number, method:string}>}
 */
async function probeEntry(entry) {
  const init = { credentials: "same-origin", cache: "no-store" };
  let res;
  try {
    res = await fetch(entry, { ...init, method: "HEAD" });
  } catch (err) {
    return { ok: false, status: 0, method: "HEAD" };
  }
  if (res.status === 405 || res.status === 501) {
    try {
      res = await fetch(entry, { ...init, method: "GET" });
    } catch (err) {
      return { ok: false, status: 0, method: "GET" };
    }
    return { ok: res.ok, status: res.status, method: "GET" };
  }
  return { ok: res.ok, status: res.status, method: "HEAD" };
}

/**
 * 创建 IframeAppAdapter。
 * @returns {Object}
 */
export function createIframeAppAdapter() {
  return {
    kind: "iframe",

    // 可选能力声明（Phase 4 全部 false；Phase 5 按 App 能力逐个置 true 并实现对应钩子）
    supportsBackgroundRuntime: false,
    supportsStateRestore: false,

    /**
     * Entry preflight：同源 + 可达校验。UI App 必须有 entry，**且 entry 必须可访问**。
     *
     * ⚠️ 异步：Runtime 必须 await 本方法，且只能在 ok 之后创建 Window。
     *
     * 失败契约（Error Contract）：
     *   { ok:false, error:{ code, message, appId, entry, status } }
     *   - NO_DEF              AppDefinition 缺失
     *   - NO_ENTRY            App 无 UI entry（能力型 App，非错误路径）
     *   - ENTRY_CROSS_ORIGIN  entry 非同源（status 0）
     *   - ENTRY_UNAVAILABLE   entry 不可访问（status = HTTP 状态码；网络异常为 0）
     *
     * @param {Object} def AppDefinition
     * @returns {Promise<{ok:boolean, error?:{code:string, message:string, appId?:string, entry?:string, status?:number}}>}
     */
    async prepare(def) {
      if (!def) {
        return { ok: false, error: { code: "NO_DEF", message: "AppDefinition 缺失" } };
      }
      if (def.entry == null) {
        return { ok: false, error: { code: "NO_ENTRY", message: "App 无 UI entry（能力型）" } };
      }

      const entry = String(def.entry);

      if (!isSameOrigin(entry)) {
        return {
          ok: false,
          error: {
            code: "ENTRY_CROSS_ORIGIN",
            message: "entry 非同源，当前 Phase 不支持跨域 App entry",
            appId: def.id,
            entry,
            status: 0,
          },
        };
      }

      const probe = await probeEntry(entry);
      if (!probe.ok) {
        return {
          ok: false,
          error: {
            code: "ENTRY_UNAVAILABLE",
            message: `App entry 不可访问（${probe.method} → ${probe.status || "network-error"}）`,
            appId: def.id,
            entry,
            status: probe.status,
          },
        };
      }

      return { ok: true };
    },

    /**
     * 产出交给 WM 的窗口规格（携带 instanceId）。
     * @param {Object} def
     * @param {Object} instance
     */
    createWindowSpec(def, instance) {
      const size = def.defaultSize || { width: 880, height: 560 };
      return {
        appId: def.id,
        instanceId: instance.instanceId,
        entry: def.entry,
        title: def.name || def.id,
        defaultSize: size,
        minSize: def.minSize || { width: 360, height: 240 },
      };
    },

    // Phase 4：iframe 释放由 WM close → osWindowFrame.destroy() 完成。
    // 此处钩子留空，供 Phase 5 资源清理扩展。
    dispose(/* instance */) {},

    // ↓ 预留能力（Phase 4 空实现；状态恢复走正式 App State Contract，不走隐藏 iframe）
    suspend(/* instance */) {},
    resume(/* instance */) {},
    serializeState(/* instance */) {
      return null;
    },
    restoreState(/* instance, state */) {
      return false;
    },
  };
}

const registry = { iframe: createIframeAppAdapter() };

/**
 * 按 kind 选 Adapter。当前仅 iframe。
 * @param {string} [kind]
 */
export function getAdapter(kind = "iframe") {
  return registry[kind] || registry.iframe;
}

export default { createIframeAppAdapter, getAdapter };
