import {
	ArrowUpIcon,
	CheckIcon,
	ChevronUpIcon,
	CircleIcon,
	FolderClosedIcon,
	HandIcon,
	ImageUpIcon,
	MicIcon,
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

export const Composer = ({ store, pendingText }: ComposerProps) => {
	const { env } = store
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const [text, setText] = useState("")
	const [addOpen, setAddOpen] = useState(false)
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
		setText("")
	}

	const submit = () => {
		const value = String(textareaRef.current?.value ?? text ?? "").trim()
		if (!value) return
		if (env.running) {
			if (store.enqueue(value)) clearInput()
			return
		}
		store.send(value)
		clearInput()
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
		const exportBtn = document.getElementById("smartExportToggle")
		if (exportBtn) {
			exportBtn.click()
			return
		}
		store.notify("画布截图入口还没准备好")
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
				setAddOpen(true)
				store.notify("已打开添加菜单")
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

			<div className="nvca-tap-composer-hint">
				<button className="nvca-tap-hint-btn" onClick={() => setAddOpen((open) => !open)} type="button">
					添加画布内容
				</button>
			</div>
			{nodeRefs.length > 0 ? (
				<div className="nvca-tap-chips">
					{nodeRefs.map((ref) => (
						<span className="nvca-tap-chip" key={ref.id}>
							{ref.thumbUrl ? <img alt="" className="nvca-tap-chip-thumb" src={ref.thumbUrl} /> : <FolderClosedIcon className="nvca-i-xs" />}
							<span className="nvca-tap-chip-name">{ref.name}</span>
							<button aria-label={"移除引用 " + ref.name} onClick={() => store.removeRef(ref.id)} type="button">
								<XIcon className="nvca-i-xs" />
							</button>
						</span>
					))}
				</div>
			) : null}

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

			<form
				className="nvca-tap-box"
				onSubmit={(event) => {
					event.preventDefault()
					submit()
				}}
			>
				<textarea
					aria-label="随心输入"
					className="nvca-tap-input"
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
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault()
							submit()
						}
					}}
					placeholder="随心输入"
					ref={textareaRef}
					rows={1}
					value={text}
				/>
				<div className="nvca-tap-toolbar">
					<div className="nvca-tap-tools-left">
						<div className="nvca-tap-add-wrap">
							<button
								aria-expanded={addOpen}
								className="nvca-tap-icon is-add"
								onClick={() => setAddOpen((open) => !open)}
								title="添加画布节点 / 素材"
								type="button"
							>
								<PlusIcon className="nvca-i-sm" />
							</button>
							{addOpen ? (
								<div className="nvca-tap-menu is-add">
									<button
										className="nvca-tap-menu-item"
										onClick={() => {
											setAddOpen(false)
											store.addSelectedRefs()
										}}
										type="button"
									>
										<MousePointerSquareDashedIcon className="nvca-i-sm" />
										<span className="nvca-tap-menu-text">引用选中的画布节点</span>
									</button>
									<button
										className="nvca-tap-menu-item"
										onClick={() => {
											setAddOpen(false)
											store.pickUpload()
										}}
										type="button"
									>
										<ImageUpIcon className="nvca-i-sm" />
										<span className="nvca-tap-menu-text">上传素材（图片 / 视频）</span>
									</button>
								</div>
							) : null}
						</div>
						<button
							aria-label={"已选目录，当前 " + refCount + " 项"}
							className="nvca-tap-catalog"
							onClick={() => setAddOpen((open) => !open)}
							title={"已选目录（" + refCount + "）"}
							type="button"
						>
							<ShieldIcon className="nvca-i-sm" />
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
						<button
							aria-label={env.running ? "停止" : "发送"}
							className={cn("nvca-tap-send", env.running && "is-running")}
							disabled={!env.running && !text.trim()}
							onClick={() => {
								if (env.running) {
									store.abort()
									return
								}
								submit()
							}}
							type="button"
						>
							{env.running ? <SquareIcon className="nvca-i-sm" /> : <ArrowUpIcon className="nvca-i-sm" />}
						</button>
					</div>
				</div>
			</form>
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
