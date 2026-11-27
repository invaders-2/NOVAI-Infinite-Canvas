/**
 * 后端权威模型规格（GET /api/model-caps）→ ModelSpec 的 ui 字段。
 *   只做「契约字段 → 前端认的字段」的翻译，不自己编能力：
 *   - 空数组 / 缺失字段不落进 ui，让 specFor 走它自己的默认或未验证兜底；
 *   - n_max 只是批量张数上限，batch 必须按需求展开成 [1..min(n_max, MAX_CAPS_BATCH)]；
 *   - 视频 modes 可能是接口值（text_to_video），统一翻译成 VMODES 的中文名。
 */
import { GIF_FRAME_FALLBACK, VMODES, type GifFrameSpec, type MjVideoSpec } from "./model";

export type ModelCapsItem = {
  provider?: string;
  model?: string;
  kind?: string;
  ratios?: unknown;
  resolutions?: unknown;
  /** 分辨率档的另一种写法（如 midjourney 的 --q 表只给 sizes） */
  sizes?: unknown;
  /** 一次出几张（后端直接给的张数候选，优先于 n_max 推导） */
  batch?: unknown;
  n_max?: unknown;
  maxRefs?: unknown;
  max_refs?: unknown;
  /** 后端 _caps_payload 的参考图上限（main.py：图片 ref_max、视频 ref_max/video_ref_max、音频 audio_ref_max） */
  ref_max?: unknown;
  video_ref_max?: unknown;
  audio_ref_max?: unknown;
  durations?: unknown;
  modes?: unknown;
  /** 质量档（后端能力表声明的接口值，如 low / medium / high）；没声明 = 不下发 */
  qualities?: unknown;
  /** 先思考开关（目前只有 wan2.7-image 族会声明 true）；没声明 = 不支持 */
  thinking_mode?: unknown;
  /** 输出格式（png / jpeg / webp / gif / svg）；没声明 = 后端没给这个能力 */
  output_formats?: unknown;
  /** GIF 帧参数 { min, max, default, durationDefault }；旧后端没这个字段 → 前端用兜底 */
  gif_frames?: unknown;
  /** 透明背景能力（只有支持的模型才有这个字段，且只有 true 才算）；缺省 = 不支持 */
  native_background?: unknown;
  /** 只返回提示词、不产视频（如 MiniMax-H3-Context-IR）：true 时面板不给视频参数 */
  prompt_only?: unknown;
  /** Seedance 草稿两段式（只有 seedance-2.5 声明）：缺字段 = 该模型不支持草稿 */
  draft?: unknown;
  /** 草稿阶段固定档位（480p）：用户传其它档位后端本地 400 */
  draft_resolution?: unknown;
  /** 成片可选档位（["1080p","4k"]）：和 resolutions 分开表达，不把 480p 当草稿成片档 */
  draft_final_resolutions?: unknown;
  /** 草稿有效期（天，3）：过期 / 不属于本账号时上游 400 */
  draft_expires_days?: unknown;
  /** 视频模型能出声音、且请求里能明确开关（后端 apimart_video_audio_switchable 判定）；缺省 = 没有这个入口 */
  audio?: unknown;
  /** 声音默认开（后端能力表声明了默认值）；缺字段 = 沿用「默认关」 */
  audio_default_on?: unknown;
  /** 首帧 / 首尾帧方式下画幅跟随首帧（不发 aspect_ratio）；缺字段 = 只有上游明确声明才这样 */
  ratio_follows_first_frame?: unknown;
  /** 内容审核开关的能力位：后端用一个布尔字段下发（字段名见 _caps_payload），缺字段 = 没有这个入口 */
  nsfw?: unknown;
  nsfw_check?: unknown;
  /** Midjourney 专属参数：{ versions, speeds, hd }（后端只给这几个数组） */
  mj?: unknown;
  /** Midjourney 图生视频能力位（只有视频模型 midjourney-video 带；缺字段 = 没有这项能力） */
  mj_video?: unknown;
  /** 精确像素生成的模型（GPT-Image 家族）声明的像素上限：长边 / 总像素 / 最低像素 */
  max_long_edge?: unknown;
  max_pixels?: unknown;
  min_pixels?: unknown;
  /** 系列模式张数区间（kling-v4-image）：{ min, max }，走 sequential_image_generation */
  series?: unknown;
  /** 长图用途（kling-v4-long-image，必填）：ecommerce / webpage */
  skill?: unknown;
  /** 长图篇幅（只在 skill=ecommerce 生效）：short / medium / long */
  length?: unknown;
  /** 上游接受的 background 枚举（mai：auto / opaque；没有 transparent） */
  background?: unknown;
  /** 显式 false = 请求体不带 size（kling-v4-long-image，传了上游 400） */
  send_size?: unknown;
  /** 精确像素按 width/height 成对下发（mai），不是 size="WxH" */
  exact_size_pair?: unknown;
  /** 精确像素约束：每边下限 / 步进（mai：768 / 32） */
  min_side?: unknown;
  size_step?: unknown;
  /** include_builtin=1 才有：能力表里有定义、但 provider 没登记的内部模型（不是用户清单里的） */
  builtin?: unknown;
};

/** 请求尺寸能取的范围（后端 caps 下发的像素上限；没声明的模型视为不限制） */
export type SizeLimits = { maxLongEdge?: number; maxPixels?: number; minPixels?: number };

/**
 * 把 WxH 等比缩进模型的像素上限（GPT-Image 家族：长边 ≤3840、总像素 ≤829 万、最低 655360、
 * 两边 16 的倍数、比例 1:3~3:1）。与后端 main.py normalize_gpt_image_2_size 同一套口径
 * （tests/test_canvas_gen_pipe.js 拿两边数值对拍），保证前端发出去的尺寸上游能接。
 * 上限之内 / 认不出 WxH（auto、档位）时原样返回，交给后端按档位换算。
 */
export function clampImageSize(size: string, limits: SizeLimits): { size: string; clamped: boolean } {
  const text = String(size || "").trim();
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(text);
  const maxEdge = Math.floor(Number(limits.maxLongEdge)) || 0;
  const maxPixels = Math.floor(Number(limits.maxPixels)) || 0;
  const minPixels = Math.floor(Number(limits.minPixels)) || 0;
  if (!m || (!maxEdge && !maxPixels)) return { size: text, clamped: false };
  let w = Number(m[1]); let h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return { size: text, clamped: false };
  if ((!maxEdge || Math.max(w, h) <= maxEdge) && (!maxPixels || w * h <= maxPixels)) return { size: text, clamped: false };
  if (w > h * 3) w = h * 3; else if (h > w * 3) h = w * 3;
  const scale = Math.min(1, maxEdge ? maxEdge / Math.max(w, h) : 1, maxPixels ? Math.sqrt(maxPixels / Math.max(1, w * h)) : 1);
  const floor16 = (v: number) => Math.max(16, Math.floor(v / 16) * 16);
  w = floor16(w * scale); h = floor16(h * scale);
  if (w > h * 3) w = floor16(h * 3);
  if (w * 3 < h) h = floor16(w * 3);
  if (minPixels && w * h < minPixels) {
    const grow = Math.sqrt(minPixels / Math.max(1, w * h));
    w = Math.ceil((w * grow) / 16) * 16; h = Math.ceil((h * grow) / 16) * 16;
  }
  return { size: w + "x" + h, clamped: true };
}

/** MAI 精确像素的口径（main.py normalize_mai_image_size）：两边 ≥768、总像素 ≤4194304、各自向下取 32 的倍数 */
export const MAI_SIZE_DEFAULTS = { minSide: 768, maxPixels: 4194304, sizeStep: 32 };
export type MaiSizeLimits = { minSide?: number; maxPixels?: number; sizeStep?: number };

/**
 * 把 WxH 收进 MAI 的像素口径（1000x1000 → 992x992）。与 clampImageSize 不是同一套规则：
 * MAI 没有长边上限，只要求每边 ≥minSide、总像素 ≤maxPixels、各自向下取 sizeStep 的倍数。
 * 认不出 WxH（auto / 比例串）时原样返回，交给后端按档位换算。
 */
export function clampMaiSize(size: string, limits?: MaiSizeLimits): { size: string; clamped: boolean } {
  const text = String(size || "").trim();
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(text);
  if (!m) return { size: text, clamped: false };
  const positive = (raw: unknown, fallback: number) => Math.floor(Number(raw)) > 0 ? Math.floor(Number(raw)) : fallback;
  const minSide = positive(limits?.minSide, MAI_SIZE_DEFAULTS.minSide);
  const maxPixels = positive(limits?.maxPixels, MAI_SIZE_DEFAULTS.maxPixels);
  const step = positive(limits?.sizeStep, MAI_SIZE_DEFAULTS.sizeStep);
  let w = Number(m[1]); let h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return { size: text, clamped: false };
  const floorStep = (value: number) => Math.max(minSide, Math.floor(value / step) * step);
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, w * h)));
  w = floorStep(w * scale); h = floorStep(h * scale);
  if (w * h > maxPixels) {
    // 抬到 minSide 之后可能又超总像素上限：按上限等比收一次，仍以 minSide 兜底
    const shrink = Math.sqrt(maxPixels / Math.max(1, w * h));
    w = floorStep(w * shrink); h = floorStep(h * shrink);
  }
  const out = w + "x" + h;
  return { size: out, clamped: out !== text };
}

const VIDEO_MODE_BY_API = new Map(Object.entries(VMODES).map(([label, value]) => [value.api, label]));
const AUTO_RATIO = /^(auto|adaptive|自动|自适应)$/i;
/** 张数候选的硬上限：后端 APIMART_IMAGE_MODEL_CAPS 的 n_max 最高 15（seedream-4-0），超过只可能是脏值；
 *  真正的「这个模型能发几张」一律听 caps 的 n_max，这里只防脏值撑爆面板。 */
const MAX_CAPS_BATCH = 15;

/** 能力表里的 GIF 帧参数：缺字段 / 脏值一律落到兜底 2–16 / 默认 9 / 200ms（面板控件不因此消失） */
export function normalizeGifFrames(value: unknown): GifFrameSpec {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const num = (raw: unknown) => {
    const parsed = Math.floor(Number(raw));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const min = Math.max(2, num(row.min) || GIF_FRAME_FALLBACK.min);
  const max = Math.max(min, num(row.max) || GIF_FRAME_FALLBACK.max);
  return {
    min,
    max,
    default: Math.max(min, Math.min(max, num(row.default) || GIF_FRAME_FALLBACK.default)),
    durationDefault: num(row.durationDefault) || GIF_FRAME_FALLBACK.durationDefault,
  };
}

/** Midjourney 规格：{ versions, speeds, hd }；缺哪个就空着，前端不猜取值 */
export function normalizeMjSpec(value: unknown): { versions: string[]; speeds: string[]; hd: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const spec = { versions: strings(row.versions), speeds: strings(row.speeds), hd: strings(row.hd) };
  return spec.versions.length || spec.speeds.length || spec.hd.length ? spec : null;
}

/**
 * Midjourney 图生视频能力位（后端 caps.mj_video 的形状，与图片 mj.video 同一份）：
 * 只收后端确证下发的键；整个对象没有任何可用键时返回 null（不伪造能力）。
 * 档位映射（base_by_tier / start_end_by_tier）原样保留：前端不硬编码 video_type 的字面值。
 */
export function normalizeMjVideoSpec(value: unknown): MjVideoSpec | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const tierMap = (raw: unknown): Record<string, string> => {
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [tier, type] of Object.entries(raw as Record<string, unknown>)) {
      const key = String(tier || "").trim().toLowerCase();
      const text = String(type || "").trim();
      if (key && text) out[key] = text;
    }
    return out;
  };
  const int = (raw: unknown): number | undefined => {
    const parsed = Math.floor(Number(raw));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const numbers = (raw: unknown): number[] => {
    const list = Array.isArray(raw) ? raw.map(Number) : [];
    return [...new Set(list.filter((item) => Number.isInteger(item) && item >= 1))].sort((a, b) => a - b);
  };
  const spec: MjVideoSpec = {
    inputSources: strings(row.input_sources),
    requiresFirstFrame: row.requires_first_frame === true,
    supportsEndFrame: row.supports_end_frame === true,
    durationFixed: row.duration_fixed === true,
    motions: strings(row.motions).map((item) => item.toLowerCase()),
    videoTypes: strings(row.video_types),
    baseByTier: tierMap(row.base_by_tier),
    startEndByTier: tierMap(row.start_end_by_tier),
    startEndVideoTypes: strings(row.start_end_video_types),
    animateModes: strings(row.animate_modes).map((item) => item.toLowerCase()),
    batch: numbers(row.batch),
    billing: strings(row.billing),
    billingByTier: tierMap(row.billing_by_tier),
  };
  const endpoint = String(row.endpoint || "").trim();
  if (endpoint) spec.endpoint = endpoint;
  const upstreamModel = String(row.upstream_model || "").trim();
  if (upstreamModel) spec.upstreamModel = upstreamModel;
  const motionDefault = String(row.motion_default || "").trim().toLowerCase();
  if (motionDefault) spec.motionDefault = motionDefault;
  const videoTypeDefault = String(row.video_type_default || "").trim();
  if (videoTypeDefault) spec.videoTypeDefault = videoTypeDefault;
  const durationSeconds = int(row.duration_seconds);
  if (durationSeconds !== undefined) spec.durationSeconds = durationSeconds;
  const batchDefault = int(row.batch_default);
  if (batchDefault !== undefined) spec.batchDefault = batchDefault;
  const indexMin = int(row.index_min);
  if (indexMin !== undefined) spec.indexMin = indexMin;
  const indexMax = int(row.index_max);
  if (indexMax !== undefined) spec.indexMax = indexMax;
  // 一个可用键都没有 = 后端这一条没有 MJ 视频能力，别让面板出现空控件
  const usable = !!spec.endpoint || !!spec.motions.length || !!spec.videoTypes.length
    || !!Object.keys(spec.baseByTier).length || !!Object.keys(spec.startEndByTier).length
    || !!spec.animateModes.length || !!spec.batch.length;
  return usable ? spec : null;
}

/** 系列模式张数区间 { min, max }：两个都是正整数且 max ≥ min，否则视为没有这个能力 */
export function normalizeSeriesSpec(value: unknown): { min: number; max: number } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const num = (raw: unknown) => {
    const parsed = Math.floor(Number(raw));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const min = num(row.min); const max = num(row.max);
  return min && max && max >= min ? { min, max } : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

export function normalizeCapsRatio(value: string): string {
  return AUTO_RATIO.test(value) ? "自适应" : value;
}

function ratios(value: unknown): string[] {
  return [...new Set(strings(value).map(normalizeCapsRatio))];
}

function resolutions(value: unknown, kind: "image" | "video" | "audio"): string[] {
  const list = strings(value);
  return [...new Set(list.map((item) => (kind === "video" ? item.toLowerCase() : item.toUpperCase())))];
}

export function normalizeCapsModes(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of strings(value)) {
    const label = raw in VMODES ? raw : VIDEO_MODE_BY_API.get(raw);
    if (label && label in VMODES && !out.includes(label)) out.push(label);
  }
  return out;
}

/** 一个 caps item → specFor 认的 ui；没有任何可用字段返回 null（不要伪造空规格） */
export function modelCapsUi(kind: "image" | "video" | "audio", item: ModelCapsItem | null | undefined): Record<string, unknown> | null {
  if (!item || typeof item !== "object") return null;
  if (item.kind && String(item.kind) !== kind) return null;
  const ui: Record<string, unknown> = {};
  // 只出提示词的模型（Context-IR）：原样透传，面板据此隐藏视频参数
  if (item.prompt_only === true || (item as { promptOnly?: unknown }).promptOnly === true) ui.promptOnly = true;
  const mj = normalizeMjSpec(item.mj ?? (item as { midjourney?: unknown }).midjourney);
  if (mj) ui.mj = mj;
  // 字段存在但数组为空：这是后端明确说「没有」，不能把它当成缺字段再补默认值
  if (Array.isArray(item.ratios)) ui.ratios = ratios(item.ratios);
  // 参考图上限的权威字段是后端 caps 的 ref_max（视频还有 video_ref_max、音频 audio_ref_max）；没有才回落旧字段。
  // 视频的 maxRefs 在前端统计的是图片参考（engine.rolesFor / table.planRow 的 refs 都是 image），
  // 后端视频表里 ref_max 才是图片参考上限（video_ref_max 是视频参考上限），所以视频也优先 ref_max、缺了才兜底。
  const firstField = (...values: unknown[]): unknown => values.find((v) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim()));
  const refCap = kind === "image" ? firstField(item.ref_max, item.maxRefs, item.max_refs)
    : kind === "video" ? firstField(item.ref_max, item.video_ref_max, item.maxRefs, item.max_refs)
    : firstField(item.audio_ref_max, item.maxRefs, item.max_refs);
  const maxRefs = Number(refCap);
  if (Number.isFinite(maxRefs) && maxRefs >= 0) ui.maxRefs = Math.floor(maxRefs);
  if (kind === "image") {
    if (Array.isArray(item.resolutions)) ui.sizes = resolutions(item.resolutions, kind);
    // 后端也直接下发 sizes（如 midjourney 只声明 2K）：resolutions 为空时用它，别把尺寸档丢掉
    if (Array.isArray(item.sizes) && !((ui.sizes as string[] | undefined) || []).length) ui.sizes = strings(item.sizes).map((item) => item.toUpperCase());
    const nRaw = item.n_max;
    const hasN = nRaw !== undefined && nRaw !== null && String(nRaw).trim() !== "";
    const n = Math.floor(Number(nRaw));
    if (hasN && Number.isFinite(n) && n >= 1) {
      ui.batch = Array.from({ length: Math.min(MAX_CAPS_BATCH, n) }, (_, index) => index + 1);
    } else if (Array.isArray(item.batch) && item.batch.length) {
      // 后端直接给张数候选（如 midjourney 固定 4 张）：按它来，不走「上限未知」兜底
      const list = [...new Set(strings(item.batch).map(Number).filter((value) => Number.isFinite(value) && value >= 1 && value <= MAX_CAPS_BATCH))].sort((a, b) => a - b);
      if (list.length) ui.batch = list; else ui.batchUnknown = true;
    } else if (Array.isArray(item.ratios) || Array.isArray(item.resolutions)) {
      // 后端说「不掌握上限」：张数只保留 1，并让面板提示未知，而不是补一个假上限
      ui.batchUnknown = true;
    }
    // Midjourney 张数按「从多到少」给：新建 / 切换模型时取 batch[0] = 4（默认 4 张候选 + 四宫格赠品）。
    // 其它模型保持升序与 1 张默认，顺序和默认值都不动。
    if (mj && Array.isArray(ui.batch) && (ui.batch as unknown[]).length) {
      ui.batch = [...(ui.batch as number[])].sort((a, b) => b - a);
    }
    // 质量档 / 先思考：后端声明什么就是什么（空数组 / 缺字段 = 不给入口，前端不按模型名猜）
    if (Array.isArray(item.qualities)) ui.qualities = strings(item.qualities);
    if (item.thinking_mode === true) ui.thinkingMode = true;
    // 透明背景：只有明确 true 才算（缺字段 / 其它值一律当不支持，面板不给入口）
    if (item.native_background === true) ui.nativeBackground = true;
    // 输出格式：空数组也保留（后端明确没有动图/矢量能力），面板据此不给入口
    if (Array.isArray(item.output_formats)) {
      ui.outputFormats = [...new Set(strings(item.output_formats).map((value) => value.toLowerCase()))];
      // 声明了 gif 就一定带帧参数：旧后端没下发 gif_frames 时用兜底，面板照常显示 2–16 / 9 / 200
      if ((ui.outputFormats as string[]).includes("gif") || item.gif_frames !== undefined) ui.gifFrames = normalizeGifFrames(item.gif_frames);
    }
    // 系列模式（kling-v4-image）：张数上限由 max_images 决定，和 n_max 是两条路
    const series = normalizeSeriesSpec(item.series);
    if (series) ui.series = series;
    // 长图用途 / 篇幅 / 上游背景枚举：空数组也保留（后端明确说「没有这个取值」）
    if (Array.isArray(item.skill)) ui.skill = strings(item.skill);
    if (Array.isArray(item.length)) ui.length = strings(item.length);
    if (Array.isArray(item.background)) ui.backgroundAllowed = strings(item.background).map((value) => value.toLowerCase());
    // send_size 缺省 true：只有显式 false 才代表「请求体不能带 size」；空条目仍返回 null，不伪造规格
    if (item.send_size === false) ui.sendSize = false;
    else if (Object.keys(ui).length) ui.sendSize = true;
    if (item.exact_size_pair === true) ui.exactSizePair = true;
    const minSide = Math.floor(Number(item.min_side));
    const sizeStep = Math.floor(Number(item.size_step));
    if (Number.isFinite(minSide) && minSide > 0) ui.minSide = minSide;
    if (Number.isFinite(sizeStep) && sizeStep > 0) ui.sizeStep = sizeStep;
  } else {
    if (Array.isArray(item.resolutions)) ui.res = resolutions(item.resolutions, kind);
    if (Array.isArray(item.durations)) {
      // -1 = 模型自选时长（后端 caps 的约定，如 seedance-2.5）；不能当脏值过滤掉，否则面板没有「自动」
      ui.durs = [...new Set(strings(item.durations).map(Number).filter((n) => Number.isFinite(n) && (n > 0 || n === -1)))].sort((a, b) => a - b);
    }
    if (Array.isArray(item.modes)) ui.modes = normalizeCapsModes(item.modes);
    // 原生音频开关：只有后端明确说「能出声音且能开关」才落进 ui（缺字段 = 面板不给这个入口）
    if (item.audio === true) ui.audio = true;
    // 声音默认开：只有后端明确声明默认开才落进 ui（缺字段 = 沿用现有的「默认关」）
    if (item.audio_default_on === true) ui.audioDefaultOn = true;
    // 参考素材上限：图片走上面的 maxRefs，视频 / 音频各有自己的上限（面板按 caps 提示，不按模型名猜）
    // imageRefMax 只存 caps 明确声明的图片上限（maxRefs 会被通用预设回填，不能拿来当权威值）
    const imageRefMax = Math.floor(Number(item.ref_max));
    if (Number.isFinite(imageRefMax) && imageRefMax > 0) ui.imageRefMax = imageRefMax;
    const videoRefMax = Math.floor(Number(item.video_ref_max));
    if (Number.isFinite(videoRefMax) && videoRefMax > 0) ui.videoRefMax = videoRefMax;
    const audioRefMax = Math.floor(Number(item.audio_ref_max));
    if (Number.isFinite(audioRefMax) && audioRefMax > 0) ui.audioRefMax = audioRefMax;
    // 画幅跟随首帧：首帧方式上游不收比例字段，面板据此丢 21:9 并提示（kling-v4 / magi-2 这类统一入口）
    if (item.ratio_follows_first_frame === true) ui.ratioFollowsFirstFrame = true;
    // 内容审核是布尔能力位：后端字段名未定，按「以 true 出现」识别，缺字段 = 面板不给这个开关
    if (item.nsfw === true || item.nsfw_check === true) ui.nsfw = true;
    // MJ 图生视频：只认 caps.mj_video，缺字段 = 这个模型没有 MJ 视频入口（不按模型名猜）
    const mjVideo = normalizeMjVideoSpec(item.mj_video);
    if (mjVideo) ui.mjVideo = mjVideo;
    // Seedance 草稿两段式：只有 draft:true 才给入口；档位 / 成片档 / 有效期都按后端原值翻译（缺失不补默认）
    if (item.draft === true) {
      ui.draft = true;
      const draftRes = String(item.draft_resolution || "").trim().toLowerCase();
      if (draftRes) ui.draftRes = draftRes;
      if (Array.isArray(item.draft_final_resolutions)) ui.draftFinals = resolutions(item.draft_final_resolutions, kind);
      const days = Math.floor(Number(item.draft_expires_days));
      if (Number.isFinite(days) && days > 0) ui.draftExpiresDays = days;
    }
  }
  return Object.keys(ui).length ? ui : null;
}

/**
 * caps 只声明参数（比例/分辨率/张数/时长/方式），不声明参考图能力。
 * 参考图是「可选能力」，缺字段不等于不支持：沿用原有官方 ui / 按名字预设里的 maxRefs/i2i，
 * 避免一上权威参数就把所有模型的参考图入口误关掉。caps 明确给值时仍以 caps 为准。
 */
export function mergeCapsReferenceCapability(kind: "image" | "video" | "audio", ui: Record<string, unknown> | null, fallback: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!ui || !fallback) return ui;
  const out = { ...ui };
  for (const key of kind === "image" ? ["maxRefs", "i2i", "refNote"] : ["maxRefs", "refNote"]) {
    if (out[key] === undefined && fallback[key] !== undefined) out[key] = fallback[key];
  }
  return out;
}

export function modelCapsKey(provider: string, model: string): string {
  return String(provider || "").trim().toLowerCase() + "::" + String(model || "").trim();
}

export function indexModelCaps(items: unknown): Map<string, ModelCapsItem> {
  const index = new Map<string, ModelCapsItem>();
  if (!Array.isArray(items)) return index;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as ModelCapsItem;
    const provider = String(row.provider || "").trim();
    const model = String(row.model || "").trim();
    if (!provider || !model) continue;
    index.set(modelCapsKey(provider, model), row);
  }
  return index;
}
