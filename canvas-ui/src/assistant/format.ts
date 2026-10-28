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
	run_generation: "生成",
	write_html_report: "写 HTML 报告",
	write_xlsx: "写 Excel",
	read_table: "读取表格",
	canvas_cli: "画布 CLI",
	node_create: "新建节点",
	node_update: "修改节点",
	node_delete: "删除节点",
	node_connect: "连接节点",
	read_file: "读取文件",
	write_file: "写文件",
	activate_skill: "启用技能",
	ask_user: "询问用户",
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
	visions: Extract<Part, { type: "vision" }>[]
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
		visions: [],
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
		} else if (part.type === "vision") {
			run.visions.push(part)
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

const CANVAS_READ_TOOLS = new Set(["get_canvas", "list_canvases", "use_asset"])
const DOCUMENT_TOOLS = new Set(["read_file", "read_table"])
const CANVAS_WRITE_TOOLS = new Set(["create_node", "update_node", "delete_node", "connect_nodes", "disconnect_nodes", "arrange_canvas", "node_create", "node_update", "node_delete", "node_connect"])
const GENERATION_TOOLS = new Set(["generate_image", "generate_video", "run_generation", "run_batch"])

export const runSummary = (run: DerivedRun): string => {
	const imageLabels = new Set<string>()
	run.visions.forEach((vision) => {
		if (vision.mode === "direct" || vision.mode === "caption") vision.labels.forEach((label) => imageLabels.add(label))
	})
	const parts = [...run.tools, ...run.steps]
	const completed = parts.filter((part) => part.status === "done" || part.ok === true)
	const reads = completed.filter((part) => CANVAS_READ_TOOLS.has(part.tool)).length
	const writes = completed.filter((part) => CANVAS_WRITE_TOOLS.has(part.tool)).length
	const documents = completed.filter((part) => part.tool === "read_file" || part.tool === "read_table").length
	const generations = completed.filter((part) => GENERATION_TOOLS.has(part.tool)).length
	const deletes = completed.filter((part) => part.tool === "delete_node" || part.tool === "node_delete").length
	if (deletes > 0 && writes === deletes && reads === 0 && generations === 0) return "编辑了画布"
	const summary: string[] = []
	if (imageLabels.size) summary.push("看了 " + imageLabels.size + " 张图")
	if (writes) summary.push("修改画布 " + writes + " 次")
	if (reads) summary.push("查看画布 " + reads + " 次")
	if (documents) summary.push("读了 " + documents + " 个文档")
	if (generations) summary.push("提交了 " + generations + " 个生成")
	const others = completed.filter((part) => !CANVAS_READ_TOOLS.has(part.tool) && !CANVAS_WRITE_TOOLS.has(part.tool) && !GENERATION_TOOLS.has(part.tool) && !DOCUMENT_TOOLS.has(part.tool)).length
	if (others) summary.push("完成了 " + others + " 个操作")
	return summary.join("，")
}

export const liveToolLabel = (run: DerivedRun): string => {
	const active = [...run.tools, ...run.steps].reverse().find((part) => part.status === "running")
	if (!active) return ""
	if (active.tool === "delete_node" || active.tool === "node_delete" || active.tool === "update_node" || active.tool === "node_update") return "正在编辑画布"
	if (active.tool === "arrange_canvas") return "正在选择节点"
	if (active.tool === "connect_nodes" || active.tool === "node_connect" || active.tool === "get_canvas") return "读取节点"
	return active.title || toolLabel(active.tool)
}

export interface MessageNodeRef {
	id: string
	label: string
}

export const messageNodeRefs = (message: Message): MessageNodeRef[] => {
	const refs: MessageNodeRef[] = []
	const seen = new Set<string>()
	const add = (id: unknown, label?: unknown) => {
		const value = String(id || "").trim()
		if (!value || seen.has(value)) return
		seen.add(value)
		refs.push({ id: value, label: String(label || value) })
	}
	const walk = (value: unknown, key = "", depth = 0) => {
		if (depth > 6 || value == null) return
		if (Array.isArray(value)) {
			if (["node_ids", "nodeIds", "inputs"].includes(key)) value.forEach((item) => add(item))
			else value.forEach((item) => walk(item, key, depth + 1))
			return
		}
		if (typeof value !== "object") return
		const record = value as Record<string, unknown>
		for (const [childKey, child] of Object.entries(record)) {
			if (["node_id", "nodeId", "from", "to", "input_node_id", "output_node_id"].includes(childKey)) add(child)
			else if (["node_ids", "nodeIds", "inputs"].includes(childKey)) walk(child, childKey, depth + 1)
			else if (child && typeof child === "object") walk(child, childKey, depth + 1)
		}
		if (record.id && (record.alias || record.title || record.type)) add(record.id, record.alias || record.title)
	}
	message.parts.forEach((part) => {
		if (part.type !== "tool_event") return
		walk(part.args)
		walk(part.result)
		walk(part.payload)
	})
	return refs.slice(0, 8)
}

export const formatBytes = (bytes: number): string => {
	const value = Number(bytes)
	if (!Number.isFinite(value) || value <= 0) return "0 B"
	if (value < 1024) return Math.round(value) + " B"
	if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + " KB"
	return (value / (1024 * 1024)).toFixed(1) + " MB"
}

export const formatRelative = (seconds: number): string => {
	const value = Number(seconds)
	if (!Number.isFinite(value) || value <= 0) return ""
	const diff = Math.max(0, Date.now() / 1000 - value)
	if (diff < 60) return "刚刚"
	if (diff < 3600) return Math.floor(diff / 60) + " 分钟前"
	if (diff < 86400) return Math.floor(diff / 3600) + " 小时前"
	if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前"
	return new Date(value * 1000).toLocaleDateString("zh-CN")
}

export const ARTIFACT_GROUPS: { kind: string; label: string }[] = [
	{ kind: "html", label: "HTML 报告" },
	{ kind: "xlsx", label: "Excel 表格" },
	{ kind: "csv", label: "CSV 数据" },
	{ kind: "md", label: "文档" },
	{ kind: "image", label: "图片" },
]

export const SECTION_LABELS: Record<string, string> = {
	role: "角色设定",
	canvas: "画布快照",
	files: "上传文件",
	tools: "工具清单",
	history: "历史对话",
	skill_index: "技能索引",
	skill_manual: "技能手册",
	store_skill_manual: "商店技能手册",
}

export const sectionLabel = (raw: string): string => {
	const key = String(raw || "")
	if (SECTION_LABELS[key]) return SECTION_LABELS[key]
	if (key.startsWith("skill_manual:")) return "技能手册 · " + key.slice("skill_manual:".length)
	if (key.startsWith("store_skill_manual:")) return "商店技能手册 · " + key.slice("store_skill_manual:".length)
	return key || "其他"
}
