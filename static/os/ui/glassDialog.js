// ============================================================================
// NOVAI OS · Glass Dialog (glassDialog.js)
// 模态：遮罩 + 内容 + 入场动画（scale-in）。返回 { overlay, dialog, close }
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-dialog-style";
const CSS = `
.os-dialog-overlay {
  position: fixed; inset: 0; z-index: var(--z-dialog);
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.32);
  animation: os-fade-in var(--motion-fast) var(--ease-standard) both;
}
.os-dialog { min-width: 320px; max-width: 92vw; padding: 22px; }
.os-dialog__title { font-family: var(--font-system); font-size: 17px; font-weight: 600; color: var(--text-primary); margin: 0 0 10px; }
.os-dialog__body { font-family: var(--font-system); font-size: 14px; line-height: 1.55; color: var(--text-secondary); }
.os-dialog__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
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
  tier = "regular",
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
    if (a.onClick) b.addEventListener("click", () => a.onClick(close));
    actionsEl.appendChild(b);
  });

  const inner = document.createElement("div");
  inner.appendChild(titleEl);
  inner.appendChild(bodyEl);
  if (actions.length) inner.appendChild(actionsEl);
  dialog.setContent(inner);

  overlay.appendChild(dialog);

  function close() {
    overlay.remove();
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  return { overlay, dialog, close };
}

export default createGlassDialog;
