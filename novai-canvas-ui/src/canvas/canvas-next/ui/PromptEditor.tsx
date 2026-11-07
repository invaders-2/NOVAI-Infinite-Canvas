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
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { connect, title } from "../actions";
import { listElements, type CanvasElement } from "../elements";
import { relinkMentions, kindIndex, KIND_SHORT, mentionable, mentionToken, selfRefOf, MENTION_RE } from "../mentions";
import { expandGroupInputs, genOf, inputsOf, isGenKind, sectionsOf, srcOf, textOf, TYPE_LABEL, uid, type GenKind, type InputRef } from "../model";
import { isStack, stackItems } from "../stack";
import { useCtl, useS } from "./ctx";
import { Icon, ICON_PATHS } from "./Icon";
import { resolveMediaUrl, useAssetUrl } from "./useAsset";
import { ThumbImg, setChipThumb } from "./thumb";

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

/** 名字真的被截断才挂 .trunc（渐变淡出）；「本节点」「图1」这类短名字保持完整可读。必须在胶囊进 DOM 之后量 */
function fitChip(chip: HTMLElement) {
  const t = chip.querySelector<HTMLElement>(".pm-t");
  if (!t) return;
  // 隐藏时 clientWidth 为 0：不判断，等下次重建 / 字体到位 / 窗口变化再量
  t.classList.toggle("trunc", t.clientWidth > 0 && t.scrollWidth > t.clientWidth + 1);
}

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
  // 本节点当前结果也能 @（图片 / 视频）：放在已连接输入之后，编号才和请求里的发送顺序一致
  const selfIns = useMemo(() => selfRefOf(node), [node]);
  const mentionIns = useMemo(() => [...ins.flatMap((x) => x.node.kind === "group" ? [x, ...expandGroupInputs(doc, [x])] : [x]), ...(selfIns ? [selfIns] : [])], [doc, ins, selfIns]);
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; mark: AtMark } | null>(null);
  const [hover, setHover] = useState<{ id: string; sec?: string; rect: DOMRect } | null>(null);
  // 预览卡的交互状态：hover 是一过性的；点「+N」后 pin 住（Esc / 点卡片外 / 收起才关）
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  const leaveTimer = useRef<number | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  /** 输入法组字状态：组字期间不重建胶囊 DOM；选中引用前先提交组字 */
  const composing = useRef<{ active: boolean; data: string }>({ active: false, data: "" });
  const composePending = useRef(false);
  /** ?debugKeys=1 / window.__nvKeysDebug：把最近 12 条键盘/输入法事件画在编辑器右下角（只读，便于真机截图定位） */
  const debugOn = useMemo(() => { try { return new URLSearchParams(location.search).get("debugKeys") === "1" || (window as unknown as { __nvKeysDebug?: unknown }).__nvKeysDebug === true; } catch { return false; } }, []);
  const [debugLines, setDebugLines] = useState<string[]>([]);

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
      // 胶囊只有 16px：用缩略图，别挂原图（见 setChipThumb）
      const fail = () => { th.innerHTML = svg(kindIcon(n!.kind)); };
      void resolveMediaUrl(store.backend, src).then((u) => setChipThumb(th, u, fail), fail);
    } else th.innerHTML = svg(n ? kindIcon(n.kind) : "x");
    const lb = document.createElement("span"); lb.className = "pm-t";
    // 自引用胶囊写明「本节点」，用户一眼能看出引用的是自己这张图 / 这段视频
    const full = n ? (n.id === node.id ? "本节点" : title(n) + (sec ? " · " + sec : "")) : "已删除";
    lb.textContent = full; span.title = full; // 名字会被渐变淡出遮掉一半，悬停看全名
    // 悬停时缩略图换成 ×（TapNow）：点 × 删掉这个引用
    const x = document.createElement("span"); x.className = "pm-x"; x.dataset.rm = "1"; x.innerHTML = svg("x"); x.title = "删除引用";
    span.append(th, x, lb);
    if (n && linked && isGenKind(n.kind) && n.kind !== "text") { const b = document.createElement("span"); b.className = "pm-n"; b.textContent = KIND_SHORT[n.kind as GenKind] + kindIndex(mentionIns, id); span.appendChild(b); }
    return span;
  };
  /** 字体异步到位、面板宽度变化后溢出会变：重画后补量一次 */
  const remeasure = () => { ref.current?.querySelectorAll<HTMLElement>(".pm-chip").forEach(fitChip); };
  const paint = (v: string) => {
    const el = ref.current; if (!el) return;
    el.innerHTML = "";
    const raw = v; v = relinkMentions(v, mentionIns.map((x) => x.node)); // 旧的「@标题·海报1」也显示成胶囊
    const re = new RegExp(MENTION_RE.source, "g"); let at = 0; let m: RegExpExecArray | null;
    const text = (s: string) => { const parts = s.split("\n"); parts.forEach((p, i) => { if (i) el.appendChild(document.createElement("br")); if (p) el.appendChild(document.createTextNode(p)); }); };
    while ((m = re.exec(v))) { text(v.slice(at, m.index)); const chip = chipEl(m[1], m[2] || undefined); el.appendChild(chip); fitChip(chip); at = m.index + m[0].length; }
    text(v.slice(at));
    if (v.endsWith("\n")) { const br = document.createElement("br"); br.dataset.tail = "1"; el.appendChild(br); }
    el.classList.toggle("empty", !v.trim()); // 只剩换行也算空：placeholder 要回来
    last.current = raw;
    requestAnimationFrame(remeasure);
  };
  // 外部改了提示词（连线自动补引用、优化提示词、切节点）→ 重画；自己打字产生的变化不重画（保住光标）
  useLayoutEffect(() => {
    if (value === last.current) return;
    if (composing.current.active) { composePending.current = true; return; } // 组字中不重建 DOM
    const focused = document.activeElement === ref.current; paint(value); if (focused) caretToEnd();
  });
  // 连线 / 缩略图变了：胶囊状态跟着刷新（不动文字）
  const sig = mentionIns.map((x) => x.node.id + ":" + srcOf(x.node) + ":" + title(x.node)).join("|");
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (composing.current.active) { composePending.current = true; return; } // 组字中不重建胶囊
    const focused = document.activeElement === el; const sel = focused ? saveCaret(el) : null; paint(serialize(el)); if (sel) restoreCaret(el, sel);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // 胶囊不重建但字宽会变（窗口缩放、面板从隐藏变可见、字体晚到）：补量溢出
  useEffect(() => {
    const on = () => remeasure();
    window.addEventListener("resize", on);
    const el = ref.current; const ro = el && typeof ResizeObserver === "function" ? new ResizeObserver(on) : null;
    if (el && ro) ro.observe(el);
    void document.fonts.ready.then(on, () => undefined);
    return () => { window.removeEventListener("resize", on); ro?.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const caretToEnd = () => { const el = ref.current!; const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const tail = el.lastChild as HTMLElement | null; if (tail && tail.dataset?.tail) r.setStartBefore(tail); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); };
  const emit = (opts?: { mention?: boolean }) => {
    const el = ref.current!; const v = serialize(el);
    // 只剩空白/换行时交回空串：节点提示词不留下一个只有换行的值
    const out = v.trim() ? v : "";
    last.current = out; el.classList.toggle("empty", !out);
    propsRef.current.onChange(out, opts);
  };

  /** 光标前刚输入的「@」（行首或跟在空白 / 标点后面），弹出上游列表 */
  const atBeforeCaret = (): AtMark | null => {
    const s = getSelection(); if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const r = s.getRangeAt(0); const t = r.startContainer; if (t.nodeType !== 3 || !ref.current?.contains(t)) return null;
    const before = (t.nodeValue || "").slice(0, r.startOffset);
    if (!before.endsWith("@")) return null;
    return { text: t as Text, at: r.startOffset - 1 };
  };
  /* ---------- 键盘/输入法事件记录（?debugKeys=1） ---------- */
  useEffect(() => {
    if (!debugOn) return;
    const lines: string[] = [];
    const where = () => {
      const a = document.activeElement as HTMLElement | null; const el = ref.current;
      if (!a) return "NONE";
      const inEditor = !!el && (a === el || el.contains(a));
      return (inEditor ? "EDITOR" : a.tagName) + (a.id ? "#" + a.id : "") + (a.isContentEditable ? "[ce]" : "");
    };
    const push = (line: string) => { lines.push(line); while (lines.length > 12) lines.shift(); setDebugLines([...lines]); console.log("[keys]", line); };
    const onKey = (ev: KeyboardEvent) => {
      const base = "keydown key=" + ev.key + " code=" + ev.code + " composing=" + (ev.isComposing || ev.keyCode === 229) + " prevented=" + ev.defaultPrevented + " active=" + where();
      push(base);
      // capture 阶段 defaultPrevented 还是 false，微任务里再补一次真实值
      setTimeout(() => { const i = lines.lastIndexOf(base); if (i >= 0) { lines[i] = base.replace(/prevented=\w+/, "prevented=" + ev.defaultPrevented); setDebugLines([...lines]); } }, 0);
    };
    const onBefore = (ev: InputEvent) => push("beforeinput type=" + ev.inputType + " data=" + JSON.stringify(ev.data) + " composing=" + ev.isComposing + " active=" + where());
    const onStart = (ev: CompositionEvent) => push("compositionstart data=" + JSON.stringify(ev.data) + " active=" + where());
    const onUpdate = (ev: CompositionEvent) => push("compositionupdate data=" + JSON.stringify(ev.data) + " active=" + where());
    const onEnd = (ev: CompositionEvent) => push("compositionend data=" + JSON.stringify(ev.data) + " active=" + where());
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeinput", onBefore, true);
    window.addEventListener("compositionstart", onStart, true);
    window.addEventListener("compositionupdate", onUpdate, true);
    window.addEventListener("compositionend", onEnd, true);
    push("debug on · editor=" + (ref.current ? "ready" : "none"));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeinput", onBefore, true);
      window.removeEventListener("compositionstart", onStart, true);
      window.removeEventListener("compositionupdate", onUpdate, true);
      window.removeEventListener("compositionend", onEnd, true);
    };
  }, [debugOn]);
  /** 组字中直接改 DOM 会把组字文本回退/吞掉：先让浏览器把当前组字落成普通文本 */
  const commitComposing = () => {
    if (!composing.current.active) return "";
    const data = composing.current.data;
    try {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== ref.current && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) ae.blur();
      else document.execCommand("insertText", false, data);
    } catch { /* 输入法不支持 execCommand 就按原 caret 插入 */ }
    composing.current = { active: false, data: "" };
    return data;
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
    const el = ref.current!; const m = menu;
    commitComposing();
    setMenu(null); el.focus({ preventScroll: true });
    const r = document.createRange();
    const mk = m?.mark; const ok = mk && el.contains(mk.text) && (mk.text.nodeValue || "")[mk.at] === "@";
    if (ok) { r.setStart(mk!.text, mk!.at); r.setEnd(mk!.text, mk!.at + 1); r.deleteContents(); } else { r.selectNodeContents(el); r.collapse(false); }
    const chip = chipEl(id, section, true);
    // 先插胶囊、再插分隔空格，光标明确落在空格之后：不依赖 insertNode 后 range 停在哪个节点
    r.insertNode(chip);
    const sp = document.createTextNode("\u00a0");
    const after = document.createRange(); after.setStartAfter(chip); after.collapse(true);
    after.insertNode(sp);
    el.normalize();
    fitChip(chip); requestAnimationFrame(remeasure);
    placeAfter(sp);
    emit({ mention: true });
    // 下一帧再确认一次：有的输入法/浏览器会在同一帧把光标挪回组字处；用户已经开始打字就不动
    requestAnimationFrame(() => {
      if (!ref.current || document.activeElement !== ref.current || !sp.parentNode) return;
      const s = getSelection(); if (!s || !s.rangeCount || !s.isCollapsed) return;
      const a = s.anchorNode;
      if (a === ref.current || a === sp) placeAfter(sp);
    });
    setTimeout(() => el.querySelectorAll(".pm-in").forEach((c) => c.classList.remove("pm-in")), 260);
  };
  const insertText = (t: string) => {
    const el = ref.current!; const m = menu;
    commitComposing();
    setMenu(null); el.focus({ preventScroll: true });
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
    // 输入法组字中一律交给浏览器：这里 preventDefault / 删胶囊都会把组字首字母吞掉
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
  const onInput = (e: import("react").FormEvent<HTMLDivElement>) => {
    const el = ref.current!;
    // 输入法组字中不要 emit / 重画：换掉 DOM 会把组字里的首字母回退成小写或直接吞掉；组字结束的 input 会再走一遍
    if ((e.nativeEvent as InputEvent).isComposing) return;
    // 浏览器可能留下空的 <br> / 包了 <div>：统一按纯文本重画
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
  // 预览卡本身要能点：离开胶囊/卡片后延迟 180ms 再收，鼠标移进卡片就取消
  const cancelLeave = () => { if (leaveTimer.current) { window.clearTimeout(leaveTimer.current); leaveTimer.current = null; } };
  const clearPreview = () => { cancelLeave(); pinnedRef.current = false; setPinned(false); setHover(null); store.setUI({ hlEdge: null, hlNode: null }); };
  const scheduleLeave = () => {
    cancelLeave(); if (pinnedRef.current) return;
    leaveTimer.current = window.setTimeout(() => { leaveTimer.current = null; if (pinnedRef.current) return; setHover(null); store.setUI({ hlEdge: null, hlNode: null }); }, 180);
  };
  const pinPreview = () => { cancelLeave(); pinnedRef.current = true; setPinned(true); };
  const onMove = (e: React.PointerEvent) => {
    if (pinnedRef.current) return; // pin 住时不让别的胶囊把卡片换掉
    const c = chipOf(e.target);
    if (!c) { if (hover) scheduleLeave(); return; }
    if (hover && hover.id === c.dataset.ref && (hover.sec || "") === (c.dataset.sec || "")) { cancelLeave(); return; }
    const id = c.dataset.ref!; const edge = mentionIns.find((x) => x.node.id === id)?.edge.id || null;
    setHover({ id, sec: c.dataset.sec, rect: c.getBoundingClientRect() }); store.setUI({ hlNode: id, hlEdge: edge && !edge.startsWith("self:") ? edge : null });
  };
  const onLeave = () => { scheduleLeave(); };
  const onClick = (e: React.MouseEvent) => {
    const c = chipOf(e.target); if (!c) return;
    if ((e.target as Element).closest("[data-rm]")) {
      e.preventDefault(); const sp = c.nextSibling; const r = document.createRange(); r.setStartBefore(c); r.collapse(true);
      if (sp && sp.nodeType === 3 && /^[\u00a0 ]/.test(sp.nodeValue || "")) sp.nodeValue = (sp.nodeValue || "").slice(1);
      c.remove(); ref.current!.focus(); const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
      setHover(null); store.setUI({ hlEdge: null, hlNode: null }); emit(); propsRef.current.onCommit(serialize(ref.current!)); return;
    }
    if (c.classList.contains("off")) {
      const id = c.dataset.ref!;
      // 自引用没有连线可补：本节点当前没有结果，提示先出结果，别去连一条自己到自己的边
      if (id === node.id) { store.toast("本节点还没有结果：先点生成，再用 @ 引用自己的当前结果"); return; }
      if (connect(store, id, node.id, { select: false, quiet: true })) store.toast(`已重新连接「${title(store.node(id)!)}」`);
      return;
    }
    c.classList.remove("pick"); void c.offsetWidth; c.classList.add("pick");
  };
  const onDbl = (e: React.MouseEvent) => { const c = chipOf(e.target); if (c && store.node(c.dataset.ref!)) { e.preventDefault(); ctl.focusNode(c.dataset.ref!); } };
  useEffect(() => () => store.setUI({ hlEdge: null, hlNode: null }), [store]);
  // pin 住之后：Esc 或点卡片外部（capture 阶段，别误伤编辑器）关掉
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); clearPreview(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Element | null; if (t && typeof t.closest === "function" && t.closest("[data-pm-prev]")) return; clearPreview(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  }, [pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelLeave(), []);

  return <>
    <div id="gpPrompt" ref={ref} className={"pm-ed " + (className || "")} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
      data-placeholder={placeholder} spellCheck={false}
      onInput={onInput} onKeyDown={onKeyDown}
      onCompositionStart={() => { composing.current = { active: true, data: "" }; }}
      onCompositionUpdate={(e) => { composing.current = { active: true, data: e.data }; }}
      onCompositionEnd={(e) => {
        composing.current = { active: false, data: "" };
        const el = ref.current; if (!el) return;
        // 组字期间 onInput 全部被跳过；提交后 Chrome 有时不再补一个 input 事件 → value 不更新、.empty 摘不掉，
        // placeholder 就会和刚打出来的中文叠在一起。这里统一收尾一次（先按需重画，再 emit 同步状态）
        if (composePending.current) { composePending.current = false; const sel = saveCaret(el); paint(serialize(el)); if (sel) restoreCaret(el, sel); }
        emit();
        void e;
      }}
      onBlur={() => propsRef.current.onCommit(serialize(ref.current!))}
      onPaste={onPaste} onCopy={onCopy} onCut={(e) => { onCopy(e); if (!e.defaultPrevented) return; getSelection()?.getRangeAt(0).deleteContents(); emit(); }}
      onPointerMove={onMove} onPointerLeave={onLeave} onClick={onClick} onDoubleClick={onDbl} />
    {debugOn ? <div data-pm-debug style={{ position: "fixed", right: 16, bottom: 16, zIndex: 99999, maxWidth: 560, maxHeight: 260, overflow: "auto", padding: "8px 10px", borderRadius: 10, background: "rgba(0,0,0,.82)", color: "#fff", font: "10px/1.5 ui-monospace, Menlo, Consolas, monospace", whiteSpace: "pre-wrap", pointerEvents: "none", boxShadow: "0 8px 24px rgba(0,0,0,.35)" }}>{debugLines.join("\n") || "（等待键盘事件…）"}</div> : null}
    {menu ? createPortal(<MentionMenu key={menu.mark.at} node={node} ins={mentionIns} value={value} x={menu.x} y={menu.y} onPick={pick} onClose={() => closeMenu()} />, document.querySelector(".cn-root") || document.body) : null}
    {hover ? createPortal(<ChipPreview key={hover.id} id={hover.id} sec={hover.sec} rect={hover.rect} ins={mentionIns} onKeep={cancelLeave} onDrop={scheduleLeave} onPin={pinPreview} onClose={clearPreview} />, document.querySelector(".cn-root") || document.body) : null}
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
  /** 搜索框自己的输入法组字状态：组字中不拦键、不数字快选；点选前先结束组字再插胶囊 */
  const comp = useRef(false);
  const pickNow = (it: Item) => {
    if (comp.current) comp.current = false;
    onPick(it);
  };
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
    // 自引用（本节点当前结果）：搜索时用「本节点 / 当前图」也能搜到
    if (x.node.id === node.id ? hit("本节点", x.node.kind === "video" ? "当前视频" : "当前图", title(x.node)) : hit(title(x.node), "#" + (x.order + 1), typeLabel)) linked.push({ type: "node", key: x.node.id, node: x.node, ord: x.order + 1, used: used.has(x.node.id + "#") });
    if (x.node.kind === "text") Object.keys(sectionsOf(textOf(x.node))).forEach((k) => { if (hit(title(x.node) + k)) linked.push({ type: "node", key: x.node.id + "#" + k, node: x.node, section: k, ord: x.order + 1, used: used.has(x.node.id + "#" + k) }); });
  });
  // 自引用排最前面（和连接输入分开看），其余保持连接顺序
  const selfAt = linked.findIndex((x) => x.type === "node" && !x.section && x.node.id === node.id);
  if (selfAt > 0) linked.unshift(linked.splice(selfAt, 1)[0]);
  const inFolder = (f: string): Item[] => f === "fav" ? favs.filter((n) => hit(title(n))).map((n) => ({ type: "fav", key: "fav:" + n.id, node: n }))
    : node.kind === "audio" ? [] : els.filter((e) => e.kind === f && hit(e.name, e.desc)).map((e) => ({ type: "element", key: "el:" + e.id, el: e }));
  const folders = FOLDERS.filter((f) => f.always || inFolder(f.id).length);
  // 搜索时直接列出素材库里匹配的条目（不用一层层点进去）
  const lib: Item[] = folder ? inFolder(folder) : kw ? folders.flatMap((f) => inFolder(f.id)) : [];
  const flat: Item[] = folder ? lib : [...linked, ...lib];
  useEffect(() => { setHi(0); }, [q, folder]);
  useEffect(() => { box.current?.querySelector(".pm-it.hi")?.scrollIntoView({ block: "nearest" }); }, [hi]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 组字中一个键都不拦（Enter 是选词用的）；其余按键只拦导航键，其它放行给输入法
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (folder) setFolder(null); else onClose(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); if (flat.length) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); const it = flat[hi]; if (it) pickNow(it); return; }
  };
  // 输入序号快选：「1」「#2」直接选中已连接的第 N 个
  const onQ = (v: string) => {
    if (comp.current) { setQ(v); return; } // 组字里的数字不是在快选
    const m = /^#?(\d{1,2})$/.exec(v.trim());
    if (m && !folder) { const it = linked.find((x) => x.type === "node" && x.ord === +m[1] && !x.section); if (it) { pickNow(it); return; } }
    setQ(v);
  };
  let i = -1; const row = (it: Item) => { i++; const me = i; const on = me === hi; const common = { "data-mi": it.key, className: "pm-it" + (on ? " hi" : "") + (it.type === "node" && it.section ? " sub" : ""), onPointerEnter: () => setHi(me), // 别让按钮抢走编辑器焦点（否则选完后的第一个键会落到 body / 触发全局快捷键）
      onPointerDown: (ev: import("react").PointerEvent) => ev.preventDefault(), onClick: () => pickNow(it) };
    if (it.type === "node") {
      const self = it.node.id === node.id && !it.section;
      return <button key={it.key} {...common} data-self={self ? "1" : undefined}><MenuThumb node={it.node} /><span className="pm-nm">{self ? <>本节点 · {it.node.kind === "video" ? "当前视频" : "当前图"}</> : it.section ? <>{title(it.node)}<i> › </i>{it.section}</> : title(it.node)}</span>{it.used ? <Icon name="check" size="xs" /> : null}{self ? null : <span className="pm-k">#{it.ord}</span>}<span className="pm-ty"><Icon name={kindIconName(it.node.kind)} size="s" /></span></button>;
    }
    if (it.type === "fav") return <button key={it.key} {...common}><MenuThumb node={it.node} /><span className="pm-nm">{title(it.node)}</span><span className="pm-ty"><Icon name={kindIconName(it.node.kind)} size="s" /></span></button>;
    return <button key={it.key} {...common}><ElThumb el={it.el} /><span className="pm-nm">{it.el.name}</span><span className="pm-k">元素</span></button>;
  };
  return <div ref={box} className={"pm-menu" + (pos?.up ? " up" : "")} data-mention-menu style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }} onPointerDown={(e) => e.stopPropagation()}>
    <div className="pm-search">
      {folder ? <button className="pm-back" data-act="back" onClick={() => setFolder(null)} aria-label="返回"><Icon name="back" size="s" /></button> : <Icon name="search" size="s" />}
      <input ref={inp} placeholder={folder ? `搜索${FOLDERS.find((f) => f.id === folder)?.name || ""}` : "搜索"} value={q} onChange={(e) => onQ(e.target.value)} onKeyDown={onKey} spellCheck={false}
        onCompositionStart={() => { comp.current = true; }} onCompositionEnd={() => { comp.current = false; }} />
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
            : folders.map((f) => <button key={f.id} className="pm-it pm-fd" data-folder={f.id} onPointerDown={(ev) => ev.preventDefault()} onClick={() => { setFolder(f.id); setQ(""); }}><span className="pm-fic"><Icon name="folder" size="s" /></span><span className="pm-nm">{f.name}</span><span className="pm-k">{inFolder(f.id).length || ""}</span><Icon name="right" size="s" /></button>)}
        </> : null}
      </>}
    </div>
  </div>;
}
const kindIconName = kindIcon;
function MenuThumb({ node }: { node: CanvasNode }) {
  // 24px 的菜单格子只值一张缩略图：菜单里一次列十几个大图节点，原图会各解码几十 MB
  return <span className={"pm-mth k-" + node.kind}><ThumbImg src={srcOf(node)} width={24} fallback={<Icon name={kindIconName(node.kind)} size="xs" />} /></span>;
}
function ElThumb({ el }: { el: CanvasElement }) {
  return <span className="pm-mth"><ThumbImg src={el.refs[0] || ""} width={24} fallback={<Icon name="user" size="xs" />} /></span>;
}

/* ---------- 胶囊悬停预览 ---------- */
/** 紧凑卡最多 8 格（4 列 × 2 行），超出的收成最后一格「+N」；点它展开看全部 */
const PREV_CELLS = 8;
/** 小格右下角的类型标记 */
const PREV_KIND: Record<string, string> = { image: "图", video: "视频", audio: "音频", text: "文本", group: "分组" };

/** 容器（分组 / 堆叠）里的成员：children → doc.nodes，堆叠走 stackItems；普通分组按位置排（和请求里「图1、图2…」同序） */
function groupMembers(doc: CanvasDoc, node: CanvasNode): CanvasNode[] {
  const items = isStack(node) ? stackItems(doc, node) : (node.children || []).map((id) => doc.nodes.find((x) => x.id === id)).filter((x): x is CanvasNode => !!x);
  if (!isStack(node)) items.sort((a, b) => a.y - b.y || a.x - b.x);
  return items;
}

function PrevMember({ n, onOpen }: { n: CanvasNode; onOpen?: () => void }) {
  const label = n.kind === "group" ? (isStack(n) ? "堆叠" : "分组") : PREV_KIND[n.kind] || "";
  const inner = <>
    {srcOf(n) ? <ThumbImg src={srcOf(n)} width={72} fallback={<Icon name={n.kind === "group" ? "layers" : kindIcon(n.kind)} size="s" />} /> : <Icon name={n.kind === "group" ? "layers" : kindIcon(n.kind)} size="s" />}
    <i className="pm-pv-k">{label}</i>
  </>;
  const cls = "pm-pv-cell" + (n.kind === "video" ? " k-v" : "") + (onOpen ? " grp" : "");
  // 视频没有 frame 时 srcOf 为空：深色底 + 视频图标，不至于整格空白
  if (onOpen) return <button type="button" className={cls} title={"查看「" + title(n) + "」里的内容"} onClick={onOpen}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}

/** 分组 / 堆叠的聚合预览：成员网格；「+N」展开全部（6 列 + 内部滚动）；子分组可以点进去 */
function GroupPreview({ node, open, onOpen, onPin, onClose }: { node: CanvasNode; open: boolean; onOpen: () => void; onPin: () => void; onClose: () => void }) {
  const doc = useS((s) => s.doc);
  const [path, setPath] = useState<string[]>([node.id]); // 层级栈：最后一个才是当前层
  const cur = doc.nodes.find((x) => x.id === path[path.length - 1]) || node;
  const items = groupMembers(doc, cur);
  const cap = open ? items.length : PREV_CELLS;
  const shown = items.length > cap ? items.slice(0, cap - 1) : items;
  const more = items.length - shown.length;
  const names = path.map((id) => { const n = doc.nodes.find((x) => x.id === id); return n ? title(n) : "?"; });
  return <>
    <div className="pm-pv-h">
      {path.length > 1 ? <button type="button" className="pm-pv-back" title="返回上一级" aria-label="返回上一级" onClick={() => setPath(path.slice(0, -1))}><Icon name="back" size="xs" /></button> : null}
      <b>@{names.join(" / ")}</b><span>· {items.length} 个</span>
      {open ? <button type="button" className="pm-pv-collapse" title="收起" onClick={onClose}>收起</button> : null}
    </div>
    {items.length ? <div className={"pm-pv-grid" + (open ? " all" : "")}>
      {shown.map((m) => <PrevMember key={m.id} n={m} onOpen={m.kind === "group" ? () => setPath([...path, m.id]) : undefined} />)}
      {more > 0 ? <button type="button" className="pm-pv-more" title={"查看全部 " + items.length + " 个"} onClick={() => { onOpen(); onPin(); }}>+{more}</button> : null}
    </div> : <div className="pm-pv-empty">空分组</div>}
  </>;
}

function ChipPreview({ id, sec, rect, ins, onKeep, onDrop, onPin, onClose }: { id: string; sec?: string; rect: DOMRect; ins: InputRef[]; onKeep: () => void; onDrop: () => void; onPin: () => void; onClose: () => void }) {
  const ctl = useCtl(); const n = ctl.store.node(id); const u = n ? srcOf(n) : "";
  const [open, setOpen] = useState(false); // 展开：全部成员 + 6 列 + 内部滚动（层级之间共用）
  const box = useRef<HTMLDivElement>(null); const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 展开后卡片尺寸会变：用 ResizeObserver 重算位置（贴胶囊上方 / 顶部不够翻下方 / 左右 8px 内收 / 不出屏）
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width, h = entry.contentRect.height;
      setSize((p) => (Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5 ? p : { w, h }));
    });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return; const root = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() || new DOMRect(0, 0, innerWidth, innerHeight);
    const w = el.offsetWidth, h = el.offsetHeight; let top = rect.top - h - 8; if (top < 8) top = rect.bottom + 8;
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8)) - root.left;
    const t = top - root.top;
    setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - t) < 0.5 ? p : { left, top: t }));
  }, [rect, size]);
  if (!n) return null;
  const linked = ins.some((x) => x.node.id === id);
  const body = n.kind === "text" ? (sec ? sectionsOf(textOf(n))[sec] : textOf(n)) || "（空文本）" : "";
  const st = pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 };
  // 分组 / 堆叠：聚合卡（可点：+N 看全部、子分组点进去），鼠标移进卡片保持打开
  if (n.kind === "group") return <div ref={box} data-pm-prev className={"pm-prev card group" + (open ? " open" : "") + (linked ? "" : " off")} style={st}
    onPointerEnter={onKeep} onPointerLeave={onDrop} onPointerDown={(e) => e.stopPropagation()}>
    <GroupPreview node={n} open={open} onOpen={() => setOpen(true)} onPin={onPin} onClose={onClose} />
  </div>;
  // TapNow：图片 / 视频只给一张带描边的图；文本 / 音频是一张小卡片，底部居中「@名字」
  // 大预览在页面上最多显示 150×180：给 180 档（缩略图 512）就足够清晰，别为了一次悬停拉 2048 原图
  if (u) return <div ref={box} className={"pm-prev img" + (linked ? "" : " off")} style={st}><ThumbImg src={u} width={180} lazy={false} fallback={<div className="pm-pv-ic"><Icon name={kindIcon(n.kind)} /></div>} /></div>;
  return <div ref={box} className={"pm-prev card" + (linked ? "" : " off")} style={st}>
    {n.kind === "text" ? <p>{body.slice(0, 80)}</p> : <div className="pm-pv-ic"><Icon name={kindIcon(n.kind)} /></div>}
    <b>@{title(n)}{sec ? "·" + sec : ""}</b>
  </div>;
}
