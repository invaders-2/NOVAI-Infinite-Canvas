/**
 * 全屏查看里的「对比原图」：算出「原图」和「当前」两张图。纯逻辑，node 可直接单测。
 *
 * 原图 = 这张图被「生成」之前的那张：来源节点（点「生成」的那个节点的当前结果）→ 其它上游输入图
 * → 最后才退回历史第一版。视频 / 音频 / 提示词没有可比的原图（返回 null，全屏里不显示这个按钮）。
 */

export type CmpVersion = { url?: string; frame?: string };
export type CmpSource = { kind: string; hist: CmpVersion[]; hi: number; inputs?: Array<string | undefined>; source?: string };
export type CompareResult = { original: string; current: string; from: "source" | "input" | "version" };

const urlOf = (v?: CmpVersion) => String(v?.url || v?.frame || "");

export function compareOriginal(src: CmpSource): CompareResult | null {
  if (src.kind !== "image") return null;
  const current = urlOf(src.hist[src.hi]);
  if (!current) return null;
  const hit = (original: string, from: CompareResult["from"]): CompareResult => ({ original, current, from });
  // 生成前的图：新节点上记着 sourceNodeId（点生成的那个节点），它的当前结果才是「生成前」
  const source = String(src.source || "");
  if (source && source !== current) return hit(source, "source");
  const input = (src.inputs || []).map((u) => String(u || "")).find((u) => !!u && u !== current);
  if (input) return hit(input, "input");
  // 只连着文本这类没有图的上游时才退回第一版（多版本节点的兜底）
  const first = urlOf(src.hist[0]);
  if (src.hist.length > 1 && first && first !== current) return hit(first, "version");
  return null;
}
