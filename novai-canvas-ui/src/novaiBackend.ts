import { hostRoot } from "./novaiBridgeRoot";
import type { CanvasBackend, ChatMessage, EditRequest, GenEvent, GenRequest, GenResult, LoadedDoc, MattingModelStatus, SavedDoc, UpscaleResult, UpscaleRuntimeStatus } from "./canvas/canvas-next/backend/types";
import { GenError } from "./canvas/canvas-next/backend/types";
import { defaultParams, outputFormatForRequest, qualityForRequest, ratioWH, specFor, thinkingForRequest, withGen, type GenOutput, type ImageParams, type ModelSpec, type TextParams, type VideoParams } from "./canvas/canvas-next/model";
import { emptyDoc, hasContent, readDoc, sanitizeDoc, type CanvasDoc, type CanvasNode, type NodeKind } from "./canvas/react-canvas/reactCanvasStore";
import { queueLocalMirror } from "./canvas/canvas-next/localMirror";
import { clampImageSize, indexModelCaps, mergeCapsReferenceCapability, modelCapsKey, modelCapsUi, type ModelCapsItem } from "./canvas/canvas-next/modelCaps";
import { midjourneyPrompt } from "./canvas/canvas-next/midjourney";

type Row = Record<string, any>;
type CanvasMeta = { title: string; icon: string; viewport: Row; logs: Row[]; updatedAt: number };

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
const NODE_KINDS = new Set<NodeKind>(["image", "video", "audio", "model3d", "timeline", "scene3d", "table", "smart-batch", "smart-loop", "text", "note", "group"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 模型规格是增强信息：接口慢/404 时最多等这么久，不能让模型列表被它拖住 */
const MODEL_CAPS_TIMEOUT_MS = 1000;
const modelId = (provider: string, model: string) => provider + "::" + model;
function officialImageUi(name: string): Record<string, unknown> | null {
  const agnes = /^agnes-image-(2\.0|2\.1|2\.5)-flash$/i.exec(name);
  if (!agnes) return null;
  return {
    ratios: agnes[1] === "2.0" ? ["1:1", "4:3", "3:4"] : ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
    sizes: ["1K", "2K", "3K", "4K"],
    batch: [1],
    maxRefs: 20,
    i2i: true,
    refNote: "支持多图参考（画布上限 20 张）",
  };
}
const urlOf = (row: any): string => String((row && typeof row === "object" ? row.url || row.dataUrl || row.value || row.sourceUrl : row) || "");

/** 图片真实像素（只读宽高，不需要 CORS：Image 元素读 naturalWidth 不受跨域限制） */
const loadImageSize = (src: string) => new Promise<{ w: number; h: number } | null>((resolve) => {
  if (!src) return resolve(null);
  const im = new Image();
  im.onload = () => resolve(im.naturalWidth > 0 && im.naturalHeight > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
  im.onerror = () => resolve(null);
  im.src = src;
});

function errorText(data: any, fallback: string): string {
  const detail = data?.detail ?? data?.error ?? data?.message;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail.message === "string") return detail.message;
  return fallback;
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new GenError(String(data?.detail?.error || data?.error || `HTTP_${response.status}`), errorText(data, `请求失败（${response.status}）`));
  return data;
}

function jsonBody(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function splitModel(id: string): { provider: string; model: string } {
  const at = id.indexOf("::");
  return at >= 0 ? { provider: id.slice(0, at), model: id.slice(at + 2) } : { provider: "comfly", model: id };
}

function legacyKind(raw: Row): NodeKind {
  if (NODE_KINDS.has(raw.kind)) return raw.kind;
  const type = String(raw.type || "");
  if (type === "image") return raw.mediaKind === "video" || raw.mediaKind === "audio" ? raw.mediaKind : "image";
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (type === "generator" || type === "midjourney" || type === "comfy" || type === "rh") return "image";
  if (type === "prompt" || type === "llm") return "text";
  if (type === "output") {
    const first = Array.isArray(raw.images) ? raw.images[0] : null;
    const kind = String(first?.kind || first?.mediaKind || "");
    return kind === "video" || kind === "audio" ? kind : "image";
  }
  if (type === "group" || type === "promptGroup") return "group";
  if (type === "table" || type === "smart-table") return "table";
  if (type === "smart-batch") return "smart-batch";
  if (type === "smart-loop") return "smart-loop";
  if (type === "timeline") return "timeline";
  if (type === "scene3d") return "scene3d";
  if (type === "model3d" || type === "smart-model3d") return "model3d";
  if (type === "smart-image") return "image";
  if (type === "smart-video") return "video";
  if (type === "smart-audio") return "audio";
  if (type === "smart-text") return "text";
  if (type === "smart-group") return "group";
  return "note";
}

function legacyOutputs(raw: Row, kind: NodeKind): GenOutput[] {
  if (kind === "text") {
    const text = String(raw.outputText ?? raw.text ?? raw.content ?? "");
    return text ? [{ text }] : [];
  }
  const source = Array.isArray(raw.generatedOutputs) ? raw.generatedOutputs : Array.isArray(raw.images) ? raw.images : [];
  const rows = source.length ? source : [raw.url, ...(Array.isArray(raw.variants) ? raw.variants : [])];
  const seen = new Set<string>();
  return rows.map((item: any) => {
    const url = urlOf(item);
    if (!url || seen.has(url)) return null;
    seen.add(url);
    return {
      url,
      frame: item?.frame || item?.poster || item?.thumbnail || undefined,
      w: Number(item?.width) || undefined,
      h: Number(item?.height) || undefined,
      dur: Number(item?.duration) || undefined,
      meta: { model: String(raw.model || ""), at: Date.now() },
    };
  }).filter(Boolean) as GenOutput[];
}

function convertNode(item: unknown, index: number): CanvasNode | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Row;
  const kind = legacyKind(raw);
  const id = String(raw.id || `legacy_${index}`).slice(0, 64);
  const existingData = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : null;
  const migrated = !NODE_KINDS.has(raw.kind);
  const data = existingData ? { ...existingData } : migrated ? { legacy: raw } : undefined;
  const base: CanvasNode = {
    id,
    kind,
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    w: Number(raw.w ?? raw.width) || (kind === "video" ? 568 : 320),
    h: Number(raw.h ?? raw.height) || (kind === "note" ? 168 : 320),
    text: String(raw.text ?? raw.outputText ?? raw.content ?? raw.title ?? raw.name ?? ""),
    ...(raw.url ? { url: String(raw.url) } : {}),
    ...(raw.originalUrl ? { originalUrl: String(raw.originalUrl) } : {}),
    ...(Array.isArray(raw.variants) ? { variants: raw.variants.map(String) } : {}),
    ...(Array.isArray(raw.clips) ? { clips: raw.clips } : {}),
    ...(raw.scene && typeof raw.scene === "object" ? { scene: raw.scene } : {}),
    ...(raw.refUrl ? { refUrl: String(raw.refUrl) } : {}),
    ...(raw.model ? { model: String(raw.model) } : {}),
    ...(raw.ratio ? { ratio: String(raw.ratio) } : {}),
    ...(kind === "group" ? { children: (raw.children || raw.items || []).map(String) } : {}),
    ...(data ? { data } : {}),
  };
  if (!["text", "image", "video", "audio"].includes(kind) || existingData?.gen) return base;
  const hist = legacyOutputs(raw, kind);
  const provider = String(raw.apiProvider || raw.llmProvider || raw.provider_id || "comfly");
  const selected = String(raw.model || raw.llmMsModel || "");
  const params: any = defaultParams(kind as "text" | "image" | "video" | "audio");
  if (selected) params.model = modelId(provider, selected);
  if (kind === "image") {
    params.ratio = raw.ratio === "square" ? "1:1" : raw.ratio === "source" ? "auto" : String(raw.ratio || raw.size || "1:1");
    params.size = String(raw.resolution || "1k").toUpperCase();
    params.count = Math.max(1, Math.min(4, Number(raw.count) || 1));
  } else if (kind === "video") {
    params.ratio = String(raw.aspectRatio || raw.ratio || "16:9");
    params.res = String(raw.resolution || "720p");
    params.dur = Number(raw.duration) || 5;
    params.sound = !!raw.generateAudio;
  }
  return withGen(base, {
    title: String(raw.title || raw.name || (kind === "text" ? "文本" : kind === "image" ? "图片" : kind === "video" ? "视频" : "音频")),
    prompt: String(raw.prompt || raw.lastPrompt || raw.chatInput || (kind !== "text" ? raw.text || "" : "")),
    params,
    hist,
    hi: Math.max(0, hist.length - 1),
    order: [],
    ...(kind === "image" && !raw.generatedOutputs && raw.type === "image" ? { uploaded: true } : {}),
    ...(kind === "text" && raw.type === "prompt" ? { manual: true } : {}),
  });
}

export function serverDocToDoc(raw: unknown): { doc: CanvasDoc | null; migrated: boolean } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Row).nodes)) return { doc: null, migrated: false };
  const root = raw as Row;
  const nodes = root.nodes.map(convertNode).filter(Boolean) as CanvasNode[];
  const ids = new Set(nodes.map((node) => node.id));
  const sourceEdges = Array.isArray(root.connections) ? root.connections : Array.isArray(root.edges) ? root.edges : [];
  const edges = sourceEdges.map((item: any, index: number) => ({
    id: String(item?.id || `legacy_edge_${index}`),
    from: String(item?.from || item?.fromId || ""),
    to: String(item?.to || item?.toId || ""),
    ...(item?.fromSide === "left" || item?.fromSide === "right" ? { fromSide: item.fromSide } : {}),
  })).filter((edge: any) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const doc = sanitizeDoc({ nodes, edges, comments: Array.isArray(root.comments) ? root.comments : [], settings: root.settings });
  return { doc, migrated: root.nodes.some((node: any) => !NODE_KINDS.has(node?.kind)) };
}

export function docToServerDoc(doc: CanvasDoc): Row {
  return {
    nodes: doc.nodes.map((node) => ({
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
      ...(node.variants ? { variants: node.variants } : {}),
      ...(node.clips ? { clips: node.clips } : {}),
      ...(node.scene ? { scene: node.scene } : {}),
      ...(node.refUrl ? { refUrl: node.refUrl } : {}),
      ...(node.model ? { model: node.model } : {}),
      ...(node.ratio ? { ratio: node.ratio } : {}),
      ...(node.kind === "group" ? { children: node.children || [] } : {}),
      ...(node.data && typeof node.data === "object" ? { data: node.data } : {}),
    })),
    connections: doc.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, ...(edge.fromSide ? { fromSide: edge.fromSide } : {}) })),
    comments: doc.comments,
    settings: doc.settings || {},
  };
}

function metaOf(canvas: Row): CanvasMeta {
  return {
    title: String(canvas.title || "未命名画布"),
    icon: String(canvas.icon || "🧩"),
    viewport: canvas.viewport && typeof canvas.viewport === "object" ? canvas.viewport : { x: 0, y: 0, scale: 1 },
    logs: Array.isArray(canvas.logs) ? canvas.logs : [],
    updatedAt: Number(canvas.updated_at) || 0,
  };
}

function imageSize(params: ImageParams): string {
  // 原图比例：面板已按源图比例 + 尺寸档算好显式 WxH，直接用，不能再回落到 1:1
  const sourceSize = String(params.sourceSize || "").trim();
  if (/auto|自适应|source/i.test(params.ratio) && /^\d+x\d+$/.test(sourceSize)) return sourceSize;
  const long = /4k/i.test(params.size) ? 4096 : /2k/i.test(params.size) ? 2048 : 1024;
  const ratio = /auto|自适应|source/i.test(params.ratio) ? "1:1" : params.ratio;
  const [w, h] = ratioWH(ratio, long);
  return `${w}x${h}`;
}

async function pollTask(taskId: string, path: "image" | "video", signal: AbortSignal, onEvent: (event: GenEvent) => void, estimate: number): Promise<Row> {
  const started = Date.now();
  // 视频（seedance 等）常常要 10 分钟以上：只要后端任务还在处理就继续等，视频最多 40 分钟
  const limitMs = (path === "image" ? 10 : 40) * 60 * 1000;
  while (Date.now() - started < limitMs) {
    if (signal.aborted) {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, jsonBody({})).catch(() => null);
      throw new GenError("STOPPED", "已停止");
    }
    const data = await request(path === "image" ? `/api/canvas-image-tasks/${encodeURIComponent(taskId)}` : `/api/tasks/${encodeURIComponent(taskId)}`);
    onEvent({ type: "progress", progress: Math.min(.95, (Date.now() - started) / (estimate * 1000)) });
    if (data.status === "succeeded") return data.result || {};
    if (data.status === "failed" || data.status === "cancelled") throw new GenError(data.status === "cancelled" ? "STOPPED" : "FAILED", String(data.error || "生成失败"));
    await sleep(1200);
  }
  throw new GenError("TIMEOUT", `生成超时（${Math.round(limitMs / 60000)} 分钟）`);
}

async function createImageTask(req: GenRequest | EditRequest, prompt: string, params: ImageParams, references: Row[], signal: AbortSignal, onEvent: (event: GenEvent) => void, sizeOverride?: string): Promise<GenOutput[]> {
  const selected = splitModel(req.model?.id || "");
  // 质量档 / 先思考：只有用户在面板上明确选了才下发；不传 = 跟随上游默认
  const quality = qualityForRequest(params.quality);
  const thinking = thinkingForRequest(params.thinking);
  const outputFormat = outputFormatForRequest(params.outputFormat);
  // Midjourney 的版本 / HD 是独立字段（后端 OnlineImageRequest 只认这两个，速度与风格化走提示词 flag）
  const isMidjourneyModel = !!req.model?.mj;
  const mjVersion = isMidjourneyModel ? String(params.mj?.version || "").trim() : "";
  const mjHd = isMidjourneyModel && params.mj?.hd === true;
  const body = {
    prompt: prompt || "编辑参考图片",
    provider_id: selected.provider,
    model: selected.model,
    size: sizeOverride || imageSize(params),
    n: Math.max(1, Math.min(4, Number(params.count) || 1)),
    reference_images: references,
    ...(quality ? { quality } : {}),
    ...(thinking === undefined ? {} : { thinking_mode: thinking }),
    ...(outputFormat ? { output_format: outputFormat } : {}),
    ...(mjVersion ? { midjourney_version: mjVersion } : {}),
    ...(mjHd ? { midjourney_hd: true } : {}),
  };
  const task = await request("/api/canvas-image-tasks", { ...jsonBody(body), signal });
  if (!task.task_id) throw new GenError("NO_TASK", "生成任务没有返回任务 ID");
  onEvent({ type: "started", runId: String(task.task_id) });
  const result = await pollTask(String(task.task_id), "image", signal, onEvent, req.model?.secs || 20);
  const rows = Array.isArray(result.images) ? result.images : [];
  const outputs = rows.map((row: any) => ({ url: urlOf(row), w: Number(row?.width) || undefined, h: Number(row?.height) || undefined, meta: { model: req.model?.name || selected.model, ratio: params.ratio, size: params.size, at: Date.now(), runId: String(task.task_id) } })).filter((output: GenOutput) => output.url);
  if (!outputs.length) throw new GenError("NO_OUTPUT", "生成结果缺少图片地址");
  return outputs;
}

function textContent(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function createNovaiBackend(): CanvasBackend {
  const metadata = new Map<string, CanvasMeta>();
  let modelCache: Promise<ModelSpec[]> | null = null;
  let configCache: Promise<Row> | null = null;
  let capsCache: Promise<Map<string, ModelCapsItem>> | null = null;

  const config = () => {
    if (!configCache) configCache = request("/api/config").catch((error) => { configCache = null; capsCache = null; throw error; });
    return configCache;
  };

  /** 后端权威模型规格：best-effort，失败/404/超时都返回空表；缓存与 config 一起失效 */
  const loadCaps = (): Promise<Map<string, ModelCapsItem>> => {
    if (capsCache) return capsCache;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_CAPS_TIMEOUT_MS);
    capsCache = fetch("/api/model-caps", { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) return new Map<string, ModelCapsItem>();
        const data = await response.json().catch(() => ({}));
        return indexModelCaps(data?.items);
      })
      .catch(() => new Map<string, ModelCapsItem>())
      .finally(() => clearTimeout(timer));
    return capsCache;
  };

  const load = async (canvasId: string): Promise<LoadedDoc> => {
    const local = readDoc(canvasId);
    try {
      const data = await request(`/api/canvases/${encodeURIComponent(canvasId)}`);
      const canvas = data.canvas;
      if (!canvas) throw new GenError("CANVAS_EMPTY_RESPONSE", "画布响应为空");
      metadata.set(canvasId, metaOf(canvas));
      const parsed = serverDocToDoc({ nodes: canvas.nodes || [], connections: canvas.connections || [], comments: canvas.comments || [], settings: canvas.settings });
      if (!parsed.doc) throw new GenError("CANVAS_DOC_INVALID", "画布格式无效");
      if (parsed.migrated && local && hasContent(local)) return { doc: local, version: Number(canvas.updated_at) || 0, source: "bridge", migrated: true };
      if (!hasContent(parsed.doc) && local && hasContent(local)) return { doc: local, version: Number(canvas.updated_at) || 0, source: "bridge" };
      return { doc: parsed.doc, version: Number(canvas.updated_at) || 0, source: "bridge", migrated: parsed.migrated };
    } catch (error) {
      return { doc: local || emptyDoc(), version: null, source: "local", error: error instanceof Error ? error.message : "CANVAS_GET_FAILED" };
    }
  };

  const chat = async (req: { canvasId: string; configId?: string; effort?: "auto" | "low" | "high"; /** 模型强度档位（low/mid/high/xhigh/max）；空 = 不传 = 模型默认 */ thinkLevel?: string; messages: ChatMessage[]; images?: string[] }, onDelta: (full: string) => void, signal: AbortSignal): Promise<string> => {
    const selected = splitModel(req.configId || "");
    const lastIndex = req.messages.map((message) => message.role).lastIndexOf("user");
    const last = lastIndex >= 0 ? req.messages[lastIndex] : req.messages[req.messages.length - 1];
    const system = req.messages.filter((message) => message.role === "system").map((message) => textContent(message.content)).join("\n");
    const history = req.messages.filter((_, index) => index !== lastIndex && req.messages[index].role !== "system").map((message) => ({ role: message.role, content: textContent(message.content) }));
    const images = await Promise.all((req.images || []).map((url) => url.startsWith("data:") ? uploadAsset(url, "对话参考图") : Promise.resolve(url)));
    const body = {
      message: textContent(last?.content || "") || "请继续",
      system_prompt: system || "You are a helpful assistant.",
      model: selected.model,
      provider: selected.provider,
      ms_model: selected.provider === "modelscope" ? selected.model : "",
      messages: history,
      images,
      no_prompt_intelligence: true,
      // 空串 = 不传 = 默认；后端映射到上游 reasoning_effort / thinking budget，不支持时安全降级
      ...(req.thinkLevel ? { think_level: req.thinkLevel } : {}),
    };
    const response = await fetch("/api/canvas-llm/stream", { ...jsonBody(body), signal });
    if (response.status === 409 || !response.body) {
      const data = await request("/api/canvas-llm", { ...jsonBody(body), signal });
      const text = String(data.text || "");
      onDelta(text);
      return text;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new GenError(`HTTP_${response.status}`, errorText(data, `对话请求失败（${response.status}）`));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let finished = "";
    const consume = (line: string) => {
      const text = line.trim();
      if (!text.startsWith("data:")) return;
      try {
        const event = JSON.parse(text.slice(5).trim());
        if (event.type === "delta" && event.delta) {
          full += String(event.delta);
          onDelta(full);
        } else if (event.type === "done") finished = String(event.text || full);
        else if (event.type === "error") throw new GenError("MODEL_ERROR", String(event.detail || "对话失败"));
      } catch (error) {
        if (error instanceof GenError) throw error;
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consume);
      if (done) break;
    }
    consume(buffer);
    const result = finished || full;
    onDelta(result);
    return result;
  };

  const uploadAsset = async (dataUrl: string, name: string): Promise<string> => {
    if (!dataUrl.startsWith("data:")) return dataUrl;
    const data = await request("/api/ai/upload-base64", jsonBody({ data: dataUrl, name, content_type: dataUrl.slice(5).split(";", 1)[0] }));
    const url = urlOf(data.files?.[0]);
    if (!url) throw new GenError("ASSET_IMPORT_FAILED", "素材上传失败");
    return url;
  };

  const isLocalMediaUrl = (path: string) => /^\/(output|assets)\//.test(path);

  /**
   * 本地抠图 / 本地超分接口都只认 /output、/assets 下的本地文件：
   * data URL 先传进资源库；外站 http(s) 图先在浏览器里读成字节再上传（读不到时给可操作的提示）。
   * verb 只进提示文案，两套接口共用这一份源图归一。
   */
  const localMediaPath = async (sourceUrl: string, verb = "抠图"): Promise<string> => {
    if (isLocalMediaUrl(sourceUrl)) return sourceUrl;
    if (/^https?:\/\//i.test(sourceUrl)) {
      const abs = new URL(sourceUrl);
      if (typeof location !== "undefined" && abs.origin === location.origin && isLocalMediaUrl(abs.pathname)) return abs.pathname + abs.search;
      let blob: Blob;
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(String(response.status));
        blob = await response.blob();
      } catch {
        throw new GenError("MATTING_SOURCE_UNREADABLE", `这张图在外部服务器上、浏览器读不到：先把图片下载到本地再拖进画布，就能本地${verb}`);
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(blob);
      });
      const ref = await uploadAsset(dataUrl, `${verb}原图`);
      if (isLocalMediaUrl(ref)) return ref;
      throw new GenError("MATTING_SOURCE_UNAVAILABLE", `${verb}原图上传失败，请重试`);
    }
    if (sourceUrl.startsWith("data:")) {
      const ref = await uploadAsset(sourceUrl, `${verb}原图`);
      if (isLocalMediaUrl(ref)) return ref;
      throw new GenError("MATTING_SOURCE_UNAVAILABLE", `${verb}原图上传失败，请重试`);
    }
    throw new GenError("MATTING_SOURCE_UNAVAILABLE", `这张图还没有可${verb}的文件，等它生成完成再试`);
  };

  /** 后端报错 → 用户能看懂的文案（未下载 / 加载失败 / 图片太大） */
  const mattingError = (error: unknown): Error => {
    const err = error instanceof GenError ? error : new GenError("MATTING_FAILED", error instanceof Error ? error.message : "本地抠图失败");
    const status = /^HTTP_(\d+)$/.exec(err.code)?.[1] || "";
    const detail = err.message || "";
    if (status === "413" || /100MB/.test(detail)) return new GenError("MATTING_IMAGE_TOO_LARGE", "图片太大（超过 100MB），先压缩再抠图");
    if (status === "400" && /未下载/.test(detail)) return new GenError("MATTING_MODEL_MISSING", "本地抠图模型未下载：在抠图弹窗里下载模型后再试");
    if (status === "400") return new GenError("MATTING_SOURCE_UNAVAILABLE", detail || "这张图不支持本地抠图（支持 png / jpg / webp）");
    if (status === "404") return new GenError("MATTING_UNSUPPORTED", "当前后端没有本地抠图接口");
    if (status === "500") return new GenError("MATTING_LOAD_FAILED", detail || "本地抠图模型加载失败");
    return new GenError("MATTING_FAILED", detail || "本地抠图失败");
  };

  /** 超分接口报错 → 用户能看懂的文案（未安装 / 图片太大 / 格式不支持 / 超分失败） */
  const upscaleError = (error: unknown): Error => {
    const err = error instanceof GenError ? error : new GenError("UPSCALE_FAILED", error instanceof Error ? error.message : "本地超分失败");
    const status = /^HTTP_(\d+)$/.exec(err.code)?.[1] || "";
    const detail = err.message || "";
    // 老后端 / BEAT 桌面版没有这条路由
    if (status === "404") return new GenError("UPSCALE_UNSUPPORTED", "当前后端没有本地超分");
    if (status === "413" || /100MB/.test(detail)) return new GenError("UPSCALE_IMAGE_TOO_LARGE", "图片太大（超过 100MB），先压缩再超分");
    if (status === "400" && /未安装/.test(detail)) return new GenError("UPSCALE_RUNTIME_MISSING", "本地超分组件未安装：在「增强」里下载组件后再试");
    if (status === "400") return new GenError("UPSCALE_SOURCE_UNSUPPORTED", detail || "这张图不支持本地超分（支持 png / jpg / webp）");
    if (status === "500") return new GenError("UPSCALE_FAILED", detail || "本地超分失败");
    return new GenError("UPSCALE_FAILED", detail || "本地超分失败");
  };

  /** 本地 RMBG 抠图：返回透明 PNG（走已有的新版本写回路径） */
  const cutoutLocal = async (req: EditRequest, signal: AbortSignal): Promise<GenOutput> => {
    const path = await localMediaPath(req.sourceUrl);
    let data: Row;
    try {
      data = await request("/api/image/matting", { ...jsonBody({ url: path, mode: "local" }), signal });
    } catch (error) {
      if (signal.aborted) throw new GenError("STOPPED", "已停止");
      throw mattingError(error);
    }
    const url = urlOf(data);
    if (!url) throw new GenError("NO_OUTPUT", "抠图结果缺少图片地址");
    return { url, meta: { model: "本地抠图", at: Date.now() } };
  };

  /** 清晰度档 → 长边像素（1K=1024、2K=2048…；认不出的档返回 0，不当档用） */
  const tierLongEdge = (tier: string): number => {
    const text = String(tier || "").trim().toUpperCase();
    const k = /^(\d+(?:\.\d+)?)\s*K$/.exec(text);
    if (k) return Math.round(Number(k[1]) * 1024);
    const p = /^(\d+(?:\.\d+)?)\s*P$/.exec(text);
    return p ? Math.round(Number(p[1])) : 0;
  };
  /**
   * 编辑类请求（增强 / 重绘 / 擦除 / 标注 / 扩图）的请求尺寸：**源图真实比例** × 模型能接受的长边。
   *   · caps 给了 resolutions（或 exact_size = 精确像素模型）：按源图长边就近取档，长边封顶最大档，比例不变形；
   *   · caps 没给清晰度档：退回模型自己声明的档位，并带一句说明（上游可能再收敛）；
   *   · 读不到源图 / 一个可用档都没有：返回 null，调用方沿用旧逻辑（模型默认档）。
   */
  const editSizeFor = (model: ModelSpec, src: { w: number; h: number } | null, capsRes: string[] | null, exactPixels: boolean) => {
    if (!src || !(src.w > 0) || !(src.h > 0)) return null;
    const fromCaps = (capsRes || []).map((tier) => ({ tier, long: tierLongEdge(tier) })).filter((x) => x.long > 0);
    const fromSpec = (model.sizes || []).map((tier) => ({ tier, long: tierLongEdge(tier) })).filter((x) => x.long > 0);
    const tiers = fromCaps.length ? fromCaps : fromSpec;
    if (!tiers.length) return null;
    const srcLong = Math.max(src.w, src.h);
    const sorted = tiers.slice().sort((a, b) => a.long - b.long);
    const picked = sorted.find((t) => t.long >= srcLong) || sorted[sorted.length - 1];
    const long = picked.long;
    const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
    const w = src.w >= src.h ? long : even((long * src.w) / src.h);
    const h = src.w >= src.h ? even((long * src.h) / src.w) : long;
    const authoritative = fromCaps.length > 0 || exactPixels;
    return {
      size: `${w}x${h}`,
      note: authoritative ? "" : `该模型没给权威清晰度档，按声明档位 ${picked.tier} 换算原图比例，上游可能再收敛`,
    };
  };
  /**
   * 生成前要用的 caps 条目。模型列表那条 1s 超时的 best-effort 缓存可能只是「那次请求超时了」，
   * 直接当成「模型没有上限」会让钳制静默失效（实测同一个节点一次 3840x2160、一次 4096x2304），
   * 所以缓存是空表时在真正发请求前再等一次，拿到就顺手把列表缓存也修好。
   */
  const capsItemFor = async (provider: string, model: string): Promise<ModelCapsItem | undefined> => {
    const key = modelCapsKey(provider, model);
    const cached = await loadCaps();
    if (cached.get(key) || cached.size) return cached.get(key);
    try {
      const response = await fetch("/api/model-caps", { headers: { Accept: "application/json" } });
      if (!response.ok) return undefined;
      const data = await response.json().catch(() => ({}));
      const fresh = indexModelCaps(data?.items);
      capsCache = Promise.resolve(fresh);
      return fresh.get(key);
    } catch { return undefined; }
  };

  /**
   * 请求尺寸收进模型允许的范围（/api/model-caps 的 max_long_edge / max_pixels / min_pixels，
   * 目前是 GPT-Image 家族：长边 3840、总像素约 829 万）。超限的 4K 16:9 直接发出去会被上游 400 拒掉，
   * 所以在组装阶段就等比缩到上限内；模型没声明上限时原样发送（后端按档位换算）。
   */
  const requestImageSize = async (model: ModelSpec, size: string): Promise<string> => {
    const selected = splitModel(model.id);
    const item = await capsItemFor(selected.provider, selected.model);
    if (!item) return size;
    const out = clampImageSize(size, { maxLongEdge: Number(item.max_long_edge) || 0, maxPixels: Number(item.max_pixels) || 0, minPixels: Number(item.min_pixels) || 0 });
    return out.size || size;
  };
  /** Midjourney 只收单行纯文本：markdown / 换行 / `--` 会被当成参数解析（后端 adapter 也清一遍） */
  const isMidjourney = (model: ModelSpec) => /midjourney|\bmj\b/i.test(model.name || "");
  const promptForModel = (model: ModelSpec, prompt: string): string => {
    if (!isMidjourney(model)) return prompt;
    const cleaned = midjourneyPrompt(prompt);
    if (!cleaned) throw new GenError("PROMPT_EMPTY", "提示词里没有能发给 Midjourney 的内容（只有格式符号）：写一句画面描述再试");
    return cleaned;
  };
  /** 读源图尺寸并按编辑类型换算请求尺寸（扩图用「扩展后的目标画布」比例） */
  const editSizing = async (req: EditRequest, model: ModelSpec) => {
    let src = await loadImageSize(req.sourceUrl);
    const raw = (req.params || {}) as Record<string, unknown>;
    const ext = raw.ext as { l?: number; t?: number; r?: number; b?: number } | undefined;
    if (src && req.op === "outpaint" && ext && raw.prepadded !== true) {
      // 还没合成扩边时（桌面包的扩图走法）：按扩展比例放大到目标画布
      const w = src.w * (1 + (Number(ext.l) || 0) + (Number(ext.r) || 0));
      const h = src.h * (1 + (Number(ext.t) || 0) + (Number(ext.b) || 0));
      src = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    }
    let capsRaw: (ModelCapsItem & { exact_size?: unknown }) | undefined;
    try {
      const caps = await loadCaps();
      const selected = splitModel(model.id);
      capsRaw = caps.get(modelCapsKey(selected.provider, selected.model)) as (ModelCapsItem & { exact_size?: unknown }) | undefined;
    } catch { capsRaw = undefined; }
    const capsRes = Array.isArray(capsRaw?.resolutions) ? (capsRaw!.resolutions as unknown[]).map((x) => String(x)) : null;
    return editSizeFor(model, src, capsRes, capsRaw?.exact_size === true);
  };

  return {
    kind: "bridge",
    available: () => true,
    listModels() {
      if (modelCache) return modelCache;
      modelCache = (async () => {
        const capsPromise = loadCaps();
        const cfg = await config();
        const caps = await capsPromise;
        const out: ModelSpec[] = [];
        const seen = new Set<string>();
        const providers = (Array.isArray(cfg.api_providers) ? cfg.api_providers : []).filter((provider: Row) => {
          if (provider.enabled === false) return false;
          const protocol = String(provider.protocol || "").toLowerCase();
          const local = /local|ollama|comfy|本机/i.test(String(provider.id || provider.name || ""));
          return provider.has_key === true || provider.has_wallet_key === true || local || ["jimeng", "codex", "gemini-cli"].includes(protocol);
        });
        for (const provider of providers) {
          const providerId = String(provider.id || "comfly");
          const groups: Array<["text" | "image" | "video" | "audio", string]> = [["text", "chat_models"], ["image", "image_models"], ["video", "video_models"], ["audio", "audio_models"]];
          for (const [kind, field] of groups) {
            const models = Array.isArray(provider[field]) ? provider[field] : [];
            for (const value of models) {
              const name = String(value || "").trim();
              const id = modelId(providerId, name);
              if (!name || seen.has(id)) continue;
              seen.add(id);
              const capsItem = kind === "image" || kind === "video" ? caps.get(modelCapsKey(providerId, name)) : undefined;
              let capsUi = kind === "image" || kind === "video" ? modelCapsUi(kind, capsItem) : null;
              const vendor = String(provider.name || providerId);
              if (capsUi && (kind === "image" || kind === "video")) {
                // caps 只给参数；参考图能力沿用官方/预设，避免权威参数一上就把所有模型的参考图入口误关
                const official = kind === "image" ? officialImageUi(name) : null;
                const guessed = specFor({ configId: id, label: name, vendor, kind, ui: null });
                capsUi = mergeCapsReferenceCapability(kind, capsUi, { ...guessed, ...(official || {}) });
              }
              const ui = capsUi || (kind === "image" ? officialImageUi(name) : null);
              // 模型强度档位的真值源：/api/config 里 provider.model_caps[模型名].think（后端没下发 = 不支持，面板不给入口）
              const think = kind === "text" ? provider?.model_caps?.[name]?.think : undefined;
              out.push(specFor({ configId: id, label: name, vendor: String(provider.name || providerId), kind, local: /local|ollama|comfy|本机/i.test(providerId), think, vision: kind === "text" && /vl|vision|gemini|gpt-4o|gpt-5|claude|qwen/i.test(name), ui, specSource: ui ? "spec" : undefined }));
            }
          }
        }
        return out;
      })();
      modelCache.catch(() => { modelCache = null; });
      return modelCache;
    },
    onModelsChanged(cb) {
      const invalidate = () => { modelCache = null; configCache = null; capsCache = null; cb(); };
      const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("studio-api") : null;
      channel?.addEventListener("message", invalidate);
      window.addEventListener("message", invalidate);
      window.addEventListener("focus", invalidate);
      return () => { channel?.removeEventListener("message", invalidate); channel?.close(); window.removeEventListener("message", invalidate); window.removeEventListener("focus", invalidate); };
    },
    loadDoc: load,
    async renameCanvas(canvasId, title) {
      const current = await request(`/api/canvases/${encodeURIComponent(canvasId)}`);
      const canvas = current.canvas || {};
      const data = await request(`/api/canvases/${encodeURIComponent(canvasId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          icon: canvas.icon || "🧩",
          nodes: canvas.nodes || [],
          connections: canvas.connections || [],
          viewport: canvas.viewport || {},
          logs: canvas.logs || [],
          settings: canvas.settings || {},
          base_updated_at: Number(canvas.updated_at) || 0,
        }),
      });
      if (data.canvas) metadata.set(canvasId, metaOf(data.canvas));
      return data.canvas;
    },
    async readAuthoritativeDoc(canvasId) {
      const loaded = await load(canvasId);
      if (loaded.source !== "bridge") throw new GenError("CANVAS_GET_FAILED", loaded.error || "无法重读权威画布");
      return loaded;
    },
    async saveDoc(canvasId, doc, baseVersion): Promise<SavedDoc> {
      // 本机镜像不再和保存同步做：空闲时补写（见 localMirror.ts），文档没变就不写，过大也不写
      queueLocalMirror(canvasId, doc);
      let meta = metadata.get(canvasId);
      if (!meta) {
        const data = await request(`/api/canvases/${encodeURIComponent(canvasId)}`);
        meta = metaOf(data.canvas || {});
        metadata.set(canvasId, meta);
      }
      const payload = { title: meta.title, icon: meta.icon, ...docToServerDoc(doc), viewport: meta.viewport, logs: meta.logs, base_updated_at: baseVersion || 0, client_id: `novai-${Date.now()}` };
      const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const canvas = data.canvas || {};
        metadata.set(canvasId, metaOf(canvas));
        return { ok: true, version: Number(canvas.updated_at) || baseVersion };
      }
      if (response.status === 409) {
        const remoteCanvas = data.detail?.canvas;
        const parsed = remoteCanvas ? serverDocToDoc(remoteCanvas) : null;
        if (remoteCanvas) metadata.set(canvasId, metaOf(remoteCanvas));
        return { ok: false, conflict: true, remote: parsed?.doc || undefined, remoteVersion: Number(remoteCanvas?.updated_at || data.detail?.updated_at) || undefined, error: errorText(data, "画布版本冲突") };
      }
      return { ok: false, conflict: false, error: errorText(data, `保存失败（${response.status}）`) };
    },
    async generate(req, onEvent, signal): Promise<GenResult> {
      if (req.kind === "text") {
        const context = req.inputs.filter((input) => input.text).map((input) => `【输入 ${input.order + 1}：${input.title}】\n${input.text}`).join("\n\n");
        const text = await chat({ canvasId: req.canvasId, configId: req.model.id, thinkLevel: (req.params as TextParams).think, messages: [{ role: "user", content: (context ? context + "\n\n" : "") + (req.resolvedPrompt || "请整理上面的输入") }], images: req.model.vision ? req.inputs.filter((input) => input.kind === "image" && input.url).map((input) => input.url!) : [] }, (full) => onEvent({ type: "text", text: full }), signal);
        return { outputs: [{ text, meta: { model: req.model.name, at: Date.now() } }] };
      }
      const refs = await Promise.all(req.inputs.filter((input) => input.url).map(async (input) => ({ url: await uploadAsset(input.url!, input.title), name: input.title, role: input.role, kind: input.kind })));
      if (req.kind === "image") {
        const prompt = promptForModel(req.model, req.resolvedPrompt);
        const size = await requestImageSize(req.model, imageSize(req.params as ImageParams));
        return { outputs: await createImageTask(req, prompt, req.params as ImageParams, refs.filter((ref) => ref.kind === "image"), signal, onEvent, size) };
      }
      if (req.kind === "video") {
        const selected = splitModel(req.model.id);
        const params = req.params as VideoParams;
        // caps 声明没有分辨率档位（如 Context-IR）：不要硬塞默认 720p
        const declaresResolution = (req.model.res || []).length > 0;
        const body = {
          prompt: req.resolvedPrompt,
          provider_id: selected.provider,
          model: selected.model,
          duration: params.dur,
          aspect_ratio: params.ratio,
          ...(declaresResolution ? { resolution: params.res } : {}),
          images: refs.filter((ref) => ref.kind === "image"),
          videos: refs.filter((ref) => ref.kind === "video").map((ref) => ({ url: ref.url, role: ref.role })),
          audios: refs.filter((ref) => ref.kind === "audio").map((ref) => ref.url),
          generate_audio: !!params.sound,
        };
        const task = await request("/api/canvas-video?async=1", { ...jsonBody(body), signal });
        if (!task.task_id) throw new GenError("NO_TASK", "视频任务没有返回任务 ID");
        onEvent({ type: "started", runId: String(task.task_id) });
        const result = await pollTask(String(task.task_id), "video", signal, onEvent, req.model.secs || 120);
        const rows = Array.isArray(result.videos) ? result.videos : [];
        const outputs = rows.map((row: any) => ({ url: urlOf(row), frame: row?.poster || row?.thumbnail || undefined, dur: Number(row?.duration) || params.dur, res: params.res, meta: { model: req.model.name, at: Date.now(), runId: String(task.task_id) } })).filter((output: GenOutput) => output.url);
        if (!outputs.length) {
          // 只出提示词的模型（如 Context-IR）：后端把结构化提示词放在 result.prompt，没有视频。
          // 明确报错并带上提示词，节点不会卡在「生成中」，用户也能把结果喂回 H3。
          const promptText = String(result.prompt ?? result.text ?? result.prompt_text ?? "").trim();
          if (promptText || req.model.promptOnly) {
            throw new GenError("PROMPT_ONLY", "该模型只返回提示词，不会出视频" + (promptText ? "：" + promptText.slice(0, 600) : "（本次没有拿到提示词，请重试）"));
          }
          throw new GenError("NO_OUTPUT", "生成结果缺少视频地址");
        }
        return { outputs, runId: String(task.task_id) };
      }
      const selected = splitModel(req.model.id);
      const params = req.params as any;
      const tts = /tts|speech|voice|gpt-audio|audio-preview/i.test(selected.model);
      const endpoint = tts ? "/api/canvas-tts" : "/api/canvas-audio";
      const payload = tts
        ? { input: req.resolvedPrompt, provider_id: selected.provider, model: selected.model, voice: "alloy", response_format: "wav" }
        : { prompt: req.resolvedPrompt, provider_id: selected.provider, model: selected.model, custom: params.kind === "音乐", instrumental: false, duration: Number.parseInt(params.dur) || null };
      const result = await request(endpoint, { ...jsonBody(payload), signal });
      const outputs = (Array.isArray(result.audios) ? result.audios : []).map((row: any) => ({ url: urlOf(row), dur: Number(row?.duration) || undefined, meta: { model: req.model.name, at: Date.now() } })).filter((output: GenOutput) => output.url);
      if (!outputs.length) throw new GenError("NO_OUTPUT", "生成结果缺少音频地址");
      return { outputs };
    },
    async editImage(req, onEvent, signal) {
      // 抠图改成本地 RMBG，不走生图模型；接口不存在的旧后端退回原来的在线抠图
      if (req.op === "cutout") {
        try {
          return await cutoutLocal(req, signal);
        } catch (error) {
          if (!(error instanceof GenError) || error.code !== "MATTING_UNSUPPORTED") throw error;
        }
      }
      const models = await this.listModels();
      const model = req.model || models.find((item) => item.kind === "image");
      if (!model) throw new GenError("MODEL_REQUIRED", "没有可用的图片模型");
      const prompts: Record<string, string> = {
        redraw: "只重绘遮罩标记的区域，其余画面保持不变",
        erase: "移除遮罩标记区域里的内容并自然补全背景",
        annotate: "按参考图中的标注修改图片，输出完整图片且不要保留标注",
        angle: "保持同一主体和场景，切换到新的拍摄视角",
        relight: "保持画面内容和构图不变，只重新调整光照",
        outpaint: "扩展画面并自然补全透明区域，保持原图内容不变",
        enhance: "将图片高清增强，提升细节和清晰度，内容保持不变",
        cutout: "完整保留主体并移除背景，输出透明背景图片",
      };
      const params = { ...defaultParams("image", model), count: 1 } as ImageParams;
      // 编辑请求按源图真实比例要尺寸（不再固定方图）；扩图的源图是「原图 + 透明扩展」的合成图，天然是目标比例
      const sizing = await editSizing(req, model).catch(() => null);
      const references = [{ url: await uploadAsset(req.sourceUrl, "编辑原图"), name: "编辑原图", kind: "image" }];
      if (req.maskDataUrl) references.push({ url: await uploadAsset(req.maskDataUrl, "编辑遮罩"), name: "编辑遮罩", kind: "image" });
      const size = await requestImageSize(model, sizing?.size || imageSize(params));
      const outputs = await createImageTask({ ...req, model }, promptForModel(model, `${prompts[req.op] || "编辑图片"}。${req.prompt || ""}`), params, references, signal, onEvent, size);
      const out = outputs[0];
      if (!out || !sizing?.note) return out;
      return { ...out, meta: { ...(out.meta || {}), sizeNote: sizing.note } as GenOutput["meta"] & { sizeNote?: string } };
    },
    chat,
    async runAgentTask(req) {
      const command = hostRoot<any>()?.task?.command;
      if (!command) return { ok: false, error: "TASK_UNAVAILABLE" };
      const result = await command({ type: "task/run", payload: { goal: req.goal, canvasContext: req.context } }).catch(() => null);
      return result ? { ok: result.ok === true, taskId: typeof result.taskId === "string" ? result.taskId : undefined, status: typeof result.status === "string" ? result.status : undefined, error: typeof result.error === "string" ? result.error : undefined } : { ok: false, error: "TASK_UNAVAILABLE" };
    },
    watchAgentTask(taskId, onSnapshot) {
      let active = true; let reading = false; let queued = false;
      const refresh = async () => {
        if (!active) return;
        if (reading) { queued = true; return; }
        reading = true;
        try {
          const command = hostRoot<any>()?.task?.command;
          if (!command) return;
          const result = await command({ type: "task/get", payload: { taskId } });
          if (!active || !result || result.ok !== true || !result.task) return;
          onSnapshot({ taskId, status: String(result.task.status || ""), modelConfigId: typeof result.task.modelConfigId === "string" ? result.task.modelConfigId : null, steps: Array.isArray(result.steps) ? result.steps : [], events: Array.isArray(result.events) ? result.events : [], calls: Array.isArray(result.calls) ? result.calls : [], artifacts: Array.isArray(result.artifacts) ? result.artifacts : [], verifications: Array.isArray(result.verifications) ? result.verifications : [], plan: result.plan && typeof result.plan === "object" ? result.plan : null, error: typeof result.error === "string" ? result.error : undefined });
        } finally {
          reading = false;
          if (queued) { queued = false; void refresh(); }
        }
      };
      const timer = setInterval(() => void refresh(), 750);
      void refresh();
      return () => { active = false; clearInterval(timer); };
    },
    async approveAgentTask(taskId, steps) {
      const command = hostRoot<any>()?.task?.command;
      if (!command) return { ok: false, error: "TASK_UNAVAILABLE" };
      const result = await command({ type: "task/approve", payload: { taskId, steps } }).catch(() => null);
      return result ? { ok: result.ok === true, taskId: typeof result.taskId === "string" ? result.taskId : undefined, status: typeof result.status === "string" ? result.status : undefined, error: typeof result.error === "string" ? result.error : undefined } : { ok: false, error: "TASK_UNAVAILABLE" };
    },
    async cancelAgentTask(taskId) {
      const command = hostRoot<any>()?.task?.command;
      if (!command) return { ok: false, error: "TASK_UNAVAILABLE" };
      const result = await command({ type: "task/cancel", payload: { taskId } }).catch(() => null);
      return result ? { ok: result.ok === true, error: typeof result.error === "string" ? result.error : undefined } : { ok: false, error: "TASK_UNAVAILABLE" };
    },
    async defaultChatModel() {
      const models = await this.listModels();
      // 只用用户在助手面板里选过的模型（服务端记着，换画布 / 重启都在）
      const saved = await request("/api/agent/default-model").then((row: Row) => String(row?.model || "")).catch(() => "");
      if (saved && models.some((model) => model.kind === "text" && model.id === saved)) return saved;
      // 用户没选过就不默认任何模型（不拿列表第一个兜底），由面板提示用户自己选
      return null;
    },
    async setDefaultChatModel(id) {
      await request("/api/agent/default-model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id || "" }) });
    },
    async importAsset(_canvasId, dataUrl, name) { return uploadAsset(dataUrl, name); },
    async importRemote(_canvasId, url) { return url; },
    async resolveAsset(ref) { return ref || null; },
    async mattingModelStatus(): Promise<MattingModelStatus> {
      const data = await request("/api/matting/model/status");
      return {
        downloaded: data?.downloaded === true,
        downloading: data?.downloading === true,
        verifying: data?.verifying === true,
        progress: Number(data?.progress) || 0,
        downloaded_mb: Number(data?.downloaded_mb) || 0,
        total_mb: Number(data?.total_mb) || 0,
        model_size_mb: Number(data?.model_size_mb) || 0,
        speed_mbps: Number(data?.speed_mbps) || 0,
        eta_seconds: Number(data?.eta_seconds) || 0,
        attempt: Number(data?.attempt) || 0,
        retrying: data?.retrying === true,
        hint: String(data?.hint || ""),
        cancelled: data?.cancelled === true,
        error: String(data?.error || ""),
        load_error: String(data?.load_error || ""),
      };
    },
    async mattingModelDownload() {
      const data = await request("/api/matting/model/download", jsonBody({}));
      return { ok: data?.ok !== false, downloaded: data?.downloaded === true, error: typeof data?.error === "string" ? data.error : undefined };
    },
    async mattingModelCancel() {
      const data = await request("/api/matting/model/cancel", jsonBody({})).catch(() => null);
      return { ok: data?.ok === true };
    },
    async upscaleRuntimeStatus(): Promise<UpscaleRuntimeStatus> {
      const data = await request("/api/image/upscale/runtime");
      return {
        installed: data?.installed === true,
        downloading: data?.downloading === true,
        progress: Number(data?.progress) || 0,
        message: String(data?.message || ""),
        platform: String(data?.platform || ""),
      };
    },
    async upscaleRuntimeDownload() {
      const data = await request("/api/image/upscale/runtime/download", jsonBody({}));
      return { ok: data?.ok !== false, installed: data?.installed === true, error: typeof data?.error === "string" ? data.error : undefined };
    },
    /** 本地超分：2k = 长边 2048、4k = 4096；skipped 表示原图已经够大，url 指回原图 */
    async upscaleLocal(sourceUrl, target): Promise<UpscaleResult> {
      const path = await localMediaPath(sourceUrl, "超分");
      let data: Row;
      try {
        data = await request("/api/image/upscale", jsonBody({ url: path, target }));
      } catch (error) {
        throw upscaleError(error);
      }
      const url = urlOf(data);
      if (!url) throw new GenError("NO_OUTPUT", "超分结果缺少图片地址");
      return {
        url,
        w: Number(data.width) || undefined,
        h: Number(data.height) || undefined,
        meta: { model: target === "4k" ? "本地超分 4K" : "本地超分 2K", at: Date.now() },
        skipped: data.skipped === true,
      };
    },
  };
}
