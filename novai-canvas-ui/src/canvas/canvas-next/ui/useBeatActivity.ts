/**
 * 画布助手的状态 → 头像表情。数据全在 AgentPanel 已经拿到的 AgentState(a) 里，
 * 这里只做「按优先级取第一条命中的」，不改任何业务状态。
 *
 * 优先级从上到下（为什么是这个顺序）：
 *   waiting     问答卡还没答完 / 任务停在 WAITING / 方案卡等批准。助手停下来等人，
 *               这是唯一会阻塞用户的状态，所以排第一——不管别的东西还在不在跑。
 *   error       最新一条助手消息上出现失败步骤，或任务 FAILED / BLOCKED。失败是一次事件不是一种状态，
 *               只闪 1.4s 就回 idle，否则一次报错会让头像永久红着。ToolStep 上没有时间字段
 *               （state.ts 只有 label / state / secs），所以「最近 15s 内」用「第一次看到这个失败」来判：
 *               首帧只登记不闪灯（打开历史对话不该红灯），之后同一签名不再重播。
 *   tool        有正在跑的步骤。执行动作要「忙」的样子。
 *   generating  正在跑的步骤是生成类。生成按进度扫描，和工具那种机械脉冲不是一回事，
 *               所以先从 tool 里摘出去（否则 generate_image 永远落进 tool，扫描态看不到）。
 *   thinking    a.busy 且还没有正文。正文开始流之后就不算「想」，避免长回答全程思考脸；
 *               任务路径的 m.text 是运行时状态播报（「任务已提交…」），不当作正文。
 *   listening   输入框有草稿，或刚发送 600ms 内。用户正在输入时助手应该在听。
 *   success     任务从进行中变成 SUCCEEDED / COMPLETED。一次性闪 1.2s（表情用 happy）。
 *   idle        其余。
 *
 * 一次性状态可被下一次事件打断：新签名/m 的 key 不同就重新计时，绝不因为「条件还挂着」反复闪。
 */

import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentMsg, AgentState, ToolStep } from "../agent/state";
import type { BeatState } from "./BeatAvatar";

const ERROR_HOLD_MS = 1400;
const SUCCESS_HOLD_MS = 1200;
const SENT_WINDOW_MS = 600;
/** ToolStep 没有进度字段，生成态只能给不定态；有真实值时再从这里读 */
const INDETERMINATE_PROGRESS = 0.5;

/** 生成类工具 id：口径与 agent/planParams.ts 的 IMAGE_TOOLS / VIDEO_TOOLS 一致，另加批量 / 导出 */
const GEN_TOOLS = new Set([
  "generate_image", "create_image", "image_to_image", "edit_image",
  "generate_video", "create_video", "image_to_video", "lipsync_video", "video_generation",
  "batch_generate", "run_generation", "export_timeline",
]);
/** 后端也可能直接给中文展示名（ToolStep.label = payload.toolId || payload.name），所以再看关键词 */
const GEN_WORDS = /生成|出图|出片|生图|图片|视频|配音|剪辑|渲染|导出/;
const isGenStep = (step: ToolStep) => GEN_TOOLS.has(step.label.trim().toLowerCase()) || GEN_WORDS.test(step.label);

const RUNNING_STATUS = new Set(["PENDING", "RUNNING", "WAITING", "STOPPING"]);
const DONE_STATUS = new Set(["SUCCEEDED", "COMPLETED"]);

const lastAssistant = (msgs: AgentMsg[]): AgentMsg | null => {
  for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i].role === "a") return msgs[i];
  return null;
};

const lastUser = (msgs: AgentMsg[]): AgentMsg | null => {
  for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i].role === "u") return msgs[i];
  return null;
};

/** 等审批：只认最新那条带 task 的消息，历史里已经结束的任务不该让头像永远等在 waiting */
const taskWaiting = (msgs: AgentMsg[]): boolean => {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const task = msgs[i].task;
    if (!task) continue;
    if (task.status === "WAITING") return true;
    // 方案卡：任务停下来了但一步都没执行，等用户点「执行这些步骤」，本质也是等确认
    if (task.plan && task.plan.steps.length) return true;
    return false;
  }
  return false;
};

/** 问答卡：只认最新一条助手消息上的卡，历史里被忽略的旧卡不该让头像永远等下去 */
const qaOpen = (newest: AgentMsg | null): boolean => Boolean(newest?.qa && newest.qa.status === "open");

const failureKey = (newest: AgentMsg | null): string => {
  if (!newest) return "";
  const status = newest.task?.status || "";
  if (status === "FAILED" || status === "BLOCKED") return "task:" + newest.id + ":" + status;
  const bad = (newest.tools || []).map((step, i) => (step.state === "error" ? i + ":" + step.label : "")).filter(Boolean);
  return bad.length ? "step:" + newest.id + ":" + bad.join("|") : "";
};

export interface BeatActivity {
  state: BeatState;
  /** 只有 generating 会读它 */
  progress: number;
}

export const useBeatActivity = (a: AgentState): BeatActivity => {
  const newest = lastAssistant(a.msgs);
  const taskStatus = newest?.task?.status || "";

  /* 正文 = 真的在往外吐的模型回答（stream() 会置 streaming，或没有 task 的本地回答）；
     任务路径的 m.text 是运行时状态播报，不是正文，不计入。 */
  const body = Boolean(newest && newest.text.trim() && (newest.streaming || !newest.task));
  const thinking = a.busy && (!body || Boolean(newest?.think?.live));

  const running = (newest?.tools || []).filter((step) => step.state === "run");
  const genStep = running.find(isGenStep) || null;
  const toolStep = running.find((step) => !isGenStep(step)) || null;

  const waiting = qaOpen(newest) || taskWaiting(a.msgs);
  const failure = failureKey(newest);

  /* 刚发送：store 只在事件到来时通知，「刚点发送」用渲染时的墙钟判断就够了 */
  const lastUserId = useRef("");
  const sentAt = useRef(0);
  const seeded = useRef(false);
  const prevStatus = useRef("");
  const errSeen = useRef("");
  /* 一次性状态的跳变只在同一条助手消息里成立：换消息（新的一轮 / 切历史线程）只重新登记位置，
     不把上一条的 RUNNING / error 当成"刚刚发生"，否则打开历史对话会莫名其妙闪一下红灯 */
  const subject = newest?.id || "";
  const subjectRef = useRef<string | null>(null);
  if (subjectRef.current !== subject) {
    subjectRef.current = subject;
    prevStatus.current = taskStatus;
    errSeen.current = failure;
  }
  const user = lastUser(a.msgs);
  if (!seeded.current) {
    seeded.current = true;
    lastUserId.current = user?.id || "";
  } else if (user && user.id !== lastUserId.current) {
    lastUserId.current = user.id;
    sentAt.current = Date.now();
  }
  const sentAtValue = sentAt.current;
  const justSent = sentAtValue > 0 && Date.now() - sentAtValue < SENT_WINDOW_MS;
  const listening = Boolean(a.draft.trim()) || justSent;

  const [pulse, setPulse] = useState<{ state: BeatState; key: string; until: number } | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  /* 发送窗口到点要主动重渲染一次，否则 listening 会挂到下一次业务事件才消失 */
  useEffect(() => {
    if (!sentAtValue) return;
    const left = SENT_WINDOW_MS - (Date.now() - sentAtValue);
    if (left <= 0) return;
    const timer = window.setTimeout(tick, left + 20);
    return () => window.clearTimeout(timer);
  }, [sentAtValue]);

  useEffect(() => {
    const previous = prevStatus.current;
    prevStatus.current = taskStatus;
    if (previous === taskStatus) return;
    if (!RUNNING_STATUS.has(previous) || !DONE_STATUS.has(taskStatus)) return;
    setPulse({ state: "happy", key: "ok:" + (newest?.id || ""), until: Date.now() + SUCCESS_HOLD_MS });
  }, [taskStatus, newest?.id]);

  useEffect(() => {
    if (failure === errSeen.current) return;
    errSeen.current = failure;
    if (!failure) return;
    setPulse({ state: "error", key: failure, until: Date.now() + ERROR_HOLD_MS });
  }, [failure]);

  useEffect(() => {
    if (!pulse) return;
    const left = pulse.until - Date.now();
    if (left <= 0) {
      setPulse(null);
      return;
    }
    const timer = window.setTimeout(() => setPulse(null), left);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  const live = pulse && pulse.until > Date.now() ? pulse : null;

  let state: BeatState;
  if (waiting) state = "waiting";
  else if (live?.state === "error") state = "error";
  else if (toolStep) state = "tool";
  else if (genStep) state = "generating";
  else if (thinking) state = "thinking";
  else if (listening) state = "listening";
  else if (live) state = live.state;
  else state = "idle";

  return { state, progress: INDETERMINATE_PROGRESS };
};
