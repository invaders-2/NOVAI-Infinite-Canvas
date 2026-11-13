import { hostRoot } from "../../../novaiBridgeRoot";
import { useSyncExternalStore } from "react";
import { newCard, parseQuestions } from "./qa";

export type ToolStep = {
    label: string;
    state: "wait" | "run" | "done" | "skip" | "error";
    secs?: string;
    /** 事件里的 callId：联网搜索的结果卡靠它把同一次搜索的步骤行从「处理过程」里摘掉 */
    callId?: string;
    /** tool_call_delta 的「正在准备」占位行：step_start / step_result 到达后原地转正，不新增行 */
    provisional?: boolean;
    /** 工具名（占位行与正式行靠它对齐） */
    tool?: string;
};
export type AgentMsg = {
  id: string;
  role: "u" | "a";
  text: string;
  at?: number;
  html?: boolean;
  streaming?: boolean;
  skill?: string;
  /** 后端写入的主动消息（origin:"agent"）：面板上轻微标记，不抢镜 */
  origin?: "agent" | string;
  /** 下一步建议（done 事件 / 结论 message 带的 suggestions）：渲染成可点芯片 */
  suggestions?: string[];
  ctx?: Array<{ id: string; title: string; kind: string; src?: string }>;
  think?: { live: boolean; open: boolean; secs: string; lines: string[]; /** 与 lines 一一对应的 kind（reflect 会标「反思」） */ kinds?: string[] };
  /** 长任务心跳（heartbeat 事件）：运行中的一行轻量阶段提示；done/error 或开始逐字输出后不显示 */
  heartbeat?: { stage: string; elapsedMs: number; kind?: string };
  /** 完成前自检（self_check 事件）：只有后端发过才有；没通过时可展开看逐条未满足项 */
  selfCheck?: { round: number; passed: boolean; items: Array<{ text: string; ok: boolean; status?: string }> };
  tools?: ToolStep[];
  toolsOpen?: boolean;
  task?: { taskId: string; status: string; modelConfigId?: string | null; stopRequested?: boolean; plan?: import("../backend/types").AgentTaskPlan | null };
  results?: string[];
  acts?: string[];
  memSaved?: { scope: string; text: string };
  summary?: boolean;
  error?: string;
  fb?: "up" | "down";
  took?: number;
  procOpen?: boolean;
  /** 问答卡（TapNow：Agent 先问清楚，最多 4 个问题） */
  qa?: import("./qa").QaCard;
  skillInstall?: import("./skillInstallIntent").SkillInstallMessage;
  /** 联网搜图 / 反图的参考图选择卡（来自 tool.execution.succeeded 的 result.items） */
  webImages?: import("./webImages").WebImageCardData[];
  /** 联网搜索的结果卡（web_search 的 started / succeeded / failed 事件按 callId 归并） */
  webSearch?: import("./webSearch").WebSearchCardData[];
  /** 生成结果的自动审查（后端 review 事件）：每批结果一张审查卡 */
  reviews?: import("./task").AgentReview[];
  /** 后端每一轮的真实上下文占用（context_usage，NOVAI_AGENT_V2_CONTEXT 开启时才有）：面板据此显示分层 */
  usage?: import("./contextUsage").AgentContextUsage;
  /** 后端整理过上下文（context_compacted）：消息流里出现一行提示，可淡出 */
  compactions?: import("./contextUsage").ContextCompaction[];
  /** 阶段三流式：原生推理全文（reasoning_delta 逐字累加），显示在思考折叠区里 */
  reasoning?: string;
};
export type ThinkingLevel = "off" | "light" | "standard" | "heavy";
export const THINKING: Array<[ThinkingLevel, string, string]> = [
  ["off", "关闭", "直接回答和执行，最快"],
  ["light", "轻度", "简单想一下再动手"],
  ["standard", "标准", "先规划步骤，信息不够时先问你"],
  ["heavy", "深度", "充分推敲方案和风险，适合复杂任务，耗时更长"],
];
export const normThinking = (v: unknown): ThinkingLevel => (v === "off" || v === "light" || v === "heavy" ? v : "standard");
export type Skill = { id?: string; name: string; desc: string; kw: string; src: "官方" | "我的"; on: boolean; md: string };
export type MemoryRecord = { resourceRef: string; text: string; scope: "user" | "canvas"; canvasId: string | null };
export type Conv = { id: string; title: string; msgs: AgentMsg[]; at: number };
/** 后端线程（NOVAI /api/agent/threads）：只带元信息，正文按 id 另拉 */
export type ThreadRow = { id: string; title: string; count: number; at: number };

type QueuedMsg = import("./queue").QueuedMsg;
/** 一条对话自己的本地状态：切对话只换这份，不互相覆盖 */
type ThreadLocal = {
  msgs: AgentMsg[];
  /** L5：本地消息版本号。历史加载在飞时用户又发了消息 → 版本变了，回来时不能整段覆盖本地消息 */
  rev: number;
  busy: boolean;
  stop: boolean;
  historyStart: number;
  historyHasMore: boolean;
  /** 本地是否已有这轮对话的完整近页（切回来直接用缓存，不再拿服务端历史覆盖后台任务消息） */
  loaded: boolean;
  /** 待发送队列与「立即发送」跟着对话走：切走再切回来还在 */
  queue: QueuedMsg[];
  pendingUrgent: QueuedMsg | null;
  /** 输入框草稿也按对话存：切到别的对话不该把没发出去的话带过去 */
  draft: string;
};
/** 还没建后端线程时的本地桶：ensureThread 会把这里的状态迁到新线程 id */
const NEW_THREAD = "__new__";

type Command = (request: Record<string, unknown>) => Promise<Record<string, any>>;
type SkillCommand = (request: { command: string; payload: Record<string, unknown> }) => Promise<Record<string, any>>;
const bridge = <T,>(name: string): T | undefined => hostRoot<Record<string, unknown>>()?.[name] as T | undefined;
const resourceCommand = (): Command | null => bridge<{ command?: Command }>("resource")?.command || null;
const taskCommand = (): Command | null => bridge<{ command?: Command }>("task")?.command || null;
const skillCommand = (): SkillCommand | null => bridge<{ command?: SkillCommand }>("skill")?.command || null;

function read<T>(k: string, fb: T): T { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) as T : fb; } catch { return fb; } }
function write(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 仅设备 UI 偏好 */ } }
const customSkills = () => read("canvas-next:skills:mine", [] as Skill[]).filter((skill) => skill.src === "我的");

/** 线程消息 → 面板消息：role u/a、文本、时间；有 steps 就折成工具步骤（没有就不铺） */
/** 历史对话里最后一条是助手的问答卡 = 还没回答，放开让用户接着答 */
function markOpenQa(msgs: AgentMsg[]) {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "a" && last.qa) last.qa = { ...last.qa, status: "open" };
}

export function historyMessage(raw: Record<string, any>, index: number): AgentMsg | null {
  const parsedQ = raw?.role === "assistant" ? parseQuestions(String(raw.text ?? raw.content ?? "")) : null;
  if (parsedQ) raw = { ...raw, text: parsedQ.rest || "开始之前想先确认几件事：", content: undefined, _qa: parsedQ.questions, _qaKind: parsedQ.kind, _qaRegen: parsedQ.regen };
  const role = raw?.role === "user" ? "u" : raw?.role === "assistant" ? "a" : null;
  if (!role) return null;
  const at = Number(raw.at || 0) * 1000;
  const msg: AgentMsg = { id: "h" + index + "_" + Math.round(at), role, text: String(raw.text ?? raw.content ?? ""), at: at || undefined };
  if (typeof raw.origin === "string" && raw.origin) msg.origin = raw.origin;
  if (Array.isArray(raw.suggestions)) msg.suggestions = raw.suggestions.map((item: unknown) => String(item || "").trim()).filter(Boolean).slice(0, 3);
  // 历史里的问答卡：先当已回答，最后一条在 markOpenQa 里放开
  if (Array.isArray(raw._qa)) msg.qa = { ...newCard("", raw._qa, raw._qaKind, raw._qaRegen), status: "answered" };
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (steps.length) {
    msg.tools = steps.map((step: Record<string, any>) => ({
      label: String(step.tool || "步骤"),
      state: step.ok === false ? "error" as const : "done" as const,
      secs: step.duration_ms != null ? (Number(step.duration_ms) / 1000).toFixed(1) : undefined,
    }));
    msg.took = steps.reduce((sum: number, step: Record<string, any>) => sum + (Number(step.duration_ms) || 0), 0) / 1000;
  }
  // K2：思考内容 / 自检结果 / 待确认方案 / 思考时长都随线程持久化过，刷新页面后按原样还原，
  // 不再变成「只剩一句话、思考了 0.0s、待生成卡片消失」。
  const savedTook = Number(raw.took);
  if (Number.isFinite(savedTook) && savedTook >= 0) msg.took = savedTook;
  const savedThink = raw.think && typeof raw.think === "object" ? raw.think as Record<string, any> : null;
  if (savedThink && Array.isArray(savedThink.lines) && savedThink.lines.length) {
    const lines = savedThink.lines.map((line: unknown) => String(line || "")).filter(Boolean);
    if (lines.length) {
      msg.think = {
        live: false,
        open: false,
        secs: String(savedThink.secs ?? (Number.isFinite(savedTook) ? savedTook.toFixed(1) : "0")),
        lines,
        kinds: Array.isArray(savedThink.kinds) ? savedThink.kinds.map((kind: unknown) => String(kind || "")) : undefined,
      };
    }
  }
  const savedCheck = raw.self_check && typeof raw.self_check === "object" ? raw.self_check as Record<string, any> : null;
  if (savedCheck && Array.isArray(savedCheck.items)) {
    const items = savedCheck.items
      .filter((item: any) => item && String(item.text || "").trim())
      .map((item: any) => ({ text: String(item.text || ""), ok: item.ok === true, status: typeof item.status === "string" ? item.status : undefined }));
    if (items.length) msg.selfCheck = { round: Number(savedCheck.round) || 0, passed: savedCheck.passed === true, items };
  }
  const savedPlan = raw.plan && typeof raw.plan === "object" ? raw.plan as Record<string, any> : null;
  if (savedPlan && Array.isArray(savedPlan.steps) && savedPlan.steps.length && String(raw.run_id || "").trim()) {
    // 已批准 / 已执行的方案不再给「执行」入口（后端批准时会把 plan 摘掉并记 plan_status）
    const approved = String(raw.plan_status || "") === "approved";
    msg.task = { taskId: String(raw.run_id), status: approved ? "COMPLETED" : "SUCCEEDED", plan: approved ? null : savedPlan as any };
  }
  return msg;
}

export class AgentState {
  /** 线程级本地状态：key = activeThreadId || "__new__"；不同对话的 msgs / busy / stop / 历史游标 / 队列 / 草稿各自独立 */
  private threadState = new Map<string, ThreadLocal>();
  skill: string | null = null;
  mode: "manual" | "auto" | "managed" = "manual";
  model = "Auto";
  effort: "auto" | "low" | "high" = read("canvas-next:agent:effort", "high");
  /** 思考强度（TapNow：关闭 / 轻度 / 标准 / 深度），随任务一起提交给运行时 */
  thinking: ThinkingLevel = normThinking(read("canvas-next:agent:thinking", "standard"));
  refs: Array<{ id: string; kind: "app" | "asset"; title: string; ref: string; detail?: string }> = [];
  pinned: string[] = [];
  muted = new Set<string>();
  memOn: boolean = read("canvas-next:mem:on", true);
  memUser: MemoryRecord[] = [];
  memCanvas: MemoryRecord[] = [];
  skills: Skill[] = customSkills();
  /** 本画布的对话线程（标题 / 条数 / 更新时间），菜单与「新建对话」用 */
  threads: ThreadRow[] = [];
  /** 当前对话线程 id；发送时带给后端，历史从这里读 */
  activeThreadId = "";
  prevOpen = false;
  lockedModel: string | null = null;
  hintOff: boolean = read("canvas-next:agent:hint-off", false);
  loading = true;
  businessError = "";
  importState = "";
  account = "";
  private generation = 0;
  private identityOff: (() => void) | null = null;
  private ls = new Set<() => void>();
  private v = 0;
  /** 历史只在首次挂载还原一次；之后切线程才会替换 msgs */
  private historyRestored = false;
  loadingEarlier = false;
  /** 线程列表是否已经拿到过（restoreHistory 就不再重复拉一次） */
  private threadsReady = false;

  constructor(public canvasId: string) {
    const savedMode: string = read<string>("canvas-next:agent:mode", "manual");
    this.mode = savedMode === "auto" || savedMode === "managed" ? savedMode : "manual";
    this.bindIdentity();
  }
  private currentKey() { return this.activeThreadId || NEW_THREAD; }
  private slot(threadId = this.currentKey()): ThreadLocal {
    let value = this.threadState.get(threadId);
    if (!value) {
      value = { msgs: [], rev: 0, busy: false, stop: false, historyStart: 0, historyHasMore: false, loaded: false, queue: [], pendingUrgent: null, draft: "" };
      this.threadState.set(threadId, value);
    }
    return value;
  }
  /** 当前对话的消息：切换对话就是另一份，后台任务不会写进别的对话 */
  get msgs(): AgentMsg[] { return this.slot().msgs; }
  set msgs(next: AgentMsg[]) { this.slot().msgs = next; }
  /** 当前对话是否在跑：同一对话内仍串行，不同对话互不阻塞 */
  get busy(): boolean { return this.slot().busy; }
  set busy(next: boolean) { this.slot().busy = next; }
  get stop(): boolean { return this.slot().stop; }
  set stop(next: boolean) { this.slot().stop = next; }
  /** 已加载的历史从线程里第几条开始；> 0 说明上面还有更早的消息，往上翻时按页补 */
  get historyStart(): number { return this.slot().historyStart; }
  set historyStart(next: number) { this.slot().historyStart = next; }
  get historyHasMore(): boolean { return this.slot().historyHasMore; }
  set historyHasMore(next: boolean) { this.slot().historyHasMore = next; }
  /** 当前对话的待发送队列（仅内存，不持久化；切换对话时各存各的，切回来还在） */
  get queue(): QueuedMsg[] { return this.slot().queue; }
  set queue(next: QueuedMsg[]) { this.slot().queue = next; }
  /** 「立即发送」在忙碌时等空闲的那一条：按对话存，切对话 / 新建对话只影响自己 */
  get pendingUrgent(): QueuedMsg | null { return this.slot().pendingUrgent; }
  set pendingUrgent(next: QueuedMsg | null) { this.slot().pendingUrgent = next; }
  /** 当前对话的输入框草稿：切换对话不会把没发出去的话带过去 */
  get draft(): string { return this.slot().draft; }
  set draft(next: string) { this.slot().draft = next; }
  /** 指定对话的消息（读别人的对话不改当前对话） */
  threadMessages(threadId: string) { return this.slot(threadId || NEW_THREAD).msgs; }
  /** 追加到发起时捕获的那条对话，即使期间已经切走也写回原对话 */
  appendMessage(msg: AgentMsg, threadId?: string) {
    const value = this.slot(threadId || this.currentKey());
    value.msgs = [...value.msgs, msg];
    value.rev += 1;
    return msg;
  }
  appendMessages(msgs: AgentMsg[], threadId?: string) {
    const value = this.slot(threadId || this.currentKey());
    value.msgs = [...value.msgs, ...msgs];
    value.rev += 1;
    return msgs;
  }
  /** 按消息对象找到它所属的对话，只刷新那一条：后台任务的实时进度不会串到当前对话 */
  patchMessage(msg: AgentMsg, patch: Partial<AgentMsg>) {
    Object.assign(msg, patch);
    for (const value of this.threadState.values()) {
      const index = value.msgs.indexOf(msg);
      if (index < 0) continue;
      value.msgs = [...value.msgs.slice(0, index), msg, ...value.msgs.slice(index + 1)];
      value.rev += 1;      // L5：运行中的实时更新也算本地改动，历史回来时不能被旧快照盖掉
      break;
    }
    this.emit();
  }
  /** 消息所属对话里它上一句用户消息（问答卡 / 重生成按各自对话取） */
  goalBefore(msg: AgentMsg) {
    for (const value of this.threadState.values()) {
      const index = value.msgs.indexOf(msg);
      if (index < 0) continue;
      return [...value.msgs.slice(0, index)].reverse().find((x) => x.role === "u")?.text || "";
    }
    return "";
  }
  setThreadBusy(threadId: string, busy: boolean) { this.slot(threadId || NEW_THREAD).busy = busy; }
  setThreadStop(threadId: string, stop: boolean) { this.slot(threadId || NEW_THREAD).stop = stop; }
  isThreadBusy(threadId: string) { return this.slot(threadId || NEW_THREAD).busy; }
  /** 目标对话的待发送队列：后台会话结束自动发送时按它取，不碰当前对话 */
  threadQueue(threadId: string) { return this.slot(threadId || NEW_THREAD).queue; }
  setThreadQueue(threadId: string, list: QueuedMsg[]) { this.slot(threadId || NEW_THREAD).queue = list; }
  threadPendingUrgent(threadId: string) { return this.slot(threadId || NEW_THREAD).pendingUrgent; }
  setThreadPendingUrgent(threadId: string, item: QueuedMsg | null) { this.slot(threadId || NEW_THREAD).pendingUrgent = item; }
  threadDraft(threadId: string) { return this.slot(threadId || NEW_THREAD).draft; }
  setThreadDraft(threadId: string, text: string) { this.slot(threadId || NEW_THREAD).draft = text; }
  /** 整体替换某条对话的消息（重新生成失败时撤回刚加的两条，只撤回原对话里的） */
  setThreadMessages(msgs: AgentMsg[], threadId?: string) {
    const value = this.slot(threadId || this.currentKey());
    value.msgs = msgs;
    value.rev += 1;
  }
  subscribe = (l: () => void) => { this.ls.add(l); return () => { this.ls.delete(l); }; };
  version = () => this.v;
  emit() { this.v++; this.ls.forEach((l) => l()); }
  dispose() { this.generation++; this.identityOff?.(); this.threadState.clear(); this.activeThreadId = ""; }

  private bindIdentity() {
    const identity = bridge<{ onEvent?: (cb: (event: any) => void) => () => void }>("identity");
    if (!identity?.onEvent) { void this.loadAll(); return; }
    this.identityOff = identity.onEvent((event) => {
      const snapshot = event?.snapshot || event?.payload?.snapshot || {};
      const next = String(snapshot.userId || snapshot.sessionRef || "");
      if (next === this.account) return;
      this.account = next;
      this.generation++;
      this.memUser = []; this.memCanvas = []; this.threads = []; this.activeThreadId = ""; this.threadState.clear();
      this.threadsReady = false; this.threadsLoading = null; this.historyRestored = false; this.skills = customSkills();
      this.businessError = ""; this.importState = ""; this.loading = true; this.emit();
      void this.loadAll();
    });
    void this.loadAll();
  }

  async loadAll() {
    const generation = this.generation;
    this.loading = true; this.businessError = ""; this.emit();
    const results = await Promise.all([this.loadMemories(generation), this.loadSkills(generation), this.loadThreads(generation)]);
    if (generation !== this.generation) return;
    this.loading = false;
    if (results.some((ok) => !ok) && (resourceCommand() || taskCommand() || skillCommand())) this.businessError = "部分账号数据暂时无法读取，请稍后重试";
    this.emit();
  }

  private async loadMemories(generation = this.generation) {
    const command = resourceCommand(); if (!command) return false;
    try {
      const result = await command({ type: "resource/query", filter: { resourceType: "memory" }, limit: 100 });
      if (!result?.ok || !Array.isArray(result.items)) return false;
      const rows = await Promise.all(result.items.map(async (item) => {
        const resourceRef = String(item.resourceRef || item.resourceId || "");
        const read = await command({ type: "resource/readText", resourceRef }).catch(() => null);
        if (!read?.ok || typeof read.text !== "string") return null;
        const scope = item.memorySubtype === "project-memory" ? "canvas" : "user";
        return { resourceRef, text: read.text, scope, canvasId: scope === "canvas" ? String(item.attributes?.canvasId || "") || null : null } as MemoryRecord;
      }));
      if (generation !== this.generation) return true;
      const valid = rows.filter((row): row is MemoryRecord => !!row);
      this.memUser = valid.filter((row) => row.scope === "user");
      this.memCanvas = valid.filter((row) => row.scope === "canvas" && row.canvasId === this.canvasId);
      this.emit(); return true;
    } catch { return false; }
  }

  /** 写一条长期记忆。L1：面板里「记住：…」也走这里——带 threadId / userText 时后端会把这条
   *  并进画布记忆（索引 + 项目档案 prefs，同一处去重）并把这一轮对话写进线程；
   *  返回 { deduplicated, reply }：reply 是服务端存进线程的那句回复，面板要显示同一句。 */
  async addMemory(scope: "user" | "canvas", text: string, extra?: { threadId?: string; userText?: string }) {
    const command = resourceCommand(); if (!command) throw new Error("当前环境没有记忆资源服务");
    const content = text.trim(); if (!content) return { deduplicated: false, reply: "" };
    const result = await command({ type: "resource/create", resourceType: "memory", name: content.slice(0, 80), content, memorySubtype: scope === "canvas" ? "project-memory" : "personal-preference", attributes: { scope, canvasId: this.canvasId, threadId: extra?.threadId || "", userText: extra?.userText || "" } });
    if (!result?.ok) throw new Error(String(result?.error || "记忆保存失败"));
    await this.loadMemories();
    return { deduplicated: result.deduplicated === true, reply: String(result.reply || "") };
  }

  async deleteMemory(record: MemoryRecord) {
    const command = resourceCommand(); if (!command) throw new Error("当前环境没有记忆资源服务");
    const result = await command({ type: "resource/delete", resourceRef: record.resourceRef });
    if (!result?.ok) throw new Error(String(result?.error || "记忆删除失败"));
    await this.loadMemories();
  }
  saveMem() { write("canvas-next:mem:on", this.memOn); this.emit(); }
  memory() { return this.memOn ? [...this.memUser, ...this.memCanvas].map((row) => row.text) : []; }

  async loadSkills(generation = this.generation) {
    const command = skillCommand(); if (!command) return false;
    try {
      const result = await command({ command: "skill/list", payload: {} });
      if (!result?.ok) return false;
      const value = result.value && typeof result.value === "object" ? result.value : result;
      const rows = Array.isArray(value.items) ? value.items : Array.isArray(value.skills) ? value.skills : [];
      const available = rows.filter((s: Record<string, any>) => s.visibleInApp !== false && (s.builtin !== true || s.origin === "official")).map((s: Record<string, any>) => ({
        id: String(s.id), name: String(s.name || s.id), desc: String(s.description || ""), kw: String(s.id),
        src: s.builtin === true || s.origin === "official" ? "官方" as const : "我的" as const, on: s.enabled !== false,
        md: String(s.source?.instructions || s.systemPrompt || s.description || ""),
      }));
      if (generation !== this.generation) return true;
      this.skills = available; this.emit(); return true;
    } catch { return false; }
  }

  async saveSkills(changed?: Skill, definition = false) {
    this.emit();
    if (!changed) return false;
    const command = skillCommand();
    if (!command) {
      if (changed.src === "官方") { write("canvas-next:skills:off", this.skills.filter((s) => s.src === "官方" && !s.on).map((s) => s.name)); return true; }
      dispatchEvent(new CustomEvent("cn:skill-sync-error", { detail: "技能服务不可用" }));
      return false;
    }
    const id = changed.id || "skill_" + Date.now().toString(36); changed.id = id;
    const request = definition && changed.src === "我的"
      ? { command: "skill/save", payload: { skill: { id, name: changed.name, description: changed.desc, systemPrompt: changed.md } } }
      : { command: changed.on ? "skill/enable" : "skill/disable", payload: { skillId: id } };
    try {
      const result = await command(request);
      if (!result?.ok) {
        dispatchEvent(new CustomEvent("cn:skill-sync-error", { detail: String(result?.error || "技能保存失败") }));
        return false;
      }
      await this.loadSkills();
      return true;
    } catch { dispatchEvent(new CustomEvent("cn:skill-sync-error", { detail: "技能保存失败" })); return false; }
  }

  /** 线程命令统一入口：canvasId 由状态带上，其他参数按命令补 */
  private threadCommand(type: string, payload: Record<string, unknown> = {}) {
    const command = taskCommand(); if (!command) return Promise.resolve(null);
    return command({ type, payload: { canvasId: this.canvasId, ...payload } }).catch(() => null);
  }
  /** 列表只在真正需要时拉：loadAll 与 restoreHistory 共用同一次请求，避免两条 list 互相覆盖 */
  private threadsLoading: Promise<boolean> | null = null;
  /** 当前环境有没有后端线程（纯 NOVAI / 模拟环境没有，退回本地行为） */
  threadsSupported() { return !!taskCommand(); }

  async loadThreads(generation = this.generation) {
    if (!taskCommand()) return false;
    if (this.threadsLoading) return this.threadsLoading;
    const loading = (async () => {
      try {
        const listed = await this.threadCommand("thread/list");
        if (!listed?.ok || !Array.isArray(listed.threads)) return false;
        const rows: ThreadRow[] = listed.threads.map((row: Record<string, any>) => ({
          id: String(row.id || ""),
          title: String(row.title || "对话"),
          count: Number(row.message_count) || 0,
          at: Number(row.updated_at || row.created_at || 0) * 1000,
        })).filter((row: ThreadRow) => !!row.id);
        const activeId = String(listed.active_id || rows[0]?.id || "");
        if (generation !== this.generation) return true;
        this.threads = rows;
        this.threadsReady = true;
        // 后台任务结束会顺带刷新列表：已经选中的对话不能被服务端 active_id 劫走
        if (activeId && (!this.activeThreadId || !rows.some((row) => row.id === this.activeThreadId))) this.activeThreadId = activeId;
        this.emit(); return true;
      } catch { return false; }
    })();
    this.threadsLoading = loading;
    loading.finally(() => { if (this.threadsLoading === loading) this.threadsLoading = null; });
    return loading;
  }

  /** 拉一条线程的消息，整体替换当前对话（后端按时间正序给 user / assistant）。

   *  L5：请求在飞的时候用户可能刚发第一条消息（新画布 2–3 秒内发很常见）。回来时如果本地
   *  消息版本变了，就不能整段覆盖——否则用户消息 + 「正在思考」会被空历史冲掉，回复也挂不上。
   *  这时把服务端历史接在前面、本地新消息接在后面（按 role+文本去重，避免同一条出现两遍）。 */
  async loadThreadMessages(threadId: string, generation = this.generation) {
    const id = String(threadId || ""); if (!id) return false;
    try {
      const revBefore = this.slot(id).rev;
      const result = await this.threadCommand("thread/messages", { threadId: id, limit: 60 });
      if (!result?.ok || !Array.isArray(result.messages)) return false;
      if (generation !== this.generation) return true;
      const start = Number(result.start) || 0;
      const value = this.slot(id);
      const loaded = result.messages.map((raw: Record<string, any>, i: number) => historyMessage(raw, start + i)).filter((msg: AgentMsg | null): msg is AgentMsg => !!msg);
      if (value.rev !== revBefore && value.msgs.length) {
        const key = (m: AgentMsg) => m.role + "\u0000" + String(m.text || "").trim();
        const known = new Set(loaded.map(key));
        value.msgs = [...loaded, ...value.msgs.filter((m) => !known.has(key(m)))];
      } else {
        value.msgs = loaded;
      }
      markOpenQa(value.msgs);
      value.historyStart = start;
      // 老服务端没有 start：退回 has_more 判断（那种情况下也拿不到更早的页，只是不报错）
      value.historyHasMore = start > 0 && result.has_more !== false;
      value.loaded = true;
      this.emit(); return true;
    } catch { return false; }
  }

  /** 往上翻到顶：再拉更早的一页，插到最前面；返回加载了几条 */
  async loadEarlier(): Promise<number> {
    if (!this.historyHasMore || this.loadingEarlier || !this.activeThreadId) return 0;
    const generation = this.generation; const threadId = this.activeThreadId;
    this.loadingEarlier = true; this.emit();
    try {
      const result = await this.threadCommand("thread/messages", { threadId, limit: 60, before: this.historyStart });
      if (!result?.ok || !Array.isArray(result.messages) || generation !== this.generation || threadId !== this.activeThreadId) return 0;
      const start = Number(result.start) || 0;
      const older = result.messages.map((raw: Record<string, any>, i: number) => historyMessage(raw, start + i)).filter((msg: AgentMsg | null): msg is AgentMsg => !!msg);
      const value = this.slot(threadId);
      value.msgs = [...older, ...value.msgs];
      value.historyStart = start;
      value.historyHasMore = start > 0;
      return older.length;
    } catch { return 0; } finally { this.loadingEarlier = false; this.emit(); }
  }

  /** 切到另一条线程：先让后端记住 active（之后的对话都落过去），再换消息。
   *  本地已加载过的对话直接用缓存：后台任务还在跑，不能被服务端历史覆盖掉。 */
  async switchThread(threadId: string) {
    const id = String(threadId || ""); if (!id) return false;
    if (id === this.activeThreadId && this.slot(id).loaded) return true;
    const switched = await this.threadCommand("thread/switch", { threadId: id });
    if (!switched?.ok) { this.businessError = String(switched?.error || "切换对话失败"); this.emit(); return false; }
    // 队列 / 立即发送 / 草稿都按对话存：切过去只换一份，不丢也不串
    this.activeThreadId = id; this.businessError = "";
    if (this.slot(id).loaded) { this.emit(); return true; }
    const loaded = await this.loadThreadMessages(id);
    if (!loaded) { this.businessError = "这条对话的消息读取失败"; this.emit(); }
    return loaded;
  }

  /** 新建空线程并切过去（旧线程留在后端和本地，菜单里还能切回来，跑着的任务不受影响） */
  async newThread() {
    if (!taskCommand()) return false;
    this.businessError = "";
    const created = await this.threadCommand("thread/new");
    const id = String(created?.thread?.id || "");
    if (!created?.ok || !id) { this.businessError = String(created?.error || "新建对话失败"); this.emit(); return false; }
    const value = this.slot(id);
    value.msgs = []; value.busy = false; value.stop = false; value.historyStart = 0; value.historyHasMore = false; value.loaded = true;
    value.queue = []; value.pendingUrgent = null; value.draft = "";
    this.lockedModel = null; this.activeThreadId = id;
    await this.loadThreads();
    this.emit(); return true;
  }

  /** 发送前确保有线程可写（第一次用这张画布时建「对话 1」）：把 "__new__" 的本地状态整体迁过去，消息不丢 */
  async ensureThread(): Promise<string> {
    if (this.activeThreadId) return this.activeThreadId;
    if (!taskCommand()) return "";
    const created = await this.threadCommand("thread/new");
    const id = String(created?.thread?.id || "");
    if (created?.ok && id) {
      const pending = this.threadState.get(NEW_THREAD);
      this.threadState.delete(NEW_THREAD);
      const value = this.slot(id);
      if (pending) {
        value.msgs = [...pending.msgs, ...value.msgs];
        value.busy = pending.busy || value.busy;
        value.stop = pending.stop;
        value.historyStart = pending.historyStart;
        value.historyHasMore = pending.historyHasMore;
        value.queue = [...pending.queue, ...value.queue];
        value.pendingUrgent = pending.pendingUrgent || value.pendingUrgent;
        value.draft = pending.draft || value.draft;
      }
      value.loaded = true;
      this.activeThreadId = id;
      await this.loadThreads();
      this.emit();
    }
    return id;
  }

  /** 首次挂载还原历史：线程列表 + 当前线程消息；已有实时消息就不覆盖（切线程才替换） */
  async restoreHistory() {
    if (this.historyRestored) return;
    this.historyRestored = true;
    const generation = this.generation;
    const listed = this.threadsReady ? true : await this.loadThreads(generation);
    if (!listed) { this.historyRestored = false; return; }
    if (generation !== this.generation || this.msgs.length || !this.activeThreadId) return;
    if (this.slot(this.activeThreadId).loaded) return;
    await this.loadThreadMessages(this.activeThreadId, generation);
  }

  setMode(m: "manual" | "auto" | "managed") { this.mode = m; write("canvas-next:agent:mode", m); this.emit(); }
  setEffort(e: "auto" | "low" | "high") { this.effort = e; write("canvas-next:agent:effort", e); this.emit(); }
  setThinking(t: ThinkingLevel) { this.thinking = normThinking(t); write("canvas-next:agent:thinking", this.thinking); this.emit(); }
  skillsOn() { return this.skills.filter((s) => s.on); }
  dismissHint() { this.hintOff = true; write("canvas-next:agent:hint-off", true); this.emit(); }
  archive() { /* 对话由后端线程持久化（run 时追加），本地不另存副本。 */ }

  async importLegacy() {
    const generation = this.generation;
    this.importState = "正在导入旧版本机数据…"; this.emit();
    const ensureCurrent = () => { if (generation !== this.generation) throw new Error("账号已切换，本次导入已停止"); };
    try {
      const userFacts = read("canvas-next:mem:user", [] as string[]);
      const canvasFacts = read("canvas-next:mem:canvas:" + this.canvasId, [] as string[]);
      const known = new Set([...this.memUser, ...this.memCanvas].map((row) => row.text));
      const scopes: Array<["user" | "canvas", string[]]> = [["user", userFacts], ["canvas", canvasFacts]];
      for (const [scope, facts] of scopes) for (const fact of facts) {
        ensureCurrent();
        if (!known.has(fact)) { await this.addMemory(scope, fact); known.add(fact); }
      }
      const mine = read("canvas-next:skills:mine", [] as Skill[]);
      for (const skill of mine) {
        ensureCurrent();
        const id = skill.id || "skill_" + Array.from(skill.name).map((c) => /[a-z0-9_]/.test(c) ? c : "_").join("").replace(/^_+|_+$/g, "");
        if (!await this.saveSkills({ ...skill, id, src: "我的", on: true }, true)) throw new Error("Skill 导入失败");
      }
      const convs = read("canvas-next:convs:" + this.canvasId, [] as Conv[]);
      ensureCurrent();
      if (convs.length) {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ canvasId: this.canvasId, conversations: convs }, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "canvas-" + this.canvasId + "-legacy-conversations.json"; link.click(); URL.revokeObjectURL(url);
      }
      write("canvas-next:legacy-imported:" + this.account, true);
      this.importState = `已导入 ${userFacts.length + canvasFacts.length} 条记忆、${mine.length} 个 Skill；${convs.length ? "旧对话已导出（不伪造为已执行 Task）" : "没有旧对话需要导出"}。旧数据未删除。`;
    } catch (error) {
      if (generation === this.generation) this.importState = "导入未完成：" + (error instanceof Error ? error.message : "未知错误") + "。旧数据及已导入数据均保留，可重试。";
    }
    await this.loadAll();
    if (generation === this.generation) this.emit();
  }
}

export function useAgent(a: AgentState) { useSyncExternalStore(a.subscribe, a.version); return a; }
