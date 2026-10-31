/**
 * 文本节点全屏编辑（对齐 TapNow：双击文本节点 / 工具条「全屏」打开）。
 *   · 所见即所得：内容以富文本显示（一级 / 二级 / 三级标题、加粗、斜体、列表、分割线、引用、代码、表格）
 *   · 底部浮动格式栏：复制全部 | H1 H2 H3 正文 | 加粗 斜体 | 无序 有序列表 | 分割线
 *   · 左上角返回、点两侧空白、Esc 关闭；关闭时把内容转回 Markdown 存进节点（一步撤销）
 *   · 行首输入「# 」「## 」「- 」「1. 」「> 」「---」自动变成对应格式（同 TapNow 的 Markdown 快捷输入）
 * 节点里的数据始终是 Markdown 字符串，这里只在打开 / 关闭时做 Markdown ↔ HTML 转换。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commitText } from "../actions";
import { genOf, outOf } from "../model";
import { useCtl } from "./ctx";
import { Icon } from "./Icon";
import { markdownToHtml } from "./markdown";

/** Markdown → HTML：和节点里同一套解析 */
function mdToHtml(md: string): string { return markdownToHtml(md) || "<p><br></p>"; }

/** HTML → Markdown（只认编辑器里会出现的结构；其它标签按文字处理） */
function inlineMd(node: Node): string {
  let s = "";
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { s += (c.textContent || "").replace(/ /g, " "); return; }
    if (c.nodeType !== 1) return;
    const el = c as HTMLElement; const t = el.tagName; const inner = inlineMd(el);
    if (t === "BR") s += "\n";
    else if ((t === "STRONG" || t === "B") && inner.trim()) s += "**" + inner + "**";
    else if ((t === "EM" || t === "I") && inner.trim()) s += "*" + inner + "*";
    else if (t === "CODE") s += "`" + (el.textContent || "") + "`";
    else if ((t === "DEL" || t === "S" || t === "STRIKE") && inner.trim()) s += "~~" + inner + "~~";
    else if (t === "SPAN" && /font-weight:\s*(bold|[6-9]00)/.test(el.getAttribute("style") || "")) s += inner.trim() ? "**" + inner + "**" : inner;
    else s += inner;
  });
  return s;
}
const BLOCKS = "h1,h2,h3,h4,h5,h6,ul,ol,hr,blockquote,pre,table";
function htmlToMd(root: HTMLElement): string {
  const out: string[] = [];
  const block = (el: Element) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) { const txt = inlineMd(el).replace(/\n+/g, " ").trim(); if (txt) out.push("#".repeat(Math.min(3, Number(t[1]))) + " " + txt); return; }
    if (t === "UL" || t === "OL") {
      let i = Number((el as HTMLOListElement).start) || 1;
      const items: string[] = [];
      el.querySelectorAll(":scope > li").forEach((li) => { const txt = inlineMd(li).replace(/\n+/g, " ").trim(); items.push((t === "OL" ? i++ + ". " : "- ") + txt); });
      if (items.length) out.push(items.join("\n")); // 紧凑列表：项与项之间不空行
      return;
    }
    if (t === "HR") { out.push("---"); return; }
    if (t === "BLOCKQUOTE") { out.push(inlineMd(el).trim().split("\n").map((l) => "> " + l).join("\n")); return; }
    if (t === "PRE") { out.push("```\n" + (el.textContent || "").replace(/\n$/, "") + "\n```"); return; }
    if (t === "TABLE") {
      const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inlineMd(c).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()));
      if (rows.length) out.push(["| " + rows[0].join(" | ") + " |", "| " + rows[0].map(() => "---").join(" | ") + " |", ...rows.slice(1).map((r) => "| " + r.join(" | ") + " |")].join("\n"));
      return;
    }
    // 段落里混进了块级元素（浏览器编辑偶尔会产生 <p><ul>…</ul></p>）：按顺序拆开
    if ((t === "DIV" || t === "P") && el.querySelector(BLOCKS)) { container(el); return; }
    const txt = inlineMd(el).replace(/\n+$/, "");
    if (txt.trim()) out.push(txt);
  };
  const container = (host: Node) => {
    let run = document.createElement("span");
    const flush = () => { const txt = inlineMd(run).replace(/\n+$/, ""); if (txt.trim()) out.push(txt.trim()); run = document.createElement("span"); };
    [...host.childNodes].forEach((c) => {
      if (c.nodeType === 1 && (c as Element).matches(BLOCKS + ",p,div")) { flush(); block(c as Element); }
      else run.appendChild(c.cloneNode(true));
    });
    flush();
  };
  container(root);
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

type Fmt = { block: string; bold: boolean; italic: boolean; ul: boolean; ol: boolean };
const NONE: Fmt = { block: "p", bold: false, italic: false, ul: false, ol: false };

export function TextDocLayer() {
  const ctl = useCtl(); const store = ctl.store;
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { const on = (e: Event) => setId(String((e as CustomEvent).detail || "") || null); addEventListener("cn:textdoc", on); return () => removeEventListener("cn:textdoc", on); }, []);
  const n = id ? store.node(id) : null;
  if (!n || n.kind !== "text") return null;
  return <TextDoc key={n.id} id={n.id} initial={outOf(n)?.text || ""} title={genOf(n).title} onClose={(md) => { commitText(store, n.id, md); setId(null); }} onCopy={(md) => { void navigator.clipboard.writeText(md).then(() => store.toast("已复制全部内容"), () => store.toast("剪贴板不可用")); }} />;
}

function TextDoc({ initial, title, onClose, onCopy }: { id: string; initial: string; title: string; onClose: (md: string) => void; onCopy: (md: string) => void }) {
  const ed = useRef<HTMLDivElement>(null);
  const [fmt, setFmt] = useState<Fmt>(NONE);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    const el = ed.current; if (!el) return;
    el.innerHTML = initial.trim() ? mdToHtml(initial) : "<p><br></p>";
    el.focus();
    // 光标放到末尾
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r);
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* 旧内核 */ }
  }, [initial]);
  const md = () => (ed.current ? htmlToMd(ed.current) : initial);
  const close = () => { if (closing) return; setClosing(true); const v = md(); setTimeout(() => onClose(v), 140); };
  // Esc 快捷键：不依赖焦点在编辑器里（点过工具栏 / 遮罩后也能关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); close(); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });
  const refresh = () => {
    const sel = getSelection(); const el = ed.current; if (!sel || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    let b: Node | null = sel.anchorNode; let block = "p";
    while (b && b !== el) { if (b.nodeType === 1 && /^(H1|H2|H3|H4|P|LI|BLOCKQUOTE|PRE)$/.test((b as Element).tagName)) { block = (b as Element).tagName.toLowerCase(); break; } b = b.parentNode; }
    const inList = (tag: string) => { let x: Node | null = sel.anchorNode; while (x && x !== el) { if (x.nodeType === 1 && (x as Element).tagName === tag) return true; x = x.parentNode; } return false; };
    setFmt({ block, bold: inList("STRONG") || inList("B"), italic: inList("EM") || inList("I"), ul: inList("UL"), ol: inList("OL") });
  };
  useEffect(() => { const on = () => refresh(); document.addEventListener("selectionchange", on); return () => document.removeEventListener("selectionchange", on); });
  const run = (cmd: string, arg?: string) => { ed.current?.focus(); document.execCommand(cmd, false, arg); refresh(); };
  /** 当前光标所在的顶层块（编辑器的直接子元素）和列表项 */
  const where = () => {
    const el = ed.current; const sel = getSelection(); if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
    let n: Node | null = sel.anchorNode; let li: HTMLElement | null = null;
    while (n && n.parentNode !== el) { if (n.nodeType === 1 && (n as Element).tagName === "LI" && !li) li = n as HTMLElement; n = n.parentNode; }
    return n && n.nodeType === 1 ? { top: n as HTMLElement, li } : null;
  };
  const caretEnd = (node: Node) => { const r = document.createRange(); r.selectNodeContents(node); r.collapse(false); const s2 = getSelection(); s2?.removeAllRanges(); s2?.addRange(r); };
  /** 列表开关：段落 / 标题 → 列表；同类列表里再点 = 取消；异类列表 = 换类型（不依赖浏览器的 insertList，避免列表被套进 <p>） */
  const toggleList = (tag: "ul" | "ol") => {
    ed.current?.focus(); const w = where(); if (!w) return;
    const TAG = tag.toUpperCase();
    if (w.li && (w.top.tagName === "UL" || w.top.tagName === "OL")) {
      if (w.top.tagName !== TAG) { const nl = document.createElement(tag); while (w.top.firstChild) nl.appendChild(w.top.firstChild); w.top.replaceWith(nl); caretEnd(w.li); }
      else { // 取消：把这一项拿出来变段落，列表从这里断开
        const p = document.createElement("p"); while (w.li.firstChild) p.appendChild(w.li.firstChild); if (!p.childNodes.length) p.innerHTML = "<br>";
        const after = document.createElement(tag); let nx = w.li.nextSibling; while (nx) { const k = nx.nextSibling; after.appendChild(nx); nx = k; }
        w.li.remove(); w.top.after(p); if (after.childNodes.length) p.after(after); if (!w.top.childNodes.length) w.top.remove(); caretEnd(p);
      }
    } else {
      const list = document.createElement(tag); const li = document.createElement("li");
      while (w.top.firstChild) li.appendChild(w.top.firstChild); if (!li.childNodes.length) li.innerHTML = "<br>";
      list.appendChild(li); w.top.replaceWith(list); caretEnd(li);
    }
    refresh();
  };
  const setBlock = (tag: string) => {
    // 列表里切标题：先退出列表
    ed.current?.focus(); const w = where(); if (!w) return;
    if (w.li) toggleList(w.top.tagName === "OL" ? "ol" : "ul"); // 先把这一项从列表里拿出来
    const w2 = where(); if (!w2) return;
    if (w2.top.tagName.toLowerCase() === tag) { refresh(); return; }
    const nb = document.createElement(tag); while (w2.top.firstChild) nb.appendChild(w2.top.firstChild); if (!nb.childNodes.length) nb.innerHTML = "<br>";
    w2.top.replaceWith(nb); caretEnd(nb); refresh();
  };
  /** 行首 Markdown 快捷输入 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if ((e.metaKey || e.ctrlKey) && e.altKey && /^[0123]$/.test(e.key)) { e.preventDefault(); setBlock(e.key === "0" ? "p" : "h" + e.key); return; }
    if (e.key !== " " && e.key !== "Enter") return;
    const sel = getSelection(); if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== 3) return;
    const text = (sel.anchorNode.textContent || "").slice(0, sel.anchorOffset);
    const blockEl = sel.anchorNode.parentElement?.closest("p,div,h1,h2,h3,h4") as HTMLElement | null;
    if (!blockEl || blockEl === ed.current || (blockEl.textContent || "") !== (sel.anchorNode.textContent || "")) return;
    const rules: Array<[RegExp, string]> = e.key === " "
      ? [[/^###$/, "h3"], [/^##$/, "h2"], [/^#$/, "h1"], [/^[-*+]$/, "ul"], [/^1[.)]$/, "ol"], [/^>$/, "blockquote"]]
      : [[/^(-{3,}|\*{3,})$/, "hr"]];
    for (const [re, kind] of rules) {
      if (!re.test(text)) continue;
      e.preventDefault();
      // 把整段换成空的目标块，光标放进去（直接改 DOM，避免 execCommand 在空文本节点上丢光标）
      let caretIn: HTMLElement;
      if (kind === "ul" || kind === "ol") { const list = document.createElement(kind); const li = document.createElement("li"); li.innerHTML = "<br>"; list.appendChild(li); blockEl.replaceWith(list); caretIn = li; }
      else if (kind === "hr") { const hr = document.createElement("hr"); const p = document.createElement("p"); p.innerHTML = "<br>"; blockEl.replaceWith(hr, p); caretIn = p; }
      else { const h = document.createElement(kind); h.innerHTML = "<br>"; blockEl.replaceWith(h); caretIn = h; }
      const r = document.createRange(); r.setStart(caretIn, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
      refresh(); return;
    }
  };
  /** 粘贴：外部富文本只保留纯文字，Markdown 文本按格式展开 */
  const onPaste = (e: React.ClipboardEvent) => {
    const t = e.clipboardData.getData("text/plain"); if (!t) return;
    e.preventDefault();
    const looksMd = /(^|\n)(#{1,3}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|.*\|)/.test(t) || /\*\*[^*]+\*\*/.test(t);
    if (looksMd) document.execCommand("insertHTML", false, mdToHtml(t));
    else document.execCommand("insertText", false, t);
  };
  const B = (on: boolean, tip: string, act: () => void, child: React.ReactNode) => <button className={"tdb" + (on ? " on" : "")} data-tip={tip} aria-label={tip} onMouseDown={(e) => e.preventDefault()} onClick={act}>{child}</button>;
  /** 点遮罩关闭；点面板本身不关（拖选文字不会误关） */
  const onBackdrop = (e: React.PointerEvent) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); };
  return <div className="textdoc" style={closing ? { animation: "fadeOut 140ms var(--e-exit) forwards" } : undefined} onPointerDown={onBackdrop} onWheel={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    <div className="td-panel" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
    <div className="td-top"><button className="td-back" aria-label="返回" data-tip="返回画布" onClick={close}><Icon name="left" /></button><span className="td-title">{title}</span></div>
    <div className="td-scroll">
      <div ref={ed} className="td-ed md" contentEditable suppressContentEditableWarning spellCheck={false} data-ph="输入内容，行首输入 # 加空格变成标题" onKeyDown={onKeyDown} onKeyUp={refresh} onMouseUp={refresh} onPaste={onPaste} />
    </div>
    <div className="td-bar" onMouseDown={(e) => e.preventDefault()}>
      {B(false, "复制全部", () => onCopy(md()), <Icon name="copy" size="s" />)}
      <span className="td-sep" />
      {B(fmt.block === "h1", "标题 1", () => setBlock("h1"), <b className="hx">H<sub>1</sub></b>)}
      {B(fmt.block === "h2", "标题 2", () => setBlock("h2"), <b className="hx">H<sub>2</sub></b>)}
      {B(fmt.block === "h3", "标题 3", () => setBlock("h3"), <b className="hx">H<sub>3</sub></b>)}
      {B(fmt.block === "p" && !fmt.ul && !fmt.ol, "正文", () => setBlock("p"), <b className="hx">¶</b>)}
      <span className="td-sep" />
      {B(fmt.bold, "加粗 ⌘B", () => run("bold"), <b className="hx">B</b>)}
      {B(fmt.italic, "斜体 ⌘I", () => run("italic"), <i className="hx it">I</i>)}
      <span className="td-sep" />
      {B(fmt.ul, "无序列表", () => toggleList("ul"), <Icon name="list" size="s" />)}
      {B(fmt.ol, "有序列表", () => toggleList("ol"), <b className="hx ol">1.</b>)}
      <span className="td-sep" />
      {B(false, "分割线", () => run("insertHorizontalRule"), <b className="hx">—</b>)}
    </div>
    </div>
  </div>;
}

export { htmlToMd, mdToHtml };
