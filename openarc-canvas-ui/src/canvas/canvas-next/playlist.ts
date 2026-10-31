/**
 * 剪辑时间线和画布之间的接线（对齐 TapNow Playlist）：
 *   · 多选视频 / 音频节点 →「建剪辑」：新建时间线节点，按画布上从左到右、从上到下的顺序放进去
 *   · 把视频 / 音频节点拖到时间线节点上 → 追加到末尾（节点放回原位）
 *   · 片段 →「定位源节点」
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, outOf, uid } from "./model";
import type { CanvasStore } from "./store";
import { normalize, type Clip } from "./timelineModel";

/** 能放进时间线的节点：有结果的视频 / 音频 */
export const clipable = (n: CanvasNode | null | undefined): n is CanvasNode =>
  !!n && (n.kind === "video" || n.kind === "audio") && !!(outOf(n)?.url || n.url);

/** 节点 → 时间线片段（带上节点的使用区间） */
export function clipFromNode(s: CanvasNode): Clip {
  const o = outOf(s); const kind = s.kind === "audio" ? "audio" : "video"; const dur = Number(o?.dur) > 0 ? Number(o!.dur) : 0;
  const trim = (o as { trim?: { in: number; out: number } } | undefined)?.trim;
  return {
    id: uid("clip"), sourceNodeId: s.id, url: o?.url || s.url || "", mediaKind: kind,
    inPoint: trim ? trim.in : 0, outPoint: trim ? trim.out : dur || 5, order: 9999,
    ...(dur ? { srcDur: dur } : {}), title: genOf(s).title || (kind === "audio" ? "音频" : "视频"), ...(o?.frame ? { thumb: o.frame } : {}),
  };
}

/** 画布上的阅读顺序：先按行（y 相差不到半个节点高算同一行），再按 x */
export function readingOrder(nodes: CanvasNode[]): CanvasNode[] {
  return [...nodes].sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
}

/** 追加到时间线末尾；返回加了几段 */
export function addToTimeline(store: CanvasStore, tlId: string, ids: string[]): number {
  const tl = store.node(tlId); if (!tl || tl.kind !== "timeline") return 0;
  const add = readingOrder(ids.map((id) => store.node(id)).filter(clipable)).map(clipFromNode);
  if (!add.length) { store.toast("只有生成好的视频 / 音频能放进剪辑"); return 0; }
  store.snapshot();
  store.updateNode(tlId, (n) => ({ ...n, clips: normalize([...((n.clips || []) as Clip[]), ...add]) }));
  store.toast(`已把 ${add.length} 段放进剪辑时间线`);
  return add.length;
}

/** 选中的视频 / 音频 → 新建一条剪辑时间线，放在选区右侧 */
export function createTimelineFrom(store: CanvasStore, nodes: CanvasNode[]): CanvasNode | null {
  const src = readingOrder(nodes.filter(clipable)); if (!src.length) { store.toast("选中的节点里没有生成好的视频 / 音频"); return null; }
  const tl = timelineFromOrdered(store, src);
  if (tl) store.toast(`已用 ${src.length} 段建好剪辑时间线`);
  return tl;
}

/** 按给定顺序建时间线（不排序、不提示），放在这些节点右侧 */
export function timelineFromOrdered(store: CanvasStore, nodes: CanvasNode[], name = "剪辑时间线"): CanvasNode | null {
  const src = nodes.filter(clipable); if (!src.length) return null;
  const right = Math.max(...nodes.map((n) => n.x + n.w)); const top = Math.min(...nodes.map((n) => n.y));
  const w = 760, h = 540; let x = right + 120, y = top;
  const hit = () => store.state.doc.nodes.some((o) => o.kind !== "group" && x < o.x + o.w + 20 && x + w + 20 > o.x && y < o.y + o.h + 44 && y + h + 44 > o.y);
  for (let i = 0; i < 40 && hit(); i++) y += 60;
  const tl = { id: uid("n"), kind: "timeline", x, y, w, h, text: name, clips: normalize(src.map(clipFromNode)) } as unknown as CanvasNode;
  store.addNodes([tl], [], { select: true });
  return tl;
}
