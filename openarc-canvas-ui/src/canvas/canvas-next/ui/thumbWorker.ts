/// <reference lib="webworker" />
/**
 * 缩略图后台线程：data URL → Blob → createImageBitmap（解码 + 缩放），整个过程不占界面线程。
 * 收：{ id, url, px, aspect }；回：{ id, bmp }（ImageBitmap 以 transfer 方式交回），失败时 bmp 为 null。
 */
const opt = (a: number, px: number): ImageBitmapOptions => (a >= 1 ? { resizeWidth: px, resizeQuality: "high" } : { resizeHeight: px, resizeQuality: "high" });
function blobOf(url: string): Blob {
  const i = url.indexOf(","); const meta = url.slice(5, i); const body = url.slice(i + 1);
  const bin = meta.endsWith(";base64") ? atob(body) : decodeURIComponent(body);
  const arr = new Uint8Array(bin.length); for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
  return new Blob([arr], { type: meta.split(";")[0] || "image/png" });
}
self.onmessage = async (e: MessageEvent<{ id: number; url: string; px: number; aspect: number }>) => {
  const { id, url, px, aspect } = e.data;
  try {
    const blob = blobOf(url);
    let bmp = await createImageBitmap(blob, opt(aspect, px));
    if (Math.max(bmp.width, bmp.height) > px * 1.05) { const a = bmp.width / bmp.height; bmp.close(); bmp = await createImageBitmap(blob, opt(a, px)); }
    (self as unknown as Worker).postMessage({ id, bmp }, [bmp]);
  } catch { (self as unknown as Worker).postMessage({ id, bmp: null }); }
};
