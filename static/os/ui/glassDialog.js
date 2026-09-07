// ============================================================================
// NOVAI OS · Glass Dialog (glassDialog.js)
// 模态：遮罩（深色 + ambient blur 让背后 wallpaper 模糊）+ 内容 + 入场 spring
// 大圆角玻璃面板，靠材质与多层阴影悬浮，hover sheen 由 os-glass.css 提供
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js + os-glass.css
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-dialog-style";
const CSS = `
.os-dialog-overlay {
  position: fixed; inset: 0; z-index: var(--z-dialog);
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  -webkit-backdrop-filter: blur(24px) saturate(120%);
  backdrop-filter: blur(24px) saturate(120%);
  animation: os-fade-in var(--motion-normal) var(--ease-standard) both;
}
.os-dialog { min-width: 360px; max-width: 92vw; padding: 26px; }
.os-dialog__title { font-family: var(--font-system); font-size: 17px; font-weight: 600; color: var(--text-primary); margin: 0 0 10px; }
.os-dialog__body { font-family: var(--font-system); font-size: 14px; line-height: 1.55; color: var(--text-secondary); }
.os-dialog__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
.os-dialog__btn {
  appearance: none; border: 0; cursor: pointer;
  font-family: var(--font-system); font-size: 14px; font-weight: 600;
  padding: 10px 20px; border-radius: var(--radius-pill);
  background: var(--surface-tertiary); color: var(--text-primary);
  transition: background var(--motion-fast) var(--ease-standard),
              transform var(--motion-fast) var(--ease-spring);
}
.os-dialog__btn:hover { background: var(--interactive-secondary); transform: translateY(-1px); }
.os-dialog__btn:active { transform: scale(0.97); }
.os-dialog__btn.is-primary { background: var(--interactive-primary); color: var(--text-on-interactive-primary); }
.os-dialog__btn.is-primary:hover { background: var(--interactive-primary-hover); }
.os-dialog__btn:focus-visible { outline: none; transform: translateY(-1px); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassDialog({
  title = "",
  body = "",
  actions = [],
  tier = "thick",
} = {}) {
  ensureStyle();
  const overlay = document.createElement("div");
  overlay.className = "os-dialog-overlay";

  const dialog = createGlassSurface({ tier, variant: "dialog", className: "os-dialog os-anim-scale-in" });

  const titleEl = document.createElement("h2");
  titleEl.className = "os-dialog__title";
  titleEl.textContent = title;

  const bodyEl = document.createElement("div");
  bodyEl.className = "os-dialog__body";
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);

  const actionsEl = document.createElement("div");
  actionsEl.className = "os-dialog__actions";
  actions.forEach((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "os-dialog__btn" + (a.primary ? " is-primary" : "");
    b.textContent = a.label;
    b.addEventListener("click", () => {
      if (a.onClick) a.onClick(close);
      else close();
    });
    actionsEl.appendChild(b);
  });

  const inner = document.createElement("div");
  inner.appendChild(titleEl);
  inner.appendChild(bodyEl);
  if (actions.length) inner.appendChild(actionsEl);
  dialog.setContent(inner);

  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  overlay.setAttribute("role", "presentation");

  overlay.appendChild(dialog);

  function cleanup() {
    document.removeEventListener("keydown", onKey);
  }
  function close() {
    cleanup();
    overlay.remove();
  }
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const focusTarget = dialog.querySelector("button") || dialog;
  focusTarget.focus();

  return { overlay, dialog, close };
}

export default createGlassDialog;
