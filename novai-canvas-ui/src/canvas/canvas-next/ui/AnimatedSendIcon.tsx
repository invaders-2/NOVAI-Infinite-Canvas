/**
 * Hugeicons Animated 的 arrow-up-02（会动的发送箭头）。
 * 官方 registry 是 motion 版本；这里不引 motion，用浏览器原生 WAAPI 播同一套关键帧，视觉一致。
 * 触发挂在最近的 button 上（鼠标进入 / 按下 / 键盘聚焦各播一次，先 cancel 再 play），
 * prefers-reduced-motion: reduce 时完全不播。纯图标，颜色跟随按钮 currentColor。
 */
import { useEffect, useRef } from "react";
import "./animated-send-icon.css";

const KEYFRAMES: Keyframe[] = [
    { transform: "translateY(0px) scaleX(1)" },
    { transform: "translateY(-2.6px) scaleX(0.94)", offset: 0.25 },
    { transform: "translateY(0.3px) scaleX(1.02)", offset: 0.5 },
    { transform: "translateY(-0.45px) scaleX(0.99)", offset: 0.75 },
    { transform: "translateY(0px) scaleX(1)", offset: 1 },
];

const TIMING: KeyframeAnimationOptions = { duration: 500, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };

export type AnimatedSendIconProps = {
    size?: number;
    className?: string;
    /** 默认 currentColor，跟随按钮文字色（浅色/深色自动适配） */
    color?: string;
};

export function AnimatedSendIcon({ size = 16, className, color = "currentColor" }: AnimatedSendIconProps) {
    const svgRef = useRef<SVGSVGElement | null>(null);

    useEffect(() => {
        const svg = svgRef.current;
        const group = svg?.querySelector("g");
        if (!svg || !group) return;
        const host: Element = svg.closest("button") ?? svg;
        let current: Animation | null = null;
        const play = () => {
            if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
            current?.cancel();
            current = group.animate(KEYFRAMES, TIMING);
        };
        host.addEventListener("pointerenter", play);
        host.addEventListener("pointerdown", play);
        host.addEventListener("focusin", play);
        return () => {
            host.removeEventListener("pointerenter", play);
            host.removeEventListener("pointerdown", play);
            host.removeEventListener("focusin", play);
            current?.cancel();
        };
    }, []);

    // 描边属性挂在 <g> 上：页面里 .send svg{stroke-width:2.2} 只作用于 svg，
    // 写在 <g> 上的声明才会盖过它继承下来的值。
    return <svg
        ref={svgRef}
        className={"nv-send-ic" + (className ? " " + className : "")}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        overflow="visible"
        aria-hidden="true"
        focusable="false"
        data-icon="send-animated"
    >
        <g stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M12 5.5V19" />
            <path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11" />
        </g>
    </svg>;
}
