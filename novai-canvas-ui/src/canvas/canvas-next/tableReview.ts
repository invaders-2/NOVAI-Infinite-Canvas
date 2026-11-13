/**
 * 表格审查（纯函数）：不发请求、不调 LLM，只按当前文档和表格数据检查常见坑。
 *   · 输入通道数 / 每通道张数 / 模式
 *   · 行数 vs 逐行通道张数（多行少行、逐行通道张数不一致）
 *   · 行文本里的「输入 N」越界、指向空通道（和 tableInputWarnings 同口径，不重复报）
 *   · 空行 / 没有提示词文字的行
 *   · 每行要发的素材数 vs 下游模型 maxRefs（截断点名哪条通道被截）
 *   · 0 素材通道 / inputModes 里残留的未连接通道
 *   · 下游批量 journal 的失败行
 * 结论给 TableNode 的「审查」弹层用；ok = 没有 error 级发现。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
// 和 table.ts / model.ts 同目录（canvas-next/）
import {
  batchOf, channelIndexFromId, channelItemsForRow, channelModesOf, CHANNEL_MODE_LABEL,
  mediaRefsIn, ROLE_META, rolesOf, tableChannels, tableInputWarnings, tableOf,
  type BatchJournal, type ChannelMode,
} from "./table";
import { genOf } from "./model";

export type ReviewLevel = "error" | "warn" | "info";
export type TableReviewFinding = { level: ReviewLevel; text: string };
export type TableReviewChannel = { id: string; index: number; title: string; count: number; mode: ChannelMode };
export type TableReviewStats = { rows: number; columns: number; channels: TableReviewChannel[]; totalMedia: number };
export type TableReviewOptions = {
  /** 下游生成模型的参考图上限；不传就不做「每行素材超上限」检查 */
  maxRefs?: number;
  /** 下游模型名，只用于提示文案 */
  modelName?: string;
  /** 下游批量节点 id；不传就自动找表格下游第一个图片 / 视频节点（journal 检查用） */
  genId?: string;
};
export type TableReview = { ok: boolean; summary: string; stats: TableReviewStats; findings: TableReviewFinding[] };

type RowMedia = { channel?: string; column?: string; url: string };

/** 这一行要发的素材（输入通道按模式取到的 + 数据列里手放的图片），按发送顺序去重 */
function rowMediaOf(t: ReturnType<typeof tableOf>, channels: ReturnType<typeof tableChannels>, row: number): RowMedia[] {
  const out: RowMedia[] = []; const seen = new Set<string>();
  const push = (m: RowMedia) => { if (!m.url || seen.has(m.url)) return; seen.add(m.url); out.push(m); };
  channels.forEach((ch) => channelItemsForRow(ch, row).forEach((m) => push({ channel: ch.title, url: m.url || m.src })));
  const roles = rolesOf(t);
  (t.rows[row] || []).forEach((v, i) => { if (ROLE_META[roles[i].role].media) mediaRefsIn(v).forEach((url) => push({ column: t.columns[i], url })); });
  return out;
}

const ALL_INTENT = /整组|全部|全组|所有|整列|每一张|每张|都用/;
/** 行文本里明确说「输入 N 整组/全部…」的通道号（16 字窗口，遇到下一个「输入 N」截断） */
function allIntentChannels(t: ReturnType<typeof tableOf>): Set<number> {
  const out = new Set<number>();
  const text = t.rows.flat().join("\n");
  for (const seg of text.split(/[\n；;。！!？?]/)) {
    const refs: Array<{ n: number; end: number }> = [];
    for (const m of seg.matchAll(/输入\s*(\d+)(?!\d)/g)) refs.push({ n: Number(m[1]), end: (m.index ?? 0) + m[0].length });
    for (const ref of refs) {
      const tail = seg.slice(ref.end, ref.end + 16).split(/输入\s*\d+(?!\d)/)[0];
      if (ALL_INTENT.test(tail)) out.add(ref.n);
    }
  }
  return out;
}

/** 行文本里引用到的输入通道号（只用于给「空通道」补一句是否被引用） */
function referencedChannelNumbers(t: ReturnType<typeof tableOf>): Set<number> {
  const out = new Set<number>();
  for (const row of t.rows) for (const cell of row) for (const hit of String(cell || "").matchAll(/输入\s*(\d+)/g)) {
    const n = Number(hit[1]); if (Number.isFinite(n) && n >= 1) out.add(n);
  }
  return out;
}

const downstreamGen = (doc: CanvasDoc, tableId: string, explicit?: string): CanvasNode | undefined => {
  if (explicit) return doc.nodes.find((n) => n.id === explicit);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  return doc.edges.filter((e) => e.from === tableId).map((e) => byId.get(e.to)).find((n): n is CanvasNode => !!n && (n.kind === "image" || n.kind === "video"));
};

const journalOf = (gen: CanvasNode | undefined): BatchJournal | null => gen ? batchOf(gen).journal : null;

/** 审查一张表；opts 传下游模型的 maxRefs 才能检查「每行素材超上限」 */
export function reviewTable(doc: CanvasDoc, tableId: string, opts: TableReviewOptions = {}): TableReview {
  const tn = doc.nodes.find((n) => n.id === tableId);
  const emptyStats: TableReviewStats = { rows: 0, columns: 0, channels: [], totalMedia: 0 };
  if (!tn || tn.kind !== "table") {
    return { ok: false, summary: "找不到这张表格", stats: emptyStats, findings: [{ level: "error", text: "找不到这张表格节点（可能已被删除）" }] };
  }
  const t = tableOf(tn);
  const channels = tableChannels(doc, tableId);
  const findings: TableReviewFinding[] = [];
  const stats: TableReviewStats = {
    rows: t.rows.length,
    columns: t.columns.length,
    channels: channels.map((ch, i) => ({ id: ch.id, index: i + 1, title: ch.title, count: ch.items.length, mode: ch.mode })),
    totalMedia: channels.reduce((sum, ch) => sum + ch.items.length, 0),
  };
  const referenced = referencedChannelNumbers(t);

  // 1) inputModes 里留着已经不存在的通道
  for (const id of Object.keys(channelModesOf(t.inputModes))) {
    if (channelIndexFromId(id) >= channels.length) findings.push({ level: "warn", text: `inputModes 里还存着 ${id}，但表格现在只有 ${channels.length} 条输入通道（多出来的配置可以忽略，或重新出表覆盖）` });
  }

  // 2) 0 素材通道（和「行文本引用了它」合并成一条，避免重复）
  channels.forEach((ch, i) => {
    if (ch.items.length) return;
    findings.push({ level: "warn", text: `输入 ${i + 1}「${ch.title}」没有素材${referenced.has(i + 1) ? "（行文本里有引用）" : ""}：通道已连到表格，但上游还没出结果` });
  });

  // 3) 和 tableInputWarnings 同口径：行文本「输入 N」越界 / 多出来的旧通道（直接复用，不重复造）
  for (const w of tableInputWarnings(doc, tableId, channels)) {
    findings.push({ level: w.includes("但表格只有") ? "error" : "warn", text: w });
  }

  // 3b) 行文本说「输入 N 整组 / 全部」，但这条通道是「沿用」：每行只会发 1 张，和行文本意图不符
  const allIntent = allIntentChannels(t);
  channels.forEach((ch, i) => {
    if (ch.mode !== "shared" || ch.items.length <= 1 || !allIntent.has(i + 1)) return;
    findings.push({
      level: "error",
      text: `行文本要求「输入 ${i + 1}」整组 / 全部，但这条通道是「沿用」：每行只会发 1 张（共 ${ch.items.length} 张）。请把输入 ${i + 1}「${ch.title}」的模式改成「全部」`,
    });
  });

  // 3c) 所有通道都是「沿用」、张数不一致、行数 > 1：每行每组只取 1 张，整组参考会丢（提示怎么改，不当作错误）
  if (channels.length > 1 && t.rows.length > 1 && channels.every((ch) => ch.mode === "shared")) {
    const counts = channels.map((ch) => ch.items.length);
    if (new Set(counts).size > 1) {
      findings.push({
        level: "warn",
        text: `所有输入通道都是「沿用」，每行每组只发 1 张；要整组参考请把对应通道设为「全部」（现在：${channels.map((ch, i) => `输入 ${i + 1} ${ch.items.length} 张`).join("、")}）`,
      });
    }
  }

  // 4) 行数 vs 逐行通道张数
  const seq = channels.map((ch, i) => ({ ch, index: i + 1 })).filter((x) => x.ch.mode === "sequence");
  const seqMax = Math.max(0, ...seq.map((x) => x.ch.items.length));
  if (seqMax > 0 && t.rows.length !== seqMax) {
    findings.push({
      level: "error",
      text: `表格有 ${t.rows.length} 行，逐行通道要求 ${seqMax} 行（${seq.map((x) => `输入 ${x.index}「${x.ch.title}」${x.ch.items.length} 张`).join("、")}）：行数对不上，多出来的行会取不到素材、少的行会漏素材`,
    });
  } else if (seq.length > 1 && new Set(seq.map((x) => x.ch.items.length)).size > 1) {
    findings.push({
      level: "warn",
      text: `逐行通道张数不一致（${seq.map((x) => `输入 ${x.index} ${x.ch.items.length} 张`).join("、")}）：按最多的 ${seqMax} 行跑，张数少的通道后面会取不到素材`,
    });
  }

  // 5) 空行 / 没有提示词文字的行
  const roles = rolesOf(t);
  t.rows.forEach((row, r) => {
    const cells = row.map((v) => String(v || "").trim());
    if (!cells.some(Boolean)) {
      findings.push({ level: "warn", text: `第 ${r + 1} 行是空行，批量运行时会跳过` });
      return;
    }
    if (!row.some((v, i) => roles[i].role === "prompt" && String(v || "").trim())) {
      findings.push({ level: "warn", text: `第 ${r + 1} 行没有提示词文字（只有参数 / 图片列），这一行可能生成不出想要的内容` });
    }
  });

  // 6) 每行素材数 vs 下游模型参考图上限（截断点名哪条通道）
  if (opts.maxRefs != null) {
    const cap = Math.max(0, Math.floor(Number(opts.maxRefs)) || 0);
    const model = opts.modelName ? `「${opts.modelName}」` : "下游模型";
    t.rows.forEach((_, r) => {
      const media = rowMediaOf(t, channels, r);
      if (media.length <= cap) return;
      if (!cap) {
        findings.push({ level: "error", text: `第 ${r + 1} 行要发 ${media.length} 张参考图，${model}不支持参考图，这些图不会发送` });
        return;
      }
      const lost = new Map<string, { sent: number; total: number }>();
      media.forEach((m, i) => {
        const key = m.channel || m.column || "其它";
        const g = lost.get(key) || { sent: 0, total: 0 }; g.total++; if (i < cap) g.sent++; lost.set(key, g);
      });
      const cut = [...lost].filter(([, g]) => g.sent < g.total).map(([k, g]) => `「${k}」${g.total} 张只发送 ${g.sent} 张`).join("、");
      findings.push({ level: "error", text: `第 ${r + 1} 行要发 ${media.length} 张参考图，超过${model}上限 ${cap} 张${cut ? `（${cut}）` : ""}` });
    });
  }

  // 7) 下游批量 journal 的失败行（表格自己不知道 batch，失败记录在生成节点上）
  const gen = downstreamGen(doc, tableId, opts.genId);
  const journal = journalOf(gen);
  if (gen && journal) {
    const failed = journal.rows.filter((r) => r.status === "failed");
    if (failed.length) {
      const detail = failed.slice(0, 3).map((r) => `第 ${r.row} 行${r.error ? `（${r.error}）` : ""}`).join("；");
      findings.push({ level: "error", text: `下游批量「${genOf(gen).title}」有 ${failed.length} 行失败：${detail}` });
    } else {
      const pending = journal.rows.filter((r) => r.status === "running" || r.status === "pending");
      if (pending.length) findings.push({ level: "info", text: `下游批量「${genOf(gen).title}」还有 ${pending.length} 行没跑完` });
    }
  }

  // 同一句只报一次（例如空通道 + inputModes 残留可能说同一件事）
  const dedup = [...new Map(findings.map((f) => [f.level + "|" + f.text, f])).values()];
  const errors = dedup.filter((f) => f.level === "error").length;
  const warns = dedup.filter((f) => f.level === "warn").length;
  const ok = errors === 0;
  const summary = ok
    ? `${stats.rows} 行 × ${stats.channels.length} 输入，未发现明显问题${warns ? `（${warns} 个提醒）` : ""}`
    : `发现 ${errors} 个问题${warns ? `、${warns} 个提醒` : ""}，建议先修再批量生成`;
  return { ok, summary, stats, findings: dedup };
}
