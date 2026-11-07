/**
 * 画布助手在 BEAT 画布上「交给画布去跑」的节点：后端只建好节点、写好提示词和参数，并打上 data.agentRun 标记；
 * 画布读到标记后按用户点「运行」同一口径执行（进度、报错、版本历史都和手动一致）。
 *
 *   · 生成节点：runNode；剪辑时间线（agentRun.export）：导出成片放到画布
 *   · 上游也在排队的节点等上游跑完再跑（先出图、再拿图做视频这类串联）
 *   · 每个节点跑完写 data.agentDone = { at, ok, url?, dur?, err?, node_id? }：助手那一轮在等它，读到就知道结果接着做
 */
import { genOf, inputsOf, isGenKind, outOf } from "../model";
import { runNode } from "../engine";
import type { CanvasStore } from "../store";
import { exportTimelineNode } from "../timelineAuto";

const running = new WeakMap<CanvasStore, Set<string>>();
type Flag = { at?: number; export?: boolean; params?: Record<string, unknown> };
const flagOf = (n: { data?: unknown }) => (n.data && typeof n.data === "object" ? (n.data as { agentRun?: Flag }).agentRun : undefined);
const queuedOf = (store: CanvasStore) => store.state.doc.nodes.filter((n) => (isGenKind(n.kind) || n.kind === "timeline") && !!flagOf(n));

function markDone(store: CanvasStore, id: string, done: Record<string, unknown>) {
  if (!store.node(id)) return;
  store.updateNode(id, (x) => ({ ...x, data: { ...((x.data as Record<string, unknown>) || {}), agentDone: { at: Date.now(), ...done } } }));
}

/** 找出带标记的节点并执行；返回这次接手了几个 */
export function runAgentQueued(store: CanvasStore): number {
  const mine = running.get(store) || new Set<string>(); running.set(store, mine);
  const queued = queuedOf(store).filter((n) => !mine.has(n.id));
  if (!queued.length) return 0;
  const ids = new Set(queued.map((n) => n.id));
  // 先清标记（不进撤销历史），避免保存 / 刷新后被重复执行
  for (const n of queued) {
    mine.add(n.id);
    const flag = flagOf(n);
    // 标记里带了用户在待生成卡片选的模型 / 参数：先套到节点上再跑（以它为准，不用节点上可能残留的默认模型）
    if (flag?.params && isGenKind(n.kind)) store.patchGen(n.id, (g) => ({ params: { ...g.params, ...flag.params } as typeof g.params }));
    store.updateNode(n.id, (x) => { const d = { ...((x.data as Record<string, unknown>) || {}) }; delete d.agentRun; delete d.agentDone; delete d.agentPending; return { ...x, data: d }; });
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
          if (n0?.kind === "timeline") {
            const r = await exportTimelineNode(store, id);
            markDone(store, id, { ok: r.ok, url: r.url, node_id: r.nodeId, dur: r.dur, err: r.err });
            return r.ok;
          }
          const ok = await runNode(store, id, { inPlace: true, chain: true });
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
