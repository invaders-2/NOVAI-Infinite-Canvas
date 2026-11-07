/**
 * 上传前的体积保护：无损改图 / 调色都会产出几十上百 MB 的 PNG，直接 POST 会被后端体积上限挡掉（413），
 * 用户只看到「图片出不来」。先降到 maxBytes 以内再传，并避开浏览器 canvas 的画布上限。
 *
 * 阶梯压缩顺序移植自旧智能画布（static/js/smart-canvas.js 38035-38130）：
 * 有透明先留 PNG（不丢透明），压不下来再用白底 JPEG q95 逐级降边；无透明直接保尺寸转 JPEG q95。
 */
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
export const CANVAS_MAX_SIDE = 16384;
export const CANVAS_MAX_PIXELS = 260000000;
export type CompressStep = { format: "image/png" | "image/jpeg"; quality?: number; maxSide: number; flatten?: boolean };
export type CompressedUpload = { dataUrl: string; name: string };

/** 单边 >16384 或面积 >2.6 亿像素时 canvas.toBlob 直接回 null，先等比降采样 */
export function fitWithinCanvasLimits(width: number, height: number) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0, scale: 1 };
  const scale = Math.min(1, CANVAS_MAX_SIDE / Math.max(w, h), Math.sqrt(CANVAS_MAX_PIXELS / (w * h)));
  if (!(scale < 1)) return { width: w, height: h, scale: 1 };
  // 向下取整：round 会把面积顶出上限一点点，toBlob 仍可能回 null
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale };
}

export function scaleToMaxSide(width: number, height: number, maxSide: number) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  if (!maxSide || Math.max(w, h) <= maxSide) return { width: w, height: h };
  const scale = maxSide / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** 有透明先留 PNG（不丢透明），压不下来再用白底 JPEG；无透明直接保尺寸转 JPEG q95 */
export function compressSteps(hasAlpha: boolean): CompressStep[] {
  const sides = [8192, 6144, 4096, 3072, 2048];
  const out: CompressStep[] = [];
  const push = (format: CompressStep["format"], maxSide: number, flatten?: boolean) => out.push(format === "image/jpeg" ? { format, quality: 0.95, maxSide, flatten } : { format, maxSide });
  if (hasAlpha) {
    [0, ...sides].forEach((maxSide) => push("image/png", maxSide));
    [0, ...sides].forEach((maxSide) => push("image/jpeg", maxSide, true));
  } else {
    [0, ...sides].forEach((maxSide) => push("image/jpeg", maxSide));
  }
  return out;
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  if (typeof dataUrl !== "string" || dataUrl.slice(0, 5) !== "data:") return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const mime = header.split(";")[0] || "image/png";
  try {
    const binary = /;base64/i.test(header) ? atob(dataUrl.slice(comma + 1)) : decodeURIComponent(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: mime });
  } catch { return null; }
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("读取压缩结果失败"));
    fr.readAsDataURL(blob);
  });
}

/** objectURL 要等 canvas 编码完再释放：有些浏览器 load 之后就 revoke 会让 drawImage 画不出来 */
export function loadBlobImage(blob: Blob) {
  return new Promise<{ img: HTMLImageElement | null; release: () => void }>((resolve) => {
    const url = URL.createObjectURL(blob);
    const release = () => { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } };
    const img = new Image();
    img.onload = () => resolve({ img, release });
    img.onerror = () => resolve({ img: null, release });
    img.src = url;
  });
}

/** 只看一张 64px 缩略图的 alpha：漏判时 JPEG 走白底压平，和后端压缩一致 */
export function blobHasAlpha(img: HTMLImageElement, width: number, height: number) {
  const w = Math.max(1, Math.min(64, Math.round(width)));
  const h = Math.max(1, Math.min(64, Math.round(height * (w / Math.max(1, width)))));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  } catch { return false; }
  return false;
}

export function drawToBlob(img: HTMLImageElement, width: number, height: number, step: CompressStep) {
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) return Promise.resolve<Blob | null>(null);
  if (step.flatten) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => c.toBlob((b) => resolve(b), step.format, step.quality));
}

/** 按阶梯重编码，第一份 <= maxBytes 的即采用；全都压不下来返回 null（交回原图，由后端压缩兜底） */
export async function compressBlob(blob: Blob, name: string, maxBytes: number) {
  const loaded = await loadBlobImage(blob);
  const img = loaded.img;
  if (!img || !img.naturalWidth || !img.naturalHeight) { loaded.release(); return null; }
  try {
    const limit = fitWithinCanvasLimits(img.naturalWidth, img.naturalHeight);
    const hasAlpha = blobHasAlpha(img, limit.width, limit.height);
    const base = String(name || "image").replace(/\.[^.]+$/, "");
    for (const step of compressSteps(hasAlpha)) {
      const size = step.maxSide ? scaleToMaxSide(limit.width, limit.height, step.maxSide) : limit;
      const out = await drawToBlob(img, size.width, size.height, step);
      if (!out || !out.size) continue;
      if (out.size <= maxBytes) return { blob: out, name: base + (step.format === "image/jpeg" ? ".jpg" : ".png") };
    }
    return null;
  } finally { loaded.release(); }
}

/**
 * dataUrl 超过 maxBytes 时按阶梯压缩。
 * 返回 null 表示「不需要压」或「压不下来」——两种情况都交回原图（后端还有一层压缩兜底），
 * 调用方只在拿到结果时提示用户「已自动压缩」。
 */
export async function compressForUpload(dataUrl: string, name: string, maxBytes: number = MAX_UPLOAD_BYTES): Promise<CompressedUpload | null> {
  if (!(maxBytes > 0)) return null;
  const blob = dataUrlToBlob(dataUrl);
  if (!blob || blob.size <= maxBytes) return null;
  const small = await compressBlob(blob, name, maxBytes);
  if (!small) return null;
  return { dataUrl: await blobToDataUrl(small.blob), name: small.name };
}
