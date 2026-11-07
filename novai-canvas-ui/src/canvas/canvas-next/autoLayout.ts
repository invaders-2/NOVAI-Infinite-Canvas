/**
 * 多选一键排版：只改位置和出线侧，不建组、不改尺寸。
 * 抽成纯函数，画布动作层与界面共用，也方便直接单测。
 */
import type { CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";

export type LayoutMode = "grid" | "horizontal";

/** 画布上节点之间的舒适间距；TapNow 组内 padding=100 / spacing=200 是组框留白，这里不适用 */
export const LAYOUT_GAP = 48;

export type LayoutPos = { id: string; x: number; y: number };
export type EdgeSide = { id: string; fromSide: "left" | "right" };
export type LayoutResult = { positions: LayoutPos[]; edgeSides: EdgeSide[] };

/** 选中区域的左上角：排版后从原位长出来，整体不跳到别处 */
const anchorOf = (nodes: CanvasNode[]) => ({ x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) });

/** 选区内部的边：只看两端都在选区里、不是自环的 */
const innerEdges = (nodes: CanvasNode[], edges: CanvasEdge[]) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { byId, inner: edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to)) };
};

/** 目标中心点在源节点右侧就从右边出线，否则从左边出（排完就近取侧，线不会绕大圈） */
function sidesOf(inner: CanvasEdge[], at: Map<string, LayoutPos>, byId: Map<string, CanvasNode>): EdgeSide[] {
  return inner.map((e) => {
    const a = byId.get(e.from)!; const b = byId.get(e.to)!;
    const right = at.get(b.id)!.x + b.w / 2 >= at.get(a.id)!.x + a.w / 2;
    return { id: e.id, fromSide: right ? ("right" as const) : ("left" as const) };
  });
}

/** 宫格：列数 = ceil(sqrt(n))，每格取成员最大宽高，节点在格内居中 */
export function computeGridLayout(nodes: CanvasNode[], edges: CanvasEdge[], gap = LAYOUT_GAP): LayoutResult {
  if (!nodes.length) return { positions: [], edgeSides: [] };
  const { x: ax, y: ay } = anchorOf(nodes);
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const cw = Math.max(...nodes.map((n) => n.w));
  const ch = Math.max(...nodes.map((n) => n.h));
  const positions = nodes.map((n, i) => ({
    id: n.id,
    x: Math.round(ax + (i % cols) * (cw + gap) + (cw - n.w) / 2),
    y: Math.round(ay + Math.floor(i / cols) * (ch + gap) + (ch - n.h) / 2),
  }));
  const { byId, inner } = innerEdges(nodes, edges);
  return { positions, edgeSides: sidesOf(inner, new Map(positions.map((p) => [p.id, p])), byId) };
}

/**
 * 水平流：Kahn 逐层剥离得到从左到右的层号；同层按原有 y 升序竖向叠放，
 * 层间水平留 gap*2（按该层最宽节点算）。有环时剩下的节点按原顺序接到最后一层的下一层，绝不死循环。
 */
export function computeFlowLayout(nodes: CanvasNode[], edges: CanvasEdge[], gap = LAYOUT_GAP): LayoutResult {
  if (!nodes.length) return { positions: [], edgeSides: [] };
  const { byId, inner } = innerEdges(nodes, edges);

  const layerOf = new Map<string, number>();
  let remaining = nodes.slice();
  let depth = 0;
  while (remaining.length) {
    const rest = new Set(remaining.map((n) => n.id));
    const hasPred = new Set(inner.filter((e) => rest.has(e.from) && rest.has(e.to)).map((e) => e.to));
    const ready = remaining.filter((n) => !hasPred.has(n.id));
    if (!ready.length) { remaining.forEach((n) => layerOf.set(n.id, depth)); break; }
    ready.forEach((n) => layerOf.set(n.id, depth));
    const done = new Set(ready.map((n) => n.id));
    remaining = remaining.filter((n) => !done.has(n.id));
    depth += 1;
  }

  const last = Math.max(0, ...[...layerOf.values()]);
  const layers: string[][] = Array.from({ length: last + 1 }, () => []);
  nodes.forEach((n) => layers[layerOf.get(n.id) || 0].push(n.id));
  layers.forEach((ids) => ids.sort((a, b) => byId.get(a)!.y - byId.get(b)!.y));

  const { x: ax, y: ay } = anchorOf(nodes);
  const positions: LayoutPos[] = [];
  let x = ax;
  for (const ids of layers) {
    if (!ids.length) continue;
    let y = ay;
    for (const id of ids) {
      const n = byId.get(id)!;
      positions.push({ id, x: Math.round(x), y: Math.round(y) });
      y += n.h + gap;
    }
    x += Math.max(...ids.map((id) => byId.get(id)!.w)) + gap * 2;
  }

  return { positions, edgeSides: sidesOf(inner, new Map(positions.map((p) => [p.id, p])), byId) };
}
