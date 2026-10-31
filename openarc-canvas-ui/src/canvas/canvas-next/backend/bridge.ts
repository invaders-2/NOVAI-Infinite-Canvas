/**
 * 真后端：桌面版 OpenArc。画布作为 ReactIsland 嵌入 React 外壳，window.openarc.canvas / model
 * 由宿主 preload 直接提供，命令全部由现有主进程实现：
 *
 *   canvas/models                 模型清单（configId / remoteModelId / displayName / providerName / capabilities / status）
 *   canvas/run → runId            每次生成先开一个 Task（预算 / 停止 / 审计归属）
 *   canvas/modelChatStream        文本流式；增量经 window.openarc.model.onEvent（payload.type = "canvas.stream"）
 *   canvas/modelImage             图片；async:true 时返回 runId，之后轮询 canvas/runStatus
 *   canvas/modelImageEdit         有参考图时走编辑（sourceDataUrl）
 *   canvas/nodes/execute          视频 / 音频（builtin.video-generator / builtin.audio-generator）
 *   canvas/runStatus / runStop / runFinish
 *   canvas/get / canvas/save      复用 react-canvas/persistence.ts（含 409 冲突与旧格式迁移）
 *   canvas/importAsset / readAsset  资源库（画布文档只存 openarc-asset:<ref>，不存大段 data URL）
 *
 * 后端暂不认识的新字段（风格、摄影机、视频 modelType、首尾帧角色……）照样带上，主进程忽略即可；
 * 不支持的能力由后端结构化错误如实返回，不在前端伪造成功。
 */
import { buildCanvasModelLabelIndex, canvasModelBaseName } from "../../canvasModelLabels";
import { loadDoc as loadDocLegacy, saveDoc as saveDocLegacy, serverDocToDoc } from "../../react-canvas/persistence";
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";
import { CAMERAS, ratioWH, specFor, styleForRequest, type GenKind, type GenOutput, type ImageParams, type ModelSpec, type VideoParams, type AudioParams, type TextParams } from "../model";
import { GenError, type EditRequest, type CanvasBackend, type ChatMessage, type ChatPart, type GenEvent, type GenRequest, type GenResult, type LoadedDoc, type SavedDoc, type AgentTaskSnapshot } from "./types";

type Cmd = (request: Record<string, unknown>) => Promise<Record<string, any>>;
type OpenArc = { canvas?: { command?: Cmd }; model?: { command?: Cmd; onEvent?: (cb: (event: unknown) => void) => () => void }; task?: { command?: Cmd; onEvent?: (cb: (event: any) => void) => () => void } };
const oa = (): OpenArc | undefined => (window as unknown as { openarc?: OpenArc }).openarc;
const canvasCmd = (): Cmd | null => { const c = oa()?.canvas?.command; return typeof c === "function" ? c : null; };
const modelCmd = (): Cmd | null => { const c = oa()?.model?.command || oa()?.canvas?.command; return typeof c === "function" ? c : null; };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (res: any, fallback: string) => String((res && (res.detail || res.error)) || fallback);
/** 参考图上限：与主进程 canvas/modelImageEdit 的截断一致（模型能力表里最多 16 张） */
const MAX_REFS = 16;
const CAP: Record<GenKind, string> = { image: "image-generation", video: "video-generation", audio: "audio-generation", text: "chat" };

/**
 * 生成失败诊断：把失败事实交给主进程 canvas/diagLog 落盘（userData/logs/canvas-errors.log）。
 * 只报 { at, canvasId, nodeId, kind, code, detail, stage }；凭据 / URL userinfo 由主进程再脱敏。
 * fire-and-forget：日志写不进去也不能改变生成结果（更不能再抛一个错）。
 * 用户主动停止（STOPPED）不算失败，不记。
 */
function reportGenFailure(stage: string, input: { canvasId?: unknown; nodeId?: unknown; kind?: unknown } | null, error: unknown): void {
  const cmd = canvasCmd();
  if (!cmd) return;
  const code = error instanceof GenError ? error.code : String((error as { code?: unknown })?.code || "GEN_FAILED");
  if (code === "STOPPED") return;
  const detail = String((error as { message?: unknown })?.message || error || "");
  void cmd({
    type: "canvas/diagLog",
    payload: {
      at: Date.now(),
      canvasId: String((input && input.canvasId) || ""),
      nodeId: String((input && input.nodeId) || ""),
      kind: String((input && input.kind) || "unknown"),
      code,
      detail,
      stage,
    },
  }).catch(() => undefined);
}

/**
 * 扩图是否需要再补边（纯函数，单测直接调）。
 *
 * 编辑框（ui/editors/OutpaintFrame.tsx）已经按用户框的尺寸把「原图 + 四周透明扩展」合成好，
 * 会带 params.prepadded === true 过来 —— 这时必须**原样**用那张图；再 padded() 就是加边两次
 * （框上 499×362 会变成请求 749×543，模型多出一大圈空白）。
 * 老调用方没传 prepadded，保持原来的「四周各留 25%」行为不变。
 */
export function needsOutpaintPadding(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return true;
  return (params as Record<string, unknown>).prepadded !== true;
}

export function createBridgeBackend(): CanvasBackend {
  let disposed = false;
  let modelCache: Promise<ModelSpec[]> | null = null;
  // 流式事件按 requestId 分发
  const streams = new Map<string, (ev: any) => void>();
  const agentWatchStops = new Set<() => void>();
  let off: (() => void) | null = null;
  const ensureStream = () => {
    if (disposed || off) return; const api = oa()?.model; if (!api?.onEvent) return;
    off = api.onEvent((event: any) => {
      if (disposed) return;
      const p = event && event.payload; if (!p || p.type !== "canvas.stream") return;
      streams.get(String(p.requestId || ""))?.(p.event || null);
    });
  };

  /* ---------- 模型目录失效 ----------
   * 设置页增删 / 启停 / 改名模型后，主进程经 model:event 广播 model/configChanged。
   * 收到就作废 modelCache 并通知订阅方（画布 store 重拉 models）；否则下拉里还留着刚删的模型，必须重载页面。
   * 兜底：窗口重新可见 / 获得焦点时也失效一次，防止窗口销毁或竞态导致事件丢失。 */
  const modelSubs = new Set<() => void>();
  let modelOff: (() => void) | null = null;
  let modelFocusBound = false;
  let modelFocusKick: (() => void) | null = null;
  function invalidateModels() {
    if (disposed) return;
    modelCache = null;
    for (const cb of [...modelSubs]) { try { cb(); } catch { /* 单个订阅方失败不影响其它 */ } }
  }
  function ensureModelInvalidation() {
    if (disposed) return;
    if (!modelOff) {
      const api = oa()?.model;
      if (api?.onEvent) {
        try { modelOff = api.onEvent((event: any) => { const p = event && event.payload; if (!p || p.type !== "model/configChanged") return; invalidateModels(); }); }
        catch { modelOff = null; }
      }
    }
    if (!modelFocusBound && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      modelFocusBound = true;
      modelFocusKick = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") return; invalidateModels(); };
      window.addEventListener("focus", modelFocusKick);
      window.addEventListener("visibilitychange", modelFocusKick);
      // ReactIsland 与外壳同域运行；外壳重新获得焦点时也失效模型缓存，父窗口可访问时一并订阅
      try { if (window.parent && window.parent !== window) { window.parent.addEventListener("focus", modelFocusKick); window.parent.addEventListener("visibilitychange", modelFocusKick); } } catch { /* 跨域父窗口不可订阅 */ }
    }
  }

  /** 被主进程标成 SUPERSEDED 的 run：结果已留档（且已计费），取回来用 */
  async function kept(canvasId: string, runId: string): Promise<Record<string, any> | null> {
    const rs = await canvasCmd()?.({ type: "canvas/runState", canvasId, runId }).catch(() => null);
    return rs && rs.ok && rs.run && rs.run.resultAvailable && rs.run.result && rs.run.result.ok === true ? rs.run.result : null;
  }
  /** async 任务轮询到终态；signal 中止时发 runStop */
  async function poll(canvasId: string, runId: string, signal: AbortSignal, onEvent: (e: GenEvent) => void, est: number): Promise<Record<string, any>> {
    const cmd = canvasCmd()!; const t0 = Date.now(); const deadline = t0 + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (signal.aborted) { await cmd({ type: "canvas/runStop", canvasId, runId, reason: "USER_STOP" }).catch(() => undefined); throw new GenError("STOPPED", "已停止"); }
      const st = await cmd({ type: "canvas/runStatus", canvasId, runId });
      if (!st || st.ok !== true) throw new GenError(String(st?.error || "RUN_STATUS_FAILED"), errText(st, "查询任务状态失败"));
      const p = typeof st.progress === "number" ? st.progress : Math.min(.95, (Date.now() - t0) / (est * 1000));
      onEvent({ type: "progress", progress: p });
      if (st.status === "DONE") return (st.result || {}) as Record<string, any>;
      if (st.status === "FAILED") throw new GenError("FAILED", String(st.error || "生成失败"));
      if (st.status !== "RUNNING" && st.status !== "QUEUED") {
        // 主进程按「目标节点被并发修改」把结果标成 SUPERSEDED（runStatus 显示为 STOPPED），但结果已留档且已扣费。
        // 新画布由页面自己写回节点，不存在覆盖用户编辑的问题：取回留档结果照常使用。
        const k = await kept(canvasId, runId); if (k) return k;
        throw new GenError("STOPPED", st.error && st.error !== "RUN_STOPPED" ? "生成被中止：" + st.error : "已停止");
      }
    }
    throw new GenError("TIMEOUT", "生成超时（10 分钟）");
  }

  /* ---------- 素材 → 模型可读的链接 ----------
   * 发给模型的图片 / 视频 / 音频一律转成 https 地址：base64 动辄几 MB 到几百 MB，模型接口接不住也读不了。
   *   http(s) 地址      原样使用
   *   data URL          先存进资源库，再按资源转链接
   *   openarc-asset:…   canvas/assetPublicUrl 上传到对象存储并返回链接（按资源缓存，过期前复用）
   * 后端还没有 canvas/assetPublicUrl 时的兜底：只有图片会压缩到长边 2048、≤1.5MB 后以 data URL 发送，视频 / 音频直接报错说明。 */
  const urlCache = new Map<string, { url: string; exp: number }>();
  let publicUrlMissing = false;
  /**
   * 临时图床（catbox）在部分网络里整个不可达：主进程的上传超时是 240s，渲染层不能陪着等 ——
   * 给这次上传一个等待预算，超时就按「临时链接不可用」处理并冷却一段时间（期间直接用内嵌兜底）。
   * 主进程那边仍在跑的上传不会被取消，成功时仍会进下次缓存。
   */
  const PUBLIC_URL_WAIT_MS = 15000;
  const PUBLIC_URL_COOLDOWN_MS = 5 * 60_000;
  let publicUrlDownUntil = 0;
  function withBudget<T>(job: Promise<T>, ms: number): Promise<{ value: T } | { timedOut: true }> {
    return Promise.race([
      job.then((value) => ({ value })),
      new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
    ]);
  }
  /** 临时链接 → 原始资源引用（读图模型拉不到链接时，回退成内嵌图片要用） */
  const origOf = new Map<string, string>();
  /** 已知拉不到外链图片的对话模型（configId）：之后直接内嵌压缩图 */
  const inlineOnly = new Set<string>();
  const FALLBACK_MAX = 1.5 * 1024 * 1024;
  async function compressImage(dataUrl: string): Promise<string> {
    const im = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("图片解码失败")); i.src = dataUrl; });
    let long = 2048;
    for (let q = .9; q >= .5; q -= .1) {
      const s = Math.min(1, long / Math.max(im.naturalWidth, im.naturalHeight)); const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s); c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
      const out = c.toDataURL("image/jpeg", q); if (out.length * .75 <= FALLBACK_MAX) return out; long = Math.round(long * .8);
    }
    throw new GenError("ASSET_TOO_LARGE", "参考图太大，压缩后仍超过模型接收上限");
  }
  async function modelUrl(canvasId: string, src: string, kind: "image" | "video" | "audio"): Promise<string> {
    if (!src) return src;
    if (/^https?:\/\//i.test(src)) return src;
    const cmd = canvasCmd(); if (!cmd) throw new GenError("NO_BRIDGE", "未连接桌面后端，无法生成");
    let ref = src;
    if (src.startsWith("data:")) {
      const r = await cmd({ type: "canvas/importAsset", canvasId, name: kind + "-input", dataUrl: src }).catch(() => null);
      if (r && r.ok && r.ref) ref = String(r.ref);
      else if (kind === "image") return src.length * .75 <= FALLBACK_MAX ? src : compressImage(src);
      else throw new GenError("ASSET_IMPORT_FAILED", "素材存入资源库失败，无法生成可发送的链接");
    }
    // 剩余有效期不足 1 小时就重新获取（视频生成可能排队较久）
    const hit = urlCache.get(ref); if (hit && hit.exp > Date.now() + 3600_000) { origOf.set(hit.url, ref); return hit.url; }
    if (!publicUrlMissing && Date.now() >= publicUrlDownUntil) {
      const waited = await withBudget(cmd({ type: "canvas/assetPublicUrl", canvasId, ref, ttlSeconds: 86400 }).catch(() => null), PUBLIC_URL_WAIT_MS);
      const r = "timedOut" in waited ? null : waited.value;
      if (r && r.ok && r.url) { urlCache.set(ref, { url: String(r.url), exp: Number(r.expiresAt) || Date.now() + 86400_000 }); origOf.set(String(r.url), ref); return String(r.url); }
      const code = String(r?.error || "");
      if (!r) {
        // 图床不可达（或 IPC 直接报错）：别让每次生成都再等一轮上传
        publicUrlDownUntil = Date.now() + PUBLIC_URL_COOLDOWN_MS;
        if (kind !== "image") throw new GenError("timedOut" in waited ? "ASSET_URL_TIMEOUT" : "ASSET_URL_FAILED", "素材上传超时或失败：临时图床不可用，先把素材放到可公开访问的网址再生成");
      } else if (code === "CANVAS_COMMAND_NOT_ALLOWED" || code === "NOT_IMPLEMENTED") publicUrlMissing = true;
      else if (kind !== "image") throw new GenError(code || "ASSET_URL_FAILED", "素材上传失败：" + errText(r, "无法生成链接"));
      // 图片：图床临时不可用时退回内嵌压缩图，不阻断生成
    }
    if (kind !== "image") throw new GenError("ASSET_URL_UNAVAILABLE", `${kind === "video" ? "视频" : "音频"}需要先上传成链接才能发给模型，当前后端还不支持素材转链接（canvas/assetPublicUrl）`);
    const data = await toDataUrl(ref);
    return data.length * .75 <= FALLBACK_MAX ? data : compressImage(data);
  }
  /** data URL 存进资源库换成 openarc-asset 引用；其余原样（存不进就保留原值，由主进程按值处理） */
  async function localRef(canvasId: string, src: string): Promise<string> {
    if (!src.startsWith("data:")) return src;
    const cmd = canvasCmd(); if (!cmd) return src;
    const r = await cmd({ type: "canvas/importAsset", canvasId, name: "image-input", dataUrl: src }).catch(() => null);
    return r && r.ok && r.ref ? String(r.ref) : src;
  }
  /** 请求里所有素材输入换成链接 */
  async function linkInputs(req: GenRequest): Promise<GenRequest> {
    const media = req.kind === "video" || req.kind === "audio";
    const inputs = await Promise.all(req.inputs.map(async (x) => {
      if (!x.url || x.kind === "text") return x;
      // 视频 / 音频生成里的参考图：主进程按资源引用自己读字节、交给服务商自家上传（APIMart / Lovart），
      // 这里先传临时图床纯属白等（最长 15s，还要上传授权）。只把未入库的 data URL 存成资源引用。
      if (media && x.kind === "image") return { ...x, url: await localRef(req.canvasId, x.url) };
      return { ...x, url: await modelUrl(req.canvasId, x.url, x.kind as "image" | "video" | "audio") };
    }));
    return { ...req, inputs };
  }

  /** openarc-asset:<ref> → data URL（只在兜底时用） */
  async function toDataUrl(url: string): Promise<string> {
    if (!url.startsWith("openarc-asset:")) return url; const cmd = canvasCmd(); if (!cmd) return url;
    const r = await cmd({ type: "canvas/readAsset", ref: url }).catch(() => null);
    if (!r || !r.ok || !r.dataUrl) throw new GenError("ASSET_UNAVAILABLE", "参考图不可用（资源已删除或无权限）"); return String(r.dataUrl);
  }
  const urlOf = (row: any): string => String((row && typeof row === "object" ? (row.dataUrl || row.url || row.value || row.sourceUrl) : row) || "");

  async function genText(req: GenRequest, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenResult> {
    const p = req.params as TextParams;
    const ctx = req.inputs.filter((x) => x.text).map((x) => `【输入 ${x.order}：${x.title}】\n${x.text}`).join("\n\n");
    const messages: ChatMessage[] = [{ role: "user", content: (ctx ? ctx + "\n\n" : "") + (req.resolvedPrompt || "请整理上面的输入") }];
    let images = req.model.vision ? req.inputs.filter((x) => x.kind === "image" && x.url).map((x) => x.url!) : [];
    const inline = async (list: string[]) => Promise.all(list.map(async (u) => { const ref = origOf.get(u); if (!ref) return u; const d = await toDataUrl(ref); return d.length * .75 <= FALLBACK_MAX ? d : compressImage(d); }));
    // 有的对话模型 / 中转拉不到外链图片：先发链接，协议报错就改成内嵌压缩图重试一次，并记住这个模型
    if (images.length && inlineOnly.has(req.model.id)) images = await inline(images);
    const go = (imgs: string[]) => chatInner({ canvasId: req.canvasId, configId: req.model.id, messages, images: imgs, webSearch: p.search }, (full) => onEvent({ type: "text", text: full }), signal, req.nodeId);
    let text: string;
    try { text = await go(images); } catch (err) {
      const code = err instanceof GenError ? err.code : "";
      if (!images.length || signal.aborted || !images.some((u) => origOf.has(u)) || !/PROVIDER|PROTOCOL|BAD_REQUEST|MODEL_ERROR|INVALID/i.test(code)) throw err;
      inlineOnly.add(req.model.id); text = await go(await inline(images));
    }
    return { outputs: [{ text, meta: { model: req.model.name, at: Date.now() } }] };
  }

  async function chatInner(o: { canvasId: string; configId?: string; effort?: "auto" | "low" | "high"; messages: ChatMessage[]; images?: (string | undefined)[]; webSearch?: boolean }, onDelta: (full: string) => void, signal: AbortSignal, nodeId: string | null = null): Promise<string> {
    const cmd = canvasCmd(); if (!cmd) throw new GenError("NO_BRIDGE", "未连接桌面后端，无法生成");
    ensureStream();
    const run = await cmd({ type: "canvas/run", canvasId: o.canvasId, kind: "chat", nodeId, configId: o.configId || undefined });
    if (!run || run.ok !== true) throw new GenError(String(run?.error || "RUN_FAILED"), errText(run, "无法开始生成"));
    const requestId = "cn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let full = "";
    streams.set(requestId, (ev) => { if (ev && ev.type === "text.delta" && typeof ev.text === "string") { full += ev.text; onDelta(full); } });
    const onAbort = () => { void cmd({ type: "canvas/runStop", canvasId: o.canvasId, runId: run.runId, reason: "USER_STOP" }).catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // 读图：图片（已换成 https 链接）放进最后一条用户消息的 content 里，后端原样交给模型适配层
      const imgs = (o.images || []).filter((u): u is string => !!u);
      let messages = o.messages;
      if (imgs.length) {
        const li = messages.map((m) => m.role).lastIndexOf("user");
        if (li >= 0) { const m = messages[li]; const parts: ChatPart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content]; imgs.forEach((url) => parts.push({ type: "image_url", image_url: { url } })); messages = messages.map((x, i) => (i === li ? { ...x, content: parts } : x)); }
      }
      const res = await cmd({ type: "canvas/modelChatStream", canvasId: o.canvasId, runId: run.runId, messages, configId: o.configId, requestId, ...(o.effort && o.effort !== "auto" ? { reasoningEffort: o.effort } : {}), ...(o.webSearch ? { webSearch: true } : {}) });
      if (signal.aborted) throw new GenError("STOPPED", "已停止");
      await cmd({ type: "canvas/runFinish", canvasId: o.canvasId, runId: run.runId, status: res && res.ok ? "DONE" : "FAILED" }).catch(() => undefined);
      if (!res || res.ok !== true) throw new GenError(String(res?.error || "MODEL_ERROR"), errText(res, "模型调用失败"));
      const text = typeof res.text === "string" ? res.text : full;
      onDelta(text); return text;
    } finally { streams.delete(requestId); signal.removeEventListener("abort", onAbort); }
  }

  async function genImage(req: GenRequest, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenResult> {
    const cmd = canvasCmd(); if (!cmd) throw new GenError("NO_BRIDGE", "未连接桌面后端，无法生成");
    const p = req.params as ImageParams;
    const refs = req.inputs.filter((x) => x.kind === "image" && x.url).map((x) => x.url as string);
    const run = await cmd({ type: "canvas/run", canvasId: req.canvasId, kind: "image", nodeId: req.nodeId, configId: req.model.id });
    if (!run || run.ok !== true) throw new GenError(String(run?.error || "RUN_FAILED"), errText(run, "无法开始生成"));
    onEvent({ type: "started", runId: run.runId });
    let ok = false;
    try {
      const camera = p.camera.on ? { body: CAMERAS.body[p.camera.body], lens: CAMERAS.lens[p.camera.lens], focal: CAMERAS.focal[p.camera.focal] + "mm", aperture: CAMERAS.aperture[p.camera.aperture] } : null;
      // 主进程 canvas/modelImage 认 prompt / ratio / resolution / count(≤4) / configId；其余字段先带上，后端补齐后生效
      const common = { canvasId: req.canvasId, runId: run.runId, nodeId: req.nodeId, prompt: req.resolvedPrompt, ratio: /自适应|auto/i.test(p.ratio) ? "auto" : p.ratio, resolution: p.size, count: Math.min(4, p.count), configId: req.model.id, style: styleForRequest(p.style), camera, webSearch: !!p.search, images: refs, ...(req.model.mj && p.mj ? { mj: p.mj } : {}) };
      // 有参考图且模型支持图生图：走 canvas/modelImageEdit（目前只收 1 张参考图）；素材已在 linkInputs 换成链接
      let result: Record<string, any>;
      // 参考图生图：参考图作为附件，提示词原样（主进程把链接下载后传成服务商附件）
      if (refs.length && req.model.i2i) {
        // 参考图生图走 canvas/modelImageEdit：比例 / 清晰度由主进程按字段处理；这条命令一次只出 1 张，
        // 风格 / 摄影机也没有字段，所以：风格与摄影机写进提示词，张数按 count 并发请求后合并。
        const extra = [common.style ? `画面风格：${common.style}` : "", camera ? `摄影机：${camera.body}，${camera.lens}，焦距 ${camera.focal}，光圈 ${camera.aperture}` : ""].filter(Boolean).join("；");
        const editPrompt = req.resolvedPrompt + (extra ? `\n\n${extra}` : "");
        const shots = await Promise.all(Array.from({ length: Math.max(1, common.count) }, () => cmd({ type: "canvas/modelImageEdit", ...common, mode: "prompt", prompt: editPrompt, inputDataUrls: refs.slice(0, Math.min(MAX_REFS, req.model.maxRefs || MAX_REFS)) }).catch((e): Record<string, any> => ({ ok: false, error: "IMAGE_EDIT_FAILED", detail: String(e && e.message || e) }))));
        const good = shots.filter((x) => x && x.ok === true);
        result = good.length ? { ok: true, images: good.flatMap((x) => (Array.isArray(x.images) ? x.images : [])) } : shots[0];
      }
      else result = await cmd({ type: "canvas/modelImage", ...common, async: true });
      if (result && result.async === true && result.runId) result = await poll(req.canvasId, String(result.runId), signal, onEvent, req.model.secs);
      if (result && result.ok !== true && /NODE_CONFLICT|TARGET_MISSING|RUN_STOPPED/.test(String(result.error || "")) && !signal.aborted) result = (await kept(req.canvasId, run.runId)) || result;
      if (!result || result.ok !== true) throw new GenError(String(result?.error || "IMAGE_FAILED"), errText(result, "生成失败"));
      const rows = Array.isArray(result.images) ? result.images : [];
      const outputs: GenOutput[] = rows.map((r: any) => ({ url: urlOf(r), w: Number(r?.width) || undefined, h: Number(r?.height) || undefined, meta: { model: req.model.name, ratio: p.ratio, size: p.size, at: Date.now(), runId: run.runId } })).filter((o: GenOutput) => o.url);
      if (!outputs.length) throw new GenError("NO_OUTPUT", "生成结果缺少图片地址");
      ok = true; return { outputs: await persist(req.canvasId, outputs, "生成图片", "image", p.ratio), runId: run.runId };
    } finally {
      await cmd({ type: "canvas/runFinish", canvasId: req.canvasId, runId: run.runId, status: ok ? "DONE" : signal.aborted ? "STOPPED" : "FAILED" }).catch(() => undefined);
    }
  }

  /** 生成结果落到本地资源库：服务商链接多数会过期（APIMart 24 小时、部分站更短），存不下就保留原链接 */
  async function persist(canvasId: string, outs: GenOutput[], name: string, kind?: "image" | "video", ratio?: string): Promise<GenOutput[]> {
    const cmd = canvasCmd(); if (!cmd) return outs;
    return Promise.all(outs.map(async (o) => {
      let out = o;
      if (o.url && /^https?:\/\//i.test(o.url)) {
        const r = await cmd({ type: "canvas/importRemote", canvasId, url: o.url, name }).catch(() => null);
        if (r && r.ok && r.ref) out = { ...o, url: String(r.ref), meta: { ...(o.meta || {}), remote: o.url } };
      }
      return kind ? measure(out, kind, ratio) : out;
    }));
  }
  /** 补上结果的实际宽高（服务商多数不返回），节点据此调整成和结果一样的比例 */
  async function measure(o: GenOutput, kind: "image" | "video", ratio?: string): Promise<GenOutput> {
    if (o.w && o.h) return o;
    if (kind === "image" && o.url) {
      const read = async (ref: string) => { const c = canvasCmd(); const r = c ? await c({ type: "canvas/readAsset", ref }).catch(() => null) : null; return r && r.ok && r.dataUrl ? String(r.dataUrl) : null; };
      const src = /^openarc-asset:/.test(o.url) ? await read(o.url) : /^data:/.test(o.url) ? o.url : null;
      if (src) {
        const wh = await new Promise<[number, number] | null>((r) => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r(null); im.src = src; });
        if (wh && wh[0] && wh[1]) return { ...o, w: wh[0], h: wh[1] };
      }
    }
    // 视频不整段读进来量尺寸：按所选比例（自适应时保持节点原样）
    if (ratio && !/自适应|auto|adaptive/i.test(ratio)) { const [w, h] = ratioWH(ratio, 1280); return { ...o, w, h }; }
    return o;
  }

  async function genMedia(req: GenRequest, raw: GenRequest, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenResult> {
    const cmd = canvasCmd(); if (!cmd) throw new GenError("NO_BRIDGE", "未连接桌面后端，无法生成");
    const video = req.kind === "video";
    /**
     * 节点参数里不塞 data URL：几 MB 的 base64 走一次 IPC 没有意义，主进程本来就会按 imageRefs /
     * videoRefs 自己读字节。临时图床不可用时（内嵌兜底）把原始资源引用交回去。
     * linkInputs 与原始输入一一对应（同序），这里按链接值反查原始值。
     */
    const rawByLinked = new Map<string, string>();
    req.inputs.forEach((input, index) => { const before = raw.inputs[index] && raw.inputs[index].url; if (before && input.url !== before) rawByLinked.set(String(input.url), String(before)); });
    const refFor = (url: string) => {
      if (!url.startsWith("data:")) return url;
      const before = rawByLinked.get(url) || "";
      return /^openarc-asset:/.test(before) ? before : url;
    };
    const params: Record<string, unknown> = { prompt: req.resolvedPrompt, configId: req.model.id };
    if (video) {
      const p = req.params as VideoParams;
      Object.assign(params, {
        modelType: req.videoMode?.api, ratio: p.ratio, resolution: p.res, duration: p.dur, count: p.times || 1, times: p.times || 1,
        ...(req.model.audio ? { generateAudio: !!p.sound } : {}),
        ...(p.multiShot ? { multiShot: true } : {}),
      });
      // 节点注册表要求 images / videos / audios 是字符串数组（防呆上界 4MB，正常是短链接或资源引用）；
      // 角色和资源库原始引用用并行数组带上，主进程拿原始引用读字节再交给服务商（Lovart 只认它自家上传的附件地址）
      const imgs = req.inputs.filter((x) => x.kind === "image" && x.url);
      const vids = req.inputs.filter((x) => x.kind === "video" && x.url);
      const auds = req.inputs.filter((x) => x.kind === "audio" && x.url);
      Object.assign(params, {
        images: imgs.map((x) => refFor(x.url!)), imageRoles: imgs.map((x) => x.role || "ref"), imageRefs: imgs.map((x) => origOf.get(x.url!) || refFor(x.url!)),
        videos: vids.map((x) => refFor(x.url!)), videoRefs: vids.map((x) => origOf.get(x.url!) || refFor(x.url!)),
        audios: auds.map((x) => refFor(x.url!)), audioRefs: auds.map((x) => origOf.get(x.url!) || refFor(x.url!)),
      });
    } else {
      const p = req.params as AudioParams;
      Object.assign(params, { kind: p.kind, duration: p.dur });
    }
    let result = await cmd({ type: "canvas/nodes/execute", payload: { type: video ? "builtin.video-generator" : "builtin.audio-generator", canvasId: req.canvasId, nodeId: req.nodeId, async: true, params } });
    if (result && result.async === true && result.runId) { onEvent({ type: "started", runId: result.runId }); result = await poll(req.canvasId, String(result.runId), signal, onEvent, req.model.secs); }
    if (!result || result.ok !== true) throw new GenError(String(result?.error || "FAILED"), errText(result, video ? "视频生成失败" : "音频生成失败"));
    const rows = result.outputs && typeof result.outputs === "object" ? (result.outputs as any)[video ? "videos" : "audios"] : null;
    const outputs: GenOutput[] = (Array.isArray(rows) ? rows : []).map((r: any) => ({ url: urlOf(r), frame: r?.poster || r?.thumbnail || undefined, dur: Number(r?.duration) || (video ? (req.params as VideoParams).dur : undefined), res: video ? (req.params as VideoParams).res : undefined, meta: { model: req.model.name, at: Date.now() } })).filter((o: GenOutput) => o.url);
    if (!outputs.length) throw new GenError("NO_OUTPUT", video ? "生成结果缺少视频地址" : "生成结果缺少音频地址");
    return { outputs: await persist(req.canvasId, outputs, video ? "生成视频" : "生成音频", video ? "video" : undefined, video ? (req.params as VideoParams).ratio : undefined) };
  }

  /* ---------- 图片编辑：按操作合成发给模型的素材和指令 ---------- */
  const EDIT_MAX = 2048;
  const loadImage = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new GenError("ASSET_UNAVAILABLE", "原图读取失败")); im.src = src; });
  const canvasOf = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  async function editSource(canvasId: string, src: string): Promise<string> {
    let url = src;
    if (/^https?:\/\//i.test(url)) { const cmd = canvasCmd(); const r = cmd ? await cmd({ type: "canvas/importRemote", canvasId, url, name: "编辑原图" }).catch(() => null) : null; if (r && r.ok && r.ref) url = String(r.ref); }
    if (url.startsWith("openarc-asset:")) url = await toDataUrl(url);
    if (!url.startsWith("data:")) throw new GenError("ASSET_UNAVAILABLE", "原图不可用");
    const im = await loadImage(url); const s = Math.min(1, EDIT_MAX / Math.max(im.naturalWidth, im.naturalHeight));
    if (s >= 1 && url.length * .75 < 8 * 1024 * 1024) return url;
    const c = canvasOf(im.naturalWidth * s, im.naturalHeight * s); c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height); return c.toDataURL("image/png");
  }
  /** 蒙版涂抹处挖成透明（Lovart 重绘 / 擦除按透明区域处理） */
  async function holeOf(source: string, mask: string): Promise<string> {
    const im = await loadImage(source); const mk = await loadImage(mask); const W = im.naturalWidth, H = im.naturalHeight;
    const c = canvasOf(W, H); const g = c.getContext("2d")!; g.drawImage(im, 0, 0, W, H);
    const m = canvasOf(W, H); const mg = m.getContext("2d")!; mg.drawImage(mk, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H); const mp = mg.getImageData(0, 0, W, H).data; let hit = 0;
    for (let i = 3; i < px.data.length; i += 4) if (mp[i] > 8) { px.data[i] = 0; hit++; }
    if (!hit) throw new GenError("INVALID_INPUT", "先涂抹需要编辑的区域");
    g.putImageData(px, 0, 0); return c.toDataURL("image/png");
  }
  /**
   * 发给服务商前压小：超过上限就转 WebP（保留透明），仍然太大再逐步缩小。
   * APIMart 等中转站的上传入口实际上限比文档小（1.6MB 的 PNG 会被拒），所以统一压到 900KB 以内。
   */
  const UPLOAD_MAX = 900 * 1024;
  async function compact(src: string): Promise<{ url: string; w: number; h: number }> {
    const im = await loadImage(src); let w = im.naturalWidth, h = im.naturalHeight;
    if (src.length * .75 <= UPLOAD_MAX) return { url: src, w, h };
    let url = src;
    for (let i = 0; i < 6; i++) {
      const c = canvasOf(w, h); c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
      url = c.toDataURL("image/webp", 0.92); if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/png");
      if (url.length * .75 <= UPLOAD_MAX) break;
      w = Math.round(w * .82); h = Math.round(h * .82);
    }
    return { url, w: Math.round(w), h: Math.round(h) };
  }
  /**
   * 抠图后处理：已有真透明就原样返回；否则按四角取背景色（要求是绿色），距离背景色越近越透明，边缘去绿色溢出。
   * 背景不是纯色绿幕（模型没听话）时返回 null，交给调用方提示。
   */
  async function keyOut(src: string): Promise<{ url: string; already?: boolean } | null> {
    const im = await loadImage(src); const W = im.naturalWidth, H = im.naturalHeight;
    const c = canvasOf(W, H); const g = c.getContext("2d", { willReadFrequently: true })!; g.drawImage(im, 0, 0);
    const px = g.getImageData(0, 0, W, H); const d = px.data;
    let clear = 0; for (let i = 3; i < d.length; i += 16) if (d[i] < 250) clear++;
    if (clear / (d.length / 16) > 0.02) return { url: src, already: true };
    // 背景色：四角 8×8 区域取平均
    let br = 0, bg = 0, bb = 0, k = 0;
    for (const [x0, y0] of [[0, 0], [W - 8, 0], [0, H - 8], [W - 8, H - 8]]) for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) { const i = (y * W + x) * 4; br += d[i]; bg += d[i + 1]; bb += d[i + 2]; k++; }
    br /= k; bg /= k; bb /= k;
    if (!(bg > 140 && bg - Math.max(br, bb) > 70)) return null;
    const T0 = 70, T1 = 150; let gone = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const dist = Math.sqrt((r - br) ** 2 + (gg - bg) ** 2 + (b - bb) ** 2);
      const a = dist <= T0 ? 0 : dist >= T1 ? 1 : (dist - T0) / (T1 - T0);
      if (a < 1) { const m = Math.max(r, b); if (gg > m) d[i + 1] = m; } // 去绿色溢出
      else if (gg > Math.max(r, b) + 30) d[i + 1] = Math.max(r, b) + 30;
      d[i + 3] = Math.round(a * 255); if (a < 0.5) gone++;
    }
    const frac = gone / (W * H); if (frac < 0.03 || frac > 0.97) return null;
    g.putImageData(px, 0, 0); return { url: c.toDataURL("image/png") };
  }
  /** 纯遮罩：不透明黑底，涂抹处透明（GPT Image 的 mask 写法），尺寸和发出去的原图一致 */
  async function maskOnly(mask: string, w: number, h: number): Promise<string> {
    const mk = await loadImage(mask); const c = canvasOf(w, h); const g = c.getContext("2d")!;
    g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "destination-out"; g.drawImage(mk, 0, 0, w, h);
    return c.toDataURL("image/png");
  }
  /**
   * 局部重绘 / 擦除结果贴回原图：遮罩外一律用原图像素，遮罩内用模型结果，边缘羽化过渡。
   * GPT Image 等模型把遮罩当参考，常常连遮罩外也改掉；贴回后保证没涂的地方原样不动。
   * 结果和原图比例差太多（模型改了画幅）时不合成，原样返回 null。
   */
  async function pasteBack(source: string, mask: string, result: string): Promise<string | null> {
    const im = await loadImage(source); const rs = await loadImage(result); const mk = await loadImage(mask);
    const W = im.naturalWidth, H = im.naturalHeight;
    if (Math.abs(Math.log((rs.naturalWidth / rs.naturalHeight) / (W / H))) > 0.03) return null;
    const feather = Math.max(2, Math.round(Math.max(W, H) / 160));
    // 羽化遮罩：先略微外扩（模糊后阈值不变的区域会向内收），再模糊出软边
    const m = canvasOf(W, H); const mg = m.getContext("2d")!; mg.filter = `blur(${feather}px)`;
    for (let i = 0; i < 2; i++) mg.drawImage(mk, 0, 0, W, H);
    const layer = canvasOf(W, H); const lg = layer.getContext("2d")!;
    lg.drawImage(rs, 0, 0, W, H); lg.globalCompositeOperation = "destination-in"; lg.drawImage(m, 0, 0);
    const out = canvasOf(W, H); const og = out.getContext("2d")!; og.drawImage(im, 0, 0, W, H); og.drawImage(layer, 0, 0);
    return out.toDataURL("image/png");
  }
  /** 标注：把笔迹画在原图上 */
  async function annotated(source: string, mask: string): Promise<string> {
    const im = await loadImage(source); const mk = await loadImage(mask); const c = canvasOf(im.naturalWidth, im.naturalHeight); const g = c.getContext("2d")!;
    g.drawImage(im, 0, 0, c.width, c.height); g.drawImage(mk, 0, 0, c.width, c.height); return c.toDataURL("image/png");
  }
  /** 扩图：四周各留 25% 透明边（编辑框已经自己补过边的走 needsOutpaintPadding 直接跳过这一步） */
  async function padded(source: string): Promise<string> {
    const im = await loadImage(source); const W = im.naturalWidth, H = im.naturalHeight; const s = Math.min(1, EDIT_MAX / (Math.max(W, H) * 1.5));
    const c = canvasOf(W * 1.5 * s, H * 1.5 * s); c.getContext("2d")!.drawImage(im, W * .25 * s, H * .25 * s, W * s, H * s); return c.toDataURL("image/png");
  }
  const dirText = (x: number, y: number) => `${y < .34 ? "上" : y > .66 ? "下" : ""}${x < .34 ? "左" : x > .66 ? "右" : ""}` || "正面";
  async function buildEdit(req: EditRequest, source: string): Promise<{ mode: string; prompt: string; source: string; inputs: string[] }> {
    const p = (req.params || {}) as Record<string, any>; const extra = req.prompt ? "。补充要求：" + req.prompt : "";
    switch (req.op) {
      case "redraw": if (!req.maskDataUrl) throw new GenError("INVALID_INPUT", "先涂抹需要重绘的区域"); return { mode: "redraw", prompt: req.prompt || "自然地重绘这块区域", source: await holeOf(source, req.maskDataUrl), inputs: [] };
      case "erase": if (!req.maskDataUrl) throw new GenError("INVALID_INPUT", "先涂抹需要擦除的区域"); return { mode: "erase", prompt: req.prompt || "", source: await holeOf(source, req.maskDataUrl), inputs: [] };
      case "outpaint": return { mode: "outpaint", prompt: req.prompt || "", source: needsOutpaintPadding(p) ? await padded(source) : source, inputs: [] };
      case "annotate": if (!req.maskDataUrl) throw new GenError("INVALID_INPUT", "先在图上画出要改的位置"); return { mode: "prompt", prompt: `按图中红色标注的位置修改这张图：${req.prompt || "按标注处理"}。输出修改后的完整图片，不要保留红色标注笔迹，其余部分保持不变。`, source: await annotated(source, req.maskDataUrl), inputs: [] };
      case "angle": return { mode: "prompt", prompt: `保持同一个主体、材质、颜色和场景，把镜头换到新的视角：水平旋转 ${Math.round(Number(p.yaw) || 0)}°（正数向右绕），俯仰 ${Math.round(Number(p.pitch) || 0)}°（正数从上往下看），画面缩放 ${(Number(p.zoom) || 1).toFixed(1)} 倍${p.wide ? "，广角镜头" : ""}。输出一张新视角的照片${extra}`, source, inputs: [] };
      case "relight": return { mode: "prompt", prompt: `保持画面内容、构图和主体完全不变，只重新打光：主光从${dirText(Number(p.lx) || .5, Number(p.ly) || .5)}方向照来，光照强度 ${Math.round(Number(p.intensity) || 70)}%，色温${(Number(p.temp) || 50) < 40 ? "偏暖" : (Number(p.temp) || 50) > 60 ? "偏冷" : "中性"}，阴影和高光随光源方向自然变化${extra}`, source, inputs: [] };
      case "enhance": return { mode: "prompt", prompt: `把这张图高清增强为 2 倍分辨率：提升清晰度和细节，去除噪点和压缩痕迹，内容、构图、颜色完全不变${extra}`, source, inputs: [] };
      // 生成模型大多输不出透明通道（会画一张假棋盘格）：让它换成纯绿背景，回来后本地抠成真透明
      case "cutout": return { mode: "prompt", prompt: `把画面主体完整保留、原样不动，背景全部换成纯绿色（#00FF00），绿色均匀平整，没有渐变、阴影、倒影和纹理，主体边缘干净清晰${extra}`, source, inputs: [] };
      default: return { mode: "prompt", prompt: req.prompt || "", source, inputs: [] };
    }
  }
  const editErr = (res: any) => {
    const code = String(res?.error || ""); const d = typeof res?.detail === "string" ? res.detail : "";
    if (/CAPABILITY_UNAVAILABLE|IMAGE_EDIT_UNAVAILABLE/.test(code)) return "所选模型不支持图片编辑：在工具里的「模型」处换一个支持参考图 / 编辑的图片模型";
    if (code === "CREDENTIAL_MISSING") return "模型凭据缺失，去「设置 › 模型」检查这个服务商的密钥";
    return d ? `${code}：${d}` : errText(res, "编辑失败");
  };

  return {
    kind: "bridge",
    dispose() {
      if (disposed) return;
      disposed = true;
      off?.(); off = null;
      modelOff?.(); modelOff = null;
      if (modelFocusKick && typeof window !== "undefined") {
        window.removeEventListener("focus", modelFocusKick);
        window.removeEventListener("visibilitychange", modelFocusKick);
        try { if (window.parent && window.parent !== window) { window.parent.removeEventListener("focus", modelFocusKick); window.parent.removeEventListener("visibilitychange", modelFocusKick); } } catch { /* 跨域父窗口不可访问 */ }
      }
      modelFocusBound = false;
      modelFocusKick = null;
      modelSubs.clear();
      for (const stop of agentWatchStops) stop();
      agentWatchStops.clear();
      streams.clear();
      modelCache = null;
    },
    available: () => !!canvasCmd(),
    listModels() {
      if (disposed) return Promise.resolve([]);
      ensureModelInvalidation();
      if (modelCache) return modelCache;
      modelCache = (async () => {
        const cmd = modelCmd(); if (!cmd) return [];
        const res = await cmd({ type: "canvas/models" }).catch(() => null);
        const rows = res && res.ok === true && Array.isArray(res.models) ? res.models as any[] : [];
        const labels = buildCanvasModelLabelIndex(rows as never);
        const out: ModelSpec[] = [];
        for (const row of rows) {
          if (row.status !== "enabled" || !Array.isArray(row.capabilities)) continue;
          for (const kind of ["text", "image", "video", "audio"] as GenKind[]) {
            if (!row.capabilities.includes(CAP[kind])) continue;
            const dn = typeof row.displayName === "string" ? row.displayName.trim() : "";
            const label = dn && dn !== row.configId ? dn : labels.labelOf.get(String(row.configId)) || canvasModelBaseName(row as never);
            out.push(specFor({ configId: String(row.configId), label, vendor: String(row.providerName || ""), kind, local: /local|ollama|comfy|本机/i.test(String(row.providerId || row.providerName || "")), vision: row.capabilities.includes("vision") || row.capabilities.includes("vision-input") || undefined, search: row.capabilities.includes("web-search") || undefined, ui: row.uiSpec || null, specSource: row.specSource || undefined }));
          }
        }
        return out;
      })();
      modelCache.catch(() => { modelCache = null; });
      return modelCache;
    },
    onModelsChanged(cb) {
      if (typeof cb !== "function") return () => {};
      modelSubs.add(cb);
      ensureModelInvalidation();
      return () => { modelSubs.delete(cb); };
    },
    async loadDoc(canvasId): Promise<LoadedDoc> {
      const r = await loadDocLegacy(canvasId);
      return { doc: r.doc, version: r.version, source: r.source, error: r.error, migrated: r.migrated };
    },
    async readAuthoritativeDoc(canvasId): Promise<LoadedDoc> {
      const cmd = canvasCmd();
      if (!cmd) throw new GenError("NO_BRIDGE", "无法重读权威画布");
      const r = await cmd({ type: "canvas/get", canvasId });
      if (!r || r.ok !== true || !r.canvas) throw new GenError(String(r?.error || "CANVAS_GET_FAILED"), errText(r, "无法重读权威画布"));
      const parsed = serverDocToDoc(r.canvas.doc);
      if (!parsed.doc) throw new GenError("CANVAS_DOC_INVALID", "权威画布格式无效");
      return { doc: parsed.doc, version: Number(r.canvas.revision) || 1, source: "bridge", migrated: parsed.migrated };
    },
    async saveDoc(canvasId, doc: CanvasDoc, baseVersion): Promise<SavedDoc> {
      const r = await saveDocLegacy(canvasId, doc, baseVersion);
      return r.ok ? { ok: true, version: r.version } : { ok: false, conflict: r.conflict, error: r.error, remote: r.remote, remoteVersion: r.remoteVersion };
    },
    async generate(raw, onEvent, signal) {
      try {
        const req = await linkInputs(raw);
        // 必须 await：直接 return Promise 时，异步失败不会进这个 catch
        if (req.kind === "text") return await genText(req, onEvent, signal);
        if (req.kind === "image") return await genImage(req, onEvent, signal);
        return await genMedia(req, raw, onEvent, signal);
      } catch (error) {
        // 失败可能在发请求前（参数/素材/配置）——真机没有 run 记录时，这里就是唯一线索。
        reportGenFailure("generate", raw, error);
        throw error;
      }
    },
    async editImage(req: EditRequest, onEvent, signal) {
      try {
      const cmd = canvasCmd(); if (!cmd) throw new GenError("NO_BRIDGE", "未连接桌面后端，无法生成");
      // 编辑要原图字节：资源库引用 / 远程地址都先读成 data URL，长边压到 2048（服务商附件有大小上限）
      const raw = await editSource(req.canvasId, req.sourceUrl);
      const built = await buildEdit(req, raw);
      // 发出去的素材压小；局部重绘 / 擦除额外带原图和纯遮罩（支持遮罩的模型用得上）
      const send: { source: string; inputs: string[]; extra: Record<string, string> } = { source: (await compact(built.source)).url, inputs: await Promise.all(built.inputs.map(async (x) => (x.startsWith("data:image/") ? (await compact(x)).url : x))), extra: {} };
      if ((req.op === "redraw" || req.op === "erase") && req.maskDataUrl) {
        const orig = await compact(raw);
        send.extra = { originalDataUrl: orig.url, maskPngDataUrl: await maskOnly(req.maskDataUrl, orig.w, orig.h) };
      }
      const run = await cmd({ type: "canvas/run", canvasId: req.canvasId, kind: "image", nodeId: req.nodeId, configId: req.model?.id });
      if (!run || run.ok !== true) throw new GenError(String(run?.error || "RUN_FAILED"), errText(run, "无法开始生成"));
      onEvent({ type: "started", runId: run.runId }); let ok = false;
      const t0 = Date.now(); const tick = setInterval(() => onEvent({ type: "progress", progress: Math.min(.95, (Date.now() - t0) / ((req.model?.secs || 30) * 1500)) }), 800);
      const onAbort = () => { void cmd({ type: "canvas/runStop", canvasId: req.canvasId, runId: run.runId, reason: "USER_STOP" }).catch(() => undefined); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await cmd({ type: "canvas/modelImageEdit", canvasId: req.canvasId, nodeId: req.nodeId, runId: run.runId, mode: built.mode, prompt: built.prompt, sourceDataUrl: send.source, inputDataUrls: send.inputs, ...send.extra, params: req.params || {}, configId: req.model?.id });
        if (signal.aborted) throw new GenError("STOPPED", "已停止");
        if (!res || res.ok !== true) throw new GenError(String(res?.error || "IMAGE_EDIT_FAILED"), editErr(res));
        const row = Array.isArray(res.images) ? res.images[0] : null; let url = urlOf(row); let pasted = false; let modelOut = "";
        if (!url) throw new GenError("NO_OUTPUT", "生成结果缺少图片地址");
        if (req.op === "cutout") {
          let rsrc = url;
          if (/^https?:\/\//i.test(rsrc)) { const r = await cmd({ type: "canvas/importRemote", canvasId: req.canvasId, url: rsrc, name: "抠图结果" }).catch(() => null); if (r && r.ok && r.ref) rsrc = String(r.ref); }
          if (rsrc.startsWith("openarc-asset:")) { modelOut = rsrc; rsrc = await toDataUrl(rsrc); }
          const keyed = rsrc.startsWith("data:") ? await keyOut(rsrc).catch(() => null) : null;
          if (!keyed) throw new GenError("CUTOUT_FAILED", "模型没有把背景换成纯色，抠不干净：换一个图像模型再试，或用局部重绘手动处理");
          if (!keyed.already) { const r = await cmd({ type: "canvas/importAsset", canvasId: req.canvasId, name: "抠图", dataUrl: keyed.url }).catch(() => null); url = r && r.ok && r.ref ? String(r.ref) : keyed.url; pasted = true; }
        }
        if ((req.op === "redraw" || req.op === "erase") && req.maskDataUrl) {
          try {
            let rsrc = url;
            if (/^https?:\/\//i.test(rsrc)) { const r = await cmd({ type: "canvas/importRemote", canvasId: req.canvasId, url: rsrc, name: "局部重绘结果" }).catch(() => null); if (r && r.ok && r.ref) rsrc = String(r.ref); }
            if (rsrc.startsWith("openarc-asset:")) { modelOut = rsrc; rsrc = await toDataUrl(rsrc); } // 模型原始结果留在版本信息里，贴回效果不满意时可以找回
            const merged = rsrc.startsWith("data:") ? await pasteBack(raw, req.maskDataUrl, rsrc) : null;
            if (merged) { const r = await cmd({ type: "canvas/importAsset", canvasId: req.canvasId, name: req.op === "erase" ? "擦除结果" : "局部重绘结果", dataUrl: merged }).catch(() => null); url = r && r.ok && r.ref ? String(r.ref) : merged; pasted = true; }
          } catch { /* 贴回失败就用模型原结果 */ }
        }
        ok = true; return measure({ url, w: pasted ? undefined : Number(row?.width) || undefined, h: pasted ? undefined : Number(row?.height) || undefined, meta: { model: req.op, at: Date.now(), runId: run.runId, ...(pasted ? { pasted: true, modelOut } : {}) } }, "image");
      } finally { clearInterval(tick); signal.removeEventListener("abort", onAbort); await cmd({ type: "canvas/runFinish", canvasId: req.canvasId, runId: run.runId, status: ok ? "DONE" : signal.aborted ? "STOPPED" : "FAILED" }).catch(() => undefined); }
      } catch (error) {
        reportGenFailure("edit-image", req, error);
        throw error;
      }
    },
    async chat(req, onDelta, signal) {
      // 附图一律内嵌成压缩后的 data URL：不走第三方图床，也就不需要上传授权
      const images = await Promise.all((req.images || []).map(async (u) => { const d = await toDataUrl(u); return d.startsWith("data:") && d.length * .75 > FALLBACK_MAX ? compressImage(d) : d; }));
      return chatInner({ canvasId: req.canvasId, configId: req.configId, effort: req.effort, messages: req.messages, images }, onDelta, signal);
    },
    async runAgentTask(req) {
      const cmd = oa()?.task?.command;
      if (!cmd) return { ok: false, error: "TASK_UNAVAILABLE" };
      const res = await cmd({ type: "task/run", payload: { goal: req.goal, canvasContext: req.context } }).catch(() => null);
      return res ? { ok: res.ok === true, taskId: typeof res.taskId === "string" ? res.taskId : undefined, status: typeof res.status === "string" ? res.status : undefined, error: typeof res.error === "string" ? res.error : undefined } : { ok: false, error: "TASK_UNAVAILABLE" };
    },
    async defaultChatModel() {
      const cmd = modelCmd(); if (!cmd) return null;
      const res = await cmd({ command: "defaults/get" }).catch(() => null);
      const id = res && res.ok !== false ? res.personal?.chat || res.organization?.chat : null;
      return typeof id === "string" && id ? id : null;
    },
    watchAgentTask(taskId, onSnapshot) {
      if (disposed) return () => {};
      const api = oa()?.task; let active = true; let reading = false; let queued = false;
      const refresh = async () => {
        if (disposed || !active || !api?.command) return;
        if (reading) { queued = true; return; }
        reading = true;
        try {
          const r = await api.command({ type: "task/get", payload: { taskId } });
          if (!active || !r || r.ok !== true || !r.task) return;
          onSnapshot({ taskId, status: String(r.task.status || ""), modelConfigId: typeof r.task.modelConfigId === "string" ? r.task.modelConfigId : null, steps: Array.isArray(r.steps) ? r.steps : [], events: Array.isArray(r.events) ? r.events : [], calls: Array.isArray(r.calls) ? r.calls : [], artifacts: Array.isArray(r.artifacts) ? r.artifacts : [], verifications: Array.isArray(r.verifications) ? r.verifications : [], error: typeof r.error === "string" ? r.error : undefined });
        } finally {
          reading = false;
          if (queued) { queued = false; void refresh(); }
        }
      };
      const off = api?.onEvent?.((ev) => { if (ev && ev.taskId === taskId && (ev.type === "task/event" || ev.type === "task/result")) void refresh(); }) || null;
      const timer = setInterval(() => void refresh(), 750);
      void refresh();
      const stop = () => { active = false; clearInterval(timer); off?.(); agentWatchStops.delete(stop); };
      agentWatchStops.add(stop);
      return stop;
    },
    async cancelAgentTask(taskId) {
      const cmd = oa()?.task?.command;
      if (!cmd) return { ok: false, error: "TASK_UNAVAILABLE" };
      const res = await cmd({ type: "task/cancel", payload: { taskId } }).catch(() => null);
      return res ? { ok: res.ok === true, error: typeof res.error === "string" ? res.error : undefined } : { ok: false, error: "TASK_UNAVAILABLE" };
    },
    async importRemote(canvasId, url, name) {
      const cmd = canvasCmd(); if (!cmd || !/^https?:\/\//i.test(url)) return url;
      const res = await cmd({ type: "canvas/importRemote", canvasId, url, name }).catch(() => null);
      return res && res.ok && res.ref ? String(res.ref) : url;
    },
    async importAsset(canvasId, dataUrl, name) {
      const cmd = canvasCmd(); if (!cmd || !dataUrl.startsWith("data:")) return dataUrl;
      const res = await cmd({ type: "canvas/importAsset", canvasId, name, dataUrl }).catch(() => null);
      return res && res.ok && res.ref ? String(res.ref) : dataUrl;
    },
    async mediaUrl(ref) {
      const cmd = canvasCmd(); if (!cmd || !ref.startsWith("openarc-asset:")) return null;
      const res = await cmd({ type: "canvas/assetMediaUrl", ref }).catch(() => null);
      return res && res.ok && typeof res.url === "string" ? { url: String(res.url), expiresAt: Number(res.expiresAt) || Date.now() + 3600_000 } : null;
    },
    async resolveAsset(ref) {
      const cmd = canvasCmd(); if (!cmd) return null;
      const res = await cmd({ type: "canvas/readAsset", ref }).catch(() => null);
      return res && res.ok && res.dataUrl ? String(res.dataUrl) : null;
    },
    async extractDocument(dataUrl, name) {
      const cmd = canvasCmd(); if (!cmd) return { ok: false as const, error: "NO_BRIDGE" };
      const res: Record<string, any> = await cmd({ type: "media/extractDocument", dataUrl, name }).catch(() => ({ ok: false, error: "EXTRACT_FAILED" }));
      return res && res.ok && typeof res.text === "string" ? { ok: true as const, text: res.text, truncated: !!res.truncated } : { ok: false as const, error: String(res?.error || "EXTRACT_FAILED"), ...(res?.detail ? { detail: String(res.detail) } : {}) };
    },
    async detectScenes(dataUrl) {
      const cmd = canvasCmd(); if (!cmd) return { ok: false as const, error: "NO_BRIDGE" };
      const res: Record<string, any> = await cmd({ type: "media/detectScenes", dataUrl }).catch((e: unknown) => ({ ok: false, error: "DETECT_FAILED", detail: String((e as Error)?.message || e) }));
      if (res && res.ok && Array.isArray(res.shots)) return { ok: true as const, duration: Number(res.duration) || 0, shots: res.shots.map((x: any) => ({ inSec: Number(x.inSec) || 0, outSec: Number(x.outSec) || 0 })), ...(res.capped ? { capped: true } : {}) };
      return { ok: false as const, error: String(res?.error || "DETECT_FAILED"), ...(res?.detail ? { detail: String(res.detail) } : {}) };
    },
    async clipVideo(canvasId, dataUrl, segments, name) {
      const cmd = canvasCmd(); if (!cmd) return { ok: false, clips: [], error: "NO_BRIDGE" };
      const res: Record<string, any> = await cmd({ type: "media/clipToCanvas", canvasId, dataUrl, segments, fileName: name }).catch((e: unknown) => ({ ok: false, error: "CLIP_FAILED", detail: String((e as Error)?.message || e) }));
      return { ok: !!res?.ok, clips: Array.isArray(res?.clips) ? res.clips : [], ...(Number(res?.dropped) > 0 ? { dropped: Number(res.dropped) } : {}), ...(res?.ok ? {} : { error: String(res?.error || "CLIP_FAILED") }) };
    },
  };
}
