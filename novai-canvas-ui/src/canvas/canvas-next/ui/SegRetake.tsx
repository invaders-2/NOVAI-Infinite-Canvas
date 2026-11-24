/**
 * 片段重拍（交互同 LibTV）：
 *   · 视频节点工具条「片段重拍」→ 在右边新建「原名-片段重拍」节点（来源视频连成它的参考视频，节点数据里记 segRetake）；
 *   · 新节点还没出片时，正文直接播来源视频；选中时节点下方是胶片条（截片段，最多 5 段），再下面是同一个生成面板；
 *   · 截了片段：提示词开头自动写成「把 @视频 中 00:03–00:08：」，后面写要怎么改（不写不让发，免得白跑一次看不出变化）；
 *     没截片段、提示词也留空：按来源节点原来的提示词原样重跑一次（来源视频当参考）。
 *   · 出片后结果留在这个节点上，再生成就是在它上面追加版本。
 * SegPicker 也给剪辑时间线的「片段重拍」弹窗用（那边带大预览）。
 */
import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { preferSourceVideoMode, regenAsNew } from "../engine";
import { mentionToken } from "../mentions";
import { defaultParams, genOf, outOf, type VideoParams } from "../model";
import { useFilmstrip } from "../timelineFilmstrip";
import type { CanvasStore } from "../store";
import { useCtl, useS, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { useAssetUrl } from "./useAsset";

export type SegRange = { a: number; b: number };
/** 节点数据里的片段重拍状态：src = 来源视频节点，orig = 来源原提示词（留空重跑用），pre = 当前写进提示词的「把 … 中 …：」前缀 */
export type SegRetakeData = { src: string; orig?: string; ranges?: SegRange[]; pre?: string };

export const segRetakeOf = (node: CanvasNode | null | undefined): SegRetakeData | null => {
  const sr = (node?.data as { segRetake?: SegRetakeData } | undefined)?.segRetake;
  return node?.kind === "video" && sr && typeof sr.src === "string" && sr.src ? sr : null;
};

export const SEG_RETAKE_PH = "留空 = 原样重跑一次；也可以先在上面截片段，再写要改什么，例如：把黄色台灯换成白色台灯";

export const fmtSec = (v: number) => { const m = Math.floor(v / 60); const sec = v - m * 60; const s0 = Math.abs(sec - Math.round(sec)) < 0.05 ? String(Math.round(sec)).padStart(2, "0") : sec.toFixed(1).padStart(4, "0"); return String(m).padStart(2, "0") + ":" + s0; };
export const segPrefixOf = (srcId: string, ranges: SegRange[]) => (ranges.length ? `把 ${mentionToken(srcId)} 中 ${ranges.map((r) => fmtSec(r.a) + "–" + fmtSec(r.b)).join("、")}：` : "");

/** 片段重拍要模型能吃参考视频（视频编辑 / 参考视频生视频）：当前模型不行就换一个能用的（优先 Seedance 2.5，和 LibTV 一样） */
export function pickRetakeModel(store: CanvasStore, id: string) {
  const okModel = (m?: { modes?: string[] } | null) => !!m?.modes?.some((x) => x === "视频编辑" || x === "参考视频生视频");
  const n = store.node(id); if (!n) return;
  if (!okModel(store.modelOf(n))) {
    const ms = (store.state.models || []).filter((m) => m.kind === "video" && okModel(m));
    const pick = ms.find((m) => /seedance[_-]?v?2[._]5/i.test(m.id)) || ms.find((m) => m.modes?.includes("视频编辑")) || ms[0];
    if (pick) store.patchGen(id, { params: defaultParams("video", pick) as VideoParams }, { history: false });
  }
  preferSourceVideoMode(store, id);
}

/** 视频节点工具条「片段重拍」：右边新建「原名-片段重拍」节点并选中它 */
export function createSegRetake(ctl: Ctl, src: CanvasNode): CanvasNode | null {
  const store = ctl.store;
  if (src.kind !== "video" || !outOf(src)?.url) { store.toast("这个视频节点还没有视频，没法片段重拍"); return null; }
  const g = genOf(src); const base = g.title.replace(/ · \d+$/, "").replace(/-片段重拍$/, "");
  const fresh = regenAsNew(store, src, undefined, { quiet: true });
  // 提示词清空（留空 = 原样重跑，发送时再补原提示词）；引用模式去掉，免得来源视频因为「没 @」被挡掉
  store.patchGen(fresh.id, { title: base + "-片段重拍", prompt: "", refMode: undefined }, { history: false });
  pickRetakeModel(store, fresh.id);
  store.updateNode(fresh.id, (n) => ({ ...n, data: { ...((n.data as object) || {}), segRetake: { src: src.id, orig: g.prompt || "", ranges: [], pre: "" } } }), { history: false });
  store.setUI({ sel: new Set([fresh.id]), edge: null });
  store.toast(`已在右边新建「${base}-片段重拍」：在节点下方的胶片条上截出要改的片段，写好改法后生成`, 5000);
  return store.node(fresh.id) || null;
}

/** 截的片段变了：节点数据记下片段，提示词开头那句「把 @视频 中 …：」跟着改，用户写在后面的话保留 */
export function setSegRanges(store: CanvasStore, id: string, next: SegRange[]) {
  const n = store.node(id); const sr = segRetakeOf(n); if (!n || !sr) return;
  const cur = genOf(n).prompt || ""; const old = sr.pre || "";
  const pre = segPrefixOf(sr.src, next);
  let rest = old && cur.startsWith(old) ? cur.slice(old.length) : cur;
  // 「留空重跑」时自动补进来的来源原提示词不算改法：截片段后清掉，免得原提示词被当成「这段要改成什么」
  if (next.length && sr.orig && rest.trim() === sr.orig.trim()) rest = "";
  store.updateNode(id, (x) => ({ ...x, data: { ...((x.data as object) || {}), segRetake: { ...sr, ranges: next, pre } } }), { history: false });
  if (pre + rest !== cur) store.patchGen(id, { prompt: pre + rest }, { history: false });
}

/** 生成前检查：截了片段却没写改法 → 不发并提示；什么都没截、提示词留空 → 补上来源原提示词，原样重跑 */
export function segRetakeReady(store: CanvasStore, id: string): boolean {
  const n = store.node(id); const sr = segRetakeOf(n); if (!n || !sr) return true;
  const cur = genOf(n).prompt || ""; const pre = sr.pre || "";
  const rest = pre && cur.startsWith(pre) ? cur.slice(pre.length) : cur;
  if ((sr.ranges || []).length) {
    if (rest.trim() && rest.trim() !== (sr.orig || "").trim()) return true;
    store.toast("先在「把 … 中 …：」后面写上这一段要改成什么，再生成；不写的话模型只会照着原片再拍一遍，看不出变化", 6000);
    return false;
  }
  if (!cur.trim() && sr.orig) store.patchGen(id, { prompt: sr.orig }, { history: false });
  return true;
}

/** 片段重拍节点工具条「替换原视频」：把当前这一版追加成来源节点的新版本（可在版本里切回），
 *  用到来源节点的剪辑时间线片段会跟着换成新视频（TimelineEditor 的来源同步） */
export function replaceSourceWithTake(store: CanvasStore, id: string) {
  const n = store.node(id); const sr = segRetakeOf(n); const o = n ? outOf(n) : null;
  if (!n || !sr || !o?.url) return;
  const src = store.node(sr.src);
  if (!src) { store.toast("来源视频节点已经不在画布上了，没法替换"); return; }
  const g = genOf(src);
  if (g.hist[g.hi]?.url === o.url) { store.toast(`「${g.title}」现在用的已经是这一版了`); return; }
  const hist = [...g.hist, { ...o, meta: { ...(o.meta || {}), retakeOf: id } }];
  store.patchGen(src.id, { hist, hi: hist.length - 1 }, { history: true });
  store.toast(`已把这一版换进「${g.title}」，用到它的剪辑时间线也跟着换了；不满意可以在「${g.title}」的版本里切回第 ${g.hist.length} 版`, 6000);
}

/** 新建的片段重拍节点还没出片：正文直接播来源视频，左上角标出来源 */
export function SegRetakeSource({ node }: { node: CanvasNode }) {
  const sr = segRetakeOf(node);
  const src = useS((s) => (sr ? s.doc.nodes.find((n) => n.id === sr.src) : undefined));
  const url = useAssetUrl(src ? outOf(src)?.url || "" : "");
  const vref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ id: string; t: number }>).detail; const v = vref.current; if (!v || d?.id !== node.id || !Number.isFinite(d.t)) return; try { v.currentTime = d.t; } catch { /* 还没加载 */ } };
    window.addEventListener("cn:segr-seek", on); return () => window.removeEventListener("cn:segr-seek", on);
  }, [node.id]);
  if (!src) return <div className="ph"><Icon name="video" /><span>来源视频节点已经不在画布上了</span></div>;
  return <div className="segr-src">
    {url ? <video ref={vref} src={url} controls playsInline preload="metadata" crossOrigin="anonymous" onPointerDown={(e) => e.stopPropagation()} /> : null}
    <span className="segr-tag"><Icon name="video" size="xs" />{genOf(src).title}</span>
  </div>;
}

/** 选中片段重拍节点时浮在节点和生成面板之间的胶片条 */
export function SegRetakeStrip({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const sr = segRetakeOf(node);
  const src = useS((s) => (sr ? s.doc.nodes.find((n) => n.id === sr.src) : undefined));
  const running = useS((s) => !!s.runtime[node.id]);
  const o = src ? outOf(src) : null;
  if (!sr) return null;
  if (!o?.url) return <div className="segr-none">来源视频节点已经不在画布上了，只能按提示词整段生成</div>;
  return <SegPicker url={o.url} clip={{ inPoint: 0, outPoint: 0, srcDur: Number(o.dur) || 0 }} ranges={sr.ranges || []} locked={running} preview={false}
    onChange={(r) => setSegRanges(store, node.id, r)} onSeek={(t) => window.dispatchEvent(new CustomEvent("cn:segr-seek", { detail: { id: node.id, t } }))} />;
}

/** 片段重拍的选段（交互和 LibTV 一致）：大预览（preview=false 时不带）+ 整段来源视频的胶片条。
 *  点胶片条空白处截一段（默认 3 秒，最多 5 段，不重叠）；拖片段挪位置，拖两端改长短，悬停点 × 删除；
 *  胶片条下沿的亮条是时间线上用到的那一段（入点～出点，没有就不画）；点哪里预览就跳到哪里。 */
export function SegPicker({ url, clip, ranges, onChange, locked, preview = true, onSeek }: { url: string; clip: { inPoint: number; outPoint: number; srcDur?: number }; ranges: SegRange[]; onChange: (r: SegRange[]) => void; locked: boolean; preview?: boolean; onSeek?: (t: number) => void }) {
  const store = useCtl().store;
  const src = useAssetUrl(url);
  const vref = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(Number(clip.srcDur) || clip.outPoint || 0);
  const [now, setNow] = useState(clip.inPoint);
  // 不带大预览时没有 <video> 报时长：单独读一次元数据
  useEffect(() => {
    if (preview || !src || dur) return;
    const v = document.createElement("video"); v.preload = "metadata"; v.muted = true; v.src = src;
    v.onloadedmetadata = () => { if (Number.isFinite(v.duration) && v.duration > 0) setDur(v.duration); v.removeAttribute("src"); v.load(); };
    return () => { v.onloadedmetadata = null; v.removeAttribute("src"); v.load(); };
  }, [preview, src, dur]);
  const cells = useFilmstrip(url, 0, Math.max(0.1, dur), 1100);
  const MAX = 5, MIN = 0.5, DEF = 3;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const sorted = [...ranges].sort((p, q) => p.a - q.a);
  const pct = (v: number) => (dur ? (v / dur) * 100 : 0) + "%";
  const toSec = (x: number) => { const r = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)) * dur; };
  const seek = (t: number) => { const v = vref.current; if (v && Number.isFinite(t)) { try { v.currentTime = t; } catch { /* 还没加载 */ } } setNow(t); onSeek?.(t); };
  /** 第 i 段左右能挪到哪（不压到别的段）；i 省略时按时间点 t 找它所在的空档 */
  const room = (t: number, skip = -1) => {
    let lo = 0, hi = dur;
    sorted.forEach((r, j) => { if (j === skip) return; if (r.b <= t + 1e-6) lo = Math.max(lo, r.b); else if (r.a >= t - 1e-6) hi = Math.min(hi, r.a); });
    return { lo, hi };
  };
  const add = (e: React.PointerEvent) => {
    if (e.button !== 0 || !dur) return;
    e.stopPropagation(); e.preventDefault();
    const t = toSec(e.clientX); seek(t);
    if (locked || sorted.some((r) => t >= r.a && t <= r.b)) return;
    if (sorted.length >= MAX) { store.toast(`最多截 ${MAX} 个片段`); return; }
    const { lo, hi } = room(t);
    if (hi - lo < MIN) { store.toast("这里剩下的空间不够截一段"); return; }
    const len = Math.min(DEF, hi - lo); const a = Math.max(lo, Math.min(t - len / 2, hi - len));
    onChange([...sorted, { a: r2(a), b: r2(a + len) }].sort((p, q) => p.a - q.a));
  };
  const drag = (i: number, mode: "a" | "b" | "move") => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (locked || e.button !== 0) return;
    const r0 = sorted[i]; const { lo, hi } = room((r0.a + r0.b) / 2, i); const t0 = toSec(e.clientX);
    const move = (ev: PointerEvent) => {
      const t = toSec(ev.clientX); let a = r0.a, b = r0.b;
      if (mode === "a") a = Math.max(lo, Math.min(t, r0.b - MIN));
      else if (mode === "b") b = Math.min(hi, Math.max(t, r0.a + MIN));
      else { const d = Math.max(lo - r0.a, Math.min(hi - r0.b, t - t0)); a = r0.a + d; b = r0.b + d; }
      seek(mode === "b" ? b : a);
      onChange(sorted.map((r, j) => (j === i ? { a: r2(a), b: r2(b) } : r)));
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  return <div className="tle-segpick">
    {preview ? <div className="tle-segpick-v">
      <video ref={vref} src={src || undefined} controls playsInline preload="metadata" crossOrigin="anonymous"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); try { e.currentTarget.currentTime = clip.inPoint; } catch { /* ignore */ } }}
        onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
    </div> : null}
    <div className="tle-segpick-row">
      <div className={"tle-segpick-bar" + (locked ? " locked" : "")} ref={bar} data-rt="strip" onPointerDown={add}>
        <span className="tle-segpick-fs">{cells.map((c, i) => <i key={i} style={c ? { backgroundImage: `url("${c}")` } : undefined} />)}</span>
        {dur && clip.outPoint > clip.inPoint ? <span className="tle-segpick-used" title="时间线上用到的部分" style={{ left: pct(clip.inPoint), width: pct(clip.outPoint - clip.inPoint) }} /> : null}
        {!sorted.length ? <span className="tle-segpick-hint">点击可截取新片段</span> : null}
        {sorted.map((r, i) => <span key={i} className="tle-segpick-r" data-rt={"range-" + i} style={{ left: pct(r.a), width: pct(r.b - r.a) }} onPointerDown={drag(i, "move")}>
          <i className="h l" onPointerDown={drag(i, "a")} /><i className="h r" onPointerDown={drag(i, "b")} />
          <em className="tnum">{(r.b - r.a).toFixed(1)}s</em>
          {!locked ? <button className="x" aria-label="删除这段" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onChange(sorted.filter((_, j) => j !== i)); }}><Icon name="x" size="xs" /></button> : null}
        </span>)}
        {dur ? <span className="tle-segpick-ph" style={{ left: pct(now) }} /> : null}
      </div>
      <span className="tle-segpick-n tnum">{sorted.length}/{MAX} 个片段</span>
    </div>
  </div>;
}
