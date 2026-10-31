import { useEffect, useState } from "react";
import { useAssetUrl } from "./useAsset";

const MAX_EDGE = 768;
const MAX_ITEMS = 80;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function thumbnail(src: string): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const long = Math.max(image.naturalWidth, image.naturalHeight);
      if (long <= MAX_EDGE) { resolve(src); return; }
      const scale = MAX_EDGE / long;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/webp", .84));
    };
    image.onerror = () => resolve(src);
    image.src = src;
  });
}

/** 节点显示专用的小图；原图仍由资源库和生成请求使用，避免拖动时重复解码超大照片。 */
export function useThumbnailUrl(src: string): string {
  const full = useAssetUrl(src);
  const [url, setUrl] = useState(full);
  useEffect(() => {
    if (!full.startsWith("data:image/")) { setUrl(full); return; }
    const hit = cache.get(full);
    if (hit) { setUrl(hit); return; }
    let alive = true;
    let job = pending.get(full);
    if (!job) { job = thumbnail(full); pending.set(full, job); }
    job.then((small) => {
      pending.delete(full);
      cache.set(full, small);
      if (cache.size > MAX_ITEMS) cache.delete(cache.keys().next().value!);
      if (alive) setUrl(small);
    });
    return () => { alive = false; };
  }, [full]);
  return url;
}
