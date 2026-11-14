const BASE = "http://127.0.0.1:3932";
const MODEL = process.env.M || "ZhipuAI/GLM-4.7-Flash";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const c = await (await fetch(BASE + "/api/canvases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "STEP8d 流式" }) })).json();
  const canvasId = c.canvas.id;
  const t = await (await fetch(BASE + "/api/agent/threads/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvas_id: canvasId }) })).json();
  const threadId = t.thread.id;
  const res = await fetch(BASE + "/api/agent/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    canvas_id: canvasId, instruction: "先读一下画布上有什么节点，再一句话告诉我。不要新建任何东西。", provider: "modelscope", model: MODEL,
    mode: "run", auto_execute: true, renderer: "beat", thread_id: threadId, max_steps: 0, history: [],
    focus: { selected_node_ids: [], reference_images: [], reference_videos: [], references: [] },
  }) });
  const runId = String(res.headers.get("X-NOVAI-Run-Id") || "");
  if (res.body) void res.body.cancel().catch(() => undefined);
  console.log(JSON.stringify({ canvasId, threadId, runId, status: res.status }));
  let last = null;
  for (let i = 0; i < 45; i += 1) {
    await sleep(2000);
    last = await (await fetch(BASE + "/api/agent/runs/" + encodeURIComponent(runId) + "/snapshot")).json().catch(() => null);
    const ev = (last && last.events) || [];
    const counts = {};
    for (const e of ev) counts[e.eventType] = (counts[e.eventType] || 0) + 1;
    if (i % 3 === 0) console.log(JSON.stringify({ t: i * 2, status: last && last.task && last.task.status, counts }));
    if (last && ["SUCCEEDED", "FAILED", "CANCELLED", "STOPPED"].includes(String(last.task && last.task.status))) break;
  }
  const ev = (last && last.events) || [];
  const deltas = ev.filter((e) => e.eventType === "message_delta").map((e) => String((e.safePayload || {}).text || ""));
  console.log(JSON.stringify({ final: last && last.task && last.task.status, types: [...new Set(ev.map((e) => e.eventType))], deltaCount: deltas.length, deltaHead: deltas.slice(0, 3), json: deltas.some((d) => /"thought"|"steps"/.test(d)) }));
})().catch((e) => { console.error(e); process.exit(1); });
