/**
 * 分享画布的媒体本地化（T52）：克隆 / 保存模板前把远端图片、视频、音频复制到本机。
 * 纯逻辑（收集 / 重写）可直接单测；localizeDocMedia 走本机后端 /api/canvas-share/localize-media。
 */
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";

export type MediaStats = { copied: number; failed: number; skipped: number };
export type LocalizeDocResult = MediaStats & { doc: CanvasDoc; error: string };

const MEDIA_STRING_KEYS = ["url", "originalUrl", "refUrl", "frame"];

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** 去掉 token 参数后的稳定 key：同一资源换一次口令仍算同一个。 */
export function canonicalMediaUrl(url: unknown): string {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) return "";
  try {
    const parsed = new URL(text);
    parsed.searchParams.delete("token");
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return text;
  }
}

function collectFrom(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFrom(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (MEDIA_STRING_KEYS.includes(key) && isHttpUrl(item)) out.push(item.trim());
    else if (key === "variants" && Array.isArray(item)) {
      for (const entry of item) if (isHttpUrl(entry)) out.push(entry.trim());
    } else collectFrom(item, out);
  }
}

/** 节点里真正需要本地化的远端媒体地址（去重，保持出现顺序；不碰提示词文本）。 */
export function mediaUrlsOf(doc: CanvasDoc | null | undefined): string[] {
  const found: string[] = [];
  collectFrom(doc?.nodes || [], found);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of found) {
    const canonical = canonicalMediaUrl(url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(url);
  }
  return unique;
}

function rewriteFrom(value: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteFrom(item, mapping));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (MEDIA_STRING_KEYS.includes(key) && typeof item === "string") {
      out[key] = mapping.get(canonicalMediaUrl(item)) || item;
    } else if (key === "variants" && Array.isArray(item)) {
      out[key] = item.map((entry) => typeof entry === "string" ? (mapping.get(canonicalMediaUrl(entry)) || entry) : entry);
    } else out[key] = rewriteFrom(item, mapping);
  }
  return out;
}

/** 用「原地址 → 本机地址」映射重写 doc 里的媒体字段；返回新对象，不改入参。 */
export function rewriteDocMedia(doc: CanvasDoc, mapping: Map<string, string>): CanvasDoc {
  if (!mapping.size) return doc;
  return { ...doc, nodes: rewriteFrom(doc.nodes, mapping) as CanvasDoc["nodes"] };
}

/** 给 media 统计拼一句人话（toast / note 共用） */
export function mediaStatsText(stats: Partial<MediaStats> | null | undefined, prefix = "复制"): string {
  const copied = Math.max(0, Number(stats?.copied) || 0);
  const failed = Math.max(0, Number(stats?.failed) || 0);
  if (!copied && !failed) return "";
  const head = prefix + " " + copied + " 个资源";
  return failed ? head + "，" + failed + " 个失败（保留原地址）" : head;
}

/**
 * 把 doc 里的远端媒体取到本机并改成本机地址。
 * shareUrl：原始分享链接（用于后端带上对方的局域网口令）；本机/裸令牌时传空串。
 */
export async function localizeDocMedia(doc: CanvasDoc | null | undefined, shareUrl = ""): Promise<LocalizeDocResult> {
  const empty = { copied: 0, failed: 0, skipped: 0, error: "" };
  if (!doc) return { ...empty, doc: { nodes: [], edges: [], comments: [] } };
  const urls = mediaUrlsOf(doc);
  if (!urls.length) return { ...empty, doc };
  let response: Response;
  try {
    response = await fetch("/api/canvas-share/localize-media", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ urls, share_url: shareUrl || "" }),
    });
  } catch {
    return { ...empty, failed: urls.length, doc, error: "本机后端没在运行，媒体没有复制" };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : "";
    return { ...empty, failed: urls.length, doc, error: detail || "媒体复制失败（HTTP " + response.status + "）" };
  }
  const items = Array.isArray(data?.items) ? data.items as Array<Record<string, unknown>> : [];
  const mapping = new Map<string, string>();
  for (const item of items) {
    const from = canonicalMediaUrl(item?.url);
    const local = typeof item?.local === "string" ? item.local : "";
    if (from && local && item?.ok !== false) mapping.set(from, local);
  }
  return {
    doc: rewriteDocMedia(doc, mapping),
    copied: Math.max(0, Number(data?.copied) || 0),
    failed: Math.max(0, Number(data?.failed) || 0),
    skipped: Math.max(0, Number(data?.skipped) || 0),
    error: "",
  };
}
