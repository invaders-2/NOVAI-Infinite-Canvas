/** 同节点多组的顺序执行器（纯逻辑，便于桩函数断言）：按队列一条一条 await，前面失败也继续交给调用方判断。 */
export type QueueItem = { index?: number; settings?: Record<string, unknown> };
export async function runQueueSequentially<T>(items: QueueItem[], run: (item: QueueItem) => Promise<T>): Promise<T[]> {
    const out: T[] = [];
    for (const item of items) out.push(await run(item));
    return out;
}
