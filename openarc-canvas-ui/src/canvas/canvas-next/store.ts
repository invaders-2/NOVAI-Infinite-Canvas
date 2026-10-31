/**
 * 画布状态。单一 store + useSyncExternalStore：
 *   doc      —— 持久化文档（CanvasDoc），所有改动经 mutate()，可撤销，防抖保存到后端；
 *   view     —— 视口；
 *   ui       —— 选择、弹层、抽屉等纯界面状态；
 *   runtime  —— 生成中的节点（进度、流式文本、AbortController），不进文档；
 *   models   —— 后端模型清单（ModelSpec）。
 */
import { useSyncExternalStore } from "react";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import type { CanvasBackend } from "./backend/types";
import { genOf, isGenKind, newNode, uid, withGen, type GenData, type GenKind, type ModelSpec } from "./model";

export type View = { x: number; y: number; k: number };
export type RunState = { status: "running"; progress: number; runId?: string; stream?: string; abort: AbortController; startedAt: number; batch?: { done: number; total: number } };
/** 一键运行（分组 / 多选）：进度。key = 分组 id，多选时为 "sel:" + 节点 id */
export type BatchRunState = { key: string; label: string; total: number; done: number; failed: number; queued: string[]; stopped: boolean; startedAt: number };
export type RunLog = {
  id: string; node: string; title: string; type: GenKind | "table"; model: string; status: "done" | "error" | "stopped"; secs: number; time: string; thumb?: string; error?: string;
  /** 跨项目历史用：记录时间、所在画布、结果（资源库引用 / 远程地址；大的 data URL 不存）、提示词 */
  at?: number; canvasId?: string; canvasName?: string; out?: { url?: string; frame?: string; text?: string; w?: number; h?: number; dur?: number }; prompt?: string;
};
/** 存本机前去掉大的 data URL（结果本身在资源库里，历史只留引用） */
const small = (u?: string) => (u && (!u.startsWith("data:") || u.length < 4000) ? u : undefined);
export const compactRun = (x: RunLog): RunLog => ({ ...x, thumb: small(x.thumb), out: x.out ? { ...x.out, url: small(x.out.url), frame: small(x.out.frame), text: x.out.text?.slice(0, 2000) } : undefined, prompt: x.prompt?.slice(0, 500) });
export type Toast = { id: number; html: string; out?: boolean };
export type Conn = { id: string; rev: boolean; a: { x: number; y: number }; p: { x: number; y: number }; sx: number; sy: number; over: string | null };

export type UIState = {
  sel: Set<string>;
  edge: string | null;
  drawer: null | "assets" | "history" | "comments";
  filesOpen: boolean;
  agentOpen: boolean;
  agentFull: boolean;
  /** 小地图：null = 跟随缩放自动浮出（缩小到阈值），true/false = 用户手动强制开/关 */
  mini: boolean | null;
  hideEdges: boolean;
  snap: boolean;
  /** 拖动节点时显示对齐参考线并吸附（按住 Alt 临时关闭） */
  guides: boolean;
  cmtMode: boolean;
  pick: string | null;
  /** 「替换」模式：点画布上的节点 / 素材库里的素材，替换这个节点的当前版本 */
  replace: string | null;
  agentPick: boolean;
  conn: Conn | null;
  editText: string | null;
  editCell: string | null;
  hlEdge: string | null;
  hlNode: string | null;
  preview: boolean;
  batchMode: "stack" | "spread";
  dragging: boolean;
  theme: "dark" | "light";
  themePref: "dark" | "light" | "system";
  /** 左键拖动空白：select = 框选（TapNow 默认，右键 / 中键 / 空格拖动平移）；pan = 平移（旧习惯，Shift 拖动框选） */
  leftDrag: "select" | "pan";
};

export type CanvasState = {
  canvasId: string;
  name: string;
  doc: CanvasDoc;
  version: number | null;
  saving: "idle" | "saving" | "saved" | "error" | "conflict";
  loaded: boolean;
  view: View;
  ui: UIState;
  runtime: Record<string, RunState>;
  /** 进行中的一键运行 */
  batches: Record<string, BatchRunState>;
  runs: RunLog[];
  models: ModelSpec[];
  toasts: Toast[];
  undo: CanvasDoc[];
  redo: CanvasDoc[];
  /** 多人协作：本端 id、通道（host 宿主 / local 同机窗口 / lan 局域网）、在线的其他人 */
  collab: { clientId: string | null; transport: string | null; peers: Array<{ id: string; cursor: { x: number; y: number } | null; seenAt: number; name?: string }> };
};

type Listener = () => void;

export class CanvasStore {
  state: CanvasState;
  readonly backend: CanvasBackend;
  /** 视频截帧（批量「镜头串联」用）：CanvasApp 接上编辑器里的截帧实现；测试里换成桩 */
  grabFrame: ((nodeId: string, at: "first" | "last") => Promise<string>) | null = null;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveFlight: Promise<void> | null = null;
  /** 保存进行中又有新的保存请求（期间有编辑）：这次保存结束后要再存一次 */
  private saveAgain = false;
  private disposeFlight: Promise<void> | null = null;
  private disposed = false;
  private toastTimers = new Set<ReturnType<typeof setTimeout>>();
  private toastSeq = 0;
  private modelOff: (() => void) | null = null;

  constructor(backend: CanvasBackend, canvasId: string, name = "未命名画布") {
    this.backend = backend;
    let pref: UIState["themePref"] = "system";
    let leftDrag: UIState["leftDrag"] = "select";
    try { pref = (localStorage.getItem("openarc-canvas-theme") as UIState["themePref"]) || "system"; leftDrag = localStorage.getItem("openarc-canvas-leftdrag") === "pan" ? "pan" : "select"; } catch { /* 无存储时用默认 */ }
    this.state = {
      canvasId, name, doc: { nodes: [], edges: [], comments: [] }, version: null, saving: "idle", loaded: false,
      view: { x: 0, y: 0, k: 1 },
      ui: { sel: new Set(), edge: null, drawer: null, filesOpen: false, agentOpen: typeof innerWidth === "number" ? innerWidth > 760 : true, agentFull: false, mini: null, hideEdges: false, snap: false, guides: true, cmtMode: false, pick: null, replace: null, agentPick: false, conn: null, editText: null, editCell: null, hlEdge: null, hlNode: null, preview: false, batchMode: "stack", dragging: false, theme: "dark", themePref: pref, leftDrag },
      runtime: {}, batches: {}, runs: [], models: [], toasts: [], undo: [], redo: [],
      collab: { clientId: null, transport: null, peers: [] },
    };
    try { const r = localStorage.getItem("canvas-next:runs:" + canvasId); if (r) this.state.runs = JSON.parse(r); } catch { /* 忽略 */ }
  }

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getState = () => this.state;
  private emit() { for (const l of [...this.listeners]) l(); }
  /** 保存冲突时的合并函数（协作层设置）：返回要重存的文档 */
  rebase: ((ours: CanvasDoc, remote: CanvasDoc) => CanvasDoc) | null = null;
  setCollab(patch: Partial<CanvasState["collab"]>) { if (this.disposed) return; this.state = { ...this.state, collab: { ...this.state.collab, ...patch } }; this.emit(); }
  /** 远端改动：不进撤销栈，也不由本端保存（发起方负责落盘） */
  applyRemote(fn: (doc: CanvasDoc) => CanvasDoc) { if (this.disposed) return; const prev = this.state.doc; const next = fn(prev); if (next === prev) return; this.state = { ...this.state, doc: next }; this.cleanSel(); this.stopOrphanRuns(); this.emit(); }
  set(patch: Partial<CanvasState>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.emit(); }
  setUI(patch: Partial<UIState>) { if (this.disposed) return; this.state = { ...this.state, ui: { ...this.state.ui, ...patch } }; this.emit(); }
  setView(v: View) { if (this.disposed) return; this.state = { ...this.state, view: v }; this.emit(); }

  /* ---------- 加载 / 保存 ---------- */
  async load() {
    const [loaded, models] = await Promise.all([this.backend.loadDoc(this.state.canvasId), this.backend.listModels().catch(() => [] as ModelSpec[])]);
    if (this.disposed) return;
    this.set({ doc: loaded.doc, version: loaded.version, loaded: true, models });
    this.watchModelDirectory();
    if (loaded.error) this.toast(`画布已从本机副本打开（${loaded.error}）`);
    if (loaded.migrated) this.toast("这张画布来自旧版本，已按新格式打开；原始内容保留了备份");
  }
  /** 设置页增删 / 启停模型后，后端作废缓存并通知；这里只重拉下拉用的 models，文档与撤销栈不动。 */
  private watchModelDirectory() {
    if (this.modelOff || typeof this.backend.onModelsChanged !== "function") return;
    this.modelOff = this.backend.onModelsChanged(() => { void this.reloadModels(); });
  }
  async reloadModels() {
    const models = await this.backend.listModels().catch(() => this.state.models);
    this.set({ models });
  }
  async refreshAuthoritative(): Promise<"refreshed" | "skipped" | "failed"> {
    if (!this.backend.readAuthoritativeDoc) return "failed";
    if (this.saveTimer || this.state.saving === "saving" || this.state.saving === "conflict" || this.state.saving === "error") {
      this.toast("本端还有未保存编辑：已保留你的内容，请先处理保存冲突"); return "skipped";
    }
    const before = this.state.doc;
    try {
      const loaded = await this.backend.readAuthoritativeDoc(this.state.canvasId);
      if (this.state.doc !== before || this.saveTimer) { this.toast("你在任务期间的新编辑已保留；请保存后再刷新画布"); return "skipped"; }
      this.set({ doc: loaded.doc, version: loaded.version, saving: "saved" });
      return "refreshed";
    } catch (error) {
      this.toast("权威画布刷新失败：" + (error instanceof Error ? error.message : "未知错误")); return "failed";
    }
  }
  private scheduleSave() {
    if (this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.saveNow(); }, 800);
  }
  async saveNow(force = false) {
    if (this.saveFlight) { this.saveAgain = true; return this.saveFlight; }
    if (this.disposed && !force) return;
    this.saveAgain = false;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.set({ saving: "saving" });
    const flight = (async () => {
      const r = await this.backend.saveDoc(this.state.canvasId, this.state.doc, this.state.version);
      if (r.ok) this.set({ saving: "saved", version: r.version });
      else if (this.disposed) return;
      else if (r.conflict && this.rebase && r.remote && r.remoteVersion) {
        // 协作中：以当前文档为准合并远端新增后，按远端版本号重存一次
        const merged = this.rebase(this.state.doc, r.remote); if (merged !== this.state.doc) this.applyRemote(() => merged);
        const again = await this.backend.saveDoc(this.state.canvasId, this.state.doc, r.remoteVersion);
        if (again.ok) this.set({ saving: "saved", version: again.version }); else { this.set({ saving: "conflict" }); this.toast("和协作者的改动冲突：已停止自动保存，刷新后会载入最新版本"); }
      }
      else if (r.conflict) { this.set({ saving: "conflict" }); this.toast("画布在别处被修改过：已停止自动保存，刷新后会载入最新版本"); }
      else this.set({ saving: "error" });
    })();
    this.saveFlight = flight;
    try { await flight; } finally { if (this.saveFlight === flight) this.saveFlight = null; }
    // 保存途中的编辑：上一次请求带的是旧文档，结束后补存一次（冲突 / 失败时不自动重试，交给原有提示）
    if (this.saveAgain && !this.saveTimer && this.state.saving === "saved" && (!this.disposed || force)) await this.saveNow(force);
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.modelOff?.(); this.modelOff = null;
    for (const timer of this.toastTimers) clearTimeout(timer);
    this.toastTimers.clear();
    this.listeners.clear();
    this.disposeFlight = (async () => {
      if (this.saveFlight) await this.saveFlight;
      if (this.saveTimer || this.saveAgain) await this.saveNow(true);
    })();
    return this.disposeFlight;
  }

  /* ---------- 文档改动 ---------- */
  /** 改文档。history:true 时先存一份撤销快照（拖动等连续操作只在开始时存一次） */
  mutate(fn: (doc: CanvasDoc) => CanvasDoc, opts: { history?: boolean } = {}) {
    if (this.disposed) return;
    const prev = this.state.doc; const next = fn(prev); if (next === prev) return;
    const undo = opts.history ? [...this.state.undo.slice(-59), prev] : this.state.undo;
    this.state = { ...this.state, doc: next, undo, redo: opts.history ? [] : this.state.redo }; this.emit(); this.scheduleSave();
  }
  snapshot() { this.state = { ...this.state, undo: [...this.state.undo.slice(-59), this.state.doc], redo: [] }; }
  undo() { const u = this.state.undo; if (!u.length) return this.toast("没有可撤销的操作"); this.state = { ...this.state, doc: u[u.length - 1], undo: u.slice(0, -1), redo: [...this.state.redo, this.state.doc] }; this.cleanSel(); this.stopOrphanRuns(); this.emit(); this.scheduleSave(); }
  redo() { const r = this.state.redo; if (!r.length) return this.toast("没有可重做的操作"); this.state = { ...this.state, doc: r[r.length - 1], redo: r.slice(0, -1), undo: [...this.state.undo, this.state.doc] }; this.cleanSel(); this.stopOrphanRuns(); this.emit(); this.scheduleSave(); }
  /** 撤销 / 重做 / 远端改动让正在生成的节点消失时，停掉它的生成（否则继续计费，结果也无处可写） */
  private stopOrphanRuns() { const ids = new Set(this.state.doc.nodes.map((n) => n.id)); for (const [id, r] of Object.entries(this.state.runtime)) if (!ids.has(id)) r.abort.abort(); }
  private cleanSel() { const ids = new Set(this.state.doc.nodes.map((n) => n.id)); const sel = new Set([...this.state.ui.sel].filter((x) => ids.has(x))); this.state = { ...this.state, ui: { ...this.state.ui, sel } }; }

  node = (id: string | null | undefined) => (id ? this.state.doc.nodes.find((n) => n.id === id) : undefined);
  updateNode(id: string, fn: (n: CanvasNode) => CanvasNode, opts: { history?: boolean } = {}) {
    this.mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? fn(n) : n)) }), opts);
  }
  patchGen(id: string, patch: Partial<GenData> | ((g: GenData) => Partial<GenData>), opts: { history?: boolean } = {}) {
    this.updateNode(id, (n) => withGen(n, typeof patch === "function" ? patch(genOf(n)) : patch), opts);
  }
  addNodes(nodes: CanvasNode[], edges: CanvasEdge[] = [], opts: { select?: boolean; history?: boolean } = {}) {
    this.mutate((d) => {
      let ns = [...d.nodes, ...nodes];
      // 新边追加到目标节点的输入顺序末尾
      for (const e of edges) ns = ns.map((n) => (n.id === e.to && isGenKind(n.kind) ? withGen(n, { order: [...genOf(n).order.filter((x) => d.edges.some((de) => de.id === x) || edges.some((ne) => ne.id === x)), e.id] }) : n));
      return { ...d, nodes: ns, edges: [...d.edges, ...edges] };
    }, { history: opts.history ?? true });
    if (opts.select) this.setUI({ sel: new Set(nodes.map((n) => n.id)), edge: null });
  }
  newNode(kind: GenKind, x: number, y: number, extra: Parameters<typeof newNode>[3] = {}) { return newNode(kind, x, y, extra, this.defaultModel(kind)); }
  removeNodes(ids: string[]) {
    const set = new Set(ids); ids.forEach((id) => this.state.runtime[id]?.abort.abort());
    this.mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => !set.has(n.id)), edges: d.edges.filter((e) => !set.has(e.from) && !set.has(e.to)) }), { history: true });
    this.setUI({ sel: new Set([...this.state.ui.sel].filter((x) => !set.has(x))) });
  }
  removeEdge(id: string) {
    const e = this.state.doc.edges.find((x) => x.id === id); if (!e) return;
    this.mutate((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== id), nodes: d.nodes.map((n) => (n.id === e.to && isGenKind(n.kind) ? withGen(n, { order: genOf(n).order.filter((x) => x !== id) }) : n)) }), { history: true });
  }
  addEdge(from: string, to: string): CanvasEdge {
    const edge: CanvasEdge = { id: uid("e"), from, to };
    this.addNodes([], [edge]);
    return edge;
  }
  /** 重新排列某节点的输入顺序 */
  reorderInputs(id: string, edgeIds: string[]) { this.patchGen(id, { order: edgeIds }, { history: true }); }

  /* ---------- 模型 ---------- */
  modelsOf(kind: GenKind) { return this.state.models.filter((m) => m.kind === kind); }
  defaultModel(kind: GenKind): ModelSpec | undefined {
    let stored = ""; try { stored = localStorage.getItem("openarc:canvas:model:" + this.state.canvasId + ":" + kind) || ""; } catch { /* 忽略 */ }
    const list = this.modelsOf(kind); return list.find((m) => m.id === stored) || list[0];
  }
  rememberModel(kind: GenKind, id: string) { try { localStorage.setItem("openarc:canvas:model:" + this.state.canvasId + ":" + kind, id); } catch { /* 忽略 */ } }
  modelOf(node: CanvasNode): ModelSpec | undefined {
    if (!isGenKind(node.kind)) return undefined;
    const p = genOf(node).params as { model?: string };
    return this.modelsOf(node.kind).find((m) => m.id === p.model) || this.defaultModel(node.kind);
  }

  /* ---------- 运行态 ---------- */
  setRun(id: string, r: RunState | null) { const rt = { ...this.state.runtime }; if (r) rt[id] = r; else delete rt[id]; this.set({ runtime: rt }); }
  setBatch(key: string, b: BatchRunState | null) { const m = { ...this.state.batches }; if (b) m[key] = b; else delete m[key]; this.set({ batches: m }); }
  patchBatch(key: string, patch: Partial<BatchRunState>) { const cur = this.state.batches[key]; if (!cur) return; this.set({ batches: { ...this.state.batches, [key]: { ...cur, ...patch } } }); }
  patchRun(id: string, patch: Partial<RunState>) { const cur = this.state.runtime[id]; if (this.disposed || !cur) return; this.state = { ...this.state, runtime: { ...this.state.runtime, [id]: { ...cur, ...patch } } }; this.emit(); }
  logRun(r: Omit<RunLog, "id" | "time">) {
    const d = new Date(); const time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const runs = [{ ...r, id: uid("r"), time, at: d.getTime(), canvasId: this.state.canvasId, canvasName: this.state.name }, ...this.state.runs].slice(0, 200); this.set({ runs });
    try { localStorage.setItem("canvas-next:runs:" + this.state.canvasId, JSON.stringify(runs.map(compactRun))); } catch { /* 忽略 */ }
  }

  /* ---------- 提示 ---------- */
  toast(html: string, ms = 2600) {
    if (this.disposed) return;
    const id = ++this.toastSeq; this.set({ toasts: [...this.state.toasts, { id, html }] });
    const first = setTimeout(() => {
      this.toastTimers.delete(first);
      if (this.disposed) return;
      this.set({ toasts: this.state.toasts.map((t) => (t.id === id ? { ...t, out: true } : t)) });
      const second = setTimeout(() => { this.toastTimers.delete(second); this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }); }, 170);
      this.toastTimers.add(second);
    }, ms);
    this.toastTimers.add(first);
  }
}

export function useStore<T>(store: CanvasStore, sel: (s: CanvasState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.getState()));
}
