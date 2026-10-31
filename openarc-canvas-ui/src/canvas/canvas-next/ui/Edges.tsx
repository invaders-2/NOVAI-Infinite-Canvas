import { memo, useEffect, useRef } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { afterInputsChanged, title } from "../actions";
import { inputsOf } from "../model";
import { useCtl, useS } from "./ctx";
import { stackOwners } from "../stack";

const portPos = (n: CanvasNode, side: "in" | "out") => ({ x: side === "out" ? n.x + n.w : n.x, y: n.y + 24 + n.h / 2 });
function pathD(a: { x: number; y: number }, b: { x: number; y: number }) { const dx = Math.max(60, Math.abs(b.x - a.x) * .5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; }

/** 连线层：新连线画出动效；选中节点 / 连线时高亮并显示输入序号 */
export const Edges = memo(function Edges() {
  const doc = useS((s) => s.doc); const ui = useS((s) => s.ui); const runtime = useS((s) => s.runtime);
  const seen = useRef<Set<string> | null>(null);
  const isNew = (id: string) => { if (!seen.current) return false; return !seen.current.has(id); };
  useEffect(() => { seen.current = new Set(doc.edges.map((e) => e.id)); });
  // 收在堆叠里的节点不单独显示：连到它们的线改连到堆叠上（TapNow），同一对端点只画一条
  const owner = stackOwners(doc.nodes);
  const byId = new Map(doc.nodes.filter((n) => !owner.has(n.id)).map((n) => [n.id, n]));
  const items: React.ReactElement[] = []; const pairs = new Set<string>();
  for (const e of doc.edges) {
    const a = byId.get(owner.get(e.from) || e.from), b = byId.get(owner.get(e.to) || e.to); if (!a || !b || a === b) continue;
    const viaStack = owner.has(e.from) || owner.has(e.to);
    if (viaStack) { const pk = a.id + ">" + b.id; if (pairs.has(pk)) continue; pairs.add(pk); }
    const p1 = portPos(a, "out"), p2 = portPos(b, "in"); const d = pathD(p1, p2);
    const sel = ui.edge === e.id || ui.sel.has(b.id) || ui.sel.has(a.id);
    const draw = isNew(e.id);
    const flow = !!runtime[b.id] && !runtime[a.id];
    items.push(<path key={"h" + e.id} className="hit" data-edge={e.id} d={d} />);
    items.push(<path key={e.id} className={"e" + (sel ? " sel" : "") + (draw ? " draw" : "") + (ui.hlEdge === e.id ? " hl" : "") + (flow ? " gen" : "")} data-edge={e.id} d={d} {...(draw ? { pathLength: 1 } : {})} />);
    // 生成中：同 TapNow，沿连线方向（上游 → 正在生成的节点）扫过一段高光，2s 一轮
    if (flow) {
      const gid = "cn-eg-" + e.id;
      items.push(
        <g key={"g" + e.id} className="egen">
          <defs>
            <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}>
              <stop offset="0%" className="s0"><animate attributeName="offset" values="-0.5;1" dur="2s" repeatCount="indefinite" /></stop>
              <stop offset="0%" className="s1"><animate attributeName="offset" values="-0.3;1.2" dur="2s" repeatCount="indefinite" /></stop>
              <stop offset="0%" className="s0"><animate attributeName="offset" values="-0.1;1.4" dur="2s" repeatCount="indefinite" /></stop>
            </linearGradient>
          </defs>
          <path d={d} stroke={`url(#${gid})`} />
        </g>,
      );
    }
    if (viaStack) continue;
    const ins = inputsOf(doc, b.id); const ord = ins.findIndex((x) => x.edge.id === e.id);
    if (ins.length > 1 || sel) items.push(<g key={"b" + e.id} className={"badge" + (ui.edge === e.id || ui.sel.has(b.id) ? " sel" : "")} data-edge-badge={e.id} transform={`translate(${p2.x - 14},${p2.y})`}><circle r="8" /><text>{ord + 1}</text></g>);
  }
  if (ui.conn) { const c = ui.conn; items.push(<path key="tmp" className="tmp" d={c.rev ? pathD(c.p, c.a) : pathD(c.a, c.p)} />); }
  return <svg id="edges" className={ui.hideEdges ? "hidden" : ""}>{items}</svg>;
});

/** 选中连线时的浮标：前移 / 后移 / 删除 */
export function EdgeBadge() {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const edgeId = useS((s) => s.ui.edge); useS((s) => s.view);
  const e = doc.edges.find((x) => x.id === edgeId); if (!e) return null;
  const a = store.node(e.from), t = store.node(e.to); if (!a || !t) return null;
  const ins = inputsOf(doc, t.id); const i = ins.findIndex((x) => x.edge.id === e.id);
  const p1 = portPos(a, "out"), p2 = portPos(t, "in"); const s = ctl.toScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2); const r = ctl.rect();
  const move = (dir: -1 | 1) => { const ids = ins.map((x) => x.edge.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; store.reorderInputs(t.id, ids); afterInputsChanged(store, t.id); };
  return (
    <div id="ebadge" className="ebadge" style={{ left: s.x - r.left, top: s.y - r.top - 44, transform: "translateX(-50%)" }} onPointerDown={(ev) => ev.stopPropagation()}>
      <span>「{title(a)}」→「{title(t)}」 输入 {i + 1}/{ins.length}</span>
      <button disabled={i === 0} onClick={() => move(-1)}>前移</button><button disabled={i === ins.length - 1} onClick={() => move(1)}>后移</button>
      <button onClick={() => { store.removeEdge(e.id); store.setUI({ edge: null }); afterInputsChanged(store, t.id); }}>删除</button>
    </div>
  );
}
