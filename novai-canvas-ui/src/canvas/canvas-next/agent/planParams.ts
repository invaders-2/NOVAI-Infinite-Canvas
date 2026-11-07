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
  let count = Math.max(1, Number(source.count) || (step?.tool === "batch_generate" ? rows || 1 : 1));
  if (spec?.batchUnknown) count = 1;
  else if (spec && Array.isArray(spec.batch) && spec.batch.length && !spec.batch.includes(count)) count = spec.batch[0];
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

function writePlanParams(step: PlanStep, params: PlanParams): PlanStep {
  const copy = JSON.parse(JSON.stringify(step || {})) as PlanStep;
  const args = (copy.args || {}) as Record<string, any>;
  if (params.scope === "settings") {
    const settings = (args.settings && typeof args.settings === "object" ? args.settings : {}) as Record<string, any>;
    settings.provider = params.provider;
    settings.model = params.model;
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
    args.provider = params.provider;
    args.model = params.model;
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
  let spec = findPlanModel(models, kind, current.provider, current.model);
  let provider = current.provider, model = current.model;
  if (patch.modelConfigId) {
    const picked = models.find((m) => m.id === patch.modelConfigId && m.kind === kind);
    if (picked) { provider = splitModelId(picked.id).provider; model = splitModelId(picked.id).model; spec = picked; }
  }
  let ratio = patch.ratio !== undefined ? patch.ratio : current.ratio;
  let resolution = patch.resolution !== undefined ? patch.resolution : current.resolution;
  let count = patch.count !== undefined ? Math.max(1, Math.round(patch.count)) : current.count;
  let duration = patch.duration !== undefined ? Math.max(1, Math.round(patch.duration)) : current.duration;
  let mode = patch.mode !== undefined ? videoModeApi(patch.mode) : current.mode;
  if (spec) {
    const ratios = kind === "image" ? imageRatioOptions(spec) : videoRatioOptions(spec);
    if (ratios.length && !ratios.includes(ratio)) ratio = ratios[0];
    if (kind === "image") {
      const sizes = imageResolutionOptions(spec);
      if (sizes.length && !sizes.includes(resolution)) resolution = sizes[0];
      // 纠正用模型声明的 batch，而不是把当前值塞回选项里（否则 4 张会带进只支持 1/2 张的模型）
      const counts = (spec.batch || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1);
      if (counts.length && !counts.includes(count)) count = counts[0];
    } else {
      const durs = durationOptions(spec, duration);
      if (durs.length && !durs.includes(duration)) duration = durs[0];
      const resList = videoResOptions(spec);
      if (resList.length && !resList.includes(resolution)) resolution = resList[0];
      const modes = videoModeOptions(spec).map((x) => x.value);
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
    const spec = findPlanModel(models, kind, params.provider, params.model);
    const label = modelLabel(spec, params.provider, params.model);
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