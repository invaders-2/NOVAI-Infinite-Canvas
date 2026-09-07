// ============================================================================
// NOVAI OS · Theme Persistence (themePersistence.js)
// 主题偏好 + Reduced Motion / Transparency 偏好持久化（localStorage）+ 重启恢复。
// 依赖：themeRuntime.js（用于 setTheme / getResolved）
// ============================================================================

const KEYS = {
  theme: "novai-os:theme",
  reduceMotion: "novai-os:reduce-motion",
  reduceTransparency: "novai-os:reduce-transparency",
};

function setAttr(name, on) {
  if (on) document.documentElement.setAttribute(name, "true");
  else document.documentElement.removeAttribute(name);
}

export function saveThemePref(theme) {
  try {
    localStorage.setItem(KEYS.theme, theme);
  } catch (e) {
    /* 隐私模式忽略 */
  }
}

export function loadThemePref() {
  try {
    return localStorage.getItem(KEYS.theme) || "system";
  } catch (e) {
    return "system";
  }
}

export function saveReduceMotion(on) {
  setAttr("data-os-reduce-motion", on);
  try {
    localStorage.setItem(KEYS.reduceMotion, on ? "1" : "0");
  } catch (e) {}
}

export function saveReduceTransparency(on) {
  setAttr("data-os-reduce-transparency", on);
  try {
    localStorage.setItem(KEYS.reduceTransparency, on ? "1" : "0");
  } catch (e) {}
}

export function loadReduceMotion() {
  try {
    return localStorage.getItem(KEYS.reduceMotion) === "1";
  } catch (e) {
    return false;
  }
}

export function loadReduceTransparency() {
  try {
    return localStorage.getItem(KEYS.reduceTransparency) === "1";
  } catch (e) {
    return false;
  }
}

/**
 * 一次性恢复全部偏好并应用到 DOM。
 * @param {Object} [opts]
 * @param {(theme:string)=>void} [opts.onTheme] 收到已恢复的主题（交给 themeRuntime.setTheme）
 */
export function restoreAll({ onTheme = null } = {}) {
  const theme = loadThemePref();
  if (onTheme) onTheme(theme);
  else setAttr("data-os-theme", theme);

  setAttr("data-os-reduce-motion", loadReduceMotion());
  setAttr("data-os-reduce-transparency", loadReduceTransparency());
}

export default {
  saveThemePref,
  loadThemePref,
  saveReduceMotion,
  saveReduceTransparency,
  loadReduceMotion,
  loadReduceTransparency,
  restoreAll,
};
