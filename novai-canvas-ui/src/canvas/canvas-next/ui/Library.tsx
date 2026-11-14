/**
 * 素材库抽屉：NOVAI 全局素材（画布 / 本地 / 资产库 / 提示词），文件管理器式布局。
 * 首屏只渲染 60 条，缩略图走 media-preview + lazy，滚到底再增加。
 */
import { hostRoot } from "../../../novaiBridgeRoot";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactElement } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { replaceNodeMedia } from "../actions";
import { filterLibraryItems, libraryNodeBox } from "../libraryAssets";
import { buildFolderTree, categoryOwners, matchFixedFolders, rowKeyIntent, type FolderNode } from "../libraryTree";
import { genOf, outOf, uid, type AssetRef, type GenKind } from "../model";
import { openCharacterLibrary } from "./CharacterLibrary";
import { useCtl, type Ctl } from "./ctx";
import { AnimateIcon } from "./AnimateIcon";
import { Icon, type IconName } from "./Icon";
import { openModal, openPop } from "./overlay";
import { useAssetUrl } from "./useAsset";
import { IS_MAC } from "./shortcuts";

type Lib = { id: string; name: string; visibility?: string; access?: string; itemCount?: number; categoryIds?: string[] };
type Cmd = (r: Record<string, unknown>) => Promise<Record<string, any>>;
type GItem = { id: string; name: string; url: string; kind: string; categoryIds: string[]; natural_w?: number; natural_h?: number; prompt?: string; canvas_title?: string; assetId?: string; use?: string; productId?: string; summary?: string; tags?: string[] };
/** 资产库条目放到画布上时写进节点的来源引用（gen.asset） */
export function assetRefOf(it: Pick<GItem, "assetId" | "use" | "productId" | "name">): AssetRef | undefined {
  if (!it.assetId) return undefined;
  return { id: it.assetId, ...(it.use ? { use: it.use } : {}), ...(it.productId ? { productId: it.productId } : {}), ...(it.name ? { name: it.name } : {}) };
}
type GCat = { id: string; name: string; count: number; kind: string };

const PAGE = 60;
const localParents = new Map<string, string>();
function applyLocalParents(cats: GCat[]): GCat[] {
  return cats.map((c) => { const p = localParents.get(c.id); return p && !(c as GCat & { parent_id?: string }).parent_id ? { ...c, parent_id: p } as GCat : c; });
}
const cmdOf = (): Cmd | null => { const c = hostRoot<{ canvas?: { command?: Cmd } }>()?.canvas?.command; return typeof c === "function" ? c : null; };
const isPersonal = (l: Lib) => l.access === "owner" && String(l.visibility || "").toUpperCase() === "PRIVATE";
// 图片和视频都走 media-preview（视频由后端抽帧），不再给视频显示灰块
const thumbOf = (it: GItem) => (it.kind === "image" || it.kind === "video") && it.url ? "/api/media-preview?w=256&url=" + encodeURIComponent(it.url) : "";

function mediaKind(kind: string): "image" | "video" | "audio" | null {
  return kind === "video" ? "video" : kind === "audio" ? "audio" : kind === "image" ? "image" : null;
}
async function measure(url: string, kind: "image" | "video"): Promise<{ w: number; h: number } | null> {
  if (!url) return null;
  if (kind === "image") return new Promise((ok) => { const im = new Image(); im.onload = () => ok(im.naturalWidth > 0 && im.naturalHeight > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null); im.onerror = () => ok(null); im.src = url; });
  return new Promise((ok) => { const v = document.createElement("video"); v.preload = "metadata"; v.onloadedmetadata = () => ok(v.videoWidth > 0 && v.videoHeight > 0 ? { w: v.videoWidth, h: v.videoHeight } : null); v.onerror = () => ok(null); v.src = url; });
}
export async function placeItem(ctl: Ctl, it: GItem, at?: { x: number; y: number }) {
  const store = ctl.store; const target = store.state.ui.replace;
  if (it.kind === "prompt") {
    const text = it.prompt || it.name;
    if (target && store.node(target)) { store.patchGen(target, { hist: [{ text }], hi: 0 }); store.setUI({ replace: null }); store.toast("已替换为提示词"); return; }
    const c = ctl.center(); const n = store.newNode("text", c.x - 150, c.y - 90, { title: it.name, manual: true, hist: [{ text }], w: 300, h: 180 });
    store.addNodes([n], [], { select: true }); store.toast("提示词已放到画布"); return;
  }
  const mk = mediaKind(it.kind); if (!mk) { store.toast("这个素材暂不支持插入"); return; }
  let sw = Number(it.natural_w) || 0, sh = Number(it.natural_h) || 0;
  if (!sw || !sh) { const m = mk === "audio" ? null : await measure(it.url, mk); if (m) { sw = m.w; sh = m.h; } }
  const box = libraryNodeBox(sw, sh, mk);
  const asset = assetRefOf(it);
  if (target && store.node(target)) { replaceNodeMedia(store, target, { url: it.url, w: box.w, h: box.h }); store.patchGen(target, { asset }); store.setUI({ replace: null }); store.toast("已替换素材"); return; }
  const c = at || ctl.center(); const n = store.newNode(mk, c.x - box.w / 2, c.y - box.h / 2, { title: it.name, uploaded: true, hist: [{ url: it.url, w: sw || box.w, h: sh || box.h }], w: box.w, h: box.h, ...(asset ? { asset } : {}) });
  store.addNodes([n], [], { select: true }); store.toast("已放到画布");
}

function scopeOf(it: GItem, scope: "personal" | "local") {
  const local = it.categoryIds.some((id) => id.startsWith("local:"));
  const nonLocal = it.categoryIds.some((id) => id !== "all" && !id.startsWith("local:"));
  return scope === "local" ? local : nonLocal;
}

/** 素材用途（和后端 server/asset_meta.py 的 ASSET_USES 同一套 id） */
export const USES: Array<{ id: string; label: string; icon: IconName }> = [
  { id: "product", label: "产品", icon: "cube" },
  { id: "model", label: "模特", icon: "user" },
  { id: "scene", label: "场景", icon: "image" },
  { id: "source", label: "源视频", icon: "video" },
  { id: "depth", label: "深度视频", icon: "layers" },
  { id: "style", label: "风格参考", icon: "palette" },
  { id: "sound", label: "音效", icon: "audio" },
];
const USE_LABEL: Record<string, string> = Object.fromEntries(USES.map((u) => [u.id, u.label]));
const TYPES: Array<{ id: string; label: string; icon: IconName }> = [
  { id: "all", label: "全部类型", icon: "layoutgrid" },
  { id: "image", label: "图片", icon: "image" },
  { id: "video", label: "视频", icon: "video" },
  { id: "audio", label: "音频", icon: "audio" },
  { id: "prompt", label: "提示词", icon: "text" },
];
type Product = { id: string; name: string; selling_points?: string; angle_count: number; angles: Array<{ item_id: string; label?: string; url: string; name?: string; kind?: string }> };
/** 文件夹里先显示这么多个，多了点「显示全部」 */
const FOLDER_PEEK = 12;

type FolderEditState = { mode: "new" } | { mode: "sub"; parentKey: string; parentId: string } | { mode: "rename"; key: string };

/** 行内输入框：新建 / 改名文件夹都在列表里直接改，不弹窗。Enter 保存，Esc 取消。 */
function FolderEditRow({ initial, depth, onSave, onCancel }: { initial: string; depth: number; onSave: (name: string) => Promise<string | null>; onCancel: () => void }) {
  const [name, setName] = useState(initial); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const save = async () => {
    const v = name.trim(); if (!v) { setErr("请输入文件夹名称"); return; }
    if (v === initial.trim()) { onCancel(); return; }
    setBusy(true); const e = await onSave(v); setBusy(false); if (e) setErr(e);
  };
  return <div className="lib-fedit" style={{ marginLeft: depth * 14 }}>
    <div className="lib-fedit-row">
      <Icon name="folder" size="s" />
      <input autoFocus maxLength={24} value={name} placeholder="文件夹名称" aria-label="文件夹名称" disabled={busy}
        onChange={(e) => { setName(e.target.value); setErr(""); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void save(); else if (e.key === "Escape") onCancel(); }} />
      <button className="ib" aria-label="保存" disabled={busy} onClick={() => void save()}><Icon name="check" size="xs" /></button>
      <button className="ib" aria-label="取消" disabled={busy} onClick={onCancel}><Icon name="x" size="xs" /></button>
    </div>
    {err ? <div className="lib-fedit-err">{err}</div> : null}
  </div>;
}

export function LibrarySection({ q }: { q: string }) {
  const ctl = useCtl(); const cmd = cmdOf();
  const [items, setItems] = useState<GItem[]>([]); const [cats, setCats] = useState<GCat[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [scope, setScope] = useState<"personal" | "local">("personal");
  const [query, setQuery] = useState(q || "");
  const [use, setUse] = useState("all"); const [type, setType] = useState("all"); const [productId, setProductId] = useState<string | null>(null);
  // 手风琴：展开的文件夹（可同时开多个）；showAll = 已点过「显示全部」的文件夹
  const [open, setOpen] = useState<Set<string>>(() => new Set()); const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [edit, setEdit] = useState<FolderEditState | null>(null);
  const [busy, setBusy] = useState(true); const [err, setErr] = useState(""); const [tick, setTick] = useState(0);
  const [offset, setOffset] = useState(0); const [hasMore, setHasMore] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [visible, setVisible] = useState(PAGE); const sentinel = useRef<HTMLDivElement>(null); const [selected, setSelected] = useState<string | null>(null);
  const offsetRef = useRef(PAGE); const refreshTimer = useRef<number | null>(null); const [libId, setLibId] = useState("default");
  useEffect(() => { if (!cmd) return; void cmd({ type: "canvas/assetLibrary/list" }).then((r) => { const id = r?.ok && r.libraries?.[0]?.id; if (id) setLibId(String(id)); }).catch(() => undefined); }, [cmd]);
  const loadProducts = useCallback(async () => {
    if (!cmd) return;
    const r = await cmd({ type: "canvas/assetLibrary/products" }).catch(() => null);
    setProducts(r?.ok && Array.isArray(r.products) ? r.products.filter((p: Product) => p && p.angle_count > 0) : []);
  }, [cmd]);
  useEffect(() => {
    if (!cmd) { setBusy(false); return; }
    setBusy(true); setErr("");
    // 每次打开抽屉都强制拉一次最新：抽屉关着时存进去的素材（收不到 ws 广播）重开也要立刻可见
    void cmd({ type: "canvas/globalAssets", limit: PAGE, refresh: true }).then((r) => {
      if (!r || !r.ok) throw new Error(String(r?.error || "读取素材库失败"));
      setItems(Array.isArray(r.items) ? r.items : []); setCats(Array.isArray(r.categories) ? applyLocalParents(r.categories) : []);
      offsetRef.current = PAGE; setOffset(PAGE); setHasMore(!!r.hasMore); setVisible(PAGE);
    }).catch((e) => setErr(e instanceof Error ? e.message : "读取素材库失败")).finally(() => setBusy(false));
    void loadProducts();
  }, [cmd, tick, loadProducts]);
  useEffect(() => { offsetRef.current = offset; }, [offset]);
  const refreshAssets = useCallback(async () => {
    if (!cmd) return;
    const limit = Math.max(offsetRef.current, PAGE);
    const r = await cmd({ type: "canvas/globalAssets", limit, refresh: true }).catch(() => null);
    if (!r || !r.ok) return;
    setItems(Array.isArray(r.items) ? r.items : []); setCats(Array.isArray(r.categories) ? applyLocalParents(r.categories) : []);
    setHasMore(!!r.hasMore); offsetRef.current = limit; setOffset(limit);
    void loadProducts();
  }, [cmd, loadProducts]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void refreshAssets(); }, 400);
  }, [refreshAssets]);
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current); }, []);
  useEffect(() => {
    const onSaved = (ev: Event) => {
      const d = (ev as CustomEvent<{ item?: Record<string, any>; categoryId?: string; categoryName?: string; kind?: string }>).detail || {};
      const raw = d.item; if (!raw?.url) return;
      const id = String(raw.id || raw.url);
      const cat = cats.find((c) => d.categoryId ? c.id === "asset:" + d.categoryId : !!d.categoryName && c.name === d.categoryName);
      const item: GItem = { id, name: String(raw.name || raw.title || "素材"), url: String(raw.url), kind: String(raw.kind || d.kind || "image"), categoryIds: ["all", ...(cat ? [cat.id] : [])] };
      setItems((prev) => prev.some((x) => x.url === item.url) ? prev : [item, ...prev]);
      if (cat) setCats((prev) => prev.map((c) => c.id === cat.id ? { ...c, count: (Number(c.count) || 0) + 1 } : c));
      scheduleRefresh();
    };
    window.addEventListener("cn:asset-saved", onSaved);
    return () => window.removeEventListener("cn:asset-saved", onSaved);
  }, [cats, scheduleRefresh]);
  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let stop = false; let ws: WebSocket | null = null; let retry = 0; let timer = 0;
    const connect = () => {
      if (stop) return;
      try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/stats"); } catch { return; }
      ws.onopen = () => { retry = 0; };
      ws.onmessage = (ev) => { try { if (JSON.parse(String(ev.data || "{}")).type === "asset_library_updated") scheduleRefresh(); } catch { /* ignore */ } };
      ws.onclose = () => { ws = null; if (!stop) { timer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000)); } };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    connect();
    return () => { stop = true; window.clearTimeout(timer); try { ws?.close(); } catch { /* ignore */ } };
  }, [scheduleRefresh]);
  useEffect(() => { setVisible(PAGE); setUse("all"); setProductId(null); setEdit(null); }, [scope]);
  useEffect(() => { setVisible(PAGE); }, [use, type, productId, query]);
  const loadMore = async () => {
    if (!cmd || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const r = await cmd({ type: "canvas/globalAssets", limit: offset + PAGE });
      if (r && r.ok) {
        const next = Array.isArray(r.items) ? r.items : [];
        setItems((prev) => { const seen = new Set(prev.map((x) => x.url)); return prev.concat(next.filter((x: GItem) => !seen.has(x.url))); });
        if (Array.isArray(r.categories)) setCats((prev) => { const map = new Map(prev.map((x) => [x.id, x])); for (const c of r.categories) { const old = map.get(c.id); if (!old || c.count > old.count || c.kind === "asset") map.set(c.id, c); } return [...map.values()]; });
        setOffset((o) => o + PAGE); setHasMore(!!r.hasMore);
      }
    } finally { setLoadingMore(false); }
  };
  const scoped = useMemo(() => items.filter((it) => scopeOf(it, scope)), [items, scope]);
  // 文件夹 = 后端真实分类（个人 = 资产库，本地 = 上传目录），不再有前端写死的虚拟文件夹
  const folders = useMemo(() => {
    const pool = scope === "personal" ? cats.filter((c) => c.kind === "asset") : cats.filter((c) => c.kind === "local" && c.id !== "local:all");
    const urlsOf = (catId: string) => new Set(scoped.filter((it) => it.categoryIds.includes(catId)).map((it) => it.url)).size;
    return buildFolderTree(pool as Array<GCat & { parent_id?: string }>, urlsOf);
  }, [cats, scoped, scope]);
  const folderByKey = useMemo(() => new Map(folders.map((f) => [f.key, f])), [folders]);
  const product = productId ? products.find((p) => p.id === productId) || null : null;
  const useCounts = useMemo(() => { const m = new Map<string, number>(); for (const it of scoped) if (it.use) m.set(it.use, (m.get(it.use) || 0) + 1); return m; }, [scoped]);
  const searching = !!query.trim();
  const shown = useMemo(() => {
    let list = scoped;
    if (product) { const ids = new Set(product.angles.map((a) => a.item_id)); list = list.filter((it) => !!it.assetId && ids.has(it.assetId)); }
    if (use !== "all") list = list.filter((it) => it.use === use);
    if (type !== "all") list = list.filter((it) => it.kind === type);
    return filterLibraryItems(list, "all", query);
  }, [scoped, product, use, type, query]);
  useEffect(() => {
    const el = sentinel.current; if (!el) return;
    const root = el.closest(".dbody"); const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      if (visible < shown.length) setVisible((v) => Math.min(shown.length, v + PAGE));
      else void loadMore();
    }, { root, rootMargin: "240px" });
    io.observe(el); return () => io.disconnect();
  }, [shown.length, visible, hasMore, loadingMore, offset]);
  if (!cmd) return <div className="lib-shell"><div className="lib-empty">素材库只在桌面版可用</div></div>;
  const close = () => { ctl.store.setUI({ drawer: null }); };
  const preview = (it: GItem) => openModal((cl) => <AssetPreview it={it} onClose={cl} />, "asset-preview-modal");
  const menu = (it: GItem, e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); setSelected(it.url);
    openPop({ x: e.clientX, y: e.clientY }, (cl) => <>
      <button className="mi" onClick={() => { cl(); void placeItem(ctl, it); }}><Icon name="plus" size="s" />添加到画布</button>
      <button className="mi" onClick={() => { cl(); preview(it); }}><Icon name="eye" size="s" />预览</button>
      <button className="mi" onClick={() => { cl(); void navigator.clipboard?.writeText(it.url === "prompt:" + it.id ? (it.prompt || it.name) : it.url).then(() => ctl.store.toast("已复制")).catch(() => ctl.store.toast("复制失败")); }}><Icon name="copy" size="s" />复制链接</button>
    </>, "down", "left");
  };
  const upload = () => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: ctl.center() } })); };
  const assetIdOf = (f: FolderNode) => f.catId.startsWith("asset:") ? f.catId.slice(6) : "";
  const setOpenKey = (key: string, on: boolean) => setOpen((prev) => { const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next; });
  const toggleFolder = (f: FolderNode) => setOpenKey(f.key, !open.has(f.key));
  const createFolder = async (name: string, parentId?: string): Promise<string | null> => {
    const r = await cmd({ type: "canvas/assetLibrary/folderCreate", libraryId: libId, name, parentId }).catch(() => null);
    if (!r || !r.ok) return String(r?.detail || r?.error || "新建失败");
    if (parentId && r.folder?.id) localParents.set("asset:" + r.folder.id, "asset:" + parentId);
    await refreshAssets(); setEdit(null); ctl.store.toast("已新建文件夹「" + name + "」"); return null;
  };
  const renameFolder = async (f: FolderNode, name: string): Promise<string | null> => {
    const r = await cmd({ type: "canvas/assetLibrary/folderRename", libraryId: libId, categoryId: assetIdOf(f) || undefined, from: f.name, to: name }).catch(() => null);
    if (!r || !r.ok) return String(r?.detail || r?.error || "重命名失败");
    await refreshAssets(); setEdit(null); return null;
  };
  const deleteFolder = (f: FolderNode) => openModal((cl) => <DeleteFolderDialog name={f.name} count={f.total} children={f.childKeys.length} onClose={cl} onConfirm={async () => {
    const id = assetIdOf(f); if (!id) return "这个文件夹没有对应的后端分类";
    const r = await cmd({ type: "canvas/assetLibrary/folderDelete", libraryId: libId, categoryId: id }).catch(() => null);
    if (!r || !r.ok) return String(r?.detail || r?.error || "删除失败");
    setOpenKey(f.key, false);
    await refreshAssets(); ctl.store.toast("已删除文件夹「" + f.name + "」"); return null;
  }} />, "folder-dialog-modal");
  const folderMenu = (f: FolderNode, e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const id = assetIdOf(f); if (!id) return; // 本地上传目录只读
    const at = e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : (() => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.right, y: r.bottom }; })();
    openPop(at, (cl) => <>
      <div className="mh">{f.name}</div>
      <button className="mi" onClick={() => { cl(); setOpenKey(f.key, true); setEdit({ mode: "sub", parentKey: f.key, parentId: id }); }}><Icon name="plus" size="s" />新建子文件夹</button>
      <button className="mi" onClick={() => { cl(); setEdit({ mode: "rename", key: f.key }); }}><Icon name="pencil" size="s" />重命名</button>
      <button className="mi danger" onClick={() => { cl(); deleteFolder(f); }}><Icon name="trash" size="s" />删除文件夹</button>
    </>, "down", "left");
  };
  const tile = (it: GItem) => <LibTile key={it.id + ":" + it.url} it={it} selected={selected === it.url} onSelect={() => setSelected(it.url)} onPreview={() => preview(it)} onMenu={(e) => menu(it, e)} />;
  /** 一个文件夹 + （展开时）它正下方的子文件夹和素材 */
  const renderFolder = (f: FolderNode): ReactElement => {
    if (edit?.mode === "rename" && edit.key === f.key) return <FolderEditRow key={f.key} initial={f.name} depth={f.depth} onCancel={() => setEdit(null)} onSave={(name) => renameFolder(f, name)} />;
    const isOpen = open.has(f.key);
    const own = isOpen ? filterLibraryItems(scoped.filter((it) => it.categoryIds.includes(f.catId)), "all", "") : [];
    const peek = showAll.has(f.key) ? own : own.slice(0, FOLDER_PEEK);
    const editable = !!assetIdOf(f);
    const onKey = (e: ReactKeyboardEvent) => {
      const intent = rowKeyIntent(e.key); if (!intent) return;
      e.preventDefault(); e.stopPropagation();
      setOpenKey(f.key, intent === "toggle" ? !isOpen : intent === "open");
    };
    return <div key={f.key} className={"lib-fitem" + (isOpen ? " open" : "")}>
      <div role="button" tabIndex={0} aria-expanded={isOpen}
        data-folder-name={f.name} data-folder-id={assetIdOf(f)}
        className={"lib-row lib-frow" + (isOpen ? " on" : "")} style={{ paddingLeft: 6 + f.depth * 14 }}
        title={isOpen ? "单击收起" : "单击展开"}
        onClick={() => toggleFolder(f)} onKeyDown={onKey} onContextMenu={(e) => folderMenu(f, e)}>
        <Icon name="right" size="xs" className="lib-chev" />
        <Icon name="folder" size="s" />
        <span className="lib-name">{f.name}</span>
        <em>{f.total !== f.count ? f.count + " / " + f.total : f.count}</em>
        {editable ? <button className="ib lib-fmore" aria-label={"「" + f.name + "」更多操作"} onClick={(e) => folderMenu(f, e)}><Icon name="more" size="xs" /></button> : null}
      </div>
      {isOpen ? <div className="lib-fbody">
        {f.childKeys.map((k) => folderByKey.get(k)).filter((x): x is FolderNode => !!x).map(renderFolder)}
        {edit?.mode === "sub" && edit.parentKey === f.key ? <FolderEditRow initial="" depth={f.depth + 1} onCancel={() => setEdit(null)} onSave={(name) => createFolder(name, edit.parentId)} /> : null}
        {own.length ? <div className="agrid lib-grid lib-fgrid" style={{ marginLeft: 6 + (f.depth + 1) * 14 }}>{peek.map(tile)}</div>
          : !f.childKeys.length ? <div className="lib-fempty" style={{ marginLeft: 6 + (f.depth + 1) * 14 }}>这个文件夹还是空的，把素材或画布节点拖到文件夹名上就能放进来</div> : null}
        {own.length > peek.length ? <button className="linkbtn lib-fall" style={{ marginLeft: 6 + (f.depth + 1) * 14 }} onClick={() => setShowAll((prev) => new Set(prev).add(f.key))}>显示全部 {own.length} 个</button> : null}
      </div> : null}
    </div>;
  };
  const topFolders = folders.filter((f) => !f.parentKey);
  const gridTitle = searching ? "搜索结果" : product ? product.name + " · 产品角度" : use !== "all" ? USE_LABEL[use] || "素材" : "全部素材";
  return <div className="lib-shell">
    <div className="lib-head"><button className="ib" aria-label="收起素材库" onClick={close}><Icon name="left" size="s" /></button><b>素材库</b><span className="sp" /><button className="lib-ai" data-lib-ai onClick={() => openCharacterLibrary(ctl)}><Icon name="user" size="xs" />AI 角色</button><button className="ib" aria-label="上传素材" onClick={upload}><Icon name="plus" size="s" /></button></div>
    <div className="lib-scope"><button className={scope === "personal" ? "on" : ""} onClick={() => setScope("personal")}>个人</button><button className={scope === "local" ? "on" : ""} onClick={() => setScope("local")}>本地</button></div>
    <div className="lib-search"><Icon name="search" size="xs" /><input value={query} placeholder="搜名称或 AI 标签，如「白色运动鞋」" onChange={(e) => setQuery(e.target.value)} />{query ? <button className="ib" aria-label="清空搜索" onClick={() => setQuery("")}><Icon name="x" size="xs" /></button> : null}<AnimateIcon asChild><button className="ib" aria-label="刷新" onClick={() => setTick((t) => t + 1)}><Icon name="history" size="xs" /></button></AnimateIcon></div>
    {useCounts.size ? <div className="lib-chips" role="group" aria-label="按用途筛选">
      <button className={"lib-chip" + (use === "all" ? " on" : "")} aria-pressed={use === "all"} onClick={() => setUse("all")}>全部</button>
      {USES.filter((u) => useCounts.has(u.id)).map((u) => <button key={u.id} className={"lib-chip" + (use === u.id ? " on" : "")} aria-pressed={use === u.id} onClick={() => setUse(use === u.id ? "all" : u.id)}><Icon name={u.icon} size="xs" />{u.label}<em>{useCounts.get(u.id)}</em></button>)}
    </div> : null}
    {err ? <div className="lib-empty">{err}<button className="linkbtn" onClick={() => setTick((t) => t + 1)}>重试</button></div> : null}
    {busy && !items.length ? <div className="lib-empty">正在读取全局素材…</div> : null}
    {!searching && scope === "personal" && products.length ? <div className="lib-sec">
      <div className="lib-section-title"><Icon name="layers" size="xs" /><span>产品档案</span><small>多角度参考</small></div>
      <div className="lib-prods">{products.map((p) => <button key={p.id} className={"lib-prod" + (productId === p.id ? " on" : "")} aria-pressed={productId === p.id} title={p.selling_points || p.name} onClick={() => setProductId(productId === p.id ? null : p.id)}>
        <span className="lib-prod-angs">{p.angles.slice(0, 3).map((a) => <i key={a.item_id} style={{ backgroundImage: "url(\"/api/media-preview?w=128&url=" + encodeURIComponent(a.url) + "\")" }} />)}</span>
        <b>{p.name}</b><small>{p.angle_count} 个角度</small>
      </button>)}</div>
    </div> : null}
    {!searching ? <div className="lib-sec">
      <div className="lib-section-title"><Icon name="folder" size="xs" /><span>文件夹</span><small>点开在下方展开，再点收起</small></div>
      <div className="lib-folder-list">
        {topFolders.map(renderFolder)}
        {!topFolders.length && !busy ? <div className="lib-fempty">{scope === "personal" ? "还没有文件夹" : "本地上传目录还没有子文件夹"}</div> : null}
        {scope === "personal" ? edit?.mode === "new" ? <FolderEditRow initial="" depth={0} onCancel={() => setEdit(null)} onSave={(name) => createFolder(name)} />
          : <button className="lib-row lib-newfolder" onClick={() => setEdit({ mode: "new" })}><Icon name="plus" size="s" /><span>新建文件夹</span></button> : null}
      </div>
    </div> : null}
    <div className="lib-grid-head">
      <b>{gridTitle}</b><em>{shown.length}{hasMore && !product ? "+" : ""}</em>
      {product ? <button className="ib" aria-label="取消产品筛选" onClick={() => setProductId(null)}><Icon name="x" size="xs" /></button> : null}
      <span className="sp" />
      <div className="lib-types" role="group" aria-label="按类型筛选">{TYPES.map((t) => <button key={t.id} className={type === t.id ? "on" : ""} title={t.label} aria-label={t.label} aria-pressed={type === t.id} onClick={() => setType(t.id)}><Icon name={t.icon} size="xs" /></button>)}</div>
    </div>
    <div className="agrid lib-grid">{shown.slice(0, visible).map(tile)}
      {!shown.length && !busy ? <span className="lg-dim" style={{ gridColumn: "1/-1" }}>{searching ? "没有和「" + query.trim() + "」匹配的素材，换个说法试试" : items.length ? "这里还没有素材" : "素材库是空的"}</span> : null}
    </div>
    <div ref={sentinel} className="lib-sentinel" />{loadingMore ? <div className="lib-empty">正在加载更多…</div> : shown.length > visible ? <div className="lib-empty">继续下滑加载更多</div> : null}
    <div className="lib-drop-tip"><Icon name="upload" size="xs" /><span>{"把画布上的节点拖到这里存入素材库，拖到文件夹名上直接放进该文件夹（按住 " + (IS_MAC ? "⌥" : "Alt") + " 也行）"}</span></div>
  </div>;
}

function DeleteFolderDialog({ name, count, children, onConfirm, onClose }: { name: string; count: number; children: number; onConfirm: () => Promise<string | null>; onClose: () => void }) {
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); const e = await onConfirm(); setBusy(false); if (e) setErr(e); else onClose(); };
  return <div className="folder-dialog"><div className="fd-head"><b>删除文件夹</b><button className="ib" aria-label="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
    <p>删除「{name}」会连同里面的 {count} 个素材{children ? "和 " + children + " 个子文件夹" : ""}一起删除，无法恢复。</p>
    {err ? <div className="fd-err">{err}</div> : null}
    <div className="fd-foot"><button className="btn" onClick={onClose}>取消</button><button className="btn solid" disabled={busy} onClick={() => void go()}>{busy ? "删除中…" : "删除"}</button></div>
  </div>;
}

function AssetPreview({ it, onClose }: { it: GItem; onClose: () => void }) {
  const src = useAssetUrl(it.kind === "prompt" ? "" : it.url);
  return <div className="asset-prev">
    <div className="ap-head"><b>{it.name}</b><span className="sp" /><button className="ib" aria-label="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
    <div className="ap-body">
      {it.kind === "image" ? <img src={src || it.url} alt={it.name} /> : it.kind === "video" ? <video src={src || it.url} controls autoPlay playsInline /> : it.kind === "audio" ? <audio src={src || it.url} controls autoPlay /> : <pre>{it.prompt || it.name}</pre>}
    </div>
  </div>;
}

function LibTile({ it, selected, onSelect, onPreview, onMenu }: { it: GItem; selected: boolean; onSelect: () => void; onPreview: () => void; onMenu: (e: MouseEvent) => void }) {
  const [broken, setBroken] = useState(false);
  const thumb = broken ? "" : thumbOf(it);
  const useLabel = it.use ? USE_LABEL[it.use] : "";
  const tip = [it.name, useLabel, it.summary, (it.tags || []).slice(0, 6).join(" · "), it.canvas_title].filter(Boolean).join("\n");
  return <div className={"a" + (selected ? " sel" : "") + (it.kind === "prompt" ? " txt" : "") + (it.kind === "video" ? " vid" : "")} title={tip} onClick={(e) => { e.stopPropagation(); onSelect(); }} onDoubleClick={(e) => { e.stopPropagation(); onPreview(); }} onContextMenu={onMenu} draggable onDragStart={(e) => { (window as unknown as { __novaiLibDrag?: GItem }).__novaiLibDrag = it; try { e.dataTransfer?.setData("text/plain", it.url); } catch { /* ignore */ } }} onDragEnd={() => { (window as unknown as { __novaiLibDrag?: GItem }).__novaiLibDrag = undefined; }}>
    {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /> : it.kind === "video" ? <Icon name="video" /> : it.kind === "audio" ? <span className="atext"><Icon name="audio" size="xs" />{it.name}</span> : <span className="atext"><Icon name={it.kind === "prompt" ? "pencil" : "image"} size="xs" />{it.name}</span>}
    {it.kind === "video" ? <span className="abadge"><Icon name={it.use === "depth" ? "layers" : "play"} size="xs" />{it.use === "depth" ? "深度" : "视频"}</span> : null}
    {useLabel && it.kind !== "video" && it.kind !== "audio" ? <span className="ause">{useLabel}</span> : null}
  </div>;
}

/** 把画布里的各种素材地址变成资产库能收的本地 /assets 或 data URL。 */
async function normalizeAssetUrl(store: Ctl["store"], raw: string): Promise<{ url?: string; dataUrl?: string; error?: string }> {
  let u = String(raw || "").trim();
  if (!u) return { error: "素材地址为空" };
  for (let i = 0; i < 3; i++) {
    if (/^\/api\/media-preview\?/i.test(u)) {
      const q = new URLSearchParams(u.split("?")[1] || ""); const inner = q.get("url"); if (!inner) break;
      u = decodeURIComponent(inner); continue;
    }
    break;
  }
  if (/^(novai-asset:|openarc-asset:|openarc-resource:|resource:\/\/)/i.test(u)) {
    const resolved = await store.backend.resolveAsset(u).catch(() => null);
    if (!resolved) return { error: "资源引用不可用（可能已删除）" };
    u = resolved;
    if (/^\/api\/media-preview\?/i.test(u)) { const q = new URLSearchParams(u.split("?")[1] || ""); const inner = q.get("url"); if (inner) u = decodeURIComponent(inner); }
  }
  if (u.startsWith("data:")) return { dataUrl: u };
  if (/^\/(assets|output)\//i.test(u)) return { url: u };
  try {
    const res = await fetch(u);
    if (!res.ok) return { error: "读取素材失败（HTTP " + res.status + "）" };
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || "")); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
    return dataUrl.startsWith("data:") ? { dataUrl } : { error: "读取素材失败" };
  } catch (e) {
    return { error: "读取素材失败：" + (e instanceof Error ? e.message : "无法访问素材地址") };
  }
}

/** 节点右键「存入资产库」：图片 / 视频 / 音频结果，或文本节点的内容（存成提示词） */
/** 把一个节点的当前结果存进指定资产库；返回失败原因（成功返回 null） */
async function saveOne(cmd: Cmd, store: Ctl["store"], lib: Lib, n: CanvasNode, folder?: { name: string; id?: string } | null): Promise<string | null> {
  const g = genOf(n); const o = outOf(n);
  if (n.kind === "text") {
    const x = await cmd({ type: "canvas/assetLibrary/upsert", libraryId: lib.id, item: { kind: "prompt", title: g.title, prompt: o?.text || g.prompt || "" } }).catch(() => null);
    return x && x.ok ? null : String(x?.detail || x?.error || "存入提示词失败");
  }
  if (!o?.url) return "还没有结果";
  const prep = await normalizeAssetUrl(store, o.url);
  if (prep.error || (!prep.url && !prep.dataUrl)) return prep.error || "读取素材失败";
  const isData = !!prep.dataUrl;
  const mime = isData ? (/^data:([^;,]+)/.exec(prep.dataUrl!)?.[1] || "image/png") : (n.kind === "video" ? "video/mp4" : n.kind === "audio" ? "audio/mpeg" : "image/png");
  const ext = mime.split("/")[1] || (n.kind === "video" ? "mp4" : n.kind === "audio" ? "mp3" : "png");
  const input: Record<string, unknown> = { type: "canvas/assetLibrary/import", libraryId: lib.id, name: g.title + "." + ext, title: g.title, mime, kind: n.kind, ...(folder ? { categoryName: folder.name, ...(folder.id ? { categoryId: folder.id } : {}) } : {}) };
  if (prep.dataUrl) input.dataUrl = prep.dataUrl; else input.url = prep.url;
  const x = await cmd(input).catch(() => null);
  if (x && x.ok) window.dispatchEvent(new CustomEvent("cn:asset-saved", { detail: { libraryId: lib.id, item: x.item, categoryId: folder?.id, categoryName: folder?.name || x.item?.group, kind: n.kind } }));
  return x && x.ok ? null : String(x?.detail || x?.error || "存入失败");
}

type SaveFolder = { name: string; count: number; id?: string; depth: number; total?: number; parentKey?: string; libraryId?: string };
/** 文件夹行的选中键：有 id 用 id（同名文件夹不会串），没有 id 的固定文件夹（尚未建）才退回名字 */
const folderKeyOf = (r: { id?: string; name: string }) => r.id ? "id:" + r.id : "name:" + r.name;
function SaveLibraryDialog({ ctl, nodes, onClose }: { ctl: Ctl; nodes: CanvasNode[]; onClose: () => void }) {
  const cmd = cmdOf()!; const store = ctl.store;
  const [lib, setLib] = useState<Lib | null>(null); const [libs, setLibs] = useState<Lib[]>([]); const [cats, setCats] = useState<GCat[]>([]);
  const [scope, setScope] = useState<"personal" | "local">("personal"); const [sel, setSel] = useState("");
  const [creating, setCreating] = useState(false); const [newName, setNewName] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const list = await cmd({ type: "canvas/assetLibrary/list" }).catch(() => null);
      let libs: Lib[] = list && list.ok ? list.libraries || [] : [];
      if (!libs.length) { const made = await cmd({ type: "canvas/assetLibrary/ensure" }).catch(() => null); if (made && made.ok && made.library) libs = [made.library]; }
      setLibs(libs);
      const own = libs.find(isPersonal) || libs[0]; if (own) setLib(own);
      // 保存弹窗也要拉最新：否则刚建的库/文件夹（或在别处建的库）可能要等 5 分钟缓存过期才出现在列表里
      const data = await cmd({ type: "canvas/globalAssets", limit: 1000, refresh: true }).catch(() => null);
      setCats(data && data.ok ? applyLocalParents(data.categories || []) : []);
    })();
  }, [cmd]);
  const owners = useMemo(() => categoryOwners(libs), [libs]);
  const ownerOf = (id?: string) => id ? owners.get(String(id).replace(/^asset:/, "")) : undefined;
  const rows = useMemo<SaveFolder[]>(() => {
    const defs: Array<[string, string[]]> = [["角色", ["角色", "characters", "character"]], ["场景", ["场景", "scenes", "scene"]], ["道具", ["道具", "props", "prop"]], ["风格", ["风格", "styles", "style"]], ["音效", ["音效", "audio", "sounds", "sound"]]];
    const pool = cats.filter((c) => c.kind === (scope === "personal" ? "asset" : "local") && c.id !== "local:all" && !c.id.startsWith("prompt:"));
    const used = new Set<string>(); const out: SaveFolder[] = [];
    const addChildren = (parentCatId: string, depth: number) => {
      for (const c of pool) {
        if (used.has(c.id)) continue;
        const pid = String((c as GCat & { parent_id?: string }).parent_id || "");
        if (pid !== parentCatId) continue;
        const row: SaveFolder = { name: c.name, count: Number(c.count) || 0, id: c.id.replace(/^asset:/, ""), depth, parentKey: parentCatId, libraryId: ownerOf(c.id) };
        used.add(c.id); out.push(row); addChildren(c.id, depth + 1);
      }
    };
    for (const [name, needles] of defs) {
      // 同 folderRows：子文件夹（有 parent_id）不参与关键词归并，否则「小道具」在这里也会被吞
      const match = matchFixedFolders(pool, needles);
      match.forEach((c) => used.add(c.id));
      const primary = match.find((c) => c.kind === "asset") || match[0];
      out.push({ name, count: match.reduce((n, c) => n + (Number(c.count) || 0), 0), id: primary?.id.replace(/^asset:/, ""), depth: 0, libraryId: ownerOf(primary?.id) });
      if (primary) addChildren(primary.id, 1);
    }
    for (const c of pool) {
      if (used.has(c.id)) continue;
      const pid = String((c as GCat & { parent_id?: string }).parent_id || "");
      if (pid) continue;
      out.push({ name: c.name, count: Number(c.count) || 0, id: c.id.replace(/^asset:/, ""), depth: 0, libraryId: ownerOf(c.id) });
      used.add(c.id); addChildren(c.id, 1);
    }
    for (const c of pool) if (!used.has(c.id)) { out.push({ name: c.name, count: Number(c.count) || 0, id: c.id.replace(/^asset:/, ""), depth: 0, libraryId: ownerOf(c.id) }); used.add(c.id); }
    out.push({ name: "Others", count: 0, depth: 0 });
    return out;
  }, [cats, scope, owners]);
  const save = async () => {
    if (!lib || busy) return;
    setBusy(true);
    const row = sel ? rows.find((r) => folderKeyOf(r) === sel) : null;
    // 选中的文件夹属于哪个库就用哪个库（多库时别落到第一个库里，否则后端报「文件夹不存在」）
    const targetLib = (row?.libraryId ? libs.find((l) => l.id === row.libraryId) : null) || lib;
    const folder = row ? { name: row.name, id: row.id } : null;
    // 多选 / 堆叠也走这个弹窗：以前直接存，图片全落到第一个图片分类（默认「角色」）
    let done = 0; const fails: string[] = []; let lastErr = "";
    for (const node of nodes) {
      const err = await saveOne(cmd, store, targetLib, node, node.kind === "image" ? folder : null);
      if (err) { fails.push(genOf(node).title); lastErr = err; } else done++;
    }
    setBusy(false);
    if (nodes.length === 1 && lastErr) { store.toast(lastErr === "还没有结果" ? "这个节点还没有结果" : "存入失败：" + lastErr); return; }
    if (!done) { store.toast("存入失败：" + (lastErr || "未知错误")); return; }
    const where = "「" + targetLib.name + "」" + (folder ? " · " + folder.name : "");
    store.toast(nodes.length === 1 ? "已存入" + where : `已存入${where} ${done} 个${fails.length ? `，${fails.length} 个失败（${fails.slice(0, 3).join("、")}）` : ""}`, fails.length ? 6000 : 2600);
    onClose();
  };
  const makeFolder = async () => {
    const name = newName.trim(); if (!name || !lib) return;
    const parent = sel ? rows.find((r) => folderKeyOf(r) === sel) : null;
    const parentLib = (parent?.libraryId ? libs.find((l) => l.id === parent.libraryId) : null) || lib;
    const r = await cmd({ type: "canvas/assetLibrary/folderCreate", libraryId: parentLib.id, name, parentId: parent?.id }).catch(() => null);
    if (!r || !r.ok) { store.toast("新建文件夹失败：" + String(r?.detail || r?.error || "未知错误")); return; }
    if (parent?.id && r.folder?.id) localParents.set("asset:" + r.folder.id, "asset:" + parent.id);
    const fresh = await cmd({ type: "canvas/globalAssets", limit: 1000, refresh: true }).catch(() => null);
    if (fresh && fresh.ok) setCats(applyLocalParents(fresh.categories || []));
    else setCats((prev) => [...prev, { id: String(r.folder?.id || "asset:" + name), name, count: 0, kind: "asset" }]);
    setSel(r.folder?.id ? "id:" + String(r.folder.id).replace(/^asset:/, "") : "name:" + name); setNewName(""); setCreating(false);
  };
  return <div className="save-lib">
    <div className="slh"><b>{nodes.length > 1 ? "保存到素材库 · " + nodes.length + " 个" : "保存到素材库"}</b><span className="sp" /><button className="linkbtn" onClick={() => setCreating(true)}><Icon name="plus" size="xs" />新建文件夹</button><button className="ib" aria-label="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
    <div className="lib-scope sl-scope"><button className={scope === "personal" ? "on" : ""} onClick={() => { setScope("personal"); setSel(""); }}>个人</button><button className={scope === "local" ? "on" : ""} onClick={() => { setScope("local"); setSel(""); }}>本地</button></div>
    {creating ? <div className="sl-newrow"><input autoFocus value={newName} placeholder="新文件夹名称" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void makeFolder(); }} /><button className="btn solid" onClick={() => void makeFolder()}>新建</button><button className="btn" onClick={() => { setCreating(false); setNewName(""); }}>取消</button></div> : null}
    <div className="sl-folders">{rows.map((r, i) => <button key={folderKeyOf(r) + ":" + i} data-save-folder={r.name} className={"lib-row sl-frow" + (sel === folderKeyOf(r) ? " on" : "")} style={{ paddingLeft: 6 + r.depth * 15 }} onClick={() => setSel(folderKeyOf(r))}><Icon name={r.name === "角色" ? "user" : r.name === "场景" ? "image" : r.name === "道具" ? "cube" : r.name === "风格" ? "palette" : r.name === "音效" ? "audio" : "folder"} size="s" /><span className="lib-name">{r.name}</span><em>{r.count}</em></button>)}</div>
    <div className="slf"><button className="btn" onClick={onClose}>取消</button><button className="btn solid" disabled={busy || !lib} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div>
  </div>;
}

export async function saveNodeToLibraryDrop(ctl: Ctl, id: string, folderName?: string | null, folderId?: string | null) {
  const cmd = cmdOf(); const store = ctl.store;
  if (!cmd) { store.toast("资产库只在桌面版里可用"); return; }
  const n = store.node(id); if (!n) return;
  const o = outOf(n);
  if (!o?.url && !o?.text) { store.toast("这个节点还没有结果"); return; }
  const list = await cmd({ type: "canvas/assetLibrary/list" }).catch(() => null);
  let libs: Lib[] = list && list.ok ? list.libraries || [] : [];
  if (!libs.length) {
    const made = await cmd({ type: "canvas/assetLibrary/ensure" }).catch(() => null);
    if (made && made.ok && made.library) libs = [made.library];
  }
  if (!libs.length) { store.toast("没有可用的资产库"); return; }
  // 拖到哪个文件夹就用那个文件夹所属的库（多库时别落到第一个库里）
  const folderOwner = folderId ? libs.find((l) => (l.categoryIds || []).some((cid) => String(cid).replace(/^asset:/, "") === String(folderId).replace(/^asset:/, ""))) : undefined;
  const lib = folderOwner || libs.find(isPersonal) || libs[0];
  const err = await saveOne(cmd, store, lib, n, folderName ? { name: folderName, id: folderId || undefined } : null);
  store.toast(err ? (err === "还没有结果" ? "这个节点还没有结果" : "存入失败：" + err) : "已存入「" + lib.name + "」" + (folderName ? " · " + folderName : ""));
}

export async function saveNodeToLibrary(ctl: Ctl, n: CanvasNode, _anchor: { x: number; y: number }) {
  const cmd = cmdOf(); const store = ctl.store; if (!cmd) return store.toast("资产库只在桌面版里可用");
  const o = outOf(n);
  if (!o?.url && !o?.text) { store.toast("这个节点还没有结果"); return; }
  openModal((close) => <SaveLibraryDialog ctl={ctl} nodes={[n]} onClose={close} />, "save-lib-modal");
}

/** 多个节点一次存进同一个资产库（堆叠 / 多选「存素材库」） */
export async function saveNodesToLibrary(ctl: Ctl, nodes: CanvasNode[], _anchor: { x: number; y: number } | Element) {
  const cmd = cmdOf(); const store = ctl.store; if (!cmd) return store.toast("资产库只在桌面版里可用");
  const list = nodes.filter((n) => outOf(n)?.url || outOf(n)?.text);
  if (!list.length) return store.toast("选中的节点还没有结果");
  // 和单个节点一样先选文件夹：以前不让选，图片全落到第一个图片分类（默认「角色」）
  openModal((close) => <SaveLibraryDialog ctl={ctl} nodes={list} onClose={close} />, "save-lib-modal");
}
export { uid };