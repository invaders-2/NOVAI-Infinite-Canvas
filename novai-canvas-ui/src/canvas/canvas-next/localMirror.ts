/**
 * 本机镜像（localStorage）写入策略。
 *
 * 为什么改：保存链路原来是「每次防抖保存都同步 writeDoc(整份文档)」——800ms 一次，
 * 一次 JSON.stringify + 一次同步 localStorage 写入。1MB 级文档在低配机上单次 5–15ms 主线程卡顿，
 * 拖拽/输入时正好落在同一帧里；文档越大越卡，也是「画布越用越大 → 越来越卡」的一条。
 *
 * 现在：
 *   · 只有 doc 引用真的变了才写（store 里 doc 是 immutable，引用变 = 内容变）；
 *   · 写盘推迟到浏览器空闲（requestIdleCallback，最长 1.5s 兜底），不再和网络保存抢同一帧；
 *   · pagehide / 页面隐藏时同步补写一次，不丢最后状态；
 *   · 体积护栏：粗估超过 1.5MB 的文档不写本机镜像（服务端才是权威，localStorage 全局只有 5MB）；
 *   · 读回路径不变：readDoc 读到的可能是上一份，load() 里已有「从本机副本打开」的降级提示。
 */
import { readDoc, writeDoc, type CanvasDoc } from "../react-canvas/reactCanvasStore";

/** localStorage 全局约 5MB：单个画布镜像超过这个量就不写，免得把整个站点的本机存储挤满 */
const MAX_APPROX_CHARS = 1.5 * 1024 * 1024;
const IDLE_TIMEOUT = 1500;

/** 粗估体积（不做 stringify）：大头是 data: URL 与文本 */
function approxChars(doc: CanvasDoc): number {
    let n = 0;
    for (const node of doc.nodes) {
        n += (node.text ? node.text.length : 0) + (node.url ? node.url.length : 0);
        const gen = (node.data as { gen?: { hist?: Array<{ url?: string; frame?: string; text?: string }> } } | undefined)?.gen;
        if (gen?.hist) for (const h of gen.hist) n += (h.url ? h.url.length : 0) + (h.frame ? h.frame.length : 0) + (h.text ? h.text.length : 0);
    }
    return n;
}

type Job = { canvasId: string; doc: CanvasDoc };
const lastWritten = new WeakMap<CanvasDoc, string>();
let queued: Job | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let idle: number | null = null;
let bound = false;

function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (idle != null && typeof cancelIdleCallback === "function") { cancelIdleCallback(idle); idle = null; }
    const job = queued; queued = null;
    if (!job) return;
    if (lastWritten.get(job.doc) === job.canvasId) return;       // 同一份文档已写过
    if (approxChars(job.doc) > MAX_APPROX_CHARS) return;         // 太大：交给服务端，别挤爆 localStorage
    lastWritten.set(job.doc, job.canvasId);
    writeDoc(job.canvasId, job.doc);
}

function bindFlush() {
    if (bound || typeof addEventListener !== "function") return;
    bound = true;
    // 关页/隐藏时同步补写：localStorage 在这里写是允许的，宁可慢一次也不能丢
    addEventListener("pagehide", flush);
    addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}

/** 保存成功后调用：只在空闲时把本机镜像更新一次 */
export function queueLocalMirror(canvasId: string, doc: CanvasDoc) {
    if (lastWritten.get(doc) === canvasId) return;
    queued = { canvasId, doc };
    bindFlush();
    if (timer || idle != null) return;
    if (typeof requestIdleCallback === "function") {
        idle = requestIdleCallback(() => { idle = null; flush(); }, { timeout: IDLE_TIMEOUT });
    } else {
        timer = setTimeout(() => { timer = null; flush(); }, 400);
    }
}

export { readDoc };
