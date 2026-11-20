/**
 * 两颗 Hugeicons 动态图标的 React 移植（Web Animations API，不引入 motion / Vue）。
 *
 * 来源（Vue 注册表，MIT）：
 *   ai-content-generator-02 · https://hugeicons-animated.com/icons/ai-content-generator-02
 *   ai-editing             · https://hugeicons-animated.com/icons/ai-editing
 *
 * 行为按原版：鼠标进入所在按钮（closest('button')，没有就监听自身）播放一次；播放中再次进入不重播；
 * 离开不打断也不复位（loops=false）；prefers-reduced-motion: reduce 时完全不动。
 * 动画时间线全部写在下面的 keyframes 里（transform / opacity / stroke-dasharray + dashoffset）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type CSSProperties, type RefObject } from "react";

export type HugeAnimatedIconProps = { size?: number; className?: string };
export type HugeAnimatedIconHandle = { play: () => void };

const EASE = "cubic-bezier(.23,1,.32,1)";
const EASE_SOFT = "cubic-bezier(.77,0,.175,1)";

type Run = { el: SVGElement | null; keyframes: Keyframe[]; duration: number; delay?: number };

/** 鼠标进入宿主按钮时播放一次；不做离场复位（hover 结束后停在基础态） */
function useHostEnter(play: () => void, svgRef: RefObject<SVGSVGElement | null>) {
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const host: Element = svg.closest("button") ?? svg;
    const onEnter = () => play();
    host.addEventListener("mouseenter", onEnter);
    return () => host.removeEventListener("mouseenter", onEnter);
  }, [play, svgRef]);
}

/** 统一的播放器：播放中不重播；reduced-motion 直接不创建动画；卸载时取消 */
function usePlayOnce(runs: () => Run[]) {
  const playing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef<Animation[]>([]);
  const play = useCallback(() => {
    if (playing.current) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const list = runs().filter((r): r is Run & { el: SVGElement } => !!r.el);
    if (!list.length) return;
    playing.current = true;
    let total = 0;
    const made: Animation[] = [];
    for (const run of list) {
      const delay = run.delay ?? 0;
      total = Math.max(total, delay + run.duration);
      try {
        made.push(run.el.animate(run.keyframes, { duration: run.duration, delay, easing: "linear", fill: "both" }));
      } catch { /* 老浏览器不支持这些属性就保留静态图标 */ }
    }
    active.current = made;
    if (timer.current) clearTimeout(timer.current);
    // 播完做一次收尾：取消 fill:"both" 留下的结束帧，保证和 hover 前的静止姿态逐像素一致
    timer.current = setTimeout(() => {
      timer.current = null;
      playing.current = false;
      for (const a of active.current) { try { a.cancel(); } catch { /* ignore */ } }
      active.current = [];
    }, total + 40);
  }, [runs]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    for (const a of active.current) { try { a.cancel(); } catch { /* ignore */ } }
    active.current = [];
  }, []);
  return play;
}

const svgProps = (size: number, className?: string) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": true, focusable: false, className, style: { display: "block", flex: "none" } as CSSProperties,
});

export const AiContentGeneratorIcon = forwardRef<HugeAnimatedIconHandle, HugeAnimatedIconProps>(function AiContentGeneratorIcon({ size = 16, className }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pageRef = useRef<SVGPathElement>(null);
  const sparkRef = useRef<SVGPathElement>(null);
  const glyphRef = useRef<SVGPathElement>(null);

  const play = usePlayOnce(useCallback(() => [
    { el: pageRef.current, duration: 600, keyframes: [
      { transform: "scale(1)", easing: EASE, offset: 0 },
      { transform: "scale(0.972)", easing: EASE, offset: 0.3 },
      { transform: "scale(1.022)", easing: EASE, offset: 0.66 },
      { transform: "scale(1)", offset: 1 },
    ] },
    { el: sparkRef.current, duration: 620, delay: 620, keyframes: [
      // 原版是关键帧序列（不是连续插值）：0° → -26° → +9° → 0°，回摆后才归零
      { transform: "rotate(0deg) scale(1)", opacity: 1, easing: EASE, offset: 0 },
      { transform: "rotate(-26deg) scale(0.5)", opacity: 0.5, easing: EASE, offset: 0.3 },
      { transform: "rotate(9deg) scale(1.2)", opacity: 1, easing: EASE, offset: 0.66 },
      { transform: "rotate(0deg) scale(1)", opacity: 1, offset: 1 },
    ] },
    // 描边描绘：pathLength=1 后用 dasharray/dashoffset 近似原始 pathLength/pathOffset 关键帧
    { el: glyphRef.current, duration: 860, keyframes: [
      { strokeDasharray: "1 1", strokeDashoffset: 0, visibility: "visible", easing: "linear", offset: 0 },
      { strokeDasharray: "1 1", strokeDashoffset: 0, visibility: "visible", easing: EASE_SOFT, offset: 0.06 },
      { strokeDasharray: "0.12 1", strokeDashoffset: -0.88, visibility: "visible", easing: "linear", offset: 0.25 },
      { strokeDasharray: "0 1", strokeDashoffset: -1, visibility: "hidden", easing: "linear", offset: 0.28 },
      { strokeDasharray: "0 1", strokeDashoffset: 0, visibility: "hidden", easing: "linear", offset: 0.35 },
      { strokeDasharray: "0.12 1", strokeDashoffset: 0, visibility: "visible", easing: EASE_SOFT, offset: 0.39 },
      { strokeDasharray: "1 1", strokeDashoffset: 0, visibility: "visible", easing: "linear", offset: 0.84 },
      { strokeDasharray: "1 1", strokeDashoffset: 0, visibility: "visible", offset: 1 },
    ] },
  ], []));
  useImperativeHandle(ref, () => ({ play }), [play]);
  useHostEnter(play, svgRef);

  return <svg ref={svgRef} {...svgProps(size, className)}>
    <path ref={pageRef} style={{ transformBox: "view-box", transformOrigin: "11px 11px" }}
      d="M11 20C7.25027 20 5.3754 20 4.06107 19.0451C3.6366 18.7367 3.26331 18.3634 2.95491 17.9389C2 16.6246 2 14.7497 2 11C2 7.25027 2 5.3754 2.95491 4.06107C3.26331 3.6366 3.6366 3.26331 4.06107 2.95491C5.3754 2 7.25027 2 11 2H11.5C14.7734 2 16.4101 2 17.6125 2.7368C18.2853 3.14908 18.8509 3.71473 19.2632 4.38751C20 5.58985 20 7.22657 20 10.5" />
    <path ref={sparkRef} style={{ transformBox: "view-box", transformOrigin: "18px 18px" }}
      d="M17.4069 14.4036C17.6192 13.8655 18.3808 13.8655 18.5931 14.4036L18.6298 14.4969C19.1482 15.8113 20.1887 16.8518 21.5031 17.3702L21.5964 17.4069C22.1345 17.6192 22.1345 18.3808 21.5964 18.5931L21.5031 18.6298C20.1887 19.1482 19.1482 20.1887 18.6298 21.5031L18.5931 21.5964C18.3808 22.1345 17.6192 22.1345 17.4069 21.5964L17.3702 21.5031C16.8518 20.1887 15.8113 19.1482 14.4969 18.6298L14.4036 18.5931C13.8655 18.3808 13.8655 17.6192 14.4036 17.4069L14.4969 17.3702C15.8113 16.8518 16.8518 15.8113 17.3702 14.4969L17.4069 14.4036Z" />
    <path ref={glyphRef} pathLength={1} style={{ strokeDasharray: "1 1", strokeDashoffset: 0 }}
      d="M11 7H7V8M11 7H15V8M11 7V15M11 15H10M11 15H12" />
  </svg>;
});

export const AiEditingIcon = forwardRef<HugeAnimatedIconHandle, HugeAnimatedIconProps>(function AiEditingIcon({ size = 16, className }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const sparkRef = useRef<SVGPathElement>(null);
  const penRef = useRef<SVGPathElement>(null);

  const play = usePlayOnce(useCallback(() => [
    { el: sparkRef.current, duration: 620, delay: 180, keyframes: [
      // 原版是关键帧序列（不是连续插值）：0° → -26° → +9° → 0°，回摆后才归零
      { transform: "rotate(0deg) scale(1)", opacity: 1, easing: EASE, offset: 0 },
      { transform: "rotate(-26deg) scale(0.5)", opacity: 0.5, easing: EASE, offset: 0.3 },
      { transform: "rotate(9deg) scale(1.2)", opacity: 1, easing: EASE, offset: 0.66 },
      { transform: "rotate(0deg) scale(1)", opacity: 1, offset: 1 },
    ] },
    { el: penRef.current, duration: 680, keyframes: [
      { transform: "translate(0px, 0px)", easing: EASE_SOFT, offset: 0 },
      { transform: "translate(1.2px, -1.2px)", easing: EASE, offset: 0.36 },
      { transform: "translate(-0.2px, 0.2px)", easing: EASE, offset: 0.7 },
      { transform: "translate(0px, 0px)", offset: 1 },
    ] },
  ], []));
  useImperativeHandle(ref, () => ({ play }), [play]);
  useHostEnter(play, svgRef);

  return <svg ref={svgRef} {...svgProps(size, className)}>
    <path ref={sparkRef} style={{ transformBox: "view-box", transformOrigin: "7px 6px" }}
      d="M6.53792 2.32172C6.69664 1.89276 7.30336 1.89276 7.46208 2.32172L8.1735 4.2443C8.27331 4.51403 8.48597 4.72669 8.7557 4.8265L10.6783 5.53792C11.1072 5.69664 11.1072 6.30336 10.6783 6.46208L8.7557 7.1735C8.48597 7.27331 8.27331 7.48597 8.1735 7.7557L7.46208 9.67828C7.30336 10.1072 6.69665 10.1072 6.53792 9.67828L5.8265 7.7557C5.72669 7.48597 5.51403 7.27331 5.2443 7.1735L3.32172 6.46208C2.89276 6.30336 2.89276 5.69665 3.32172 5.53792L5.2443 4.8265C5.51403 4.72669 5.72669 4.51403 5.8265 4.2443L6.53792 2.32172Z" />
    <path ref={penRef} style={{ transformBox: "view-box", transformOrigin: "13.5px 14.5px" }}
      d="M14.4039 9.64136L15.8869 11.1244M6 22H7.49759C8.70997 22 9.31617 22 9.86124 21.7742C10.4063 21.5484 10.835 21.1198 11.6923 20.2625L19.8417 12.1131C20.3808 11.574 20.6503 11.3045 20.7944 11.0137C21.0685 10.4605 21.0685 9.81094 20.7944 9.25772C20.6503 8.96695 20.3808 8.69741 19.8417 8.15832C19.3026 7.61924 19.0331 7.3497 18.7423 7.20561C18.1891 6.93146 17.5395 6.93146 16.9863 7.20561C16.6955 7.3497 16.426 7.61924 15.8869 8.15832L7.73749 16.3077C6.8802 17.165 6.45156 17.5937 6.22578 18.1388C6 18.6838 6 19.29 6 20.5024V22Z" />
  </svg>;
});
