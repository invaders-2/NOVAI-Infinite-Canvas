import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import type { AnyParams } from "./model";

export type PersonalTemplate = {
  id: string;
  title: string;
  prompt: string;
  updatedAt: number;
  doc: CanvasDoc;
  coverDataUrl?: string;
};

type Command = (request: Record<string, unknown>) => Promise<Record<string, any>>;
const command = (): Command | null => {
  const api = (window as unknown as { openarc?: { canvas?: { command?: Command } } }).openarc?.canvas;
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
      return doc ? [{ id: String(item.id), title: String(item.title || "未命名模板"), prompt: String(item.prompt || ""), updatedAt: Number(item.updatedAt || item.createdAt || 0), doc }] : [];
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
      return [{ ...node, text: table.title || "多维表格", data: { table: { title: table.title || "多维表格", columns: Array.isArray(table.columns) ? table.columns : [], rows: Array.isArray(table.rows) ? table.rows : [] } } }];
    }
    if (!["text", "image", "video", "audio"].includes(node.kind)) return [];
    const data = node.data && typeof node.data === "object" ? node.data as { gen?: { title?: string; prompt?: string; params?: AnyParams; hist?: Array<{ text?: string }>; hi?: number } } : {};
    const gen = data.gen || {};
    const current = gen.hist?.[gen.hi || 0];
    return [{
      ...node,
      data: { gen: {
        title: gen.title || node.text || "", prompt: gen.prompt || "", ...(gen.params ? { params: gen.params } : {}),
        ...(node.kind === "text" && current?.text ? { hist: [{ text: current.text }], hi: 0 } : {}),
      } },
    }];
  });
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: doc.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), comments: Array.isArray(doc.comments) ? doc.comments : [] };
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
