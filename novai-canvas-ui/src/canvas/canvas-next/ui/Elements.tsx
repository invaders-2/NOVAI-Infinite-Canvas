/**
 * 元素（TapNow Elements）的界面：从选中的图片节点创建 / 编辑元素，素材抽屉里的元素列表。
 * 数据与 @引用 逻辑见 ../elements.ts。
 */
import { useEffect, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { ELEMENT_ATTR_FIELDS, ELEMENT_FREE_FIELDS, ELEMENT_KINDS, ELEMENT_MAX_REFS, deleteElement, listElements, nameError, saveElement, syncElements, type CanvasElement, type ElementAttrKey, type ElementAttrs, type ElementKind } from "../elements";
import { clearOf } from "../history";
import { fitMediaBox } from "../mediaFit";
import { genOf, isGenKind, outOf } from "../model";
import { stackItems, isStack } from "../stack";
import { useCtl, type Ctl } from "./ctx";
import { Icon, type IconName } from "./Icon";
import { ModalHead, openModal, openPop } from "./overlay";
import { ThumbImg } from "./thumb";
import "./character.css";

export const KIND_ICON: Record<ElementKind, IconName> = { character: "user", product: "cube", scene: "image", style: "palette", other: "tag" };
const kindLabel = (k: ElementKind) => ELEMENT_KINDS.find(([x]) => x === k)?.[1] || "其他";

let synced = false;
export function useElements(): CanvasElement[] {
  const [list, setList] = useState(listElements);
  useEffect(() => { const on = () => setList(listElements()); addEventListener("cn:elements", on); if (!synced) { synced = true; void syncElements(); } return () => removeEventListener("cn:elements", on); }, []);
  return list;
}

/** 选中节点里能当参考图的结果（堆叠展开） */
export function elementRefsOf(ctl: Ctl, nodes: CanvasNode[]): string[] {
  const doc = ctl.store.state.doc; const out: string[] = [];
  for (const n of nodes) for (const m of isStack(n) ? stackItems(doc, n) : [n]) {
    if (!isGenKind(m.kind) || (m.kind !== "image" && m.kind !== "video")) continue;
    const o = outOf(m); const u = m.kind === "image" ? o?.url : o?.frame; if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

export function createElementFrom(ctl: Ctl, nodes: CanvasNode[], preset?: { kind?: ElementKind; attrs?: ElementAttrs }, onDone?: () => void) {
  const refs = elementRefsOf(ctl, nodes);
  if (!refs.length) { ctl.store.toast("先选中有结果的图片节点，再存成元素"); return; }
  const first = nodes[0]; const guess = first && isGenKind(first.kind) ? genOf(first).title.replace(/[\s@·,，。!?！？:：;；"'“”‘’()[\]{}<>]/g, "").slice(0, 20) : "";
  openModal((close) => <ElementEditor ctl={ctl} init={{ name: guess, kind: preset?.kind || "character", desc: "", refs: refs.slice(0, ELEMENT_MAX_REFS), ...(preset?.attrs ? { attrs: preset.attrs } : {}) }} extra={Math.max(0, refs.length - ELEMENT_MAX_REFS)} close={() => { close(); onDone?.(); }} />, "rungroup");
}
export function editElement(ctl: Ctl, e: CanvasElement, onDone?: () => void) { openModal((close) => <ElementEditor ctl={ctl} init={e} extra={0} close={() => { close(); onDone?.(); }} />, "rungroup"); }

function ElementEditor({ ctl, init, extra, close }: { ctl: Ctl; init: Omit<CanvasElement, "id" | "at"> & { id?: string }; extra: number; close: () => void }) {
  const store = ctl.store;
  const [name, setName] = useState(init.name); const [kind, setKind] = useState<ElementKind>(init.kind); const [desc, setDesc] = useState(init.desc); const [refs, setRefs] = useState(init.refs);
  const [attrs, setAttrs] = useState<ElementAttrs>(init.attrs || {}); const [attrsOpen, setAttrsOpen] = useState(!!init.attrs && Object.keys(init.attrs).length > 0);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const setAttr = (k: ElementAttrKey, v: string) => setAttrs((a) => ({ ...a, [k]: v }));
  const attrCount = Object.values(attrs).filter((v) => (v || "").trim()).length;
  const save = async () => {
    const e = nameError(name, listElements(), init.id); if (e) { setErr(e); return; }
    if (!refs.length) { setErr("至少保留一张参考图"); return; }
    setBusy(true); setErr("");
    try {
      // 参考图先存进资源库，元素里只留引用（大图不进本机存储）
      const kept = await Promise.all(refs.map((r, i) => (r.startsWith("data:") ? store.backend.importAsset(store.state.canvasId, r, `${name.trim()}-${i + 1}`).catch(() => r) : Promise.resolve(r))));
      const saved = saveElement({ id: init.id, name, kind, desc, refs: kept, attrs });
      close(); store.toast(init.id ? `已更新元素「${saved.name}」` : `已存为元素「${saved.name}」：在提示词里输入 @${saved.name} 引用`);
    } catch (x) { setErr(x instanceof Error ? x.message : "保存失败"); } finally { setBusy(false); }
  };
  return <>
    <ModalHead title={init.id ? "编辑元素" : "存为元素"} icon={KIND_ICON[kind]} />
    <div className="mbd rg el-ed">
      <div className="el-refs">{refs.map((r, i) => <span key={r + i} className="el-ref"><RefImg src={r} />{refs.length > 1 ? <button className="x" aria-label="移除这张" onClick={() => setRefs(refs.filter((_, k) => k !== i))}><Icon name="x" size="xs" /></button> : null}</span>)}</div>
      {extra ? <p className="rg-note">最多 {ELEMENT_MAX_REFS} 张参考图，另外 {extra} 张没有加入。</p> : null}
      <div className="sec"><span>名字</span><span className="lg-dim">提示词里用 @{name.trim() || "名字"} 引用</span></div>
      <input className="rg-input" data-el-name autoFocus value={name} maxLength={20} placeholder="例如：小白猫" onChange={(e) => { setName(e.target.value); setErr(""); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.nativeEvent.isComposing) void save(); }} />
      <div className="sec"><span>类型</span></div>
      <div className="seg">{ELEMENT_KINDS.map(([k, l]) => <button key={k} data-el-kind={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}</div>
      <div className="sec"><span>描述（可选）</span></div>
      <textarea className="rg-input" rows={3} value={desc} maxLength={300} placeholder="外形、材质、穿着等需要保持一致的特征" onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {kind === "character" ? <>
        <button className="ea-toggle" data-el-attrs-toggle aria-expanded={attrsOpen} onClick={() => setAttrsOpen((v) => !v)}><Icon name={attrsOpen ? "down" : "right"} size="xs" /><span>角色属性（可选）</span><span className="lg-dim">{attrCount ? attrCount + " 项" : "时代 / 性别 / 体格…"}</span></button>
        {attrsOpen ? <div className="ea-grid">
          {ELEMENT_ATTR_FIELDS.map(([k, label]) => <label key={k} className={"ea-f" + (k === "scene" ? " wide" : "")}><span>{label}</span><input className="rg-input" data-el-attr={k} value={attrs[k] || ""} maxLength={160} placeholder={k === "era" ? "古代历史 / 当代现实…" : ""} onChange={(e) => setAttr(k, e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>)}
          {ELEMENT_FREE_FIELDS.map(([k, label]) => <label key={k} className="ea-f wide"><span>{label}</span><textarea className="rg-input" data-el-attr={k} rows={2} value={attrs[k] || ""} maxLength={160} onChange={(e) => setAttr(k, e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>)}
        </div> : null}
      </> : null}
      {err ? <p className="rg-note"><span style={{ color: "var(--bad)" }}>{err}</span></p> : null}
      <div className="rg-foot"><button className="btn" onClick={close}>取消</button><button className="btn solid" data-el-save disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div>
    </div>
  </>;
}

// 72px 的参考图格子：走缩略图，失败退回图标（原图只在图像编辑器 / 灯箱里用）
function RefImg({ src }: { src: string }) { return <ThumbImg src={src} width={72} fallback={<span className="el-ph"><Icon name="image" size="s" /></span>} />; }

/** 把 @名字 插进当前选中的生成节点的提示词；没有选中就复制到剪贴板 */
export function insertElement(ctl: Ctl, e: CanvasElement) {
  const store = ctl.store; const id = [...store.state.ui.sel][0]; const n = id ? store.node(id) : null;
  if (n && isGenKind(n.kind) && n.kind !== "audio") {
    const p = genOf(n).prompt; const tag = "@" + e.name;
    if (!p.includes(tag)) store.patchGen(n.id, { prompt: (p && !/\s$/.test(p) ? p + " " : p) + tag + " " }, { history: true });
    store.toast(`已在「${genOf(n).title}」的提示词里引用 ${tag}`); ctl.focusPrompt(); return;
  }
  void navigator.clipboard?.writeText("@" + e.name).then(() => store.toast(`已复制 @${e.name}，粘贴到任意提示词里即可引用`), () => store.toast(`在提示词里输入 @${e.name} 引用`));
}

/** 读图片真实尺寸；失败返回 null（调用方退回默认尺寸） */
function imageSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((ok) => {
    try {
      const im = new Image();
      im.onload = () => ok(im.naturalWidth > 0 && im.naturalHeight > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
      im.onerror = () => ok(null);
      im.src = src;
    } catch { ok(null); }
  });
}

const PLACE_GAP = 40;
const PLACE_BASE_W = 320;
const PLACE_FALLBACK = { w: 320, h: 240 };

/** 参考图按各自真实比例放到画布中心：横向间距 40、顶部对齐；量不到尺寸的用默认 320×240 */
export async function placeRefs(ctl: Ctl, e: CanvasElement) {
  const store = ctl.store; const c = ctl.center();
  if (!e.refs.length) { store.toast("这个角色还没有参考图"); return; }
  const measured = await Promise.all(e.refs.map((r) => imageSize(r)));
  const boxes = measured.map((s) => (s ? fitMediaBox(PLACE_BASE_W, s.w, s.h) : null) || PLACE_FALLBACK);
  const maxH = Math.max(...boxes.map((b) => b.h));
  const totalW = boxes.reduce((n, b) => n + b.w, 0) + PLACE_GAP * (boxes.length - 1);
  const top = c.y - maxH / 2;
  let x = c.x - totalW / 2;
  const nodes = e.refs.map((r, i) => {
    const box = boxes[i]; const size = measured[i];
    const node = store.newNode("image", x, top, { title: `${e.name} ${i + 1}`, uploaded: true, hist: [{ url: r, ...(size ? { w: size.w, h: size.h } : {}) }], w: box.w, h: box.h });
    x += box.w + PLACE_GAP;
    return node;
  });
  const ns = clearOf(store.state.doc.nodes, nodes);
  store.addNodes(ns, [], { select: true }); store.toast(`已放到画布：${ns.length} 张参考图`);
}

/** 素材抽屉里的「元素」分区 */
export function ElementsSection({ q }: { q: string }) {
  const ctl = useCtl(); const list = useElements().filter((e) => !q || (e.name + e.desc).includes(q));
  const menu = (e: CanvasElement, at: Element) => openPop(at, (close) => <>
    <div className="mh">{kindLabel(e.kind)} · @{e.name}</div>
    <button className="mi" data-el-act="insert" onClick={() => { close(); insertElement(ctl, e); }}><Icon name="link" size="s" />在提示词里引用</button>
    <button className="mi" data-el-act="place" onClick={() => { close(); placeRefs(ctl, e); }}><Icon name="plus" size="s" />参考图放到画布</button>
    <button className="mi" data-el-act="edit" onClick={() => { close(); editElement(ctl, e); }}><Icon name="pencil" size="s" />编辑</button>
    <button className="mi danger" data-el-act="del" onClick={() => { close(); deleteElement(e.id); ctl.store.toast(`已删除元素「${e.name}」；已经写进提示词的 @${e.name} 不再展开`); }}><Icon name="trash" size="s" />删除</button>
  </>);
  return <>
    <div className="sec"><span>元素 <span className="tnum">{list.length || ""}</span></span><button className="linkbtn" data-el-new onClick={() => createElementFrom(ctl, [...ctl.store.state.ui.sel].map((id) => ctl.store.node(id)).filter((n): n is CanvasNode => !!n))}><Icon name="plus" size="xs" />用选中的图片新建</button></div>
    <div className="elgrid">
      {list.map((e) => <button key={e.id} className="elc" data-el={e.name} title={e.desc || e.name} onClick={(ev) => menu(e, ev.currentTarget)}>
        <span className="cv">{e.refs[0] ? <RefImg src={e.refs[0]} /> : <Icon name={KIND_ICON[e.kind]} size="s" />}{e.refs.length > 1 ? <i className="tnum">{e.refs.length}</i> : null}</span>
        <span className="nm"><Icon name={KIND_ICON[e.kind]} size="xs" />{e.name}</span>
      </button>)}
      {list.length ? null : <span className="el-empty">还没有元素</span>}
    </div>
  </>;
}

/** 提示词 @ 菜单里的元素项 */
export function ElementMenuItems({ onPick }: { onPick: (e: CanvasElement) => void }) {
  const list = useElements();
  if (!list.length) return null;
  return <>{list.map((e) => <button key={e.id} className="mi" data-el-pick={e.name} onClick={() => onPick(e)}><span className="ic"><Icon name={KIND_ICON[e.kind]} size="s" /></span><span>@{e.name}<span className="d">{kindLabel(e.kind)} · {e.refs.length} 张参考图{e.desc ? " · " + e.desc.slice(0, 18) : ""}</span></span></button>)}</>;
}
