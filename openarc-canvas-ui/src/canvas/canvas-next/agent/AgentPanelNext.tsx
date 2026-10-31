/**
 * 右侧 Agent：对话、思考过程、工具步骤、确认卡片、结果卡片；输入区（上下文贴片、技能标签、+ 菜单、/ 技能、@ 引用、
 * 模式、上下文圆环、模型、语音）；技能管理、记忆、压缩对话、历史对话、全屏 + 画布预览窗。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { addFiles, title } from "../actions";
import { genOf, isGenKind, srcOf, TYPE_ICON, type GenKind } from "../model";
import { useCtl, useS, type Ctl } from "../ui/ctx";
import { Icon, Logo } from "../ui/Icon";
import { closeModal, ModalHead, openModal, openPop } from "../ui/overlay";
import { useAssetUrl } from "../ui/useAsset";
import { Markdown } from "../ui/markdown";
import { ruleAnswer } from "./planner";
import { MentionPalette } from "./MentionPalette";
import { QueryLocator } from "./QueryLocator";
import { AgentState, useAgent, type AgentMsg, type Skill } from "./state";
import { subscribeAgentTask, TASK_UI_SETTLED, taskAnswer, taskStatusText, taskToolSteps, type RefreshOutcome } from "./task";

const SUGS: Array<[Parameters<typeof Icon>[0]["name"], string, string, string]> = [
  ["brain", "帮我延续这个项目的记忆", "保留已经确定的设定、风格和方向。", "回顾这张画布和记忆，总结已经确定的设定、风格和方向，之后都按这个来"],
  ["sparkle", "体验头脑风暴一起设计故事", "发散多个故事方向，并收束一个重点。", "@@头脑风暴"],
  ["sparkle", "生成一套卖点海报", "读取产品图和产品信息，拆 3 个卖点，各出一张海报", "用产品图和产品信息做一套 3 张的卖点海报"],
  ["grid", "拆成表格批量出图", "需求 → 多维表格 → 逐行出图", "把这个需求拆成多维表格，再逐行批量出图"],
  ["video", "把两张图做成短片", "用首尾帧生成 10 秒视频", "把选中的两张图做成一条 10 秒短片"],
  ["search", "这张画布现在什么状态", "列出还没生成和缺输入的节点", "检查一下这张画布还缺什么"],
];
const CTX_MAX = 200000;
const mid = () => "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AgentPanel() {
  const ctl = useCtl(); const store = ctl.store;
  const a = useMemo(() => new AgentState(store.state.canvasId), [store]);
  useAgent(a);
  useEffect(() => () => { a.dispose(); }, [a]);
  const ui = useS((s) => s.ui); const doc = useS((s) => s.doc); const models = useS((s) => s.models);
  const taRef = useRef<HTMLTextAreaElement>(null); const scrollRef = useRef<HTMLDivElement>(null); const boxRef = useRef<HTMLDivElement>(null);
  const [sugPage, setSugPage] = useState(0); const seen = useRef(0);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const taskWatchers = useRef(new Map<string, () => void>());
  useEffect(() => () => { taskWatchers.current.forEach((off) => off()); taskWatchers.current.clear(); }, []);
  useEffect(() => { let live = true; void store.backend.defaultChatModel?.().then((id) => { if (live) setDefaultModelId(id || null); }); return () => { live = false; }; }, [store.backend, models]);
  const frozenModelId = [...a.msgs].reverse().find((m) => m.task?.modelConfigId)?.task?.modelConfigId || null;
  const modelLabel = frozenModelId ? models.find((m) => m.id === frozenModelId)?.name || "任务冻结模型" : models.find((m) => m.id === defaultModelId)?.name || (models.some((m) => m.kind === "text") ? "默认对话模型" : "未配置对话模型");
  const modelHint = (frozenModelId ? "任务冻结模型：" : "默认对话模型：") + modelLabel + "，在系统设置里更改";

  // 上下文：固定的 + 当前选中的（可移除）
  const ctxNodes = (): Array<{ n: CanvasNode; pinned: boolean }> => {
    const pinned = a.pinned.map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
    const sel = [...store.state.ui.sel].filter((id) => !a.muted.has(id) && !a.pinned.includes(id)).map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
    return [...pinned.map((n) => ({ n, pinned: true })), ...sel.map((n) => ({ n, pinned: false }))];
  };
  useEffect(() => { [...a.muted].forEach((id) => { if (!ui.sel.has(id)) a.muted.delete(id); }); }, [ui.sel, a]);
  // 画布上点选加入上下文
  useEffect(() => { const on = (e: Event) => { const id = (e as CustomEvent).detail as string; if (!a.pinned.includes(id)) a.pinned.push(id); a.emit(); }; addEventListener("cn:agent-pick", on); return () => removeEventListener("cn:agent-pick", on); }, [a]);
  useEffect(() => { const el = scrollRef.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight; });

  const ctxBreak = (): Array<[string, number]> => [["系统与工具", 3200], ["技能", a.skill ? 900 : 0], ["记忆", a.memory().length * 60], ["画布与已选节点", ctxNodes().length * 600 + doc.nodes.length * 80], ["对话历史", a.msgs.reduce((s, m) => s + m.text.length * 2 + (m.tools ? m.tools.length * 180 : 0), 0)]];
  const used = ctxBreak().reduce((s, x) => s + x[1], 0);
  const setDraft = (t: string) => { a.draft = t; a.emit(); setTimeout(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = t.length; } }, 0); };
  const patch = (m: AgentMsg, p: Partial<AgentMsg>) => { Object.assign(m, p); a.msgs = [...a.msgs]; a.emit(); };
  const stream = async (m: AgentMsg, full: string) => { patch(m, { streaming: true, text: "" }); const step = Math.max(2, Math.round(full.length / 40)); for (let k = 0; k < full.length; k += step) { if (a.stop) break; patch(m, { text: full.slice(0, k) }); await sleep(24); } patch(m, { text: full, streaming: false }); };

  const brainstorm = () => { a.skill = "头脑风暴"; setDraft(a.skills.find((k) => k.name === "头脑风暴")?.desc || ""); };

  function watchTask(m: AgentMsg, taskId: string, t0: number) {
    let refreshed = ""; let refreshOutcome: RefreshOutcome = "not_required";
    const watcher = subscribeAgentTask(store.backend, taskId, (snapshot) => {
      const settled = TASK_UI_SETTLED.has(snapshot.status);
      const effect = settled ? "terminal" : snapshot.events.filter((e) => /side_effect\.succeeded|execution\.succeeded/.test(String(e.eventType))).map((e) => String(e.eventId)).join(",");
      if (effect && effect !== refreshed && (snapshot.status === "SUCCEEDED" || snapshot.status === "COMPLETED")) refreshOutcome = "pending";
      patch(m, { task: { taskId, status: snapshot.status, modelConfigId: snapshot.modelConfigId, stopRequested: m.task?.stopRequested }, tools: taskToolSteps(snapshot), text: taskAnswer(snapshot, refreshOutcome) || m.text, streaming: false, think: m.think ? { ...m.think, live: false, secs: ((performance.now() - t0) / 1000).toFixed(1) } : undefined, took: settled ? (performance.now() - t0) / 1000 : m.took });
      a.busy = !settled; a.stop = false; a.emit();
      if (effect && effect !== refreshed) {
        refreshed = effect;
        void store.refreshAuthoritative().then((outcome) => { if (refreshed !== effect) return; refreshOutcome = outcome; patch(m, { text: taskAnswer(snapshot, refreshOutcome) || m.text }); });
      }
    }, () => taskWatchers.current.delete(taskId));
    if (!watcher.settled()) taskWatchers.current.set(taskId, watcher.stop);
  }

  async function send() {
    let text = a.draft.trim(); const skill = a.skill ? a.skills.find((s) => s.name === a.skill) || null : null;
    if ((!text && !skill) || a.busy) return; if (!text) text = skill!.desc;
    const ctx = ctxNodes().map((x) => x.n); const refs = a.refs;
    a.msgs = [...a.msgs, { id: mid(), role: "u", text, at: Date.now(), skill: skill?.name, ctx: [...ctx.map((n) => ({ id: n.id, title: title(n), kind: n.kind, src: isGenKind(n.kind) ? srcOf(n) : undefined })), ...refs.map((r) => ({ id: r.id, title: r.title, kind: r.kind, src: r.kind === "asset" ? r.ref : undefined }))] }];
    a.draft = ""; a.pinned = []; a.refs = []; a.skill = null; a.stop = false; a.busy = true;
    const m: AgentMsg = { id: mid(), role: "a", text: "", at: Date.now(), think: { live: true, open: false, secs: "0", lines: [] } }; a.msgs = [...a.msgs, m]; a.emit();
    const t0 = performance.now();
    try {
      if (/^(请)?(记住|记一下|以后都|下次)/.test(text)) {
        const fact = text.replace(/^(请)?(记住|记一下)[，,：: ]*/, ""); const scope = /这张画布|本画布|这个项目|产品/.test(text) ? "canvas" : "user";
        await a.addMemory(scope, fact);
        patch(m, { think: { live: false, open: false, secs: ((performance.now() - t0) / 1000).toFixed(1), lines: [] }, tools: [{ label: `写入${scope === "user" ? "用户" : "画布"}记忆`, state: "done", secs: "0.1" }], memSaved: { scope: scope === "user" ? "用户" : "画布", text: fact } });
        await stream(m, a.memOn ? "记住了，之后的对话和生成都会参考这条。" : "记住了。注意：记忆目前是关闭的，打开后才会在对话里使用。"); return;
      }
      if (store.backend.runAgentTask) {
        const goal = (text + (skill ? "\n\n本次技能要求：" + skill.desc : "")).slice(0, 2000);
        const resourceRefs = [...ctx.map((n) => isGenKind(n.kind) ? srcOf(n) : ""), ...refs.filter((r) => r.kind === "asset").map((r) => r.ref)].filter((ref) => /^(openarc-asset:|resource:\/\/)/.test(ref)).slice(0, 16);
        const submitted = await store.backend.runAgentTask({ goal, context: { schemaVersion: 1, canvasId: store.state.canvasId, selectedNodeIds: ctx.map((n) => n.id).slice(0, 16), resourceRefs, completionConditions: ["完成用户目标；画布写入必须经受控工具批准并读回验证"] } });
        if (!submitted.ok || !submitted.taskId) throw new Error(submitted.error || "任务提交失败");
        patch(m, { task: { taskId: submitted.taskId, status: submitted.status || "PENDING" }, think: { live: false, open: false, secs: "0", lines: ["目标、画布引用与完成条件已提交 OpenArc 任务运行时"] }, text: "任务已提交；等待 OpenArc 分配工具与执行。" });
        watchTask(m, submitted.taskId, t0); return;
      }
      const ans = ruleAnswer(store, text, ctx);
      patch(m, { think: { live: false, open: false, secs: ((performance.now() - t0) / 1000).toFixed(1), lines: [] }, acts: ans.acts });
      await stream(m, ans.text);
    } catch (err) {
      patch(m, { streaming: false, think: m.think ? { ...m.think, live: false } : undefined, error: err instanceof Error ? err.message : "Agent 调用失败", text: m.text || "" });
    } finally {
      if (!m.took) m.took = (performance.now() - t0) / 1000;
      if (!m.task || TASK_UI_SETTLED.has(m.task.status)) a.busy = false;
      a.emit();
    }
  }

  /** 分支对话：把到这条为止的消息复制成一段新对话，原对话存进历史 */
  const branch = (i: number) => { const keep = a.msgs.slice(0, i + 1).map((x) => ({ ...x })); a.archive(); a.msgs = keep; a.lockedModel = null; seen.current = keep.length; a.emit(); store.toast("已从这条消息分出新对话，原对话保存在对话列表里"); };

  async function stopTask() {
    const m = a.msgs.find((msg) => msg.task && !TASK_UI_SETTLED.has(msg.task.status));
    if (!m?.task) { a.stop = true; a.emit(); return; }
    patch(m, { task: { ...m.task, status: "STOPPING", stopRequested: true } });
    const res = await store.backend.cancelAgentTask?.(m.task.taskId);
    if (res && !res.ok) { patch(m, { task: { ...m.task, status: "RUNNING", stopRequested: false }, error: res.error || "停止失败" }); }
  }

  const onInput = (v: string) => { a.draft = v; a.emit(); if (v === "/" || /\s\/$/.test(v)) slashPalette(); else if (v.endsWith("@")) mentionMenu(); };
  const slashPalette = () => { const box = boxRef.current!; openPop(box, (close) => <Palette a={a} onPick={(s) => { close(); a.skill = s; a.draft = a.draft.replace(/\/$/, ""); a.emit(); taRef.current?.focus(); }} width={box.offsetWidth} />, "up", "left", "palette"); };
  const mentionMenu = () => openPop(boxRef.current!, (close) => <MentionPalette nodes={store.state.doc.nodes} onNode={(n) => { close(); if (!a.pinned.includes(n.id)) a.pinned.push(n.id); setDraft(a.draft.replace(/@$/, "@" + title(n) + " ")); }} onRef={(ref) => { close(); if (!a.refs.some((x) => x.id === ref.id)) a.refs.push(ref); setDraft(a.draft.replace(/@$/, "@" + ref.title + " ")); }} />, "up", "left", "palette");
  const full = ui.agentFull;
  const ctxItems = ctxNodes();
  return (
    <aside id="agent" className={(ui.agentOpen ? "" : "closed") + (full ? " full" : "")}>
      <div className="ah">
        {full ? <span className="logo" style={{ display: "grid", placeItems: "center", width: 30 }}><Logo /></span> : null}
        <button className={"ib tipB" + (ui.filesOpen ? " on" : "")} id="aFiles" data-tip="侧边栏 · 文件" onClick={() => store.setUI({ filesOpen: !ui.filesOpen })}><Icon name="folder" size="s" /></button>
        <button className="t" id="aConv" onClick={(e) => convMenu(a, e.currentTarget)}>{a.msgs.length ? (a.msgs.find((m) => m.role === "u")?.text.slice(0, 14) || "当前对话") : "新建对话"}<Icon name="down" size="xs" /></button><span className="sp" />
        <button className="ib tipB" id="aNew" data-tip="新对话" onClick={() => { a.archive(); a.msgs = []; a.lockedModel = null; seen.current = 0; a.emit(); store.toast("已开始新对话，上一段保存在对话列表里"); }}><Icon name="pencil" size="s" /></button>
        <button className="ib tipB" id="aFull" data-tip={full ? "Agent 居右" : "Agent 全屏"} onClick={() => { store.setUI({ agentFull: !full }); a.prevOpen = !full; a.emit(); }}><Icon name={full ? "panel" : "expand"} size="s" /></button>
        {full ? <button className={"ib tipB" + (a.prevOpen ? " on" : "")} id="aPrev" data-tip="显示画布预览" onClick={() => { a.prevOpen = !a.prevOpen; a.emit(); }}><Icon name="map" size="s" /></button> : null}
        <button className="ib tipB" id="aMore" data-tip="更多选项" onClick={(e) => moreMenu(ctl, a, e.currentTarget, modelLabel)}><Icon name="more" size="s" /></button>
        <button className="ib narrow-only" id="aClose" aria-label="收起 Agent" onClick={() => store.setUI({ agentOpen: false, agentFull: false })}><Icon name="x" size="s" /></button>
      </div>
      <div className="ab" id="aScroll" ref={scrollRef}><div className="acol" id="aBody">
        {!a.msgs.length ? <div className="hello"><h2><span>Hi{ctl.host.user?.name ? " " + ctl.host.user.name : ""}！</span><br />今天一起创作点什么？</h2>
          {SUGS.slice((sugPage % 3) * 2, (sugPage % 3) * 2 + 2).map(([ic, t, d, q], k) => <button key={t} className="sug" data-q={q} style={{ ["--r" as string]: (k ? 1.2 : -1.2) + "deg" }} onClick={() => (q === "@@头脑风暴" ? brainstorm() : setDraft(q))}><span className="si"><Icon name={ic} size="s" /></span><span><b>{t}</b><small>{d}</small></span><Icon name="right" size="s" /></button>)}
          <button className="ib tipT" id="aRefresh" data-tip="换一批" style={{ alignSelf: "flex-end", width: 28, height: 28 }} onClick={() => setSugPage(sugPage + 1)}><Icon name="history" size="xs" /></button></div>
          : a.msgs.map((m, i) => <Msg key={m.id} m={m} i={i} isNew={i >= seen.current} a={a} ctl={ctl} onRetry={() => { const u = a.msgs.slice(0, i).reverse().find((x) => x.role === "u"); if (u) { a.draft = u.text; void send(); } }} onBranch={() => branch(i)} onQ={setDraft} />)}
        <SeenMark onSeen={() => (seen.current = a.msgs.length)} />
      </div><QueryLocator msgs={a.msgs} onJump={(id) => { scrollRef.current?.querySelector(`[data-msg-id="${id}"]`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }} /></div>
      {!a.msgs.length && a.draft && !a.skill && !a.hintOff ? <div className="ahint"><Icon name="brain" size="xs" /><span>用头脑风暴，开启你的项目创作。</span><button className="linkbtn" onClick={brainstorm}>试一下</button><button className="ib" aria-label="不再提示" onClick={() => a.dismissHint()}><Icon name="x" size="xs" /></button></div> : null}
      <div className="ai" id="aiBox" ref={boxRef}>
        <div className="ctxrow" id="aCtx">
          {ctxItems.map(({ n, pinned }) => <CtxTile key={n.id} n={n} pinned={pinned} onRemove={() => { a.muted.add(n.id); a.pinned = a.pinned.filter((x) => x !== n.id); a.emit(); }} />)}
          {a.refs.map((ref) => <span className="skchip" key={ref.id} title={ref.kind === "app" ? "应用工具：" + ref.ref : "素材引用"}><Icon name={ref.kind === "app" ? "grid" : "folder"} size="xs" />{ref.title}<button className="x" aria-label={"移除 " + ref.title} onClick={() => { a.refs = a.refs.filter((x) => x.id !== ref.id); a.emit(); }}><Icon name="x" size="xs" /></button></span>)}
          {a.skill ? <span className="skchip" title={"已加载技能：" + a.skill}><Icon name="sparkle" size="xs" />{a.skill}<button className="x" data-unskill aria-label="移除技能" onClick={() => { a.skill = null; a.emit(); }}><Icon name="x" size="xs" /></button></span> : null}
          {ctxItems.some((x) => !x.pinned) ? <button className="linkbtn" id="aPin" onClick={() => { ctxItems.filter((x) => !x.pinned).forEach((x) => a.pinned.push(x.n.id)); a.emit(); store.toast("已固定到本次对话，取消选中也会保留"); }}><Icon name="plus" size="xs" />添加画布内容</button> : null}
          {ui.agentPick ? <span className="cchip">点画布上的节点加入上下文 · Esc 结束</span> : null}
        </div>
        <textarea id="aiInput" ref={taRef} rows={2} placeholder={full ? "描述创意或需求，/ 使用技能，@ 引用参考或使用应用" : "随心输入"} value={a.draft} onChange={(e) => { onInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <div className="foot">
          <button className="ib" style={{ width: 30, height: 30 }} id="aPlus" aria-label="添加" onClick={(e) => plusMenu(ctl, a, e.currentTarget, () => slashPalette())}><Icon name="plus" size="s" /></button>
          <button className="pill ghost" id="aMode" onClick={(e) => openPop(e.currentTarget, (close) => <>{([["manual", "cursor", "手动确认", "Agent 自动规划与只读执行，写入由你逐次批准"], ["auto", "bolt", "自动规划", "Agent 自动规划与只读执行，写入仍需你的可信批准"]] as const).map(([k, ic, t, d]) => <button key={k} className={"mi" + (a.mode === k ? " on" : "")} data-m={k} onClick={() => { close(); a.setMode(k); }}><span className="ic"><Icon name={ic} size="s" /></span><span>{t}<span className="d">{d}</span></span>{a.mode === k ? <span className="k"><Icon name="check" size="s" /></span> : null}</button>)}</>, "up")}><Icon name={a.mode === "auto" ? "bolt" : "cursor"} size="s" />{a.mode === "auto" ? "自动规划" : "手动确认"}<Icon name="down" size="xs" /></button>
          <span className="sp" />
          <button className="ib" style={{ width: 30, height: 30 }} id="aRing" aria-label="上下文占用" onClick={(e) => ctxPopover(ctl, a, e.currentTarget, ctxBreak(), modelLabel)}><Ring p={Math.min(1, used / CTX_MAX)} /></button>
          <button className="pill ghost locked tipT" id="aModel" aria-label={modelHint} data-tip={modelHint} onClick={() => store.toast(modelHint)}><Icon name="sparkle" size="s" />{modelLabel}</button>
          <button className="ib" style={{ width: 30, height: 30 }} id="aMic" aria-label="语音输入" onClick={(e) => micInput(ctl, e.currentTarget, (t) => setDraft((a.draft ? a.draft + " " : "") + t))}><Icon name="mic" size="s" /></button>
          {a.busy ? <button className="send busy" id="aSend" title="停止" onClick={() => { void stopTask(); }}><i className="ring"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></svg></i><span className="sqr" /></button>
            : <button className="send" id="aSend" title="发送 ↵" onClick={() => void send()}><Icon name="send" size="s" /></button>}
        </div>
      </div>
      {full && a.prevOpen ? <PreviewWin ctl={ctl} onClose={() => { a.prevOpen = false; a.emit(); }} /> : null}
    </aside>
  );
}

function SeenMark({ onSeen }: { onSeen: () => void }) { useEffect(() => { onSeen(); }); return null; }
function Ring({ p }: { p: number }) { const c = 2 * Math.PI * 7; return <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" /><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(c * p).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 9 9)" /></svg>; }

function CtxTile({ n, pinned, onRemove }: { n: CanvasNode; pinned: boolean; onRemove: () => void }) {
  const url = useAssetUrl(isGenKind(n.kind) ? srcOf(n) : "");
  return <span className={"ctile" + (pinned ? " pinned" : "")} title={title(n) + (pinned ? "" : "（随选中变化）")}>{url ? <img src={url} alt="" draggable={false} /> : <span className="ct"><Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="xs" /><em>{title(n)}</em></span>}<button className="x" aria-label="移除" onClick={onRemove}><Icon name="x" size="xs" /></button></span>;
}
function MentionRow({ n, onClick }: { n: CanvasNode; onClick: () => void }) {
  const url = useAssetUrl(isGenKind(n.kind) ? srcOf(n) : "");
  return <button className="mi" onClick={onClick}>{url ? <img src={url} style={{ width: 24, height: 24, borderRadius: 6, objectFit: "cover" }} alt="" /> : <span className="ic" style={{ width: 24, height: 24 }}><Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="xs" /></span>}<span>{title(n)}<span className="d">{n.kind === "table" ? "多维表格" : { text: "文本", image: "图片", video: "视频", audio: "音频" }[n.kind as GenKind]}</span></span></button>;
}

const toolIcon = (label: string): Parameters<typeof Icon>[0]["name"] => /读取|检查|计算/.test(label) ? "eye" : /连线|连入|连到/.test(label) ? "link" : /新建|创建/.test(label) ? "plus" : /生成|运行/.test(label) ? "sparkle" : /排布|整理/.test(label) ? "grid" : /记忆/.test(label) ? "brain" : "bolt";
function Msg({ m, i, isNew, a, ctl, onRetry, onBranch, onQ }: { m: AgentMsg; i: number; isNew: boolean; a: AgentState; ctl: Ctl; onRetry: () => void; onBranch: () => void; onQ: (q: string) => void }) {
  const nw = isNew ? " new" : "";
  const copy = async () => { try { await navigator.clipboard.writeText(m.text || ""); ctl.store.toast("已复制"); } catch { ctl.store.toast("剪贴板不可用"); } };
  if (m.role === "u") return <div className={"msg u" + nw} data-i={i} data-msg-id={m.id}>
    {m.ctx?.length || m.skill ? <div className="ctxs">{m.skill ? <span className="skchip"><Icon name="sparkle" size="xs" />{m.skill}</span> : null}{m.ctx?.map((c) => <CtxThumb key={c.id} c={c} />)}</div> : null}
    <div className="bub">{m.text}</div><MessageTime at={m.at} /><div className="mact"><button title="复制" onClick={copy}><Icon name="copy" size="xs" /></button></div></div>;
  const patch = (p: Partial<AgentMsg>) => { Object.assign(m, p); a.msgs = [...a.msgs]; a.emit(); };
  return <div className={"msg a" + nw} data-i={i} data-msg-id={m.id}>
    <Proc m={m} patch={patch} />
    {m.memSaved ? <div className="memrow"><Icon name="check" size="xs" />已写入{m.memSaved.scope}记忆：{m.memSaved.text}<button className="linkbtn" onClick={() => memoryModal(a)}>管理</button></div> : null}
    {m.text ? <div className="bub md-chat"><Markdown text={m.text} />{m.streaming ? <span className="caret" /> : null}</div> : null}
    {m.error ? <div className="gp-warn" style={{ margin: "4px 0" }}><Icon name="alert" size="s" /><span>{m.error}</span></div> : null}
    {m.task ? <div className="confirm" data-task-id={m.task.taskId} data-task-status={m.task.status}><div className="ch"><Icon name="layers" size="s" /><b>OpenArc 任务</b><span className="sp" /><span className="tag">{taskStatusText(m.task.status)}</span></div></div> : null}
    {m.results?.length ? <div className="mentions">{m.results.map((id) => <NodeMention key={id} id={id} ctl={ctl} />)}</div> : null}
    {m.acts ? <div className="qacts">{m.acts.map((q) => <button key={q} className="btn" onClick={() => onQ(q)}>{q}</button>)}</div> : null}
    <MessageTime at={m.at} />
    {!m.think?.live && !m.streaming && !a.busy ? <div className="mact">
      <button className="tipT" data-tip="复制" aria-label="复制" onClick={copy}><Icon name="copy" size="xs" /></button>
      <button className={"tipT" + (m.fb === "up" ? " on" : "")} data-tip="好评" aria-label="好评" onClick={() => { patch({ fb: m.fb === "up" ? undefined : "up" }); ctl.store.toast("感谢反馈"); }}><Icon name="thumbup" size="xs" /></button>
      <button className={"tipT" + (m.fb === "down" ? " on" : "")} data-tip="差评" aria-label="差评" onClick={() => { patch({ fb: m.fb === "down" ? undefined : "down" }); ctl.store.toast("已记录，会用来改进回答"); }}><Icon name="thumbdown" size="xs" /></button>
      <button className="tipT" data-tip="分支对话" aria-label="分支对话" onClick={onBranch}><Icon name="branch" size="xs" /></button>
      <button className="tipT" data-tip="重新生成" aria-label="重新生成" onClick={onRetry}><Icon name="history" size="xs" /></button>
    </div> : null}
  </div>;
}

function MessageTime({ at }: { at?: number }) {
  if (!at) return null;
  const d = new Date(at);
  return <time className="mtime" dateTime={d.toISOString()}>{d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} {d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}
/** 处理过程（同 TapNow）：进行中逐条显示「已思考 Ns · 摘要」与每一步；完成后折叠成「处理了 1m 12s」 */
function Proc({ m, patch }: { m: AgentMsg; patch: (p: Partial<AgentMsg>) => void }) {
  const tools = m.tools || []; const th = m.think;
  if (!th && !tools.length) return null;
  const live = !!th?.live || tools.some((t) => t.state === "run") || !!m.streaming && !m.took;
  const done = tools.filter((t) => t.state === "done").length;
  const fmt = (s: number) => (s >= 60 ? Math.floor(s / 60) + "m " + Math.round(s % 60) + "s" : (s < 10 ? s.toFixed(1) : Math.round(s)) + "s");
  const open = live || m.procOpen === true;
  const thinkLine = th && !th.live ? <div className="prow think" key="th"><span className="pi"><Icon name="brain" size="xs" /></span><span className="pl">已思考 {th.secs}s{th.lines[0] ? <em> · {th.lines[0]}</em> : null}</span></div> : null;
  return <div className={"proc" + (open ? " open" : "") + (live ? " live" : "")}>
    {live ? (th?.live ? <div className="pstat"><i className="spn" /><span className="shim">正在思考</span></div> : null)
      : <button className="phd" onClick={() => patch({ procOpen: !open })}>处理了 {fmt(m.took || Number(th?.secs) || 0)}{tools.length ? <span className="pc tnum"> · {done}/{tools.length} 步</span> : null}<Icon name="right" size="xs" /></button>}
    {open ? <div className="plist">
      {thinkLine}
      {open && th && !th.live && m.procOpen ? <div className="pthink">{th.lines.map((l, k) => <p key={k}>{l}</p>)}</div> : null}
      {tools.map((t, k) => <div key={k} className={"prow " + t.state}><span className="pi">{t.state === "run" ? <i className="spn" /> : <Icon name={toolIcon(t.label)} size="xs" />}</span><span className="pl">{t.label}</span><span className="ps tnum">{t.state === "done" ? (t.secs != null ? t.secs + "s" : "") : t.state === "skip" ? "跳过" : t.state === "error" ? "失败" : t.state === "wait" ? "待执行" : ""}</span></div>)}
    </div> : null}
  </div>;
}
/** 回复里引用的节点（TapNow 的 mention 胶囊）：点一下定位到画布 */
function NodeMention({ id, ctl }: { id: string; ctl: Ctl }) {
  const n = useS((s) => s.doc.nodes.find((x) => x.id === id)); const url = useAssetUrl(n && isGenKind(n.kind) ? srcOf(n) : "");
  if (!n) return null;
  return <button className="mention" onClick={() => { if (ctl.store.state.ui.agentFull) ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.focusNode(id), 60); }}>{url ? <img src={url} alt="" draggable={false} /> : <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="xs" />}<span>{title(n)}</span></button>;
}
function CtxThumb({ c }: { c: { title: string; kind: string; src?: string } }) { const url = useAssetUrl(c.src || ""); return url ? <img className="cthumb" src={url} alt="" title={c.title} /> : <span className="cchip"><Icon name={c.kind === "table" ? "grid" : TYPE_ICON[c.kind as GenKind] || "layers"} size="xs" />{c.title}</span>; }
function ResultCard({ id, ctl }: { id: string; ctl: Ctl }) {
  const n = useS((s) => s.doc.nodes.find((x) => x.id === id)); const url = useAssetUrl(n && isGenKind(n.kind) ? srcOf(n) : "");
  if (!n) return null;
  return <button className="rcard" onClick={() => { if (ctl.store.state.ui.agentFull) ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.focusNode(id), 60); }}>{url ? <img src={url} alt="" draggable={false} /> : <span className="ri"><Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" /></span>}<span className="rt">{title(n)}</span></button>;
}

/* ---------- 菜单 / 面板 ---------- */
function Palette({ a, onPick, width }: { a: AgentState; onPick: (s: string) => void; width: number }) {
  const [q, setQ] = useState(""); const list = a.skillsOn().filter((k) => !q || (k.name + k.desc).includes(q));
  return <div style={{ width }}>
    <div className="pal-s"><Icon name="search" size="s" /><input autoFocus placeholder="搜索技能" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && list[0]) onPick(list[0].name); }} /></div>
    <div className="mh">技能</div>
    {list.map((k) => <button key={k.name} className="pal-row" onClick={() => onPick(k.name)}><span className="ic"><Icon name="sparkle" size="s" /></span><b>{k.name}</b><span className="pd">{k.desc}</span><span className="src">{k.src}</span></button>)}
    {!list.length ? <div className="row" style={{ color: "var(--fg3)" }}><span>没有匹配的技能</span></div> : null}
  </div>;
}
function plusMenu(ctl: Ctl, a: AgentState, anchor: Element, slash: () => void) {
  const store = ctl.store;
  const Root = ({ close, go }: { close: () => void; go: (v: string) => void }) => <>
    <button className="mi" onClick={() => { close(); store.setUI({ agentPick: true }); store.toast("点画布上的节点加入 Agent 上下文，Esc 结束"); }}><Icon name="cursor" size="s" />从画布添加</button>
    <button className="mi" onClick={() => { close(); const fi = document.createElement("input"); fi.type = "file"; fi.multiple = true; fi.accept = "image/*,video/*,audio/*"; fi.onchange = () => { void addFiles(store, [...(fi.files || [])], ctl.center()).then(() => { [...store.state.ui.sel].forEach((id) => a.pinned.push(id)); a.emit(); }); }; fi.click(); }}><Icon name="upload" size="s" />上传附件</button>
    <button className="mi" onClick={() => go("skill")}><Icon name="sparkle" size="s" />技能<span className="k"><Icon name="right" size="xs" /></span></button>
    <button className="mi" onClick={() => { close(); a.skill = "头脑风暴"; a.draft = a.draft || (a.skills.find((k) => k.name === "头脑风暴")?.desc || ""); a.emit(); }}><Icon name="brain" size="s" />头脑风暴</button>
    <button className="mi" onClick={() => { close(); if (ctl.host.openMcpCenter) ctl.host.openMcpCenter(); else store.toast("应用中心只在桌面版里可用"); }}><Icon name="grid" size="s" />全部应用</button>
  </>;
  function Menu({ close }: { close: () => void }) {
    const [v, setV] = useState("root");
    if (v === "skill") return <>
      <button className="mi" onClick={() => setV("root")}><Icon name="left" size="s" /><b>技能</b></button><div className="msep" />
      {a.skillsOn().map((k) => <button key={k.name} className="mi" onClick={() => { close(); a.skill = k.name; a.emit(); }}><span className="ic"><Icon name="sparkle" size="s" /></span><span>{k.name}<span className="d">{k.desc}</span></span>{k.src === "我的" ? <span className="k">我的</span> : null}</button>)}
      <div className="msep" />
      <button className="mi" onClick={() => { close(); uploadSkill(a); }}><Icon name="upload" size="s" />上传技能文件</button>
      <button className="mi" onClick={() => { close(); skillEditor(a); }}><Icon name="plus" size="s" />创建技能</button>
      <button className="mi" onClick={() => { close(); skillsModal(a); }}><Icon name="settings" size="s" />管理技能</button>
    </>;
    return <Root close={close} go={setV} />;
  }
  openPop(anchor, (close) => <Menu close={close} />, "up"); void slash;
}
function convMenu(a: AgentState, anchor: Element) {
  openPop(anchor, (close) => <>
    <button className="mi" onClick={() => { close(); a.archive(); a.msgs = []; a.emit(); }}><Icon name="pencil" size="s" />新建对话</button>
    <div className="mh">本画布的对话</div>
    {a.convs.length ? a.convs.map((c) => <button key={c.id} className="mi" onClick={() => { close(); a.archive(); a.convs = a.convs.filter((x) => x.id !== c.id); a.msgs = c.msgs; a.saveConvs(); a.emit(); }}><Icon name="msg" size="s" /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</span><span className="k">{c.msgs.length} 条</span></button>) : <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>还没有保存的对话</span></div>}
  </>);
}
function moreMenu(ctl: Ctl, a: AgentState, anchor: Element, modelLabel: string) {
  openPop(anchor, (close) => <>
    <button className="mi" onClick={() => { close(); usageModal(ctl, a, modelLabel); }}><Icon name="bolt" size="s" />用量统计</button>
    <button className="mi" onClick={() => { close(); memoryModal(a); }}><Icon name="brain" size="s" />记忆<span className="k">{a.memOn ? a.memory().length + " 条" : "已关闭"}</span></button>
    <button className="mi" onClick={() => { close(); skillsModal(a); }}><Icon name="sparkle" size="s" />管理技能<span className="k">{a.skillsOn().length} 个启用</span></button>
    <button className="mi" onClick={() => { close(); compact(ctl, a); }}><Icon name="layers" size="s" />压缩对话</button>
    <div className="msep" />
    <button className="mi" onClick={() => { close(); ctl.store.setUI({ agentOpen: false, agentFull: false }); }}><Icon name="right" size="s" />收起对话</button>
  </>, "down", "right");
}
function usageModal(ctl: Ctl, a: AgentState, modelLabel: string) {
  const asks = a.msgs.filter((m) => m.role === "u").length; const steps = a.msgs.reduce((n, m) => n + (m.tools || []).filter((t) => t.state === "done").length, 0);
  const made = a.msgs.reduce((n, m) => n + (m.results || []).length, 0); const secs = a.msgs.reduce((n, m) => n + (m.took || 0), 0);
  const chars = a.msgs.reduce((n, m) => n + m.text.length, 0);
  openModal(() => <><ModalHead title="用量统计" icon="bolt" /><div className="mbd">
    {([["对话轮数", asks + " 轮"], ["执行步骤", steps + " 步"], ["新建节点", made + " 个"], ["Agent 处理耗时", secs >= 60 ? Math.floor(secs / 60) + "m " + Math.round(secs % 60) + "s" : secs.toFixed(1) + "s"], ["对话文字（估算 tokens）", "约 " + Math.round(chars * 1.6).toLocaleString()], ["模型", modelLabel]] as Array<[string, string]>).map(([k, v]) => <div key={k} className="row"><span>{k}</span><b className="tnum">{v}</b></div>)}
    <p style={{ color: "var(--fg3)", fontSize: 12, marginTop: 10 }}>生成类花费以各节点实际调用为准；这里统计的是 Agent 本次对话本身。{ctl.store.state.canvasId ? "" : ""}</p>
  </div></>);
}
function ctxPopover(ctl: Ctl, a: AgentState, anchor: Element, b: Array<[string, number]>, modelLabel: string) {
  const tot = b.reduce((s, x) => s + x[1], 0);
  openPop(anchor, (close) => <>
    <div className="mh">上下文 · {modelLabel}</div>
    <div className="row"><span>已用</span><b className="tnum">{tot.toLocaleString()} / {CTX_MAX / 1000}K</b></div>
    <div className="ctxbar">{b.filter((x) => x[1]).map(([k, v], i) => <i key={k} style={{ width: Math.max(1.5, (v / CTX_MAX) * 100 * 6).toFixed(1) + "%", opacity: 1 - i * .16 }} title={k} />)}</div>
    {b.map(([k, v], i) => <div key={k} className="row ctxk"><span><i style={{ opacity: 1 - i * .16 }} />{k}</span><b className="tnum">{v.toLocaleString()}</b></div>)}
    <div className="msep" />
    <button className="mi" onClick={() => { close(); compact(ctl, a); }}><Icon name="layers" size="s" />压缩对话<span className="k">早期消息合成摘要</span></button>
    <button className="mi" onClick={() => { close(); memoryModal(a); }}><Icon name="brain" size="s" />记忆<span className="k">{a.memOn ? "开" : "关"}</span></button>
  </>, "up", "right");
}
function compact(ctl: Ctl, a: AgentState) {
  if (a.msgs.length < 4) return ctl.store.toast("对话还很短，不需要压缩");
  const keep = a.msgs.slice(-2), old = a.msgs.slice(0, -2); const asks = old.filter((m) => m.role === "u").map((m) => m.text);
  const made = old.flatMap((m) => m.results || []).map((id) => ctl.store.node(id)).filter(Boolean).map((n) => title(n!));
  a.msgs = [{ id: mid(), role: "a", summary: true, text: `【对话摘要】之前 ${asks.length} 轮：${asks.map((t) => "「" + t.slice(0, 18) + "」").join("、")}${made.length ? `；新建了 ${made.join("、")}` : ""}。` }, ...keep];
  a.emit(); ctl.store.toast(`已把 ${old.length} 条早期消息压缩成 1 条摘要`);
}
function micInput(ctl: Ctl, btn: HTMLElement, onText: (t: string) => void) {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) { ctl.store.toast("当前环境没有语音识别服务，可以用系统听写输入"); return; }
  const r = new SR(); r.lang = "zh-CN"; btn.classList.add("rec"); r.onresult = (e: any) => onText(String(e.results?.[0]?.[0]?.transcript || "")); r.onend = () => btn.classList.remove("rec"); r.onerror = () => ctl.store.toast("没有听清，可以再试一次"); r.start();
}

/* ---------- 记忆 / 技能 ---------- */
export function memoryModal(a: AgentState) { openModal(() => <MemoryView a={a} />); }
function MemoryView({ a }: { a: AgentState }) {
  useAgent(a); const [tab, setTab] = useState<"user" | "canvas">("user"); const [v, setV] = useState("");
  const list = tab === "user" ? a.memUser : a.memCanvas;
  const add = () => { const t = v.trim(); if (!t) return; setV(""); void a.addMemory(tab, t).catch((error) => { a.businessError = error instanceof Error ? error.message : "记忆保存失败"; a.emit(); }); };
  return <><ModalHead title="记忆" icon="brain" /><div className="mbd">
    <div className="row" style={{ padding: "0 0 10px" }}><span>在对话里使用记忆<small style={{ display: "block", color: "var(--fg3)", fontSize: 12 }}>关闭后 Agent 不读取也不引用下面的内容；说「记住…」仍会写入</small></span><button className={"sw" + (a.memOn ? " on" : "")} id="memOn" onClick={() => { a.memOn = !a.memOn; a.saveMem(); }} /></div>
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
    {(["我的", "官方"] as const).map((src) => { const l = list.filter((k) => k.src === src); return l.length ? <div key={src}><div className="mh" style={{ paddingLeft: 0 }}>{src === "我的" ? "我的技能" : "官方技能"} · {l.length}</div>{l.map((k) => <div key={k.name} className="skrow"><span className="ic"><Icon name="sparkle" size="s" /></span><span className="m"><b>{k.name}</b><small>{k.desc}</small></span><button className="linkbtn" onClick={() => skillEditor(a, k)}>查看</button><button className={"sw" + (k.on ? " on" : "")} aria-label="启用" onClick={() => { k.on = !k.on; a.saveSkills(k); }} /></div>)}</div> : null; })}
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
    doc.nodes.forEach((n) => { g.fillStyle = css("--card"); g.fillRect(ox + n.x * s, oy + (n.y + 24) * s, n.w * s, n.h * s); const src = isGenKind(n.kind) ? srcOf(n) : ""; if (src && !src.startsWith("openarc-asset:")) { const im = new Image(); im.onload = () => g.drawImage(im, ox + n.x * s, oy + (n.y + 24) * s, n.w * s, n.h * s); im.src = src; } });
  }, [doc]);
  return <div className="aprev" id="aPrevWin" ref={win}>
    <div className="aph" onPointerDown={(e) => { const pw = win.current!; const r = pw.getBoundingClientRect(); const ox = e.clientX - r.left, oy = e.clientY - r.top; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); (e.currentTarget as HTMLElement).onpointermove = (ev) => { Object.assign(pw.style, { left: Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - ox)) + "px", top: Math.max(8, Math.min(innerHeight - r.height - 8, ev.clientY - oy)) + "px", right: "auto", bottom: "auto" }); }; (e.currentTarget as HTMLElement).onpointerup = (ev) => { (ev.currentTarget as HTMLElement).onpointermove = null; }; }}><Icon name="map" size="xs" />画布预览<span className="sp" /><button className="ib" style={{ width: 24, height: 24 }} onClick={onClose}><Icon name="x" size="xs" /></button></div>
    <canvas ref={ref} width={640} height={400} onClick={() => { ctl.store.setUI({ agentFull: false }); setTimeout(() => ctl.fitTo(ctl.store.state.doc.nodes), 60); }} />
  </div>;
}
export { genOf };
