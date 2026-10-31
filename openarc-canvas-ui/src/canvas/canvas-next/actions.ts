/** 画布上的编辑动作（连线、删除、复制粘贴、上传……），界面和 Agent 共用 */
import type { CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import { autoVideoMode, connectBlock, genOf, inputsOf, isGenKind, NODE_DEFAULT_SIZE, uid, withGen, type GenKind, type TextParams, type VideoParams } from "./model";
import type { CanvasStore } from "./store";
import { appendMention, mentionable } from "./mentions";
import { tableAutoSize, tableMedia, tableOf } from "./table";
import { hiddenIds, isStack } from "./stack";

/** 连线；成功后选中下游节点，并按输入自动切换视频生成方式 */
export function connect(store: CanvasStore, from: string, to: string, opts: { quiet?: boolean; select?: boolean } = {}): CanvasEdge | null {
  const block = connectBlock(store.state.doc, from, to);
  if (block) { if (!opts.quiet) store.toast(block); return null; }
  const e = store.addEdge(from, to);
  // TapNow：连上的上游自动出现在下游提示词里（@ 引用胶囊）
  if (isGenKind(store.node(to)?.kind || "") && mentionable(store.node(from))) addMention(store, to, from);
  afterInputsChanged(store, to);
  if (opts.select !== false) store.setUI({ sel: new Set([to]), edge: null });
  if (!opts.quiet) { const a = store.node(from)!, b = store.node(to)!; store.toast(`已连接：「${title(a)}」作为「${title(b)}」的第 ${inputsOf(store.state.doc, to).length} 个输入`); }
  return e;
}
/**
 * 在节点提示词里加一个 @ 引用。第一次加时切到「引用模式」：先把已经连着的上游都补成引用，
 * 这样旧节点原本会发送的输入不会因为切换而丢掉。
 */
export function addMention(store: CanvasStore, id: string, ref: string, section?: string) {
  const n = store.node(id); if (!n || !isGenKind(n.kind)) return;
  store.patchGen(id, (g) => {
    let prompt = g.prompt;
    if (g.refMode !== "mention") for (const x of inputsOf(store.state.doc, id)) if (x.node.id !== ref && mentionable(x.node)) prompt = appendMention(prompt, x.node.id);
    return { prompt: appendMention(prompt, ref, section), refMode: "mention" };
  });
}
export const title = (n: CanvasNode) => (isGenKind(n.kind) ? genOf(n).title : n.kind === "table" ? tableOf(n).title : n.text || n.kind);

/** 输入变化后的联动：视频节点自动选生成方式；表格自动调尺寸 */
export function afterInputsChanged(store: CanvasStore, id: string) {
  const n = store.node(id); if (!n) return;
  if (n.kind === "video") { const m = store.modelOf(n); if (m) { const mode = autoVideoMode(store.state.doc, id, m); if (mode && mode !== (genOf(n).params as VideoParams).mode) store.patchGen(id, (g) => ({ params: { ...(g.params as VideoParams), mode } })); } }
  // 文本节点连进分组：输出还是「文本」时切到「多维表格」，出表按提示词区分图片 / 视频任务
  if (n.kind === "text" && inputsOf(store.state.doc, id).some((x) => x.node.kind === "group")) { const tp = genOf(n).params as TextParams; if (!tp.output || tp.output === "text") { store.patchGen(id, (g) => ({ params: { ...(g.params as TextParams), output: "table" } })); store.toast("已把输出切到「多维表格」：出表时按提示词区分图片 / 视频任务，并把组内素材逐行放进对应列"); } }
  if (n.kind === "table") { const s = tableAutoSize(tableOf(n), tableMedia(store.state.doc, id).length ? 1 : 0); if (s.w > n.w) store.updateNode(id, (x) => ({ ...x, w: s.w })); }
}

export function deleteSelection(store: CanvasStore) {
  const { ui } = store.state;
  if (ui.edge) { const e = store.state.doc.edges.find((x) => x.id === ui.edge); store.removeEdge(ui.edge); store.setUI({ edge: null }); if (e) afterInputsChanged(store, e.to); return; }
  if (!ui.sel.size) return;
  // 删除堆叠 = 连同叠里的节点一起删（分组只删框，组内节点留在画布上）
  const ids = withStackMembers(store, [...ui.sel]); const gone = new Set(ids);
  const touched = [...new Set(store.state.doc.edges.filter((e) => gone.has(e.from) && !gone.has(e.to)).map((e) => e.to))];
  store.removeNodes(ids); touched.forEach((t) => afterInputsChanged(store, t));
  store.toast(`已删除 ${ids.length} 个节点 · ⌘Z 撤销`);
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
const CLIP_MARK = "openarc-canvas-nodes:";
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
  if (!t || t.startsWith(CLIP_MARK) || (clip && !clipMarkSynced)) { paste(store); return; }
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
    const dataUrl = await new Promise<string>((r, j) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.onerror = () => j(fr.error); fr.readAsDataURL(f); }).catch(() => "");
    if (!dataUrl) { store.toast("读取失败：" + f.name); continue; }
    // 视频 / 音频读一下元数据：时长（使用区间、切镜要用）和视频宽高
    const meta = kind === "image" ? null : await mediaMeta(dataUrl, kind);
    const wh = kind === "image" ? await new Promise<[number, number]>((r) => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([1, 1]); im.src = dataUrl; }) : meta?.w && meta.h ? [meta.w, meta.h] : [16, 9];
    const dur = meta?.dur ? Math.round(meta.dur * 100) / 100 : undefined;
    const url = await store.backend.importAsset(store.state.canvasId, dataUrl, f.name);
    // 桌面版存资源库失败时不把整段 data URL 写进画布文档（几十上百 MB 会拖垮保存与本机备份），只放行小图
    if (store.backend.kind === "bridge" && url.startsWith("data:") && url.length > INLINE_FALLBACK_MAX) { store.toast(`${f.name} 存入资源库失败，未添加（文件较大，不能内嵌进画布）`); continue; }
    const name = f.name.replace(/\.[^.]+$/, "").slice(0, 24);
    // 「替换」：只换当前版本，节点本身不动（位置/尺寸/连线/提示词保留）
    if (opts.replace && store.node(opts.replace)) { replaceNodeMedia(store, opts.replace, { url, w: wh[0], h: wh[1], ...(dur ? { dur } : {}) }); continue; }
    if (opts.target && store.node(opts.target)) {
      const t = store.node(opts.target)!; const g = genOf(t);
      store.updateNode(t.id, (n) => withGen({ ...n, h: kind === "image" ? Math.round(Math.max(100, Math.min(520, n.w * wh[1] / wh[0]))) : n.h }, { hist: [...g.hist, { url, w: wh[0], h: wh[1], ...(dur ? { dur } : {}) }], hi: g.hist.length, uploaded: true }), { history: true });
      made.push(t.id); opts = { ...opts, target: undefined }; continue;
    }
    const w = kind === "image" ? 240 : 320; const h = kind === "image" ? Math.round(Math.max(100, Math.min(520, w * wh[1] / wh[0]))) : kind === "video" ? (meta?.w && meta.h ? Math.round(Math.max(100, Math.min(520, w * meta.h / meta.w))) : 180) : NODE_DEFAULT_SIZE.audio.h;
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
  g.hist.forEach((o, i) => { if (i === g.hi) return; made.push(withGen({ ...n, id: uid("n"), x: n.x + (made.length + 1) * (n.w + 30), data: undefined }, { ...g, title: g.title + " · 版本" + (i + 1), hist: [o], hi: 0, order: [] })); });
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
    { ...g, title: g.title + " · 版本 " + (g.hi + 1), hist: [o], hi: 0, order: [] });
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

/** 双击文本节点直接书写后提交 */
export function commitText(store: CanvasStore, id: string, text: string) {
  const n = store.node(id); store.setUI({ editText: null }); if (!n) return;
  const g = genOf(n); const cur = g.hist[g.hi]?.text || "";
  if (cur === text) return;
  store.patchGen(id, { hist: [...g.hist.slice(0, Math.max(0, g.hist.length - (g.manual ? 1 : 0))), { text }], hi: Math.max(0, g.hist.length - (g.manual ? 1 : 0)), manual: true }, { history: true });
}
