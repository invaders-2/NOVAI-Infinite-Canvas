/**
 * 剪辑时间线「导出成片到画布」的无界面版本：画布助手建好时间线后由 agent/autorun 调用，
 * 和时间线编辑器里的「导出到画布」同一套渲染（NOVAI 后端 ffmpeg；没有就用浏览器录制 WebM）。
 */
import { novaiTimelineAvailable, renderTimelineNovai } from "../react-canvas/timelineExportBackend";
import { addFiles } from "./actions";
import { newNode } from "./model";
import type { CanvasStore } from "./store";
import { frameSize, normalize, RATIOS, RESES, renderPlan, toSrt, totalOf, type Clip } from "./timelineModel";
import { recordWebM, type SubStyle } from "./timelinePlayer";
import { resolveMediaUrl } from "./ui/useAsset";

export type TimelineExportResult = { ok: boolean; url?: string; nodeId?: string; dur?: number; err?: string };

export async function exportTimelineNode(store: CanvasStore, id: string): Promise<TimelineExportResult> {
  const node = store.node(id); if (!node || node.kind !== "timeline") return { ok: false, err: "剪辑时间线不在画布上了" };
  const clips = normalize((node.clips || []) as Clip[]);
  if (!totalOf(clips) || !clips.some((c) => c.type !== "subtitle" && c.mediaKind !== "audio" && c.url)) return { ok: false, err: "时间线上还没有画面片段" };
  const data = (node.data || {}) as { tlRes?: string; tlSub?: SubStyle };
  const ratio = (RATIOS as readonly string[]).includes(String(node.ratio)) ? String(node.ratio) : "16:9";
  const res = (RESES as readonly string[]).includes(String(data.tlRes)) ? String(data.tlRes) : "1080p";
  const size = frameSize(ratio, res); const title = (node.text || "剪辑时间线") + " · 成片";
  const at = { x: node.x + node.w + 120, y: node.y };
  try {
    if (novaiTimelineAvailable()) {
      const r = await renderTimelineNovai({ ...renderPlan(clips), srt: toSrt(clips), subStyle: data.tlSub, ...size, filename: (node.text || "剪辑时间线") + ".mp4" });
      const vw = 320; const vh = Math.round((vw * r.height) / Math.max(1, r.width));
      const made = newNode("video", at.x, at.y, { title, hist: [{ url: r.url, dur: r.duration, w: r.width, h: r.height, meta: { model: "剪辑时间线", at: Date.now() } }], uploaded: true, w: vw, h: vh });
      store.addNodes([made], [], { select: false });
      store.toast(`「${title}」已导出并放到画布上` + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : ""), 5000);
      return { ok: true, url: r.url, nodeId: made.id, dur: Math.round(r.duration * 10) / 10 };
    }
    const blob = await recordWebM(clips, size, (u) => resolveMediaUrl(store.backend, u), undefined, data.tlSub);
    const had = new Set(store.state.doc.nodes.map((n) => n.id));
    await addFiles(store, [new File([blob], title + ".webm", { type: blob.type || "video/webm" })], at);
    const made = store.state.doc.nodes.find((n) => !had.has(n.id) && n.kind === "video");
    if (made) store.patchGen(made.id, { title });
    return { ok: !!made, nodeId: made?.id, dur: Math.round(totalOf(clips) * 10) / 10, err: made ? undefined : "成片没有放到画布上" };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : "导出失败" };
  }
}
