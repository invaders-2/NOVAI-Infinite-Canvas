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

export interface QueueItem {
	id: string
	text: string
}

export interface EnvState {
	running: boolean
	queue: QueueItem[]
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
	enterPickMode(): void
	exitPickMode(): void
	captureCanvas(): Promise<boolean>
	captureRegionPreview(rect: { x: number; y: number; w: number; h: number }): Promise<{ url: string; width: number; height: number } | null>
	addCaptureRef(url: string, width: number, height: number): boolean
	addSkillRef(skill: { id: string; name: string; description?: string }): boolean
	addAppRef(app: { id: string; name: string; description?: string; activationSkill?: string }): boolean
	addFolderRef(name: string, count: number): boolean
	addFolderFiles(files: { name: string; url?: string; kind?: string }[]): number
	branchAt(index: number): Promise<void>
	removeRef(id: string): void
	clearRefs(): void
	planAction(action: "run" | "cancel" | "adjust"): void
	confirmAction(yes: boolean): void
	undoRun(runId: string): Promise<{ ok: boolean; message: string }>
	executeConfirmation(id: string): void
	skipConfirmation(id: string): void
	cancelConfirmation(id: string): void
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

const historyString = (value: unknown): string => {
	if (value == null) return ""
	return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

const messageFromHistory = (item: Record<string, unknown>, createdAt = Date.now()): Message => {
	const role = String(item.role || "assistant")
	const text = String(item.content ?? item.text ?? "")
	const message = historyMessage(role, text, createdAt)
	if (item.run_id) message.runId = String(item.run_id)
	const steps = Array.isArray(item.steps) ? item.steps : []
	const seen = new Set<string>()
	for (const raw of steps) {
		if (!raw || typeof raw !== "object") continue
		const step = raw as Record<string, unknown>
		const tool = String(step.tool || "")
		if (!tool) continue
		const index = step.index === undefined || step.index === null ? "" : String(step.index)
		const dedupeKey = String(message.runId || "") + "|" + index + "|" + tool
		if (index && seen.has(dedupeKey)) continue
		if (index) seen.add(dedupeKey)
		const ok = step.ok !== false
		message.parts.push({
			type: "tool_event",
			id: uid("part"),
			kind: "step",
			index,
			tool,
			title: String(step.description || ""),
			status: ok ? "done" : "failed",
			ok,
			message: String(step.error || step.message || ""),
			code: String(step.code || ""),
			output: historyString(step.output),
			args: step.args && typeof step.args === "object" ? step.args : undefined,
			durationMs: Number(step.duration_ms) || 0,
			startedAt: 0,
			endedAt: 0,
		})
	}
	if (item.changes && typeof item.changes === "object") {
		const raw = item.changes as Record<string, unknown>
		const created = Number(raw.nodes_created) || 0
		const modified = Number(raw.nodes_modified) || 0
		const deleted = Number(raw.nodes_deleted) || 0
		const nodes = Number(raw.nodes) || 0
		message.changes = {
			nodes_created: created + (nodes && !created && !modified && !deleted ? nodes : 0),
			nodes_modified: modified,
			nodes_deleted: deleted,
			connections: Number(raw.connections) || 0,
			generations: Number(raw.generations) || 0,
			artifacts: Number(raw.artifacts) || 0,
		}
	}
	const sources = Array.isArray(item.sources) ? item.sources : []
	const urls: string[] = []
	for (const source of sources) {
		const value = typeof source === "string" ? source : String((source && (source as Record<string, unknown>).url) || "")
		if (/^https?:\/\//.test(value) && !urls.includes(value)) urls.push(value)
	}
	if (urls.length) message.sources = urls
	return message
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
		queue: [],
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
	let queueTimer = 0
	let suppressQueueFlushUntil = 0

	const flushQueued = () => {
		if (env.running || env.queue.length === 0 || queueTimer) return
		if (Date.now() < suppressQueueFlushUntil) return
		queueTimer = window.setTimeout(() => {
			queueTimer = 0
			if (env.running || env.queue.length === 0) return
			const next = env.queue.shift()
			if (!next) return
			emit()
			void store.send(next.text)
		}, 260)
	}

	const findConfirmationPart = (current: ReturnType<typeof createSession>, id: string) => {
		for (const message of current.messages) {
			for (const part of message.parts) {
				if (part.type === "confirmation" && part.id === id) return part
			}
		}
		return null
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
					if (ok !== false) {
						const uploads = env.refs.filter((ref) => ref.type === "upload" || /^upload_/.test(ref.id))
						uploads.forEach((ref) => {
							try { api.removeRef(ref.id) } catch {}
						})
						if (uploads.length) {
							env.refs = env.refs.filter((ref) => !(ref.type === "upload" || /^upload_/.test(ref.id)))
							emit()
						}
					}
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
		enqueue(text) {
			const value = String(text || "").trim()
			if (!value) return false
			if (env.queue.length >= 5) {
				pushNotice("队列最多 5 条，等前面的发完再加")
				return false
			}
			env.queue.push({ id: uid("queue"), text: value })
			emit()
			return true
		},
		removeQueued(id) {
			env.queue = env.queue.filter((item) => item.id !== id)
			emit()
		},
		updateQueued(id, text) {
			const value = String(text || "").trim()
			if (!value) return
			const item = env.queue.find((entry) => entry.id === id)
			if (item) item.text = value
			emit()
		},
		sendQueuedNow(id) {
			const item = env.queue.find((entry) => entry.id === id)
			if (!item) return
			env.queue = env.queue.filter((entry) => entry.id !== id)
			emit()
			if (env.running) {
				suppressQueueFlushUntil = Date.now() + 1600
				try { store.abort() } catch {}
				window.setTimeout(() => { void store.send(item.text) }, 500)
			} else {
				void store.send(item.text)
			}
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
			suppressQueueFlushUntil = Date.now() + 1200
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
		setChatModel(model, provider) {
			env.chatModel = String(model || "")
			env.chatProvider = String(provider || "")
			try { api.setChatModel(env.chatModel, env.chatProvider) } catch {}
			emit()
		},
		setImageProvider(value) {
			env.imageProvider = String(value || "")
			try { api.setImageProvider(env.imageProvider) } catch {}
			emit()
		},
		setPlanConfirm(on) {
			env.planConfirm = Boolean(on)
			try { api.togglePlanConfirm(env.planConfirm) } catch {}
			emit()
		},
		addSelectedRefs() {
			return Promise.resolve()
				.then(() => api.addSelectedRefs())
				.then((count) => {
					pushNotice(count > 0 ? "已引用 " + count + " 个画布节点" : "先在画布上选中要引用的节点")
					return count
				})
				.catch(() => {
					pushNotice("引用节点失败")
					return 0
				})
		},
		pickUpload() {
			try { api.pickUpload() } catch {}
		},
		enterPickMode() {
			try { if (typeof api.enterPickMode === "function") api.enterPickMode() } catch {}
		},
		exitPickMode() {
			try { if (typeof api.exitPickMode === "function") api.exitPickMode() } catch {}
		},
		captureRegionPreview(rect) {
			return Promise.resolve()
				.then(() => (typeof api.captureRegionPreview === "function" ? api.captureRegionPreview(rect) : null))
				.catch(() => null)
		},
		addCaptureRef(url, width, height) {
			try {
				if (typeof api.addCaptureRef === "function") return Boolean(api.addCaptureRef(url, width, height))
			} catch {}
			return false
		},
		addSkillRef(skill) {
			try {
				if (typeof api.addSkillRef === "function") return Boolean(api.addSkillRef(skill))
			} catch {}
			return false
		},
		addAppRef(app) {
			try {
				if (typeof api.addAppRef === "function") return Boolean(api.addAppRef(app))
			} catch {}
			return false
		},
		addFolderRef(name, count) {
			try {
				if (typeof api.addFolderRef === "function") return Boolean(api.addFolderRef(name, count))
			} catch {}
			return false
		},
		addFolderFiles(files) {
			try {
				if (typeof api.addFolderFiles === "function") return Number(api.addFolderFiles(files)) || 0
			} catch {}
			return 0
		},
		captureCanvas() {
			return Promise.resolve()
				.then(() => (typeof api.captureCanvas === "function" ? api.captureCanvas() : false))
				.then((ok) => {
					pushNotice(ok ? "已把画布可视区域加入引用" : "截图没有生成")
					return Boolean(ok)
				})
				.catch(() => {
					pushNotice("截图失败，请重试")
					return false
				})
		},
		async branchAt(index) {
			const list = await fetchThreads()
			const activeId = list.active_id || (list.threads[0] ? list.threads[0].id : "")
			if (!activeId) {
				pushNotice("还没有可分支的对话")
				return
			}
			const upto = state.messages.slice(0, index + 1).filter((message) => message.role !== "system")
			const messageIndex = Math.max(0, upto.length - 1)
			const thread = await forkThread(activeId, messageIndex)
			await switchThreadViaLegacy(thread.id)
			store.reloadHistory()
			env.threadRefresh = (env.threadRefresh || 0) + 1
			pushNotice("已创建分支对话")
			emit()
		},
		removeRef(id) {
			try { api.removeRef(String(id)) } catch {}
			env.refs = env.refs.filter((ref) => ref.id !== id)
			emit()
		},
		clearRefs() {
			try { api.clearRefs() } catch {}
			env.refs = []
			emit()
		},
		async undoRun(runId) {
			try {
				if (typeof api.undoRun !== "function") return { ok: false, message: "撤销入口不可用" }
				const result = await api.undoRun(String(runId))
				return { ok: Boolean(result && result.ok), message: String((result && result.message) || "已撤销本次修改") }
			} catch (error) {
				return { ok: false, message: (error as Error)?.message || "撤销失败" }
			}
		},
		executeConfirmation(id) {
			const part = findConfirmationPart(state, id)
			if (!part || part.status !== "pending") return
			const args = part.args && typeof part.args === "object" ? { ...(part.args as Record<string, unknown>) } : {}
			if (part.confirmKind === "delete" || /delete/i.test(part.tool)) args.force = true
			part.status = "executed"
			state.pendingConfirmation = null
			emit()
			pushNotice("已确认执行这一步")
			const launch = () => {
				try {
					if (typeof api.approveStep === "function") {
						void api.approveStep(
							{ tool: part.tool, args, description: part.description },
							part.description || "执行已确认的步骤",
						)
					} else if (typeof api.confirmAction === "function") {
						api.confirmAction(true)
					}
				} catch {
					pushNotice("确认执行失败，请重试")
				}
			}
			if (env.running) {
				const timer = window.setInterval(() => {
					if (env.running) return
					window.clearInterval(timer)
					window.setTimeout(launch, 250)
				}, 250)
			} else {
				window.setTimeout(launch, 120)
			}
		},
		skipConfirmation(id) {
			const part = findConfirmationPart(state, id)
			if (!part || part.status !== "pending") return
			part.status = "skipped"
			state.pendingConfirmation = null
			emit()
			pushNotice("已跳过这一步")
		},
		cancelConfirmation(id) {
			const part = findConfirmationPart(state, id)
			if (!part) return
			part.status = "cancelled"
			state.pendingConfirmation = null
			emit()
			pushNotice("已取消本轮")
			try { store.abort() } catch {}
		},
		planAction(action) {
			try { api.planAction(action) } catch {}
		},
		confirmAction(yes) {
			try {
				const fn = api.confirmAction
				if (typeof fn === "function") fn(Boolean(yes))
			} catch {}
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
			env.queue = []
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
			env.queue = []
			if (!canvasId) return
			fetch("/api/agent/thread/" + encodeURIComponent(canvasId) + "?limit=60", { headers: { Accept: "application/json" } })
				.then((response) => (response.ok ? response.json() : null))
				.then((data) => {
					if (!data || !Array.isArray(data.messages)) return
					state.messages = data.messages.map((item: Record<string, unknown>) =>
						messageFromHistory(item, Number(item.at) ? Number(item.at) * 1000 : Date.now()),
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
				flushQueued()
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
					messageFromHistory(item as Record<string, unknown>, Number((item as Record<string, unknown>).at) ? Number((item as Record<string, unknown>).at) * 1000 : Date.now()),
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
			const wasRunning = env.running
			env.running = Boolean(running)
			if (!running && !isTerminal(state.streamState) && state.streamState === "streaming") {
				state.streamState = "completed"
			}
			emit()
			if (wasRunning && !env.running) flushQueued()
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
