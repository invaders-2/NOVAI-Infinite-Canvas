import { memo, useEffect, useRef, useState } from "react";
import { afterInputsChanged, title } from "../actions";
import { edgePathD, edgeSideOf, inPoint, outPoint } from "../edgeGeometry";
import { inputsOf } from "../model";
import { useCtl, useS } from "./ctx";
import { stackOwners } from "../stack";
import { usePerf } from "../perf";

/** 连线层：新连线画出动效；选中节点 / 连线时高亮并显示输入序号 */
export const Edges = memo(function Edges() {
  // 只订阅「哪些节点在生成」的签名：patchRun 每个 token 都会换掉 runtime 对象，订阅整个 runtime
  // 会让整个连线层（含每条边的 inputsOf 排序）每 token 重渲一次。生成开始/结束才需要重画。
  const doc = useS((s) => s.doc); const ui = useS((s) => s.ui);
  const running = useS((s) => Object.keys(s.runtime).join(","));
  // 视频「解析」中的分镜表：连进来的线走虚线流动（原型 v3），和生成中的扫光区分开
  const parsingIds = useS((s) => [...s.ui.parsing].join(","));
  const perf = usePerf();
  const seen = useRef<Set<string> | null>(null);
  const isNew = (id: string) => { if (!seen.current) return false; return !seen.current.has(id); };
  useEffect(() => { seen.current = new Set(doc.edges.map((e) => e.id)); });
  // 悬停节点：它的直接上下游连线提亮一档（TapNow）。只在连线层本地记，不写 store，悬停变化只重渲这一层
  const [hov, setHov] = useState<string | null>(null);
  useEffect(() => {
    const on = (ev: PointerEvent) => { const el = (ev.target as Element | null)?.closest?.(".cn-root #nodes .node") as HTMLElement | null; const id = el?.dataset.id || null; setHov((p) => (p === id ? p : id)); };
    document.addEventListener("pointerover", on); return () => document.removeEventListener("pointerover", on);
  }, []);
  const multi = ui.sel.size > 1;
  // 收在堆叠里的节点不单独显示：连到它们的线改连到堆叠上（TapNow），同一对端点只画一条
  const owner = stackOwners(doc.nodes);
  const live = new Set(running ? running.split(",") : []);
  const parsingSet = new Set(parsingIds ? parsingIds.split(",") : []);
  const byId = new Map(doc.nodes.filter((n) => !owner.has(n.id)).map((n) => [n.id, n]));
  const items: React.ReactElement[] = []; const pairs = new Set<string>();
  for (const e of doc.edges) {
    const a = byId.get(owner.get(e.from) || e.from), b = byId.get(owner.get(e.to) || e.to); if (!a || !b || a === b) continue;
    const viaStack = owner.has(e.from) || owner.has(e.to);
    if (viaStack) { const pk = a.id + ">" + b.id; if (pairs.has(pk)) continue; pairs.add(pk); }
    // 出线侧按当前几何重算：数据里的 fromSide 是排版当时的快照，节点拖走后会绕大圈
    const side = edgeSideOf(a, b);
    const p1 = outPoint(a, side), p2 = inPoint(b); const d = edgePathD(p1, p2, side);
    // 连线三档（TapNow）：平时 --edge → 悬停 / 单选节点的直接上下游 near → 多选（含框选拖动中）或选中连线 sel。线宽不变
    const touch = ui.sel.has(b.id) || ui.sel.has(a.id);
    const sel = ui.edge === e.id || (multi && touch);
    const near = !sel && (touch || (!ui.dragging && (hov === a.id || hov === b.id)));
    const draw = isNew(e.id);
    const flow = live.has(b.id) && !live.has(a.id);
    items.push(<path key={"h" + e.id} className="hit" data-edge={e.id} d={d} />);
    items.push(<path key={e.id} className={"e" + (sel ? " sel" : "") + (near ? " near" : "") + (draw ? " draw" : "") + (ui.hlEdge === e.id ? " hl" : "") + (flow ? " gen" : "") + (parsingSet.has(b.id) ? " flow" : "")} data-edge={e.id} d={d} {...(draw ? { pathLength: 1 } : {})} />);
    // 生成中：同 TapNow，沿连线方向（上游 → 正在生成的节点）扫过一段高光，2s 一轮。
    // 流畅优先模式下不做 SMIL 扫光（每轮要重算渐变 offset 并重绘整条路径），改用 .gen 的静态高亮：
    // 线宽/颜色与扫光底色一致，仍然看得出「这条线在给生成中的节点供料」。
    if (flow && perf.mode === "high") {
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
          <path data-edge={e.id} d={d} stroke={`url(#${gid})`} />
        </g>,
      );
    }
    if (viaStack) continue;
    const ins = inputsOf(doc, b.id); const ord = ins.findIndex((x) => x.edge.id === e.id);
    if (ins.length > 1 || sel || touch) items.push(<g key={"b" + e.id} className={"badge" + (ui.edge === e.id || ui.sel.has(b.id) ? " sel" : "")} data-edge-badge={e.id} transform={`translate(${p2.x - 14},${p2.y})`}><circle r="8" /><text>{ord + 1}</text></g>);
  }
  if (ui.conn) {
    const c = ui.conn;
    // 多选加号：每个源节点的出口各拉一条预览线汇到指针（TapNow），一眼看出这几个都会接进去
    if (!c.rev && c.sources?.length) c.sources.forEach((sid) => { const s = byId.get(owner.get(sid) || sid); if (!s) return; const side = c.p.x >= s.x + s.w / 2 ? "right" : "left"; items.push(<path key={"tmp" + sid} className="tmp" d={edgePathD(outPoint(s, side), c.p, side)} />); });
    else { const from = c.rev ? c.p : c.a, to = c.rev ? c.a : c.p; items.push(<path key="tmp" className="tmp" d={edgePathD(from, to, to.x >= from.x ? "right" : "left")} />); }
  }
  return <svg id="edges" className={ui.hideEdges ? "hidden" : ""}>{items}</svg>;
});

/** 选中连线时的浮标：前移 / 后移 / 删除 */
export function EdgeBadge() {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const edgeId = useS((s) => s.ui.edge); useS((s) => s.view);
  const e = doc.edges.find((x) => x.id === edgeId); if (!e) return null;
  const a = store.node(e.from), t = store.node(e.to); if (!a || !t) return null;
  const ins = inputsOf(doc, t.id); const i = ins.findIndex((x) => x.edge.id === e.id);
  const p1 = outPoint(a, edgeSideOf(a, t)), p2 = inPoint(t); const s = ctl.toScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2); const r = ctl.rect();
  const move = (dir: -1 | 1) => { const ids = ins.map((x) => x.edge.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; store.reorderInputs(t.id, ids); afterInputsChanged(store, t.id); };
  return (
    <div id="ebadge" className="ebadge" style={{ left: s.x - r.left, top: s.y - r.top - 44, transform: "translateX(-50%)" }} onPointerDown={(ev) => ev.stopPropagation()}>
      <span>「{title(a)}」→「{title(t)}」 输入 {i + 1}/{ins.length}</span>
      <button disabled={i === 0} onClick={() => move(-1)}>前移</button><button disabled={i === ins.length - 1} onClick={() => move(1)}>后移</button>
      <button onClick={() => { store.removeEdge(e.id); store.setUI({ edge: null }); afterInputsChanged(store, t.id); }}>删除</button>
    </div>
  );
}
