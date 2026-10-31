import type { CanvasStore } from "../store";

/**
 * 桌面版外壳的深浅色。两个外壳（React / Vue）都把 .dark 挂在根节点 .desktop 上，
 * <html> 上不挂，所以两处都看；没有外壳（独立页 / 探针）时退回系统偏好。
 */
export function shellDark() {
  if (document.documentElement.classList.contains("dark")) return true;
  const root = document.querySelector(".desktop");
  // 外壳在跑：跟随系统也由外壳自己解析成 .dark，这里只认外壳的结果
  return root ? root.classList.contains("dark") : matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 深色 / 浅色 / 跟随系统：写到 [data-theme]，CSS 变量随之切换 */
export function applyTheme(store: CanvasStore) {
  const pref = store.state.ui.themePref;
  const t = pref === "system" ? (shellDark() ? "dark" : "light") : pref;
  if (store.state.ui.theme !== t) store.setUI({ theme: t });
}

export function watchSystemTheme(store: CanvasStore) {
  const mq = matchMedia("(prefers-color-scheme: light)");
  const on = () => { if (store.state.ui.themePref === "system") applyTheme(store); };
  mq.addEventListener?.("change", on);
  // 外壳切深浅色只改 .desktop 的 class，不会重传 props：跟着那个 class 走画布才跟得上
  const shell = document.querySelector(".desktop");
  const mo = shell ? new MutationObserver(on) : null;
  if (shell) mo?.observe(shell, { attributes: true, attributeFilter: ["class"] });
  return () => { mq.removeEventListener?.("change", on); mo?.disconnect(); };
}
