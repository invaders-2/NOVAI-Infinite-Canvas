/**
 * 「原图比例」：ratio 用自适应（auto），尺寸按源图长宽比 + 当前尺寸档的长边算，避免回落到 1:1。
 * 源图优先节点自己的当前结果；图片节点没有结果时取上游图片节点。拿不到尺寸时返回 null，调用方按现状兜底。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import type { GenKind } from "./model";
import { inputsOf, isGenKind, outOf } from "./model";

export type SourceBox = { url: string; w: number; h: number };

type StoreLike = { state: { doc: CanvasDoc } };

function boxFrom(url: string, w: unknown, h: unknown): SourceBox | null {
  const width = Number(w) || 0;
  const height = Number(h) || 0;
  if (!url) return null;
  return { url, w: width, h: height };
}

/** 节点自己的结果 / 上游图片结果里，第一个有 URL 的源图（尺寸可能为 0，交给调用方异步量） */
export function sourceBoxForNode(store: StoreLike, node: CanvasNode, kind: GenKind): SourceBox | null {
  if (kind === "image") {
    const own = outOf(node);
    if (own?.url) return boxFrom(own.url, own.w, own.h);
  }
  for (const ref of inputsOf(store.state.doc, node.id)) {
    const input = ref.node;
    if (!isGenKind(input.kind) || input.kind !== "image") continue;
    const out = outOf(input);
    if (out?.url) return boxFrom(out.url, out.w, out.h);
  }
  return null;
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

/** 比例展示：自适应/auto/adaptive → 原图比例，其余原样 */
export function ratioDisplayLabel(ratio: unknown): string {
  const text = String(ratio == null ? "" : ratio).trim();
  return !text || /^(自适应|自动|auto|adaptive|source)$/i.test(text) ? "原图比例" : text;
}