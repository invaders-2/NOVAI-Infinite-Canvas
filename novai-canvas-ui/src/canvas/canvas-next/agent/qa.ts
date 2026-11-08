/**
 * Agent 问答卡（TapNow：需求不清楚时，Agent 先抛出最多 4 个带选项的问题，答完再继续）。
 *
 * 运行时约定：Agent 回复里放一个 ```novai-questions 代码块，内容是 JSON 数组
 * （升级前会话里存的是 ```openarc-questions，解析两种都认；历史对话不迁移）
 *   [{ "question": "用在哪里？", "options": ["小红书封面", "电商主图"], "multi": false }]
 * 面板把它渲染成问答卡，代码块本身不显示。用户回答后，问答拼成一条新消息继续对话。
 * 运行时那边的提示词见 electron/task-harness-orchestrator.cjs（thinking / 问答协议）。
 * 没有任务运行时（浏览器预览）时，clarifyQuestions 用规则给常见的模糊需求补问题。
 */
import type { ThinkingLevel } from "./state";

export type QaQuestion = { q: string; options: string[]; multi?: boolean };
/** kind：ask = 动手前先问清楚（默认）；confirm = 结果出来后问「是否符合要求 / 哪里不满意」 */
export type QaKind = "ask" | "confirm";
/** 审查后一键重生成的一项：后端给修订提示词 / 问题清单；ok=false 的才是要重做的 */
export type QaRegenItem = { node_id: string; label: string; kind: string; prompt: string; issues: string[]; ok?: boolean };
/** 结果确认卡上的「重新生成」清单（空 = 没有不合格项，不显示重生成入口） */
export type QaRegen = { items: QaRegenItem[] };
export type QaCard = { goal: string; questions: QaQuestion[]; picks: string[][]; other: string[]; status: "open" | "answered" | "skipped"; kind?: QaKind; regen?: QaRegen };
/** 后端没标 kind 时按第一题兜底识别「结果确认」类问题 */
const CONFIRM_Q = /符合.{0,8}要求|满意|对口|可以吗|没问题吗/;

export const QA_MAX = 4;
const BLOCK = /```(?:novai|openarc)-questions\s*\n?([\s\S]*?)```/i;
const clean = (v: unknown, max: number) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** 后端 /api/agent/regenerate 一次最多收 8 项（多余的它自己会丢） */
const REGEN_MAX = 8;
const REGEN_KINDS = new Set(["image", "video", "timeline", "audio", "text"]);
/** 结果确认块里的 regenerate：要重做的结果清单；node_id 为空的丢掉，其余字段截长 / 净化 */
function parseRegen(raw: unknown): QaRegen | undefined {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
  if (!list) return undefined;
  const items: QaRegenItem[] = [];
  for (const it of list) {
    if (items.length >= REGEN_MAX) break;
    const o = it && typeof it === "object" ? (it as { node_id?: unknown; label?: unknown; kind?: unknown; prompt?: unknown; issues?: unknown; ok?: unknown }) : null;
    const nodeId = clean(o?.node_id, 80);
    if (!nodeId) continue;
    const kind = String(o?.kind == null ? "" : o.kind);
    items.push({
      node_id: nodeId,
      label: clean(o?.label, 60) || "未命名结果",
      kind: REGEN_KINDS.has(kind) ? kind : "",
      prompt: clean(o?.prompt, 1200),
      issues: Array.isArray(o?.issues) ? o.issues.map((x) => clean(x, 80)).filter(Boolean).slice(0, 6) : [],
      ...(typeof o?.ok === "boolean" ? { ok: o.ok } : {}),
    });
  }
  return items.length ? { items } : undefined;
}

/** 从回复里取出问题块；没有或格式不对返回 null（原文照常显示） */
export function parseQuestions(text: string): { rest: string; questions: QaQuestion[]; kind: QaKind; regen?: QaRegen } | null {
  const m = BLOCK.exec(String(text || "")); if (!m) return null;
  let raw: unknown; try { raw = JSON.parse(m[1]); } catch { return null; }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions) ? (raw as { questions: unknown[] }).questions : null;
  if (!list) return null;
  const questions: QaQuestion[] = [];
  for (const it of list) {
    if (questions.length >= QA_MAX) break;
    const o = (it && typeof it === "object" ? it : { question: it }) as { question?: unknown; q?: unknown; options?: unknown; multi?: unknown };
    const q = clean(o.question ?? o.q, 120); if (!q) continue;
    const options = Array.isArray(o.options) ? [...new Set(o.options.map((x) => clean(x, 40)).filter(Boolean))].slice(0, 6) : [];
    questions.push({ q, options, ...(o.multi === true ? { multi: true } : {}) });
  }
  if (!questions.length) return null;
  const marked = raw && typeof raw === "object" && !Array.isArray(raw) ? String((raw as { kind?: unknown }).kind || "") : "";
  const kind: QaKind = marked === "confirm" || (!marked && CONFIRM_Q.test(questions[0].q)) ? "confirm" : "ask";
  const regen = raw && typeof raw === "object" && !Array.isArray(raw) ? parseRegen((raw as { regenerate?: unknown }).regenerate) : undefined;
  return { rest: String(text).replace(BLOCK, "").trim(), questions, kind, ...(regen ? { regen } : {}) };
}

export function newCard(goal: string, questions: QaQuestion[], kind: QaKind = "ask", regen?: QaRegen): QaCard {
  const qs = questions.slice(0, QA_MAX);
  return { goal, questions: qs, picks: qs.map(() => []), other: qs.map(() => ""), status: "open", kind, ...(regen && regen.items.length ? { regen } : {}) };
}

/** 要重做哪几项：卡里标了 ok=false 的优先，其次对上审查卡里不合格的节点，都没有就全部 */
export function regenTargets(card: QaCard, reviewItems: Array<{ node_id: string; ok: boolean }> = []): QaRegenItem[] {
  const items = card.regen?.items || [];
  const marked = items.filter((it) => it.ok === false);
  if (marked.length) return marked;
  const bad = new Set(reviewItems.filter((it) => !it.ok).map((it) => String(it.node_id || "")));
  const fromReview = items.filter((it) => bad.has(it.node_id));
  return fromReview.length ? fromReview : items;
}

export function togglePick(card: QaCard, qi: number, opt: string): QaCard {
  const q = card.questions[qi]; if (!q) return card;
  const cur = card.picks[qi] || [];
  const next = cur.includes(opt) ? cur.filter((x) => x !== opt) : q.multi ? [...cur, opt] : [opt];
  return { ...card, picks: card.picks.map((p, i) => (i === qi ? next : p)) };
}

export const answerOf = (card: QaCard, qi: number) => [...(card.picks[qi] || []), card.other[qi]?.trim() || ""].filter(Boolean).join("、");
export const answeredCount = (card: QaCard) => card.questions.filter((_, i) => answerOf(card, i)).length;

/** 问答 → 发回给 Agent 的文字；没答的问题写「你来决定」 */
export function answerText(card: QaCard): string {
  if (card.kind === "confirm") {
    const lines = card.questions.map((q, i) => `${i + 1}. ${q.q} → ${answerOf(card, i) || "（没填）"}`);
    return `结果确认（我的反馈）：\n${lines.join("\n")}\n\n请按我的反馈继续。`.slice(0, 1900);
  }
  const lines = card.questions.map((q, i) => `${i + 1}. ${q.q} → ${answerOf(card, i) || "你来决定"}`);
  return `补充信息（回答你的问题）：\n${lines.join("\n")}\n\n请按这些继续：${card.goal}`.slice(0, 1900);
}

const IMG = /海报|封面|主图|图片|插画|logo|头像|壁纸|banner|广告图|画一|出图|一张图/i;
const VID = /视频|短片|片子|动画|宣传片|广告片/;

/** 本地规则：模糊的出图 / 出视频需求，补 3–4 个问题（思考强度关闭 / 轻度、或有上下文时不问） */
export function clarifyQuestions(text: string, ctxCount: number, level: ThinkingLevel): QaQuestion[] | null {
  if (level === "off" || level === "light" || ctxCount > 0) return null;
  const t = String(text || "").trim();
  if (t.length > 24 || /\d+\s*(张|秒|s)|:|：|比例|风格/.test(t)) return null;
  if (VID.test(t)) return [
    { q: "视频多长？", options: ["5 秒", "10 秒", "15 秒"] },
    { q: "画面比例？", options: ["16:9 横屏", "9:16 竖屏", "1:1 方形"] },
    { q: "想要什么风格？", options: ["电影感", "产品特写", "手持 Vlog", "动画"] },
    { q: "需要配乐吗？", options: ["需要", "不需要"] },
  ];
  if (IMG.test(t)) return [
    { q: "用在哪里？", options: ["小红书封面 3:4", "电商主图 1:1", "横版海报 16:9", "手机壁纸 9:16"] },
    { q: "想要什么风格？", options: ["写实摄影", "扁平插画", "3D 渲染", "国潮"] },
    { q: "主色调？", options: ["暖色", "冷色", "黑白", "品牌色"], multi: true },
    { q: "出几张？", options: ["1 张", "3 张", "4 张"] },
  ];
  return null;
}
