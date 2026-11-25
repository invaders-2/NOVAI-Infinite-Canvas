/**
 * 节点工具条上的「解析」：把节点当前的画面交给视觉模型，反推出
 * 中文 / 英文的正向 · 负向提示词，在源节点右边新建一个文本节点。
 * 视频走专用流程：在「使用区间」里均匀取 6 帧一起发，得到的是视频提示词；响应里带了分镜表
 * （table）就在文本节点下面再放一张「解析 · 分镜表」表格节点（不连线、不抢选中）。
 * 「更多 › 解析当前帧」仍按老的单帧走。
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
import { normalizeTable, withTable, type TableData } from "../table";
import type { CanvasStore } from "../store";
import { toDataUrl } from "./editors/sourceToDataUrl";
import { grabVideoFrame, grabVideoFrameAt } from "./editors/registry";
import type { Ctl } from "./ctx";

const ENDPOINT = "/api/canvas-analyze-media";
/** 长边上限与 JPEG 质量：视觉模型够看，又能把体积压到 8MB 以内 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.9;
const MAX_BYTES = 8 * 1024 * 1024;
/** 视频解析取几帧：使用区间里均匀取 6 个时间点（后端多帧上限已放宽到 8） */
const FRAME_COUNT = 6;
const MAX_FRAMES = 8;
const TIMEOUT_MS = 90 * 1000;
/** 分镜表：文本节点正下方 80px、宽 1240 高 360；只放表格数据，不连线 */
const TABLE_TITLE = "解析 · 分镜表";
const TABLE_W = 1240;
const TABLE_H = 360;
const TABLE_GAP = 80;
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

/** data URL 的实际字节数（base64 每 4 个字符 3 字节，文件头不算） */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? 0 : Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/**
 * 统一转成 JPEG 0.9：toDataUrl 对长边已经 ≤1280 的图会原样返回，
 * 一张透明 PNG 照样能到几十 MB，发出去也只会被接口拒掉，所以这里固定再编码一次。
 */
function encodeJpeg(dataUrl: string, maxEdge = MAX_EDGE): Promise<string> {
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
      resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
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
 * 视频多帧：在「使用区间」里均匀取 FRAME_COUNT 个时间点（有 trim 按 trim.in→trim.out，没有就 0→真实时长），
 * 每帧同样缩到长边 ≤1280 的 JPEG；取不到 / 重复的帧跳过，至少留 1 帧。
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
    const jpeg = await encodeJpeg(data).catch(() => "");
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

/** 接口 body：图片 / 单帧走 image + is_video_frame；视频多帧走 images + kind，有总时长就带 duration */
type ParseBody =
  | { image: string; is_video_frame: boolean }
  | { images: string[]; kind: "video"; duration?: number };

async function collect(store: CanvasStore, node: CanvasNode, singleFrame: boolean): Promise<ParseBody> {
  if (node.kind === "image") return { image: await imageDataUrl(store, node), is_video_frame: false };
  if (node.kind !== "video") throw new Error("只有图片 / 视频节点能解析");
  if (singleFrame) return { image: await videoFrameDataUrl(store, node), is_video_frame: true };
  const { images, duration } = await videoFrames(store, node);
  return { images, kind: "video", ...(duration > 0 ? { duration } : {}) };
}

/**
 * 体积闸门：总数 ≤4 帧、每帧 ≤8MB，超了就不发（原因经 catch 写进节点正文并 toast）。
 * 视频多帧点名是第几帧，方便换张更小的图 / 缩短区间。
 */
function assertPayloadSize(body: ParseBody): void {
  if ("image" in body) {
    const bytes = dataUrlBytes(body.image);
    if (bytes > MAX_BYTES) throw new Error(`画面约 ${Math.round(bytes / 1024 / 1024)}MB，超过 ${MAX_BYTES / 1024 / 1024}MB 上限，没有发送`);
    return;
  }
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

/** 成功返回正文、实际用的模型（可能为空）和后端顺带给的分镜表（table 可能是 null） */
async function requestParse(body: ParseBody): Promise<{ text: string; model: string; table: unknown }> {
  const caption = captionModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
    if (!response.ok) throw new Error(reasonOf(data) || `接口返回 ${response.status}`);
    if (!data || (data as { ok?: unknown }).ok === false) throw new Error(reasonOf(data) || "接口没有返回内容");
    const row = data as { text?: unknown; model?: unknown; table?: unknown };
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) throw new Error("模型没有返回内容");
    return { text, model: typeof row.model === "string" ? row.model.trim() : "", table: row.table ?? null };
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

/** 响应里的 table → 可落库的 TableData；null / 形状不对 / 空表都当「这次没有表」，不建也不报错 */
function tableDataOf(raw: unknown, sourceId: string): TableData | null {
  const t = normalizeTable(raw, false);
  if (!t || !t.columns.length || !t.rows.length) return null;
  return { kind: "table", version: 1, title: TABLE_TITLE, columns: t.columns, rows: t.rows, sourceId };
}

/**
 * 文本节点正下方放一张分镜表：x 对齐文本节点、间隔 TABLE_GAP，撞到已有节点按 60 往下让。
 * 不连任何边（连进表格会变成输入通道，把表格数据搅乱），也不 select——选中仍留在文本节点上。
 */
function addStoryboardTable(store: CanvasStore, text: CanvasNode, table: TableData): CanvasNode {
  const x = text.x;
  const y = freeY(store, text, x, text.y + text.h + TABLE_GAP, TABLE_W, TABLE_H);
  const node = withTable({ id: uid("t"), kind: "table", x, y, w: TABLE_W, h: TABLE_H, text: TABLE_TITLE }, table);
  store.addNodes([node], [], { history: true });
  return node;
}

/** 异常 → (中文原因, 指路补充)：建节点和跑接口两处失败都按同一套口径说话 */
function failureOf(error: unknown): { reason: string; hint: string } {
  const reason = error instanceof DOMException && error.name === "AbortError" ? "等待超时，请稍后再试"
    : error instanceof TypeError ? "网络异常，连不上接口"
      : error instanceof Error && error.message.trim() ? error.message.trim()
        : "未知错误，请稍后再试";
  // 原因里提到模型（典型是「一个能看图的对话模型都没配」）才多指一句路；
  // Key 不对是另一类问题，图片太大 / 网络异常也不该带这句
  const hint = reason.includes("模型") && !/key/i.test(reason) ? "（可在 设置 › API 设置 里配一个能看图的模型）" : "";
  return { reason, hint };
}

/**
 * 「解析」的共同流程：先在源节点右边建好文本节点、连上「源 → 文本」的边并选中（用户立刻看到东西），
 * 再去取画面（图片 1 张 / 视频区间起、中、末 3 帧）→ 打接口 → 把四段式正文写进这个节点的当前版本。
 * 失败不删节点：把「解析失败：…」写进正文并 toast 同样的原因，异常不悄悄吞掉。
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
  // 视频多帧要取 6 帧再一起给模型，比单图慢；图片和视频单帧仍是 10–40 秒。
  // 节点虽然已经出来了，还得说一句让它知道在跑
  store.toast(node.kind === "video" && !singleFrame ? "解析中…（约 15–50 秒）" : "解析中…（约 10–40 秒）", 40000);
  try {
    const payload = await collect(store, node, singleFrame);
    assertPayloadSize(payload);
    const parsed = await requestParse(payload);
    const body = formatParsedPrompt(parsed.text);
    // 节点可能在等结果时被用户删掉 / 撤销，写之前确认它还在
    if (store.node(text.id)) store.patchGen(text.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, text: body } : h)) }), { history: true });
    const live = store.node(text.id);
    // 后端顺带给了分镜表就放到文本节点下面；table=null / 形状不对就不建，也不额外报错
    const table = tableDataOf(parsed.table, text.id);
    if (table && live) {
      try {
        revealIfOffscreen(ctl, [live, addStoryboardTable(store, live, table)]);
      } catch (error) {
        // 建表失败不能把已经成功的解析判成失败：正文已经写好，toast 照常报成功
        console.warn("[canvas] 分镜表创建失败", error);
      }
    }
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

/** 点「解析」：图片 = 单图；视频 = 区间均匀 6 帧一起交给模型，出的是视频提示词（有 table 就再建分镜表） */
export async function parseMedia(ctl: Ctl, node: CanvasNode): Promise<void> {
  return runParse(ctl, node, false);
}

/** 视频「更多 › 解析当前帧」：仍走老的单帧逻辑（image + is_video_frame:true），不重新抽 6 帧 */
export async function parseMediaFrame(ctl: Ctl, node: CanvasNode): Promise<void> {
  return runParse(ctl, node, true);
}
