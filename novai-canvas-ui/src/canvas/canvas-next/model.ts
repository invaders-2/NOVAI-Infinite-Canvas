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
import { fitMediaBox, ratioOf } from "./mediaFit";

export type GenKind = "text" | "image" | "video" | "audio";
export const GEN_KINDS: GenKind[] = ["text", "image", "video", "audio"];
export const isGenKind = (k: NodeKind | string): k is GenKind => k === "text" || k === "image" || k === "video" || k === "audio";

export const TYPE_LABEL: Record<GenKind, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
export const TYPE_ICON = { image: "image", video: "video", text: "text", audio: "audio" } as const;

/* ---------- 参数 ---------- */
export type CameraParams = { on: boolean; body: number; lens: number; focal: number; aperture: number };
/** Midjourney 专属参数（只在模型规格带 mj 时出现）：version 为空 = 交给上游默认；"niji 7" 这种带 niji 前缀 */
export type MjParams = { version?: string; speed?: string; hd?: boolean; stylize?: number };
/**
 * Midjourney 图生视频能力位（后端 caps.mj_video；图片模型 midjourney 的 mj.video 同一形状）。
 * 只装后端确证下发的键，缺字段 = 这一项没有能力，前端不猜取值、不补默认档位。
 */
export type MjVideoSpec = {
  /** 上游提交路径（仅标识，真正请求由后端发） */
  endpoint?: string;
  /** 上游模型 id（不进请求体） */
  upstreamModel?: string;
  /** 输入二选一：image_urls / task_id */
  inputSources: string[];
  requiresFirstFrame: boolean;
  supportsEndFrame: boolean;
  durationSeconds?: number;
  durationFixed: boolean;
  motions: string[];
  motionDefault?: string;
  videoTypes: string[];
  videoTypeDefault?: string;
  /** 档位 → video_type（无尾帧） */
  baseByTier: Record<string, string>;
  /** 档位 → video_type（有尾帧，自动升级 start_end_*） */
  startEndByTier: Record<string, string>;
  startEndVideoTypes: string[];
  animateModes: string[];
  batch: number[];
  batchDefault?: number;
  indexMin?: number;
  indexMax?: number;
  billing: string[];
  /** 档位 → 计费 id（费 = 单价 × batch） */
  billingByTier: Record<string, string>;
};
export type ImageParams = { model: string; ratio: string; size: string; /** 尺寸档（1K/2K/4K，来自方案卡 settings；原图比例按它算显式 WxH） */ resolution?: string; /** 「原图比例」选中的显式 WxH（不填则沿用尺寸档） */ sourceSize?: string; count: number; search: boolean; style: string; camera: CameraParams; mj?: MjParams; /** 质量档（后端 caps.qualities 里的一档）；不填 / auto = 不传 = 上游默认 */ quality?: string; /** 先思考（只有 caps.thinking_mode 的模型有）；undefined = 不传，交给模型决定 */ thinking?: boolean; /** 输出格式（后端 caps.output_formats）：gif / svg；不填 = 静态图（不发字段） */ outputFormat?: "gif" | "svg"; /** GIF 帧数（只有 outputFormat=gif 时下发）；不填 = caps 默认 9 */ frameCount?: number; /** GIF 每帧时长 ms（只有 outputFormat=gif 时下发）；不填 = 200 */ frameDuration?: number; /** 背景（后端 caps.native_background / caps.background）：不填 = 不传字段（跟随上游默认）；transparent 只给原生透明背景的模型，auto / opaque 只给 mai 这类声明了枚举的模型 */ background?: "transparent" | "auto" | "opaque"; /** 长图用途（后端 caps.skill，kling-v4-long-image 必填）：ecommerce / webpage */ skill?: string; /** 长图篇幅（后端 caps.length，只在 skill=ecommerce 生效）：short / medium / long */ length?: string; /** 系列模式张数（后端 caps.series，kling-v4-image 2–4）：不填 = 按普通 n 张出 */ seriesImages?: number };
export type VideoMode = "文生视频" | "首帧" | "首尾帧" | "参考生视频" | "视频编辑" | "视频延长" | "参考视频生视频" | "数字人";
export type VideoParams = { model: string; mode: VideoMode; ratio: string; res: string; dur: number; sound: boolean; times: number; /** 多镜头（高级设置） */ multiShot?: boolean; /** 生成模式（4K / 标准 / 专业…，仅规格声明的模型可用） */ genMode?: string; /** 极速模式（仅规格声明的模型可用） */ turbo?: boolean; /** 草稿模式（Seedance 两段式）：先按草稿档出 480p，满意后再出成片；只有 caps.draft 的模型可用 */ draft?: boolean; /** 成片步：草稿任务 id（这一段只发 model + draft_task_id + resolution，其余字段后端会忽略） */ draftTaskId?: string;
  /** Midjourney 图生视频（只有 caps.mj_video 的模型带，其它模型一律不下发）：运动幅度 low / high */
  motion?: string;
  /** MJ 上游 batch_size（1/2/4）：一次出 N 条，费用按 N 倍计 */
  mjBatch?: number;
  /** 复用某次 MJ 出图任务的上游 task_id（不是画布任务 id）；与首帧图二选一 */
  mjTaskId?: string;
  /** 复用 MJ 出图任务的候选下标 0–3（必须配 mjTaskId） */
  mjIndex?: number;
  /** animate_mode：manual / auto（auto 必须 mjTaskId + 显式 mjIndex） */
  animateMode?: string;
  /** 内容审核开关（只有 caps 带该布尔位的模型才有）：只在打开时发 nsfw_check，默认不带 */
  nsfw?: boolean; };
export type TextParams = { model: string; search: boolean; /** 输出：文本 / 多维表格 / 分镜表 */ output?: "text" | "table" | "storyboard"; /** 模型强度档位（后端 model_caps.think 里的一档）；不填 = 不传 = 模型默认 */ think?: string };
export type AudioParams = { model: string; kind: string; dur: string };
export type ParamsOf<K extends GenKind> = K extends "image" ? ImageParams : K extends "video" ? VideoParams : K extends "text" ? TextParams : AudioParams;
export type AnyParams = ImageParams | VideoParams | TextParams | AudioParams;

/** 素材库条目引用（gen.asset）：id 是资产库条目 id；use 是用途（product / model / scene / source / depth / style / sound） */
export type AssetRef = { id: string; use?: string; productId?: string; name?: string };

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
  /** 草稿任务 id（后端返回体的 task_id）：出成片时只发它 + 目标分辨率，成片任务另起 id 轮询 */
  draftTaskId?: string;
  /** 音频波形（0~1），后端不给时前端从音频解码或用占位 */
  bars?: number[];
  meta?: { model?: string; ratio?: string; size?: string; at?: number; runId?: string; remote?: string; /** 上传文档的文件名 */ doc?: string; /** 后端返回的尺寸收敛说明（如 GIF 每帧尺寸被拼版上限缩小），写回后 toast 一次 */ notice?: string; /** 生成这一版时「@ 本节点」实际发出去的自我参考图：string = 那张源图；null = 明确没发（没有可用源图 / 模型不收）。字段缺失 = 这次改动之前的旧数据，读取时走旧回退（见 mentions.selfSourceOf） */ selfSrc?: string | null; /** 出这一版时用的提示词（归一比较见 mentions.samePromptAsVersion）：提示词没改 = 重复生成，不再带上一版结果；改过 = 用户在这张基础上改，仍带当前这一版当第一参考 */ prompt?: string };
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
  /** 从素材库放上来的节点记住来源素材：助手据此知道「这是哪个产品 / 什么用途」，以后也能存回原条目 */
  asset?: AssetRef;
  /** 拆分图层：结果节点已建好，正在等全屏编辑器回传合成图（上一版；新入口用 split） */
  splitPending?: boolean;
  /** 拆分图层：结果节点里的内联编辑器配置（源图 / 模式 / 加载状态） */
  split?: { sourceId: string; mode: "auto" | "custom"; status: "loading" | "ready" | "error" };
  /**
   * 后端还在跑的任务 id（持久化）：离开画布 / 切到别的画布时任务没写完，
   * 回来按它接上轮询并写回（完成 / 失败后清掉）。
   */
  taskId?: string;
  /** 最近一次失败的说明（人话；持久化，刷新后仍能看到） */
  err?: string;
  /** 失败时的原始错误码（如 MODEL_TIMEOUT）：只在弹层里以 12px 灰字展示，便于排查 */
  errCode?: string;
  /** 「引用模式」：插入过 @ 引用后，只发送提示词里 @ 到的上游（见 mentions.ts） */
  refMode?: "mention";
  /** 调色结果：源图引用 + 参数，再次调色从原图继续（source.url 存 compact 地址，不存 data URL） */
  adjust?: { v: 2; source: { url: string; name: string }; params: unknown };
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
  ratios?: string[]; sizes?: string[]; maxRefs?: number; refNote?: string; i2i?: boolean; search?: boolean; style?: boolean; camera?: boolean; batch?: number[]; /** caps 没给 n_max：张数只能保守给 1，面板提示上限未知 */ batchUnknown?: boolean;
  /** 质量档（后端 caps.qualities 原样）；空 / 只有 1 档 = 不给入口 */
  qualities?: string[];
  /** 先思考开关（后端 caps.thinking_mode）；没有这个字段 = 不支持，不给入口 */
  thinkingMode?: boolean;
  /** 输出格式（后端 caps.output_formats，已小写去重）；没有 gif / svg = 面板不给「输出格式」入口 */
  outputFormats?: string[];
  /** GIF 帧参数（后端 caps.gif_frames；缺失时用 GIF_FRAME_FALLBACK，面板照常给控件） */
  gifFrames?: GifFrameSpec;
  /** 透明背景（后端 caps.native_background）；没有这个字段 = 不支持，面板不给入口 */
  nativeBackground?: boolean;
  /** 系列模式张数区间（后端 caps.series）；没有 = 面板不给系列开关 */
  series?: { min: number; max: number };
  /** 长图用途（后端 caps.skill）；有才给「用途」入口 */
  skill?: string[];
  /** 长图篇幅（后端 caps.length，只在 skill=ecommerce 生效） */
  length?: string[];
  /** 上游接受的 background 枚举（后端 caps.background，mai：auto / opaque） */
  backgroundAllowed?: string[];
  /** 后端 caps.send_size：显式 false = 请求体不能带 size，面板不渲染比例 / 尺寸 */
  sendSize?: boolean;
  /** 后端 caps.exact_size_pair：精确像素按 width/height 成对下发（mai） */
  exactSizePair?: boolean;
  /** 精确像素约束（后端 caps.min_side / caps.size_step，mai：768 / 32） */
  minSide?: number;
  sizeStep?: number;
  /** 只返回提示词、不产视频（后端 caps.prompt_only）：面板隐藏视频参数，结果按提示词说明 */
  promptOnly?: boolean;
  // video
  modes?: VideoMode[]; res?: string[]; durs?: number[]; audio?: boolean; times?: number[]; multiShot?: boolean;
  /** 声音默认开（后端 caps.audio_default_on）：新建节点 / 切到该模型时音频开关默认打开 */
  audioDefaultOn?: boolean;
  /** 参考上限（后端 caps.ref_max / video_ref_max / audio_ref_max）：面板按上限提示，缺哪条不提哪条 */
  imageRefMax?: number;
  videoRefMax?: number;
  audioRefMax?: number;
  /** 内容审核开关（后端 caps 的布尔能力位）；缺省 = 面板不给这个入口 */
  nsfw?: boolean;
  /** 首帧方式画幅跟随首帧（后端 caps.ratio_follows_first_frame）：比例列表丢 21:9 并提示 */
  ratioFollowsFirstFrame?: boolean;
  /** Seedance 草稿两段式（后端 caps.draft 声明才有；缺省 = 该模型不支持草稿） */
  draft?: boolean;
  /** 草稿阶段固定档位（caps.draft_resolution；缺省时回落最低档） */
  draftRes?: string;
  /** 成片可选档位（caps.draft_final_resolutions，原样；空 = 没有成片入口） */
  draftFinals?: string[];
  /** 草稿有效期天数（caps.draft_expires_days；缺省 = 不写死天数） */
  draftExpiresDays?: number;
  /** Midjourney 图生视频能力位（caps.mj_video）；缺省 = 这个模型没有 MJ 视频入口 */
  mjVideo?: MjVideoSpec;
  /** 生成模式（TapNow 的 4K / 标准 / 专业 / 大 / 中 / 小）：只有服务商规格声明时才出现 */
  genModes?: string[];
  /** 极速模式（TapNow 的 turbo）：只有规格声明时才出现 */
  turbo?: boolean;
  /** Midjourney：可选版本 / 速度 / 支持 HD 的版本（服务商规格声明时才有） */
  mj?: { versions: string[]; speeds: string[]; hd: string[] };
  // text
  vision?: boolean;
  /** 模型强度档位键（后端 /api/config 的 provider.model_caps[model].think）；空 = 不支持，面板不给入口 */
  think?: string[];
  // audio
  kinds?: string[]; adurs?: string[];
  /**
   * 规格来源：`spec` = 后端适配器给了 uiSpec（以它为准）；`guess` = 没规格，按模型名套 PRESETS 兜底（面板显示「未验证」）。
   * 可选能力（联网 / 风格 / 摄影机 / 批量 / 参考图上限）只在 spec 里出现才算支持。
   */
  specSource?: "spec" | "guess";
  /**
   * 后端 /api/model-caps 里有这条规格、但没登记进「设置 → API」的模型清单：节点编辑器里当候选显示，
   * 选中它不改设置里的清单（见 novaiBackend.listModels 的候选合并）。
   */
  unlisted?: boolean;
  /** 用户在下拉里从上游目录挑的清单外模型（只存本机，见 modelExtras）：和 unlisted 一样只是入口，不是配置 */
  extra?: boolean;
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
/** 视频时长档：-1 表示「自动 / 模型自选」（caps 里可能带），其余是正数秒数 */
export function durationTiers(durs: number[] | undefined | null): { auto: boolean; positive: number[] } {
  const list = (durs || []).filter((value) => Number.isFinite(Number(value))).map(Number);
  return { auto: list.includes(-1), positive: list.filter((value) => value > 0) };
}
/** 视频时长滑块的档位：-1 排最左（标签「自动」），其余按秒；只有一档时调用方给只读文案（见 DurationSlider） */
export function durationSliderLevels(durs: number[] | undefined | null): { levels: string[]; labels: Record<string, string> } {
  const { auto, positive } = durationTiers(durs);
  const levels = [...(auto ? ["-1"] : []), ...positive.map((value) => String(value))];
  const labels: Record<string, string> = {};
  for (const level of levels) labels[level] = level === "-1" ? "自动" : level + "s";
  return { levels, labels };
}
/** 上游多数视频模型的默认时长是 5 秒（文档口径 default 5） */
const DEFAULT_VIDEO_SECONDS = 5;
/** 模型默认时长：档位里有 5 秒就用上游默认的 5 秒，否则退第一个正数档（-1=自动不参与默认） */
export function defaultVideoDuration(model: ModelSpec | null | undefined): number {
  const { auto, positive } = durationTiers(model?.durs);
  if (positive.includes(DEFAULT_VIDEO_SECONDS)) return DEFAULT_VIDEO_SECONDS;
  return positive[0] ?? (auto ? -1 : DEFAULT_VIDEO_SECONDS);
}
/** 换模型时时长收敛：合法值保留；「自动」只给支持 -1 的模型；否则收到最接近的正数档 */
export function clampVideoDuration(model: ModelSpec | null | undefined, current: unknown): number {
  const { auto, positive } = durationTiers(model?.durs);
  const list = auto ? [-1, ...positive] : positive;
  const raw = String(current ?? '').trim();
  const cur = Number(current);
  const explicit = raw !== '' && current !== null && current !== undefined && Number.isFinite(cur);
  if (!list.length) return explicit && cur > 0 ? cur : 5;
  const nearest = (values: number[]) => values.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a), values[0]);
  if (explicit && list.includes(cur)) return cur;
  if (explicit && cur > 0) return nearest(positive.length ? positive : list);
  if (explicit && cur <= 0 && auto) return -1;
  return positive[0] ?? list[0];
}
/** 时长档标签（模型清单 / 参数摘要用）：有 -1 带「自动」 */
export function videoDurationTagLabel(durs: number[] | undefined | null): string {
  const { auto, positive } = durationTiers(durs);
  const range = positive.length
    ? (Math.min(...positive) === Math.max(...positive) ? Math.min(...positive) + 'S' : Math.min(...positive) + '-' + Math.max(...positive) + 'S')
    : '';
  return [auto ? '自动' : '', range].filter(Boolean).join(' · ');
}
/** 清晰度：空 / 自适应 → 自适应 */
export function videoResLabel(res: unknown): string {
  const text = String(res == null ? "" : res).trim();
  return !text || /^(自动|自适应|auto|adaptive)$/i.test(text) ? "自适应" : text;
}
/** 真实像素 → 档位标签（和视频档位同一套小写 p 写法）：按最短边定档，拿不到有效宽高就返回空串，不瞎猜 */
export function resTierLabel(w: unknown, h: unknown): string {
  const a = Number(w); const b = Number(h);
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return "";
  const short = Math.min(a, b);
  if (short >= 2000) return "4K";
  if (short >= 1400) return "2K";
  if (short >= 1000) return "1080p";
  if (short >= 660) return "720p";
  if (short >= 420) return "480p";
  return "";
}
/** 比例：adaptive / 自动 / 空 → 原图比例（用户口径：跟随源图比例） */
export function videoRatioLabel(ratio: unknown): string {
  const text = String(ratio == null ? "" : ratio).trim();
  return !text || /^(自动|自适应|auto|adaptive)$/i.test(text) ? "原图比例" : text;
}
/**
 * 视频参考素材上限的提示：全部来自后端 caps（图 ref_max / 视频 video_ref_max / 音频 audio_ref_max），
 * 缺哪条就不提哪条；一条都没有返回空串（面板不渲染这行）。
 */
export function videoRefHint(model: ModelSpec | null | undefined): string {
  const count = (value: unknown) => { const n = Math.floor(Number(value)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const images = count(model?.imageRefMax); const videos = count(model?.videoRefMax); const audios = count(model?.audioRefMax);
  const parts: string[] = [];
  if (images) parts.push("图 ≤" + images);
  if (videos) parts.push("视频 ≤" + videos);
  if (audios) parts.push("音频 ≤" + audios);
  if (!parts.length) return "";
  return "参考素材上限：" + parts.join(" · ") + (audios ? "；音频每段 2–30 秒、合计建议 ≤30 秒" : "");
}
/** 首帧 / 首尾帧方式下画幅跟随首帧（caps.ratio_follows_first_frame）：上游这些方式不收比例字段 */
export function videoRatioFollowsFirstFrame(model: ModelSpec | null | undefined, mode?: unknown): boolean {
  if (model?.ratioFollowsFirstFrame !== true) return false;
  return mode === "首帧" || mode === "首尾帧";
}
/**
 * 视频比例的可选值：图生视频（首帧 / 首尾帧）丢掉 21:9 —— 上游首帧方式只认前面几个画幅；
 * 判据是 caps 的 ratio_follows_first_frame，不按模型名写死。
 */
export function videoRatioOptions(model: ModelSpec | null | undefined, mode?: unknown): string[] {
  const ratios = Array.isArray(model?.ratios) ? model!.ratios! : [];
  if (!videoRatioFollowsFirstFrame(model, mode)) return [...ratios];
  return ratios.filter((ratio) => String(ratio).trim() !== "21:9");
}
/** 视频分辨率可选值：只有一档画质时不给下拉（底栏已经写明这档），避免弹出一个只有一项的分辨率 */
export function videoResChoices(model: ModelSpec | null | undefined): string[] {
  const list = Array.isArray(model?.res) ? model!.res! : [];
  return list.length > 1 ? [...list] : [];
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

/* ---------- 模型强度（思考强度档位） ---------- */
/**
 * 档位键沿用后端 THINK_LEVELS（main.py）：low / mid / high / xhigh / max，中文 低/中/高/极高/Max。
 * 真值源是 /api/config 里 provider.model_caps[chatModel].think（后端按模型能力下发），
 * 前端只认这几个键，不自己新增、不按模型名猜：没下发 = 不支持 = 不给入口。
 */
export const THINK_LEVEL_KEYS = ["low", "mid", "high", "xhigh", "max"] as const;
export type ThinkLevel = (typeof THINK_LEVEL_KEYS)[number];
export const THINK_LEVEL_LABEL: Record<string, string> = { low: "低", mid: "中", high: "高", xhigh: "极高", max: "Max" };
/** 后端下发的档位 → 合法档位数组（丢掉未知键、去重、按 low→max 排序）；不是数组 = 空 = 不支持 */
export function normalizeThinkLevels(raw: unknown): string[] {
  const known = (Array.isArray(raw) ? raw : []).map((item) => String(item ?? "").trim())
    .filter((item) => (THINK_LEVEL_KEYS as readonly string[]).includes(item));
  return [...new Set(known)].sort((a, b) => (THINK_LEVEL_KEYS as readonly string[]).indexOf(a) - (THINK_LEVEL_KEYS as readonly string[]).indexOf(b));
}
/** 这个模型能选的档位；空数组 = 不支持，入口不显示 */
export function thinkLevelsFor(model: ModelSpec | null | undefined): string[] {
  return normalizeThinkLevels(model?.think);
}
/** 档位中文名：低 / 中 / 高 / 极高 / Max（认不出的键原样显示，不编造） */
export function thinkLevelLabel(level: unknown): string {
  const key = String(level ?? "").trim();
  return THINK_LEVEL_LABEL[key] || key;
}
/**
 * 换模型时收敛当前档位：新模型不支持 → 清空；当前档位不在新列表里 → 收到第一个合法档位；
 * 没选过（空 = 默认）保持空，不替用户做决定。
 */
export function clampThinkLevel(levels: string[], current: unknown): string {
  const cur = String(current ?? "").trim();
  if (!levels.length || !cur) return "";
  return levels.includes(cur) ? cur : levels[0];
}
/** 面板要不要给「模型强度」入口：多于 1 档才给（只有一档等于没有选择） */
export function thinkEntryAvailable(model: ModelSpec | null | undefined): boolean {
  return thinkLevelsFor(model).length > 1;
}

/* ---------- 图片质量档 / 先思考（同样只认后端 caps，不按模型名猜） ---------- */
/** 质量档文案：caps 的接口值 → 中文；认不出的值原样显示（不编造） */
export const QUALITY_LABEL: Record<string, string> = { auto: "自动", low: "低", medium: "中", high: "高", xhigh: "极高", max: "Max" };
/** 后端下发的质量档 → 面板档位（去重、保留 caps 顺序；不是数组 = 空） */
export function normalizeQualities(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : []).map((item) => String(item ?? "").trim()).filter(Boolean);
  return [...new Set(list)];
}
export function qualityLevelsFor(model: ModelSpec | null | undefined): string[] {
  return normalizeQualities(model?.qualities);
}
export function qualityLabel(value: unknown): string {
  const key = String(value ?? "").trim();
  return QUALITY_LABEL[key.toLowerCase()] || key;
}
/** 面板要不要给「质量」入口：多于 1 档才给（只有一档等于没有选择） */
export function qualityEntryAvailable(model: ModelSpec | null | undefined): boolean {
  return qualityLevelsFor(model).length > 1;
}
/** 换模型时收敛质量档：新模型没有质量档 → 清空；不在新列表里 → 收到第一个合法档；没选过保持空 */
export function clampQuality(levels: string[], current: unknown): string {
  const cur = String(current ?? "").trim();
  if (!levels.length || !cur) return "";
  if (levels.includes(cur)) return cur;
  const hit = levels.find((level) => level.toLowerCase() === cur.toLowerCase());
  return hit || levels[0];
}
/** 档位是不是「不指定质量档」：空 / auto 都不发字段，语义相同 */
export function isQualityDefault(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return !text || text.toLowerCase() === "auto";
}
/** 质量菜单项：auto 和「默认」都不发字段，合并成一项放最前（避免两个入口说同一件事） */
export type QualityChoice = { value: string; label: string; /** 选中它 = 不指定质量档（不发字段） */ isDefault: boolean };
export function qualityChoices(model: ModelSpec | null | undefined): QualityChoice[] {
  const levels = qualityLevelsFor(model);
  const hasAuto = levels.some((level) => level.toLowerCase() === "auto");
  const head: QualityChoice = hasAuto
    ? { value: "auto", label: "自动（默认）", isDefault: true }
    : { value: "", label: "默认", isDefault: true };
  return [head, ...levels.filter((level) => level.toLowerCase() !== "auto").map((level) => ({ value: level, label: qualityLabel(level), isDefault: false }))];
}
/** 发请求用的质量档：空 / auto = 不传（跟随上游默认） */
export function qualityForRequest(quality: unknown): string {
  const value = String(quality ?? "").trim();
  return !value || value.toLowerCase() === "auto" ? "" : value;
}
/** 有没有「先思考」开关：只认后端 caps.thinking_mode */
export function thinkingAvailable(model: ModelSpec | null | undefined): boolean {
  return model?.thinkingMode === true;
}
/** 换模型时收敛：新模型没有开关 → 清空；没有明确选择（undefined）保持「模型决定」 */
export function clampThinking(available: boolean, current: unknown): boolean | undefined {
  if (!available) return undefined;
  return current === true || current === false ? current : undefined;
}
/** 发请求用的 thinking_mode：只有用户明确开 / 关才传，不传 = 模型决定 */
export function thinkingForRequest(thinking: unknown): boolean | undefined {
  return thinking === true || thinking === false ? thinking : undefined;
}
/** 这个模型只产出提示词、不产视频（后端 caps.prompt_only）：面板隐藏视频参数，结果不是视频 */
export function promptOnlyModel(model: ModelSpec | null | undefined): boolean {
  return model?.promptOnly === true;
}

/* ---------- 图片输出格式（静态图 / GIF 动图 / SVG 矢量，只认后端 caps.output_formats） ---------- */
/** "" = 静态图（请求不带 output_format），gif / svg 才带字段 */
export type ImageOutputFormat = "gif" | "svg";
export const OUTPUT_FORMAT_LABEL: Record<string, string> = { "": "静态图", gif: "GIF 动图", svg: "SVG 矢量" };
/** 格式文案：gif / svg 认名字；其余（含空）都是静态图，和请求口径一致 */
export function outputFormatLabel(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  return OUTPUT_FORMAT_LABEL[key] || OUTPUT_FORMAT_LABEL[""];
}
/** 底栏摘要用的短文案：静态图保持全称，GIF / SVG 只留名字（面板按钮仍用 OUTPUT_FORMAT_LABEL 全称） */
export const OUTPUT_FORMAT_SHORT_LABEL: Record<string, string> = { "": "静态图", gif: "GIF", svg: "SVG" };
export function outputFormatShortLabel(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  return OUTPUT_FORMAT_SHORT_LABEL[key] || OUTPUT_FORMAT_SHORT_LABEL[""];
}
/** 面板选项：静态图永远有；GIF / SVG 只在 caps 声明时才出现，一个都没有 = 返回空 = 不给入口 */
export function outputFormatOptions(model: ModelSpec | null | undefined): Array<{ value: "" | ImageOutputFormat; label: string }> {
  const caps = (Array.isArray(model?.outputFormats) ? model.outputFormats : []).map((item) => String(item ?? "").trim().toLowerCase());
  const extra = (["gif", "svg"] as ImageOutputFormat[]).filter((value) => caps.includes(value));
  return extra.length ? [{ value: "", label: OUTPUT_FORMAT_LABEL[""] }, ...extra.map((value) => ({ value, label: OUTPUT_FORMAT_LABEL[value] }))] : [];
}
/** 发请求用的输出格式：只有 gif / svg 才带字段，静态图 / 认不出的值一律空串 */
export function outputFormatForRequest(value: unknown): "" | ImageOutputFormat {
  const key = String(value ?? "").trim().toLowerCase();
  return key === "gif" || key === "svg" ? key : "";
}

/* ---------- GIF 帧参数（只有 outputFormat=gif 才生效） ---------- */
/** 后端 caps.gif_frames 缺省 / 请求失败时的兜底：2–16 帧、默认 9、每帧 200ms、时长 20–2000 步进 10 */
export const GIF_FRAME_FALLBACK = { min: 2, max: 16, default: 9, durationDefault: 200, durationMin: 20, durationMax: 2000, durationStep: 10 } as const;
export type GifFrameSpec = { min: number; max: number; default: number; durationDefault: number };
/** 这个模型的 GIF 帧参数；没有 caps 也照样给兜底（控件不能因为读不到就消失） */
export function gifFrameSpec(model: ModelSpec | null | undefined): GifFrameSpec {
  const raw = model?.gifFrames;
  const num = (value: unknown, fallback: number) => {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const min = Math.max(2, num(raw?.min, GIF_FRAME_FALLBACK.min));
  const max = Math.max(min, num(raw?.max, GIF_FRAME_FALLBACK.max));
  return { min, max, default: Math.max(min, Math.min(max, num(raw?.default, GIF_FRAME_FALLBACK.default))), durationDefault: num(raw?.durationDefault, GIF_FRAME_FALLBACK.durationDefault) };
}
/** 帧数：按 caps 夹在 2–16（缓存里的非法值 / 空值回默认） */
export function gifFrameCountFor(value: unknown, model?: ModelSpec | null): number {
  const spec = gifFrameSpec(model);
  const raw = Number(value);
  const count = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : spec.default;
  return Math.max(spec.min, Math.min(spec.max, count));
}
/** 每帧时长 ms：20–2000、10ms 取整（不发小数；空值回默认） */
export function gifFrameDurationFor(value: unknown, model?: ModelSpec | null): number {
  const spec = gifFrameSpec(model);
  const raw = Number(value);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : spec.durationDefault;
  const stepped = Math.round(ms / GIF_FRAME_FALLBACK.durationStep) * GIF_FRAME_FALLBACK.durationStep;
  return Math.max(GIF_FRAME_FALLBACK.durationMin, Math.min(GIF_FRAME_FALLBACK.durationMax, stepped));
}
/** 请求体里的 GIF 帧字段：只有 outputFormat=gif 才带，且按 caps 夹好；静态图 / SVG 返回空对象（不发这两个字段） */
export function gifFrameFieldsForRequest(params: Pick<ImageParams, "outputFormat" | "frameCount" | "frameDuration">, model?: ModelSpec | null): { frame_count?: number; frame_duration_ms?: number } {
  if (outputFormatForRequest(params.outputFormat) !== "gif") return {};
  return { frame_count: gifFrameCountFor(params.frameCount, model), frame_duration_ms: gifFrameDurationFor(params.frameDuration, model) };
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
const UI_KEYS = ["ratios", "sizes", "batch", "batchUnknown", "maxRefs", "refNote", "i2i", "res", "durs", "modes", "audio", "times", "kinds", "adurs", "search", "style", "camera", "multiShot", "genModes", "turbo", "mj", "qualities", "thinkingMode", "promptOnly", "outputFormats", "gifFrames", "nativeBackground", "series", "skill", "length", "backgroundAllowed", "sendSize", "exactSizePair", "minSide", "sizeStep", "draft", "draftRes", "draftFinals", "draftExpiresDays", "mjVideo", "audioDefaultOn", "imageRefMax", "videoRefMax", "audioRefMax", "nsfw", "ratioFollowsFirstFrame"] as const;
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

export function specFor(row: { configId: string; label: string; vendor?: string; kind: GenKind; local?: boolean; vision?: boolean; search?: boolean; ui?: Record<string, unknown> | null; specSource?: string; /** 后端 model_caps[model].think 的档位键 */ think?: unknown }): ModelSpec {
  const prov = fromProvider(row.kind, row.ui);
  const thinkLevels = normalizeThinkLevels(row.think);
  const hasSpec = Object.keys(prov).length > 0;
  const preset = hasSpec ? {} : PRESETS.find((p) => p.spec.kind === row.kind && p.re.test(row.label))?.spec || {};
  // 有规格时：可选能力只认规格里明确的声明，规格没写就是「不支持」（不再从名字继承，也不回落猜测）。
  // 比例 / 档位 / 时长这类**必填取值**缺省时仍按同类型通用表兜底（否则面板无从选择），
  // 但 batch / maxRefs / i2i / times / audio / multiShot 这些**可选能力**缺省一律按不支持。
  const base = hasSpec
    ? {
      ...prov,
      search: prov.search === true, style: prov.style === true, camera: prov.camera === true,
      ...(row.kind === "image" ? { batch: prov.batch ?? [1], maxRefs: prov.maxRefs ?? 0, i2i: prov.i2i === true, ...(prov.batchUnknown === true ? { batchUnknown: true } : {}) } : {}),
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
    ...(thinkLevels.length ? { think: thinkLevels } : {}),
    specSource,
    // 能读图：能力表（row.vision）是后端声明的，不是名字猜的；联网：规格里有才算，没规格才按名字猜
    ...(row.kind === "text" ? {
      vision: row.vision ?? (hasSpec ? false : /vl|vision|gemini|gpt-4o|gpt-5|claude|qwen.*vl/i.test(row.label)),
      search: typeof prov.search === "boolean" ? prov.search : !hasSpec && (row.search ?? /gemini|search|联网/i.test(row.label)),
    } : {}),
  } as ModelSpec;
}

/** 节点参数的深拷贝：camera / mj 是嵌套对象，两个节点共用引用时改一个会串到另一个。 */
export function cloneParams<T extends AnyParams>(p: T): T {
  if (!p || typeof p !== "object") return p;
  try { return (typeof structuredClone === "function" ? structuredClone(p) : JSON.parse(JSON.stringify(p))) as T; }
  catch { return JSON.parse(JSON.stringify(p)) as T; }
}

/**
 * 旧画布迁移（幂等）：给 params.model 为空 / 失效的生成类节点写死一个具体模型 id。
 *   pick(kind, currentId) 返回要写入的 id；返回 null 表示这个 kind 没有可用模型，保持原样。
 *   只改需要改的节点，其余节点对象原样返回（引用不变），方便调用方判断是否需要落盘。
 */
export function pinMissingModelIds(doc: CanvasDoc, pick: (kind: GenKind, currentId: string) => string | null): { doc: CanvasDoc; changed: boolean } {
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (!isGenKind(n.kind)) return n;
    // 画布助手建好、等用户在待生成卡片里选模型的节点：不补默认模型
    if (n.data && typeof n.data === "object" && (n.data as { agentPending?: unknown }).agentPending) return n;
    const params = genOf(n).params as { model?: string };
    const current = String(params.model || "");
    const next = pick(n.kind, current);
    if (!next || next === current) return n;
    changed = true;
    return withGen(n, { params: { ...params, model: next } as AnyParams });
  });
  return changed ? { doc: { ...doc, nodes }, changed: true } : { doc, changed: false };
}

export function defaultParams(kind: GenKind, m?: ModelSpec): AnyParams {
  const model = m?.id || "";
  if (kind === "image") {
    // Midjourney 默认一次 4 张候选（batch 降序，batch[0] = 4；四宫格是免费赠品）；其它模型保持 1
    const count = m?.mj && Array.isArray(m.batch) && m.batch.length ? (Number(m.batch[0]) || 1) : 1;
    // 长图：用途必填、默认 ecommerce；篇幅只在 ecommerce 生效、默认 medium
    const skills = (m?.skill || []).map((item) => String(item).toLowerCase());
    const lengths = (m?.length || []).map((item) => String(item).toLowerCase());
    const skill = skills.length ? (skills.includes("ecommerce") ? "ecommerce" : skills[0]) : "";
    const length = skill === "ecommerce" && lengths.length ? (lengths.includes("medium") ? "medium" : lengths[0]) : "";
    return { model, ratio: m?.ratios?.includes("3:4") ? "3:4" : m?.ratios?.[0] || "1:1", size: m?.sizes?.includes("2K") ? "2K" : m?.sizes?.[0] || "1K", count, search: false, style: "无", camera: { ...DEFAULT_CAMERA }, ...(skill ? { skill } : {}), ...(length ? { length } : {}) };
  }
  if (kind === "video") {
    // MJ 图生视频没有画幅字段（caps 的 ratios 为空）：默认就表达成「原图比例」
    const rawRatio = mjVideoSpec(m) && !(m?.ratios || []).length ? "adaptive" : m?.ratios?.[0] || "16:9";
    // 没有「文生视频」的模型（MJ 图生视频只有「首帧」）：默认就用它支持的第一种方式，别先发一个必然 400 的方式
    const modes = m?.modes || [];
    const mode: VideoMode = modes.length && !modes.includes("文生视频") ? modes[0] : "文生视频";
    // MJ 图生视频的默认档位只听 caps 的 video_type_default（480p），不套通用「优先 720p」
    const mjTier = mjVideoDefaultTier(m);
    const res = mjTier && (m?.res || []).includes(mjTier) ? mjTier : m?.res?.includes("720p") ? "720p" : m?.res?.[0] || "720p";
    // 声音默认开只听 caps.audio_default_on（缺字段 = 沿用默认关）；内容审核有该能力位时默认关
    return { model, mode, ratio: /^(auto|adaptive|自适应)$/i.test(rawRatio) ? "adaptive" : rawRatio, res, dur: defaultVideoDuration(m), sound: m?.audio === true && m?.audioDefaultOn === true, times: 1, ...(m?.nsfw ? { nsfw: false } : {}), ...(mjVideoSpec(m) ? { motion: mjVideoMotion(m), mjBatch: mjVideoBatch(m), animateMode: "manual" } : {}) };
  }
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
    if (m.ratios && m.ratios.length && !m.ratios.includes(q.ratio)) q.ratio = m.ratios[0];
    if (m.sizes && m.sizes.length && !m.sizes.includes(q.size)) q.size = nearestTier(m.sizes, q.size);
    if (m.batch && !m.batch.includes(q.count)) q.count = m.batch[0];
    // Midjourney：从别的模型切过来时按「一次 4 张候选」起步（batch 降序，batch[0] = 4）；
    // 已经就是 MJ 时不覆盖，用户手动选的 1/2 张要保留
    if (m.mj && m.batch?.length && String((p as ImageParams).model || "") !== m.id) q.count = m.batch[0];
    if (!m.search) q.search = false; q.style = m.style ? normalizeStyle(q.style) : "无"; if (!m.camera) q.camera.on = false;
    // MJ 专属参数：换模型后非法值收敛（版本 / 速度不在该模型列表里 → 回默认；HD 只在版本允许时保留）
    if (m.mj) {
      const mj: MjParams = { ...(q.mj || {}) };
      if (mj.version && !m.mj.versions.includes(mj.version)) delete mj.version;
      if (mj.speed && !m.mj.speeds.includes(mj.speed)) delete mj.speed;
      if (mj.hd && !mjHdAllowed(m.mj, mj.version)) mj.hd = false;
      if (Object.keys(mj).length) q.mj = mj; else delete q.mj;
    } else delete q.mj;
    // 质量档 / 先思考同样按能力收敛：新模型没有就清掉，档位不在新列表里就收到第一档
    const quality = clampQuality(qualityLevelsFor(m), q.quality);
    if (quality) q.quality = quality; else delete q.quality;
    const thinking = clampThinking(thinkingAvailable(m), q.thinking);
    if (thinking === undefined) delete q.thinking; else q.thinking = thinking;
    // 输出格式：新模型没声明就清掉（也顺手把空串 / 脏值挡在参数外）
    const outputFormat = outputFormatForRequest(q.outputFormat);
    const outputFormats = (Array.isArray(m.outputFormats) ? m.outputFormats : []).map((item) => String(item ?? "").trim().toLowerCase());
    if (outputFormat && outputFormats.includes(outputFormat)) q.outputFormat = outputFormat; else delete q.outputFormat;
    // GIF 帧参数只跟 gif 一起存在：非 gif 一律删掉（请求 / 持久化都不留），gif 时按 caps 夹成合法值
    if (outputFormatForRequest(q.outputFormat) === "gif") {
      q.frameCount = gifFrameCountFor(q.frameCount, m);
      q.frameDuration = gifFrameDurationFor(q.frameDuration, m);
    } else { delete q.frameCount; delete q.frameDuration; }
    // 长图用途 / 篇幅 / 系列张数：只认新模型声明的取值（换模型后不留别家的值）
    const skills = (Array.isArray(m.skill) ? m.skill : []).map((item) => String(item).toLowerCase());
    if (skills.length) {
      const wanted = String(q.skill || "").trim().toLowerCase();
      q.skill = skills.includes(wanted) ? wanted : skills.includes("ecommerce") ? "ecommerce" : skills[0];
    } else delete q.skill;
    const lengths = (Array.isArray(m.length) ? m.length : []).map((item) => String(item).toLowerCase());
    if (lengths.length && q.skill === "ecommerce") {
      const wanted = String(q.length || "").trim().toLowerCase();
      q.length = lengths.includes(wanted) ? wanted : lengths.includes("medium") ? "medium" : lengths[0];
    } else delete q.length;
    const series = m.series;
    const seriesCount = Math.floor(Number(q.seriesImages));
    if (series && Number.isFinite(seriesCount) && seriesCount >= series.min && seriesCount <= series.max) q.seriesImages = seriesCount;
    else delete q.seriesImages;
    // send_size=false：像素尺寸由后端按档位折算 resolution，显式 WxH（原图比例）不再有意义
    if (m.sendSize === false) delete q.sourceSize;
    // 背景：透明只认 caps.native_background；其余只认 caps.background 枚举（mai：auto / opaque）
    const backgrounds = (Array.isArray(m.backgroundAllowed) ? m.backgroundAllowed : []).map((item) => String(item).toLowerCase());
    const bg = String(q.background || "").trim().toLowerCase();
    if (bg === "transparent" && m.nativeBackground) { delete q.outputFormat; delete q.frameCount; delete q.frameDuration; }
    else if (bg && bg !== "transparent" && backgrounds.includes(bg)) q.background = bg as ImageParams["background"];
    else delete q.background;
    return q;
  }
  if (kind === "video") {
    const q = { ...(p as VideoParams), model: m.id };
    const auto = (value: unknown) => /^(auto|adaptive|自适应)$/i.test(String(value || ""));
    const ratios = m.ratios || [];
    if (auto(q.ratio)) {
      if (ratios.some(auto)) q.ratio = "adaptive";
      else if (ratios.length) q.ratio = ratios[0];
    } else if (ratios.length && !ratios.some((r) => auto(r) ? auto(q.ratio) : String(r) === String(q.ratio))) {
      q.ratio = ratios[0];
    }
    if (m.res && m.res.length && !m.res.includes(q.res)) q.res = nearestTier(m.res, q.res);
    q.dur = clampVideoDuration(m, q.dur);
    if (m.modes && m.modes.length && !m.modes.includes(q.mode)) q.mode = m.modes[0];
    if (!(m.times || [1]).includes(q.times || 1)) q.times = 1;
    // 声音默认开：从别的模型切过来按新模型的默认起步；已经是这个模型就保留用户自己的开关
    if (m.audio && m.audioDefaultOn && String((p as VideoParams).model || "") !== m.id) q.sound = true;
    if (!m.audio) q.sound = false;
    // 内容审核开关只属于声明该能力位的模型：别家模型上残留的真值一律清掉（请求里不带）
    if (!m.nsfw) delete q.nsfw; else q.nsfw = q.nsfw === true;
    if (!m.multiShot) q.multiShot = false;
    // 草稿两段式只属于声明 draft 的模型：换到别的模型时两个字段都清掉（请求里永远不带）；
    // 成片步与 draft 互斥，目标档位收敛进 caps 的成片档
    if (!draftSupported(m)) { delete q.draft; delete q.draftTaskId; }
    else if (q.draftTaskId) { delete q.draft; q.res = draftFinalResolution(q, m); }
    // MJ 图生视频：这些字段只属于声明 mj_video 的模型；换到别的模型时全部清掉，
    // 档位按 caps 的 480p/720p 收敛（1080p/4k 面板上根本不给，残留值在这里被收掉）
    if (mjVideoSpec(m)) {
      q.motion = mjVideoMotion(m, q.motion);
      q.mjBatch = mjVideoBatch(m, q.mjBatch);
      if (!String(q.mjTaskId || "").trim()) { delete q.mjTaskId; delete q.mjIndex; }
      q.animateMode = mjVideoAnimateMode(m, q);
      // 画幅跟随首帧（caps 的 ratios 为空）：比例表达成「原图比例」，别把上一家的 21:9 显示成有效值
      if (!(m.ratios || []).length) q.ratio = "adaptive";
      // 档位决定计费：换到 MJ 视频时回到 caps 的默认档（480p），不继承别家的 720p/1080p；已经是 MJ 则保留用户选的档
      const mjDefaultTier = mjVideoDefaultTier(m);
      if (mjDefaultTier && String((p as VideoParams).model || "") !== m.id) q.res = mjDefaultTier;
    } else {
      delete q.motion; delete q.mjBatch; delete q.mjTaskId; delete q.mjIndex; delete q.animateMode;
    }
    return q;
  }
  if (kind === "text") {
    const q = { ...(p as TextParams), model: m.id };
    if (!m.search) q.search = false;
    // 换模型时档位收敛：新模型不支持就清空，档位不在新列表里就收到第一档（不替用户挑默认）
    const think = clampThinkLevel(thinkLevelsFor(m), q.think);
    if (think) q.think = think; else delete q.think;
    return q;
  }
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
    ...(raw.splitPending ? { splitPending: true } : {}),
    ...(() => {
      const s = raw.split as { sourceId?: unknown; mode?: unknown; status?: unknown } | undefined;
      if (!s || typeof s !== "object" || typeof s.sourceId !== "string" || !s.sourceId) return {};
      const mode = s.mode === "custom" ? "custom" as const : "auto" as const;
      const status = s.status === "ready" || s.status === "error" ? s.status : "loading" as const;
      return { split: { sourceId: s.sourceId, mode, status } };
    })(),
    ...(typeof raw.taskId === "string" && raw.taskId ? { taskId: raw.taskId } : {}),
    // 原始错误码（弹层里以「代码：…」展示；旧文档没有这个字段，读出来就是 undefined）
    ...(typeof raw.errCode === "string" && raw.errCode ? { errCode: raw.errCode } : {}),
    ...(raw.refMode === "mention" ? { refMode: "mention" as const } : {}),
    ...(raw.adjust && typeof raw.adjust === "object" ? { adjust: raw.adjust as NonNullable<GenData["adjust"]> } : {}),
  };
}
/** 节点背景色（TapNow 背景颜色面板：无色 + 7 种低饱和色） */
export const NODE_BG: Array<[string, string]> = [["red", "#8e4545"], ["orange", "#8a5426"], ["olive", "#8a8231"], ["green", "#4b7744"], ["teal", "#3d6f7c"], ["blue", "#34508a"], ["purple", "#78408e"]];
/** 颜色标签（TapNow Pin：6 种亮色） */
export const NODE_TAG: Array<[string, string]> = [["red", "#e25c5c"], ["orange", "#eda05a"], ["yellow", "#e9c85a"], ["green", "#6cc67c"], ["blue", "#5aa1f0"], ["purple", "#9b6ae6"]];
export const bgColor = (key?: string) => NODE_BG.find((c) => c[0] === key)?.[1] || null;
export const tagColor = (key?: string) => NODE_TAG.find((c) => c[0] === key)?.[1] || null;
export const outOf = (node: CanvasNode): GenOutput | null => { const g = genOf(node); return g.hist[g.hi] || null; };
export const srcOf = (node: CanvasNode): string => { const o = outOf(node); return node.kind === "video" ? o?.frame || o?.url || "" : node.kind === "image" ? o?.url || "" : ""; };
export const textOf = (node: CanvasNode): string => (node.kind === "text" ? outOf(node)?.text || "" : "");

/** 把生成数据写回节点：同时同步通用字段，旧版组件 / 导出 / 资源引用也能读到当前结果 */
export function withGen(node: CanvasNode, patch: Partial<GenData>): CanvasNode {
  const g = { ...genOf(node), ...patch };
  // 写回时总是持有自己的参数副本：模板铺开 / 版本铺开 / 批量拷贝等入口即使传了同一个 params，
  // 落盘后也不会和别的节点共用 camera、mj 这类嵌套对象。
  g.params = cloneParams(g.params);
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
  const { w, h, id, params: ownParams, ...gen } = extra;
  // 参数在创建时就落成这个节点自己的：合并默认值 + 写入具体模型 id，不靠读取时回落到全局默认模型
  const params = { ...defaultParams(kind, model), ...(ownParams || {}) } as AnyParams;
  const modelId = String((params as { model?: string }).model || model?.id || "");
  if (!(params as { model?: string }).model && modelId) (params as { model?: string }).model = modelId;
  // 空状态图片 / 视频节点从创建起就按面板里选的比例定型：新建后就是 3:4 的竖图框，不用等点生成才变形。
  // 显式传了 w / h（模板、导入、复制、再生成）的一律按传的来，这里只管默认尺寸。
  const wantRatio = kind === "image" || kind === "video" ? ratioOf((params as { ratio?: string }).ratio) : null;
  const box = w == null && h == null && wantRatio ? fitMediaBox(size.w, wantRatio, 1) : null;
  const base: CanvasNode = { id: id || uid("n"), kind, x: Math.round(x), y: Math.round(y), w: w ?? box?.w ?? size.w, h: h ?? box?.h ?? size.h, text: "" };
  return withGen(base, { title: TYPE_LABEL[kind], prompt: "", params, hist: [], hi: 0, order: [], ...gen });
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
  /* 分组里再套分组 / 堆叠：递归展开到素材节点（和后端 _agent_beat_channel_items 同口径，最多 6 层，防环）。
     每一层各按自己的规则排：堆叠保持叠内顺序，普通分组按画布位置（先上后下、先左后右）。 */
  const membersOf = (group: CanvasNode, depth: number, seen: Set<string>): CanvasNode[] => {
    if (depth > 6 || seen.has(group.id)) return [];
    seen.add(group.id);
    const stacked = !!(group.data && typeof group.data === "object" && (group.data as { stack?: unknown }).stack);
    const kids = (group.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n && (n.kind === "group" || isGenKind(n.kind)));
    if (!stacked) kids.sort((a, b) => a.y - b.y || a.x - b.x);
    return kids.flatMap((n) => (n.kind === "group" ? membersOf(n, depth + 1, seen) : [n]));
  };
  const expanded = inputs.flatMap((x) => {
    if (x.node.kind !== "group") return [x];
    const members = membersOf(x.node, 0, new Set()).filter((n, i, arr) => arr.findIndex((m) => m.id === n.id) === i);
    return members.map((node) => ({ edge: { ...x.edge, id: `${x.edge.id}:${node.id}` }, node, order: x.order }));
  });
  return expanded.map((x, order) => ({ ...x, order }));
}
/**
 * 出边邻接表 + 已连端点集合，按 doc 对象缓存。
 * 连线拖动时 Viewport 会对每个节点各算一次 connectBlock，而 wouldCycle 里原实现对每个弹出的节点
 * 都 doc.edges.filter 一遍（O(V×E)）；98 条边 + 100 节点时一次 pointermove 要做上万次比较。
 * 缓存键就是 doc 本身：所有改动都换新 doc 对象，缓存自然失效，不存在脏读。
 */
type DocGraph = { out: Map<string, string[]>; pairs: Set<string> };
const graphCache = new WeakMap<CanvasDoc, DocGraph>();
function graphOf(doc: CanvasDoc): DocGraph {
  const hit = graphCache.get(doc); if (hit) return hit;
  const out = new Map<string, string[]>(); const pairs = new Set<string>();
  for (const e of doc.edges) {
    pairs.add(e.from + "\u0000" + e.to);
    const arr = out.get(e.from); if (arr) arr.push(e.to); else out.set(e.from, [e.to]);
  }
  const graph: DocGraph = { out, pairs }; graphCache.set(doc, graph); return graph;
}
export function wouldCycle(doc: CanvasDoc, from: string, to: string): boolean {
  const { out } = graphOf(doc);
  const seen = new Set<string>(); const stack = [to];
  while (stack.length) { const x = stack.pop()!; if (x === from) return true; if (seen.has(x)) continue; seen.add(x); for (const next of out.get(x) || []) stack.push(next); }
  return false;
}
/** 能不能从 from 连到 to；不能时返回原因 */
export function connectBlock(doc: CanvasDoc, from: string, to: string): string | null {
  if (from === to) return "不能连到自己";
  if (graphOf(doc).pairs.has(from + "\u0000" + to)) return "这两个节点已经连着";
  if (wouldCycle(doc, from, to)) return "不能连成环：下游节点不能再作为上游的输入";
  const a = doc.nodes.find((n) => n.id === from), b = doc.nodes.find((n) => n.id === to);
  if (!a || !b) return "节点不存在";
  if (b.kind === "image" && a.kind === "audio") return "图片节点不接收音频输入";
  if (b.kind === "group") return "分组不接收输入";
  if (a.kind === "group" && !isGenKind(b.kind)) return "分组只能连到生成节点：组内素材会按顺序作为输入";
  return null;
}

/** 有效输入里各类素材的条数（视频方式的选择只看这些） */
export type VideoInputCounts = { images: number; videos: number; audios: number };

/**
 * 视频方式按**有效输入**选：有视频 → 参考视频生视频 / 视频延长；人像 + 音频 → 数字人；
 * 只有图 → 首帧 / 首尾帧 / 参考生视频；什么都没有 → 文生视频。模型不支持时退到最接近的一档。
 * 单独抽出来是因为请求组装会剔除「来源连线」，剔除后不能再用文档上的连线数来选。
 */
export function videoModeForCounts(modes: VideoMode[] | undefined | null, counts: VideoInputCounts): VideoMode | null {
  const list = modes == null ? (["文生视频"] as VideoMode[]) : modes;
  if (!list.length) return null; // 空 modes = 后端声明没有生成方式（如 Context-IR 这类提示词模型）
  const { images: imgs, videos: vids, audios: auds } = counts;
  const want: VideoMode = vids ? (imgs ? "参考视频生视频" : "视频延长") : auds && imgs ? "数字人" : imgs === 0 ? "文生视频" : imgs === 1 ? "首帧" : imgs === 2 ? "首尾帧" : "参考生视频";
  if (list.includes(want)) return want;
  if (vids && list.includes("视频编辑")) return "视频编辑";
  const alt: VideoMode = imgs ? "参考生视频" : "文生视频";
  return list.includes(alt) ? alt : list[0];
}

/** 这个生成方式是不是依赖某类输入（视频 / 音频）：这类输入没了就不能继续用它 */
export function videoModeMissingInput(mode: VideoMode, counts: VideoInputCounts): boolean {
  if (mode === "参考视频生视频" || mode === "视频编辑" || mode === "视频延长") return counts.videos === 0;
  if (mode === "数字人") return counts.audios === 0;
  return false;
}

/** 视频节点按输入自动选生成方式 */
export function autoVideoMode(doc: CanvasDoc, id: string, m: ModelSpec): VideoMode | null {
  const n = doc.nodes.find((x) => x.id === id); if (!n || n.kind !== "video") return null;
  const ins = expandGroupInputs(doc, inputsOf(doc, id));
  return videoModeForCounts(m.modes, {
    images: ins.filter((x) => x.node.kind === "image").length,
    videos: ins.filter((x) => x.node.kind === "video").length,
    audios: ins.filter((x) => x.node.kind === "audio").length,
  });
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
/** 草稿入口只由后端 caps 决定：没有 draft 声明的模型（含 seedance-2.5-flash）没有这个入口 */
export function draftSupported(m: ModelSpec | undefined): boolean { return m?.draft === true; }

/** 成片可选档位：只认 caps.draft_final_resolutions，缺失就是没有成片入口（不拿 resolutions 猜） */
export function draftFinalResolutions(m: ModelSpec | undefined): string[] {
  if (!draftSupported(m)) return [];
  return [...new Set((Array.isArray(m?.draftFinals) ? m!.draftFinals! : []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

/** 草稿阶段固定档位：caps.draft_resolution 优先；旧格式没给才回落最低档 */
export function draftResolution(m: ModelSpec | undefined): string {
  const fixed = String(m?.draftRes || "").trim().toLowerCase();
  return fixed || resRange(m)?.low || "";
}

/** 草稿有效期天数：后端声明的原值；没声明返回 null（文案不写死 3 天） */
export function draftExpiresDays(m: ModelSpec | undefined): number | null {
  const days = Math.floor(Number(m?.draftExpiresDays));
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** 当前请求是不是草稿步：只有声明 draft 的模型才真正生效（其它模型上的旧值一律不发、不改清晰度） */
export function draftActive(p: Pick<VideoParams, "draft">, m: ModelSpec | undefined): boolean {
  return p.draft === true && draftSupported(m);
}

/** 当前请求是不是成片步：草稿任务 id 只对声明 draft 的模型生效 */
export function draftFinalActive(p: Pick<VideoParams, "draftTaskId">, m: ModelSpec | undefined): boolean {
  return !!String(p.draftTaskId || "").trim() && draftSupported(m);
}

/** 成片目标档位：只收 caps 的成片档；选的档不在里面按 1080p → 第一档收敛 */
export function draftFinalResolution(p: Pick<VideoParams, "res">, m: ModelSpec | undefined): string {
  const finals = draftFinalResolutions(m);
  const want = String(p.res || "").trim().toLowerCase();
  if (finals.includes(want)) return want;
  return finals.includes("1080p") ? "1080p" : (finals[0] || want);
}

/** 草稿模式下真正发出去的清晰度（固定草稿档；非草稿 / 模型不支持时按用户选的档位） */
export function draftRes(p: VideoParams, m: ModelSpec | undefined): string {
  if (!draftActive(p, m)) return p.res;
  return draftResolution(m) || p.res;
}

/* ---------- 视频 · Midjourney 图生视频（caps.mj_video） ---------- */
export const MJ_VIDEO_MOTION_LABEL: Record<string, string> = { low: "低", high: "高" };
export const MJ_VIDEO_ANIMATE_LABEL: Record<string, string> = { manual: "手动", auto: "自动" };

/** 该模型有没有 MJ 图生视频能力（只认后端 caps.mj_video，缺字段 = 没有） */
export function mjVideoSpec(m: ModelSpec | null | undefined): MjVideoSpec | null {
  return m?.mjVideo ?? null;
}

/** 默认档位：caps 的 video_type_default 落在哪个档位（480p/720p），就默认哪档 */
export function mjVideoDefaultTier(m: ModelSpec | null | undefined): string {
  const spec = mjVideoSpec(m);
  if (!spec) return "";
  const wanted = String(spec.videoTypeDefault || "").trim();
  for (const table of [spec.baseByTier, spec.startEndByTier]) {
    const hit = Object.entries(table || {}).find(([, value]) => String(value || "").trim() === wanted);
    if (hit) return String(hit[0]).trim().toLowerCase();
  }
  const tiers = (m?.res || []).map((tier) => String(tier || "").trim().toLowerCase());
  return tiers.includes("480p") ? "480p" : tiers[0] || "";
}

/** 把请求档位收进模型的档位列表：MJ 视频只有 480p/720p，1080p/4k 这类残留值按最近档收（不原样发出去） */
export function mjVideoTier(m: ModelSpec | null | undefined, tier: string): string {
  const list = (m?.res || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  if (!list.length) return "";
  const wanted = String(tier || "").trim().toLowerCase();
  if (list.includes(wanted)) return wanted;
  return nearestTier(list, wanted);
}

/**
 * 档位 + 有没有尾帧 → 上游 video_type（4 个值之一）。caps 没给这个映射时返回空串，
 * 由请求改发 resolution 让后端按档位推导（不猜 video_type 的字面值）。
 */
export function mjVideoType(m: ModelSpec | null | undefined, tier: string, withEndFrame = false): string {
  const spec = mjVideoSpec(m);
  if (!spec) return "";
  const key = String(tier || "").trim().toLowerCase();
  const picked = String((withEndFrame ? spec.startEndByTier : spec.baseByTier)?.[key] || "").trim();
  return picked;
}

/** 运动幅度：只认 caps 的 motions / motion_default，脏值回默认 */
export function mjVideoMotion(m: ModelSpec | null | undefined, motion?: unknown): string {
  const spec = mjVideoSpec(m);
  if (!spec) return "";
  const wanted = String(motion ?? "").trim().toLowerCase();
  if (spec.motions.includes(wanted)) return wanted;
  const fallback = String(spec.motionDefault || "").trim().toLowerCase();
  return spec.motions.includes(fallback) ? fallback : spec.motions[0] || "";
}

/** 批次候选（caps 的 batch，1/2/4）：去重升序 */
export function mjVideoBatchOptions(m: ModelSpec | null | undefined): number[] {
  const spec = mjVideoSpec(m);
  if (!spec) return [];
  return [...new Set(spec.batch.filter((value) => Number.isFinite(value) && value >= 1))].sort((a, b) => a - b);
}

/** 批次收敛进 caps 的候选；没声明候选就按 1（上游默认） */
export function mjVideoBatch(m: ModelSpec | null | undefined, batch?: unknown): number {
  const options = mjVideoBatchOptions(m);
  if (!options.length) return 1;
  const wanted = Math.floor(Number(batch));
  if (options.includes(wanted)) return wanted;
  const fallback = Math.floor(Number(mjVideoSpec(m)?.batchDefault));
  return options.includes(fallback) ? fallback : options[0];
}

/** animate_mode：auto 只在「复用 MJ 任务 + 显式候选下标」且 caps 声明了 auto 时成立，否则固定 manual */
export function mjVideoAnimateMode(m: ModelSpec | null | undefined, p: Pick<VideoParams, "mjTaskId" | "mjIndex" | "animateMode">): "manual" | "auto" {
  const spec = mjVideoSpec(m);
  if (!spec) return "manual";
  const taskId = String(p?.mjTaskId || "").trim();
  const rawIndex = p?.mjIndex;
  const hasIndex = rawIndex !== undefined && rawIndex !== null && String(rawIndex).trim() !== "" && Number.isInteger(Number(rawIndex)) && Number(rawIndex) >= 0;
  return String(p?.animateMode || "").trim() === "auto" && spec.animateModes.includes("auto") && taskId && hasIndex ? "auto" : "manual";
}

/** 档位对应的计费 id（480p → midjourney@video，720p → midjourney@video-720p） */
export function mjVideoBilling(m: ModelSpec | null | undefined, tier: string): string {
  const spec = mjVideoSpec(m);
  if (!spec) return "";
  return String(spec.billingByTier?.[String(tier || "").trim().toLowerCase()] || "").trim();
}

/** 批次旁注：条数 × 倍率 × 计费 id（后端只回 credits，这里只解释「为什么 ×N」） */
export function mjVideoBatchNote(m: ModelSpec | null | undefined, batch?: unknown, tier?: string): string {
  const spec = mjVideoSpec(m);
  if (!spec) return "";
  const n = mjVideoBatch(m, batch);
  const billing = mjVideoBilling(m, tier || mjVideoDefaultTier(m));
  const tail = n > 1 ? "费用 ×" + n + (billing ? "（" + billing + " 单价 × " + n + "）" : "") : "费用按 1 条计" + (billing ? "（" + billing + "）" : "");
  return "批次 " + n + "：一次出 " + n + " 条视频，" + tail;
}

/**
 * 提交前的前端拦截（后端也会 400，但先在这里说清楚，别白扣费）：
 * 首帧图必填（不支持文生视频）、首帧图与复用 MJ 任务二选一、候选下标 0–3、auto 缺参数。
 * 返回 null = 可以发。
 */
export function mjVideoInputError(m: ModelSpec | null | undefined, p: VideoParams, hasFirstFrame: boolean): string | null {
  const spec = mjVideoSpec(m);
  if (!spec) return null;
  const taskId = String(p?.mjTaskId || "").trim();
  if (hasFirstFrame && taskId) return "首帧图与「复用 MJ 任务图」只能二选一：去掉一个再生成";
  if (!hasFirstFrame && !taskId) return "Midjourney 图生视频需要一张首帧图（文档不支持文生视频）：连一张图片到「首帧」";
  const min = Number.isFinite(Number(spec.indexMin)) ? Number(spec.indexMin) : 0;
  const max = Number.isFinite(Number(spec.indexMax)) ? Number(spec.indexMax) : 3;
  const rawIndex = p?.mjIndex;
  const hasIndex = rawIndex !== undefined && rawIndex !== null && String(rawIndex).trim() !== "";
  const index = Math.floor(Number(rawIndex));
  if (taskId && hasIndex && !(index >= min && index <= max)) return "复用 MJ 任务图只能取第 " + min + "–" + max + " 张候选";
  if (String(p?.animateMode || "").trim() === "auto" && (!taskId || !hasIndex)) return "自动模式必须复用 MJ 任务并指明第几张（第 " + min + "–" + max + " 张）；当前固定手动";
  return null;
}