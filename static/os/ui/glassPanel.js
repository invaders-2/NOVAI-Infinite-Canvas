// ============================================================================
// NOVAI OS · Glass Panel / Card (glassPanel.js)
// 通用容器：承载任意内容；玻璃主体保持中性（D3=C）
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js + os-glass.css（4 档 thickness 真实差异 + interactive hover-lift + sheen）
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-panel-style";
const CSS = `
.os-panel { display: block; }
.os-panel__head {
  font-family: var(--font-system); font-size: 12px; font-weight: 600;
  color: var(--text-secondary); letter-spacing: 0.08em;
  padding: 0 4px 12px; text-transform: uppercase;
}
.os-panel__body { font-family: var(--font-system); color: var(--text-primary); font-size: 14px; line-height: 1.55; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassPanel({
  title = "",
  content = null,
  tier = "regular",
  padding = 22,
  interactive = true,
} = {}) {
  ensureStyle();
  const surface = createGlassSurface({
    tier,
    variant: "panel",
    className: "os-panel",
  });
  if (interactive) surface.classList.add("os-glass--interactive"); /* hover 抬起 + sheen */
  surface.style.padding = `${padding}px`;

  const body = document.createElement("div");
  body.className = "os-panel__body";
  if (content) {
    if (typeof content === "string") body.innerHTML = content;
    else if (content instanceof Node) body.appendChild(content);
  }

  if (title) {
    const head = document.createElement("div");
    head.className = "os-panel__head";
    head.textContent = title;
    surface.setContent(head);
    surface.querySelector(".os-glass__content").appendChild(body);
  } else {
    surface.setContent(body);
  }

  surface.setBody = (node) => {
    body.innerHTML = "";
    if (node instanceof Node) body.appendChild(node);
    else if (typeof node === "string") body.innerHTML = node;
    return surface;
  };
  return surface;
}

export default createGlassPanel;
