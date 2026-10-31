/**
 * 剪辑时间线节点：预览窗 + 多轨时间线（视频 / 音频 / 字幕）+ 片段属性。
 *
 *   · 拖片段：视频轨、音频轨调整先后（吸附，不留空），字幕轨自由挪
 *   · 拖片段两端：修剪入点 / 出点（不超过素材长度）
 *   · 点刻度尺或拖播放头定位；C（或 S）在播放头处切开，Q / E 剪掉播放头左 / 右，右键片段定位源节点，Delete 删除，空格播放 / 暂停，← → 逐帧（⇧ 一秒）
 *   · 选中片段后可调音量（0–200%）、进场转场（黑场淡入 / 交叉溶解）和时长
 *   · 画幅（16:9 / 9:16 / 1:1 / 4:3）和清晰度（720p / 1080p）同时作用于预览和导出
 * 数据存在 node.clips（旧版 TimelineClip + 可选字段），画幅在 node.ratio，清晰度在 node.data.tlRes。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { backendExportAvailable, exportPlanMp4 } from "../../react-canvas/timelineExportBackend";
import { downloadTimelineBlob } from "../../react-canvas/timelineExport";
import { genOf, outOf, uid } from "../model";
import { addFiles } from "../actions";
import { clipFromNode } from "../playlist";
import { openPop } from "./overlay";
import { dropIndex, fmt, frameSize, lenOf, moveTo, normalize, place, RATIOS, renderPlan, RESES, shiftSub, splitAt, tickStep, toSrt, totalOf, trackOf, transOf, trimEdge, volOf, type Clip, type Placed, type Track, type TransKind } from "../timelineModel";
import { grabThumb, recordWebM, TimelinePlayer } from "../timelinePlayer";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { resolveMediaUrl, useAssetUrl } from "./useAsset";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const TRACKS: Array<{ t: Track; label: string; icon: "video" | "audio" | "text"; h: number }> = [
  { t: "video", label: "视频", icon: "video", h: 46 }, { t: "audio", label: "音频", icon: "audio", h: 34 }, { t: "subtitle", label: "字幕", icon: "text", h: 28 },
];
type Drag = { id: string; mode: "move" | "l" | "r"; dt: number };

export function TimelineEditor({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc);
  const clips = useMemo(() => (node.clips || []) as Clip[], [node.clips]);
  const ratio = (RATIOS as readonly string[]).includes(String(node.ratio)) ? String(node.ratio) : "16:9";
  const res = ((node.data as { tlRes?: string } | undefined)?.tlRes === "1080p" ? "1080p" : "720p");
  const [sel, setSel] = useState<string | null>(null);
  const [t, setT] = useState(0); const tRef = useRef(0); tRef.current = t;
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(36);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [adding, setAdding] = useState<null | "video" | "audio">(null);
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
  const setMeta = (p: { ratio?: string; tlRes?: string }) => { store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, ...(p.ratio ? { ratio: p.ratio } : {}), ...(p.tlRes ? { data: { ...((n.data as object) || {}), tlRes: p.tlRes } } : {}) })); };

  /* ---------- 播放引擎 ---------- */
  useEffect(() => {
    const cv = screen.current; if (!cv) return;
    const size = frameSize(ratio, "720p");
    const p = new TimelinePlayer({ canvas: cv, ...size, resolve: (u) => resolveMediaUrl(store.backend, u), onTime: (v) => setT(v), onEnd: () => setPlaying(false) });
    player.current = p;
    return () => { p.destroy(); player.current = null; setPlaying(false); };
  }, [ratio, store]);
  useEffect(() => {
    const p = player.current; if (!p) return; let alive = true;
    void p.setClips(clips).then(() => {
      if (!alive) return;
      if (!p.playing) void p.seek(Math.min(tRef.current, totalOf(clips)));
      // 素材真实时长补进片段（只补缺的 / 超出的，不记历史）
      const fix = p.durations(); const patch = clips.filter((c) => fix[c.id] && (!c.srcDur || c.outPoint > fix[c.id] + 0.05));
      if (patch.length) store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (fix[c.id] && patch.some((x) => x.id === c.id) ? { ...c, srcDur: fix[c.id], outPoint: Math.min(c.outPoint, fix[c.id]), inPoint: Math.min(c.inPoint, Math.max(0, fix[c.id] - 0.1)) } : c)) }));
    });
    return () => { alive = false; };
  }, [clips, ratio, store, node.id]);

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
  const locate = (id: string) => { const c = clips.find((x) => x.id === id); const src = c?.sourceNodeId ? store.node(c.sourceNodeId) : null; if (!src) { store.toast("源节点已经不在画布上了"); return; } ctl.focusNode(src.id); };
  const clipMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation(); setSel(id); const c = clips.find((x) => x.id === id);
    openPop(e.currentTarget as HTMLElement, (close) => <>
      {c?.type !== "subtitle" ? <button className="mi" data-clipmenu="locate" onClick={() => { close(); locate(id); }}><Icon name="fit" size="s" />定位源节点</button> : null}
      <button className="mi danger" data-clipmenu="remove" onClick={() => { close(); remove(id); }}><Icon name="trash" size="s" />移除片段<span className="k">源节点保留</span></button>
    </>, "down");
  };
  const remove = (id = sel) => { if (!id) return; commit(clips.filter((c) => c.id !== id)); setSel(null); };
  const patchSel = (p: Partial<Clip>, history = false) => { if (!sel) return; if (history) store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (c.id === sel ? { ...c, ...p } : c)) })); };
  const addSource = (s: CanvasNode) => { const c = clipFromNode(s); commit([...clips, c]); setAdding(null); setSel(c.id); };
  const addSub = () => {
    const at = Math.min(t, Math.max(0, total - 0.5)); const c: Clip = { id: uid("sub"), sourceNodeId: "", url: "", mediaKind: "video", inPoint: 0, outPoint: 2, order: 9999, type: "subtitle", text: "新字幕", start: Math.round(at * 10) / 10, end: Math.round((at + 2) * 10) / 10 };
    commit([...clips, c]); setSel(c.id);
  };

  /* ---------- 拖动 ---------- */
  const scaleOf = () => { const el = lanes.current; if (!el) return 1; const r = el.getBoundingClientRect(); return r.width / Math.max(1, el.offsetWidth); };
  const timeAt = (clientX: number) => { const el = lanes.current!; const r = el.getBoundingClientRect(); return ((clientX - r.left) / scaleOf() + el.scrollLeft - 56) / pps; };
  const startDrag = (e: React.PointerEvent, id: string, mode: Drag["mode"]) => {
    e.stopPropagation(); e.preventDefault(); setSel(id); focus();
    const x0 = e.clientX; const k = scaleOf(); let moved = false; let last: Drag = { id, mode, dt: 0 };
    const move = (ev: PointerEvent) => { const dt = (ev.clientX - x0) / k / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return; last = { id, mode, dt }; setDrag(last); };
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
    e.stopPropagation(); e.preventDefault(); setSel(null); focus(); seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return; // ⌘Z / ⌘C 等交给画布
    const tag = (e.target as HTMLElement).tagName; e.stopPropagation();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "s" || e.key === "S" || e.key === "c" || e.key === "C") { e.preventDefault(); split(); }
    else if (e.key === "q" || e.key === "Q") { e.preventDefault(); trimTo("l"); }
    else if (e.key === "e" || e.key === "E") { e.preventDefault(); trimTo("r"); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); seek(t + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)); }
  };

  const span = Math.max(total + 4, 12); const width = span * pps; const step = tickStep(pps);
  const sources = doc.nodes.filter((n) => (n.kind === "video" || n.kind === "audio") && (outOf(n)?.url || n.url));
  const [w, h] = ratio.split(":").map(Number);
  /** 导出到画布：用预览引擎合成一遍，作为新的视频节点放在时间线右边 */
  const exportToCanvas = async () => {
    const size = frameSize(ratio, res); player.current?.pause(); setPlaying(false); setBusy("合成到画布…");
    try {
      const blob = await recordWebM(clips, size, (u) => resolveMediaUrl(store.backend, u), (f) => setBusy(`合成到画布… ${Math.round(f * 100)}%`));
      const file = new File([blob], (node.text || "剪辑时间线") + ".webm", { type: blob.type || "video/webm" });
      const had = new Set(store.state.doc.nodes.map((n) => n.id));
      await addFiles(store, [file], { x: node.x + node.w + 120 + 200, y: node.y + 160 });
      const made = store.state.doc.nodes.find((n) => !had.has(n.id) && n.kind === "video");
      if (made) { store.patchGen(made.id, { title: (node.text || "剪辑时间线") + " · 成片" }); ctl.focusNode(made.id); }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 5000); }
    finally { setBusy(null); }
  };
  const exportIt = async (fmtKind: "mp4" | "webm") => {
    const size = frameSize(ratio, res); player.current?.pause(); setPlaying(false);
    setBusy(fmtKind === "mp4" ? "导出 MP4…" : "导出 WebM…");
    try {
      if (fmtKind === "mp4") {
        const plan = renderPlan(clips);
        const r = await exportPlanMp4({ ...plan, srt: toSrt(clips), ...size, canvasId: store.state.canvasId, onProgress: (v) => setBusy(`导出 MP4… ${Math.round(v)}%`) });
        store.toast("已导出 MP4：" + r.relativePath.split("/").pop() + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : "") + "，导出文件夹已在访达中打开", 6000);
      } else {
        const blob = await recordWebM(clips, size, (u) => resolveMediaUrl(store.backend, u), (f) => setBusy(`导出 WebM… ${Math.round(f * 100)}%`));
        downloadTimelineBlob(blob, "剪辑时间线.webm"); store.toast("已导出 WebM");
      }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 5000); }
    finally { setBusy(null); }
  };

  return <div className="tle" ref={root} data-act="timeline" tabIndex={0} onPointerDown={stop} onWheel={stop} onKeyDown={onKey} onDoubleClick={stop}>
    <div className="tle-bar">
      <span className="tle-addw">
        <button className="pill" data-tl="add-video" onClick={() => setAdding(adding === "video" ? null : "video")}><Icon name="video" size="xs" />视频</button>
        <button className="pill" data-tl="add-audio" onClick={() => setAdding(adding === "audio" ? null : "audio")}><Icon name="audio" size="xs" />音频</button>
        <button className="pill" data-tl="add-sub" onClick={addSub}><Icon name="text" size="xs" />字幕</button>
        {adding ? <div className="tle-src">{sources.filter((s) => (adding === "audio") === (s.kind === "audio")).map((s) => <button key={s.id} className="mi" data-src={s.id} onClick={() => addSource(s)}><Icon name={s.kind === "audio" ? "audio" : "video"} size="xs" />{genOf(s).title || (s.kind === "audio" ? "音频" : "视频")}<span className="d">{outOf(s)?.dur ? fmt(Number(outOf(s)!.dur)) : ""}</span></button>)}
          {!sources.some((s) => (adding === "audio") === (s.kind === "audio")) ? <span className="lg-dim">画布上还没有生成好的{adding === "audio" ? "音频" : "视频"}</span> : null}</div> : null}
      </span>
      <span className="vsep" />
      <button className="ib tipT" data-tl="split" data-tip="在播放头处切开（C）" onClick={split}><Icon name="scissors" size="s" /></button>
      <button className="ib tipT" data-tl="delete" data-tip="删除选中片段（Delete）" disabled={!sel} onClick={() => remove()}><Icon name="trash" size="s" /></button>
      <span className="grow" />
      <select className="tle-sel" data-tl="ratio" value={ratio} onChange={(e) => setMeta({ ratio: e.target.value })} title="画幅">{RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <select className="tle-sel" data-tl="res" value={res} onChange={(e) => setMeta({ tlRes: e.target.value })} title="导出清晰度">{RESES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
    </div>

    <div className="tle-mon"><canvas ref={screen} className="tle-screen" style={{ aspectRatio: `${w} / ${h}` }} />{!clips.length ? <span className="tle-hint">点上方「视频」「音频」，或把画布上的视频节点直接拖进来</span> : null}</div>

    <div className="tle-ctl">
      <button className="ib" data-tl="play" aria-label={playing ? "暂停" : "播放"} onClick={toggle} disabled={!total}><Icon name={playing ? "pause" : "play"} size="s" /></button>
      <span className="tnum tle-time" data-tl-time>{fmt(t)} / {fmt(total)}</span>
      <span className="grow" />
      <button className="ib" aria-label="缩小时间线" onClick={() => setPps(Math.max(8, pps / 1.4))}>−</button>
      <button className="ib" aria-label="放大时间线" onClick={() => setPps(Math.min(240, pps * 1.4))}>+</button>
    </div>

    <div className="tle-lanes" ref={lanes}>
      <div className="tle-inner" style={{ width: width + 56 }}>
        <div className="tle-ruler" data-tl="ruler" onPointerDown={scrub}>
          {Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => <span key={i} className="tle-tick" style={{ left: 56 + i * step * pps }}>{fmt(i * step).replace(/\.0$/, "")}</span>)}
        </div>
        {TRACKS.map((tr) => <div key={tr.t} className={"tle-track k-" + tr.t} style={{ height: tr.h }} data-track={tr.t} onPointerDown={(e) => { if (e.target === e.currentTarget) scrub(e); }}>
          <span className="tle-lab"><Icon name={tr.icon} size="xs" />{tr.label}</span>
          {place(shown, tr.t).map((p, i, all) => <ClipBlock key={p.clip.id} p={p} prev={all[i - 1]?.clip} pps={pps} selected={sel === p.clip.id}
            dx={drag && drag.id === p.clip.id && drag.mode === "move" ? drag.dt * pps : 0} onDown={startDrag} onMenu={clipMenu} />)}
        </div>)}
        <span className="tle-head" style={{ left: 56 + t * pps }} />
      </div>
    </div>

    <div className="tle-insp">
      {selClip ? (selClip.type === "subtitle"
        ? <>
          <Icon name="text" size="xs" /><input className="tle-text" data-tl="subtext" value={selClip.text || ""} onChange={(e) => patchSel({ text: e.target.value })} onFocus={() => store.snapshot()} />
          <span className="lg-dim tnum">{fmt(Number(selClip.start) || 0)} – {fmt(Number(selClip.end) || 0)}</span>
        </>
        : <>
          <span className="tle-name" title={selClip.title}>{selClip.title || (selClip.mediaKind === "audio" ? "音频" : "视频")}</span>
          <span className="lg-dim tnum">{fmt(selClip.inPoint)}–{fmt(selClip.outPoint)} · {lenOf(selClip).toFixed(1)}s</span>
          <label className="tle-f"><Icon name={volOf(selClip) === 0 ? "mute" : "volume"} size="xs" /><input type="range" data-tl="volume" min={0} max={200} step={5} value={Math.round(volOf(selClip) * 100)} onPointerDown={() => store.snapshot()} onChange={(e) => patchSel({ volume: Number(e.target.value) / 100 })} /><span className="tnum">{Math.round(volOf(selClip) * 100)}%</span></label>
          {selClip.mediaKind === "video" ? <label className="tle-f">转场<select data-tl="trans" value={selClip.trans || "none"} onChange={(e) => patchSel({ trans: e.target.value as TransKind, transMs: selClip.transMs || 500 }, true)}><option value="none">无</option><option value="fade">黑场淡入</option><option value="dissolve">交叉溶解</option></select></label> : null}
          {selClip.mediaKind === "video" && selClip.trans && selClip.trans !== "none" ? <label className="tle-f"><input type="range" data-tl="transms" min={100} max={2000} step={100} value={selClip.transMs || 500} onPointerDown={() => store.snapshot()} onChange={(e) => patchSel({ transMs: Number(e.target.value) })} /><span className="tnum">{((selClip.transMs || 500) / 1000).toFixed(1)}s</span></label> : null}
        </>)
        : <span className="lg-dim">点片段调音量和转场 · 拖两端修剪 · C 切开 · Q / E 剪掉播放头左 / 右 · 右键片段定位源节点 · 空格播放</span>}
    </div>

    <div className="tle-bar">
      <span className="lg-dim">{clips.filter((c) => c.type !== "subtitle").length} 段 · {fmt(total)} · {frameSize(ratio, res).width}×{frameSize(ratio, res).height}</span>
      <span className="grow" />{busy ? <span className="lg-dim" data-tl-busy>{busy}</span> : null}
      {backendExportAvailable() ? <button className="pill" data-tl="mp4" disabled={!total || !!busy} onClick={() => void exportIt("mp4")}><Icon name="download" size="xs" />导出 MP4</button> : null}
      <button className="pill" data-tl="webm" disabled={!total || !!busy} onClick={() => void exportIt("webm")}><Icon name="download" size="xs" />导出 WebM</button>
      <button className="pill strong" data-tl="tocanvas" disabled={!total || !!busy} title="合成成片，作为新视频节点放到画布上" onClick={() => void exportToCanvas()}><Icon name="plus" size="xs" />导出到画布</button>
    </div>
  </div>;
}

function ClipBlock({ p, prev, pps, selected, dx, onDown, onMenu }: { p: Placed; prev?: Clip; pps: number; selected: boolean; dx: number; onDown: (e: React.PointerEvent, id: string, mode: Drag["mode"]) => void; onMenu: (e: React.MouseEvent, id: string) => void }) {
  const c = p.clip; const t = trackOf(c); const cover = useAssetUrl(t === "video" ? c.thumb || "" : "");
  // 没有封面就从视频入点处现取一帧
  const be = useCtl().store.backend; const [grab, setGrab] = useState("");
  useEffect(() => { if (t !== "video" || c.thumb || !c.url) return; let alive = true; void resolveMediaUrl(be, c.url).then((u) => (u ? grabThumb(u, c.inPoint + 0.05) : "")).then((d) => { if (alive) setGrab(d); }); return () => { alive = false; }; }, [t, c.thumb, c.url, c.inPoint, be]);
  const thumb = cover || grab;
  const tr = t === "video" ? transOf(c, prev) : null;
  return <div className={"tle-clip k-" + t + (selected ? " on" : "") + (dx ? " drag" : "")} data-clip={c.id}
    style={{ left: 56 + p.start * pps, width: Math.max(6, (p.end - p.start) * pps), transform: dx ? `translateX(${dx}px)` : undefined, backgroundImage: thumb ? `url("${thumb}")` : undefined }}
    onPointerDown={(e) => { if (e.button === 2) { e.stopPropagation(); return; } onDown(e, c.id, "move"); }} onContextMenu={(e) => onMenu(e, c.id)}>
    {tr && tr.kind !== "none" ? <span className="tle-tr" title={tr.kind === "fade" ? "黑场淡入" : "交叉溶解"} style={{ width: Math.max(6, tr.sec * pps) }} /> : null}
    <span className="tle-cl">{t === "subtitle" ? c.text : c.title || (t === "audio" ? "音频" : "视频")}</span>
    {t !== "subtitle" && volOf(c) !== 1 ? <span className="tle-vol tnum">{Math.round(volOf(c) * 100)}%</span> : null}
    <span className="tle-h l" data-edge="l" onPointerDown={(e) => onDown(e, c.id, "l")} />
    <span className="tle-h r" data-edge="r" onPointerDown={(e) => onDown(e, c.id, "r")} />
  </div>;
}
