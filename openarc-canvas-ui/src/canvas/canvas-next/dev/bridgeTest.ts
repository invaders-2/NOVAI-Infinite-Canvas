// 桥接后端的素材转链接测试：用假的 window.openarc 记录收到的命令
import { createBridgeBackend } from "../backend/bridge";
import { specFor } from "../model";
const calls: any[] = []; let publicUrl = (window as any).__publicUrl !== false;
(window as any).openarc = { canvas: { command: async (r: any) => {
  calls.push({ type: r.type, keys: Object.keys(r), sample: JSON.stringify({ src: r.sourceUrl, srcData: r.sourceDataUrl ? "data(" + r.sourceDataUrl.length + ")" : undefined, images: r.images, video: r.payload?.params?.video }) });
  if (r.type === "canvas/run") return { ok: true, runId: "run1" };
  if (r.type === "canvas/importAsset") return { ok: true, ref: "openarc-asset:res_" + r.name };
  if (r.type === "canvas/assetPublicUrl") return publicUrl ? { ok: true, url: "https://cdn.example.com/" + r.ref.slice(14) + ".bin", expiresAt: Date.now() + 3600e3 } : { ok: false, error: "CANVAS_COMMAND_NOT_ALLOWED" };
  if (r.type === "canvas/readAsset") return { ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" };
  if (r.type === "canvas/modelImageEdit") return { ok: true, images: [{ url: "https://out/1.png" }] };
  if (r.type === "canvas/nodes/execute") return { ok: true, outputs: { videos: [{ url: "https://out/v.mp4" }] } };
  return { ok: true };
} } };
(window as any).runTest = async (pu: boolean) => {
  publicUrl = pu; calls.length = 0; const be = createBridgeBackend();
  const img = specFor({ configId: "c1", label: "Banana Pro", kind: "image" }); const vid = specFor({ configId: "c2", label: "Seedance 2.0", kind: "video" });
  const out: any = {};
  try { await be.generate({ canvasId: "cv", nodeId: "n1", kind: "image", model: img, prompt: "p", resolvedPrompt: "p", params: { model: "c1", ratio: "1:1", size: "2K", count: 1, search: false, style: "无", camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 3 } } as any, inputs: [{ nodeId: "a", title: "a", kind: "image", order: 1, role: "reference", url: "openarc-asset:res_abc" }] }, () => {}, new AbortController().signal); out.image = calls.filter((c) => c.type === "canvas/modelImageEdit").map((c) => c.sample); } catch (e: any) { out.imageErr = e.message; }
  calls.length = 0;
  try { await be.generate({ canvasId: "cv", nodeId: "n2", kind: "video", model: vid, prompt: "p", resolvedPrompt: "p", params: { model: "c2", mode: "视频延长", ratio: "16:9", res: "720p", dur: 5, sound: false, times: 1 } as any, inputs: [{ nodeId: "v", title: "v", kind: "video", order: 1, role: "source_video", url: "openarc-asset:res_vid" }] }, () => {}, new AbortController().signal); out.video = calls.filter((c) => c.type === "canvas/nodes/execute").map((c) => c.sample); } catch (e: any) { out.videoErr = e.message; }
  return out;
};
