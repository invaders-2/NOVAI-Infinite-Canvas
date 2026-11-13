/**
 * 同节点多组的「内存队列」：不依赖画布文档持久化。
 * approve 时把 countGroup 队列放进来（key = canvasId + nodeId）；autorun 开始时取出，跑完自动删除。
 * 画布刷新权威文档 / 服务端回写节点 data 都不会影响这里。
 */
export type CountQueueItem = { index?: number; settings?: Record<string, unknown> };
const queues = new Map<string, CountQueueItem[]>();
const keyOf = (canvasId: string, nodeId: string) => String(canvasId || "") + "::" + String(nodeId || "");

/** 记下一组按序执行的任务（index 小的先跑） */
export function rememberCountQueue(canvasId: string, nodeId: string, items: CountQueueItem[]): void {
    if (!canvasId || !nodeId || !items || !items.length) return;
    queues.set(keyOf(canvasId, nodeId), items.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0)));
}

/** 取出并删除（执行入口只取一次，避免重复跑） */
export function takeCountQueue(canvasId: string, nodeId: string): CountQueueItem[] | null {
    const key = keyOf(canvasId, nodeId);
    const items = queues.get(key);
    if (!items) return null;
    queues.delete(key);
    return items.slice();
}

/** 这张画布上还有哪些节点有待跑的队列（autorun 据此把节点纳入本轮） */
export function pendingCountQueueNodeIds(canvasId: string): string[] {
    const prefix = String(canvasId || "") + "::";
    const out: string[] = [];
    for (const key of queues.keys()) if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    return out;
}

/** 仅测试用：清空内存 */
export function clearCountQueues(): void { queues.clear(); }
