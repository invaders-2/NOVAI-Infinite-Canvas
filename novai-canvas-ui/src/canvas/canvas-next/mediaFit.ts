/**
 * 生成媒体的显示尺寸（纯函数，单测覆盖）。
 *
 * 生成结果回来时只有真实像素（w/h，或解码出来的 naturalWidth/Height），画布节点要按这个比例摆正：
 *   · 先按节点当前宽度算高度，保证比例 = 真实比例；
 *   · 超出展示盒（宽 MAX.w、高 MAX.h）时两边一起缩放，不能只夹一边（单边 clamp 会把 9:16 压扁）。
 * 「自适应」（原图比例）没有固定的比例文本，比例来自源图真实像素或面板写好的 params.sourceSize（"2048x1536"），
 * 两个都拿不到时调用方不调用这里，保持节点原尺寸（不猜 1:1）。
 *
 * 空状态节点（还没有结果）按生成面板里选的比例预估尺寸，用的也是这套盒子：先在节点当前宽度上算高度，
 * 再收进最大盒，比例才不会被拉扁。ratioOf 把面板里的 "16:9" 这种文本换成数值比例，
 * sizeRatioOf 把「原图比例」的显式 WxH 换成数值比例。
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

/** 上传 / 参考素材新节点的起始盒：宽 240 起步、高不低于 100，长边封在 480×640 */
export type SourceFitBox = { baseW: number; minH: number; maxW: number; maxH: number };
export const SOURCE_FIT: SourceFitBox = { baseW: 240, minH: 100, maxW: 480, maxH: 640 };

/**
 * 上传 / 联网搜图 / 助手参考素材的节点尺寸：宽度从 baseW 起步，高不足 minH 就把宽度等比放大，
 * 太高再按 maxH 收宽度 —— 每一步只动一边，比例始终等于源图。
 * 以前写成 Math.max(100, Math.min(520, baseW * h / w))：只夹高度不动宽度，4.79:1 的横图会被夹成
 * 240×100（比例 2.4:1），节点正文又是 object-fit:cover，画布上看到的就只剩中间一条，不是原比例。
 */
export function fitSourceBox(sourceW: number, sourceH: number, opts: Partial<SourceFitBox> = {}): MediaBox | null {
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 0 || sourceH <= 0) return null;
  const box = { ...SOURCE_FIT, ...opts };
  const ratio = sourceW / sourceH;
  let h = Math.max(box.minH, box.baseW / ratio);
  let w = h * ratio;
  if (h > box.maxH) { h = box.maxH; w = h * ratio; }
  if (w > box.maxW) { w = box.maxW; h = w / ratio; }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** 已有节点换源图（切版本 / 老节点纠偏）：宽度不动，只按源图比例改高度；高过节点现有高度才收宽度 */
export function refitNodeBox(current: MediaBox, sourceW: number, sourceH: number): MediaBox | null {
  return fitMediaBox(current.w, sourceW, sourceH, { w: Math.max(MEDIA_FIT_MAX.w, current.w), h: Math.max(MEDIA_FIT_MAX.h, current.h) });
}

/** "16:9" → 宽高比 16/9；自适应 / auto / 不合法 → null */
export function ratioOf(r: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(r ?? "").trim());
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

/** 面板里的「原图比例」：自适应 / 自动 / auto / adaptive / source —— 没有固定的比例字面值，比例要跟源图走 */
export function isAdaptiveRatio(r: unknown): boolean {
  const text = String(r ?? "").trim();
  return !!text && /^(自适应|自动|auto|adaptive|source)$/i.test(text);
}

/** 「原图比例」写进 params.sourceSize 的显式 WxH（"2048x1536"）→ 宽高比；不合法 → null */
export function sizeRatioOf(size: unknown): number | null {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(size ?? "").trim());
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}
