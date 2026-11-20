"use client"

/*
 * Rare UI StreamingResponse 的 NOVAI 移植版。
 * 动画全部用 WAAPI（项目没装 motion/framer-motion）；逐词节奏沿用参考实现的随机 chunk + CATCH_UP。
 * 分词改成 CJK 两字一组、拉丁按空白、标点单独成 token：中文没有空格，按空白切会把整段当成一个词。
 */

import { Check, Copy, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react"
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ComponentProps, ReactNode, RefObject } from "react"

import { cn } from "@/lib/utils"
import "./streaming-response.css"

export type StreamingResponseStatus = "streaming" | "done" | "stopped"
export type StreamingResponseFeedback = "up" | "down" | null

const SPEED = 8
const MAX_CHUNK = 3
// 允许的落后量：真实 token 到达速率 × LAG_MS，最多 26 个词（约 0.3~0.6s）
const LAG_MS = 420
const MIN_LAG_TOKENS = 4
const MAX_LAG_TOKENS = 26
// 正文停止增长（或 status 变 done）后，剩余文字必须在这个时间内补齐
const STALL_MS = 220
const SETTLE_TAIL = 6
const TAIL_GAP_MAX_MS = 70
const SENTENCE_PAUSE_MS = 240
const CLAUSE_PAUSE_MS = 90
const SHARPEN_MS = 260
const DEVELOP_MS = 520
const GLIDE_MS = 180
const STAGGER_MS = 16
const MAX_STAGGER_MS = 60
const COPIED_MS = 1600
const EASE_OUT = "cubic-bezier(0.2, 0.7, 0.3, 1)"
const EASE_DEVELOP = "cubic-bezier(0.25, 0.6, 0.35, 1)"
const EASE_SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)"

type Inline =
	| { type: "text"; text: string }
	| { type: "strong"; children: Inline[] }
	| { type: "em"; children: Inline[] }
	| { type: "code"; text: string }
	| { type: "link"; href?: string; children: Inline[] }

type Block =
	| { type: "p"; text: string }
	| { type: "quote"; text: string }
	| { type: "h"; level: number; text: string }
	| { type: "ul"; start: number; items: string[] }
	| { type: "ol"; start: number; items: string[] }
	| { type: "code"; lang: string; text: string }

const FENCE = /^\s*```(.*)$/
const HEADING = /^(#{1,3})\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/
const SAFE_HREF = /^(https?:|mailto:|\/|#)/i

const startsBlock = (line: string) =>
	FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line)

function parseBlocks(src: string): Block[] {
	const lines = src.split("\n")
	const blocks: Block[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		const fence = line.match(FENCE)
		if (fence) {
			const body: string[] = []
			i += 1
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
				body.push(lines[i])
				i += 1
			}
			i += 1
			blocks.push({ type: "code", lang: fence[1].trim(), text: body.join("\n") })
			continue
		}
		if (!line.trim()) {
			i += 1
			continue
		}
		const heading = line.match(HEADING)
		if (heading) {
			blocks.push({ type: "h", level: heading[1].length, text: heading[2] })
			i += 1
			continue
		}
		const list = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : QUOTE.test(line) ? QUOTE : null
		if (list) {
			const items: string[] = []
			const start = Number.parseInt(line.match(ORDERED)?.[1] ?? "1", 10)
			while (i < lines.length && list.test(lines[i])) {
				const match = lines[i].match(list) as RegExpMatchArray
				items.push(match[match.length - 1])
				i += 1
			}
			if (list === QUOTE) {
				blocks.push({ type: "quote", text: items.join("\n") })
			} else {
				blocks.push({ type: list === BULLET ? "ul" : "ol", start, items })
			}
			continue
		}
		const body = [line]
		i += 1
		while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
			body.push(lines[i])
			i += 1
		}
		blocks.push({ type: "p", text: body.join("\n") })
	}
	return blocks
}

// 维基百科那种自带括号的链接，右括号要配对
function closingParen(src: string, from: number) {
	let depth = 0
	for (let i = from; i < src.length; i += 1) {
		if (src[i] === "(") {
			depth += 1
		} else if (src[i] === ")") {
			if (!depth) {
				return i
			}
			depth -= 1
		}
	}
	return -1
}

// 流式过程中未闭合的标记按已闭合处理，别先闪出星号再回流
function parseInline(src: string, final: boolean): Inline[] {
	const out: Inline[] = []
	let text = ""
	let i = 0
	const flush = () => {
		if (text) {
			out.push({ type: "text", text })
			text = ""
		}
	}
	const close = (marker: string, from: number) => {
		const end = src.indexOf(marker, from)
		return end < 0 && final ? -2 : end
	}
	while (i < src.length) {
		const c = src[i]
		const next = src[i + 1] ?? ""
		if (c === "`") {
			const end = close("`", i + 1)
			if (end !== -2) {
				flush()
				out.push({ type: "code", text: src.slice(i + 1, end < 0 ? undefined : end) })
				i = end < 0 ? src.length : end + 1
				continue
			}
		} else if (c === "*" && next === "*" && src[i + 2] && !/\s/.test(src[i + 2])) {
			const end = close("**", i + 2)
			if (end !== -2) {
				flush()
				out.push({ type: "strong", children: parseInline(src.slice(i + 2, end < 0 ? undefined : end), final) })
				i = end < 0 ? src.length : end + 2
				continue
			}
		} else if ((c === "*" || (c === "_" && !/\w/.test(src[i - 1] ?? ""))) && next && !/\s/.test(next)) {
			const end = close(c, i + 1)
			if (end !== -2) {
				flush()
				out.push({ type: "em", children: parseInline(src.slice(i + 1, end < 0 ? undefined : end), final) })
				i = end < 0 ? src.length : end + 1
				continue
			}
		} else if (c === "[") {
			const bracket = src.indexOf("]", i + 1)
			const after = src[bracket + 1]
			const pending = bracket < 0 || after === undefined
			if ((pending && !final) || after === "(") {
				const paren = after === "(" ? closingParen(src, bracket + 2) : -1
				if (!(final && after === "(" && paren < 0)) {
					const href = paren >= 0 ? src.slice(bracket + 2, paren) : undefined
					flush()
					out.push({
						type: "link",
						href: href && SAFE_HREF.test(href) ? href : undefined,
						children: parseInline(src.slice(i + 1, bracket < 0 ? undefined : bracket), final),
					})
					i = paren >= 0 ? paren + 1 : after === "(" || bracket < 0 ? src.length : bracket + 1
					continue
				}
			}
		}
		text += c
		i += 1
	}
	flush()
	return out
}

type PieceKind = "cjk" | "word" | "punct" | "space"
type Piece = { kind: PieceKind; text: string }

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const PUNCT = /[\p{P}\p{S}]/u
const LETTER_DIGIT = /[\p{L}\p{N}]/u
// 这些标点夹在拉丁词中间时算词的一部分（3:2、deepseek-v4、0.5x），单独出现才当标点
const JOINER = /[-_.'’\/:%@&+#]/

function isSpace(char: string) {
	return /\s/.test(char)
}
function isCjk(char: string) {
	return CJK.test(char)
}
function isPunct(char: string) {
	return PUNCT.test(char)
}
function isLetterDigit(char: string) {
	return LETTER_DIGIT.test(char)
}

// 只负责切分，不丢字符：拼回去必须等于原文
function splitPieces(text: string): Piece[] {
	const pieces: Piece[] = []
	let i = 0
	while (i < text.length) {
		const char = text[i]
		if (isSpace(char)) {
			let end = i + 1
			while (end < text.length && isSpace(text[end])) end += 1
			pieces.push({ kind: "space", text: text.slice(i, end) })
			i = end
			continue
		}
		if (isCjk(char)) {
			let end = i + 1
			while (end < text.length && isCjk(text[end])) end += 1
			// 两字一组：切分位置只取决于 CJK 段起点，文本增量追加不会改动已经出现过的组
			for (let start = i; start < end; start += 2) {
				pieces.push({ kind: "cjk", text: text.slice(start, Math.min(start + 2, end)) })
			}
			i = end
			continue
		}
		if (isPunct(char)) {
			let end = i + 1
			while (end < text.length && isPunct(text[end])) end += 1
			pieces.push({ kind: "punct", text: text.slice(i, end) })
			i = end
			continue
		}
		let end = i + 1
		while (end < text.length) {
			const next = text[end]
			if (isSpace(next) || isCjk(next)) break
			if (isPunct(next)) {
				if (JOINER.test(next) && isLetterDigit(text[end + 1] ?? "")) {
					end += 1
					continue
				}
				break
			}
			end += 1
		}
		pieces.push({ kind: "word", text: text.slice(i, end) })
		i = end
	}
	return pieces
}

// 揭开到哪些字符位置：中文/标点本身就是完整的小组；西文词要等后面还有字（或已经结束）才露，避免半个单词先蹦出来
function tokenEnds(text: string, final: boolean): number[] {
	const ends: number[] = []
	let at = 0
	for (const piece of splitPieces(text)) {
		at += piece.text.length
		if (piece.kind === "space") continue
		if (piece.kind === "word" && !final && at >= text.length) continue
		ends.push(at)
	}
	return ends
}

function countInlineWords(src: string, final: boolean): number {
	let count = 0
	const walk = (nodes: Inline[]) => {
		for (const node of nodes) {
			if (node.type === "text") {
				for (const piece of splitPieces(node.text)) {
					if (piece.kind !== "space") count += 1
				}
			} else if (node.type === "code") {
				count += 1
			} else {
				walk(node.children)
			}
		}
	}
	walk(parseInline(src, final))
	return count
}

function countRenderedWords(src: string, final: boolean): number {
	let count = 0
	for (const block of parseBlocks(src)) {
		if (block.type === "code") {
			count += block.text.split("\n").length
		} else if (block.type === "ul" || block.type === "ol") {
			for (const item of block.items) count += countInlineWords(item, final)
		} else {
			count += countInlineWords(block.text, final)
		}
	}
	return count
}

const fresh = { at: 0, n: 0 }

function usePrefersReducedMotion() {
	const [reduced, setReduced] = useState(false)
	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)")
		const update = () => setReduced(query.matches)
		update()
		query.addEventListener("change", update)
		return () => query.removeEventListener("change", update)
	}, [])
	return reduced
}

function animate(el: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions) {
	if (!el || typeof el.animate !== "function") return
	try {
		el.animate(frames, options)
	} catch {
		/* 老浏览器不支持 WAAPI 时直接呈现终态 */
	}
}

const Word = memo(function Word({ animate: shouldAnimate, children }: { animate: boolean; children: ReactNode }) {
	const ref = useRef<HTMLSpanElement>(null)

	useLayoutEffect(() => {
		const el = ref.current
		if (!el || !shouldAnimate) return
		// 同一帧里挂载的词按阅读顺序错开，最多 60ms
		const now = performance.now()
		if (now - fresh.at > 8) {
			fresh.at = now
			fresh.n = 0
		}
		const delay = Math.min(fresh.n * STAGGER_MS, MAX_STAGGER_MS)
		fresh.n += 1
		animate(el, [{ filter: "blur(5px)" }, { filter: "blur(0px)" }], {
			duration: SHARPEN_MS,
			delay,
			easing: EASE_OUT,
			fill: "backwards",
		})
		animate(el, [{ opacity: 0 }, { opacity: 1 }], {
			duration: DEVELOP_MS,
			delay,
			easing: EASE_DEVELOP,
			fill: "backwards",
		})
	}, [shouldAnimate])

	return <span ref={ref}>{children}</span>
})

type Ctx = { i: number; from: number; caret: ReactNode }

function renderInline(nodes: Inline[], ctx: Ctx): ReactNode[] {
	return nodes.flatMap((node): ReactNode[] => {
		const key = ctx.i
		if (node.type === "text") {
			return splitPieces(node.text).map((piece, index) => {
				if (piece.kind === "space") {
					return piece.text.includes("\n") ? <br key={`br${key}-${index}`} /> : piece.text
				}
				ctx.i += 1
				return (
					<Word key={`w${ctx.i}`} animate={ctx.i > ctx.from}>
						{piece.text}
					</Word>
				)
			})
		}
		if (node.type === "code") {
			ctx.i += 1
			return [
				<Word key={`w${ctx.i}`} animate={ctx.i > ctx.from}>
					<code className="nvca-sr-code">{node.text}</code>
				</Word>,
			]
		}
		const children = renderInline(node.children, ctx)
		if (node.type === "strong") {
			return [
				<strong key={`s${key}`} className="nvca-sr-strong">
					{children}
				</strong>,
			]
		}
		if (node.type === "em") {
			return [
				<em key={`e${key}`} className="nvca-sr-em">
					{children}
				</em>,
			]
		}
		if (node.href) {
			return [
				<a key={`a${key}`} href={node.href} target="_blank" rel="noopener noreferrer" className="nvca-sr-link">
					{children}
				</a>,
			]
		}
		return [
			<span key={`a${key}`} className="nvca-sr-link is-plain">
				{children}
			</span>,
		]
	})
}

type CaretTrack = { x: number; y: number; glide?: Animation } | null

function Caret({ reduced, trackRef }: { reduced: boolean; trackRef: RefObject<CaretTrack> }) {
	const ref = useRef<HTMLSpanElement>(null)

	// 圆点滑到新词上：从它当前可见的位置起滑，滑动中途被打断也不会先弹回原处
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const last = trackRef.current
		const translate = typeof window !== "undefined" ? window.getComputedStyle(el).getPropertyValue("translate") : ""
		const offset = last?.glide && (last.glide.effect as KeyframeEffect | null)?.target === el ? Number.parseFloat(translate) || 0 : 0
		const rect = el.getBoundingClientRect()
		const x = rect.left - offset
		if (last && last.x === x && last.y === rect.top) {
			return
		}
		last?.glide?.cancel()
		const from = last ? last.x + offset - x : 0
		const sameLine = last ? Math.abs(last.y - rect.top) <= 2 : false
		trackRef.current = {
			x,
			y: rect.top,
			glide:
				sameLine && from < 0 && !reduced
					? el.animate([{ translate: `${from}px 0` }, { translate: "0 0" }], {
						duration: GLIDE_MS,
						easing: "cubic-bezier(0.25, 0.8, 0.3, 1)",
					})
					: undefined,
		}
	})

	return <span ref={ref} aria-hidden data-slot="streaming-response-caret" className="nvca-sr-caret" />
}

function CodeBlock({ lang, text, children }: { lang: string; text: string; children: ReactNode }) {
	const reduced = usePrefersReducedMotion()
	const [copied, setCopied] = useState(false)
	const timer = useRef<number | undefined>(undefined)
	useEffect(() => () => window.clearTimeout(timer.current), [])

	const copy = () => {
		navigator.clipboard?.writeText(text).catch(() => {})
		setCopied(true)
		window.clearTimeout(timer.current)
		timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
	}

	return (
		<div className="nvca-sr-codeblock">
			<div className="nvca-sr-codeblock-head">
				<span className="nvca-sr-codeblock-lang">{lang || "code"}</span>
				<IconButton label={copied ? "已复制" : "复制代码"} className="is-small" onClick={copy}>
					<SwapIcon on={copied} reduced={reduced} off={<Copy className="nvca-sr-i-sm" />} onIcon={<Check className="nvca-sr-i-sm" />} />
				</IconButton>
			</div>
			<pre className="nvca-sr-pre">
				<code>{children}</code>
			</pre>
		</div>
	)
}

function IconButton({ label, pressed, className, children, ...props }: React.ComponentProps<"button"> & { label: string; pressed?: boolean }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			className={cn("nvca-sr-btn", className)}
			{...props}
		>
			{children}
		</button>
	)
}

function SwapIcon({ on, off, onIcon, reduced }: { on: boolean; off: ReactNode; onIcon: ReactNode; reduced: boolean }) {
	const ref = useRef<HTMLSpanElement>(null)

	useLayoutEffect(() => {
		if (reduced) return
		animate(ref.current, [{ opacity: 0, transform: "scale(0.5)", filter: "blur(3px)" }, { opacity: 1, transform: "scale(1)", filter: "blur(0px)" }], {
			duration: 200,
			easing: EASE_OUT,
		})
	}, [on, reduced])

	return (
		<span ref={ref} className="nvca-sr-swap">
			{on ? onIcon : off}
		</span>
	)
}

function PopIcon({ active, direction, reduced, children }: { active: boolean; direction: "up" | "down"; reduced: boolean; children: ReactNode }) {
	const ref = useRef<HTMLSpanElement>(null)
	const previous = useRef(active)

	useLayoutEffect(() => {
		const changed = previous.current !== active
		previous.current = active
		if (!changed || !active || reduced) return
		animate(
			ref.current,
			[
				{ transform: `scale(0.6) rotate(${direction === "up" ? -14 : 14}deg)` },
				{ transform: "scale(1) rotate(0deg)" },
			],
			{ duration: 380, easing: EASE_SPRING },
		)
	}, [active, direction, reduced])

	return (
		<span ref={ref} className="nvca-sr-swap">
			{children}
		</span>
	)
}

export type StreamingResponseProps = Omit<ComponentProps<"div">, "children"> & {
	text: string
	status?: StreamingResponseStatus
	speed?: number
	actions?: boolean
	caret?: boolean
	defaultFeedback?: StreamingResponseFeedback
	onFeedback?: (feedback: StreamingResponseFeedback) => void
	onRetry?: () => void
	onCopy?: (text: string) => void
}

function StreamingResponse({
	text,
	status = "done",
	speed = SPEED,
	actions = true,
	caret = true,
	defaultFeedback = null,
	onFeedback,
	onRetry,
	onCopy,
	className,
	...props
}: StreamingResponseProps) {
	const reduced = usePrefersReducedMotion()
	const streaming = status === "streaming"

	// 挂载时就存在的文本（历史消息）直接全量显示，不补动画
	const [initial] = useState(() => (status === "streaming" ? 0 : text.length))
	const [shown, setShown] = useState(initial)
	const [initialWords] = useState(() => (initial > 0 ? countRenderedWords(text.slice(0, initial), !streaming) : 0))
	const count = useRef(tokenEnds(text.slice(0, initial), true).length)
	const wait = useRef(0)
	const [run, setRun] = useState(0)
	const seen = useRef(text.slice(0, initial))
	// 到达速率与「收尾」状态：决定是柔和浮现还是加速追平
	const lastLen = useRef(initial)
	const lastEnds = useRef(tokenEnds(text.slice(0, initial), true).length)
	const lastGrowth = useRef(performance.now())
	const arrivalRate = useRef(0)
	const draining = useRef(false)

	useEffect(() => {
		if (status === "stopped") {
			return
		}
		const ends = tokenEnds(text, !streaming)
		let frame = 0
		let last = performance.now()
		const tick = (now: number) => {
			const dt = Math.min(Math.max(now - last, 0), 100)
			last = now
			// 不是追加（比如重新生成）就整段重来
			if (!text.startsWith(seen.current)) {
				count.current = 0
				wait.current = 0
				lastLen.current = 0
				lastEnds.current = 0
				arrivalRate.current = 0
				draining.current = false
				lastGrowth.current = now
				setRun((n) => n + 1)
			}

			// 用新增文字估算到达速率：真实流里 token 是一段一段来的，揭示节奏要跟着它走
			if (text.length !== lastLen.current) {
				const added = Math.max(0, ends.length - lastEnds.current)
				const span = Math.max(now - lastGrowth.current, 16)
				const instant = (added * 1000) / span
				arrivalRate.current = arrivalRate.current ? arrivalRate.current * 0.55 + instant * 0.45 : instant
				lastLen.current = text.length
				lastEnds.current = ends.length
				lastGrowth.current = now
				draining.current = false
			}

			const backlog = ends.length - count.current
			const stalled = !streaming || now - lastGrowth.current > STALL_MS
			// 收尾：先留最后几个词按正常节奏浮现，前面欠下的一次性追平，标题变「已思考」后不会还在慢慢长
			if (stalled && backlog > 0 && !draining.current) {
				draining.current = true
				count.current = Math.max(count.current, ends.length - SETTLE_TAIL)
				wait.current = 0
			}

			if (reduced) {
				count.current = ends.length
			} else if (count.current < ends.length) {
				wait.current -= dt
				// 词一块一块地落下来，间隔也不均匀，像真实 token
				while (wait.current <= 0 && count.current < ends.length) {
					const remaining = ends.length - count.current
					let chunk: number
					let gap: number
					if (draining.current) {
						chunk = Math.min(remaining, 1 + Math.floor(Math.random() * 2))
						gap = Math.min(((chunk * 1000) / Math.max(speed, 1)) * (0.5 + Math.random()), TAIL_GAP_MAX_MS)
					} else {
						const lagBudget = Math.min(MAX_LAG_TOKENS, Math.max(MIN_LAG_TOKENS, (arrivalRate.current || speed) * (LAG_MS / 1000)))
						if (remaining > lagBudget) {
							const drainRate = Math.max(arrivalRate.current, speed) + (remaining - lagBudget) / 0.3
							chunk = Math.min(remaining, 1 + Math.floor(Math.random() * MAX_CHUNK) + Math.floor((remaining - lagBudget) / 6))
							gap = ((chunk * 1000) / Math.max(drainRate, 1)) * (0.5 + Math.random())
						} else {
							chunk = Math.min(remaining, 1 + Math.floor(Math.random() * MAX_CHUNK))
							gap = ((chunk * 1000) / Math.max(speed, 1)) * (0.5 + Math.random())
						}
					}
					count.current = Math.min(ends.length, count.current + chunk)
					const tail = text[ends[count.current - 1] - 1]
					const pause = /[.!?。！？]/.test(tail ?? "") ? SENTENCE_PAUSE_MS : /[,;:，；：、]/.test(tail ?? "") ? CLAUSE_PAUSE_MS : 0
					wait.current += gap + pause
					if (draining.current) {
						wait.current = Math.min(wait.current, TAIL_GAP_MAX_MS)
					} else if (backlog > 8) {
						// 积压大时别被句末停顿拖住
						wait.current = Math.min(wait.current, 36)
					}
				}
			}

			// 内容结束、尾部是空白时也算全部显示
			const end = !streaming && count.current >= ends.length ? text.length : (ends[count.current - 1] ?? 0)
			seen.current = text.slice(0, end)
			setShown(end)
			if (count.current < ends.length) {
				frame = requestAnimationFrame(tick)
			}
		}
		frame = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(frame)
	}, [text, status, streaming, speed, reduced])

	const visible = text.slice(0, shown)
	const settled = status === "stopped" || (!streaming && shown >= text.length)
	const caretTrack = useRef<CaretTrack>(null)
	// caret 会作为 inline 数组的最后一项插入，必须带 key（否则 React 会报 list key 警告）
	const caretNode = caret && !settled ? <Caret key="caret" reduced={reduced} trackRef={caretTrack} /> : null

	const ctx: Ctx = { i: 0, from: reduced ? Number.POSITIVE_INFINITY : run ? 0 : initialWords, caret: caretNode }
	const blocks = parseBlocks(visible)
	const content = blocks.map((block, index) => (
		<Fragment key={`b${run}-${index}`}>{renderBlock(block, ctx, index === blocks.length - 1 && Boolean(caretNode), !streaming)}</Fragment>
	))

	const [feedback, setFeedback] = useState<StreamingResponseFeedback>(defaultFeedback)
	const [copied, setCopied] = useState(false)
	const copyTimer = useRef<number | undefined>(undefined)
	useEffect(() => () => window.clearTimeout(copyTimer.current), [])

	const copy = () => {
		// 停止后复制读者实际看到的这部分
		const value = status === "stopped" ? visible : text
		navigator.clipboard?.writeText(value).catch(() => {})
		onCopy?.(value)
		setCopied(true)
		window.clearTimeout(copyTimer.current)
		copyTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
	}

	const vote = (value: "up" | "down") => {
		const next = feedback === value ? null : value
		setFeedback(next)
		onFeedback?.(next)
	}

	return (
		<div
			data-slot="streaming-response"
			data-status={status}
			data-settled={settled ? "true" : "false"}
			data-shown={shown}
			data-total={text.length}
			aria-busy={!settled}
			className={cn("nvca-sr", className)}
			{...props}
		>
			<div className="nvca-sr-body">
				{content.length > 0 ? content : caretNode ? <p>{caretNode}</p> : null}
			</div>

			{actions && settled && text.length > 0 ? (
				<ActionsRow
					reduced={reduced}
					copied={copied}
					feedback={feedback}
					onCopy={copy}
					onRetry={onRetry}
					onVote={vote}
				/>
			) : null}
		</div>
	)
}

function ActionsRow({
	reduced,
	copied,
	feedback,
	onCopy,
	onRetry,
	onVote,
}: {
	reduced: boolean
	copied: boolean
	feedback: StreamingResponseFeedback
	onCopy: () => void
	onRetry?: () => void
	onVote: (value: "up" | "down") => void
}) {
	const rowRef = useRef<HTMLDivElement>(null)
	const [spins, setSpins] = useState(0)

	useEffect(() => {
		if (reduced) return
		const items = rowRef.current?.querySelectorAll<HTMLElement>("[data-sr-action]")
		items?.forEach((item, index) => {
			animate(item, [{ opacity: 0, transform: "translateY(4px)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0px)" }], {
				duration: 260,
				delay: index * 50,
				easing: EASE_OUT,
				fill: "backwards",
			})
		})
	}, [reduced])

	useLayoutEffect(() => {
		if (!spins || reduced) return
		animate(rowRef.current?.querySelector<HTMLElement>("[data-sr-spin]") ?? null, [{ transform: "rotate(0deg)" }, { transform: "rotate(-360deg)" }], {
			duration: 700,
			easing: EASE_OUT,
		})
	}, [spins, reduced])

	return (
		<div ref={rowRef} className="nvca-sr-actions" data-slot="streaming-response-actions">
			<span data-sr-action className="nvca-sr-action">
				<IconButton label={copied ? "已复制" : "复制"} onClick={onCopy}>
					<SwapIcon on={copied} reduced={reduced} off={<Copy className="nvca-sr-i" />} onIcon={<Check className="nvca-sr-i" />} />
				</IconButton>
			</span>
			{onRetry ? (
				<span data-sr-action className="nvca-sr-action">
					<IconButton
						label="重试"
						onClick={() => {
							setSpins((n) => n + 1)
							onRetry()
						}}
					>
						<span data-sr-spin className="nvca-sr-swap">
							<RotateCcw className="nvca-sr-i" />
						</span>
					</IconButton>
				</span>
			) : null}
			{(["up", "down"] as const).map((value) => {
				const active = feedback === value
				const Icon = value === "up" ? ThumbsUp : ThumbsDown
				return (
					<span data-sr-action className="nvca-sr-action" key={value}>
						<IconButton
							label={value === "up" ? "回答有帮助" : "回答没帮助"}
							pressed={active}
							onClick={() => onVote(value)}
						>
							<PopIcon active={active} direction={value} reduced={reduced}>
								<Icon className="nvca-sr-i" />
							</PopIcon>
						</IconButton>
					</span>
				)
			})}
		</div>
	)
}

function renderBlock(block: Block, ctx: Ctx, caret: boolean, final = true): ReactNode {
	const inline = (src: string, withCaret: boolean) => {
		const nodes = renderInline(parseInline(src, final), ctx)
		return withCaret ? [...nodes, ctx.caret] : nodes
	}
	if (block.type === "code") {
		// 代码按行浮出，不逐词拆
		const lines = block.text.split("\n").map((line, index) => {
			ctx.i += 1
			return (
				<Fragment key={`l${ctx.i}`}>
					{index > 0 && "\n"}
					<Word animate={ctx.i > ctx.from}>{line}</Word>
				</Fragment>
			)
		})
		return (
			<CodeBlock lang={block.lang} text={block.text}>
				{lines}
				{caret && ctx.caret}
			</CodeBlock>
		)
	}
	if (block.type === "h") {
		const Tag = (["h3", "h4", "h5"] as const)[block.level - 1]
		return <Tag className={cn("nvca-sr-h", `nvca-sr-h${block.level}`)}>{inline(block.text, caret)}</Tag>
	}
	if (block.type === "quote") {
		return <div className="nvca-sr-quote">{inline(block.text, caret)}</div>
	}
	if (block.type === "ul" || block.type === "ol") {
		const List = block.type
		return (
			<List className={cn("nvca-sr-list", block.type === "ul" ? "is-bullet" : "is-ordered")} start={block.type === "ol" && block.start !== 1 ? block.start : undefined}>
				{block.items.map((item, index) => (
					<li key={item + index}>{inline(item, caret && index === block.items.length - 1)}</li>
				))}
			</List>
		)
	}
	return <p className="nvca-sr-p">{inline(block.text, caret)}</p>
}

export { StreamingResponse }
export default StreamingResponse
