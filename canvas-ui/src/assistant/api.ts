// 画布助手微应用里直接调用的只读/管理接口（全部相对 /api/...，不写死后端地址）。
// 桥接层只转发 SSE，这里不碰 agent 协议本身。

export const canvasId = (() => {
	try {
		const fromUrl = new URLSearchParams(location.search).get("id")
		if (fromUrl) return fromUrl
		const collab = (window as unknown as { SmartCanvasCollab?: { getCanvas?: () => { id?: string } | null } }).SmartCanvasCollab
		return String(collab?.getCanvas?.()?.id || "")
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
	updated_at?: number
	message_count?: number
	forked_from?: string
	forked_at_message?: number | null
}

export interface ThreadList {
	active_id: string
	threads: ThreadRow[]
}

export interface CanvasNodeSummary {
	id: string
	title: string
	type: string
}

const mapCanvasNodes = (raw: unknown): CanvasNodeSummary[] => {
	const nodes = Array.isArray(raw) ? raw : []
	return nodes
		.map((item) => {
			const node = (item || {}) as Record<string, unknown>
			const title = String(node.title || node.alias || node.prompt || node.type || "画布节点").slice(0, 40)
			return { id: String(node.id || ""), title, type: String(node.type || "") }
		})
		.filter((node) => node.id)
}

export const fetchCanvasNodes = async (): Promise<CanvasNodeSummary[]> => {
	if (!canvasId) return []
	/* 优先读当前画布内存里的节点，@ 提及才能看到还没保存到服务端的改动 */
	const collab = (window as unknown as { SmartCanvasCollab?: { getDoc?: () => { nodes?: unknown } | null } }).SmartCanvasCollab
	try {
		const doc = collab && typeof collab.getDoc === "function" ? collab.getDoc() : null
		if (doc && Array.isArray(doc.nodes) && doc.nodes.length) return mapCanvasNodes(doc.nodes)
	} catch {
		/* 回退到接口 */
	}
	const response = await fetch("/api/canvases/" + encodeURIComponent(canvasId), { headers: { Accept: "application/json" } })
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const canvas = (data.canvas || {}) as { nodes?: unknown }
	return mapCanvasNodes(canvas.nodes)
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

export const rateThreadMessage = async (threadId: string, messageIndex: number, rating: "up" | "down" | null): Promise<void> => {
	if (!canvasId) throw new Error("缺少画布 id")
	const response = await fetch("/api/agent/threads/feedback", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ canvas_id: canvasId, thread_id: threadId, message_index: messageIndex, rating }),
	})
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
}

export interface SkillRow {
	id: string
	name: string
	description: string
	icon?: string
}

export const fetchSkills = async (): Promise<SkillRow[]> => {
	const response = await fetch("/api/skills?limit=60", jsonInit)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const rows = Array.isArray(data.skills) ? data.skills : []
	return rows
		.filter((raw) => !raw || typeof raw !== "object" || (raw as Record<string, unknown>).enabled !== false)
		.map((raw) => {
			const row = (raw || {}) as Record<string, unknown>
			return {
				id: String(row.id || ""),
				name: String(row.name || row.display_name || row.id || ""),
				description: String(row.description || ""),
				icon: String(row.icon || ""),
			}
		})
		.filter((row) => row.id && row.name)
}

export const importSkill = async (markdown: string, overwrite = false): Promise<SkillRow> => {
	const response = await fetch("/api/skills/import", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ markdown, overwrite }),
	})
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const skill = (data.skill || {}) as Record<string, unknown>
	const id = String(skill.id || "")
	if (!id) throw new Error("技能导入接口没有返回技能")
	return { id, name: String(skill.name || skill.display_name || id), description: String(skill.description || "") }
}

export interface StoreCatalogItem {
	id: string
	name: string
	description: string
	kind: "skill" | "app" | string
	activationSkill: string
	installed: boolean
}

export const fetchStoreCatalog = async (): Promise<StoreCatalogItem[]> => {
	const response = await fetch("/api/store/catalog", jsonInit)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const items = Array.isArray(data.items) ? data.items : []
	return items
		.map((raw) => {
			const row = (raw || {}) as Record<string, unknown>
			return {
				id: String(row.name || row.id || ""),
				name: String(row.display_name || row.name || ""),
				description: String(row.description || row.marketing_line || ""),
				kind: String(row.kind || ""),
				activationSkill: String(row.activation_skill || ""),
				installed: row.installed === true,
			}
		})
		.filter((row) => row.id && row.name)
}

export interface StoreAppRow {
	id: string
	name: string
	description: string
	activationSkill: string
}

export const fetchStoreApps = async (): Promise<StoreAppRow[]> => {
	const response = await fetch("/api/store/catalog", jsonInit)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	const items = Array.isArray(data.items) ? data.items : []
	return items
		.filter((raw) => raw && typeof raw === "object" && (raw as Record<string, unknown>).kind === "app")
		.slice(0, 8)
		.map((raw) => {
			const row = raw as Record<string, unknown>
			return {
				id: String(row.name || row.id || row.display_name || ""),
				name: String(row.display_name || row.name || ""),
				description: String(row.description || ""),
				activationSkill: String(row.activation_skill || ""),
			}
		})
		.filter((row) => row.id && row.name)
}
