/**
 * 新画布入口组件。
 *
 *   <CanvasApp backend={createBridgeBackend()} canvasId="…" host={{ backToList, openModelSettings, … }} />
 *
 * backend 决定接真后端还是模拟；host 是桌面外壳提供的能力（返回列表、模型设置、共享……），没有就不显示对应入口。
 */
import { TextDocLayer } from "./ui/TextDoc";
import { TableDocLayer } from "./ui/TableNode";
import { useEffect, useMemo, useRef, useState } from "react";
import { addFiles, DOC_ACCEPT, pasteFromSystem } from "./actions";
import { repairAgentRefBoxes } from "./mediaBoxRepair";
import { AgentPanel } from "../tapnow/AgentPanel";
import type { CanvasBackend } from "./backend/types";
import { CanvasStore } from "./store";
import { Chrome, Lightbox, Toasts } from "./ui/Chrome";
import { Ctl, CtlCtx, useS, type HostActions } from "./ui/ctx";
import { Editors } from "./ui/Editors";
import { grabVideoFrame } from "./ui/editors/registry";
import { SelectionUI } from "./ui/GenPanel";
import { OverlayHost } from "./ui/overlay";
import { dispatchShortcut } from "./ui/shortcuts";
import { applyTheme, watchSystemTheme } from "./ui/theme";
import { isTyping, Viewport } from "./ui/Viewport";
import "./ui/canvas-next.css";
import { attachCollab } from "./collab";
import { StackFocusHost } from "./ui/StackNode";
import { runAgentQueued } from "./agent/autorun";
import { buildDebugBatchRatio } from "./agent/debugBatchRatio";
import type { AgentDraft } from "./homeSeed";
import { probe, usePerf } from "./perf";

/** 作用域根：所有样式都在 .cn-root 之下，主题写在它的 data-theme 上，不影响外壳 */
function Root({ children, inset }: { children: React.ReactNode; inset?: number }) {
  const theme = useS((s) => s.ui.theme); const ref = useRef<HTMLDivElement>(null);
  // 低性能模式（流畅优先）：data-perf="low" 时 canvas-next.css 末尾那段只降模糊半径与动效成本
  const perf = usePerf();
  useEffect(() => { probe(); }, []);
  // 响应式按画布自身宽度：窄 < 760 < 中 < 1280 < 宽
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => { const w = el.clientWidth; el.dataset.w = w < 760 ? "narrow" : w < 1280 ? "mid" : "wide"; }); ro.observe(el); return () => ro.disconnect(); }, []);
  // 嵌在外壳 iframe 里：先问一次顶部安全区（mac 红绿灯 / Windows 悬浮三键），外壳回信后写进变量给 #tl / #tr 让位
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data; if (!d || d.type !== "novai:canvas-chrome" || e.source !== parent) return;
      const el = ref.current; if (!el) return;
      el.style.setProperty("--cn-chrome-left", (Number(d.left) || 0) + "px");
      el.style.setProperty("--cn-chrome-right", (Number(d.right) || 0) + "px");
      // .md-lb-x 这类挂在 body 上的浮层不在 .cn-root 里，变量也要写到 <html> 才继承得到
      document.documentElement.style.setProperty("--cn-chrome-right", (Number(d.right) || 0) + "px");
      // mac 的红绿灯中心比 16px 更高：外壳给多少就用多少，没给按 16
      el.style.setProperty("--cn-chrome-top", (Number(d.top) || 16) + "px");
      // 收到这条消息说明画布在桌面外壳里：顶部渐变磨砂只在这个场景出现
      el.classList.add("has-topfx");
      // Windows 外壳的三键浮在窗口右上，会压住助手卡片顶栏图标：right>0 是「三键那套」（同 bridge 的判据），
      // 给 root 挂标记让 agent-panel-v2.css 把卡片下移；mac（right=0）/ 纯浏览器不受影响
      el.classList.toggle("has-win-controls", Number(d.right) > 0);
    };
    addEventListener("message", onMsg);
    try { parent.postMessage({ type: "novai:canvas-chrome-request" }, "*"); } catch { /* 普通窗口里 parent 就是自己 */ }
    return () => removeEventListener("message", onMsg);
  }, []);
  return <div ref={ref} className={"cn-root" + (inset ? " in-win" : "")} data-theme={theme} data-perf={perf.mode} style={inset ? ({ ["--win-inset" as string]: inset + "px" } as React.CSSProperties) : undefined}>{children}</div>;
}

/** winInset：嵌在桌面窗口里时左上角给系统红绿灯留出的宽度（px） */
export type CanvasAppProps = { backend: CanvasBackend; canvasId: string; name?: string; host?: HostActions; onReady?: (store: CanvasStore) => void; winInset?: number; agentDraft?: AgentDraft | null };

export function CanvasApp({ backend, canvasId, name, host, onReady, winInset, agentDraft }: CanvasAppProps) {
  // 只在换画布 / 换后端时新建 store：标题、宿主回调变化不能重建（重建会重新加载文档、丢掉进行中的生成结果）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ctl = useMemo(() => new Ctl(new CanvasStore(backend, canvasId, name), host || {}), [backend, canvasId]);
  // 模板/其他入口把话交给右侧助手：只在浏览器内预填并聚焦，不自动发送
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const draftSeq = useRef(0);
  useEffect(() => { if (agentDraft) setDraft(agentDraft); }, [agentDraft]);
  useEffect(() => {
    ctl.agentDraft = (text, opts) => {
      draftSeq.current += 1;
      setDraft({ seq: draftSeq.current, text, skill: opts?.skill || undefined, autoSend: opts?.autoSend === true });
    };
  }, [ctl]);
  ctl.host = host || {};
  // 批量「镜头串联」要取上一镜视频的最后一帧：用编辑器里的截帧（需要 DOM）
  ctl.store.grabFrame = (id, at) => { const n = ctl.store.node(id); return n ? grabVideoFrame(ctl.store, n, at) : Promise.resolve(""); };
  // 窗口标题变了只同步名字，不重建
  useEffect(() => { if (name && ctl.store.state.name !== name) ctl.store.set({ name }); }, [name, ctl]);
  // onReady 用引用保存：调用方每次渲染传新函数也不会触发重新载入画布（重载会冲掉还没保存的改动）
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const store = ctl.store; const fileRef = useRef<HTMLInputElement>(null); const uploadOpts = useRef<{ at?: { x: number; y: number }; target?: string; linkTo?: string; replace?: string }>({});

  useEffect(() => {
    applyTheme(store); const off = watchSystemTheme(store);
    // Agent 默认展开与否看画布自己的宽度（窗口里可能很窄），不是整块屏幕
    const w = ctl.rect().width; if (w && w < 1240 && store.state.ui.agentOpen) store.setUI({ agentOpen: false });
    let hub: ReturnType<typeof attachCollab> | null = null; let dead = false;
    void store.load().then(() => {
      if (!dead) { hub = attachCollab(store, { forceLocal: backend.kind !== "bridge" }); ctl.collab = hub; } const n = store.state.doc.nodes; if (n.length) ctl.fitTo(n, 70, 1, false); else { const r = ctl.rect(); store.setView({ x: r.width / 2, y: r.height / 2, k: 1 }); } // 验收口：?debugBatchRatio=1 —— 画布文档载入完成后、用产品 API 建批量原图比例验证数据（不在助手 effect 里做，避免被文档载入覆盖）
        if (!dead && new URLSearchParams(location.search).get("debugBatchRatio") === "1" && !store.state.doc.nodes.length) buildDebugBatchRatio(store);
        readyRef.current?.(store);
        // 老画布：助手以前建的参考图节点固定 240×240（外链参考图也量不到像素），会把图片裁掉一截；
        // 量一次真实像素按原比例摆正并写回尺寸（幂等，替换过素材的节点不会被动）
        if (!dead) void repairAgentRefBoxes(store);
        if (!dead) {
          // 兜底：加载完成后若文档里已经有 assistant 标记（agentRun / agentRunQueue / data.batch），立刻调度一次；
          // 再补两次延迟调度，覆盖「文档刚载入、面板可能还没挂载」的时序。
          const kick = () => { if (!dead) runAgentQueued(store); };
          kick();
          window.setTimeout(kick, 400);
          window.setTimeout(kick, 1500);
          try {
            const w = window as unknown as { __autorunLog?: Array<Record<string, unknown>> };
            const marks = store.state.doc.nodes.filter((n) => { const d = n.data && typeof n.data === "object" ? n.data as Record<string, unknown> : {}; return !!d.agentRun || (Array.isArray(d.agentRunQueue) && d.agentRunQueue.length > 0); }).map((n) => n.id);
            w.__autorunLog = [...(w.__autorunLog || []), { stage: "canvas-load", at: Date.now(), nodes: store.state.doc.nodes.length, edges: store.state.doc.edges.length, marks }].slice(-200);
          } catch { /* 忽略 */ }
        }
      });
    const flush = () => { void store.saveNow(); }; addEventListener("beforeunload", flush);
    return () => { dead = true; hub?.detach(); ctl.collab = null; off(); removeEventListener("beforeunload", flush); void store.dispose(); };
  }, [store, ctl]);

  // 上传入口（菜单 / 工具条 / 面板都发这个事件）
  useEffect(() => {
    const on = (e: Event) => { uploadOpts.current = (e as CustomEvent).detail || {}; fileRef.current?.click(); };
    addEventListener("cn:upload", on); return () => removeEventListener("cn:upload", on);
  }, []);
  // 粘贴图片
  useEffect(() => {
    const on = (e: ClipboardEvent) => { if (isTyping()) return; const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); void addFiles(store, files, ctl.center()); } else if (!isTyping()) pasteFromSystem(store, e.clipboardData?.getData("text/plain") || "", ctl.center()); };
    addEventListener("paste", on); return () => removeEventListener("paste", on);
  }, [store, ctl]);

  // 键盘：绑定表和帮助弹窗共用 ui/shortcuts，改键位只改那一处
  useEffect(() => {
    const on = (e: KeyboardEvent) => { dispatchShortcut(ctl, e); };
    addEventListener("keydown", on); return () => removeEventListener("keydown", on);
  }, [ctl]);

  return (
    <CtlCtx.Provider value={ctl}>
      <Root inset={winInset}>
      <div id="app">
        <div id="stage">
          <Viewport />
          <div className="cn-topfx" aria-hidden="true"><i /><i /><i /><i /></div>
          <div id="layer"><Chrome /><SelectionUI /><Editors /></div>
          <StackFocusHost />
        </div>
        <AgentPanel draft={draft ?? agentDraft} />
      </div>
      <input type="file" ref={fileRef} accept={"image/*,video/*,audio/*," + DOC_ACCEPT} multiple hidden onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ""; const o = uploadOpts.current; void addFiles(store, files, o.at || ctl.center(), { target: o.target, linkTo: o.linkTo, replace: o.replace }); }} />
      <Toasts />
      <Lightbox />
      <TextDocLayer />
      <TableDocLayer />
      <OverlayHost />
      </Root>
    </CtlCtx.Provider>
  );
}
