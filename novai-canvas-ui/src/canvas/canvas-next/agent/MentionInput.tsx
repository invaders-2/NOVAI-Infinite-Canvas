/**
 * 助手输入框的 @ 引用编辑器（contenteditable，参考 ui/PromptEditor.tsx 的胶囊做法，但不绑定节点/连线）。
 *   · 输入 @ 或 / 时把「触发字符」的位置记下来，外部打开选择面板；选中后删掉这个字符、在光标处插入胶囊；
 *   · 胶囊整块 contentEditable=false：退格 / Delete 整体删除，点 × 也能删；删除时回调 onRemove 让上层同步引用；
 *   · 序列化成纯文本时胶囊写成记号：节点 @{id}（与 mentions.ts 一致）、素材 @ref{id}、应用 @app{id}、技能 @skill{名}；
 *   · 输入法组字期间不重建 DOM；Enter 发送 / Shift+Enter 换行 / 粘贴纯文本 / 空态 placeholder 都保持可用。
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { useCtl } from "../ui/ctx";
import { ICON_PATHS, type IconName } from "../ui/Icon";
import { resolveMediaUrl } from "../ui/useAsset";
import { setChipThumb } from "../ui/thumb";

export type MentionKind = "node" | "ref" | "app" | "skill";
export type MentionChip = { kind: MentionKind; id: string; title: string; src?: string; icon?: IconName; badge?: string };
export type MentionInputHandle = {
  focus: () => void;
  /** 在触发字符处（没有就在光标处）插入一个引用胶囊 */
  insertMention: (chip: MentionChip) => void;
  /** 面板选了「不生成胶囊」的项（比如联网搜索）：只把触发字符删掉 */
  dropTrigger: () => void;
};
export type MentionInputProps = {
  value: string;
  placeholder: string;
  className?: string;
  id?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  onChange: (value: string) => void;
  /** Enter（不带 Shift）发送 */
  onEnter: () => void;
  onEscape?: () => void;
  /** 光标前刚打出 @ 或 /：外部据此打开选择面板 */
  onTrigger?: (ch: "@" | "/") => void;
  /** 已记录在 trigger.current 的触发字符被删掉 / 替换：上层据此关掉对应的面板（目前只对 / 回调） */
  onTriggerGone?: () => void;
  /** 记号 → 胶囊内容；拿不到时按「已移除」渲染 */
  resolve: (kind: MentionKind, id: string) => MentionChip | null;
  /** 胶囊被删（退格 / Delete / 点 ×）时同步上层引用 */
  onRemove?: (kind: MentionKind, id: string) => void;
  /** 悬停胶囊（chip 为 null 表示移开）；rect 是胶囊的屏幕矩形，用来定位预览卡 */
  onChipHover?: (chip: { kind: MentionKind; id: string } | null, rect?: DOMRect) => void;
};

/** 记号：@{节点id}（和 mentions.ts 一致） / @ref{素材id} / @app{工具名} / @skill{技能名} */
const TOKEN_RE = /@(ref|app|skill)?\{([^}\n]+)\}/g;
const TOKEN_SRC = TOKEN_RE.source;
export type ParsedToken = { kind: MentionKind; id: string; start: number; end: number; raw: string };

export const mentionTokenOf = (kind: MentionKind, id: string) => (kind === "node" ? "@{" + id + "}" : "@" + kind + "{" + id + "}");

export function parseMentionTokens(text: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  const re = new RegExp(TOKEN_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || "")))) out.push({ kind: (m[1] as MentionKind) || "node", id: m[2], start: m.index, end: m.index + m[0].length, raw: m[0] });
  return out;
}

/** 把某一处引用从文本里删掉（顶部胶囊被移除时用，保持两边一致） */
export function removeMentionTokens(text: string, kind: MentionKind, id: string): string {
  const raw = mentionTokenOf(kind, id).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return String(text || "").replace(new RegExp(raw, "g"), "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n");
}

/** 发送前还原成人话：节点 / 素材 / 应用 → 「@标题」，技能交给 context.skillName，不留在正文里 */
export function plainMentionText(text: string, resolve: (kind: MentionKind, id: string) => MentionChip | null): string {
  return parseMentionTokens(text).reduce((out, token) => {
    if (token.kind === "skill") return out.replace(token.raw, "");
    const chip = resolve(token.kind, token.id);
    return out.replace(token.raw, chip ? "@" + chip.title : "");
  }, String(text || "")).replace(/[ \t]{2,}/g, " ").trim();
}

const svgOf = (name: IconName) => '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || ICON_PATHS.x) + "</svg>";

type Trigger = { text: Text; at: number; ch: "@" | "/" };

/** 顶部 / 消息区的胶囊名字：超宽时加 .trunc，尾部用 mask 渐变淡出（这里只管测量，样式在 CSS 里） */
export function ChipLabel({ text, className = "pm-t" }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => el.classList.toggle("trunc", el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1);
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    void document.fonts?.ready.then(fit, () => undefined);
    return () => ro?.disconnect();
  }, [text]);
  return <span ref={ref} className={className}>{text}</span>;
}

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(function MentionInput(props, handleRef) {
  const { value, placeholder, className } = props;
  const store = useCtl().store;
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const trigger = useRef<Trigger | null>(null);
  /** 输入法组字状态：组字期间不重建胶囊 DOM */
  const composing = useRef<{ active: boolean; data: string }>({ active: false, data: "" });
  const composePending = useRef(false);

  const chipElement = (chip: MentionChip, fresh: boolean) => {
    const span = document.createElement("span");
    span.className = "pm-chip" + (fresh ? " pm-in" : "");
    span.contentEditable = "false";
    span.dataset.mk = chip.kind; span.dataset.mid = chip.id;
    const th = document.createElement("span"); th.className = "pm-th";
    if (chip.src) {
      // 胶囊只有 16px：用缩略图，别挂原图（见 setChipThumb）
      const fail = () => { th.innerHTML = svgOf(chip.icon || "layers"); };
      void resolveMediaUrl(store.backend, chip.src).then((u) => setChipThumb(th, u, fail), fail);
    } else th.innerHTML = svgOf(chip.icon || "layers");
    const x = document.createElement("span"); x.className = "pm-x"; x.dataset.rm = "1"; x.innerHTML = svgOf("x"); x.title = "删除引用";
    const lb = document.createElement("span"); lb.className = "pm-t"; lb.textContent = chip.title;
    span.title = chip.title; // 全名仍可在悬停 title 里看到
    span.append(th, x, lb);
    if (chip.badge) { const b = document.createElement("span"); b.className = "pm-n"; b.textContent = chip.badge; span.appendChild(b); }
    return span;
  };

  /** 名字比可用宽度长时加 .trunc：尾部用 mask 渐变淡出（和 PromptEditor 的 fitChip 同一手法） */
  const fitLabel = (label: HTMLElement) => label.classList.toggle("trunc", label.clientWidth > 0 && label.scrollWidth > label.clientWidth + 1);
  const remeasure = () => { ref.current?.querySelectorAll<HTMLElement>(".pm-chip .pm-t").forEach(fitLabel); };

  /* ---------- 纯文本 ⇄ DOM ---------- */
  const serialize = (root: HTMLElement) => {
    let out = "";
    const walk = (el: Node) => {
      el.childNodes.forEach((c) => {
        if (c.nodeType === 3) out += (c.nodeValue || "");
        else if (c instanceof HTMLElement) {
          if (c.dataset.mk && c.dataset.mid) out += mentionTokenOf(c.dataset.mk as MentionKind, c.dataset.mid);
          else if (c.tagName === "BR") { if (!c.dataset.tail) out += "\n"; }
          else if (c.tagName === "DIV" || c.tagName === "P") { if (out && !out.endsWith("\n")) out += "\n"; walk(c); }
          else walk(c);
        }
      });
    };
    walk(root);
    return out.replace(/\u00a0/g, " ");
  };
  const paint = (v: string) => {
    const el = ref.current; if (!el) return;
    el.innerHTML = "";
    const re = new RegExp(TOKEN_SRC, "g");
    const text = (s: string) => { const parts = s.split("\n"); parts.forEach((p, i) => { if (i) el.appendChild(document.createElement("br")); if (p) el.appendChild(document.createTextNode(p)); }); };
    let at = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      text(v.slice(at, m.index));
      const kind = (m[1] as MentionKind) || "node";
      el.appendChild(chipElement(propsRef.current.resolve(kind, m[2]) || { kind, id: m[2], title: "已移除" }, false));
      at = m.index + m[0].length;
    }
    text(v.slice(at));
    if (v.endsWith("\n")) { const br = document.createElement("br"); br.dataset.tail = "1"; el.appendChild(br); }
    el.classList.toggle("empty", !v.trim()); // 只剩换行也算空
    last.current = v;
    requestAnimationFrame(remeasure);
  };
  const caretToEnd = () => {
    const el = ref.current; if (!el) return;
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const tail = el.lastChild as HTMLElement | null; if (tail && tail.dataset && tail.dataset.tail) r.setStartBefore(tail);
    const s = getSelection(); if (!s) return; s.removeAllRanges(); s.addRange(r);
  };
  const emit = () => {
    const el = ref.current; if (!el) return;
    const v = serialize(el);
    const out = v.trim() ? v : ""; // 只有空白/换行也当空，别把空草稿写成换行
    last.current = out; el.classList.toggle("empty", !out);
    propsRef.current.onChange(out);
  };
  const placeAfter = (n: Node) => { const r = document.createRange(); r.setStartAfter(n); r.collapse(true); const s = getSelection(); if (!s) return; s.removeAllRanges(); s.addRange(r); };

  useLayoutEffect(() => {
    if (value === last.current) return;
    if (composing.current.active) { composePending.current = true; return; }
    paint(value);
    if (document.activeElement === ref.current) caretToEnd();
  }, [value]);

  /** 组字中直接改 DOM 会把组字文本回退/吞掉：先让浏览器把当前组字落成普通文本 */
  const commitComposing = () => {
    if (!composing.current.active) return;
    const data = composing.current.data;
    try { document.execCommand("insertText", false, data); } catch { /* 输入法不支持就按原 caret 插入 */ }
    composing.current = { active: false, data: "" };
  };

  const insertMention = (chip: MentionChip) => {
    const el = ref.current; if (!el) return;
    commitComposing();
    el.focus({ preventScroll: true });
    const t = trigger.current; trigger.current = null;
    const r = document.createRange();
    const ok = !!t && el.contains(t.text) && (t.text.nodeValue || "")[t.at] === t.ch;
    if (ok && t) { r.setStart(t.text, t.at); r.setEnd(t.text, t.at + 1); r.deleteContents(); }
    else { r.selectNodeContents(el); r.collapse(false); }
    const node = chipElement(chip, true);
    r.insertNode(node);
    const sp = document.createTextNode("\u00a0");
    const after = document.createRange(); after.setStartAfter(node); after.collapse(true); after.insertNode(sp);
    el.normalize();
    placeAfter(sp);
    emit();
    fitLabel(node.querySelector(".pm-t") as HTMLElement || node);
    setTimeout(() => el.querySelectorAll(".pm-in").forEach((c) => c.classList.remove("pm-in")), 260);
  };
  const dropTrigger = () => {
    const el = ref.current; const t = trigger.current; trigger.current = null;
    if (!el || !t || !el.contains(t.text) || (t.text.nodeValue || "")[t.at] !== t.ch) return;
    const r = document.createRange(); r.setStart(t.text, t.at); r.setEnd(t.text, t.at + 1); r.deleteContents();
    emit(); el.focus({ preventScroll: true });
  };

  useEffect(() => {
    const on = () => remeasure();
    window.addEventListener("resize", on);
    void document.fonts?.ready.then(on, () => undefined);
    return () => window.removeEventListener("resize", on);
  }, []);

  useImperativeHandle(handleRef, () => ({
    focus: () => { const el = ref.current; if (!el) return; el.focus({ preventScroll: true }); caretToEnd(); },
    insertMention,
    dropTrigger,
  }));

  /** 光标前刚打出的触发字符（行首或跟在空白后的 / 才算） */
  const detectTrigger = () => {
    const s = getSelection(); if (!s || !s.rangeCount || !s.isCollapsed) return;
    const r = s.getRangeAt(0); const t = r.startContainer;
    if (t.nodeType !== 3 || !ref.current?.contains(t)) return;
    const before = (t.nodeValue || "").slice(0, r.startOffset);
    if (before.endsWith("@")) { trigger.current = { text: t as Text, at: r.startOffset - 1, ch: "@" }; propsRef.current.onTrigger?.("@"); return; }
    // 斜杠：光标前刚输入的就是 /，不再要求行首或空格后（「帮我处理/」也要弹）；
    // 只排除网址/路径这类「:」「/」后面的斜杠（http://、a/b/），免得误触。
    if (before.endsWith("/")) {
      const prev = before[before.length - 2] || "";
      if (prev !== ":" && prev !== "/") {
        trigger.current = { text: t as Text, at: r.startOffset - 1, ch: "/" };
        propsRef.current.onTrigger?.("/");
      }
    }
  };

  const insertBreak = () => {
    const s = getSelection(); if (!s || !s.rangeCount) return;
    const r = s.getRangeAt(0); r.deleteContents();
    const br = document.createElement("br"); r.insertNode(br);
    const el = ref.current!;
    const lastBr = el.lastChild as HTMLElement | null;
    if (!br.nextSibling || (lastBr && lastBr === br)) { const tail = document.createElement("br"); tail.dataset.tail = "1"; el.appendChild(tail); }
    placeAfter(br);
  };

  /** 退格 / Delete 碰到胶囊：整体删掉；胶囊之间只剩一个字时也自己删（Chrome 会塞 <br>） */
  const deleteChip = (back: boolean): HTMLElement | null => {
    const root = ref.current!; const s = getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const r = s.getRangeAt(0); const c: Node = r.startContainer; const off = r.startOffset;
    const isChip = (n: Node | null | undefined): n is HTMLElement => !!n && n instanceof HTMLElement && !!n.dataset.mk && !!n.dataset.mid;
    const caretAt = (parent: Node, idx: number) => { const rr = document.createRange(); rr.setStart(parent, Math.max(0, Math.min(idx, parent.childNodes.length))); rr.collapse(true); s.removeAllRanges(); s.addRange(rr); };
    const idxOf = (n: Node) => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;
    if (c.nodeType === 3) {
      const t = c.nodeValue || "";
      const edge = back ? off === 0 : off === t.length;
      if (edge) { const sib = back ? c.previousSibling : c.nextSibling; if (isChip(sib)) { const i = idxOf(sib); sib.remove(); caretAt(root, i); return sib; } return null; }
      if (t.length === 1 && (isChip(c.previousSibling) || isChip(c.nextSibling))) { const i = idxOf(c); c.parentNode!.removeChild(c); caretAt(root, i); return null; }
      return null;
    }
    if (c === root) { const sib = back ? root.childNodes[off - 1] : root.childNodes[off]; if (isChip(sib)) { sib.remove(); caretAt(root, back ? off - 1 : off); return sib; } }
    return null;
  };

  const removeChipElement = (chip: HTMLElement) => {
    const kind = (chip.dataset.mk as MentionKind) || "node"; const id = chip.dataset.mid || "";
    const sp = chip.nextSibling;
    if (sp && sp.nodeType === 3 && /^[\u00a0 ]/.test(sp.nodeValue || "")) sp.nodeValue = (sp.nodeValue || "").slice(1);
    chip.remove();
    ref.current?.focus({ preventScroll: true });
    emit();
    propsRef.current.onRemove?.(kind, id);
  };

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    if ((e.nativeEvent as InputEvent).isComposing) return;
    emit();
    const el = ref.current!;
    // 记录过的触发字符还在不在（先算，下面 paint 重建 DOM 会换掉文本节点）
    const t = trigger.current;
    const alive = !t || (el.contains(t.text) && (t.text.nodeValue || "")[t.at] === t.ch);
    if (el.querySelector("div,p")) { paint(serialize(el)); caretToEnd(); }
    if (t && !alive) {
      trigger.current = null;
      if (t.ch === "/") propsRef.current.onTriggerGone?.();
    }
    detectTrigger();
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const chip = deleteChip(e.key === "Backspace");
      if (chip) { e.preventDefault(); propsRef.current.onRemove?.((chip.dataset.mk as MentionKind) || "node", chip.dataset.mid || ""); emit(); }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) { insertBreak(); emit(); } else propsRef.current.onEnter();
      return;
    }
    if (e.key === "Escape") propsRef.current.onEscape?.();
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault(); e.stopPropagation();
    const text = e.clipboardData.getData("text/plain"); if (!text) return;
    const s = getSelection(); if (!s || !s.rangeCount) return;
    const r = s.getRangeAt(0); r.deleteContents();
    if (new RegExp(TOKEN_SRC).test(text)) { const mark = document.createTextNode("\u2063"); r.insertNode(mark); const all = serialize(ref.current!); const parts = all.split("\u2063"); paint(parts[0] + text + (parts[1] || "")); caretToEnd(); emit(); return; }
    const tn = document.createTextNode(text); r.insertNode(tn); placeAfter(tn); emit();
  };
  /** 胶囊悬停：交给上层弹预览卡（划过不闪、移开延迟关） */
  const hoveredChip = useRef("");
  const handlePointerOver = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element | null;
    const chip = target && typeof target.closest === "function" ? target.closest(".pm-chip") as HTMLElement | null : null;
    if (!chip) return;
    const key = (chip.dataset.mk || "") + ":" + (chip.dataset.mid || "");
    if (hoveredChip.current === key) return;
    hoveredChip.current = key;
    propsRef.current.onChipHover?.({ kind: (chip.dataset.mk as MentionKind) || "node", id: chip.dataset.mid || "" }, chip.getBoundingClientRect());
  };
  const handlePointerOut = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element | null;
    const chip = target && typeof target.closest === "function" ? target.closest(".pm-chip") as HTMLElement | null : null;
    if (!chip) return;
    const to = e.relatedTarget as Node | null;
    if (to && chip.contains(to)) return;
    hoveredChip.current = "";
    propsRef.current.onChipHover?.(null);
  };

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as Element | null;
    const chip = target && typeof target.closest === "function" ? target.closest(".pm-chip") as HTMLElement | null : null;
    if (!chip) return;
    if (target && target.closest("[data-rm]")) { e.preventDefault(); removeChipElement(chip); }
  };

  return <div
    ref={ref}
    id={props.id}
    className={"pm-ed ap2-md" + (className ? " " + className : "")}
    contentEditable
    suppressContentEditableWarning
    role="textbox"
    aria-multiline="true"
    data-placeholder={placeholder}
    spellCheck={false}
    onInput={handleInput}
    onKeyDown={handleKeyDown}
    onCompositionStart={() => { composing.current = { active: true, data: "" }; }}
    onCompositionUpdate={(e) => { composing.current = { active: true, data: e.data }; }}
    onCompositionEnd={() => {
      composing.current = { active: false, data: "" };
      const el = ref.current; if (!el) return;
      // 组字提交后不一定再收到 input 事件：自己同步一次，否则 value 不更新、.empty 摘不掉
      if (composePending.current) { composePending.current = false; paint(serialize(el)); if (document.activeElement === el) caretToEnd(); }
      emit();
    }}
    onPaste={handlePaste}
    onClick={handleClick}
    onPointerOver={handlePointerOver}
    onPointerOut={handlePointerOut}
    onFocus={() => propsRef.current.onFocus?.()}
    onBlur={() => propsRef.current.onBlur?.()}
  />;
});
