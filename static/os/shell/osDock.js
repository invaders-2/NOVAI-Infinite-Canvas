// ============================================================================
// NOVAI OS · Dock (osDock.js)
// 底部停靠栏：thick 玻璃 + 中性线性图标 + 运行指示。
//
// 硬性约束：
//   - 运行指示为**中性明度点**，禁止青柠（青柠仅 Send / AI 光效）
//   - 0 border / 0 hairline / 0 outline / 0 ring
//   - 材质来自 glassSurface.js（thick），不自建玻璃
//   - 图标来自 osIcon.js，尺寸 24（Dock 规范 24~32）
// ============================================================================
import { createGlassSurface } from "../ui/glassSurface.js";
import { createGlassIconButton } from "../ui/glassIconButton.js";
import { createIcon } from "../icons/osIcon.js";

/**
 * @param {Object} options
 * @param {Array} options.apps 归一化后的 App 清单
 * @param {(app: Object) => void} options.onActivate 点击 Dock Item
 * @returns {{ node: HTMLElement, setRunning: Function, refresh: Function }}
 */
export function createDock({ apps = [], onActivate = null, onOpenLauncher = null } = {}) {
  const surface = createGlassSurface({ tier: "thick", variant: "dock", className: "os-dock" });
  const row = document.createElement("div");
  row.className = "os-dock__row";
  surface.setContent(row);

  /** appId → { item, dot } */
  const entries = new Map();

  /** 可变 App 清单（Registry 加载完成后由 setApps 更新） */
  let currentApps = apps;

  function build() {
    row.innerHTML = "";
    entries.clear();

    // App Launcher 入口（置于 Dock 首端，与 App 区分隔）
    if (onOpenLauncher) {
      const launcherWrap = document.createElement("div");
      launcherWrap.className = "os-dock__item os-dock__item--launcher";
      const launcherBtn = createGlassIconButton({
        icon: "grid",
        size: "xl",
        label: "App Launcher",
        onClick: onOpenLauncher,
      });
      launcherBtn.title = "App Launcher";
      launcherWrap.appendChild(launcherBtn);
      row.appendChild(launcherWrap);

      const divider = document.createElement("span");
      divider.className = "os-dock__divider";
      divider.setAttribute("aria-hidden", "true");
      row.appendChild(divider);
    }

    for (const app of currentApps) {
      const item = document.createElement("div");
      item.className = "os-dock__item";
      item.dataset.appId = app.id;

      const btn = createGlassIconButton({
        icon: app.icon,
        size: "xl", // 48 容器 / 24 图标（Dock 规范 24~32）
        label: app.name,
        onClick: () => onActivate && onActivate(app),
      });
      btn.title = app.desc || app.name;
      item.appendChild(btn);

      const dot = document.createElement("span");
      dot.className = "os-dock__dot";
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);

      row.appendChild(item);
      entries.set(app.id, { item, dot, btn });
    }

    // AI Assistant 入口（Idle 中性；不常驻青柠）
    const aiWrap = document.createElement("div");
    aiWrap.className = "os-dock__item os-dock__item--ai";
    const aiBtn = createGlassIconButton({
      icon: "ai",
      size: "xl",
      label: "AI Assistant",
      onClick: () => onActivate && onActivate({ id: "ai-assistant", name: "AI Assistant", entry: null, source: "system" }),
    });
    aiWrap.appendChild(aiBtn);
    row.appendChild(aiWrap);
  }

  /**
   * 更新运行态：中性明度点，不是彩色、不是青柠。
   * @param {Set<string>|Array<string>} runningAppIds
   */
  function setRunning(runningAppIds) {
    const set = runningAppIds instanceof Set ? runningAppIds : new Set(runningAppIds || []);
    for (const [appId, entry] of entries) {
      entry.dot.classList.toggle("is-running", set.has(appId));
      entry.item.classList.toggle("is-running", set.has(appId));
    }
  }

  /** 高亮当前前台窗口所属 App（明度，不是描边） */
  function setActive(appId) {
    for (const [id, entry] of entries) {
      entry.btn.classList.toggle("is-selected", id === appId);
    }
  }

  /** 更新 App 清单并重建 */
  function setApps(next) {
    currentApps = next || [];
    build();
  }

  build();

  return {
    node: surface,
    setRunning,
    setActive,
    setApps,
    refresh: build,
  };
}

export default createDock;
