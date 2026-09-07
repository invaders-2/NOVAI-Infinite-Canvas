// ============================================================================
// NOVAI OS · Theme Runtime (themeRuntime.js)
// 新增独立模块（不修改 legacy theme.js）。三态：light / dark / system。
// system 由 CSS @media (prefers-color-scheme) 解析视觉；本模块仅设置 data-os-theme
// 并维护 data-os-resolved 供 JS 读取实际态。matchMedia 实时响应系统外观变化。
// 字体：--font-system 为默认；--font-display 不进入 OS 组件（D4=B）
// ============================================================================

export const THEMES = ["light", "dark", "system"];

const mql = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(theme) {
  if (theme === "system") return mql.matches ? "dark" : "light";
  return theme;
}

/**
 * 初始化主题运行时。
 * @param {Object} options
 * @param {('light'|'dark'|'system')} [options.initial='system']
 * @param {(state:{theme:string,resolved:string})=>void} [options.onChange]
 * @returns {{setTheme, getTheme, getResolved, THEMES}}
 */
export function initThemeRuntime({ initial = "system", onChange = null } = {}) {
  const root = document.documentElement;

  function apply(theme) {
    root.setAttribute("data-os-theme", theme);
    const resolved = resolve(theme);
    root.setAttribute("data-os-resolved", resolved);
    if (onChange) onChange({ theme, resolved });
  }

  function setTheme(theme) {
    if (!THEMES.includes(theme)) return;
    apply(theme);
  }

  function getTheme() {
    return root.getAttribute("data-os-theme") || "system";
  }

  function getResolved() {
    return resolve(getTheme());
  }

  // 系统外观变化且当前为 system 时，实时重算 resolved
  const onSystemChange = () => {
    if (getTheme() === "system") apply("system");
  };
  if (mql.addEventListener) mql.addEventListener("change", onSystemChange);
  else if (mql.addListener) mql.addListener(onSystemChange); // 旧浏览器回退

  apply(initial);

  return { setTheme, getTheme, getResolved, THEMES };
}

export default initThemeRuntime;
