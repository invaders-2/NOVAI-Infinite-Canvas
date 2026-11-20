/**
 * 剪辑时间线节点：预览窗 + 多轨时间线（画面 / 音频 / 字幕）+ 片段属性。
 *
 *   · 素材入轨有三条路：点上方按钮、把节点拖进来、从节点输出口连线到本节点——三条路都会在画布上留下来源连线
 *   · 拖片段：视频轨、音频轨调整先后（吸附，不留空），字幕轨自由挪；多选后整块挪
 *   · 拖片段两端：修剪入点 / 出点（不超过素材长度）
 *   · 点刻度尺或拖播放头定位；滚轮平移，⌘/Ctrl+滚轮缩放，Alt 拖动平移，播放时时间线跟着走
 *   · 快捷键：C 切开、Q / E 剪掉播放头左 / 右、D 复制、M 静音、Delete 删除、Esc 取消选中、空格播放、
 *     ← → 逐帧（⇧ 一秒）、, . 逐帧、I / O 设入出点、⌘A 全选、F 缩放到全部、Home / End 跳到首尾
 *   · 片段属性：音量、变速（0.25–4×）、声音淡入淡出、进场转场（黑场淡入 / 交叉溶解）、图片时长、字幕文字与起止时间
 *   · 轨道头可单独隐藏画面 / 静音音频 / 隐藏字幕；隐藏的轨道不进预览也不进导出
 *   · 片段里是胶片缩略图与真实音频波形（按需取帧 / 解码，都带缓存）；时间码按 30fps 的 MM:SS:FF 显示
 *   · 片段重拍（交互同 LibTV）：选中视频片段点「片段重拍」，新建「原名-片段重拍」节点（来源视频当参考视频），
 *     弹窗里大预览 + 胶片条，点胶片条截片段（最多 5 段），提示词自动写成「把 @视频 中 00:03–00:08：」；出片后换进时间线。
 *     图片片段的「重拍」直接打开来源节点的生成面板。「版本」切的是来源节点的当前版本
 *   · 全屏剪辑：工具条右上角「全屏」或双击节点空白处进入，同一份数据；Esc（没有选中片段时）或「退出全屏」返回画布
 *   · 撤销 / 重做：工具条按钮或 ⌘Z / ⇧⌘Z（与画布共用一条历史）；播放头、拖动修剪都对齐到帧（30fps）
 *   · 画中画轨：视频 / 图片叠在主画面上，自由摆放；选中画面片段可调位置 / 缩放 / 不透明度 / 旋转，或在预览里直接拖动、滚轮缩放
 *   · 关键帧：在播放头处打关键帧（◆），各属性在关键帧之间缓入缓出；有关键帧时改数值会自动记到播放头那一帧
 *   · 用到画中画 / 变换 / 关键帧时，MP4 改由浏览器逐帧合成导出（Mediabunny），和预览完全一致
 *   · 修剪工具：选择（V）/ 滚动编辑（N，挪两段之间的剪辑点）/ 滑移（Y，换用素材里的另一段）/ 滑动（U，在前后两段之间挪）
 *   · 标记点：⇧M 或「标记」在播放头加标记，点标记跳过去、右键删除；拖动时会吸附到标记
 *   · 轨道锁定：锁住的轨道不能拖动 / 修剪 / 删除 / 切开
 *   · 调色（亮度 / 对比 / 饱和）、更多转场（擦除 / 推入 / 放大进场）、背景音乐自动压低（画面有声音时降低音乐）
 *   · AI 剪辑（工具条「AI 剪辑」）：拆镜头（按画面切换点自动切开）、去静音（剪掉停顿和空白，后面的片段自动补上）、
 *     自动字幕（整条时间线的声音转写成带时间的字幕，走「设置 → 通用 → 语音转写」）
 *   · 导出：MP4（NOVAI 后端 ffmpeg 渲染，或桌面版媒体服务）/ WebM（浏览器录制），或直接作为新视频节点放回画布
 *   · 布局：顶栏（添加素材 / AI 剪辑 / 画幅清晰度 / 导出）→ 左预览 + 右属性面板（选中片段的重拍、声音、转场、画面、调色；
 *     没选中时是使用说明和快捷键）→ 工具条 → 轨道。视频自带的声音单独显示在「原声」轨（跟着画面片段走）
 * 数据存在 node.clips（旧版 TimelineClip + 可选字段），画幅在 node.ratio，清晰度 / 字幕样式 / 吸附 / 轨道显隐在 node.data。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { backendExportAvailable, exportPlanMp4, novaiTimelineAvailable, renderTimelineNovai } from "../../react-canvas/timelineExportBackend";
import { downloadTimelineBlob } from "../../react-canvas/timelineExport";
import { novaiName } from "./downloadName";
import { defaultParams, genOf, isGenKind, newNode, outOf, uid, type GenOutput, type VideoParams } from "../model";
import { GenPanel } from "./GenPanel";
import { preferSourceVideoMode, regenAsNew } from "../engine";
import { mentionToken } from "../mentions";
import { addFiles } from "../actions";
import { clipable, clipFromNode, syncTimelineEdges } from "../playlist";
import { closePop, openPop } from "./overlay";
import { baseTf, EXPORT_PRESETS, type ExportPreset, isFree, keyAt, needsCompositor, nextOf, prevOf, rollEdit, slideEdit, slipEdit, TRANS_LABEL, tfAt, upsertKey, type Tf, duplicate, fadeOf, fmt, fmtTC, frameSec, frameSize, IMAGE_LEN, lenOf, moveGroupTo, normalize, place, RATIOS, renderPlan, RESES, shiftSub, snapPoints, snapTo, speedOf, SPEEDS, splitAt, tickStep, toSrt, totalOf, trackOf, transOf, trimEdge, volOf, type Clip, type ClipMedia, type Placed, type Track, type TransKind } from "../timelineModel";
import { grabThumb, recordWebM, TimelinePlayer, type SubStyle } from "../timelinePlayer";
import { exportMp4Browser } from "../timelineExportMp4";
import { exportProjectZip } from "../timelineInterchange";
import { detectScenes, detectSilence, mixToWav, transcribeSegments } from "../timelineAI";
import { useFilmstrip } from "../timelineFilmstrip";
import { peaksOf, usePeaks, WaveStrip, type Peaks } from "../timelineWave";
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
const LAB = 108; // 轨道标签宽度（px）：显隐按钮 + 轨名 + 添加 + 锁定，片段从它右边开始
const MEDIA_LABEL: Record<ClipMedia, string> = { video: "视频", audio: "音频", image: "图片" };
const SHORT: Record<string, number> = { "720p": 720, "1080p": 1080, "2K": 1440, "4K": 2160 };
type Drag = { id: string; ids: Set<string>; mode: "move" | "l" | "r" | "roll" | "slip" | "slide"; dt: number; snap: number | null };
type Mark = { t: number };
type TlData = { tlRes?: string; tlSub?: SubStyle; tlSnap?: boolean; tlFit?: "contain" | "cover"; tlTracks?: Partial<Record<Track | "vaudio", boolean>>; tlLock?: Partial<Record<Track, boolean>>; tlMarks?: Mark[]; tlPending?: Pending[] };
/** 重拍中的片段：存在节点数据里，弹窗关了、退出全屏、刷新画布后出片也照样换进时间线 */
type Pending = { clipId: string; nodeId: string; base: number; seg?: boolean };
type Tool = "select" | "roll" | "slip" | "slide";
const TOOLS: Array<{ id: Tool; label: string; key: string; tip: string }> = [
  { id: "select", label: "选择", key: "V", tip: "选择：拖动换位置，拖两端修剪（V）" },
  { id: "roll", label: "滚动", key: "N", tip: "滚动编辑：拖两段之间的剪辑点，左边变长右边等量变短，总时长不变（N）" },
  { id: "slip", label: "滑移", key: "Y", tip: "滑移：片段位置和长度不变，左右拖换用素材里的另一段（Y）" },
  { id: "slide", label: "滑动", key: "U", tip: "滑动：片段不变，在前后两段之间左右挪，前后两段跟着变长变短（U）" },
];
type IO = { a: number; b: number };
type Box = { x: number; y: number; w: number; h: number };

export function TimelineEditor({ node, full, onFull }: { node: CanvasNode; full?: boolean; onFull?: (on: boolean) => void }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc);
  const clips = useMemo(() => (node.clips || []) as Clip[], [node.clips]);
  const meta = ((node.data as TlData | undefined) || {}) as TlData;
  const ratio = (RATIOS as readonly string[]).includes(String(node.ratio)) ? String(node.ratio) : "16:9";
  const res = (RESES as readonly string[]).includes(String(meta.tlRes)) ? String(meta.tlRes) : "720p";
  const subStyle: SubStyle = { size: meta.tlSub?.size || "m", pos: meta.tlSub?.pos || "bottom" };
  const snapOn = meta.tlSnap !== false;
  const fit = meta.tlFit === "cover" ? "cover" : "contain";
  const hidden = useMemo(() => (meta.tlTracks || {}) as Partial<Record<Track | "vaudio", boolean>>, [meta.tlTracks]);
  const hideKey = (hidden.video ? 1 : 0) + (hidden.audio ? 2 : 0) + (hidden.subtitle ? 4 : 0) + (hidden.overlay ? 8 : 0) + (hidden.vaudio ? 16 : 0);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [t, setT] = useState(0); const tRef = useRef(0); tRef.current = t;
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(36);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [io, setIo] = useState<IO | null>(null);
  const [loop, setLoop] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  /** 轨道横向滚动量：滚到轨道头底下的播放头 / 标记线不画，免得在轨道头之间的缝里露出来 */
  const [lanesX, setLanesX] = useState(0);
  const locked = (meta.tlLock || {}) as Partial<Record<Track, boolean>>;
  const marks = useMemo(() => ((meta.tlMarks || []) as Mark[]).filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t), [meta.tlMarks]);
  const isLocked = (c: Clip) => !!locked[trackOf(c)];
  const screen = useRef<HTMLCanvasElement>(null); const player = useRef<TimelinePlayer | null>(null);
  const lanes = useRef<HTMLDivElement>(null); const root = useRef<HTMLDivElement>(null); const mon = useRef<HTMLDivElement>(null);
  const focus = () => root.current?.focus({ preventScroll: true });

  // 拖动中的临时片段表：修剪时实时重排，移动时只平移被拖的那段
  const shown = useMemo(() => {
    if (!drag || drag.mode === "move") return clips;
    if (drag.mode === "roll") return rollEdit(clips, drag.id, drag.dt);
    if (drag.mode === "slide") return slideEdit(clips, drag.id, drag.dt);
    if (drag.mode === "slip") return clips.map((c) => (c.id === drag.id ? slipEdit(c, drag.dt) : c));
    return clips.map((c) => (c.id === drag.id ? trimEdge(c, drag.mode as "l" | "r", drag.dt) : c));
  }, [clips, drag]);
  // 隐藏的轨道不进预览 / 导出，也不显示片段
  const visRaw = useMemo(() => shown.filter((c) => !hidden[trackOf(c)]), [shown, hideKey]);
  // 「原声」轨静音 = 画面里视频自带的声音都不出（预览 / 导出一致）；界面上的片段仍按原音量显示
  const visible = useMemo(() => (hidden.vaudio ? visRaw.map((c) => (c.mediaKind === "video" && (trackOf(c) === "video" || trackOf(c) === "overlay") ? { ...c, volume: 0 } : c)) : visRaw), [visRaw, hideKey]);
  const total = totalOf(visible);
  const selClips = useMemo(() => visRaw.filter((c) => sel.has(c.id)), [visRaw, sel]);
  const selOne = selClips.length === 1 ? selClips[0] : null;
  const selPlaced = selOne ? place(clips, trackOf(selOne)).find((p) => p.clip.id === selOne.id) : undefined;
  const tl = useRef({ t: 0, total: 0 }); tl.current = { t, total };

  const commit = (next: Clip[]) => { store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, clips: normalize(next) })); };
  const setMeta = (p: { ratio?: string } & TlData) => {
    store.snapshot();
    store.updateNode(node.id, (n) => {
      const { ratio: r, ...rest } = p;
      return { ...n, ...(r ? { ratio: r } : {}), ...(Object.keys(rest).length ? { data: { ...((n.data as object) || {}), ...rest } } : {}) };
    });
  };
  const setSelSafe = (next: Set<string>) => setSel(next);

  /* ---------- 来源同步：片段的来源节点 = 画布上的那条连线 ---------- */
  useEffect(() => {
    syncTimelineEdges(store, node.id);
    // 源节点重新生成出新版本时，片段跟着换素材（否则时间线里还是旧片子）；只补缺的，不记历史
    const patch = clips.flatMap((c) => {
      const src = c.sourceNodeId ? store.node(c.sourceNodeId) : null; if (!src) return [];
      const o = outOf(src); const url = o?.url || src.url || ""; if (!url || url === c.url) return [];
      const dur = Number(o?.dur) > 0 ? Number(o!.dur) : 0;
      return [{ id: c.id, url, ...(o?.frame && o.frame !== c.thumb ? { thumb: o.frame } : {}), ...(dur ? { srcDur: dur } : {}) }];
    });
    if (!patch.length) return;
    const by = new Map(patch.map((p) => [p.id, p]));
    store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (by.has(c.id) ? { ...c, ...by.get(c.id)! } : c)) }), { history: false });
  }, [clips, doc, node.id, store]);

  /* ---------- 播放引擎 ---------- */
  // 预览按节点的实际大小挑够用的清晰度档：760px 的节点没必要按 4K 逐帧画
  const previewRes = useMemo(() => {
    const need = Math.min(2160, Math.max(720, Math.round((full ? window.innerWidth * 0.62 : node.w) * 1.15)));
    return RESES.find((r) => (SHORT[r] || 720) >= need) || "4K";
  }, [node.w, full]);
  useEffect(() => {
    const cv = screen.current; if (!cv) return;
    const size = frameSize(ratio, previewRes);
    const p = new TimelinePlayer({ canvas: cv, ...size, subStyle, fit, resolve: (u) => resolveMediaUrl(store.backend, u), onTime: (v) => setT(v), onEnd: () => setPlaying(false) });
    player.current = p;
    return () => { p.destroy(); player.current = null; setPlaying(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio, previewRes, store]);
  useEffect(() => { player.current?.setSubStyle(subStyle); }, [subStyle.size, subStyle.pos]);
  useEffect(() => { player.current?.setFit(fit); }, [fit]);
  useEffect(() => { player.current?.setRange(loop && io ? { start: io.a, end: io.b } : null, loop); }, [io, loop]);
  useEffect(() => {
    const p = player.current; if (!p) return; let alive = true;
    void p.setClips(visible).then(() => {
      if (!alive) return;
      if (!p.playing) void p.seek(Math.min(tRef.current, totalOf(visible)));
      // 素材真实时长补进片段（只补缺的 / 超出的，不记历史）
      const fix = p.durations(); const patch = visible.filter((c) => fix[c.id] && !c.pad && (!c.srcDur || c.outPoint > fix[c.id] + 0.05));
      if (patch.length) store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (fix[c.id] && patch.some((x) => x.id === c.id) ? { ...c, srcDur: fix[c.id], outPoint: Math.min(c.outPoint, fix[c.id]), inPoint: Math.min(c.inPoint, Math.max(0, fix[c.id] - 0.1)) } : c)) }));
    });
    return () => { alive = false; };
  }, [visible, ratio, previewRes, store, node.id]);
  // 播放时让播放头保持在可视范围里
  useEffect(() => {
    if (!playing) return; const el = lanes.current; if (!el) return;
    const x = LAB + t * pps; const view = el.clientWidth;
    if (x > el.scrollLeft + view - 40) el.scrollLeft = x - LAB - 40;
    else if (x < el.scrollLeft + LAB) el.scrollLeft = Math.max(0, x - LAB - 40);
  }, [t, playing, pps]);

  /** 时间对齐到帧（30fps）：播放头、修剪、切开都落在帧边界上，导出时不会出现半帧 */
  const toFrame = (v: number) => Math.round(v / frameSec) * frameSec;
  const seekNow = (v: number) => { const x = Math.max(0, Math.min(total, toFrame(v))); setT(x); void player.current?.seek(x); };
  // 拖动播放头：连续 seek 会排大队，只保留最后一个目标
  const scrubTo = (v: number) => { const x = Math.max(0, Math.min(total, toFrame(v))); setT(x); player.current?.requestSeek(x); };
  const toggle = () => { const p = player.current; if (!p) return; if (p.playing) { p.pause(); setPlaying(false); } else { setPlaying(true); void p.play(tRef.current).catch(() => setPlaying(false)); } };

  /* ---------- 选中 ---------- */
  const pick = (e: React.PointerEvent | React.MouseEvent, id: string): Set<string> => {
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    if (multi) { const next = new Set(sel); if (next.has(id)) next.delete(id); else next.add(id); setSel(next); return next; }
    if (sel.has(id) && sel.size > 1) return sel; // 已选中的一段按下去：留着多选，方便整块拖
    const next = new Set([id]); setSel(next); return next;
  };

  /* ---------- 编辑操作 ---------- */
  const split = () => {
    // 选中的片段压着播放头就只切它，否则切所有轨上压着播放头的片段
    const picked = selOne && place(clips, trackOf(selOne)).some((q) => q.clip.id === selOne.id && t > q.start && t < q.end) ? selOne.id : undefined;
    const lockedClips = clips.filter(isLocked);
    const r0 = splitAt(clips.filter((c) => !isLocked(c)), t, picked && !lockedClips.some((c) => c.id === picked) ? picked : undefined, () => uid("clip"));
    const r = { clips: normalize([...r0.clips, ...lockedClips]), made: r0.made };
    if (!r.made.length) { store.toast("播放头要停在片段中间才能切开"); return; }
    commit(r.clips); if (r.made.length === 1) setSel(new Set(r.made));
  };
  /** Q / E：把播放头所在片段的左边 / 右边剪掉（只改使用区间，源视频不动） */
  const trimTo = (side: "l" | "r") => {
    const c0 = selOne; const tracks: Track[] = c0 && trackOf(c0) !== "subtitle" ? [trackOf(c0)] : ["video", "audio"];
    const p = tracks.flatMap((tr) => place(clips, tr)).find((q) => (!c0 || trackOf(c0) === "subtitle" || q.clip.id === c0.id) && t > q.start + 0.05 && t < q.end - 0.05);
    if (!p) { store.toast("播放头要停在片段中间"); return; }
    const next = trimEdge(p.clip, side, side === "l" ? t - p.start : t - p.end);
    commit(clips.map((x) => (x.id === p.clip.id ? next : x))); setSel(new Set([p.clip.id]));
    if (side === "l") seekNow(p.start);
  };
  const dup = () => {
    const ids = selClips.length ? selClips.map((c) => c.id) : [];
    if (!ids.length) return;
    let next = clips; const made: string[] = [];
    for (const id of ids) { const nid = uid("clip"); next = duplicate(next, id, nid); if (next.some((x) => x.id === nid)) made.push(nid); }
    commit(next); setSel(new Set(made));
  };
  const toggleMute = () => {
    const list = selClips.filter((c) => c.type !== "subtitle" && c.mediaKind !== "image");
    if (!list.length) return;
    const muted = list.every((c) => volOf(c) === 0);
    const ids = new Set(list.map((c) => c.id));
    commit(clips.map((x) => (ids.has(x.id) ? { ...x, volume: muted ? 1 : 0 } : x)));
  };
  const locate = (id: string) => { const c = clips.find((x) => x.id === id); const src = c?.sourceNodeId ? store.node(c.sourceNodeId) : null; if (!src) { store.toast("源节点已经不在画布上了"); return; } ctl.focusNode(src.id); };
  const clipMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation(); const ids = pick(e, id);
    const c = clips.find((x) => x.id === id); const many = ids.size > 1;
    openPop(e.currentTarget as HTMLElement, (close) => <>
      <button className="mi" data-clipmenu="dup" onClick={() => { close(); dup(); }}><span className="ic"><Icon name="copy" size="s" /></span>{many ? `复制 ${ids.size} 段` : "复制片段"}<span className="k">D</span></button>
      {c && c.type !== "subtitle" && c.mediaKind !== "image" ? <button className="mi" data-clipmenu="mute" onClick={() => { close(); toggleMute(); }}><span className="ic"><Icon name={volOf(c) === 0 ? "volume" : "mute"} size="s" /></span>{volOf(c) === 0 ? "取消静音" : "静音"}<span className="k">M</span></button> : null}
      {!many && c && (trackOf(c) === "video" || trackOf(c) === "overlay") ? <button className="mi" data-clipmenu="layer" onClick={() => { close(); toggleLayer(c); }}><span className="ic"><Icon name="layers" size="s" /></span>{trackOf(c) === "overlay" ? "移回主画面轨" : "移到画中画轨"}</button> : null}
      {!many && canRetake(c) ? <button className="mi" data-clipmenu="retake" onClick={() => { close(); if (c) openRetake(c); }}><span className="ic"><Icon name="camera" size="s" /></span>{c?.mediaKind === "video" ? "片段重拍" : "重拍"}</button> : null}
      {c?.type !== "subtitle" ? <button className="mi" data-clipmenu="locate" onClick={() => { close(); locate(id); }}><span className="ic"><Icon name="fit" size="s" /></span>定位源节点</button> : null}
      <button className="mi danger" data-clipmenu="remove" onClick={() => { close(); remove(); }}><span className="ic"><Icon name="trash" size="s" /></span>{many ? `移除 ${ids.size} 段` : "移除片段"}<span className="k">源节点保留</span></button>
    </>, "down");
  };
  const remove = () => {
    const ids = new Set(selClips.filter((c) => !isLocked(c)).map((c) => c.id));
    if (!ids.size) { if (selClips.length) store.toast("选中的片段所在轨道已锁定"); return; }
    commit(clips.filter((c) => !ids.has(c.id))); setSel(new Set());
  };
  // 片段选中后，Delete/Backspace 一律删片段：焦点在画布或右键菜单上（例如右键节点后再按 Delete）也能用。
  // 输入框/可编辑区不抢；画布上已选节点/连线时让画布自己处理（那时用户意图是删节点）。
  const selRef = useRef(sel); selRef.current = sel;
  const removeRef = useRef(remove); removeRef.current = remove;
  useEffect(() => {
    const onWinKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selRef.current.size) return;
      if (store.state.ui.sel.size || store.state.ui.edge) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault(); e.stopPropagation();
      closePop();
      removeRef.current();
    };
    window.addEventListener("keydown", onWinKey, true);
    return () => window.removeEventListener("keydown", onWinKey, true);
  }, [store]);
  /** 批量改片段属性（多选时作用于全部选中） */
  const patchSel = (p: Partial<Clip>, history = false) => {
    const ids = new Set(selClips.map((c) => c.id)); if (!ids.size) return;
    if (history) store.snapshot();
    store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => (ids.has(c.id) ? { ...c, ...p } : c)) }));
  };
  /* ── 片段重拍（和 LibTV 同一套交互）：
   *   视频片段 → 在来源节点右边新建「原名-片段重拍」节点（来源视频连成它的参考视频），弹窗里是大预览 + 胶片条：
   *   在胶片条上点一下截一段（最多 5 段），提示词自动写成「把 @视频 中 00:03–00:08：」，后面写要怎么改；
   *   不截片段 = 整段重来（沿用原提示词）。出片后换进时间线（片段改跟新节点走，入出点不变）。
   *   图片片段 → 直接打开来源节点的生成面板，出新版本自动替换。 ── */
  type SegRange = { a: number; b: number };
  const [retake, setRetake] = useState<{ clipId: string; nodeId: string; base: number; seg?: { src: string; orig: string } } | null>(null);
  const [ranges, setRanges] = useState<SegRange[]>([]);
  const segPrefix = useRef("");
  const retakeSrc = useS((s) => (retake ? s.doc.nodes.find((n) => n.id === retake.nodeId) : undefined));
  const retakeRun = useS((s) => (retake ? s.runtime[retake.nodeId] : undefined));
  const retakeClip = retake ? clips.find((c) => c.id === retake.clipId) : undefined;
  const canRetake = (c: Clip | null | undefined): CanvasNode | null => {
    if (!c || c.type === "subtitle" || !c.sourceNodeId) return null;
    const src = store.node(c.sourceNodeId);
    return src && isGenKind(src.kind) ? src : null;
  };
  const openRetake = (c: Clip) => {
    const src = canRetake(c);
    if (!src) { store.toast(c.sourceNodeId ? "来源节点已经不在画布上了，没法重拍" : "这个片段不是画布上生成的，没法重拍"); return; }
    setSel(new Set([c.id])); setRanges([]); segPrefix.current = "";
    if (c.mediaKind !== "video" || src.kind !== "video") { const base = genOf(src).hist.length; setRetake({ clipId: c.id, nodeId: src.id, base }); addPending({ clipId: c.id, nodeId: src.id, base }); return; }
    const g = genOf(src); const base = g.title.replace(/ · \d+$/, "").replace(/-片段重拍$/, "");
    const fresh = regenAsNew(store, src, undefined, { quiet: true });
    store.patchGen(fresh.id, { title: base + "-片段重拍" }, { history: false });
    // 片段重拍要模型能吃参考视频（视频编辑 / 参考视频生视频）：当前模型不行就换一个能用的（优先 Seedance 2.5，和 LibTV 一样）
    const okModel = (m?: { modes?: string[] } | null) => !!m?.modes?.some((x) => x === "视频编辑" || x === "参考视频生视频");
    if (!okModel(store.modelOf(store.node(fresh.id)!))) {
      const ms = (store.state.models || []).filter((m) => m.kind === "video" && okModel(m));
      const pick = ms.find((m) => /seedance[_-]?v?2[._]5/i.test(m.id)) || ms.find((m) => m.modes?.includes("视频编辑")) || ms[0];
      if (pick) store.patchGen(fresh.id, { params: defaultParams("video", pick) as VideoParams }, { history: false });
    }
    preferSourceVideoMode(store, fresh.id);
    store.setUI({ sel: new Set(), edge: null });
    setRetake({ clipId: c.id, nodeId: fresh.id, base: 0, seg: { src: src.id, orig: g.prompt || "" } });
    addPending({ clipId: c.id, nodeId: fresh.id, base: 0, seg: true });
  };
  const pendingOf = () => (((store.node(node.id)?.data as TlData | undefined)?.tlPending) || []) as Pending[];
  const setPending = (list: Pending[]) => store.updateNode(node.id, (n) => ({ ...n, data: { ...((n.data as object) || {}), tlPending: list.length ? list : undefined } }), { history: false });
  const addPending = (p: Pending) => setPending([...pendingOf().filter((x) => x.clipId !== p.clipId), p]);
  /** 关掉弹窗：片段重拍新建的节点要是还没生成过、也没在跑，就当没开过，删掉不留垃圾 */
  const closeRetake = () => {
    const r = retake; setRetake(null); if (!r) return;
    const n = store.node(r.nodeId); const running = !!(n && store.state.runtime[n.id]);
    // 还在生成：继续盯着，出片后照样换进时间线；没生成过：不用盯了（片段重拍新建的空节点顺手删掉）
    if (running) return;
    const p = pendingOf().find((x) => x.nodeId === r.nodeId);
    if (n && p && genOf(n).hist.length > p.base) return;
    setPending(pendingOf().filter((x) => x.nodeId !== r.nodeId));
    if (r.seg && n && !genOf(n).hist.length) store.removeNodes([n.id]);
  };
  const fmtSec = (v: number) => { const m = Math.floor(v / 60); const sec = v - m * 60; const s0 = Math.abs(sec - Math.round(sec)) < 0.05 ? String(Math.round(sec)).padStart(2, "0") : sec.toFixed(1).padStart(4, "0"); return String(m).padStart(2, "0") + ":" + s0; };
  /** 截的片段变了：把提示词开头那句「把 @视频 中 …：」跟着改，用户写在后面的话保留 */
  const setSegRanges = (next: SegRange[]) => {
    setRanges(next);
    if (!retake?.seg) return; const n = store.node(retake.nodeId); if (!n) return;
    const cur = genOf(n).prompt || ""; const old = segPrefix.current;
    const pre = next.length ? `把 ${mentionToken(retake.seg.src)} 中 ${next.map((r) => fmtSec(r.a) + "–" + fmtSec(r.b)).join("、")}：` : "";
    let rest = old && cur.startsWith(old) ? cur.slice(old.length) : cur;
    if (!old && next.length && rest === retake.seg.orig) rest = "";
    const np = !next.length && !rest.trim() ? retake.seg.orig : pre + rest;
    segPrefix.current = pre;
    if (np !== cur) store.patchGen(n.id, { prompt: np }, { history: false });
  };
  /** 把来源节点的某个版本换进片段：时长尽量不变（新视频更短就用新视频的长度），这样后面的片段不会被挤动。
   *  seg（片段重拍）：新视频是整段重新生成的，入出点原样保留；片段改跟新节点走 */
  const applyTake = (clipId: string, o: GenOutput | undefined, seg?: { nodeId: string }) => {
    if (!o || !o.url) return;
    store.snapshot();
    store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((c) => {
      if (c.id !== clipId) return c;
      const isImg = c.mediaKind === "image";
      const next: Clip = { ...c, url: o.url!, thumb: o.frame || (isImg ? o.url : undefined), ...(seg ? { sourceNodeId: seg.nodeId } : {}) };
      if (isImg) return next;
      const dur = Number(o.dur) > 0 ? Number(o.dur) : 0;
      if (seg && (!dur || dur >= c.outPoint - 0.05)) return { ...next, ...(dur ? { srcDur: dur } : {}) };
      const len = Math.max(0.1, c.outPoint - c.inPoint);
      return { ...next, inPoint: 0, outPoint: dur ? Math.min(dur, len) : len, ...(dur ? { srcDur: dur } : {}) };
    }) }));
  };
  // 重拍出片 → 换进时间线。盯的是节点数据里的 tlPending，所以弹窗关掉、退出全屏、刷新画布后出片也一样自动换进来
  const pendKey = JSON.stringify(meta.tlPending || []);
  useEffect(() => {
    const list = (meta.tlPending || []) as Pending[]; if (!list.length) return;
    let changed = false; const next: Pending[] = [];
    for (const p of list) {
      const n = store.node(p.nodeId); const c = clips.find((x) => x.id === p.clipId);
      if (!n || !c) { changed = true; continue; }
      const g = genOf(n);
      if (g.hist.length > p.base) {
        const o = g.hist[g.hi];
        if (o?.url) {
          applyTake(p.clipId, o, p.seg ? { nodeId: n.id } : undefined);
          store.toast(p.seg ? `片段重拍完成，已换进剪辑时间线（「${g.title}」节点留在画布上）` : "新版本已换进剪辑时间线，不满意可以再拍或在「版本」里切回去", 5000);
        }
        changed = true;
        // 弹窗还开着：接着盯下一次生成
        if (retake && retake.nodeId === p.nodeId) next.push({ ...p, base: g.hist.length });
        continue;
      }
      next.push(p);
    }
    if (changed) setPending(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pendKey]);
  useEffect(() => { if (retake && !clips.some((c) => c.id === retake.clipId)) setRetake(null); }, [retake, clips]);
  const retakeView = retake && retakeSrc ? createPortal(
    <div className="modal-bg tle-rt-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) closeRetake(); }}>
      <div className={"modal tle-rt" + (retake.seg ? " seg" : "")} role="dialog" aria-label="片段重拍" onPointerDown={(e) => e.stopPropagation()}>
        <div className="mhd">
          <Icon name="camera" size="s" /><span>{retake.seg ? "片段重拍" : "重拍"}</span><span className="tle-rt-n">{genOf(retakeSrc).title}</span>
          {retakeRun ? <span className="tle-busy"><i className="tle-spin" />生成中，可以关掉窗口，出片后自动换进剪辑时间线</span> : null}
          <span className="sp" />
          <button className="ib" aria-label="关闭" onClick={closeRetake}><Icon name="x" size="s" /></button>
        </div>
        <div className="mbd">
          {retake.seg && retakeClip
            ? <SegPicker url={retakeClip.url} clip={retakeClip} ranges={ranges} onChange={setSegRanges} locked={!!retakeRun} />
            : <p className="tle-rt-tip">改提示词或参数后生成，新版本会自动替换这个片段</p>}
          <div id="gp" className={"tle-rt-gp" + (retakeSrc.kind === "video" ? " gp-video" : "")}><GenPanel node={retakeSrc} /></div>
          {retake.seg ? <p className="tle-note">{ranges.length ? "只会改动框出的片段，其余部分尽量保持原样。" : "没有截片段：整段重新生成（来源视频作为参考）。"}需要支持「参考视频生视频」或「视频编辑」的模型；新节点会留在画布上。</p> : null}
        </div>
      </div>
    </div>, (document.querySelector(".cn-root") as HTMLElement | null) || document.body) : null;

  /* ── AI 剪辑 ── */
  const aiTarget = (needAudio: boolean): { c: Clip; p: Placed } | null => {
    const c = selOne;
    if (!c || c.type === "subtitle" || !c.url || c.mediaKind === "image" || (!needAudio && c.mediaKind === "audio")) { store.toast(needAudio ? "先选中一段视频或音频" : "先选中一段视频"); return null; }
    if (isLocked(c)) { store.toast("这条轨道已锁定"); return null; }
    const p = place(clips, trackOf(c)).find((q) => q.clip.id === c.id); return p ? { c, p } : null;
  };
  const aiScenes = async () => {
    const tg = aiTarget(false); if (!tg) return;
    const { c, p } = tg; setBusy("正在找镜头切换点…");
    try {
      const cuts = await detectScenes(await resolveMediaUrl(store.backend, c.url), c.inPoint, c.outPoint);
      if (!cuts.length) { store.toast("这段里没找到明显的镜头切换"); return; }
      let next = clips; const k = speedOf(c);
      // 从后往前切：左半段保留原 id，前面的切点还落在它身上
      for (const cut of [...cuts].sort((x, y) => y - x)) next = splitAt(next, p.start + (cut - c.inPoint) / k, c.id, () => uid("clip")).clips;
      commit(next); store.toast(`按镜头切成了 ${cuts.length + 1} 段`);
    } catch (e) { store.toast("拆镜头失败：" + (e instanceof Error ? e.message : "读不到视频")); }
    finally { setBusy(null); }
  };
  const aiSilence = async () => {
    const tg = aiTarget(true); if (!tg) return;
    const { c } = tg; setBusy("正在找静音段…");
    try {
      const gaps = await detectSilence(await resolveMediaUrl(store.backend, c.url), c.inPoint, c.outPoint);
      if (gaps == null) { store.toast("这段没有声音轨，没法去静音"); return; }
      if (!gaps.length) { store.toast("没找到超过 0.5 秒的静音"); return; }
      // 留下的区间 = 片段区间减去静音段；吸附轨上后面的片段会自动往前补
      const keep: Array<[number, number]> = []; let cur = c.inPoint;
      for (const [a, b] of gaps) { if (a - cur >= 0.15) keep.push([cur, a]); cur = Math.max(cur, b); }
      if (c.outPoint - cur >= 0.15) keep.push([cur, c.outPoint]);
      if (!keep.length) { store.toast("整段都是静音，没有动它"); return; }
      const k = speedOf(c); let at = Number(c.start) || 0;
      const parts: Clip[] = keep.map(([a, b], i) => {
        const part: Clip = { ...c, id: i ? uid("clip") : c.id, inPoint: Math.round(a * 1000) / 1000, outPoint: Math.round(b * 1000) / 1000, order: c.order + i * 0.01, kf: undefined, ...(i ? { trans: "none" as TransKind, transMs: 0 } : {}) };
        if (trackOf(c) === "overlay") { part.start = Math.round(at * 1000) / 1000; at += (b - a) / k; }
        return part;
      });
      const cut = gaps.reduce((sum, [a, b]) => sum + (b - a), 0) / k;
      commit(clips.flatMap((x) => (x.id === c.id ? parts : [x])));
      store.toast(`去掉了 ${gaps.length} 处静音，共 ${cut.toFixed(1)} 秒`);
    } catch (e) { store.toast("去静音失败：" + (e instanceof Error ? e.message : "读不到声音")); }
    finally { setBusy(null); }
  };
  const aiSubs = async () => {
    if (!total) return;
    setBusy("正在混合时间线的声音…");
    try {
      const audio = await mixToWav(visible, total, (u) => resolveMediaUrl(store.backend, u));
      if (!audio) { store.toast("时间线里没有声音，生成不了字幕"); return; }
      setBusy("正在转写成字幕…");
      const r = await transcribeSegments(audio, "zh");
      if (!r.ok || !r.segments.length) { store.toast(r.error || "没有转写出字幕", 6000); return; }
      // 模型给的时间偶尔太短（一两个字 0.3 秒）：每条至少按字数留够阅读时间，往后顺延但不压到下一条
      const segs = r.segments.map((g) => ({ ...g })).sort((a, b) => a.start - b.start);
      segs.forEach((g, i) => {
        const need = Math.max(0.7, g.text.length * 0.16); const next = segs[i + 1];
        if (g.end - g.start < need) g.end = Math.min(g.start + need, next ? Math.max(g.end, next.start) : total);
        if (next && next.start < g.end) next.start = g.end;
        g.start = Math.round(Math.min(g.start, total) * 100) / 100; g.end = Math.round(Math.min(Math.max(g.end, g.start + 0.3), total) * 100) / 100;
      });
      const subs: Clip[] = segs.filter((g) => g.end > g.start).map((g) => ({ id: uid("sub"), sourceNodeId: "", url: "", mediaKind: "video", inPoint: 0, outPoint: 2, order: 9999, type: "subtitle", text: g.text, start: g.start, end: g.end }));
      const had = clips.filter((x) => x.type === "subtitle").length;
      commit([...clips.filter((x) => x.type !== "subtitle"), ...subs]);
      store.toast(`生成了 ${subs.length} 条字幕` + (had ? `（替换了原来的 ${had} 条，撤销可以找回）` : ""), 5000);
    } catch (e) { store.toast("自动字幕失败：" + (e instanceof Error ? e.message : "未知错误")); }
    finally { setBusy(null); }
  };
  const aiMenu = (e: React.MouseEvent) => openPop(e.currentTarget as HTMLElement, (close) => <div className="tle-menu" data-tl-ai>
    <div className="mh">AI 剪辑</div>
    <button className="mi" data-ai="scenes" disabled={!!busy} onClick={() => { close(); void aiScenes(); }}><span className="ic"><Icon name="scissors" size="s" /></span><span className="tle-mi-t">拆镜头<span className="d">选中一段视频，按画面切换点自动切开</span></span></button>
    <button className="mi" data-ai="silence" disabled={!!busy} onClick={() => { close(); void aiSilence(); }}><span className="ic"><Icon name="mute" size="s" /></span><span className="tle-mi-t">去静音<span className="d">选中一段，剪掉停顿和空白，后面自动补上</span></span></button>
    <button className="mi" data-ai="subs" disabled={!!busy || !total} onClick={() => { close(); void aiSubs(); }}><span className="ic"><Icon name="text" size="s" /></span><span className="tle-mi-t">自动字幕<span className="d">整条时间线的人声转成带时间的字幕</span></span></button>
  </div>, "down");

  /* ── 标记点 / 轨道锁定 ── */
  const addMark = () => { const at = Math.round(t * 1000) / 1000; if (marks.some((m) => Math.abs(m.t - at) < frameSec)) return; setMeta({ tlMarks: [...marks, { t: at }] }); };
  const delMark = (at: number) => setMeta({ tlMarks: marks.filter((m) => Math.abs(m.t - at) >= 1e-3) });
  const jumpMark = (dir: 1 | -1) => { const hit = dir > 0 ? marks.find((m) => m.t > t + 1e-3) : [...marks].reverse().find((m) => m.t < t - 1e-3); if (hit) seekNow(hit.t); };
  const toggleLock = (tr: Track) => setMeta({ tlLock: { ...locked, [tr]: !locked[tr] } });

  /* ── 画面变换 / 关键帧 ── */
  const isVisual = (c: Clip | null | undefined): c is Clip => !!c && (trackOf(c) === "video" || trackOf(c) === "overlay");
  const placedOf = (c: Clip) => place(clips, trackOf(c)).find((q) => q.clip.id === c.id);
  /** 播放头在片段里的相对时间（不在片段里就夹到首尾） */
  const localT = (c: Clip) => { const p = placedOf(c); return p ? Math.max(0, Math.min(p.end - p.start, t - p.start)) : 0; };
  /** 改变换：有关键帧就记到播放头这一帧，没有就改静态值 */
  const patchTf = (c: Clip, patch: Partial<Tf>, history = false) => {
    if (history) store.snapshot();
    store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((x) => {
      if (x.id !== c.id) return x;
      if (x.kf && x.kf.length) return upsertKey(x, localT(x), patch);
      return { ...x, tf: { ...(x.tf || {}), ...patch } };
    }) }));
  };
  const addKey = (c: Clip) => { store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, clips: ((n.clips || []) as Clip[]).map((x) => (x.id === c.id ? upsertKey(x, localT(x), {}) : x)) })); };
  const delKey = (c: Clip) => { const lt = localT(c); commit(clips.map((x) => (x.id === c.id ? { ...x, kf: (x.kf || []).filter((k) => Math.abs(k.t - lt) >= 1 / 60) } : x))); };
  const clearKeys = (c: Clip) => { const f = tfAt(c, localT(c)); commit(clips.map((x) => (x.id === c.id ? { ...x, kf: undefined, tf: { ...f } } : x))); };
  const resetTf = (c: Clip) => commit(clips.map((x) => (x.id === c.id ? { ...x, tf: undefined, kf: undefined } : x)));
  const jumpKey = (c: Clip, dir: 1 | -1) => {
    const p = placedOf(c); if (!p) return; const lt = t - p.start;
    const ks = (c.kf || []).map((k) => k.t).sort((a, b) => a - b);
    const hit = dir > 0 ? ks.find((k) => k > lt + 1e-3) : [...ks].reverse().find((k) => k < lt - 1e-3);
    if (hit != null) seekNow(p.start + hit);
  };
  const toggleLayer = (c: Clip) => {
    const p = placedOf(c);
    commit(clips.map((x) => (x.id !== c.id ? x : trackOf(x) === "overlay" ? { ...x, layer: undefined, start: undefined, tf: undefined, kf: undefined, order: 9999 } : { ...x, layer: "overlay", start: p ? p.start : t, trans: "none", transMs: 0 })));
  };
  /** 在预览里直接拖动选中的画面片段（改位置），滚轮缩放 */
  const monDown = (e: React.PointerEvent) => {
    const c = selOne; if (!isVisual(c)) return; const p = placedOf(c); if (!p || t < p.start || t >= p.end) return;
    const cv = screen.current; if (!cv) return;
    e.stopPropagation(); e.preventDefault(); focus();
    const r = cv.getBoundingClientRect(); const f0 = tfAt(c, localT(c)); const x0 = e.clientX, y0 = e.clientY; let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved) { moved = true; store.snapshot(); }
      patchTf(c, { x: Math.round((f0.x + (ev.clientX - x0) / r.width) * 1000) / 1000, y: Math.round((f0.y + (ev.clientY - y0) / r.height) * 1000) / 1000 });
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  // React 的 onWheel 挂在 passive 监听上，preventDefault 不生效还会刷警告；改由下面这条原生非 passive 监听负责阻止页面滚动
  useEffect(() => {
    const el = mon.current; if (!el) return;
    const block = (ev: WheelEvent) => ev.preventDefault();
    el.addEventListener("wheel", block, { passive: false });
    return () => el.removeEventListener("wheel", block);
  }, []);
  const monWheel = (e: React.WheelEvent) => {
    const c = selOne; if (!isVisual(c)) return; const p = placedOf(c); if (!p || t < p.start || t >= p.end) return;
    e.stopPropagation();
    const f = tfAt(c, localT(c)); patchTf(c, { s: Math.max(0.05, Math.min(5, Math.round(f.s * (e.deltaY < 0 ? 1.06 : 1 / 1.06) * 1000) / 1000)) });
  };

  const addSource = (s: CanvasNode, overlay = false) => {
    const c0 = clipFromNode(s); const c: Clip = overlay ? { ...c0, layer: "overlay", start: Math.round(t * 1000) / 1000 } : c0; store.snapshot();
    // 与连线路径一致：片段与来源连线一起产生
    store.mutate((d) => {
      const linked = d.edges.some((e) => e.from === s.id && e.to === node.id);
      return {
        ...d,
        nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, clips: normalize([...((n.clips || []) as Clip[]), c]) } : n)),
        ...(linked ? {} : { edges: [...d.edges, { id: uid("e"), from: s.id, to: node.id }] }),
      };
    });
    setSel(new Set([c.id]));
  };
  const addSub = () => {
    const at = Math.min(t, Math.max(0, total - 0.5)); const c: Clip = { id: uid("sub"), sourceNodeId: "", url: "", mediaKind: "video", inPoint: 0, outPoint: 2, order: 9999, type: "subtitle", text: "新字幕", start: Math.round(at * 10) / 10, end: Math.round((at + 2) * 10) / 10 };
    commit([...clips, c]); setSel(new Set([c.id]));
  };
  const sources = doc.nodes.filter((n) => n.id !== node.id && clipable(n));
  const ADD_KINDS: Array<{ k: ClipMedia | "overlay"; icon: "video" | "image" | "layers" | "audio"; label: string; d: string }> = [
    { k: "video", icon: "video", label: "视频", d: "接到画面轨末尾，自带的声音放进「原声」轨" },
    { k: "image", icon: "image", label: "图片", d: "默认 " + IMAGE_LEN + " 秒，可在右侧改时长" },
    { k: "overlay", icon: "layers", label: "画中画", d: "从播放头处叠在主画面上，可拖动缩放" },
    { k: "audio", icon: "audio", label: "音频", d: "配乐、配音放到音频轨" },
  ];
  /** 选素材：列出画布上能用的节点（统一 NOVAI 菜单样式：图标块 + 标题 + 说明） */
  const addMenu = (e: React.MouseEvent | { currentTarget: Element }, kind: ClipMedia | "overlay") => {
    const overlay = kind === "overlay";
    const list = sources.filter((s) => (overlay ? s.kind === "video" || s.kind === "image" : s.kind === kind));
    const meta0 = ADD_KINDS.find((x) => x.k === kind)!;
    openPop(e.currentTarget as HTMLElement, (close) => <div className="tle-menu" data-tl-src={kind}>
      <div className="mh">添加{meta0.label}{overlay ? " · 叠加到播放头 " + fmtTC(t) : ""}</div>
      {list.length ? list.map((s) => { const o = outOf(s); return <button key={s.id} className="mi" data-src={s.id} onClick={() => { close(); addSource(s, overlay); }}>
        <span className="ic"><Icon name={s.kind === "image" ? "image" : s.kind === "audio" ? "audio" : "video"} size="s" /></span>
        <span className="tle-mi-t">{genOf(s).title || MEDIA_LABEL[s.kind as ClipMedia]}</span>
        <span className="k tnum">{s.kind === "image" ? IMAGE_LEN + "s" : o?.dur ? fmt(Number(o.dur)) : ""}</span></button>; })
        : <div className="tle-menu-empty">画布上还没有{overlay ? "视频或图片" : kind === "image" ? "图片" : "生成好的" + MEDIA_LABEL[kind as ClipMedia]}节点。先在画布上生成或上传，再回来添加。</div>}
      <div className="tle-menu-foot">也可以直接把画布上的节点拖到时间线里</div>
    </div>, "down");
  };
  /** 「添加素材」入口：先选类型，再选画布上的节点 */
  const addRoot = (e: React.MouseEvent) => openPop(e.currentTarget as HTMLElement, (close) => <div className="tle-menu" data-tl-add>
    <div className="mh">添加到时间线</div>
    {ADD_KINDS.map((x) => <button key={x.k} className="mi" data-add={x.k} onClick={(ev) => addMenu({ currentTarget: ev.currentTarget }, x.k)}>
      <span className="ic"><Icon name={x.icon} size="s" /></span><span className="tle-mi-t">{x.label}<span className="d">{x.d}</span></span><Icon name="right" size="xs" className="tle-mi-go" /></button>)}
    <button className="mi" data-add="sub" onClick={() => { close(); addSub(); }}><span className="ic"><Icon name="text" size="s" /></span><span className="tle-mi-t">字幕<span className="d">在播放头处加一条，右侧改文字；也可用「AI 剪辑 → 自动字幕」</span></span></button>
  </div>, "down");

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
  /** 拖动量吸附：移动吸首尾，修剪吸被拖的那条边（吸附轨的左边修剪不动位置，不吸） */
  const snapDt = (id: string, mode: Drag["mode"], dt: number, alt: boolean): { dt: number; hit: number | null } => {
    if (!snapOn || alt) return { dt, hit: null };
    const c = clips.find((x) => x.id === id); if (!c) return { dt, hit: null };
    const p = place(clips, trackOf(c)).find((q) => q.clip.id === id); if (!p) return { dt, hit: null };
    const pts = snapPoints(clips, id, tRef.current, marks.map((m) => m.t)); const tol = 8 / pps;
    const sub = isFree(trackOf(c));
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
  const startDrag = (e: React.PointerEvent, id: string, mode0: Drag["mode"]) => {
    e.stopPropagation(); if (e.button === 2) return; e.preventDefault();
    const c0 = clips.find((x) => x.id === id);
    // 锁住的轨道：只能选中，不能拖
    if (c0 && isLocked(c0)) { pick(e, id); focus(); return; }
    // 修剪工具只作用在吸附轨（画面 / 音频）上；自由轨（画中画 / 字幕）照常
    let mode: Drag["mode"] = mode0; let target = id;
    if (c0 && !isFree(trackOf(c0)) && tool !== "select") {
      if (tool === "roll") {
        if (mode0 === "r" && nextOf(clips, id)) mode = "roll";
        else if (mode0 === "l") { const pv = prevOf(clips, id); if (pv) { mode = "roll"; target = pv.id; } }
      } else if (tool === "slip" && mode0 === "move") mode = "slip";
      else if (tool === "slide" && mode0 === "move" && prevOf(clips, id) && nextOf(clips, id)) mode = "slide";
    }
    const ids = mode === "move" ? pick(e, id) : (() => { const next = new Set([id]); setSel(next); return next; })();
    focus();
    if (mode === "roll" || mode === "slip" || mode === "slide") {
      const x0 = e.clientX; const k = scaleOf(); let moved = false; let last: Drag = { id: target, ids, mode, dt: 0, snap: null };
      const move = (ev: PointerEvent) => { const raw = (ev.clientX - x0) / k / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return; last = { ...last, dt: toFrame(raw) }; setDrag(last); };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); setDrag(null);
        if (!moved || !last.dt) return;
        if (mode === "roll") commit(rollEdit(clips, target, last.dt));
        else if (mode === "slide") commit(slideEdit(clips, target, last.dt));
        else commit(clips.map((x) => (x.id === target ? slipEdit(x, last.dt) : x)));
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return;
    }
    const x0 = e.clientX; const k = scaleOf(); let moved = false; let last: Drag = { id, ids, mode, dt: 0, snap: null };
    const move = (ev: PointerEvent) => {
      const raw = (ev.clientX - x0) / k / pps; if (Math.abs(ev.clientX - x0) > 3) moved = true; if (!moved) return;
      const s = snapDt(id, mode, raw, ev.altKey); last = { id, ids, mode, dt: s.hit != null ? s.dt : toFrame(s.dt), snap: s.hit }; setDrag(last);
    };
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); setDrag(null);
      if (!moved) return;
      const c = clips.find((x) => x.id === id); if (!c) return;
      if (mode === "move") {
        if (isFree(trackOf(c))) commit(clips.map((x) => (ids.has(x.id) && trackOf(x) === trackOf(c) ? shiftSub(x, last.dt) : x)));
        else { const p = place(clips, trackOf(c)).find((q) => q.clip.id === id)!; commit(moveGroupTo(clips, id, ids, (p.start + p.end) / 2 + last.dt)); }
      } else commit(clips.map((x) => (x.id === id ? trimEdge(x, mode as "l" | "r", last.dt) : x)));
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  /** 刻度尺：只挪播放头 */
  const scrub = (e: React.PointerEvent) => {
    if (e.altKey || e.button === 1) { startPan(e); return; }
    e.stopPropagation(); e.preventDefault(); focus(); scrubTo(timeAt(e.clientX));
    const move = (ev: PointerEvent) => scrubTo(timeAt(ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  /** 轨道空白处：单击挪播放头，拖出选择框 */
  const laneDown = (e: React.PointerEvent) => {
    if (e.altKey || e.button === 1) { startPan(e); return; }
    e.stopPropagation(); e.preventDefault(); focus();
    const el = lanes.current!; const r = el.getBoundingClientRect(); const x0 = e.clientX, y0 = e.clientY;
    const base = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(sel) : new Set<string>();
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
      moved = true;
      setBox({ x: Math.min(ev.clientX, x0) - r.left + el.scrollLeft, y: Math.min(ev.clientY, y0) - r.top, w: Math.abs(ev.clientX - x0), h: Math.abs(ev.clientY - y0) });
    };
    const up = (ev: PointerEvent) => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); setBox(null);
      if (!moved) { setSel(new Set()); scrubTo(timeAt(ev.clientX)); return; }
      const x1 = Math.min(ev.clientX, x0), x2 = Math.max(ev.clientX, x0), y1 = Math.min(ev.clientY, y0), y2 = Math.max(ev.clientY, y0);
      const hit = [...(el.querySelectorAll<HTMLElement>(".tle-clip"))].filter((c) => { const b = c.getBoundingClientRect(); return b.left < x2 && b.right > x1 && b.top < y2 && b.bottom > y1; }).map((c) => c.dataset.clip!).filter(Boolean);
      setSel(new Set([...base, ...hit]));
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  /** 设入 / 出点，第二次按就成区间 */
  const markIO = (edge: "in" | "out") => {
    const v = Math.max(0, Math.min(total, Math.round(t * 1000) / 1000));
    setIo((prev) => {
      const next: IO = edge === "in" ? { a: v, b: prev ? prev.b : total } : { a: prev ? prev.a : 0, b: v };
      if (next.b - next.a < 0.1) return prev;
      return { a: Math.min(next.a, next.b), b: Math.max(next.a, next.b) };
    });
    setLoop(true);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === "a") { e.preventDefault(); e.stopPropagation(); setSel(new Set(visRaw.map((c) => c.id))); return; }
    if ((e.metaKey || e.ctrlKey) && k === "z") { const tag0 = (e.target as HTMLElement).tagName; if (tag0 === "INPUT" || tag0 === "TEXTAREA") return; e.preventDefault(); e.stopPropagation(); if (e.shiftKey) store.redo(); else store.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k === "y") { e.preventDefault(); e.stopPropagation(); store.redo(); return; }
    if (e.metaKey || e.ctrlKey) return; // ⌘C 等交给画布
    const tag = (e.target as HTMLElement).tagName; e.stopPropagation();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (k === "s" || k === "c") { e.preventDefault(); split(); }
    else if (k === "q") { e.preventDefault(); trimTo("l"); }
    else if (k === "e") { e.preventDefault(); trimTo("r"); }
    else if (k === "d") { e.preventDefault(); dup(); }
    else if (k === "m" && e.shiftKey) { e.preventDefault(); addMark(); }
    else if (k === "m") { e.preventDefault(); toggleMute(); }
    else if (k === "v") { e.preventDefault(); setTool("select"); }
    else if (k === "n") { e.preventDefault(); setTool("roll"); }
    else if (k === "y") { e.preventDefault(); setTool("slip"); }
    else if (k === "u") { e.preventDefault(); setTool("slide"); }
    else if (k === "i") { e.preventDefault(); markIO("in"); }
    else if (k === "o") { e.preventDefault(); markIO("out"); }
    else if (k === "f") { e.preventDefault(); zoomFit(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTimeline(1.25); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomTimeline(1 / 1.25); }
    else if (e.key === "," ) { e.preventDefault(); seekNow(t - frameSec); }
    else if (e.key === ".") { e.preventDefault(); seekNow(t + frameSec); }
    else if (e.key === "Home") { e.preventDefault(); seekNow(0); }
    else if (e.key === "End") { e.preventDefault(); seekNow(total); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "Escape") { if (sel.size || !full) setSel(new Set()); else onFull?.(false); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); seekNow(t + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : frameSec)); }
  };

  const span = Math.max(total + 4, 12); const width = span * pps; const step = tickStep(pps);
  const [w, h] = ratio.split(":").map(Number); const out = frameSize(ratio, res);
  const visualCount = visible.filter((c) => c.type !== "subtitle").length;
  const mp4Available = novaiTimelineAvailable() || backendExportAvailable();

  /** NOVAI：后端渲染 MP4，返回成片地址 */
  const renderMp4 = async (label: string, size = out) => {
    const plan = renderPlan(visible);
    setBusy(label + "…");
    return renderTimelineNovai({ ...plan, srt: toSrt(visible), subStyle, ...size, filename: (node.text || "剪辑时间线") + ".mp4" });
  };
  /** 成片作为新视频节点放在时间线右边 */
  const placeResult = (url: string, size: { width: number; height: number }, dur: number) => {
    const vw = 320; const vh = Math.round((vw * size.height) / Math.max(1, size.width));
    const made = newNode("video", node.x + node.w + 120, node.y, { title: (node.text || "剪辑时间线") + " · 成片", hist: [{ url, dur, w: size.width, h: size.height, meta: { model: "剪辑时间线", at: Date.now() } }], uploaded: true, w: vw, h: vh });
    // 节点上的清晰度 / 比例标签按成片实际参数显示
    store.patchGen(made.id, (g) => ({ params: { ...g.params, res, ratio } as typeof g.params }));
    store.addNodes([made], [], { select: true }); ctl.focusNode(made.id);
  };
  /** 用到画中画 / 变换 / 关键帧时：浏览器逐帧合成 MP4（后端 ffmpeg 渲染不了这些） */
  const composite = needsCompositor(visible);
  const browserMp4 = async (label: string, size = out) => {
    setBusy(label + "…");
    return exportMp4Browser(visible, size, (u) => resolveMediaUrl(store.backend, u), { subStyle, fit, onProgress: (f, step) => setBusy(`${label}：${step} ${Math.round(f * 100)}%`) });
  };
  const exportToCanvas = async () => {
    player.current?.pause(); setPlaying(false);
    try {
      if (composite) {
        const blob = await browserMp4("合成成片");
        const file = new File([blob], (node.text || "剪辑时间线") + ".mp4", { type: "video/mp4" });
        const had = new Set(store.state.doc.nodes.map((n) => n.id));
        await addFiles(store, [file], { x: node.x + node.w + 120 + 200, y: node.y + 160 });
        const made = store.state.doc.nodes.find((n) => !had.has(n.id) && n.kind === "video");
        if (made) { store.patchGen(made.id, { title: (node.text || "剪辑时间线") + " · 成片" }); ctl.focusNode(made.id); }
        store.toast("成片已放到画布上");
        return;
      }
      if (novaiTimelineAvailable()) {
        const r = await renderMp4("合成成片");
        placeResult(r.url, { width: r.width, height: r.height }, r.duration);
        store.toast("成片已放到画布上" + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : ""), 5000);
        return;
      }
      setBusy("合成到画布…");
      const blob = await recordWebM(visible, out, (u) => resolveMediaUrl(store.backend, u), (f) => setBusy(`合成到画布… ${Math.round(f * 100)}%`), subStyle);
      const file = new File([blob], (node.text || "剪辑时间线") + ".webm", { type: blob.type || "video/webm" });
      const had = new Set(store.state.doc.nodes.map((n) => n.id));
      await addFiles(store, [file], { x: node.x + node.w + 120 + 200, y: node.y + 160 });
      const made = store.state.doc.nodes.find((n) => !had.has(n.id) && n.kind === "video");
      if (made) { store.patchGen(made.id, { title: (node.text || "剪辑时间线") + " · 成片" }); ctl.focusNode(made.id); }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 6000); }
    finally { setBusy(null); }
  };
  const canBrowserMp4 = typeof VideoEncoder === "function";
  /** preset：按平台规格导出（不改工程本身的画幅）；画幅和工程不同时按预览的「留边 / 铺满」重新构图，走本机逐帧合成 */
  const exportIt = async (fmtKind: "mp4" | "webm", preset?: ExportPreset) => {
    player.current?.pause(); setPlaying(false);
    const size = preset ? frameSize(preset.ratio, preset.res) : out;
    const tag = preset ? "「" + preset.label + "」" : "";
    const reframe = !!preset && preset.ratio !== ratio;
    try {
      if (fmtKind === "mp4" && (composite || (reframe && canBrowserMp4) || (!mp4Available && canBrowserMp4))) {
        const blob = await browserMp4("导出 MP4" + tag, size);
        downloadTimelineBlob(blob, novaiName("mp4")); store.toast(`已导出${tag} MP4 · ${size.width}×${size.height}（本机逐帧合成，和预览一致）`);
      } else if (fmtKind === "mp4" && novaiTimelineAvailable()) {
        const r = await renderMp4("导出 MP4" + tag, size);
        const a = document.createElement("a"); a.href = r.url; a.download = novaiName("mp4"); document.body.appendChild(a); a.click(); a.remove();
        store.toast("已导出 MP4" + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : "") + "，文件也保存在输出目录里", 6000);
      } else if (fmtKind === "mp4") {
        setBusy("导出 MP4…");
        const plan = renderPlan(visible);
        const r = await exportPlanMp4({ ...plan, srt: toSrt(visible), ...size, canvasId: store.state.canvasId, onProgress: (v) => setBusy(`导出 MP4… ${Math.round(v)}%`) });
        store.toast("已导出 MP4：" + r.relativePath.split("/").pop() + (r.subtitlesDropped ? "（本机 ffmpeg 不支持字幕，字幕没有烧进去）" : "") + "，导出文件夹已在访达中打开", 6000);
      } else {
        setBusy("导出 WebM…");
        const blob = await recordWebM(visible, out, (u) => resolveMediaUrl(store.backend, u), (f) => setBusy(`导出 WebM… ${Math.round(f * 100)}%`), subStyle);
        downloadTimelineBlob(blob, novaiName("webm")); store.toast("已导出 WebM");
      }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 6000); }
    finally { setBusy(null); }
  };
  /** 剪辑工程包：Premiere / 达芬奇 xml + Final Cut fcpxml + OTIO + 字幕 + 素材 */
  const exportProject = async () => {
    player.current?.pause(); setPlaying(false);
    setBusy("打包剪辑工程…");
    try {
      const zipName = novaiName("zip"); const folder = zipName.replace(/\.zip$/, "");
      const blob = await exportProjectZip(visible, { name: node.text || "NOVAI 剪辑", folder, ...out, fit, resolve: (u) => resolveMediaUrl(store.backend, u), onProgress: (f, step) => setBusy(`${step} ${Math.round(f * 100)}%`) });
      downloadTimelineBlob(blob, zipName);
      store.toast("剪辑工程已导出：解压后用 Premiere / 达芬奇 / Final Cut 打开，详见包里的「说明.txt」", 7000);
    } catch (err) { store.toast("导出工程失败：" + (err instanceof Error ? err.message : "未知错误"), 6000); }
    finally { setBusy(null); }
  };
  const mp4Ok = mp4Available || composite || canBrowserMp4;
  const exportMenu = (e: React.MouseEvent) => openPop(e.currentTarget as HTMLElement, (close) => <div className="tle-menu tle-exmenu" data-tl-export>
    <div className="mh">按平台导出 MP4</div>
    {EXPORT_PRESETS.map((p) => <button key={p.id} className="mi" data-exp={p.id} disabled={!total || !!busy || !mp4Ok} onClick={() => { close(); void exportIt("mp4", p); }}>
      <span className="ic"><Icon name="video" size="s" /></span><span className="tle-mi-t">{p.label}<span className="d">{p.hint}{p.ratio !== ratio ? (fit === "cover" ? " · 铺满裁切" : " · 留边适配") : ""}</span></span>{p.ratio === ratio && p.res === res ? <span className="k">当前</span> : null}</button>)}
    <div className="mh">当前设置 · {ratio} · {out.width}×{out.height}</div>
    {mp4Ok ? <button className="mi" data-exp="mp4" disabled={!total || !!busy} onClick={() => { close(); void exportIt("mp4"); }}><span className="ic"><Icon name="download" size="s" /></span><span className="tle-mi-t">MP4<span className="d">通用格式，手机电脑都能播</span></span></button> : null}
    <button className="mi" data-exp="webm" disabled={!total || !!busy} onClick={() => { close(); void exportIt("webm"); }}><span className="ic"><Icon name="download" size="s" /></span><span className="tle-mi-t">WebM<span className="d">浏览器边播边录，体积小</span></span></button>
    <div className="mh">交给专业软件</div>
    <button className="mi" data-exp="project" disabled={!visualCount || !!busy} onClick={() => { close(); void exportProject(); }}><span className="ic"><Icon name="layers" size="s" /></span><span className="tle-mi-t">剪辑工程包<span className="d">Premiere / 达芬奇 / Final Cut 工程 + 字幕 + 素材</span></span></button>
  </div>, "down", "right");

  const trackHidden = (tr: Track | "vaudio") => !!hidden[tr];
  const toggleTrack = (tr: Track | "vaudio") => setMeta({ tlTracks: { ...hidden, [tr]: !hidden[tr] } });

  /* ---------- 右侧属性面板的小部件（不用滑块：标签按住左右拖就能调，也能直接输入） ---------- */
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const scrubber = (value: number, onChange: (v: number) => void, o: { min: number; max: number; step: number }) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); store.snapshot();
    const x0 = e.clientX; const v0 = value;
    const move = (ev: PointerEvent) => { const per = o.step * (ev.shiftKey ? 10 : 1); onChange(Math.max(o.min, Math.min(o.max, r3(v0 + Math.round((ev.clientX - x0) / 4) * per)))); };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); document.documentElement.classList.remove("tle-scrubbing"); };
    document.documentElement.classList.add("tle-scrubbing");
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  type NumOpt = { min: number; max: number; step: number; unit?: string; key: string };
  const numBox = (value: number, onChange: (v: number) => void, o: NumOpt, tag?: string) => <span className="tle-numbox">
    {tag ? <span className="tle-scrub tag" title="按住左右拖动调整（按住 ⇧ 更快）" onPointerDown={scrubber(value, onChange, o)}>{tag}</span> : null}
    <input className="tle-num tnum" type="number" data-tl={o.key} min={o.min} max={o.max} step={o.step} value={Math.round(value * 100) / 100} onFocus={() => store.snapshot()}
      onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.max(o.min, Math.min(o.max, v))); }} />
    {o.unit ? <span className="tle-unit">{o.unit}</span> : null}
  </span>;
  /** 一行属性：左边标签（可按住拖动调值），右边控件 */
  const field = (label: string, value: number, onChange: (v: number) => void, o: NumOpt, extra?: React.ReactNode) => <div className="tle-row" key={o.key}>
    <span className="tle-rl tle-scrub" title="按住左右拖动调整（按住 ⇧ 更快）" onPointerDown={scrubber(value, onChange, o)}>{label}</span>
    <div className="tle-rc">{numBox(value, onChange, o)}{extra}</div>
  </div>;
  const row = (label: string, body: React.ReactNode, key?: string) => <div className="tle-row" key={key || label}><span className="tle-rl">{label}</span><div className="tle-rc">{body}</div></div>;
  const sec = (title: string, body: React.ReactNode, extra?: React.ReactNode, key?: string) => <section className="tle-sec" data-sec={key || title}>
    <div className="tle-sec-h"><span>{title}</span>{extra}</div>{body}
  </section>;
  function seg<T extends string>(val: T, opts: Array<[T, string]>, on: (v: T) => void, key: string) {
    return <span className="tle-seg" data-tl={key}>{opts.map(([v, l]) => <button key={v} className={val === v ? "on" : ""} onClick={() => on(v)}>{l}</button>)}</span>;
  }
  const subStyleRows = <>
    {row("字号", seg(subStyle.size || "m", [["s", "小"], ["m", "中"], ["l", "大"]], (k) => setMeta({ tlSub: { ...subStyle, size: k } }), "sub-size"))}
    {row("位置", seg(subStyle.pos || "bottom", [["top", "顶部"], ["middle", "居中"], ["bottom", "底部"]], (k) => setMeta({ tlSub: { ...subStyle, pos: k } }), "sub-pos"))}
  </>;
  const delBtn = <button className="pill danger" data-tl="delete-side" onClick={remove}><Icon name="trash" size="xs" />删除</button>;

  const side = (() => {
    if (selClips.length > 1) return <>
      <div className="tle-side-hd"><span className="tle-kind">多选</span><b>{selClips.length} 段已选中</b><span className="tle-dim">拖其中任意一段可以整块挪动</span></div>
      {sec("批量调整", <>
        {row("声音", <button className="pill" data-tl="mute" onClick={toggleMute}><Icon name="mute" size="xs" />静音 / 恢复</button>)}
        {row("变速", <select className="tle-sel" data-tl="speed" value="" onChange={(e) => { const v = Number(e.target.value); if (v) patchSel({ speed: v }, true); }}><option value="">选择倍速…</option>{SPEEDS.map((v) => <option key={v} value={String(v)}>{v}×</option>)}</select>)}
      </>)}
      <div className="tle-side-acts"><button className="pill" onClick={dup}><Icon name="copy" size="xs" />复制</button>{delBtn}</div>
    </>;
    if (selOne && selOne.type === "subtitle") {
      const st = Number(selOne.start) || 0; const en = Number(selOne.end) || st + 1;
      return <>
        <div className="tle-side-hd"><span className="tle-kind">字幕</span><b>{(selOne.text || "字幕").slice(0, 24)}</b><span className="tle-dim tnum">{fmtTC(st)} – {fmtTC(en)}</span></div>
        {sec("文字", <textarea className="tle-ta" data-tl="subtext" rows={3} value={selOne.text || ""} placeholder="输入字幕文字" onFocus={() => store.snapshot()} onChange={(e) => patchSel({ text: e.target.value })} />)}
        {sec("时间", <>
          {field("开始", Math.round(st * 10) / 10, (v) => patchSel({ start: v, end: Math.max(v + 0.1, en) }), { min: 0, max: 3600, step: 0.1, unit: "秒", key: "substart" })}
          {field("结束", Math.round(en * 10) / 10, (v) => patchSel({ end: Math.max(st + 0.1, v) }), { min: 0.1, max: 3600, step: 0.1, unit: "秒", key: "subend" })}
        </>)}
        {sec("字幕样式", subStyleRows, <span className="tle-dim">对全部字幕生效</span>)}
        <div className="tle-side-acts">{delBtn}</div>
      </>;
    }
    if (selOne) {
      const c = selOne; const tr = trackOf(c); const vis = isVisual(c); const src = canRetake(c); const g = src ? genOf(src) : null;
      const takes = g ? g.hist.filter((x) => x.url).length : 0;
      const orphan = !!c.sourceNodeId && !store.node(c.sourceNodeId);
      const lt = vis ? localT(c) : 0; const f = vis ? tfAt(c, lt) : null; const nk = (c.kf || []).length; const onKeyF = vis ? !!keyAt(c, lt) : false;
      const pct = (label: string, prop: keyof Tf, v: number, o: { min: number; max: number; step: number; mul?: number; unit?: string }, tag?: string) => {
        const mul = o.mul ?? 100; const val = Math.round(v * mul * 10) / 10; const set = (x: number) => patchTf(c, { [prop]: x / mul } as Partial<Tf>);
        return tag ? numBox(val, set, { min: o.min, max: o.max, step: o.step, unit: o.unit ?? "%", key: "tf-" + prop }, tag) : field(label, val, set, { min: o.min, max: o.max, step: o.step, unit: o.unit ?? "%", key: "tf-" + prop });
      };
      const kfBar = vis ? <span className="tle-kf">
        <button className="tle-mini" data-tl="kf-prev" aria-label="上一个关键帧" disabled={!nk} onClick={() => jumpKey(c, -1)}><Icon name="left" size="xs" /></button>
        <button className={"tle-dia" + (onKeyF ? " on" : "")} data-tl="kf" title={onKeyF ? "删除播放头处的关键帧" : "在播放头处打关键帧：之后改的数值会做成动画"} onClick={() => (onKeyF ? delKey(c) : addKey(c))}>◆</button>
        <button className="tle-mini" data-tl="kf-next" aria-label="下一个关键帧" disabled={!nk} onClick={() => jumpKey(c, 1)}><Icon name="right" size="xs" /></button>
        {nk ? <button className="tle-mini" data-tl="kf-clear" title={"清除全部 " + nk + " 个关键帧（保留当前画面）"} onClick={() => clearKeys(c)}><Icon name="x" size="xs" /></button> : null}
        {c.tf || nk ? <button className="tle-mini" data-tl="tf-reset" title="恢复默认位置和大小" onClick={() => resetTf(c)}><Icon name="undo" size="xs" /></button> : null}
      </span> : null;
      return <>
        <div className="tle-side-hd">
          <span className="tle-kind">{tr === "overlay" ? "画中画" : MEDIA_LABEL[c.mediaKind]}</span>
          <b title={c.title}>{c.title || MEDIA_LABEL[c.mediaKind]}</b>
          <span className="tle-dim tnum">{selPlaced ? fmtTC(selPlaced.start) + " 开始 · " : ""}时长 {lenOf(c).toFixed(1)} 秒</span>
        </div>
        {src ? <div className="tle-rt-acts">
          <button className="pill strong" data-tl="retake" title={c.mediaKind === "video" ? "在胶片条上截出要改的片段，写改法后重新生成，出片自动换进时间线" : "重新生成这张图，出新版本自动替换"} onClick={() => openRetake(c)}><Icon name="camera" size="xs" />{c.mediaKind === "video" ? "片段重拍" : "重拍"}</button>
          {takes > 1 ? <select className="tle-sel" data-tl="take" title="切换来源节点的版本" value={String(g!.hi)} onChange={(e) => { const i = Number(e.target.value); if (g!.hist[i]?.url) store.patchGen(src.id, { hi: i }, { history: true }); }}>{g!.hist.map((x, i) => (x.url ? <option key={i} value={String(i)}>第 {i + 1} 版</option> : null))}</select> : null}
        </div> : c.mediaKind !== "audio" ? <p className="tle-note">{orphan ? "来源节点已删除：片段还能用，但不能重拍" : "这个片段不是画布上生成的，不能重拍"}</p> : null}
        {c.mediaKind === "image"
          ? sec("时长", field("显示", Math.round(lenOf(c) * 10) / 10, (v) => patchSel({ inPoint: 0, outPoint: Math.max(0.1, v) }), { min: 0.1, max: 600, step: 0.5, unit: "秒", key: "imgdur" }))
          : sec("速度", row("变速", <select className="tle-sel" data-tl="speed" value={String(speedOf(c))} onChange={(e) => patchSel({ speed: Number(e.target.value) }, true)}>{SPEEDS.map((v) => <option key={v} value={String(v)}>{v === 1 ? "1×（原速）" : v + "×"}</option>)}</select>))}
        {c.mediaKind !== "image" ? sec(tr === "audio" ? "声音" : "原声", <>
          {field("音量", Math.round(volOf(c) * 100), (v) => patchSel({ volume: v / 100 }), { min: 0, max: 200, step: 5, unit: "%", key: "volume" },
            <button className={"tle-mini" + (volOf(c) === 0 ? " on" : "")} data-tl="mute" title={volOf(c) === 0 ? "取消静音（M）" : "静音（M）"} onClick={toggleMute}><Icon name={volOf(c) === 0 ? "mute" : "volume"} size="xs" /></button>)}
          {field("淡入", Math.round(fadeOf(c).in * 10) / 10, (v) => patchSel({ fadeIn: Math.round(v * 1000) }), { min: 0, max: 5, step: 0.1, unit: "秒", key: "fadein" })}
          {field("淡出", Math.round(fadeOf(c).out * 10) / 10, (v) => patchSel({ fadeOut: Math.round(v * 1000) }), { min: 0, max: 5, step: 0.1, unit: "秒", key: "fadeout" })}
          {tr === "audio" ? row("自动压低", <select className="tle-sel" data-tl="duck" title="画面里的视频有声音时，把这段（通常是背景音乐）自动降下去" value={String(c.duck && c.duck < 1 ? c.duck : 1)} onChange={(e) => { const v = Number(e.target.value); patchSel({ duck: v < 1 ? v : undefined }, true); }}><option value="1">关</option><option value="0.4">人声时降到 40%</option><option value="0.25">人声时降到 25%</option><option value="0.1">人声时降到 10%</option></select>) : null}
        </>, tr !== "audio" ? <span className="tle-dim">视频自带的声音</span> : null) : null}
        {tr === "video" ? sec("转场", <>
          {row("进场", <select className="tle-sel" data-tl="trans" value={c.trans || "none"} onChange={(e) => patchSel({ trans: e.target.value as TransKind, transMs: c.transMs || 500 }, true)}>{Object.entries(TRANS_LABEL).map(([k2, v]) => <option key={k2} value={k2}>{v}</option>)}</select>)}
          {c.trans && c.trans !== "none" ? field("时长", c.transMs || 500, (v) => patchSel({ transMs: v }), { min: 100, max: 2000, step: 100, unit: "毫秒", key: "transms" }) : null}
        </>) : null}
        {vis && f ? sec("画面", <>
          <div className="tle-row"><span className="tle-rl">位置</span><div className="tle-rc">{pct("", "x", f.x, { min: -100, max: 200, step: 1 }, "X")}{pct("", "y", f.y, { min: -100, max: 200, step: 1 }, "Y")}</div></div>
          {pct("缩放", "s", f.s, { min: 5, max: 500, step: 1 })}
          {pct("不透明", "o", f.o, { min: 0, max: 100, step: 5 })}
          {pct("旋转", "r", f.r, { min: -360, max: 360, step: 1, mul: 1, unit: "°" })}
          <p className="tle-note">也可以在预览画面里直接拖动、滚轮缩放。点 ◆ 打关键帧做动画。</p>
        </>, kfBar) : null}
        {vis ? sec("调色", <>
          {field("亮度", Number(c.color?.b ?? 100), (v) => patchSel({ color: { ...(c.color || {}), b: v } }), { min: 0, max: 200, step: 5, unit: "%", key: "col-b" })}
          {field("对比", Number(c.color?.c ?? 100), (v) => patchSel({ color: { ...(c.color || {}), c: v } }), { min: 0, max: 200, step: 5, unit: "%", key: "col-c" })}
          {field("饱和", Number(c.color?.s ?? 100), (v) => patchSel({ color: { ...(c.color || {}), s: v } }), { min: 0, max: 300, step: 5, unit: "%", key: "col-s" })}
        </>, c.color ? <button className="tle-mini" data-tl="col-reset" title="恢复原色" onClick={() => patchSel({ color: undefined }, true)}><Icon name="undo" size="xs" /></button> : null) : null}
        <div className="tle-side-acts">
          {c.sourceNodeId && !orphan ? <button className="pill" data-tl="locate" onClick={() => locate(c.id)}><Icon name="fit" size="xs" />定位源节点</button> : null}
          {vis ? <button className="pill" data-tl="layer" onClick={() => toggleLayer(c)}><Icon name="layers" size="xs" />{tr === "overlay" ? "移回主画面" : "改成画中画"}</button> : null}
          <button className="pill" data-tl="dup" onClick={dup}><Icon name="copy" size="xs" />复制</button>
          {delBtn}
        </div>
      </>;
    }
    return <>
      <div className="tle-side-hd"><span className="tle-kind">项目</span><b>{node.text || "剪辑时间线"}</b><span className="tle-dim tnum">{visualCount} 段 · {fmtTC(total)} · {out.width}×{out.height}</span></div>
      {sec("预览与字幕", <>
        {row("预览", seg(fit, [["contain", "留黑边"], ["cover", "铺满裁切"]], (v) => setMeta({ tlFit: v }), "fit"))}
        {subStyleRows}
      </>)}
      {sec("怎么剪", <ol className="tle-guide">
        <li><b>添加素材</b>点左上角「添加素材」，或把画布上的节点直接拖到时间线里</li>
        <li><b>排顺序、修剪</b>拖动片段换位置；拖片段左右两端改长短</li>
        <li><b>切开</b>播放头停在要切的地方，按 C 或点下方剪刀</li>
        <li><b>调整片段</b>点一下片段，这里会出现重拍、音量、变速、转场、画面和调色</li>
        <li><b>导出</b>右上角「导出」按平台出片，或「导出到画布」</li>
      </ol>)}
      {sec("快捷键", <div className="tle-keys">{([["空格", "播放 / 暂停"], ["C", "切开"], ["D", "复制"], ["Delete", "删除"], ["Q / E", "剪掉左 / 右"], ["← →", "逐帧"], ["I / O", "入点 / 出点"], [IS_MAC ? "⌘Z" : "Ctrl+Z", "撤销"]] as Array<[string, string]>).map(([k, v]) => <span key={k}><kbd>{k}</kbd>{v}</span>)}</div>)}
    </>;
  })();

  const hasVideoAudio = visRaw.some((c) => c.mediaKind === "video" && trackOf(c) === "video");
  const trackRows: Array<{ t: Track | "vaudio"; label: string; icon: "video" | "audio" | "text" | "layers" | "mic"; h: number; addTip?: string }> = [
    { t: "video", label: "画面", icon: "video", h: 46, addTip: "添加视频 / 图片" },
    ...(hasVideoAudio ? [{ t: "vaudio" as const, label: "原声", icon: "mic" as const, h: 26 }] : []),
    { t: "overlay", label: "画中画", icon: "layers", h: 34, addTip: "添加画中画" },
    { t: "audio", label: "音频", icon: "audio", h: 34, addTip: "添加配乐 / 配音" },
    { t: "subtitle", label: "字幕", icon: "text", h: 26, addTip: "在播放头处加字幕" },
  ];
  const addTo = (tr: Track | "vaudio", el: HTMLElement) => {
    if (tr === "subtitle") { addSub(); return; }
    if (tr === "video") { openPop(el, () => <div className="tle-menu"><div className="mh">添加到画面轨</div>
      {ADD_KINDS.filter((x) => x.k === "video" || x.k === "image").map((x) => <button key={x.k} className="mi" data-add={x.k} onClick={(ev) => addMenu({ currentTarget: ev.currentTarget }, x.k)}><span className="ic"><Icon name={x.icon} size="s" /></span><span className="tle-mi-t">{x.label}<span className="d">{x.d}</span></span></button>)}
    </div>, "down"); return; }
    if (tr === "overlay" || tr === "audio") addMenu({ currentTarget: el }, tr);
  };

  /* 不再整块吞掉 pointerdown：编辑器里各控件（片段、标尺、按钮、输入框）自己会 stopPropagation，
     其余空白处交给画布，按住就能拖整个节点——以前只有标题栏能拖 */
  return <div className={"tle" + (full ? " full" : "")} ref={root} data-act="timeline" data-drag={full ? undefined : ""} tabIndex={0} onWheel={stop} onKeyDown={onKey}
    onDoubleClick={(e) => { stop(e); if (!full && onFull && !(e.target as HTMLElement).closest("button,input,select,textarea,.tle-clip,.tle-ruler,.tle-side,.tle-va")) onFull(true); }}>
    <div className="tle-top" onPointerDown={stopOnControl}>
      <button className="pill strong" data-tl="add" onClick={addRoot}><Icon name="plus" size="xs" />添加素材</button>
      <button className="pill" data-tl="ai" onClick={aiMenu}><Icon name="sparkle" size="xs" />AI 剪辑<Icon name="down" size="xs" className="tle-caret" /></button>
      <span className="grow" />
      {busy ? <span className="tle-busy" data-tl-busy><i className="tle-spin" />{busy}</span> : null}
      <select className="tle-sel" data-tl="ratio" value={ratio} onChange={(e) => setMeta({ ratio: e.target.value })} title="画幅">{RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <select className="tle-sel" data-tl="res" value={res} onChange={(e) => setMeta({ tlRes: e.target.value })} title="导出清晰度">{RESES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <button className="pill" data-tl="export" disabled={!total || !!busy} onClick={exportMenu}><Icon name="download" size="xs" />导出<Icon name="down" size="xs" className="tle-caret" /></button>
      <button className="pill strong" data-tl="tocanvas" disabled={!total || !!busy} title="合成成片，作为新视频节点放到画布上" onClick={() => void exportToCanvas()}>导出到画布</button>
      {onFull ? <button className="ib tipB" data-tl="fullmode" data-tip={full ? "回到画布（Esc）" : "全屏剪辑"} onClick={() => onFull(!full)}><Icon name={full ? "x" : "expand"} size="s" /></button> : null}
    </div>

    <div className="tle-main">
      <div className="tle-stage">
        <div className={`tle-mon${fit === "cover" ? " cover" : ""}${isVisual(selOne) ? " editable" : ""}`} ref={mon} onWheel={monWheel}>
          <canvas ref={screen} className="tle-screen" style={{ aspectRatio: `${w} / ${h}` }} onPointerDown={monDown} title={isVisual(selOne) ? "拖动移动选中的画面，滚轮缩放" : undefined} />
          {!visible.length ? <div className="tle-hint">{clips.length ? <>轨道都被隐藏了，点下方轨道名左边的眼睛恢复</> : <><b>还没有素材</b><span>点左上角「添加素材」，或把画布上的视频节点拖进来</span><button className="pill strong" onPointerDown={stop} onClick={addRoot}><Icon name="plus" size="xs" />添加素材</button></>}</div> : null}
        </div>
        <div className="tle-ctl" onPointerDown={stopOnControl}>
          <button className="ib" data-tl="home" aria-label="跳到开头" onClick={() => seekNow(0)} disabled={!total}><Icon name="skipb" size="s" /></button>
          <button className="ib tle-play" data-tl="play" aria-label={playing ? "暂停" : "播放"} onClick={toggle} disabled={!total}><Icon name={playing ? "pause" : "play"} size="s" /></button>
          <button className="ib" data-tl="end" aria-label="跳到结尾" onClick={() => seekNow(total)} disabled={!total}><Icon name="skipf" size="s" /></button>
          <span className="tnum tle-time" data-tl-time>{fmtTC(t)}<span className="tle-dim"> / {fmtTC(total)}</span></span>
          {io ? <button className="pill" data-tl="io" onClick={() => { setIo(null); setLoop(false); }} title="清除入出点">{fmtTC(io.a)} – {fmtTC(io.b)}<span className="k">×</span></button> : null}
          <span className="grow" />
          <button className={"ib tipT" + (fit === "cover" ? " on" : "")} data-tl="fit" data-tip={fit === "cover" ? "预览：铺满裁切（点一下改回留黑边）" : "预览：留黑边（点一下改成铺满裁切）"} onClick={() => setMeta({ tlFit: fit === "cover" ? "contain" : "cover" })}><Icon name="monitor" size="s" /></button>
          <button className="ib tipT" data-tl="full" data-tip="全屏预览（Esc 退出）" onClick={() => { const el = mon.current; if (!el) return; if (document.fullscreenElement) void document.exitFullscreen(); else void el.requestFullscreen?.().catch(() => store.toast("当前环境不支持全屏预览")); }}><Icon name="expand" size="s" /></button>
        </div>
      </div>
      <aside className="tle-side" data-tl-side data-wheel="scroll" onPointerDown={stopOnControl} onWheel={stop}>{side}</aside>
    </div>

    <div className="tle-tbar" onPointerDown={stopOnControl}>
      <span className="tle-seg tle-tools">{TOOLS.map((x) => <button key={x.id} className={"tipT" + (tool === x.id ? " on" : "")} data-tl={"tool-" + x.id} data-tip={x.tip} onClick={() => setTool(x.id)}>{x.label}</button>)}</span>
      <span className="tle-sep" />
      <button className="ib tipT" data-tl="split" data-tip="在播放头处切开（C）" disabled={!clips.length} onClick={split}><Icon name="scissors" size="s" /></button>
      <button className="ib tipT" data-tl="dup" data-tip="复制选中片段（D）" disabled={!sel.size} onClick={dup}><Icon name="copy" size="s" /></button>
      <button className="ib tipT" data-tl="delete" data-tip="删除选中片段（Delete）" disabled={!sel.size} onClick={remove}><Icon name="trash" size="s" /></button>
      <span className="tle-sep" />
      <button className={"ib tipT" + (snapOn ? " on" : "")} data-tl="snap" data-tip={snapOn ? "吸附：开（拖动时按住 " + (IS_MAC ? "⌥" : "Alt") + " 临时关闭）" : "吸附：关"} onClick={() => setMeta({ tlSnap: !snapOn })}><Icon name="magnet" size="s" /></button>
      <button className="ib tipT" data-tl="mark" data-tip="在播放头加标记（⇧M）" onClick={addMark} disabled={!total}><Icon name="tag" size="s" /></button>
      {marks.length ? <><button className="ib" data-tl="mark-prev" aria-label="上一个标记" onClick={() => jumpMark(-1)}><Icon name="left" size="s" /></button><button className="ib" data-tl="mark-next" aria-label="下一个标记" onClick={() => jumpMark(1)}><Icon name="right" size="s" /></button></> : null}
      <button className={"ib tipT" + (io ? " on" : "")} data-tl="loop" data-tip={io ? "循环播放入出点（再点关闭）" : "循环播放（先按 I / O 设入出点）"} disabled={!total} onClick={() => { if (!io) { markIO("in"); return; } setLoop(!loop); }}><Icon name="history" size="s" /></button>
      <span className="tle-sep" />
      <button className="ib tipT" data-tl="undo" data-tip={"撤销（" + (IS_MAC ? "⌘Z" : "Ctrl+Z") + "）"} onClick={() => store.undo()}><Icon name="undo" size="s" /></button>
      <button className="ib tipT" data-tl="redo" data-tip={"重做（" + (IS_MAC ? "⇧⌘Z" : "Ctrl+Y") + "）"} onClick={() => store.redo()}><Icon name="redo" size="s" /></button>
      <span className="grow" />
      <button className="ib tipT" data-tl="zoom-out" data-tip="缩小时间线" onClick={() => zoomTimeline(1 / 1.4)}><Icon name="minus" size="s" /></button>
      <span className="tnum tle-zoom" data-tl-zoom title={IS_MAC ? "⌘ + 滚轮缩放，滚轮左右平移" : "Ctrl + 滚轮缩放，滚轮左右平移"}>{Math.round(pps / 36 * 100)}%</span>
      <button className="ib tipT" data-tl="zoom-in" data-tip="放大时间线" onClick={() => zoomTimeline(1.4)}><Icon name="plus" size="s" /></button>
      <button className="ib tipT" data-tl="zoom-fit" data-tip="缩放到全部可见（F）" onClick={zoomFit} disabled={!total}><Icon name="fit" size="s" /></button>
    </div>

    <div className="tle-lanes" ref={lanes} data-tl="lanes" data-wheel="own" onWheel={onLanesWheel} onScroll={(e) => setLanesX(e.currentTarget.scrollLeft)} onPointerDown={(e) => { if (e.altKey || e.button === 1) startPan(e); }}>
      <div className="tle-inner" style={{ width: width + LAB }}>
        <div className="tle-ruler" data-tl="ruler" onPointerDown={scrub}>
          <span className="tle-ruler-lab">时间</span>
          {io ? <span className="tle-io" style={{ left: LAB + io.a * pps, width: Math.max(2, (io.b - io.a) * pps) }} /> : null}
          {marks.map((m) => <span key={m.t} className="tle-mark" data-mark={m.t} title={"标记 " + fmtTC(m.t) + "（点击跳到这里，右键删除）"} style={{ left: LAB + m.t * pps }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekNow(m.t); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); delMark(m.t); }} />)}
          {Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => <span key={i} className="tle-tick" style={{ left: LAB + i * step * pps }}>{fmt(i * step).replace(/\.0$/, "")}</span>)}
        </div>
        {trackRows.map((tr) => {
          const real = tr.t !== "vaudio" ? (tr.t as Track) : null;
          const off = trackHidden(tr.t);
          return <div key={tr.t} className={"tle-track k-" + tr.t + (off ? " off" : "") + (real && locked[real] ? " locked" : "")} style={{ height: tr.h }} data-track={tr.t} onPointerDown={(e) => { if (e.target === e.currentTarget) laneDown(e); }}>
            <span className="tle-lab">
              <button className={"tle-tb" + (off ? " off" : "")} data-tl={"track-" + tr.t} title={tr.t === "audio" || tr.t === "vaudio" ? (off ? "取消静音这条轨" : "静音这条轨") : (off ? "显示这条轨" : "隐藏这条轨")} onPointerDown={stopOnControl} onClick={(e) => { e.stopPropagation(); toggleTrack(tr.t); }}>
                <Icon name={tr.t === "audio" || tr.t === "vaudio" ? (off ? "mute" : "volume") : (off ? "eyeoff" : "eye")} size="xs" />
              </button>
              <span className="tle-lab-n">{tr.label}</span>
              {tr.addTip ? <button className="tle-tb add" data-tl={"track-add-" + tr.t} title={tr.addTip} onPointerDown={stopOnControl} onClick={(e) => { e.stopPropagation(); addTo(tr.t, e.currentTarget); }}><Icon name="plus" size="xs" /></button> : null}
              {real ? <button className={"tle-tb lk" + (locked[real] ? " on" : "")} data-tl={"lock-" + tr.t} title={locked[real] ? "解锁这条轨" : "锁定这条轨（不能拖动 / 修剪 / 删除）"} onPointerDown={stopOnControl} onClick={(e) => { e.stopPropagation(); toggleLock(real); }}><Icon name="shield" size="xs" /></button> : null}
            </span>
            {tr.t === "vaudio"
              ? place(visRaw, "video").filter((p) => p.clip.mediaKind === "video" && p.clip.url).map((p) => <VoiceBlock key={p.clip.id} p={p} pps={pps} selected={sel.has(p.clip.id)} off={off}
                onDown={(e) => { e.stopPropagation(); if (e.button === 2) return; e.preventDefault(); pick(e, p.clip.id); focus(); }} onMenu={clipMenu} />)
              : place(visRaw, tr.t as Track).map((p, i, all) => <ClipBlock key={p.clip.id} p={p} prev={all[i - 1]?.clip} pps={pps} selected={sel.has(p.clip.id)}
                dx={drag && drag.id === p.clip.id && drag.mode === "move" ? drag.dt * pps : 0} onDown={startDrag} onMenu={clipMenu} />)}
          </div>;
        })}
        {!clips.length ? <div className="tle-lanes-empty"><span>时间线是空的</span><button className="pill" onPointerDown={stop} onClick={addRoot}><Icon name="plus" size="xs" />添加素材</button><span className="tle-dim">或把画布上的视频、图片、音频节点拖到这里</span></div> : null}
        {drag?.snap != null ? <span className="tle-snap" style={{ left: LAB + drag.snap * pps }} /> : null}
        {box ? <span className="tle-marq" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : null}
        {marks.filter((m) => m.t * pps >= lanesX).map((m) => <span key={"ml" + m.t} className="tle-markline" style={{ left: LAB + m.t * pps }} />)}
        {t * pps >= lanesX - 1 ? <span className="tle-head" style={{ left: LAB + t * pps }} /> : null}
      </div>
    </div>
    {retakeView}
  </div>;
}

/** 「原声」轨上的一段：跟着画面轨上的视频片段走（位置 / 长度 / 变速都一样），显示它自带声音的波形；点一下选中那段视频 */
function VoiceBlock({ p, pps, selected, off, onDown, onMenu }: { p: Placed; pps: number; selected: boolean; off: boolean; onDown: (e: React.PointerEvent) => void; onMenu: (e: React.MouseEvent, id: string) => void }) {
  const c = p.clip; const width = Math.max(6, (p.end - p.start) * pps);
  const [st, setSt] = useState<{ peaks: Peaks | null; done: boolean }>({ peaks: null, done: false });
  const be = useCtl().store.backend;
  useEffect(() => {
    let alive = true; setSt({ peaks: null, done: false });
    void resolveMediaUrl(be, c.url).then((u) => peaksOf(u || c.url)).then((pk) => { if (alive) setSt({ peaks: pk, done: true }); }).catch(() => { if (alive) setSt({ peaks: null, done: true }); });
    return () => { alive = false; };
  }, [c.url, be]);
  const muted = volOf(c) === 0 || off;
  const none = st.done && !st.peaks;
  return <div className={"tle-va" + (selected ? " on" : "") + (muted ? " muted" : "") + (none ? " none" : "")} data-va={c.id} title={none ? "这段视频没有声音" : muted ? "已静音" : "视频自带的声音 · 音量 " + Math.round(volOf(c) * 100) + "%"}
    style={{ left: LAB + p.start * pps, width }} onPointerDown={onDown} onContextMenu={(e) => onMenu(e, c.id)}>
    {st.peaks ? <WaveStrip peaks={st.peaks} from={c.inPoint} to={c.outPoint} width={Math.round(Math.min(2400, width))} height={20} color="rgba(255,255,255,.78)" /> : <span className="tle-va-t">{none ? "无声音" : ""}</span>}
    {volOf(c) !== 1 && !none ? <span className="tle-badge tnum">{volOf(c) === 0 ? "静音" : Math.round(volOf(c) * 100) + "%"}</span> : null}
  </div>;
}

type ClipBlockProps = { p: Placed; prev?: Clip; pps: number; selected: boolean; dx: number; onDown: (e: React.PointerEvent, id: string, mode: Drag["mode"]) => void; onMenu: (e: React.MouseEvent, id: string) => void };

function ClipBlock({ p, prev, pps, selected, dx, onDown, onMenu }: ClipBlockProps) {
  const store = useCtl().store;
  const c = p.clip; const t = trackOf(c); const isImg = c.mediaKind === "image";
  // 时间线上一排小封面只有几十像素高：用缩略图，别为一条时间线拉几十张 4K 原图（失败自动退回原图）
  const cover = useThumbBg(useAssetUrl(t === "video" || t === "overlay" ? c.thumb || (isImg ? c.url : "") : ""), 160);
  // 没有封面就从视频入点处现取一帧
  const be = store.backend; const [grab, setGrab] = useState("");
  useEffect(() => { if ((t !== "video" && t !== "overlay") || isImg || c.thumb || !c.url) return; let alive = true; void resolveMediaUrl(be, c.url).then((u) => (u ? grabThumb(u, c.inPoint + 0.05) : "")).then((d) => { if (alive) setGrab(d); }); return () => { alive = false; }; }, [t, isImg, c.thumb, c.url, c.inPoint, be]);
  const thumb = cover || grab;
  const tr = t === "video" ? transOf(c, prev) : null; const vis = t === "video" || t === "overlay"; const k = speedOf(c); const fd = fadeOf(c);
  const width = Math.max(6, (p.end - p.start) * pps);
  const strip = !isImg && vis && !!c.url;
  const cells = useFilmstrip(strip ? c.url : "", c.inPoint, c.outPoint, width);
  // 视频自带的声音画在下面单独的「原声」轨上；片段里只给音频 / 画中画画波形
  const peaks = usePeaks((t === "audio" || t === "overlay") && c.url ? c.url : "");
  const orphan = !!c.sourceNodeId && !store.node(c.sourceNodeId);
  const tip = `${fmt(p.start)} – ${fmt(p.end)} · ${lenOf(c).toFixed(1)}s${k !== 1 ? ` · ${k}×` : ""}${orphan ? " · 来源节点已删除" : ""}`;
  return <div className={"tle-clip k-" + t + (isImg ? " k-image" : "") + (selected ? " on" : "") + (dx ? " drag" : "") + (t !== "subtitle" && volOf(c) === 0 ? " muted" : "")} data-clip={c.id} title={tip}
    style={{ left: LAB + p.start * pps, width, transform: dx ? `translateX(${dx}px)` : undefined, backgroundImage: !strip && thumb ? `url("${thumb}")` : undefined }}
    onPointerDown={(e) => { if (e.button === 2) { e.stopPropagation(); return; } onDown(e, c.id, "move"); }} onContextMenu={(e) => onMenu(e, c.id)}>
    {strip && cells.length ? <span className="tle-fs">{cells.map((src, i) => <i key={i} style={src ? { backgroundImage: `url("${src}")` } : undefined} />)}</span> : null}
    {peaks && t !== "subtitle" ? <span className={"tle-wavewrap" + (t === "audio" ? " tall" : "")}><WaveStrip peaks={peaks} from={c.inPoint} to={c.outPoint} width={Math.round(Math.min(2400, width))} height={t === "audio" ? 26 : 13} color={t === "audio" ? "rgba(214,255,231,.85)" : "rgba(255,255,255,.72)"} /></span> : null}
    {tr && tr.kind !== "none" ? <span className="tle-tr" title={tr.kind === "fade" ? "黑场淡入" : "交叉溶解"} style={{ width: Math.max(6, tr.sec * pps) }} /> : null}
    {t !== "subtitle" && fd.in > 0 ? <span className="tle-fade l" style={{ width: Math.min(width / 2, fd.in * pps) }} /> : null}
    {t !== "subtitle" && fd.out > 0 ? <span className="tle-fade r" style={{ width: Math.min(width / 2, fd.out * pps) }} /> : null}
    <span className="tle-cl">{t === "subtitle" ? c.text : c.title || MEDIA_LABEL[c.mediaKind]}</span>
    {(c.kf || []).map((k, i) => <i key={i} className="tle-kfd" style={{ left: Math.max(0, Math.min(width, k.t * pps)) }} />)}
    {orphan && t !== "subtitle" ? <span className="tle-badge dis">已断开</span> : null}
    {t !== "subtitle" && (volOf(c) !== 1 || k !== 1) ? <span className="tle-badge tnum">{k !== 1 ? k + "×" : ""}{k !== 1 && volOf(c) !== 1 ? " · " : ""}{volOf(c) !== 1 ? (volOf(c) === 0 ? "静音" : Math.round(volOf(c) * 100) + "%") : ""}</span> : null}
    <span className="tle-h l" data-edge="l" onPointerDown={(e) => onDown(e, c.id, "l")} />
    <span className="tle-h r" data-edge="r" onPointerDown={(e) => onDown(e, c.id, "r")} />
  </div>;
}


/** 片段重拍的选段（交互和 LibTV 一致）：大预览 + 整段来源视频的胶片条。
 *  点胶片条空白处截一段（默认 3 秒，最多 5 段，不重叠）；拖片段挪位置，拖两端改长短，悬停点 × 删除；
 *  胶片条下沿的亮条是时间线上用到的那一段（入点～出点）；点哪里预览就跳到哪里。 */
function SegPicker({ url, clip, ranges, onChange, locked }: { url: string; clip: Clip; ranges: Array<{ a: number; b: number }>; onChange: (r: Array<{ a: number; b: number }>) => void; locked: boolean }) {
  const store = useCtl().store;
  const src = useAssetUrl(url);
  const vref = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(Number(clip.srcDur) || clip.outPoint || 0);
  const [now, setNow] = useState(clip.inPoint);
  const cells = useFilmstrip(url, 0, Math.max(0.1, dur), 1100);
  const MAX = 5, MIN = 0.5, DEF = 3;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const sorted = [...ranges].sort((p, q) => p.a - q.a);
  const pct = (v: number) => (dur ? (v / dur) * 100 : 0) + "%";
  const toSec = (x: number) => { const r = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)) * dur; };
  const seek = (t: number) => { const v = vref.current; if (v && Number.isFinite(t)) { try { v.currentTime = t; } catch { /* 还没加载 */ } } setNow(t); };
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
    <div className="tle-segpick-v">
      <video ref={vref} src={src || undefined} controls playsInline preload="metadata" crossOrigin="anonymous"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); try { e.currentTarget.currentTime = clip.inPoint; } catch { /* ignore */ } }}
        onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
    </div>
    <div className="tle-segpick-row">
      <div className={"tle-segpick-bar" + (locked ? " locked" : "")} ref={bar} data-rt="strip" onPointerDown={add}>
        <span className="tle-segpick-fs">{cells.map((c, i) => <i key={i} style={c ? { backgroundImage: `url("${c}")` } : undefined} />)}</span>
        {dur ? <span className="tle-segpick-used" title="时间线上用到的部分" style={{ left: pct(clip.inPoint), width: pct(clip.outPoint - clip.inPoint) }} /> : null}
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


/**
 * 画布上的剪辑节点：平时在节点里编辑；切到全屏时整个编辑器 portal 到画布最上层铺满窗口（同一份数据），
 * 节点里只留占位，免得两套播放器同时跑。
 */
export function TimelineNodeBody({ node }: { node: CanvasNode }) {
  const [full, setFull] = useState(false);
  const host = typeof document !== "undefined" ? ((document.querySelector(".cn-root") as HTMLElement | null) || document.body) : null;
  useEffect(() => {
    if (!full) return;
    const t = window.setTimeout(() => (document.querySelector(".tle-full .tle") as HTMLElement | null)?.focus({ preventScroll: true }), 30);
    return () => window.clearTimeout(t);
  }, [full]);
  if (full && host) return <>
    <div className="tle-fullph" data-drag=""><Icon name="expand" size="s" /><span>正在全屏剪辑</span><button className="pill" onPointerDown={stop} onClick={() => setFull(false)}>回到这里</button></div>
    {createPortal(<div className="tle-full" role="dialog" aria-label="全屏剪辑" onPointerDown={(e) => e.stopPropagation()}><TimelineEditor node={node} full onFull={setFull} /></div>, host)}
  </>;
  return <TimelineEditor node={node} onFull={setFull} />;
}
