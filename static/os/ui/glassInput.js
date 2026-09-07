// ============================================================================
// NOVAI OS · Glass Input (glassInput.js)
// 文本输入：嵌进玻璃表面（下凹 inset shadow，材质表达，非边框）
// focus：下凹加深 + 内部 ambient 提亮 + 中性柔和 glow（无青柠 focus ring、无常驻 1px 描边）
// 字体：--font-system（D4=B）
// 依赖：glassSurface.js
// ============================================================================
import { createGlassSurface } from "./glassSurface.js";

const STYLE_ID = "os-glass-input-style";
const CSS = `
.os-input {
  display: block; min-width: 220px;
  /* 嵌进玻璃：内阴影下凹（材质表达，非等宽边框） */
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.10),
    inset 0 -1px 0 rgba(255, 255, 255, 0.04);
  transition: box-shadow var(--motion-normal) var(--ease-standard),
              background var(--motion-normal) var(--ease-standard);
}
.os-input__native {
  appearance: none; -webkit-appearance: none;
  margin: 0; border: 0; background: transparent; width: 100%;
  font-family: var(--font-system); font-size: 14px; line-height: 1.4;
  color: var(--text-primary);
  padding: 11px 16px; border-radius: inherit;
}
.os-input__native::placeholder { color: var(--text-tertiary); }
.os-input__native:focus { outline: none; }
/* focus：下凹加深 + 内部 ambient 提亮 + 中性柔和 glow */
.os-input.is-focused {
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.14),
    inset 0 -1px 0 rgba(255, 255, 255, 0.06),
    0 0 0 3px var(--focus-neutral);
}
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
