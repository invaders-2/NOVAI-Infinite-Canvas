/**
 * 「优化提示词」：把节点自己的画面（已生成的图 / 视频帧）、上游节点（文字 / 图片 / 视频帧 / 音频）
 * 和用户写的提示词一起交给对话模型，改写成更适合「这个节点所选模型」的提示词。
 *
 * 纪律：
 *   · 只改写，不替用户换模型、不改参数；结果写回提示词框，⌘Z 可撤销；
 *   · @引用（@标题·段落 / @元素名）原样保留，不然改写后引用会断；
 *   · 对话模型看不了图时，只把图的标题告诉它，不假装看过；
 *   · 输出只要提示词本身：去掉代码块、引号、「优化后的提示词：」这类前缀。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { ROLE_LABEL, rolesFor } from "./engine";
import { genOf, inputsOf, outOf, srcOf, textOf, type AudioParams, type GenKind, type ImageParams, type ModelSpec, type TextParams, type VideoParams } from "./model";
import type { ChatMessage } from "./backend/types";
import type { CanvasStore } from "./store";
import { plainPrompt } from "./mentions";

export const OPTIMIZE_MARK = "【OpenArc 提示词优化】";
const MAX_IMAGES = 4;
const MAX_TEXT = 3000;

export type OptimizeSource = { title: string; kind: string; role?: string; text?: string; image?: string };
export type OptimizeContext = {
  kind: GenKind;
  model?: ModelSpec;
  params: Record<string, unknown>;
  prompt: string;
  /** 节点自己已有的画面（重新生成 / 在它基础上改时最有用） */
  own?: OptimizeSource;
  upstream: OptimizeSource[];
};

const TYPE_LABEL: Record<GenKind, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

/** 从画布读出优化需要的全部上下文 */
export function optimizeContext(store: CanvasStore, node: CanvasNode): OptimizeContext {
  const kind = node.kind as GenKind; const g = genOf(node); const m = store.modelOf(node);
  const ins = inputsOf(store.state.doc, node.id);
  const { roles, ignored } = rolesFor(kind, g.params, m, ins.filter((x) => x.node.kind !== "table"));
  const upstream: OptimizeSource[] = ins.map((x) => {
    const xk = x.node.kind; const o = outOf(x.node);
    const role = roles.get(x.edge.id); const skipped = ignored.has(x.edge.id);
    return {
      title: genOf(x.node).title || TYPE_LABEL[xk as GenKind] || xk,
      kind: xk,
      role: skipped ? "当前模型不会使用" : role ? ROLE_LABEL[role] : undefined,
      text: xk === "text" ? textOf(x.node).slice(0, MAX_TEXT) : xk === "table" ? "（表格：每行生成一次）" : undefined,
      image: xk === "image" ? srcOf(x.node) || undefined : xk === "video" ? o?.frame || undefined : undefined,
    };
  });
  const o = outOf(node);
  const own: OptimizeSource | undefined = kind === "image" && srcOf(node) ? { title: "当前节点已有的图片", kind, image: srcOf(node)! }
    : kind === "video" && o?.frame ? { title: "当前节点已有视频的画面", kind, image: o.frame }
      : kind === "text" && textOf(node).trim() ? { title: "当前节点已有的文字", kind, text: textOf(node).slice(0, MAX_TEXT) } : undefined;
  return { kind, model: m, params: g.params as unknown as Record<string, unknown>, prompt: plainPrompt(g.prompt, store.state.doc), own, upstream };
}

/** 选一个对话模型来改写：文本节点用它自己的模型；有图时优先能看图的；否则第一个文本模型 */
export function pickOptimizerModel(models: ModelSpec[], ctx: Pick<OptimizeContext, "kind" | "model">, needVision: boolean, preferId?: string | null): ModelSpec | undefined {
  const text = models.filter((x) => x.kind === "text");
  if (ctx.kind === "text" && ctx.model && (!needVision || ctx.model.vision)) return ctx.model;
  const pref = preferId ? text.find((x) => x.id === preferId) : undefined;
  if (pref && (!needVision || pref.vision)) return pref;
  return (needVision ? text.find((x) => x.vision) : undefined) || pref || (ctx.kind === "text" ? ctx.model : undefined) || text[0];
}

/** 按目标模型类型给改写要点 */
function guideFor(ctx: OptimizeContext): string {
  const m = ctx.model; const p = ctx.params;
  const name = m ? `${m.name}${m.vendor ? `（${m.vendor}）` : ""}` : "未选模型";
  const lines = [`目标：${TYPE_LABEL[ctx.kind]}生成，模型 ${name}。`];
  if (ctx.kind === "image") {
    const ip = p as unknown as ImageParams;
    lines.push(`画面比例 ${ip.ratio || "自适应"}，尺寸 ${ip.size || "默认"}。`);
    if (ip.style && ip.style !== "无") lines.push(`已选风格「${ip.style}」，由参数单独传给模型，提示词里不要再重复风格名，只写和它一致的画面细节。`);
    if (ip.camera?.on) lines.push("已开启摄影机参数，机身 / 镜头 / 焦段 / 光圈由参数传递，提示词里不要重复。");
    lines.push("写法：一段连贯的自然语言画面描述，按「主体与动作 → 场景与环境 → 构图与景别 → 光线与色调 → 质感与细节」组织；有参考图时写清楚每张参考图要保留什么（产品外观、人物长相、配色等）、要改什么；画面里要出现的文字用引号原样写出。");
  } else if (ctx.kind === "video") {
    const vp = p as unknown as VideoParams;
    lines.push(`模式「${vp.mode || "文生视频"}」，时长 ${vp.dur || "默认"} 秒，比例 ${vp.ratio || "默认"}${vp.sound ? "，同时生成声音" : ""}。`);
    lines.push("写法：按时间顺序写清楚主体动作和镜头运动（推 / 拉 / 摇 / 跟 / 环绕、景别变化），动作量要和时长匹配，不要塞太多事件；首尾帧模式写清楚从首帧怎样过渡到尾帧；图生视频不要重新描述参考图里已有的外观，重点写动起来的部分；需要声音时写清环境声或台词。");
  } else if (ctx.kind === "audio") {
    const ap = p as unknown as AudioParams;
    lines.push(`音频类型「${ap.kind || "音乐"}」，时长 ${ap.dur || "默认"}。`);
    lines.push("写法：音乐写清曲风、情绪、速度（BPM）、主要乐器、结构（前奏 / 主歌 / 副歌）；音效写清声源、空间感、远近与时长；配音 / 朗读时要念的文字一字不改，只补充音色、语气、语速。");
  } else {
    const tp = p as unknown as TextParams;
    lines.push(`输出形式「${tp.output || "text"}」。`);
    lines.push("写法：说清楚任务目标、读者、要用到哪些输入、输出结构（标题 / 列表 / 表格列）和字数，去掉含糊的说法。");
  }
  return lines.join("\n");
}

/** 组装发给对话模型的消息；images 是要附上的图（已去重、限量） */
export function buildOptimizeMessages(ctx: OptimizeContext, vision: boolean): { messages: ChatMessage[]; images: string[] } {
  const images: string[] = [];
  const addImg = (u?: string) => { if (!vision || !u || images.includes(u) || images.length >= MAX_IMAGES) return false; images.push(u); return true; };
  const describe = (s: OptimizeSource, label: string) => {
    const head = `【${label}：${s.title}】${TYPE_LABEL[s.kind as GenKind] || s.kind}${s.role ? ` · ${s.role}` : ""}`;
    const seen = s.image ? (addImg(s.image) ? `（见附图 ${images.length}）` : "（图片，未附上）") : "";
    return [head + seen, s.text ? s.text : ""].filter(Boolean).join("\n");
  };
  const parts: string[] = [];
  if (ctx.own) parts.push(describe(ctx.own, "当前节点"));
  ctx.upstream.forEach((s, i) => parts.push(describe(s, `输入 ${i + 1}`)));
  const system = [
    OPTIMIZE_MARK,
    "你是 AI 生成提示词专家。把用户的想法改写成能直接交给下面这个模型的提示词。",
    guideFor(ctx),
    "规则：",
    "1. 只输出改写后的提示词本身，不要解释、不要标题、不要引号或代码块。",
    "2. 保留用户的原意和所有具体要求；不要编造输入里没有的品牌、文字或数据。",
    "3. 形如 @标题·段落 或 @名字 的引用必须原样保留。",
    "4. 用户提示词是什么语言就用什么语言；为空时用中文。",
    "5. 结合附上的图片和上游内容，把它们具体化（例如写出参考图里产品的颜色、材质）。",
  ].join("\n");
  const user = [
    parts.length ? "画布上的输入：\n" + parts.join("\n\n") : "（没有上游输入）",
    ctx.prompt.trim() ? `用户的提示词：\n${ctx.prompt.trim()}` : "用户还没写提示词：请根据上面的输入写一条合适的提示词。",
  ].join("\n\n");
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], images };
}

/** 模型偶尔会加前缀 / 代码块 / 引号：剥掉 */
export function cleanOptimized(raw: string): string {
  let t = String(raw || "").trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  t = t.replace(/^(?:优化后的?提示词|改写后的?提示词|提示词|Optimized prompt|Prompt)\s*[:：]\s*/i, "").trim();
  if (/^["“「『].*["”」』]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/** 有没有东西可优化（提示词、自己的画面、上游都没有就不发请求） */
export function canOptimize(ctx: OptimizeContext): boolean {
  return !!(ctx.prompt.trim() || ctx.own || ctx.upstream.length);
}
