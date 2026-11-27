/**
 * 表格 AI 的 LLM 通道（薄客户端）：POST /api/canvas-llm。
 *
 * 请求体照抄旧画布 static/js/canvas.js 的 callCanvasLLM（同一套字段名），noMedia 场景带 no_prompt_intelligence：
 * 后端 Prompt Intelligence 只要收到 images/videos/reverse 就会改写 message，那会把「只返回 JSON」的结构化提示词毁掉。
 *
 * 模型 / 系统提示词一律取**表格节点自己的配置**（data.table.aiModel / aiSystem，见 table.ts 的 TableData）：
 * 模型写的是 configId（provider::model，和文本节点 params.model 同一种写法），没配才回落到当前画布的文本模型，
 * 绝不写死模型名。
 */
import type { ModelSpec } from "./model";
import type { TableData } from "./table";
import { AI_COLUMN_MAX_TOKENS } from "./tableAi";

export const TABLE_AI_SYSTEM_DEFAULT = "You are a helpful assistant.";

export type TableLlmConfig = {
  /** provider::model（节点上存的原值） */
  configId: string;
  provider: string;
  model: string;
  /** ModelScope 走单独字段，其余供应商传空串（同旧画布） */
  msModel: string;
  system: string;
};
export type TableLlmReady = { ok: true; cfg: TableLlmConfig } | { ok: false; reason: string };

/** configId 形如 "comfly::gpt-4o-mini"；没有分隔符时整串当模型名（供应商由后端按默认解析） */
export function splitConfigId(configId: string): { provider: string; model: string } {
  const text = String(configId || "").trim();
  const at = text.indexOf("::");
  if (at <= 0) return { provider: "", model: text };
  return { provider: text.slice(0, at), model: text.slice(at + 2) };
}

/** 表格节点的 AI 配置：先读节点自己的字段，再回落到画布的文本模型清单 */
export function tableLlmConfig(t: TableData, textModels: ModelSpec[]): TableLlmReady {
  const own = String(t.aiModel || "").trim();
  const configId = own || String((textModels[0] && textModels[0].id) || "").trim();
  if (!configId) return { ok: false, reason: "还没有可用的文本模型：先去「设置 › API 设置」配一个，或在智能列弹层里选模型" };
  const { provider, model } = splitConfigId(configId);
  if (!provider || !model) return { ok: false, reason: "模型配置不完整：需要 provider::model 形式的模型 id" };
  return {
    ok: true,
    cfg: {
      configId,
      provider,
      model,
      msModel: provider === "modelscope" ? model : "",
      system: String(t.aiSystem || "").trim() || TABLE_AI_SYSTEM_DEFAULT,
    },
  };
}

/** 后端报错 → 人话：/api/canvas-llm 的 detail 优先，取不到就用状态码 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return fallback + "（HTTP " + res.status + "）";
    try {
      const data = JSON.parse(text) as { detail?: unknown; error?: unknown };
      const detail = String(data.detail ?? data.error ?? "").trim();
      if (detail) return detail;
    } catch { /* 不是 JSON：原样给出去 */ }
    return String(text).slice(0, 400) || fallback + "（HTTP " + res.status + "）";
  } catch { return fallback + "（HTTP " + res.status + "）"; }
}

export type TableLlmOptions = { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number; /** 一起发给能看图的模型（智能列带首帧）；no_prompt_intelligence 仍然生效，不会改写提示词 */ images?: string[] };

/**
 * 一次非流式对话，返回模型正文。表格的规划 / 生成 / 修复遍都是短请求，不需要流式。
 * 超时单独 abort：模型端挂住不返回时，fetch 会永远 pending，调用方的 finally 不会执行。
 */
export async function callTableLlm(cfg: TableLlmConfig, message: string, options: TableLlmOptions = {}): Promise<string> {
  const maxTokens = Math.max(0, Math.floor(Number(options.maxTokens) || AI_COLUMN_MAX_TOKENS));
  const body = {
    message,
    model: cfg.model,
    ms_model: cfg.msModel,
    provider: cfg.provider,
    system_prompt: cfg.system,
    messages: [] as Array<{ role: string; content: string }>,
    images: (options.images || []).filter(Boolean).slice(0, 8),
    videos: [] as string[],
    reverse: false,
    target_type: "",
    target_model: "",
    no_prompt_intelligence: true,
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
  };
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 180000);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  const outer = options.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener("abort", onOuterAbort); }
  try {
    const res = await fetch("/api/canvas-llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(await readError(res, "LLM 运行失败"));
    const data = (await res.json()) as { text?: unknown };
    const text = String(data && data.text !== undefined && data.text !== null ? data.text : "");
    if (!text.trim()) throw new Error("模型返回了空回复");
    return text;
  } catch (error) {
    if (timedOut) throw new Error("LLM 超过 " + Math.round(timeoutMs / 1000) + " 秒未返回，已中止");
    if (ctrl.signal.aborted && !(outer && outer.aborted)) throw new Error("生成已停止");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (timer) clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}
