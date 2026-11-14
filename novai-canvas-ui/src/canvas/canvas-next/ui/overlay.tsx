/**
 * 弹层 / 对话框：全局只有一个弹层和一个对话框（与预览一致）。
 * openPop(anchor, render, dir, align) —— anchor 是元素或屏幕坐标；render 拿到 close。
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "./Icon";
import { placePopover, type PopRect } from "./placement";

type PopState = { key: number; anchor: Element | { x: number; y: number }; /** 打开时的锚点矩形：锚点被二级弹层顶掉后用它定位 */ rect?: PopRect; render: (close: () => void) => ReactNode; dir: "down" | "up" | "right"; align: "left" | "right"; cls?: string; agent?: boolean; closing?: boolean } | null;
type ModalState = { key: number; render: (close: () => void) => ReactNode; cls?: string; closing?: boolean } | null;

let pop: PopState = null, modalSt: ModalState = null, seq = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());
const sub = (l: () => void) => { ls.add(l); return () => { ls.delete(l); }; };

export function openPop(anchor: Element | { x: number; y: number }, render: (close: () => void) => ReactNode, dir: "down" | "up" | "right" = "down", align: "left" | "right" = "left", cls?: string) {
  // 二级弹层的锚点是上一个 #pop 自己：父弹层属于助手时，二级也要按助手区摆，否则会飘到面板标题栏上
  const agent = (anchor instanceof Element && !!anchor.closest("#agent")) || (anchor instanceof Element && !!anchor.closest("#pop") && !!pop?.agent);
  // 弹层只有一个实例：二级弹层（右键「添加辅助工具」、节点「替换」）会顶掉父菜单，锚点随之从文档里卸载。
  // 锚点还在时先把矩形量下来，卸载后用它定位，否则 0×0 会把二级弹窗摆到左上角。
  const rect = anchor instanceof Element ? (() => { const r = anchor.getBoundingClientRect(); return r.width || r.height ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined; })() : undefined;
  pop = { key: ++seq, anchor, rect, render, dir, align, cls: (cls ? cls + " " : "") + (agent ? "agent-pop" : ""), agent };
  syncOverlayBlur(); emit();
}
function syncOverlayBlur() {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("agent-layer-open", !!pop || !!modalSt);
}
export function closePop() {
  if (!pop || pop.closing) return; const k = pop.key;
  // combo-pop 的关闭动画是 180ms（comboOut），比默认的 120ms popOut 长，多等一会儿再卸载，别把尾巴截掉
  const combo = /(^| )combo-pop( |$)/.test(pop.cls || "");
  pop = { ...pop, closing: true }; emit();
  setTimeout(() => { if (pop && pop.key === k) { pop = null; syncOverlayBlur(); emit(); } }, combo ? 200 : 130);
}
export const popOpen = () => !!pop && !pop.closing;
export function openModal(render: (close: () => void) => ReactNode, cls?: string) { modalSt = { key: ++seq, render, cls }; syncOverlayBlur(); emit(); }
export function closeModal() {
  if (!modalSt || modalSt.closing) return; const k = modalSt.key; modalSt = { ...modalSt, closing: true }; emit();
  setTimeout(() => { if (modalSt && modalSt.key === k) { modalSt = null; syncOverlayBlur(); emit(); } }, 170);
}
export const modalOpen = () => !!modalSt && !modalSt.closing;

export function OverlayHost() {
  const p = useSyncExternalStore(sub, () => pop);
  const m = useSyncExternalStore(sub, () => modalSt);
  return <>{p ? <Popover key={p.key} st={p} /> : null}{m ? <ModalView key={m.key} st={m} /> : null}</>;
}

function Popover({ st }: { st: NonNullable<PopState> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; origin: string; menu: boolean; maxWidth: number; maxHeight: number; scrollX: boolean; scrollY: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      // 量「内容自然高度」：内联 maxHeight 是上一轮按旧内容算的，不清掉就会把弹层永久锁在初始高度，
      // 列表长了只能滚动整个弹层（连搜索框一起走），看着像错位、也看不到底下的模型
      // 量自然尺寸时必须把上一轮的 maxHeight / maxWidth 一起清掉：只清高度的话，宽度会在「被限宽」和
      // 「自然宽度」之间来回量，ResizeObserver 每帧改一次 maxWidth，弹层就会一直抖（并且可能超出面板）
      const prevMax = el.style.maxHeight; const prevW = el.style.maxWidth;
      el.style.maxHeight = "none"; el.style.maxWidth = "none";
      const pr = el.getBoundingClientRect();
      el.style.maxHeight = prevMax; el.style.maxWidth = prevW;
      // 助手里的弹层只允许落在消息区内：以前按整个窗口算，模型/分辨率菜单会盖到面板标题栏和卡片标题上，看着像错位。
      const host = st.agent ? document.querySelector<HTMLElement>("#agent .ap2-viewport") : null;
      const hr = host?.getBoundingClientRect();
      const bounds = hr && hr.width > 2 && hr.height > 2 ? hr : null;
      const toLocal = (r: { x: number; y: number; width: number; height: number }) => bounds ? { x: r.x - bounds.x, y: r.y - bounds.y, width: r.width, height: r.height } : r;
      const anchor: PopRect = st.anchor instanceof Element
        ? (() => {
          const r = st.anchor.getBoundingClientRect();
          // 锚点还在文档里且量得到尺寸就跟着实时走（窗口缩放 / 滚动）；否则用打开时的快照
          if (st.anchor.isConnected && (r.width || r.height)) return toLocal({ x: r.left, y: r.top, width: r.width, height: r.height });
          return toLocal(st.rect ?? { x: r.left, y: r.top, width: r.width, height: r.height });
        })()
        : { x: st.anchor.x, y: st.anchor.y, width: 0, height: 0 };
      const placed = placePopover({
        anchor, popup: { x: 0, y: 0, width: pr.width, height: pr.height }, viewport: bounds ? { width: bounds.width, height: bounds.height } : { width: innerWidth, height: innerHeight }, dir: st.dir, align: st.align, margin: 8, gap: 8,
        // 助手里的卡片弹层（模型/参数/组合）：高度收到 min(420px, 55vh)，翻边按收小后的高度算，少挡卡片正文
        capHeight: st.agent ? Math.min(420, innerHeight * 0.55, (bounds ? bounds.height : innerHeight) - 16) : undefined,
      });
      const next = { x: placed.x + (bounds ? bounds.x : 0), y: placed.y + (bounds ? bounds.y : 0), origin: placed.origin, menu: placed.menu, maxWidth: placed.maxWidth, maxHeight: placed.maxHeight, scrollX: placed.scrollX, scrollY: placed.scrollY };
      // 子菜单（combobox）首帧的行高常比定稿矮几像素，只有位置真的变了才重排，避免无谓 re-render
      setPos((cur) => (cur && cur.x === next.x && cur.y === next.y && cur.menu === next.menu && cur.maxHeight === next.maxHeight && cur.maxWidth === next.maxWidth && cur.scrollY === next.scrollY && cur.scrollX === next.scrollX ? cur : next));
    };
    // 内容可以在打开之后才变高（二级视图切换、combobox 列表定稿），跟着自身尺寸再量一次
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    // 内容在头几帧才定高（字体/换行/弹性布局），再补量两次，免得弹层尾巴压出视口
    const settle = window.setTimeout(measure, 260);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); cancelAnimationFrame(frame); window.clearTimeout(settle); window.removeEventListener("resize", measure); };
  }, [st]);
  // 弹层外按下关闭（按在锚点上交给锚点自己的 onClick 切换）
  useLayoutEffect(() => {
    if (st.closing) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as Element).closest?.(".model-flyout")) return;
      // 选择面板（@ 提及 / 斜杠）是「跟着输入框里的触发字符活的」：点到锚点范围内的空白也要收掉，
      // 否则面板会一直挂在输入区上方，等一个用户并不想做的选择
      const palette = /(^| )palette( |$)/.test(st.cls || "");
      if (!palette && st.anchor instanceof Element && st.anchor.contains(t)) return;
      closePop();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); } };
    document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [st]);
  return (
    <div id="pop" ref={ref} className={(st.closing ? "closing" : "") + (pos?.menu ? " menu" : "") + (st.cls ? " " + st.cls : "")}
      style={{
        left: pos?.x ?? -9999, top: pos?.y ?? -9999, transformOrigin: pos?.origin, visibility: pos ? undefined : "hidden",
        maxWidth: pos?.scrollX ? pos.maxWidth : undefined, maxHeight: pos?.scrollY ? pos.maxHeight : undefined, overflow: pos?.scrollX || pos?.scrollY ? "auto" : undefined,
      }}
      onPointerDown={(e) => e.stopPropagation()}>
      {st.render(closePop)}
    </div>
  );
}

function ModalView({ st }: { st: NonNullable<ModalState> }) {
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || pop) return;
      // 带 data-esc-clear 的输入框：有内容时 Esc 先清空（由输入框自己处理），再按一次才关闭
      const t = e.target as HTMLInputElement | null; if (t && t.dataset && "escClear" in t.dataset && t.value) return;
      e.stopPropagation(); closeModal();
    };
    document.addEventListener("keydown", onKey, true); return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    /* 弹层类型同时挂在背景层上：模板面板要靠 .modal-bg.tpl-panel 首帧就拿到 absolute / padding:0，不依赖 :has() */
    <div className={"modal-bg" + (st.cls ? " " + st.cls : "") + (st.closing ? " closing" : "")} id="modal" onPointerDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className={"modal " + (st.cls || "")} role="dialog">{st.render(closeModal)}</div>
    </div>
  );
}

export function ModalHead({ title, icon, extra }: { title: ReactNode; icon?: Parameters<typeof Icon>[0]["name"]; extra?: ReactNode }) {
  return <div className="mhd">{icon ? <Icon name={icon} size="s" /> : null}{title}<span className="sp" />{extra}<button className="ib" onClick={closeModal} aria-label="关闭"><Icon name="x" /></button></div>;
}