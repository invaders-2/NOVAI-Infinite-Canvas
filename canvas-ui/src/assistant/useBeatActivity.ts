import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { BeatState } from "./beat/BeatAvatar"
import { GENERATION_TOOLS } from "./format"
import type { AssistantStore } from "./store"
import type { Message, Part } from "./types"

/* 画布助手的事件 → 头像表情。按优先级从上到下取第一条命中的：
 *
 * waiting      pendingConfirmation 非空。助手停下来等人，这是唯一会阻塞用户的状态，所以排第一。
 * error        agent_error / 刚失败的步骤。失败是一次事件不是一种状态，所以只闪 1.4s 再回 idle。
 * tool         有 running 的工具/步骤。工具执行要「忙」的样子。
 * generating   有 running 的生成类工具。生成要按进度扫描，和工具那种机械脉冲不是一回事，
 *              所以从 tool 里拆出来单独一档（否则 generate_image 这种也会落进 tool，永远看不到扫描）。
 * thinking     running 但还没有正文。正文开始流之后就不算「想」，避免长回答全程思考脸。
 * listening    Composer 有文字，或刚点发送 600ms 内。用户正在输入时助手应该在听。
 * success      streaming 正常收尾。一次性闪 1.2s；只有没有别的活动时才轮到它。
 * idle         没有活动。
 *
 * 一次性状态会被下一次事件覆盖：新事件的 key 不同就重新计时，绝不因为「条件还挂着」反复闪。
 * 失败只认 15s 内的 active 失败：历史和已结束的对话里也躺着失败步骤，不该在打开对话时闪红灯。
 * 生成类 part 目前没有真实进度字段（types.ts 里没有），所以统一给 0.5 不定态，见 readProgress。
 */

const ERROR_HOLD_MS = 1400
const SUCCESS_HOLD_MS = 1200
const SENT_WINDOW_MS = 600
const FAILED_FRESH_MS = 15000
const INDETERMINATE_PROGRESS = 0.5

export interface BeatActivity {
	state: BeatState
	progress: number
}

/* Composer 的输入文字留在 prompt-input 的 controller 里，没有进 store；这里开一个极小的外部信号，
   让「用户正在打字」能被 hook 看到，又不用把草稿塞进会话状态。 */
let drafting = false
const draftingListeners = new Set<() => void>()

export const setBeatDrafting = (value: boolean) => {
	const next = Boolean(value)
	if (next === drafting) return
	drafting = next
	for (const listener of draftingListeners) listener()
}

const subscribeDrafting = (listener: () => void) => {
	draftingListeners.add(listener)
	return () => {
		draftingListeners.delete(listener)
	}
}

const readDrafting = () => drafting

const partStatus = (part: Part): string => {
	const value = (part as { status?: unknown }).status
	return typeof value === "string" ? value : ""
}

const lastAssistantMessage = (messages: Message[]): Message | null => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") return messages[index]
	}
	return null
}

/* 留一条读真值的口子：后端一旦在 part 里带 progress（0..1 或 0..100），这里直接用，
   读不到才给 null 让调用方走不定态——不自己编百分比。 */
const readProgress = (part: Part): number | null => {
	const raw = (part as { progress?: unknown }).progress
	if (typeof raw !== "number" || !Number.isFinite(raw)) return null
	return Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw))
}

const freshFailureKey = (message: Message | null): string => {
	if (!message) return ""
	for (const part of message.parts) {
		if (part.type === "agent_error") return "agent_error:" + part.id
	}
	const now = Date.now()
	for (const part of message.parts) {
		if (part.type !== "tool_event" || part.status !== "failed") continue
		if (!part.endedAt || now - Number(part.endedAt) > FAILED_FRESH_MS) continue
		return "failed:" + part.id
	}
	return ""
}

export const useBeatActivity = (store: AssistantStore): BeatActivity => {
	const { state: session, env } = store
	const draftingNow = useSyncExternalStore(subscribeDrafting, readDrafting, readDrafting)
	const [pulse, setPulse] = useState<{ state: BeatState; key: string; until: number } | null>(null)
	const streamSeen = useRef(String(session.streamState || env.streamState || "idle"))
	const failureSeen = useRef("")
	const lastMessageId = useRef("")
	const sentAt = useRef(0)

	const messages = session.messages
	const lastMessage = messages.length ? messages[messages.length - 1] : null
	const streamState = String(session.streamState || env.streamState || "idle")
	const assistant = lastAssistantMessage(messages)
	const parts = assistant ? assistant.parts : []
	const active = Boolean(env.running) || streamState === "streaming"

	/* 发送窗口：store 只在事件到来时通知，「刚点发送」用渲染时的墙钟判断就够了 */
	if (lastMessage && lastMessage.role === "user" && lastMessage.id !== lastMessageId.current) {
		lastMessageId.current = lastMessage.id
		sentAt.current = Date.now()
	}
	const justSent = sentAt.current > 0 && Date.now() - sentAt.current < SENT_WINDOW_MS

	const failure = freshFailureKey(assistant)
	const runningParts = parts.filter(
		(part): part is Extract<Part, { type: "tool_event" }> => part.type === "tool_event" && part.status === "running",
	)
	const generatingPart = runningParts.find((part) => GENERATION_TOOLS.has(part.tool)) || null
	const toolPart = runningParts.find((part) => !GENERATION_TOOLS.has(part.tool)) || null
	const hasText = parts.some((part) => part.type === "text" && part.text.trim())
	const thinkingNow = active && !hasText
	const listening = draftingNow || justSent

	useEffect(() => {
		if (!failure || failure === failureSeen.current) return
		failureSeen.current = failure
		setPulse({ state: "error", key: failure, until: Date.now() + ERROR_HOLD_MS })
	}, [failure])

	useEffect(() => {
		const previous = streamSeen.current
		streamSeen.current = streamState
		if (previous !== "streaming" || streamState === "streaming") return
		if (streamState !== "completed" || !assistant) return
		if (assistant.status !== "completed" && assistant.status !== "done") return
		setPulse({ state: "happy", key: "ok:" + assistant.id, until: Date.now() + SUCCESS_HOLD_MS })
	}, [streamState])

	useEffect(() => {
		if (!pulse) return
		const remaining = pulse.until - Date.now()
		if (remaining <= 0) {
			setPulse(null)
			return
		}
		const timer = window.setTimeout(() => setPulse(null), remaining)
		return () => window.clearTimeout(timer)
	}, [pulse])

	const live = pulse && pulse.until > Date.now() ? pulse : null
	let state: BeatState
	if (session.pendingConfirmation) state = "waiting"
	else if (live && live.state === "error") state = "error"
	else if (toolPart) state = "tool"
	else if (generatingPart) state = "generating"
	else if (thinkingNow) state = "thinking"
	else if (listening) state = "listening"
	else if (live) state = live.state
	else state = "idle"

	const progress = generatingPart ? readProgress(generatingPart) ?? INDETERMINATE_PROGRESS : INDETERMINATE_PROGRESS

	return { state, progress }
}
