type Bridge = {
  canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> };
  media?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>; onEvent?: (cb: (event: unknown) => void) => () => void };
};

function bridge(): Bridge {
  return ((window as unknown as { openarc?: Bridge }).openarc || {}) as Bridge;
}

export function backendExportAvailable(): boolean {
  const api = bridge();
  return typeof api.media?.command === "function" && typeof api.canvas?.command === "function";
}

function base64FromDataUrl(url: string): { base64: string; mime: string } | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(url);
  if (!match) return null;
  return { mime: match[1] || "application/octet-stream", base64: match[2] || "" };
}

async function urlToBase64(url: string, kind: "video" | "audio"): Promise<{ base64: string; mime: string }> {
  const direct = base64FromDataUrl(url);
  if (direct) return direct;
  const api = bridge();
  if (url.startsWith("openarc-asset:")) {
    const ref = url.slice("openarc-asset:".length);
    const res = await api.canvas?.command?.({ type: "canvas/readAsset", ref }) as Record<string, any> | undefined;
    const dataUrl = String((res && (res.dataUrl || res.url || (res.asset && (res.asset.dataUrl || res.asset.url)))) || "");
    const parsed = dataUrl ? base64FromDataUrl(dataUrl) : null;
    if (!parsed) throw new Error("ASSET_READ_FAILED");
    return parsed;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error("ASSET_FETCH_FAILED");
  const buffer = await response.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mime: response.headers.get("content-type") || (kind === "video" ? "video/mp4" : "audio/mpeg") };
}

export type BackendExportClip = { url: string; mediaKind: "video" | "audio"; inPoint: number; outPoint: number };

/** 画布 id → 固定的 UUID（SHA-1 截取，按 v5 格式置版本 / 变体位），同一张画布每次导出都进同一个媒体项目 */
async function canvasProjectUuid(canvasId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("openarc-canvas-export:" + String(canvasId || "default")))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function exportTimelineMp4({ clips, canvasId, onProgress }: { clips: BackendExportClip[]; canvasId: string; onProgress?: (value: number) => void }): Promise<{ relativePath: string }> {
  const api = bridge();
  if (typeof api.media?.command !== "function") throw new Error("MEDIA_SERVICE_UNAVAILABLE");
  if (typeof api.canvas?.command !== "function") throw new Error("CANVAS_BRIDGE_UNAVAILABLE");
  if (!clips.length) throw new Error("EMPTY_TIMELINE");
  const projectId = await canvasProjectUuid(canvasId); // 媒体服务只认 UUID 形式的项目 ID
  // 媒体服务返回 { ok, value } 信封：在这里拆开，失败时把服务给的原因带出去
  const command = async (cmd: string, payload: Record<string, unknown>): Promise<any> => {
    const r: any = await api.media!.command!({ command: cmd, payload });
    if (r && r.ok === false) throw new Error(String(r.message || r.error || cmd + " 失败"));
    return r && typeof r === "object" && "value" in r && r.ok === true ? r.value : r;
  };
  onProgress?.(3);
  await command("media/project/ensure", { projectId, projectName: "Canvas 导出" });
  const videoClips: Array<Record<string, unknown>> = [];
  const audioClips: Array<Record<string, unknown>> = [];
  // 视频轨、音频轨各自从 0 开始依次排（配音 / 音乐垫在画面下面），成片时长取两轨里较长的
  let vCursor = 0; let aCursor = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const media = await urlToBase64(clip.url, clip.mediaKind);
    const extOf: Record<string, string> = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg" };
    const name = "canvas-" + projectId + "-" + i + (extOf[String(media.mime).toLowerCase()] || (clip.mediaKind === "video" ? ".mp4" : ".mp3"));
    const saved = await command("media/asset/save", { projectId, name, mime: media.mime, base64: media.base64 });
    const asset = (saved && saved.asset) as Record<string, unknown> | undefined;
    if (!asset || !asset.id) throw new Error("ASSET_SAVE_FAILED");
    const durationMs = Math.max(100, Math.round((clip.outPoint - clip.inPoint) * 1000));
    const sourceInMs = Math.max(0, Math.round(clip.inPoint * 1000));
    const sourceOutMs = Math.max(sourceInMs + 100, Math.round(clip.outPoint * 1000));
    const entry = {
      id: "clip-" + (clip.mediaKind === "video" ? "v" + (videoIndex += 1) : "a" + (audioIndex += 1)),
      trackId: clip.mediaKind === "video" ? "video-track" : "audio-track",
      assetId: String(asset.id),
      name,
      timelineStartMs: clip.mediaKind === "video" ? vCursor : aCursor,
      durationMs,
      sourceInMs,
      sourceOutMs,
      volume: 1,
    };
    if (clip.mediaKind === "video") videoClips.push(entry); else audioClips.push(entry);
    if (clip.mediaKind === "video") vCursor += durationMs; else aCursor += durationMs;
    onProgress?.(5 + Math.round(((i + 1) / clips.length) * 35));
  }
  if (!videoClips.length) throw new Error("NO_VISUAL_CLIP");
  const timeline = {
    schemaVersion: "1.0",
    projectId,
    version: 1,
    timebase: 1000,
    canvas: { width: 1280, height: 720, fps: 30 },
    durationMs: Math.max(0, vCursor, aCursor),
    outputProfileId: null,
    tracks: [
      { id: "video-track", type: "video", name: "视频", order: 0, locked: false, muted: false, hidden: false, clips: videoClips },
      { id: "audio-track", type: "voice", name: "音频", order: 1, locked: false, muted: false, hidden: false, clips: audioClips },
    ].filter((track) => track.clips.length > 0),
    transitions: [],
  };
  onProgress?.(45);
  const rendered = await command("media/render/submit", { projectId, projectName: "Canvas 导出", timeline });
  const renderJob = (rendered && rendered.job) as Record<string, unknown> | undefined;
  if (!renderJob || !renderJob.id) throw new Error("RENDER_SUBMIT_FAILED");
  onProgress?.(60);
  await command("media/render/run", { workerId: "canvas_export_worker", timeoutMs: 600000 });
  onProgress?.(90);
  const exported = await command("media/render/export", { projectId, jobId: renderJob.id, target: "finder", name: "剪辑时间线-" + (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; })() + ".mp4", requestedName: "timeline-" + canvasId });
  const payload = (exported && (exported.export || exported.artifact || exported)) as Record<string, unknown>;
  const relativePath = String((payload && (payload.relativePath || payload.path)) || "");
  if (!relativePath) throw new Error("EXPORT_PATH_MISSING");
  onProgress?.(100);
  return { relativePath };
}

/* ---------------- 新版剪辑时间线：按片段位置 / 音量 / 转场 / 字幕 / 画幅渲染 ---------------- */

export type PlanClip = { id: string; url: string; track: "video" | "audio"; timelineStartMs: number; durationMs: number; sourceInMs: number; sourceOutMs: number; volume: number; transitionIn?: { type: "fade" | "dissolve"; durationMs: number } };

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const utf8Base64 = (text: string) => { const bytes = new TextEncoder().encode(text); let bin = ""; for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]); return btoa(bin); };

/**
 * 交给媒体服务（ffmpeg）渲染 MP4。
 *   · 同一个源文件只上传一次（切开的片段共用素材）
 *   · 视频自带的声音单独放一条音轨，跟着片段音量走；音频轨的转场只支持淡入，所以溶解在音轨上按淡入处理
 *   · 字幕做成 SRT 叠上去；如果本机 ffmpeg 不支持字幕滤镜，就去掉字幕再渲一次，并告诉调用方
 */
export async function exportPlanMp4({ clips, durationMs, srt, width, height, canvasId, onProgress }: { clips: PlanClip[]; durationMs: number; srt?: string; width: number; height: number; canvasId: string; onProgress?: (value: number) => void }): Promise<{ relativePath: string; subtitlesDropped: boolean }> {
  const api = bridge();
  if (typeof api.media?.command !== "function") throw new Error("MEDIA_SERVICE_UNAVAILABLE");
  if (!clips.some((c) => c.track === "video")) throw new Error("视频轨上还没有片段");
  const projectId = await canvasProjectUuid(canvasId);
  const command = async (cmd: string, payload: Record<string, unknown>): Promise<any> => {
    const r: any = await api.media!.command!({ command: cmd, payload });
    if (r && r.ok === false) throw new Error(String(r.message || r.error || cmd + " 失败"));
    return r && typeof r === "object" && "value" in r && r.ok === true ? r.value : r;
  };
  onProgress?.(2);
  await command("media/project/ensure", { projectId, projectName: "Canvas 导出" });
  const extOf: Record<string, string> = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg" };
  const assets = new Map<string, { id: string; hasAudio: boolean }>();
  const urls = [...new Set(clips.map((c) => c.url))];
  for (let i = 0; i < urls.length; i += 1) {
    const kind = clips.find((c) => c.url === urls[i])!.track;
    const media = await urlToBase64(urls[i], kind);
    const name = "canvas-" + projectId.slice(0, 8) + "-" + i + (extOf[String(media.mime).toLowerCase()] || (kind === "video" ? ".mp4" : ".mp3"));
    const saved = await command("media/asset/save", { projectId, name, mime: media.mime, base64: media.base64 });
    const asset = saved && saved.asset;
    if (!asset || !asset.id) throw new Error("ASSET_SAVE_FAILED");
    assets.set(urls[i], { id: String(asset.id), hasAudio: asset.hasAudio !== false });
    onProgress?.(4 + Math.round(((i + 1) / urls.length) * 36));
  }
  const entry = (c: PlanClip, trackId: string, idPrefix: string, audioTrack: boolean) => ({
    id: idPrefix + c.id, trackId, assetId: assets.get(c.url)!.id, name: c.id,
    timelineStartMs: c.timelineStartMs, durationMs: c.durationMs, sourceInMs: c.sourceInMs, sourceOutMs: c.sourceOutMs,
    volume: Math.max(0, Math.min(2, c.volume)),
    ...(c.transitionIn ? { transitionIn: { type: audioTrack ? "fade" : c.transitionIn.type, durationMs: c.transitionIn.durationMs } } : {}),
  });
  const video = clips.filter((c) => c.track === "video");
  const tracks: Array<Record<string, unknown>> = [
    { id: "video-track", type: "video", name: "视频", order: 0, locked: false, muted: false, hidden: false, clips: video.map((c) => entry(c, "video-track", "v-", false)) },
    { id: "video-sound", type: "voice", name: "视频原声", order: 1, locked: false, muted: false, hidden: false, clips: video.filter((c) => assets.get(c.url)!.hasAudio && c.volume > 0).map((c) => entry(c, "video-sound", "vs-", true)) },
    { id: "audio-track", type: "music", name: "音频", order: 2, locked: false, muted: false, hidden: false, clips: clips.filter((c) => c.track === "audio" && c.volume > 0).map((c) => entry(c, "audio-track", "a-", true)) },
  ].filter((t) => (t.clips as unknown[]).length > 0);
  let subTrack: Record<string, unknown> | null = null;
  if (srt && srt.trim()) {
    const saved = await command("media/asset/save", { projectId, name: "canvas-" + projectId.slice(0, 8) + "-subs.srt", mime: "application/x-subrip", base64: utf8Base64(srt) });
    if (saved && saved.asset && saved.asset.id) subTrack = { id: "subtitle-track", type: "subtitle", name: "字幕", order: 3, locked: false, muted: false, hidden: false, clips: [{ id: "subs", trackId: "subtitle-track", assetId: String(saved.asset.id), name: "字幕", timelineStartMs: 0, durationMs: Math.max(100, durationMs), sourceInMs: 0, sourceOutMs: Math.max(100, durationMs), volume: 1 }] };
  }
  const render = async (withSubs: boolean) => {
    const timeline = { schemaVersion: "1.0", projectId, version: 1, timebase: 1000, canvas: { width, height, fps: 30 }, durationMs: Math.max(100, durationMs), outputProfileId: null, tracks: withSubs && subTrack ? [...tracks, subTrack] : tracks, transitions: [] };
    onProgress?.(45);
    const rendered = await command("media/render/submit", { projectId, projectName: "Canvas 导出", timeline });
    const job = rendered && rendered.job; if (!job || !job.id) throw new Error("RENDER_SUBMIT_FAILED");
    onProgress?.(55);
    const ran = await command("media/render/run", { workerId: "canvas_export_worker", timeoutMs: 900000 });
    const status = String((ran && (ran.job?.status || ran.status)) || "");
    if (/fail|error/i.test(status)) throw new Error(String(ran.error?.message || ran.job?.error || ran.job?.errorMessage || "渲染失败"));
    onProgress?.(92);
    return job.id as string;
  };
  let subtitlesDropped = false; let jobId: string;
  try { jobId = await render(true); }
  catch (err) { if (!subTrack) throw err; subtitlesDropped = true; jobId = await render(false); }
  const exported = await command("media/render/export", { projectId, jobId, target: "finder", name: "剪辑时间线-" + stamp() + ".mp4", requestedName: "timeline-" + canvasId });
  const payload = (exported && (exported.export || exported.artifact || exported)) as Record<string, unknown>;
  const relativePath = String((payload && (payload.relativePath || payload.path)) || "");
  if (!relativePath) throw new Error("EXPORT_PATH_MISSING");
  onProgress?.(100);
  return { relativePath, subtitlesDropped };
}
