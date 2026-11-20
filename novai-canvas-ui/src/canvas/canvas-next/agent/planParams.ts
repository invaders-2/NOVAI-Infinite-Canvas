/**
 * 方案卡参数：把「生成类步骤」的 args 读成可编辑参数、写回 args/settings，并生成一句人话摘要。
 *   图片尺寸换算与 main.py 的 CHAT_RATIO_SIZE_OPTIONS 同表（1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 × 1k/2k/4k）；
 *   模型 ratios / sizes / batch / res / durs 来自 ModelSpec，是面板可选项的唯一来源。
 */
import {
  DEFAULT_CAMERA, STYLES, VMODES, clampQuality, clampThinking, isQualityDefault, normalizeStyle,
  outputFormatForRequest, outputFormatLabel, outputFormatOptions, qualityChoices, qualityLabel,
  qualityLevelsFor, resRange, thinkLevelLabel, thinkLevelsFor, thinkingAvailable,
  type CameraParams, type ImageOutputFormat, type MjParams, type ModelSpec,
} from "../model";
import { ratioDisplayLabel } from "../originalRatio";
import type { AgentTaskPlan } from "../backend/types";

export type PlanStep = AgentTaskPlan["steps"][number];
export type PlanKind = "image" | "video";
/** 待生成卡片能改参数的四类节点（文本 / 音频参数比图片视频少） */
export type CardKind = PlanKind | "text" | "audio";
/** 三态开关：默认（不传）/ 开 / 关 */
export type TriState = "default" | "on" | "off";
export type TextOutputMode = "text" | "table" | "storyboard";
/** 文本节点输出：与画布 table.ts 的 OUTPUT_MODES 同三档 */
export const TEXT_OUTPUT_MODES: Array<[TextOutputMode, string]> = [["text", "文本"], ["table", "多维表格"], ["storyboard", "分镜表"]];

export type PlanStepPatch = {
  modelConfigId?: string; ratio?: string; resolution?: string; count?: number; duration?: number; mode?: string;
  /** 卡片：把整套参数（含「默认」清空标记）都写进 settings，而不是只写本次改动的那几项 */
  full?: boolean;
  quality?: string; thinking?: TriState; outputFormat?: "" | ImageOutputFormat; background?: boolean;
  search?: boolean; style?: string; camera?: CameraParams; mj?: MjParams;
  audio?: boolean; times?: number; genMode?: string; turbo?: boolean; draft?: boolean; multiShot?: boolean;
};
export type PlanParams = {
  kind: PlanKind;
  scope: "args" | "settings";
  provider: string;
  model: string;
  ratio: string;
  /** 图片的 1K/2K/3K/4K；视频的 480p/720p/1080p（仅 settings 作用域有） */
  resolution: string;
  /** 图片显式像素（WxH），写进 args.size / settings.resolution 之外的请求口径 */
  size: string;
  count: number;
  duration: number;
  /** 视频生成方式：VMODES 的接口值（text_to_video 等）；空串 = 自动选择 */
  mode: string;
  /** 图片质量档（"" = 跟随上游默认） */
  quality: string;
  /** 图片先思考（default = 交给模型决定） */
  thinking: TriState;
  /** 图片输出格式（"" = 静态图） */
  outputFormat: "" | ImageOutputFormat;
  /** 图片透明背景 */
  background: boolean;
  /** 图片 / 文本的联网检索 */
  search: boolean;
  style: string;
  camera: CameraParams;
  mj?: MjParams;
  /** 视频一次生成几条 */
  times: number;
  /** 视频生成模式（"" = 默认） */
  genMode: string;
  turbo: boolean;
  draft: boolean;
  multiShot: boolean;
  /** 视频原生音频（settings.audio → params.sound） */
  audio?: boolean;
};

/** 与 main.py CHAT_RATIO_SIZE_OPTIONS 逐格一致（只用于生成显式 size，最终由后端尺寸策略收敛） */
export const IMAGE_SIZE_TABLE: Record<string, [string, string, string]> = {
  "1:1": ["1024x1024", "2048x2048", "2880x2880"],
  "2:3": ["1024x1536", "1360x2048", "2336x3520"],
  "3:2": ["1536x1024", "2048x1360", "3520x2336"],
  "3:4": ["768x1024", "1536x2048", "2480x3312"],
  "4:3": ["1024x768", "2048x1536", "3312x2480"],
  "9:16": ["864x1536", "1152x2048", "2160x3840"],
  "16:9": ["1536x864", "2048x1152", "3840x2160"],
};
export const IMAGE_TIER_LONG: Record<number, number> = { 0: 1536, 1: 2048, 2: 3840 };
const TIER_LABELS = ["1K", "2K", "4K"];
const IMAGE_RATIO_COLON = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9", "9:21", "1:2", "2:1", "5:4", "4:5", "3:1", "1:3"];
const VIDEO_RATIO_COLON = ["adaptive", "自适应", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const IMAGE_TOOLS = new Set(["generate_image", "create_image", "image_to_image", "edit_image"]);
const VIDEO_TOOLS = new Set(["generate_video", "create_video", "image_to_video", "lipsync_video", "video_generation"]);
const SETTINGS_TOOLS = new Set(["batch_generate", "run_generation", "create_node"]);
const MODE_BY_API = new Map(Object.entries(VMODES).map(([label, value]) => [value.api, label]));

/** 方式值可能来自 VMODES 中文名或接口值；统一返回接口值（空串 = 自动） */
export function videoModeApi(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text in VMODES) return VMODES[text as keyof typeof VMODES].api;
  return MODE_BY_API.has(text) ? text : "";
}

/** 接口值 → 中文名；未知返回空串 */
export function videoModeLabel(value: unknown): string {
  const api = videoModeApi(value);
  if (!api) return "";
  return MODE_BY_API.get(api) || "";
}

/** 当前模型支持的方式（值=接口值、label=中文名）；顺序听 ModelSpec.modes */
export function videoModeOptions(spec: ModelSpec | undefined): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const item of spec?.modes || []) {
    const value = videoModeApi(item);
    const label = videoModeLabel(value);
    if (value && label && !out.some((x) => x.value === value)) out.push({ value, label });
  }
  return out;
}

export function splitModelId(id: string | null | undefined): { provider: string; model: string } {
  const text = String(id || "");
  const at = text.indexOf("::");
  return at >= 0 ? { provider: text.slice(0, at), model: text.slice(at + 2) } : { provider: "", model: text };
}

export function planStepKind(step: PlanStep, models: ModelSpec[] = []): PlanKind | null {
  const tool = String(step?.tool || "").trim().toLowerCase();
  const args = (step?.args || {}) as Record<string, any>;
  if (tool === "batch_generate") {
    const media = String(args.media || (args.settings || {}).media || "image").toLowerCase();
    return media === "video" ? "video" : "image";
  }
  if (IMAGE_TOOLS.has(tool)) return "image";
  if (VIDEO_TOOLS.has(tool)) return "video";
  if (tool === "run_generation" || tool === "create_node") {
    const type = String(args.type || args.kind || "").toLowerCase();
    if (type.includes("video")) return "video";
    if (type.includes("image")) return "image";
    const settings = (args.settings || {}) as Record<string, any>;
    if (settings.videoModel || settings.videoAspect || settings.videoDuration || settings.mode) return "video";
    if (settings.model || settings.ratio || settings.size || settings.resolution) return "image";
    void models;
  }
  return null;
}

export function planStepScope(step: PlanStep): "args" | "settings" {
  return SETTINGS_TOOLS.has(String(step?.tool || "").trim().toLowerCase()) ? "settings" : "args";
}

/** 待生成卡片拆卡的固定顺序：图片 → 视频 → 文本 → 配音（没有行的类型不出现） */
export const CARD_KIND_ORDER: CardKind[] = ["image", "video", "text", "audio"];

/** 步骤属于哪一类卡：只认 args.type（后端 _agent_generation_plan 给每个 run_generation 都写了它） */
export function stepCardKind(step: PlanStep): CardKind | null {
  const type = String((step?.args || {}).type || "").trim().toLowerCase();
  return CARD_KIND_ORDER.find((kind) => kind === type) || null;
}

export type StepKindGroup = {
  /** null = 认不出类型的步骤（照旧按「节点」渲染，拆卡不丢行） */
  kind: CardKind | null;
  /** 在原始 steps / rows 里的下标：行、touched、统一设置全都按这个下标走 */
  indices: number[];
};

/** 按类型把步骤分组：顺序固定，空类型不出现；认不出类型的挂最后一组 */
export function groupPlanSteps(steps: PlanStep[]): StepKindGroup[] {
  const groups: StepKindGroup[] = CARD_KIND_ORDER.map((kind) => ({ kind: kind as CardKind | null, indices: [] }));
  const other: StepKindGroup = { kind: null, indices: [] };
  (steps || []).forEach((step, index) => {
    const kind = stepCardKind(step);
    (kind ? groups[CARD_KIND_ORDER.indexOf(kind)] : other).indices.push(index);
  });
  return [...groups, other].filter((group) => group.indices.length);
}

function readSource(step: PlanStep): Record<string, any> {
  const args = (step?.args || {}) as Record<string, any>;
  return planStepScope(step) === "settings" ? ((args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, any>) : args;
}

function normalizedModelId(provider: string, model: string): string {
  return provider && model ? provider + "::" + model : "";
}

/** 步骤里**显式写过**的 provider / model（settings 或 args），没写就是空串；不要拿 models[0] 兜底 */
export function planStepModelSource(step: PlanStep): { provider: string; model: string } {
  const source = readSource(step);
  const args = (step?.args || {}) as Record<string, any>;
  let provider = String(source.provider || args.provider || "");
  let model = String(source.model || args.model || "");
  // 兼容把完整 id 写进 model 的情况：p::m 拆成 provider / model
  if (!provider && model.includes("::")) ({ provider, model } = splitModelId(model));
  return { provider, model };
}

/** 步骤显式指定的模型；没写 / 列表里没有就返回 undefined（方案卡据此显示「跟随助手默认」） */
export function findExplicitPlanModel(step: PlanStep, kind: PlanKind, models: ModelSpec[] = []): ModelSpec | undefined {
  const { provider, model } = planStepModelSource(step);
  return findPlanModel(models, kind, provider, model);
}

export function findPlanModel(models: ModelSpec[], kind: PlanKind, provider: string, model: string): ModelSpec | undefined {
  const list = (models || []).filter((m) => m.kind === kind);
  const wanted = normalizedModelId(provider, model);
  if (wanted) {
    const exact = list.find((m) => m.id === wanted);
    if (exact) return exact;
  }
  if (model) {
    const byName = list.find((m) => m.name === model);
    if (byName) return byName;
  }
  return undefined;
}

export function tierIndex(resolution: string | number): number {
  const text = String(resolution || "").toLowerCase().replace(/[^0-9]/g, "");
  const n = Number(text);
  if (n >= 4) return 2;
  if (n >= 3) return 2;   // 3K 表里没有独立列：落到 4K 列，再由后端尺寸策略收敛
  if (n >= 2) return 1;
  return 0;
}

export function tierLabel(index: number): string {
  return TIER_LABELS[Math.max(0, Math.min(2, index))];
}

/** 显式像素：表内比例直接查表；表外比例按该档长边等比换算（分辨率档仍取 1K/2K/4K） */
export function imageSizeFor(ratio: string, resolution: string): string {
  const text = String(ratio || "").trim().toLowerCase();
  if (!text || ["auto", "自适应", "自动", "adaptive", "source"].includes(text)) return "";
  const idx = tierIndex(resolution);
  const hit = IMAGE_SIZE_TABLE[text];
  if (hit) return hit[idx];
  const m = text.match(/^(\d+):(\d+)$/);
  if (!m) return IMAGE_SIZE_TABLE["1:1"][idx];
  const w = Number(m[1]), h = Number(m[2]);
  if (!w || !h) return IMAGE_SIZE_TABLE["1:1"][idx];
  const long = IMAGE_TIER_LONG[idx] || 1536;
  return w >= h ? long + "x" + Math.max(1, Math.round(long * h / w)) : Math.round(long * w / h) + "x" + long;
}

/** 从已有显式 size 反推是哪个分辨率档（对不上任何表值时按长边取最近档） */
export function resolutionFromSize(size: string, ratio = ""): string {
  const m = String(size || "").trim().match(/^(\d+)x(\d+)$/);
  if (!m) return "";
  const w = Number(m[1]), h = Number(m[2]);
  const table = IMAGE_SIZE_TABLE[String(ratio || "").trim().toLowerCase()];
  if (table) {
    const idx = table.findIndex((item) => item === m[0]);
    if (idx >= 0) return TIER_LABELS[idx];
  }
  const long = Math.max(w, h);
  if (long >= 2800) return "4K";
  if (long >= 1700) return "2K";
  return "1K";
}

export function imageResolutionOptions(spec: ModelSpec | undefined, current = ""): string[] {
  // 有 spec 时严格用 spec.sizes（空数组=后端明确没有），不再拿默认档位补，避免表格外多出选项
  const declared = spec && Array.isArray(spec.sizes);
  const list = declared ? (spec!.sizes || []).map((x) => String(x).toUpperCase()).filter(Boolean) : [];
  const base = declared ? [...new Set(list)] : ["1K", "2K", "4K"];
  if (!declared && current && !base.includes(current)) base.unshift(current);
  return base;
}

export function imageRatioOptions(spec: ModelSpec | undefined, current = ""): string[] {
  const declared = spec && Array.isArray(spec.ratios);
  const list = declared ? (spec!.ratios || []).map((x) => String(x).trim()).filter(Boolean) : [];
  const base = declared ? [...new Set(list)] : ["1:1", "3:4", "4:3", "16:9", "9:16"];
  if (!declared && current && !base.includes(current)) base.unshift(current);
  return base;
}

export function planVideoRatio(raw: unknown): string {
  const text = String(raw ?? "").trim();
  return /^(auto|adaptive|自适应)$/i.test(text) ? "adaptive" : text;
}

export function videoRatioOptions(spec: ModelSpec | undefined, current = ""): string[] {
  const declared = spec && Array.isArray(spec.ratios);
  const list = declared ? (spec!.ratios || []).map(planVideoRatio).filter(Boolean) : [];
  const base = declared ? [...new Set(list)] : ["adaptive", "16:9", "9:16", "1:1"];
  if (!declared && current && !base.includes(planVideoRatio(current))) base.unshift(planVideoRatio(current));
  return base;
}

export function videoResOptions(spec: ModelSpec | undefined, current = ""): string[] {
  const declared = spec && Array.isArray(spec.res);
  const list = declared ? (spec!.res || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  const base = declared ? [...new Set(list)] : [];
  if (!declared && current && !base.includes(current)) base.unshift(current);
  return base;
}

export function countOptions(spec: ModelSpec | undefined, current = 1): number[] {
  const declared = spec && Array.isArray(spec.batch);
  const list = declared ? (spec!.batch || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 8) : [];
  const base = declared ? [...new Set(list)].sort((a, b) => a - b) : [1];
  if (!declared && current > 0 && !base.includes(current) && current <= 8) base.push(current);
  return [...new Set(base)].sort((a, b) => a - b);
}

export function durationOptions(spec: ModelSpec | undefined, current = 5): number[] {
  const declared = spec && Array.isArray(spec.durs);
  const list = declared ? (spec!.durs || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 1 && x <= 60) : [];
  const base = declared ? [...new Set(list)].sort((a, b) => a - b) : [5, 10];
  if (!declared && current >= 1 && current <= 60 && !base.includes(current)) base.push(current);
  return [...new Set(base)].sort((a, b) => a - b);
}

export function readPlanParams(step: PlanStep, kind: PlanKind, models: ModelSpec[] = []): PlanParams {
  const source = readSource(step);
  const scope = planStepScope(step);
  const args = (step?.args || {}) as Record<string, any>;
  const provider = String(source.provider || args.provider || "");
  const model = String(source.model || args.model || "");
  const spec = findPlanModel(models, kind, provider, model);
  const fallback = models.find((m) => m.kind === kind);
  const chosen = spec || fallback;
  const ratio = kind === "video" ? planVideoRatio(source.ratio || "adaptive") : String(source.ratio || "1:1");
  // 分辨率：步骤里没写、或写的值不在该模型的档位里（换过模型 / 旧数据）→ 回落到模型第一档，不能显示空白
  const resolution = kind === "image" ? imageResolutionFor(chosen, source) : videoResolutionFor(chosen, source);
  const rows = Array.isArray(args.rows) ? args.rows.length : 0;
  // 不再静默回落到 spec.batch[0]：这里只保留「用户要几张」，
  // 模型一次最多 N 张时由 countPlan()/expandGenerationSteps() 拆成多次执行（见文件末尾）。
  const count = Math.max(1, Math.round(Number(source.count) || (step?.tool === "batch_generate" ? rows || 1 : 1)));
  const duration = Math.max(1, Number(source.duration) || 5);
  let mode = kind === "video" ? videoModeApi(source.mode) : "";
  if (kind === "video" && spec && Array.isArray(spec.modes) && mode) {
    const supported = videoModeOptions(spec).map((x) => x.value);
    if (!supported.includes(mode)) mode = supported[0] || "";
  }
  const thinkingRaw = source.thinking;
  const mjRaw = source.mj;
  return {
    kind,
    scope,
    provider: provider || splitModelId(chosen?.id).provider,
    model: model || splitModelId(chosen?.id).model,
    ratio,
    resolution,
    size: kind === "image" ? String(source.size || imageSizeFor(ratio, resolution)) : "",
    count,
    duration,
    mode,
    quality: String(source.quality || ""),
    thinking: thinkingRaw === true ? "on" : thinkingRaw === false ? "off" : "default",
    outputFormat: outputFormatForRequest(source.outputFormat),
    background: source.background === "transparent",
    search: source.search === true,
    style: normalizeStyle(source.style),
    camera: cameraFor(source.camera),
    ...(mjRaw && typeof mjRaw === "object" && Object.keys(mjRaw).length ? { mj: { ...(mjRaw as MjParams) } } : {}),
    times: Math.max(1, Math.round(Number(source.times) || 1)),
    genMode: String(source.genMode || ""),
    turbo: source.turbo === true,
    draft: source.draft === true,
    multiShot: source.multiShot === true,
  };
}

/** 摄影机组合：节点 / 步骤里存的是 {on, body, lens, focal, aperture}；布尔只表示开关 */
function cameraFor(raw: unknown): CameraParams {
  if (raw && typeof raw === "object") {
    const value = raw as Partial<CameraParams>;
    return { ...DEFAULT_CAMERA, ...value, on: value.on === true };
  }
  return { ...DEFAULT_CAMERA, on: raw === true };
}

/** 图片分辨率档：步骤给的值不在该模型的 sizes 里就回落到第一档（没有 sizes 声明才保留原值） */
function imageResolutionFor(spec: ModelSpec | undefined, source: Record<string, any>): string {
  const list = imageResolutionOptions(spec);
  const current = String(source.resolution || "").toUpperCase()
    || resolutionFromSize(String(source.size || ""), String(source.ratio || "1:1"));
  if (current && (!list.length || list.includes(current))) return current;
  return list[0] || current || "1K";
}

/** 视频分辨率档：同上，模型有 res 列表时绝不显示空白 */
function videoResolutionFor(spec: ModelSpec | undefined, source: Record<string, any>): string {
  const list = videoResOptions(spec);
  const current = String(source.resolution || "").trim().toLowerCase();
  if (current && (!list.length || list.includes(current))) return current;
  return list[0] || current || "";
}

/** 该模型一次最多能出几张：batch 声明的最大合法值；没有声明 / 批量未知按 1 张处理 */
export function maxBatchOf(spec: ModelSpec | undefined): number {
  const declared = spec && Array.isArray(spec.batch) ? spec.batch.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1) : [];
  return declared.length ? Math.max(...declared) : 1;
}

export type CountPlan = {
  requested: number;
  /** 每次最多几张（模型 batch 的最大合法值；未知时 1） */
  perGroup: number;
  groups: number;
  /** 每次实际生成几张（尾组可能不足 perGroup；不在模型合法档位的尾数会补到最近一档） */
  sizes: number[];
  /** 模型明确声明了 batchUnknown（批量上限未知） */
  batchUnknown: boolean;
  /** 没有声明 batch（旧数据 / 未知） */
  unknownBatch: boolean;
  /** 尾组被补到合法档位（总数会略多于用户要求） */
  bumped: boolean;
};

/**
 * 「要 X 张、这个模型一次最多 N 张」→ 分几次、每次几张。
 *   4 + batch=[1]     → 4 次，每次 1
 *   4 + batch=[1,2]   → 2 次，每次 2
 *   4 + batch=[1,2,4] → 1 次，4 张
 *   1                 → 1 次，1 张
 * 批量未知（batchUnknown / 没声明）→ 按一次 1 张，卡片上明确提示。
 */
export function countPlan(spec: ModelSpec | undefined, requested: number): CountPlan {
  const want = Math.max(1, Math.round(Number(requested) || 1));
  const declared = spec && Array.isArray(spec.batch) ? spec.batch.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1) : [];
  const perGroup = declared.length ? Math.max(...declared) : 1;
  const sizeCount = Math.ceil(want / perGroup);
  const sizes: number[] = [];
  let left = want;
  for (let i = 0; i < sizeCount; i += 1) { const take = Math.min(perGroup, left); sizes.push(take); left -= take; }
  let bumped = false;
  if (declared.length) {
    for (let i = 0; i < sizes.length; i += 1) {
      if (declared.includes(sizes[i])) continue;
      const fix = declared.filter((n) => n >= sizes[i]).sort((a, b) => a - b)[0];
      if (fix) { sizes[i] = fix; bumped = true; }
    }
  }
  return { requested: want, perGroup, groups: sizes.length, sizes, batchUnknown: !!spec && spec.batchUnknown === true, unknownBatch: !declared.length, bumped };
}

/** 把批准给后端的步骤按「模型一次最多 N 张」拆成多次 run_generation（总数等于用户要的；尾组按合法档位补） */
export function expandGenerationSteps(steps: PlanStep[], models: ModelSpec[] = []): PlanStep[] {
  const out: PlanStep[] = [];
  for (const step of steps) {
    const kind = planStepKind(step, models);
    if (!kind) { out.push(step); continue; }
    const source = planStepModelSource(step);
    const spec = findPlanModel(models, kind, source.provider, source.model);
    const requested = Math.max(1, Math.round(Number(readSource(step).count) || 1));
    const plan = countPlan(spec, requested);
    if (plan.groups <= 1) { out.push(step); continue; }
    for (let i = 0; i < plan.sizes.length; i += 1) {
      const copy = JSON.parse(JSON.stringify(step)) as PlanStep;
      const args = (copy.args || {}) as Record<string, any>;
      if (planStepScope(step) === "settings") {
        const settings = (args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, any>;
        settings.count = plan.sizes[i];
        args.settings = settings;
      } else {
        args.count = plan.sizes[i];
      }
      copy.args = args;
      // 明确标记：同节点的多次执行要按顺序串行（画布 autorun 靠它建队列，不按节点去重吞掉）
      args.countGroup = { index: i + 1, total: plan.sizes.length };
      copy.description = (step.description || "生成") + "（第 " + (i + 1) + "/" + plan.sizes.length + " 次）";
      out.push(copy);
    }
  }
  return out;
}

/** 从批准步骤里取出「同节点按顺序执行」的队列（带 countGroup 标记的步骤；旧路径没有标记返回空 = 保持原去重行为） */
export type CountGroupItem = { nodeId: string; index: number; total: number; settings: Record<string, unknown> };
export function countGroupQueue(steps: PlanStep[]): Map<string, CountGroupItem[]> {
  const queues = new Map<string, CountGroupItem[]>();
  for (const step of steps || []) {
    const args = (step?.args || {}) as Record<string, any>;
    const group = args.countGroup as { index?: number; total?: number } | undefined;
    const nodeId = String(args.node_id || "");
    if (!group || !nodeId) continue;
    const settings = { ...((args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, unknown>) };
    // 卡片里模型可能是短 id（agnes-image-2.0-flash）：队列统一存完整 provider::model，执行时 modelOf 才能解析
    if (settings.model && !String(settings.model).includes("::") && settings.provider) settings.model = String(settings.provider) + "::" + String(settings.model);
    const item: CountGroupItem = { nodeId, index: Math.max(1, Number(group.index) || 1), total: Math.max(1, Number(group.total) || 1), settings };
    const list = queues.get(nodeId) || [];
    list.push(item);
    queues.set(nodeId, list);
  }
  for (const [nodeId, list] of queues) queues.set(nodeId, list.sort((a, b) => a.index - b.index));
  return queues;
}

/** 卡片写 settings：图片行不带视频键、视频行不带图片键；full = 连「默认 / 清空」标记一起写 */
function writeSettingsExtras(settings: Record<string, any>, params: PlanParams, full: boolean) {
  if (params.kind === "image") {
    delete settings.duration; delete settings.times; delete settings.genMode;
    delete settings.turbo; delete settings.draft; delete settings.multiShot; delete settings.audio;
    if (!full) return;
    if (params.quality) settings.quality = params.quality; else delete settings.quality;
    // 「默认」用 default 表示：后端把它当「删掉这个键」，回到跟随上游默认
    settings.thinking = params.thinking === "on" ? true : params.thinking === "off" ? false : "default";
    settings.outputFormat = params.outputFormat || "default";
    settings.background = params.background ? "transparent" : "default";
    settings.search = params.search === true;
    settings.style = params.style || "无";
    settings.camera = { ...params.camera };
    settings.mj = params.mj && Object.keys(params.mj).length ? { ...params.mj } : {};
    // GIF 帧参数只在 gif 输出时跟着走（后端 / 画布都按 outputFormat 判断）
    if (params.outputFormat !== "gif") { delete settings.frameCount; delete settings.frameDuration; }
  } else {
    delete settings.quality; delete settings.thinking; delete settings.outputFormat; delete settings.background;
    delete settings.search; delete settings.style; delete settings.camera; delete settings.mj;
    delete settings.frameCount; delete settings.frameDuration;
    if (!full) return;
    settings.times = params.times;
    settings.genMode = params.genMode || "default";
    settings.turbo = params.turbo === true;
    settings.draft = params.draft === true;
    settings.multiShot = params.multiShot === true;
    if (typeof params.audio === "boolean") settings.audio = params.audio;
    if (params.mode) settings.mode = params.mode; else delete settings.mode;
  }
}

function writePlanParams(step: PlanStep, params: PlanParams, full = false): PlanStep {
  const copy = JSON.parse(JSON.stringify(step || {})) as PlanStep;
  const args = (copy.args || {}) as Record<string, any>;
  if (params.scope === "settings") {
    const settings = (args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, any>;
    if (params.provider) settings.provider = params.provider; else delete settings.provider;
    if (params.model) settings.model = params.model; else delete settings.model;
    settings.ratio = params.ratio;
    if (params.kind === "image") {
      settings.resolution = params.resolution.toLowerCase();
      if (params.size) settings.size = params.size; else delete settings.size;
      if (copy.tool !== "batch_generate") settings.count = params.count;
    } else {
      if (params.resolution) settings.resolution = params.resolution; else delete settings.resolution;
      settings.duration = params.duration;
    }
    writeSettingsExtras(settings, params, full);
    args.settings = settings;
  } else {
    if (params.provider) args.provider = params.provider; else delete args.provider;
    if (params.model) args.model = params.model; else delete args.model;
    args.ratio = params.ratio;
    if (params.kind === "image") {
      if (params.size) args.size = params.size; else delete args.size;
      args.count = params.count;
    } else {
      args.duration = params.duration;
      // 后端 generate_video 新增 mode 入参；只写接口值，空串 = 自动（不落 args）
      if (String(copy.tool || "").toLowerCase() === "generate_video") {
        if (params.mode) args.mode = params.mode; else delete args.mode;
      }
    }
  }
  copy.args = args;
  return copy;
}

export function patchPlanStep(step: PlanStep, kind: PlanKind, models: ModelSpec[], patch: PlanStepPatch): PlanStep {
  const current = readPlanParams(step, kind, models);
  // 只有步骤显式写了模型（或这次明确选了模型）才写回 provider/model；不要用 readPlanParams 的兜底模型
  const source = planStepModelSource(step);
  let provider = source.provider, model = source.model;
  let spec = findPlanModel(models, kind, provider, model);
  if (patch.modelConfigId) {
    const picked = models.find((m) => m.id === patch.modelConfigId && m.kind === kind);
    if (picked) { provider = splitModelId(picked.id).provider; model = splitModelId(picked.id).model; spec = picked; }
  } else if (patch.modelConfigId === "") {
    // 选回「跟随助手默认」：清掉步骤里的模型，交给运行上下文
    provider = ""; model = ""; spec = undefined;
  }
  // 没显式模型时，比例/分辨率/张数用默认 spec 收敛选项，但绝不写回模型
  const optionSpec = spec || (models || []).find((m) => m.kind === kind);
  let ratio = patch.ratio !== undefined ? patch.ratio : current.ratio;
  let resolution = patch.resolution !== undefined ? patch.resolution : current.resolution;
  let count = patch.count !== undefined ? Math.max(1, Math.round(patch.count)) : current.count;
  let duration = patch.duration !== undefined ? Math.max(1, Math.round(patch.duration)) : current.duration;
  let mode = patch.mode !== undefined ? videoModeApi(patch.mode) : current.mode;
  let quality = patch.quality !== undefined ? patch.quality : current.quality;
  let thinking: TriState = patch.thinking !== undefined ? patch.thinking : current.thinking;
  let outputFormat = patch.outputFormat !== undefined ? patch.outputFormat : current.outputFormat;
  let background = patch.background !== undefined ? patch.background : current.background;
  let search = patch.search !== undefined ? patch.search : current.search;
  let style = patch.style !== undefined ? patch.style : current.style;
  let camera = patch.camera !== undefined ? patch.camera : current.camera;
  let mj = patch.mj !== undefined ? patch.mj : current.mj;
  let times = patch.times !== undefined ? Math.max(1, Math.round(patch.times)) : current.times;
  let genMode = patch.genMode !== undefined ? patch.genMode : current.genMode;
  let turbo = patch.turbo !== undefined ? patch.turbo : current.turbo;
  let draft = patch.draft !== undefined ? patch.draft : current.draft;
  let multiShot = patch.multiShot !== undefined ? patch.multiShot : current.multiShot;
  let audio = patch.audio !== undefined ? patch.audio : current.audio;
  if (optionSpec) {
    const ratios = kind === "image" ? imageRatioOptions(optionSpec) : videoRatioOptions(optionSpec);
    if (ratios.length && !ratios.includes(ratio)) ratio = ratios[0];
    if (kind === "image") {
      const sizes = imageResolutionOptions(optionSpec);
      if (sizes.length && !sizes.includes(resolution)) resolution = sizes[0];
      // 张数不在这里夹回 batch[0]：用户要几张就保留几张，批量收敛交给 expandGenerationSteps 拆组执行。
      // （其余参数仍按模型支持的选项纠正；只有「要几张」不能被吞，否则批准转录里就只剩 1 张。）
    } else {
      const durs = durationOptions(optionSpec, duration);
      if (durs.length && !durs.includes(duration)) duration = durs[0];
      const resList = videoResOptions(optionSpec);
      if (resList.length && !resList.includes(resolution)) resolution = resList[0];
      const modes = videoModeOptions(optionSpec).map((x) => x.value);
      if (mode && !modes.includes(mode)) mode = modes[0] || "";
      const timesList = (optionSpec.times || [1]).filter((n) => Number(n) >= 1);
      if (!timesList.includes(times)) times = timesList[0] || 1;
      const genModes = optionSpec.genModes || [];
      if (genModes.length && genMode && !genModes.includes(genMode)) genMode = genModes[0];
      if (!optionSpec.genModes?.length) genMode = "";
      if (!optionSpec.turbo) turbo = false;
      if (!optionSpec.multiShot) multiShot = false;
      if (!resRange(optionSpec)) draft = false;
      if (!optionSpec.audio) audio = false;
    }
    if (kind === "image") {
      quality = clampQuality(qualityLevelsFor(optionSpec), quality);
      const thinkFlag = clampThinking(thinkingAvailable(optionSpec), thinking === "on" ? true : thinking === "off" ? false : undefined);
      thinking = thinkFlag === true ? "on" : thinkFlag === false ? "off" : "default";
      const formats = outputFormatOptions(optionSpec).map((x) => x.value);
      if (!formats.includes(outputFormat)) outputFormat = "";
      if (!optionSpec.nativeBackground) background = false;
      if (!optionSpec.search) search = false;
      style = optionSpec.style ? normalizeStyle(style) : "无";
      if (!optionSpec.camera) camera = { ...camera, on: false };
      if (optionSpec.mj) {
        const next: MjParams = { ...(mj || {}) };
        if (next.version && !optionSpec.mj.versions.includes(next.version)) delete next.version;
        if (next.speed && !optionSpec.mj.speeds.includes(next.speed)) delete next.speed;
        if (next.hd && !optionSpec.mj.hd.includes(next.version || "")) next.hd = false;
        mj = Object.keys(next).length ? next : undefined;
      } else mj = undefined;
    }
  }
  const next: PlanParams = {
    kind, scope: planStepScope(step), provider, model, ratio, resolution, size: "", count, duration, mode,
    quality, thinking, outputFormat, background, search, style, camera, times, genMode, turbo, draft, multiShot,
    ...(mj ? { mj } : {}),
    ...(typeof audio === "boolean" ? { audio } : {}),
  };
  if (kind === "image") next.size = imageSizeFor(ratio, resolution);
  return writePlanParams(step, next, patch.full === true);
}

function modelLabel(spec: ModelSpec | undefined, provider: string, model: string): string {
  if (spec) return (spec.vendor || splitModelId(spec.id).provider || "模型") + " · " + spec.name;
  if (provider && model) return provider + " · " + model;
  return model || "助手默认模型";
}

/** 方案卡上的一句人话摘要（只概括生成类步骤；没有生成步骤时返回空串） */
export function planParamsSummary(steps: PlanStep[], models: ModelSpec[] = []): string {
  const parts: string[] = [];
  (steps || []).forEach((step) => {
    const kind = planStepKind(step, models);
    if (!kind) return;
    const params = readPlanParams(step, kind, models);
    const src = planStepModelSource(step);
    const explicit = findPlanModel(models, kind, src.provider, src.model);
    // 没有显式模型就不要把 models[0] 写进摘要（执行时用的是运行上下文默认模型）
    const raw = src.provider && src.model ? src.provider + " · " + src.model : (src.model || src.provider);
    const label = explicit ? modelLabel(explicit, "", "") : raw || "跟随助手默认";
    const tool = String(step.tool || "").toLowerCase();
    if (tool === "batch_generate") {
      const rows = Array.isArray((step.args || {}).rows) ? (step.args as Record<string, any>).rows.length : params.count;
      parts.push("按 " + (rows || 1) + " 行批量出" + (kind === "video" ? "视频" : "图") + "（" + label + "，" + ratioDisplayLabel(params.ratio) + (kind === "image" ? " " + params.resolution : "") + "）");
      return;
    }
    if (kind === "video") {
      const mode = videoModeLabel(params.mode);
      parts.push("用 " + label + (mode ? " 以" + mode + "出 " : " 出 ") + params.duration + "s " + ratioDisplayLabel(params.ratio) + " 视频");
    }
    else parts.push("用 " + label + " 出 " + params.count + " 张 " + ratioDisplayLabel(params.ratio) + " " + params.resolution);
  });
  return parts.join("；");
}

/** 待生成卡片里一行参数（L6）：「执行生成」按它把模型 / 比例 / 张数写进执行步骤 */
export type ApproveRow = {
  on: boolean;
  modelId: string;
  ratio: string;
  resolution: string;
  count: number;
  duration: number;
  mode: string;
  /** 视频：这一镜要不要模型自带的原生音频（只有 video 行有意义） */
  audio?: boolean;
  prompt: string;
  // ---- 图片（键名与 ImageParams 一致；默认值 = 跟随上游默认）----
  quality?: string;
  thinking?: TriState;
  outputFormat?: "" | ImageOutputFormat;
  background?: boolean;
  /** 图片 / 文本的联网检索 */
  search?: boolean;
  style?: string;
  camera?: CameraParams;
  mj?: MjParams;
  // ---- 视频（键名与 VideoParams 一致）----
  times?: number;
  genMode?: string;
  turbo?: boolean;
  draft?: boolean;
  multiShot?: boolean;
  // ---- 文本（TextParams.out of 面板同款三档 / 模型强度 / 联网）----
  output?: TextOutputMode;
  think?: string;
  // ---- 音频（AudioParams）----
  audioKind?: string;
  audioDur?: string;
};
export type ApproveNode = { node_id: string; title: string; prompt?: string };

/** 「执行生成」能不能点：至少勾一个节点，图片 / 视频节点都必须选了模型 */
export function generationReady(rows: ApproveRow[], kinds: Array<CardKind | null>): boolean {
  const picked = rows.filter((r) => r.on).length;
  if (!picked) return false;
  return !rows.some((r, i) => r.on && (kinds[i] === "image" || kinds[i] === "video") && !r.modelId);
}

/** 文本行的默认值：步骤 settings → 模型能力第一档 */
export type TextRowParams = { output: TextOutputMode; think: string; search: boolean };
export function readTextRowParams(step: PlanStep, models: ModelSpec[] = []): TextRowParams {
  const source = readSource(step);
  const spec = models.find((m) => m.kind === "text");
  const levels = thinkLevelsFor(spec);
  const output = String(source.output || "text").toLowerCase();
  const think = String(source.think || "");
  return {
    output: output === "table" || output === "storyboard" ? output : "text",
    think: levels.includes(think) ? think : "",
    search: source.search === true,
  };
}

/** 音频行的默认值：步骤 settings → 模型能力第一档 */
export type AudioRowParams = { kind: string; dur: string };
export function readAudioRowParams(step: PlanStep, models: ModelSpec[] = []): AudioRowParams {
  const source = readSource(step);
  const spec = models.find((m) => m.kind === "audio");
  const kinds = spec?.kinds || [];
  const durs = spec?.adurs || [];
  const kind = String(source.kind || "");
  const dur = String(source.dur || "");
  return {
    kind: kinds.includes(kind) ? kind : (kinds[0] || kind || ""),
    dur: durs.includes(dur) ? dur : (durs[0] || dur || ""),
  };
}

/** 节点上现有的 params → 一行默认值（键名与四套 param 类型逐项对齐；卡片默认优先读它） */
export function rowFromNodeParams(kind: CardKind, params: Record<string, any> | null | undefined): Partial<ApproveRow> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, any>;
  if (kind === "image") {
    const out: Partial<ApproveRow> = {
      outputFormat: outputFormatForRequest(p.outputFormat),
      background: p.background === "transparent",
      search: p.search === true,
      style: normalizeStyle(p.style),
      camera: cameraFor(p.camera),
    };
    if (p.ratio) out.ratio = String(p.ratio);
    if (p.size) out.resolution = String(p.size).toUpperCase();
    if (p.count) out.count = Math.max(1, Math.round(Number(p.count) || 1));
    if (p.quality) out.quality = String(p.quality);
    if (p.thinking === true || p.thinking === false) out.thinking = p.thinking ? "on" : "off";
    if (p.mj && typeof p.mj === "object" && Object.keys(p.mj).length) out.mj = { ...(p.mj as MjParams) };
    return out;
  }
  if (kind === "video") {
    const out: Partial<ApproveRow> = { audio: p.sound === true, turbo: p.turbo === true, draft: p.draft === true, multiShot: p.multiShot === true };
    if (p.ratio) out.ratio = planVideoRatio(p.ratio);
    if (p.res) out.resolution = String(p.res).toLowerCase();
    if (p.dur) out.duration = Math.max(1, Number(p.dur) || 5);
    if (p.times) out.times = Math.max(1, Math.round(Number(p.times) || 1));
    if (p.mode) out.mode = videoModeApi(p.mode);
    if (p.genMode) out.genMode = String(p.genMode);
    return out;
  }
  if (kind === "text") {
    const output = String(p.output || "text").toLowerCase();
    return {
      output: output === "table" || output === "storyboard" ? output : "text",
      think: String(p.think || ""),
      search: p.search === true,
    };
  }
  return { audioKind: String(p.kind || ""), audioDur: String(p.dur || "") };
}

/**
 * 按模型能力收敛一行参数（换模型时用）：比例 / 分辨率 / 时长 / 方式 / 质量档 / 输出格式 …
 * 张数故意不收敛（批量拆分交给 expandGenerationSteps），其它都收到该模型第一档。
 */
export function clampRowParams(kind: PlanKind, row: ApproveRow, spec: ModelSpec | undefined): Partial<ApproveRow> {
  if (!spec) return {};
  const out: Partial<ApproveRow> = {};
  const ratios = kind === "image" ? imageRatioOptions(spec) : videoRatioOptions(spec);
  if (ratios.length && !ratios.includes(kind === "image" ? row.ratio : planVideoRatio(row.ratio))) out.ratio = ratios[0];
  if (kind === "image") {
    const sizes = imageResolutionOptions(spec);
    if (sizes.length && !sizes.includes(row.resolution)) out.resolution = sizes[0];
    out.quality = clampQuality(qualityLevelsFor(spec), row.quality);
    const thinkFlag = clampThinking(thinkingAvailable(spec), row.thinking === "on" ? true : row.thinking === "off" ? false : undefined);
    out.thinking = thinkFlag === true ? "on" : thinkFlag === false ? "off" : "default";
    const formats = outputFormatOptions(spec).map((x) => x.value);
    out.outputFormat = formats.includes(row.outputFormat || "") ? (row.outputFormat || "") : "";
    if (!spec.nativeBackground) out.background = false;
    if (!spec.search) out.search = false;
    out.style = spec.style ? normalizeStyle(row.style) : "无";
    const camera = cameraFor(row.camera);
    out.camera = spec.camera ? camera : { ...camera, on: false };
    if (spec.mj && row.mj) {
      const mj: MjParams = { ...row.mj };
      if (mj.version && !spec.mj.versions.includes(mj.version)) delete mj.version;
      if (mj.speed && !spec.mj.speeds.includes(mj.speed)) delete mj.speed;
      if (mj.hd && !spec.mj.hd.includes(mj.version || "")) mj.hd = false;
      out.mj = Object.keys(mj).length ? mj : undefined;
    } else out.mj = undefined;
    return out;
  }
  const resList = videoResOptions(spec);
  if (resList.length && !resList.includes(row.resolution)) out.resolution = resList[0];
  const durs = durationOptions(spec, row.duration);
  if (durs.length && !durs.includes(row.duration)) out.duration = durs[0];
  const modes = videoModeOptions(spec).map((x) => x.value);
  if (modes.length && row.mode && !modes.includes(row.mode)) out.mode = modes[0] || "";
  const timesList = (spec.times || [1]).filter((n) => Number(n) >= 1);
  out.times = timesList.includes(row.times || 1) ? row.times || 1 : (timesList[0] || 1);
  const genModes = spec.genModes || [];
  if (!genModes.length) out.genMode = "";
  else if (row.genMode && !genModes.includes(row.genMode)) out.genMode = genModes[0];
  if (!spec.turbo) out.turbo = false;
  if (!spec.multiShot) out.multiShot = false;
  if (!resRange(spec)) out.draft = false;
  if (!spec.audio) out.audio = false;
  return out;
}


/* ---------- 待生成卡片「统一设置」：一次把同类行的参数改好 ----------
   能力取交集：只列「这批行（勾选中的同类型行；一个都没勾就按同类全部行）的模型都支持」的参数与取值，
   避免把 turbo / 透明背景这类能力应用到不支持它的行。默认「保持不改」，只把用户明确改过的项写进行里。 */
export type UnifiedOption = { value: string; label: string; patch: (row: ApproveRow) => Partial<ApproveRow> };
export type UnifiedItem = { key: string; label: string; options: UnifiedOption[]; hint?: string };
export type UnifiedGroup = { title?: string; items: UnifiedItem[] };
export type UnifiedPlan = {
  kind: CardKind;
  /** 这次要应用到的行（勾选中的同类型行；没有勾选 = 全部同类型行） */
  targets: number[];
  groups: UnifiedGroup[];
  /** 面板顶部那句小字：只列出都支持的参数 / 为什么没有可改项 */
  note: string;
  /** 这批行还有没选模型的（图片 / 视频）：没有能力交集，先不让改 */
  blocked: boolean;
};

const UNIFIED_NOTE = "只列出这些行都支持的参数";
const uniqueStrings = (list: string[]): string[] => [...new Set(list)];
/** 交集：只有每一行都支持时才保留这个取值 */
const commonStrings = (lists: string[][]): string[] => {
  if (!lists.length) return [];
  const head = uniqueStrings(lists[0]);
  return head.filter((value) => lists.every((list) => list.includes(value)));
};
const unifiedOption = (value: string, label: string, patch: Partial<ApproveRow> | ((row: ApproveRow) => Partial<ApproveRow>)): UnifiedOption =>
  ({ value, label, patch: typeof patch === "function" ? patch : () => patch });
const onOffOptions = (patch: (on: boolean, row: ApproveRow) => Partial<ApproveRow>): UnifiedOption[] => [
  unifiedOption("off", "关", (row) => patch(false, row)),
  unifiedOption("on", "开", (row) => patch(true, row)),
];

/** 只改 MJ 版本，其它（速度 / HD / 风格化）沿用行上的值 */
export function mjWithVersion(current: ApproveRow["mj"] | undefined, version: string) {
  const next = { ...(current || {}) };
  if (version) next.version = version; else delete next.version;
  return Object.keys(next).length ? next : undefined;
}

function imageUnifiedGroups(targets: number[], specs: Array<ModelSpec | undefined>): UnifiedGroup[] {
  const list = targets.map((i) => specs[i]).filter((spec): spec is ModelSpec => !!spec);
  const every = (test: (spec: ModelSpec) => boolean) => list.length === targets.length && list.every(test);
  const groups: UnifiedGroup[] = [];
  const frame: UnifiedItem[] = [];
  const ratios = commonStrings(list.map((spec) => imageRatioOptions(spec)));
  const sizes = commonStrings(list.map((spec) => imageResolutionOptions(spec)));
  const counts = commonStrings(list.map((spec) => countOptions(spec).map(String)));
  if (ratios.length) frame.push({ key: "ratio", label: "比例", options: ratios.map((v) => unifiedOption(v, ratioDisplayLabel(v), { ratio: v })) });
  if (sizes.length) frame.push({ key: "resolution", label: "分辨率", options: sizes.map((v) => unifiedOption(v, v, { resolution: v })) });
  if (counts.length) frame.push({ key: "count", label: "张数", options: counts.map((v) => unifiedOption(v, v + " 张", { count: Number(v) })) });
  if (frame.length) groups.push({ title: "画幅与张数", items: frame });

  const quality: UnifiedItem[] = [];
  if (every((spec) => qualityChoices(spec).length > 1)) {
    // 「默认」在有些模型是 auto、有些是空串：统一按空串写（后端两种都不发字段）
    const values = commonStrings(list.map((spec) => qualityChoices(spec).map((q) => (q.isDefault ? "" : q.value))));
    if (values.length) quality.push({ key: "quality", label: "质量", options: values.map((v) => unifiedOption(v, isQualityDefault(v) ? "默认" : qualityLabel(v), { quality: v })) });
  }
  if (every(thinkingAvailable)) quality.push({ key: "thinking", label: "先思考", options: [
    unifiedOption("default", "默认", { thinking: "default" }),
    unifiedOption("on", "开", { thinking: "on" }),
    unifiedOption("off", "关", { thinking: "off" }),
  ] });
  if (every((spec) => outputFormatOptions(spec).length > 1)) {
    const values = commonStrings(list.map((spec) => outputFormatOptions(spec).map((f) => f.value)));
    if (values.length) quality.push({ key: "outputFormat", label: "输出格式", options: values.map((v) => unifiedOption(v, outputFormatLabel(v),
      // 和节点面板一致：选 GIF / SVG 会清掉透明背景；选静态图不动背景
      v ? { outputFormat: v as ImageOutputFormat, background: false } : { outputFormat: "" })) });
  }
  if (every((spec) => spec.nativeBackground === true)) quality.push({ key: "background", label: "透明背景", hint: "透明只出 PNG，开了就不带输出格式", options: [
    unifiedOption("off", "关", { background: false }),
    // 透明与输出格式互斥（以透明为准）：开透明顺手把输出格式收回静态图
    unifiedOption("on", "开", { background: true, outputFormat: "" }),
  ] });
  if (quality.length) groups.push({ title: "画质", items: quality });

  const extra: UnifiedItem[] = [];
  if (every((spec) => spec.search === true)) extra.push({ key: "search", label: "联网", options: onOffOptions((on) => ({ search: on })) });
  if (every((spec) => spec.style === true)) extra.push({ key: "style", label: "风格", options: STYLES.map(([name]) => unifiedOption(name, name, { style: name })) });
  if (every((spec) => spec.camera === true)) extra.push({ key: "camera", label: "摄影机", options: onOffOptions((on, row) => ({ camera: { ...(row.camera || DEFAULT_CAMERA), on } })) });
  if (every((spec) => !!spec.mj && spec.mj.versions.length > 0)) {
    const versions = commonStrings(list.map((spec) => spec.mj!.versions.map(String)));
    if (versions.length) extra.push({ key: "mj", label: "MJ 版本", options: [
      unifiedOption("", "默认", (row) => ({ mj: mjWithVersion(row.mj, "") })),
      ...versions.map((v) => unifiedOption(v, /^niji/i.test(v) ? v.replace(/^niji\s*/i, "Niji ") : "v" + v, (row) => ({ mj: mjWithVersion(row.mj, v) }))),
    ] });
  }
  if (extra.length) groups.push({ title: "风格与参考", items: extra });
  return groups;
}

function videoUnifiedGroups(targets: number[], specs: Array<ModelSpec | undefined>): UnifiedGroup[] {
  const list = targets.map((i) => specs[i]).filter((spec): spec is ModelSpec => !!spec);
  const every = (test: (spec: ModelSpec) => boolean) => list.length === targets.length && list.every(test);
  const groups: UnifiedGroup[] = [];
  const frame: UnifiedItem[] = [];
  const ratios = commonStrings(list.map((spec) => videoRatioOptions(spec)));
  const sizes = commonStrings(list.map((spec) => videoResOptions(spec)));
  const durs = commonStrings(list.map((spec) => durationOptions(spec).map(String)));
  if (ratios.length) frame.push({ key: "ratio", label: "比例", options: ratios.map((v) => unifiedOption(v, ratioDisplayLabel(v), { ratio: v })) });
  // 换分辨率会关掉草稿：和节点面板选清晰度时的行为一致
  if (sizes.length) frame.push({ key: "resolution", label: "分辨率", options: sizes.map((v) => unifiedOption(v, v, { resolution: v, draft: false })) });
  if (durs.length) frame.push({ key: "duration", label: "时长", options: durs.map((v) => unifiedOption(v, v + "s", { duration: Number(v) })) });
  if (frame.length) groups.push({ title: "画幅与时长", items: frame });

  const gen: UnifiedItem[] = [];
  const modes = commonStrings(list.map((spec) => videoModeOptions(spec).map((m) => m.value)));
  if (modes.length) gen.push({ key: "mode", label: "方式", options: [
    unifiedOption("", "自动", { mode: "" }),
    ...modes.map((v) => unifiedOption(v, videoModeLabel(v), { mode: v })),
  ] });
  const times = commonStrings(list.map((spec) => (spec.times || [1]).filter((n) => Number(n) >= 1).map(String)));
  if (times.length) gen.push({ key: "times", label: "一次几条", options: times.map((v) => unifiedOption(v, v + " 条", { times: Number(v) })) });
  if (every((spec) => spec.audio === true)) gen.push({ key: "audio", label: "音频", options: onOffOptions((on) => ({ audio: on })) });
  if (every((spec) => (spec.genModes || []).length > 0)) {
    const genModes = commonStrings(list.map((spec) => spec.genModes || []));
    if (genModes.length) gen.push({ key: "genMode", label: "生成模式", options: [
      unifiedOption("", "默认", { genMode: "" }),
      ...genModes.map((v) => unifiedOption(v, v, { genMode: v })),
    ] });
  }
  if (gen.length) groups.push({ title: "生成", items: gen });

  const perf: UnifiedItem[] = [];
  if (every((spec) => spec.turbo === true)) perf.push({ key: "turbo", label: "加速", options: onOffOptions((on) => ({ turbo: on })) });
  // 草稿只在两档以上清晰度的模型上可用（节点面板的草稿行也是这个门槛）
  if (every((spec) => !!resRange(spec))) perf.push({ key: "draft", label: "草稿", hint: "按最低清晰度先出草稿，出成片再按所选清晰度", options: onOffOptions((on) => ({ draft: on })) });
  if (every((spec) => spec.multiShot === true)) perf.push({ key: "multiShot", label: "多镜头", options: onOffOptions((on) => ({ multiShot: on })) });
  if (perf.length) groups.push({ title: "性能", items: perf });
  return groups;
}

function textUnifiedGroups(targets: number[], specs: Array<ModelSpec | undefined>): UnifiedGroup[] {
  const list = targets.map((i) => specs[i]).filter((spec): spec is ModelSpec => !!spec);
  const every = (test: (spec: ModelSpec) => boolean) => list.length === targets.length && list.every(test);
  const items: UnifiedItem[] = [{ key: "output", label: "输出", options: TEXT_OUTPUT_MODES.map(([v, label]) => unifiedOption(v, label, { output: v })) }];
  if (every((spec) => thinkLevelsFor(spec).length > 1)) {
    const levels = commonStrings(list.map((spec) => thinkLevelsFor(spec)));
    if (levels.length) items.push({ key: "think", label: "强度", options: [
      unifiedOption("", "默认", { think: "" }),
      ...levels.map((lv) => unifiedOption(lv, thinkLevelLabel(lv), { think: lv })),
    ] });
  }
  if (every((spec) => spec.search === true)) items.push({ key: "search", label: "联网", options: onOffOptions((on) => ({ search: on })) });
  return [{ items }];
}

function audioUnifiedGroups(targets: number[], specs: Array<ModelSpec | undefined>): UnifiedGroup[] {
  const list = targets.map((i) => specs[i]).filter((spec): spec is ModelSpec => !!spec);
  const every = (test: (spec: ModelSpec) => boolean) => list.length === targets.length && list.every(test);
  const items: UnifiedItem[] = [];
  if (every((spec) => (spec.kinds || []).length > 0)) {
    const kinds = commonStrings(list.map((spec) => spec.kinds || []));
    if (kinds.length) items.push({ key: "audioKind", label: "类型", options: kinds.map((v) => unifiedOption(v, v, { audioKind: v })) });
  }
  if (every((spec) => (spec.adurs || []).length > 0)) {
    const durs = commonStrings(list.map((spec) => spec.adurs || []));
    if (durs.length) items.push({ key: "audioDur", label: "时长", options: durs.map((v) => unifiedOption(v, v, { audioDur: v })) });
  }
  return items.length ? [{ items }] : [];
}

/**
 * 统一设置的面板内容：取「这次要应用到的行」的模型能力交集。
 * 图片 / 视频行必须都选好模型才有能力交集；文本 / 音频行没有模型选择，用节点当前模型判能力。
 */
export function buildUnifiedPlan(kind: CardKind, rows: ApproveRow[], kinds: Array<CardKind | null>, specs: Array<ModelSpec | undefined>): UnifiedPlan {
  const same = rows.map((_, index) => index).filter((index) => kinds[index] === kind);
  const checked = same.filter((index) => rows[index]?.on);
  // 没勾选任何一行 → 应用到全部同类型行（文案在面板里写清作用对象）
  const targets = checked.length ? checked : same;
  if (!targets.length) return { kind, targets, groups: [], note: "卡片里没有这类节点", blocked: false };
  const needModel = kind === "image" || kind === "video";
  const missing = targets.filter((index) => !specs[index]).length;
  if (needModel && missing) return { kind, targets, groups: [], note: "还有 " + missing + " 行没选模型，先选好模型再统一设置", blocked: true };
  const groups = kind === "image" ? imageUnifiedGroups(targets, specs)
    : kind === "video" ? videoUnifiedGroups(targets, specs)
      : kind === "text" ? textUnifiedGroups(targets, specs)
        : audioUnifiedGroups(targets, specs);
  const usable = groups.filter((group) => group.items.length);
  return { kind, targets, groups: usable, note: usable.length ? UNIFIED_NOTE : "这些行没有可统一的参数", blocked: false };
}

/** 只保留面板上真实存在的选项（换模型 / 勾选变化后旧值自动失效，计数跟着降） */
export function pruneUnifiedValues(groups: UnifiedGroup[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of groups) for (const item of group.items) {
    const value = values[item.key];
    if (value !== undefined && item.options.some((option) => option.value === value)) out[item.key] = value;
  }
  return out;
}

/** 入口上的计数：改了几项（「保持不改」不算） */
export function unifiedValueCount(groups: UnifiedGroup[], values: Record<string, string>): number {
  return Object.keys(pruneUnifiedValues(groups, values)).length;
}

/**
 * 把用户改过的项写成每一行的 patch（保持不改的项不出现 = 不改）。
 * 顺序按分组：画幅 → 画质 → 风格；分辨率在草稿前面（同一次里草稿开关仍以用户选择为准），
 * 输出格式在透明背景前面（两者互斥时以透明为准，和节点面板 / 后端一致）。
 */
export function applyUnifiedValues(groups: UnifiedGroup[], rows: ApproveRow[], targets: number[], values: Record<string, string>): Array<{ index: number; patch: Partial<ApproveRow> }> {
  const picked: UnifiedOption[] = [];
  for (const group of groups) for (const item of group.items) {
    const value = values[item.key];
    const option = value === undefined ? undefined : item.options.find((entry) => entry.value === value);
    if (option) picked.push(option);
  }
  const out: Array<{ index: number; patch: Partial<ApproveRow> }> = [];
  for (const index of targets) {
    const row = rows[index];
    if (!row) continue;
    const patch: Partial<ApproveRow> = {};
    for (const option of picked) Object.assign(patch, option.patch(row));
    if (Object.keys(patch).length) out.push({ index, patch });
  }
  return out;
}

/** 文本行 → run_generation 的 settings（只写文本键，模型仍用节点当前的） */
export function writeTextApproveSettings(step: PlanStep, row: ApproveRow): PlanStep {
  const copy = JSON.parse(JSON.stringify(step || {})) as PlanStep;
  const args = (copy.args || {}) as Record<string, any>;
  const settings = { ...((args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, any>) };
  settings.output = row.output || "text";
  settings.think = row.think || "default";
  settings.search = row.search === true;
  args.settings = settings;
  copy.args = args;
  return copy;
}

/** 音频行 → run_generation 的 settings（只写音频键） */
export function writeAudioApproveSettings(step: PlanStep, row: ApproveRow): PlanStep {
  const copy = JSON.parse(JSON.stringify(step || {})) as PlanStep;
  const args = (copy.args || {}) as Record<string, any>;
  const settings = { ...((args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, any>) };
  if (row.audioKind) settings.kind = row.audioKind;
  if (row.audioDur) settings.dur = row.audioDur;
  args.settings = settings;
  copy.args = args;
  return copy;
}

/** 点「执行生成」时真正交给后端的步骤（L6）：改过的提示词先写回节点，再按行里选的模型 / 参数生成；
 *  一次生成不完的按模型批量上限拆成多次。选了模型后必须能产出可执行的 run_generation。 */
export function buildGenerationApproveSteps(steps: PlanStep[], rows: ApproveRow[],
  models: ModelSpec[], nodes: ApproveNode[]): AgentTaskPlan["steps"] {
  const out: AgentTaskPlan["steps"] = [];
  const infoOf = (step: PlanStep) => nodes.find((n) => n.node_id === (step.args || {}).node_id);
  steps.forEach((step, index) => {
    const type = String((step.args || {}).type || "").toLowerCase();
    const kind: CardKind | null = type === "image" || type === "video" || type === "text" || type === "audio" ? type : null;
    const row = rows[index];
    if (!row?.on) return;
    const args = (step.args || {}) as Record<string, any>;
    const info = infoOf(step);
    if (info && row.prompt.trim() && row.prompt.trim() !== (info.prompt || "").trim()) {
      out.push({ tool: "update_node", args: { canvas_id: args.canvas_id, node_id: args.node_id, prompt: row.prompt.trim() }, description: "改「" + info.title + "」的提示词" });
    }
    if (kind === "text") { out.push(writeTextApproveSettings(step, row)); return; }
    if (kind === "audio") { out.push(writeAudioApproveSettings(step, row)); return; }
    if (kind !== "image" && kind !== "video") { out.push(step); return; }
    const patched = patchPlanStep(step, kind, models, {
      full: true,
      modelConfigId: row.modelId, ratio: row.ratio, resolution: row.resolution,
      ...(kind === "image" ? { count: row.count } : { duration: row.duration }),
      quality: row.quality, thinking: row.thinking, outputFormat: row.outputFormat,
      background: row.background, search: row.search, style: row.style, camera: row.camera, mj: row.mj,
      mode: row.mode, audio: row.audio, times: row.times, genMode: row.genMode,
      turbo: row.turbo, draft: row.draft, multiShot: row.multiShot,
    });
    const settings = ((patched.args || {}) as Record<string, any>).settings;
    if (settings && typeof settings === "object") {
      delete settings.size;   // 画布节点参数用档位（1k/2k/4k），像素尺寸不往后端写
    }
    out.push(...expandGenerationSteps([patched], models));
  });
  return out;
}
