// 参考图选择卡的纯数据层：把工具结果 / 反图接口两种来源归一成同一张卡片能渲染的数据。
// 契约里 ImageItem 的字段名不许改，这里只做清洗与去重，不改语义。

import type { Part, ReferenceCardData, ReferenceImage, ReferenceSourceRow } from "./types"

/* 素材站中文名：筛选 chips 和缩略图来源标注都优先用它，认不出的回退域名 */
export const SOURCE_LABELS: Record<string, string> = {
	huaban: "花瓣",
	zcool: "站酷",
	bing: "必应",
	"360": "360",
	nipic: "昵图",
	duitang: "堆糖",
	tuchong: "图虫",
}

const str = (value: unknown): string => (value == null ? "" : String(value).trim())

const toSize = (value: unknown): number | null => {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

const looksLikeUrl = (value: string): boolean =>
	/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("data:")

export const normalizeReferenceImage = (raw: unknown): ReferenceImage | null => {
	if (!raw || typeof raw !== "object") return null
	const record = raw as Record<string, unknown>
	const original = str(record.original_url) || str(record.url)
	if (!original || !looksLikeUrl(original)) return null
	const thumb = str(record.thumb_url)
	return {
		id: str(record.id) || original,
		title: str(record.title),
		original_url: original,
		thumb_url: looksLikeUrl(thumb) ? thumb : "",
		width: toSize(record.width),
		height: toSize(record.height),
		source_page: str(record.source_page),
		source_site: str(record.source_site),
		source_kind: str(record.source_kind).toLowerCase(),
	}
}

export const normalizeReferenceImageList = (raw: unknown): ReferenceImage[] => {
	const rows = Array.isArray(raw) ? raw : []
	const seen = new Set<string>()
	const list: ReferenceImage[] = []
	for (const row of rows) {
		const image = normalizeReferenceImage(row)
		if (!image || seen.has(image.original_url)) continue
		seen.add(image.original_url)
		list.push(image)
	}
	/* 契约：单个工具结果的 items 上限 24 条 */
	return list.slice(0, 24)
}

export const referenceImagesOf = (value: unknown): ReferenceImage[] => {
	if (!value || typeof value !== "object") return []
	const record = value as Record<string, unknown>
	return normalizeReferenceImageList(record.items)
}

/** 联网关闭时后端返回 code=web_access_disabled / HTTP 403，卡片要显示指引而不是「失败」 */
export const isWebAccessDisabled = (code: unknown, message: unknown): boolean =>
	/web_access_disabled|联网未开启|联网已关闭|画布助手联网/i.test(str(code) + " " + str(message))

/** 已经是本地文件的图不需要再 import（服务端直接读盘，避免重复下载） */
export const isLocalImageUrl = (url: string): boolean => {
	const value = str(url)
	return value.startsWith("/uploads/") || value.startsWith("/assets/") || value.startsWith("/static/") || value.startsWith("data:")
}

const resultValueOf = (part: { result?: unknown; output?: unknown }): unknown => {
	if (part.result !== undefined && part.result !== null) return part.result
	const output = typeof part.output === "string" ? part.output.trim() : ""
	if (output.startsWith("{")) {
		try {
			return JSON.parse(output)
		} catch {
			return null
		}
	}
	return null
}

const emptyCard = (id: string, source: "search" | "reverse"): ReferenceCardData => ({
	id,
	source,
	status: "done",
	items: [],
	engine: "",
	query: "",
	queries: [],
	description: "",
	note: "",
	message: "",
	code: "",
	imageUrl: "",
	title: "",
	sources: [],
})

export const referenceCardFromReversePart = (part: Extract<Part, { type: "reference_images" }>): ReferenceCardData => ({
	id: part.id,
	source: "reverse",
	status: part.status,
	items: part.items,
	sources: referenceSourceRows(part.items, null),
	engine: part.engine,
	query: part.query,
	queries: part.queries,
	description: part.description,
	note: part.note,
	message: part.message,
	code: part.code,
	imageUrl: part.imageUrl,
	title: part.title,
})

const SEARCH_TOOLS = new Set(["search_images", "find_similar_images"])

/** 工具结果 → 选择卡：只处理 search_images / find_similar_images；
    有 items、有 items 字段（空结果带 note）、或联网关闭时出卡，其它失败仍由工具卡显示原因 */
export const referenceCardFromToolEvent = (part: {
	id: string
	tool: string
	status: string
	message: string
	code?: string
	args?: unknown
	result?: unknown
	output?: unknown
}): ReferenceCardData | null => {
	const tool = str(part.tool)
	if (!SEARCH_TOOLS.has(tool)) return null
	const disabled = part.status === "failed" && isWebAccessDisabled(part.code, part.message)
	const value = resultValueOf(part)
	const items = referenceImagesOf(value)
	const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
	/* 搜不到时后端会回 items: [] + note，这种空结果也要出卡说明真实原因 */
	const hasItemsField = Array.isArray(record.items)
	if (!items.length && !disabled && !hasItemsField && !str(record.note) && !str(record.engine)) return null
	const card = emptyCard(part.id, tool === "find_similar_images" ? "reverse" : "search")
	card.items = items
	card.sources = referenceSourceRows(items, record.sources)
	card.engine = str(record.engine)
	card.query = str(record.query)
	card.queries = Array.isArray(record.queries) ? record.queries.map((item) => str(item)).filter(Boolean) : []
	card.description = str(record.description)
	card.note = str(record.note)
	card.code = str(part.code)
	/* find_similar_images 的原始图在 args 里（结果只带检索词与 items） */
	const args = (part.args && typeof part.args === "object" ? part.args : {}) as Record<string, unknown>
	card.imageUrl = str(record.image_url) || str(args.image_url)
	if (disabled) {
		card.status = "disabled"
		card.message = str(part.message)
	} else if (part.status === "running") {
		card.status = "loading"
	} else if (part.status === "failed") {
		card.status = "failed"
		card.message = str(part.message)
	}
	return card
}

export const referenceCardFromPart = (part: Part): ReferenceCardData | null => {
	if (part.type === "reference_images") return referenceCardFromReversePart(part)
	if (part.type === "tool_event") return referenceCardFromToolEvent(part)
	return null
}

export const sizeLabel = (image: ReferenceImage): string =>
	image.width && image.height ? image.width + "×" + image.height : "尺寸未知"

export const domainOf = (image: ReferenceImage): string => {
	if (image.source_site) return image.source_site
	const url = image.source_page || image.original_url
	try {
		return new URL(url).hostname
	} catch {
		return ""
	}
}

/** 服务端图片代理（花瓣这类 CDN 带 Referer 会 567）：只代理外链，本地/内联图不绕一圈 */
export const thumbProxyUrl = (url: string, width: number): string => {
	const value = str(url)
	if (!value || !/^https?:\/\//i.test(value)) return ""
	return "/api/agent/images/thumb?url=" + encodeURIComponent(value) + "&w=" + Math.round(Number(width) || 0)
}

/** 缩略图/预览上的来源标注：认得的素材站用中文名，认不出回退域名 */
export const sourceNameOf = (image: ReferenceImage): string =>
	SOURCE_LABELS[image.source_kind] || domainOf(image)

/** 该来源第一张图的域名：给「认不出的 source_kind」当 chip 文案 */
const domainOfKind = (items: ReferenceImage[], kind: string): string => {
	const hit = items.find((item) => item.source_kind === kind)
	return hit ? domainOf(hit) : ""
}

/**
 * 来源筛选行：数量优先取 result.sources（{"huaban": 12, "bing": 6}，0 条也可以下发），
 * 老数据没有 sources 就按 items 的 source_kind 现算；上层在只有一个来源时不显示这一排。
 */
export const referenceSourceRows = (items: ReferenceImage[], rawSources: unknown): ReferenceSourceRow[] => {
	const counts = new Map<string, number>()
	if (rawSources && typeof rawSources === "object" && !Array.isArray(rawSources)) {
		for (const [key, value] of Object.entries(rawSources as Record<string, unknown>)) {
			const kind = String(key || "").trim().toLowerCase()
			if (!kind) continue
			counts.set(kind, Number(value) || 0)
		}
	} else if (Array.isArray(rawSources)) {
		rawSources.forEach((entry) => {
			const kind = String(entry || "").trim().toLowerCase()
			if (kind && !counts.has(kind)) counts.set(kind, 0)
		})
	}
	/* items 补齐：老数据只有 source_kind 没有 sources；顺带兜住 sources 漏报的来源 */
	const fromItems = new Map<string, number>()
	items.forEach((item) => {
		const kind = item.source_kind || ""
		fromItems.set(kind, (fromItems.get(kind) || 0) + 1)
	})
	if (!counts.size) {
		fromItems.forEach((count, kind) => counts.set(kind, count))
	} else {
		fromItems.forEach((count, kind) => {
			if (!counts.has(kind)) counts.set(kind, count)
		})
	}
	const rows: ReferenceSourceRow[] = []
	counts.forEach((count, kind) => {
		const label = kind ? SOURCE_LABELS[kind] || domainOfKind(items, kind) || kind : "其他"
		rows.push({ kind, label, count })
	})
	return rows
}
