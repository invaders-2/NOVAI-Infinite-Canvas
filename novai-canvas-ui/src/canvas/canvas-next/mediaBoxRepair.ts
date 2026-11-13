/**
 * 老画布纠偏：画布助手以前把参考图节点一律建成 240×240（见 main.py `_agent_beat_new_node`），
 * 节点正文又是 object-fit:cover —— 扁平长图在画布上只剩中间一条，看不到原图比例。
 * 外链参考图（模型直接给的 URL）建节点时量不到像素，走的也是这个默认尺寸。
 *
 * 只认「助手建的上传节点、当前版本还没量过像素」这一种：量一次真实像素，
 * 宽度不动、按源图比例把高度改对，并把像素写回版本记录。之后按已有尺寸走：
 * 用户拖动（媒体节点保持比例）和「替换素材保留尺寸」（替换会写入新像素）都不会被反复纠正。
 */
import { isAssetRef } from "../canvasAssetRefs";
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { fitSourceBox, refitNodeBox } from "./mediaFit";
import { genOf, withGen } from "./model";
import type { CanvasStore } from "./store";

/** 旧版助手固定给图片节点的尺寸：这个尺寸原样保留时按新建节点的规则重摆（可能更宽），不用窄宽度压成细条 */
const LEGACY_AGENT_BOX = 240;
/** 量像素最多等这么久：读不到就当量不到，不卡住画布 */
const DECODE_TIMEOUT_MS = 4000;

type Size = { w: number; h: number };

function decodeSize(url: string): Promise<Size | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (size: Size | null) => { if (done) return; done = true; clearTimeout(timer); resolve(size); };
    const timer = setTimeout(() => finish(null), DECODE_TIMEOUT_MS);
    const img = new Image();
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => finish(null);
    try { img.src = url; } catch { finish(null); }
  });
}

/** 需要纠偏的节点：助手建的上传图片节点，当前版本还没有真实像素 */
export function needsAgentRefFit(node: CanvasNode): boolean {
  if (node.kind !== "image") return false;
  const g = genOf(node);
  if (!g.agent || !g.uploaded) return false;
  const out = g.hist[g.hi];
  return !!out?.url && !(out.w && out.h);
}

export async function repairAgentRefBoxes(store: CanvasStore): Promise<void> {
  const targets = store.state.doc.nodes.filter(needsAgentRefFit);
  if (!targets.length) return;
  const be = store.backend;
  const measured = new Map<string, Size>();
  await Promise.all(targets.map(async (node) => {
    const g = genOf(node);
    const raw = String(g.hist[g.hi]?.url || "");
    if (!raw) return;
    const url = isAssetRef(raw) ? await be.resolveAsset(raw).catch(() => null) : raw;
    const size = url ? await decodeSize(url) : null;
    if (size) measured.set(node.id, size);
  }));
  if (!measured.size) return;
  // 量尺寸期间文档可能被改过（用户拖动 / 生成写回）：落盘前再按当前节点复核一次
  store.mutate((doc) => ({
    ...doc,
    nodes: doc.nodes.map((node) => {
      const size = measured.get(node.id);
      if (!size || !needsAgentRefFit(node)) return node;
      const g = genOf(node);
      const legacyBox = node.w === LEGACY_AGENT_BOX && node.h === LEGACY_AGENT_BOX;
      const box = legacyBox ? fitSourceBox(size.w, size.h) : refitNodeBox(node, size.w, size.h);
      const hist = g.hist.map((out, i) => (i === g.hi ? { ...out, w: size.w, h: size.h } : out));
      return withGen(box ? { ...node, w: box.w, h: box.h } : node, { hist });
    }),
  }));
}
