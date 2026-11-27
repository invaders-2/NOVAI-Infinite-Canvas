/**
 * 多维表格「智能」数据层（BEAT / React 画布）：AI 列（智能列）、选区批量改写、差异对比、快照回滚。
 *
 * 语义与旧画布 static/js/shared/table-model.js 的对应函数逐条对齐（同一套提示词与容错解析），
 * 那里是已验收的实现，这里只换成 TS + BEAT 的表格口径（单元格一律字符串，媒体格是地址）。
 * 纯数据层：不碰 DOM、不发请求 —— 请求在 tableLlm.ts，界面在 ui/TableAi.tsx。
 */
import { clampSelection, isMediaRef, mediaRefsIn, normalizeAiColumns, rolesOf, TABLE_LIMITS, type TableData, type TableSelection } from "./table";

/** 归一化助手只在 table.ts 一处（避免循环依赖），这里转出去给界面层用 */
export { clampSelection, normalizeAiColumns };

export const AI_INSTRUCTION_MAX_CHARS = TABLE_LIMITS.cell;
export const AI_COLUMN_BATCH_ROWS = 20;
export const AI_COLUMN_BATCH_ROWS_MAX = 50;
export const AI_COLUMN_MAX_TOKENS = 8192;
export const TABLE_SNAPSHOT_KIND = "table-snapshot";

export type AiCellWrite = { row: number; column?: number | string; columnName?: string; value: string };
export type AiColumnBatch = { columnIndex: number; rows: number[] };
export type AiDiffChange = { row: number; col: number; columnName: string; before: string; after: string };
export type AiParseItem = { row: number; col?: number; value: string };
export type AiParseInvalid = { row: number | null; col?: number; reason: "shape" | "row" | "col" | "value" | "duplicate" };
export type AiParseResult = {
  ok: boolean;
  parsed: boolean;
  applied: AiParseItem[];
  values: Record<number, string>;
  cells: Record<string, string>;
  missing: number[];
  invalid: AiParseInvalid[];
  extra: AiParseItem[];
};
export type TableSnapshot = { kind: typeof TABLE_SNAPSHOT_KIND; version: 1; table: TableData };

/** 单元格原文（不截断）：批量写要按真实长度判超限，不能被静默截断绕过 */
export const rawCellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};
const cellText = (v: unknown): string => { const s = rawCellText(v); return s.length > TABLE_LIMITS.cell ? s.slice(0, TABLE_LIMITS.cell) : s; };

export const selectionCount = (sel: TableSelection | null): number => (sel ? (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1) : 0);
export const selectionRows = (sel: TableSelection): number[] => {
  const rows: number[] = [];
  for (let r = sel.r0; r <= sel.r1; r += 1) rows.push(r + 1);
  return rows;
};

/** 一次请求最多带几张首帧图（后端 /api/canvas-llm 只取前 8 张）；带图时智能列按这个行数分批 */
export const AI_COLUMN_FRAME_BATCH = 8;

/** 智能列看图：表里「首帧」用途的列（目标列本身就是首帧列时不算），没有返回 -1 */
export function aiFrameColumn(t: TableData, target: number): number {
  const at = rolesOf(t).findIndex((r) => r.role === "first");
  return at >= 0 && at !== target ? at : -1;
}

/** 这一批行里有首帧的那些：按行号顺序，每行取第一张 */
export function aiFrameImages(t: TableData, frameCol: number, rows: number[]): Array<{ row: number; url: string }> {
  if (frameCol < 0) return [];
  return rows.map((row) => ({ row, url: mediaRefsIn(String((t.rows[row - 1] || [])[frameCol] ?? ""))[0] || "" }))
    .filter((x) => x.url).slice(0, AI_COLUMN_FRAME_BATCH);
}

/** 附图说明：告诉模型第几张图是哪一行的首帧 */
export function aiFrameNote(frames: Array<{ row: number }>): string {
  if (!frames.length) return "";
  return ["", "附图：按顺序是以下各行的首帧画面，生成时结合画面内容（文字和画面冲突时以画面为准）：",
    frames.map((f, i) => "图 " + (i + 1) + " = 第 " + f.row + " 行").join("；")].join("\n");
}

export function aiColumnBatchSize(raw: unknown): number {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 1) return AI_COLUMN_BATCH_ROWS;
  return Math.min(AI_COLUMN_BATCH_ROWS_MAX, value);
}

/** 整行一个字都没有（也没有媒体地址）＝没东西可改写，规划时跳过 */
export const rowHasContent = (row: string[]): boolean => (Array.isArray(row) ? row : []).some((cell) => isMediaRef(cell) || Boolean(String(cell ?? "").trim()));

/**
 * 智能列执行计划：[{columnIndex, rows:[1-based 行号…]}]。
 * rows 用 1-based（与 setCells 的 row 同一口径），columnIndex 与 columns 同下标（0-based）。
 */
export function planAiColumn(t: TableData, columnIndex: number, options: { batchSize?: unknown; rows?: number[] } = {}): AiColumnBatch[] {
  const index = Math.floor(Number(columnIndex));
  if (!Number.isInteger(index) || index < 0 || index >= t.columns.length) return [];
  const batchSize = aiColumnBatchSize(options.batchSize);
  const wanted = Array.isArray(options.rows) ? new Set(options.rows.map(Number).filter((v) => Number.isInteger(v) && v > 0)) : null;
  const rows: number[] = [];
  t.rows.forEach((row, at) => {
    const rowNumber = at + 1;
    if (wanted && !wanted.has(rowNumber)) return;
    if (!rowHasContent(row)) return;
    rows.push(rowNumber);
  });
  const batches: AiColumnBatch[] = [];
  for (let at = 0; at < rows.length; at += batchSize) batches.push({ columnIndex: index, rows: rows.slice(at, at + batchSize) });
  return batches;
}

/** 1-based 行号校验（越界抛错，让 setCells 整批不写） */
function rowAt(t: TableData, value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > t.rows.length) throw new Error("行序号必须是 1–" + t.rows.length + "。");
  return n - 1;
}
/** 列定位：columnName 优先（要求唯一）→ column 1-based 序号 */
function colAt(t: TableData, sel: { column?: unknown; columnName?: unknown }): number {
  const name = String(sel.columnName ?? "").trim();
  if (name) {
    const hits: number[] = [];
    t.columns.forEach((c, i) => { if (c === name) hits.push(i); });
    if (hits.length > 1) throw new Error("列名“" + name + "”不唯一。");
    if (!hits.length) throw new Error("不存在列“" + name + "”。");
    return hits[0];
  }
  const n = Number(sel.column);
  if (!Number.isInteger(n) || n < 1 || n > t.columns.length) throw new Error("列序号必须是 1–" + t.columns.length + "。");
  return n - 1;
}

/** 深拷贝（不含运行时字段，只保数据） */
export function cloneTable(t: TableData): TableData {
  return {
    ...t,
    columns: [...t.columns],
    rows: t.rows.map((r) => [...r]),
    ...(t.roles ? { roles: [...t.roles] } : {}),
    ...(t.inputModes ? { inputModes: { ...t.inputModes } } : {}),
    ...(t.inputModesAuto ? { inputModesAuto: [...t.inputModesAuto] } : {}),
    ...(t.aiColumns ? { aiColumns: t.aiColumns.map((c) => (c ? { instruction: c.instruction, updatedAt: c.updatedAt } : null)) } : {}),
    ...(t.selection ? { selection: { ...t.selection } } : {}),
  };
}

/**
 * 原子批量写格：先全部校验再统一落笔 —— 任何一格越界 / 超长，整批一格都不写。
 * 长度按原文判（cellText 会静默截断，不能拿它当超限判断）。
 */
export function setCells(t: TableData, cells: AiCellWrite[]): TableData {
  if (!Array.isArray(cells)) throw new Error("批量修改需要 cells 数组。");
  const writes = cells.map((item) => {
    const cell = item && typeof item === "object" ? item : ({} as AiCellWrite);
    const r = rowAt(t, cell.row);
    const c = colAt(t, cell);
    if (rawCellText(cell.value).length > TABLE_LIMITS.cell) throw new Error("单元格内容不能超过 " + TABLE_LIMITS.cell + " 字。");
    return { r, c, value: cellText(cell.value) };
  });
  const next = cloneTable(t);
  writes.forEach((item) => { next.rows[item.r][item.c] = item.value; });
  return next;
}

/** cells 每项 {row, values:[各列原文]}；给字符串/数组时当作「只有目标列原文」 */
export function aiColumnPrompt(instruction: string, cells: unknown, columns: string[], options: { columnIndex?: number; columnName?: string } = {}): string {
  const names = (Array.isArray(columns) ? columns : []).map((name, index) => String(name ?? "").trim() || "第 " + (index + 1) + " 列");
  const targetIndex = Number.isInteger(Number(options.columnIndex)) ? Math.floor(Number(options.columnIndex)) : -1;
  const targetName = String(options.columnName || (targetIndex >= 0 && names[targetIndex] ? names[targetIndex] : "")).trim() || "未指定列";
  const rows = (Array.isArray(cells) ? cells : []).map((entry, index) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { row?: unknown; values?: unknown; value?: unknown }) : { values: Array.isArray(entry) ? entry : [entry] };
    const rawRow = Number(item.row);
    const row = Number.isInteger(rawRow) && rawRow > 0 ? rawRow : index + 1;
    const values = Array.isArray(item.values) ? item.values : [item.value];
    return { row, values };
  });
  const rowLines = rows.map((item) => {
    const lines = names.length
      ? names.map((name, col) => name + "：" + (rawCellText(item.values[col]).trim() || "（空）"))
      : ["原文：" + (rawCellText(item.values[0]).trim() || "（空）")];
    return "第 " + item.row + " 行\n" + lines.map((line) => "  " + line).join("\n");
  });
  return [
    "你在为一个「多维表格」的智能列批量生成单元格内容。",
    "目标列：「" + targetName + "」",
    "本列指令（每一行都按它产出）：",
    String(instruction || "").trim() || "（未填写指令：按目标列的列名理解，生成适合这一列的内容）",
    "",
    "表格列（按顺序）：" + (names.join("、") || "（无列名）"),
    "逐行原文（行号就是表格里的行号）：",
    rowLines.join("\n") || "（没有可处理的行）",
    "",
    "要求：",
    "- 只为上面列出的每一行各产出一条结果，不要新增、删除或合并行。",
    "- 行号必须与原文行号完全一致，不得改写。",
    "- 只依据该行原文和指令改写，不要编造原文里没有的信息。",
    "- 每条结果只写目标列该有的内容，不要带列名、行号、引号或 Markdown。",
    "- 只返回一个 JSON 对象，不要 Markdown 代码块，不要解释：",
    '{"values":[{"row":' + (rows[0] ? rows[0].row : 1) + ',"value":"改写后的单元格文本"}]}',
  ].join("\n");
}

export type RewritePatch = { values: string[][]; rowOffset?: number; colOffset?: number; columnNames?: string[] };

/** patch 是选中区域原文：二维数组，或 {values, rowOffset, colOffset, columnNames}（带偏移时提示词里写整表真实行列号） */
function rewritePatchOf(patch: string[][] | RewritePatch) {
  if (Array.isArray(patch)) return { values: patch, rowOffset: 0, colOffset: 0, columnNames: [] as string[] };
  const source = patch && typeof patch === "object" ? patch : ({} as RewritePatch);
  const values = Array.isArray(source.values) ? source.values : [];
  const offset = (raw: unknown) => { const v = Math.floor(Number(raw)); return Number.isFinite(v) && v > 0 ? v : 0; };
  return {
    values,
    rowOffset: offset(source.rowOffset),
    colOffset: offset(source.colOffset),
    columnNames: (Array.isArray(source.columnNames) ? source.columnNames : []).map((n) => String(n || "")),
  };
}

export function batchRewritePrompt(instruction: string, patch: string[][] | RewritePatch): string {
  const region = rewritePatchOf(patch);
  const rows = region.values.filter(Array.isArray);
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const regionLine = rows.length
    ? "选中区域：第 " + (region.rowOffset + 1) + "–" + (region.rowOffset + rows.length)
      + " 行，第 " + (region.colOffset + 1) + "–" + (region.colOffset + Math.max(1, width))
      + " 列（行列号都是整张表里的真实序号）"
    : "选中区域：（空）";
  const rowLines = rows.map((row, index) => {
    const rowNumber = region.rowOffset + index + 1;
    const cells: string[] = [];
    for (let col = 0; col < Math.max(1, width); col += 1) {
      const colNumber = region.colOffset + col + 1;
      const name = region.columnNames[col] ? region.columnNames[col] + "（第 " + colNumber + " 列）" : "第 " + colNumber + " 列";
      cells.push("  " + name + "：" + (rawCellText(row[col]).trim() || "（空）"));
    }
    return "第 " + rowNumber + " 行\n" + cells.join("\n");
  });
  return [
    "你在批量改写一张「多维表格」中选中区域的单元格。",
    "改写要求：",
    String(instruction || "").trim() || "（未填写要求：保持原意，只做通顺化与去噪）",
    "",
    regionLine,
    "区域原文：",
    rowLines.join("\n") || "（没有可改写的单元格）",
    "",
    "要求：",
    "- 只改写给出的格子：行号、列号必须原样照抄，不得新增、删除或合并行列。",
    "- 每一格只输出改写后的单元格文本，不要带行列号、列名、引号或 Markdown。",
    "- 不需要改写的格子可以不返回；返回的每一格都必须落在上面的行号、列号范围内。",
    "- 只依据原文与要求改写，不要编造原文里没有的信息。",
    "- 只返回一个 JSON 对象，不要 Markdown 代码块，不要解释：",
    '{"values":[{"row":1,"col":1,"value":"改写后的单元格文本"}]}',
  ].join("\n");
}

/* ---------- 模型输出的容错解析（与旧画布同一套：代码块 / 多块 / 裸控制字符 / 顶层数组都认） ---------- */

/** 把 JSON 字符串字面量内部的裸控制字符转成转义序列（模型常把真实换行写进字符串值里） */
export function escapeJsonControlChars(source: string): string {
  const text = String(source || "");
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (!inString) { out += ch; if (ch === '"') inString = true; continue; }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { out += ch; inString = false; continue; }
    const code = text.charCodeAt(index);
    if (code >= 0x20) { out += ch; continue; }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += "\\u" + ("000" + code.toString(16)).slice(-4);
  }
  return out;
}

/** 先按原样 parse（合法 JSON 行为一点不变），失败了才做控制字符修复 */
export function parseJsonLenient(body: string): unknown {
  try { return JSON.parse(body); } catch { try { return JSON.parse(escapeJsonControlChars(body)); } catch { return null; } }
}

function stripJsonFence(text: string): string {
  let source = String(text || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(source);
  if (fenced) source = fenced[1].trim();
  else {
    const inline = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
    if (inline) source = inline[1].trim();
  }
  return source;
}

export function extractJsonObject(text: string): unknown {
  const source = stripJsonFence(text);
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return parseJsonLenient(source.slice(first, last + 1));
}

export function extractJsonArray(text: string): unknown[] | null {
  const source = stripJsonFence(text);
  const first = source.indexOf("[");
  const last = source.lastIndexOf("]");
  if (first < 0 || last <= first) return null;
  const parsed = parseJsonLenient(source.slice(first, last + 1));
  return Array.isArray(parsed) ? parsed : null;
}

/** 模型返回里的**全部** JSON 数据块（代码块优先；没有代码块再按顶层括号逐段扫） */
export function extractJsonValues(text: string): unknown[] {
  const source = String(text || "");
  if (!source.trim()) return [];
  const values: unknown[] = [];
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let fenced: RegExpExecArray | null;
  while ((fenced = fenceRe.exec(source))) {
    const body = String(fenced[1] || "").trim();
    if (!body) continue;
    const parsed = parseJsonLenient(body);
    if (parsed !== null && parsed !== undefined) values.push(parsed);
  }
  if (values.length) return values;
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source.charAt(index);
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === String.fromCharCode(92)) { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") {
      if (!stack.length) start = index;
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (!stack.length) continue;
      const open = stack.pop();
      if ((open === "{" && ch !== "}") || (open === "[" && ch !== "]")) { stack.length = 0; start = -1; continue; }
      if (stack.length || start < 0) continue;
      const parsed = parseJsonLenient(source.slice(start, index + 1));
      if (parsed !== null && parsed !== undefined) values.push(parsed);
      start = -1;
    }
  }
  return values;
}

/** 收 {row,value} 项：{"values":[…]}、顶层数组、多块 JSON、代码块都认 */
function aiValueItems(text: string): { items: unknown[]; parsed: boolean } {
  const items: unknown[] = [];
  const push = (value: unknown) => {
    if (Array.isArray(value)) items.push(...value);
    else if (value && typeof value === "object") {
      const obj = value as { values?: unknown; row?: unknown };
      if (Array.isArray(obj.values)) items.push(...obj.values);
      else if (obj.row !== undefined) items.push(value);
    }
  };
  const values = extractJsonValues(text);
  if (values.length) { values.forEach(push); return { items, parsed: true }; }
  const object = extractJsonObject(text);
  if (object) { push(object); return { items, parsed: true }; }
  const array = extractJsonArray(text);
  if (array) { push(array); return { items, parsed: true }; }
  return { items, parsed: false };
}

/**
 * 解析智能列 / 批量改写的返回。成功哪些行（applied / values）、缺哪些行（missing）、
 * 非法行号/重复行/缺失值（invalid）、超出预期的行（extra）全部报出来，不静默吞。
 * expectedRows 传行号数组（1-based）；传数字时按「前 N 行」理解。
 * 带 col 的结果（选区批量改写）按「行:列」收进 cells，行列号都是 1-based。
 */
export function parseAiValues(text: string, expectedRows: number[] | number): AiParseResult {
  const expectedSource = Array.isArray(expectedRows)
    ? expectedRows
    : (Number.isInteger(Number(expectedRows)) && Number(expectedRows) > 0 ? Array.from({ length: Number(expectedRows) }, (_, index) => index + 1) : []);
  const expected = Array.from(new Set(expectedSource.map(Number).filter((v) => Number.isInteger(v) && v > 0))).sort((a, b) => a - b);
  const expectedSet = new Set(expected);
  const { items, parsed } = aiValueItems(text);
  const values: Record<number, string> = {};
  const cells: Record<string, string> = {};
  const seen = new Set<string>();
  const seenRows = new Set<number>();
  const applied: AiParseItem[] = [];
  const invalid: AiParseInvalid[] = [];
  const extra: AiParseItem[] = [];
  items.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { invalid.push({ row: null, reason: "shape" }); return; }
    const item = raw as { row?: unknown; col?: unknown; value?: unknown };
    const rawRow = Number(item.row);
    if (!Number.isInteger(rawRow) || rawRow < 1) { invalid.push({ row: null, reason: "row" }); return; }
    const hasCol = item.col !== undefined && item.col !== null;
    const rawCol = Number(item.col);
    if (hasCol && (!Number.isInteger(rawCol) || rawCol < 1)) { invalid.push({ row: rawRow, reason: "col" }); return; }
    if (item.value === undefined || item.value === null) { invalid.push({ row: rawRow, reason: "value" }); return; }
    const value = cellText(item.value);
    const address = hasCol ? rawRow + ":" + rawCol : String(rawRow);
    if (!expectedSet.has(rawRow)) { extra.push(hasCol ? { row: rawRow, col: rawCol, value } : { row: rawRow, value }); return; }
    if (seen.has(address)) { invalid.push(hasCol ? { row: rawRow, col: rawCol, reason: "duplicate" } : { row: rawRow, reason: "duplicate" }); return; }
    seen.add(address);
    seenRows.add(rawRow);
    if (hasCol) { cells[address] = value; applied.push({ row: rawRow, col: rawCol, value }); }
    else { values[rawRow] = value; applied.push({ row: rawRow, value }); }
  });
  const byAddress = (a: AiParseItem, b: AiParseItem) => a.row - b.row || (a.col || 0) - (b.col || 0);
  applied.sort(byAddress);
  extra.sort(byAddress);
  const missing = expected.filter((row) => !seenRows.has(row));
  return { ok: parsed && !invalid.length && !extra.length && !missing.length, parsed, applied, values, cells, missing, invalid, extra };
}

/** 模型输出解析不出可用结果时的补发提示词（只补发一次） */
export function aiValuesRepairPrompt(prompt: string, bad: string, withCols: boolean): string {
  return [
    "你上一次的输出无法解析成要求的 JSON。请只返回一个合法 JSON 对象，不要解释、不要 Markdown。",
    '格式：{"values":[{"row":1' + (withCols ? ',"col":1' : "") + ',"value":"改写后的单元格文本"}]}',
    "",
    "原始要求：",
    String(prompt || "").slice(0, 12000),
    "",
    "上一次输出：",
    String(bad || "").slice(0, 4000),
  ].join("\n");
}

/** 逐格比对用的文本：媒体格比地址，其余比单元格原文 */
const diffCellText = (v: unknown): string => rawCellText(v);

/** 逐格差异（先行后列），行/列都是 1-based：只列真正变化的格子 */
export function diffTables(before: TableData, after: TableData): AiDiffChange[] {
  const rowCount = Math.max(before.rows.length, after.rows.length);
  const colCount = Math.max(before.columns.length, after.columns.length);
  const changes: AiDiffChange[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const beforeValue = diffCellText(before.rows[row] ? before.rows[row][col] : "");
      const afterValue = diffCellText(after.rows[row] ? after.rows[row][col] : "");
      if (beforeValue === afterValue) continue;
      changes.push({
        row: row + 1,
        col: col + 1,
        columnName: after.columns[col] !== undefined ? after.columns[col] : (before.columns[col] || ""),
        before: beforeValue,
        after: afterValue,
      });
    }
  }
  return changes;
}

/** 快照只能整体还原（cloneTable(snapshot.table)），防止把快照当表格局部改，改出与列数对不上的 aiColumns */
export function tableSnapshot(t: TableData): TableSnapshot {
  return { kind: TABLE_SNAPSHOT_KIND, version: 1, table: cloneTable(t) };
}
export function restoreSnapshot(snap: TableSnapshot): TableData { return cloneTable(snap.table); }
