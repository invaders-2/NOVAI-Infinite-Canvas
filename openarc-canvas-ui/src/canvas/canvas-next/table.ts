/**
 * 多维表格（简化自 NOVAI / DX OS 的 table 节点，见 NOVAI docs/v2/DXOS_TABLE_SPEC.md）。
 *
 * 节点：kind = "table"，数据在 node.data.table。
 *   上游 —— ① 文本节点「输出：多维表格 / 分镜表」跑完后自动建表并连线（表格由文本模型生成）；
 *          ② 图片 / 视频 / 音频节点直接连进表格 → 成为最左侧的「输入列」：
 *             只有 1 个素材 → 所有行共用（shared）；多个 → 逐行对应（sequence）。
 *   下游 —— 表格连到生成节点 → 生成节点按行批量生成（见 engine.ts 的 runTableBatch）：
 *             每行提示词 = 上游文本 + 节点提示词 + 该行「列名：值」；每行素材 = 节点自身输入 + 该行输入列素材。
 *
 * 和 NOVAI 相比的简化：输入列由连线自动推导（不做「钉住通道」）；出表一遍生成 + 失败修复一次（不做规划遍）；
 * 不做合并单元格。上限沿用：手工 200 列 / 5000 行，模型生成 40 列 / 200 行，单元格 20000 字。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { isStack, stackItems } from "./stack";
import { genOf, inputsOf, isGenKind, outOf, srcOf, textOf, uid, type AnyParams, type GenKind, type ModelSpec, type VideoMode, type VideoParams } from "./model";

export const TABLE_LIMITS = { cols: 200, rows: 5000, llmCols: 40, llmRows: 200, cell: 20000 };
export type TableData = {
  kind: "table"; version: 1;
  title: string;
  columns: string[];
  rows: string[][];
  /** 由哪个文本节点生成（重新出表时更新这张，而不是再建一张） */
  sourceId?: string;
  /** 输入列模式：auto 按素材数量判断；pair = 两张一组，依次作为每行的首帧 / 尾帧 */
  inputMode?: "auto" | "shared" | "sequence" | "pair";
  /** 每列的用途（和 columns 等长）；"" 或缺省 = 按列名自动识别，见 guessRole */
  roles?: string[];
};
export type TextOutputMode = "text" | "table" | "storyboard";
export const OUTPUT_MODES: Array<[TextOutputMode, string, string]> = [["text", "文本", "普通文字结果"], ["table", "多维表格", "整理成逐行可执行的任务表"], ["storyboard", "分镜表", "镜头 / 画面 / 运镜 / 时长 / 台词"]];
export const STORYBOARD_COLUMNS = ["镜头", "画面", "运镜", "时长", "台词 / 字幕"];
/** 分镜表出表后系统追加的图片列（模型不写，留给用户拖图 / 「首帧图」批量回填） */
export const STORYBOARD_MEDIA_COLUMNS = ["首帧", "尾帧"];

/* ---------- 列用途 ---------- */
export type ColRole = "prompt" | "first" | "last" | "ref" | "dur" | "ratio" | "label" | "skip";
export const ROLE_META: Record<ColRole, { label: string; hint: string; media?: boolean }> = {
  prompt: { label: "提示词", hint: "拼进这一行的提示词" },
  first: { label: "首帧", hint: "图片：这一行视频的开场画面", media: true },
  last: { label: "尾帧", hint: "图片：这一行视频的结尾画面", media: true },
  ref: { label: "参考图", hint: "图片：主体 / 风格参考，可放多张", media: true },
  dur: { label: "时长", hint: "覆盖这一行的视频时长（取模型支持的最接近值）" },
  ratio: { label: "比例", hint: "覆盖这一行的画面比例，如 16:9、竖屏" },
  label: { label: "镜头名", hint: "只用来给结果命名，不进提示词" },
  skip: { label: "不使用", hint: "备注等，不参与生成" },
};
export const ROLE_ORDER: ColRole[] = ["prompt", "first", "last", "ref", "dur", "ratio", "label", "skip"];
const isRole = (x: unknown): x is ColRole => typeof x === "string" && x in ROLE_META;
/** 按列名猜用途：「首帧 / 开头画面」→ 首帧，「尾帧 / 结尾画面」→ 尾帧，「时长 / 秒」→ 时长…；带「描述 / 提示词」的仍算文字 */
export function guessRole(name: string): ColRole {
  const n = String(name || "").replace(/\s+/g, "");
  const textual = /描述|提示|prompt|文字|文案|说明|内容/i.test(n);
  if (!textual) {
    if (/首帧|起始帧|开始帧|开场画面|开头画面|起幅|first.?frame|start.?frame/i.test(n)) return "first";
    if (/尾帧|结束帧|结尾帧|结尾画面|结束画面|落幅|last.?frame|end.?frame/i.test(n)) return "last";
    if (/参考图|参考图片|素材图|^ref(erence)?(image|img)?s?$|^参考$/i.test(n)) return "ref";
  }
  if (/时长|秒数|^duration$|^dur$|^秒$/i.test(n)) return "dur";
  if (/比例|画幅|宽高比|^ratio$|aspect/i.test(n)) return "ratio";
  if (/^(镜头|镜号|镜头号|镜头编号|序号|编号|场次|shot|no\.?|#)$/i.test(n)) return "label";
  if (/备注|^note$|remark/i.test(n)) return "skip";
  return "prompt";
}
/** 每列的用途和是否来自自动识别 */
export function rolesOf(t: TableData): Array<{ role: ColRole; auto: boolean }> {
  return t.columns.map((c, i) => { const r = t.roles?.[i]; return isRole(r) ? { role: r, auto: false } : { role: guessRole(c), auto: true }; });
}
export function withRole(t: TableData, col: number, role: ColRole | ""): TableData {
  const roles = t.columns.map((_, i) => (i === col ? role : t.roles?.[i] || ""));
  return { ...t, roles: roles.some(Boolean) ? roles : undefined };
}
/** 单元格里是不是一张图（资源库引用 / data URL / 网络地址） */
export const isMediaRef = (v: string) => /^(openarc-asset:|openarc-resource:|data:image\/|https?:\/\/)/i.test(String(v || "").trim());
/** 图片列的单元格可以放多张（换行分隔） */
export const mediaRefsIn = (v: string) => String(v || "").split(/\s*\n\s*/).map((x) => x.trim()).filter(isMediaRef);
/** 「5s」「约 4.5 秒」「10」→ 秒数 */
export function parseDur(v: string): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec(String(v || "")); if (!m) return null;
  const n = Number(m[1]); return Number.isFinite(n) && n > 0 && n <= 600 ? n : null;
}
/** 「16:9」「9：16」「竖屏」→ 比例串 */
export function parseRatio(v: string): string | null {
  const s = String(v || "").trim();
  const m = /(\d+(?:\.\d+)?)\s*[:：x×\/]\s*(\d+(?:\.\d+)?)/.exec(s); if (m) return `${m[1]}:${m[2]}`;
  if (/竖屏|竖版|portrait/i.test(s)) return "9:16";
  if (/横屏|横版|landscape/i.test(s)) return "16:9";
  if (/方形|正方|square/i.test(s)) return "1:1";
  return null;
}

export function emptyTable(): TableData {
  return { kind: "table", version: 1, title: "多维表格", columns: ["字段 1", "字段 2", "字段 3"], rows: [["", "", ""], ["", "", ""], ["", "", ""]] };
}
export function tableOf(node: CanvasNode): TableData {
  const raw = node.data && typeof node.data === "object" ? (node.data as { table?: unknown }).table : undefined;
  const t = normalizeTable(raw, false);
  if (t) return t;
  // 旧版只读表格（react-canvas 的 legacy table）：data 是二维数组或 {columns, rows}/{cells}
  const legacy = normalizeLegacy(node.data);
  return legacy || emptyTable();
}
export function withTable(node: CanvasNode, t: TableData): CanvasNode {
  return { ...node, text: t.title, data: { ...(node.data && typeof node.data === "object" ? node.data : {}), table: t } };
}

/** 归一化（DX OS Mx）：列名去空补「未命名列」，行补齐列数，非字符串 stringify，截断 */
export function normalizeTable(raw: unknown, llm: boolean): TableData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) return null;
  const maxC = llm ? TABLE_LIMITS.llmCols : TABLE_LIMITS.cols, maxR = llm ? TABLE_LIMITS.llmRows : TABLE_LIMITS.rows;
  const columns = r.columns.slice(0, maxC).map((c, i) => String(c ?? "").trim() || `未命名列 ${i + 1}`);
  if (!columns.length) return null;
  // 图片单元格（内嵌的 data URL）不截断，截了图就坏了
  const cell = (v: unknown) => { const x = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v); return /^data:image\//.test(x) ? x : x.slice(0, TABLE_LIMITS.cell); };
  const rows = r.rows.slice(0, maxR).map((row) => { const arr = Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((c) => (row as Record<string, unknown>)[c]) : [row]; return columns.map((_, i) => cell(arr[i])); });
  return { kind: "table", version: 1, title: typeof r.title === "string" && r.title ? r.title : "多维表格", columns, rows, ...(typeof r.sourceId === "string" ? { sourceId: r.sourceId } : {}), ...(r.inputMode === "shared" || r.inputMode === "sequence" || r.inputMode === "pair" ? { inputMode: r.inputMode } : {}), ...(Array.isArray(r.roles) && !llm && r.roles.some((x) => isRole(x)) ? { roles: columns.map((_, i) => (isRole(r.roles && (r.roles as unknown[])[i]) ? String((r.roles as unknown[])[i]) : "")) } : {}) };
}
function normalizeLegacy(raw: unknown): TableData | null {
  const any = raw as any;
  const matrix: unknown[][] | null = Array.isArray(any) ? any : Array.isArray(any?.cells) ? any.cells : null;
  if (matrix && matrix.length) return normalizeTable({ columns: matrix[0], rows: matrix.slice(1) }, false);
  if (any && Array.isArray(any.columns)) return normalizeTable({ columns: any.columns, rows: Array.isArray(any.rows) ? any.rows : [] }, false);
  return null;
}

/** 解析模型返回（DX OS a6）：剥 ```json、取首尾大括号、JSON.parse、校验 */
export function parseTableJson(text: string): TableData {
  let s = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s); if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("模型没有返回统一的多维表格格式");
  let obj: unknown; try { obj = JSON.parse(s.slice(a, b + 1)); } catch { throw new Error("模型没有返回统一的多维表格格式"); }
  const t = normalizeTable(obj, true);
  if (!t) throw new Error("模型没有返回统一的多维表格格式");
  if ((obj as any).columns.some((c: unknown) => !String(c ?? "").trim())) throw new Error("模型返回的表格列名不完整");
  if (!t.rows.length) throw new Error("LLM 没有生成可执行的多维表格。");
  return t;
}

/** 出表提示词（DX OS BS 的 list 分支，简化为一遍） */
export function tablePrompt(task: string, mode: TextOutputMode, mediaCount: number): string {
  const cols = mode === "storyboard" ? `列固定为：${JSON.stringify(STORYBOARD_COLUMNS)}。每行是一个镜头。` : "请根据任务自行设计最合适的列结构，不套固定模板。";
  return [
    "请把结果整理为可逐行执行的生成任务：每一行必须是一条完整、独立、可直接用于后续图像或视频生成的内容。",
    "严格遵守用户指定的数量；未指定时根据输入数量和任务目标合理决定。" + (mediaCount ? `当前有 ${mediaCount} 个素材输入：图片组通常逐张映射到各行，单图参考通常应用到所有相关行。` : ""),
    "如果任务区分了「目标主体」和「风格/版式参考」，每行内容都必须显式写清它们的关系。",
    "不要只写「使用图1」「参考图2」这类占位说明，每个文字单元格都要有足够的信息密度。",
    cols,
    "行的先后顺序已经表达执行顺序，不需要额外的序号列。",
    "不要在 JSON 中创建图片、参考图或生成输入列，系统会在独立的输入列里放素材。",
    "只返回一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
    '{"kind":"table","version":1,"columns":["列名1","列名2"],"rows":[["单元格1","单元格2"]]}',
    "", "任务：", task,
  ].join("\n");
}
export function repairPrompt(bad: string): string {
  return "请把下面未通过校验的结果修复为合法的多维表格 JSON。不要删减原有信息，不要输出解释或 Markdown。格式：\n" + '{"kind":"table","version":1,"columns":["列名1"],"rows":[["单元格1"]]}' + "\n\n" + bad.slice(0, 30000);
}

/* ---------- 输入列：从连进表格的素材节点推导 ---------- */
export type TableMedia = {
  nodeId: string; kind: GenKind; title: string; src: string; url?: string;
  /** 这张图在这一行里的身份：输入列「两张一组」或图片列（首帧 / 尾帧 / 参考图）给出；没有 = 按生成节点的方式分配 */
  as?: "first" | "last" | "ref";
};
export function tableMedia(doc: CanvasDoc, tableId: string): TableMedia[] {
  const node = doc.nodes.find((n) => n.id === tableId);
  const direct = inputsOf(doc, tableId).filter((x) => isGenKind(x.node.kind) && x.node.kind !== "text");
  // 由文本节点生成的表：没有直接素材时，继承那个文本节点的素材输入
  let list = direct;
  if (!list.length && node) { const t = tableOf(node); if (t.sourceId) list = inputsOf(doc, t.sourceId).filter((x) => isGenKind(x.node.kind) && x.node.kind !== "text"); }
  return list.map((x) => ({ nodeId: x.node.id, kind: x.node.kind as GenKind, title: genOf(x.node).title, src: srcOf(x.node), url: outOf(x.node)?.url }));
}
export type InputMode = "shared" | "sequence" | "pair";
export const INPUT_MODE_LABEL: Record<InputMode, string> = { shared: "共用", sequence: "逐行", pair: "首尾帧" };
export function inputModeOf(t: TableData, media: TableMedia[]): InputMode { return t.inputMode && t.inputMode !== "auto" ? t.inputMode : media.length > 1 ? "sequence" : "shared"; }
/** 第 row 行（0 起）对应的素材：sequence 逐行，pair 两张一组（首帧 + 尾帧），shared 全部共用 */
export function mediaForRow(t: TableData, media: TableMedia[], row: number): TableMedia[] {
  if (!media.length) return [];
  const mode = inputModeOf(t, media);
  if (mode === "pair") { const a = media[row * 2], b = media[row * 2 + 1]; const out: TableMedia[] = []; if (a) out.push({ ...a, as: "first" }); if (b) out.push({ ...b, as: "last" }); return out; }
  return mode === "sequence" ? (media[row] ? [media[row]] : []) : media;
}

/* ---------- 下游：生成节点读表 ---------- */
export type BatchRow = {
  row: number;
  /** 只含「提示词」用途的列（图片列里写的文字也算） */
  text: string;
  /** 输入列素材 + 图片列里的图 */
  media: TableMedia[];
  tableId: string;
  /** 「镜头名」列：给结果节点命名 */
  label?: string;
  /** 「时长」「比例」列：覆盖这一行的参数 */
  dur?: number; ratio?: string;
};
/** 图片批量的结果填回哪张表的哪一列 */
export type FillTarget = { table: string; col: number };
/**
 * 生成节点的所有上游表格的逐行任务（DX OS Pu）：行数取各表最大行数，空行跳过。
 * skip：图片批量正在回填的列，不当作这次的输入。
 */
export function batchRows(doc: CanvasDoc, genId: string, skip?: FillTarget | null): BatchRow[] {
  const tables = inputsOf(doc, genId).filter((x) => x.node.kind === "table").map((x) => x.node);
  if (!tables.length) return [];
  const n = Math.max(...tables.map((t) => tableOf(t).rows.length));
  const out: BatchRow[] = [];
  for (let r = 0; r < n; r++) {
    const media: TableMedia[] = []; const lines: string[] = []; const row: BatchRow = { row: r + 1, text: "", media, tableId: tables[0].id };
    for (const tn of tables) {
      const t = tableOf(tn); const tm = tableMedia(doc, tn.id); const roles = rolesOf(t);
      media.push(...mediaForRow(t, tm, r));
      (t.rows[r] || []).forEach((v, i) => {
        const val = (v || "").trim(); if (!val || (skip && skip.table === tn.id && skip.col === i)) return;
        const role = roles[i].role; const name = t.columns[i];
        if (ROLE_META[role].media) {
          const refs = mediaRefsIn(val);
          if (refs.length) { refs.slice(0, role === "ref" ? 8 : 1).forEach((u, k) => media.push({ nodeId: `cell:${tn.id}:${r}:${i}:${k}`, kind: "image", title: `${name} · 行${r + 1}`, src: u, url: u, as: role as "first" | "last" | "ref" })); return; }
          lines.push(`${name}：${val}`); return;
        }
        if (role === "dur") { const d = parseDur(val); if (d != null) { if (row.dur == null) row.dur = d; return; } }
        else if (role === "ratio") { const q = parseRatio(val); if (q) { if (!row.ratio) row.ratio = q; return; } }
        else if (role === "label") { if (!row.label) row.label = val.slice(0, 24); return; }
        else if (role === "skip") return;
        lines.push(`${name}：${val}`);
      });
    }
    row.text = lines.join("\n");
    out.push(row);
  }
  return out;
}

/** 发给模型的这一行输入（engine 再并到生成节点自己的输入里） */
export type RowInput = { nodeId: string; title: string; kind: GenKind; url: string; role: "reference" | "first_frame" | "last_frame" | "source_video" | "driving_audio" | "context" };
export type RowPlan = { params: AnyParams; inputs: RowInput[]; warnings: string[]; /** 这一行自带了图：生成节点自己连的图片不再发送，免得首帧打架 */ ownImages: boolean };
/**
 * 一行的请求怎么组（纯函数，便于测试）：
 *   时长 / 比例列覆盖参数（时长取模型支持的最接近值）；
 *   视频：有首帧 + 尾帧 → 首尾帧；只有首帧 → 首帧；只有参考图 → 参考生视频；模型不支持时降级并给出说明；
 *   图片：这一行的图都当参考图（按模型上限截断）。
 */
export function planRow(kind: GenKind, params: AnyParams, m: ModelSpec | undefined, row: BatchRow): RowPlan {
  const warnings: string[] = []; const p = { ...(params as Record<string, unknown>) } as Record<string, unknown>;
  if (row.ratio && (kind === "image" || kind === "video")) {
    if (!m?.ratios?.length || m.ratios.includes(row.ratio)) p.ratio = row.ratio; else warnings.push(`比例 ${row.ratio} 该模型不支持，沿用 ${p.ratio}`);
  }
  if (row.dur != null && kind === "video") {
    const want = row.dur; const ds = m?.durs || [];
    const d = ds.length ? ds.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a), ds[0]) : Math.round(want);
    if (d !== want) warnings.push(`时长 ${want}s 按模型改为 ${d}s`);
    p.dur = d;
  }
  const out: RowInput[] = [];
  const add = (x: TableMedia, role: RowInput["role"]) => out.push({ nodeId: x.nodeId, title: x.title, kind: x.kind, url: x.url || x.src, role });
  const imgs = row.media.filter((x) => x.kind === "image");
  row.media.filter((x) => x.kind !== "image").forEach((x) => add(x, x.kind === "video" ? "source_video" : x.kind === "audio" ? "driving_audio" : "context"));
  const done = (ownImages: boolean): RowPlan => ({ params: p as AnyParams, inputs: out, warnings, ownImages });
  if (!imgs.length) return done(false);
  if (kind !== "video") {
    const cap = kind === "image" ? (m ? (m.i2i ? m.maxRefs ?? 0 : 0) : imgs.length) : imgs.length;
    imgs.slice(0, cap).forEach((x) => add(x, "reference"));
    if (imgs.length > cap) warnings.push(cap ? `参考图超过模型上限 ${cap} 张，多出的没有发送` : "该模型不支持参考图，这一行的图片没有发送");
    return done(false);
  }
  const vm = (params as VideoParams).mode; const modes: VideoMode[] = m?.modes?.length ? m.modes : [vm];
  let first = imgs.find((x) => x.as === "first"); let last = imgs.find((x) => x.as === "last");
  const refs = imgs.filter((x) => x.as === "ref"); const plain = imgs.filter((x) => !x.as);
  // 输入列「共用 / 逐行」给的图没有身份：按生成节点选的方式分配；节点还是「文生视频」就按张数（1 首帧 / 2 首尾帧 / 更多 参考）
  if (plain.length) {
    const how = vm === "首尾帧" || vm === "首帧" || vm === "参考生视频" ? vm : plain.length === 1 ? "首帧" : plain.length === 2 ? "首尾帧" : "参考生视频";
    if (how === "参考生视频") refs.push(...plain);
    else {
      const q = [...plain];
      if (!first) first = q.shift();
      if (how === "首尾帧" && !last && q.length) last = q.shift();
      if (q.length) warnings.push(`${how}模式只用前 ${how === "首尾帧" ? 2 : 1} 张图，其余没有发送`);
    }
  }
  let want: VideoMode = first && last ? "首尾帧" : first ? "首帧" : "参考生视频";
  if (want === "首尾帧" && !modes.includes("首尾帧")) { warnings.push("该模型不支持首尾帧，只用了首帧"); last = undefined; want = "首帧"; }
  if (want === "首帧" && !modes.includes("首帧")) {
    if (modes.includes("参考生视频") && first) { refs.unshift(first); first = undefined; want = "参考生视频"; warnings.push("该模型不支持首帧，首帧图改作参考图"); }
    else { warnings.push("该模型不支持图生视频，这一行的图片没有发送"); return done(false); }
  }
  if (want === "参考生视频" && !modes.includes("参考生视频")) {
    if (modes.includes("首帧") && refs.length) { first = refs.shift(); want = "首帧"; warnings.push("该模型不支持参考生视频，第一张参考图改作首帧"); }
    else { warnings.push("该模型不支持参考图生视频，这一行的图片没有发送"); return done(false); }
  }
  p.mode = want;
  if (first) add(first, "first_frame");
  if (last) add(last, "last_frame");
  if (want === "参考生视频") {
    const cap = m?.maxRefs ?? refs.length; refs.slice(0, cap).forEach((x) => add(x, "reference"));
    if (refs.length > cap) warnings.push(`参考图超过模型上限 ${cap} 张，多出的没有发送`);
  } else if (refs.length) warnings.push(`${want}模式不带参考图，参考图列没有发送`);
  return done(true);
}

/** 镜头串联：这一行没有首帧时，接上一行视频的最后一帧 */
export const rowHasFirst = (r: BatchRow) => r.media.some((x) => x.kind === "image" && (x.as === "first" || !x.as));

export type BatchSettings = {
  concurrency: number; startRow: number; manual: boolean; selected: number[]; failure: "stop" | "continue";
  /** 图片批量：结果填回表格的哪一列。undefined = 自动（第一次运行时定下来并记住），null = 不回填 */
  fill?: FillTarget | null;
  /** 视频批量：镜头串联（上一行视频的最后一帧作为下一行的首帧；按顺序逐行生成） */
  chain?: boolean;
};
export const DEFAULT_BATCH: BatchSettings = { concurrency: 3, startRow: 1, manual: false, selected: [], failure: "continue" };
export type BatchJournal = { runId: string; rows: Array<{ row: number; status: "pending" | "running" | "completed" | "failed"; nodeId?: string; error?: string }> };
export function batchOf(node: CanvasNode): { settings: BatchSettings; journal: BatchJournal | null } {
  const raw = node.data && typeof node.data === "object" ? (node.data as { batch?: any }).batch : undefined;
  const s = { ...DEFAULT_BATCH, ...(raw?.settings || {}) } as BatchSettings;
  s.concurrency = Math.max(1, Math.min(8, Math.round(Number(s.concurrency) || 3)));
  s.startRow = Math.max(1, Math.round(Number(s.startRow) || 1));
  if (s.fill !== undefined && s.fill !== null && !(typeof s.fill === "object" && typeof s.fill.table === "string" && Number.isInteger(s.fill.col))) delete s.fill;
  s.chain = !!s.chain;
  return { settings: s, journal: raw?.journal && Array.isArray(raw.journal.rows) ? raw.journal : null };
}
export function withBatch(node: CanvasNode, patch: { settings?: Partial<BatchSettings>; journal?: BatchJournal | null }): CanvasNode {
  const cur = batchOf(node);
  const batch = { settings: { ...cur.settings, ...(patch.settings || {}) }, journal: patch.journal === undefined ? cur.journal : patch.journal };
  return { ...node, data: { ...(node.data && typeof node.data === "object" ? node.data : {}), batch } };
}
/** 可以回填的列：上游表格里所有图片用途的列 */
export function fillCandidates(doc: CanvasDoc, genId: string): Array<FillTarget & { name: string; role: ColRole }> {
  return inputsOf(doc, genId).filter((x) => x.node.kind === "table").flatMap((x) => { const t = tableOf(x.node); return rolesOf(t).map((r, col) => ({ table: x.node.id, col, name: t.columns[col], role: r.role })).filter((c) => ROLE_META[c.role].media); });
}
/**
 * 图片批量的回填列：显式设置优先（列还在、还是图片用途才算）；
 * 自动 = 第一张表里第一列「首帧」用途、且整列还空着的列（填过之后由 runTableBatch 记住，重跑仍回填同一列）。
 */
export function fillTargetOf(doc: CanvasDoc, genId: string, s: BatchSettings): FillTarget | null {
  const gen = doc.nodes.find((n) => n.id === genId); if (!gen || gen.kind !== "image" || s.fill === null) return null;
  const cands = fillCandidates(doc, genId);
  if (s.fill) return cands.find((c) => c.table === s.fill!.table && c.col === s.fill!.col) ? { table: s.fill.table, col: s.fill.col } : null;
  for (const c of cands) {
    if (c.role !== "first") continue;
    const tn = doc.nodes.find((n) => n.id === c.table)!; const t = tableOf(tn);
    if (t.rows.every((row) => !(row[c.col] || "").trim())) return { table: c.table, col: c.col };
  }
  return null;
}
/** 本次要跑的行（DX OS bl）：手动模式 = 已选行；批量模式 = 起始行之后；都要有内容 */
export function rowsToRun(rows: BatchRow[], s: BatchSettings): BatchRow[] {
  const has = (r: BatchRow) => r.media.length > 0 || !!r.text.trim();
  return s.manual ? rows.filter((r) => s.selected.includes(r.row) && has(r)) : rows.filter((r) => r.row >= s.startRow && has(r));
}
export function emptyRunHint(rows: BatchRow[], s: BatchSettings): string {
  if (s.manual) return "请先点击上方行，选择至少一行独立运行";
  if (s.startRow > rows.length) return `起始行超出表格范围，当前共 ${rows.length} 行`;
  return "起始行之后没有可生成的内容";
}

/** 分镜表：追加首帧 / 尾帧两列图片列（已有同名列就不加） */
export function withStoryboardMedia(t: TableData): TableData {
  const add = STORYBOARD_MEDIA_COLUMNS.filter((c) => !t.columns.includes(c));
  if (!add.length) return t;
  return { ...t, columns: [...t.columns, ...add], rows: t.rows.map((r) => [...r, ...add.map(() => "")]), ...(t.roles ? { roles: [...t.roles, ...add.map(() => "")] } : {}) };
}
/** 重新出表时保留旧表图片列里的图（同名列、同一行） */
export function keepMediaCells(t: TableData, old: TableData | null): TableData {
  if (!old) return t;
  const oldRoles = rolesOf(old); const roles = rolesOf(t);
  const rows = t.rows.map((r, ri) => r.map((v, ci) => { if (v || !ROLE_META[roles[ci].role].media) return v; const oc = old.columns.indexOf(t.columns[ci]); return oc >= 0 && ROLE_META[oldRoles[oc].role].media ? old.rows[ri]?.[oc] || "" : v; }));
  // 手动改过的列用途也按列名带过来
  const kept = t.columns.map((c, i) => { const oc = old.columns.indexOf(c); return t.roles?.[i] || (oc >= 0 ? old.roles?.[oc] || "" : ""); });
  return { ...t, rows, ...(kept.some(Boolean) ? { roles: kept } : {}) };
}

/** 画布上的图片节点拖到表格图片单元格上（cellId = 表格 id:行:列）：单图列替换，参考图列追加 */
export function dropImageOnCell(store: { node: (id: string) => CanvasNode | undefined; updateNode: (id: string, fn: (n: CanvasNode) => CanvasNode, o?: { history?: boolean }) => void; toast: (s: string) => void }, cellId: string, imageId: string, multi: boolean): boolean {
  const [tid, rs, cs] = cellId.split(":"); const r = Number(rs), c = Number(cs);
  const tn = store.node(tid); const img = store.node(imageId); const url = img ? outOf(img)?.url : undefined;
  if (!tn || tn.kind !== "table" || !url || !Number.isInteger(r) || !Number.isInteger(c)) return false;
  store.updateNode(tid, (n) => { const t = tableOf(n); if (!t.rows[r] || c >= t.columns.length) return n; const cur = mediaRefsIn(t.rows[r][c]); const v = (multi ? [...cur.filter((x) => x !== url), url].slice(-8) : [url]).join("\n"); return withTable(n, { ...t, rows: t.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) }); }, { history: true });
  store.toast(`已把「${genOf(img!).title}」放进第 ${r + 1} 行的「${tableOf(tn).columns[c]}」`);
  return true;
}

/* ---------- 分组输入：按提示词区分批量图片 / 视频，出表时逐行放图 ---------- */
export type TableGenKind = "image" | "video";
/** 最后出现的明确目标优先；静态编辑等没有视频信号的任务默认按图片处理。 */
export function tableGenKindOf(prompt: string): TableGenKind {
  const text = String(prompt || "");
  const last = (re: RegExp) => { let at = -1; for (const m of text.matchAll(re)) at = m.index ?? at; return at; };
  const image = last(/图片|图像|照片|海报|主图|套图|宣传图|封面|拼图|banner|poster|image|picture|photo/gi);
  const video = last(/视频|短片|影片|动画|分镜|镜头|运镜|首尾帧|首帧|尾帧|mp4|video/gi);
  return video > image ? "video" : "image";
}
export type GroupInput = { groupId: string; name: string; role: "first" | "last" | "ref"; images: Array<{ nodeId: string; title: string; url: string }> };
/** 组里的图片（有结果的才算）：堆叠按叠内顺序，分组按画布位置从上到下、从左到右 */
export function groupImages(doc: CanvasDoc, g: CanvasNode): Array<{ nodeId: string; title: string; url: string }> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const members = isStack(g) ? stackItems(doc, g) : (g.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n).sort((a, b) => a.y - b.y || a.x - b.x);
  return members.filter((n) => n.kind === "image" && outOf(n)?.url).map((n) => ({ nodeId: n.id, title: genOf(n).title, url: outOf(n)!.url! }));
}
/** 批量图片的分组都作为参考图；批量视频才按组名 / 连线顺序分配首帧、尾帧与参考图。 */
export function groupInputs(doc: CanvasDoc, id: string, intent: TableGenKind = "video"): GroupInput[] {
  const gs = inputsOf(doc, id).filter((x) => x.node.kind === "group").map((x) => x.node);
  const named = gs.map((g) => { const name = g.text && g.text !== "分组" && g.text !== "堆叠" ? g.text : ""; const r = intent === "image" ? "ref" : name ? guessRole(name) : null; return { g, name, role: r === "first" || r === "last" || r === "ref" ? r : null }; });
  const taken = new Set(named.map((x) => x.role).filter(Boolean));
  return named.map(({ g, name, role }) => {
    let r = role;
    if (!r) { r = !taken.has("first") ? "first" : !taken.has("last") ? "last" : "ref"; taken.add(r); }
    return { groupId: g.id, name: name || (isStack(g) ? "堆叠" : "分组"), role: r, images: groupImages(doc, g) };
  });
}
/** 出表提示里关于分组的说明 */
export function groupNote(groups: GroupInput[], withImages: boolean, intent: TableGenKind = "video"): string {
  if (!groups.length) return "";
  const n = Math.max(0, ...groups.map((g) => g.images.length));
  const instruction = intent === "image"
    ? withImages ? "这些图已按顺序附上（图的标题写明了是哪一组第几张）。请看图，为每一行写出可直接用于图片生成或编辑的提示词，明确各组参考图的主体、作用，以及需要修改和保持不变的内容。" : "请按行写出可直接用于图片生成或编辑的提示词，明确各组参考图的作用，以及需要修改和保持不变的内容。"
    : withImages ? "这些图已按顺序附上（图的标题写明了是哪一组第几张）。请看图，为每一行写出从首帧画面自然过渡到尾帧画面的主体动作、镜头运动和氛围，可直接用作视频提示词。" : "请按行写出每个镜头的画面、动作和运镜，可直接用作视频提示词。";
  return [
    `素材分组：${groups.map((g) => `「${g.name}」${g.images.length} 张，作为每一行的${ROLE_META[g.role].label}`).join("；")}。`,
    `表格必须正好 ${n} 行：第 i 行对应每组的第 i 张图，图片由系统放进对应的列，你只写文字列。`,
    instruction,
  ].join("");
}
/** 把分组里的图逐行放进参考图 / 首帧 / 尾帧列（没有对应列就加一列），行数不够就补空行 */
export function fillGroupColumns(t: TableData, groups: GroupInput[]): TableData {
  if (!groups.some((g) => g.images.length)) return t;
  const columns = [...t.columns]; const rows = t.rows.map((r) => [...r]); const roles = t.roles ? [...t.roles] : undefined;
  const n = Math.max(rows.length, ...groups.map((g) => g.images.length));
  while (rows.length < n) rows.push(columns.map(() => ""));
  for (const g of groups) {
    if (!g.images.length) continue;
    let ci = rolesOf({ ...t, columns, rows, roles }).findIndex((r) => r.role === g.role);
    if (ci < 0) { columns.push(ROLE_META[g.role].label); rows.forEach((r) => r.push("")); if (roles) roles.push(""); ci = columns.length - 1; }
    g.images.forEach((im, i) => { rows[i][ci] = g.role === "ref" ? [...mediaRefsIn(rows[i][ci]), im.url].slice(0, 8).join("\n") : im.url; });
  }
  return { ...t, columns, rows, ...(roles ? { roles } : {}) };
}

/* ---------- 尺寸（DX OS Yw / mR，按我们的节点比例收一点） ---------- */
export const TABLE_COL_W = 132, TABLE_INPUT_COL_W = 96, TABLE_HEAD_H = 34;
export function rowHeight(cells: string[], hasMedia: boolean): number {
  // 图片单元格（资源引用）按一张缩略图算，不按引用串的长度算行数
  const img = cells.some((c) => isMediaRef(c));
  const lines = Math.max(1, ...cells.map((c) => (isMediaRef(c) ? 1 : Math.ceil((c || "").length / 16) || 1)));
  return Math.min(140, Math.max(hasMedia || img ? 84 : 40, 20 + lines * 15));
}
export function tableAutoSize(t: TableData, mediaCols: number): { w: number; h: number } {
  const w = Math.max(320, Math.min(800, (mediaCols ? TABLE_INPUT_COL_W : 0) + t.columns.length * TABLE_COL_W + 36));
  const h = Math.min(640, TABLE_HEAD_H + t.rows.reduce((s, r) => s + rowHeight(r, mediaCols > 0), 0) + 40);
  return { w, h: Math.max(160, h) };
}
export const newTableId = () => uid("t");
export { textOf };
