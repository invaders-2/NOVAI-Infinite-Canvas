/**
 * 助手面板「跟随最新回答」：发出消息后，助手的回答（文字、思考、方案卡、问答卡…）一长出来就滚进视野。
 *   · 回答没超过一屏：贴底显示；超过一屏：把回答的开头停在顶部（先看开头，不跳到末尾）；
 *   · 用户这期间主动往上滚（滚轮 / 触摸 / PageUp / ↑ / Home；只认用户操作，不看程序滚动），就停止跟随，不打扰看历史；点「回到最新」恢复；
 *   · 只依赖 DOM：.ap2-viewport（滚动容器）、.ap2-content（内容）、[data-msg-id]（每条消息）。
 */
import { useEffect, useRef } from "react";

type Msg = { id: string; role: string };

export function useFollowLatest(rootRef: { current: HTMLElement | null }, msgs: readonly Msg[]) {
  const follow = useRef(false);
  const lastUser = useRef("");
  const pinned = useRef("");                 // 已经把这条回答的开头停在顶部了（之后不再跳动）

  // 新的用户消息出现 = 刚发送：进入跟随
  const lastU = [...msgs].reverse().find((m) => m.role === "u")?.id || "";
  useEffect(() => {
    if (!lastU || lastU === lastUser.current) { lastUser.current = lastU; return; }
    const first = !lastUser.current; lastUser.current = lastU;
    if (first) return;                          // 刚打开面板还原历史，不算发送
    follow.current = true; pinned.current = "";
    requestAnimationFrame(() => bring());
  }, [lastU]);

  const bring = () => {
    const root = rootRef.current; if (!root || !follow.current) return;
    const vp = root.querySelector<HTMLElement>(".ap2-viewport"); if (!vp) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-msg-id]")];
    const last = items[items.length - 1]; if (!last) return;
    const vr = vp.getBoundingClientRect(); const lr = last.getBoundingClientRect();
    if (lr.height <= vp.clientHeight - 24) { vp.scrollTop = vp.scrollHeight; return; }
    // 回答比一屏高：开头停在顶部一次，之后让用户自己往下读
    const id = last.getAttribute("data-msg-id") || "";
    if (pinned.current === id) return;
    pinned.current = id;
    vp.scrollTop += lr.top - vr.top - 8;
  };

  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    const vp = root.querySelector<HTMLElement>(".ap2-viewport");
    const content = root.querySelector<HTMLElement>(".ap2-content");
    if (!vp || !content) return;
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) follow.current = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") follow.current = false; };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY || 0; };
    const onTouchMove = (e: TouchEvent) => { if ((e.touches[0]?.clientY || 0) > touchY + 4) follow.current = false; };
    // 「回到最新」按钮：恢复跟随
    const onClick = (e: MouseEvent) => { if ((e.target as Element | null)?.closest?.(".ap2-jump")) { follow.current = true; pinned.current = ""; } };
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
