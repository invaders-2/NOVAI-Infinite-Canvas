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
			/** 历史消息里带的服务端耗时 */
			durationMs?: number
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
	| { type: "vision"; id: string; mode: string; labels: string[]; text: string }
	| { type: "usage"; id: string; usage: UsageTotals }
	| { type: "user_steer"; id: string; text: string; status: string }
	| { type: "context_nodes"; id: string; nodeIds: string[]; nodeCount: number }
	| { type: "agent_error"; id: string; message: string; code: string }
	| ({ type: "reference_images" } & ReferenceCardData)

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
		artifacts?: number
	}
	/** 历史消息里的来源 URL */
	sources?: string[]
	plan?: PlanData
	planState?: "pending" | "running" | "applied" | "cancelled" | "adjusted" | "aborted" | ""
	systemKind?: "info" | "warn" | "error"
	rating?: "up" | "down"
}

export interface RefChip {
	id: string
	name: string
	role?: string
	type?: string
	nodeType?: string
	thumbUrl?: string
	kind?: "image" | "video"
}

export interface SkillChip {
	id: string
	name: string
	icon?: string
	description?: string
}

/** 联网搜图 / 反图的一张参考图（契约 docs/agent-web-image-search.md 的 ImageItem，字段名不许改） */
export interface ReferenceImage {
	id: string
	title: string
	/** 原图直链：只有它允许进画布 / 进生成 */
	original_url: string
	/** 缩略图：只允许在面板里做预览 */
	thumb_url: string
	width: number | null
	height: number | null
	source_page: string
	source_site: string
	/** 素材站标识（bing / 360 / huaban / zcool / nipic / duitang / tuchong；老数据可能为空） */
	source_kind: string
}

/** 来源筛选 chips 的一行：数量取 result.sources，老数据没有就按 items 现算 */
export interface ReferenceSourceRow {
	kind: string
	label: string
	count: number
}

/** 参考图选择卡的渲染数据：工具结果与反图接口都归一到这一份 */
export interface ReferenceCardData {
	/** 卡片的稳定标识（工具事件/反图 part 的 id） */
	id: string
	source: "search" | "reverse"
	status: "loading" | "done" | "failed" | "disabled"
	items: ReferenceImage[]
	engine: string
	query: string
	queries: string[]
	description: string
	/** 后端给的真实原因（搜不到 / 被限流等） */
	note: string
	/** 失败原因（失败态与关闭联网态都用它） */
	message: string
	code: string
	/** 反图入口那张图，卡片顶部回显 */
	imageUrl: string
	title: string
	/** 来源筛选；多来源才显示那排 chips */
	sources: ReferenceSourceRow[]
}

/** 加入画布的请求条目：url 必须是 /api/agent/images/import 返回的本地 url */
export interface InsertImageRequest {
	url: string
	name?: string
	width?: number | null
	height?: number | null
}

export interface InsertImagesResult {
	ok: boolean
	created: number
	message?: string
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
	event?: string
	name?: string
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
	enterPickMode?(): void
	exitPickMode?(): void
	captureCanvas?(): Promise<boolean>
	captureRegionPreview?(rect: { x: number; y: number; w: number; h: number }): Promise<{ url: string; width: number; height: number } | null>
	addCaptureRef?(url: string, width: number, height: number): boolean
	addSkillRef?(skill: { id: string; name: string; description?: string; storeRef?: string }): boolean
	addAppRef?(app: { id: string; name: string; description?: string; activationSkill?: string }): boolean
	addFolderRef?(name: string, count: number): boolean
	addFolderFiles?(files: { name: string; url?: string; kind?: string }[]): number
	planAction(action: "run" | "cancel" | "adjust"): void
	confirmAction?(yes: boolean): void
	approveStep?(step: { tool: string; args?: unknown; description?: string }, instruction: string): Promise<boolean>
	undoRun?(runId: string): Promise<{ ok: boolean; message: string }>
	togglePlanConfirm(on: boolean): void
	openHistory(): void
	openNode(id: string): void
	toast?(message: string): void
	/** 把已经落库成本地文件的图片建成画布 image 节点（视口中心、一次撤销、建完选中） */
	insertImages?(items: InsertImageRequest[]): Promise<InsertImagesResult>
	/** 画布上当前选中的图片节点；没选中或不是图片节点时返回 null */
	getSelectedImage?(): { url: string; title?: string } | null
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
