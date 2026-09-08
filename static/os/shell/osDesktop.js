// ============================================================================
// NOVAI OS · Desktop (osDesktop.js)
// Phase 3 桌面外壳编排层：把 System Bar / Desktop Icons / Window Host /
// Dock / Launcher 接到 App Registry 与 **Window Manager** 上。
//
// Phase 3 的变化（相对 Phase 2）：
//   - 不再直接操作 Window Store：所有窗口动作一律走 wm.*（唯一写入口）
//   - Host 瘦身为集合层，单窗口渲染交给 osWindowFrame
//   - 负责测量可用工作区（System Bar 下沿 → Dock 上沿）并下发给 WM
//   - 点击桌面空白 → wm.blur()（清空焦点）
//
// 最小功能闭环：
//   /os-preview 启动
//     → Desktop 纯色背景出现
//     → osAppRegistry.loadApps()（builtinApps + /api/apps 合并）
//     → Desktop Icons / Dock / Launcher 渲染
//     → 点击 App → osBus app:launch → wm.open()
//     → Store 写入 → store:change → Host.sync() + Dock 运行态 + System Bar
//     → Drag / Resize / Minimize / Maximize / Restore / Close 全部经 WM
//
// 本文件不含任何视觉参数：材质走 glassSurface，图标走 osIcon，
// 布局/尺寸走 os-shell.css + os-window.css，颜色一律 var() 引用冻结 Token。
// ============================================================================
import { on, emit } from "../core/osBus.js";
import { loadApps, getApp, getApps, getDiagnostics } from "../core/osAppRegistry.js";
import * as wm from "../core/osWindowManager.js";
import * as appRuntime from "../core/osAppRuntime.js";
import * as appStore from "../core/osAppStore.js";
import { createSystemBar, IDLE_LABEL } from "./osSystemBar.js";
import { createDesktopIcon } from "./osDesktopIcon.js";
import { createDock } from "./osDock.js";
import { createLauncher } from "./osLauncher.js";
import { createWindowHost } from "./osWindowHost.js";

/** 读取 spacing Token（避免 JS 里硬编码像素） */
function readSpace(token, fallback) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token);
    const value = parseFloat(String(raw || "").trim());
    return Number.isFinite(value) ? value : fallback;
  } catch (err) {
    return fallback;
  }
}

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
    onAi: () =>
      // AI Assistant 不是注册 App，走直接 wm.open（无 AppInstance，appRuntime 会拒绝）
      wm.open(
        { id: "ai-assistant", name: "AI Assistant", icon: "ai", entry: null },
        "system"
      ),
  });
  root.appendChild(sysbar.node);

  /* ---------------- Desktop Icons ---------------- */
  const iconLayer = document.createElement("div");
  iconLayer.className = "os-desktop__icons";
  root.appendChild(iconLayer);

  /* ---------------- Window Host（集合层；单窗口渲染在 osWindowFrame） ---------------- */
  const host = createWindowHost({
    wm,
    getApp: (appId) => getApp(appId),
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

  /* ---------------- 可用工作区测量 ----------------
     maximize 的目标 = System Bar 下沿 → Dock 上沿，含安全边距。
     不写死像素：margin / gap 一律从 spacing Token 读。 */
  function measureWorkArea() {
    const rect = root.getBoundingClientRect();
    const margin = readSpace("--space-4", 16);
    const gap = readSpace("--space-3", 12);
    const bar = sysbar.node.getBoundingClientRect();
    const dockRect = dock.node.getBoundingClientRect();

    const top = Math.max(rect.top, bar.bottom) + gap;
    const bottom = Math.min(rect.bottom, dockRect.top) - gap;
    const width = rect.width - margin * 2;
    const height = bottom - top;

    return {
      x: rect.left + margin,
      y: top,
      width: Math.max(240, width),
      height: Math.max(240, height),
    };
  }

  function refreshWorkArea() {
    wm.setWorkArea(measureWorkArea());
  }

  /* ---------------- 状态同步（Store 是唯一真相来源） ---------------- */
  function syncWindows() {
    const snap = wm.getState();
    host.sync(snap);

    // 运行指示来自 App Store：含 background（关窗后实例在 session 内保活 → 点仍亮）
    dock.setRunning(appRuntime.getAliveAppIds());
    dock.setMinimized(
      new Set(
        snap.windows.filter((w) => w.state === "minimized").map((w) => w.appId)
      )
    );

    const active = snap.windows.find((w) => w.id === snap.focusedId) || null;
    dock.setActive(active ? active.appId : null);
    // 无焦点 → 空态文案（NOVAI OS），不残留上一个 App 名
    sysbar.setCurrentApp(active ? active.title : IDLE_LABEL);
  }

  on("store:change", syncWindows);
  on("app-store:change", syncWindows);

  /* ---------------- 点击桌面空白 → 清空焦点 ----------------
     （Focus Policy 确认结果：清 focus）
     命中 System Bar / Dock / Launcher / Desktop Icon / 窗口 的一律跳过。 */
  root.addEventListener("pointerdown", (event) => {
    const target = event.target;
    // 游离节点（渲染过程中被替换掉的元素）一律不判定为"点桌面空白"：
    // 它的 closest() 恒为 null，会误清空焦点。
    if (!target || !target.isConnected) return;
    if (target.closest) {
      if (
        target.closest(".os-dicon, .os-sysbar, .os-dock, .os-launcher, .os-window")
      ) {
        return;
      }
    }
    wm.blur("user");
  });

  /* ---------------- 启动 App ---------------- */
  function launchApp(app, source = "desktop-icon") {
    if (!app || !app.id) return null;
    emit("app:launch", { appId: app.id, source });
    // App 生命周期交给 App Runtime（singleton / keepAlive / 实例管理）
    return appRuntime.launch(app.id, source);
  }

  /* ---------------- 渲染 App 清单 ---------------- */
  function renderApps(apps) {
    iconLayer.innerHTML = "";
    for (const app of apps) {
      iconLayer.appendChild(
        createDesktopIcon({ app, onActivate: (a) => launchApp(a, "desktop-icon") })
      );
    }
    dock.setApps(apps);
    launcher.setApps(apps);
    // Dock 重建后高度可能变化 → 重算工作区
    refreshWorkArea();
    syncWindows();
  }

  /* ---------------- 初始化 ---------------- */
  const apps = await loadApps();
  renderApps(apps);
  refreshWorkArea();

  if (themeRuntime) {
    on("theme:changed", ({ theme }) => sysbar.setTheme(theme));
  }

  // 视口变化 → 重算工作区（maximize 的正确性依赖这个）
  const onResize = () => refreshWorkArea();
  window.addEventListener("resize", onResize);

  return {
    root,
    apps,
    wm,
    diagnostics: getDiagnostics(),
    getWindows: () => wm.list(),
    getActiveId: () => wm.getActiveId(),
    getWorkArea: () => wm.getWorkArea(),
    launch: launchApp,
    // Window Manager 直面（Phase 3；未来 AI Assistant 走同一套 API）
    openApp: (app, source) => appRuntime.launch(app && app.id, source),
    focusWindow: (id) => wm.focus(id),
    blurWindows: () => wm.blur(),
    moveWindow: (id, x, y) => wm.move(id, x, y),
    resizeWindow: (id, rect) => wm.resize(id, rect),
    minimizeWindow: (id) => wm.minimize(id),
    maximizeWindow: (id) => wm.maximize(id),
    restoreWindow: (id) => wm.restore(id),
    toggleMaximize: (id) => wm.toggleMaximize(id),
    closeWindow: (id) => wm.close(id),
    closeActiveWindow: () => wm.closeActive(),
    activate: (id) => wm.focus(id),
    openLauncher: () => launcher.open(),
    reloadApps: async () => renderApps(await loadApps()),
    refreshDiagnostics: () => getDiagnostics(),
    destroy() {
      window.removeEventListener("resize", onResize);
      host.destroy();
    },
  };
}

export default createDesktop;
