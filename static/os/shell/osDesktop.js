// ============================================================================
// NOVAI OS · Desktop (osDesktop.js)
// Phase 2 桌面外壳编排层：把 System Bar / Desktop Icons / Window Host /
// Dock / Launcher 接到 App Registry 与 Window Store 上。
//
// 最小功能闭环：
//   /os-preview 启动
//     → Desktop 纯色背景出现
//     → osAppRegistry.loadApps()（builtinApps + /api/apps 合并）
//     → Desktop Icons / Dock / Launcher 渲染
//     → 点击 App → osBus app:launch
//     → osWindowStore 创建窗口状态
//     → osWindowHost 显示基础窗口
//     → Dock 显示运行态
//     → Close → Store remove → Host remove → Dock 运行态更新
//
// 本文件不含任何视觉参数：材质走 glassSurface，图标走 osIcon，
// 布局/尺寸走 os-shell.css，颜色一律 var() 引用冻结 Token。
// ============================================================================
import { on, emit } from "../core/osBus.js";
import { loadApps, getApp, getApps, getDiagnostics } from "../core/osAppRegistry.js";
import * as store from "../core/osWindowStore.js";
import { createSystemBar } from "./osSystemBar.js";
import { createDesktopIcon } from "./osDesktopIcon.js";
import { createDock } from "./osDock.js";
import { createLauncher } from "./osLauncher.js";
import { createWindowHost } from "./osWindowHost.js";

/**
 * @param {Object} options
 * @param {HTMLElement} options.mount 挂载容器
 * @param {Object} options.themeRuntime themeRuntime 实例
 * @returns {Promise<Object>} desktop 句柄（供验收与调试）
 */
export async function createDesktop({ mount, themeRuntime = null } = {}) {
  const root = document.createElement("div");
  root.className = "os-desktop";
  mount.appendChild(root);

  /* ---------------- System Bar ---------------- */
  const sysbar = createSystemBar({
    theme: themeRuntime ? themeRuntime.getTheme() : "system",
    onThemeChange: (t) => themeRuntime && themeRuntime.setTheme(t),
    onAi: () => launchApp({ id: "ai-assistant", name: "AI Assistant", icon: "ai", entry: null, source: "system" }),
  });
  root.appendChild(sysbar.node);

  /* ---------------- Desktop Icons ---------------- */
  const iconLayer = document.createElement("div");
  iconLayer.className = "os-desktop__icons";
  root.appendChild(iconLayer);

  /* ---------------- Window Host ---------------- */
  const host = createWindowHost({
    onClose: (id) => store.close(id), // Close 闭环第一步：交给 Store
    onFocus: (id) => store.activate(id),
  });
  root.appendChild(host.node);

  /* ---------------- Launcher ---------------- */
  const launcher = createLauncher({
    apps: [],
    onLaunch: (app) => launchApp(app, "launcher"),
  });
  launcher.node.classList.add("os-launcher--hosted");
  root.appendChild(launcher.node);

  /* ---------------- Dock ---------------- */
  const dock = createDock({
    apps: [],
    onActivate: (app) => launchApp(app, "dock"),
    onOpenLauncher: () => launcher.open(),
  });
  root.appendChild(dock.node);

  /* ---------------- 状态同步（Store 是唯一真相来源） ---------------- */
  function syncWindows() {
    const wins = store.list();
    const validIds = new Set(wins.map((w) => w.id));

    host.prune(validIds);
    for (const win of wins) {
      host.mount(win, getApp(win.appId));
      host.sync(win);
    }

    const activeId = store.getActiveId();
    host.setActive(activeId);

    const running = new Set(wins.map((w) => w.appId));
    dock.setRunning(running);

    const active = wins.find((w) => w.id === activeId);
    dock.setActive(active ? active.appId : null);
    sysbar.setCurrentApp(active ? active.title : "Desktop");
  }

  on("store:change", syncWindows);

  /* ---------------- 启动 App ---------------- */
  function launchApp(app, source = "desktop-icon") {
    if (!app || !app.id) return null;
    emit("app:launch", { appId: app.id, source });
    const win = store.launchOrActivate(app); // 未开→创建；已开→z++ 激活
    syncWindows();
    return win;
  }

  /* ---------------- 渲染 App 清单 ---------------- */
  function renderApps(apps) {
    iconLayer.innerHTML = "";
    for (const app of apps) {
      iconLayer.appendChild(createDesktopIcon({ app, onActivate: (a) => launchApp(a, "desktop-icon") }));
    }
    dock.setApps(apps);
    launcher.setApps(apps);
    syncWindows();
  }

  /* ---------------- 初始化 ---------------- */
  const apps = await loadApps();
  renderApps(apps);

  if (themeRuntime) {
    on("theme:changed", ({ theme }) => sysbar.setTheme(theme));
  }

  return {
    root,
    apps,
    diagnostics: getDiagnostics(),
    getWindows: () => store.list(),
    getActiveId: () => store.getActiveId(),
    launch: launchApp,
    closeWindow: (id) => store.close(id),
    activate: (id) => store.activate(id),
    openLauncher: () => launcher.open(),
    reloadApps: async () => renderApps(await loadApps()),
    refreshDiagnostics: () => getDiagnostics(),
  };
}

export default createDesktop;
