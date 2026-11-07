/**
 * 画布右下角悬浮球的表情：把「助手在干什么」和「用户正在干什么」合成一个头像状态。
 *
 * 助手那一半由 AgentPanel 里的 useBeatActivity 发布上来（那个 hook 已经拿得到 AgentState(a)，
 * 这里不新建第二个 AgentState——两套实例会各自拉线程 / 各自算一次性 pulse，表情会对不上）。
 * 用户那一半自己监听：画布上的按下 / 拖动 / 抬手、选中的节点、悬停球、点球、20s 无操作。
 *
 * 优先级（从上到下，和面板那套「谁更该被看见」的判断一致）：
 *   error                    助手报错 / 任务 FAILED。一次性 1.4s 由 AgentPanel 那边的 pulse 管，
 *                            这里只透传、不重复计时（两个 1.4s 会互相盖住）
 *   waiting                  助手停下来等人（问答卡未答 / WAITING / 方案待执行）
 *   generating / tool / thinking   助手在生成 / 调工具 / 想：球上看得到"它在干活"
 *   focus                    正在拖画布（平移 / 框选 / 拖节点）或画布上有选中节点 → 视线跟手
 *   listening                鼠标停在球上
 *   happy                    点了球（面板马上打开、球卸载；只有面板又被关回来的剩余时间里看得到）
 *   sleepy                   20s 没有任何操作
 *   idle                     其它
 *
 * 一次性状态可被打断。prefers-reduced-motion 下的静态化由 BeatAvatar 的 CSS 负责，
 * 这里不额外驱动任何动画（除了状态本身的计时）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BeatState } from "./BeatAvatar";

/** 20s 没有任何操作就转「困倦」 */
const IDLE_SLEEP_MS = 20000;
/** 点球后 happy 亮多久（和面板 success 的 1.2s 同一档） */
const TAP_HOLD_MS = 1200;
/** 按下后移动超过这么多像素才算「拖拽」，避免点一下就被判成 focus */
const DRAG_SLOP = 4;
/** 球上只认这三档助手活动；listening / happy / idle 由球自己的用户信号决定 */
const AGENT_BUSY = new Set<BeatState>(["generating", "tool", "thinking"]);

/* ── 助手活动：AgentPanel 发布、球订阅 ──────────────────────────────
   用版本号当快照：订阅方只要「变了就重渲染」，值本身在 render 时直接读。 */
let agentBeat: { state: BeatState; progress: number } = { state: "idle", progress: 0.5 };
let agentBeatVersion = 0;
const agentBeatListeners = new Set<() => void>();

/** 面板每算出一次头像状态就调用；state / progress 都没变时什么都不做（不触发球重渲染） */
export function publishAgentBeat(state: BeatState, progress = 0.5) {
  if (agentBeat.state === state && agentBeat.progress === progress) return;
  agentBeat = { state, progress };
  agentBeatVersion += 1;
  agentBeatListeners.forEach((listener) => listener());
}

const subscribeAgentBeat = (listener: () => void) => {
  agentBeatListeners.add(listener);
  return () => { agentBeatListeners.delete(listener); };
};
const readAgentBeatVersion = () => agentBeatVersion;

export interface OrbActivity {
  state: BeatState;
  /** 只有 generating 会读它 */
  progress: number;
  /** 鼠标进出球（顺便把「无操作」计时归零） */
  hover: (on: boolean) => void;
  /** 点球：闪一下 happy；打开面板由调用方负责 */
  tap: () => void;
}

/** selected：画布上选中的节点数（store.state.ui.sel.size） */
export const useOrbActivity = (selected: number): OrbActivity => {
  useSyncExternalStore(subscribeAgentBeat, readAgentBeatVersion, readAgentBeatVersion);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dozing, setDozing] = useState(false);
  const [tapUntil, setTapUntil] = useState(0);
  const lastActive = useRef(Date.now());
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  /* 任何操作都把「20s 没动」归零。pointermove 只改 ref、只在真的醒来时才 setState，
     画布每帧都在派发 move，不能每次移动都重渲染一遍浮层 */
  const touch = useCallback(() => {
    lastActive.current = Date.now();
    setDozing((current) => (current ? false : current));
  }, []);

  useEffect(() => {
    const stage = document.getElementById("stage");
    if (!stage) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("#orb, #orbTip")) return; // 点球 / 点气泡不算画布操作
      touch();
      press.current = { x: event.clientX, y: event.clientY, moved: false };
    };
    const onMove = (event: PointerEvent) => {
      touch();
      const start = press.current;
      if (!start || start.moved) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= DRAG_SLOP) return;
      start.moved = true;
      setDragging(true);
    };
    const onUp = () => { touch(); press.current = null; setDragging(false); };
    stage.addEventListener("pointerdown", onDown, true);
    // 拖动中指针会跑出画布容器，所以 move / up 挂在 window 上
    addEventListener("pointermove", onMove, { passive: true });
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onUp, true);
    addEventListener("wheel", touch, { passive: true });
    addEventListener("keydown", touch);
    return () => {
      stage.removeEventListener("pointerdown", onDown, true);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp, true);
      removeEventListener("pointercancel", onUp, true);
      removeEventListener("wheel", touch);
      removeEventListener("keydown", touch);
    };
  }, [touch]);

  /* 秒级轮询比「每次移动都重排一个 20s 定时器」便宜，而且只在真的变困时才 setState */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const idle = Date.now() - lastActive.current >= IDLE_SLEEP_MS;
      setDozing((current) => (current === idle ? current : idle));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  /* 助手在动也算「有活动」：别让它在生成中途睡过去 */
  const agentState = agentBeat.state;
  useEffect(() => { touch(); }, [agentState, touch]);

  useEffect(() => {
    if (!tapUntil) return;
    const left = tapUntil - Date.now();
    if (left <= 0) { setTapUntil(0); return; }
    const timer = window.setTimeout(() => setTapUntil(0), left);
    return () => window.clearTimeout(timer);
  }, [tapUntil]);

  const hover = useCallback((on: boolean) => { touch(); setHovering(on); }, [touch]);
  const tap = useCallback(() => { touch(); setTapUntil(Date.now() + TAP_HOLD_MS); }, [touch]);

  let state: BeatState;
  if (agentState === "error") state = "error";
  else if (agentState === "waiting") state = "waiting";
  else if (AGENT_BUSY.has(agentState)) state = agentState;
  else if (dragging || selected > 0) state = "focus";
  else if (hovering) state = "listening";
  else if (tapUntil > Date.now()) state = "happy";
  else if (dozing) state = "sleepy";
  else state = "idle";

  return { state, progress: agentBeat.progress, hover, tap };
};
