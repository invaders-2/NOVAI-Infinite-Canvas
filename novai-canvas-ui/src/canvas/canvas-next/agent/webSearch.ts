/**
 * 画布助手联网搜索（web_search）→ 消息里的搜索结果卡数据。
 *
 * 只做数据解析：把任务快照里 tool.execution.* 的 safePayload 按 callId 归并成卡片，
 * 不发请求、不碰 DOM、不编内容。后端在 started 事件里补了 args（{query, limit}），
 * 但历史快照 / 老服务端没有这一步，所以 query 依次退化：
 * args.query → description 里的「…」→ 剥掉「联网搜索」前缀的剩余文字 → 空串（卡片照常显示，不崩）。
 */
import { isWebAccessDisabled } from "./webImages";

export type WebSearchSource = { title: string; url: string; snippet: string };

export type WebSearchCardStatus = "searching" | "done" | "web-off" | "failed";

/** 消息里的一张「联网搜索结果卡」 */
export type WebSearchCardData = {
    key: string;
    query: string;
    status: WebSearchCardStatus;
    sources: WebSearchSource[];
    /** started 事件里的展示描述（没有 args 时 query 从这里的「…」取） */
    description: string;
    /** failed / web-off 的真实原因（空串表示没有失败） */
    error: string;
};

/** 工具名容错：契约是 web_search，历史 / 别的适配器可能写成 web-search、websearch */
const WEB_SEARCH_TOOLS = new Set(["web_search", "websearch", "web-search"]);

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** 「联网搜索「xxx」」/ 「Searching "xxx"」取出引号里的内容 */
function quotedOf(value: string): string {
    const hit = /[「“"'《]([^」”"'》]+)[」”"'》]/.exec(value);
    return hit ? hit[1].trim() : "";
}

function queryOf(description: string, args: Record<string, unknown>): string {
    const direct = text(args.query).trim();
    if (direct) return direct;
    const quoted = quotedOf(description);
    if (quoted) return quoted;
    return description.replace(/^(联网搜索|web[_ -]?search)[：:，,\s]*/i, "").trim();
}

function sourceOf(raw: unknown): WebSearchSource | null {
    const row = objectOf(raw);
    const url = text(row.url).trim();
    if (!url) return null;
    return { title: text(row.title).trim() || url, url, snippet: text(row.snippet).trim() };
}

/** result 契约是 [{title,url,snippet}]；外面再包一层（results / items / sources）也认，认不出就当没有结果 */
function rowsOf(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const row = objectOf(value);
    for (const key of ["results", "items", "sources"]) if (Array.isArray(row[key])) return row[key] as unknown[];
    return [];
}

/** 同一条来源在结果里重复出现时只留第一条（后端偶尔会把同页多条结果并进来） */
function sourcesOf(value: unknown): WebSearchSource[] {
    const out: WebSearchSource[] = [];
    const seen = new Set<string>();
    for (const raw of rowsOf(value)) {
        const source = sourceOf(raw);
        if (!source || seen.has(source.url)) continue;
        seen.add(source.url);
        out.push(source);
    }
    return out;
}

/**
 * 从任务快照里取出联网搜索，按 callId 归并成卡片（一次搜索一张）。
 * started 只负责「搜索中」和 query；succeeded 补结果；failed 保留真实失败原因。
 * 关闭联网（code=web_access_disabled / 「联网未开启」文案）单独标成 web-off，交给卡面显示可读指引。
 */
export function webSearchCards(snapshot: { events?: Array<Record<string, unknown>> }): WebSearchCardData[] {
    const cards: WebSearchCardData[] = [];
    const at = new Map<string, number>();
    for (const event of snapshot.events || []) {
        const type = text(event.eventType);
        const payload = objectOf(event.safePayload);
        const tool = (text(payload.toolId) || text(payload.name)).toLowerCase();
        if (!WEB_SEARCH_TOOLS.has(tool)) continue;
        const failed = /failed|denied|blocked|unknown_effect/.test(type);
        const succeeded = !failed && /succeeded/.test(type);
        const started = !failed && !succeeded && /started/.test(type);
        if (!failed && !succeeded && !started) continue;
        const key = text(payload.callId) || text(payload.toolCallId) || text(event.eventId) || tool + ":" + cards.length;
        let card = at.has(key) ? cards[at.get(key)!] : null;
        if (!card) {
            card = { key, query: "", status: "searching", sources: [], description: "", error: "" };
            at.set(key, cards.length);
            cards.push(card);
        }
        const description = text(payload.description).trim();
        if (description) card.description = description;
        const args = objectOf(payload.args);
        if (started) {
            // 同一个 callId 真重复 started 也不该把已经完成的状态打回搜索中；query 有了就不再覆盖
            if (card.status === "searching" && !card.query) card.query = queryOf(description || card.description, args);
            continue;
        }
        if (succeeded) {
            if (!card.query) card.query = queryOf(description || card.description, args);
            card.status = "done";
            card.sources = sourcesOf(payload.result);
            card.error = "";
            continue;
        }
        const code = text(payload.code).trim();
        const reason = text(payload.error).trim() || code || "联网搜索执行失败（服务端没有给出原因）";
        card.status = code === "web_access_disabled" || isWebAccessDisabled(reason) ? "web-off" : "failed";
        card.error = reason;
        card.sources = [];
    }
    return cards;
}
