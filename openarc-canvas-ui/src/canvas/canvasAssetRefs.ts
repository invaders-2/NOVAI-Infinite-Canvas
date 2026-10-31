/**
 * 画布文档里的资源引用（openarc-asset:<ResourceRef>）⇄ 页面可显示数据 的纯逻辑。
 *
 * 为什么单独成模块：宿主 CanvasHost 的 resolveRefs / refsBack 是这段逻辑的唯一调用方，但它们是
 * React 组件内的闭包（组件文件是 .tsx，Node 单测无法直接 import）。把"怎么找、怎么换、换不回来
 * 放什么"抽成不依赖 Electron / DOM 的纯函数，才能对真实逻辑写门禁用例（多引用分批、非 url 字段、
 * 保存对称回写、读不出来时的如实处理），而不是在测试里复刻一份实现。
 *
 * 三条硬约束（来自产品口径）：
 *   1. 画布文档只存引用：保存时必须把显示用的数据换回 openarc-asset: ref（旧 data URL 原样保留，不静默丢图）。
 *   2. 页面 CSP 只有 img-src openarc-canvas: data: blob:：绝不能把未转换的 openarc-asset: 丢给 <img>，
 *      否则就是 CSP 违规 + 图裂。
 *   3. 读不出来的引用（被删 / 无权限）必须如实标注为不可用，且仍然保留引用本身，保存时不丢。
 */

/** 画布文档里资源引用的稳定前缀（与 canvas-service.importAsset 的落库口径一致）。*/
export const ASSET_PREFIX = "openarc-asset:";

/**
 * 引用读不出来时给页面的占位值。
 *
 * 为什么不是空串、也不是 openarc-asset:：
 *   · openarc-asset: 会以 <img src> 落到页面 → 页面 CSP（img-src openarc-canvas: data: blob:）直接拦下，
 *     产生 "violates ... Content Security Policy" 违规样本，图也裂（这正是本模块要修的缺陷）；
 *   · 空串在部分 Chromium 版本会被解析成当前文档地址再发一次请求，且看不出"这里原本有张图"；
 *   · data: 在 CSP 白名单内，image 解码失败是静默失败（不产生 console error / requestfailed，
 *     已用 experiments/dxos-canvas-asset-refs/img-csp-probe.mjs 实测），
 *     同时 MIME 不是 image/* 所以不会被误当成真图，且能**自描述地编码原引用**，
 *     保存侧无需任何跨请求状态即可确定性还原。
 */
export const MISSING_ASSET_DATA_URL_PREFIX = "data:application/vnd.openarc.missing-asset;charset=utf-8,";

/**
 * 一次并发读多少个引用。
 *
 * readAsset 每次回整张图的 data URL：不设并发上限时几十张大图会同时回传（主进程 base64 + 宿主内存峰值）。
 * 16 与仓库既有小批量约定同量级（上传/入库每次 8、assetStates 每次 200），既压住峰值又不会让几十张图
 * 串行到肉眼可见的等待。**没有总数上限**：可解析的引用必须全部解析（否则就是图不显示），
 * 批次只约束并发，缓存（dataUrlByRef）保证重复引用不重复读。
 */
export const ASSET_RESOLVE_BATCH = 16;

/** 文档深遍历的深度上限：只防病态深嵌套，画布文档远达不到。*/
const MAX_DOC_WALK_DEPTH = 16;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** 读不出来的引用 → 页面安全占位值（只编码裸 ref，不带 ASSET_PREFIX）。*/
export function missingAssetPlaceholder(ref: string): string {
  return MISSING_ASSET_DATA_URL_PREFIX + encodeURIComponent(String(ref || ""));
}

/** 占位值 → 裸 ref；不是占位值时返回 null（保存侧据此只动自己放进去的值，不碰用户旧数据）。*/
export function refFromMissingAssetPlaceholder(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(MISSING_ASSET_DATA_URL_PREFIX)) return null;
  try {
    const ref = decodeURIComponent(value.slice(MISSING_ASSET_DATA_URL_PREFIX.length));
    return ref && !ref.startsWith("data:") ? ref : null;
  } catch {
    return null;
  }
}

/**
 * 深度遍历文档（对象 / 数组），把 mapper 的返回值写回每一个字符串。
 * 原位修改并返回同一引用：与既有 refsBack 对 node.url 的原位写法一致，且页面保存载荷本来就是本帧对象。
 */
export function mapDocStrings<T>(value: T, mapper: (s: string) => string, depth = 0): T {
  if (typeof value === "string") return mapper(value) as unknown as T;
  if (depth >= MAX_DOC_WALK_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = mapDocStrings(value[i], mapper, depth + 1);
    return value;
  }
  if (!isPlain(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    (value as Record<string, unknown>)[key] = mapDocStrings((value as Record<string, unknown>)[key], mapper, depth + 1);
  }
  return value;
}

/**
 * 文档里所有出现过的资源引用字段路径。
 *
 * 实际结构（只读确认，不是猜测）：
 *   · node.url                        图片 / 视频节点的主地址（public/novai-canvas/static/js/canvas.js 用它渲染 <img>）
 *   · node.refs[]                     string 或 { url } 两种形态（canvas-exchange-ports.cjs createCanvasCard 写 refs:[ref]；
 *                                     画布页 generatorSources / renderVideoImageInputs 会把 refs[].url 渲染成缩略图）
 *   · node.inputs[].url               canvas-exchange-ports.cjs sanitizeInputs 写 url: ref
 *   · node.params / node.thumbnail / node.preview / node.images / node.generatedOutputs /
 *     node.imageComparisons / doc.logs[].refs 等凡是字符串形态的引用
 * 所以这里不写死字段名，而是**按前缀深度遍历**：只有真正以 openarc-asset: 开头的字符串会被处理，
 * 既不会碰文本 / 尺寸 / 坐标，也不会漏掉上游新版页面新增的承载字段（封面 / 缩略图等）。
 */
export function collectAssetRefs(doc: unknown): string[] {
  const refs = new Set<string>();
  mapDocStrings(doc, (s) => {
    if (s.startsWith(ASSET_PREFIX)) refs.add(s.slice(ASSET_PREFIX.length));
    return s;
  });
  return [...refs];
}

export type ResolveAssetDataUrl = (ref: string) => Promise<string | null>;

export type ResolveAssetRefsOptions = {
  /** ref → data URL 的跨次缓存；命中就不重复读。*/
  cache: Map<string, string>;
  /** data URL → openarc-asset:ref 的反向映射（保存回写用）。*/
  reverse: Map<string, string>;
  /** 受控读取（宿主里是 canvas/readAsset：逐资源授权）。返回 null 表示读不出来。*/
  resolve: ResolveAssetDataUrl;
  batch?: number;
};

export type ResolveAssetRefsResult<T> = {
  doc: T;
  /** 本次真的从受控读取拿到的引用数（不含缓存命中）。*/
  fetched: number;
  /** 读不出来的引用（被删 / 无权限）；文档里已换成安全占位值，引用本身仍可还原。*/
  unavailable: string[];
};

/**
 * 把文档里所有 openarc-asset: 引用换成可显示的 data URL；读不出来的换成安全占位值。
 *
 * 语义：
 *   · 可解析的引用一律换成 data URL（没有 20 之类的总数上限，否则剩下的会以原始 ref 落到 <img> 上）；
 *   · 批次只约束并发，缓存命中不计数；
 *   · 读不出来的引用换成 data:...missing-asset 占位值并原样登记，绝不把 openarc-asset: 留给页面。
 */
export async function resolveAssetRefsInDoc<T>(doc: T, options: ResolveAssetRefsOptions): Promise<ResolveAssetRefsResult<T>> {
  const { cache, reverse, resolve, batch = ASSET_RESOLVE_BATCH } = options;
  const size = Math.max(1, Math.floor(batch) || ASSET_RESOLVE_BATCH);
  const wanted = collectAssetRefs(doc).filter((ref) => !cache.has(ref));
  const unavailable = new Set<string>();
  let fetched = 0;
  for (let i = 0; i < wanted.length; i += size) {
    const slice = wanted.slice(i, i + size);
    const results = await Promise.all(slice.map(async (ref) => {
      try {
        const dataUrl = await resolve(ref);
        return { ref, dataUrl: typeof dataUrl === "string" && dataUrl ? dataUrl : null };
      } catch {
        return { ref, dataUrl: null };
      }
    }));
    for (const r of results) {
      if (r.dataUrl) {
        cache.set(r.ref, r.dataUrl);
        reverse.set(r.dataUrl, ASSET_PREFIX + r.ref);
        fetched += 1;
      } else {
        unavailable.add(r.ref);
      }
    }
  }
  const out = mapDocStrings(doc, (s) => {
    if (!s.startsWith(ASSET_PREFIX)) return s;
    const ref = s.slice(ASSET_PREFIX.length);
    const dataUrl = cache.get(ref);
    if (dataUrl) return dataUrl;
    unavailable.add(ref);
    return missingAssetPlaceholder(ref);
  });
  return { doc: out, fetched, unavailable: [...unavailable] };
}

/**
 * 保存回写：把显示用的 data URL / 占位值换回稳定的 openarc-asset: 引用。
 *   · 占位值 → 原引用（读不出来的资源不因一次显示就被清掉）；
 *   · 已知 data URL（本帧导入或解析出来的）→ 原引用；
 *   · 其它（用户旧 data URL / 非引用内容）原样保留，绝不静默丢图。
 */
export function restoreAssetRefsInDoc<T>(doc: T, reverse: Map<string, string>): T {
  return mapDocStrings(doc, (s) => {
    const ref = refFromMissingAssetPlaceholder(s);
    if (ref) return ASSET_PREFIX + ref;
    if (s.startsWith("data:")) {
      const known = reverse.get(s);
      if (known) return known;
    }
    return s;
  });
}
