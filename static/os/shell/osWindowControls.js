// ============================================================================
// NOVAI OS · Window Controls (osWindowControls.js)
// Phase 3 正式确定三个控件：Minimize / Maximize-Restore / Close。
//
// 硬性约束（继承冻结基线，不另起视觉）：
//   - 图标一律来自 osIcon.js 的**中性线性图标**
//   - **禁止**红黄绿彩色圆点、**禁止** macOS 红绿灯式排列与配色
//   - 0 border / 0 hairline / 0 outline / 0 focus ring
//   - 容器用 glassIconButton（sm = 28 容器 / 16 图标）
//
// 排列：Minimize → Maximize/Restore → Close（左→右，Close 在最右）
//   刻意与 macOS 的 close-first-left 不同，避免"抄红绿灯"。
// ============================================================================
import { createGlassIconButton } from "../ui/glassIconButton.js";

/**
 * @param {Object} options
 * @param {string} options.title 窗口标题（用于 aria-label）
 * @param {() => void} options.onMinimize
 * @param {() => void} options.onToggleMaximize
 * @param {() => void} options.onClose
 * @returns {{ node: HTMLElement, setMaximized: Function, destroy: Function }}
 */
export function createWindowControls({
  title = "window",
  onMinimize = null,
  onToggleMaximize = null,
  onClose = null,
} = {}) {
  const group = document.createElement("div");
  group.className = "os-window__controls";
  // 拖拽手柄要跳过整个控件区
  group.setAttribute("data-no-drag", "true");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", `${title} window controls`);

  const minimizeBtn = createGlassIconButton({
    icon: "minimize",
    size: "sm",
    label: `Minimize ${title}`,
    onClick: () => onMinimize && onMinimize(),
  });

  const maxBtn = createGlassIconButton({
    icon: "maximize",
    size: "sm",
    label: `Maximize ${title}`,
    onClick: () => onToggleMaximize && onToggleMaximize(),
  });

  const closeBtn = createGlassIconButton({
    icon: "close",
    size: "sm",
    label: `Close ${title}`,
    onClick: () => onClose && onClose(),
  });

  group.appendChild(minimizeBtn);
  group.appendChild(maxBtn);
  group.appendChild(closeBtn);

  let maximized = false;

  /**
   * 切换 Maximize / Restore 图标与语义（同一按钮，不出现两个都亮）
   *
   * ⚠️ 必须幂等（踩过的坑）：
   *   update() 每次 store:change 都会调用本函数。若无条件 setIcon，
   *   图标 svg 会在 **pointerdown 与 pointerup 之间**被重建 ——
   *   ① 按钮的 click 永远不触发（mousedown 的 target 已游离）
   *   ② 事件 target 变成游离节点，closest() 一律返回 null，
   *      于是 drag 的 data-no-drag 判定失效、桌面空白判定误触发 blur
   *   → 只要值没变就直接返回，绝不重建 DOM。
   */
  function setMaximized(next) {
    const nextMax = !!next;
    if (nextMax === maximized) return;
    maximized = nextMax;
    maxBtn.setIcon(maximized ? "restore" : "maximize");
    maxBtn.setAttribute(
      "aria-label",
      maximized ? `Restore ${title}` : `Maximize ${title}`
    );
  }

  function destroy() {
    group.remove();
  }

  return { node: group, setMaximized, destroy };
}

export default createWindowControls;
