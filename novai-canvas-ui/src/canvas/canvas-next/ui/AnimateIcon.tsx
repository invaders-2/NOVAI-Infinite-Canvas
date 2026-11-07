/* 复刻 animate-ui 的 AnimateIcon：这里只做触发与参数传递，动效全部在 static/css/nv-icons.css。
   hover / focus 由 CSS 的祖先选择器负责（图标是 button / [data-icon-trigger] 的直接子元素就会动）；
   tap 和自动播放靠给 svg 加 .nv-i-play 类，参数走 .nv-i-a-<变体> 类和 --nv-i-* 内联变量
   （变量必须写在 svg 上：动效层在 svg 自身定义了默认值，写在祖先上会被盖掉）。 */
import {
    Children,
    cloneElement,
    createContext,
    isValidElement,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type ReactElement,
    type ReactNode,
    type Ref,
} from "react";

export type IconAnimation = "default" | "pop" | "rotate" | "spin" | "bounceY" | "slideX" | "wiggle" | "blink" | "draw" | "path" | "path-loop" | "tilt";

export type IconAnimationConfig = {
    animation?: IconAnimation;
    animateOnHover: boolean;
    speed?: number;
    delay?: number;
    loop: boolean;
};

export const IconAnimationContext = createContext<IconAnimationConfig | null>(null);

/** 播一次：先摘类再强制 reflow，否则同一个图标连续点击不会重放 */
function playOnce(host: Element) {
    for (const icon of host.querySelectorAll<SVGSVGElement>("svg.nv-i")) {
        icon.classList.remove("nv-i-play");
        void icon.getBoundingClientRect();
        icon.classList.add("nv-i-play");
        const done = (event: AnimationEvent) => {
            if (event.target !== icon) return;
            icon.removeEventListener("animationend", done);
            icon.classList.remove("nv-i-play");
        };
        icon.addEventListener("animationend", done);
        // reduced-motion 或外部样式关掉动画时不会有 animationend，兜底摘类，否则类常驻会让后续 hover 不再重放
        window.setTimeout(() => { icon.removeEventListener("animationend", done); icon.classList.remove("nv-i-play"); }, 2400);
    }
}

export type AnimateIconProps = {
    children: ReactNode;
    /** 挂载后自动播一次 */
    animate?: boolean;
    animateOnHover?: boolean;
    animateOnTap?: boolean;
    animation?: IconAnimation;
    speed?: number;
    delay?: number;
    loop?: boolean;
    /** 并入唯一子元素，不额外包一层 DOM：按钮、菜单项这类布局敏感的容器用它 */
    asChild?: boolean;
    className?: string;
    style?: CSSProperties;
};

export function AnimateIcon({
    children,
    animate = false,
    animateOnHover = true,
    animateOnTap = true,
    animation,
    speed,
    delay,
    loop = false,
    asChild = false,
    className,
    style,
}: AnimateIconProps) {
    const hostRef = useRef<Element | null>(null);
    const childRef = isValidElement(children) ? (children.props as { ref?: Ref<Element> }).ref : undefined;
    const config = useMemo<IconAnimationConfig>(
        () => ({ animation, animateOnHover, speed, delay, loop }),
        [animation, animateOnHover, speed, delay, loop],
    );
    const setHost = useCallback((node: Element | null) => {
        hostRef.current = node;
        if (typeof childRef === "function") childRef(node);
        else if (childRef) (childRef as { current: Element | null }).current = node;
    }, [childRef]);
    useEffect(() => { if (animate && hostRef.current) playOnce(hostRef.current); }, [animate]);
    const onPointerDown = (event: ReactPointerEvent<Element>) => { if (animateOnTap) playOnce(event.currentTarget); };

    if (!asChild) {
        return <IconAnimationContext.Provider value={config}>
            <span ref={setHost} className={"nv-i-host" + (className ? " " + className : "")} style={style} data-icon-trigger="" onPointerDown={onPointerDown}>{children}</span>
        </IconAnimationContext.Provider>;
    }
    const child = Children.only(children) as ReactElement<Record<string, unknown>>;
    return <IconAnimationContext.Provider value={config}>
        {cloneElement(child, {
            ref: setHost,
            "data-icon-trigger": "",
            className: [child.props.className, className].filter(Boolean).join(" ") || undefined,
            style: style ? { ...(child.props.style as CSSProperties | undefined), ...style } : child.props.style,
            onPointerDown: (event: ReactPointerEvent<Element>) => {
                (child.props.onPointerDown as ((e: ReactPointerEvent<Element>) => void) | undefined)?.(event);
                onPointerDown(event);
            },
        })}
    </IconAnimationContext.Provider>;
}
