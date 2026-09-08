// ============================================================================
// NOVAI OS · Window Policy (osLayerPolicy.js)
// Phase 3 Window Manager 的**两层策略**：层级（z / layer）+ 几何（clamp / resize）。
//
// 为什么独立成文件：
//   Drag / Resize / WM / Frame 都要用同一套边界与分层规则。
//   如果各写一份，必然出现"拖拽能拖出去但最大化对不上"这类漂移。
//
// 层级约定（与 os-tokens.css 的 --z-* 一一对应，禁止业务 App 自写大 z-index）：
//   wallpaper 0 < icon 10 < window 100 < dock 800 < assistant 900
//     < menu 1000 < dialog 1100 < notification 1200
//   interaction 1500 —— **仅用于 .os-window-layer 内部**的临时交互层
//     （shield / resize handle）。该层是 z=100 的独立层叠上下文，
//     内部 z 再大也越不过 Dock / System Bar，天然形成护栏。
//
// 窗口 z 是**层内相对值**：压缩到 1..N，不随打开次数无限膨胀。
// ============================================================================

/** 层级常量（与 os-tokens.css --z-* 保持同步；JS 侧需要数值时用） */
export const Z_LAYER = Object.freeze({
  wallpaper: 0,
  icon: 10,
  window: 100,
  interaction: 1500,
  dock: 800,
  assistant: 900,
  menu: 1000,
  dialog: 1100,
  notification: 1200,
});

/** 生成 CSS 变量引用（业务侧一律用 var()，不写裸数字） */
export function cssLayer(name) {
  return `var(--z-${name})`;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/* ---------------- 层级：z 压缩 ---------------- */

/**
 * 把窗口 z 压缩为层内连续的 1..N（按当前 z 升序）。
 * @param {Array<object>} wins
 * @returns {Map<string, number>} id → 新 z
 */
export function compact(wins) {
  const ordered = Array.from(wins || []).sort((a, b) => a.z - b.z);
  const map = new Map();
  ordered.forEach((win, index) => map.set(win.id, index + 1));
  return map;
}

/* ---------------- 几何：边界约束 ---------------- */

/**
 * 把一个 rect 约束进 workArea，并保证不小于 minSize。
 * 用于 resize 提交、窗口初始化、workArea 变化后的重新收敛。
 */
export function clampRect(rect, minSize, area) {
  const wa = area || { x: 0, y: 0, width: 1280, height: 720 };
  const min = minSize || { width: 360, height: 240 };

  let width = Math.max(min.width, Math.round(rect.width));
  let height = Math.max(min.height, Math.round(rect.height));
  // 不允许比 workArea 还大（否则 maximized 之外也占满）
  width = Math.min(width, wa.width);
  height = Math.min(height, wa.height);

  const x = clamp(
    Math.round(rect.x),
    wa.x,
    Math.max(wa.x, wa.x + wa.width - width)
  );
  const y = clamp(
    Math.round(rect.y),
    wa.y,
    Math.max(wa.y, wa.y + wa.height - height)
  );
  return { x, y, width, height };
}

/**
 * 拖拽位置约束：不允许窗口被拖到完全脱离 Desktop。
 * 规则（比 resize 宽松，保留"半掩"的自由）：
 *   - 上边界：y 不得小于 workArea.y —— 标题栏必须始终可抓
 *   - 左/右：至少保留 keepVisible 宽的可见区域
 *   - 下边界：至少保留 keepVisible 高的可见区域
 */
export function clampPosition(x, y, size, area, keepVisible = 96) {
  const wa = area || { x: 0, y: 0, width: 1280, height: 720 };
  const keep = Math.max(24, Math.min(keepVisible, wa.width, wa.height));

  const minX = wa.x + keep - size.width;
  const maxX = wa.x + wa.width - keep;
  const minY = wa.y; // 标题栏不允许被拖出顶部
  const maxY = wa.y + wa.height - keep;

  return {
    x: Math.round(clamp(x, minX, Math.max(minX, maxX))),
    y: Math.round(clamp(y, minY, Math.max(minY, maxY))),
  };
}

/** 8 向 resize 方向（句柄顺序固定，供 osWindowFrame 构建） */
export const RESIZE_DIRS = Object.freeze(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

/**
 * 按方向计算 resize 后的 rect。
 * 约束顺序：先按方向算 → 夹 minSize（并修正 x/y）→ 夹 workArea → 再夹一次 minSize。
 * @param {{x,y,width,height}} start 拖拽开始时的 rect
 * @param {string} dir n/s/e/w/ne/nw/se/sw
 * @param {number} dx 指针位移
 * @param {number} dy
 */
export function resizeRect(start, dir, dx, dy, minSize, area) {
  const wa = area || { x: 0, y: 0, width: 1280, height: 720 };
  const min = minSize || { width: 360, height: 240 };
  const d = String(dir || "");

  let { x, y, width, height } = start;

  if (d.indexOf("e") >= 0) width = start.width + dx;
  if (d.indexOf("s") >= 0) height = start.height + dy;
  if (d.indexOf("w") >= 0) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (d.indexOf("n") >= 0) {
    height = start.height - dy;
    y = start.y + dy;
  }

  // 1) 最小尺寸：拉 west / north 到达下限时必须把 x / y 一起"顶回去"
  if (width < min.width) {
    if (d.indexOf("w") >= 0) x -= min.width - width;
    width = min.width;
  }
  if (height < min.height) {
    if (d.indexOf("n") >= 0) y -= min.height - height;
    height = min.height;
  }

  // 2) workArea 边界：不允许超出可用区域
  if (x < wa.x) {
    width -= wa.x - x;
    x = wa.x;
  }
  if (y < wa.y) {
    height -= wa.y - y;
    y = wa.y;
  }
  if (x + width > wa.x + wa.width) width = wa.x + wa.width - x;
  if (y + height > wa.y + wa.height) height = wa.y + wa.height - y;

  // 3) 再夹一次下限（步骤 2 可能把尺寸压小了）
  width = Math.max(min.width, width);
  height = Math.max(min.height, height);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** workArea 矩形（maximize 目标） */
export function workAreaRect(area) {
  const wa = area || { x: 0, y: 0, width: 1280, height: 720 };
  return {
    x: Math.round(wa.x),
    y: Math.round(wa.y),
    width: Math.round(wa.width),
    height: Math.round(wa.height),
  };
}

export default {
  Z_LAYER,
  cssLayer,
  compact,
  clampRect,
  clampPosition,
  resizeRect,
  workAreaRect,
  RESIZE_DIRS,
};
