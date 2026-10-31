/**
 * 画布数据模型。
 *
 * 持久化仍走现有的 CanvasDoc（react-canvas/reactCanvasStore.ts）：节点的通用字段（kind/x/y/w/h/text/url）不变，
 * 生成相关的一切（标题、提示词、参数、历史版本、输入顺序、标记）放在 node.data.gen 里。
 * 这样 persistence / 协作 / 迁移 / 资源引用 这些既有模块原样可用，旧画布打开时按 genOf() 补默认值。
 *
 * 运行态（生成中、进度、runId、错误）不进文档，见 store.ts 的 runtime。
 */
import type { CanvasDoc, CanvasEdge, CanvasNode, NodeKind } from "../react-canvas/reactCanvasStore";

export type GenKind = "text" | "image" | "video" | "audio";
export const GEN_KINDS: GenKind[] = ["text", "image", "video", "audio"];
export const isGenKind = (k: NodeKind | string): k is GenKind => k === "text" || k === "image" || k === "video" || k === "audio";

export const TYPE_LABEL: Record<GenKind, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
export const TYPE_ICON = { image: "image", video: "video", text: "text", audio: "audio" } as const;

/* ---------- 参数 ---------- */
export type CameraParams = { on: boolean; body: number; lens: number; focal: number; aperture: number };
/** Midjourney 专属参数（只在模型规格带 mj 时出现）：version 为空 = 交给上游默认；"niji 7" 这种带 niji 前缀 */
export type MjParams = { version?: string; speed?: string; hd?: boolean; stylize?: number };
export type ImageParams = { model: string; ratio: string; size: string; count: number; search: boolean; style: string; camera: CameraParams; mj?: MjParams };
export type VideoMode = "文生视频" | "首帧" | "首尾帧" | "参考生视频" | "视频编辑" | "视频延长" | "参考视频生视频" | "数字人";
export type VideoParams = { model: string; mode: VideoMode; ratio: string; res: string; dur: number; sound: boolean; times: number; /** 多镜头（高级设置） */ multiShot?: boolean; /** 生成模式（4K / 标准 / 专业…，仅规格声明的模型可用） */ genMode?: string; /** 极速模式（仅规格声明的模型可用） */ turbo?: boolean; /** 草稿模式（TapNow Draft Mode）：先按最低清晰度出草稿，满意后再出成片 */ draft?: boolean };
export type TextParams = { model: string; search: boolean; /** 输出：文本 / 多维表格 / 分镜表 */ output?: "text" | "table" | "storyboard" };
export type AudioParams = { model: string; kind: string; dur: string };
export type ParamsOf<K extends GenKind> = K extends "image" ? ImageParams : K extends "video" ? VideoParams : K extends "text" ? TextParams : AudioParams;
export type AnyParams = ImageParams | VideoParams | TextParams | AudioParams;

/** 一次生成的产物。图片 / 视频 / 音频是地址，文本是正文。 */
export type GenOutput = {
  url?: string;
  /** 视频的封面帧（可选） */
  frame?: string;
  text?: string;
  w?: number;
  h?: number;
  dur?: number;
  res?: string;
  /** 视频「使用区间」（按版本各存一份）：播放循环 / 截帧 / 下载都按它 */
  trim?: VideoTrim;
  /** 草稿模式出的低清版本：工具条显示「出成片」 */
  draft?: boolean;
  /** 音频波形（0~1），后端不给时前端从音频解码或用占位 */
  bars?: number[];
  meta?: { model?: string; ratio?: string; size?: string; at?: number; runId?: string; remote?: string; /** 上传文档的文件名 */ doc?: string };
};

export type GenData = {
  title: string;
  prompt: string;
  params: AnyParams;
  hist: GenOutput[];
  hi: number;
  /** 入边顺序（edge id），决定发给模型的输入顺序 */
  order: string[];
  pinned?: boolean;
  /** 节点背景色（TapNow「背景颜色」：NODE_BG 的键） */
  bg?: string;
  /** 颜色标签（TapNow「Pin」：NODE_TAG 的键）；旧数据 pinned=true 视为红色 */
  tag?: string;
  fav?: boolean;
  /** 由 Agent 新建 */
  agent?: boolean;
  /** 文本节点：手写内容（不需要生成） */
  manual?: boolean;
  /** 图片节点：用户上传 */
  uploaded?: boolean;
  /** 最近一次失败的说明（人话；持久化，刷新后仍能看到） */
  err?: string;
  /** 失败时的原始错误码（如 MODEL_TIMEOUT）：只在弹层里以 12px 灰字展示，便于排查 */
  errCode?: string;
  /** 「引用模式」：插入过 @ 引用后，只发送提示词里 @ 到的上游（见 mentions.ts） */
  refMode?: "mention";
};

/* ---------- 模型能力 ---------- */
export type ModelSpec = {
  id: string; // configId
  name: string;
  vendor: string;
  tags: string[];
  kind: GenKind;
  local?: boolean;
  secs: number; // 估计耗时（秒）
  // image
  ratios?: string[]; sizes?: string[]; maxRefs?: number; refNote?: string; i2i?: boolean; search?: boolean; style?: boolean; camera?: boolean; batch?: number[];
  // video
  modes?: VideoMode[]; res?: string[]; durs?: number[]; audio?: boolean; times?: number[]; multiShot?: boolean;
  /** 生成模式（TapNow 的 4K / 标准 / 专业 / 大 / 中 / 小）：只有服务商规格声明时才出现 */
  genModes?: string[];
  /** 极速模式（TapNow 的 turbo）：只有规格声明时才出现 */
  turbo?: boolean;
  /** Midjourney：可选版本 / 速度 / 支持 HD 的版本（服务商规格声明时才有） */
  mj?: { versions: string[]; speeds: string[]; hd: string[] };
  // text
  vision?: boolean;
  // audio
  kinds?: string[]; adurs?: string[];
  /**
   * 规格来源：`spec` = 后端适配器给了 uiSpec（以它为准）；`guess` = 没规格，按模型名套 PRESETS 兜底（面板显示「未验证」）。
   * 可选能力（联网 / 风格 / 摄影机 / 批量 / 参考图上限）只在 spec 里出现才算支持。
   */
  specSource?: "spec" | "guess";
};

/** TapNow 视频 modelType 全集：中文名 → 接口值 + 需要的输入 */
export const VMODES: Record<VideoMode, { api: string; need: string }> = {
  "文生视频": { api: "text_to_video", need: "不用图片，只靠提示词" },
  "首帧": { api: "image_to_video", need: "第 1 张图作为开场画面" },
  "首尾帧": { api: "start_end_to_video", need: "第 1、2 张图分别是首帧和尾帧" },
  "参考生视频": { api: "reference_to_video", need: "多张图作主体 / 风格参考" },
  "视频编辑": { api: "video_edit", need: "连入 1 段视频，用提示词改它" },
  "视频延长": { api: "video_extend", need: "连入 1 段视频，接着往后生成" },
  "参考视频生视频": { api: "reference_video_to_video", need: "连入视频作动作 / 运镜参考" },
  "数字人": { api: "digital_human", need: "1 张人像 + 1 段音频，生成口播" },
};

/* ---------- 视频「使用区间」：按版本持久化，播放循环 / 截帧 / 下载都按它 ---------- */
export type VideoTrim = { in: number; out: number };
/** in/out 之间至少留这么长，避免把区间拖成一条线 */
export const MIN_TRIM_GAP = 0.2;

/** 把任意输入夹成合法区间：0 ≤ in < out ≤ dur（dur 未知时按 10s 兜底） */
export function clampTrim(dur: number | undefined, trim: { in?: unknown; out?: unknown } | undefined): VideoTrim {
  const total = Number.isFinite(Number(dur)) && Number(dur) > 0 ? Number(dur) : 10;
  const rawIn = Number(trim?.in), rawOut = Number(trim?.out);
  let start = Number.isFinite(rawIn) ? rawIn : 0;
  let end = Number.isFinite(rawOut) ? rawOut : total;
  start = Math.min(Math.max(0, start), Math.max(0, total - MIN_TRIM_GAP));
  end = Math.min(Math.max(start + MIN_TRIM_GAP, end), total);
  return { in: Math.round(start * 100) / 100, out: Math.round(end * 100) / 100 };
}
/** 区间是否覆盖全片（下载/截帧时用它决定要不要提示「按区间裁剪」） */
export function trimIsFull(dur: number | undefined, trim: VideoTrim | undefined): boolean {
  if (!trim) return true;
  const total = Number.isFinite(Number(dur)) && Number(dur) > 0 ? Number(dur) : 10;
  const full = clampTrim(total, undefined);
  return Math.abs(trim.in - full.in) < 0.05 && Math.abs(trim.out - full.out) < 0.05;
}
/** 区间文案：2.2s – 10.1s（保留一位小数） */
export function trimLabel(trim: VideoTrim | undefined): string {
  if (!trim) return "";
  const one = (v: number) => Math.round(v * 10) / 10;
  return one(trim.in) + "s – " + one(trim.out) + "s";
}

/* ---------- 视频参数条的显示口径（对齐 TapNow：未设置显示「自动 / 自适应」） ---------- */
/** 秒 → 0:05 / 1:20 */
export function formatClock(seconds: unknown): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + String(s).padStart(2, "0");
}
/** 生成时长：未设置 / -1 → 自动，否则 {{n}}s */
export function videoDurLabel(dur: unknown): string {
  const n = Number(dur);
  return !Number.isFinite(n) || n <= 0 ? "自动" : n + "s";
}
/** 清晰度：空 / 自适应 → 自适应 */
export function videoResLabel(res: unknown): string {
  const text = String(res == null ? "" : res).trim();
  return !text || /^(自动|自适应|auto|adaptive)$/i.test(text) ? "自适应" : text;
}
/** 比例：adaptive / 自动 / 空 → 自适应 */
export function videoRatioLabel(ratio: unknown): string {
  const text = String(ratio == null ? "" : ratio).trim();
  return !text || /^(自动|自适应|auto|adaptive)$/i.test(text) ? "自适应" : text;
}
/** 次数：1× / 2× */
export function videoTimesLabel(times: unknown): string {
  const n = Math.round(Number(times));
  return (Number.isFinite(n) && n > 0 ? n : 1) + "×";
}

export const STYLES: Array<[string, string]> = [["无", "var(--s2)"], ["电影感", "linear-gradient(#000 0 12%,#24404a 12% 88%,#000 88%)"], ["胶片", "linear-gradient(135deg,#6b4a2f,#c79a6a)"], ["极简棚拍", "linear-gradient(#f3f3f3,#cfcfd4)"], ["赛博", "linear-gradient(135deg,#3b0a5c,#0ff3)"], ["水彩", "linear-gradient(135deg,#f6c1c9,#b8e0f6)"], ["3D 渲染", "radial-gradient(circle at 30% 30%,#fff,#777 60%,#222)"], ["国潮", "linear-gradient(135deg,#7a0d0d,#e2b84d)"]];
/**
 * 摄影机控制四维取值表（对齐 TapNow：机身 9 / 镜头 10 / 焦段 7 / 光圈 3）。
 * 与 electron/canvas-bootstrap.cjs#CAMERA_PARTS 逐项一致（tests/style-camera-forward.test.mjs 漂移核对），
 * 索引越界由 sanitizeCamera 夹到边界；名称用 TapNow 的拼写（Arri / Red 首字母大写）。
 */
export const CAMERAS = {
  body: ["Sony Venice", "Arri Alexa 35", "Arri Alexa 65", "Red V-Raptor", "Panavision DXL2", "Arricam LT", "ArriFlex 435", "IMAX Keighley", "IMAX Film Camera"],
  lens: ["Zeiss Ultra Prime", "Arri Signature Prime", "Canon K-35", "Cooke S4", "Cooke Panchro", "Cooke SF 1.8x", "Helios", "Panavision C-series", "Panavision Primo", "Hawk Class X"],
  focal: [8, 14, 24, 35, 50, 75, 125],
  aperture: ["ƒ/1.4", "ƒ/4", "ƒ/11"],
};

const camIndex = (v: unknown, len: number) => Math.max(0, Math.min(len - 1, Math.trunc(Number(v) || 0)));
/** 默认组合（TapNow 实测：Sony Venice + Zeiss Ultra Prime + 24mm + ƒ/4）；on=false 表示还没选过 */
export const DEFAULT_CAMERA: CameraParams = { on: false, body: 0, lens: 0, focal: 2, aperture: 1 };
/** 需求摘要（浮层列标签 / 请求预览用）：机身 · 24mm · ƒ/4 · 镜头 */
export function cameraSummary(c: CameraParams | undefined | null): string {
  if (!c || !c.on) return "";
  return CAMERAS.body[camIndex(c.body, CAMERAS.body.length)] + " · " + CAMERAS.focal[camIndex(c.focal, CAMERAS.focal.length)] + "mm · " + CAMERAS.aperture[camIndex(c.aperture, CAMERAS.aperture.length)] + " · " + CAMERAS.lens[camIndex(c.lens, CAMERAS.lens.length)];
}
/** 发请求用的组合：on=false 一律 null（这条请求不带摄影机），索引越界收敛到边界 */
export function cameraForRequest(c: CameraParams | undefined | null): { body: string; lens: string; focal: string; aperture: string } | null {
  if (!c || !c.on) return null;
  return {
    body: CAMERAS.body[camIndex(c.body, CAMERAS.body.length)],
    lens: CAMERAS.lens[camIndex(c.lens, CAMERAS.lens.length)],
    focal: CAMERAS.focal[camIndex(c.focal, CAMERAS.focal.length)] + "mm",
    aperture: CAMERAS.aperture[camIndex(c.aperture, CAMERAS.aperture.length)],
  };
}

/**
 * 风格取值收敛到 STYLES 枚举。
 *
 * 后端只把 style 当 ≤40 字自由文本原样拼进提示词，所以画布这边必须保证：
 *   · 只有 STYLES 里的名字才会被发送；
 *   · 未知 / 自定义串一律不发送（styleForRequest → null），绝不把脏字符串塞进请求；
 *   · 清空 / 「无」/ 非法值在读参数时回退成「无」（normalizeStyle）。
 */
const STYLE_NAMES = new Set(STYLES.map(([name]) => name));
/** 文档/面板里的风格 → 合法枚举值（未知一律回退「无」） */
export function normalizeStyle(style: unknown): string {
  const value = String(style == null ? "" : style).trim();
  return STYLE_NAMES.has(value) ? value : "无";
}
/** 发请求用的风格：只有 STYLES 里的非「无」值才返回，其它一律 null（这一条请求不带风格） */
export function styleForRequest(style: unknown): string | null {
  const value = normalizeStyle(style);
  return value === "无" ? null : value;
}

/**
 * 已知模型的能力表（按名字匹配）。后端 canvas/models 只给 configId / 名称 / capabilities，
 * 比例、分辨率、生成方式这些前端控件靠这张表决定；匹配不到的模型用同类型的保守默认值。
 */
const PRESETS: Array<{ re: RegExp; spec: Partial<ModelSpec> & { kind: GenKind } }> = [
  { re: /banana|gemini.*image|nano/i, spec: { kind: "image", tags: ["4K"], ratios: ["自适应", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"], sizes: ["1K", "2K", "4K"], maxRefs: 14, i2i: true, search: true, batch: [1, 2, 4], secs: 12 } },
  { re: /seedream/i, spec: { kind: "image", tags: ["2K"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"], sizes: ["2K", "3K"], maxRefs: 14, i2i: true, batch: [1, 2, 4], secs: 9 } },
  { re: /gpt.?image|dall/i, spec: { kind: "image", tags: ["4K"], ratios: ["auto", "1:1", "2:1", "4:3", "3:4", "5:4", "4:5", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21"], sizes: ["1K", "2K", "4K"], maxRefs: 16, i2i: true, batch: [1, 2, 4], secs: 14 } },
  { re: /flux/i, spec: { kind: "image", tags: ["2K"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"], sizes: ["1K", "2K"], maxRefs: 4, i2i: true, batch: [1, 2, 4], secs: 8 } },
  { re: /midjourney|\bmj\b/i, spec: { kind: "image", tags: ["2K"], ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2", "7:4", "4:7"], sizes: ["2K"], maxRefs: 4, i2i: true, batch: [4], secs: 300 } },
  { re: /recraft/i, spec: { kind: "image", tags: ["矢量"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"], sizes: ["1080P"], maxRefs: 0, i2i: false, batch: [1, 2], secs: 7 } },
  { re: /sdxl|comfy|stable/i, spec: { kind: "image", tags: ["本机"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"], sizes: ["1K"], maxRefs: 1, i2i: true, batch: [1, 2, 4], secs: 6, local: true } },
  { re: /seedance/i, spec: { kind: "video", tags: ["1080P"], modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "视频编辑", "视频延长"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], res: ["480p", "720p", "1080p"], durs: [5, 10, 15], maxRefs: 9, times: [1, 2, 4], audio: true, secs: 120 } },
  { re: /veo/i, spec: { kind: "video", tags: ["有声"], modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "视频延长"], ratios: ["16:9", "9:16"], res: ["720p", "1080p"], durs: [4, 6, 8], maxRefs: 3, audio: true, times: [1, 2], secs: 120 } },
  { re: /kling|可灵/i, spec: { kind: "video", tags: ["热门"], modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "参考视频生视频", "数字人"], ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10], maxRefs: 4, times: [1, 2], secs: 120 } },
  { re: /hailuo|minimax.*video|wan|runway|sora|pika|vidu/i, spec: { kind: "video", tags: [], modes: ["文生视频", "首帧", "首尾帧"], ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10], maxRefs: 2, times: [1], secs: 120 } },
  { re: /mureka|suno|music/i, spec: { kind: "audio", tags: ["音乐"], kinds: ["音乐", "配音", "音效"], adurs: ["自适应", "15s", "30s", "60s"], secs: 10 } },
  { re: /eleven|tts|speech|voice/i, spec: { kind: "audio", tags: ["配音"], kinds: ["配音", "音效"], adurs: ["自适应", "15s", "30s"], secs: 8 } },
];
const DEFAULTS: Record<GenKind, Partial<ModelSpec>> = {
  image: { ratios: ["1:1", "3:4", "4:3", "16:9", "9:16"], sizes: ["1K", "2K"], maxRefs: 4, i2i: true, batch: [1, 2, 4], secs: 12 },
  video: { modes: ["文生视频", "首帧", "首尾帧"], ratios: ["16:9", "9:16", "1:1"], res: ["720p"], durs: [5, 10], maxRefs: 2, times: [1], secs: 120 },
  text: { vision: false, search: false, secs: 4 },
  audio: { kinds: ["音乐", "配音", "音效"], adurs: ["自适应", "15s", "30s"], secs: 10 },
};
/** 后端模型行 → 前端能力表。kind 由 capabilities 决定，能力细节按名字套预设。 */
/** 服务商适配器给的面板规格（canvas/models 的 uiSpec）里，前端认的字段 */
const UI_KEYS = ["ratios", "sizes", "batch", "maxRefs", "refNote", "i2i", "res", "durs", "modes", "audio", "times", "kinds", "adurs", "search", "style", "camera", "multiShot", "genModes", "turbo", "mj"] as const;
function fromProvider(kind: GenKind, ui?: Record<string, unknown> | null): Partial<ModelSpec> {
  if (!ui || typeof ui !== "object" || (ui.kind && ui.kind !== kind)) return {};
  const out: Record<string, unknown> = {};
  for (const k of UI_KEYS) if (ui[k] !== undefined && ui[k] !== null) out[k] = ui[k];
  if (Array.isArray(out.modes)) out.modes = (out.modes as string[]).filter((m) => m in VMODES);
  const top = kind === "image" ? (out.sizes as string[] | undefined)?.slice(-1)[0] : kind === "video" ? (out.res as string[] | undefined)?.slice(-1)[0]?.toUpperCase() : undefined;
  if (top) out.tags = [top];
  // 估计耗时（进度条用）：服务商规格没给时按类型估，视频生成通常要两分钟上下
  out.secs = typeof ui.secs === "number" && ui.secs > 0 ? ui.secs : kind === "video" ? 120 : kind === "audio" ? 30 : kind === "image" ? 15 : 8;
  return out as Partial<ModelSpec>;
}

/**
 * 后端模型行 → 前端能力表。kind 由 capabilities 决定。
 *
 * **规格优先**：canvas/models 行带了服务商适配器的 uiSpec（specSource='spec'）就以它为准，
 * 名字 PRESETS 一个字段都不继承 —— 按名字匹配会把别家的「联网 / 风格 / 摄影机 / 批量 / 参考图上限」
 * 套过来，服务端根本不支持却显示成可用（"假可用"）。
 * 没有 uiSpec 时才用 PRESETS 兜底，并把 specSource 标成 'guess'，面板据此显示「未验证」。
 */
/** 面板上的速度名 */
export const MJ_SPEED_LABEL: Record<string, string> = { relax: "慢速", fast: "快速", turbo: "极速" };
/** 底部参数行的 Midjourney 摘要：「v8.1 · 快速 · HD · S250」（S = 风格化 --s）；全默认时显示「默认版本 · 快速」 */
export function mjSummary(p?: MjParams): string {
  const v = p?.version ? (/^niji/i.test(p.version) ? p.version.replace(/^niji\s*/i, "Niji ") : "v" + p.version) : "默认版本";
  return [v, MJ_SPEED_LABEL[p?.speed || "fast"] || "快速", p?.hd ? "HD" : "", typeof p?.stylize === "number" ? "S" + p.stylize : ""].filter(Boolean).join(" · ");
}
/** 这个版本能不能开 HD（版本留空 = 上游默认会补 8.1，也可以开） */
export function mjHdAllowed(spec: ModelSpec["mj"], version?: string): boolean { return !!spec && (!version || spec.hd.includes(version)); }

export function specFor(row: { configId: string; label: string; vendor?: string; kind: GenKind; local?: boolean; vision?: boolean; search?: boolean; ui?: Record<string, unknown> | null; specSource?: string }): ModelSpec {
  const prov = fromProvider(row.kind, row.ui);
  const hasSpec = Object.keys(prov).length > 0;
  const preset = hasSpec ? {} : PRESETS.find((p) => p.spec.kind === row.kind && p.re.test(row.label))?.spec || {};
  // 有规格时：可选能力只认规格里明确的声明，规格没写就是「不支持」（不再从名字继承，也不回落猜测）。
  // 比例 / 档位 / 时长这类**必填取值**缺省时仍按同类型通用表兜底（否则面板无从选择），
  // 但 batch / maxRefs / i2i / times / audio / multiShot 这些**可选能力**缺省一律按不支持。
  const base = hasSpec
    ? {
      ...prov,
      search: prov.search === true, style: prov.style === true, camera: prov.camera === true,
      ...(row.kind === "image" ? { batch: prov.batch ?? [1], maxRefs: prov.maxRefs ?? 0, i2i: prov.i2i === true } : {}),
      ...(row.kind === "video" ? { times: prov.times ?? [1], audio: prov.audio === true, multiShot: prov.multiShot === true } : {}),
    }
    : preset;
  // 后端显式给的 specSource 优先，但『标了 spec 却没带可用规格』不许冒充已验证
  const declared = row.specSource === "spec" || row.specSource === "guess" ? row.specSource : null;
  const specSource: "spec" | "guess" = declared === "guess" || (declared === "spec" && !hasSpec) || (!declared && !hasSpec) ? "guess" : "spec";
  return {
    secs: 10, tags: [], ...DEFAULTS[row.kind], ...base,
    // 风格 / 摄影机：显式布尔（没有 uiSpec 声明就是 false，前端据此决定是否给入口）
    ...(row.kind === "image" ? { style: (base as Partial<ModelSpec>).style === true, camera: (base as Partial<ModelSpec>).camera === true } : {}),
    id: row.configId, name: row.label, vendor: row.vendor || "", kind: row.kind,
    ...(row.local ? { local: true } : {}),
    specSource,
    // 能读图：能力表（row.vision）是后端声明的，不是名字猜的；联网：规格里有才算，没规格才按名字猜
    ...(row.kind === "text" ? {
      vision: row.vision ?? (hasSpec ? false : /vl|vision|gemini|gpt-4o|gpt-5|claude|qwen.*vl/i.test(row.label)),
      search: typeof prov.search === "boolean" ? prov.search : !hasSpec && (row.search ?? /gemini|search|联网/i.test(row.label)),
    } : {}),
  } as ModelSpec;
}

export function defaultParams(kind: GenKind, m?: ModelSpec): AnyParams {
  const model = m?.id || "";
  if (kind === "image") return { model, ratio: m?.ratios?.includes("3:4") ? "3:4" : m?.ratios?.[0] || "1:1", size: m?.sizes?.includes("2K") ? "2K" : m?.sizes?.[0] || "1K", count: 1, search: false, style: "无", camera: { ...DEFAULT_CAMERA } };
  if (kind === "video") return { model, mode: "文生视频", ratio: m?.ratios?.[0] || "16:9", res: m?.res?.includes("720p") ? "720p" : m?.res?.[0] || "720p", dur: m?.durs?.[0] || 5, sound: false, times: 1 };
  if (kind === "text") return { model, search: false, output: "text" };
  return { model, kind: m?.kinds?.[0] || "音乐", dur: m?.adurs?.[0] || "自适应" };
}

/** 档位按数值取最接近（1080p 切到只有 480p/720p 的模型 → 720p，而不是第一个） */
const tierNum = (x: string) => { const s = String(x).toLowerCase(); const k = /([0-9.]+)\s*k/.exec(s); if (k) return Number(k[1]) * 1000; const p = /([0-9]+)\s*p/.exec(s); if (p) return Number(p[1]) * 1.5; const mp = /([0-9.]+)\s*mp/.exec(s); return mp ? Number(mp[1]) * 1000 : NaN; };
const nearestTier = (list: string[], want: string) => { const t = tierNum(want); return Number.isFinite(t) ? list.reduce((a, b) => (Math.abs(tierNum(b) - t) < Math.abs(tierNum(a) - t) ? b : a), list[0]) : list[0]; };

/** 切换模型时把不再支持的参数收回到合法值 */
export function clampParams(kind: GenKind, p: AnyParams, m: ModelSpec): AnyParams {
  if (kind === "image") {
    const q = { ...(p as ImageParams), camera: { ...(p as ImageParams).camera }, model: m.id };
    if (m.ratios && !m.ratios.includes(q.ratio)) q.ratio = m.ratios[0];
    if (m.sizes && m.sizes.length && !m.sizes.includes(q.size)) q.size = nearestTier(m.sizes, q.size);
    if (m.batch && !m.batch.includes(q.count)) q.count = m.batch[0];
    if (!m.search) q.search = false; q.style = m.style ? normalizeStyle(q.style) : "无"; if (!m.camera) q.camera.on = false;
    return q;
  }
  if (kind === "video") {
    const q = { ...(p as VideoParams), model: m.id };
    if (m.ratios && m.ratios.length && !m.ratios.includes(q.ratio)) q.ratio = m.ratios[0];
    if (m.res && m.res.length && !m.res.includes(q.res)) q.res = nearestTier(m.res, q.res);
    if (m.durs && m.durs.length && !m.durs.includes(q.dur)) q.dur = m.durs.reduce((a, b) => (Math.abs(b - q.dur) < Math.abs(a - q.dur) ? b : a), m.durs[0]);
    if (m.modes && m.modes.length && !m.modes.includes(q.mode)) q.mode = m.modes[0];
    if (!(m.times || [1]).includes(q.times || 1)) q.times = 1;
    if (!m.audio) q.sound = false;
    if (!m.multiShot) q.multiShot = false;
    return q;
  }
  if (kind === "text") { const q = { ...(p as TextParams), model: m.id }; if (!m.search) q.search = false; return q; }
  const q = { ...(p as AudioParams), model: m.id }; if (m.kinds && m.kinds.length && !m.kinds.includes(q.kind)) q.kind = m.kinds[0]; if (m.adurs && m.adurs.length && !m.adurs.includes(q.dur)) q.dur = m.adurs[0]; return q;
}

/**
 * 「未配置模型」时给参数弹层用的占位规格：只用来把**有哪些档位**灰显出来，不参与生成。
 * 真实模型一旦选中就走模型的 uiSpec，这里不会被用到。
 */
export const PLACEHOLDER_SPECS: Record<GenKind, ModelSpec> = {
  image: { id: "__placeholder-image", name: "未配置模型", vendor: "", tags: [], kind: "image", secs: 12, ratios: ["自适应", "1:1", "4:3", "3:4", "16:9", "9:16"], sizes: ["1K", "2K", "4K"], batch: [1, 2, 4], maxRefs: 4, i2i: true, style: true, camera: true, search: true, specSource: "guess" },
  text: { id: "__placeholder-text", name: "未配置模型", vendor: "", tags: [], kind: "text", secs: 6, vision: true, search: true, specSource: "guess" },
  video: { id: "__placeholder-video", name: "未配置模型", vendor: "", tags: [], kind: "video", secs: 60, modes: ["文生视频", "首帧", "首尾帧"], ratios: ["16:9", "9:16", "1:1", "自适应"], res: ["720p", "1080p"], durs: [5, 10], times: [1, 2], audio: true, maxRefs: 4, specSource: "guess" },
  audio: { id: "__placeholder-audio", name: "未配置模型", vendor: "", tags: [], kind: "audio", secs: 8, kinds: ["音乐", "配音", "音效"], adurs: ["自适应", "15s", "30s", "60s"], specSource: "guess" },
};
/** 没配置模型时取占位规格（只用于把参数档位灰显出来，不能拿去生成） */
export function placeholderSpec(kind: GenKind): ModelSpec { return PLACEHOLDER_SPECS[kind]; }

/* ---------- 节点读写 ---------- */
export const NODE_DEFAULT_SIZE: Record<GenKind, { w: number; h: number }> = { text: { w: 280, h: 200 }, image: { w: 240, h: 240 }, video: { w: 320, h: 180 }, audio: { w: 320, h: 180 } };

/** 读节点的生成数据；旧画布的节点没有 data.gen，按通用字段补出来（不改原节点）。 */
export function genOf(node: CanvasNode): GenData {
  const raw = (node.data && typeof node.data === "object" ? (node.data as { gen?: Partial<GenData> }).gen : undefined) || {};
  const kind = isGenKind(node.kind) ? node.kind : "text";
  let hist = Array.isArray(raw.hist) ? raw.hist.filter(Boolean) as GenOutput[] : [];
  if (!hist.length) {
    if (kind === "text" && node.text) hist = [{ text: node.text }];
    else if (node.url) hist = [node.kind === "video" ? { url: node.url } : { url: node.url }, ...(node.variants || []).map((u) => ({ url: u }))];
  }
  // 旧文档可能存着自定义风格串：读参数时就收敛到 STYLES，避免「面板显示一个名字、请求里又发不出去」
  const rawParams = (raw.params as AnyParams) || defaultParams(kind);
  const params = kind === "image" && rawParams && typeof rawParams === "object"
    ? { ...rawParams, style: normalizeStyle((rawParams as ImageParams).style) }
    : rawParams;
  return {
    title: typeof raw.title === "string" && raw.title ? raw.title : TYPE_LABEL[kind],
    prompt: typeof raw.prompt === "string" ? raw.prompt : (kind !== "text" && !node.url ? node.text || "" : ""),
    params,
    hist,
    hi: Math.min(Math.max(0, Number(raw.hi) || 0), Math.max(0, hist.length - 1)),
    order: Array.isArray(raw.order) ? raw.order.filter((x): x is string => typeof x === "string") : [],
    ...(raw.pinned ? { pinned: true } : {}), ...(raw.fav ? { fav: true } : {}), ...(raw.agent ? { agent: true } : {}),
    ...(typeof raw.bg === "string" && NODE_BG.some((c) => c[0] === raw.bg) ? { bg: raw.bg } : {}),
    ...(typeof raw.tag === "string" && NODE_TAG.some((c) => c[0] === raw.tag) ? { tag: raw.tag } : raw.pinned ? { tag: "red" } : {}),
    ...(raw.manual ? { manual: true } : {}), ...(raw.uploaded ? { uploaded: true } : {}), ...(raw.err ? { err: String(raw.err) } : {}),
    // 原始错误码（弹层里以「代码：…」展示；旧文档没有这个字段，读出来就是 undefined）
    ...(typeof raw.errCode === "string" && raw.errCode ? { errCode: raw.errCode } : {}),
    ...(raw.refMode === "mention" ? { refMode: "mention" as const } : {}),
  };
}
/** 节点背景色（TapNow 背景颜色面板：无色 + 7 种低饱和色） */
export const NODE_BG: Array<[string, string]> = [["red", "#8e4545"], ["orange", "#8a5426"], ["olive", "#8a8231"], ["green", "#4b7744"], ["teal", "#3d6f7c"], ["blue", "#34508a"], ["purple", "#78408e"]];
/** 颜色标签（TapNow Pin：6 种亮色） */
export const NODE_TAG: Array<[string, string]> = [["red", "#e25c5c"], ["orange", "#eda05a"], ["yellow", "#e9c85a"], ["green", "#6cc67c"], ["blue", "#5aa1f0"], ["purple", "#9b6ae6"]];
export const bgColor = (key?: string) => NODE_BG.find((c) => c[0] === key)?.[1] || null;
export const tagColor = (key?: string) => NODE_TAG.find((c) => c[0] === key)?.[1] || null;
export const outOf = (node: CanvasNode): GenOutput | null => { const g = genOf(node); return g.hist[g.hi] || null; };
export const srcOf = (node: CanvasNode): string => { const o = outOf(node); return node.kind === "video" ? o?.frame || "" : node.kind === "image" ? o?.url || "" : ""; };
export const textOf = (node: CanvasNode): string => (node.kind === "text" ? outOf(node)?.text || "" : "");

/** 把生成数据写回节点：同时同步通用字段，旧版组件 / 导出 / 资源引用也能读到当前结果 */
export function withGen(node: CanvasNode, patch: Partial<GenData>): CanvasNode {
  const g = { ...genOf(node), ...patch };
  const cur = g.hist[g.hi];
  const next: CanvasNode = { ...node, data: { ...(node.data && typeof node.data === "object" ? node.data : {}), gen: g } };
  if (node.kind === "text") next.text = (cur?.text || "").slice(0, 4000);
  else {
    next.text = g.title;
    if (cur?.url) next.url = cur.url; else delete next.url;
    next.variants = g.hist.filter((o, i) => i !== g.hi && o.url).map((o) => o.url as string).slice(0, 20);
    if (node.kind === "image" || node.kind === "video") { const p = g.params as ImageParams | VideoParams; next.ratio = p.ratio; }
  }
  return next;
}

export function newNode(kind: GenKind, x: number, y: number, extra: Partial<GenData> & { w?: number; h?: number; id?: string } = {}, model?: ModelSpec): CanvasNode {
  const size = NODE_DEFAULT_SIZE[kind];
  const { w, h, id, ...gen } = extra;
  const base: CanvasNode = { id: id || uid("n"), kind, x: Math.round(x), y: Math.round(y), w: w ?? size.w, h: h ?? size.h, text: "" };
  return withGen(base, { title: TYPE_LABEL[kind], prompt: "", params: defaultParams(kind, model), hist: [], hi: 0, order: [], ...gen });
}

/* ---------- 图关系 ---------- */
export type InputRef = { edge: CanvasEdge; node: CanvasNode; order: number };
/** 节点的输入，按 data.gen.order 排序；order 里没有的边排在后面（按边在文档里的顺序） */
export function inputsOf(doc: CanvasDoc, id: string): InputRef[] {
  const n = doc.nodes.find((x) => x.id === id); if (!n) return [];
  const order = genOf(n).order;
  const edges = doc.edges.filter((e) => e.to === id);
  const rank = (e: CanvasEdge) => { const i = order.indexOf(e.id); return i < 0 ? 1e6 + edges.indexOf(e) : i; };
  return edges.slice().sort((a, b) => rank(a) - rank(b)).map((edge, i) => ({ edge, node: doc.nodes.find((x) => x.id === edge.from)!, order: i })).filter((x) => x.node);
}
export const outputsOf = (doc: CanvasDoc, id: string) => doc.edges.filter((e) => e.from === id).map((e) => doc.nodes.find((n) => n.id === e.to)).filter((n): n is CanvasNode => !!n);
/** 分组作为生成输入时展开成组内节点；普通分组按画布位置排序，堆叠保持叠内顺序。 */
export function expandGroupInputs(doc: CanvasDoc, inputs: InputRef[]): InputRef[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const expanded = inputs.flatMap((x) => {
    if (x.node.kind !== "group") return [x];
    const stacked = !!(x.node.data && typeof x.node.data === "object" && (x.node.data as { stack?: unknown }).stack);
    const members = (x.node.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n && isGenKind(n.kind));
    if (!stacked) members.sort((a, b) => a.y - b.y || a.x - b.x);
    return members.map((node) => ({ edge: { ...x.edge, id: `${x.edge.id}:${node.id}` }, node, order: x.order }));
  });
  return expanded.map((x, order) => ({ ...x, order }));
}
export function wouldCycle(doc: CanvasDoc, from: string, to: string): boolean {
  const seen = new Set<string>(); const stack = [to];
  while (stack.length) { const x = stack.pop()!; if (x === from) return true; if (seen.has(x)) continue; seen.add(x); doc.edges.filter((e) => e.from === x).forEach((e) => stack.push(e.to)); }
  return false;
}
/** 能不能从 from 连到 to；不能时返回原因 */
export function connectBlock(doc: CanvasDoc, from: string, to: string): string | null {
  if (from === to) return "不能连到自己";
  if (doc.edges.some((e) => e.from === from && e.to === to)) return "这两个节点已经连着";
  if (wouldCycle(doc, from, to)) return "不能连成环：下游节点不能再作为上游的输入";
  const a = doc.nodes.find((n) => n.id === from), b = doc.nodes.find((n) => n.id === to);
  if (!a || !b) return "节点不存在";
  if (b.kind === "image" && a.kind === "audio") return "图片节点不接收音频输入";
  if (b.kind === "group") return "分组不接收输入";
  if (a.kind === "group" && !isGenKind(b.kind)) return "分组只能连到生成节点：组内素材会按顺序作为输入";
  return null;
}

/** 视频节点按输入自动选生成方式 */
export function autoVideoMode(doc: CanvasDoc, id: string, m: ModelSpec): VideoMode | null {
  const n = doc.nodes.find((x) => x.id === id); if (!n || n.kind !== "video") return null;
  const ins = expandGroupInputs(doc, inputsOf(doc, id)); const modes = m.modes || ["文生视频"];
  const imgs = ins.filter((x) => x.node.kind === "image").length, vids = ins.filter((x) => x.node.kind === "video").length, auds = ins.filter((x) => x.node.kind === "audio").length;
  const want: VideoMode = vids ? (imgs ? "参考视频生视频" : "视频延长") : auds && imgs ? "数字人" : imgs === 0 ? "文生视频" : imgs === 1 ? "首帧" : imgs === 2 ? "首尾帧" : "参考生视频";
  if (modes.includes(want)) return want;
  if (vids && modes.includes("视频编辑")) return "视频编辑";
  const alt: VideoMode = imgs ? "参考生视频" : "文生视频";
  return modes.includes(alt) ? alt : modes[0];
}

/* ---------- 引用 @节点·段落 ---------- */
export function sectionsOf(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}; const re = /(海报|镜头|方案)\s*(\d)\s*[：:]?\s*\n?([\s\S]*?)(?=\n\s*(?:海报|镜头|方案)\s*\d|$)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) out[m[1] + m[2]] = m[3].trim();
  return out;
}
export function refsIn(prompt: string, ins: InputRef[]) {
  const found: Array<{ node: CanvasNode; key: string; text: string; order: number }> = [], missing: string[] = [];
  const re = /@([^\s@，。,]+?)·((?:海报|镜头|方案)\d)/g; let mm: RegExpExecArray | null;
  while ((mm = re.exec(prompt || ""))) {
    const hit = ins.find((x) => genOf(x.node).title === mm![1]); const secs = hit ? sectionsOf(textOf(hit.node)) : {};
    if (hit && secs[mm[2]]) found.push({ node: hit.node, key: mm[2], text: secs[mm[2]], order: hit.order }); else missing.push(mm[1] + "·" + mm[2]);
  }
  return { found, missing };
}

/* ---------- 小工具 ---------- */
let _seq = 0;
export const uid = (p = "n") => p + "_" + Date.now().toString(36) + (++_seq).toString(36) + Math.random().toString(36).slice(2, 5);
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export function ratioWH(r: string | undefined, long = 640): [number, number] {
  if (!r || /auto|自适应/i.test(r)) r = "3:4";
  const [a, b] = r.split(":").map(Number); if (!a || !b) return [long, long];
  return a >= b ? [long, Math.round((long * b) / a)] : [Math.round((long * a) / b), long];
}
export function bounds(nodes: CanvasNode[]) {
  if (!nodes.length) return null;
  const x = Math.min(...nodes.map((n) => n.x)), y = Math.min(...nodes.map((n) => n.y));
  const r = Math.max(...nodes.map((n) => n.x + n.w)), b = Math.max(...nodes.map((n) => n.y + n.h + 24));
  return { x, y, w: r - x, h: b - y };
}
export const nowStr = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

/* ---------- 视频草稿模式 ---------- */
/** 模型支持的最低 / 最高清晰度（按档位数值比较） */
export function resRange(m: ModelSpec | undefined): { low: string; high: string } | null {
  const list = (m?.res || []).filter(Boolean); if (list.length < 2) return null;
  const sorted = list.slice().sort((a, b) => (tierNum(a) || 0) - (tierNum(b) || 0));
  return sorted[0] === sorted[sorted.length - 1] ? null : { low: sorted[0], high: sorted[sorted.length - 1] };
}
/** 草稿模式下真正发出去的清晰度 */
export function draftRes(p: VideoParams, m: ModelSpec | undefined): string { const r = resRange(m); return p.draft && r ? r.low : p.res; }
