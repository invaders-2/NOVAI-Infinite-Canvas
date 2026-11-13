/**
 * Markdown 显示走 streamdown（GFM、流式补齐、数学公式、表格 / 代码块工具、外链安全），
 * 全屏编辑器的 contentEditable 需要 HTML 字符串，仍用下面同一套块级解析生成。
 */
import { useEffect } from "react";
import { createMathPlugin } from "@streamdown/math";
import { defaultRehypePlugins, Streamdown, type ControlsConfig, type StreamdownTranslations } from "streamdown";
import { padCjkEmphasis } from "./markdownCjk";
import "katex/dist/katex.min.css";

type Align = "left" | "center" | "right" | null;
type ListItem = { text: string; children: ListBlock[] };
type ListBlock = { t: "ul" | "ol"; items: ListItem[]; start: number };
type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | ListBlock
  | { t: "table"; head: string[]; rows: string[][]; align: Align[] }
  | { t: "quote"; text: string }
  | { t: "code"; text: string }
  | { t: "hr" };

const LI_RE = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/;
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
/** 按未转义的竖线切单元格：表格里的转义竖线是内容，不是列边界 */
const splitRow = (l: string): string[] => {
  const s = l.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = []; let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
};
/** GFM 允许单个 - 做分隔符（| - |），旧规则要求两个 - 才识别 */
const isSep = (l: string) => isRow(l) && splitRow(l).every((c) => /^:?-+:?$/.test(c));
const alignOf = (c: string): Align => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);

/**
 * 有些模型会把整篇回答（策划案之类）用一个没有语言标记的围栏包起来，照常渲染就是一个巨大的代码块。
 * 只有「整段就是这一个围栏块、且围栏没有语言标记」时才拆栏，交给普通 Markdown 解析；
 * 有语言标记（```ts）、围栏在正文中间、多个围栏、空内容都原样返回。
 * 流式时结束围栏还没生成：后面不再出现围栏就当成「整段被包住还没写完」，同样拆掉，
 * 否则前半段会先显示成代码块、写完再跳变成标题列表。有语言标记的未闭合围栏仍然不拆。
 */
export function unwrapWholeFence(src: string): string {
  const text = String(src || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return src;
  const lines = text.split("\n");
  const open = /^(```|~~~)$/.exec(lines[0].trim());
  if (!open) return src;
  const fence = open[1];
  const isFence = (l: string) => /^(```|~~~)/.test(l.trim());
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === fence) { close = i; break; }
  }
  let inner: string | null = null;
  if (close >= 0) {
    // 结束围栏之后还有内容 → 不止这一个围栏块，不动
    if (!lines.slice(close + 1).join("\n").trim()) inner = lines.slice(1, close).join("\n");
  } else if (!lines.slice(1).some(isFence)) {
    inner = lines.slice(1).join("\n");
  }
  if (inner === null || !inner.trim()) return src;
  return inner.replace(/^\n+/, "").trimEnd();
}

/** 缩进嵌套的列表：同一缩进是一级，更深的缩进取上一层最后一项的子列表 */
function readList(lines: string[], from: number, indent: number): { block: ListBlock; next: number } {
  const first = LI_RE.exec(lines[from]);
  const ordered = !!first?.[3];
  const start = ordered ? Number(first?.[3]) : 1;
  const items: ListItem[] = [];
  let i = from;
  while (i < lines.length) {
    const m = LI_RE.exec(lines[i]);
    if (m) {
      const ind = m[1].length;
      if (ind < indent) break;
      if (ind > indent) {
        if (!items.length) break;
        const sub = readList(lines, i, ind);
        items[items.length - 1].children.push(sub.block);
        i = sub.next;
        continue;
      }
      if (!!m[3] !== ordered) break;
      items.push({ text: m[4], children: [] });
      i++;
      continue;
    }
    if (items.length && lines[i].trim() && /^\s+/.test(lines[i])) {
      items[items.length - 1].text += " " + lines[i].trim();
      i++;
      continue;
    }
    break;
  }
  return { block: { t: ordered ? "ol" : "ul", items, start }, next: i };
}

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
    if (h) { out.push({ t: "h", level: h[1].length, text: h[2].replace(/\s+#+\s*$/, "") }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push({ t: "hr" }); i++; continue; }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = splitRow(l);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2; const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) rows.push(splitRow(lines[i++]));
      out.push({ t: "table", head, rows, align }); continue;
    }
    const li = LI_RE.exec(l);
    if (li) { const r = readList(lines, i, li[1].length); out.push(r.block); i = r.next; continue; }
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

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** 只放行 http(s) / mailto / 相对地址；javascript: 之类的协议直接当文字，不拼进标签 */
const safeUrl = (u: string) => {
  const t = u.trim();
  if (!t) return "";
  if (/^(?:javascript|vbscript|data:text\/html)/i.test(t)) return "";
  return t;
};

/**
 * 行内：图片 / 链接 / 裸 URL / 加粗 / 斜体 / 代码 / 删除线。先匹配出片段再拼标签，文字段全部转义。
 * 下划线强调带词界：a_b_c 是标识符，不能变斜体。
 */
const INLINE_RE = new RegExp(
  [
    "`(?<code>[^`]+)`",
    "!\\[(?<alt>[^\\]]*)\\]\\((?<imgsrc>[^)\\s]+)\\)",
    "\\[(?<label>[^\\]]+)\\]\\((?<href>[^)\\s]+)\\)",
    "\\*\\*(?<bold>[^*]+)\\*\\*",
    "__(?<bold2>[^_]+)__",
    "~~(?<del>[^~]+)~~",
    "\\*(?<em>[^*\\s][^*]*)\\*",
    "(?<![\\p{L}\\p{N}])_(?<em2>[^_\\s][^_]*)_(?![\\p{L}\\p{N}])",
    "(?<url>(?:https?:\\/\\/|www\\.)[^\\s<>()]+)",
  ].join("|"),
  "gu",
);

export function inlineHtml(text: string): string {
  let out = ""; let last = 0; let m: RegExpExecArray | null;
  // 每次调用独立一份：递归处理链接文字 / 强调文字时不能共用 lastIndex
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const g = m.groups || {};
    if (g.code) out += "<code>" + esc(g.code) + "</code>";
    else if (g.alt !== undefined) {
      const src = safeUrl(g.imgsrc || "");
      out += src ? '<img src="' + esc(src) + '" alt="' + esc(g.alt) + '">' : esc(g.alt);
    } else if (g.label) {
      const href = safeUrl(g.href || "");
      out += href ? '<a href="' + esc(href) + '" target="_blank" rel="noreferrer">' + inlineHtml(g.label) + "</a>" : inlineHtml(g.label);
    } else if (g.bold) out += "<strong>" + inlineHtml(g.bold) + "</strong>";
    else if (g.bold2) out += "<strong>" + inlineHtml(g.bold2) + "</strong>";
    else if (g.del) out += "<del>" + inlineHtml(g.del) + "</del>";
    else if (g.em) out += "<em>" + inlineHtml(g.em) + "</em>";
    else if (g.em2) out += "<em>" + inlineHtml(g.em2) + "</em>";
    else if (g.url) {
      // 句末标点不属于 URL
      const tail = /[.,;:!?。，；：！？]+$/.exec(g.url)?.[0] || "";
      const raw = tail ? g.url.slice(0, -tail.length) : g.url;
      const href = safeUrl(/^www\./i.test(raw) ? "https://" + raw : raw);
      out += href ? '<a href="' + esc(href) + '" target="_blank" rel="noreferrer">' + esc(raw) + "</a>" + esc(tail) : esc(g.url);
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const listHtml = (b: ListBlock): string => {
  const items = b.items.map((it) => "<li>" + inlineHtml(it.text) + it.children.map(listHtml).join("") + "</li>").join("");
  return b.t === "ol" ? '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : "") + ">" + items + "</ol>" : "<ul>" + items + "</ul>";
};
const cellHtml = (tag: "th" | "td", text: string, align: Align) =>
  "<" + tag + (align ? ' style="text-align:' + align + '"' : "") + ">" + inlineHtml(text) + "</" + tag + ">";

/** Markdown → HTML 字符串（全屏编辑器用；和 <Markdown> 同一套块级解析，内容全部转义） */
export function markdownToHtml(src: string): string {
  const lineHtml = (t: string) => t.split("\n").map(inlineHtml).join("<br>");
  return parseMarkdown(unwrapWholeFence(src)).map((b) => {
    switch (b.t) {
      case "h": return "<h" + b.level + ">" + inlineHtml(b.text) + "</h" + b.level + ">";
      case "p": return "<p>" + lineHtml(b.text) + "</p>";
      case "ul":
      case "ol": return listHtml(b);
      case "quote": return "<blockquote>" + lineHtml(b.text) + "</blockquote>";
      case "code": return "<pre><code>" + esc(b.text) + "</code></pre>";
      case "hr": return "<hr>";
      case "table": {
        // 和显示端 padTables 同一套规则：表宽只认表头 / 分隔行，数据行多出的单元格并进最后一列
        const cols = Math.max(b.head.length, b.align.length, 1);
        const cell = (tag: "th" | "td", text: string, j: number) => cellHtml(tag, text, b.align[j] ?? null);
        const fit = (r: string[]) => (r.length > cols ? [...r.slice(0, cols - 1), r.slice(cols - 1).join(" · ")] : r);
        const head = Array.from({ length: cols }, (_, j) => cell("th", b.head[j] ?? "", j)).join("");
        const rows = b.rows.map((r) => { const c = fit(r); return "<tr>" + Array.from({ length: cols }, (_, j) => cell("td", c[j] ?? "", j)).join("") + "</tr>"; }).join("");
        return "<table><thead><tr>" + head + "</tr></thead><tbody>" + rows + "</tbody></table>";
      }
    }
    return "";
  }).join("");
}

/**
 * streamdown 的 GFM 解析按表头列数裁行，数据行多出的单元格会被直接丢掉。
 * 表宽只认表头 / 分隔行：多出来的单元格并进最后一列（「 · 」分隔），
 * 既不会凭空多出一列空表头，也不丢任何文字。
 */
function padTables(src: string): string {
  const lines = src.split("\n");
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !isRow(lines[i]) || i + 1 >= lines.length || !isSep(lines[i + 1])) continue;
    const head = splitRow(lines[i]); const sep = splitRow(lines[i + 1]);
    const rows: string[][] = []; let j = i + 2;
    while (j < lines.length && isRow(lines[j])) rows.push(splitRow(lines[j++]));
    const cols = Math.max(head.length, sep.length, 1);
    const over = rows.some((r) => r.length > cols);
    if (over || cols > head.length || cols > sep.length) {
      const join = (cells: string[]) => "| " + cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ") + " |";
      const padTo = (cells: string[], filler: string) => [...cells, ...Array(Math.max(0, cols - cells.length)).fill(filler)];
      // 多出的单元格并进最后一列：不新增列，文字一个不丢
      const fit = (cells: string[]) => (cells.length > cols ? [...cells.slice(0, cols - 1), cells.slice(cols - 1).join(" · ")] : cells);
      lines[i] = join(padTo(head, ""));
      lines[i + 1] = join(padTo(sep, "---"));
      rows.forEach((r, k) => { lines[i + 2 + k] = join(padTo(fit(r), "")); });
    }
    i = j - 1;
  }
  return lines.join("\n");
}

/**
 * 浏览器会把 <script> 连同内容一起从 sanitize 后的树里删掉；这里转义成文字，和编辑器一致。
 * 只处理正文：围栏代码块与行内代码里的 <script> 是代码内容，交给 markdown 自己转义一次。
 */
const escapeScriptInProse = (text: string) => text.replace(/<(\/?)(script)\b/gi, "&lt;$1$2");

/** 行内代码原样保留，只转义片段之间的正文；未配对的反引号仍按正文处理 */
const escapeInlineCode = (line: string) => {
  const re = /(`+)([\s\S]*?)\1/g;
  let out = ""; let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out += escapeScriptInProse(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapeScriptInProse(line.slice(last));
};

/** 成对围栏（``` / ~~~）之间、含未闭合围栏到文末的行整段跳过 */
const escapeScriptTags = (src: string) => {
  let fence: string | null = null;
  return src.split("\n").map((line) => {
    const m = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (m && m[1] === fence) fence = null;
      return line;
    }
    if (m) { fence = m[1]; return line; }
    return escapeInlineCode(line);
  }).join("\n");
};

/** 独占一行的 $$…$$ 补成行间公式：remark-math 只把「行首 $$、行尾 $$」当块级，单行写法会被当成行内 */
const displayMath = (src: string) => {
  let fenced = false;
  return src.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    const m = /^\s*\$\$(?!\$)([\s\S]+?)\$\$\s*$/.exec(line);
    return m ? "$$\n" + m[1].trim() + "\n$$" : line;
  }).join("\n");
};

/** 交给 streamdown 之前统一预处理：先拆整段围栏 → 补中文标点旁的加粗定界符 → 公式成块 → 保护 <script> → 补表格列 */
const prepareMarkdown = (src: string) => padTables(escapeScriptTags(displayMath(padCjkEmphasis(unwrapWholeFence(String(src || ""))))));

/** 单个 $ 也认（$E=mc^2$）；不打开时只有 $$…$$ 会进公式 */
const MATH = createMathPlugin({ singleDollarTextMath: true });
const PLUGINS = { math: MATH } as const;

/**
 * 裸 HTML 一律当文字：默认 rehype 链里有 rehype-raw，会把正文的 <b> / <br> 变成真元素，
 * 而编辑器 markdownToHtml 是一律转义的。去掉 raw 后 streamdown 会在 remark 阶段把 html
 * 节点换成文本节点，两端行为一致；代码块 / 行内代码里的标签本来就是代码内容，不受影响。
 */
const ALLOWED_REHYPE = Object.entries(defaultRehypePlugins).filter(([key]) => key !== "raw").map(([, plugin]) => plugin);

type HastNode = { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[]; value?: string };

/**
 * sanitize 用的是 GitHub 的 HTML 白名单：div / span 只放行 itemScope、itemType，会把 remark-rehype
 * 给公式加的 math-display / math-inline class 抹掉，KaTeX 于是退化成行内公式。过了 sanitize
 * 先把类型藏在 id（白名单放行）里，再还原 class，交给排最后的 rehype-katex。
 */
const MATH_CLASSES = ["math-display", "math-inline"];
const rehypeStashMathClass = () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    const hit = (node.properties?.className as string[] | undefined)?.find((c) => MATH_CLASSES.includes(c));
    if (hit) node.properties = { ...node.properties, id: "cn-" + hit };
    node.children?.forEach(walk);
  };
  walk(tree);
};
const rehypeRestoreMathClass = () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    const id = String(node.properties?.id || "");
    if (id === "cn-math-display" || id === "cn-math-inline") {
      const rest = { ...node.properties };
      delete rest.id;
      node.properties = { ...rest, className: [id.slice(3)] };
    }
    node.children?.forEach(walk);
  };
  walk(tree);
};

/** 脚注区标题由 mdast-util-to-hast 拼死英文 "Footnotes"（不走 streamdown 的 translations），这里换中文 */
const rehypeFootnotesZh = () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    if (node.type === "element" && node.properties?.id === "footnote-label") {
      node.children = [{ type: "text", value: "脚注" }];
      return;
    }
    node.children?.forEach(walk);
  };
  walk(tree);
};

const REHYPE_PLUGINS = [rehypeStashMathClass, defaultRehypePlugins.sanitize, rehypeRestoreMathClass, defaultRehypePlugins.harden, rehypeFootnotesZh] as typeof ALLOWED_REHYPE;

const TRANSLATIONS: Partial<StreamdownTranslations> = {
  copyCode: "复制代码", copied: "已复制", downloadFile: "下载",
  copyTable: "复制表格", copyTableAsMarkdown: "复制为 Markdown", copyTableAsCsv: "复制为 CSV", copyTableAsTsv: "复制为 TSV",
  downloadTable: "下载表格", downloadTableAsMarkdown: "下载 Markdown", downloadTableAsCsv: "下载 CSV",
  tableFormatMarkdown: "Markdown", tableFormatCsv: "CSV", tableFormatTsv: "TSV",
  viewFullscreen: "全屏查看", exitFullscreen: "退出全屏", resetView: "重置视图", zoomIn: "放大", zoomOut: "缩小",
  openExternalLink: "打开外部链接？", externalLinkWarning: "即将离开当前画布，打开外部网站。", openLink: "打开链接", copyLink: "复制链接", close: "关闭",
  imageNotAvailable: "图片无法显示", downloadImage: "下载图片",
};

/** 表格全屏会把弹层 portal 到 body，拿不到 .cn-root 的主题变量，所以只留复制 / 下载 */
const CONTROLS: ControlsConfig = {
  table: { copy: true, download: true, fullscreen: false },
  code: { copy: true, download: false },
};
const LINK_SAFETY = { enabled: false };

export function Markdown({ text, className, streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  useEffect(() => { bindImagePreview(); }, []);
  return (
    <Streamdown
      className={"md md-sd" + (className ? " " + className : "")}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret={streaming ? "block" : undefined}
      parseIncompleteMarkdown
      controls={CONTROLS}
      linkSafety={LINK_SAFETY}
      translations={TRANSLATIONS}
      plugins={PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      lineNumbers={false}
      tableMaxHeight={0}
      codeBlockMaxHeight={0}
    >
      {prepareMarkdown(text)}
    </Streamdown>
  );
}

const IMG_SELECTOR = 'img[data-streamdown="image"]';
let imgBound = false;

/** 图片点开放大：遮罩挂在 body 上（聊天 / 文本节点 / 分享页共用），点遮罩或 Esc 关闭 */
function openImagePreview(src: string, alt: string) {
  if (!src) return;
  const box = document.createElement("div");
  box.className = "md-lb";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", alt.trim() || "查看大图");
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.draggable = false;
  const close = document.createElement("button");
  close.className = "md-lb-x";
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  let done = false;
  const shut = () => {
    if (done) return;
    done = true;
    removeEventListener("keydown", onKey, true);
    box.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    shut();
  };
  box.addEventListener("pointerdown", (e) => { if (e.target === box) shut(); });
  close.addEventListener("click", shut);
  box.append(img, close);
  document.body.appendChild(box);
  addEventListener("keydown", onKey, true);
}

/** 只绑一次：所有 Markdown 实例共用这一层；编辑器里的图片是内容要拖拽选中，不放大 */
function bindImagePreview() {
  if (imgBound) return;
  imgBound = true;
  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest(IMG_SELECTOR) : null;
    if (!(el instanceof HTMLImageElement)) return;
    if (el.closest("a") || el.closest('[contenteditable="true"]')) return;
    e.preventDefault();
    openImagePreview(el.currentSrc || el.src, el.alt || "");
  }, true);
}

/** 生成中的文本节点：TapNow 用三条灰色骨架线（满 / 6 成 / 3 成） */
export function TextSkeleton() {
  return <div className="tsk"><i style={{ width: "100%" }} /><i style={{ width: "62%" }} /><i style={{ width: "30%" }} /></div>;
}
