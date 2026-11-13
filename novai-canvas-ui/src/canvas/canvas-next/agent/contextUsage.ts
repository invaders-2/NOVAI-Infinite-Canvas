/**
 * 阶段一上下文事件（NOVAI_AGENT_V2_CONTEXT=1 才发）→ 面板状态。
 *
 *   context_usage      { used_tokens, max_tokens, percentage, source, round, layers{system,memory,history,canvas,transcript,instruction,...} }
 *   context_compacted  { id, level: "fold"|"summary", before_tokens, after_tokens, round }
 *
 * 只做解析：不发请求、不碰 DOM、不改后端字段。开关关闭时这两个事件根本不出现，
 * 这里全部返回空，面板退回原来那份本地估算（不能出现空壳组件）。
 * percentage 为 null = 后端不知道模型窗口多大：只显示绝对值，不显示猜出来的百分比。
 */

export type ContextLayerKey = "system" | "memory" | "history" | "canvas" | "transcript" | "instruction" | "reserve";

/** 弹层里层级的顺序与中文名：后端 layers 的键固定是这几个，多出来的键忽略、缺的层不占位 */
export const CONTEXT_LAYERS: Array<[ContextLayerKey, string]> = [
    ["system", "系统与工具"],
    ["memory", "记忆"],
    ["history", "对话历史"],
    ["canvas", "画布与已选节点"],
    ["transcript", "运行记录"],
    ["instruction", "本次指令"],
    ["reserve", "预留输出"],
];

export type ContextLayer = { key: ContextLayerKey; label: string; tokens: number };

/** 面板上「当前上下文占用」的真值（来自后端每一轮的 context_usage） */
export type AgentContextUsage = {
    used: number;
    /** 0 = 模型窗口未知（后端拿不到 context_max） */
    max: number;
    /** null = 不知道窗口多大：只显示绝对值 */
    percentage: number | null;
    source: string;
    round: number;
    layers: ContextLayer[];
};

/** 后端整理过一次上下文（折叠旧工具结果 / 把较早内容收成摘要） */
export type ContextCompaction = {
    id: string;
    level: "fold" | "summary";
    before: number;
    after: number;
    round: number;
};

const tokensOf = (value: unknown): number => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};

/** 事件的展示数据都在 safePayload 里（老形状 data 也认，历史快照可能两种都有） */
const payloadOf = (event: Record<string, any> | null | undefined): Record<string, any> => {
    const payload = event && (event.safePayload || event.data);
    return payload && typeof payload === "object" ? payload as Record<string, any> : {};
};

/** layers 读成固定顺序的数组：后端没发的层直接不出现（不补 0，免得弹层里出现一排空行） */
export function contextLayersOf(raw: unknown): ContextLayer[] {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const layers = raw as Record<string, unknown>;
    const out: ContextLayer[] = [];
    for (const [key, label] of CONTEXT_LAYERS) {
        if (layers[key] == null) continue;
        const tokens = tokensOf(layers[key]);
        if (tokens > 0) out.push({ key, label, tokens });
    }
    return out;
}

/** 这次运行里最后一轮的 context_usage（每轮都发一条，取最后一条）；没有就 null */
export function contextUsageOf(events: Array<Record<string, any>>): AgentContextUsage | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event?.eventType || "") !== "context_usage") continue;
        const payload = payloadOf(event);
        const percentage = payload.percentage == null ? null : Number(payload.percentage);
        return {
            used: tokensOf(payload.used_tokens),
            max: tokensOf(payload.max_tokens),
            percentage: Number.isFinite(percentage as number) ? percentage as number : null,
            source: String(payload.source || ""),
            round: Number(payload.round) || 0,
            layers: contextLayersOf(payload.layers),
        };
    }
    return null;
}

/** 这次运行里发生过的上下文整理（折叠 / 摘要），按事件顺序；没有就是空数组 */
export function contextCompactionsOf(events: Array<Record<string, any>>): ContextCompaction[] {
    const out: ContextCompaction[] = [];
    for (const event of events) {
        if (String(event?.eventType || "") !== "context_compacted") continue;
        const payload = payloadOf(event);
        const before = tokensOf(payload.before_tokens);
        const after = tokensOf(payload.after_tokens);
        out.push({
            id: String(payload.id || "compacted:" + out.length),
            level: String(payload.level || "") === "summary" ? "summary" : "fold",
            before,
            after,
            round: Number(payload.round) || 0,
        });
    }
    return out;
}

/** 面板里最近一次拿到的真实占用（挂在消息上）：没有就 null，退回本地估算 */
export function latestContextUsage(msgs: Array<{ usage?: AgentContextUsage }>): AgentContextUsage | null {
    for (let index = msgs.length - 1; index >= 0; index -= 1) {
        const usage = msgs[index]?.usage;
        if (usage) return usage;
    }
    return null;
}

/** 绝对值统一口径：带千分位，不缩写（12,460 比 12.5K 更能说明每层占多少） */
export function tokenText(tokens: unknown): string {
    return Math.max(0, Math.round(Number(tokens) || 0)).toLocaleString("zh-CN");
}

/** 百分比只在后端给了的时候才显示；null 返回空串（调用方据此不画百分比） */
export function percentText(usage: AgentContextUsage | null): string {
    if (!usage || usage.percentage == null || !Number.isFinite(usage.percentage)) return "";
    return (Math.round(usage.percentage * 10) / 10) + "%";
}

/** 「已整理上下文」那一行说清楚做了什么、省了多少 token；标签短一点，窄面板才不会省略掉数字 */
export function compactionText(notice: ContextCompaction): string {
    const action = notice.level === "summary" ? "摘要较早内容" : "折叠旧工具结果";
    if (!notice.before && !notice.after) return action;
    return action + " · " + tokenText(notice.before) + " → " + tokenText(notice.after) + " tokens";
}
