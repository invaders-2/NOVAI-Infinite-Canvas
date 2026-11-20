/**
 * 浏览器端逐帧导出 MP4（Mediabunny + WebCodecs）：
 *
 *   · 画面：每一帧都用和预览同一个 composeFrame 合成（主画面 + 转场 + 画中画 + 变换 / 关键帧 + 字幕），所见即所得
 *   · 解码：视频片段用 Mediabunny 按帧时间顺序解码（比 <video> 逐帧 seek 快得多，也是逐帧精确的）；
 *     某段解不了（地址读不到、格式不认）就退回隐藏 <video> 逐帧 seek
 *   · 声音：OfflineAudioContext 离线混音（音量 / 变速 / 淡入淡出 / 转场淡入），再编码进同一个 MP4
 *   · 不是边播边录：导出速度取决于机器解码 / 编码速度，不用等视频时长
 */
import {
  ALL_FORMATS, AudioBufferSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH, UrlSource, VideoSampleSink,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, type VideoSample,
} from "mediabunny";
import { FPS, OVERLAP_TRANS, duckGain, duckOf, fadeOf, lenOf, place, speedOf, srcTime, totalOf, transOf, voiceSpans, volOf, type Clip, type Placed } from "./timelineModel";
import { composeFrame, type SubStyle } from "./timelinePlayer";

type Frames = { next(t: number): Promise<CanvasImageSource | null>; close(): void };

/** 一段视频的「按时间要帧」：Mediabunny 顺序解码；时间只会往后走 */
async function mediabunnyFrames(url: string, times: number[]): Promise<Frames | null> {
  try {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack(); if (!track) return null;
    const gen = new VideoSampleSink(track).samplesAtTimestamps(times);
    let last: VideoSample | null = null; let cur: CanvasImageSource | null = null;
    return {
      async next() {
        const r = await gen.next();
        if (r.done) return cur;
        if (r.value) { last?.close(); last = r.value; cur = r.value.toCanvasImageSource(); }
        return cur;
      },
      close() { last?.close(); last = null; void gen.return(undefined); try { input.dispose(); } catch { /* ignore */ } },
    };
  } catch { return null; }
}

/** 退路：隐藏 <video> 逐帧 seek */
async function seekFrames(url: string): Promise<Frames | null> {
  const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.playsInline = true; v.src = url;
  const wait = (ev: string, ms: number) => new Promise<boolean>((res) => { const tm = setTimeout(() => res(false), ms); v.addEventListener(ev, () => { clearTimeout(tm); res(true); }, { once: true }); v.addEventListener("error", () => { clearTimeout(tm); res(false); }, { once: true }); });
  if (!(await wait("loadeddata", 15000))) return null;
  return {
    async next(t: number) {
      const want = Math.min(Math.max(0, t), Math.max(0, (v.duration || t) - 0.02));
      if (Math.abs(v.currentTime - want) > 0.004) { const sk = wait("seeked", 4000); v.currentTime = want; await sk; }
      return v;
    },
    close() { v.removeAttribute("src"); v.load(); },
  };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = url; setTimeout(() => res(im.complete && im.naturalWidth ? im : null), 15000); });
}

/** 离线混音：所有有声音的片段按时间线排好，渲染成一条立体声 AudioBuffer；没有声音返回 null */
async function mixAudio(clips: Clip[], total: number, resolve: (u: string) => Promise<string>): Promise<AudioBuffer | null> {
  const rate = 48000; const length = Math.max(1, Math.ceil(total * rate));
  const ctx = new OfflineAudioContext(2, length, rate);
  let any = false;
  const decoded = new Map<string, AudioBuffer | null>();
  const decode = async (url: string) => {
    if (decoded.has(url)) return decoded.get(url)!;
    let buf: AudioBuffer | null = null;
    try { const ab = await (await fetch(await resolve(url))).arrayBuffer(); buf = await ctx.decodeAudioData(ab); } catch { buf = null; }
    decoded.set(url, buf); return buf;
  };
  const spans = voiceSpans(clips);
  for (const tr of ["video", "overlay", "audio"] as const) {
    const placed = place(clips, tr);
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]; const c = p.clip;
      if (!c.url || c.mediaKind === "image" || volOf(c) <= 0) continue;
      const buf = await decode(c.url); if (!buf) continue;
      any = true;
      const k = speedOf(c); const len = lenOf(c);
      const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = k;
      const g = ctx.createGain(); src.connect(g); g.connect(ctx.destination);
      const vol = volOf(c); const t0 = p.start; const t1 = p.end;
      // 音量包络按 100Hz 采样：音量 × 进场（转场 / 淡入）× 出场（淡出 / 下一段重叠转场）× 背景音乐自动压低
      const tin = transOf(c, placed[i - 1]?.clip); const fd = fadeOf(c);
      const next = tr === "overlay" ? undefined : placed[i + 1]; const tnext = next ? transOf(next.clip, c) : null;
      const inSec = Math.min(len / 2, Math.max(fd.in, tin.kind !== "none" ? tin.sec : 0));
      const outSec = Math.min(len / 2, Math.max(fd.out, tnext && OVERLAP_TRANS.includes(tnext.kind) ? Math.max(0, t1 - next!.start) : 0));
      const level = duckOf(c);
      const n = Math.max(2, Math.ceil(len * 100) + 1); const curve = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const tt = t0 + (len * j) / (n - 1); let gg = vol;
        if (inSec > 0) gg *= Math.min(1, (tt - t0) / inSec);
        if (outSec > 0) gg *= Math.min(1, Math.max(0, (t1 - tt) / outSec));
        if (level < 1) gg *= duckGain(spans, tt, level);
        curve[j] = gg;
      }
      g.gain.setValueCurveAtTime(curve, t0, Math.max(0.01, len));
      src.start(t0, Math.max(0, c.inPoint), len * k);
    }
  }
  if (!any) return null;
  return ctx.startRendering();
}

export async function exportMp4Browser(
  clips: Clip[], size: { width: number; height: number }, resolve: (url: string) => Promise<string>,
  opts: { onProgress?: (f: number, label: string) => void; subStyle?: SubStyle; fit?: "contain" | "cover"; signal?: AbortSignal } = {},
): Promise<Blob> {
  if (typeof VideoEncoder !== "function") throw new Error("当前环境不支持 WebCodecs，没法在本机导出 MP4");
  const total = totalOf(clips); if (total <= 0) throw new Error("时间线是空的");
  const { width: W, height: H } = size; const N = Math.max(1, Math.ceil(total * FPS - 1e-6));
  const vcodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"], { width: W, height: H });
  if (!vcodec) throw new Error("本机没有可用的视频编码器");
  const progress = opts.onProgress || (() => undefined);

  progress(0, "混音");
  const audio = await mixAudio(clips, total, resolve);
  const acodec = audio ? await getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: 2, sampleRate: audio.sampleRate }) : null;

  // 每段画面准备好取帧器：只为它在画面上出现的那些帧的源时间解码
  progress(0, "准备素材");
  const visual: Placed[] = [...place(clips, "video"), ...place(clips, "overlay")];
  const frames = new Map<string, Frames>(); const images = new Map<string, HTMLImageElement>();
  await Promise.all(visual.map(async (p) => {
    const c = p.clip; if (!c.url) return;
    const url = await resolve(c.url);
    if (c.mediaKind === "image") { const im = await loadImage(url); if (im) images.set(c.id, im); return; }
    const times: number[] = [];
    for (let i = Math.max(0, Math.floor(p.start * FPS)); i < N; i++) { const t = i / FPS; if (t >= p.end) break; if (t >= p.start) times.push(srcTime(p, t)); }
    const f = (await mediabunnyFrames(url, times)) || (await seekFrames(url));
    if (f) frames.set(c.id, f);
  }));

  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx2d = canvas.getContext("2d")!;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const vsrc = new CanvasSource(canvas, { codec: vcodec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(vsrc, { frameRate: FPS });
  const asrc = audio && acodec ? new AudioBufferSource({ codec: acodec, bitrate: QUALITY_HIGH }) : null;
  if (asrc) output.addAudioTrack(asrc);
  try {
    await output.start();
    const current = new Map<string, CanvasImageSource | null>();
    for (let i = 0; i < N; i++) {
      if (opts.signal?.aborted) throw new Error("已取消导出");
      const t = i / FPS;
      current.clear();
      for (const p of visual) {
        if (t < p.start || t >= p.end) continue;
        const im = images.get(p.clip.id); if (im) { current.set(p.clip.id, im); continue; }
        const f = frames.get(p.clip.id); if (f) current.set(p.clip.id, await f.next(srcTime(p, t)));
      }
      composeFrame(ctx2d, W, H, t, clips, (c) => current.get(c.id), opts.fit || "contain", opts.subStyle);
      await vsrc.add(t, 1 / FPS);
      if (i % 6 === 0) progress(i / N, "合成画面");
    }
    vsrc.close();
    if (asrc && audio) { progress(1, "编码声音"); await asrc.add(audio); asrc.close(); }
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch { /* ignore */ }
    throw e;
  } finally {
    for (const f of frames.values()) f.close();
  }
  const buf = target.buffer; if (!buf || !buf.byteLength) throw new Error("导出结果为空");
  return new Blob([buf], { type: "video/mp4" });
}
