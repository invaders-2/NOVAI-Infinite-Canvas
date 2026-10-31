import { useEffect, useState } from "react";
import { useCtl } from "./ctx";
import { useAssetUrl } from "./useAsset";

/**
 * 视频 / 音频播放地址。
 *
 * 资源库里的媒体优先拿主进程的流式地址（openarc-resource://…，支持 Range）：不用把整段文件转成 base64
 * 传过来，节点一出现就能显示首帧，播放时也能随意拖动。拿不到（旧后端、共享来的资源、地址失效）时
 * 退回 useAssetUrl 的 data URL。外链结果先由 useAssetUrl 同一条路径转存进资源库。
 */
type Hit = { url: string; exp: number };
const cache = new Map<string, Hit>();
const pending = new Map<string, Promise<Hit | null>>();
/** 播放器报错过的地址：同一会话里不再用流式地址，直接走 data URL */
const broken = new Set<string>();

export function forgetMediaUrl(ref: string) { cache.delete(ref); broken.add(ref); }

export function useMediaUrl(src: string): { url: string; stream: boolean; onError: () => void } {
  const ctl = useCtl(); const be = ctl.store.backend;
  const canStream = !!be.mediaUrl && src.startsWith("openarc-asset:") && !broken.has(src);
  const fresh = (h?: Hit) => !!h && h.exp > Date.now() + 60_000;
  const [hit, setHit] = useState<Hit | null>(() => { const h = cache.get(src); return canStream && fresh(h) ? h! : null; });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!canStream) { setHit(null); return; }
    const h = cache.get(src); if (fresh(h)) { setHit(h!); return; }
    let p = pending.get(src);
    if (!p) {
      p = be.mediaUrl!(src).then((r) => (r ? { url: r.url, exp: r.expiresAt } : null)).catch(() => null);
      pending.set(src, p);
    }
    let alive = true;
    p.then((r) => { pending.delete(src); if (r) cache.set(src, r); if (alive) { if (r) setHit(r); else setFailed(true); } });
    return () => { alive = false; };
  }, [src, canStream, be]);
  // 流式拿不到才去读整段（避免两条路同时读大文件）
  const needData = !canStream || failed;
  const data = useAssetUrl(needData ? src : "");
  const onError = () => { if (canStream && hit) { forgetMediaUrl(src); setFailed(true); } };
  if (!needData && hit) return { url: hit.url, stream: true, onError };
  return { url: needData ? data : "", stream: false, onError };
}
