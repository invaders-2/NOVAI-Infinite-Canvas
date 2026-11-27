/**
 * 画布助手在 BEAT 画布上「交给画布去跑」的节点：后端只建好节点、写好提示词和参数，并打上 data.agentRun 标记；
 * 画布读到标记后按用户点「运行」同一口径执行（进度、报错、版本历史都和手动一致）。
 *
 *   · 生成节点：runNode；剪辑时间线（agentRun.export）：导出成片放到画布
 *   · 上游也在排队的节点等上游跑完再跑（先出图、再拿图做视频这类串联）
 *   · 每个节点跑完写 data.agentDone = { at, ok, url?, dur?, err?, node_id? }：助手那一轮在等它，读到就知道结果接着做
 */
import { genOf, inputsOf, isGenKind, outOf, type GenKind } from "../model";
import { regenAsNew, runNode, runTableBatch } from "../engine";
import { excludeSelfRefsFlag } from "./selfRefs";
import { runQueueSequentially, type QueueItem } from "./runQueue";
import { pendingCountQueueNodeIds, takeCountQueue } from "./countQueue";
import { hasBatchData, smartBatchMediaKind } from "./runTarget";
import { defaultParams } from "../model";
import { normalizeModelParams } from "./modelResolve";
import { batchOf } from "../table";
import type { CanvasStore } from "../store";
import { exportTimelineNode } from "../timelineAuto";

const running = new WeakMap<CanvasStore, Set<string>>();
type Flag = { at?: number; export?: boolean; params?: Record<string, unknown>; /** 这次生成不拿节点自己的产物当参考图 */ excludeSelfRefs?: boolean; /** 「在这张基础上改」：后端指定要带上的参考图地址 */ referenceImages?: unknown; /** 节点已有结果：右侧新建节点再跑，不在原节点追加版本（审查自动重跑不带它） */ regenAsNew?: boolean };
const flagOf = (n: { data?: unknown }) => (n.data && typeof n.data === "object" ? (n.data as { agentRun?: Flag }).agentRun : undefined);
/**
 * 画布助手「在这张基础上改」的参考图（后端契约，名字固定）：
 * 立即跑写在 data.agentRun.referenceImages，待生成卡片 defer 时写在 data.agentPendingReferenceImages。
 * 读下来交给 runNode → buildRequest 当参考图输入；两者都没有就是空。
 */
function referenceImagesOf(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const row = data as { agentRun?: Flag; agentPendingReferenceImages?: unknown };
  const list = row.agentRun && Array.isArray(row.agentRun.referenceImages) ? row.agentRun.referenceImages : row.agentPendingReferenceImages;
  return Array.isArray(list) ? list.map((u) => String(u || "").trim()).filter(Boolean) : [];
}
/** 同节点多组：待生成卡片批准时写进 data.agentRunQueue 的按序任务（按 countGroup 标记建的队列） */
const queueOf = (n: { data?: unknown }): QueueItem[] => (n.data && typeof n.data === "object" && Array.isArray((n.data as { agentRunQueue?: unknown }).agentRunQueue) ? (n.data as { agentRunQueue: QueueItem[] }).agentRunQueue : []);
const queuedOf = (store: CanvasStore) => {
  // 内存队列优先：画布刷新/服务端回写把节点 data 覆盖掉也不影响「还有 4 组没跑」
  const memory = new Set(pendingCountQueueNodeIds(store.state.canvasId));
  // 助手的 run_batch 可能打在 smart-batch（助手 API 建的批量节点）上：也要纳入，否则 agentRun 永远不消费
  // 按能力识别：gen / timeline / smart-batch，或带 data.batch 的旧类型节点
  return store.state.doc.nodes.filter((n) => (isGenKind(n.kind) || n.kind === "timeline" || n.kind === "smart-batch" || hasBatchData(n.data)) && (!!flagOf(n) || queueOf(n).length > 0 || memory.has(n.id)));
};

function markDone(store: CanvasStore, id: string, done: Record<string, unknown>) {
  if (!store.node(id)) return;
  // 生成完成：agentDone 写回，同时保证「剔除自产物」标记不会残留（它只管这一次运行）
  store.updateNode(id, (x) => {
    const data: Record<string, unknown> = { ...((x.data as Record<string, unknown>) || {}), agentDone: { at: Date.now(), ...done } };
    delete data.agentPendingExcludeSelfRefs;
    return { ...x, data };
  });
}

/** 仅验收：?debugAutorun=1 时把「每个被纳入节点的判定 + 走了哪个分支」记到 window.__autorunLog（不打印生产日志） */
// 模块一加载就把验收日志挂出来：即使之后 autorun 一次都没被调度，也能看到 boot（证明模块已加载）。
// 是否带 ?debugAutorun=1 只影响 console 打印；window.__autorunLog 始终存在（最多保留 200 条）。
try {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __autorunLog?: Array<Record<string, unknown>> };
    const debug = typeof location !== "undefined" && new URLSearchParams(location.search).get("debugAutorun") === "1";
    w.__autorunLog = [{ stage: "boot", at: Date.now(), debug }];
  }
} catch { /* 非浏览器：忽略 */ }

function debugAutorunOn(): boolean {
  try { return typeof location !== "undefined" && new URLSearchParams(location.search).get("debugAutorun") === "1"; } catch { return false; }
}
function autorunLog(row: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __autorunLog?: Array<Record<string, unknown>> };
  w.__autorunLog = [...(w.__autorunLog || []), { at: Date.now(), ...row }].slice(-200);
  if (debugAutorunOn()) { try { console.info("[autorun]", row); } catch { /* 忽略 */ } }
}

/** 找出带标记的节点并执行；返回这次接手了几个 */
export function runAgentQueued(store: CanvasStore): number {
  const mine = running.get(store) || new Set<string>(); running.set(store, mine);
  const queued = queuedOf(store).filter((n) => !mine.has(n.id));
  if (debugAutorunOn()) for (const n of queued) {
    const hasTable = inputsOf(store.state.doc, n.id).some((x) => x.node.kind === "table");
    const journal = batchOf(n).journal;
    autorunLog({ stage: "queued", nodeId: n.id, kind: n.kind, hasBatch: hasBatchData(n.data), hasTable, target: hasTable ? "batch" : hasBatchData(n.data) ? "smart-batch" : "single", reason: hasTable ? "table-input" : hasBatchData(n.data) ? "batch-data" : "single", journal: journal ? journal.rows.map((r) => r.row + ":" + r.status) : null });
  }
  {
    const flagged = store.state.doc.nodes.filter((n) => !!flagOf(n));
    autorunLog({ stage: "cycle", queued: queued.length, flagged: flagged.map((n) => n.id) });
    for (const n of flagged) if (!queued.some((q) => q.id === n.id)) autorunLog({ stage: "skip", nodeId: n.id, kind: n.kind, reason: mine.has(n.id) ? "already-running" : "not-runnable" });
  }
  if (!queued.length) return 0;
  const ids = new Set(queued.map((n) => n.id));
  /** 每个节点这次要不要剔除自产物：清标记前先读下来（标记两种：agentRun.excludeSelfRefs / agentPendingExcludeSelfRefs） */
  const excludeSelf = new Map<string, boolean>();
  /** 同节点多组：清标记前先记下按序队列（没有队列 = 旧路径，仍按节点去重只跑一次） */
  const queues = new Map<string, QueueItem[]>();
  /** 助手「在这张基础上改」的参考图：清标记前先读下来，跑的时候当额外参考图输入 */
  const references = new Map<string, string[]>();
  /** 助手重跑已有结果的节点：改成右侧新建节点再跑（后端契约 agentRun.regenAsNew），清标记前先读下来 */
  const regenNew = new Set<string>();
  // 先清标记（不进撤销历史），避免保存 / 刷新后被重复执行；
  // agentPendingExcludeSelfRefs 也在这里一起清掉，避免残留影响之后的手动重跑
  for (const n of queued) {
    mine.add(n.id);
    const flag = flagOf(n);
    excludeSelf.set(n.id, flag?.excludeSelfRefs === true || excludeSelfRefsFlag(n.data));
    references.set(n.id, referenceImagesOf(n.data));
    if (flag?.regenAsNew === true) regenNew.add(n.id);
    // 内存队列优先（approve 时放的，刷新不会丢）；没有就回落到节点 data.agentRunQueue
    const memory = takeCountQueue(store.state.canvasId, n.id);
    if (memory && memory.length) queues.set(n.id, memory);
    else if (queueOf(n).length) queues.set(n.id, queueOf(n).slice());
    // 标记里带了用户在待生成卡片选的模型 / 参数：先套到节点上再跑（以它为准，不用节点上可能残留的默认模型）
    if (flag?.params && isGenKind(n.kind)) store.patchGen(n.id, (g) => ({ params: { ...g.params, ...flag.params } as typeof g.params }));
    store.updateNode(n.id, (x) => { const d = { ...((x.data as Record<string, unknown>) || {}) }; delete d.agentRun; delete d.agentDone; delete d.agentPending; delete d.agentPendingExcludeSelfRefs; delete d.agentPendingReferenceImages; delete d.agentRunQueue; return { ...x, data: d }; });
  }
  const doc = store.state.doc;
  const waitsFor = (id: string) => inputsOf(doc, id).map((x) => x.node.id).filter((up) => ids.has(up));
  const done = new Map<string, Promise<boolean>>();
  const start = (id: string): Promise<boolean> => {
    let p = done.get(id);
    if (!p) {
      p = (async () => {
        await Promise.all(waitsFor(id).map(start));
        try {
          const n0 = store.node(id);
          // 助手 API 建的 smart-batch：BEAT 没有它的 UI body，先迁成 BEAT 的批量生成节点（image/video）再跑批量
          if (n0?.kind === "smart-batch") {
            const media = smartBatchMediaKind(n0.data);
            const model = store.defaultModel(media);
            if (!model) {
              markDone(store, id, { ok: false, err: "批量节点没有可用的" + (media === "video" ? "视频" : "图片") + "模型，先在设置里添加模型再跑" });
              return false;
            }
            store.updateNode(id, (x) => {
              const data = { ...((x.data as Record<string, unknown>) || {}) } as Record<string, unknown>;
              delete data.tableBatchVideo;
              const gen = { title: x.text || "批量出图", prompt: "", params: defaultParams(media, model), hist: [], hi: 0, order: [] };
              return { ...x, kind: media, data: { ...data, gen } };
            });
          }
          // 助手交来的组件编辑（多角度 / 重打光 / 白膜 / 增强）：走「更多」菜单同一套编辑逻辑，不当普通生图跑
          const action = n0 && n0.kind === "image" && n0.data && typeof n0.data === "object"
            ? (n0.data as { agentAction?: unknown }).agentAction : undefined;
          if (action && typeof action === "object") {
            const { runAgentImageAction } = await import("../ui/editors/registry");
            const r = await runAgentImageAction(store, id, action as { op?: string; params?: Record<string, unknown>; source_url?: string });
            markDone(store, id, r.ok ? { ok: true, url: r.url } : { ok: false, err: r.err || "组件编辑失败" });
            return r.ok;
          }
          if (n0?.kind === "timeline") {
            const r = await exportTimelineNode(store, id);
            markDone(store, id, { ok: r.ok, url: r.url, node_id: r.nodeId, dur: r.dur, err: r.err });
            return r.ok;
          }
          // 同节点多组（countGroup 队列）：按顺序一组一组跑，每组套用自己的参数；不按节点去重吞掉
          const group = (queues.get(id) || []).slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
          if (group.length && n0 && isGenKind(n0.kind)) {
            const results = await runQueueSequentially(group, async (item) => {
              if (!store.node(id)) return { ok: false, err: "节点已被删除" };
              if (item.settings && typeof item.settings === "object") {
                // 兜底：队列里万一是短 id / 只有 modelConfigId，也归一成完整 provider::model 再套进节点
                const raw = item.settings as Record<string, unknown>;
                const configId = typeof raw.modelConfigId === "string" ? raw.modelConfigId : "";
                const settings = configId.includes("::")
                  ? { ...raw, model: configId, provider: configId.split("::")[0] }
                  : normalizeModelParams(store.state.models || [], n0.kind as GenKind, raw as { model?: unknown; provider?: unknown });
                store.patchGen(id, (g) => ({ params: { ...g.params, ...(settings as Record<string, unknown>) } as typeof g.params }));
              }
              const okOne = await runNode(store, id, { inPlace: true, chain: true, excludeSelfRefs: excludeSelf.get(id) === true, referenceImages: references.get(id) || [] });
              const n2 = store.node(id); const g2 = n2 ? genOf(n2) : null; const o2 = n2 ? outOf(n2) : null;
              const ok = !!okOne && !g2?.err && !!(o2?.url || o2?.text);
              return { ok, url: o2?.url, dur: o2?.dur, err: ok ? "" : (g2?.err || "画布没有拿到生成结果") };
            });
            const last = results[results.length - 1];
            const bad = results.find((row) => !row.ok);
            markDone(store, id, bad ? { ok: false, err: bad.err } : { ok: true, url: last?.url, dur: last?.dur });
            return !bad;
          }
          // 上游有表格：这是「表格 → 逐行批量」节点，必须整批跑，不能单次 runNode（会把表格输入当成普通上下文）
          const hasTable = inputsOf(store.state.doc, id).some((x) => x.node.kind === "table");
          autorunLog({ stage: "branch", nodeId: id, branch: hasTable ? "batch" : String(n0?.kind) === "timeline" ? "timeline" : group.length ? "countGroup" : "single" });
          if (hasTable) {
            // 按能力补默认模型：节点 params.model 可能不在前端模型清单（或只有短 id），不补会让每行「无法组装请求」
            if (n0 && isGenKind(n0.kind) && !store.modelOf(store.node(id)!)) {
              const fallback = store.defaultModel(n0.kind);
              if (fallback) store.patchGen(id, (g) => ({ params: { ...g.params, model: fallback.id } as typeof g.params }));
            }
            // 表格批量：逐行生成用的是表格行素材，不涉及「这一行自己的产物」，保持原有调用（标记只影响单节点生成）
            await runTableBatch(store, id);
            const n = store.node(id); const { journal } = n ? batchOf(n) : { journal: null };
            const rows = journal?.rows || [];
            const failed = rows.filter((r) => r.status === "failed");
            const completed = rows.filter((r) => r.status === "completed").sort((a, b) => a.row - b.row);
            if (failed.length) {
              const detail = failed.slice(0, 3).map((r) => `第 ${r.row} 行${r.error ? `（${r.error}）` : ""}`).join("；");
              markDone(store, id, { ok: false, err: `批量生成有 ${failed.length} 行失败：${detail}`, failed_rows: failed.map((r) => r.row) });
              return false;
            }
            if (!rows.length || !completed.length) {
              markDone(store, id, { ok: false, err: "表格没有可执行的行（空表，或起始行之后没有内容）" });
              return false;
            }
            if (completed.length < rows.length) {
              markDone(store, id, { ok: false, err: `批量没有跑完：${completed.length}/${rows.length} 行完成`, pending_rows: rows.filter((r) => r.status !== "completed").map((r) => r.row) });
              return false;
            }
            const first = completed[0];
            const result = first.nodeId ? store.node(first.nodeId) : undefined;
            const out = result ? outOf(result) : null;
            if (!out?.url) {
              markDone(store, id, { ok: false, err: "批量全部完成，但第一行结果没有拿到地址", node_id: first.nodeId });
              return false;
            }
            markDone(store, id, { ok: true, node_id: first.nodeId, url: out.url, dur: out.dur });
            return true;
          }
          // 助手重跑一个已经有结果的节点：不在原节点追加版本（会把这一版当参考越改越偏），
          // 改成「右侧新建同类型节点 + 复制提示词 / 参数 / 输入」再跑，旧节点原样保留。
          // 输入等价于用户点「再来一张」的 fresh 语义：只复制来源节点的输入，绝不连旧节点、不把旧结果当参考。
          // 只走单节点路径：表格逐行批量 / 时间线 / 同节点多组 / 组件编辑都在上面各自分支处理，行为不变。
          const cur = store.node(id);
          if (regenNew.has(id) && cur && isGenKind(cur.kind) && outOf(cur)) {
            const fresh = regenAsNew(store, cur, undefined, { linkSelf: false, fresh: true, quiet: true });
            const okFresh = await runNode(store, fresh.id, { inPlace: true, chain: true, excludeSelfRefs: excludeSelf.get(id) === true, referenceImages: references.get(id) || [] });
            const fn = store.node(fresh.id); const fg = fn ? genOf(fn) : null; const fo = fn ? outOf(fn) : null;
            const good = !!okFresh && !!fn && !fg?.err && !!(fo?.url || fo?.text);
            const reason = good ? "" : (fg?.err || "画布没有拿到生成结果");
            // 助手等的是「它点的那个节点」：agentDone 写在旧节点上并带上新节点 id，新节点也留一份
            markDone(store, id, good ? { ok: true, url: fo?.url, node_id: fresh.id, dur: fo?.dur } : { ok: false, err: reason, node_id: fresh.id });
            markDone(store, fresh.id, good ? { ok: true, url: fo?.url, dur: fo?.dur } : { ok: false, err: reason });
            autorunLog({ stage: "regen-new-node", from: id, to: fresh.id, ok: good });
            return good;
          }
          const ok = await runNode(store, id, { inPlace: true, chain: true, excludeSelfRefs: excludeSelf.get(id) === true, referenceImages: references.get(id) || [] });
          autorunLog({ stage: "single-done", nodeId: id, ok, err: store.node(id)?.data ? (genOf(store.node(id)!).err || "") : "" });
          const n = store.node(id); const g = n ? genOf(n) : null; const o = n ? outOf(n) : null;
          const good = !!ok && !!n && !g?.err && !!(o?.url || o?.text);
          markDone(store, id, good ? { ok: true, url: o?.url, dur: o?.dur } : { ok: false, err: g?.err || "画布没有拿到生成结果" });
          return good;
        } catch (e) {
          markDone(store, id, { ok: false, err: e instanceof Error ? e.message : "生成失败" });
          return false;
        } finally { mine.delete(id); }
      })();
      done.set(id, p);
    }
    return p;
  };
  for (const n of queued) void start(n.id);
  const names = queued.slice(0, 3).map((n) => "「" + (n.kind === "timeline" ? n.text || "剪辑时间线" : genOf(n).title) + "」").join("、");
  store.toast(`画布助手交来 ${queued.length} 个任务，已开始运行：${names}${queued.length > 3 ? " 等" : ""}`);
  return queued.length;
}
