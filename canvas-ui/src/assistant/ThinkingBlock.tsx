import { BrainIcon, ChevronDownIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Shimmer } from "@/components/ai-elements/shimmer"
import StreamingResponse from "@/components/ai-elements/streaming-response"
import { cn } from "@/lib/utils"

// 思考折叠：标题行沿用旧 ReasoningTrigger 的观感（线性 Brain + Shimmer/已思考 Ns + 人字箭头），
// 正文换成 StreamingResponse 的逐词浮现 + 圆点光标。样式全部在 styles/index.css 的 .nvca-thinking 里。
const AUTO_COLLAPSE_MS = 1000

export const ThinkingBlock = ({
	text,
	durationMs,
	streaming,
}: {
	text: string
	durationMs: number
	streaming: boolean
}) => {
	const [open, setOpen] = useState(streaming)
	const manual = useRef(false)
	const wasStreaming = useRef(streaming)

	useEffect(() => {
		if (streaming) {
			wasStreaming.current = true
			if (!manual.current) setOpen(true)
			return
		}
		/* 结束后 1s 自动收起成一行；用户手动点过就不再自动改 */
		if (!wasStreaming.current || manual.current) return
		const timer = window.setTimeout(() => setOpen(false), AUTO_COLLAPSE_MS)
		return () => window.clearTimeout(timer)
	}, [streaming])

	const seconds = durationMs > 0 ? Math.max(1, Math.round(durationMs / 1000)) : 0
	const toggle = () => {
		manual.current = true
		setOpen((value) => !value)
	}

	return (
		<div className="nvca-thinking" data-open={open ? "true" : "false"} data-status={streaming ? "streaming" : "done"} data-thinking="true">
			<button
				aria-expanded={open}
				className="nvca-thinking-head"
				data-thinking-trigger="true"
				onClick={toggle}
				type="button"
			>
				<BrainIcon className="nvca-thinking-brain" />
				{streaming ? (
					<Shimmer as="span" className="nvca-thinking-shimmer" duration={1.6}>思考中…</Shimmer>
				) : (
					<span className="nvca-thinking-label">{seconds ? "已思考 " + seconds + "s" : "思考"}</span>
				)}
				<ChevronDownIcon className={cn("nvca-thinking-caret", open && "is-open")} />
			</button>
			<div className="nvca-thinking-body" data-thinking-body="true">
				<div className="nvca-thinking-body-inner">
					<StreamingResponse
						actions={false}
						caret={streaming}
						className="nvca-thinking-text"
						status={streaming ? "streaming" : "done"}
						text={text}
					/>
				</div>
			</div>
		</div>
	)
}
