
import { Markdown } from "@/components/ai-elements/markdown"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Bubble, BubbleContent, BubbleGroup } from "@/components/hexta/bubble"
import { Marker, MarkerContent, MarkerTime } from "@/components/hexta/marker"
import { Message, MessageContent } from "@/components/hexta/message"
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
	useMessageScroller,
} from "@/components/hexta/message-scroller"
import { cn } from "@/lib/utils"
import {
	AlertTriangleIcon,
	BrainIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	FileTextIcon,
	ImageIcon,
	InfoIcon,
	LayoutGridIcon,
	ListChecksIcon,
	PencilIcon,
	PlayIcon,
	RefreshCwIcon,
	SearchIcon,
	SparklesIcon,
	SplitIcon,
	ThumbsDownIcon,
	ThumbsUpIcon,
	WorkflowIcon,
	XIcon,
} from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { BeatAvatar } from "./beat/BeatAvatar"
import { Composer } from "./Composer"
import { ThreadBar } from "./ThreadBar"
import { deriveRun, formatWorkMs, liveToolLabel, messageNodeRefs, runSummary, statusLabel, toolLabel } from "./format"
import { CheckpointCard } from "./CheckpointCard"
import { QuestionCard } from "./QuestionCard"
import { ReferenceImagesCard } from "./ReferenceImagesCard"
import { referenceCardFromPart } from "./reference"
import { SourcesCard } from "./SourcesCard"
import { ToolCard } from "./ToolCard"
import { ToolIcon } from "./icons"
import type { AssistantStore } from "./store"
import type { ArtifactItem, Message as AssistantMessage } from "./types"
import { useBeatActivity, type BeatActivity } from "./useBeatActivity"

const formatClock = (timestamp: number) => {
	const date = new Date(timestamp || Date.now())
	const pad = (value: number) => String(value).padStart(2, "0")
	return pad(date.getHours()) + ":" + pad(date.getMinutes())
}

const startOfDay = (timestamp: number) => {
	const date = new Date(timestamp || Date.now())
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const TOAST_HOLD_MS = 4000

const SUGGESTION_SETS = [
	[
		{ icon: "grid", title: "帮我建立这个项目的创作记忆", desc: "记录项目主题、风格、关系和禁区。" },
		{ icon: "memory", title: "帮我记住我的创作风格", desc: "总结画面偏好、叙事习惯和审美边界。" },
	],
	[
		{ icon: "workflow", title: "搭建可视化创作工作台", desc: "把世界观、人物和故事结构可视化。" },
		{ icon: "search", title: "为这个项目搜索历史考据", desc: "核查时代、地域、服饰和社会背景等创作细节。" },
	],
]

interface AssistantAppProps {
	store: AssistantStore
}

/* 会话流拍平成一行一条：message-scroller 的 Item 才是滚动锚点与未读计数的单位，
   日期分隔单独占一行（Marker），消息行带 messageId 供「回到最新 · N 条未读」计数。 */
interface ThreadRow {
	key: string
	messageId?: string
	role?: "user" | "assistant" | "system"
	day?: number
	message?: AssistantMessage
	index?: number
	mergedTop?: boolean
	mergedBottom?: boolean
}

const buildThreadRows = (messages: AssistantMessage[]): ThreadRow[] => {
	const rows: ThreadRow[] = []
	let lastDay = -1
	let prevBubble: ThreadRow | null = null
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]
		const day = startOfDay(message.createdAt)
		if (day !== lastDay) {
			rows.push({ key: "day-" + day + "-" + index, day })
			lastDay = day
		}
		const isBubble = message.role === "user" || message.role === "assistant"
		const mergedTop = isBubble && prevBubble !== null && prevBubble.role === message.role
		if (mergedTop && prevBubble) prevBubble.mergedBottom = true
		const row: ThreadRow = {
			key: message.id,
			messageId: message.id,
			role: message.role,
			message,
			index,
			mergedTop,
			mergedBottom: false,
		}
		rows.push(row)
		prevBubble = isBubble ? row : null
	}
	return rows
}

export const AssistantApp = ({ store }: AssistantAppProps) => {
	useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.getVersion(),
		() => store.getVersion(),
	)
	const { state, env } = store
	const activity = useBeatActivity(store)
	const [pendingText, setPendingText] = useState<{ text: string; token: number } | null>(null)
	const [lightbox, setLightbox] = useState<ArtifactItem | null>(null)
	const [toastText, setToastText] = useState("")
	const toastTimer = useRef(0)
	const lastNotice = useRef("")
	const tokenRef = useRef(0)

	const messages = state.messages
	// state.messages 是原地 push 的数组（引用不变），所以不能 useMemo，否则永远停在首帧的空列表上
	let lastAssistantIndex = -1
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role === "assistant") {
			lastAssistantIndex = i
			break
		}
	}
	const rows = buildThreadRows(messages)
	const hasUserMessage = messages.some((message) => message.role === "user")

	/* store.notify 只覆盖、没有清空点，所以通知做成「本地挂 4s 后收起」的浮层：
	   内容仍然是被覆盖才换，避免浮层常驻挡住对话。 */
	useEffect(() => {
		const text = env.notice
		if (!text || text === lastNotice.current) return
		lastNotice.current = text
		setToastText(text)
		if (toastTimer.current) window.clearTimeout(toastTimer.current)
		toastTimer.current = window.setTimeout(() => setToastText(""), TOAST_HOLD_MS)
	}, [env.notice])
	useEffect(() => () => {
		if (toastTimer.current) window.clearTimeout(toastTimer.current)
	}, [])

	const pickExample = (text: string) => {
		tokenRef.current += 1
		setPendingText({ text, token: tokenRef.current })
	}

	return (
		<div className="nvca-root nvca-tap">
			<div
				aria-orientation="vertical"
				className="nvca-tap-resize"
				onMouseDown={(event) => {
					event.preventDefault()
					event.stopPropagation()
				}}
				onPointerDown={(event) => {
					event.stopPropagation()
					const panel = document.getElementById("canvasAssistantPanel")
					if (!panel || panel.classList.contains("is-full")) return
					event.preventDefault()
					const startX = event.clientX
					const startWidth = panel.getBoundingClientRect().width
					const onMove = (moveEvent: PointerEvent) => {
						const width = Math.max(360, Math.min(window.innerWidth - 160, startWidth - (moveEvent.clientX - startX)))
						panel.style.width = width + "px"
						document.documentElement.style.setProperty("--nvca-panel-width", width + "px")
					}
					const onUp = () => {
						window.removeEventListener("pointermove", onMove)
						window.removeEventListener("pointerup", onUp)
						window.dispatchEvent(new Event("resize"))
					}
					window.addEventListener("pointermove", onMove)
					window.addEventListener("pointerup", onUp)
				}}
				role="separator"
			/>
			<ThreadBar activity={activity} store={store} />
			{messages.length === 0 ? (
				<div className="nvca-tap-empty-wrap">
					<EmptyState activity={activity} onPick={pickExample} />
				</div>
			) : (
				<MessageScrollerProvider autoScroll defaultScrollPosition="end">
					<MessageScroller className="nvca-thread-scroller">
						<MessageScrollerViewport aria-label="对话消息" className="nvca-thread-viewport">
							<MessageScrollerContent className="nvca-thread-content">
								{rows.map((row) => {
									if (row.day !== undefined) {
										return (
											<MessageScrollerItem animated={false} className="nvca-thread-item" key={row.key}>
												<Marker className="nvca-thread-day" sticky variant="separator">
													<MarkerContent>
														<MarkerTime date={row.day} locale="zh-CN" />
													</MarkerContent>
												</Marker>
											</MessageScrollerItem>
										)
									}
									const message = row.message
									if (!message) return null
									if (message.role === "system") {
										return (
											<MessageScrollerItem
												animated={false}
												className="nvca-thread-item"
												data-role="system"
												key={row.key}
												messageId={row.messageId}
											>
												<SystemNote message={message} store={store} />
											</MessageScrollerItem>
										)
									}
									if (message.role === "user") {
										return (
											<MessageScrollerItem
												className="nvca-thread-item"
												data-role="user"
												key={row.key}
												messageId={row.messageId}
												scrollAnchor
											>
												<UserBubble
													index={row.index || 0}
													mergedBottom={row.mergedBottom}
													mergedTop={row.mergedTop}
													message={message}
													store={store}
												/>
											</MessageScrollerItem>
										)
									}
									const isLast = row.index === lastAssistantIndex
									const streaming = env.running && (state.streamingMessageId === message.id || (isLast && !state.streamingMessageId))
									return (
										<MessageScrollerItem
											className="nvca-thread-item"
											data-role="assistant"
											key={row.key}
											messageId={row.messageId}
										>
											<RunTurn
												artifacts={isLast ? env.artifacts : []}
												index={row.index || 0}
												mergedBottom={row.mergedBottom}
												mergedTop={row.mergedTop}
												message={message}
												onOpenArtifact={setLightbox}
												store={store}
												streaming={streaming}
											/>
										</MessageScrollerItem>
									)
								})}
							</MessageScrollerContent>
						</MessageScrollerViewport>
						{hasUserMessage ? <QueryNavigator messages={messages} /> : null}
						<MessageScrollerButton
							className="nvca-thread-jump"
							unseenLabel={(count) => "回到最新 · " + count + " 条未读"}
						/>
					</MessageScroller>
				</MessageScrollerProvider>
			)}
			{toastText ? (
				<div aria-live="polite" className="nvca-thread-toast" role="status">
					<InfoIcon className="nvca-i-sm" />
					<span className="nvca-thread-toast-text">{toastText}</span>
					<button
						aria-label="关闭提示"
						className="nvca-thread-toast-x"
						onClick={() => {
							setToastText("")
							if (toastTimer.current) window.clearTimeout(toastTimer.current)
						}}
						type="button"
					>
						<XIcon className="nvca-i-xs" />
					</button>
				</div>
			) : null}
			<Composer store={store} pendingText={pendingText} />
			{lightbox ? <Lightbox item={lightbox} onClose={() => setLightbox(null)} /> : null}
		</div>
	)
}

const QueryNavigator = ({ messages }: { messages: AssistantMessage[] }) => {
	const { scrollToMessage } = useMessageScroller()
	const queries = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => message.role === "user")
	return (
		<nav aria-label="Conversation query locator" className="nvca-query-nav">
			{queries.map(({ message, index }, queryIndex) => {
				const text = message.parts.map((part) => part.type === "text" ? part.text : "").join("").trim()
				return (
					<button
						aria-label={"Jump to Query " + (queryIndex + 1) + ": " + text}
						key={message.id}
						onClick={() => {
							const moved = scrollToMessage(message.id, { align: "start", behavior: "smooth" })
							if (!moved) document.getElementById("nvca-query-" + index)?.scrollIntoView({ behavior: "smooth", block: "start" })
						}}
						title={"跳转到问题 " + (queryIndex + 1)}
						type="button"
					>
						{queryIndex + 1}
					</button>
				)
			})}
		</nav>
	)
}

const SUGGESTION_ICONS = {
	grid: LayoutGridIcon,
	memory: BrainIcon,
	workflow: WorkflowIcon,
	search: SearchIcon,
}

const EmptyState = ({ activity, onPick }: { activity: BeatActivity; onPick: (text: string) => void }) => {
	const [setIndex, setSetIndex] = useState(0)
	const [username, setUsername] = useState("")
	useEffect(() => {
		let alive = true
		fetch("/api/auth/me", { headers: { Accept: "application/json" } })
			.then((response) => (response.ok ? response.json() : null))
			.then((data) => {
				if (alive && data && data.username) setUsername(String(data.username))
			})
			.catch(() => {})
		return () => {
			alive = false
		}
	}, [])
	const suggestions = SUGGESTION_SETS[setIndex] || SUGGESTION_SETS[0]
	return (
		<div className="nvca-thread-empty">
			<div className="nvca-thread-empty-head">
				<span className="nvca-thread-empty-logo nvca-beat-logo-slot">
					<BeatAvatar size={28} state={activity.state} />
				</span>
				<span className="nvca-thread-empty-hi">Hi {username || "创作者"}!</span>
				<button
					aria-label="换一批"
					className="nvca-thread-empty-shuffle"
					onClick={() => setSetIndex((current) => (current === 0 ? 1 : 0))}
					title="换一批"
					type="button"
				>
					<RefreshCwIcon className="nvca-i-sm" />
				</button>
			</div>
			<div className="nvca-thread-empty-copy">
				<h2 className="nvca-thread-empty-title">今天一起创作点什么?</h2>
				<p className="nvca-thread-empty-sub">挑一张卡片开始，或者直接说你想画的画面。</p>
			</div>
			<div className="nvca-thread-empty-cards">
				{suggestions.map((item) => {
					const Icon = SUGGESTION_ICONS[item.icon as keyof typeof SUGGESTION_ICONS] || FileTextIcon
					return (
						<button
							className="nvca-thread-suggest"
							key={item.title}
							onClick={() => onPick(item.title + "\n" + item.desc)}
							type="button"
						>
							<span className="nvca-thread-suggest-icon">
								<Icon className="nvca-i-lg" />
							</span>
							<span className="nvca-thread-suggest-body">
								<span className="nvca-thread-suggest-title">{item.title}</span>
								<span className="nvca-thread-suggest-desc">{item.desc}</span>
							</span>
							<ChevronRightIcon className="nvca-thread-suggest-arrow" />
						</button>
					)
				})}
			</div>
		</div>
	)
}

const UserBubble = ({
	message,
	index,
	mergedTop,
	mergedBottom,
	store,
}: {
	message: AssistantMessage
	index: number
	mergedTop?: boolean
	mergedBottom?: boolean
	store: AssistantStore
}) => {
	const text = message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim()
	return (
		<Message align="end" className="nvca-thread-msg">
			<MessageContent>
				<Bubble
					align="end"
					className={cn(
						"nvca-thread-bubble nvca-thread-bubble-user",
						mergedTop && "is-merged-top",
						mergedBottom && "is-merged-bottom",
					)}
					variant="secondary"
				>
					<BubbleContent className="nvca-thread-bubble-body" id={"nvca-query-" + index}>
						<p className="nvca-user-text">{text}</p>
						<div className="nvca-user-head">
							<button
								aria-label="复制"
								className="nvca-user-icon"
								onClick={() => {
									if (navigator.clipboard) void navigator.clipboard.writeText(text)
								store.notify("已复制这条消息")
								}}
								title="复制"
								type="button"
							>
								<CopyIcon className="nvca-i-xs" />
							</button>
							<time className="nvca-user-time" dateTime={new Date(message.createdAt || Date.now()).toISOString()}>
								{formatClock(message.createdAt)}
							</time>
						</div>
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
	)
}

const SystemNote = ({ message, store }: { message: AssistantMessage; store: AssistantStore }) => {
	const text = message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim()
	if (!text) return null
	const lines = text.split("\n")
	const hasTitle = lines.length > 1
	const title = hasTitle ? lines[0].trim() : message.systemKind === "error" ? "出错了" : "提示"
	const body = hasTitle ? lines.slice(1).join("\n").trim() : text
	const Icon = message.systemKind === "error" || message.systemKind === "warn" ? AlertTriangleIcon : InfoIcon
	return (
		<div
			className={cn(
				"nvca-thread-system",
				message.systemKind === "warn" && "is-warn",
				message.systemKind === "error" && "is-error",
			)}
			role="status"
		>
			<Icon className="nvca-i-sm" />
			<div className="nvca-thread-system-main">
				<span className="nvca-thread-system-title">{title}</span>
				{body ? <p className="nvca-thread-system-body">{body}</p> : null}
			</div>
			<button className="nvca-thread-system-btn" onClick={() => store.removeMessage(message.id)} type="button">
				知道了
			</button>
		</div>
	)
}

const RunTurn = ({
	message,
	index,
	mergedTop,
	mergedBottom,
	streaming,
	store,
}: {
	message: AssistantMessage
	index: number
	mergedTop?: boolean
	mergedBottom?: boolean
	streaming: boolean
	artifacts: ArtifactItem[]
	onOpenArtifact: (item: ArtifactItem) => void
	store: AssistantStore
}) => {
	useTicker(streaming)
	const run = deriveRun(message)
	const texts = run.texts.map((item) => item.text)
	const { state } = store
	const status = message.status || (streaming ? state.streamState : "")
	const outcomeLabel = run.outcome ? statusLabel(run.outcome.status, "已结束") : ""
	const totalWork = run.outcome?.activeWorkMs || message.activeWorkMs || 0
	const hasSteps = run.steps.length > 0 || run.tools.length > 0
	const baseSummary = runSummary(run)
	const liveSummary = liveToolLabel(run)
	const summary = baseSummary
		? baseSummary + (baseSummary !== "编辑了画布" && totalWork > 0 ? " · " + formatWorkMs(totalWork) : "")
		: liveSummary
	const nodeRefs = messageNodeRefs(message)
	const confirmations = message.parts.filter((part) => part.type === "confirmation")
	/* 联网搜图 / 反图的参考图选择卡：step 事件里带 items 的，和反图直接推进来的 part，都在这里出卡 */
	const referenceCards = message.parts
		.map((part) => referenceCardFromPart(part))
		.filter((card): card is NonNullable<typeof card> => Boolean(card))
	const hasBody =
		hasSteps ||
		run.visions.length > 0 ||
		Boolean(run.thinking) ||
		Boolean(message.plan) ||
		confirmations.length > 0 ||
		referenceCards.length > 0
	const showRunHeader = streaming || (!hasBody && run.texts.length === 0)
	const reasoning = run.thinking ? (
		<Reasoning
			className="nvca-reasoning"
			duration={run.thinking.durationMs ? Math.max(1, Math.round(run.thinking.durationMs / 1000)) : undefined}
			defaultOpen={false}
			isStreaming={streaming && Boolean(run.thinking.text)}
		>
			<ReasoningTrigger
				className="nvca-reasoning-trigger"
				getThinkingMessage={(isStreaming, duration) =>
					isStreaming ? <Shimmer duration={1.6}>思考中…</Shimmer> : <span>{duration ? "已思考 " + duration + "s" : "思考"}</span>
				}
			/>
			<ReasoningContent className="nvca-reasoning-content">
				<Markdown>{run.thinking.text}</Markdown>
			</ReasoningContent>
		</Reasoning>
	) : null
	const inlineNodeRefs = nodeRefs.length > 0 ? (
		<span className="nvca-node-refs">
			{nodeRefs.map((ref) => (
				<button className="nvca-node-ref" key={ref.id} onClick={() => store.openNode(ref.id)} title={"定位到 " + ref.label} type="button">
					{ref.label === "Text" || ref.label.startsWith("文本") ? <FileTextIcon className="nvca-i-xs" /> : <ImageIcon className="nvca-i-xs" />}
					<span>{ref.label}</span>
				</button>
			))}
		</span>
	) : null

	return (
		<div className="nvca-thread-turn" data-streaming={streaming ? "true" : "false"}>
			{showRunHeader ? (
				<div className="nvca-run-head">
					<span className={cn("nvca-run-dot", streaming && "is-live", run.error && "is-fail", outcomeLabel && !streaming && "is-done")} />
					<span className="nvca-run-status">
						{streaming ? <Shimmer duration={1.6}>{liveSummary || statusLabel(state.streamState, "正在执行…")}</Shimmer> : outcomeLabel || statusLabel(status, "运行记录")}
					</span>
					<span className="nvca-run-spacer" />
					{!baseSummary && (streaming || totalWork > 0) ? <span className="nvca-run-time">处理了 {formatWorkMs(streaming ? currentWork(state) : totalWork)}</span> : null}
				</div>
			) : null}

			{hasBody ? (
				<div className="nvca-run-body">
					{!hasSteps && !summary ? reasoning : null}
					{hasSteps || summary ? <StepGroup parts={[...run.tools, ...run.steps]} streaming={streaming} summary={summary} thinking={reasoning} checkpoint={<CheckpointCard message={message} store={store} />} /> : null}
					{confirmations.map((part) => (
						<QuestionCard key={part.id} part={part} store={store} />
					))}

					{message.plan ? (
						<PlanCard
							plan={message.plan}
							planState={message.planState || ""}
							running={store.env.running}
							onAction={(action) => store.planAction(action)}
						/>
					) : null}

					{referenceCards.map((card) => (
						<ReferenceImagesCard card={card} key={card.id} store={store} />
					))}
				</div>
			) : null}

			{run.texts.length > 0 ? (
				<Message align="start" className="nvca-thread-msg">
					<MessageContent>
						<BubbleGroup className="nvca-thread-bubbles" shape="joined">
							{run.texts.map((text, textIndex) => (
								<Bubble
									align="start"
									className={cn(
										"nvca-thread-bubble nvca-thread-bubble-assistant",
										mergedTop && textIndex === 0 && "is-merged-top",
										mergedBottom && textIndex === run.texts.length - 1 && "is-merged-bottom",
									)}
									key={text.id}
									variant="muted"
								>
									<BubbleContent className="nvca-thread-bubble-body">
										<Markdown trailing={textIndex === run.texts.length - 1 ? inlineNodeRefs : null}>{text.text}</Markdown>
									</BubbleContent>
								</Bubble>
							))}
						</BubbleGroup>
					</MessageContent>
				</Message>
			) : null}

			{run.error ? (
				<div className="nvca-error">
					<ToolIcon className="nvca-i-sm" name="fail" />
					<span>{run.error.message}{run.error.code ? "（" + run.error.code + "）" : ""}</span>
				</div>
			) : null}

			{run.contextNodes > 0 || run.steers.length > 0 ? (
				<div className="nvca-run-meta">
					{run.contextNodes > 0 ? <span className="nvca-meta-chip">本轮引用 {run.contextNodes} 个节点</span> : null}
					{run.steers.map((steer) => (
						<span className="nvca-meta-chip is-steer" key={steer.id}>
							{steer.status === "unread" ? "未读到（已放回输入框）：" : "已插话："}
							{steer.text.slice(0, 20)}
							{steer.text.length > 20 ? "…" : ""}
						</span>
					))}
				</div>
			) : null}

			<SourcesCard message={message} />

			{texts.length > 0 ? (
				<div className="nvca-run-tools">
					<button
						aria-label="复制"
						className="nvca-link-btn"
						onClick={() => {
							const copyText = texts.join("\n\n")
							if (navigator.clipboard) void navigator.clipboard.writeText(copyText)
							store.notify("已复制这条回复")
						}}
						title="复制"
						type="button"
					>
						<CopyIcon className="nvca-i-xs" />
						<span className="nvca-sr-only">复制</span>
					</button>
					<button aria-label="好评" aria-pressed={message.rating === "up"} className={cn("nvca-link-btn", message.rating === "up" && "is-on")} onClick={() => void store.rateMessage(index, "up")} title="好评" type="button">
						<ThumbsUpIcon className="nvca-i-xs" />
						<span className="nvca-sr-only">好评</span>
					</button>
					<button aria-label="差评" aria-pressed={message.rating === "down"} className={cn("nvca-link-btn", message.rating === "down" && "is-on")} onClick={() => void store.rateMessage(index, "down")} title="差评" type="button">
						<ThumbsDownIcon className="nvca-i-xs" />
						<span className="nvca-sr-only">差评</span>
					</button>
					<button aria-label="分支对话" className="nvca-link-btn" onClick={() => void store.branchAt(index)} title="分支对话" type="button">
						<SplitIcon className="nvca-i-xs" />
						<span className="nvca-sr-only">分支对话</span>
					</button>
					<time className="nvca-assistant-time" dateTime={new Date(message.createdAt || Date.now()).toISOString()}>{formatClock(message.createdAt)}</time>
				</div>
			) : null}
		</div>
	)
}

const StepGroup = ({ parts, streaming, summary, thinking, checkpoint }: { parts: Extract<AssistantMessage["parts"][number], { type: "tool_event" }>[]; streaming: boolean; summary: string; thinking?: Parameters<typeof Reasoning>[0]["children"]; checkpoint?: Parameters<typeof Reasoning>[0]["children"] }) => {
	const [open, setOpen] = useState(streaming)
	const total = parts.length
	const finished = parts.filter((part) => part.status === "done" || part.status === "failed").length
	useEffect(() => setOpen(streaming), [streaming])
	return (
		<div className="nvca-step-group nvca-thread-card">
			<button
				aria-expanded={open}
				className="nvca-step-group-head"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				{summary === "编辑了画布" ? <PencilIcon className="nvca-i-sm" /> : <ListChecksIcon className="nvca-i-sm" />}
				<span className="nvca-step-group-title">{summary || "执行清单"}</span>
				{streaming && total > 0 ? <span className="nvca-step-group-progress">{finished}/{total}</span> : null}
				<span className="nvca-step-group-spacer" />
				<ChevronDownIcon className={cn("nvca-step-group-caret", open && "is-open")} />
			</button>
			{open ? (
				<div className="nvca-tool-list">
					{thinking}
					{parts.map((part) => (
						<ToolCard key={part.id} part={part} />
					))}
					{checkpoint}
				</div>
			) : null}
		</div>
	)
}

const PlanCard = ({
	plan,
	planState,
	running,
	onAction,
}: {
	plan: NonNullable<AssistantMessage["plan"]>
	planState: string
	running: boolean
	onAction: (action: "run" | "cancel" | "adjust") => void
}) => {
	const resolved = planState && planState !== "pending" && planState !== "running"
	const generations = Number(plan.impact?.generations) || 0
	const title = plan.intent || plan.summary || "按你说的改画布"
	return (
		<div className="nvca-plan nvca-thread-card" data-state={planState || "pending"}>
			{!resolved ? (
				<div className="nvca-plan-head">
					<span className="nvca-plan-kicker">
						<SparklesIcon className="nvca-i-sm" />
						方案
					</span>
					<span className="nvca-plan-state">{planState === "running" ? "执行中…" : "等你确认"}</span>
				</div>
			) : null}
			<div className="nvca-plan-title">{title}</div>
			<ol className="nvca-plan-steps">
				{plan.steps.map((step, index) => (
					<li className="nvca-plan-step" key={index}>
						<span className="nvca-plan-num">{index + 1}.</span>
						<div className="nvca-plan-step-main">
							<span className="nvca-plan-tool">{step.description || toolLabel(step.tool)}</span>
						</div>
					</li>
				))}
			</ol>
			{!resolved ? (
				<>
					<div className="nvca-plan-cost">
						{generations > 0 ? "会用掉 " + generations + " 次生成" : "不消耗生成额度"}
						{Number(plan.impact?.nodes) > 0 ? " · 新增 " + Number(plan.impact?.nodes) + " 个节点" : ""}
					</div>
					<div className="nvca-plan-actions">
						<button className="nvca-btn ghost" disabled={running} onClick={() => onAction("cancel")} type="button">取消</button>
						<button className="nvca-btn ghost" disabled={running} onClick={() => onAction("adjust")} type="button">换个说法</button>
						<button className="nvca-btn primary" disabled={running} onClick={() => onAction("run")} type="button">
							<PlayIcon className="nvca-i-sm" />
							{generations > 0 ? "开始生成" : "开始"}
						</button>
					</div>
				</>
			) : null}
		</div>
	)
}

const Lightbox = ({ item, onClose }: { item: ArtifactItem; onClose: () => void }) => {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [onClose])
	return (
		<div className="nvca-lightbox" onClick={onClose} role="dialog" aria-label="产物预览">
			<div className="nvca-lightbox-inner" onClick={(event) => event.stopPropagation()}>
				<button aria-label="关闭预览" className="nvca-lightbox-close" onClick={onClose} type="button">
					<XIcon className="nvca-i-sm" />
				</button>
				{item.kind === "video" ? <video controls autoPlay src={item.url} /> : <img alt={item.title || "产物"} src={item.url} />}
			</div>
		</div>
	)
}

const currentWork = (state: AssistantStore["state"]): number => {
	const activity = state.runActivity
	if (!activity) return 0
	if (activity.frozen) return Number(activity.frozenMs) || 0
	return (Number(activity.frozenMs) || 0) + Math.max(0, Date.now() - (Number(activity.startedAt) || Date.now()))
}

const useTicker = (active: boolean) => {
	const [, setTick] = useState(0)
	useEffect(() => {
		if (!active) return
		const timer = setInterval(() => setTick((value) => value + 1), 1000)
		return () => clearInterval(timer)
	}, [active])
}
