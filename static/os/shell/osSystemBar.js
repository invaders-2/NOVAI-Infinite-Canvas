// ============================================================================
// NOVAI OS · System Bar (osSystemBar.js)
// NOVAI OS 自己的顶部系统区域。**不是** macOS Menu Bar 的复刻。
//
// 只包含：
//   左：NOVAI 字标 + 当前 App 名称
//   右：AI 入口 + Theme Preview Test Entry
//
// 明确不包含：
//   时钟 / 电量 / 网络 / Apple 风格下拉菜单 / 任何多余系统状态
//
// Theme 控件标记为 **Preview-only test entry**，最终迁入 System Settings，
// 不设计为桌面顶部永久主功能。
//
// 字体：--font-system（System Bar 属系统 UI；Space Grotesk 仅品牌/Welcome）
// ============================================================================
import { createGlassSurface } from "../ui/glassSurface.js";
import { createGlassIconButton } from "../ui/glassIconButton.js";
import { THEMES } from "../theme/themeRuntime.js";

/** 无焦点窗口时 System Bar 的"当前 App"空态文案 */
export const IDLE_LABEL = "NOVAI OS";

/**
 * @param {Object} options
 * @param {string} [options.theme] 当前主题
 * @param {(theme: string) => void} [options.onThemeChange]
 * @param {() => void} [options.onAi] AI 入口点击
 * @returns {{ node: HTMLElement, setCurrentApp: Function, setTheme: Function }}
 */
export function createSystemBar({ theme = "system", onThemeChange = null, onAi = null } = {}) {
  const surface = createGlassSurface({ tier: "thick", variant: "system-bar", className: "os-sysbar" });

  const left = document.createElement("div");
  left.className = "os-sysbar__left";

  const brand = document.createElement("span");
  brand.className = "os-sysbar__brand";
  brand.textContent = "NOVAI";
  left.appendChild(brand);

  const sep = document.createElement("span");
  sep.className = "os-sysbar__sep";
  sep.setAttribute("aria-hidden", "true");
  left.appendChild(sep);

  const current = document.createElement("span");
  current.className = "os-sysbar__current";
  current.textContent = IDLE_LABEL;
  left.appendChild(current);

  const right = document.createElement("div");
  right.className = "os-sysbar__right";

  // AI 入口：Idle 中性，不常驻青柠
  const aiBtn = createGlassIconButton({
    icon: "ai",
    size: "md",
    label: "AI Assistant",
    onClick: () => onAi && onAi(),
  });
  aiBtn.classList.add("os-sysbar__ai");
  right.appendChild(aiBtn);

  // Theme —— Preview-only test entry（最终迁入 System Settings）
  const themeWrap = document.createElement("div");
  themeWrap.className = "os-sysbar__theme";
  themeWrap.title = "Preview-only test entry · 最终迁入 System Settings → Appearance";
  themeWrap.setAttribute("data-preview-only", "true");

  const seg = document.createElement("div");
  seg.className = "os-sysbar__seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Theme (preview test entry)");

  const buttons = new Map();
  for (const t of THEMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "os-sysbar__seg-btn";
    b.dataset.theme = t;
    b.textContent = t[0].toUpperCase() + t.slice(1);
    b.addEventListener("click", () => onThemeChange && onThemeChange(t));
    seg.appendChild(b);
    buttons.set(t, b);
  }
  themeWrap.appendChild(seg);
  right.appendChild(themeWrap);

  surface.setContent(left);
  surface.appendChild(right);

  function setTheme(next) {
    for (const [t, b] of buttons) {
      b.classList.toggle("is-active", t === next);
    }
  }

  function setCurrentApp(name) {
    // 空态：无焦点窗口时显示 OS 名，而不是残留上一个 App 名，也不是空白
    current.textContent = name || IDLE_LABEL;
  }

  setTheme(theme);

  return { node: surface, setTheme, setCurrentApp };
}

export default createSystemBar;
