import type { CanvasBackend, ChatMessage, EditRequest, GenEvent, GenRequest, GenResult, LoadedDoc, SavedDoc } from "./canvas/canvas-next/backend/types";
import { GenError } from "./canvas/canvas-next/backend/types";
import { defaultParams, ratioWH, specFor, withGen, type GenOutput, type ImageParams, type ModelSpec, type VideoParams } from "./canvas/canvas-next/model";
import { emptyDoc, hasContent, readDoc, sanitizeDoc, writeDoc, type CanvasDoc, type CanvasNode, type NodeKind } from "./canvas/react-canvas/reactCanvasStore";

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
  const long = /4k/i.test(params.size) ? 4096 : /2k/i.test(params.size) ? 2048 : 1024;
  const ratio = /auto|自适应/i.test(params.ratio) ? "1:1" : params.ratio;
  const [w, h] = ratioWH(ratio, long);
  return `${w}x${h}`;
}

async function pollTask(taskId: string, path: "image" | "video", signal: AbortSignal, onEvent: (event: GenEvent) => void, estimate: number): Promise<Row> {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
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
  throw new GenError("TIMEOUT", "生成超时（10 分钟）");
}

async function createImageTask(req: GenRequest | EditRequest, prompt: string, params: ImageParams, references: Row[], signal: AbortSignal, onEvent: (event: GenEvent) => void): Promise<GenOutput[]> {
  const selected = splitModel(req.model?.id || "");
  const body = {
    prompt: prompt || "编辑参考图片",
    provider_id: selected.provider,
    model: selected.model,
    size: imageSize(params),
    quality: "auto",
    n: Math.max(1, Math.min(4, Number(params.count) || 1)),
    reference_images: references,
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

  const config = () => {
    if (!configCache) configCache = request("/api/config").catch((error) => { configCache = null; throw error; });
    return configCache;
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

  const chat = async (req: { canvasId: string; configId?: string; effort?: "auto" | "low" | "high"; messages: ChatMessage[]; images?: string[] }, onDelta: (full: string) => void, signal: AbortSignal): Promise<string> => {
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

  return {
    kind: "bridge",
    available: () => true,
    listModels() {
      if (modelCache) return modelCache;
      modelCache = (async () => {
        const cfg = await config();
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
              const ui = kind === "image" ? officialImageUi(name) : null;
              out.push(specFor({ configId: id, label: name, vendor: String(provider.name || providerId), kind, local: /local|ollama|comfy|本机/i.test(providerId), vision: kind === "text" && /vl|vision|gemini|gpt-4o|gpt-5|claude|qwen/i.test(name), ui, specSource: ui ? "spec" : undefined }));
            }
          }
        }
        return out;
      })();
      modelCache.catch(() => { modelCache = null; });
      return modelCache;
    },
    onModelsChanged(cb) {
      const invalidate = () => { modelCache = null; configCache = null; cb(); };
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
      writeDoc(canvasId, doc);
      let meta = metadata.get(canvasId);
      if (!meta) {
        const data = await request(`/api/canvases/${encodeURIComponent(canvasId)}`);
        meta = metaOf(data.canvas || {});
        metadata.set(canvasId, meta);
      }
      const payload = { title: meta.title, icon: meta.icon, ...docToServerDoc(doc), viewport: meta.viewport, logs: meta.logs, base_updated_at: baseVersion || 0, client_id: `openarc-${Date.now()}` };
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
        const text = await chat({ canvasId: req.canvasId, configId: req.model.id, messages: [{ role: "user", content: (context ? context + "\n\n" : "") + (req.resolvedPrompt || "请整理上面的输入") }], images: req.model.vision ? req.inputs.filter((input) => input.kind === "image" && input.url).map((input) => input.url!) : [] }, (full) => onEvent({ type: "text", text: full }), signal);
        return { outputs: [{ text, meta: { model: req.model.name, at: Date.now() } }] };
      }
      const refs = await Promise.all(req.inputs.filter((input) => input.url).map(async (input) => ({ url: await uploadAsset(input.url!, input.title), name: input.title, role: input.role, kind: input.kind })));
      if (req.kind === "image") return { outputs: await createImageTask(req, req.resolvedPrompt, req.params as ImageParams, refs.filter((ref) => ref.kind === "image"), signal, onEvent) };
      if (req.kind === "video") {
        const selected = splitModel(req.model.id);
        const params = req.params as VideoParams;
        const body = {
          prompt: req.resolvedPrompt,
          provider_id: selected.provider,
          model: selected.model,
          duration: params.dur,
          aspect_ratio: params.ratio,
          resolution: params.res,
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
        if (!outputs.length) throw new GenError("NO_OUTPUT", "生成结果缺少视频地址");
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
      const references = [{ url: await uploadAsset(req.sourceUrl, "编辑原图"), name: "编辑原图", kind: "image" }];
      if (req.maskDataUrl) references.push({ url: await uploadAsset(req.maskDataUrl, "编辑遮罩"), name: "编辑遮罩", kind: "image" });
      const outputs = await createImageTask({ ...req, model }, `${prompts[req.op] || "编辑图片"}。${req.prompt || ""}`, params, references, signal, onEvent);
      return outputs[0];
    },
    chat,
    async runAgentTask(req) {
      const command = (window as any).openarc?.task?.command;
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
          const command = (window as any).openarc?.task?.command;
          if (!command) return;
          const result = await command({ type: "task/get", payload: { taskId } });
          if (!active || !result || result.ok !== true || !result.task) return;
          onSnapshot({ taskId, status: String(result.task.status || ""), modelConfigId: typeof result.task.modelConfigId === "string" ? result.task.modelConfigId : null, steps: Array.isArray(result.steps) ? result.steps : [], events: Array.isArray(result.events) ? result.events : [], calls: Array.isArray(result.calls) ? result.calls : [], artifacts: Array.isArray(result.artifacts) ? result.artifacts : [], verifications: Array.isArray(result.verifications) ? result.verifications : [], error: typeof result.error === "string" ? result.error : undefined });
        } finally {
          reading = false;
          if (queued) { queued = false; void refresh(); }
        }
      };
      const timer = setInterval(() => void refresh(), 750);
      void refresh();
      return () => { active = false; clearInterval(timer); };
    },
    async cancelAgentTask(taskId) {
      const command = (window as any).openarc?.task?.command;
      if (!command) return { ok: false, error: "TASK_UNAVAILABLE" };
      const result = await command({ type: "task/cancel", payload: { taskId } }).catch(() => null);
      return result ? { ok: result.ok === true, error: typeof result.error === "string" ? result.error : undefined } : { ok: false, error: "TASK_UNAVAILABLE" };
    },
    async defaultChatModel() {
      const cfg = await config();
      const wanted = String(cfg.chat_model || "");
      const models = await this.listModels();
      return models.find((model) => model.kind === "text" && splitModel(model.id).model === wanted)?.id || models.find((model) => model.kind === "text")?.id || null;
    },
    async importAsset(_canvasId, dataUrl, name) { return uploadAsset(dataUrl, name); },
    async importRemote(_canvasId, url) { return url; },
    async resolveAsset(ref) { return ref || null; },
  };
}
