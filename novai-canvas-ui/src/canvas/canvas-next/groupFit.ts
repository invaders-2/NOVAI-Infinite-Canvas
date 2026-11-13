/**
 * 普通分组（不是堆叠）的框和成员保持一致：
 *   · 建组时，框里压着的其他节点（中心点落在框内）一起编进组，免得「看着在组里、其实不在」
 *   · 拖节点：中心落进某个分组框就加入它；组员被拖到框外就移出
 *   · 组员移动 / 加入后，框只会扩大把它们包住，不会自动缩小（用户手动拉大的框保留）
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { isStack } from "./stack";

export const GROUP_PAD = 28;
type Box = { x: number; y: number; w: number; h: number };
const center = (n: CanvasNode) => ({ x: n.x + n.w / 2, y: n.y + (n.h + 24) / 2 });
const inside = (p: { x: number; y: number }, b: Box) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
export const isFrame = (n: CanvasNode | null | undefined): n is CanvasNode => !!n && n.kind === "group" && !isStack(n);

/** 节点所在的普通分组 id（一个节点最多属于一个组；堆叠不算普通分组） */
export function ownerOf(doc: CanvasDoc, id: string): string | null {
  const g = doc.nodes.find((n) => isFrame(n) && (n.children || []).includes(id));
  return g ? g.id : null;
}

/** 分组（含堆叠）的全部子孙 id，递归到所有层级：拖组 / 复制组 / 组内排版时成员要跟着走 */
export function memberIdsDeep(doc: CanvasDoc, ids: Iterable<string>): Set<string> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const c of byId.get(id)?.children || []) {
      if (c === id || out.has(c)) continue;
      out.add(c); walk(c);
    }
  };
  for (const id of ids) walk(id);
  return out;
}

/**
 * 去掉「已经被另一个选中组包含」的节点：选中外层组 + 它的成员时只算外层，
 * 否则新组的 children 会把同一节点收两次（双籍）。
 */
export function dropNestedIds(doc: CanvasDoc, ids: string[]): string[] {
  const parent = new Map<string, string>();
  for (const g of doc.nodes) if (isFrame(g)) for (const c of g.children || []) parent.set(c, g.id);
  const chosen = new Set(ids);
  return ids.filter((id) => {
    const seen = new Set<string>([id]);
    for (let cur = parent.get(id); cur && !seen.has(cur); cur = parent.get(cur)) {
      if (chosen.has(cur)) return false;
      seen.add(cur);
    }
    return true;
  });
}

/** 普通分组的最小尺寸：递归组内成员的包围盒 + GROUP_PAD（frameOf 口径）；堆叠 / 非分组 / 空组返回 0 */
export function minGroupSize(doc: CanvasDoc, id: string): { w: number; h: number } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const g = byId.get(id);
  if (!g || g.kind !== "group" || isStack(g)) return { w: 0, h: 0 };
  const members = [...memberIdsDeep(doc, [id])].map((x) => byId.get(x)).filter((n): n is CanvasNode => !!n);
  if (!members.length) return { w: 0, h: 0 };
  const f = frameOf(members);
  return { w: f.w, h: f.h };
}

/** 只把给定的普通分组框扩到包住内容（只扩不缩，x/y 不变）；没有变化返回原文档 */
export function growGroupFrames(doc: CanvasDoc, ids: Iterable<string>): CanvasDoc {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const grown = new Map<string, CanvasNode>();
  for (const id of ids) {
    const g = byId.get(id);
    if (!g || g.kind !== "group" || isStack(g)) continue;
    const min = minGroupSize(doc, id);
    if (min.w <= g.w && min.h <= g.h) continue;
    grown.set(id, { ...g, w: Math.max(g.w, Math.round(min.w)), h: Math.max(g.h, Math.round(min.h)) });
  }
  return grown.size ? { ...doc, nodes: doc.nodes.map((n) => grown.get(n.id) || n) } : doc;
}

/**
 * 组内节点变大后，把它所属的普通分组（含嵌套的父组）扩到包住它：只扩不缩、x/y 不变。
 * 逐层向上传，最多 8 层，避免异常数据成环时死循环。
 */
export function growOwnerFrames(doc: CanvasDoc, ids: Iterable<string>): CanvasDoc {
  let current = doc; let targets = new Set(ids);
  for (let pass = 0; pass < 8; pass++) {
    const owners = new Set<string>();
    for (const id of targets) { const owner = ownerOf(current, id); if (owner) owners.add(owner); }
    if (!owners.size) break;
    const next = growGroupFrames(current, owners);
    if (next === current) break;
    current = next; targets = owners;
  }
  return current;
}

/** 选中的节点 → 分组框（与 groupSelection 原来的算法一致） */
export function frameOf(ns: CanvasNode[]): Box {
  const pad = GROUP_PAD;
  const x = Math.min(...ns.map((n) => n.x)) - pad, y = Math.min(...ns.map((n) => n.y)) - pad - 10;
  const w = Math.max(...ns.map((n) => n.x + n.w)) - x + pad, h = Math.max(...ns.map((n) => n.y + n.h + 24)) - y + pad - 24;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** 建组时框里还压着、但没选中的节点（不在别的组 / 堆叠里，不是分组本身） */
export function strayInFrame(doc: CanvasDoc, ids: string[], box: Box): string[] {
  const chosen = new Set(ids);
  const owned = new Set(doc.nodes.flatMap((g) => (g.kind === "group" ? g.children || [] : [])));
  return doc.nodes.filter((n) => !chosen.has(n.id) && n.kind !== "group" && !owned.has(n.id) && inside(center(n), box)).map((n) => n.id);
}

/**
 * 拖完节点后整理分组成员：返回新文档（没变化返回原文档）。
 * moved：这次拖动的节点 id（拖的是整个分组时不处理组员）。
 */
export function reconcileGroups(doc: CanvasDoc, moved: string[]): CanvasDoc {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const frames = doc.nodes.filter(isFrame);
  if (!frames.length) return doc;
  const draggedFrames = new Set(moved.filter((id) => isFrame(byId.get(id))));
  const kids = new Map(frames.map((g) => [g.id, [...(g.children || [])]]));
  let changed = false;
  for (const id of moved) {
    const n = byId.get(id); if (!n || n.kind === "group") continue;
    const owner = frames.find((g) => kids.get(g.id)!.includes(id));
    if (owner && draggedFrames.has(owner.id)) continue; // 跟着整个分组一起动的
    if (doc.nodes.some((s) => isStack(s) && (s.children || []).includes(id))) continue; // 堆叠里的不管
    const c = center(n);
    // 最里层（面积最小）的框优先
    const target = frames.filter((g) => g.id !== owner?.id && inside(c, g)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (owner && !inside(c, owner)) { kids.set(owner.id, kids.get(owner.id)!.filter((k) => k !== id)); changed = true; }
    if (target && (!owner || !inside(c, owner))) { kids.get(target.id)!.push(id); changed = true; }
  }
  // 框扩大到包住所有组员（只扩不缩）
  const nodes = doc.nodes.map((g) => {
    if (!isFrame(g)) return g;
    const list = kids.get(g.id)!; const members = list.map((k) => byId.get(k)).filter((m): m is CanvasNode => !!m);
    let next = list.length !== (g.children || []).length || list.some((k, i) => k !== g.children![i]) ? { ...g, children: list } : g;
    if (members.length) {
      const f = frameOf(members);
      const x = Math.min(next.x, f.x), y = Math.min(next.y, f.y);
      const r = Math.max(next.x + next.w, f.x + f.w), b = Math.max(next.y + next.h, f.y + f.h);
      if (x !== next.x || y !== next.y || r - x !== next.w || b - y !== next.h) next = { ...next, x, y, w: r - x, h: b - y };
    }
    if (next !== g) changed = true;
    return next;
  });
  return changed ? { ...doc, nodes } : doc;
}
