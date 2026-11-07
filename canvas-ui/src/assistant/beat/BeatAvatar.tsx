import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import "./beat-avatar.css"

/* 12 个状态都对应权威片段里的一个 CSS 动画；组件只负责「当前 state 长什么样」，
   自动回退（success 1.2s / error 1.4s / 45s 转困倦）一律由上层决定。 */
export type BeatState =
	| "idle"
	| "blink"
	| "happy"
	| "thinking"
	| "listening"
	| "focus"
	| "sleepy"
	| "surprised"
	| "error"
	| "generating"
	| "tool"
	| "waiting"

export type BeatTheme = "dark" | "light"

interface BeatAvatarProps {
	state?: BeatState
	/** 只决定根节点边长，内部全是百分比 */
	size?: number
	/** 不传就跟随宿主页面的 html/body 主题类 */
	theme?: BeatTheme
	/** 0.55 弱 / 1 中 / 1.5 强 */
	glow?: 0.55 | 1 | 1.5
	/** 0..1，只有 generating 会读它 */
	progress?: number
	followPointer?: boolean
	className?: string
}

/* 主题：NOVAI 宿主用 html/body 上的 theme-dark / studio-theme-dark / data-theme="dark" 切主题，
   面板自己没有主题属性，所以这里读宿主根节点；只看 html/body，避免被图标自己的 data-theme 反过来影响。 */
const readTheme = (): BeatTheme => {
	const html = document.documentElement
	const body = document.body
	const dark =
		html.classList.contains("theme-dark") ||
		html.classList.contains("studio-theme-dark") ||
		html.getAttribute("data-theme") === "dark" ||
		(body &&
			(body.classList.contains("theme-dark") ||
				body.classList.contains("studio-theme-dark") ||
				body.getAttribute("data-theme") === "dark"))
	return dark ? "dark" : "light"
}

export const useBeatTheme = (): BeatTheme => {
	const [theme, setTheme] = useState<BeatTheme>(readTheme)
	useEffect(() => {
		const sync = () => setTheme((current) => (current === readTheme() ? current : readTheme()))
		sync()
		const observer = new MutationObserver(sync)
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] })
		if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] })
		return () => observer.disconnect()
	}, [])
	return theme
}

/* 表情动效全在 CSS，JS 只剩两件 CSS 做不到的事：鼠标跟随要每帧插值，随机眨眼要按状态改间隔。
   两者都按「片段里那套数值」实现，只是把单例 el.beatAvatar 换成模块级共享循环：
   整个面板只挂一个 pointermove 和一个 rAF，多个头像只是同一循环里多注册一个目标。 */
interface FollowTarget {
	root: HTMLElement
	eyes: HTMLElement
	bars: HTMLElement[]
	ox: number
	oy: number
	blinkAt: number
	double: boolean
	nextBlink: number
}

const BLINK_WINDOW: Record<string, { min: number; max: number; double?: boolean }> = {
	idle: { min: 4000, max: 7000 },
	listening: { min: 2000, max: 3500 },
	sleepy: { min: 4000, max: 6000 },
	happy: { min: 1100, max: 2000, double: true },
}

const targets = new Set<FollowTarget>()
let pointerX = window.innerWidth / 2
let pointerY = window.innerHeight / 2
let frameHandle = 0
let pointerBound = false
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

const trackPointer = (event: PointerEvent) => {
	pointerX = event.clientX
	pointerY = event.clientY
}

const blinkShape = (p: number) =>
	p < 0.45 ? 1 - 0.94 * Math.sin((p / 0.45) * Math.PI / 2) : 0.06 + 0.94 * (1 - Math.pow(1 - (p - 0.45) / 0.55, 3))

const frame = (time: number) => {
	if (!targets.size) {
		frameHandle = 0
		return
	}
	frameHandle = requestAnimationFrame(frame)
	if (reducedMotion.matches) return
	targets.forEach((target) => {
		const rect = target.root.getBoundingClientRect()
		if (!rect.width) return
		const dx = pointerX - (rect.left + rect.width / 2)
		const dy = pointerY - (rect.top + rect.height / 2)
		const distance = Math.hypot(dx, dy) || 1
		const range = rect.width * 0.075 * 0.88
		const lerp = target.root.dataset.state === "focus" ? 0.24 : 0.15
		const force = Math.min(1, distance / 420)
		target.ox += (dx / distance * range * force - target.ox) * lerp
		target.oy += (dy / distance * range * force - target.oy) * lerp
		target.eyes.style.transform = "translate(" + (target.ox / rect.width * 100).toFixed(2) + "%," + (target.oy / rect.height * 100).toFixed(2) + "%)"

		const window_ = BLINK_WINDOW[target.root.dataset.state || ""]
		if (window_ && time > target.nextBlink) {
			target.blinkAt = time
			target.double = Boolean(window_.double)
			target.nextBlink = time + window_.min + Math.random() * (window_.max - window_.min)
		}
		let k = 1
		const p = (time - target.blinkAt) / 220
		if (p >= 0 && p < 1) k = blinkShape(p)
		if (target.double) {
			const p2 = (time - target.blinkAt - 200) / 220
			if (p2 >= 0 && p2 < 1) k = Math.min(k, blinkShape(p2))
		}
		for (const bar of target.bars) bar.style.transform = "scaleY(" + k.toFixed(3) + ")"
	})
}

const syncLoop = () => {
	if (targets.size) {
		if (!pointerBound) {
			window.addEventListener("pointermove", trackPointer, { passive: true })
			pointerBound = true
		}
		if (!frameHandle) frameHandle = requestAnimationFrame(frame)
		return
	}
	if (pointerBound) {
		window.removeEventListener("pointermove", trackPointer)
		pointerBound = false
	}
	if (frameHandle) {
		cancelAnimationFrame(frameHandle)
		frameHandle = 0
	}
}

const registerFollow = (root: HTMLElement, eyes: HTMLElement) => {
	const target: FollowTarget = {
		root,
		eyes,
		bars: Array.from(eyes.querySelectorAll<HTMLElement>(".nvca-beat-eye")),
		ox: 0,
		oy: 0,
		blinkAt: -1e9,
		double: false,
		nextBlink: performance.now() + 1600 + Math.random() * 3000,
	}
	targets.add(target)
	syncLoop()
	return () => {
		targets.delete(target)
		syncLoop()
	}
}

export const BeatAvatar = ({
	state = "idle",
	size = 28,
	theme,
	glow = 1,
	progress = 0.5,
	followPointer = true,
	className,
}: BeatAvatarProps) => {
	const detected = useBeatTheme()
	const rootRef = useRef<HTMLSpanElement | null>(null)
	const eyesRef = useRef<HTMLSpanElement | null>(null)

	useEffect(() => {
		const root = rootRef.current
		const eyes = eyesRef.current
		if (!followPointer || !root || !eyes) return
		return registerFollow(root, eyes)
	}, [followPointer])

	/* 片段的 28 / 40 / 64 三档光半径；22px 这种更小的值并进 28 档，否则小图标会糊成一团 */
	const sizeBucket = size <= 28 ? 28 : size <= 40 ? 40 : 64
	const clamped = Math.min(1, Math.max(0, Number(progress) || 0))

	return (
		<span
			aria-hidden="true"
			className={className ? "nvca-beat-avatar " + className : "nvca-beat-avatar"}
			data-size={sizeBucket}
			data-state={state}
			data-theme={theme || detected}
			ref={rootRef}
			style={{ width: size, height: size, "--glow": glow, "--beat-progress": clamped.toFixed(3) } as CSSProperties}
		>
			<span className="nvca-beat-face" />
			<span className="nvca-beat-eyes" ref={eyesRef}>
				<span className="nvca-beat-group">
					<i className="nvca-beat-eye" />
					<i className="nvca-beat-eye" />
				</span>
			</span>
		</span>
	)
}
