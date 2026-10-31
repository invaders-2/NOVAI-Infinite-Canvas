/**
 * 音频节点卡片（对齐 TapNow）。
 *   · 中间一排胶囊形波形条，每根代表 0.5 秒的真实音量；播放时整排向左滚动，
 *     播放指针固定在正中（蓝色竖线 + 顶部小三角），下方气泡显示「当前 / 总时长」。
 *   · 底部居中：后退 10 秒 / 播放暂停（大圆钮）/ 前进 10 秒。
 *   · 节点选中或播过之后，左右拖动波形就是拖动播放位置（向左拖 = 往后走）。
 * 波形从解码后的音频数据算（见 audioAnalysis.ts），不依赖播放地址能不能接 Web Audio。
 */
import { useEffect, useRef, useState } from "react";
import type { GenOutput } from "../model";
import { decodeAudio, peaks, type Decoded } from "../audioAnalysis";
import { useAssetUrl } from "./useAsset";
import { useMediaUrl } from "./useMedia";

/** 每根波形条代表的秒数（TapNow 实测约 0.5s 一根） */
export const SEC_PER_BAR = 0.5;
/** 节点宽度里大约放多少根条：条距 = 宽度 / 这个数 */
const BARS_ACROSS = 34;

/** 00:08 这种两位分钟格式 */
export function clock2(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/** 旧数据里的 bars（生成时给的粗略波形）重采样到 count 根 */
function resample(src: number[], count: number): number[] {
  if (!src.length) return Array.from({ length: count }, (_, i) => 0.2 + Math.abs(Math.sin(i * 0.7)) * 0.6);
  return Array.from({ length: count }, (_, i) => src[Math.min(src.length - 1, Math.floor((i / count) * src.length))]);
}

export function AudioBody({ out, sel }: { out: GenOutput; sel?: boolean }) {
  // 播放走流式地址（支持 Range、秒开）；波形要整段字节，读资源库的 data URL 来解码
  const media = useMediaUrl(out.url || ""); const url = media.url;
  const dataUrl = useAssetUrl(out.url || "");
  const aref = useRef<HTMLAudioElement>(null);
  const cvs = useRef<HTMLCanvasElement>(null);
  const [dec, setDec] = useState<Decoded | null>(null);
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [mediaDur, setMediaDur] = useState(0);
  const dur = dec?.duration || mediaDur || Number(out.dur) || 0;

  useEffect(() => {
    let alive = true; setDec(null);
    decodeAudio(dataUrl).then((d) => { if (alive && d) setDec(d); });
    return () => { alive = false; };
  }, [dataUrl]);

  // 动画状态放在 ref 里，每帧直接画 canvas，不走 React 渲染
  const anim = useRef({ bars: [] as number[], barsKey: "", fake0: 0, raf: 0, ink: "255,255,255", styleAt: 0 });
  const live = useRef({ on, t, dec, dur, bars: out.bars || [] });
  live.current = { on, t, dec, dur, bars: out.bars || [] };

  /** 当前播放时间：有 <audio> 读它，没有（演示数据）按开始时刻推算 */
  const now = () => {
    const a = aref.current; const L = live.current;
    if (a && url) return a.currentTime;
    return L.on ? (performance.now() - anim.current.fake0) / 1000 : L.t;
  };

  const draw = () => {
    const c = cvs.current; if (!c) return;
    const A = anim.current; const L = live.current;
    const w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    const dpr = Math.min(3, (globalThis.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d"); if (!g) return;
    const stamp = performance.now();
    if (stamp - A.styleAt > 500) { A.ink = getComputedStyle(c).getPropertyValue("--ink").trim() || A.ink; A.styleAt = stamp; }
    const n = Math.max(1, Math.ceil((L.dur || 10) / SEC_PER_BAR));
    const key = (L.dec ? "d" : "b") + n;
    if (A.barsKey !== key) { A.bars = L.dec ? peaks(L.dec, n) : resample(L.bars, n); A.barsKey = key; }
    const pitch = w / BARS_ACROSS; const bw = Math.max(2, pitch * 0.6);
    const time = Math.max(0, Math.min(L.dur || 0, now()));
    // 指针固定在正中；时间 t 对应的位置画在中线上，波形整体向左滚
    const x0 = w / 2 - (time / SEC_PER_BAR) * pitch;
    const mid = h / 2; const maxH = h * 0.56;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const first = Math.max(0, Math.floor(-x0 / pitch) - 1), last = Math.min(n - 1, Math.ceil((w - x0) / pitch));
    for (let i = first; i <= last; i++) {
      const cx = x0 + (i + 0.5) * pitch;
      const bh = Math.max(bw * 0.9, Math.min(1, A.bars[i] || 0) * maxH);
      const top = mid - bh / 2;
      const grad = g.createLinearGradient(0, top, 0, top + bh);
      grad.addColorStop(0, `rgba(${A.ink},.42)`); grad.addColorStop(1, `rgba(${A.ink},.16)`);
      g.fillStyle = grad;
      g.beginPath();
      if (g.roundRect) g.roundRect(cx - bw / 2, top, bw, bh, bw / 2); else g.rect(cx - bw / 2, top, bw, bh);
      g.fill();
    }
  };

  const loop = () => {
    const A = anim.current; cancelAnimationFrame(A.raf);
    const step = () => {
      const L = live.current;
      if (L.on) {
        const tm = now();
        if ((!aref.current || !url) && L.dur && tm >= L.dur) { setOn(false); setT(0); } else setT(tm);
      }
      draw();
      A.raf = L.on ? requestAnimationFrame(step) : 0;
    };
    A.raf = requestAnimationFrame(step);
  };

  useEffect(() => { anim.current.barsKey = ""; loop(); }, [dec, out.bars, dur]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loop(); }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!on) loop(); }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = cvs.current; if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => loop()); ro.observe(c);
    return () => { ro.disconnect(); cancelAnimationFrame(anim.current.raf); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const a = aref.current;
    if (!a || !url) {
      if (on) { setT(now()); setOn(false); }
      else { const start = t > 0 && t < dur ? t : 0; anim.current.fake0 = performance.now() - start * 1000; setOn(true); }
      return;
    }
    if (a.paused) { if (dur && a.currentTime >= dur - 0.05) a.currentTime = 0; void a.play().then(() => setOn(true)).catch(() => setOn(false)); }
    else { a.pause(); setT(a.currentTime); setOn(false); }
  };

  const seekTime = (sec: number) => {
    if (!dur) return;
    const tm = Math.max(0, Math.min(dur, sec));
    const a = aref.current;
    if (a && url) a.currentTime = tm; else anim.current.fake0 = performance.now() - tm * 1000;
    setT(tm);
  };
  /** 后退 / 前进 10 秒 */
  const skip = (d: number) => seekTime(now() + d);
  /** 左右拖波形：向左拖 = 往后走，按条距换算成秒 */
  const scrub = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !dur) return;
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget; el.setPointerCapture?.(e.pointerId);
    const pitch = el.clientWidth / BARS_ACROSS || 1;
    const x0 = e.clientX; const t0 = now();
    // 画布可能被缩放：用屏幕上的实际宽度换算
    const scale = el.getBoundingClientRect().width / Math.max(1, el.clientWidth) || 1;
    const move = (ev: PointerEvent) => seekTime(t0 - ((ev.clientX - x0) / scale / pitch) * SEC_PER_BAR);
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); el.classList.remove("drag"); };
    el.classList.add("drag");
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  // 没选中、也没播过时，波形区按下仍是拖节点；选中或播过之后才拿来拖播放位置
  const canScrub = sel || on || t > 0;

  return <div className="abody" data-audio-state={on ? "playing" : t > 0 ? "paused" : "idle"} data-audio-decoded={dec ? "1" : "0"}>
    {url ? <audio ref={aref} src={url} preload="metadata" onError={() => media.onError()}
      onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d)) setMediaDur(d); }}
      onPause={() => setOn(false)} onSeeked={(e) => { if (e.currentTarget.paused) setT(e.currentTarget.currentTime); }} onEnded={(e) => { e.currentTarget.currentTime = 0; setOn(false); setT(0); }} /> : null}
    <div className={"awave" + (canScrub ? " seek" : "")} onPointerDown={canScrub ? scrub : undefined}>
      <canvas ref={cvs} data-aviz />
    </div>
    <div className="ahead" aria-hidden><i className="ahead-tri" /><i className="ahead-line" /></div>
    <span className="atime tnum" data-atime>{clock2(t)}/{clock2(dur)}</span>
    <div className="actl" onPointerDown={(e) => e.stopPropagation()}>
      <button className="sk" data-act="back10" title="后退 10 秒" onPointerDown={(e) => { e.stopPropagation(); skip(-10); }}>
        <svg viewBox="0 0 24 24" aria-hidden><path d="M11.5 6.5v11L4 12zM20 6.5v11L12.5 12z" /></svg>
      </button>
      <button className="p" data-act="play" title={on ? "暂停" : "播放"} onPointerDown={(e) => { e.stopPropagation(); toggle(); }}>
        {on ? <svg viewBox="0 0 24 24" aria-hidden><rect x="7" y="5.5" width="3.6" height="13" rx="1.2" /><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" /></svg>
          : <svg viewBox="0 0 24 24" aria-hidden className="pl"><path d="M8 5.5v13l10.5-6.5z" /></svg>}
      </button>
      <button className="sk" data-act="fwd10" title="前进 10 秒" onPointerDown={(e) => { e.stopPropagation(); skip(10); }}>
        <svg viewBox="0 0 24 24" aria-hidden><path d="M12.5 6.5v11L20 12zM4 6.5v11L11.5 12z" /></svg>
      </button>
    </div>
  </div>;
}
