/**
 * 多维表格「智能」界面层（BEAT / React 画布）：
 *   ① 拖选矩形（Shift 扩选、Esc / 点格子外清空）+ 选区工具条；
 *   ② AI 批量改预览弹层（位置 / 原文 / 改动后、逐条取消、应用后 ⌘Z 一步回滚、点别处即丢弃快照）；
 *   ③ 表头 AI 列按钮 + 智能列弹层（写指令 / 模型 / 系统提示词 / 按此列生成 / 进度 / 停止 / 失败行重试）。
 *
 * 数据语义在 ../tableAi.ts，请求在 ../tableLlm.ts。批量生成（runTableBatch / journal / 通道 / 勾选）只读不碰：
 * 批量运行期间这里的每个入口都会被禁用并写明原因。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { batchOf, isMediaRef, tableOf, withTable, type TableData, type TableSelection } from "../table";
import {
  AI_COLUMN_FRAME_BATCH, AI_INSTRUCTION_MAX_CHARS, aiColumnPrompt, aiFrameColumn, aiFrameImages, aiFrameNote, aiValuesRepairPrompt, batchRewritePrompt, diffTables,
  normalizeAiColumns, parseAiValues, planAiColumn, selectionCount, selectionRows, setCells, type AiDiffChange, type AiParseResult,
} from "../tableAi";
import { callTableLlm, tableLlmConfig, TABLE_AI_SYSTEM_DEFAULT, type TableLlmConfig } from "../tableLlm";
import { isGenKind } from "../model";
import type { CanvasStore } from "../store";
import { openModal, ModalHead } from "./overlay";
import { Icon } from "./Icon";
import { useS } from "./ctx";

export const TABLE_AI_BUSY_TITLE = "批量生成中，完成后再改";
export const TABLE_AI_NOTICE_MS = 5000;

/** 表格下游的生成节点正在批量跑（或 journal 里还有 running 行）＝本表的 AI 入口一律禁用 */
export function tableBatchBusy(store: CanvasStore, tableId: string): boolean {
  const st = store.state;
  const targets = st.doc.edges.filter((e) => e.from === tableId).map((e) => e.to);
  return targets.some((id) => {
    const gen = store.node(id);
    if (!gen) return false;
    if (st.runtime[id] && st.runtime[id].status === "running") return true;
    if (!isGenKind(gen.kind)) return false;
    const journal = batchOf(gen).journal;
    return Boolean(journal && journal.rows.some((r) => r.status === "running"));
  });
}

/* ---------- 选区原文 ---------- */

/** 选区原文：二维数组 + 偏移 + 选中的列名（行列号在提示词里是整表真实序号）。媒体格不参与改写：留空，也不许被文字覆盖 */
export function selectionPatch(t: TableData, sel: TableSelection) {
  const values: string[][] = [];
  const skipped: Array<{ row: number; col: number }> = [];
  for (let r = sel.r0; r <= sel.r1; r += 1) {
    const line: string[] = [];
    for (let c = sel.c0; c <= sel.c1; c += 1) {
      const raw = t.rows[r] ? t.rows[r][c] : "";
      if (isMediaRef(raw)) { skipped.push({ row: r + 1, col: c + 1 }); line.push(""); }
      else line.push(String(raw ?? ""));
    }
    values.push(line);
  }
  return { values, rowOffset: sel.r0, colOffset: sel.c0, columnNames: t.columns.slice(sel.c0, sel.c1 + 1), skipped };
}

/* ---------- AI 撤销快照（点别处即作废） ---------- */

type AiUndoEntry = { data: TableData; at: number; cells: number };
const aiUndo = new Map<string, AiUndoEntry>();

export const aiHasUndo = (): boolean => aiUndo.size > 0;

/** 应用选中的差异：一次 setCells 原子写；改动前的表整张存成快照，⌘Z / 「撤销」只回滚这一张表 */
export function applyAiChanges(store: CanvasStore, nodeId: string, changes: AiDiffChange[]): boolean {
  const node = store.node(nodeId);
  if (!node || !changes.length) return false;
  const t = tableOf(node);
  let next: TableData;
  try {
    next = setCells(t, changes.map((c) => ({ row: c.row, column: c.col, value: c.after })));
  } catch (error) {
    store.toast(String((error as Error).message || error || "应用改动失败"), 5000);
    return false;
  }
  aiUndo.set(nodeId, { data: t, at: Date.now(), cells: changes.length });
  store.updateNode(nodeId, (n) => withTable(n, next));
  store.toast("已应用 " + changes.length + " 处改动 · 撤销", TABLE_AI_NOTICE_MS, () => { undoAiNode(store, nodeId); });
  return true;
}

export function undoAiNode(store: CanvasStore, nodeId: string): boolean {
  const entry = aiUndo.get(nodeId);
  if (!entry) return false;
  aiUndo.delete(nodeId);
  store.updateNode(nodeId, (n) => withTable(n, entry.data));
  store.toast("已撤销 AI 改动");
  return true;
}

function dropAiUndo(): boolean {
  if (!aiUndo.size) return false;
  aiUndo.clear();
  return true;
}

const latestUndo = (): { nodeId: string; entry: AiUndoEntry } | null => {
  let hit: { nodeId: string; entry: AiUndoEntry } | null = null;
  aiUndo.forEach((entry, nodeId) => { if (!hit || entry.at >= hit.entry.at) hit = { nodeId, entry }; });
  return hit;
};

/* ---------- 智能列运行态（模块级：关掉弹层也继续跑；同一时刻只允许一列在跑） ---------- */

export type AiColumnRun = {
  column: number;
  running: boolean;
  stopped: boolean;
  done: number;
  total: number;
  failed: Array<{ row: number; reason: string }>;
  error: string;
};
const aiRuns = new Map<string, AiColumnRun>();
const aiRunListeners = new Set<() => void>();
const notifyRuns = () => { aiRunListeners.forEach((fn) => fn()); };

export function subscribeAiRuns(fn: () => void): () => void {
  aiRunListeners.add(fn);
  return () => { aiRunListeners.delete(fn); };
}
export const aiColumnRunOf = (nodeId: string): AiColumnRun | null => aiRuns.get(nodeId) || null;
const patchRun = (nodeId: string, run: AiColumnRun) => { aiRuns.set(nodeId, { ...run, failed: run.failed.slice() }); notifyRuns(); };

/** 界面读运行态的 hook：模块级运行态变了就重渲染（读到的是快照，不是可变对象） */
export function useAiColumnRun(nodeId: string): AiColumnRun | null {
  const [run, setRun] = useState<AiColumnRun | null>(() => aiColumnRunOf(nodeId));
  useEffect(() => {
    setRun(aiColumnRunOf(nodeId));
    return subscribeAiRuns(() => setRun(aiColumnRunOf(nodeId)));
  }, [nodeId]);
  return run;
}

export function useTableBatchBusy(store: CanvasStore, tableId: string): boolean {
  const doc = useS((s) => s.doc);
  const runtime = useS((s) => s.runtime);
  return useMemo(() => tableBatchBusy(store, tableId), [store, tableId, doc, runtime]);
}

export function stopAiColumn(nodeId: string): boolean {
  const run = aiRuns.get(nodeId);
  if (!run || !run.running) return false;
  patchRun(nodeId, { ...run, stopped: true });
  return true;
}

/** 写一列的生成指令（空 = 清除）。aiColumns 与 columns 定长对齐，全空时整条清掉，不把文档改脏 */
export function setAiInstruction(store: CanvasStore, nodeId: string, column: number, instruction: string): boolean {
  const node = store.node(nodeId);
  if (!node) return false;
  const t = tableOf(node);
  if (column < 0 || column >= t.columns.length) return false;
  const text = String(instruction || "").trim().slice(0, AI_INSTRUCTION_MAX_CHARS);
  const list = normalizeAiColumns(t.aiColumns, t.columns.length).slice();
  list[column] = text ? { instruction: text, updatedAt: Date.now() } : null;
  const aligned = normalizeAiColumns(list, t.columns.length);
  store.updateNode(nodeId, (n) => withTable(n, { ...tableOf(n), aiColumns: aligned.some(Boolean) ? aligned : undefined }), { history: true });
  return true;
}

/** 写表格节点自己的 AI 配置（模型 / 系统提示词）；空串 = 清掉该字段 */
export function setAiConfig(store: CanvasStore, nodeId: string, patch: { aiModel?: string; aiSystem?: string }): boolean {
  const node = store.node(nodeId);
  if (!node) return false;
  store.updateNode(nodeId, (n) => {
    const t = tableOf(n);
    const next: TableData = { ...t };
    if (patch.aiModel !== undefined) { const v = String(patch.aiModel || "").trim(); if (v) next.aiModel = v; else delete next.aiModel; }
    if (patch.aiSystem !== undefined) { const v = String(patch.aiSystem || ""); if (v) next.aiSystem = v; else delete next.aiSystem; }
    return withTable(n, next);
  }, { history: true });
  return true;
}

const errText = (error: unknown): string => String((error as Error)?.message || error || "生成失败");

function markFailed(run: AiColumnRun, row: number, reason: string) {
  const hit = run.failed.filter((item) => item.row === row)[0];
  if (hit) { hit.reason = reason; return; }
  run.failed.push({ row, reason });
}
function clearFailed(run: AiColumnRun, row: number) {
  run.failed = run.failed.filter((item) => item.row !== row);
}

/** 按列生成：分批（默认 20 行 / 上限 50）、逐批解析回填、可随时停止，失败行单独记下来给「重试该行」 */
export async function runAiColumn(store: CanvasStore, nodeId: string, column: number, options: { rows?: number[]; keepFailed?: boolean } = {}): Promise<boolean> {
  const node = store.node(nodeId);
  if (!node || node.kind !== "table") return false;
  if ([...aiRuns.values()].some((r) => r.running)) {
    const own = aiRuns.get(nodeId);
    if (!(own && own.running)) store.toast("另一列的 AI 生成还在进行，等它结束再试", 4000);
    return false;
  }
  if (tableBatchBusy(store, nodeId)) { store.toast(TABLE_AI_BUSY_TITLE, 4000); return false; }
  const t0 = tableOf(node);
  if (column < 0 || column >= t0.columns.length) return false;
  const ready = tableLlmConfig(t0, store.modelsOf("text"));
  if (!ready.ok) { store.toast(ready.reason, 4000); return false; }
  const meta = normalizeAiColumns(t0.aiColumns, t0.columns.length)[column];
  const instruction = meta ? meta.instruction : "";
  // 行里有首帧、模型能看图：首帧一起发过去（每批最多 8 行，对应 8 张图）
  const frameCol = aiFrameColumn(t0, column);
  const spec = store.modelsOf("text").find((m) => m.id === ready.cfg.configId);
  const withFrames = frameCol >= 0 && Boolean(spec?.vision) && t0.rows.some((_, i) => aiFrameImages(t0, frameCol, [i + 1]).length > 0);
  const jobs = planAiColumn(t0, column, { ...(options.rows && options.rows.length ? { rows: options.rows } : {}), ...(withFrames ? { batchSize: AI_COLUMN_FRAME_BATCH } : {}) });
  const total = jobs.reduce((sum, batch) => sum + batch.rows.length, 0);
  const prev = aiRuns.get(nodeId);
  const kept = options.keepFailed && prev && prev.column === column ? prev.failed.slice() : [];
  if (!total) {
    patchRun(nodeId, { column, running: false, stopped: false, done: 0, total: 0, failed: kept, error: "没有可生成的行（整行都是空的行会跳过）" });
    return false;
  }
  const run: AiColumnRun = { column, running: true, stopped: false, done: 0, total, failed: kept, error: "" };
  patchRun(nodeId, run);
  const cfg: TableLlmConfig = ready.cfg;
  const stopped = () => Boolean(aiRuns.get(nodeId)?.stopped);
  try {
    for (const batch of jobs) {
      if (run.stopped || stopped()) break;
      const nodeNow = store.node(nodeId);
      if (!nodeNow) break;
      const t = tableOf(nodeNow);
      const cells = batch.rows.map((rowNumber) => ({
        row: rowNumber,
        values: t.columns.map((_, c) => String((t.rows[rowNumber - 1] || [])[c] ?? "")),
      }));
      const frames = withFrames ? aiFrameImages(t, frameCol, batch.rows) : [];
      const prompt = aiColumnPrompt(instruction, cells, t.columns, { columnIndex: column }) + aiFrameNote(frames);
      let parsed: AiParseResult | null = null;
      try {
        let text = await callTableLlm(cfg, prompt, frames.length ? { images: frames.map((f) => f.url) } : {});
        parsed = parseAiValues(text, batch.rows);
        // 只有「整批解析不出可用结果」才补发一次；缺行属于逐行失败，交给「重试该行」
        if (!parsed.parsed || !parsed.applied.length) {
          text = await callTableLlm(cfg, aiValuesRepairPrompt(prompt, text, false));
          parsed = parseAiValues(text, batch.rows);
        }
      } catch (error) {
        run.error = errText(error);
        parsed = null;
      }
      const writes = (parsed ? parsed.applied : [])
        .filter((item) => item.col === undefined || item.col === null)
        .map((item) => ({ row: item.row, column: column + 1, value: item.value }));
      if (writes.length) {
        try {
          const freshNode = store.node(nodeId);
          if (!freshNode) break;
          const next = setCells(tableOf(freshNode), writes);
          store.updateNode(nodeId, (n) => withTable(n, next));
          writes.forEach((item) => { run.done += 1; clearFailed(run, item.row); });
        } catch (error) {
          run.error = errText(error);
          writes.forEach((item) => markFailed(run, item.row, run.error));
        }
      }
      batch.rows.filter((rowNumber) => !writes.some((item) => item.row === rowNumber))
        .forEach((rowNumber) => markFailed(run, rowNumber, run.error || "这一行没有返回结果"));
      // 「停止」是外部改的运行态：写回前先并回来，否则会被这一轮快照覆盖掉
      run.stopped = run.stopped || stopped();
      patchRun(nodeId, run);
    }
  } finally {
    run.running = false;
    run.stopped = run.stopped || stopped();
    patchRun(nodeId, run);
    if (!run.done && run.error) store.toast(run.error, 6000);
  }
  return run.done > 0;
}

/* ---------- 全局监听（⌘Z 接管 / 点别处丢弃） ---------- */

const isTypingTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(el.isContentEditable);
};

let globalsInstalled = false;
let globalsStore: CanvasStore | null = null;

/** 只装一次：⌘Z 在有 AI 快照时接管（焦点在输入框里不抢）；点表格外 → 快照作废，⌘Z 交回画布撤销 */
export function installTableAiGlobals(store: CanvasStore) {
  globalsStore = store;
  if (globalsInstalled || typeof document === "undefined") return;
  globalsInstalled = true;
  document.addEventListener("pointerdown", (event) => {
    if (!aiUndo.size) return;
    const target = event.target as Element | null;
    if (target && typeof target.closest === "function" && target.closest(".tnode")) return;
    dropAiUndo();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!aiUndo.size) return;
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (String(event.key).toLowerCase() !== "z") return;
    if (isTypingTarget(event.target)) return;
    const latest = latestUndo();
    if (!latest || !globalsStore) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    undoAiNode(globalsStore, latest.nodeId);
  }, true);
}

/* ---------- 选区工具条 ---------- */

/**
 * 选区工具条：贴着选区的左上角站位（会盖住表头时翻到选区下方，左右上下都夹在表格可视区内）。
 * 位置只在选区 / 表格尺寸 / 表格滚动变化时重算，拖选过程不重排。
 */
export function TableAiToolbar({ store, nodeId, table, sel, rootRef, gridRef, busy, onClear }: {
  store: CanvasStore;
  nodeId: string;
  table: TableData;
  sel: TableSelection;
  rootRef: React.RefObject<HTMLDivElement | null>;
  gridRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  onClear: () => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);

  const place = useCallback(() => {
    const root = rootRef.current, grid = gridRef.current, bar = barRef.current;
    if (!root || !grid || !bar) return;
    const cell = root.querySelector<HTMLElement>('[data-r="' + sel.r0 + '"][data-c="' + sel.c0 + '"]');
    if (!cell) return;
    const rb = root.getBoundingClientRect(), gb = grid.getBoundingClientRect(), cb = cell.getBoundingClientRect();
    const w = bar.offsetWidth || 340, h = bar.offsetHeight || 38;
    // 表头是 sticky 的：贴选区上方时不能压住表头，空间不够就翻到选区下方
    const minTop = gb.top - rb.top + 52;
    const maxTop = Math.max(minTop, gb.bottom - rb.top - h - 6);
    let top = cb.top - rb.top - h - 8;
    if (top < minTop) top = cb.bottom - rb.top + 8;
    top = Math.min(maxTop, Math.max(minTop, top));
    const minLeft = gb.left - rb.left + 4;
    const maxLeft = Math.max(minLeft, gb.right - rb.left - w - 4);
    const left = Math.min(maxLeft, Math.max(minLeft, cb.left - rb.left));
    bar.style.left = Math.round(left) + "px";
    bar.style.top = Math.round(top) + "px";
    bar.style.maxWidth = Math.max(200, Math.round(gb.width - 8)) + "px";
  }, [gridRef, rootRef, sel.c0, sel.r0]);

  useLayoutEffect(() => { place(); }, [place, text, running]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const on = () => place();
    grid.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { grid.removeEventListener("scroll", on); window.removeEventListener("resize", on); };
  }, [gridRef, place]);

  const typed = text.trim();
  const hint = busy ? TABLE_AI_BUSY_TITLE : running ? "正在生成预览…" : "";
  const canRun = !busy && !running && Boolean(typed);

  const openPreview = async () => {
    if (!canRun) return;
    setRunning(true);
    try {
      const node = store.node(nodeId);
      if (!node) return;
      const t = tableOf(node);
      const ready = tableLlmConfig(t, store.modelsOf("text"));
      if (!ready.ok) { store.toast(ready.reason, 5000); return; }
      const patch = selectionPatch(t, sel);
      if (!patch.values.some((line) => line.some((v) => String(v || "").trim()))) { store.toast("选中的格子都是空的，没什么可改写"); return; }
      const prompt = batchRewritePrompt(typed, patch);
      let parsed: AiParseResult;
      try {
        let text = await callTableLlm(ready.cfg, prompt);
        parsed = parseAiValues(text, selectionRows(sel));
        if (!parsed.parsed || !parsed.applied.length) {
          text = await callTableLlm(ready.cfg, aiValuesRepairPrompt(prompt, text, true));
          parsed = parseAiValues(text, selectionRows(sel));
        }
      } catch (error) {
        throw new Error(errText(error));
      }
      if (!parsed.parsed) throw new Error("模型返回的内容不是可解析的 JSON");
      const fresh = store.node(nodeId);
      if (!fresh) throw new Error("表格已不存在");
      const freshTable = tableOf(fresh);
      const cells: Array<{ row: number; column: number; value: string }> = [];
      let ignored = 0;
      parsed.applied.forEach((item) => {
        const row = Number(item.row);
        const col = item.col === undefined ? (sel.c0 === sel.c1 ? sel.c0 + 1 : 0) : Number(item.col);
        if (!col || row - 1 < sel.r0 || row - 1 > sel.r1 || col - 1 < sel.c0 || col - 1 > sel.c1) { ignored += 1; return; }
        const raw = (freshTable.rows[row - 1] || [])[col - 1];
        if (isMediaRef(raw)) { ignored += 1; return; }
        cells.push({ row, column: col, value: item.value });
      });
      if (!cells.length) throw new Error(ignored ? "模型返回的格子都不在选区里" : "模型没有返回可用的改写结果");
      const after = setCells(freshTable, cells);
      const changes = diffTables(freshTable, after).map((change) => ({ ...change, included: true }));
      if (!changes.length) throw new Error("模型返回的内容和原文相同，没有可应用的改动");
      const note: string[] = [];
      if (ignored) note.push("有 " + ignored + " 处返回不在选区或落在图片格，已忽略");
      if (parsed.missing.length) note.push("有 " + parsed.missing.length + " 行没有返回改写结果");
      if (parsed.invalid.length) note.push("有 " + parsed.invalid.length + " 项返回不合法");
      openAiPreviewModal(store, nodeId, changes, note);
    } catch (error) {
      store.toast(errText(error), 6000);
    } finally {
      setRunning(false);
    }
  };

  // 整条工具条都挡住 pointerdown：否则按下按钮会被画布当成「拖节点」，click 落不到按钮上
  return <div className="tai-tb" ref={barRef} data-tai-toolbar role="group" aria-label="AI 批量改" onPointerDown={(e) => e.stopPropagation()}>
    <span className="tai-tb-count">{selectionCount(sel)} 格 · AI 批量改</span>
    <input className="tai-tb-input" value={text} placeholder="一句话说明怎么改" aria-label="改写要求"
      disabled={busy || running}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); void openPreview(); }
        else if (e.key === "Escape") { e.preventDefault(); onClear(); }
      }} />
    <button type="button" className="tai-btn solid" disabled={!canRun} onClick={() => void openPreview()}
      title={busy ? TABLE_AI_BUSY_TITLE : !typed ? "先写一句改写要求" : "按这句要求生成改动预览"}>
      <Icon name="wand" size="xs" />{running ? "生成中…" : "生成预览"}
    </button>
    <button type="button" className="tai-btn" onClick={onClear}>取消</button>
    {hint ? <span className="tai-hint">{hint}</span> : null}
  </div>;
}

/* ---------- 预览弹层 ---------- */

type PreviewChange = AiDiffChange & { included: boolean };

export function openAiPreviewModal(store: CanvasStore, nodeId: string, changes: AiDiffChange[], note: string[]) {
  openModal((close) => <AiPreviewModal store={store} nodeId={nodeId} changes={changes} note={note} close={close} />, "ai-modal-bg");
}

function AiPreviewModal({ store, nodeId, changes, note, close }: { store: CanvasStore; nodeId: string; changes: AiDiffChange[]; note: string[]; close: () => void }) {
  const [rows, setRows] = useState<PreviewChange[]>(() => changes.map((c) => ({ ...c, included: true })));
  const picked = rows.filter((r) => r.included);
  const toggle = (index: number) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, included: !r.included } : r)));
  const apply = () => {
    if (!picked.length) return;
    const ok = applyAiChanges(store, nodeId, picked);
    if (ok) close();
  };
  return <>
    <ModalHead title={"AI 批量改 · " + rows.length + " 处"} icon="wand" />
    <div className="mbd tai-modal">
      {note.length ? <p className="tai-note">{note.join("；")}</p> : null}
      <div className="tai-diff">
        <div className="tai-diff-head">
          <span />
          <span>位置</span>
          <span>原文</span>
          <span>改动后</span>
        </div>
        {rows.map((row, index) => <div className={"tai-diff-row" + (row.included ? "" : " off")} key={row.row + ":" + row.col}>
          <input type="checkbox" className="tai-check" checked={row.included} aria-label={"应用第 " + row.row + " 行第 " + row.col + " 列"} onChange={() => toggle(index)} />
          <span className="tai-where">第 {row.row} 行 · {row.columnName || "第 " + row.col + " 列"}</span>
          <div className="tai-before" title={row.before}>{row.before || "（空）"}</div>
          <div className="tai-after" title={row.after}>{row.after || "（空）"}</div>
        </div>)}
      </div>
      <div className="tai-foot">
        <span className="tai-count">共 {rows.length} 处变更{picked.length < rows.length ? "（已选 " + picked.length + " 处）" : ""} · 应用后 ⌘Z 一步撤销</span>
        <button type="button" className="tai-btn" onClick={close}>取消</button>
        <button type="button" className="tai-btn solid" disabled={!picked.length} onClick={apply}>应用</button>
      </div>
    </div>
  </>;
}

/* ---------- 智能列弹层 ---------- */

export function openAiColumnPanel(store: CanvasStore, nodeId: string, column: number) {
  const node = store.node(nodeId);
  if (!node) return;
  openModal((close) => <AiColumnPanel store={store} nodeId={nodeId} column={column} close={close} />, "ai-modal-bg");
}

function AiColumnPanel({ store, nodeId, column, close }: { store: CanvasStore; nodeId: string; column: number; close: () => void }) {
  const node = useS((s) => s.doc.nodes.find((n) => n.id === nodeId));
  const models = useS((s) => s.models);
  const run = useAiColumnRun(nodeId);
  const busy = useTableBatchBusy(store, nodeId);
  const t = node ? tableOf(node) : null;
  const aiMeta = t ? normalizeAiColumns(t.aiColumns, t.columns.length)[column] : null;
  const [instruction, setInstruction] = useState(aiMeta ? aiMeta.instruction : "");
  const [systemDraft, setSystemDraft] = useState(() => (t ? String(t.aiSystem || "") : ""));
  const textModels = useMemo(() => models.filter((m) => m.kind === "text"), [models]);
  const ready = t ? tableLlmConfig(t, textModels) : ({ ok: false, reason: "表格不存在" } as const);
  const activeRun = run && run.column === column ? run : null;
  const running = Boolean(activeRun && activeRun.running);

  useEffect(() => {
    setInstruction(aiMeta ? aiMeta.instruction : "");
  }, [aiMeta ? aiMeta.instruction : ""]);

  if (!t || !node) return <div className="mbd">表格已不存在</div>;
  if (column < 0 || column >= t.columns.length) return <div className="mbd">这一列已经不存在了</div>;

  const status = (() => {
    if (!activeRun || !activeRun.total) return activeRun && activeRun.error ? activeRun.error : "";
    const failed = activeRun.failed.length;
    const head = activeRun.running ? "正在生成：" : activeRun.stopped ? "已停止：" : "";
    return head + "已生成 " + activeRun.done + "/" + activeRun.total + " 行" + (failed ? "，失败 " + failed + " 行" : "");
  })();
  const hint = busy ? TABLE_AI_BUSY_TITLE
    : !ready.ok ? ready.reason
      : running ? "正在按指令生成这一列；可随时点「停止」，已生成的格子会保留。"
        : !aiMeta ? "先写这一列的生成指令，再点「按此列生成」。" : "";

  const runNow = () => {
    const text = instruction.trim();
    if (!text) return;
    setAiInstruction(store, nodeId, column, text);
    void runAiColumn(store, nodeId, column);
  };

  return <>
    <ModalHead title={"智能列 · " + (t.columns[column] || "未命名列")} icon="sparkle" />
    <div className="mbd tai-colp">
      {hint ? <p className="tai-note">{hint}</p> : null}
      <textarea className="tai-input" value={instruction} placeholder="这一列怎么生成？例如：按场景描述写一句英文 SD 提示词，不超过 30 词"
        aria-label="这一列的生成指令" rows={3}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()} />
      <div className="tai-cfg">
        <label className="tai-field">
          <span>模型</span>
          <select value={String(t.aiModel || "")} aria-label="智能列使用的模型" data-ai-model
            onChange={(e) => setAiConfig(store, nodeId, { aiModel: e.target.value })}>
            <option value="">跟随默认{textModels[0] ? "：" + textModels[0].name : "（还没有文本模型）"}</option>
            {textModels.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.vendor}</option>)}
          </select>
        </label>
        <label className="tai-field grow">
          <span>系统提示词</span>
          <input value={systemDraft} placeholder={TABLE_AI_SYSTEM_DEFAULT} aria-label="系统提示词" data-ai-system
            onChange={(e) => setSystemDraft(e.target.value)}
            onBlur={() => { if (systemDraft !== String(t.aiSystem || "")) setAiConfig(store, nodeId, { aiSystem: systemDraft }); }}
            onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </div>
      <div className={"tai-status" + (activeRun && activeRun.error && !activeRun.done ? " bad" : "")}>{status}</div>
      {activeRun && activeRun.failed.length ? <div className="tai-fails">
        {activeRun.failed.map((item) => <div className="tai-fail" key={item.row}>
          <span className="tai-fail-text">第 {item.row} 行失败：{item.reason || "未知原因"}</span>
          <button type="button" className="tai-btn tiny" disabled={running || busy}
            onClick={() => void runAiColumn(store, nodeId, column, { rows: [item.row], keepFailed: true })}>重试该行</button>
        </div>)}
      </div> : null}
      <div className="tai-foot">
        <button type="button" className="tai-btn" disabled={running || !aiMeta}
          onClick={() => { setAiInstruction(store, nodeId, column, ""); setInstruction(""); }}>清除指令</button>
        <span className="tai-sp" />
        <button type="button" className="tai-btn solid" disabled={running || busy || !ready.ok || !instruction.trim()} onClick={runNow}>
          <Icon name="sparkle" size="xs" />按此列生成
        </button>
        <button type="button" className="tai-btn" disabled={!running} onClick={() => stopAiColumn(nodeId)}>
          <Icon name="stop" size="xs" />停止
        </button>
        <button type="button" className="tai-btn" onClick={close}>关闭</button>
      </div>
    </div>
  </>;
}
