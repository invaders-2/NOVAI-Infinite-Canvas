import { hostRoot } from "../../../novaiBridgeRoot";
import { useSyncExternalStore } from "react";
import { newCard, parseQuestions } from "./qa";

export type ToolStep = { label: string; state: "wait" | "run" | "done" | "skip" | "error"; secs?: string };
export type AgentMsg = {
  id: string;
  role: "u" | "a";
  text: string;
  at?: number;
  html?: boolean;
  streaming?: boolean;
  skill?: string;
  ctx?: Array<{ id: string; title: string; kind: string; src?: string }>;
  think?: { live: boolean; open: boolean; secs: string; lines: string[] };
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
  /** 生成结果的自动审查（后端 review 事件）：每批结果一张审查卡 */
  reviews?: import("./task").AgentReview[];
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

function historyMessage(raw: Record<string, any>, index: number): AgentMsg | null {
  const parsedQ = raw?.role === "assistant" ? parseQuestions(String(raw.text ?? raw.content ?? "")) : null;
  if (parsedQ) raw = { ...raw, text: parsedQ.rest || "开始之前想先确认几件事：", content: undefined, _qa: parsedQ.questions, _qaKind: parsedQ.kind };
  const role = raw?.role === "user" ? "u" : raw?.role === "assistant" ? "a" : null;
  if (!role) return null;
  const at = Number(raw.at || 0) * 1000;
  const msg: AgentMsg = { id: "h" + index + "_" + Math.round(at), role, text: String(raw.text ?? raw.content ?? ""), at: at || undefined };
  // 历史里的问答卡：先当已回答，最后一条在 markOpenQa 里放开
  if (Array.isArray(raw._qa)) msg.qa = { ...newCard("", raw._qa, raw._qaKind), status: "answered" };
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (steps.length) {
    msg.tools = steps.map((step: Record<string, any>) => ({
      label: String(step.tool || "步骤"),
      state: step.ok === false ? "error" as const : "done" as const,
      secs: step.duration_ms != null ? (Number(step.duration_ms) / 1000).toFixed(1) : undefined,
    }));
    msg.took = steps.reduce((sum: number, step: Record<string, any>) => sum + (Number(step.duration_ms) || 0), 0) / 1000;
  }
  return msg;
}

export class AgentState {
  msgs: AgentMsg[] = [];
  busy = false;
  stop = false;
  draft = "";
  skill: string | null = null;
  mode: "manual" | "auto" = "manual";
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
  /** 已加载的历史从线程里第几条开始；> 0 说明上面还有更早的消息，往上翻时按页补 */
  historyStart = 0;
  historyHasMore = false;
  loadingEarlier = false;
  /** 线程列表是否已经拿到过（restoreHistory 就不再重复拉一次） */
  private threadsReady = false;

  constructor(public canvasId: string) {
    this.mode = read("canvas-next:agent:mode", "manual");
    this.bindIdentity();
  }
  subscribe = (l: () => void) => { this.ls.add(l); return () => { this.ls.delete(l); }; };
  version = () => this.v;
  emit() { this.v++; this.ls.forEach((l) => l()); }
  dispose() { this.generation++; this.identityOff?.(); }

  private bindIdentity() {
    const identity = bridge<{ onEvent?: (cb: (event: any) => void) => () => void }>("identity");
    if (!identity?.onEvent) { void this.loadAll(); return; }
    this.identityOff = identity.onEvent((event) => {
      const snapshot = event?.snapshot || event?.payload?.snapshot || {};
      const next = String(snapshot.userId || snapshot.sessionRef || "");
      if (next === this.account) return;
      this.account = next;
      this.generation++;
      this.memUser = []; this.memCanvas = []; this.threads = []; this.activeThreadId = "";
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

  async addMemory(scope: "user" | "canvas", text: string) {
    const command = resourceCommand(); if (!command) throw new Error("当前环境没有记忆资源服务");
    const content = text.trim(); if (!content) return;
    const result = await command({ type: "resource/create", resourceType: "memory", name: content.slice(0, 80), content, memorySubtype: scope === "canvas" ? "project-memory" : "personal-preference", attributes: { scope, canvasId: scope === "canvas" ? this.canvasId : null } });
    if (!result?.ok) throw new Error(String(result?.error || "记忆保存失败"));
    await this.loadMemories();
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
        if (activeId) this.activeThreadId = activeId;
        this.emit(); return true;
      } catch { return false; }
    })();
    this.threadsLoading = loading;
    loading.finally(() => { if (this.threadsLoading === loading) this.threadsLoading = null; });
    return loading;
  }

  /** 拉一条线程的消息，整体替换当前对话（后端按时间正序给 user / assistant） */
  async loadThreadMessages(threadId: string, generation = this.generation) {
    const id = String(threadId || ""); if (!id) return false;
    try {
      const result = await this.threadCommand("thread/messages", { threadId: id, limit: 60 });
      if (!result?.ok || !Array.isArray(result.messages)) return false;
      if (generation !== this.generation) return true;
      const start = Number(result.start) || 0;
      this.msgs = result.messages.map((raw: Record<string, any>, i: number) => historyMessage(raw, start + i)).filter((msg: AgentMsg | null): msg is AgentMsg => !!msg);
      markOpenQa(this.msgs);
      this.historyStart = start;
      // 老服务端没有 start：退回 has_more 判断（那种情况下也拿不到更早的页，只是不报错）
      this.historyHasMore = start > 0 && result.has_more !== false;
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
      this.msgs = [...older, ...this.msgs];
      this.historyStart = start;
      this.historyHasMore = start > 0;
      return older.length;
    } catch { return 0; } finally { this.loadingEarlier = false; this.emit(); }
  }

  /** 切到另一条线程：先让后端记住 active（之后的对话都落过去），再换消息 */
  async switchThread(threadId: string) {
    const id = String(threadId || ""); if (!id) return false;
    if (id === this.activeThreadId && this.msgs.length) return true;
    const switched = await this.threadCommand("thread/switch", { threadId: id });
    if (!switched?.ok) { this.businessError = String(switched?.error || "切换对话失败"); this.emit(); return false; }
    this.activeThreadId = id; this.businessError = "";
    const loaded = await this.loadThreadMessages(id);
    if (!loaded) { this.businessError = "这条对话的消息读取失败"; this.emit(); }
    return loaded;
  }

  /** 新建空线程并切过去（旧线程留在后端，菜单里还能切回来） */
  async newThread() {
    if (!taskCommand()) return false;
    this.businessError = "";
    const created = await this.threadCommand("thread/new");
    const id = String(created?.thread?.id || "");
    if (!created?.ok || !id) { this.businessError = String(created?.error || "新建对话失败"); this.emit(); return false; }
    this.msgs = []; this.lockedModel = null; this.activeThreadId = id; this.historyStart = 0; this.historyHasMore = false;
    await this.loadThreads();
    this.emit(); return true;
  }

  /** 发送前确保有线程可写（第一次用这张画布时建「对话 1」） */
  async ensureThread(): Promise<string> {
    if (this.activeThreadId) return this.activeThreadId;
    if (!taskCommand()) return "";
    const created = await this.threadCommand("thread/new");
    const id = String(created?.thread?.id || "");
    if (created?.ok && id) { this.activeThreadId = id; await this.loadThreads(); }
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
    await this.loadThreadMessages(this.activeThreadId, generation);
  }

  setMode(m: "manual" | "auto") { this.mode = m; write("canvas-next:agent:mode", m); this.emit(); }
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
