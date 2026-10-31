/**
 * 时间线播放引擎：预览和导出 WebM 用同一套，所见即所得。
 *
 *   · 每个片段一个 <video>/<audio>（切开的两半可能在溶解时同时出现，所以不共用元素）
 *   · 画面画到一块 canvas 上：按画幅留黑边，转场按透明度叠，字幕画在最上层
 *   · 声音走 WebAudio：每段一个增益（音量 0–2 + 转场淡入淡出），预览接扬声器，导出接录制流
 *   · 时间以墙上时钟为准；元素落后/超前超过 0.25s 就校正
 */
import { activeAt, lenOf, place, srcTime, totalOf, transOf, volOf, type Clip, type Placed, type Track } from "./timelineModel";

type Slot = { clip: Clip; url: string; el: HTMLMediaElement; gain: GainNode | null; ready: Promise<boolean> };
export type PlayerOptions = {
  canvas: HTMLCanvasElement;
  width: number; height: number;
  resolve: (url: string) => Promise<string>;
  /** 导出时传录制用的音频出口；不传就接扬声器 */
  audioOut?: (ctx: AudioContext) => AudioNode;
  onTime?: (t: number) => void;
  onEnd?: () => void;
};

const waitFor = (el: HTMLMediaElement, ev: string, ms = 8000) => new Promise<boolean>((res) => {
  const done = (ok: boolean) => { clearTimeout(tm); el.removeEventListener(ev, okh); el.removeEventListener("error", bad); res(ok); };
  const okh = () => done(true); const bad = () => done(false); const tm = setTimeout(() => done(false), ms);
  el.addEventListener(ev, okh, { once: true }); el.addEventListener("error", bad, { once: true });
});

export class TimelinePlayer {
  private o: PlayerOptions; private ctx2d: CanvasRenderingContext2D; private slots = new Map<string, Slot>();
  private clips: Clip[] = []; private ac: AudioContext | null = null; private out: AudioNode | null = null;
  private raf = 0; private wall = 0; t = 0; playing = false; private dead = false;

  constructor(o: PlayerOptions) {
    this.o = o; o.canvas.width = o.width; o.canvas.height = o.height;
    this.ctx2d = o.canvas.getContext("2d")!;
  }

  ensureAudio(): AudioContext | null {
    if (this.ac) return this.ac;
    if (typeof AudioContext !== "function") return null;
    this.ac = new AudioContext(); this.out = this.o.audioOut ? this.o.audioOut(this.ac) : this.ac.destination;
    for (const s of this.slots.values()) this.wire(s);
    return this.ac;
  }
  private wire(s: Slot) {
    if (!this.ac || s.gain) return;
    try { const src = this.ac.createMediaElementSource(s.el); const g = this.ac.createGain(); src.connect(g); g.connect(this.out!); s.gain = g; }
    catch { s.gain = null; }
  }

  /** 换一组片段：同 id 同地址的元素沿用，其余新建 / 释放 */
  async setClips(clips: Clip[]) {
    this.clips = clips.filter((c) => c.type === "subtitle" || c.url);
    const keep = new Set<string>();
    await Promise.all(this.clips.filter((c) => c.type !== "subtitle").map(async (c) => {
      keep.add(c.id);
      const old = this.slots.get(c.id);
      if (old && old.clip.url === c.url) { old.clip = c; return; }
      if (old) this.drop(old);
      const url = await this.o.resolve(c.url); if (this.dead) return;
      const el = document.createElement(c.mediaKind === "audio" ? "audio" : "video") as HTMLMediaElement;
      el.preload = "auto"; el.crossOrigin = "anonymous"; (el as HTMLVideoElement).playsInline = true; el.src = url;
      const slot: Slot = { clip: c, url, el, gain: null, ready: waitFor(el, "loadeddata", 15000) };
      this.slots.set(c.id, slot); this.wire(slot);
    }));
    for (const [id, s] of this.slots) if (!keep.has(id)) this.drop(s);
  }
  private drop(s: Slot) { try { s.el.pause(); s.el.removeAttribute("src"); s.el.load(); } catch { /* ignore */ } this.slots.delete(s.clip.id); }

  get total() { return totalOf(this.clips); }
  /** 已加载素材的真实时长（秒），按片段 id */
  durations(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, s] of this.slots) if (Number.isFinite(s.el.duration) && s.el.duration > 0) out[id] = Math.round(s.el.duration * 1000) / 1000;
    return out;
  }

  /** 停在 t，画出这一帧 */
  async seek(t: number) {
    this.t = Math.max(0, Math.min(this.total, t));
    if (this.playing) { this.wall = performance.now() - this.t * 1000; this.sync(true); return; }
    const vis = activeAt(this.clips, "video", this.t);
    await Promise.all(vis.map(async (p) => {
      const s = this.slots.get(p.clip.id); if (!s) return;
      await s.ready; const want = srcTime(p, this.t);
      if (Math.abs(s.el.currentTime - want) > 0.01) { const sk = waitFor(s.el, "seeked", 3000); s.el.currentTime = want; await sk; }
    }));
    this.draw(this.t); this.o.onTime?.(this.t);
  }

  async play(from = this.t) {
    if (this.playing) return;
    if (from >= this.total - 0.05) from = 0;
    this.ensureAudio(); try { await this.ac?.resume(); } catch { /* ignore */ }
    await Promise.all([...this.slots.values()].map((s) => s.ready));
    this.t = from; this.playing = true; this.wall = performance.now() - from * 1000;
    this.sync(true);
    const tick = () => {
      if (!this.playing) return;
      this.t = (performance.now() - this.wall) / 1000;
      if (this.t >= this.total) { this.t = this.total; this.draw(this.t); this.o.onTime?.(this.t); this.pause(); this.o.onEnd?.(); return; }
      this.sync(false); this.draw(this.t); this.o.onTime?.(this.t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false; cancelAnimationFrame(this.raf);
    for (const s of this.slots.values()) try { s.el.pause(); } catch { /* ignore */ }
  }

  /** 让每个元素的播放状态和位置跟上时间轴 */
  private sync(hard: boolean) {
    const t = this.t;
    for (const tr of ["video", "audio"] as Track[]) {
      const placed = place(this.clips, tr);
      placed.forEach((p, i) => {
        const s = this.slots.get(p.clip.id); if (!s) return;
        const on = t >= p.start && t < p.end;
        if (!on) {
          if (!s.el.paused) s.el.pause();
          // 快轮到的片段提前跳到入点，切换时不卡
          if (p.start > t && p.start - t < 1.2 && Math.abs(s.el.currentTime - p.clip.inPoint) > 0.05) s.el.currentTime = p.clip.inPoint;
          return;
        }
        const want = srcTime(p, t);
        if (hard || Math.abs(s.el.currentTime - want) > 0.25) s.el.currentTime = want;
        if (s.el.paused) void s.el.play().catch(() => undefined);
        // 音量：本段音量 × 进场淡入 × （下一段溶解进来时）淡出
        const next = placed[i + 1]; const tin = transOf(p.clip, placed[i - 1]?.clip); const tnext = next ? transOf(next.clip, p.clip) : null;
        let g = volOf(p.clip);
        if (tin.kind !== "none" && tin.sec > 0) g *= Math.min(1, (t - p.start) / tin.sec);
        if (tnext && tnext.kind === "dissolve" && tnext.sec > 0 && t > next!.start) g *= Math.max(0, 1 - (t - next!.start) / tnext.sec);
        if (s.gain) s.gain.gain.value = g; else s.el.volume = Math.max(0, Math.min(1, g));
      });
    }
  }

  private draw(t: number) {
    const c = this.ctx2d; const W = this.o.width, H = this.o.height;
    c.globalAlpha = 1; c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    const placed = place(this.clips, "video");
    for (const p of placed.filter((x) => t >= x.start && t < x.end)) {
      const s = this.slots.get(p.clip.id); const v = s?.el as HTMLVideoElement | undefined;
      if (!v || !v.videoWidth) continue;
      const tr = transOf(p.clip, placed[p.index - 1]?.clip);
      c.globalAlpha = tr.kind !== "none" && tr.sec > 0 ? Math.max(0, Math.min(1, (t - p.start) / tr.sec)) : 1;
      const k = Math.min(W / v.videoWidth, H / v.videoHeight); const dw = v.videoWidth * k, dh = v.videoHeight * k;
      if (tr.kind === "fade" || c.globalAlpha >= 1) { const a = c.globalAlpha; c.globalAlpha = 1; c.fillStyle = "#000"; c.fillRect(0, 0, W, H); c.globalAlpha = a; }
      try { c.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch { /* 还没解码 */ }
    }
    c.globalAlpha = 1;
    drawSubs(c, W, H, activeAt(this.clips, "subtitle", t));
  }

  destroy() {
    this.dead = true; this.pause();
    for (const s of [...this.slots.values()]) this.drop(s);
    try { void this.ac?.close(); } catch { /* ignore */ }
  }
}

function drawSubs(c: CanvasRenderingContext2D, W: number, H: number, subs: Placed[]) {
  const size = Math.round(Math.min(W, H) * 0.048);
  for (const p of subs) {
    const text = String(p.clip.text || "").trim(); if (!text) continue;
    c.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`; c.textAlign = "center"; c.textBaseline = "bottom";
    const maxW = W * 0.86; const lines: string[] = []; let line = "";
    for (const ch of text) { if (c.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; } else line += ch; }
    if (line) lines.push(line);
    const lh = size * 1.3; const base = H - size * 1.6;
    lines.slice(-3).forEach((v, i, all) => {
      const y = base - (all.length - 1 - i) * lh;
      c.lineWidth = Math.max(3, size / 6); c.strokeStyle = "rgba(0,0,0,.85)"; c.lineJoin = "round"; c.strokeText(v, W / 2, y);
      c.fillStyle = "#fff"; c.fillText(v, W / 2, y);
    });
  }
  c.textAlign = "start"; c.textBaseline = "alphabetic";
}

/** 导出 WebM：用同一个播放引擎从头播到尾，边播边录 */
export async function recordWebM(clips: Clip[], size: { width: number; height: number }, resolve: (url: string) => Promise<string>, onProgress?: (f: number) => void): Promise<Blob> {
  if (typeof MediaRecorder !== "function") throw new Error("当前环境不支持录制");
  const canvas = document.createElement("canvas");
  let dest: MediaStreamAudioDestinationNode | null = null;
  let finish = () => {}; const ended = new Promise<void>((r) => { finish = r; });
  const player = new TimelinePlayer({ canvas, ...size, resolve, audioOut: (ac) => (dest = ac.createMediaStreamDestination()), onTime: (t) => onProgress?.(t / Math.max(0.1, player.total)), onEnd: () => finish() });
  try {
    await player.setClips(clips);
    if (!place(clips, "video").length) throw new Error("视频轨上还没有片段");
    await player.seek(0);
    player.ensureAudio();
    const audioTracks = dest ? (dest as MediaStreamAudioDestinationNode).stream.getAudioTracks() : [];
    const tracks = [...canvas.captureStream(30).getVideoTracks(), ...audioTracks];
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: size.height >= 1080 ? 8_000_000 : 5_000_000 } : undefined);
    const chunks: Blob[] = []; rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
    rec.start(250); await player.play(0); await ended;
    await new Promise((r) => setTimeout(r, 200)); rec.stop(); await stopped;
    const blob = new Blob(chunks, { type: mime || "video/webm" }); if (!blob.size) throw new Error("录制结果为空");
    return blob;
  } finally { player.destroy(); }
}

export const clipLen = lenOf;

/** 片段缩略图：在源视频 at 秒处取一帧，缩成 h 像素高的 JPEG（按地址 + 时间缓存） */
const thumbs = new Map<string, Promise<string>>();
export function grabThumb(url: string, at: number, h = 56): Promise<string> {
  const key = url.length + ":" + url.slice(-64) + "@" + at.toFixed(2);
  let p = thumbs.get(key);
  if (!p) {
    p = (async () => {
      const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.src = url;
      try {
        if (!(await waitFor(v, "loadeddata", 10000))) return "";
        const sk = waitFor(v, "seeked", 4000); v.currentTime = Math.min(Math.max(0, at), Math.max(0, (v.duration || at) - 0.05)); await sk;
        const c = document.createElement("canvas"); c.height = h; c.width = Math.max(1, Math.round((v.videoWidth / Math.max(1, v.videoHeight)) * h));
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.7);
      } catch { return ""; } finally { v.removeAttribute("src"); v.load(); }
    })();
    thumbs.set(key, p);
  }
  return p;
}
