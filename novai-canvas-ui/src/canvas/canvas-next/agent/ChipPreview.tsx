/**
 * 助手输入区 / 顶部胶囊的悬停预览（和节点编辑器的 ChipPreview 同一套观感，但数据只依赖画布文档）：
 *   · 悬停约 120ms 才出卡，移开约 200ms 关；鼠标移进卡片不关；Esc / 点外面立刻关；
 *   · 图片 / 视频给缩略图，文本节点给内容片段，分组 / 堆叠给成员数量，素材 / 应用 / 技能给图标 + 标题；
 *   · 卡片默认浮在整个输入框上方（不挡输入框），上方放不下就翻到下方。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../ui/Icon";
import { ThumbImg } from "../ui/thumb";
import { useCtl } from "../ui/ctx";
import { isGenKind, srcOf, textOf } from "../model";
import { isStack, stackItems } from "../stack";
import type { MentionChip, MentionKind } from "./MentionInput";

const HOVER_DELAY = 120;
const LEAVE_DELAY = 200;
const GAP = 8;

type Req = { kind: MentionKind; id: string; rect: DOMRect };

let current: Req | null = null;
let showTimer = 0;
let hideTimer = 0;
const subs = new Set<() => void>();
const emit = () => { subs.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
const snapshot = () => current;

/** 悬停某个胶囊：120ms 后才真正弹出（划过不闪） */
export function hoverChip(chip: { kind: MentionKind; id: string }, rect: DOMRect): void {
  window.clearTimeout(showTimer); window.clearTimeout(hideTimer); hideTimer = 0;
  showTimer = window.setTimeout(() => { showTimer = 0; current = { ...chip, rect }; emit(); }, HOVER_DELAY);
}
/** 移开胶囊：200ms 后关（留给鼠标移进卡片） */
export function leaveChip(): void {
  window.clearTimeout(showTimer); showTimer = 0;
  if (!current) return;
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => { hideTimer = 0; current = null; emit(); }, LEAVE_DELAY);
}
/** 鼠标进了卡片：取消待关闭 */
export function keepChip(): void {
  window.clearTimeout(hideTimer); hideTimer = 0;
  window.clearTimeout(showTimer); showTimer = 0;
}
export function closeChip(): void {
  window.clearTimeout(showTimer); window.clearTimeout(hideTimer); showTimer = hideTimer = 0;
  if (!current) return;
  current = null; emit();
}

/** 挂在助手面板里一次即可；resolve 用调用方的胶囊解析（标题 / 图标 / 角标） */
export function ChipPreviewHost({ resolve }: { resolve: (kind: MentionKind, id: string) => MentionChip | null }) {
  const req = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!req) return null;
  return createPortal(<ChipPreviewCard req={req} resolve={resolve} />, document.querySelector(".cn-root") || document.body);
}

function ChipPreviewCard({ req, resolve }: { req: Req; resolve: (kind: MentionKind, id: string) => MentionChip | null }) {
  const store = useCtl().store;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const chip = resolve(req.kind, req.id);
  const doc = store.state.doc;
  const node = req.kind === "node" ? doc.nodes.find((n) => n.id === req.id) : undefined;
  const members = node ? (isStack(node) ? stackItems(doc, node) : node.kind === "group" ? (node.children || []).map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n) : []) : [];
  const src = chip?.src || (node ? srcOf(node) : "") || members.map((m) => srcOf(m)).find(Boolean) || "";
  const snippet = node && node.kind === "text" ? textOf(node).trim().slice(0, 180) : "";
  const title = chip?.title || (node ? "节点" : "引用");
  const kindName = node ? (node.kind === "group" ? (isStack(node) ? "堆叠" : "分组") : node.kind === "table" ? "表格" : node.kind === "text" ? "文本" : node.kind === "audio" ? "音频" : node.kind === "video" ? "视频" : "图片") : "";
  const sub = members.length ? members.length + " 个成员" : kindName && kindName !== "图片" ? kindName : chip?.badge || "";
  const showImage = !!src && (!!node ? isGenKind(node.kind) || members.length > 0 : true) && !snippet;

  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const place = () => {
      const root = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() || new DOMRect(0, 0, innerWidth, innerHeight);
      const w = el.offsetWidth, h = el.offsetHeight;
      // 浮在整个输入框上方（不挡输入区）；上方放不下就翻到下方
      const composer = document.getElementById("aiBox")?.getBoundingClientRect();
      const anchorTop = composer ? Math.min(req.rect.top, composer.top) : req.rect.top;
      const anchorBottom = composer ? Math.max(req.rect.bottom, composer.bottom) : req.rect.bottom;
      let top = anchorTop - GAP - h;
      if (top < 8) top = Math.min(innerHeight - h - 8, anchorBottom + GAP);
      const left = Math.max(8, Math.min(req.rect.left + req.rect.width / 2 - w / 2, innerWidth - w - 8));
      setPos({ left: left - root.left, top: top - root.top });
    };
    place();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (ro) ro.observe(el);
    return () => ro?.disconnect();
  }, [req]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeChip(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Element | null; if (t && typeof t.closest === "function" && t.closest("[data-chip-prev]")) return; closeChip(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  }, []);

  return <div ref={box} className={"pm-prev chip-prev " + (showImage ? "img" : "card")} data-chip-prev
    style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999, visibility: "hidden" }}
    onPointerEnter={keepChip} onPointerLeave={leaveChip}>
    {showImage
      ? <ThumbImg src={src} width={180} lazy={false} fallback={<div className="pm-prev-th"><Icon name={(chip?.icon || "image") as IconName} /></div>} />
      : <>
        {src ? <div className="pm-prev-th"><ThumbImg src={src} width={150} lazy={false} fallback={<Icon name={(chip?.icon || "layers") as IconName} size="s" />} /></div>
          : <div className="pm-pv-ic"><Icon name={(chip?.icon || "layers") as IconName} /></div>}
        {snippet ? <p>{snippet}</p> : null}
        <b>@{title}</b>
        {sub ? <span className="pm-prev-sub">{sub}</span> : null}
      </>}
  </div>;
}
