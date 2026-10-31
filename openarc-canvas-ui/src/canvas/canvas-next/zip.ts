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

/** 同名文件自动加序号：海报.png、海报 (2).png … */
export function uniqueNames(names: string[]): string[] {
  const used = new Map<string, number>(); const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/[\\/:*?"<>|]/g, "_") || "file";
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
