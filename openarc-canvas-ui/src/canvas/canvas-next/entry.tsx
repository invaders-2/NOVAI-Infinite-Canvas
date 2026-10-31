/**
 * 桌面版接入点：和旧的 ReactCanvasApp 同样的 props，换入口时只改 import。
 *
 *   import { NextCanvasApp as ReactCanvasApp } from "../canvas-next/entry";
 *
 * 画布 id 来自窗口（win.canvasId / win.meta.canvasId）或 ?canvas=；都没有时显示画布列表。
 * 宿主能力优先用 props，其次用旧版约定的 window.__openarc* 钩子。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeCanvasId } from "../react-canvas/reactCanvasStore";
import { saveDoc, serverDocToDoc } from "../react-canvas/persistence";
import { renderCanvasThumb } from "../react-canvas/exportCanvas";
import { createBridgeBackend } from "./backend/bridge";
import { CanvasApp } from "./CanvasApp";
import { genOf, newNode } from "./model";
import type { HostActions } from "./ui/ctx";
import { shellDark } from "./ui/theme";
import { Icon, Logo } from "./ui/Icon";
import "./ui/canvas-next.css";
import "./ui/list.css";

/** 开发模式下把画布状态挂到 window.__cn，便于端到端测试读取；打包版不挂 */
const exposeForDev = typeof location !== "undefined" && /^http:\/\/(127\.0\.0\.1|localhost):/.test(location.origin) ? (s: unknown) => { (window as unknown as { __cn: unknown }).__cn = s; } : undefined;

type Win = { canvasId?: unknown; meta?: Record<string, unknown> } | undefined;
type Props = {
  win?: unknown;
  /** 当前登录用户的显示名（Agent 问候、头像首字、评论署名） */
  userName?: string;
  /** 入口页打开其它应用窗口（应用市场 / Skill 中心）：由外壳注入，宿主没有就不显示这两个入口 */
  onOpenApp?: (appId: string) => void;
  onOpenMcpCenter?: () => void; onOpenModelSettings?: () => void; onOpenSettings?: () => void; onBackToWorkspace?: () => void;
  /** 外壳要求打开指定画布（市场「立即体验」）：值变化时用现有加载路径切过去，然后回调 onCanvasOpened 清掉 */
  openCanvasId?: string;
  agentDraft?: { seq: number; text: string; skill: string } | null;
  onCanvasOpened?: (canvasId?: string) => void;
};
type Entry = { id: string; name: string; updatedAt?: number; nodes?: number; /** 卡片底部那行描述（取最近一次生成的标题，或「继续编辑」） */ desc?: string };

const hook = <T,>(name: string): T | undefined => { const f = (window as unknown as Record<string, unknown>)[name]; return typeof f === "function" ? (f as T) : undefined; };
const cmd = () => { const c = (window as unknown as { openarc?: { canvas?: { command?: (r: Record<string, unknown>) => Promise<Record<string, any>> } } }).openarc?.canvas?.command; return typeof c === "function" ? c : null; };

async function listCanvases(): Promise<Entry[]> {
  const c = cmd(); if (!c) return [];
  const res = await c({ type: "canvas/list" }).catch(() => null);
  const raw = res && res.ok ? (Array.isArray(res.items) ? res.items : Array.isArray(res.canvases) ? res.canvases : []) : [];
  return raw.map((r: Record<string, unknown>) => ({ id: normalizeCanvasId(String(r.canvasId ?? r.id ?? "")), name: String(r.title ?? r.name ?? "未命名画布"), updatedAt: Number(r.updatedAt || 0) })).filter((e: Entry) => e.id !== "default");
}

function fromWin(win: unknown): Entry | null {
  const w = win as Win; const id = w?.canvasId ?? w?.meta?.canvasId;
  if (typeof id === "string" && id.trim()) return { id: normalizeCanvasId(id), name: typeof w?.meta?.title === "string" && w.meta.title ? w.meta.title : "画布" };
  const q = new URLSearchParams(location.search).get("canvas");
  return q ? { id: normalizeCanvasId(q), name: "画布" } : null;
}

export function NextCanvasApp(props: Props) {
  // 只按「画布 id + 标题」判断窗口指定的画布有没有变：外壳每次重绘都会给新的 win 对象，
  // 不能因此把当前画布重置（在窗口里从列表打开的画布 win 不带 id，旧写法会被打回列表）。
  const fx = fromWin(props.win); const fixedKey = fx ? fx.id + "\u0000" + fx.name : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fixed = useMemo(() => fx, [fixedKey]);
  const [active, setActive] = useState<Entry | null>(fixed);
  useEffect(() => { if (fixed) setActive(fixed); }, [fixed]);
  const backend = useMemo(() => createBridgeBackend(), []);
  useEffect(() => () => { backend.dispose?.(); }, [backend]);
  // 外壳传进来的回调每次渲染都是新函数：经 ref 取最新的，host 本身保持稳定（host 变了画布会整个重建、丢掉进行中的生成）
  const latest = useRef(props); latest.current = props;
  const host: HostActions = useMemo(() => {
    const ms = latest.current.onOpenModelSettings || hook<() => void>("__openarcOpenModelSettings");
    const mcp = latest.current.onOpenMcpCenter || hook<() => void>("__openarcOpenMcpCenter");
    return {
      // 返回 = 回到画布列表（和旧版一样在同一个窗口里切画布）；关窗口交给窗口自己的红绿灯
      backToList: () => setActive(null),
      ...(ms ? { openModelSettings: () => (latest.current.onOpenModelSettings || hook<() => void>("__openarcOpenModelSettings"))?.() } : {}),
      ...(mcp ? { openMcpCenter: () => (latest.current.onOpenMcpCenter || hook<() => void>("__openarcOpenMcpCenter"))?.() } : {}),
      openShare: hook("__openarcOpenShare"),
      ...(latest.current.onOpenApp ? { openApp: (id: string) => latest.current.onOpenApp?.(id) } : {}),
      openCanvas: (id: string) => setActive({ id, name: "画布" }),
      listCanvases: async () => (await listCanvases()).map((e) => ({ id: e.id, name: e.name })),
      ...(props.userName ? { user: { name: props.userName, initial: Array.from(props.userName)[0].toUpperCase() } } : {}),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userName]);
  // 市场等外部入口的「打开这张画布」：只切画布，不新建；打开后回调外壳清掉 target。
  // 用 ref 记已处理过的 id，避免 onCanvasOpened 触发重渲染时反复打开同一张。
  const handledTarget = useRef("");
  const openCanvasId = typeof props.openCanvasId === "string" ? props.openCanvasId.trim() : "";
  useEffect(() => {
    if (!openCanvasId || handledTarget.current === openCanvasId) return;
    handledTarget.current = openCanvasId;
    let alive = true;
    void (async () => {
      const id = normalizeCanvasId(openCanvasId);
      const list = await listCanvases().catch(() => [] as Entry[]);
      if (!alive) return;
      const found = list.find((e) => e.id === id);
      setActive({ id, name: found?.name || "画布" });
      latest.current.onCanvasOpened?.(id);
    })();
    return () => { alive = false; };
  }, [openCanvasId]);
  if (!active) return <CanvasList onOpen={setActive} onOpenApp={props.onOpenApp} userName={props.userName} resolveAsset={backend.resolveAsset} winInset={props.win ? 84 : undefined} />;
  return <CanvasApp key={active.id} backend={backend} canvasId={active.id} name={active.name} host={host} agentDraft={props.agentDraft} winInset={props.win ? 84 : undefined} onReady={exposeForDev} />;
}

/** 跟外壳的深浅色：外壳切外观只改 .desktop 的 class，不会重传 props，所以列表页自己订阅 */
function useShellDark() {
  const [dark, setDark] = useState(shellDark);
  useEffect(() => {
    const sync = () => setDark(shellDark());
    const shell = document.querySelector(".desktop");
    const mo = shell ? new MutationObserver(sync) : null;
    if (shell) mo?.observe(shell, { attributes: true, attributeFilter: ["class"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", sync);
    return () => { mo?.disconnect(); mq.removeEventListener?.("change", sync); };
  }, []);
  return dark;
}

/* ------------------------- 入口页：TapNow 首页形态 ------------------------- */

/** 首页快捷起点：点一下只把提示词填进输入框（不直接生成，用户还能改） */
const STARTERS = [
  { icon: "video", label: "文字生视频", prompt: "把下面这段描述做成 5 秒短视频，比例 16:9：" },
  { icon: "image", label: "图片换背景", prompt: "把这张图的背景换成干净的影棚浅灰，主体造型保持不动：" },
  { icon: "frame", label: "首帧生成视频", prompt: "以这张图为首帧，生成 5 秒、镜头缓慢推近的视频：" },
  { icon: "grid", label: "表格批量出图", prompt: "按表格逐行批量出图，每行一张，风格统一，比例 1:1：" },
  { icon: "layout", label: "模板", prompt: "用模板起一张画布：产品图 + 卖点拆解 → 3 张卖点海报，比例 3:4" },
] as const;

const KIND_LABEL: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "音频", table: "表格", note: "便签", group: "分组", timeline: "时间线", model3d: "3D 模型", scene3d: "3D 片场" };

/** 描述太长时按字数截断做画布名（不切在半个字上：Array.from 按码点切） */
function titleOf(text: string) {
  const chars = Array.from(text);
  return chars.length > 24 ? chars.slice(0, 24).join("") + "…" : text;
}

/** 卡片右上角：编辑于 X 天前 */
function editedAt(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 3600000) return "编辑于刚刚";
  if (diff < 86400000) return "编辑于 " + Math.floor(diff / 3600000) + " 小时前";
  const days = Math.floor(diff / 86400000);
  return "编辑于 " + (days <= 1 ? "1 天前" : days + " 天前");
}

/** 卡片底部那行：取该画布最近一次生成的标题；没有就用节点类型给一句人话 */
function describeDoc(doc: { nodes?: Array<{ kind?: string; data?: unknown }> } | null): string {
  const nodes = (doc && doc.nodes) || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const gen = (n.data && typeof n.data === "object" ? (n.data as { gen?: { title?: unknown } }).gen : null) || null;
    const title = gen && typeof gen.title === "string" ? gen.title : "";
    const kind = String(n.kind || "");
    if (title && title !== KIND_LABEL[kind] && title !== "未命名") return title;
  }
  const last = nodes[nodes.length - 1];
  if (!last) return "继续编辑";
  return "继续编辑 · " + (KIND_LABEL[String(last.kind || "")] || "画布");
}

/** 缩略图 / 描述缓存：同一张画布同一版本只渲染一次（列表页别每次重画） */
const CARD_CACHE = new Map<string, { thumb?: string; desc?: string }>();

async function cardDetail(item: Entry, resolve?: (u: string) => Promise<string | null>): Promise<{ thumb?: string; desc?: string }> {
  const key = item.id + "@" + (item.updatedAt || 0);
  const hit = CARD_CACHE.get(key); if (hit) return hit;
  const c = cmd(); if (!c) return {};
  try {
    const res = await c({ type: "canvas/get", canvasId: item.id });
    const raw = res && res.ok && res.canvas ? res.canvas.doc : null;
    const parsed = raw ? serverDocToDoc(raw) : null;
    const doc = parsed && parsed.doc ? parsed.doc : null;
    if (!doc || !doc.nodes.length) { const out = { desc: "空画布 · 进去写第一句" }; CARD_CACHE.set(key, out); return out; }
    const desc = describeDoc(doc as never);
    const thumb = await renderCanvasThumb({ doc, width: 480, height: 300, resolve, maxImages: 6 });
    const out = { thumb, desc }; CARD_CACHE.set(key, out); return out;
  } catch { return {}; }
}

/** 项目卡：缩略图 + 标题/时间 + 底部一行描述（首页和「我的项目」共用） */
function ProjectCard({ item, detail, onOpen, compact }: { item: Entry; detail?: { thumb?: string; desc?: string }; onOpen: () => void; compact?: boolean }) {
  return <button className={"lp2-card" + (compact ? " sm" : "")} data-canvas={item.id} onClick={onOpen} title={item.name}>
    <span className="lp2-thumb">{detail && detail.thumb ? <img src={detail.thumb} alt="" draggable={false} /> : <span className="lp2-thumb-ph"><Icon name="layers" /></span>}</span>
    <span className="lp2-card-top"><b>{item.name}</b><em>{editedAt(item.updatedAt)}</em></span>
    <span className="lp2-card-desc">{detail && detail.desc ? detail.desc : "继续编辑"}<Icon name="right" size="xs" /></span>
  </button>;
}

/** 没指定画布时的入口页：主页（大标题 + 输入卡 + 快捷 chips + 项目行）/ 我的项目（网格） */
function CanvasList({ onOpen, onOpenApp, resolveAsset, userName, winInset }: {
  onOpen: (e: Entry) => void;
  onOpenApp?: (appId: string) => void;
  resolveAsset?: (url: string) => Promise<string | null>;
  userName?: string;
  winInset?: number;
}) {
  const [list, setList] = useState<Entry[] | null>(null);
  const [details, setDetails] = useState<Record<string, { thumb?: string; desc?: string }>>({});
  const [view, setView] = useState<"home" | "all">("home");
  const [desc, setDesc] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const dark = useShellDark();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { void listCanvases().then(setList).catch(() => setList([])); }, []);
  const recent = useMemo(() => (list || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)), [list]);
  // 只给真要显示的那几张卡取文档画缩略图：首页 3 张、我的项目最多 12 张
  const need = view === "home" ? recent.slice(0, 3) : recent.slice(0, 12);
  const needKey = need.map((x) => x.id + x.updatedAt).join(",");
  useEffect(() => {
    if (!need.length) return;
    let dead = false;
    void (async () => {
      for (const item of need) {
        if (dead) return;
        if (details[item.id]) continue;
        const d = await cardDetail(item, resolveAsset);
        if (dead) return;
        setDetails((prev) => ({ ...prev, [item.id]: d }));
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, resolveAsset]);

  const create = async (text: string) => {
    if (busy) return;
    const body = text.trim();
    setBusy(true); setErr("");
    try {
      const title = body ? titleOf(body) : "未命名画布";
      const c = cmd(); let id = normalizeCanvasId("c" + Date.now().toString(36));
      if (c) {
        const res = await c({ type: "canvas/create", title }).catch(() => null);
        if (!res || !res.ok) { setErr("新建失败（" + String(res?.error || "UNKNOWN") + "）"); return; }
        id = normalizeCanvasId(String(res.canvasId || res.canvas?.id || res.canvas?.canvasId || res.id || id));
      }
      // 描述写成首个文本节点（内容与提示词都落上，进画布就看得到自己那句话）；写失败不挡进入，如实提示
      if (body) {
        try {
          const node = newNode("text", 0, 0, { title: "创作说明", prompt: body, hist: [{ text: body, meta: { at: Date.now() } }] });
          const saved = await saveDoc(id, { nodes: [node], edges: [], comments: [] }, null);
          if (!saved.ok) setErr("描述已留在本机，但没能同步到画布：" + String(saved.error || "保存失败"));
        } catch (e) { setErr("描述写入失败：" + (e instanceof Error ? e.message : "未知错误")); }
      }
      onOpen({ id, name: title });
    } finally { setBusy(false); }
  };

  const initial = (userName || "").trim().slice(0, 1).toUpperCase() || "O";
  // 窗口里左上角要给系统红绿灯让位：外壳传 winInset，这里写成 CSS 变量给顶栏用
  const rootStyle = winInset ? ({ "--win-inset": winInset + "px" } as unknown as import("react").CSSProperties) : undefined;
  return <div className="cn-root lp2" data-theme={dark ? "dark" : "light"} style={rootStyle}>
    <header className="lp2-top">
      <div className="lp2-brand"><Logo /><b>OpenArc</b><span className="lp2-beta">BETA</span></div>
      <nav className="lp2-nav" aria-label="主导航">
        <button className={"lp2-nav-i" + (view === "home" ? " on" : "")} aria-current={view === "home" ? "page" : undefined} onClick={() => setView("home")}><Icon name="layout" size="s" />主页</button>
        {onOpenApp ? <button className="lp2-nav-i" data-open="market" onClick={() => onOpenApp("market")}><Icon name="grid" size="s" />应用市场</button> : null}
        <button className={"lp2-nav-i" + (view === "all" ? " on" : "")} aria-current={view === "all" ? "page" : undefined} onClick={() => setView("all")}><Icon name="folder" size="s" />我的项目</button>
      </nav>
      <div className="lp2-me" title={userName || "未登录用户"}>{initial}</div>
    </header>
    {view === "home" ? <main className="lp2-main">
      <section className="lp2-hero">
        <h1><Icon name="sparkle" />今天要做点什么？</h1>
        <div className="lp2-pad">
          <textarea ref={taRef} value={desc} rows={2} disabled={busy}
            placeholder="描述你想做的画面，例如：给一款白色运动水壶做三张电商主图，比例 3:4"
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void create(desc); } }} />
          <div className="lp2-pad-foot">
            <button className="lp2-plus" title="新建空白画布" aria-label="新建空白画布" data-new="blank" onClick={() => void create("")}><Icon name="plus" /></button>
            <span className="sp" />
            <button className="lp2-go" disabled={busy} data-new="prompt" onClick={() => void create(desc)}>{busy ? "正在创建…" : "开始制作"}<Icon name="runup" size="xs" /></button>
          </div>
        </div>
        {err ? <div className="gp-warn lp2-err"><Icon name="alert" size="s" /><span>{err}</span></div> : null}
        <div className="lp2-under">
          <div className="lp2-chips">
            {STARTERS.map((s) => <button key={s.label} className="lp2-chip" data-starter={s.label}
              onClick={() => { setDesc(s.prompt); taRef.current?.focus(); }}><Icon name={s.icon} size="s" />{s.label}</button>)}
          </div>
          <div className="lp2-skills">
            <span className="lp2-skills-l">技能</span>
            {onOpenApp ? <button className="lp2-tile" data-open="skills" title="Skill 中心" aria-label="Skill 中心" onClick={() => onOpenApp("skills")}><Icon name="sparkle" /></button> : null}
          </div>
        </div>
      </section>
      <section className="lp2-row">
        <button className="lp2-newcard" data-new="project" onClick={() => void create("")}><span className="lp2-nc-plus"><Icon name="plus" /></span><span>新建项目</span></button>
        {recent.slice(0, 3).map((item) => <ProjectCard key={item.id} item={item} detail={details[item.id]} onOpen={() => onOpen(item)} />)}
      </section>
      <div className="lp2-more"><button onClick={() => setView("all")}>所有项目<Icon name="right" size="xs" /></button></div>
    </main> : <main className="lp2-main lp2-main-all">
      <div className="lp2-allhead"><h1>我的项目</h1><span>{list ? list.length + " 个画布" : "读取中…"}</span></div>
      <div className="lp2-grid">
        <button className="lp2-newcard sm" data-new="project" onClick={() => void create("")}><span className="lp2-nc-plus"><Icon name="plus" /></span><span>新建项目</span></button>
        {(list || []).map((item) => <ProjectCard key={item.id} item={item} detail={details[item.id]} onOpen={() => onOpen(item)} compact />)}
      </div>
      {list && !list.length ? <p className="lp2-empty">还没有画布。回主页写一句，或点「新建项目」。</p> : null}
    </main>}
  </div>;
}
