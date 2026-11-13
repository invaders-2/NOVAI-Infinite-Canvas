/**
 * 阶段二 recall 检索（面板「搜索历史」）：GET /api/agent/recall?q=&canvas_id=&scope=&thread_id=&limit=
 *
 * 与后端的真实契约（2026-11 联调版，字段以这个为准）：
 *   必填 canvas_id（不传 → 400）；scope=thread 时还应传 thread_id（不传后端用该画布当前对话）。
 *   顶层：{ query, scope, canvas_id, thread_id, limit, count, items, message }
 *   item：{ key, source, source_label, score, snippet(≤200), origin(画布名 · 对话名 · 日期),
 *           canvas_id, canvas_title, thread_id, thread_title, date, ts }
 *   count=0 时 message 是「没有找到相关的历史记录；如实告诉用户没找到，不要编造」（给模型看的，面板用自己的空状态文案）。
 *   开关 NOVAI_AGENT_V2_MEMORY 关闭 → 400 + detail 文案（原样展示）。
 *
 * 只做请求 + 收敛，不自己造字段、不猜结果。
 * 验收口 ?debugRecall=1|empty|off 只替换数据源（同一个函数入口），形状与真实返回完全一致（snippet/source_label/origin）。
 */

export type RecallScope = "thread" | "canvas" | "all";

export type RecallItem = {
    key: string;
    /** message / thread_summary / canvas_profile / long_term_memory */
    source: string;
    /** 后端给的中文来源名（对话记录 / 对话摘要 / 画布档案 / 长期记忆），缺失时按 source 兜底 */
    source_label: string;
    score: number;
    snippet: string;
    /** 「画布名 · 对话名 · 日期」（缺哪段跳哪段） */
    origin: string;
    canvas_id: string;
    canvas_title: string;
    thread_id: string;
    thread_title: string;
    /** 后端格式化好的日期文本（YYYY-MM-DD） */
    date: string;
    ts: number;
};

export type RecallResult = {
    query: string;
    scope: RecallScope;
    canvas_id: string;
    thread_id: string;
    limit: number;
    count: number;
    items: RecallItem[];
    message: string;
};

export type RecallFailure = { message: string; status: number };

/** 后端 400（开关没开 / 参数不对）也能把「为什么搜不了」原样带出来 */
export class RecallError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "RecallError";
        this.status = status;
    }
}

export const RECALL_SCOPE_LABEL: Record<RecallScope, string> = { thread: "当前对话", canvas: "本画布", all: "全部" };

/** 后端 source → 中文名；后端已经给了 source_label 时以它为准（不覆盖） */
const SOURCE_LABEL: Record<string, string> = {
    message: "对话记录",
    thread_summary: "对话摘要",
    canvas_profile: "画布档案",
    long_term_memory: "长期记忆",
};

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

const scopeOf = (value: unknown, fallback: RecallScope): RecallScope => {
    const raw = text(value);
    return raw === "thread" || raw === "canvas" || raw === "all" ? raw : fallback;
};

const emptyResult = (query: string, scope: RecallScope, canvasId: string, threadId: string): RecallResult => ({
    query, scope, canvas_id: canvasId, thread_id: threadId, limit: 0, count: 0, items: [], message: "",
});

/** 出处：优先后端 origin；没有再按「画布 · 对话 · 日期」拼（缺哪段跳哪段）；都没有就说时间未知 */
function originOf(item: { origin: string; canvas_title: string; thread_title: string; date: string; ts: number }): string {
    const direct = item.origin.trim();
    if (direct) return direct;
    const date = item.date.trim() || recallDate(item.ts);
    return [item.canvas_title.trim(), item.thread_title.trim(), date].filter(Boolean).join(" · ") || date || "时间未知";
}

/** 后端只给 ts 时兜底成日期文本（后端正常会给 date，这里只是不让缺字段的场合空着） */
export function recallDate(ts: number): string {
    const raw = Number(ts) || 0;
    const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : 0;
    if (!ms) return "";
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

/** 一条结果收敛成「有片段」的对象；片段为空的脏数据直接丢（不让列表出现空白行） */
const itemOf = (raw: unknown): RecallItem | null => {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const snippet = text(row.snippet);
    if (!snippet.trim()) return null;
    const source = text(row.source);
    const date = text(row.date);
    const ts = Number(row.ts) || 0;
    const canvasTitle = text(row.canvas_title);
    const item: RecallItem = {
        key: text(row.key),
        source,
        source_label: text(row.source_label) || SOURCE_LABEL[source] || "记录",
        score: Number(row.score) || 0,
        snippet,
        // 后端给的 origin 必须原样保留（「画布 · 对话 · 日期」由后端拼好），只在缺失时才本地兜底
        origin: text(row.origin),
        canvas_id: text(row.canvas_id),
        canvas_title: canvasTitle,
        thread_id: text(row.thread_id),
        thread_title: text(row.thread_title),
        date,
        ts,
    };
    item.origin = originOf(item);
    return item;
};

const errorOf = (data: unknown, status: number): string => {
    const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const detail = row.detail ?? row.error ?? row.message;
    const direct = text(detail).trim();
    if (direct) return direct;
    if (detail && typeof detail === "object") {
        const inner = text((detail as Record<string, unknown>).message).trim() || text((detail as Record<string, unknown>).error).trim();
        if (inner) return inner;
    }
    return "搜索历史暂时不可用（HTTP " + status + "）";
};

const debugMode = (): "" | "data" | "empty" | "off" => {
    if (typeof location === "undefined") return "";
    const raw = new URLSearchParams(location.search).get("debugRecall");
    if (!raw || raw === "0") return "";
    if (raw === "empty") return "empty";
    if (raw === "off") return "off";
    return "data";
};

/** 验收口数据：字段与真实返回一致（snippet / source_label / origin / date / ts / count / message） */
function debugResult(query: string, scope: RecallScope, canvasId: string, threadId: string): RecallResult {
    const now = Math.floor(Date.now() / 1000);
    const day = (secondsAgo: number) => new Date((now - secondsAgo) * 1000).toISOString().slice(0, 10);
    const rows: Array<{ source: RecallItem["source"]; canvasTitle: string; threadTitle: string; snippet: string; ago: number }> = [
        { source: "message", canvasTitle: "封面 01｜早八宿舍书桌 · 热水还在", threadTitle: "会话一 · 保温杯主图", snippet: "这版封面用了「阶段二」的冷白光设定，左上留白放标题，主体压在右下。", ago: 3600 },
        { source: "thread_summary", canvasTitle: "封面 01｜早八宿舍书桌 · 热水还在", threadTitle: "阶段二 · 卖点海报", snippet: "这段对话较早的内容摘要：先确认了「阶段二」的画面生成范围，再按 3:4 竖版出封面。", ago: 86400 },
        { source: "canvas_profile", canvasTitle: "秋季保温杯 Campaign", threadTitle: "", snippet: "画布项目档案：主色曜石黑，出图统一「阶段二」的冷白光，文案口播风格偏克制。", ago: 172800 },
        { source: "long_term_memory", canvasTitle: "用户偏好 · 海报比例", threadTitle: "", snippet: "长期记忆：做海报默认用「阶段二」的配色，3:4 竖版优先。", ago: 604800 },
    ];
    const items = rows.map((row, index) => {
        const date = day(row.ago);
        const item: RecallItem = {
            key: "debug:" + index,
            source: row.source,
            source_label: SOURCE_LABEL[row.source] || "记录",
            score: 6 - index,
            snippet: row.snippet,
            origin: "",
            canvas_id: canvasId,
            canvas_title: row.canvasTitle,
            thread_id: row.threadTitle ? "debug-thread" : "",
            thread_title: row.threadTitle,
            date,
            ts: now - row.ago,
        };
        item.origin = originOf(item);
        return item;
    });
    const picked = scope === "thread" ? items.filter((item) => !!item.thread_title) : items;
    return {
        query, scope, canvas_id: canvasId, thread_id: threadId, limit: 20,
        count: picked.length, items: picked,
        message: picked.length ? "找到 " + picked.length + " 段相关记录（出处见每条的 origin）" : "没有找到相关的历史记录；如实告诉用户没找到，不要编造",
    };
}

export type RecallQuery = {
    query: string;
    /** 必填：当前画布 id（后端缺它会 400） */
    canvasId: string;
    /** scope=thread 时必需；其它 scope 传了也会被后端忽略 */
    threadId?: string;
    scope?: RecallScope;
    limit?: number;
};

/** 搜索历史。空关键词直接返回空结果（不去打 400），其余参数按后端契约带齐 */
export async function searchRecall(request: RecallQuery): Promise<RecallResult> {
    const q = String(request.query || "").trim();
    const canvasId = String(request.canvasId || "").trim();
    const threadId = String(request.threadId || "").trim();
    const scope = scopeOf(request.scope, "canvas");
    if (!q) return emptyResult("", scope, canvasId, threadId);
    if (!canvasId) throw new RecallError("缺少画布信息，没法和历史记录对上（canvas_id 为空）", 0);
    const debug = debugMode();
    if (debug === "off") throw new RecallError("记忆检索需要打开 NOVAI_AGENT_V2_MEMORY=1", 400);
    if (debug === "empty") return { ...emptyResult(q, scope, canvasId, threadId), message: "没有找到相关的历史记录；如实告诉用户没找到，不要编造" };
    if (debug === "data") return debugResult(q, scope, canvasId, threadId);
    const params = new URLSearchParams({ q, canvas_id: canvasId, scope, limit: String(Math.max(1, Math.min(20, Math.round(request.limit || 20)))) });
    if (threadId) params.set("thread_id", threadId);
    let response: Response;
    try {
        response = await fetch("/api/agent/recall?" + params.toString(), { headers: { Accept: "application/json" } });
    } catch (error) {
        throw new RecallError("连不上本地服务：" + (error instanceof Error ? error.message : "网络错误"), 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new RecallError(errorOf(data, response.status), response.status);
    const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const items = Array.isArray(row.items) ? row.items.map(itemOf).filter((item): item is RecallItem => !!item) : [];
    return {
        query: text(row.query) || q,
        scope: scopeOf(row.scope, scope),
        canvas_id: text(row.canvas_id) || canvasId,
        thread_id: text(row.thread_id) || threadId,
        limit: Number(row.limit) || items.length,
        count: Number.isFinite(Number(row.count)) ? Number(row.count) : items.length,
        items,
        message: text(row.message),
    };
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[]\]/g, "\\$&");

/** 关键词高亮：按空白/中文标点拆词，逐个不区分大小写命中；一个都没命中就原样返回（不硬凑高亮） */
export function highlightSegments(body: string, query: string): Array<{ text: string; hit: boolean }> {
    const source = String(body || "");
    const terms = String(query || "").split(/[\s\u3000,，。、；;：:!?！？]+/).map((term) => term.trim()).filter(Boolean);
    if (!source || !terms.length) return [{ text: source, hit: false }];
    const re = new RegExp("(" + terms.map(escapeRe).join("|") + ")", "gi");
    const out: Array<{ text: string; hit: boolean }> = [];
    let last = 0;
    for (const match of source.matchAll(re)) {
        const at = match.index ?? 0;
        if (at > last) out.push({ text: source.slice(last, at), hit: false });
        out.push({ text: match[0], hit: true });
        last = at + match[0].length;
    }
    if (!out.length) return [{ text: source, hit: false }];
    if (last < source.length) out.push({ text: source.slice(last), hit: false });
    return out;
}
