/**
 * 记忆弹窗里新增的两块（阶段二收口）：记忆策略开关 + 这张画布的项目档案。
 *
 * 后端契约（settings 后端并行实现，按这个写）：
 *   GET  /api/agent/memory/settings?canvas_id=            → { auto_summary, candidates, cross_canvas_recall }
 *   PUT  /api/agent/memory/settings {canvas_id, ...部分字段} → 同上返回
 *   GET  /api/agent/profile/{canvas_id}                    → { canvas_id, profile:{intro,style,key_nodes,progress}, text, chars, limit }
 *   PUT  /api/agent/profile/{canvas_id} {intro?,style?,key_nodes?,progress?} → 同上
 *   DELETE /api/agent/profile/{canvas_id}                  → { canvas_id, deleted }
 *
 * 前端只做请求与收敛：接口不可用就如实说「暂时读不到」，不拿默认值假装开关状态。
 * 验收口 ?debugMemoryExtras=1|empty|off 只替换数据源（同一套函数入口），截图时 README 会标明。
 */

export type MemorySettings = { auto_summary: boolean; candidate_cards: boolean; cross_canvas_recall: boolean };
export type MemorySettingKey = keyof MemorySettings;

export type ProfileFields = { intro: string; style: string; key_nodes: string[]; progress: string };
export type CanvasProfileData = { text: string; chars: number; limit: number; fields: ProfileFields };

export class MemoryExtrasError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "MemoryExtrasError";
        this.status = status;
    }
}

export const MEMORY_SETTINGS_LABEL: Array<[MemorySettingKey, string, string]> = [
    ["auto_summary", "自动整理上下文摘要", "关闭后不再花额外的模型调用整理对话摘要"],
    ["candidate_cards", "回复后推荐要记住的偏好", "关闭后回复结束不再推荐候选，也不会后台轮询候选"],
    ["cross_canvas_recall", "允许跨画布检索历史", "关闭后「搜索历史」只在本画布内检索"],
];

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : value === 1 || value === "1" || value === "true" ? true : value === 0 || value === "0" || value === "false" ? false : fallback);

const debugMode = (): "" | "1" | "empty" | "off" => {
    if (typeof location === "undefined") return "";
    const raw = new URLSearchParams(location.search).get("debugMemoryExtras");
    if (!raw || raw === "0") return "";
    if (raw === "empty") return "empty";
    if (raw === "off") return "off";
    return "1";
};

const DEBUG_SETTINGS: MemorySettings = { auto_summary: true, candidate_cards: true, cross_canvas_recall: false };
const debugSettings: { value: MemorySettings } = { value: { ...DEBUG_SETTINGS } };
const DEBUG_FIELDS: ProfileFields = {
    intro: "秋季保温杯 Campaign：3:4 竖版主图，冷白光，文案克制。",
    style: "冷白光、低饱和、左上留白放标题",
    key_nodes: ["封面 01｜早八宿舍书桌 · 热水还在", "镜头 1｜开盖冒热气"],
    progress: "阶段二：4 条卖点已确认，待出 3 张封面",
};
/** empty 模式下初次进来就是空档案；保存 / 清空会改这份内存状态 */
const debugProfile: { fields: ProfileFields | null } = { fields: debugMode() === "empty" ? null : { ...DEBUG_FIELDS } };

const renderDebugText = (fields: ProfileFields): string => [
    fields.intro ? "简介：" + fields.intro : "",
    fields.style ? "风格：" + fields.style : "",
    fields.key_nodes.length ? "关键节点：" + fields.key_nodes.join("、") : "",
    fields.progress ? "进度：" + fields.progress : "",
].filter(Boolean).join("\n");

const errorOf = (data: unknown, status: number): string => {
    const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const detail = row.detail ?? row.error ?? row.message;
    const direct = text(detail).trim();
    if (direct) return direct;
    return "记忆设置暂时不可用（HTTP " + status + "）";
};

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, any>> {
    let response: Response;
    try {
        response = await fetch(path, { headers: { Accept: "application/json", ...(init?.headers || {}) }, ...init });
    } catch (error) {
        throw new MemoryExtrasError("连不上本地服务：" + (error instanceof Error ? error.message : "网络错误"), 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new MemoryExtrasError(errorOf(data, response.status), response.status);
    return (data && typeof data === "object" ? data : {}) as Record<string, any>;
}

/** 真实返回是 { canvas_id, settings:{auto_summary,candidate_cards,cross_canvas_recall}, defaults }；
 *  也兼容契约里的扁平写法，两种都认 */
const settingsOf = (row: Record<string, any>): MemorySettings => {
    const flat = row.settings && typeof row.settings === "object" ? row.settings as Record<string, any> : row;
    return {
        auto_summary: bool(flat.auto_summary, DEBUG_SETTINGS.auto_summary),
        candidate_cards: bool(flat.candidate_cards ?? flat.candidates, DEBUG_SETTINGS.candidate_cards),
        cross_canvas_recall: bool(flat.cross_canvas_recall, DEBUG_SETTINGS.cross_canvas_recall),
    };
};

const fieldsOf = (raw: unknown): ProfileFields => {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
        intro: text(row.intro).trim(),
        style: text(row.style).trim(),
        progress: text(row.progress).trim(),
        key_nodes: Array.isArray(row.key_nodes) ? row.key_nodes.map((item) => text(item).trim()).filter(Boolean) : [],
    };
};

const profileOf = (row: Record<string, any>, fallbackFields: ProfileFields = { intro: "", style: "", progress: "", key_nodes: [] }): CanvasProfileData => {
    const fields = row.profile && typeof row.profile === "object" ? fieldsOf(row.profile) : fallbackFields;
    const rendered = text(row.text);
    return { text: rendered || renderDebugText(fields), chars: Number(row.chars) || (rendered || renderDebugText(fields)).length, limit: Number(row.limit) || 800, fields };
};

/** 三个开关当前状态；读不到就抛错（调用方据此显示「暂时读不到」，不猜） */
export async function fetchMemorySettings(canvasId: string): Promise<MemorySettings> {
    const debug = debugMode();
    if (debug === "off") throw new MemoryExtrasError("记忆策略接口未就绪（调试注入：off）", 404);
    if (debug === "1" || debug === "empty") return { ...debugSettings.value };
    return settingsOf(await requestJson("/api/agent/memory/settings?canvas_id=" + encodeURIComponent(canvasId)));
}

/** 改一个或几个开关；返回后端的最新全量状态 */
export async function updateMemorySettings(canvasId: string, patch: Partial<MemorySettings>): Promise<MemorySettings> {
    const debug = debugMode();
    if (debug === "1" || debug === "empty") {
        debugSettings.value = { ...debugSettings.value, ...patch };
        return { ...debugSettings.value };
    }
    return settingsOf(await requestJson("/api/agent/memory/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canvas_id: canvasId, ...patch }),
    }));
}

/** 这张画布的项目档案正文（空档案会返回空 text） */
export async function fetchCanvasProfile(canvasId: string): Promise<CanvasProfileData> {
    const debug = debugMode();
    if (debug === "off") throw new MemoryExtrasError("项目档案接口未就绪（调试注入：off）", 404);
    if (debug === "1" || debug === "empty") {
        const fields = debugProfile.fields;
        return profileOf(fields ? { profile: fields, text: renderDebugText(fields) } : {}, { intro: "", style: "", progress: "", key_nodes: [] });
    }
    return profileOf(await requestJson("/api/agent/profile/" + encodeURIComponent(canvasId)));
}

/** 保存档案正文的几段（各对话的一句话摘要不在手动编辑范围内） */
export async function saveCanvasProfile(canvasId: string, fields: ProfileFields): Promise<CanvasProfileData> {
    const payload = { intro: fields.intro, style: fields.style, progress: fields.progress, key_nodes: fields.key_nodes };
    const debug = debugMode();
    if (debug === "1" || debug === "empty") {
        debugProfile.fields = { ...fields };
        return profileOf({ profile: fields, text: renderDebugText(fields) });
    }
    return profileOf(await requestJson("/api/agent/profile/" + encodeURIComponent(canvasId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }));
}

/** 清空档案（对话原文和线程摘要不动） */
export async function clearCanvasProfile(canvasId: string): Promise<void> {
    const debug = debugMode();
    if (debug === "1" || debug === "empty") { debugProfile.fields = null; return; }
    await requestJson("/api/agent/profile/" + encodeURIComponent(canvasId), { method: "DELETE" });
}
