/**
 * 浮动工具条（Floating Dock / Native）：参照 Framer 的 Floating Dock。
 *   · 平时只有 36×36 的图标方块；指针落在哪一颗，只让那一颗的标签长出来（max-width 写实测 px 才能连续插值）
 *   · 悬停底色由条内的滑块（.cn-fm-hl）承担，按钮自己不加底色、不上浮
 *   · 整条位置永远不动，只让标签在条内长出来；按折叠宽度定位的条（#ntb）用 margin-left 补回视觉中心
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./float-menu.css";

/** 展开一颗时左右各长出来的内距（折叠态是 36×36 的方块、内距 0；展开态 padding 0 12px） */
const OPEN_PAD_X = 12;
/** 展开时标签与图标（或装饰）之间的间距：由 .is-open .cn-fm-label 的 margin-left 给，按钮本身 gap 是 0 */
const LABEL_GAP = 6;
/** 指针从按钮缝隙穿过去时会先 leave 再 over，立刻折叠会闪：留 90ms（旧实现同值） */
const COLLAPSE_DELAY = 90;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 条上有反向缩放（scale）和画布缩放，量出来的 rect 都带着它，得除回菜单自己的坐标 */
function localScale(menu: HTMLElement): number {
  let scale = 1;
  for (let node: HTMLElement | null = menu; node; node = node.parentElement) {
    const cs = getComputedStyle(node);
    const zoom = parseFloat(cs.zoom);
    if (zoom > 0) scale *= zoom;
    const transform = cs.transform;
    if (transform && transform !== "none") {
      const values = transform.slice(transform.indexOf("(") + 1, -1).split(",").map(Number);
      if (values.length >= 4) scale *= Math.hypot(values[0], values[1]) || 1;
    }
    const own = cs.scale;
    if (own && own !== "none") {
      const ownScale = Math.abs(parseFloat(own));
      if (ownScale > 0) scale *= ownScale;
    }
  }
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** max-width:0 + overflow:hidden 会把标签盒子压扁，只能量文字本身的宽（Range） */
function naturalWidth(span: HTMLElement, scale: number): number {
  try {
    const range = document.createRange();
    range.selectNodeContents(span);
    return range.getBoundingClientRect().width / scale;
  } catch { return (span.scrollWidth || 0) / scale; }
}

const labelOf = (btn: HTMLElement) => btn.querySelector<HTMLElement>(":scope > .cn-fm-label");
const buttonsOf = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .cn-fm-btn"));
/** 收起一颗：标签 max-width 归零、展开态样式摘掉（高度 / 宽度都靠过渡自己回去） */
function closeButton(btn: HTMLElement) {
  const span = labelOf(btn);
  if (span) span.style.maxWidth = "";
  btn.classList.remove("is-open");
}
/**
 * 这颗按钮还差多少才长到展开态：按「展开后的宽度 - 当前宽」算（已经展开完就是 0）。
 * 不能拿标签当前位置换算：折叠态被 36 的方块兜着、内容居中，标签可见位置比它在展开态里的排位偏右，
 * 量出来会多算半个留白。图标 / 装饰的宽不随过渡变化，所以直接拼固定部分 + 文字宽。
 */
function growthOf(btn: HTMLElement, scale: number): number {
  const span = labelOf(btn); if (!span) return 0;
  // 移动端标签 display:none：不展开、也不参与补偿
  if (getComputedStyle(span).display === "none") return 0;
  let inner = 0;
  for (const child of Array.from(btn.children)) {
    if (child === span) continue;
    const cs = getComputedStyle(child);
    inner += child.getBoundingClientRect().width / scale + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
  }
  const open = OPEN_PAD_X * 2 + inner + LABEL_GAP + naturalWidth(span, scale);
  return Math.max(0, open - btn.getBoundingClientRect().width / scale);
}

export type FloatMenuBarProps = {
  /** 是否显示整条（不传 = 一直显示；显隐交给外面，条自己不猜） */
  show?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  children: ReactNode;
  /** 透传给容器的 data-* 标记（好选中、好测） */
  data?: Record<string, string>;
  onPointerDown?: MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
  /**
   * 外部给定位的用法（#ntb / 多选条）打开「展开时保持视觉中心」的补偿：
   * 它们的 left 是按折叠宽度算的，标签长出来后要往左挪半个增量，才和旧画布那种居中向两边长一致。
   * FloatMenu（自带 left:50% + translate(-50%)）不要开这个，否则会重复补偿。
   */
  compensate?: boolean;
};

/** 只管视觉 / 动效 / 交互，**不带定位**：给已经有自己定位方案的调用方（节点工具条 #ntb）复用 */
export const FloatMenuBar = forwardRef<HTMLDivElement, FloatMenuBarProps>(function FloatMenuBar({ show = true, className, style, id, children, data, onPointerDown, onDoubleClick, compensate = false }, ref) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLSpanElement>(null);
  const inside = useRef(false);
  const collapseTimer = useRef<number | null>(null);
  const hovered = useRef<HTMLButtonElement | null>(null);
  const lastX = useRef<number | null>(null);
  /** 展开时为了保持视觉中心而下过的 margin-left 补偿（收起 / 外部重渲染后要归零） */
  const marginRef = useRef(0);
  useImperativeHandle(ref, () => menuRef.current as HTMLDivElement, []);

  const setHighlightOpacity = (value: string) => { const hl = hlRef.current; if (hl) hl.style.opacity = value; };

  /** 把滑块摆到这一颗展开后的位置：宽 = 按钮当前宽 + 它还要长出来的那截 */
  const placeHighlight = useCallback((btn: HTMLButtonElement) => {
    const menu = menuRef.current, hl = hlRef.current;
    if (!menu || !hl) return;
    if (btn.disabled) { setHighlightOpacity("0"); hovered.current = null; return; }
    const scale = localScale(menu);
    const menuRect = menu.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    hovered.current = btn;
    // 滑块和按钮同尺寸（只有指针那一颗会长），夹在条的内边距盒里：条被 max-width 截断时末尾按钮会溢出，
    // 高亮不能跟着跑出去（否则会在圆角处露头）。
    const PAD = 7, HL_H = 36;
    // 滑块块宽按展开后算，clamp 也得按展开后的总宽：只有一颗按钮的条（生成中的「停止」）展开后
    // 不会再派发 pointerover，用折叠宽度 clamp 会把这步错算永久冻在右边界上
    const grew = growthOf(btn, scale);
    const maxW = parseFloat(getComputedStyle(menu).maxWidth) || Infinity;
    const finalW = Math.min(menu.clientWidth + grew, maxW);
    const width = Math.min(Math.max(0, btnRect.width / scale + grew), Math.max(0, finalW - PAD * 2));
    const height = Math.min(HL_H, Math.max(0, menu.clientHeight - PAD * 2));
    const left = Math.min(Math.max((btnRect.left - menuRect.left) / scale, PAD), Math.max(PAD, finalW - PAD - width));
    const top = Math.min(Math.max((menu.clientHeight - height) / 2, PAD), Math.max(PAD, menu.clientHeight - PAD - height));
    hl.style.left = left + "px";
    hl.style.top = top + "px";
    hl.style.width = width + "px";
    hl.style.height = height + "px";
    hl.style.opacity = "1";
  }, []);

  /**
   * 外部给定位的用法（#ntb）left 是按折叠宽度算的：展开某颗时往左挪半个增量，视觉中心才停在原地。
   * 用 margin-left 而不是 translate，避免和 .cn-fm-anchored 的 translate / 内联 scale 互相覆盖；
   * margin-left 也带同一条过渡曲线，展开过程中中心一直是稳的。
   */
  const compensateFor = useCallback((before: DOMRect, scale: number, grown: number) => {
    const menu = menuRef.current;
    if (!menu || !compensate || grown <= 0) return;
    const visual = scale > 0 ? scale : 1;
    const parentW = menu.parentElement?.clientWidth || window.innerWidth;
    const maxW = parseFloat(getComputedStyle(menu).maxWidth) || Infinity;
    // 展开后的宽度会被 max-width 截住（12 个标签的天然宽度比上限略大）：按截断后的宽度算补偿，
    // 否则会多挪「被截掉的那一半」，中心差几像素
    const widened = Math.min(before.width / visual + grown, maxW) - before.width / visual;
    let margin = -widened / 2;
    // 补偿后整条不能出视口：宁可略微偏离中心，也不能跑出画布
    const leftLimit = (8 - before.left) / visual;
    const rightLimit = (parentW - 8 - before.left) / visual - (before.width / visual + widened);
    margin = leftLimit > rightLimit ? leftLimit : Math.min(Math.max(margin, leftLimit), rightLimit);
    menu.style.marginLeft = margin + "px";
    marginRef.current = margin;
  }, [compensate]);

  /** 只展开指针所在那一颗（整条一起展开是旧行为，会把 dock 撑成一排文字） */
  const openButton = useCallback((btn: HTMLButtonElement) => {
    const menu = menuRef.current;
    if (!menu || btn === hovered.current) return;
    const scale = localScale(menu);
    // 折叠态几何要在改 DOM 之前量：写 max-width / 加 is-open 之后，getBoundingClientRect 拿到的是过渡起点
    const before = menu.getBoundingClientRect();
    const grew = growthOf(btn, scale);
    const span = labelOf(btn);
    const width = span ? naturalWidth(span, scale) : 0;
    const prev = hovered.current;
    if (prev) closeButton(prev);
    hovered.current = btn;
    btn.classList.add("is-open");
    if (span && width > 0) span.style.maxWidth = width + "px";
    compensateFor(before, scale, grew);
  }, [compensateFor]);

  const collapse = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    for (const btn of buttonsOf(menu)) closeButton(btn);
    if (marginRef.current) { menu.style.marginLeft = ""; marginRef.current = 0; }
    hovered.current = null;
    setHighlightOpacity("0");
  }, []);

  // 外部重新渲染（平移 / 缩放 / 换选中）时，定位方会按「当前宽度」重算 left，这时补偿必须归零，
  // 否则会和新的 left 叠成双重偏移。子层 layout effect 先于父层跑，所以父层量到的是归零后的位置。
  useLayoutEffect(() => {
    if (!marginRef.current) return;
    const menu = menuRef.current;
    if (menu) menu.style.marginLeft = "";
    marginRef.current = 0;
  });

  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  // show 变 false（取消选中 / 开始拖动）时立刻收起，别等指针事件
  useEffect(() => { if (!show) { inside.current = false; if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; } collapse(); } }, [show, collapse]);

  /** 指针落在按钮间隙 / 内边距上时滑块不亮（旧实现专门修过「凭空灰块」）；标签留着，横扫一排时不会来回抖 */
  const syncAt = (clientX: number | null) => {
    const menu = menuRef.current;
    if (!menu || !inside.current) return;
    if (clientX !== null) lastX.current = clientX;
    const x = lastX.current;
    if (x === null) return;
    const hit = buttonsOf(menu).find((btn) => { const r = btn.getBoundingClientRect(); return x >= r.left && x <= r.right; }) || null;
    if (!hit) { setHighlightOpacity("0"); return; }
    // 禁用按钮既不长标签也不亮滑块（停在灰掉的「停止」上不该出现展开态）
    if (hit.disabled) { if (hovered.current) collapse(); setHighlightOpacity("0"); return; }
    if (hit === hovered.current) {
      // 指针穿过间隙时滑块会先隐藏，回到同一颗要重新点亮（标签一直没收起）
      if (hlRef.current?.style.opacity !== "1") placeHighlight(hit);
      return;
    }
    openButton(hit);
    placeHighlight(hit);
  };
  // pointerover 先于 pointerenter 到（那一刻 inside 还是 false，syncAt 会忽略），所以进场时按当前位置补一次：
  // 指针一次性跳进某颗按钮也会立刻展开，不用再晃一下
  const onEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    inside.current = true;
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    syncAt(e.clientX);
  };
  const onLeave = () => {
    inside.current = false;
    lastX.current = null;
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = window.setTimeout(() => { collapseTimer.current = null; collapse(); }, COLLAPSE_DELAY);
  };

  const block = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      ref={menuRef}
      id={id}
      className={"cn-fm" + (show ? " on" : "") + (className ? " " + className : "")}
      style={style}
      {...(data || {})}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerOver={(e) => syncAt(e.clientX)}
      onPointerMove={(e) => syncAt(e.clientX)}
      // 展开结束必须按最终几何重摆一次：只有一颗按钮的条不会再派发 pointerover，去重会把这次重算吞掉。
      // 这里直接重摆而不是把 hovered 清空再 hit-test：换颗时旧那颗还在收，清空会让补偿按「剩余宽度」重算成错的
      onTransitionEnd={(e) => { if (e.propertyName === "max-width" && inside.current && hovered.current) placeHighlight(hovered.current); }}
      onPointerDown={(e) => { block(e); onPointerDown?.(e); }}
      onDoubleClick={(e) => { block(e); onDoubleClick?.(e); }}
    >
      {/* 高亮单独放在裁剪层里：条本身不能 overflow:hidden（会裁掉按钮上方的 data-tip tooltip） */}
      <span className="cn-fm-clip" aria-hidden="true"><span ref={hlRef} className="cn-fm-hl" /></span>
      {children}
    </div>
  );
});

export type FloatMenuProps = FloatMenuBarProps;

/** 自带定位的一版（分组工具栏 / 多选条）：浮在节点正上方、居中、按 --zinv 反向缩放 */
export const FloatMenu = forwardRef<HTMLDivElement, FloatMenuProps>(function FloatMenu({ className, style, ...rest }, ref) {
  return <FloatMenuBar ref={ref} {...rest} className={"cn-fm-anchored" + (className ? " " + className : "")} style={style} />;
});

export type FloatMenuButtonProps = {
  icon: IconName;
  label: string;
  title?: string;
  disabled?: boolean;
  /** 主操作：常驻一层浅底 */
  primary?: boolean;
  danger?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** 透传给按钮的 data-* 标记 */
  data?: Record<string, string>;
  /** 图标旁的附加小标（如颜色标记的小圆点） */
  adornment?: ReactNode;
};

/** 工具条按钮：图标 + 文字（文字默认折叠，指针落在这一颗时展开） */
export const FloatMenuButton = forwardRef<HTMLButtonElement, FloatMenuButtonProps>(function FloatMenuButton({ icon, label, title, disabled, primary, danger, onClick, data, adornment }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="cn-fm-btn"
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      {...(primary ? { "data-fm-primary": "1" } : {})}
      {...(danger ? { "data-fm-danger": "1" } : {})}
      {...(data || {})}
    >
      <Icon name={icon} />
      {adornment}
      <span className="cn-fm-label">{label}</span>
    </button>
  );
});
