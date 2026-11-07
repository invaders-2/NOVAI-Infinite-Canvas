/**
 * 后端权威模型规格（GET /api/model-caps）→ ModelSpec 的 ui 字段。
 *   只做「契约字段 → 前端认的字段」的翻译，不自己编能力：
 *   - 空数组 / 缺失字段不落进 ui，让 specFor 走它自己的默认或未验证兜底；
 *   - n_max 只是批量张数上限，batch 必须按需求展开成 [1..min(n_max, 8)]；
 *   - 视频 modes 可能是接口值（text_to_video），统一翻译成 VMODES 的中文名。
 */
import { VMODES } from "./model";

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
  durations?: unknown;
  modes?: unknown;
  /** 质量档（后端能力表声明的接口值，如 low / medium / high）；没声明 = 不下发 */
  qualities?: unknown;
  /** 先思考开关（目前只有 wan2.7-image 族会声明 true）；没声明 = 不支持 */
  thinking_mode?: unknown;
  /** 输出格式（png / jpeg / webp / gif / svg）；没声明 = 后端没给这个能力 */
  output_formats?: unknown;
  /** 只返回提示词、不产视频（如 MiniMax-H3-Context-IR）：true 时面板不给视频参数 */
  prompt_only?: unknown;
  /** Midjourney 专属参数：{ versions, speeds, hd }（后端只给这几个数组） */
  mj?: unknown;
  /** 精确像素生成的模型（GPT-Image 家族）声明的像素上限：长边 / 总像素 / 最低像素 */
  max_long_edge?: unknown;
  max_pixels?: unknown;
  min_pixels?: unknown;
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

const VIDEO_MODE_BY_API = new Map(Object.entries(VMODES).map(([label, value]) => [value.api, label]));
const AUTO_RATIO = /^(auto|adaptive|自动|自适应)$/i;

/** Midjourney 规格：{ versions, speeds, hd }；缺哪个就空着，前端不猜取值 */
export function normalizeMjSpec(value: unknown): { versions: string[]; speeds: string[]; hd: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const spec = { versions: strings(row.versions), speeds: strings(row.speeds), hd: strings(row.hd) };
  return spec.versions.length || spec.speeds.length || spec.hd.length ? spec : null;
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

function resolutions(value: unknown, kind: "image" | "video"): string[] {
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
export function modelCapsUi(kind: "image" | "video", item: ModelCapsItem | null | undefined): Record<string, unknown> | null {
  if (!item || typeof item !== "object") return null;
  if (item.kind && String(item.kind) !== kind) return null;
  const ui: Record<string, unknown> = {};
  // 只出提示词的模型（Context-IR）：原样透传，面板据此隐藏视频参数
  if (item.prompt_only === true || (item as { promptOnly?: unknown }).promptOnly === true) ui.promptOnly = true;
  const mj = normalizeMjSpec(item.mj ?? (item as { midjourney?: unknown }).midjourney);
  if (mj) ui.mj = mj;
  // 字段存在但数组为空：这是后端明确说「没有」，不能把它当成缺字段再补默认值
  if (Array.isArray(item.ratios)) ui.ratios = ratios(item.ratios);
  if (kind === "image") {
    if (Array.isArray(item.resolutions)) ui.sizes = resolutions(item.resolutions, kind);
    // 后端也直接下发 sizes（如 midjourney 只声明 2K）：resolutions 为空时用它，别把尺寸档丢掉
    if (Array.isArray(item.sizes) && !((ui.sizes as string[] | undefined) || []).length) ui.sizes = strings(item.sizes).map((item) => item.toUpperCase());
    const nRaw = item.n_max;
    const hasN = nRaw !== undefined && nRaw !== null && String(nRaw).trim() !== "";
    const n = Math.floor(Number(nRaw));
    if (hasN && Number.isFinite(n) && n >= 1) {
      ui.batch = Array.from({ length: Math.min(8, n) }, (_, index) => index + 1);
    } else if (Array.isArray(item.batch) && item.batch.length) {
      // 后端直接给张数候选（如 midjourney 固定 4 张）：按它来，不走「上限未知」兜底
      const list = [...new Set(strings(item.batch).map(Number).filter((value) => Number.isFinite(value) && value >= 1 && value <= 8))].sort((a, b) => a - b);
      if (list.length) ui.batch = list; else ui.batchUnknown = true;
    } else if (Array.isArray(item.ratios) || Array.isArray(item.resolutions)) {
      // 后端说「不掌握上限」：张数只保留 1，并让面板提示未知，而不是补一个假上限
      ui.batchUnknown = true;
    }
    const maxRefs = Number(item.maxRefs ?? item.max_refs);
    if (Number.isFinite(maxRefs) && maxRefs >= 0) ui.maxRefs = Math.floor(maxRefs);
    // 质量档 / 先思考：后端声明什么就是什么（空数组 / 缺字段 = 不给入口，前端不按模型名猜）
    if (Array.isArray(item.qualities)) ui.qualities = strings(item.qualities);
    if (item.thinking_mode === true) ui.thinkingMode = true;
    // 输出格式：空数组也保留（后端明确没有动图/矢量能力），面板据此不给入口
    if (Array.isArray(item.output_formats)) ui.outputFormats = [...new Set(strings(item.output_formats).map((value) => value.toLowerCase()))];
  } else {
    if (Array.isArray(item.resolutions)) ui.res = resolutions(item.resolutions, kind);
    if (Array.isArray(item.durations)) {
      // -1 = 模型自选时长（后端 caps 的约定，如 seedance-2.5）；不能当脏值过滤掉，否则面板没有「自动」
      ui.durs = [...new Set(strings(item.durations).map(Number).filter((n) => Number.isFinite(n) && (n > 0 || n === -1)))].sort((a, b) => a - b);
    }
    if (Array.isArray(item.modes)) ui.modes = normalizeCapsModes(item.modes);
  }
  return Object.keys(ui).length ? ui : null;
}

/**
 * caps 只声明参数（比例/分辨率/张数/时长/方式），不声明参考图能力。
 * 参考图是「可选能力」，缺字段不等于不支持：沿用原有官方 ui / 按名字预设里的 maxRefs/i2i，
 * 避免一上权威参数就把所有模型的参考图入口误关掉。caps 明确给值时仍以 caps 为准。
 */
export function mergeCapsReferenceCapability(kind: "image" | "video", ui: Record<string, unknown> | null, fallback: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
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
