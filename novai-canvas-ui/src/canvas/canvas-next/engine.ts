/**
 * 生成引擎：组装请求 → 调后端 → 写回节点。界面只调这里的函数。
 *
 *   runNode       单节点生成（首次原地写回；已有结果时先找自己的结果节点覆盖，没有就新建一个后覆盖它）
 *   runChain      运行到此（含上游）/ 从此运行下游
 *   stopNode      停止
 *   buildRequest  请求预览也用它，看到的就是发给后端的
 *   文本节点「输出：多维表格 / 分镜表」→ runTextToTable
 *   上游连着表格的生成节点 → runTableBatch（逐行批量）
 */
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import { GenError, type CanvasTask, type GenInput, type GenRequest } from "./backend/types";
import { fitMediaBox, isAdaptiveRatio, ratioOf, refitNodeBox } from "./mediaFit";
import { batchSourceSize, sourceBoxInDoc, sourceSizeForTier, wantedRatio } from "./originalRatio";
import { applyElements, elementInputs } from "./elements";
import { nodeError } from "./errorText";
import { excludeSelfRefsFlag, filterSelfRefs } from "./agent/selfRefs";
import { mentionedIds, plainPrompt, resolveMentions, selfSourceOf, unmentionedInputs, type SentRef } from "./mentions";
import { autoVideoMode, clamp, cloneParams, draftRes, expandGroupInputs, genOf, inputsOf, isGenKind, outOf, outputsOf, refsIn, textOf, uid, VMODES, withGen, type GenKind, type GenOutput, type ImageParams, type ModelSpec, type TextParams, type VideoMode, type VideoParams } from "./model";
import type { CanvasStore } from "./store";
import { batchOf, batchRows, channelIndexFromId, channelModesOf, CHANNEL_MODE_LABEL, groupInputs, groupNote, growRowsPrompt, inferChannelModesFromRows, keepMediaCells, mergeInputGroups, ownRefCount, padTableRows, parseListPlan, parseTableReply, perRowRowCount, planRepairPrompt, plannedChannelMode, planPrompt, planTextOf, refOrderText, tableChannels, tableInputWarnings, trimTableRows, withStoryboardMedia, emptyRunHint, fillTargetOf, planRow, repairPrompt, rowHasFirst, rowsToRun, STORYBOARD_COLUMNS, tableAutoSize, tableGenKindOf, tableOf, tablePrompt, withBatch, withTable, type BatchJournal, type BatchRow, type ChannelMode, type FillTarget, type InputGroupPlan, type ListPlan, type TableChannel, type TableData } from "./table";

/* ---------- 请求组装 ---------- */
export function rolesFor(kind: GenKind, p: unknown, m: ModelSpec | undefined, ins: ReturnType<typeof inputsOf>) {
  const roles = new Map<string, GenInput["role"]>(); const ignored = new Set<string>();
  const imgs = ins.filter((x) => x.node.kind === "image");
  for (const x of ins) {
    if (x.node.kind === "text" || x.node.kind === "table") { roles.set(x.edge.id, "context"); continue; }
    if (kind === "image") { if (x.node.kind !== "image" || !m?.i2i || imgs.indexOf(x) >= (m?.maxRefs ?? 0)) ignored.add(x.edge.id); else roles.set(x.edge.id, "reference"); continue; }
    if (kind === "text") { if (x.node.kind === "image" && m?.vision) roles.set(x.edge.id, "reference"); else ignored.add(x.edge.id); continue; }
    if (kind === "audio") { ignored.add(x.edge.id); continue; }
    const mode = (p as VideoParams).mode; const i = imgs.indexOf(x);
    if (x.node.kind === "image") {
      const r: GenInput["role"] | null = mode === "首帧" ? (i === 0 ? "first_frame" : null) : mode === "首尾帧" ? (i === 0 ? "first_frame" : i === 1 ? "last_frame" : null) : mode === "参考生视频" || mode === "视频编辑" ? (i < (m?.maxRefs ?? 0) ? "reference" : null) : mode === "数字人" ? (i === 0 ? "portrait" : null) : null;
      r ? roles.set(x.edge.id, r) : ignored.add(x.edge.id);
    } else if (x.node.kind === "video") {
      ["视频编辑", "视频延长", "参考视频生视频"].includes(mode) && ins.filter((y) => y.node.kind === "video")[0] === x ? roles.set(x.edge.id, mode === "参考视频生视频" ? "reference_video" : "source_video") : ignored.add(x.edge.id);
    } else if (x.node.kind === "audio") {
      mode === "数字人" && ins.filter((y) => y.node.kind === "audio")[0] === x ? roles.set(x.edge.id, "driving_audio") : ignored.add(x.edge.id);
    }
  }
  return { roles, ignored };
}
export const ROLE_LABEL: Record<GenInput["role"], string> = { reference: "参考", first_frame: "首帧", last_frame: "尾帧", source_video: "源视频", reference_video: "参考视频", driving_audio: "驱动音频", portrait: "人像", context: "上下文" };

/** 把 @节点·段落 换成段落原文、@{节点} 换成「图1」/原文；没被引用的上游文本作为上下文附在后面 */
export function resolvePrompt(doc: CanvasDoc, node: CanvasNode, extra = "", sent?: SentRef[]): string {
  const all = inputsOf(doc, node.id); const g = genOf(node);
  const skip = unmentionedInputs(node, all); const ins = all.filter((x) => !skip.has(x.edge.id));
  const refs = refsIn(g.prompt, ins);
  let p = g.prompt;
  for (const r of refs.found) p = p.replace(new RegExp("@" + escapeRe(genOf(r.node).title) + "·" + r.key), `「${r.text}」`);
  const mm = resolveMentions(p, doc, sent || ins.filter((x) => isGenKind(x.node.kind) && x.node.kind !== "text").map((x) => ({ nodeId: x.node.id, kind: x.node.kind as GenKind })));
  p = applyElements(mm.text);
  if (node.kind === "text") return [p, extra].filter((s) => s.trim()).join("\n\n");
  const refNodes = new Set([...refs.found.map((r) => r.node.id), ...mm.usedText]);
  const ctx = ins.filter((x) => x.node.kind === "text" && !refNodes.has(x.node.id) && textOf(x.node).trim()).map((x) => textOf(x.node).trim());
  return [...ctx, p, extra].filter((s) => s.trim()).join("\n");
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildRequest(store: CanvasStore, node: CanvasNode, row?: BatchRow, flags?: { excludeSelfRefs?: boolean }): GenRequest | null {
  if (!isGenKind(node.kind)) return null;
  /** 这次生成是否剔除自产物（缺省 false = 既有行为：@ 本节点 / 自己的历史结果照常可以当参考） */
  const excludeSelf = flags?.excludeSelfRefs === true;
  const doc = store.state.doc; const m = store.modelOf(node); if (!m) return null;
  const g = genOf(node);
  // 表格的一行：时长 / 比例 / 首尾帧按行定（planRow），这一行自带图时生成节点自己连的图片不再发送；
  // 图片批量时生成节点自身连的图也会发送，必须先把名额留出来，否则「自身图 + 行素材」会超过模型 maxRefs。
  const plan = row ? planRow(node.kind, g.params, m, row, ownRefCount(doc, node.id, node.kind)) : null;
  let eff = plan ? plan.params : g.params;
  // 原图比例（自适应）在批量行里拿不到源图：row.media 的图不是节点 doc 输入，wantedRatio 只能看出 1:1。
  // 这里按「这一行第一张图的真实像素」算显式 WxH（再回落生成节点自己的上游图），写进该行 params.sourceSize/size。
  // 只修图片批量：视频 batch 的行为保持不变（显式比例、视频原图比例路径都不动）
  if (row && node.kind === "image" && isAdaptiveRatio((eff as { ratio?: string }).ratio)) {
    const tier = String((eff as { resolution?: string }).resolution || "1K");
    const sized = (row.media || []).map((item) => {
      if (item.kind !== "image") return item;
      const up = store.node(item.nodeId); const out = up ? outOf(up) : null;
      return { ...item, w: out?.w, h: out?.h };
    });
    let explicit = batchSourceSize(sized, tier);
    if (!explicit) {
      const box = sourceBoxInDoc(doc, node, node.kind);
      explicit = box ? sourceSizeForTier(box, tier) : "";
    }
    if (explicit) eff = { ...(eff as Record<string, unknown>), sourceSize: explicit, ...(node.kind === "image" ? { size: explicit } : {}) } as typeof eff;
  }
  const allIns = inputsOf(doc, node.id);
  const skip = unmentionedInputs(node, allIns);
  const directIns = allIns.filter((x) => x.node.kind !== "table" && !skip.has(x.edge.id) && !(plan?.ownImages && x.node.kind === "image"));
  const expandedIns = node.kind === "text" ? directIns : expandGroupInputs(doc, directIns);
  const expandedSkip = unmentionedInputs(node, expandedIns, allIns);
  // 标了 excludeSelfRefs：分组展开出来的自己 / 由它生成的结果节点都不进参考图；上游连线和用户手加的引用照旧
  const ins = filterSelfRefs(expandedIns.filter((x) => !expandedSkip.has(x.edge.id)), node.id, excludeSelf);
  const { roles, ignored } = rolesFor(node.kind, eff, m, ins);
  const inputs: GenInput[] = ins.filter((x) => !ignored.has(x.edge.id)).map((x) => ({ nodeId: x.node.id, title: genOf(x.node).title, kind: x.node.kind as GenKind, order: x.order + 1, role: roles.get(x.edge.id) || "context", url: outOf(x.node)?.url || (x.node.kind === "video" ? outOf(x.node)?.frame : undefined), text: x.node.kind === "text" ? textOf(x.node) : undefined }));
  if (plan) plan.inputs.forEach((ri) => { if (!inputs.some((i) => i.nodeId === ri.nodeId)) inputs.push({ ...ri, order: inputs.length + 1 }); });
  // 元素（@名字）：参考图按模型剩余的参考名额加进来
  inputs.push(...elementInputs(g.prompt, node.kind, m, eff, inputs));
  // @本节点：提示词里 @ 到自己、且这一版有可用的自我参考源时，把那张图加在末尾（self 没有连线，直接 push）。
  // 源图取值见 selfSourceOf：这一版 meta.selfSrc 优先（null = 生成这一版时就没发，重新生成也不补上一版结果），
  // 旧数据没有记录才走原来的回退。实际发出去的是哪张（没有就是 null）随请求带给写回，写回时原样记到新版本上——
  // 不再事后从节点当前结果推算，否则「第一版是生成图」的节点会在第二轮把自己的结果记成源图、从此永远喂回上一版。
  // 标了 excludeSelfRefs：仍然发送「更早的源图」（meta.selfSrc 记录的那张 / 上传原图），
  // 只剔除节点当前这一版结果、由它生成的结果节点、分组展开出的自己（输入层已经剔过）。
  const selfMentionedRaw = (node.kind === "image" || node.kind === "video") && mentionedIds(g.prompt).has(node.id);
  let selfSrc: string | null = null;
  if (selfMentionedRaw) {
    const src = selfSourceOf(node);
    if (typeof src === "string" && src) {
      const cur = outOf(node);
      const curUrl = cur ? (cur.url || (node.kind === "video" ? cur.frame : undefined)) : undefined;
      // selfSourceOf 返回的就是当前这一版结果本身（没有更早的源图）时才不发；有更早的源图照发并记录
      const usable = !excludeSelf || src !== curUrl;
      if (usable) {
        const role = selfInputRole(node.kind, eff, m, inputs.filter((x) => x.kind === "image").length);
        if (role) { inputs.push({ nodeId: node.id, title: genOf(node).title, kind: node.kind as GenKind, order: inputs.length + 1, role, url: src }); selfSrc = src; }
      }
    }
  }
  const vm = node.kind === "video" ? (eff as VideoParams).mode : undefined;
  // 草稿模式：按模型最低清晰度出片（请求预览里看到的就是实际发出的清晰度）
  const params = node.kind === "video" && (eff as VideoParams).draft ? { ...(eff as VideoParams), res: draftRes(eff as VideoParams, m) } : eff;
  // 表格行：按**最终真的发送的 inputs 顺序**（含生成节点自身连的图 / 元素图）编号，
  // 不能从行素材第 1 张开始数，否则模型按「图 N」会拿错图。
  const rowRefOrder = row ? refOrderText(inputs) : "";
  // 普通图片生图：后端按 inputs 里「kind=image 且带 url」的顺序发 reference_images，
  // 光说「图 N」模型不知道第 N 张是哪张，所以把清单放到提示词最前面；表格行已经在上面加过，别叠两遍。
  const refOrder = !row && node.kind === "image" ? refOrderText(inputs.filter((x) => x.kind === "image" && x.url)) : "";
  const extra = [row?.text || "", rowRefOrder].filter((s) => s.trim()).join("\n\n");
  const resolved = resolvePrompt(doc, node, extra, inputs.filter((x) => x.kind !== "text").map((x) => ({ nodeId: x.nodeId, kind: x.kind, role: x.role })));
  return { canvasId: store.state.canvasId, nodeId: node.id, kind: node.kind, model: m, prompt: g.prompt, resolvedPrompt: [refOrder, resolved].filter((s) => s.trim()).join("\n\n"), params, inputs, selfSrc, ...(vm ? { videoMode: { name: vm, api: VMODES[vm].api } } : {}) };
}

/**
 * @本节点时这条结果用什么角色发送：图片要模型支持图生图、且还有参考图名额 → reference；
 * 视频看生成方式（参考视频生视频 → reference_video，视频编辑 / 视频延长 → source_video）。
 * 模型不接受时返回 null：不发送、不伪造，面板仍按「没被引用」显示标题。
 */
export function selfInputRole(kind: GenKind, eff: unknown, m: ModelSpec, imageCount: number): GenInput["role"] | null {
  if (kind === "image") return m.i2i && imageCount < (m.maxRefs ?? 0) ? "reference" : null;
  if (kind === "video") {
    const mode = (eff as VideoParams).mode;
    if (mode === "参考视频生视频") return "reference_video";
    if (mode === "视频编辑" || mode === "视频延长") return "source_video";
  }
  return null;
}

/** 表格批量生成出来的「行节点」上冻结的请求快照（data.frozen）：记录这一行绑定了哪些输入 */
const frozenOf = (node: CanvasNode) => (node.data as { frozen?: GenRequest } | undefined)?.frozen;

/**
 * 节点这次真正要发的请求（请求预览也用它，看到的就是发给后端的）。
 * 行节点带 frozen 时只沿用它的**输入快照**（这一行的表格素材行），提示词 / 参数 / 模型一律取节点当前值——
 * 否则用户改了提示词再点生成，发出去的还是上一次的旧请求。
 */
export function requestForNode(store: CanvasStore, node: CanvasNode, row?: BatchRow, flags?: { excludeSelfRefs?: boolean }): GenRequest | null {
  const frozen = frozenOf(node);
  if (!frozen) return buildRequest(store, node, row, flags);
  const g = genOf(node); const m = store.modelOf(node); if (!m) return null;
  const sent: SentRef[] = frozen.inputs.filter((x) => x.kind !== "text").map((x) => ({ nodeId: x.nodeId, kind: x.kind, role: x.role }));
  const mm = resolveMentions(g.prompt, store.state.doc, sent);
  const ctx = frozen.inputs.filter((x) => x.kind === "text" && (x.text || "").trim() && !mm.usedText.has(x.nodeId)).map((x) => x.text!.trim());
  const rowText = String((node.data as { rowText?: string } | undefined)?.rowText || "").trim();
  const vm = node.kind === "video" ? (g.params as VideoParams).mode : undefined;
  const params = node.kind === "video" && (g.params as VideoParams).draft ? { ...(g.params as VideoParams), res: draftRes(g.params as VideoParams, m) } : g.params;
  // 表格行节点：frozen 里记着这一行发送的输入，重新生成时清单照样附上
  const refOrder = (node.data as { tableRow?: unknown } | undefined)?.tableRow != null ? refOrderText(frozen.inputs) : "";
  return { ...frozen, nodeId: node.id, model: m, prompt: g.prompt, params, resolvedPrompt: [...ctx, applyElements(mm.text), rowText, refOrder].filter((s) => s.trim()).join("\n"), ...(vm ? { videoMode: { name: vm, api: VMODES[vm].api } } : {}) };
}

/** 历史记录里留的结果（不带版本元数据） */
const runOut = (o?: GenOutput | null) => (o ? { url: o.url, frame: o.frame, text: o.text, w: o.w, h: o.h, dur: o.dur } : undefined);

/* ---------- 放置 ---------- */
/** 在 n 正下方找一块不和别的节点重叠的位置 */
export function freeSpotBelow(doc: CanvasDoc, n: CanvasNode, w = n.w, h = n.h) {
  const x = n.x; let y = n.y + 24 + n.h + 56;
  const hit = (yy: number) => doc.nodes.some((o) => o !== n && o.x < x + w + 20 && o.x + o.w + 20 > x && o.y < yy + h + 44 && o.y + o.h + 44 > yy);
  for (let i = 0; i < 20 && hit(y); i++) y += 60;
  return { x, y };
}
/**
 * n 右侧 120px 起找空位（顶边对齐）；被占就推到这一批占位节点里最靠右的右边，最多推 12 次，
 * 整排都占着再掉回自由下方——重复点生成时按「一排接一排」铺开，不往正下方叠。
 */
export function freeSpotRight(doc: CanvasDoc, n: CanvasNode, w = n.w, h = n.h) {
  let x = n.x + n.w + 120; const y = n.y;
  const blockers = (xx: number) => doc.nodes.filter((o) => o !== n && o.x < xx + w + 20 && o.x + o.w + 20 > xx && o.y < y + h + 20 && o.y + o.h + 20 > y);
  for (let i = 0; i < 12; i++) {
    const blocked = blockers(x);
    if (!blocked.length) return { x, y };
    x = Math.max(...blocked.map((o) => o.x + o.w + 120));
  }
  return freeSpotBelow(doc, n, w, h);
}
/** 源节点右侧 120px；已有下游时往下避让（DX OS l6） */
export function spotRightOf(doc: CanvasDoc, src: CanvasNode, h: number) {
  const outs = outputsOf(doc, src.id);
  const y = Math.max(src.y + src.h / 2 - h / 2, ...outs.map((o) => o.y + o.h + 24 + 42));
  return { x: src.x + src.w + 120, y };
}

/* ---------- 单节点 ---------- */
export type RunOpts = {
  chain?: boolean;
  inPlace?: boolean;
  /** 这次生成剔除节点自己的产物（后端 agentRun.excludeSelfRefs / agentPendingExcludeSelfRefs 标记；手动重跑不传 = 保持原有行为） */
  excludeSelfRefs?: boolean;
};

export async function runNode(store: CanvasStore, id: string, opts: RunOpts = {}): Promise<boolean> {
  let node = store.node(id); if (!node || !isGenKind(node.kind)) return false;
  if (store.state.runtime[id]) return false;
  const doc = store.state.doc;
  if (!store.backend.available()) { store.toast("未连接桌面后端，无法生成"); return false; }
  const m = store.modelOf(node);
  if (!m) { store.toast(`还没有可用的${node.kind === "text" ? "文本" : node.kind === "image" ? "图片" : node.kind === "video" ? "视频" : "音频"}模型，请在设置 › 模型里添加`); return false; }
  const g = genOf(node);
  /** 后端标记（agentRun.excludeSelfRefs / agentPendingExcludeSelfRefs）：这次生成不拿自己的产物当参考图 */
  const excludeSelfRefs = opts.excludeSelfRefs === true || excludeSelfRefsFlag(node.data);
  // 文本节点出表
  if (node.kind === "text" && ((g.params as TextParams).output === "table" || (g.params as TextParams).output === "storyboard")) return runTextToTable(store, id);
  // 上游有表格 → 逐行批量
  if (inputsOf(doc, id).some((x) => x.node.kind === "table") && !opts.inPlace) return runTableBatch(store, id);
  // 节点上还记着一个没写完的后端任务（离开画布后回来点生成）：先接上它，别重复建任务再扣一次费
  if (genOf(node).taskId && await adoptPendingTask(store, node)) return false;
  const frozen = frozenOf(node);
  const allIns = inputsOf(doc, id);
  const skipIns = unmentionedInputs(node, allIns);
  const expandedIns = expandGroupInputs(doc, allIns.filter((x) => x.node.kind !== "table" && !skipIns.has(x.edge.id)));
  const expandedSkip = unmentionedInputs(node, expandedIns, allIns);
  const ins = expandedIns.filter((x) => !expandedSkip.has(x.edge.id));
  const notReady = frozen ? [] : ins.filter((x) => isGenKind(x.node.kind) && !outOf(x.node) && !store.state.runtime[x.node.id]);
  if (notReady.length && !opts.chain) { store.toast(`上游「${genOf(notReady[0].node).title}」还没有结果。右键选「运行到此（含上游）」可以一起跑`); return false; }
  if (!frozen && !g.prompt.trim() && !ins.length && !(node.kind === "text" && g.manual)) {
    // 连了输入却一个都不发（提示词里只 @ 了别人 / 全被引用模式挡掉）：说清楚是「没引用」，别说成没连
    store.toast(allIns.length
      ? `已连接的 ${allIns.length} 个输入都没在提示词里 @ 引用，这次不会发送。点面板里的「全部引用」，或把提示词里的 @ 删掉`
      : "先写一句提示词，或者连一个上游节点");
    return false;
  }
  // 已有结果：默认先找「由它生成的结果节点」（data.sourceNodeId），有就在它上面覆盖生成；
  // 还没有就新建一个结果节点（原名 · N）。节点自己就是结果节点时原地覆盖，避免无限往下套娃。
  // 换比例后不覆盖旧比例的结果节点：按 data.sourceNodeId + 同比例找，找不到就新建一个本次比例的节点。
  // chain / inPlace / autorun（Agent）保持原地追加版本，不新建。
  if (outOf(node) && !opts.chain && !opts.inPlace && !(node.kind === "text" && g.manual)) {
    const sourceId = (node.data as { sourceNodeId?: unknown } | undefined)?.sourceNodeId;
    if (typeof sourceId !== "string" || !sourceId) {
      const srcId = node.id;
      const want = ratioOf((g.params as { ratio?: string }).ratio);
      // 源→结果的那条边被删掉后就不再认这个结果节点（文本节点没有这条边，维持原逻辑）
      const needEdge = node.kind !== "text";
      const links = store.state.doc.edges;
      const results = store.state.doc.nodes.filter((n) => {
        if ((n.data as { sourceNodeId?: unknown } | undefined)?.sourceNodeId !== srcId) return false;
        return !needEdge || links.some((e) => e.from === srcId && e.to === n.id);
      });
      const result = want == null ? results[0] : results.find((n) => {
        const r = ratioOf((genOf(n).params as { ratio?: string }).ratio) ?? (n.w / Math.max(1, n.h));
        return Math.abs(r - want) <= Math.max(r, want) * 0.02;
      });
      if (result) {
        if (store.state.runtime[result.id]) return false;
        // 结果节点是「点生成的那个节点」派生的，提示词是复制过去的：它自己没有引用模式标记时沿用源节点的，
        // 否则面板提示「没 @ 的不发送」，实际请求在结果节点上又把所有输入都发了。
        if (genOf(node).refMode && !genOf(result).refMode) store.patchGen(result.id, { refMode: genOf(node).refMode });
        node = store.node(result.id)!; id = result.id;
      } else {
        // 用户把节点拖大后再生成：新结果节点沿用当前宽度，只按比例改高（不缩回 360×640 的默认盒）
        const box = want ? refitNodeBox(node, want, 1) : null;
        node = regenAsNew(store, node, box ? { w: box.w, h: box.h } : undefined); id = node.id;
      }
    }
  }
  const req = requestForNode(store, node, undefined, { excludeSelfRefs });
  if (!req) return false;
  return execute(store, node, req);
}

/** 执行一次请求并写回（单节点 / 批量行共用） */
async function execute(store: CanvasStore, node: CanvasNode, req: GenRequest, label?: string): Promise<boolean> {
  const id = node.id; const abort = new AbortController(); const t0 = performance.now();
  // 表格批量行由 journal 续跑，不把 taskId 记到行节点上（否则回来接结果和 journal 会各写一遍）
  const batchRow = !!(node.data as { batchOf?: unknown } | undefined)?.batchOf;
  store.patchGen(id, { err: undefined, errCode: undefined });
  // 生成中的占位（加载动效）先按面板选的比例摆好，不要等结果回来才变形；没选比例 / 拿不到原图尺寸的保持原样
  // 原图比例（自适应）也要能摆正：按 params.sourceSize 的显式 WxH，或直接按源图真实像素
  // 用共享的最大盒等比缩放：9:16 这种高比例不会被单边夹扁
  const want = wantedRatio(store.state.doc, node, node.kind as GenKind, req.params);
  // 占位也按节点当前尺寸摆正：用户拖大的节点不能在点生成的一瞬间被缩回默认最大盒
  const wantBox = want && (node.kind === "image" || node.kind === "video") ? refitNodeBox(node, want, 1) : null;
  if (wantBox) store.updateNode(id, (n) => ({ ...n, w: wantBox.w, h: wantBox.h }));
  store.setRun(id, { status: "running", progress: .02, abort, startedAt: Date.now() });
  try {
    const res = await store.backend.generate(req, (e) => {
      if (e.type === "progress") store.patchRun(id, { progress: clamp(e.progress, .02, 1) });
      else if (e.type === "started") {
        store.patchRun(id, { runId: e.runId });
        // 任务 id 落进文档：离开画布 / 切到别的画布后回来靠它接上（完成 / 失败后清掉）
        if (e.runId && !batchRow) store.patchGen(id, { taskId: e.runId });
      } else if (e.type === "text") store.patchRun(id, { stream: e.text });
    }, abort.signal);
    // 生成期间节点被删除 / 撤销掉：结果无处可写，按「已停止」记录，不当成报错
    if (!store.node(id)) throw new GenError("STOPPED", "节点已被删除或撤销，生成结果未写回");
    const isDraft = req.kind === "video" && !!(req.params as VideoParams).draft;
    const measured = await applyRunResult(store, id, req.kind, res.outputs, { draft: isDraft, selfSrc: req.selfSrc });
    store.patchGen(id, { taskId: undefined });
    store.setRun(id, null);
    const cur = store.node(id)!;
    store.logRun({ node: id, title: label || genOf(cur).title, type: cur.kind as GenKind, model: req.model.name, status: "done", secs: Math.round((performance.now() - t0) / 1000), thumb: outOf(cur)?.url && cur.kind === "image" ? outOf(cur)!.url : outOf(cur)?.frame, out: runOut(outOf(cur)), prompt: plainPrompt(req.prompt, store.state.doc) });
    return true;
  } catch (err) {
    store.setRun(id, null);
    const stopped = err instanceof GenError && err.code === "STOPPED";
    // 主行只写人话；原始码留给 gen.errCode（弹层里以「代码：…」展示，便于排查）
    const { err: msg, errCode } = nodeError(err);
    // 只有任务真的结束（失败 / 用户停止）才清 taskId；网络抖动 / 超时留着，下次进画布还能接上
    if (store.node(id)) {
      const patch: { err?: string; errCode?: string; taskId?: string } = {};
      if (!stopped) { patch.err = msg; patch.errCode = errCode; }
      if (stopped || errCode === "FAILED") patch.taskId = undefined;
      if (Object.keys(patch).length) store.patchGen(id, patch);
    }
    store.logRun({ node: id, title: label || genOf(node).title, type: node.kind as GenKind, model: req.model.name, status: stopped ? "stopped" : "error", secs: Math.round((performance.now() - t0) / 1000), error: errCode ? errCode + " " + msg : msg });
    return false;
  }
}

/** 结果的写回（首次生成 / 回到画布续跑共用）：落资源库 → 量真实尺寸 → 追加版本 */
async function applyRunResult(store: CanvasStore, id: string, kind: GenKind, outputs: GenOutput[], opts: { draft?: boolean; /** 这次请求实际发出去的自我参考图（字符串 / 明确没有 = null）；缺失 = 旧请求快照，不写记录 */ selfSrc?: string | null } = {}): Promise<GenOutput[]> {
  if (!store.node(id)) throw new GenError("STOPPED", "节点已被删除或撤销，生成结果未写回");
  const before = store.node(id)!;
  // 新版本记下这次请求实际发出去的「@ 本节点」源图（null = 没发），下次重新生成优先读它，
  // 不拿这一版的结果再喂回去。旧请求快照没有这个字段时不写，读取时按旧数据回退。
  const selfSrc = kind === "image" || kind === "video" ? opts.selfSrc : undefined;
  const outs = (await persistOutputs(store, outputs, genOf(before).title)).map((o) => (opts.draft ? { ...o, draft: true } : o))
    .map((o) => (selfSrc !== undefined ? { ...o, meta: { ...o.meta, selfSrc } } : o));
  if (!store.node(id)) throw new GenError("STOPPED", "节点已被删除或撤销，生成结果未写回");
  // 后端没返回像素宽高时用真实文件兜底（失败 / 超时都只是原样返回，不阻塞写回）
  const measured = await Promise.all(outs.map((o) => measureOutput(store, kind, o)));
  applyOutputs(store, id, measured);
  // 后端提示尺寸被收敛（如 GIF 每帧尺寸按拼版上限缩小）：写回成功后 toast 一次，别让用户以为「选了 2K 却拿到小图」
  const sizeNotice = measured.map((o) => String(o.meta?.notice || "").trim()).find(Boolean) || "";
  if (sizeNotice) store.toast(sizeNotice, 6000);
  return measured;
}

/** data URL 存进资源库，文档里只留引用（真后端）；模拟后端原样返回 */
async function persistOutputs(store: CanvasStore, outs: GenOutput[], name: string): Promise<GenOutput[]> {
  const be = store.backend; const cid = store.state.canvasId;
  // data URL 存进资源库；服务商返回的 https 结果由主进程下载进资源库（外链会过期，画布页也不直接显示外链）
  const keep = async (u: string | undefined, label: string) => !u ? u : u.startsWith("data:") ? (label.endsWith("封面") && be.kind !== "bridge" ? u : be.importAsset(cid, u, label)) : /^https?:\/\//i.test(u) && be.importRemote ? be.importRemote(cid, u, label) : u;
  return Promise.all(outs.map(async (o) => ({ ...o, url: await keep(o.url, name), frame: await keep(o.frame, name + " 封面") })));
}

/** 解码图片真实像素；加载失败 / 超时返回 null（不能卡住生成写回） */
const SIZE_WAIT_MS = 4000;
function decodeImageSize(url: string): Promise<{ w: number; h: number } | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { w: number; h: number } | null) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(null), SIZE_WAIT_MS);
    const img = new Image();
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => finish(null);
    try { img.src = url; } catch { finish(null); }
  });
}
/** 视频没有封面图时，用视频元数据取真实画面尺寸 */
function decodeVideoSize(url: string): Promise<{ w: number; h: number } | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false; const video = document.createElement("video");
    const finish = (v: { w: number; h: number } | null) => {
      if (done) return; done = true; clearTimeout(timer);
      try { video.removeAttribute("src"); video.load(); } catch { /* 释放解码 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), SIZE_WAIT_MS);
    video.preload = "metadata"; video.muted = true; video.playsInline = true;
    video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0 ? { w: video.videoWidth, h: video.videoHeight } : null);
    video.onerror = () => finish(null);
    try { video.src = url; } catch { finish(null); }
  });
}
/** 资源库引用换成能直接加载的地址（普通地址原样返回；解析失败 / 超时返回空串） */
async function decodableUrl(store: CanvasStore, url: string): Promise<string> {
  if (!url) return "";
  if (!/^(novai-asset:|openarc-asset:|openarc-resource:|resource:)/.test(url)) return url;
  try {
    const resolved = await Promise.race([
      store.backend.resolveAsset?.(url) || Promise.resolve(""),
      new Promise<string>((r) => setTimeout(() => r(""), SIZE_WAIT_MS)),
    ]);
    return resolved || "";
  } catch { return ""; }
}
/** 结果缺 w/h 时用图片 / 视频封面的真实像素兜底；拿不到就原样返回（调用方再用所选比例兜底） */
async function measureOutput(store: CanvasStore, kind: GenKind, o: GenOutput): Promise<GenOutput> {
  if (kind !== "image" && kind !== "video") return o;
  if (o.w && o.h && o.w > 0 && o.h > 0) return o;
  const cover = kind === "video" ? o.frame : o.url;
  if (cover) {
    const size = await decodeImageSize(await decodableUrl(store, cover));
    if (size) return { ...o, w: size.w, h: size.h };
  }
  if (kind === "video") {
    const size = await decodeVideoSize(await decodableUrl(store, o.url || ""));
    if (size) return { ...o, w: size.w, h: size.h };
  }
  return o;
}

function applyOutputs(store: CanvasStore, id: string, outs: GenOutput[]) {
  const node = store.node(id)!; const g = genOf(node);
  // 优先真实像素；解码失败时用面板选的比例兜底（自适应不兜底，保持原尺寸）。宽高一起缩放，比例不变。
  const fit = (n: CanvasNode, o: GenOutput): CanvasNode => {
    if (n.kind !== "image" && n.kind !== "video") return n;
    const box = o.w && o.h ? refitNodeBox(n, o.w, o.h) : null;
    const fallback = box ? null : ratioOf((genOf(n).params as { ratio?: string }).ratio);
    const sized = box || (fallback ? refitNodeBox(n, fallback, 1) : null);
    return sized ? { ...n, w: sized.w, h: sized.h } : n;
  };
  if (outs.length > 1 && store.state.ui.batchMode === "spread" && node.kind === "image") {
    store.mutate((d) => {
      const extra = outs.slice(1).map((o, i) => fit(withGen({ ...node, id: uid("n"), x: node.x + (i + 1) * (node.w + 30) }, { ...g, params: cloneParams(g.params), title: g.title + " · " + (i + 2), hist: [o], hi: 0, order: [] }), o));
      const edges = inputsOf(d, id).flatMap((x) => extra.map((c) => ({ id: uid("e"), from: x.node.id, to: c.id })));
      const withOrder = extra.map((c) => withGen(c, { order: edges.filter((e) => e.to === c.id).map((e) => e.id) }));
      return { ...d, nodes: [...d.nodes.map((n) => (n.id === id ? fit(withGen(n, { hist: [...g.hist, outs[0]], hi: g.hist.length }), outs[0]) : n)), ...withOrder], edges: [...d.edges, ...edges] };
    });
    return;
  }
  const hist = [...g.hist, ...outs];
  store.updateNode(id, (n) => fit(withGen(n, { hist, hi: hist.length - 1, ...(n.kind === "text" ? { manual: false } : {}) }), outs[outs.length - 1]));
}

/**
 * 视频节点按当前输入重选生成方式——和 actions.afterInputsChanged 是同一条规则（都用纯函数 autoVideoMode），
 * 这里不 import actions：engine 只依赖纯模块，引 UI 层会把 engine 从 node 测试里踢出去。
 */
function syncVideoMode(store: CanvasStore, id: string) {
  const n = store.node(id); const m = n ? store.modelOf(n) : null; if (!n || !m || n.kind !== "video") return;
  const mode = autoVideoMode(store.state.doc, id, m);
  if (mode && mode !== (genOf(n).params as VideoParams).mode) store.patchGen(id, (g) => ({ params: { ...(g.params as VideoParams), mode } }));
}

/** 已有结果的节点再生成：右侧新建「原名 · N」，复制提示词、参数和全部输入连线 */
export function regenAsNew(store: CanvasStore, n: CanvasNode, size?: { w: number; h: number }): CanvasNode {
  const doc = store.state.doc; const g = genOf(n);
  const { x, y } = freeSpotRight(doc, n);
  const base = g.title.replace(/ · \d+$/, "");
  const sibs = doc.nodes.filter((o) => { const t = isGenKind(o.kind) ? genOf(o).title : ""; return t === base || t.startsWith(base + " · "); }).length;
  const frozen = (n.data as { frozen?: unknown } | undefined)?.frozen; const rowText = (n.data as { rowText?: string } | undefined)?.rowText;
  // sourceNodeId 记着「点生成的那个节点」：全屏查看的「对比原图」靠它找到生成前的那张图
  // 提示词复制过去，引用模式（refMode）也要一起复制：否则新节点不认 @ 过滤，已连接但没 @ 的图也会发出去
  const c = withGen({ id: uid("n"), kind: n.kind, x, y, w: size?.w ?? n.w, h: size?.h ?? n.h, text: "", data: { ...(frozen ? { frozen, ...(rowText ? { rowText } : {}) } : {}), sourceNodeId: n.id } }, { title: `${base} · ${sibs + 1}`, prompt: g.prompt, params: JSON.parse(JSON.stringify(g.params)), hist: [], hi: 0, order: [], ...(g.refMode ? { refMode: g.refMode } : {}) });
  const edges = inputsOf(doc, n.id).map((x) => ({ id: uid("e"), from: x.node.id, to: c.id }));
  // 被点的这个图片 / 视频 / 音频节点自己也是新节点的输入（媒体当参考 / 来源）。三种情况不连：
  // 文本节点（文本本身是提示词，连过去只会变成上下文）、没有结果的节点（留下一条取不到东西的空边）、
  // 表格批量行节点（请求由冻结的行输入决定，这条媒体边不会进请求，连上只会显示成一条不生效的输入）。
  const selfEdge = n.kind !== "text" && isGenKind(n.kind) && !frozen && outOf(n) ? { id: uid("e"), from: n.id, to: c.id } : null;
  store.addNodes([c], selfEdge ? [...edges, selfEdge] : edges, { select: true });
  syncVideoMode(store, c.id);
  // 视频从视频结果再生成：autoVideoMode 优先「视频延长」，大多数模型没有这一档、会退回「文生视频」，
  // 等于把来源视频整个丢掉。这里显式选「参考视频生视频」（提示词照旧驱动，来源视频当参考），
  // 模型没有就依次退到「视频编辑」「视频延长」。
  if (selfEdge && c.kind === "video") {
    const m = store.modelOf(c); const modes = m?.modes || [];
    const mode = (["参考视频生视频", "视频编辑", "视频延长"] as VideoMode[]).find((x) => modes.includes(x));
    if (mode && (genOf(store.node(c.id)!).params as VideoParams).mode !== mode) store.patchGen(c.id, (gg) => ({ params: { ...(gg.params as VideoParams), mode } }));
  }
  store.toast(selfEdge ? `已在右边新建「${genOf(c).title}」重新生成，并把「${g.title}」连成它的输入，原结果保留` : `已在右边新建「${genOf(c).title}」重新生成，原结果保留`);
  return store.node(c.id)!;
}

export function stopNode(store: CanvasStore, id: string) {
  if (!store.state.runtime[id]) return;
  // 用户明确停止 = 任务不要了：后端任务一起取消（离开画布 / 切画布不走这里，任务留着回来续跑）
  store.stopRun(id);
  store.patchGen(id, { taskId: undefined });
  store.toast("已停止生成");
}

/* ---------- 离开画布后回来续跑 ---------- */
/**
 * 回到画布后接上没写完的任务（store.load 完成后调）：还在跑就继续轮询，已经跑完就直接写回。
 * 有 taskId 的按 taskId 找；没记上 taskId 的（保存还没来得及落盘就离开了）按 node_id + 节点还没结果认领（任务可能在离开期间跑完）。
 * 全程不新建任务、不重发生成请求，所以不会重复扣费；已在文档里的结果不再写一遍。
 */
export async function resumeCanvasTasks(store: CanvasStore): Promise<void> {
  const backend = store.backend;
  if (!store.state.loaded || !backend.listCanvasTasks || !backend.resumeTask) return;
  const tasks = await backend.listCanvasTasks(store.state.canvasId).catch(() => [] as CanvasTask[]);
  if (!tasks.length) return;
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  for (const node of [...store.state.doc.nodes]) {
    if (!isGenKind(node.kind) || store.state.runtime[node.id]) continue;
    const taskId = genOf(node).taskId;
    // 没记 taskId 时按 node_id 认领：节点还没有结果、任务不是失败态（成功也要认，结果可能是在离开期间跑完的）
    const task = taskId ? byId.get(taskId) : tasks.find((t) => t.nodeId === node.id && t.status !== "failed" && !outOf(node));
    if (!task) { if (taskId) store.patchGen(node.id, { taskId: undefined }); continue; }
    // 任务已经写过一次（taskId 没清干净）：只清记录，不再追加一遍结果
    if (genOf(node).hist.some((out) => out.meta?.runId === task.taskId)) { if (taskId) store.patchGen(node.id, { taskId: undefined }); continue; }
    void resumeRun(store, node, task);
  }
}

/** 再点生成时节点上还记着没写完的任务：在跑就接上并返回 true（别再建一个重复任务） */
async function adoptPendingTask(store: CanvasStore, node: CanvasNode): Promise<boolean> {
  const taskId = genOf(node).taskId; if (!taskId) return false;
  const tasks = await store.backend.listCanvasTasks?.(store.state.canvasId).catch(() => undefined);
  if (!tasks) return false;                                   // 老后端查不到任务：照旧新建
  const fresh = store.node(node.id); if (!fresh || genOf(fresh).taskId !== taskId) return false;
  const task = tasks.find((t) => t.taskId === taskId);
  // 任务记录没了（服务重装 / 清过任务库）：清掉记录，按新任务走
  if (!task || task.status === "failed") { store.patchGen(node.id, { taskId: undefined }); return false; }
  if (task.status !== "succeeded") store.toast("这张还在生成中，等它出结果");
  void resumeRun(store, fresh, task);
  return true;
}

/**
 * 接上一个后端任务：还在跑就继续等（进度照旧），已经跑完 / 失败的直接按结果收尾。
 * 写回走 applyRunResult，和首次生成同一条路径。
 */
async function resumeRun(store: CanvasStore, node: CanvasNode, task: CanvasTask): Promise<boolean> {
  const backend = store.backend;
  if (!backend.resumeTask) return false;
  const id = node.id; const kind = node.kind as GenKind;
  const abort = new AbortController(); const t0 = performance.now();
  store.patchGen(id, { err: undefined, errCode: undefined });
  store.setRun(id, { status: "running", progress: .02, abort, startedAt: Date.now(), runId: task.taskId });
  try {
    const outputs = await backend.resumeTask(task, (e) => {
      if (e.type === "progress") store.patchRun(id, { progress: clamp(e.progress, .02, .99) });
    }, abort.signal);
    const cur = store.node(id); if (!cur) throw new GenError("STOPPED", "节点已被删除或撤销，生成结果未写回");
    const draft = cur.kind === "video" && !!(genOf(cur).params as VideoParams).draft;
    // 续跑拿不到当初的请求对象：按同一条组装路径以节点当前状态重建（任务发起后结果还没写回，口径一致），
    // 让新版本记录当初实际发出去的自我参考图，而不是等写回时从结果反推。
    const selfSrc = requestForNode(store, cur)?.selfSrc;
    await applyRunResult(store, id, kind, outputs, { draft, selfSrc });
    store.patchGen(id, { taskId: undefined });
    store.setRun(id, null);
    const done = store.node(id)!;
    store.logRun({ node: id, title: genOf(done).title, type: kind, model: store.modelOf(done)?.name || task.model || "", status: "done", secs: Math.round((performance.now() - t0) / 1000), thumb: outOf(done)?.url && kind === "image" ? outOf(done)!.url : outOf(done)?.frame, out: runOut(outOf(done)), prompt: plainPrompt(genOf(done).prompt, store.state.doc) });
    store.toast(`「${genOf(done).title}」已经生成好了`);
    return true;
  } catch (err) {
    store.setRun(id, null);
    const stopped = err instanceof GenError && err.code === "STOPPED";
    const { err: msg, errCode } = nodeError(err);
    // 任务真的结束了（失败 / 取消 / 已完成但结果没法写回）才清 taskId；网络抖动留着，下次进画布还能接上
    if (store.node(id) && !stopped) {
      const patch: { err?: string; errCode?: string; taskId?: string } = { err: msg, errCode };
      if (errCode === "FAILED" || task.status === "succeeded") patch.taskId = undefined;
      store.patchGen(id, patch);
    }
    store.logRun({ node: id, title: genOf(node).title, type: kind, model: task.model || "", status: stopped ? "stopped" : "error", secs: Math.round((performance.now() - t0) / 1000), error: errCode ? errCode + " " + msg : msg });
    return false;
  }
}

export async function runChain(store: CanvasStore, id: string, dir: "up" | "down") {
  const doc = store.state.doc; const order: string[] = []; const seen = new Set<string>();
  const up = (x: string) => { if (seen.has(x)) return; seen.add(x); expandGroupInputs(doc, inputsOf(doc, x)).forEach((i) => up(i.node.id)); order.push(x); };
  const down = (x: string) => { const q = [x]; const vis = new Set<string>(); while (q.length) { const c = q.shift()!; if (vis.has(c)) continue; vis.add(c); order.push(c); outputsOf(doc, c).forEach((o) => q.push(o.id)); } };
  dir === "up" ? up(id) : down(id);
  const todo = order.filter((x) => { const n = store.node(x)!; if (!isGenKind(n.kind)) return false; const g = genOf(n); if (dir === "up" && outOf(n) && x !== id) return false; if (g.manual || g.uploaded) return false; return g.prompt.trim() || inputsOf(doc, x).length; });
  if (!todo.length) { store.toast("没有需要运行的节点"); return; }
  store.toast(`按依赖顺序运行 ${todo.length} 个节点`);
  for (const x of todo) { const ok = await runNode(store, x, { chain: true }); if (!ok && store.node(x) && genOf(store.node(x)!).err) break; }
}

/* ---------- 文本 → 多维表格 ---------- */
export async function runTextToTable(store: CanvasStore, id: string): Promise<boolean> {
  const node = store.node(id)!; const g = genOf(node); const m = store.modelOf(node)!;
  const mode = (g.params as TextParams).output === "storyboard" ? "storyboard" : "table";
  const ins = inputsOf(store.state.doc, id);
  // 每个素材来源（分组 / 堆叠 / 单个素材节点）＝ 一条输入通道；通道数与素材数决定表格宽度和提示词
  const sources = tableChannels(store.state.doc, id);
  const media = sources.reduce((n, ch) => n + ch.items.length, 0);
  const ctx = ins.filter((x) => x.node.kind === "text").map((x) => `【${genOf(x.node).title}】\n${textOf(x.node)}`).join("\n\n");
  const intent = mode === "storyboard" ? "video" : tableGenKindOf(g.prompt.trim() || ctx);
  // 分组的输入通道编号（= 提示词 / 表格列里的「输入 N」），让模型在每行里写对组号
  const groupChannel = new Map(sources.map((ch, i) => [ch.sourceId, i + 1]));
  const groups = groupInputs(store.state.doc, id, intent).map((gr) => ({ ...gr, channel: groupChannel.get(gr.groupId) }));
  const base0 = buildRequest(store, node); if (!base0) return false;
  const seeImages = !!m.vision && groups.some((x) => x.images.length);
  const groupRefs = seeImages ? groups.flatMap((gr) => gr.images.map((im, k) => ({ nodeId: im.nodeId, title: `${gr.name} 第 ${k + 1} 张`, kind: "image" as const, role: "reference" as const, url: im.url }))).slice(0, 24) : [];
  const base = { ...base0, inputs: [...base0.inputs, ...groupRefs.filter((r) => !base0.inputs.some((i) => i.nodeId === r.nodeId)).map((r, k) => ({ ...r, order: base0.inputs.length + k + 1 }))] };
  if (!g.prompt.trim() && !ins.length) { store.toast("LLM 表格工作流需要拆分任务的文字要求。"); return false; }
  // 文本节点的提示词里 @ 到图片 / 分组时，不能把 @{节点id} 原样发给模型：
  // 用这次真正附上的图片顺序展开成「图N」；分组展开成成员图号（没有成员图时回落组名）。
  // 只做提示词展开，不改输入通道（通道仍然只看连线，@ 不会新增输入列）。
  const sentRefs = base.inputs.filter((x) => x.kind === "image").map((x) => ({ nodeId: x.nodeId, kind: "image" as const }));
  const opened = resolveMentions(g.prompt, store.state.doc, sentRefs);
  const taskPrompt = opened.text;
  // @ 到的文本节点正文已经内联进提示词，就不再作为上下文重复附一遍
  const ctxForModel = ins.filter((x) => x.node.kind === "text" && !opened.usedText.has(x.node.id)).map((x) => `【${genOf(x.node).title}】\n${textOf(x.node)}`).join("\n\n");
  const task = [ctxForModel, taskPrompt, groupNote(groups, seeImages, intent)].filter(Boolean).join("\n\n");
  const taskWithoutImages = [ctxForModel, taskPrompt, groupNote(groups, false, intent)].filter(Boolean).join("\n\n");
  const abort = new AbortController(); const t0 = performance.now();
  store.patchGen(id, { err: undefined, errCode: undefined });
  store.setRun(id, { status: "running", progress: .02, abort, startedAt: Date.now() });
  let requestBase = base;
  const send = async (prompt: string) => (await store.backend.generate({ ...requestBase, resolvedPrompt: prompt, inputs: requestBase.inputs.filter((x) => x.kind !== "text") }, (e) => { if (e.type === "progress") store.patchRun(id, { progress: clamp(e.progress, .02, .98) }); if (e.type === "text") store.patchRun(id, { stream: "正在整理表格…\n" + e.text.slice(-400) }); }, abort.signal)).outputs[0]?.text || "";
  const call = async (prompt: string, withoutImagesPrompt = prompt) => {
    try { return await send(prompt); }
    catch (err) {
      const code = err instanceof GenError ? err.code : String((err as { code?: unknown })?.code || "");
      if (code !== "PROVIDER_PROTOCOL_ERROR" || abort.signal.aborted || !requestBase.inputs.some((x) => x.kind === "image")) throw err;
      requestBase = { ...requestBase, inputs: requestBase.inputs.filter((x) => x.kind !== "image") };
      store.patchRun(id, { stream: "供应商未接受图片输入，正在改用文字出表…" });
      return send(withoutImagesPrompt);
    }
  };
  try {
    // 把每个素材来源（= 输入通道）连同张数告诉模型
    const sourceBrief = sources.map((ch) => ({ name: ch.title, count: ch.items.length }));
    // 规划遍（旧版 buildListPlanPrompt）：先单独要一份「每组怎么用」；解析失败 / 请求失败都重试一次（只要 JSON），
    // 还不行才退回单遍出表（通道模式交给行文本证据推断）
    let plan: ListPlan | null = null;
    if (sources.length) {
      const askPlan = async (prompt: string, withoutImagesPrompt: string) => parseListPlan(await call(prompt, withoutImagesPrompt));
      try { plan = await askPlan(planPrompt(task, mode, sourceBrief), planPrompt(taskWithoutImages, mode, sourceBrief)); }
      catch { plan = null; }
      if (!plan && !abort.signal.aborted) {
        store.patchRun(id, { stream: "规划没解析出来，重试一次…" });
        try { plan = await askPlan(planRepairPrompt(task, mode, sourceBrief), planRepairPrompt(taskWithoutImages, mode, sourceBrief)); }
        catch { plan = null; }
      }
      if (!plan) store.patchRun(id, { stream: "规划没拿到，按单遍出表…" });
    }
    const planText = plan ? planTextOf(plan, sourceBrief) : "";
    const askPrompt = tablePrompt(task, mode, media, sourceBrief, planText);
    const askPromptWithoutImages = tablePrompt(taskWithoutImages, mode, media, sourceBrief, planText);
    let raw = await call(askPrompt, askPromptWithoutImages);
    let t: TableData; let plans: InputGroupPlan[] = plan ? plan.inputGroups : [];
    const parseReply = (text: string) => parseTableReply(text);
    try {
      const reply = parseReply(raw);
      t = reply.table;
      // 两遍 inputGroups 按 group 合并：生成遍优先、缺的保留规划遍（整体替换会丢掉规划遍对其它组的判断）
      plans = mergeInputGroups(reply.inputGroups, plans);
    } catch {
      store.patchRun(id, { stream: "表格格式校验未通过，正在修复…" });
      raw = await call(repairPrompt(raw));
      const reply = parseReply(raw);
      t = reply.table;
      plans = mergeInputGroups(reply.inputGroups, plans);
    }
    const doc = store.state.doc;
    const existing = doc.nodes.find((n) => n.kind === "table" && tableOf(n).sourceId === id);
    const existingTable = existing ? tableOf(existing) : null;
    const sourceIds = new Set(sources.map((ch) => ch.sourceId));
    // 每个素材来源直接连到表格（旧版 materializeLlmTable 的「素材 --toPort--> 表格」），文本节点那条边保留
    const ensureSourceEdges = (tableId: string) => {
      const have = new Set(store.state.doc.edges.filter((e) => e.to === tableId).map((e) => e.from));
      const add = sources.map((ch) => ch.sourceId).filter((sid) => !have.has(sid)).map((sid) => ({ id: uid("e"), from: sid, to: tableId }));
      if (add.length) store.addNodes([], add);
    };
    if (existing) ensureSourceEdges(existing.id);
    // 通道编号 = 提示词组号：把表格的 gen.order 固定成「文本节点 → 各素材来源」的边顺序。
    // 表格上多出来的旧通道不删边（用户可能手连），按 inputsOf 的规则排在最后，由常驻告警说明。
    const pinSourceOrder = (tableId: string) => {
      const d = store.state.doc;
      const tn = d.nodes.find((n) => n.id === tableId); if (!tn) return;
      const edgeTo = (fromId: string) => d.edges.find((e) => e.to === tableId && e.from === fromId);
      const textEdge = edgeTo(id);
      const srcEdges = sources.map((ch) => edgeTo(ch.sourceId)).filter((e): e is CanvasEdge => !!e);
      const order = [...(textEdge ? [textEdge.id] : []), ...srcEdges.map((e) => e.id)];
      const cur = genOf(tn).order;
      if (order.length && (order.length !== cur.length || order.some((x, i) => cur[i] !== x))) store.updateNode(tableId, (n) => withGen(n, { order }));
    };
    if (existing) pinSourceOrder(existing.id);
    const baseChannels: TableChannel[] = existing ? tableChannels(store.state.doc, existing.id) : sources;
    // 通道模式**逐通道**解析：声明（模型/规划遍）> 行文本「输入 N 整组 / 第 k 张」推断 > 缺省沿用。
    // 有声明不代表其它通道不用推断：真实模型只回报 group1 时，2-4 组必须继续从行文本推断。
    // 用户手点表头改过的模式（不在 inputModesAuto 里）永远优先，重新出表不覆盖。
    const inferredModes: Record<string, ChannelMode> = mode === "table" ? inferChannelModesFromRows(t, baseChannels) : {};
    const sourceGroup = new Map(sources.map((ch, i) => [ch.sourceId, i + 1]));
    const wanted = new Map<string, ChannelMode>();
    baseChannels.forEach((ch) => {
      if (!sourceIds.has(ch.sourceId)) return;
      const declared = plannedChannelMode(sourceGroup.get(ch.sourceId) || 0, plans);
      const wantMode = declared || inferredModes[ch.id];
      if (wantMode) wanted.set(ch.sourceId, wantMode);
    });
    const inputModes = channelModesOf(existingTable?.inputModes);
    // 迁移口径：inputModesAuto 缺失 = 旧版本写的文档，里面的模式是旧系统自动写的 → 本次出表允许按规划/推断覆盖，
    // 并补写 inputModesAuto；字段存在（哪怕是空数组）= 新格式，列表外的模式算用户手点，保护起来。
    // 旧版本本来就是每次出表覆盖所有声明通道，所以把 legacy 当 auto 不会吃掉用户手设（用户手设只能来自本版本的表头点击）。
    const legacyModes = !!existingTable && !Array.isArray(existingTable.inputModesAuto);
    const autoModes = new Set<string>(legacyModes ? Object.keys(inputModes) : (existingTable?.inputModesAuto || []));
    for (const ch of baseChannels) {
      if (!sourceIds.has(ch.sourceId)) continue;                          // 用户手连的额外通道：模式不动
      if (!legacyModes && inputModes[ch.id] && !autoModes.has(ch.id)) continue; // 新格式里列表外 = 用户手设：不覆盖
      const wantMode = wanted.get(ch.sourceId);
      if (wantMode) { inputModes[ch.id] = wantMode; autoModes.add(ch.id); }
      else { delete inputModes[ch.id]; autoModes.delete(ch.id); }
    }
    const legacyMode = existingTable?.inputMode;
    const finalChannels: TableChannel[] = baseChannels.map((ch) => ({ ...ch, mode: inputModes[ch.id] || (ch.id === "input-1" && legacyMode === "sequence" ? "sequence" : "shared") }));
    // 行数只由「逐行」的输入通道决定（这些通道的最大张数）；「全部」每行带整组、不增加行数。
    // 用户手连的额外通道沿用旧口径（不算进行数）。分镜表的行数 = 镜头数，由提示词定，永远不补不裁。
    const needChannels = finalChannels.filter((ch) => sourceIds.has(ch.sourceId));
    const need = perRowRowCount(needChannels, needChannels.flatMap((ch, i) => (ch.mode === "sequence" ? [{ group: i + 1, rowMode: "per-row" as const }] : [])));
    let paddedRows = 0; let trimmed = false;
    if (mode === "table" && need > 0) {
      if (t.rows.length > need) { t = trimTableRows(t, need); trimmed = true; }
      else if (t.rows.length < need) {
        store.patchRun(id, { stream: `行数比素材少，正在补到 ${need} 行…` });
        try {
          const fixed = parseReply(await call(growRowsPrompt(t, need)));
          if (fixed.table.rows.length > t.rows.length) t = fixed.table;
        } catch { /* 补行修复失败就按素材补空行，不阻断出表 */ }
        if (t.rows.length > need) { t = trimTableRows(t, need); trimmed = true; }
        else if (t.rows.length < need) { paddedRows = need - t.rows.length; t = padTableRows(t, need); }
      }
    }
    if (mode === "storyboard") t = withStoryboardMedia({ ...t, columns: t.columns.length ? t.columns : STORYBOARD_COLUMNS });
    const title = mode === "storyboard" ? "分镜表" : "多维表格";
    // 重新出表：手动放进首帧 / 尾帧等图片列的图按行保留（列名相同才算）；组里的图不进数据列，只走输入通道
    const channelIds = new Set(baseChannels.map((ch) => ch.id));
    const autoList = [...autoModes].filter((x) => channelIds.has(x) && inputModes[x]);
    // 一律写 inputModesAuto（空数组也算）：标成新格式，下次出表才能区分「系统写」和「用户手点」
    const modesData = { ...(Object.keys(inputModes).length ? { inputModes } : {}), inputModesAuto: autoList };
    const base: TableData = keepMediaCells({ ...t, title: existingTable ? existingTable.title : title, sourceId: id, ...modesData }, existingTable);
    let tableId: string; let table: TableData;
    if (existing) {
      table = base;
      // 高度按「写完模式后」每行真正取到的素材数算：全部模式的整组会占更多行高
      const size = tableAutoSize(table, finalChannels);
      store.updateNode(existing.id, (n) => ({ ...withTable(n, table), w: Math.max(n.w, size.w), h: size.h }), { history: true });
      tableId = existing.id;
    } else {
      table = base;
      const size = tableAutoSize(table, finalChannels);
      const pos = spotRightOf(doc, node, size.h);
      const tn: CanvasNode = withTable({ id: uid("t"), kind: "table", x: pos.x, y: pos.y, w: size.w, h: size.h, text: title }, table);
      // 先连文本节点（上下文），再按顺序连每个素材来源 → 通道编号就是 输入 1 / 2 / 3…
      store.addNodes([tn], [{ id: uid("e"), from: id, to: tn.id }, ...sources.map((ch) => ({ id: uid("e"), from: ch.sourceId, to: tn.id }))]);
      tableId = tn.id;
    }
    const channels = tableChannels(store.state.doc, tableId);
    const placed = channels.filter((ch) => ch.items.length).map((ch) => `「${ch.title}」${ch.items.length} 张 → 输入 ${channelIndexFromId(ch.id) + 1}（${CHANNEL_MODE_LABEL[ch.mode]}）`).join("，");
    const notes: string[] = [];
    if (paddedRows) notes.push(`已按素材补到 ${need} 行，空的提示词列请手动补`);
    if (trimmed) notes.push(`按素材把行数对齐到 ${need} 行`);
    // 「输入 N」编号对不上 / 多出来的旧通道：常驻告警（表格节点和批量面板也会显示），并写进历史与 toast
    notes.push(...tableInputWarnings(store.state.doc, tableId, channels));
    const alignNote = notes.join("；");
    const summary = `已生成${title}：${table.rows.length} 行 × ${table.columns.length} 列\n列：${table.columns.join("、")}` + (placed ? `\n输入列：${placed}` : "") + (alignNote ? `\n${alignNote}` : "");
    const hist = [...genOf(store.node(id)!).hist, { text: summary, meta: { model: m.name, at: Date.now() } }];
    store.patchGen(id, { hist, hi: hist.length - 1, manual: false });
    store.setRun(id, null);
    store.logRun({ node: id, title: g.title, type: "text", model: m.name, status: "done", secs: Math.round((performance.now() - t0) / 1000) });
    store.toast((existing ? `已更新「${table.title}」：${table.rows.length} 行` : `已新建「${title}」并连好线：${table.rows.length} 行`) + (alignNote ? `；${alignNote}` : ""));
    return true;
  } catch (err) {
    store.setRun(id, null);
    const stopped = err instanceof GenError && err.code === "STOPPED";
    const { err: msg, errCode } = nodeError(err);
    if (!stopped) store.patchGen(id, { err: msg, errCode });
    store.logRun({ node: id, title: g.title, type: "text", model: m.name, status: stopped ? "stopped" : "error", secs: 0, error: errCode ? errCode + " " + msg : msg });
    return false;
  }
}

/* ---------- 表格 → 逐行批量生成 ---------- */
export async function runTableBatch(store: CanvasStore, id: string, opts: RunOpts = {}): Promise<boolean> {
  const gen = store.node(id)!; const g = genOf(gen); const m = store.modelOf(gen)!;
  const { settings, journal } = batchOf(gen);
  // 图片批量回填（分镜「首帧图」）：自动选中的列第一次运行时记下来，重跑仍填同一列
  const fill = fillTargetOf(store.state.doc, id, settings);
  if (fill && settings.fill === undefined) store.updateNode(id, (n) => withBatch(n, { settings: { fill } }));
  const rows = batchRows(store.state.doc, id, fill);
  const todo = rowsToRun(rows, settings);
  if (!todo.length) { store.toast(emptyRunHint(rows, settings)); return false; }
  const chain = gen.kind === "video" && !!settings.chain;
  // 续跑：上次 journal 里没完成的行（且仍在本次范围内）
  const resumable = journal && journal.rows.some((r) => r.status !== "completed") ? journal : null;
  const jr: BatchJournal = resumable ? { ...resumable, rows: resumable.rows.map((r) => (r.status === "running" ? { ...r, status: "pending" } : r)) } : { runId: uid("b"), rows: todo.map((r) => ({ row: r.row, status: "pending" })) };
  const pending = jr.rows.filter((r) => r.status !== "completed" && todo.some((t) => t.row === r.row)).sort((a, b) => a.row - b.row);
  if (!pending.length) { store.updateNode(id, (n) => withBatch(n, { journal: null })); return runTableBatch(store, id); }
  const conc = chain ? 1 : Math.min(settings.concurrency, pending.length);
  // 每行的参数（时长 / 比例 / 方式）和要提醒的地方，开跑前算一遍
  const reservedRefs = ownRefCount(store.state.doc, id, gen.kind as GenKind);
  const plans = new Map(todo.map((r) => [r.row, planRow(gen.kind as GenKind, g.params, m, r, reservedRefs)]));
  // 每行的提醒（参考图超上限被截 / 降级）落进 journal，跑完还能在批量面板复查，不只靠 toast
  jr.rows = jr.rows.map((x) => { const w = plans.get(x.row)?.warnings; return w && w.length ? { ...x, warn: w.join("；") } : x; });
  const notes = new Map<string, number[]>();
  for (const r of pending) for (const w of plans.get(r.row)?.warnings || []) notes.set(w, [...(notes.get(w) || []), r.row]);
  const noteText = [...notes].slice(0, 2).map(([w, rs]) => `第 ${rs.slice(0, 6).join("、")}${rs.length > 6 ? " 等" : ""} 行：${w}`).join("；");
  store.toast((resumable ? `继续上次未完成的 ${pending.length} 行，已完成的行跳过` : `已开始批量生成：${pending.length} 行，${chain ? "镜头串联逐行生成" : "并发 " + conc}`) + (fill ? "，结果会填回表格" : "") + (noteText ? "。" + noteText : ""), noteText ? 6000 : 2600);
  // 结果节点：每行一个，排在生成节点右侧一列
  const doc = store.state.doc; const colX = gen.x + gen.w + 120;
  const existingY = doc.nodes.filter((n) => (n.data as any)?.batchOf === id).map((n) => n.y + n.h + 24 + 40);
  let y = Math.max(gen.y, ...existingY);
  const created: CanvasNode[] = []; const edges = [];
  // 按（这一行的）比例预估出图后的尺寸来排行间距（出图后节点会按比例长高，按原高度排会互相压住）
  const boxOf = (ratio: unknown) => (gen.kind === "image" || gen.kind === "video") ? fitMediaBox(gen.w, ratioOf(ratio) ?? 0, 1) : null;
  for (const r of pending) {
    // 已有结果节点就复用：先看 journal 的 nodeId，再按 batchOf + tableRow 兜底（全量重跑时 journal 会重建，nodeId 会丢）
    const reused = (r.nodeId && store.node(r.nodeId)) || doc.nodes.find((n) => {
      const d = (n.data || {}) as { batchOf?: unknown; tableRow?: unknown };
      return d.batchOf === id && Number(d.tableRow) === r.row;
    });
    if (reused) { r.nodeId = reused.id; continue; }
    const row = todo.find((t) => t.row === r.row)!; const params = plans.get(r.row)?.params || g.params; const box = boxOf((params as { ratio?: string }).ratio);
    const rowW = box ? box.w : gen.w; const rowH = box ? box.h : gen.h;
    const rowPlanWarn = plans.get(r.row)?.warnings;
    const c = withGen({ id: uid("n"), kind: gen.kind, x: colX, y, w: rowW, h: rowH, text: "", data: { batchOf: id, tableRow: r.row, ...(row.text ? { rowText: row.text } : {}), ...(rowPlanWarn && rowPlanWarn.length ? { rowWarn: rowPlanWarn.join("；") } : {}) } }, { title: `${g.title} · ${row.label || "行" + r.row}`, prompt: g.prompt, params: JSON.parse(JSON.stringify(params)), hist: [], hi: 0, order: [] });
    y += rowH + 24 + 40; r.nodeId = c.id; created.push(c); edges.push({ id: uid("e"), from: id, to: c.id });
  }
  if (created.length) store.addNodes(created, edges);
  store.updateNode(id, (n) => withBatch(n, { journal: jr }));
  const abort = new AbortController(); let done = 0; let stop = false; const failed: number[] = [];
  store.setRun(id, { status: "running", progress: .02, abort, startedAt: Date.now(), batch: { done: 0, total: pending.length } });
  const setRow = (row: number, patch: Partial<BatchJournal["rows"][number]>) => { jr.rows = jr.rows.map((x) => (x.row === row ? { ...x, ...patch } : x)); store.updateNode(id, (n) => withBatch(n, { journal: { ...jr } })); };
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length && !stop && !abort.signal.aborted) {
      const jrow = pending[cursor++]; let row = todo.find((t) => t.row === jrow.row) as BatchRow; const target = store.node(jrow.nodeId)!;
      setRow(jrow.row, { status: "running" });
      // 镜头串联：这一行没有首帧时，接上一行（已完成）视频的最后一帧
      if (chain && !rowHasFirst(row)) { const tail = await chainFrame(store, jr, todo, row.row); if (tail) row = { ...row, media: [...row.media, tail] }; }
      // 原图比例但这一行没有可量尺寸的图：在 journal 里留一句提醒（不静默按 1:1 生成）
      if (gen.kind === "image" && isAdaptiveRatio((plans.get(row.row)?.params as { ratio?: string; }).ratio)) {
        const rowImage = (row.media || []).find((x) => x.kind === "image");
        const upstreamBox = sourceBoxInDoc(store.state.doc, gen, gen.kind);
        if (!rowImage && !upstreamBox) setRow(jrow.row, { warn: "这一行没有参考图，原图比例按 1:1 生成" });
      }
      const req = buildRequest(store, gen, row, { excludeSelfRefs: opts.excludeSelfRefs }); if (!req) { setRow(jrow.row, { status: "failed", error: "无法组装请求" }); continue; }
      const rowReq = { ...req, nodeId: target.id };
      store.updateNode(target.id, (n) => ({ ...n, data: { ...(n.data as object), frozen: rowReq } }));
      const onParentAbort = () => store.stopRun(target.id); abort.signal.addEventListener("abort", onParentAbort);
      const ok = await execute(store, store.node(target.id)!, rowReq, `${g.title} · ${row.label || "行" + jrow.row}`);
      abort.signal.removeEventListener("abort", onParentAbort);
      done++; store.patchRun(id, { progress: done / pending.length, batch: { done, total: pending.length } });
      if (ok) { setRow(jrow.row, { status: "completed" }); if (fill) fillBack(store, fill, jrow.row, target.id); }
      else { failed.push(jrow.row); setRow(jrow.row, { status: "failed", error: genOf(store.node(target.id)!).err }); if (settings.failure === "stop") stop = true; }
    }
  };
  await Promise.all(Array.from({ length: conc }, () => worker()));
  store.setRun(id, null);
  const left = jr.rows.filter((r) => r.status !== "completed").length;
  if (!left) store.updateNode(id, (n) => withBatch(n, { journal: { ...jr } }));
  store.toast(abort.signal.aborted ? `已停止：完成 ${done - failed.length} 行，剩下的行再点生成会接着跑` : failed.length ? `批量生成未全部完成：计划 ${pending.length}，成功 ${pending.length - failed.length}，失败 ${failed.length}（第 ${failed.join("、")} 行）。再点生成只重跑失败的行` : `批量生成完成：${pending.length} 行` + (fill ? "，已填回表格" : ""), 4200);
  return !failed.length;
}

/** 图片批量：把这一行的结果写进表格的回填列（首帧列） */
function fillBack(store: CanvasStore, fill: FillTarget, row: number, resultId: string) {
  const url = outOf(store.node(resultId)!)?.url; const tn = store.node(fill.table);
  if (!url || !tn) return;
  store.updateNode(fill.table, (n) => { const t = tableOf(n); if (fill.col >= t.columns.length) return n; const rows = t.rows.map((r) => [...r]); while (rows.length < row) rows.push(t.columns.map(() => "")); rows[row - 1][fill.col] = url; return withTable(n, { ...t, rows }); });
}

/** 镜头串联：上一行（本次范围内、已完成）视频的最后一帧，存进资源库后作为这一行的首帧 */
async function chainFrame(store: CanvasStore, jr: BatchJournal, todo: BatchRow[], row: number) {
  const prev = todo.filter((t) => t.row < row).pop(); if (!prev) return null;
  const j = jr.rows.find((r) => r.row === prev.row); const pn = j?.status === "completed" ? store.node(j.nodeId) : undefined;
  const po = pn ? outOf(pn) : null; if (!pn || !(po?.url || po?.frame)) return null;
  const data = store.grabFrame ? await store.grabFrame(pn.id, "last").catch(() => "") : "";
  if (!data) return null;
  const url = data.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, data, `${genOf(pn).title} · 尾帧`) : data;
  return { nodeId: `chain:${pn.id}`, kind: "image" as const, title: `${genOf(pn).title} · 尾帧`, src: url, url, as: "first" as const };
}

/* ---------- 分组运行（TapNow Run Group） ---------- */
export type GroupPlan = {
  /** 按依赖分层：同一层互不依赖，可以并行 */
  levels: string[][];
  total: number;
  /** 预计调用次数（张数 / 次数都算进去）、按类型、按模型 */
  calls: number;
  byKind: Record<GenKind, number>;
  byModel: Array<{ name: string; calls: number }>;
  /** 预计耗时（秒，按每层最慢的节点累加） */
  secs: number;
  /** 跳过的节点及原因（手写 / 上传 / 没提示词 / 组外上游没结果 / 没模型） */
  skipped: Array<{ id: string; title: string; why: string }>;
  /** 范围里已经有结果的节点数（确认框里决定要不要显示「只跑没结果的」） */
  hasOut: number;
};

/** 节点一次运行会产出几份结果（图片张数 / 视频次数），用于预估消耗 */
export function callsOf(n: CanvasNode): number {
  const p = genOf(n).params as Partial<ImageParams & VideoParams>;
  if (n.kind === "image") return Math.max(1, Number(p.count) || 1);
  if (n.kind === "video") return Math.max(1, Number(p.times) || 1);
  return 1;
}

export type PlanOpts = {
  /** 只运行还没有结果的节点（已有结果的直接给下游用） */
  onlyMissing?: boolean;
};

export function planGroup(store: CanvasStore, ids: string[], opts: PlanOpts = {}): GroupPlan {
  const doc = store.state.doc; const inGroup = new Set(ids);
  const skipped: GroupPlan["skipped"] = []; const run = new Set<string>(); let hasOut = 0;
  for (const id of ids) {
    const n = store.node(id); if (!n || !isGenKind(n.kind)) continue;
    const g = genOf(n); const ins = expandGroupInputs(doc, inputsOf(doc, id));
    if (g.manual || g.uploaded) continue; // 手写文本 / 上传素材本身就是结果，不算跳过
    if (outOf(n)) { hasOut++; if (opts.onlyMissing) continue; }
    if (!g.prompt.trim() && !ins.length) { skipped.push({ id, title: g.title, why: "没有提示词也没有输入" }); continue; }
    if (!store.modelOf(n)) { skipped.push({ id, title: g.title, why: "没有可用模型" }); continue; }
    run.add(id);
  }
  // 组外上游没结果：这个节点和它在组内的下游都跑不了
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...run]) {
      const bad = expandGroupInputs(doc, inputsOf(doc, id)).find((x) => isGenKind(x.node.kind) && !outOf(x.node) && !(inGroup.has(x.node.id) && run.has(x.node.id)));
      if (bad) { run.delete(id); skipped.push({ id, title: genOf(store.node(id)!).title, why: `上游「${genOf(bad.node).title}」还没有结果` }); changed = true; }
    }
  }
  // 分层（Kahn）：只看组内、要运行的节点之间的依赖
  const levels: string[][] = []; const done = new Set<string>(); let left = [...run];
  while (left.length) {
    const lv = left.filter((id) => expandGroupInputs(doc, inputsOf(doc, id)).every((x) => !run.has(x.node.id) || done.has(x.node.id)));
    if (!lv.length) break; // 不会成环（连线时已禁止），保险起见
    levels.push(lv); lv.forEach((id) => done.add(id)); left = left.filter((id) => !done.has(id));
  }
  const byKind: Record<GenKind, number> = { text: 0, image: 0, video: 0, audio: 0 }; const models = new Map<string, number>(); let calls = 0; let secs = 0;
  for (const lv of levels) {
    let slow = 0;
    for (const id of lv) { const n = store.node(id)!; const c = callsOf(n); const m = store.modelOf(n)!; calls += c; byKind[n.kind as GenKind] += c; models.set(m.name, (models.get(m.name) || 0) + c); slow = Math.max(slow, m.secs || 10); }
    secs += slow;
  }
  return { levels, total: done.size, calls, byKind, byModel: [...models].map(([name, c]) => ({ name, calls: c })).sort((a, b) => b.calls - a.calls), secs, skipped, hasOut };
}

/** 按计划逐层运行：同层并行；某个节点失败时，它在组内的下游不再运行。
 *  key 用来登记进度（分组头 / 顶部进度条显示），stopGroup(key) 可以中途停下 */
export async function runGroup(store: CanvasStore, plan: GroupPlan, meta: { key?: string; label?: string } = {}): Promise<{ ok: number; failed: number; skipped: number; stopped: boolean }> {
  const key = meta.key || "run:" + Date.now();
  const failed = new Set<string>(); let ok = 0; let skippedDown = 0;
  const all = plan.levels.flat();
  store.setBatch(key, { key, label: meta.label || "分组", total: all.length, done: 0, failed: 0, queued: all, stopped: false, startedAt: Date.now() });
  const blocked = (id: string) => expandGroupInputs(store.state.doc, inputsOf(store.state.doc, id)).some((x) => failed.has(x.node.id));
  const stopped = () => !!store.state.batches[key]?.stopped;
  const tick = (id: string) => { const b = store.state.batches[key]; if (b) store.patchBatch(key, { done: ok, failed: failed.size - skippedDown, queued: b.queued.filter((x) => x !== id) }); };
  let st = false;
  try {
    for (const lv of plan.levels) {
      if (stopped()) break;
      await Promise.all(lv.map(async (id) => {
        if (!store.node(id) || stopped()) return;
        if (blocked(id)) { failed.add(id); skippedDown++; tick(id); return; }
        const res = await runNode(store, id, { chain: true }).catch(() => false);
        if (!res) failed.add(id); else ok++;
        tick(id);
      }));
    }
  } finally {
    st = stopped(); store.setBatch(key, null);
  }
  return { ok, failed: failed.size - skippedDown, skipped: skippedDown, stopped: st };
}

/** 停止一键运行：正在跑的节点中止，后面的不再开始 */
export function stopGroup(store: CanvasStore, key: string) {
  const b = store.state.batches[key]; if (!b) return;
  store.patchBatch(key, { stopped: true });
  for (const id of b.queued) store.stopRun(id);
}
