import { fitMediaBox } from "./mediaFit";

export type LibraryItem = {
  id: string; name: string; url: string; kind: string; categoryIds: string[];
  natural_w?: number; natural_h?: number; prompt?: string; source?: string; canvas_title?: string; folder?: string;
  /** 资产库条目才有：条目 id / 用途 / 所属产品档案（放到画布时写进节点 gen.asset） */
  assetId?: string; use?: string; productId?: string;
};
export type LibraryCategory = { id: string; name: string; count: number; kind: string };
export type LibraryData = { items: LibraryItem[]; categories: LibraryCategory[] };

const normKind = (kind: unknown): string => {
  const k = String(kind || "image");
  return ["image", "video", "audio", "prompt", "workflow"].includes(k) ? k : "image";
};

/** 把三个全局来源合并成统一素材库：按 url 去重，分类挂到 item.categoryIds。 */
export function mergeAssetSources(canvasData: any, localData: any, assetData: any, promptData: any): LibraryData {
  const items: LibraryItem[] = [];
  const byUrl = new Map<string, LibraryItem>();
  const cats = new Map<string, LibraryCategory>();
  const addCat = (id: string, name: string, kind: string): LibraryCategory => {
    if (!cats.has(id)) cats.set(id, { id, name, kind, count: 0 });
    return cats.get(id)!;
  };
  const addItem = (raw: any, categoryIds: string[]) => {
    const kind = normKind(raw.kind || raw.mediaKind);
    const url = String(raw.url || (kind === "prompt" ? "prompt:" + String(raw.id || raw.name || "item") : "")).trim();
    if (!url) return;
    const old = byUrl.get(url);
    if (old) {
      for (const id of categoryIds) if (!old.categoryIds.includes(id)) old.categoryIds.push(id);
      // 同一个文件既在画布里又在资产库里：补上资产库的条目信息
      if (raw.assetId && !old.assetId) { old.assetId = String(raw.assetId); if (raw.use) old.use = String(raw.use); if (raw.product_id) old.productId = String(raw.product_id); }
      old.natural_w = old.natural_w || Number(raw.natural_w || raw.width) || 0;
      old.natural_h = old.natural_h || Number(raw.natural_h || raw.height) || 0;
      return;
    }
    const item: LibraryItem = {
      id: String(raw.id || url), name: String(raw.name || raw.title || "素材"), url, kind, categoryIds: [...new Set(categoryIds)],
      ...(raw.assetId ? { assetId: String(raw.assetId) } : {}), ...(raw.use ? { use: String(raw.use) } : {}), ...(raw.product_id ? { productId: String(raw.product_id) } : {}),
      natural_w: Number(raw.natural_w || raw.width) || 0, natural_h: Number(raw.natural_h || raw.height) || 0,
      prompt: String(raw.prompt || ""), source: String(raw.source || ""),
      canvas_title: String(raw.canvas_title || ""), folder: String(raw.folder || ""),
    };
    byUrl.set(url, item); items.push(item);
  };

  addCat("all", "全部素材", "all");
  for (const cat of canvasData?.categories || []) addCat("canvas:" + String(cat.id || "all"), String(cat.name || "全部画布"), "canvas");
  for (const id of ["canvas:all", "canvas:smart", "canvas:classic"]) if (!cats.has(id)) addCat(id, id === "canvas:all" ? "全部画布" : id === "canvas:smart" ? "智能画布" : "普通画布", "canvas");
  for (const raw of canvasData?.items || []) {
    const kind = String(raw.canvas_kind || "classic");
    addItem(raw, ["all", "canvas:all", "canvas:" + kind]);
  }

  addCat("local:all", "本地素材", "local");
  for (const raw of localData?.items || []) {
    const folder = String(raw.folder || "未分组");
    addCat("local:" + folder, "本地 · " + folder, "local");
    addItem(raw, ["all", "local:all", "local:" + folder]);
  }

  for (const cat of assetData?.library?.categories || []) {
    const id = "asset:" + String(cat.id);
    addCat(id, String(cat.name || "资产"), "asset");
    for (const raw of cat.items || []) addItem({ ...raw, kind: raw.kind || cat.type || "image", assetId: raw.id }, ["all", id]);
  }

  let promptCount = 0;
  for (const lib of promptData?.library?.libraries || []) for (const raw of lib.items || []) {
    promptCount++;
    addItem({ id: raw.id, name: raw.name || "提示词", kind: "prompt", prompt: raw.positive || "" }, ["all", "prompt:all"]);
  }
  addCat("prompt:all", "提示词", "prompt");

  for (const item of items) for (const id of item.categoryIds) {
    const c = cats.get(id); if (c) c.count++;
  }
  cats.get("all")!.count = items.length;
  return { items, categories: [...cats.values()].filter((c) => c.count > 0 || c.kind === "asset") };
}

export function filterLibraryItems(items: LibraryItem[], active: string, query: string): LibraryItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (active !== "all" && !it.categoryIds?.includes(active)) return false;
    return !q || [it.name, it.prompt, it.canvas_title].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

export function libraryNodeBox(naturalW: unknown, naturalH: unknown, kind: string): { w: number; h: number } {
  const w = Number(naturalW) || 0, h = Number(naturalH) || 0;
  const fallback = kind === "video" ? { w: 16, h: 9 } : { w: 4, h: 3 };
  return fitMediaBox(320, w || fallback.w, h || fallback.h) || { w: 320, h: 240 };
}
