// ============================================================================
// NOVAI OS · Glass Button (glassButton.js)
// 变体：primary(CTA, 中性) / secondary / ghost / danger
// 字体：--font-system（D4=B）。primary 走 --interactive-primary（中性：Light 黑底白字 / Dark 白底黑字）
// 青柠 --brand-accent 不用于普通按钮，仅保留给 Send Button 与 AI 光效
// 依赖：glassSurface.js + os-glass.css（提供 .os-glass--interactive hover-lift + ::after sheen）
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const VARIANTS = {
  primary: "os-btn--primary",
  secondary: "os-btn--secondary",
  ghost: "os-btn--ghost",
  danger: "os-btn--danger",
};

const STYLE_ID = "os-glass-button-style";
const CSS = `
.os-btn { display: inline-flex; }
.os-btn__native {
  appearance: none; -webkit-appearance: none;
  margin: 0; border: 0; background: transparent;
  font-family: var(--font-system); font-size: 14px; font-weight: 600;
  line-height: 1; color: var(--text-primary);
  padding: 11px 22px; cursor: pointer; width: 100%; height: 100%;
  border-radius: inherit;
  transition: color var(--motion-fast) var(--ease-standard);
}
/* focus：无 outline / 无 focus ring / 无描边；靠材质亮度与阴影深度表达 */
.os-btn__native:focus-visible { outline: none; }
.os-btn:focus-within { box-shadow: var(--glass-shadow-stack-hover, var(--glass-shadow-stack)); }
.os-btn--secondary:focus-within .os-glass__bg,
.os-btn--ghost:focus-within .os-glass__bg { background: var(--surface-tertiary); }

/* primary = 系统主交互（中性：Light 黑底白字 / Dark 白底黑字）
   实色 + sheen 镜面（白底/黑底上都能看到光斑滑过） */
.os-btn--primary .os-btn__native { color: var(--text-on-interactive-primary); }
.os-btn--primary { background: var(--interactive-primary); }
.os-btn--primary .os-glass__bg { background: var(--interactive-primary); }
.os-btn--primary .os-glass__refraction { -webkit-backdrop-filter: none; backdrop-filter: none; opacity: 0.25; }
.os-btn--primary .os-glass__highlight,
.os-btn--primary .os-glass__border { opacity: 0.55; }
.os-btn--primary:hover .os-glass__bg { background: var(--interactive-primary-hover); }
.os-btn--primary:active .os-glass__bg { background: var(--interactive-primary-active); }

/* secondary = 玻璃中性体（带 hover sheen） */
.os-btn--secondary .os-btn__native { color: var(--text-primary); }
.os-btn--secondary:hover .os-glass__bg { background: var(--surface-tertiary); }

/* ghost = 透明玻璃 */
.os-btn--ghost { background: transparent; }
.os-btn--ghost .os-glass__bg { background: transparent; }
.os-btn--ghost .os-btn__native { color: var(--text-secondary); }
.os-btn--ghost:hover .os-glass__bg { background: var(--interactive-secondary); }

/* danger = 语义危险色 */
.os-btn--danger .os-btn__native { color: var(--semantic-danger); }
.os-btn--danger .os-glass__bg { background: var(--interactive-secondary); }
.os-btn--danger:hover .os-glass__bg { background: var(--semantic-danger); }
.os-btn--danger:hover .os-btn__native { color: #ffffff; }

.os-btn--disabled { opacity: 0.45; pointer-events: none; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassButton({
  label = "",
  variant = "primary",
  tier = "regular",
  onClick = null,
  disabled = false,
} = {}) {
  ensureStyle();
  const surface = createGlassSurface({
    tier,
    variant: "button",
    className: "os-btn",
  });
  surface.classList.add("os-glass--interactive"); /* 启用 os-glass.css 的 hover-lift + sheen */
  surface.classList.add(VARIANTS[variant] || VARIANTS.primary);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "os-btn__native";
  btn.textContent = label;
  if (disabled) {
    btn.disabled = true;
    surface.classList.add("os-btn--disabled");
  }
  if (onClick) btn.addEventListener("click", onClick);
  surface.setContent(btn);
  return surface;
}

export default createGlassButton;
