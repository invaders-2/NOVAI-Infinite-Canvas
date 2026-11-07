/**
 * 缩略图：把大图（2K / 4K 的 data URL）缩成小图再显示。
 *
 * 堆叠封面、堆叠展开视图里一次要显示很多张图，直接用 <img src=原图> 时浏览器要在主线程把每张原图
 * 解码成几十 MB 的位图，30 张就是上 GB 内存、展开时卡一两秒。这里改成：
 *   · data URL 交给后台线程（thumbWorker.ts）转成 Blob，用 createImageBitmap 一步「解码 + 缩放」，不卡界面；
 *     其它地址用 <img> 异步解码后再缩；
 *   · 缩好的 ImageBitmap 直接画到 <canvas> 上显示（不再编码成图片，也不受 CSP 对 blob: 的限制）；
 *   · 同时最多 3 张在缩，按像素总量做 LRU（约 160 MB），超出淘汰最久没用的；
 *   · 缩不了（外链跨域、格式不支持）就返回 null，调用方退回显示原图。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAssetUrl } from "./useAsset";
import { useThumbnailUrl } from "./useThumbnail";
import { previewThumbUrl } from "../table";

const MAX_PIXELS = 40_000_000;
type Entry = { bmp: ImageBitmap | null };
const cache = new Map<string, Entry>();
let pixels = 0;
const pending = new Map<string, Promise<Entry>>();
let active = 0;
const queue: Array<() => void> = [];
const slot = () => new Promise<void>((res) => { if (active < 3) { active++; res(); } else queue.push(() => { active++; res(); }); });
const free = () => { active--; queue.shift()?.(); };

/** 长字符串（data URL）不直接当 key：取长度 + 头尾，避免每次查表都对几 MB 的字符串求哈希 */
const keyOf = (src: string, px: number) => px + "|" + (src.length > 512 ? src.length + ":" + src.slice(0, 96) + src.slice(-160) : src);
const sizeOf = (e: Entry) => (e.bmp ? e.bmp.width * e.bmp.height : 0);

function put(key: string, e: Entry) {
  const old = cache.get(key); if (old) { pixels -= sizeOf(old); cache.delete(key); }
  cache.set(key, e); pixels += sizeOf(e);
  for (const [k, v] of cache) { if (pixels <= MAX_PIXELS || k === key) break; cache.delete(k); pixels -= sizeOf(v); v.bmp?.close(); }
}

/* data URL 交给后台线程解码 + 缩放；建不了 Worker（极老内核 / 测试环境）时在本线程做 */
let worker: Worker | null | undefined; let seq = 0;
const waiting = new Map<number, (b: ImageBitmap | null) => void>();
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./thumbWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; bmp: ImageBitmap | null }>) => { waiting.get(e.data.id)?.(e.data.bmp); waiting.delete(e.data.id); };
    worker.onerror = () => { waiting.forEach((f) => f(null)); waiting.clear(); worker = null; };
  } catch { worker = null; }
  return worker;
}
const viaWorker = (w: Worker, url: string, px: number, aspect: number) => new Promise<ImageBitmap | null>((res) => { const id = ++seq; waiting.set(id, res); w.postMessage({ id, url, px, aspect }); });

/**
 * 缩成长边不超过 px 的位图。aspect（宽 / 高）用来决定按宽还是按高缩，不准也没关系：
 * 解码后会按真实尺寸再确认一次。
 */
export function thumbBitmap(url: string, px: number, aspect = 1): Promise<Entry> {
  const key = keyOf(url, px);
  const hit = cache.get(key); if (hit) { put(key, hit); return Promise.resolve(hit); }
  let p = pending.get(key);
  if (!p) {
    p = (async (): Promise<Entry> => {
      await slot();
      try {
        const opt = (a: number): ImageBitmapOptions => (a >= 1 ? { resizeWidth: px } : { resizeHeight: px });
        const w = url.startsWith("data:") ? getWorker() : null;
        if (w) { const bmp = await viaWorker(w, url, px, aspect); if (bmp) return { bmp }; }
        const img = new Image(); img.decoding = "async"; img.src = url; await img.decode();
        const a = img.naturalWidth / Math.max(1, img.naturalHeight);
        return { bmp: await createImageBitmap(img, { ...opt(a), resizeQuality: "high" }) };
      } catch { return { bmp: null }; } finally { free(); }
    })();
    pending.set(key, p);
    void p.then((e) => { pending.delete(key); put(key, e); });
  }
  return p;
}

/**
 * 表格 / 网格里的小缩略图：NOVAI 本地素材统一走 /api/media-preview（后端缩图、视频自动抽帧），
 * 一律渲染成 <img loading="lazy" decoding="async">——绝不在表格里挂 <video>：
 * 「全部」模式下每行几十张素材，真实 video 元素会开几十个解码器，画布直接卡死。
 * preview 打不开回落原地址，原地址也不行就交给 onFail（调用方显示占位 / 文字）。
 */
export function PreviewImg({ src, width, title, className, onFail }: { src: string; width: number; title?: string; className?: string; onFail?: () => void }) {
  const [stage, setStage] = useState(0);
  // novai-asset: 引用先由资源库换成可显示地址（本地素材换出来就是 /assets/…，会走 media-preview）
  const resolved = useAssetUrl(src);
  const original = resolved || src;
  const preview = previewThumbUrl(original, width);
  useEffect(() => { setStage(0); }, [original, width]);
  if (!original || stage > 1) return null;
  return <img className={className} src={stage === 0 ? preview : original} alt="" title={title} draggable={false} loading="lazy" decoding="async"
    onError={() => { if (stage === 0 && preview !== original) setStage(1); else { setStage(2); onFail?.(); } }} />;
}

/**
 * 展示位的小图（列表行 / 胶囊 / 悬停预览这类「看一眼」的地方）：
 * 先走 useThumbnailUrl 的缩略图（本地素材交给 /api/media-preview，后端按路径+宽度缓存，视频自动抽帧），
 * 缩略图加载失败退回原图，原图也失败就交给调用方的 fallback（图标兜底，不留空白格）。
 * 灯箱 / 图像编辑器 / 导出 / 生成请求继续用原图，不走这里。
 */
export function ThumbImg({ src, width, fallback = null, className, title, style, lazy = true }: {
  src: string; width: number; fallback?: ReactNode; className?: string; title?: string; style?: CSSProperties; lazy?: boolean;
}) {
  const full = useAssetUrl(src);
  const thumb = useThumbnailUrl(src, width);
  const [step, setStep] = useState(0);
  useEffect(() => { setStep(0); }, [full, thumb]);
  if (!full || step > 1) return <>{fallback}</>;
  const small = thumb || full;
  return <img className={className} src={step === 0 ? small : full} alt="" title={title} style={style} draggable={false}
    loading={lazy ? "lazy" : undefined} decoding="async"
    onError={() => setStep((s) => (s === 0 && small !== full ? 1 : 2))} />;
}

/**
 * 背景图位（时间线片段封面这类不能挂 <img> 的地方）：先给缩略图地址，
 * 缩略图加载失败再退回原图——background-image 没有 onError，只能用探针图兜底。
 */
export function useThumbBg(src: string, width: number): string {
  const small = previewThumbUrl(src, width);
  const [url, setUrl] = useState(() => (src ? small : ""));
  useEffect(() => {
    if (!src) { setUrl(""); return; }
    setUrl(small);
    if (small === src) return;
    let alive = true;
    const probe = new Image();
    probe.onerror = () => { if (alive) setUrl(src); };
    probe.src = small;
    return () => { alive = false; probe.onerror = null; };
  }, [src, small]);
  return url;
}

/**
 * 显示一张缩略图：src 可以是 novai-asset:… 引用或普通地址。缩好前显示占位（不先显示原图——
 * 先显示原图就又要解码一次大图，正是卡顿的来源）；缩不了时退回 <img>。
 */
export function ThumbImage({ src, px, aspect, className }: { src: string; px: number; aspect?: number; className?: string }) {
  const url = useAssetUrl(src);
  const [e, setE] = useState<Entry | null>(() => (url ? cache.get(keyOf(url, px)) || null : null));
  useEffect(() => {
    if (!url) { setE(null); return; }
    const hit = cache.get(keyOf(url, px)); if (hit) { setE(hit); return; }
    let alive = true; setE(null);
    void thumbBitmap(url, px, aspect).then((v) => { if (alive) setE(v); });
    return () => { alive = false; };
  }, [url, px, aspect]);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current; const b = e?.bmp; if (!c || !b) return;
    try { c.width = b.width; c.height = b.height; c.getContext("2d")?.drawImage(b, 0, 0); } catch { /* 位图已被淘汰：下次渲染重新缩 */ }
  }, [e]);
  if (!url || !e) return <div className={(className || "") + " st-ph loading"} />;
  if (!e.bmp) return <img className={className} src={url} alt="" draggable={false} decoding="async" />;
  return <canvas ref={ref} className={className} />;
}

/**
 * 输入框里 @ 胶囊的小图（约 16px，DOM 直接拼的那种，用不了 <ThumbImg>）：绝不挂原图。
 * 之前胶囊里直接 <img src=原图>：一张 3072×4096 的图解码 48MB，而且 contenteditable 光标每次闪烁
 * 都要把整块重绘一遍——等于每秒把 4K 原图缩成 16px 画好几次，@ 了图片以后打字就明显发卡。
 *   · /assets、/output 本地素材 → /api/media-preview?w=64（后端缩图，视频自动抽帧）；
 *   · data:image → 后台线程缩成 48px 位图画到 <canvas>；
 *   · 其它外链 → 异步解码的 <img>；任何一步失败都交给 onFail 显示图标。
 */
export function setChipThumb(th: HTMLElement, url: string, onFail: () => void): void {
  if (!url) { onFail(); return; }
  if (url.startsWith("data:")) {
    if (!url.startsWith("data:image/")) { onFail(); return; }
    void thumbBitmap(url, 48).then((e) => {
      if (!e.bmp) { onFail(); return; }
      const c = document.createElement("canvas"); c.width = e.bmp.width; c.height = e.bmp.height;
      c.getContext("2d")?.drawImage(e.bmp, 0, 0);
      th.replaceChildren(c);
    });
    return;
  }
  const img = document.createElement("img"); img.alt = ""; img.draggable = false; img.decoding = "async";
  img.onerror = onFail;
  img.src = previewThumbUrl(url, 64);
  th.replaceChildren(img);
}
