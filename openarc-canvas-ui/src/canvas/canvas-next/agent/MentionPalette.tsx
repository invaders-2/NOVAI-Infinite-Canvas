import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { Icon } from "../ui/Icon";
import { listAgentReferences, type AgentReference } from "./references";

type Choice = { id: string; group: string; title: string; detail: string; node?: CanvasNode; ref?: AgentReference };

export function MentionPalette({ nodes, onNode, onRef }: { nodes: CanvasNode[]; onNode: (node: CanvasNode) => void; onRef: (ref: AgentReference) => void }) {
  const [q, setQ] = useState(""); const [active, setActive] = useState(0);
  const [refs, setRefs] = useState<AgentReference[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { let live = true; void listAgentReferences().then((r) => { if (!live) return; setRefs([...r.apps, ...r.assets]); setError(r.errors.join("；")); setLoading(false); }); return () => { live = false; }; }, []);
  const choices = useMemo<Choice[]>(() => {
    const kw = q.trim().toLocaleLowerCase();
    const nodeChoices = nodes.map((node) => ({ id: "node:" + node.id, group: "画布节点", title: title(node), detail: node.kind, node }));
    return [...nodeChoices, ...refs.map((ref) => ({ id: ref.id, group: ref.group, title: ref.title, detail: ref.detail || ref.kind, ref }))].filter((item) => !kw || (item.title + item.detail + item.group).toLocaleLowerCase().includes(kw)).slice(0, 60);
  }, [nodes, refs, q]);
  useEffect(() => { setActive(0); }, [q]);
  const pick = (choice?: Choice) => { if (!choice) return; if (choice.node) onNode(choice.node); if (choice.ref) onRef(choice.ref); };
  let lastGroup = "";
  return <div className="mention-palette">
    <div className="pal-s"><Icon name="search" size="s" /><input autoFocus aria-label="搜索引用" placeholder="搜索应用、素材或画布节点" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const next = (active + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % Math.max(1, choices.length); setActive(next); listRef.current?.children[next]?.scrollIntoView({ block: "nearest" }); } if (e.key === "Enter") { e.preventDefault(); pick(choices[active]); } }} /></div>
    <div className="mention-results" ref={listRef}>{choices.map((choice, index) => {
      const head = choice.group !== lastGroup ? <div className="mh" key={"h" + choice.id}>{choice.group}</div> : null; lastGroup = choice.group;
      return <span key={choice.id}>{head}<button className={"mi" + (index === active ? " active" : "")} onMouseEnter={() => setActive(index)} onClick={() => pick(choice)}><span className="ic"><Icon name={choice.node ? "layers" : choice.ref?.kind === "app" ? "grid" : "folder"} size="s" /></span><span>{choice.title}<span className="d">{choice.detail}</span></span></button></span>;
    })}{loading ? <div className="row"><i className="spn" /><span>读取应用与素材…</span></div> : null}{!loading && !choices.length ? <div className="row"><span>没有匹配的引用</span></div> : null}</div>
    {error ? <div className="mention-error">{error}；仍可使用画布节点</div> : null}
  </div>;
}
