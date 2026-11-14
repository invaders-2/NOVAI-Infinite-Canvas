/**
 * 生成面板里的「优化提示词」按钮：文本 / 图片 / 视频 / 音频节点通用。
 * 点一下：结合节点画面、上游输入和所选模型改写提示词，边生成边显示在提示词框里；再点一下停止。
 * 结果写回节点（可 ⌘Z 撤销）；失败或停止时提示词恢复原样。
 * 任务的生存在 optimizeTasks 的模块级注册表里：切节点 / 关面板不会中断，切回来还能看到进度。
 */
import { useEffect, useSyncExternalStore } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { attachOptimizeView, cancelOptimize, isOptimizing, optimizeDraft, startOptimize, subscribeOptimizeTasks } from "./optimizeTasks";
import { useCtl } from "./ctx";
import { Icon } from "./Icon";
import { keyHint } from "./shortcuts";

export function OptimizeButton({ node, draft, setDraft, className }: { node: CanvasNode; draft: string; setDraft: (v: string) => void; className: string }) {
  const { store } = useCtl();
  // busy 跟着注册表走：切回这个节点时任务还在，按钮就还是「停止优化」
  const busy = useSyncExternalStore(subscribeOptimizeTasks, () => isOptimizing(node.id), () => false);
  useEffect(() => {
    if (!busy) return;
    const detach = attachOptimizeView(node.id, setDraft);
    // GenPanel 挂载时会用 store 里的提示词重置本地草稿（父组件的效果在子组件之后执行），
    // 微任务里再补一次，切回来看到的是正在生成的文本而不是旧提示词
    queueMicrotask(() => {
      const latest = optimizeDraft(node.id);
      if (latest !== undefined && isOptimizing(node.id)) setDraft(latest);
    });
    return detach;
  }, [busy, node.id, setDraft]);

  const run = () => {
    if (isOptimizing(node.id)) { cancelOptimize(node.id); return; }
    startOptimize(store, node.id, { draft, view: setDraft, undoHint: keyHint("undo") });
  };

  return <button className={className + " tipT" + (busy ? " busy" : "")} data-p="optimize" data-tip={busy ? "停止优化" : "优化提示词"} aria-label={busy ? "停止优化" : "优化提示词"} onClick={run}>
    {busy ? <i className="opt-spin" /> : <Icon name="wand" size="s" />}
  </button>;
}
