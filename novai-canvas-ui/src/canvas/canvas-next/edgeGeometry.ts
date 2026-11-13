/**
 * 连线几何（画布渲染与拖动共用）。
 *
 * 出线侧按「目标中心在源节点中线哪一侧」就近算，不信任数据里的 fromSide：
 * 排版那一刻写下的侧边会随节点拖动过期，之后线就从错误的一侧甩出去、绕一大圈穿过画布。
 * 这里和 autoLayout.sidesOf 是同一条规则，只是改成渲染时按当前几何重算。
 */
export type EdgeSide = "left" | "right";
export type EdgeBox = { x: number; y: number; w: number; h: number };
export type EdgePoint = { x: number; y: number };

/** 目标中心在源节点中线右侧 → 右出线；否则左出线 */
export function edgeSideOf(a: EdgeBox, b: EdgeBox): EdgeSide {
  return b.x + b.w / 2 >= a.x + a.w / 2 ? "right" : "left";
}

/** 出线点：端口在 24px 标题栏下方的正文垂直中线上，靠节点的一侧 */
export const outPoint = (n: EdgeBox, side: EdgeSide): EdgePoint => ({ x: side === "left" ? n.x : n.x + n.w, y: n.y + 24 + n.h / 2 });

/** 进线点：一律落在目标节点左侧 */
export const inPoint = (n: EdgeBox): EdgePoint => ({ x: n.x, y: n.y + 24 + n.h / 2 });

/** 三次贝塞尔：出线朝外甩、进线从目标左侧水平收 */
export function edgePathD(a: EdgePoint, b: EdgePoint, out: EdgeSide): string {
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + (out === "left" ? -dx : dx)},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
