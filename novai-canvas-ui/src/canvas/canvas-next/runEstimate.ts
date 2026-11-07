/**
 * 一键运行的「预计花费」：只打后端估价接口 GET /api/credits/price，前端不存任何价目。
 * 拿不到价就整格隐藏（degraded），任何失败都不抛给界面。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { callsOf } from "./engine";
import { genOf, isGenKind, type AudioParams, type ImageParams, type TextParams, type VideoParams } from "./model";

export type PriceKind = "image" | "video" | "audio" | "chat";
export type PriceRequest = { kind: PriceKind; model: string; provider: string; size?: string; duration?: number; quality?: string; tokens_in?: number };
export type PriceQuote = { price: number; degraded: boolean };
export type RunEstimate = { price: number; priced: number; unpriced: number; degraded: boolean };

const PRICE_PATH = "/api/credits/price";
const TIMEOUT_MS = 3000;
const CONCURRENCY = 4;
/** 文本节点按字符折算 token 的粗估系数（中英混排，只为给估价接口一个量级，不是精确分词） */
const CHAT_TOKENS_PER_CHAR = 0.6;
/** 「30s」这种时长档 → 秒；「自适应」等解析不出来就不传 duration */
const secondsOf = (raw: unknown) => { const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(raw ?? "")); return m ? Number(m[1]) : 0; };
/** provider::model → 估价接口要的两段；没带 provider 时与生成链路一样按 comfly 兜底 */
const splitModel = (id: string) => { const at = id.indexOf("::"); return at >= 0 ? { provider: id.slice(0, at), model: id.slice(at + 2) } : { provider: "comfly", model: id }; };

/** 从生成节点推导估价入参；不是生成节点 / 没有模型 → null（这一份算不出价） */
export function priceRequestOf(node: CanvasNode): PriceRequest | null {
  if (!isGenKind(node.kind)) return null;
  const g = genOf(node);
  if (node.kind === "image") { const p = g.params as ImageParams; const { provider, model } = splitModel(p.model); if (!model) return null; return { kind: "image", model, provider, ...(p.size ? { size: p.size } : {}) }; }
  if (node.kind === "video") { const p = g.params as VideoParams; const { provider, model } = splitModel(p.model); if (!model) return null; return { kind: "video", model, provider, ...(p.dur > 0 ? { duration: p.dur } : {}), ...(p.res ? { quality: p.res } : {}) }; }
  if (node.kind === "audio") { const p = g.params as AudioParams; const { provider, model } = splitModel(p.model); if (!model) return null; const dur = secondsOf(p.dur); return { kind: "audio", model, provider, ...(dur > 0 ? { duration: dur } : {}) }; }
  const p = g.params as TextParams; const { provider, model } = splitModel(p.model); if (!model) return null;
  return { kind: "chat", model, provider, tokens_in: Math.max(1, Math.round((g.prompt || "").length * CHAT_TOKENS_PER_CHAR)) };
}

async function fetchQuote(req: PriceRequest, f: typeof fetch, timeoutMs: number): Promise<PriceQuote | null> {
  const q = new URLSearchParams({ kind: req.kind, model: req.model, provider: req.provider });
  if (req.size) q.set("size", req.size);
  if (req.duration) q.set("duration", String(req.duration));
  if (req.quality) q.set("quality", req.quality);
  if (req.tokens_in) q.set("tokens_in", String(req.tokens_in));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(PRICE_PATH + "?" + q.toString(), { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { price?: unknown; estimated_price?: unknown; pricing_fallback?: unknown; unmapped?: unknown };
    // 后付费模式下 price 恒为 0，真正的估算值在 estimated_price
    const price = Number(data.price) > 0 ? Number(data.price) : Number(data.estimated_price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const unmapped = Array.isArray(data.unmapped) ? data.unmapped.length : 0;
    return { price, degraded: data.pricing_fallback === true || unmapped > 0 };
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * 一批节点的预计花费：同规格只请求一次（再按每节点的调用次数相乘，和「次模型调用」口径一致）。
 * 并发上限 4、单请求 3 秒超时；全部失败 / 一个价都没拿到 → degraded（界面整格隐藏）。
 */
export async function estimateRunPrice(nodes: CanvasNode[], opts: { fetch?: typeof fetch; timeoutMs?: number; concurrency?: number } = {}): Promise<RunEstimate> {
  const f = opts.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const jobs = new Map<string, { req: PriceRequest; calls: number }>();
  let unpriced = 0;
  for (const n of nodes) {
    const req = priceRequestOf(n);
    if (!req) { unpriced += 1; continue; }
    const key = [req.kind, req.provider, req.model, req.size || "", req.duration ?? "", req.quality || "", req.tokens_in ?? ""].join("|");
    const job = jobs.get(key);
    if (job) job.calls += callsOf(n); else jobs.set(key, { req, calls: callsOf(n) });
  }
  const list = [...jobs.values()];
  if (!f || !list.length) return { price: 0, priced: 0, unpriced, degraded: true };

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const width = Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, list.length));
  const quotes: Array<PriceQuote | null> = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; quotes[i] = await fetchQuote(list[i].req, f, timeoutMs); } };
  await Promise.all(Array.from({ length: width }, () => worker()));

  let price = 0; let priced = 0; let degraded = false;
  list.forEach((job, i) => {
    const q = quotes[i];
    if (!q) { unpriced += job.calls; return; }
    price += q.price * job.calls; priced += job.calls;
    if (q.degraded) degraded = true;
  });
  if (!priced) return { price: 0, priced: 0, unpriced, degraded: true };
  return { price: Math.round(price * 100) / 100, priced, unpriced, degraded: degraded || unpriced > 0 };
}
