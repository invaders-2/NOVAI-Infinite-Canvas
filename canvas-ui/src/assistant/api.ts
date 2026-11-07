// 画布助手微应用里直接调用的只读/管理接口（全部相对 /api/...，不写死后端地址）。
// 桥接层只转发 SSE，这里不碰 agent 协议本身。

import type { ReferenceImage } from "./types"
import { normalizeReferenceImageList } from "./reference"

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

/* 失败卡要把真实原因说清楚：带上 HTTP 状态；服务端有 detail 就原样带上（例如 403 的中文原因） */
const httpErrorText = (data: Record<string, unknown>, status: number): string => {
	const detail = String(data.detail || data.message || "").trim()
	return detail ? "HTTP " + status + " · " + detail : "HTTP " + status
}

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

export interface CanvasTemplateItem {
	id: string
	name: string
	node_count: number
	connection_count: number
	contains: string
	input_count: number
	generation_count: number
	covers: string[]
	error?: string
}

export interface CanvasTemplateApplyResult {
	canvas_id: string
	template: string
	node_id: string
	node_ids: string[]
	node_count: number
	task_ids: string[]
	run: boolean
}

export const fetchCanvasTemplates = async (): Promise<CanvasTemplateItem[]> => {
	const response = await fetch("/api/canvas-templates", jsonInit)
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "HTTP " + response.status))
	return Array.isArray(data.templates) ? (data.templates as CanvasTemplateItem[]) : []
}

export const applyCanvasTemplate = async (templateId: string): Promise<CanvasTemplateApplyResult> => {
	const response = await fetch("/api/canvas-templates/" + encodeURIComponent(templateId) + "/apply", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ canvas_id: canvasId }),
	})
	const data = await readJson(response)
	if (!response.ok) throw new Error(errorText(data, "模板克隆失败"))
	return data as unknown as CanvasTemplateApplyResult
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

/* ── 画布助手联网搜图 / 反图 / 原图入画布（契约：docs/agent-web-image-search.md 第 4 节） ── */

const toSize = (value: unknown): number | null => {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

export interface ImportedImageRow {
	source_url: string
	ok: boolean
	url: string
	width: number | null
	height: number | null
	bytes: number
	error: string
}

export interface ImportImagesResult {
	ok: boolean
	items: ImportedImageRow[]
	/** 失败时的真实原因（HTTP 状态 / 服务端 detail） */
	message: string
	/** 关闭联网（HTTP 403）时置 true，卡片显示指引而不是「失败」 */
	disabled: boolean
}

/** 导入一条原图：source_page 是出处页，服务端拿它的 origin 当 Referer（防盗链站点靠它才拿得到原图） */
export interface ImportImageSource {
	url: string
	source_page?: string
}

/** POST /api/agent/images/import：服务端逐条下载原图（只认原图直链，绝不拿缩略图兜底） */
export const importImages = async (sources: (ImportImageSource | string)[], name = ""): Promise<ImportImagesResult> => {
	const list = (Array.isArray(sources) ? sources : [])
		.map((entry) => {
			if (typeof entry === "string") return { url: entry.trim(), source_page: "" }
			return { url: String(entry?.url || "").trim(), source_page: String(entry?.source_page || "").trim() }
		})
		.filter((entry) => entry.url)
		.slice(0, 12)
	if (!list.length) return { ok: false, items: [], message: "没有要导入的图片", disabled: false }
	try {
		const response = await fetch("/api/agent/images/import", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			/* 有出处页才带 source_page（空字符串会让服务端算出一个空 origin 的 Referer） */
			body: JSON.stringify({
				items: list.map((entry) => (entry.source_page ? { url: entry.url, source_page: entry.source_page } : { url: entry.url })),
				name,
			}),
		})
		const data = await readJson(response)
		if (!response.ok) {
			return {
				ok: false,
				items: [],
				message: httpErrorText(data, response.status),
				disabled: response.status === 403,
			}
		}
		const rows = Array.isArray(data.items) ? data.items : []
		const items: ImportedImageRow[] = rows.map((raw) => {
			const row = (raw || {}) as Record<string, unknown>
			return {
				source_url: String(row.source_url || ""),
				ok: row.ok === true,
				url: String(row.url || ""),
				width: toSize(row.width),
				height: toSize(row.height),
				bytes: Number(row.bytes) || 0,
				error: String(row.error || ""),
			}
		})
		return { ok: true, items, message: "", disabled: false }
	} catch (error) {
		return { ok: false, items: [], message: (error as Error)?.message || "网络错误", disabled: false }
	}
}

export interface ReverseImagesData {
	engine: string
	query: string
	queries: string[]
	description: string
	note: string
	items: ReferenceImage[]
}

export interface ReverseImagesResult {
	ok: boolean
	data: ReverseImagesData
	message: string
	disabled: boolean
}

const emptyReverseData = (): ReverseImagesData => ({
	engine: "",
	query: "",
	queries: [],
	description: "",
	note: "",
	items: [],
})

/** POST /api/agent/images/reverse：视觉模型生成检索词再走图搜，返回与 find_similar_images 同构 */
export const reverseImages = async (imageUrl: string, count = 12): Promise<ReverseImagesResult> => {
	const url = String(imageUrl || "").trim()
	if (!url) return { ok: false, data: emptyReverseData(), message: "没拿到要做反图的那张图", disabled: false }
	try {
		const response = await fetch("/api/agent/images/reverse", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ image_url: url, count }),
		})
		const data = await readJson(response)
		if (!response.ok) {
			return {
				ok: false,
				data: emptyReverseData(),
				message: httpErrorText(data, response.status),
				disabled: response.status === 403,
			}
		}
		return {
			ok: true,
			disabled: false,
			message: "",
			data: {
				engine: String(data.engine || ""),
				query: String(data.query || ""),
				queries: Array.isArray(data.queries) ? data.queries.map(String).filter(Boolean) : [],
				description: String(data.description || ""),
				note: String(data.note || ""),
				items: normalizeReferenceImageList(data.items),
			},
		}
	} catch (error) {
		return { ok: false, data: emptyReverseData(), message: (error as Error)?.message || "网络错误", disabled: false }
	}
}

export interface UploadImageResult {
	ok: boolean
	url: string
	name: string
	width: number | null
	height: number | null
	message: string
}

const failedUpload = (message: string): UploadImageResult => ({ ok: false, url: "", name: "", width: null, height: null, message })

/** 上传一张本地图片到素材库（复用现有 /api/local-assets/upload），返回它在服务端的本地地址 */
export const uploadImageFile = async (file: File): Promise<UploadImageResult> => {
	if (!file) return failedUpload("没有选中图片")
	try {
		const form = new FormData()
		form.append("files", file, file.name || "image")
		const response = await fetch("/api/local-assets/upload", { method: "POST", body: form })
		const data = await readJson(response)
		if (!response.ok) return failedUpload(httpErrorText(data, response.status))
		const rows = Array.isArray(data.files) ? data.files : []
		const row = (rows[0] || {}) as Record<string, unknown>
		const url = String(row.url || "")
		if (!url) return failedUpload("上传接口没有返回图片地址")
		return {
			ok: true,
			url,
			name: String(row.name || file.name || "图片"),
			width: toSize(row.width),
			height: toSize(row.height),
			message: "",
		}
	} catch (error) {
		return failedUpload((error as Error)?.message || "网络错误")
	}
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
	storeVisible: boolean
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
				storeVisible: row.store_visible !== false,
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