import { CheckIcon, ChevronDownIcon, MoreHorizontalIcon, PackageIcon, Trash2Icon, XIcon } from "lucide-react"
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
import type { ArtifactList, ThreadRow } from "./api"
import { ArtifactsSheet } from "./ArtifactsSheet"
import type { ArtifactPanelState } from "./ArtifactsSheet"
import type { AssistantStore } from "./store"

const EMPTY_ARTIFACTS: ArtifactPanelState = { status: "idle", data: null, error: "" }

export const ThreadBar = ({ store }: { store: AssistantStore }) => {
	const { env } = store
	const [threads, setThreads] = useState<ThreadRow[]>([])
	const [activeId, setActiveId] = useState("")
	const [menuOpen, setMenuOpen] = useState(false)
	const [actionsId, setActionsId] = useState("")
	const [renamingId, setRenamingId] = useState("")
	const [renameValue, setRenameValue] = useState("")
	const [deleteTarget, setDeleteTarget] = useState<ThreadRow | null>(null)
	const [busy, setBusy] = useState(false)
	const [notice, setNotice] = useState("")
	const [artifactsOpen, setArtifactsOpen] = useState(false)
	const [artifactState, setArtifactState] = useState<ArtifactPanelState>(EMPTY_ARTIFACTS)
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
		if (!menuOpen && !actionsId && !artifactsOpen) return
		const onDown = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null
			if (target && target.closest && target.closest(".nvca-topbar")) return
			setMenuOpen(false)
			setActionsId("")
			setArtifactsOpen(false)
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			setMenuOpen(false)
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
	}, [menuOpen, actionsId, artifactsOpen])

	const activeThread = threads.find((thread) => String(thread.id) === String(activeId)) || null
	const currentTitle = activeThread?.title || "新对话"
	const artifactCount = artifactState.data ? artifactState.data.files.length : 0
	const onlyOne = threads.length <= 1

	const handleSwitch = async (thread: ThreadRow) => {
		setMenuOpen(false)
		setActionsId("")
		if (busy || String(thread.id) === String(activeId)) return
		setBusy(true)
		try {
			// 旧面板的 activeId 是发消息时真正用的 thread_id，必须同步切过去
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
		<div className="nvca-topbar">
			<div className="nvca-thread-cluster">
				<button
					aria-expanded={menuOpen}
					aria-haspopup="listbox"
					className="nvca-thread-btn"
					onClick={() => {
						const next = !menuOpen
						setMenuOpen(next)
						setActionsId("")
						if (next) void refreshThreads()
					}}
					title="切换对话线程"
					type="button"
				>
					<span className="nvca-thread-caption">对话</span>
					<span className="nvca-thread-current">{currentTitle}</span>
					<ChevronDownIcon className="nvca-i-xs nvca-thread-caret" />
				</button>

			</div>

			{menuOpen ? (
				<div className="nvca-thread-menu" role="listbox" aria-label="对话线程">
					{threads.length === 0 ? (
						<div className="nvca-thread-empty">还没有线程，发一条消息就会创建。</div>
					) : (
						threads.map((thread) => {
							const isActive = String(thread.id) === String(activeId)
							const renaming = String(thread.id) === String(renamingId)
							return (
								<div className={"nvca-thread-row" + (isActive ? " is-active" : "")} key={thread.id}>
									{renaming ? (
										<div className="nvca-thread-rename-row">
											<input
												autoFocus
												className="nvca-thread-rename"
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
												aria-label="对话名称"
											/>
											<button className="nvca-thread-rename-save" onClick={() => void commitRename()} type="button">保存</button>
										</div>
									) : (
										<>
											<button
												className="nvca-thread-pick"
												disabled={busy}
												onClick={() => void handleSwitch(thread)}
												role="option"
												aria-selected={isActive}
												type="button"
											>
												<span className="nvca-thread-row-title">{thread.title || "对话"}</span>
												<span className="nvca-thread-row-count">{Number(thread.message_count) || 0}</span>
												{isActive ? <CheckIcon className="nvca-i-xs nvca-thread-check" /> : null}
											</button>
											{String(actionsId) === String(thread.id) ? (
												<div className="nvca-thread-actions">
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
												className="nvca-thread-more"
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
						<div className="nvca-topbar-actions">
				<button
					aria-expanded={artifactsOpen}
					className={"nvca-artifacts-toggle" + (artifactsOpen ? " is-open" : "")}
					onClick={() => setArtifactsOpen((open) => !open)}
					title="查看助手产出的文件"
					type="button"
				>
					<PackageIcon className="nvca-i-sm" />
					<span>产物</span>
					{artifactCount > 0 ? <span className="nvca-artifacts-badge">{artifactCount}</span> : null}
				</button>
			</div>

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
		</div>
	)
}
