// ============================================================================
// NOVAI OS · Desktop Icon (osDesktopIcon.js)
// 桌面图标：统一线性图标（48）+ 中性文字标签。
// 0 border / 0 hairline / 0 outline / 0 focus ring；hover 与 selected 只靠材质。
// 颜色一律走 --icon-* Token，不使用青柠（青柠仅 Send / AI 光效）。
// ============================================================================
import { createIcon } from "../icons/osIcon.js";

/**
 * @param {Object} options
 * @param {Object} options.app 归一化后的 App 描述符
 * @param {(app: Object) => void} [options.onActivate]
 * @returns {HTMLButtonElement}
 */
export function createDesktopIcon({ app, onActivate } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "os-dicon";
  btn.dataset.appId = app.id;
  btn.setAttribute("aria-label", app.name);
  if (app.desc) btn.title = app.desc;

  const glyph = document.createElement("span");
  glyph.className = "os-dicon__glyph";
  glyph.appendChild(createIcon({ name: app.icon, size: 48, color: "var(--icon-secondary)" }));
  btn.appendChild(glyph);

  const label = document.createElement("span");
  label.className = "os-dicon__label";
  label.textContent = app.name;
  btn.appendChild(label);

  if (app.source === "registry") {
    const badge = document.createElement("span");
    badge.className = "os-dicon__badge";
    badge.textContent = "registry";
    btn.appendChild(badge);
  }

  btn.addEventListener("click", () => {
    if (typeof onActivate === "function") onActivate(app);
  });

  return btn;
}

export default createDesktopIcon;
