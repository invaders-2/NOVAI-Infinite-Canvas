import {
	AlertTriangleIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	ImageIcon,
	Loader2Icon,
	PlusIcon,
	WifiOffIcon,
	XIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { importImages } from "./api"
import { isWebAccessDisabled, sizeLabel, sourceNameOf, thumbProxyUrl } from "./reference"
import type { AssistantStore } from "./store"
import type { ReferenceCardData, ReferenceImage } from "./types"

/* 参考图选择卡：把 search_images / find_similar_images 的结果渲染成可多选的图墙。
   加入画布只走原图直链 → POST /api/agent/images/import → 宿主 api.insertImages(本地 url)，
   失败一律显示服务端给的真实原因，绝不用 thumb_url 或占位图兜底。
   默认只露一排 3 张，双击缩略图看大图（单击仍然是选中）。 */

const IMPORT_CHUNK = 12
const DEFAULT_VISIBLE = 3
/* 单击后等这么久再切选中：双击会先触发两次 click，靠这个窗口把选中状态让出来 */
const CLICK_DELAY_MS = 220
/* 两次 click 间隔小于这个值就算双击（桥接层的画布手势守卫会吞掉 dblclick 事件） */
const DOUBLE_CLICK_MS = 350

const cardTitle = (card: ReferenceCardData): string => {
	if (card.source === "reverse") return "以图搜图 · 相似参考图"
	return "参考图"
}

/* 403 的 detail 本身就是那句指引，别在卡片里重复两遍 */
const detailNote = (message: string): string => {
	const text = String(message || "").trim()
	if (!text) return ""
	return /设置|联网/.test(text) ? "" : text
}

const previewHref = (item: ReferenceImage): string => item.source_page || item.original_url

/* 缩略图回退链：thumb_url → 代理 thumb(w=480) → 代理 original(w=720) → 占位。
   花瓣/堆糖的 CDN 带 Referer 会 567，所以第二级开始走服务端代理（相对路径，不写死后端地址）。 */
const thumbSourcesOf = (item: ReferenceImage): string[] => {
	const list: string[] = []
	const push = (url: string) => {
		if (url && !list.includes(url)) list.push(url)
	}
	push(item.thumb_url)
	push(thumbProxyUrl(item.thumb_url, 480))
	push(thumbProxyUrl(item.original_url, 720))
	return list
}

/* 大图回退链：original → 代理 original(w=1200) → thumb → 占位；note 标在当前这级上 */
interface PreviewSource {
	url: string
	note: string
}

const previewSourcesOf = (item: ReferenceImage): PreviewSource[] => {
	const list: PreviewSource[] = []
	const push = (url: string, note: string) => {
		if (url && !list.some((entry) => entry.url === url)) list.push({ url, note })
	}
	push(item.original_url, "")
	push(thumbProxyUrl(item.original_url, 1200), "原图加载失败，显示的是服务端代理图")
	push(item.thumb_url, "原图加载失败，显示的是缩略图")
	return list
}

/* 放大预览：居中、80vw/80vh 上限、深色遮罩；←/→ 换图，Esc / 点遮罩关闭。
   大图优先 original_url，加载失败退回 thumb_url 并明确标注。 */
const ReferenceImageLightbox = ({
	items,
	index,
	onClose,
	onStep,
}: {
	items: ReferenceImage[]
	index: number
	onClose: () => void
	onStep: (delta: number) => void
}) => {
	const item = items[index]
	const [sourceIndex, setSourceIndex] = useState(0)
	const [loaded, setLoaded] = useState(false)
	useEffect(() => {
		setSourceIndex(0)
		setLoaded(false)
	}, [index])
	useEffect(() => {
		/* 键盘事件要 stopPropagation：画布自己也监听 Esc / 方向键（方向键会挪选中节点） */
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault()
				event.stopPropagation()
				onClose()
				return
			}
			if (event.key === "ArrowLeft") {
				event.preventDefault()
				event.stopPropagation()
				onStep(-1)
				return
			}
			if (event.key === "ArrowRight") {
				event.preventDefault()
				event.stopPropagation()
				onStep(1)
			}
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [onClose, onStep])
	if (!item) return null
	const href = previewHref(item)
	const sources = previewSourcesOf(item)
	const current = sourceIndex < sources.length ? sources[sourceIndex] : null
	/* 这条链走完还没加载出来：大图区直接说明，不再死循环换地址 */
	const exhausted = sources.length === 0 || !current
	return createPortal(
		<div
			aria-label={item.title || "参考图预览"}
			aria-modal="true"
			className="nvca-refimgs-lightbox"
			onClick={onClose}
			role="dialog"
		>
			<div className="nvca-refimgs-lightbox-body" onClick={(event) => event.stopPropagation()}>
				<div className="nvca-refimgs-lightbox-media">
					{current ? (
						<img
							alt={item.title || "参考图"}
							onError={() => {
								setLoaded(false)
								setSourceIndex((value) => value + 1)
							}}
							onLoad={() => setLoaded(true)}
							src={current.url}
						/>
					) : null}
					{exhausted ? <span className="nvca-refimgs-lightbox-empty">大图加载失败，可以点右侧「查看出处」看原页</span> : null}
					{!loaded && !exhausted ? (
						<span className="nvca-refimgs-lightbox-pending">
							<Loader2Icon className="nvca-i-sm nvca-spin" />
							{sourceIndex === 0 ? "正在加载大图…" : "原图不可用，正在换成代理图…"}
						</span>
					) : null}
					{items.length > 1 ? (
						<>
							<button
								aria-label="上一张"
								className="nvca-refimgs-lightbox-nav is-prev"
								onClick={() => onStep(-1)}
								type="button"
							>
								<ChevronLeftIcon className="nvca-i-lg" />
							</button>
							<button
								aria-label="下一张"
								className="nvca-refimgs-lightbox-nav is-next"
								onClick={() => onStep(1)}
								type="button"
							>
								<ChevronRightIcon className="nvca-i-lg" />
							</button>
						</>
					) : null}
				</div>
				<div className="nvca-refimgs-lightbox-info">
					<div className="nvca-refimgs-lightbox-titlerow">
						<span className="nvca-refimgs-lightbox-title">{item.title || "参考图"}</span>
						<span className="nvca-refimgs-lightbox-index">
							{index + 1} / {items.length}
						</span>
					</div>
					<div className="nvca-refimgs-lightbox-meta">
						<span>{sizeLabel(item)}</span>
						<span>{sourceNameOf(item) || "来源未知"}</span>
						{href ? (
							<a href={href} rel="noreferrer" target="_blank">
								查看出处
								<ExternalLinkIcon className="nvca-i-xs" />
							</a>
						) : null}
					</div>
					{!exhausted && current && current.note ? <div className="nvca-refimgs-lightbox-warn">{current.note}</div> : null}
				</div>
				<button aria-label="关闭预览" className="nvca-refimgs-lightbox-close" onClick={onClose} type="button">
					<XIcon className="nvca-i-sm" />
				</button>
			</div>
		</div>,
		document.body,
	)
}

export const ReferenceImagesCard = ({ card, store }: { card: ReferenceCardData; store: AssistantStore }) => {
	const [selected, setSelected] = useState<string[]>([])
	const [busy, setBusy] = useState(false)
	const [errors, setErrors] = useState<Record<string, string>>({})
	const [added, setAdded] = useState<string[]>([])
	const [expanded, setExpanded] = useState(false)
	const [sourceFilter, setSourceFilter] = useState<string | null>(null)
	const [previewIndex, setPreviewIndex] = useState<number | null>(null)
	/* 缩略图走到回退链第几级：0=thumb_url，1=代理 thumb，2=代理 original，越界=占位 */
	const [thumbSteps, setThumbSteps] = useState<Record<string, number>>({})
	/* 每张图各有一个「等一会儿再切选中」的定时器：快速连点多张时不能互相取消 */
	const clickTimersRef = useRef<Map<string, number>>(new Map())
	const lastClickRef = useRef<{ url: string; at: number }>({ url: "", at: 0 })

	useEffect(() => {
		const timers = clickTimersRef.current
		return () => {
			timers.forEach((timer) => window.clearTimeout(timer))
			timers.clear()
		}
	}, [])

	/* 来源筛选：多来源才出 chips；过滤只影响「看得见哪些」，选中集合按 original_url 保留 */
	const sourceRows = card.sources
	const filteredItems =
		sourceFilter === null ? card.items : card.items.filter((item) => (item.source_kind || "") === sourceFilter)
	const filterLabel = sourceFilter === null ? "" : sourceRows.find((row) => row.kind === sourceFilter)?.label || sourceFilter
	const selectable = filteredItems.filter((item) => !added.includes(item.original_url))
	const allSelected = selectable.length > 0 && selectable.every((item) => selected.includes(item.original_url))
	const hiddenCount = Math.max(0, filteredItems.length - DEFAULT_VISIBLE)
	const visibleEntries = (expanded ? filteredItems : filteredItems.slice(0, DEFAULT_VISIBLE)).map((item, index) => ({ item, index }))

	const selectSource = (kind: string | null) => {
		setSourceFilter(kind)
		/* 切来源重置折叠，避免上一个来源的展开状态串过来 */
		setExpanded(false)
	}

	const toggle = (url: string) => {
		if (added.includes(url)) return
		setSelected((list) => (list.includes(url) ? list.filter((item) => item !== url) : [...list, url]))
	}

	const onThumbError = (item: ReferenceImage) => {
		setThumbSteps((current) => ({ ...current, [item.original_url]: (current[item.original_url] || 0) + 1 }))
	}

	/* 桥接层的 guardPanelEvents 会在捕获阶段吞掉 dblclick（画布手势守卫），
	   所以双击靠两次 click 的时间差自己认：第二次 click 取消待执行的选中并打开预览。 */
	const onCellClick = (url: string, index: number) => {
		if (busy) return
		const now = Date.now()
		const last = lastClickRef.current
		const pending = clickTimersRef.current.get(url)
		if (last.url === url && now - last.at <= DOUBLE_CLICK_MS) {
			lastClickRef.current = { url, at: 0 }
			if (pending) {
				window.clearTimeout(pending)
				clickTimersRef.current.delete(url)
			}
			openPreview(index)
			return
		}
		lastClickRef.current = { url, at: now }
		if (pending) {
			window.clearTimeout(pending)
			clickTimersRef.current.delete(url)
		}
		clickTimersRef.current.set(
			url,
			window.setTimeout(() => {
				clickTimersRef.current.delete(url)
				toggle(url)
			}, CLICK_DELAY_MS),
		)
	}

	const openPreview = (index: number) => {
		clickTimersRef.current.forEach((timer) => window.clearTimeout(timer))
		clickTimersRef.current.clear()
		setPreviewIndex(index)
	}

	const closePreview = () => setPreviewIndex(null)

	const stepPreview = (delta: number) => {
		setPreviewIndex((current) => {
			if (current === null) return null
			const total = filteredItems.length
			if (!total) return null
			return (current + delta + total) % total
		})
	}

	const toggleAll = () => {
		const urls = selectable.map((item) => item.original_url)
		setSelected((list) => {
			/* 取消全选只清当前筛选这几张；其它来源已经选中的保留 */
			if (allSelected) return list.filter((url) => !urls.includes(url))
			const next = new Set(list)
			urls.forEach((url) => next.add(url))
			return [...next]
		})
	}

	const insert = async () => {
		const chosen = card.items.filter((item) => selected.includes(item.original_url))
		if (!chosen.length) {
			store.notify("先选择要加入画布的参考图")
			return
		}
		setBusy(true)
		setErrors({})
		const failures: Record<string, string> = {}
		const imported: { original: string; local: { url: string; name: string; width: number | null; height: number | null } }[] = []
		for (let start = 0; start < chosen.length; start += IMPORT_CHUNK) {
			const chunk = chosen.slice(start, start + IMPORT_CHUNK)
			const result = await importImages(
				/* 带上出处页：服务端用它的 origin 当 Referer，防盗链站点才拿得到原图 */
				chunk.map((item) => ({ url: item.original_url, source_page: item.source_page })),
				card.title || card.query || "",
			)
			if (!result.ok) {
				const reason = result.disabled
					? "联网未开启，先在 设置 → 通用 打开「画布助手联网」"
					: result.message || "导入失败"
				chunk.forEach((item) => {
					failures[item.original_url] = reason
				})
				continue
			}
			for (const item of chunk) {
				const row = result.items.find((entry) => entry.source_url === item.original_url)
				if (!row) {
					failures[item.original_url] = "导入接口没有返回这张图，可能是服务端漏处理"
					continue
				}
				if (!row.ok || !row.url) {
					failures[item.original_url] = row.error || "导入失败（服务端没有给出原因）"
					continue
				}
				imported.push({
					original: item.original_url,
					local: {
						url: row.url,
						name: item.title || card.title || "参考图",
						width: row.width ?? item.width,
						height: row.height ?? item.height,
					},
				})
			}
		}
		if (Object.keys(failures).length) setErrors(failures)
		if (!imported.length) {
			const firstReason = chosen.map((item) => failures[item.original_url]).find(Boolean)
			store.notify("加入画布失败：" + (firstReason || "没有一张导入成功"))
		}
		if (imported.length) {
			const result = await store.insertReferenceImages(imported.map((entry) => entry.local))
			if (result.ok) {
				const done = imported.map((entry) => entry.original)
				setAdded((list) => [...list, ...done])
				setSelected((list) => list.filter((url) => !done.includes(url)))
			} else {
				const reason = result.message || "加入画布失败"
				const extra: Record<string, string> = {}
				imported.forEach((entry) => {
					extra[entry.original] = reason
				})
				setErrors((current) => ({ ...current, ...extra }))
			}
		}
		setBusy(false)
	}

	const state = card.status
	const showGrid = (state === "done" || state === "failed") && card.items.length > 0

	return (
		<div className="nvca-refimgs" data-source={card.source} data-state={state}>
			<div className="nvca-refimgs-head">
				<span className="nvca-refimgs-icon">
					{state === "disabled" ? <WifiOffIcon className="nvca-i-sm" /> : <ImageIcon className="nvca-i-sm" />}
				</span>
				<span className="nvca-refimgs-title">{cardTitle(card)}</span>
				{card.items.length > 0 ? <span className="nvca-refimgs-count">{card.items.length}</span> : null}
				{card.query ? <span className="nvca-refimgs-query">{card.query}</span> : null}
				{card.engine ? <span className="nvca-refimgs-engine">{card.engine}</span> : null}
			</div>

			{card.source === "reverse" && state === "loading" && card.imageUrl ? (
				<div className="nvca-refimgs-subject">
					<img alt="用于反查的图" src={card.imageUrl} />
					<span>正在按这张图生成检索词并搜相似图…</span>
				</div>
			) : null}
			{card.source === "reverse" && state === "done" ? (
				<div className="nvca-refimgs-subject">
					{card.imageUrl ? <img alt="用于反查的图" src={card.imageUrl} /> : null}
					<span>
						{card.description || "已按这张图反查"}
						{card.queries.length ? " · 检索词：" + card.queries.join(" / ") : ""}
					</span>
				</div>
			) : null}

			{state === "loading" ? (
				<div className="nvca-refimgs-loading">
					<Loader2Icon className="nvca-i-sm nvca-spin" />
					<span>{card.source === "reverse" ? "正在找相似参考图…" : "正在搜索参考图…"}</span>
				</div>
			) : null}

			{state === "disabled" ? (
				<div className="nvca-refimgs-state is-warn">
					<span className="nvca-refimgs-state-title">联网未开启</span>
					<span className="nvca-refimgs-state-body">
						先在「设置 → 通用 → 画布助手联网」打开联网，再让我搜参考图。
						{detailNote(card.message) ? "服务端原因：" + detailNote(card.message) : ""}
					</span>
				</div>
			) : null}

			{state === "failed" ? (
				<div className={cn("nvca-refimgs-state", "is-error")}>
					<span className="nvca-refimgs-state-title">
						<AlertTriangleIcon className="nvca-i-xs" />
						{isWebAccessDisabled(card.code, card.message) ? "联网未开启" : "找图失败"}
					</span>
					<span className="nvca-refimgs-state-body">
						{card.message || "服务端没有给出原因"}
						{isWebAccessDisabled(card.code, card.message) && !/设置|联网/.test(card.message)
							? "（设置 → 通用 → 画布助手联网）"
							: ""}
					</span>
				</div>
			) : null}

			{state === "done" && card.items.length === 0 ? (
				<div className="nvca-refimgs-state">
					<span className="nvca-refimgs-state-title">没有搜到参考图</span>
					<span className="nvca-refimgs-state-body">{card.note || "服务端没有给出原因，换个说法再试"}</span>
				</div>
			) : null}

			{state === "done" && card.items.length > 0 && card.note ? (
				<div className="nvca-refimgs-note">{card.note}</div>
			) : null}

			{showGrid ? (
				<>
					{sourceRows.length > 1 ? (
						<div aria-label="按来源筛选" className="nvca-refimgs-sources" role="tablist">
							<button
								aria-selected={sourceFilter === null}
								className={cn("nvca-refimgs-source", sourceFilter === null && "is-on")}
								onClick={() => selectSource(null)}
								role="tab"
								type="button"
							>
								全部
								<span className="nvca-refimgs-source-count">{card.items.length}</span>
							</button>
							{sourceRows.map((row) => (
								<button
									aria-selected={sourceFilter === row.kind}
									className={cn("nvca-refimgs-source", sourceFilter === row.kind && "is-on")}
									key={row.kind || "other"}
									onClick={() => selectSource(row.kind)}
									role="tab"
									type="button"
								>
									{row.label}
									<span className="nvca-refimgs-source-count">{row.count}</span>
								</button>
							))}
						</div>
					) : null}
					{filteredItems.length === 0 ? (
						<div className="nvca-refimgs-empty">
							{filterLabel ? "这个来源这次没搜到（" + filterLabel + "）" : "这个来源这次没搜到"}
						</div>
					) : null}
					<div className="nvca-refimgs-grid" data-expanded={expanded ? "true" : "false"}>
						{visibleEntries.map(({ item, index }) => {
							const isAdded = added.includes(item.original_url)
							const isSelected = selected.includes(item.original_url)
							const error = errors[item.original_url]
							const href = previewHref(item)
							const thumbSources = thumbSourcesOf(item)
							const thumbStep = thumbSteps[item.original_url] || 0
							const thumbSrc = thumbSources[thumbStep] || ""
							const showThumb = Boolean(thumbSrc)
							return (
								<div className={cn("nvca-refimg", isSelected && "is-selected", isAdded && "is-added")} key={item.original_url}>
									<button
										aria-label={(isSelected ? "取消选中 " : "选中 ") + (item.title || "参考图")}
										aria-pressed={isSelected}
										className="nvca-refimg-cell"
										disabled={busy}
										onClick={() => onCellClick(item.original_url, index)}
										title={(item.title || item.original_url) + "（双击放大）"}
										type="button"
									>
										{showThumb ? (
											<img
												alt={item.title || "参考图"}
												loading="lazy"
												onError={() => onThumbError(item)}
												referrerPolicy="no-referrer"
												src={thumbSrc}
											/>
										) : (
											<span className="nvca-refimg-noimg">
												<ImageIcon className="nvca-i-sm" />
												<span>{item.thumb_url || item.original_url ? "缩略图加载失败" : "没有缩略图"}</span>
											</span>
										)}
										<span className="nvca-refimg-mark">
											{isAdded ? <CheckIcon className="nvca-i-xs" /> : isSelected ? <CheckIcon className="nvca-i-xs" /> : null}
										</span>
									</button>
									<div className="nvca-refimg-meta">
										<span className="nvca-refimg-size">{sizeLabel(item)}</span>
										<a
											className="nvca-refimg-source"
											href={href}
											rel="noreferrer"
											target="_blank"
											title={href}
										>
											<span>{sourceNameOf(item) || "查看出处"}</span>
											<ExternalLinkIcon className="nvca-i-xs" />
										</a>
									</div>
									{isAdded ? <div className="nvca-refimg-added">已加入画布</div> : null}
									{error ? <div className="nvca-refimg-error">{error}</div> : null}
								</div>
							)
						})}
					</div>
					{hiddenCount > 0 ? (
						<button
							aria-expanded={expanded}
							className="nvca-refimgs-more"
							onClick={() => setExpanded((value) => !value)}
							type="button"
						>
							{expanded ? "收起" : "展开全部 (" + filteredItems.length + ")"}
							<ChevronRightIcon className={cn("nvca-i-xs", expanded && "is-open")} />
						</button>
					) : null}
					<div className="nvca-refimgs-foot">
						<span className="nvca-refimgs-selected">
							{selected.length > 0
								? "已选 " + selected.length + " 张"
								: filteredItems.length < card.items.length
									? "共 " + filteredItems.length + " 张（全部 " + card.items.length + "），默认不选"
									: "共 " + card.items.length + " 张，默认不选"}
						</span>
						<button className="nvca-link-btn" onClick={toggleAll} type="button">
							{allSelected ? "取消全选" : "全选"}
						</button>
						<button className="nvca-btn primary" disabled={busy || selected.length === 0} onClick={() => void insert()} type="button">
							{busy ? <Loader2Icon className="nvca-i-sm nvca-spin" /> : <PlusIcon className="nvca-i-sm" />}
							{busy ? "正在加入…" : "加入画布 (" + selected.length + ")"}
						</button>
					</div>
				</>
			) : null}

			{previewIndex !== null ? (
				<ReferenceImageLightbox
					index={previewIndex}
					items={filteredItems}
					onClose={closePreview}
					onStep={stepPreview}
				/>
			) : null}
		</div>
	)
}
