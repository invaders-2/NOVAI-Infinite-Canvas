/**
 * 画布状态。单一 store + useSyncExternalStore：
 *   doc      —— 持久化文档（CanvasDoc），所有改动经 mutate()，可撤销，防抖保存到后端；
 *   view     —— 视口；
 *   ui       —— 选择、弹层、抽屉等纯界面状态；
 *   runtime  —— 生成中的节点（进度、流式文本、AbortController），不进文档；
 *   models   —— 后端模型清单（ModelSpec）。
 */
import { readMigratedKey, removeMigratedKey } from "../../novaiStorage";
import { useSyncExternalStore } from "react";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import type { CanvasBackend } from "./backend/types";
import { resolveModelForParams } from "./agent/modelResolve";
import { genOf, isGenKind, newNode, outOf, pinMissingModelIds, uid, withGen, type AnyParams, type GenData, type GenKind, type ModelSpec } from "./model";
import { resumeCanvasTasks } from "./engine";
import { fitMediaBox } from "./mediaFit";
import { declaredRatio, wantedRatio } from "./originalRatio";

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
export type Toast = { id: number; html: string; out?: boolean; /** 可点动作（例如点开面板）；只存在内存里 */ action?: () => void };
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
  /** 左键拖动空白：select = 框选（TapNow 默认，中键 / 空格拖动平移）；pan = 平移（旧习惯，Shift 拖动框选） */
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

/** 默认模型按画布存，一台机器上不同画布的偏好互不影响 */
const DEFAULT_MODEL_KEY = (canvasId: string, kind: GenKind) => "novai:canvas:model:" + canvasId + ":" + kind;
/** 「优化提示词」的模型是全画布共用的一套文本模型，不跟 canvasId 走 */
const OPTIMIZE_MODEL_KEY = "novai:canvas:optimize-model";

/**
 * 空状态节点（还没有结果）的宽高跟着面板里选的比例走，改比例就立刻摆正，不用等生成。
 * 「原图比例」按源图算（面板写下的 params.sourceSize，或上游 / 自己的源图真实像素），拿不到尺寸就不动，不猜 1:1。
 * 只认比例的**取值**有没有变：清晰度、张数、风格这类参数改动不能把用户手动拖过的尺寸弹回去；
 * 源图比例第一次变得可用（备忘从空到有）会摆正一次，之后同比例不再动。有结果的节点保持真实结果比例。
 * 比例取值只从节点参数里读（declaredRatio），不读源图回退——源图是「现在能拿到什么」，不是「上次摆成什么样」。
 * x / y 不参与，节点位置不受影响。
 */
function fitEmptyRatio(prev: CanvasNode, next: CanvasNode, doc: CanvasDoc): CanvasNode {
  if (prev === next || (next.kind !== "image" && next.kind !== "video") || outOf(next)) return next;
  const kind = next.kind as GenKind;
  const want = wantedRatio(doc, next, kind);
  if (!want) return next;
  const have = declaredRatio(genOf(prev).params);
  if (have != null && Math.abs(have - want) <= Math.max(have, want) * .001) return next;
  const box = fitMediaBox(next.w, want, 1);
  return box ? { ...next, w: box.w, h: box.h } : next;
}

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
    pref = (readMigratedKey("novai-canvas-theme") as UIState["themePref"]) || "system"; leftDrag = readMigratedKey("novai-canvas-leftdrag") === "pan" ? "pan" : "select";
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
    // 旧画布：模型列表到了之后，把缺 model / model 失效的节点一次性写死（不提示、不进撤销）
    this.migrateMissingModelIds();
    if (loaded.error) this.toast(`画布已从本机副本打开（${loaded.error}）`);
    if (loaded.migrated) this.toast("这张画布来自旧版本，已按新格式打开；原始内容保留了备份");
    // 离开画布时后端任务可能还在跑：载入后按节点上记着的 taskId 接上（后台跑，不挡首屏）
    void resumeCanvasTasks(this).catch(() => undefined);
  }
  /** 设置页增删 / 启停模型后，后端作废缓存并通知；这里只重拉下拉用的 models，文档与撤销栈不动。 */
  private watchModelDirectory() {
    if (this.modelOff || typeof this.backend.onModelsChanged !== "function") return;
    this.modelOff = this.backend.onModelsChanged(() => { void this.reloadModels(); });
  }
  async reloadModels() {
    const models = await this.backend.listModels().catch(() => this.state.models);
    this.set({ models });
    // 打开时模型列表还是空的，等它异步回来后再补跑一次迁移（幂等，已写死的不动）
    this.migrateMissingModelIds();
  }

  /**
   * 旧画布一次性迁移：给 params.model 为空 / 不在当前模型列表里的生成类节点写死默认模型 id。
   *   · 只在节点自己身上写；不产生撤销历史、不弹提示、其它节点对象原样保留；
   *   · 该 kind 没有可用模型时不动；
   *   · 已经写死且有效 → 直接跳过，所以重复载入 / 重复调用都是幂等的；
   *   · 有改动时走自动保存落盘，重载后仍是这个模型。
   */
  migrateMissingModelIds(): boolean {
    if (this.disposed || !this.state.loaded || !this.state.models.length) return false;
    const { doc, changed } = pinMissingModelIds(this.state.doc, (kind, current) => {
      const list = this.modelsOf(kind);
      if (!list.length) return null;
      if (current && list.some((m) => m.id === current)) return null;
      return this.defaultModel(kind)?.id || null;
    });
    if (!changed) return false;
    this.set({ doc });
    this.scheduleSave();
    return true;
  }
  async refreshAuthoritative(opts: { force?: boolean } = {}): Promise<"refreshed" | "skipped" | "failed"> {
    if (!this.backend.readAuthoritativeDoc) return "failed";
    if (opts.force) {
      // 已经和服务端冲突（自动保存停了）：放弃本端未保存的少量改动，直接载入服务端最新版本
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      try {
        const loaded = await this.backend.readAuthoritativeDoc(this.state.canvasId);
        this.set({ doc: loaded.doc, version: loaded.version, saving: "saved" });
        this.migrateMissingModelIds();
        return "refreshed";
      } catch (error) {
        this.toast("权威画布刷新失败：" + (error instanceof Error ? error.message : "未知错误")); return "failed";
      }
    }
    if (this.saveTimer || this.state.saving === "saving" || this.state.saving === "conflict" || this.state.saving === "error") {
      this.toast("本端还有未保存编辑：已保留你的内容，请先处理保存冲突"); return "skipped";
    }
    const before = this.state.doc;
    try {
      const loaded = await this.backend.readAuthoritativeDoc(this.state.canvasId);
      if (this.state.doc !== before || this.saveTimer) { this.toast("你在任务期间的新编辑已保留；请保存后再刷新画布"); return "skipped"; }
      this.set({ doc: loaded.doc, version: loaded.version, saving: "saved" });
      this.migrateMissingModelIds();
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
  private stopOrphanRuns() { const ids = new Set(this.state.doc.nodes.map((n) => n.id)); for (const id of Object.keys(this.state.runtime)) if (!ids.has(id)) this.stopRun(id); }
  /**
   * 停掉一个正在跑的生成：用户点停止 / 删节点 / 撤销都走这里，后端任务一起取消。
   * 页面卸载 / 切画布不走这里——任务留着，回到画布由 resumeCanvasTasks 接上。
   */
  stopRun(id: string) {
    const r = this.state.runtime[id]; if (!r) return;
    r.abort.abort();
    if (r.runId && this.backend.cancelTask) void this.backend.cancelTask(r.runId).catch(() => undefined);
  }
  private cleanSel() { const ids = new Set(this.state.doc.nodes.map((n) => n.id)); const sel = new Set([...this.state.ui.sel].filter((x) => ids.has(x))); this.state = { ...this.state, ui: { ...this.state.ui, sel } }; }

  node = (id: string | null | undefined) => (id ? this.state.doc.nodes.find((n) => n.id === id) : undefined);
  updateNode(id: string, fn: (n: CanvasNode) => CanvasNode, opts: { history?: boolean } = {}) {
    this.mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? fitEmptyRatio(n, fn(n), d) : n)) }), opts);
  }
  patchGen(id: string, patch: Partial<GenData> | ((g: GenData) => Partial<GenData>), opts: { history?: boolean } = {}) {
    this.updateNode(id, (n) => withGen(n, typeof patch === "function" ? patch(genOf(n)) : patch), opts);
  }
  /** 新加入画布的节点：参数深拷贝 + 模型写死（缺模型时用当前类型的默认模型，只影响这一次创建） */
  private isolatedNode(n: CanvasNode): CanvasNode {
    if (!isGenKind(n.kind)) return n;
    const hasGen = !!(n.data && typeof n.data === "object" && (n.data as { gen?: unknown }).gen);
    if (!hasGen) return n;
    const params = genOf(n).params as { model?: string };
    const id = String(params.model || "");
    const valid = !!id && this.modelsOf(n.kind).some((m) => m.id === id);
    const model = valid ? id : this.defaultModel(n.kind)?.id || "";
    return withGen(n, { params: { ...params, ...(model && model !== id ? { model } : {}) } as AnyParams });
  }
  addNodes(nodes: CanvasNode[], edges: CanvasEdge[] = [], opts: { select?: boolean; history?: boolean } = {}) {
    const isolated = nodes.map((n) => this.isolatedNode(n));
    this.mutate((d) => {
      let ns = [...d.nodes, ...isolated];
      // 新边追加到目标节点的输入顺序末尾
      for (const e of edges) ns = ns.map((n) => (n.id === e.to && isGenKind(n.kind) ? withGen(n, { order: [...genOf(n).order.filter((x) => d.edges.some((de) => de.id === x) || edges.some((ne) => ne.id === x)), e.id] }) : n));
      return { ...d, nodes: ns, edges: [...d.edges, ...edges] };
    }, { history: opts.history ?? true });
    if (opts.select) this.setUI({ sel: new Set(isolated.map((n) => n.id)), edge: null });
  }
  newNode(kind: GenKind, x: number, y: number, extra: Parameters<typeof newNode>[3] = {}) { return newNode(kind, x, y, extra, this.defaultModel(kind)); }
  removeNodes(ids: string[]) {
    const set = new Set(ids); ids.forEach((id) => this.stopRun(id));
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
  /** 显式存过的默认模型 id：没存过返回 ""，失效 id 也原样返回（设置页据此显示当前选择） */
  defaultModelId(kind: GenKind): string {
    return readMigratedKey(DEFAULT_MODEL_KEY(this.state.canvasId, kind)) || "";
  }
  defaultModel(kind: GenKind): ModelSpec | undefined {
    const stored = this.defaultModelId(kind);
    const list = this.modelsOf(kind); return list.find((m) => m.id === stored) || list[0];
  }
  /** id 为空 = 回到「自动」：必须 removeItem，否则空串会盖住回落逻辑 */
  rememberModel(kind: GenKind, id: string) {
    const key = DEFAULT_MODEL_KEY(this.state.canvasId, kind);
    try { if (id) localStorage.setItem(key, id); else removeMigratedKey(key); } catch { /* 忽略 */ }
  }
  /**
   * 「优化提示词」用的文本模型：只有显式设置过、且这个 id 还在当前文本模型列表里才返回。
   * 失效 id 不在这里删：模型可能只是暂时没加载，删掉会让用户的显式选择无声丢失，交给设置页重选。
   */
  optimizeModel(): ModelSpec | undefined {
    const id = readMigratedKey(OPTIMIZE_MODEL_KEY) || "";
    return id ? this.modelsOf("text").find((m) => m.id === id) : undefined;
  }
  rememberOptimizeModel(id: string) {
    try { if (id) localStorage.setItem(OPTIMIZE_MODEL_KEY, id); else removeMigratedKey(OPTIMIZE_MODEL_KEY); } catch { /* 忽略 */ }
  }
  /**
   * 节点自己的模型：只认 params.model 里写死的 id，不再回落到「按类型记住的默认模型」。
   * 否则改一个节点的模型会让所有没写 model 的同类节点一起变；新建 / 导入时已经写死具体 id。
   */
  modelOf(node: CanvasNode): ModelSpec | undefined {
    if (!isGenKind(node.kind)) return undefined;
    // 兼容短 id：params.model 可能是 agnes-image-2.0-flash，而 models[].id 是 provider::model；
    // 助手队列 / 旧数据都会写短 id，统一交给 resolveModelForParams 解析（完整 id 优先，避免误配）。
    return resolveModelForParams(this.modelsOf(node.kind), node.kind, genOf(node).params as { model?: unknown; provider?: unknown });
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
  toast(html: string, ms = 2600, action?: () => void) {
    if (this.disposed) return;
    const id = ++this.toastSeq; this.set({ toasts: [...this.state.toasts, { id, html, action }] });
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
