/**
 * 文本节点全屏编辑（对齐 TapNow：双击文本节点 / 工具条「全屏」打开）。
 *   · 所见即所得：内容以富文本显示（一级—六级标题、加粗、斜体、列表、分隔线、引用、行内代码、代码块、链接、图片、表格）
 *   · 底部浮动格式栏：复制全部 | H1—H6 正文 | 加粗 斜体 | 无序 有序列表 | 引用 行内代码 代码块 | 链接 图片 表格 | 分割线
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
import { MOD_KEY } from "./shortcuts";

/** Markdown → HTML：和节点里同一套解析 */
function mdToHtml(md: string): string { return markdownToHtml(md) || "<p><br></p>"; }

/** HTML → Markdown（只认编辑器里会出现的结构；其它标签按文字处理） */
function inlineMd(node: Node): string {
  let s = "";
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { s += (c.textContent || "").replace(/\u200b/g, "").replace(/ /g, " "); return; }
    if (c.nodeType !== 1) return;
    const el = c as HTMLElement; const t = el.tagName; const inner = inlineMd(el);
    if (t === "BR") s += "\n";
    else if ((t === "STRONG" || t === "B") && inner.trim()) s += "**" + inner + "**";
    else if ((t === "EM" || t === "I") && inner.trim()) s += "*" + inner + "*";
    else if (t === "CODE") { const code = (el.textContent || "").replace(/\u200b/g, ""); if (code) s += "`" + code + "`"; }
    else if ((t === "DEL" || t === "S" || t === "STRIKE") && inner.trim()) s += "~~" + inner + "~~";
    else if (t === "A") { const href = el.getAttribute("href") || ""; s += href ? "[" + inner + "](" + href + ")" : inner; }
    else if (t === "IMG") s += "![" + (el.getAttribute("alt") || "") + "](" + (el.getAttribute("src") || "") + ")";
    else if (t === "SPAN" && /font-weight:\s*(bold|[6-9]00)/.test(el.getAttribute("style") || "")) s += inner.trim() ? "**" + inner + "**" : inner;
    else s += inner;
  });
  return s;
}
const BLOCKS = "h1,h2,h3,h4,h5,h6,ul,ol,hr,blockquote,pre,table";
function htmlToMd(root: HTMLElement): string {
  const out: string[] = [];
  /** 嵌套列表按缩进写回：只存同级会把层级拍平 */
  const listMd = (list: Element, depth: number): string => {
    const ordered = list.tagName === "OL";
    let n = Number((list as HTMLOListElement).start) || 1;
    const rows: string[] = [];
    [...list.children].filter((c) => c.tagName === "LI").forEach((li) => {
      const own = li.cloneNode(true) as HTMLElement;
      own.querySelectorAll(":scope > ul, :scope > ol").forEach((sub) => sub.remove());
      const txt = inlineMd(own).replace(/\n+/g, " ").trim();
      rows.push("  ".repeat(depth) + (ordered ? n++ + ". " : "- ") + txt);
      [...li.children].filter((c) => c.tagName === "UL" || c.tagName === "OL").forEach((sub) => rows.push(listMd(sub, depth + 1)));
    });
    return rows.join("\n");
  };
  const block = (el: Element) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) { const txt = inlineMd(el).replace(/\n+/g, " ").trim(); if (txt) out.push("#".repeat(Math.min(6, Number(t[1]))) + " " + txt); return; }
    if (t === "UL" || t === "OL") { const md = listMd(el, 0); if (md) out.push(md); return; }
    if (t === "HR") { out.push("---"); return; }
    if (t === "BLOCKQUOTE") { out.push(inlineMd(el).trim().split("\n").map((l) => "> " + l).join("\n")); return; }
    // 代码块用 innerText：浏览器偶尔在里面塞 <div>/<br>，textContent 会把换行吃掉
    if (t === "PRE") { const code = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\u200b/g, ""); if (code.trim()) out.push("```\n" + code.replace(/\n$/, "") + "\n```"); return; }
    if (t === "TABLE") {
      const trs = [...el.querySelectorAll("tr")];
      const rows = trs.map((tr) => [...tr.children].map((c) => inlineMd(c).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()));
      if (rows.length) {
        const alignOf = (c: Element) => {
          const a = (c.getAttribute("align") || (c as HTMLElement).style?.textAlign || "").toLowerCase();
          return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
        };
        const cols = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => Array.from({ length: cols }, (_, j) => r[j] ?? "");
        const sep = Array.from({ length: cols }, (_, j) => alignOf(trs[0]?.children[j] as Element) || "---");
        out.push(["| " + pad(rows[0]).join(" | ") + " |", "| " + sep.join(" | ") + " |", ...rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |")].join("\n"));
      }
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

type Fmt = { block: string; bold: boolean; italic: boolean; code: boolean; ul: boolean; ol: boolean };
const NONE: Fmt = { block: "p", bold: false, italic: false, code: false, ul: false, ol: false };

/** 链接 / 图片地址：桌面版（Electron / WKWebView）不实现 window.prompt，只能自己做一个小输入框 */
type Ask = { title: string; hint: string; value: string; ok: (v: string) => void };

export function TextDocLayer() {
  const ctl = useCtl(); const store = ctl.store;
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { const on = (e: Event) => setId(String((e as CustomEvent).detail || "") || null); addEventListener("cn:textdoc", on); return () => removeEventListener("cn:textdoc", on); }, []);
  const n = id ? store.node(id) : null;
  if (!n || n.kind !== "text") return null;
  const resize = (w: number, h: number) => store.updateNode(n.id, (x) => (x.w === w && x.h === h ? x : { ...x, w, h }));
  return <TextDoc key={n.id} id={n.id} initial={outOf(n)?.text || ""} title={genOf(n).title} w={n.w} h={n.h} onResize={resize} onClose={(md) => { commitText(store, n.id, md); setId(null); }} onCopy={(md) => { void navigator.clipboard.writeText(md).then(() => store.toast("已复制全部内容"), () => store.toast("剪贴板不可用")); }} />;
}

/** 宽高输入：失焦或回车才写入节点（避免边输入边被最小值夹住） */
function SizeField({ label, value, min, onCommit }: { label: string; value: number; min: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  const commit = () => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) { setV(String(value)); return; } onCommit(Math.max(min, Math.round(n))); };
  return <label className="td-size-f"><span>{label}</span><input type="number" min={min} step={10} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }} /></label>;
}

function TextDoc({ initial, title, w, h, onResize, onClose, onCopy }: { id: string; initial: string; title: string; w: number; h: number; onResize: (w: number, h: number) => void; onClose: (md: string) => void; onCopy: (md: string) => void }) {
  const ed = useRef<HTMLDivElement>(null);
  const [fmt, setFmt] = useState<Fmt>(NONE);
  const [closing, setClosing] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const askRange = useRef<Range | null>(null);
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (ask) closeAsk(); else close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });
  const refresh = () => {
    const sel = getSelection(); const el = ed.current; if (!sel || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    let b: Node | null = sel.anchorNode; let block = "p";
    while (b && b !== el) { if (b.nodeType === 1 && /^(H[1-6]|P|LI|BLOCKQUOTE|PRE)$/.test((b as Element).tagName)) { block = (b as Element).tagName.toLowerCase(); break; } b = b.parentNode; }
    const inList = (tag: string) => { let x: Node | null = sel.anchorNode; while (x && x !== el) { if (x.nodeType === 1 && (x as Element).tagName === tag) return true; x = x.parentNode; } return false; };
    setFmt({ block, bold: inList("STRONG") || inList("B"), italic: inList("EM") || inList("I"), code: inList("CODE") && !inList("PRE"), ul: inList("UL"), ol: inList("OL") });
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
  /** 选区必须落在编辑器里，否则工具栏操作会把光标吞到面板外 */
  const selRange = () => {
    const el = ed.current; const sel = getSelection();
    if (!el || !sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    return { sel, range };
  };
  const closestIn = (node: Node | null, tag: string) => {
    let x = node;
    while (x && x !== ed.current) { if (x.nodeType === 1 && (x as Element).tagName === tag) return x as HTMLElement; x = x.parentNode; }
    return null;
  };
  /** 弹输入框前把选区存下来：输入框一聚焦，contentEditable 的选区就没了 */
  const openAsk = (title: string, hint: string, value: string, ok: (v: string) => void) => {
    const cur = selRange(); if (!cur) return;
    askRange.current = cur.range.cloneRange();
    setAsk({ title, hint, value, ok });
  };
  const closeAsk = () => { setAsk(null); askRange.current = null; };
  const confirmAsk = (value: string) => {
    const cb = ask?.ok; const range = askRange.current;
    setAsk(null); askRange.current = null;
    if (!cb) return;
    ed.current?.focus();
    if (range) { const s = getSelection(); s?.removeAllRanges(); s?.addRange(range); }
    cb(value);
  };
  const selectInside = (node: Node, toEnd = false) => {
    const r = document.createRange(); r.selectNodeContents(node); if (toEnd) r.collapse(false);
    const s = getSelection(); s?.removeAllRanges(); s?.addRange(r);
  };
  /** 顶层块换成新块（内容搬过去），列表里先退出列表，避免块被套进 <li> */
  const swapBlock = (top: HTMLElement, tag: string) => {
    const nb = document.createElement(tag);
    while (top.firstChild) nb.appendChild(top.firstChild);
    if (!nb.childNodes.length) nb.innerHTML = "<br>";
    top.replaceWith(nb);
    return nb;
  };
  const insertRawText = (text: string) => {
    const cur = selRange(); if (!cur) return;
    const { sel, range } = cur;
    range.deleteContents();
    const tn = document.createTextNode(text);
    range.insertNode(tn);
    const r = document.createRange(); r.setStart(tn, text.length); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  };
  /** 引用块开关：标题 / 段落都能切过去，再点一次退回段落 */
  const toggleQuote = () => {
    ed.current?.focus(); const w = where(); if (!w) return;
    if (w.li) toggleList(w.top.tagName === "OL" ? "ol" : "ul");
    const w2 = where(); if (!w2) return;
    const top = w2.top;
    if (top.tagName !== "BLOCKQUOTE") { caretEnd(swapBlock(top, "blockquote")); refresh(); return; }
    // 取消引用：里面只有一个 <p> 就摊平它，避免 <p> 套 <p>
    const only = top.children.length === 1 && top.firstElementChild;
    if (only && only.tagName === "P") { top.replaceWith(only); caretEnd(only); }
    else caretEnd(swapBlock(top, "p"));
    refresh();
  };
  /** 行内代码：有选区包住，没选区插空 <code> 把光标放进去（不用 execCommand） */
  const toggleCode = () => {
    const cur = selRange(); if (!cur) return;
    const { sel, range } = cur;
    const host = closestIn(range.commonAncestorContainer, "CODE");
    if (host) {
      const parent = host.parentNode; if (!parent) return;
      const tail = host.lastChild;
      while (host.firstChild) parent.insertBefore(host.firstChild, host);
      host.remove();
      const r = document.createRange();
      if (tail) { r.setStartAfter(tail); r.collapse(true); } else { r.setStart(parent, Math.min(range.startOffset, parent.childNodes.length)); r.collapse(true); }
      sel.removeAllRanges(); sel.addRange(r);
    } else {
      const code = document.createElement("code");
      if (!range.collapsed) { code.appendChild(range.extractContents()); range.insertNode(code); selectInside(code); }
      else {
        // 空的 <code> 没有文本节点，光标落不进去（Chrome 会把字打在它后面）：先塞一个零宽字符占位，保存时剥掉
        const zw = document.createTextNode("\u200b");
        code.appendChild(zw); range.insertNode(code);
        const r = document.createRange(); r.setStart(zw, 1); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
      }
    }
    refresh();
  };
  const safeHref = (raw: string) => {
    const t = raw.trim();
    if (!t) return "";
    if (/^(?:javascript|vbscript|data:text\/html)/i.test(t)) return "";
    if (/^(?:https?:|mailto:|tel:|\/|#|\.{1,2}\/)/i.test(t)) return t;
    return /^[\w-]+(?:\.[\w-]+)+(?:[/?#].*)?$/.test(t) ? "https://" + t : "";
  };
  const applyLink = (raw: string) => {
    const href = safeHref(raw);
    if (!href) return;
    const cur = selRange(); if (!cur) return;
    const { sel, range } = cur;
    const host = closestIn(range.commonAncestorContainer, "A");
    if (host) { host.setAttribute("href", href); host.setAttribute("target", "_blank"); host.setAttribute("rel", "noreferrer"); refresh(); return; }
    const a = document.createElement("a");
    a.setAttribute("href", href); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noreferrer");
    if (!range.collapsed) {
      a.appendChild(range.extractContents()); range.insertNode(a);
      const r = document.createRange(); r.setStartAfter(a); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
    } else {
      a.textContent = "链接文字"; range.insertNode(a); selectInside(a);
    }
    refresh();
  };
  const insertLink = () => {
    const cur = selRange(); if (!cur) return;
    const host = closestIn(cur.range.commonAncestorContainer, "A");
    openAsk("链接地址", "https://example.com 或 /static/… 或 #锚点", host?.getAttribute("href") || "https://", applyLink);
  };
  const safeImg = (raw: string) => {
    const t = raw.trim();
    if (!t) return "";
    if (/^(?:javascript|vbscript|data:(?!image\/))/i.test(t)) return "";
    if (/^(?:https?:|data:image\/|\/|\.{1,2}\/)/i.test(t)) return t;
    return /^[\w./-]+$/.test(t) ? t : "";
  };
  const applyImage = (raw: string) => {
    const src = safeImg(raw);
    if (!src) return;
    const cur = selRange(); if (!cur) return;
    const img = document.createElement("img");
    img.setAttribute("src", src); img.setAttribute("alt", "");
    const { sel, range } = cur;
    range.deleteContents(); range.insertNode(img);
    const p = img.parentElement;
    // 段落里只剩图片时补个 <br>：否则光标无处可落，也没法继续换行
    if (p && p !== ed.current && !(p.textContent || "").trim() && !p.querySelector("br")) p.appendChild(document.createElement("br"));
    const r = document.createRange(); r.setStartAfter(img); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    refresh();
  };
  const insertImage = () => openAsk("图片地址", "/static/… 或 http(s):// 或 data:image/…", "/static/", applyImage);
  /** 表格后面总要留一个可继续输入的段落，否则光标会卡在表格里 */
  const afterBlock = (node: HTMLElement) => {
    const p = document.createElement("p"); p.innerHTML = "<br>"; node.after(p); return p;
  };
  const placeBlock = (node: HTMLElement) => {
    const top = where()?.top ?? null;
    if (top && top.tagName === "P" && !(top.textContent || "").trim()) top.replaceWith(node);
    else if (top) top.after(node);
    else ed.current?.appendChild(node);
  };
  const insertCodeBlock = () => {
    ed.current?.focus();
    const w = where();
    const cur = selRange();
    const text = cur && !cur.range.collapsed ? cur.range.toString() : "";
    if (text && cur) cur.range.deleteContents();
    if (w?.li) toggleList(w.top.tagName === "OL" ? "ol" : "ul");
    const pre = document.createElement("pre"); const code = document.createElement("code");
    const zw = text ? null : document.createTextNode("\u200b");
    if (text) code.textContent = text; else if (zw) code.appendChild(zw);
    pre.appendChild(code);
    placeBlock(pre); afterBlock(pre);
    if (text) { const r = document.createRange(); r.selectNodeContents(code); r.collapse(false); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    else if (zw) { const r = document.createRange(); r.setStart(zw, 1); r.collapse(true); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    refresh();
  };
  const insertTable = () => {
    ed.current?.focus();
    const w = where();
    if (w?.li) toggleList(w.top.tagName === "OL" ? "ol" : "ul");
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th><br></th><th><br></th></tr></thead><tbody><tr><td><br></td><td><br></td></tr></tbody>";
    placeBlock(table); afterBlock(table);
    const cell = table.querySelector("th");
    if (cell) { const r = document.createRange(); r.setStart(cell, 0); r.collapse(true); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    refresh();
  };
  /** 行首 Markdown 快捷输入 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if ((e.metaKey || e.ctrlKey) && e.altKey && /^[0-6]$/.test(e.key)) { e.preventDefault(); setBlock(e.key === "0" ? "p" : "h" + e.key); return; }
    if (e.key === "Enter") {
      const cur = selRange();
      const pre = cur ? closestIn(cur.range.commonAncestorContainer, "PRE") : null;
      if (pre && cur) {
        e.preventDefault();
        const { sel, range } = cur;
        // 末尾（或空块）回车 = 退出代码块；中间 / Shift+Enter 补一个真正的 \n，别让浏览器塞 <div> 把换行吃掉
        const tail = range.cloneRange(); tail.selectNodeContents(pre); tail.setStart(range.endContainer, range.endOffset);
        const atEnd = !tail.toString().replace(/\u200b/g, "").trim();
        const empty = !(pre.textContent || "").replace(/\u200b/g, "").trim();
        if (empty || (atEnd && !e.shiftKey)) {
          const p = document.createElement("p"); p.innerHTML = "<br>";
          if (empty) pre.replaceWith(p); else pre.after(p);
          const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
        } else insertRawText("\n");
        refresh();
        return;
      }
    }
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
    <div className="td-top"><button className="td-back" aria-label="返回" data-tip="返回画布" onClick={close}><Icon name="left" /></button><span className="td-title">{title}</span><div className="td-size"><SizeField label="宽" value={w} min={120} onCommit={(v) => onResize(v, h)} /><SizeField label="高" value={h} min={80} onCommit={(v) => onResize(w, v)} /></div></div>
    <div className="td-scroll">
      <div ref={ed} className="td-ed md" contentEditable suppressContentEditableWarning spellCheck={false} data-ph="输入内容，行首输入 # 加空格变成标题" onKeyDown={onKeyDown} onKeyUp={refresh} onMouseUp={refresh} onPaste={onPaste} />
    </div>
    <div className="td-bar" onMouseDown={(e) => e.preventDefault()}>
      {B(false, "复制全部", () => onCopy(md()), <Icon name="copy" size="s" />)}
      <span className="td-sep" />
      {B(fmt.block === "h1", "标题 1", () => setBlock("h1"), <b className="hx">H<sub>1</sub></b>)}
      {B(fmt.block === "h2", "标题 2", () => setBlock("h2"), <b className="hx">H<sub>2</sub></b>)}
      {B(fmt.block === "h3", "标题 3", () => setBlock("h3"), <b className="hx">H<sub>3</sub></b>)}
      {B(fmt.block === "h4", "标题 4", () => setBlock("h4"), <b className="hx">H<sub>4</sub></b>)}
      {B(fmt.block === "h5", "标题 5", () => setBlock("h5"), <b className="hx">H<sub>5</sub></b>)}
      {B(fmt.block === "h6", "标题 6", () => setBlock("h6"), <b className="hx">H<sub>6</sub></b>)}
      {B(fmt.block === "p" && !fmt.ul && !fmt.ol, "正文", () => setBlock("p"), <b className="hx">¶</b>)}
      <span className="td-sep" />
      {B(fmt.bold, "加粗 " + MOD_KEY + "B", () => run("bold"), <b className="hx">B</b>)}
      {B(fmt.italic, "斜体 " + MOD_KEY + "I", () => run("italic"), <i className="hx it">I</i>)}
      <span className="td-sep" />
      {B(fmt.ul, "无序列表", () => toggleList("ul"), <Icon name="list" size="s" />)}
      {B(fmt.ol, "有序列表", () => toggleList("ol"), <b className="hx ol">1.</b>)}
      <span className="td-sep" />
      {B(fmt.block === "blockquote", "引用块", toggleQuote, <b className="hx q">“</b>)}
      {B(fmt.code, "行内代码", toggleCode, <b className="hx code">{"</>"}</b>)}
      {B(false, "代码块", insertCodeBlock, <b className="hx pre">{"{ }"}</b>)}
      <span className="td-sep" />
      {B(false, "插入链接", insertLink, <Icon name="link" size="s" />)}
      {B(false, "插入图片", insertImage, <Icon name="image" size="s" />)}
      {B(false, "插入表格", insertTable, <Icon name="grid" size="s" />)}
      <span className="td-sep" />
      {B(false, "分割线", () => run("insertHorizontalRule"), <b className="hx">—</b>)}
    </div>
    {ask ? <div className="td-ask" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) closeAsk(); }}>
      <div className="td-ask-card" role="dialog" aria-modal="true" aria-label={ask.title}>
        <div className="td-ask-t">{ask.title}</div>
        <input className="td-ask-i" autoFocus value={ask.value} placeholder={ask.hint} spellCheck={false}
          onChange={(e) => setAsk({ ...ask, value: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); confirmAsk(ask.value); }
            else if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
          }} />
        <div className="td-ask-b">
          <button type="button" onClick={closeAsk}>取消</button>
          <button type="button" className="primary" onClick={() => confirmAsk(ask.value)}>确定</button>
        </div>
      </div>
    </div> : null}
    </div>
  </div>;
}

export { htmlToMd, mdToHtml };
