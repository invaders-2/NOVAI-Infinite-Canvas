// ============================================================================
// NOVAI OS · Window Frame (osWindowFrame.js)
// **单个窗口**的完整渲染与交互挂载。Phase 3 从 osWindowHost.js 拆出来的部分。
//
// 职责：
//   1. 构建窗口 DOM（材质走 glassSurface，图标走 osIcon，布局走 os-window.css）
//   2. 挂载 Drag / Resize / IframeBridge / Controls
//   3. 提供 update(win, focusedId) —— **只做渲染**，不持有状态
//
// ⛔ 三条铁律
//   1. **iframe 绝不重建**：sync 每帧都可能被调用，重建 src 会让业务页重新加载、
//      画布内容丢失。update() 只改 style，不动子节点结构。
//   2. **不写 Store**：所有用户操作一律回调 wm.*，由 WM 统一决策后回写。
//   3. 拖拽 / 缩放期间跳过 Store 回写导致的几何覆盖（interacting 标志）。
//
// 视觉（继承冻结基线）：
//   焦点 / 非焦点只用**明度 + 透明度 + 控件强调**区分，
//   禁止 border / outline / focus ring / 彩色描边。
// ============================================================================
import { createGlassSurface } from "../ui/glassSurface.js";
import { createIcon } from "../icons/osIcon.js";
import { RESIZE_DIRS, clampPosition } from "../core/osLayerPolicy.js";
import { createWindowControls } from "./osWindowControls.js";
import { attachDrag } from "./osWindowDrag.js";
import { attachResize } from "./osWindowResize.js";
import { attachIframeFocus } from "./osIframeBridge.js";

const ANIMATION_WINDOW = 320;

function prefersReducedMotion() {
  try {
    return (
      document.documentElement.getAttribute("data-os-reduce-motion") === "true" ||
      (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    );
  } catch (err) {
    return false;
  }
}

function buildPlaceholder(app) {
  const placeholder = document.createElement("div");
  placeholder.className = "os-window__placeholder";

  const glyph = document.createElement("div");
  glyph.className = "os-window__placeholder-glyph";
  glyph.appendChild(
    createIcon({ name: (app && app.icon) || "grid", size: 48, color: "var(--icon-tertiary)" })
  );
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

function buildHandles() {
  return RESIZE_DIRS.map((dir) => {
    const handle = document.createElement("div");
    handle.className = `os-window__handle os-window__handle--${dir}`;
    handle.dataset.dir = dir;
    handle.setAttribute("data-no-drag", "true");
    handle.setAttribute("aria-hidden", "true");
    return handle;
  });
}

/**
 * @param {Object} options
 * @param {object} options.win Store 中的窗口记录
 * @param {object|null} options.app App 描述符
 * @param {object} options.wm osWindowManager（唯一写入口）
 * @returns {{ node: HTMLElement, update: Function, destroy: Function, id: string }}
 */
export function createWindowFrame({ win, app = null, wm } = {}) {
  const id = win.id;

  const surface = createGlassSurface({
    tier: "regular",
    variant: "window",
    className: "os-window",
  });
  surface.dataset.windowId = id;
  surface.setAttribute("role", "group");

  /* ---------------- 标题栏 ---------------- */
  const bar = document.createElement("div");
  bar.className = "os-window__bar";

  const titleEl = document.createElement("span");
  titleEl.className = "os-window__title";
  titleEl.textContent = win.title;
  bar.appendChild(titleEl);

  const controls = createWindowControls({
    title: win.title,
    onMinimize: () => wm && wm.minimize(id, "user"),
    onToggleMaximize: () => wm && wm.toggleMaximize(id, "user"),
    onClose: () => wm && wm.close(id, "user"),
  });
  bar.appendChild(controls.node);

  /* ---------------- 内容区 ---------------- */
  const body = document.createElement("div");
  body.className = "os-window__body";

  let frame = null;
  let bridge = { mode: "none", detach() {} };

  if (app && app.entry) {
    frame = document.createElement("iframe");
    frame.className = "os-window__frame";
    frame.src = app.entry;
    frame.title = `${win.title} content`;
    frame.setAttribute("referrerpolicy", "same-origin");
    body.appendChild(frame);
    // 同源直连：iframe 内的点击 / 聚焦 → 激活本窗口
    bridge = attachIframeFocus(frame, () => wm && wm.focus(id, "user"));
  } else {
    body.appendChild(buildPlaceholder(app));
  }

  /* ---------------- 交互层：shield + 8 向句柄 ---------------- */
  const shield = document.createElement("div");
  shield.className = "os-window__shield";
  shield.setAttribute("aria-hidden", "true");
  shield.addEventListener("pointerdown", () => wm && wm.focus(id, "user"));

  const handles = buildHandles();

  surface.setContent(bar);
  surface.appendChild(body);
  surface.appendChild(shield);
  for (const handle of handles) surface.appendChild(handle);

  /* ---------------- 状态 ---------------- */
  let current = { ...win, rect: { ...win.rect } };
  let interacting = false;
  let animTimer = 0;

  function setInteracting(next) {
    interacting = !!next;
    surface.classList.toggle("is-interacting", interacting);
    try {
      document.documentElement.classList.toggle("os-interacting", interacting);
    } catch (err) {
      /* noop */
    }
  }

  /** 交互期间强制盖 shield：防止 iframe 吞掉指针事件 */
  function showShield(next) {
    shield.classList.toggle("is-on", !!next);
  }

  function animate() {
    if (prefersReducedMotion()) return;
    surface.classList.add("is-animating");
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      surface.classList.remove("is-animating");
      animTimer = 0;
    }, ANIMATION_WINDOW);
  }

  /* ---------------- 点击窗口 → 聚焦 ---------------- */
  // capture 阶段：赶在 Drag / 业务页 stopPropagation 之前
  surface.addEventListener(
    "pointerdown",
    () => {
      if (wm) wm.focus(id, "user");
    },
    true
  );

  /* ---------------- Drag ---------------- */
  const drag = attachDrag({
    handle: bar,
    getRect: () => ({ ...current.rect }),
    onStart: () => {
      setInteracting(true);
      showShield(true);
      if (wm) wm.focus(id, "user");
    },
    onPreview: (x, y) => {
      const pos = clampPosition(
        x,
        y,
        current.rect,
        wm ? wm.getWorkArea() : { x: 0, y: 0, width: 1280, height: 720 }
      );
      surface.style.left = `${pos.x}px`;
      surface.style.top = `${pos.y}px`;
    },
    onEnd: (x, y) => {
      setInteracting(false);
      showShield(false);
      if (x == null || !wm) return;
      const pos = clampPosition(
        x,
        y,
        current.rect,
        wm.getWorkArea()
      );
      wm.move(id, pos.x, pos.y, "user");
    },
  });

  /* ---------------- Resize ---------------- */
  const resize = attachResize({
    handles,
    getState: () => ({
      rect: { ...current.rect },
      minSize: { ...(current.minSize || { width: 360, height: 240 }) },
      workArea: wm ? wm.getWorkArea() : { x: 0, y: 0, width: 1280, height: 720 },
    }),
    onStart: () => {
      setInteracting(true);
      showShield(true);
      if (wm) wm.focus(id, "user");
    },
    onPreview: (rect) => {
      surface.style.left = `${rect.x}px`;
      surface.style.top = `${rect.y}px`;
      surface.style.width = `${rect.width}px`;
      surface.style.height = `${rect.height}px`;
    },
    onEnd: (rect) => {
      setInteracting(false);
      showShield(false);
      if (!rect || !wm) return;
      wm.resize(id, rect, "user");
    },
  });

  /* ---------------- 渲染（唯一入口） ---------------- */
  function update(next, focusedId) {
    const stateChanged = !current || current.state !== next.state;
    current = { ...next, rect: { ...next.rect } };

    if (titleEl.textContent !== next.title) titleEl.textContent = next.title;
    surface.setAttribute("aria-label", next.title);

    if (stateChanged) animate();

    // 拖拽 / 缩放期间不覆盖几何，否则会出现"跟手被打断"
    if (!interacting) {
      surface.style.left = `${next.rect.x}px`;
      surface.style.top = `${next.rect.y}px`;
      surface.style.width = `${next.rect.width}px`;
      surface.style.height = `${next.rect.height}px`;
    }
    surface.style.zIndex = String(next.z);

    const minimized = next.state === "minimized";
    const maximized = next.state === "maximized";
    const active = focusedId === id && !minimized;

    surface.classList.toggle("is-active", active);
    surface.classList.toggle("is-minimized", minimized);
    surface.classList.toggle("is-maximized", maximized);
    controls.setMaximized(maximized);

    // 无障碍：最小化后整体退出焦点序列（iframe 仍在 DOM 中，Runtime 不中断）
    if (minimized) surface.setAttribute("inert", "");
    else surface.removeAttribute("inert");

    // 跨域降级：拿不到 contentDocument 时才盖 shield 兜住首次点击。
    // same-origin / pending 都不盖 —— pending 期间页面还在加载，盖 shield 只会白吞一次点击。
    if (bridge.mode === "shield" && !interacting) {
      showShield(!active && !minimized);
    }
  }

  function destroy() {
    clearTimeout(animTimer);
    drag.destroy();
    resize.destroy();
    if (bridge && bridge.detach) bridge.detach();
    try {
      document.documentElement.classList.remove("os-interacting");
    } catch (err) {
      /* noop */
    }
    surface.remove();
  }

  return { node: surface, update, destroy, id };
}

export default createWindowFrame;
