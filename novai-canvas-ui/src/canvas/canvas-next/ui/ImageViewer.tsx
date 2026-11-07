import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useAssetUrl } from "./useAsset";

export type ViewItem = { src: string; title: string; ratio?: string };
const MIN = 0.25, MAX = 4;

/**
 * 全屏看图：fixed 铺满（z-index 高于角色库 modal），图 contain 不裁切；
 * 滚轮以鼠标为锚点缩放 0.25–4、放大后可拖动、双击 1x/2x；Esc / 点背景关闭、点图不关。
 */
export function ImageViewer({ items, start = 0, onClose }: { items: ViewItem[]; start?: number; onClose: () => void }) {
  const [idx, setIdx] = useState(() => Math.max(0, Math.min(items.length - 1, start)));
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState({ w: typeof window === "undefined" ? 0 : window.innerWidth, h: typeof window === "undefined" ? 0 : window.innerHeight });
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; px: number; py: number } | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const item = items[idx];
  const url = useAssetUrl(item?.src || "");

  const reset = () => { setScale(1); setPos({ x: 0, y: 0 }); };
  const zoomAt = (clientX: number, clientY: number, next: number) => {
    const s2 = Math.max(MIN, Math.min(MAX, next));
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = clientX - (r.left + r.width / 2), py = clientY - (r.top + r.height / 2);
    setPos((p) => ({ x: px - (px - p.x) * (s2 / scale), y: py - (py - p.y) * (s2 / scale) }));
    setScale(s2);
  };
  const zoomCenter = (f: number) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, scale * f);
  };
  const go = (d: number) => { setIdx((i) => (i + d + items.length) % items.length); reset(); };

  useEffect(() => { reset(); setNat({ w: 0, h: 0 }); }, [idx, items.length]);
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const fit = nat.w && vp.w ? (() => { const k = Math.min((vp.w * 0.92) / nat.w, (vp.h * 0.82) / nat.h); return { width: Math.round(nat.w * k), height: Math.round(nat.h * k) }; })() : {};
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); closeRef.current(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setIdx((i) => (i - 1 + items.length) % items.length); setScale(1); setPos({ x: 0, y: 0 }); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setIdx((i) => (i + 1) % items.length); setScale(1); setPos({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items.length]);
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY * 0.0015)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale]);

  const onPointerDown = (e: RPointerEvent<HTMLImageElement>) => {
    if (scale <= 1) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动指针，忽略 */ }
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
    setDragging(true);
  };
  const onPointerMove = (e: RPointerEvent<HTMLImageElement>) => {
    const d = dragRef.current; if (!d || d.id !== e.pointerId) return;
    setPos({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  };
  const endDrag = () => { dragRef.current = null; setDragging(false); };

  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return createPortal(<div className="chview" data-ch-view ref={rootRef} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="chview-hd" onClick={stop}>
      <b className="t">{item?.title || "查看大图"}</b>
      {item?.ratio ? <span className="r">{item.ratio}</span> : null}
      <span className="pct tnum" data-ch-view-pct>{Math.round(scale * 100)}%</span>
      <span className="cnt">{idx + 1} / {items.length}</span>
    </div>
    <div className="chview-body">
      <img src={url} alt="" data-ch-view-img draggable={false} className={dragging ? "drag" : ""}
        onLoad={(e) => { const t = e.currentTarget; setNat({ w: t.naturalWidth, h: t.naturalHeight }); }}
        style={{ ...fit, transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
        onClick={stop}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
        onDoubleClick={(e) => { e.stopPropagation(); if (scale === 1) zoomAt(e.clientX, e.clientY, 2); else reset(); }} />
    </div>
    <div className="chview-ctrl" onClick={stop}>
      <button className="chview-ib" data-ch-view-zoom="out" aria-label="缩小" title="缩小" onClick={() => zoomCenter(1 / 1.25)}><Icon name="minus" size="s" /></button>
      <button className="chview-ib" data-ch-view-zoom="fit" aria-label="适应窗口" title="适应窗口" onClick={reset}><Icon name="fit" size="s" /></button>
      <button className="chview-ib" data-ch-view-zoom="in" aria-label="放大" title="放大" onClick={() => zoomCenter(1.25)}><Icon name="zoomin" size="s" /></button>
      <button className="chview-ib" data-ch-view-zoom="close" aria-label="关闭" title="关闭" onClick={onClose}><Icon name="x" size="s" /></button>
    </div>
    {items.length > 1 ? <>
      <button className="chview-nav prev" data-ch-view-nav="prev" aria-label="上一张" onClick={(e) => { e.stopPropagation(); go(-1); }}><Icon name="left" size="s" /></button>
      <button className="chview-nav next" data-ch-view-nav="next" aria-label="下一张" onClick={(e) => { e.stopPropagation(); go(1); }}><Icon name="right" size="s" /></button>
    </> : null}
  </div>, document.body);
}
