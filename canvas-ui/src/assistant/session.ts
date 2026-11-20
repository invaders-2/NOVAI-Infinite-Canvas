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

type ThinkingPart = Extract<Part, { type: "thinking" }>
type TextPart = Extract<Part, { type: "text" }>

const lastPartOf = <T extends Part["type"]>(message: Message, type: T): Extract<Part, { type: T }> | null => {
	for (let i = message.parts.length - 1; i >= 0; i -= 1) {
		const part = message.parts[i]
		if (part.type === type) return part as Extract<Part, { type: T }>
	}
	return null
}

const lastStreamedText = (message: Message): TextPart | null => {
	for (let i = message.parts.length - 1; i >= 0; i -= 1) {
		const part = message.parts[i]
		if (part.type === "text" && part.streamed) return part
	}
	return null
}

const ensureThinkingPart = (message: Message, at: number): ThinkingPart => {
	let part = lastPartOf(message, "thinking")
	if (!part) {
		part = { type: "thinking", id: uid("part"), text: "", totalDurationMs: 0, streaming: true, startedAt: at, segments: [] }
		message.parts.push(part)
	} else {
		if (!part.segments) part.segments = part.text ? [{ kind: "base", round: 0, text: part.text }] : []
		if (!part.startedAt) part.startedAt = at
		part.streaming = true
	}
	return part
}

/* 同一轮里只要出现 reasoning_delta，这一轮的 thought 短句就不进正文（中英草稿不混排）；
   没有 reasoning_delta 的轮次，thought 按行拼成正文（兼容只出短句的模型）。 */
const recomputeThinking = (part: ThinkingPart) => {
	const segments = part.segments
	if (!segments) return
	const reasoned = new Set<number>()
	for (const segment of segments) {
		if (segment.kind === "reasoning") reasoned.add(segment.round)
	}
	let text = ""
	let previous = ""
	for (const segment of segments) {
		if (!segment.text) continue
		if (segment.kind === "thought" && reasoned.has(segment.round)) continue
		if (text && (segment.kind === "thought" || previous === "thought" || segment.kind === "base" || previous === "base")) text += "\n"
		text += segment.text
		previous = segment.kind
	}
	part.text = text
}

const appendReasoningDelta = (message: Message, text: string, at: number, round: number) => {
	const part = ensureThinkingPart(message, at)
	const segments = part.segments || []
	const last = segments[segments.length - 1]
	if (last && last.kind === "reasoning" && last.round === round) last.text += text
	else segments.push({ kind: "reasoning", round, text })
	part.segments = segments
	recomputeThinking(part)
}

const appendThought = (message: Message, text: string, at: number, round: number) => {
	const part = ensureThinkingPart(message, at)
	const segments = part.segments || []
	segments.push({ kind: "thought", round, text })
	part.segments = segments
	recomputeThinking(part)
}

const finalizeThinkingPart = (part: ThinkingPart, at: number, hard: boolean) => {
	if (part.segments) recomputeThinking(part)
	const elapsed = part.startedAt ? Math.max(0, at - part.startedAt) : 0
	if (part.streaming) {
		part.streaming = false
		part.endedAt = at
	}
	/* soft：正文开始流出时先停光标；hard：done/error 时按「首个思考事件 → done」定格 */
	if (hard && !part.durationLocked) {
		part.totalDurationMs = Math.max(Number(part.totalDurationMs) || 0, elapsed)
		part.durationLocked = true
	} else if (!hard && (part.totalDurationMs === undefined || part.totalDurationMs === 0)) {
		part.totalDurationMs = elapsed
	}
}

const finalizeThinkingIn = (message: Message, at: number, hard: boolean) => {
	for (const part of message.parts) {
		if (part.type === "thinking") finalizeThinkingPart(part, at, hard)
	}
}

/* 正文开始流出：思考正文停止流式（标题不再 Shimmer），但时长等 done 再定格 */
const endThinkingStream = (message: Message, at: number) => {
	for (const part of message.parts) {
		if (part.type === "thinking" && part.streaming) finalizeThinkingPart(part, at, false)
	}
}

/* abort 等没有 done/error 的结束路径：把还在流的思考定格，不然标题会永远停在「思考中…」 */
export const finishStreaming = (state: SessionState, at = now()) => {
	for (const message of state.messages) finalizeThinkingIn(message, at, true)
}

const appendTextDelta = (message: Message, text: string): TextPart => {
	/* 整个 run 只维护一个流式正文 part：几百条 delta 合并进去，不按帧新建 part */
	const existing = lastStreamedText(message)
	if (existing) {
		existing.text += text
		return existing
	}
	const last = message.parts[message.parts.length - 1]
	if (last && last.type === "text") {
		last.text += text
		last.streamed = true
		return last
	}
	const part: TextPart = { type: "text", id: uid("part"), text, streamed: true }
	message.parts.push(part)
	return part
}

const applyWholeThinking = (state: SessionState, raw: string, at: number, duration: number) => {
	const text = String(raw ?? "")
	if (!text.trim()) return
	const message = ensureAssistant(state)
	const part = ensureThinkingPart(message, at)
	const segments = part.segments || []
	segments.push({ kind: "base", round: 0, text })
	part.segments = segments
	recomputeThinking(part)
	part.totalDurationMs = Math.max(Number(part.totalDurationMs) || 0, Number(duration) || 0)
	if (duration > 0) part.durationLocked = true
	part.streaming = false
	part.endedAt = at
}

/* message / done.message 是最终文本：已经通过 message_delta 流式累加过就只做收尾，不再追加一遍 */
const applyFinalText = (state: SessionState, message: Message, raw: string) => {
	const text = String(raw ?? "")
	const clean = text.trim()
	if (!clean) return
	const streamed = lastStreamedText(message)
	if (streamed) {
		/* 最终文本是权威版本：直接收尾替换，绝不再追加一遍 */
		if (streamed.text !== text) streamed.text = text
		return
	}
	const spoken = message.parts.some((part) => part.type === "text" && part.text.trim() === clean)
	if (!spoken) appendPart(state, message, { type: "text", id: uid("part"), text })
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
		/* 上一轮如果没收到 done/error（断流），先把还在流的思考定格 */
		finishStreaming(state)
		const previous = state.messages[state.messages.length - 1]
		const visionOnly = previous?.role === "assistant" && !previous.runId && previous.parts.length > 0 && previous.parts.every((part) => part.type === "vision")
		const assistant = visionOnly ? previous : pushAssistant(state)
		state.streamingMessageId = assistant.id
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
			args: data.args && typeof data.args === "object" ? clone(data.args) : undefined,
			result: data.result === undefined ? undefined : clone(data.result),
			payload: data.payload && typeof data.payload === "object" ? clone(data.payload) : undefined,
		}
		appendPart(state, ensureAssistant(state), part)
		return state
	}

	if (type === "vision") {
		const labels = Array.isArray(data.labels) ? data.labels.map(String).filter(Boolean) : []
		appendPart(state, ensureAssistant(state), {
			type: "vision",
			id: uid("part"),
			mode: String(data.mode || ""),
			labels,
			text: String(data.text || ""),
		})
		return state
	}

	if (type === "thinking") {
		applyWholeThinking(state, String(data.text ?? ""), now(), Number(data.duration_ms || data.totalDurationMs) || 0)
		return state
	}

	if (type === "reasoning_delta") {
		const text = String(data.text ?? "")
		if (text) appendReasoningDelta(ensureAssistant(state), text, now(), Number(data.round) || 0)
		return state
	}

	if (type === "thought") {
		const text = String(data.text ?? "").trim()
		if (text) appendThought(ensureAssistant(state), text, now(), Number(data.round) || 0)
		return state
	}

	if (type === "message_delta") {
		const text = String(data.text ?? "")
		if (!text) return state
		const message = ensureAssistant(state)
		endThinkingStream(message, now())
		appendTextDelta(message, text)
		return state
	}

	if (type === "message") {
		const text = String(data.text ?? "")
		if (!text.trim()) return state
		const at = now()
		if (String(data.kind || "") === "thinking") {
			applyWholeThinking(state, text, at, Number(data.duration_ms) || 0)
		} else {
			const message = ensureAssistant(state)
			endThinkingStream(message, at)
			applyFinalText(state, message, text)
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
		if (data.run_id) message.runId = String(data.run_id)
		if (data.changes && typeof data.changes === "object") {
			const changes = data.changes as Record<string, unknown>
			message.changes = {
				nodes_created: Number(changes.nodes_created) || 0,
				nodes_modified: Number(changes.nodes_modified) || 0,
				nodes_deleted: Number(changes.nodes_deleted) || 0,
				connections: Number(changes.connections) || 0,
				generations: Number(changes.generations) || 0,
			}
		}
		const status = normalizeDone(data)
		state.streamState = status
		message.status = status
		finalizeThinkingIn(message, now(), true)
		/* 纯问答时 message / message_delta 与 done.message 是同一段文本，别在气泡里重复一遍 */
		applyFinalText(state, message, String(data.message || ""))
		message.activeWorkMs = freezeActivity(state)
		appendPart(state, message, { type: "run_outcome", id: uid("part"), status, activeWorkMs: message.activeWorkMs, steps: Number(data.steps_executed) || 0 })
		state.streamingMessageId = null
		state.pendingConfirmation = null
		return state
	}

	if (type === "error") {
		const message = ensureAssistant(state)
		finalizeThinkingIn(message, now(), true)
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
