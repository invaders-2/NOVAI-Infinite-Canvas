/**
 * 下载命名统一规则（老板要求）：文件名里不带原标题，只用 NOVAI + 时间。
 *   · 单文件：NOVAI-20261106-094500.png
 *   · 打包：NOVAI-20261106-094500.zip，zip 内 NOVAI-20261106-094500-1.png、-2.png…（单个不加序号）
 * 同一批下载共用一次 stamp()（一次点击 = 一个时间），不逐文件取时间。
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地时间 → 20261106-094500 */
export function stamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 清掉文件名里的非法字符（CJK / 空格保留） */
export function safeName(name: string, fallback = "未命名"): string {
  return (name || "").replace(/[\\/:*?"<>|]/g, "_").trim() || fallback;
}

/** 单文件：NOVAI-<时间>.<ext>（不带原文件名 / 节点标题） */
export function novaiName(ext: string, ts = stamp()): string {
  return `NOVAI-${ts}.${safeName(ext, "bin").replace(/^\.+/, "")}`;
}

/** 打包：NOVAI-<时间>.zip */
export function novaiZipName(ts = stamp()): string {
  return `NOVAI-${ts}.zip`;
}

/**
 * 连续保存多张（同一秒内多次调用）时自动带 -2、-3…，避免互相覆盖；
 * 第一次仍是不带序号的 NOVAI-<时间>.<ext>。
 */
let seqStamp = ""; let seqCount = 0;
export function novaiNext(ext: string): string {
  const ts = stamp();
  if (ts !== seqStamp) { seqStamp = ts; seqCount = 0; }
  seqCount += 1;
  return seqCount === 1 ? novaiName(ext, ts) : `NOVAI-${ts}-${seqCount}.${safeName(ext, "bin").replace(/^\.+/, "")}`;
}

/** zip 内条目：单个不加序号；多个按顺序 NOVAI-<时间>-1.ext、-2.ext… */
export function novaiEntry(ext: string, index: number, total: number, ts = stamp()): string {
  const tail = `${safeName(ext, "bin").replace(/^\.+/, "")}`;
  return total > 1 ? `NOVAI-${ts}-${index + 1}.${tail}` : `NOVAI-${ts}.${tail}`;
}
