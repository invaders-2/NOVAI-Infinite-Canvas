// ============================================================================
// NOVAI OS · Window Resize (osWindowResize.js)
// 8 向缩放：n / s / e / w / ne / nw / se / sw。
//
// 关键约束：
//   1. **没有可见的 resize 边框**。句柄是完全透明的 hit area，
//      视觉上不允许出现 1px 线框 / 描边 / 圆点。
//   2. 句柄放在窗口**内部**（.os-window 有 overflow:hidden，放外面会被裁掉），
//      通过 z-index 抬到内容之上。
//   3. resize 期间必须盖 shield：iframe 会吞掉指针事件，
//      不盖会出现"拉到画布上就断"。
//   4. 尺寸下限 minWidth / minHeight、workArea 边界由 osLayerPolicy.resizeRect 统一裁决。
//
// ⛔ 本模块不写 Store，只回调。
// ============================================================================
import { resizeRect } from "../core/osLayerPolicy.js";

/**
 * @param {Object} options
 * @param {Array<HTMLElement>} options.handles 8 个句柄元素（需带 data-dir）
 * @param {() => {rect:object,minSize:object,workArea:object}} options.getState
 * @param {() => void} [options.onStart]
 * @param {(rect:object) => void} [options.onPreview] 实时预览（改 DOM）
 * @param {(rect:object) => void} [options.onEnd] 松手提交（写 Store）
 * @returns {{ destroy: Function }}
 */
export function attachResize({ handles = [], getState, onStart, onPreview, onEnd } = {}) {
  let active = false;
  let pointerId = null;
  let captureEl = null;
  let dir = "";
  let startPointer = { x: 0, y: 0 };
  let snapshot = null;
  let raf = 0;
  let pending = null;

  function flush() {
    raf = 0;
    if (!pending || !onPreview) return;
    onPreview({ ...pending });
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const target = event.target;
    if (!target || !target.dataset || !target.dataset.dir) return;

    const state = getState && getState();
    if (!state || !state.rect) return;

    active = true;
    pointerId = event.pointerId;
    dir = target.dataset.dir;
    startPointer = { x: event.clientX, y: event.clientY };
    snapshot = {
      rect: { ...state.rect },
      minSize: { ...(state.minSize || { width: 360, height: 240 }) },
      workArea: { ...(state.workArea || { x: 0, y: 0, width: 1280, height: 720 }) },
    };
    pending = null;
    captureEl = target;

    // capture 只作为"越过 iframe 不丢事件"的增强，不是正确性的依赖
    try {
      target.setPointerCapture(pointerId);
    } catch (err) {
      /* 不支持就算了：window 级监听 + shield 已经兜住 */
    }

    if (onStart) onStart();
  }

  function onPointerMove(event) {
    if (!active || (pointerId != null && event.pointerId !== pointerId)) return;
    const dx = event.clientX - startPointer.x;
    const dy = event.clientY - startPointer.y;
    pending = resizeRect(
      snapshot.rect,
      dir,
      dx,
      dy,
      snapshot.minSize,
      snapshot.workArea
    );
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function finish(commit) {
    if (!active) return;
    active = false;

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    flush();

    try {
      if (pointerId != null && captureEl && captureEl.hasPointerCapture && captureEl.hasPointerCapture(pointerId)) {
        captureEl.releasePointerCapture(pointerId);
      }
    } catch (err) {
      /* noop */
    }

    const final = pending ? { ...pending } : null;
    pending = null;
    pointerId = null;
    captureEl = null;
    dir = "";

    if (commit && onEnd && final) onEnd(final);
    if (!commit && onEnd) onEnd(null);
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

  const list = Array.from(handles);
  for (const handle of list) {
    handle.addEventListener("pointerdown", onPointerDown);
  }
  // move / up / cancel 挂 window（capture）：理由同 osWindowDrag ——
  // resize 期间 shield 盖在句柄之上，capture 一旦失效就会永久卡死。
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("blur", onAbort);

  return {
    destroy() {
      for (const handle of list) {
        handle.removeEventListener("pointerdown", onPointerDown);
      }
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

export default attachResize;
