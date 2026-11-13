/**
 * 画布助手联网搜图 / 反图（契约：docs/agent-web-image-search.md 第 4、5 节）。
 *
 * 这里只做三件事：
 *   1. 把工具事件里的 safePayload.result 解析成参考图选择卡的数据（快照与总线事件同构）；
 *   2. 面板直调的接口：导入原图 / 以图搜图 / 读联网开关；
 *   3. 把导入成功的本地图落成 image 节点（复用 store.newNode + store.addNodes）。
 * 失败一律带真实原因抛出来：不拿 thumb_url、不拿占位图兜底。
 */
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { fitSourceBox } from "../mediaFit";
import type { CanvasStore } from "../store";

/** 契约里的 ImageItem（字段名不改） */
export type WebImageItem = {
  id: string;
  title: string;
  original_url: string;
  thumb_url: string;
  width: number | null;
  height: number | null;
  source_page: string;
  source_site: string;
  /** 多来源：bing / 360 / huaban / zcool / nipic / duitang / tuchong；旧数据为空串 */
  source_kind: string;
};

/** search_images / find_similar_images / reverse 的返回体 */
export type WebImageResult = {
  engine: string;
  query: string;
  queries: string[];
  description: string;
  note: string;
  /** 契约增量：{"huaban": 12, "bing": 6}，前端据此做来源筛选；旧数据为空对象 */
  sources: Record<string, number>;
  items: WebImageItem[];
};

export type WebImageCardStatus = "ready" | "loading" | "failed" | "web-off";

/** 面板里的一张「参考图选择卡」 */
export type WebImageCardData = {
  key: string;
  kind: "search" | "similar";
  status: WebImageCardStatus;
  query: string;
  queries: string[];
  description: string;
  note: string;
  /** 来源 -> 数量（后端 sources 原样；旧数据为空对象） */
  sources: Record<string, number>;
  items: WebImageItem[];
  /** 整次工具 / 接口失败的真实原因（空串表示没有失败） */
  error: string;
};

export type ImportedWebImage = {
  source_url: string;
  ok: boolean;
  url: string;
  width: number | null;
  height: number | null;
  bytes: number;
  error: string;
};

export type InsertWebImage = { url: string; title: string; width: number | null; height: number | null };

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function itemOf(raw: unknown, index: number): WebImageItem | null {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const original = text(row.original_url).trim();
  if (!original) return null;
  return {
    id: text(row.id).trim() || "img_" + index + "_" + original,
    title: text(row.title).trim(),
    original_url: original,
    thumb_url: text(row.thumb_url).trim(),
    width: positive(row.width),
    height: positive(row.height),
    source_page: text(row.source_page).trim(),
    source_site: text(row.source_site).trim(),
    source_kind: text(row.source_kind).trim(),
  };
}

/** sources: {kind: count}；坏值（负数 / 非数字）直接丢掉，不编数量 */
function readSources(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [rawKind, rawCount] of Object.entries(value as Record<string, unknown>)) {
    const kind = String(rawKind || "").trim();
    const count = Number(rawCount);
    if (kind && Number.isFinite(count) && count >= 0) out[kind] = Math.round(count);
  }
  return out;
}

/** 工具返回体 → 结构化结果；items 只保留有原图直链的条目（没有原图直链的条目在面板里没有意义） */
export function readWebImageResult(value: unknown): WebImageResult {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const raw = Array.isArray(row.items) ? row.items : [];
  const items = raw.map(itemOf).filter((item): item is WebImageItem => !!item);
  return {
    engine: text(row.engine),
    query: text(row.query),
    queries: (Array.isArray(row.queries) ? row.queries : []).map(text).filter(Boolean),
    description: text(row.description),
    note: text(row.note),
    sources: readSources(row.sources),
    items,
  };
}

const WEB_IMAGE_TOOLS = new Set(["search_images", "find_similar_images"]);
/** 关闭联网时后端给的中文原因（HTTP 403 / code=web_access_disabled）；snapshot 目前不带 code，两种都认 */
export const isWebAccessDisabled = (value: string) => /web_access_disabled|联网功能未开启|联网未开启/.test(value);

/**
 * 从任务快照里取出搜图 / 反图工具的结果，按调用顺序各生成一张卡。
 * 只认 web_access_disabled 之后仍是当前工具的事件：失败事件也进来（面板要显示「那次失败的真实原因」）。
 */
export function webImageCards(snapshot: { events?: Array<Record<string, unknown>> }): WebImageCardData[] {
  const cards: WebImageCardData[] = [];
  const seen = new Set<string>();
  for (const event of snapshot.events || []) {
    const type = text(event.eventType);
    const payload = (event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {}) as Record<string, unknown>;
    const tool = text(payload.toolId) || text(payload.name);
    if (!WEB_IMAGE_TOOLS.has(tool)) continue;
    const failed = /failed|denied|blocked|denied/.test(type);
    const succeeded = /succeeded/.test(type);
    if (!failed && !succeeded) continue;
    const key = text(payload.callId) || text(event.eventId) || tool + ":" + cards.length;
    if (seen.has(key)) continue;
    seen.add(key);
    const base: WebImageCardData = {
      key,
      kind: tool === "find_similar_images" ? "similar" : "search",
      status: "ready",
      query: "",
      queries: [],
      description: "",
      note: "",
      sources: {},
      items: [],
      error: "",
    };
    if (failed) {
      const payloadError = text(payload.error);
      const code = text(payload.code);
      const reason = payloadError || code || "搜图工具执行失败（服务端没有给出原因）";
      cards.push({ ...base, status: isWebAccessDisabled(reason) || code === "web_access_disabled" ? "web-off" : "failed", error: reason });
      continue;
    }
    const result = readWebImageResult(payload.result);
    cards.push({ ...base, query: result.query, queries: result.queries, description: result.description, note: result.note, sources: result.sources, items: result.items });
  }
  return cards;
}

function errorOf(data: unknown, status: number): string {
  const row = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const detail = row.detail ?? row.error ?? row.message;
  const direct = text(detail).trim();
  if (direct) return direct;
  if (detail && typeof detail === "object") {
    const inner = text(detail.message).trim() || text(detail.error).trim();
    if (inner) return inner;
    try { return JSON.stringify(detail); } catch { return "HTTP " + status; }
  }
  return "请求失败（HTTP " + status + "）";
}

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error("连不上本地服务：" + (error instanceof Error ? error.message : "网络错误"));
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorOf(data, response.status));
  if (!data || typeof data !== "object") throw new Error("服务端返回的不是 JSON 对象");
  return data as Record<string, any>;
}

export type ImportWebImageEntry = { url: string; source_page?: string };

/**
 * 导入原图（契约：一次 1..12 条，超出自动分批）。
 * 请求体用 items=[{url, source_page}]：source_page 的 origin 会被服务端当成 Referer，
 * 58pic / nipic / 花瓣这类防盗链站点不带出处页来源会 403；空 source_page 就不传该字段。
 * 返回顺序不保证，按 source_url 对应回去。
 */
export async function importWebImages(entries: ImportWebImageEntry[]): Promise<ImportedWebImage[]> {
  const list = entries
    .map((entry) => ({ url: String(entry?.url || "").trim(), source_page: String(entry?.source_page || "").trim() }))
    .filter((entry) => entry.url);
  if (!list.length) throw new Error("没有要导入的图片");
  const out: ImportedWebImage[] = [];
  for (let i = 0; i < list.length; i += 12) {
    const chunk = list.slice(i, i + 12).map((entry) => (entry.source_page ? { url: entry.url, source_page: entry.source_page } : { url: entry.url }));
    const data = await postJson("/api/agent/images/import", { items: chunk });
    const rows = Array.isArray(data.items) ? data.items : [];
    if (!rows.length) throw new Error("导入接口没有返回任何结果");
    for (const raw of rows) {
      const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
      out.push({
        source_url: text(row.source_url).trim(),
        ok: row.ok === true,
        url: text(row.url).trim(),
        width: positive(row.width),
        height: positive(row.height),
        bytes: Number(row.bytes) || 0,
        error: text(row.error).trim(),
      });
    }
  }
  return out;
}

/** 以图搜图（面板直调，不消耗一轮对话）；关闭联网时后端返回 403 + 可读中文原因 */
export async function reverseWebImages(imageUrl: string, count = 12): Promise<WebImageResult> {
  const url = String(imageUrl || "").trim();
  if (!url) throw new Error("没有可用于以图搜图的图片");
  return readWebImageResult(await postJson("/api/agent/images/reverse", { image_url: url, count }));
}

/**
 * 服务端图片代理：后端不带 Referer 去拉图，绕开花瓣/堆糖这类按 Referer 反爬的 CDN。
 * 用当前站点相对路径（不写死后端地址）；url 必须整体 encodeURIComponent。
 */
export function thumbProxyUrl(url: string, width: number): string {
  const target = String(url || "").trim();
  if (!target) return "";
  return "/api/agent/images/thumb?url=" + encodeURIComponent(target) + "&w=" + Math.round(width);
}

/** 联网开关：false = 明确关闭，true = 开启，null = 读不到（交给真正的请求报错，不猜） */
export async function webAccessEnabled(): Promise<boolean | null> {
  try {
    const response = await fetch("/api/agent/web-access", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data && typeof data === "object" && typeof data.enabled === "boolean" ? data.enabled : null;
  } catch {
    return null;
  }
}

const IMAGE_W = 240;
const IMAGE_GAP = 30;

/**
 * 导入成功的本地图 → image 节点：整组落在视口中心、一次 addNodes（单步可撤销）、建完选中。
 * 尺寸跟 addFiles 一致：宽 240 起步，按真实比例定高（太扁就把宽度等比放大，不夹高度压比例）。
 */
export function insertWebImages(store: CanvasStore, center: { x: number; y: number }, rows: InsertWebImage[]): string[] {
  const made: CanvasNode[] = [];
  const plan = rows.map((row) => ({ row, url: String(row.url || "").trim() })).filter((x) => x.url)
    .map(({ row, url }) => ({ row, url, box: (row.width && row.height ? fitSourceBox(row.width, row.height, { baseW: IMAGE_W }) : null) || { w: IMAGE_W, h: IMAGE_W } }));
  const total = plan.reduce((sum, x) => sum + x.box.w, 0) + IMAGE_GAP * Math.max(0, plan.length - 1);
  let cursor = center.x - total / 2;
  for (const { row, url, box } of plan) {
    const n = store.newNode("image", cursor, center.y - box.h / 2, {
      title: row.title || "参考图",
      uploaded: true,
      hist: [{ url, ...(row.width ? { w: row.width } : {}), ...(row.height ? { h: row.height } : {}) }],
      w: box.w,
      h: box.h,
    });
    made.push(n);
    cursor += box.w + IMAGE_GAP;
  }
  if (!made.length) return [];
  store.addNodes(made);
  store.setUI({ sel: new Set(made.map((n) => n.id)), edge: null });
  return made.map((n) => n.id);
}