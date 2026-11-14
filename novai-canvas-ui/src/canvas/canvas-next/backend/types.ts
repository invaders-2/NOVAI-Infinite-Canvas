/**
 * 画布后端接口。界面只认这一层：
 *   · bridge.ts —— 桌面版真后端，走 window.novai.canvas / window.novai.model 命令；
 *   · mock.ts   —— 本地模拟，独立页面 / 开发 / 自动化测试用，不联网不花钱。
 * 换后端 = 换一个实现，组件和生成引擎不改。
 */
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";
import type { AnyParams, GenKind, GenOutput, ModelSpec, VideoMode } from "../model";

/** 发给模型的一个输入（上游节点的产物） */
export type GenInput = {
  nodeId: string;
  title: string;
  kind: GenKind;
  /** 1 起的序号，等于连线顺序 */
  order: number;
  /** 输入在这次生成里的角色 */
  role: "reference" | "first_frame" | "last_frame" | "source_video" | "reference_video" | "driving_audio" | "portrait" | "context";
  url?: string;
  text?: string;
};

export type GenRequest = {
  canvasId: string;
  nodeId: string;
  kind: GenKind;
  model: ModelSpec;
  prompt: string;
  /** 已把 @引用 展开后的提示词 */
  resolvedPrompt: string;
  params: AnyParams;
  inputs: GenInput[];
  /**
   * 「@ 本节点」这次实际发出去的自我参考图：string = 那张源图；null = 没发（节点当时没有结果 / 模型不收）。
   * 写回时原样记到新版本的 meta.selfSrc；字段缺失 = 旧请求快照，按旧数据回退。
   */
  selfSrc?: string | null;
  /** 视频：TapNow modelType */
  videoMode?: { name: VideoMode; api: string };
};

export type GenEvent =
  | { type: "started"; runId?: string }
  | { type: "progress"; progress: number }
  /** 文本流式增量（整段累计文本） */
  | { type: "text"; text: string };

export type GenResult = { outputs: GenOutput[]; runId?: string };
export type VideoSegment = { inSec: number; outSec: number };

export class GenError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** 图片编辑（局部重绘 / 擦除 / 标注 / 多角度 / 重打光 / 扩图 / 增强 / 抠图） */
export type EditOp = "redraw" | "erase" | "annotate" | "angle" | "relight" | "outpaint" | "enhance" | "cutout" | "whitemodel";

/** 本地抠图模型（RMBG）状态：NOVAI 后端有这套接口，NOVAI 桌面版没有 */
export type MattingModelStatus = {
  downloaded: boolean;
  downloading?: boolean;
  verifying?: boolean;
  /** 0-100 */
  progress?: number;
  downloaded_mb?: number;
  total_mb?: number;
  model_size_mb?: number;
  speed_mbps?: number;
  eta_seconds?: number;
  attempt?: number;
  retrying?: boolean;
  hint?: string;
  cancelled?: boolean;
  error?: string;
  load_error?: string;
};
/** 本地超分（Real-ESRGAN）运行时状态：NOVAI 后端有这套接口，NOVAI 桌面版没有 */
export type UpscaleRuntimeStatus = { installed: boolean; downloading: boolean; progress: number; message: string; platform?: string };
/** 本地超分结果：skipped 表示原图已经达到目标精度，url 指回原图，调用方不要再写一个新版本 */
export type UpscaleResult = GenOutput & { skipped?: boolean };
export type EditRequest = { canvasId: string; nodeId: string; op: EditOp; model?: ModelSpec; sourceUrl: string; maskDataUrl?: string; prompt?: string; params?: Record<string, unknown> };

/**
 * 后端持久任务的精简视图（图片 / 视频任务化生成用）：
 * 离开画布时前端只把 taskId 记在节点上，回来按它接上——不再新建任务，也不会丢结果。
 */
export type CanvasTask = {
  taskId: string;
  /** 发起任务的画布节点（没带 node_id 的老任务是空串） */
  nodeId: string;
  kind: "image" | "video";
  /** legacy 口径：queued/running/succeeded/failed（cancelled 后端会归到 failed） */
  status: "queued" | "running" | "succeeded" | "failed";
  model?: string;
  result?: Record<string, any> | null;
  error?: string;
  createdAt: number;
  updatedAt?: number;
};

export type LoadedDoc = { doc: CanvasDoc; version: number | null; source: "bridge" | "local" | "mock"; error?: string; migrated?: boolean };
export type SavedDoc = { ok: true; version: number | null } | { ok: false; conflict: boolean; error: string; remote?: CanvasDoc; remoteVersion?: number };

/** 多模态内容块（OpenAI 兼容写法；Anthropic 适配层会转成 image block） */
export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

export type CanvasAgentContext = {
  schemaVersion: 1;
  canvasId: string;
  selectedNodeIds: string[];
  resourceRefs: string[];
  completionConditions: string[];
  modelConfigId?: string;
  /** 思考强度（关闭 / 轻度 / 标准 / 深度）；运行时据此决定规划深度和是否先提问 */
  thinking?: "off" | "light" | "standard" | "heavy";
  /** 手动模式先出方案；自动模式可执行只读工具，写操作仍受既有确认闸门约束 */
  mode?: "plan" | "run";
  /** 当前画布/选中节点惯用的图片模型，task/run 时带给助手，避免它按清单第一个模型出图 */
  imageProvider?: string;
  imageModel?: string;
  /** 当前对话线程：后端据此读取线程历史，并把本轮问答追加回线程（不传 = 不带历史） */
  threadId?: string;
  /** 本轮挂载的技能（名字 + 正文）：后端放进系统提示，不再塞进 goal 被截断 */
  skillName?: string;
  skillPrompt?: string;
  /** 本轮 @ 点名的应用（工具）：后端要求方案里真的调用它们 */
  apps?: Array<{ name: string; title: string; description: string }>;
  /** 模型强度档位键（后端 model_caps.think 里的一档）；空 = 不传 = 默认 */
  thinkLevel?: string;
  /** 自治档位（阶段四）：协作（默认，写入逐次批准）/ 自动推进 / 托管（按预算自动推进） */
  autonomy?: "collab" | "auto" | "managed";
};
/** 待用户确认的执行方案（服务端 plan 事件原样；没有方案时为 null） */
export type AgentTaskPlan = {
  intent?: string;
  summary?: string;
  expected_output?: string;
  /** 模型给用户看的「为什么这么选」/「我假设了什么」：只在方案卡上展示，人话 1-2 行 */
  reason?: string;
  assumptions?: string[] | string;
  requires_confirmation?: boolean;
  blocked_tools?: string[];
  impact?: Record<string, any>;
  steps: Array<{ tool: string; args?: Record<string, any>; description?: string; index?: number }>;
  /** 整个任务的阶段路线图（steps 只是第一阶段）；批准 = 批准整套路线 */
  roadmap?: Array<{ stage: string; detail?: string; generations?: number; /** 这一阶段的验收标准（一句话，旧数据没有） */ acceptance?: string }>;
  /** generation = 待生成卡片（节点已建好，用户选模型后执行）；其余为普通执行方案 */
  kind?: string;
  nodes?: Array<{ node_id: string; title: string; kind: string; prompt?: string }>;
  total_generations?: number;
};
/** 重新生成一项：node_id 指向画布节点，prompt 是审查给的修订提示词（可为空，后端按 issues 自己改） */
export type AgentRegenerateItem = {
  node_id: string;
  label?: string;
  kind?: string;
  prompt?: string;
  issues?: string[];
};
/** 审查不合格后的一键重新生成：后端改提示词并立即开跑，跑完自动复审再问 */
export type AgentRegenerateRequest = {
  canvasId: string;
  threadId?: string;
  /** 用户自己写的修改描述（结果确认卡里选 / 写的反馈），可空 */
  description?: string;
  items: AgentRegenerateItem[];
};
export type AgentTaskSnapshot = {
  taskId: string;
  status: string;
  modelConfigId?: string | null;
  steps: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  calls: Array<Record<string, any>>;
  artifacts: Array<Record<string, any>>;
  verifications: Array<Record<string, any>>;
  /** 等用户点「执行」的方案：有它就是「需要确认」，不是「已完成」 */
  plan?: AgentTaskPlan | null;
  error?: string;
};

export interface CanvasBackend {
  readonly kind: "bridge" | "mock";
  /** 根所有者释放共享订阅；不得取消仍在执行的后台 Task。 */
  dispose?(): void;
  /** 是否真的能生成（bridge 在没接桌面后端时为 false，界面据此提示） */
  available(): boolean;
  listModels(): Promise<ModelSpec[]>;
  /** 模型目录失效信号（设置页增删 / 启停 / 改名模型后）。实现方在缓存作废时回调，返回取消订阅函数。 */
  onModelsChanged?(cb: () => void): () => void;
  loadDoc(canvasId: string): Promise<LoadedDoc>;
  readAuthoritativeDoc?(canvasId: string): Promise<LoadedDoc>;
  saveDoc(canvasId: string, doc: CanvasDoc, baseVersion: number | null): Promise<SavedDoc>;
  renameCanvas?(canvasId: string, title: string): Promise<unknown>;
  /** 生成；signal 中止 = 用户点停止（后端也要停掉对应任务） */
  generate(req: GenRequest, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenResult>;
  /** 这张画布上最近的任务（离开画布回来续跑用）；老后端不实现 = 没有续跑能力 */
  listCanvasTasks?(canvasId: string): Promise<CanvasTask[]>;
  /** 接着已有任务等结果（不新建任务；已完成的直接返回结果） */
  resumeTask?(task: CanvasTask, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenOutput[]>;
  /** 用户主动停止生成：真正取消后端任务（页面卸载 / 切画布不调，留给回来续跑） */
  cancelTask?(taskId: string): Promise<void>;
  /** 图片编辑，返回新版本（原图保留在历史里） */
  editImage(req: EditRequest, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenOutput>;
  /** Agent / 提示词润色用的对话（流式）；返回完整文本 */
  chat(req: { canvasId: string; configId?: string; effort?: "auto" | "low" | "high"; /** 模型强度档位键（low/mid/high/xhigh/max）；空 = 不传 = 模型默认 */ thinkLevel?: string; messages: ChatMessage[]; /** 附图（novai-asset / data / https），只发给能看图的模型 */ images?: string[] }, onDelta: (full: string) => void, signal: AbortSignal): Promise<string>;
  runAgentTask?(req: { goal: string; context: CanvasAgentContext }): Promise<{ ok: boolean; taskId?: string; status?: string; error?: string }>;
  /** 托管授权：提交 / 补充预算（平台 + 模型 + 生成次数上限） */
  postAgentBudget?(runId: string, budget: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  defaultChatModel?(): Promise<string | null>;
  /** 把画布助手的默认对话模型记到服务端（null = 清掉，回到列表第一个） */
  setDefaultChatModel?(id: string | null): Promise<void>;
  watchAgentTask?(taskId: string, onSnapshot: (snapshot: AgentTaskSnapshot) => void): () => void;
  cancelAgentTask?(taskId: string): Promise<{ ok: boolean; error?: string }>;
  /** 用户在方案卡上点「执行」：批准步骤后返回新的任务 ID（后续照旧 watchAgentTask） */
  approveAgentTask?(taskId: string, steps: AgentTaskPlan["steps"]): Promise<{ ok: boolean; taskId?: string; status?: string; error?: string }>;
  /** 审查不合格后的一键重新生成：后端按修订提示词 / 用户描述改节点参数并立刻开跑（返回 taskId，后续照旧 watchAgentTask） */
  regenerateAgentResults?(req: AgentRegenerateRequest): Promise<{ ok: boolean; taskId?: string; status?: string; error?: string }>;
  /** 本地文件 / data URL 存进资源库，返回画布里可保存的地址（novai-asset:… 或原地址） */
  importAsset(canvasId: string, dataUrl: string, name: string): Promise<string>;
  /** 模型返回的远程结果（https）下载进资源库，返回 novai-asset 引用；失败时原样返回 url */
  importRemote?(canvasId: string, url: string, name: string): Promise<string>;
  /** novai-asset:… → 可显示的地址 */
  resolveAsset(ref: string): Promise<string | null>;
  /** 抠图用的本地模型（RMBG）：查状态 / 开始下载 / 取消下载。没实现这套接口的后端，抠图直接走 editImage */
  mattingModelStatus?(): Promise<MattingModelStatus>;
  mattingModelDownload?(): Promise<{ ok: boolean; downloaded?: boolean; error?: string }>;
  mattingModelCancel?(): Promise<{ ok: boolean }>;
  /** 本地超分：查运行时 / 下载运行时 / 真正超分。没实现这套接口的后端（老后端、BEAT 桌面版）增强仍走在线 AI */
  upscaleRuntimeStatus?(): Promise<UpscaleRuntimeStatus>;
  upscaleRuntimeDownload?(): Promise<{ ok: boolean; installed?: boolean; error?: string }>;
  upscaleLocal?(sourceUrl: string, target: "2k" | "4k"): Promise<UpscaleResult>;
  /** 深度动作捕捉：本机把视频逐帧转成深度参考视频（灰度、越近越亮）。没实现的后端不显示入口 */
  depthCapture?(sourceUrl: string): Promise<{ url: string; w?: number; h?: number; dur?: number; seconds?: number }>;
  /** 本机套用原声：把 audioUrl 的音轨贴到 videoUrl 上，可只取 start 起 duration 秒；返回新视频地址 */
  muxAudio?(videoUrl: string, audioUrl: string, opts?: { start?: number; duration?: number }): Promise<{ url: string; dur?: number; seconds?: number }>;

  /** novai-asset:…（视频 / 音频）→ 可边播边拖的流式地址；拿不到时 null，调用方退回 resolveAsset */
  mediaUrl?(ref: string): Promise<{ url: string; expiresAt: number } | null>;
  /** 视频智能切镜：返回各镜头区间（秒）；没有 ffmpeg 等失败时 ok:false */
  /** 文档（docx / xlsx / txt / md…）抽成文本；没有时只读纯文本类文件 */
  extractDocument?(dataUrl: string, name: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string; detail?: string }>;
  detectScenes?(dataUrl: string): Promise<{ ok: true; duration: number; shots: VideoSegment[]; /** 镜头太多，最后一段包含剩余部分 */ capped?: boolean } | { ok: false; error: string; detail?: string }>;
  /** 按区间真裁剪视频并存进资源库（每段一个引用）；没有 ffmpeg 等失败时 ok:false */
  clipVideo?(canvasId: string, dataUrl: string, segments: VideoSegment[], name: string): Promise<{ ok: boolean; clips: Array<{ ref?: string; duration?: number; inSec?: number; outSec?: number; error?: string }>; error?: string; /** 超过一次能裁的段数而没裁的段 */ dropped?: number }>;
}