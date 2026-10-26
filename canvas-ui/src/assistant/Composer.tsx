import {
	ArrowUpIcon,
	CheckIcon,
	ChevronUpIcon,
	CircleIcon,
	FolderClosedIcon,
	HandIcon,
	ImageUpIcon,
	LayoutGridIcon,
	MicIcon,
	PuzzleIcon,
	MousePointerSquareDashedIcon,
	PencilIcon,
	SendHorizontalIcon,
	PlusIcon,
	ScissorsIcon,
	ShieldIcon,
	SparklesIcon,
	SquareIcon,
	XIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
	PromptInput,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	PromptInputHeader,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
	usePromptInputController,
} from "../ai-elements/prompt-input"
import {
	Attachment,
	AttachmentInfo,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "../ai-elements/attachments"
import { PlusMenu } from "./PlusMenu"
import { ScreenshotPicker } from "./ScreenshotPicker"
import { listFolderFiles, restoreFolder } from "./folder"
import { cn } from "@/lib/utils"
import { fetchCanvasNodes } from "./api"
import type { CanvasNodeSummary } from "./api"
import { formatTokens } from "./format"
import type { AssistantStore } from "./store"

interface SlashCommand {
	name: string
	description: string
	action: "new" | "plan" | "auto" | "attach" | "artifacts" | "context" | "clear"
}

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "new", description: "新对话：清空当前对话并新建", action: "new" },
	{ name: "plan", description: "先出方案：本轮强制手动确认", action: "plan" },
	{ name: "auto", description: "自动执行：只读步骤直接跑", action: "auto" },
	{ name: "attach", description: "添加内容：引用节点或上传素材", action: "attach" },
	{ name: "artifacts", description: "产物：打开本画布产物面板", action: "artifacts" },
	{ name: "context", description: "上下文：查看占用与上限", action: "context" },
	{ name: "clear", description: "清空输入：清掉输入框文字", action: "clear" },
]

interface ComposerProps {
	store: AssistantStore
	pendingText: { text: string; token: number } | null
}

const ComposerInner = ({ store, pendingText }: ComposerProps) => {
	const { env } = store
	const controller = usePromptInputController()
	const promptAttachments = usePromptInputAttachments()
	const text = controller.textInput.value
	const setText = controller.textInput.setInput
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const [pickMode, setPickMode] = useState(false)
	const [shotOpen, setShotOpen] = useState(false)
	const [plusOpen, setPlusOpen] = useState(false)
	const addButtonRef = useRef<HTMLButtonElement | null>(null)
	const [modelOpen, setModelOpen] = useState(false)
	const [mentionOpen, setMentionOpen] = useState(false)
	const [mentionNodes, setMentionNodes] = useState<CanvasNodeSummary[]>([])
	const [mentionLoading, setMentionLoading] = useState(false)
	const [attachmentPreview, setAttachmentPreview] = useState<{ url: string; name: string } | null>(null)
	const [slashOpen, setSlashOpen] = useState(false)
	const [slashQuery, setSlashQuery] = useState("")
	const [slashIndex, setSlashIndex] = useState(0)
	const [contextOpen, setContextOpen] = useState(false)

	const modelGroups = useMemo(() => {
		const groups: { provider: string; providerName: string; models: string[] }[] = []
		for (const option of env.chatModels) {
			let group = groups.find((item) => item.provider === option.provider)
			if (!group) {
				group = { provider: option.provider, providerName: option.providerName || option.provider, models: [] }
				groups.push(group)
			}
			if (!group.models.includes(option.value)) group.models.push(option.value)
		}
		const hasCurrent = env.chatModels.some(
			(option) => option.provider === env.chatProvider && option.value === env.chatModel,
		)
		if (env.chatModel && !hasCurrent) {
			groups.unshift({ provider: env.chatProvider, providerName: env.chatProvider || "当前", models: [env.chatModel] })
		}
		return groups
	}, [env.chatModels, env.chatModel, env.chatProvider])

	useEffect(() => {
		store.registerComposer((value: string) => {
			const node = textareaRef.current
			if (node) {
				node.value = value
				node.style.height = "auto"
				if (value) node.focus()
			}
			setText(value)
		})
		return () => store.registerComposer(null)
	}, [store])

	useEffect(() => {
		let alive = true
		void restoreFolder()
			.then((info) => {
				if (alive && info) store.addFolderRef(info.name, info.count)
			})
			.catch(() => {})
		return () => {
			alive = false
		}
	}, [store])

	useEffect(() => {
		return () => {
			try { store.exitPickMode() } catch {}
		}
	}, [store])

	useEffect(() => {
		if (!pendingText) return
		const node = textareaRef.current
		if (!node) return
		node.value = pendingText.text
		node.focus()
		node.setSelectionRange(node.value.length, node.value.length)
		setText(pendingText.text)
	}, [pendingText])

	const clearInput = () => {
		if (textareaRef.current) textareaRef.current.value = ""
		controller.textInput.clear()
	}

	const promptFilesToFiles = async (files: { url: string; filename?: string; mediaType?: string }[]) => {
		const result: File[] = []
		for (let index = 0; index < files.length; index += 1) {
			const part = files[index]
			try {
				const response = await fetch(part.url)
				const blob = await response.blob()
				result.push(new File([blob], part.filename || "附件" + (index + 1), { type: part.mediaType || blob.type }))
			} catch {
				/* 单个文件失败时继续处理其余附件 */
			}
		}
		return result
	}

	const handlePromptSubmit = async (message: { text: string; files: { url: string; filename?: string; mediaType?: string }[] }) => {
		const value = String(message.text || "").trim()
		if (env.running) {
			if (value) store.enqueue(value)
			return
		}
		if (message.files.length > 0) {
			const files = await promptFilesToFiles(message.files)
			let added = 0
			if (files.length) {
				try {
					const form = new FormData()
					files.forEach((file, index) => form.append("files", file, file.name || "附件" + (index + 1)))
					const response = await fetch("/api/upload", { method: "POST", body: form })
					const data = await response.json().catch(() => ({}))
					if (response.ok && Array.isArray(data.files) && data.files.length) {
						added = store.addFolderFiles(
							data.files.map((item: { name?: string; url?: string; kind?: string }) => ({
								name: String(item.name || "附件"),
								url: String(item.url || ""),
								kind: String(item.kind || "image"),
							})),
						)
					}
				} catch {
					/* 上传服务不可用时退回本地 data URL，仍可发送引用 */
				}
			}
			if (!added) {
				added = store.addFolderFiles(
					message.files.map((file) => ({
						name: file.filename || "附件",
						url: file.url,
						kind: (file.mediaType || "").startsWith("video") ? "video" : "image",
					})),
				)
				if (!added) {
					store.notify("附件读取失败，请重试")
					throw new Error("upload failed")
				}
				store.notify("附件上传服务不可用，已按本地附件发送")
			}
		}
		if (value) store.send(value)
	}

	const voiceInput = () => {
		const Speech = (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
		const Recognition = Speech.SpeechRecognition || Speech.webkitSpeechRecognition
		if (!Recognition) {
			store.notify("当前浏览器不支持语音输入")
			return
		}
		try {
			const recognition = new Recognition() as {
				lang: string
				onresult: (event: { results: { 0: { 0: { transcript: string } } } }) => void
				onerror: () => void
				start: () => void
			}
			recognition.lang = "zh-CN"
			recognition.onresult = (event) => {
				const transcript = event.results?.[0]?.[0]?.transcript || ""
				const node = textareaRef.current
				if (!node) return
				node.value = (node.value || "") + transcript
				setText(node.value)
			}
			recognition.onerror = () => store.notify("语音输入失败，请重试")
			recognition.start()
		} catch {
			store.notify("语音输入启动失败")
		}
	}

	const captureView = () => {
		setPlusOpen(false)
		setShotOpen(true)
	}

	const insertBrainstorm = () => {
		const prompt = "把下面这个想法展开成 3 个差异明显的方向，每个方向给标题+一句话说明：\n"
		const field = textareaRef.current
		const value = field ? field.value : text
		const next = value.trim() ? value.replace(/\s*$/, "") + "\n\n" + prompt : prompt
		if (field) {
			field.value = next
			field.focus()
			field.setSelectionRange(next.length, next.length)
		}
		setText(next)
		setPlusOpen(false)
		store.notify("已插入头脑风暴提示词")
	}

	const openFolderFiles = async () => {
		try {
			const files = await listFolderFiles(20)
			if (!files.length) {
				store.notify("文件夹里没有可加入的文件")
				return
			}
			const added = store.addFolderFiles(files.map((file) => ({ name: file.name, url: file.url, kind: file.kind })))
			store.notify(added ? "已从文件夹加入 " + added + " 个文件" : "没有加入新文件")
		} catch (error) {
			store.notify((error as Error)?.message || "读取文件夹失败")
		}
	}

	const togglePickMode = () => {
		try {
			const panel = document.getElementById("canvasAssistantPanel")
			document.documentElement.style.setProperty("--nvca-panel-width", (panel ? panel.getBoundingClientRect().width : 440) + "px")
		} catch {}
		if (pickMode) {
			store.exitPickMode()
			setPickMode(false)
			store.notify("已退出从画布添加")
		} else {
			store.enterPickMode()
			setPickMode(true)
			store.notify("从画布添加：点击节点加入引用")
		}
	}

	const contextLabel = (() => {
		const usage = env.contextUsage
		if (!usage) return "0%"
		if (typeof usage.percentage === "number") return Math.round(usage.percentage) + "%"
		if (typeof usage.used_tokens === "number") return formatTokens(usage.used_tokens)
		return "0%"
	})()

	const slashCommands = slashOpen
		? SLASH_COMMANDS.filter((command) => !slashQuery || command.name.includes(slashQuery.toLowerCase()))
		: []

	const stripSlashCommand = (value: string) => value.replace(/\/[^\s/]*$/, "").trimEnd()

	const runSlashCommand = (command: SlashCommand) => {
		const field = textareaRef.current
		const current = field ? field.value : text
		const next = stripSlashCommand(current)
		if (field) {
			field.value = next
			field.focus()
			field.setSelectionRange(next.length, next.length)
		}
		setText(next)
		setSlashOpen(false)
		setSlashQuery("")
		setMentionOpen(false)
		switch (command.action) {
			case "new": {
				const btn = document.getElementById("canvasAssistantNewChatBtn")
				if (btn) btn.click()
				else store.clearHistory()
				store.notify("已新建对话")
				break
			}
			case "plan":
				store.setPlanConfirm(true)
				store.notify("已切换到手动确认")
				break
			case "auto":
				store.setPlanConfirm(false)
				store.notify("已切换到自动执行")
				break
			case "attach":
				promptAttachments.openFileDialog()
				store.notify("已打开文件选择")
				break
			case "artifacts":
				window.dispatchEvent(new CustomEvent("novai-canvas-assistant:artifacts"))
				store.notify("已打开产物面板")
				break
			case "context":
				setContextOpen(true)
				store.notify("已打开上下文")
				break
			case "clear":
				if (field) field.value = ""
				setText("")
				store.notify("已清空输入框")
				break
		}
	}

	const refCount = env.refs.length
	const isUpload = (ref: { id: string; type?: string }) => ref.type === "upload" || /^upload_/.test(ref.id)
	const attachments = env.refs.filter(isUpload)
	const nodeRefs = env.refs.filter((ref) => !isUpload(ref))

	return (
		<div className="nvca-tap-composer">
			{env.queue.length > 0 ? (
				<div className="nvca-queue">
					<div className="nvca-queue-head">
						<span className="nvca-queue-title">消息队列</span>
						<span className="nvca-queue-count">{env.queue.length}/5</span>
					</div>
					<div className="nvca-queue-list">
						{env.queue.map((item, index) => (
							<div className="nvca-queue-item" key={item.id}>
								<span className="nvca-queue-index">{index + 1}</span>
								<span className="nvca-queue-text">{item.text}</span>
								<div className="nvca-queue-actions">
									<button
										aria-label="编辑排队消息"
										onClick={() => {
											store.removeQueued(item.id)
											store.fillComposer(item.text)
										}}
										title="编辑"
										type="button"
									>
										<PencilIcon className="nvca-i-xs" />
									</button>
									<button
										aria-label="移除排队消息"
										onClick={() => store.removeQueued(item.id)}
										title="移除"
										type="button"
									>
										<XIcon className="nvca-i-xs" />
									</button>
									<button
										aria-label="立即发送"
										className="is-send"
										onClick={() => store.sendQueuedNow(item.id)}
										title="立即发送"
										type="button"
									>
										<SendHorizontalIcon className="nvca-i-xs" />
									</button>
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}

			{attachments.length > 0 ? (
				<div className="nvca-attach-row">
					{attachments.map((ref) => (
						<div className="nvca-attachment" key={ref.id}>
							<button
								className="nvca-attachment-preview"
								onClick={() => setAttachmentPreview({ url: ref.thumbUrl || "", name: ref.name })}
								title={"预览 " + ref.name}
								type="button"
							>
								{ref.kind === "video" || !ref.thumbUrl ? (
									<span className="nvca-attachment-file">{ref.name.slice(0, 1).toUpperCase()}</span>
								) : (
									<img alt={ref.name} src={ref.thumbUrl} />
								)}
							</button>
							<span className="nvca-attachment-name">{ref.name}</span>
							<button
								aria-label={"移除附件 " + ref.name}
								className="nvca-attachment-remove"
								onClick={() => store.removeRef(ref.id)}
								title="移除"
								type="button"
							>
								<XIcon className="nvca-i-xs" />
							</button>
						</div>
					))}
				</div>
			) : null}

			<ScreenshotPicker onClose={() => setShotOpen(false)} open={shotOpen} store={store} />
			<PlusMenu
				anchor={addButtonRef.current}
				onBrainstorm={insertBrainstorm}
				onClose={() => setPlusOpen(false)}
				onPickCanvas={() => {
					setPlusOpen(false)
					store.enterPickMode()
					setPickMode(true)
					store.notify("从画布添加：点击节点加入引用")
				}}
				onUpload={() => {
					setPlusOpen(false)
					promptAttachments.openFileDialog()
				}}
				open={plusOpen}
				store={store}
			/>
			{pickMode
				? createPortal(
						<div className="nvca-pick-bar" role="status" aria-live="polite">
							<div className="nvca-pick-copy">
								<strong>从画布添加</strong>
								<span>点击或框选节点，也可拖到输入框</span>
							</div>
							<button className="nvca-pick-upload" onClick={() => promptAttachments.openFileDialog()} type="button">
								<ImageUpIcon className="nvca-i-xs" />
								上传素材
							</button>
							<button className="nvca-pick-exit" onClick={togglePickMode} type="button">
								退出
							</button>
						</div>,
						document.body,
					)
				: null}
			<div className="nvca-tap-composer-hint">
				<button className="nvca-tap-hint-btn" onClick={() => setPlusOpen((value) => !value)} type="button">
					{pickMode ? "正在从画布添加…" : "添加画布内容"}
				</button>
			</div>


			{slashOpen ? (
				<div className="nvca-slash" role="listbox" aria-label="斜杠命令">
					<div className="nvca-tap-menu-label">斜杠命令</div>
					{slashCommands.length === 0 ? <div className="nvca-tap-menu-empty">没有匹配的命令</div> : null}
					{slashCommands.map((command, index) => (
						<button
							aria-selected={index === slashIndex}
							className={cn("nvca-slash-item", index === slashIndex && "is-active")}
							key={command.name}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => runSlashCommand(command)}
							role="option"
							type="button"
						>
							<span className="nvca-slash-name">/{command.name}</span>
							<span className="nvca-slash-desc">{command.description}</span>
						</button>
					))}
				</div>
			) : null}

			{mentionOpen ? (
				<div className="nvca-tap-mention" role="listbox" aria-label="画布内容">
					<div className="nvca-tap-menu-label">画布内容</div>
					{mentionLoading ? <div className="nvca-tap-menu-empty">正在读取画布…</div> : null}
					{!mentionLoading && mentionNodes.length === 0 ? <div className="nvca-tap-menu-empty">画布上还没有节点</div> : null}
					{mentionNodes.map((node) => (
						<button
							className="nvca-tap-menu-item"
							key={node.id}
							onClick={() => {
								const field = textareaRef.current
								const value = field ? field.value : text
								const next = value.replace(/@([^\s@]*)$/, "@" + node.title + " ")
								if (field) {
									field.value = next
									field.focus()
									field.setSelectionRange(next.length, next.length)
								}
								setText(next)
								setMentionOpen(false)
							}}
							type="button"
						>
							<FolderClosedIcon className="nvca-i-sm" />
							<span className="nvca-tap-menu-text">{node.title}</span>
							<span className="nvca-tap-mention-type">{node.type.replace(/^smart-/, "")}</span>
						</button>
					))}
				</div>
			) : null}

			<PromptInput
				className="nvca-prompt-form"
				multiple
				onSubmit={handlePromptSubmit}
			>
				<PromptInputHeader className="nvca-prompt-header">
					{promptAttachments.files.length > 0 ? (
						<Attachments className="nvca-prompt-attachments" variant="inline">
							{promptAttachments.files.map((file) => (
								<Attachment data={file} key={file.id} onRemove={() => promptAttachments.remove(file.id)}>
									<AttachmentPreview />
									<AttachmentInfo />
									<AttachmentRemove label="移除附件" />
								</Attachment>
							))}
						</Attachments>
					) : null}
			{nodeRefs.length > 0 ? (
				<div className="nvca-tap-chips">
					{nodeRefs.map((ref) => (
						<span
							className={"nvca-tap-chip" + (ref.type === "folder" ? " is-folder" : ref.type === "skill" ? " is-skill" : ref.type === "app" ? " is-app" : "")}
							key={ref.id}
							onClick={() => {
								if (ref.type === "folder") void openFolderFiles()
							}}
							title={ref.type === "folder" ? "点击列出文件夹内的文件" : ref.name}
						>
							{ref.thumbUrl ? (
								<img alt="" className="nvca-tap-chip-thumb" src={ref.thumbUrl} />
							) : ref.type === "skill" ? (
								<PuzzleIcon className="nvca-i-xs" />
							) : ref.type === "app" ? (
								<LayoutGridIcon className="nvca-i-xs" />
							) : (
								<FolderClosedIcon className="nvca-i-xs" />
							)}
							<span className="nvca-tap-chip-name">{ref.name}</span>
							<button
								aria-label={"移除引用 " + ref.name}
								onClick={(event) => {
									event.stopPropagation()
									store.removeRef(ref.id)
								}}
								type="button"
							>
								<XIcon className="nvca-i-xs" />
							</button>
						</span>
					))}
				</div>
			) : null}
				</PromptInputHeader>
				<div className="nvca-drop-hint">松手将节点加入引用</div>
				<PromptInputBody>
					<PromptInputTextarea
					aria-label="随心输入"
					className="nvca-prompt-textarea"
					onChange={(event) => {
						const value = event.currentTarget.value
						setText(value)
						const slash = /(?:^|\s)\/([^\s/]*)$/.exec(value)
						if (slash) {
							setSlashOpen(true)
							setSlashQuery(slash[1] || "")
							setSlashIndex(0)
							setMentionOpen(false)
						} else {
							setSlashOpen(false)
						}
						if (/@([^\s@]*)$/.test(value)) {
							if (slash) setSlashOpen(false)
							setMentionOpen(true)
							setMentionLoading(true)
							void fetchCanvasNodes()
								.then((nodes) => setMentionNodes(nodes))
								.catch(() => setMentionNodes([]))
								.finally(() => setMentionLoading(false))
						} else {
							setMentionOpen(false)
						}
					}}
					onKeyDown={(event) => {
						if (slashOpen) {
							if (event.key === "ArrowDown") {
								event.preventDefault()
								setSlashIndex((index) => (index + 1) % Math.max(1, slashCommands.length))
								return
							}
							if (event.key === "ArrowUp") {
								event.preventDefault()
								setSlashIndex((index) => (index - 1 + Math.max(1, slashCommands.length)) % Math.max(1, slashCommands.length))
								return
							}
							if (event.key === "Escape") {
								event.preventDefault()
								setSlashOpen(false)
								return
							}
							if ((event.key === "Enter" || event.key === "Tab") && slashCommands.length > 0) {
								event.preventDefault()
								runSlashCommand(slashCommands[Math.min(slashIndex, slashCommands.length - 1)])
								return
							}
						}
						if (event.key === "Escape") {
							setMentionOpen(false)
							return
						}
					}}
					placeholder="随心输入"
					ref={textareaRef}
					rows={1}
				/>
				</PromptInputBody>
				<PromptInputFooter className="nvca-prompt-footer">
				<div className="nvca-tap-toolbar">
					<div className="nvca-tap-tools-left">
						<PromptInputButton
							aria-expanded={plusOpen}
							aria-haspopup="menu"
							className={cn("nvca-tap-icon is-add", (plusOpen || pickMode) && "is-on")}
							onClick={() => setPlusOpen((value) => !value)}
							ref={addButtonRef}
							tooltip="添加内容"
						>
							<PlusIcon className="nvca-i-sm" />
						</PromptInputButton>
						<button
							aria-label={"已选目录，当前 " + refCount + " 项"}
							className="nvca-tap-catalog"
							onClick={() => store.notify(refCount ? "已选 " + refCount + " 项引用" : "还没有引用，点＋从画布添加")}
							title={"已选目录（" + refCount + "）"}
							type="button"
						>
							<ShieldIcon className="nvca-i-sm" />
						</button>
						<button className="nvca-tap-icon is-upload" onClick={() => promptAttachments.openFileDialog()} title="上传素材" type="button">
							<ImageUpIcon className="nvca-i-sm" />
						</button>
						<button
							aria-pressed={env.planConfirm}
							className={cn("nvca-tap-manual", env.planConfirm && "is-on")}
							onClick={() => store.setPlanConfirm(!env.planConfirm)}
							title={env.planConfirm ? "手动生成：每轮先出方案" : "自动：只读步骤直接执行"}
							type="button"
						>
							<HandIcon className="nvca-i-sm" />
						</button>
						<button className="nvca-tap-icon is-shot" onClick={captureView} title="截图" type="button">
							<ScissorsIcon className="nvca-i-sm" />
						</button>
						<button className="nvca-tap-icon is-record" onClick={() => store.notify("截图与录屏接入中")} title="截图与录屏" type="button">
							<ChevronUpIcon className="nvca-i-sm" />
						</button>
					</div>
					<div className="nvca-tap-tools-right">
						<button
							aria-expanded={contextOpen}
							className="nvca-tap-context"
							onClick={() => setContextOpen((open) => !open)}
							title="上下文占用"
							type="button"
						>
							<CircleIcon className="nvca-i-sm" />
							<span className="nvca-sr-only">上下文占用 {contextLabel}</span>
						</button>
						{contextOpen ? (
							<div className="nvca-tap-menu is-context">
								<div className="nvca-tap-menu-label">上下文占用</div>
								<div className="nvca-tap-context-row">
									<span>已用</span>
									<span className="nvca-mono">
										{env.contextUsage && typeof env.contextUsage.used_tokens === "number"
											? formatTokens(env.contextUsage.used_tokens)
											: "—"}
									</span>
								</div>
								<div className="nvca-tap-context-row">
									<span>上限</span>
									<span className="nvca-mono">
										{env.contextUsage && typeof env.contextUsage.max_tokens === "number"
											? formatTokens(env.contextUsage.max_tokens)
											: "未设置"}
									</span>
								</div>
								<div className="nvca-tap-context-row">
									<span>本轮引用节点</span>
									<span className="nvca-mono">{refCount}</span>
								</div>
							</div>
						) : null}
						<button
							aria-expanded={modelOpen}
							aria-label="Auto：模型 / 生图平台"
							className="nvca-tap-auto"
							onClick={() => setModelOpen((open) => !open)}
							title="Auto（模型 / 生图平台）"
							type="button"
						>
							<SparklesIcon className="nvca-i-sm" />
						</button>
						{modelOpen ? (
							<div className="nvca-tap-menu is-model">
								<div className="nvca-tap-menu-label">对话模型</div>
								<div className="nvca-tap-model-list">
									{modelGroups.length === 0 ? <div className="nvca-tap-menu-empty">没有可用模型</div> : null}
									{modelGroups.map((group) => (
										<div key={group.provider || group.providerName}>
											<div className="nvca-tap-model-group">{group.providerName}</div>
											{group.models.map((model) => (
												<button
													className={cn(
														"nvca-tap-menu-item",
														env.chatModel === model && env.chatProvider === group.provider && "is-on",
													)}
													key={group.provider + ":" + model}
													onClick={() => {
														store.setChatModel(model, group.provider)
														setModelOpen(false)
													}}
													type="button"
												>
													<span className="nvca-tap-menu-text">{model}</span>
													{env.chatModel === model && env.chatProvider === group.provider ? (
														<CheckIcon className="nvca-i-xs" />
													) : null}
												</button>
											))}
										</div>
									))}
								</div>
								{env.imageProviders.length > 0 ? (
									<>
										<div className="nvca-tap-menu-label">生图平台</div>
										<button
											className={cn("nvca-tap-menu-item", !env.imageProvider && "is-on")}
											onClick={() => {
												store.setImageProvider("")
												setModelOpen(false)
											}}
											type="button"
										>
											<span className="nvca-tap-menu-text">自动（跟随模型）</span>
											{!env.imageProvider ? <CheckIcon className="nvca-i-xs" /> : null}
										</button>
										{env.imageProviders.map((provider) => (
											<button
												className={cn("nvca-tap-menu-item", env.imageProvider === provider.value && "is-on")}
												key={provider.value}
												onClick={() => {
													store.setImageProvider(provider.value)
													setModelOpen(false)
												}}
												type="button"
											>
												<span className="nvca-tap-menu-text">{provider.label}</span>
												{env.imageProvider === provider.value ? <CheckIcon className="nvca-i-xs" /> : null}
											</button>
										))}
									</>
								) : null}
							</div>
						) : null}
						<button className="nvca-tap-icon is-voice" onClick={voiceInput} title="语音输入" type="button">
							<MicIcon className="nvca-i-sm" />
						</button>
						<PromptInputSubmit
							aria-label={env.running ? "停止" : "发送"}
							className={cn("nvca-tap-send", env.running && "is-running")}
							disabled={!env.running && !text.trim()}
							onStop={() => store.abort()}
							status={env.running ? "streaming" : "ready"}
						>
							{env.running ? <SquareIcon className="nvca-i-sm" /> : <ArrowUpIcon className="nvca-i-sm" />}
						</PromptInputSubmit>
					</div>
				</div>
				</PromptInputFooter>
			</PromptInput>
			{attachmentPreview ? (
				<div className="nvca-attach-lightbox" onClick={() => setAttachmentPreview(null)} role="presentation">
					<div className="nvca-attach-lightbox-box" onClick={(event) => event.stopPropagation()}>
						{attachmentPreview.url ? <img alt={attachmentPreview.name} src={attachmentPreview.url} /> : <div className="nvca-attach-lightbox-fallback">无法预览</div>}
						<div className="nvca-attach-lightbox-actions">
							<span>{attachmentPreview.name}</span>
							{attachmentPreview.url ? <a download={attachmentPreview.name} href={attachmentPreview.url}>下载</a> : null}
							<button onClick={() => setAttachmentPreview(null)} type="button">关闭</button>
						</div>
					</div>
				</div>
			) : null}
			{env.notice ? <div className="nvca-tap-notice">{env.notice}</div> : null}
		</div>
	)
}

export const Composer = (props: ComposerProps) => (
	<PromptInputProvider>
		<ComposerInner {...props} />
	</PromptInputProvider>
)
