import {
  emptyDoc,
  hasContent,
  readDoc,
  sanitizeDoc,
  writeDoc,
  type CanvasDoc,
  type NodeKind,
} from "./reactCanvasStore";
import { migrateLegacyDoc, type MigrationReport } from "./migration";

export type CanvasCommandBridge = {
  command: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type LoadSource = "bridge" | "local";

export type LoadResult = {
  ok: boolean;
  doc: CanvasDoc;
  version: number | null;
  source: LoadSource;
  migrated: boolean;
  report?: MigrationReport;
  rawLegacy?: unknown;
  error?: string;
};

export type SaveResult =
  | { ok: true; source: LoadSource; version: number | null }
  | { ok: false; conflict: boolean; remote?: CanvasDoc; remoteVersion?: number; error: string };

const DOMAIN_TYPE: Record<NodeKind, string> = {
  image: "smart-image",
  video: "smart-video",
  audio: "smart-audio",
  model3d: "smart-model3d",
  table: "table",
  "smart-batch": "smart-batch",
  "smart-loop": "smart-loop",
  timeline: "timeline",
  scene3d: "scene3d",
  text: "smart-text",
  note: "smart-label",
  group: "smart-group",
};

const BACKUP_KEY = "openarc-canvas-react:";
const BACKUP_SUFFIX = ":legacy-backup";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// 新画布的全部节点类型（之前漏了 table / model3d / smart-batch / smart-loop，读回来会变成便签）
const isKind = (value: unknown): value is NodeKind =>
  value === "image" || value === "video" || value === "audio" || value === "model3d" || value === "timeline" || value === "scene3d" ||
  value === "table" || value === "smart-batch" || value === "smart-loop" || value === "text" || value === "note" || value === "group";

export function canvasBridge(): CanvasCommandBridge | null {
  const candidate = (window as unknown as { openarc?: { canvas?: CanvasCommandBridge } }).openarc?.canvas;
  return candidate && typeof candidate.command === "function" ? candidate : null;
}

export function isNewFormatDoc(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return false;
  return raw.nodes.some((node) => isRecord(node) && isKind(node.kind));
}

/** 服务端文档口径是旧画布 {nodes,connections}；新文档会带 kind 字段，旧文档没有。 */
export function serverDocToDoc(raw: unknown): {
  doc: CanvasDoc | null;
  migrated: boolean;
  report?: MigrationReport;
  rawLegacy?: unknown;
} {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return { doc: null, migrated: false };
  if (!raw.nodes.length) return { doc: emptyDoc(), migrated: false };
  if (!isNewFormatDoc(raw)) {
    const result = migrateLegacyDoc(raw);
    return { doc: result.doc, migrated: true, report: result.report, rawLegacy: raw };
  }
  const connections = Array.isArray(raw.connections) ? raw.connections : [];
  const nodes = raw.nodes.map((node) => {
    const source = isRecord(node) ? node : {};
    const kind: NodeKind = isKind(source.kind) ? source.kind : "note";
    return {
      id: source.id,
      kind,
      x: source.x,
      y: source.y,
      w: source.w,
      h: source.h,
      text: source.text,
      ...(typeof source.url === "string" && source.url ? { url: source.url } : {}),
      ...(typeof source.originalUrl === "string" && source.originalUrl ? { originalUrl: source.originalUrl } : {}),
      ...(Array.isArray(source.clips) ? { clips: source.clips } : {}),
      ...(source.scene && typeof source.scene === "object" ? { scene: source.scene } : {}),
      ...(typeof source.refUrl === "string" && source.refUrl ? { refUrl: source.refUrl } : {}),
      ...(Array.isArray(source.variants) ? { variants: source.variants } : {}),
      ...(typeof source.model === "string" ? { model: source.model } : {}),
      ...(typeof source.ratio === "string" ? { ratio: source.ratio } : {}),
      ...(kind === "group" ? { children: source.children } : {}),
      // 节点自带数据（生成参数 / 提示词 / 历史版本 / 背景色与标记 / 表格内容…）原样带回
      ...(isRecord(source.data) ? { data: source.data } : {}),
    };
  });
  const edges = connections.map((edge) => {
    const source = isRecord(edge) ? edge : {};
    return {
      id: source.id,
      from: source.from,
      to: source.to,
      ...(source.fromSide === "left" || source.fromSide === "right" ? { fromSide: source.fromSide } : {}),
    };
  });
  const comments = Array.isArray(raw.comments) ? raw.comments : [];
  return { doc: sanitizeDoc({ nodes, edges, comments, settings: raw.settings }), migrated: false };
}

export function docToServerDoc(doc: CanvasDoc): Record<string, unknown> {
  const nodes = doc.nodes.map((node) => ({
    id: node.id,
    type: DOMAIN_TYPE[node.kind],
    kind: node.kind,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    text: node.text,
    ...(node.url ? { url: node.url } : {}),
    ...(node.originalUrl ? { originalUrl: node.originalUrl } : {}),
    ...(node.clips ? { clips: node.clips } : {}),
    ...(node.scene ? { scene: node.scene } : {}),
    ...(node.refUrl ? { refUrl: node.refUrl } : {}),
    ...(node.variants ? { variants: node.variants } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.ratio ? { ratio: node.ratio } : {}),
    ...(node.kind === "group" ? { children: node.children || [] } : {}),
    ...(node.data && typeof node.data === "object" ? { data: node.data } : {}),
  }));
  const connections = doc.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...(edge.fromSide ? { fromSide: edge.fromSide } : {}),
  }));
  return { nodes, connections, comments: doc.comments, settings: doc.settings, viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
}

/** 迁移前的原始文档副本：localStorage 尽力而为，失败不影响迁移。 */
export function backupLegacyDoc(canvasId: string, raw: unknown): void {
  try {
    const serialized = JSON.stringify(raw);
    if (serialized && serialized.length <= 2_000_000) {
      window.localStorage.setItem(BACKUP_KEY + canvasId + BACKUP_SUFFIX, serialized);
    }
  } catch {
    return;
  }
}

export async function loadDoc(canvasId: string): Promise<LoadResult> {
  const local = readDoc(canvasId);
  const api = canvasBridge();
  if (!api) return { ok: true, doc: local ?? emptyDoc(), version: null, source: "local", migrated: false };
  try {
    const response = await api.command({ type: "canvas/get", canvasId });
    if (!response || response.ok !== true) {
      return {
        ok: true,
        doc: local ?? emptyDoc(),
        version: null,
        source: "local",
        migrated: false,
        error: String((response && response.error) || "CANVAS_GET_FAILED"),
      };
    }
    const canvas = isRecord(response.canvas) ? response.canvas : null;
    if (!canvas) {
      return { ok: true, doc: local ?? emptyDoc(), version: null, source: "local", migrated: false, error: "CANVAS_EMPTY_RESPONSE" };
    }
    const revision = Number(canvas.revision);
    const version = Number.isFinite(revision) && revision > 0 ? revision : 1;
    const parsed = serverDocToDoc(canvas.doc);
    if (!parsed.doc) {
      return { ok: true, doc: local ?? emptyDoc(), version: null, source: "local", migrated: false, error: "CANVAS_DOC_INVALID" };
    }
    if (parsed.migrated) {
      return {
        ok: true,
        doc: parsed.doc,
        version,
        source: "bridge",
        migrated: true,
        report: parsed.report,
        rawLegacy: parsed.rawLegacy,
      };
    }
    if (hasContent(parsed.doc)) return { ok: true, doc: parsed.doc, version, source: "bridge", migrated: false };
    if (local && hasContent(local)) return { ok: true, doc: local, version, source: "bridge", migrated: false };
    return { ok: true, doc: parsed.doc, version, source: "bridge", migrated: false };
  } catch (error) {
    return {
      ok: true,
      doc: local ?? emptyDoc(),
      version: null,
      source: "local",
      migrated: false,
      error: error instanceof Error ? error.message : "BRIDGE_UNAVAILABLE",
    };
  }
}

/**
 * 保存：本地镜像永远先写（独立页/刷新恢复靠它），bridge 可用时再按 baseVersion 落服务端。
 * 409 不覆盖：返回 conflict + 服务端远端文档，由调用方显示冲突状态。
 */
export async function saveDoc(canvasId: string, doc: CanvasDoc, baseVersion: number | null): Promise<SaveResult> {
  writeDoc(canvasId, doc);
  const api = canvasBridge();
  if (!api) return { ok: true, source: "local", version: baseVersion };
  try {
    const response = await api.command({
      type: "canvas/save",
      canvasId,
      baseRevision: baseVersion == null ? null : baseVersion,
      doc: docToServerDoc(doc),
    });
    if (response && response.ok === true && isRecord(response.canvas)) {
      const revision = Number(response.canvas.revision);
      return { ok: true, source: "bridge", version: Number.isFinite(revision) && revision > 0 ? revision : baseVersion };
    }
    const error = String((response && response.error) || "CANVAS_SAVE_FAILED");
    if (error === "REVISION_CONFLICT") {
      const detail = isRecord(response.detail) ? response.detail : {};
      const remoteCanvas = isRecord(detail.canvas) ? detail.canvas : null;
      const parsed = remoteCanvas ? serverDocToDoc(remoteCanvas.doc) : { doc: null, migrated: false };
      const remoteRevision = remoteCanvas ? Number(remoteCanvas.revision) : Number.NaN;
      return {
        ok: false,
        conflict: true,
        remote: parsed.doc || undefined,
        remoteVersion: Number.isFinite(remoteRevision) && remoteRevision > 0 ? remoteRevision : undefined,
        error,
      };
    }
    return { ok: false, conflict: false, error };
  } catch (error) {
    return { ok: false, conflict: false, error: error instanceof Error ? error.message : "BRIDGE_UNAVAILABLE" };
  }
}
