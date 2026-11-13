/**
 * 拖进画布的图片上传策略：按「后端能不能原样存住」分三档。
 *   direct  —— 后端白名单格式（png/jpg/jpeg/webp/gif），原字节上传；GIF 动图必须走这里，转码会丢动画。
 *   convert —— 浏览器能解码、但后端只认上面几种扩展名的格式（SVG / BMP / AVIF）：先在浏览器里
 *              用 canvas 转 PNG（保留透明）再上传。不改的话后端会把它按扩展名存成 .png，
 *              字节却不转码 —— 变成「叫 .png 的坏文件」，节点既不显示也不报错。
 *   reject  —— 浏览器自己也解不了的格式（TIFF / HEIC 等）：明确提示，不上传坏文件。
 * 判定和尺寸计算都是纯函数（不碰 DOM），方便单测（tests/test_novai_canvas_image_upload_format.js）。
 */
export type ImageUploadMode = "direct" | "convert" | "reject";

export interface ImageUploadPlan {
  mode: ImageUploadMode;
  /** 实际上传用的文件名：convert 时扩展名换成 .png，其余原样 */
  name: string;
  /** 格式名（SVG / BMP / TIFF …），给提示文案用 */
  format: string;
}

/** 浏览器转 PNG 允许的最大长边：再大 PNG 体积和内存都不划算，超过就等比缩到这个尺寸 */
export const CONVERT_MAX_SIDE = 4096;
/** SVG 没有固有尺寸时的兜底长边 */
export const SVG_FALLBACK_SIDE = 2048;

const DIRECT_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const CONVERT_EXTS = new Set([".svg", ".bmp", ".avif"]);
const DIRECT_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
// image/x-ms-bmp 是 Windows 上常见的 BMP MIME，和 image/bmp 一起收
const CONVERT_MIMES = new Set(["image/svg+xml", "image/bmp", "image/x-ms-bmp", "image/avif"]);

const extOf = (name: string) => { const m = /\.[^./\\]+$/.exec(String(name || "").trim()); return m ? m[0].toLowerCase() : ""; };
const stemOf = (name: string) => String(name || "").trim().replace(/\.[^./\\]+$/, "") || "image";

function formatLabel(ext: string, mime: string): string {
  if (ext) return ext.slice(1).toUpperCase();
  const sub = String(mime || "").split("/")[1] || "";
  return sub ? sub.toUpperCase() : "该";
}

/** 扩展名优先（拖拽来的 type 偶尔为空或不准）；扩展名认不出时再按 MIME */
export function planImageUpload(file: { name: string; type: string }): ImageUploadPlan {
  const ext = extOf(file.name);
  const mime = String(file.type || "").toLowerCase();
  if (DIRECT_EXTS.has(ext)) return { mode: "direct", name: file.name, format: formatLabel(ext, mime) };
  if (CONVERT_EXTS.has(ext)) return { mode: "convert", name: stemOf(file.name) + ".png", format: formatLabel(ext, mime) };
  if (DIRECT_MIMES.has(mime)) return { mode: "direct", name: file.name, format: formatLabel(ext, mime) };
  if (CONVERT_MIMES.has(mime)) return { mode: "convert", name: stemOf(file.name) + ".png", format: formatLabel(ext, mime) };
  return { mode: "reject", name: file.name, format: formatLabel(ext, mime) };
}

export const isSvgImage = (file: { name: string; type: string }) =>
  extOf(file.name) === ".svg" || String(file.type || "").toLowerCase() === "image/svg+xml";

/**
 * SVG 没写 width/height 也没有 viewBox 时，浏览器按默认 300×150 解码 —— 这不是作者要的尺寸，
 * 照它转 PNG 就是一张糊图，所以按「没有固有尺寸」处理，交给 convertTargetSize 用长边兜底。
 */
export function hasNoIntrinsicSize(file: { name: string; type: string }, size: { naturalWidth: number; naturalHeight: number }): boolean {
  const w = Number(size.naturalWidth) || 0;
  const h = Number(size.naturalHeight) || 0;
  if (!(w > 0 && h > 0)) return true;
  return isSvgImage(file) && w === 300 && h === 150;
}

/** 转 PNG 的输出尺寸：常规按原尺寸（长边超过 CONVERT_MAX_SIDE 才等比缩），无固有尺寸时按长边 SVG_FALLBACK_SIDE 兜底 */
export function convertTargetSize(w: number, h: number, opts: { sizeless?: boolean } = {}): { w: number; h: number } {
  // 浏览器给「无固有尺寸」的图报的默认尺寸是 300×150，留作兜底时的宽高比
  const valid = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  const srcW = valid ? w : 300;
  const srcH = valid ? h : 150;
  const long = Math.max(srcW, srcH);
  const target = opts.sizeless ? SVG_FALLBACK_SIDE : Math.min(long, CONVERT_MAX_SIDE);
  const k = target / long;
  return { w: Math.max(1, Math.round(srcW * k)), h: Math.max(1, Math.round(srcH * k)) };
}

export interface ConvertedImage { dataUrl: string; w: number; h: number }

/** 浏览器里解码 → canvas 转 PNG（不铺底色，保留透明）。解不出来返回 null，调用方按「暂不支持」提示，不上传坏文件。 */
export async function convertImageToPng(file: File): Promise<ConvertedImage | null> {
  const raw = await new Promise<string>((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => resolve("");
    fr.readAsDataURL(file);
  });
  if (!raw) return null;
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = raw;
  });
  if (!image) return null;
  const size = convertTargetSize(image.naturalWidth, image.naturalHeight, { sizeless: hasNoIntrinsicSize(file, image) });
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, size.w, size.h);
  try { return { dataUrl: canvas.toDataURL("image/png"), w: size.w, h: size.h }; } catch { return null; }
}
