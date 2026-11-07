/**
 * 画布助手建完节点后把视图带过去。
 *
 * 节点不是前端建的：后端画布工具（server/agents/ 路由到 main.py 的 22 个画布工具）直接改画布文档，
 * 前端只有在 refreshForAgent → store.refreshAuthoritative() 换成服务端文档之后才看得见新节点，
 * 所以只能用「刷新前后的节点 id 集合」判断这次新增了哪些 —— 用户自己手动建 / 拖节点不走这条路径，
 * 不会被误判成助手建的。
 *
 * 一次任务常连着建好几个（表格 + 批量 + 结果节点），或分几轮刷新才落地：
 * 先攒 420ms，等这一串都落定后一次性 fit，别每个节点都跳一次视图。
 */
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { bounds } from "../model";
import type { CanvasStore } from "../store";
import type { Ctl } from "../ui/ctx";

/** 静默这么久没有新节点才聚焦；比动画略长，够盖住同一轮里的连续刷新 */
const SETTLE_MS = 420;
/** 单个节点留白大一点，看起来就是「居中在这个节点上」；多个节点用常规留白 */
const SINGLE_PAD = 160;
const MULTI_PAD = 88;
/** 新节点已经完整露出来时不动视图：助手只补一点小改动，别把用户正看着的地方挪走 */
const VISIBLE_MARGIN = 24;

type Pending = { ctl: Ctl; ids: Set<string>; timer: number };
let pending: Pending | null = null;

/** 刷新前记一份节点 id 集合 */
export function nodeIdSet(store: CanvasStore): Set<string> {
  return new Set(store.state.doc.nodes.map((node) => node.id));
}

/** 刷新落地后调用：把这次新增的节点攒起来，静默 420ms 后一次性聚焦 */
export function revealAddedNodes(ctl: Ctl, before: Set<string>): void {
  const added = ctl.store.state.doc.nodes.filter((node) => !before.has(node.id));
  if (!added.length) return;
  if (!pending || pending.ctl !== ctl) {
    if (pending) window.clearTimeout(pending.timer);
    pending = { ctl, ids: new Set<string>(), timer: 0 };
  }
  const current: Pending = pending;
  for (const node of added) current.ids.add(node.id);
  window.clearTimeout(current.timer);
  current.timer = window.setTimeout(() => {
    if (pending === current) pending = null;
    focusAdded(ctl, current.ids);
  }, SETTLE_MS);
}

/** 离开画布时清掉还没触发的聚焦 */
export function cancelReveal(ctl: Ctl): void {
  if (!pending || pending.ctl !== ctl) return;
  window.clearTimeout(pending.timer);
  pending = null;
}

function visible(ctl: Ctl, node: CanvasNode): boolean {
  const bb = bounds([node]);
  if (!bb) return false;
  const rect = ctl.rect(); const view = ctl.store.state.view;
  const left = rect.left + bb.x * view.k + view.x;
  const top = rect.top + bb.y * view.k + view.y;
  return left >= rect.left + VISIBLE_MARGIN && top >= rect.top + VISIBLE_MARGIN
    && left + bb.w * view.k <= rect.right - VISIBLE_MARGIN
    && top + bb.h * view.k <= rect.bottom - VISIBLE_MARGIN;
}

function focusAdded(ctl: Ctl, ids: Set<string>): void {
  if (typeof document !== "undefined" && document.hidden) return;
  const nodes = [...ids].map((id) => ctl.store.node(id)).filter((node): node is CanvasNode => !!node);
  if (!nodes.length) return;
  if (nodes.every((node) => visible(ctl, node))) return;
  ctl.fitTo(nodes, nodes.length > 1 ? MULTI_PAD : SINGLE_PAD, 1);
}
