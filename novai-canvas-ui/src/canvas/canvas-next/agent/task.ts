import type { AgentTaskPlan, AgentTaskSnapshot, CanvasBackend } from "../backend/types";
import type { ToolStep } from "./state";

export const TASK_PERSISTENT_TERMINAL = new Set(["SUCCEEDED", "COMPLETED", "FAILED", "CANCELLED", "STOPPED"]);
export const TASK_UI_SETTLED = new Set([...TASK_PERSISTENT_TERMINAL, "BLOCKED"]);

export function taskStatusText(status: string): string {
  return ({
    PENDING: "排队中", RUNNING: "执行中", WAITING: "等待你的批准", BLOCKED: "已阻塞",
    STOPPING: "停止中", CANCELLED: "已停止", STOPPED: "已停止", FAILED: "失败",
    SUCCEEDED: "已完成", COMPLETED: "已完成",
  } as Record<string, string>)[status] || status || "等待任务状态";
}

/** 这次任务里还没执行、等用户点「执行」的方案；没有就是 null（快照字段优先，老服务端退回读事件） */
export function taskPendingPlan(snapshot: AgentTaskSnapshot): AgentTaskPlan | null {
  const direct = snapshot.plan;
  if (direct && Array.isArray(direct.steps) && direct.steps.length) return direct;
  for (const event of [...snapshot.events].reverse()) {
    if (String(event.eventType || "") !== "harness.tool_proposed") continue;
    const plan = event.safePayload && typeof event.safePayload === "object" ? event.safePayload.plan : null;
    if (plan && Array.isArray(plan.steps) && plan.steps.length && plan.requires_confirmation === true) return plan as AgentTaskPlan;
  }
  return null;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

/** 阶段三流式：原生推理逐字（reasoning_delta，开关 NOVAI_AGENT_V2_STREAM 才发） */
export function taskReasoning(snapshot: AgentTaskSnapshot): string {
  let out = "";
  for (const event of snapshot.events) {
    if (String(event.eventType || "") !== "reasoning_delta") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    out += textOf(payload.text);
  }
  return out;
}

/** 决策 JSON 的字段：JSON 模式每轮的正文其实是这种对象，不能当「回复」显示给用户 */
const DECISION_KEYS = ["thought", "intent", "steps", "roadmap", "done", "message", "questions", "confirm", "expected_output", "reason", "assumptions", "plan"];
const DECISION_PREFIX = new RegExp('^\\{\\s*"(' + DECISION_KEYS.join("|") + ')"\\s*:');

/**
 * 这段文字像不像「模型决策 JSON」：JSON 模式下第 1 轮正文就是 {"thought":...,"steps":[...]}。
 * 流式途中 JSON 还没收尾，按前缀判断；完整 JSON 再解析出决策键兜底。
 * 正常回复不会以 { 开头；万一用户让模型输出 JSON 代码，流式时先不显示、等最终 message 也不会有错。
 */
export function looksLikeDecisionJson(text: string): boolean {
  const body = String(text || "").trim();
  if (!body.startsWith("{")) return false;
  if (/^\{\s*$/.test(body)) return true;                 // 流式才发出一个 "{"：先别当正文
  if (DECISION_PREFIX.test(body)) return true;
  try {
    const row = JSON.parse(body);
    return !!row && typeof row === "object" && !Array.isArray(row) && DECISION_KEYS.some((key) => key in row);
  } catch { return false; }
}

/**
 * 阶段三流式：回复正文逐字（message_delta）。平台不支持流式时整段一次性来，这里同样成立（只是只有一段）。
 * 只取「最后一个 round_start 之后」的增量：JSON 模式前面几轮的正文是决策 JSON，不是给用户看的回复。
 * 双保险：即便后端还在 JSON 模式里发 message_delta，拼出来像决策 JSON 也返回空（等最终 message）。
 */
export function taskMessageStream(snapshot: AgentTaskSnapshot): string {
  let from = 0;
  snapshot.events.forEach((event, index) => {
    if (String(event.eventType || "") === "round_start") from = index + 1;
  });
  let out = "";
  for (let i = from; i < snapshot.events.length; i += 1) {
    const event = snapshot.events[i];
    if (String(event.eventType || "") !== "message_delta") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    out += textOf(payload.text);
  }
  return looksLikeDecisionJson(out) ? "" : out;
}

export function taskToolSteps(snapshot: AgentTaskSnapshot): ToolStep[] {
  const steps: ToolStep[] = [];
  const byCall = new Map<string, ToolStep>();
  for (const event of snapshot.events) {
    const type = String(event.eventType || "");
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    // 阶段三流式：工具还在准备的占位行（先给一句「正在准备：…」，step_start 到达后原地转正，不新增行）
    if (type === "tool_call_delta") {
      const tool = textOf(payload.tool);
      const description = textOf(payload.description) || tool || "工具";
      const key = "delta:" + (textOf(payload.id) || steps.length);
      let row = byCall.get(key);
      if (!row) {
        row = { label: "正在准备：" + description, state: "run", callId: key, tool, provisional: true };
        byCall.set(key, row);
        steps.push(row);
      } else {
        row.label = "正在准备：" + description;
        row.tool = tool || row.tool;
      }
      continue;
    }
    if (!/^tool\.|^harness\.tool_proposed$/.test(type)) continue;
    // 自动执行时每轮的「本轮计划」只是过程记录，不是等你批准的步骤：不进步骤列表（待确认的方案有自己的卡片）
    if (type === "harness.tool_proposed" && !(payload.plan && payload.plan.requires_confirmation === true)) continue;
    const callId = String(payload.callId || payload.toolCallId || event.eventId || steps.length);
    // 给用户看「对哪个节点做什么」的描述，没有才退回工具名
    const name = String(payload.description || payload.toolId || payload.name || "NOVAI 工具");
    const tool = textOf(payload.toolId || payload.tool);
    let step = byCall.get(callId);
    if (!step) {
      // 优先把这个工具之前那条「正在准备」行转正：沿用原来的位置，不新增行、不跳行
      step = steps.find((row) => row.provisional && (!tool || !row.tool || row.tool === tool));
      if (step) {
        if (step.callId) byCall.delete(step.callId);
        step.callId = callId;
        step.label = name;
        step.tool = tool || step.tool;
        step.provisional = false;
        byCall.set(callId, step);
      } else {
        step = { label: name, state: "wait", callId };
        byCall.set(callId, step);
        steps.push(step);
      }
    }
    if (/waiting_approval|approval_required/.test(type)) step.state = "wait";
    else if (/execution_started|execution\.started|verification_started/.test(type)) step.state = "run";
    else if (/succeeded|verification_passed|verification_applied/.test(type)) step.state = "done";
    else if (/denied|blocked|failed|abandoned|revoke|not_applied|unknown_effect/.test(type)) step.state = "error";
  }
  return steps;
}

export type AgentReview = {
  summary?: string; model?: string; skipped?: boolean;
  items: Array<{ label: string; node_id: string; url?: string; kind?: string; ok: boolean; issues: string[]; revised_prompt?: string }>;
};
/** 生成结果的自动审查：每批一条（后端 review 事件） */
export function taskReviews(snapshot: AgentTaskSnapshot): AgentReview[] {
  return snapshot.events.filter((e) => String(e.eventType || "") === "review").map((e) => {
    const p = (e.safePayload && typeof e.safePayload === "object" ? e.safePayload : {}) as Record<string, any>;
    return { summary: String(p.summary || ""), model: String(p.model || ""), skipped: !!p.skipped, items: Array.isArray(p.items) ? p.items : [] };
  });
}

export type ThoughtRow = { text: string; /** thought / roadmap / reflect / self_check（后端的 kind） */ kind: string };

/** 助手每轮的思考（后端 thought 事件）：带 kind，用来把「反思」那一条标出来 */
export function taskThoughtRows(snapshot: AgentTaskSnapshot): ThoughtRow[] {
  const out: ThoughtRow[] = [];
  for (const event of snapshot.events) {
    if (String(event.eventType || "") !== "thought") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    const text = String(payload.text || "").trim();
    if (text && out[out.length - 1]?.text !== text) out.push({ text, kind: String(payload.kind || "thought") });
  }
  return out;
}

/** 只保留文本（兼容旧调用处） */
export function taskThoughts(snapshot: AgentTaskSnapshot): string[] {
  return taskThoughtRows(snapshot).map((row) => row.text);
}

/** 长任务心跳：取最后一条 heartbeat；其后出现 done/error（或任务已结束）就返回 null（面板据此清掉这一行） */
export type Heartbeat = { stage: "decide" | "tools" | "review"; elapsedMs: number; kind?: string };
export function taskHeartbeat(snapshot: AgentTaskSnapshot): Heartbeat | null {
  let hit: Heartbeat | null = null;
  let ended = false;
  for (const event of snapshot.events) {
    const type = String(event.eventType || "");
    if (type === "heartbeat") {
      if (ended) continue;   // 结束之后迟到的心跳不复活这一行
      const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
      const stage = String(payload.stage || "decide");
      hit = {
        stage: stage === "tools" || stage === "review" ? stage : "decide",
        elapsedMs: Math.max(0, Number(payload.elapsed_ms) || 0),
        kind: typeof payload.kind === "string" ? payload.kind : undefined,
      };
      continue;
    }
    if (type === "done" || type === "error" || type === "task.completed") { ended = true; hit = null; }
  }
  if (snapshot.status && ["SUCCEEDED", "COMPLETED", "FAILED", "CANCELLED", "STOPPED", "BLOCKED"].includes(String(snapshot.status))) return null;
  return hit;
}

/** 下一步建议（done 事件 / 结论 message 上的 suggestions；开关打开时后端才发） */
export function taskSuggestions(snapshot: AgentTaskSnapshot): string[] {
  const out: string[] = [];
  for (const event of snapshot.events) {
    const type = String(event.eventType || "");
    if (type !== "done" && type !== "message") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    const list = (payload as { suggestions?: unknown }).suggestions;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const text = String(item || "").trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out.slice(0, 3);
}

/** 托管预算事件（budget_required）：额度用完 / 即将用完，面板弹授权卡（补额度或结束） */
export type BudgetRequired = {
  run_id?: string;
  /** 各模态还缺多少次 */
  needs?: Partial<Record<"image" | "video" | "audio", number>>;
  /** 各模态当前上限 */
  budget?: Partial<Record<"image" | "video" | "audio", number>>;
  /** 各模态已用次数（remaining = budget - used 前端自己算） */
  used?: Partial<Record<"image" | "video" | "audio", number>>;
  modality?: string;
  units?: string;
  [key: string]: unknown;
};
export function taskBudgetRequired(snapshot: AgentTaskSnapshot): BudgetRequired | null {
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const event = snapshot.events[index];
    if (String(event.eventType || "") !== "budget_required") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    return { ...payload };
  }
  return null;
}

/** 完成前自检事件：{ round, passed, items:[{text, ok, status?}] }；只有事件存在时才返回（没有就不长出来） */
export type SelfCheckResult = { round: number; passed: boolean; items: Array<{ text: string; ok: boolean; /** pending = 待核对，不计入未满足 */ status?: string }> };
export function taskSelfCheck(snapshot: AgentTaskSnapshot): SelfCheckResult | null {
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const event = snapshot.events[index];
    if (String(event.eventType || "") !== "self_check") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    const items = (Array.isArray(payload.items) ? payload.items : [])
      .map((row: any) => ({ text: String(row?.text || "").trim(), ok: row?.ok === true, status: typeof row?.status === "string" ? row.status : undefined }))
      .filter((row: { text: string }) => !!row.text);
    return { round: Number(payload.round) || 0, passed: payload.passed === true, items };
  }
  return null;
}

export function subscribeAgentTask(backend: Pick<CanvasBackend, "watchAgentTask">, taskId: string, onSnapshot: (snapshot: AgentTaskSnapshot) => void, onSettled: () => void) {
  let cleanup: (() => void) | null = null;
  let settled = false;
  const stop = () => { if (settled) return; settled = true; cleanup?.(); onSettled(); };
  const off = backend.watchAgentTask?.(taskId, (snapshot) => { onSnapshot(snapshot); if (TASK_UI_SETTLED.has(snapshot.status)) stop(); }) || null;
  cleanup = off;
  if (settled) cleanup?.();
  return { stop, settled: () => settled };
}

export type RefreshOutcome = "pending" | "refreshed" | "skipped" | "failed" | "not_required";
export function taskAnswer(snapshot: AgentTaskSnapshot, refresh: RefreshOutcome = "not_required"): string {
  const last = snapshot.artifacts[snapshot.artifacts.length - 1];
  if (last && last.content != null) return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  if (snapshot.status === "SUCCEEDED" || snapshot.status === "COMPLETED") {
    if (refresh === "pending") return "任务已完成，正在重读权威画布。";
    if (refresh === "refreshed") return "任务已完成，画布已按权威文档刷新。";
    if (refresh === "skipped") return "任务已完成；本端未保存编辑已保留，未用远端文档覆盖。";
    if (refresh === "failed") return "任务已完成，但权威画布刷新失败；请手动刷新核查。";
    return "任务已完成。";
  }
  if (snapshot.status === "CANCELLED" || snapshot.status === "STOPPED") return "已停止；已经完成的操作保留，后续步骤不会继续。";
  if (snapshot.status === "WAITING") return "等待你在 NOVAI 审批提示中决定。自动模式也不会跳过写入批准。";
  if (snapshot.status === "BLOCKED") return "任务已阻塞。请查看失败原因；若是画布版本冲突，你的现有编辑已保留。";
  if (snapshot.status === "FAILED") return "任务失败；已发生的操作保留，未执行的操作不会补跑。";
  // 运行中：助手在等画布出结果（生图 / 视频 / 配音 / 导出成片），把进度说出来，别一直停在「任务已提交」
  const lastEv = snapshot.events[snapshot.events.length - 1] as { eventType?: string; safePayload?: { text?: string } } | undefined;
  if (lastEv && lastEv.eventType === "waiting" && lastEv.safePayload?.text) return lastEv.safePayload.text + "（出结果后会自动审查，再问你是否满意）";
  return "";
}
