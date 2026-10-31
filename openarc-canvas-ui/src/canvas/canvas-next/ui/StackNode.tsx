/**
 * 堆叠（TapNow Stack）：画布上的叠放封面 + 悬停工具条、双击后的展开视图，以及分组运行确认框。
 *
 * 性能：封面和展开视图都用缩略图（ui/thumb.ts），不解码原图；封面只在封面内容变化时重绘。
 * 动效：堆叠时成员从原位飞进叠里；悬停时后面两张向两边扇开；双击时成员从叠里飞出排成一排，
 * 画布其它内容淡出；Esc / 点空白处飞回叠里。系统开启「减少动态效果」时不播放。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { renderCanvasThumb } from "../../react-canvas/exportCanvas";
import { savePersonalTemplate } from "../personalTemplates";
import { title } from "../actions";
import { planGroup, runGroup, type GroupPlan } from "../engine";
import { isGenKind, outOf, TYPE_ICON, TYPE_LABEL, type GenKind } from "../model";
import { cardOf, groupLabel, isStack, stackCover, stackCoverKey, stackItems, takeFromStack, takeStackFlyIn, unstack, type StackCard } from "../stack";
import { useCtl, useS, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { saveNodesToLibrary } from "./Library";
import { downloadMany } from "./menus";
import { closeModal, ModalHead, openModal } from "./overlay";
import { ThumbImage } from "./thumb";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const EASE = "cubic-bezier(.2,0,0,1)";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** 封面缩略图长边（节点 ~220 宽 × 2 倍屏） / 展开视图缩略图长边 */
const COVER_PX = 480, FOCUS_PX = 640;

/** 一张卡片的画面：图片 / 视频封面用缩略图，文本显示摘要，其它显示类型图标 */
function CardFace({ c, px }: { c: StackCard; px: number }) {
  if (c.src) return <ThumbImage src={c.src} px={px} aspect={c.w && c.h ? c.w / c.h : 1} />;
  if (c.text) return <div className="st-text">{c.text}</div>;
  return <div className="st-ph"><Icon name={isGenKind(c.kind) ? TYPE_ICON[c.kind] : "layers"} /></div>;
}

const toAgent = (ctl: Ctl, items: CanvasNode[]) => { items.forEach((n) => window.dispatchEvent(new CustomEvent("cn:agent-pick", { detail: n.id }))); ctl.store.setUI({ agentOpen: true }); ctl.store.toast(`已把 ${items.length} 个节点加入对话`); };

/**
 * 画布上的堆叠：最上面一张完整显示，第 2、3 张缩小一点从右、左两边露出来（TapNow）。
 * 悬停时两边的卡片扇开，上方出现工具条：取消堆叠 / 加入对话 / 存素材库 / 下载。
 */
export function StackBody({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store;
  // 只订阅封面指纹（字符串）：拖动 / 生成别的节点时堆叠不重绘
  const key = useS((s) => stackCoverKey(s.doc, node));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cover = useMemo(() => stackCover(store.state.doc, node), [key]);
  const ref = useRef<HTMLDivElement>(null);
  // 刚堆叠：卡片从各自原来的位置飞进叠里，其余成员化成浅色卡片一起收拢
  useLayoutEffect(() => {
    const from = takeStackFlyIn(node.id); const root = ref.current; if (!from || !root) return;
    const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
    const fly = (el: HTMLElement, r: { x: number; y: number; w: number; h: number }, i: number, extra?: Keyframe) =>
      el.animate([{ transform: `translate(${r.x + r.w / 2 - cx}px,${r.y + r.h / 2 - cy}px) scale(${Math.max(.2, r.w / Math.max(1, node.w))})`, ...(extra || {}) }], { duration: 420, delay: Math.min(i * 24, 160), easing: EASE, fill: "backwards" });
    const cards = [...root.querySelectorAll<HTMLElement>(".stack-card")];
    cover.forEach((c, i) => { const r = from.find((f) => f.id === c.id); const el = cards.find((x) => x.dataset.card === c.id); if (r && el) fly(el, r, i); });
    const rest = from.filter((f) => !cover.some((c) => c.id === f.id)).slice(0, 12);
    rest.forEach((r, i) => {
      const g = document.createElement("div"); g.className = "stack-ghost"; root.appendChild(g);
      const a = fly(g, r, i + cover.length, { opacity: 1 }); a.onfinish = a.oncancel = () => g.remove();
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: Math.min((i + cover.length) * 24, 160), easing: EASE, fill: "both" });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);
  const items = () => stackItems(store.state.doc, store.node(node.id) || node);
  const front = cover[0];
  return <div className="stack-body" ref={ref}>
    {cover.slice().reverse().map((c) => { const i = cover.indexOf(c); return (
      <div key={c.id} data-card={c.id} className={"stack-card b" + i + (i ? "" : " front") + (c.src ? "" : c.text ? " is-text" : " is-ph")} style={i && front && c.w && c.h ? { aspectRatio: `${c.w} / ${c.h}` } : undefined}>
        <CardFace c={c} px={COVER_PX} />
      </div>); })}
    <div className="stack-tools" data-act="stack-tools" onPointerDown={stop} onDoubleClick={stop}>
      <button data-tip="取消堆叠" data-st="unstack" onClick={(e) => { stop(e); unstack(store, node.id); }}><Icon name="layers" size="s" /></button>
      <button data-tip="加入对话" data-st="agent" onClick={(e) => { stop(e); toAgent(ctl, items()); }}><Icon name="msg" size="s" /></button>
      <button data-tip="存素材库" data-st="lib" onClick={(e) => { stop(e); void saveNodesToLibrary(ctl, items(), e.currentTarget); }}><Icon name="libadd" size="s" /></button>
      <button data-tip="全部下载" data-st="dl" onClick={(e) => { stop(e); void downloadMany(items(), store, store.state.name + "-堆叠"); }}><Icon name="download" size="s" /></button>
    </div>
  </div>;
}

/* ---------- 展开视图（双击堆叠） ---------- */

/** 监听「展开堆叠」，在画布上方打开展开视图；打开时画布上的工具栏淡出 */
export function StackFocusHost() {
  const ctl = useCtl();
  const [st, setSt] = useState<{ id: string; closing: boolean } | null>(null);
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent).detail as string; if (isStack(ctl.store.node(id))) setSt({ id, closing: false }); };
    addEventListener("cn:stack", on); return () => removeEventListener("cn:stack", on);
  }, [ctl]);
  useEffect(() => { document.getElementById("stage")?.classList.toggle("sfocus", !!st && !st.closing); }, [st]);
  useEffect(() => () => document.getElementById("stage")?.classList.remove("sfocus"), []);
  if (!st) return null;
  return <StackFocus key={st.id} ctl={ctl} id={st.id} closing={st.closing} onClose={() => setSt((s) => (s ? { ...s, closing: true } : s))} onGone={() => setSt(null)} />;
}

/** 卡片在展开视图里的高度：一排放得下就大一点，多了就换行、可滚动 */
function cardHeight(n: number, vw: number, vh: number) {
  const base = Math.min(300, Math.max(150, vh * .4));
  return n <= 4 ? base : n <= 8 ? Math.min(base, Math.max(150, (vw - 160) / (n * .8))) : Math.max(140, Math.min(200, base * .7));
}

function StackFocus({ ctl, id, closing, onClose, onGone }: { ctl: Ctl; id: string; closing: boolean; onClose: () => void; onGone: () => void }) {
  const store = ctl.store; const doc = useS((s) => s.doc);
  const s = doc.nodes.find((n) => n.id === id);
  const items = s && isStack(s) ? stackItems(doc, s) : [];
  const cards = items.map(cardOf);
  const rowRef = useRef<HTMLDivElement>(null); const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => { const r = ctl.rect(); return { w: r.width, h: r.height }; });
  const H = cardHeight(cards.length, size.w, size.h);
  // 叠在屏幕上的位置（相对展开视图）：卡片从这里飞出、关闭时飞回这里
  const stackRect = () => {
    const n = store.node(id); const r = ctl.rect(); if (!n) return null; const k = store.state.view.k;
    const p = ctl.toScreen(n.x, n.y + 24); return { x: p.x - r.left, y: p.y - r.top, w: n.w * k, h: n.h * k };
  };
  const flyAll = (dir: "in" | "out") => {
    const row = rowRef.current; const root = rootRef.current; const sr = stackRect(); if (!row || !root || !sr || reduced()) return 0;
    const base = root.getBoundingClientRect();
    const els = [...row.querySelectorAll<HTMLElement>(".sf-card")];
    // 先一次读完所有位置，再统一开始动画（边读边写会让每张卡片都强制重新布局一次）
    const rects = els.map((el) => el.querySelector(".sf-face")!.getBoundingClientRect());
    els.forEach((el, i) => {
      const r = rects[i];
      // 看不见的卡片、第 9 张以后的卡片只做淡入淡出：几十张卡片同时飞会掉帧
      if (i >= 8 || r.bottom < base.top || r.top > base.bottom) { el.animate(dir === "out" ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: dir === "out" ? 200 : 0, easing: EASE, fill: "both" }); return; }
      el.style.zIndex = String(20 - i); // 飞的途中第 1 张在最上面，和画布上的叠一致
      const dx = sr.x + sr.w / 2 - (r.left - base.left + r.width / 2), dy = sr.y + sr.h / 2 - (r.top - base.top + r.height / 2);
      const sc = Math.max(.1, sr.w / Math.max(1, r.width));
      const at: Keyframe = { transform: `translate(${dx}px,${dy}px) scale(${sc})`, opacity: i < 3 ? 1 : 0 };
      const kf = dir === "out" ? [at, { transform: "none", opacity: 1 }] : [{ transform: "none", opacity: 1 }, at];
      el.animate(kf, { duration: dir === "out" ? 420 : 300, delay: dir === "out" ? Math.min(i * 22, 220) : Math.min((els.length - 1 - i) * 12, 120), easing: dir === "out" ? EASE : "cubic-bezier(.4,0,.2,1)", fill: "both" });
    });
    return dir === "out" ? 420 : 300 + Math.min(els.length * 12, 120);
  };
  useLayoutEffect(() => { flyAll("out"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!closing) return; const t = setTimeout(onGone, flyAll("in") + 20); return () => clearTimeout(t); }, [closing]); // eslint-disable-line react-hooks/exhaustive-deps
  // 叠没了（取消堆叠 / 只剩一个自动解散）：直接收起
  useEffect(() => { if (!s || !isStack(s)) onGone(); }, [s, onGone]);
  useEffect(() => { const on = () => { const r = ctl.rect(); setSize({ w: r.width, h: r.height }); }; addEventListener("resize", on); return () => removeEventListener("resize", on); }, [ctl]);
  // Esc 收起；展开时画布快捷键不生效（Delete 不会误删整个叠）
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (document.querySelector(".lightbox,.modal")) return;
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !t.closest(".sf")) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      e.stopImmediatePropagation();
    };
    addEventListener("keydown", on, true); return () => removeEventListener("keydown", on, true);
  }, [onClose]);

  // 拖卡片：拖出一段距离松手 = 放回画布（放在松手的位置）；没拖动 = 打开预览
  const drag = useRef<{ id: string; el: HTMLElement; sx: number; sy: number; moved: boolean } | null>(null);
  const down = (e: React.PointerEvent, cid: string) => {
    if (e.button !== 0) return; e.stopPropagation();
    const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId);
    drag.current = { id: cid, el, sx: e.clientX, sy: e.clientY, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return; const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) { d.moved = true; d.el.getAnimations().forEach((a) => a.cancel()); d.el.classList.add("dragging"); }
    d.el.style.transform = `translate(${dx}px,${dy}px) rotate(${Math.max(-4, Math.min(4, dx / 60))}deg)`;
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null; if (!d) return;
    const n = store.node(d.id);
    if (!d.moved) { if (n && n.kind === "text") window.dispatchEvent(new CustomEvent("cn:textdoc", { detail: d.id })); else if (n && outOf(n)) window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: d.id })); return; }
    const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    if (dist < 48 || !n) { d.el.classList.remove("dragging"); d.el.animate([{ transform: d.el.style.transform }, { transform: "none" }], { duration: 220, easing: EASE }); d.el.style.transform = ""; return; }
    const face = d.el.querySelector(".sf-face")!.getBoundingClientRect();
    const c = ctl.toWorld(face.left + face.width / 2, face.top + face.height / 2);
    d.el.style.visibility = "hidden";
    takeFromStack(store, id, d.id, { x: c.x - n.w / 2, y: c.y - n.h / 2 - 12 });
  };

  const label = s ? groupLabel(s) : "堆叠";
  return <div className={"sf" + (closing ? " closing" : "")} ref={rootRef} data-stack-focus={id}>
    <div className="sf-bg" onPointerDown={(e) => { if (e.button === 0) onClose(); }} />
    <div className="sf-top" onPointerDown={stop}>
      <span className="sf-title"><Icon name="layers" size="s" />{label}<b className="tnum">{items.length}</b></span>
      <span className="vsep" />
      <button className="sf-btn" data-sf="agent" onClick={() => toAgent(ctl, items)}><Icon name="msg" size="s" />加入对话</button>
      <button className="sf-btn" data-sf="lib" onClick={(e) => void saveNodesToLibrary(ctl, items, e.currentTarget)}><Icon name="libadd" size="s" />存素材库</button>
      <button className="sf-btn" data-sf="dl" onClick={() => void downloadMany(items, store, store.state.name + "-堆叠")}><Icon name="download" size="s" />全部下载</button>
      <button className="sf-btn" data-sf="unstack" onClick={() => { unstack(store, id); }}><Icon name="split" size="s" />取消堆叠</button>
      <span className="vsep" />
      <button className="sf-btn solid" data-sf="close" onClick={onClose}>完成<kbd>Esc</kbd></button>
    </div>
    <div className="sf-scroll" onPointerDown={(e) => { if (e.target === e.currentTarget && e.button === 0) onClose(); }}>
      <div className="sf-row" ref={rowRef} onPointerDown={(e) => { if (e.target === e.currentTarget && e.button === 0) onClose(); }}>
        {cards.map((c) => <div key={c.id} className="sf-card" data-sf-card={c.id} onPointerDown={(e) => down(e, c.id)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <div className="sf-head"><Icon name={isGenKind(c.kind) ? TYPE_ICON[c.kind] : "layers"} size="xs" /><span>{c.title}</span></div>
          <div className={"sf-face" + (c.src ? "" : c.text ? " is-text" : " is-ph")} style={{ height: H, width: Math.round(H * Math.max(.5, Math.min(2, (c.w || 1) / (c.h || 1)))) }}><CardFace c={c} px={cards.length > 8 ? 400 : FOCUS_PX} /></div>
        </div>)}
      </div>
    </div>
    <div className="sf-hint"><Icon name="cursor" size="s" />拖动节点即可将它放回原画布 · 点一下预览</div>
  </div>;
}

/* ---------- 分组运行 ---------- */
const fmtSecs = (s: number) => (s < 60 ? `${Math.round(s)} 秒` : `${Math.round(s / 60)} 分钟`);

const ONLY_MISSING_KEY = "canvas-next:rungroup:onlyMissing";
const loadOnlyMissing = () => { try { return localStorage.getItem(ONLY_MISSING_KEY) === "1"; } catch { return false; } };

/** 一键运行的进度 key：分组用分组 id；多选用排好序的节点 id（同一批节点再点一次能认出来） */
export function runKeyOf(nodes: CanvasNode[]): string {
  if (nodes.length === 1 && nodes[0].kind === "group") return nodes[0].id;
  return "sel:" + nodes.map((n) => n.id).sort().join(",");
}

/** 运行前确认：列出要跑的节点数、预计调用次数（按类型 / 模型）、预计耗时、跳过的节点 */
export function confirmRunGroup(ctl: Ctl, ids: string[], label = "分组", key?: string) {
  if (key && ctl.store.state.batches[key]) { const b = ctl.store.state.batches[key]; ctl.store.toast(`「${label}」正在运行（${b.done}/${b.total}），可以在上方进度条里停止`); return; }
  const onlyMissing = loadOnlyMissing();
  const plan = planGroup(ctl.store, ids, { onlyMissing });
  // 「只跑没结果的」打开时全都有结果了：退回全部运行，不让用户卡在“没有可运行的节点”
  const full = !plan.total && onlyMissing ? planGroup(ctl.store, ids) : plan;
  if (!full.total) { ctl.store.toast(full.skipped.length ? `没有可运行的节点：${full.skipped[0].title}（${full.skipped[0].why}）` : "分组里没有可运行的生成节点"); return; }
  openModal((close) => <RunGroupConfirm ctl={ctl} ids={ids} label={label} runKey={key} initOnlyMissing={onlyMissing && !!plan.total} close={close} />, "rungroup");
}
function RunGroupConfirm({ ctl, ids, label, runKey, initOnlyMissing, close }: { ctl: Ctl; ids: string[]; label: string; runKey?: string; initOnlyMissing: boolean; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(initOnlyMissing);
  const plan = planGroup(ctl.store, ids, { onlyMissing });
  const allPlan = onlyMissing ? planGroup(ctl.store, ids) : plan;
  const kinds = (Object.keys(plan.byKind) as GenKind[]).filter((k) => plan.byKind[k]);
  const toggle = (v: boolean) => { setOnlyMissing(v); try { localStorage.setItem(ONLY_MISSING_KEY, v ? "1" : "0"); } catch { /* 忽略 */ } };
  const go = async () => {
    if (!plan.total) return;
    setBusy(true); close();
    ctl.store.toast(`开始运行「${label}」：${plan.total} 个节点，按依赖分 ${plan.levels.length} 步`);
    const r = await runGroup(ctl.store, plan, { key: runKey, label });
    if (r.stopped) { ctl.store.toast(`已停止「${label}」：完成 ${r.ok} 个`, 4000); return; }
    ctl.store.toast(r.failed || r.skipped ? `「${label}」运行结束：成功 ${r.ok}，失败 ${r.failed}${r.skipped ? `，${r.skipped} 个因上游失败未运行` : ""}` : `「${label}」运行完成：${r.ok} 个节点`, 5000);
  };
  return <>
    <ModalHead title={<>一键运行「{label}」</>} icon="play" />
    <div className="mbd rg">
      <div className="rg-sum">
        <div><b className="tnum">{plan.total}</b><span>个节点</span></div>
        <div><b className="tnum">{plan.calls}</b><span>次模型调用</span></div>
        <div><b className="tnum">≈{fmtSecs(plan.secs)}</b><span>预计耗时</span></div>
      </div>
      {allPlan.hasOut ? <label className="rg-opt" data-rg="onlyMissing">
        <input type="checkbox" checked={onlyMissing} onChange={(e) => toggle(e.target.checked)} />
        <span>只运行还没有结果的节点<small>{allPlan.hasOut} 个已有结果，{onlyMissing ? "直接给下游用" : "会追加一个新版本"}</small></span>
      </label> : null}
      {plan.levels.length > 1 ? <><div className="sec"><span>运行顺序（{plan.levels.length} 步）</span></div>
        <div className="rg-steps" data-rg="steps">{plan.levels.map((lv, i) => <div key={i} className="rg-step"><span className="n tnum">{i + 1}</span><span className="names">{lv.map((id) => title(ctl.store.node(id)!)).join("、")}</span></div>)}</div></> : null}
      <div className="sec"><span>预计消耗</span></div>
      {kinds.length ? kinds.map((k) => <div key={k} className="row"><span>{TYPE_LABEL[k]}</span><b className="tnum">{plan.byKind[k]} 次</b></div>) : <div className="row sub"><span>都已有结果，不需要运行</span></div>}
      {plan.byModel.map((m) => <div key={m.name} className="row sub"><span>{m.name}</span><span className="tnum">{m.calls} 次</span></div>)}
      {plan.skipped.length ? <><div className="sec"><span>不会运行（{plan.skipped.length}）</span></div>
        {plan.skipped.slice(0, 6).map((x) => <div key={x.id} className="row sub"><span>{x.title}</span><span>{x.why}</span></div>)}</> : null}
      <p className="rg-note">按服务商的用量计费。同一步里互不依赖的节点并行运行，某个节点失败时它的下游不再运行；运行中可以随时停止。</p>
      <div className="rg-foot"><button className="btn" onClick={close}>取消</button><button className="btn solid" data-rg="go" disabled={busy || !plan.total} onClick={() => void go()}><Icon name="play" size="s" />运行 {plan.total} 个节点</button></div>
    </div>
  </>;
}

/** 分组 / 多选里可运行的节点 id（堆叠展开成员） */
export function runnableIds(store: Ctl["store"], nodes: CanvasNode[]): string[] {
  const doc = store.state.doc; const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "group") (isStack(n) ? stackItems(doc, n) : (n.children || []).map((c) => store.node(c)).filter((x): x is CanvasNode => !!x)).forEach((c) => { if (isGenKind(c.kind)) out.push(c.id); });
    else if (isGenKind(n.kind)) out.push(n.id);
  }
  return [...new Set(out)];
}
export { groupLabel } from "../stack";

/** 一键运行：一个分组 / 堆叠，或多选的节点（分组展开成员），按依赖顺序跑 */
export function runNodes(ctl: Ctl, nodes: CanvasNode[]) {
  if (!nodes.length) return;
  const one = nodes.length === 1 && nodes[0].kind === "group";
  confirmRunGroup(ctl, runnableIds(ctl.store, nodes), one ? groupLabel(nodes[0]) : `选中的 ${nodes.length} 个节点`, runKeyOf(nodes));
}

/* ---------- 分组 / 选中节点「存为我的模板」（TapNow Create Template） ---------- */
/** 分组 / 堆叠展开成员，取出子画布（只保留两端都在里面的连线） */
export function subDoc(store: Ctl["store"], nodes: CanvasNode[]): CanvasDoc {
  const doc = store.state.doc; const ids = new Set<string>();
  for (const n of nodes) { if (n.kind === "group") (n.children || []).forEach((c) => { if (store.node(c)) ids.add(c); }); else ids.add(n.id); }
  return { nodes: doc.nodes.filter((n) => ids.has(n.id)), edges: doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), comments: [] };
}
export function saveAsTemplate(ctl: Ctl, nodes: CanvasNode[], name: string) {
  const sub = subDoc(ctl.store, nodes);
  if (!sub.nodes.length) { ctl.store.toast("没有可保存的节点"); return; }
  openModal((close) => <SaveTemplate ctl={ctl} doc={sub} name={name} close={close} />, "rungroup");
}
function SaveTemplate({ ctl, doc, name, close }: { ctl: Ctl; doc: CanvasDoc; name: string; close: () => void }) {
  const [title, setTitle] = useState(name); const [desc, setDesc] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const save = async () => {
    if (!title.trim()) { setErr("请填写模板名称"); return; }
    setBusy(true); setErr("");
    const coverDataUrl = await renderCanvasThumb({ doc, width: 480, height: 480, theme: ctl.store.state.ui.theme, structure: true, fit: "fill" }).catch(() => undefined);
    const r = await savePersonalTemplate({ title, prompt: desc, doc, coverDataUrl });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "保存失败"); return; }
    close(); ctl.store.toast(`已存为我的模板「${title.trim()}」：${doc.nodes.length} 个节点`);
  };
  return <>
    <ModalHead title="存为我的模板" icon="layout" />
    <div className="mbd rg">
      <div className="sec"><span>模板名称</span></div>
      <input className="rg-input" autoFocus value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="sec"><span>说明（可选）</span></div>
      <textarea className="rg-input" rows={3} value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <p className="rg-note">保存 {doc.nodes.length} 个节点和它们之间的 {doc.edges.length} 条连线；提示词和参数会保存，生成结果不保存。{err ? <><br /><span style={{ color: "var(--bad)" }}>{err}</span></> : null}</p>
      <div className="rg-foot"><button className="btn" onClick={close}>取消</button><button className="btn solid" data-tpl="save" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div>
    </div>
  </>;
}
