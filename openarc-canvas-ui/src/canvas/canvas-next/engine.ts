/**
 * 生成引擎：组装请求 → 调后端 → 写回节点。界面只调这里的函数。
 *
 *   runNode       单节点生成（已有结果时在下方新建节点重新生成，不叠在原节点里）
 *   runChain      运行到此（含上游）/ 从此运行下游
 *   stopNode      停止
 *   buildRequest  请求预览也用它，看到的就是发给后端的
 *   文本节点「输出：多维表格 / 分镜表」→ runTextToTable
 *   上游连着表格的生成节点 → runTableBatch（逐行批量）
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { GenError, type GenInput, type GenRequest } from "./backend/types";
import { applyElements, elementInputs } from "./elements";
import { nodeError } from "./errorText";
import { plainPrompt, resolveMentions, unmentionedInputs, type SentRef } from "./mentions";
import { autoVideoMode, clamp, draftRes, expandGroupInputs, genOf, inputsOf, isGenKind, outOf, outputsOf, refsIn, textOf, uid, VMODES, withGen, type GenKind, type GenOutput, type ImageParams, type ModelSpec, type TextParams, type VideoParams } from "./model";
import type { CanvasStore } from "./store";
import { batchOf, batchRows, ROLE_META, fillGroupColumns, groupInputs, groupNote, keepMediaCells, withStoryboardMedia, emptyRunHint, fillTargetOf, parseTableJson, planRow, repairPrompt, rowHasFirst, rowsToRun, STORYBOARD_COLUMNS, tableAutoSize, tableGenKindOf, tableMedia, tableOf, tablePrompt, withBatch, withTable, type BatchJournal, type BatchRow, type FillTarget, type TableData } from "./table";

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

export function buildRequest(store: CanvasStore, node: CanvasNode, row?: BatchRow): GenRequest | null {
  if (!isGenKind(node.kind)) return null;
  const doc = store.state.doc; const m = store.modelOf(node); if (!m) return null;
  const g = genOf(node);
  // 表格的一行：时长 / 比例 / 首尾帧按行定（planRow），这一行自带图时生成节点自己连的图片不再发送
  const plan = row ? planRow(node.kind, g.params, m, row) : null;
  const eff = plan ? plan.params : g.params;
  const allIns = inputsOf(doc, node.id);
  const skip = unmentionedInputs(node, allIns);
  const directIns = allIns.filter((x) => x.node.kind !== "table" && !skip.has(x.edge.id) && !(plan?.ownImages && x.node.kind === "image"));
  const expandedIns = node.kind === "text" ? directIns : expandGroupInputs(doc, directIns);
  const expandedSkip = unmentionedInputs(node, expandedIns, allIns);
  const ins = expandedIns.filter((x) => !expandedSkip.has(x.edge.id));
  const { roles, ignored } = rolesFor(node.kind, eff, m, ins);
  const inputs: GenInput[] = ins.filter((x) => !ignored.has(x.edge.id)).map((x) => ({ nodeId: x.node.id, title: genOf(x.node).title, kind: x.node.kind as GenKind, order: x.order + 1, role: roles.get(x.edge.id) || "context", url: outOf(x.node)?.url || (x.node.kind === "video" ? outOf(x.node)?.frame : undefined), text: x.node.kind === "text" ? textOf(x.node) : undefined }));
  if (plan) plan.inputs.forEach((ri) => { if (!inputs.some((i) => i.nodeId === ri.nodeId)) inputs.push({ ...ri, order: inputs.length + 1 }); });
  // 元素（@名字）：参考图按模型剩余的参考名额加进来
  inputs.push(...elementInputs(g.prompt, node.kind, m, eff, inputs));
  const vm = node.kind === "video" ? (eff as VideoParams).mode : undefined;
  // 草稿模式：按模型最低清晰度出片（请求预览里看到的就是实际发出的清晰度）
  const params = node.kind === "video" && (eff as VideoParams).draft ? { ...(eff as VideoParams), res: draftRes(eff as VideoParams, m) } : eff;
  return { canvasId: store.state.canvasId, nodeId: node.id, kind: node.kind, model: m, prompt: g.prompt, resolvedPrompt: resolvePrompt(doc, node, row?.text || "", inputs.filter((x) => x.kind !== "text").map((x) => ({ nodeId: x.nodeId, kind: x.kind, role: x.role }))), params, inputs, ...(vm ? { videoMode: { name: vm, api: VMODES[vm].api } } : {}) };
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
/** 源节点右侧 120px；已有下游时往下避让（DX OS l6） */
export function spotRightOf(doc: CanvasDoc, src: CanvasNode, h: number) {
  const outs = outputsOf(doc, src.id);
  const y = Math.max(src.y + src.h / 2 - h / 2, ...outs.map((o) => o.y + o.h + 24 + 42));
  return { x: src.x + src.w + 120, y };
}

/* ---------- 单节点 ---------- */
export type RunOpts = { chain?: boolean; inPlace?: boolean };

export async function runNode(store: CanvasStore, id: string, opts: RunOpts = {}): Promise<boolean> {
  let node = store.node(id); if (!node || !isGenKind(node.kind)) return false;
  if (store.state.runtime[id]) return false;
  const doc = store.state.doc;
  if (!store.backend.available()) { store.toast("未连接桌面后端，无法生成"); return false; }
  const m = store.modelOf(node);
  if (!m) { store.toast(`还没有可用的${node.kind === "text" ? "文本" : node.kind === "image" ? "图片" : node.kind === "video" ? "视频" : "音频"}模型，请在设置 › 模型里添加`); return false; }
  const g = genOf(node);
  // 文本节点出表
  if (node.kind === "text" && ((g.params as TextParams).output === "table" || (g.params as TextParams).output === "storyboard")) return runTextToTable(store, id);
  // 上游有表格 → 逐行批量
  if (inputsOf(doc, id).some((x) => x.node.kind === "table") && !opts.inPlace) return runTableBatch(store, id);
  const frozen = (node.data as { frozen?: GenRequest } | undefined)?.frozen;
  const allIns = inputsOf(doc, id);
  const skipIns = unmentionedInputs(node, allIns);
  const expandedIns = expandGroupInputs(doc, allIns.filter((x) => x.node.kind !== "table" && !skipIns.has(x.edge.id)));
  const expandedSkip = unmentionedInputs(node, expandedIns, allIns);
  const ins = expandedIns.filter((x) => !expandedSkip.has(x.edge.id));
  const notReady = frozen ? [] : ins.filter((x) => isGenKind(x.node.kind) && !outOf(x.node) && !store.state.runtime[x.node.id]);
  if (notReady.length && !opts.chain) { store.toast(`上游「${genOf(notReady[0].node).title}」还没有结果。右键选「运行到此（含上游）」可以一起跑`); return false; }
  if (!frozen && !g.prompt.trim() && !ins.length && !(node.kind === "text" && g.manual)) { store.toast("先写一句提示词，或者连一个上游节点"); return false; }
  // 已有结果：在下方新建节点重新生成（原结果保留）
  if (outOf(node) && !opts.chain && !opts.inPlace && !(node.kind === "text" && g.manual)) { node = regenAsNew(store, node); id = node.id; }
  const req = frozen ? { ...frozen, nodeId: id, params: genOf(node).params, prompt: genOf(node).prompt, model: m } : buildRequest(store, node);
  if (!req) return false;
  return execute(store, node, req);
}

/** "16:9" → 宽高比 16/9；自适应 / auto / 不合法 → null */
export function ratioOf(r: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(r ?? "").trim());
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

/** 执行一次请求并写回（单节点 / 批量行共用） */
async function execute(store: CanvasStore, node: CanvasNode, req: GenRequest, label?: string): Promise<boolean> {
  const id = node.id; const abort = new AbortController(); const t0 = performance.now();
  store.patchGen(id, { err: undefined, errCode: undefined });
  // 生成中的占位（加载动效）先按面板选的比例摆好，不要等结果回来才变形；自适应 / 没选比例的保持原样
  const want = ratioOf((req.params as { ratio?: string }).ratio);
  if (want && (node.kind === "image" || node.kind === "video")) store.updateNode(id, (n) => ({ ...n, h: Math.round(clamp(n.w / want, 100, 520)) }));
  store.setRun(id, { status: "running", progress: .02, abort, startedAt: Date.now() });
  try {
    const res = await store.backend.generate(req, (e) => {
      if (e.type === "progress") store.patchRun(id, { progress: clamp(e.progress, .02, 1) });
      else if (e.type === "started") store.patchRun(id, { runId: e.runId });
      else if (e.type === "text") store.patchRun(id, { stream: e.text });
    }, abort.signal);
    // 生成期间节点被删除 / 撤销掉：结果无处可写，按「已停止」记录，不当成报错
    if (!store.node(id)) throw new GenError("STOPPED", "节点已被删除或撤销，生成结果未写回");
    const isDraft = req.kind === "video" && !!(req.params as VideoParams).draft;
    const outs = (await persistOutputs(store, res.outputs, genOf(node).title)).map((o) => (isDraft ? { ...o, draft: true } : o));
    if (!store.node(id)) throw new GenError("STOPPED", "节点已被删除或撤销，生成结果未写回");
    applyOutputs(store, id, outs);
    store.setRun(id, null);
    const cur = store.node(id)!;
    store.logRun({ node: id, title: label || genOf(cur).title, type: cur.kind as GenKind, model: req.model.name, status: "done", secs: Math.round((performance.now() - t0) / 1000), thumb: outOf(cur)?.url && cur.kind === "image" ? outOf(cur)!.url : outOf(cur)?.frame, out: runOut(outOf(cur)), prompt: plainPrompt(req.prompt, store.state.doc) });
    return true;
  } catch (err) {
    store.setRun(id, null);
    const stopped = err instanceof GenError && err.code === "STOPPED";
    // 主行只写人话；原始码留给 gen.errCode（弹层里以「代码：…」展示，便于排查）
    const { err: msg, errCode } = nodeError(err);
    if (!stopped && store.node(id)) store.patchGen(id, { err: msg, errCode });
    store.logRun({ node: id, title: label || genOf(node).title, type: node.kind as GenKind, model: req.model.name, status: stopped ? "stopped" : "error", secs: Math.round((performance.now() - t0) / 1000), error: errCode ? errCode + " " + msg : msg });
    return false;
  }
}

/** data URL 存进资源库，文档里只留引用（真后端）；模拟后端原样返回 */
async function persistOutputs(store: CanvasStore, outs: GenOutput[], name: string): Promise<GenOutput[]> {
  const be = store.backend; const cid = store.state.canvasId;
  // data URL 存进资源库；服务商返回的 https 结果由主进程下载进资源库（外链会过期，画布页也不直接显示外链）
  const keep = async (u: string | undefined, label: string) => !u ? u : u.startsWith("data:") ? (label.endsWith("封面") && be.kind !== "bridge" ? u : be.importAsset(cid, u, label)) : /^https?:\/\//i.test(u) && be.importRemote ? be.importRemote(cid, u, label) : u;
  return Promise.all(outs.map(async (o) => ({ ...o, url: await keep(o.url, name), frame: await keep(o.frame, name + " 封面") })));
}

function applyOutputs(store: CanvasStore, id: string, outs: GenOutput[]) {
  const node = store.node(id)!; const g = genOf(node);
  const fit = (n: CanvasNode, o: GenOutput): CanvasNode => (o.w && o.h && (n.kind === "image" || n.kind === "video") ? { ...n, h: Math.round(clamp((n.w * o.h) / o.w, 100, 520)) } : n);
  if (outs.length > 1 && store.state.ui.batchMode === "spread" && node.kind === "image") {
    store.mutate((d) => {
      const extra = outs.slice(1).map((o, i) => fit(withGen({ ...node, id: uid("n"), x: node.x + (i + 1) * (node.w + 30) }, { ...g, title: g.title + " · " + (i + 2), hist: [o], hi: 0, order: [] }), o));
      const edges = inputsOf(d, id).flatMap((x) => extra.map((c) => ({ id: uid("e"), from: x.node.id, to: c.id })));
      const withOrder = extra.map((c) => withGen(c, { order: edges.filter((e) => e.to === c.id).map((e) => e.id) }));
      return { ...d, nodes: [...d.nodes.map((n) => (n.id === id ? fit(withGen(n, { hist: [...g.hist, outs[0]], hi: g.hist.length }), outs[0]) : n)), ...withOrder], edges: [...d.edges, ...edges] };
    });
    return;
  }
  const hist = [...g.hist, ...outs];
  store.updateNode(id, (n) => fit(withGen(n, { hist, hi: hist.length - 1, ...(n.kind === "text" ? { manual: false } : {}) }), outs[outs.length - 1]));
}

/** 已有结果的节点再生成：正下方新建「原名 · N」，复制提示词、参数和全部输入连线 */
export function regenAsNew(store: CanvasStore, n: CanvasNode): CanvasNode {
  const doc = store.state.doc; const g = genOf(n);
  const { x, y } = freeSpotBelow(doc, n);
  const base = g.title.replace(/ · \d+$/, "");
  const sibs = doc.nodes.filter((o) => { const t = isGenKind(o.kind) ? genOf(o).title : ""; return t === base || t.startsWith(base + " · "); }).length;
  const c = withGen({ id: uid("n"), kind: n.kind, x, y, w: n.w, h: n.h, text: "", ...(n.data && (n.data as { frozen?: unknown }).frozen ? { data: { frozen: (n.data as { frozen?: unknown }).frozen } } : {}) }, { title: `${base} · ${sibs + 1}`, prompt: g.prompt, params: JSON.parse(JSON.stringify(g.params)), hist: [], hi: 0, order: [] });
  const edges = inputsOf(doc, n.id).map((x) => ({ id: uid("e"), from: x.node.id, to: c.id }));
  store.addNodes([c], edges, { select: true });
  store.toast(`已在下方新建「${genOf(c).title}」重新生成，原结果保留`);
  return store.node(c.id)!;
}

export function stopNode(store: CanvasStore, id: string) {
  const r = store.state.runtime[id]; if (!r) return;
  r.abort.abort(); store.toast("已停止生成");
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
  const media = ins.filter((x) => x.node.kind !== "text" && x.node.kind !== "table" && x.node.kind !== "group").length;
  const ctx = ins.filter((x) => x.node.kind === "text").map((x) => `【${genOf(x.node).title}】\n${textOf(x.node)}`).join("\n\n");
  const intent = mode === "storyboard" ? "video" : tableGenKindOf(g.prompt.trim() || ctx);
  const groups = groupInputs(store.state.doc, id, intent);
  const base0 = buildRequest(store, node); if (!base0) return false;
  const seeImages = !!m.vision && groups.some((x) => x.images.length);
  const groupRefs = seeImages ? groups.flatMap((gr) => gr.images.map((im, k) => ({ nodeId: im.nodeId, title: `${gr.name} 第 ${k + 1} 张`, kind: "image" as const, role: "reference" as const, url: im.url }))).slice(0, 24) : [];
  const base = { ...base0, inputs: [...base0.inputs, ...groupRefs.filter((r) => !base0.inputs.some((i) => i.nodeId === r.nodeId)).map((r, k) => ({ ...r, order: base0.inputs.length + k + 1 }))] };
  if (!g.prompt.trim() && !ins.length) { store.toast("LLM 表格工作流需要拆分任务的文字要求。"); return false; }
  const task = [ctx, g.prompt, groupNote(groups, seeImages, intent)].filter(Boolean).join("\n\n");
  const taskWithoutImages = [ctx, g.prompt, groupNote(groups, false, intent)].filter(Boolean).join("\n\n");
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
    let raw = await call(tablePrompt(task, mode, media), tablePrompt(taskWithoutImages, mode, media)); let t: TableData;
    try { t = parseTableJson(raw); } catch { store.patchRun(id, { stream: "表格格式校验未通过，正在修复…" }); raw = await call(repairPrompt(raw)); t = parseTableJson(raw); }
    if (mode === "storyboard") t = withStoryboardMedia({ ...t, columns: t.columns.length ? t.columns : STORYBOARD_COLUMNS });
    const title = mode === "storyboard" ? "分镜表" : "多维表格";
    const doc = store.state.doc;
    const existing = doc.nodes.find((n) => n.kind === "table" && tableOf(n).sourceId === id);
    // 重新出表：已经放进首帧 / 尾帧等图片列的图按行保留（列名相同才算）
    const table: TableData = keepMediaCells(fillGroupColumns({ ...t, title: existing ? tableOf(existing).title : title, sourceId: id }, groups), existing ? tableOf(existing) : null);
    const size = tableAutoSize(table, media ? 1 : 0);
    if (existing) store.updateNode(existing.id, (n) => ({ ...withTable(n, table), w: Math.max(n.w, size.w), h: size.h }), { history: true });
    else {
      const pos = spotRightOf(doc, node, size.h);
      const tn: CanvasNode = withTable({ id: uid("t"), kind: "table", x: pos.x, y: pos.y, w: size.w, h: size.h, text: title }, table);
      store.addNodes([tn], [{ id: uid("e"), from: id, to: tn.id }]);
    }
    const placed = groups.filter((x) => x.images.length).map((x) => `「${x.name}」${x.images.length} 张 → ${ROLE_META[x.role].label}列`).join("，");
    const summary = `已生成${title}：${table.rows.length} 行 × ${table.columns.length} 列\n列：${table.columns.join("、")}` + (placed ? `\n已放图：${placed}` : "");
    const hist = [...genOf(store.node(id)!).hist, { text: summary, meta: { model: m.name, at: Date.now() } }];
    store.patchGen(id, { hist, hi: hist.length - 1, manual: false });
    store.setRun(id, null);
    store.logRun({ node: id, title: g.title, type: "text", model: m.name, status: "done", secs: Math.round((performance.now() - t0) / 1000) });
    store.toast(existing ? `已更新「${table.title}」：${table.rows.length} 行` : `已新建「${title}」并连好线：${table.rows.length} 行`);
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
export async function runTableBatch(store: CanvasStore, id: string): Promise<boolean> {
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
  const plans = new Map(todo.map((r) => [r.row, planRow(gen.kind as GenKind, g.params, m, r)]));
  const notes = new Map<string, number[]>();
  for (const r of pending) for (const w of plans.get(r.row)?.warnings || []) notes.set(w, [...(notes.get(w) || []), r.row]);
  const noteText = [...notes].slice(0, 2).map(([w, rs]) => `第 ${rs.slice(0, 6).join("、")}${rs.length > 6 ? " 等" : ""} 行：${w}`).join("；");
  store.toast((resumable ? `继续上次未完成的 ${pending.length} 行，已完成的行跳过` : `已开始批量生成：${pending.length} 行，${chain ? "镜头串联逐行生成" : "并发 " + conc}`) + (fill ? "，结果会填回表格" : "") + (noteText ? "。" + noteText : ""), noteText ? 6000 : 2600);
  // 结果节点：每行一个，排在生成节点右侧一列
  const doc = store.state.doc; const colX = gen.x + gen.w + 120;
  const existingY = doc.nodes.filter((n) => (n.data as any)?.batchOf === id).map((n) => n.y + n.h + 24 + 40);
  let y = Math.max(gen.y, ...existingY);
  const created: CanvasNode[] = []; const edges = [];
  // 按（这一行的）比例预估出图后的高度来排行间距（出图后节点会按比例长高，按原高度排会互相压住）
  const hOf = (ratio: unknown) => { const pr = String(ratio ?? ""); return (gen.kind === "image" || gen.kind === "video") && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(pr) ? (() => { const [a, b] = pr.split(":").map(Number); return Math.round(clamp((gen.w * b) / a, 100, 520)); })() : gen.h; };
  for (const r of pending) {
    const old = r.nodeId && store.node(r.nodeId);
    if (old) continue;
    const row = todo.find((t) => t.row === r.row)!; const params = plans.get(r.row)?.params || g.params; const rowH = hOf((params as { ratio?: string }).ratio);
    const c = withGen({ id: uid("n"), kind: gen.kind, x: colX, y, w: gen.w, h: rowH, text: "", data: { batchOf: id, tableRow: r.row } }, { title: `${g.title} · ${row.label || "行" + r.row}`, prompt: g.prompt, params: JSON.parse(JSON.stringify(params)), hist: [], hi: 0, order: [] });
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
      const req = buildRequest(store, gen, row); if (!req) { setRow(jrow.row, { status: "failed", error: "无法组装请求" }); continue; }
      const rowReq = { ...req, nodeId: target.id };
      store.updateNode(target.id, (n) => ({ ...n, data: { ...(n.data as object), frozen: rowReq } }));
      const onParentAbort = () => store.state.runtime[target.id]?.abort.abort(); abort.signal.addEventListener("abort", onParentAbort);
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

/** 上游表格变化时，table 节点输入列数（界面显示用） */
export const tableMediaOf = tableMedia;

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
  for (const id of b.queued) store.state.runtime[id]?.abort.abort();
}
