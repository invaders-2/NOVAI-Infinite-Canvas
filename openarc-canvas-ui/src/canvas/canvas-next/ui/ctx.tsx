import { createContext, useContext } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { bounds, clamp } from "../model";
import { useStore, type CanvasState, type CanvasStore } from "../store";

/** 宿主能力：桌面版由 CanvasHost 注入，独立页 / 测试为空 */
export type HostActions = {
  backToList?: () => void;
  openModelSettings?: () => void;
  /** Agent「+ › 全部应用」：打开宿主的 MCP / 应用中心 */
  openMcpCenter?: () => void;
  openShare?: () => void;
  /** 打开外壳里的应用窗口（扩展菜单：Skill 中心 / 组织治理） */
  openApp?: (appId: string) => void;
  openCanvas?: (id: string) => void;
  listCanvases?: () => Promise<Array<{ id: string; name: string; nodes?: number }>>;
  user?: { name: string; initial: string; role?: string };
  badge?: string;
  features?: { collab?: boolean; share?: boolean; organization?: boolean; desktopInputs?: boolean; elements?: boolean; teamAssets?: boolean };
};

export class Ctl {
  vp: HTMLDivElement | null = null;
  /** 多人协作中心（加载完成后挂上；局域网会话也挂在它上面） */
  collab: import("../collab").CollabHub | null = null;
  constructor(public store: CanvasStore, public host: HostActions) {}
  rect() { return this.vp?.getBoundingClientRect() || new DOMRect(0, 0, innerWidth, innerHeight); }
  toWorld = (sx: number, sy: number) => { const r = this.rect(); const v = this.store.state.view; return { x: (sx - r.left - v.x) / v.k, y: (sy - r.top - v.y) / v.k }; };
  toScreen = (x: number, y: number) => { const r = this.rect(); const v = this.store.state.view; return { x: r.left + x * v.k + v.x, y: r.top + y * v.k + v.y }; };
  center() { const r = this.rect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }
  zoomAt(k: number, sx: number, sy: number) {
    const r = this.rect(); const v = this.store.state.view; k = clamp(k, .15, 2);
    const px = sx - r.left, py = sy - r.top;
    this.store.setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
  }
  fitTo(nodes: CanvasNode[], pad = 80, maxK = 1, anim = true) {
    const bb = bounds(nodes); if (!bb) return; const r = this.rect();
    const k = clamp(Math.min((r.width - pad * 2) / bb.w, (r.height - pad * 2) / bb.h), .15, maxK);
    const target = { k, x: r.width / 2 - (bb.x + bb.w / 2) * k, y: r.height / 2 - (bb.y + bb.h / 2) * k };
    if (!anim || matchMedia("(prefers-reduced-motion: reduce)").matches) { this.store.setView(target); return; }
    const from = { ...this.store.state.view }; const t0 = performance.now();
    const step = (t: number) => { const p = Math.min(1, (t - t0) / 300); const e = 1 - Math.pow(1 - p, 3); this.store.setView({ k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e }); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  focusNode(id: string) { const n = this.store.node(id); if (!n) return; this.store.setUI({ sel: new Set([id]), edge: null }); this.fitTo([n], 160, 1); }
  focusPrompt() { setTimeout(() => { const el = document.getElementById("gpPrompt") as HTMLElement | null; if (!el) return; el.focus(); if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); } }, 40); }
}

export const CtlCtx = createContext<Ctl | null>(null);
export function useCtl(): Ctl { const c = useContext(CtlCtx); if (!c) throw new Error("CtlCtx missing"); return c; }
export function useS<T>(sel: (s: CanvasState) => T): T { const c = useCtl(); return useStore(c.store, sel); }
