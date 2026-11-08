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

export function taskToolSteps(snapshot: AgentTaskSnapshot): ToolStep[] {
  const steps: ToolStep[] = [];
  const byCall = new Map<string, ToolStep>();
  for (const event of snapshot.events) {
    const type = String(event.eventType || "");
    if (!/^tool\.|^harness\.tool_proposed$/.test(type)) continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    // 自动执行时每轮的「本轮计划」只是过程记录，不是等你批准的步骤：不进步骤列表（待确认的方案有自己的卡片）
    if (type === "harness.tool_proposed" && !(payload.plan && payload.plan.requires_confirmation === true)) continue;
    const callId = String(payload.callId || payload.toolCallId || event.eventId || steps.length);
    // 给用户看「对哪个节点做什么」的描述，没有才退回工具名
    const name = String(payload.description || payload.toolId || payload.name || "NOVAI 工具");
    let step = byCall.get(callId);
    if (!step) {
      step = { label: name, state: "wait", callId };
      byCall.set(callId, step);
      steps.push(step);
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

/** 助手每轮的思考（后端 thought 事件：整体方案 + 每轮判断），按时间顺序 */
export function taskThoughts(snapshot: AgentTaskSnapshot): string[] {
  const out: string[] = [];
  for (const event of snapshot.events) {
    if (String(event.eventType || "") !== "thought") continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    const text = String(payload.text || "").trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
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
