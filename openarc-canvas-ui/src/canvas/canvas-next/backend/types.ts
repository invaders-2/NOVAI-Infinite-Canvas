/**
 * 画布后端接口。界面只认这一层：
 *   · bridge.ts —— 桌面版真后端，走 window.openarc.canvas / window.openarc.model 命令；
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
export type EditOp = "redraw" | "erase" | "annotate" | "angle" | "relight" | "outpaint" | "enhance" | "cutout";
export type EditRequest = { canvasId: string; nodeId: string; op: EditOp; model?: ModelSpec; sourceUrl: string; maskDataUrl?: string; prompt?: string; params?: Record<string, unknown> };

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
  /** 图片编辑，返回新版本（原图保留在历史里） */
  editImage(req: EditRequest, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<GenOutput>;
  /** Agent / 提示词润色用的对话（流式）；返回完整文本 */
  chat(req: { canvasId: string; configId?: string; effort?: "auto" | "low" | "high"; messages: ChatMessage[]; /** 附图（openarc-asset / data / https），只发给能看图的模型 */ images?: string[] }, onDelta: (full: string) => void, signal: AbortSignal): Promise<string>;
  runAgentTask?(req: { goal: string; context: CanvasAgentContext }): Promise<{ ok: boolean; taskId?: string; status?: string; error?: string }>;
  defaultChatModel?(): Promise<string | null>;
  watchAgentTask?(taskId: string, onSnapshot: (snapshot: AgentTaskSnapshot) => void): () => void;
  cancelAgentTask?(taskId: string): Promise<{ ok: boolean; error?: string }>;
  /** 本地文件 / data URL 存进资源库，返回画布里可保存的地址（openarc-asset:… 或原地址） */
  importAsset(canvasId: string, dataUrl: string, name: string): Promise<string>;
  /** 模型返回的远程结果（https）下载进资源库，返回 openarc-asset 引用；失败时原样返回 url */
  importRemote?(canvasId: string, url: string, name: string): Promise<string>;
  /** openarc-asset:… → 可显示的地址 */
  resolveAsset(ref: string): Promise<string | null>;
  /** openarc-asset:…（视频 / 音频）→ 可边播边拖的流式地址；拿不到时 null，调用方退回 resolveAsset */
  mediaUrl?(ref: string): Promise<{ url: string; expiresAt: number } | null>;
  /** 视频智能切镜：返回各镜头区间（秒）；没有 ffmpeg 等失败时 ok:false */
  /** 文档（docx / xlsx / txt / md…）抽成文本；没有时只读纯文本类文件 */
  extractDocument?(dataUrl: string, name: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string; detail?: string }>;
  detectScenes?(dataUrl: string): Promise<{ ok: true; duration: number; shots: VideoSegment[]; /** 镜头太多，最后一段包含剩余部分 */ capped?: boolean } | { ok: false; error: string; detail?: string }>;
  /** 按区间真裁剪视频并存进资源库（每段一个引用）；没有 ffmpeg 等失败时 ok:false */
  clipVideo?(canvasId: string, dataUrl: string, segments: VideoSegment[], name: string): Promise<{ ok: boolean; clips: Array<{ ref?: string; duration?: number; inSec?: number; outSec?: number; error?: string }>; error?: string; /** 超过一次能裁的段数而没裁的段 */ dropped?: number }>;
}
