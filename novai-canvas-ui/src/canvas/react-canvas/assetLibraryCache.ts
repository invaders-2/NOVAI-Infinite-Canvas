type Command = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
const cache = new Map<string, Promise<Record<string, unknown>>>();

export function cachedAssetCommand(api: { command: Command }, request: Record<string, unknown>) {
  const key = JSON.stringify(request);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = api.command(request)
    .then((result) => {
      if (!result || result.ok !== true) cache.delete(key);
      return result;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, pending);
  return pending;
}

import { setHostHook } from "../../novaiBridgeRoot";

export function clearAssetCache() {
  cache.clear();
}

if (typeof window !== "undefined") {
  setHostHook("__novaiAssetCacheClear", clearAssetCache);
}
