/**
 * 本地存储键名的迁移读。
 *
 * 新版本一律写 novai-* / novai:*；升级前写下的 openarc-* / openarc:* 是旧键。
 * 读一律走 readMigratedKey：先读新键，没有就回落旧键，并把值搬进新键（旧键不删——
 * 同机的旧版本、外部脚本还按旧键读，删了它们就读到空值）。只做读兼容，历史数据不迁移。
 */

const legacyOf = (key: string): string => {
  if (key.startsWith("novai-")) return "openarc-" + key.slice("novai-".length);
  if (key.startsWith("novai:")) return "openarc:" + key.slice("novai:".length);
  return key; // 没有旧名字的键（外部键）原样
};

const storageOf = (kind: "local" | "session"): Storage | null => {
  try { return kind === "session" ? sessionStorage : localStorage; } catch { return null; /* 无存储（隐私模式）时按没有值 */ }
};

/**
 * 读一个键：先新键，缺失时回落 oldKey（缺省由新键推旧键）。
 * 命中旧键时顺手写进新键，下一次直接读新键；旧键保留。
 */
export function readMigratedKey(newKey: string, oldKey: string = legacyOf(newKey), kind: "local" | "session" = "local"): string | null {
  const store = storageOf(kind);
  if (!store) return null;
  try {
    const fresh = store.getItem(newKey);
    if (fresh !== null) return fresh;
    const legacy = store.getItem(oldKey);
    if (legacy === null) return null;
    store.setItem(newKey, legacy);
    return legacy;
  } catch {
    return null;
  }
}

/**
 * 清掉一个键：新旧一起删。
 * 只删新键会把旧值留在旧键里，下次读又把它当「迁移」搬回来（用户刚选回「自动」又变回旧值）。
 */
export function removeMigratedKey(key: string, kind: "local" | "session" = "local"): void {
  const store = storageOf(kind);
  if (!store) return;
  try { store.removeItem(key); store.removeItem(legacyOf(key)); } catch { /* 忽略 */ }
}

/** sessionStorage 的迁移读（键同样换成 novai-*）。 */
export function readMigratedSessionKey(newKey: string, oldKey: string = legacyOf(newKey)): string | null {
  return readMigratedKey(newKey, oldKey, "session");
}
