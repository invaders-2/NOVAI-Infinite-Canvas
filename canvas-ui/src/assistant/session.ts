import type { Message, Part, PlanData, StreamEvent, UsageTotals } from "./types"

// 事件 → 会话状态的移植版（对齐 static/js/shared/agent-session.js 的 part 语义，
// 只保留渲染需要的字段；宿主仍然用它自己的状态机渲染旧面板，两边互不影响）。

const TERMINAL = ["completed", "failed", "stopped", "ended_unknown"]
const WAITING = ["waiting_user_input", "waiting_external"]
const DONE_STATUS: Record<string, string> = {
	ok: "completed",
	completed: "completed",
	success: "completed",
	failed: "failed",
	fail: "failed",
	error: "failed",
	aborted: "stopped",
	stopped: "stopped",
	canceled: "stopped",
	cancelled: "stopped",
	ended_unknown: "ended_unknown",
}

let seq = 0
const uid = (prefix: string) => {
	seq += 1
	return prefix + "_" + Date.now().toString(36) + "_" + seq
}

export const isWaiting = (status: string) => WAITING.indexOf(String(status || "")) !== -1
export const isTerminal = (status: string) => TERMINAL.indexOf(String(status || "")) !== -1

const clone = <T,>(value: T): T => {
	if (value === null || typeof value !== "object") return value
	try {
		return JSON.parse(JSON.stringify(value)) as T
	} catch {
		return value
	}
}

export interface SessionState {
	streamState: string
	runId: string
	messages: Message[]
	streamingMessageId: string | null
	runActivity: { startedAt: number; frozenMs: number; frozen: boolean } | null
	contextUsage: { used_tokens?: number; max_tokens?: number; percentage?: number } | null
	contextNodeIds: string[]
	pendingConfirmation: Record<string, unknown> | null
}

export const createSession = (): SessionState => ({
	streamState: "idle",
	runId: "",
	messages: [],
	streamingMessageId: null,
	runActivity: null,
	contextUsage: null,
	contextNodeIds: [],
	pendingConfirmation: null,
})

const now = () => Date.now()

const pushAssistant = (state: SessionState): Message => {
	const at = now()
	const message: Message = {
		id: uid("msg"),
		role: "assistant",
		parts: [],
		status: "",
		activeWorkMs: 0,
		createdAt: at,
		planState: "",
	}
	state.messages.push(message)
	state.streamingMessageId = message.id
	return message
}

const currentAssistant = (state: SessionState): Message | null =>
	(state.streamingMessageId && state.messages.find((m) => m.id === state.streamingMessageId)) || null

const ensureAssistant = (state: SessionState): Message => currentAssistant(state) || pushAssistant(state)

const appendPart = (state: SessionState, message: Message, part: Part): Part => {
	const last = message.parts[message.parts.length - 1]
	if (part.type === "text" && last && last.type === "text" && part.text.trim()) {
		last.text = last.text + part.text
		return last
	}
	if (part.type === "thinking" && last && last.type === "thinking") {
		last.text = last.text + part.text
		last.totalDurationMs = (Number(last.totalDurationMs) || 0) + (Number(part.totalDurationMs) || 0)
		return last
	}
	if (!part.id) part.id = uid("part")
	message.parts.push(part)
	return part
}

const stepKey = (data: Record<string, unknown>) =>
	data.index === undefined || data.index === null || data.index === "" ? "" : String(data.index)

const findStep = (message: Message, key: string): Part | null => {
	if (key) {
		for (let i = 0; i < message.parts.length; i += 1) {
			const part = message.parts[i]
			if (part.type === "tool_event" && part.kind === "step" && String(part.index ?? "") === key) return part
		}
		return null
	}
	for (let i = message.parts.length - 1; i >= 0; i -= 1) {
		const part = message.parts[i]
		if (part.type === "tool_event" && part.kind === "step") return part
	}
	return null
}

const upsertStep = (state: SessionState, message: Message, data: Record<string, unknown>, phase: "start" | "result"): Part => {
	const at = now()
	const key = stepKey(data)
	let part = findStep(message, key)
	if (!part || part.type !== "tool_event") {
		part = {
			type: "tool_event",
			id: uid("part"),
			kind: "step",
			index: key,
			tool: "",
			title: "",
			status: "",
			message: "",
			startedAt: at,
			endedAt: 0,
		}
		message.parts.push(part)
	}
	if (data.tool) part.tool = String(data.tool)
	if (data.description && !part.title) part.title = String(data.description)
	if (data.args && typeof data.args === "object") part.args = clone(data.args)
	if (phase === "start") {
		part.status = "running"
		if (!part.startedAt) part.startedAt = at
	} else {
		part.status = data.ok ? "done" : "failed"
		part.ok = Boolean(data.ok)
		part.endedAt = at
		if (data.message) part.message = String(data.message)
		else if (data.error) part.message = String(data.error)
		if (data.code) part.code = String(data.code)
		if (data.result !== undefined) part.result = clone(data.result)
		if (typeof data.output === "string") part.output = data.output
		else if (data.output !== undefined) part.output = JSON.stringify(data.output, null, 2)
		if (data.canvas_ops !== undefined) part.payload = clone(data.canvas_ops)
	}
	return part
}

const usageOf = (data: Record<string, unknown>): UsageTotals | null => {
	if (data.usage && typeof data.usage === "object") return clone(data.usage as UsageTotals)
	const keys: (keyof UsageTotals)[] = [
		"input_tokens",
		"output_tokens",
		"total_tokens",
		"cached_tokens",
		"cache_read_tokens",
		"cache_write_tokens",
		"reasoning_tokens",
	]
	const usage: UsageTotals = {}
	let found = false
	for (const key of keys) {
		if (typeof data[key] === "number") {
			usage[key] = data[key] as number
			found = true
		}
	}
	return found ? usage : null
}

const activityElapsed = (activity: SessionState["runActivity"], at: number) => {
	if (!activity) return 0
	if (activity.frozen) return Number(activity.frozenMs) || 0
	return (Number(activity.frozenMs) || 0) + Math.max(0, at - (Number(activity.startedAt) || at))
}

const freezeActivity = (state: SessionState) => {
	const activity = state.runActivity
	if (!activity) return 0
	if (!activity.frozen) {
		activity.frozenMs = activityElapsed(activity, now())
		activity.startedAt = now()
		activity.frozen = true
	}
	return Number(activity.frozenMs) || 0
}

export const workMs = (state: SessionState, at = now()) => {
	if (!state.runActivity) return 0
	if (isWaiting(state.streamState) || isTerminal(state.streamState) || state.runActivity.frozen) {
		return Number(state.runActivity.frozenMs) || 0
	}
	return activityElapsed(state.runActivity, at)
}

const normalizeDone = (data: Record<string, unknown>): string => {
	const raw = String(data.status || data.state || "completed").toLowerCase()
	if (DONE_STATUS[raw]) return DONE_STATUS[raw]
	return isTerminal(raw) ? raw : "ended_unknown"
}

export const applyEvent = (state: SessionState, event: StreamEvent): SessionState => {
	if (!event) return state
	const type = String(event.type || event.event || event.name || "")
	const data: Record<string, unknown> = event.data && typeof event.data === "object" ? event.data : (event as Record<string, unknown>)

	if (type === "run_start") {
		const assistant = pushAssistant(state)
		assistant.status = "streaming"
		state.streamState = "streaming"
		state.runId = String(data.run_id || data.runId || "")
		assistant.runId = state.runId
		const baseline = state.runActivity && state.runActivity.frozen ? Number(state.runActivity.frozenMs) || 0 : 0
		state.runActivity = { startedAt: now(), frozenMs: baseline, frozen: false }
		state.pendingConfirmation = null
		return state
	}

	if (type === "plan") {
		const steps = Array.isArray(data.steps) ? (data.steps as PlanData["steps"]) : []
		const plan: PlanData = {
			intent: String(data.intent || ""),
			summary: String(data.summary || ""),
			steps,
			requiresConfirmation: Boolean(data.requires_confirmation),
			round: Number(data.round) || 0,
			impact: (data.impact as PlanData["impact"]) || null,
		}
		const previous = [...state.messages]
			.reverse()
			.find((item) => item.plan && item.id !== state.streamingMessageId)
		/* 执行轮的 plan 会给每步补 index，比较时忽略它 */
		const stepKey = (list: PlanData["steps"]) => JSON.stringify((list || []).map((step) => [step.tool, step.args, step.description || ""]))
		const echo = previous && stepKey(previous.plan?.steps) === stepKey(plan.steps)
		if (echo) {
			/* 执行轮会把同一批步骤再广播一次 plan：沿用已确认的那张卡，不要长出新方案 */
			return state
		}
		const message = ensureAssistant(state)
		message.plan = plan
		message.planState = "pending"
		if (plan.requiresConfirmation) {
			state.pendingConfirmation = { kind: "plan", steps }
			state.streamState = "waiting_user_input"
			message.status = "waiting_user_input"
			freezeActivity(state)
		}
		return state
	}

	if (type === "step_start") {
		upsertStep(state, ensureAssistant(state), data, "start")
		return state
	}
	if (type === "step_result") {
		upsertStep(state, ensureAssistant(state), data, "result")
		return state
	}

	if (type === "tool_event") {
		const part: Part = {
			type: "tool_event",
			id: uid("part"),
			kind: data.kind ? String(data.kind) : "tool",
			tool: String(data.tool || data.name || ""),
			title: String(data.description || data.title || ""),
			status: String(data.status || "") as "" | "running" | "done" | "failed",
			message: String(data.message || ""),
			payload: data.payload && typeof data.payload === "object" ? clone(data.payload) : undefined,
		}
		appendPart(state, ensureAssistant(state), part)
		return state
	}

	if (type === "thinking") {
		const text = String(data.text ?? "")
		if (text.trim()) appendPart(state, ensureAssistant(state), { type: "thinking", id: uid("part"), text, totalDurationMs: Number(data.duration_ms || data.totalDurationMs) || 0 })
		return state
	}

	if (type === "message") {
		const text = String(data.text ?? "")
		if (!text.trim()) return state
		if (String(data.kind || "") === "thinking") {
			appendPart(state, ensureAssistant(state), { type: "thinking", id: uid("part"), text, totalDurationMs: Number(data.duration_ms) || 0 })
		} else {
			appendPart(state, ensureAssistant(state), { type: "text", id: uid("part"), text })
		}
		return state
	}

	if (type === "usage") {
		const usage = usageOf(data)
		if (usage) appendPart(state, ensureAssistant(state), { type: "usage", id: uid("part"), usage })
		return state
	}

	if (type === "context_usage") {
		const source = data.context_usage && typeof data.context_usage === "object" ? (data.context_usage as Record<string, unknown>) : data
		const usage: SessionState["contextUsage"] = {}
		if (typeof source.used_tokens === "number") usage.used_tokens = source.used_tokens
		if (typeof source.max_tokens === "number") usage.max_tokens = source.max_tokens
		if (typeof source.percentage === "number") usage.percentage = source.percentage
		if (Object.keys(usage).length) state.contextUsage = usage
		return state
	}

	if (type === "context_nodes") {
		const ids = Array.isArray(data.node_ids) ? data.node_ids : Array.isArray(data.ids) ? data.ids : null
		if (ids) {
			state.contextNodeIds = ids.map(String)
			appendPart(state, ensureAssistant(state), {
				type: "context_nodes",
				id: uid("part"),
				nodeIds: state.contextNodeIds,
				nodeCount: state.contextNodeIds.length,
			})
		}
		return state
	}

	if (type === "confirmation_required" || type === "confirm_required") {
		state.pendingConfirmation = clone(data)
		state.streamState = "waiting_user_input"
		const message = ensureAssistant(state)
		message.status = "waiting_user_input"
		const args = data.args && typeof data.args === "object" ? clone(data.args) : undefined
		message.parts.push({
			type: "confirmation",
			id: uid("part"),
			index: data.index === undefined || data.index === null ? "" : String(data.index),
			tool: String(data.tool || ""),
			args,
			reason: String(data.reason || ""),
			confirmKind: String(data.confirm_kind || ""),
			units: Number(data.units) || 0,
			description: String(data.description || ""),
			status: "pending",
		})
		freezeActivity(state)
		return state
	}

	if (type === "user_steer") {
		const text = String(data.text || data.message || "")
		if (text.trim()) appendPart(state, ensureAssistant(state), { type: "user_steer", id: uid("part"), text, status: String(data.status || "") })
		return state
	}

	if (type === "done") {
		const message = ensureAssistant(state)
		const status = normalizeDone(data)
		state.streamState = status
		message.status = status
		const doneText = String(data.message || "").trim()
		/* 纯问答时 message 事件与 done.message 是同一段文本，别在气泡里重复一遍 */
		const alreadySpoken = doneText && message.parts.some(
			(part) => part.type === "text" && part.text.trim() === doneText,
		)
		if (doneText && !alreadySpoken) appendPart(state, message, { type: "text", id: uid("part"), text: doneText })
		message.activeWorkMs = freezeActivity(state)
		appendPart(state, message, { type: "run_outcome", id: uid("part"), status, activeWorkMs: message.activeWorkMs, steps: Number(data.steps_executed) || 0 })
		state.streamingMessageId = null
		state.pendingConfirmation = null
		return state
	}

	if (type === "error") {
		const message = ensureAssistant(state)
		state.streamState = "failed"
		message.status = "failed"
		appendPart(state, message, { type: "agent_error", id: uid("part"), message: String(data.message || data.error || "未知错误"), code: data.code ? String(data.code) : "" })
		message.activeWorkMs = freezeActivity(state)
		appendPart(state, message, { type: "run_outcome", id: uid("part"), status: "failed", activeWorkMs: message.activeWorkMs, steps: 0 })
		state.streamingMessageId = null
		state.pendingConfirmation = null
		return state
	}

	return state
}
