import type {
	ArtifactItem,
	CanvasAssistantHandle,
	CanvasAssistantHostApi,
	ContextUsage,
	Message,
	RefChip,
	SkillChip,
	StreamEvent,
} from "./types"
import { applyEvent, createSession, isTerminal, workMs } from "./session"

export interface EnvState {
	running: boolean
	streamState: string
	planConfirm: boolean
	refs: RefChip[]
	skills: SkillChip[]
	selectedSkillId: string | null
	contextUsage: ContextUsage | null
	artifacts: ArtifactItem[]
	steerPending: boolean
	notice: string
}

export interface AssistantStore {
	version: number
	state: ReturnType<typeof createSession>
	env: EnvState
	subscribe(listener: () => void): () => void
	getVersion(): number
	send(text: string): void
	abort(): void
	steer(text: string): void
	chooseSkill(id: string): void
	clearSkill(): void
	removeRef(id: string): void
	clearRefs(): void
	planAction(action: "run" | "cancel" | "adjust"): void
	confirmAction(yes: boolean): void
	togglePlanConfirm(): void
	openHistory(): void
	openNode(id: string): void
	clearHistory(): void
	destroy(): void
}

const uid = (() => {
	let n = 0
	return (prefix: string) => {
		n += 1
		return prefix + "_" + Date.now().toString(36) + "_" + n
	}
})()

const historyMessage = (role: string, text: string): Message => {
	const clean = String(text || "")
	const resolved = role === "user" ? "user" : role === "system" ? "system" : "assistant"
	return {
		id: uid("msg"),
		role: resolved,
		parts: [{ type: "text", id: uid("part"), text: clean }],
		status: "",
		activeWorkMs: 0,
		createdAt: Date.now(),
		planState: "",
	}
}

export const createAssistant = (api: CanvasAssistantHostApi): { store: AssistantStore; handle: CanvasAssistantHandle } => {
	const state = createSession()
	const env: EnvState = {
		running: false,
		streamState: "idle",
		planConfirm: true,
		refs: [],
		skills: [],
		selectedSkillId: null,
		contextUsage: null,
		artifacts: [],
		steerPending: false,
		notice: "",
	}
	const listeners = new Set<() => void>()
	let version = 0
	let destroyed = false
	const emit = () => {
		if (destroyed) return
		version += 1
		for (const listener of listeners) listener()
	}

	const pushNotice = (text: string) => {
		env.notice = text
		emit()
	}

	const store: AssistantStore = {
		get version() {
			return version
		},
		state,
		env,
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		getVersion() {
			return version
		},
		send(text) {
			const value = String(text || "").trim()
			if (!value) return
			env.running = true
			env.streamState = "streaming"
			state.streamState = "streaming"
			state.messages.push(historyMessage("user", value))
			emit()
			try {
				const result = api.send(value)
				if (result && typeof (result as Promise<boolean>).then === "function") {
					(result as Promise<boolean>).then((ok) => {
						if (!ok) {
							env.running = false
							emit()
						}
					})
				}
			} catch {
				env.running = false
				emit()
			}
		},
		abort() {
			try {
				api.abort()
			} finally {
				env.running = false
				env.streamState = "stopped"
				state.streamState = "stopped"
				const message = state.messages.find((m) => m.id === state.streamingMessageId)
				if (message && !isTerminal(message.status)) message.status = "stopped"
				state.messages.forEach((item) => {
					if (item.planState === "running") item.planState = "aborted"
				})
				emit()
			}
		},
		steer(text) {
			const value = String(text || "").trim()
			if (!value) return
			try {
				api.steer(value)
			} catch {
				/* 失败由宿主提示 */
			}
		},
		chooseSkill(id) {
			env.selectedSkillId = id || null
			try {
				if (id) api.selectSkill(id)
				else api.clearSkill()
			} catch {
				/* 忽略：宿主会在状态变化时回推 */
			}
			emit()
		},
		clearSkill() {
			store.chooseSkill("")
		},
		removeRef(id) {
			env.refs = env.refs.filter((ref) => String(ref.id) !== String(id))
			try {
				api.removeRef(String(id))
			} catch {
				/* ignore */
			}
			emit()
		},
		clearRefs() {
			env.refs = []
			try {
				api.clearRefs()
			} catch {
				/* ignore */
			}
			emit()
		},
		planAction(action) {
			const message = [...state.messages].reverse().find((m) => m.plan)
			if (message) {
				message.planState = action === "run" ? "running" : action === "cancel" ? "cancelled" : "adjusted"
			}
			if (action === "run") {
				env.running = true
				env.streamState = "streaming"
				state.streamState = "streaming"
			}
			emit()
			try {
				api.planAction(action)
			} catch {
				/* host will surface its own error */
			}
		},
		confirmAction(yes) {
			try {
				const fn = api.confirmAction
				if (typeof fn === "function") fn(Boolean(yes))
			} catch {
				/* ignore */
			}
			state.pendingConfirmation = null
			emit()
		},
		togglePlanConfirm() {
			env.planConfirm = !env.planConfirm
			try {
				api.togglePlanConfirm(env.planConfirm)
			} catch {
				/* ignore */
			}
			emit()
		},
		openHistory() {
			try {
				api.openHistory()
			} catch {
				/* ignore */
			}
		},
		openNode(id) {
			try {
				api.openNode(String(id))
			} catch {
				/* ignore */
			}
		},
		clearHistory() {
			state.messages = []
			state.streamingMessageId = null
			state.streamState = "idle"
			state.contextUsage = null
			env.artifacts = []
			env.running = false
			emit()
		},
		destroy() {
			destroyed = true
			listeners.clear()
		},
	}

	const handle: CanvasAssistantHandle = {
		pushEvent(event: StreamEvent) {
			applyEvent(state, event)
			const type = String(event?.type || "")
			if (type === "run_start") {
				env.running = true
				env.artifacts = []
			}
			if (type === "done" || type === "error") {
				env.running = false
				if (type === "done" && !isTerminal(state.streamState)) state.streamState = "completed"
				state.messages.forEach((message) => {
					if (message.planState === "running") {
						message.planState = type === "done" && state.streamState === "completed" ? "applied" : "cancelled"
					}
				})
			}
			emit()
		},
		setHistory(messages) {
			const list = Array.isArray(messages) ? messages : []
			if (!list.length) {
				state.messages = []
			} else {
				state.messages = list.map((item) => historyMessage(String(item.role || "assistant"), String(item.text || "")))
			}
			state.streamingMessageId = null
			emit()
		},
		setRefs(refs) {
			env.refs = Array.isArray(refs) ? refs : []
			emit()
		},
		setSkills(skills) {
			env.skills = Array.isArray(skills) ? skills : []
			emit()
		},
		setSelectedSkill(id) {
			env.selectedSkillId = id || null
			emit()
		},
		setRunning(running) {
			env.running = Boolean(running)
			if (!running && !isTerminal(state.streamState) && state.streamState === "streaming") {
				state.streamState = "completed"
			}
			emit()
		},
		setPlanConfirm(on) {
			env.planConfirm = Boolean(on)
			emit()
		},
		setContextUsage(usage) {
			env.contextUsage = usage || null
			emit()
		},
		setArtifacts(items) {
			env.artifacts = Array.isArray(items) ? items : []
			emit()
		},
		setStreamState(next) {
			env.streamState = String(next || "")
			state.streamState = String(next || "")
			emit()
		},
		notifySteer(text, status) {
			const message = state.messages.find((m) => m.id === state.streamingMessageId)
			const clean = String(text || "").trim()
			if (!clean) return
			if (status === "placed" || status === "") {
				if (message) {
					message.parts.push({ type: "user_steer", id: uid("part"), text: clean, status: String(status || "placed") })
				}
			} else if (status === "unread") {
				pushNotice("没来得及读，已放回输入框")
			}
			emit()
		},
		notifySystem(text, kind = "info") {
			const message = historyMessage("system", String(text || ""))
			message.systemKind = kind
			state.messages.push(message)
			emit()
		},
		notifyRunSummary(text) {
			const clean = String(text || "").trim()
			if (!clean) return
			const message = historyMessage("system", clean)
			message.systemKind = "info"
			state.messages.push(message)
			emit()
		},
		clearHistory() {
			store.clearHistory()
		},
		destroy() {
			store.destroy()
		},
	}

	return { store, handle }
}

export const currentWorkMs = (state: ReturnType<typeof createSession>) => workMs(state)
