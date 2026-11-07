import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import "./template-panel.css";

/* ---------- 首页模板（web/src/pages/home/templates.js）的读取与适配 ---------- */
/** 首页模板节点定义：type = label / text / image / group / gen / table / batch */
export type HomeNode = {
  key?: string; type: string; title?: string; text?: string; brief?: boolean; ref?: boolean;
  ratio?: string; prompt?: string; inputs?: string[]; col?: number; video?: boolean; color?: string;
};
export type HomeTemplate = {
  id: string; title: string; cat?: string; media?: string; video?: string; desc?: string; agent?: string; nodes: HomeNode[];
};
/** 与 Chrome 的 TplEntry 结构兼容；home 字段承载首页模板原始定义 */
export type HomeEntry = {
  id: string; name: string; summary: string; tags: string[]; chips: string[]; category: string;
  steps: Array<{ title: string; detail: string }>; nodes: number; edges: number; publishedAt: number; home: HomeTemplate;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
function toHomeTemplate(raw: unknown): HomeTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const id = str(t.id); const title = str(t.title);
  if (!id || !title) return null;
  const nodes = Array.isArray(t.nodes) ? t.nodes.filter((n): n is HomeNode => !!n && typeof n === "object" && typeof (n as HomeNode).type === "string") : [];
  if (!nodes.length) return null;
  return {
    id, title, nodes,
    cat: str(t.cat) || undefined, media: str(t.media) || undefined, video: str(t.video) || undefined,
    desc: str(t.desc) || undefined, agent: str(t.agent) || undefined,
  };
}
function nodeCount(nodes: HomeNode[]) { return nodes.length; }
function entryOf(t: HomeTemplate): HomeEntry {
  const cat = t.cat || "";
  const links = t.nodes.reduce((n, x) => n + (Array.isArray(x.inputs) ? x.inputs.length : 0), 0);
  return {
    id: t.id, name: t.title, summary: t.desc || "", tags: cat ? [cat] : [], chips: cat ? [cat] : [],
    category: cat, steps: [], nodes: nodeCount(t.nodes), edges: links, publishedAt: 0, home: t,
  };
}

/**
 * 首页模板是同源 ESM（web/src/pages/home/templates.js），但不带类型声明；
 * 动态 import + try/catch：那边文件被改坏 / 暂时为空时，公共模板退回空列表，画布不白屏。
 */
export async function loadHomeEntries(): Promise<{ entries: HomeEntry[]; cats: Record<string, string>; error: string }> {
  try {
    // @ts-ignore 首页模板是 JS 数据模块（同源、无 .d.ts）
    const mod = (await import("../../../../../web/src/pages/home/templates.js")) as { TEMPLATES?: unknown; CATS?: unknown };
    const list = Array.isArray(mod.TEMPLATES) ? mod.TEMPLATES : [];
    const templates = list.flatMap((x) => { const t = toHomeTemplate(x); return t ? [t] : []; });
    if (!templates.length) console.warn("[template] 首页模板数据为空，公共模板暂用空列表");
    const cats: Record<string, string> = {};
    for (const c of Array.isArray(mod.CATS) ? mod.CATS : []) { const name = str(c); if (name && name !== "全部") cats[name] = name; }
    return { entries: templates.map(entryOf), cats, error: "" };
  } catch (err) {
    console.warn("[template] 读取首页模板失败，公共模板暂用空列表", err);
    return { entries: [], cats: {}, error: "" };
  }
}

/* ---------- 模板 → 画布 doc（应用模板用） ---------- */
export type PreviewDocNode = {
  id: string; kind: "text" | "image" | "video" | "audio" | "table";
  x: number; y: number; w: number; h: number; title: string; text: string; prompt: string;
  params?: { output?: "text" | "table" | "storyboard"; ratio?: string; count?: number; dur?: number; mode?: string };
  table?: { title?: string; columns?: string[]; rows?: string[][] } | null;
  /** doc 里节点上带的结果图（我的模板封面/预览） */
  cover?: string;
};
const CANVAS_RATIO: Record<string, string> = { square: "1:1", portrait43: "3:4", "3:4": "3:4", "4:3": "4:3", wide: "16:9", "16:9": "16:9", "9:16": "9:16", ultrawide: "16:9" };
export function homeToDoc(home: HomeTemplate): { nodes: PreviewDocNode[]; edges: Array<{ id: string; from: string; to: string }> } {
  const g = homeGraph(home);
  const idOf = new Map<string, string>(); const used = new Set<string>();
  const keyOf = (n: GNode) => n.key || "n" + n.idx;
  const nodes: PreviewDocNode[] = [];
  for (const n of g.nodes) {
    if (n.type === "label") continue;
    const raw = n.node as HomeNode;
    let id = keyOf(n); let suffix = 2;
    while (used.has(id)) id = keyOf(n) + "-" + suffix++;
    used.add(id); idOf.set(keyOf(n), id);
    const kind: PreviewDocNode["kind"] = raw.type === "gen" ? (raw.video ? "video" : "image")
      : raw.type === "text" ? "text" : raw.type === "table" ? "table" : "image";
    nodes.push({
      id, kind, x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h),
      title: raw.title || (kind === "text" ? "说明" : kind === "table" ? "需求表" : kind === "video" ? "视频" : "素材"),
      text: kind === "text" ? (raw.text || (raw.brief ? "在这里写你的需求：卖点、风格、使用场景" : "")) : "",
      prompt: raw.type === "gen" ? (raw.prompt || "") : "",
      params: kind === "image" || kind === "video" ? { ratio: CANVAS_RATIO[raw.ratio || ""] || "自适应", ...(kind === "video" ? { mode: "文生视频" } : {}) } : undefined,
      table: kind === "table" ? { title: raw.title || "需求表", columns: ["需求"], rows: [[""]] } : null,
    });
  }
  const edges = g.edges.flatMap((e) => {
    if (e.from.type === "label" || e.to.type === "label") return [];
    const from = idOf.get(keyOf(e.from)); const to = idOf.get(keyOf(e.to));
    return from && to ? [{ id: from + ">" + to, from, to }] : [];
  });
  return { nodes, edges };
}

/* ---------- 只读画布图（首页定义 / 画布 doc 共用） ---------- */
type GNode = {
  id: string; idx: number; key?: string; type: string; title: string; node: HomeNode | PreviewDocNode;
  x: number; y: number; w: number; h: number; prompt?: string; text?: string; ratio?: string; video?: boolean; example?: boolean; cover?: string;
};
type GEdge = { from: GNode; to: GNode };
const RATIO_SIZE: Record<string, [number, number]> = {
  square: [260, 260], portrait43: [240, 320], "3:4": [240, 320], "4:3": [300, 225],
  wide: [320, 180], "16:9": [320, 180], "9:16": [200, 356], ultrawide: [320, 140],
};
const KIND_LABEL: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频", table: "表格" };
const RATIO_LABEL: Record<string, string> = { square: "1:1", portrait43: "3:4", wide: "16:9", ultrawide: "16:9", "16:9": "16:9", "9:16": "9:16", "3:4": "3:4", "4:3": "4:3" };
const ratioLabel = (r?: string) => (r ? RATIO_LABEL[r] || r : "自动比例");
function homeSize(n: HomeNode): [number, number] {
  if (n.type === "label") return [160, 34];
  if (n.type === "image") return [220, 180];
  if (n.type === "group") return [240, 190];
  if (n.type === "text") return [240, (n.text || "").length > 120 ? 220 : 150];
  if (n.type === "table") return [300, 190];
  if (n.type === "batch") return [260, 170];
  if (n.type !== "gen") return [260, 260];
  return RATIO_SIZE[n.ratio || ""] || [260, 260];
}
function homeTitle(n: HomeNode): string {
  if (n.type === "text") return n.brief ? "你的需求" : (n.title || "说明");
  if (n.type === "image") return n.title || (n.ref ? "参考图" : "素材");
  if (n.type === "group") return n.title || "素材组";
  if (n.type === "table") return n.title || "多维表格";
  if (n.type === "batch") return n.title || "批量生成";
  return n.title || (n.video ? "视频" : "图片");
}
const COL_W = 360, GAP = 54, PAD = 40;
function homeGraph(home: HomeTemplate): { nodes: GNode[]; edges: GEdge[]; width: number; height: number } {
  const nodes: GNode[] = []; const cols: Record<number, GNode[]> = {}; let example = false;
  home.nodes.forEach((raw, i) => {
    const [w, h] = homeSize(raw); const col = Number(raw.col) || 0;
    const n: GNode = {
      id: "h" + i, idx: i, key: raw.key, type: raw.type, title: homeTitle(raw), node: raw,
      x: 0, y: 0, w, h, prompt: raw.prompt, text: raw.text, ratio: raw.ratio, video: raw.video === true,
    };
    if (raw.type === "gen" && !example) { n.example = true; example = true; }
    (cols[col] = cols[col] || []).push(n); nodes.push(n);
  });
  const heights = Object.keys(cols).map((c) => cols[+c].reduce((s, n) => s + n.h + GAP + 22, -GAP));
  const maxH = Math.max(...heights, 0);
  Object.keys(cols).forEach((c) => {
    const list = cols[+c];
    let y = (maxH - list.reduce((s, n) => s + n.h + GAP + 22, -GAP)) / 2;
    list.forEach((n) => { n.x = (+c) * COL_W + (+c > 0 ? 40 : 0); n.y = y + 22; y += n.h + GAP + 22; });
  });
  const byKey = new Map<string, GNode>(); nodes.forEach((n) => { if (n.key) byKey.set(n.key, n); });
  const edges: GEdge[] = [];
  nodes.forEach((n) => ((n.node as HomeNode).inputs || []).forEach((k) => {
    const from = byKey.get(k); if (from) edges.push({ from, to: n });
  }));
  const width = Math.max(...nodes.map((n) => n.x + n.w), 0) + PAD * 2;
  const height = Math.max(...nodes.map((n) => n.y + n.h), 0) + PAD * 2;
  return { nodes, edges, width, height };
}
function docGraph(doc: { nodes: PreviewDocNode[]; edges: Array<{ id: string; from: string; to: string }> } | null | undefined): { nodes: GNode[]; edges: GEdge[]; width: number; height: number } {
  const nodes: GNode[] = [];
  (doc?.nodes || []).forEach((raw, i) => {
    if (!raw || !raw.id || !raw.kind) return;
    nodes.push({
      id: raw.id, idx: i, key: raw.id, type: raw.kind, title: raw.title || KIND_LABEL[raw.kind] || "节点", node: raw,
      x: raw.x, y: raw.y, w: raw.w, h: raw.h, prompt: raw.prompt, text: raw.text, cover: raw.cover,
      video: raw.kind === "video", ratio: raw.params?.ratio,
    });
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: GEdge[] = (doc?.edges || []).flatMap((e) => {
    const from = byId.get(e.from); const to = byId.get(e.to);
    return from && to ? [{ from, to }] : [];
  });
  if (!nodes.length) return { nodes, edges, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x)); const minY = Math.min(...nodes.map((n) => n.y));
  nodes.forEach((n) => { n.x = n.x - minX + PAD; n.y = n.y - minY + PAD; });
  const width = Math.max(...nodes.map((n) => n.x + n.w), 0) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + n.h), 0) + PAD;
  return { nodes, edges, width, height };
}

/* ---------- 组件 ---------- */
export type TemplatePreviewProps = {
  entry: { id: string; name: string; personal?: boolean; home?: HomeTemplate; doc?: { nodes: PreviewDocNode[]; edges: Array<{ id: string; from: string; to: string }> } | null };
  onClose: () => void;
  onApply?: () => void;
  /** 仅个人模板传入：确认删除并返回错误文案（空串=成功）；确认弹层在预览组件内 */
  onDeleteConfirm?: () => Promise<string>;
  onAgent?: () => void;
  agentDisabled?: boolean;
  busy?: boolean;
  /** 右上操作区（分享只读预览用）：给了就不再渲染默认的「交给画布助手 / 删除 / 应用」 */
  actions?: ReactNode;
  /** 头部右侧的说明文案，默认是模板预览那句 */
  note?: string;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ICONS: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  text: "text", image: "image", video: "video", audio: "audio", table: "grid", group: "layers", batch: "frame", gen: "image",
};

export function TemplatePreview({ entry, onClose, onApply, onDeleteConfirm, onAgent, agentDisabled, busy, actions, note }: TemplatePreviewProps) {
  const graph = useMemo(() => (entry.home ? homeGraph(entry.home) : docGraph(entry.doc)), [entry]);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [tip, setTip] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const selNode = graph.nodes.find((n) => n.id === sel) || null;

  const fit = useCallback(() => {
    const el = stageRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    if (!graph.width || !graph.height || !r.width || !r.height) return;
    const k = clamp(Math.min((r.width - 72) / graph.width, (r.height - 88) / graph.height), .2, 1.2);
    setView({ k, x: (r.width - graph.width * k) / 2, y: (r.height - graph.height * k) / 2 });
  }, [graph]);

  useEffect(() => { setSel(null); const t = requestAnimationFrame(fit); return () => cancelAnimationFrame(t); }, [fit]);
  useEffect(() => { const t = setTimeout(() => setTip(false), 3600); return () => clearTimeout(t); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); onClose(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const zoomTo = (pct: number) => {
    const el = stageRef.current; const r = el?.getBoundingClientRect(); const k = clamp(pct / 100, .25, 2);
    if (!r) { setView((v) => ({ ...v, k })); return; }
    setView((v) => ({ k, x: r.width / 2 - ((r.width / 2 - v.x) / v.k) * k, y: r.height / 2 - ((r.height / 2 - v.y) / v.k) * k }));
  };
  const pct = Math.round(view.k * 100);
  const panelStyle = (() => {
    if (!selNode) return null;
    const r = stageRef.current?.getBoundingClientRect(); if (!r) return null;
    const w = Math.min(520, r.width - 32);
    let left = view.x + (selNode.x + selNode.w / 2) * view.k - w / 2;
    left = clamp(left, 16, r.width - w - 16);
    const top = clamp(view.y + (selNode.y + selNode.h) * view.k + 14, 80, r.height - 168);
    return { left: left + "px", top: top + "px", width: w + "px" };
  })();
  const selected = selNode && selNode.type !== "label" ? selNode : null;
  const upstream = selected ? graph.edges.filter((e) => e.to.id === selected.id).map((e) => e.from) : [];
  const isGen = (n: GNode) => (entry.home ? n.type === "gen" : n.type === "image" || n.type === "video" || n.type === "audio");

  return <>
    <div className="tplpv-scrim" onClick={onClose} />
    <div className="tplpv" role="dialog" aria-modal="true" aria-label={entry.name + " 模板预览"}>
      <div className="tplpv-h">
        <h3>{entry.name}</h3>
        {entry.home?.cat ? <span className="tplpv-chip">{entry.home.cat}</span> : null}
        <span className="tplpv-sp" />
        <span className="tplpv-note">{note || "只读预览 · 拖动空白平移 · 滚轮缩放 · 点节点看详情"}</span>
        {actions ? actions : <>
          <button type="button" className="tplpv-btn" data-tplpv-agent disabled={busy || agentDisabled || !onAgent} title={agentDisabled ? "这轮先不接画布助手入口：先「应用」到画布，再用右侧助手继续" : "把模板交给画布助手"} onClick={onAgent}><Icon name="sparkle" size="s" />交给画布助手</button>
          {entry.personal && onDeleteConfirm ? <button type="button" className="tplpv-btn danger" data-tplpv-delete disabled={busy || confirmBusy} onClick={() => { setConfirmErr(""); setConfirming(true); }}><Icon name="trash" size="s" />删除</button> : null}
          {onApply ? <button type="button" className="tplpv-btn pri" data-tplpv-apply disabled={busy} onClick={onApply}><Icon name="check" size="s" />应用</button> : null}
        </>}
        <button type="button" className="tplpv-x" aria-label="关闭预览" data-tplpv-close onClick={onClose}><Icon name="x" size="s" /></button>
      </div>
      <div className="tplpv-c" ref={stageRef} data-tplpv-stage
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as Element).closest(".tplpv-nd,.tplpv-panel,.tplpv-zoom")) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); }}
        onPointerUp={(e) => { drag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 指针已释放 */ } }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={(e) => {
          const r = stageRef.current?.getBoundingClientRect(); if (!r) return;
          const k = clamp(view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), .25, 2);
          const px = e.clientX - r.left; const py = e.clientY - r.top;
          setView((v) => ({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }));
        }}
        onClick={() => setSel(null)}
      >
        <div className="tplpv-world" style={{ transform: "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")" }}>
          <svg className="tplpv-edges" width="1" height="1">
            {graph.edges.map((e, i) => {
              const x1 = e.from.x + e.from.w, y1 = e.from.y + e.from.h / 2, x2 = e.to.x, y2 = e.to.y + e.to.h / 2;
              const dx = Math.max(30, Math.abs(x2 - x1) / 2);
              return <path key={i} className={"tplpv-e" + (sel && (e.from.id === sel || e.to.id === sel) ? " on" : "")} d={"M" + x1 + " " + y1 + "C" + (x1 + dx) + " " + y1 + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2} />;
            })}
          </svg>
          {graph.nodes.map((n) => {
            const raw = n.node as HomeNode;
            const kind = entry.home ? n.type : n.type;
            const video = entry.home ? (n.example && !!entry.home.video) : false;
            return <div key={n.id} className={"tplpv-nd t-" + kind + (n.type === "label" ? "" : "") + (sel === n.id ? " on" : "")}
              data-tplpv-node={n.id} data-tplpv-kind={kind} style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setSel((cur) => (cur === n.id ? null : n.id)); }}
            >
              {n.type === "label" ? <span className="tplpv-lbl">{raw.text || n.title}</span> : <>
                <div className="tplpv-al">
                  <Icon name={ICONS[entry.home ? n.type : n.type] || (n.type === "gen" ? "image" : "image")} size="xs" />
                  <span>[{n.idx + 1}] {n.title}</span>
                  {n.example ? <span className="ex">示例效果</span> : null}
                </div>
                {entry.home && n.type === "gen" ? (n.example && entry.home.media ? <div className="tplpv-im">
                  {video ? <video src={entry.home.video} poster={entry.home.media} muted loop autoPlay playsInline /> : <img src={entry.home.media} alt="" draggable={false} />}
                </div> : <div className="tplpv-draft"><Icon name={raw.video ? "video" : "image"} size="s" /><p>{n.prompt}</p><span>{ratioLabel(n.ratio)}</span></div>)
                  : n.type === "text" ? <div className="tplpv-txt">{raw.brief ? "在首页输入框里写的需求会放在这里，例如卖点、风格、使用场景。" : n.text}</div>
                    : n.cover && (n.type === "image" || n.type === "video") ? <div className="tplpv-im"><img src={n.cover} alt="" draggable={false} /></div>
                  : n.type === "image" || n.type === "group" ? <div className="tplpv-drop"><Icon name={n.type === "group" ? "layers" : "upload"} size="s" /><span>{n.type === "group" ? "把多张图片一起拖进来" : raw.ref ? "首页上传的参考图会放在这里" : "把图片拖进来"}</span></div>
                      : n.type === "table" ? <div className="tplpv-tbl">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>
                        : n.type === "batch" ? <div className="tplpv-drop"><Icon name="layers" size="s" /><span>表格每一行生成一张</span></div>
                          : entry.home ? <div className="tplpv-drop"><Icon name="video" size="s" /><span>视频提示词</span></div>
                            : <div className="tplpv-txt">{(n.node as PreviewDocNode).text || n.prompt || ""}</div>}
                <span className="tplpv-port l"><Icon name="plus" size="xs" /></span>
                <span className="tplpv-port r"><Icon name="plus" size="xs" /></span>
              </>}
            </div>;
          })}
        </div>
        {tip ? <div className="tplpv-tip">拖动空白处平移 · 滚轮缩放 · 点节点看详情</div> : null}
        {selected && panelStyle ? <div className="tplpv-panel" data-tplpv-panel style={panelStyle} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <div className="tplpv-refs">
            {upstream.length ? upstream.map((u) => <span key={u.id} className="tplpv-ref"><Icon name={ICONS[entry.home ? u.type : u.type] || "image"} size="xs" />{u.title}</span>) : <span className="tplpv-ref muted">没有上游输入</span>}
          </div>
          <p className="tplpv-prompt">{isGen(selected) ? (selected.prompt || "（运行时按上游输入生成）") : (selected.text || selected.prompt || "（无提示词）")}</p>
          <div className="tplpv-bar">
            <Icon name={selected.video ? "video" : "image"} size="s" />
            <b>{isGen(selected) ? (selected.video ? "视频" : "图片") : selected.title}</b>
            <span>·</span>
            <span>{ratioLabel(selected.ratio)}</span>
          </div>
        </div> : null}
        <div className="tplpv-zoom" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" title="适应画布" aria-label="适应画布" onClick={fit}><Icon name="fit" size="s" /></button>
          <button type="button" title="缩小" aria-label="缩小" onClick={() => zoomTo(pct - 10)}><Icon name="minus" size="s" /></button>
          <input type="range" min={25} max={200} value={clamp(pct, 25, 200)} aria-label="缩放" onChange={(e) => zoomTo(+e.target.value)} />
          <button type="button" title="放大" aria-label="放大" onClick={() => zoomTo(pct + 10)}><Icon name="plus" size="s" /></button>
          <button type="button" title="重置为 100%" onClick={() => zoomTo(100)}>{pct}%</button>
        </div>
      </div>
      {confirming ? <div className="tplpv-confirm" data-tplpv-confirm onPointerDown={(e) => e.stopPropagation()}>
        <div className="folder-dialog" data-tpl-delete-dialog>
          <div className="fd-head"><b>删除模板</b><button type="button" className="ib" aria-label="关闭" onClick={() => setConfirming(false)}><Icon name="x" size="s" /></button></div>
          <p>删除模板「{entry.name}」？删除后不可恢复。</p>
          {confirmErr ? <div className="fd-err" role="alert">{confirmErr}</div> : null}
          <div className="fd-foot"><button type="button" className="btn" onClick={() => setConfirming(false)}>取消</button><button type="button" className="btn solid" data-tpl-delete-ok disabled={confirmBusy} onClick={() => { void (async () => { setConfirmBusy(true); const msg = onDeleteConfirm ? await onDeleteConfirm() : ""; setConfirmBusy(false); if (msg) setConfirmErr(msg); else setConfirming(false); })(); }}>{confirmBusy ? "删除中…" : "删除"}</button></div>
        </div>
      </div> : null}
    </div>
  </>;
}
