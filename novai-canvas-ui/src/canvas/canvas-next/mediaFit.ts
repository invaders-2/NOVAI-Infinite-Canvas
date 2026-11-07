/**
 * 生成媒体的显示尺寸（纯函数，单测覆盖）。
 *
 * 生成结果回来时只有真实像素（w/h，或解码出来的 naturalWidth/Height），画布节点要按这个比例摆正：
 *   · 先按节点当前宽度算高度，保证比例 = 真实比例；
 *   · 超出展示盒（宽 MAX.w、高 MAX.h）时两边一起缩放，不能只夹一边（单边 clamp 会把 9:16 压扁）。
 * 「自适应」没有已知比例，调用方不调用这里，保持节点原尺寸。
 *
 * 空状态节点（还没有结果）按生成面板里选的比例预估尺寸，用的也是这套盒子：先在节点当前宽度上算高度，
 * 再收进最大盒，比例才不会被拉扁。ratioOf 把面板里的 "16:9" 这种文本换成数值比例。
 */
export const MEDIA_FIT_MAX = { w: 360, h: 640 } as const;

export type MediaBox = { w: number; h: number };

/** 按真实像素（sourceW / sourceH）算节点显示尺寸；参数不合法返回 null，调用方保持原样 */
export function fitMediaBox(baseWidth: number, sourceW: number, sourceH: number, max: MediaBox = MEDIA_FIT_MAX): MediaBox | null {
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 0 || sourceH <= 0) return null;
  const ratio = sourceW / sourceH;
  const base = Number.isFinite(baseWidth) && baseWidth > 0 ? baseWidth : MEDIA_FIT_MAX.w;
  let w = base;
  let h = w / ratio;
  // 先按高度收，再按宽度收；两者互斥，收完仍严格保持比例（只在最后取整）
  if (h > max.h) { h = max.h; w = h * ratio; }
  if (w > max.w) { w = max.w; h = w / ratio; }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** "16:9" → 宽高比 16/9；自适应 / auto / 不合法 → null */
export function ratioOf(r: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(r ?? "").trim());
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}
