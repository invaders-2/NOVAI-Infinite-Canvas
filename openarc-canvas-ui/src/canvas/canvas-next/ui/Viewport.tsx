/**
 * 视口：平移 / 缩放 / 拖动节点 / 框选 / 调整大小 / 从 ⊕ 拉线（磁吸）/ 右键 / 双击 / 拖放文件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { addFiles, commitText, connect, replaceNodeMedia } from "../actions";
import { connectBlock, genOf, inputsOf, isGenKind, outOf, srcOf } from "../model";
import { batchOf, dropImageOnCell } from "../table";
import { useCtl, useS } from "./ctx";
import { Edges } from "./Edges";
import { addMenu, blankMenu, nodeMenu, portMenu, onNodeAct } from "./menus";
import { NodeView } from "./NodeView";
import { closePop } from "./overlay";
import { addToStack, hiddenIds, isStack } from "../stack";
import { addToTimeline, clipable } from "../playlist";
import { reconcileGroups } from "../groupFit";
import { bodyBox, snapToGuides, unionBox, type Box, type Guide } from "../snapGuides";

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean; /** 右键按下：没拖动就在松开时弹右键菜单 */ menu?: { nodeId: string | null } }
  | { kind: "node"; start: { x: number; y: number }; moved: boolean; orig: Array<{ id: string; x: number; y: number }>; pos?: Map<string, { x: number; y: number }> }
  | { kind: "resize"; id: string; sx: number; sy: number; w: number; h: number; ar: number; keepRatio: boolean }
  | { kind: "conn" }
  | { kind: "marq"; sx: number; sy: number; base: Set<string>; moved: boolean };

const dragPath = (a: { x: number; y: number }, b: { x: number; y: number }) => { const dx = Math.max(60, Math.abs(b.x - a.x) * .5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
/** 拖动中只更新合成层与 SVG，松手后才提交 React 文档，避免每个 pointermove 全树重渲染。 */
function paintNodeDrag(doc: CanvasDoc, pos: Map<string, { x: number; y: number }>) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const [id, p] of pos) {
    const n = byId.get(id); if (!n) continue;
    const el = document.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`);
    if (el) el.style.transform = `translate(${p.x - n.x}px,${p.y - n.y}px)`;
  }
  const svg = document.getElementById("edges");
  for (const e of doc.edges) {
    if (!pos.has(e.from) && !pos.has(e.to)) continue;
    const a0 = byId.get(e.from), b0 = byId.get(e.to); if (!a0 || !b0) continue;
    const a = pos.get(e.from) || a0, b = pos.get(e.to) || b0;
    const p1 = { x: a.x + a0.w, y: a.y + 24 + a0.h / 2 }, p2 = { x: b.x, y: b.y + 24 + b0.h / 2 }, d = dragPath(p1, p2);
    svg?.querySelectorAll(`path[data-edge="${CSS.escape(e.id)}"]`).forEach((el) => el.setAttribute("d", d));
    const gradient = svg?.querySelector(`#${CSS.escape("cn-eg-" + e.id)}`);
    gradient?.setAttribute("x1", String(p1.x)); gradient?.setAttribute("y1", String(p1.y)); gradient?.setAttribute("x2", String(p2.x)); gradient?.setAttribute("y2", String(p2.y));
    svg?.querySelector(`g[data-edge-badge="${CSS.escape(e.id)}"]`)?.setAttribute("transform", `translate(${p2.x - 14},${p2.y})`);
  }
}
function clearNodeDrag(pos: Map<string, { x: number; y: number }>) {
  for (const id of pos.keys()) { const el = document.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`); if (el) el.style.transform = ""; }
}

export function Viewport() {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const view = useS((s) => s.view); const ui = useS((s) => s.ui); const runtime = useS((s) => s.runtime); const batches = useS((s) => s.batches);
  const vpRef = useRef<HTMLDivElement>(null); const drag = useRef<Drag | null>(null); const space = useRef(false);
  /** 右键菜单已在 pointerup 里弹过（Windows 的 contextmenu 在松开后才来，避免弹两次） */
  const menuAt = useRef(0);
  const [marq, setMarq] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [panning, setPanning] = useState(false);
  /** 拖动节点时的对齐参考线（世界坐标） */
  const [guides, setGuidesState] = useState<Guide[]>([]); const guidesRef = useRef(0);
  const setGuides = (g: Guide[]) => { if (!g.length && !guidesRef.current) return; guidesRef.current = g.length; setGuidesState(g); };
  /** 拖动节点经过的堆叠（松开就放进去） */
  const [dropStack, setDropStack] = useState<string | null>(null); const dropRef = useRef<string | null>(null);
  // 把一张图片节点拖到表格的图片单元格（首帧 / 尾帧 / 参考图列）上：松手后图填进单元格，节点回到原位
  const cellRef = useRef<HTMLElement | null>(null);
  const cellUnder = (x: number, y: number, orig: Array<{ id: string }>) => {
    if (orig.length !== 1) return null; const n = store.node(orig[0].id);
    if (!n || n.kind !== "image" || !outOf(n)?.url) return null;
    return (document.elementsFromPoint(x, y).find((el) => (el as HTMLElement).dataset?.mcell) as HTMLElement | undefined) || null;
  };
  const markCell = (el: HTMLElement | null) => { if (cellRef.current === el) return; cellRef.current?.classList.remove("drop"); el?.classList.add("drop"); cellRef.current = el; };
  // 按几何位置找指针下的堆叠：拖动时每一帧都要查，不用 elementsFromPoint（会强制重新布局）
  const stackUnder = (x: number, y: number, moving: Set<string>) => {
    const p = ctl.toWorld(x, y); const nodes = store.state.doc.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]; if (!moving.has(n.id) && isStack(n) && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + 24 + n.h) return n.id; }
    return null;
  };
  /** 拖着的全是有结果的视频 / 音频时，指针下的剪辑时间线节点（TapNow：把视频拖进 Playlist） */
  const timelineUnder = (x: number, y: number, moving: Set<string>) => {
    if (![...moving].every((id) => clipable(store.node(id)))) return null;
    for (const el of document.elementsFromPoint(x, y)) { const id = (el as HTMLElement).closest?.(".node")?.getAttribute("data-id"); if (id && !moving.has(id) && store.node(id)?.kind === "timeline") return id; }
    return null;
  };
  useEffect(() => { ctl.vp = vpRef.current; }, [ctl]);

  // 空格拖动画布
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.key === " " && !isTyping()) space.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
    addEventListener("keydown", dn); addEventListener("keyup", up); return () => { removeEventListener("keydown", dn); removeEventListener("keyup", up); };
  }, []);

  const portPos = (n: CanvasNode, side: "in" | "out") => ({ x: side === "out" ? n.x + n.w : n.x, y: n.y + 24 + n.h / 2 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    closePop();
    const vp = vpRef.current!; const st = store.state; const t = e.target as HTMLElement;
    // 右键：按住拖动 = 平移画布（TapNow）；没拖动 = 松开时弹右键菜单
    if (e.button === 2) {
      if (t.closest("textarea:not([readonly]),input:not([readonly])")) return;
      const nodeEl = t.closest(".node") as HTMLElement | null;
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false, menu: { nodeId: nodeEl?.dataset.id || null } };
      vp.setPointerCapture(e.pointerId); return;
    }
    if (e.button === 1 || space.current) { e.preventDefault(); drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: true }; setPanning(true); vp.setPointerCapture(e.pointerId); return; }
    if (t.closest(".nhead .t.rename")) return;
    const nodeEl = t.closest(".node") as HTMLElement | null;
    // Agent 选择上下文 / 选择输入
    if (nodeEl && st.ui.agentPick) { const id = nodeEl.dataset.id!; window.dispatchEvent(new CustomEvent("cn:agent-pick", { detail: id })); return; }
    // 「替换」模式：点另一个节点，用它的当前版本替换目标节点的当前版本
    if (nodeEl && st.ui.replace) {
      const target = st.ui.replace; const src = store.node(nodeEl.dataset.id!); const o = src ? outOf(src) : null;
      if (src && o?.url) { replaceNodeMedia(store, target, { url: o.url, frame: o.frame, w: o.w, h: o.h }); store.setUI({ replace: null, sel: new Set([target]) }); }
      else store.toast("这个节点还没有可替换的结果");
      return;
    }
    if (nodeEl && st.ui.pick) { const target = st.ui.pick; const id = nodeEl.dataset.id!; if (id !== target) connect(store, id, target); store.setUI({ pick: target, sel: new Set([target]) }); return; }
    const rz = t.closest("[data-rz]");
    if (rz && nodeEl) { const n = store.node(nodeEl.dataset.id)!; store.snapshot(); drag.current = { kind: "resize", id: n.id, sx: e.clientX, sy: e.clientY, w: n.w, h: n.h, ar: n.h / n.w, keepRatio: n.kind === "image" || n.kind === "video" }; vp.setPointerCapture(e.pointerId); return; }
    const port = t.closest("[data-port]") as HTMLElement | null;
    if (st.ui.editText && !(nodeEl && nodeEl.dataset.id === st.ui.editText)) (document.getElementById("txtEdit") as HTMLTextAreaElement | null)?.blur();
    if (port && nodeEl) {
      const n = store.node(nodeEl.dataset.id)!; const out = port.dataset.port === "out";
      store.setUI({ conn: { id: n.id, rev: !out, a: portPos(n, out ? "out" : "in"), p: ctl.toWorld(e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, over: null } });
      vp.closest(".cn-root")?.classList.add("connecting"); vp.setPointerCapture(e.pointerId); drag.current = { kind: "conn" }; return;
    }
    if (nodeEl) {
      const id = nodeEl.dataset.id!;
      if (t.closest("[data-act]")) return; // 节点内按钮自己处理
      if (t.closest("textarea:not([readonly]),input:not([readonly])")) return;
      let sel = st.ui.sel;
      if (e.shiftKey || e.metaKey) { sel = new Set(sel); sel.has(id) ? sel.delete(id) : sel.add(id); }
      else if (!sel.has(id)) sel = new Set([id]);
      store.setUI({ sel, edge: null });
      // 拖分组 = 连同组内节点一起移动
      const moving = new Set(sel); sel.forEach((sid) => { const g = store.node(sid); if (g && g.kind === "group") (g.children || []).forEach((c) => { if (store.node(c)) moving.add(c); }); });
      drag.current = { kind: "node", start: ctl.toWorld(e.clientX, e.clientY), moved: false, orig: [...moving].map((sid) => { const n = store.node(sid)!; return { id: sid, x: n.x, y: n.y }; }) };
      vp.setPointerCapture(e.pointerId); return;
    }
    const edgeEl = t.closest("[data-edge]") as HTMLElement | null;
    if (edgeEl) { store.setUI({ edge: edgeEl.dataset.edge!, sel: new Set() }); return; }
    if (st.ui.cmtMode) { window.dispatchEvent(new CustomEvent("cn:place-comment", { detail: ctl.toWorld(e.clientX, e.clientY) })); return; }
    if (st.ui.pick) { store.setUI({ pick: null }); return; }
    if (st.ui.replace) { store.setUI({ replace: null }); return; }
    // 左键拖空白：默认框选（TapNow），触屏和「平移」偏好下拖动平移；Shift / ⌘ 框选时在原选择上追加
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive || (st.ui.leftDrag === "select" && e.pointerType !== "touch")) {
      drag.current = { kind: "marq", sx: e.clientX, sy: e.clientY, base: additive ? new Set(st.ui.sel) : new Set(), moved: false };
      if (st.ui.editText) (document.getElementById("txtEdit") as HTMLTextAreaElement | null)?.blur();
      vp.setPointerCapture(e.pointerId); return;
    }
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false }; vp.setPointerCapture(e.pointerId);
  }, [store, ctl]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current; if (!d) return; const st = store.state;
    if (d.kind === "pan") { const dx = e.clientX - d.sx, dy = e.clientY - d.sy; if (Math.abs(dx) + Math.abs(dy) > 3 && !d.moved) { d.moved = true; setPanning(true); } store.setView({ ...st.view, x: d.vx + dx, y: d.vy + dy }); }
    else if (d.kind === "node") {
      const p = ctl.toWorld(e.clientX, e.clientY); const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3 / st.view.k) return;
      if (!d.moved) { store.snapshot(); d.moved = true; store.setUI({ dragging: true }); }
      // 对齐参考线：整批节点的外框去对其它节点的边 / 中线；对上的方向不再做网格吸附
      let gx = 0, gy = 0, lines: Guide[] = [];
      if (st.ui.guides && !e.altKey) {
        const moving = new Set(d.orig.map((o) => o.id)); const hidden = hiddenIds(st.doc.nodes);
        const box = unionBox(d.orig.flatMap((o) => { const n = store.node(o.id); return n ? [bodyBox({ x: o.x + dx, y: o.y + dy, w: n.w, h: n.h })] : []; }));
        const others: Box[] = st.doc.nodes.filter((n) => !moving.has(n.id) && !hidden.has(n.id)).map(bodyBox);
        if (box) { const r = snapToGuides(box, others, 6 / st.view.k); gx = r.dx; gy = r.dy; lines = r.guides; }
      }
      const onX = lines.some((g) => g.axis === "x"), onY = lines.some((g) => g.axis === "y");
      setGuides(lines);
      const pos = new Map(d.orig.map((o) => { let x = o.x + dx + gx, y = o.y + dy + gy; if (st.ui.snap) { if (!onX) x = Math.round(x / 20) * 20; if (!onY) y = Math.round(y / 20) * 20; } return [o.id, { x: Math.round(x), y: Math.round(y) }]; }));
      d.pos = pos; paintNodeDrag(st.doc, pos);
      const ids = new Set(d.orig.map((o) => o.id));
      const over = (d.orig.some((o) => isStack(store.node(o.id))) ? null : stackUnder(e.clientX, e.clientY, ids)) || timelineUnder(e.clientX, e.clientY, ids);
      if (over !== dropRef.current) { dropRef.current = over; setDropStack(over); }
      markCell(cellUnder(e.clientX, e.clientY, d.orig));
    } else if (d.kind === "resize") {
      const dx = (e.clientX - d.sx) / st.view.k, dy = (e.clientY - d.sy) / st.view.k;
      const w = Math.round(Math.max(140, Math.min(900, d.w + dx))); const h = d.keepRatio ? Math.round(w * d.ar) : Math.round(Math.max(80, Math.min(900, d.h + dy)));
      store.updateNode(d.id, (n) => ({ ...n, w, h }));
    } else if (d.kind === "conn" && st.ui.conn) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest(".node") as HTMLElement | null;
      const c = st.ui.conn; let over = el && el.dataset.id !== c.id ? el.dataset.id! : null;
      if (over && connectBlock(st.doc, c.rev ? over : c.id, c.rev ? c.id : over)) over = null;
      store.setUI({ conn: { ...c, p: ctl.toWorld(e.clientX, e.clientY), over } });
    } else if (d.kind === "marq") {
      if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
      d.moved = true;
      const r = vpRef.current!.getBoundingClientRect();
      setMarq({ x: Math.min(e.clientX, d.sx) - r.left, y: Math.min(e.clientY, d.sy) - r.top, w: Math.abs(e.clientX - d.sx), h: Math.abs(e.clientY - d.sy) });
      const a = ctl.toWorld(Math.min(e.clientX, d.sx), Math.min(e.clientY, d.sy)), b = ctl.toWorld(Math.max(e.clientX, d.sx), Math.max(e.clientY, d.sy));
      const hidden = hiddenIds(st.doc.nodes);
      // 分组框只有被完整框住才选中（框住组里几个节点时不把整个组拖着走）
      const hit = st.doc.nodes.filter((n) => !hidden.has(n.id) && (n.kind === "group" && !isStack(n) ? n.x >= a.x && n.x + n.w <= b.x && n.y >= a.y && n.y + n.h + 24 <= b.y : n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + n.h + 24 > a.y)).map((n) => n.id);
      store.setUI({ sel: new Set([...d.base, ...hit]), edge: null });
    }
  }, [store, ctl]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current; if (!d) return; drag.current = null; setPanning(false); const st = store.state;
    if (d.kind === "pan" && d.menu) {
      // Windows 在 mouseup 之后才发 contextmenu：拖动平移结束也要记下时间，onContext 才会忽略它
      menuAt.current = Date.now();
      if (d.moved) return;
      const id = d.menu.nodeId && store.node(d.menu.nodeId) ? d.menu.nodeId : null;
      if (id) { if (!st.ui.sel.has(id)) store.setUI({ sel: new Set([id]), edge: null }); nodeMenu(ctl, { x: e.clientX, y: e.clientY }); }
      else blankMenu(ctl, { x: e.clientX, y: e.clientY }, ctl.toWorld(e.clientX, e.clientY));
      return;
    }
    if (d.kind === "pan" && !d.moved) { if (st.ui.editText) (document.getElementById("txtEdit") as HTMLTextAreaElement | null)?.blur(); store.setUI({ sel: new Set(), edge: null, editCell: null }); }
    if (d.kind === "node" && d.moved) {
      if (d.pos) { clearNodeDrag(d.pos); store.mutate((doc) => ({ ...doc, nodes: doc.nodes.map((n) => (d.pos!.has(n.id) ? { ...n, ...d.pos!.get(n.id)! } : n)) }), { history: false }); }
      setGuides([]); store.setUI({ dragging: false }); dropRef.current = null; setDropStack(null);
      const cell = cellUnder(e.clientX, e.clientY, d.orig); markCell(null);
      if (cell && dropImageOnCell(store, cell.dataset.mcell!, d.orig[0].id, cell.dataset.multi === "1")) { const o = d.orig[0]; store.updateNode(o.id, (n) => ({ ...n, x: o.x, y: o.y })); return; }
      const tl = timelineUnder(e.clientX, e.clientY, new Set(d.orig.map((o) => o.id)));
      if (tl && addToTimeline(store, tl, d.orig.map((o) => o.id))) { d.orig.forEach((o) => store.updateNode(o.id, (n) => ({ ...n, x: o.x, y: o.y }))); return; }
      const over = d.orig.some((o) => isStack(store.node(o.id))) ? null : stackUnder(e.clientX, e.clientY, new Set(d.orig.map((o) => o.id)));
      // 拖的是普通分组：只叠分组外单独选中的节点，组里的节点跟着分组走，不拆进叠
      const dragged = new Set(d.orig.map((o) => o.id)); const inDraggedGroup = new Set(d.orig.flatMap((o) => { const g = store.node(o.id); return g && g.kind === "group" ? g.children || [] : []; }));
      if (over) addToStack(store, over, [...dragged].filter((id) => !inDraggedGroup.has(id)));
      // 普通分组：拖进框里就加入，拖出框就移出，框扩大包住组员（与拖动同一步撤销）
      else { const next = reconcileGroups(store.state.doc, [...dragged]); if (next !== store.state.doc) store.mutate(() => next, { history: false }); }
    }
    if (d.kind === "marq") { setMarq(null); if (!d.moved) store.setUI({ sel: d.base, edge: null, editCell: null }); }
    if (d.kind === "conn") {
      vpRef.current?.closest(".cn-root")?.classList.remove("connecting"); const c = st.ui.conn; store.setUI({ conn: null }); if (!c) return;
      if (!c.over && Math.hypot(e.clientX - c.sx, e.clientY - c.sy) < 5) { portMenu(ctl, store.node(c.id)!, c.rev ? "in" : "out", { x: e.clientX + 14, y: e.clientY - 20 }); return; }
      if (c.over) connect(store, c.rev ? c.over : c.id, c.rev ? c.id : c.over);
      else if (!c.rev) { const p = ctl.toWorld(e.clientX, e.clientY); addMenu(ctl, { x: e.clientX + 6, y: e.clientY + 6 }, { x: p.x + 140, y: p.y }, c.id); }
    }
  }, [store, ctl]);

  // 滚轮：平移；⌘/Ctrl+滚轮 或触控板捏合：缩放
  useEffect(() => {
    const vp = vpRef.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.(".tgrid,.ntext")) { const el = (e.target as HTMLElement).closest(".tgrid,.ntext") as HTMLElement; if (el.scrollHeight > el.clientHeight && !(e.ctrlKey || e.metaKey) && store.state.ui.sel.has((el.closest(".node") as HTMLElement)?.dataset.id || "")) return; }
      e.preventDefault(); const v = store.state.view;
      if (e.ctrlKey || e.metaKey) ctl.zoomAt(v.k * Math.exp(-e.deltaY * .0025), e.clientX, e.clientY);
      else store.setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
    };
    vp.addEventListener("wheel", onWheel, { passive: false }); return () => vp.removeEventListener("wheel", onWheel);
  }, [store, ctl]);

  // ⊕ 磁吸：80px 感应区内 ⊕ 朝指针偏移（纵向 ≈1:1，横向滞后约一半，TapNow 实测）
  const pzCur = useRef<HTMLElement | null>(null);
  const onHover = (e: React.PointerEvent) => {
    if (drag.current) return; const z = (e.target as HTMLElement).closest?.(".pz") as HTMLElement | null;
    if (pzCur.current && pzCur.current !== z) { const f = pzCur.current.querySelector(".pf") as HTMLElement | null; if (f) f.style.transform = ""; }
    pzCur.current = z; if (!z) return;
    const r = z.getBoundingClientRect(); const k = store.state.view.k; const R = 26;
    let tx = ((e.clientX - (r.left + r.width / 2)) / k) * .5, ty = ((e.clientY - (r.top + r.height / 2)) / k) * .9; const dd = Math.hypot(tx, ty); if (dd > R) { tx *= R / dd; ty *= R / dd; }
    (z.querySelector(".pf") as HTMLElement).style.transform = `translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px)`;
  };

  const onDouble = (e: React.MouseEvent) => {
    const tg = (document.elementFromPoint(e.clientX, e.clientY) || e.target) as HTMLElement;
    const nodeEl = tg.closest(".node") as HTMLElement | null;
    const tt = tg.closest(".nhead .t") as HTMLElement | null;
    if (tt && nodeEl) { renameInline(nodeEl.dataset.id!, tt); return; }
    if (nodeEl) { const n = store.node(nodeEl.dataset.id)!; if (isStack(n)) { window.dispatchEvent(new CustomEvent("cn:stack", { detail: n.id })); return; } if (n.kind === "table") { /* 指针被画布捕获后双击到不了单元格：按位置找到单元格进入编辑 */ const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-cell]") as HTMLElement | null; if (cell?.dataset.cell) { store.snapshot(); store.setUI({ editCell: cell.dataset.cell, sel: new Set([n.id]) }); } return; } if (n.kind === "text" && !tg.closest("[data-act]")) { window.dispatchEvent(new CustomEvent("cn:textdoc", { detail: n.id })); return; } if (outOf(n)) window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: n.id })); return; }
    if (tg.closest("[data-edge]")) return;
    const w = ctl.toWorld(e.clientX, e.clientY); addMenu(ctl, { x: e.clientX + 4, y: e.clientY + 4 }, w);
  };
  const renameInline = (id: string, el: HTMLElement) => {
    const n = store.node(id); if (!n) return;
    // 分组 / 堆叠：名字存在 node.text（起名「首帧」「尾帧」后连到文本节点，出表时按组名放图）
    if (n.kind === "group") {
      el.contentEditable = "true"; el.classList.add("rename"); el.focus(); const rg = document.createRange(); rg.selectNodeContents(el); const sl = getSelection()!; sl.removeAllRanges(); sl.addRange(rg);
      const fin = (save: boolean) => { el.contentEditable = "false"; el.classList.remove("rename"); const v = (el.textContent || "").trim().slice(0, 40); if (save && v && v !== n.text) { store.updateNode(id, (x) => ({ ...x, text: v }), { history: true }); store.toast(`已重命名为「${v}」`); } else el.textContent = n.text || "分组"; };
      el.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); el.onblur = null; fin(true); } if (ev.key === "Escape") { el.onblur = null; fin(false); } };
      el.onblur = () => fin(true); return;
    }
    if (!isGenKind(n.kind)) return;
    el.contentEditable = "true"; el.classList.add("rename"); el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    const done = (save: boolean) => { el.contentEditable = "false"; el.classList.remove("rename"); const v = (el.textContent || "").trim().slice(0, 40); const old = genOf(n).title; if (save && v && v !== old) { store.patchGen(id, { title: v }, { history: true }); store.toast(`已重命名为「${v}」，引用它的提示词需要同步修改`); } else el.textContent = old; };
    el.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); el.onblur = null; done(true); } if (ev.key === "Escape") { el.onblur = null; done(false); } };
    el.onblur = () => done(true);
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    // 鼠标右键在 pointerup 里处理（拖动平移 / 不动弹菜单）；这里只接键盘菜单键等没有按下过程的情况
    if (drag.current?.kind === "pan" && drag.current.menu) return;
    if (Date.now() - menuAt.current < 600) return;
    const nodeEl = (e.target as HTMLElement).closest(".node") as HTMLElement | null;
    if (nodeEl) { const id = nodeEl.dataset.id!; if (!store.state.ui.sel.has(id)) store.setUI({ sel: new Set([id]), edge: null }); nodeMenu(ctl, { x: e.clientX, y: e.clientY }); }
    else blankMenu(ctl, { x: e.clientX, y: e.clientY }, ctl.toWorld(e.clientX, e.clientY));
  };

  const queuedIds = new Set(Object.values(batches).flatMap((b) => b.queued));
  const handleAct = useCallback((node: CanvasNode, act: string, e: React.SyntheticEvent) => onNodeAct(ctl, node, act, e), [ctl]);
  const handleTextCommit = useCallback((id: string, text: string) => commitText(store, id, text), [store]);
  const k = view.k; const gs = 24 * (k < .45 ? 2 : 1) * k;
  const conn = ui.conn;
  return (
    <div id="vp" ref={vpRef} className={(panning ? "panning" : "") + (ui.pick || ui.agentPick ? " picking" : "") + (ui.cmtMode ? " commenting" : "")}
      style={{ backgroundSize: `${gs}px ${gs}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onPointerDown} onPointerMove={(e) => { onPointerMove(e); onHover(e); if (store.state.collab.transport) window.dispatchEvent(new CustomEvent("cn:cursor", { detail: ctl.toWorld(e.clientX, e.clientY) })); }} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => { if (store.state.collab.transport) window.dispatchEvent(new CustomEvent("cn:cursor", { detail: null })); }}
      onDoubleClick={onDouble} onContextMenu={onContext}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const files = [...(e.dataTransfer?.files || [])]; if (files.length) void addFiles(store, files, ctl.toWorld(e.clientX, e.clientY)); }}>
      <div id="world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${k})`, ["--zinv" as string]: String(1 / k) }}>
        <Edges />
        {guides.map((g, i) => <div key={i} className={"snapguide " + g.axis} style={g.axis === "x" ? { left: g.at, top: g.from, height: g.to - g.from, width: 1 / k } : { top: g.at, left: g.from, width: g.to - g.from, height: 1 / k }} />)}
        <div id="nodes">
          {(() => { const hidden = hiddenIds(doc.nodes); return doc.nodes.filter((n) => !hidden.has(n.id)); })().sort((a, b) => (a.kind === "group" && !isStack(a) ? 0 : 1) - (b.kind === "group" && !isStack(b) ? 0 : 1)).map((n) => {
            const run = runtime[n.id];
            const queued = queuedIds.has(n.id);
            const loadSrc = run ? srcOf(n) || inputsOf(doc, n.id).map((x) => srcOf(x.node)).find(Boolean) : undefined;
            const bj = run ? null : batchOf(n).journal;
            const batchInfo = bj && n.kind !== "table" ? `${bj.rows.filter((r) => r.status === "completed").length}/${bj.rows.length} 行` : undefined;
            return <NodeView key={n.id} node={n} sel={ui.sel.has(n.id)} modelName={(store.modelOf(n) || {}).name} run={run} editing={ui.editText === n.id} drop={conn?.over === n.id || dropStack === n.id} noconn={!!conn && conn.over !== n.id && !!connectBlock(doc, conn.rev ? n.id : conn.id, conn.rev ? conn.id : n.id)} hl={ui.hlNode === n.id} loadSrc={loadSrc} batchInfo={batchInfo} queued={queued}
              onAct={handleAct} onTextCommit={handleTextCommit} />;
          })}
        </div>
        <PeerCursors k={k} />
      </div>
      {marq ? <div id="marquee" style={{ display: "block", left: marq.x, top: marq.y, width: marq.w, height: marq.h }} /> : null}
    </div>
  );
}

/** 协作者的光标（画布坐标）：按 clientId 取一个灰阶色，不用彩色 */
function PeerCursors({ k }: { k: number }) {
  const peers = useS((s) => s.collab.peers);
  return <>{peers.filter((p) => p.cursor).map((p, i) => <div key={p.id} className="peer-cur" style={{ transform: `translate(${p.cursor!.x}px,${p.cursor!.y}px) scale(${1 / k})` }}>
    <svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1l13 7-6 1.6L5 16z" /></svg><span>{p.name || "协作者 " + (i + 1)}</span></div>)}</>;
}

export function isTyping() { const a = document.activeElement as HTMLElement | null; return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable) && !(a as HTMLInputElement).readOnly; }
