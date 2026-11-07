/**
 * 最小 ZIP 打包（只存储不压缩）：批量下载把多张图 / 多段视频打成一个文件。
 * 图片、视频本身已是压缩格式，再压缩收益很小；不压缩也不用额外依赖。
 * 文件名按 UTF-8 写（通用标志位 bit 11），macOS / Windows 解压中文名都正常。
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 清理单段文件名里的非法字符（保留目录分隔符，工作流资源放在 assets/ 下） */
const cleanSegment = (raw: string) => raw.replace(/[\\:*?"<>|]/g, "_");
const cleanPath = (raw: string) => raw.split("/").map(cleanSegment).join("/");

/** 同名文件自动加序号：海报.png、海报 (2).png … */
export function uniqueNames(names: string[]): string[] {
  const used = new Map<string, number>(); const out: string[] = [];
  for (const raw of names) {
    const name = cleanPath(raw) || "file";
    const key = name.toLowerCase();
    const n = (used.get(key) || 0) + 1; used.set(key, n);
    if (n === 1) { out.push(name); continue; }
    const dot = name.lastIndexOf(".");
    let next = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    while (used.has(next.toLowerCase())) next = "_" + next;
    used.set(next.toLowerCase(), 1); out.push(next);
  }
  return out;
}

function unicodePathExtra(name: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + name.length); const view = new DataView(out.buffer);
  view.setUint16(0, 0x7075, true); view.setUint16(2, 5 + name.length, true); out[4] = 1; view.setUint32(5, crc32(name), true); out.set(name, 9);
  return out;
}

export async function makeZip(files: Array<{ name: string; data: Blob | Uint8Array }>): Promise<Blob> {
  const enc = new TextEncoder(); const parts: BlobPart[] = []; const central: Uint8Array[] = [];
  let offset = 0;
  const d = new Date(); const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const names = uniqueNames(files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) {
    const bytes = files[i].data instanceof Uint8Array ? files[i].data as Uint8Array : new Uint8Array(await (files[i].data as Blob).arrayBuffer());
    const name = enc.encode(names[i]); const crc = crc32(bytes); const extra = unicodePathExtra(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true); local.setUint16(26, name.length, true); local.setUint16(28, extra.length, true);
    parts.push(local.buffer as ArrayBuffer, name as BlobPart, extra as BlobPart, bytes as BlobPart);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true); c.setUint16(30, extra.length, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + extra.length + name.length); entry.set(new Uint8Array(c.buffer), 0); entry.set(name, 46); entry.set(extra, 46 + name.length); central.push(entry);
    offset += 30 + name.length + extra.length + bytes.length;
  }
  const size = central.reduce((s, e) => s + e.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer as ArrayBuffer], { type: "application/zip" });
}

/* ---------- 只读解析：导入含资源的 ZIP ---------- */

export type ZipEntry = { name: string; data: Uint8Array };

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;

/** deflate-raw 解压：浏览器 / Node 18+ 的 DecompressionStream，不给额外依赖 */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const D = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (typeof D !== "function") throw new Error("当前环境不支持解压 ZIP（缺少 DecompressionStream）");
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new D("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error("ZIP 解压失败：压缩数据损坏");
  }
}

/**
 * 读取 ZIP 里的全部文件：走中央目录，支持 store(0) 和 deflate(8)；
 * 条目名按 UTF-8 解（makeZip 写的通用标志位 bit 11），并校验 CRC32，坏包给可读错误。
 */
export async function readZip(input: Blob | ArrayBuffer | Uint8Array): Promise<ZipEntry[]> {
  const buffer = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("文件不是有效的 ZIP 包");
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("不支持 ZIP64 格式");
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder("utf-8");
  let offset = cdOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || view.getUint32(offset, true) !== SIG_CENTRAL) throw new Error("ZIP 目录损坏，无法读取");
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (method !== 0 && method !== 8) throw new Error(`ZIP 里的「${name}」使用了不支持的压缩方式（${method}）`);
    if (localOffset + 30 > buffer.length || view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`ZIP 里的「${name}」文件头损坏`);
    const dataAt = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataAt + compSize > buffer.length) throw new Error(`ZIP 里的「${name}」数据不完整`);
    const raw = buffer.subarray(dataAt, dataAt + compSize);
    const data = method === 0 ? raw.slice() : await inflateRaw(raw);
    if (crc32(data) !== crc) throw new Error(`ZIP 里的「${name}」校验失败，文件已损坏`);
    entries.push({ name, data });
  }
  return entries;
}
