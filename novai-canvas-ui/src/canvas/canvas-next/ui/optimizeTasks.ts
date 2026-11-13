/**
 * 「优化提示词」任务的模块级注册表（按 nodeId 一个）。
 *
 * 为什么不在组件里：切换节点 / 关掉面板会让按钮卸载，任务如果跟着组件走就会停在半路；
 * 放到模块里，面板只是「显示器」——挂着就同步流式文本，卸掉就只收集，切回来再接上。
 * 结果按发起时的 nodeId 写回，节点被删掉（删除 / 撤销 / 远端同步）就结束任务，避免写到已删节点。
 */
import { FALLBACK_TEXT, nodeError } from "../errorText";
import { genOf, inputsOf } from "../model";
import { relinkMentions } from "../mentions";
import { buildOptimizeMessages, canOptimize, cleanOptimized, optimizeContext, pickOptimizerModel, unmaskRefs } from "../promptOptimize";
import type { CanvasStore } from "../store";

export type OptimizeApply = (text: string) => void;

export type OptimizeTask = {
  controller: AbortController;
  /** 已收到的改写文本（不一定是最终结果）；面板卸掉期间也一直更新 */
  draft: string;
  /** 发起时的草稿：停止 / 失败时恢复它 */
  before: string;
  /** 当前正在显示这个节点的面板（卸掉 = null）；只有非空时才把流式文本渲染出去 */
  apply: OptimizeApply | null;
};

const tasks = new Map<string, OptimizeTask>();
const listeners = new Set<() => void>();

const changed = () => { for (const fn of [...listeners]) fn(); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function subscribeOptimizeTasks(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function isOptimizing(nodeId: string): boolean { return tasks.has(nodeId); }
export function optimizeDraft(nodeId: string): string | undefined { return tasks.get(nodeId)?.draft; }

/**
 * 面板挂载 / 切回这个节点：接上还在进行的任务，立刻显示当前的流式文本。
 * 返回的解绑函数只断开显示，不打断任务（切走不是「停止」）。
 */
export function attachOptimizeView(nodeId: string, apply: OptimizeApply): () => void {
  const t = tasks.get(nodeId);
  if (!t) return () => {};
  t.apply = apply;
  apply(t.draft);
  return () => { if (t.apply === apply) t.apply = null; };
}

/** 再点一次按钮 = 只取消这个节点的任务；提示词怎么收尾由任务自己按「主动停止」处理 */
export function cancelOptimize(nodeId: string): void {
  tasks.get(nodeId)?.controller.abort();
}

export type StartOptimizeOptions = {
  /** 面板里当前的草稿（发起前先落盘，和原来一致） */
  draft: string;
  /** 发起时仍显示这个节点的面板；之后切走 / 切回来由 attachOptimizeView 接管 */
  view?: OptimizeApply;
  /** 成功提示里的撤销键位（「⌘Z 可撤销」），由界面按平台传入 */
  undoHint?: string;
};

/** 开始优化；没有可发的内容 / 没有可用模型时只提示，不注册任务 */
export function startOptimize(store: CanvasStore, nodeId: string, opts: StartOptimizeOptions): void {
  if (tasks.has(nodeId)) return;
  const live = store.node(nodeId); if (!live) return;
  if (opts.draft !== genOf(live).prompt) store.patchGen(nodeId, { prompt: opts.draft });
  const ctx = optimizeContext(store, live);
  if (!canOptimize(ctx)) { store.toast("先写一点提示词，或给节点连上输入"); return; }
  const needVision = !!ctx.own?.image || ctx.upstream.some((s) => s.image);
  // 设置里单独选过的「优化提示词模型」优先；没设置时和原来一样用文本默认模型
  const preferId = store.optimizeModel()?.id || store.defaultModel("text")?.id;
  const tm = pickOptimizerModel(store.state.models, ctx, needVision, preferId);
  if (!tm) { store.toast("还没有可用的文本模型，请在 设置 › 模型 里添加"); return; }
  const { messages, images } = buildOptimizeMessages(ctx, !!tm.vision);
  // 兜底：模型万一没保住占位符而是写回了「@标题」，再按标题换回记号（本节点也一起给）
  const ups = [...inputsOf(store.state.doc, nodeId).map((x) => x.node), live];
  const relink = (t: string, appendMissing: boolean) => {
    const { text, missing } = unmaskRefs(cleanOptimized(t), ctx.mask, { appendMissing });
    return { text: relinkMentions(text, ups), missing };
  };

  const controller = new AbortController();
  const task: OptimizeTask = { controller, draft: opts.draft, before: opts.draft, apply: opts.view ?? null };
  tasks.set(nodeId, task); changed();

  // 节点被删掉（删除 / 撤销 / 远端同步）就立刻结束：结果没有地方可写
  const off = store.subscribe(() => { if (!store.node(nodeId) && !controller.signal.aborted) controller.abort(); });

  const stream = (text: string) => {
    if (controller.signal.aborted || tasks.get(nodeId) !== task) return;
    task.draft = text;
    // 面板已经切走（apply 为空）就只收集，不渲染，避免串到别的节点
    task.apply?.(text);
  };

  void (async () => {
    try {
      // 模型强度只属于节点所选的那个模型：改写用的模型和它一致时才带（别把 A 模型的档位塞给 B）
      const nodeThink = String((genOf(live).params as { think?: string }).think || "");
      const thinkLevel = tm.id === store.modelOf(live)?.id ? nodeThink : "";
      const out = await store.backend.chat({ canvasId: store.state.canvasId, configId: tm.id, thinkLevel: thinkLevel || undefined, messages, images },
        (full) => stream(relink(full, false).text), controller.signal);
      if (controller.signal.aborted) throw new Error("STOPPED");
      const { text, missing } = relink(out, true); if (!text) throw new Error("EMPTY");
      if (!store.node(nodeId)) return;
      store.patchGen(nodeId, { prompt: text }, { history: true });
      task.draft = text; task.apply?.(text);
      store.toast(`已用 ${esc(tm.name)} 优化提示词${needVision && !tm.vision ? "（该模型看不了图，只参考了文字）" : ""}${missing.length ? `（${missing.length} 个引用模型没保住，已补回末尾）` : ""}${opts.undoHint ? `，${opts.undoHint} 可撤销` : ""}`, 3600);
    } catch (e) {
      if (controller.signal.aborted) {
        // 节点没了（删除 / 撤销）就安静收尾：没有提示词可恢复，也不该说「已停止」
        if (store.node(nodeId)) { task.apply?.(task.before); store.toast("已停止优化，提示词未改动"); }
      } else {
        task.apply?.(task.before);
        const ne = nodeError(e);
        const why = e instanceof Error && e.message === "EMPTY" ? "模型没有返回内容" : ne.err === FALLBACK_TEXT ? `调用「${tm.name}」没有成功${ne.errCode ? `（${ne.errCode.slice(0, 60)}）` : ""}，可稍后重试` : ne.err;
        store.toast("优化提示词失败：" + esc(why), 4200);
      }
    } finally {
      off();
      if (tasks.get(nodeId) === task) { tasks.delete(nodeId); changed(); }
    }
  })();
}
