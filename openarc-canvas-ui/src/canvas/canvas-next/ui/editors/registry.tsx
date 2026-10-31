/**
 * 图片编辑器：
 *   本地完成：裁剪、调整像素、快速切分、视频截帧；
 *   走模型（backend.editImage）：局部重绘、擦除、标注、多角度、重打光、扩图、增强、抠图。
 * 结果作为新版本写回原节点（多角度 / 切分 / 截帧是新建节点并连线），原图留在历史里。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CanvasNode } from "../../../react-canvas/reactCanvasStore";
import { relit } from "../../backend/mockEdit";
import { GenError, type EditOp } from "../../backend/types";
import { clamp, clampTrim, genOf, outOf, uid, withGen, type GenOutput } from "../../model";
import type { CanvasStore } from "../../store";
import { useCtl, useS, type Ctl } from "../ctx";
import { Icon } from "../Icon";
import { closeModal, ModalHead, openModal, openPop } from "../overlay";
import { useAssetUrl } from "../useAsset";
import { OutpaintFrame } from "./OutpaintFrame";
import { brushRadius, ringVisible, type Ext } from "./outpaint-geometry";
// 扩图框 / 笔刷圆圈的样式：独立小块，写进 canvas-next.css 会和另一路（textdoc 段）冲突。
// 在这里 import 一次即可 —— registry 随画布常驻，笔刷圆圈不用等扩图框打开才加载样式。
import "./editors.css";

type EdState = { type: "crop" | "mask" | "outpaint"; id: string; mode?: "redraw" | "erase" | "annot" } | null;
let ed: EdState = null; const ls = new Set<() => void>();
const setEd = (v: EdState) => { ed = v; ls.forEach((l) => l()); };
export const useEditorState = () => useSyncExternalStore((l) => { ls.add(l); return () => { ls.delete(l); }; }, () => ed);

/* ---------- 工具用哪个模型：用户自己选，按工具分别记住；默认跟节点当前选的图片模型 ---------- */
const TOOL_GROUP: Record<string, string> = { redraw: "mask", erase: "mask", annotate: "mask", angle: "angle", relight: "relight", outpaint: "more", enhance: "more", cutout: "more" };
const prefKey = (op: string) => "canvas-next:tool-model:" + (TOOL_GROUP[op] || op);
export function toolModel(store: CanvasStore, op: string, n?: CanvasNode) {
  const list = store.modelsOf("image"); let id = ""; try { id = localStorage.getItem(prefKey(op)) || ""; } catch { /* 无存储 */ }
  return list.find((m) => m.id === id) || (n ? list.find((m) => m.id === store.modelOf(n)?.id) : undefined) || store.defaultModel("image") || list[0];
}
function setToolModel(op: string, id: string) { try { localStorage.setItem(prefKey(op), id); } catch { /* 无存储 */ } }
/** 模型选择胶囊：点开列出「设置 › 模型」里所有图片模型 */
export function ToolModelPill({ op, n }: { op: string; n?: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store; useS((s) => s.models); const [, force] = useState(0); const m = toolModel(store, op, n);
  return <button className="pill" data-tm={op} onClick={(e) => openPop(e.currentTarget, (close) => <>
    <div className="mh">这个工具使用的模型</div>
    {store.modelsOf("image").map((x) => <button key={x.id} className={"mi" + (x.id === m?.id ? " on" : "")} onClick={() => { close(); setToolModel(op, x.id); force((v) => v + 1); }}><span>{x.name}<span className="d">{x.vendor}</span></span>{x.id === m?.id ? <span className="k"><Icon name="check" size="s" /></span> : null}</button>)}
    {!store.modelsOf("image").length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>还没有配置图片模型</span></div> : null}
    {ctl.host.openModelSettings ? <><div className="msep" /><button className="mi" onClick={() => { close(); ctl.host.openModelSettings!(); }}><Icon name="settings" size="s" />模型设置</button></> : null}
  </>, "up")}><Icon name="sparkle" size="s" />{m?.name || "选择图片模型"}<Icon name="down" size="xs" /></button>;
}

const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error("图片读取失败")); im.src = src; });
const cv = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
async function srcData(store: CanvasStore, url: string) { return url.startsWith("openarc-asset:") ? (await store.backend.resolveAsset(url)) || "" : url; }

/** 新版本写回节点（data URL 先进资源库） */
async function applyVariant(store: CanvasStore, id: string, out: GenOutput, label: string) {
  const url = out.url?.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, out.url, label)
    : out.url && /^https?:\/\//i.test(out.url) && store.backend.importRemote ? await store.backend.importRemote(store.state.canvasId, out.url, label) : out.url;
  const n = store.node(id); if (!n) return; const g = genOf(n); const o = { ...out, url, meta: { ...(out.meta || {}), model: label, size: out.w && out.h ? out.w + "×" + out.h : undefined } };
  store.updateNode(id, (x) => withGen({ ...x, ...(o.w && o.h ? { h: Math.round(clamp((x.w * o.h) / o.w, 100, 520)) } : {}) }, { hist: [...g.hist, o], hi: g.hist.length }), { history: true });
  store.toast(`${label}完成，原图保留在历史版本里（‹ › 切换）`);
}

/** 走模型的编辑：目标节点进入生成态（同一套加载动效），可停止 */
async function runEdit(store: CanvasStore, id: string, op: EditOp, label: string, extra: { maskDataUrl?: string; prompt?: string; params?: Record<string, unknown>; sourceUrl?: string } = {}, target?: string) {
  const n = store.node(id); const src = n ? outOf(n)?.url : ""; if (!n || !src) return;
  const tid = target || id; const abort = new AbortController();
  store.setRun(tid, { status: "running", progress: .02, abort, startedAt: Date.now() });
  try {
    // 扩图会自己合成「原图 + 透明扩展」再传进来（extra.sourceUrl）；其余编辑仍用节点当前结果
    const { sourceUrl: prepadded, ...rest } = extra;
    const sourceUrl = prepadded || (store.backend.kind === "mock" ? await srcData(store, src) : src);
    const out = await store.backend.editImage({ canvasId: store.state.canvasId, nodeId: tid, op, model: toolModel(store, op, n), sourceUrl, ...rest }, (e) => { if (e.type === "progress") store.patchRun(tid, { progress: clamp(e.progress, .02, 1) }); }, abort.signal);
    store.setRun(tid, null); await applyVariant(store, tid, out, label);
    store.logRun({ node: tid, title: genOf(store.node(tid)!).title, type: "image", model: label, status: "done", secs: 0 });
  } catch (err) {
    store.setRun(tid, null);
    if (!(err instanceof GenError && err.code === "STOPPED")) store.patchGen(tid, { err: err instanceof Error ? err.message : label + "失败" });
  }
}

/** ⌘I「指向编辑」：在图片上圈出要改的地方再写说明（标注编辑器） */
export function openPointEdit(id: string) { setEd({ type: "mask", id, mode: "annot" }); }
export function openEditor(ctl: Ctl, kind: string, id: string, anchor?: Element) {
  const store = ctl.store; const n = store.node(id); if (!n) return;
  if (kind === "crop") return setEd({ type: "crop", id });
  if (kind === "mask") return setEd({ type: "mask", id, mode: "redraw" });
  if (kind === "angle") return openModal(() => <AngleModal ctl={ctl} id={id} />);
  if (kind === "relight") return openModal(() => <RelightModal ctl={ctl} id={id} />);
  if (kind === "frame") return void captureFrame(store, n, "current");
  if (kind === "cropframe") return void frameThen(ctl, n, "crop");
  if (kind === "eraseframe") return void frameThen(ctl, n, "erase");
  if (kind === "firstframe") return void captureFrame(store, n, "first");
  if (kind === "lastframe") return void captureFrame(store, n, "last");
  if (kind === "setcover") return void setVideoCover(store, n);
  if (kind === "applycanvas") return void applyVideoToCanvas(store, n);
  if (kind === "more" && anchor) return openPop(anchor, (close) => <>
    <div className="row tm-row"><span>模型</span><ToolModelPill op="enhance" n={n} /></div><div className="msep" />
    <button className="mi" data-k="open-outpaint" onClick={() => { close(); setEd({ type: "outpaint", id }); }}><Icon name="outpaint" size="s" />扩图</button>
    <button className="mi" onClick={() => { close(); setEd({ type: "mask", id, mode: "erase" }); }}><Icon name="eraser" size="s" />擦除</button>
    <button className="mi" onClick={() => { close(); setEd({ type: "mask", id, mode: "annot" }); }}><Icon name="annot" size="s" />标注</button>
    <button className="mi" onClick={() => { close(); void runEdit(store, id, "enhance", "增强"); }}><Icon name="zoomin" size="s" />增强<span className="k">2×</span></button>
    <button className="mi" onClick={() => { close(); openModal(() => <ResizeModal ctl={ctl} id={id} />); }}><Icon name="resize" size="s" />调整像素</button>
    <button className="mi" onClick={() => { close(); void runEdit(store, id, "cutout", "抠图"); }}><Icon name="scissors" size="s" />抠图</button>
    <div className="mh">快速切分</div><div className="seg">{[2, 3, 4].map((k) => <button key={k} onClick={() => { close(); void split(ctl, id, k); }}>{k}×{k}</button>)}</div>
  </>);
}

/* ---------- 叠在节点上的编辑层（裁剪 / 蒙版） ---------- */
export function EditorLayer() {
  const st = useEditorState(); const ctl = useCtl(); useS((s) => s.view); const doc = useS((s) => s.doc);
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === "Escape" && ed) { e.stopPropagation(); setEd(null); } }; addEventListener("keydown", on, true); return () => removeEventListener("keydown", on, true); }, []);
  if (!st) return null; const n = doc.nodes.find((x) => x.id === st.id); if (!n) { setTimeout(() => setEd(null)); return null; }
  const r0 = ctl.rect(); const a = ctl.toScreen(n.x, n.y + 24), b = ctl.toScreen(n.x + n.w, n.y + 24 + n.h);
  const rect = { left: a.x - r0.left, top: a.y - r0.top, width: b.x - a.x, height: b.y - a.y };
  if (st.type === "outpaint") return <Outpaint ctl={ctl} n={n} onClose={() => setEd(null)} />;
  return st.type === "crop" ? <Crop ctl={ctl} n={n} rect={rect} /> : <Mask ctl={ctl} n={n} rect={rect} mode={st.mode || "redraw"} />;
}

/** 扩图框的外壳：把资源引用解析成可显示的原图，确认后带着合成好的 PNG 去走 outpaint */
function Outpaint({ ctl, n, onClose }: { ctl: Ctl; n: CanvasNode; onClose: () => void }) {
  const src = useAssetUrl(outOf(n)?.url || "");
  return <OutpaintFrame ctl={ctl} n={n} source={src} onClose={onClose}
    onApply={(png: string, ext: Ext) => { onClose(); void runEdit(ctl.store, n.id, "outpaint", "扩图", { sourceUrl: png, params: { ext, prepadded: true } }); }} />;
}
export const editorOpen = () => !!ed;

type Rect = { left: number; top: number; width: number; height: number };
function Crop({ ctl, n, rect }: { ctl: Ctl; n: CanvasNode; rect: Rect }) {
  const src = useAssetUrl(outOf(n)?.url || ""); const [rs, setRs] = useState({ l: .08, t: .08, w: .84, h: .84 }); const [ratio, setRatio] = useState("自由"); const el = useRef<HTMLDivElement>(null);
  const fix = (r: typeof rs, ra = ratio) => { const x = { ...r }; if (ra !== "自由" && el.current) { const [p, q] = ra.split(":").map(Number); const R = el.current.clientWidth / el.current.clientHeight; x.h = clamp((x.w * R * q) / p, .05, 1 - x.t); x.w = (x.h * p) / (q * R); } x.w = clamp(x.w, .05, 1 - x.l); x.h = clamp(x.h, .05, 1 - x.t); return x; };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); const h = (e.target as HTMLElement).closest("i")?.className || ""; const sx = e.clientX, sy = e.clientY, o = { ...rs }; const W = el.current!.clientWidth, H = el.current!.clientHeight; const tgt = e.currentTarget; tgt.setPointerCapture(e.pointerId);
    tgt.onpointermove = (ev) => { const dx = (ev.clientX - sx) / W, dy = (ev.clientY - sy) / H; const r = { ...o };
      if (!h) { r.l = clamp(o.l + dx, 0, 1 - o.w); r.t = clamp(o.t + dy, 0, 1 - o.h); }
      else { if (h.includes("l")) { r.l = clamp(o.l + dx, 0, o.l + o.w - .05); r.w = o.w + (o.l - r.l); } if (h.includes("r")) r.w = clamp(o.w + dx, .05, 1 - o.l); if (h.includes("t")) { r.t = clamp(o.t + dy, 0, o.t + o.h - .05); r.h = o.h + (o.t - r.t); } if (h.includes("b")) r.h = clamp(o.h + dy, .05, 1 - o.t); }
      setRs(ratio !== "自由" && h ? fix(r) : r); };
    tgt.onpointerup = () => { tgt.onpointermove = null; };
  };
  const ok = async () => { const im = await loadImg(src); const c = cv(im.naturalWidth * rs.w, im.naturalHeight * rs.h); c.getContext("2d")!.drawImage(im, -im.naturalWidth * rs.l, -im.naturalHeight * rs.t); setEd(null); await applyVariant(ctl.store, n.id, { url: c.toDataURL("image/jpeg", .92), w: c.width, h: c.height }, "裁剪"); };
  return <>
    <div className="edov" data-ed="crop" ref={el} style={rect} onPointerDown={(e) => e.stopPropagation()}>
      {src ? <img className="crop-img" src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      <div className="crop-rect" style={{ left: rs.l * 100 + "%", top: rs.t * 100 + "%", width: rs.w * 100 + "%", height: rs.h * 100 + "%" }} onPointerDown={down}><i className="tl" /><i className="tr" /><i className="bl" /><i className="br" /></div>
    </div>
    <div className="edbar" style={{ left: rect.left + rect.width / 2, top: Math.min(rect.top + rect.height + 14, ctl.rect().height - 54), transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="取消" onClick={() => setEd(null)}><Icon name="x" /></button><span className="vsep" />
      <button className="pill" onClick={(e) => openPop(e.currentTarget, (close) => <>{["自由", "1:1", "4:3", "3:4", "16:9", "9:16"].map((r) => <button key={r} className={"mi" + (r === ratio ? " on" : "")} onClick={() => { close(); setRatio(r); setRs(fix(rs, r)); }}>{r}</button>)}</>, "up")}><Icon name="ratio" size="s" /><span>宽高比：{ratio}</span></button><span className="vsep" />
      <button className="pill" data-k="ok" style={{ background: "var(--solid)", color: "var(--on-solid)" }} onClick={() => void ok()}><Icon name="check" size="s" />确认裁剪</button>
    </div>
  </>;
}

function Mask({ ctl, n, rect, mode }: { ctl: Ctl; n: CanvasNode; rect: Rect; mode: "redraw" | "erase" | "annot" }) {
  const cvsRef = useRef<HTMLCanvasElement>(null); const strokes = useRef<Array<{ t: string; size: number; p: Array<{ x: number; y: number }> }>>([]);
  const [tool, setTool] = useState("brush"); const [size, setSize] = useState(28); const [prompt, setPrompt] = useState(""); const [, force] = useState(0);
  // 圆圈光标：直径 = 笔刷 size（半径 = size/2），只在画布内、只对鼠标 / 触控笔显示
  const [ring, setRing] = useState<{ x: number; y: number; ptype: string } | null>(null);
  const ringShown = ring ? ringVisible(tool, ring.ptype, true) : false;
  const dia = brushRadius(size) * 2;
  const title = { redraw: "局部重绘", erase: "擦除", annot: "标注" }[mode];
  const paint = () => { const c = cvsRef.current; if (!c) return; const g = c.getContext("2d")!; c.width = c.clientWidth; c.height = c.clientHeight; g.clearRect(0, 0, c.width, c.height);
    for (const s of strokes.current) { g.globalCompositeOperation = s.t === "eraser" ? "destination-out" : "source-over"; g.fillStyle = g.strokeStyle = mode === "annot" ? "rgba(255,69,58,.9)" : "rgba(255,255,255,.55)";
      if (s.t === "rect") { const [a, b] = [s.p[0], s.p[s.p.length - 1]]; if (mode === "annot") { g.lineWidth = 3; g.strokeRect(a.x * c.width, a.y * c.height, (b.x - a.x) * c.width, (b.y - a.y) * c.height); } else g.fillRect(a.x * c.width, a.y * c.height, (b.x - a.x) * c.width, (b.y - a.y) * c.height); }
      else { g.lineWidth = mode === "annot" ? 4 : s.size; g.lineCap = g.lineJoin = "round"; g.beginPath(); s.p.forEach((pt, i) => (i ? g.lineTo(pt.x * c.width, pt.y * c.height) : g.moveTo(pt.x * c.width, pt.y * c.height))); g.stroke(); } }
    g.globalCompositeOperation = "source-over"; };
  useEffect(paint);
  const go = async () => {
    if (!strokes.current.length) return ctl.store.toast(mode === "annot" ? "先在图上画出要改的位置" : "先涂抹需要编辑的区域");
    if (mode === "redraw" && !prompt.trim()) return ctl.store.toast("写一句要改成什么");
    const src = await srcData(ctl.store, outOf(n)?.url || ""); const im = await loadImg(src); const mask = cv(im.naturalWidth, im.naturalHeight); mask.getContext("2d")!.drawImage(cvsRef.current!, 0, 0, mask.width, mask.height);
    setEd(null); await runEdit(ctl.store, n.id, mode === "annot" ? "annotate" : mode, title, { maskDataUrl: mask.toDataURL("image/png"), prompt: prompt.trim() });
  };
  const H = ctl.rect().height;
  return <>
    <div className="edov" data-ed="mask" style={rect} onPointerDown={(e) => e.stopPropagation()}>
      <canvas ref={cvsRef} className="mask-cv"
        style={{ cursor: ringShown ? "none" : "crosshair" }}
        onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setRing({ x: e.clientX - r.left, y: e.clientY - r.top, ptype: e.pointerType || "mouse" }); }}
        onPointerEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setRing({ x: e.clientX - r.left, y: e.clientY - r.top, ptype: e.pointerType || "mouse" }); }}
        onPointerLeave={() => setRing(null)}
        onPointerDown={(e) => { e.stopPropagation(); const c = e.currentTarget; c.setPointerCapture(e.pointerId); const r = c.getBoundingClientRect(); const s = { t: tool, size, p: [{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }] }; strokes.current.push(s);
        c.onpointermove = (ev) => { const pt = { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height }; if (s.t === "rect") s.p[1] = pt; else s.p.push(pt); paint(); }; c.onpointerup = () => { c.onpointermove = null; force((x) => x + 1); }; }} />
      {ringShown && ring ? <div className="brush-ring" data-brush-ring data-brush-size={size} data-brush-dia={Math.round(dia)}
        style={{ left: ring.x, top: ring.y, width: dia, height: dia, transform: "translate(-50%,-50%)" }} /> : null}
    </div>
    <div className="edbar" style={{ left: rect.left + rect.width / 2, top: Math.max(8, rect.top - 56), transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="关闭" onClick={() => setEd(null)}><Icon name="x" /></button><span className="vsep" /><span className="est">{title}</span>
      {([["brush", "brush", "画笔"], ["rect", "rect", "矩形"], ["eraser", "eraser", "橡皮"]] as const).map(([t, ic, tip]) => <button key={t} className={"ib" + (tool === t ? " on" : "")} data-tip={tip} onClick={() => setTool(t)}><Icon name={ic} /></button>)}
      <span className="vsep" /><input type="range" min={6} max={80} value={size} className="slider" style={{ width: 90 }} aria-label="笔刷大小" onChange={(e) => setSize(+e.target.value)} />
      <button className="ib" data-tip="撤销一笔" onClick={() => { strokes.current.pop(); paint(); }}><Icon name="undo" /></button>
    </div>
    <div className="edprompt" style={{ left: rect.left + rect.width / 2, top: Math.min(H - 120, rect.top + rect.height + 14), transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void go(); }} placeholder={mode === "erase" ? "可选：说明要擦掉什么（例如：去掉挂绳）" : mode === "annot" ? "描述标注要做的修改，例如：箭头处的 Logo 放大" : "描述你想改变什么…"} />
      <div className="gp-foot"><span className="est">{mode === "erase" ? "涂抹要擦除的区域" : mode === "annot" ? "在图上圈出要改的位置" : "绘制蒙版以重绘"}</span><span className="sp" /><ToolModelPill op={mode === "annot" ? "annotate" : mode} n={n} /><button className="send" data-k="go" onClick={() => void go()}><Icon name="send" size="s" /></button></div>
    </div>
  </>;
}

/* ---------- 对话框：多角度 / 重打光 / 调整像素 ---------- */
function AngleModal({ ctl, id }: { ctl: Ctl; id: string }) {
  const n = ctl.store.node(id)!; const src = useAssetUrl(outOf(n)?.url || "");
  const [yaw, setYaw] = useState(23), [pitch, setPitch] = useState(-12), [zoom, setZoom] = useState(1), [wide, setWide] = useState(false);
  const go = () => {
    closeModal(); const store = ctl.store;
    const v = withGen({ id: uid("n"), kind: "image", x: n.x + n.w + 80, y: n.y, w: n.w, h: n.h, text: "" }, { ...genOf(n), title: `多角度 ${yaw}°`, prompt: "", hist: [], hi: 0, order: [] });
    store.addNodes([v], [{ id: uid("e"), from: n.id, to: v.id }], { select: true });
    void runEdit(store, id, "angle", "多角度", { params: { yaw, pitch, zoom, wide } }, v.id);
  };
  return <><ModalHead title="多角度" /><div className="mbd">
    <div className="angle-stage" onPointerDown={(e) => { const sx = e.clientX, sy = e.clientY, oy = yaw, op = pitch; const el = e.currentTarget; el.setPointerCapture(e.pointerId); el.onpointermove = (ev) => { setYaw(clamp(Math.round(oy + (ev.clientX - sx) * .6), -180, 180)); setPitch(clamp(Math.round(op - (ev.clientY - sy) * .4), -60, 60)); }; el.onpointerup = () => (el.onpointermove = null); }}>
      <div className="grid" /><div className="card3d" style={{ transform: `rotateY(${yaw}deg) rotateX(${-pitch}deg) scale(${zoom})` }}>{src ? <img src={src} alt="" /> : null}</div></div>
    <p style={{ color: "var(--fg3)", fontSize: 12, margin: "8px 0" }}>拖动方块调整角度。生成一个新视角的图片节点，原图不变，并自动连线。</p>
    <div className="ctlrow"><span>旋转</span><input type="range" className="slider" min={-180} max={180} value={yaw} onChange={(e) => setYaw(+e.target.value)} /><span className="tnum">{yaw}°</span></div>
    <div className="ctlrow"><span>俯仰</span><input type="range" className="slider" min={-60} max={60} value={pitch} onChange={(e) => setPitch(+e.target.value)} /><span className="tnum">{pitch}°</span></div>
    <div className="ctlrow"><span>缩放</span><input type="range" className="slider" min={50} max={200} value={Math.round(zoom * 100)} onChange={(e) => setZoom(+e.target.value / 100)} /><span className="tnum">{zoom.toFixed(1)}×</span></div>
    <div className="row" style={{ padding: "6px 0" }}><span>模型</span><ToolModelPill op="angle" n={n} /></div>
    <div className="row" style={{ padding: "6px 0" }}><span>广角镜头</span><button className={"sw" + (wide ? " on" : "")} onClick={() => setWide(!wide)} /></div>
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}><button className="btn" onClick={() => { setYaw(0); setPitch(0); setZoom(1); }}>重置</button><button className="btn solid" id="ago" onClick={go}>生成新视角</button></div>
  </div></>;
}
function RelightModal({ ctl, id }: { ctl: Ctl; id: string }) {
  const n = ctl.store.node(id)!; const src = useAssetUrl(outOf(n)?.url || "");
  const [lx, setLx] = useState(.25), [ly, setLy] = useState(.3), [inten, setInten] = useState(70), [temp, setTemp] = useState(40); const [pv, setPv] = useState("");
  useEffect(() => { if (!src) return; let alive = true; const t = setTimeout(() => void (relit(src, lx, ly, inten, temp, 360) as Promise<string>).then((u) => { if (alive) setPv(u); }).catch(() => undefined), 60); return () => { alive = false; clearTimeout(t); }; }, [src, lx, ly, inten, temp]);
  return <><ModalHead title="重打光" /><div className="mbd">
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <div className="light-pad" onPointerDown={(e) => { const el = e.currentTarget; el.setPointerCapture(e.pointerId); const mv = (ev: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); setLx(clamp((ev.clientX - r.left) / r.width, 0, 1)); setLy(clamp((ev.clientY - r.top) / r.height, 0, 1)); }; mv(e); el.onpointermove = mv; el.onpointerup = () => (el.onpointermove = null); }}><i style={{ left: lx * 100 + "%", top: ly * 100 + "%" }} /></div>
      <div style={{ flex: 1, minWidth: 200 }}><img src={pv || src} style={{ width: "100%", borderRadius: 12, maxHeight: 220, objectFit: "contain", background: "var(--s0)" }} alt="" /></div>
    </div>
    <div className="ctlrow"><span>强度</span><input type="range" className="slider" min={10} max={100} value={inten} onChange={(e) => setInten(+e.target.value)} /><span className="tnum">{inten}%</span></div>
    <div className="ctlrow"><span>色温</span><input type="range" className="slider" min={0} max={100} value={temp} onChange={(e) => setTemp(+e.target.value)} /><span>{temp < 40 ? "偏暖" : temp > 60 ? "偏冷" : "中性"}</span></div>
    <div className="row" style={{ padding: "6px 0" }}><span>模型</span><ToolModelPill op="relight" n={n} /></div>
    <p style={{ color: "var(--fg3)", fontSize: 12, margin: "8px 0 0" }}>预览是本地近似效果，点「应用」由所选图片模型按光源方向、强度和色温重新打光。</p>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}><button className="btn solid" id="rgo" onClick={() => { closeModal(); void runEdit(ctl.store, id, "relight", "重打光", { params: { lx, ly, intensity: inten, temp } }); }}>应用</button></div>
  </div></>;
}
function ResizeModal({ ctl, id }: { ctl: Ctl; id: string }) {
  const n = ctl.store.node(id)!; const o = outOf(n)!; const w0 = o.w || 1024, h0 = o.h || 1024;
  const [w, setW] = useState(w0), [h, setH] = useState(h0), [lock, setLock] = useState(true);
  const go = async () => { const W = clamp(w, 16, 4096), H = clamp(h, 16, 4096); closeModal(); const im = await loadImg(await srcData(ctl.store, o.url || "")); const c = cv(W, H); const g = c.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, W, H); await applyVariant(ctl.store, id, { url: c.toDataURL("image/jpeg", .92), w: W, h: H }, `调整像素 ${W}×${H}`); };
  const inp = { width: 110, background: "var(--sunken)", borderRadius: 8, padding: "6px 8px" };
  return <><ModalHead title="调整像素" /><div className="mbd">
    <div className="row"><span>宽</span><input type="number" className="tnum" style={inp} value={w} onChange={(e) => { const v = +e.target.value; setW(v); if (lock) setH(Math.round((v * h0) / w0)); }} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="row"><span>高</span><input type="number" className="tnum" style={inp} value={h} onChange={(e) => { const v = +e.target.value; setH(v); if (lock) setW(Math.round((v * w0) / h0)); }} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="row"><span>锁定比例</span><button className={"sw" + (lock ? " on" : "")} onClick={() => setLock(!lock)} /></div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}><button className="btn solid" onClick={() => void go()}>应用</button></div>
  </div></>;
}

/* ---------- 切分 / 截帧 ---------- */
async function split(ctl: Ctl, id: string, k: number) {
  const store = ctl.store; const n = store.node(id)!; const im = await loadImg(await srcData(store, outOf(n)?.url || "")); const W = im.naturalWidth / k, H = im.naturalHeight / k; const cw = Math.round((n.w / k) * 1.4);
  const made: CanvasNode[] = []; const edges: Array<{ id: string; from: string; to: string }> = [];
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) {
    const cvs = cv(W, H); cvs.getContext("2d")!.drawImage(im, -c * W, -r * H);
    const url = await store.backend.importAsset(store.state.canvasId, cvs.toDataURL("image/jpeg", .9), `${genOf(n).title} ${r + 1}-${c + 1}`);
    const t = store.newNode("image", n.x + n.w + 80 + c * (cw + 16), n.y + r * ((cw * H) / W + 40), { title: `${genOf(n).title} ${r + 1}-${c + 1}`, w: cw, h: Math.round((cw * H) / W), hist: [{ url, w: Math.round(W), h: Math.round(H) }] });
    made.push(t); edges.push({ id: uid("e"), from: n.id, to: t.id });
  }
  store.addNodes(made, edges, { select: true }); ctl.fitTo([n, ...made], 100, 1); store.toast(`已切成 ${k * k} 张，每张都连到原图`);
}
/**
 * 视频截帧：current = 正在播放的那一帧（没在播就退回封面）；
 * first / last = 用临时 video 定位到开头 / 结尾再画（对齐 TapNow 的截帧 1 / 首帧 2 / 尾帧 3）。
 */
export async function grabVideoFrame(store: CanvasStore, n: CanvasNode, at: "current" | "first" | "last"): Promise<string> {
  const o = outOf(n);
  if (!o) return "";
  // 「当前帧」= 节点里正在播放/暂停的那一帧；流式地址（openarc-resource）画到 canvas 会被标记为跨源、导不出，
  // 这时改用数据地址的隐藏 video 跳到同一时间点再取
  let nowAt = -1;
  if (at === "current") {
    const vid = document.querySelector(`.node[data-id="${n.id}"] video`) as HTMLVideoElement | null;
    if (vid && vid.videoWidth) {
      try { const c = cv(vid.videoWidth, vid.videoHeight); c.getContext("2d")!.drawImage(vid, 0, 0); return c.toDataURL("image/jpeg", .92); }
      catch { nowAt = vid.currentTime || 0; }
    }
  }
  const src = o.url ? await srcData(store, o.url) : "";
  if (!src) return o.frame ? await srcData(store, o.frame) : "";
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.src = src;
  const ok = await new Promise<boolean>((resolve) => {
    v.onloadedmetadata = () => resolve(true);
    v.onerror = () => resolve(false);
    setTimeout(() => resolve(!!v.videoWidth), 4000);
  });
  if (!ok || !v.videoWidth) return o.frame ? await srcData(store, o.frame) : "";
  const duration = Number(v.duration) || 0;
  // 设了「使用区间」就按区间取首/尾帧（截帧跟着区间走）
  const trim = o.trim ? clampTrim(o.dur, o.trim) : null;
  v.currentTime = nowAt >= 0 ? Math.min(nowAt, Math.max(0, duration - 0.05)) : at === "first"
    ? (trim ? trim.in : Math.min(0.05, Math.max(0, duration / 2)))
    : (trim ? Math.min(trim.out, duration || trim.out) : Math.max(0, duration - 0.05));
  await new Promise<void>((resolve) => { v.onseeked = () => resolve(); setTimeout(resolve, 3000); });
  const c = cv(v.videoWidth, v.videoHeight);
  c.getContext("2d")!.drawImage(v, 0, 0);
  return c.toDataURL("image/jpeg", .92);
}

/** 把某一帧做成新的图片节点（默认连到视频节点） */
async function frameNode(store: CanvasStore, n: CanvasNode, at: "current" | "first" | "last", label: string, opts: { link?: boolean } = {}) {
  const data = await grabVideoFrame(store, n, at);
  if (!data) { store.toast("还没有可截取的画面：先等视频生成完成"); return null; }
  const url = data.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, data, genOf(n).title + " · " + label) : data;
  // 图片节点按帧的真实比例摆放（宽度跟视频节点一致），避免 16:9 的帧被裁成方块
  const im = data.startsWith("data:") ? await loadImg(data).catch(() => null) : null;
  const fw = im?.naturalWidth || 0, fh = im?.naturalHeight || 0;
  const size = fw && fh ? { w: n.w, h: Math.round((n.w * fh) / fw), } : {};
  const made = store.newNode("image", n.x + n.w + 60, n.y, { title: genOf(n).title + " · " + label, hist: [{ url, ...(fw && fh ? { w: fw, h: fh } : {}) }], ...size });
  store.addNodes([made], opts.link === false ? [] : [{ id: uid("e"), from: n.id, to: made.id }], { select: true });
  return made;
}

/** 视频裁剪 / 擦除：先截当前帧成图片节点，再在它上面打开对应编辑器（视频逐帧处理要转码，暂不做） */
async function frameThen(ctl: Ctl, n: CanvasNode, editor: "crop" | "erase") {
  const store = ctl.store;
  const made = await frameNode(store, n, "current", editor === "crop" ? "裁剪素材" : "擦除素材");
  if (!made) return;
  if (editor === "crop") openEditor(ctl, "crop", made.id);
  else setEd({ type: "mask", id: made.id, mode: "erase" });
  store.toast(editor === "crop" ? "已截当前帧，在它上面裁剪" : "已截当前帧，在它上面擦除");
}

async function captureFrame(store: CanvasStore, n: CanvasNode, at: "current" | "first" | "last" = "current") {
  const label = at === "first" ? "首帧" : at === "last" ? "尾帧" : "当前帧";
  const made = await frameNode(store, n, at, label);
  if (made) store.toast(`已截取${label}，作为新的图片节点`);
}

/** 设为视频封面：把首帧写进当前结果的 frame（节点卡片 / 分享预览都用它） */
async function setVideoCover(store: CanvasStore, n: CanvasNode) {
  const data = await grabVideoFrame(store, n, "first");
  if (!data) { store.toast("还没有可截取的画面：先等视频生成完成"); return; }
  const url = data.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, data, genOf(n).title + " · 封面") : data;
  store.patchGen(n.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, frame: url } : h)) }), { history: true });
  store.toast("已设为视频封面");
}

/** 应用到画布：把视频画面作为一张独立图片节点放到画布上（不连线） */
async function applyVideoToCanvas(store: CanvasStore, n: CanvasNode) {
  const made = await frameNode(store, n, "first", "应用到画布", { link: false });
  if (made) store.toast("已把视频画面放到画布上");
}
