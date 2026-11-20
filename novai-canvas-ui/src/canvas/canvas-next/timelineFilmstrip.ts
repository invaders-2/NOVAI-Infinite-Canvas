/**
 * 片段里的胶片缩略图。
 *
 * 一条源素材只开一个 <video>，按需顺序 seek 取帧（每个片段都新建 video 会同时解码十几路，直接卡死），
 * 帧按 url + 时间点缓存：缩放/拖动只是换取样点，同一帧不重复解码。
 */
import { useEffect, useRef, useState } from "react";

const FRAME_H = 54;
const MAX_CACHE = 240;
const MAX_FRAMES = 12;

const cache = new Map<string, string>();
const keyOf = (url: string, at: number) => url + "#" + at.toFixed(2);
function remember(k: string, v: string) {
  if (cache.size >= MAX_CACHE) { const first = cache.keys().next().value; if (first) cache.delete(first); }
  cache.set(k, v);
}

const waitFor = (el: HTMLMediaElement, ev: string, ms = 8000) => new Promise<boolean>((res) => {
  const done = (ok: boolean) => { clearTimeout(tm); el.removeEventListener(ev, okh); el.removeEventListener("error", bad); res(ok); };
  const okh = () => done(true); const bad = () => done(false); const tm = setTimeout(() => done(false), ms);
  el.addEventListener(ev, okh, { once: true }); el.addEventListener("error", bad, { once: true });
});

/** 每条素材一个播放器 + 一条串行链：同一个元素不能并发 seek */
const loaders = new Map<string, { el: HTMLVideoElement; ok: Promise<boolean> }>();
const chains = new Map<string, Promise<unknown>>();
function loaderOf(url: string) {
  let l = loaders.get(url);
  if (!l) {
    const el = document.createElement("video");
    el.muted = true; el.preload = "auto"; el.crossOrigin = "anonymous"; el.playsInline = true;
    el.src = url;
    const ok = waitFor(el, "loadeddata", 12000);
    l = { el, ok }; loaders.set(url, l);
  }
  return l;
}
function enqueue<T>(url: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(url) || Promise.resolve();
  const next = prev.then(task, task);
  chains.set(url, next.then(() => undefined, () => undefined));
  return next;
}
async function frameAt(url: string, at: number): Promise<string> {
  const k = keyOf(url, at); const hit = cache.get(k); if (hit) return hit;
  const l = loaderOf(url); if (!(await l.ok)) return "";
  const data = await enqueue(url, async () => {
    const el = l.el;
    try {
      const want = Math.min(Math.max(0, at), Math.max(0, (el.duration || at) - 0.04));
      if (Math.abs(el.currentTime - want) > 0.02) { const sk = waitFor(el, "seeked", 4000); el.currentTime = want; if (!(await sk)) return ""; }
      const c = document.createElement("canvas"); c.height = FRAME_H; c.width = Math.max(1, Math.round((el.videoWidth / Math.max(1, el.videoHeight)) * FRAME_H));
      c.getContext("2d")!.drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.62);
    } catch { return ""; }
  });
  if (data) remember(k, data);
  return data;
}

/** 帧数按片段宽度定（约每 96px 一帧，最多 12 帧），返回与取样点等长的地址数组（没取到的为空串） */
export function useFilmstrip(url: string, from: number, to: number, px: number): string[] {
  const span = Math.max(0.05, to - from);
  const n = px < 48 ? 1 : Math.max(1, Math.min(MAX_FRAMES, Math.round(px / 96)));
  const sig = url ? url + "|" + n + "|" + from.toFixed(2) + "|" + to.toFixed(2) : "";
  const [cells, setCells] = useState<string[]>([]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    alive.current = true;
    if (!url) { setCells([]); return; }
    const times = Array.from({ length: n }, (_, i) => from + ((i + 0.5) * span) / n);
    const ready = times.map((t) => cache.get(keyOf(url, t)) || "");
    setCells(ready);
    void Promise.all(times.map((t) => (cache.get(keyOf(url, t)) ? cache.get(keyOf(url, t))! : frameAt(url, t))))
      .then((all) => { if (alive.current) setCells(all); });
    // sig 把「地址 / 帧数 / 入出点」编码进来：只有取样点真的变了才重新取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return cells;
}
