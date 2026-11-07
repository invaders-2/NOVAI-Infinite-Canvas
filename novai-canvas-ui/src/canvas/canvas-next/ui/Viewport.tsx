/**
 * 视口：平移 / 缩放 / 拖动节点 / 框选 / 调整大小 / 从 ⊕ 拉线（磁吸）/ 右键 / 双击 / 拖放文件。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { addFiles, commitText, connect, replaceNodeMedia, title } from "../actions";
import type { CanvasStore } from "../store";
import { connectBlock, genOf, inputsOf, isGenKind, outOf, srcOf, uid, withGen } from "../model";
import { batchOf, dropImageOnCell } from "../table";
import { useCtl, useS } from "./ctx";
import { Edges } from "./Edges";
import { addMenu, blankMenu, nodeMenu, portMenu, onNodeAct } from "./menus";
import { NodeView } from "./NodeView";
import { ICON_PATHS } from "./Icon";
import { placeItem, saveNodeToLibraryDrop } from "./Library";
import { closePop } from "./overlay";
import { dropSourceUrls } from "./sourceDrop";
import { addToStack, hiddenIds, isStack, stackItems } from "../stack";
import { addToTimeline, clipable } from "../playlist";
import { memberIdsDeep, reconcileGroups } from "../groupFit";
import { bodyBox, snapToGuides, unionBox, type Box, type Guide } from "../snapGuides";

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: "node"; start: { x: number; y: number }; moved: boolean; orig: Array<{ id: string; x: number; y: number }>; pos?: Map<string, { x: number; y: number }>; /** 指针进了助手面板：节点冻结回原位，只留跟随指针的 ghost */ frozen?: boolean; /** ⌥ / Alt 拖动：松手把副本落到拖到的位置，原节点不动 */ copy?: "plain" | "edges" }
  | { kind: "resize"; id: string; sx: number; sy: number; w: number; h: number; ar: number; keepRatio: boolean }
  | { kind: "conn" }
  | { kind: "marq"; sx: number; sy: number; base: Set<string>; moved: boolean }
  | { kind: "asset"; id: string; sx: number; sy: number; orig: { x: number; y: number }; moved: boolean };

const dragPath = (a: { x: number; y: number }, b: { x: number; y: number }) => { const dx = Math.max(60, Math.abs(b.x - a.x) * .5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
/** 按几何重写受影响的边（pos 传拖动态；不传则用文档里的位置还原） */
function paintEdges(doc: CanvasDoc, ids: Set<string>, pos?: Map<string, { x: number; y: number }>) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const svg = document.getElementById("edges");
  for (const e of doc.edges) {
    if (!ids.has(e.from) && !ids.has(e.to)) continue;
    const a0 = byId.get(e.from), b0 = byId.get(e.to); if (!a0 || !b0) continue;
    const a = pos?.get(e.from) || a0, b = pos?.get(e.to) || b0;
    const p1 = { x: a.x + a0.w, y: a.y + 24 + a0.h / 2 }, p2 = { x: b.x, y: b.y + 24 + b0.h / 2 }, d = dragPath(p1, p2);
    svg?.querySelectorAll(`path[data-edge="${CSS.escape(e.id)}"]`).forEach((el) => el.setAttribute("d", d));
    const gradient = svg?.querySelector(`#${CSS.escape("cn-eg-" + e.id)}`);
    gradient?.setAttribute("x1", String(p1.x)); gradient?.setAttribute("y1", String(p1.y)); gradient?.setAttribute("x2", String(p2.x)); gradient?.setAttribute("y2", String(p2.y));
    svg?.querySelector(`g[data-edge-badge="${CSS.escape(e.id)}"]`)?.setAttribute("transform", `translate(${p2.x - 14},${p2.y})`);
  }
}
/** 拖动中只更新合成层与 SVG，松手后才提交 React 文档，避免每个 pointermove 全树重渲染。 */
function paintNodeDrag(doc: CanvasDoc, pos: Map<string, { x: number; y: number }>) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const [id, p] of pos) {
    const n = byId.get(id); if (!n) continue;
    const el = document.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`);
    if (el) el.style.transform = `translate(${p.x - n.x}px,${p.y - n.y}px)`;
  }
  paintEdges(doc, new Set(pos.keys()), pos);
}
/** 节点回原位时边也要一起还原，否则冻结/落库后线还停在拖到的位置 */
function clearNodeDrag(doc: CanvasDoc, pos: Map<string, { x: number; y: number }>) {
  for (const id of pos.keys()) { const el = document.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`); if (el) el.style.transform = ""; }
  paintEdges(doc, new Set(pos.keys()));
}
let trackpadUntil = 0;
/** 触控板双指滑动的 deltaY 通常只有个位数到几十、deltaMode 也是 0，只有真鼠标滚轮才是一个数量级以上的台阶（老画布 ReactCanvas 用同一判据） */
function isMouseWheelEvent(e: WheelEvent) {
  if (e.deltaMode !== 0) return true;
  // 触控板事件是碎片化的小 delta：出现过一次就标记一小段时间，避免随后的甩动峰值被当成滚轮
  if (Math.abs(e.deltaY) < 100) { trackpadUntil = performance.now() + 300; return false; }
  return performance.now() >= trackpadUntil;
}
/** ⌥ / Alt 拖动松手：副本落在拖到的位置；keepInputs 时把外部输入连线也复制过来 */
function duplicateDrag(store: CanvasStore, orig: Array<{ id: string; x: number; y: number }>, pos: Map<string, { x: number; y: number }> | undefined, keepInputs: boolean) {
  const ids = new Set(orig.map((o) => o.id)); const doc = store.state.doc;
  const src = doc.nodes.filter((n) => ids.has(n.id)); if (!src.length) return;
  const map = new Map<string, string>();
  const copies = src.map((n) => { const c: CanvasNode = JSON.parse(JSON.stringify(n)); c.id = uid("n"); map.set(n.id, c.id); const p = pos?.get(n.id); c.x = Math.round(p ? p.x : n.x + 20); c.y = Math.round(p ? p.y : n.y + 20); return c; });
  const inner = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: uid("e"), from: map.get(e.from)!, to: map.get(e.to)! }));
  const kept = keepInputs ? doc.edges.filter((e) => ids.has(e.to) && !ids.has(e.from)).map((e) => ({ id: uid("e"), from: e.from, to: map.get(e.to)! })) : [];
  const edges = [...inner, ...kept];
  const fixed = copies.map((c) => {
    const own = edges.filter((e) => e.to === c.id).map((e) => e.id);
    const q = isGenKind(c.kind) ? withGen(c, { order: own }) : c;
    return q.children ? { ...q, children: q.children.map((x) => map.get(x)).filter((x): x is string => !!x) } : q;
  });
  // 拖动开始时已经存过撤销快照（onPointerMove 里），这里不再多存一步
  store.addNodes(fixed, edges, { select: true, history: false });
  store.toast(keepInputs ? `已复制 ${fixed.length} 个节点（保留输入连线）` : `已复制 ${fixed.length} 个节点`);
}

export function Viewport() {
  const ctl = useCtl(); const store = ctl.store;
  // 刻意不订阅 view：平移/缩放只改 #world 的 transform 与网格背景（命令式，见下面的 viewBridge），
  // 否则每个 pointermove 都要重渲整棵节点树 + 写 --zinv 触发子树样式重算。
  const doc = useS((s) => s.doc); const ui = useS((s) => s.ui); const runtime = useS((s) => s.runtime); const batches = useS((s) => s.batches);
  const vpRef = useRef<HTMLDivElement>(null); const worldRef = useRef<HTMLDivElement>(null); const drag = useRef<Drag | null>(null); const space = useRef(false);
  const [marq, setMarq] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [panning, setPanning] = useState(false);
  /** 拖动节点时的对齐参考线（世界坐标） */
  const [guides, setGuidesState] = useState<Guide[]>([]); const guidesRef = useRef(0);
  const setGuides = (g: Guide[]) => { if (!g.length && !guidesRef.current) return; guidesRef.current = g.length; setGuidesState(g); };
  /** 拖动节点经过的堆叠（松开就放进去） */
  const [dropStack, setDropStack] = useState<string | null>(null); const dropRef = useRef<string | null>(null);
  // 把一张图片节点拖到表格的图片单元格（首帧 / 尾帧 / 参考图列）上：松手后图填进单元格，节点回到原位
  const cellRef = useRef<HTMLElement | null>(null);
  const ghostRef = useRef<HTMLElement | null>(null); const assetOverRef = useRef(false); const assetFolderRef = useRef<string | null>(null); const assetFolderIdRef = useRef<string | null>(null);
  const clearAssetDrop = () => {
    vpRef.current?.closest(".cn-root")?.classList.remove("asset-drag");
    document.getElementById("drawer")?.classList.remove("asset-drop");
    document.querySelectorAll(".lib-folder-list .lib-row.drop-on").forEach((el) => el.classList.remove("drop-on"));
    ghostRef.current?.remove(); ghostRef.current = null;
    assetOverRef.current = false; assetFolderRef.current = null; assetFolderIdRef.current = null;
  };
  const showGhost = (id: string, x: number, y: number) => {
    const n = store.node(id); if (!n) return;
    let el = ghostRef.current;
    if (!el) { el = document.createElement("div"); el.className = "cn-drag-ghost"; (document.querySelector(".cn-root") || document.body).appendChild(el); ghostRef.current = el; }
    const o = outOf(n); const thumb = document.createElement("div"); thumb.className = "gthumb";
    if (n.kind === "text" || !o?.url) thumb.textContent = "T";
    else if (n.kind === "audio") thumb.textContent = "♪";
    else { const img = document.createElement("img"); img.alt = ""; img.src = o.url.startsWith("/assets") || o.url.startsWith("/output") ? "/api/media-preview?w=180&url=" + encodeURIComponent(o.url) : o.url; img.onerror = () => { img.remove(); thumb.textContent = n.kind === "video" ? "▶" : "▧"; }; thumb.appendChild(img); }
    el.replaceChildren(thumb);
    el.style.left = (x + 14) + "px"; el.style.top = (y + 14) + "px";
  };
  const markAssetDrop = (id: string, x: number, y: number) => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const over = !!hit?.closest("#drawer .lib-shell");
    assetOverRef.current = over;
    if (!over) { clearAssetDrop(); return; }
    vpRef.current?.closest(".cn-root")?.classList.add("asset-drag");
    document.getElementById("drawer")?.classList.add("asset-drop");
    showGhost(id, x, y);
    const row = hit?.closest(".lib-folder-list .lib-row") as HTMLElement | null;
    document.querySelectorAll(".lib-folder-list .lib-row.drop-on").forEach((el) => el.classList.remove("drop-on"));
    if (row) row.classList.add("drop-on");
    assetFolderRef.current = row?.dataset.folderName || null; assetFolderIdRef.current = row?.dataset.folderId || null;
  };
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

  // 视图变换命令式落地：store 里的 view 照旧更新（ctl.toWorld / 小地图 / 连线端点都读它），
  // 但只有这里写 DOM——平移到不写 --zinv，缩放时 --zinv 变化才写一次；每帧最多一次（rAF 合并）。
  useLayoutEffect(() => {
    const store = ctl.store; const world = worldRef.current; const vp = vpRef.current;
    if (!world || !vp) return;
    let raf = 0; let zinv = "";
    const apply = () => {
      raf = 0;
      const v = store.state.view;
      world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
      // --zinv 是给「分组按钮 / 排队徽标 / 参考线 / 协作者光标」做反向缩放的。它是祖先级自定义属性，
      // 一写就要重算整棵节点子树的样式（实测缩放时 RecalcStyle 占单帧 CPU 一半以上），所以：
      //   · k ≥ 1 时 CSS 的 max(1, …) 本来就把它钉在 1 —— 直接写 "1"，放大全程零重算；
      //   · k < 1 时按 1/24 量化（24px 的小按钮每档差不到 1px，看不出来），重算次数降到 1/8 左右。
      const raw = 1 / v.k;
      const z = raw <= 1 ? "1" : (Math.round(raw * 24) / 24).toFixed(3);
      if (z !== zinv) { zinv = z; world.style.setProperty("--zinv", z); }
      const gs = 24 * (v.k < .45 ? 2 : 1) * v.k;
      vp.style.backgroundSize = `${gs}px ${gs}px`;
      vp.style.backgroundPosition = `${v.x}px ${v.y}px`;
    };
    apply();
    const off = store.subscribe(() => { if (!raf) raf = requestAnimationFrame(apply); });
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, [ctl]);

  // 空格拖动画布
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.key === " " && !isTyping()) space.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
    addEventListener("keydown", dn); addEventListener("keyup", up); return () => { removeEventListener("keydown", dn); removeEventListener("keyup", up); };
  }, []);

  const portPos = (n: CanvasNode, side: "in" | "out") => ({ x: side === "out" ? n.x + n.w : n.x, y: n.y + 24 + n.h / 2 });

  /** 节点拖到助手面板 / 输入区：进面板就冻结节点只留 ghost，在输入区松手才落成引用胶囊 */
  const inRect = (r: DOMRect | null, x: number, y: number) => !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const overAgentPanel = (x: number, y: number) => inRect(document.getElementById("agent")?.getBoundingClientRect() ?? null, x, y);
  const overComposer = (x: number, y: number) => inRect(document.getElementById("aiBox")?.getBoundingClientRect() ?? null, x, y);
  /** 悬停高亮：切 class 只会改底色，不动布局 */
  const markComposerDrop = (el: HTMLElement | null) => {
    const prev = document.querySelector<HTMLElement>(".ap2-composer.is-drop-target");
    if (prev && prev !== el) prev.classList.remove("is-drop-target");
    el?.classList.add("is-drop-target");
  };
  /** 跟着指针的拖拽缩略图：图片取首帧，文本 / 音频 / 表格 / 分组用类型图标；多选和分组标数量 */
  const nodeGhostRef = useRef<HTMLElement | null>(null);
  const clearNodeGhost = () => { nodeGhostRef.current?.remove(); nodeGhostRef.current = null; };
  const svgIcon = (name: keyof typeof ICON_PATHS) => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || ICON_PATHS.layers) + "</svg>";
  const showNodeGhost = (ids: string[], x: number, y: number) => {
    const first = ids.length ? store.node(ids[0]) : null; if (!first) return;
    let el = nodeGhostRef.current;
    if (!el) {
      el = document.createElement("div");
      el.className = "cn-drag-ghost cn-node-ghost";
      el.innerHTML = '<span class="gthumb"></span><span class="gmeta"><b class="gtext"></b><i class="gsub"></i></span>';
      (document.querySelector(".cn-root") || document.body).appendChild(el);
      nodeGhostRef.current = el;
    }
    const thumb = el.querySelector<HTMLElement>(".gthumb")!;
    const text = el.querySelector<HTMLElement>(".gtext")!;
    const sub = el.querySelector<HTMLElement>(".gsub")!;
    const members = isStack(first) ? stackItems(store.state.doc, first)
      : first.kind === "group" ? (first.children || []).map((id) => store.node(id)).filter((n): n is CanvasNode => !!n) : [];
    const pick = members.find((n) => !!srcOf(n)) || first;
    const src = isGenKind(pick.kind) ? srcOf(pick) : "";
    const icon = (pick.kind === "video" ? "video" : pick.kind === "audio" ? "audio" : pick.kind === "text" ? "text" : pick.kind === "table" ? "grid" : pick.kind === "group" ? "layers" : "image") as keyof typeof ICON_PATHS;
    thumb.innerHTML = src ? "" : svgIcon(icon);
    if (src) {
      const img = document.createElement("img"); img.alt = "";
      img.src = src.startsWith("/assets") || src.startsWith("/output") ? "/api/media-preview?w=180&url=" + encodeURIComponent(src) : src;
      img.onerror = () => { img.remove(); thumb.innerHTML = svgIcon(icon); };
      thumb.appendChild(img);
    }
    text.textContent = title(first);
    const count = Math.max(ids.length, members.length);
    sub.textContent = count > 1 ? "引用 " + count + " 个" : first.kind === "group" ? (isStack(first) ? "整个堆叠" : "分组") : "";
    sub.style.display = sub.textContent ? "" : "none";
    el.style.left = (x + 12) + "px"; el.style.top = (y + 12) + "px";
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    closePop();
    const vp = vpRef.current!; const st = store.state; const t = e.target as HTMLElement;
    // 右键只出菜单：平移已改成中键 / 空格，右键若继续走下面的分支会误拖节点或清掉选择
    if (e.button === 2) return;
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
      // ⌥ / Alt 拖动 = 复制一份（再按住 ⇧ 时保留输入连线），与旧画布一致
      if (e.altKey) {
        let sel = st.ui.sel;
        if (!sel.has(id)) sel = new Set([id]);
        store.setUI({ sel, edge: null });
        // 拖分组 / 堆叠时成员一起复制
        const picked = new Set(sel);
        // 嵌套分组要递归带上所有层级的成员，否则内层组的成员会被留在原地
        memberIdsDeep(st.doc, sel).forEach((c) => { if (store.node(c)) picked.add(c); });
        drag.current = { kind: "node", start: ctl.toWorld(e.clientX, e.clientY), moved: false, copy: e.shiftKey ? "edges" : "plain", orig: [...picked].map((sid) => { const n = store.node(sid)!; return { id: sid, x: n.x, y: n.y }; }) };
        vp.setPointerCapture(e.pointerId); return;
      }
      let sel = st.ui.sel;
      if (e.shiftKey || e.metaKey) { sel = new Set(sel); sel.has(id) ? sel.delete(id) : sel.add(id); }
      else if (!sel.has(id)) sel = new Set([id]);
      store.setUI({ sel, edge: null });
      // 拖分组 = 连同组内节点一起移动（嵌套分组递归到所有层级）
      const moving = new Set(sel); memberIdsDeep(st.doc, sel).forEach((c) => { if (store.node(c)) moving.add(c); });
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
    else if (d.kind === "asset") {
      if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
      d.moved = true;
      markAssetDrop(d.id, e.clientX, e.clientY);
    } else if (d.kind === "node") {
      const p = ctl.toWorld(e.clientX, e.clientY); const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3 / st.view.k) return;
      if (!d.moved) { store.snapshot(); d.moved = true; store.setUI({ dragging: true }); }
      // 画布内拖动保持干净的拖影；只有指针进助手面板才出缩略图（同时冻结节点回原位）
      const overPanel = overAgentPanel(e.clientX, e.clientY);
      if (overPanel !== !!d.frozen) {
        d.frozen = overPanel;
        if (overPanel) { if (d.pos) clearNodeDrag(st.doc, d.pos); setGuides([]); }
      }
      if (overPanel) {
        const picked = [...st.ui.sel].filter((id) => !!store.node(id));
        showNodeGhost(picked.length ? picked : d.orig.map((o) => o.id), e.clientX, e.clientY);
      } else clearNodeGhost();
      markComposerDrop(overPanel ? document.getElementById("aiBox") : null);
      if (d.frozen) return;
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
      markAssetDrop(d.orig[0].id, e.clientX, e.clientY);
      const ids = new Set(d.orig.map((o) => o.id));
      const over = (d.orig.some((o) => isStack(store.node(o.id))) ? null : stackUnder(e.clientX, e.clientY, ids)) || timelineUnder(e.clientX, e.clientY, ids);
      if (over !== dropRef.current) { dropRef.current = over; setDropStack(over); }
      markCell(cellUnder(e.clientX, e.clientY, d.orig));
    } else if (d.kind === "resize") {
      const dx = (e.clientX - d.sx) / st.view.k, dy = (e.clientY - d.sy) / st.view.k;
      // 拖动改尺寸不设硬上限（文本节点也要能拉大）；最小 120×80，媒体节点保持原比例
      const minW = 120, minH = 80;
      let w = Math.round(Math.max(minW, d.w + dx));
      let h = d.keepRatio ? Math.round(w * d.ar) : Math.round(Math.max(minH, d.h + dy));
      if (d.keepRatio && h < minH) { h = minH; w = Math.round(h / d.ar); }
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
    if (d.kind === "asset") {
      const over = d.moved && assetOverRef.current;
      const folder = assetFolderRef.current; const folderId = assetFolderIdRef.current;
      clearAssetDrop();
      if (over) { void saveNodeToLibraryDrop(ctl, d.id, folder, folderId); return; }
      if (d.moved) { const p = ctl.toWorld(e.clientX, e.clientY); const start = ctl.toWorld(d.sx, d.sy); store.snapshot(); store.updateNode(d.id, (n) => ({ ...n, x: Math.round(d.orig.x + p.x - start.x), y: Math.round(d.orig.y + p.y - start.y) })); }
      return;
    }
    if (d.kind === "pan" && !d.moved) { if (st.ui.editText) (document.getElementById("txtEdit") as HTMLTextAreaElement | null)?.blur(); store.setUI({ sel: new Set(), edge: null, editCell: null }); }
    if (d.kind === "node") { markComposerDrop(null); clearNodeGhost(); }
    if (d.kind === "node" && d.moved && assetOverRef.current) {
      const id = d.orig[0].id; const folder = assetFolderRef.current; const folderId = assetFolderIdRef.current;
      if (d.pos) clearNodeDrag(st.doc, d.pos);
      const orig = new Map(d.orig.map((o) => [o.id, o]));
      store.mutate((doc) => ({ ...doc, nodes: doc.nodes.map((n) => { const o = orig.get(n.id); return o ? { ...n, x: o.x, y: o.y } : n; }) }), { history: false });
      setGuides([]); store.setUI({ dragging: false }); dropRef.current = null; setDropStack(null);
      clearAssetDrop(); void saveNodeToLibraryDrop(ctl, id, folder, folderId); return;
    }
    // 拖到助手面板松手：节点一律回到原处；落点在内嵌输入框里才变成引用胶囊（单个 / 多选 / 分组 / 堆叠都按节点 id 引用）
    if (d.kind === "node" && d.moved && d.frozen) {
      if (d.pos) clearNodeDrag(st.doc, d.pos);
      clearAssetDrop(); setGuides([]); store.setUI({ dragging: false }); dropRef.current = null; setDropStack(null); markCell(null);
      if (overComposer(e.clientX, e.clientY)) {
        const picked = [...st.ui.sel].filter((id) => !!store.node(id));
        window.dispatchEvent(new CustomEvent("cn:agent-drop-nodes", { detail: picked.length ? picked : d.orig.map((o) => o.id) }));
      }
      return;
    }
    // ⌥ 拖动：原节点留在原处，副本落在拖到的位置
    if (d.kind === "node" && d.moved && d.copy) {
      clearAssetDrop();
      if (d.pos) clearNodeDrag(st.doc, d.pos);
      setGuides([]); store.setUI({ dragging: false }); dropRef.current = null; setDropStack(null);
      duplicateDrag(store, d.orig, d.pos, d.copy === "edges");
      return;
    }
    if (d.kind === "node" && d.moved) {
      clearAssetDrop();
      if (d.pos) { clearNodeDrag(st.doc, d.pos); store.mutate((doc) => ({ ...doc, nodes: doc.nodes.map((n) => (d.pos!.has(n.id) ? { ...n, ...d.pos!.get(n.id)! } : n)) }), { history: false }); }
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

  // 滚轮分三种：触控板捏合 / 真鼠标滚轮 = 缩放，触控板双指滑动 = 平移（与老画布 ReactCanvas 同一套判据）
  useEffect(() => {
    const vp = vpRef.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.(".tgrid,.ntext")) { const el = (e.target as HTMLElement).closest(".tgrid,.ntext") as HTMLElement; if (el.scrollHeight > el.clientHeight && !(e.ctrlKey || e.metaKey) && store.state.ui.sel.has((el.closest(".node") as HTMLElement)?.dataset.id || "")) return; }
      e.preventDefault(); const v = store.state.view;
      // 捏合是浏览器合成的 ⌘/Ctrl+wheel：保持改动前的公式，触控板手感才和以前一样
      if (e.ctrlKey || e.metaKey) { ctl.zoomAt(v.k * Math.exp(-e.deltaY * .0025), e.clientX, e.clientY); return; }
      if (isMouseWheelEvent(e)) {
        // deltaMode 为行 / 页时先折算成像素，否则同一格鼠标滚轮的缩放跨度差几十倍
        const raw = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
        // 单次再夹一道：高精度滚轮偶发的大 delta 会一帧跳到缩放上下限
        const dy = Math.max(-180, Math.min(180, raw));
        ctl.zoomAt(v.k * Math.exp(-dy * .0018), e.clientX, e.clientY);
        return;
      }
      store.setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
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
    // 右键菜单只在这里出：右键按下不再开始拖动，不会和 pointerup 各弹一次
    const nodeEl = (e.target as HTMLElement).closest(".node") as HTMLElement | null;
    if (nodeEl) { const id = nodeEl.dataset.id!; if (!store.state.ui.sel.has(id)) store.setUI({ sel: new Set([id]), edge: null }); nodeMenu(ctl, { x: e.clientX, y: e.clientY }); }
    else blankMenu(ctl, { x: e.clientX, y: e.clientY }, ctl.toWorld(e.clientX, e.clientY));
  };

  const queuedIds = new Set(Object.values(batches).flatMap((b) => b.queued));
  const handleAct = useCallback((node: CanvasNode, act: string, e: React.SyntheticEvent) => onNodeAct(ctl, node, act, e), [ctl]);
  const handleTextCommit = useCallback((id: string, text: string) => commitText(store, id, text), [store]);
  const conn = ui.conn;
  // 参考线只在拖动节点时存在（每次 pointermove 都会重渲），所以直接在渲染时读一次精确的 1/k，
  // 不必为它订阅 view；也不能用 --zinv（那个值在 k≥1 时被钉成 1，会让线变粗）。
  const zinvExact = 1 / store.state.view.k;
  return (
    <div id="vp" ref={vpRef} className={(panning ? "panning" : "") + (ui.pick || ui.agentPick ? " picking" : "") + (ui.cmtMode ? " commenting" : "")}
      style={{ backgroundSize: "24px 24px" }}
      onPointerDown={onPointerDown} onPointerMove={(e) => { onPointerMove(e); onHover(e); if (store.state.collab.transport) window.dispatchEvent(new CustomEvent("cn:cursor", { detail: ctl.toWorld(e.clientX, e.clientY) })); }} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => { if (store.state.collab.transport) window.dispatchEvent(new CustomEvent("cn:cursor", { detail: null })); }}
      onDoubleClick={onDouble} onContextMenu={onContext}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const at = ctl.toWorld(e.clientX, e.clientY); const lib = (window as unknown as { __novaiLibDrag?: Parameters<typeof placeItem>[1] }).__novaiLibDrag; if (lib) { delete (window as unknown as { __novaiLibDrag?: unknown }).__novaiLibDrag; void placeItem(ctl, lib, { x: e.clientX, y: e.clientY }); return; } const files = [...(e.dataTransfer?.files || [])]; if (files.length) void addFiles(store, files, at); else void dropSourceUrls(store, at, e.dataTransfer); }}>
      <div id="world" ref={worldRef}>
        <Edges />
        {guides.map((g, i) => <div key={i} className={"snapguide " + g.axis} style={g.axis === "x" ? { left: g.at, top: g.from, height: g.to - g.from, width: zinvExact } : { top: g.at, left: g.from, width: g.to - g.from, height: zinvExact }} />)}
        <div id="nodes">
          {(() => { const hidden = hiddenIds(doc.nodes); return doc.nodes.filter((n) => !hidden.has(n.id)); })().sort((a, b) => (a.kind === "group" && !isStack(a) ? 0 : 1) - (b.kind === "group" && !isStack(b) ? 0 : 1)).map((n) => {
            const run = runtime[n.id];
            const queued = queuedIds.has(n.id);
            const bj = run ? null : batchOf(n).journal;
            const batchInfo = bj && n.kind !== "table" ? `${bj.rows.filter((r) => r.status === "completed").length}/${bj.rows.length} 行` : undefined;
            return <NodeView key={n.id} node={n} sel={ui.sel.has(n.id)} modelName={(store.modelOf(n) || {}).name} run={run} editing={ui.editText === n.id} drop={conn?.over === n.id || dropStack === n.id} noconn={!!conn && conn.over !== n.id && !!connectBlock(doc, conn.rev ? n.id : conn.id, conn.rev ? conn.id : n.id)} hl={ui.hlNode === n.id} batchInfo={batchInfo} queued={queued}
              onAct={handleAct} onTextCommit={handleTextCommit} />;
          })}
        </div>
        <PeerCursors />
      </div>
      {marq ? <div id="marquee" style={{ display: "block", left: marq.x, top: marq.y, width: marq.w, height: marq.h }} /> : null}
    </div>
  );
}

/** 协作者的光标（画布坐标）：按 clientId 取一个灰阶色，不用彩色；1/k 让光标在任何缩放下都是同样大 */
function PeerCursors() {
  const peers = useS((s) => s.collab.peers);
  // 只让这一小块订阅缩放：光标数量是个位数，每帧重渲几个 div 可以忽略；Viewport 主体不订阅。
  const k = useS((s) => s.view.k);
  const inv = 1 / k;
  return <>{peers.filter((p) => p.cursor).map((p, i) => <div key={p.id} className="peer-cur" style={{ transform: `translate(${p.cursor!.x}px,${p.cursor!.y}px) scale(${inv})` }}>
    <svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1l13 7-6 1.6L5 16z" /></svg><span>{p.name || "协作者 " + (i + 1)}</span></div>)}</>;
}

export function isTyping() { const a = document.activeElement as HTMLElement | null; return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable) && !(a as HTMLInputElement).readOnly; }