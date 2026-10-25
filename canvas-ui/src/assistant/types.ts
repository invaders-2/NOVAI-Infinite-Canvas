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
			output?: string
			args?: unknown
			payload?: unknown
			startedAt?: number
			endedAt?: number
	  }
	| {
			type: "confirmation"
			id: string
			index?: string
			tool: string
			args?: unknown
			reason: string
			confirmKind: string
			units?: number
			description: string
			status: "pending" | "executing" | "executed" | "skipped" | "cancelled"
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
	/** done 事件里的 changes：本轮改了画布才显示检查点 */
	changes?: {
		nodes_created?: number
		nodes_modified?: number
		nodes_deleted?: number
		connections?: number
		generations?: number
	}
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

export interface ChatModelOption {
	value: string
	provider: string
	providerName: string
}

export interface ImageProviderOption {
	value: string
	label: string
}

export interface ComposerState {
	models: ChatModelOption[]
	model: string
	provider: string
	imageProviders: ImageProviderOption[]
	imageProvider: string
	planConfirm: boolean
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
	selectSkill(id: string): void | Promise<boolean>
	/** 应用市场种子里的 store:<id> 技能：由桥接层在下一次 /api/agent/run 的请求体里带上 skill_ref */
	applySkillRef?(ref: string): void
	clearSkill(): void
	removeRef(id: string): void
	clearRefs(): void
	setChatModel(model: string, provider: string): void
	setImageProvider(value: string): void
	setPlanConfirm(on: boolean): void
	/** 把画布当前选中的节点加进本轮引用，返回引用条数量（0 = 没有选中节点/同步失败） */
	addSelectedRefs(): Promise<number>
	/** 打开旧面板的素材上传（图片/视频），上传后同样以引用条形式进入本轮上下文 */
	pickUpload(): void
	planAction(action: "run" | "cancel" | "adjust"): void
	confirmAction?(yes: boolean): void
	approveStep?(step: { tool: string; args?: unknown; description?: string }, instruction: string): Promise<boolean>
	undoRun?(runId: string): Promise<{ ok: boolean; message: string }>
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
	setComposerState(state: ComposerState): void
	clearHistory(): void
	/** 外部（桥接层/应用市场种子）触发的自动发送；resolve 表示是否已进入官方 run 通路 */
	seedAutoSend(input: { text: string; skillRef?: string }): Promise<boolean>
	destroy(): void
}
