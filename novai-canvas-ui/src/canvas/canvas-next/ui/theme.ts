import type { CanvasStore } from "../store";

/**
 * NOVAI 宿主（static/canvas.html）在启动时打上这个标记：画布是软件里的一个子页面，
 * 没有自己的深浅色偏好，始终跟随软件主题。
 */
const HOST_FLAG = "__novaiCanvasHost";

export function followsShellTheme(): boolean {
  try { return Boolean((window as unknown as Record<string, { followTheme?: boolean } | undefined>)[HOST_FLAG]?.followTheme); } catch { return false; }
}

/**
 * 外壳把解析好的深浅色写在 html[data-shell-theme]。比 class 可靠：
 * 浅色时那套 dark / theme-dark class 一个都不在，光看 class 会误判成「没有外壳 → 问系统」。
 */
function shellThemeAttr(): "dark" | "light" | null {
  const value = document.documentElement.dataset.shellTheme;
  return value === "dark" || value === "light" ? value : null;
}

const DARK_CLASSES = ["dark", "theme-dark", "studio-theme-dark"];
const isDarkEl = (el: Element | null) => !!el && DARK_CLASSES.some((name) => el.classList.contains(name));

/**
 * 桌面版外壳的深浅色。两个外壳（旧 index.html / Vue）都切 html 上的 class，
 * 独立桌面应用切根节点 .desktop 的 .dark，<html> 上不挂 class，所以几处都看；
 * 没有外壳（独立页 / 探针）时退回系统偏好。
 */
export function shellDark() {
  const attr = shellThemeAttr();
  if (attr) return attr === "dark";
  if (isDarkEl(document.documentElement)) return true;
  const root = document.querySelector(".desktop");
  // 外壳在跑：跟随系统也由外壳自己解析成 class，这里只认外壳的结果
  if (root) return isDarkEl(root);
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 把外壳主题写到 <html>：三个外壳各认一套 class，data-shell-theme 是本模块的权威值 */
export function applyShellTheme(theme: "dark" | "light") {
  const dark = theme === "dark";
  const html = document.documentElement;
  for (const name of DARK_CLASSES) html.classList.toggle(name, dark);
  html.dataset.shellTheme = theme;
}

/** 画布里的主题入口（设置菜单 / 右下角按钮 / ⇧⌘L）：NOVAI 宿主下要改的是软件主题，不是画布自己的偏好 */
export function requestShellTheme(theme: "dark" | "light") {
  try {
    localStorage.setItem("studio_theme", theme);
    localStorage.setItem("canvas_theme", theme);
  } catch { /* 无存储时仍然按本次选择渲染 */ }
  applyShellTheme(theme);
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: "studio-theme", theme }, location.origin);
  } catch { /* 没有外壳 */ }
}

/** 深色 / 浅色 / 跟随系统：写到 [data-theme]，CSS 变量随之切换 */
export function applyTheme(store: CanvasStore) {
  // NOVAI 宿主里没有「画布自己的主题偏好」：localStorage 的 novai-canvas-theme 不参与解析
  const pref = followsShellTheme() ? "system" : store.state.ui.themePref;
  const t = pref === "system" ? (shellDark() ? "dark" : "light") : pref;
  if (store.state.ui.theme !== t) store.setUI({ theme: t });
}

export function watchSystemTheme(store: CanvasStore) {
  const mq = matchMedia("(prefers-color-scheme: light)");
  const on = () => { if (followsShellTheme() || store.state.ui.themePref === "system") applyTheme(store); };
  mq.addEventListener?.("change", on);
  const observers: MutationObserver[] = [];
  const watch = (el: Element | null) => {
    if (!el) return;
    const mo = new MutationObserver(on);
    mo.observe(el, { attributes: true, attributeFilter: ["class", "data-shell-theme"] });
    observers.push(mo);
  };
  // NOVAI 宿主 / Vue 外壳：深浅色切在 <html> 上，只观察 .desktop 会漏掉运行中的切换
  watch(document.documentElement);
  // 独立桌面应用：外壳把 .dark 挂在根节点 .desktop 上，不会重传 props
  watch(document.querySelector(".desktop"));
  return () => { mq.removeEventListener?.("change", on); observers.forEach((mo) => mo.disconnect()); };
}
