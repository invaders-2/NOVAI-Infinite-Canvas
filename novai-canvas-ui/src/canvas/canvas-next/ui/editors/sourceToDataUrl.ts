/**
 * 源图 → dataURL（长边压到 maxSide）：拆分 / 编辑工具都要把宿主图塞进 iframe，走同一份实现。
 * 画布里的地址可能是 novai-asset: 引用，调用方先解析成可 fetch 的地址再传进来。
 */
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("图片解码失败"));
    im.src = src;
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("读取图片失败"));
    fr.readAsDataURL(blob);
  });
}

export async function toDataUrl(url: string, maxSide: number) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error("图片读取失败（HTTP " + res.status + "）");
  const raw = await blobToDataUrl(await res.blob());
  const im = await loadImage(raw);
  const sw = im.naturalWidth || 0;
  const sh = im.naturalHeight || 0;
  if (!sw || !sh) throw new Error("图片尺寸读取失败");
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  if (scale >= 1) return { image: raw, width: sw, height: sh };
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("无法创建画布");
  g.imageSmoothingQuality = "high";
  g.drawImage(im, 0, 0, w, h);
  // 原图有透明通道就继续用 PNG，照片类走 JPEG（体积小、后端拆分够用）
  const png = /^data:image\/png/i.test(raw);
  return { image: c.toDataURL(png ? "image/png" : "image/jpeg", 0.92), width: w, height: h };
}
