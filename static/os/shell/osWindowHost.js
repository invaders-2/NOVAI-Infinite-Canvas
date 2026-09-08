// ============================================================================
// NOVAI OS · Window Host (osWindowHost.js)
// Phase 2 基础窗口宿主：只负责"渲染窗口 + Close 闭环 + z 排序"。
//
// 明确不做（Phase 3 Window Manager）：
//   drag / resize / minimize / maximize / restore /
//   完整 focus policy / modal stacking / snapping / Mission Control
//
// Window Controls：Phase 2 **只有 Close**。
//   不渲染 Minimize / Maximize / Restore —— 避免无行为的死 UI。
//   Close 真实闭环：Close → Store remove → Host remove → Dock 运行态更新
//
// 视觉：regular 玻璃 + 中性线性 icon，0 border / 0 outline / 无彩色圆点。
// ============================================================================
import { createGlassSurface } from "../ui/glassSurface.js";
import { createGlassIconButton } from "../ui/glassIconButton.js";
import { createIcon } from "../icons/osIcon.js";

/**
 * @param {Object} options
 * @param {(id: string) => void} options.onClose  请求关闭（交由 Store 决策）
 * @param {(id: string) => void} options.onFocus  点击窗口 → 激活（z++）
 * @returns {{ node: HTMLElement, mount: Function, remove: Function, sync: Function }}
 */
export function createWindowHost({ onClose = null, onFocus = null } = {}) {
  const layer = document.createElement("div");
  layer.className = "os-window-layer";

  /** id → { surface, frame } */
  const mounted = new Map();

  function buildContent(win, app) {
    if (app && app.entry) {
      const frame = document.createElement("iframe");
      frame.className = "os-window__frame";
      frame.src = app.entry;
      frame.title = `${win.title} content`;
      frame.setAttribute("referrerpolicy", "same-origin");
      return frame;
    }
    // 无 UI entry（远程能力型 App / 未迁移的第一方）：明确占位，不假装能用
    const placeholder = document.createElement("div");
    placeholder.className = "os-window__placeholder";

    const glyph = document.createElement("div");
    glyph.className = "os-window__placeholder-glyph";
    glyph.appendChild(createIcon({ name: (app && app.icon) || "grid", size: 48, color: "var(--icon-tertiary)" }));
    placeholder.appendChild(glyph);

    const title = document.createElement("p");
    title.className = "os-window__placeholder-title";
    title.textContent = app ? `${app.name} · 暂无 UI entry` : "Unknown app";
    placeholder.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "os-window__placeholder-desc";
    desc.textContent =
      app && app.source === "registry"
        ? "该 App 由 /api/apps 注册，当前仅提供能力（capabilities），没有可嵌入的界面入口。"
        : "该入口尚未提供可嵌入的界面。等待 Phase 5 manifest / adapter 化。";
    placeholder.appendChild(desc);

    if (app && app.capabilities && app.capabilities.length) {
      const caps = document.createElement("ul");
      caps.className = "os-window__caps";
      for (const cap of app.capabilities) {
        const li = document.createElement("li");
        li.textContent = `${cap.title || cap.id} · ${cap.risk}`;
        caps.appendChild(li);
      }
      placeholder.appendChild(caps);
    }
    return placeholder;
  }

  /**
   * 挂载一个窗口。
   * @param {Object} win Store 中的窗口对象
   * @param {Object|null} app 对应 App 描述符
   */
  function mount(win, app) {
    if (mounted.has(win.id)) {
      sync(win);
      return mounted.get(win.id).surface;
    }

    const surface = createGlassSurface({ tier: "regular", variant: "window", className: "os-window" });
    surface.dataset.windowId = win.id;
    surface.style.left = `${win.rect.x}px`;
    surface.style.top = `${win.rect.y}px`;
    surface.style.width = `${win.rect.width}px`;
    surface.style.height = `${win.rect.height}px`;
    surface.style.zIndex = String(win.z);
    surface.setAttribute("role", "group");
    surface.setAttribute("aria-label", win.title);

    const bar = document.createElement("div");
    bar.className = "os-window__bar";

    const title = document.createElement("span");
    title.className = "os-window__title";
    title.textContent = win.title;
    bar.appendChild(title);

    // Phase 2 只暴露 Close；Min/Max/Restore 留 Phase 3
    const closeBtn = createGlassIconButton({
      icon: "close",
      size: "sm", // 28 容器 / 16 图标，中性材质
      label: `Close ${win.title}`,
      onClick: () => onClose && onClose(win.id),
    });
    closeBtn.classList.add("os-window__close");
    bar.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "os-window__body";
    body.appendChild(buildContent(win, app));

    surface.setContent(bar);
    surface.appendChild(body);

    // 点击窗口任意位置 → 激活（z++）。不是完整 focus policy，只是最小激活。
    surface.addEventListener("pointerdown", () => onFocus && onFocus(win.id));

    layer.appendChild(surface);
    mounted.set(win.id, { surface, bar });
    return surface;
  }

  /** 同步 z 与激活态（明度，不是描边） */
  function sync(win) {
    const entry = mounted.get(win.id);
    if (!entry) return;
    entry.surface.style.zIndex = String(win.z);
  }

  function setActive(id) {
    for (const [wid, entry] of mounted) {
      entry.surface.classList.toggle("is-active", wid === id);
    }
  }

  function remove(id) {
    const entry = mounted.get(id);
    if (!entry) return false;
    entry.surface.remove();
    mounted.delete(id);
    return true;
  }

  /** 已挂载窗口 id 列表 */
  function ids() {
    return Array.from(mounted.keys());
  }

  /** 移除所有不在 validIds 中的窗口（Store 是唯一真相来源） */
  function prune(validIds) {
    const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
    for (const id of ids()) {
      if (!valid.has(id)) remove(id);
    }
  }

  return { node: layer, mount, remove, sync, setActive, ids, prune };
}

export default createWindowHost;
