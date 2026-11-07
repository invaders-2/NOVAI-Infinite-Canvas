/**
 * 工作流文件（JSON / 含资源 ZIP）的纯逻辑：选中切片、媒体 URL 收集去重、
 * 资源清单（manifest）生成与解析、导入时的旧地址 → 新地址映射。
 *
 * 放在这里而不是组件里，是为了能在 node 单测里直接跑真实逻辑（不碰 DOM / 后端）。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { mapDocStrings } from "../canvasAssetRefs";

/** ZIP 里的固定文件名：导入时按它们找文档和资源清单 */
export const WORKFLOW_JSON = "workflow.json";
export const MANIFEST_JSON = "manifest.json";
export const ASSET_SCHEMA = "novai.canvas-workflow-assets/v1";

export type MediaKind = "image" | "video" | "audio";
export type MediaRef = { url: string; name: string; kind: MediaKind; ext: string; nodeIds: string[] };
export type WorkflowAsset = { url: string; file: string; name: string; kind: string };
export type WorkflowManifest = { schema: string; workflow: string; assets: WorkflowAsset[] };
export type WorkflowSlice = { doc: CanvasDoc; selected: boolean; nodeCount: number; edgeCount: number };

const MEDIA_KINDS: MediaKind[] = ["image", "video", "audio"];
const DEFAULT_EXT: Record<MediaKind, string> = { image: "png", video: "mp4", audio: "mp3" };
const KNOWN_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "webm", "avif", "bmp", "mp4", "mov", "webm", "mkv", "m4v", "mp3", "wav", "m4a", "aac", "ogg", "flac"]);
const TYPE_LABEL: Record<MediaKind, string> = { image: "图片", video: "视频", audio: "音频" };

const dataOf = (node: CanvasNode): { gen?: { title?: string; hist?: Array<{ url?: string; frame?: string }>; hi?: number } } =>
  node.data && typeof node.data === "object" ? node.data as { gen?: { title?: string; hist?: Array<{ url?: string; frame?: string }>; hi?: number } } : {};

/** 节点当前结果：优先 outOf 的 url / frame，退化到通用字段 node.url（旧画布） */
export function currentMediaUrl(node: CanvasNode): string {
  const gen = dataOf(node).gen;
  const hist = gen?.hist || [];
  const out = hist[Math.min(Math.max(0, Number(gen?.hi) || 0), Math.max(0, hist.length - 1))];
  return [out?.url, out?.frame, node.url].find((value): value is string => typeof value === "string" && !!value.trim()) || "";
}

function nameOf(node: CanvasNode): string {
  const title = dataOf(node).gen?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  return (node.text || "").trim() || TYPE_LABEL[node.kind as MediaKind] || "节点";
}

function extOf(url: string, kind: MediaKind): string {
  const match = /\.([A-Za-z0-9]{1,5})(?:[?#].*)?$/.exec(url);
  const ext = match ? match[1].toLowerCase() : "";
  return KNOWN_EXT.has(ext) ? ext : DEFAULT_EXT[kind];
}

/**
 * 导出用的切片：有选中就只取选中节点和它们之间的连线；没有选中则整张画布（保留旧能力）。
 * 选中切片不复制评论：评论是按画布坐标放的，跟着节点导入会错位。
 */
export function sliceWorkflowDoc(doc: CanvasDoc, selectedIds?: Iterable<string> | null): WorkflowSlice {
  const all = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];
  const known = new Set(all.map((node) => node.id));
  const picked = new Set<string>();
  if (selectedIds) for (const id of selectedIds) if (known.has(id)) picked.add(id);
  if (!picked.size) return { doc, selected: false, nodeCount: all.length, edgeCount: edges.length };
  const nodes = all.filter((node) => picked.has(node.id));
  const inner = edges.filter((edge) => picked.has(edge.from) && picked.has(edge.to));
  return { doc: { nodes, edges: inner, comments: [] }, selected: true, nodeCount: nodes.length, edgeCount: inner.length };
}

/** 媒体节点当前结果地址，按地址去重（同一张图被多个节点引用只打包一次） */
export function collectMediaRefs(doc: CanvasDoc): MediaRef[] {
  const refs: MediaRef[] = [];
  const byUrl = new Map<string, MediaRef>();
  for (const node of Array.isArray(doc?.nodes) ? doc.nodes : []) {
    if (!MEDIA_KINDS.includes(node.kind as MediaKind)) continue;
    const url = currentMediaUrl(node);
    if (!url) continue;
    const seen = byUrl.get(url);
    if (seen) { if (!seen.nodeIds.includes(node.id)) seen.nodeIds.push(node.id); continue; }
    const kind = node.kind as MediaKind;
    const ref: MediaRef = { url, name: nameOf(node), kind, ext: extOf(url, kind), nodeIds: [node.id] };
    byUrl.set(url, ref); refs.push(ref);
  }
  return refs;
}

/** 文件夹 / 文件名里的危险字符换成 -，保留中文；空名字给 asset */
export function safeAssetPart(name: string): string {
  return (name || "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
}

/** ZIP 内资源路径：assets/001-节点标题.png（序号保证同名不冲突） */
export function assetFileName(index: number, name: string, ext: string): string {
  const clean = (ext || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  return `assets/${String(index + 1).padStart(3, "0")}-${safeAssetPart(name)}.${clean}`;
}

export function buildAssetManifest(assets: WorkflowAsset[]): WorkflowManifest {
  return {
    schema: ASSET_SCHEMA,
    workflow: WORKFLOW_JSON,
    assets: assets.map((asset) => ({ url: asset.url, file: asset.file, name: asset.name, kind: asset.kind })),
  };
}

/** 解析资源清单；缺字段的条目跳过，不是合法 JSON 时给出可读错误 */
export function parseAssetManifest(text: string): WorkflowManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("资源清单不是有效的 JSON"); }
  const box = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = Array.isArray(box.assets) ? box.assets : [];
  const assets = list.flatMap((item): WorkflowAsset[] => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const url = typeof row?.url === "string" ? row.url : "";
    const file = typeof row?.file === "string" ? row.file : "";
    if (!url || !file) return [];
    return [{ url, file, name: typeof row?.name === "string" ? row.name : "工作流资源", kind: typeof row?.kind === "string" ? row.kind : "image" }];
  });
  return {
    schema: typeof box.schema === "string" ? box.schema : ASSET_SCHEMA,
    workflow: typeof box.workflow === "string" ? box.workflow : WORKFLOW_JSON,
    assets,
  };
}

/** ZIP 条目名查表：去前导 ./、统一斜杠与大小写（自己打的包和手工压缩的包都能认） */
export function zipEntryKey(name: string): string {
  return String(name || "").replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

/**
 * 导入时把文档里的旧资源地址换成新地址：先整串命中，再按子串替换
 * （地址可能嵌在提示词 / markdown 里）；长地址优先，避免前缀相同的地址互相覆盖。
 */
export function mapWorkflowUrls(doc: CanvasDoc, mapping: Map<string, string> | Record<string, string>): CanvasDoc {
  const pairs = (mapping instanceof Map ? [...mapping.entries()] : Object.entries(mapping))
    .filter(([from, to]) => !!from && typeof to === "string" && !!to && to !== from)
    .sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return doc;
  const clone = JSON.parse(JSON.stringify(doc)) as CanvasDoc;
  return mapDocStrings(clone, (value) => {
    let next = value;
    for (const [from, to] of pairs) if (next.includes(from)) next = next.split(from).join(to);
    return next;
  });
}
