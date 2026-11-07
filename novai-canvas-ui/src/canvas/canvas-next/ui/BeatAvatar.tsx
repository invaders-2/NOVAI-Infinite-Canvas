/**
 * BEAT 助手头像：扁平双条（深色实心盘 + 纯平竖眼 + 三层发光）+ 12 状态。
 *
 * 权威实现是 _beat-icon-final/beat-avatar.snippet.html：几何、颜色、光强、动画时长逐字沿用，
 * 只做三处必要适配——
 *   1) 类名与关键帧加 beat-av- 前缀：微应用注入宿主页面，裸 beat-* 会和画布页撞名；
 *   2) 片段里浅色主题靠祖先 [data-theme="light"]，这里由 [data-theme] 投影到图标自己身上
 *      （画布的主题写在 .cn-root[data-theme] 上，见 canvas-next.css 第一行）；
 *   3) 片段里的单例 el.beatAvatar 换成模块级共享循环：整个应用只挂一个 pointermove 和一个 rAF，
 *      多个头像只是同一循环里多注册一个目标。
 *
 * 盘的内描边是这个图形本身的一部分（「本身是图形」的例外），不是给面板画的层级线。
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import "./beat-avatar.css";

export type BeatState =
  | "idle"
  | "blink"
  | "happy"
  | "thinking"
  | "listening"
  | "focus"
  | "sleepy"
  | "surprised"
  | "error"
  | "generating"
  | "tool"
  | "waiting";

export type BeatTheme = "dark" | "light";

interface BeatAvatarProps {
  /** 12 个状态之一；自动回落（success 1.2s / error 1.4s / 45s 转困倦）由上层决定 */
  state?: BeatState;
  /** 只决定根节点边长，内部全是百分比 */
  size?: number;
  /** 不传就跟随最近的 [data-theme] 祖先（画布是 .cn-root）；都没有时按深色 */
  theme?: BeatTheme;
  /** 0.55 弱 / 1 中 / 1.5 强 */
  glow?: number;
  /** 0..1，只有 generating 会读它 */
  progress?: number;
  followPointer?: boolean;
  className?: string;
}

/** 画布的主题属性在 .cn-root[data-theme] 上，这里向上找最近的宿主；默认深色（画布默认主题） */
const nearestThemeHost = (el: HTMLElement | null): HTMLElement | null => {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const value = node.dataset ? node.dataset.theme : undefined;
    if (value === "dark" || value === "light") return node;
    node = node.parentElement;
  }
  return null;
};

const readTheme = (el: HTMLElement | null): BeatTheme => {
  const host = nearestThemeHost(el);
  return host?.dataset.theme === "light" ? "light" : "dark";
};

/** 宿主没换过，主题就可能在运行中切（设置菜单 / ⇧⌘L / 跟随系统），所以只盯宿主那一个属性 */
const useNearestTheme = (root: RefObject<HTMLElement | null>): BeatTheme => {
  const [theme, setTheme] = useState<BeatTheme>("dark");
  useEffect(() => {
    const sync = () => setTheme((current) => (current === readTheme(root.current) ? current : readTheme(root.current)));
    sync();
    const hosts = [nearestThemeHost(root.current), document.documentElement].filter((el): el is HTMLElement => !!el);
    const observer = new MutationObserver(sync);
    for (const el of hosts) observer.observe(el, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, [root]);
  return theme;
};

/* 表情动效全在 CSS，JS 只剩两件 CSS 做不到的事：鼠标跟随要每帧插值，随机眨眼要按状态改间隔。
   两者都照片段里的数值实现，只是把单例换成共享循环。 */
interface FollowTarget {
  root: HTMLElement;
  eyes: HTMLElement;
  bars: HTMLElement[];
  ox: number;
  oy: number;
  blinkAt: number;
  double: boolean;
  nextBlink: number;
}

const BLINK_WINDOW: Record<string, { min: number; max: number; double?: boolean }> = {
  idle: { min: 4000, max: 7000 },
  listening: { min: 2000, max: 3500 },
  sleepy: { min: 4000, max: 6000 },
  happy: { min: 1100, max: 2000, double: true },
};

const targets = new Set<FollowTarget>();
/* 模块顶层不裸用 window：设计器 / node 测试会用 esbuild 打包源码在无 DOM 环境里 import 本文件
   （actions.ts → ui/shortcuts → ui/Chrome → 这里），拿不到 window 就按 0 / 没有动效处理 */
const hasWindow = typeof window !== "undefined";
let pointerX = hasWindow ? window.innerWidth / 2 : 0;
let pointerY = hasWindow ? window.innerHeight / 2 : 0;
let frameHandle = 0;
let pointerBound = false;
let settleBound = false;
const reducedMotion = hasWindow ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

const trackPointer = (event: PointerEvent) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
};

const blinkShape = (p: number) =>
  p < 0.45 ? 1 - 0.94 * Math.sin((p / 0.45) * Math.PI / 2) : 0.06 + 0.94 * (1 - Math.pow(1 - (p - 0.45) / 0.55, 3));

/** 关掉动效时把跟随/眨眼留下的行内 transform 清掉，否则会停在最后那一帧的偏移上 */
const restTarget = (target: FollowTarget) => {
  target.ox = 0;
  target.oy = 0;
  target.eyes.style.transform = "";
  for (const bar of target.bars) bar.style.transform = "";
};

const frame = (time: number) => {
  if (!targets.size) {
    frameHandle = 0;
    return;
  }
  frameHandle = requestAnimationFrame(frame);
  if (reducedMotion?.matches) return;
  targets.forEach((target) => {
    const rect = target.root.getBoundingClientRect();
    if (!rect.width) return;
    const dx = pointerX - (rect.left + rect.width / 2);
    const dy = pointerY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const range = rect.width * 0.075 * 0.88;
    const lerp = target.root.dataset.state === "focus" ? 0.24 : 0.15;
    const force = Math.min(1, distance / 420);
    target.ox += (dx / distance * range * force - target.ox) * lerp;
    target.oy += (dy / distance * range * force - target.oy) * lerp;
    target.eyes.style.transform = "translate(" + (target.ox / rect.width * 100).toFixed(2) + "%," + (target.oy / rect.height * 100).toFixed(2) + "%)";

    const window_ = BLINK_WINDOW[target.root.dataset.state || ""];
    if (window_ && time > target.nextBlink) {
      target.blinkAt = time;
      target.double = Boolean(window_.double);
      target.nextBlink = time + window_.min + Math.random() * (window_.max - window_.min);
    }
    let k = 1;
    const p = (time - target.blinkAt) / 220;
    if (p >= 0 && p < 1) k = blinkShape(p);
    if (target.double) {
      const p2 = (time - target.blinkAt - 200) / 220;
      if (p2 >= 0 && p2 < 1) k = Math.min(k, blinkShape(p2));
    }
    for (const bar of target.bars) bar.style.transform = "scaleY(" + k.toFixed(3) + ")";
  });
};

const syncLoop = () => {
  if (targets.size) {
    if (!pointerBound) {
      window.addEventListener("pointermove", trackPointer, { passive: true });
      pointerBound = true;
    }
    if (!settleBound) {
      reducedMotion?.addEventListener("change", () => { if (reducedMotion.matches) targets.forEach(restTarget); });
      settleBound = true;
    }
    if (!frameHandle) frameHandle = requestAnimationFrame(frame);
    return;
  }
  if (pointerBound) {
    window.removeEventListener("pointermove", trackPointer);
    pointerBound = false;
  }
  if (frameHandle) {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
};

const registerFollow = (root: HTMLElement, eyes: HTMLElement) => {
  const target: FollowTarget = {
    root,
    eyes,
    bars: Array.from(eyes.querySelectorAll<HTMLElement>(".beat-av-eye")),
    ox: 0,
    oy: 0,
    blinkAt: -1e9,
    double: false,
    nextBlink: performance.now() + 1600 + Math.random() * 3000,
  };
  targets.add(target);
  syncLoop();
  return () => {
    targets.delete(target);
    syncLoop();
  };
};

export const BeatAvatar = ({
  state = "idle",
  size = 28,
  theme,
  glow = 1,
  progress = 0.5,
  followPointer = true,
  className,
}: BeatAvatarProps) => {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const detected = useNearestTheme(rootRef);
  const eyesRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const eyes = eyesRef.current;
    if (!followPointer || !root || !eyes) return;
    return registerFollow(root, eyes);
  }, [followPointer]);

  /* 片段的 28 / 40 / 64 三档光半径；20px 这种更小的值并进 28 档，否则小图标会糊成一团 */
  const sizeBucket = size <= 28 ? 28 : size <= 40 ? 40 : 64;
  const clamped = Math.min(1, Math.max(0, Number(progress) || 0));

  return (
    <span
      aria-hidden="true"
      className={className ? "beat-av " + className : "beat-av"}
      data-size={sizeBucket}
      data-state={state}
      data-theme={theme || detected}
      ref={rootRef}
      style={{ width: size, height: size, "--glow": glow, "--beat-progress": clamped.toFixed(3) } as CSSProperties}
    >
      <span className="beat-av-face" />
      <span className="beat-av-eyes" ref={eyesRef}>
        <span className="beat-av-group">
          <i className="beat-av-eye" />
          <i className="beat-av-eye" />
        </span>
      </span>
    </span>
  );
};
