/**
 * 画布节点错误的「码 → 人话」映射（节点错误弹层 / 批量行 / 文本出表 共用一张表）。
 *
 * 纪律：
 *   · 主行只出现人话，绝不把 MODEL_TIMEOUT 这类原始码丢给用户；
 *   · 原始码不丢：errorText() 同时返回 code，调用方写进 gen.errCode，界面用 12px 灰字「代码：…」显示；
 *   · 能复用宿主已有的措辞就复用（streamErrorMessage），canvas 专属的码补在这里，不另起第二套表。
 */
import { streamErrorMessage } from "../canvasLlmStream.ts";
import { GenError } from "./backend/types.ts";

export type ErrorText = { text: string; code: string };

const clean = (raw: unknown): string => String(raw == null ? "" : raw).trim();

/** 已知码（从长到短匹配，避免 MODEL_TIMEOUT 被 TIMEOUT 抢先命中） */
const KNOWN_CODES = [
  "MODEL_CONFIG_UNAVAILABLE", "UPLOAD_CONSENT_REQUIRED", "CAPABILITY_UNAVAILABLE", "PROXY_UNAUTHORIZED", "CREDENTIAL_MISSING", "ENDPOINT_BLOCKED",
  "MODEL_NOT_FOUND", "MODEL_TIMEOUT", "RATE_LIMITED", "CANCELLED", "STOPPED", "ECONNRESET", "ENOTFOUND", "TIMEOUT", "NETWORK",
] as const;

const NETWORK_RE = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|NETWORK|fetch failed|Failed to fetch|Load failed|socket hang up/i;

/** 原始错误串 → 规范码（认不出就返回 trim 后的原串，空串返回 ""） */
export function errorCode(raw: unknown): string {
  const text = clean(raw);
  if (!text) return "";
  const upper = text.toUpperCase();
  if (/\b429\b/.test(text) || /RATE.?LIMIT/i.test(text)) return "RATE_LIMITED";
  if (NETWORK_RE.test(text)) return "NETWORK";
  for (const code of KNOWN_CODES) if (upper.includes(code)) return code;
  return text;
}

/** 兜底人话：所有认不出的码都落到这一句（测试也用它判断"码表命中"） */
export const FALLBACK_TEXT = "生成失败，可稍后重试";

const CANVAS_TEXT: Record<string, string> = {
  RATE_LIMITED: "请求太频繁被限流，请稍后重试",
  NETWORK: "网络连接中断，请检查网络后重试",
  CAPABILITY_UNAVAILABLE: "该模型不支持这种生成（OpenArc 不会用别的接口顶替）",
  ENDPOINT_BLOCKED: "该供应商地址不在允许范围内",
  STOPPED: "生成已停止",
  UPLOAD_CONSENT_REQUIRED: "该模型需要把参考素材上传到临时图床，请先到 设置 → 网络 里允许上传",
};

/**
 * 码 → 人话。canvas 专属的几条用本表的措辞，其余走宿主的 streamErrorMessage
 * （同一码不写两套文案；宿主那边没有的码才落到「生成失败，可稍后重试」）。
 */
export function errorTextFor(code: string): string {
  if (!code) return FALLBACK_TEXT;
  if (CANVAS_TEXT[code]) return CANVAS_TEXT[code];
  if (code === "MODEL_NOT_FOUND") return "该模型不在当前模型清单里（不会改用其它模型）";
  if (code === "MODEL_CONFIG_UNAVAILABLE") return "没有可用的模型配置，请到 设置 → 模型 里配置";
  if (code === "PROXY_UNAUTHORIZED") return "没有权限使用该模型（授权可能已被撤销）";
  if (code === "MODEL_TIMEOUT" || code === "TIMEOUT") return "模型响应超时（长时间没有新内容）";
  if (code === "CREDENTIAL_MISSING") return "该模型缺少凭据";
  if (code === "CANCELLED") return "生成已停止";
  // 宿主已有一套措辞（流式 LLM 用）；同一码优先用它的结果，避免两套说法
  const host = streamErrorMessage(code);
  if (host && host !== code) return host;
  return FALLBACK_TEXT;
}

/**
 * 引擎 catch 的落点：一次算出「写进 gen.err 的人话」+「保留到 gen.errCode 的原始码」。
 * GenError 优先用它自己的 code（后端明确给的），其它错误串从消息里认码。
 */
export function nodeError(err: unknown): { err: string; errCode?: string } {
  const raw = err instanceof Error ? err.message : err;
  const code = err instanceof GenError ? err.code : errorCode(raw);
  const byCode = errorTextFor(code);
  // 码表里没有这个码时，再看消息串能不能认出网络/限流这类具体原因（原始码仍然照旧保留）
  const byMsg = byCode === FALLBACK_TEXT ? errorTextFor(errorCode(raw)) : byCode;
  return { err: byMsg, errCode: code || undefined };
}

/** 任意错误串 → { text, code }（节点错误弹层只用这两个字段） */
export function errorText(raw: unknown): ErrorText {
  const code = errorCode(raw);
  return { text: errorTextFor(code), code };
}

/**
 * 「重试」能不能点：没有模型（或错误本身就是模型缺失）时点了也没用，返回禁用理由；能重试返回 null。
 * 由 NodeView 的按钮 title 直接用，避免"点了没反应"。
 */
export function retryBlockedReason(code: string, hasModel: boolean): string | null {
  if (code === "MODEL_CONFIG_UNAVAILABLE") return "没有可用的模型配置，先去 设置 → 模型 里配置";
  if (code === "MODEL_NOT_FOUND") return "该模型不在当前模型清单里，先去 设置 → 模型 里重新选择";
  if (!hasModel) return "这个节点还没有可用的模型，先去 设置 → 模型 里配置";
  return null;
}
