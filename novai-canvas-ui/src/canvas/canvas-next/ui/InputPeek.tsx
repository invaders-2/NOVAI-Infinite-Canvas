/* 节点编辑器输入区的缩略图：分组 / 堆叠也有封面；鼠标移上去，在上方浮出这一项的完整预览——
   单个节点给大一点的图 / 文字摘要，分组和堆叠把里面所有成员（图片、视频、文本……）平铺出来。 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { genOf, isGenKind, outOf, srcOf, textOf, TYPE_ICON, TYPE_LABEL, type GenKind } from "../model";
import { displaySrc, isStack } from "../stack";
import { Icon, type IconName } from "./Icon";
import { ThumbImg } from "./thumb";
import { useAssetUrl } from "./useAsset";

const PEEK_MAX = 60;

const iconOf = (n: CanvasNode): IconName => (n.kind === "table" ? "grid" : n.kind === "group" ? "layers" : (TYPE_ICON[n.kind as GenKind] || "layers") as IconName);

/** 节点的文字摘要：文本节点的结果 → 提示词 → 节点自带文字 */
function snippetOf(n: CanvasNode): string {
  let text = "";
  try { text = textOf(n) || (isGenKind(n.kind) ? String(genOf(n).prompt || "") : "") || String(n.text || ""); } catch { text = String(n.text || ""); }
  // 预览只要读得懂的文字：去掉 Markdown 记号（# 标题、**加粗**、`代码`、> 引用、列表符、链接括号）
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\s+/g, " ").trim();
}

/** 分组 / 堆叠里的成员：嵌套的分组展开成员，按顺序平铺，去重，最多 PEEK_MAX 个 */
function membersOf(nodes: CanvasNode[], group: CanvasNode): CanvasNode[] {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const out: CanvasNode[] = []; const seen = new Set<string>();
  const walk = (g: CanvasNode, depth: number) => {
    for (const id of g.children || []) {
      if (out.length >= PEEK_MAX || seen.has(id)) continue;
      const child = byId.get(id); if (!child) continue;
      seen.add(id);
      if (child.kind === "group" && depth < 4) walk(child, depth + 1);
      else out.push(child);
    }
  };
  walk(group, 0);
  return out;
}

/** 视频缩略图兜底：后端抽不了帧（外链视频）时，用 <video> 只加载元数据，停在第 1 秒那帧当封面 */
export function VideoFrame({ src, className }: { src: string; className?: string }) {
  const url = useAssetUrl(src);
  if (!url) return null;
  return <video className={className || "chip-vthumb"} src={url + (url.includes("#") ? "" : "#t=1")} muted playsInline preload="metadata" />;
}

/** 悬停时的视频：静音循环播放，能播之前透明（下面垫着封面图），novai-asset 引用先换成可播放地址 */
function PeekVideo({ src }: { src: string }) {
  const url = useAssetUrl(src);
  if (!url) return null;
  return <video className="ipk-video" src={url} muted loop autoPlay playsInline preload="metadata" onLoadedData={(e) => e.currentTarget.classList.add("on")} />;
}

const groupKind = (n: CanvasNode) => (isStack(n) ? "堆叠" : "分组");

/** 输入缩略图本身：分组 / 堆叠用第一张有图的成员当封面，右下角带图层标 */
export function InputChipFace({ node, nodes, size = 28 }: { node: CanvasNode; nodes: CanvasNode[]; size?: number }) {
  const src = node.kind === "group" ? displaySrc(nodes, node) : srcOf(node);
  const icon = <Icon name={iconOf(node)} size="s" />;
  const vurl = node.kind === "video" ? String(outOf(node)?.url || "") : "";
  const fallback = vurl ? <VideoFrame src={vurl} /> : icon;
  return <>
    {src ? <ThumbImg src={src} width={size} fallback={fallback} /> : fallback}
    {node.kind === "group" ? <span className="chip-stackmark" aria-hidden="true"><Icon name="layers" size="xs" /></span> : null}
    {node.kind === "video" ? <span className="chip-vplay" aria-hidden="true"><Icon name="play" size="xs" /></span> : null}
  </>;
}

function PeekTile({ n }: { n: CanvasNode }) {
  const src = srcOf(n);
  const vurl = n.kind === "video" ? String(outOf(n)?.url || "") : "";
  if (src) return <div className="ipk-tile" title={title(n)}>
    <ThumbImg src={src} width={120} fallback={vurl ? <VideoFrame src={vurl} /> : <Icon name={iconOf(n)} size="s" />} />
    {n.kind === "video" ? <span className="ipk-play"><Icon name="play" size="xs" /></span> : null}
  </div>;
  const text = snippetOf(n);
  return <div className="ipk-tile txt" title={title(n)}>
    <span className="ipk-tile-hd"><Icon name={iconOf(n)} size="xs" />{TYPE_LABEL[n.kind as GenKind] || (n.kind === "table" ? "表格" : "节点")}</span>
    <span className="ipk-tile-tx">{text || title(n)}</span>
  </div>;
}

/** 浮在缩略图上方的预览卡（portal 到 .cn-root 下，免得被面板 overflow 裁掉，主题变量也还在） */
export function InputPeek({ node, nodes, anchor }: { node: CanvasNode; nodes: CanvasNode[]; anchor: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  /* 预览默认在缩略图上方：上方空间不够就把图 / 网格的高度收小去适应（--ipk-room），实在太挤（不到 140px）才翻到下方。
     图片是异步加载的，加载完卡片会变高，所以用 ResizeObserver 跟着重新摆 */
  const room = Math.max(0, (anchor.isConnected ? anchor.getBoundingClientRect().top : 0) - 8 - 8);
  const flip = room < 140;
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !anchor.isConnected) return;
    const place = () => {
      const a = anchor.getBoundingClientRect(); const p = el.getBoundingClientRect();
      const margin = 8;
      let left = a.left + a.width / 2 - p.width / 2;
      left = Math.max(margin, Math.min(left, innerWidth - p.width - margin));
      const top = flip ? a.bottom + 8 : Math.max(margin, a.top - p.height - 8);
      setPos((cur) => (cur && Math.abs(cur.left - left) < 0.5 && Math.abs(cur.top - top) < 0.5 && cur.below === flip ? cur : { left, top, below: flip }));
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [node, anchor, flip]);
  const host = (anchor.closest(".cn-root") as HTMLElement | null) || document.body;
  let body: React.ReactNode; let bare = false;
  if (node.kind === "group") {
    const items = membersOf(nodes, node);
    const total = (node.children || []).length;
    body = <>
      <div className="ipk-hd"><Icon name="layers" size="xs" /><span className="ipk-name">{title(node) && title(node) !== "group" ? title(node) : groupKind(node)}</span><span className="ipk-meta">{groupKind(node)} · {items.length || total} 项</span></div>
      {items.length ? <div className={"ipk-grid" + (items.length <= 2 ? " few" : "")}>{items.map((n) => <PeekTile key={n.id} n={n} />)}</div> : <div className="ipk-empty">里面还没有节点</div>}
    </>;
  } else {
    const src = srcOf(node); const text = snippetOf(node);
    // 单个节点：不要卡片和名字，直接按原比例放图（视频悬停时静音循环播放，封面兜底）；没图就只给文字
    if (src || node.kind === "video") {
      bare = true;
      const videoUrl = node.kind === "video" ? String(outOf(node)?.url || "") : "";
      body = <div className="ipk-media">
        {src ? <ThumbImg src={src} width={640} lazy={false} fallback={<span className="ipk-media-ph"><Icon name={iconOf(node)} size="s" /></span>} /> : <span className="ipk-media-ph"><Icon name={iconOf(node)} size="s" /></span>}
        {videoUrl ? <PeekVideo src={videoUrl} /> : null}
        {node.kind === "video" ? <span className="ipk-play"><Icon name="play" size="xs" /></span> : null}
      </div>;
    } else {
      // 文本节点没有图：保留一层磨砂底才看得清，但同样不放标题行
      body = <div className="ipk-text">{text || title(node) || "（没有内容）"}</div>;
    }
  }
  return createPortal(<div ref={ref} className={"ipk" + (node.kind === "group" ? " is-group" : "") + (bare ? " is-bare" : "") + (pos?.below ? " below" : "")} role="tooltip"
    style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? undefined : "hidden", ["--ipk-room" as string]: (flip ? Math.max(200, innerHeight - (anchor.getBoundingClientRect().bottom + 16)) : room) + "px" }}>{body}</div>, host);
}
