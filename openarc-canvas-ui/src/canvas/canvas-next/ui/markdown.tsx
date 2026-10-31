/**
 * 文本节点的 Markdown 渲染（对齐 TapNow：模型返回 Markdown，节点里按富文本显示一级 / 二级 / 三级标题、加粗、列表、表格）。
 * 只生成 React 元素，不走 innerHTML；不认识的语法原样当文字。
 */
import type { ReactNode } from "react";

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: string[]; start: number }
  | { t: "table"; head: string[]; rows: string[][]; align: ("left" | "center" | "right" | null)[] }
  | { t: "quote"; text: string }
  | { t: "code"; text: string }
  | { t: "hr" };

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSep = (l: string) => isRow(l) && cells(l).every((c) => /^:?-{2,}:?$/.test(c));

export function parseMarkdown(src: string): Block[] {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^```/.test(l.trim())) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++; out.push({ t: "code", text: buf.join("\n") }); continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push({ t: "h", level: Math.min(h[1].length, 4), text: h[2].replace(/\s+#+\s*$/, "") }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push({ t: "hr" }); i++; continue; }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l); const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null)) as ("left" | "center" | "right" | null)[];
      i += 2; const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: "table", head, rows, align }); continue;
    }
    const li = /^\s*([-*+]|(\d+)[.)])\s+(.*)$/.exec(l);
    if (li) {
      const ordered = !!li[2]; const items: string[] = []; const start = ordered ? Number(li[2]) : 1;
      while (i < lines.length) {
        const m = /^\s*([-*+]|(\d+)[.)])\s+(.*)$/.exec(lines[i]);
        if (m && !!m[2] === ordered) { items.push(m[3]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
        break;
      }
      out.push({ t: ordered ? "ol" : "ul", items, start }); continue;
    }
    if (/^\s*>/.test(l)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", text: buf.join("\n") }); continue;
    }
    const buf: string[] = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))) buf.push(lines[i++]);
    out.push({ t: "p", text: buf.join("\n") });
  }
  return out;
}

/** 行内：**加粗** / *斜体* / `代码` / ~~删除线~~ */
export function inline(text: string, key = "i"): ReactNode[] {
  const res: ReactNode[] = []; const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;
  let last = 0; let m: RegExpExecArray | null; let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) res.push(text.slice(last, m.index));
    const k = key + "-" + n++;
    if (m[2] || m[3]) res.push(<strong key={k}>{inline(m[2] || m[3], k)}</strong>);
    else if (m[4]) res.push(<code key={k}>{m[4]}</code>);
    else if (m[5]) res.push(<del key={k}>{m[5]}</del>);
    else res.push(<em key={k}>{m[6] || m[7]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) res.push(text.slice(last));
  return res;
}

const lines = (text: string, key: string) => text.split("\n").flatMap((t, i) => (i ? [<br key={key + "br" + i} />, ...inline(t, key + i)] : inline(t, key + i)));

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={"md" + (className ? " " + className : "")}>
      {blocks.map((b, i) => {
        const k = "b" + i;
        switch (b.t) {
          case "h": { const H = (["h1", "h2", "h3", "h4"] as const)[b.level - 1]; return <H key={k}>{inline(b.text, k)}</H>; }
          case "p": return <p key={k}>{lines(b.text, k)}</p>;
          case "ul": return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, k + j)}</li>)}</ul>;
          case "ol": return <ol key={k} start={b.start}>{b.items.map((it, j) => <li key={j}>{inline(it, k + j)}</li>)}</ol>;
          case "quote": return <blockquote key={k}>{lines(b.text, k)}</blockquote>;
          case "code": return <pre key={k}><code>{b.text}</code></pre>;
          case "hr": return <hr key={k} />;
          case "table": return (
            <table key={k}>
              <thead><tr>{b.head.map((c, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(c, k + "h" + j)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, ri) => <tr key={ri}>{b.head.map((_, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(r[j] || "", k + ri + "-" + j)}</td>)}</tr>)}</tbody>
            </table>
          );
        }
        return null;
      })}
    </div>
  );
}

/** Markdown → HTML 字符串（全屏编辑器用；和 <Markdown> 同一套解析，内容全部转义） */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function inlineHtml(text: string): string {
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;
  let out = ""; let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    if (m[2] || m[3]) out += "<strong>" + inlineHtml(m[2] || m[3]) + "</strong>";
    else if (m[4]) out += "<code>" + esc(m[4]) + "</code>";
    else if (m[5]) out += "<del>" + inlineHtml(m[5]) + "</del>";
    else out += "<em>" + inlineHtml(m[6] || m[7]) + "</em>";
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
export function markdownToHtml(src: string): string {
  const lineHtml = (t: string) => t.split("\n").map(inlineHtml).join("<br>");
  return parseMarkdown(src).map((b) => {
    switch (b.t) {
      case "h": { const n = Math.min(b.level, 3); return `<h${n}>${inlineHtml(b.text)}</h${n}>`; }
      case "p": return `<p>${lineHtml(b.text)}</p>`;
      case "ul": return `<ul>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join("")}</ul>`;
      case "ol": return `<ol${b.start !== 1 ? ` start="${b.start}"` : ""}>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join("")}</ol>`;
      case "quote": return `<blockquote>${lineHtml(b.text)}</blockquote>`;
      case "code": return `<pre><code>${esc(b.text)}</code></pre>`;
      case "hr": return "<hr>";
      case "table": return `<table><thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${b.head.map((_, j) => `<td>${inlineHtml(r[j] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    return "";
  }).join("");
}

/** 生成中的文本节点：TapNow 用三条灰色骨架线（满 / 6 成 / 3 成） */
export function TextSkeleton() {
  return <div className="tsk"><i style={{ width: "100%" }} /><i style={{ width: "62%" }} /><i style={{ width: "30%" }} /></div>;
}
