"use client"

import { useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

// Hugeicons Animated「arrow-up-02」的原生复刻：官方实现依赖 motion，这里用 WAAPI 播同一套关键帧，
// 不额外引入依赖。两条 path 包在一个 <g> 里，只动这个 g。
// 缓动挂在每一段关键帧上（motion 对关键帧数组就是把同一个 ease 逐段套用），不是整条动画一条曲线。
const SEND_ICON_EASING = "cubic-bezier(0.23, 1, 0.32, 1)"

const SEND_ICON_KEYFRAMES: Keyframe[] = [
	{ offset: 0, transform: "translateY(0) scaleX(1)", easing: SEND_ICON_EASING },
	{ offset: 0.25, transform: "translateY(-2.6px) scaleX(0.94)", easing: SEND_ICON_EASING },
	{ offset: 0.5, transform: "translateY(0.3px) scaleX(1.02)", easing: SEND_ICON_EASING },
	{ offset: 0.75, transform: "translateY(-0.45px) scaleX(0.99)", easing: SEND_ICON_EASING },
	{ offset: 1, transform: "translateY(0) scaleX(1)" },
]

const SEND_ICON_TIMING: KeyframeAnimationOptions = {
	duration: 500,
	fill: "none",
}

export interface AnimatedSendIconProps {
	size?: number
	className?: string
	onHover?: () => void
}

export function AnimatedSendIcon({ size = 16, className, onHover }: AnimatedSendIconProps) {
	const svgRef = useRef<SVGSVGElement | null>(null)
	const groupRef = useRef<SVGGElement | null>(null)
	const animationRef = useRef<Animation | null>(null)

	const play = useCallback(() => {
		const group = groupRef.current
		if (!group) return
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
		animationRef.current?.cancel()
		animationRef.current = group.animate(SEND_ICON_KEYFRAMES, SEND_ICON_TIMING)
	}, [])

	useEffect(() => {
		const svg = svgRef.current
		if (!svg) return
		// 整颗按钮都算触发区（圆底比图标大），所以监听最近的按钮；独立使用时退回 svg 本身。
		const host = svg.closest<HTMLElement>("button, a, [role='button']") ?? svg
		const handleHover = () => {
			play()
			onHover?.()
		}
		const handlePress = () => play()
		host.addEventListener("mouseenter", handleHover)
		host.addEventListener("focusin", handlePress)
		host.addEventListener("pointerdown", handlePress)

		// 空输入时发送键是 disabled（Tailwind 的 pointer-events-none 让鼠标事件到不了 host），
		// 在父级做一次命中测试，保证默认空闲态 hover 也能看到动画。
		const overlay = host.parentElement
		let inside = false
		const handleMove = (event: PointerEvent) => {
			if (!(host instanceof HTMLButtonElement) || !host.disabled) {
				inside = false
				return
			}
			const rect = host.getBoundingClientRect()
			const hit =
				event.clientX >= rect.left &&
				event.clientX <= rect.right &&
				event.clientY >= rect.top &&
				event.clientY <= rect.bottom
			if (hit && !inside) handleHover()
			inside = hit
		}
		const handleLeave = () => {
			inside = false
		}
		if (overlay) {
			overlay.addEventListener("pointermove", handleMove)
			overlay.addEventListener("pointerleave", handleLeave)
		}

		return () => {
			host.removeEventListener("mouseenter", handleHover)
			host.removeEventListener("focusin", handlePress)
			host.removeEventListener("pointerdown", handlePress)
			overlay?.removeEventListener("pointermove", handleMove)
			overlay?.removeEventListener("pointerleave", handleLeave)
			animationRef.current?.cancel()
			animationRef.current = null
		}
	}, [play, onHover])

	return (
		<svg
			aria-hidden="true"
			className={cn("nvca-animated-send-icon", className)}
			fill="none"
			height={size}
			overflow="visible"
			ref={svgRef}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={1.5}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<g ref={groupRef} style={{ transformBox: "view-box", transformOrigin: "center" }}>
				<path d="M12 5.5V19" strokeWidth={1.5} />
				<path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11" strokeWidth={1.5} />
			</g>
		</svg>
	)
}
