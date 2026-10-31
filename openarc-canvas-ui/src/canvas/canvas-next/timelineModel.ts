/**
 * 剪辑时间线的纯逻辑（不碰 DOM，方便单测）。
 *
 * 轨道模型（和剪映主轨一样是「吸附式」的）：
 *   · 视频轨、音频轨：片段按 order 首尾相接，从 0 开始排；拖动只改变先后，不留空隙
 *   · 「交叉溶解」转场让本段提前 transMs 进场，和上一段重叠；「黑场淡入」不重叠
 *   · 字幕轨：每条字幕有自己的 start / end，可以自由摆放
 *
 * 数据仍是旧版 TimelineClip（node.clips），只多了几个可选字段，旧画布读到也不会坏。
 */
import type { TimelineClip } from "../react-canvas/reactCanvasStore";

export type TransKind = "none" | "fade" | "dissolve";
export type Clip = TimelineClip & {
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
};
export type Track = "video" | "audio" | "subtitle";
export type Placed = { clip: Clip; start: number; end: number; index: number };

export const MIN_LEN = 0.1;
export const MAX_TRANS_MS = 2000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export const trackOf = (c: Clip): Track => (c.type === "subtitle" ? "subtitle" : c.mediaKind === "audio" ? "audio" : "video");
export const lenOf = (c: Clip) => Math.max(0, c.outPoint - c.inPoint);
export const volOf = (c: Clip) => (Number.isFinite(Number(c.volume)) ? Math.max(0, Math.min(2, Number(c.volume))) : 1);

/** 进入本段的有效转场（第一段没有转场；时长不超过本段和上一段的一半） */
export function transOf(c: Clip, prev?: Clip): { kind: TransKind; sec: number } {
  const kind: TransKind = c.trans === "fade" || c.trans === "dissolve" ? c.trans : "none";
  if (kind === "none") return { kind, sec: 0 };
  const want = Math.max(0, Math.min(MAX_TRANS_MS, Number(c.transMs) || 500)) / 1000;
  const cap = Math.min(lenOf(c), prev ? lenOf(prev) : lenOf(c)) / 2;
  if (kind === "dissolve" && !prev) return { kind: "fade", sec: r3(Math.min(want, cap)) };
  return { kind, sec: r3(Math.max(0, Math.min(want, cap))) };
}

/** 某条吸附轨上的片段（按 order） */
export const trackClips = (clips: Clip[], t: Track) => clips.filter((c) => trackOf(c) === t).sort((a, b) => a.order - b.order);

/** 把一条轨道排到时间轴上 */
export function place(clips: Clip[], t: Track): Placed[] {
  const list = trackClips(clips, t);
  if (t === "subtitle") return list.map((clip, index) => ({ clip, index, start: Math.max(0, Number(clip.start) || 0), end: Math.max((Number(clip.start) || 0) + MIN_LEN, Number(clip.end) || 0) }));
  let cursor = 0; const out: Placed[] = [];
  list.forEach((clip, index) => {
    const tr = transOf(clip, list[index - 1]);
    const start = r3(Math.max(0, cursor - (tr.kind === "dissolve" ? tr.sec : 0)));
    const end = r3(start + lenOf(clip));
    out.push({ clip, start, end, index }); cursor = end;
  });
  return out;
}

export function totalOf(clips: Clip[]): number {
  const ends = (["video", "audio", "subtitle"] as Track[]).flatMap((t) => place(clips, t).map((p) => p.end));
  return r3(Math.max(0, ...ends));
}

/** 时间点 t 上某条轨正在播的片段（溶解重叠时可能有两段，后一段在后面） */
export function activeAt(clips: Clip[], t: Track, time: number): Placed[] {
  return place(clips, t).filter((p) => time >= p.start && time < p.end);
}

/** 片段内的源时间 */
export const srcTime = (p: Placed, time: number) => p.clip.inPoint + Math.max(0, Math.min(lenOf(p.clip), time - p.start));

/** 重新编号 order（每条轨各自从 0 开始，字幕按开始时间） */
export function normalize(clips: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const t of ["video", "audio", "subtitle"] as Track[]) {
    const list = t === "subtitle" ? trackClips(clips, t).sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)) : trackClips(clips, t);
    list.forEach((c, i) => out.push({ ...c, order: i }));
  }
  return out;
}

/** 在 time 处切开。id 给定时只切这一段；否则切视频轨、音频轨、字幕轨上压着播放头的所有片段 */
export function splitAt(clips: Clip[], time: number, id?: string, mkId: (c: Clip) => string = (c) => c.id + "_b" + Math.round(time * 1000)): { clips: Clip[]; made: string[] } {
  const made: string[] = []; let next = [...clips];
  for (const t of ["video", "audio", "subtitle"] as Track[]) {
    for (const p of place(next, t)) {
      if (id && p.clip.id !== id) continue;
      if (time <= p.start + MIN_LEN || time >= p.end - MIN_LEN) continue;
      const c = p.clip; const nid = mkId(c);
      let a: Clip, b: Clip;
      if (t === "subtitle") { a = { ...c, end: r3(time) }; b = { ...c, id: nid, start: r3(time) }; }
      else {
        const cut = r3(c.inPoint + (time - p.start));
        a = { ...c, outPoint: cut };
        b = { ...c, id: nid, inPoint: cut, trans: "none", transMs: 0, order: c.order + 0.5 };
      }
      next = next.flatMap((x) => (x.id === c.id ? [a, b] : [x])); made.push(nid);
    }
  }
  return { clips: normalize(next), made };
}

/** 把 id 移到本轨第 to 位（吸附轨） */
export function moveTo(clips: Clip[], id: string, to: number): Clip[] {
  const c = clips.find((x) => x.id === id); if (!c) return clips;
  const t = trackOf(c); if (t === "subtitle") return clips;
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
  const max = Number(c.srcDur) > 0 ? Number(c.srcDur) : Infinity;
  if (edge === "l") return { ...c, inPoint: r3(Math.max(0, Math.min(c.outPoint - MIN_LEN, c.inPoint + dt))) };
  return { ...c, outPoint: r3(Math.max(c.inPoint + MIN_LEN, Math.min(max, c.outPoint + dt))) };
}

/** 平移字幕 */
export function shiftSub(c: Clip, dt: number): Clip {
  const s = Number(c.start) || 0, e = Number(c.end) || s + 1; const d = Math.max(-s, dt);
  return { ...c, start: r3(s + d), end: r3(e + d) };
}

/* ---------------- 导出 ---------------- */

export const RATIOS = ["16:9", "9:16", "1:1", "4:3"] as const;
export type Ratio = (typeof RATIOS)[number];
export const RESES = ["720p", "1080p"] as const;
export type Res = (typeof RESES)[number];
export function frameSize(ratio: string, res: string): { width: number; height: number } {
  const short = res === "1080p" ? 1080 : 720;
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

export type RenderClip = { id: string; url: string; track: "video" | "audio"; timelineStartMs: number; durationMs: number; sourceInMs: number; sourceOutMs: number; volume: number; transitionIn?: { type: "fade" | "dissolve"; durationMs: number } };
/** 后端渲染（ffmpeg）用的片段表：毫秒整数 */
export function renderPlan(clips: Clip[]): { clips: RenderClip[]; durationMs: number } {
  const out: RenderClip[] = [];
  for (const t of ["video", "audio"] as const) {
    const placed = place(clips, t);
    placed.forEach((p, i) => {
      const tr = transOf(p.clip, placed[i - 1]?.clip);
      const startMs = Math.round(p.start * 1000); const durMs = Math.max(100, Math.round(lenOf(p.clip) * 1000)); const inMs = Math.round(p.clip.inPoint * 1000);
      out.push({ id: p.clip.id, url: p.clip.url, track: t, timelineStartMs: startMs, durationMs: durMs, sourceInMs: inMs, sourceOutMs: inMs + durMs, volume: volOf(p.clip), ...(tr.kind !== "none" && tr.sec > 0 ? { transitionIn: { type: tr.kind, durationMs: Math.round(tr.sec * 1000) } } : {}) });
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
