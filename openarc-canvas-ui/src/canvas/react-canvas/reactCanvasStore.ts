export type NodeKind = "image" | "video" | "audio" | "model3d" | "timeline" | "scene3d" | "table" | "smart-batch" | "smart-loop" | "text" | "note" | "group";

export type CanvasNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 媒体地址（素材库 ResourceRef / 图片 URL）。没有媒体的节点不能保存到素材库。 */
  url?: string;
  originalUrl?: string;
  variants?: string[];
  clips?: TimelineClip[];
  scene?: Scene3DData;
  refUrl?: string;
  children?: string[];
  model?: string;
  ratio?: string;
  data?: unknown;
};

export type CanvasEdge = { id: string; from: string; to: string; fromSide?: "left" | "right" };
export type TimelineClip = { id: string; sourceNodeId: string; url: string; mediaKind: "video" | "audio"; inPoint: number; outPoint: number; order: number; type?: "subtitle"; text?: string; start?: number; end?: number; fadeIn?: number; fadeOut?: number };
export type Scene3DObjectType = "cube" | "sphere" | "cylinder" | "plane" | "gltf";
export type Scene3DObject = { id: string; type: Scene3DObjectType; position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]; color: string; url?: string; name?: string };
export type Scene3DData = { objects: Scene3DObject[]; camera: { position: [number, number, number]; target: [number, number, number] }; background: string; lights?: { ambient: number; directional: number; color: string } };
export type BatchMode = "stack" | "variants" | "spread";
export type CanvasSettings = { gridSnap: boolean; hideEdges: boolean; batchMode: BatchMode; voiceEnabled: boolean };
export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = { gridSnap: false, hideEdges: false, batchMode: "variants", voiceEnabled: false };
export type CanvasCommentReply = { id: string; text: string; createdAt: number; clientId: string; author?: string; editedAt?: number };
export type CanvasComment = { id: string; x: number; y: number; text: string; createdAt: number; clientId: string; author?: string; editedAt?: number; replies?: CanvasCommentReply[] };
export type CanvasDoc = { nodes: CanvasNode[]; edges: CanvasEdge[]; comments: CanvasComment[]; settings?: CanvasSettings };

export type CanvasOp =
  | { type: "add-node"; node: CanvasNode }
  | { type: "update-node"; id: string; patch: Partial<Pick<CanvasNode, "x" | "y" | "w" | "h" | "text" | "url" | "originalUrl" | "variants" | "clips" | "scene" | "refUrl" | "model" | "ratio" | "children" | "data">>; ts?: number; clientId?: string }
  | { type: "add-edge"; edge: CanvasEdge }
  | { type: "remove-nodes"; ids: string[] }
  | { type: "remove-edges"; ids: string[] }
  | { type: "add-comment"; comment: CanvasComment }
  | { type: "remove-comment"; id: string }
  | { type: "update-settings"; patch: Partial<CanvasSettings> }
  | { type: "replace"; doc: CanvasDoc };

export const NODE_KIND_LABEL: Record<NodeKind, string> = { image: "图片", video: "视频", audio: "音频", model3d: "3D 模型", table: "表格", "smart-batch": "批量", "smart-loop": "循环", timeline: "剪辑时间线 Beta", scene3d: "3D 片场", text: "文本", note: "便签", group: "分组" };
export const NODE_SIZE: Record<NodeKind, { w: number; h: number }> = {
  image: { w: 320, h: 320 },
  video: { w: 568, h: 320 },
  audio: { w: 568, h: 320 },
  model3d: { w: 420, h: 260 },
  table: { w: 320, h: 160 },
  "smart-batch": { w: 320, h: 160 },
  "smart-loop": { w: 320, h: 160 },
  timeline: { w: 560, h: 280 },
  scene3d: { w: 640, h: 400 },
  text: { w: 320, h: 320 },
  note: { w: 220, h: 168 },
  group: { w: 320, h: 240 },
};

export function emptyDoc(): CanvasDoc {
  return { nodes: [], edges: [], comments: [] };
}

export function hasContent(doc: CanvasDoc): boolean {
  return doc.nodes.length > 0 || doc.edges.length > 0 || doc.comments.length > 0;
}

export function makeId(prefix: string): string {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

export function normalizeCanvasId(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const clean = text.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return clean || "default";
}

export function makeNode(kind: NodeKind, x: number, y: number, text = ""): CanvasNode {
  const size = NODE_SIZE[kind];
  return { id: makeId("n"), kind, x: Math.round(x), y: Math.round(y), w: size.w, h: size.h, text };
}

export function makeGroupNode(children: CanvasNode[]): CanvasNode {
  const padding = 24;
  const minX = Math.min.apply(null, children.map((node) => node.x));
  const minY = Math.min.apply(null, children.map((node) => node.y));
  const maxX = Math.max.apply(null, children.map((node) => node.x + node.w));
  const maxY = Math.max.apply(null, children.map((node) => node.y + node.h));
  return {
    id: makeId("g"),
    kind: "group",
    x: Math.round(minX - padding),
    y: Math.round(minY - padding),
    w: Math.round(maxX - minX + padding * 2),
    h: Math.round(maxY - minY + padding * 2),
    text: "",
    children: children.map((node) => node.id),
  };
}

function clampNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

function sanitizeScene(raw: unknown): Scene3DData {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const vec = (value: unknown, fallback: [number, number, number]): [number, number, number] => Array.isArray(value) && value.length === 3 ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0] : fallback;
  const objects = Array.isArray(row.objects) ? row.objects.slice(0, 80).map((item, index) => {
    const obj = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const type: Scene3DObjectType = obj.type === "sphere" || obj.type === "cylinder" || obj.type === "plane" || obj.type === "gltf" ? obj.type : "cube";
    return { id: String(obj.id || "obj_" + index).slice(0, 80), type, position: vec(obj.position, [0, 0.5, 0]), rotation: vec(obj.rotation, [0, 0, 0]), scale: vec(obj.scale, [1, 1, 1]), color: typeof obj.color === "string" ? obj.color.slice(0, 20) : "#e8e8e8", ...(typeof obj.url === "string" ? { url: obj.url.slice(0, 4000) } : {}), ...(typeof obj.name === "string" ? { name: obj.name.slice(0, 120) } : {}) };
  }) : [];
  const camera = row.camera && typeof row.camera === "object" ? row.camera as Record<string, unknown> : {};
  const lights = row.lights && typeof row.lights === "object" ? row.lights as Record<string, unknown> : {};
  return { objects, camera: { position: vec(camera.position, [6, 5, 8]), target: vec(camera.target, [0, 0, 0]) }, background: typeof row.background === "string" ? row.background.slice(0, 20) : "#111111", lights: { ambient: Math.max(0, Math.min(5, Number(lights.ambient) || 0.55)), directional: Math.max(0, Math.min(8, Number(lights.directional) || 1.1)), color: typeof lights.color === "string" ? lights.color.slice(0, 20) : "#ffffff" } };
}

function sanitizeClips(raw: unknown): TimelineClip[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const inPoint = Math.max(0, Number(row.inPoint) || 0);
    const outPoint = Math.max(inPoint + 0.1, Number(row.outPoint) || inPoint + 5);
    const subtitle = row.type === "subtitle";
    const start = Math.max(0, Number(row.start) || inPoint);
    const end = Math.max(start + 0.1, Number(row.end) || outPoint);
    return { id: String(row.id || "clip_" + index).slice(0, 80), sourceNodeId: String(row.sourceNodeId || "").slice(0, 80), url: String(row.url || "").slice(0, 2000), mediaKind: row.mediaKind === "audio" ? "audio" as const : "video" as const, inPoint, outPoint, order: index, ...(subtitle ? { type: "subtitle" as const, text: String(row.text || "字幕").slice(0, 500), start, end } : {}), fadeIn: Math.max(0, Math.min(1000, Number(row.fadeIn) || 0)), fadeOut: Math.max(0, Math.min(1000, Number(row.fadeOut) || 0)) };
  }).filter((clip) => clip.url || clip.type === "subtitle").slice(0, 50);
}

export function sanitizeDoc(raw: unknown): CanvasDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(root.nodes) || !Array.isArray(root.edges)) return null;
  const nodes: CanvasNode[] = [];
  for (const item of root.nodes.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id.slice(0, 64) : "";
    if (!id) continue;
    const kind: NodeKind = n.kind === "image" || n.kind === "video" || n.kind === "audio" || n.kind === "model3d" || n.kind === "timeline" || n.kind === "scene3d" || n.kind === "table" || n.kind === "smart-batch" || n.kind === "smart-loop" || n.kind === "text" || n.kind === "note" || n.kind === "group" ? n.kind : "note";
    const size = NODE_SIZE[kind];
    nodes.push({
      id,
      kind,
      x: clampNumber(n.x, -20000, 20000, 0),
      y: clampNumber(n.y, -20000, 20000, 0),
      w: clampNumber(n.w, 80, 800, size.w),
      h: clampNumber(n.h, 48, 800, size.h),
      text: typeof n.text === "string" ? n.text.slice(0, 4000) : "",
      ...(typeof n.url === "string" && n.url.trim() ? { url: n.url.slice(0, 2000) } : {}),
      ...(typeof n.originalUrl === "string" && n.originalUrl.trim() ? { originalUrl: n.originalUrl.slice(0, 2000) } : {}),
      ...(Array.isArray(n.variants) ? { variants: n.variants.filter((value): value is string => typeof value === "string").slice(0, 20) } : {}),
      ...(Array.isArray(n.clips) ? { clips: sanitizeClips(n.clips) } : {}),
      ...(n.scene && typeof n.scene === "object" ? { scene: sanitizeScene(n.scene) } : {}),
      ...(typeof n.refUrl === "string" && n.refUrl.trim() ? { refUrl: n.refUrl.slice(0, 2000) } : {}),
      ...(typeof n.model === "string" ? { model: n.model.slice(0, 120) } : {}),
      ...(typeof n.ratio === "string" ? { ratio: n.ratio.slice(0, 20) } : {}),
      ...(n.data && typeof n.data === "object" ? { data: n.data } : {}),
      ...(kind === "group"
        ? {
            children: Array.isArray(n.children)
              ? n.children.filter((value): value is string => typeof value === "string").slice(0, 200)
              : [],
          }
        : {}),
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  for (const item of root.edges.slice(0, 800)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.slice(0, 64) : "";
    const from = typeof e.from === "string" ? e.from : "";
    const to = typeof e.to === "string" ? e.to : "";
    if (!id || !ids.has(from) || !ids.has(to) || from === to) continue;
    const fromSide = e.fromSide === "left" || e.fromSide === "right" ? e.fromSide : undefined;
    edges.push({ id, from, to, ...(fromSide ? { fromSide } : {}) });
  }
  const comments: CanvasComment[] = [];
  if (Array.isArray((root as { comments?: unknown }).comments)) {
    for (const item of (root as { comments: unknown[] }).comments.slice(0, 1000)) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const cid = typeof c.id === "string" ? c.id.slice(0, 64) : "";
      const text = typeof c.text === "string" ? c.text.slice(0, 200) : "";
      if (!cid || !text) continue;
      comments.push({
        id: cid,
        x: clampNumber(c.x, -20000, 20000, 0),
        y: clampNumber(c.y, -20000, 20000, 0),
        text,
        createdAt: clampNumber(c.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
        clientId: typeof c.clientId === "string" ? c.clientId.slice(0, 64) : "local",
        ...(typeof c.author === "string" && c.author ? { author: c.author.slice(0, 80) } : {}),
        ...(Number.isFinite(Number(c.editedAt)) && Number(c.editedAt) > 0 ? { editedAt: Number(c.editedAt) } : {}),
        ...sanitizeReplies(c.replies),
      });
    }
  }
  const rawSettings = (raw as { settings?: unknown }).settings;
  const settings = rawSettings && typeof rawSettings === "object"
    ? {
        gridSnap: (rawSettings as Record<string, unknown>).gridSnap === true,
        hideEdges: (rawSettings as Record<string, unknown>).hideEdges === true,
        batchMode: (rawSettings as Record<string, unknown>).batchMode === "stack" || (rawSettings as Record<string, unknown>).batchMode === "spread" ? ((rawSettings as Record<string, unknown>).batchMode as BatchMode) : "variants",
        voiceEnabled: (rawSettings as Record<string, unknown>).voiceEnabled === true,
      }
    : undefined;
  return { nodes, edges, comments, ...(settings ? { settings } : {}) };
}

export function sanitizeOp(raw: unknown): CanvasOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "add-node": {
      const doc = sanitizeDoc({ nodes: [r.node], edges: [] });
      const node = doc?.nodes[0];
      return node ? { type: "add-node", node } : null;
    }
    case "update-node": {
      if (typeof r.id !== "string") return null;
      if (!r.patch || typeof r.patch !== "object") return null;
      const source = r.patch as Record<string, unknown>;
      const patch: Partial<Pick<CanvasNode, "x" | "y" | "w" | "h" | "text" | "url" | "originalUrl" | "variants" | "clips" | "scene" | "refUrl" | "model" | "ratio" | "children">> = {};
      if (typeof source.x === "number" && Number.isFinite(source.x)) patch.x = clampNumber(source.x, -20000, 20000, 0);
      if (typeof source.y === "number" && Number.isFinite(source.y)) patch.y = clampNumber(source.y, -20000, 20000, 0);
      if (typeof source.w === "number" && Number.isFinite(source.w)) patch.w = clampNumber(source.w, 80, 800, 260);
      if (typeof source.h === "number" && Number.isFinite(source.h)) patch.h = clampNumber(source.h, 48, 800, 132);
      if (typeof source.text === "string") patch.text = source.text.slice(0, 4000);
      if (typeof source.url === "string") patch.url = source.url.slice(0, 2000);
      if (typeof source.originalUrl === "string") patch.originalUrl = source.originalUrl.slice(0, 2000);
      if (Array.isArray(source.variants)) patch.variants = source.variants.filter((value): value is string => typeof value === "string").slice(0, 20);
      if (Array.isArray(source.clips)) patch.clips = sanitizeClips(source.clips);
      if (source.scene && typeof source.scene === "object") patch.scene = sanitizeScene(source.scene);
      if (typeof source.refUrl === "string") patch.refUrl = source.refUrl.slice(0, 2000);
      if (typeof source.model === "string") patch.model = source.model.slice(0, 120);
      if (typeof source.ratio === "string") patch.ratio = source.ratio.slice(0, 20);
      if (Array.isArray(source.children)) {
        patch.children = source.children.filter((value): value is string => typeof value === "string").slice(0, 200);
      }
      if (source.data && typeof source.data === "object") (patch as Record<string, unknown>).data = source.data;
      const ts = Number.isFinite(Number(r.ts)) ? Number(r.ts) : undefined;
      const clientId = typeof r.clientId === "string" ? r.clientId.slice(0, 80) : undefined;
      return Object.keys(patch).length ? { type: "update-node", id: r.id.slice(0, 64), patch, ...(ts !== undefined ? { ts } : {}), ...(clientId ? { clientId } : {}) } : null;
    }
    case "add-edge": {
      if (!r.edge || typeof r.edge !== "object") return null;
      const e = r.edge as Record<string, unknown>;
      if (typeof e.id !== "string" || typeof e.from !== "string" || typeof e.to !== "string") return null;
      const fromSide = e.fromSide === "left" || e.fromSide === "right" ? e.fromSide : undefined;
      return { type: "add-edge", edge: { id: e.id.slice(0, 64), from: e.from, to: e.to, ...(fromSide ? { fromSide } : {}) } };
    }
    case "remove-nodes": {
      if (!Array.isArray(r.ids)) return null;
      const ids = r.ids.filter((v): v is string => typeof v === "string").slice(0, 500);
      return ids.length ? { type: "remove-nodes", ids } : null;
    }
    case "remove-edges": {
      if (!Array.isArray(r.ids)) return null;
      const ids = r.ids.filter((v): v is string => typeof v === "string").slice(0, 500);
      return ids.length ? { type: "remove-edges", ids } : null;
    }
    case "add-comment": {
      const doc = sanitizeDoc({ nodes: [], edges: [], comments: [r.comment] });
      const comment = doc?.comments[0];
      return comment ? { type: "add-comment", comment } : null;
    }
    case "remove-comment": {
      return typeof r.id === "string" ? { type: "remove-comment", id: r.id.slice(0, 64) } : null;
    }
    case "update-settings": {
      const patch: Partial<CanvasSettings> = {};
      if (typeof r.gridSnap === "boolean") patch.gridSnap = r.gridSnap;
      if (typeof r.hideEdges === "boolean") patch.hideEdges = r.hideEdges;
      if (r.batchMode === "stack" || r.batchMode === "variants" || r.batchMode === "spread") patch.batchMode = r.batchMode;
      if (typeof r.voiceEnabled === "boolean") patch.voiceEnabled = r.voiceEnabled;
      return Object.keys(patch).length ? { type: "update-settings", patch } : null;
    }
    case "replace": {
      const doc = sanitizeDoc(r.doc);
      return doc ? { type: "replace", doc } : null;
    }
    default:
      return null;
  }
}

export function applyOp(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  switch (op.type) {
    case "add-node": {
      if (doc.nodes.some((n) => n.id === op.node.id)) return doc;
      return { ...doc, nodes: [...doc.nodes, op.node] };
    }
    case "update-node": {
      let changed = false;
      const nodes = doc.nodes.map((n) => {
        if (n.id !== op.id) return n;
        changed = true;
        return { ...n, ...op.patch };
      });
      return changed ? { ...doc, nodes } : doc;
    }
    case "add-edge": {
      const { from, to } = op.edge;
      if (from === to) return doc;
      if (!doc.nodes.some((n) => n.id === from) || !doc.nodes.some((n) => n.id === to)) return doc;
      if (doc.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return doc;
      return { ...doc, edges: [...doc.edges, op.edge] };
    }
    case "remove-nodes": {
      const ids = new Set(op.ids);
      const nodes = doc.nodes
        .filter((n) => !ids.has(n.id))
        .map((n) =>
          n.kind === "group" && n.children ? { ...n, children: n.children.filter((id) => !ids.has(id)) } : n,
        );
      return {
        nodes,
        edges: doc.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
        comments: doc.comments,
      };
    }
    case "remove-edges": {
      const ids = new Set(op.ids);
      return { ...doc, edges: doc.edges.filter((e) => !ids.has(e.id)) };
    }
    case "add-comment": {
      if (doc.comments.some((c) => c.id === op.comment.id)) return doc;
      return { ...doc, comments: [...doc.comments, op.comment] };
    }
    case "remove-comment": {
      return { ...doc, comments: doc.comments.filter((c) => c.id !== op.id) };
    }
    case "update-settings": {
      return { ...doc, settings: { ...DEFAULT_CANVAS_SETTINGS, ...(doc.settings || {}), ...op.patch } };
    }
    case "replace":
      return sanitizeDoc(op.doc) ?? emptyDoc();
    default:
      return doc;
  }
}

export function storageKey(canvasId: string): string {
  return "openarc-canvas-react:" + canvasId + ":doc";
}

export function channelName(canvasId: string): string {
  return "openarc-canvas-react:" + canvasId;
}

export function readDoc(canvasId: string): CanvasDoc | null {
  try {
    const raw = window.localStorage.getItem(storageKey(canvasId));
    if (!raw) return null;
    return sanitizeDoc(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeDoc(canvasId: string, doc: CanvasDoc): void {
  try {
    window.localStorage.setItem(storageKey(canvasId), JSON.stringify(doc));
  } catch {
    return;
  }
}

/** 评论回复：最多 200 条，每条 200 字 */
function sanitizeReplies(raw: unknown): { replies?: CanvasCommentReply[] } {
  if (!Array.isArray(raw)) return {};
  const replies: CanvasCommentReply[] = [];
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.slice(0, 64) : ""; const text = typeof r.text === "string" ? r.text.slice(0, 200) : "";
    if (!id || !text) continue;
    replies.push({
      id, text,
      createdAt: Number.isFinite(Number(r.createdAt)) ? Math.max(0, Number(r.createdAt)) : Date.now(),
      clientId: typeof r.clientId === "string" ? r.clientId.slice(0, 64) : "local",
      ...(typeof r.author === "string" && r.author ? { author: r.author.slice(0, 80) } : {}),
      ...(Number.isFinite(Number(r.editedAt)) && Number(r.editedAt) > 0 ? { editedAt: Number(r.editedAt) } : {}),
    });
  }
  return replies.length ? { replies } : {};
}
