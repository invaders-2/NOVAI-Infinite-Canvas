/**
 * 片段里的真实音频波形。
 *
 * 解码一次、按 1/50 秒抽 min/max 峰值缓存起来：缩放/拖动只是换取样区间，不重新解码。
 * 视频片段也能解（容器里的音轨一起解码）；解码失败 / 文件过大就返回 null，片段退回纹理样式。
 */
import { useEffect, useRef, useState } from "react";

export type Peaks = { dur: number; step: number; data: Float32Array };
const MAX_BYTES = 60 * 1024 * 1024;
const MAX_ENTRIES = 8;
const STEP = 1 / 50;

const cache = new Map<string, Promise<Peaks | null>>();
let ctx: AudioContext | null = null;
const audioCtx = () => {
  if (!ctx) { const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (!C) return null; ctx = new C(); }
  return ctx;
};

function peaksFrom(buffer: AudioBuffer): Peaks {
  const n = Math.max(1, Math.ceil(buffer.duration / STEP));
  const data = new Float32Array(n * 2);
  const chans = Math.min(2, buffer.numberOfChannels);
  const ch0 = buffer.getChannelData(0); const ch1 = chans > 1 ? buffer.getChannelData(1) : ch0;
  const per = Math.max(1, Math.floor((ch0.length / n) | 0));
  for (let i = 0; i < n; i++) {
    const a = i * per; const b = Math.min(ch0.length, a + per);
    let lo = 0, hi = 0;
    for (let j = a; j < b; j++) { const v = (ch0[j] + ch1[j]) / 2; if (v < lo) lo = v; else if (v > hi) hi = v; }
    data[i * 2] = lo; data[i * 2 + 1] = hi;
  }
  return { dur: buffer.duration, step: STEP, data };
}

export function peaksOf(url: string): Promise<Peaks | null> {
  const hit = cache.get(url); if (hit) return hit;
  const job = (async (): Promise<Peaks | null> => {
    try {
      const res = await fetch(url); if (!res.ok) return null;
      const size = Number(res.headers.get("content-length") || 0); if (size > MAX_BYTES) return null;
      const buf = await res.arrayBuffer(); if (buf.byteLength > MAX_BYTES) return null;
      const ac = audioCtx(); if (!ac) return null;
      const audio = await ac.decodeAudioData(buf);
      return peaksFrom(audio);
    } catch { return null; }
  })();
  cache.set(url, job);
  if (cache.size > MAX_ENTRIES) { const first = cache.keys().next().value; if (first && first !== url) cache.delete(first); }
  return job;
}

export function usePeaks(url: string): Peaks | null {
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!url) return;
    let alive = true;
    void peaksOf(url).then((p) => { if (alive) setPeaks(p); });
    return () => { alive = false; };
  }, [url]);
  return peaks;
}

/** 画一段波形：x 轴是 [from, to] 这段源时间，y 轴是峰值 */
export function WaveStrip({ peaks, from, to, width, height, color = "rgba(255,255,255,.72)", dim = 0.34 }: { peaks: Peaks | null; from: number; to: number; width: number; height: number; color?: string; dim?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const w = Math.max(1, Math.round(width)); const h = Math.max(1, Math.round(height));
    c.width = w; c.height = h;
    const g = c.getContext("2d"); if (!g) return;
    g.clearRect(0, 0, w, h);
    if (!peaks) return;
    const half = h / 2; const span = Math.max(0.02, to - from);
    const n = peaks.data.length / 2;
    g.fillStyle = color;
    const bar = Math.max(1, Math.round(w / 260));
    for (let x = 0; x < w; x += bar + 1) {
      const at = from + (x / w) * span;
      const i = Math.max(0, Math.min(n - 1, Math.floor(at / peaks.step)));
      const lo = peaks.data[i * 2], hi = peaks.data[i * 2 + 1];
      const top = half - hi * half * (1 - dim) + 0.5;
      const hgt = Math.max(1, (hi - lo) * half * (1 - dim));
      g.globalAlpha = 0.9;
      g.fillRect(x, Math.min(h - 0.5, top), bar, hgt);
    }
    g.globalAlpha = 1;
  }, [peaks, from, to, width, height, color, dim]);
  return <canvas ref={ref} className="tle-wave" style={{ width, height }} aria-hidden />;
}
