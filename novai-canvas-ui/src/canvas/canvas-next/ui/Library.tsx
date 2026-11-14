/**
 * 素材库抽屉：NOVAI 全局素材（画布 / 本地 / 资产库 / 提示词），文件管理器式布局。
 * 首屏只渲染 60 条，缩略图走 media-preview + lazy，滚到底再增加。
 */
import { hostRoot } from "../../../novaiBridgeRoot";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { replaceNodeMedia } from "../actions";
import { filterLibraryItems, libraryNodeBox } from "../libraryAssets";
import { categoryOwners, matchFixedFolders, rowKeyIntent } from "../libraryTree";
import { genOf, outOf, uid, type AssetRef, type GenKind } from "../model";
import { openCharacterLibrary } from "./CharacterLibrary";
import { useCtl, type Ctl } from "./ctx";
import { AnimateIcon } from "./AnimateIcon";
import { Icon } from "./Icon";
import { openModal, openPop } from "./overlay";
import { useAssetUrl } from "./useAsset";
import { IS_MAC } from "./shortcuts";

type Lib = { id: string; name: string; visibility?: string; access?: string; itemCount?: number; categoryIds?: string[] };
type Cmd = (r: Record<string, unknown>) => Promise<Record<string, any>>;
type GItem = { id: string; name: string; url: string; kind: string; categoryIds: string[]; natural_w?: number; natural_h?: number; prompt?: string; canvas_title?: string; assetId?: string; use?: string; productId?: string };
/** 资产库条目放到画布上时写进节点的来源引用（gen.asset） */
export function assetRefOf(it: Pick<GItem, "assetId" | "use" | "productId" | "name">): AssetRef | undefined {
  if (!it.assetId) return undefined;
  return { id: it.assetId, ...(it.use ? { use: it.use } : {}), ...(it.productId ? { productId: it.productId } : {}), ...(it.name ? { name: it.name } : {}) };
}
type GCat = { id: string; name: string; count: number; kind: string };
type FolderRow = { key: string; name: string; icon: Parameters<typeof Icon>[0]["name"]; count: number; total?: number; ids: string[]; assetId?: string; parentKey?: string; depth?: number; hasChildren?: boolean };

const PAGE = 60;
const localParents = new Map<string, string>();
function applyLocalParents(cats: GCat[]): GCat[] {
  return cats.map((c) => { const p = localParents.get(c.id); return p && !(c as GCat & { parent_id?: string }).parent_id ? { ...c, parent_id: p } as GCat : c; });
}
const cmdOf = (): Cmd | null => { const c = hostRoot<{ canvas?: { command?: Cmd } }>()?.canvas?.command; return typeof c === "function" ? c : null; };
const isPersonal = (l: Lib) => l.access === "owner" && String(l.visibility || "").toUpperCase() === "PRIVATE";
const thumbOf = (it: GItem) => it.kind === "image" && it.url ? "/api/media-preview?w=256&url=" + encodeURIComponent(it.url) : "";

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
function folderRows(items: GItem[], cats: GCat[], scope: "personal" | "local"): FolderRow[] {
  const pool = items.filter((it) => scopeOf(it, scope));
  const own = (ids: string[]) => new Set(pool.filter((it) => it.categoryIds.some((id) => ids.includes(id))).map((it) => it.url)).size;
  const fixed: Array<[string, string, string, string[]]> = [
    ["role", "角色", "user", ["角色", "characters", "character", "role"]],
    ["scene", "场景", "image", ["场景", "scenes", "scene"]],
    ["prop", "道具", "cube", ["道具", "props", "prop"]],
    ["style", "风格", "palette", ["风格", "styles", "style"]],
    ["sound", "音效", "audio", ["音效", "audio", "sounds", "sound"]],
  ];
  const rows: FolderRow[] = []; const used = new Set<string>();
  const assetCats = cats.filter((c) => c.kind === "asset");
  const localCats = cats.filter((c) => c.kind === "local" && c.id !== "local:all");
  const addChildren = (parentCatId: string, parentKey: string, depth: number) => {
    for (const c of assetCats) {
      if (used.has(c.id)) continue;
      const pid = String((c as GCat & { parent_id?: string }).parent_id || "");
      if (pid !== parentCatId) continue;
      const ids = [c.id]; const row: FolderRow = { key: "folder:custom:" + c.id, name: c.name, icon: "folder", count: own(ids), ids, assetId: c.id.replace(/^asset:/, ""), parentKey, depth };
      used.add(c.id); rows.push(row); addChildren(c.id, row.key, depth + 1);
    }
  };
  for (const [key, name, icon, needles] of fixed) {
    // 只按顶级分类归并；有 parent_id 的子文件夹（如「小道具」）留给 parentKey 正常挂载
    const match = matchFixedFolders(scope === "personal" ? assetCats : localCats, needles);
    match.forEach((c) => used.add(c.id));
    const ids = match.map((c) => c.id);
    const primary = match.find((c) => c.kind === "asset");
    const row: FolderRow = { key: "folder:" + key, name, icon: icon as FolderRow["icon"], count: own(ids), ids, assetId: primary?.id.replace(/^asset:/, ""), depth: 0 };
    rows.push(row);
    if (primary) addChildren(primary.id, row.key, 1);
  }
  for (const c of scope === "personal" ? assetCats : localCats) {
    if (used.has(c.id)) continue;
    const pid = String((c as GCat & { parent_id?: string }).parent_id || "");
    if (pid) continue;
    const ids = [c.id]; const row: FolderRow = { key: "folder:custom:" + c.id, name: c.name, icon: "folder", count: own(ids), ids, assetId: c.kind === "asset" ? c.id.replace(/^asset:/, "") : undefined, depth: 0 };
    used.add(c.id); rows.push(row);
    if (c.kind === "asset") addChildren(c.id, row.key, 1);
  }
  // 父级缺失的孤儿分类按顶级展示，避免后端还没上线 parent_id 时丢项
  for (const c of scope === "personal" ? assetCats : localCats) {
    if (used.has(c.id)) continue;
    const ids = [c.id]; used.add(c.id);
    rows.push({ key: "folder:custom:" + c.id, name: c.name, icon: "folder", count: own(ids), ids, assetId: c.kind === "asset" ? c.id.replace(/^asset:/, "") : undefined, depth: 0 });
  }
  const otherIds = (scope === "personal" ? assetCats : localCats).map((c) => c.id).filter((id) => !used.has(id));
  const otherCount = own(otherIds);
  rows.push({ key: "folder:other", name: "Others", icon: "folder", count: otherCount, ids: otherIds, depth: 0 });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const r of rows) { r.total = r.count; }
  for (const r of rows) {
    let p = r.parentKey; const seen = new Set<string>();
    while (p && !seen.has(p)) { seen.add(p); const row = byKey.get(p); if (!row) break; row.total = (row.total || 0) + r.count; p = row.parentKey; }
  }
  for (const r of rows) { r.hasChildren = rows.some((x) => x.parentKey === r.key); }
  return rows;
}

type FolderRowProps = {
  f: FolderRow; active: boolean;
  onEnter: (f: FolderRow) => void; onBack: () => void; onContext: (f: FolderRow, e: MouseEvent) => void;
};
/** 文件夹行（列表扁平/进入后的子文件夹共用）：单击整行 = 直接进入，Enter 进入，← 返回上一级 */
function FolderRowView({ f, active, onEnter, onBack, onContext }: FolderRowProps) {
  const key = (e: ReactKeyboardEvent) => {
    const intent = rowKeyIntent(e.key);
    if (!intent) return;
    e.preventDefault(); e.stopPropagation();
    if (intent === "enter") onEnter(f); else onBack();
  };
  return <div role="button" tabIndex={0}
    data-folder-name={f.name} data-folder-id={f.ids.find((id) => id.startsWith("asset:"))?.slice(6) || ""}
    title="单击进入文件夹"
    className={"lib-row" + (active ? " on" : "")}
    onClick={() => onEnter(f)} onKeyDown={key} onContextMenu={(e) => onContext(f, e)}>
    <Icon name={f.icon} size="s" />
    <span className="lib-name">{f.name}</span>
    <em>{f.count}{f.total && f.total !== f.count ? <small> / {f.total}</small> : null}</em>
  </div>;
}

export function LibrarySection({ q }: { q: string }) {
  const ctl = useCtl(); const cmd = cmdOf();
  const [items, setItems] = useState<GItem[]>([]); const [cats, setCats] = useState<GCat[]>([]);
  const [scope, setScope] = useState<"personal" | "local">("personal");
  const [active, setActive] = useState("all"); const [query, setQuery] = useState(q || "");
  const [folderKey, setFolderKey] = useState<string | null>(null); const [lastOpened, setLastOpened] = useState<string | null>(null);
  const scrollPos = useRef(0);
  const [busy, setBusy] = useState(true); const [err, setErr] = useState(""); const [tick, setTick] = useState(0);
  const [offset, setOffset] = useState(0); const [hasMore, setHasMore] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [visible, setVisible] = useState(PAGE); const sentinel = useRef<HTMLDivElement>(null); const [selected, setSelected] = useState<string | null>(null);
  const offsetRef = useRef(PAGE); const refreshTimer = useRef<number | null>(null); const [libId, setLibId] = useState("default");
  useEffect(() => { if (!cmd) return; void cmd({ type: "canvas/assetLibrary/list" }).then((r) => { const id = r?.ok && r.libraries?.[0]?.id; if (id) setLibId(String(id)); }).catch(() => undefined); }, [cmd]);
  useEffect(() => {
    if (!cmd) { setBusy(false); return; }
    setBusy(true); setErr("");
    // 每次打开抽屉都强制拉一次最新：抽屉关着时存进去的素材（收不到 ws 广播）重开也要立刻可见
    void cmd({ type: "canvas/globalAssets", limit: PAGE, refresh: true }).then((r) => {
      if (!r || !r.ok) throw new Error(String(r?.error || "读取素材库失败"));
      setItems(Array.isArray(r.items) ? r.items : []); setCats(Array.isArray(r.categories) ? applyLocalParents(r.categories) : []);
      offsetRef.current = PAGE; setOffset(PAGE); setHasMore(!!r.hasMore); setVisible(PAGE);
    }).catch((e) => setErr(e instanceof Error ? e.message : "读取素材库失败")).finally(() => setBusy(false));
  }, [cmd, tick]);
  useEffect(() => { offsetRef.current = offset; }, [offset]);
  const refreshAssets = useCallback(async () => {
    if (!cmd) return;
    const limit = Math.max(offsetRef.current, PAGE);
    const r = await cmd({ type: "canvas/globalAssets", limit, refresh: true }).catch(() => null);
    if (!r || !r.ok) return;
    setItems(Array.isArray(r.items) ? r.items : []); setCats(Array.isArray(r.categories) ? applyLocalParents(r.categories) : []);
    setHasMore(!!r.hasMore); offsetRef.current = limit; setOffset(limit);
  }, [cmd]);
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
  useEffect(() => { setVisible(PAGE); setActive("all"); }, [scope]);
  useEffect(() => {
    const d = sentinel.current?.closest(".dbody") as HTMLElement | null; if (!d) return;
    if (folderKey) d.scrollTop = 0;
    else requestAnimationFrame(() => { d.scrollTop = scrollPos.current; });
  }, [folderKey]);
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
  const folders = useMemo(() => folderRows(items, cats, scope), [items, cats, scope]);
  // 列表扁平：只列顶级文件夹，子文件夹只在进入后的视图顶部出现（不再就地展开子项）
  const topFolders = useMemo(() => folders.filter((f) => !f.parentKey), [folders]);
  const favoriteCount = 0; const subjectCount = new Set(scoped.filter((it) => it.categoryIds.some((id) => id.startsWith("asset:"))).map((it) => it.url)).size;
  const folder = folders.find((f) => f.key === folderKey) || null;
  const childFolders = folder ? folders.filter((f) => f.parentKey === folder.key) : [];
  const activeIds = folder?.ids || [];
  const shown = useMemo(() => {
    if (folder) return filterLibraryItems(scoped.filter((it) => it.categoryIds.some((id) => activeIds.includes(id))), "all", query);
    if (active === "favorite") return [];
    if (active === "subject") return filterLibraryItems(scoped.filter((it) => it.categoryIds.some((id) => id.startsWith("asset:"))), "all", query);
    return filterLibraryItems(scoped, "all", query);
  }, [scoped, folder, activeIds, active, query]);
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
  const close = () => { setFolderKey(null); ctl.store.setUI({ drawer: null }); };
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
  const enterFolder = (f: FolderRow) => {
    const d = sentinel.current?.closest(".dbody") as HTMLElement | null;
    scrollPos.current = d?.scrollTop || 0;
    setActive("all"); setLastOpened(f.key); setFolderKey(f.key); setVisible(PAGE);
  };
  const back = () => { const cur = folders.find((f) => f.key === folderKey); setFolderKey(cur?.parentKey || null); };
  const createFolder = (parentId?: string, label = "新建文件夹") => openModal((cl) => <FolderNameDialog title={label} initial="" onClose={cl} onSave={async (name) => {
    if (!cmd) return "桌面版不可用";
    const r = await cmd({ type: "canvas/assetLibrary/folderCreate", libraryId: libId, name, parentId }).catch(() => null);
    if (!r || !r.ok) return String(r?.detail || r?.error || "新建失败");
    if (parentId && r.folder?.id) localParents.set("asset:" + r.folder.id, "asset:" + parentId);
    await refreshAssets(); return null;
  }} />, "folder-dialog-modal");
  const renameFolder = (f: FolderRow) => openModal((cl) => <FolderNameDialog title="重命名文件夹" initial={f.name} onClose={cl} onSave={async (name) => {
    if (!cmd) return "桌面版不可用";
    const r = await cmd({ type: "canvas/assetLibrary/folderRename", libraryId: libId, categoryId: f.assetId || undefined, from: f.name, to: name }).catch(() => null);
    if (!r || !r.ok) return String(r?.detail || r?.error || "重命名失败");
    await refreshAssets(); return null;
  }} />, "folder-dialog-modal");
  const deleteFolder = (f: FolderRow) => openModal((cl) => <DeleteFolderDialog name={f.name} count={f.total || f.count} children={folders.filter((x) => x.parentKey === f.key).length} onClose={cl} onConfirm={async () => {
    if (!cmd) return "桌面版不可用";
    const id = f.assetId; if (!id) return "这个文件夹没有对应的后端分类";
    const r = await cmd({ type: "canvas/assetLibrary/folderDelete", libraryId: libId, categoryId: id }).catch(() => null);
    if (!r || !r.ok) return String(r?.detail || r?.error || "删除失败");
    if (folderKey === f.key) setFolderKey(null);
    await refreshAssets(); ctl.store.toast("已删除文件夹「" + f.name + "」"); return null;
  }} />, "folder-dialog-modal");
  const folderMenu = (f: FolderRow, e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); setLastOpened(f.key);
    openPop({ x: e.clientX, y: e.clientY }, (cl) => <>
      <div className="mh">{f.name}</div>
      <button className="mi" onClick={() => { cl(); renameFolder(f); }}><Icon name="pencil" size="s" />重命名</button>
      <button className="mi danger" onClick={() => { cl(); deleteFolder(f); }}><Icon name="trash" size="s" />删除文件夹</button>
    </>, "down", "left");
  };
  return <div className="lib-shell">
    <div className="lib-head"><button className="ib" aria-label={folder ? "返回文件夹列表" : "返回"} onClick={folder ? back : close}><Icon name="left" size="s" /></button><b>{folder ? folder.name + " · " + folder.count + " 个素材" + (folder.total && folder.total !== folder.count ? "（合计 " + folder.total + "）" : "") : "素材库"}</b><span className="sp" />{!folder ? <button className="lib-ai" data-lib-ai onClick={() => openCharacterLibrary(ctl)}><Icon name="user" size="xs" />AI 角色</button> : null}<button className="ib" aria-label="上传或新建" onClick={upload}><Icon name="plus" size="s" /></button></div>
    {!folder ? <><div className="lib-scope"><button className={scope === "personal" ? "on" : ""} onClick={() => setScope("personal")}>个人</button><button className={scope === "local" ? "on" : ""} onClick={() => setScope("local")}>本地</button></div>
    <div className="lib-search"><Icon name="search" size="xs" /><input value={query} placeholder="搜索素材、提示词" onChange={(e) => setQuery(e.target.value)} /><AnimateIcon asChild><button className="ib" aria-label="刷新" onClick={() => setTick((t) => t + 1)}><Icon name="history" size="xs" /></button></AnimateIcon></div>
    <button className={"lib-row" + (active === "favorite" ? " on" : "")} onClick={() => setActive("favorite")}><Icon name="star" size="s" /><span>收藏</span><em>{favoriteCount}</em></button>
    <button className={"lib-row" + (active === "subject" ? " on" : "")} onClick={() => setActive("subject")}><Icon name="layers" size="s" /><span>主体库</span><em>{subjectCount}</em></button>
    <div className="lib-section-title"><span>文件夹</span></div>
    <div className="lib-folder-list">{topFolders.map((f) => <FolderRowView key={f.key} f={f} active={lastOpened === f.key} onEnter={enterFolder} onBack={back} onContext={folderMenu} />)}{scope === "personal" ? <button className="lib-row lib-newfolder" onClick={() => createFolder()}><Icon name="plus" size="s" /><span>新建文件夹</span></button> : null}</div></> : <div className="lib-search"><Icon name="search" size="xs" /><input autoFocus value={query} placeholder={"搜索「" + folder.name + "」"} onChange={(e) => setQuery(e.target.value)} /><button className="ib" aria-label="返回上一级" onClick={back}><Icon name="left" size="xs" /></button></div>}
    {folder ? <div className="lib-folder-list lib-subfolders">{childFolders.map((f) => <FolderRowView key={f.key} f={f} active={false} onEnter={enterFolder} onBack={back} onContext={folderMenu} />)}{folder.assetId ? <button className="lib-row lib-newfolder" onClick={() => createFolder(folder.assetId, "新建子文件夹")}><Icon name="plus" size="s" /><span>新建子文件夹</span></button> : null}</div> : null}
    {err ? <div className="lib-empty">{err}<button className="linkbtn" onClick={() => setTick((t) => t + 1)}>重试</button></div> : null}
    {busy && !items.length ? <div className="lib-empty">正在读取全局素材…</div> : null}
    {!folder && (active === "favorite" ? <div className="lib-empty">还没有收藏素材</div> : active === "subject" && !subjectCount ? <div className="lib-empty">主体库还没有素材</div> : null)}
    {folder && !shown.length && !busy ? <div className="lib-empty">这个文件夹还没有素材</div> : null}
    <div className="lib-drop-tip"><Icon name="upload" size="xs" /><span>{"把画布上的节点拖到这里存入素材库（按住 " + (IS_MAC ? "⌥" : "Alt") + " 也行）"}</span></div>
    <div className="agrid lib-grid">{shown.slice(0, visible).map((it) => <LibTile key={it.id + ":" + it.url} it={it} selected={selected === it.url} onSelect={() => setSelected(it.url)} onPreview={() => preview(it)} onMenu={(e) => menu(it, e)} />)}
      {!shown.length && !busy && !folder && active !== "favorite" ? <span className="lg-dim" style={{ gridColumn: "1/-1" }}>{items.length ? "这个分类下还没有素材" : "素材库是空的"}</span> : null}
    </div>
    <div ref={sentinel} className="lib-sentinel" />{loadingMore ? <div className="lib-empty">正在加载更多…</div> : shown.length > visible ? <div className="lib-empty">继续下滑加载更多</div> : null}
  </div>;
}

function FolderNameDialog({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(initial); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const save = async () => { const v = name.trim(); if (!v) { setErr("请输入文件夹名称"); return; } setBusy(true); const e = await onSave(v); setBusy(false); if (e) setErr(e); else onClose(); };
  return <div className="folder-dialog"><div className="fd-head"><b>{title}</b><button className="ib" aria-label="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
    <input autoFocus value={name} placeholder="文件夹名称" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
    {err ? <div className="fd-err">{err}</div> : null}
    <div className="fd-foot"><button className="btn" onClick={onClose}>取消</button><button className="btn solid" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div>
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
  const thumb = thumbOf(it);
  return <div className={"a" + (selected ? " sel" : "") + (it.kind === "prompt" ? " txt" : "")} title={[it.name, it.canvas_title].filter(Boolean).join(" · ")} onClick={(e) => { e.stopPropagation(); onSelect(); }} onDoubleClick={(e) => { e.stopPropagation(); onPreview(); }} onContextMenu={onMenu} draggable onDragStart={(e) => { (window as unknown as { __novaiLibDrag?: GItem }).__novaiLibDrag = it; try { e.dataTransfer?.setData("text/plain", it.url); } catch { /* ignore */ } }} onDragEnd={() => { (window as unknown as { __novaiLibDrag?: GItem }).__novaiLibDrag = undefined; }}>
    {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" /> : it.kind === "video" ? <Icon name="video" /> : it.kind === "audio" ? <Icon name="audio" /> : <span className="atext"><Icon name={it.kind === "prompt" ? "pencil" : "image"} size="xs" />{it.name}</span>}
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