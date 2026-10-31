import { useEffect, useState } from "react";
import { useCtl } from "./ctx";

/**
 * openarc-asset:<ref> → 可显示的地址；普通地址原样返回。
 *
 * 缓存规则：
 *   · 只缓存成功结果；读失败（网络抖动、主进程忙）不进缓存，下次渲染会重试；
 *   · 按字符总量做 LRU：视频 data URL 可达上百 MB，超过上限就淘汰最久没用的，避免越用越卡；
 *   · 服务商外链转存失败时退回显示原链接（链接过期前仍能看到），而不是空白。
 */
const MAX_CACHE_CHARS = 300 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheChars = 0;
const pending = new Map<string, Promise<string | null>>();

function cacheGet(key: string): string | undefined {
  const v = cache.get(key); if (v === undefined) return undefined;
  cache.delete(key); cache.set(key, v); // 最近使用移到末尾
  return v;
}
function cachePut(key: string, value: string) {
  const old = cache.get(key); if (old !== undefined) { cacheChars -= old.length; cache.delete(key); }
  cache.set(key, value); cacheChars += value.length;
  for (const [k, v] of cache) { if (cacheChars <= MAX_CACHE_CHARS || k === key) break; cache.delete(k); cacheChars -= v.length; }
}

export function useAssetUrl(src: string): string {
  const ctl = useCtl();
  // 桌面版里外链（服务商结果）不能直接显示：先由主进程下载进资源库再显示
  const be = ctl.store.backend;
  const remote = be.kind === "bridge" && !!be.importRemote && /^https?:\/\//i.test(src);
  const isRef = src.startsWith("openarc-asset:") || remote;
  const [url, setUrl] = useState<string>(isRef ? cacheGet(src) || "" : src);
  useEffect(() => {
    if (!isRef) { setUrl(src); return; }
    const hit = cacheGet(src); if (hit !== undefined) { setUrl(hit); return; }
    let p = pending.get(src);
    if (!p) {
      p = (src.startsWith("openarc-asset:") ? be.resolveAsset(src)
        : be.importRemote!(ctl.store.state.canvasId, src, "远程结果").then((ref) => (ref.startsWith("openarc-asset:") ? be.resolveAsset(ref) : null)).then((u) => u || src))
        .catch(() => (remote ? src : null));
      pending.set(src, p);
    }
    let alive = true;
    p.then((u) => { pending.delete(src); if (u && u !== src) cachePut(src, u); if (alive) setUrl(u || ""); });
    return () => { alive = false; };
  }, [src, isRef, remote, ctl]);
  return url;
}

/** 非 hook 版本：openarc-asset:<ref> → data URL（和 useAssetUrl 共用缓存），时间线播放 / 导出用 */
export async function resolveMediaUrl(be: { resolveAsset(ref: string): Promise<string | null> }, src: string): Promise<string> {
  if (!src.startsWith("openarc-asset:")) return src;
  const hit = cacheGet(src); if (hit !== undefined) return hit;
  let p = pending.get(src);
  if (!p) { p = be.resolveAsset(src).catch(() => null); pending.set(src, p); }
  const u = await p; pending.delete(src); if (u && u !== src) cachePut(src, u);
  return u || "";
}
