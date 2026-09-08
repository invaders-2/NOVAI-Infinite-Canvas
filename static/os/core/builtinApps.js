// ============================================================================
// NOVAI OS · Built-in First-party App Descriptors (builtinApps.js)
// ⛔ 迁移期临时方案（Phase 2）
//
// 职责：只保存 Phase 2 的内置第一方 App 描述符，不含任何逻辑。
// 合并 / normalize / 输出 一律由 osAppRegistry.js 负责。
//
// 迁移约定：
//   Phase 5 第一方 App 真正 manifest / adapter 化后，应逐步移除本文件中
//   对应的临时描述符（每迁移一个，删一条，并在 CHANGE 注释中记录）。
//
// 已确认的正式基线（D2）：
//   NOVAI OS 正式无限画布基础 = smart-canvas
//   → infinite-canvas entry 必须是 /static/smart-canvas.html
//   → /static/canvas.html 继续视为 Legacy，不作为第一方 App entry
//
// 已确认的收敛方向（D5）：
//   online / zimage / enhance / klein 最终只有一个用户可见的 image-generation App。
//   → Phase 2 只暴露 image-generation，不把它们拆成四个 Desktop App。
//
// home.html 不作为普通业务 App（当前不承担独立 App 能力）。
// ============================================================================

/**
 * 内置第一方 App 描述符。
 * 字段说明：
 *   id        App 唯一 id（小写连字符）
 *   name      显示名
 *   desc      简述（Launcher / Desktop Icon tooltip 用）
 *   icon      osIcon.js 中的图标名（统一线性 stroke）
 *   entry     可嵌入 iframe 的 URL；null 表示暂无 UI entry（能力型）
 *   kind      分类标签，仅用于 Launcher 分组展示
 */
export const BUILTIN_APPS = [
  {
    id: "image-generation",
    name: "Image Generation",
    desc: "图像生成 · 统一的图像创作入口",
    icon: "image",
    entry: "/static/online.html",
    kind: "create",
  },
  {
    // D2 已确认：正式无限画布基础 = smart-canvas
    id: "infinite-canvas",
    name: "Infinite Canvas",
    desc: "无限画布 · 基于 smart-canvas",
    icon: "canvas",
    entry: "/static/smart-canvas.html",
    kind: "create",
  },
  {
    id: "assets",
    name: "Assets",
    desc: "素材库管理",
    icon: "grid",
    entry: "/static/asset-manager.html",
    kind: "library",
  },
  {
    id: "chat",
    name: "Chat",
    desc: "对话助手",
    icon: "chat",
    entry: "/static/gpt-chat.html",
    kind: "assistant",
  },
  {
    id: "api-settings",
    name: "API Settings",
    desc: "接口与凭据设置",
    icon: "settings",
    entry: "/static/api-settings.html",
    kind: "settings",
  },
  {
    // 现有真实工作流设置入口 = comfyui-settings.html
    // （index.html 侧边栏 i18n key: common.comfyuiSettings = "工作流设置"）
    id: "workflow-settings",
    name: "Workflow Settings",
    desc: "工作流设置 · 后端与节点配置",
    icon: "workflow",
    entry: "/static/comfyui-settings.html",
    kind: "settings",
  },
];

export default BUILTIN_APPS;
