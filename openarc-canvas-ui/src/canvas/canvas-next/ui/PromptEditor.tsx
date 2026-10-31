/**
 * 生成面板的提示词编辑器（文本 / 图片 / 视频 / 音频节点通用），对齐 TapNow 的 @ 引用上游：
 *   · 在任意位置输入 @ → 光标处弹出上游列表（缩略图 + 名字 + 类型编号），继续输入可过滤，↑↓ 选、↵ / Tab 确定、Esc 关；
 *   · 选中后插入一个整体的引用胶囊（缩略图 + 名字），退格整体删除，插入时有弹出动效；
 *   · 鼠标悬停胶囊：上方出预览卡片，画布上对应的上游节点和连线同时高亮；双击胶囊在画布上定位；
 *   · 连线断开后胶囊变成虚线「未连接」，点一下重新连上；
 *   · 引用文本节点时可以选它里面的一段（海报1 / 镜头2…）。
 * 提示词仍存成纯文本，胶囊对应 `@{节点id}` 记号（见 mentions.ts）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { connect, title } from "../actions";
import { listElements, type CanvasElement } from "../elements";
import { appendMention, relinkMentions, kindIndex, KIND_SHORT, mentionable, mentionToken, MENTION_RE } from "../mentions";
import { expandGroupInputs, genOf, inputsOf, isGenKind, sectionsOf, srcOf, textOf, TYPE_LABEL, uid, type GenKind, type InputRef } from "../model";
import { useCtl, useS } from "./ctx";
import { Icon, ICON_PATHS } from "./Icon";
import { resolveMediaUrl, useAssetUrl } from "./useAsset";

type Item =
  | { type: "node"; key: string; node: CanvasNode; section?: string; ord: number; used: boolean }
  | { type: "fav"; key: string; node: CanvasNode }
  | { type: "element"; key: string; el: CanvasElement };
/** 「@」所在位置：选中后把这个 @ 换成胶囊 */
type AtMark = { text: Text; at: number };

export type PromptEditorProps = {
  node: CanvasNode; value: string; placeholder: string; className?: string;
  onChange: (v: string, opts?: { mention?: boolean }) => void;
  onCommit: (v: string) => void;
  onSend: () => void; onEscape: () => void;
  /** 光标前刚输入了「/」（图片节点的快捷指令） */
  onSlash?: () => void;
};

const svg = (name: keyof typeof ICON_PATHS) => `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
const kindIcon = (k: string): keyof typeof ICON_PATHS => (k === "image" ? "image" : k === "video" ? "video" : k === "audio" ? "audio" : k === "group" ? "layers" : "text");

/* ---------- 纯文本 ⇄ DOM ---------- */
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (el: Node) => {
    el.childNodes.forEach((c) => {
      if (c.nodeType === 3) out += (c.nodeValue || "").replace(/​/g, "");
      else if (c instanceof HTMLElement) {
        if (c.dataset.ref) out += mentionToken(c.dataset.ref, c.dataset.sec || undefined);
        else if (c.tagName === "BR") { if (!c.dataset.tail) out += "\n"; }
        else if (c.tagName === "DIV" || c.tagName === "P") { if (out && !out.endsWith("\n")) out += "\n"; walk(c); }
        else walk(c);
      }
    });
  };
  walk(root);
  return out;
}

export function PromptEditor(props: PromptEditorProps) {
  const { node, value, placeholder, className } = props;
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc);
  const ins = useMemo(() => inputsOf(doc, node.id), [doc, node.id]);
  const mentionIns = useMemo(() => ins.flatMap((x) => x.node.kind === "group" ? [x, ...expandGroupInputs(doc, [x])] : [x]), [doc, ins]);
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; mark: AtMark } | null>(null);
  const [hover, setHover] = useState<{ id: string; sec?: string; rect: DOMRect } | null>(null);
  const propsRef = useRef(props); propsRef.current = props;

  /* 胶囊 DOM：缩略图异步解析（和画布共用缓存） */
  const chipEl = (id: string, sec: string | undefined, fresh = false) => {
    const n = doc.nodes.find((x) => x.id === id);
    const span = document.createElement("span");
    span.className = "pm-chip" + (fresh ? " pm-in" : ""); span.contentEditable = "false";
    span.dataset.ref = id; if (sec) span.dataset.sec = sec;
    const linked = mentionIns.some((x) => x.node.id === id);
    if (!n) span.classList.add("gone"); else if (!linked) span.classList.add("off");
    if (n) span.dataset.kind = n.kind;
    const th = document.createElement("span"); th.className = "pm-th";
    const src = n ? srcOf(n) : "";
    if (src) {
      const img = document.createElement("img"); img.alt = ""; img.draggable = false; th.appendChild(img);
      void resolveMediaUrl(store.backend, src).then((u) => { if (u) img.src = u; else th.innerHTML = svg(kindIcon(n!.kind)); });
    } else th.innerHTML = svg(n ? kindIcon(n.kind) : "x");
    const lb = document.createElement("span"); lb.className = "pm-t";
    lb.textContent = n ? title(n) + (sec ? " · " + sec : "") : "已删除";
    // 悬停时缩略图换成 ×（TapNow）：点 × 删掉这个引用
    const x = document.createElement("span"); x.className = "pm-x"; x.dataset.rm = "1"; x.innerHTML = svg("x"); x.title = "删除引用";
    span.append(th, x, lb);
    if (n && linked && isGenKind(n.kind) && n.kind !== "text") { const b = document.createElement("span"); b.className = "pm-n"; b.textContent = KIND_SHORT[n.kind as GenKind] + kindIndex(mentionIns, id); span.appendChild(b); }
    return span;
  };
  const paint = (v: string) => {
    const el = ref.current; if (!el) return;
    el.innerHTML = "";
    const raw = v; v = relinkMentions(v, mentionIns.map((x) => x.node)); // 旧的「@标题·海报1」也显示成胶囊
    const re = new RegExp(MENTION_RE.source, "g"); let at = 0; let m: RegExpExecArray | null;
    const text = (s: string) => { const parts = s.split("\n"); parts.forEach((p, i) => { if (i) el.appendChild(document.createElement("br")); if (p) el.appendChild(document.createTextNode(p)); }); };
    while ((m = re.exec(v))) { text(v.slice(at, m.index)); el.appendChild(chipEl(m[1], m[2] || undefined)); at = m.index + m[0].length; }
    text(v.slice(at));
    if (v.endsWith("\n")) { const br = document.createElement("br"); br.dataset.tail = "1"; el.appendChild(br); }
    el.classList.toggle("empty", !v);
    last.current = raw;
  };
  // 外部改了提示词（连线自动补引用、优化提示词、切节点）→ 重画；自己打字产生的变化不重画（保住光标）
  useLayoutEffect(() => { if (value !== last.current) { const focused = document.activeElement === ref.current; paint(value); if (focused) caretToEnd(); } });
  // 连线 / 缩略图变了：胶囊状态跟着刷新（不动文字）
  const sig = mentionIns.map((x) => x.node.id + ":" + srcOf(x.node) + ":" + title(x.node)).join("|");
  useEffect(() => { const el = ref.current; if (!el) return; const focused = document.activeElement === el; const sel = focused ? saveCaret(el) : null; paint(serialize(el)); if (sel) restoreCaret(el, sel); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const caretToEnd = () => { const el = ref.current!; const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const tail = el.lastChild as HTMLElement | null; if (tail && tail.dataset?.tail) r.setStartBefore(tail); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); };
  const emit = (opts?: { mention?: boolean }) => { const el = ref.current!; const v = serialize(el); last.current = v; el.classList.toggle("empty", !v); propsRef.current.onChange(v, opts); };

  /** 光标前刚输入的「@」（行首或跟在空白 / 标点后面），弹出上游列表 */
  const atBeforeCaret = (): AtMark | null => {
    const s = getSelection(); if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const r = s.getRangeAt(0); const t = r.startContainer; if (t.nodeType !== 3 || !ref.current?.contains(t)) return null;
    const before = (t.nodeValue || "").slice(0, r.startOffset);
    if (!before.endsWith("@")) return null;
    return { text: t as Text, at: r.startOffset - 1 };
  };
  const caretRect = (): DOMRect => {
    const s = getSelection(); const r = s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
    let rect = r ? r.getBoundingClientRect() : null;
    if (!rect || (!rect.width && !rect.height && !rect.x)) rect = ref.current!.getBoundingClientRect();
    return rect;
  };
  const openMenu = (mark: AtMark) => { const r = caretRect(); setMenu({ x: r.left, y: r.top, mark }); };
  /** 弹层关了：光标回到 @ 后面（@ 留在原文里，和 TapNow 一样） */
  const closeMenu = (refocus = true) => {
    const m = menu; setMenu(null);
    if (refocus && m && ref.current) { ref.current.focus(); try { const r = document.createRange(); r.setStart(m.mark.text, Math.min(m.mark.at + 1, m.mark.text.length)); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); } catch { caretToEnd(); } }
  };
  const placeAfter = (n: Node) => { const r = document.createRange(); r.setStartAfter(n); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); };

  /** 在 @ 的位置插入一个上游引用胶囊 */
  const insertChip = (id: string, section?: string) => {
    const el = ref.current!; const m = menu; setMenu(null); el.focus();
    const r = document.createRange();
    const mk = m?.mark; const ok = mk && el.contains(mk.text) && (mk.text.nodeValue || "")[mk.at] === "@";
    if (ok) { r.setStart(mk!.text, mk!.at); r.setEnd(mk!.text, mk!.at + 1); r.deleteContents(); } else { r.selectNodeContents(el); r.collapse(false); }
    const chip = chipEl(id, section, true);
    const sp = document.createTextNode("\u00a0");
    r.insertNode(sp); r.insertNode(chip);
    // 第一次 @：已经连着、还没被引用的上游一起补到末尾（切到引用模式后只发送被引用的上游，旧输入不能丢）
    let v = serialize(el);
    if (genOf(store.node(node.id)!).refMode !== "mention") {
      const before = v;
      for (const x of inputsOf(store.state.doc, node.id)) if (mentionable(x.node) && x.node.id !== id) v = appendMention(v, x.node.id);
      if (v !== before) { placeAfter(sp); const sel = saveCaret(el); paint(v); if (sel != null) restoreCaret(el, sel); store.toast("已切到 @ 引用：只发送提示词里引用到的上游，其它连线已一并补成引用"); }
      else placeAfter(sp);
    } else placeAfter(sp);
    emit({ mention: true });
    setTimeout(() => el.querySelectorAll(".pm-in").forEach((c) => c.classList.remove("pm-in")), 260);
  };
  const insertText = (t: string) => {
    const el = ref.current!; const m = menu; setMenu(null); el.focus();
    const r = document.createRange(); const mk = m?.mark;
    if (mk && el.contains(mk.text) && (mk.text.nodeValue || "")[mk.at] === "@") { r.setStart(mk.text, mk.at); r.setEnd(mk.text, mk.at + 1); r.deleteContents(); } else { r.selectNodeContents(el); r.collapse(false); }
    const tn = document.createTextNode(t); r.insertNode(tn); placeAfter(tn); emit();
  };
  const pick = (it: Item) => {
    if (it.type === "node") return insertChip(it.node.id, it.section);
    if (it.type === "element") return insertText("@" + it.el.name + " ");
    // 收藏的素材：复制一个上传节点放到左边、连进来，再在 @ 处插入它的引用
    const live = store.node(node.id); if (!live) return;
    const k = it.node.kind as GenKind; const o = genOf(it.node);
    const made = store.newNode(k, live.x - (it.node.w || 240) - 120, live.y + 24 * inputsOf(store.state.doc, node.id).length, { title: o.title, uploaded: k !== "text", manual: k === "text", hist: o.hist.slice(o.hi, o.hi + 1), w: it.node.w, h: it.node.h });
    store.addNodes([made], [{ id: uid("e"), from: made.id, to: node.id }], { select: false });
    insertChip(made.id);
    store.toast(`已把「${o.title}」连成输入并引用`);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if ((e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.metaKey && !e.ctrlKey && chipDelete(e.key === "Backspace")) { e.preventDefault(); emit(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); propsRef.current.onCommit(serialize(ref.current!)); propsRef.current.onSend(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); insertBreak(); emit(); return; }
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); insertBreak(); emit(); return; }
    if (e.key === "Escape") { ref.current!.blur(); propsRef.current.onEscape(); }
  };
  /**
   * 退格 / Delete 碰到胶囊时自己处理：胶囊整体删掉；胶囊之间只剩一个字时也自己删，
   * 不然 Chrome 会在两个不可编辑元素之间塞一个 <br>（提示词里多出空行）。
   */
  const chipDelete = (back: boolean): boolean => {
    const root = ref.current!; const s = getSelection(); if (!s || !s.rangeCount || !s.isCollapsed) return false;
    const r = s.getRangeAt(0); let c: Node = r.startContainer; let off = r.startOffset;
    const isChip = (n: Node | null | undefined): n is HTMLElement => !!n && n instanceof HTMLElement && !!n.dataset.ref;
    const caretAt = (parent: Node, idx: number) => { const rr = document.createRange(); rr.setStart(parent, Math.max(0, Math.min(idx, parent.childNodes.length))); rr.collapse(true); s.removeAllRanges(); s.addRange(rr); };
    const idxOf = (n: Node) => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;
    if (c.nodeType === 3) {
      const t = c.nodeValue || "";
      const edge = back ? off === 0 : off === t.length;
      if (edge) { const sib = back ? c.previousSibling : c.nextSibling; if (isChip(sib)) { const i = idxOf(sib); sib.remove(); caretAt(root, back ? i : i); return true; } return false; }
      if (t.length === 1 && (isChip(c.previousSibling) || isChip(c.nextSibling))) { const i = idxOf(c); c.parentNode!.removeChild(c); caretAt(root, i); return true; }
      return false;
    }
    if (c === root) { const sib = back ? root.childNodes[off - 1] : root.childNodes[off]; if (isChip(sib)) { sib.remove(); caretAt(root, back ? off - 1 : off); return true; } }
    return false;
  };
  const insertBreak = () => {
    const s = getSelection(); if (!s || !s.rangeCount) return; const r = s.getRangeAt(0); r.deleteContents();
    const br = document.createElement("br"); r.insertNode(br);
    const el = ref.current!; const lastBr = el.lastChild as HTMLElement | null;
    if (!br.nextSibling || (lastBr && lastBr === br)) { const tail = document.createElement("br"); tail.dataset.tail = "1"; el.appendChild(tail); }
    placeAfter(br);
  };
  const onInput = () => {
    const el = ref.current!;
    // 浏览器可能留下空的 <br> / 包了 <div>：统一按纯文本重画（不在输入法组字时做）
    emit();
    const mk = atBeforeCaret(); if (mk) openMenu(mk); else if (menu) setMenu(null);
    const q = getSelection(); const t = q && q.rangeCount ? q.getRangeAt(0).startContainer : null;
    if (t && t.nodeType === 3 && /(^|\s)\/$/.test((t.nodeValue || "").slice(0, q!.getRangeAt(0).startOffset)) && propsRef.current.onSlash) propsRef.current.onSlash();
    if (el.querySelector("div,p")) { const sel = saveCaret(el); paint(serialize(el)); if (sel) restoreCaret(el, sel); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault(); e.stopPropagation();
    const t = e.clipboardData.getData("text/plain"); if (!t) return;
    const s = getSelection(); if (!s || !s.rangeCount) return; const r = s.getRangeAt(0); r.deleteContents();
    const v0 = serialize(ref.current!);
    // 粘贴里带记号（从别的节点复制过来）：整体重画成胶囊
    if (new RegExp(MENTION_RE.source).test(t)) { const mark = document.createTextNode("⁣"); r.insertNode(mark); const all = serialize(ref.current!); const [a, b] = all.split("⁣"); paint(a + t + (b || "")); caretToEnd(); emit(); return; }
    const tn = document.createTextNode(t); r.insertNode(tn); placeAfter(tn); if (serialize(ref.current!) !== v0) emit();
  };
  const onCopy = (e: React.ClipboardEvent) => {
    const s = getSelection(); if (!s || !s.rangeCount || s.isCollapsed) return;
    const box = document.createElement("div"); box.appendChild(s.getRangeAt(0).cloneContents());
    e.preventDefault(); e.clipboardData.setData("text/plain", serialize(box));
  };

  /* 胶囊交互：悬停预览 + 画布高亮；双击定位；点未连接的胶囊重新连上 */
  const chipOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".pm-chip") : null);
  const onMove = (e: React.PointerEvent) => {
    const c = chipOf(e.target);
    if (!c) { if (hover) { setHover(null); store.setUI({ hlEdge: null, hlNode: null }); } return; }
    if (hover && hover.id === c.dataset.ref && (hover.sec || "") === (c.dataset.sec || "")) return;
    const id = c.dataset.ref!; const edge = mentionIns.find((x) => x.node.id === id)?.edge.id || null;
    setHover({ id, sec: c.dataset.sec, rect: c.getBoundingClientRect() }); store.setUI({ hlNode: id, hlEdge: edge });
  };
  const onLeave = () => { if (hover) { setHover(null); store.setUI({ hlEdge: null, hlNode: null }); } };
  const onClick = (e: React.MouseEvent) => {
    const c = chipOf(e.target); if (!c) return;
    if ((e.target as Element).closest("[data-rm]")) {
      e.preventDefault(); const sp = c.nextSibling; const r = document.createRange(); r.setStartBefore(c); r.collapse(true);
      if (sp && sp.nodeType === 3 && /^[\u00a0 ]/.test(sp.nodeValue || "")) sp.nodeValue = (sp.nodeValue || "").slice(1);
      c.remove(); ref.current!.focus(); const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
      setHover(null); store.setUI({ hlEdge: null, hlNode: null }); emit(); propsRef.current.onCommit(serialize(ref.current!)); return;
    }
    if (c.classList.contains("off")) { const id = c.dataset.ref!; if (connect(store, id, node.id, { select: false, quiet: true })) store.toast(`已重新连接「${title(store.node(id)!)}」`); return; }
    c.classList.remove("pick"); void c.offsetWidth; c.classList.add("pick");
  };
  const onDbl = (e: React.MouseEvent) => { const c = chipOf(e.target); if (c && store.node(c.dataset.ref!)) { e.preventDefault(); ctl.focusNode(c.dataset.ref!); } };
  useEffect(() => () => store.setUI({ hlEdge: null, hlNode: null }), [store]);

  return <>
    <div id="gpPrompt" ref={ref} className={"pm-ed " + (className || "")} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
      data-placeholder={placeholder} spellCheck={false}
      onInput={onInput} onKeyDown={onKeyDown}
      onBlur={() => propsRef.current.onCommit(serialize(ref.current!))}
      onPaste={onPaste} onCopy={onCopy} onCut={(e) => { onCopy(e); if (!e.defaultPrevented) return; getSelection()?.getRangeAt(0).deleteContents(); emit(); }}
      onPointerMove={onMove} onPointerLeave={onLeave} onClick={onClick} onDoubleClick={onDbl} />
    {menu ? createPortal(<MentionMenu key={menu.mark.at} node={node} ins={mentionIns} value={value} x={menu.x} y={menu.y} onPick={pick} onClose={() => closeMenu()} />, document.querySelector(".cn-root") || document.body) : null}
    {hover ? createPortal(<ChipPreview id={hover.id} sec={hover.sec} rect={hover.rect} ins={mentionIns} />, document.querySelector(".cn-root") || document.body) : null}
  </>;
}

/* ---------- 光标保存 / 恢复（按纯文本偏移，胶囊算 1 个字符） ---------- */
function saveCaret(root: HTMLElement): number | null {
  const s = getSelection(); if (!s || !s.rangeCount) return null; const r = s.getRangeAt(0); if (!root.contains(r.startContainer)) return null;
  let off = 0; let done = false;
  const walk = (n: Node) => {
    if (done) return;
    if (n === r.startContainer && n.nodeType === 3) { off += r.startOffset; done = true; return; }
    if (n === r.startContainer) { for (let i = 0; i < r.startOffset; i++) count(n.childNodes[i]); done = true; return; }
    if (n.nodeType === 3) { off += (n.nodeValue || "").length; return; }
    if (n instanceof HTMLElement && n.dataset.ref) { off += 1; return; }
    if (n instanceof HTMLElement && n.tagName === "BR") { off += 1; return; }
    n.childNodes.forEach(walk);
  };
  const count = (n: Node) => { if (!n) return; if (n.nodeType === 3) off += (n.nodeValue || "").length; else if (n instanceof HTMLElement && (n.dataset.ref || n.tagName === "BR")) off += 1; else n.childNodes.forEach(count); };
  walk(root); return off;
}
function restoreCaret(root: HTMLElement, off: number) {
  const r = document.createRange(); let left = off; let placed = false;
  for (const n of Array.from(root.childNodes)) {
    const len = n.nodeType === 3 ? (n.nodeValue || "").length : 1;
    if (left <= len) { if (n.nodeType === 3) r.setStart(n, left); else if (left === 0) r.setStartBefore(n); else r.setStartAfter(n); placed = true; break; }
    left -= len;
  }
  if (!placed) { r.selectNodeContents(root); r.collapse(false); }
  r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
}

/* ---------- @ 弹层（TapNow：贴着 @ 往上弹，顶部搜索框；已连接节点 #序号 + 类型图标；个人素材库文件夹） ---------- */
const FOLDERS: Array<{ id: string; name: string; always?: boolean }> = [
  { id: "fav", name: "收藏", always: true }, { id: "character", name: "角色", always: true }, { id: "scene", name: "场景", always: true },
  { id: "product", name: "产品" }, { id: "style", name: "风格" }, { id: "other", name: "其他" },
];
function MentionMenu({ node, ins, value, x, y, onPick, onClose }: { node: CanvasNode; ins: InputRef[]; value: string; x: number; y: number; onPick: (it: Item) => void; onClose: () => void }) {
  const ctl = useCtl(); const doc = useS((s) => s.doc);
  const [q, setQ] = useState(""); const [hi, setHi] = useState(0); const [folder, setFolder] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null); const inp = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return; const root = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() || new DOMRect(0, 0, innerWidth, innerHeight);
    const w = el.offsetWidth, h = el.offsetHeight; const up = y - 10 - h >= 8;
    setPos({ left: Math.max(8, Math.min(x - 14, innerWidth - w - 8)) - root.left, top: (up ? y - 10 - h : y + 26) - root.top, up });
  }, [x, y, folder]);
  useEffect(() => { inp.current?.focus(); }, [folder]);
  // 点弹层外面：关掉
  useEffect(() => { const on = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); }; document.addEventListener("pointerdown", on, true); return () => document.removeEventListener("pointerdown", on, true); }, [onClose]);

  const kw = q.trim().toLowerCase(); const hit = (...s: string[]) => !kw || s.some((t) => t.toLowerCase().includes(kw));
  const used = useMemo(() => new Set(([...value.matchAll(new RegExp(MENTION_RE.source, "g"))]).map((m) => m[1] + "#" + (m[2] || ""))), [value]);
  const els = listElements();
  const favs = doc.nodes.filter((n) => (n.kind === "image" || n.kind === "video") && genOf(n).fav && n.id !== node.id && !ins.some((x) => x.node.id === n.id));
  const linked: Item[] = []; ins.filter((x) => mentionable(x.node)).forEach((x) => {
    const typeLabel = x.node.kind === "group" ? "分组" : isGenKind(x.node.kind) ? TYPE_LABEL[x.node.kind] : "";
    if (hit(title(x.node), "#" + (x.order + 1), typeLabel)) linked.push({ type: "node", key: x.node.id, node: x.node, ord: x.order + 1, used: used.has(x.node.id + "#") });
    if (x.node.kind === "text") Object.keys(sectionsOf(textOf(x.node))).forEach((k) => { if (hit(title(x.node) + k)) linked.push({ type: "node", key: x.node.id + "#" + k, node: x.node, section: k, ord: x.order + 1, used: used.has(x.node.id + "#" + k) }); });
  });
  const inFolder = (f: string): Item[] => f === "fav" ? favs.filter((n) => hit(title(n))).map((n) => ({ type: "fav", key: "fav:" + n.id, node: n }))
    : node.kind === "audio" ? [] : els.filter((e) => e.kind === f && hit(e.name, e.desc)).map((e) => ({ type: "element", key: "el:" + e.id, el: e }));
  const folders = FOLDERS.filter((f) => f.always || inFolder(f.id).length);
  // 搜索时直接列出素材库里匹配的条目（不用一层层点进去）
  const lib: Item[] = folder ? inFolder(folder) : kw ? folders.flatMap((f) => inFolder(f.id)) : [];
  const flat: Item[] = folder ? lib : [...linked, ...lib];
  useEffect(() => { setHi(0); }, [q, folder]);
  useEffect(() => { box.current?.querySelector(".pm-it.hi")?.scrollIntoView({ block: "nearest" }); }, [hi]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); if (folder) setFolder(null); else onClose(); return; }
    if (e.key === "Backspace" && !q) { e.preventDefault(); if (folder) setFolder(null); else onClose(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (flat.length) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const it = flat[hi]; if (it) onPick(it); return; }
  };
  // 输入序号快选：「1」「#2」直接选中已连接的第 N 个
  const onQ = (v: string) => {
    const m = /^#?(\d{1,2})$/.exec(v.trim());
    if (m && !folder) { const it = linked.find((x) => x.type === "node" && x.ord === +m[1] && !x.section); if (it) { onPick(it); return; } }
    setQ(v);
  };
  let i = -1; const row = (it: Item) => { i++; const me = i; const on = me === hi; const common = { "data-mi": it.key, className: "pm-it" + (on ? " hi" : "") + (it.type === "node" && it.section ? " sub" : ""), onPointerEnter: () => setHi(me), onClick: () => onPick(it) };
    if (it.type === "node") return <button key={it.key} {...common}><MenuThumb node={it.node} /><span className="pm-nm">{it.section ? <>{title(it.node)}<i> › </i>{it.section}</> : title(it.node)}</span>{it.used ? <Icon name="check" size="xs" /> : null}<span className="pm-k">#{it.ord}</span><span className="pm-ty"><Icon name={kindIconName(it.node.kind)} size="s" /></span></button>;
    if (it.type === "fav") return <button key={it.key} {...common}><MenuThumb node={it.node} /><span className="pm-nm">{title(it.node)}</span><span className="pm-ty"><Icon name={kindIconName(it.node.kind)} size="s" /></span></button>;
    return <button key={it.key} {...common}><ElThumb el={it.el} /><span className="pm-nm">{it.el.name}</span><span className="pm-k">元素</span></button>;
  };
  return <div ref={box} className={"pm-menu" + (pos?.up ? " up" : "")} data-mention-menu style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }} onPointerDown={(e) => e.stopPropagation()}>
    <div className="pm-search">
      {folder ? <button className="pm-back" data-act="back" onClick={() => setFolder(null)} aria-label="返回"><Icon name="back" size="s" /></button> : <Icon name="search" size="s" />}
      <input ref={inp} placeholder={folder ? `搜索${FOLDERS.find((f) => f.id === folder)?.name || ""}` : "搜索"} value={q} onChange={(e) => onQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
    </div>
    <div className="pm-body">
      {folder ? <>
        <div className="pm-h"><span>{FOLDERS.find((f) => f.id === folder)?.name}</span></div>
        {lib.length ? lib.map(row) : <div className="pm-empty">{folder === "fav" ? "还没有收藏：点图片 / 视频节点左上角的星标" : "这个文件夹还没有素材：在素材库里新建元素"}</div>}
      </> : <>
        <div className="pm-h"><span>已连接节点</span>{linked.length ? <span className="pm-tip">输入序号快选</span> : null}</div>
        {linked.length ? linked.map(row) : <div className="pm-empty">{ins.some((x) => mentionable(x.node)) ? "没有匹配的节点" : <>还没有连接上游节点<br /><span>把节点连到这里，或点 ⊕ 从画布选择</span></>}</div>}
        {node.kind !== "audio" || favs.length ? <><div className="pm-sep" />
          <div className="pm-h"><span>个人素材库</span></div>
          {kw ? (lib.length ? lib.map(row) : <div className="pm-empty">素材库里没有匹配的</div>)
            : folders.map((f) => <button key={f.id} className="pm-it pm-fd" data-folder={f.id} onClick={() => { setFolder(f.id); setQ(""); }}><span className="pm-fic"><Icon name="folder" size="s" /></span><span className="pm-nm">{f.name}</span><span className="pm-k">{inFolder(f.id).length || ""}</span><Icon name="right" size="s" /></button>)}
        </> : null}
      </>}
    </div>
  </div>;
}
const kindIconName = kindIcon;
function MenuThumb({ node }: { node: CanvasNode }) {
  const u = useAssetUrl(srcOf(node));
  return <span className={"pm-mth k-" + node.kind}>{u ? <img src={u} alt="" draggable={false} /> : <Icon name={kindIconName(node.kind)} size="xs" />}</span>;
}
function ElThumb({ el }: { el: CanvasElement }) {
  const u = useAssetUrl(el.refs[0] || "");
  return <span className="pm-mth">{u ? <img src={u} alt="" draggable={false} /> : <Icon name="user" size="xs" />}</span>;
}

/* ---------- 胶囊悬停预览 ---------- */
function ChipPreview({ id, sec, rect, ins }: { id: string; sec?: string; rect: DOMRect; ins: InputRef[] }) {
  const ctl = useCtl(); const n = ctl.store.node(id); const u = useAssetUrl(n ? srcOf(n) : "");
  const box = useRef<HTMLDivElement>(null); const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return; const root = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() || new DOMRect(0, 0, innerWidth, innerHeight);
    const w = el.offsetWidth, h = el.offsetHeight; let top = rect.top - h - 8; if (top < 8) top = rect.bottom + 8;
    setPos({ left: Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8)) - root.left, top: top - root.top });
  }, [rect]);
  if (!n) return null;
  const linked = ins.some((x) => x.node.id === id);
  const body = n.kind === "text" ? (sec ? sectionsOf(textOf(n))[sec] : textOf(n)) || "（空文本）" : "";
  const st = pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 };
  // TapNow：图片 / 视频只给一张带描边的图；文本 / 音频 / 分组是一张小卡片，底部居中「@名字」
  if (u) return <div ref={box} className={"pm-prev img" + (linked ? "" : " off")} style={st}><img src={u} alt="" draggable={false} /></div>;
  return <div ref={box} className={"pm-prev card" + (linked ? "" : " off")} style={st}>
    {n.kind === "text" ? <p>{body.slice(0, 80)}</p> : <div className="pm-pv-ic"><Icon name={kindIcon(n.kind)} /></div>}
    <b>@{title(n)}{sec ? "·" + sec : ""}</b>
  </div>;
}
