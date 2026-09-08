// ============================================================================
// NOVAI OS · Window Drag (osWindowDrag.js)
// 标题栏拖拽。技术方案：Pointer Events + setPointerCapture + rAF 节流。
//
// 为什么用 Pointer Events 而不是 mouse 事件：
//   1. 鼠标 / 触控板 / 触屏统一，不需要两套代码
//   2. setPointerCapture 把后续事件锁在手柄上，**指针划过 iframe 时不被吞掉**
//
// ⚠️ 为什么 move / up 挂在 window 而不是手柄上（踩过的坑）：
//   拖拽开始时会盖 shield（防 iframe 吞事件），shield 覆盖在标题栏之上。
//   一旦 setPointerCapture 因任何原因失效（环境不支持 / 捕获被系统抢走 /
//   指针离开文档），后续 pointermove / pointerup 就会全部落到 shield 上，
//   手柄永远收不到 up → finish() 不执行 → os-interacting 与 shield 永久卡死，
//   整个窗口再也点不动。
//   → 因此：pointerdown 挂手柄，move / up / cancel 一律挂 window（capture 阶段）。
//     无论事件被哪个元素命中，都会冒泡到 window，松手必然能收尾。
//
// 为什么实时预览不写 Store：
//   拖拽每秒 60+ 次 pointermove，每次都 store:change 会引发渲染风暴。
//   做法：onPreview 只改 DOM style（Frame 自己改），松手才调 wm.move() 提交一次。
//   因此 window:moved 的语义 = "一次移动完成"，不是"每帧都在移动"。
//
// ⛔ 本模块不写 Store，只回调。
// ============================================================================

/**
 * @param {Object} options
 * @param {HTMLElement} options.handle 拖拽手柄（标题栏）
 * @param {() => ({x:number,y:number,width:number,height:number})} options.getRect 起始几何
 * @param {() => void} [options.onStart]
 * @param {(x:number,y:number) => void} [options.onPreview] 实时预览（改 DOM，不写 Store）
 * @param {(x:number,y:number) => void} [options.onEnd] 松手提交
 * @returns {{ destroy: Function }}
 */
export function attachDrag({ handle, getRect, onStart, onPreview, onEnd } = {}) {
  if (!handle) return { destroy() {} };

  let active = false;
  let pointerId = null;
  let startPointer = { x: 0, y: 0 };
  let startRect = null;
  let raf = 0;
  let pending = null;

  function flush() {
    raf = 0;
    if (!pending || !onPreview) return;
    onPreview(pending.x, pending.y);
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    // 控件区 / resize 句柄一律标记为 data-no-drag，不触发拖拽
    if (event.target && event.target.closest && event.target.closest("[data-no-drag]")) return;

    const rect = getRect && getRect();
    if (!rect) return;

    active = true;
    pointerId = event.pointerId;
    startPointer = { x: event.clientX, y: event.clientY };
    startRect = { ...rect };
    pending = null;

    // capture 只作为"越过 iframe 不丢事件"的增强，不是正确性的依赖
    try {
      handle.setPointerCapture(pointerId);
    } catch (err) {
      /* 不支持就算了：window 级监听 + shield 已经兜住 */
    }

    if (onStart) onStart();
  }

  function onPointerMove(event) {
    if (!active || (pointerId != null && event.pointerId !== pointerId)) return;
    const dx = event.clientX - startPointer.x;
    const dy = event.clientY - startPointer.y;
    pending = { x: startRect.x + dx, y: startRect.y + dy };
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function finish(commit) {
    if (!active) return;
    active = false;

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    // 最后一帧立刻落地，避免松手瞬间位置滞后
    flush();

    try {
      if (pointerId != null && handle.hasPointerCapture && handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    } catch (err) {
      /* noop */
    }

    const final = pending ? { ...pending } : null;
    pending = null;
    pointerId = null;

    if (commit && onEnd && final) onEnd(final.x, final.y);
    if (!commit && onEnd) onEnd(null, null);
  }

  function onPointerUp(event) {
    if (!active) return;
    if (pointerId != null && event && event.pointerId !== pointerId) return;
    finish(true);
  }

  function onPointerCancel(event) {
    if (!active) return;
    if (pointerId != null && event && event.pointerId !== pointerId) return;
    finish(false);
  }

  /** 指针离开文档 / 窗口失焦：兜底收尾，绝不让 interacting 状态卡死 */
  function onAbort() {
    if (active) finish(true);
  }

  handle.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("blur", onAbort);

  return {
    destroy() {
      handle.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", onAbort);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      active = false;
    },
  };
}

export default attachDrag;
