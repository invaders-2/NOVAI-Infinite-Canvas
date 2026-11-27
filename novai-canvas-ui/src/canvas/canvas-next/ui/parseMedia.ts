/**
 * 节点工具条上的「解析」：把节点当前的画面交给视觉模型。
 * 视频走专用流程：把视频地址交给后端自己抽整条片子的关键帧（table_only + video_url），
 * 后端读不到的地址（blob: / data: / 素材引用解析失败）才退回本地等距 8 帧；
 * 只建一张「解析 · 分镜表」表格节点（连到视频节点、选中），不建文本节点。
 * 图片走「文本」：只建文本节点放四段提示词（连上源 → 文本的边），不建表格。
 * 「更多 › 解析当前帧」仍按老的单帧走，只建文本节点。
 *
 * 放在 ui/ 的原因：这个动作要 toast、要选中并带出新建的节点，视频取帧又直接复用
 * ui/editors/registry 的 grabVideoFrame / grabVideoFrameAt（桌面版的流式地址也能取），跟界面同一层最省。
 *
 * 不挂到画布运行时（runNode）上：这里只读画面、没有模型参数 / 版本 / 批量这些概念，
 * 挂上去会把「一个节点同一时间只能跑一个生成」的通道白白占住。
 */
import { isAssetRef } from "../../canvasAssetRefs";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { bounds, clampTrim, genOf, outOf, uid } from "../model";
import { normalizeTable, tableOf, withTable, type TableData } from "../table";
import type { CanvasStore } from "../store";
import { toDataUrl } from "./editors/sourceToDataUrl";
import { grabVideoFrame, grabVideoFrameAt } from "./editors/registry";
import type { Ctl } from "./ctx";

const ENDPOINT = "/api/canvas-analyze-media";
/** 长边上限与 JPEG 质量：视觉模型够看，又能把体积压到 8MB 以内 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.9;
const MAX_BYTES = 8 * 1024 * 1024;
/** 后端读不到视频地址时，前端本地兜底取几帧（等距） */
const FRAME_COUNT = 6;
/** 兜底帧比单图更省：长边 896 / JPEG 0.85，别把 body 撑大 */
const FALLBACK_EDGE = 896;
const FALLBACK_QUALITY = 0.85;
const MAX_FRAMES = 8;
const TIMEOUT_MS = 90 * 1000;
/** 分镜表：视频节点右侧 / 文本节点正下方 80px，宽 1240 高 360 */
const TABLE_TITLE = "解析 · 分镜表";
const TABLE_W = 1240;
const TABLE_H = 360;
/** 建表占位用的 12 列表头（和后端契约一致）；响应里的 columns 会整列替换它 */
const TABLE_COLUMNS = ["镜号", "时长", "画面描述", "角色", "角色描述", "景别", "情绪", "光影氛围", "音效", "对白", "分镜提示词", "视频运动提示词"];

/**
 * 分镜模板（「更多 › 解析设置」）：列与后端 CANVAS_ANALYZE_TEMPLATES 一致。
 * 首帧由后端按每镜开始时间截图，起止由后端按模型给的 start/end 算。
 */
export type ParseTemplate = "storyboard" | "ecom" | "lite";
export const PARSE_TEMPLATES: Array<{ id: ParseTemplate; label: string; desc: string; columns: string[] }> = [
  { id: "storyboard", label: "完整分镜", desc: "16 列，含首帧、起止、机位、运镜",
    columns: ["镜号", "首帧", "起止", "时长", "画面描述", "角色", "角色描述", "景别", "机位", "运镜", "情绪", "光影氛围", "音效", "对白", "分镜提示词", "视频运动提示词"] },
  { id: "ecom", label: "电商短视频", desc: "多出卖点、字幕文案、音乐",
    columns: ["镜号", "首帧", "起止", "时长", "画面描述", "景别", "机位", "运镜", "卖点", "字幕文案", "音乐", "分镜提示词", "视频运动提示词"] },
  { id: "lite", label: "精简", desc: "7 列，只留出图要用的",
    columns: ["镜号", "首帧", "起止", "画面描述", "景别", "运镜", "分镜提示词"] },
];
const PARSE_SETTINGS_KEY = "novai_canvas_parse_settings_v1";
export type ParseSettings = { template: ParseTemplate };
/** 本机记住上次的解析设置；读不到 / 不认识就用「完整分镜」 */
export function getParseSettings(): ParseSettings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PARSE_SETTINGS_KEY) || "{}");
    const t = raw && typeof raw === "object" ? (raw as { template?: unknown }).template : "";
    if (PARSE_TEMPLATES.some((x) => x.id === t)) return { template: t as ParseTemplate };
  } catch { /* 隐私模式等读不到就用默认 */ }
  return { template: "storyboard" };
}
export function setParseSettings(next: ParseSettings): void {
  try { localStorage.setItem(PARSE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* 存不了就只这次生效 */ }
}
const templateColumns = (id: ParseTemplate) => PARSE_TEMPLATES.find((x) => x.id === id)?.columns || TABLE_COLUMNS;
/** 「起止」只是给人看的时间码，不该拼进出图提示词：列用途固定为「不使用」 */
function storyboardRoles(columns: string[]): string[] | undefined {
  const roles = columns.map((c) => (c === "起止" ? "skip" : ""));
  return roles.some(Boolean) ? roles : undefined;
}
/** 长视频后端可能「首次 100 秒 + 降级重试一次」，最坏 200 秒上下；视频接口超时按 300 秒给 */
const VIDEO_TIMEOUT_MS = 300 * 1000;
/** 超时的人话：AbortError 的原始信息（signal is aborted without reason）不往界面吐 */
const VIDEO_TIMEOUT_TEXT = "等待超时（这次用了 5 分钟）：素材可能太大，可以重试或换一段更短的视频";
/** 新文本节点的落点：源节点右侧留 140，和别的节点撞上就按 60 往下让 */
const GAP_X = 140;
const DROP_Y = 60;
const TEXT_W = 420;
const TEXT_H = 380;
/** 已经露出多少像素就算「看得见」，不必再动视图（同 agent/revealNodes 的口径） */
const VISIBLE_MARGIN = 24;

/** 按节点 id 防重复点击：同一节点解析中再点直接忽略，不并发打接口 */
const inFlight = new Set<string>();

/** 素材库页「反推设置」的本机记忆（web/src/pages/assets/lib/state.js 的 LOCAL_CAPTION_SETTINGS_KEY） */
const CAPTION_SETTINGS_KEY = "asset_manager_local_caption_settings_v1";

const SECTION_TITLES = {
  cnPos: "【中文 · 正向】",
  cnNeg: "【中文 · 负向】",
  enPos: "【English · Positive】",
  enNeg: "【English · Negative】",
} as const;
type SectionKey = keyof typeof SECTION_TITLES;
const SECTION_ORDER: SectionKey[] = ["cnPos", "cnNeg", "enPos", "enNeg"];

/** 模型的标记行：[中文正向] / 【English Positive】 这类方括号，后面可以跟冒号和正文 */
const MARKER_RE = /^[\s>*_#-]*[\[【]\s*([^\]】\n]{1,40}?)\s*[\]】][\s*_]*[:：]?[ \t]*(.*)$/;

const normalizeLabel = (raw: string) => raw.replace(/[\s·•.．、_\-—–:：/]/g, "").toLowerCase();

function sectionOf(label: string): SectionKey | null {
  const t = normalizeLabel(label);
  if (!t) return null;
  if (/[\u4e00-\u9fa5]/.test(t)) {
    if (t.includes("负")) return "cnNeg";
    if (t.includes("正")) return "cnPos";
    return null;
  }
  if (t.includes("negative")) return "enNeg";
  if (t.includes("positive")) return "enPos";
  return null;
}

/**
 * 模型输出（[中文正向]…）→ 四段式正文（【中文 · 正向】…）。
 * 四段没收齐（模型少写一段 / 换了别的标记）就整段照原文写：不拼半成品，也不替模型编内容。
 */
export function formatParsedPrompt(raw: string): string {
  const text = String(raw || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | null = null;
  for (const line of text.split("\n")) {
    const mark = MARKER_RE.exec(line);
    const key = mark ? sectionOf(mark[1]) : null;
    if (key && mark) {
      current = key;
      if (!sections.has(key)) sections.set(key, []);
      if (mark[2].trim()) sections.get(key)!.push(mark[2]);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }
  const complete = SECTION_ORDER.every((key) => (sections.get(key) || []).join("\n").trim());
  if (!complete) return text;
  return SECTION_ORDER.map((key) => `${SECTION_TITLES[key]}\n${(sections.get(key) || []).join("\n").trim()}`).join("\n\n");
}

/** fetch 被 AbortController 掐断：不同浏览器 / 环境里 instanceof DOMException 不一定成立，按 name / message 兜底 */
function isAbortError(error: unknown): boolean {
  const name = error && typeof error === "object" ? String((error as { name?: unknown }).name || "") : "";
  const message = error instanceof Error ? error.message : "";
  return name === "AbortError" || /signal is aborted|aborted without reason/i.test(message);
}

/** data URL 的实际字节数（base64 每 4 个字符 3 字节，文件头不算） */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? 0 : Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/**
 * 统一转成 JPEG（默认 0.9）：toDataUrl 对长边已经 ≤1280 的图会原样返回，
 * 一张透明 PNG 照样能到几十 MB，发出去也只会被接口拒掉，所以这里固定再编码一次。
 */
function encodeJpeg(dataUrl: string, maxEdge = MAX_EDGE, quality = JPEG_QUALITY): Promise<string> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth; const h = im.naturalHeight;
      if (!w || !h) { reject(new Error("读不到画面尺寸")); return; }
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("无法创建画布")); return; }
      // JPEG 没有透明通道，透明 PNG 直接画会变成黑底，先铺白
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    im.onerror = () => reject(new Error("画面解码失败"));
    im.src = dataUrl;
  });
}

/** novai-asset: 引用 → 能画的地址；data URL 与外链原样返回 */
async function fetchable(store: CanvasStore, url: string): Promise<string> {
  if (!url) return "";
  if (!isAssetRef(url)) return url;
  return (await store.backend.resolveAsset(url).catch(() => null)) || "";
}

async function imageDataUrl(store: CanvasStore, node: CanvasNode): Promise<string> {
  const url = outOf(node)?.url || "";
  if (!url) throw new Error("这个节点还没有可解析的画面");
  const src = await fetchable(store, url);
  if (!src) throw new Error("读取画面失败：素材引用已失效");
  // 复用编辑器的源图处理：取字节 + 长边压到 MAX_EDGE
  const prep = await toDataUrl(src, MAX_EDGE).catch(() => null);
  if (!prep) throw new Error("读取画面失败（素材可能已失效或跨域）");
  return encodeJpeg(prep.image);
}

/** 视频帧：正在播的那一帧 → 封面 → 首帧（取首帧时 grabVideoFrame 自己会按使用区间取） */
async function videoFrameDataUrl(store: CanvasStore, node: CanvasNode): Promise<string> {
  const o = outOf(node);
  if (!o?.url && !o?.frame) throw new Error("这个节点还没有可解析的画面");
  const live = document.querySelector<HTMLVideoElement>(`.node[data-id="${node.id}"] video`);
  if (live?.videoWidth) {
    const current = await grabVideoFrame(store, node, "current");
    if (current) return encodeJpeg(current);
  }
  if (o?.frame) {
    const cover = await fetchable(store, o.frame);
    const prep = cover ? await toDataUrl(cover, MAX_EDGE).catch(() => null) : null;
    if (prep) return encodeJpeg(prep.image);
  }
  const first = await grabVideoFrame(store, node, "first");
  if (!first) throw new Error("取不到画面：视频还没加载出来");
  return encodeJpeg(first);
}

/**
 * 视频兜底帧：后端读不到地址时，在「使用区间」里均匀取 FRAME_COUNT 个时间点（有 trim 按 trim.in→trim.out，
 * 没有就 0→真实时长），每帧缩到长边 ≤896 的 JPEG 0.85；取不到 / 重复的帧跳过，至少留 1 帧。
 */
async function videoFrames(store: CanvasStore, node: CanvasNode): Promise<{ images: string[]; duration: number }> {
  const o = outOf(node);
  if (!o?.url && !o?.frame) throw new Error("这个节点还没有可解析的画面");
  const trim = o?.trim ? clampTrim(o.dur, o.trim) : null;
  const from = trim ? trim.in : 0;
  const head = await grabVideoFrameAt(store, node, from);
  // 真实时长用来算等分点；请求里的 duration 仍按 outOf().dur（拿不到就不带）
  const total = head.duration > 0 ? head.duration : Number(o?.dur) || 0;
  const to = trim ? Math.min(trim.out, total || trim.out) : (total > 0 ? total : from);
  const images: string[] = [];
  const add = async (data: string) => {
    if (!data) return;
    const jpeg = await encodeJpeg(data, FALLBACK_EDGE, FALLBACK_QUALITY).catch(() => "");
    if (jpeg && !images.includes(jpeg)) images.push(jpeg);
  };
  await add(head.data);
  // 区间内均匀取 FRAME_COUNT 个点（首点已取），末点由 grabVideoFrameAt 收到 duration-0.05
  for (let i = 1; i < FRAME_COUNT; i += 1) {
    const seconds = from + ((to - from) * i) / (FRAME_COUNT - 1);
    const frame = await grabVideoFrameAt(store, node, seconds).catch(() => ({ data: "", duration: 0 }));
    await add(frame.data);
  }
  if (!images.length) throw new Error("取不到画面：视频还没加载出来");
  return { images, duration: Number(o?.dur) || 0 };
}

/**
 * 接口 body：
 *   图片 / 单帧 = image + is_video_frame；
 *   视频 = kind + table_only，后端能读地址就发 video_url、读不到才发本地 8 帧 images。
 */
type ParseBody =
  | { image: string; is_video_frame: boolean }
  | { video_url: string; kind: "video"; duration?: number; table_only: true; template?: ParseTemplate }
  | { images: string[]; kind: "video"; duration?: number; table_only: true; template?: ParseTemplate };

/** 后端能自己读地址抽帧的形态：/assets、/output 本地素材或 http(s) 外链；blob: / data: / 解析不出的素材引用都不算 */
function backendReadableVideoUrl(url: string): boolean {
  return /^\/(?:assets|output)\//i.test(url) || /^https?:\/\//i.test(url);
}

async function collect(store: CanvasStore, node: CanvasNode, singleFrame: boolean, template?: ParseTemplate): Promise<ParseBody> {
  if (node.kind === "image") return { image: await imageDataUrl(store, node), is_video_frame: false };
  if (node.kind !== "video") throw new Error("只有图片 / 视频节点能解析");
  if (singleFrame) return { image: await videoFrameDataUrl(store, node), is_video_frame: true };
  const o = outOf(node);
  const duration = Number(o?.dur) || 0;
  // novai-asset 引用先解析成可读地址
  const videoUrl = o?.url ? await fetchable(store, o.url) : "";
  // 后端能自己抽整条视频的关键帧：直接给地址，前端不再本地抽帧、不带 images
  if (videoUrl && backendReadableVideoUrl(videoUrl)) {
    return { video_url: videoUrl, kind: "video", table_only: true, ...(duration > 0 ? { duration } : {}), ...(template ? { template } : {}) };
  }
  // blob: / data: / 素材引用解析不出来 → 退回本地等距 8 帧（这条后端没有视频文件，首帧列会留空）
  const { images } = await videoFrames(store, node);
  return { images, kind: "video", table_only: true, ...(duration > 0 ? { duration } : {}), ...(template ? { template } : {}) };
}

/**
 * 体积闸门：总数 ≤8 帧、每帧 ≤8MB，超了就不发（原因经 catch 写进文本 / 表格并 toast）。
 * 视频多帧点名是第几帧，方便换张更小的图 / 缩短区间。
 */
function assertPayloadSize(body: ParseBody): void {
  if ("image" in body) {
    const bytes = dataUrlBytes(body.image);
    if (bytes > MAX_BYTES) throw new Error(`画面约 ${Math.round(bytes / 1024 / 1024)}MB，超过 ${MAX_BYTES / 1024 / 1024}MB 上限，没有发送`);
    return;
  }
  // video_url 形态没有本地帧要卡（后端自己抽帧）
  if (!("images" in body)) return;
  if (body.images.length > MAX_FRAMES) throw new Error(`取了 ${body.images.length} 帧，超过 ${MAX_FRAMES} 帧上限，没有发送`);
  body.images.forEach((image, index) => {
    const bytes = dataUrlBytes(image);
    if (bytes > MAX_BYTES) throw new Error(`第 ${index + 1} 帧约 ${Math.round(bytes / 1024 / 1024)}MB，超过 ${MAX_BYTES / 1024 / 1024}MB 上限，没有发送`);
  });
}

/** 后端的两种失败形状都认：{detail:"…"} 与 {ok:false,error:"…"} */
function reasonOf(data: unknown): string {
  const row = (data && typeof data === "object" ? data : {}) as { detail?: unknown; error?: unknown; message?: unknown };
  const pick = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      const inner = value as { message?: unknown; error?: unknown; detail?: unknown };
      for (const item of [inner.message, inner.error, inner.detail]) {
        if (typeof item === "string" && item.trim()) return item.trim();
      }
    }
    return "";
  };
  return pick(row.detail) || pick(row.error) || pick(row.message);
}

/**
 * 复用素材库反推的设置，用户不用在两处各选一次模型：只借平台 / 模型。
 * 提示词仍旧用后端那套四段式模板（素材库那边自定义的提示词不参与）。
 * 字段缺失 / 解析失败都当没配置，交给后端自己挑一个能看图的对话模型。
 */
function captionModel(): { provider: string; model: string } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CAPTION_SETTINGS_KEY) || "{}");
    const row = (parsed && typeof parsed === "object" ? parsed : {}) as { provider?: unknown; model?: unknown };
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    const model = typeof row.model === "string" ? row.model.trim() : "";
    return provider && model ? { provider, model } : { provider: "", model: "" };
  } catch {
    return { provider: "", model: "" };
  }
}

/**
 * 成功返回正文、实际用的模型（可能为空）和后端顺带给的分镜表（table 可能是 null）。
 * 视频 table_only 这条只认表格，text 允许为空；图片 / 单帧仍要求有正文。
 */
async function requestParse(body: ParseBody, opts: { requireText?: boolean; timeoutMs?: number; timeoutText?: string } = {}): Promise<{ text: string; model: string; table: unknown }> {
  const requireText = opts.requireText !== false;
  const caption = captionModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        // 素材库里选过反推平台 / 模型就沿用，两个都齐才发；否则后端自己挑一个能看图的对话模型
        ...(caption.provider && caption.model ? { provider: caption.provider, model: caption.model } : {}),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    // 后端会把「HTTP 502」这类状态码带进 detail：原样交给 toast，不改写、不吞掉
    if (!response.ok) throw new Error(reasonOf(data) || `接口返回 ${response.status}`);
    if (!data || (data as { ok?: unknown }).ok === false) throw new Error(reasonOf(data) || "接口没有返回内容");
    const row = data as { text?: unknown; model?: unknown; table?: unknown };
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (requireText && !text) throw new Error("模型没有返回内容");
    return { text, model: typeof row.model === "string" ? row.model.trim() : "", table: row.table ?? null };
  } catch (error) {
    // 超时被 AbortController 掐断：不把浏览器的「signal is aborted without reason」吐给用户
    if (isAbortError(error)) throw new Error(opts.timeoutText || "等待超时，请稍后再试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 目标位置的空位：和已有节点重叠就按 DROP_Y 往下让（同 videoTools.rowSpots 的避让思路，那边是私有函数，这里按需重写） */
function freeY(store: CanvasStore, src: CanvasNode, x: number, y: number, w = TEXT_W, h = TEXT_H): number {
  const hit = (yy: number) => store.state.doc.nodes.some((node) => node.id !== src.id
    && node.x < x + w + 20 && node.x + node.w + 20 > x
    && node.y < yy + h + 20 && node.y + node.h + 20 > yy);
  let yy = y;
  for (let i = 0; i < 40 && hit(yy); i++) yy += DROP_Y;
  return yy;
}

/** 新节点已经完整露出时不动视图：用户正看着的地方不该因为一次解析被挪走 */
function revealIfOffscreen(ctl: Ctl, nodes: CanvasNode[]): void {
  const bb = bounds(nodes);
  if (!bb) return;
  const rect = ctl.rect(); const view = ctl.store.state.view;
  const left = rect.left + bb.x * view.k + view.x;
  const top = rect.top + bb.y * view.k + view.y;
  if (left >= rect.left + VISIBLE_MARGIN && top >= rect.top + VISIBLE_MARGIN
    && left + bb.w * view.k <= rect.right - VISIBLE_MARGIN
    && top + bb.h * view.k <= rect.bottom - VISIBLE_MARGIN) return;
  ctl.fitTo(nodes, 160, 1);
}

/** 建表占位：按模板列出表头 + 1 行空行，让用户点完立刻看到表格（成功后再用响应整表替换） */
function emptyStoryboard(template: ParseTemplate): TableData {
  const columns = [...templateColumns(template)];
  return { kind: "table", version: 1, title: TABLE_TITLE, columns, rows: [columns.map(() => "")], roles: storyboardRoles(columns), view: "card" };
}

/** 响应里的 table → 可落库的 TableData；null / 形状不对 / 空表都当「这次没有表」 */
function tableDataOf(raw: unknown): TableData | null {
  const t = normalizeTable(raw, false);
  if (!t || !t.columns.length || !t.rows.length) return null;
  // 带首帧的分镜表默认打开创意视图（卡片墙）；老 12 列没有图，留在表格视图
  return { kind: "table", version: 1, title: TABLE_TITLE, columns: t.columns, rows: t.rows, roles: storyboardRoles(t.columns), ...(t.columns.includes("首帧") ? { view: "card" as const } : {}) };
}

/**
 * 视频节点右侧放一张分镜表：x = 源 x + w + GAP_X、y 与源对齐，撞到已有节点按 60 往下让。
 * 和源节点连一条边（表格会出现「输入」通道列，这是产品要的效果），并选中它。
 */
function createVideoTable(store: CanvasStore, src: CanvasNode, template: ParseTemplate): CanvasNode {
  const x = src.x + src.w + GAP_X;
  const node = withTable(
    { id: uid("t"), kind: "table", x, y: freeY(store, src, x, src.y, TABLE_W, TABLE_H), w: TABLE_W, h: TABLE_H, text: TABLE_TITLE },
    emptyStoryboard(template),
  );
  store.addNodes([node], [{ id: uid("e"), from: src.id, to: node.id }], { select: true });
  return node;
}

/** 把响应里的列 / 行写进表格节点（列名以响应为准，替换占位） */
function fillTable(store: CanvasStore, tableId: string, data: TableData): void {
  store.updateNode(tableId, (n) => withTable(n, data), { history: true });
}

/** 失败：原因写进第一行「画面描述」列，表格节点保留（不删） */
function writeTableFailure(store: CanvasStore, tableId: string, reason: string): void {
  const node = store.node(tableId);
  if (!node) return;
  const data = tableOf(node);
  const columns = data.columns.length ? data.columns : [...TABLE_COLUMNS];
  const found = columns.indexOf("画面描述");
  const at = found >= 0 ? found : Math.min(2, columns.length - 1);
  const rows = (data.rows.length ? data.rows : [columns.map(() => "")]).map((row) => [...row]);
  rows[0] = columns.map((_, i) => (i === at ? `解析失败：${reason}` : (rows[0][i] ?? "")));
  store.updateNode(tableId, (n) => withTable(n, { ...data, columns, rows }), { history: true });
}

/** 异常 → (中文原因, 指路补充)：建节点和跑接口两处失败都按同一套口径说话 */
function failureOf(error: unknown): { reason: string; hint: string } {
  const reason = isAbortError(error) ? "等待超时，请稍后再试"
    : error instanceof TypeError ? "网络异常，连不上接口"
      : error instanceof Error && error.message.trim() ? error.message.trim()
        : "未知错误，请稍后再试";
  // 原因里提到模型（典型是「一个能看图的对话模型都没配」）才多指一句路；
  // Key 不对是另一类问题，图片太大 / 网络异常也不该带这句
  const hint = reason.includes("模型") && !/key/i.test(reason) ? "（可在 设置 › API 设置 里配一个能看图的模型）" : "";
  return { reason, hint };
}

/**
 * 「文本」流程（图片解析 / 视频「解析当前帧」）：先在源节点右边建好文本节点、连上「源 → 文本」的边并选中，
 * 再去取画面（图片 1 张 / 视频单帧）→ 打接口 → 把四段式正文写进这个节点的当前版本。
 * 图片解析不建表格（表格只给视频解析）；失败不删节点：把「解析失败：…」写进正文并 toast 同样的原因。
 */
async function runParse(ctl: Ctl, node: CanvasNode, singleFrame: boolean): Promise<void> {
  const store = ctl.store;
  if (inFlight.has(node.id)) { store.toast("正在解析…"); return; }
  inFlight.add(node.id);
  let text: CanvasNode;
  try {
    const src = store.node(node.id);
    if (!src) throw new Error("节点已经不在画布上");
    const x = src.x + src.w + GAP_X;
    text = store.newNode("text", x, freeY(store, src, x, src.y), {
      title: `解析 · ${genOf(src).title || (src.kind === "video" ? "视频" : "图片")}`,
      manual: true,
      hist: [{ text: "" }],
      hi: 0,
      w: TEXT_W,
      h: TEXT_H,
    });
    // 节点和边一次加进去：边会进文本节点的输入顺序，之后它能拿上游那张图当参考
    store.addNodes([text], [{ id: uid("e"), from: src.id, to: text.id }], { select: true });
  } catch (error) {
    // 建节点这一步就失败：没有节点可写，只 toast
    const { reason, hint } = failureOf(error);
    store.toast(`解析失败：${reason}${hint}`, 5000);
    console.warn("[canvas] 解析失败", error);
    inFlight.delete(node.id);
    return;
  }
  // 纯界面态：让这个文本节点在等画面 / 等模型时显示「文本生成中」的骨架 + 脉冲点。
  // 不进文档，也不伪造 runtime 的 run——那会牵出停止按钮、Escape、排队、并发这些生成通道的逻辑。
  store.setUI({ parsing: new Set([...store.state.ui.parsing, text.id]) });
  revealIfOffscreen(ctl, [text]);
  // 图片 / 视频单帧都是 10–40 秒；节点虽然已经出来了，还得说一句让它知道在跑
  store.toast("解析中…（约 10–40 秒）", 40000);
  try {
    const payload = await collect(store, node, singleFrame);
    assertPayloadSize(payload);
    const parsed = await requestParse(payload);
    const body = formatParsedPrompt(parsed.text);
    // 节点可能在等结果时被用户删掉 / 撤销，写之前确认它还在
    if (store.node(text.id)) store.patchGen(text.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, text: body } : h)) }), { history: true });
    // 图片 / 单帧都只写正文，不建表格（表格只给视频解析）
    store.toast(parsed.model ? `已生成解析提示词（${parsed.model}）` : "已生成解析提示词");
  } catch (error) {
    const { reason, hint } = failureOf(error);
    // 节点保留不删（用户已经看到它了）：把原因写进正文，别留一个空白节点说不清
    if (store.node(text.id)) store.patchGen(text.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, text: `解析失败：${reason}` } : h)) }), { history: true });
    store.toast(`解析失败：${reason}${hint}`, 5000);
    console.warn("[canvas] 解析失败", error);
  } finally {
    // 位清不干净会让节点永远转圈：成功写正文 / 失败写原因 / 节点被删或撤销，都走这里清
    store.setUI({ parsing: new Set([...store.state.ui.parsing].filter((id) => id !== text.id)) });
    inFlight.delete(node.id);
  }
}

/**
 * 视频解析专用流程（table_only）：不建文本节点，先在视频右侧建表格 + 连边 + 选中，
 * 再取 6 帧打接口；成功用响应整表替换占位，失败把原因写进第一行「画面描述」列，表格保留。
 */
async function runVideoParse(ctl: Ctl, node: CanvasNode): Promise<void> {
  const store = ctl.store;
  if (inFlight.has(node.id)) { store.toast("正在解析…"); return; }
  inFlight.add(node.id);
  let table: CanvasNode;
  const { template } = getParseSettings();
  try {
    const src = store.node(node.id);
    if (!src) throw new Error("节点已经不在画布上");
    table = createVideoTable(store, src, template);
  } catch (error) {
    // 建表这一步就失败：没有节点可写，只 toast
    const { reason, hint } = failureOf(error);
    store.toast(`解析失败：${reason}${hint}`, 5000);
    console.warn("[canvas] 解析失败", error);
    inFlight.delete(node.id);
    return;
  }
  revealIfOffscreen(ctl, [table]);
  // 进度直接显示在表格节点上（标题旁转圈 + 已用时间），不再挂一个 3 分钟的 toast
  store.setUI({ parsing: new Set([...store.state.ui.parsing, table.id]) });
  try {
    const payload = await collect(store, node, false, template);
    assertPayloadSize(payload);
    // table_only 这条只认表格，正文允许为空
    const parsed = await requestParse(payload, { requireText: false, timeoutMs: VIDEO_TIMEOUT_MS, timeoutText: VIDEO_TIMEOUT_TEXT });
    const data = tableDataOf(parsed.table);
    if (!data) throw new Error("模型没有返回分镜表");
    if (store.node(table.id)) fillTable(store, table.id, data);
    store.toast(parsed.model ? `已生成分镜表（${parsed.model}）` : "已生成分镜表");
  } catch (error) {
    const { reason, hint } = failureOf(error);
    // 表格保留不删（用户已经看到它了）：把原因写进第一行「画面描述」
    writeTableFailure(store, table.id, reason);
    store.toast(`解析失败：${reason}${hint}`, 5000);
    console.warn("[canvas] 解析失败", error);
  } finally {
    store.setUI({ parsing: new Set([...store.state.ui.parsing].filter((id) => id !== table.id)) });
    inFlight.delete(node.id);
  }
}

/** 点「解析」：图片 = 单图 + 文本 + 表格；视频 = 6 帧只出分镜表（不建文本节点） */
export async function parseMedia(ctl: Ctl, node: CanvasNode): Promise<void> {
  if (node.kind === "video") return runVideoParse(ctl, node);
  return runParse(ctl, node, false);
}

/** 视频「更多 › 解析当前帧」：仍走单帧逻辑（image + is_video_frame:true），只建文本节点、不建表 */
export async function parseMediaFrame(ctl: Ctl, node: CanvasNode): Promise<void> {
  return runParse(ctl, node, true);
}
