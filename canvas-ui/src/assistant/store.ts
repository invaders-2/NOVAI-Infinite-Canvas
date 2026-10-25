import type {
	ArtifactItem,
	ChatModelOption,
	ComposerState,
	ImageProviderOption,
	CanvasAssistantHandle,
	CanvasAssistantHostApi,
	ContextUsage,
	Message,
	RefChip,
	SkillChip,
	StreamEvent,
} from "./types"
import { canvasId, fetchThreads, forkThread, switchThreadViaLegacy } from "./api"
import { applyEvent, createSession, isTerminal, workMs } from "./session"

export interface EnvState {
	running: boolean
	streamState: string
	planConfirm: boolean
	refs: RefChip[]
	chatModels: ChatModelOption[]
	chatModel: string
	chatProvider: string
	imageProviders: ImageProviderOption[]
	imageProvider: string
	contextUsage: ContextUsage | null
	artifacts: ArtifactItem[]
	steerPending: boolean
	notice: string
	/** 产物有变化（artifact_updated / 本轮结束）时自增，产物面板据此重拉 */
	artifactRefresh: number
	/** 线程列表可能变化（本轮结束 / 清空对话）时自增 */
	threadRefresh: number
}

export interface AssistantStore {
	version: number
	state: ReturnType<typeof createSession>
	env: EnvState
	subscribe(listener: () => void): () => void
	getVersion(): number
	send(text: string): Promise<boolean>
	seedAutoSend(input: { text: string; skillRef?: string }): Promise<boolean>
	registerComposer(fill: ((text: string) => void) | null): void
	notify(text: string): void
	fillComposer(text: string): void
	abort(): void
	steer(text: string): void
	setChatModel(model: string, provider: string): void
	setImageProvider(value: string): void
	setPlanConfirm(on: boolean): void
	addSelectedRefs(): Promise<number>
	pickUpload(): void
	branchAt(index: number): Promise<void>
	removeRef(id: string): void
	clearRefs(): void
	planAction(action: "run" | "cancel" | "adjust"): void
	confirmAction(yes: boolean): void
	togglePlanConfirm(): void
	openHistory(): void
	openNode(id: string): void
	clearHistory(): void
	removeMessage(id: string): void
	reloadHistory(): void
	destroy(): void
}

const uid = (() => {
	let n = 0
	return (prefix: string) => {
		n += 1
		return prefix + "_" + Date.now().toString(36) + "_" + n
	}
})()

const historyMessage = (role: string, text: string, createdAt = Date.now()): Message => {
	const clean = String(text || "")
	const resolved = role === "user" ? "user" : role === "system" ? "system" : "assistant"
	return {
		id: uid("msg"),
		role: resolved,
		parts: [{ type: "text", id: uid("part"), text: clean }],
		status: "",
		activeWorkMs: 0,
		createdAt,
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
		chatModels: [],
		chatModel: "",
		chatProvider: "",
		imageProviders: [],
		imageProvider: "",
		contextUsage: null,
		artifacts: [],
		steerPending: false,
		notice: "",
		artifactRefresh: 0,
		threadRefresh: 0,
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

	const pushSystem = (text: string, kind: "info" | "warn" | "error" = "warn") => {
		if (!text) return
		const message = historyMessage("system", text)
		message.systemKind = kind
		state.messages.push(message)
		emit()
	}

	let composerFill: ((text: string) => void) | null = null

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
			if (!value) return Promise.resolve(false)
			if (env.running) {
				pushSystem("助手还在执行，这条消息没有发出去", "warn")
				return Promise.resolve(false)
			}
			env.running = true
			env.streamState = "streaming"
			state.streamState = "streaming"
			state.messages.push(historyMessage("user", value))
			emit()
			return Promise.resolve()
				.then(() => api.send(value))
				.then((ok) => {
					if (ok === false) {
						env.running = false
						env.streamState = "idle"
						state.streamState = "idle"
						pushSystem("发送失败：没有拿到运行回执，请检查模型与网络后重试", "error")
						return false
					}
					return true
				})
				.catch((error) => {
					env.running = false
					env.streamState = "idle"
					state.streamState = "idle"
					pushSystem("发送失败：" + ((error as Error)?.message || "网络错误"), "error")
					return false
				})
		},
		async seedAutoSend(input) {
			const text = String(input && input.text ? input.text : "").trim()
			const skillRef = String(input && input.skillRef ? input.skillRef : "").trim()
			if (!text) {
				pushSystem("自动发送缺少内容", "error")
				return false
			}
			if (env.running) {
				pushSystem("助手还在执行，自动发送没有执行", "warn")
				return false
			}
			try {
				let injectedSkillRef = false
				if (skillRef && /^store:/.test(skillRef) && typeof api.applySkillRef === "function") {
					/* 应用市场 brief 的 store:<id>：桥接层在下一轮 /api/agent/run 里注入 skill_ref */
					api.applySkillRef(skillRef)
					injectedSkillRef = true
				}
				if (composerFill) composerFill(text)
				const accepted = await store.send(text)
				/* 失败时把提示词留在输入框，用户可以直接重发 */
				if (composerFill) composerFill(accepted ? "" : text)
				if (injectedSkillRef && accepted) {
					window.setTimeout(() => {
						try { api.clearSkill() } catch {}
					}, 400)
				}
				return accepted
			} catch (error) {
				pushSystem("自动发送失败：" + ((error as Error)?.message || "未知错误"), "error")
				return false
			}
		},
		registerComposer(fill) {
			composerFill = fill
		},
		notify(text) {
			pushNotice(String(text || ""))
		},
		fillComposer(text) {
			if (composerFill) composerFill(String(text || ""))
			else pushNotice("输入框还没准备好，稍后再试")
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
		removeMessage(id) {
			state.messages = state.messages.filter((message) => message.id !== id)
			emit()
		},
		clearHistory() {
			state.messages = []
			state.streamingMessageId = null
			state.streamState = "idle"
			state.contextUsage = null
			env.artifacts = []
			env.running = false
			env.threadRefresh += 1
			emit()
		},
		reloadHistory() {
			if (!canvasId) return
			fetch("/api/agent/thread/" + encodeURIComponent(canvasId) + "?limit=60", { headers: { Accept: "application/json" } })
				.then((response) => (response.ok ? response.json() : null))
				.then((data) => {
					if (!data || !Array.isArray(data.messages)) return
					state.messages = data.messages.map((item: { role?: string; text?: string }) =>
						historyMessage(String(item.role || "assistant"), String(item.text || "")),
					)
					state.streamingMessageId = null
					env.artifacts = []
					emit()
				})
				.catch(() => {})
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
			if (type === "artifact_updated" || type === "done" || type === "error") {
				env.artifactRefresh += 1
			}
			if (type === "done" || type === "error") {
				env.running = false
				env.threadRefresh += 1
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
			/* 刚发送/运行中的历史可能还没落盘：旧面板的线程拉取晚到，别用它覆盖当前对话（会把用户消息吞掉） */
			if (env.running) return
			const list = Array.isArray(messages) ? messages : []
			if (!list.length) {
				state.messages = []
			} else {
				state.messages = list.map((item) =>
				historyMessage(
					String(item.role || "assistant"),
					String(item.text || ""),
					Number(item.at) ? Number(item.at) * 1000 : Date.now(),
				),
			)
			}
			state.streamingMessageId = null
			emit()
		},
		setRefs(refs) {
			env.refs = Array.isArray(refs) ? refs : []
			emit()
		},
		setSkills() {
			/* 技能入口已移除：保留空实现，桥接层回推状态时不报错 */
		},
		setSelectedSkill() {
			/* 技能入口已移除 */
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
		seedAutoSend(input) {
			return store.seedAutoSend(input)
		},
		setComposerState(next) {
			if (!next || typeof next !== "object") return
			env.chatModels = Array.isArray(next.models) ? next.models : []
			env.chatModel = String(next.model || "")
			env.chatProvider = String(next.provider || "")
			env.imageProviders = Array.isArray(next.imageProviders) ? next.imageProviders : []
			env.imageProvider = String(next.imageProvider || "")
			env.planConfirm = Boolean(next.planConfirm)
			emit()
		},
		destroy() {
			store.destroy()
		},
	}

	return { store, handle }
}

export const currentWorkMs = (state: ReturnType<typeof createSession>) => workMs(state)
