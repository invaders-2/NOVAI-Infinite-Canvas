import type { AgentTaskSnapshot, CanvasBackend } from "../backend/types";
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

export function taskToolSteps(snapshot: AgentTaskSnapshot): ToolStep[] {
  const steps: ToolStep[] = [];
  const byCall = new Map<string, ToolStep>();
  for (const event of snapshot.events) {
    const type = String(event.eventType || "");
    if (!/^tool\.|^harness\.tool_proposed$/.test(type)) continue;
    const payload = event.safePayload && typeof event.safePayload === "object" ? event.safePayload : {};
    const callId = String(payload.callId || payload.toolCallId || event.eventId || steps.length);
    const name = String(payload.toolId || payload.name || "NOVAI 工具");
    let step = byCall.get(callId);
    if (!step) {
      step = { label: name, state: "wait" };
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
  return "";
}
