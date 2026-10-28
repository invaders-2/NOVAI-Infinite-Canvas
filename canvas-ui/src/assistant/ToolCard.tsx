import {
	AlertTriangleIcon,
	CheckIcon,
	ChevronDownIcon,
	Clock3Icon,
	Loader2Icon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { toolLabel } from "./format"
import type { Message } from "./types"

type StepPart = Extract<Message["parts"][number], { type: "tool_event" }>

const TRUNC_ARGS = 2000
const TRUNC_OUTPUT = 4000

const truncate = (text: string, max: number): { text: string; truncated: boolean } => {
	if (text.length <= max) return { text, truncated: false }
	return { text: text.slice(0, max) + "\n…", truncated: true }
}

const firstString = (source: unknown, keys: string[]): string => {
	if (!source || typeof source !== "object") return ""
	const record = source as Record<string, unknown>
	for (const key of keys) {
		const value = record[key]
		if (value == null) continue
		if (typeof value === "string" && value.trim()) return value.trim()
		if (typeof value === "number" || typeof value === "boolean") return String(value)
	}
	return ""
}

const clip = (text: string, max = 48): string => (text.length > max ? text.slice(0, max).trimEnd() + "…" : text)

export const toolDisplayName = (tool: string): string => toolLabel(tool)

export const toolSubtitle = (part: StepPart): string => {
	const args = part.args as Record<string, unknown> | undefined
	if (args && typeof args === "object") {
		if (part.tool === "canvas_cli") {
			const command = firstString(args, ["command"])
			const inner = firstString(args.args, ["title", "name", "path", "filename", "id", "type"])
			const detail = [command, inner].filter(Boolean).join(" · ")
			if (detail) return clip(detail)
		}
		const value = firstString(args, [
			"filename",
			"file_name",
			"filepath",
			"file_path",
			"path",
			"title",
			"name",
			"command",
			"query",
			"url",
			"instructions",
			"description",
			"prompt",
			"text",
			"content",
		])
		if (value) return clip(value)
		try {
			const compact = JSON.stringify(args)
			if (compact && compact !== "{}") return clip(compact, 56)
		} catch {
			/* 参数不可序列化时只用标题 */
		}
	}
	return clip(part.title || "")
}

const formatMs = (ms: number): string => {
	if (!Number.isFinite(ms) || ms < 0) return ""
	if (ms < 1) return "<1ms"
	if (ms < 1000) return Math.round(ms) + "ms"
	const seconds = ms / 1000
	if (seconds < 60) return seconds.toFixed(1) + "s"
	const minutes = Math.floor(seconds / 60)
	const rest = Math.floor(seconds % 60)
	return minutes + "m" + String(rest).padStart(2, "0") + "s"
}

export const toolDuration = (part: StepPart): string => {
	if (typeof part.durationMs === "number" && Number.isFinite(part.durationMs)) {
		return formatMs(part.durationMs)
	}
	const startedAt = Number(part.startedAt) || 0
	if (!startedAt) return ""
	const endedAt = Number(part.endedAt) || (part.status === "running" ? Date.now() : 0)
	if (!endedAt) return ""
	return formatMs(endedAt - startedAt)
}

const statusIcon = (status: string) => {
	if (status === "done") return <CheckIcon className="nvca-tool-icon is-done" />
	if (status === "failed") return <AlertTriangleIcon className="nvca-tool-icon is-failed" />
	if (status === "running") return <Loader2Icon className="nvca-tool-icon is-running nvca-spin" />
	return <Clock3Icon className="nvca-tool-icon is-pending" />
}

export const ToolCard = ({ part }: { part: StepPart }) => {
	const failed = part.status === "failed"
	const [open, setOpen] = useState(failed)
	useEffect(() => {
		if (failed) setOpen(true)
	}, [failed])

	const args = part.args
	const argsRaw = args === undefined ? "" : typeof args === "string" ? args : JSON.stringify(args, null, 2)
	const argsView = truncate(argsRaw || "", TRUNC_ARGS)
	const outputRaw =
		typeof part.output === "string" && part.output
			? part.output
			: part.result === undefined
				? ""
				: typeof part.result === "string"
					? part.result
					: JSON.stringify(part.result, null, 2)
	const outputView = truncate(outputRaw || "", TRUNC_OUTPUT)
	const subtitle = toolSubtitle(part)
	const duration = toolDuration(part)

	return (
		<div className={cn("nvca-tool-card", failed && "is-failed", part.status === "running" && "is-running")} data-tool={part.tool}>
			<button
				aria-expanded={open}
				className="nvca-tool-head"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<span className="nvca-tool-state">{statusIcon(part.status)}</span>
				<span className="nvca-tool-name">{part.title || toolDisplayName(part.tool)}</span>
				{part.title ? <span className="nvca-tool-sub">{toolDisplayName(part.tool)}</span> : subtitle ? <span className="nvca-tool-sub">{subtitle}</span> : null}
				<span className="nvca-tool-spacer" />
				{duration ? <span className="nvca-tool-duration">{duration}</span> : null}
				<ChevronDownIcon className={cn("nvca-tool-caret", open && "is-open")} />
			</button>
			{open ? (
				<div className="nvca-tool-body">
					{failed ? (
						<div className="nvca-tool-error">
							<span className="nvca-tool-code">{part.code || "FAILED"}</span>
							<span className="nvca-tool-error-text">{part.message || "执行失败"}</span>
						</div>
					) : null}
					<div className="nvca-tool-section">
						<div className="nvca-tool-label">参数</div>
						<pre className="nvca-tool-pre">{argsView.text || "（无参数）"}</pre>
						{argsView.truncated ? <div className="nvca-tool-trunc">参数过长，已截断（仅显示前 2k 字符）</div> : null}
					</div>
					<div className="nvca-tool-section">
						<div className="nvca-tool-label">输出</div>
						<pre className="nvca-tool-pre">{outputView.text || "（无输出）"}</pre>
						{outputView.truncated ? <div className="nvca-tool-trunc">输出过长，已截断（仅显示前 4k 字符）</div> : null}
					</div>
				</div>
			) : null}
		</div>
	)
}
