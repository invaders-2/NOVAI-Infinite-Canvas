/**
 * 素材抽屉里的「资源库 / 我的资产库 / 团队资产库」。
 *   资源库      canvas/libraryList：OpenArc 资源库里画布可引用的图片（含生成结果），点一下放到画布
 *   资产库      canvas/assetLibrary/list + get：个人（PRIVATE）与团队共享的资产库；图片 / 视频放成素材节点，提示词放成文本节点
 *   上传        canvas/assetLibrary/import 存进当前资产库（团队库即对团队成员可见）
 * 节点右键「存入资产库」也走 import（见 saveNodeToLibrary）。
 */
import { useEffect, useMemo, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { replaceNodeMedia } from "../actions";
import { genOf, outOf, uid, type GenKind } from "../model";
import { useCtl, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { openPop } from "./overlay";
import { useAssetUrl } from "./useAsset";

type Lib = { id: string; name: string; visibility?: string; access?: string; itemCount?: number };
type Folder = { name: string; count: number; custom?: boolean };
type Item = { id: string; group?: string; kind?: string; title?: string; prompt?: string; mediaKind?: string; media?: { kind?: string; mime?: string }; coverRef?: string; resourceRef?: string; previewUrl?: string; url?: string };
type Res = { ref: string; name?: string; mimeType?: string; thumbnail?: string };
type Cmd = (r: Record<string, unknown>) => Promise<Record<string, any>>;

const cmdOf = (): Cmd | null => { const c = (window as unknown as { openarc?: { canvas?: { command?: Cmd } } }).openarc?.canvas?.command; return typeof c === "function" ? c : null; };
const isPersonal = (l: Lib) => l.access === "owner" && String(l.visibility || "").toUpperCase() === "PRIVATE";
const refOf = (it: Item) => { const r = it.resourceRef || it.coverRef || it.url || it.previewUrl || ""; return r && !/^(openarc-asset:|data:|https?:)/.test(r) ? "openarc-asset:" + r.replace(/^openarc-resource:/, "") : r; };
const mediaOf = (it: Item): "image" | "video" | "audio" | null => { const k = String(it.mediaKind || it.media?.kind || it.kind || ""); if (it.kind === "prompt") return null; return /video/.test(k) ? "video" : /audio/.test(k) ? "audio" : /image|asset|character|scene|prop|style/.test(k) || refOf(it) ? "image" : null; };

function place(ctl: Ctl, kind: GenKind, title: string, out: { url?: string; text?: string; w?: number; h?: number }) {
  const store = ctl.store;
  // 替换模式：素材库点一个素材 → 替换目标节点的当前版本（不新增节点）
  const target = store.state.ui.replace;
  if (target && store.node(target) && out.url) { replaceNodeMedia(store, target, { url: out.url, w: out.w, h: out.h }); store.setUI({ replace: null }); return; }
  const c = ctl.center();
  const n = store.newNode(kind, c.x - 120, c.y - 120, { title, uploaded: kind !== "text", manual: kind === "text", hist: [out] });
  store.addNodes([n], [], { select: true }); store.toast("已放到画布中央");
}

export function LibrarySection({ q }: { q: string }) {
  const ctl = useCtl(); const store = ctl.store;
  const [tab, setTab] = useState<"res" | "mine" | "team">("res");
  const [libs, setLibs] = useState<Lib[] | null>(null); const [items, setItems] = useState<Item[]>([]); const [res, setRes] = useState<Res[]>([]);
  const [libId, setLibId] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [tick, setTick] = useState(0);
  // 文件夹（TapNow 素材库文件夹）：资产库条目的 group；「全部」不过滤，「未分组」是没有 group 的条目
  const [folders, setFolders] = useState<Folder[]>([]); const [folder, setFolder] = useState("全部");
  const cmd = cmdOf();
  useEffect(() => { if (!cmd) return; void cmd({ type: "canvas/assetLibrary/list" }).then((r) => setLibs(r && r.ok ? (r.libraries || []) : [])).catch(() => setLibs([])); }, [cmd, tick]);
  const pool = useMemo(() => (libs || []).filter((l) => (tab === "team" ? !isPersonal(l) : isPersonal(l))), [libs, tab]);
  useEffect(() => { if (tab !== "res" && pool.length && !pool.some((l) => l.id === libId)) setLibId(pool[0].id); }, [pool, tab, libId]);
  useEffect(() => {
    if (!cmd) return; setErr("");
    if (tab === "res") { setBusy(true); void cmd({ type: "canvas/libraryList", limit: 60, query: q }).then((r) => setRes(r && r.ok ? (r.items || []) : [])).catch(() => setErr("读取资源库失败")).finally(() => setBusy(false)); return; }
    if (!libId) { setItems([]); return; }
    void cmd({ type: "canvas/assetLibrary/folderList", libraryId: libId }).then((r) => setFolders(r && r.ok ? (r.folders || []) : [])).catch(() => setFolders([]));
    setBusy(true); void cmd({ type: "canvas/assetLibrary/get", libraryId: libId }).then((r) => { if (!r || !r.ok) throw new Error(String(r?.error || "")); setItems(r.items || []); }).catch(() => setErr("读取资产库失败")).finally(() => setBusy(false));
  }, [cmd, tab, libId, q, tick]);
  useEffect(() => { setFolder("全部"); }, [libId, tab]);
  if (!cmd) return <div className="sec"><span>资源库</span><span className="lg-dim">桌面版可用</span></div>;
  const inFolder = (it: Item) => folder === "全部" || (folder === "未分组" ? !it.group || it.group === "未分组" : it.group === folder);
  const shown = tab === "res" ? [] : items.filter((it) => inFolder(it) && it.kind !== "character" && (!q || [it.title, it.prompt].join(" ").includes(q)));
  const newFolder = (anchor: Element) => openPop(anchor, (close) => <FolderName title="新建文件夹" onDone={async (name) => {
    const r = await cmd({ type: "canvas/assetLibrary/folderCreate", libraryId: libId, name }).catch(() => null);
    if (!r || !r.ok) return r?.detail === "folder-exists" || r?.error === "CONFLICT" ? "已经有这个文件夹了" : "新建失败";
    close(); setFolder(name); setTick((t) => t + 1); return null;
  }} />);
  const folderMenu = (name: string, anchor: Element) => openPop(anchor, (close) => <FolderName title="重命名文件夹" init={name} onDone={async (to) => {
    const r = await cmd({ type: "canvas/assetLibrary/folderRename", libraryId: libId, from: name, to }).catch(() => null);
    if (!r || !r.ok) return r?.error === "CONFLICT" ? "已经有这个文件夹了" : "重命名失败";
    close(); setFolder(to); setTick((t) => t + 1); return null;
  }} />);
  const moveItem = (it: Item, anchor: Element) => openPop(anchor, (close) => <>
    <div className="mh">移动到文件夹</div>
    {["未分组", ...folders.map((f) => f.name)].map((name) => <button key={name} className={"mi" + ((it.group || "未分组") === name ? " on" : "")} data-move={name} onClick={() => { close(); void cmd({ type: "canvas/assetLibrary/folderMove", libraryId: libId, itemId: it.id, folder: name === "未分组" ? "" : name }).then((r) => { if (r && r.ok) { setTick((t) => t + 1); store.toast(`已移到「${name}」`); } else store.toast("移动失败"); }); }}><Icon name="folder" size="s" />{name}</button>)}
  </>);
  const upload = () => {
    if (!libId) return store.toast("先选一个资产库");
    const fi = document.createElement("input"); fi.type = "file"; fi.accept = "image/*,video/*,audio/*"; fi.multiple = true;
    fi.onchange = async () => {
      for (const f of [...(fi.files || [])]) {
        const dataUrl = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || "")); r.onerror = () => no(new Error("读取失败")); r.readAsDataURL(f); });
        const r = await cmd({ type: "canvas/assetLibrary/import", libraryId: libId, name: f.name, mime: f.type || "image/png", dataUrl }).catch(() => null);
        if (!r || !r.ok) { store.toast("上传失败：" + String(r?.error || "未知错误")); break; }
      }
      setTick((t) => t + 1); store.toast("已存入资产库");
    };
    fi.click();
  };
  return <>
    <div className="sec"><span>资源库</span>{busy ? <i className="spn" /> : null}</div>
    <div className="tabs lib-tabs">{([["res", "资源库"], ["mine", "我的资产库"], ["team", "团队资产库"]] as const).map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab !== "res" ? <div className="lib-bar">
      {pool.length > 1 ? <button className="pill" onClick={(e) => openPop(e.currentTarget, (close) => <>{pool.map((l) => <button key={l.id} className={"mi" + (l.id === libId ? " on" : "")} onClick={() => { close(); setLibId(l.id); }}>{l.name}<span className="k tnum">{l.itemCount ?? ""}</span></button>)}</>)}>{pool.find((l) => l.id === libId)?.name || "选择资产库"}<Icon name="down" size="xs" /></button> : <span className="lg-dim">{pool[0]?.name || (tab === "team" ? "还没有加入团队资产库" : "还没有个人资产库")}</span>}
      <span className="grow" />{libId ? <button className="pill" onClick={upload}><Icon name="upload" size="xs" />上传</button> : null}
      {tab === "mine" && !pool.length ? <button className="pill" onClick={() => void cmd({ type: "canvas/assetLibrary/ensure" }).then(() => setTick((t) => t + 1))}>创建</button> : null}
    </div> : null}
    {tab !== "res" && libId ? <div className="tabs lib-folders" data-folder={folder}>
      {[["全部", items.filter((it) => it.kind !== "character").length], ["未分组", items.filter((it) => it.kind !== "character" && (!it.group || it.group === "未分组")).length], ...folders.filter((f) => f.name !== "AI 角色").map((f) => [f.name, f.count] as const)].map(([name, n]) => <button key={name} className={folder === name ? "on" : ""} data-f={name} onClick={() => setFolder(String(name))} onDoubleClick={(e) => { if (name !== "全部" && name !== "未分组") folderMenu(String(name), e.currentTarget); }}><Icon name="folder" size="xs" />{name}<span className="tnum">{n}</span></button>)}
      <button className="ib" aria-label="新建文件夹" data-newfolder onClick={(e) => newFolder(e.currentTarget)}><Icon name="plus" size="xs" /></button>
    </div> : null}
    {err ? <div className="lg-dim" style={{ padding: "4px 0" }}>{err}</div> : null}
    {tab === "res" ? <div className="agrid">{res.map((r) => <ResTile key={r.ref} r={r} onUse={() => place(ctl, /video/.test(r.mimeType || "") ? "video" : "image", r.name || "素材", { url: r.ref })} />)}{!res.length && !busy ? <span className="lg-dim" style={{ gridColumn: "1/-1" }}>资源库里还没有可用的图片</span> : null}</div>
      : <div className="agrid">{shown.map((it) => <ItemTile key={it.id} it={it} onMove={(el) => moveItem(it, el)} onUse={() => { const m = mediaOf(it); if (m) place(ctl, m, it.title || "素材", { url: refOf(it) }); else place(ctl, "text", it.title || "提示词", { text: it.prompt || it.title || "" }); }} />)}{!shown.length && !busy ? <span className="lg-dim" style={{ gridColumn: "1/-1" }}>这个资产库是空的</span> : null}</div>}
  </>;
}
function ResTile({ r, onUse }: { r: Res; onUse: () => void }) { return <div className="a" title={r.name} onClick={onUse}>{r.thumbnail ? <img src={r.thumbnail} alt="" /> : <Icon name="image" />}</div>; }
function FolderName({ title, init = "", onDone }: { title: string; init?: string; onDone: (name: string) => Promise<string | null> }) {
  const [v, setV] = useState(init); const [err, setErr] = useState("");
  const go = async () => { const name = v.trim(); if (!name || name === "全部" || name === "未分组") { setErr("换个名字"); return; } setErr((await onDone(name)) || ""); };
  return <div className="fname"><div className="mh">{title}</div><input autoFocus value={v} maxLength={60} placeholder="文件夹名称" onChange={(e) => { setV(e.target.value); setErr(""); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.nativeEvent.isComposing) void go(); }} />{err ? <small>{err}</small> : null}<button className="btn solid" onClick={() => void go()}>确定</button></div>;
}
function ItemTile({ it, onUse, onMove }: { it: Item; onUse: () => void; onMove: (anchor: Element) => void }) {
  const m = mediaOf(it); const url = useAssetUrl(m === "image" ? (it.previewUrl && it.previewUrl.startsWith("data:") ? it.previewUrl : refOf(it)) : "");
  return <div className={"a" + (m ? "" : " txt")} title={it.title || ""} onClick={onUse}>{url ? <img src={url} alt="" /> : m === "video" ? <Icon name="video" /> : m === "audio" ? <Icon name="audio" /> : <span className="atext"><Icon name="text" size="xs" />{it.title || "提示词"}</span>}
    <button className="amove" aria-label="移动到文件夹" title="移动到文件夹" onClick={(e) => { e.stopPropagation(); onMove(e.currentTarget); }}><Icon name="folder" size="xs" /></button></div>;
}

/** 节点右键「存入资产库」：图片 / 视频 / 音频结果，或文本节点的内容（存成提示词） */
/** 把一个节点的当前结果存进指定资产库；返回失败原因（成功返回 null） */
async function saveOne(cmd: Cmd, store: Ctl["store"], lib: Lib, n: CanvasNode): Promise<string | null> {
  const g = genOf(n); const o = outOf(n);
  if (n.kind === "text") { const x = await cmd({ type: "canvas/assetLibrary/upsert", libraryId: lib.id, item: { kind: "prompt", title: g.title, prompt: o?.text || g.prompt } }).catch(() => null); return x && x.ok ? null : String(x?.error || "存入失败"); }
  if (!o?.url) return "还没有结果";
  const dataUrl = o.url.startsWith("data:") ? o.url : await store.backend.resolveAsset(o.url);
  if (!dataUrl || !dataUrl.startsWith("data:")) return "读取素材失败";
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "image/png";
  const x = await cmd({ type: "canvas/assetLibrary/import", libraryId: lib.id, name: g.title + "." + (mime.split("/")[1] || "png"), title: g.title, mime, dataUrl }).catch(() => null);
  return x && x.ok ? null : String(x?.error || "存入失败");
}
async function pickLibrary(cmd: Cmd, anchor: { x: number; y: number } | Element, then: (lib: Lib) => void) {
  const r = await cmd({ type: "canvas/assetLibrary/list" }).catch(() => null); const libs: Lib[] = r && r.ok ? r.libraries || [] : [];
  if (!libs.length) { const e = await cmd({ type: "canvas/assetLibrary/ensure" }).catch(() => null); if (e && e.ok && e.library) libs.push(e.library); }
  if (!libs.length) return false;
  if (libs.length === 1) { then(libs[0]); return true; }
  openPop(anchor, (close) => <><div className="mh">存入哪个资产库</div>{libs.map((l) => <button key={l.id} className="mi" onClick={() => { close(); then(l); }}><Icon name={isPersonal(l) ? "user" : "layers"} size="s" />{l.name}<span className="k">{isPersonal(l) ? "个人" : "团队"}</span></button>)}</>);
  return true;
}

export async function saveNodeToLibrary(ctl: Ctl, n: CanvasNode, anchor: { x: number; y: number }) {
  const cmd = cmdOf(); const store = ctl.store; if (!cmd) return store.toast("资产库只在桌面版里可用");
  const ok = await pickLibrary(cmd, anchor, (lib) => { void saveOne(cmd, store, lib, n).then((err) => store.toast(err ? (err === "还没有结果" ? "这个节点还没有结果" : "存入失败：" + err) : `已存入「${lib.name}」${isPersonal(lib) ? "" : "，团队成员都能用"}`)); });
  if (!ok) store.toast("没有可用的资产库");
}

/** 多个节点一次存进同一个资产库（堆叠 / 多选「存素材库」） */
export async function saveNodesToLibrary(ctl: Ctl, nodes: CanvasNode[], anchor: { x: number; y: number } | Element) {
  const cmd = cmdOf(); const store = ctl.store; if (!cmd) return store.toast("资产库只在桌面版里可用");
  const list = nodes.filter((n) => outOf(n)?.url || outOf(n)?.text);
  if (!list.length) return store.toast("选中的节点还没有结果");
  const ok = await pickLibrary(cmd, anchor, (lib) => { void (async () => {
    let done = 0; const fails: string[] = [];
    for (const n of list) { const err = await saveOne(cmd, store, lib, n); if (err) fails.push(genOf(n).title); else done++; }
    store.toast(`已存入「${lib.name}」${done} 个${fails.length ? `，${fails.length} 个失败（${fails.slice(0, 3).join("、")}）` : ""}`, fails.length ? 6000 : 2600);
  })(); });
  if (!ok) store.toast("没有可用的资产库");
}
export { uid };
