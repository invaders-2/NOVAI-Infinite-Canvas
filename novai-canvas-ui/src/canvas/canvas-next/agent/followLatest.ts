/**
 * 助手面板「跟随最新回答」：发出消息后立刻贴底，助手的回答（文字、思考、方案卡、问答卡…）长出来时继续贴底跟随。
 *   · 用户这期间主动往上滚（滚轮 / 触摸 / PageUp / ↑ / Home；只认用户操作，不看程序滚动），就停止跟随，
 *     之后即使助手回答完也不会把视野拽回底部；点「回到最新」恢复贴底跟随；
 *   · 只依赖 DOM：.ap2-viewport（滚动容器）、.ap2-content（内容）、[data-msg-id]（每条消息）。
 *
 * 这里现在是唯一的跟随滚动驱动：provider 的 autoScroll 会和它抢同一个 scrollTop（见 AgentPanel 里的 autoScroll={false}）。
 */
import { useEffect, useRef } from "react";

type Msg = { id: string; role: string };

export function useFollowLatest(rootRef: { current: HTMLElement | null }, msgs: readonly Msg[], threadId?: string | null) {
  const follow = useRef(false);
  /** 新回答停开头（默认）还是贴底（用户点过「回到最新」）：两种期望不能同时满足，按最近一次意图来 */
  const sticky = useRef<"top" | "bottom">("top");
  const lastUser = useRef("");
  const firstLoad = useRef(false);           // 首次 / 换对话：先把历史滚到最新
  const userScrolled = useRef(false);        // 用户自己滚过：别再替他把视野拽回去
  const thread = useRef(threadId || "");
  const empty = msgs.length === 0;

  const viewport = () => rootRef.current?.querySelector<HTMLElement>(".ap2-viewport") || null;

  // 换对话：允许再滚一次到底（新对话本来就没历史，滚了也没副作用）
  useEffect(() => {
    if ((threadId || "") === thread.current) return;
    thread.current = threadId || "";
    firstLoad.current = false; userScrolled.current = false;
  }, [threadId]);

  // 打开面板 / 载入历史：滚到最新（provider 不再自动做这件事）。
  // 历史是逐条渲染出来的（图片、代码块会继续把高度顶大），只滚一帧会停在半路，所以在布局稳定前一直贴底。
  useEffect(() => {
    if (empty || firstLoad.current) return;
    const vp = viewport();
    const content = rootRef.current?.querySelector<HTMLElement>(".ap2-content");
    if (!vp || !content) return;
    firstLoad.current = true;
    let alive = true;
    const stick = () => { if (alive && !follow.current && !userScrolled.current) vp.scrollTop = vp.scrollHeight; };
    stick();
    const ro = new ResizeObserver(stick); ro.observe(content);
    const started = performance.now();
    const timer = window.setInterval(() => { if (performance.now() - started > 2500) cleanup(); else stick(); }, 80);
    function cleanup() { alive = false; ro.disconnect(); window.clearInterval(timer); }
    return cleanup;
  }, [empty, threadId]);

  // 手动发送（队列自动发送不发 cn:agent-send）：立刻贴底并恢复跟随。
  // 之后如果用户上滚看历史，就停止跟随；助手回答完也不再自动回到底部。
  const lastU = [...msgs].reverse().find((m) => m.role === "u")?.id || "";
  useEffect(() => {
    if (!lastU || lastU === lastUser.current) { lastUser.current = lastU; return; }
    lastUser.current = lastU;
  }, [lastU]);

  useEffect(() => {
    const onSent = () => {
      follow.current = true; sticky.current = "bottom"; userScrolled.current = false;
      requestAnimationFrame(() => { const vp = viewport(); if (vp) toBottom(vp); });
    };
    window.addEventListener("cn:agent-send", onSent);
    return () => window.removeEventListener("cn:agent-send", onSent);
  }, []);

  /** 贴底跟随走平滑滚动：流式每 750ms 长一截，直接写 scrollTop 是一次 100~300px 的硬跳，看起来就是一抽 */
  const toBottom = (vp: HTMLElement) => {
    if (vp.scrollHeight - vp.scrollTop - vp.clientHeight <= 2) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { vp.scrollTop = vp.scrollHeight; return; }
    vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  };
  const bring = () => {
    const vp = viewport(); if (!vp || !follow.current) return;
    if (sticky.current === "bottom") { toBottom(vp); return; }
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-msg-id]") || [])];
    const last = items[items.length - 1]; if (!last) return;
    if (last.getBoundingClientRect().height <= vp.clientHeight - 24) { toBottom(vp); return; }
    // 回答比一屏高：停止跟随，不做任何跳动（流式每 750ms 长一截，跟着滚就会上下抽动）
    follow.current = false;
  };

  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    const vp = viewport();
    const content = root.querySelector<HTMLElement>(".ap2-content");
    if (!vp || !content) return;
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) { follow.current = false; userScrolled.current = true; } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") { follow.current = false; userScrolled.current = true; } };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY || 0; };
    const onTouchMove = (e: TouchEvent) => { if ((e.touches[0]?.clientY || 0) > touchY + 4) { follow.current = false; userScrolled.current = true; } };
    // 「回到最新」按钮：恢复跟随，并且这次要贴底（不是再把长回答的开头拽回顶部）
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".ap2-jump")) return;
      follow.current = true; sticky.current = "bottom"; userScrolled.current = false;
      requestAnimationFrame(() => bring());
    };
    const ro = new ResizeObserver(() => { if (follow.current) bring(); });
    ro.observe(content);
    const mo = new MutationObserver(() => { if (follow.current) requestAnimationFrame(bring); });
    mo.observe(content, { childList: true, subtree: true });
    vp.addEventListener("wheel", onWheel, { passive: true });
    vp.addEventListener("keydown", onKey);
    vp.addEventListener("touchstart", onTouchStart, { passive: true });
    vp.addEventListener("touchmove", onTouchMove, { passive: true });
    root.addEventListener("click", onClick);
    return () => { ro.disconnect(); mo.disconnect(); vp.removeEventListener("wheel", onWheel); vp.removeEventListener("keydown", onKey); vp.removeEventListener("touchstart", onTouchStart); vp.removeEventListener("touchmove", onTouchMove); root.removeEventListener("click", onClick); };
  }, [rootRef.current]);
}
