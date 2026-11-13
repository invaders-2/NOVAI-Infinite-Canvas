/**
 * 从内嵌素材浏览器 / 系统浏览器把图片或视频拖进画布。
 *
 * 桌面端把原生 WebContentsView 叠在面板上，拖出来的数据是 text/uri-list / text/plain（见
 * desktop/source-drag-preload.js），dataTransfer.files 是空的 —— 只认 files 的话拖进来毫无反应。
 * 这里把 URL 交给 /api/local-assets/import-urls 存成本机素材文件（旧站点的时效签名链接会过期，
 * 直接引用外链迟早裂图），拿到本地 url / kind / 宽高后按图片 / 视频落成节点。
 */
import { fitSourceBox } from "../mediaFit";
import type { CanvasStore } from "../store";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";

/** 一次拖拽最多处理多少条：够用又不至于一次打爆本地服务 */
const MAX_URLS = 20;
const IMAGE_W = 240;
const VIDEO_W = 320;
const GAP = 30;

type MediaKind = "image" | "video" | "audio";
type ImportedRow = { url: string; name: string; kind: MediaKind; width: number | null; height: number | null };
type GuestDrag = {
  uriList?: string;
  bestUrl?: string;
  imageCandidates?: Array<string | { url?: string }>;
  videoCandidates?: Array<string | { url?: string }>;
  mediaUrl?: string;
  src?: string;
  urls?: string[];
  html?: string;
};

/** 主进程在内嵌页上下文里预取到的图片字节（'guest-drag-bytes' 的返回，20s 内有效） */
type GuestBytes = { url: string; dataUrl: string; contentType: string; size: number; originalUrl: string };
type ImportItem = { url: string; data?: string; content_type?: string; name?: string };

function collectUrls(value: string, out: string[]) {
  for (const line of String(value || "").split(/\r?\n/)) {
    const url = line.trim();
    // uri-list 允许以 # 开头的注释行
    if (!url || url.startsWith("#")) continue;
    if (!/^(https?:\/\/|data:(?:image|video)\/)/i.test(url)) continue;
    out.push(url);
  }
}

/** 拖拽载荷里的候选地址：优先 text/uri-list，没有再看 text/plain / text/html 里的 src */
export function urlsFromDataTransfer(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const out: string[] = [];
  collectUrls(dt.getData("text/uri-list"), out);
  if (!out.length) collectUrls(dt.getData("text/plain"), out);
  if (!out.length) {
    const html = dt.getData("text/html");
    if (html) for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) collectUrls(match[1], out);
  }
  return Array.from(new Set(out));
}

function candidateUrls(list: GuestDrag["imageCandidates"]): string[] {
  const out: string[] = [];
  for (const item of list || []) {
    const url = typeof item === "string" ? item : item && item.url;
    collectUrls(String(url || ""), out);
  }
  return out;
}

/** 桥没回应时的等待上限：卡住比报错更糟——整次 drop 会静默挂死，连「没读到地址」的提示都不出现 */
const GUEST_DRAG_TIMEOUT_MS = 1200;

/** 桌面端兜底：起拖时主进程记下了那一次拖拽的元素（60s 内有效），iframe 的 drop 载荷为空时用它补 */
async function guestDragUrls(): Promise<string[]> {
  const api = (window as unknown as { pywebview?: { api?: { get_last_guest_drag?: () => Promise<unknown> } } }).pywebview?.api;
  if (!api || typeof api.get_last_guest_drag !== "function") return [];
  let payload: unknown;
  try {
    payload = await Promise.race([
      api.get_last_guest_drag(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GUEST_DRAG_TIMEOUT_MS)),
    ]);
  } catch { return []; }
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const drag = (row.drag && typeof row.drag === "object" ? row.drag : null) as GuestDrag | null;
  if (!drag) return [];
  const out: string[] = [];
  collectUrls(String(drag.uriList || ""), out);
  collectUrls(String(drag.bestUrl || ""), out);
  collectUrls(String(drag.mediaUrl || ""), out);
  collectUrls(String(drag.src || ""), out);
  for (const url of drag.urls || []) collectUrls(String(url), out);
  if (!out.length) for (const url of candidateUrls(drag.imageCandidates)) collectUrls(url, out);
  if (!out.length) for (const url of candidateUrls(drag.videoCandidates)) collectUrls(url, out);
  return Array.from(new Set(out));
}

/** 字节通道的等待上限：主进程自己 20s 超时，这里只防「父窗口不回包」把整次 drop 挂死 */
const GUEST_BYTES_TIMEOUT_MS = 21000;

/**
 * 桌面字节通道：主进程在内嵌页上下文里（带站点自己的网络环境）已经预取到图片字节。
 * pinimg 的 originals 对无 referer 的服务器下载直接 403、部分网络下压根连不通，
 * 交给后端按 URL 下载必然失败，所以有字节就用字节。
 */
async function guestDragBytes(urls: string[]): Promise<{ bytes: GuestBytes | null; reason: string }> {
  const api = (window as unknown as { pywebview?: { api?: { get_guest_drag_bytes?: () => Promise<unknown> } } }).pywebview?.api;
  if (!api || typeof api.get_guest_drag_bytes !== "function") return { bytes: null, reason: "" };
  // 字节只对应「最近一次拖拽」的那一张图，多张一起拖容易串图，交给 URL 通道
  if (urls.length !== 1) return { bytes: null, reason: "" };
  let payload: unknown;
  try {
    payload = await Promise.race([
      api.get_guest_drag_bytes(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GUEST_BYTES_TIMEOUT_MS)),
    ]);
  } catch (error) {
    return { bytes: null, reason: error instanceof Error ? error.message : "字节通道异常" };
  }
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (row.ok !== true) {
    const error = String(row.error || "").trim();
    // 视频 / 没有预取记录这类属于常态，不该在最终提示里当失败理由
    if (!error || /no-drag|no-image-prefetch|视频不预取|没有可预取的图片 URL|内嵌浏览器未打开/.test(error)) return { bytes: null, reason: "" };
    return { bytes: null, reason: !payload ? "字节通道无响应" : error };
  }
  const dataUrl = String(row.dataUrl || "");
  if (!dataUrl) return { bytes: null, reason: "字节通道没有返回图片数据" };
  const originalUrl = String(row.originalUrl || "");
  const url = String(originalUrl || row.url || urls[0] || "");
  // 预取的是「上一次拖的图」时宁可走 URL 下载，也不落错图：按尺寸段归一后比主路径
  if (urls[0] && url && primaryPathKey(urls[0]) && primaryPathKey(url) && primaryPathKey(urls[0]) !== primaryPathKey(url)) return { bytes: null, reason: "" };
  return { bytes: { url, dataUrl, contentType: String(row.contentType || "").split(";")[0].trim(), size: Number(row.size) || 0, originalUrl }, reason: "" };
}

/** pinimg / 花瓣同一张图有多种尺寸地址（originals、736x、_fw658…）：归一后比较主路径 */
function primaryPathKey(value: string): string {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname
      .replace(/\/(?:originals|1200x|736x|474x|236x|75x75)\//gi, "/")
      .replace(/_(?:fw|sq)\d+(?=\.|$)/gi, "");
    return parsed.hostname.toLowerCase() + path;
  } catch { return ""; }
}

function errorOf(data: unknown, status: number): string {
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const detail = row.detail ?? row.error ?? row.message;
  const text = typeof detail === "string" ? detail.trim() : "";
  if (text) return text;
  if (detail && typeof detail === "object") {
    const inner = (detail as Record<string, unknown>).message ?? (detail as Record<string, unknown>).error;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  return "请求失败（HTTP " + status + "）";
}

/** 素材 → 本机素材文件；沿用旧版智能画布的 import-urls 报文，逐条回报成功 / 失败原因 */
async function importItems(items: ImportItem[]): Promise<{ rows: ImportedRow[]; failed: string[] }> {
  let response: Response;
  try {
    response = await fetch("/api/local-assets/import-urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  } catch (error) {
    throw new Error("连不上本地服务：" + (error instanceof Error ? error.message : "网络错误"));
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorOf(data, response.status));
  const returned = Array.isArray((data as Record<string, unknown>)?.items) ? (data as { items: unknown[] }).items : [];
  const rows: ImportedRow[] = [];
  const failed: string[] = [];
  for (const raw of returned) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    if (row.ok !== true) { failed.push(String(row.error || row.url || "导入失败")); continue; }
    const item = (row.item && typeof row.item === "object" ? row.item : {}) as Record<string, any>;
    const url = String(item.url || "").trim();
    if (!url) { failed.push(String(row.url || "导入接口没有返回本地地址")); continue; }
    const kind = String(item.kind || "image");
    if (kind !== "image" && kind !== "video") {
      failed.push(String(item.name || url) + "：只支持把图片或视频拖进画布");
      continue;
    }
    const width = Number(item.width ?? item.natural_w);
    const height = Number(item.height ?? item.natural_h);
    rows.push({ url, name: String(item.name || "").trim(), kind, width: Number.isFinite(width) && width > 0 ? width : null, height: Number.isFinite(height) && height > 0 ? height : null });
  }
  if (!returned.length) failed.push("导入接口没有返回任何结果");
  return { rows, failed };
}

/** URL 版：只有地址可交（浏览器模式 / 字节通道不可用时） */
function importUrls(urls: string[]): Promise<{ rows: ImportedRow[]; failed: string[] }> {
  return importItems(urls.map((url) => ({ url })));
}

function probeImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function probeVideo(url: string): Promise<{ width: number; height: number; duration: number | null } | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let done = false;
    const finish = (value: { width: number; height: number; duration: number | null } | null) => {
      if (done) return;
      done = true;
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish({ width: video.videoWidth || 0, height: video.videoHeight || 0, duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null });
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/** 按图片 / 视频落节点：宽 240 / 320 起步，高按真实比例（太扁时宽度等比放大，不夹高度压比例）；一批按拖放点居中排开 */
async function insertSourceRows(store: CanvasStore, at: { x: number; y: number }, rows: ImportedRow[]) {
  const made: CanvasNode[] = [];
  const plan: Array<{ row: ImportedRow; rawW: number; rawH: number; duration: number; box: { w: number; h: number } }> = [];
  for (const row of rows) {
    const meta = row.kind === "video" ? await probeVideo(row.url) : await probeImage(row.url);
    const rawW = meta?.width || row.width || (row.kind === "video" ? 16 : 1);
    const rawH = meta?.height || row.height || (row.kind === "video" ? 9 : 1);
    const base = row.kind === "video" ? VIDEO_W : IMAGE_W;
    const box = fitSourceBox(rawW, rawH, { baseW: base }) || { w: base, h: base };
    const duration = row.kind === "video" ? Number((meta as { duration?: number | null } | null)?.duration || 0) : 0;
    plan.push({ row, rawW, rawH, duration, box });
  }
  const total = plan.reduce((sum, x) => sum + x.box.w, 0) + GAP * Math.max(0, plan.length - 1);
  let cursor = at.x - total / 2;
  for (const { row, rawW, rawH, duration, box } of plan) {
    const title = (row.name || (row.kind === "video" ? "在线视频" : "在线图片")).replace(/\.[^.]+$/, "").slice(0, 24);
    const hist = {
      url: row.url,
      w: rawW,
      h: rawH,
      ...(row.kind === "video" && duration ? { dur: Math.round(duration * 100) / 100 } : {}),
    };
    const node = store.newNode(row.kind === "video" ? "video" : "image", cursor, at.y - box.h / 2, {
      title,
      uploaded: true,
      hist: [hist],
      w: box.w,
      h: box.h,
    });
    made.push(node);
    cursor += box.w + GAP;
  }
  if (!made.length) return;
  store.addNodes(made);
  store.setUI({ sel: new Set(made.map((node) => node.id)), edge: null });
}

async function placeImported(store: CanvasStore, at: { x: number; y: number }, rows: ImportedRow[]): Promise<boolean> {
  if (!rows.length) return false;
  await insertSourceRows(store, at, rows);
  store.toast(rows.some((row) => row.kind === "video") ? `已从在线素材添加 ${rows.length} 个素材` : `已从在线素材添加 ${rows.length} 张图片`);
  return true;
}

/** drop 事件统一入口：有文件走原有上传，没有文件按「桌面字节 → URL」两条通道落节点 */
export async function dropSourceUrls(store: CanvasStore, at: { x: number; y: number }, dt: DataTransfer | null) {
  let urls = urlsFromDataTransfer(dt);
  // 原生视图起拖的素材，iframe 有时只拿得到空载荷：再问一次主进程记下的那次拖拽
  if (!urls.length) urls = await guestDragUrls();
  if (!urls.length) { store.toast("没读到拖进来的素材地址，请从在线素材面板里重新拖一次", 4200); return; }
  if (urls.length > MAX_URLS) { urls = urls.slice(0, MAX_URLS); store.toast(`一次最多导入 ${MAX_URLS} 个，已取前 ${MAX_URLS} 个`, 4200); }
  store.toast(urls.length > 1 ? `正在导入 ${urls.length} 个素材…` : "正在导入素材…");

  const failed: string[] = [];
  let placed = false;
  let bytesFailure = "";

  // 字节优先：Pinterest 的 originals 对无 referer 下载回 403、部分网络下装不上代理就超时，
  // 而主进程在内嵌页里已经预取到同一张图的字节（中等尺寸就够，不为原图再等 60s）
  const bytes = await guestDragBytes(urls);
  if (bytes.bytes) {
    try {
      const result = await importItems([{ url: bytes.bytes.url, data: bytes.bytes.dataUrl, content_type: bytes.bytes.contentType }]);
      placed = await placeImported(store, at, result.rows);
      failed.push(...result.failed);
    } catch (error) {
      bytesFailure = "字节通道：" + (error instanceof Error ? error.message : "未知原因");
    }
  } else if (bytes.reason) bytesFailure = "字节通道：" + bytes.reason;

  if (!placed) {
    try {
      const result = await importUrls(urls);
      placed = await placeImported(store, at, result.rows);
      failed.push(...result.failed);
    } catch (error) {
      failed.push("地址下载：" + (error instanceof Error ? error.message : "未知原因"));
    }
  }

  if (!placed) {
    if (bytesFailure) failed.unshift(bytesFailure);
    store.toast("在线素材导入失败：" + (failed.slice(0, 2).join("；") || "未知原因"), 6000);
  } else if (failed.length) {
    store.toast("有 " + failed.length + " 个没导入：" + failed.slice(0, 2).join("；"), 6000);
  }
}