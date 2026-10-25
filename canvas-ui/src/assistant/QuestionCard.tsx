import { CheckIcon, MessageCircleQuestionIcon, SkipForwardIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AssistantStore } from "./store"
import { toolDisplayName } from "./ToolCard"
import type { Message } from "./types"

type ConfirmPart = Extract<Message["parts"][number], { type: "confirmation" }>

const argsSummary = (part: ConfirmPart): string => {
	const args = part.args
	if (!args || typeof args !== "object") return ""
	const record = args as Record<string, unknown>
	if (part.tool === "canvas_cli") {
		const command = String(record.command || "")
		const inner = record.args && typeof record.args === "object" ? (record.args as Record<string, unknown>) : {}
		const detail = Object.values(inner).find((value) => typeof value === "string" && value.trim())
		return [command, detail ? String(detail).slice(0, 36) : ""].filter(Boolean).join(" · ")
	}
	for (const key of ["node_id", "title", "name", "path", "filename", "instructions", "description", "prompt", "text", "command"]) {
		const value = record[key]
		if (typeof value === "string" && value.trim()) return value.slice(0, 48)
	}
	return ""
}

const titleFor = (part: ConfirmPart): string => {
	if (part.confirmKind === "delete") return "这一步会删除内容"
	if (part.confirmKind === "budget") return "需要追加确认"
	return "这一步需要你确认"
}

const resolvedText: Record<string, string> = {
	executed: "已执行",
	skipped: "已跳过",
	cancelled: "已取消",
}

export const QuestionCard = ({ part, store }: { part: ConfirmPart; store: AssistantStore }) => {
	const resolved = part.status !== "pending"
	if (resolved) {
		return (
			<div className={cn("nvca-question is-resolved", "is-" + part.status)} data-confirm-id={part.id}>
				<span className="nvca-question-resolved-icon">
					{part.status === "executed" ? <CheckIcon className="nvca-i-xs" /> : part.status === "skipped" ? <SkipForwardIcon className="nvca-i-xs" /> : <XIcon className="nvca-i-xs" />}
				</span>
				<span className="nvca-question-resolved-text">{resolvedText[part.status] || part.status}</span>
				<span className="nvca-question-resolved-tool">{toolDisplayName(part.tool)}</span>
			</div>
		)
	}
	const summary = argsSummary(part)
	return (
		<div className="nvca-question" data-confirm-id={part.id}>
			<div className="nvca-question-head">
				<MessageCircleQuestionIcon className="nvca-i-sm" />
				<span className="nvca-question-title">{titleFor(part)}</span>
			</div>
			{part.reason ? <p className="nvca-question-reason">{part.reason}</p> : null}
			<div className="nvca-question-step">
				<span className="nvca-question-tool">{toolDisplayName(part.tool)}</span>
				{summary ? <span className="nvca-question-args">{summary}</span> : null}
			</div>
			<div className="nvca-question-actions">
				<button className="nvca-question-btn primary" onClick={() => store.executeConfirmation(part.id)} type="button">
					执行这一步
				</button>
				<button className="nvca-question-btn" onClick={() => store.skipConfirmation(part.id)} type="button">
					跳过
				</button>
				<button className="nvca-question-btn danger" onClick={() => store.cancelConfirmation(part.id)} type="button">
					取消本轮
				</button>
			</div>
		</div>
	)
}
