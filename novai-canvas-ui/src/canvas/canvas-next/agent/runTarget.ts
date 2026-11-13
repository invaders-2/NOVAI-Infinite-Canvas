/** 助手交给画布执行的节点类型判定（纯函数，便于单测）
 *  按「能力」而不是 type 字面：有 data.batch（withBatch 写的）且上游有表格 → 批量；smart-batch 也走批量。 */
import { isGenKind } from "../model";

export type AgentRunTarget = "timeline" | "batch" | "single" | "smart-batch" | null;

export function hasBatchData(data: unknown): boolean {
    return !!data && typeof data === "object" && !!(data as { batch?: unknown }).batch;
}

/**
 * @param hasTableInput 上游是否有表格节点
 * @param hasBatch 节点 data.batch 是否存在（withBatch）
 */
export function agentRunTarget(kind: string, hasTableInput: boolean, hasBatch = false): AgentRunTarget {
    if (kind === "timeline") return "timeline";
    if (kind === "smart-batch") return hasTableInput ? "batch" : "smart-batch";
    if (!isGenKind(kind)) {
        // 非标准类型但有批量数据 + 上游表格：也按批量入口跑（真遇到未知 kind 时由调用方决定）
        return hasBatch && hasTableInput ? "batch" : null;
    }
    if (hasTableInput && (kind === "image" || kind === "video")) return "batch";
    return "single";
}

/** smart-batch 用哪个媒体类型执行：runSettings/apiKind=video 或 tableBatchVideo → 视频，其余图片 */
export function smartBatchMediaKind(data: unknown): "image" | "video" {
    if (!data || typeof data !== "object") return "image";
    const row = data as { tableBatchVideo?: unknown; runSettings?: { apiKind?: unknown } };
    return row.tableBatchVideo === true || String(row.runSettings?.apiKind || "") === "video" ? "video" : "image";
}
