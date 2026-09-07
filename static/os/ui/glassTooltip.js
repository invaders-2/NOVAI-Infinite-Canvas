// ============================================================================
// NOVAI OS · Glass Tooltip (glassTooltip.js)
// 轻量提示气泡。返回节点，由调用方定位（absolute/fixed）
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-tooltip-style";
const CSS = `
.os-tooltip { padding: 6px 10px; z-index: var(--z-menu); pointer-events: none; }
.os-tooltip__text { font-family: var(--font-system); font-size: 12px; color: var(--text-primary); white-space: nowrap; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassTooltip({ text = "", tier = "ultraThin" } = {}) {
  ensureStyle();
  const surface = createGlassSurface({ tier, variant: "tooltip", className: "os-tooltip os-anim-fade-in" });
  const t = document.createElement("span");
  t.className = "os-tooltip__text";
  t.textContent = text;
  surface.setContent(t);
  return surface;
}

export default createGlassTooltip;
