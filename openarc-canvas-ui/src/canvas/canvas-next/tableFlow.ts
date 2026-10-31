/**
 * 分镜出片：从一张表（分镜表）接出「首帧图」图片节点和「分镜视频」视频节点。
 *   首帧图 —— 逐行按画面描述出图，结果填回表格的「首帧」列；
 *   分镜视频 —— 逐行读首帧（和尾帧）+ 提示词列出视频，时长 / 比例按行。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, uid, withGen, type ImageParams, type VideoParams } from "./model";
import type { CanvasStore } from "./store";
import { rolesOf, tableOf, withBatch, withStoryboardMedia, withTable } from "./table";

export const FIRST_FRAME_PROMPT = "按这一行的画面描述，生成这个镜头开场的第一帧静帧画面：构图完整、主体清晰，适合作为视频首帧。";

export function storyboardPipeline(store: CanvasStore, tableId: string): { image: CanvasNode; video: CanvasNode } | null {
  const tn = store.node(tableId); if (!tn || tn.kind !== "table") return null;
  // 表里还没有首帧列：先补上首帧 / 尾帧两列
  let t = tableOf(tn);
  if (!rolesOf(t).some((r) => r.role === "first")) { t = withStoryboardMedia(t); store.updateNode(tableId, (n) => ({ ...withTable(n, t), w: Math.max(n.w, Math.min(1200, n.w + 2 * 132)) }), { history: true }); }
  const first = rolesOf(t).findIndex((r) => r.role === "first");
  const x = tn.x + (store.node(tableId)?.w ?? tn.w) + 140;
  let image = store.newNode("image", x, tn.y, { title: "首帧图", prompt: FIRST_FRAME_PROMPT });
  // 分镜视频放在首帧图的结果列下方：首帧图每行一个结果排在它右侧，视频结果也排在视频节点右侧，竖向错开才不会叠在一起
  const rowsN = Math.max(1, t.rows.length); const imgRowH = Math.round(image.w * 9 / 16) + 64;
  let video = store.newNode("video", x, tn.y + Math.max(image.h + 120, rowsN * imgRowH + 80), { title: "分镜视频" });
  // 首帧图跟视频用同一个比例，首帧才不会被裁
  const vp = genOf(video).params as VideoParams; const ip = genOf(image).params as ImageParams; const im = store.defaultModel("image");
  if (vp.ratio && (!im?.ratios?.length || im.ratios.includes(vp.ratio))) image = withGen(image, { params: { ...ip, ratio: vp.ratio } });
  image = withBatch(image, { settings: { fill: { table: tableId, col: first } } });
  video = withBatch(video, { settings: { concurrency: 2 } });
  store.addNodes([image, video], [{ id: uid("e"), from: tableId, to: image.id }, { id: uid("e"), from: tableId, to: video.id }], { select: true });
  store.toast("已接好「首帧图」和「分镜视频」：先运行首帧图，图会填回表格的首帧列；再运行分镜视频", 6000);
  return { image: store.node(image.id)!, video: store.node(video.id)! };
}
