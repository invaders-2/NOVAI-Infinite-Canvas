import { hostRoot } from "../../novaiBridgeRoot";
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { cloneParams, type AnyParams } from "./model";

export type PersonalTemplate = {
  id: string;
  title: string;
  prompt: string;
  updatedAt: number;
  doc: CanvasDoc;
  coverDataUrl?: string;
  /** 从 doc 里已生成的结果推导出的封面（读取时算，保存时的截图只是兜底） */
  cover?: string;
};

type Command = (request: Record<string, unknown>) => Promise<Record<string, any>>;
const command = (): Command | null => {
  const api = hostRoot<{ canvas?: { command?: Command } }>()?.canvas;
  return api && typeof api.command === "function" ? api.command : null;
};

function docOf(value: unknown): CanvasDoc | null {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const source = raw?.doc && typeof raw.doc === "object" ? raw.doc as Record<string, unknown> : raw;
  const nodes = Array.isArray(source?.nodes) ? source.nodes.filter((n) => n && typeof n === "object") : [];
  const edges = Array.isArray(source?.edges) ? source.edges.filter((e) => e && typeof e === "object") : [];
  const comments = Array.isArray(source?.comments) ? source.comments.filter((comment) => comment && typeof comment === "object") : [];
  return nodes.length ? { nodes, edges, comments } as CanvasDoc : null;
}

export async function loadPersonalTemplates(): Promise<{ items: PersonalTemplate[]; libraryId: string; error?: string }> {
  const cmd = command();
  if (!cmd) return { items: [], libraryId: "", error: "个人模板需要桌面资产库" };
  try {
    const ensured = await cmd({ type: "canvas/assetLibrary/ensure" });
    const libraryId = String(ensured?.library?.id || "");
    if (!ensured?.ok || !libraryId) return { items: [], libraryId: "", error: String(ensured?.error || "无法创建个人资产库") };
    const got = await cmd({ type: "canvas/assetLibrary/get", libraryId });
    if (!got?.ok) return { items: [], libraryId, error: String(got?.error || "读取个人模板失败") };
    const items = (Array.isArray(got.items) ? got.items : []).flatMap((item: Record<string, any>) => {
      if (item.kind !== "workflow") return [];
      const doc = docOf(item.workflow);
      if (!doc) return [];
      // 优先结果图（读 doc 推导），后端若真的存了封面再兜底
      const stored = String(item.cover || item.thumbnail || item.coverDataUrl || "");
      return [{ id: String(item.id), title: String(item.title || "未命名模板"), prompt: String(item.prompt || ""), updatedAt: Number(item.updatedAt || item.createdAt || 0), doc, cover: templateCover(doc) || stored || undefined, ...(stored ? { coverDataUrl: stored } : {}) }];
    });
    return { items, libraryId };
  } catch (error) {
    return { items: [], libraryId: "", error: error instanceof Error ? error.message : "读取个人模板失败" };
  }
}

export function templateDocument(doc: CanvasDoc): CanvasDoc {
  const nodes = doc.nodes.flatMap((node): CanvasNode[] => {
    if (node.kind === "table") {
      const data = node.data && typeof node.data === "object" ? node.data as { table?: { title?: string; columns?: string[]; rows?: string[][] } } : {};
      const table = data.table || { title: node.text || "多维表格", columns: ["字段 1"], rows: [["", ""]] };
      const tableTitle = table.title || node.text || "多维表格";
      return [{ ...node, title: (node as { title?: string }).title || tableTitle, text: tableTitle, data: { table: { title: tableTitle, columns: Array.isArray(table.columns) ? table.columns : [], rows: Array.isArray(table.rows) ? table.rows : [] } } } as unknown as CanvasNode];
    }
    if (!["text", "image", "video", "audio"].includes(node.kind)) return [];
    const data = node.data && typeof node.data === "object" ? node.data as { gen?: { title?: string; prompt?: string; params?: AnyParams; hist?: Array<{ text?: string; url?: string; frame?: string }>; hi?: number } } : {};
    const gen = data.gen || {};
    const current = gen.hist?.[gen.hi || 0];
    // 卡片封面：模板存一份「当前结果是哪张图」，读取时不用再猜（视频优先用首帧）
    const cover = current ? (current.frame || current.url || "") : "";
    // 顶层 title 是铺模板时 createFromTemplate 认的字段；没有它 3 个节点会全变成模板名
    const nodeTitle = (gen.title || node.text || "").trim() || ({ text: "文本", image: "图片", video: "视频", audio: "音频" } as Record<string, string>)[node.kind] || "节点";
    return [{
      ...node,
      title: nodeTitle,
      ...(cover ? { cover } : {}),
      data: { gen: {
        title: nodeTitle, prompt: gen.prompt || "", ...(gen.params ? { params: cloneParams(gen.params) } : {}),
        ...(node.kind === "text" && current?.text ? { hist: [{ text: current.text }], hi: 0 } : {}),
      } },
    } as unknown as CanvasNode];
  });
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: doc.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), comments: Array.isArray(doc.comments) ? doc.comments : [] };
}

/** 从模板 doc 里取「已生成结果」作为封面：先看保存时写在节点上的 cover，再看 gen.hist[hi]（视频优先首帧） */
export function templateCover(doc: CanvasDoc): string {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const urlOf = (n: CanvasNode): string => {
    const saved = (n as unknown as { cover?: unknown }).cover;
    if (typeof saved === "string" && saved) return saved;
    const data = n.data && typeof n.data === "object" ? n.data as { gen?: { hist?: Array<{ url?: string; frame?: string }>; hi?: number } } : {};
    const o = data.gen?.hist?.[data.gen?.hi || 0];
    return o ? (o.frame || o.url || "") : "";
  };
  const media = nodes.filter((n) => n.kind === "image" || n.kind === "video");
  for (const n of media) { const url = urlOf(n); if (url) return url; }
  for (const n of nodes) { const url = urlOf(n); if (url) return url; }
  return "";
}

export async function savePersonalTemplate(input: { libraryId?: string; id?: string; title: string; prompt: string; doc: CanvasDoc; coverDataUrl?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const cmd = command();
  if (!cmd) return { ok: false, error: "个人模板需要桌面资产库" };
  let libraryId = input.libraryId || "";
  if (!libraryId) {
    const loaded = await loadPersonalTemplates();
    if (!loaded.libraryId) return { ok: false, error: loaded.error };
    libraryId = loaded.libraryId;
  }
  const result = await cmd({ type: "canvas/assetLibrary/upsert", libraryId, item: { id: input.id, kind: "workflow", title: input.title.trim(), prompt: input.prompt.trim(), workflow: { schema: "openarc.canvas-template/v1", doc: templateDocument(input.doc) }, coverDataUrl: input.coverDataUrl } }).catch((error) => ({ error: String(error) })) as Record<string, any>;
  return result?.ok && result.item?.id ? { ok: true, id: String(result.item.id) } : { ok: false, error: String(result?.error || "保存个人模板失败") };
}

export async function deletePersonalTemplate(libraryId: string, id: string): Promise<boolean> {
  const cmd = command();
  if (!cmd) return false;
  const result = await cmd({ type: "canvas/assetLibrary/delete", libraryId, itemId: id }).catch(() => null);
  return result?.ok === true;
}

export function workflowDocument(doc: CanvasDoc): CanvasDoc {
  const nodes = doc.nodes.map((node) => ({ ...node }));
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: doc.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => ({ ...edge })), comments: Array.isArray(doc.comments) ? doc.comments.map((comment) => ({ ...comment })) : [], ...(doc.settings ? { settings: doc.settings } : {}) };
}

export function workflowFileContents(title: string, doc: CanvasDoc): string {
  return JSON.stringify({ schema: "novai.canvas-workflow/v1", title: title.trim() || "未命名工作流", doc: workflowDocument(doc) }, null, 2);
}

export function cloneWorkflowForImport(doc: CanvasDoc, center: { x: number; y: number }, mkId: (prefix: string) => string): { nodes: CanvasNode[]; edges: CanvasDoc["edges"] } {
  const minX = Math.min(...doc.nodes.map((node) => node.x)), maxX = Math.max(...doc.nodes.map((node) => node.x + node.w));
  const minY = Math.min(...doc.nodes.map((node) => node.y)), maxY = Math.max(...doc.nodes.map((node) => node.y + node.h));
  const ox = Math.round(center.x - (minX + maxX) / 2), oy = Math.round(center.y - (minY + maxY) / 2);
  const idOf = new Map(doc.nodes.map((node) => [node.id, mkId("n")]));
  const remapPrompt = (text: string) => text.replace(/@\{([A-Za-z0-9_-]+)(#[^}\n]{1,40})?\}/g, (raw, id: string, section?: string) => idOf.has(id) ? "@{" + idOf.get(id) + (section || "") + "}" : raw);
  const nodes = doc.nodes.map((node) => {
    const data = node.data && typeof node.data === "object" ? { ...node.data } as Record<string, any> : undefined;
    const gen = data && "gen" in data ? data.gen as { prompt?: unknown; params?: AnyParams } | undefined : undefined;
    const table = data && "table" in data ? data.table as { sourceId?: unknown } | undefined : undefined;
    if (data && gen) data.gen = { ...gen, ...(gen.params ? { params: cloneParams(gen.params as AnyParams) } : {}), prompt: remapPrompt(String(gen.prompt || "")) };
    if (data && table?.sourceId) data.table = { ...table, sourceId: idOf.get(String(table.sourceId)) || table.sourceId };
    // 成员没一起导出（旧文件 / 只导了容器）时丢掉悬空引用：留一串不存在的 id，堆叠会显示「堆叠 4」却没有封面
    const children = node.children ? node.children.map((id) => idOf.get(id)).filter((id): id is string => !!id) : null;
    return { ...node, id: idOf.get(node.id)!, x: node.x + ox, y: node.y + oy, ...(children ? { children } : {}), ...(data ? { data } : {}) };
  });
  const edges = doc.edges.flatMap((edge) => {
    const from = idOf.get(edge.from), to = idOf.get(edge.to);
    return from && to ? [{ ...edge, id: mkId("e"), from, to }] : [];
  });
  return { nodes, edges };
}

export function parseWorkflowFile(text: string): { title: string; doc: CanvasDoc } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("文件不是有效的 JSON 工作流"); }
  const box = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const doc = docOf(box?.doc || raw);
  if (!doc) throw new Error("工作流里没有可导入的节点");
  return { title: String(box?.title || box?.name || "导入的工作流"), doc };
}
