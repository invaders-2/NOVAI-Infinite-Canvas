/**
 * 时间线播放引擎：预览和导出 WebM 用同一套，所见即所得。
 *
 *   · 每个片段一个 <video>/<audio>（切开的两半可能在溶解时同时出现，所以不共用元素）
 *   · 画面画到一块 canvas 上：按画幅留黑边，转场按透明度叠，字幕画在最上层
 *   · 声音走 WebAudio：每段一个增益（音量 0–2 + 转场淡入淡出），预览接扬声器，导出接录制流
 *   · 时间以墙上时钟为准；元素落后/超前超过 0.25s 就校正
 */
import { activeAt, colorFilter, duckGain, duckOf, fadeOf, lenOf, OVERLAP_TRANS, place, speedOf, srcTime, tfAt, totalOf, transOf, voiceSpans, volOf, type Clip, type Placed, type Track, type TransKind } from "./timelineModel";

/** 图片片段用 <img>，其余用 <video>/<audio>；isMedia 区分两类 */
type Slot = { clip: Clip; url: string; el: HTMLMediaElement; img: HTMLImageElement | null; gain: GainNode | null; ready: Promise<boolean> };
/** 字幕样式（整条时间线共用）：字号 s/m/l，位置 bottom/middle/top */
export type SubStyle = { size?: "s" | "m" | "l"; pos?: "bottom" | "middle" | "top" };
export type PlayerOptions = {
  canvas: HTMLCanvasElement;
  width: number; height: number;
  resolve: (url: string) => Promise<string>;
  /** 导出时传录制用的音频出口；不传就接扬声器 */
  audioOut?: (ctx: AudioContext) => AudioNode;
  onTime?: (t: number) => void;
  onEnd?: () => void;
  subStyle?: SubStyle;
  /** 画面适配：contain 留黑边（默认）/ cover 铺满裁切 */
  fit?: "contain" | "cover";
  /** 播放区间（入点 / 出点）：只在区间内播，loop 时到出点回到入点 */
  range?: { start: number; end: number } | null;
  loop?: boolean;
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
  private seekWant: number | null = null; private seeking = false;

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
    if (!this.ac || s.gain || s.img) return;
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
      if (old && old.clip.url === c.url && old.clip.mediaKind === c.mediaKind) { old.clip = c; return; }
      if (old) this.drop(old);
      const url = await this.o.resolve(c.url); if (this.dead) return;
      if (c.mediaKind === "image") {
        const img = new Image(); img.crossOrigin = "anonymous"; img.decoding = "async";
        const ready = new Promise<boolean>((res) => { img.onload = () => res(true); img.onerror = () => res(false); setTimeout(() => res(img.complete && img.naturalWidth > 0), 15000); });
        img.src = url;
        // el 只是占位（图片没有播放状态），所有媒体操作都先判断 s.img
        this.slots.set(c.id, { clip: c, url, el: document.createElement("audio"), img, gain: null, ready });
        return;
      }
      const el = document.createElement(c.mediaKind === "audio" ? "audio" : "video") as HTMLMediaElement;
      el.preload = "auto"; el.crossOrigin = "anonymous"; (el as HTMLVideoElement).playsInline = true; el.src = url;
      const slot: Slot = { clip: c, url, el, img: null, gain: null, ready: waitFor(el, "loadeddata", 15000) };
      this.slots.set(c.id, slot); this.wire(slot);
    }));
    for (const [id, s] of this.slots) if (!keep.has(id)) this.drop(s);
  }
  private drop(s: Slot) { try { if (s.img) s.img.src = ""; else { s.el.pause(); s.el.removeAttribute("src"); s.el.load(); } } catch { /* ignore */ } this.slots.delete(s.clip.id); }
  /** 预览 / 导出共用的字幕样式（改了立刻重画当前帧） */
  setSubStyle(st: SubStyle | undefined) { this.o.subStyle = st; if (!this.playing) this.draw(this.t); }
  /** 适配方式 / 播放区间：不重建播放器，避免换一下就把已加载的素材全丢了 */
  setFit(fit: "contain" | "cover") { this.o.fit = fit; if (!this.playing) this.draw(this.t); }
  setRange(range: { start: number; end: number } | null, loop: boolean) { this.o.range = range; this.o.loop = loop; }

  get total() { return totalOf(this.clips); }
  /** 已加载素材的真实时长（秒），按片段 id */
  durations(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, s] of this.slots) if (!s.img && Number.isFinite(s.el.duration) && s.el.duration > 0) out[id] = Math.round(s.el.duration * 1000) / 1000;
    return out;
  }

  /** 拖动播放头 / 点刻度尺时用：连续调用只保留最后一个目标，避免每次都等 <video> seek 完成 */
  requestSeek(t: number) {
    this.seekWant = t;
    if (!this.seeking) void this.drainSeek();
  }
  private async drainSeek() {
    this.seeking = true;
    while (this.seekWant != null) { const t = this.seekWant; this.seekWant = null; await this.seek(t); }
    this.seeking = false;
  }
  /** 停在 t，画出这一帧 */
  async seek(t: number) {
    this.t = Math.max(0, Math.min(this.total, t));
    if (this.playing) { this.wall = performance.now() - this.t * 1000; this.sync(true); return; }
    const vis = [...activeAt(this.clips, "video", this.t), ...activeAt(this.clips, "overlay", this.t)];
    await Promise.all(vis.map(async (p) => {
      const s = this.slots.get(p.clip.id); if (!s) return;
      await s.ready; if (s.img) return; const want = srcTime(p, this.t);
      if (Math.abs(s.el.currentTime - want) > 0.01) { const sk = waitFor(s.el, "seeked", 3000); s.el.currentTime = want; await sk; }
    }));
    this.draw(this.t); this.o.onTime?.(this.t);
  }

  async play(from = this.t) {
    if (this.playing) return;
    const rg = this.o.range;
    if (rg && (from < rg.start || from >= rg.end)) from = rg.start;
    else if (from >= this.total - 0.05) from = 0;
    this.ensureAudio(); try { await this.ac?.resume(); } catch { /* ignore */ }
    await Promise.all([...this.slots.values()].map((s) => s.ready));
    this.t = from; this.playing = true; this.wall = performance.now() - from * 1000;
    this.sync(true);
    const tick = () => {
      if (!this.playing) return;
      this.t = (performance.now() - this.wall) / 1000;
      // 区间播放：到出点回入点（循环）或停下（不循环），停下的位置就是出点
      const rg = this.o.range;
      if (rg && this.t >= rg.end) {
        if (this.o.loop) { this.wall = performance.now() - rg.start * 1000; this.t = rg.start; this.sync(true); this.draw(this.t); this.o.onTime?.(this.t); this.raf = requestAnimationFrame(tick); return; }
        this.t = rg.end; this.draw(this.t); this.o.onTime?.(this.t); this.pause(); this.o.onEnd?.(); return;
      }
      if (this.t >= this.total) { this.t = this.total; this.draw(this.t); this.o.onTime?.(this.t); this.pause(); this.o.onEnd?.(); return; }
      this.sync(false); this.draw(this.t); this.o.onTime?.(this.t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false; cancelAnimationFrame(this.raf);
    for (const s of this.slots.values()) try { if (!s.img) s.el.pause(); } catch { /* ignore */ }
  }

  /** 让每个元素的播放状态和位置跟上时间轴 */
  private sync(hard: boolean) {
    const t = this.t; const spans = voiceSpans(this.clips);
    for (const tr of ["video", "overlay", "audio"] as Track[]) {
      const placed = place(this.clips, tr);
      placed.forEach((p, i) => {
        const s = this.slots.get(p.clip.id); if (!s || s.img) return;
        const on = t >= p.start && t < p.end;
        if (!on) {
          if (!s.el.paused) s.el.pause();
          // 快轮到的片段提前跳到入点，切换时不卡
          if (p.start > t && p.start - t < 1.2 && Math.abs(s.el.currentTime - p.clip.inPoint) > 0.05) s.el.currentTime = p.clip.inPoint;
          return;
        }
        const want = srcTime(p, t); const rate = speedOf(p.clip);
        if (Math.abs(s.el.playbackRate - rate) > 1e-3) s.el.playbackRate = rate;
        if (hard || Math.abs(s.el.currentTime - want) > 0.25 * rate) s.el.currentTime = want;
        if (s.el.paused) void s.el.play().catch(() => undefined);
        // 音量：本段音量 × 进场淡入 × （下一段溶解进来时）淡出
        const next = placed[i + 1]; const tin = transOf(p.clip, placed[i - 1]?.clip); const tnext = next ? transOf(next.clip, p.clip) : null;
        let g = volOf(p.clip);
        if (tin.kind !== "none" && tin.sec > 0) g *= Math.min(1, (t - p.start) / tin.sec);
        if (tnext && OVERLAP_TRANS.includes(tnext.kind) && tnext.sec > 0 && t > next!.start) g *= Math.max(0, 1 - (t - next!.start) / tnext.sec);
        // 背景音乐自动压低：画面里有声音的时候降下去
        if (tr === "audio") g *= duckGain(spans, t, duckOf(p.clip));
        // 片段自己的声音淡入 / 淡出
        const fd = fadeOf(p.clip);
        if (fd.in > 0) g *= Math.min(1, (t - p.start) / fd.in);
        if (fd.out > 0) g *= Math.min(1, Math.max(0, (p.end - t) / fd.out));
        if (s.gain) s.gain.gain.value = g; else s.el.volume = Math.max(0, Math.min(1, g));
      });
    }
  }

  private draw(t: number) {
    composeFrame(this.ctx2d, this.o.width, this.o.height, t, this.clips, (c) => { const s = this.slots.get(c.id); return (s?.img || s?.el) as CanvasImageSource | undefined; }, this.o.fit || "contain", this.o.subStyle);
  }

  destroy() {
    this.dead = true; this.pause();
    for (const s of [...this.slots.values()]) this.drop(s);
    try { void this.ac?.close(); } catch { /* ignore */ }
  }
}

/** 画面尺寸：<video> 用 videoWidth，<img> 用 naturalWidth，其余（解码出来的帧 / canvas）用 width */
function sizeOf(v: CanvasImageSource): [number, number] {
  const a = v as Partial<HTMLVideoElement & HTMLImageElement & { displayWidth: number; displayHeight: number; width: number; height: number }>;
  if (a.videoWidth) return [a.videoWidth, a.videoHeight || 0];
  if (a.naturalWidth) return [a.naturalWidth, a.naturalHeight || 0];
  if (a.displayWidth) return [a.displayWidth, a.displayHeight || 0];
  return [Number(a.width) || 0, Number(a.height) || 0];
}
/** 按变换画一层：先按适配方式算出「铺在画幅里」的大小，再缩放 s、把中心放到 (x, y)、旋转 r、不透明度 o × 额外 alpha */
function drawLayer(c: CanvasRenderingContext2D, W: number, H: number, v: CanvasImageSource, clip: Clip, lt: number, fit: "contain" | "cover", alpha: number) {
  const [vw, vh] = sizeOf(v); if (!vw || !vh) return;
  const f = tfAt(clip, lt);
  const k = (fit === "cover" ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh)) * Math.max(0.01, f.s);
  const dw = vw * k, dh = vh * k;
  c.save(); c.globalAlpha = Math.max(0, Math.min(1, alpha * f.o)); const cf = colorFilter(clip); if (cf) c.filter = cf;
  c.translate(f.x * W, f.y * H); if (f.r) c.rotate((f.r * Math.PI) / 180);
  try { c.drawImage(v, -dw / 2, -dh / 2, dw, dh); } catch { /* 还没解码 */ }
  c.restore();
}
/**
 * 合成一帧：主画面（含转场）→ 画中画 → 字幕。预览播放器和逐帧导出共用，保证所见即所得。
 * src(clip) 返回这一段当前要画的画面（播放器给 <video>/<img>，导出给解码好的帧）。
 */
export function composeFrame(c: CanvasRenderingContext2D, W: number, H: number, t: number, clips: Clip[], src: (clip: Clip) => CanvasImageSource | null | undefined, fit: "contain" | "cover", subStyle?: SubStyle) {
  c.globalAlpha = 1; c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
  const placed = place(clips, "video");
  for (const p of placed.filter((x) => t >= x.start && t < x.end)) {
    const v = src(p.clip); if (!v) continue;
    const tr = transOf(p.clip, placed[p.index - 1]?.clip);
    const a = tr.kind !== "none" && tr.sec > 0 ? Math.max(0, Math.min(1, (t - p.start) / tr.sec)) : 1;
    if (tr.kind === "fade" || a >= 1) { c.globalAlpha = 1; c.fillStyle = "#000"; c.fillRect(0, 0, W, H); }
    if (a < 1 && tr.kind !== "fade" && tr.kind !== "dissolve") { drawTrans(c, W, H, tr.kind, a, () => drawLayer(c, W, H, v, p.clip, t - p.start, fit, tr.kind === "zoom" ? a : 1)); continue; }
    drawLayer(c, W, H, v, p.clip, t - p.start, fit, a);
  }
  for (const p of place(clips, "overlay").filter((x) => t >= x.start && t < x.end)) {
    const v = src(p.clip); if (v) drawLayer(c, W, H, v, p.clip, t - p.start, "contain", 1);
  }
  c.globalAlpha = 1;
  drawSubs(c, W, H, activeAt(clips, "subtitle", t), subStyle);
}

/** 擦除 / 推入 / 放大进场：a 是进场进度 0→1 */
function drawTrans(c: CanvasRenderingContext2D, W: number, H: number, kind: TransKind, a: number, paint: () => void) {
  const e = a * a * (3 - 2 * a);
  c.save();
  if (kind === "wipe") { c.beginPath(); c.rect(0, 0, W * e, H); c.clip(); }
  else if (kind === "slide") c.translate(W * (1 - e), 0);
  else if (kind === "zoom") { const k = 1.25 - 0.25 * e; c.translate(W / 2, H / 2); c.scale(k, k); c.translate(-W / 2, -H / 2); }
  paint();
  c.restore();
}

function drawSubs(c: CanvasRenderingContext2D, W: number, H: number, subs: Placed[], st?: SubStyle) {
  const size = Math.round(Math.min(W, H) * ({ s: 0.036, m: 0.048, l: 0.064 }[st?.size || "m"] || 0.048));
  for (const p of subs) {
    const text = String(p.clip.text || "").trim(); if (!text) continue;
    c.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`; c.textAlign = "center"; c.textBaseline = "bottom";
    const maxW = W * 0.86; const lines: string[] = []; let line = "";
    for (const ch of text) { if (c.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; } else line += ch; }
    if (line) lines.push(line);
    const lh = size * 1.3; const shown = lines.slice(-3); const block = shown.length * lh;
    // 底部 / 居中 / 顶部：base 是最后一行文字的底线
    const base = st?.pos === "top" ? size * 1.6 + block - (lh - size) : st?.pos === "middle" ? (H + block) / 2 : H - size * 1.6;
    shown.forEach((v, i, all) => {
      const y = base - (all.length - 1 - i) * lh;
      c.lineWidth = Math.max(3, size / 6); c.strokeStyle = "rgba(0,0,0,.85)"; c.lineJoin = "round"; c.strokeText(v, W / 2, y);
      c.fillStyle = "#fff"; c.fillText(v, W / 2, y);
    });
  }
  c.textAlign = "start"; c.textBaseline = "alphabetic";
}

/** 导出 WebM：用同一个播放引擎从头播到尾，边播边录 */
export async function recordWebM(clips: Clip[], size: { width: number; height: number }, resolve: (url: string) => Promise<string>, onProgress?: (f: number) => void, subStyle?: SubStyle): Promise<Blob> {
  if (typeof MediaRecorder !== "function") throw new Error("当前环境不支持录制");
  const canvas = document.createElement("canvas");
  let dest: MediaStreamAudioDestinationNode | null = null;
  let finish = () => {}; const ended = new Promise<void>((r) => { finish = r; });
  const player = new TimelinePlayer({ canvas, ...size, resolve, subStyle, audioOut: (ac) => (dest = ac.createMediaStreamDestination()), onTime: (t) => onProgress?.(t / Math.max(0.1, player.total)), onEnd: () => finish() });
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
