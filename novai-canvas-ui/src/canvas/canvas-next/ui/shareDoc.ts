/**
 * 分享只读预览的纯函数：令牌解析 + 画布快照 → TemplatePreview 的只读图。
 * 单独成文件是为了能用 esbuild 直接单测（不 import React / CSS）。
 */
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import type { PreviewDocNode } from "./TemplatePreview";

export type SharePermission = "view" | "clone" | "template";

export type ShareLinkPayload = {
  token: string;
  canvas_id?: string;
  title?: string;
  url: string;
  permission: SharePermission;
  can_clone: boolean;
  can_save_template: boolean;
  expires_at: number;
  created_at?: number;
  owner_name?: string;
};

export type ShareSnapshot = {
  share: {
    token: string;
    permission: SharePermission;
    can_clone: boolean;
    can_save_template: boolean;
    expires_at: number;
    created_at?: number;
    owner_name?: string;
  };
  title: string;
  canvas: { title: string; icon?: string; nodes?: unknown[]; connections?: unknown[]; settings?: unknown };
  can_clone?: boolean;
  can_save_template?: boolean;
};

type Row = Record<string, any>;

export type ParsedShareLink = {
  token: string;
  /** 完整链接（裸令牌时为空串） */
  url: string;
  /** http(s)://host[:port]，裸令牌时为空串 */
  origin: string;
  /** host[:port]（带端口比较，127.0.0.1:3999 与 127.0.0.1 视为不同主机） */
  host: string;
  /** 有链接且主机/端口不是本机 → 需要走本机后端代取 */
  remote: boolean;
  error: string;
};

function defaultLocalHost(): string {
  try { return String(location.host || "").toLowerCase(); } catch { return ""; }
}

/**
 * 「打开分享链接」输入解析：完整 URL / ?share=…&token=… / /api/canvas-share/<token> / 裸 token 都支持。
 * 裸 token 或同源链接走本机原路径；其它主机（含同机不同端口）标记 remote，交给 /api/lan/share-preview 代取。
 */
export function parseShareLink(input: unknown, localHost?: string): ParsedShareLink {
  const empty: ParsedShareLink = { token: "", url: "", origin: "", host: "", remote: false, error: "" };
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { ...empty, error: "请先粘贴分享链接" };
  const host = String(localHost === undefined ? defaultLocalHost() : localHost || "").toLowerCase();
  if (/^[A-Za-z0-9_-]{16,}$/.test(text)) {
    return { ...empty, token: text };
  }
  const hasScheme = /^https?:\/\//i.test(text);
  const protocolRelative = text.startsWith("//");
  let parsed: URL;
  try {
    parsed = new URL(hasScheme || protocolRelative ? (protocolRelative ? "http:" + text : text) : text, "http://local.invalid");
  } catch {
    return { ...empty, error: "这不像一条分享链接，检查后重试" };
  }
  const pathOnly = !hasScheme && !protocolRelative;
  let token = parsed.searchParams.get("share") || "";
  if (!token) {
    const match = /\/api\/canvas-share\/([A-Za-z0-9_-]{16,})\/?$/.exec(parsed.pathname || "");
    if (match) token = match[1];
  }
  token = cleanToken(token);
  if (!token) return { ...empty, error: "分享链接里没有有效的画布令牌" };
  // 只给 ?share=… / /api/canvas-share/<token> 这种路径时按本机同源处理，避免误走代取
  if (pathOnly) return { ...empty, token };
  const remote = !!host && parsed.host.toLowerCase() !== host;
  return {
    token,
    url: parsed.href,
    origin: parsed.origin,
    host: parsed.host.toLowerCase(),
    remote,
    error: "",
  };
}

/** 有完整 URL 且主机（带端口）不是本机 → 走代取 */
export function isRemoteShareUrl(input: unknown, localHost?: string): boolean {
  const parsed = parseShareLink(input, localHost);
  return !parsed.error && parsed.remote;
}

/** 从「完整链接 / 带 share= 的链接 / 裸令牌」里取令牌；取不到返回空串。 */
export function parseShareToken(input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return "";
  if (text.includes("share=") || text.includes("?") || text.includes("://")) {
    try {
      const parsed = new URL(text, "http://local");
      const value = parsed.searchParams.get("share") || "";
      return cleanToken(value);
    } catch {
      const match = /[?&]share=([^&#\s]+)/.exec(text);
      return match ? cleanToken(decodeURIComponent(match[1])) : "";
    }
  }
  return cleanToken(text);
}

function cleanToken(value: string): string {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : "";
}

export function permissionLabel(permission: SharePermission | string | undefined): string {
  if (permission === "clone") return "可克隆到画布";
  if (permission === "template") return "可存为模板";
  return "仅查看";
}

/** 快照（可能还是旧格式 server doc）→ CanvasDoc；复用 novaiBackend 的 serverDocToDoc。 */
export function docOfSnapshot(snapshot: ShareSnapshot | null | undefined, convert: (raw: unknown) => { doc: CanvasDoc | null }): CanvasDoc | null {
  const canvas = snapshot?.canvas;
  if (!canvas || !Array.isArray(canvas.nodes)) return null;
  return convert({ nodes: canvas.nodes, connections: canvas.connections || [], settings: canvas.settings }).doc;
}

const KIND_LABEL: Record<string, string> = {
  image: "图片", video: "视频", audio: "音频", table: "表格", text: "文本", note: "便签",
  group: "分组", model3d: "3D 模型", timeline: "时间线", scene3d: "3D 片场",
  "smart-batch": "批量", "smart-loop": "循环",
};
const PREVIEW_KIND: Record<string, PreviewDocNode["kind"]> = {
  image: "image", video: "video", audio: "audio", table: "table", text: "text",
};
const TITLE_MAX = 40;

type GenLike = {
  title?: string; prompt?: string; params?: { ratio?: string };
  hist?: Array<{ text?: string; url?: string; frame?: string }>;
  hi?: number;
};

function genOf(node: CanvasNode): GenLike {
  const data = node.data && typeof node.data === "object" ? node.data as Row : {};
  return (data.gen && typeof data.gen === "object" ? data.gen : {}) as GenLike;
}

function tableOf(node: CanvasNode): { title?: string; columns?: string[]; rows?: string[][] } | null {
  const data = node.data && typeof node.data === "object" ? node.data as Row : {};
  return data.table && typeof data.table === "object" ? data.table as { title?: string; columns?: string[]; rows?: string[][] } : null;
}

function firstLine(text: string): string {
  const line = String(text || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  return line.slice(0, TITLE_MAX);
}

function titleOf(node: CanvasNode): string {
  const gen = genOf(node);
  if (gen.title) return gen.title;
  if (node.kind === "text" || node.kind === "note") return firstLine(node.text) || KIND_LABEL[node.kind] || "文本";
  if (node.kind === "table") return tableOf(node)?.title || firstLine(node.text) || "多维表格";
  return firstLine(node.text) || KIND_LABEL[node.kind] || "节点";
}

function coverOf(node: CanvasNode): string {
  const gen = genOf(node);
  const current = gen.hist?.[gen.hi || 0];
  if (current?.url) return current.frame || current.url;
  if (current?.frame) return current.frame;
  if (node.url) return node.url;
  if (node.originalUrl) return node.originalUrl;
  return "";
}

/**
 * 画布 doc → 只读预览图：保留坐标与尺寸（TemplatePreview 的 docGraph 会把整体平移进视口），
 * 生成类节点带封面 + 提示词，文本节点带正文，表格节点带表头；其余类型降级成文本卡。
 */
export function previewDocOf(doc: CanvasDoc | null | undefined): { nodes: PreviewDocNode[]; edges: Array<{ id: string; from: string; to: string }> } {
  const nodes: PreviewDocNode[] = [];
  const ids = new Set<string>();
  for (const node of Array.isArray(doc?.nodes) ? doc!.nodes : []) {
    if (!node || !node.id) continue;
    const gen = genOf(node);
    const current = gen.hist?.[gen.hi || 0];
    const kind: PreviewDocNode["kind"] = PREVIEW_KIND[node.kind] || "text";
    const cover = coverOf(node);
    const ratio = gen.params?.ratio;
    const table = tableOf(node);
    const text = node.kind === "text" || node.kind === "note"
      ? (current?.text || node.text || "")
      : (node.text || "");
    nodes.push({
      id: String(node.id),
      kind,
      x: Math.round(Number(node.x) || 0),
      y: Math.round(Number(node.y) || 0),
      w: Math.max(24, Math.round(Number(node.w) || 320)),
      h: Math.max(24, Math.round(Number(node.h) || 320)),
      title: titleOf(node),
      text,
      prompt: gen.prompt || "",
      params: ratio || kind === "image" || kind === "video" ? { ratio: ratio || "", ...(kind === "video" ? { mode: "视频" } : {}) } : undefined,
      table: kind === "table" ? (table || { title: titleOf(node), columns: ["字段 1"], rows: [[""]] }) : null,
      ...(cover ? { cover } : {}),
    });
    ids.add(String(node.id));
  }
  const edges = (Array.isArray(doc?.edges) ? doc!.edges : []).flatMap((edge) => {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) return [];
    return [{ id: String(edge.id || edge.from + ">" + edge.to), from: String(edge.from), to: String(edge.to) }];
  });
  return { nodes, edges };
}

/** 分享页/克隆前的错误文案：400 格式 / 401 口令 / 403 权限 / 404 撤销 / 410 过期 / 502 离线。 */
export function shareErrorMessage(status: number, detail?: string): string {
  const text = String(detail || "").trim();
  if (status === 0) return "连不上 NOVAI 服务：确认后端还在运行、两台机器在同一个局域网。";
  if (status === 400) return text || "这不像一条分享链接，检查后重试。";
  if (status === 401) return text || "对方的局域网口令不一致，让对方重新发一次链接。";
  if (status === 403) return text || "这个分享只允许查看，不能克隆。";
  if (status === 404) return "这个分享链接无效，或者分享已被撤销。";
  if (status === 410) return "这个分享链接已过期，请让分享者重新生成一个。";
  if (status === 413) return "已超过本机设置的分享快照上限：可调大 NOVAI_LAN_JSON_MAX_BYTES（0 = 不限）后重试。";
  if (status === 504) return "对方的画布读取超时（画布较大或网络较慢），点「重试」再来一次。";
  if (status === 502) return text || "连不上对方的电脑：确认对方还在运行 NOVAI、两台机器在同一个局域网。";
  if (status >= 500) return text || "分享所在的电脑出了点问题，稍后再试一次。";
  return text || "打开分享失败，请稍后再试。";
}
