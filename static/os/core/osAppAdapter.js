// ============================================================================
// NOVAI OS · App Adapter (osAppAdapter.js)
// Phase 4 仅实现 IframeAppAdapter。
//
// iframe 生命周期归 WM / Frame 所有（Minimize 保留、Close 释放），**不做 stash**。
// 本 Adapter 负责：entry/权限 sanity + 产出 WindowSpec。
// 同时**预留** suspend/resume/serializeState/restoreState 与能力声明，
// 供 Phase 5 按 App 能力逐个落地状态恢复（不依赖隐藏 iframe hack）。
// ============================================================================

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
     * entry / 权限 sanity。UI App 必须有 entry。
     * @param {Object} def AppDefinition
     * @returns {{ok:boolean, error?:{code:string, message:string}}}
     */
    prepare(def) {
      if (!def) return { ok: false, error: { code: "NO_DEF", message: "AppDefinition 缺失" } };
      if (def.entry == null) {
        return { ok: false, error: { code: "NO_ENTRY", message: "App 无 UI entry（能力型）" } };
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
