// ============================================================================
// NOVAI OS · Glass Icon Button (glassIconButton.js)
// 纯图标按钮。硬性规则：
//   0 visible border / 0 hairline / 0 outline / 0 focus ring / 0 container stroke
// 状态只通过 surface 明度、brightness、opacity、材质与 micro scale 表达，
// 不允许让用户感觉"图标被框在一个小框里"。
//
// 尺寸体系（来自 Icon System，不制造 17/21/23/27 这类尺寸）：
//   sm = 28px 容器 / 16px 图标      md = 32px 容器 / 18px 图标
//   lg = 40px 容器 / 20px 图标      xl = 48px 容器 / 24px 图标
// 图标一律走 osIcon.js（统一线性 stroke），颜色走 --icon-* Token。
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";
import { createIcon } from "../icons/osIcon.js";

const STYLE_ID = "os-glass-icon-button-style";

const SIZES = {
  sm: { box: 28, icon: 16 },
  md: { box: 32, icon: 18 },
  lg: { box: 40, icon: 20 },
  xl: { box: 48, icon: 24 },
};

const CSS = `
.os-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
  border: 0 !important; outline: none; padding: 0;
  background: transparent; cursor: pointer;
  color: var(--icon-secondary, var(--text-secondary));
  /* 容器无任何描边；默认状态表面几乎不可见 */
  transition: background var(--motion-normal, 240ms) var(--ease-material, cubic-bezier(.2,0,.2,1)),
              color var(--motion-fast, 160ms) var(--ease-material, cubic-bezier(.2,0,.2,1)),
              transform var(--motion-normal, 240ms) var(--ease-material, cubic-bezier(.2,0,.2,1)),
              box-shadow var(--motion-normal, 240ms) var(--ease-material, cubic-bezier(.2,0,.2,1)),
              opacity var(--motion-fast, 160ms) var(--ease-standard);
}
.os-icon-btn .os-glass__bg { background: transparent; }
.os-icon-btn .os-glass__content {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%;
}
.os-icon-btn svg { display: block; }

/* hover：表面材质浮现（明度），不是描边 */
.os-icon-btn:hover .os-glass__bg { background: var(--interactive-secondary); }
.os-icon-btn:hover { color: var(--icon-primary, var(--text-primary)); transform: scale(1.06); }
/* active：轻微压下，不 bounce */
.os-icon-btn:active { transform: scale(0.94); transition-duration: var(--motion-instant, 100ms); }
/* focus-visible：无任何 ring / outline，只做极轻材质浮现 */
.os-icon-btn:focus-visible { outline: none; box-shadow: none; }
.os-icon-btn:focus-visible .os-glass__bg { background: var(--interactive-secondary); }
.os-icon-btn:focus-visible { color: var(--icon-primary, var(--text-primary)); }

/* selected：材质加深（--surface-active），不是线框 */
.os-icon-btn.is-selected .os-glass__bg { background: var(--surface-active); }
.os-icon-btn.is-selected { color: var(--icon-primary, var(--text-primary)); }

.os-icon-btn--disabled { opacity: 0.4; pointer-events: none; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * 创建 Icon Button。
 * @param {Object} options
 * @param {string} [options.icon='close'] osIcon.js 中的图标名
 * @param {('sm'|'md'|'lg'|'xl')} [options.size='md'] 尺寸档位
 * @param {string} [options.label] 无障碍名称（写入 aria-label，不渲染文字）
 * @param {boolean} [options.selected=false]
 * @param {boolean} [options.disabled=false]
 * @param {Function|null} [options.onClick]
 * @returns {HTMLButtonElement}
 */
export function createGlassIconButton({
  icon = "close",
  size = "md",
  label = "",
  selected = false,
  disabled = false,
  onClick = null,
} = {}) {
  ensureStyle();
  const spec = SIZES[size] || SIZES.md;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "os-icon-btn";
  btn.style.width = `${spec.box}px`;
  btn.style.height = `${spec.box}px`;
  btn.style.borderRadius = "var(--radius-pill)";
  if (label) btn.setAttribute("aria-label", label);
  if (selected) btn.classList.add("is-selected");
  if (disabled) {
    btn.disabled = true;
    btn.classList.add("os-icon-btn--disabled");
  }
  if (onClick) btn.addEventListener("click", onClick);

  btn.appendChild(createIcon({ name: icon, size: spec.icon, color: "currentColor" }));

  /** 切换 selected（材质表达，非描边） */
  btn.setSelected = (next) => {
    btn.classList.toggle("is-selected", !!next);
    return btn;
  };
  /** 更换图标（保持统一线性风格） */
  btn.setIcon = (name) => {
    btn.innerHTML = "";
    btn.appendChild(createIcon({ name, size: spec.icon, color: "currentColor" }));
    return btn;
  };
  return btn;
}

export default createGlassIconButton;
