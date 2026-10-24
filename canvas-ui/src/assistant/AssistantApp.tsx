import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Markdown } from "@/components/ai-elements/markdown"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task"
import { cn } from "@/lib/utils"
import {
	ChevronDownIcon,
	GaugeIcon,
	ImageIcon,
	ListChecksIcon,
	PlayIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Composer } from "./Composer"
import { ModelContextDialog } from "./ModelContextDialog"
import { ThreadBar } from "./ThreadBar"
import { deriveRun, formatTokens, formatWorkMs, statusLabel, toolIconKey, toolLabel } from "./format"
import { ToolIcon } from "./icons"
import type { AssistantStore } from "./store"
import type { ArtifactItem, Message as AssistantMessage, SkillChip } from "./types"

const EXAMPLES = ["生成一张红色杯子的图", "用选中的图做电商主图", "创建提示词节点并连线", "生成一张赛博朋克风格的街道图"]

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
		<div className="nvca-root">
			<ThreadBar store={store} />
			<Conversation className="nvca-conversation">
				<ConversationContent className="nvca-conversation-content">
					{messages.length === 0 ? (
						<EmptyState onPick={pickExample} skills={env.skills} />
					) : (
						messages.map((message, index) => {
							if (message.role === "user") return <UserBubble key={message.id} message={message} />
							if (message.role === "system") return <SystemNote key={message.id} message={message} />
							const isLast = index === lastAssistantIndex
							const streaming = env.running && (state.streamingMessageId === message.id || (isLast && !state.streamingMessageId))
							return (
								<RunTurn
									key={message.id}
									message={message}
									streaming={streaming}
									artifacts={isLast ? env.artifacts : []}
									onOpenArtifact={setLightbox}
									store={store}
								/>
							)
						})
					)}
				</ConversationContent>
				<ConversationScrollButton className="nvca-scroll-btn" />
			</Conversation>
			<Composer store={store} pendingText={pendingText} />
			{lightbox ? <Lightbox item={lightbox} onClose={() => setLightbox(null)} /> : null}
		</div>
	)
}

const EmptyState = ({ onPick, skills }: { onPick: (text: string) => void; skills: SkillChip[] }) => (
	<div className="nvca-empty">
		<div className="nvca-empty-icon">
			<SparklesIcon className="nvca-i-lg" />
		</div>
		<h3 className="nvca-empty-title">你好，我是画布助手</h3>
		<p className="nvca-empty-sub">告诉我你想做什么。写操作会先给你一版方案，点「开始」才动画布。</p>
		{skills.length > 0 ? (
			<div className="nvca-empty-skills">
				{skills.slice(0, 4).map((skill) => (
					<span className="nvca-empty-skill" key={skill.id}>
						<span>{skill.icon || "✨"}</span>
						{skill.name}
					</span>
				))}
			</div>
		) : null}
		<div className="nvca-empty-examples">
			{EXAMPLES.map((example) => (
				<button className="nvca-example" key={example} onClick={() => onPick(example)} type="button">
					{example}
				</button>
			))}
		</div>
	</div>
)

const UserBubble = ({ message }: { message: AssistantMessage }) => {
	const text = message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim()
	return (
		<Message className="nvca-user-msg" from="user">
			<MessageContent className="nvca-user-bubble">
				<p className="nvca-user-text">{text}</p>
			</MessageContent>
		</Message>
	)
}

const SystemNote = ({ message }: { message: AssistantMessage }) => {
	const text = message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim()
	if (!text) return null
	return <div className={cn("nvca-system", message.systemKind === "warn" && "is-warn", message.systemKind === "error" && "is-error")}>{text}</div>
}

const RunTurn = ({
	message,
	streaming,
	artifacts,
	onOpenArtifact,
	store,
}: {
	message: AssistantMessage
	streaming: boolean
	artifacts: ArtifactItem[]
	onOpenArtifact: (item: ArtifactItem) => void
	store: AssistantStore
}) => {
	useTicker(streaming)
	const [contextOpen, setContextOpen] = useState(false)
	const run = deriveRun(message)
	const { state } = store
	const pending = state.pendingConfirmation as { kind?: string; tool?: string; description?: string; units?: number; reason?: string } | null
	const status = message.status || (streaming ? state.streamState : "")
	const outcomeLabel = run.outcome ? statusLabel(run.outcome.status, "已结束") : ""
	const totalWork = run.outcome?.activeWorkMs || message.activeWorkMs || 0
	const hasSteps = run.steps.length > 0 || run.tools.length > 0
	const hasBody = hasSteps || Boolean(run.thinking) || Boolean(message.plan)

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

					{hasSteps ? (
						<Task className="nvca-steps" defaultOpen={streaming || run.steps.length <= 6}>
							<TaskTrigger className="nvca-steps-trigger" title="">
								<ListChecksIcon className="nvca-i-sm" />
								<span className="nvca-steps-title">执行清单</span>
								<span className="nvca-steps-count">{run.steps.length + run.tools.length}</span>
								<ChevronDownIcon className="nvca-i-xs nvca-steps-caret" />
							</TaskTrigger>
							<TaskContent className="nvca-steps-content">
								{run.tools.map((part) => (
									<StepRow key={part.id} part={part} />
								))}
								{run.steps.map((part, index) => (
									<StepRow key={part.id} part={part} index={index} />
								))}
							</TaskContent>
						</Task>
					) : null}

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

			{pending && pending.kind !== "plan" ? <ConfirmationHint pending={pending} store={store} /> : null}

			{message.runId ? (
				<div className="nvca-run-tools">
					<button className="nvca-link-btn" onClick={() => setContextOpen(true)} title="查看这轮发给模型的上下文规模" type="button">
						<GaugeIcon className="nvca-i-xs" />
						上下文
					</button>
				</div>
			) : null}

			{contextOpen && message.runId ? (
				<ModelContextDialog runId={message.runId} onClose={() => setContextOpen(false)} />
			) : null}
		</div>
	)
}

const StepRow = ({
	part,
	index,
}: {
	part: Extract<AssistantMessage["parts"][number], { type: "tool_event" }>
	index?: number
}) => {
	const status = part.status || ""
	const icon = toolIconKey(part.tool)
	return (
		<div className="nvca-step" data-status={status || "pending"}>
			<span className="nvca-step-icon">
				<ToolIcon className="nvca-i-sm" name={icon} />
			</span>
			<div className="nvca-step-body">
				<div className="nvca-step-head">
					{typeof index === "number" ? <span className="nvca-step-index">{index + 1}</span> : null}
					<span className="nvca-step-title">{part.title || toolLabel(part.tool)}</span>
					<span className="nvca-step-state">
						{status === "running" ? <span className="nvca-pulse" /> : null}
						{status === "done" ? <ToolIcon className="nvca-i-xs is-ok" name="checkPlain" /> : null}
						{status === "failed" ? <ToolIcon className="nvca-i-xs is-fail" name="fail" /> : null}
					</span>
				</div>
				{part.message ? <div className="nvca-step-note">{part.message}</div> : null}
			</div>
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

