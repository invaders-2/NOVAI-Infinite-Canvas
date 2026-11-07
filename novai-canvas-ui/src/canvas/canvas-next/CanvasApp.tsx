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
      if (!dead) { hub = attachCollab(store, { forceLocal: backend.kind !== "bridge" }); ctl.collab = hub; } const n = store.state.doc.nodes; if (n.length) ctl.fitTo(n, 70, 1, false); else { const r = ctl.rect(); store.setView({ x: r.width / 2, y: r.height / 2, k: 1 }); } readyRef.current?.(store); if (!dead) runAgentQueued(store); });
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
