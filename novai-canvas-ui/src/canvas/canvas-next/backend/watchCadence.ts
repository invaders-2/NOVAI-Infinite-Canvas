/**
 * 任务快照的轮询节奏 —— C8 之后只作**断线兜底**：运行中优先订阅 SSE（agentStream.ts），
 * 流健康时一次快照请求都不发；只有连不上 / 断流重连期间才按这个间隔兜底。
 *
 *   · 兜底轮询：1000ms（≥750ms，20 秒窗口最多 20 次 /snapshot，满足「≤30 次」）
 *   · 已 settled：1500ms（订阅方通常已经 stop）
 *   · 页面不可见：0 = 暂停；回到前台立刻补刷一次
 */
export const WATCH_FALLBACK_MS = 1000;
export const WATCH_SETTLED_MS = 1500;
export const WATCH_STREAM_STALL_MS = 8000;

export type WatchCadence = { elapsedMs?: number; settled: boolean; hidden?: boolean; streamLive?: boolean };

export function watchDelay(state: WatchCadence): number {
    if (state.hidden) return 0;
    if (state.settled) return WATCH_SETTLED_MS;
    return WATCH_FALLBACK_MS;
}

/** 一段时间内预计会发多少次 /snapshot（流健康 = 0；验收口径：20s 内 ≤30） */
export function watchSnapshotPolls(durationMs: number, state: WatchCadence): number {
    if (state.hidden || state.streamLive) return 0;
    const delay = watchDelay(state);
    if (!delay || !(durationMs > 0)) return 0;
    return Math.floor(durationMs / delay);
}
