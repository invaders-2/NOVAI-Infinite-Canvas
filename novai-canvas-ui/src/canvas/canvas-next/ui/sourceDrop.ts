/**
 * 从内嵌素材浏览器 / 系统浏览器把图片或视频拖进画布。
 *
 * 桌面端把原生 WebContentsView 叠在面板上，拖出来的数据是 text/uri-list / text/plain（见
 * desktop/source-drag-preload.js），dataTransfer.files 是空的 —— 只认 files 的话拖进来毫无反应。
 * 这里把 URL 交给 /api/local-assets/import-urls 存成本机素材文件（旧站点的时效签名链接会过期，
 * 直接引用外链迟早裂图），拿到本地 url / kind / 宽高后按图片 / 视频落成节点。
 *
 * 视频比图片多一层坑：小红书这类播放器用 MSE 播放，拖拽载荷里的地址是 blob:（甚至压根没有地址），
 * 后端下载不了。所以「没有 http 地址」时先回主进程抓到的最近视频请求里找真链，再按
 * 地址下载 → 页面内取字节 → 主进程带登录态下载 三条通道依次兜底。
 *
 * 桌面桥的真实返回形状是 { ok: true, drag: {...} }（desktop/main.js 的 last-drag），
 * 不是 { http, blobs, video } —— 本文件里的 GuestDragInfo 只是解析后的内部结构，别照它改桥。
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
  videoUrls?: string[];
  mediaUrl?: string;
  src?: string;
  urls?: string[];
  html?: string;
  tagName?: string;
  sourceTag?: string;
  pageUrl?: string;
};
type DesktopApi = {
  get_last_guest_drag?: () => Promise<unknown>;
  get_guest_drag_bytes?: () => Promise<unknown>;
  get_recent_source_media?: () => Promise<unknown>;
  get_source_view_fetch_bytes?: (arg: unknown, maxBytes?: number) => Promise<unknown>;
  fetch_source_url?: (arg: unknown, referer?: string) => Promise<unknown>;
};
type GuestDragInfo = { http: string[]; blobs: string[]; pageUrl: string; video: boolean };

/** 主进程在内嵌页上下文里预取到的图片字节（'guest-drag-bytes' 的返回，20s 内有效） */
type GuestBytes = { url: string; dataUrl: string; contentType: string; size: number; originalUrl: string };
type ImportItem = { url: string; data?: string; content_type?: string; name?: string };

const NO_SOURCE_URL_TEXT = "没读到拖进来的素材地址，请从在线素材面板里重新拖一次";

function desktopApi(): DesktopApi | null {
  const api = (window as unknown as { pywebview?: { api?: unknown } }).pywebview?.api;
  return api && typeof api === "object" ? (api as DesktopApi) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知原因");
}

function unique(list: string[]): string[] {
  return Array.from(new Set(list));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

function collectUrls(value: string, out: string[]) {
  for (const line of String(value || "").split(/\r?\n/)) {
    const url = line.trim();
    // uri-list 允许以 # 开头的注释行
    if (!url || url.startsWith("#")) continue;
    if (!/^(https?:\/\/|data:(?:image|video)\/)/i.test(url)) continue;
    out.push(url);
  }
}

/** blob: 单收：后端下载不了这类地址，只能回到内嵌页面里取字节 */
function collectBlobUrls(value: string, out: string[]) {
  for (const line of String(value || "").split(/\r?\n/)) {
    const url = line.trim();
    if (!url || url.startsWith("#")) continue;
    if (!/^blob:/i.test(url)) continue;
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

/** 载荷里只有 blob: 时（视频走 MSE 播放）单独捞出来 */
export function blobUrlsFromDataTransfer(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const out: string[] = [];
  collectBlobUrls(dt.getData("text/uri-list"), out);
  if (!out.length) collectBlobUrls(dt.getData("text/plain"), out);
  if (!out.length) {
    const html = dt.getData("text/html");
    if (html) for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) collectBlobUrls(match[1], out);
  }
  return Array.from(new Set(out));
}

/** 拖拽载荷自带的一小段 HTML 里再捞一遍（<video>/<source>/<img> 的 src）：优先级最低，只做兜底 */
function collectHtmlSources(html: string, out: string[], blobs: string[]) {
  const text = String(html || "");
  if (!text) return;
  for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    collectUrls(match[1], out);
    collectBlobUrls(match[1], blobs);
  }
}

/** 站点页面地址（不是素材本身）：拖错层时别把它当图片/视频导进来 */
function isPageLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (!/(^|\.)(xiaohongshu\.com|pinterest\.com|huaban\.com)$/i.test(parsed.hostname)) return false;
    return /(?:^|\/)(?:explore|discovery|pins?|boards?|search)(?:\/|$)/i.test(parsed.pathname || "");
  } catch { return false; }
}

/** HLS 播放列表：后端只能拿到一张播放列表，下不了整段视频，别白等一次下载 */
function isHlsUrl(value: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(String(value || ""));
}

/** fMP4 / HLS 分片：只有 2~6 秒的一小段（或 init 索引段），拼不成整段视频 */
function isFragmentUrl(value: string, contentType = ""): boolean {
  if (/video\/iso\.segment/i.test(String(contentType || ""))) return true;
  const text = String(value || "");
  if (/\.(?:m4s|m4a|ts)(?:[?#]|$)/i.test(text)) return true;
  return /\/init\.mp4(?:[?#]|$)/i.test(text);
}

/** 分片排在整段后面：同一批候选里有整段时先用整段，别拿碎片去导 */
function fragmentsLast(urls: string[]): string[] {
  return urls.filter((url) => !isFragmentUrl(url)).concat(urls.filter((url) => isFragmentUrl(url)));
}

function candidateUrls(list: GuestDrag["imageCandidates"], out: string[], blobs: string[] = []) {
  for (const item of list || []) {
    const url = typeof item === "string" ? item : item && item.url;
    const text = String(url || "");
    collectUrls(text, out);
    collectBlobUrls(text, blobs);
  }
}

/** 桥没回应时的等待上限：卡住比报错更糟——整次 drop 会静默挂死，连「没读到地址」的提示都不出现 */
const GUEST_DRAG_TIMEOUT_MS = 1200;

/** 桌面端兜底：读主进程记下的那一次拖拽（60s 内有效）。同时带回 blob 地址与「拖的是视频」这个线索 */
async function guestDragInfo(): Promise<GuestDragInfo> {
  const empty: GuestDragInfo = { http: [], blobs: [], pageUrl: "", video: false };
  const api = desktopApi();
  if (!api || typeof api.get_last_guest_drag !== "function") return empty;
  let payload: unknown;
  try {
    payload = await withTimeout(api.get_last_guest_drag(), GUEST_DRAG_TIMEOUT_MS);
  } catch { return empty; }
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const drag = (row.drag && typeof row.drag === "object" ? row.drag : null) as GuestDrag | null;
  if (!drag) return empty;
  const http: string[] = [];
  const blobs: string[] = [];
  const add = (value: unknown) => {
    const text = String(value || "");
    collectUrls(text, http);
    collectBlobUrls(text, blobs);
  };
  const video = /^VIDEO$/i.test(String(drag.tagName || drag.sourceTag || "")) || (drag.videoCandidates || []).length > 0;
  // 视频元素自己的地址最准：小红书这类页面 mediaUrl 常是 blob，videoUrls 里才藏着真链
  if (video) {
    for (const url of drag.videoUrls || []) add(url);
    candidateUrls(drag.videoCandidates, http, blobs);
  }
  add(drag.uriList);
  add(drag.bestUrl);
  add(drag.mediaUrl);
  add(drag.src);
  for (const url of drag.urls || []) add(url);
  collectHtmlSources(String(drag.html || ""), http, blobs);
  // 主要字段全空时才翻候选列表：同一张图常有多档尺寸地址，混进来会让「单图字节通道」失效
  if (!http.length && !blobs.length) {
    if (!video) candidateUrls(drag.imageCandidates, http, blobs);
    if (!http.length && !blobs.length) candidateUrls(drag.videoCandidates, http, blobs);
    if (!http.length && !blobs.length) for (const url of drag.videoUrls || []) add(url);
  }
  return { http: fragmentsLast(unique(http)), blobs: unique(blobs), pageUrl: String(drag.pageUrl || ""), video };
}

const RECENT_MEDIA_TIMEOUT_MS = 900;
const RECENT_MEDIA_MAX = 4;

/** 主进程抓到的最近视频请求（120s 内）：blob 播放时靠它还原出可下载的真链 */
async function recentVideoUrls(pageUrl: string): Promise<string[]> {
  const api = desktopApi();
  if (!api || typeof api.get_recent_source_media !== "function") return [];
  let payload: unknown;
  try {
    payload = await withTimeout(api.get_recent_source_media(), RECENT_MEDIA_TIMEOUT_MS);
  } catch { return []; }
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const list = row.items ?? row.media ?? row.urls ?? row.list;
  const entries = Array.isArray(list) ? (list as unknown[]) : [];
  const picked: Array<{ url: string; time: number; same: boolean; hls: boolean; fragment: boolean }> = [];
  for (const entry of entries) {
    const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const url = String(obj ? obj.url ?? obj.src ?? obj.mediaUrl ?? "" : entry ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (String((obj && obj.kind) || "").toLowerCase() !== "video") continue;
    picked.push({
      url,
      time: Number(obj && obj.time) || 0,
      // 同一页面拖下来的才最可能是刚拖的那一条
      same: !pageUrl || String((obj && obj.pageUrl) || "") === pageUrl,
      hls: /\.m3u8(?:[?#]|$)/i.test(url),
      fragment: isFragmentUrl(url),
    });
  }
  // 整段优先于分片 → 同页面优先 → mp4 优先于 m3u8（m3u8 后端下不了整段视频） → 越新越优先
  picked.sort((a, b) => Number(a.fragment) - Number(b.fragment) || Number(b.same) - Number(a.same) || Number(a.hls) - Number(b.hls) || b.time - a.time);
  return unique(picked.map((item) => item.url)).slice(0, RECENT_MEDIA_MAX);
}

/** 字节通道的等待上限：主进程自己 20s 超时，这里只防「父窗口不回包」把整次 drop 挂死 */
const GUEST_BYTES_TIMEOUT_MS = 21000;

/**
 * 桌面字节通道：主进程在内嵌页上下文里（带站点自己的网络环境）已经预取到图片字节。
 * pinimg 的 originals 对无 referer 的服务器下载直接 403、部分网络下压根连不通，
 * 交给后端按 URL 下载必然失败，所以有字节就用字节。
 */
async function guestDragBytes(urls: string[]): Promise<{ bytes: GuestBytes | null; reason: string }> {
  const api = desktopApi();
  if (!api || typeof api.get_guest_drag_bytes !== "function") return { bytes: null, reason: "" };
  // 字节只对应「最近一次拖拽」的那一张图，多张一起拖容易串图，交给 URL 通道
  if (urls.length !== 1) return { bytes: null, reason: "" };
  let payload: unknown;
  try {
    payload = await withTimeout(api.get_guest_drag_bytes(), GUEST_BYTES_TIMEOUT_MS);
  } catch (error) {
    return { bytes: null, reason: messageOf(error) || "字节通道异常" };
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
    throw new Error("连不上本地服务：" + messageOf(error));
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

type ChannelOutcome = { rows: ImportedRow[]; failed: string[]; reasons: string[] };
type FetchedBytes = { ok: true; dataUrl: string; contentType: string } | { ok: false; reason: string };

/** 页面内取字节 / 主进程带登录态取字节的统一收尾：通道没装或没响应时不算失败原因 */
async function fetchedBytes(call: () => Promise<unknown>, timeoutMs: number, label: string): Promise<FetchedBytes> {
  let payload: unknown;
  try {
    payload = await withTimeout(call(), timeoutMs);
  } catch (error) {
    return { ok: false, reason: label + "：" + messageOf(error) };
  }
  if (!payload) return { ok: false, reason: "" };
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const dataUrl = String(row.dataUrl || "");
  if (row.ok !== true || !dataUrl) {
    const error = String(row.error || "").trim();
    const status = Number(row.status) || 0;
    if (!error && !status) return { ok: false, reason: "" };
    const detail = error === "too-large" ? "素材超过 30MB" : status ? "HTTP " + status : error;
    return { ok: false, reason: label + "：" + detail };
  }
  return { ok: true, dataUrl, contentType: String(row.contentType || "").split(";")[0].trim() };
}

const PAGE_BYTES_MAX = 30 * 1024 * 1024;
const PAGE_BYTES_TIMEOUT_MS = 21000;
const SESSION_FETCH_TIMEOUT_MS = 31000;

/** 内嵌页面上下文里 fetch：带站点自己的 referer / cookie，blob: 也能取（MSE 的取不到） */
async function pageBytes(url: string): Promise<FetchedBytes> {
  const api = desktopApi();
  const fn = api && api.get_source_view_fetch_bytes;
  if (typeof fn !== "function") return { ok: false, reason: "" };
  return fetchedBytes(async () => {
    try { return await fn({ url, maxBytes: PAGE_BYTES_MAX }); }
    catch { return await fn(url, PAGE_BYTES_MAX); }
  }, PAGE_BYTES_TIMEOUT_MS, "页面取字节");
}

/** 主进程 session.fetch：走系统代理 / 登录态，后端直连被 403 时用 */
async function sessionBytes(url: string, referer: string): Promise<FetchedBytes> {
  const api = desktopApi();
  const fn = api && api.fetch_source_url;
  if (typeof fn !== "function") return { ok: false, reason: "" };
  return fetchedBytes(async () => {
    try { return await fn({ url, referer }); }
    catch { return await fn(url, referer); }
  }, SESSION_FETCH_TIMEOUT_MS, "带登录态下载");
}

/** 字节内联进 import-urls：后端不用再下载，站点防盗链也拦不住 */
async function importFetched(url: string, fetched: FetchedBytes): Promise<ChannelOutcome> {
  if (fetched.ok !== true) return { rows: [], failed: [], reasons: fetched.reason ? [fetched.reason] : [] };
  // 地址上看不出、响应头是分支片（video/iso.segment）时同样不导：后端只会回同一句拒收
  if (isFragmentUrl(url, fetched.contentType)) return { rows: [], failed: [], reasons: ["拿到的是视频分片（.m4s），不是整段视频"] };
  try {
    const result = await importItems([{ url, data: fetched.dataUrl, content_type: fetched.contentType }]);
    return { rows: result.rows, failed: result.failed, reasons: [] };
  } catch (error) {
    return { rows: [], failed: [], reasons: ["内联导入：" + messageOf(error)] };
  }
}

async function importChannel(urls: string[]): Promise<ChannelOutcome> {
  try {
    const result = await importUrls(urls);
    return { rows: result.rows, failed: result.failed, reasons: [] };
  } catch (error) {
    return { rows: [], failed: [], reasons: ["地址下载：" + messageOf(error)] };
  }
}

/** 地址下载失败后的两条兜底：先页面取字节，再主进程带登录态下载。成功即停，不重复落节点 */
const MAX_FALLBACKS = 3;
async function importFallbacks(store: CanvasStore, at: { x: number; y: number }, urls: string[], pageUrl: string, failed: string[]): Promise<boolean> {
  for (const url of urls.slice(0, MAX_FALLBACKS)) {
    // 分片走三条兜底拿到的还是同一段字节，别让用户看三遍「不是图片或视频资源」
    if (isFragmentUrl(url)) continue;
    const page = await importFetched(url, await pageBytes(url));
    failed.push(...page.reasons, ...page.failed);
    if (page.rows.length && await placeImported(store, at, page.rows)) return true;
    const session = await importFetched(url, await sessionBytes(url, pageUrl));
    failed.push(...session.reasons, ...session.failed);
    if (session.rows.length && await placeImported(store, at, session.rows)) return true;
  }
  return false;
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
  store.toast(rows.some((row) => row.kind === "video") ? "已从在线素材添加 " + rows.length + " 个素材" : "已从在线素材添加 " + rows.length + " 张图片");
  return true;
}

/** drop 事件统一入口：有文件走原有上传，没有文件按「桌面字节 → 地址下载 → 页面字节 → 登录态下载」落节点 */
export async function dropSourceUrls(store: CanvasStore, at: { x: number; y: number }, dt: DataTransfer | null) {
  let urls = urlsFromDataTransfer(dt);
  let blobs = blobUrlsFromDataTransfer(dt);
  let drag: GuestDragInfo = { http: [], blobs: [], pageUrl: "", video: false };
  // 原生视图起拖的素材，iframe 有时只拿得到空载荷：再问一次主进程记下的那次拖拽
  if (!urls.length) {
    drag = await guestDragInfo();
    urls = drag.http;
    blobs = unique([...blobs, ...drag.blobs]);
  }
  const videoIntent = drag.video || blobs.length > 0;
  // 页面地址（小红书笔记页 / Pinterest 图钉页）不是素材本身；HLS 播放列表下不了整段
  const pageHits = urls.filter(isPageLikeUrl);
  urls = urls.filter((url) => !isPageLikeUrl(url));
  const hlsHits = urls.filter(isHlsUrl);
  urls = urls.filter((url) => !isHlsUrl(url));
  if (!urls.length && !blobs.length && (pageHits.length || hlsHits.length)) {
    if (hlsHits.length) {
      store.toast("这条视频是 HLS（m3u8）流，只能拿到播放列表、下不了整段；换一条直链视频再拖", 12000);
      return;
    }
    store.toast("拖进来的是页面地址而不是素材，请在面板里直接按住图片/视频再拖", 5200);
    return;
  }
  if (!urls.length && !blobs.length) {
    store.toast(videoIntent ? "没读到这条视频的可下载地址（页面可能用加密流播放），先在素材面板里播放几秒再拖一次" : NO_SOURCE_URL_TEXT, 4200);
    return;
  }
  const failed: string[] = [];
  const reasons: string[] = [];
  let placed = false;
  let bytesFailure = "";

  if (!urls.length && blobs.length) {
    // 视频在页面上是 blob:（MSE 播放）时，回主进程抓到的最近视频请求里找真实地址
    urls = await recentVideoUrls(drag.pageUrl);
    if (!urls.length) {
      reasons.push(desktopApi()
        ? "页面用的是加密流（blob）播放，没抓到可下载的视频地址"
        : "浏览器模式读不到这类加密流视频的地址，请在桌面版里拖，或换一条能直接下载的视频");
    }
  }
  // 同一批候选里有整段时先导整段，分片排后面
  urls = fragmentsLast(urls);

  // 只剩 fMP4 / HLS 分片：每片只有 2~6 秒，后端既拼不成整段也认不出类型，别静默 import
  if (urls.length && urls.every((url) => isFragmentUrl(url))) {
    console.info("[sourceDrop] 只拿到视频分片，已跳过导入：" + urls.join(" "));
    store.toast("这条视频拿到的是加密分片（.m4s），下不了整段；先在面板里把视频播完、或换一条直链 mp4 再拖", 12000);
    return;
  }

  if (urls.length) {
    if (urls.length > MAX_URLS) { urls = urls.slice(0, MAX_URLS); store.toast("一次最多导入 " + MAX_URLS + " 个，已取前 " + MAX_URLS + " 个", 4200); }
    store.toast(urls.length > 1 ? "正在导入 " + urls.length + " 个素材…" : "正在导入素材…");

    // 字节优先：Pinterest 的 originals 对无 referer 下载回 403、部分网络下装不上代理就超时，
    // 而主进程在内嵌页里已经预取到同一张图的字节（中等尺寸就够，不为原图再等 60s）
    const bytes = await guestDragBytes(urls);
    if (bytes.bytes) {
      try {
        const result = await importItems([{ url: bytes.bytes.url, data: bytes.bytes.dataUrl, content_type: bytes.bytes.contentType }]);
        placed = await placeImported(store, at, result.rows);
        failed.push(...result.failed);
      } catch (error) {
        bytesFailure = "字节通道：" + messageOf(error);
      }
    } else if (bytes.reason) bytesFailure = "字节通道：" + bytes.reason;

    if (!placed) {
      const channel = await importChannel(urls);
      placed = await placeImported(store, at, channel.rows);
      failed.push(...channel.failed, ...channel.reasons);
      if (!placed) placed = await importFallbacks(store, at, urls, drag.pageUrl, failed);
    }
  } else if (blobs.length) {
    // 只剩 blob: 能试：只能回内嵌页面里取字节（MSE 的 blob 取不到，会落到下面的失败提示）
    store.toast("正在从素材面板取素材…");
    placed = await importFallbacks(store, at, blobs, drag.pageUrl, failed);
  }

  if (!placed) {
    const all = [...(bytesFailure ? [bytesFailure] : []), ...reasons, ...failed];
    // URL 上没有后缀的分片真链，只能等后端认出来：同样给可操作引导，别只甩一句 400
    if (all.some((text) => text.indexOf("视频分片") >= 0)) {
      console.info("[sourceDrop] 后端认出视频分片，已跳过导入：" + urls.join(" "));
      store.toast("这条视频拿到的是加密分片（.m4s），下不了整段；先在面板里把视频播完、或换一条直链 mp4 再拖", 12000);
      return;
    }
    store.toast("在线素材导入失败：" + (all.slice(0, 2).join("；") || "未知原因"), 6000);
  } else if (failed.length) {
    store.toast("有 " + failed.length + " 个没导入：" + failed.slice(0, 2).join("；"), 6000);
  }
}
