// ============================================================================
// NOVAI OS · Glass Notification (glassNotification.js)
// 通知条：title / message / 状态点；spring 滑入（来自 os-motion.css）
// sheen 来自 os-glass.css 的 .os-glass::after
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js + os-glass.css
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-notification-style";
const CSS = `
.os-notification {
  min-width: 300px; max-width: 380px;
  padding: 16px 44px 16px 18px;
  z-index: var(--z-notification);
}
.os-notification__title {
  font-family: var(--font-system); font-size: 14px; font-weight: 600;
  color: var(--text-primary); margin: 0 0 4px;
}
.os-notification__msg {
  font-family: var(--font-system); font-size: 13px; line-height: 1.5;
  color: var(--text-secondary);
}
.os-notification__dot {
  position: absolute; top: 20px; right: 18px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--interactive-primary);
}
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
  const surface = createGlassSurface({
    tier,
    variant: "notification",
    className: "os-notification os-anim-slide-up",
  });

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
