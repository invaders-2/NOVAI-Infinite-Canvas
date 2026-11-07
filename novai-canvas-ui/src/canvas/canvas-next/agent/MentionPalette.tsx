import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { Icon } from "../ui/Icon";
import { isGenKind, srcOf, TYPE_ICON, type GenKind } from "../model";
import { ThumbImg } from "../ui/thumb";
import { listAgentReferences, type AgentReference } from "./references";

type Choice = { id: string; group: string; title: string; detail: string; kindLabel: string; node?: CanvasNode; ref?: AgentReference };

const KIND_LABEL: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "音频", table: "表格", group: "分组" };
const kindLabelOf = (node: CanvasNode) => KIND_LABEL[node.kind] || node.kind;
const kindIconOf = (node: CanvasNode) => (node.kind === "table" ? "grid" : TYPE_ICON[node.kind as GenKind] || "layers");

/** 画布节点的真实缩略图（图片/视频取 src，取不到时按 kind 用线性图标兜底） */
function NodeThumb({ node }: { node: CanvasNode }) {
  const src = isGenKind(node.kind) ? srcOf(node) : "";
  if (!src) return <span className="ap2-mp-th is-icon"><Icon name={kindIconOf(node)} size="s" /></span>;
  // 36px 的格子放缩略图就够：原图 3072×4096 解码一张 48MB，8 张就 450MB 位图，面板一开就卡
  return <span className="ap2-mp-th"><ThumbImg src={src} width={36} fallback={<Icon name={kindIconOf(node)} size="s" />} /></span>;
}

export function MentionPalette({ nodes, onNode, onRef }: { nodes: CanvasNode[]; onNode: (node: CanvasNode) => void; onRef: (ref: AgentReference) => void }) {
  const [q, setQ] = useState(""); const [active, setActive] = useState(0);
  const [refs, setRefs] = useState<AgentReference[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // 应用（工具）和素材都要能 @：之前只取了 r.assets，应用一直不出现在面板里
  useEffect(() => { let live = true; void listAgentReferences().then((r) => { if (!live) return; setRefs([...r.apps, ...r.assets]); setError(r.errors.join("；")); setLoading(false); }); return () => { live = false; }; }, []);
  const choices = useMemo<Choice[]>(() => {
    const kw = q.trim().toLocaleLowerCase();
    const nodeChoices = nodes.map((node) => ({ id: "node:" + node.id, group: "画布节点", title: title(node), detail: node.kind, kindLabel: kindLabelOf(node), node }));
    return [...nodeChoices, ...refs.map((ref) => ({ id: ref.id, group: ref.group, title: ref.title, detail: ref.detail || ref.kind, kindLabel: ref.kind === "app" ? "应用" : "素材", ref }))].filter((item) => !kw || (item.title + item.detail + item.group).toLocaleLowerCase().includes(kw)).slice(0, 60);
  }, [nodes, refs, q]);
  useEffect(() => { setActive(0); }, [q]);
  const pick = (choice?: Choice) => { if (!choice) return; if (choice.node) onNode(choice.node); if (choice.ref) onRef(choice.ref); };
  let lastGroup = "";
  return <div className="mention-palette ap2-mention">
    <div className="pal-s"><Icon name="search" size="s" /><input autoFocus aria-label="搜索引用" placeholder="搜索画布节点、应用或素材" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const next = (active + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % Math.max(1, choices.length); setActive(next); listRef.current?.children[next]?.scrollIntoView({ block: "nearest" }); } if (e.key === "Enter") { e.preventDefault(); pick(choices[active]); } }} /></div>
    <div className="mention-results ap2-mp-list" ref={listRef}>{choices.map((choice, index) => {
      const head = choice.group !== lastGroup ? <div className="mh" key={"h" + choice.id}>{choice.group}</div> : null; lastGroup = choice.group;
      return <span key={choice.id}>{head}<button className={"mi ap2-mp-item" + (index === active ? " active" : "")} onMouseEnter={() => setActive(index)} onClick={() => pick(choice)}>
        {choice.node ? <NodeThumb node={choice.node} /> : <span className="ap2-mp-th is-icon"><Icon name={choice.ref?.kind === "app" ? "grid" : "folder"} size="s" /></span>}
        <span className="ap2-mp-copy">
          <span className="ap2-mp-name">{choice.title}</span>
          {choice.ref ? <span className="ap2-mp-desc">{choice.detail}</span> : null}
        </span>
        <span className="ap2-mp-kind">{choice.kindLabel}</span>
      </button></span>;
    })}{loading ? <div className="row ap2-mp-state"><i className="spn" /><span>读取应用与素材…</span></div> : null}{!loading && !choices.length && !error ? <div className="row ap2-mp-state"><span>没有匹配的引用</span></div> : null}</div>
    {/* 读取失败要说出来（下次打开会自动重试），不能安静地只给一个空列表 */}
    {error ? <div className="mention-error">{error}；仍可使用画布节点</div> : null}
  </div>;
}
