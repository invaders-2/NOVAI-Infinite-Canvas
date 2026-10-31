/**
 * 整画布导出（PNG / JPEG）。
 *
 * 为什么不是 DOM 截图：画布是「世界坐标 + transform 缩放」的绝对定位 DOM，节点里还有跨域 / 协议图片，
 * html2canvas 这类方案要额外依赖、还会被 CSP 挡。这里按模型自己重画一遍：
 *   · 背景：画布底色 + 点阵（和 #vp 的视觉一致，点到为止）；
 *   · 连线：与 Edges.tsx 同一条三次贝塞尔（出端口 → 入端口，dx = max(60, |dx| * .5)）；
 *   · 节点：标题行 + 圆角卡片（图片 cover、视频 poster + 播放三角、文本按宽度换行、表格简化网格）；
 *   · 倍率 1x / 2x，范围全部或选中，输出 PNG / JPEG（JPEG 没有透明通道，先铺底色）。
 *
 * 纯函数部分（pickExportNodes / computeExportBounds / exportPixels / exportFileName / drawCanvasExport）
 * 不碰 DOM，单测用假 ctx 断言绘制指令；exportCanvas() 是浏览器侧编排（取字节 → 画 → toBlob → 保存）。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, outOf, TYPE_LABEL, isGenKind } from "./model";
import { tableOf } from "./table";

export type ExportFormat = "png" | "jpeg";
export type ExportRange = "all" | "selection";

export type ExportBounds = { x: number; y: number; w: number; h: number };

export type CanvasExportOptions = {
  format?: ExportFormat;
  /** 1 = 原尺寸，2 = 两倍（像素上限会自动收敛） */
  scale?: number;
  range?: ExportRange;
  padding?: number;
  maxDimension?: number;
  maxPixels?: number;
  includeEdges?: boolean;
  includeGrid?: boolean;
};

export type ExportPalette = {
  background: string;
  grid: string;
  card: string;
  border: string;
  title: string;
  text: string;
  muted: string;
  edge: string;
  accent: string;
  font: string;
  mono: string;
};

/** drawCanvasExport 只用到 ctx 的这几个方法：单测可以传记录器，不需要真 canvas */
export type ExportCtx = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "closePath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo"
  | "rect" | "clip" | "fill" | "stroke" | "fillRect" | "strokeRect" | "fillText" | "measureText" | "drawImage" | "arc"
> & {
  fillStyle?: string | CanvasGradient | CanvasPattern;
  strokeStyle?: string | CanvasGradient | CanvasPattern;
  lineWidth?: number;
  font?: string;
  textBaseline?: CanvasTextBaseline;
  textAlign?: CanvasTextAlign;
  globalAlpha?: number;
};

export type NodeImage = { source: CanvasImageSource; width: number; height: number };

export const EXPORT_PADDING = 40;
export const EXPORT_MAX_DIMENSION = 8192;
export const EXPORT_MAX_PIXELS = 48 * 1000 * 1000;
export const GRID_STEP = 20;
const NODE_HEAD = 24;
const BODY_RADIUS = 14;
const LINE_HEIGHT = 19;

export const DARK_PALETTE: ExportPalette = {
  background: "#000000", grid: "rgba(255,255,255,0.16)", card: "#1c1c1e", border: "rgba(255,255,255,0.12)",
  title: "#98989d", text: "#e6e6e8", muted: "#6e6e73", edge: "rgba(255,255,255,0.34)", accent: "#f5f5f7",
  font: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif",
  mono: "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace",
};

export const LIGHT_PALETTE: ExportPalette = {
  background: "#f2f2f4", grid: "rgba(0,0,0,0.14)", card: "#ffffff", border: "rgba(0,0,0,0.10)",
  title: "#6e6e73", text: "#2c2c2e", muted: "#8e8e93", edge: "rgba(0,0,0,0.32)", accent: "#1d1d1f",
  font: DARK_PALETTE.font, mono: DARK_PALETTE.mono,
};

/* ---------- 纯函数：范围 / 包围盒 / 像素 / 文件名 ---------- */

/** 导出哪些节点：「选中」但没有选中时回落到全部（并如实返回实际范围） */
export function pickExportNodes(doc: Pick<CanvasDoc, "nodes">, options: Pick<CanvasExportOptions, "range"> & { selectedIds?: Iterable<string> } = {}): { nodes: CanvasNode[]; range: ExportRange } {
  const all = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
  const wanted = options.range === "selection";
  const selected = new Set<string>(options.selectedIds ? Array.from(options.selectedIds) : []);
  const picked = wanted ? all.filter((n) => selected.has(n.id)) : all.slice();
  if (picked.length) return { nodes: picked, range: wanted ? "selection" : "all" };
  return { nodes: all.slice(), range: "all" };
}

/** 节点包围盒（含标题行 24px）+ 内边距；没有节点返回 null */
export function computeExportBounds(nodes: CanvasNode[], padding = EXPORT_PADDING): ExportBounds | null {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n && Number.isFinite(n.x) && Number.isFinite(n.y)) : [];
  if (!list.length) return null;
  const left = Math.min(...list.map((n) => n.x));
  const top = Math.min(...list.map((n) => n.y));
  const right = Math.max(...list.map((n) => n.x + (Number(n.w) || 0)));
  const bottom = Math.max(...list.map((n) => n.y + NODE_HEAD + (Number(n.h) || 0)));
  const pad = Math.max(0, Number.isFinite(Number(padding)) ? Number(padding) : EXPORT_PADDING);
  return { x: left - pad, y: top - pad, w: Math.max(1, right - left + pad * 2), h: Math.max(1, bottom - top + pad * 2) };
}

/** 世界尺寸 × 倍率 → 输出像素；超过上限时等比收敛（返回实际倍率） */
export function exportPixels(bounds: ExportBounds, scale = 1, maxDimension = EXPORT_MAX_DIMENSION, maxPixels = EXPORT_MAX_PIXELS): { width: number; height: number; scale: number } {
  const w0 = Math.max(1, Number(bounds && bounds.w) || 1);
  const h0 = Math.max(1, Number(bounds && bounds.h) || 1);
  const want = Math.max(0.01, Number(scale) || 1);
  const dimLimit = Math.max(1, Number(maxDimension) || EXPORT_MAX_DIMENSION);
  const pixelLimit = Math.max(1, Number(maxPixels) || EXPORT_MAX_PIXELS);
  let factor = 1;
  const w = w0 * want, h = h0 * want;
  if (w > dimLimit || h > dimLimit) factor = Math.min(factor, dimLimit / Math.max(w, h));
  if (w * h > pixelLimit) factor = Math.min(factor, Math.sqrt(pixelLimit / (w * h)));
  const used = want * factor;
  return { width: Math.max(1, Math.ceil(w0 * used)), height: Math.max(1, Math.ceil(h0 * used)), scale: Number(used.toFixed(4)) };
}

/** 文件名：<画布名>[-选中][-2x].png|jpg，去掉路径非法字符 */
export function exportFileName(name: unknown, { format = "png", scale = 1, range = "all" }: Pick<CanvasExportOptions, "format" | "scale" | "range"> = {}): string {
  const base = String(name == null ? "" : name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80) || "画布";
  const rangeTag = range === "selection" ? "-选中" : "";
  const n = Number(scale) || 1;
  const scaleTag = Math.abs(n - 1) < 0.01 ? "" : "-" + String(Number(n.toFixed(2))) + "x";
  return base + rangeTag + scaleTag + "." + (format === "jpeg" ? "jpg" : "png");
}

/* ---------- 纯函数：绘画 ---------- */

type DrawInput = {
  nodes: CanvasNode[];
  edges?: Array<{ id?: string; from: string; to: string }>;
  bounds: ExportBounds;
  scale: number;
  palette?: ExportPalette;
  images?: Map<string, NodeImage>;
  includeEdges?: boolean;
  includeGrid?: boolean;
  gridStep?: number;
};

const measure = (ctx: ExportCtx, text: string): number => {
  try { const m = ctx.measureText(text); return (m && Number(m.width)) || 0; } catch { return 0; }
};

const fontOf = (size: number, palette: ExportPalette) => size + "px " + palette.font;

/** 截断到 maxWidth，超出加省略号 */
function clipText(ctx: ExportCtx, text: unknown, maxWidth: number, palette: ExportPalette): string {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (measure(ctx, value) <= maxWidth) return value;
  const chars = Array.from(value);
  let out = "";
  for (const ch of chars) {
    if (measure(ctx, out + ch + "…") > maxWidth) return out ? out + "…" : "…";
    out += ch;
  }
  return out;
}

/** 按宽度换行（逐字，中英文都成立），最多 maxLines 行，最后一行截断加省略号 */
function wrapText(ctx: ExportCtx, text: unknown, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  const paragraphs = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  for (const para of paragraphs) {
    if (lines.length >= maxLines) break;
    let line = "";
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && measure(ctx, next) > maxWidth) { lines.push(line); line = ch; if (lines.length >= maxLines) break; }
      else line = next;
    }
    if (lines.length >= maxLines) break;
    lines.push(line);
  }
  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (measure(ctx, last) > maxWidth) lines[maxLines - 1] = clipText(ctx, last, maxWidth, DARK_PALETTE);
    const usedAll = lines.join("").length >= Array.from(paragraphs.join("")).length;
    if (!usedAll && !lines[maxLines - 1].endsWith("…")) lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, "…");
  }
  return lines;
}

function roundRectPath(ctx: ExportCtx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawCover(ctx: ExportCtx, image: NodeImage, x: number, y: number, w: number, h: number): void {
  const iw = Math.max(1, Number(image.width) || 1);
  const ih = Math.max(1, Number(image.height) || 1);
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale, sh = h / scale;
  const sx = Math.max(0, (iw - sw) / 2), sy = Math.max(0, (ih - sh) / 2);
  try { ctx.drawImage(image.source, sx, sy, sw, sh, x, y, w, h); } catch { /* 单张图坏了不影响整张导出 */ }
}

function edgePath(ctx: ExportCtx, a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): void {
  const p1 = { x: a.x + a.w, y: a.y + NODE_HEAD + a.h / 2 };
  const p2 = { x: b.x, y: b.y + NODE_HEAD + b.h / 2 };
  const dx = Math.max(60, Math.abs(p2.x - p1.x) * 0.5);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.bezierCurveTo(p1.x + dx, p1.y, p2.x - dx, p2.y, p2.x, p2.y);
  ctx.stroke();
}

function drawBody(ctx: ExportCtx, node: CanvasNode, palette: ExportPalette, images?: Map<string, NodeImage>): void {
  const x = node.x, y = node.y + NODE_HEAD, w = Number(node.w) || 0, h = Number(node.h) || 0;
  const image = images ? images.get(node.id) : undefined;
  const out = outOf(node);
  const kind = String(node.kind || "");

  // 卡片底 + 描边
  roundRectPath(ctx, x, y, w, h, BODY_RADIUS);
  ctx.fillStyle = palette.card;
  ctx.fill();
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  // 图片 / 视频首帧：圆角裁切后 cover
  if ((kind === "image" || kind === "video") && image) {
    ctx.save();
    roundRectPath(ctx, x, y, w, h, BODY_RADIUS);
    ctx.clip();
    drawCover(ctx, image, x, y, w, h);
    ctx.restore();
    if (kind === "video") {
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(28, Math.min(w, h) * 0.18);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = palette.background;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.28, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.5, cy);
      ctx.lineTo(cx - r * 0.28, cy + r * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }

  // 文本：按宽度换行绘制正文
  if (kind === "text") {
    const text = (out && out.text) || node.text || "";
    const lines = wrapText(ctx, text, Math.max(20, w - 24), Math.max(1, Math.floor((h - 20) / LINE_HEIGHT)));
    ctx.fillStyle = palette.text;
    ctx.font = fontOf(12, palette);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => ctx.fillText(line, x + 12, y + 10 + i * LINE_HEIGHT));
    return;
  }

  // 表格：表头 + 网格 + 单元格文字（简化绘制）
  if (kind === "table") {
    let table: { columns: string[]; rows: string[][] } | null = null;
    try { const t = tableOf(node); if (t) table = { columns: (t.columns || []).map(String), rows: (t.rows || []).map((row: unknown[]) => (row || []).map(String)) }; } catch { table = null; }
    const cols = table && table.columns.length ? table.columns : ["字段 1", "字段 2", "字段 3"];
    const rows = table ? table.rows : [];
    const headH = 30;
    ctx.fillStyle = palette.title;
    ctx.font = fontOf(11.5, palette);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const colW = (w - 24) / Math.max(1, cols.length);
    cols.forEach((c, i) => ctx.fillText(clipText(ctx, c, colW - 12, palette), x + 12 + i * colW, y + headH / 2));
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + headH + 0.5);
    ctx.lineTo(x + w, y + headH + 0.5);
    ctx.stroke();
    const rowH = Math.max(18, Math.min(30, (h - headH) / Math.max(1, Math.min(rows.length || 3, 8))));
    ctx.fillStyle = palette.text;
    ctx.font = fontOf(11.5, palette);
    const maxRows = Math.max(0, Math.floor((h - headH) / rowH));
    rows.slice(0, maxRows).forEach((row, r) => {
      row.slice(0, cols.length).forEach((cell, c) => {
        if (!cell) return;
        ctx.fillText(clipText(ctx, cell, colW - 12, palette), x + 12 + c * colW, y + headH + r * rowH + rowH / 2);
      });
      if (r > 0) {
        ctx.strokeStyle = palette.border;
        ctx.beginPath();
        ctx.moveTo(x, y + headH + r * rowH + 0.5);
        ctx.lineTo(x + w, y + headH + r * rowH + 0.5);
        ctx.stroke();
      }
    });
    return;
  }

  // 其它（音频 / 3D / 时间线 / 分组 / 便签）：居中说明
  const label = kind === "audio" ? "音频" : (TYPE_LABEL[kind as keyof typeof TYPE_LABEL] || node.kind || "节点");
  ctx.fillStyle = palette.muted;
  ctx.font = fontOf(12, palette);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(label), x + w / 2, y + h / 2);
  ctx.textAlign = "left";
}

/** 把画布按世界坐标画进 ctx（调用方负责 canvas 尺寸与 transform 之前的清屏） */
export function drawCanvasExport(ctx: ExportCtx, input: DrawInput): { nodes: number; edges: number } {
  const palette = input.palette || DARK_PALETTE;
  const bounds = input.bounds;
  const scale = Number(input.scale) > 0 ? Number(input.scale) : 1;
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (Array.isArray(input.edges) ? input.edges : []).filter((e) => byId.has(e.from) && byId.has(e.to));

  ctx.save();
  // 世界坐标 → 输出像素
  const ox = -bounds.x, oy = -bounds.y;
  // 先整体平移 + 缩放：调用方已经按 bounds*scale 建好的 canvas 上，直接画世界坐标即可
  const anyCtx = ctx as unknown as { setTransform?: (a: number, b: number, c: number, d: number, e: number, f: number) => void; translate?: (x: number, y: number) => void; scale?: (x: number, y: number) => void };
  if (typeof anyCtx.setTransform === "function") anyCtx.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
  else { anyCtx.translate?.(ox, oy); anyCtx.scale?.(scale, scale); }

  // 背景（JPEG 没透明通道，必须铺满）
  ctx.fillStyle = palette.background;
  ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

  // 点阵背景
  if (input.includeGrid !== false) {
    const step = Math.max(4, Number(input.gridStep) || GRID_STEP);
    const dots = Math.ceil(bounds.w / step) * Math.ceil(bounds.h / step);
    if (dots <= 200000) {
      ctx.fillStyle = palette.grid;
      for (let gx = Math.ceil(bounds.x / step) * step; gx <= bounds.x + bounds.w; gx += step) {
        for (let gy = Math.ceil(bounds.y / step) * step; gy <= bounds.y + bounds.h; gy += step) {
          ctx.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }
    }
  }

  // 连线
  if (input.includeEdges !== false) {
    ctx.strokeStyle = palette.edge;
    ctx.lineWidth = 1.6;
    for (const edge of edges) edgePath(ctx, byId.get(edge.from)!, byId.get(edge.to)!);
  }

  // 节点：标题 + 卡片
  for (const node of nodes) {
    const title = (isGenKind(node.kind) ? genOf(node).title : (node.text || "")) || TYPE_LABEL[node.kind as keyof typeof TYPE_LABEL] || String(node.kind || "节点");
    ctx.fillStyle = palette.title;
    ctx.font = fontOf(12, palette);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(clipText(ctx, title, Math.max(10, (Number(node.w) || 0) - 4), palette), node.x, node.y + 17);
    drawBody(ctx, node, palette, input.images);
  }

  ctx.restore();
  return { nodes: nodes.length, edges: edges.length };
}

/* ---------- 浏览器侧：调色板 / 取图 / 导出 / 保存 ---------- */

/** 从画布根节点读 CSS 变量作为导出调色板（读不到就按深浅色兜底） */
export function readCanvasPalette(root?: Element | null): ExportPalette {
  const el = root || (typeof document !== "undefined" ? document.querySelector(".cn-root") : null);
  if (!el || typeof getComputedStyle !== "function") return DARK_PALETTE;
  const css = (name: string, fallback: string) => {
    try { const v = getComputedStyle(el).getPropertyValue(name).trim(); return v || fallback; } catch { return fallback; }
  };
  const dark = el.classList.contains("dark") || (typeof document !== "undefined" && !document.documentElement.classList.contains("light") && css("--bg", "#000") !== "#f2f2f4");
  const base = dark ? DARK_PALETTE : LIGHT_PALETTE;
  return {
    background: css("--bg", base.background),
    grid: css("--dot", base.grid),
    card: css("--card", base.card),
    border: css("--line", base.border),
    title: css("--fg2", base.title),
    text: css("--fg1", base.text),
    muted: css("--fg3", base.muted),
    edge: css("--edge", base.edge),
    accent: css("--fg", base.accent),
    font: css("--font", base.font),
    mono: css("--mono", base.mono),
  };
}

/** 节点结果图：openarc-asset 取字节、远程地址先入库，再解码成可 drawImage 的位图 */
async function resolveNodeImages(store: { backend: { resolveAsset(ref: string): Promise<string | null>; importRemote?: (canvasId: string, url: string, name: string) => Promise<string> }; state: { canvasId: string } }, nodes: CanvasNode[], onProgress?: (done: number, total: number) => void): Promise<Map<string, NodeImage>> {
  const out = new Map<string, NodeImage>();
  const wanted = nodes.filter((n) => n.kind === "image" || n.kind === "video");
  let done = 0;
  for (const node of wanted) {
    done += 1;
    onProgress?.(done, wanted.length);
    const o = outOf(node);
    let src = String((o && (node.kind === "video" ? (o.frame || o.url) : o.url)) || node.url || "");
    if (!src) continue;
    try {
      if (src.startsWith("openarc-asset:")) { const data = await store.backend.resolveAsset(src); if (!data) continue; src = data; }
      else if (/^https?:\/\//i.test(src) && store.backend.importRemote) {
        const ref = await store.backend.importRemote(store.state.canvasId, src, "导出素材");
        if (!ref || !ref.startsWith("openarc-asset:")) continue;
        const data = await store.backend.resolveAsset(ref);
        if (!data) continue;
        src = data;
      }
      const image = await loadImage(src);
      if (image) out.set(node.id, image);
    } catch { /* 单张失败就画占位，不影响整张导出 */ }
  }
  return out;
}

function loadImage(src: string): Promise<NodeImage | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve({ source: img, width: img.naturalWidth || img.width || 1, height: img.naturalHeight || img.height || 1 });
      img.onerror = () => resolve(null);
      img.src = src;
    } catch { resolve(null); }
  });
}

export type CanvasExportResult = { blob: Blob; filename: string; width: number; height: number; scale: number; range: ExportRange; nodes: number; edges: number };

/** 浏览器侧编排：选范围 → 算尺寸 → 取图 → 画 → toBlob */
export async function exportCanvas(store: {
  backend: { resolveAsset(ref: string): Promise<string | null>; importRemote?: (canvasId: string, url: string, name: string) => Promise<string> };
  state: { canvasId: string; name?: string; doc: CanvasDoc; ui?: { sel?: Set<string> } };
  toast?: (text: string, ms?: number) => void;
}, options: CanvasExportOptions = {}): Promise<CanvasExportResult> {
  const doc = store.state.doc;
  const picked = pickExportNodes(doc, { range: options.range, selectedIds: store.state.ui && store.state.ui.sel });
  if (!picked.nodes.length) throw new Error("画布上没有可导出的节点");
  const bounds = computeExportBounds(picked.nodes, options.padding);
  if (!bounds) throw new Error("画布上没有可导出的节点");
  const pixels = exportPixels(bounds, options.scale ?? 1, options.maxDimension, options.maxPixels);
  const ids = new Set(picked.nodes.map((n) => n.id));
  const edges = (doc.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to));

  const images = await resolveNodeImages(store, picked.nodes);
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("导出失败：拿不到 2D 画布上下文");
  const palette = readCanvasPalette();
  const drawn = drawCanvasExport(ctx as unknown as ExportCtx, {
    nodes: picked.nodes, edges, bounds, scale: pixels.scale, palette, images,
    includeEdges: options.includeEdges !== false, includeGrid: options.includeGrid !== false,
  });

  const format: ExportFormat = options.format === "jpeg" ? "jpeg" : "png";
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出失败：浏览器没有返回图片数据"))), mime, format === "jpeg" ? 0.92 : undefined);
  });
  return {
    blob,
    filename: exportFileName(store.state.name || "画布", { format, scale: drawn ? pixels.scale : 1, range: picked.range }),
    width: pixels.width, height: pixels.height, scale: pixels.scale, range: picked.range,
    nodes: drawn.nodes, edges: drawn.edges,
  };
}

/* ---------- 保存：主进程真正落盘（file:// 页面里 <a download> 不落盘） ---------- */

export type ExportSaveResult = {
  ok: boolean;
  /** 真实落盘路径（主进程给的绝对路径） */
  path?: string;
  fileName?: string;
  bytes?: number;
  /** 给 toast 用的短路径（~/Downloads/xxx.png） */
  display: string;
  error?: string;
  detail?: string;
};

/** 绝对路径 → ~ 开头（macOS /Users/x、Linux /home/x 都收） */
export function shortenPath(value: unknown): string {
  const full = String(value == null ? "" : value);
  const parts = full.split("/");
  // /Users/<name>/... 或 /home/<name>/... → ~/...
  if ((parts[1] === "Users" || parts[1] === "home") && parts.length > 3) return "~/" + parts.slice(3).join("/");
  return full;
}

/** Blob → base64（分块，避免大图把 String.fromCharCode 的参数撑爆） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return typeof btoa === "function" ? btoa(binary) : "";
}

type CanvasSaveCommand = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | null | undefined | { ok: boolean; error?: string; detail?: string }>;

/**
 * 保存导出图：优先走主进程 canvas/saveExport（真正写进系统下载目录，重名自动 -1），
 * 没有 openarc 桥（独立页 / 开发页）时才退回 <a download>。
 *
 * @param send 测试可注入的画布命令；缺省取 window.openarc.canvas.command
 */
export async function saveCanvasBlob(blob: Blob, filename: string, send?: CanvasSaveCommand): Promise<ExportSaveResult> {
  const mime = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const command = send || (typeof window !== "undefined" ? (window as unknown as { openarc?: { canvas?: { command?: CanvasSaveCommand } } }).openarc?.canvas?.command : undefined);
  if (typeof command === "function") {
    let base64 = "";
    try { base64 = await blobToBase64(blob); }
    catch (error) { return { ok: false, error: "ENCODE_FAILED", detail: String((error as Error)?.message || error).slice(0, 200), display: filename }; }
    if (!base64) return { ok: false, error: "ENCODE_FAILED", detail: "base64-empty", display: filename };
    const res = await command({ type: "canvas/saveExport", fileName: filename, mime, base64 })
      .catch((error: unknown) => ({ ok: false, error: "SAVE_FAILED", detail: String((error as Error)?.message || error).slice(0, 200) })) as Record<string, any> | null;
    if (res && res.ok === true && typeof res.path === "string") {
      return { ok: true, path: res.path, fileName: String(res.fileName || filename), bytes: Number(res.bytes) || blob.size, display: shortenPath(res.path) };
    }
    const detail = res && typeof res.detail === "string" ? res.detail : "";
    return { ok: false, error: String((res && res.error) || "SAVE_FAILED"), detail, display: filename };
  }
  // 独立页 / 开发页兜底（没有主进程可写盘）
  if (typeof document === "undefined") return { ok: false, error: "NO_BRIDGE", detail: "no-openarc-bridge", display: filename };
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, path: filename, fileName: filename, bytes: blob.size, display: filename };
}
