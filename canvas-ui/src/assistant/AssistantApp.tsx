import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Markdown } from "@/components/ai-elements/markdown"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	FileTextIcon,
	GitBranchIcon,
	GaugeIcon,
	ImageIcon,
	BrainIcon,
	LayoutGridIcon,
	ListChecksIcon,
	PencilIcon,
	PlayIcon,
	RefreshCwIcon,
	RefreshCcwIcon,
	SearchIcon,
	SparklesIcon,
	UserIcon,
	WorkflowIcon,
	XIcon,
} from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Composer } from "./Composer"
import { ModelContextDialog } from "./ModelContextDialog"
import { ThreadBar } from "./ThreadBar"
import { deriveRun, formatTokens, formatWorkMs, statusLabel, toolIconKey, toolLabel } from "./format"
import { CheckpointCard } from "./CheckpointCard"
import { QuestionCard } from "./QuestionCard"
import { SourcesCard } from "./SourcesCard"
import { ToolCard } from "./ToolCard"
import { ToolIcon } from "./icons"
import type { AssistantStore } from "./store"
import type { ArtifactItem, Message as AssistantMessage, SkillChip } from "./types"

const formatClock = (timestamp: number) => {
	const date = new Date(timestamp || Date.now())
	const pad = (value: number) => String(value).padStart(2, "0")
	return pad(date.getHours()) + ":" + pad(date.getMinutes())
}

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

export const AssistantApp = ({ store }: AssistantAppProps) => {
	useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.getVersion(),
		() => store.getVersion(),
	)
	const { state, env } = store
	const [pendingText, setPendingText] = useState<{ text: string; token: number } | null>(null)
	const [lightbox, setLightbox] = useState<ArtifactItem | null>(null)
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
			<ThreadBar store={store} />
			{messages.length === 0 ? (
				<div className="nvca-tap-empty-wrap">
					<EmptyState onPick={pickExample} />
				</div>
			) : (
				<Conversation className="nvca-conversation">
					<ConversationContent className="nvca-conversation-content">
						{messages.map((message, index) => {
							if (message.role === "user") return <UserBubble key={message.id} message={message} store={store} />
							if (message.role === "system") return <SystemNote key={message.id} message={message} store={store} />
							const isLast = index === lastAssistantIndex
							const streaming = env.running && (state.streamingMessageId === message.id || (isLast && !state.streamingMessageId))
							return (
								<RunTurn
									key={message.id}
									index={index}
									message={message}
									streaming={streaming}
									artifacts={isLast ? env.artifacts : []}
									onOpenArtifact={setLightbox}
									store={store}
								/>
							)
						})}
					</ConversationContent>
					<ConversationScrollButton className="nvca-scroll-btn" />
				</Conversation>
			)}
			<Composer store={store} pendingText={pendingText} />
			{lightbox ? <Lightbox item={lightbox} onClose={() => setLightbox(null)} /> : null}
		</div>
	)
}

const SUGGESTION_ICONS = {
	grid: LayoutGridIcon,
	memory: BrainIcon,
	workflow: WorkflowIcon,
	search: SearchIcon,
}

const EmptyState = ({ onPick }: { onPick: (text: string) => void }) => {
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
		<div className="nvca-tap-empty">
			<div className="nvca-tap-greeting">
				<img alt="" className="nvca-tap-greeting-logo" src="/static/images/logo.png" />
				<span>Hi {username || "创作者"}!</span>
			</div>
			<h2 className="nvca-tap-empty-title">今天一起创作点什么?</h2>
			<div className="nvca-tap-cards">
				{suggestions.map((item) => {
					const Icon = SUGGESTION_ICONS[item.icon as keyof typeof SUGGESTION_ICONS] || FileTextIcon
					return (
						<button
							className="nvca-tap-card"
							key={item.title}
							onClick={() => onPick(item.title + "\n" + item.desc)}
							type="button"
						>
							<Icon className="nvca-tap-card-icon" />
							<span className="nvca-tap-card-body">
								<span className="nvca-tap-card-title">{item.title}</span>
								<span className="nvca-tap-card-desc">{item.desc}</span>
							</span>
							<ChevronRightIcon className="nvca-tap-card-arrow" />
						</button>
					)
				})}
			</div>
			<button
				aria-label="换一批"
				className="nvca-tap-shuffle"
				onClick={() => setSetIndex((current) => (current === 0 ? 1 : 0))}
				title="换一批"
				type="button"
			>
				<RefreshCwIcon className="nvca-tap-shuffle-icon" />
			</button>
		</div>
	)
}

const UserBubble = ({ message, store }: { message: AssistantMessage; store: AssistantStore }) => {
	const text = message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim()
	return (
		<Message className="nvca-user-msg" from="user">
			<MessageContent className="nvca-user-bubble">
				<div className="nvca-user-head">
					<span className="nvca-user-avatar"><UserIcon className="nvca-i-xs" /></span>
					<span className="nvca-user-name">你</span>
					<span className="nvca-user-spacer" />
					<button
						aria-label="编辑这条消息"
						className="nvca-user-icon nvca-user-edit"
						onClick={() => store.fillComposer(text)}
						title="编辑"
						type="button"
					>
						<PencilIcon className="nvca-i-xs" />
					</button>
					<button
						aria-label="复制这条消息"
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
				<p className="nvca-user-text">{text}</p>
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
	return (
		<div
			className={cn(
				"nvca-system nvca-system-card",
				message.systemKind === "warn" && "is-warn",
				message.systemKind === "error" && "is-error",
			)}
			role="status"
		>
			<div className="nvca-system-title">{title}</div>
			{body ? <p className="nvca-system-body">{body}</p> : null}
			<div className="nvca-system-actions">
				<button className="nvca-system-btn" onClick={() => store.removeMessage(message.id)} type="button">
					知道了
				</button>
			</div>
		</div>
	)
}

const RunTurn = ({
	message,
	index,
	streaming,
	artifacts,
	onOpenArtifact,
	store,
}: {
	message: AssistantMessage
	index: number
	streaming: boolean
	artifacts: ArtifactItem[]
	onOpenArtifact: (item: ArtifactItem) => void
	store: AssistantStore
}) => {
	useTicker(streaming)
	const [contextOpen, setContextOpen] = useState(false)
	const run = deriveRun(message)
	const texts = run.texts.map((item) => item.text)
	const { state } = store
	const pending = state.pendingConfirmation as { kind?: string; tool?: string; description?: string; units?: number; reason?: string } | null
	const status = message.status || (streaming ? state.streamState : "")
	const outcomeLabel = run.outcome ? statusLabel(run.outcome.status, "已结束") : ""
	const totalWork = run.outcome?.activeWorkMs || message.activeWorkMs || 0
	const hasSteps = run.steps.length > 0 || run.tools.length > 0
	const confirmations = message.parts.filter((part) => part.type === "confirmation")
	const hasBody = hasSteps || Boolean(run.thinking) || Boolean(message.plan) || confirmations.length > 0

	return (
		<div className="nvca-turn" data-streaming={streaming ? "true" : "false"}>
			<div className="nvca-run-head">
				<span className={cn("nvca-run-dot", streaming && "is-live", run.error && "is-fail", outcomeLabel && !streaming && "is-done")} />
				<span className="nvca-run-status">
					{streaming ? <Shimmer duration={1.6}>{statusLabel(state.streamState, "正在执行…")}</Shimmer> : outcomeLabel || statusLabel(status, "运行记录")}
				</span>
				<span className="nvca-run-spacer" />
				{(streaming || totalWork > 0) && <span className="nvca-run-time">处理了 {formatWorkMs(streaming ? currentWork(state) : totalWork)}</span>}
			</div>

			{hasBody ? (
				<div className="nvca-run-body">
					{run.thinking ? (
						<Reasoning
							className="nvca-reasoning"
							duration={run.thinking.durationMs ? Math.max(1, Math.round(run.thinking.durationMs / 1000)) : undefined}
							defaultOpen={false}
							isStreaming={streaming && Boolean(run.thinking.text)}
						>
							<ReasoningTrigger
								className="nvca-reasoning-trigger"
								getThinkingMessage={(isStreaming, duration) =>
									isStreaming ? (
										<Shimmer duration={1.6}>思考中…</Shimmer>
									) : (
										<span>{duration ? "思考了 " + duration + " 秒" : "思考"}</span>
									)
								}
							/>
							<ReasoningContent className="nvca-reasoning-content">
								<Markdown>{run.thinking.text}</Markdown>
							</ReasoningContent>
						</Reasoning>
					) : null}

					{hasSteps ? <StepGroup parts={[...run.tools, ...run.steps]} /> : null}
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
				</div>
			) : null}

			{run.texts.length > 0 ? (
				<Message className="nvca-assistant-msg" from="assistant">
					<MessageContent className="nvca-assistant-bubble">
						{run.texts.map((text) => (
							<Markdown key={text.id}>{text.text}</Markdown>
						))}
					</MessageContent>
				</Message>
			) : null}

			{run.error ? (
				<div className="nvca-error">
					<ToolIcon className="nvca-i-sm" name="fail" />
					<span>{run.error.message}{run.error.code ? "（" + run.error.code + "）" : ""}</span>
				</div>
			) : null}

			{artifacts.length > 0 ? (
				<ArtifactGrid items={artifacts} onOpen={onOpenArtifact} />
			) : null}

			{run.contextNodes > 0 || run.usage || run.steers.length > 0 || run.outcome ? (
				<div className="nvca-run-meta">
					{run.contextNodes > 0 ? <span className="nvca-meta-chip">本轮引用 {run.contextNodes} 个节点</span> : null}
					{run.usage ? (
						<span className="nvca-meta-chip">
							用量 {typeof run.usage.input_tokens === "number" ? "输入 " + formatTokens(run.usage.input_tokens) : ""}
							{typeof run.usage.output_tokens === "number" ? " · 输出 " + formatTokens(run.usage.output_tokens) : ""}
						</span>
					) : null}
					{run.steers.map((steer) => (
						<span className="nvca-meta-chip is-steer" key={steer.id}>
							{steer.status === "unread" ? "未读到（已放回输入框）：" : "已插话："}
							{steer.text.slice(0, 20)}
							{steer.text.length > 20 ? "…" : ""}
						</span>
					))}
					{run.outcome ? (
						<span className="nvca-meta-chip">
							{outcomeLabel}
							{run.outcome.activeWorkMs > 0 ? " · 处理了 " + formatWorkMs(run.outcome.activeWorkMs) : ""}
						</span>
					) : null}
				</div>
			) : null}

			<SourcesCard message={message} />

			<CheckpointCard message={message} store={store} />

			{message.runId || texts.length > 0 ? (
				<div className="nvca-run-tools">
					{texts.length > 0 ? (
						<>
							<button
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
								复制
							</button>
							<button
								className="nvca-link-btn"
								onClick={() => {
									const lastUser = [...store.state.messages].reverse().find((item) => item.role === "user")
									const text = lastUser ? lastUser.parts.map((part) => (part.type === "text" ? part.text : "")).join("").trim() : ""
									if (text) store.send(text)
								}}
								title="重试"
								type="button"
							>
								<RefreshCcwIcon className="nvca-i-xs" />
								重试
							</button>
							<button
								className="nvca-link-btn"
								onClick={() => void store.branchAt(index)}
								title="从这里分支"
								type="button"
							>
								<GitBranchIcon className="nvca-i-xs" />
								分支
							</button>
						</>
					) : null}
					{message.runId ? (
						<button className="nvca-link-btn" onClick={() => setContextOpen(true)} title="查看这轮发给模型的上下文规模" type="button">
							<GaugeIcon className="nvca-i-xs" />
							上下文
						</button>
					) : null}
				</div>
			) : null}

			{contextOpen && message.runId ? (
				<ModelContextDialog runId={message.runId} onClose={() => setContextOpen(false)} />
			) : null}
		</div>
	)
}

const StepGroup = ({ parts }: { parts: Extract<AssistantMessage["parts"][number], { type: "tool_event" }>[] }) => {
	const [open, setOpen] = useState(true)
	const total = parts.length
	const finished = parts.filter((part) => part.status === "done" || part.status === "failed").length
	return (
		<div className="nvca-step-group">
			<button
				aria-expanded={open}
				className="nvca-step-group-head"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<ListChecksIcon className="nvca-i-sm" />
				<span className="nvca-step-group-title">执行清单</span>
				<span className="nvca-step-group-progress">{finished}/{total}</span>
				<span className="nvca-step-group-spacer" />
				<ChevronDownIcon className={cn("nvca-step-group-caret", open && "is-open")} />
			</button>
			{open ? (
				<div className="nvca-tool-list">
					{parts.map((part) => (
						<ToolCard key={part.id} part={part} />
					))}
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
		<div className="nvca-plan" data-state={planState || "pending"}>
			<div className="nvca-plan-head">
				<span className="nvca-plan-kicker">
					<SparklesIcon className="nvca-i-sm" />
					方案
				</span>
				<span className="nvca-plan-state">
					{planState === "running"
						? "执行中…"
						: planState === "applied"
							? "已执行"
							: planState === "aborted"
								? "已中止"
								: planState === "cancelled"
									? "已取消"
									: planState === "adjusted"
										? "换个说法"
										: "等你确认"}
				</span>
			</div>
			<div className="nvca-plan-title">{title}</div>
			<ol className="nvca-plan-steps">
				{plan.steps.map((step, index) => (
					<li className="nvca-plan-step" key={index}>
						<span className="nvca-plan-num">{index + 1}</span>
						<div className="nvca-plan-step-main">
							<span className="nvca-plan-tool">{toolLabel(step.tool)}</span>
							{step.description ? <span className="nvca-plan-desc">{step.description}</span> : null}
						</div>
					</li>
				))}
			</ol>
			<div className="nvca-plan-cost">
				{generations > 0 ? "会用掉 " + generations + " 次生成" : "不消耗生成额度"}
				{Number(plan.impact?.nodes) > 0 ? " · 新增 " + Number(plan.impact?.nodes) + " 个节点" : ""}
			</div>
			<div className="nvca-plan-actions">
				<button className="nvca-btn ghost" disabled={Boolean(resolved) || running} onClick={() => onAction("cancel")} type="button">
					取消
				</button>
				<button className="nvca-btn ghost" disabled={Boolean(resolved) || running} onClick={() => onAction("adjust")} type="button">
					换个说法
				</button>
				<button
					className="nvca-btn primary"
					disabled={Boolean(resolved) || running}
					onClick={() => onAction("run")}
					type="button"
				>
					<PlayIcon className="nvca-i-sm" />
					{generations > 0 ? "开始生成" : "开始"}
				</button>
			</div>
		</div>
	)
}

const ConfirmationHint = ({
	pending,
	store,
}: {
	pending: { kind?: string; tool?: string; description?: string; units?: number; reason?: string }
	store: AssistantStore
}) => {
	const isDelete = pending.kind === "delete" || String(pending.tool || "").indexOf("delete") === 0
	return (
		<div className="nvca-confirm">
			<div className="nvca-confirm-title">{isDelete ? "有一批节点等你确认删除" : "这一步还要再确认一次"}</div>
			<div className="nvca-confirm-note">
				{pending.description || pending.reason || (isDelete ? "确认后才会删除，删了还能撤销。" : "继续会再消耗生成额度。")}
			</div>
			<div className="nvca-confirm-actions">
				<button className="nvca-btn ghost" onClick={() => store.confirmAction(false)} type="button">
					不用了
				</button>
				<button className="nvca-btn primary" onClick={() => store.confirmAction(true)} type="button">
					{isDelete ? "删除" : "继续"}
				</button>
			</div>
		</div>
	)
}

const ArtifactGrid = ({
	items,
	onOpen,
}: {
	items: ArtifactItem[]
	onOpen: (item: ArtifactItem) => void
}) => (
	<div className="nvca-artifacts">
		<div className="nvca-artifacts-head">
			<ImageIcon className="nvca-i-sm" />
			<span>本轮产物</span>
			<span className="nvca-artifacts-count">{items.length}</span>
		</div>
		<div className="nvca-artifacts-grid">
			{items.map((item) => (
				<div className="nvca-artifact" key={item.id}>
					<button className="nvca-artifact-media" onClick={() => onOpen(item)} type="button">
						{item.kind === "video" ? (
							<video muted preload="metadata" src={item.url} />
						) : (
							<img alt={item.title || "生成的图片"} loading="lazy" src={item.thumb || item.url} />
						)}
					</button>
					<div className="nvca-artifact-foot">
						<span className="nvca-artifact-title">{item.title || (item.kind === "video" ? "视频" : "图片")}</span>
						<button className="nvca-link-btn" onClick={() => onOpen(item)} type="button">
							预览
						</button>
					</div>
				</div>
			))}
		</div>
	</div>
)

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

