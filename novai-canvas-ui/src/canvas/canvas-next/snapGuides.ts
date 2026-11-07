/**
 * 拖动节点时的对齐参考线（智能吸附）。
 *
 * 规则：
 *   · 以「被拖动的那批节点的整体外框」去对其它节点的左 / 中 / 右、顶 / 中 / 底；
 *   · 屏幕上 6px 以内就吸过去，并画出参考线（线从被对齐的节点一直连到拖动的节点）；
 *   · 横竖两个方向分开算，各自取最近的那条；
 *   · 只看节点身体（标题行以下），所有节点标题行等高，所以对齐身体就等于对齐整体。
 */

export type Box = { x: number; y: number; w: number; h: number };
/** 参考线：竖线 axis="x"（at = 世界 x，from/to = 世界 y 范围），横线 axis="y" 反之 */
export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
export type SnapResult = { dx: number; dy: number; guides: Guide[] };

/** 节点标题行高度（canvas-next.css .nhead） */
export const HEAD_H = 24;

/** 节点 → 身体外框（世界坐标） */
export function bodyBox(n: { x: number; y: number; w: number; h: number }): Box {
  return { x: n.x, y: n.y + HEAD_H, w: n.w, h: n.h };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];

/**
 * moving：被拖动节点整体外框（已经加上了这一帧的位移）
 * others：可以对齐的其它节点外框
 * threshold：吸附距离（世界坐标，调用方传 6 / 缩放比例）
 * 返回还要再补的位移 dx / dy 和要画的参考线。
 */
export function snapToGuides(moving: Box, others: Box[], threshold: number): SnapResult {
  let bestX: { d: number; delta: number } | null = null, bestY: { d: number; delta: number } | null = null;
  const mx = xs(moving), my = ys(moving);
  for (const o of others) {
    for (const a of mx) for (const b of xs(o)) { const delta = b - a, d = Math.abs(delta); if (d <= threshold && (!bestX || d < bestX.d)) bestX = { d, delta }; }
    for (const a of my) for (const b of ys(o)) { const delta = b - a, d = Math.abs(delta); if (d <= threshold && (!bestY || d < bestY.d)) bestY = { d, delta }; }
  }
  const dx = bestX ? bestX.delta : 0, dy = bestY ? bestY.delta : 0;
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  // 吸附后再收集所有正好对上的线（同一位置可能对上好几个节点，合成一条从最远到最远的线）
  if (bestX) for (const a of xs(snapped)) {
    const hits = others.filter((o) => xs(o).some((b) => near(a, b)));
    if (hits.length) guides.push({ axis: "x", at: a, from: Math.min(snapped.y, ...hits.map((o) => o.y)), to: Math.max(snapped.y + snapped.h, ...hits.map((o) => o.y + o.h)) });
  }
  if (bestY) for (const a of ys(snapped)) {
    const hits = others.filter((o) => ys(o).some((b) => near(a, b)));
    if (hits.length) guides.push({ axis: "y", at: a, from: Math.min(snapped.x, ...hits.map((o) => o.x)), to: Math.max(snapped.x + snapped.w, ...hits.map((o) => o.x + o.w)) });
  }
  return { dx, dy, guides };
}
