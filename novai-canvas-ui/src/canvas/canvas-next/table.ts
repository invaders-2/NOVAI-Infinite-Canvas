/**
 * 多维表格（简化自 NOVAI / DX OS 的 table 节点，见 NOVAI docs/v2/DXOS_TABLE_SPEC.md）。
 *
 * 节点：kind = "table"，数据在 node.data.table。
 *   上游 —— ① 文本节点「输出：多维表格 / 分镜表」跑完后自动建表并连线（表格由文本模型生成），
 *              并把每个素材来源（分组 / 堆叠 / 单个素材节点）直接连到表格；
 *          ② 每个素材来源 = 一条输入通道 = 最左侧一列「输入 N」，通道内是它的素材；
 *             每条通道自己的模式：逐行（第 N 行取第 N 个）/ 全部（每行都用整列）/ 沿用（超出取最后一张），
 *             见 tableChannels / channelItemsForRow（对齐旧版 table-node.js 的 Co / ab）。
 *   下游 —— 表格连到生成节点 → 生成节点按行批量生成（见 engine.ts 的 runTableBatch）：
 *             每行提示词 = 上游文本 + 节点提示词 + 该行「列名：值」；每行素材 = 节点自身输入 + 该行输入列素材。
 *
 * 和 NOVAI 相比的简化：输入列由连线自动推导（不做「钉住通道」）；出表一遍生成 + 失败修复一次（不做规划遍）；
 * 不做合并单元格。上限沿用：手工 200 列 / 5000 行，模型生成 40 列 / 200 行，单元格 20000 字。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { groupLabel, isStack } from "./stack";
import { durationTiers, genOf, inputsOf, isGenKind, outOf, srcOf, textOf, uid, type AnyParams, type GenKind, type InputRef, type ModelSpec, type VideoMode, type VideoParams } from "./model";
import { unmentionedInputs } from "./mentions";

export const TABLE_LIMITS = { cols: 200, rows: 5000, llmCols: 40, llmRows: 200, cell: 20000 };
export type TableData = {
  kind: "table"; version: 1;
  title: string;
  columns: string[];
  rows: string[][];
  /** 由哪个文本节点生成（重新出表时更新这张，而不是再建一张） */
  sourceId?: string;
  /** 旧版单列输入模式：只用来读旧文档，映射到第一通道（pair 视为沿用）；新写入一律走 inputModes */
  inputMode?: "auto" | "shared" | "sequence" | "pair";
  /** 每条输入通道的模式（key = "input-1"、"input-2"…）；没写过的通道默认「沿用」 */
  inputModes?: Record<string, ChannelMode>;
  /** inputModes 里由系统（出表声明 / 行文本推断）写入的通道 id；用户手点表头后移除，重新出表不能覆盖用户手设的模式 */
  inputModesAuto?: string[];
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
const MEDIA_EXT = /\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg)(?:[?#]\S*)?$/i;
/** 单行是不是素材地址：资源库引用 / blob / data:image|video|audio / 网络地址 / 本地路径 */
const isMediaLine = (s: string): boolean => {
  if (!s || /\s/.test(s)) return false;
  if (/^(?:(?:novai|openarc)-asset:|openarc-resource:|blob:|data:(?:image|video|audio)\/)/i.test(s)) return true;
  // NOVAI 宿主的素材是本地相对路径（novaiBackend 上传后拿到 /assets/…、/output/…），没有协议也没有查询串
  if (/^\/(?:assets|output)\//i.test(s)) return true;
  if (/^https?:\/\//i.test(s)) return MEDIA_EXT.test(s);
  // 其余只认「路径 / 文件名」形态：必须带媒体扩展名，且不是一句话（「把 a.jpg 换成 b.png」不能被当素材）
  return MEDIA_EXT.test(s) && (/[/\\]/.test(s) || !/[\u4e00-\u9fff]/.test(s));
};
/** 单元格里是不是素材（多行时看第一行，和旧的「以前缀开头」判断一致） */
export const isMediaRef = (v: string) => isMediaLine(String(v || "").trim().split(/\s*\n\s*/)[0] || "");
/** 图片列的单元格可以放多张（换行分隔） */
export const mediaRefsIn = (v: string) => String(v || "").split(/\s*\n\s*/).map((x) => x.trim()).filter(isMediaRef);
/** 表格缩略图的请求宽度：输入列 96、数据列图片格 192（对齐旧版 mediaPreviewUrl 的 size） */
export const TABLE_INPUT_PREVIEW_W = 96, TABLE_CELL_PREVIEW_W = 192;
/**
 * 缩略图地址（对齐旧版 static/js/shared/media.js 的 mediaPreviewUrl）：
 * NOVAI 本地素材（/assets/、/output/）走后端 /api/media-preview —— 后端会缩图，视频还会自动抽帧当封面；
 * http(s) / novai-asset: / data: / blob: 原样交给 <img>。
 */
export function previewThumbUrl(url: string, width = 512): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (!/^\/(?:assets|output)\//i.test(raw)) return raw;
  const w = Math.max(64, Math.min(2048, Math.round(Number(width) || 512)));
  return `/api/media-preview?w=${w}&url=${encodeURIComponent(raw)}`;
}
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

/** 系统写入过模式的通道 id（脏值丢弃）；用来区分「用户手点」和「出表自动写」 */
const autoModeIdsOf = (raw: unknown): string[] => Array.isArray(raw) ? [...new Set(raw.map((x) => String(x ?? "")).filter((x) => /^input-\d+$/.test(x)))] : [];
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
  return { kind: "table", version: 1, title: typeof r.title === "string" && r.title ? r.title : "多维表格", columns, rows, ...(typeof r.sourceId === "string" ? { sourceId: r.sourceId } : {}), ...(r.inputMode === "shared" || r.inputMode === "sequence" || r.inputMode === "pair" ? { inputMode: r.inputMode } : {}), ...(Object.keys(channelModesOf(r.inputModes)).length ? { inputModes: channelModesOf(r.inputModes) } : {}), ...(!llm && Array.isArray(r.inputModesAuto) ? { inputModesAuto: autoModeIdsOf(r.inputModesAuto) } : {}), ...(Array.isArray(r.roles) && !llm && r.roles.some((x) => isRole(x)) ? { roles: columns.map((_, i) => (isRole(r.roles && (r.roles as unknown[])[i]) ? String((r.roles as unknown[])[i]) : "")) } : {}) };
}
function normalizeLegacy(raw: unknown): TableData | null {
  const any = raw as any;
  const matrix: unknown[][] | null = Array.isArray(any) ? any : Array.isArray(any?.cells) ? any.cells : null;
  if (matrix && matrix.length) return normalizeTable({ columns: matrix[0], rows: matrix.slice(1) }, false);
  if (any && Array.isArray(any.columns)) return normalizeTable({ columns: any.columns, rows: Array.isArray(any.rows) ? any.rows : [] }, false);
  return null;
}

/** 模型声明的「每组素材怎么用」（对齐旧版 DX OS 规划的 inputGroups）：per-row → 逐行，every-row → 全部 */
export type InputGroupPlan = { group: number; rowMode: "per-row" | "every-row" };
/** 规划遍的结果（旧版 buildListPlanPrompt 的产物）：只用于生成遍提示词和行数对齐，不落表格数据 */
export type ListPlan = { inputGroups: InputGroupPlan[]; rowCount?: number };
/** 只透传、不参与表格数据：group 从 1 开始（= 输入通道编号），非法项丢弃 */
export function parseInputGroups(raw: unknown): InputGroupPlan[] {
  if (!Array.isArray(raw)) return [];
  const out: InputGroupPlan[] = [];
  raw.forEach((item) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!row) return;
    const group = Math.floor(Number(row.group));
    // 兼容 per_row / perRow 之类的写法，只认这两种语义
    const mode = String(row.rowMode || "").toLowerCase().replace(/_/g, "-").replace(/^perrow$/, "per-row").replace(/^everyrow$/, "every-row");
    if (!Number.isFinite(group) || group < 1 || (mode !== "per-row" && mode !== "every-row")) return;
    out.push({ group, rowMode: mode });
  });
  return out;
}
/**
 * 两遍 inputGroups 按 group 合并：primary（生成遍）优先，primary 没声明的 group 保留 secondary（规划遍）。
 * 不能整体替换——生成遍常常只回报它关心的那几组，整体替换会把规划遍对其它组的判断丢掉。
 */
export function mergeInputGroups(primary: InputGroupPlan[], secondary: InputGroupPlan[]): InputGroupPlan[] {
  const byGroup = new Map<number, InputGroupPlan>();
  for (const p of secondary) byGroup.set(p.group, p);
  for (const p of primary) byGroup.set(p.group, p);
  return [...byGroup.values()].sort((a, b) => a.group - b.group);
}
/** 解析模型返回（DX OS a6）：剥 ```json、取首尾大括号、JSON.parse、校验；顺带把 inputGroups 透传出来 */
export function parseTableReply(text: string): { table: TableData; inputGroups: InputGroupPlan[] } {
  let s = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s); if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("模型没有返回统一的多维表格格式");
  let obj: unknown; try { obj = JSON.parse(s.slice(a, b + 1)); } catch { throw new Error("模型没有返回统一的多维表格格式"); }
  const t = normalizeTable(obj, true);
  if (!t) throw new Error("模型没有返回统一的多维表格格式");
  if ((obj as any).columns.some((c: unknown) => !String(c ?? "").trim())) throw new Error("模型返回的表格列名不完整");
  if (!t.rows.length) throw new Error("LLM 没有生成可执行的多维表格。");
  return { table: t, inputGroups: parseInputGroups((obj as { inputGroups?: unknown }).inputGroups) };
}
export function parseTableJson(text: string): TableData { return parseTableReply(text).table; }

/** 规划遍提示词（对齐旧版 buildListPlanPrompt）：只要每组怎么用，不要 rows */
export function planPrompt(task: string, mode: TextOutputMode, groups: Array<{ name: string; count: number }>): string {
  const video = mode === "storyboard";
  return [
    video ? "你在为一个「多维表格 → 视频分镜批量生成」工作流做任务规划。" : "你在为一个「多维表格批量生成」工作流做任务规划。",
    "",
    "用户要求：",
    task,
    "",
    "可用输入（按画布连线分组；每一组 = 表格最左侧的一列「输入 N」）：",
    ...groups.map((g, i) => `第 ${i + 1} 组（输入 ${i + 1}）「${g.name}」${g.count} 张`),
    "",
    "必须为每一个输入组指定它在逐行执行里的用法 rowMode。判据是「这一组里的图彼此是什么关系」：",
    '- "per-row"（逐行）：同一组里是每行各一个不同主体/物品（例如一组不同款商品的静物图，一行换一个主体）。第 N 行只引用这一组的第 N 张；这一组有几张就几行。',
    '- "every-row"（全部）：同一组是同一个产品的多角度照片（例如同一产品的白底多角度图），整组是这一行的多角度参考，每一行都要用上整组。',
    '- 同一个主体的三视图 / 立绘 / 特写 / 姿势 / 多角度 / 白底 / 细节图都是 every-row：它们是同一主体的多套参考，每一行都要带上整组，绝不增加行数。',
    "一行具体引用哪一张，由「这一组是逐行还是全部」决定：逐行组按行号取一张，全部组整组都带上。",
    "行的数量由 per-row 的组决定；every-row 的组只增加每行带的素材数（多角度参考），不增加行数。",
    "补充判据（产品替换任务，非常重要）：",
    '- 如果任务是把 A 组里的产品替换成 B 组里的产品：A 组是「待替换的场景/参考图」，每组图彼此是不同场景或不同角度，**A 组用 per-row，A 组几张就几行**；',
    '- B 组是「用来替换的产品图/白底多角度图」，整组是同一件产品的不同角度，**B 组用 every-row，整组每行都要带上，绝不因为 B 组张数多就增加行数**；',
    "- 同一个产品的白底图/多角度图总数再多，也只是 every-row 的一组，不是多行；",
    "- rowCount 必须等于 per-row 组的张数。",
    ...(video ? ["本次产出直接接到视频生成：每一行 = 一个分镜；镜头数由用户要求决定，参考素材决定主体与风格的一致性。"] : []),
    "",
    "只做规划，不要输出最终 rows。",
    "请只返回一个 JSON 对象：",
    '{"rowCount":行数,"inputGroups":[{"group":1,"role":"这一组是什么","rowMode":"per-row 或 every-row","mapping":"如何映射到行"}]}',
    "不要 Markdown 代码块，不要解释。",
  ].join("\n");
}
/** 解析规划遍返回；解析不出来返回 null（调用方退回单遍出表，模式回落沿用） */
export function parseListPlan(text: string): ListPlan | null {
  let s = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s); if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let obj: unknown; try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const raw = obj as { inputGroups?: unknown; rowCount?: unknown };
  const inputGroups = parseInputGroups(raw.inputGroups);
  const rowCount = Math.floor(Number(raw.rowCount));
  if (!inputGroups.length) return null;
  return { inputGroups, ...(Number.isFinite(rowCount) && rowCount > 0 ? { rowCount } : {}) };
}
/** 规划遍没解析出来时的重试：只要求 rowCount + inputGroups，别让一次格式跑偏就丢掉模式 */
export function planRepairPrompt(task: string, mode: TextOutputMode, groups: Array<{ name: string; count: number }>): string {
  return [
    "上一次的规划不是合法 JSON。请只返回一个 JSON 对象，不要解释、不要 Markdown：",
    '{"rowCount":行数,"inputGroups":[{"group":1,"rowMode":"per-row"或"every-row"}]}',
    "",
    "用户要求：",
    task.slice(0, 2000),
    "",
    "输入组（组号 = 输入列编号；先判断每组是 per-row 还是 every-row）：",
    ...groups.map((g, i) => `第 ${i + 1} 组（输入 ${i + 1}）「${g.name}」${g.count} 张`),
    mode === "storyboard" ? "分镜表：rowCount = 镜头数，由用户要求决定。" : "rowCount 必须等于 per-row 组的张数；every-row 组整组每行都用，不增加行数。",
  ].join("\n");
}
/** 规划内容写进生成遍（对齐旧版把 plan 塞进 buildListGeneratePrompt） */
export function planTextOf(plan: ListPlan, groups: Array<{ name: string; count: number }>): string {
  const lines = groups.map((g, i) => {
    const hit = plan.inputGroups.find((p) => p.group === i + 1);
    const mode = hit ? (hit.rowMode === "per-row" ? "逐行（第 N 行用第 N 张）" : "全部（每行都带整组）") : "沿用（每行取一张，超出沿用最后一张）";
    return `第 ${i + 1} 组（输入 ${i + 1}）「${g.name}」${g.count} 张：${mode}`;
  });
  return [...(plan.rowCount ? [`规划行数：${plan.rowCount}`] : []), ...lines].join("\n");
}
/** 行数只由「逐行(per-row)」组决定：这些组的最大张数（channels 顺序 = 列给模型的上游来源顺序）；没有 per-row 组 → 0（不补不裁） */
export function perRowRowCount(channels: TableChannel[], plans: InputGroupPlan[]): number {
  const perRow = new Set(plans.filter((p) => p.rowMode === "per-row").map((p) => p.group));
  return channels.filter((_, i) => perRow.has(i + 1)).reduce((n, ch) => Math.max(n, ch.items.length), 0);
}

/** 出表提示词（DX OS BS 的 list 分支）。groups 是这次连进来的素材来源（第 i 个 = 输入通道 i），planText 是规划遍的结果 */
export function tablePrompt(task: string, mode: TextOutputMode, mediaCount: number, groups: Array<{ name: string; count: number }> = [], planText = ""): string {
  const cols = mode === "storyboard" ? `列固定为：${JSON.stringify(STORYBOARD_COLUMNS)}。每行是一个镜头。` : "请根据任务自行设计最合适的列结构，不套固定模板。";
  const groupText = groups.length
    ? ["素材已按输入通道分组（组号就是输入列编号，第 1 组在输入 1）：", ...groups.map((g, i) => `第 ${i + 1} 组（输入 ${i + 1}）「${g.name}」${g.count} 张`)]
    : [];
  return [
    "请把结果整理为可逐行执行的生成任务：每一行必须是一条完整、独立、可直接用于后续图像或视频生成的内容。",
    "严格遵守用户指定的数量；未指定时根据输入数量和任务目标合理决定。" + (mediaCount ? `当前有 ${mediaCount} 个素材输入：图片组通常逐张映射到各行，单图参考通常应用到所有相关行。` : ""),
    ...groupText,
    ...(planText ? ["", "已确认的规划（请严格按它执行）：", planText] : []),
    "每一组素材怎么用，由你按任务判断，并在 JSON 里用 inputGroups 声明（group 从 1 开始，对应上面的组号）。",
    "行数按「逐行」的组确定；「全部」的组每一行都带整组，不增加行数。",
    "不声明、行文本也没有明确说法时（默认「沿用」）：每行从这一组取一张，第 i 行取第 i 张，这一组张数不够时沿用最后一张——这是最常用的用法，不同素材不同行就靠它。",
    "没有声明 inputGroups 时，系统会按每一行文本里对这个输入组的说法判断：写「输入 2 整组」= 全部，写「输入 1 第 2 张」= 逐行；所以每一行都要写清楚是哪一组、怎么用。",
    '- "per-row"（逐行）：这一组是每行各用一张（不同主体 / 物品 / 款式），第 N 行用第 N 张；声明后这一组有几张就应有几行。',
    '- "every-row"（全部）：只用于「同一主体的多角度 / 多套参考，且确实希望每一行都带上整组」。它会让每一行多带整组素材，不要为了保险起见把每一组都声明成 every-row。',
    "「逐行」的组：第 N 行只能用这一组的第 N 张，绝不能引用同组其它行的图；每行就一张主体参考。",
    "「全部」的组：整组当作这一行的「多角度参考」，每一行都要用上整组的每一张（例如 5 张白底图就写「参考输入 2 的这 5 张白底多角度图」），不能只写其中一张。",
    "示例：第 1 组是 3 张静物图（逐行），第 2 组是同一个产品的 2 张白底多角度图（全部）→ 第 1 行 = 静物 1 + 白底 1、2；第 2 行 = 静物 2 + 白底 1、2；第 3 行 = 静物 3 + 白底 1、2。",
    "**产品替换**任务：待替换的「场景 / 参考图」组用 per-row（几张就几行）；用来替换的「产品图 / 白底多角度图」组用 every-row（整组每行都带上，绝不因为白底图张数多就增加行数）。",
    "产品替换的行数必须等于 per-row 组的张数；同一个产品的白底 / 多角度图再多，也只是一组 every-row，不是多行。",
    "同时回报每一组的用法 inputGroups：{\"group\":组号,\"rowMode\":\"per-row\"或\"every-row\"}。per-row = 行驱动（第 N 行用第 N 张）；every-row = 每一行都要用上整组。",
    "没有声明 per-row 时，表格行数按用户要求确定（例如「每行一个场景」就按场景组的张数）；同一主体的三视图 / 姿势 / 多角度 / 白底产品图整组每行都用、不增加行数；只有实在判断不了时才用素材最多那组的张数。",
    "如果任务区分了「目标主体」和「风格/版式参考」，每行内容都必须显式写清它们的关系。",
    "不要只写「使用图1」「参考图2」这类占位说明，每个文字单元格都要有足够的信息密度。",
    cols,
    "行的先后顺序已经表达执行顺序，不需要额外的序号列。",
    "不要在 JSON 中创建图片、参考图或生成输入列，系统会在独立的输入列里放素材。",
    "只返回一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
    '{"kind":"table","version":1,"inputGroups":[{"group":1,"rowMode":"per-row"}],"columns":["列名1","列名2"],"rows":[["单元格1","单元格2"]]}',
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
  /** 来自输入通道时的通道身份：名字 + 编号 + 通道内第几张 / 通道共几张（截断告警和参考图清单要用） */
  channel?: string; channelId?: string; channelPos?: number; channelTotal?: number;
};
/**
 * 输入通道：一个上游来源 = 一列「输入 N」（对齐旧版 static/js/shared/table-node.js 的 Co / ab 与
 * table-model.js 的 normalizeChannels / inputItemsForRow）。每条通道有自己的模式：
 *   sequence（逐行）→ items[row]，越界为空；all（全部）→ 整列；shared（沿用）→ items[min(row, len-1)]。
 * 分组 / 堆叠整组算一条通道，组里的图**只进通道**，不再写进数据列。
 */
export type ChannelMode = "sequence" | "all" | "shared";
/** 表头点一下按这个顺序循环：逐行 → 全部 → 沿用 */
export const CHANNEL_MODES: ChannelMode[] = ["sequence", "all", "shared"];
export const CHANNEL_MODE_LABEL: Record<ChannelMode, string> = { sequence: "逐行", all: "全部", shared: "沿用" };
export const channelIdAt = (index: number) => "input-" + (Math.max(0, Math.floor(index)) + 1);
export function channelIndexFromId(id: string): number {
  const m = /^input-(\d+)$/.exec(String(id || ""));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n - 1 : -1;
}
const isChannelMode = (x: unknown): x is ChannelMode => x === "sequence" || x === "all" || x === "shared";
/** 只保留合法的通道模式（读旧文档、写回前都走这里，脏值一律丢掉回落「沿用」） */
export function channelModesOf(raw: unknown): Record<string, ChannelMode> {
  const out: Record<string, ChannelMode> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) if (/^input-\d+$/.test(key) && isChannelMode(value)) out[key] = value as ChannelMode;
  return out;
}
export type TableChannel = {
  id: string;
  /** 这条通道来自哪个上游节点（分组 / 堆叠 / 单个素材节点） */
  sourceId: string;
  title: string;
  mode: ChannelMode;
  items: TableMedia[];
};
/** 能当输入列来源的节点：图片 / 视频 / 音频 / 分组（文本走提示词上下文，表格不能再套表格） */
const isChannelSource = (n: CanvasNode) => n.kind === "image" || n.kind === "video" || n.kind === "audio" || n.kind === "group";
/**
 * 分组 / 堆叠递归展开到最内层节点：普通分组按画布位置从上到下、从左到右，堆叠保持叠内顺序；
 * 嵌套分组在父组里占它自己的位置，内层再按同样规则展开（组里套组不再丢图）。
 */
function groupMembersDeep(doc: CanvasDoc, g: CanvasNode): CanvasNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const walk = (node: CanvasNode): CanvasNode[] => {
    if (seen.has(node.id)) return [];
    seen.add(node.id);
    const list = (node.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n);
    if (!isStack(node)) list.sort((a, b) => a.y - b.y || a.x - b.x);
    return list.flatMap((child) => (child.kind === "group" ? walk(child) : [child]));
  };
  return walk(g);
}
/** 一个来源的素材：分组 / 堆叠递归展开成组内成员，只要已经出结果的 */
function channelItemsOf(doc: CanvasDoc, ref: InputRef): TableMedia[] {
  const seen = new Set<string>();
  const nodes = ref.node.kind === "group" ? groupMembersDeep(doc, ref.node) : [ref.node];
  return nodes
    .filter((x) => isGenKind(x.kind) && x.kind !== "text" && !!outOf(x))
    .filter((x) => {
      const key = x.id + "#" + (outOf(x)?.url || "");
      if (seen.has(key)) return false;
      seen.add(key); return true;
    })
    .map((x) => ({ nodeId: x.id, kind: x.kind as GenKind, title: genOf(x).title, src: srcOf(x), url: outOf(x)?.url }));
}
/** 某个上游节点自己的素材（出表时算通道默认模式、给模型附参考图都用它） */
export function channelItemsOfSource(doc: CanvasDoc, sourceId: string): TableMedia[] {
  const n = doc.nodes.find((x) => x.id === sourceId);
  return n && isChannelSource(n) ? channelItemsOf(doc, { edge: { id: "src:" + sourceId, from: sourceId, to: "" }, node: n, order: 0 }) : [];
}
/**
 * 表格的输入通道：表格每条「素材来源」入边一条通道，顺序按入边顺序。
 * 旧文档 / 出表之前没有直连素材时，兜底用生成它的文本节点（sourceId）的上游来源。
 * 没有结果也保留通道（items 为空），这样用户能看到这一列绑的是哪个来源。
 */
export function tableChannels(doc: CanvasDoc, tableId: string): TableChannel[] {
  const tn = doc.nodes.find((n) => n.id === tableId);
  const t = tn ? tableOf(tn) : null;
  let refs = inputsOf(doc, tableId).filter((x) => isChannelSource(x.node));
  if (!refs.length && t?.sourceId) refs = inputsOf(doc, t.sourceId).filter((x) => isChannelSource(x.node));
  const modes = channelModesOf(t?.inputModes);
  const legacy = t?.inputMode;
  return refs.map((x, i) => {
    const id = channelIdAt(i);
    // 旧字段 inputMode 只映射第一通道（pair / auto 都按「沿用」）
    const mode = modes[id] || (id === "input-1" && legacy === "sequence" ? "sequence" : "shared");
    return { id, sourceId: x.node.id, title: isGenKind(x.node.kind) ? genOf(x.node).title : groupLabel(x.node), mode, items: channelItemsOf(doc, x) };
  });
}
/** 这一行该通道取到哪些素材（旧版 ab()）：逐行越界为空、全部整列、沿用超出后取最后一张 */
export function channelItemsForRow(ch: TableChannel, row: number): TableMedia[] {
  const items = ch.items || [];
  if (!items.length) return [];
  const index = Math.max(0, Math.floor(row) || 0);
  if (ch.mode === "all") return items.slice();
  if (ch.mode === "sequence") return items[index] ? [items[index]] : [];
  const last = items[Math.min(index, items.length - 1)];
  return last ? [last] : [];
}
/**
 * 模型声明的这条通道（第 group 条，1 起）的模式：per-row→逐行、every-row→全部。
 * 没声明返回 ""——**调用方不要写 inputModes**，读出来自然回落「沿用」（旧版 channelModeFor 就是 shared），
 * 这样默认值不会被一次出表锁死在数据里。
 */
export function plannedChannelMode(group: number, plans: InputGroupPlan[]): ChannelMode | "" {
  const hit = plans.find((p) => p.group === group);
  if (!hit) return "";
  return hit.rowMode === "per-row" ? "sequence" : "all";
}

/**
 * 没有模型 / 规划遍声明的 inputGroups 时，只从**模型返回的行文本**里找证据：
 *   行文本出现「输入 i 整组 / 全部 / 所有 / 每张」→ 这条通道是「全部」；
 *   出现「输入 i 第 k 张」（或「第 k 张 … 输入 i」）→ 这条通道是「逐行」。
 * 没有任何证据的通道不返回（不写 inputModes，保持既有「沿用」默认，不按组名瞎猜）。
 */
export function inferChannelModesFromRows(t: TableData, channels: TableChannel[]): Record<string, ChannelMode> {
  const text = t.rows.flat().join("\n");
  const out: Record<string, ChannelMode> = {};
  if (!text.trim() || !channels.length) return out;
  const ALL = /整组|全部|全组|所有|整列|每一张|每张|都用/;
  const refRe = /输入\s*(\d+)(?!\d)/g;   // 数字边界：输入 1 不能命中「输入 10」
  const all = new Set<number>(); const seq = new Set<number>();
  // 按句 / 行切段，避免跨句把别的组的「整组」算进来
  for (const seg of text.split(/[\n；;。！!？?]/)) {
    const refs: Array<{ n: number; start: number; end: number }> = [];
    for (const m of seg.matchAll(refRe)) {
      const n = Number(m[1]); if (!Number.isFinite(n) || n < 1) continue;
      const start = m.index ?? 0; refs.push({ n, start, end: start + m[0].length });
    }
    // 输入 N 之后 16 字窗口内的说法；遇到下一个「输入 N」/「第 k 张」就截断（避免串到下一组）
    const tailOf = (i: number) => {
      const tail = seg.slice(refs[i].end, refs[i].end + 16);
      const stop = tail.search(/输入\s*\d+(?!\d)/);
      return stop >= 0 ? tail.slice(0, stop) : tail;
    };
    refs.forEach((r, i) => {
      const tail = tailOf(i);
      if (ALL.test(tail)) all.add(r.n);
      else if (/第\s*\d+\s*张/.test(tail)) seq.add(r.n);
    });
    // 并列：「输入 1、输入 2 整组」「输入 1 和 输入 2 第 2 张」→ 共享最后一个输入组后面的说法
    for (let i = 0; i < refs.length; i++) {
      let j = i;
      while (j + 1 < refs.length && /^\s*(?:、|和|与|及|,|，|\/|\+)\s*$/.test(seg.slice(refs[j].end, refs[j + 1].start))) j++;
      if (j > i) {
        const tail = tailOf(j);
        for (let k = i; k <= j; k++) {
          if (ALL.test(tail)) all.add(refs[k].n);
          else if (/第\s*\d+\s*张/.test(tail)) seq.add(refs[k].n);
        }
      }
      i = j;
    }
    // 倒装：「第 2 张来自输入 10」→ 逐行；同样要数字边界
    for (const m of seg.matchAll(/第\s*\d+\s*张[^\n。；;，,]{0,16}?输入\s*(\d+)(?!\d)/g)) {
      const n = Number(m[1]); if (Number.isFinite(n) && n >= 1) seq.add(n);
    }
  }
  channels.forEach((ch, i) => {
    const n = i + 1;
    if (all.has(n)) out[ch.id] = "all";
    else if (seq.has(n)) out[ch.id] = "sequence";
  });
  return out;
}
/**
 * 表格常驻告警：行文本里引用了不存在的「输入 N」；或表格上还挂着不在这次提示词组里的旧通道。
 * TableNode / 批量面板都读它，不能只靠 toast。
 */
export function tableInputWarnings(doc: CanvasDoc, tableId: string, channelsIn?: TableChannel[]): string[] {
  const tn = doc.nodes.find((n) => n.id === tableId);
  if (!tn || tn.kind !== "table") return [];
  const t = tableOf(tn);
  const channels = channelsIn || tableChannels(doc, tableId);
  const warns: string[] = [];
  const bad = new Set<number>();
  for (const row of t.rows) for (const cell of row) {
    for (const hit of String(cell || "").matchAll(/输入\s*(\d+)/g)) {
      const n = Number(hit[1]);
      if (!Number.isFinite(n) || n < 1 || n > channels.length) bad.add(n);
    }
  }
  if (bad.size) {
    warns.push(`行文本引用了 ${[...bad].sort((a, b) => a - b).map((n) => `「输入 ${n}」`).join("、")}，但表格只有 ${channels.length} 条输入通道——提示词里的组号可能过期，请重新出表或改行文本。`);
  }
  const sourceNode = t.sourceId ? doc.nodes.find((n) => n.id === t.sourceId) : undefined;
  if (sourceNode) {
    const srcIds = new Set(inputsOf(doc, sourceNode.id).filter((x) => isChannelSource(x.node)).map((x) => x.node.id));
    const extra = channels.filter((ch) => !srcIds.has(ch.sourceId));
    if (extra.length) {
      warns.push(`表格上还有 ${extra.length} 条不在这次提示词组里的输入通道：${extra.map((ch) => `输入 ${channelIndexFromId(ch.id) + 1}「${ch.title}」`).join("、")}（已排在最后；不需要可以删掉那条连线）。`);
    }
  }
  return warns;
}
/** 生成节点上游所有表格的常驻告警（批量面板用） */
export function batchInputWarnings(doc: CanvasDoc, genId: string): string[] {
  return inputsOf(doc, genId).filter((x) => x.node.kind === "table").flatMap((x) => tableInputWarnings(doc, x.node.id));
}

/** 裁到 need 行（保留前 need 行，最少留 1 行）；没有 per-row 组（need = 0）时不动，避免误删纯文字行 */
export function trimTableRows(t: TableData, need: number): TableData {
  if (need <= 0) return t;
  const target = Math.max(1, Math.floor(need));
  return t.rows.length > target ? { ...t, rows: t.rows.slice(0, target) } : t;
}
/** 行数不够时补空行（不改已有行内容） */
export function padTableRows(t: TableData, need: number): TableData {
  if (t.rows.length >= need) return t;
  const add = Array.from({ length: need - t.rows.length }, () => t.columns.map(() => ""));
  return { ...t, rows: [...t.rows, ...add] };
}
/** 行数不足的一次修复请求：把现有表发给模型，让它补到 need 行 */
export function growRowsPrompt(t: TableData, need: number): string {
  const json = JSON.stringify({ kind: "table", version: 1, columns: t.columns, rows: t.rows }).slice(0, 30000);
  return `行数不足：素材共 ${need} 张，请把表格补到 ${need} 行，保留已有行的内容，每行写清这一行怎么用第 i 张素材，只返回 JSON。\n\n${json}`;
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
    // 旧版 Df 去重：同一 nodeId / url 只发一次；数据列里手动放的图带角色（首帧 / 尾帧 / 参考图），以它为准
    const pushMedia = (x: TableMedia) => {
      const url = x.url || x.src;
      const at = media.findIndex((y) => (!!x.nodeId && y.nodeId === x.nodeId) || (!!url && (y.url || y.src) === url));
      if (at < 0) { media.push(x); return; }
      const cur = media[at];
      // 首帧 / 尾帧是两个位置：同一张图被同时写成这两个单元格时都留着，别让去重吃掉一个角色
      if (x.as && cur.as && x.as !== cur.as) { media.push(x); return; }
      if (x.as && !cur.as) media[at] = x;
    };
    for (const tn of tables) {
      const t = tableOf(tn); const roles = rolesOf(t);
      tableChannels(doc, tn.id).forEach((ch) => channelItemsForRow(ch, r).forEach((m) => {
        // 通道内第几张 / 共几张：截断告警点名、参考图清单标「整组 / 第 k 张」都要用
        const pos = ch.items.indexOf(m) + 1;
        pushMedia({ ...m, channel: ch.title, channelId: ch.id, ...(pos > 0 ? { channelPos: pos } : {}), ...(ch.items.length ? { channelTotal: ch.items.length } : {}) });
      }));
      (t.rows[r] || []).forEach((v, i) => {
        const val = (v || "").trim(); if (!val || (skip && skip.table === tn.id && skip.col === i)) return;
        const role = roles[i].role; const name = t.columns[i];
        if (ROLE_META[role].media) {
          const refs = mediaRefsIn(val);
          if (refs.length) { refs.slice(0, role === "ref" ? 8 : 1).forEach((u, k) => pushMedia({ nodeId: `cell:${tn.id}:${r}:${i}:${k}`, kind: "image", title: `${name} · 行${r + 1}`, src: u, url: u, as: role as "first" | "last" | "ref" })); return; }
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
export type RowInput = { nodeId: string; title: string; kind: GenKind; url: string; role: "reference" | "first_frame" | "last_frame" | "source_video" | "driving_audio" | "context"; channel?: string; channelId?: string; channelPos?: number; channelTotal?: number };
/** 参考图清单只看这几类图（上下文 / 视频 / 音频不占「图 N」的位置） */
export type RefOrderItem = { kind: string; role: string; title?: string; channel?: string; channelId?: string; channelPos?: number; channelTotal?: number };
/**
 * 系统生成的「参考图顺序」清单：把扁平的图片列表和提示词里的「输入 N / 图 N」对上，
 * 模型只会看图片列表时也能知道第几张是哪一组、是不是整组。只在表格批量行请求里追加。
 */
export function refOrderText(items: RefOrderItem[]): string {
  const imgs = items.filter((x) => x.kind === "image" && (x.role === "reference" || x.role === "first_frame" || x.role === "last_frame"));
  if (!imgs.length) return "";
  const runs: Array<{ start: number; end: number; first: RefOrderItem }> = [];
  imgs.forEach((x, i) => {
    const last = runs[runs.length - 1];
    const sameChannel = !!(last && x.channelId && last.first.channelId === x.channelId);
    const nextPos = last ? (last.first.channelPos || 0) + (i - last.start) : 0;
    if (last && sameChannel && (x.channelPos || 0) === nextPos) last.end = i;
    else runs.push({ start: i, end: i, first: x });
  });
  const lines = runs.map((run) => {
    const x = run.first; const n = channelIndexFromId(x.channelId || "") + 1;
    const count = run.end - run.start + 1;
    const range = count > 1 ? `图${run.start + 1}-${run.end + 1}` : `图${run.start + 1}`;
    if (n < 1) return `${range}=${x.title ? `「${x.title}」` : "参考图"}`;
    const name = x.channel ? `「${x.channel}」` : "";
    const pos = x.channelPos || 1;
    const whole = !!x.channelTotal && x.channelTotal > 1 && count >= x.channelTotal;
    const where = whole ? `整组（第${pos}-${pos + count - 1}张）` : count > 1 ? `第${pos}-${pos + count - 1}张` : `第${pos}张`;
    return `${range}=输入${n}${name}${where}`;
  });
  return ["参考图顺序（系统按输入通道排好，下面说的「图 N」就是这次请求里的第 N 张图）：", ...lines].join("\n");
}
export type RowPlan = { params: AnyParams; inputs: RowInput[]; warnings: string[]; /** 这一行自带了图：生成节点自己连的图片不再发送，免得首帧打架 */ ownImages: boolean };
/**
 * 生成节点自己连的图片数：这些图会和行素材一起发送，但只有图片批量会发（视频行请求里 plan.ownImages=true，
 * 自身连的图会被 buildRequest 主动挡掉），所以只对图片节点预留参考图名额。
 * 只算「最终会发送」的：引用模式下没被 @ 的自身图不算。
 */
export function ownRefCount(doc: CanvasDoc, genId: string, kind: GenKind): number {
  if (kind !== "image") return 0;
  const node = doc.nodes.find((n) => n.id === genId); if (!node) return 0;
  const all = inputsOf(doc, genId);
  const skip = unmentionedInputs(node, all);
  return all.filter((x) => x.node.kind === "image" && !!outOf(x.node)?.url && !skip.has(x.edge.id)).length;
}
/**
 * 一行的请求怎么组（纯函数，便于测试）：
 *   时长 / 比例列覆盖参数（时长取模型支持的最接近值）；
 *   视频：有首帧 + 尾帧 → 首尾帧；只有首帧 → 首帧；只有参考图 → 参考生视频；模型不支持时降级并给出说明；
 *   图片：这一行的图都当参考图（按模型上限截断；reservedRefs = 生成节点自身参考图占用的名额，行素材只能用剩下的）。
 */
export function planRow(kind: GenKind, params: AnyParams, m: ModelSpec | undefined, row: BatchRow, reservedRefs = 0): RowPlan {
  const warnings: string[] = []; const p = { ...(params as Record<string, unknown>) } as Record<string, unknown>;
  if (row.ratio && (kind === "image" || kind === "video")) {
    if (!m?.ratios?.length || m.ratios.includes(row.ratio)) p.ratio = row.ratio; else warnings.push(`比例 ${row.ratio} 该模型不支持，沿用 ${p.ratio}`);
  }
  if (row.dur != null && kind === "video") {
    const want = Number(row.dur);
    const tiers = durationTiers(m?.durs);
    const nearest = (values: number[]) => values.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a), values[0]);
    const d = !Number.isFinite(want) ? (tiers.positive[0] ?? (tiers.auto ? -1 : 5))
      : tiers.auto && want <= 0 ? -1
      : tiers.positive.length ? nearest(tiers.positive)
      : (m?.durs?.length ? nearest(m.durs) : Math.round(want));
    if (d !== want) warnings.push(`时长 ${want}s 按模型改为 ${d < 0 ? "自动" : d + "s"}`);
    p.dur = d;
  }
  const out: RowInput[] = [];
  const add = (x: TableMedia, role: RowInput["role"]) => out.push({ nodeId: x.nodeId, title: x.title, kind: x.kind, url: x.url || x.src, role, ...(x.channel ? { channel: x.channel } : {}), ...(x.channelId ? { channelId: x.channelId } : {}), ...(x.channelPos ? { channelPos: x.channelPos } : {}), ...(x.channelTotal ? { channelTotal: x.channelTotal } : {}) });
  // 超上限时点名被截的通道：不能只报「超过 N 张」，用户看不出是哪一列被截了
  const cutDetail = (imgs: TableMedia[], cap: number): string => {
    const groups = new Map<string, { sent: number; total: number }>();
    imgs.forEach((x, i) => { const key = x.channel || ""; const g = groups.get(key) || { sent: 0, total: 0 }; g.total++; if (i < cap) g.sent++; groups.set(key, g); });
    return [...groups].filter(([key, g]) => key && g.sent < g.total).map(([key, g]) => `「${key}」${g.total} 张只发送 ${g.sent} 张`).join("、");
  };
  const imgs = row.media.filter((x) => x.kind === "image");
  row.media.filter((x) => x.kind !== "image").forEach((x) => add(x, x.kind === "video" ? "source_video" : x.kind === "audio" ? "driving_audio" : "context"));
  const done = (ownImages: boolean): RowPlan => ({ params: p as AnyParams, inputs: out, warnings, ownImages });
  if (!imgs.length) return done(false);
  if (kind !== "video") {
    const totalCap = kind === "image" ? (m ? (m.i2i ? m.maxRefs ?? 0 : 0) : imgs.length) : imgs.length;
    // 生成节点自身连的参考图先占名额，行素材只能用剩下的（reserved 超过上限时夹到上限，绝不让总数超 maxRefs）
    const reserved = kind === "image" ? Math.max(0, Math.min(Math.floor(reservedRefs) || 0, totalCap)) : 0;
    const cap = Math.max(0, totalCap - reserved);
    imgs.slice(0, cap).forEach((x) => add(x, "reference"));
    if (imgs.length > cap) {
      const cut = cutDetail(imgs, cap); const detail = cut ? `（${cut}）` : "";
      if (!totalCap) warnings.push(`该模型不支持参考图，这一行的图片没有发送${detail}`);
      else if (!cap) warnings.push(`参考图名额已被生成节点自身的参考图占满（${reserved}/${totalCap} 张），这一行的图片没有发送${detail}`);
      else warnings.push(`参考图超过模型上限 ${totalCap} 张${reserved ? `（其中自身参考图占 ${reserved} 张）` : ""}，多出的没有发送${detail}`);
    }
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
    if (refs.length > cap) {
      const cut = cutDetail(refs, cap);
      warnings.push(`参考图超过模型上限 ${cap} 张，多出的没有发送${cut ? `（${cut}）` : ""}`);
    }
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
export type BatchJournal = { runId: string; rows: Array<{ row: number; status: "pending" | "running" | "completed" | "failed"; nodeId?: string; error?: string; /** 开跑前算出的这一行提醒（截断 / 降级等），批量面板可复查 */ warn?: string }> };
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

/* ---------- CSV 导入 / 导出 ---------- */
/** RFC4180：含逗号、引号、换行的字段用双引号包住，内部双引号翻倍 */
const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/**
 * 表格 → CSV 文本：第一行是列名，其余是数据行；不含左侧「输入 N」通道列（那是画布连线推导出来的，不属于表格数据）。
 * 行尾用 CRLF（RFC4180 与 Excel 都认）。
 */
export function csvFromTable(t: TableData): string {
  const line = (row: string[]) => t.columns.map((_, i) => csvCell(row[i] ?? "")).join(",");
  return [line(t.columns), ...t.rows.map(line)].join("\r\n");
}
/** 首行引号外哪个分得多就当分隔符：Excel 复制出来是制表符，导出的文件是逗号 */
function sniffDelimiter(text: string): "," | "\t" {
  let quoted = false, tabs = 0, commas = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') i++; else quoted = false; } continue; }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "\n" || ch === "\r") break;
    if (ch === "\t") tabs++; else if (ch === ",") commas++;
  }
  return tabs > commas ? "\t" : ",";
}
/** 按 RFC4180 解析成二维数组：双引号字段可含分隔符 / 换行，"" 表示一个双引号；CRLF、CR、LF 都算换行 */
function parseDelimited(text: string): { rows: string[][]; delimiter: "," | "\t" } {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const delimiter = sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (src[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false; continue;
    }
    if (ch === '"' && !cell) { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; continue; }
    if (ch === "\r" || ch === "\n") { if (ch === "\r" && src[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return { rows, delimiter };
}
export type CsvImport = {
  table: TableData;
  /** 超过 TABLE_LIMITS 被截掉的行 / 列数（0 = 没截），由调用方 toast 说明 */
  droppedRows: number;
  droppedCols: number;
  delimiter: "," | "\t";
};
/**
 * CSV / TSV 文本 → 表格：第一行是列名（空列名、重名回落「字段 N」），其余是数据行；
 * 单元格原样保留（@引用、图片地址、换行都不动），只按 TABLE_LIMITS 截断。
 * 替换当前表：保留 title / sourceId / inputModes，roles 按列位置沿用（新列给空 role）。
 * 空内容或解析不出列返回 null（调用方 toast 报错，不改表格）。
 */
export function tableFromCsv(text: string, prev?: TableData | null): CsvImport | null {
  const { rows, delimiter } = parseDelimited(String(text ?? ""));
  // 只削掉首尾的空白行（粘贴时多敲的换行）；中间的空行是真数据，保留
  const blank = (r: string[]) => !r.some((c) => c.trim() !== "");
  let from = 0, to = rows.length;
  while (from < to && blank(rows[from])) from++;
  while (to > from && blank(rows[to - 1])) to--;
  const data = rows.slice(from, to);
  if (!data.length) return null;
  const header = data[0], body = data.slice(1);
  const width = Math.max(header.length, ...body.map((r) => r.length));
  if (width < 1) return null;
  const used = new Set<string>();
  const names = Array.from({ length: width }, (_, i) => {
    const raw = (header[i] ?? "").trim();
    let name = raw && !used.has(raw) ? raw : `字段 ${i + 1}`;
    if (used.has(name)) { let k = 2; while (used.has(`${name} (${k})`)) k++; name = `${name} (${k})`; }
    used.add(name);
    return name.slice(0, 120);
  });
  const columns = names.slice(0, TABLE_LIMITS.cols);
  const kept = body.slice(0, TABLE_LIMITS.rows);
  // 内嵌的 data URL 图片不截断，截了图就坏了（和 normalizeTable 一致）
  const cell = (v: string) => (/^data:image\//.test(v) ? v : v.slice(0, TABLE_LIMITS.cell));
  const inputModes = channelModesOf(prev?.inputModes);
  const inputModesAuto = autoModeIdsOf(prev?.inputModesAuto);
  const roles = columns.map((_, i) => (isRole(prev?.roles?.[i]) ? String(prev!.roles![i]) : ""));
  return {
    table: {
      kind: "table", version: 1,
      title: prev?.title || "多维表格",
      columns,
      rows: kept.map((r) => columns.map((_, i) => cell(r[i] ?? ""))),
      ...(prev?.sourceId ? { sourceId: prev.sourceId } : {}),
      // 旧文档只有 inputMode（只映射第一通道），留着免得导入后通道模式跳回默认
      ...(prev?.inputMode ? { inputMode: prev.inputMode } : {}),
      ...(Object.keys(inputModes).length ? { inputModes } : {}),
      ...(prev && Array.isArray(prev.inputModesAuto) ? { inputModesAuto } : {}),
      ...(roles.some(Boolean) ? { roles } : {}),
    },
    droppedRows: body.length - kept.length,
    droppedCols: names.length - columns.length,
    delimiter,
  };
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
export type GroupInput = { groupId: string; name: string; role: "first" | "last" | "ref"; images: Array<{ nodeId: string; title: string; url: string }>; /** 这组在输入通道里的编号（1 起，= 提示词里的「输入 N」）；由 engine 按 sources 顺序补上 */ channel?: number };
/** 组里的图片（有结果的才算）：堆叠按叠内顺序，分组按画布位置从上到下、从左到右 */
export function groupImages(doc: CanvasDoc, g: CanvasNode): Array<{ nodeId: string; title: string; url: string }> {
  return (g.kind === "group" ? groupMembersDeep(doc, g) : [])
    .filter((n) => n.kind === "image" && outOf(n)?.url)
    .map((n) => ({ nodeId: n.id, title: genOf(n).title, url: outOf(n)!.url! }));
}
/** 批量图片的分组都作为参考图；批量视频才按组名 / 连线顺序分配首帧、尾帧与参考图。 */
export function groupInputs(doc: CanvasDoc, id: string, intent: TableGenKind = "video"): GroupInput[] {
  const gs = inputsOf(doc, id).filter((x) => x.node.kind === "group").map((x) => x.node);
  // 名字统一走 groupLabel（堆叠重命名后 tableChannels / groupInputs / 提示词组名一致）
  const named = gs.map((g) => { const name = groupLabel(g); const r = intent === "image" ? "ref" : guessRole(name); return { g, name, role: r === "first" || r === "last" || r === "ref" ? r : null }; });
  const taken = new Set(named.map((x) => x.role).filter(Boolean));
  return named.map(({ g, name, role }) => {
    let r = role;
    if (!r) { r = !taken.has("first") ? "first" : !taken.has("last") ? "last" : "ref"; taken.add(r); }
    return { groupId: g.id, name, role: r, images: groupImages(doc, g) };
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
    `素材分组：${groups.map((g) => `「${g.name}」${g.images.length} 张${g.channel ? `（输入 ${g.channel}）` : ""}，作为每一行的${ROLE_META[g.role].label}`).join("；")}。`,
    "表格行数按用户要求确定（例如「每行一个场景」就按场景组的张数）；同一主体的三视图 / 姿势 / 多角度 / 白底产品图整组是每一行都要用的参考，不增加行数；只有实在判断不了时才用素材最多那组的张数。素材由系统放进独立的输入通道列（输入 N），不要在表里创建图片列。",
    "每一行的提示词都要对每个输入组写清用法：要整组就写「输入 2 整组」（同一主体的三视图 / 姿势 / 多角度产品图都写整组）；只取其中一张就写「输入 1 第 2 张」。不要只写「参考图」「图 1」这类看不出是哪一组的说法。",
    instruction,
  ].join("");
}
/* ---------- 尺寸（DX OS Yw / mR，按我们的节点比例收一点） ---------- */
/** 输入通道列宽 112（对齐旧版 table-node.js 的 .table-input-column） */
export const TABLE_COL_W = 132, TABLE_INPUT_COL_W = 112, TABLE_HEAD_H = 34;
/** 12px 字号下 132px 列宽一行大约放 10 个汉字（半角约 18 个）；行高按 1.5 倍行距 = 18px 算 */
const ROW_LINE_H = 18, ROW_CHARS_PER_LINE = 10;
/** 一段文字按「汉字 1 个字宽、半角 0.55 个字宽」估算占几行（旧版直接 len/16，中文被估少一半） */
function estimateLines(text: string): number {
  if (!text) return 1;
  let width = 0;
  for (const ch of text) width += /[\u2e80-\u9fff\uff00-\uff60\u3000-\u303f]/.test(ch) ? 1 : 0.55;
  return Math.max(1, Math.ceil(width / ROW_CHARS_PER_LINE));
}
export function rowHeight(cells: string[], hasMedia: boolean): number {
  // 图片单元格（资源引用）按一张缩略图算，不按引用串的长度算行数
  const img = cells.some((c) => isMediaRef(c));
  const lines = Math.max(1, ...cells.map((c) => (isMediaRef(c) ? 1 : estimateLines(c || ""))));
  // 上限 240 = 单元格自己的显示上限（TableNode.CELL_MAX.node），再多就格内滚动而不是把行撑到看不见
  return Math.min(240, Math.max(hasMedia || img ? 84 : 40, 20 + lines * ROW_LINE_H));
}
/** 输入列缩略图：40px 一张，112px 列宽一行放 2 张；超过 9 张才折叠成「+N」 */
export const TABLE_INPUT_THUMB = 40, TABLE_INPUT_PER_LINE = 2, TABLE_INPUT_MAX_SHOWN = 9;
/** 输入格显示几张（第 10 张起折叠） */
export const inputCellShown = (count: number) => Math.min(Math.max(0, Math.floor(count) || 0), TABLE_INPUT_MAX_SHOWN);
/** 输入格高度：有几张就显示几张，行高跟着涨（不再固定 84px 把第 5 张藏起来） */
export function inputCellHeight(count: number): number {
  const shown = inputCellShown(count);
  if (!shown) return 0;
  return Math.ceil(shown / TABLE_INPUT_PER_LINE) * (TABLE_INPUT_THUMB + 4) + 12;
}
/**
 * 节点尺寸：宽度按输入通道数预留（每条通道一列 112px）；高度按行高，
 * 传入通道时输入格里素材多的行也要算进去，避免 5 张缩略图把行撑破。
 */
export function tableAutoSize(t: TableData, inputChannels: number | TableChannel[]): { w: number; h: number } {
  const channels = Array.isArray(inputChannels) ? inputChannels : null;
  const count = channels ? channels.length : Math.max(0, inputChannels as number);
  const rowOf = (row: string[], index: number) => {
    const items = channels ? channels.reduce((n, ch) => Math.max(n, channelItemsForRow(ch, index).length), 0) : 0;
    return Math.max(rowHeight(row, count > 0), inputCellHeight(items));
  };
  // 上限 1600：多通道 + 多数据列会超过 800，和 reactCanvasStore 里 table 的宽度上限保持一致
  // 带输入通道的表默认至少 650：420 宽下提示词列只能露出半列，用户以为表格只有输入列
  const w = Math.max(count > 0 ? 650 : 320, Math.min(1600, count * TABLE_INPUT_COL_W + t.columns.length * TABLE_COL_W + 36));
  const h = Math.min(640, TABLE_HEAD_H + t.rows.reduce((s, row, i) => s + rowOf(row, i), 0) + 40);
  return { w, h: Math.max(160, h) };
}
export const newTableId = () => uid("t");
export { textOf };
