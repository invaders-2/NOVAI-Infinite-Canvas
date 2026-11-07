/* 图标：24×24 线性描边，和预览同一套路径。只在本模块内使用。
   有 lucide 官方图形的业务名走 iconData.ts 里的数据，只有业务图形（续画 / 标注 / 比例 …）才手绘。 */
import { memo, useContext, type CSSProperties } from "react";
import { type IconAnimation, IconAnimationContext } from "./AnimateIcon";
import { ICON_LUCIDE, LUCIDE_ICON_NODES } from "./iconData";

/** lucide 没有对应图形的业务图标：保留原有手绘路径（lucide 里形状对不上，换过去会改变含义） */
const HAND_DRAWN = {
    arrowleft: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    libadd: '<path d="M4 6h16M4 12h10M4 18h7M17 15v6M14 18h6"/>',
    ratio: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
    magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4M6 8h4M14 8h4"/><path d="M10 4v8a2 2 0 0 0 4 0V4"/>',
    skipb: '<path d="M6 5v14M19 5l-9 7 9 7z"/>',
    skipf: '<path d="M18 5v14M5 5l9 7-9 7z"/>',
    gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1"/>',
    fadein: '<path d="M3 19L13 7h8M3 19h18"/>',
    fadeout: '<path d="M21 19L11 7H3M3 19h18"/>',
    split: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/>',
    outpaint: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5"/>',
    annot: '<path d="M3 21l3-1 11-11-2-2L4 18zM14 6l3-3 4 4-3 3"/>',
    resize: '<path d="M21 3l-7 7M21 3h-6M21 3v6M3 21l7-7M3 21h6M3 21v-6"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
    rundown: '<path d="M5 4l10 8-10 8zM19 5v14"/>',
    runup: '<path d="M19 4L9 12l10 8zM5 5v14"/>',
} as const;

type HandName = keyof typeof HAND_DRAWN;
type MappedName = keyof typeof ICON_LUCIDE;
export type IconName = HandName | MappedName;

/** 业务名 → lucide 官方名；手绘的那几个没有，查不到就不挂 lucide-* 类 */
const LUCIDE_NAME: Partial<Record<IconName, string>> = ICON_LUCIDE;
const LUCIDE_PATHS = Object.fromEntries(
    Object.entries(ICON_LUCIDE).map(([business, lucide]) => [business, LUCIDE_ICON_NODES[lucide]]),
) as Record<MappedName, string>;

/** 业务名 → 内联子元素。PromptEditor 拿它拼 mentions 里的内联 svg */
export const ICON_PATHS: Record<IconName, string> = { ...HAND_DRAWN, ...LUCIDE_PATHS };

const HTML = new Map<string, { __html: string }>();
const html = (name: IconName) => { let h = HTML.get(name); if (!h) { h = { __html: ICON_PATHS[name] }; HTML.set(name, h); } return h; };

type IconProps = {
    name: IconName;
    size?: "s" | "xs";
    className?: string;
    style?: CSSProperties;
    /** 显式指定动画变体；不给就按 nv-icons.css 的具名方向映射走（chevron-down 向下弹、trash 掀盖 …） */
    animation?: IconAnimation;
    animateOnHover?: boolean;
    speed?: number;
    delay?: number;
    loop?: boolean;
};
/** memo + 固定的 __html 对象：重渲染时不重建 <path>，否则按下与松开落在不同元素上，click 会丢 */
export const Icon = memo(function Icon({ name, size, className, style, animation, animateOnHover, speed, delay, loop }: IconProps) {
    const ctx = useContext(IconAnimationContext);
    const variant = animation ?? ctx?.animation;
    const hover = animateOnHover ?? ctx?.animateOnHover ?? true;
    const rate = speed ?? ctx?.speed;
    const wait = delay ?? ctx?.delay;
    const repeat = loop ?? ctx?.loop ?? false;
    const lucide = LUCIDE_NAME[name];
    // nv-i-<业务名> 和 lucide-<官方名> 都挂：动效层的具名方向映射两个都认，缺一个会掉到通用 pop
    const cls = "i nv-i nv-i-" + name + (lucide ? " lucide lucide-" + lucide : "")
        + (size ? " " + size : "") + (className ? " " + className : "") + (variant ? " nv-i-a-" + variant : "");
    const vars: Record<string, string> = {};
    if (rate != null) vars["--nv-i-speed"] = String(rate);
    if (wait != null) vars["--nv-i-delay"] = wait + "ms";
    if (repeat) vars["--nv-i-loop"] = "infinite";
    return <svg
        className={cls}
        style={Object.keys(vars).length ? ({ ...vars, ...style } as CSSProperties) : style}
        data-icon={name}
        data-nv-no-hover={hover ? undefined : ""}
        viewBox="0 0 24 24"
        aria-hidden="true"
        dangerouslySetInnerHTML={html(name)}
    />;
});

export function Logo() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <defs><linearGradient id="cnLogo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--solid)" /><stop offset="1" stopColor="#8e8e93" /></linearGradient></defs>
            <path d="M4 18a8 8 0 0 1 16 0" fill="none" stroke="url(#cnLogo)" strokeWidth="3" strokeLinecap="round" />
            <circle cx="12" cy="18" r="2.4" fill="var(--solid)" />
        </svg>
    );
}
