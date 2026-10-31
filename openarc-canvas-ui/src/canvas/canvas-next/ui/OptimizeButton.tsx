/**
 * 生成面板里的「优化提示词」按钮：文本 / 图片 / 视频 / 音频节点通用。
 * 点一下：结合节点画面、上游输入和所选模型改写提示词，边生成边显示在提示词框里；再点一下停止。
 * 结果写回节点（可 ⌘Z 撤销）；失败或停止时提示词恢复原样。
 */
import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { FALLBACK_TEXT, nodeError } from "../errorText";
import { genOf, inputsOf } from "../model";
import { relinkMentions } from "../mentions";
import { buildOptimizeMessages, canOptimize, cleanOptimized, optimizeContext, pickOptimizerModel } from "../promptOptimize";
import { useCtl } from "./ctx";
import { Icon } from "./Icon";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function OptimizeButton({ node, draft, setDraft, className }: { node: CanvasNode; draft: string; setDraft: (v: string) => void; className: string }) {
  const { store } = useCtl();
  const [busy, setBusy] = useState(false); const ac = useRef<AbortController | null>(null);
  // 换节点 / 面板关掉：停掉还没回来的改写，免得结果写到别的节点
  useEffect(() => () => { ac.current?.abort(); ac.current = null; }, [node.id]);

  const run = async () => {
    if (ac.current) { ac.current.abort(); return; }
    const id = node.id; const live = store.node(id); if (!live) return;
    if (draft !== genOf(live).prompt) store.patchGen(id, { prompt: draft });
    const ctx = optimizeContext(store, store.node(id)!);
    if (!canOptimize(ctx)) { store.toast("先写一点提示词，或给节点连上输入"); return; }
    const needVision = !!ctx.own?.image || ctx.upstream.some((s) => s.image);
    const tm = pickOptimizerModel(store.state.models, ctx, needVision);
    if (!tm) { store.toast("还没有可用的文本模型，请在 设置 › 模型 里添加"); return; }
    const { messages, images } = buildOptimizeMessages(ctx, !!tm.vision);
    const ups = inputsOf(store.state.doc, id).map((x) => x.node); const relink = (t: string) => relinkMentions(t, ups);
    const before = draft; const ctrl = new AbortController(); ac.current = ctrl; setBusy(true);
    try {
      const out = await store.backend.chat({ canvasId: store.state.canvasId, configId: tm.id, messages, images }, (full) => { if (!ctrl.signal.aborted) setDraft(relink(cleanOptimized(full))); }, ctrl.signal);
      if (ctrl.signal.aborted) throw new Error("STOPPED");
      const text = relink(cleanOptimized(out)); if (!text) throw new Error("EMPTY");
      if (!store.node(id)) return;
      store.patchGen(id, { prompt: text }, { history: true }); setDraft(text);
      store.toast(`已用 ${esc(tm.name)} 优化提示词${needVision && !tm.vision ? "（该模型看不了图，只参考了文字）" : ""}，⌘Z 可撤销`, 3600);
    } catch (e) {
      setDraft(before);
      if (ctrl.signal.aborted) store.toast("已停止优化，提示词未改动");
      else {
        const ne = nodeError(e);
        const why = e instanceof Error && e.message === "EMPTY" ? "模型没有返回内容" : ne.err === FALLBACK_TEXT ? `调用「${tm.name}」没有成功${ne.errCode ? `（${ne.errCode.slice(0, 60)}）` : ""}，可稍后重试` : ne.err;
        store.toast("优化提示词失败：" + esc(why), 4200);
      }
    } finally {
      if (ac.current === ctrl) ac.current = null; setBusy(false);
    }
  };

  return <button className={className + " tipT" + (busy ? " busy" : "")} data-p="optimize" data-tip={busy ? "停止优化" : "优化提示词"} aria-label={busy ? "停止优化" : "优化提示词"} onClick={() => void run()}>
    {busy ? <i className="opt-spin" /> : <Icon name="sparkle" size="s" />}
  </button>;
}
