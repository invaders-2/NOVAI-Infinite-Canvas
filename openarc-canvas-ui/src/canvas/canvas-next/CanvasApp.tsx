/**
 * 新画布入口组件。
 *
 *   <CanvasApp backend={createBridgeBackend()} canvasId="…" host={{ backToList, openModelSettings, … }} />
 *
 * backend 决定接真后端还是模拟；host 是桌面外壳提供的能力（返回列表、模型设置、共享……），没有就不显示对应入口。
 */
import { TextDocLayer } from "./ui/TextDoc";
import { TableDocLayer } from "./ui/TableNode";
import { useEffect, useMemo, useRef } from "react";
import { addFiles, DOC_ACCEPT, copySelection, deleteSelection, duplicate, pasteFromSystem } from "./actions";
import { AgentPanel } from "../tapnow/AgentPanel";
import type { CanvasBackend } from "./backend/types";
import { CanvasStore } from "./store";
import { Chrome, Lightbox, openSearch, showKeys, Toasts, toggleCmt } from "./ui/Chrome";
import { Ctl, CtlCtx, useS, type HostActions } from "./ui/ctx";
import { Editors } from "./ui/Editors";
import { grabVideoFrame, openPointEdit } from "./ui/editors/registry";
import { outOf } from "./model";
import { SelectionUI } from "./ui/GenPanel";
import { closePop, modalOpen, OverlayHost, popOpen } from "./ui/overlay";
import { applyTheme, watchSystemTheme } from "./ui/theme";
import { isTyping, Viewport } from "./ui/Viewport";
import "./ui/canvas-next.css";
import { attachCollab } from "./collab";
import { groupSelection, ungroup } from "./ui/LegacyNodes";
import { runNodes, StackFocusHost } from "./ui/StackNode";
import { hiddenIds, isStack, stackSelection } from "./stack";

/** 作用域根：所有样式都在 .cn-root 之下，主题写在它的 data-theme 上，不影响外壳 */
function Root({ children, inset }: { children: React.ReactNode; inset?: number }) {
  const theme = useS((s) => s.ui.theme); const ref = useRef<HTMLDivElement>(null);
  // 响应式按画布自身宽度：窄 < 760 < 中 < 1280 < 宽
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => { const w = el.clientWidth; el.dataset.w = w < 760 ? "narrow" : w < 1280 ? "mid" : "wide"; }); ro.observe(el); return () => ro.disconnect(); }, []);
  return <div ref={ref} className={"cn-root" + (inset ? " in-win" : "")} data-theme={theme} style={inset ? ({ ["--win-inset" as string]: inset + "px" } as React.CSSProperties) : undefined}>{children}</div>;
}

/** winInset：嵌在桌面窗口里时左上角给系统红绿灯留出的宽度（px） */
export type CanvasAppProps = { backend: CanvasBackend; canvasId: string; name?: string; host?: HostActions; onReady?: (store: CanvasStore) => void; winInset?: number; agentDraft?: { seq: number; text: string; skill: string } | null };

export function CanvasApp({ backend, canvasId, name, host, onReady, winInset, agentDraft }: CanvasAppProps) {
  // 只在换画布 / 换后端时新建 store：标题、宿主回调变化不能重建（重建会重新加载文档、丢掉进行中的生成结果）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ctl = useMemo(() => new Ctl(new CanvasStore(backend, canvasId, name), host || {}), [backend, canvasId]);
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
      if (!dead) { hub = attachCollab(store, { forceLocal: backend.kind !== "bridge" }); ctl.collab = hub; } const n = store.state.doc.nodes; if (n.length) ctl.fitTo(n, 70, 1, false); else { const r = ctl.rect(); store.setView({ x: r.width / 2, y: r.height / 2, k: 1 }); } readyRef.current?.(store); });
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

  // 键盘
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey; const st = store.state; const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (modalOpen() || popOpen()) return; // 由弹层自己处理
        if (st.ui.pick) return store.setUI({ pick: null });
        if (st.ui.agentPick) return store.setUI({ agentPick: false });
        if (st.ui.cmtMode) return toggleCmt(ctl);
        if (st.ui.drawer) return store.setUI({ drawer: null });
        if (st.ui.editCell) return store.setUI({ editCell: null });
        if (st.ui.editText) { (document.getElementById("txtEdit") as HTMLTextAreaElement | null)?.blur(); return; }
        return store.setUI({ sel: new Set(), edge: null });
      }
      if (mod && k === "j") { e.preventDefault(); store.setUI({ agentOpen: !st.ui.agentOpen, agentFull: false }); return; }
      if (mod && k === "f") { e.preventDefault(); openSearch(ctl); return; }
      // ⌘I 指向编辑：选中一张有结果的图片 → 在图上圈出要改的地方；否则进入「点节点加入 Agent」
      if (mod && k === "i" && !isTyping() && !modalOpen()) {
        e.preventDefault(); const one = st.ui.sel.size === 1 ? store.node([...st.ui.sel][0]) : null;
        if (one && one.kind === "image" && outOf(one)?.url) { openPointEdit(one.id); store.toast("在图上圈出要改的地方，再写改法"); return; }
        if (st.ui.agentPick) { store.setUI({ agentPick: false }); return; }
        store.setUI({ agentOpen: true, agentPick: true }); store.toast("点画布上的节点加入 Agent 上下文，Esc 结束"); return;
      }
      // 按 V 开始语音输入，再按一次 V 结束（TapNow：hold V / press V）
      if (!mod && k === "v" && !e.repeat && !isTyping() && !modalOpen()) {
        e.preventDefault(); const was = st.ui.agentOpen; if (!was) store.setUI({ agentOpen: true });
        setTimeout(() => (document.getElementById("aMic") as HTMLButtonElement | null)?.click(), was ? 0 : 120); return;
      }
      if (mod && e.shiftKey && k === "l" && !isTyping()) { e.preventDefault(); const pref = st.ui.theme === "light" ? "dark" : "light"; store.setUI({ themePref: pref }); try { localStorage.setItem("openarc-canvas-theme", pref); } catch { /* 忽略 */ } applyTheme(store); store.toast(pref === "light" ? "已切换到浅色" : "已切换到深色"); return; }
      if (isTyping() || modalOpen()) return;
      if (mod && k === "z") { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
      if (mod && k === "a") { e.preventDefault(); const hidden = hiddenIds(st.doc.nodes); store.setUI({ sel: new Set(st.doc.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id)) }); return; }
      if (mod && k === "c") { copySelection(store); return; }
      if (mod && k === "d") { e.preventDefault(); duplicate(store); return; }
      if (mod && e.key === "Enter") {
        // ⌘↵：选中分组 / 多个节点时一键运行（单个生成节点在面板里 ⌘↵ 生成）
        const sel = [...st.ui.sel].map((id) => store.node(id)).filter((n): n is NonNullable<typeof n> => !!n);
        if (sel.length > 1 || (sel.length === 1 && sel[0].kind === "group")) { e.preventDefault(); runNodes(ctl, sel); return; }
      }
      if (mod && k === "g") { e.preventDefault(); e.shiftKey ? ungroup(store) : groupSelection(store); return; }
      if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); const r = ctl.rect(); ctl.zoomAt(st.view.k * 1.2, r.left + r.width / 2, r.top + r.height / 2); return; }
      if (mod && e.key === "-") { e.preventDefault(); const r = ctl.rect(); ctl.zoomAt(st.view.k / 1.2, r.left + r.width / 2, r.top + r.height / 2); return; }
      if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) { ctl.fitTo(st.doc.nodes); return; }
      if (e.key === "?") { showKeys(); return; }
      if (k === "s" && e.shiftKey && !mod && st.ui.sel.size > 1) { e.preventDefault(); stackSelection(store); return; }
      if (k === "c" && !mod) { toggleCmt(ctl); return; }
      if (e.key === "Delete" || e.key === "Backspace") { closePop(); deleteSelection(store); return; }
      if (e.key.startsWith("Arrow") && st.ui.sel.size) {
        e.preventDefault(); const d = e.shiftKey ? 10 : 1; const [dx, dy] = ({ ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] } as Record<string, number[]>)[e.key];
        // 堆叠里的成员跟着堆叠一起移动（取消堆叠后相对位置不变）
        const moving = new Set(st.ui.sel); st.ui.sel.forEach((id) => { const g = store.node(id); if (isStack(g)) (g!.children || []).forEach((c) => moving.add(c)); });
        if (!e.repeat) store.snapshot(); store.mutate((doc) => ({ ...doc, nodes: doc.nodes.map((n) => (moving.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }));
      }
    };
    addEventListener("keydown", on); return () => removeEventListener("keydown", on);
  }, [store, ctl]);

  return (
    <CtlCtx.Provider value={ctl}>
      <Root inset={winInset}>
      <div id="app">
        <div id="stage">
          <Viewport />
          <div id="layer"><Chrome /><SelectionUI /><Editors /></div>
          <StackFocusHost />
        </div>
        <AgentPanel draft={agentDraft} />
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
