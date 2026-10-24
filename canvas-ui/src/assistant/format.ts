import type { Message, Part } from "./types"

export const formatWorkMs = (ms: number): string => {
	const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
	if (total < 60) return total + "s"
	if (total < 3600) {
		const seconds = total % 60
		return Math.floor(total / 60) + "m" + (seconds < 10 ? "0" : "") + seconds + "s"
	}
	const minutes = Math.floor((total % 3600) / 60)
	return Math.floor(total / 3600) + "h" + (minutes < 10 ? "0" : "") + minutes + "m"
}

export const formatTokens = (count?: number): string => {
	const n = Number(count)
	if (!Number.isFinite(n) || n < 0) return "0"
	if (n < 1000) return String(Math.floor(n))
	if (n < 1000000) return (n / 1000).toFixed(1) + "k"
	return (n / 1000000).toFixed(1) + "m"
}

export const STATUS_LABEL: Record<string, string> = {
	idle: "连接中…",
	streaming: "正在执行…",
	running: "正在执行…",
	waiting_user_input: "等你确认",
	waiting_external: "等你确认",
	completed: "已完成",
	stopped: "已停止",
	failed: "失败",
	ended_unknown: "已结束",
}

export const statusLabel = (status: string, fallback = "处理中…"): string =>
	STATUS_LABEL[String(status || "")] || fallback

export const TOOL_LABELS: Record<string, string> = {
	create_node: "新建节点",
	update_node: "修改节点",
	delete_node: "删除节点",
	connect_nodes: "连接节点",
	disconnect_nodes: "断开连线",
	arrange_canvas: "整理画布",
	generate_image: "生成图片",
	generate_video: "生成视频",
	run_generation: "重新生成",
	batch_generate: "批量生成",
	run_batch: "批量运行",
	run_downstream: "顺序运行",
	check_task: "查看进度",
	get_canvas: "读取画布",
	list_canvases: "浏览画布",
	use_asset: "查找素材",
	refine_prompt: "润色提示词",
	remember: "记住偏好",
	forget: "忘记偏好",
	list_templates: "查看模板",
	save_template: "保存模板",
	apply_template: "套用模板",
}

export const toolLabel = (tool: string): string => {
	const key = String(tool || "")
	return TOOL_LABELS[key] || (key ? key.replace(/_/g, " ") : "执行步骤")
}

export const toolIconKey = (tool: string): string => {
	if (tool === "generate_image" || tool === "use_asset") return "image"
	if (tool === "generate_video" || tool === "run_generation") return "clapperboard"
	if (tool === "create_node") return "plus"
	if (tool === "update_node" || tool === "refine_prompt") return "pencil"
	if (tool === "delete_node") return "trash"
	if (tool === "connect_nodes" || tool === "disconnect_nodes") return "link"
	if (tool === "check_task") return "check"
	if (tool === "get_canvas" || tool === "list_canvases") return "scan"
	if (tool === "arrange_canvas") return "layout"
	if (tool === "remember" || tool === "forget") return "brain"
	if (tool === "batch_generate" || tool === "run_batch" || tool === "run_downstream") return "layers"
	return "wrench"
}

export interface DerivedRun {
	texts: { id: string; text: string }[]
	thinking: { id: string; text: string; durationMs: number } | null
	steps: Extract<Part, { type: "tool_event" }>[]
	tools: Extract<Part, { type: "tool_event" }>[]
	usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null
	outcome: { status: string; activeWorkMs: number } | null
	steers: { id: string; text: string; status: string }[]
	contextNodes: number
	error: { message: string; code: string } | null
}

export const deriveRun = (message: Message): DerivedRun => {
	const run: DerivedRun = {
		texts: [],
		thinking: null,
		steps: [],
		tools: [],
		usage: null,
		outcome: null,
		steers: [],
		contextNodes: 0,
		error: null,
	}
	for (const part of message.parts) {
		if (part.type === "text") {
			if (part.text.trim()) run.texts.push({ id: part.id, text: part.text })
		} else if (part.type === "thinking") {
			if (!run.thinking) run.thinking = { id: part.id, text: part.text, durationMs: part.totalDurationMs }
			else {
				run.thinking.text += part.text
				run.thinking.durationMs += part.totalDurationMs
			}
		} else if (part.type === "tool_event") {
			if (part.kind === "step") run.steps.push(part)
			else run.tools.push(part)
		} else if (part.type === "usage") {
			run.usage = part.usage
		} else if (part.type === "run_outcome") {
			run.outcome = { status: part.status, activeWorkMs: part.activeWorkMs }
		} else if (part.type === "user_steer") {
			run.steers.push({ id: part.id, text: part.text, status: part.status })
		} else if (part.type === "context_nodes") {
			run.contextNodes += Number(part.nodeCount) || 0
		} else if (part.type === "agent_error") {
			run.error = { message: part.message, code: part.code }
		}
	}
	return run
}
