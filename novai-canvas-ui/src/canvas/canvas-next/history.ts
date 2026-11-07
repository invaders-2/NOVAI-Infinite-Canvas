/**
 * 跨项目生成历史（TapNow History：所有项目的生成记录，按类型筛选、搜索、多选后放到当前画布或打包下载）。
 *
 * 每张画布的记录仍存在本机 localStorage「canvas-next:runs:<canvasId>」（store.logRun 写入），
 * 这里把所有画布的记录合在一起按时间倒序；当前画布用内存里的最新记录。
 * 只有成功且留下结果引用的记录可以放到画布 / 下载（大的 data URL 不落本机，见 compactRun）。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { isGenKind, type GenKind } from "./model";
import type { CanvasStore, RunLog } from "./store";

export type HistItem = RunLog & { canvasId: string; canvasName: string; current: boolean };
const PREFIX = "canvas-next:runs:";

function readAll(): Array<{ canvasId: string; runs: RunLog[] }> {
  const out: Array<{ canvasId: string; runs: RunLog[] }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith(PREFIX)) continue;
      try { const v = JSON.parse(localStorage.getItem(k) || "[]"); if (Array.isArray(v)) out.push({ canvasId: k.slice(PREFIX.length), runs: v }); } catch { /* 坏数据跳过 */ }
    }
  } catch { /* 无本机存储 */ }
  return out;
}

/** scope=canvas 只看当前画布；all 合并所有画布 */
export function historyItems(store: CanvasStore, scope: "canvas" | "all"): HistItem[] {
  const cur = store.state.canvasId;
  const mine: HistItem[] = store.state.runs.map((r) => ({ ...r, canvasId: cur, canvasName: store.state.name, current: true }));
  if (scope === "canvas") return mine;
  const others = readAll().filter((x) => x.canvasId !== cur).flatMap(({ canvasId, runs }) => {
    const name = runs.find((r) => r.canvasName)?.canvasName || "其他画布";
    return runs.map((r) => ({ ...r, canvasId, canvasName: name, current: false }));
  });
  return [...mine, ...others].sort((a, b) => (b.at || 0) - (a.at || 0));
}

export type HistFilter = { type: "all" | GenKind; q: string; status: "all" | "done" };
export function filterHistory(list: HistItem[], f: HistFilter): HistItem[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((r) => (f.type === "all" || r.type === f.type) && (f.status === "all" || r.status === "done")
    && (!q || [r.title, r.prompt, r.model, r.canvasName].some((s) => String(s || "").toLowerCase().includes(q))));
}

export const usable = (r: RunLog) => r.status === "done" && !!r.out && !!(r.out.url || r.out.text || r.out.frame) && isGenKind(r.type);

/** 历史记录 → 新节点（还没加进画布）；结果取不到返回 null */
export function histNode(store: CanvasStore, r: RunLog, x: number, y: number): CanvasNode | null {
  if (!usable(r)) return null;
  const kind = r.type as GenKind; const o = r.out!;
  const w = kind === "text" ? 320 : o.w && o.h ? 280 : undefined; const h = w && o.w && o.h && kind !== "text" ? Math.round(w * o.h / o.w) : undefined;
  return store.newNode(kind, x, y, { title: r.title, uploaded: kind !== "text", manual: kind === "text", prompt: r.prompt || "", hist: [{ ...o, meta: { model: r.model, at: r.at || Date.now() } }], ...(w ? { w } : {}), ...(h ? { h } : {}) });
}

/** 时间显示：今天只显示时刻，其他显示月日 */
export function histTime(r: RunLog, now = Date.now()): string {
  if (!r.at) return r.time;
  const d = new Date(r.at); const t = new Date(now);
  return d.toDateString() === t.toDateString() ? r.time : `${d.getMonth() + 1}/${d.getDate()} ${r.time}`;
}

/** 一组新节点整体右移，直到不和画布上已有节点重叠（放到画布中央时避开已有内容） */
export function clearOf(existing: CanvasNode[], nodes: CanvasNode[], gap = 40): CanvasNode[] {
  let dx = 0;
  for (let i = 0; i < 40; i++) {
    const hit = existing.filter((o) => nodes.some((n) => o.x < n.x + dx + n.w + gap && o.x + o.w + gap > n.x + dx && o.y < n.y + n.h + gap && o.y + o.h + gap > n.y));
    if (!hit.length) break;
    const left = Math.min(...nodes.map((n) => n.x + dx));
    dx += Math.max(...hit.map((o) => o.x + o.w)) + gap - left;
  }
  return dx ? nodes.map((n) => ({ ...n, x: n.x + dx })) : nodes;
}
