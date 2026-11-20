import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { Icon } from "../ui/Icon";
import { TYPE_ICON, type GenKind } from "../model";
import { displaySrc, isStack } from "../stack";
import { ThumbImg } from "../ui/thumb";
import { listAgentReferences, type AgentReference } from "./references";

type Choice = { id: string; group: string; title: string; detail: string; kindLabel: string; node?: CanvasNode; ref?: AgentReference; depth?: number; members?: number };

const KIND_LABEL: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "音频", table: "表格", group: "分组" };
const kindLabelOf = (node: CanvasNode) => (isStack(node) ? "堆叠" : KIND_LABEL[node.kind] || node.kind);
const kindIconOf = (node: CanvasNode) => (node.kind === "table" ? "grid" : TYPE_ICON[node.kind as GenKind] || "layers");

/** 画布节点的真实缩略图：图片 / 视频取 src；分组 / 堆叠取成员里第一张有图的；都取不到时按 kind 用线性图标兜底 */
function NodeThumb({ node, nodes }: { node: CanvasNode; nodes: CanvasNode[] }) {
  const src = displaySrc(nodes, node);
  const icon = <Icon name={kindIconOf(node)} size="s" />;
  if (!src) return <span className="ap2-mp-th is-icon">{icon}</span>;
  // 36px 的格子放缩略图就够：原图 3072×4096 解码一张 48MB，8 张就 450MB 位图，面板一开就卡
  return <span className={"ap2-mp-th" + (node.kind === "group" ? " is-group" : "")}><ThumbImg src={src} width={36} fallback={icon} />{node.kind === "group" ? <i className="ap2-mp-stackmark"><Icon name="layers" size="xs" /></i> : null}</span>;
}

/**
 * 输入 @ 时的引用面板：画布节点 + 应用 + 素材。
 * 分组 / 堆叠默认收起：它的成员不在一级列表里平铺，行尾有个「展开」按钮，点开才把成员缩进列在下面（可单独 @）；
 * 点行本身还是 @ 整个分组 / 堆叠。搜索时不分层，所有匹配的节点（含成员）平铺出来，免得搜不到收起的成员。
 */
export function MentionPalette({ nodes, onNode, onRef }: { nodes: CanvasNode[]; onNode: (node: CanvasNode) => void; onRef: (ref: AgentReference) => void }) {
  const [q, setQ] = useState(""); const [active, setActive] = useState(0);
  const [refs, setRefs] = useState<AgentReference[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  /** 展开着的分组 / 堆叠 id：默认全部收起 */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  // 应用（工具）和素材都要能 @：之前只取了 r.assets，应用一直不出现在面板里
  useEffect(() => { let live = true; void listAgentReferences().then((r) => { if (!live) return; setRefs([...r.apps, ...r.assets]); setError(r.errors.join("；")); setLoading(false); }); return () => { live = false; }; }, []);
  const choices = useMemo<Choice[]>(() => {
    const kw = q.trim().toLocaleLowerCase();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const membersOf = (g: CanvasNode) => (g.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n);
    const nodeChoice = (node: CanvasNode, depth = 0): Choice => {
      const members = node.kind === "group" ? membersOf(node).length : 0;
      return { id: "node:" + node.id, group: "画布节点", title: title(node), detail: node.kind, kindLabel: kindLabelOf(node) + (members ? " · " + members : ""), node, depth, members };
    };
    let nodeChoices: Choice[];
    if (kw) {
      nodeChoices = nodes.map((n) => nodeChoice(n));
    } else {
      // 不搜索：成员收进所属分组 / 堆叠下面，展开了才列出来（嵌套分组同理，逐层缩进）
      const inGroup = new Set<string>();
      for (const n of nodes) if (n.kind === "group") (n.children || []).forEach((id) => inGroup.add(id));
      nodeChoices = [];
      const walk = (n: CanvasNode, depth: number, seen: Set<string>) => {
        if (seen.has(n.id)) return; seen.add(n.id);
        nodeChoices.push(nodeChoice(n, depth));
        if (n.kind === "group" && open.has(n.id)) membersOf(n).forEach((m) => walk(m, depth + 1, seen));
      };
      const seen = new Set<string>();
      nodes.filter((n) => !inGroup.has(n.id)).forEach((n) => walk(n, 0, seen));
    }
    const refChoices = refs.map((ref) => ({ id: ref.id, group: ref.group, title: ref.title, detail: ref.detail || ref.kind, kindLabel: ref.kind === "app" ? "应用" : "素材", ref }));
    return [...nodeChoices, ...refChoices].filter((item) => !kw || (item.title + item.detail + item.group).toLocaleLowerCase().includes(kw)).slice(0, kw ? 60 : 120);
  }, [nodes, refs, q, open]);
  useEffect(() => { setActive(0); }, [q]);
  const pick = (choice?: Choice) => { if (!choice) return; if (choice.node) onNode(choice.node); if (choice.ref) onRef(choice.ref); };
  const toggle = (id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  let lastGroup = "";
  return <div className="mention-palette ap2-mention">
    <div className="pal-s"><Icon name="search" size="s" /><input autoFocus aria-label="搜索引用" placeholder="搜索画布节点、应用或素材" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const next = (active + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % Math.max(1, choices.length); setActive(next); listRef.current?.children[next]?.scrollIntoView({ block: "nearest" }); }
      // → 展开 / ← 收起当前高亮的分组 / 堆叠（输入框里有字时让给光标移动）
      const cur = choices[active];
      if (!q && cur?.node?.kind === "group" && cur.members && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const isOpen = open.has(cur.node.id);
        if ((e.key === "ArrowRight") !== isOpen) toggle(cur.node.id);
      }
      if (e.key === "Enter") { e.preventDefault(); pick(choices[active]); }
    }} /></div>
    <div className="mention-results ap2-mp-list" ref={listRef}>{choices.map((choice, index) => {
      const head = choice.group !== lastGroup ? <div className="mh" key={"h" + choice.id}>{choice.group}</div> : null; lastGroup = choice.group;
      const node = choice.node;
      const expandable = !q && !!node && node.kind === "group" && !!choice.members;
      const isOpen = !!node && open.has(node.id);
      return <span key={choice.id}>{head}<button className={"mi ap2-mp-item" + (index === active ? " active" : "") + (choice.depth ? " is-member" : "")} style={choice.depth ? { paddingLeft: 7 + choice.depth * 22 } : undefined}
        data-mp-node={node?.id} onMouseEnter={() => setActive(index)} onClick={() => pick(choice)}>
        {node ? <NodeThumb node={node} nodes={nodes} /> : <span className="ap2-mp-th is-icon"><Icon name={choice.ref?.kind === "app" ? "grid" : "folder"} size="s" /></span>}
        <span className="ap2-mp-copy">
          <span className="ap2-mp-name">{choice.title}</span>
          {choice.ref ? <span className="ap2-mp-desc">{choice.detail}</span> : null}
        </span>
        <span className="ap2-mp-kind">{choice.kindLabel}</span>
        {expandable ? <span role="button" tabIndex={-1} className={"ap2-mp-expand" + (isOpen ? " on" : "")} data-mp-expand={node!.id}
          aria-label={isOpen ? "收起成员" : "查看全部成员"} aria-expanded={isOpen} title={isOpen ? "收起" : "查看全部 " + choice.members + " 个成员"}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggle(node!.id); }}><Icon name="right" size="xs" /></span> : null}
      </button></span>;
    })}{loading ? <div className="row ap2-mp-state"><i className="spn" /><span>读取应用与素材…</span></div> : null}{!loading && !choices.length && !error ? <div className="row ap2-mp-state"><span>没有匹配的引用</span></div> : null}</div>
    {/* 读取失败要说出来（下次打开会自动重试），不能安静地只给一个空列表 */}
    {error ? <div className="mention-error">{error}；仍可使用画布节点</div> : null}
  </div>;
}
