/**
 * 阶段二·3 记忆候选（面板「要记住这些吗」卡片）
 *
 * 后端契约（与后端并行实现，按这个写）：
 *   GET  /api/agent/memory/candidates?canvas_id=&thread_id=
 *        → { items: [{ id, text, scope: "canvas"|"global", reason }], confirmed_ids: [], pending: boolean }
 *   POST /api/agent/memory/confirm  { canvas_id, thread_id, ids:[...] } → { saved: int, items: [...] }
 *   POST /api/agent/memory/candidates/dismiss { canvas_id, thread_id, ids:[...] } → { dismissed: int }
 *   开关 NOVAI_AGENT_V2_MEMORY 关闭时 GET 返回 400。
 *
 * 面板只在「有 pending 候选项」时出卡片：没有候选 / 开关关闭 / 接口失败都静默返回空，不留空壳。
 * 验收口 ?debugMemoryCandidates=1|none|off|fail 只替换数据源（同一套函数入口），截图时 README 会标明。
 */

export type MemoryCandidateScope = "canvas" | "global";

export type MemoryCandidate = {
    id: string;
    text: string;
    scope: MemoryCandidateScope;
    /** 为什么建议记住（可空） */
    reason: string;
};

export type MemoryCandidatesResult = {
    items: MemoryCandidate[];
    /** 已经确认过的 id：面板不会再弹（后端也会从 pending 里剔掉） */
    confirmed_ids: string[];
    pending: boolean;
};

export type MemoryCandidatesRequest = { canvasId: string; threadId?: string };

export class MemoryCandidatesError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "MemoryCandidatesError";
        this.status = status;
    }
}

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

const scopeOf = (value: unknown): MemoryCandidateScope => (text(value) === "global" ? "global" : "canvas");

/** 一条候选收敛成可渲染的数据：没有 id / 没有正文的丢掉（卡片不出现空白行） */
const itemOf = (raw: unknown): MemoryCandidate | null => {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = text(row.id).trim();
    const body = text(row.text).trim();
    if (!id || !body) return null;
    return { id, text: body, scope: scopeOf(row.scope), reason: text(row.reason).trim() };
};

const itemsOf = (raw: unknown): MemoryCandidate[] => {
    const seen = new Set<string>();
    const out: MemoryCandidate[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        const row = itemOf(item);
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
    }
    return out;
};

const errorOf = (data: unknown, status: number): string => {
    const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const detail = row.detail ?? row.error ?? row.message;
    const direct = text(detail).trim();
    if (direct) return direct;
    return "记忆候选暂时不可用（HTTP " + status + "）";
};

const debugMode = (): "" | "1" | "none" | "off" | "fail" => {
    if (typeof location === "undefined") return "";
    const raw = new URLSearchParams(location.search).get("debugMemoryCandidates");
    if (!raw || raw === "0") return "";
    if (raw === "none") return "none";
    if (raw === "off") return "off";
    if (raw === "fail") return "fail";
    return "1";
};

/** 验收口的数据：形状与后端一致（两种范围、带依据、带已确认 id） */
const DEBUG_ITEMS: MemoryCandidate[] = [
    { id: "memc:1", text: "封面默认做 3:4 竖版，标题放在左上留白", scope: "canvas", reason: "这几轮都在要求竖版封面" },
    { id: "memc:2", text: "出图统一用冷白光，不用暖色", scope: "canvas", reason: "两次对话里都提到冷白光" },
    { id: "memc:3", text: "文案口播偏克制，不夸张、不喊口号", scope: "global", reason: "你在别的画布也这样要求过" },
];
/** 验收口状态跨刷新保留（只在这个 debug 模式下用）：这样「忽略后刷新也不再出现」也能截图证明 */
const DEBUG_DONE_KEY = "canvas-next:debug-memory-done";
const debugLoad = (): { confirmed: string[]; dismissed: string[] } => {
    try { return JSON.parse(sessionStorage.getItem(DEBUG_DONE_KEY) || "{}"); } catch { return { confirmed: [], dismissed: [] }; }
};
const debugDone = { confirmed: new Set<string>(debugLoad().confirmed || []), dismissed: new Set<string>(debugLoad().dismissed || []) };
/** 验收口：?debugMemoryCandidatesDelay=<ms> 让候选「晚一点才出现」，用来模拟摘要 5 分钟后才写回候选的时序 */
const debugStartedAt = Date.now();
const debugDelay = (): number => {
    if (typeof location === "undefined") return 0;
    const raw = Number(new URLSearchParams(location.search).get("debugMemoryCandidatesDelay"));
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 600000) : 0;
};
const debugSave = () => {
    try { sessionStorage.setItem(DEBUG_DONE_KEY, JSON.stringify({ confirmed: [...debugDone.confirmed], dismissed: [...debugDone.dismissed] })); } catch { /* 验收口状态丢了也不影响真实链路 */ }
};

const debugPending = (): MemoryCandidatesResult => {
    const items = DEBUG_ITEMS.filter((item) => !debugDone.confirmed.has(item.id) && !debugDone.dismissed.has(item.id));
    return { items, confirmed_ids: [...debugDone.confirmed], pending: items.length > 0 };
};

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
    let response: Response;
    try {
        response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
        throw new MemoryCandidatesError("连不上本地服务：" + (error instanceof Error ? error.message : "网络错误"), 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new MemoryCandidatesError(errorOf(data, response.status), response.status);
    return (data && typeof data === "object" ? data : {}) as Record<string, any>;
}

/** 拉一次候选；没有候选就是空数组（调用方据此决定要不要出卡片） */
export async function fetchMemoryCandidates(request: MemoryCandidatesRequest): Promise<MemoryCandidatesResult> {
    const canvasId = String(request.canvasId || "").trim();
    const threadId = String(request.threadId || "").trim();
    if (!canvasId) return { items: [], confirmed_ids: [], pending: false };
    const debug = debugMode();
    if (debug === "off") throw new MemoryCandidatesError("记忆候选未开启（NOVAI_AGENT_V2_MEMORY 关闭）", 400);
    if (debug === "fail") throw new MemoryCandidatesError("记忆候选接口暂时不可用（调试注入）", 500);
    if (debug === "none") return { items: [], confirmed_ids: [], pending: false };
    if (debug === "1") {
        // 延时模式：还没到点就当没候选（面板会继续按退避节奏来问）
        if (Date.now() - debugStartedAt < debugDelay()) return { items: [], confirmed_ids: [], pending: false };
        return debugPending();
    }
    const params = new URLSearchParams({ canvas_id: canvasId });
    if (threadId) params.set("thread_id", threadId);
    let response: Response;
    try {
        response = await fetch("/api/agent/memory/candidates?" + params.toString(), { headers: { Accept: "application/json" } });
    } catch (error) {
        throw new MemoryCandidatesError("连不上本地服务：" + (error instanceof Error ? error.message : "网络错误"), 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new MemoryCandidatesError(errorOf(data, response.status), response.status);
    const row = (data && typeof data === "object" ? data : {}) as Record<string, any>;
    const items = itemsOf(row.items);
    return {
        items,
        confirmed_ids: Array.isArray(row.confirmed_ids) ? row.confirmed_ids.map(text).filter(Boolean) : [],
        pending: typeof row.pending === "boolean" ? row.pending : items.length > 0,
    };
}

/** 勾选的写进长期记忆（后端复用 agent_memory_add 并标记已确认） */
export async function confirmMemoryCandidates(request: MemoryCandidatesRequest & { ids: string[] }): Promise<{ saved: number; items: MemoryCandidate[] }> {
    const ids = (request.ids || []).map((id) => String(id || "").trim()).filter(Boolean);
    if (!ids.length) return { saved: 0, items: [] };
    const debug = debugMode();
    if (debug === "1") {
        ids.forEach((id) => debugDone.confirmed.add(id));
        debugSave();
        return { saved: ids.length, items: DEBUG_ITEMS.filter((item) => ids.includes(item.id)) };
    }
    const data = await postJson("/api/agent/memory/confirm", { canvas_id: request.canvasId, thread_id: request.threadId || "", ids });
    // 后端真实返回：{ confirmed: [...], skipped: [...], memory: [...] }（memory = 真正写进长期记忆的条目）
    // 也兼容契约里的 { saved, items } —— 两边取数都不丢，toast 说的「已记住 N 条」以真正写入的条数为准
    const wrote = Array.isArray(data.memory) ? data.memory.length : null;
    const confirmed = Array.isArray(data.confirmed) ? data.confirmed.length : null;
    const saved = Number(data.saved) || wrote || confirmed || ids.length;
    return { saved, items: itemsOf(data.items) };
}

/** 忽略这些候选（不写入长期记忆，之后不再弹） */
export async function dismissMemoryCandidates(request: MemoryCandidatesRequest & { ids: string[] }): Promise<{ dismissed: number }> {
    const ids = (request.ids || []).map((id) => String(id || "").trim()).filter(Boolean);
    if (!ids.length) return { dismissed: 0 };
    const debug = debugMode();
    if (debug === "1") {
        ids.forEach((id) => debugDone.dismissed.add(id));
        debugSave();
        return { dismissed: ids.length };
    }
    const data = await postJson("/api/agent/memory/candidates/dismiss", { canvas_id: request.canvasId, thread_id: request.threadId || "", ids });
    // 后端真实返回 dismissed 是 id 数组；契约写的是数字 —— 两种都认
    const dismissed = Array.isArray(data.dismissed) ? data.dismissed.length : Number(data.dismissed) || 0;
    return { dismissed };
}
