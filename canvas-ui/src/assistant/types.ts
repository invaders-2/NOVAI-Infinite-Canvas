// 画布助手微应用的数据契约：宿主（NOVAI 桥接层）→ 微应用（事件/环境），微应用 → 宿主（动作）。
// 只描述渲染需要的最小集合，不改动 /api/agent/* 的协议。

export type Part =
	| { type: "text"; id: string; text: string }
	| { type: "thinking"; id: string; text: string; totalDurationMs: number }
	| {
			type: "tool_event"
			id: string
			kind: "step" | "tool" | string
			index?: string
			tool: string
			title: string
			status: "" | "running" | "done" | "failed"
			message: string
			ok?: boolean
			code?: string
			result?: unknown
			payload?: unknown
			startedAt?: number
			endedAt?: number
	  }
	| { type: "run_outcome"; id: string; status: string; activeWorkMs: number; steps: number }
	| { type: "usage"; id: string; usage: UsageTotals }
	| { type: "user_steer"; id: string; text: string; status: string }
	| { type: "context_nodes"; id: string; nodeIds: string[]; nodeCount: number }
	| { type: "agent_error"; id: string; message: string; code: string }

export interface UsageTotals {
	input_tokens?: number
	output_tokens?: number
	total_tokens?: number
	cached_tokens?: number
	cache_read_tokens?: number
	cache_write_tokens?: number
	reasoning_tokens?: number
}

export interface PlanStep {
	tool: string
	args?: Record<string, unknown>
	description?: string
}

export interface PlanData {
	intent: string
	summary: string
	steps: PlanStep[]
	requiresConfirmation: boolean
	round: number
	impact?: { generations?: number; writes?: number; nodes?: number } | null
}

export interface Message {
	id: string
	role: "user" | "assistant" | "system"
	parts: Part[]
	status: string
	activeWorkMs: number
	createdAt: number
	/** 该轮 run 的 id：运行卡底部「上下文」调试入口用，历史消息没有 */
	runId?: string
	plan?: PlanData
	planState?: "pending" | "running" | "applied" | "cancelled" | "adjusted" | "aborted" | ""
	systemKind?: "info" | "warn" | "error"
}

export interface RefChip {
	id: string
	name: string
	role?: string
	type?: string
	thumbUrl?: string
	kind?: "image" | "video"
}

export interface SkillChip {
	id: string
	name: string
	icon?: string
	description?: string
}

export interface ArtifactItem {
	id: string
	kind: "image" | "video"
	url: string
	thumb?: string
	title?: string
	tool?: string
}

export interface ContextUsage {
	used_tokens?: number
	max_tokens?: number
	percentage?: number
}

export interface StreamEvent {
	id?: string
	type?: string
	data?: Record<string, unknown>
}

// 宿主提供的动作 + 推送接口。动作全部落到 NOVAI 现有函数（sendChatMessage / abortAgentRun / 旧方案卡按钮）。
export interface CanvasAssistantHostApi {
	send(text: string): boolean | Promise<boolean>
	abort(): void
	steer(text: string): void
	selectSkill(id: string): void
	clearSkill(): void
	removeRef(id: string): void
	clearRefs(): void
	planAction(action: "run" | "cancel" | "adjust"): void
	confirmAction?(yes: boolean): void
	togglePlanConfirm(on: boolean): void
	openHistory(): void
	openNode(id: string): void
	toast?(message: string): void
}

export interface CanvasAssistantHandle {
	pushEvent(event: StreamEvent): void
	setHistory(messages: { role?: string; text?: string }[]): void
	setRefs(refs: RefChip[]): void
	setSkills(skills: SkillChip[]): void
	setSelectedSkill(id: string | null): void
	setRunning(running: boolean): void
	setPlanConfirm(on: boolean): void
	setContextUsage(usage: ContextUsage | null): void
	setArtifacts(items: ArtifactItem[]): void
	setStreamState(state: string): void
	notifySteer(text: string, status: string): void
	notifySystem(text: string, kind?: "info" | "warn" | "error"): void
	notifyRunSummary(text: string): void
	clearHistory(): void
	destroy(): void
}
