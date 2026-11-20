/**
 * 剪辑时间线的 AI 辅助（全部在本机跑，不花额度；自动字幕除外，它走「设置 → 通用 → 语音转写」那条通道）：
 *
 *   · detectScenes：按颜色直方图找镜头切换点（一段生成视频里常常拼着好几个镜头）
 *   · detectSilence：按音量找静音段（口播里的停顿、开头结尾的空白）
 *   · mixToWav：把整条时间线的声音混成 16kHz 单声道 WAV，交给后端转写成带时间的字幕
 */
import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";
import { fadeOf, lenOf, place, speedOf, volOf, type Clip } from "./timelineModel";

/** 在 [a, b) 源时间里找镜头切换点（源秒数，升序）。step 是采样间隔，越小越准越慢 */
export async function detectScenes(url: string, a: number, b: number, opts: { step?: number; threshold?: number; minGap?: number } = {}): Promise<number[]> {
  const step = opts.step ?? 1 / 8; const thr = opts.threshold ?? 0.42; const minGap = opts.minGap ?? 0.6;
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack(); if (!track) throw new Error("读不到视频画面");
    const sink = new CanvasSink(track, { width: 64, height: 36, fit: "fill", poolSize: 2 });
    const times: number[] = []; for (let t = a; t < b; t += step) times.push(t);
    const hists: Float32Array[] = []; const at: number[] = [];
    let i = 0;
    for await (const w of sink.canvasesAtTimestamps(times)) {
      const t = times[i++];
      if (!w) continue;
      const cv = w.canvas as HTMLCanvasElement | OffscreenCanvas;
      const ctx = (cv as HTMLCanvasElement).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
      if (!ctx) continue;
      const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const h = new Float32Array(48); const n = px.length / 4;
      for (let p = 0; p < px.length; p += 4) { h[px[p] >> 4]++; h[16 + (px[p + 1] >> 4)]++; h[32 + (px[p + 2] >> 4)]++; }
      for (let k = 0; k < 48; k++) h[k] /= n;
      hists.push(h); at.push(t);
    }
    const cuts: number[] = [];
    for (let k = 1; k < hists.length; k++) {
      let d = 0; for (let j = 0; j < 48; j++) d += Math.abs(hists[k][j] - hists[k - 1][j]);
      d /= 3; // 0..2 → 三个通道平均后 0..~0.67 一类的量级
      if (d > thr * 0.5 && (!cuts.length || at[k] - cuts[cuts.length - 1] >= minGap) && at[k] - a >= minGap && b - at[k] >= minGap) cuts.push(Math.round(at[k] * 1000) / 1000);
    }
    return cuts;
  } finally { try { input.dispose(); } catch { /* ignore */ } }
}

/** 解码一段素材的声音（失败返回 null：没有音轨 / 格式不认） */
async function decodeAudio(url: string, rate = 16000): Promise<AudioBuffer | null> {
  try {
    const ab = await (await fetch(url)).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, rate);
    return await ctx.decodeAudioData(ab);
  } catch { return null; }
}

/** 在 [a, b) 源时间里找静音段：低于 dbThreshold 且至少 minLen 秒。返回源秒数区间（已经往里各收 pad 秒，留一点呼吸） */
export async function detectSilence(url: string, a: number, b: number, opts: { db?: number; minLen?: number; pad?: number } = {}): Promise<Array<[number, number]> | null> {
  const db = opts.db ?? -38; const minLen = opts.minLen ?? 0.5; const pad = opts.pad ?? 0.12;
  const buf = await decodeAudio(url); if (!buf) return null;
  const data = buf.getChannelData(0); const sr = buf.sampleRate; const win = Math.round(sr * 0.03);
  const thr = Math.pow(10, db / 20);
  const out: Array<[number, number]> = []; let start = -1;
  const i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(data.length, Math.ceil(b * sr));
  for (let i = i0; i < i1; i += win) {
    let sum = 0; const end = Math.min(i1, i + win);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    const rms = Math.sqrt(sum / Math.max(1, end - i)); const t = i / sr;
    if (rms < thr) { if (start < 0) start = t; }
    else if (start >= 0) { if (t - start >= minLen) out.push([start, t]); start = -1; }
  }
  if (start >= 0 && b - start >= minLen) out.push([start, b]);
  return out.map(([s, e]) => [Math.round((s <= a + 1e-3 ? s : s + pad) * 1000) / 1000, Math.round((e >= b - 1e-3 ? e : e - pad) * 1000) / 1000] as [number, number]).filter(([s, e]) => e - s >= 0.2);
}

/** 整条时间线的声音混成 16kHz 单声道（音量 / 变速 / 淡入淡出都算上），编码成 WAV；没有声音返回 null */
export async function mixToWav(clips: Clip[], total: number, resolve: (u: string) => Promise<string>): Promise<Blob | null> {
  const rate = 16000; const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(total * rate)), rate);
  let any = false; const cache = new Map<string, AudioBuffer | null>();
  for (const tr of ["video", "overlay", "audio"] as const) {
    for (const p of place(clips, tr)) {
      const c = p.clip; if (!c.url || c.mediaKind === "image" || volOf(c) <= 0) continue;
      if (!cache.has(c.url)) { let b: AudioBuffer | null = null; try { b = await ctx.decodeAudioData(await (await fetch(await resolve(c.url))).arrayBuffer()); } catch { b = null; } cache.set(c.url, b); }
      const buf = cache.get(c.url); if (!buf) continue;
      any = true;
      const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = speedOf(c);
      const g = ctx.createGain(); g.gain.value = volOf(c); src.connect(g); g.connect(ctx.destination);
      const fd = fadeOf(c); void fd;
      src.start(p.start, Math.max(0, c.inPoint), lenOf(c) * speedOf(c));
    }
  }
  if (!any) return null;
  const out = await ctx.startRendering();
  return wav(out.getChannelData(0), rate);
}

function wav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: "audio/wav" });
}

export type SubSeg = { start: number; end: number; text: string };
/** 后端转写成带时间的字幕段 */
export async function transcribeSegments(audio: Blob, lang = "zh"): Promise<{ ok: boolean; segments: SubSeg[]; error?: string }> {
  const fd = new FormData(); fd.append("audio", new File([audio], "timeline.wav", { type: "audio/wav" })); fd.append("lang", lang);
  const r = await fetch("/api/asr/subtitles", { method: "POST", body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, segments: [], error: String(d.detail || d.error || "HTTP " + r.status) };
  return { ok: !!d.ok, segments: Array.isArray(d.segments) ? d.segments : [], error: d.error || d.message };
}
