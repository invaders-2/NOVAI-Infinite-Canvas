/** 画布上的编辑动作（连线、删除、复制粘贴、上传……），界面和 Agent 共用 */
import type { CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import { autoVideoMode, cloneParams, connectBlock, genOf, inputsOf, isGenKind, NODE_DEFAULT_SIZE, outOf, uid, withGen, type GenKind, type TextParams, type VideoParams } from "./model";
import { fitSourceBox, isAdaptiveRatio, refitNodeBox } from "./mediaFit";
import { sourceBoxForNode, sourceSizeForTier } from "./originalRatio";
import type { CanvasStore } from "./store";
import { appendMention } from "./mentions";
import { tableAutoSize, tableChannels, tableOf } from "./table";
import { hiddenIds, isStack } from "./stack";
import { keyHint } from "./ui/shortcuts";
import { computeFlowLayout, computeGridLayout, type LayoutMode } from "./autoLayout";
import { frameOf, isFrame, memberIdsDeep } from "./groupFit";
import { withGroupColor } from "./groupStyle";
import { convertImageToPng, planImageUpload } from "./imageUpload";

/** 连线；成功后选中下游节点，并按输入自动切换视频生成方式 */
export function connect(store: CanvasStore, from: string, to: string, opts: { quiet?: boolean; select?: boolean } = {}): CanvasEdge | null {
  const block = connectBlock(store.state.doc, from, to);
  if (block) { if (!opts.quiet) store.toast(block); return null; }
  const e = store.addEdge(from, to);
  afterInputsChanged(store, to);
  if (opts.select !== false) store.setUI({ sel: new Set([to]), edge: null });
  if (!opts.quiet) { const a = store.node(from)!, b = store.node(to)!; store.toast(`已连接：「${title(a)}」作为「${title(b)}」的第 ${inputsOf(store.state.doc, to).length} 个输入`); }
  return e;
}
/** 只添加用户显式选择的 @ 引用，不把其他连线自动带入。 */
export function addMention(store: CanvasStore, id: string, ref: string, section?: string) {
  const n = store.node(id); if (!n || !isGenKind(n.kind)) return;
  store.patchGen(id, (g) => ({ prompt: appendMention(g.prompt, ref, section), refMode: "mention" }));
}
export const title = (n: CanvasNode) => (isGenKind(n.kind) ? genOf(n).title : n.kind === "table" ? tableOf(n).title : n.text || n.kind);

/**
 * 原图比例：连入 / 更换参考图后，按新源图比例把空节点摆正一次（拿不到源图尺寸就不动）。
 * 只把量到的尺寸写回 params.sourceSize —— 图片是请求要发的显式 WxH（沿用尺寸档长边），
 * 视频没有自己的尺寸档，只把它当「已按哪个源图比例摆正过」的备忘（不发请求）。
 * 摆正本身由 store 的比例不变量完成：比例没变就不重摆，用户拖过的尺寸不会被弹回去。
 */
function syncSourceRatio(store: CanvasStore, n: CanvasNode) {
  if (n.kind !== "image" && n.kind !== "video") return;
  if (outOf(n)) return;                                                              // 有结果：真实比例优先
  const p = genOf(n).params as { ratio?: string; size?: string; sourceSize?: string };
  if (!isAdaptiveRatio(p.ratio)) return;
  const tier = n.kind === "image" ? String(p.size || "") : "1K";
  const size = sourceSizeForTier(sourceBoxForNode(store, n, n.kind as GenKind), tier);
  if (!size || size === (p.sourceSize || "")) return;                                // 量不到尺寸 / 比例没变：不动
  store.patchGen(n.id, (g) => ({ params: { ...g.params, sourceSize: size } }));
}

/** 输入变化后的联动：视频节点自动选生成方式；表格自动调尺寸；原图比例按新源图摆正 */
export function afterInputsChanged(store: CanvasStore, id: string) {
  const n = store.node(id); if (!n) return;
  if (n.kind === "video") { const m = store.modelOf(n); if (m) { const mode = autoVideoMode(store.state.doc, id, m); if (mode && mode !== (genOf(n).params as VideoParams).mode) store.patchGen(id, (g) => ({ params: { ...(g.params as VideoParams), mode } })); } }
  // 文本节点连进分组：输出还是「文本」时切到「多维表格」，出表按提示词区分图片 / 视频任务
  if (n.kind === "text" && inputsOf(store.state.doc, id).some((x) => x.node.kind === "group")) { const tp = genOf(n).params as TextParams; if (!tp.output || tp.output === "text") { store.patchGen(id, (g) => ({ params: { ...(g.params as TextParams), output: "table" } })); store.toast("已把输出切到「多维表格」：出表时按提示词区分图片 / 视频任务，每个分组 / 堆叠各占一列「输入 N」"); } }
  if (n.kind === "table") { const s = tableAutoSize(tableOf(n), tableChannels(store.state.doc, id).length); if (s.w > n.w) store.updateNode(id, (x) => ({ ...x, w: s.w })); }
  syncSourceRatio(store, n);
}

export function deleteSelection(store: CanvasStore) {
  const { ui } = store.state;
  if (ui.edge) { const e = store.state.doc.edges.find((x) => x.id === ui.edge); store.removeEdge(ui.edge); store.setUI({ edge: null }); if (e) afterInputsChanged(store, e.to); return; }
  if (!ui.sel.size) return;
  // 删除堆叠 = 连同叠里的节点一起删（分组只删框，组内节点留在画布上）
  const ids = withStackMembers(store, [...ui.sel]); const gone = new Set(ids);
  const touched = [...new Set(store.state.doc.edges.filter((e) => gone.has(e.from) && !gone.has(e.to)).map((e) => e.to))];
  store.removeNodes(ids); touched.forEach((t) => afterInputsChanged(store, t));
  store.toast(`已删除 ${ids.length} 个节点 · ${keyHint("undo")} 撤销`);
}
/** 选中的堆叠展开出成员（删除 / 复制时成员跟着堆叠走） */
function withStackMembers(store: CanvasStore, ids: string[]): string[] {
  const out = new Set(ids);
  for (const id of ids) { const n = store.node(id); if (isStack(n)) (n!.children || []).forEach((c) => { if (store.node(c)) out.add(c); }); }
  return [...out];
}

let clip: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
export const hasClip = () => !!clip;
/**
 * 复制节点时往系统剪贴板写一个标记：之后 ⌘V 时剪贴板里还是这个标记 → 粘贴节点；
 * 已经换成别处复制的文字 → 新建文本节点（不再误贴上一次复制的节点）。写剪贴板失败时退回旧行为。
 */
const CLIP_MARK = "novai-canvas-nodes:";
/** 升级前写进系统剪贴板的标记：老剪贴板内容还能按「粘贴节点」处理，不影响新粘贴 */
const LEGACY_CLIP_MARK = "openarc-canvas-nodes:";
let clipMarkSynced = false;
export function copySelection(store: CanvasStore, quiet = false, toSystem = true) {
  if (!store.state.ui.sel.size) return;
  const sel = new Set(withStackMembers(store, [...store.state.ui.sel]));
  const nodes = store.state.doc.nodes.filter((n) => sel.has(n.id)); const edges = store.state.doc.edges.filter((e) => sel.has(e.from) && sel.has(e.to));
  clip = JSON.parse(JSON.stringify({ nodes, edges }));
  if (toSystem) {
    clipMarkSynced = false;
    try { void navigator.clipboard?.writeText(CLIP_MARK + uid("c")).then(() => { clipMarkSynced = true; }, () => undefined); } catch { /* 无剪贴板权限：退回旧行为 */ }
  }
  if (!quiet) store.toast(`已复制 ${nodes.length} 个节点`);
}
/** 系统粘贴事件（无文件时）：判断该贴节点还是把外部文字贴成文本节点 */
export function pasteFromSystem(store: CanvasStore, text: string, at: { x: number; y: number }) {
  const t = text.trim();
  if (!t || t.startsWith(CLIP_MARK) || t.startsWith(LEGACY_CLIP_MARK) || (clip && !clipMarkSynced)) { paste(store); return; }
  const n = store.newNode("text", at.x - 160, at.y - 90, { title: "粘贴的文本", hist: [{ text: t.slice(0, 20000) }], hi: 0, manual: true });
  store.addNodes([n], [], { select: true });
  store.toast("已把剪贴板文字贴成文本节点");
}
export function paste(store: CanvasStore, dx = 40) {
  if (!clip) return; const map: Record<string, string> = {};
  const edges = clip.edges.map((e) => ({ id: uid("e"), from: "", to: "", _old: e }));
  const nodes = clip.nodes.map((n) => { const c: CanvasNode = JSON.parse(JSON.stringify(n)); c.id = uid("n"); map[n.id] = c.id; c.x += dx; c.y += dx; return c; });
  const realEdges = edges.map((e) => ({ id: e.id, from: map[e._old.from], to: map[e._old.to] }));
  // 输入顺序里的旧 edge id 换成新的
  // 分组 / 堆叠的成员 id 换成新节点；没一起复制的成员去掉
  const remapped = nodes.map((c) => (c.children ? { ...c, children: c.children.map((x) => map[x]).filter(Boolean) } : c));
  const fixed = remapped.map((c) => (isGenKind(c.kind) ? withGen(c, { order: realEdges.filter((e) => e.to === c.id).map((e) => e.id) }) : c));
  store.mutate((d) => ({ ...d, nodes: [...d.nodes, ...fixed], edges: [...d.edges, ...realEdges] }), { history: true });
  const hidden = hiddenIds(fixed);
  store.setUI({ sel: new Set(fixed.filter((n) => !hidden.has(n.id)).map((n) => n.id)), edge: null });
}
export function duplicate(store: CanvasStore) { const keep = clip; copySelection(store, true, false); paste(store, 30); clip = keep; }

/** 读视频 / 音频的时长和宽高（读不到返回 null，不影响上传） */
function mediaMeta(src: string, kind: "video" | "audio"): Promise<{ dur: number; w: number; h: number } | null> {
  return new Promise((resolve) => {
    try {
      const el = document.createElement(kind); el.preload = "metadata"; el.muted = true;
      const done = (v: { dur: number; w: number; h: number } | null) => { el.removeAttribute("src"); resolve(v); };
      const timer = setTimeout(() => done(null), 8000);
      el.onloadedmetadata = () => { clearTimeout(timer); const d = Number(el.duration); done(Number.isFinite(d) && d > 0 ? { dur: d, w: kind === "video" ? (el as HTMLVideoElement).videoWidth : 0, h: kind === "video" ? (el as HTMLVideoElement).videoHeight : 0 } : null); };
      el.onerror = () => { clearTimeout(timer); done(null); };
      el.src = src;
    } catch { resolve(null); }
  });
}

/** 资源库导入失败时允许内嵌进文档的上限（字符数，约 1.5MB 文件） */
const INLINE_FALLBACK_MAX = 2 * 1024 * 1024;
export const MEDIA_UPLOAD_LIMIT = 200 * 1024 * 1024;

/** 上传媒体：新建节点，或填进指定节点，或作为某节点的输入 */
/** 文档上传（TapNow：文档作为文本输入）：纯文本类直接读，docx / xlsx 交给桌面端抽文本 */
// PDF 正文暂不能解析（主进程会如实拒绝），所以不在可选类型里；拖进来时按「不支持的文件」提示
const DOC_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|srt|vtt|log|docx|xlsx|xlsm)$/i;
const PLAIN_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|srt|vtt|log)$/i;
export const DOC_ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.srt,.vtt,.docx,.xlsx";
export const isDocument = (f: { name: string; type: string }) => DOC_EXT.test(f.name) || /^text\//.test(f.type) || f.type === "application/json";
export const DOC_MAX_CHARS = 60000;
export async function documentText(store: CanvasStore, f: File): Promise<{ text: string; truncated: boolean } | { error: string }> {
  if (f.size > 20 * 1024 * 1024) return { error: `${f.name} 超过 20MB，未添加` };
  if (PLAIN_EXT.test(f.name) || /^text\//.test(f.type) || f.type === "application/json") {
    const raw = await f.text().catch(() => null); if (raw == null) return { error: "读取失败：" + f.name };
    const text = raw.replace(/\0/g, "").trim(); return { text: text.slice(0, DOC_MAX_CHARS), truncated: text.length > DOC_MAX_CHARS };
  }
  if (!store.backend.extractDocument) return { error: `${f.name}：网页预览里只能读纯文本文档，docx / xlsx 请在桌面版上传` };
  const buf = await f.arrayBuffer().catch(() => null);
  if (!buf) return { error: "读取失败：" + f.name };
  const bytes = new Uint8Array(buf); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = await store.backend.extractDocument(`data:${f.type || "application/octet-stream"};base64,${btoa(bin)}`, f.name);
  if (!r.ok) return { error: `${f.name}：${r.detail || "无法读取正文"}` };
  return { text: r.text.slice(0, DOC_MAX_CHARS), truncated: r.truncated || r.text.length > DOC_MAX_CHARS };
}
async function addDocument(store: CanvasStore, f: File, at: { x: number; y: number }): Promise<string | null> {
  const r = await documentText(store, f);
  if ("error" in r) { store.toast(r.error, 6000); return null; }
  if (!r.text.trim()) { store.toast(`${f.name} 里没有可读的文字`); return null; }
  const name = f.name.replace(/\.[^.]+$/, "").slice(0, 24);
  const n = store.newNode("text", at.x - 160, at.y - 120, { title: name, manual: true, hist: [{ text: r.text, meta: { at: Date.now(), doc: f.name } }], w: 320, h: 240 });
  store.addNodes([n]);
  if (r.truncated) store.toast(`${f.name} 太长，只保留了前 ${DOC_MAX_CHARS} 字`, 5000);
  return n.id;
}

export async function addFiles(store: CanvasStore, files: File[], at: { x: number; y: number }, opts: { target?: string; linkTo?: string; replace?: string } = {}) {
  let dx = 0; const made: string[] = [];
  for (const f of files) {
    const kind: GenKind | null = f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : null;
    if (!kind && isDocument(f)) { const id = await addDocument(store, f, { x: at.x + dx, y: at.y }); if (id) { made.push(id); dx += 360; if (opts.linkTo && store.node(opts.linkTo)) connect(store, id, opts.linkTo, { quiet: true, select: false }); } continue; }
    if (!kind) { store.toast(/\.pdf$/i.test(f.name) ? `${f.name}：暂不能读取 PDF 正文，请另存为 docx 或文本后上传` : `不支持的文件：${f.name}`, 5000); continue; }
    if (f.size > MEDIA_UPLOAD_LIMIT) { store.toast(`${f.name} 超过 200MB，未添加`); continue; }
    // 图片先过一遍格式判定：直接传 / 浏览器转 PNG / 明确拒绝（三档规则见 imageUpload.ts）
    const plan = kind === "image" ? planImageUpload(f) : null;
    if (plan?.mode === "reject") { store.toast(`暂不支持 ${plan.format} 格式：${f.name}，请另存为 PNG/JPG 后上传`, 6000); continue; }
    let dataUrl = "";
    let uploadName = f.name;
    if (plan?.mode === "convert") {
      const png = await convertImageToPng(f);
      if (!png) { store.toast(`${f.name} 转成 PNG 失败，请另存为 PNG/JPG 后上传`, 6000); continue; }
      dataUrl = png.dataUrl; uploadName = plan.name;
    } else {
      dataUrl = await new Promise<string>((r, j) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.onerror = () => j(fr.error); fr.readAsDataURL(f); }).catch(() => "");
    }
    if (!dataUrl) { store.toast("读取失败：" + f.name); continue; }
    // 视频 / 音频读一下元数据：时长（使用区间、切镜要用）和视频宽高
    const meta = kind === "image" ? null : await mediaMeta(dataUrl, kind);
    const wh = kind === "image" ? await new Promise<[number, number]>((r) => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([1, 1]); im.src = dataUrl; }) : meta?.w && meta.h ? [meta.w, meta.h] : [16, 9];
    const dur = meta?.dur ? Math.round(meta.dur * 100) / 100 : undefined;
    const url = await store.backend.importAsset(store.state.canvasId, dataUrl, uploadName);
    // 桌面版存资源库失败时不把整段 data URL 写进画布文档（几十上百 MB 会拖垮保存与本机备份），只放行小图
    if (store.backend.kind === "bridge" && url.startsWith("data:") && url.length > INLINE_FALLBACK_MAX) { store.toast(`${f.name} 存入资源库失败，未添加（文件较大，不能内嵌进画布）`); continue; }
    const name = uploadName.replace(/\.[^.]+$/, "").slice(0, 24);
    // 「替换」：只换当前版本，节点本身不动（位置/尺寸/连线/提示词保留）
    if (opts.replace && store.node(opts.replace)) { replaceNodeMedia(store, opts.replace, { url, w: wh[0], h: wh[1], ...(dur ? { dur } : {}) }); continue; }
    if (opts.target && store.node(opts.target)) {
      const t = store.node(opts.target)!; const g = genOf(t);
      const box = kind === "image" ? refitNodeBox(t, wh[0], wh[1]) : null;
      store.updateNode(t.id, (n) => withGen({ ...n, ...(box ? { w: box.w, h: box.h } : {}) }, { hist: [...g.hist, { url, w: wh[0], h: wh[1], ...(dur ? { dur } : {}) }], hi: g.hist.length, uploaded: true }), { history: true });
      made.push(t.id); opts = { ...opts, target: undefined }; continue;
    }
    const box = kind === "image" ? fitSourceBox(wh[0], wh[1]) : kind === "video" && meta?.w && meta.h ? fitSourceBox(meta.w, meta.h, { baseW: 320 }) : null;
    const w = box?.w || (kind === "image" ? 240 : 320);
    const h = box?.h || (kind === "video" ? 180 : NODE_DEFAULT_SIZE.audio.h);
    const n = store.newNode(kind, at.x + dx - w / 2, at.y - h / 2, { title: name, uploaded: true, hist: [{ url, w: wh[0], h: wh[1], ...(dur ? { dur } : {}) }], w, h });
    store.addNodes([n]); made.push(n.id); dx += w + 30;
    if (opts.linkTo && store.node(opts.linkTo)) connect(store, n.id, opts.linkTo, { quiet: true, select: false });
  }
  if (opts.linkTo && store.node(opts.linkTo)) { store.setUI({ sel: new Set([opts.linkTo]) }); store.toast("已上传并连成输入"); return; }
  if (made.length) { store.setUI({ sel: new Set(made) }); store.toast(`已添加 ${made.length} 个文件`); }
}

/**
 * 「替换」：只换当前版本的媒体（url / 封帧 / 宽高），节点位置、尺寸、连线、提示词、参数都不动。
 */
export function replaceNodeMedia(store: CanvasStore, id: string, next: { url?: string; frame?: string; w?: number; h?: number; dur?: number }) {
  const n = store.node(id); if (!n || !next.url) return false;
  store.patchGen(id, (g) => ({
    hist: g.hist.map((h, i) => (i === g.hi ? { ...h, ...next, ...(n.kind === "video" && !next.frame ? { frame: h.frame || next.url } : {}) } : h)),
  }), { history: true });
  store.toast(`已替换「${title(n)}」的当前版本`);
  return true;
}

/** 把节点的所有历史版本铺开成独立节点 */
export function spreadHistory(store: CanvasStore, id: string) {
  const n = store.node(id)!; const g = genOf(n); const made: CanvasNode[] = [];
  g.hist.forEach((o, i) => { if (i === g.hi) return; made.push(withGen({ ...n, id: uid("n"), x: n.x + (made.length + 1) * (n.w + 30), data: undefined }, { ...g, params: cloneParams(g.params), title: g.title + " · 版本" + (i + 1), hist: [o], hi: 0, order: [] })); });
  store.addNodes(made, [], { select: true });
  store.toast(`已把 ${made.length} 个历史版本铺开成节点`);
}

/**
 * 把「当前版本」单独提成一个新节点：只带这一版（hist:[o], hi:0, order:[]，与 spreadHistory 同形状），
 * 放在原节点右侧（x + w + 30、y 对齐），标题「原标题 · 版本 n」；原节点完全不动。
 */
export function extractCurrentVersion(store: CanvasStore, id: string) {
  const n = store.node(id); if (!n) return null;
  const g = genOf(n); const o = g.hist[g.hi]; if (!o) return null;
  const made = withGen({ ...n, id: uid("n"), x: n.x + n.w + 30, y: n.y, data: undefined },
    { ...g, params: cloneParams(g.params), title: g.title + " · 版本 " + (g.hi + 1), hist: [o], hi: 0, order: [] });
  store.addNodes([made], [], { select: true });
  store.toast(`已提取版本 ${g.hi + 1} 为新节点`);
  return made;
}

/** 多选对齐：左边 / 顶边 / 水平等距（只改位置，不改尺寸） */
export function alignSelection(store: CanvasStore, mode: "left" | "top" | "hgap") {
  const nodes = [...store.state.ui.sel].map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
  if (nodes.length < 2) return;
  if (mode === "left") {
    const x = Math.min(...nodes.map((n) => n.x));
    nodes.forEach((n) => store.updateNode(n.id, (k) => ({ ...k, x })));
    store.toast(`已左对齐 ${nodes.length} 个节点`);
    return;
  }
  if (mode === "top") {
    const y = Math.min(...nodes.map((n) => n.y));
    nodes.forEach((n) => store.updateNode(n.id, (k) => ({ ...k, y })));
    store.toast(`已顶对齐 ${nodes.length} 个节点`);
    return;
  }
  const sorted = [...nodes].sort((a, b) => a.x - b.x);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const totalW = sorted.reduce((sum, n) => sum + n.w, 0);
  const gap = ((last.x + last.w) - first.x - totalW) / Math.max(1, sorted.length - 1);
  let cursor = first.x;
  sorted.forEach((n) => { const x = Math.round(cursor); store.updateNode(n.id, (k) => ({ ...k, x })); cursor += n.w + gap; });
  store.toast(`已水平等距 ${sorted.length} 个节点`);
}

/**
 * 多选一键排版：只对「自由」节点生效（分组本身和组员都不参与，免得把组框和成员拆开）。
 * 一次撤销：先 snapshot 再 mutate({history:false})，和 ungroup 同一套写法。
 */
export function layoutSelection(store: CanvasStore, mode: LayoutMode) {
  const doc = store.state.doc;
  const grouped = new Set<string>();
  for (const g of doc.nodes) if (g.kind === "group") (g.children || []).forEach((c) => grouped.add(c));
  const targets = [...store.state.ui.sel].map((id) => doc.nodes.find((n) => n.id === id))
    .filter((n): n is CanvasNode => !!n && n.kind !== "group" && !grouped.has(n.id));
  if (targets.length < 2) { store.toast("至少选中 2 个节点再排版"); return; }

  const ids = new Set(targets.map((n) => n.id));
  const inner = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const result = mode === "grid" ? computeGridLayout(targets, inner) : computeFlowLayout(targets, inner);
  const pos = new Map(result.positions.map((p) => [p.id, p]));
  const sides = new Map(result.edgeSides.map((s) => [s.id, s.fromSide]));

  store.snapshot();
  store.mutate((d) => ({
    ...d,
    nodes: d.nodes.map((n) => { const p = pos.get(n.id); return p ? { ...n, x: p.x, y: p.y } : n; }),
    edges: sides.size ? d.edges.map((e) => { const s = sides.get(e.id); return s ? { ...e, fromSide: s } : e; }) : d.edges,
  }), { history: false });
  store.toast(mode === "grid" ? `已按宫格排列 ${targets.length} 个节点` : `已按水平流排列 ${targets.length} 个节点`);
}

/**
 * 组内排版：排组员并把组框收紧到刚好包住（含 GROUP_PAD 留白）。
 * 复用多选排版的同一套算法；堆叠不是普通分组，直接不处理。
 */
export function layoutGroupMembers(store: CanvasStore, gid: string, mode: LayoutMode) {
  const group = store.node(gid);
  if (!isFrame(group)) return;
  const doc = store.state.doc;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const members = (group.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n && n.id !== group.id);
  if (members.length < 2) { store.toast("组里至少 2 个节点才能排版"); return; }

  const ids = new Set(members.map((n) => n.id));
  const inner = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const result = mode === "grid" ? computeGridLayout(members, inner) : computeFlowLayout(members, inner);
  const pos = new Map(result.positions.map((p) => [p.id, p]));
  const sides = new Map(result.edgeSides.map((s) => [s.id, s.fromSide]));
  const box = frameOf(members.map((n) => { const p = pos.get(n.id); return p ? { ...n, x: p.x, y: p.y } : n; }));
  // 组员可能是嵌套分组：它自己的成员要跟着整体平移，否则会被落在原地
  const shift = new Map<string, { dx: number; dy: number }>();
  for (const n of members) { const p = pos.get(n.id); if (!p) continue; const dx = p.x - n.x, dy = p.y - n.y; if (!dx && !dy) continue; for (const id of memberIdsDeep(doc, [n.id])) shift.set(id, { dx, dy }); }

  store.snapshot();
  store.mutate((d) => ({
    ...d,
    nodes: d.nodes.map((n) => {
      if (n.id === group.id) return { ...n, ...box };
      const p = pos.get(n.id); if (p) return { ...n, x: p.x, y: p.y };
      const s = shift.get(n.id); return s ? { ...n, x: n.x + s.dx, y: n.y + s.dy } : n;
    }),
    edges: sides.size ? d.edges.map((e) => { const s = sides.get(e.id); return s ? { ...e, fromSide: s } : e; }) : d.edges,
  }), { history: false });
  store.toast(mode === "grid" ? `已按宫格排列组内 ${members.length} 个节点` : `已按水平流排列组内 ${members.length} 个节点`);
}

/** 分组背景色（"" = 重置）；和排版一样只落一次撤销 */
export function setGroupColor(store: CanvasStore, gid: string, color: string) {
  const g = store.node(gid);
  if (!g || g.kind !== "group") return;
  store.snapshot();
  store.updateNode(gid, (n) => withGroupColor(n, color), { history: false });
  store.toast(color ? "已设置分组背景色" : "已重置分组背景色");
}

/** 双击文本节点直接书写后提交 */
export function commitText(store: CanvasStore, id: string, text: string) {
  const n = store.node(id); store.setUI({ editText: null }); if (!n) return;
  const g = genOf(n); const cur = g.hist[g.hi]?.text || "";
  if (cur === text) return;
  store.patchGen(id, { hist: [...g.hist.slice(0, Math.max(0, g.hist.length - (g.manual ? 1 : 0))), { text }], hi: Math.max(0, g.hist.length - (g.manual ? 1 : 0)), manual: true }, { history: true });
}
