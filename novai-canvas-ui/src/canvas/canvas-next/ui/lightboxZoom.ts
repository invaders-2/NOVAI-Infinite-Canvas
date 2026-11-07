/**
 * 全屏查看器（双击图片）的缩放 / 平移。
 * 基准是「适应窗口」：s=1 时整图可见，上限 6x；百分比按真实像素算（100% = 1:1 像素）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const EPS = 0.001;
const KEEP = 48;

export type LbView = { s: number; x: number; y: number };
export type LbBox = { w: number; h: number };

export const LB_FIT: LbView = { s: MIN_ZOOM, x: 0, y: 0 };

export const clampZoom = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

/** 以 (px,py)（图片未变换时的左上角为原点）为不动点缩放 */
export function zoomAt(v: LbView, s2: number, px: number, py: number): LbView {
  const s = clampZoom(s2);
  if (s <= MIN_ZOOM + EPS) return LB_FIT;
  if (s === v.s) return v;
  return { s, x: px - ((px - v.x) / v.s) * s, y: py - ((py - v.y) / v.s) * s };
}

/** 滚轮增量 → 倍率：连续指数缩放，单次夹在 .8–1.2 之间，避免一格跳太远；捏合灵敏度更高 */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.min(1.2, Math.max(0.8, Math.exp(-deltaY * (pinch ? 0.012 : 0.0018))));
}

/** 软边界：拖到头时图至少留 KEEP 像素可见，拖不丢也拖得回来 */
export function clampPan(v: LbView, stage: LbBox, box: LbBox): LbView {
  if (v.s <= MIN_ZOOM + EPS) return LB_FIT;
  if (!box.w || !box.h) return v;
  const ox = Math.max(0, (stage.w - box.w) / 2), oy = Math.max(0, (stage.h - box.h) / 2);
  const x = Math.min(Math.max(0, stage.w - KEEP - ox), Math.max(-Math.max(0, box.w * v.s + ox - KEEP), v.x));
  const y = Math.min(Math.max(0, stage.h - KEEP - oy), Math.max(-Math.max(0, box.h * v.s + oy - KEEP), v.y));
  return x === v.x && y === v.y ? v : { s: v.s, x, y };
}

export function useLbZoom(key: string) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 对比模式下这里指向 .lb-cmp 包裹层（它和 .big 一样是 .lb-stage 的直接子元素，offset 口径一致）
  const imgRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef<LbView>(LB_FIT);
  const boxRef = useRef<LbBox>({ w: 0, h: 0 });
  const natRef = useRef<LbBox>({ w: 0, h: 0 });
  const dragRef = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);
  const bgRef = useRef(false);
  const animRef = useRef<number | null>(null);
  const [view, setView] = useState<LbView>(LB_FIT);
  const [box, setBox] = useState<LbBox>({ w: 0, h: 0 });
  const [nat, setNat] = useState<LbBox>({ w: 0, h: 0 });
  const [drag, setDrag] = useState(false);
  const [anim, setAnim] = useState(false);

  const put = useCallback((next: LbView) => {
    const el = stageRef.current;
    const v = clampPan(next, el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 }, boxRef.current);
    viewRef.current = v; setView(v);
  }, []);

  const flash = useCallback(() => {
    setAnim(true);
    if (animRef.current) clearTimeout(animRef.current);
    animRef.current = window.setTimeout(() => { animRef.current = null; setAnim(false); }, 240);
  }, []);
  useEffect(() => () => { if (animRef.current) clearTimeout(animRef.current); }, []);

  const measure = useCallback(() => {
    const el = imgRef.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight; if (!w || !h) return;
    // 对比态量到的是包裹层，真实像素尺寸还得从里面那张 <img> 取，百分比读数才对
    const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
    const b = { w, h }, n = { w: img?.naturalWidth || w, h: img?.naturalHeight || h };
    if (boxRef.current.w === w && boxRef.current.h === h && natRef.current.w === n.w) return;
    boxRef.current = b; natRef.current = n; setBox(b); setNat(n);
  }, []);
  /** 交给外部挂 ref：普通模式是 <img>，对比模式是 .lb-cmp，所以按 HTMLElement 放宽 */
  const assignImg = useCallback((el: HTMLElement | null) => { imgRef.current = el; }, []);

  // 换图（切换版本）回到「适应窗口」
  useLayoutEffect(() => {
    dragRef.current = null; movedRef.current = false; setDrag(false);
    viewRef.current = LB_FIT; setView(LB_FIT);
  }, [key]);

  useEffect(() => {
    const on = () => measure();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [measure]);

  // wheel 必须走原生监听：React 17+ 的 onWheel 是 passive，preventDefault 挡不住页面缩放
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !key) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      const img = imgRef.current; if (!img) return;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - img.offsetLeft;
      const py = e.clientY - r.top - img.offsetTop;
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      setAnim(false);
      put(zoomAt(viewRef.current, viewRef.current.s * wheelFactor(dy, e.ctrlKey || e.metaKey), px, py));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [key, put]);

  const onPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    setAnim(false); movedRef.current = false; bgRef.current = e.target === e.currentTarget;
    if (e.button !== 0 || viewRef.current.s <= MIN_ZOOM + EPS) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    setDrag(true);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current; if (!d || d.id !== e.pointerId) return;
    movedRef.current = true;
    put({ s: viewRef.current.s, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
  }, [put]);

  const endDrag = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null; setDrag(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  /** 适应窗口 ↔ 100% 实际像素（图比窗口小时退化成 2x，保证有反馈） */
  const toggleFit = useCallback(() => {
    const m = boxRef.current, n = natRef.current;
    if (!m.w) return;
    flash();
    if (viewRef.current.s > MIN_ZOOM + EPS) { put(LB_FIT); return; }
    const actual = clampZoom(n.w / m.w);
    put(zoomAt(LB_FIT, Math.abs(actual - 1) > 0.02 ? actual : 2, m.w / 2, m.h / 2));
  }, [flash, put]);

  const zoomBy = useCallback((f: number) => {
    const m = boxRef.current;
    flash();
    put(zoomAt(viewRef.current, viewRef.current.s * f, m.w / 2, m.h / 2));
  }, [flash, put]);

  const reset = useCallback(() => { flash(); put(LB_FIT); }, [flash, put]);

  const pct = Math.round(view.s * (box.w && nat.w ? box.w / nat.w : 1) * 100);
  return {
    stageRef, imgRef, assignImg,
    /** 当前倍率：对比层要拿它把分割线 / 标签反向缩放到屏幕尺寸 */
    s: view.s,
    stageClass: "lb-stage" + (drag ? " drag" : "") + (view.s > MIN_ZOOM + EPS ? " zoomed" : ""),
    imgClass: "big" + (anim ? " lb-anim" : ""),
    imgStyle: { transform: `translate3d(${view.x}px,${view.y}px,0) scale(${view.s})` } as CSSProperties,
    pct, dragging: drag, wasDragged: () => movedRef.current, isBackdrop: () => bgRef.current,
    onLoad: measure, onPointerDown, onPointerMove, endDrag, toggleFit, zoomBy, reset,
  };
}