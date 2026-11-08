/**
 * 「待发送」消息队列（画布助手输入区上方的 aQueue）：纯数据结构，便于 node 直接测。
 * 每条消息带一份发送上下文快照（@ 记号原文 + 技能 / 固定节点 / 选中节点 / 素材引用 / 本轮联网），
 * 自动发送时按快照还原，不用「发送那一刻」的选中态。
 */
export const QUEUE_MAX = 5;

/** 发送上下文快照：和输入区当前状态解耦，改完草稿不影响已排队的那条 */
export type QueueSnapshot = {
  /** 输入框原始文本（含 @{节点id} / @ref{} / @app{} / @skill{} 记号） */
  text: string;
  skill: string | null;
  pinned: string[];
  selected: string[];
  refs: Array<{ id: string; kind: "app" | "asset"; title: string; ref: string; detail?: string }>;
  webPlugin: boolean;
};

export type QueuedMsg = {
  id: string;
  /** 队列行上显示的文本（引用记号已还原成人话，技能不显示） */
  label: string;
  snap: QueueSnapshot;
  /** 「立即发送」在忙碌时标成优先：下一次空闲先发这条，不排 FIFO 后面 */
  urgent?: boolean;
};

export type EnqueueResult = { ok: boolean; list: QueuedMsg[] };

/** 追加到队尾；到上限就原样返回（调用方据此提示，别丢用户输入） */
export function enqueue(list: QueuedMsg[], item: QueuedMsg): EnqueueResult {
  if (list.length >= QUEUE_MAX) return { ok: false, list };
  return { ok: true, list: [...list, item] };
}

export function removeQueued(list: QueuedMsg[], id: string): QueuedMsg[] {
  return list.filter((item) => item.id !== id);
}

/** 取下一条要发的：有「立即优先」就先取它，否则取队首；返回值里不含被取走的那条 */
export function takeFirst(list: QueuedMsg[]): { first: QueuedMsg | null; rest: QueuedMsg[] } {
  if (!list.length) return { first: null, rest: list };
  const urgent = list.findIndex((item) => item.urgent);
  const index = urgent >= 0 ? urgent : 0;
  return { first: list[index], rest: list.filter((_, i) => i !== index) };
}

/** 把某条标成「立即优先」（不改变它在队列里的位置，takeFirst 会先取它） */
export function markUrgent(list: QueuedMsg[], id: string): QueuedMsg[] {
  return list.map((item) => (item.id === id ? { ...item, urgent: true } : item));
}

/** 忙碌时又点了一条「立即发送」：标成优先并插到队首（排在已等空闲的 pendingUrgent 之后），不覆盖前一条 */
export function prependUrgent(list: QueuedMsg[], item: QueuedMsg): QueuedMsg[] {
  return [{ ...item, urgent: true }, ...list.filter((x) => x.id !== item.id)];
}
