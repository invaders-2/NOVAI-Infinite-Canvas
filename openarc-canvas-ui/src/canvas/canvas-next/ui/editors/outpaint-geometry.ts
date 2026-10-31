/**
 * 扩图框 + 笔刷圆圈的纯几何。只为可单测：不碰 DOM、不碰 store、不引 React。
 *
 * 模型：原图占一块 base 尺寸；用户把四边**向外**拉，每边扩展量是「原图对应边长」的比例。
 *   ext = { l, t, r, b }，都是 >= 0 的倍数（0.25 = 向外扩出原图的四分之一）。
 * 目标画布 = 原图 + 四周扩展，原图居中被透明区域包住；透明区域就是交给模型的待扩展部分。
 */

export type Size = { w: number; h: number };
export type Ext = { l: number; t: number; r: number; b: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 单边最多向外扩到原图的 2 倍（纯函数层的硬上限） */
export const MAX_EXT = 2;
/** 编辑器里一圈「看得见」的预览上限：每边最多 60%，保证目标框始终落在可视区内 */
export const PREVIEW_MAX_EXT = 0.6;
/** 单边最小可分辨扩展：0.5% 以下当 0，避免像素级的抖动 */
export const EXT_EPSILON = 0.005;

export const NO_EXT: Ext = { l: 0, t: 0, r: 0, b: 0 };

export const clampNum = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const round1 = (v: number) => Math.round(v * 1000) / 1000;

/** 目标画布像素尺寸：原图尺寸 × (1 + 两侧扩展) */
export function targetSize(base: Size, ext: Ext): Size {
  const w = Math.max(1, Math.round(base.w * (1 + ext.l + ext.r)));
  const h = Math.max(1, Math.round(base.h * (1 + ext.t + ext.b)));
  return { w, h };
}

/** 原图在目标画布里的左上角偏移（像素） */
export function imageOffset(base: Size, ext: Ext): { x: number; y: number } {
  return { x: Math.round(base.w * ext.l), y: Math.round(base.h * ext.t) };
}

/** 是否有任何一边真的扩出去了 */
export function hasExt(ext: Ext): boolean {
  return ext.l > EXT_EPSILON || ext.r > EXT_EPSILON || ext.t > EXT_EPSILON || ext.b > EXT_EPSILON;
}

/** 规整：夹到 [0, MAX_EXT]，小于 epsilon 的归零（避免显示 0.004 这种毛刺） */
export function clampExt(ext: Ext): Ext {
  const one = (v: number) => { const c = clampNum(v, 0, MAX_EXT); return c < EXT_EPSILON ? 0 : round1(c); };
  return { l: one(ext.l), t: one(ext.t), r: one(ext.r), b: one(ext.b) };
}

/** 扩图框预览用：每边夹到 PREVIEW_MAX_EXT（比硬上限更严，保证整框在屏幕上放得下） */
export function clampPreview(ext: Ext): Ext {
  const one = (v: number) => { const c = clampNum(v, 0, PREVIEW_MAX_EXT); return c < EXT_EPSILON ? 0 : round1(c); };
  return { l: one(ext.l), t: one(ext.t), r: one(ext.r), b: one(ext.b) };
}

/** 解析 "16:9" → { p:16, q:9 }；"自由" 或非法返回 null */
export function parseRatio(label: string): { p: number; q: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(label || ""));
  if (!m) return null;
  const p = Number(m[1]); const q = Number(m[2]);
  if (!(p > 0) || !(q > 0)) return null;
  return { p, q };
}

/**
 * 按目标比例算扩展：只扩「不够的那一根轴」，另一根轴保持 0，居中分配。
 * 这样比例是精确的（不会因为两边都扩而互相抵消），也不会凭空放大另一轴。
 */
export function fitRatio(base: Size, label: string): Ext | null {
  const r = parseRatio(label);
  if (!r || !(base.w > 0) || !(base.h > 0)) return null;
  const want = r.p / r.q; const cur = base.w / base.h;
  if (Math.abs(want - cur) < 1e-6) return { ...NO_EXT };
  if (cur < want) {
    // 太窄 → 往左右扩。目标宽 = 高 × 目标比例
    const total = (base.h * want) / base.w - 1;
    const half = clampNum(total / 2, 0, MAX_EXT);
    return clampExt({ l: half, t: 0, r: half, b: 0 });
  }
  // 太宽 → 往上下扩
  const total = (base.w / want) / base.h - 1;
  const half = clampNum(total / 2, 0, MAX_EXT);
  return clampExt({ l: 0, t: half, r: 0, b: half });
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** 目标尺寸 → 最简整数比（显示用）。尺寸退化或比例离谱时返回 "—" */
export function ratioOf(size: Size): string {
  const w = Math.round(size.w); const h = Math.round(size.h);
  if (!(w > 0) || !(h > 0)) return "—";
  const g = gcd(w, h) || 1;
  const p = w / g; const q = h / g;
  // 约分后两边都太大就不像"比例"了，给个近似值
  if (p > 40 || q > 40) return (Math.round((w / h) * 100) / 100) + ":1";
  return p + ":" + q;
}

/** 拖拽句柄 → 跟着变的边 */
export function edgesOfHandle(handle: Handle): Array<keyof Ext> {
  switch (handle) {
    case "n": return ["t"];
    case "s": return ["b"];
    case "e": return ["r"];
    case "w": return ["l"];
    case "ne": return ["t", "r"];
    case "nw": return ["t", "l"];
    case "se": return ["b", "r"];
    case "sw": return ["b", "l"];
    default: return [];
  }
}

/**
 * 把一次拖拽位移落到扩展量上。
 *   dx/dy：屏幕位移（px）
 *   basePx：原图在屏幕上的宽 / 高（px），用来把 px 换成比例
 *   向左上拖是负值 → 只有该边的方向取反（左边往左 = 扩展变大）
 */
export function dragExt(ext: Ext, handle: Handle, dx: number, dy: number, basePx: Size): Ext {
  const next: Ext = { ...ext };
  const fx = basePx.w > 0 ? dx / basePx.w : 0;
  const fy = basePx.h > 0 ? dy / basePx.h : 0;
  for (const edge of edgesOfHandle(handle)) {
    if (edge === "l") next.l = ext.l - fx;
    else if (edge === "r") next.r = ext.r + fx;
    else if (edge === "t") next.t = ext.t - fy;
    else if (edge === "b") next.b = ext.b + fy;
  }
  return clampExt(next);
}

/** 扩图确认前的守卫：没扩出去就不该发请求 */
export function canConfirm(ext: Ext): boolean {
  return hasExt(clampExt(ext));
}

/* ---------------- 笔刷圆圈 ---------------- */

/** 圆圈半径 = 笔刷 size / 2；size 非法时按 1 兜底，保证直径永远 = size */
export function brushRadius(size: number): number {
  const s = Number.isFinite(size) && size > 0 ? size : 1;
  return s / 2;
}

/** 只有画笔 / 橡皮显示圆圈；矩形工具自己就是框，不再叠一个圆 */
export function showsBrushRing(tool: string): boolean {
  return tool === "brush" || tool === "eraser";
}

/** 触屏不显示圆圈（手指本身挡住那一圈，反而挡视线），鼠标 / 触控板才显示 */
export function ringVisible(tool: string, pointerType: string, inside: boolean): boolean {
  if (!showsBrushRing(tool)) return false;
  if (pointerType === "touch") return false;
  return inside;
}
