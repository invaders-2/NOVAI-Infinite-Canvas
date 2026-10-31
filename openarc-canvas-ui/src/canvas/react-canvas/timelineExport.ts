export type TimelineExportClip = { url: string; mediaKind: "video" | "audio"; inPoint: number; outPoint: number; type?: "subtitle"; text?: string; start?: number; end?: number; fadeIn?: number; fadeOut?: number };

type ExportOptions = {
  clips: TimelineExportClip[];
  fileName: string;
  onProgress?: (current: number, total: number) => void;
  isCancelled?: () => boolean;
};

function drawSubtitleTracks(ctx: CanvasRenderingContext2D, clips: TimelineExportClip[], time: number) {
  for (const clip of clips) {
    if (clip.type !== "subtitle" || time < (clip.start || 0) || time > (clip.end || 0)) continue;
    const text = String(clip.text || "").trim(); if (!text) continue;
    ctx.font = "600 34px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    const maxWidth = WIDTH - 120; const words = text.split(""); const lines: string[] = []; let line = "";
    for (const ch of words) { if (ctx.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ch; } else line += ch; }
    if (line) lines.push(line);
    const baseY = HEIGHT - 56;
    lines.slice(-3).forEach((value, index, list) => {
      const y = baseY - (list.length - 1 - index) * 44;
      const width = ctx.measureText(value).width;
      ctx.fillStyle = "rgba(0,0,0,.62)"; ctx.fillRect((WIDTH - width) / 2 - 18, y - 36, width + 36, 42);
      ctx.lineWidth = 6; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.strokeText(value, WIDTH / 2, y);
      ctx.fillStyle = "#fff"; ctx.fillText(value, WIDTH / 2, y);
    });
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  }
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

function abortError(): Error {
  const error = new Error("EXPORT_CANCELLED");
  error.name = "AbortError";
  return error;
}

function drawLetterbox(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void {
  const vw = video.videoWidth || WIDTH;
  const vh = video.videoHeight || HEIGHT;
  const scale = Math.min(WIDTH / vw, HEIGHT / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.drawImage(video, (WIDTH - dw) / 2, (HEIGHT - dh) / 2, dw, dh);
}

function waitForEvent(target: EventTarget, name: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("MEDIA_LOAD_TIMEOUT")); }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("MEDIA_LOAD_FAILED")); };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(name, onOk);
      target.removeEventListener("error", onErr);
    };
    target.addEventListener(name, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
  });
}

export async function exportTimelineWebM({ clips, fileName, onProgress, isCancelled }: ExportOptions): Promise<Blob> {
  if (!clips.length) throw new Error("EMPTY_TIMELINE");
  if (typeof MediaRecorder !== "function") throw new Error("MEDIA_RECORDER_UNAVAILABLE");
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") throw new Error("CAPTURE_STREAM_UNAVAILABLE");
  if (typeof AudioContext !== "function") throw new Error("AUDIO_CONTEXT_UNAVAILABLE");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
  const mimeCandidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
  const audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();
  const gain = audioCtx.createGain();
  gain.connect(destination);
  const videoStream = canvas.captureStream(FPS);
  const stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  const mediaClips = clips.filter((clip) => clip.type !== "subtitle");
  const total = Math.max(1, mediaClips.reduce((sum, clip) => sum + Math.max(0.1, clip.outPoint - clip.inPoint), 0), ...clips.filter((clip) => clip.type === "subtitle").map((clip) => Number(clip.end) || 0));
  const startAt = performance.now();
  let elapsed = 0;
  const media: HTMLMediaElement[] = [];
  const sources: MediaElementAudioSourceNode[] = [];
  const cleanup = () => {
    for (const element of media) { try { element.pause(); } catch { /* ignore */ } try { element.removeAttribute("src"); element.load(); } catch { /* ignore */ } }
    for (const source of sources) { try { source.disconnect(); } catch { /* ignore */ } }
    try { gain.disconnect(); } catch { /* ignore */ }
    for (const track of stream.getTracks()) { try { track.stop(); } catch { /* ignore */ } }
    try { audioCtx.close(); } catch { /* ignore */ }
  };
  try {
    recorder.start(200);
    for (const clip of clips) {
      if (clip.type === "subtitle") continue;
      if (isCancelled?.()) throw abortError();
      const element = document.createElement(clip.mediaKind === "audio" ? "audio" : "video") as HTMLMediaElement;
      element.crossOrigin = "anonymous";
      element.preload = "auto";
      element.src = clip.url;
      media.push(element);
      await waitForEvent(element, "loadedmetadata");
      if (isCancelled?.()) throw abortError();
      const seeked = waitForEvent(element, "seeked");
      element.currentTime = clip.inPoint;
      await seeked;
      if (isCancelled?.()) throw abortError();
      if (clip.mediaKind === "video" && !(element as HTMLVideoElement).videoWidth) throw new Error("VIDEO_METADATA_INVALID");
      const source = audioCtx.createMediaElementSource(element);
      source.connect(gain);
      sources.push(source);
      await element.play();
      const duration = Math.max(0.1, clip.outPoint - clip.inPoint);
      const clipStart = performance.now();
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (isCancelled?.()) { reject(abortError()); return; }
          const current = Math.min(duration, (performance.now() - clipStart) / 1000);
          elapsed += 0; // total elapsed tracked below
          const overall = clips.slice(0, clips.indexOf(clip)).filter((item) => item.type !== "subtitle").reduce((sum, item) => sum + Math.max(0.1, item.outPoint - item.inPoint), 0) + current;
          const fadeIn = Math.max(0, Number(clip.fadeIn) || 0) / 1000; const fadeOut = Math.max(0, Number(clip.fadeOut) || 0) / 1000;
          const opacity = Math.min(1, fadeIn > 0 ? current / fadeIn : 1, fadeOut > 0 ? (duration - current) / fadeOut : 1);
          ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
          if (clip.mediaKind === "video") drawLetterbox(ctx, element as HTMLVideoElement);
          else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, WIDTH, HEIGHT); }
          ctx.globalAlpha = 1;
          drawSubtitleTracks(ctx, clips, overall);
          onProgress?.(Math.min(total, overall), total);
          if (current >= duration) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      try { element.pause(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
    }
    if (isCancelled?.()) throw abortError();
    elapsed = (performance.now() - startAt) / 1000;
    onProgress?.(total, total);
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: mimeType || "video/webm" });
    if (!blob.size) throw new Error("EMPTY_RECORDING");
    return blob;
  } catch (error) {
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* ignore */ }
    throw error;
  } finally {
    cleanup();
  }
}

export function downloadTimelineBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".webm") ? fileName : fileName + ".webm";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 1000);
}
