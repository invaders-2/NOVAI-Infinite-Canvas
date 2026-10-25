// 画布助手微应用里直接调用的只读/管理接口（全部相对 /api/...，不写死后端地址）。
// 桥接层只转发 SSE，这里不碰 agent 协议本身。

export const canvasId = (() => {
	try {
		return new URLSearchParams(location.search).get("id") || ""
	} catch {
		return ""
	}
})()

export interface ArtifactFile {
	name: string
	kind: string
	size: number
	mtime: number
	url: string
	run_id?: string
}

export interface ArtifactList {
	canvas_id: string
	files: ArtifactFile[]
	counts: Record<string, number>
	truncated: boolean
}

export interface ThreadRow {
	id: string
	title: string
	created_at?: number
	message_count?: number
	forked_from?: string
}

export interface ThreadList {
	active_id: string
	threads: ThreadRow[]
}

export interface ModelContext {
	run_id: string
	model: string | null
	system_prompt_chars: number | null
	system_prompt_sections: string[] | null
	tool_count: number | null
	tool_names: string[] | null
	history_chars: number | null
	instruction_chars: number | null
	estimated_tokens: number | null
	context_max: number | null
	percentage: number | null
}

const jsonInit: RequestInit = { headers: { Accept: "application/json" } }

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
	try {
		return (await response.json()) as Record<string, unknown>
	} catch {
		return {}
	}
}

const errorText = (data: Record<string, unknown>, fallback: string): string =>
	String(data.detail || data.message || fallback)

export const fetchArtifacts = async (): Promise<ArtifactList> => {
	if (!canvasId) return { canvas_id: "", files: [], counts: {}, truncated: false }
	const response = await fetch("/api/agent/canvases/" + encodeURIComponent(canvasId) + "/artifacts", jsonInit)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	return {
		canvas_id: String(data.canvas_id || canvasId),
		files: Array.isArray(data.files) ? (data.files as ArtifactFile[]) : [],
		counts: (data.counts && typeof data.counts === "object" ? data.counts : {}) as Record<string, number>,
		truncated: Boolean(data.truncated),
	}
}

export type ModelContextResult =
	| { ok: true; data: ModelContext }
	| { ok: false; expired: boolean; message: string }

export const fetchModelContext = async (runId: string): Promise<ModelContextResult> => {
	if (!runId) return { ok: false, expired: false, message: "这轮没有可查看的上下文" }
	try {
		const response = await fetch("/api/agent/runs/" + encodeURIComponent(runId) + "/model-context", jsonInit)
		const data = await readJson(response)
		if (response.status === 404) {
			return { ok: false, expired: true, message: "这轮已过期，无法查看上下文" }
		}
		if (!response.ok) {
			return { ok: false, expired: false, message: errorText(data, "HTTP " + response.status) }
		}
		return { ok: true, data: data as unknown as ModelContext }
	} catch (error) {
		return { ok: false, expired: false, message: (error as Error)?.message || "网络错误" }
	}
}

export const fetchThreads = async (): Promise<ThreadList> => {
	if (!canvasId) return { active_id: "", threads: [] }
	const response = await fetch("/api/agent/threads?canvas_id=" + encodeURIComponent(canvasId), jsonInit)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	return {
		active_id: String(data.active_id || ""),
		threads: Array.isArray(data.threads) ? (data.threads as ThreadRow[]) : [],
	}
}

export const fetchThreadMessages = async (): Promise<{ role?: string; text?: string }[]> => {
	if (!canvasId) return []
	const response = await fetch("/api/agent/thread/" + encodeURIComponent(canvasId) + "?limit=60", jsonInit)
	const data = await readJson(response)
	if (!response.ok) return []
	return Array.isArray(data.messages) ? (data.messages as { role?: string; text?: string }[]) : []
}

export const renameThread = async (threadId: string, title: string): Promise<{ id: string; title: string }> => {
	const response = await fetch("/api/agent/threads/rename", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ canvas_id: canvasId, thread_id: threadId, title }),
	})
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const thread = (data.thread && typeof data.thread === "object" ? data.thread : {}) as { id?: string; title?: string }
	return { id: String(thread.id || threadId), title: String(thread.title || title) }
}

export const deleteThread = async (threadId: string): Promise<{ deleted: string; active_id: string }> => {
	const response = await fetch(
		"/api/agent/threads/" + encodeURIComponent(threadId) + "?canvas_id=" + encodeURIComponent(canvasId),
		{ method: "DELETE", headers: { Accept: "application/json" } },
	)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	return { deleted: String(data.deleted || threadId), active_id: String(data.active_id || "") }
}

/* 切线程必须让旧面板的 agentThreadState.activeId 跟着走，否则下一轮消息会发到旧线程：
   点一下旧面板里同一线程的行，复用它的 switch + 历史刷新逻辑（旧 DOM 在 React 版里只是隐藏）。 */
export const switchThreadViaLegacy = async (threadId: string): Promise<boolean> => {
	const trigger = document.getElementById("chatThreadBtn")
	if (!trigger) return false
	try {
		trigger.click()
	} catch {
		return false
	}
	const rowSelector = '#chatThreadMenu [data-thread-row="' + cssEscape(threadId) + '"] .chat-thread-main'
	const startedAt = Date.now()
	return await new Promise<boolean>((resolve) => {
		const tick = () => {
			const row = document.querySelector(rowSelector) as HTMLElement | null
			if (row) {
				try {
					row.click()
				} catch {
					resolve(false)
					return
				}
				resolve(true)
				return
			}
			if (Date.now() - startedAt > 3000) {
				const menu = document.getElementById("chatThreadMenu")
				if (menu) menu.hidden = true
				resolve(false)
				return
			}
			setTimeout(tick, 60)
		}
		tick()
	})
}

const cssEscape = (value: string): string => {
	const raw = String(value || "")
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(raw)
	return raw.replace(/["\\\]\[#.:>+~*^$|()]/g, "\\$&")
}

export const switchThreadApi = async (threadId: string): Promise<void> => {
	const response = await fetch("/api/agent/threads/switch", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ canvas_id: canvasId, thread_id: threadId }),
	})
	if (!response.ok) throw new Error("HTTP " + response.status)
}

export const forkThread = async (threadId: string, messageIndex: number, title = ""): Promise<ThreadRow> => {
	if (!canvasId) throw new Error("缺少画布 id")
	const response = await fetch("/api/agent/threads/fork", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ canvas_id: canvasId, thread_id: threadId, message_index: messageIndex, title }),
	})
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const thread = (data.thread || {}) as ThreadRow
	if (!thread.id) throw new Error("分支接口没有返回线程")
	return thread
}
