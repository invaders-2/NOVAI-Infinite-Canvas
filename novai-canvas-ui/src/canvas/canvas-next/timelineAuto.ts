/**
 * 剪辑时间线「导出成片到画布」的无界面版本：画布助手建好时间线后由 agent/autorun 调用，
 * 和时间线编辑器里的「导出到画布」同一套渲染：
 *   · 用到画中画 / 变换 / 关键帧 / 擦除推入放大转场 / 调色 / 自动压低 → 浏览器逐帧合成 MP4（后端 ffmpeg 做不了这些）
 *   · 否则 NOVAI 后端 ffmpeg；都不行就浏览器录制 WebM
 */
import { novaiTimelineAvailable, renderTimelineNovai } from "../react-canvas/timelineExportBackend";
import { addFiles } from "./actions";
import { newNode, outOf } from "./model";
import type { CanvasStore } from "./store";
import { exportMp4Browser } from "./timelineExportMp4";
import { autoRes, frameSize, needsCompositor, normalize, RATIOS, RESES, renderPlan, toSrt, totalOf, trackOf, type Clip, type MediaSize } from "./timelineModel";
import { recordWebM, type SubStyle } from "./timelinePlayer";
import { resolveMediaUrl } from "./ui/useAsset";

export type TimelineExportResult = { ok: boolean; url?: string; nodeId?: string; dur?: number; err?: string };

export async function exportTimelineNode(store: CanvasStore, id: string): Promise<TimelineExportResult> {
  const node = store.node(id); if (!node || node.kind !== "timeline") return { ok: false, err: "剪辑时间线不在画布上了" };
  // 编辑器里隐藏的轨道（眼睛关掉的）导出时同样不要
  const hiddenTracks = ((node.data || {}) as { tlTracks?: Record<string, boolean> }).tlTracks || {};
  const clips = normalize((node.clips || []) as Clip[]).filter((c) => !hiddenTracks[trackOf(c)])
    // 「原声」轨静音：画面里视频自带的声音不出
    .map((c) => (hiddenTracks.vaudio && c.mediaKind === "video" && (trackOf(c) === "video" || trackOf(c) === "overlay") ? { ...c, volume: 0 } : c));
  if (!totalOf(clips) || !clips.some((c) => c.type !== "subtitle" && c.mediaKind !== "audio" && c.url)) return { ok: false, err: "时间线上还没有画面片段" };
  const data = (node.data || {}) as { tlRes?: string; tlSub?: SubStyle; tlFit?: "contain" | "cover" };
  const ratio = (RATIOS as readonly string[]).includes(String(node.ratio)) ? String(node.ratio) : "16:9";
  // 没手选清晰度时按素材真实尺寸定档（与时间线编辑器同一套规则），不再写死 1080p / 720p
  const res = (RESES as readonly string[]).includes(String(data.tlRes)) ? String(data.tlRes) : autoRes(clips.flatMap((c): MediaSize[] => {
    if (c.type === "subtitle" || c.mediaKind === "audio" || !c.url) return [];
    const src = c.sourceNodeId ? store.node(c.sourceNodeId) : null;
    const o = src ? outOf(src) : null;
    const w = Number(o?.w); const h = Number(o?.h);
    return w > 0 && h > 0 ? [{ w, h }] : [];
  }));
  const size = frameSize(ratio, res); const title = (node.text || "剪辑时间线") + " · 成片";
  const at = { x: node.x + node.w + 120, y: node.y };
  const resolve = (u: string) => resolveMediaUrl(store.backend, u);
  /** 成片文件放到画布上（上传成新视频节点） */
  const placeFile = async (blob: Blob, ext: string, mime: string) => {
    const had = new Set(store.state.doc.nodes.map((n) => n.id));
    await addFiles(store, [new File([blob], title + "." + ext, { type: blob.type || mime })], at);
    const made = store.state.doc.nodes.find((n) => !had.has(n.id) && n.kind === "video");
    if (made) store.patchGen(made.id, { title });
    return made;
  };
  try {
    if (needsCompositor(clips) && typeof VideoEncoder === "function") {
      const blob = await exportMp4Browser(clips, size, resolve, { subStyle: data.tlSub, fit: data.tlFit === "cover" ? "cover" : "contain" });
      const made = await placeFile(blob, "mp4", "video/mp4");
      if (made) store.toast(`「${title}」已导出并放到画布上`, 5000);
      return { ok: !!made, nodeId: made?.id, dur: Math.round(totalOf(clips) * 10) / 10, err: made ? undefined : "成片没有放到画布上" };
    }
    if (novaiTimelineAvailable()) {
      const r = await renderTimelineNovai({ ...renderPlan(clips), srt: toSrt(clips), subStyle: data.tlSub, ...size, filename: (node.text || "剪辑时间线") + ".mp4" });
      const vw = 320; const vh = Math.round((vw * r.height) / Math.max(1, r.width));
      const made = newNode("video", at.x, at.y, { title, hist: [{ url: r.url, dur: r.duration, w: r.width, h: r.height, meta: { model: "剪辑时间线", at: Date.now() } }], uploaded: true, w: vw, h: vh });
      store.addNodes([made], [], { select: false });
      store.toast(`「${title}」已导出并放到画布上` + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : ""), 5000);
      return { ok: true, url: r.url, nodeId: made.id, dur: Math.round(r.duration * 10) / 10 };
    }
    const blob = await recordWebM(clips, size, resolve, undefined, data.tlSub);
    const made = await placeFile(blob, "webm", "video/webm");
    return { ok: !!made, nodeId: made?.id, dur: Math.round(totalOf(clips) * 10) / 10, err: made ? undefined : "成片没有放到画布上" };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : "导出失败" };
  }
}
