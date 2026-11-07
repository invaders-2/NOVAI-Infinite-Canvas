/**
 * 本地标注编辑器（不走模型）：画笔 / 箭头 / 方框 / 圆圈 / 文字 / 马赛克 / 橡皮，叠在图片节点上直接画。
 * 笔迹按 0–1 归一化坐标记录，粗细按屏幕像素记录；「完成」时按原图分辨率重画一遍，作为新版本写回节点（原图留在历史里）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../../react-canvas/reactCanvasStore";
import { outOf } from "../../model";
import type { Ctl } from "../ctx";
import { Icon } from "../Icon";
import { useAssetUrl } from "../useAsset";
import { barAbove, useEdBar } from "./barPos";

type Tool = "pen" | "arrow" | "rect" | "ellipse" | "text" | "mosaic" | "eraser";
type Pt = { x: number; y: number };
type Shape = { t: Tool; color: string; size: number; p: Pt[]; text?: string };
type Rect = { left: number; top: number; width: number; height: number };

const COLORS = ["#ff453a", "#ff9f0a", "#ffd60a", "#30d158", "#0a84ff", "#ffffff", "#1d1d1f"];
const TOOLS: Array<[Tool, string, string]> = [["pen", "brush", "画笔"], ["arrow", "right", "箭头"], ["rect", "rect", "方框"], ["ellipse", "cursor", "圆圈"], ["text", "text", "文字"], ["mosaic", "grid", "马赛克"], ["eraser", "eraser", "橡皮"]];

const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error("图片读取失败")); im.src = src; });

/** 把一组笔迹画到 g 上（W×H 是目标像素，k 是屏幕像素 → 目标像素的倍数） */
function drawShapes(g: CanvasRenderingContext2D, shapes: Shape[], W: number, H: number, k: number, mosaic: HTMLCanvasElement | null) {
  // 马赛克：先把所有马赛克笔迹画成遮罩，再用像素化的原图填进去；橡皮只擦掉它之前画的东西
  const layer = document.createElement("canvas"); layer.width = W; layer.height = H; const L = layer.getContext("2d")!;
  for (const s of shapes) {
    const P = s.p.map((q) => ({ x: q.x * W, y: q.y * H })); const lw = Math.max(1, s.size * k);
    L.globalCompositeOperation = s.t === "eraser" ? "destination-out" : "source-over";
    L.strokeStyle = L.fillStyle = s.color; L.lineWidth = lw; L.lineCap = L.lineJoin = "round";
    if (s.t === "mosaic" && mosaic) {
      const m = document.createElement("canvas"); m.width = W; m.height = H; const M = m.getContext("2d")!;
      M.lineWidth = lw * 2.2; M.lineCap = M.lineJoin = "round"; M.strokeStyle = "#000"; M.beginPath(); P.forEach((q, i) => (i ? M.lineTo(q.x, q.y) : M.moveTo(q.x, q.y))); if (P.length === 1) M.lineTo(P[0].x + .1, P[0].y); M.stroke();
      M.globalCompositeOperation = "source-in"; M.imageSmoothingEnabled = false; M.drawImage(mosaic, 0, 0, W, H);
      L.drawImage(m, 0, 0);
    } else if (s.t === "pen" || s.t === "eraser") {
      L.beginPath(); P.forEach((q, i) => (i ? L.lineTo(q.x, q.y) : L.moveTo(q.x, q.y))); if (P.length === 1) L.lineTo(P[0].x + .1, P[0].y); L.stroke();
    } else if (s.t === "rect" && P.length > 1) {
      const [a, b] = [P[0], P[P.length - 1]]; L.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.t === "ellipse" && P.length > 1) {
      const [a, b] = [P[0], P[P.length - 1]]; L.beginPath(); L.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); L.stroke();
    } else if (s.t === "arrow" && P.length > 1) {
      const [a, b] = [P[0], P[P.length - 1]]; const ang = Math.atan2(b.y - a.y, b.x - a.x); const head = Math.max(10, lw * 3.2);
      L.beginPath(); L.moveTo(a.x, a.y); L.lineTo(b.x - Math.cos(ang) * head * .6, b.y - Math.sin(ang) * head * .6); L.stroke();
      L.beginPath(); L.moveTo(b.x, b.y); L.lineTo(b.x - head * Math.cos(ang - .45), b.y - head * Math.sin(ang - .45)); L.lineTo(b.x - head * Math.cos(ang + .45), b.y - head * Math.sin(ang + .45)); L.closePath(); L.fill();
    } else if (s.t === "text" && s.text) {
      const fs = Math.max(10, s.size * k * 2.2); L.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`; L.textBaseline = "top";
      const lines = s.text.split("\n"); L.lineWidth = Math.max(2, fs / 7); L.strokeStyle = s.color === "#1d1d1f" ? "rgba(255,255,255,.85)" : "rgba(0,0,0,.55)";
      lines.forEach((ln, i) => { L.strokeText(ln, P[0].x, P[0].y + i * fs * 1.25); L.fillStyle = s.color; L.fillText(ln, P[0].x, P[0].y + i * fs * 1.25); });
    }
  }
  g.drawImage(layer, 0, 0);
}

/** 像素化版本（马赛克用）：长边缩到约 48 格再放大 */
function pixelate(im: HTMLImageElement): HTMLCanvasElement {
  const W = im.naturalWidth, H = im.naturalHeight; const cells = 48; const s = Math.max(W, H) / cells;
  const small = document.createElement("canvas"); small.width = Math.max(1, Math.round(W / s)); small.height = Math.max(1, Math.round(H / s));
  small.getContext("2d")!.drawImage(im, 0, 0, small.width, small.height); return small;
}

export function Markup({ ctl, n, rect, onClose, onApply }: { ctl: Ctl; n: CanvasNode; rect: Rect; onClose: () => void; onApply: (dataUrl: string, w: number, h: number) => Promise<void> }) {
  const src = useAssetUrl(outOf(n)?.url || "");
  const cvsRef = useRef<HTMLCanvasElement>(null); const [shapes, setShapes] = useState<Shape[]>([]); const [redo, setRedo] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("pen"); const [color, setColor] = useState(COLORS[0]); const [size, setSize] = useState(6);
  const [img, setImg] = useState<HTMLImageElement | null>(null); const [draft, setDraft] = useState<{ x: number; y: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false); const live = useRef<Shape | null>(null);
  useEffect(() => { let ok = true; if (src) void loadImg(src).then((im) => { if (ok) setImg(im); }).catch(() => ctl.store.toast("图片读取失败，没法标注")); return () => { ok = false; }; }, [src]);
  const mosaic = useMemo(() => (img ? pixelate(img) : null), [img]);
  const paint = () => {
    const c = cvsRef.current; if (!c) return; const W = c.clientWidth, H = c.clientHeight; if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
    const g = c.getContext("2d")!; g.clearRect(0, 0, W, H); drawShapes(g, live.current ? [...shapes, live.current] : shapes, W, H, 1, mosaic);
  };
  useEffect(paint);
  const undo = () => setShapes((s) => { if (!s.length) return s; setRedo((r) => [...r, s[s.length - 1]]); return s.slice(0, -1); });
  const again = () => setRedo((r) => { if (!r.length) return r; setShapes((s) => [...s, r[r.length - 1]]); return r.slice(0, -1); });
  // 文字草稿用 ref 取最新值：失焦和点画布会先后触发提交，只能落一次
  const draftRef = useRef(draft); draftRef.current = draft;
  const commitText = () => { const d = draftRef.current; draftRef.current = null; if (d && d.text.trim()) { setShapes((s) => [...s, { t: "text", color, size, p: [{ x: d.x, y: d.y }], text: d.text }]); setRedo([]); } setDraft(null); };
  const done = async () => {
    const d = draftRef.current; if (d) commitText();
    if (!img) return; const all = d && d.text.trim() ? [...shapes, { t: "text" as Tool, color, size, p: [{ x: d.x, y: d.y }], text: d.text }] : shapes;
    if (!all.length) { onClose(); return; }
    setBusy(true);
    try {
      const W = img.naturalWidth, H = img.naturalHeight; const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0); drawShapes(g, all, W, H, W / Math.max(1, rect.width), mosaic);
      const png = /\.png($|\?)/i.test(outOf(n)?.url || "") || (outOf(n)?.url || "").startsWith("data:image/png");
      await onApply(c.toDataURL(png ? "image/png" : "image/jpeg", .93), W, H);
    } catch (e) { ctl.store.toast("标注保存失败：" + (e instanceof Error ? e.message : "未知错误")); setBusy(false); }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) again(); else undo(); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void done(); }
      else if (e.key === "[" || e.key === "]") { e.stopPropagation(); setSize((v) => Math.max(2, Math.min(40, v + (e.key === "]" ? 2 : -2)))); }
    };
    addEventListener("keydown", on, true); return () => removeEventListener("keydown", on, true);
  });
  const at = (e: React.PointerEvent) => { const r = e.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation(); if (busy) return;
    if (tool === "text") { if (draftRef.current) { commitText(); return; } setDraft({ ...at(e), text: "" }); return; }
    const c = e.currentTarget; c.setPointerCapture(e.pointerId); live.current = { t: tool, color, size, p: [at(e)] }; paint();
    c.onpointermove = (ev) => { const s = live.current; if (!s) return; const r = c.getBoundingClientRect(); const q = { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) }; if (s.t === "pen" || s.t === "mosaic" || s.t === "eraser") s.p.push(q); else s.p[1] = q; paint(); };
    c.onpointerup = () => { c.onpointermove = null; const s = live.current; live.current = null; if (s && (s.p.length > 1 || s.t === "pen" || s.t === "mosaic")) { setShapes((x) => [...x, s]); setRedo([]); } else paint(); };
  };
  const stage = ctl.rect(); const H = stage.height; const cx = rect.left + rect.width / 2;
  const tools = useEdBar(cx, stage.width); const fin = useEdBar(cx, stage.width);
  const above = barAbove(rect.top);
  const toolsTop = above ?? Math.min(H - 108, rect.top + rect.height + 14);
  const doneTop = above != null ? Math.min(H - 54, rect.top + rect.height + 14) : Math.min(H - 54, toolsTop + 54);
  return <>
    <div className="edov mk-ov" data-ed="markup" style={rect} onPointerDown={(e) => e.stopPropagation()}>
      <canvas ref={cvsRef} className="mask-cv" style={{ cursor: tool === "text" ? "text" : "crosshair" }} onPointerDown={down} />
      {draft ? <textarea className="mk-text" autoFocus value={draft.text} placeholder="输入文字，Enter 换行，点空白处完成"
        style={{ left: draft.x * rect.width, top: draft.y * rect.height, color, fontSize: Math.max(10, size * 2.2) }}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })} onBlur={commitText}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setDraft(null); } }} onPointerDown={(e) => e.stopPropagation()} /> : null}
    </div>
    <div className="edbar mk-bar" ref={tools.ref} style={{ left: tools.left, top: toolsTop, transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="关闭" onClick={onClose}><Icon name="x" /></button><span className="vsep" />
      {TOOLS.map(([t, ic, tip]) => <button key={t} className={"ib" + (tool === t ? " on" : "")} data-tip={tip} data-mk={t} onClick={() => { if (draft) commitText(); setTool(t); }}>{t === "ellipse" ? <i className="mk-circle" /> : <Icon name={ic as "brush"} />}</button>)}
      <span className="vsep" />
      {tool !== "mosaic" && tool !== "eraser" ? <span className="mk-colors">{COLORS.map((c) => <button key={c} className={"mk-c" + (c === color ? " on" : "")} style={{ background: c }} aria-label={"颜色 " + c} onClick={() => setColor(c)} />)}</span> : null}
      <input type="range" min={2} max={40} step={1} value={size} className="brush-size" aria-label="粗细" onChange={(e) => setSize(+e.target.value)} /><span className="tnum est">{size}</span>
      <span className="vsep" />
      <button className="ib" data-tip="撤销（⌘Z）" disabled={!shapes.length} onClick={undo}><Icon name="undo" /></button>
      <button className="ib" data-tip="重做（⇧⌘Z）" disabled={!redo.length} onClick={again}><Icon name="redo" /></button>
      <button className="ib" data-tip="清空" disabled={!shapes.length} onClick={() => { setRedo([]); setShapes([]); }}><Icon name="trash" /></button>
    </div>
    <div className="edbar mk-done" ref={fin.ref} style={{ left: fin.left, top: doneTop, transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <span className="est">{shapes.length ? `${shapes.length} 处标注` : "在图上直接画，完成后作为新版本保存"}</span>
      <button className="pill" onClick={onClose}>取消</button>
      <button className="pill mk-ok" data-k="ok" disabled={busy || !img} onClick={() => void done()}><Icon name="check" size="s" />{busy ? "保存中…" : "完成"}</button>
    </div>
  </>;
}
