/**
 * 参数选择卡片（分辨率 / 比例 / 张数 / 时长这类短选项）——生成面板和助手的待生成卡片共用一套：
 * 同样的高度、圆角、内距、字号；比例卡带画幅小图标（按 ratioWH 算宽高，线性描边小方框）。
 * 选中高亮走旧智能画布留存的 window.NovaGlide 滑块（.nv-glide-pill），切换时是滑动过渡。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { ratioWH } from "../model";

/** 旧智能画布的滑块高亮（static/js/shared/glide.js 暴露的 window.NovaGlide），这里只声明用到的部分 */
interface NovaGlideController {
  refresh: () => NovaGlideController;
  destroy: () => void;
  setActive: (el: Element | null, opts?: { instant?: boolean }) => NovaGlideController;
  clear: () => NovaGlideController;
  readonly orientation: string;
}
interface NovaGlideApi {
  attach: (container: Element, options: { item: string; orientation?: string; activeClass?: string; cursorClass?: string; duration?: number; inset?: number }) => NovaGlideController | null;
}
declare global {
  interface Window { NovaGlide?: NovaGlideApi }
}

/** 一张卡：on 决定滑块落在哪，shape 是比例卡上的画幅图标，attrs 给测试钩子（data-p / data-vopt 之类） */
export type OptCardItem = { key: string; label: ReactNode; on: boolean; disabled?: boolean; title?: string; shape?: ReactNode; attrs?: Record<string, string>; pick: () => void };

export function OptCards({ cols, items }: { cols: number; items: OptCardItem[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const glideRef = useRef<NovaGlideController | null>(null);
  const timersRef = useRef<number[]>([]);
  /* 选项集合变了才重挂滑块；普通 re-render 不碰，免得把正在滑的过渡重置 */
  const signature = items.map((it) => it.key).join("|");
  useEffect(() => {
    const el = hostRef.current;
    const api = typeof window === "undefined" ? undefined : window.NovaGlide;
    if (!el || !api) return;
    // React 重渲染不会替我们保住滑块：没了就重新挂，还在就交给 glide 自己的 observer 跟位置
    if (!el.querySelector(".nv-glide-pill")) {
      glideRef.current?.destroy();
      glideRef.current = api.attach(el, { item: "button", orientation: "grid", activeClass: "on" });
    }
    // 参数卡片在 #pop 里，首帧 visibility:hidden 量到 0×0：等弹层显示后再补两次 refresh 让选中项落位
    timersRef.current.forEach((id) => window.clearTimeout(id));
    const frame = requestAnimationFrame(() => glideRef.current?.refresh());
    const late = window.setTimeout(() => glideRef.current?.refresh(), 160);
    timersRef.current = [late];
    return () => { cancelAnimationFrame(frame); window.clearTimeout(late); };
  }, [signature]);
  useEffect(() => () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    glideRef.current?.destroy();
    glideRef.current = null;
  }, []);
  // 字体换行 / 网格 reflow 后重新对齐（滑块坐标是内容空间的，容器尺寸一变就得重算）
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => glideRef.current?.refresh());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div className="opt-grid" ref={hostRef} style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}>
    {items.map((it) => <button key={it.key} {...(it.attrs || {})} className={it.on ? "on" : ""} disabled={it.disabled} title={it.title} onClick={it.pick}>{it.shape || null}<span>{it.label}</span></button>)}
  </div>;
}

/** auto / adaptive / 自动 统一成画布内部用的「自适应」（画幅图标按 3:4 画） */
export function normRatio(value: string): string {
  return /^(auto|adaptive|自适应)$/i.test(String(value || "")) ? "自适应" : String(value || "");
}

/** 比例卡上的画幅图标：按比例算宽高的小方框（线性描边交给 .opt-grid i 的 CSS） */
export function ratioShape(ratio: string, long = 20): ReactNode {
  const [w, h] = ratioWH(normRatio(ratio), long);
  return <i style={{ width: w, height: h }} />;
}
