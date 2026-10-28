import {
	CheckIcon,
	ChevronDownIcon,
	ChevronsLeftIcon,
	FolderClosedIcon,
	GaugeIcon,
	GitBranchIcon,
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
import { createPortal } from "react-dom"
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
import { chooseFolder, folderSupported, forgetFolder, restoreFolder } from "./folder"
import type { FolderInfo } from "./folder"
import { formatRelative } from "./format"
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
	const [resetOpen, setResetOpen] = useState(false)
	const [folderOpen, setFolderOpen] = useState(false)
	const [folderInfo, setFolderInfo] = useState<FolderInfo | null>(null)
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
		} catch (error) {
			console.warn("[NVCA] 线程列表加载失败", error)
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
		if (menuOpen) void refreshThreads()
	}, [menuOpen, refreshThreads])

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
		if (folderOpen) void restoreFolder().then(setFolderInfo).catch(() => setFolderInfo(null))
	}, [folderOpen])

	useEffect(() => {
		if (!menuOpen && !moreOpen && !actionsId && !artifactsOpen && !folderOpen) return
		const onDown = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null
			if (target?.closest?.(".nvca-tap-header, .nvca-artifacts-sheet, .nvca-folder-permissions, .nvca-dialog")) return
			setMenuOpen(false)
			setMoreOpen(false)
			setActionsId("")
			setArtifactsOpen(false)
			setFolderOpen(false)
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			setMenuOpen(false)
			setMoreOpen(false)
			setActionsId("")
			setArtifactsOpen(false)
			setFolderOpen(false)
			setDeleteTarget(null)
			setResetOpen(false)
		}
		window.addEventListener("mousedown", onDown, true)
		window.addEventListener("keydown", onKey)
		return () => {
			window.removeEventListener("mousedown", onDown, true)
			window.removeEventListener("keydown", onKey)
		}
	}, [menuOpen, moreOpen, actionsId, artifactsOpen, folderOpen])

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
		setArtifactsOpen(false)
		setFolderOpen(false)
		clickHidden("canvasAssistantCollapseBtn")
	}

	const resetConversation = () => {
		store.clearHistory()
		setResetOpen(false)
		setMoreOpen(false)
		window.setTimeout(() => void refreshThreads(), 120)
	}

	const reauthorizeFolder = async () => {
		try {
			const info = await chooseFolder()
			if (info) {
				setFolderInfo(info)
				store.addFolderRef(info.name, info.count)
			}
		} catch (error) {
			if ((error as Error)?.name !== "AbortError") showNotice((error as Error)?.message || "选择文件夹失败")
		}
	}

	const removeFolder = async () => {
		await forgetFolder()
		setFolderInfo(null)
		store.removeRef("folder_last")
		showNotice("已移除本地文件夹授权")
	}

	const toggleFull = () => {
		const panel = document.getElementById("canvasAssistantPanel")
		if (!panel) return
		panel.style.width = ""
		panel.classList.toggle("is-full")
		const isFull = panel.classList.contains("is-full")
		setFull(isFull)
		if (isFull) {
			setArtifactsOpen(false)
			setFolderOpen(false)
		}
		document.documentElement.style.setProperty("--nvca-panel-width", panel.getBoundingClientRect().width + "px")
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
				<button
					aria-label="产物侧栏"
					aria-pressed={artifactsOpen}
					className="nvca-tap-head-btn is-sidebar"
					onClick={() => {
						setArtifactsOpen((open) => !open)
						setFolderOpen(false)
					}}
					title="产物侧栏"
					type="button"
				>
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
					<span className="nvca-tap-current-thread">{activeThread?.title || "新建对话"}</span>
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
												{thread.forked_from ? <GitBranchIcon className="nvca-i-xs nvca-tap-thread-branch" /> : null}
												<span className="nvca-tap-thread-title">{thread.title || "对话"}</span>
												<span className="nvca-tap-thread-count">{formatRelative(thread.updated_at || thread.created_at)}</span>
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
					<button className="nvca-tap-menu-item" onClick={() => { setMoreOpen(false); window.dispatchEvent(new CustomEvent("novai-canvas-assistant:context")) }} role="menuitem" type="button">
						<GaugeIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">用量统计</span>
					</button>
					<button className="nvca-tap-menu-item" onClick={collapse} role="menuitem" type="button">
						<ChevronsLeftIcon className="nvca-i-sm" />
						<span className="nvca-tap-menu-text">收起对话</span>
					</button>
				</div>
			) : null}

			{artifactsOpen ? createPortal(
				<ArtifactsSheet state={artifactState} onClose={() => setArtifactsOpen(false)} onReload={() => void loadArtifacts()} />,
				document.body,
			) : null}

			{folderOpen ? (
				<div className="nvca-folder-permissions" role="dialog" aria-label="本地文件权限">
					<div className="nvca-sheet-head">
						<div className="nvca-sheet-title"><FolderClosedIcon className="nvca-i-sm" /><span>本地文件权限</span></div>
						<button className="nvca-icon-btn" onClick={() => setFolderOpen(false)} title="关闭" type="button"><XIcon className="nvca-i-sm" /></button>
					</div>
					<div className="nvca-folder-permission-body">
						{folderInfo ? (
							<>
								<strong>{folderInfo.name}</strong>
								<span>允许读取此目录中的文件，约 {folderInfo.count} 个项目。文件只在你主动加入时上传。</span>
								<div className="nvca-folder-permission-actions">
									<button className="nvca-btn ghost" onClick={() => void reauthorizeFolder()} type="button">更换目录</button>
									<button className="nvca-btn ghost" onClick={() => void removeFolder()} type="button">移除授权</button>
								</div>
							</>
						) : (
							<>
								<strong>还没有授权目录</strong>
								<span>授权后可从本地文件夹选择素材；你可以随时移除。</span>
								<button className="nvca-btn ghost" onClick={() => void reauthorizeFolder()} type="button">选择文件夹</button>
							</>
						)}
					</div>
				</div>
			) : null}

			{resetOpen ? (
				<div className="nvca-dialog-scrim" onClick={() => setResetOpen(false)} role="presentation">
					<div className="nvca-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="重置对话">
						<div className="nvca-dialog-head"><div><h3 className="nvca-dialog-title">重置当前对话？</h3><p className="nvca-dialog-sub">当前线程的聊天记录会被清空，画布节点不受影响。</p></div></div>
						<div className="nvca-dialog-actions"><button className="nvca-btn ghost" onClick={() => setResetOpen(false)} type="button">取消</button><button className="nvca-btn danger" onClick={resetConversation} type="button">重置</button></div>
					</div>
				</div>
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
