/**
 * 方案卡参数：把「生成类步骤」的 args 读成可编辑参数、写回 args/settings，并生成一句人话摘要。
 *   图片尺寸换算与 main.py 的 CHAT_RATIO_SIZE_OPTIONS 同表（1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 × 1k/2k/4k）；
 *   模型 ratios / sizes / batch / res / durs 来自 ModelSpec，是面板可选项的唯一来源。
 */
import { VMODES, type ModelSpec } from "../model";
import { ratioDisplayLabel } from "../originalRatio";
import type { AgentTaskPlan } from "../backend/types";

export type PlanStep = AgentTaskPlan["steps"][number];
export type PlanKind = "image" | "video";
export type PlanStepPatch = { modelConfigId?: string; ratio?: string; resolution?: string; count?: number; duration?: number; mode?: string };
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
  const list = declared ? (spec!.durs || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 1 && x <= 15) : [];
  const base = declared ? [...new Set(list)].sort((a, b) => a - b) : [5, 10];
  if (!declared && current >= 1 && current <= 15 && !base.includes(current)) base.push(current);
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
  const resolution = kind === "image"
    ? (String(source.resolution || "").toUpperCase() || resolutionFromSize(String(source.size || ""), ratio) || "1K")
    : String(source.resolution || (chosen?.res && chosen.res[0]) || "");
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
  };
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

function writePlanParams(step: PlanStep, params: PlanParams): PlanStep {
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
      if (params.resolution) settings.resolution = params.resolution;
      settings.duration = params.duration;
    }
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
    }
  }
  const next: PlanParams = { kind, scope: planStepScope(step), provider, model, ratio, resolution, size: "", count, duration, mode };
  if (kind === "image") next.size = imageSizeFor(ratio, resolution);
  return writePlanParams(step, next);
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
  prompt: string;
};
export type ApproveNode = { node_id: string; title: string; prompt?: string };

/** 「执行生成」能不能点：至少勾一个节点，图片 / 视频节点都必须选了模型 */
export function generationReady(rows: ApproveRow[], kinds: Array<PlanKind | "audio" | null>): boolean {
  const picked = rows.filter((r) => r.on).length;
  if (!picked) return false;
  return !rows.some((r, i) => r.on && (kinds[i] === "image" || kinds[i] === "video") && !r.modelId);
}

/** 点「执行生成」时真正交给后端的步骤（L6）：改过的提示词先写回节点，再按行里选的模型 / 参数生成；
 *  一次生成不完的按模型批量上限拆成多次。选了模型后必须能产出可执行的 run_generation。 */
export function buildGenerationApproveSteps(steps: PlanStep[], rows: ApproveRow[],
  models: ModelSpec[], nodes: ApproveNode[]): AgentTaskPlan["steps"] {
  const out: AgentTaskPlan["steps"] = [];
  const infoOf = (step: PlanStep) => nodes.find((n) => n.node_id === (step.args || {}).node_id);
  steps.forEach((step, index) => {
    const type = String((step.args || {}).type || "").toLowerCase();
    const kind: PlanKind | "audio" | null = type === "image" || type === "video" ? type : type === "audio" ? "audio" : null;
    const row = rows[index];
    if (!row?.on) return;
    const args = (step.args || {}) as Record<string, any>;
    const info = infoOf(step);
    if (info && row.prompt.trim() && row.prompt.trim() !== (info.prompt || "").trim()) {
      out.push({ tool: "update_node", args: { canvas_id: args.canvas_id, node_id: args.node_id, prompt: row.prompt.trim() }, description: "改「" + info.title + "」的提示词" });
    }
    if (kind !== "image" && kind !== "video") { out.push(step); return; }
    const patched = patchPlanStep(step, kind, models, {
      modelConfigId: row.modelId, ratio: row.ratio, resolution: row.resolution,
      ...(kind === "image" ? { count: row.count } : { duration: row.duration }),
    });
    const settings = ((patched.args || {}) as Record<string, any>).settings;
    if (settings && typeof settings === "object") {
      delete settings.size;   // 画布节点参数用档位（1k/2k/4k），像素尺寸不往后端写
      if (kind === "video") { if (row.mode) settings.mode = row.mode; else delete settings.mode; }
    }
    out.push(...expandGenerationSteps([patched], models));
  });
  return out;
}
