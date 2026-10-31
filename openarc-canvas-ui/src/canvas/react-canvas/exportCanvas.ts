import type { CanvasDoc, CanvasNode } from "./reactCanvasStore";

type Scope = "view" | "selected" | "all";
type View = { x: number; y: number; k: number };
const PADDING = 40;
function nodeBounds(nodes: CanvasNode[]) { const minX = Math.min(...nodes.map((n) => n.x)); const minY = Math.min(...nodes.map((n) => n.y)); const maxX = Math.max(...nodes.map((n) => n.x + n.w)); const maxY = Math.max(...nodes.map((n) => n.y + n.h)); return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }; }
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
async function loadImage(url: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = () => reject(new Error("图片加载失败或跨域受限")); img.src = url; }); }
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) { const lines: string[] = []; let line = ""; for (const char of text) { const next = line + char; if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = char; if (lines.length >= maxLines) break; } else line = next; } if (lines.length < maxLines && line) lines.push(line); return lines; }

export async function exportCanvasPng({ doc, scope, selectedIds, view, viewportWidth, viewportHeight, showDots = true, showEdges = true }: { doc: CanvasDoc; scope: Scope; selectedIds: string[]; view: View; viewportWidth: number; viewportHeight: number; showDots?: boolean; showEdges?: boolean }) {
  const selected = scope === "selected" ? doc.nodes.filter((node) => selectedIds.includes(node.id)) : doc.nodes;
  if (scope === "selected" && !selected.length) throw new Error("没有选中节点");
  const source = selected.length ? selected : doc.nodes;
  if (!source.length && scope !== "view") throw new Error("画布没有可导出的内容");
  let box = { x: 0, y: 0, w: viewportWidth, h: viewportHeight };
  if (scope !== "view") { const b = nodeBounds(source); box = { x: b.x * view.k + view.x - PADDING, y: b.y * view.k + view.y - PADDING, w: b.w * view.k + PADDING * 2, h: b.h * view.k + PADDING * 2 }; }
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(box.w * scale)); canvas.height = Math.max(1, Math.ceil(box.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建导出画布");
  ctx.scale(scale, scale); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, box.w, box.h);
  ctx.save(); ctx.translate(-box.x, -box.y);
  if (showDots) { const step = 28 * Math.max(view.k, 0.2); ctx.fillStyle = "rgba(255,255,255,.10)"; for (let x = ((view.x % step) + step) % step; x < box.w; x += step) for (let y = ((view.y % step) + step) % step; y < box.h; y += step) { ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill(); } }
  const screen = (node: CanvasNode) => ({ x: node.x * view.k + view.x, y: node.y * view.k + view.y, w: node.w * view.k, h: node.h * view.k });
  if (showEdges) { ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.lineWidth = 1.5; for (const edge of doc.edges) { const from = doc.nodes.find((n) => n.id === edge.from); const to = doc.nodes.find((n) => n.id === edge.to); if (!from || !to) continue; const a = screen(from); const b = screen(to); ctx.beginPath(); ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2); ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2); ctx.stroke(); } }
  for (const node of selected.length ? selected : doc.nodes) {
    if (!doc.nodes.includes(node)) continue;
    const s = screen(node);
    ctx.save(); roundRect(ctx, s.x, s.y, s.w, s.h, 16 * view.k); ctx.fillStyle = "#181818"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 1; ctx.stroke(); ctx.clip();
    if (node.url && node.kind === "image") { const img = await loadImage(node.url); const ratio = Math.max(s.w / img.naturalWidth, s.h / img.naturalHeight); const iw = img.naturalWidth * ratio; const ih = img.naturalHeight * ratio; ctx.drawImage(img, s.x + (s.w - iw) / 2, s.y + (s.h - ih) / 2, iw, ih); }
    else if (node.kind === "text" || node.kind === "note") { ctx.fillStyle = "#f5f5f5"; ctx.font = Math.max(11, 13 * view.k) + "px -apple-system, sans-serif"; ctx.textBaseline = "top"; const lines = wrapText(ctx, node.text || "", s.w - 24, 8); lines.forEach((line, index) => ctx.fillText(line, s.x + 12, s.y + 14 + index * 18 * Math.max(view.k, .8))); }
    else { ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = Math.max(10, 12 * view.k) + "px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; const label = node.kind === "model3d" ? "3D 模型" : node.kind === "scene3d" ? "3D 片场" : node.kind === "timeline" ? "剪辑时间线" : "媒体"; ctx.fillText(label, s.x + s.w / 2, s.y + s.h / 2); }
    ctx.restore();
  }
  ctx.restore();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG 编码失败");
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "canvas-" + scope + ".png"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { bytes: blob.size, width: canvas.width, height: canvas.height };
}


/**
 * 列表缩略图：把一份画布文档渲染成小图（不下载、不弹窗、不改文档）。
 *
 * 与 exportCanvasPng 的区别：不按视口、不加 2x、不触发下载；只为「一眼看出这张画布长什么样」。
 * 图片节点只有当调用方能解析成可加载地址时才会画出来（画布文档里存的是 openarc-asset: 引用），
 * 解析不到就留占位块 —— 不假装渲染成功。
 */
/**
 * 缩略图配色。不传 theme 时用 legacy（原来的深色，列表页在用，必须保持不变）；
 * dark / light 给模板面板这类"要跟当前主题走"的地方用：
 * 封面底与节点块拉开一档，并用 1px 描边勾出节点边界，避免缩略图糊成一块。
 */
type ThumbSkin = { bg: string; dot: string; node: string; nodeLine: string | null; edge: string; text: string; label: string };
const THUMB_SKINS: Record<"legacy" | "dark" | "light", ThumbSkin> = {
  legacy: { bg: "#0b0b0c", dot: "rgba(255,255,255,.045)", node: "#17171a", nodeLine: null, edge: "rgba(255,255,255,.16)", text: "rgba(245,245,247,.82)", label: "rgba(255,255,255,.30)" },
  dark: { bg: "#1a1a1c", dot: "rgba(255,255,255,.05)", node: "#2a2a2d", nodeLine: "rgba(255,255,255,.10)", edge: "rgba(255,255,255,.22)", text: "rgba(245,245,247,.85)", label: "rgba(255,255,255,.40)" },
  light: { bg: "#ececee", dot: "rgba(0,0,0,.05)", node: "#ffffff", nodeLine: "rgba(0,0,0,.10)", edge: "rgba(0,0,0,.18)", text: "#1d1d1f", label: "rgba(0,0,0,.40)" },
};

/**
 * 结构预览配色：模板卡片与大预览用（列表页不走这里）。
 * 只用现有墨色单色阶 —— 深色 #1a1a1c 底 + 亮一档的节点块，浅色 #f0f0f2 底 + 白色节点块；不引入新色相。
 * 节点块比底色亮一档 + 1px 描边，块内再画按类型的图形，缩到卡片 150px 宽也不是一块糊掉的灰。
 */
type ThumbStructureSkin = ThumbSkin & { glyph: string; glyphDim: string };
const STRUCTURE_SKINS: Record<"dark" | "light", ThumbStructureSkin> = {
  dark: { bg: "#1a1a1c", dot: "rgba(255,255,255,.035)", node: "#2e2e32", nodeLine: "rgba(255,255,255,.16)", edge: "rgba(255,255,255,.34)", text: "rgba(245,245,247,.9)", label: "rgba(255,255,255,.45)", glyph: "rgba(245,245,247,.72)", glyphDim: "rgba(255,255,255,.32)" },
  light: { bg: "#ececee", dot: "rgba(0,0,0,.035)", node: "#f7f7f8", nodeLine: "rgba(0,0,0,.10)", edge: "rgba(0,0,0,.26)", text: "#1d1d1f", label: "rgba(0,0,0,.45)", glyph: "rgba(0,0,0,.55)", glyphDim: "rgba(0,0,0,.30)" },
};
type ThumbRect = { x: number; y: number; w: number; h: number };

/** 节点类型 → 图形语言：块内只用大形状，不写字（字缩小到 150px 宽的卡上就成噪点了） */
function drawNodeGlyph(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, w: number, h: number, k: number, skin: ThumbStructureSkin) {
  const pad = Math.round(Math.min(8, Math.max(4, Math.min(w, h) * 0.1)));
  const ix = x + pad, iy = y + pad, iw = w - pad * 2, ih = h - pad * 2;
  if (iw < 5 || ih < 5) return;
  ctx.save();
  if (kind === "text" || kind === "note") {
    // 最多 3 行文字条，按块高缩放，不越出内边距
    const bar = Math.max(1.4, Math.min(6, ih * 0.07));
    const gap = bar * 2.4;
    const widths = [0.86, 0.68, 0.44];
    const total = bar * widths.length + gap * (widths.length - 1);
    let by = iy + (ih - total) / 2;
    for (let i = 0; i < widths.length; i++) {
      ctx.fillStyle = i === widths.length - 1 ? skin.glyphDim : skin.glyph;
      ctx.beginPath(); roundRect(ctx, ix, by, Math.max(bar, iw * widths[i]), bar, bar / 2); ctx.fill();
      by += bar + gap;
    }
  } else if (kind === "image") {
    // 对角细纹铺满 + 左下角山形（高 ≤ 节点高 30%）+ 小太阳
    const step = Math.max(3, Math.min(6, Math.min(iw, ih) / 6));
    ctx.save(); ctx.globalAlpha = 0.45; ctx.strokeStyle = skin.glyphDim; ctx.lineWidth = 1;
    for (let d = -ih; d < iw; d += step) { ctx.beginPath(); ctx.moveTo(ix + d, iy + ih); ctx.lineTo(ix + d + ih, iy); ctx.stroke(); }
    ctx.restore();
    const base = iy + ih - Math.max(1, ih * 0.04);
    const mh = ih * 0.3;
    ctx.fillStyle = skin.glyph;
    ctx.beginPath(); ctx.moveTo(ix + iw * 0.04, base); ctx.lineTo(ix + iw * 0.26, base - mh); ctx.lineTo(ix + iw * 0.48, base); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(ix + iw * 0.34, base); ctx.lineTo(ix + iw * 0.56, base - mh * 0.72); ctx.lineTo(ix + iw * 0.78, base); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(ix + iw * 0.84, iy + ih * 0.2, Math.max(1.2, Math.min(iw, ih) * 0.045), 0, Math.PI * 2); ctx.fill();
  } else if (kind === "video") {
    // 圆形 ▶ 直径 ≤ 节点高 22%，加底部时长条
    const r = Math.max(2.5, Math.min(ih * 0.11, iw * 0.11));
    const cx = ix + iw / 2, cy = iy + ih * 0.44;
    ctx.fillStyle = skin.glyph;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = skin.node;
    ctx.beginPath(); ctx.moveTo(cx - r * 0.26, cy - r * 0.34); ctx.lineTo(cx + r * 0.4, cy); ctx.lineTo(cx - r * 0.26, cy + r * 0.34); ctx.closePath(); ctx.fill();
    const bar = Math.max(1.2, Math.min(2.5, ih * 0.05));
    const ty = iy + ih - bar - Math.max(1, ih * 0.06);
    ctx.fillStyle = skin.glyphDim; ctx.beginPath(); roundRect(ctx, ix + iw * 0.1, ty, iw * 0.8, bar, bar / 2); ctx.fill();
    ctx.fillStyle = skin.glyph; ctx.beginPath(); roundRect(ctx, ix + iw * 0.1, ty, iw * 0.34, bar, bar / 2); ctx.fill();
  } else if (kind === "audio") {
    // 声波竖条：最高 ≤ 节点高 45%
    const bars = [0.34, 0.58, 0.86, 1, 0.64, 0.44, 0.26];
    const bw = Math.max(1.2, Math.min(3, (iw * 0.6) / (bars.length * 1.9)));
    const gap = bw * 1.5;
    const totalW = bars.length * bw + (bars.length - 1) * gap;
    let bx = ix + Math.max(0, (iw - totalW) / 2);
    const midY = iy + ih / 2;
    for (let i = 0; i < bars.length; i++) {
      const hh = Math.max(bw, ih * 0.45 * bars[i]);
      ctx.fillStyle = i % 2 === 0 ? skin.glyph : skin.glyphDim;
      ctx.beginPath(); roundRect(ctx, bx, midY - hh / 2, bw, hh, bw / 2); ctx.fill();
      bx += bw + gap;
    }
  } else if (kind === "table") {
    // 3 列网格线 + 表头一档浅底
    const rows = 3, cols = 3;
    ctx.save(); ctx.globalAlpha = 0.1; ctx.fillStyle = skin.glyph; ctx.fillRect(ix, iy, iw, ih / rows); ctx.restore();
    ctx.strokeStyle = skin.glyphDim; ctx.lineWidth = 1;
    for (let i = 1; i < rows; i++) { const yy = iy + (ih / rows) * i; ctx.beginPath(); ctx.moveTo(ix, yy); ctx.lineTo(ix + iw, yy); ctx.stroke(); }
    for (let i = 1; i < cols; i++) { const xx = ix + (iw / cols) * i; ctx.beginPath(); ctx.moveTo(xx, iy); ctx.lineTo(xx, iy + ih); ctx.stroke(); }
  } else {
    ctx.fillStyle = skin.label;
    ctx.font = Math.max(5, Math.min(10, ih * 0.18)) + "px -apple-system, 'PingFang SC', sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(nodeKindLabel(kind), ix + iw / 2, iy + ih / 2);
  }
  ctx.restore();
}

function nodeKindLabel(kind: string) { return kind === "model3d" ? "3D" : kind === "scene3d" ? "片场" : kind === "timeline" ? "时间线" : kind === "table" ? "表格" : "媒体"; }
function drawThumbEdge(ctx: CanvasRenderingContext2D, a: ThumbRect, b: ThumbRect, color: string) {
  const rightward = b.x + b.w / 2 >= a.x + a.w / 2;
  const sx = rightward ? a.x + a.w : a.x, sy = a.y + a.h / 2;
  const tx = rightward ? b.x : b.x + b.w, ty = b.y + b.h / 2;
  const dx = Math.max(16, Math.abs(tx - sx) * 0.45) * (rightward ? 1 : -1);
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.bezierCurveTo(sx + dx, sy, tx - dx, ty, tx, ty); ctx.stroke();
  const dir = rightward ? 1 : -1;
  const head = Math.max(2.5, Math.min(5, ((a.h + b.h) / 2) * 0.07));
  const tip = tx - dir * 1.5;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(tip, ty); ctx.lineTo(tip - dir * head, ty - head * 0.62); ctx.lineTo(tip - dir * head, ty + head * 0.62); ctx.closePath(); ctx.fill();
}

export async function renderCanvasThumb({ doc, width = 480, height = 300, resolve, maxImages = 6, theme, structure = false, fit = "contain" }: {
  doc: CanvasDoc;
  width?: number;
  height?: number;
  /** openarc-asset:<ref> → 可显示的 data URL；没有就只画布局 */
  resolve?: (url: string) => Promise<string | null>;
  /** 最多解析几张图：列表页要便宜，别把整张画布的素材全拉下来 */
  maxImages?: number;
  /** 不传 = 原来的深色配色；dark / light 供需要跟主题的地方用 */
  theme?: "dark" | "light";
  /** 结构预览（模板卡片 / 大预览用）：按节点类型画图形语言 + 曲线箭头连线。默认 false = 原样，列表页不受影响 */
  structure?: boolean;
  /** contain（默认，与列表页同一套算法，k 封顶 1.2）/ fill（结构预览用：节点包围盒占画面 80%，每边留 10%，不封顶） */
  fit?: "contain" | "fill";
}): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const skin = THUMB_SKINS[theme || "legacy"];
  const struct = structure ? STRUCTURE_SKINS[theme === "light" ? "light" : "dark"] : null;
  const look = struct || skin;
  // 底 + 极淡点阵（和列表页背景同一套观感）
  ctx.fillStyle = look.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = look.dot;
  for (let x = 10; x < canvas.width; x += 22) for (let y = 10; y < canvas.height; y += 22) { ctx.beginPath(); ctx.arc(x, y, .8, 0, Math.PI * 2); ctx.fill(); }

  const nodes = (doc.nodes || []).filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.w > 0 && n.h > 0);
  if (!nodes.length) return canvas.toDataURL("image/png");

  const minX = Math.min(...nodes.map((n) => n.x)); const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w)); const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  const bw = Math.max(1, maxX - minX); const bh = Math.max(1, maxY - minY);
  // contain = 老算法（k 封顶 1.2）；fill = 结构预览专用：包围盒占画面 80%，四周各留 10%，不封顶
  const pad = 16;
  const k = fit === "fill"
    ? Math.min((canvas.width * 0.8) / bw, (canvas.height * 0.8) / bh)
    : Math.min((canvas.width - pad * 2) / bw, (canvas.height - pad * 2) / bh, 1.2);
  const ox = (canvas.width - bw * k) / 2 - minX * k; const oy = (canvas.height - bh * k) / 2 - minY * k;
  const at = (n: CanvasNode) => ({ x: n.x * k + ox, y: n.y * k + oy, w: Math.max(2, n.w * k), h: Math.max(2, n.h * k) });

  // 连线：细、低对比，只交代结构；结构预览走曲线 + 小箭头
  for (const edge of doc.edges || []) {
    const from = nodes.find((n) => n.id === edge.from); const to = nodes.find((n) => n.id === edge.to);
    if (!from || !to) continue;
    const a = at(from); const b = at(to);
    if (struct) { drawThumbEdge(ctx, a, b, struct.edge); continue; }
    ctx.strokeStyle = look.edge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2); ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2); ctx.stroke();
  }

  let budget = Math.max(0, maxImages);
  for (const node of nodes) {
    const s = at(node);
    const radius = Math.min(8, Math.max(3, 14 * k));
    ctx.save();
    roundRect(ctx, s.x, s.y, s.w, s.h, radius);
    ctx.fillStyle = look.node; ctx.fill();
    const nodeLine = struct ? struct.nodeLine : skin.nodeLine;
    if (nodeLine) { ctx.strokeStyle = nodeLine; ctx.lineWidth = struct && canvas.width >= 900 ? 1.5 : 1; ctx.stroke(); }
    ctx.clip();
    if (struct) { drawNodeGlyph(ctx, node.kind, s.x, s.y, s.w, s.h, k, struct); ctx.restore(); continue; }
    if (node.url && node.kind === "image") {
      let src = node.url;
      if (/^openarc-asset:/.test(src)) {
        src = "";
        if (budget > 0 && resolve) { budget--; try { src = (await resolve(node.url)) || ""; } catch { src = ""; } }
      }
      if (src) {
        try {
          const img = await loadImage(src);
          const ratio = Math.max(s.w / img.naturalWidth, s.h / img.naturalHeight);
          const iw = img.naturalWidth * ratio; const ih = img.naturalHeight * ratio;
          ctx.drawImage(img, s.x + (s.w - iw) / 2, s.y + (s.h - ih) / 2, iw, ih);
        } catch { /* 读不到就留占位 */ }
      }
    } else if (node.kind === "text" || node.kind === "note") {
      ctx.fillStyle = look.text;
      const fs = Math.max(6, Math.min(11, 13 * k));
      ctx.font = fs + "px -apple-system, 'PingFang SC', sans-serif";
      ctx.textBaseline = "top";
      const lines = wrapText(ctx, node.text || "", s.w - 10, Math.max(1, Math.floor((s.h - 8) / (fs * 1.45))));
      lines.forEach((line, i) => ctx.fillText(line, s.x + 5, s.y + 4 + i * fs * 1.45));
    } else {
      ctx.fillStyle = look.label;
      ctx.font = Math.max(6, 9 * k) + "px -apple-system, 'PingFang SC', sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (s.w > 18 && s.h > 12) ctx.fillText(nodeKindLabel(node.kind), s.x + s.w / 2, s.y + s.h / 2);
    }
    ctx.restore();
  }
  return canvas.toDataURL("image/png");
}