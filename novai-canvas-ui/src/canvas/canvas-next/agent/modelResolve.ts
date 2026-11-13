/**
 * 节点 params 里的模型 id 解析（纯函数，便于单测）：
 * 画布里 models[].id 是「provider::model」，但助手 / 队列可能只写短 id（如 agnes-image-2.0-flash）。
 * 依次尝试：完整 id → provider::model → 短名 + provider → 按短名唯一匹配。写队列时也用它归一成完整 id。
 */
import type { GenKind, ModelSpec } from "../model";

type ParamsLike = { model?: unknown; provider?: unknown } | null | undefined;
const text = (v: unknown) => String(v ?? "").trim();
const providerOfModel = (m: ModelSpec) => (text(m.vendor) ? String(m.id).split("::")[0] : String(m.id).split("::")[0]);
const shortNameOf = (m: ModelSpec) => String(m.id).includes("::") ? String(m.id).split("::").slice(1).join("::") : m.name;

export function resolveModelForParams(models: ModelSpec[], kind: GenKind, params: ParamsLike): ModelSpec | undefined {
    const list = (models || []).filter((m) => m.kind === kind);
    const raw = text(params?.model);
    if (!raw) return undefined;
    const provider = text(params?.provider);
    const exact = list.find((m) => m.id === raw);
    if (exact) return exact;
    const full = raw.includes("::") ? raw : (provider ? provider + "::" + raw : raw);
    const byFull = list.find((m) => m.id === full);
    if (byFull) return byFull;
    if (provider) {
        const byProvider = list.find((m) => providerOfModel(m) === provider && (m.name === raw || shortNameOf(m) === raw));
        if (byProvider) return byProvider;
    }
    const byName = list.filter((m) => m.name === raw || shortNameOf(m) === raw);
    return byName.length === 1 ? byName[0] : undefined;
}

/** 把 params 里的短 model 归一成完整 provider::model（provider 缺失时从 models 里按短名反查） */
export function normalizeModelParams<T extends ParamsLike>(models: ModelSpec[], kind: GenKind, params: T): T {
    const raw = text(params?.model);
    if (!raw) return params;
    if (raw.includes("::")) return params;
    const provider = text(params?.provider);
    if (provider) return { ...(params as object), model: provider + "::" + raw } as T;
    const hit = resolveModelForParams(models, kind, params);
    return hit ? { ...(params as object), model: hit.id, provider: provider || String(hit.id).split("::")[0] } as T : params;
}
