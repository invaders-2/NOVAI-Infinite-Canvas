/**
 * 阶段三修复 C8：任务运行用 SSE 订阅（GET /api/agent/runs/{run_id}/stream?after=N），不再靠高频轮询快照。
 *
 *   · parseSseFrames：把流式分片切成一帧一帧（事件名 / id=seq / data JSON；支持多行 data 与心跳注释）
 *   · projectRunEvent：把一帧事件按后端 _agent_run_task_snapshot 的口径投影进本地快照（events 追加、状态收敛），
 *     这样运行中每来一条增量直接进状态，不需要再拉一次 /snapshot
 *   · 快照轮询只做断线兜底（见 watchCadence.ts），间隔 ≥750ms
 *
 * 纯函数，tests 可断言；bridge.watchAgentTask 负责网络与重连（after=lastSeq 续传）。
 */
export type RunStreamFrame = { id: number; event: string; data: any };
export type RunSnapshot = {
    taskId: string;
    status: string;
    modelConfigId?: string | null;
    steps: unknown[];
    events: Array<{ eventId: string; eventType: string; safePayload: Record<string, any> }>;
    calls: unknown[];
    artifacts: unknown[];
    verifications: unknown[];
    error?: string;
};

/** 流式分片 → 帧；返回剩余的半帧（下次拼接）。 */
export function parseSseFrames(buffer: string, chunk: string): { frames: RunStreamFrame[]; rest: string } {
    const text = String(buffer || "") + String(chunk || "").replace(/\r\n/g, "\n");
    const parts = text.split("\n\n");
    const rest = parts.pop() ?? "";
    const frames: RunStreamFrame[] = [];
    for (const part of parts) {
        let id = 0;
        let event = "message";
        const dataLines: string[] = [];
        for (const line of part.split("\n")) {
            if (!line || line.startsWith(":")) continue;
            if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
            else if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!dataLines.length) continue;
        let data: any = null;
        try { data = JSON.parse(dataLines.join("\n")); } catch { continue; }
        frames.push({ id, event, data });
    }
    return { frames, rest };
}

/** 从快照里取最后一条事件的 seq（eventId 形如 run_id:seq） */
export function lastSeqOf(snapshot: Pick<RunSnapshot, "events"> | null | undefined): number {
    const events = snapshot?.events || [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const id = String(events[index]?.eventId || "");
        const seq = Number(id.slice(id.lastIndexOf(":") + 1));
        if (Number.isFinite(seq) && seq > 0) return seq;
    }
    return 0;
}

/** 一帧事件按后端快照口径投影进本地快照（不修改入参） */
export function projectRunEvent(snapshot: RunSnapshot, frame: RunStreamFrame): RunSnapshot {
    const data = frame.data && typeof frame.data === "object" ? frame.data : {};
    const seq = Number(frame.id) || 0;
    const event: { eventId: string; eventType: string; safePayload: Record<string, any> } = {
        eventId: snapshot.taskId + ":" + seq,
        eventType: frame.event,
        safePayload: data,
    };
    let status = snapshot.status;
    let error = snapshot.error;
    if (frame.event === "step_start" || frame.event === "step_result") {
        const ok = data.ok === true;
        event.eventType = "tool.execution." + (frame.event === "step_start" ? "started" : ok ? "succeeded" : "failed");
        event.safePayload = {
            callId: "step:" + (data.index ?? 0),
            toolId: String(data.tool || ""),
            description: String(data.description || ""),
            result: data.result,
            error: data.error,
            code: data.code,
            args: data.args,
        };
    } else if (frame.event === "plan") {
        event.eventType = "harness.tool_proposed";
        event.safePayload = { callId: "plan:" + seq, toolId: "执行方案", name: "执行方案", plan: data };
    } else if (frame.event === "done") {
        event.eventType = "task.completed";
        const resultStatus = String(data.status || "").toLowerCase();
        status = resultStatus === "aborted" || resultStatus === "cancelled" || resultStatus === "stopped" ? "CANCELLED" : "SUCCEEDED";
        if (resultStatus !== "ok" && resultStatus !== "aborted" && resultStatus !== "cancelled" && resultStatus !== "stopped") {
            status = "FAILED";
            error = String(data.message || "") || error;
        }
    } else if (frame.event === "error") {
        status = "FAILED";
        error = String(data.message || "") || error;
    }
    return { ...snapshot, status, error, events: [...snapshot.events, event] };
}
