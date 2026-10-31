import { useSyncExternalStore } from "react";

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
  task?: { taskId: string; status: string; modelConfigId?: string | null; stopRequested?: boolean };
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

type Command = (request: Record<string, unknown>) => Promise<Record<string, any>>;
type SkillCommand = (request: { command: string; payload: Record<string, unknown> }) => Promise<Record<string, any>>;
const bridge = <T,>(name: string): T | undefined => (window as unknown as { openarc?: Record<string, unknown> }).openarc?.[name] as T | undefined;
const resourceCommand = (): Command | null => bridge<{ command?: Command }>("resource")?.command || null;
const taskCommand = (): Command | null => bridge<{ command?: Command }>("task")?.command || null;
const skillCommand = (): SkillCommand | null => bridge<{ command?: SkillCommand }>("skill")?.command || null;

const OFFICIAL: Array<[string, string, string]> = [
  ["头脑风暴", "基于我的核心创意，发展三个差异明显的故事方向", "头脑风暴"],
  ["电商套图", "产品图 + 产品信息 → 卖点文案 → 3 张海报", "卖点海报"], ["首帧视频", "选中的图片做首帧 / 首尾帧，出一条短片", "视频"],
  ["整理画布", "按上下游关系把节点排成列", "整理"], ["换背景", "保持产品不变，换一个场景", "换背景"],
  ["分镜脚本", "把一句创意拆成分镜表，并逐镜头生成画面", "分镜"], ["表格批量出图", "把需求拆成多维表格，再逐行批量出图", "表格"],
  ["提示词润色", "把口语描述改写成模型更容易理解的提示词", "润色"], ["多角度展示", "一张产品图扩成正 / 侧 / 背 / 俯 4 个角度", "多角度"],
  ["模特试戴", "把产品放到模特身上，保持产品细节", "模特"], ["小红书封面", "3:4 竖版封面 + 大字标题", "封面"],
];
const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n1. 读取已选节点和画布上的相关输入\n2. ${desc}\n3. 新建的节点标记为 Agent，连线顺序与输入一致\n4. 手动确认模式下先给出计划，确认后再调用生成`;
function read<T>(k: string, fb: T): T { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) as T : fb; } catch { return fb; } }
function write(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 仅设备 UI 偏好 */ } }
const officialSkills = () => OFFICIAL.map(([name, desc, kw]) => ({ name, desc, kw, src: "官方" as const, on: !read("canvas-next:skills:off", [] as string[]).includes(name), md: md(name, desc) }));

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
  refs: Array<{ id: string; kind: "app" | "asset"; title: string; ref: string }> = [];
  pinned: string[] = [];
  muted = new Set<string>();
  memOn: boolean = read("canvas-next:mem:on", true);
  memUser: MemoryRecord[] = [];
  memCanvas: MemoryRecord[] = [];
  skills: Skill[] = officialSkills();
  convs: Conv[] = [];
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
      this.memUser = []; this.memCanvas = []; this.convs = []; this.skills = officialSkills();
      this.businessError = ""; this.importState = ""; this.loading = true; this.emit();
      void this.loadAll();
    });
    void this.loadAll();
  }

  async loadAll() {
    const generation = this.generation;
    this.loading = true; this.businessError = ""; this.emit();
    const results = await Promise.all([this.loadMemories(generation), this.loadSkills(generation), this.loadConvs(generation)]);
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

  private async loadConvs(generation = this.generation) {
    const command = taskCommand(); if (!command) return false;
    try {
      const listed = await command({ command: "task/list", payload: {} });
      if (!listed?.ok || !Array.isArray(listed.items)) return false;
      const rows = await Promise.all(listed.items.slice(-30).reverse().map(async (task) => {
        const detail = await command({ command: "task/get", payload: { taskId: task.taskId } }).catch(() => null);
        if (!detail?.ok) return null;
        const input = detail.steps?.[0]?.input;
        if (input?.type !== "canvas.task.v1" || input.canvasId !== this.canvasId) return null;
        const answer = detail.artifacts?.at(-1)?.content;
        const msgs: AgentMsg[] = [{ id: "u_" + task.taskId, role: "u", text: String(detail.task.goal || ""), at: Number(detail.task.createdAt || 0) }];
        if (answer != null || detail.task.status) msgs.push({ id: "a_" + task.taskId, role: "a", text: answer == null ? String(detail.task.status || "") : typeof answer === "string" ? answer : JSON.stringify(answer), task: { taskId: task.taskId, status: String(detail.task.status || ""), modelConfigId: detail.task.modelConfigId || null }, at: Number(detail.task.updatedAt || 0) });
        return { id: task.taskId, title: String(detail.task.goal || "画布任务").slice(0, 24), msgs, at: Number(detail.task.updatedAt || 0) } as Conv;
      }));
      if (generation !== this.generation) return true;
      this.convs = rows.filter((row): row is Conv => !!row); this.emit(); return true;
    } catch { return false; }
  }
  saveConvs() { /* Task 已是权威；不复制到本地会话库。 */ }

  setMode(m: "manual" | "auto") { this.mode = m; write("canvas-next:agent:mode", m); this.emit(); }
  setEffort(e: "auto" | "low" | "high") { this.effort = e; write("canvas-next:agent:effort", e); this.emit(); }
  setThinking(t: ThinkingLevel) { this.thinking = normThinking(t); write("canvas-next:agent:thinking", this.thinking); this.emit(); }
  skillsOn() { return this.skills.filter((s) => s.on); }
  dismissHint() { this.hintOff = true; write("canvas-next:agent:hint-off", true); this.emit(); }
  archive() { /* 对话已经由 task/run 持久化；这里不另存副本。 */ }

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
