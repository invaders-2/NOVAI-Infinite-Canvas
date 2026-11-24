/**
 * 提示词里的 @ 引用（对齐 TapNow：在下游节点的提示词里 @ 上游节点）。
 *
 * 存储：提示词仍是一段纯文本，引用写成记号 `@{节点id}`，引用文本节点的一段写成 `@{节点id#海报1}`。
 * 编辑器把记号渲染成带缩略图的胶囊；发给模型前 resolveMentions() 把记号换成模型看得懂的文字
 * （图片 → 「图1」、视频 → 「视频1」、文本 → 原文），其它地方显示时用 plainPrompt() 换成「@标题」。
 *
 * 引用模式（gen.refMode = "mention"）：节点里插入过引用后，只有提示词里 @ 到的上游才会发送，
 * 已连接但没被 @ 的输入在面板里变灰并提示。旧画布没有这个标记，行为不变（所有连线都发送）。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { expandGroupInputs, genOf, inputsOf, isGenKind, outOf, sectionsOf, textOf, type GenKind, type GenOutput, type InputRef } from "./model";

export const MENTION_RE = /@\{([A-Za-z0-9_-]+)(?:#([^}\n]{1,40}))?\}/g;
export type Mention = { id: string; section?: string; start: number; end: number; raw: string };

export const mentionToken = (id: string, section?: string) => "@{" + id + (section ? "#" + section : "") + "}";

/** 把提示词里的 @原节点（含 #段落）换成 @新节点；用于复制出结果节点时保留「@本节点」语义 */
export function remapMention(prompt: string, from: string, to: string): string {
  if (!prompt || !from || !to || from === to) return prompt || "";
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.replace(new RegExp("@" + "\\{" + esc + "(#[^}\\n]*)?\\}", "g"), (_m, sec) => "@{" + to + (sec || "") + "}");
}



export function parseMentions(prompt: string): Mention[] {
  const out: Mention[] = []; const re = new RegExp(MENTION_RE.source, "g"); let m: RegExpExecArray | null;
  while ((m = re.exec(prompt || ""))) out.push({ id: m[1], section: m[2] || undefined, start: m.index, end: m.index + m[0].length, raw: m[0] });
  return out;
}
export const mentionedIds = (prompt: string) => new Set(parseMentions(prompt).map((m) => m.id));
export const hasMentions = (prompt: string) => parseMentions(prompt).length > 0;

/** 能被 @ 的上游：生成类节点（图片 / 视频 / 音频 / 文本）或整个分组；表格走自己的逻辑 */
export const mentionable = (n: CanvasNode | undefined) => !!n && (isGenKind(n.kind) || n.kind === "group");

const nodeTitle = (n: CanvasNode) => (isGenKind(n.kind) ? genOf(n).title : n.text || n.kind);
/** 显示用：记号换成「@标题」或「@标题·海报1」（找不到节点时保留「@已删除节点」） */
export function plainPrompt(prompt: string, doc: CanvasDoc | { nodes: CanvasNode[] }): string {
  if (!prompt || prompt.indexOf("@{") < 0) return prompt || "";
  return prompt.replace(new RegExp(MENTION_RE.source, "g"), (_s, id: string, sec?: string) => {
    const n = doc.nodes.find((x) => x.id === id);
    return "@" + (n ? nodeTitle(n) : "已删除节点") + (sec ? "·" + sec : "");
  });
}

/** 同类上游的编号：第几张图 / 第几段视频…（按连线顺序，从 1 起）——胶囊角标与发给模型的「图1」一致 */
export function kindIndex(ins: InputRef[], nodeId: string): number {
  const hit = ins.find((x) => x.node.id === nodeId); if (!hit) return 0;
  return ins.filter((x) => x.node.kind === hit.node.kind).findIndex((x) => x.node.id === nodeId) + 1;
}
export const KIND_SHORT: Record<GenKind, string> = { image: "图", video: "视频", audio: "音频", text: "文本" };

/**
 * 能「@ 本节点」的节点：图片 / 视频，且有当前结果（把本节点当前结果当参考图 / 参考视频发出去）。
 * 文本自引用没意义、音频还不支持当参考，都不给入口。伪 InputRef 的边 id 用 "self:"+节点 id，
 * 它不对应文档里任何一条连线（删胶囊只改提示词文本，不会去删边）。
 */
export function selfRefOf(node: CanvasNode): InputRef | null {
  if (node.kind !== "image" && node.kind !== "video") return null;
  if (!outOf(node)?.url) return null;
  return { edge: { id: "self:" + node.id, from: node.id, to: node.id }, node, order: -1 };
}

/**
 * 「@ 本节点」这一版能发出去的那张图 / 视频（三态，调用方必须区分）：
 *   string    —— 生成这一版时实际发出去的那张源图，重新生成继续用它；
 *   null      —— 生成这一版时明确没有自我参考图（节点当时还没有结果 / 模型不收），重新生成也不要补上一版结果；
 *   undefined —— 旧数据（这次改动之前生成的版本，meta 里没有 selfSrc），维持原来的回退：
 *                上传的图被原地覆盖过时退回最初上传的那张（hist[0]），其余用当前这一版的结果。
 * 不拿新生成的结果再喂回去，否则原地重新生成（画布助手审查后改提示词重跑）会越改越偏、永远改不掉。
 * 用户把版本切回没有记录的那一版（比如最初上传的图）时，按上面的旧回退发那一版。
 */
export function selfSourceOf(node: CanvasNode): string | null | undefined {
  const cur = outOf(node); if (!cur) return undefined;
  const own = cur.url || (node.kind === "video" ? cur.frame : undefined);
  if (cur.meta && cur.meta.selfSrc !== undefined) return cur.meta.selfSrc || null;
  const g = genOf(node);
  if (g.uploaded && g.hi > 0 && g.hist[0]?.url) return g.hist[0].url;
  return own;
}

/* ---------- 重新生成时带哪张「本节点参考」：只带原始素材（产品规则 R1/R2） ---------- */
/**
 * 一个版本是不是模型生成的：后端回来的结果带 meta.runId；上传 / 拖入 / 外部导入 / 本地编辑产物都没有。
 * 产品规则：模型生成的上一版结果不再自动当参考图，只有「原始素材」才自动带上。
 */
export function isModelVersion(o: GenOutput | null | undefined): boolean {
  const runId = o?.meta?.runId;
  return typeof runId === "string" && !!runId;
}

const normPrompt = (s: unknown) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/**
 * 当前提示词是否和「出这一版时用的提示词」一样（按空白归一）。
 * meta.prompt 缺失 = 这次改动之前的旧数据：判成「改过」，维持原来的迭代手感（旧画布行为不变）。
 */
export function samePromptAsVersion(version: GenOutput | null | undefined, prompt: string): boolean {
  const recorded = version?.meta?.prompt;
  return typeof recorded === "string" && normPrompt(recorded) === normPrompt(prompt);
}

/** 结果节点的来源节点（data.sourceNodeId）；没有就是空串 */
export function sourceIdOf(node: CanvasNode | undefined): string {
  const id = node && node.data && typeof node.data === "object" ? (node.data as { sourceNodeId?: unknown }).sourceNodeId : undefined;
  return typeof id === "string" ? id : "";
}

/** 沿 data.sourceNodeId 往回找到最初的源节点（防环：链上重复出现就停在那里） */
export function rootOriginOf(doc: CanvasDoc, node: CanvasNode): CanvasNode {
  let cur = node; const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const upId = sourceIdOf(cur);
    const up = upId ? doc.nodes.find((n) => n.id === upId) : undefined;
    if (!up) return cur;
    cur = up;
  }
  return cur;
}

/** 上传节点最初的那张素材（hist[0] 不是模型生成时用它）；拿不到就是 undefined */
function uploadOriginOf(node: CanvasNode): string | undefined {
  const first = genOf(node).hist[0];
  if (!first || isModelVersion(first)) return undefined;
  return first.url || (node.kind === "video" ? first.frame : undefined);
}

/**
 * 用户最初放上画布的那张素材（上传 / 拖入 / 外部导入 / 本地编辑产物），没有就 null。
 *   · 根节点是上传素材 → 最初上传的那张（上传后原地改过也回到 hist[0]）；
 *   · 根节点当前版本不是模型生成的（没有 runId）→ 那一版本身就是素材；
 *   · 根节点就是模型生成的图 → 没有原始素材，返回 null（不带上一版结果）。
 */
export function materialUrlOf(doc: CanvasDoc, node: CanvasNode): string | null {
  if (!node) return null;
  const root = rootOriginOf(doc, node);
  const g = genOf(root);
  // 上传素材一直回到最初那张：原地重生成过、当前版记了 selfSrc=null 时 selfSourceOf 会返回 null，hist[0] 兜住
  if (g.uploaded) return uploadOriginOf(root) || selfSourceOf(root) || null;
  const cur = outOf(root);
  if (!cur || isModelVersion(cur)) return null;
  return cur.url || (root.kind === "video" ? cur.frame : undefined) || null;
}

/** 本地运行历史里用到的字段（store.ts 的 RunLog；纯模块不 import store，只取这几项） */
type RunRow = { node?: unknown; type?: unknown; status?: unknown; prompt?: unknown };

/**
 * 老数据（出这一版时还没记录 meta.prompt）的兜底：看本地运行历史。
 * 历史里这个节点最近一次成功生成用的提示词和当前提示词一致 = 同一条流水线重抽 → 不该带上一版结果；
 * 提示词不同 / 查不到记录 = 维持原回退（判成「改过」），老画布的迭代手感不变。
 * 只用在这个节点「没有 meta.prompt」的时候，新版本有记录就不会走到这里。
 */
export function legacyPromptUnchanged(runs: RunRow[] | undefined | null, doc: CanvasDoc, node: CanvasNode): boolean {
  const list = Array.isArray(runs) ? runs : [];
  const hit = list.find((r) => r && r.node === node.id && (r.type === "image" || r.type === "video") && r.status === "done" && typeof r.prompt === "string" && !!String(r.prompt).trim());
  if (!hit) return false;
  const then = normPrompt(hit.prompt);
  if (!then) return false;
  // 历史里的提示词记录的是显示口径（@{id} 已换成 @标题）
  const now = normPrompt(plainPrompt(genOf(node).prompt, doc));
  if (then === now) return true;
  // 历史只留前 500 字（store.compactRun 截断）：当前提示词是它的延长版时仍算同一条
  return String(hit.prompt).length >= 500 && now.startsWith(then);
}

/**
 * 这次生成自动带上的「本节点参考」（没 @ 本节点、不是表格行时用它）：
 *   1) 提示词显式 @ 了本节点 → 这一版记录的源图（既有能力，不变）；
 *   2) 上传素材 → 最初上传的那张（一直带，不随生成次数漂移）；
 *   3) 提示词相对出这一版时改过 → 当前这一版当第一参考（保留迭代手感）；老数据用运行历史判断；
 *   4) 其余 → 原始素材（materialUrlOf）；没有原始素材就是 null，不带上一版结果。
 */
export function autoSelfUrl(store: { state: { doc: CanvasDoc; runs?: RunRow[] } }, node: CanvasNode): string | null {
  if (!node) return null;
  const g = genOf(node);
  if ((node.kind === "image" || node.kind === "video") && mentionedIds(g.prompt).has(node.id)) return selfSourceOf(node) || null;
  if (g.uploaded) return materialUrlOf(store.state.doc, node);
  const cur = outOf(node);
  const curUrl = cur ? (cur.url || (node.kind === "video" ? cur.frame : undefined)) : undefined;
  if (curUrl) {
    // 这一版记录了出图时的提示词：按记录判断改没改；老数据没有记录，用本地运行历史兜底（否则「第一次还是像」）
    const unchanged = typeof cur?.meta?.prompt === "string" ? samePromptAsVersion(cur, g.prompt) : legacyPromptUnchanged(store.state.runs, store.state.doc, node);
    if (!unchanged) return curUrl;
  }
  return materialUrlOf(store.state.doc, node);
}

/**
 * 一个节点自己的输入，沿它的 sourceNodeId 链展开（来源节点是结果节点时继续往上走），按节点去重。
 * 「结果节点 → 它的来源」这条边只表示来源，不发送；发送的是来源节点真正连着的那些输入。
 */
export function sourceInputsOf(doc: CanvasDoc, id: string, seen: Set<string> = new Set()): InputRef[] {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || seen.has(id)) return [];
  seen.add(id);
  const src = sourceIdOf(node);
  // 这个节点自己标了 keepSourceInput（出成片 / 重拍 / 延长）：它的来源是真实输入，继续往下展开会把它弄丢
  const keep = (node.data as { keepSourceInput?: unknown } | undefined)?.keepSourceInput === true;
  const own = node.kind === "text" ? inputsOf(doc, id) : expandGroupInputs(doc, inputsOf(doc, id));
  const out: InputRef[] = []; const used = new Set<string>();
  const push = (x: InputRef) => { if (used.has(x.node.id)) return; used.add(x.node.id); out.push(x); };
  for (const x of own) {
    if (src && !keep && x.node.id === src) { for (const up of sourceInputsOf(doc, src, seen)) push(up); continue; }
    push(x);
  }
  return out;
}

/** 请求组装用：来源连线不发送，改成来源节点自己的输入（原位替换、按节点去重） */
export function replaceSourceInput(doc: CanvasDoc, inputs: InputRef[], sourceId: string): InputRef[] {
  if (!sourceId || !inputs.some((x) => x.node.id === sourceId)) return inputs;
  const out: InputRef[] = []; const used = new Set<string>();
  const push = (x: InputRef) => { if (used.has(x.node.id)) return; used.add(x.node.id); out.push(x); };
  for (const x of inputs) {
    if (x.node.id === sourceId) { for (const up of sourceInputsOf(doc, sourceId)) push(up); continue; }
    push(x);
  }
  return out;
}

/** 引用模式下没被 @ 的输入（不发送）；分组被整体 @ 时保留全部组员，只 @ 组员时保留该组员。 */
export function unmentionedInputs(node: CanvasNode, ins: InputRef[], directIns: InputRef[] = ins): Set<string> {
  const g = genOf(node); const out = new Set<string>();
  if (g.refMode !== "mention") return out;
  const ids = mentionedIds(g.prompt);
  // 「@ 本节点」是自引用，不算引用过上游：只 @ 了自己时已连接的输入照旧全部发送，
  // 否则用户只是想带上自己上一版结果，却把连好的上游全丢了。
  ids.delete(node.id);
  // 引用模式只在提示词里真的还 @ 着上游时成立：@ 被删光（整段改写提示词 / 复制节点带过来的残留标记）时
  // 已连接的输入照旧全部发送，否则面板上明明连了、点生成却什么都不读。
  if (!ids.size) return out;
  const groups = directIns.filter((x) => x.node.kind === "group");
  for (const x of ins) {
    if (x.node.kind === "group") {
      if (!ids.has(x.node.id) && !(x.node.children || []).some((id) => ids.has(id))) out.add(x.edge.id);
      continue;
    }
    if (!mentionable(x.node) || ids.has(x.node.id)) continue;
    const parent = groups.find((p) => x.edge.id.startsWith(p.edge.id + ":"));
    if (!parent || !ids.has(parent.node.id)) out.add(x.edge.id);
  }
  return out;
}

export type SentRef = { nodeId: string; kind: GenKind; role?: string };
const sentLabel = (sent: SentRef[], s: SentRef) => {
  const role = s.role === "first_frame" ? "首帧图" : s.role === "last_frame" ? "尾帧图" : s.role === "portrait" ? "人像图" : s.role === "source_video" ? "源视频" : s.role === "driving_audio" ? "驱动音频" : "";
  if (role) return `「${role}」`;
  const idx = sent.filter((x) => x.kind === s.kind).findIndex((x) => x.nodeId === s.nodeId) + 1;
  return `「${KIND_SHORT[s.kind]}${idx}」`;
};
/**
 * 发给模型前把记号换成文字。sent = 这次真正发送的输入（顺序即编号）：
 * 图片 → 「图N」（首帧 / 尾帧 / 人像按角色）、视频 → 「视频N」、音频 → 「音频N」、文本 → 原文（或其中一段）。
 * 分组 → 按发送顺序列出组内素材。没发送的（断开 / 模型不收）退回成「标题」。
 */
export function resolveMentions(prompt: string, doc: CanvasDoc, sent: SentRef[]): { text: string; usedText: Set<string> } {
  const usedText = new Set<string>();
  if (!prompt || prompt.indexOf("@{") < 0) return { text: prompt || "", usedText };
  const text = prompt.replace(new RegExp(MENTION_RE.source, "g"), (_s, id: string, sec?: string) => {
    const n = doc.nodes.find((x) => x.id === id); if (!n) return "";
    const t = nodeTitle(n);
    if (n.kind === "text") {
      usedText.add(id);
      const body = sec ? sectionsOf(textOf(n))[sec] : textOf(n);
      return body && body.trim() ? `「${body.trim()}」` : `「${t}」`;
    }
    if (n.kind === "group") {
      const refs = (n.children || []).map((child) => sent.find((x) => x.nodeId === child)).filter((x): x is SentRef => !!x);
      return refs.length ? refs.map((x) => sentLabel(sent, x)).join("、") : `「${t}」`;
    }
    const s = sent.find((x) => x.nodeId === id);
    return s ? sentLabel(sent, s) : `「${t}」`;
  });
  return { text: text.replace(/[ \t]{2,}/g, " "), usedText };
}

/** 在末尾补上引用（已经有了就不重复）；返回新提示词 */
export function appendMention(prompt: string, id: string, section?: string): string {
  if (parseMentions(prompt).some((m) => m.id === id && (m.section || "") === (section || ""))) return prompt;
  const tok = mentionToken(id, section);
  return prompt ? prompt.replace(/\s*$/, "") + " " + tok + " " : tok + " ";
}

/** plainPrompt 的反向：模型改写回来的「@标题」按上游节点标题换回记号（长标题优先，避免前缀误配） */
export function relinkMentions(text: string, nodes: CanvasNode[]): string {
  if (!text || text.indexOf("@") < 0) return text;
  const list = nodes.filter(mentionable).map((n) => ({ id: n.id, t: nodeTitle(n) })).filter((x) => x.t).sort((a, b) => b.t.length - a.t.length);
  let out = ""; let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && text[i + 1] !== "{") {
      const hit = list.find((x) => text.startsWith(x.t, i + 1));
      if (hit) {
        let j = i + 1 + hit.t.length; let sec = "";
        const sm = /^·((?:海报|镜头|方案)\d)/.exec(text.slice(j)); if (sm) { sec = sm[1]; j += sm[0].length; }
        out += mentionToken(hit.id, sec || undefined); i = j; continue;
      }
    }
    out += text[i]; i++;
  }
  return out;
}
