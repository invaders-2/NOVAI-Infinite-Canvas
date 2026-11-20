/**
 * 剪辑时间线的纯逻辑（不碰 DOM，方便单测）。
 *
 * 轨道模型（和剪映主轨一样是「吸附式」的）：
 *   · 视频轨、音频轨：片段按 order 首尾相接，从 0 开始排；拖动只改变先后，不留空隙
 *   · 「交叉溶解」转场让本段提前 transMs 进场，和上一段重叠；「黑场淡入」不重叠
 *   · 字幕轨：每条字幕有自己的 start / end，可以自由摆放
 *   · 画中画轨（layer=overlay）：叠在主画面上的视频 / 图片，像字幕一样自由摆放（start = 时间线上的开始），
 *     时长 = 使用区间 / 速度；画面位置 / 大小 / 不透明度由 tf（静态）和 kf（关键帧）决定
 *
 * 数据仍是旧版 TimelineClip（node.clips），只多了几个可选字段，旧画布读到也不会坏。
 */
import type { TimelineClip } from "../react-canvas/reactCanvasStore";

export type TransKind = "none" | "fade" | "dissolve" | "wipe" | "slide" | "zoom";
/** 和上一段重叠进场的转场（溶解 / 擦除 / 推入 / 放大）；黑场淡入不重叠 */
export const OVERLAP_TRANS: TransKind[] = ["dissolve", "wipe", "slide", "zoom"];
export const TRANS_LABEL: Record<TransKind, string> = { none: "无", fade: "黑场淡入", dissolve: "交叉溶解", wipe: "擦除", slide: "推入", zoom: "放大进场" };
/** 片段素材：视频 / 音频 / 静态图片（图片放在视频轨，按设定时长显示） */
export type ClipMedia = "video" | "audio" | "image";
export type Clip = Omit<TimelineClip, "mediaKind"> & {
  mediaKind: ClipMedia;
  /** 配音对齐镜头：时长按镜头定，素材更短时后面留空（不按素材真实时长收缩） */
  pad?: boolean;
  /** 变速：0.25–4，1 = 原速（时间线上的长度 = 使用区间 / 速度） */
  speed?: number;
  /** 源素材总时长（秒）：修剪不能超过它 */
  srcDur?: number;
  /** 0–2，1 = 原音量 */
  volume?: number;
  /** 进入本段的转场 */
  trans?: TransKind;
  transMs?: number;
  /** 片段名（取自源节点标题） */
  title?: string;
  /** 缩略图（源节点封面） */
  thumb?: string;
  /** overlay = 放在画中画轨（叠在主画面上） */
  layer?: "overlay";
  /** 画面变换（静态）：x / y 是画面中心在画幅里的位置（0–1），s 是相对「适配画幅大小」的缩放，o 不透明度，r 旋转（度） */
  tf?: Partial<Tf>;
  /** 关键帧：t 是片段内的相对秒数；两帧之间缓入缓出插值 */
  kf?: Key[];
  /** 调色：亮度 / 对比度 / 饱和度（百分比，100 = 原样） */
  color?: { b?: number; c?: number; s?: number };
  /** 背景音乐自动压低：画面里有声音的片段播放时，这段音量降到 duck 倍（0–1），前后 0.3 秒渐变 */
  duck?: number;
};
export type Tf = { x: number; y: number; s: number; o: number; r: number };
export type Key = { t: number } & Partial<Tf>;
export type Track = "video" | "overlay" | "audio" | "subtitle";
/** 所有轨道（排版 / 归一化 / 统计用的顺序） */
export const ALL_TRACKS: Track[] = ["video", "overlay", "audio", "subtitle"];
/** 自由摆放的轨道（每段有自己的 start）；其余是首尾相接的吸附轨 */
export const isFree = (t: Track) => t === "subtitle" || t === "overlay";
export type Placed = { clip: Clip; start: number; end: number; index: number };

export const MIN_LEN = 0.1;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
/** 图片片段默认时长（秒） */
export const IMAGE_LEN = 3;
export const MAX_TRANS_MS = 2000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export const trackOf = (c: Clip): Track => (c.type === "subtitle" ? "subtitle" : c.mediaKind === "audio" ? "audio" : c.layer === "overlay" ? "overlay" : "video");
export const speedOf = (c: Clip) => { const v = Number(c.speed); return Number.isFinite(v) && v > 0 ? Math.max(0.25, Math.min(4, v)) : 1; };
/** 时间线上的长度（已按变速换算） */
export const lenOf = (c: Clip) => Math.max(0, c.outPoint - c.inPoint) / speedOf(c);
/** 音频淡入 / 淡出（秒）；字段沿用旧版 fadeIn / fadeOut（毫秒） */
export const fadeOf = (c: Clip) => ({ in: Math.max(0, Number(c.fadeIn) || 0) / 1000, out: Math.max(0, Number(c.fadeOut) || 0) / 1000 });
export const volOf = (c: Clip) => (Number.isFinite(Number(c.volume)) ? Math.max(0, Math.min(2, Number(c.volume))) : 1);

/** 进入本段的有效转场（第一段没有转场；时长不超过本段和上一段的一半） */
export function transOf(c: Clip, prev?: Clip): { kind: TransKind; sec: number } {
  const kind: TransKind = c.trans && c.trans in TRANS_LABEL ? c.trans : "none";
  if (kind === "none") return { kind, sec: 0 };
  const want = Math.max(0, Math.min(MAX_TRANS_MS, Number(c.transMs) || 500)) / 1000;
  const cap = Math.min(lenOf(c), prev ? lenOf(prev) : lenOf(c)) / 2;
  if (OVERLAP_TRANS.includes(kind) && !prev) return { kind: "fade", sec: r3(Math.min(want, cap)) };
  return { kind, sec: r3(Math.max(0, Math.min(want, cap))) };
}

/** 某条吸附轨上的片段（按 order） */
export const trackClips = (clips: Clip[], t: Track) => clips.filter((c) => trackOf(c) === t).sort((a, b) => a.order - b.order);

/** 把一条轨道排到时间轴上 */
export function place(clips: Clip[], t: Track): Placed[] {
  const list = trackClips(clips, t);
  if (t === "subtitle") return list.map((clip, index) => ({ clip, index, start: Math.max(0, Number(clip.start) || 0), end: Math.max((Number(clip.start) || 0) + MIN_LEN, Number(clip.end) || 0) }));
  if (t === "overlay") return list.map((clip, index) => { const start = r3(Math.max(0, Number(clip.start) || 0)); return { clip, index, start, end: r3(start + Math.max(MIN_LEN, lenOf(clip))) }; });
  let cursor = 0; const out: Placed[] = [];
  list.forEach((clip, index) => {
    const tr = transOf(clip, list[index - 1]);
    const start = r3(Math.max(0, cursor - (OVERLAP_TRANS.includes(tr.kind) ? tr.sec : 0)));
    const end = r3(start + lenOf(clip));
    out.push({ clip, start, end, index }); cursor = end;
  });
  return out;
}

export function totalOf(clips: Clip[]): number {
  const ends = ALL_TRACKS.flatMap((t) => place(clips, t).map((p) => p.end));
  return r3(Math.max(0, ...ends));
}

/** 时间点 t 上某条轨正在播的片段（溶解重叠时可能有两段，后一段在后面） */
export function activeAt(clips: Clip[], t: Track, time: number): Placed[] {
  return place(clips, t).filter((p) => time >= p.start && time < p.end);
}

/** 片段内的源时间 */
export const srcTime = (p: Placed, time: number) => p.clip.inPoint + Math.max(0, Math.min(lenOf(p.clip), time - p.start)) * speedOf(p.clip);

/** 重新编号 order（每条轨各自从 0 开始，字幕按开始时间） */
export function normalize(clips: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const t of ALL_TRACKS) {
    const list = isFree(t) ? trackClips(clips, t).sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)) : trackClips(clips, t);
    list.forEach((c, i) => out.push({ ...c, order: i }));
  }
  return out;
}

/** 在 time 处切开。id 给定时只切这一段；否则切视频轨、音频轨、字幕轨上压着播放头的所有片段 */
export function splitAt(clips: Clip[], time: number, id?: string, mkId: (c: Clip) => string = (c) => c.id + "_b" + Math.round(time * 1000)): { clips: Clip[]; made: string[] } {
  const made: string[] = []; let next = [...clips];
  for (const t of ALL_TRACKS) {
    for (const p of place(next, t)) {
      if (id && p.clip.id !== id) continue;
      if (time <= p.start + MIN_LEN || time >= p.end - MIN_LEN) continue;
      const c = p.clip; const nid = mkId(c);
      let a: Clip, b: Clip;
      if (t === "subtitle") { a = { ...c, end: r3(time) }; b = { ...c, id: nid, start: r3(time) }; }
      else if (t === "overlay") {
        const cut = r3(c.inPoint + (time - p.start) * speedOf(c)); const at = time - p.start;
        a = { ...c, outPoint: cut, ...(c.kf ? { kf: c.kf.filter((k) => k.t <= at) } : {}) };
        b = { ...c, id: nid, inPoint: cut, start: r3(time), ...(c.kf ? { kf: c.kf.filter((k) => k.t >= at).map((k) => ({ ...k, t: r3(k.t - at) })) } : {}) };
      }
      else {
        const cut = r3(c.inPoint + (time - p.start) * speedOf(c));
        const at = time - p.start;
        a = { ...c, outPoint: cut, ...(c.kf ? { kf: c.kf.filter((k) => k.t <= at) } : {}) };
        b = { ...c, id: nid, inPoint: cut, trans: "none", transMs: 0, order: c.order + 0.5, ...(c.kf ? { kf: c.kf.filter((k) => k.t >= at).map((k) => ({ ...k, t: r3(k.t - at) })) } : {}) };
      }
      next = next.flatMap((x) => (x.id === c.id ? [a, b] : [x])); made.push(nid);
    }
  }
  return { clips: normalize(next), made };
}

/** 多选整块挪位：以主拖片段的新中心算落点，同轨选中的片段保持相对顺序整体插入 */
export function moveGroupTo(clips: Clip[], primaryId: string, ids: Set<string>, newCenter: number): Clip[] {
  const primary = clips.find((c) => c.id === primaryId); if (!primary) return clips;
  const t = trackOf(primary); if (isFree(t)) return clips;
  const others = place(clips.filter((c) => !ids.has(c.id)), t);
  const at = others.filter((p) => (p.start + p.end) / 2 < newCenter).length;
  const block = trackClips(clips, t).filter((c) => ids.has(c.id));
  const list = others.map((p) => p.clip); list.splice(at, 0, ...block);
  const order = new Map(list.map((x, i) => [x.id, i]));
  return normalize(clips.map((x) => (order.has(x.id) ? { ...x, order: order.get(x.id)! } : x)));
}

/** 把 id 移到本轨第 to 位（吸附轨） */
export function moveTo(clips: Clip[], id: string, to: number): Clip[] {
  const c = clips.find((x) => x.id === id); if (!c) return clips;
  const t = trackOf(c); if (isFree(t)) return clips;
  const list = trackClips(clips, t).filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(list.length, Math.round(to)));
  list.splice(at, 0, c);
  const order = new Map(list.map((x, i) => [x.id, i]));
  return normalize(clips.map((x) => (order.has(x.id) ? { ...x, order: order.get(x.id)! } : x)));
}

/** 拖动结束时，按拖动后片段中心落在哪两段之间算目标位置 */
export function dropIndex(clips: Clip[], id: string, newCenter: number): number {
  const c = clips.find((x) => x.id === id); if (!c) return 0;
  const others = place(clips.filter((x) => x.id !== id), trackOf(c));
  return others.filter((p) => (p.start + p.end) / 2 < newCenter).length;
}

/** 拖动片段边缘修剪；dt 为时间轴上的位移（秒） */
export function trimEdge(c: Clip, edge: "l" | "r", dt: number): Clip {
  if (trackOf(c) === "subtitle") {
    const s = Number(c.start) || 0, e = Number(c.end) || s + 1;
    return edge === "l" ? { ...c, start: r3(Math.max(0, Math.min(e - MIN_LEN, s + dt))) } : { ...c, end: r3(Math.max(s + MIN_LEN, e + dt)) };
  }
  // 画中画：左边修剪同时挪开始时间（右边不动），右边修剪和主轨一样
  if (trackOf(c) === "overlay") {
    const s0 = Number(c.start) || 0;
    if (c.mediaKind === "image") {
      const len = c.outPoint - c.inPoint;
      if (edge === "r") return { ...c, inPoint: 0, outPoint: r3(Math.min(600, Math.max(MIN_LEN, len + dt))) };
      const d = Math.max(-s0, Math.min(len - MIN_LEN, dt));
      return { ...c, inPoint: 0, outPoint: r3(len - d), start: r3(s0 + d) };
    }
    const max = Number(c.srcDur) > 0 ? Number(c.srcDur) : Infinity; const k = speedOf(c);
    if (edge === "r") return { ...c, outPoint: r3(Math.max(c.inPoint + MIN_LEN, Math.min(max, c.outPoint + dt * k))) };
    const d = Math.max(-s0, -c.inPoint / k, Math.min((c.outPoint - c.inPoint - MIN_LEN) / k, dt));
    return { ...c, inPoint: r3(c.inPoint + d * k), start: r3(s0 + d) };
  }
  // 图片没有源时长：只改显示时长（出点），左边修剪等价于缩短
  if (c.mediaKind === "image") {
    const len = c.outPoint - c.inPoint; const next = Math.max(MIN_LEN, edge === "l" ? len - dt : len + dt);
    return { ...c, inPoint: 0, outPoint: r3(Math.min(600, next)) };
  }
  const max = Number(c.srcDur) > 0 ? Number(c.srcDur) : Infinity; const k = speedOf(c);
  if (edge === "l") return { ...c, inPoint: r3(Math.max(0, Math.min(c.outPoint - MIN_LEN, c.inPoint + dt * k))) };
  return { ...c, outPoint: r3(Math.max(c.inPoint + MIN_LEN, Math.min(max, c.outPoint + dt * k))) };
}

/** 复制一段：放在原片段后面（吸附轨），字幕接在原字幕后面 */
export function duplicate(clips: Clip[], id: string, newId: string): Clip[] {
  const c = clips.find((x) => x.id === id); if (!c) return clips;
  if (trackOf(c) === "subtitle") { const s = Number(c.start) || 0, e = Number(c.end) || s + 1; return normalize([...clips, { ...c, id: newId, start: r3(e), end: r3(e + (e - s)) }]); }
  if (trackOf(c) === "overlay") { const s = Number(c.start) || 0; return normalize([...clips, { ...c, id: newId, start: r3(s + lenOf(c)) }]); }
  return normalize(clips.flatMap((x) => (x.id === id ? [x, { ...x, id: newId, order: x.order + 0.5, trans: "none" as TransKind, transMs: 0 }] : [x])));
}

/** 吸附点：所有片段的首尾 + 播放头（拖动 / 修剪时靠近就吸上去） */
export function snapPoints(clips: Clip[], exceptId: string, playhead: number, marks: number[] = []): number[] {
  const pts = [0, playhead, ...marks];
  for (const t of ALL_TRACKS) for (const p of place(clips, t)) if (p.clip.id !== exceptId) pts.push(p.start, p.end);
  return pts;
}
/** v 离某个吸附点不到 tol 秒就返回那个点，否则原样 */
export function snapTo(v: number, pts: number[], tol: number): { v: number; hit: number | null } {
  let best: number | null = null; let d = tol;
  for (const p of pts) { const k = Math.abs(p - v); if (k <= d) { d = k; best = p; } }
  return best == null ? { v, hit: null } : { v: best, hit: best };
}

/** 平移字幕 / 画中画（自由轨） */
export function shiftSub(c: Clip, dt: number): Clip {
  const s = Number(c.start) || 0; const d = Math.max(-s, dt);
  if (trackOf(c) === "overlay") return { ...c, start: r3(s + d) };
  const e = Number(c.end) || s + 1;
  return { ...c, start: r3(s + d), end: r3(e + d) };
}

/* ---------------- 画面变换 / 关键帧 ---------------- */

/** 主轨默认铺在画幅中间（等于原来的适配显示）；画中画默认缩到 35% 放右上角 */
export function baseTf(c: Clip): Tf {
  const d: Tf = trackOf(c) === "overlay" ? { x: 0.76, y: 0.26, s: 0.36, o: 1, r: 0 } : { x: 0.5, y: 0.5, s: 1, o: 1, r: 0 };
  const t = c.tf || {};
  return { x: num(t.x, d.x), y: num(t.y, d.y), s: num(t.s, d.s), o: num(t.o, d.o), r: num(t.r, d.r) };
}
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ease = (k: number) => k * k * (3 - 2 * k);
/** 片段内相对时间 lt 处的变换：没有关键帧就是静态 tf；有关键帧时各属性在相邻两帧之间缓入缓出 */
export function tfAt(c: Clip, lt: number): Tf {
  const base = baseTf(c); const keys = (c.kf || []).filter((k) => Number.isFinite(k.t)).sort((a, b) => a.t - b.t);
  if (!keys.length) return base;
  const out = { ...base };
  for (const prop of ["x", "y", "s", "o", "r"] as const) {
    const ks = keys.filter((k) => Number.isFinite(Number(k[prop])));
    if (!ks.length) continue;
    if (lt <= ks[0].t) { out[prop] = Number(ks[0][prop]); continue; }
    if (lt >= ks[ks.length - 1].t) { out[prop] = Number(ks[ks.length - 1][prop]); continue; }
    const i = ks.findIndex((k) => k.t > lt); const a = ks[i - 1], b = ks[i];
    const k = ease((lt - a.t) / Math.max(1e-6, b.t - a.t));
    out[prop] = Number(a[prop]) + (Number(b[prop]) - Number(a[prop])) * k;
  }
  return out;
}
/** 在相对时间 lt 处写一帧（同一帧位 ±1/60 秒内视为同一帧，合并属性） */
export function upsertKey(c: Clip, lt: number, patch: Partial<Tf>): Clip {
  const t = r3(Math.max(0, Math.min(lenOf(c), lt)));
  const keys = [...(c.kf || [])]; const i = keys.findIndex((k) => Math.abs(k.t - t) < 1 / 60);
  if (i >= 0) keys[i] = { ...keys[i], ...patch }; else keys.push({ t, ...tfAt(c, t), ...patch });
  return { ...c, kf: keys.sort((a, b) => a.t - b.t) };
}
export const keyAt = (c: Clip, lt: number) => (c.kf || []).find((k) => Math.abs(k.t - lt) < 1 / 60) || null;
/** 是否用到了后端 ffmpeg 渲染不了的东西（画中画 / 变换 / 关键帧）：用到了就走浏览器逐帧合成导出 */
export function needsCompositor(clips: Clip[]): boolean {
  return clips.some((c) => trackOf(c) === "overlay" || (c.kf && c.kf.length) || (c.tf && Object.keys(c.tf).length)
    || (c.trans && c.trans !== "none" && c.trans !== "fade" && c.trans !== "dissolve") || colorFilter(c) !== "" || duckOf(c) < 1);
}

/* ---------------- 调色 / 自动压低 ---------------- */
/** 画布 filter 串（全是默认值返回空串） */
export function colorFilter(c: Clip): string {
  const v = c.color || {}; const b = num(v.b, 100), k = num(v.c, 100), sa = num(v.s, 100);
  if (b === 100 && k === 100 && sa === 100) return "";
  return `brightness(${b}%) contrast(${k}%) saturate(${sa}%)`;
}
export const duckOf = (c: Clip) => (trackOf(c) === "audio" && Number(c.duck) > 0 && Number(c.duck) < 1 ? Number(c.duck) : 1);
export const DUCK_RAMP = 0.3;
/** 画面里「有声音」的时间段：主轨 / 画中画上的视频片段（音量大于 0） */
export function voiceSpans(clips: Clip[]): Array<[number, number]> {
  return [...place(clips, "video"), ...place(clips, "overlay")].filter((p) => p.clip.mediaKind === "video" && p.clip.url && volOf(p.clip) > 0).map((p) => [p.start, p.end] as [number, number]);
}
/** 时间 t 处背景音乐的压低倍数：在有声段里 = level，离有声段 DUCK_RAMP 秒以内线性过渡，其余 1 */
export function duckGain(spans: Array<[number, number]>, t: number, level: number): number {
  if (level >= 1 || !spans.length) return 1;
  let d = Infinity;
  for (const [a, b] of spans) { if (t >= a && t <= b) return level; d = Math.min(d, t < a ? a - t : t - b); }
  if (d >= DUCK_RAMP) return 1;
  return level + (1 - level) * (d / DUCK_RAMP);
}

/* ---------------- 专业修剪 ---------------- */
const srcMax = (c: Clip) => (Number(c.srcDur) > 0 ? Number(c.srcDur) : Infinity);
/** 吸附轨上紧挨着的下一段 */
export function nextOf(clips: Clip[], id: string): Clip | null {
  const c = clips.find((x) => x.id === id); if (!c) return null; const t = trackOf(c); if (isFree(t)) return null;
  const list = trackClips(clips, t); const i = list.findIndex((x) => x.id === id); return list[i + 1] || null;
}
export function prevOf(clips: Clip[], id: string): Clip | null {
  const c = clips.find((x) => x.id === id); if (!c) return null; const t = trackOf(c); if (isFree(t)) return null;
  const list = trackClips(clips, t); const i = list.findIndex((x) => x.id === id); return i > 0 ? list[i - 1] : null;
}
/** 两段之间剪辑点能挪的范围（时间线秒）：左段出点不超过素材 / 不短于最小长度，右段入点同理 */
function rollRange(a: Clip, b: Clip): [number, number] {
  const ka = speedOf(a), kb = speedOf(b);
  const aMax = a.mediaKind === "image" ? 600 : (srcMax(a) - a.outPoint) / ka;
  const aMin = -(a.outPoint - a.inPoint - MIN_LEN) / ka;
  const bMax = b.mediaKind === "image" ? (b.outPoint - b.inPoint - MIN_LEN) : (b.outPoint - b.inPoint - MIN_LEN) / kb;
  const bMin = b.mediaKind === "image" ? -600 : -b.inPoint / kb;
  return [Math.max(aMin, bMin), Math.min(aMax, bMax)];
}
function shiftOut(c: Clip, dt: number): Clip { return c.mediaKind === "image" ? { ...c, inPoint: 0, outPoint: r3(c.outPoint - c.inPoint + dt) } : { ...c, outPoint: r3(c.outPoint + dt * speedOf(c)) }; }
function shiftIn(c: Clip, dt: number): Clip { return c.mediaKind === "image" ? { ...c, inPoint: 0, outPoint: r3(c.outPoint - c.inPoint - dt) } : { ...c, inPoint: r3(c.inPoint + dt * speedOf(c)) }; }
/** 滚动编辑：挪 a 和它下一段之间的剪辑点，左段变长右段等量变短（总长不变） */
export function rollEdit(clips: Clip[], leftId: string, dt: number): Clip[] {
  const a = clips.find((x) => x.id === leftId); const b = a ? nextOf(clips, leftId) : null; if (!a || !b) return clips;
  const [lo, hi] = rollRange(a, b); const d = Math.max(lo, Math.min(hi, dt)); if (!d) return clips;
  return clips.map((x) => (x.id === a.id ? shiftOut(x, d) : x.id === b.id ? shiftIn(x, d) : x));
}
/** 滑移：片段位置和长度不变，只换用素材里的哪一段（往右拖 = 用更早的画面） */
export function slipEdit(c: Clip, dt: number): Clip {
  if (c.mediaKind === "image" || trackOf(c) === "subtitle") return c;
  const k = speedOf(c); const d = Math.max(-(srcMax(c) - c.outPoint), Math.min(c.inPoint, dt * k));
  return { ...c, inPoint: r3(c.inPoint - d), outPoint: r3(c.outPoint - d) };
}
/** 滑动：片段本身不变，在前后两段之间左右挪（前一段出点、后一段入点跟着变） */
export function slideEdit(clips: Clip[], id: string, dt: number): Clip[] {
  const a = prevOf(clips, id), c = clips.find((x) => x.id === id), b = nextOf(clips, id);
  if (!a || !b || !c) return clips;
  const ka = speedOf(a), kb = speedOf(b);
  // 前一段出点能挪的范围 ∩ 后一段入点能挪的范围（c 自身长度不变，所以只看 a、b）
  const aLo = -(a.outPoint - a.inPoint - MIN_LEN) / ka, aHi = a.mediaKind === "image" ? 600 : (srcMax(a) - a.outPoint) / ka;
  const bLo = b.mediaKind === "image" ? -600 : -b.inPoint / kb, bHi = (b.outPoint - b.inPoint - MIN_LEN) / (b.mediaKind === "image" ? 1 : kb);
  const dd = Math.max(Math.max(aLo, bLo), Math.min(Math.min(aHi, bHi), dt));
  if (!dd) return clips;
  return clips.map((x) => (x.id === a.id ? shiftOut(x, dd) : x.id === b.id ? shiftIn(x, dd) : x));
}

/* ---------------- 导出 ---------------- */

export const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9", "9:21", "2.39:1"] as const;
export type Ratio = (typeof RATIOS)[number];
export const RESES = ["720p", "1080p", "2K", "4K"] as const;
export type Res = (typeof RESES)[number];
/** 按平台导出的预设（和后端 main._TL_PRESETS 一致） */
export type ExportPreset = { id: string; label: string; hint: string; ratio: Ratio; res: Res };
export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "douyin", label: "抖音 / 视频号 / 快手", hint: "竖屏 9:16 · 1080×1920", ratio: "9:16", res: "1080p" },
  { id: "xiaohongshu", label: "小红书", hint: "竖版 3:4 · 1080×1440", ratio: "3:4", res: "1080p" },
  { id: "bilibili", label: "B站 / YouTube", hint: "横屏 16:9 · 1920×1080", ratio: "16:9", res: "1080p" },
  { id: "square", label: "方形 / 朋友圈", hint: "1:1 · 1080×1080", ratio: "1:1", res: "1080p" },
  { id: "4k", label: "横版 4K 母版", hint: "16:9 · 3840×2160", ratio: "16:9", res: "4K" },
];
export function frameSize(ratio: string, res: string): { width: number; height: number } {
  const short = ({ "720p": 720, "1080p": 1080, "2K": 1440, "4K": 2160 } as Record<string, number>)[res] || 720;
  const [a, b] = (RATIOS as readonly string[]).includes(ratio) ? ratio.split(":").map(Number) : [16, 9];
  const even = (v: number) => Math.round(v / 2) * 2;
  return a >= b ? { width: even((short * a) / b), height: short } : { width: short, height: even((short * b) / a) };
}

const srtTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000)); const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function toSrt(clips: Clip[]): string {
  return place(clips, "subtitle").filter((p) => String(p.clip.text || "").trim())
    .map((p, i) => `${i + 1}\n${srtTime(p.start)} --> ${srtTime(p.end)}\n${String(p.clip.text).trim()}\n`).join("\n");
}

export type RenderClip = { id: string; url: string; track: "video" | "audio"; kind: ClipMedia; timelineStartMs: number; durationMs: number; sourceInMs: number; sourceOutMs: number; speed: number; volume: number; fadeInMs: number; fadeOutMs: number; transitionIn?: { type: "fade" | "dissolve"; durationMs: number } };
/** 后端渲染（ffmpeg）用的片段表：毫秒整数 */
export function renderPlan(clips: Clip[]): { clips: RenderClip[]; durationMs: number } {
  const out: RenderClip[] = [];
  for (const t of ["video", "audio"] as const) {
    const placed = place(clips, t);
    placed.forEach((p, i) => {
      const tr = transOf(p.clip, placed[i - 1]?.clip);
      const startMs = Math.round(p.start * 1000); const durMs = Math.max(100, Math.round(lenOf(p.clip) * 1000)); const inMs = Math.round(p.clip.inPoint * 1000); const k = speedOf(p.clip);
      out.push({ id: p.clip.id, url: p.clip.url, track: t, kind: p.clip.mediaKind, timelineStartMs: startMs, durationMs: durMs, sourceInMs: inMs, sourceOutMs: inMs + Math.round(durMs * k), speed: k, volume: volOf(p.clip), fadeInMs: Math.round(fadeOf(p.clip).in * 1000), fadeOutMs: Math.round(fadeOf(p.clip).out * 1000), ...(tr.kind !== "none" && tr.sec > 0 ? { transitionIn: { type: tr.kind === "fade" ? "fade" : "dissolve", durationMs: Math.round(tr.sec * 1000) } } : {}) });
    });
  }
  const durationMs = Math.max(0, ...out.map((c) => c.timelineStartMs + c.durationMs), ...place(clips, "subtitle").map((p) => Math.round(p.end * 1000)));
  return { clips: out, durationMs };
}

/** 刻度间隔：保证相邻刻度至少 60px */
export function tickStep(pxPerSec: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s * pxPerSec >= 60) return s;
  return 600;
}
export const fmt = (s: number) => { const v = Math.max(0, s); const m = Math.floor(v / 60); const sec = v - m * 60; return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`; };

/** 专业时间码 MM:SS:FF（30fps 定帧，和导出帧率 / 帧步进对得上） */
export const FPS = 30;
export function fmtTC(s: number): string {
  const v = Math.max(0, Number.isFinite(s) ? s : 0);
  const total = Math.round(v * FPS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / (60 * FPS)) % 60)}:${p(Math.floor(total / FPS) % 60)}:${p(total % FPS)}`;
}
/** 逐帧步进（秒） */
export const frameSec = 1 / FPS;
