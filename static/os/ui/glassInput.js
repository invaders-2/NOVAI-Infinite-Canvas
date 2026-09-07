// ============================================================================
// NOVAI OS · Glass Input (glassInput.js)
// 输入框 = "嵌入材质中的柔和输入区域"，不是漂浮卡片。
//   - 无 border / 无 outline / 无 focus ring / 无阴影（inset 与外阴影全部去掉）
//   - 状态只靠 surface 明度差：Normal 极轻 → Hover 轻微变化 → Focus 材质加深
//   - 无重 blur、无雾蒙蒙叠层（tier 默认 ultraThin，走 low-haze 默认材质）
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-input-style";
const CSS = `
.os-input {
  display: block; min-width: 220px;
  /* 无阴影：既无 inset 下凹，也无外投影；层级完全由 surface 明度承担 */
  box-shadow: none;
  transition: background var(--motion-normal) var(--ease-material),
              box-shadow var(--motion-normal) var(--ease-material);
}
.os-input .os-glass__bg { background: var(--input-fill); }
.os-input__native {
  appearance: none; -webkit-appearance: none;
  margin: 0; border: 0; background: transparent; width: 100%;
  font-family: var(--font-system); font-size: 14px; line-height: 1.4;
  color: var(--text-primary);
  padding: 11px 16px; border-radius: inherit;
}
.os-input__native::placeholder { color: var(--text-tertiary); }
.os-input__native:focus { outline: none; }
/* hover：轻微亮度变化 */
.os-input:hover .os-glass__bg { background: var(--input-fill-hover); }
/* focus：材质加深（明度差），无 ring / 无 outline / 无阴影 */
.os-input.is-focused .os-glass__bg { background: var(--input-fill-focus); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createGlassInput({
  placeholder = "",
  value = "",
  type = "text",
  tier = "ultraThin", /* 无重 blur：输入区走最薄一档（4px），保持 low-haze */
  onChange = null,
} = {}) {
  ensureStyle();
  const surface = createGlassSurface({
    tier,
    variant: "input",
    className: "os-input",
  });

  const input = document.createElement("input");
  input.type = type;
  input.className = "os-input__native";
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener("focus", () => surface.classList.add("is-focused"));
  input.addEventListener("blur", () => surface.classList.remove("is-focused"));
  if (onChange) input.addEventListener("input", (e) => onChange(e.target.value, e));
  surface.setContent(input);

  surface.getValue = () => input.value;
  surface.setValue = (v) => {
    input.value = v;
    return surface;
  };
  return surface;
}

export default createGlassInput;
