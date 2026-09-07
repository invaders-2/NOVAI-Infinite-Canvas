// ============================================================================
// NOVAI OS · Glass Context Menu (glassContextMenu.js)
// 右键菜单：items=[{label,onClick,danger?,separator?}]
// subtle 玻璃 + item hover 用 surface 变化（材质，非边框）
// separator 用 gradient（不是等宽 1px solid）
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js + os-glass.css（提供 ::after sheen on hover）
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-contextmenu-style";
const CSS = `
.os-context-menu { min-width: 200px; padding: 6px; z-index: var(--z-menu); }
.os-context-menu__item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: var(--font-system); font-size: 13px; color: var(--text-primary);
  background: transparent; border: 0; text-align: left; cursor: pointer;
  padding: 8px 12px; border-radius: var(--radius-sm);
  transition: background var(--motion-fast) var(--ease-standard);
}
.os-context-menu__item:hover { background: var(--surface-tertiary); }
.os-context-menu__item:focus-visible { outline: none; background: var(--surface-tertiary); }
.os-context-menu__item.is-danger { color: var(--semantic-danger); }
.os-context-menu__item.is-danger:hover { background: rgba(255, 59, 48, 0.12); }
/* separator 用材质渐变（非等宽 1px solid） */
.os-context-menu__sep {
  height: 1px; margin: 6px 8px;
  background: linear-gradient(90deg, transparent, var(--border-subtle), transparent);
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassContextMenu({ items = [], x = 0, y = 0, tier = "thin" } = {}) {
  ensureStyle();
  const surface = createGlassSurface({ tier, variant: "menu", className: "os-context-menu" });
  surface.style.position = "fixed";
  surface.style.left = `${x}px`;
  surface.style.top = `${y}px`;

  const list = document.createElement("div");
  list.className = "os-context-menu__list";
  items.forEach((it) => {
    if (it.separator) {
      const sep = document.createElement("div");
      sep.className = "os-context-menu__sep";
      list.appendChild(sep);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "os-context-menu__item" + (it.danger ? " is-danger" : "");
    btn.textContent = it.label;
    if (it.onClick) btn.addEventListener("click", () => it.onClick());
    list.appendChild(btn);
  });
  surface.setContent(list);

  const firstBtn = list.querySelector("button");
  if (firstBtn) firstBtn.focus();
  const onKey = (e) => {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      surface.remove();
    }
  };
  document.addEventListener("keydown", onKey);

  return surface;
}

export default createGlassContextMenu;
