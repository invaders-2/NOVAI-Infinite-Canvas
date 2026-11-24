/**
 * 右侧 Agent：对话、思考过程、工具步骤、确认卡片、结果卡片；输入区（上下文贴片、技能标签、+ 菜单、/ 技能、@ 引用、
 * 模式、上下文圆环、模型、语音）；技能管理、记忆、压缩对话、历史对话、全屏 + 画布预览窗。
 */
import { hostRoot } from "../../novaiBridgeRoot";
import { isAssetRef } from "../canvasAssetRefs";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { addFiles, title } from "../canvas-next/actions";
import { clampThinkLevel, genOf, isGenKind, srcOf, thinkLevelsFor, TYPE_ICON, type GenKind, type ModelSpec } from "../canvas-next/model";
import { useCtl, useS, type Ctl } from "../canvas-next/ui/ctx";
import { ComboMenu, prefersReduced } from "../canvas-next/ui/combo";
import { BeatAvatar } from "../canvas-next/ui/BeatAvatar";
import { useBeatActivity } from "../canvas-next/ui/useBeatActivity";
import { publishAgentBeat } from "../canvas-next/ui/useOrbActivity";
import { VendorLogo } from "../canvas-next/ui/VendorLogo";
import { Icon } from "../canvas-next/ui/Icon";
import { AnimatedSendIcon } from "../canvas-next/ui/AnimatedSendIcon";
import { EffortSlider } from "../canvas-next/ui/EffortSlider";
import { closeModal, closePop, ModalHead, openModal, openPop } from "../canvas-next/ui/overlay";
import { placePopover } from "../canvas-next/ui/placement";
import { ThumbImg } from "../canvas-next/ui/thumb";
import { Markdown } from "../canvas-next/ui/markdown";
import { ruleAnswer } from "../canvas-next/agent/planner";
import { runAgentQueued } from "../canvas-next/agent/autorun";
import { rememberCountQueue } from "../canvas-next/agent/countQueue";
import { pickSendText } from "../canvas-next/agent/sendText";
import { cancelReveal, nodeIdSet, revealAddedNodes } from "../canvas-next/agent/revealNodes";
import type { CanvasStore } from "../canvas-next/store";
import { startVoiceCapture, transcribeVoice, voiceErrorText, type VoiceCapture, type VoicePhase } from "../canvas-next/voiceInput";
import { annotationsPrompt, type AnnotationPayload } from "../canvas-next/annotations";
import type { AgentDraft } from "../canvas-next/homeSeed";

/** 桌面壳（pywebview）标记：主进程把它拼进 userAgent（desktop/README.md）。画布常跑在 iframe 里，顶层 / 父窗口也要看 */
function desktopShell(): boolean {
  const hit = (w: Window | null | undefined) => {
    try {
      if (!w) return false;
      if (/pywebview/i.test(String(w.navigator?.userAgent || ""))) return true;
      return Boolean((w as Window & { pywebview?: { api?: unknown } }).pywebview?.api);
    } catch { return false; }
  };
  if (typeof window === "undefined") return false;
  let top: Window | null = null; let parent: Window | null = null;
  try { top = window.top; } catch { top = null; }
  try { parent = window.parent; } catch { parent = null; }
  return hit(window) || hit(top) || hit(parent);
}
/** mac 判定：和 shortcuts.tsx 的 IS_MAC 同口径（userAgentData.platform → platform → userAgent） */
const IS_MAC_PLATFORM = (() => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || "");
})();
/** Electron hiddenInset：红绿灯由系统画在网页之上，mac 桌面端全屏助手要把顶栏左侧让出来（尺寸写在 CSS 里） */
const MAC_LIGHTS = IS_MAC_PLATFORM && desktopShell();

/** 官方技能：技能名 → 市场封面 id（gen-<id>-sq.webp）；没对上就退回原来的 ✨ 图标 */
const SKILL_THUMB: Record<string, string> = {
  "一万条提示词库": "ai-image-prompts-skill",
  "Amazon 主图规范": "amazon-listing-images",
  "Banner 设计": "banner-design",
  "品牌视觉简报": "brand-identity",
  "小红书封面设计": "cover-design",
  "电商出图套件 · 12 套流程": "ecommerce-listing-suite",
  "电商产品图": "ecommerce-product-imagery",
  "时尚 Campaign 全流程": "fashion-campaign-production",
  "模特摄影规范": "fashion-model-photography",
  "多模型视频生成": "google-veo",
  "GPT Image 2 出图与改图": "gpt-image-2",
  "商品换背景 · 白底转场景": "item-change-background",
  "打光指导": "lighting-direction",
  "中文人像写真": "nuyoah-xiezhen-prompt",
  "大师海报设计": "qiaomu-mondo-poster-design",
  "时尚造型书视频": "seedance-fashion-lookbook",
  "Seedance 中文提示词": "seedance-prompt-zh",
  "镜头构图": "shot-composition",
  "提示词优化器": "text-to-image-prompt-optimizer",
  "服装大片 · 胶片暗房": "fashion-editorial",
};
/** RedSkill 技能：SKILL.md 内部 id / 显示名 → 封面文件名里的 slug（封面按 redskill-<slug>-sq.webp 取） */
const REDSKILL_THUMB: Record<string, string> = {
  "avant-garde-chromatic-fashion": "avant-garde-chromatic-fashion",
  "先锋色块时装大片": "avant-garde-chromatic-fashion",
  "retro-romantic-garden-lookbook": "retro-romantic-garden-lookbook",
  "复古英伦花园写真": "retro-romantic-garden-lookbook",
  "create-y2k-fashion-images": "create-y2k-fashion-images",
  "千禧 Y2K 时尚大片": "create-y2k-fashion-images",
  "avant-fashion-editorial": "0867678-avant-fashion-editorial",
  "先锋档案时尚摄影": "0867678-avant-fashion-editorial",
};
/** 技能缩略图地址：先查 RedSkill 映射，再按官方技能的 gen-<id> 规则；都没有就返回空串（保持 ✨） */
function thumbUrl(skill: { id?: string; name?: string; src?: string }): string {
  const id = skill.id || "";
  const name = skill.name || "";
  const red = REDSKILL_THUMB[id] || REDSKILL_THUMB[name];
  if (red) return `/static/store/covers/redskill-${red}-sq.webp`;
  const sid = SKILL_THUMB[name] || (skill.src === "官方" ? id : "");
  return sid ? `/static/store/covers/gen-${sid}-sq.webp` : "";
}

/** 助手改完画布后拉权威版本：本端还有没存完的编辑时先存掉再拉一次，别让助手建的节点因为「跳过刷新」而看不见 */
/** 保存状态（读最新值；运行中会变，别让 TS 按上一次比较收窄） */
const saveState = (store: CanvasStore) => store.state.saving as string;
async function refreshForAgent(store: CanvasStore): Promise<"refreshed" | "skipped" | "failed"> {
  const first = await store.refreshAuthoritative();
  if (first === "refreshed" || first === "failed") return first;
  // 和助手的改动冲突（本端自动保存已停）：强制载入服务端版本，否则助手交来的生成任务永远到不了画布
  if (saveState(store) === "conflict" || saveState(store) === "error") { const r = await store.refreshAuthoritative({ force: true }); if (r === "refreshed") store.toast("已载入画布助手的最新改动"); return r; }
  await new Promise((r) => setTimeout(r, 900));
  await store.saveNow();
  const again = await store.refreshAuthoritative();
  if (again === "skipped" && (saveState(store) === "conflict" || saveState(store) === "error")) return store.refreshAuthoritative({ force: true });
  return again;
}

/** 执行待生成卡片前：先把画布本地的改动存好（和服务端对齐），后端再改节点参数时就不会撞版本冲突 */
async function syncBeforeAgentWrite(store: CanvasStore) {
  if (saveState(store) === "conflict" || saveState(store) === "error") { await store.refreshAuthoritative({ force: true }); return; }
  await store.saveNow();
  if (saveState(store) === "conflict" || saveState(store) === "error") await store.refreshAuthoritative({ force: true });
}
import { MentionPalette } from "../canvas-next/agent/MentionPalette";
import { displaySrc } from "../canvas-next/stack";
import { agentAssetsVersion, cachedAgentAssets, listAgentReferences, subscribeAgentAssets } from "../canvas-next/agent/references";
import { matchSkillRef } from "../canvas-next/agent/skillRef";
import { QueryLocator } from "../canvas-next/agent/QueryLocator";
import { AgentState, THINKING, useAgent, type AgentMsg, type Skill, type ToolStep } from "../canvas-next/agent/state";
import { QUEUE_MAX, enqueue as enqueueQueued, prependUrgent, removeQueued, snapshotForText, takeFirst, type QueuedMsg } from "../canvas-next/agent/queue";
import { useFollowLatest } from "../canvas-next/agent/followLatest";
import { WebImageCard } from "../canvas-next/agent/WebImageCard";
import { ReviewCard } from "../canvas-next/agent/ReviewCard";
import { WebSearchCard } from "../canvas-next/agent/WebSearchCard";
import { importWebImages, isWebAccessDisabled, reverseWebImages, webAccessEnabled, webImageCards, type WebImageCardData, type WebImageItem } from "../canvas-next/agent/webImages";
import { webSearchCards, type WebSearchCardData } from "../canvas-next/agent/webSearch";
import { answerText, clarifyQuestions, newCard, parseQuestions, regenTargets, type QaCard } from "../canvas-next/agent/qa";
import { QaCardView } from "../canvas-next/agent/QaCard";
import { contextCompactionsOf, contextUsageOf, latestContextUsage } from "../canvas-next/agent/contextUsage";
import { ContextMeter, CompactNotice } from "../canvas-next/agent/ContextMeter";
import { openRecallSearch } from "../canvas-next/agent/RecallPanel";
import { MemoryCandidateCard } from "../canvas-next/agent/MemoryCandidateCard";
import { CanvasProfilePanel, MemorySettingsPanel } from "../canvas-next/agent/MemoryPanels";
import { MemoryCandidatesError, confirmMemoryCandidates, dismissMemoryCandidates, fetchMemoryCandidates, type MemoryCandidate } from "../canvas-next/agent/memoryCandidates";
import { looksLikeDecisionJson, subscribeAgentTask, TASK_UI_SETTLED, taskAnswer, taskBudgetRequired, taskChecklist, taskHeartbeat, taskMessageStream, taskPendingPlan, taskReasoning, taskReviews, taskSelfCheck, taskSuggestions, taskThoughtRows, taskThoughts, taskToolSteps, type BudgetRequired, type SelfCheckResult, type RefreshOutcome } from "../canvas-next/agent/task";
import { TaskPlanCard } from "../canvas-next/agent/TaskPlanCard";
import { TaskChecklistBar } from "../canvas-next/agent/TaskChecklistBar";
import { AutonomyCard, type AutonomyBudget } from "../canvas-next/agent/AutonomyCard";
import { countGroupQueue } from "../canvas-next/agent/planParams";
import { GenerationCard } from "../canvas-next/agent/GenerationCard";
import type { AgentRegenerateItem, AgentTaskPlan, AgentTaskSnapshot } from "../canvas-next/backend/types";
import { skillInstallIntent } from "../canvas-next/agent/skillInstallIntent";
import { inspectSkillRepository, installSkillPreview } from "../canvas-next/agent/skillInstallClient";
import { SkillInstallCard } from "../canvas-next/agent/SkillInstallCard";
import { ChipLabel, MentionInput, mentionTokenOf, parseMentionTokens, plainMentionText, removeMentionTokens, type MentionChip, type MentionInputHandle, type MentionKind } from "../canvas-next/agent/MentionInput";
import { ChipPreviewHost, hoverChip, leaveChip } from "../canvas-next/agent/ChipPreview";
import { CaptureButton, FolderButton } from "./DesktopInputControls";
import "./agent-webimg.css";
import { Bubble, BubbleContent } from "@/components/hexta/bubble";
import { InputGroup } from "@/components/hexta/input-group";
import { Marker, MarkerContent, MarkerTime } from "@/components/hexta/marker";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from "@/components/hexta/message-scroller";
import "./agent-panel-v2.css";
import { IconWorld } from "@tabler/icons-react";
import { Alert, AlertClose, AlertTitle } from "@/components/hexta/alert";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { ButtonGroup } from "@/components/hexta/button-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/hexta/collapsible";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/hexta/item";
import { Message, MessageContent } from "@/components/hexta/message";
import { Skeleton } from "@/components/hexta/skeleton";
import { Spinner } from "@/components/hexta/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/hexta/tooltip";

const SUGS: Array<[Parameters<typeof Icon>[0]["name"], string, string, string]> = [
  ["brain", "帮我延续这个项目的记忆", "保留已经确定的设定、风格和方向。", "回顾这张画布和记忆，总结已经确定的设定、风格和方向，之后都按这个来"],
  ["sparkle", "生成一套卖点海报", "读取产品图和产品信息，拆 3 个卖点，各出一张海报", "用产品图和产品信息做一套 3 张的卖点海报"],
  ["grid", "拆成表格批量出图", "需求 → 多维表格 → 逐行出图", "把这个需求拆成多维表格，再逐行批量出图"],
  ["video", "把两张图做成短片", "用首尾帧生成 10 秒视频", "把选中的两张图做成一条 10 秒短片"],
  ["search", "这张画布现在什么状态", "列出还没生成和缺输入的节点", "检查一下这张画布还缺什么"],
];
/** 空状态建议卡自动轮播间隔（Boss：5 秒换一批） */
const SUG_ROTATE_MS = 5000;
/** 粘贴图片单张上限：和「上传附件」共用 addFiles，超过这个尺寸先挡掉，避免读进内存才失败 */
const PASTE_IMAGE_LIMIT = 20 * 1024 * 1024;
/** 草稿最前面插技能胶囊（已经有同名胶囊就不重复插） */
function withSkillChip(text: string, name: string): string {
  const token = mentionTokenOf("skill", name);
  return text.includes(token) ? text : token + " " + text;
}
/** .zip 技能包上限（和后端 /api/skills/import-zip 一致） */
const SKILL_ZIP_LIMIT = 10 * 1024 * 1024;
const mid = () => "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const qid = () => "q_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 结果确认卡里代表「动作」而不是「问题描述」的选项：拼反馈时不算进描述 */
const QA_ACTION_OPTIONS = new Set(["重新生成", "先不重做", "符合要求，继续下一步", "不满意，需要重做"]);
/** 第一题勾了这些 = 想重做（不是「基本可以，微调一下」这类补充描述） */
const QA_REGEN_PICK = /重新生成|重做|不满意/;
/** 结果确认卡的反馈 → 重生成描述（各题自己填的 + 勾选的问题描述类选项）；勾了动作类选项算「要重做」 */
function confirmFeedback(card: QaCard): { description: string; regenerate: boolean } {
  const others = card.questions.map((_, qi) => (card.other[qi] || "").trim()).filter(Boolean);
  const details = card.picks.flat().filter((opt) => !!opt && !QA_ACTION_OPTIONS.has(opt));
  return { description: [...new Set([...others, ...details])].join("；"), regenerate: (card.picks[0] || []).some((opt) => QA_REGEN_PICK.test(opt)) };
}

/** 顶部 / 内联胶囊上的类型角标 */
const CTX_KIND_LABEL: Record<string, string> = { image: "图", video: "视频", text: "文本", audio: "音频", table: "表格", group: "分组" };
/** 历史消息没有 ctx：按当前画布节点 / 素材库标题反查文本里的「@标题」，补出上下文（只影响正文 @ 内联记号）。
 *  素材库是异步读的，快照版本一起进缓存 key：素材读回来之后会重新算，不会把「还没读到」缓存成「没有」。 */
const inferredCtxCache = new Map<string, NonNullable<AgentMsg["ctx"]>>();
const ctxTitleHit = (text: string, name: string): boolean => {
  if (!name || name.length < 2) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf("@" + name, from); if (at < 0) return false;
    const after = text[at + 1 + name.length] || "";
    if (!after || /[\s，。,.!?、;；:：)）\]】@]/.test(after)) return true;
    from = at + 1;
  }
};
function inferCtxFromText(store: CanvasStore, text: string): NonNullable<AgentMsg["ctx"]> {
  if (!text || !text.includes("@")) return [];
  const key = agentAssetsVersion() + "\u0000" + text;
  const hit = inferredCtxCache.get(key); if (hit) return hit;
  const out: NonNullable<AgentMsg["ctx"]> = [];
  for (const n of store.state.doc.nodes) {
    const t = title(n); if (!ctxTitleHit(text, t)) continue;
    if (out.some((x) => x.id === n.id)) continue;
    out.push({ id: n.id, title: t, kind: n.kind, src: displaySrc(store.state.doc.nodes, n) || undefined });
    if (out.length >= 16) break;
  }
  if (out.length < 16) {
    for (const ref of cachedAgentAssets()) {
      if (ref.kind !== "asset" || !ctxTitleHit(text, ref.title)) continue;
      if (out.some((x) => x.id === ref.id)) continue;
      // 只有能当图显示的引用才给 src：工作流 / 提示词条目的 ref 不是图片地址，挂上去会变成坏图请求
      const src = refMediaSrc(ref);
      out.push({ id: ref.id, title: ref.title, kind: "asset", src: src || undefined });
      if (out.length >= 16) break;
    }
  }
  // 胶囊顺序跟正文里 @ 出现的位置一致（实时消息是 token 顺序，历史按文本反查时也保持同序）
  out.sort((a, b) => text.indexOf("@" + a.title) - text.indexOf("@" + b.title));
  if (inferredCtxCache.size > 400) inferredCtxCache.clear();
  inferredCtxCache.set(key, out);
  return out;
}

export function AgentPanel({ draft }: { draft?: AgentDraft | null }) {
  const ctl = useCtl(); const store = ctl.store;
  const a = useMemo(() => new AgentState(store.state.canvasId), [store]);
  useAgent(a);
  useEffect(() => () => { a.dispose(); }, [a]);
  const ui = useS((s) => s.ui); const doc = useS((s) => s.doc); const models = useS((s) => s.models);
  /* 头像表情：单个 hook 派生出 activity + progress，三处头像共用同一份（一个 rAF 服务所有实例） */
  const beat = useBeatActivity(a);
  /* 收起对话时面板还在挂载，所以由它把「助手在干什么」广播给右下角的悬浮球，不用为球再建一套 AgentState */
  useEffect(() => { publishAgentBeat(beat.state, beat.progress); }, [beat.state, beat.progress]);
  const edRef = useRef<MentionInputHandle | null>(null); const scrollRef = useRef<HTMLDivElement>(null); const boxRef = useRef<HTMLDivElement>(null);
  /** / 技能面板是当前打开的弹层：删掉触发字符时只关它，不误关别的弹层 */
  const slashPaletteOpen = useRef(false);
  const [sugPage, setSugPage] = useState(0);
  /* 空状态建议卡轮播：悬停 / 键盘聚焦 / 面板收起 / 已有对话都停；没暂停时每 5 秒自动换一批 */
  const [sugHover, setSugHover] = useState(false);
  const [sugFocus, setSugFocus] = useState(false);
  const sugNext = () => setSugPage((page) => page + 1);
  const sugPaused = sugHover || sugFocus;
  useEffect(() => {
    // 收起 / 已有对话 / 被悬停或聚焦 → 不轮播，定时器一起清掉
    if (!ui.agentOpen || a.msgs.length || sugPaused) return;
    const timer = window.setInterval(sugNext, SUG_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [ui.agentOpen, a.msgs.length, sugPaused]);
  const [webPlugin, setWebPlugin] = useState(false);
  /** 全屏查看器里「添加到对话」带过来的图片标注：随下一条消息一起发给助手 */
  const [annChat, setAnnChat] = useState<AnnotationPayload[]>([]);
  /** 历史消息里「@素材名」没有内联 ctx：素材库是异步读的，读完重渲染一次把缩略图补出来 */
  const [, setAssetRefsRev] = useState(0);
  useEffect(() => subscribeAgentAssets(() => setAssetRefsRev((v) => v + 1)), []);
  useEffect(() => {
    if (a.msgs.some((m) => m.role === "u" && !m.ctx?.length && (m.text || "").includes("@"))) void listAgentReferences().catch(() => undefined);
  }, [a.msgs.length, a.activeThreadId]);
  const sendLatest = useRef<(() => void) | null>(null);
  /** 建议芯片 / 快捷动作的直传文本：调用 send 前同步放进来，send 开头取走（不依赖 draft 状态 / React flush） */
  const directSendText = useRef<string | null>(null);
  /* 「立即发送」还在忙时先记在 AgentState.pendingUrgent 上：它随线程走，切对话 / 新建对话会和队列一起清空 */
  /** 自动发送正在跑的对话：按线程标记，两个对话同时 flush 互不阻塞 */
  const queueFlushing = useRef(new Set<string>());
  /** 每个对话各自的「空闲后 260ms 自动发送」定时器（后台会话结束也要能自己发） */
  const flushTimers = useRef(new Map<string, number>());
  const [webOn, setWebOn] = useState(true); const seen = useRef(0);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  /** 默认对话模型解析完没：解析前 activeModelId 只是列表第一个，别拿它收敛用户的档位选择 */
  const [defaultModelReady, setDefaultModelReady] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(() => { try { return localStorage.getItem("canvas-next:agent:model"); } catch { return null; } });
  /** 托管授权卡（阶段四）：开始托管 / 收到 budget_required 时弹；handledBudget 防止同一条事件反复弹 */
  const [authCard, setAuthCard] = useState<{ runId: string; reason: "start" | "budget_required"; initial?: AutonomyBudget; key: string } | null>(null);
  const handledBudget = useRef<Set<string>>(new Set());
  const [authBusy, setAuthBusy] = useState(false);
  /** 模型强度（发给模型的上游推理档位，键名与 /api/config 的 model_caps.think 一致）；和下面的「思考强度」是两件事 */
  const [thinkLevel, setThinkLevelState] = useState<string>(() => { try { return localStorage.getItem("canvas-next:agent:think") || ""; } catch { return ""; } });
  const setThinkLevel = (level: string) => {
    setThinkLevelState(level);
    try { if (level) localStorage.setItem("canvas-next:agent:think", level); else localStorage.removeItem("canvas-next:agent:think"); } catch { /* 仅设备 UI 偏好 */ }
  };
  const taskWatchers = useRef(new Map<string, () => void>());
  useEffect(() => () => { taskWatchers.current.forEach((off) => off()); taskWatchers.current.clear(); cancelReveal(ctl); }, [ctl]);
  useEffect(() => { void a.loadSkills(); }, [a]);
  // 首次挂载还原这张画布的历史对话：离开画布再回来 / 刷新页面都还在
  useEffect(() => {
    void (async () => {
      await a.restoreHistory();
      // 验收口：?debugWebimg=1 / loading / failed / web-off 注入模拟参考图卡（正常用户不会触发）
      const webimgMode = new URLSearchParams(location.search).get("debugWebimg");
      if (webimgMode && webimgMode !== "0") a.msgs = [...a.msgs, debugWebImageMessage(webimgMode)];
      if (new URLSearchParams(location.search).get("debugThinking") === "1") a.msgs = [...a.msgs, debugThinkingMessage()];
      // 验收口：?debugWebsearch=1 注入「搜索中」+「已完成 6 条来源」两条模拟消息（只在前端内存，不发请求）
      if (new URLSearchParams(location.search).get("debugWebsearch") === "1") a.msgs = [...a.msgs, ...debugWebSearchMessages()];
      if (new URLSearchParams(location.search).get("debugPlan") === "1") a.msgs = [...a.msgs, debugPlanMessage()];
      // 验收口：?debugChecklist=run|done|fail 注入一张「任务清单」卡（事件按后端快照的形状造，走同一个 taskChecklist 解析）
      const debugChecklist = new URLSearchParams(location.search).get("debugChecklist");
      if (debugChecklist) a.msgs = [...a.msgs, debugChecklistMessage(debugChecklist)];
      // 验收口：?debugHeartbeat=1 前端内存模拟心跳（思考 → 工具 → 审查 → 结束消失），不请求后端
      if (new URLSearchParams(location.search).get("debugHeartbeat") === "1") {
        const hbMsg: AgentMsg = { id: mid(), role: "a", at: Date.now(), text: "", heartbeat: { stage: "decide", elapsedMs: 0 } };
        a.msgs = [...a.msgs, hbMsg];
        const beat = (stage: "decide" | "tools" | "review", elapsedMs: number) => a.patchMessage(hbMsg, { heartbeat: { stage, elapsedMs } });
        window.setTimeout(() => beat("decide", 5000), 1500);
        window.setTimeout(() => beat("tools", 9000), 5000);
        window.setTimeout(() => beat("review", 8000), 6500);
        window.setTimeout(() => beat("review", 13000), 9000);
        window.setTimeout(() => a.patchMessage(hbMsg, { heartbeat: undefined, text: "调试：任务已完成（心跳已清掉）。" }), 11500);
      }
      // 验收口：?debugSuggestions=1 注入带建议芯片的助手消息；?debugProactive=1 注入 origin=agent 的主动消息
      const debugSuggestions = new URLSearchParams(location.search).get("debugSuggestions");
      if (debugSuggestions) a.msgs = [...a.msgs, { id: mid(), role: "a", at: Date.now(), took: 3.1, text: "三张封面已经改好，标题都压到 18 字以内。", suggestions: ["再出一版暖光对比", "把标题换成第二版文案", "导出 3:4 竖版"] }];
      const debugProactive = new URLSearchParams(location.search).get("debugProactive");
      if (debugProactive) a.msgs = [...a.msgs, { id: mid(), role: "a", at: Date.now(), took: 2.2, origin: "agent", text: "三张封面已按昨晚的设定生成完，等你回来确认是否保留。", suggestions: ["保留这一版", "再换一版冷光"] }];
      // 验收口：?debugAutonomy=start|budget 注入托管授权卡（只在前端内存，不发请求）
      // 验收口：?debugProactiveToast=1 模拟「面板收起时收到主动消息」：收起面板 + 现有 Toast（可点开面板）
      if (new URLSearchParams(location.search).get("debugProactiveToast")) {
        setTimeout(() => { store.setUI({ agentOpen: false }); store.toast("助手主动发来一条消息：三张封面已生成完，等你确认", 6000, () => store.setUI({ agentOpen: true })); }, 900);
      }
      const debugAutonomy = new URLSearchParams(location.search).get("debugAutonomy");
      if (debugAutonomy) setAuthCard({ runId: "debug-run", reason: debugAutonomy === "budget" ? "budget_required" : "start", initial: debugAutonomy === "budget" ? {
        used: { image: 8, video: 0, audio: 0 }, budget: { image: 10, video: 6, audio: 4 }, needs: { image: 2, video: 6, audio: 4 }, modality: "image",
      } : { image: { max: 10 }, video: { max: 6 }, audio: { max: 4 } }, key: "debug:" + debugAutonomy });
      // 验收口：?debugSelfCheck=pass|fail 注入一条带「完成前自检」+「反思」的助手消息
      const debugSelf = new URLSearchParams(location.search).get("debugSelfCheck");
      if (debugSelf) a.msgs = [...a.msgs, debugSelfCheckMessage(debugSelf === "fail")];
      // 验收口：?debugGen=1 注入待生成卡片 + 结果审查卡 + 结果确认卡（只在前端内存，不写服务端）
      if (new URLSearchParams(location.search).get("debugGen") === "1") a.msgs = [...a.msgs, ...debugGenMessages()];
      if (new URLSearchParams(location.search).get("debugQa") === "1") a.msgs = [...a.msgs, debugQaMessage()];
      if (new URLSearchParams(location.search).get("debugSkill") === "1") a.msgs = [...a.msgs, ...debugSkillMessages()];
      // 验收口：?debugStream=hold|done 模拟阶段三流式（推理逐字 / 工具准备行 / 回复逐字），只在前端内存
      const debugStream = new URLSearchParams(location.search).get("debugStream");
      if (debugStream && debugStream !== "0") debugStreamScript(a, debugStream === "done" ? "done" : debugStream === "json" ? "json" : debugStream === "json-raw" ? "json-raw" : "hold");
      // 验收口：?debugCjk=1 注入一段中文加粗样例（含代码块 / 行内 code / 未配对对照，只在前端内存）
      if (new URLSearchParams(location.search).get("debugCjk") === "1") a.msgs = [...a.msgs, debugCjkMessage()];
      // 验收口：?debugContext=1（模型窗口已知，带百分比）/ =unknown（窗口未知，只显示绝对值），
      // ?debugCompact=1 再带一条「已整理上下文」；都只在前端内存，不发请求、不写服务端
      const debugCtx = new URLSearchParams(location.search).get("debugContext");
      if (debugCtx && debugCtx !== "0") a.msgs = [...a.msgs, ...debugContextMessages(debugCtx === "unknown" ? "unknown" : "known", new URLSearchParams(location.search).get("debugCompact") === "1")];
      // 验收口：?debugQueue=1 注入 2 条待发送队列消息（只在前端内存，不发请求、不写服务端）
      if (new URLSearchParams(location.search).get("debugQueue") === "1") a.queue = debugQueueItems();
      // 验收口：?debugBusy=<毫秒>（默认 1500）模拟助手忙碌，只在前端内存，绝不请求后端
      const busyMs = debugBusyMs();
      if (busyMs > 0) { const tid = a.activeThreadId || "__new__"; a.setThreadBusy(tid, true); window.setTimeout(() => { a.setThreadBusy(tid, false); a.emit(); scheduleFlush(tid); }, busyMs); }
      seen.current = a.msgs.length;
      a.emit();
    })();
  }, [a]);
  /* 宿主技能事件：bridge 在保存 / 启停 / 导入成功、以及正文补齐后广播（novaiBridge 的 skill.onEvent）。
     订阅要在卸载时摘掉；别的页面 / 应用市场装的技能跨 iframe 收不到事件，下面 focus / visibilitychange 兜底。 */
  useEffect(() => {
    const off = hostRoot<{ skill?: { onEvent?: (cb: (event: any) => void) => () => void } }>()?.skill?.onEvent?.((event) => {
      const command = String(event?.payload?.command || "");
      if (/^skill\/(?:save|enable|disable|delete|import|reload|bodies|pack\/)/.test(command)) void a.loadSkills();
    });
    return () => off?.();
  }, [a]);
  /* 切回窗口 / 标签页重新可见时刷新技能：5s 内不重复请求，失败静默保留旧列表 */
  useEffect(() => {
    const sync = () => { if (document.visibilityState === "hidden") return; void a.refreshSkills(5000); };
    addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [a]);
  useEffect(() => { const on = (e: Event) => store.toast("技能同步失败：" + String((e as CustomEvent).detail || "未知错误")); addEventListener("cn:skill-sync-error", on); return () => removeEventListener("cn:skill-sync-error", on); }, [store]);
  useEffect(() => {
    let live = true;
    const pending = store.backend.defaultChatModel ? store.backend.defaultChatModel() : Promise.resolve<string | null>(null);
    void Promise.resolve(pending).then((id) => { if (!live) return; setDefaultModelId(id || null); setDefaultModelReady(true); }).catch(() => { if (live) setDefaultModelReady(true); });
    return () => { live = false; };
  }, [store.backend, models]);
  const frozenModelId = [...a.msgs].reverse().find((m) => m.task?.modelConfigId)?.task?.modelConfigId || null;
  const chatModels = models.filter((m) => m.kind === "text");
  const selectedModel = chatModels.find((m) => m.id === selectedModelId);
  // 不默认：只用用户自己选过的模型（面板里选的 / 服务端记住的那次选择），不拿列表第一个兜底
  const activeModelId = selectedModel?.id || (chatModels.some((m) => m.id === defaultModelId) ? defaultModelId : null);
  /** 验收口：?debugGenBatch=N 给待生成卡片注入一个「一次最多 N 张」的调试模型（只在前端内存） */
  const debugBatch = Math.max(0, Math.min(8, Math.round(Number(new URLSearchParams(location.search).get("debugGenBatch")) || 0)));
  /** 验收口：?debugGenCaps=1 再注入全能力 / 基础能力模型，用来验收卡片的参数覆盖与「不支持就隐藏」 */
  const debugCaps = new URLSearchParams(location.search).get("debugGenCaps") === "1";
  const cardModels = useMemo(() => {
    const extra: ModelSpec[] = debugBatch > 0 ? [{ id: "debug::批量调试模型", name: "批量调试模型", vendor: "调试", kind: "image", tags: [], secs: 5, batch: Array.from({ length: debugBatch }, (_, i) => i + 1) }] : [];
    return [...models, ...extra, ...(debugCaps ? debugCapModels() : [])];
  }, [models, debugBatch, debugCaps]);
  const modelLabel = selectedModel?.name || (frozenModelId ? chatModels.find((m) => m.id === frozenModelId)?.name || "任务冻结模型" : chatModels.find((m) => m.id === activeModelId)?.name || (chatModels.length ? "选择对话模型" : "未配置对话模型"));
  const modelHint = "画布助手模型：" + modelLabel + "，点击切换";
  /* 模型强度：档位真值源是后端 /api/config 的 provider.model_caps[模型].think，没下发 = 不支持 = 不给入口。
     注意和下面「思考强度」(#aThink，a.thinking) 区分：那个是助手任务规划深度，这个传给上游模型。 */
  const activeModel = chatModels.find((model) => model.id === activeModelId);
  const thinkLevels = thinkLevelsFor(activeModel);
  const thinkLevelsKey = thinkLevels.join(",");
    // 换模型 / 模型列表刷新后收敛：新模型不支持就清空，档位不在新列表里就收到第一个合法档位
  useEffect(() => {
    // 模型列表 / 默认模型都解析完再收敛：否则会拿「列表第一个」把用户存的档位误清掉
    if (!activeModelId || !defaultModelReady) return;
    const next = clampThinkLevel(thinkLevelsKey ? thinkLevelsKey.split(",") : [], thinkLevel);
    if (next !== thinkLevel) setThinkLevel(next);
  }, [activeModelId, defaultModelReady, thinkLevelsKey, thinkLevel]);
  const chooseModel = (id: string | null) => {
    setSelectedModelId(id);
    try { if (id) localStorage.setItem("canvas-next:agent:model", id); else localStorage.removeItem("canvas-next:agent:model"); } catch { /* 仅设备 UI 偏好 */ }
    // 切模型后档位立刻收敛（不依赖默认模型异步解析）：新模型不支持就清空，不在列表里收到第一档
    const nextModel = chatModels.find((m) => m.id === (id || (chatModels.some((x) => x.id === defaultModelId) ? defaultModelId : chatModels[0]?.id)));
    const nextThink = clampThinkLevel(thinkLevelsFor(nextModel), thinkLevel);
    if (nextThink !== thinkLevel) setThinkLevel(nextThink);
    // 选择同时记成默认：换画布、重启应用都沿用，不会再回到列表里的第一个（ModelScope）
    void Promise.resolve(store.backend.setDefaultChatModel?.(id)).then(async () => setDefaultModelId(id || (await store.backend.defaultChatModel?.()) || null)).catch(() => undefined);
    store.toast(id ? "画布助手已切换到 " + (chatModels.find((m) => m.id === id)?.name || "所选模型") + "，之后新画布也默认用它" : "画布助手已恢复默认对话模型");
  };
  const modelMenu = (anchor: Element, keyboard = false) => {
    openPop(anchor, (close) => <AgentModelMenu models={chatModels} defaultModelId={defaultModelId} selectedModelId={selectedModel?.id || null} thinkLevels={thinkLevels} thinkLevel={thinkLevel} onThinkChange={setThinkLevel} onChoose={chooseModel} onSettings={ctl.host.openModelSettings} close={close} />, "up", "left", "model-pop");
    // 键盘打开时把焦点放进菜单，↑/↓/回车 才能直接用
    if (keyboard) setTimeout(() => document.querySelector<HTMLElement>("#pop.model-pop button")?.focus(), 30);
  };

  // 上下文：固定的 + 当前选中的（可移除）；排队消息发送时传快照里的 pinned / selected，不用此刻的选中态
  const ctxNodes = (scope?: { pinned?: string[]; selected?: string[] }): Array<{ n: CanvasNode; pinned: boolean }> => {
    const pinnedIds = scope?.pinned ?? a.pinned;
    const selectedIds = scope?.selected ?? [...store.state.ui.sel];
    const pinned = pinnedIds.map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
    const sel = selectedIds.filter((id) => !a.muted.has(id) && !pinnedIds.includes(id)).map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
    return [...pinned.map((n) => ({ n, pinned: true })), ...sel.map((n) => ({ n, pinned: false }))];
  };
  /** 分组 / 堆叠的引用标签：title(n) 对 group 只会退回 kind（三个堆叠全叫 group），
      这里用 data.gen.title（堆叠名）+ 成员数，引用清单 / 胶囊才分得清是哪一个。 */
  const refLabel = (n: CanvasNode): string => {
    if (n.kind !== "group") return title(n);
    const row = n as unknown as { text?: string; children?: unknown[]; data?: { stack?: unknown; gen?: { title?: unknown } } };
    const name = String(row.data?.gen?.title || row.text || "").trim() || (row.data?.stack ? "堆叠" : "分组");
    const count = Array.isArray(row.children) ? row.children.length : 0;
    return count ? `${name}（${count} 个成员）` : name;
  };
  useEffect(() => { [...a.muted].forEach((id) => { if (!ui.sel.has(id)) a.muted.delete(id); }); }, [ui.sel, a]);
  // 画布上点选加入上下文
  useEffect(() => { const on = (e: Event) => { const id = (e as CustomEvent).detail as string; if (!a.pinned.includes(id)) a.pinned.push(id); a.emit(); }; addEventListener("cn:agent-pick", on); return () => removeEventListener("cn:agent-pick", on); }, [a]);

  /** 本地估算的分层占用：只有拿不到后端 context_usage 时（开关关闭 / 老后端）才用它，内容与改动前一致 */
  const ctxBreak = (): Array<[string, number]> => [["系统与工具", 3200], ["技能", a.skill ? 900 : 0], ["记忆", a.memory().length * 60], ["画布与已选节点", ctxNodes().length * 600 + doc.nodes.length * 80], ["对话历史", a.msgs.reduce((s, m) => s + m.text.length * 2 + (m.tools ? m.tools.length * 180 : 0), 0)]];
  /** 最近一次后端真实占用；没有就是 null（ContextMeter 退回上面的本地估算，面板与改动前一样） */
  const liveUsage = latestContextUsage(a.msgs);
  /** 「要记住这些吗」候选：只显示当前对话、还没处理过的；msgId 是触发那次回复的助手消息（卡片挂它下面） */
  const [memCand, setMemCand] = useState<{ threadId: string; msgId: string; items: MemoryCandidate[] } | null>(null);
  const [memBusy, setMemBusy] = useState(false);
  const memHandled = useRef(new Set<string>());
  /** 退避轮询的定时器与令牌：切对话 / 面板收起 / 拿到候选 都要能立刻停掉 */
  const memTimers = useRef<number[]>([]);
  const memPollKey = useRef(0);
  const memOneShotKey = useRef("");
  /** 定时器里要读「此刻」的面板开合状态（闭包里的 ui 是启动那次渲染的快照） */
  const memOpenRef = useRef(true);
  memOpenRef.current = ui.agentOpen;
  const setDraft = (t: string) => { stopVoiceTyping(); a.draft = t; a.emit(); setTimeout(() => edRef.current?.focus({ caret: "end" }), 0); };
  /* 语音输入：#aMic 走本机录音 + 后端转写（Web Speech API 在 Electron / 国内不可用） */
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceSecs, setVoiceSecs] = useState(0);
  const voiceCap = useRef<VoiceCapture | null>(null);
  const voiceTick = useRef<number | null>(null);
  const voiceStarting = useRef(false);
  const voiceToken = useRef(0);
  /** 卸载时权限弹窗可能还没回来：回来后再拿到的 cap 要立刻取消，别把麦克风留在开着的状态 */
  const voiceAlive = useRef(true);
  const stopVoiceTick = () => { if (voiceTick.current !== null) { window.clearInterval(voiceTick.current); voiceTick.current = null; } };
  const voiceTyping = useRef<number | null>(null);
  const voiceTypingToken = useRef(0);
  /** 取消 / 卸载 / 重新录音都要停掉逐字上屏，避免两个动画同时写草稿、迟到结果再覆盖 */
  const stopVoiceTyping = () => {
    voiceTypingToken.current += 1;
    if (voiceTyping.current !== null) { window.clearInterval(voiceTyping.current); voiceTyping.current = null; }
  };
  /** 取消后迟到回来的转写结果不能再回填，所以每次取消推进一个令牌 */
  const resetVoice = () => {
    voiceToken.current += 1;
    stopVoiceTyping();
    stopVoiceTick();
    voiceCap.current?.cancel();
    voiceCap.current = null;
    setVoiceSecs(0);
    setVoicePhase("idle");
  };
  /** 说完后逐字上屏：后端一次返回整段，这里用 28ms/步近似「边说边出字」，40 步封顶约 1.1s */
  const typeIntoDraft = (text: string) => {
    stopVoiceTyping();
    const token = voiceTypingToken.current;
    const base = a.draft;
    const prefix = base ? base + " " : "";
    const step = Math.max(1, Math.ceil(text.length / 40));
    let i = 0;
    a.draft = prefix;
    a.emit();
    voiceTyping.current = window.setInterval(() => {
      if (token !== voiceTypingToken.current) {
        if (voiceTyping.current !== null) { window.clearInterval(voiceTyping.current); voiceTyping.current = null; }
        return;
      }
      i = Math.min(text.length, i + step);
      a.draft = prefix + text.slice(0, i);
      a.emit();
      if (i >= text.length) {
        if (voiceTyping.current !== null) { window.clearInterval(voiceTyping.current); voiceTyping.current = null; }
        // 只在整段结束后 focus 一次，逐帧 focus 会把光标抢得没法输入
        setTimeout(() => edRef.current?.focus({ caret: "end" }), 0);
      }
    }, 28);
  };
  const transcribeIntoDraft = async (blob: Blob) => {
    const token = voiceToken.current;
    const result = await transcribeVoice(blob);
    if (token !== voiceToken.current) return;
    if (result.ok && result.text) typeIntoDraft(result.text);
    else store.toast(voiceErrorText(result.code, result.error));
    setVoiceSecs(0);
    setVoicePhase("idle");
  };
  const finishVoice = (blob: Blob) => {
    stopVoiceTick();
    voiceCap.current = null;
    setVoicePhase("transcribing");
    void transcribeIntoDraft(blob);
  };
  const toggleVoice = async () => {
    if (voicePhase === "transcribing" || voiceStarting.current) return;
    if (voicePhase === "recording") {
      const cap = voiceCap.current;
      // 到时长上限自动结束时 finishVoice 已经接管，这次点击直接忽略
      if (!cap) return;
      voiceCap.current = null;
      stopVoiceTick();
      setVoicePhase("transcribing");
      let blob: Blob | null = null;
      try { blob = await cap.stop(); } catch { blob = null; }
      if (!blob) { setVoiceSecs(0); setVoicePhase("idle"); return; }
      await transcribeIntoDraft(blob);
      return;
    }
    voiceStarting.current = true;
    stopVoiceTyping();
    setVoiceSecs(0);
    try {
      const cap = await startVoiceCapture({ maxSeconds: 90, onAutoStop: finishVoice });
      if (!voiceAlive.current) { cap.cancel(); return; }
      voiceCap.current = cap;
      setVoicePhase("recording");
      voiceTick.current = window.setInterval(() => setVoiceSecs((n) => Math.min(90, n + 1)), 1000);
    } catch (error) {
      const err = error as { name?: string; message?: string } | null;
      store.toast(voiceErrorText(err?.name, err?.message));
    } finally {
      voiceStarting.current = false;
    }
  };
  // 面板收起 / 切画布时别把麦克风一直开着：卸载直接取消
  useEffect(() => {
    voiceAlive.current = true;
    return () => {
      voiceAlive.current = false;
      voiceToken.current += 1;
      stopVoiceTyping();
      stopVoiceTick();
      voiceCap.current?.cancel();
      voiceCap.current = null;
    };
  }, []);
  // 同一个 seq 只处理一次：技能列表异步回来会让这个 effect 再跑，重填会把刚发出去的话又塞回输入框
  const handledDraft = useRef(0);
  /** 种子里的 skillRef 先到、技能列表后到时暂存在这，等 a.skills 回来再补胶囊 */
  const pendingSkillRef = useRef<string | null>(null);
  /** 暂存的技能补上时要不要顺手插胶囊：只有不自动发送的草稿才插（自动发送的话早就发出去了） */
  const pendingSkillChip = useRef(false);
  useEffect(() => {
    if (!draft?.seq || handledDraft.current === draft.seq) return;
    handledDraft.current = draft.seq;
    const text = draft.text;
    store.setUI({ agentOpen: true });
    // 技能是可选的：首页输入框来的种子只有文字，技能列表里查不到不能把整条草稿丢掉
    if (draft.skill && a.skills.some((skill) => skill.name === draft.skill)) a.skill = draft.skill;
    // 应用市场「在新画布里使用」带的是 skillRef（内置技能 = id，市场技能 = store:<id>）：现在查得到就挂上，
    // 查不到（技能列表还在拉）先记下，交给下面那个 effect 补；一直查不到就静默忽略，不动草稿
    let chipName: string | null = null;
    if (draft.skillRef && !a.skill) {
      const name = matchSkillRef(draft.skillRef, a.skills);
      if (name) { a.skill = name; chipName = name; } else { pendingSkillRef.current = draft.skillRef; pendingSkillChip.current = !draft.autoSend; }
    }
    // 不自动发送的草稿（应用市场「试试这样说」）：技能要在输入区看得见，跟 / 选技能一样在最前面插一个技能胶囊
    setDraft(!draft.autoSend && chipName ? withSkillChip(text, chipName) : text);
    if (!draft.autoSend) return;
    // 没有对话模型时后端必定报错：把话留在输入框并提示，比发出去再弹一条错误更像人话
    if (!store.state.models.some((model) => model.kind === "text")) { store.toast("还没有配置对话模型，这句话已留在输入框"); return; }
    // send() 自己会接住大部分失败（写进对话错误条），这里只兜线程创建这种抛出来的情况
    void send().catch((error: unknown) => {
      a.draft = text; a.emit();
      store.toast("自动发送失败，这句话已留在输入框：" + (error instanceof Error ? error.message : "未知错误"));
    });
  }, [draft?.seq, a.skills, a, store]);
  useEffect(() => {
    const ref = pendingSkillRef.current;
    if (!ref) return;
    const name = matchSkillRef(ref, a.skills);
    if (!name) return;
    pendingSkillRef.current = null;
    if (!a.skill) { a.skill = name; if (pendingSkillChip.current && !a.busy) a.draft = withSkillChip(a.draft, name); a.emit(); }
    pendingSkillChip.current = false;
  }, [a.skills, a]);
  // 按消息归属的线程刷新：后台任务回来也不会改到当前对话
  const patch = (m: AgentMsg, p: Partial<AgentMsg>) => a.patchMessage(m, p);
  const stream = async (m: AgentMsg, full: string) => { patch(m, { streaming: true, text: "" }); const step = Math.max(2, Math.round(full.length / 40)); for (let k = 0; k < full.length; k += step) { if (a.stop) break; patch(m, { text: full.slice(0, k) }); await sleep(24); } patch(m, { text: full, streaming: false }); };

  /** 回复里带 ```novai-questions 时变成问答卡（旧会话里的 ```openarc-questions 也认），代码块不显示 */
  function withQuestions(m: AgentMsg, text: string) {
    const parsed = parseQuestions(text); if (!parsed) return text;
    if (!m.qa) m.qa = newCard(a.goalBefore(m), parsed.questions, parsed.kind, parsed.regen);
    return parsed.rest || "开始之前想先确认几件事：";
  }
  const answerQa = (m: AgentMsg, card: QaCard, skip: boolean) => {
    if (a.busy) return;
    const hasRegen = card.kind === "confirm" && !!card.regen?.items.length;
    // 结果确认卡：写了描述 / 选了「重新生成」「不满意，需要重做」→ 直接让后端改提示词重跑，不再发一轮对话
    if (hasRegen && !skip) {
      const { description, regenerate: wants } = confirmFeedback(card);
      if (description || wants) {
        void regenerate(m, regenTargets(card, (m.reviews || []).flatMap((r) => r.items)), description);
        return;
      }
    }
    patch(m, { qa: { ...card, status: skip ? "skipped" : "answered" } });
    a.draft = skip ? (card.kind === "confirm" ? (hasRegen ? "先用这批结果继续。" : "结果符合要求，继续下一步。") : `不用再问了，按你的理解直接做：${card.goal}`) : answerText(card); void send(true);
  };

  /** 没有一键重生成接口（旧桌面后端 / 浏览器预览）：把要求放进输入框，走原来的「发一条指令让 Agent 自己改」 */
  function regenerateFallback(m: AgentMsg, description: string, names: string) {
    if (m.qa && m.qa.status === "answered") m.qa = { ...m.qa, status: "open" };
    a.draft = description ? `按我的描述重新生成这些结果：${names}（${description}）` : `重新生成这些结果：${names}`;
    store.toast("当前后端不支持一键重新生成，已把要求放进输入框");
    a.emit();
    void send(true);
  }

  /** 审查不合格 → 让后端改提示词并立刻重跑（跑完自动复审再问）；旧后端不支持时退回成一段指令发给 Agent */
  async function regenerate(m: AgentMsg, items: AgentRegenerateItem[], description: string) {
    if (a.busy) return;
    const threadId = a.activeThreadId || "__new__";
    const list = items.filter((it) => !!it.node_id);
    if (!list.length) return;
    const desc = description.trim();
    const names = list.slice(0, 6).map((it) => it.label || it.node_id).join("、");
    if (!store.backend.regenerateAgentResults) { regenerateFallback(m, desc, names); return; }
    const ask: AgentMsg = { id: mid(), role: "u", text: desc ? "按我的描述重新生成：" + desc : "重新生成审查不合格的 " + list.length + " 个结果：" + names, at: Date.now() };
    const m2: AgentMsg = { id: mid(), role: "a", text: "", at: Date.now(), think: { live: true, open: false, secs: "0", lines: ["按审查意见改提示词，重新生成 " + list.length + " 个结果"] } };
    a.appendMessages([ask, m2], threadId);
    // 这条消息上还开着的问答卡：已经用「重新生成」处理过了，标成已回答
    if (m.qa && m.qa.status === "open") m.qa = { ...m.qa, status: "answered" };
    a.setThreadBusy(threadId, true); a.setThreadStop(threadId, false); a.emit();
    const t0 = performance.now();
    try {
      // 后端要改画布节点参数：先把本地没存完的改动存掉 / 对齐（否则改完 refreshAuthoritative 会撞版本或冲掉用户的拖动）
      await syncBeforeAgentWrite(store);
      const res = await store.backend.regenerateAgentResults({ canvasId: store.state.canvasId, threadId: threadId || undefined, description: desc || undefined, items: list });
      if (!res.ok || !res.taskId) throw new Error(res.error || "重新生成失败");
      patch(m2, { task: { taskId: res.taskId, status: res.status || "RUNNING" }, text: "" });
      watchTask(m2, res.taskId, t0, threadId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "重新生成失败";
      // 后端没有这个接口：撤掉刚才这两条，退回「输入框 + 发指令」，不留下重复的对话
      if (/TASK_UNAVAILABLE|HTTP (404|405|501)/.test(reason)) {
        a.setThreadMessages(a.threadMessages(threadId).filter((msg) => msg.id !== ask.id && msg.id !== m2.id), threadId);
        a.setThreadBusy(threadId, false);
        regenerateFallback(m, desc, names);
        return;
      }
      if (!m2.took) m2.took = (performance.now() - t0) / 1000;
      patch(m2, { think: m2.think ? { ...m2.think, live: false } : undefined, error: reason });
      a.setThreadBusy(threadId, false); a.emit();
    }
  }

  function watchTask(m: AgentMsg, taskId: string, t0: number, threadId: string) {
    let refreshed = ""; let refreshOutcome: RefreshOutcome = "not_required";
    let terminalHandled = false;
    let self: { stop?: () => void } | null = null;
    const watcher = subscribeAgentTask(store.backend, taskId, (snapshot) => {
      // 同一条消息可能先后挂过两个任务（先出方案、再执行）。旧任务的 watcher 在宽限轮询里还会回来，
      // 它会和新任务交替把 plan / heartbeat / busy 翻来翻去：卡片一出现一消失，整列消息上下跳。
      if (m.task?.taskId && m.task.taskId !== taskId) { self?.stop?.(); return; }
      const settled = TASK_UI_SETTLED.has(snapshot.status);
      const firstTerminal = settled && !terminalHandled;
      const effect = settled ? "terminal" : snapshot.events.filter((e) => /side_effect\.succeeded|execution\.succeeded/.test(String(e.eventType))).map((e) => String(e.eventId)).join(",");
      if (effect && effect !== refreshed && (snapshot.status === "SUCCEEDED" || snapshot.status === "COMPLETED")) refreshOutcome = "pending";
      // 待确认的方案：状态是「跑完了」但一步都没执行，必须说清「还没动画布」并给出执行入口
      const plan = taskPendingPlan(snapshot);
      const answer = plan
        ? (plan.kind === "generation" ? plan.summary || "节点已经放到画布上了，选好模型后点「执行生成」。" : "方案已生成（" + plan.steps.length + " 步），点下面的「执行」才会真的在画布上执行；" + (plan.summary || ""))
        : withQuestions(m, taskAnswer(snapshot, refreshOutcome));
      // 搜图 / 反图工具的结果（tool.execution.succeeded 的 safePayload.result.items）在这里变成参考图选择卡
      const images = webImageCards(snapshot);
      // 联网搜索：结果变成下面的搜索卡，同一次搜索就不在「处理过程」里再留一行「联网搜索」步骤
      const searches = webSearchCards(snapshot);
      const searchCalls = new Set(searches.map((card) => card.key));
      const steps = taskToolSteps(snapshot).filter((step) => !(step.callId && searchCalls.has(step.callId)));
      // 执行进度清单：方案步骤（每轮 plan）+ step 事件对账，运行中逐项打勾；空快照不覆盖已有清单
      const checklist = taskChecklist(snapshot);
      // 思考过程：后端每轮的 thought 事件（整体方案 + 每轮判断），运行中实时更新
      const thoughtRows = taskThoughtRows(snapshot);
      const thoughts = thoughtRows.length ? thoughtRows.map((row) => row.text) : (m.think?.lines || []);
      const kinds = thoughtRows.length ? thoughtRows.map((row) => row.kind) : m.think?.kinds;
      // 终态后的审查宽限刷新只更新审查卡，思考时长/展开状态保持第一次终态的样子
      const think = settled && !firstTerminal
        ? m.think
        : { live: !settled, open: false, secs: ((performance.now() - t0) / 1000).toFixed(1), lines: thoughts, kinds };
      // 阶段三·3：完成前自检（self_check 事件，在最终 message 之前）；没有事件就保持原值 = 不渲染
      const selfCheck = taskSelfCheck(snapshot);
      // 阶段四：托管额度用完 / 将尽 → 弹授权卡（补额度或结束）；同一条事件只弹一次
      const budgetRequired = taskBudgetRequired(snapshot);
      // 阶段四：下一步建议芯片（done / 结论 message 里才带；没有就保持原值 = 不渲染）
      const suggestions = taskSuggestions(snapshot);
      // 长任务心跳：运行中一行轻状态；settled 后清掉
      const heartbeat = taskHeartbeat(snapshot);
      if (budgetRequired) {
        const runId = m.task?.taskId || taskId;
        const key = "budget:" + runId + ":" + String(budgetRequired.round ?? budgetRequired.used ?? snapshot.events.length);
        if (!handledBudget.current.has(key)) {
          handledBudget.current.add(key);
          setAuthCard({ runId, reason: "budget_required", initial: budgetRequired, key });
        }
      }
      const reviews = taskReviews(snapshot);
      // 阶段三流式：原生推理逐字（reasoning_delta）+ 回复逐字（message_delta）；开关关闭时两者都是空串，行为与之前一致
      const reasoning = taskReasoning(snapshot);
      const streamed = taskMessageStream(snapshot);
      // 上下文事件（NOVAI_AGENT_V2_CONTEXT 开启才有）：真实分层占用 + 「已整理上下文」提示；没有就保持 null / 原样
      const usage = contextUsageOf(snapshot.events);
      const compactions = contextCompactionsOf(snapshot.events);
      // 收尾：有流式正文就用它（平台一次性给整段时也是同一条路径，不会「闪一下再重画」）；方案卡 / 兜底文案仍走 answer
      const nextText = settled ? (plan || !streamed ? (answer || m.text) : streamed) : (streamed || m.text);
      patch(m, { heartbeat: settled ? undefined : (heartbeat || m.heartbeat), suggestions: suggestions.length ? suggestions : m.suggestions, task: { taskId, status: snapshot.status, modelConfigId: snapshot.modelConfigId, stopRequested: m.task?.stopRequested, plan, checklist: checklist.length ? checklist : m.task?.checklist }, reviews: reviews.length ? reviews : m.reviews, tools: steps, webImages: images.length ? images : m.webImages, webSearch: searches.length ? searches : m.webSearch, usage: usage || m.usage, compactions: compactions.length ? compactions : m.compactions, reasoning: reasoning || m.reasoning, selfCheck: selfCheck || m.selfCheck, text: nextText, streaming: !settled && !!streamed, think, took: settled ? (firstTerminal ? Math.max(Number(m.took) || 0, (performance.now() - t0) / 1000) : m.took) : m.took });
      // 只有「当前线程最后一条」的 watcher 能改 busy：旧任务的 watcher 在宽限轮询里还会回来，
      // 它会和正在跑的任务互相把 busy 翻成 true/false，面板跟着反复重排（上下抽动的真凶之一）。
      const threadList = a.threadMessages(threadId);
      const latest = threadList.length ? threadList[threadList.length - 1] : null;
      if (!latest || latest.id === m.id) a.setThreadBusy(threadId, !settled);
      a.setThreadStop(threadId, false); a.emit();
      // L5：结束后这一轮没有可见回复（快照里既没有流式正文也没有 done 文案）→ 直接读一次线程。
      // 后端在收尾时已经把回复落盘，读回来就能显示，不用让用户刷新页面。
      if (firstTerminal && !nextText && threadId && threadId !== "__new__") {
        void a.loadThreadMessages(threadId).then((ok) => { if (ok) a.emit(); });
      }
      // 这一轮结束时后端已经把问答追加进线程：刷新列表里的条数 / 时间
      // 该对话还有排队消息就在它自己的线程里 260ms 后自动发下一条（当前看的是别的对话也照发）
      if (firstTerminal) { void a.loadThreads(); scheduleFlush(threadId); }
      // 回复结束后按 5s/15s/40s/90s/180s 的退避节奏找记忆候选（后台摘要可能要几分钟）；卡片挂在这条回复下面
      if (firstTerminal && threadId === (a.activeThreadId || "__new__") && ui.agentOpen) startMemoryPoll(threadId === "__new__" ? "" : threadId, m.id);
      // 终态后的审查宽限刷新只补审查结论，收尾动作已经跑过一次了
      if (settled) terminalHandled = true;
      if (effect && effect !== refreshed) {
        refreshed = effect;
        // 助手建的节点只在 refreshAuthoritative 换掉文档之后才出现：先记下刷新前的 id，刷新落地再对比补焦点
        const beforeIds = nodeIdSet(store);
        void refreshForAgent(store).then((outcome) => {
          if (outcome === "refreshed") { revealAddedNodes(ctl, beforeIds); runAgentQueued(store); }
          if (refreshed !== effect || plan) return;
          refreshOutcome = outcome;
          patch(m, { text: withQuestions(m, taskAnswer(snapshot, refreshOutcome)) || m.text });
        });
      }
    }, () => taskWatchers.current.delete(taskId));
    self = watcher as unknown as { stop?: () => void };
    if (!watcher.settled()) taskWatchers.current.set(taskId, watcher.stop);
  }

  /** 退避轮询的时间点（相对回复结束）：5s / 15s / 40s / 90s / 180s —— 后台摘要可能要几分钟才写回候选 */
  const MEM_POLL_AT = [5000, 15000, 40000, 90000, 180000];
  /** 停掉所有候选轮询；令牌推进让正在飞的那次回来也不再生效 */
  function stopMemoryPoll() {
    memPollKey.current += 1;
    memTimers.current.forEach((timer) => window.clearTimeout(timer));
    memTimers.current = [];
  }
  /** 拉一次候选：找到就挂卡片；没有就等下一个时间点；接口 400（开关关闭）就彻底别问了。全程不弹提示。 */
  async function fetchMemoryCandidatesOnce(threadId: string, msgId: string): Promise<"found" | "empty" | "stop"> {
    const canvasId = store.state.canvasId;
    if (!canvasId) return "stop";
    let result;
    try { result = await fetchMemoryCandidates({ canvasId, threadId }); }
    catch (error) {
      return error instanceof MemoryCandidatesError && error.status === 400 ? "stop" : "empty";
    }
    const handled = memHandled.current;
    const items = result.items.filter((item) => !handled.has(item.id) && !result.confirmed_ids.includes(item.id));
    if (!items.length) return "empty";
    setMemCand({ threadId, msgId, items });
    return "found";
  }
  /** 回复结束后按退避节奏找候选；拿到卡 / 400 / 切对话 / 面板收起 都会把剩下的定时器清掉 */
  function startMemoryPoll(threadId: string, msgId: string) {
    stopMemoryPoll();
    const key = memPollKey.current;
    const debug = new URLSearchParams(location.search).has("debugMemoryCandidates");
    // 验收口：debug 下第一次提前到 1.5s（真实链路仍是 5s 起），截图不用干等
    const schedule = debug ? [1500, 5000, 15000, 40000, 90000, 180000] : MEM_POLL_AT;
    schedule.forEach((delay) => {
      const timer = window.setTimeout(async () => {
        if (key !== memPollKey.current) return;
        if ((a.activeThreadId || "") !== threadId || !memOpenRef.current) return;   // 切走对话 / 面板收起：不再问
        const outcome = await fetchMemoryCandidatesOnce(threadId, msgId);
        if (key !== memPollKey.current) return;
        if (outcome === "found" || outcome === "stop") stopMemoryPoll();
      }, delay);
      memTimers.current.push(timer);
    });
  }
  /** 只把勾选的写进长期记忆；成功后卡片收起并提示 */
  async function confirmMemory(ids: string[]) {
    if (!memCand || !ids.length) return;
    const threadId = memCand.threadId;
    setMemBusy(true);
    try {
      const result = await confirmMemoryCandidates({ canvasId: store.state.canvasId, threadId, ids });
      ids.forEach((id) => memHandled.current.add(id));
      setMemCand(null);
      store.toast("已记住 " + (result.saved || ids.length) + " 条");
    } catch (error) {
      store.toast("没记住：" + (error instanceof Error ? error.message : "未知错误"));
    } finally { setMemBusy(false); }
  }
  /** 用户明确说不用：先收起卡片，再尽力通知后端标记忽略（失败也不反复问） */
  async function dismissMemory() {
    if (!memCand) return;
    const threadId = memCand.threadId;
    const ids = memCand.items.map((item) => item.id);
    ids.forEach((id) => memHandled.current.add(id));
    setMemCand(null);
    setMemBusy(true);
    try { await dismissMemoryCandidates({ canvasId: store.state.canvasId, threadId, ids }); }
    catch (error) { store.toast("已收起，但同步给服务端失败：" + (error instanceof Error ? error.message : "未知错误")); }
    finally { setMemBusy(false); }
  }
  /** 换对话 / 收起面板：停掉轮询并收起上一张卡（再回来时会重新拉一次） */
  useEffect(() => {
    stopMemoryPoll();
    memOneShotKey.current = "";
    setMemCand(null);
    return () => stopMemoryPoll();
  }, [a.activeThreadId, ui.agentOpen]);

  /** 阶段四：面板收起时，定时看一眼前端线程里有没有新的「助手主动消息」（origin=agent）；有就用现有 Toast 提示，点开面板 */
  const agentSeen = useRef<string>("");
  useEffect(() => {
    if (ui.agentOpen || !a.activeThreadId) return;
    let active = true;
    const check = async () => {
      if (!active || a.busy) return;
      const threadId = a.activeThreadId; if (!threadId) return;
      await a.loadThreadMessages(threadId);
      if (!active) return;
      const agentMsgs = a.threadMessages(threadId).filter((msg) => msg.role === "a" && msg.origin === "agent");
      const last = agentMsgs[agentMsgs.length - 1];
      if (!last) return;
      if (!agentSeen.current) { agentSeen.current = last.id; return; }   // 首次只记基线，不打扰
      if (last.id !== agentSeen.current) {
        agentSeen.current = last.id;
        store.toast((last.text || "助手发来一条消息").replace(/\s+/g, " ").slice(0, 48), 4200, () => store.setUI({ agentOpen: true }));
      }
    };
    const timer = setInterval(() => void check(), 20000);
    void check();
    return () => { active = false; clearInterval(timer); };
  }, [ui.agentOpen, a.activeThreadId]);
  /** 打开某条对话 / 历史刚载完：立即拉一次；挂到「当时最后一条助手消息」下面 */
  useEffect(() => {
    if (a.busy || !ui.agentOpen || !a.msgs.length) return;
    const threadId = a.activeThreadId || "";
    const debug = new URLSearchParams(location.search).has("debugMemoryCandidates");
    if (!threadId && !debug) return;
    const lastAssistant = [...a.msgs].reverse().find((msg) => msg.role === "a");
    if (!lastAssistant) return;
    const key = threadId + ":" + lastAssistant.id;
    if (key === memOneShotKey.current) return;
    memOneShotKey.current = key;
    if (debug) {
      // 验收口：debug 下没有真实 run，用同一个轮询入口模拟「回复结束」的节奏
      if (!memTimers.current.length) startMemoryPoll(threadId, lastAssistant.id);
      return;
    }
    void fetchMemoryCandidatesOnce(threadId, lastAssistant.id);
  }, [a.activeThreadId, ui.agentOpen, a.msgs.length]);

  /** 方案卡「执行」：把批准的步骤交回后端跑一次真的执行（写操作闸门只认 approved_steps） */
  async function approvePlan(m: AgentMsg, approved?: AgentTaskPlan["steps"]) {
    const task = m.task; const steps = approved && approved.length ? approved : task?.plan?.steps || [];
    if (!task || !steps.length || a.busy) return;
    if (!store.backend.approveAgentTask) { patch(m, { error: "当前后端不支持执行方案" }); return; }
    const threadId = a.activeThreadId || "__new__";
    a.setThreadBusy(threadId, true); a.setThreadStop(threadId, false);
    const isGen = task.plan?.kind === "generation";
    patch(m, { task: { ...task, status: "RUNNING", plan: null }, error: undefined, text: isGen ? "已按你选的模型和参数开始生成…" : "已批准这份方案，正在画布上执行 " + steps.length + " 步…" });
    try {
      // 同节点多组（countGroup 标记）：先把按序队列写进本地画布 → syncBeforeAgentWrite 会一起存到服务端，
      // 这样画布在 agent 运行后刷新权威文档也不会丢队列（服务端 agentRun 标记只留最后一个，不能靠它去重）。
      const groups = countGroupQueue(steps);
      if (groups.size) {
        for (const [nodeId, items] of groups) {
          if (!store.node(nodeId)) continue;
          const rows = items.map((item) => ({ index: item.index, settings: item.settings }));
          rememberCountQueue(store.state.canvasId, nodeId, rows);   // 内存队列（不依赖画布文档持久化）
          store.updateNode(nodeId, (x) => ({ ...x, data: { ...((x.data as Record<string, unknown>) || {}), agentRunQueue: rows } }), { history: false });
        }
      }
      if (isGen) await syncBeforeAgentWrite(store);
      const res = await store.backend.approveAgentTask(task.taskId, steps);
      if (!res.ok || !res.taskId) {
        patch(m, { task: { ...task, status: task.status }, error: res.error || "方案执行失败" });
        return;
      }
      patch(m, { task: { taskId: res.taskId, status: res.status || "RUNNING" } });
      // 执行任务接管这条消息：先把「出方案」那个任务的 watcher 停掉，避免两个任务交替刷新同一条消息
      if (task.taskId) taskWatchers.current.get(task.taskId)?.();
      watchTask(m, res.taskId, performance.now(), threadId);
    } finally {
      if (!m.task || TASK_UI_SETTLED.has(m.task.status)) a.setThreadBusy(threadId, false);
      a.emit();
    }
  }

  async function inspectRepository(m: AgentMsg, source: string) {
    try {
      const preview = await inspectSkillRepository(source);
      patch(m, { skillInstall: { status: "ready", source, preview }, think: { live: false, open: false, secs: "0", lines: ["已固定公开仓库版本并检查 Skill 内容，尚未安装"] } });
    } catch (error) {
      patch(m, { skillInstall: { status: "error", source, error: error instanceof Error ? error.message : "仓库读取失败" }, think: { live: false, open: false, secs: "0", lines: ["仓库预览未完成，没有安装"] } });
    }
  }

  async function confirmRepositoryInstall(m: AgentMsg) {
    const current = m.skillInstall;
    if (!current?.preview || !["ready", "error"].includes(current.status) || a.busy) return;
    const threadId = a.activeThreadId || "__new__";
    a.setThreadBusy(threadId, true);
    patch(m, { skillInstall: { ...current, status: "installing", error: undefined } });
    try {
      const installed = await installSkillPreview(current.preview.previewId);
      await a.loadSkills();
      patch(m, { skillInstall: { ...current, ...installed, status: "installed", error: undefined } });
    } catch (error) {
      patch(m, { skillInstall: { ...current, status: "error", error: error instanceof Error ? error.message : "导入失败" } });
    } finally {
      a.setThreadBusy(threadId, false); a.emit();
    }
  }

  function cancelRepositoryInstall(m: AgentMsg) {
    if (!m.skillInstall || a.busy) return;
    patch(m, { skillInstall: { ...m.skillInstall, status: "cancelled", error: undefined } });
  }

  /** 发一条消息。outgoing = 队列里的上下文快照（文本 / 技能 / 引用 / 固定与选中节点 / 联网），
   *  此时不发完清空草稿——用户可能正在输入下一条。 */
  async function send(fromQa = false, outgoing?: QueuedMsg["snap"], targetThreadId?: string) {
    // 发起时就捕获线程：正常发送用当前对话，后台队列自动发送用目标对话；
    // 消息 / busy / 任务归属都记在这条对话上，之后切走也不会串。
    const target = targetThreadId || "";
    let threadId = target || a.activeThreadId;
    // 后台队列自动发送不打断用户正在做的语音输入
    if (!target) stopVoiceTyping();
    const refs = outgoing ? outgoing.refs : a.refs;
    // 建议芯片 / 快捷动作的直传文本：取一次就清掉（同步读取，不依赖 draft 状态 / React flush）
    const direct = directSendText.current ?? undefined;
    directSendText.current = null;
    const rawText = pickSendText(direct, outgoing, a.draft);
    const skillName = outgoing ? outgoing.skill : a.skill;
    // 气泡 / 线程用保留 @skill{…} 记号的版本：技能胶囊留在用户当时放的位置（行内）；
    // 发给后端的 goal 仍去掉记号，提示词跟改前一致（技能正文走 context.skillPrompt）。
    const text = plainMentionText(rawText, (kind, id) => chipFor(refs, kind, id), { keepSkill: true });
    let goalText = plainMentionText(rawText, (kind, id) => chipFor(refs, kind, id));
    const skill = skillName ? a.skills.find((s) => s.name === skillName) || null : null;
    // 同一对话内仍串行：当前对话看 a.busy，后台队列发送看目标对话自己的忙闲
    if ((!goalText && !skill) || (target ? a.isThreadBusy(target) : a.busy)) return; if (!goalText) goalText = skill!.desc;
    // 图片标注属于当前对话的输入区：后台队列自动发送不能把当前对话的标注塞进别人的消息
    const annBlock = !target && annChat.length ? annotationsPrompt(annChat) : "";
    // 验收口：?debugBusy / ?debugQueue 只在前端内存里模拟一轮执行，不建线程、不请求后端
    const simMs = debugSimMs();
    if (simMs > 0) { const tId = threadId || "__new__"; debugSimulateSend(a, text, skillName, simMs, tId, () => scheduleFlush(tId)); return; }
    let sendModelId = activeModelId;
    if (!sendModelId && store.backend.runAgentTask) {
      // L5：刚打开画布 2–3 秒内发的第一条消息，模型清单可能还在加载——先等它一会儿再判断，
      // 不能因为「这会儿还没拿到模型」就把用户的第一条消息吞掉（表现就是发了没反应）。
      for (let i = 0; i < 24 && !store.state.models.length; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 125));
      }
      const chatNow = store.state.models.filter((m) => m.kind === "text");
      const fallbackModel = selectedModelId
        || (chatNow.some((m) => m.id === defaultModelId) ? defaultModelId : null)
        || chatNow[0]?.id || null;
      if (!fallbackModel) {
        // 确实没有可用对话模型：不发送，直接把模型菜单打开让用户选（选完再按发送）
        const anchor = document.getElementById("aModel"); if (anchor) modelMenu(anchor);
        store.toast(chatNow.length ? "先选一个对话模型，再发送" : "还没有配置对话模型，先到 API 设置里添加"); return;
      }
      sendModelId = fallbackModel;
    }
    // 第一次在这张画布上说话：先让后端建一条线程，这样本轮问答会写进历史
    if (a.threadsSupported() && !threadId && !target) threadId = (await a.ensureThread()) || "";
    const tId = threadId || "__new__";
    const installSource = skillInstallIntent(goalText);
    const ctx = ctxNodes(outgoing ? { pinned: outgoing.pinned, selected: outgoing.selected } : undefined).map((x) => x.n);
    const web = outgoing ? outgoing.webPlugin : webPlugin;
    // 消息里的引用：输入框记号（最权威）+ 顶部胶囊 / 选中节点 + 素材应用，按 id 去重后一起带上
    const tokenCtx: NonNullable<AgentMsg["ctx"]> = [];
    for (const t of parseMentionTokens(rawText)) {
      if (t.kind === "skill") continue;
      if (t.kind === "node") { const n = store.node(t.id); if (n) tokenCtx.push({ id: n.id, title: refLabel(n), kind: n.kind, src: displaySrc(store.state.doc.nodes, n) || undefined }); continue; }
      const ref = refs.find((r) => r.id === t.id);
      if (ref) tokenCtx.push({ id: ref.id, title: ref.title, kind: ref.kind, src: ref.kind === "asset" ? ref.ref : undefined });
    }
    const msgCtx: NonNullable<AgentMsg["ctx"]> = [...tokenCtx,
      ...ctx.map((n) => ({ id: n.id, title: refLabel(n), kind: n.kind, src: displaySrc(store.state.doc.nodes, n) || undefined })),
      ...refs.map((r) => ({ id: r.id, title: r.title, kind: r.kind, src: r.kind === "asset" ? r.ref : undefined })),
    ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);
    const userMsgId = mid();
    a.appendMessage({ id: userMsgId, role: "u", text, at: Date.now(), skill: skillName || undefined, ctx: msgCtx }, tId);
    if (!outgoing && !target) window.dispatchEvent(new CustomEvent("cn:agent-send", { detail: { id: userMsgId } }));
    if (!outgoing) { a.draft = ""; a.pinned = []; a.refs = []; a.skill = null; setWebPlugin(false); if (annChat.length) setAnnChat([]); }
    a.setThreadStop(tId, false); a.setThreadBusy(tId, true);
    const m: AgentMsg = { id: mid(), role: "a", text: "", at: Date.now(), think: { live: true, open: false, secs: "0", lines: [] }, ...(installSource ? { skillInstall: { status: "inspecting" as const, source: installSource } } : {}) }; a.appendMessage(m, tId); a.emit();
    const t0 = performance.now();
    const imageNodeForModel = ctx.find((n) => n.kind === "image") || null;
    const imageSpec = (imageNodeForModel ? store.modelOf(imageNodeForModel) : undefined) || store.defaultModel("image");
    const imageConfigId = imageSpec?.id || "";
    const imageSplit = imageConfigId.indexOf("::");
    const imageProvider = imageSplit >= 0 ? imageConfigId.slice(0, imageSplit) : "";
    const imageModel = imageSplit >= 0 ? imageConfigId.slice(imageSplit + 2) : imageConfigId;
    /* 引用现在只以胶囊存在（输入框里没有 @名称）：
       task/run 走 canvasContext.selectedNodeIds + resourceRefs，不解析文本；
       但 chat 回退 / 记忆这类「只有文字」的路径会丢引用，所以把引用清单隐性附到 goal 尾部。 */
    const refSeen: Record<string, number> = {};
    const refDigest = [...ctx.map((n) => { const k = n.kind === "image" ? "图" : n.kind === "video" ? "视频" : n.kind === "text" ? "文本" : n.kind === "audio" ? "音频" : "节点"; refSeen[k] = (refSeen[k] || 0) + 1; return k + refSeen[k] + "=" + refLabel(n) + "（" + n.id + "）"; }), ...refs.map((r) => (r.kind === "app" ? "应用=" + r.title + "（工具名 " + r.ref + "）" : "素材=" + r.title))].join("；");
    const apps = refs.filter((r) => r.kind === "app").map((r) => ({ name: r.ref, title: r.title, description: r.detail || "" }));
    try {
      if (installSource) { await inspectRepository(m, installSource); return; }
      if (/^(请)?(记住|记一下|以后都|下次)/.test(goalText)) {
        const fact = goalText.replace(/^(请)?(记住|记一下)[，,：: ]*/, ""); const scope = /这张画布|本画布|这个项目|产品/.test(goalText) ? "canvas" : "user";
        // L1：走 /api/memories 这一个入口 → 后端同时写记忆库、画布记忆（索引 + 档案 prefs，同一处去重），
        // 并把这一轮对话写进线程；回复文案由服务端给，面板显示的和线程里存的是同一句。
        const saved = await a.addMemory(scope, fact, { threadId: tId, userText: text });
        patch(m, { think: { live: false, open: false, secs: ((performance.now() - t0) / 1000).toFixed(1), lines: [] }, tools: [{ label: `写入${scope === "user" ? "用户" : "画布"}记忆`, state: "done", secs: "0.1" }], memSaved: { scope: scope === "user" ? "用户" : "画布", text: fact } });
        await stream(m, saved.reply || (a.memOn ? "记住了，之后的对话和生成都会参考这条。" : "记住了。注意：记忆目前是关闭的，打开后才会在对话里使用。")); return;
      }
      if (store.backend.runAgentTask) {
        // 技能正文走 context.skillPrompt（后端放进系统提示），goal 里只留一句点名，避免长技能被截断
        const goal = (goalText + annBlock + (refDigest ? "\n\n本轮引用（按顺序，图N/视频N/文本N 对应画布节点）：" + refDigest : "") + (web ? "\n\n本轮请联网搜索公开网页并读取正文，作为参考后再回答。" : "") + (skill ? "\n\n本轮按技能「" + skill.name + "」来做。" : "")).slice(0, 3900);
        const resourceRefs = [...ctx.map((n) => isGenKind(n.kind) ? srcOf(n) : ""), ...refs.filter((r) => r.kind === "asset").map((r) => r.ref)].filter((ref) => /^(novai-asset:|openarc-asset:|resource:\/\/)/.test(ref)).slice(0, 32);
        const submitted = await store.backend.runAgentTask({ goal, context: { schemaVersion: 1, canvasId: store.state.canvasId, threadId: threadId || undefined, selectedNodeIds: ctx.map((n) => n.id).slice(0, 32), threadText: text, resourceRefs, completionConditions: ["完成用户目标；画布写入必须经受控工具批准并读回验证"], modelConfigId: sendModelId || undefined, thinkLevel: thinkLevel || undefined, imageProvider, imageModel, skillName: skill?.name || undefined, skillPrompt: skill ? (skill.md || skill.desc) : undefined, apps: apps.length ? apps : undefined, thinking: fromQa && a.thinking !== "off" ? "light" : a.thinking, autonomy: a.mode === "auto" ? "auto" : a.mode === "managed" ? "managed" : "collab", mode: a.mode === "manual" ? "plan" : "run" } });
        if (!submitted.ok || !submitted.taskId) throw new Error(submitted.error || "任务提交失败");
        patch(m, { task: { taskId: submitted.taskId, status: submitted.status || "PENDING" }, think: { live: true, open: false, secs: "0", lines: [] }, text: "" });
        // 托管：开跑前先弹授权卡（预算 + 平台/模型），确认后再让后端按预算推进
        if (a.mode === "managed") setAuthCard({ runId: submitted.taskId, reason: "start", key: "start:" + submitted.taskId });
        watchTask(m, submitted.taskId, t0, tId); return;
      }
      // 没有任务运行时：模糊的出图 / 出视频需求先用问答卡问清楚（思考强度关闭 / 轻度时不问）
      const qs = fromQa ? null : clarifyQuestions(goalText, ctx.length + refs.length, a.thinking);
      if (qs) { patch(m, { think: { live: false, open: false, secs: ((performance.now() - t0) / 1000).toFixed(1), lines: ["需求里缺少用途、风格等关键信息，先确认"] }, qa: newCard(text, qs) }); await stream(m, "开始之前想先确认几件事，选好后我再动手："); return; }
      const ans = ruleAnswer(store, goalText, ctx);
      patch(m, { think: { live: false, open: false, secs: ((performance.now() - t0) / 1000).toFixed(1), lines: [] }, acts: ans.acts });
      await stream(m, ans.text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Agent 调用失败";
      if (!m.task && /TASK_UNAVAILABLE|HTTP (404|405|501)/.test(reason)) {
        try {
          const answer = await store.backend.chat({ canvasId: store.state.canvasId, configId: sendModelId || undefined, thinkLevel: thinkLevel || undefined, messages: [{ role: "user", content: goalText + annBlock + (refDigest ? "\n\n本轮引用：" + refDigest : "") }] }, () => undefined, new AbortController().signal);
          patch(m, { error: undefined, think: m.think ? { ...m.think, live: false } : undefined, text: withQuestions(m, answer) });
          return;
        } catch { /* 保留原始任务错误，避免覆盖更具体的原因 */ }
      }
      patch(m, { streaming: false, think: m.think ? { ...m.think, live: false } : undefined, error: reason, text: m.text || "" });
    } finally {
      if (!m.took) m.took = (performance.now() - t0) / 1000;
      if (!m.task || TASK_UI_SETTLED.has(m.task.status)) a.setThreadBusy(tId, false);
      a.emit();
    }
  }

  sendLatest.current = () => { void send(); };

  /** 托管授权确认：把平台 / 模型 / 次数上限提交给后端（POST /api/agent/runs/{run_id}/budget） */
  const confirmBudget = async (draft: AutonomyBudget) => {
    if (!authCard) return;
    const body = { image: draft.image, video: draft.video, audio: draft.audio, limit: draft.limit };
    setAuthBusy(true);
    try {
      const backend = store.backend;
      const result = backend.postAgentBudget ? await backend.postAgentBudget(authCard.runId, body) : { ok: false, error: "当前环境不支持托管预算" };
      if (!result.ok) { store.toast(result.error || "预算提交失败"); return; }
      handledBudget.current.add(authCard.key);
      setAuthCard(null);
      store.toast(authCard.reason === "budget_required" ? "额度已补充，继续托管" : "已开始托管");
    } finally { setAuthBusy(false); }
  };
  /** 结束托管 / 取消授权：直接停掉这次运行，保持原有收尾逻辑 */
  const endAutonomy = async () => {
    if (!authCard) return;
    const runId = authCard.runId;
    setAuthCard(null);
    if (!runId.startsWith("debug")) await store.backend.cancelAgentTask?.(runId);
    store.toast(authCard.reason === "budget_required" ? "已结束托管任务" : "已取消托管");
  };

  /** 全屏查看器「添加到对话 / 发送」：把标注挂到输入区，发送模式再自动发一条 */
  useEffect(() => {
    const on = (event: Event) => {
      const detail = (event as CustomEvent).detail as AnnotationPayload | undefined;
      if (!detail || !Array.isArray(detail.annotations) || !detail.annotations.length) return;
      setAnnChat((prev) => [...prev.filter((x) => x.nodeId !== detail.nodeId), { ...detail }]);
      const n = store.node(detail.nodeId);
      if (n) {
        if (!a.pinned.includes(n.id)) a.pinned.push(n.id);
        a.muted.delete(n.id);
        a.emit();
      }
      if (detail.mode === "send") {
        if (!a.draft.trim()) { a.draft = "按这些标注改一下"; a.emit(); }
        window.setTimeout(() => sendLatest.current?.(), 160);
      }
    };
    window.addEventListener("cn:annotations-to-chat", on);
    return () => window.removeEventListener("cn:annotations-to-chat", on);
  }, [store, a]);

  /** 往上翻加载更早的消息：插到最前面后把滚动位置补回来，眼前的内容不跳 */
  const loadEarlier = async () => {
    const vp = scrollRef.current?.querySelector<HTMLElement>(".ap2-viewport");
    const fromBottom = vp ? vp.scrollHeight - vp.scrollTop : 0;
    const n = await a.loadEarlier();
    if (!n || !vp) return;
    seen.current += n;
    requestAnimationFrame(() => { vp.scrollTop = vp.scrollHeight - fromBottom; });
  };
  // 滚到离顶部不到 120px 时自动加载更早的一页
  useEffect(() => {
    const vp = scrollRef.current?.querySelector<HTMLElement>(".ap2-viewport");
    if (!vp) return;
    const onScroll = () => { if (vp.scrollTop < 120 && a.historyHasMore && !a.loadingEarlier) void loadEarlier(); };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  });

  /** 分支对话：把到这条为止的消息复制成一段新对话，原对话存进历史 */
  const branch = (i: number) => { const keep = a.msgs.slice(0, i + 1).map((x) => ({ ...x })); a.archive(); a.msgs = keep; a.lockedModel = null; seen.current = keep.length; a.emit(); store.toast("已从这条消息分出新对话，原对话保存在对话列表里"); };

  async function stopTask() {
    const m = a.msgs.find((msg) => msg.task && !TASK_UI_SETTLED.has(msg.task.status));
    if (!m?.task) { a.stop = true; a.emit(); return; }
    patch(m, { task: { ...m.task, status: "STOPPING", stopRequested: true } });
    const res = await store.backend.cancelAgentTask?.(m.task.taskId);
    if (res && !res.ok) { patch(m, { task: { ...m.task, status: "RUNNING", stopRequested: false }, error: res.error || "停止失败" }); }
  }

  /** 忙碌时 Enter：把当前输入 + 引用快照排进队列，并清空输入区（草稿 / 胶囊 / 技能 / 联网） */
  const enqueueDraft = () => {
    stopVoiceTyping();
    const raw = a.draft;
    const label = plainMentionText(raw, (kind, id) => chipFor(a.refs, kind, id)) || (a.skill ? a.skills.find((s) => s.name === a.skill)?.desc || a.skill : "");
    if (!label) return;
    const item: QueuedMsg = {
      id: qid(), label,
      snap: { text: raw, skill: a.skill, pinned: [...a.pinned], selected: [...store.state.ui.sel], refs: a.refs.map((r) => ({ ...r })), webPlugin },
    };
    const added = enqueueQueued(a.queue, item);
    if (!added.ok) { store.toast("队列最多 " + QUEUE_MAX + " 条，等前面的发完再加"); return; }
    a.queue = added.list;
    a.draft = ""; a.pinned = []; a.refs = []; a.skill = null; setWebPlugin(false);
    a.emit();
    store.toast("已加入队列（第 " + a.queue.length + " 条）· 助手当前任务结束后自动发送");
  };
  /** 编辑：从队列取出并还原到输入区（文本保留 @ 记号，引用 / 技能 / 联网快照一起回来） */
  const editQueued = (item: QueuedMsg) => {
    a.queue = removeQueued(a.queue, item.id);
    a.draft = item.snap.text; a.skill = item.snap.skill; a.pinned = [...item.snap.pinned];
    a.refs = item.snap.refs.map((r) => ({ ...r })); setWebPlugin(item.snap.webPlugin);
    a.emit();
    store.toast("已放回输入框，改完再发");
    setTimeout(() => edRef.current?.focus({ caret: "end" }), 0);
  };
  const deleteQueued = (item: QueuedMsg) => { a.queue = removeQueued(a.queue, item.id); a.emit(); };
  /** 立即发送：空闲直接发；忙就先停掉当前任务，把这条记成优先，等空闲后最先发。
   *  忙碌时又点了一条：不覆盖还在排队的 pendingUrgent（否则前一条既不在队列也发不出去），
   *  把新的标成优先插到队首——pendingUrgent 发完就轮到它，点击顺序不丢。 */
  const sendQueuedNow = (item: QueuedMsg) => {
    a.queue = removeQueued(a.queue, item.id); a.emit();
    if (!a.busy) { void send(false, item.snap); return; }
    if (a.pendingUrgent) {
      a.queue = prependUrgent(a.queue, item); a.emit();
      store.toast("已排到优先队首，当前任务结束后马上发这条");
      return;
    }
    a.pendingUrgent = item;
    void stopTask();
    store.toast("已停止当前任务，马上发送这条");
  };
  /** 给某条对话安排一次「空闲后 260ms 自动发送」：后台对话结束 / 切回有待发队列的对话都走这里 */
  function scheduleFlush(threadId: string) {
    const tId = threadId || "__new__";
    if (flushTimers.current.has(tId)) return;
    const timer = window.setTimeout(() => { flushTimers.current.delete(tId); void flushThreadQueue(tId); }, 260);
    flushTimers.current.set(tId, timer);
  }
  /** 自动发送：先取走再发（避免重复），取「立即优先」那条，否则 FIFO 队首；只动目标对话自己的队列 */
  async function flushThreadQueue(threadId: string) {
    const tId = threadId || "__new__";
    if (queueFlushing.current.has(tId) || a.isThreadBusy(tId)) return;
    if (!debugSimMs() && !activeModelId && store.backend.runAgentTask) return;
    let item = a.threadPendingUrgent(tId);
    if (item) a.setThreadPendingUrgent(tId, null);
    else {
      const taken = takeFirst(a.threadQueue(tId));
      item = taken.first;
      if (!item) return;
      a.setThreadQueue(tId, taken.rest); a.emit();
    }
    queueFlushing.current.add(tId);
    try { await send(false, item.snap, tId); } finally { queueFlushing.current.delete(tId); }
  }
  // 当前对话刚由忙转闲、且还有排队消息：兜底自动发下一条。
  // 只认「忙变闲」这一下（不是「当前空闲」）：debug 注入的队列不会一进页面就被抽空，真实入队也只在任务结束后才发。
  // 切到某条空闲且有待发队列的对话时也安排一次（切回来队列接着跑）。
  // 定时器按对话放 ref：用户在这 260ms 里改队列 / 换模型不会把已经排好的自动发送取消掉。
  const wasBusy = useRef(a.busy);
  const lastThread = useRef(a.activeThreadId);
  useEffect(() => {
    const becameIdle = wasBusy.current && !a.busy;
    // 首次加载不算「切对话」：debug 注入的队列不会一进页面就被抽空
    const switched = !!lastThread.current && lastThread.current !== a.activeThreadId;
    wasBusy.current = a.busy;
    lastThread.current = a.activeThreadId;
    if (!a.queue.length && !a.pendingUrgent) return;
    if (!becameIdle && !(switched && !a.busy)) return;
    scheduleFlush(a.activeThreadId);
  }, [a.busy, a.queue, a.pendingUrgent, a.activeThreadId, activeModelId]);
  useEffect(() => () => { flushTimers.current.forEach((timer) => window.clearTimeout(timer)); flushTimers.current.clear(); }, []);

  /** 输入框里的记号（@{节点} / @ref{} / @app{} / @skill{}）变化 */
  /* 输入框里的 @ 胶囊不管是怎么没的（退格、点 ×、框选删除、剪切、整段改写），上面那排对应的缩略图都要跟着去掉：
     MentionInput 只在「退格 / 点 ×」时回调 onRemove，其它删法不会通知，这里按前后两版记号对账兜底 */
  const onDraftInput = (v: string) => { stopVoiceTyping();
    const now = new Set(parseMentionTokens(v).map((t) => t.kind + ":" + t.id));
    const gone = parseMentionTokens(a.draft).filter((t) => !now.has(t.kind + ":" + t.id));
    a.draft = v;
    for (const t of gone) dropMention(t.kind, t.id);
    a.emit();
  };
  /** 记号 → 胶囊内容：节点走画布文档，素材 / 应用走传入的 refs（渲染用当前引用；发送排队消息用快照里的），技能走 a.skills */
  const chipFor = (refs: AgentState["refs"], kind: MentionKind, id: string): MentionChip | null => {
    if (kind === "node") {
      const n = store.node(id); if (!n) return null;
      return { kind, id, title: refLabel(n), src: displaySrc(store.state.doc.nodes, n), icon: n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers", badge: CTX_KIND_LABEL[n.kind] };
    }
    if (kind === "skill") return { kind, id, title: id, icon: "sparkle", badge: "技能" };
    const ref = refs.find((x) => x.id === id);
    return ref ? { kind, id, title: ref.title, icon: ref.kind === "app" ? "grid" : "folder", badge: ref.kind === "app" ? "应用" : "素材" } : null;
  };
  const resolveChip = (kind: MentionKind, id: string): MentionChip | null => chipFor(a.refs, kind, id);
  /** 内联胶囊被删：同步掉顶部胶囊和引用状态 */
  const dropMention = (kind: MentionKind, id: string) => {
    if (kind === "node") { a.pinned = a.pinned.filter((x) => x !== id); a.muted.add(id); }
    else if (kind === "skill") { if (a.skill === id) a.skill = null; }
    else a.refs = a.refs.filter((x) => x.id !== id);
    a.emit();
  };
  const insertNodeChip = (n: CanvasNode) => {
    if (!a.pinned.includes(n.id)) a.pinned.push(n.id);
    a.muted.delete(n.id); a.emit();
    const chip = resolveChip("node", n.id); if (chip) edRef.current?.insertMention(chip);
  };
  const insertRefChip = (ref: { id: string; kind: "app" | "asset"; title: string; ref: string; detail?: string }) => {
    if (!a.refs.some((x) => x.id === ref.id)) a.refs = [...a.refs, { id: ref.id, kind: ref.kind, title: ref.title, ref: ref.ref, detail: ref.detail }];
    a.emit();
    const chip = resolveChip(ref.kind === "app" ? "app" : "ref", ref.id); if (chip) edRef.current?.insertMention(chip);
  };
  /** 剪贴板图片 → 画布节点 + 本次对话上下文（和「上传附件」「拖节点进输入区」同一条路径）。
   *  同时插一个 @ 记号：发出去的文字里带 @标题，刷新后历史消息能按标题反查回上下文。 */
  const pasteImages = (files: File[]) => {
    // 粘贴进来的 .zip：当技能包安装（只认技能包，别的压缩包也会按「找不到 SKILL.md」说清楚）
    files.filter((f) => /\.zip$/i.test(f.name || "") || /zip/i.test(f.type || "")).forEach((f) => { void installSkillZip(f); });
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) { if (!files.some((f) => /\.zip$/i.test(f.name || "") || /zip/i.test(f.type || ""))) store.toast("只能粘贴图片或 .zip 技能包；其它文件请用「+ → 上传附件」"); return; }
    const accepted = images.filter((f) => {
      if (f.size <= PASTE_IMAGE_LIMIT) return true;
      store.toast((f.name || "图片") + " 超过 20MB，未添加");
      return false;
    });
    if (!accepted.length) return;
    const before = new Set(store.state.doc.nodes.map((n) => n.id));
    void addFiles(store, accepted, ctl.center()).then(() => {
      const made = store.state.doc.nodes.filter((n) => !before.has(n.id)).map((n) => n.id);
      if (!made.length) return;
      for (const id of made) { if (!a.pinned.includes(id)) a.pinned.push(id); a.muted.delete(id); }
      a.emit();
      for (const id of made) { const chip = resolveChip("node", id); if (chip) edRef.current?.insertMention(chip); }
    }).catch(() => store.toast("粘贴图片失败"));
  };
  /** 技能落点：/ 面板与 + →「我的技能」共用——写进 a.skill 并在输入区插一个技能胶囊（选没选中要看得见） */
  const pickSkill = (name: string) => { a.skill = name; a.emit(); edRef.current?.insertMention({ kind: "skill", id: name, title: name, icon: "sparkle", badge: "技能" }); };
  /** 安装 .zip 技能包：在对话里记一条「安装技能包：xx.zip」，助手回一条结果；装好一个就直接放进输入框当本轮技能。
   *  同名技能已存在时不覆盖，给一条带「覆盖安装」动作的提示。包里的脚本不会执行，只装 SKILL.md（和 references 附录）。 */
  const installSkillZip = async (file: File, overwrite = false) => {
    if (file.size > SKILL_ZIP_LIMIT) { store.toast((file.name || "技能包") + " 超过 10MB 上限，未安装"); return; }
    const tId = a.activeThreadId || "__new__";
    if (!overwrite) a.appendMessage({ id: mid(), role: "u", text: "安装技能包：" + (file.name || "skill.zip"), at: Date.now() }, tId);
    const m: AgentMsg = { id: mid(), role: "a", text: "", at: Date.now(), streaming: true };
    a.appendMessage(m, tId); a.emit();
    try {
      const fd = new FormData(); fd.append("file", file, file.name || "skill.zip"); if (overwrite) fd.append("overwrite", "1");
      const res = await fetch("/api/skills/import-zip", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "HTTP " + res.status);
      const installed: string[] = (Array.isArray(data.installed) ? data.installed : []).map((x: any) => String(x?.skill?.name || x?.skill?.id || "")).filter(Boolean);
      const conflicts: string[] = (Array.isArray(data.conflicts) ? data.conflicts : []).map((x: any) => String(x?.name || x?.path || "")).filter(Boolean);
      const errors: string[] = (Array.isArray(data.errors) ? data.errors : []).map((x: any) => String(x?.path || "") + "：" + String(x?.error || "")).filter(Boolean);
      await a.refreshSkills(0);
      const lines: string[] = [];
      if (installed.length) lines.push((overwrite ? "已覆盖安装" : "已安装") + "技能：" + installed.map((n) => "「" + n + "」").join("、") + "。");
      if (installed.length === 1) lines.push("已经放进输入框，直接说要做什么就会按这个技能来；以后在 / 菜单或「+ → 我的技能」里也能选到。");
      else if (installed.length > 1) lines.push("在 / 菜单或「+ → 我的技能」里选一个开始用。");
      const scriptCount = (Array.isArray(data.installed) ? data.installed : []).reduce((n: number, x: any) => n + (Array.isArray(x?.scripts) ? x.scripts.length : 0), 0);
      if (scriptCount) lines.push("技能包里带了 " + scriptCount + " 个脚本，完整保存在本机。助手需要运行时会先弹确认卡，写明要跑哪个脚本、用什么参数，你点「执行」才会运行。");
      if (conflicts.length) lines.push("这些技能已经存在，没有覆盖：" + conflicts.map((n) => "「" + n + "」").join("、") + "（需要的话点下方提示里的「覆盖安装」）。");
      if (errors.length) lines.push("没装上的：" + errors.join("；"));
      if (Number(data.skipped) > 0) lines.push("包里技能超过 20 个，后面 " + data.skipped + " 个没有安装。");
      lines.push("说明：只安装了 SKILL.md（references 里的文档已内联成附录），包里的脚本不会执行。");
      a.patchMessage(m, { text: lines.join("\n\n"), streaming: false });
      if (installed.length === 1) pickSkill(installed[0]);
      if (conflicts.length) store.toast("已有同名技能 " + conflicts.join("、") + "，点这里覆盖安装", 8000, () => { void installSkillZip(file, true); });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err || "未知错误");
      a.patchMessage(m, { text: "", streaming: false, error: "技能包安装失败：" + reason });
    }
    a.emit();
  };
  /** 选文件 / 粘贴进来的 .zip 交给技能包安装，其余文件照旧 */
  const isZip = (f: File) => /\.zip$/i.test(f.name || "") || /zip/i.test(f.type || "");
  const pickSkillZip = () => {
    const fi = document.createElement("input"); fi.type = "file"; fi.accept = ".zip,application/zip,application/x-zip-compressed";
    fi.onchange = () => { const f = fi.files?.[0]; if (f) void installSkillZip(f); };
    fi.click();
  };
  const slashPalette = () => {
    const box = boxRef.current!;
    void webAccessEnabled().then((on) => setWebOn(on !== false)).catch(() => {});
    // 先用旧列表渲染再后台刷新：弹层不等网络，新装的技能回来就自动补上
    void a.refreshSkills();
    slashPaletteOpen.current = true;
    openPop(box, (close) => <Palette a={a} onClose={() => { slashPaletteOpen.current = false; close(); }} onPick={(s) => { slashPaletteOpen.current = false; close(); pickSkill(s); }} onPlugin={(on) => { slashPaletteOpen.current = false; close(); setWebPlugin(on); edRef.current?.dropTrigger(); }} webOn={webOn} webPlugin={webPlugin} width={box.offsetWidth} />, "up", "left", "palette");
  };
  /** 输入框里的 / 或 @ 被删掉 / 替换：对应的选择面板跟着关（@ 面板不再赖着不走） */
  const onTriggerGone = () => {
    const slashOpen = slashPaletteOpen.current;
    slashPaletteOpen.current = false;
    if (!slashOpen && !document.querySelector('#pop:not(.closing) .ap2-mention')) return;
    // 斜杠面板只在它自己开着时关；提及面板只要存在就关
    if (document.querySelector('#pop:not(.closing) [data-slash-palette], #pop:not(.closing) .ap2-mention')) closePop();
  };
  const mentionMenu = () => openPop(boxRef.current!, (close) => <MentionPalette nodes={store.state.doc.nodes} onNode={(n) => { close(); insertNodeChip(n); }} onRef={(ref) => { close(); insertRefChip(ref); }} />, "up", "left", "palette");
  /** 光标前刚打出 @ / 斜杠：开对应的选择面板 */
  const onMentionTrigger = (ch: "@" | "/") => { if (ch === "/") slashPalette(); else mentionMenu(); };
  useEffect(() => { const on = () => mentionMenu(); addEventListener("cn:agent-mention", on); return () => removeEventListener("cn:agent-mention", on); }, [store]);
  // 从画布把节点拖进输入区松手：每个节点插一个引用胶囊（分组 / 堆叠引用整个节点，语义和拖拽一致）
  useEffect(() => {
    const on = (event: Event) => {
      const ids = ((event as CustomEvent).detail as string[] | undefined) || [];
      if (!ids.length) return;
      let added = 0;
      for (const id of ids) {
        const n = store.node(id); if (!n) continue;
        if (!a.pinned.includes(id)) a.pinned.push(id);
        a.muted.delete(id);
        const chip = resolveChip("node", id);
        if (chip) { edRef.current?.insertMention(chip); added += 1; }
      }
      a.emit();
      // 每个胶囊插完光标都停在自己后面：这里只聚焦，不再把光标送回全文末尾
      if (added) { edRef.current?.focus({ caret: "keep" }); store.toast("已引用 " + added + " 个节点到本次对话"); }
    };
    window.addEventListener("cn:agent-drop-nodes", on);
    return () => window.removeEventListener("cn:agent-drop-nodes", on);
  }, [store]);
  // 发出消息后跟随助手的最新回答（回答 / 卡片长出来就滚进视野；用户主动往上翻就停）
  useFollowLatest(scrollRef, a.msgs, a.activeThreadId);
  const full = ui.agentFull;
  const ctxItems = ctxNodes();
  /** 输入列里的 ×：这条消息不再带上它；输入框里 @ 过的话，对应的行内记号一起删掉，两边不打架 */
  const dropDraftTokens = (kind: MentionKind, id: string) => {
    const next = removeMentionTokens(a.draft, kind, id);
    if (next !== a.draft) { a.draft = next; a.emit(); }
  };
  const removeCtxNode = (id: string) => {
    a.muted.add(id); a.pinned = a.pinned.filter((x) => x !== id);
    dropDraftTokens("node", id);
    a.emit();
  };
  /* 任务清单条：只认当前线程最后一条「带 task 的消息」——新任务替换旧清单，丢弃方案后清空就不再出，避免旧清单复活 */
  const lastTaskMsg = [...a.msgs].reverse().find((m) => !!m.task);
  const checklistTask = lastTaskMsg?.task && lastTaskMsg.task.checklist?.length && !lastTaskMsg.task.plan ? lastTaskMsg.task : null;
  const [checklistOpen, setChecklistOpen] = useState(false);
  const checklistBarKey = useRef("");
  // 默认收起：新任务开跑 / 切线程都回到收起；同一条任务内保留用户手动展开的状态
  useEffect(() => {
    const key = (a.activeThreadId || "__new__") + "|" + (checklistTask?.taskId || "");
    if (checklistBarKey.current === key) return;
    checklistBarKey.current = key;
    setChecklistOpen(false);
  }, [a.activeThreadId, checklistTask?.taskId]);
  /* 输入区上方这排：素材 / 应用 / 技能不再单独显示（输入框里已经是行内胶囊）；
     但「选中 / 点选加入、输入框里没 @ 的画布节点」会被悄悄带上，必须显示成小胶囊并能 × 掉。
     其余只留联网搜索与点选提示；以图搜图是输入区里的一行无底色文字按钮。 */
  return (
    <aside id="agent" data-mac-lights={MAC_LIGHTS ? "1" : undefined} data-busy={a.busy ? "1" : undefined} className={(ui.agentOpen ? "" : "closed") + (full ? " full" : "") + " ap2-agent"}>
      <div className="ah ap2-ah">
        {/* mac 桌面端全屏时给系统红绿灯让位：这 88px 是空的，同时充当窗口拖拽区（CSS 只在 #agent.full[data-mac-lights] 下显示） */}
        <span className="ap2-lights-gap" aria-hidden="true" />
        {/* 顶栏最左常驻头像：全屏模式原本就有一个 26px 的封面槽位，直接复用它（同尺寸），
            窄面板没有这个槽位，就在最左挂一个 20px 的——两种模式都不会并排出现两张脸 */}
        {full
          ? <span className="logo ap2-logo ap2-beat-slot"><BeatAvatar size={26} state={beat.state} progress={beat.progress} theme={ui.theme} /></span>
          : <span className="ap2-beat-head"><BeatAvatar size={20} state={beat.state} progress={beat.progress} theme={ui.theme} /></span>}
        <button className={"ib tipB ap2-hb" + (ui.filesOpen ? " on" : "")} id="aFiles" data-tip="侧边栏 · 文件" aria-label="文件" onClick={() => store.setUI({ filesOpen: !ui.filesOpen })}><Icon name="folder" size="s" /></button>
        <button className="t ap2-conv" id="aConv" onClick={(e) => convMenu(store, a, e.currentTarget)}>{convTitle(a)}<Icon name="down" size="xs" /></button><span className="sp" />
        <div className="ap2-hgroup">
          <button className="ib tipB ap2-hb" id="aNew" data-tip="新对话" aria-label="新对话" onClick={() => void startNewThread(store, a)}><Icon name="pencil" size="s" /></button>
          <button className="ib tipB ap2-hb" id="aFull" data-tip={full ? "Agent 居右" : "Agent 全屏"} aria-label={full ? "Agent 居右" : "Agent 全屏"} onClick={() => { store.setUI({ agentFull: !full }); a.prevOpen = !full; a.emit(); }}><Icon name={full ? "panel" : "expand"} size="s" /></button>
          {full ? <button className={"ib tipB ap2-hb" + (a.prevOpen ? " on" : "")} id="aPrev" data-tip="显示画布预览" aria-label="显示画布预览" onClick={() => { a.prevOpen = !a.prevOpen; a.emit(); }}><Icon name="map" size="s" /></button> : null}
          <button className="ib tipB ap2-hb" id="aMore" data-tip="更多选项" aria-label="更多选项" onClick={(e) => moreMenu(ctl, a, e.currentTarget)}><Icon name="more" size="s" /></button>
        </div>
        <button className="ib narrow-only ap2-hb" id="aClose" aria-label="收起 Agent" onClick={() => store.setUI({ agentOpen: false, agentFull: false })}><Icon name="x" size="s" /></button>
      </div>
      {/* 跟随滚动只交给 useFollowLatest 一处：provider 的 autoScroll 会和它抢同一个 scrollTop（消息一多就上下跳） */}
      <MessageScrollerProvider autoScroll={false} defaultScrollPosition="end">
        <MessageScroller className="ab ap2-scroller" id="aScroll" ref={scrollRef}>
          <MessageScrollerViewport className="ap2-viewport">
            <MessageScrollerContent className="acol ap2-content" id="aBody">
        {!a.msgs.length ? <div className="hello ap2-hello">
          <div className="ap2-hi">
            <span className="ap2-logo2 ap2-beat-slot"><BeatAvatar size={28} state={beat.state} progress={beat.progress} theme={ui.theme} /></span>
            <span className="ap2-hi-t">Hi{ctl.host.user?.name ? " " + ctl.host.user.name : ""}！</span>
          </div>
          <h2>今天一起创作点什么？</h2>
          <p className="ap2-sub">挑一张卡片开始，或者直接说你想画的画面。</p>
          <div className="ap2-sugs" aria-live="off" onPointerEnter={() => setSugHover(true)} onPointerLeave={() => setSugHover(false)}
            onFocus={() => setSugFocus(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSugFocus(false); }}>
            {SUGS.slice((sugPage % 3) * 2, (sugPage % 3) * 2 + 2).map(([ic, t, d, q]) => <button key={t} className="ap2-sug" data-q={q} onClick={() => setDraft(q)}><span className="ap2-sug-ic"><Icon name={ic} size="s" /></span><span className="ap2-sug-b"><b className="ap2-sug-t">{t}</b><small className="ap2-sug-d">{d}</small></span><span className="ap2-sug-arrow"><Icon name="right" size="s" /></span></button>)}
          </div>
        </div>
          : <>{a.historyHasMore ? <MessageScrollerItem animated={false} className="ap2-item ap2-earlier-row" key="earlier">
              <button className="ap2-earlier" disabled={a.loadingEarlier} onClick={() => void loadEarlier()}>{a.loadingEarlier ? "正在加载更早的消息…" : "查看更早的 " + a.historyStart + " 条消息"}</button>
            </MessageScrollerItem> : null}{agentRows(a.msgs).map((row) => row.kind === "day"
            ? <MessageScrollerItem animated={false} className="ap2-item" key={row.key}><Marker className="ap2-day" sticky variant="separator"><MarkerContent><MarkerTime date={row.at} locale="zh-CN" /></MarkerContent></Marker></MessageScrollerItem>
            : (() => { const m = row.m; const i = row.i; return (
              <MessageScrollerItem className="ap2-item" data-msg-id={m.id} key={row.key} messageId={m.id}>
                <Msg m={m} i={i} isNew={i >= seen.current} a={a} ctl={ctl} onRetry={() => { const u = a.msgs.slice(0, i).reverse().find((x) => x.role === "u"); if (u) { a.draft = u.text; void send(); } }} onBranch={() => branch(i)} onQ={setDraft} onSkillInstallConfirm={() => void confirmRepositoryInstall(m)} onSkillInstallCancel={() => cancelRepositoryInstall(m)} onQa={(card, skip) => answerQa(m, card, skip)} models={cardModels} onApprovePlan={(steps) => void approvePlan(m, steps)} onRegenerate={(items) => void regenerate(m, items, "")} />
                {memCand && memCand.threadId === (a.activeThreadId || "") && memCand.msgId === m.id
                  ? <MemoryCandidateCard busy={memBusy} items={memCand.items} onConfirm={(ids) => void confirmMemory(ids)} onDismiss={() => void dismissMemory()} /> : null}
              </MessageScrollerItem>
            ); })())}
            </>}
        <SeenMark onSeen={() => (seen.current = a.msgs.length)} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <AgentQueryLocator msgs={a.msgs} />
          <MessageScrollerButton className="ap2-jump" unseenLabel={(n) => "回到最新 · " + n + " 条新消息"} />
        </MessageScroller>
      </MessageScrollerProvider>
      {/* 任务清单条：钉在输入框上方，默认收起，点整条展开（不占消息流） */}
      {checklistTask?.checklist?.length ? <TaskChecklistBar items={checklistTask.checklist} onToggle={() => setChecklistOpen((value) => !value)} open={checklistOpen} status={checklistTask.status} /> : null}
      <div className="ai ap2-composer" id="aiBox" ref={boxRef}>
        {/* 待发送队列 / 标注 / 上下文芯片统一浮在输入区上方：它们原来占正常布局，
            一出现就把输入区顶高、消息区压矮（助手新建节点自动选中时最明显），看起来就是上下跳。 */}
        <div className="ap2-composer-float">
        {a.queue.length ? <div className="ap2-queue" id="aQueue" aria-label="待发送消息队列">
          <div className="ap2-queue-hd">
            <span className="ap2-queue-title">待发送</span>
            <span className="ap2-queue-count">{a.queue.length}/{QUEUE_MAX}</span>
            <span className="ap2-queue-hint">助手结束后自动发送</span>
          </div>
          <div className="ap2-queue-list">
            {a.queue.map((item, index) => <div className="ap2-queue-row" key={item.id} data-queue-id={item.id}>
              <span className="ap2-queue-idx">{index + 1}</span>
              <span className="ap2-queue-text" title={item.label}>{item.label}</span>
              <span className="ap2-queue-acts">
                <button className="ap2-queue-btn" type="button" aria-label="编辑排队消息" title="编辑" onClick={() => editQueued(item)}><Icon name="pencil" size="xs" /></button>
                <button className="ap2-queue-btn" type="button" aria-label="立即发送" title="立即发送" onClick={() => sendQueuedNow(item)}><AnimatedSendIcon size={16} /></button>
                <button className="ap2-queue-btn" type="button" aria-label="删除排队消息" title="删除" onClick={() => deleteQueued(item)}><Icon name="x" size="xs" /></button>
              </span>
            </div>)}
          </div>
        </div> : null}
        {annChat.length ? <div className="ap2-annrow" id="aAnn">
          {annChat.map((g) => <span className="ap2-ann" key={g.nodeId} title={g.nodeTitle + " · " + g.annotations.length + " 条标注"}>
            <span className="ap2-ann-n">{g.annotations.length}</span>
            <span className="ap2-ann-t">{g.nodeTitle} · 标注</span>
            <button className="pm-x" type="button" aria-label="移除标注" onClick={() => setAnnChat((v) => v.filter((x) => x.nodeId !== g.nodeId))}><Icon name="x" size="xs" /></button>
          </span>)}
        </div> : null}
        {/* 这排只剩联网搜索 / 点选提示：素材与应用引用胶囊整排都不显示（Boss 2026-11），
            引用仍写进 a.refs 并随消息发出；全空时 :empty 规则直接收掉，不留空白高或空胶囊。 */}
        <div className="ctxrow ap2-ctxrow" id="aCtx">
          {webPlugin ? <span className="pm-chip ap2-chip is-plugin" title="本轮联网搜索：搜索公开网页并读取正文">
            <span className="pm-th"><IconWorld size={12} stroke={1.7} /></span>
            <span className="pm-t">联网搜索</span>
            <button className="pm-x" aria-label="移除联网搜索" data-unplugin onClick={() => { setWebPlugin(false); a.emit(); }} type="button"><Icon name="x" size="xs" /></button>
          </span> : null}
          {/* 技能不再在这排占胶囊：/ 选的技能仍写进 a.skill 并随消息生效，只是不显示（Boss 2026-11）。
              「添加画布内容」一并去掉：它只把选中节点 pin 住，节点胶囊隐藏后点了只剩一个 toast，状态变化完全看不见。 */}
          {ui.agentPick ? <span className="cchip">点画布上的节点加入上下文 · Esc 结束</span> : null}
        </div>
        </div>
        {/* 输入列：跟节点生成面板同一套（.gp-in .sq / .chip-in）——第一个是「从画布点选」，中间是这条消息会带上的
            画布节点 / 素材（正方形缩略图 + 序号，悬停出 ×），最后是「+」（原来底栏那颗，菜单不变）。
            选中、点选加入、在输入框里 @ 的节点都会随消息发出去，这里全部看得见、能去掉。 */}
        <div className="gp-in ap2-in" id="aIns">
          <button className={"sq tipT" + (ui.agentPick ? " on" : "")} data-p="agent-pick" data-tip="从画布点选节点加入对话" aria-label="从画布点选节点加入对话" type="button"
            onClick={() => { const on = !ui.agentPick; store.setUI({ agentPick: on }); if (on) store.toast("点画布上的节点加入 Agent 上下文，Esc 结束"); }}><Icon name="cursor" size="s" /></button>
          {ctxItems.map(({ n, pinned }, i) => {
            const src = displaySrc(store.state.doc.nodes, n);
            const icon = <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" />;
            return <button key={n.id} type="button" className={"sq chip-in" + (src ? "" : " txt")} data-ctx-node={n.id} title={(pinned ? "已加入本次对话：" : "已选中，会随消息发送：") + title(n)}
              onPointerEnter={(e) => { store.setUI({ hlNode: n.id }); hoverChip({ kind: "node", id: n.id }, e.currentTarget.getBoundingClientRect()); }}
              onPointerLeave={() => { store.setUI({ hlNode: null }); leaveChip(); }}>
              {src ? <ThumbImg src={src} width={28} fallback={icon} /> : icon}
              <span className="ord">{i + 1}</span>
              <span className="x" role="button" aria-label={"不发送 " + title(n)} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); removeCtxNode(n.id); }}><Icon name="x" size="xs" /></span>
            </button>;
          })}
          {a.refs.filter((r) => r.kind === "asset").map((ref, i) => {
            const src = refMediaSrc(ref);
            return <button key={ref.id} type="button" className={"sq chip-in" + (src ? "" : " txt")} data-ctx-ref={ref.id} title={"素材引用：" + ref.title}
              onPointerEnter={(e) => hoverChip({ kind: "ref", id: ref.id }, e.currentTarget.getBoundingClientRect())} onPointerLeave={leaveChip}>
              {src ? <ThumbImg src={src} width={28} fallback={<Icon name="folder" size="s" />} /> : <Icon name="folder" size="s" />}
              <span className="ord">{ctxItems.length + i + 1}</span>
              <span className="x" role="button" aria-label={"不发送 " + ref.title} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); a.refs = a.refs.filter((x) => x.id !== ref.id); dropDraftTokens("ref", ref.id); a.emit(); }}><Icon name="x" size="xs" /></span>
            </button>;
          })}
          <button className="sq tipT" id="aPlus" data-tip="添加" aria-label="添加" type="button" onClick={(e) => plusMenu(ctl, a, e.currentTarget, pickSkill, { pickZip: pickSkillZip, installZip: (f) => { void installSkillZip(f); } })}><Icon name="plus" size="s" /></button>
        </div>
        {/* 以图搜图：Boss 不要外面那层白色圆角胶囊底（.ap2-ctxrow 的卡片底），改成输入区里的一行
            纯文字 / 图标按钮——无底色、无边框、无胶囊，hover 只变字色。只在选中图片节点时出现，不占空行。 */}
        {ctxItems.some(({ n }) => n.kind === "image" && srcOf(n)) ? <button className="ap2-revlink" id="aReverse" title="用这张（或这几张里的第一张）找相似参考图" onClick={() => void reverseSearch(ctl, a)} type="button"><Icon name="search" size="xs" />以图搜图</button> : null}
        {authCard ? <AutonomyCard busy={authBusy} initial={authCard.initial} models={models} reason={authCard.reason} onCancel={endAutonomy} onConfirm={confirmBudget} /> : null}
        <InputGroup className="ap2-input"><MentionInput id="aiInput" ref={edRef} value={a.draft}
          placeholder={a.busy ? (full ? "助手执行中 · 按 Enter 加入队列" : "Enter 加入队列") : voicePhase === "recording" ? "正在聆听…" : voicePhase === "transcribing" ? "正在转写…" : (full ? "描述创意或需求，/ 使用技能，@ 引用参考或使用应用" : "随心输入")}
          onChange={onDraftInput} onEnter={() => { if (a.busy) enqueueDraft(); else void send(); }} onTrigger={onMentionTrigger} onTriggerGone={onTriggerGone}
          resolve={resolveChip} onRemove={dropMention} onPasteFiles={pasteImages}
          onChipHover={(chip, rect) => { if (chip && rect) hoverChip(chip, rect); else leaveChip(); }}
          onFocus={() => setSugFocus(true)} onBlur={() => setSugFocus(false)} /></InputGroup>
        <div className="foot ap2-foot" data-voice={voicePhase}>
          <FolderButton ctl={ctl} a={a} />
          <CaptureButton ctl={ctl} a={a} />
          <button className="pill ghost ap2-pill" id="aMode" data-autonomy={a.mode} onClick={(e) => openPop(e.currentTarget, (close) => <>{AUTONOMY_MODES.map(([k, ic, t, d]) => <button key={k} className={"mi" + (a.mode === k ? " on" : "")} data-m={k} onClick={() => { close(); a.setMode(k); }}><span className="ic"><Icon name={ic} size="s" /></span><span>{t}<span className="d">{d}</span></span>{a.mode === k ? <span className="k"><Icon name="check" size="s" /></span> : null}</button>)}</>, "up")}><Icon name={AUTONOMY_MODES.find(([k]) => k === a.mode)?.[1] || "cursor"} size="s" />{a.mode === "auto" ? (full ? "自动推进" : "自动") : a.mode === "managed" ? (full ? "托管" : "托管") : (full ? "协作" : "协作")}<Icon name="down" size="xs" /></button>
          <button className={"pill ghost tipT ap2-pill" + (full ? "" : " icon")} id="aThink" data-thinking={a.thinking} aria-label={"思考强度：" + THINKING.find(([k]) => k === a.thinking)?.[1]} data-tip={"思考强度：" + THINKING.find(([k]) => k === a.thinking)?.[1]} onClick={(e) => openPop(e.currentTarget, (close) => <><div className="mh">思考强度</div>{THINKING.map(([k, t, d]) => <button key={k} className={"mi" + (a.thinking === k ? " on" : "")} data-t={k} onClick={() => { close(); a.setThinking(k); }}><span className="ic"><Icon name="brain" size="s" /></span><span>{t}<span className="d">{d}</span></span>{a.thinking === k ? <span className="k"><Icon name="check" size="s" /></span> : null}</button>)}</>, "up")}><Icon name="brain" size="s" />{full ? THINKING.find(([k]) => k === a.thinking)?.[1] : null}{a.thinking === "off" ? null : <i className={"thk l" + THINKING.findIndex(([k]) => k === a.thinking)} />}</button>
          <span className="sp" />
          <ContextMeter model={a.model} usage={liveUsage} estimate={ctxBreak()} memOn={a.memOn} onCompact={() => compact(ctl, a)} onMemory={() => memoryModal(a)} />
          <button className="pill ghost tipT ap2-pill" id="aModel" aria-label={modelHint} data-tip={modelHint} onClick={(e) => modelMenu(e.currentTarget, e.detail === 0)}><Icon name="sparkle" size="s" /><span className="amodel-name ap2-amodel">{modelLabel}</span></button>
          {/* 录音/转写时 #aMic 原位变身成胶囊（方案 7）：红点 + 计时；不额外占一行，其它按钮位置保持 */}
          <button className={"ib ap2-btn" + (voicePhase === "idle" ? "" : " voice-live") + (voicePhase === "recording" ? " rec" : "")} id="aMic" aria-label={voicePhase === "recording" ? "结束语音输入" : voicePhase === "transcribing" ? "正在转写" : "语音输入"} aria-pressed={voicePhase === "recording"} data-voice-phase={voicePhase} disabled={voicePhase === "transcribing"} onClick={() => void toggleVoice()}>
            {voicePhase === "recording"
              ? <><i className="ap2-vdot" aria-hidden="true" /><span className="ap2-vtime tnum">{voiceClock(voiceSecs)}</span><span className="ap2-vstop" aria-hidden="true"><i /></span></>
              : voicePhase === "transcribing"
                ? <><i className="ap2-vspin" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></svg></i><span className="ap2-vtime">正在转写…</span></>
                : <Icon name="mic" size="s" />}
          </button>
          {voicePhase !== "idle" ? <button className="ap2-voice-x" type="button" aria-label="取消语音输入" title="取消语音输入" onClick={resetVoice}><Icon name="x" size="xs" /></button> : null}
          {a.busy ? <button className="send busy ap2-send" id="aSend" title="停止" aria-label="停止" onClick={() => { void stopTask(); }}><i className="ring"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></svg></i><span className="sqr" /></button>
            : <button className="send ap2-send" id="aSend" title="发送 ↵" aria-label="发送" onClick={() => void send()}><AnimatedSendIcon size={16} /></button>}
        </div>
      </div>
      {full && a.prevOpen ? <PreviewWin ctl={ctl} onClose={() => { a.prevOpen = false; a.emit(); }} /> : null}
      <ChipPreviewHost resolve={resolveChip} />
    </aside>
  );
}

/** 供应商 → 模型两级菜单：两级都夹在视口内，二级贴着供应商行展开，放不下就翻到左侧。
 *  一级列表保持原样（↑/↓ 换供应商、→/回车进二级）；二级换成 combobox 面板：搜索 / ↑↓ / Enter / Esc 都交给 Base UI，
 *  选中/高亮/对勾仍走 data-agent-model 与 .on 软底。二级弹层挂在 #pop 根下（不在供应商列表的滚动容器里），
 *  滚动一级列表不会把它裁掉；关闭时先播 180ms 反向动画再卸载（presence）。 */
function AgentModelMenu({ models, defaultModelId, selectedModelId, thinkLevels, thinkLevel, onThinkChange, onChoose, onSettings, close }: { models: ModelSpec[]; defaultModelId: string | null; selectedModelId: string | null; thinkLevels: string[]; thinkLevel: string; onThinkChange: (level: string) => void; onChoose: (id: string | null) => void; onSettings?: () => void; close: () => void }) {
  const vendorOf = (m: ModelSpec) => m.vendor.trim() || "其他供应商";
  const vendors = [...new Set(models.map(vendorOf))];
  const [active, setActive] = useState<{ vendor: string; row: HTMLElement; focus: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null); const flyRef = useRef<HTMLDivElement>(null); const closeTimer = useRef<number | null>(null);
  const box = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
  const cancelClose = () => { if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } };
  useEffect(() => cancelClose, []);
  const show = (vendor: string, row: HTMLElement, focus = false) => {
    cancelClose(); setClosing(false);
    if (active?.vendor === vendor) { if (focus) flyRef.current?.querySelector<HTMLElement>(".combo-in")?.focus(); return; }
    setActive({ vendor, row, focus });
  };
  /* 关二级：留 180ms 给 comboOut，再卸载；焦点回到供应商行（Esc 只关这一层，#pop 还开着） */
  const hide = () => {
    if (!active) return;
    cancelClose(); setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null; setClosing(false); setPlace(null); setActive(null);
      active.row.focus();
    }, 180);
  };
  /* 二级弹层 portal 到 .cn-root 根级：用视口 fixed 坐标，脱离 #pop 的 backdrop root，才能采到画布而不是父盒。
     换供应商必须重量：1 个和 37 个模型的供应商共用同一块浮层，沿用上一次量到的 maxHeight 会把新列表裁成一行。
     量的是列表完整高度（.combo-scroll 的 scrollHeight + 搜索框/内距），不是被 maxHeight 裁过的外框高度；
     上限 420 由 placePopover 的 capHeight 给（它再按视口可用空间收），贴边 / 翻到左侧仍交给 placePopover。 */
  const placedVendor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    if (place && placedVendor.current === active.vendor) return;
    const el = flyRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const scroller = el.querySelector<HTMLElement>(".combo-scroll");
    const contentHeight = scroller ? el.clientHeight - scroller.clientHeight + scroller.scrollHeight : r.height;
    const placed = placePopover({ anchor: box(active.row), popup: { x: 0, y: 0, width: r.width, height: contentHeight }, viewport: { width: innerWidth, height: innerHeight }, dir: "right", align: "left", margin: 8, gap: 8, capHeight: 420 });
    placedVendor.current = active.vendor;
    setPlace({ left: Math.round(placed.x), top: Math.round(placed.y), maxHeight: Math.round(placed.maxHeight) });
  }, [active, place]);
  useEffect(() => { if (!active) return; const on = () => setPlace(null); addEventListener("resize", on); return () => removeEventListener("resize", on); }, [active]);
  const step = (list: HTMLElement[], dir: number) => {
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    (at < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[(at + dir + list.length) % list.length]).focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // 焦点在模型强度滑块里时把方向键 / Home / End 留给滑块（role=slider 自己处理，别再挪菜单焦点）
    if ((e.target as HTMLElement | null)?.closest?.(".ev-track")) return;
    const root = menuRef.current; if (!root) return;
    const fly = flyRef.current;
    const list = [...root.querySelectorAll<HTMLElement>("button:not([disabled])")].filter((b) => !fly || !fly.contains(b));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); step(list, e.key === "ArrowDown" ? 1 : -1);
      const el = document.activeElement as HTMLElement | null; const vendor = el?.dataset?.agentVendor;
      if (active && vendor) show(vendor, el!, false); // 换到别的供应商时二级菜单跟着走
    } else if (e.key === "ArrowRight") {
      const el = document.activeElement as HTMLElement | null; const vendor = el?.dataset?.agentVendor;
      if (vendor) { e.preventDefault(); show(vendor, el!, true); }
    } else if (e.key === "ArrowLeft" && active) { e.preventDefault(); hide(); }
  };
  const optionsOf = (vendor: string) => models.filter((m) => vendorOf(m) === vendor);
  return <div className="model-menu" ref={menuRef} onKeyDown={onKeyDown}>
    <div className="mh">选择供应商</div>
    {defaultModelId ? <button className={"mi" + (!selectedModelId ? " on" : "")} data-agent-model="default" onClick={() => { close(); onChoose(null); }}><Icon name="sparkle" size="s" /><span>默认对话模型<span className="d">{models.find((m) => m.id === defaultModelId)?.name || "跟随系统设置"}</span></span></button> : null}
    <div className="model-providers">
      {vendors.map((vendor) => {
        const options = optionsOf(vendor);
        const open = active?.vendor === vendor;
        return <div key={vendor} className={"model-vendor" + (open ? " open" : "")}>
          <button className={"mi" + (open ? " open" : "")} data-agent-vendor={vendor} aria-expanded={open} aria-controls={open ? "agent-model-options" : undefined} aria-haspopup="menu" onPointerEnter={(e) => show(vendor, e.currentTarget)} onClick={(e) => show(vendor, e.currentTarget, e.detail === 0)}><VendorLogo name={vendor} size={16} /><span className="nm">{vendor}</span><span className="n">{options.length} 个模型</span><Icon name="right" size="s" /></button>
        </div>;
      })}
      {!models.length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>还没有配置对话模型</span></div> : null}
    </div>
    {/* 一级供应商列表下方、模型设置上方：高度有限，.model-providers 的 max-height 收到 300px（可滚），
        保证滑块始终露在弹层里；只有多于 1 档才渲染（组件内部也兜一层）。
        档位 / 当前值 / 改写回调都来自上面 #aThinkLevel 那一套 thinkLevels / thinkLevel / setThinkLevel */}
    {thinkLevels.length > 1 ? <div className="model-effort"><EffortSlider levels={thinkLevels} value={thinkLevel} onChange={onThinkChange} /></div> : null}
    {active && typeof document !== "undefined" ? createPortal(
      <div className={"model-flyout model-flyout-portal" + (place ? " combo-flyout" : "") + (closing ? " closing" : "")} id="agent-model-options" role="group" aria-label={active.vendor + "模型"} ref={flyRef}
        onPointerDown={(e) => e.stopPropagation()}
        style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: "hidden" }}>
        <ComboMenu
          autoFocus={active.focus}
          empty={<span>{optionsOf(active.vendor).length ? "没有匹配的模型" : "这个供应商还没有模型"}</span>}
          itemAttrs={(m) => ({ "data-agent-model": m.id })}
          itemClassName={(m) => "mi combo-item" + (m.id === selectedModelId ? " on" : "")}
          items={optionsOf(active.vendor)}
          label={(m) => m.name}
          onEscape={hide}
          onPick={(m) => { close(); onChoose(m.id); }}
          renderItem={(m) => <><VendorLogo name={m.vendor} model={m.name} size={14} /><span className="nm">{m.name}</span></>}
          resetKey={active.vendor}
          searchPlaceholder="搜索模型"
          searchable={optionsOf(active.vendor).length > 8}
        />
      </div>,
      document.querySelector(".cn-root") || document.body
    ) : null}
    {onSettings ? <><button className="mi" onClick={() => { close(); onSettings(); }}><Icon name="settings" size="s" />模型设置</button></> : null}
  </div>;
}

function SeenMark({ onSeen }: { onSeen: () => void }) { useEffect(() => { onSeen(); }); return null; }

/** 素材引用的 ref 什么时候能当图片显示（历史消息反查 @素材 时决定要不要挂 src；挂错会变成坏图请求） */
const MEDIA_REF_HINT = /image|video|图片|视频|photo|png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov/i;
function refMediaSrc(ref: { kind: "app" | "asset"; ref: string; detail?: string }): string {
  if (ref.kind !== "asset" || !ref.ref) return "";
  const src = ref.ref;
  const addressLike = /^(https?:\/\/|\/|data:|novai-asset:|openarc-asset:|resource:)/i.test(src);
  // 提示词 / 工作流条目的 ref 是正文或 JSON 地址，不是图：别拿它当 img src（会变成坏图请求）
  if (!addressLike && !MEDIA_REF_HINT.test(ref.detail || "")) return "";
  if (MEDIA_REF_HINT.test(ref.detail || "")) return src;
  if (/^data:(image|video)\//i.test(src)) return src;
  if (/\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov|m4v)(?:$|[?#])/i.test(src)) return src;
  // novai-asset / resource 引用本身不带扩展名，交给 useAssetUrl 解析；解析不出来 ThumbImg 会退回图标
  return /^(novai-asset|openarc-asset|resource):/i.test(src) ? src : "";
}
function MentionRow({ n, onClick }: { n: CanvasNode; onClick: () => void }) {
  const src = isGenKind(n.kind) ? srcOf(n) : "";
  const icon = <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="xs" />;
  const fallback = <span className="ic" style={{ width: 24, height: 24 }}>{icon}</span>;
  return <button className="mi" onClick={onClick}>{src ? <ThumbImg src={src} width={24} style={{ width: 24, height: 24, borderRadius: 6, objectFit: "cover" }} fallback={fallback} /> : fallback}<span>{title(n)}<span className="d">{n.kind === "table" ? "多维表格" : { text: "文本", image: "图片", video: "视频", audio: "音频" }[n.kind as GenKind]}</span></span></button>;
}

/** 阶段四：自治三档（协作默认 = 现状；两档旧行为不变） */
const AUTONOMY_MODES = [
    ["manual", "cursor", "协作（默认）", "Agent 先规划、写入逐次批准；只读步骤自动执行"],
    ["auto", "bolt", "自动推进", "只读步骤自动跑，写入和生成仍要你批准"],
    ["managed", "shield", "托管", "先定平台 / 模型与生成次数上限，按预算自动推进"],
] as const;

const toolIcon = (label: string): Parameters<typeof Icon>[0]["name"] => /读取|检查|计算/.test(label) ? "eye" : /连线|连入|连到/.test(label) ? "link" : /新建|创建/.test(label) ? "plus" : /生成|运行/.test(label) ? "sparkle" : /排布|整理/.test(label) ? "grid" : /记忆/.test(label) ? "brain" : "bolt";
/** 老线程里用户气泡混进的内部提示词（以前把发给后端的 goal 原样存进了线程）：显示 / 复制时剥掉。
 *  新消息发送时已经单独存了给人看的文字（threadText），这里只兜老数据。顺带修掉问答回答里「1. 1.」的重复编号。 */
const LEGACY_SKILL_RE = /\n*本轮按技能「([^」\n]+)」来做。/;
function displayUserText(text: string): string {
  return String(text || "")
    .replace(/\n*本轮引用（按顺序[^）\n]*）：[^\n]*/g, "")
    .replace(/\n*本轮引用：[^\n]*/g, "")
    .replace(/\n*本轮请联网搜索公开网页并读取正文，作为参考后再回答。/g, "")
    .replace(new RegExp(LEGACY_SKILL_RE.source, "g"), "")
    .replace(/（技能 ID：[^）\n]*）/g, "")
    .replace(/^(\s*\d+)[.、]\s*\d+[.、)）]\s*/gm, "$1. ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** 「还没有开始生成——在下面的待生成卡片里…」：卡片已经执行 / 失效、消息里不再有卡片时，这句话会指向空气。
 *  按实际情况改写：后面紧跟着生成结果、或方案已批准 → 已确认生成；否则说明卡片已失效。 */
const PENDING_GEN_RE = /还没有开始生成——在下面的待生成卡片里[^。\n]*。/;
function settleGenText(text: string, executed: boolean): string {
  if (!PENDING_GEN_RE.test(text)) return text;
  return text.replace(PENDING_GEN_RE, executed ? "已确认并开始生成。" : "这张待生成卡片已经失效，需要的话让我重新整理一次。");
}

function Msg({ m, i, isNew, a, ctl, models, onRetry, onBranch, onQ, onSkillInstallConfirm, onSkillInstallCancel, onQa, onApprovePlan, onRegenerate }: { m: AgentMsg; i: number; isNew: boolean; a: AgentState; ctl: Ctl; models: ModelSpec[]; onRetry: () => void; onBranch: () => void; onQ: (q: string) => void; onSkillInstallConfirm: () => void; onSkillInstallCancel: () => void; onQa: (card: QaCard, skip: boolean) => void; onApprovePlan: (steps: AgentTaskPlan["steps"]) => void; onRegenerate: (items: AgentRegenerateItem[]) => void }) {
  const nw = isNew ? " new" : "";
  const copy = async () => { try { await navigator.clipboard.writeText(copyableText(m.text || "")); ctl.store.toast("已复制"); } catch { ctl.store.toast("剪贴板不可用"); } };
  if (m.role === "u") {
    // 发送时已经带 ctx；历史消息（后端只存文本）按 @标题 反查当前画布，补出上下文。
    // @ 的节点 / 素材在正文里内联成缩略图胶囊（点一下定位到画布），技能是行内技能胶囊（有封面显示封面）；
    // 不再在气泡上方单独挂一排。
    const shown = displayUserText(m.text || "");
    // 老数据里技能只写在「本轮按技能「X」来做。」这句里：剥掉文字的同时把它还原成技能胶囊
    const legacySkill = m.skill || (String(m.text || "").match(LEGACY_SKILL_RE)?.[1] ?? undefined);
    const ctx = m.ctx?.length ? m.ctx : inferCtxFromText(ctl.store, shown);
    const copyUser = async () => { try { await navigator.clipboard.writeText(copyableText(shown)); ctl.store.toast("已复制"); } catch { ctl.store.toast("剪贴板不可用"); } };
    return <div className={"msg u" + nw} data-i={i} data-msg-id={m.id}>
      <Bubble className="ap2-bub-u" variant="secondary"><BubbleContent className="ap2-bub-body"><MessageText text={shown} ctx={ctx} ctl={ctl} skill={legacySkill} own={!!m.ctx?.length} skills={a.skills} /></BubbleContent></Bubble><MessageTime at={m.at} /><div className="mact"><button title="复制" onClick={copyUser}><Icon name="copy" size="xs" /></button></div></div>;
  }
  const patch = (p: Partial<AgentMsg>) => a.patchMessage(m, p);
  /* 方案卡「跟随助手默认」：卡片里凡是没写模型的步骤，都按「这一类排第一个模型」的能力列比例 / 分辨率等选项，
     执行时用的却是画布记住的默认模型（store.defaultModel）。把每类的默认模型挪到最前，两边就是同一个模型 */
  const planModels = (() => {
    const defaults = new Set((["image", "video", "text", "audio"] as GenKind[]).map((k) => ctl.store.defaultModel(k)?.id).filter(Boolean) as string[]);
    return [...models.filter((x) => defaults.has(x.id)), ...models.filter((x) => !defaults.has(x.id))];
  })();
  const hasGenCard = !!(m.task?.plan && TASK_UI_SETTLED.has(m.task.status) && m.task.plan.kind === "generation");
  const nextMsg = a.msgs[i + 1];
  const genExecuted = m.task?.status === "COMPLETED" || (!!nextMsg && nextMsg.role === "a" && /^这批生成完成了/.test(String(nextMsg.text || "").trim()));
  const aText = !m.streaming && !hasGenCard && m.text ? settleGenText(m.text, genExecuted) : (m.text || "");
  /* 老线程里的生成结果消息只有文字（当时没存审查卡数据）：按正文里点到的节点名把画布上的结果图补成缩略图，
     点一下定位到节点。同名的取画布上最后一个（最新一版）；最多 8 张 */
  const resultIds = (() => {
    if (m.streaming || m.reviews?.length || !/^这批生成完成了/.test(aText.trim())) return [] as string[];
    const byTitle = new Map<string, string>();
    for (const n of ctl.store.state.doc.nodes) {
      if (!isGenKind(n.kind) || !srcOf(n)) continue;
      const t = title(n); if (t.length >= 4 && aText.includes(t)) byTitle.set(t, n.id);
    }
    return [...byTitle.values()].slice(0, 8);
  })();
  return <div className={"msg a" + nw} data-i={i} data-msg-id={m.id}>
    <Proc m={m} patch={patch} />
    {m.webSearch?.length ? <div className="websearch-cards">{m.webSearch.map((card) => <WebSearchCard card={card} key={card.key} />)}</div> : null}
    {m.memSaved ? <div className="memrow"><Icon name="check" size="xs" />已写入{m.memSaved.scope}记忆：{m.memSaved.text}<button className="linkbtn" onClick={() => memoryModal(a)}>管理</button></div> : null}
    {m.compactions?.length ? <CompactNotice key={m.compactions[m.compactions.length - 1].id} notice={m.compactions[m.compactions.length - 1]} times={m.compactions.length} /> : null}
    {m.heartbeat && !m.streaming ? <HeartbeatLine hb={m.heartbeat} /> : null}
    {m.origin === "agent" ? <div className="ap2-proactive" data-origin="agent"><Icon name="sparkle" size="xs" /><span>助手主动发来</span></div> : null}
    {m.selfCheck ? <SelfCheckLine check={m.selfCheck} /> : null}
    {m.streaming && !m.text ? <div aria-hidden="true" className="ap2-skeleton"><Skeleton className="ap2-skeleton-line" /><Skeleton className="ap2-skeleton-line is-short" /><Skeleton className="ap2-skeleton-line" /></div> : null}
    {m.text ? <Message align="start" className="ap2-msg-a"><MessageContent className="ap2-mc"><div className="md-chat ap2-bub-a"><Markdown streaming={m.streaming} text={aText} /></div></MessageContent></Message> : null}
    {/* 下一步建议：只当文字给，不做成按钮（用户 2026-11 明确）；要采纳直接照着说一句即可 */}
    {m.suggestions?.length ? <div className="ap2-sugs ap2-sugs-text" data-suggestions>
      <span className="ap2-sugs-hd">下一步建议</span>
      {m.suggestions.map((text, index) => <p className="ap2-sug-text" key={index}>{text}</p>)}
    </div> : null}
    {m.error ? <Alert className="ap2-alert"><Icon name="alert" size="s" /><AlertTitle>{m.error}</AlertTitle><AlertClose aria-label="关闭错误提示" onClick={() => patch({ error: undefined })} /></Alert> : null}
    <div className="ap2-cards">
      {m.webImages?.length ? <div className="webimgs">{m.webImages.map((card) => <WebImageCard key={card.key} card={card} ctl={ctl} />)}</div> : null}
      {m.reviews?.length ? m.reviews.map((r, k) => <ReviewCard key={k} review={r} ctl={ctl} round={m.reviews!.length > 1 ? k + 1 : 0} onRegenerate={onRegenerate} />) : null}
      {!m.reviews?.length && resultIds.length ? <div className="results ap2-results" data-results>{resultIds.map((id) => <ResultCard key={id} id={id} ctl={ctl} />)}</div> : null}
      {m.task?.plan && TASK_UI_SETTLED.has(m.task.status) && m.task.plan.kind === "generation" ? <GenerationCard plan={m.task.plan} models={models} busy={a.busy} onApprove={onApprovePlan} onFocusNode={(id) => ctl.focusNode(id)} onDiscard={() => patch({ task: m.task ? { ...m.task, plan: null, checklist: undefined } : undefined })} /> : null}
      {m.task?.plan && TASK_UI_SETTLED.has(m.task.status) && m.task.plan.kind !== "generation" ? <TaskPlanCard plan={m.task.plan} models={planModels} busy={a.busy} onApprove={onApprovePlan} onDiscard={() => patch({ task: m.task ? { ...m.task, plan: null, checklist: undefined } : undefined })} /> : null}
      {m.qa ? <QaCardView card={m.qa} busy={a.busy} onChange={(qa) => patch({ qa })} onSubmit={() => onQa(m.qa!, false)} onSkip={() => onQa(m.qa!, true)} /> : null}
      {m.skillInstall ? <SkillInstallCard value={m.skillInstall} onConfirm={onSkillInstallConfirm} onCancel={onSkillInstallCancel} onManage={() => skillsModal(a)} /> : null}
    </div>
    {m.results?.length ? <div className="mentions">{m.results.map((id) => <NodeMention key={id} id={id} ctl={ctl} />)}</div> : null}
    {m.acts ? <ButtonGroup className="ap2-qacts">{m.acts.map((q) => <Button className="ap2-qbtn" key={q} onClick={() => onQ(q)} size="sm" variant="outline">{q}</Button>)}</ButtonGroup> : null}
    <MessageTime at={m.at} />
    {/* 操作条常驻占位：忙碌/流式时只隐藏不卸载。以前是条件渲染，a.busy 每翻一次，所有助手消息就矮 31px，
        整列消息跟着上下跳（实测 750ms 轮询与旧 watcher 抢 busy 时最明显）。 */}
    <TooltipProvider><ButtonGroup className={"ap2-mact" + (m.think?.live || m.streaming || a.busy ? " is-ghost" : "")}>
      <Tooltip><TooltipTrigger render={<Button aria-label="复制" className="ap2-act" onClick={copy} size="icon-sm" variant="ghost"><Icon name="copy" size="xs" /></Button>} /><TooltipContent>复制</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Button aria-label="好评" aria-pressed={m.fb === "up"} className={"ap2-act" + (m.fb === "up" ? " on" : "")} onClick={() => { patch({ fb: m.fb === "up" ? undefined : "up" }); ctl.store.toast("感谢反馈"); }} size="icon-sm" variant="ghost"><Icon name="thumbup" size="xs" /></Button>} /><TooltipContent>好评</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Button aria-label="差评" aria-pressed={m.fb === "down"} className={"ap2-act" + (m.fb === "down" ? " on" : "")} onClick={() => { patch({ fb: m.fb === "down" ? undefined : "down" }); ctl.store.toast("已记录，会用来改进回答"); }} size="icon-sm" variant="ghost"><Icon name="thumbdown" size="xs" /></Button>} /><TooltipContent>差评</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Button aria-label="分支对话" className="ap2-act" onClick={onBranch} size="icon-sm" variant="ghost"><Icon name="branch" size="xs" /></Button>} /><TooltipContent>分支对话</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Button aria-label="重新生成" className="ap2-act" onClick={onRetry} size="icon-sm" variant="ghost"><Icon name="redo" size="xs" /></Button>} /><TooltipContent>重新生成</TooltipContent></Tooltip>
    </ButtonGroup></TooltipProvider>
  </div>;
}


function MessageTime({ at }: { at?: number }) {
  if (!at) return null;
  const d = new Date(at);
  return <time className="mtime" dateTime={d.toISOString()}>{d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} {d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}
/** 处理过程：运行中一行「正在思考」+ 动效；结束后一行轻文字 + chevron，展开是纯文字步骤（无卡面） */
/** 长任务心跳：一行很轻的状态（正在思考 / 审查中 · 已 N 秒），本地每秒走一格 */
function HeartbeatLine({ hb }: { hb: NonNullable<AgentMsg["heartbeat"]> }) {
  const [elapsed, setElapsed] = useState(hb.elapsedMs);
  useEffect(() => {
    setElapsed(hb.elapsedMs);
    const timer = window.setInterval(() => setElapsed((value) => value + 1000), 1000);
    return () => window.clearInterval(timer);
  }, [hb.elapsedMs, hb.stage]);
  // 进程行（ap2-proc-live）已经写着「正在思考」，这里再写一次就出现两行相同的字；改成「运行中」区分开
  const label = hb.stage === "review" ? "审查中" : hb.stage === "tools" ? "执行工具中" : "运行中";
  return <div className="ap2-hb-line" data-heartbeat={hb.stage}><i className="dot" /><span>{label + " · 已 " + Math.max(0, Math.floor(elapsed / 1000)) + " 秒"}</span></div>;
}

/** 回复前的一行「完成前自检」：通过就一行字；未通过可以展开看逐条未满足项；pending 项只标「待核对」，不算未通过 */
function SelfCheckLine({ check }: { check: SelfCheckResult }) {
  const [open, setOpen] = useState(false);
  const pending = check.items.filter((item) => item.status === "pending");
  const unmet = check.items.filter((item) => !item.ok && item.status !== "pending");
  const tone = check.passed ? "passed" : unmet.length ? "failed" : "pending";
  const expandable = !check.passed && (unmet.length > 0 || pending.length > 0);
  return <div className={"ap2-selfcheck" + (tone === "passed" ? " is-pass" : tone === "failed" ? " is-fail" : " is-pending")} data-self-check={tone}>
    <Icon name={tone === "passed" ? "check" : tone === "pending" ? "history" : "alert"} size="xs" />
    <span>{tone === "passed" ? "完成前自检通过" : tone === "failed" ? "完成前自检未通过 · " + unmet.length + " 项未满足" : "完成前自检 · " + pending.length + " 项待核对"}{tone === "failed" && pending.length ? " · " + pending.length + " 项待核对" : ""}</span>
    {expandable ? <button className="linkbtn" data-self-check-detail onClick={() => setOpen((value) => !value)}>{open ? "收起" : "看明细"}</button> : null}
    {expandable && open ? <ul className="ap2-selfcheck-list">
      {unmet.map((item, index) => <li key={"unmet" + index}>{item.text}</li>)}
      {pending.map((item, index) => <li className="pending" key={"pending" + index}>{item.text}<span className="ap2-selfcheck-pending">待核对</span></li>)}
    </ul> : null}
  </div>;
}

/** 工具名 → 人话（收起态那行只给用户看「它在做什么」，不暴露内部工具名） */
const STEP_LABEL: Record<string, string> = {
  read_node: "读取节点", search_canvas: "查找节点", read_table: "读取表格", canvas_diff: "对比画布改动",
  view_image: "查看图片", recall_step: "取回步骤结果", create_node: "新建节点", update_node: "修改节点",
  delete_node: "删除节点", connect_nodes: "连接节点", disconnect_nodes: "断开连线", move_nodes: "移动节点",
  analyze_video: "分析视频", depth_capture: "深度动作捕捉", generate_image: "生成图片", generate_video: "生成视频",
  batch_generate: "批量生成", run_generation: "执行生成", lipsync_video: "视频对口型", query_models: "查询可用模型",
  activate_skill: "启用技能", install_skill: "安装技能", run_skill_script: "运行技能脚本", list_skills: "查看技能", edit_timeline: "剪辑时间线", write_html_report: "生成网页报告", write_xlsx: "生成表格文件",
  annotate_node: "标注节点", crop_image: "裁剪图片", edit_image: "编辑图片", upscale_image: "放大图片",
};
/** 已知的内部工具名集合：label 恰好等于工具名时不当作人话 */
const TOOL_NAMES = new Set(Object.keys(STEP_LABEL));

/** 这一条思考是不是「反思」：后端 thought 事件的 kind=reflect（老数据没有 kinds 就一律不标） */
const isReflect = (th: AgentMsg["think"], index: number) => String(th?.kinds?.[index] || "") === "reflect";

function Proc({ m, patch }: { m: AgentMsg; patch: (p: Partial<AgentMsg>) => void }) {
  const tools = m.tools || []; const th = m.think;
  const reasoning = m.reasoning || "";
  /** 展开了「代码」的步骤（按下标）：参数 / 返回用代码块显示，带复制 */
  const [codeOpen, setCodeOpen] = useState<Set<number>>(() => new Set());
  const live = !!th?.live || tools.some((t) => t.state === "run") || !!m.streaming && !m.took;
  /** 运行中每秒走一格：没有推理原文时，过一会儿要告诉用户模型在后台想（不是卡住了） */
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  if (!th && !tools.length && !reasoning) return null;
  /** 「结果审查」判定不合格不是步骤失败：审查本身做完了，只是结论是「这张不行」。用中性样式，也不算进失败 */
  const reviewMiss = (t: (typeof tools)[number]) => t.state === "error" && /审查|自检|review/i.test(String(t.label || "") + " " + String(t.tool || ""));
  /** 历史记录里 label 就是内部工具名（run_generation 这种）：翻成中文；没收录的英文名原样留着 */
  const labelOf = (t: (typeof tools)[number]) => { const l = String(t.label || "").trim(); return TOOL_NAMES.has(l) ? STEP_LABEL[l] : (l || STEP_LABEL[String(t.tool || "")] || "步骤"); };
  const done = tools.filter((t) => t.state === "done" || reviewMiss(t)).length;
  /** 思考时长：历史记录没存、步骤耗时也都是 0 时拿到的是 0，别显示成「思考了 0.0s」 */
  const secs = m.took || Number(th?.secs) || 0;
  const fmt = (s: number) => (s >= 60 ? Math.floor(s / 60) + "m " + Math.round(s % 60) + "s" : (s < 10 ? s.toFixed(1) : Math.round(s)) + "s");
  /** 默认收起：收起态给一条「现在在跑什么」的实时命令行，点开才看完整思考与每步的真实参数 */
  const open = m.procOpen === true;
  /** 运行中、还没有任何推理原文、也没有工具在跑：超过 6 秒就提示模型在后台思考 */
  const waitingSilently = live && !reasoning && !tools.some((t) => t.state === "run") && !!m.at && Date.now() - m.at > 6000;
  const thinking = !!th && !!m.procOpen && !!th.lines.length;
  /* 收起态那行显示什么：正在跑的那一步在做什么 → 最近一步 → 推理最后一行（还没开始动工具时） */
  const runningCmd = (() => {
    const rows = [...tools].reverse();
    const hit = rows.find((t) => t.state === "run") || rows[0];
    if (hit) {
      // 占位行的 label 是「正在准备：xxx」，主语已经是「正在思考」，前缀要去掉
      const label = String(hit.label || "").trim().replace(/^正在准备：/, "");
      // label 是后端给的这步在干什么；拿不到就按工具名翻成中文，别再显示 read_node 这种内部名
      if (label && !TOOL_NAMES.has(label)) return label;
      const zh = STEP_LABEL[String(hit.tool || "")];
      if (zh) return zh;
      if (hit.cmd) return String(hit.cmd).slice(0, 60);
    }
    // 还没开始动工具时不给内容：推理原文多半是英文/半句话，塞在这行既难看也没信息量
    return "";
  })();
  return (
    <Collapsible className={"ap2-proc" + (live ? " is-live" : "")} onOpenChange={(v) => patch({ procOpen: v })} open={open}>
      {live ? (
        /* 收起态也在干活：左边转圈 +「正在思考」，右边跟一条真实命令（随事件跳动），点整行展开 */
        <CollapsibleTrigger aria-live="polite" className="ap2-proc-live">
          <Spinner className="ap2-spin" size="sm" />
          <span className="ap2-proc-live-text ap2-shimmer">正在思考</span>
          {runningCmd
            ? <span className="ap2-proc-cmd" title={runningCmd}>{runningCmd}</span>
            : <i aria-hidden="true" className="ap2-dots"><b /><b /><b /></i>}
          <span className="ap2-proc-caret"><Icon name="right" size="xs" /></span>
        </CollapsibleTrigger>
      ) : (
        <CollapsibleTrigger className="ap2-proc-hd">
          <span>{secs >= 0.05 ? "思考了 " + fmt(secs) : "执行过程"}</span>
          {tools.length ? <span className="ap2-proc-count"> · {done}/{tools.length} 步</span> : null}
          <span className="ap2-proc-caret"><Icon name="right" size="xs" /></span>
        </CollapsibleTrigger>
      )}
      {/* 收起态也看得到推理：模型吐了推理原文就滚动显示最后几行；一直没有（APIMART 的 gpt 系列不返回推理）
          就过几秒说清楚「在后台想、不是卡了」（模型自己决定这次想不想、给不给推理原文），免得用户以为面板死了 */}
      {live && !open ? (reasoning
        ? <ReasonPeek text={reasoning} />
        : waitingSilently ? <div className="ap2-reason-hint"><Icon name="brain" size="xs" /><span>模型正在后台思考，这次没有返回思考内容，想完会直接给出回复</span></div> : null) : null}
      <CollapsibleContent className="ap2-proc-body">
        {/* 阶段三：原生推理（reasoning_delta）逐字追加；运行中带一层很轻的 shimmer，结束后就是普通正文 */}
        {/* 运行中：原生推理逐字追加、直接可见；结束后折成一行「模型推理原文」，默认收起——
            原文多是模型自言自语（还常有「作为 API 助手无法访问画布」这类误导的话），先给人看步骤和结论 */}
        {reasoning && th?.live ? <div className="ap2-think-reason is-live" data-think-reason aria-live="polite">{reasoning}</div> : null}
        {reasoning && !th?.live ? <details className="ap2-reason-fold" data-think-reason-fold>
          <summary><Icon name="brain" size="xs" /><span>模型推理原文</span><Icon name="right" size="xs" /></summary>
          <div className="ap2-think-reason" data-think-reason>{reasoning}</div>
        </details> : null}
        {th && !th.live && th.lines[0] && !thinking ? <div className="ap2-think-sum"><Icon name="brain" size="xs" /><span>{th.lines[0]}</span></div> : null}
        {thinking ? <div className="ap2-think-text">{th!.lines.map((l, k) => <p key={k}>{isReflect(th, k) ? <span className="ap2-reflect">反思</span> : null}{l}</p>)}</div> : null}
        {tools.length ? <div className="ap2-steps">{tools.map((t, k) => (
          <Item className={"ap2-step " + (reviewMiss(t) ? "miss" : t.state)} key={k}>
            <ItemMedia className="ap2-step-chip">
              {t.state === "run" ? <Spinner size="sm" /> : <Icon name={reviewMiss(t) ? "eye" : t.state === "error" ? "alert" : t.state === "skip" ? "right" : toolIcon(labelOf(t))} size="xs" />}
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="ap2-step-text">{labelOf(t)}</ItemTitle>
              {t.cmd ? <div className="ap2-step-cmd" title={t.cmd}>{t.cmd}</div> : null}
              {codeOpen.has(k) ? <StepCode step={t} /> : null}
            </ItemContent>
            {stepHasCode(t) ? <button type="button" className={"ap2-step-code-btn" + (codeOpen.has(k) ? " on" : "")} aria-expanded={codeOpen.has(k)} aria-label={codeOpen.has(k) ? "收起代码" : "查看代码"} title={codeOpen.has(k) ? "收起代码" : "查看参数与返回"}
              onClick={() => setCodeOpen((cur) => { const next = new Set(cur); if (next.has(k)) next.delete(k); else next.add(k); return next; })}><Icon name="code" size="xs" /></button> : null}
            <ItemActions className="ap2-step-secs">
              {reviewMiss(t) ? <Badge className="ap2-step-badge">未通过</Badge>
                : t.state === "done" ? (t.secs != null && Number(t.secs) >= 0.05 ? t.secs + "s" : "")
                : t.state === "skip" || t.state === "error" || t.state === "wait" ? <Badge className="ap2-step-badge">{t.state === "skip" ? "跳过" : t.state === "error" ? "失败" : "待执行"}</Badge> : null}
            </ItemActions>
          </Item>
        ))}</div> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
/** 推理原文的「窥视窗」：收起态只露最后几行，新内容进来自动滚到底；点上面那行展开看全文 */
function ReasonPeek({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [text]);
  return <div className="ap2-reason-peek" ref={ref} aria-live="polite" data-reason-peek>{text.slice(-1200)}</div>;
}

const STEP_CODE_HIDE = new Set(["canvas_id", "description"]);
/** 代码区里的参数：去掉画布 id / 描述这类噪音，长字符串截断，避免一个提示词把面板撑爆 */
function stepArgsForCode(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (STEP_CODE_HIDE.has(key) || value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "string" && value.length > 2000 ? value.slice(0, 2000) + "…（已截断）" : value;
  }
  return out;
}
const stepJson = (value: unknown, limit = 6000): string => {
  let text = "";
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  return text.length > limit ? text.slice(0, limit) + "\n…（已截断，共 " + text.length + " 字）" : text;
};
const stepHasCode = (t: ToolStep) => {
  const args = stepArgsForCode(t.args);
  return (!!args && typeof args === "object" && Object.keys(args as object).length > 0) || (t.result !== undefined && t.result !== null) || !!t.error || !!t.cmd;
};
/** 代码围栏：内容里自带 ``` 时加长围栏，免得提前收尾 */
const fence = (lang: string, body: string) => { const ticks = body.includes("```") ? "````" : "```"; return ticks + lang + "\n" + body + "\n" + ticks; };
/** 步骤的「代码」区：命令 / 参数 / 返回（技能脚本把 stdout / stderr 拆出来单独给），用 Markdown 代码块渲染，自带复制 */
function StepCode({ step }: { step: ToolStep }) {
  const blocks: string[] = [];
  const args = stepArgsForCode(step.args);
  const hasArgs = !!args && typeof args === "object" && Object.keys(args as object).length > 0;
  if (hasArgs) blocks.push("**参数**\n\n" + fence("json", stepJson(args)));
  else if (step.cmd) blocks.push("**命令**\n\n" + fence("bash", step.cmd));
  const result = step.result as Record<string, unknown> | undefined;
  if (step.tool === "run_skill_script" && result && typeof result === "object") {
    if (result.stdout) blocks.push("**输出**\n\n" + fence("text", stepJson(String(result.stdout))));
    if (result.stderr) blocks.push("**错误输出**\n\n" + fence("text", stepJson(String(result.stderr))));
    const rest = { ...result }; delete rest.stdout; delete rest.stderr;
    blocks.push("**结果**\n\n" + fence("json", stepJson(rest)));
  } else if (result !== undefined && result !== null) {
    blocks.push("**返回**\n\n" + fence(typeof result === "string" ? "text" : "json", stepJson(result)));
  }
  if (step.error) blocks.push("**失败原因**\n\n" + fence("text", step.error));
  if (!blocks.length) return null;
  return <div className="ap2-step-code"><Markdown text={blocks.join("\n\n")} /></div>;
}
/** 这些终态无需再解释，任务卡收起；失败 / 阻塞 / 等待批准仍然保留 */
/** 回复里引用的节点（TapNow 的 mention 胶囊）：点一下定位到画布 */
function NodeMention({ id, ctl }: { id: string; ctl: Ctl }) {
  const n = useS((s) => s.doc.nodes.find((x) => x.id === id)); const src = n && isGenKind(n.kind) ? srcOf(n) : "";
  if (!n) return null;
  return <button className="mention" onClick={() => { if (ctl.store.state.ui.agentFull) ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.focusNode(id), 60); }}>{src ? <ThumbImg src={src} width={14} fallback={<Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="xs" />} /> : <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="xs" />}<span>{title(n)}</span></button>;
}
/** 消息文字里的 @引用：内联成小胶囊（缩略图 + 名字），点一下定位到画布节点 */
function MentionInline({ c, ctl }: { c: { id?: string; title: string; kind: string; src?: string }; ctl: Ctl }) {
    const nodes = useS((s) => s.doc.nodes);
    const n = c.id ? nodes.find((x) => x.id === c.id) : undefined;
    // 分组 / 堆叠没有自己的图：用成员里第一张有图的当缩略图（右下角带一个小图层标，看得出是一组）
    const src = n ? displaySrc(nodes, n) : (c.src || "");
    const isGroup = (n?.kind || c.kind) === "group";
    const icon = <Icon name={c.kind === "table" ? "grid" : TYPE_ICON[c.kind as GenKind] || "layers"} size="xs" />;
    // 只要缩略图，不带节点名：名字放在 title 里悬停可见
    return <button type="button" className="m-ment" title={c.title} onClick={() => { if (c.id) { if (ctl.store.state.ui.agentFull) ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.focusNode(c.id!), 60); } }}>
        {src ? <ThumbImg src={src} width={16} fallback={icon} /> : icon}
        {src && isGroup ? <i className="m-ment-stack" aria-hidden="true"><Icon name="layers" size="xs" /></i> : null}
    </button>;
}

/** 复制消息时还原成人话：@skill{名} → （技能：名），别把给面板渲染用的记号复制出去 */
const copyableText = (text: string) => String(text || "").replace(/@skill\{([^}\n]+)\}/g, "（技能：$1）").replace(/[ \t]{2,}/g, " ").trim();

/** 行内技能胶囊：跟输入区同一个位置语义——用户把技能放在句子中间，消息正文里就渲染在同一处 */
function SkillChipInline({ name, skills }: { name: string; skills?: Skill[] }) {
    // 有封面的技能显示封面缩略图（跟技能面板同一套 thumbUrl）；没有封面 / 加载失败退回 ✨
    const sk = skills?.find((x) => x.name === name);
    const cover = thumbUrl(sk ? { id: sk.id, name: sk.name, src: sk.src } : { name });
    return <span className="ap2-bub-skill" data-mk="skill" title={"本轮技能：" + name}>
        <span className="th">{cover ? <ThumbImg src={cover} width={32} className="ap2-bub-skill-cover" fallback={<Icon name="sparkle" size="xs" />} /> : <Icon name="sparkle" size="xs" />}</span>
        <ChipLabel text={name} className="nm" />
        <span className="nb">技能</span>
    </span>;
}

/** 一段纯文本里的「@节点名」→ 内联胶囊；找不到的 @ 原样留着。
 *  own=true：ctx 就是这条消息发送时记下的引用（m.ctx，最权威）——名字后面紧跟中文 / 另一个 @ 也照样认，
 *  单字名也认；同一处有多个候选时取最长的名字（「图片1」不会被「图片」截走）。
 *  own=false：历史消息按画布标题反查出来的 ctx，仍要求 @名 后面是空白 / 标点，避免误伤正文。
 *  hit 收集已经在正文里内联显示过的引用 id，MessageText 用它把没内联到的补在末尾。 */
function textNodes(text: string, ctx: NonNullable<AgentMsg["ctx"]>, ctl: Ctl, own = false, hit?: Set<string>): React.ReactNode[] {
    if (!text) return [];
    if (!ctx.length || !text.includes("@")) return [text];
    const hits: Array<{ start: number; end: number; c: (typeof ctx)[number] }> = [];
    for (const c of ctx) {
        const t = String(c.title || "").trim();
        if (t.length < (own ? 1 : 2)) continue;
        let from = 0;
        for (;;) {
            const at = text.indexOf("@" + t, from); if (at < 0) break;
            const after = text[at + 1 + t.length] || "";
            if (own || !after || /[\s，。,.!?、;；:：)）\]】@]/.test(after)) hits.push({ start: at, end: at + 1 + t.length, c });
            from = at + 1;
        }
    }
    if (!hits.length) return [text];
    hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const parts: React.ReactNode[] = []; let cur = 0;
    const used = new Set<string>();
    for (let i = 0; i < hits.length; i++) {
        let h = hits[i];
        if (h.start < cur) continue;
        /* 同一处有多个同名候选（老版本三个堆叠都叫「group」，或两个堆叠同名）：按发送时的引用顺序取还没用过的那个，
           否则每一处都会落到 ctx 里第一个同名项——表现就是「@ 了三个堆叠，发出去全是第一个」。 */
        for (let j = i; j < hits.length && hits[j].start === h.start && hits[j].end === h.end; j++) {
            if (!hits[j].c.id || !used.has(hits[j].c.id)) { h = hits[j]; break; }
        }
        if (h.start > cur) parts.push(text.slice(cur, h.start));
        parts.push(<MentionInline key={"m" + h.start} c={h.c} ctl={ctl} />);
        if (h.c.id) { used.add(h.c.id); hit?.add(h.c.id); }
        cur = h.end;
    }
    if (cur < text.length) parts.push(text.slice(cur));
    return parts;
}

/** 消息正文：技能记号 @skill{名} 渲染成行内胶囊（位置就是用户放的位置），其余文字照旧匹配 @节点名。
 *  own：ctx 来自消息自己（发送时记录）；这种情况下正文里没能内联匹配到的引用补在末尾，缩略图不会凭空消失。 */
function MessageText({ text, ctx, ctl, skill, own = false, skills }: { text: string; ctx: NonNullable<AgentMsg["ctx"]>; ctl: Ctl; skill?: string; own?: boolean; skills?: Skill[] }) {
    const source = String(text || "");
    const parts: React.ReactNode[] = [];
    const hit = new Set<string>();
    const tokenRe = /@skill{([^}\n]+)\}/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(source))) {
        if (m.index > last) parts.push(<Fragment key={"t" + last}>{textNodes(source.slice(last, m.index), ctx, ctl, own, hit)}</Fragment>);
        parts.push(<SkillChipInline key={"sk" + m.index} name={m[1]} skills={skills} />);
        last = m.index + m[0].length;
    }
    if (last < source.length) parts.push(<Fragment key={"t" + last}>{textNodes(source.slice(last), ctx, ctl, own, hit)}</Fragment>);
    if (!parts.length) parts.push(...textNodes(source, ctx, ctl, own, hit));
    // 老消息（前几轮只有 skill 字段、正文里没有记号）：补在正文末尾，别让技能消失
    if (skill && !source.includes("@skill{")) parts.push(<SkillChipInline key="sk-old" name={skill} skills={skills} />);
    // 发送时带着的引用（@ 进输入框的节点 / 素材、选中的节点）在正文里没对上位置：补在末尾，缩略图照样显示
    if (own) for (const c of ctx) if (c.id && !hit.has(c.id) && c.kind !== "app") parts.push(<MentionInline key={"mx" + c.id} c={c} ctl={ctl} />);
    return parts.length ? <>{parts}</> : null;
}

function ResultCard({ id, ctl }: { id: string; ctl: Ctl }) {
  const n = useS((s) => s.doc.nodes.find((x) => x.id === id)); const src = n && isGenKind(n.kind) ? srcOf(n) : "";
  if (!n) return null;
  return <button className="rcard" onClick={() => { if (ctl.store.state.ui.agentFull) ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.focusNode(id), 60); }}>{src ? <ThumbImg src={src} width={96} fallback={<span className="ri"><Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" /></span>} /> : <span className="ri"><Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" /></span>}<span className="rt">{title(n)}</span></button>;
}

/** 技能图标：✨ 打底，封面加载成功才盖住图标；没有封面 / 加载失败就保持原来的 ✨ */
function SkillIcon({ skill, className }: { skill: { id?: string; name?: string; src?: string }; className: string }) {
  const src = thumbUrl(skill);
  return <span className={className}><Icon name="sparkle" size="s" />{src ? <img className="nv-skill-thumb" alt="" loading="lazy" src={src}
    onLoad={(e) => { const sv = e.currentTarget.parentElement?.querySelector("svg"); if (sv) sv.style.display = "none"; }}
    onError={(e) => { e.currentTarget.remove(); }} /> : null}</span>;
}

/* ---------- 菜单 / 面板 ---------- */
/** 输入 / 的弹窗：插件（联网搜索）+ 技能两组，↑↓ 选、回车用、Esc 关；选中后输入区出现胶囊 */
function Palette({ a, onPick, onPlugin, webOn, webPlugin, onClose, width }: { a: AgentState; onPick: (s: string) => void; onPlugin: (on: boolean) => void; webOn: boolean; webPlugin: boolean; onClose: () => void; width: number }) {
  // 弹层是 openPop 里一次性渲染的：订阅 AgentState，技能列表在打开后才回来时也要跟着更新
  useAgent(a);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const list = a.skillsOn().filter((k) => !q || (k.name + k.desc).includes(q));
  const rows = 1 + list.length;
  const pick = (index: number) => { if (index === 0) { onPlugin(!webPlugin); return; } const k = list[index - 1]; if (k) onPick(k.name); };
  return <div className="ap2-pal" data-slash-palette="1" style={{ width }}>
    <div className="pal-s ap2-pal-search"><Icon name="search" size="s" /><input autoFocus placeholder="搜索技能或插件" value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + rows) % Math.max(1, rows)); return; }
      if (e.key === "Enter") { e.preventDefault(); pick(Math.min(hi, rows - 1)); return; }
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }} /></div>
    <div className="ap2-pal-group">
      <div className="mh">插件</div>
      <button className={"mi ap2-pal-row" + (hi === 0 ? " active" : "") + (webPlugin ? " on" : "")} data-plugin="websearch" onMouseEnter={() => setHi(0)} onClick={() => pick(0)} type="button">
        <span className="ap2-pal-ic is-plugin"><IconWorld size={15} stroke={1.7} /></span>
        <span className="ap2-pal-copy"><b>联网搜索</b><small>{webOn ? "已开启 · 搜索公开网页、读取正文" : "未开启 · 先在 设置 → 通用 打开画布助手联网"}</small></span>
        <span className="ap2-pal-tag">{webPlugin ? "已选" : webOn ? "已开启" : "未开启"}</span>
      </button>
    </div>
    <div className="ap2-pal-group">
      <div className="mh">技能</div>
      {list.map((k, i) => <button className={"mi ap2-pal-row" + (hi === i + 1 ? " active" : "") + (a.skill === k.name ? " on" : "")} key={k.name} onMouseEnter={() => setHi(i + 1)} onClick={() => onPick(k.name)} type="button">
        <SkillIcon className="ap2-pal-ic" skill={k} />
        <span className="ap2-pal-copy"><b title={k.desc}>{k.name}</b></span>
        <span className="ap2-pal-tag">{k.src}</span>
      </button>)}
      {!list.length ? <div className="row ap2-pal-empty"><span>{a.skills.length ? "没有匹配的技能" : a.skillsLoaded ? "还没有技能 · 去设置里添加" : "正在加载技能…"}</span></div> : null}
    </div>
    <div className="ap2-pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>回车</kbd> 使用</span><span><kbd>Esc</kbd> 关闭</span></div>
  </div>;
}
function plusMenu(ctl: Ctl, a: AgentState, anchor: Element, pickSkill: (name: string) => void, zip: { pickZip: () => void; installZip: (f: File) => void }) {
  const store = ctl.store;
  // 进 + 菜单（含「我的技能」二级）先刷新：不等网络，旧列表先渲染，回来再补
  void a.refreshSkills();
  const Root = ({ close, go }: { close: () => void; go: (v: string) => void }) => <>
    <button className="mi" onClick={() => { close(); store.setUI({ agentPick: true }); store.toast("点画布上的节点加入 Agent 上下文，Esc 结束"); }}><Icon name="cursor" size="s" />从画布添加</button>
    <button className="mi" onClick={() => { close(); const fi = document.createElement("input"); fi.type = "file"; fi.multiple = true; fi.accept = "image/*,video/*,audio/*,.zip,application/zip"; fi.onchange = () => {
      // .zip 当技能包安装；图片 / 视频 / 音频照旧放到画布并加入本次对话
      const all = [...(fi.files || [])]; const zips = all.filter((f) => /\.zip$/i.test(f.name || "") || /zip/i.test(f.type || "")); const media = all.filter((f) => !zips.includes(f));
      zips.forEach((f) => zip.installZip(f));
      if (media.length) void addFiles(store, media, ctl.center()).then(() => { [...store.state.ui.sel].forEach((id) => a.pinned.push(id)); a.emit(); });
    }; fi.click(); }}><Icon name="upload" size="s" />上传附件<span className="k">图片 / 视频 / 音频 / 技能包 .zip</span></button>
    <button className="mi" data-act="skill-zip" onClick={() => { close(); zip.pickZip(); }}><Icon name="sparkle" size="s" />安装技能包<span className="k">.zip</span></button>
    <button className="mi" onClick={() => { close(); void reverseSearch(ctl, a); }}><Icon name="search" size="s" />以图搜图<span className="k">选中图 / 上传</span></button>
    <button className="mi" onClick={() => { close(); (document.getElementById("aFolder") as HTMLButtonElement | null)?.click(); }}><Icon name="folder" size="s" />添加本地文件夹并记住授权</button>
    {/* 技能入口常驻：一个技能都没有时也要能进去上传 / 创建 / 管理 */}
    <button className="mi" onClick={() => go("skill")}><Icon name="sparkle" size="s" />我的技能<span className="k">{a.skillsOn().length ? a.skillsOn().length + " 个启用" : "管理技能"}<Icon name="right" size="xs" /></span></button>
  </>;
  function Menu({ close }: { close: () => void }) {
    // 和 Palette 一样：弹层内容只在打开时渲染一次，订阅 AgentState 让技能列表/启用数同步更新
    useAgent(a);
    const [v, setV] = useState("root");
    const viewRef = useRef<HTMLDivElement>(null);
    /* 视图切换（一级 ↔ 技能二级）也当一次进入：220ms 淡入 + 4px 位移 */
    useLayoutEffect(() => {
      const el = viewRef.current;
      if (!el || prefersReduced()) return;
      const anim = el.animate([{ opacity: 0, transform: "translate3d(0,4px,0)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.215,.61,.355,1)" });
      return () => anim.cancel();
    }, [v]);
    return <div className="combo-view" ref={viewRef}>
      {v === "skill" ? <ComboMenu
        autoFocus
        empty={<span>{a.skillsLoaded ? "没有匹配的技能" : "正在加载技能…"}</span>}
        filterText={(k) => k.name + " " + k.desc}
        footer={<>
          <button className="mi" onClick={() => { close(); uploadSkill(a); }}><Icon name="upload" size="s" />上传技能文件<span className="k">.md</span></button>
          <button className="mi" onClick={() => { close(); zip.pickZip(); }}><Icon name="upload" size="s" />安装技能包<span className="k">.zip</span></button>
          <button className="mi" onClick={() => { close(); skillEditor(a); }}><Icon name="plus" size="s" />创建技能</button>
          <button className="mi" onClick={() => { close(); skillsModal(a); }}><Icon name="settings" size="s" />管理技能</button>
        </>}
        header={<><button className="mi" onClick={() => setV("root")}><Icon name="left" size="s" /><b>技能</b></button><div className="msep" /></>}
        itemClassName="mi combo-item"
        items={a.skillsOn()}
        label={(k) => k.name}
        onPick={(k) => { close(); pickSkill(k.name); }}
        renderItem={(k) => <>
          <SkillIcon className="ic" skill={k} />
          <span className="ap2-skill-name" title={k.desc}>{k.name}</span>
          {k.src === "我的" ? <span className="k">我的</span> : null}
        </>}
        searchPlaceholder="搜索技能"
        searchable
      /> : <Root close={close} go={setV} />}
    </div>;
  }
  openPop(anchor, (close) => <Menu close={close} />, "up", "left", "combo-pop");
}
/**
 * 以图搜图：画布选中的图片（没有选中就先选一张本地图）→ 拿本地 url → POST /api/agent/images/reverse
 * → 结果直接进参考图选择卡（不消耗一轮对话）。关闭联网时卡片显示指引，不发请求。
 */
async function reverseSearch(ctl: Ctl, a: AgentState) {
  const store = ctl.store;
  const node = [...store.state.ui.sel, ...a.pinned].map((id) => store.node(id)).find((n): n is CanvasNode => !!n && n.kind === "image" && !!srcOf(n));
  let source = ""; let label = "上传的图片";
  if (node) { source = srcOf(node); label = title(node); }
  else {
    const file = await pickImageFile();
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { store.toast(file.name + " 超过 25MB，没有用于以图搜图", 5000); return; }
    source = await readAsDataUrl(file).catch(() => "");
    if (!source) { store.toast("读取失败：" + file.name); return; }
    label = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "上传的图片";
  }
  const m: AgentMsg = { id: mid(), role: "a", text: "", at: Date.now(), webImages: [{ key: "reverse:" + Date.now().toString(36), kind: "similar", status: "loading", query: "", queries: [], description: "", note: "", sources: {}, items: [], error: "" }] };
  a.msgs = [...a.msgs, m]; a.emit();
  const card = (next: Partial<WebImageCardData>) => { m.webImages = [{ ...m.webImages![0], ...next }]; a.msgs = [...a.msgs]; a.emit(); };
  try {
    if (await webAccessEnabled() === false) { card({ status: "web-off" }); return; }
    const local = await localImageFor(store, source, label);
    const result = await reverseWebImages(local, 12);
    card({ status: "ready", query: result.query, queries: result.queries, description: result.description, note: result.note, sources: result.sources, items: result.items });
    if (!result.items.length) store.toast("没有搜到相似参考图" + (result.note ? "：" + result.note : ""));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "以图搜图失败";
    card(isWebAccessDisabled(reason) ? { status: "web-off", error: reason } : { status: "failed", error: reason });
  }
}

/** 反图接口只收 url：本地图直接用；远程图先过导入接口；上传的 data: 走既有资源上传拿本地地址 */
async function localImageFor(store: Ctl["store"], url: string, name: string): Promise<string> {
  const value = String(url || "").trim();
  if (!value) throw new Error("这张图没有可用的地址");
  if (value.startsWith("/")) return value;
  if (value.startsWith("data:")) {
    const local = await store.backend.importAsset(store.state.canvasId, value, name || "以图搜图");
    if (!local) throw new Error("图片存进资源库失败，没有拿到本地地址");
    return local;
  }
  if (isAssetRef(value)) {
    const local = await store.backend.resolveAsset(value);
    if (!local) throw new Error("读不到这张图的本地地址");
    return localImageFor(store, local, name);
  }
  const [row] = await importWebImages([{ url: value }]);
  if (!row || !row.ok || !row.url) throw new Error(row?.error || "原图导入失败（服务端没有给出原因）");
  return row.url;
}

function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}
/** 当前对话标题：有提问就按第一条提问，没有就问线程名 */
function convTitle(a: AgentState) {
  const thread = a.threads.find((row) => row.id === a.activeThreadId);
  // 正文里的 @skill{名} 是渲染用的记号：标题只显示名字，别把记号露给用户
  const first = a.msgs.find((m) => m.role === "u")?.text.replace(/@skill\{([^}\n]+)\}/g, "$1");
  return first ? first.slice(0, 14) : thread?.title || "新建对话";
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 月日 */
function relTime(at: number) {
  if (!at) return "";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + " 天前";
  const d = new Date(at);
  return d.getMonth() + 1 + "月" + d.getDate() + "日";
}

/** 新建对话：后端建一条空线程并切过去，旧线程留在列表里（不删） */
async function startNewThread(store: Ctl["store"], a: AgentState) {
  if (!a.threadsSupported()) { a.msgs = []; a.queue = []; a.pendingUrgent = null; a.draft = ""; a.emit(); store.toast("已开始新对话"); return; }
  const ok = await a.newThread();
  store.toast(ok ? "已新建对话，上一段还在对话列表里" : a.businessError || "新建对话失败");
}

/** 切到历史线程：先让后端记住当前线程，再把消息换过来 */
async function switchConv(store: Ctl["store"], a: AgentState, threadId: string) {
  if (threadId === a.activeThreadId) return;
  if (!await a.switchThread(threadId)) store.toast(a.businessError || "切换对话失败");
}

function convMenu(store: Ctl["store"], a: AgentState, anchor: Element) {
  openPop(anchor, (close) => <>
    <button className="mi" data-conv-new onClick={() => { close(); void startNewThread(store, a); }}><Icon name="pencil" size="s" />新建对话</button>
    <div className="mh">本画布的对话</div>
    {a.threads.length ? a.threads.map((row) => <button key={row.id} className={"mi" + (row.id === a.activeThreadId ? " on" : "")} data-thread-id={row.id} onClick={() => { close(); void switchConv(store, a, row.id); }}><Icon name="msg" size="s" /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{row.title}</span><span className="k">{relTime(row.at)}{row.count ? " · " + row.count + " 条" : ""}</span></button>) : <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>{a.loading ? "正在读取对话…" : "还没有对话记录"}</span></div>}
  </>);
}
function moreMenu(ctl: Ctl, a: AgentState, anchor: Element) {
  openPop(anchor, (close) => <>
    {/* 搜索历史放这里，不新增底栏按钮：底栏的上下文入口只有一个（#aRing） */}
    <button className="mi" data-recall-entry onClick={() => { close(); openRecallSearch(ctl.store.state.canvasId, a.activeThreadId); }}><Icon name="search" size="s" />搜索历史<span className="k">跨对话 · 本机</span></button>
    <button className="mi" onClick={() => { close(); usageModal(ctl, a); }}><Icon name="bolt" size="s" />用量统计</button>
    <button className="mi" onClick={() => { close(); memoryModal(a); }}><Icon name="brain" size="s" />记忆<span className="k">{a.memOn ? a.memory().length + " 条" : "已关闭"}</span></button>
    <button className="mi" onClick={() => { close(); skillsModal(a); }}><Icon name="sparkle" size="s" />管理技能<span className="k">{a.skillsOn().length} 个启用</span></button>
    <button className="mi" onClick={() => { close(); compact(ctl, a); }}><Icon name="layers" size="s" />压缩对话</button>
    <div className="msep" />
    <button className="mi" onClick={() => { close(); ctl.store.setUI({ agentOpen: false, agentFull: false }); }}><Icon name="right" size="s" />收起对话</button>
  </>, "down", "right");
}
function usageModal(ctl: Ctl, a: AgentState) {
  const asks = a.msgs.filter((m) => m.role === "u").length; const steps = a.msgs.reduce((n, m) => n + (m.tools || []).filter((t) => t.state === "done").length, 0);
  const made = a.msgs.reduce((n, m) => n + (m.results || []).length, 0); const secs = a.msgs.reduce((n, m) => n + (m.took || 0), 0);
  const chars = a.msgs.reduce((n, m) => n + m.text.length, 0);
  openModal(() => <><ModalHead title="用量统计" icon="bolt" /><div className="mbd">
    {([["对话轮数", asks + " 轮"], ["执行步骤", steps + " 步"], ["新建节点", made + " 个"], ["Agent 处理耗时", secs >= 60 ? Math.floor(secs / 60) + "m " + Math.round(secs % 60) + "s" : secs.toFixed(1) + "s"], ["对话文字（估算 tokens）", "约 " + Math.round(chars * 1.6).toLocaleString()], ["模型", a.lockedModel || a.model]] as Array<[string, string]>).map(([k, v]) => <div key={k} className="row"><span>{k}</span><b className="tnum">{v}</b></div>)}
    <p style={{ color: "var(--fg3)", fontSize: 12, marginTop: 10 }}>生成类花费以各节点实际调用为准；这里统计的是 Agent 本次对话本身。{ctl.store.state.canvasId ? "" : ""}</p>
  </div></>);
}
function compact(ctl: Ctl, a: AgentState) {
  if (a.msgs.length < 4) return ctl.store.toast("对话还很短，不需要压缩");
  const keep = a.msgs.slice(-2), old = a.msgs.slice(0, -2); const asks = old.filter((m) => m.role === "u").map((m) => m.text);
  const made = old.flatMap((m) => m.results || []).map((id) => ctl.store.node(id)).filter(Boolean).map((n) => title(n!));
  a.msgs = [{ id: mid(), role: "a", summary: true, text: `【对话摘要】之前 ${asks.length} 轮：${asks.map((t) => "「" + t.slice(0, 18) + "」").join("、")}${made.length ? `；新建了 ${made.join("、")}` : ""}。` }, ...keep];
  a.emit(); ctl.store.toast(`已把 ${old.length} 条早期消息压缩成 1 条摘要`);
}
/** 录音计时条用 mm:ss */
const voiceClock = (seconds: number) => String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");

/* ---------- 记忆 / 技能 ---------- */
export function memoryModal(a: AgentState) { openModal(() => <MemoryView a={a} />); }
function MemoryView({ a }: { a: AgentState }) {
  useAgent(a); const [tab, setTab] = useState<"user" | "canvas">("user"); const [v, setV] = useState("");
  const list = tab === "user" ? a.memUser : a.memCanvas;
  const add = () => { const t = v.trim(); if (!t) return; setV(""); void a.addMemory(tab, t).catch((error) => { a.businessError = error instanceof Error ? error.message : "记忆保存失败"; a.emit(); }); };
  return <><ModalHead title="记忆" icon="brain" /><div className="mbd">
    <div className="row" style={{ padding: "0 0 10px" }}><span>在对话里使用记忆<small style={{ display: "block", color: "var(--fg3)", fontSize: 12 }}>关闭后 Agent 不读取也不引用下面的内容；说「记住…」仍会写入</small></span><button className={"sw" + (a.memOn ? " on" : "")} id="memOn" onClick={() => { a.memOn = !a.memOn; a.saveMem(); }} /></div>
    <MemorySettingsPanel a={a} />
    <CanvasProfilePanel a={a} />
    <div className="seg" style={{ padding: "0 0 8px" }}><button className={tab === "user" ? "on" : ""} onClick={() => setTab("user")}>用户记忆 · {a.memUser.length}</button><button className={tab === "canvas" ? "on" : ""} onClick={() => setTab("canvas")}>本画布 · {a.memCanvas.length}</button></div>
    <div className="memlist">{list.map((t) => <div key={t.resourceRef} className="memitem"><span>{t.text}</span><button className="ib" aria-label="删除" onClick={() => { void a.deleteMemory(t).catch((error) => { a.businessError = error instanceof Error ? error.message : "记忆删除失败"; a.emit(); }); }}><Icon name="trash" size="xs" /></button></div>)}{!list.length ? <div className="row" style={{ color: "var(--fg3)" }}><span>暂无</span></div> : null}</div>
    <div className="memadd"><input id="memIn" value={v} placeholder={tab === "user" ? "跨画布生效的偏好，例如：海报都用 3:4" : "只对这张画布有效的事实，例如：主色曜石黑"} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") add(); }} /><button className="btn solid" id="memAdd" onClick={add}>添加</button></div>
    <div className="memadd" style={{ marginTop: 8 }}><button className="btn" id="legacyImport" onClick={() => void a.importLegacy()}>导入旧版本机数据</button><small style={{ color: "var(--fg3)" }}>仅当前账号确认后导入；旧对话只导出，不伪造 Task。</small></div>
    {a.importState ? <p role="status" style={{ color: "var(--fg3)", fontSize: 12 }}>{a.importState}</p> : null}
    {a.businessError ? <p role="alert" className="gp-warn">{a.businessError}</p> : null}
    <p style={{ color: "var(--fg3)", fontSize: 12, marginTop: 10 }}>也可以直接在对话里说「记住……」。</p>
  </div></>;
}
export function skillsModal(a: AgentState) { openModal(() => <SkillsView a={a} />); }
function SkillsView({ a }: { a: AgentState }) {
  useAgent(a); const [q, setQ] = useState(""); const list = a.skills.filter((k) => !q || (k.name + k.desc).includes(q));
  return <><ModalHead title="管理技能" icon="sparkle" /><div className="mbd">
    <div className="pal-s" style={{ margin: "0 0 10px" }}><Icon name="search" size="s" /><input placeholder="搜索技能" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
    {(["我的", "官方"] as const).map((src) => { const l = list.filter((k) => k.src === src); return l.length ? <div key={src}><div className="mh" style={{ paddingLeft: 0 }}>{src === "我的" ? "我的技能" : "官方技能"} · {l.length}</div>{l.map((k) => <div key={k.name} className="skrow"><SkillIcon className="ic" skill={k} /><span className="m"><b title={k.desc}>{k.name}</b></span><button className="linkbtn" onClick={() => skillEditor(a, k)}>查看</button><button className={"sw" + (k.on ? " on" : "")} aria-label="启用" onClick={() => { k.on = !k.on; a.saveSkills(k); }} /></div>)}</div> : null; })}
    <div className="memadd" style={{ marginTop: 12 }}><button className="btn" onClick={() => uploadSkill(a)}><Icon name="upload" size="s" />上传技能文件</button><button className="btn solid" onClick={() => skillEditor(a)}><Icon name="plus" size="s" />创建技能</button></div>
  </div></>;
}
export function skillEditor(a: AgentState, k?: Skill) { openModal(() => <SkillEditor a={a} k={k} />); }
function SkillEditor({ a, k }: { a: AgentState; k?: Skill }) {
  const ro = k?.src === "官方"; const [name, setName] = useState(k?.name || ""); const [desc, setDesc] = useState(k?.desc || ""); const [md, setMd] = useState(k?.md || "");
  const save = () => { if (!name.trim() || !desc.trim()) return; const body = md || `---\nname: ${name}\ndescription: ${desc}\n---\n`; if (k) Object.assign(k, { name, desc, md: body, kw: name }); else a.skills.unshift({ name, desc, kw: name, md: body, src: "我的", on: true }); a.saveSkills(k || a.skills[0], true); closeModal(); };
  return <><ModalHead title={k ? k.name : "创建技能"} icon="sparkle" /><div className="mbd skform">
    <label>名称<input value={name} readOnly={ro} placeholder="例如：节日促销海报" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
    <label>什么时候用<input value={desc} readOnly={ro} placeholder="一句话，Agent 靠它判断何时调用" onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
    <label>SKILL.md<textarea rows={9} value={md} readOnly={ro} placeholder="写给 Agent 的步骤说明" onChange={(e) => setMd(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
    <div className="memadd">{ro ? <><span style={{ color: "var(--fg3)", fontSize: 12, flex: 1 }}>官方技能只读，可以「复制为我的」后修改</span><button className="btn" onClick={() => { const c: Skill = { ...k!, id: undefined, name: k!.name + "（我的）", src: "我的", on: true }; a.skills.unshift(c); a.saveSkills(c, true); skillEditor(a, c); }}>复制为我的</button></> : <><span style={{ flex: 1 }} /><button className="btn" onClick={closeModal}>取消</button><button className="btn solid" onClick={save}>保存</button></>}</div>
  </div></>;
}
export function uploadSkill(a: AgentState) {
  const fi = document.createElement("input"); fi.type = "file"; fi.accept = ".md,.skill,.txt";
  fi.onchange = async () => { const f = fi.files?.[0]; if (!f) return; let md = ""; try { md = await f.text(); } catch { /* 读不了就用文件名 */ }
    const name = (/^name:\s*(.+)$/m.exec(md) || [])[1]?.trim() || f.name.replace(/\.(md|skill|txt)$/i, ""); const desc = (/^description:\s*(.+)$/m.exec(md) || [])[1]?.trim() || "上传的技能";
    a.skills.unshift({ name, desc, kw: name, md: md || `---\nname: ${name}\ndescription: ${desc}\n---\n`, src: "我的", on: true }); a.saveSkills(a.skills[0], true); };
  fi.click();
}

/* ---------- 全屏时的画布预览窗 ---------- */
function PreviewWin({ ctl, onClose }: { ctl: Ctl; onClose: () => void }) {
  const doc = useS((s) => s.doc); const ref = useRef<HTMLCanvasElement>(null); const win = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const g = c.getContext("2d")!; const css = (k: string) => getComputedStyle(document.querySelector(".cn-root") || document.documentElement).getPropertyValue(k).trim();
    g.fillStyle = css("--bg"); g.fillRect(0, 0, c.width, c.height); if (!doc.nodes.length) return;
    const xs = doc.nodes.map((n) => n.x), ys = doc.nodes.map((n) => n.y); const bb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...doc.nodes.map((n) => n.x + n.w)) - Math.min(...xs), h: Math.max(...doc.nodes.map((n) => n.y + n.h + 24)) - Math.min(...ys) };
    const s = Math.min((c.width - 40) / bb.w, (c.height - 40) / bb.h); const ox = 20 - bb.x * s + ((c.width - 40) - bb.w * s) / 2, oy = 20 - bb.y * s + ((c.height - 40) - bb.h * s) / 2;
    g.strokeStyle = `rgba(${css("--ink")},.25)`; doc.edges.forEach((e) => { const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to); if (!a || !b) return; g.beginPath(); g.moveTo(ox + (a.x + a.w) * s, oy + (a.y + 24 + a.h / 2) * s); g.lineTo(ox + b.x * s, oy + (b.y + 24 + b.h / 2) * s); g.stroke(); });
    doc.nodes.forEach((n) => { g.fillStyle = css("--card"); g.fillRect(ox + n.x * s, oy + (n.y + 24) * s, n.w * s, n.h * s); const src = isGenKind(n.kind) ? srcOf(n) : ""; if (src && !isAssetRef(src)) { const im = new Image(); im.onload = () => g.drawImage(im, ox + n.x * s, oy + (n.y + 24) * s, n.w * s, n.h * s); im.src = src; } });
  }, [doc]);
  return <div className="aprev" id="aPrevWin" ref={win}>
    <div className="aph" onPointerDown={(e) => { const pw = win.current!; const r = pw.getBoundingClientRect(); const ox = e.clientX - r.left, oy = e.clientY - r.top; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); (e.currentTarget as HTMLElement).onpointermove = (ev) => { Object.assign(pw.style, { left: Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - ox)) + "px", top: Math.max(8, Math.min(innerHeight - r.height - 8, ev.clientY - oy)) + "px", right: "auto", bottom: "auto" }); }; (e.currentTarget as HTMLElement).onpointerup = (ev) => { (ev.currentTarget as HTMLElement).onpointermove = null; }; }}><Icon name="map" size="xs" />画布预览<span className="sp" /><button className="ib" style={{ width: 24, height: 24 }} onClick={onClose}><Icon name="x" size="xs" /></button></div>
    <canvas ref={ref} width={640} height={400} onClick={() => { ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.fitTo(ctl.store.state.doc.nodes), 60); }} />
  </div>;
}
/** 验收口：?debugWebimg=1 / loading / failed / web-off 的模拟参考图卡（14 张本地封面，七种来源） */
const DEBUG_WEBIMG_COVERS = [
  ["01187c87648aee74", "莫兰迪灰调静物参考", 1200], ["0389e5954f8908c1", "奶油风客厅配色参考", 1080],
  ["0455ac4ee5a0a96c", "清晨窗边早餐氛围", 1600], ["055dcc637a4f328d", "木质桌面产品摆拍", 1200],
  ["056fd55d32343985", "低饱和卧室一角", 900], ["05bdc823c1062ff5", "白墙绿植留白构图", 1200],
  ["0645d6766e95586b", "咖啡杯特写参考", 1080], ["0688e9501818eaf1", "通勤包袋场景图", 1600],
  ["073c895dfcd8fc3c", "极简护肤品陈列", 1200], ["07874e42baee6c23", "午后书桌暖光", 1080],
  ["08d6e2ac600bddee", "冷调玻璃质感参考", 1200], ["096b31e3795c3097", "原木家居角落", 900],
  ["0a69a411e63d6261", "布艺沙发质感参考", 1200], ["0c2431b6084821e1", "晨光卧室细节", 1080],
] as const;
/** 验收口固定 7 个来源 × 2 张：覆盖全部契约来源，任何人打开 ?debugWebimg=1 都能看到 7 个筛选 chips */
const DEBUG_WEBIMG_SOURCES = ["huaban", "duitang", "bing", "360", "bingglobal", "pinterest", "artstation"] as const;
const DEBUG_WEBIMG_PAGES: Record<string, string> = {
  huaban: "https://huaban.com/pins/", duitang: "https://www.duitang.com/blog/", bing: "https://www.bing.com/images/search?q=",
  "360": "https://image.so.com/i?q=", bingglobal: "https://www.bing.com/images/search?q=", pinterest: "https://www.pinterest.com/pin/",
  artstation: "https://www.artstation.com/artwork/",
};
const DEBUG_WEBIMG_SITES: Record<string, string> = { huaban: "huaban.com", duitang: "duitang.com", bing: "bing.com", "360": "so.com", bingglobal: "bing.com", pinterest: "pinterest.com", artstation: "artstation.com" };
function debugWebImageMessage(mode = "1"): AgentMsg {
  const status = mode === "loading" || mode === "failed" || mode === "web-off" ? mode : "ready";
  const items: WebImageItem[] = status !== "ready" ? [] : DEBUG_WEBIMG_COVERS.map(([hash, title, size], index) => {
    const sourceKind = DEBUG_WEBIMG_SOURCES[index % DEBUG_WEBIMG_SOURCES.length];
    return {
      id: "debug_" + index,
      title,
      original_url: "/static/store/covers/" + hash + "-sq.webp",
      thumb_url: "",
      width: size,
      height: size,
      source_page: DEBUG_WEBIMG_PAGES[sourceKind] + (index + 1),
      source_site: DEBUG_WEBIMG_SITES[sourceKind] || sourceKind + ".com",
      source_kind: sourceKind,
    };
  });
  // 数量按 items 实算（7 个来源各 2 张），别再手写死表，加来源时只改上面的 SOURCES
  const sources: Record<string, number> = status === "ready"
    ? items.reduce((acc, item) => { const kind = item.source_kind || ""; if (kind) acc[kind] = (acc[kind] || 0) + 1; return acc; }, {} as Record<string, number>)
    : {};
  const card: WebImageCardData = {
    key: "debug:" + Date.now().toString(36),
    kind: "search",
    status,
    query: "莫兰迪 静物 参考图",
    queries: ["莫兰迪 静物 参考图"],
    description: status === "ready" ? "调试入口注入的模拟参考图（?debugWebimg=1）" : "调试入口注入的模拟参考图（?debugWebimg=" + mode + "）",
    note: "",
    sources,
    items,
    error: status === "failed" ? "调试入口模拟：搜图接口超时" : "",
  };
  const text = status === "ready" ? "参考图卡调试：单击选中、双击放大。" : status === "loading" ? "参考图卡调试：正在搜索。" : status === "failed" ? "参考图卡调试：搜索失败。" : "参考图卡调试：联网未开启。";
  return { id: mid(), role: "a", text, at: Date.now(), webImages: [card] };
}


/* ---------- T8：会话流拍平（日期分隔 + 消息），以及定位到某条消息 ---------- */
type AgentRow = { kind: "day"; key: string; at: number } | { kind: "msg"; key: string; m: AgentMsg; i: number };
function agentRows(msgs: AgentMsg[]): AgentRow[] {
  const rows: AgentRow[] = []; let lastDay = -1;
  msgs.forEach((m, i) => {
    if (m.at) {
      const d = new Date(m.at); const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (day !== lastDay) { rows.push({ kind: "day", key: "day-" + day + "-" + i, at: day }); lastDay = day; }
    }
    rows.push({ kind: "msg", key: m.id, m, i });
  });
  return rows;
}
function AgentQueryLocator({ msgs }: { msgs: AgentMsg[] }) {
  const { scrollToMessage } = useMessageScroller();
  return <QueryLocator msgs={msgs} onJump={(id) => {
    const moved = scrollToMessage(id, { align: "start", behavior: "smooth" });
    if (!moved) document.querySelector('[data-msg-id="' + id + '"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  }} />;
}


/** 验收口：?debugBusy=<毫秒> 模拟助手忙碌（默认 1500）；不带参数返回 0 = 正常模式 */
function debugBusyMs(): number {
  const raw = new URLSearchParams(location.search).get("debugBusy");
  if (raw === null) return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 1500;
}
/** 验收口：?debugQueue / ?debugBusy 下的发送只在前端内存里模拟，不请求后端 */
const debugSimMs = () => debugBusyMs() || (new URLSearchParams(location.search).get("debugQueue") === "1" ? 900 : 0);
function debugSimulateSend(a: AgentState, text: string, skillName: string | null, ms: number, threadId?: string, onDone?: () => void) {
  // 后台对话的队列自动发送也走这里：结果只写回目标对话，不落到当前正在看的对话
  const tId = threadId || a.activeThreadId || "__new__";
  const ask: AgentMsg = { id: mid(), role: "u", text, at: Date.now(), skill: skillName || undefined };
  const reply: AgentMsg = { id: mid(), role: "a", text: "", at: Date.now(), think: { live: true, open: false, secs: "0", lines: [] } };
  a.appendMessages([ask, reply], tId);
  a.setThreadBusy(tId, true); a.setThreadStop(tId, false); a.emit();
  window.setTimeout(() => {
    a.patchMessage(reply, { think: { live: false, open: false, secs: (ms / 1000).toFixed(1), lines: [] }, text: "（调试模拟）这轮执行结束，队列里的下一条会接着发。" });
    a.setThreadBusy(tId, false); a.setThreadStop(tId, false); a.emit();
    // 调试模拟结束也按「该对话空闲了」继续跑它自己的队列，方便验收后台自动发送
    onDone?.();
  }, ms);
}
/** 验收口：?debugQueue=1 的两条队列消息（其中一条够长，用来验证单行省略） */
function debugQueueItems(): QueuedMsg[] {
  const make = (text: string): QueuedMsg => ({ id: qid(), label: text, snap: { text, skill: null, pinned: [], selected: [], refs: [], webPlugin: false } });
  return [
    make("把刚才那版封面调成 3:4 竖版，主标题挪到左上留白，整体配色再冷一点，杯子上的水珠保留"),
    make("再出 2 张备选，一张白底一张生活场景"),
  ];
}

/** 验收口：?debugGenCaps=1 的全能力 / 基础能力调试模型（只在前端内存；用来验收卡片参数覆盖与「不支持就隐藏」） */
function debugCapModels(): ModelSpec[] {
  const base = { vendor: "调试", tags: [] as string[], secs: 5, specSource: "spec" as const };
  return [
    { ...base, id: "debug::图片全能力", name: "图片全能力", kind: "image", ratios: ["1:1", "3:4", "16:9"], sizes: ["1K", "2K", "4K"], batch: [1, 2, 4], maxRefs: 4, i2i: true,
      qualities: ["auto", "low", "medium", "high"], thinkingMode: true, outputFormats: ["gif", "svg"], nativeBackground: true,
      search: true, style: true, camera: true, mj: { versions: ["7", "6.1", "niji 6"], speeds: ["relax", "fast"], hd: ["7"] } },
    { ...base, id: "debug::图片基础", name: "图片基础", kind: "image", ratios: ["1:1", "3:4"], sizes: ["1K", "2K"], batch: [1], maxRefs: 0, i2i: false },
    { ...base, id: "debug::视频全能力", name: "视频全能力", kind: "video", modes: ["文生视频", "首帧", "首尾帧"],
      ratios: ["16:9", "9:16", "1:1"], res: ["480p", "720p", "1080p"], durs: [4, 6, 8], audio: true, times: [1, 2, 4],
      genModes: ["标准", "4K"], turbo: true, multiShot: true, maxRefs: 4 },
    { ...base, id: "debug::视频基础", name: "视频基础", kind: "video", modes: ["文生视频"], ratios: ["16:9"], res: ["720p"], durs: [5], times: [1], audio: false, maxRefs: 0 },
    { ...base, id: "debug::文本全能力", name: "文本全能力", kind: "text", search: true, think: ["low", "mid", "high"], vision: true },
    { ...base, id: "debug::音频调试", name: "音频调试", kind: "audio", kinds: ["配音", "音乐", "音效"], adurs: ["自适应", "15s", "30s"] },
  ];
}

/** 验收口：卡片类消息的纯前端注入（只进内存，不发请求、不写服务端/localStorage）。
 *  ?debugPlan=1 / ?debugQa=1 / ?debugSkill=1 三个口与 ?debugWebimg=1 / ?debugThinking=1 同款写法。 */
function debugGenMessages(): AgentMsg[] {
  /** 验收口：?debugGenCount=4 把待生成卡片的张数设成 4（只在前端内存，不跑生成） */
  const debugCount = Math.max(1, Math.min(8, Math.round(Number(new URLSearchParams(location.search).get("debugGenCount")) || 0)));
  const plan: AgentTaskPlan = {
    kind: "generation", requires_confirmation: true, intent: "做 2 张小红书封面 + 1 段产品短视频",
    summary: "节点、连线和提示词已经放到画布上了：「封面 01｜早八宿舍书桌 · 热水还在」、「封面 02｜自习室窗边 · 一杯热水一下午」、「镜头 1｜开盖冒热气」。还没有开始生成——在下面的待生成卡片里选好模型、尺寸 / 分辨率，点「执行生成」再生成。",
    nodes: [
      { node_id: "dbg1", title: "封面 01｜早八宿舍书桌 · 热水还在", kind: "image", prompt: "小红书竖版封面图，3:4 竖构图。清晨的大学宿舍书桌，7 点左右的自然光从左侧窗户斜射进来，在桌面上拉出柔和的窗格光影，桌面上摆着一只 450ml 哑光奶白色直饮保温杯。" },
      { node_id: "dbg2", title: "封面 02｜自习室窗边 · 一杯热水一下午", kind: "image", prompt: "小红书竖版封面图，3:4 竖构图。大学自习室窗边座位，午后柔和的侧逆光透过窗玻璃照进来，一只女生的手正握着同样的保温杯。" },
      { node_id: "dbg3", title: "镜头 1｜开盖冒热气", kind: "video", prompt: "特写，手拧开保温杯密封旋盖，热气缓缓升起，清晨窗边逆光，5 秒，镜头缓慢推进。" },
    ],
    steps: [
      { tool: "run_generation", args: { node_id: "dbg1", type: "image", settings: { ratio: "3:4", resolution: "2k", ...(debugCount ? { count: debugCount } : {}) } }, description: "生成「封面 01」" },
      { tool: "run_generation", args: { node_id: "dbg2", type: "image", settings: { ratio: "3:4", resolution: "2k", ...(debugCount ? { count: debugCount } : {}) } }, description: "生成「封面 02」" },
      { tool: "run_generation", args: { node_id: "dbg3", type: "video", settings: { ratio: "9:16", duration: 5 } }, description: "生成「镜头 1」" },
    ],
  };
  /** 验收口：?debugGenKinds=1 再挂一个文本节点 / 一条配音节点，验收四类行的参数（文本节点目前只有卡片能改参数） */
  if (new URLSearchParams(location.search).get("debugGenKinds") === "1") {
    plan.nodes = [...(plan.nodes || []),
      { node_id: "dbg4", title: "卖点表｜3 行文案", kind: "text", prompt: "把保温杯的 3 个卖点整理成表格，每行一个卖点加一句口播。" },
      { node_id: "dbg5", title: "口播｜开盖那一下", kind: "audio", prompt: "轻声旁白：清晨的第一口热水，从拧开盖子开始。" }];
    plan.steps = [...(plan.steps || []),
      { tool: "run_generation", args: { node_id: "dbg4", type: "text", settings: { output: "table" } }, description: "生成「卖点表」" },
      { tool: "run_generation", args: { node_id: "dbg5", type: "audio", settings: { kind: "配音", dur: "自适应" } }, description: "生成「口播」" }];
  }
  /** 验收口：?debugGenOnly=image|video|text|audio 只留这一类节点，验收「只有一种类型时只有一张卡」 */
  const onlyKind = String(new URLSearchParams(location.search).get("debugGenOnly") || "").trim().toLowerCase();
  if (onlyKind === "image" || onlyKind === "video" || onlyKind === "text" || onlyKind === "audio") {
    plan.nodes = (plan.nodes || []).filter((node) => node.kind === onlyKind);
    plan.steps = (plan.steps || []).filter((step) => String((step.args || {}).type || "") === onlyKind);
  }
  const confirm = { ...newCard("", [
    { q: "审查发现 1 个结果不符合要求，要重新生成吗？", options: ["重新生成", "先不重做"] },
    { q: "要改哪里？可以直接勾选，或者自己写（可多选）", options: ["杯盖结构不对", "左侧留白不够", "构图 / 角度", "风格 / 色调", "产品外观 / 细节", "文字 / 字幕"], multi: true },
  ], "confirm", { items: [
    { node_id: "dbg1", label: "封面 01｜早八宿舍书桌 · 热水还在", kind: "image", prompt: "小红书竖版封面图，3:4 竖构图。清晨的大学宿舍书桌，密封旋盖保温杯立在桌面右侧，左侧留白。", issues: ["杯盖看起来像敞口，不是密封旋盖", "左侧留白不够，主体太居中"], ok: false },
    { node_id: "dbg2", label: "封面 02｜自习室窗边 · 一杯热水一下午", kind: "image", prompt: "", issues: [], ok: true },
  ] }) };
  return [
    { id: mid(), role: "a", at: Date.now(), took: 18.2, text: plan.summary || "",
      think: { live: false, open: false, secs: "18.2", lines: ["整体方案：\n1. 写策划\n2. 出封面\n3. 出短视频"] },
      tools: [{ label: "新建图片节点", state: "done", secs: "0.3" }, { label: "新建图片节点", state: "done", secs: "0.2" }, { label: "新建视频节点", state: "done", secs: "0.2" }],
      task: { taskId: "debug-gen", status: "COMPLETED", plan } },
    { id: mid(), role: "a", at: Date.now(), took: 36, text: "这批生成完成了：2 个成功。\n自动审查：画面整体氛围不错，但封面 01 杯盖结构与留白要求不符。",
      reviews: [{ summary: "画面整体氛围不错，但封面 01 杯盖结构与留白要求不符。", model: "gemini-3.1-flash-lite-preview", items: [
        { label: "封面 01｜早八宿舍书桌 · 热水还在", node_id: "dbg1", kind: "image", url: "/static/store/covers/01187c87648aee74-sq.webp", ok: false, issues: ["杯盖看起来像敞口，不是密封旋盖", "左侧留白不够，主体太居中"], revised_prompt: "小红书竖版封面图，3:4 竖构图。清晨大学宿舍书桌，7 点自然光从左侧窗户斜射；一只 450ml 哑光奶白色直饮保温杯立在桌面右侧，密封旋盖扣紧，左侧留出标题位。" },
        { label: "封面 02｜自习室窗边 · 一杯热水一下午", node_id: "dbg2", kind: "image", url: "/static/store/covers/0389e5954f8908c1-sq.webp", ok: true, issues: [], revised_prompt: "" },
        { label: "镜头 1｜开盖冒热气", node_id: "dbg3", kind: "video", url: "/static/store/covers/0455ac4ee5a0a96c-sq.webp", ok: true, issues: [], revised_prompt: "" }] }],
      qa: confirm },
  ];
}
function debugSelfCheckMessage(fail: boolean): AgentMsg {
  return {
    id: mid(), role: "a", at: Date.now(), took: 6.2, procOpen: true,
    text: "三张封面已经按方案改好，标题都压到 18 字以内。",
    think: { live: false, open: true, secs: "6.2", kinds: ["roadmap", "reflect"], lines: ["整体方案：沿用冷白光与左上留白，改三张封面的标题与尺寸", "反思：第 1 轮漏了尺寸校验，这轮先核对比例再改标题"] },
    selfCheck: fail
      ? { round: 3, passed: false, items: [
          { text: "5 个镜头都生成成功", ok: true },
          { text: "标题都在 18 字以内", ok: false },
          { text: "尺寸统一 3:4", ok: false },
        ] }
      : { round: 3, passed: true, items: [{ text: "封面 3 张都已生成", ok: true }, { text: "标题 ≤18 字", ok: true }] },
  };
}
function debugPlanMessage(): AgentMsg {
  const plan: AgentTaskPlan = {
    intent: "用选中的红色杯子做主图，出一张电商首图",
    summary: "先写提示词，再生成 1 张 1:1 主图",
    reason: "画布上已经有产品素材，直接复用比重新生成参考图更快",
    assumptions: ["产品主体就是画布上选中的那张图", "这次只出 1 张，用来先定风格"],
    requires_confirmation: true,
    impact: { generations: 1, writes: 2, nodes: 2 },
    roadmap: [
      { stage: "阶段一：定风格", detail: "先出 1 张主图定冷白光与留白", generations: 1, acceptance: "主图 1:1、冷白光、标题左上有留白" },
      { stage: "阶段二：出封面", detail: "按同一设定补 2 张竖版封面", generations: 2, acceptance: "3 张封面都生成成功，标题 ≤18 字" },
    ],
    steps: [
      { tool: "create_node", index: 0, description: "新建提示词节点：红色杯子，白色背景，电商主图，柔和棚拍光", args: { node_type: "prompt" } },
      { tool: "connect_nodes", index: 1, description: "把提示词节点连到图片节点", args: { from_index: 0, to_index: 2 } },
      { tool: "generate_image", index: 2, description: "生成 1 张 1:1 主图", args: { ratio: "1:1", count: 1 } },
    ],
  };
  return {
    id: mid(), role: "a", at: Date.now(), took: 2.4,
    text: "方案已生成（3 步），点下面的「执行」才会真的在画布上执行。",
    think: { live: false, open: false, secs: "2.4", lines: ["先确认画布上的主体素材，再决定提示词与比例"] },
    tools: [{ label: "读取画布与选中节点", state: "done", secs: "0.6" }, { label: "拆解方案与参数", state: "done", secs: "1.2" }],
    task: { taskId: "debug-plan", status: "COMPLETED", plan },
  };
}
/** 验收口：?debugChecklist=run|done|fail|info 的任务清单消息：事件按后端快照的形状造出来，再走 taskChecklist 同一套解析，
 *  所以截图看到的就是真实链路的渲染结果（run = 2 完成 + 1 进行中 + 2 待办；done = 全部完成；fail = 中间一步失败；
 *  info = 中间一步是可纠正的失败（带 recoverable 标记），其余完成）。 */
function debugChecklistMessage(mode: string): AgentMsg {
    const steps = [
        { index: 0, tool: "read_node", description: "读取画布与选中的 3 个节点" },
        { index: 1, tool: "write_xlsx", description: "把待办整理成一张表格" },
        { index: 2, tool: "update_node", description: "更新 3017（等你的 Mac 唤醒）" },
        { index: 3, tool: "generate_image", description: "生成 1 张 1:1 主图" },
        { index: 4, tool: "connect_nodes", description: "把主图连到封面节点" },
    ];
    const events: Array<Record<string, any>> = [{ eventType: "harness.tool_proposed", safePayload: { callId: "plan:1", plan: { steps } } }];
    const fire = (index: number, state: "started" | "succeeded" | "failed", extra?: Record<string, any>) => events.push({ eventType: "tool.execution." + state, safePayload: { callId: "step:" + index, toolId: steps[index].tool, ...(extra || {}) } });
    const finish = (index: number) => { fire(index, "started"); fire(index, "succeeded"); };
    finish(0);
    if (mode === "fail") { fire(1, "started"); fire(1, "failed"); }
    else if (mode === "info") { fire(1, "started"); fire(1, "failed", { code: "github_skill_install_failed", error: "仓库中有多个 SKILL.md，请用 path 指定一个：a/SKILL.md、b/SKILL.md", recoverable: true }); }
    else finish(1);
    if (mode === "done" || mode === "info") { finish(2); finish(3); finish(4); } else fire(2, "started");
    const succeeded = mode === "done" || mode === "info";
    const snapshot: AgentTaskSnapshot = { taskId: "debug-checklist", status: succeeded ? "SUCCEEDED" : "RUNNING", steps: [], events, calls: [], artifacts: [], verifications: [] };
    return {
        id: mid(), role: "a", at: Date.now(), took: 12.4,
        text: succeeded ? "方案里的 5 步已经全部做完。" : "正在按方案推进，完成后会自动审查。",
        think: { live: false, open: false, secs: "12.4", lines: ["先读画布，再更新节点、出图并连线"] },
        task: { taskId: "debug-checklist", status: snapshot.status, checklist: taskChecklist(snapshot) },
    };
}
function debugQaMessage(): AgentMsg {
  const card = newCard("用产品图和产品信息做一套 3 张的卖点海报", [
    { q: "这套海报主要用在哪里？", options: ["小红书封面", "电商主图", "详情页头图"] },
    { q: "希望什么调性？", options: ["干净白底", "生活场景", "高对比促销"], multi: true },
  ]);
  return {
    id: mid(), role: "a", at: Date.now(), took: 1.2,
    text: "开始之前想先确认几件事，选好后我再动手：",
    think: { live: false, open: false, secs: "1.2", lines: [] },
    qa: card,
  };
}
function debugSkillMessages(): AgentMsg[] {
  const source = "https://github.com/tingqi-18040332311/fashion-editorial-skill";
  const preview = {
    previewId: "debug-preview",
    repository: "tingqi-18040332311/fashion-editorial-skill",
    sourceUrl: source,
    branch: "main",
    commit: "9f1c2b7d3a4e5f60718293a4b5c6d7e8f9012345",
    sha256: "b1946ac92492d2347c6235b4d2611184a0d1e2f3b4c5d6e7f80912233445566",
    skills: [
      { name: "fashion-editorial", description: "把模特与服装图合成胶片感大片", path: "skills/fashion-editorial/SKILL.md" },
      { name: "lookbook-copy", description: "给成片写一句卖点文案", path: "skills/lookbook-copy/SKILL.md" },
    ],
    scripts: ["scripts/build-index.mjs"],
    excluded: [],
    bytes: 18432,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const think = { live: false, open: false, secs: "0.8", lines: ["已固定仓库 commit 并检查 Skill 内容，尚未安装"] };
  return [
    { id: mid(), role: "a", at: Date.now(), took: 0.8, text: "", think, skillInstall: { status: "ready", source, preview } },
    { id: mid(), role: "a", at: Date.now(), took: 0.5, text: "", think: { ...think, lines: ["已导入 2 个 Skill，默认不启用"] }, skillInstall: { status: "installed", source, preview, packId: "debug-pack", skillCount: 2 } },
  ];
}
/** 验收口：?debugContext=1 / =unknown 注入一条带真实分层的助手消息。
 *  事件先按后端形状造出来，再走同一个解析函数，验收时看到的就是真实链路的渲染结果。
 *  known = 模型窗口已知（有百分比）；unknown = 窗口未知（只显示绝对值，不显示猜的百分比）。 */
function debugContextMessages(kind: "known" | "unknown", compact: boolean): AgentMsg[] {
    const layers = { system: 13557, memory: 640, history: 1240, canvas: 4769, transcript: 2680, instruction: 214 };
    const used = Object.values(layers).reduce((sum, tokens) => sum + tokens, 0);
    const known = kind !== "unknown";
    const events: Array<Record<string, any>> = [{
        eventType: "context_usage",
        safePayload: { used_tokens: used, max_tokens: known ? 200000 : 0, percentage: known ? Math.round(used * 1000 / 200000) / 10 : null, source: "estimate", round: 3, layers },
    }];
    if (compact) events.push(
        { eventType: "context_compacted", safePayload: { id: "debug-cc:fold", level: "fold", before_tokens: 31800, after_tokens: 24100, round: 2 } },
        { eventType: "context_compacted", safePayload: { id: "debug-cc:summary", level: "summary", before_tokens: 24100, after_tokens: 16800, round: 3 } },
    );
    return [{
        id: mid(), role: "a", at: Date.now(), took: 6.4,
        text: "（调试注入）这一轮用的是后端真实的上下文占用，点右下角的占用按钮可以看各层明细。",
        think: { live: false, open: false, secs: "6.4", lines: [] },
        tools: [{ label: "读取画布与选中节点", state: "done", secs: "0.5" }],
        usage: contextUsageOf(events) || undefined,
        compactions: contextCompactionsOf(events),
    }];
}
/** 验收口：?debugStream=hold|done 模拟阶段三流式：
 *  推理逐字（reasoning_delta 语义）→ 工具「正在准备」占位行 → 原地转正 → 回复逐字（message_delta 语义）。
 *  hold = 一直保持流式中途（截图用）；done = 跑完收尾。只在前端内存，不发请求。 */
function debugStreamScript(a: AgentState, mode: "hold" | "done" | "json" | "json-raw") {
    const threadId = a.activeThreadId || "__new__";
    const reasonChunks = ["先看画布上已有的封面节点和尺寸，", "确认这轮要改的是「阶段二」那三张封面；", "冷白光和左上留白的设定沿用，", "标题文案压到 18 字以内，", "尺寸保持 3:4 竖版。", ""];
    const replyChunks = ["这三张封面按上一轮的设定改：", "保留冷白光和左上留白，", "标题压到 18 字以内，", "尺寸仍是 3:4 竖版；", "改完把节点参数回写画布。", ""];
    const m: AgentMsg = { id: mid(), role: "a", at: Date.now(), text: "", streaming: true, reasoning: "", tools: [], think: { live: true, open: false, secs: "0", lines: [] } };
    a.appendMessage(m, threadId);
    a.setThreadBusy(threadId, true);
    a.emit();
    const jsonChunks = ['{"thought":"先看画布', '上已有的封面，', '再把标题压到 18 字",', '"steps":[{"tool":"read_node",', '"description":"读取画布与选中节点"}],', '"roadmap":[]}'];
    let reasoning = ""; let text = ""; let ri = 0; let ti = 0; let prepareTicks = 0; let jsonIndex = 0; let rawJson = "";
    let phase: "reason" | "json" | "prepare" | "step" | "reply" | "end" = "reason";
    const timer = window.setInterval(() => {
        if (phase === "reason") {
            if (ri < reasonChunks.length) { reasoning += reasonChunks[ri]; ri += 1; a.patchMessage(m, { reasoning }); return; }
            phase = jsonIndex < jsonChunks.length ? "json" : "prepare"; return;
        }
        if (phase === "json") {
            // JSON 模式：第 1 轮正文是决策 JSON（真实后端 message_delta 就是这么发的）。
            // json = 修好之后：同一段 JSON 用生产规则过滤（looksLikeDecisionJson），气泡保持空白；
            // json-raw = 模拟修复前：原样塞进气泡，用来出「前后对比」的对比图。
            if (jsonIndex < jsonChunks.length) {
                rawJson += jsonChunks[jsonIndex]; jsonIndex += 1;
                a.patchMessage(m, { text: mode === "json-raw" ? rawJson : (looksLikeDecisionJson(rawJson) ? "" : rawJson), streaming: true });
                return;
            }
            phase = "prepare"; return;
        }
        if (phase === "prepare") {
            // 占位行停留一段时间（真实后端准备工具也可能几十毫秒到几百毫秒）
            if (!m.tools?.length) { a.patchMessage(m, { tools: [{ label: "正在准备：读取画布与选中节点", state: "run", callId: "delta:1", tool: "read_node", provisional: true }] }); return; }
            prepareTicks += 1;
            if (prepareTicks < 4) return;
            phase = "step"; return;
        }
        if (phase === "step") {
            a.patchMessage(m, { tools: [{ label: "读取画布与选中节点", state: "run", callId: "step:0", tool: "read_node" }] });
            phase = "reply"; return;
        }
        if (phase === "reply") {
            if (ti < replyChunks.length) { text += replyChunks[ti]; ti += 1; a.patchMessage(m, { text, streaming: true }); return; }
            phase = "end"; return;
        }
        window.clearInterval(timer);
        if (mode === "done" || mode === "json" || mode === "json-raw") {
            a.patchMessage(m, {
                text, streaming: false, took: 3.2, reasoning,
                think: { live: false, open: false, secs: "3.2", lines: ["整体方案：沿用冷白光与左上留白，改三张封面的标题与尺寸"] },
                tools: [{ label: "读取画布与选中节点", state: "done", secs: "0.4", callId: "step:0", tool: "read_node" }],
            });
            a.setThreadBusy(threadId, false);
            a.emit();
        }
    }, 180);
}

/** 验收口：?debugCjk=1 注入中文加粗样例：第 1、2 行是修好的情况，第 3 行是「本来就正常」的对照，
 *  4/5/6 行验证行内 code、围栏代码块、未配对星号都没被动过（只在前端内存，不发请求）。 */
function debugCjkMessage(): AgentMsg {
    const text = [
        "1. 这一轮**完成了「阶段二」**的画面生成（闭合 ** 前是 」，后紧跟汉字）",
        "2. 他说**「阶段二」**就开工（开场后是标点、闭合前也是标点）",
        "3. 对照：**加粗**后面的汉字 / **加粗**，后面是标点 / **加粗** 后面是空格 / 行尾**加粗」**",
        "4. 行内 code 里的星号不动：`**原样」**后文`",
        "5. 围栏代码块里的星号也不动：",
        "```md",
        "**代码块里的星号」**后文",
        "```",
        "6. 没配对的星号不动：这里是 **未配对 收工。",
    ].join("\n");
    return { id: mid(), role: "a", at: Date.now(), took: 0.6, text, think: { live: false, open: false, secs: "0.6", lines: [] } };
}
/** 验收口：?debugThinking=1 注入一条「正在思考 + 一步执行中」的消息（只在前端内存，不发请求、不写服务端） */
function debugThinkingMessage(): AgentMsg {
  return { id: mid(), role: "a", text: "", at: Date.now(), think: { live: true, open: false, secs: "0", lines: [] },
    tools: [{ label: "读取画布与选中节点", state: "done", secs: "0.6" }, { label: "按参考图生成主图", state: "run", secs: undefined }, { label: "整理结果节点", state: "wait", secs: undefined }] };
}

/** 验收口：?debugWebsearch=1 注入一条「搜索中」+ 一条「已完成 6 条来源」的消息（只在前端内存，不发请求、不写服务端） */
function debugWebSearchMessages(): AgentMsg[] {
    const sources: WebSearchCardData["sources"] = [
        { title: "早八宿舍书桌｜一只保温杯也能拍出杂志感", url: "https://www.xiaohongshu.com/explore/cover-desk", snippet: "3:4 竖构图，左上留白放标题，产品在右下，整体冷白光。" },
        { title: "保温杯产品图怎么摆？电商主图的 5 个留白公式", url: "https://www.zhihu.com/question/cover-layout", snippet: "主体不超过画面 1/3，留白处放大字标题更醒目。" },
        { title: "自习室窗边一杯水的一下午｜vlog 分镜参考", url: "https://www.bilibili.com/video/BV1cover", snippet: "侧逆光穿过窗玻璃，桌面反光作为前景层。" },
        { title: "秋冬保温杯赛道：小红书封面都在用这 3 种版式", url: "https://36kr.com/p/cover-003", snippet: "左文右图、上图下文、居中对称三种版式占比最高。" },
        { title: "设计小报｜版式里的呼吸感从哪里来", url: "https://sspai.com/post/layout-air", snippet: "间距比字号更能决定画面的高级感。" },
        { title: "拍产品图的光：柔光箱与窗光的差别", url: "https://www.douban.com/note/light-setup", snippet: "窗光更硬，柔光箱更适合电商主图。" },
    ];
    // 真实链路里这次「联网搜索」已经换成上面的卡片，不再留步骤行；调试消息照真实样子来
    const tools: AgentMsg["tools"] = [{ label: "读取画布与选中节点", state: "done", secs: "0.6", callId: "debug-step:1" }];
    return [
        { id: mid(), role: "a", text: "", at: Date.now(), think: { live: true, open: false, secs: "0", lines: [] }, tools,
          webSearch: [{ key: "debug-ws-1", query: "小红书 保温杯 早八 封面 排版", status: "searching", sources: [], description: "", error: "" }] },
        { id: mid(), role: "a", text: "翻了 6 个网页：这类「宿舍 / 自习室 + 保温杯」的封面基本是左上留白放标题、主体压在右下、整体冷白光。按这个排版出封面会更像爆款。", at: Date.now(), took: 9.4,
          think: { live: false, open: false, secs: "9.4", lines: ["先联网找同类封面，再按找到的版式给方案"] }, tools,
          webSearch: [{ key: "debug-ws-2", query: "小红书 保温杯 早八 封面 排版", status: "done", sources, description: "", error: "" }] },
    ];
}

export { genOf };
