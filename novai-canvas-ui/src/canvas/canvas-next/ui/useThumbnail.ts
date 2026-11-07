import { useEffect, useState } from "react";
import { previewThumbUrl } from "../table";
import { useAssetUrl } from "./useAsset";

const MAX_EDGE = 768;
const MAX_ITEMS = 80;
/**
 * 节点卡显示用的请求宽度档位。
 * 取 2.5× 显示宽再归一到固定档：覆盖 dpr1 下最大缩放（k 上限 2）仍不放大，也覆盖 dpr2 下 1.25 倍，
 * 档位少 → 后端 /api/media-preview 按「路径+宽度」缓存的命中率高（同一张图不同节点共用一份）。
 */
const STEPS = [256, 384, 512, 768, 1024, 1536];
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export const thumbStep = (cssWidth: number) => {
    const want = Math.max(1, Number(cssWidth) || 320) * 2.5;
    return STEPS.find((s) => s >= want) || STEPS[STEPS.length - 1];
};

function thumbnail(src: string): Promise<string> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            const long = Math.max(image.naturalWidth, image.naturalHeight);
            if (long <= MAX_EDGE) { resolve(src); return; }
            const scale = MAX_EDGE / long;
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/webp", .84));
        };
        image.onerror = () => resolve(src);
        image.src = src;
    });
}

/**
 * 节点显示专用的小图；原图仍由资源库、灯箱、图像编辑、导出和生成请求使用。
 *
 * 三条路分开处理：
 *   · 后端能解析的本地素材（/assets/、/output/）→ 交给 /api/media-preview 缩图（服务端按
 *     路径+宽度落盘缓存、immutable 长缓存、视频自动抽帧）。之前这里直接把原图塞进 <img>，
 *     1024²/2048² 的图每张要解码 4–16MB，几十个节点就是几百 MB 位图 + 每帧重新上传纹理；
 *   · data:image 的 data URL → 主线程缩图（超大 base64 走这条路）；
 *   · 其它地址（外链、novai-asset:）→ 原样返回，交给调用方自己兜。
 *
 * cssWidth 传节点显示宽度（CSS px），按 2.5× 归一档位；不传时按默认卡宽算。
 */
export function useThumbnailUrl(src: string, cssWidth = 320): string {
    const full = useAssetUrl(src);
    // 初始值直接取缩略图地址：若初始值用 full，节点挂载的第一帧会先按原图挂上 <img>，
    // 下一帧再换成缩略图——那次原图请求/解码虽然会被取消，但冷缓存首开和拖动时都是白花的
    const [url, setUrl] = useState(() => previewThumbUrl(full, thumbStep(cssWidth)) || full);
    useEffect(() => {
        const small = previewThumbUrl(full, thumbStep(cssWidth));
        if (small !== full) { setUrl(small); return; }
        if (!full.startsWith("data:image/")) { setUrl(full); return; }
        const hit = cache.get(full);
        if (hit) { setUrl(hit); return; }
        let alive = true;
        let job = pending.get(full);
        if (!job) { job = thumbnail(full); pending.set(full, job); }
        job.then((smallUrl) => {
            pending.delete(full);
            cache.set(full, smallUrl);
            if (cache.size > MAX_ITEMS) cache.delete(cache.keys().next().value!);
            if (alive) setUrl(smallUrl);
        });
        return () => { alive = false; };
    }, [full, cssWidth]);
    return url;
}

/** GIF 判定基于解析后的原图地址：可能是 data:image/gif 的 data URL，也可能带 query（/assets/input/a.gif?v=2） */
export const isGifUrl = (url: string) => /^data:image\/gif/i.test(url) || /\.gif(?:$|[?#])/i.test(url);

const posterCache = new Map<string, string>();
const posterPending = new Map<string, Promise<string>>();
const MAX_POSTERS = 60;

/**
 * GIF 的静态首帧（只在内存里，不进资源库、不写文档）。
 *
 * 为什么不能只靠缩略图：/api/media-preview 由后端只取第一帧，浏览器模式天然就是静态；但桌面版拿到的是
 * data URL，走不到那个接口，thumbnail() 对长边 ≤768 的图又直接返回原图本身——那一支没有静态帧可借。
 * 画布不虚拟化、所有节点常驻 DOM，默认态挂原图等于所有 GIF 常驻解码，所以这里自己画一张首帧兜底。
 */
function drawPoster(src: string): Promise<string> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            const long = Math.max(image.naturalWidth, image.naturalHeight) || 1;
            const scale = long > MAX_EDGE ? MAX_EDGE / long : 1;
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(""); return; }
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/webp", .9));
        };
        image.onerror = () => resolve("");
        image.src = src;
    });
}

/** 原图 → 首帧地址；同一地址只画一次（画不出来也缓存空串，不反复解码） */
export function useGifPoster(src: string): string {
    const [poster, setPoster] = useState<string>(() => (src ? posterCache.get(src) || "" : ""));
    useEffect(() => {
        if (!src) { setPoster(""); return; }
        const hit = posterCache.get(src);
        if (hit !== undefined) { setPoster(hit); return; }
        let alive = true;
        let job = posterPending.get(src);
        if (!job) { job = drawPoster(src); posterPending.set(src, job); }
        job.then((url) => {
            posterPending.delete(src);
            if (posterCache.size >= MAX_POSTERS) posterCache.delete(posterCache.keys().next().value!);
            posterCache.set(src, url);
            if (alive) setPoster(url);
        });
        return () => { alive = false; };
    }, [src]);
    return poster;
}
