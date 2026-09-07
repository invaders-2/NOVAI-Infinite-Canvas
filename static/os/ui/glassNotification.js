// ============================================================================
// NOVAI OS · Glass Notification (glassNotification.js)
// 通知条：title / message / 可选 action；自动滑入。返回 { node, dismiss }
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-notification-style";
const CSS = `
.os-notification { min-width: 280px; max-width: 360px; padding: 14px 16px; z-index: var(--z-notification); }
.os-notification__title { font-family: var(--font-system); font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0 0 4px; }
.os-notification__msg { font-family: var(--font-system); font-size: 13px; line-height: 1.45; color: var(--text-secondary); }
.os-notification__dot { position: absolute; top: 14px; right: 14px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassNotification({
  title = "",
  message = "",
  tier = "regular",
  duration = 4000,
} = {}) {
  ensureStyle();
  const surface = createGlassSurface({ tier, variant: "notification", className: "os-notification os-anim-slide-up" });

  const titleEl = document.createElement("div");
  titleEl.className = "os-notification__title";
  titleEl.textContent = title;

  const msgEl = document.createElement("div");
  msgEl.className = "os-notification__msg";
  msgEl.textContent = message;

  const inner = document.createElement("div");
  inner.appendChild(titleEl);
  if (message) inner.appendChild(msgEl);
  surface.setContent(inner);

  const dot = document.createElement("div");
  dot.className = "os-notification__dot";
  surface.appendChild(dot);

  let timer = null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    surface.remove();
  }
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { node: surface, dismiss };
}

export default createGlassNotification;
