import {
	CheckIcon,
	ChevronDownIcon,
	ChevronsLeftIcon,
	HistoryIcon,
	Maximize2Icon,
	MoreHorizontalIcon,
	PackageIcon,
	PanelLeftIcon,
	RotateCcwIcon,
	SquarePenIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
	canvasId,
	deleteThread,
	fetchArtifacts,
	fetchThreads,
	renameThread,
	switchThreadApi,
	switchThreadViaLegacy,
} from "./api"
import type { ThreadRow } from "./api"
import { ArtifactsSheet } from "./ArtifactsSheet"
import type { ArtifactPanelState } from "./ArtifactsSheet"
import type { AssistantStore } from "./store"

const EMPTY_ARTIFACTS: ArtifactPanelState = { status: "idle", data: null, error: "" }

const clickHidden = (id: string) => {
	const el = document.getElementById(id) as HTMLElement | null
	if (el) el.click()
}

export const ThreadBar = ({ store }: { store: AssistantStore }) => {
	const { env } = store
	const [threads, setThreads] = useState<ThreadRow[]>([])
	const [activeId, setActiveId] = useState("")
	const [menuOpen, setMenuOpen] = useState(false)
	const [moreOpen, setMoreOpen] = useState(false)
	const [actionsId, setActionsId] = useState("")
	const [renamingId, setRenamingId] = useState("")
	const [renameValue, setRenameValue] = useState("")
	const [deleteTarget, setDeleteTarget] = useState<ThreadRow | null>(null)
	const [busy, setBusy] = useState(false)
	const [notice, setNotice] = useState("")
	const [artifactsOpen, setArtifactsOpen] = useState(false)
	const [artifactState, setArtifactState] = useState<ArtifactPanelState>(EMPTY_ARTIFACTS)
	const [full, setFull] = useState(false)
	const noticeTimer = useRef<number>(0)

	const showNotice = useCallback((text: string) => {
		setNotice(text)
		if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
		noticeTimer.current = window.setTimeout(() => setNotice(""), 2600)
	}, [])

	const refreshThreads = useCallback(async () => {
		if (!canvasId) return
		try {
			const data = await fetchThreads()
			setThreads(data.threads)
			setActiveId(data.active_id || (data.threads[0] ? data.threads[0].id : ""))
		} catch {
			/* 线程列表失败不打断对话 */
		}
	}, [])

	const loadArtifacts = useCallback(async () => {
		setArtifactState((prev) => ({ ...prev, status: "loading", error: "" }))
		try {
			const data = await fetchArtifacts()
			setArtifactState({ status: "ready", data, error: "" })
		} catch (error) {
			setArtifactState((prev) => ({ status: "error", data: prev.data, error: (error as Error)?.message || "网络错误" }))
		}
	}, [])

	useEffect(() => {
		void refreshThreads()
	}, [refreshThreads, env.threadRefresh])

	useEffect(() => {
		void loadArtifacts()
	}, [loadArtifacts, env.artifactRefresh])

	useEffect(() => {
		if (artifactsOpen) void loadArtifacts()
	}, [artifactsOpen, loadArtifacts])

	useEffect(() => {
		const panel = document.getElementById("canvasAssistantPanel")
		if (panel) setFull(panel.classList.contains("is-full"))
	}, [])

	useEffect(() => {
		const openArtifacts = () => setArtifactsOpen(true)
		window.addEventListener("novai-canvas-assistant:artifacts", openArtifacts)
		return () => window.removeEventListener("novai-canvas-assistant:artifacts", openArtifacts)
	}, [])

	useEffect(() => {
		if (!menuOpen && !moreOpen && !actionsId && !artifactsOpen) return
		const onDown = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null
			if (target && target.closest && target.closest(".nvca-tap-header")) return
			setMenuOpen(false)
			setMoreOpen(false)
			setActionsId("")
			setArtifactsOpen(false)
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			setMenuOpen(false)
			setMoreOpen(false)
			setActionsId("")
			setArtifactsOpen(false)
			setDeleteTarget(null)
		}
		window.addEventListener("mousedown", onDown, true)
		window.addEventListener("keydown", onKey)
		return () => {
			window.removeEventListener("mousedown", onDown, true)
			window.removeEventListener("keydown", onKey)
		}
	}, [menuOpen, moreOpen, actionsId, artifactsOpen])

	const activeThread = threads.find((thread) => String(thread.id) === String(activeId)) || null
	const artifactCount = artifactState.data ? artifactState.data.files.length : 0
	const onlyOne = threads.length <= 1

	const newChat = () => {
		setMenuOpen(false)
		setMoreOpen(false)
		const btn = document.getElementById("canvasAssistantNewChatBtn")
		if (btn) btn.click()
		else {
			store.clearHistory()
			store.notify("已新建对话")
		}
		window.setTimeout(() => void refreshThreads(), 120)
	}

	const collapse = () => {
		setMenuOpen(false)
		setMoreOpen(false)
		clickHidden("canvasAssistantCollapseBtn")
	}

	const toggleFull = () => {
		const panel = document.getElementById("canvasAssistantPanel")
		if (!panel) return
		panel.style.width = ""
		panel.classList.toggle("is-full")
		setFull(panel.classList.contains("is-full"))
		window.dispatchEvent(new Event("resize"))
	}

	const handleSwitch = async (thread: ThreadRow) => {
		setMenuOpen(false)
		setActionsId("")
		if (busy || String(thread.id) === String(activeId)) return
		setBusy(true)
		try {
			const viaLegacy = await switchThreadViaLegacy(thread.id)
			if (!viaLegacy) await switchThreadApi(thread.id)
			await new Promise((resolve) => window.setTimeout(resolve, 120))
			store.reloadHistory()
			await refreshThreads()
		} catch (error) {
			showNotice("切换失败：" + ((error as Error)?.message || "网络错误"))
		} finally {
			setBusy(false)
		}
	}

	const beginRename = (thread: ThreadRow) => {
		setActionsId("")
		setRenamingId(String(thread.id))
		setRenameValue(String(thread.title || ""))
	}

	const cancelRename = () => {
		setRenamingId("")
		setRenameValue("")
	}

	const commitRename = async () => {
		const id = renamingId
		if (!id) return
		const value = renameValue.trim()
		const current = threads.find((thread) => String(thread.id) === String(id))
		if (!value) {
			showNotice("标题不能为空")
			return
		}
		if (current && value === String(current.title || "")) {
			cancelRename()
			return
		}
		try {
			await renameThread(id, value)
			cancelRename()
			await refreshThreads()
			showNotice("已重命名对话")
		} catch (error) {
			showNotice("重命名失败：" + ((error as Error)?.message || "网络错误"))
		}
	}

	const confirmDelete = async () => {
		const target = deleteTarget
		if (!target || busy) return
		setBusy(true)
		try {
			const result = await deleteThread(String(target.id))
			setDeleteTarget(null)
			await refreshThreads()
			if (String(target.id) === String(activeId)) {
				if (result.active_id) await switchThreadViaLegacy(result.active_id)
				store.reloadHistory()
			}
			showNotice("已删除对话")
		} catch (error) {
			showNotice("删除失败：" + ((error as Error)?.message || "网络错误"))
		} finally {
			setBusy(false)
		}
	}

	return (
		<header className="nvca-tap-header">
			<div className="nvca-tap-header-left">
				<button className="nvca-tap-head-btn is-sidebar" onClick={collapse} title="侧边栏" aria-label="侧边栏" type="button">
					<PanelLeftIcon className="nvca-tap-head-icon-svg" />
				</button>
				<button
					aria-expanded={menuOpen}
					aria-haspopup="listbox"
					className="nvca-tap-newchat"
					onClick={() => {
						const next = !menuOpen
						setMenuOpen(next)
						setMoreOpen(false)
						setActionsId("")
						if (next) void refreshThreads()
					}}
					type="button"
				>
					<span>新建对话</span>
					<ChevronDownIcon className="nvca-i-xs" />
				</button>
			</div>
			<div className="nvca-tap-header-right">
				<button className="nvca-tap-head-btn" onClick={newChat} title="新对话" aria-label="新对话" type="button">
					<SquarePenIcon className="nvca-tap-head-icon-svg" />
				</button>
				<button
					aria-pressed={full}
					className="nvca-tap-head-btn"
					onClick={toggleFull}
					title="Agent 全屏"
					aria-label="Agent 全屏"
					type="button"
				>
					<Maximize2Icon className="nvca-tap-head-icon-svg" />
				</button>
				<button
					aria-expanded={moreOpen}
					className="nvca-tap-head-btn"
					onClick={() => {
						setMoreOpen((open) => !open)
						setMenuOpen(false)
					}}
					title="更多选项"
					aria-label="更多选项"
					type="button"
				>
					<MoreHorizontalIcon className="nvca-tap-head-icon-svg" />
				</button>
			</div>

			{menuOpen ? (
				<div className="nvca-tap-thread-menu" role="listbox" aria-label="对话线程">
					<button className="nvca-tap-menu-item is-new" onClick={newChat} type="button">
						<SquarePenIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">新建对话</span>
					</button>
					<div className="nvca-tap-menu-sep" />
					{threads.length === 0 ? (
						<div className="nvca-tap-menu-empty">还没有线程，发一条消息就会创建。</div>
					) : (
						threads.map((thread) => {
							const isActive = String(thread.id) === String(activeId)
							const renaming = String(thread.id) === String(renamingId)
							return (
								<div className={"nvca-tap-thread-row" + (isActive ? " is-active" : "")} key={thread.id}>
									{renaming ? (
										<div className="nvca-tap-thread-rename-row">
											<input
												autoFocus
												aria-label="对话名称"
												className="nvca-tap-thread-rename"
												maxLength={60}
												onChange={(event) => setRenameValue(event.currentTarget.value)}
												onKeyDown={(event) => {
													event.stopPropagation()
													if (event.key === "Enter") {
														event.preventDefault()
														void commitRename()
													} else if (event.key === "Escape") {
														event.preventDefault()
														cancelRename()
													}
												}}
												value={renameValue}
											/>
											<button className="nvca-tap-thread-save" onClick={() => void commitRename()} type="button">保存</button>
										</div>
									) : (
										<>
											<button
												className="nvca-tap-thread-pick"
												disabled={busy}
												onClick={() => void handleSwitch(thread)}
												role="option"
												aria-selected={isActive}
												type="button"
											>
												<span className="nvca-tap-thread-title">{thread.title || "对话"}</span>
												<span className="nvca-tap-thread-count">{Number(thread.message_count) || 0}</span>
												{isActive ? <CheckIcon className="nvca-i-xs nvca-tap-thread-check" /> : null}
											</button>
											{String(actionsId) === String(thread.id) ? (
												<div className="nvca-tap-thread-actions">
													<button onClick={() => beginRename(thread)} type="button">重命名</button>
													<button
														disabled={onlyOne}
														title={onlyOne ? "至少保留一条对话" : "删除这条对话"}
														onClick={() => {
															setActionsId("")
															setDeleteTarget(thread)
														}}
														type="button"
													>
														删除
													</button>
												</div>
											) : null}
											<button
												className="nvca-tap-thread-more"
												onClick={(event) => {
													event.stopPropagation()
													setActionsId((current) => (current === String(thread.id) ? "" : String(thread.id)))
												}}
												aria-label={"对话操作：" + (thread.title || "对话")}
												type="button"
											>
												<MoreHorizontalIcon className="nvca-i-sm" />
											</button>
										</>
									)}
								</div>
							)
						})
					)}
				</div>
			) : null}

			{moreOpen ? (
				<div className="nvca-tap-more-menu" role="menu">
					<button
						className="nvca-tap-menu-item"
						onClick={() => {
							setMoreOpen(false)
							setArtifactsOpen(true)
						}}
						role="menuitem"
						type="button"
					>
						<PackageIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">产物</span>
						{artifactCount > 0 ? <span className="nvca-tap-menu-count">{artifactCount}</span> : null}
					</button>
					<button
						className="nvca-tap-menu-item"
						onClick={() => {
							setMoreOpen(false)
							store.openHistory()
						}}
						role="menuitem"
						type="button"
					>
						<HistoryIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">历史记录</span>
					</button>
					<button
						className="nvca-tap-menu-item"
						onClick={() => {
							setMoreOpen(false)
							store.clearHistory()
						}}
						role="menuitem"
						type="button"
					>
						<RotateCcwIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">重置对话</span>
					</button>
					<button
						className="nvca-tap-menu-item"
						onClick={collapse}
						role="menuitem"
						type="button"
					>
						<ChevronsLeftIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">收起面板</span>
					</button>
				</div>
			) : null}

			{artifactsOpen ? (
				<ArtifactsSheet
					state={artifactState}
					onClose={() => setArtifactsOpen(false)}
					onReload={() => void loadArtifacts()}
				/>
			) : null}

			{deleteTarget ? (
				<div className="nvca-dialog-scrim" onClick={() => setDeleteTarget(null)} role="presentation">
					<div className="nvca-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="删除对话">
						<div className="nvca-dialog-head">
							<div>
								<h3 className="nvca-dialog-title">删除对话「{deleteTarget.title || "对话"}」？</h3>
								<p className="nvca-dialog-sub">该对话的历史会一并删除，不可恢复。</p>
							</div>
							<button className="nvca-icon-btn" onClick={() => setDeleteTarget(null)} title="关闭" aria-label="取消删除" type="button">
								<XIcon className="nvca-i-sm" />
							</button>
						</div>
						<div className="nvca-dialog-actions">
							<button className="nvca-btn ghost" onClick={() => setDeleteTarget(null)} type="button">取消</button>
							<button className="nvca-btn danger" disabled={busy || onlyOne} onClick={() => void confirmDelete()} type="button">
								<Trash2Icon className="nvca-i-sm" />
								删除
							</button>
						</div>
					</div>
				</div>
			) : null}

			{notice ? <div className="nvca-bar-notice">{notice}</div> : null}
		</header>
	)
}
