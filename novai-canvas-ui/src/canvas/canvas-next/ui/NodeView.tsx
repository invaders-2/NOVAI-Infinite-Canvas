/**
 * 节点渲染。生成类节点（文本 / 图片 / 视频 / 音频）、多维表格、旧版节点（只读占位）。
 * 生成中用 TapNow 的 node-loading 图层栈；失败用「提示」遮罩；结果 180ms 淡入。
 */
import { Markdown, TextSkeleton } from "./markdown";
import { GroupBody, GroupTools, Model3DBody, NoteBody, Scene3DBody, TimelineBody } from "./LegacyNodes";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { bgColor, clampTrim, formatClock, genOf, isGenKind, outOf, tagColor, TYPE_ICON, TYPE_LABEL, videoResLabel, type GenOutput, type VideoParams, type VideoTrim } from "../model";
import type { RunState } from "../store";
import { Icon } from "./Icon";
import { TableNodeBody } from "./TableNode";
import { StackBody } from "./StackNode";
import { isStack, takeFlyOut } from "../stack";
import { groupBackground } from "../groupStyle";
import { isGifUrl, thumbStep, useGifPoster, useThumbnailUrl } from "./useThumbnail";
import { previewThumbUrl } from "../table";
import { AudioBody } from "./AudioBody";
import { isSplitNode, SplitNodeBody } from "./SplitNode";
import { useAssetUrl } from "./useAsset";
import { useMediaUrl } from "./useMedia";
import { useCtl } from "./ctx";
import type { GenData } from "../model";
import { retryBlockedReason } from "../errorText";

export type NodeViewProps = {
  node: CanvasNode;
  sel: boolean;
  run?: RunState;
  editing: boolean;
  drop: boolean;
  noconn: boolean;
  hl: boolean;
  batchInfo?: string;
  /** 在一键运行的队列里、还没轮到（等上游） */
  queued?: boolean;
  /** 选中时左上角徽标用的模型名（TapNow：模型 + 第 n/m 版） */
  modelName?: string;
  onAct: (node: CanvasNode, act: string, e: React.SyntheticEvent) => void;
  onTextCommit: (id: string, text: string) => void;
};

const legacyLabel: Record<string, string> = { model3d: "3D 模型", timeline: "剪辑时间线", scene3d: "3D 片场", note: "便签", group: "分组", "smart-batch": "批量", "smart-loop": "循环" };

/** 空状态节点按比例摆正后，扁平比例（21:9）的正文放不下整句文案：矮到这个高度就只留图标，16:9 的 135px 仍显示文字 */
const PH_SHORT_H = 120;

/** 换比例时尺寸过渡的时长：短到不挡手，又足以让人看出「框是跟着比例变的」 */
const RATIO_ANIM_MS = 220;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** 面板里选的比例原文；只用来判断「这次渲染是不是换了比例」，没有 ratio 参数的节点给空串 */
const ratioTextOf = (node: CanvasNode) => (isGenKind(node.kind) ? String((genOf(node).params as { ratio?: unknown }).ratio ?? "") : "");

export const NodeView = memo(function NodeView(p: NodeViewProps) {
  const { node, run } = p;
  const enterRef = useRef(true);
  const [entering, setEntering] = useState(true);
  // 指针进到节点正文才算「在看这个节点」：GIF 换原图播、视频才懒挂 <video>。
  // 画布不虚拟化（所有节点常驻 DOM），默认态把媒体全挂上等于全部常驻解码；hover 只重渲染这一个节点。
  const [hoverNode, setHoverNode] = useState(false);
  useEffect(() => { const t = setTimeout(() => { enterRef.current = false; setEntering(false); }, 200); return () => clearTimeout(t); }, []);
  const cls = ["node", entering ? "enter" : "", p.sel ? "sel" : "", run ? "running" : "", p.drop ? "drop" : "", p.noconn ? "noconn" : "", p.hl ? "hl" : "", p.queued && !run ? "queued" : ""].filter(Boolean).join(" ");
  const style = { left: node.x, top: node.y, width: node.w };
  const flyOut = useFlyOut(node.id, node.x, node.y, node.w, node.h);
  const rootEl = useRef<HTMLDivElement | null>(null);
  const ref = (el: HTMLDivElement | null) => { rootEl.current = el; flyOut(el); };
  // 换比例时给尺寸补一段过渡：只有「空状态节点 + 比例取值真的变了」这一种情况播，
  // 拖右下角缩放时比例没变、结果写回时已有 hist、新建/挂载时上一次的尺寸就是它自己，都不会播。
  const lastBox = useRef({ w: node.w, h: node.h, ratio: ratioTextOf(node) });
  const boxAnim = useRef<{ w?: Animation; h?: Animation }>({});
  useLayoutEffect(() => {
    const prev = lastBox.current;
    lastBox.current = { w: node.w, h: node.h, ratio: ratioTextOf(node) };
    const el = rootEl.current; const body = el?.querySelector<HTMLElement>(".nbody");
    if (!el || !body) return;
    if (prev.w === node.w && prev.h === node.h) return;
    if (prev.ratio === lastBox.current.ratio) return;
    if ((node.kind !== "image" && node.kind !== "video") || outOf(node) || reducedMotion()) return;
    // 两个元素各自的 inline 尺寸都要动：外层 .node 是宽度、.nbody 是高度
    const timing: KeyframeAnimationOptions = { duration: RATIO_ANIM_MS, easing: "cubic-bezier(.2,0,0,1)" };
    boxAnim.current.w?.cancel(); boxAnim.current.h?.cancel();
    boxAnim.current.w = el.animate([{ width: prev.w + "px" }, { width: node.w + "px" }], timing);
    boxAnim.current.h = body.animate([{ height: prev.h + "px" }, { height: node.h + "px" }], timing);
  }, [node]);
  if (node.kind === "table") return (
    <div ref={ref} className={cls + " tnode-wrap"} data-id={node.id} style={style}>
      <TableNodeBody node={node} sel={p.sel} />
      <Ports h={node.h} />
    </div>
  );
  if (isStack(node)) return (
    <div className={cls + " snode" + (node.text && node.text !== "堆叠" ? " named" : "")} data-id={node.id} style={style}>
      <div className="nhead"><Icon name="layers" size="xs" /><span className="t">{node.text && node.text !== "堆叠" ? node.text : "堆叠"}</span><span className="st tnum" data-stack-count>{(node.children || []).length}</span></div>
      <div className="nbody sbody" style={{ height: node.h }}><StackBody node={node} /></div>
      <Ports h={node.h} only="out" />
    </div>
  );
  if (node.kind === "group") {
    return (
      <div ref={ref} className={cls + " gnode"} data-id={node.id} style={style}>
        <div className="nhead"><Icon name="layers" size="xs" /><span className="t">{node.text && node.text !== "分组" ? node.text : "分组"}</span></div>
        <GroupTools node={node} show={p.sel} />
        {/* 组框不再画虚线（描边不表达层级）：只用一层 90% 透明的底色标区域，选中时底色加深；
            项目里 .node.sel .nbody 的通用选中描边也一并关掉，组的选中只靠底色 */}
        <div className="nbody gbody" style={{ height: node.h, border: "none", outline: "none", background: groupBackground(node, p.sel) }}><GroupBody node={node} /></div>
        <div className="rz" data-rz title="拖动调整大小" />
        <Ports h={node.h} only="out" />
      </div>
    );
  }
  if (!isGenKind(node.kind)) {
    const body = node.kind === "note" ? <NoteBody node={node} /> : node.kind === "timeline" ? <TimelineBody node={node} /> : node.kind === "model3d" ? <Model3DBody node={node} /> : node.kind === "scene3d" ? <Scene3DBody node={node} />
      : <div className="ph"><Icon name="layers" /><span>旧版「{legacyLabel[node.kind] || node.kind}」节点，新画布里只显示</span></div>;
    return (
      <div ref={ref} className={cls + " lgnode lg-" + node.kind} data-id={node.id} style={style}>
        <div className="nhead"><Icon name={node.kind === "model3d" || node.kind === "scene3d" ? "cube" : node.kind === "timeline" ? "video" : node.kind === "note" ? "pencil" : "layers"} size="xs" /><span className="t">{legacyLabel[node.kind] || node.kind}</span></div>
        <div className="nbody" style={{ height: node.h }}>{body}</div>
        <div className="rz" data-rz title="拖动调整大小" />
        {node.kind === "model3d" || node.kind === "timeline" ? <Ports h={node.h} /> : null}
      </div>
    );
  }
  // 拆分结果节点：自定义外壳（32px 标题栏 + 节点内 inline 编辑器），不套普通图片节点的标题/占位
  if (node.kind === "image" && isSplitNode(node)) {
    return (
      <div ref={ref} className={cls + " splitnode"} data-id={node.id} style={style}>
        <SplitNodeBody node={node} />
        <div className="rz" data-rz title="拖动调整大小" />
      </div>
    );
  }
  const g = genOf(node); const out = outOf(node); const running = !!run;
  return (
    <div ref={ref} className={cls} data-id={node.id} style={style}>
      <div className="nhead">
        <Icon name={TYPE_ICON[node.kind]} size="xs" /><span className="t">{g.title}</span>
        {node.kind === "video" ? <span className="kindtag" data-kindtag>视频</span> : null}
        {g.tag || g.pinned ? <i className="tagdot" title="颜色标记" style={{ background: tagColor(g.tag || "red")! }} /> : null}{g.agent ? <span className="pinmark">Agent</span> : null}
        {running ? <span className="st tnum" style={{ color: "var(--fg2)" }}>{run!.batch ? `${run!.batch.done}/${run!.batch.total}` : <i className="runsig" role="status" aria-label="生成中" />}</span>
          : g.err ? <span className="st" style={{ color: "var(--bad)" }}><Icon name="alert" size="xs" /></span>
          : out ? <span className="st" style={{ color: "var(--fg3)" }}><Icon name="check" size="xs" /></span> : null}
      </div>
      <div className={"nbody" + (g.bg ? " tinted" : "")} style={{ height: node.h, ...(g.bg ? { ["--tint" as string]: bgColor(g.bg)! } : {}) }}
        onPointerEnter={node.kind === "image" || node.kind === "video" ? () => setHoverNode(true) : undefined}
        onPointerLeave={node.kind === "image" || node.kind === "video" ? () => setHoverNode(false) : undefined}>
        <Body {...p} out={out} running={running} hover={hoverNode} />
        {g.hist.length > 1 && !running ? <div className="vstrip tnum"><button data-act="vprev" onPointerDown={(e) => p.onAct(node, "vprev", e)}><Icon name="left" size="xs" /></button><button className="vnum" data-act="vmenu" title="版本操作" onPointerDown={(e) => p.onAct(node, "vmenu", e)}>{g.hi + 1}/{g.hist.length}</button><button data-act="vnext" onPointerDown={(e) => p.onAct(node, "vnext", e)}><Icon name="right" size="xs" /></button></div> : null}
        {(node.kind === "image" || node.kind === "video") && out && !running ? <button className={"favstar" + (g.fav ? " on" : "")} data-act="fav" title={g.fav ? "取消收藏" : "收藏到素材库（收藏后可在提示词编辑器里 @ 引用）"} onPointerDown={(e) => p.onAct(node, "fav", e)}><Icon name="star" size="s" /></button> : null}
        {(node.kind === "image" || node.kind === "video" || node.kind === "audio") && out && !running ? <button className="node-replace" data-act="replace" title="替换素材（位置 / 尺寸 / 连线 / 提示词保留）" style={{ height: 24, padding: "0 9px", borderRadius: 7, background: "rgba(0,0,0,.62)", color: "#fff", fontSize: 11, gap: 3, zIndex: 3, whiteSpace: "nowrap", alignItems: "center" }} onPointerDown={(e) => { e.stopPropagation(); p.onAct(node, "replace", e); }}><Icon name="upload" size="xs" />替换</button> : null}
        {p.batchInfo && !running ? <span className="bbadge tnum">{p.batchInfo}</span> : null}
        {p.queued && !running ? <span className="qbadge" data-queued><span className="runsig" />排队中</span> : null}
        {g.err && !running ? (() => {
          // 主行只出现人话（engine 写入的 err），原始码单独一行灰字；没有可用模型时重试禁用并说明原因
          const blocked = retryBlockedReason(g.errCode || "", !!p.modelName);
          return <div className="nerr" data-nerr>
            <b>提示</b>
            <span data-nerr-text>{g.err}</span>
            {g.errCode ? <code className="nerr-code" data-nerr-code>{"代码：" + g.errCode}</code> : null}
            <div className="nerr-btns">
              <button className="ghost" data-act="errok" onPointerDown={(e) => p.onAct(node, "errok", e)}>关闭</button>
              <button className="primary" data-act="erretry" disabled={!!blocked} title={blocked || "重试这次生成"} onPointerDown={(e) => { if (blocked) return; p.onAct(node, "erretry", e); }}>重试</button>
            </div>
          </div>;
        })() : null}
      </div>
      <div className="rz" data-rz title="拖动调整大小" />
      <Ports h={node.h} />
    </div>
  );
});

/**
 * 从堆叠里出来的节点（取消堆叠 / 移出）：挂载时从堆叠的位置飞到自己的位置（TapNow）。
 * 只在第一次挂上 DOM 时读一次，之后的重绘不受影响。
 */
function useFlyOut(id: string, x: number, y: number, w: number, h: number) {
  const done = useRef(false);
  return (el: HTMLDivElement | null) => {
    if (!el || done.current) return; done.current = true;
    const f = takeFlyOut(id); if (!f) return;
    const s = Math.max(.2, Math.min(1.5, f.w / Math.max(1, w)));
    const dx = f.x + f.w / 2 - (x + w / 2), dy = f.y + f.h / 2 - (y + h / 2);
    el.classList.remove("enter");
    el.animate([{ transform: `translate(${dx}px,${dy}px) scale(${s})`, opacity: .4 }, { transform: "none", opacity: 1 }], { duration: 340, easing: "cubic-bezier(.2,0,0,1)" });
  };
}

/** 连线端口；分组 / 堆叠只有输出端（连到文本节点按组出表） */
function Ports({ h, only }: { h: number; only?: "out" }) {
  return <>{(only ? [only] : ["in", "out"] as const).map((s) => <div key={s} className={"pz " + s} data-port={s} style={{ top: 24 + h / 2 }}><div className="pf"><div className="port"><Icon name="plus" /></div></div></div>)}</>;
}

function Body(p: NodeViewProps & { out: GenOutput | null; running: boolean; hover: boolean }) {
  const { node, out, running } = p; const g = genOf(node);
  // 文本节点生成中：同 TapNow 用骨架线；流式有内容后直接按 Markdown 渲染并跟随光标
  if (running && node.kind === "text") return p.run?.stream ? <div className="ntext md-wrap streaming"><Markdown streaming text={p.run.stream} /></div> : <TextSkeleton />;
  if (running) return <><Loading /><span className="nl-lab tnum">{p.run?.batch ? `逐行生成 ${p.run.batch.done}/${p.run.batch.total}` : "生成中"}</span></>;
  if (node.kind === "image") {
    if (out?.url) return <MediaImg src={out.url} alpha={false} px={node.w} play={p.hover} nodeId={node.id} nodeW={node.w} nodeH={node.h} />;
    return <div className="ph" data-short={node.h < PH_SHORT_H ? "" : undefined}><Icon name="image" /><span>{g.uploaded ? "拖入或上传图片" : "选中后在下方描述要生成的画面"}</span></div>;
  }
  if (node.kind === "text") {
    if (p.editing) return <TextEditor node={node} onCommit={p.onTextCommit} />;
    // 版本条（hist>1 才出现）浮在右上角：文本节点给它留一条顶边，避免盖住第一行正文
    if (out?.text) return <div className="ntext md-wrap" style={g.hist.length > 1 ? { paddingTop: 34 } : undefined}><Markdown text={out.text} /></div>;
    return <div className="ph" data-short={node.h < PH_SHORT_H ? "" : undefined}><Icon name="text" /><span>双击直接书写，或在下方写指令让模型生成</span></div>;
  }
  if (node.kind === "video") {
    if (out && (out.frame || out.url)) return <VideoBody node={node} out={out} res={(genOf(node).params as VideoParams).res || out.res} hover={p.hover} />;
    return <div className="ph" data-short={node.h < PH_SHORT_H ? "" : undefined}><Icon name="video" /><span>连入图片作为首帧 / 尾帧 / 参考，或直接写提示词</span></div>;
  }
  if (out) return <AudioBody out={out} sel={p.sel} />;
  return <div className="ph" data-short={node.h < PH_SHORT_H ? "" : undefined}><Icon name="audio" /><span>音乐、配音或音效</span></div>;
}

function MediaImg({ src, alpha, px, play, nodeId, nodeW, nodeH }: { src: string; alpha: boolean; px: number; play: boolean; nodeId?: string; nodeW?: number; nodeH?: number }) {
  const url = useThumbnailUrl(src, px); const [fresh, setFresh] = useState(true);

  // 缩略图接口拿不到（老后端 / 素材被移走）时回退原图，别让节点变「资源不可用」
  const [fallback, setFallback] = useState(false);
  // 静态缩略图自己加载失败：GIF 不能退到原图（那就是动画），改退自绘首帧
  const [thumbBroken, setThumbBroken] = useState(false);
  useEffect(() => { setFresh(true); setFallback(false); setThumbBroken(false); const t = setTimeout(() => setFresh(false), 200); return () => clearTimeout(t); }, [url]);
  const full = useAssetUrl(src);
  const gif = isGifUrl(full);
  // 缩略图就是原图本身（桌面版 data URL 且长边 ≤768 的短路）或缩略图裂了，都没有静态帧可借，只能自己画；
  // 其余情况不碰原图，所以浏览器模式下默认态不会去请求/解码 GIF 原图
  const poster = useGifPoster(gif && (url === full || thumbBroken) ? full : "");
  const still = gif ? (url && url !== full && !thumbBroken ? url : poster) : (fallback ? src : url);
  const shown = gif && play ? full : still;
  if (!shown) return gif ? null : <div className="ph"><Icon name="image" /><span>资源不可用</span></div>;
  return <img src={shown} className={(alpha ? "alpha" : "") + (fresh ? " fresh" : "")} alt="" draggable={false} decoding="async"
    onError={() => { if (gif) { if (!play) setThumbBroken(true); return; } if (!fallback && url !== src) setFallback(true); }} />;
}

function Loading() {
  // 生成中不铺上游旧图做底（用户明确不要拿旧素材当背景）：只留干净的卡片底 + 扫光
  return (
    <div className="nl empty">
      <div className="nl-shadow" />
      <div className="nl-lite" />
    </div>
  );
}

/**
 * 视频节点卡片：默认只画封面 <img>（DOM 里没有 <video>、也不解析播放地址）；指针进正文才挂上静音循环预览，
 * 点播放按钮 / 画面进入固定播放（移开不停），「收起」回到封面。左下角时长 + 右下角分辨率角标；
 * 固定播放时显示自绘控制条（播放 / 时间 / 可拖进度 / 使用区间 / 截帧 / 静音 / 收起）。
 *
 * 为什么不能像以前那样有 url 就挂 <video>：画布不虚拟化，一条 N 个视频节点的画布就是 N 个 <video> +
 * N 次元数据请求 + N 次流式地址解析，逼近 Chromium 单渲染进程的媒体元素上限（约 75），
 * 也等于用户没在看的视频全在解码。
 */
function VideoBody({ node, out, res, hover }: { node: CanvasNode; out: GenOutput; res?: string; hover: boolean }) {
  const ctl = useCtl(); const store = ctl.store;
  // 封面：结果自带的帧；没有时让后端抽（previewThumbUrl 只对 /assets、/output 这类后端能读的本地素材生效，
  // 其它地址会原样返回，那种引用塞进 <img> 只会裂图，所以只认它真的改写成了 /api/media-preview 的情况）
  const frame = useThumbnailUrl(out.frame || "", node.w);
  const preview = out.frame ? "" : previewThumbUrl(out.url || "", thumbStep(node.w));
  const cover = frame || (preview.startsWith("/api/media-preview?") ? preview : "");
  const [pinned, setPinned] = useState(false); const [paused, setPaused] = useState(false); const [muted, setMuted] = useState(false);
  const [now, setNow] = useState<number | null>(null); const [total, setTotal] = useState(0); const [trimOpen, setTrimOpen] = useState(false);
  // 「收起」之后指针还在节点里：closed 只压住 hover 预览（不能让 hover 立刻又挂回来），
  // 但不能压住 pinned——否则收起后不移开鼠标再点播放就成了死键
  const [closed, setClosed] = useState(false);
  const mounted = pinned || (hover && !closed);
  const media = useMediaUrl(out.url || "", mounted); const url = media.url;
  const vref = useRef<HTMLVideoElement>(null);
  // 视频节点的框也要跟真实画面对上：助手生成 / 上传的视频常见竖版本被塞进 16:9 横框（或反过来），
  // 封面图和 <video> 元数据都能拿到真实宽高，差超过 6% 就按画面比例改一次框高（宽度不动）
  const fittedKey = useRef("");
  const fitToMedia = (mw: number, mh: number) => {
    if (!mw || !mh) return;
    const want = mw / mh;
    const cur = node.w / node.h;
    if (Math.abs(want - cur) <= 0.06) return;
    const key = node.id + ":" + Math.round(want * 100);
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    store.updateNode(node.id, (n) => ({ ...n, h: Math.max(80, Math.round(node.w / want)) }), { history: false });
  };
  const resText = res ? videoResLabel(res) : "";
  // 没设过区间也要显示（整段），拖过之后按版本存；dur 未知时按 10s 兜底
  const trim = clampTrim(out.dur, out.trim);
  const length = total > 0 ? total : Number(out.dur) > 0 ? Number(out.dur) : 0;
  /** 循环在「使用区间」里：播到 out 就跳回 in；第一帧从 in 开始 */
  const seekTo = (el: HTMLVideoElement | null, t: number) => { if (el && Number.isFinite(t)) el.currentTime = Math.max(0, t); };
  const onTick = (el: HTMLVideoElement) => {
    if (!trim) return;
    if (el.currentTime >= trim.out - 0.02 || el.currentTime < trim.in - 0.12) seekTo(el, trim.in);
  };
  // 挂上就播（<video> 是懒挂的，autoPlay 在节点重挂载时不一定触发，所以显式 play()）：
  // 预览态必须静音——浏览器只放行静音自动播放；固定播放是用户点进来的手势，沿用原来的「先试有声、被拦再静音」
  useEffect(() => {
    if (!mounted || !url) return;
    const v = vref.current; if (!v) return;
    if (trim && v.currentTime < trim.in) seekTo(v, trim.in);
    setPaused(false);
    if (pinned) {
      v.muted = false; setMuted(false);
      v.play().catch(() => { v.muted = true; setMuted(true); return v.play().catch(() => setPaused(true)); });
    } else {
      v.muted = true; setMuted(true);
      v.play().catch(() => setPaused(true));
    }
    // 进度用 rAF 刷，比 timeupdate（约 4 次/秒）顺滑；预览态没有控制条，不用每帧重渲
    let raf = 0; const loop = () => { const el = vref.current; if (el) { onTick(el); if (pinned) setNow(el.currentTime); } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, pinned, url]);
  // 收起后指针离开正文：清掉 closed，下次进来照常挂载
  useEffect(() => { if (!hover) setClosed(false); }, [hover]);
  // 服务商不一定按所选时长出片：拿到真实时长后写回当前版本（没手动设过区间时），时长角标和使用区间都按真的来
  const learnDur = (el: HTMLVideoElement) => {
    const d = el.duration; if (!Number.isFinite(d) || d <= 0) return;
    setTotal(d);
    if (out.trim || Math.abs((Number(out.dur) || 0) - d) < 0.5) return;
    const real = Math.round(d * 100) / 100;
    store.patchGen(node.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi && h.url === out.url ? { ...h, dur: real } : h)) }));
  };
  const toggle = () => { const v = vref.current; if (!v) return; if (v.paused) { void v.play().catch(() => undefined); } else v.pause(); };
  // 画面点击：预览态是「点进来固定播放」，固定态才是原来的播放/暂停
  const onSurface = () => { if (!pinned) { setPinned(true); return; } toggle(); };
  const close = () => { const v = vref.current; if (v) { v.pause(); seekTo(v, 0); } setPinned(false); setClosed(true); setPaused(true); setNow(0); };
  const saveTrim = (next: { in: number; out: number }) => {
    const t = clampTrim(out.dur, next);
    store.patchGen(node.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, trim: t } : h)) }));
  };
  const chips = <>
    <span className="vdur tnum" data-vdur>{formatClock(out.dur)}</span>
    {resText && resText !== "自适应" ? <span className="vres tnum" data-vres>{resText}</span> : null}
  </>;
  return <>
    {mounted && url ? <video ref={vref} src={url} poster={cover || undefined} playsInline muted={muted} preload="metadata" loop={!pinned}
      onLoadedMetadata={(e) => { learnDur(e.currentTarget); fitToMedia(e.currentTarget.videoWidth, e.currentTarget.videoHeight); }}
      onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
      onEnded={() => { setPaused(true); setNow(length); }}
      onError={() => media.onError()}
      onClick={(e) => { e.stopPropagation(); onSurface(); }}
      style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      : cover ? <img src={cover} alt="" draggable={false} decoding="async" onLoad={(e) => fitToMedia(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} onClick={(e) => { e.stopPropagation(); if (out.url) setPinned(true); }} /> : null}
    {!pinned ? <button className="play" data-act="play" onPointerDown={(e) => { e.stopPropagation(); if (out.url) setPinned(true); }}><Icon name="play" /></button> : null}
    {chips}
    {pinned ? <VideoControls now={now || 0} length={length} paused={paused} muted={muted} trimOpen={trimOpen}
      onToggle={toggle} onMute={() => { const v = vref.current; const m = !muted; if (v) v.muted = m; setMuted(m); }}
      onSeek={(t) => { seekTo(vref.current, t); setNow(t); }} onClose={close}
      onTrim={() => setTrimOpen((open) => !open)}
      onFrame={() => { vref.current?.pause(); window.dispatchEvent(new CustomEvent("cn:editor", { detail: { kind: "frame", id: node.id } })); }} /> : null}
    {pinned && trimOpen ? <TrimBar trim={trim} dur={out.dur} playing={!paused} onSeek={(t) => { seekTo(vref.current, t); setNow(t); }} onTrim={saveTrim} /> : null}
  </>;
}

/** 播放控制条：播放/暂停 · 当前/总时长 · 可点可拖的进度条 · 静音 · 收起 */
function VideoControls({ now, length, paused, muted, trimOpen, onToggle, onMute, onSeek, onClose, onFrame, onTrim }: { now: number; length: number; paused: boolean; muted: boolean; trimOpen: boolean; onToggle: () => void; onMute: () => void; onSeek: (t: number) => void; onClose: () => void; onFrame: () => void; onTrim: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const frac = length > 0 ? Math.max(0, Math.min(1, now / length)) : 0;
  const scrub = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault(); const box = track.current; if (!box || !(length > 0)) return;
    const at = (x: number) => { const r = box.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))) * length; };
    onSeek(at(e.clientX));
    const move = (ev: PointerEvent) => onSeek(at(ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return <div className="vctl" data-vctl onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
    <button className="vctl-b" data-act={paused ? "resume" : "pause"} title={paused ? "播放" : "暂停"} onClick={onToggle}><Icon name={paused ? "play" : "pause"} size="s" /></button>
    <span className="vctl-t tnum" data-vtime>{formatClock(now)} / {formatClock(length)}</span>
    <div className="vctl-track" data-vtrack data-frac={frac.toFixed(3)} ref={track} onPointerDown={scrub}>
      <span className="vctl-rail" /><span className="vctl-fill" style={{ width: frac * 100 + "%" }} /><span className="vctl-knob" style={{ left: frac * 100 + "%" }} />
    </div>
    <button className="vctl-b" data-act="trim" title="使用区间（入点 / 出点）" aria-pressed={trimOpen} onClick={onTrim}><Icon name="scissors" size="s" /></button>
    <button className="vctl-b" data-act="vframe" title="导出当前帧（生成图片节点）" onClick={onFrame}><Icon name="camera" size="s" /></button>
    <button className="vctl-b" data-act="mute" title={muted ? "取消静音" : "静音"} onClick={onMute}><Icon name={muted ? "mute" : "volume"} size="s" /></button>
    <button className="vctl-b" data-act="stop" title="停止播放" onClick={onClose}><Icon name="x" size="s" /></button>
  </div>;
}

/** 节点底部的「使用区间」条：两个手柄 + 区间/总时长文本；拖动时实时写回当前版本 */
function TrimBar({ trim, dur, playing, onSeek, onTrim }: { trim: VideoTrim; dur?: number; playing?: boolean; onSeek: (t: number) => void; onTrim: (next: VideoTrim) => void }) {
  const total = Number.isFinite(Number(dur)) && Number(dur) > 0 ? Number(dur) : 10;
  const ref = useRef<HTMLDivElement>(null);
  const drag = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation(); const box = ref.current; if (!box) return;
    const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId);
    const W = box.clientWidth;
    const move = (ev: PointerEvent) => {
      const r = box.getBoundingClientRect();
      const t = ((ev.clientX - r.left) / Math.max(1, W)) * total;
      const next = which === "in" ? { in: t, out: trim.out } : { in: trim.in, out: t };
      onTrim(next);
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const left = (trim_in: number) => Math.max(0, Math.min(100, (trim_in / total) * 100));
  return <div className="trim" data-trim={trim.in.toFixed(2) + "|" + trim.out.toFixed(2)} ref={ref} onPointerDown={(e) => e.stopPropagation()}>
    <span className="trim-rail" />
    <span className="trim-sel" style={{ left: left(trim.in) + "%", width: Math.max(0, left(trim.out) - left(trim.in)) + "%" }} />
    <button className="trim-h in" data-trim-handle="in" title="入点" style={{ left: left(trim.in) + "%" }} onPointerDown={drag("in")} onClick={() => playing && onSeek(trim.in)} />
    <button className="trim-h out" data-trim-handle="out" title="出点" style={{ left: left(trim.out) + "%" }} onPointerDown={drag("out")} onClick={() => playing && onSeek(trim.out)} />
    <span className="trim-lab left tnum">{Math.round(trim.in * 10) / 10}s</span>
    <span className="trim-lab right tnum" data-trim-total>{Math.round(trim.out * 10) / 10}s · 共 {Math.round((trim.out - trim.in) * 10) / 10}s / {Math.round(total * 10) / 10}s</span>
  </div>;
}

function TextEditor({ node, onCommit }: { node: CanvasNode; onCommit: (id: string, text: string) => void }) {
  const [v, setV] = useState(outOf(node)?.text || ""); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className="ntext edit" onPointerDown={(e) => e.stopPropagation()}><textarea ref={ref} id="txtEdit" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(node.id, v)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); (e.target as HTMLTextAreaElement).blur(); } }} /></div>;
}

export { TYPE_LABEL };
