/**
 * 二级子菜单的 combobox 交互（§ animate-ui combobox）：
 * Base UI 负责过滤 / ↑↓ / Enter / Esc / aria / 高亮，这里只管外观、错峰入场、滑动高亮与键盘衔接。
 * 面板本身的定位和开合交给调用方（#pop 的 combo-pop、模型 flyout 的 combo-flyout 各自管动画）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Icon } from "./Icon";

const ITEM_EASE = "cubic-bezier(0.215,0.61,0.355,1)";
const ITEM_IN_MS = 300;
const ITEM_STAGGER_MS = 33;
const ITEM_STAGGER_BASE = 10;

export const prefersReduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const reduced = prefersReduced;

/* Base UI 1.9 的 Root 类型没声明 keepHighlight（运行时照传），这里只放宽这一层 */
const ComboboxRoot = Combobox.Root as unknown as (props: Record<string, unknown>) => JSX.Element;

export interface ComboMenuProps<T> {
  items: readonly T[];
  label: (item: T) => string;
  value?: (item: T) => string;
  filterText?: (item: T) => string;
  itemClassName?: string | ((item: T) => string);
  itemAttrs?: (item: T) => Record<string, string>;
  renderItem: (item: T) => ReactNode;
  onPick: (item: T) => void;
  /** 长列表（模型/技能）显示搜索框；短动作菜单不显示，但仍渲染一个视觉隐藏的输入框承接键盘 */
  searchable?: boolean;
  searchPlaceholder?: string;
  searchLabel?: string;
  empty?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  /** 换供应商/换数据时重置搜索词并重跑一次错峰入场 */
  resetKey?: string;
  /** 焦点在面板外时，↑/↓ 先把焦点收进搜索框（hover 打开也不抢焦点） */
  focusRescue?: boolean;
  /** 需要自己处理 Esc（比如只关二级 flyout）时传；内部用 window 捕获，抢在 #pop 之前 */
  onEscape?: () => void;
}

export function ComboMenu<T>({
  items,
  label,
  value,
  filterText,
  itemClassName,
  itemAttrs,
  renderItem,
  onPick,
  searchable,
  searchPlaceholder,
  searchLabel,
  empty,
  header,
  footer,
  className,
  style,
  autoFocus,
  resetKey,
  focusRescue,
  onEscape,
}: ComboMenuProps<T>) {
  const valueOf = (item: T) => (value ? value(item) : label(item));
  const [query, setQuery] = useState("");
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const staggeredRef = useRef(false);

  useEffect(() => {
    staggeredRef.current = false;
    setQuery("");
  }, [resetKey]);

  /* 只在「这一批列表第一次出现」时错峰：过滤、翻页都不再逐项动画 */
  useEffect(() => {
    if (items.length === 0 || staggeredRef.current) return;
    const frame = requestAnimationFrame(() => {
      const node = nodeRef.current;
      if (!node || staggeredRef.current) return;
      const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-combo-item], .combo-foot button"));
      if (!rows.length) return;
      staggeredRef.current = true;
      if (reduced()) return;
      const raw = rows.length <= ITEM_STAGGER_BASE ? ITEM_STAGGER_MS : ITEM_STAGGER_MS * Math.sqrt(ITEM_STAGGER_BASE / rows.length);
      rows.forEach((row, i) => {
        row.animate(
          [
            { opacity: 0, transform: "translate3d(8px,0,0)", filter: "blur(4px)" },
            { opacity: 1, transform: "translate3d(0,0,0)", filter: "blur(0px)" },
          ],
          { duration: ITEM_IN_MS, delay: i * raw, easing: ITEM_EASE, fill: "backwards" },
        );
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [items.length, resetKey]);

  /* #pop 首帧是 visibility:hidden（等量完位置才显示），那时 focus() 会被浏览器丢掉：
     逐帧重试几次，等它真的可见再落焦；已经有人把焦点放进面板里就不抢 */
  useLayoutEffect(() => {
    if (!autoFocus) return;
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const el = inputRef.current;
      if (!el) return;
      const node = nodeRef.current;
      const at = document.activeElement;
      if (at && at !== el && node && node.contains(at)) return;
      el.focus();
      tries += 1;
      if (document.activeElement !== el && tries < 5) raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, resetKey]);

  /* 滑动高亮面：只跟 Base UI 的 data-highlighted 走，指针离开列表时 retain（keepHighlight） */
  useLayoutEffect(() => {
    const node = nodeRef.current;
    const scroller = scrollRef.current;
    if (!node || !scroller) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const active = node.querySelector<HTMLElement>("[data-highlighted]");
      if (!active) {
        setBox((cur) => (cur ? null : cur));
        return;
      }
      const rect = active.getBoundingClientRect();
      const base = scroller.getBoundingClientRect();
      // 高亮面比行内缩：左右各 6px（CSS 里 .combo-hl 的 left/right），上下各 3px
      const top = rect.top - base.top + scroller.scrollTop + 3;
      const h = Math.max(0, rect.height - 6);
      setBox((cur) => (cur && Math.abs(cur.top - top) < 0.5 && Math.abs(cur.height - h) < 0.5 ? cur : { top, height: h }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(node, { attributes: true, attributeFilter: ["data-highlighted"], subtree: true });
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!focusRescue) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const node = nodeRef.current;
      const input = inputRef.current;
      if (!node || !input || node.contains(document.activeElement)) return;
      e.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [focusRescue]);

  useEffect(() => {
    if (!onEscape) return;
    /* window 捕获：抢在 #pop 自己的 document 捕获之前，Esc 先只关二级 */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape]);

  const matches = (item: T, q: string) => ((filterText ?? label)(item) || "").toLowerCase().includes(q.trim().toLowerCase());

  return (
    <ComboboxRoot
      filter={searchable ? matches : null}
      highlightItemOnHover
      inline
      inputValue={query}
      itemToStringLabel={label}
      itemToStringValue={(item: T) => valueOf(item)}
      items={items}
      keepHighlight
      onInputValueChange={(next: string) => setQuery(next)}
      open
    >
      <div className={"combo" + (className ? " " + className : "")} data-combo="" ref={nodeRef} style={style}>
        {header}
        {searchable ? (
          <label className="combo-s">
            <Icon name="search" size="s" />
            <Combobox.Input aria-label={searchLabel || searchPlaceholder || "搜索"} autoComplete="off" className="combo-in" placeholder={searchPlaceholder} ref={inputRef} />
          </label>
        ) : (
          <Combobox.Input aria-label={searchLabel || "菜单选项"} autoComplete="off" className="combo-in combo-in-hidden" ref={inputRef} />
        )}
        <div className="combo-scroll" ref={scrollRef}>
          <div className="combo-hl" data-shown={box ? "true" : "false"} style={box ? { height: box.height, transform: "translate3d(0," + box.top + "px,0)" } : undefined} />
          <Combobox.Empty className="combo-empty">{empty}</Combobox.Empty>
          <Combobox.List className="combo-list">
            <Combobox.Collection>
              {(item: T) => (
                <Combobox.Item
                  {...(itemAttrs ? itemAttrs(item) : {})}
                  aria-label={label(item)}
                  className={(typeof itemClassName === "function" ? itemClassName(item) : itemClassName) || "combo-item"}
                  data-combo-item=""
                  key={valueOf(item)}
                  onClick={() => onPick(item)}
                  value={valueOf(item)}
                >
                  {renderItem(item)}
                </Combobox.Item>
              )}
            </Combobox.Collection>
          </Combobox.List>
        </div>
        {footer ? <div className="combo-foot">{footer}</div> : null}
      </div>
    </ComboboxRoot>
  );
}
