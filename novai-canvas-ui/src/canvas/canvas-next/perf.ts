/**
 * 低性能模式（流畅优先）：探测 + 手动偏好 + 持久化。
 *
 * 为什么需要：画布上有大量磨砂玻璃（backdrop-filter 对每个元素采样背景再模糊，成本随半径和面积走）
 * 与常驻动画，集显 / 4 核机在 100 节点画布上会被它们吃掉大半帧预算。
 *
 * 降级策略：
 *   · 硬件只做初判（4 核及以下才值得采样；Chrome 的 deviceMemory 封顶就是 8，不能当判据）；
 *   · 采样必须落在真实负载上 —— 等用户第一次操作后再量 1.2s 的 rAF 间隔，p95 > 45ms 才降级，
 *     空闲首屏一律 16.7ms，采了没意义；
 *   · 用户可以在「画布设置 → 性能模式」里锁定 自动 / 流畅优先 / 画质优先，写 localStorage。
 */
import { readMigratedKey } from "../../novaiStorage";
import { useSyncExternalStore } from "react";

export type PerfPref = "auto" | "high" | "low";
export type PerfState = { pref: PerfPref; sampled: "idle" | "weak" };
const KEY = "novai-canvas-perf";

function read(): PerfPref {
    try {
        const v = readMigratedKey(KEY);
        return v === "high" || v === "low" ? v : "auto";
    } catch { return "auto"; /* 无存储时按自动 */ }
}

let state: PerfState = { pref: read(), sampled: "idle" };
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
export const subscribePerf = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getState = () => state;

/** 实际生效的模式：手动优先，其次看采样结论 */
export function perfMode(s: PerfState = state): "low" | "high" {
    if (s.pref === "low") return "low";
    if (s.pref === "high") return "high";
    return s.sampled === "weak" ? "low" : "high";
}

export function setPerfPref(pref: PerfPref) {
    try { localStorage.setItem(KEY, pref); } catch { /* 只影响本次会话 */ }
    state = { ...state, pref, sampled: pref === "auto" ? "idle" : state.sampled };
    emit();
    if (pref === "auto") probe();
}

/** 硬件初判：只有 4 核及以下才值得采样，高性能机直接不打扰 */
function weakHardware() {
    return (Number(navigator.hardwareConcurrency) || 8) <= 4;
}

let probing = false;
/** 1.2s 帧间隔采样：p95 > 45ms 判为跑不动（60fps 预算 16.7ms，留约 2.7 倍余量） */
export function probe() {
    if (probing || state.pref !== "auto") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
        state = { ...state, sampled: "weak" }; emit(); return;
    }
    if (!weakHardware()) return;
    probing = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;
    const sample = () => {
        const frames: number[] = [];
        const t0 = performance.now();
        let last = t0;
        const tick = () => {
            const t = performance.now();
            frames.push(t - last); last = t;
            if (t - t0 < 1200) { requestAnimationFrame(tick); return; }
            probing = false;
            const sorted = frames.slice().sort((a, b) => a - b);
            const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] || 0;
            if (p95 > 45) { state = { ...state, sampled: "weak" }; emit(); }
        };
        requestAnimationFrame(tick);
    };
    const go = () => {
        if (armed) return; armed = true;
        for (const e of EVENTS) removeEventListener(e, go, true);
        if (timer) clearTimeout(timer);
        sample();
    };
    for (const e of EVENTS) addEventListener(e, go, { capture: true, passive: true });
    timer = setTimeout(go, 3000);
}
const EVENTS = ["pointerdown", "pointermove", "wheel", "keydown"] as const;

export function usePerf(): { mode: "low" | "high"; pref: PerfPref } {
    const s = useSyncExternalStore(subscribePerf, getState);
    return { mode: perfMode(s), pref: s.pref };
}
