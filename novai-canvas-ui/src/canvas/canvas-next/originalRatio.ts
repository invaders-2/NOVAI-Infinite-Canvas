/**
 * 「原图比例」：ratio 用自适应（auto），尺寸按源图长宽比 + 当前尺寸档的长边算，避免回落到 1:1。
 * 源图优先节点自己的当前结果；图片节点没有结果时取上游图片节点。拿不到尺寸时返回 null，调用方按现状兜底。
 * 空状态节点（还没有结果）要在生成前 / 生成中就按源图比例摆正，比例取值也从这里取（wantedRatio）。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import type { GenKind } from "./model";
import { genOf, inputsOf, isGenKind, outOf } from "./model";
import { isAdaptiveRatio, ratioOf, sizeRatioOf } from "./mediaFit";

export type SourceBox = { url: string; w: number; h: number };

/** 生成参数里和「比例」有关的两项：面板选的 ratio，以及原图比例写下的显式 WxH 备忘 */
export type RatioParams = { ratio?: string; sourceSize?: string };

type StoreLike = { state: { doc: CanvasDoc } };

function boxFrom(url: string, w: unknown, h: unknown): SourceBox | null {
  const width = Number(w) || 0;
  const height = Number(h) || 0;
  if (!url) return null;
  return { url, w: width, h: height };
}

/** 节点自己的结果 / 上游图片结果里，第一个有 URL 的源图（尺寸可能为 0，交给调用方异步量） */
export function sourceBoxInDoc(doc: CanvasDoc, node: CanvasNode, kind: GenKind): SourceBox | null {
  if (kind === "image") {
    const own = outOf(node);
    if (own?.url) return boxFrom(own.url, own.w, own.h);
  }
  for (const ref of inputsOf(doc, node.id)) {
    const input = ref.node;
    if (!isGenKind(input.kind) || input.kind !== "image") continue;
    const out = outOf(input);
    if (out?.url) return boxFrom(out.url, out.w, out.h);
  }
  return null;
}

export function sourceBoxForNode(store: StoreLike, node: CanvasNode, kind: GenKind): SourceBox | null {
  return sourceBoxInDoc(store.state.doc, node, kind);
}

/**
 * 节点这次要用的比例：显式比例（16:9）优先；原图比例先看面板写下的 params.sourceSize，
 * 再退到源图真实像素（上游图片的结果 / 节点自己的结果）。都拿不到 → null，调用方保持原尺寸。
 * 第三个来源（源图）会随文档变，所以只用于「现在该用多少」，不能拿来判断「上次摆成多少」。
 */
export function wantedRatio(doc: CanvasDoc, node: CanvasNode, kind: GenKind, params?: unknown): number | null {
  const p = (params && typeof params === "object" ? params : genOf(node).params) as RatioParams;
  const explicit = ratioOf(p.ratio);
  if (explicit) return explicit;
  if (!isAdaptiveRatio(p.ratio)) return null;
  const size = sizeRatioOf(p.sourceSize);
  if (size) return size;
  const box = sourceBoxInDoc(doc, node, kind);
  return box && box.w > 0 && box.h > 0 ? box.w / box.h : null;
}

/** 参数里「已经写着」的比例：显式比例 / 原图比例的 WxH 备忘（不含源图回退，回退不代表上次摆成什么样） */
export function declaredRatio(params: unknown): number | null {
  const p = (params || {}) as RatioParams;
  const explicit = ratioOf(p.ratio);
  if (explicit) return explicit;
  return isAdaptiveRatio(p.ratio) ? sizeRatioOf(p.sourceSize) : null;
}

export const SOURCE_TIER_LONG: Record<string, number> = { "1K": 1024, "2K": 2048, "3K": 3072, "4K": 4096 };

/** 按源图比例 + 尺寸档长边算显式 WxH（2K 横图 800×600 → 2048×1536） */
export function sourceSizeForTier(source: SourceBox | null | undefined, tier: string): string {
  const w = Number(source?.w) || 0;
  const h = Number(source?.h) || 0;
  if (!source || w <= 0 || h <= 0) return "";
  const key = String(tier || "1K").toUpperCase();
  const long = SOURCE_TIER_LONG[key] || SOURCE_TIER_LONG["1K"];
  const width = w >= h ? long : Math.round((long * w) / h);
  const height = w >= h ? Math.round((long * h) / w) : long;
  return Math.max(1, width) + "x" + Math.max(1, height);
}

/** 批量一行里第一张图（row.media 里 kind=image 的第一张，带像素尺寸）→ 按尺寸档算显式 WxH；没图返回 fallback */
export type BatchMediaLike = { kind?: string; url?: string; src?: string; w?: unknown; h?: unknown };
export function batchSourceSize(media: BatchMediaLike[], tier: string, fallbackSize = ""): string {
  const first = (media || []).find((item) => String(item?.kind || "image") === "image" && (item?.url || item?.src));
  if (!first) return fallbackSize;
  const size = sourceSizeForTier({ url: String(first.url || first.src || ""), w: Number(first.w) || 0, h: Number(first.h) || 0 }, tier);
  return size || fallbackSize;
}

/** 比例展示：自适应/auto/adaptive → 原图比例，其余原样 */
export function ratioDisplayLabel(ratio: unknown): string {
  const text = String(ratio == null ? "" : ratio).trim();
  return !text || /^(自适应|自动|auto|adaptive|source)$/i.test(text) ? "原图比例" : text;
}