// ============================================================================
// NOVAI OS · Glass Input (glassInput.js)
// 文本输入：focus 用中性 glow + surface 提亮；无青柠 focus ring、无常驻 1px 描边
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-input-style";
const CSS = `
.os-input {
  display: block; min-width: 220px;
  transition: box-shadow var(--motion-fast) var(--ease-standard);
}
.os-input__native {
  appearance: none; -webkit-appearance: none;
  margin: 0; border: 0; background: transparent; width: 100%;
  font-family: var(--font-system); font-size: 14px; line-height: 1.4;
  color: var(--text-primary);
  padding: 10px 14px; border-radius: inherit;
}
.os-input__native::placeholder { color: var(--text-tertiary); }
.os-input__native:focus { outline: none; }
/* focus：中性柔和 glow + surface 提亮；无常驻 1px 描边、无青柠 focus ring */
.os-input.is-focused { box-shadow: 0 0 0 3px var(--focus-neutral); }
.os-input.is-focused .os-glass__bg { background: var(--glass-fill-strong); }
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
  tier = "thin",
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
