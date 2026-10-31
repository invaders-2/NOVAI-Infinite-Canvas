/** 添加节点 / 右键 / ⊕ 端口菜单，以及节点内按钮动作 */
import { plainPrompt } from "../mentions";
import { createElementFrom, elementRefsOf } from "./Elements";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { addFiles, alignSelection, connect, copySelection, deleteSelection, duplicate, extractCurrentVersion, hasClip, paste, spreadHistory, title } from "../actions";
import { runChain, runNode } from "../engine";
import { genOf, inputsOf, isGenKind, outOf, trimIsFull, trimLabel, TYPE_ICON, uid, type GenKind, NODE_DEFAULT_SIZE } from "../model";
import { emptyTable, withTable } from "../table";
import type { Ctl } from "./ctx";
import type { CanvasStore } from "../store";
import { Icon } from "./Icon";
import { openPop } from "./overlay";
import { groupSelection, LEGACY_DEFAULT, ungroup } from "./LegacyNodes";
import { saveNodeToLibrary } from "./Library";
import { blobToBase64, shortenPath } from "../exportCanvas";
import { isStack, stackItems, stackSelection, unstack } from "../stack";
import { groupLabel, runNodes, saveAsTemplate } from "./StackNode";
import { makeZip } from "../zip";

type At = Element | { x: number; y: number };
const ITEMS: Array<[GenKind | "table", string, string]> = [["text", "文本", "脚本、广告词、品牌文案"], ["image", "图片", "宣传图、海报、封面"], ["video", "视频", "宣传视频、动画、电影"], ["audio", "音频", "音乐、配音、音效"], ["table", "多维表格", "逐行批量：一行一条生成任务"]];
const iconOf = (t: GenKind | "table") => (t === "table" ? "grid" : TYPE_ICON[t]);

export function createAt(ctl: Ctl, t: GenKind | "table", at: { x: number; y: number }, fromId: string | null = null): CanvasNode {
  const store = ctl.store;
  const n = t === "table" ? withTable({ id: uid("t"), kind: "table", x: Math.round(at.x - 210), y: Math.round(at.y - 40), w: 420, h: 220, text: "多维表格" }, emptyTable()) : store.newNode(t, at.x - (t === "text" ? 140 : 120), at.y - 40);
  store.addNodes([n], [], { select: true });
  if (fromId) connect(store, fromId, n.id, { quiet: true });
  if (t !== "table") ctl.focusPrompt();
  return store.node(n.id)!;
}

/** 辅助节点（3D / 时间线 / 片场 / 便签）：数据结构沿用旧版 CanvasDoc */
export function createLegacy(ctl: Ctl, kind: "model3d" | "timeline" | "scene3d" | "note", at: { x: number; y: number }) {
  const d = LEGACY_DEFAULT[kind]; let x = Math.round(at.x - d.w / 2), y = Math.round(at.y - 40);
  // 不压在已有节点上：往下挪到空位
  const hit = () => ctl.store.state.doc.nodes.some((o) => o.kind !== "group" && x < o.x + o.w + 20 && x + d.w + 20 > o.x && y < o.y + o.h + 44 && y + d.h + 44 > o.y);
  for (let i = 0; i < 40 && hit(); i++) y += 60;
  const n = { id: uid("n"), kind, x, y, w: d.w, h: d.h, text: d.text, ...(kind === "timeline" ? { clips: [] } : {}) } as CanvasNode;
  ctl.store.addNodes([n], [], { select: true });
}

export function createImageEditor(ctl: Ctl, at: { x: number; y: number }) {
  const input = document.createElement("input"); input.type = "file"; input.accept = "image/*";
  input.onchange = () => { const file = input.files?.[0]; if (!file) return; void addFiles(ctl.store, [file], at).then(() => { const id = [...ctl.store.state.ui.sel][0]; if (id) window.dispatchEvent(new CustomEvent("cn:editor", { detail: { kind: "crop", id } })); }); };
  input.click();
}

export function addMenu(ctl: Ctl, anchor: At, at: { x: number; y: number }, fromId: string | null = null) {
  const store = ctl.store; const from = fromId ? store.node(fromId) : null;
  openPop(anchor, (close) => <>
    <div className="mh">添加节点{from ? ` · 自动连到「${title(from)}」` : ""}</div>
    {ITEMS.map(([t, l, d]) => <button key={t} className="mi" data-t={t} onClick={() => { close(); createAt(ctl, t, at, fromId); }}><span className="ic"><Icon name={iconOf(t)} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}
    {from ? null : <><div className="mh">辅助工具</div>
      {([["model3d", "3D", "文生 / 图生 3D 模型", "cube"], ["timeline", "剪辑时间线", "把视频 / 音频排成一条片子并导出", "video"], ["scene3d", "3D 片场", "摆放几何体和模型，调机位", "cube"], ["note", "便签", "随手记一段说明", "pencil"]] as const).map(([k, l, d, ic]) => <button key={k} className="mi" data-t={k} onClick={() => { close(); createLegacy(ctl, k, at); }}><span className="ic"><Icon name={ic} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}
      <button className="mi" data-t="image-editor" onClick={() => { close(); createImageEditor(ctl, at); }}><span className="ic"><Icon name="brush" size="s" /></span><span>图片编辑器<span className="d">选择图片后直接裁剪和编辑</span></span></button></>}
    {from ? null : <><div className="mh">添加资源</div><button className="mi" data-t="upload" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at } })); }}><span className="ic"><Icon name="upload" size="s" /></span><span>上传<span className="d">图片、视频、音频、文档，也可以直接拖进画布</span></span></button></>}
  </>);
}

export function portMenu(ctl: Ctl, n: CanvasNode, side: "in" | "out", at: { x: number; y: number }) {
  const store = ctl.store;
  const types = ITEMS.filter(([t]) => (side === "out" ? !(t === "image" && n.kind === "audio") : !(n.kind === "image" && t === "audio")) && !(side === "in" && t === "table" && n.kind === "table"));
  const make = (t: GenKind | "table") => {
    const sz = t === "table" ? { w: 420, h: 220 } : NODE_DEFAULT_SIZE[t]; const w = sz.w; const h = sz.h;
    const x = side === "out" ? n.x + n.w + 120 : n.x - w - 120; let y = n.y + (n.h - h) / 2;
    // 同一侧已经有节点时往下避让，不叠在一起（先后从同一个 ⊕ 拉出多个节点）
    const hit = (yy: number) => store.state.doc.nodes.some((o) => o.x < x + w + 30 && o.x + o.w + 30 > x && o.y < yy + h + 56 && o.y + o.h + 56 > yy);
    for (let i = 0; i < 40 && hit(y); i++) y += 40;
    const c = createAt(ctl, t, { x: x + (t === "text" ? 140 : t === "table" ? 210 : 120), y: y + 40 });
    if (t !== "table" && (c.x !== x || c.y !== y)) store.updateNode(c.id, (q) => ({ ...q, x, y })); // 按算好的空位落位（各类型默认宽度不同）
    side === "out" ? connect(store, n.id, c.id, { quiet: true, select: true }) : connect(store, c.id, n.id, { quiet: true, select: false });
    store.setUI({ sel: new Set([c.id]) });
  };
  openPop(at, (close) => side === "out" ? <>
    <div className="mh">从「{title(n)}」继续生成</div>
    {types.map(([t, l, d]) => <button key={t} className="mi" data-t={t} onClick={() => { close(); make(t); }}><span className="ic"><Icon name={iconOf(t)} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}
    <div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>也可以按住 ⊕ 拖到其他节点上直接连线</span></div>
  </> : <>
    <div className="mh">给「{title(n)}」添加输入</div>
    <button className="mi" data-k="up" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: { x: n.x - 360, y: n.y + 120 }, linkTo: n.id } })); }}><span className="ic"><Icon name="upload" size="s" /></span><span>上传文件</span></button>
    <button className="mi" data-k="lib" onClick={() => { close(); store.setUI({ drawer: "assets" }); window.dispatchEvent(new CustomEvent("cn:lib-link", { detail: n.id })); }}><span className="ic"><Icon name="folder" size="s" /></span><span>从素材库选择</span></button>
    <button className="mi" data-k="pick" onClick={() => { close(); store.setUI({ sel: new Set([n.id]), pick: n.id }); store.toast("点画布上的节点，把它连成输入；Esc 结束"); }}><span className="ic"><Icon name="cursor" size="s" /></span><span>从画布选择</span></button>
    <div className="msep" />
    {types.map(([t, l]) => <button key={t} className="mi" data-t={t} onClick={() => { close(); make(t); }}><span className="ic"><Icon name={iconOf(t)} size="s" /></span><span>新建{l}节点<span className="d">作为第 {inputsOf(store.state.doc, n.id).length + 1} 个输入</span></span></button>)}
  </>);
}

export function nodeMenu(ctl: Ctl, at: { x: number; y: number }) {
  const store = ctl.store; const sel = [...store.state.ui.sel]; const n = store.node(sel[0]); if (!n) return; const multi = sel.length > 1;
  const gen = isGenKind(n.kind); const g = gen ? genOf(n) : null; const out = gen ? outOf(n) : null;
  openPop(at, (close) => {
    const act = (f: () => void) => () => { close(); f(); };
    return <>
      {/* 分组：资产 ┃ 版本 ┃ 运行 ┃ 编辑 ┃ 删除 ┃ 剪贴板（TapNow 的节点菜单也是按用途分组） */}
      <button className="mi" data-k="lib" disabled={!(n.kind === "image" && out)} onClick={act(() => { store.patchGen(n.id, { fav: true }); store.toast(`「${title(n)}」已收藏`); })}><Icon name="star" size="s" />收藏</button>
      <button className="mi" data-k="element" disabled={!elementRefsOf(ctl, sel.map((x) => store.node(x)).filter((x): x is CanvasNode => !!x)).length} onClick={act(() => createElementFrom(ctl, sel.map((x) => store.node(x)).filter((x): x is CanvasNode => !!x)))}><Icon name="user" size="s" />存为元素<span className="k">@ 引用</span></button>
      <button className="mi" data-k="assetlib" disabled={!gen || !(out?.url || out?.text)} onClick={act(() => void saveNodeToLibrary(ctl, n, at))}><Icon name="libadd" size="s" />存入资产库<span className="k">个人 / 团队</span></button>
      {multi || isStack(n) ? <button className="mi" data-k="dl" onClick={act(() => void downloadMany(sel.map((x) => store.node(x)).filter((x): x is CanvasNode => !!x), store))}><Icon name="download" size="s" />全部下载<span className="k">zip</span></button>
        : <button className="mi" data-k="dl" disabled={!out} onClick={act(() => void download(n, store))}><Icon name="download" size="s" />下载</button>}
      <div className="msep" />
      <button className="mi" data-k="extractver" disabled={!g || g.hist.length < 2} onClick={act(() => extractCurrentVersion(store, n.id))}><Icon name="copy" size="s" />提取当前版本<span className="k">{g && g.hist.length > 1 ? "第 " + (g.hi + 1) + " 版" : ""}</span></button>
      <button className="mi" data-k="allhist" disabled={!g || g.hist.length < 2} onClick={act(() => spreadHistory(store, n.id))}><Icon name="layers" size="s" />应用所有历史<span className="k">{g && g.hist.length > 1 ? g.hist.length + " 个版本" : ""}</span></button>
      <div className="msep" />
      {multi || n.kind === "group" ? <button className="mi" data-k="rungroup" onClick={act(() => runNodes(ctl, sel.map((x) => store.node(x)).filter((x): x is CanvasNode => !!x)))}><Icon name="play" size="s" />{multi ? "一键运行选中节点" : isStack(n) ? "一键运行堆叠" : "一键运行分组"}<span className="k">⌘↵</span></button> : null}
      {multi || n.kind === "group" ? <button className="mi" data-k="savetpl" onClick={act(() => { const ns = sel.map((x) => store.node(x)).filter((x): x is CanvasNode => !!x); saveAsTemplate(ctl, ns, multi ? store.state.name + " 模板" : groupLabel(n) + " 模板"); })}><Icon name="layout" size="s" />存为我的模板</button> : null}
      <button className="mi" data-k="runup" disabled={!gen} onClick={act(() => void runChain(store, n.id, "up"))}><Icon name="runup" size="s" />运行到此（含上游）</button>
      <button className="mi" data-k="rundown" onClick={act(() => void runChain(store, n.id, "down"))}><Icon name="rundown" size="s" />从此运行下游</button>
      <div className="msep" />
      <button className="mi" data-k="copy" onClick={act(() => copySelection(store))}><Icon name="copy" size="s" />复制<span className="k">⌘C</span></button>
      <button className="mi" data-k="paste" disabled={!hasClip()} onClick={act(() => paste(store))}><Icon name="copy" size="s" />粘贴<span className="k">⌘V</span></button>
      <button className="mi" data-k="dup" onClick={act(() => duplicate(store))}><Icon name="layers" size="s" />副本<span className="k">⌘D</span></button>
      {multi ? <button className="mi" data-k="group" onClick={act(() => groupSelection(store))}><Icon name="layers" size="s" />编组<span className="k">⌘G</span></button> : null}
      {multi ? <button className="mi" data-k="stack" onClick={act(() => stackSelection(store))}><Icon name="layers" size="s" />堆叠<span className="k">⇧S</span></button> : null}
      {isStack(n) ? <><button className="mi" data-k="stackopen" onClick={act(() => window.dispatchEvent(new CustomEvent("cn:stack", { detail: n.id })))}><Icon name="expand" size="s" />展开堆叠</button>
        <button className="mi" data-k="unstack" onClick={act(() => unstack(store, n.id))}><Icon name="split" size="s" />取消堆叠</button></>
        : n.kind === "group" ? <button className="mi" data-k="ungroup" onClick={act(() => ungroup(store, n.id))}><Icon name="layers" size="s" />取消分组<span className="k">⇧⌘G</span></button> : null}
      <div className="msep" />
      <button className="mi" data-k="clip" onClick={act(async () => { try { await navigator.clipboard.writeText(out?.text || (g?.prompt ? plainPrompt(g.prompt, store.state.doc) : "") || title(n)); store.toast("已复制到剪贴板"); } catch { store.toast("剪贴板不可用"); } })}><Icon name="copy" size="s" />复制到剪贴板</button>
      <div className="msep" />
      <button className="mi danger" data-k="del" onClick={act(() => deleteSelection(store))}><Icon name="trash" size="s" />删除{multi ? ` ${sel.length} 个` : ""}<span className="k">⌫, del</span></button>
    </>;
  });
}

export function blankMenu(ctl: Ctl, at: { x: number; y: number }, w: { x: number; y: number }) {
  const store = ctl.store;
  openPop(at, (close) => <>
    <button className="mi" data-k="up" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: w } })); }}><Icon name="upload" size="s" />上传</button>
    <button className="mi" data-k="assets" onClick={() => { close(); store.setUI({ drawer: "assets" }); }}><Icon name="folder" size="s" />添加资产</button>
    <button className="mi" data-k="add" onClick={() => { close(); setTimeout(() => addMenu(ctl, at, w), 140); }}><Icon name="plus" size="s" />添加节点<span className="k"><Icon name="right" size="xs" /></span></button>
    <button className="mi" data-k="aux" onClick={(e) => { const anchor = e.currentTarget as Element; openPop(anchor, (c) => <>
      <div className="mh">添加辅助工具</div>
      {([["note", "便签", "随手记一段说明", "pencil"], ["model3d", "3D", "文生 / 图生 3D 模型", "cube"], ["timeline", "剪辑时间线", "把视频 / 音频排成一条片子并导出", "video"], ["scene3d", "3D 片场", "摆放几何体和模型，调机位", "cube"]] as const).map(([k, l, d, ic]) => <button key={k} className="mi" data-t={k} onClick={() => { c(); createLegacy(ctl, k, w); }}><span className="ic"><Icon name={ic} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}
      <button className="mi" data-t="image-editor" onClick={() => { c(); createImageEditor(ctl, w); }}><Icon name="brush" size="s" />图片编辑器</button>
    </>, "right"); }}><Icon name="pencil" size="s" />添加辅助工具<span className="k"><Icon name="right" size="xs" /></span></button>
    <div className="msep" />
    <button className="mi" data-k="undo" onClick={() => { close(); store.undo(); }}><Icon name="undo" size="s" />撤销<span className="k">⌘Z</span></button>
    <button className="mi" data-k="redo" onClick={() => { close(); store.redo(); }}><Icon name="redo" size="s" />重做<span className="k">⇧⌘Z</span></button>
    <div className="msep" />
    <button className="mi" data-k="paste" disabled={!hasClip()} onClick={() => { close(); paste(store); }}><Icon name="copy" size="s" />粘贴<span className="k">⌘V</span></button>
  </>);
}

export function onNodeAct(ctl: Ctl, n: CanvasNode, act: string, e: React.SyntheticEvent) {
  const store = ctl.store; e.stopPropagation();
  if (act === "errok") { store.patchGen(n.id, { err: undefined, errCode: undefined }); return; }
  // 重试：清错误后按节点当前参数重跑（与右键「运行到此」同一入口）
  if (act === "erretry") { store.patchGen(n.id, { err: undefined, errCode: undefined }); void runNode(store, n.id); return; }
  if (act === "fav") { const fav = !genOf(n).fav; store.patchGen(n.id, { fav }); store.toast(fav ? `已收藏「${title(n)}」到素材库` : "已取消收藏"); return; }
  if (act === "replace") {
    // hover 的「替换」：只换媒体，节点本身（位置/尺寸/连线/提示词/参数）都不动
    const anchor = e.currentTarget as Element;
    openPop(anchor, (close) => <>
      <div className="mh">替换「{title(n)}」的当前版本</div>
      <button className="mi" data-k="rep-pick" onClick={() => { close(); store.setUI({ replace: n.id, pick: null }); store.toast("点画布上的图片 / 视频 / 音频节点，用它的当前版本替换这里"); }}><Icon name="cursor" size="s" />从画布选择</button>
      <button className="mi" data-k="rep-up" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { replace: n.id, at: { x: n.x - 40, y: n.y + 40 } } })); }}><Icon name="upload" size="s" />上传文件</button>
      <button className="mi" data-k="rep-lib" onClick={() => { close(); store.setUI({ replace: n.id, drawer: "assets" }); store.toast("在素材库里点一张图 / 一段视频，就会替换这里的当前版本"); }}><Icon name="folder" size="s" />从素材库选择</button>
    </>, "down");
    return;
  }
  if (act === "vmenu") {
    // 轮播条上的「1/2」：点开小菜单，能做「提取当前版本 / 应用所有历史」（箭头保留）
    const g = genOf(n);
    openPop(e.currentTarget as Element, (close) => <>
      <div className="mh">版本 {g.hi + 1} / {g.hist.length}</div>
      <button className="mi" data-k="extractver" disabled={g.hist.length < 2} onClick={() => { close(); extractCurrentVersion(store, n.id); }}><Icon name="copy" size="s" />提取当前版本</button>
      <button className="mi" data-k="allhist" disabled={g.hist.length < 2} onClick={() => { close(); spreadHistory(store, n.id); }}><Icon name="layers" size="s" />应用所有历史<span className="k">{g.hist.length} 个版本</span></button>
    </>, "down");
    return;
  }
  if (act === "vprev" || act === "vnext") { const g = genOf(n); const hi = (g.hi + (act === "vnext" ? 1 : -1) + g.hist.length) % g.hist.length; const o = g.hist[hi]; store.updateNode(n.id, (x) => { const y = { ...x }; if (o?.w && o.h && (x.kind === "image" || x.kind === "video")) y.h = Math.round(Math.max(100, Math.min(520, (x.w * o.h) / o.w))); return y; }); store.patchGen(n.id, { hi }); }
}

type ClipCommand = (payload: Record<string, unknown>) => Promise<Record<string, any> | null | undefined>;
type ClipOutcome = { ok: true; path: string; duration: number } | { ok: false; error: string; detail?: string };

/** 视频按「使用区间」交给主进程 ffmpeg 裁剪；没有桥 / 没有 ffmpeg / 裁剪失败都返回结构化结果，由调用方降级。 */
async function clipVideoBlob(blob: Blob, opts: { name: string; inSec: number; outSec: number }): Promise<ClipOutcome> {
  const command = typeof window === "undefined" ? undefined : (window as unknown as { openarc?: { canvas?: { command?: ClipCommand } } }).openarc?.canvas?.command;
  if (typeof command !== "function") return { ok: false, error: "NO_BRIDGE", detail: "当前页面没有桌面桥" };
  let base64 = "";
  try { base64 = await blobToBase64(blob); } catch { return { ok: false, error: "ENCODE_FAILED", detail: "读取视频字节失败" }; }
  if (!base64) return { ok: false, error: "ENCODE_FAILED", detail: "视频字节为空" };
  const res = await command({
    type: "media/clipVideo",
    dataUrl: "data:" + (blob.type || "video/mp4") + ";base64," + base64,
    inSec: opts.inSec, outSec: opts.outSec, format: "mp4", fileName: opts.name,
  }).catch((error: unknown) => ({ ok: false, error: "CLIP_FAILED", detail: String((error as Error)?.message || error).slice(0, 300) })) as Record<string, any> | null;
  if (res && res.ok === true && typeof res.path === "string") return { ok: true, path: res.path, duration: Number(res.duration) || 0 };
  return { ok: false, error: String(res?.error || "CLIP_FAILED"), detail: res && typeof res.detail === "string" ? res.detail : "" };
}

const saveBlob = (blob: Blob, file: string) => { const a = document.createElement("a"); const u = URL.createObjectURL(blob); a.href = u; a.download = file; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
const fileBase = (n: CanvasNode) => (genOf(n).title || "openarc").replace(/[\\/:*?"<>|]/g, "_");

/** 取节点当前结果的字节：资源库引用 / 远程地址先换成可取的地址，按类型补扩展名 */
export async function nodeFile(n: CanvasNode, store?: CanvasStore): Promise<{ blob: Blob; name: string; ext: string } | null> {
  if (!isGenKind(n.kind)) return null;
  const o = outOf(n); if (!o) return null; const name = fileBase(n);
  if (o.text && !o.url) return { blob: new Blob([o.text], { type: "text/markdown" }), name, ext: "md" };
  let url = o.url || o.frame || ""; if (!url) return null;
  if (url.startsWith("openarc-asset:")) { const d = store ? await store.backend.resolveAsset(url) : null; if (!d) throw new Error("资源不可用"); url = d; }
  else if (/^https?:\/\//i.test(url) && store?.backend.importRemote) { const ref = await store.backend.importRemote(store.state.canvasId, url, name); const d = ref.startsWith("openarc-asset:") ? await store.backend.resolveAsset(ref) : null; if (d) url = d; }
  const blob = await (await fetch(url)).blob();
  const ext = (blob.type.split("/")[1] || (n.kind === "video" ? "mp4" : n.kind === "audio" ? "mp3" : "png")).replace("jpeg", "jpg").replace("quicktime", "mov").replace("mpeg", "mp3").replace(/[^a-z0-9]/g, "");
  return { blob, name, ext };
}

/**
 * 批量下载（TapNow：多选 / 堆叠「全部下载」）：堆叠展开成成员，有结果的节点打成一个 zip。
 * 只有一个文件时直接下载；没有结果的节点跳过并说明。
 */
export async function downloadMany(nodes: CanvasNode[], store: CanvasStore, zipName?: string) {
  const doc = store.state.doc; const seen = new Set<string>(); const list: CanvasNode[] = [];
  for (const n of nodes) for (const m of isStack(n) ? stackItems(doc, n) : [n]) if (!seen.has(m.id)) { seen.add(m.id); list.push(m); }
  const withOut = list.filter((n) => isGenKind(n.kind) && outOf(n));
  const skipped = list.length - withOut.length;
  if (!withOut.length) { store.toast("选中的节点还没有可下载的结果"); return; }
  if (withOut.length === 1) { await download(withOut[0], store); return; }
  store.toast(`正在打包 ${withOut.length} 个文件…`);
  const files: Array<{ name: string; data: Blob }> = []; const failed: string[] = [];
  for (const n of withOut) {
    try { const f = await nodeFile(n, store); if (f) files.push({ name: f.name + "." + f.ext, data: f.blob }); else failed.push(title(n)); }
    catch { failed.push(title(n)); }
  }
  if (!files.length) { store.toast("下载失败：结果都取不到"); return; }
  const zip = await makeZip(files);
  const base = (zipName || store.state.name || "openarc").replace(/[\\/:*?"<>|]/g, "_");
  saveBlob(zip, `${base}-${files.length}个文件.zip`);
  const notes = [skipped ? `${skipped} 个没有结果已跳过` : "", failed.length ? `${failed.length} 个读取失败（${failed.slice(0, 3).join("、")}${failed.length > 3 ? "…" : ""}）` : ""].filter(Boolean).join("；");
  store.toast(`已打包下载 ${files.length} 个文件${notes ? "；" + notes : ""}`, notes ? 6000 : 2600);
}

/** 下载节点结果：资源库引用 / 远程地址先取成字节，按类型补扩展名（Electron 里 a[download] 只认能直接取到的地址） */
export async function download(n: CanvasNode, store?: CanvasStore) {
  if (!outOf(n)) return; const name = fileBase(n);
  const save = (blob: Blob, ext: string) => saveBlob(blob, name + "." + ext);
  try {
    const f = await nodeFile(n, store); if (!f) return;
    const { blob, ext } = f;
    if (ext === "md") return save(blob, ext);
    const o = outOf(n)!;
    const trim = n.kind === "video" ? o.trim : undefined;
    // 视频设了「使用区间」：先让主进程 ffmpeg 真裁；没有 ffmpeg / 裁剪失败再退回完整下载（如实说明，不静默）
    if (trim && !trimIsFull(o.dur, trim)) {
      const clipped = await clipVideoBlob(blob, { name, inSec: trim.in, outSec: trim.out });
      if (clipped.ok) {
        const dur = clipped.duration > 0 ? clipped.duration.toFixed(1) : "?";
        store?.toast("已导出 " + trimLabel(trim) + " 片段（" + dur + "s）→ " + shortenPath(clipped.path), 9000);
        return;
      }
      save(blob, ext);
      const why = clipped.error === "FFMPEG_MISSING" ? "本机没有 ffmpeg"
        : clipped.error === "NO_BRIDGE" ? "当前页面没有桌面桥"
        : "裁剪失败（" + ((clipped as { detail?: string }).detail || clipped.error) + "）";
      store?.toast("已下载完整视频「" + name + "." + ext + "」：" + why + "；区间 " + trimLabel(trim) + " 仅用于预览/截帧", 9000);
      return;
    }
    save(blob, ext);
    store?.toast(`已下载「${name}.${ext}」`);
  } catch (err) { store?.toast("下载失败：" + (err instanceof Error ? err.message : "未知错误")); }
}
