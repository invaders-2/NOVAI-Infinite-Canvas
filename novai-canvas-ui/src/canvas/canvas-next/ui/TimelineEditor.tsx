/**
 * 剪辑时间线节点：预览窗 + 多轨时间线（视频 / 音频 / 字幕）+ 片段属性。
 *
 *   · 素材：画布上的视频、音频、图片（图片按 3 秒静帧放在视频轨，时长可调）；也可以把节点直接拖进来
 *   · 拖片段：视频轨、音频轨调整先后（吸附，不留空），字幕轨自由挪；修剪 / 字幕拖动会吸附到播放头和其它片段边缘（可关）
 *   · 拖片段两端：修剪入点 / 出点（不超过素材长度）
 *   · 点刻度尺或拖播放头定位；滚轮平移，⌘/Ctrl+滚轮缩放，Alt 拖动平移，播放时时间线跟着走
 *   · C（或 S）切开，Q / E 剪掉播放头左 / 右，D 复制片段，M 静音，Delete 删除，Esc 取消选中，空格播放，← → 逐帧（⇧ 一秒），Home / End 跳到首尾
 *   · 片段属性：音量、变速（0.25–4×）、声音淡入淡出、进场转场（黑场淡入 / 交叉溶解）、图片时长、字幕文字与起止时间
 *   · 字幕样式（字号 / 位置）、12 种画幅、720p–4K 清晰度同时作用于预览和导出
 *   · 导出：MP4（NOVAI 后端 ffmpeg 渲染，或桌面版媒体服务）/ WebM（浏览器录制），或直接作为新视频节点放回画布
 * 数据存在 node.clips（旧版 TimelineClip + 可选字段），画幅在 node.ratio，清晰度 / 字幕样式 / 吸附在 node.data。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { backendExportAvailable, exportPlanMp4, novaiTimelineAvailable, renderTimelineNovai } from "../../react-canvas/timelineExportBackend";
import { downloadTimelineBlob } from "../../react-canvas/timelineExport";
import { novaiName } from "./downloadName";
import { genOf, newNode, outOf, uid } from "../model";
import { addFiles } from "../actions";
import { clipable, clipFromNode } from "../playlist";
import { openPop } from "./overlay";
import { dropIndex, duplicate, fadeOf, fmt, frameSize, IMAGE_LEN, lenOf, moveTo, normalize, place, RATIOS, renderPlan, RESES, shiftSub, snapPoints, snapTo, speedOf, SPEEDS, splitAt, tickStep, toSrt, totalOf, trackOf, transOf, trimEdge, volOf, type Clip, type ClipMedia, type Placed, type Track, type TransKind } from "../timelineModel";
import { grabThumb, recordWebM, TimelinePlayer, type SubStyle } from "../timelinePlayer";
import { useCtl, useS } from "./ctx";
import { IS_MAC } from "./shortcuts";
import { Icon } from "./Icon";
import { resolveMediaUrl, useAssetUrl } from "./useAsset";
import { useThumbBg } from "./thumb";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** 工具条只有按在控件上才拦（按钮 / 下拉 / 输入），按在条的空白处不算交互，交给画布拖节点 */
const stopOnControl = (e: React.PointerEvent) => {
  if ((e.target as HTMLElement).closest("button,input,select,textarea,label")) e.stopPropagation();
};
const LAB = 56; // 轨道标签宽度（px）
const TRACKS: Array<{ t: Track; label: string; icon: "video" | "audio" | "text"; h: number }> = [
  { t: "video", label: "画面", icon: "video", h: 46 }, { t: "audio", label: "音频", icon: "audio", h: 34 }, { t: "subtitle", label: "字幕", icon: "text", h: 28 },
];
const MEDIA_LABEL: Record<ClipMedia, string> = { video: "视频", audio: "音频", image: "图片" };
type Drag = { id: string; mode: "move" | "l" | "r"; dt: number; snap: number | null };
type TlData = { tlRes?: string; tlSub?: SubStyle; tlSnap?: boolean };

export function TimelineEditor({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc);
  const clips = useMemo(() => (node.clips || []) as Clip[], [node.clips]);
  const meta = ((node.data as TlData | undefined) || {}) as TlData;
  const ratio = (RATIOS as readonly string[]).includes(String(node.ratio)) ? String(node.ratio) : "16:9";
  const res = (RESES as readonly string[]).includes(String(meta.tlRes)) ? String(meta.tlRes) : "720p";
  const subStyle: SubStyle = { size: meta.tlSub?.size || "m", pos: meta.tlSub?.pos || "bottom" };
  const snapOn = meta.tlSnap !== false;
  const [sel, setSel] = useState<string | null>(null);
  const [t, setT] = useState(0); const tRef = useRef(0); tRef.current = t;
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(36);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const screen = useRef<HTMLCanvasElement>(null); const player = useRef<TimelinePlayer | null>(null);
  const lanes = useRef<HTMLDivElement>(null); const root = useRef<HTMLDivElement>(null);
  const focus = () => root.current?.focus({ preventScroll: true });

  // 拖动中的临时片段表：修剪时实时重排，移动时只平移被拖的那段
  const shown = useMemo(() => {
    if (!drag || drag.mode === "move") return clips;
    return clips.map((c) => (c.id === drag.id ? trimEdge(c, drag.mode as "l" | "r", drag.dt) : c));
  }, [clips, drag]);
  const total = totalOf(shown);
  const selClip = clips.find((c) => c.id === sel) || null;

  const commit = (next: Clip[]) => { store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, clips: normalize(next) })); };
  const setMeta = (p: { ratio?: string } & TlData) => {
    store.snapshot();
    store.updateNode(node.id, (n) => {
      const { ratio: r, ...rest } = p;
      return { ...n, ...(r ? { ratio: r } : {}), ...(Object.keys(rest).length ? { data: { ...((n.data as object) || {}), ...rest } } : {}) };
    });
  };

  /* ---------- 播放引擎 ---------- */
  useEffect(() => {
    const cv = screen.current; if (!cv) return;
    const size = frameSize(ratio, "720p");
    const p = new TimelinePlayer({ canvas: cv, ...size, subStyle, resolve: (u) => resolveMediaUrl(store.backend, u), onTime: (v) => setT(v), onEnd: () => setPlaying(false) });
    player.current = p;
    return () => { p.destroy(); player.current = null; setPlaying(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio, store]);
  useEffect(() => { player.current?.setSubStyle(subStyle); }, [subStyle.size, subStyle.pos]);
  useEffect(() => {
    const p = player.current; if (!p) return; let alive = true;
    void p.setClips(clips).then(() => {
      if (!alive) return;
      if (!p.playing) void p.seek(Math.min(tRef.current, totalOf(clips)));
      // 素材真实时长补进片段（只补缺的 / 超出的，不记历史）
      const fix = p.durations(); const patch = clips.filter((c) => fix[c.id] && !c.pad && (!c.srcDur || c.outPoint > fix[c.id] + 0.05));
      if (patch.length) store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (fix[c.id] && patch.some((x) => x.id === c.id) ? { ...c, srcDur: fix[c.id], outPoint: Math.min(c.outPoint, fix[c.id]), inPoint: Math.min(c.inPoint, Math.max(0, fix[c.id] - 0.1)) } : c)) }));
    });
    return () => { alive = false; };
  }, [clips, ratio, store, node.id]);
  // 播放时让播放头保持在可视范围里
  useEffect(() => {
    if (!playing) return; const el = lanes.current; if (!el) return;
    const x = LAB + t * pps; const view = el.clientWidth;
    if (x > el.scrollLeft + view - 40) el.scrollLeft = x - LAB - 40;
    else if (x < el.scrollLeft + LAB) el.scrollLeft = Math.max(0, x - LAB - 40);
  }, [t, playing, pps]);

  const seek = (v: number) => { const x = Math.max(0, Math.min(total, v)); setT(x); void player.current?.seek(x); };
  const toggle = () => { const p = player.current; if (!p) return; if (p.playing) { p.pause(); setPlaying(false); } else { setPlaying(true); void p.play(tRef.current).catch(() => setPlaying(false)); } };

  /* ---------- 编辑操作 ---------- */
  const split = () => {
    // 选中的片段压着播放头就只切它，否则切所有轨上压着播放头的片段
    const c = sel ? clips.find((x) => x.id === sel) : undefined;
    const p = c ? place(clips, trackOf(c)).find((q) => q.clip.id === sel) : undefined;
    const r = splitAt(clips, t, p && t > p.start && t < p.end ? sel! : undefined, () => uid("clip"));
    if (!r.made.length) { store.toast("播放头要停在片段中间才能切开"); return; }
    commit(r.clips); if (sel && r.made.length === 1) setSel(r.made[0]);
  };
  /** Q / E：把播放头所在片段的左边 / 右边剪掉（只改使用区间，源视频不动） */
  const trimTo = (side: "l" | "r") => {
    const c0 = sel ? clips.find((x) => x.id === sel) : undefined;
    const tracks: Track[] = c0 && trackOf(c0) !== "subtitle" ? [trackOf(c0)] : ["video", "audio"];
    const p = tracks.flatMap((tr) => place(clips, tr)).find((q) => (!c0 || trackOf(c0) === "subtitle" || q.clip.id === c0.id) && t > q.start + 0.05 && t < q.end - 0.05);
    if (!p) { store.toast("播放头要停在片段中间"); return; }
    const next = trimEdge(p.clip, side, side === "l" ? t - p.start : t - p.end);
    commit(clips.map((x) => (x.id === p.clip.id ? next : x))); setSel(p.clip.id);
    if (side === "l") seek(p.start);
  };
  const dup = (id = sel) => { if (!id) return; const nid = uid("clip"); commit(duplicate(clips, id, nid)); setSel(nid); };
  const toggleMute = (id = sel) => { const c = clips.find((x) => x.id === id); if (!c || c.type === "subtitle" || c.mediaKind === "image") return; commit(clips.map((x) => (x.id === id ? { ...x, volume: volOf(x) === 0 ? 1 : 0 } : x))); };
  const locate = (id: string) => { const c = clips.find((x) => x.id === id); const src = c?.sourceNodeId ? store.node(c.sourceNodeId) : null; if (!src) { store.toast("源节点已经不在画布上了"); return; } ctl.focusNode(src.id); };
  const clipMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation(); setSel(id); const c = clips.find((x) => x.id === id);
    openPop(e.currentTarget as HTMLElement, (close) => <>
      <button className="mi" data-clipmenu="dup" onClick={() => { close(); dup(id); }}><Icon name="copy" size="s" />复制片段<span className="k">D</span></button>
      {c && c.type !== "subtitle" && c.mediaKind !== "image" ? <button className="mi" data-clipmenu="mute" onClick={() => { close(); toggleMute(id); }}><Icon name={volOf(c) === 0 ? "volume" : "mute"} size="s" />{volOf(c) === 0 ? "取消静音" : "静音"}<span className="k">M</span></button> : null}
      {c?.type !== "subtitle" ? <button className="mi" data-clipmenu="locate" onClick={() => { close(); locate(id); }}><Icon name="fit" size="s" />定位源节点</button> : null}
      <button className="mi danger" data-clipmenu="remove" onClick={() => { close(); remove(id); }}><Icon name="trash" size="s" />移除片段<span className="k">源节点保留</span></button>
    </>, "down");
  };
  const remove = (id = sel) => { if (!id) return; commit(clips.filter((c) => c.id !== id)); setSel(null); };
  const patchSel = (p: Partial<Clip>, history = false) => { if (!sel) return; if (history) store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (c.id === sel ? { ...c, ...p } : c)) })); };
  const addSource = (s: CanvasNode) => { const c = clipFromNode(s); commit([...clips, c]); setSel(c.id); };
  const addSub = () => {
    const at = Math.min(t, Math.max(0, total - 0.5)); const c: Clip = { id: uid("sub"), sourceNodeId: "", url: "", mediaKind: "video", inPoint: 0, outPoint: 2, order: 9999, type: "subtitle", text: "新字幕", start: Math.round(at * 10) / 10, end: Math.round((at + 2) * 10) / 10 };
    commit([...clips, c]); setSel(c.id);
  };
  const sources = doc.nodes.filter((n) => n.id !== node.id && clipable(n));
  const addMenu = (e: React.MouseEvent, kind: ClipMedia) => {
    const list = sources.filter((s) => s.kind === kind);
    openPop(e.currentTarget as HTMLElement, (close) => <div className="tle-srcpop">
      {list.length ? list.map((s) => <button key={s.id} className="mi" data-src={s.id} onClick={() => { close(); addSource(s); }}><Icon name={kind} size="xs" /><span className="tle-srcname">{genOf(s).title || MEDIA_LABEL[kind]}</span><span className="d tnum">{kind === "image" ? IMAGE_LEN + "s" : outOf(s)?.dur ? fmt(Number(outOf(s)!.dur)) : ""}</span></button>)
        : <span className="tle-empty">画布上还没有{kind === "image" ? "图片" : "生成好的" + MEDIA_LABEL[kind]}</span>}
    </div>, "down");
  };
  const subMenu = (e: React.MouseEvent) => openPop(e.currentTarget as HTMLElement, (close) => <div className="tle-subpop">
    <div className="mh">字号</div>
    <div className="seg">{(["s", "m", "l"] as const).map((k) => <button key={k} className={subStyle.size === k ? "on" : ""} onClick={() => { close(); setMeta({ tlSub: { ...subStyle, size: k } }); }}>{({ s: "小", m: "中", l: "大" })[k]}</button>)}</div>
    <div className="mh">位置</div>
    <div className="seg">{(["top", "middle", "bottom"] as const).map((k) => <button key={k} className={subStyle.pos === k ? "on" : ""} onClick={() => { close(); setMeta({ tlSub: { ...subStyle, pos: k } }); }}>{({ top: "顶部", middle: "居中", bottom: "底部" })[k]}</button>)}</div>
  </div>, "down", "right");

  /* ---------- 拖动 ---------- */
  const scaleOf = () => { const el = lanes.current; if (!el) return 1; const r = el.getBoundingClientRect(); return r.width / Math.max(1, el.offsetWidth); };
  const timeAt = (clientX: number) => { const el = lanes.current!; const r = el.getBoundingClientRect(); return ((clientX - r.left) / scaleOf() + el.scrollLeft - LAB) / pps; };
  const zoomTimeline = (factor: number, clientX?: number) => {
    const el = lanes.current; if (!el) return;
    const next = Math.max(8, Math.min(240, pps * factor)); if (next === pps) return;
    const r = el.getBoundingClientRect(); const offset = clientX == null ? r.width / 2 : (clientX - r.left) / scaleOf();
    const anchorTime = (el.scrollLeft + offset - LAB) / pps;
    setPps(next);
    requestAnimationFrame(() => { el.scrollLeft = Math.max(0, LAB + anchorTime * next - offset); });
  };
  const zoomFit = () => { const el = lanes.current; if (!el) return; setPps(Math.max(8, Math.min(240, (el.clientWidth - LAB - 24) / Math.max(2, total)))); requestAnimationFrame(() => { el.scrollLeft = 0; }); };
  const startPan = (e: React.PointerEvent) => {
    const el = lanes.current; if (!el) return;
    e.stopPropagation(); e.preventDefault(); focus();
    const x0 = e.clientX; const left0 = el.scrollLeft; const k = scaleOf();
    const move = (ev: PointerEvent) => { el.scrollLeft = left0 - (ev.clientX - x0) / k; };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const onLanesWheel = (e: React.WheelEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey || e.metaKey) zoomTimeline(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
    else if (lanes.current) lanes.current.scrollLeft += e.deltaX + e.deltaY;
  };
  /** 拖动量吸附：移动字幕吸首尾，修剪吸被拖的那条边（吸附轨的左边修剪不动位置，不吸） */
  const snapDt = (id: string, mode: Drag["mode"], dt: number, alt: boolean): { dt: number; hit: number | null } => {
    if (!snapOn || alt) return { dt, hit: null };
    const c = clips.find((x) => x.id === id); if (!c) return { dt, hit: null };
    const p = place(clips, trackOf(c)).find((q) => q.clip.id === id); if (!p) return { dt, hit: null };
    const pts = snapPoints(clips, id, tRef.current); const tol = 8 / pps;
    const sub = trackOf(c) === "subtitle";
    if (mode === "move") {
      if (!sub) return { dt, hit: null };
      const a = snapTo(p.start + dt, pts, tol), b = snapTo(p.end + dt, pts, tol);
      if (a.hit != null && (b.hit == null || Math.abs(a.v - (p.start + dt)) <= Math.abs(b.v - (p.end + dt)))) return { dt: a.v - p.start, hit: a.hit };
      if (b.hit != null) return { dt: b.v - p.end, hit: b.hit };
      return { dt, hit: null };
    }
    if (mode === "l" && !sub) return { dt, hit: null };
    const edge = mode === "l" ? p.start : p.end; const r = snapTo(edge + dt, pts, tol);
    return r.hit != null ? { dt: r.v - edge, hit: r.hit } : { dt, hit: null };
  };
  const startDrag = (e: React.PointerEvent, id: string, mode: Drag["mode"]) => {
    e.stopPropagation(); e.preventDefault(); setSel(id); focus();
    const x0 = e.clientX; const k = scaleOf(); let moved = false; let last: Drag = { id, mode, dt: 0, snap: null };
    const move = (ev: PointerEvent) => {
      const raw = (ev.clientX - x0) / k / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return;
      const s = snapDt(id, mode, raw, ev.altKey); last = { id, mode, dt: s.dt, snap: s.hit }; setDrag(last);
    };
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); setDrag(null);
      if (!moved) return;
      const c = clips.find((x) => x.id === id); if (!c) return;
      if (mode === "move") {
        if (trackOf(c) === "subtitle") commit(clips.map((x) => (x.id === id ? shiftSub(x, last.dt) : x)));
        else { const p = place(clips, trackOf(c)).find((q) => q.clip.id === id)!; commit(moveTo(clips, id, dropIndex(clips, id, (p.start + p.end) / 2 + last.dt))); }
      } else commit(clips.map((x) => (x.id === id ? trimEdge(x, mode, last.dt) : x)));
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const scrub = (e: React.PointerEvent) => {
    if (e.altKey || e.button === 1) { startPan(e); return; }
    // 只挪播放头，不动已选中的片段：以前这里顺手 setSel(null)，用户挪完播放头再按 Delete 就什么都不删
    e.stopPropagation(); e.preventDefault(); focus(); seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return; // ⌘Z / ⌘C 等交给画布
    const tag = (e.target as HTMLElement).tagName; e.stopPropagation();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = e.key.toLowerCase();
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (k === "s" || k === "c") { e.preventDefault(); split(); }
    else if (k === "q") { e.preventDefault(); trimTo("l"); }
    else if (k === "e") { e.preventDefault(); trimTo("r"); }
    else if (k === "d") { e.preventDefault(); dup(); }
    else if (k === "m") { e.preventDefault(); toggleMute(); }
    else if (e.key === "Home") { e.preventDefault(); seek(0); }
    else if (e.key === "End") { e.preventDefault(); seek(total); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "Escape") { setSel(null); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); seek(t + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)); }
  };

  const span = Math.max(total + 4, 12); const width = span * pps; const step = tickStep(pps);
  const [w, h] = ratio.split(":").map(Number); const out = frameSize(ratio, res);
  const visualCount = clips.filter((c) => c.type !== "subtitle").length;
  const mp4Available = novaiTimelineAvailable() || backendExportAvailable();

  /** NOVAI：后端渲染 MP4，返回成片地址 */
  const renderMp4 = async (label: string) => {
    const plan = renderPlan(clips);
    setBusy(label + "…");
    return renderTimelineNovai({ ...plan, srt: toSrt(clips), subStyle, ...out, filename: (node.text || "剪辑时间线") + ".mp4" });
  };
  /** 成片作为新视频节点放在时间线右边 */
  const placeResult = (url: string, size: { width: number; height: number }, dur: number) => {
    const vw = 320; const vh = Math.round((vw * size.height) / Math.max(1, size.width));
    const made = newNode("video", node.x + node.w + 120, node.y, { title: (node.text || "剪辑时间线") + " · 成片", hist: [{ url, dur, w: size.width, h: size.height, meta: { model: "剪辑时间线", at: Date.now() } }], uploaded: true, w: vw, h: vh });
    // 节点上的清晰度 / 比例标签按成片实际参数显示
    store.patchGen(made.id, (g) => ({ params: { ...g.params, res, ratio } as typeof g.params }));
    store.addNodes([made], [], { select: true }); ctl.focusNode(made.id);
  };
  const exportToCanvas = async () => {
    player.current?.pause(); setPlaying(false);
    try {
      if (novaiTimelineAvailable()) {
        const r = await renderMp4("合成成片");
        placeResult(r.url, { width: r.width, height: r.height }, r.duration);
        store.toast("成片已放到画布上" + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : ""), 5000);
        return;
      }
      setBusy("合成到画布…");
      const blob = await recordWebM(clips, out, (u) => resolveMediaUrl(store.backend, u), (f) => setBusy(`合成到画布… ${Math.round(f * 100)}%`), subStyle);
      const file = new File([blob], (node.text || "剪辑时间线") + ".webm", { type: blob.type || "video/webm" });
      const had = new Set(store.state.doc.nodes.map((n) => n.id));
      await addFiles(store, [file], { x: node.x + node.w + 120 + 200, y: node.y + 160 });
      const made = store.state.doc.nodes.find((n) => !had.has(n.id) && n.kind === "video");
      if (made) { store.patchGen(made.id, { title: (node.text || "剪辑时间线") + " · 成片" }); ctl.focusNode(made.id); }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 6000); }
    finally { setBusy(null); }
  };
  const exportIt = async (fmtKind: "mp4" | "webm") => {
    player.current?.pause(); setPlaying(false);
    try {
      if (fmtKind === "mp4" && novaiTimelineAvailable()) {
        const r = await renderMp4("导出 MP4");
        const a = document.createElement("a"); a.href = r.url; a.download = novaiName("mp4"); document.body.appendChild(a); a.click(); a.remove();
        store.toast("已导出 MP4" + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : "") + "，文件也保存在输出目录里", 6000);
      } else if (fmtKind === "mp4") {
        setBusy("导出 MP4…");
        const plan = renderPlan(clips);
        const r = await exportPlanMp4({ ...plan, srt: toSrt(clips), ...out, canvasId: store.state.canvasId, onProgress: (v) => setBusy(`导出 MP4… ${Math.round(v)}%`) });
        store.toast("已导出 MP4：" + r.relativePath.split("/").pop() + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : "") + "，导出文件夹已在访达中打开", 6000);
      } else {
        setBusy("导出 WebM…");
        const blob = await recordWebM(clips, out, (u) => resolveMediaUrl(store.backend, u), (f) => setBusy(`导出 WebM… ${Math.round(f * 100)}%`), subStyle);
        downloadTimelineBlob(blob, novaiName("webm")); store.toast("已导出 WebM");
      }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 6000); }
    finally { setBusy(null); }
  };

  const selPlaced = selClip ? place(clips, trackOf(selClip)).find((p) => p.clip.id === selClip.id) : undefined;
  const numIn = (label: string, value: number, onChange: (v: number) => void, o: { min: number; max: number; step: number; unit?: string; key: string }) =>
    <label className="tle-f"><span className="tle-fl">{label}</span><input className="tle-num tnum" type="number" data-tl={o.key} min={o.min} max={o.max} step={o.step} value={value} onFocus={() => store.snapshot()} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.max(o.min, Math.min(o.max, v))); }} />{o.unit ? <span className="tle-unit">{o.unit}</span> : null}</label>;

  /* 不再整块吞掉 pointerdown：编辑器里各控件（片段、标尺、按钮、输入框）自己会 stopPropagation，
     其余空白处交给画布，按住就能拖整个节点——以前只有标题栏能拖 */
  return <div className="tle" ref={root} data-act="timeline" data-drag="" tabIndex={0} onWheel={stop} onKeyDown={onKey} onDoubleClick={stop}>
    <div className="tle-bar" onPointerDown={stopOnControl}>
      <button className="pill" data-tl="add-video" onClick={(e) => addMenu(e, "video")}><Icon name="video" size="xs" />视频</button>
      <button className="pill" data-tl="add-image" onClick={(e) => addMenu(e, "image")}><Icon name="image" size="xs" />图片</button>
      <button className="pill" data-tl="add-audio" onClick={(e) => addMenu(e, "audio")}><Icon name="audio" size="xs" />音频</button>
      <button className="pill" data-tl="add-sub" onClick={addSub}><Icon name="text" size="xs" />字幕</button>
      <span className="tle-gap" />
      <button className="ib tipT" data-tl="split" data-tip="在播放头处切开（C）" disabled={!clips.length} onClick={split}><Icon name="scissors" size="s" /></button>
      <button className="ib tipT" data-tl="dup" data-tip="复制片段（D）" disabled={!sel} onClick={() => dup()}><Icon name="copy" size="s" /></button>
      <button className="ib tipT" data-tl="delete" data-tip="删除选中片段（Delete）" disabled={!sel} onClick={() => remove()}><Icon name="trash" size="s" /></button>
      <button className={"ib tipT" + (snapOn ? " on" : "")} data-tl="snap" data-tip={snapOn ? "吸附：开（拖动时按住 " + (IS_MAC ? "⌥" : "Alt") + " 临时关闭）" : "吸附：关"} onClick={() => setMeta({ tlSnap: !snapOn })}><Icon name="magnet" size="s" /></button>
      <span className="grow" />
      <button className="pill" data-tl="substyle" onClick={subMenu} title="字幕样式"><Icon name="text" size="xs" />{({ s: "小", m: "中", l: "大" })[subStyle.size || "m"]} · {({ top: "顶部", middle: "居中", bottom: "底部" })[subStyle.pos || "bottom"]}</button>
      <select className="tle-sel" data-tl="ratio" value={ratio} onChange={(e) => setMeta({ ratio: e.target.value })} title="画幅">{RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <select className="tle-sel" data-tl="res" value={res} onChange={(e) => setMeta({ tlRes: e.target.value })} title="导出清晰度">{RESES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
    </div>

    <div className="tle-mon"><canvas ref={screen} className="tle-screen" style={{ aspectRatio: `${w} / ${h}` }} />{!clips.length ? <span className="tle-hint">点上方「视频」「图片」「音频」添加素材，或把画布上的节点直接拖进来</span> : null}</div>

    <div className="tle-ctl">
      <button className="ib" data-tl="home" aria-label="跳到开头" onClick={() => seek(0)} disabled={!total}><Icon name="skipb" size="s" /></button>
      <button className="ib tle-play" data-tl="play" aria-label={playing ? "暂停" : "播放"} onClick={toggle} disabled={!total}><Icon name={playing ? "pause" : "play"} size="s" /></button>
      <button className="ib" data-tl="end" aria-label="跳到结尾" onClick={() => seek(total)} disabled={!total}><Icon name="skipf" size="s" /></button>
      <span className="tnum tle-time" data-tl-time>{fmt(t)}<span className="tle-dim"> / {fmt(total)}</span></span>
      <span className="grow" />
      <span className="tle-dim tle-tips">{"滚轮平移 · " + (IS_MAC ? "⌘" : "Ctrl") + "+滚轮缩放"}</span>
      <button className="ib" data-tl="zoom-out" aria-label="缩小时间线" onClick={() => zoomTimeline(1 / 1.4)}>−</button>
      <span className="tnum tle-zoom" data-tl-zoom>{Math.round(pps / 36 * 100)}%</span>
      <button className="ib" data-tl="zoom-in" aria-label="放大时间线" onClick={() => zoomTimeline(1.4)}>+</button>
      <button className="ib tipT" data-tl="zoom-fit" data-tip="缩放到全部可见" onClick={zoomFit} disabled={!total}><Icon name="fit" size="s" /></button>
    </div>

    <div className="tle-lanes" ref={lanes} data-tl="lanes" onWheel={onLanesWheel} onPointerDown={(e) => { if (e.altKey || e.button === 1) startPan(e); }}>
      <div className="tle-inner" style={{ width: width + LAB }}>
        <div className="tle-ruler" data-tl="ruler" onPointerDown={scrub}>
          {Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => <span key={i} className="tle-tick" style={{ left: LAB + i * step * pps }}>{fmt(i * step).replace(/\.0$/, "")}</span>)}
        </div>
        {TRACKS.map((tr) => <div key={tr.t} className={"tle-track k-" + tr.t} style={{ height: tr.h }} data-track={tr.t} onPointerDown={(e) => { if (e.target === e.currentTarget) scrub(e); }}>
          <span className="tle-lab"><Icon name={tr.icon} size="xs" />{tr.label}</span>
          {place(shown, tr.t).map((p, i, all) => <ClipBlock key={p.clip.id} p={p} prev={all[i - 1]?.clip} pps={pps} selected={sel === p.clip.id}
            dx={drag && drag.id === p.clip.id && drag.mode === "move" ? drag.dt * pps : 0} onDown={startDrag} onMenu={clipMenu} />)}
        </div>)}
        {drag?.snap != null ? <span className="tle-snap" style={{ left: LAB + drag.snap * pps }} /> : null}
        <span className="tle-head" style={{ left: LAB + t * pps }} />
      </div>
    </div>

    <div className="tle-insp">
      {selClip ? (selClip.type === "subtitle"
        ? <>
          <Icon name="text" size="xs" /><input className="tle-text" data-tl="subtext" value={selClip.text || ""} placeholder="字幕文字" onChange={(e) => patchSel({ text: e.target.value })} onFocus={() => store.snapshot()} />
          {numIn("开始", Math.round((Number(selClip.start) || 0) * 10) / 10, (v) => patchSel({ start: v, end: Math.max(v + 0.1, Number(selClip.end) || v + 1) }), { min: 0, max: 3600, step: 0.1, unit: "s", key: "substart" })}
          {numIn("结束", Math.round((Number(selClip.end) || 0) * 10) / 10, (v) => patchSel({ end: Math.max((Number(selClip.start) || 0) + 0.1, v) }), { min: 0.1, max: 3600, step: 0.1, unit: "s", key: "subend" })}
        </>
        : <>
          <span className="tle-name" title={selClip.title}>{selClip.title || MEDIA_LABEL[selClip.mediaKind]}</span>
          <span className="tle-dim tnum">{selPlaced ? fmt(selPlaced.start) + " · " : ""}{lenOf(selClip).toFixed(1)}s</span>
          {selClip.mediaKind === "image"
            ? numIn("时长", Math.round(lenOf(selClip) * 10) / 10, (v) => patchSel({ inPoint: 0, outPoint: Math.max(0.1, v) }), { min: 0.1, max: 600, step: 0.5, unit: "s", key: "imgdur" })
            : <>
              <label className="tle-f"><button className="tle-mini" data-tl="mute" aria-label={volOf(selClip) === 0 ? "取消静音" : "静音"} onClick={() => toggleMute()}><Icon name={volOf(selClip) === 0 ? "mute" : "volume"} size="xs" /></button><input type="number" className="tle-num tnum" data-tl="volume" aria-label="音量百分比" min={0} max={200} step={5} value={Math.round(volOf(selClip) * 100)} onFocus={() => store.snapshot()} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) patchSel({ volume: Math.max(0, Math.min(200, v)) / 100 }); }} /><span className="tle-unit">%</span></label>
              <label className="tle-f"><Icon name="gauge" size="xs" /><select className="tle-sel" data-tl="speed" value={String(speedOf(selClip))} onChange={(e) => patchSel({ speed: Number(e.target.value) }, true)}>{SPEEDS.map((v) => <option key={v} value={String(v)}>{v}×</option>)}</select></label>
              {numIn("淡入", Math.round(fadeOf(selClip).in * 10) / 10, (v) => patchSel({ fadeIn: Math.round(v * 1000) }), { min: 0, max: 5, step: 0.1, unit: "s", key: "fadein" })}
              {numIn("淡出", Math.round(fadeOf(selClip).out * 10) / 10, (v) => patchSel({ fadeOut: Math.round(v * 1000) }), { min: 0, max: 5, step: 0.1, unit: "s", key: "fadeout" })}
            </>}
          {selClip.mediaKind !== "audio" ? <label className="tle-f"><span className="tle-fl">转场</span><select className="tle-sel" data-tl="trans" value={selClip.trans || "none"} onChange={(e) => patchSel({ trans: e.target.value as TransKind, transMs: selClip.transMs || 500 }, true)}><option value="none">无</option><option value="fade">黑场淡入</option><option value="dissolve">交叉溶解</option></select></label> : null}
          {selClip.mediaKind !== "audio" && selClip.trans && selClip.trans !== "none" ? numIn("", selClip.transMs || 500, (v) => patchSel({ transMs: v }), { min: 100, max: 2000, step: 100, unit: "ms", key: "transms" }) : null}
        </>)
        : <span className="tle-dim">选中片段可调音量、变速、淡入淡出和转场 · 拖两端修剪 · C 切开 · D 复制 · Q / E 剪掉播放头左 / 右 · 右键更多</span>}
    </div>

    <div className="tle-bar" onPointerDown={stopOnControl}>
      <span className="tle-dim tnum">{visualCount} 段 · {fmt(total)} · {out.width}×{out.height}</span>
      <span className="grow" />{busy ? <span className="tle-busy" data-tl-busy><i className="tle-spin" />{busy}</span> : null}
      {mp4Available ? <button className="pill" data-tl="mp4" disabled={!total || !!busy} onClick={() => void exportIt("mp4")}><Icon name="download" size="xs" />导出 MP4</button> : null}
      <button className="pill" data-tl="webm" disabled={!total || !!busy} onClick={() => void exportIt("webm")}><Icon name="download" size="xs" />导出 WebM</button>
      <button className="pill strong" data-tl="tocanvas" disabled={!total || !!busy} title="合成成片，作为新视频节点放到画布上" onClick={() => void exportToCanvas()}><Icon name="plus" size="xs" />导出到画布</button>
    </div>
  </div>;
}

function ClipBlock({ p, prev, pps, selected, dx, onDown, onMenu }: { p: Placed; prev?: Clip; pps: number; selected: boolean; dx: number; onDown: (e: React.PointerEvent, id: string, mode: Drag["mode"]) => void; onMenu: (e: React.MouseEvent, id: string) => void }) {
  const c = p.clip; const t = trackOf(c); const isImg = c.mediaKind === "image";
  // 时间线上一排小封面只有几十像素高：用缩略图，别为一条时间线拉几十张 4K 原图（失败自动退回原图）
  const cover = useThumbBg(useAssetUrl(t === "video" ? c.thumb || (isImg ? c.url : "") : ""), 160);
  // 没有封面就从视频入点处现取一帧
  const be = useCtl().store.backend; const [grab, setGrab] = useState("");
  useEffect(() => { if (t !== "video" || isImg || c.thumb || !c.url) return; let alive = true; void resolveMediaUrl(be, c.url).then((u) => (u ? grabThumb(u, c.inPoint + 0.05) : "")).then((d) => { if (alive) setGrab(d); }); return () => { alive = false; }; }, [t, isImg, c.thumb, c.url, c.inPoint, be]);
  const thumb = cover || grab;
  const tr = t === "video" ? transOf(c, prev) : null; const k = speedOf(c); const fd = fadeOf(c); const w = Math.max(6, (p.end - p.start) * pps);
  return <div className={"tle-clip k-" + t + (isImg ? " k-image" : "") + (selected ? " on" : "") + (dx ? " drag" : "") + (t !== "subtitle" && volOf(c) === 0 ? " muted" : "")} data-clip={c.id}
    style={{ left: LAB + p.start * pps, width: w, transform: dx ? `translateX(${dx}px)` : undefined, backgroundImage: thumb ? `url("${thumb}")` : undefined }}
    onPointerDown={(e) => { if (e.button === 2) { e.stopPropagation(); return; } onDown(e, c.id, "move"); }} onContextMenu={(e) => onMenu(e, c.id)}>
    {tr && tr.kind !== "none" ? <span className="tle-tr" title={tr.kind === "fade" ? "黑场淡入" : "交叉溶解"} style={{ width: Math.max(6, tr.sec * pps) }} /> : null}
    {t !== "subtitle" && fd.in > 0 ? <span className="tle-fade l" style={{ width: Math.min(w / 2, fd.in * pps) }} /> : null}
    {t !== "subtitle" && fd.out > 0 ? <span className="tle-fade r" style={{ width: Math.min(w / 2, fd.out * pps) }} /> : null}
    <span className="tle-cl">{t === "subtitle" ? c.text : c.title || MEDIA_LABEL[c.mediaKind]}</span>
    {t !== "subtitle" && (volOf(c) !== 1 || k !== 1) ? <span className="tle-badge tnum">{k !== 1 ? k + "×" : ""}{k !== 1 && volOf(c) !== 1 ? " · " : ""}{volOf(c) !== 1 ? (volOf(c) === 0 ? "静音" : Math.round(volOf(c) * 100) + "%") : ""}</span> : null}
    <span className="tle-h l" data-edge="l" onPointerDown={(e) => onDown(e, c.id, "l")} />
    <span className="tle-h r" data-edge="r" onPointerDown={(e) => onDown(e, c.id, "r")} />
  </div>;
}
