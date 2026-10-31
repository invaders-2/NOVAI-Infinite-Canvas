import {
  makeId,
  NODE_SIZE,
  sanitizeDoc,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type NodeKind,
} from "./reactCanvasStore";

const LEGACY_TYPE_KIND: Record<string, NodeKind> = {
  "smart-image": "image",
  "smart-text": "text",
  "smart-label": "note",
  "smart-group": "group",
  image: "image",
  text: "text",
  note: "note",
  group: "group",
};

/** 本任务明确不转换的旧类型：原始节点整条进 report.unsupported，不丢字段。 */
export const UNSUPPORTED_LEGACY_TYPES = ["table", "smart-table", "smart-batch", "smart-loop"] as const;

export type MigrationReport = {
  total: number;
  mapped: Array<{ id: string; type: string; kind: NodeKind }>;
  unsupported: Array<{ id: string; type: string; raw: Record<string, unknown> }>;
  droppedConnections: Array<{
    id: string;
    from: string;
    to: string;
    reason: "invalid-endpoint" | "endpoint-not-migrated";
  }>;
  viewport: { present: boolean; value: unknown };
  backup: { nodes: unknown[]; connections: unknown[]; viewport: unknown; logs: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function legacyText(raw: Record<string, unknown>): string {
  for (const key of ["text", "title", "name", "label", "content"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function legacyUrl(raw: Record<string, unknown>): string {
  const media = isRecord(raw.media) ? raw.media : null;
  for (const value of [raw.url, raw.src, raw.imageUrl, raw.assetUrl, media && media.url]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 2000);
  }
  return "";
}

function legacyChildren(raw: Record<string, unknown>): string[] {
  const source = Array.isArray(raw.children) ? raw.children : Array.isArray(raw.childIds) ? raw.childIds : [];
  return source.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * 旧 smart-canvas 文档 → 新 {nodes,edges}：只做字段改名与结构映射，不做内容裁剪。
 * 不可映射的节点/连线留在 report.unsupported / droppedConnections，原始文档另由调用方备份。
 */
export function migrateLegacyDoc(oldDoc: unknown): { doc: CanvasDoc; report: MigrationReport } {
  const root = isRecord(oldDoc) ? oldDoc : {};
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const rawConnections = Array.isArray(root.connections) ? root.connections : [];
  const viewport = isRecord(root.viewport) ? { ...root.viewport } : null;
  const report: MigrationReport = {
    total: rawNodes.length,
    mapped: [],
    unsupported: [],
    droppedConnections: [],
    viewport: { present: viewport !== null, value: viewport },
    backup: {
      nodes: rawNodes.map((node) => (isRecord(node) ? { ...node } : node)),
      connections: rawConnections.map((connection) => (isRecord(connection) ? { ...connection } : connection)),
      viewport,
      logs: Array.isArray(root.logs) ? root.logs.slice() : [],
    },
  };

  const nodes: CanvasNode[] = [];
  rawNodes.forEach((item, index) => {
    if (!isRecord(item)) return;
    const type = typeof item.type === "string" ? item.type : "";
    const kind = LEGACY_TYPE_KIND[type];
    const rawId = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 64) : "";
    const id = rawId || "legacy_" + index;
    if (!kind) {
      report.unsupported.push({ id, type: type || "(missing)", raw: { ...item } });
      return;
    }
    const size = NODE_SIZE[kind];
    nodes.push({
      id,
      kind,
      x: finite(item.x) ?? 0,
      y: finite(item.y) ?? 0,
      w: finite(item.w) ?? finite(item.width) ?? size.w,
      h: finite(item.h) ?? finite(item.height) ?? size.h,
      text: legacyText(item),
      ...(legacyUrl(item) ? { url: legacyUrl(item) } : {}),
      ...(kind === "group" ? { children: legacyChildren(item) } : {}),
    });
    report.mapped.push({ id, type, kind });
  });

  const mappedIds = new Set(nodes.map((node) => node.id));
  nodes.forEach((node) => {
    if (node.kind !== "group" || !node.children) return;
    node.children = node.children.filter((id) => mappedIds.has(id));
  });

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  rawConnections.forEach((item, index) => {
    if (!isRecord(item)) return;
    const from = typeof item.from === "string" ? item.from : typeof item.fromId === "string" ? item.fromId : "";
    const to = typeof item.to === "string" ? item.to : typeof item.toId === "string" ? item.toId : "";
    let id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 64) : "c_legacy_" + index;
    if (!from || !to || from === to) {
      report.droppedConnections.push({ id, from, to, reason: "invalid-endpoint" });
      return;
    }
    if (!mappedIds.has(from) || !mappedIds.has(to)) {
      report.droppedConnections.push({ id, from, to, reason: "endpoint-not-migrated" });
      return;
    }
    while (edgeIds.has(id)) id = makeId("e");
    edgeIds.add(id);
    const fromSide = item.fromSide === "left" || item.fromSide === "right" ? item.fromSide : undefined;
    edges.push({ id, from, to, ...(fromSide ? { fromSide } : {}) });
  });

  const comments = Array.isArray(root.comments) ? root.comments : [];
  const doc = sanitizeDoc({ nodes, edges, comments, settings: root.settings }) ?? { nodes: [], edges: [], comments: [] };
  return { doc, report };
}
