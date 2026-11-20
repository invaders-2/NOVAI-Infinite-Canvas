/**
 * 剪辑时间线和画布之间的接线（对齐 TapNow Playlist）：
 *   · 多选视频 / 音频节点 →「建剪辑」：新建时间线节点，按画布上从左到右、从上到下的顺序放进去
 *   · 把视频 / 音频节点拖到时间线节点上 → 追加到末尾（节点放回原位）
 *   · 片段 →「定位源节点」
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, outOf, uid } from "./model";
import type { CanvasStore } from "./store";
import { IMAGE_LEN, normalize, type Clip } from "./timelineModel";

/** 能放进时间线的节点：有结果的视频 / 音频 / 图片（图片按 3 秒静帧放进视频轨） */
export const clipable = (n: CanvasNode | null | undefined): n is CanvasNode =>
  !!n && (n.kind === "video" || n.kind === "audio" || n.kind === "image") && !!(outOf(n)?.url || n.url);

/** 节点 → 时间线片段（带上节点的使用区间） */
export function clipFromNode(s: CanvasNode): Clip {
  const o = outOf(s);
  if (s.kind === "image") {
    const url = o?.url || s.url || "";
    return { id: uid("clip"), sourceNodeId: s.id, url, mediaKind: "image", inPoint: 0, outPoint: IMAGE_LEN, order: 9999, title: genOf(s).title || "图片", ...(url && !url.startsWith("data:") ? { thumb: url } : {}) };
  }
  const kind = s.kind === "audio" ? "audio" : "video"; const dur = Number(o?.dur) > 0 ? Number(o!.dur) : 0;
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

/**
 * 时间线的「来源」连线：连入时间线 = 素材入轨。片段是内容权威（顺序 / 修剪 / 转场都在片段上），
 * 连线只表达来源关系，两者必须保持一致，否则画布上看着连着、时间线上却是空的（用户反馈过）。
 */
export const sourceEdges = (doc: { edges: Array<{ id: string; from: string; to: string }> }, tlId: string) => doc.edges.filter((e) => e.to === tlId);

/** 补齐 / 清掉来源连线：有片段没线就补，线在但该来源已无片段就删。幂等，不记历史 */
export function syncTimelineEdges(store: CanvasStore, tlId: string) {
  const tl = store.node(tlId); if (!tl || tl.kind !== "timeline") return;
  const doc = store.state.doc; const clips = (tl.clips || []) as Clip[];
  // 来源节点已从画布删除的片段保留（片段自带地址和修剪，等于已导入的素材），不补线也不删片段
  const want = new Set(clips.map((c) => c.sourceNodeId).filter((id) => !!id && !!store.node(id)));
  const live = sourceEdges(doc, tlId);
  const have = new Set(live.map((e) => e.from));
  const add = [...want].filter((id) => !have.has(id));
  const drop = live.filter((e) => !want.has(e.from));
  if (!add.length && !drop.length) return;
  const gone = new Set(drop.map((e) => e.id));
  store.mutate((d) => ({ ...d, edges: [...d.edges.filter((e) => !gone.has(e.id)), ...add.map((from) => ({ id: uid("e"), from, to: tlId }))] }), { history: false });
}

/** 追加到时间线末尾；返回加了几段。顺带补齐来源连线，一次历史 */
export function addToTimeline(store: CanvasStore, tlId: string, ids: string[]): number {
  const tl = store.node(tlId); if (!tl || tl.kind !== "timeline") return 0;
  const src = readingOrder(ids.map((id) => store.node(id)).filter(clipable));
  const add = src.map(clipFromNode);
  if (!add.length) { store.toast("只有生成好的视频 / 音频 / 图片能放进剪辑"); return 0; }
  store.snapshot();
  store.mutate((d) => {
    const linked = new Set(d.edges.filter((e) => e.to === tlId).map((e) => e.from));
    const fresh = src.filter((n) => !linked.has(n.id)).map((n) => ({ id: uid("e"), from: n.id, to: tlId }));
    return {
      ...d,
      nodes: d.nodes.map((n) => (n.id === tlId ? { ...n, clips: normalize([...((n.clips || []) as Clip[]), ...add]) } : n)),
      ...(fresh.length ? { edges: [...d.edges, ...fresh] } : {}),
    };
  });
  store.toast(`已把 ${add.length} 段放进剪辑时间线`);
  return add.length;
}

/** 选中的视频 / 音频 → 新建一条剪辑时间线，放在选区右侧 */
export function createTimelineFrom(store: CanvasStore, nodes: CanvasNode[]): CanvasNode | null {
  const src = readingOrder(nodes.filter(clipable)); if (!src.length) { store.toast("选中的节点里没有生成好的视频 / 音频 / 图片"); return null; }
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
  // 建剪辑同样落连线：画布上看得见「这几段是从哪来的」
  store.addNodes([tl], src.map((n) => ({ id: uid("e"), from: n.id, to: tl.id })), { select: true });
  return tl;
}
