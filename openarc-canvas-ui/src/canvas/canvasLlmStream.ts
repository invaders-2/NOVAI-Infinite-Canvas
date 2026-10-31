/**
 * 智能画布流式 LLM（`POST /api/canvas-llm/stream`）宿主侧的纯逻辑。
 *
 * 分工：CanvasHost 只做接线（`model:event` 下行 → `postMessage` 上行、`canvas/runStop` 取消），
 * 这里承载"事件 → 页面 SSE 帧 / 开流时机 / 没有正文时怎么如实收口"这些可判定的部分，
 * 单测直接覆盖（tests/dxos-canvas-llm-stream.test.mjs）。
 *
 * 页面读法（public/novai-canvas/static/js/smart-canvas.js 的 `streamCanvasLLMResponse`）：
 *   `data: {"type":"delta","delta":"..."}` / `{"type":"reasoning","delta":"..."}` /
 *   `{"type":"error","detail":"..."}` / `{"type":"done","text":"..."}`，一行一个 JSON，空行分隔。
 *   409/404/405 表示"这里没有流式"，页面会退回普通 `/api/canvas-llm`（诚实降级，不是伪造分块）。
 */

/** 页面可读的 SSE 帧（只发这些；上游的 response.start / usage / tool_call.delta 不是正文，不发）。*/
export type CanvasStreamFrame =
  | { type: "delta"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; text: string }
  | { type: "error"; detail: string };

/** 上游统一事件模型里，哪些类型算"真的在出正文"。*/
const CONTENT_EVENT = "text.delta";

/** 一条 SSE 帧的线上格式：`data: <json>\\n\\n`。*/
export function sseChunk(frame: CanvasStreamFrame): string {
  return "data: " + JSON.stringify(frame) + "\n\n";
}

/** 上游错误码 → 页面可读文案（与 CanvasHost 的 explain 同一套；未知码原样透出，不假装成功）。*/
export function streamErrorMessage(code: string): string {
  const key = String(code || "").trim();
  if (key === "PARTIAL_RESPONSE") return "模型连接在回答中途中断，已返回收到的部分内容";
  if (key === "MODEL_TIMEOUT" || key === "TIMEOUT") return "模型响应超时（长时间没有新内容）";
  if (key === "CANCELLED") return "生成已停止";
  if (key === "CREDENTIAL_MISSING") return "该模型缺少凭据";
  if (key === "PROXY_UNAUTHORIZED") return "没有权限使用该模型（应用授权已被撤销或未授予）";
  if (key === "CAPABILITY_UNAVAILABLE") return "该模型没有文本对话能力（OpenArc 不会用别的接口顶替）";
  if (key === "MODEL_CONFIG_UNAVAILABLE") return "没有可用的模型配置（请在 设置 → 模型 里配置）";
  if (key === "MODEL_NOT_FOUND") return "该模型不在当前 OpenArc 模型清单里（不会改用其它模型）";
  if (key === "ENDPOINT_BLOCKED") return "该供应商的地址不在允许范围内";
  if (!key) return "模型调用失败";
  return key;
}

/**
 * 上游事件 → 0/1 条页面帧。
 * `text.delta` → delta；`response.error` → error；其余（start / usage / tool_call.delta / complete）不回帧。
 */
export function pageFrameFor(modelEvent: unknown): CanvasStreamFrame | null {
  if (!modelEvent || typeof modelEvent !== "object") return null;
  const ev = modelEvent as { type?: unknown; text?: unknown; delta?: unknown; error?: unknown };
  const type = String(ev.type || "");
  if (type === CONTENT_EVENT) return { type: "delta", delta: String(ev.text == null ? "" : ev.text) };
  if (type === "reasoning") return { type: "reasoning", delta: String(ev.delta == null ? (ev.text == null ? "" : ev.text) : ev.delta) };
  if (type === "response.error") return { type: "error", detail: streamErrorMessage(String(ev.error == null ? "" : ev.error)) };
  return null;
}

/** 只有"真的有正文"的事件才允许把 HTTP 200 定下来（response.start 不算，避免非流式响应被开成空流）。*/
export function isStreamContentEvent(modelEvent: unknown): boolean {
  if (!modelEvent || typeof modelEvent !== "object") return false;
  const ev = modelEvent as { type?: unknown; text?: unknown };
  return String(ev.type || "") === CONTENT_EVENT && String(ev.text == null ? "" : ev.text).length > 0;
}

export type StreamCloseDecision = { status: number; error: string; unsupported: boolean };

/**
 * 整条流结束时**一帧正文都没出过**怎么收口（绝不伪造分块）：
 *   · 上游 ok 但没有正文 → 这个站点/模型不是流式：409 让页面退回非流式 `/api/canvas-llm`（如实降级）；
 *   · 上游明确失败 → 502/504 + 结构化错误码（页面按 `res.text()` 给出可读文案）；
 *   · 超时单独给 504。
 */
export function closeStreamWithoutContent(input: { ok: boolean; error?: string | null }): StreamCloseDecision {
  if (input && input.ok) return { status: 409, error: "STREAM_UNSUPPORTED", unsupported: true };
  const code = String((input && input.error) || "MODEL_ERROR");
  if (code === "MODEL_TIMEOUT" || code === "TIMEOUT") return { status: 504, error: code, unsupported: false };
  return { status: 502, error: code, unsupported: false };
}

/** 已出过正文、收尾却失败时的页面错误帧文案（正文是真的，错误也如实说）。*/
export function streamCloseErrorFrame(error: string | null | undefined): CanvasStreamFrame {
  return { type: "error", detail: streamErrorMessage(String(error || "MODEL_ERROR")) };
}
