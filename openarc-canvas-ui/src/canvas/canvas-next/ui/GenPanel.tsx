/**
 * 选中单个节点时：节点上方工具条 + 节点下方生成面板。
 * 生成面板：输入（可拖动排序）→ 提示词（@ 引用上游分段）→ 提示 → 请求预览 → 底栏（模型 / 参数 / 张数 / 发送）。
 * 上游连着多维表格时，面板中间出现「生成输入」逐行列表与批量设置。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { addMention, afterInputsChanged, title } from "../actions";
import { mentionable, unmentionedInputs } from "../mentions";
import { PromptEditor } from "./PromptEditor";
import { buildRequest, rolesFor, ROLE_LABEL, runNode, stopNode } from "../engine";
import { mjHdAllowed, mjSummary, MJ_SPEED_LABEL, type MjParams } from "../model";
import { bgColor, CAMERAS, cameraSummary, clamp, clampParams, DEFAULT_CAMERA, formatClock, genOf, NODE_BG, NODE_TAG, placeholderSpec, tagColor, inputsOf, isGenKind, outOf, ratioWH, refsIn, sectionsOf, srcOf, textOf, TYPE_ICON, TYPE_LABEL, uid, videoDurLabel, videoRatioLabel, videoResLabel, videoTimesLabel, VMODES, resRange, type AudioParams, type CameraParams, type GenKind, type ImageParams, type ModelSpec, type TextParams, type VideoParams, type VideoMode } from "../model";
import { batchOf, batchRows, fillCandidates, fillTargetOf, OUTPUT_MODES, planRow, rowsToRun, tableOf, withBatch, type BatchSettings } from "../table";
import { useCtl, useS } from "./ctx";
import { Icon, type IconName } from "./Icon";
import { download } from "./menus";
import { saveNodeToLibrary } from "./Library";
import { closePop, openPop } from "./overlay";
import { useAssetUrl } from "./useAsset";
import { OptimizeButton } from "./OptimizeButton";
import { useEditorState } from "./editors/registry";
import { draftToFinal, smartClip, trimToNode } from "../videoTools";
import { videoAiMenu } from "./VideoTools";
import type { CanvasStore } from "../store";

export function SelectionUI() {
  const ctl = useCtl(); const ui = useS((s) => s.ui); const doc = useS((s) => s.doc); useS((s) => s.view); const runtime = useS((s) => s.runtime);
  const editing = useEditorState();
  const id = ui.sel.size === 1 && !ui.dragging && !editing ? [...ui.sel][0] : null;
  const node = id ? doc.nodes.find((n) => n.id === id) : undefined;
  const tbRef = useRef<HTMLDivElement>(null); const gpRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ tb: { left: number; top: number } | null; gp: { left: number; top: number } | null }>({ tb: null, gp: null });
  const [enterKey, setEnterKey] = useState(id);
  useEffect(() => { if (id !== enterKey) setEnterKey(id); }, [id, enterKey]);
  useLayoutEffect(() => {
    if (!node) return; const sr = ctl.rect(); const a = ctl.toScreen(node.x, node.y), b = ctl.toScreen(node.x + node.w, node.y + 24 + node.h);
    const cx = (a.x + b.x) / 2 - sr.left; let tb = null, gp = null;
    // 左侧竖排工具栏（#lb）所在的高度范围内，浮层不压到它上面：左边界让到工具栏右侧
    const lb = (tbRef.current || gpRef.current)?.closest(".cn-root")?.querySelector("#lb")?.getBoundingClientRect();
    const minLeft = (top: number, h: number) => (lb && lb.width && top < lb.bottom - sr.top && top + h > lb.top - sr.top ? Math.max(8, lb.right - sr.left + 8) : 8);
    if (tbRef.current) { const tw = tbRef.current.offsetWidth, th = tbRef.current.offsetHeight; const ty = a.y - sr.top - 52; const top = Math.max(8, ty); tb = ty > sr.height - 60 || b.y < sr.top ? { left: -9999, top: -9999 } : { left: clamp(cx - tw / 2, minLeft(top, th), sr.width - tw - 8), top }; }
    if (gpRef.current) { const gw = gpRef.current.offsetWidth, gh = gpRef.current.offsetHeight; let top = b.y - sr.top + 14; const safeB = gpRef.current.closest(".cn-root.in-win") ? 76 : 8; /* 嵌在系统窗口里：底部给会弹出的 Dock 让位 */ if (top + gh > sr.height - safeB) top = Math.max(8, sr.height - gh - safeB); gp = { left: clamp(cx - gw / 2, minLeft(top, gh), sr.width - gw - 8), top }; }
    if (JSON.stringify(tb) !== JSON.stringify(pos.tb) || JSON.stringify(gp) !== JSON.stringify(pos.gp)) setPos({ tb, gp });
  });
  if (!node) return null;
  const run = runtime[node.id];
  return <>
    <Toolbar key={"t" + node.id} refEl={tbRef} node={node} running={!!run} progress={run?.progress || 0} style={pos.tb || { left: -9999, top: -9999 }} />
    {isGenKind(node.kind) ? <div id="gp" key={"g" + node.id} ref={gpRef} className={"float enter" + (node.kind === "video" ? " gp-video" : "")} style={pos.gp || { left: -9999, top: -9999 }} onPointerDown={(e) => e.stopPropagation()}><GenPanel node={node} /></div> : null}
  </>;
}

function Toolbar({ node, running, progress, style, refEl }: { node: CanvasNode; running: boolean; progress: number; style: React.CSSProperties; refEl: React.RefObject<HTMLDivElement | null> }) {
  const ctl = useCtl(); const store = ctl.store; const out = isGenKind(node.kind) ? outOf(node) : null; const g = isGenKind(node.kind) ? genOf(node) : null;
  const B = (act: string, ic: IconName, tip: string, lab = "", on?: (el: HTMLElement) => void) => <button key={act} className={"ib tipT" + (lab ? " lab" : "")} data-tb={act} data-tip={tip} onClick={(e) => on ? on(e.currentTarget) : edit(act, e.currentTarget)}><Icon name={ic} />{lab}</button>;
  /** TapNow「背景颜色」：无色 + 7 种低饱和色，竖排弹出 */
  const bgBtn = () => <button key="bg" className="ib tipT bgdot-btn" data-tb="bg" data-tip="背景颜色" onClick={(e) => openPop(e.currentTarget, (close) => <div className="swatches v">
    <button className={"sw none" + (!g!.bg ? " on" : "")} aria-label="无" onClick={() => { close(); store.patchGen(node.id, { bg: undefined }, { history: true }); }} />
    {NODE_BG.map(([k, c]) => <button key={k} className={"sw" + (g!.bg === k ? " on" : "")} style={{ background: c }} aria-label={k} onClick={() => { close(); store.patchGen(node.id, { bg: k }, { history: true }); }} />)}
  </div>, "down", "left", "pop-sw")}><i className="bgdot" style={{ background: bgColor(g!.bg) || "var(--fg)" }} /></button>;
  /** TapNow「Pin」：6 种亮色标签，再点同色取消 */
  const tagBtn = () => <button key="pin" className={"ib tipT" + (g!.tag ? " on" : "")} data-tb="pin" data-tip={g!.tag ? "颜色标记" : "标记"} onClick={(e) => openPop(e.currentTarget, (close) => <div className="swatches h">
    <button className={"sw none" + (!g!.tag ? " on" : "")} aria-label="无" data-tag="none" onClick={() => { close(); store.patchGen(node.id, { tag: undefined, pinned: false }, { history: true }); }} />
    {NODE_TAG.map(([k, c]) => <button key={k} className={"sw" + (g!.tag === k ? " on" : "")} style={{ background: c }} aria-label={k} onClick={() => { close(); store.patchGen(node.id, g!.tag === k ? { tag: undefined, pinned: false } : { tag: k, pinned: true }, { history: true }); }} />)}
  </div>, "up", "left", "pop-sw")}><Icon name="tag" />{g!.tag ? <i className="tagmini" style={{ background: tagColor(g!.tag)! }} /> : null}</button>;
  /** 存进桌面资产库（与右键「存入资产库」同一条路径）；没有桌面后端时只能在本画布收藏，提示里如实说明 */
  const saveToLibrary = (el: HTMLElement) => {
    if (store.backend.kind !== "bridge") { store.patchGen(node.id, { fav: true }); store.toast(`「${g!.title}」已收藏到本画布（资产库只在桌面版里可用）`); return; }
    const r = el.getBoundingClientRect(); void saveNodeToLibrary(ctl, node, { x: r.left, y: r.bottom + 6 });
  };
  const edit = (k: string, el: Element) => window.dispatchEvent(new CustomEvent("cn:editor", { detail: { kind: k, id: node.id, anchor: el } }));
  let items: React.ReactElement[] = [];
  // 生成中：视频节点参数条全禁用，工具条里只有「截帧」还能用（对齐 TapNow）；其它类型保持只有「停止」
  if (running) items = node.kind === "video"
    ? [B("frame", "frame", "截帧（快捷键 1）", "截帧"), <span key="e" className="est" data-running="1">生成中</span>, B("stop", "x", "停止生成", "", () => stopNode(store, node.id))]
    : [<span key="e" className="est" data-running="1">生成中</span>, B("stop", "x", "停止生成", "", () => stopNode(store, node.id))];
  else if (node.kind === "image") items = !out ? [B("upload", "upload", "上传图片", "上传", () => window.dispatchEvent(new CustomEvent("cn:upload", { detail: { target: node.id, at: { x: node.x + 120, y: node.y + 120 } } })))]
    : [B("crop", "crop", "裁剪"), B("angle", "cube", "多角度"), B("mask", "brush", "局部重绘"), B("relight", "sun", "重打光"), B("more", "more", "更多"), <span key="s" className="vsep" />, tagBtn(), B("lib", "libadd", "保存到素材库", "", (el) => saveToLibrary(el)), B("dl", "download", "下载", "", () => void download(node, store)), B("full", "expand", "全屏查看", "", () => window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id })))];
  else if (node.kind === "text") items = [bgBtn(), tagBtn(), <span key="s" className="vsep" />, B("copy", "copy", "复制全部", "", async () => { try { await navigator.clipboard.writeText(textOf(node)); store.toast("已复制全部内容"); } catch { store.toast("剪贴板不可用"); } }), B("lib", "libadd", "保存到素材库", "", (el) => { const r = el.getBoundingClientRect(); void saveNodeToLibrary(ctl, node, { x: r.left, y: r.bottom + 6 }); }), B("full", "expand", "全屏编辑", "", () => window.dispatchEvent(new CustomEvent("cn:textdoc", { detail: node.id })))];
  else if (node.kind === "video" && out) items = [
    // TapNow 视频工具栏：修剪 / 智能切镜 / AI 编辑（替换·移除·续写·重拍）/ 截帧 / 更多 ┃ 标签 ┃ 保存素材库 / 下载 / 全屏
    // 草稿模式出的低清版本最前面多一个「出成片」
    ...(out.draft ? [B("final", "sparkle", "按最高清晰度重新生成成片", "出成片", () => void draftToFinal(store, node))] : []),
    B("trim", "scissors", "修剪：把使用区间裁成新视频节点", "", () => void trimToNode(store, node)),
    B("smartclip", "split", "智能切镜：按镜头拆成多个节点", "", () => void smartClip(store, node)),
    <button key="vai" className="ib tipT lab" data-tb="vai" data-tip="AI 编辑：替换 / 移除 / 续写 / 重拍" onClick={(e) => videoAiMenu(store, node, e.currentTarget)}><Icon name="wand" />AI 编辑</button>,
    B("frame", "frame", "截帧（快捷键 1）", "截帧"),
    <button key="vmore" className="ib tipT" data-tb="vmore" data-tip="更多" onClick={(e) => videoMore(store, node, e.currentTarget)}><Icon name="more" /></button>,
    <span key="s1" className="vsep" />, tagBtn(), <span key="s2" className="vsep" />,
    B("lib", "libadd", "保存到素材库", "", (el) => saveToLibrary(el)),
    B("dl", "download", "下载", "", () => void download(node, store)),
    B("full", "expand", "全屏播放", "", () => window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id }))),
  ];
  // TapNow 音频结果：颜色标记 ┃ 保存素材库 / 下载
  else if (node.kind === "audio" && out) items = [tagBtn(), <span key="s" className="vsep" />, B("lib", "libadd", "保存到素材库", "", (el) => saveToLibrary(el)), B("dl", "download", "下载", "", () => void download(node, store))];
  if (!items.length) return null;
  return <div id="ntb" ref={refEl} className="float enter" style={style} onPointerDown={(e) => e.stopPropagation()}>{items}</div>;
}

/* ---------------- 生成面板 ---------------- */
function GenPanel({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const run = useS((s) => s.runtime[node.id]); const preview = useS((s) => s.ui.preview); const pick = useS((s) => s.ui.pick); useS((s) => s.models);
  const kind = node.kind as GenKind; const g = genOf(node); const m = store.modelOf(node); const p = g.params;
  const allIns = inputsOf(doc, node.id); const unm = unmentionedInputs(node, allIns);
  const ins = allIns.filter((x) => x.node.kind !== "table" && !unm.has(x.edge.id)); const tables = allIns.filter((x) => x.node.kind === "table");
  const { roles, ignored } = rolesFor(kind, p, m, ins);
  const imgIns = ins.filter((x) => x.node.kind === "image");
  const optsRef = useRef<HTMLDivElement>(null); const [fit, setFit] = useState(true);
  useLayoutEffect(() => { const o = optsRef.current; if (o) setFit(o.scrollWidth <= o.clientWidth + 1); });
  const [draft, setDraft] = useState(g.prompt); const lastId = useRef(node.id);
  /** 风格 / 摄影机：自己管浮层（不进全局 popover 栈），这样 enter/exit 150ms 能按 SPEC 走完整；锚点取自 chip */
  const [camOpen, setCamOpen] = useState(false); const camRef = useRef<HTMLButtonElement>(null);
  const [styleOpen, setStyleOpen] = useState(false); const styleRef = useRef<HTMLButtonElement>(null);
  const openCamera = () => {
    const cam = (genOf(store.node(node.id)!).params as ImageParams).camera;
    if (!cam || !cam.on) store.patchGen(node.id, (gg) => ({ params: { ...gg.params, camera: { ...DEFAULT_CAMERA, on: true } } }));
    setCamOpen(true);
  };
  const clearCamera = () => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, camera: { ...DEFAULT_CAMERA, on: false } } }));

  useEffect(() => { if (lastId.current !== node.id || document.activeElement?.id !== "gpPrompt") { setDraft(g.prompt); lastId.current = node.id; } }, [g.prompt, node.id]);
  // 视频结果快捷键（对齐 TapNow）：1 截帧 / 2 首帧 / 3 尾帧；正在输入时不抢键
  useEffect(() => {
    if (kind !== "video") return;
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (e.key !== "1" && e.key !== "2" && e.key !== "3") return;
      const live = store.node(node.id);
      if (!live || !outOf(live)) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("cn:editor", { detail: { kind: e.key === "1" ? "frame" : e.key === "2" ? "firstframe" : "lastframe", id: node.id } }));
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [kind, node.id, store]);
  const commitPrompt = (v: string) => { if (v !== genOf(store.node(node.id)!).prompt) store.patchGen(node.id, { prompt: v }); };
  /** 编辑器每次改动：插入 @ 引用时立刻写回并切到引用模式（其余改动失焦时写回） */
  const onPrompt = (v: string, o?: { mention?: boolean }) => { setDraft(v); if (o?.mention) store.patchGen(node.id, { prompt: v, refMode: "mention" }); };

  const warns: string[] = [];
  if (!m) warns.push(`还没有可用的${TYPE_LABEL[kind]}模型，请在 设置 › 模型 里添加。`);
  if (m && kind === "image" && imgIns.length && !m.i2i) warns.push(`${m.name} 不支持参考图，${imgIns.length} 张图片输入不会发送。`);
  else if (m && kind === "image" && imgIns.length > (m.maxRefs || 0)) warns.push(`${m.name} 最多接收 ${m.maxRefs} 张参考图，按连线顺序只发送前 ${m.maxRefs} 张。`);
  if (m && kind === "text" && imgIns.length && !m.vision) warns.push(`${m.name} 不读图片，${imgIns.length} 张图片输入会被忽略。`);
  if (kind === "video") { const vp = p as VideoParams; if (["视频编辑", "视频延长", "参考视频生视频"].includes(vp.mode) && !ins.some((x) => x.node.kind === "video") && !tables.length) warns.push(`「${vp.mode}」需要连入一段视频。`); if (vp.mode === "数字人" && !(imgIns.length && ins.some((x) => x.node.kind === "audio"))) warns.push("「数字人」需要 1 张人像和 1 段音频。"); if (imgIns.length && vp.mode === "文生视频") warns.push("当前是文生视频，图片输入不会发送。切到「首帧」可以用上第 1 张图。"); }
  refsIn(g.prompt, ins).missing.forEach((r) => warns.push(`找不到引用「@${r}」：确认上游节点里有这一段。`));

  const set = (patch: Partial<typeof p>) => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, ...patch } as typeof p }));
  const send = () => { commitPrompt(draft); runNode(store, node.id).catch((err) => { console.error(err); store.toast("生成出错：" + (err instanceof Error ? err.message : String(err))); }); };
  const est = m ? (kind === "image" ? `约 ${m.secs * ((p as ImageParams).count || 1)}s` : `约 ${m.secs}s`) : "";

  // 输入芯片拖动排序
  const chipDrag = useRef<{ moved: boolean } | null>(null);
  const onChipDown = (e: React.PointerEvent, edgeId: string) => {
    if ((e.target as HTMLElement).closest("[data-rm]")) return; e.stopPropagation();
    const chip = e.currentTarget as HTMLElement; const box = chip.parentElement!; const chips = [...box.querySelectorAll<HTMLElement>(".chip-in")];
    const from = chips.indexOf(chip); const rects = chips.map((c) => c.getBoundingClientRect()); const step = rects.length > 1 ? rects[1].left - rects[0].left : 46;
    let moved = false, to = from; const sx = e.clientX; chip.setPointerCapture(e.pointerId); chipDrag.current = { moved: false };
    chip.onpointermove = (ev) => { const dx = ev.clientX - sx; if (!moved && Math.abs(dx) < 4) return; if (!moved) { moved = true; chipDrag.current!.moved = true; chip.classList.add("dragging"); chips.forEach((c) => c !== chip && c.classList.add("shift")); } chip.style.transform = `translateX(${dx}px) scale(1.06)`; to = clamp(Math.round(from + dx / step), 0, chips.length - 1); chips.forEach((c, i) => { if (c === chip) return; let off = 0; if (from < to && i > from && i <= to) off = -step; if (from > to && i < from && i >= to) off = step; c.style.transform = off ? `translateX(${off}px)` : ""; }); };
    chip.onpointerup = () => { chip.onpointermove = null; chips.forEach((c) => { c.style.transform = ""; c.classList.remove("shift", "dragging"); }); if (!moved) { chipDrag.current = null; chipMenu(edgeId, chip); return; } setTimeout(() => (chipDrag.current = null), 50); if (to !== from) { const list = allIns.map((x) => x.edge.id); const [it] = list.splice(from, 1); list.splice(to, 0, it); store.reorderInputs(node.id, list); afterInputsChanged(store, node.id); store.toast(`「${title(store.node(allIns[from].node.id)!)}」移到第 ${to + 1} 位`); } };
  };
  const chipMenu = (edgeId: string, anchor: Element) => {
    const x = allIns.find((y) => y.edge.id === edgeId)!; const i = allIns.indexOf(x); const src = x.node;
    const move = (d: number) => { const list = allIns.map((y) => y.edge.id); [list[i], list[i + d]] = [list[i + d], list[i]]; store.reorderInputs(node.id, list); afterInputsChanged(store, node.id); };
    openPop(anchor, (close) => <>
      <div className="mh">输入 {i + 1} · {title(src)}</div>
      <button className="mi" disabled={i === 0} onClick={() => { close(); move(-1); }}><Icon name="up" size="s" />前移一位</button>
      <button className="mi" disabled={i === allIns.length - 1} onClick={() => { close(); move(1); }}><Icon name="down" size="s" />后移一位</button>
      {mentionable(src) ? <button className="mi" data-k="mention" onClick={() => { close(); commitPrompt(draft); addMention(store, node.id, src.id); ctl.focusPrompt(); }}><Icon name="link" size="s" />在提示词里 @ 引用</button> : null}
      <button className="mi" onClick={() => { close(); ctl.focusNode(src.id); }}><Icon name="search" size="s" />在画布中定位</button>
      <button className="mi danger" onClick={() => { close(); store.removeEdge(edgeId); afterInputsChanged(store, node.id); }}><Icon name="x" size="s" />移除这个输入</button>
    </>);
  };
  /** 图片提示词里输入 /：快捷指令（TapNow Prompt shortcuts），↑↓ 选、↵ / Tab 确定、Esc 关 */
  const slashMenu = (ta: HTMLElement) => {
    if (kind !== "image") return;
    const hasRef = ins.some((x) => x.node.kind === "image");
    const put = (sc: PromptShortcut) => {
      const v = draft.replace(/\/\s*$/, "") + sc.prompt; setDraft(v); commitPrompt(v);
      if (sc.ratio && (!m?.ratios?.length || m.ratios.includes(sc.ratio))) set({ ratio: sc.ratio } as Partial<ImageParams>);
      if (sc.needRef && !hasRef) store.toast("这个指令要先连一张参考图");
      setTimeout(() => ta.focus(), 0);
    };
    openPop(ta, (close) => <SlashList onPick={(sc) => { close(); put(sc); }} onClose={() => { close(); ta.focus(); }} />);
  };
  const ph = kind === "text" ? (g.manual ? "这是手写文本节点。写一条指令可以让模型改写它，或双击节点直接编辑" : (p as TextParams).output === "table" ? "描述要拆成哪些行、每行包含什么，上游文字和素材会一起发送" : (p as TextParams).output === "storyboard" ? "描述这条片子的内容，会拆成逐镜头的分镜表" : "写给模型的指令，输入 @ 引用上游节点") : kind === "video" ? "描述镜头运动、主体动作和氛围，输入 @ 引用上游节点" : kind === "audio" ? "描述想要的音乐或声音，输入 @ 引用上游节点" : "描述任何你想要生成的内容，输入 @ 引用上游节点";
  // 视频编辑器：TapNow 排法 —— 顶部参考缩略图（首帧/尾帧）+ 交换 + 「+」，下面提示词；
  // 底部一行左边「模型 · 生成方式 · 比例 · 清晰度 · 时长」文字值，右边 次数 + 圆形发送；音频收成行首图标。
  if (kind === "video") {
    const vp = p as VideoParams; const busy = !!run;
    const imgs = ins.filter((x) => x.node.kind === "image");
    const hasLast = (m?.modes || []).includes("首尾帧");
    const first = imgs.find((x) => roles.get(x.edge.id) === "first_frame") || imgs[0];
    const last = imgs.find((x) => roles.get(x.edge.id) === "last_frame") || (hasLast ? imgs[1] : undefined);
    const dropRef = (x: typeof imgs[number]) => { store.removeEdge(x.edge.id); afterInputsChanged(store, node.id); store.toast(`已移除「${title(x.node)}」`); };
    const addMenu = (anchor: Element) => openPop(anchor, (close) => <>
      <button className="mi" onClick={() => { close(); store.setUI({ pick: node.id }); store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" />从画布选择</button>
      <button className="mi" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: { x: node.x - 360, y: node.y + 120 }, linkTo: node.id } })); }}><Icon name="upload" size="s" />上传图片</button>
      <button className="mi" onClick={() => { close(); store.setUI({ drawer: "assets" }); window.dispatchEvent(new CustomEvent("cn:lib-link", { detail: node.id })); }}><Icon name="folder" size="s" />从素材库选择</button>
    </>, "down", "left");
    const slot = (key: "first" | "last", label: string, x?: (typeof imgs)[number]) => (
      <button key={key} className={"vp-thumb" + (x ? " has" : "")} data-fram={key} data-empty={x ? undefined : "1"} disabled={busy}
        title={x ? title(x.node) : `从画布选一张图作为${label}`}
        onClick={(e) => {
          if (busy) return;
          if (!x) { store.setUI({ pick: node.id }); store.toast(`点画布上的图片节点，把它连成「${label}」`); return; }
          openPop(e.currentTarget, (close) => <>
            <div className="mh">{label} · {title(x.node)}</div>
            <button className="mi" onClick={() => { close(); ctl.focusNode(x.node.id); }}><Icon name="search" size="s" />在画布中定位</button>
            <button className="mi" onClick={() => { close(); store.setUI({ drawer: "assets" }); window.dispatchEvent(new CustomEvent("cn:lib-link", { detail: node.id })); }}><Icon name="folder" size="s" />从素材库换一张</button>
            <button className="mi danger" onClick={() => { close(); dropRef(x); }}><Icon name="x" size="s" />移除这张</button>
          </>, "down", "left");
        }}>
        {x ? <ChipImg src={srcOf(x.node)} /> : <Icon name="image" size="s" />}
        <span className="fl">{label}</span>
      </button>
    );
    const swap = () => {
      if (!first || !last || first === last) return;
      const order = ins.map((x) => x.edge.id);
      const a = order.indexOf(first.edge.id), b = order.indexOf(last.edge.id);
      if (a < 0 || b < 0) return;
      [order[a], order[b]] = [order[b], order[a]];
      store.reorderInputs(node.id, order);
      afterInputsChanged(store, node.id);
      store.toast("已交换首帧 / 尾帧");
    };
    return <>
      <div className="vp-top">
        <button className={"vp-pick tipB" + (pick === node.id ? " on" : "")} data-p="vpick" data-tip="从画布选择输入" onClick={() => { const on = pick !== node.id; store.setUI({ pick: on ? node.id : null }); if (on) store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" /></button>
        {slot("first", "首帧", first)}
        {hasLast ? <><button className="vp-swap tipB" data-p="vswap" data-fram-swap data-tip="交换首尾帧" disabled={busy || !first || !last} onClick={swap}><Icon name="branch" size="xs" /></button>{slot("last", "尾帧", last)}</> : null}
        <button className="vp-add tipB" data-p="addin" data-tip="添加参考图" onClick={(e) => addMenu(e.currentTarget)}><Icon name="plus" size="s" /></button>
        {m?.modes?.includes("视频编辑") ? <button className="vp-object" data-p="object-replace" disabled={busy} onClick={() => { set({ mode: "视频编辑" }); const next = draft.trim() || "替换源视频中的目标对象，保持其他人物、背景、光照、镜头运动和场景连续性不变"; setDraft(next); commitPrompt(next); }}><Icon name="wand" size="xs" />对象替换</button> : null}
      </div>
      <PromptEditor node={node} className="vp-prompt" placeholder={ph} value={draft} onChange={onPrompt} onCommit={commitPrompt} onSend={send} onEscape={() => store.setUI({ sel: new Set(), pick: null })} />
      {tables.length ? <BatchPanel node={node} /> : null}
      {unm.size ? <UnrefWarn node={node} ids={[...unm]} onAdd={() => commitPrompt(draft)} /> : null}
    {warns.map((w) => <div key={w} className="gp-warn"><Icon name="alert" size="s" /><span>{w}</span></div>)}
      <div className="vp-foot">
        <button className={"vp-audio tipT" + (vp.sound ? " on" : "")} data-p="vaudio" data-tip={vp.sound ? "音频：开" : "音频：关"} disabled={busy || !m?.audio} onClick={() => set({ sound: !vp.sound })}><Icon name="audio" size="s" /></button>
        <OptimizeButton node={node} draft={draft} setDraft={setDraft} className="vp-audio opt" />
        <button className="vp-model" data-p="model" onClick={(e) => paramPop(ctl, node, "model", e.currentTarget)} title={m?.name || "未配置模型"}>{m?.name || "未配置模型"}</button>
        <span className="vp-between" />
        <button className="vp-vals" data-p="vset" disabled={busy} title={m ? `${m.name} 的参数：点开调整` : "还没有可用的视频模型"} onClick={(e) => paramPop(ctl, node, "vset", e.currentTarget)}>
          <span data-vval="mode">{vp.mode}</span>
          <i>·</i>
          <span data-vval="ratio">{videoRatioLabel(vp.ratio)}</span>
          <i>·</i>
          <span data-vval="res">{vp.draft && resRange(m) ? `草稿 ${resRange(m)!.low}` : videoResLabel(vp.res)}</span>
          <i>·</i>
          <span data-vval="dur">{videoDurLabel(vp.dur)}</span>
        </button>
        <span className="grow" />
        <button className="vp-times tnum" data-p="vtimes" disabled={busy || !m || (m.times || [1]).length < 2} onClick={(e) => paramPop(ctl, node, "vtimes", e.currentTarget)}>{videoTimesLabel(vp.times)}</button>
        {run
          ? <button className="vp-send busy" data-p="stop" title="停止生成" onClick={() => stopNode(store, node.id)}><span className="sqr" /></button>
          : <button className="vp-send" data-p="send" title="生成 ⌘↵" onClick={send}><Icon name="send" size="s" /></button>}
      </div>
    </>;
  }
  const pill = (k: string, content: React.ReactNode, on = false, extraCls = "") => <button key={"p-" + k} className={"pill" + (on ? " on" : "") + (extraCls ? " " + extraCls : "")} data-p={k} onClick={(e) => paramPop(ctl, node, k, e.currentTarget)}>{content}</button>;
  const vline = (k: string) => <span key={k} className="vline" />;
  const foot: React.ReactNode[] = [];
  if (kind === "audio") { const ap = p as AudioParams; foot.push(pill("model", <><Icon name="sparkle" size="s" />{m?.name || "未配置模型"}<Icon name="down" size="xs" /></>), vline("v1"), pill("akind", <><Icon name="audio" size="s" />{ap.kind}</>), vline("v2"), pill("adur", <>{ap.dur}</>)); }
  // 图片 / 文本：TapNow 式单行文本（模型 ｜ 比例 · 尺寸 · 次数 · 风格 · 摄影机），点哪段开哪段弹层，能力不丢
  // 没模型时节段灰显（仍可点开看有哪些档位，弹层里的控件是禁用的）
  const seg = (k: string, label: React.ReactNode, on = false, muted = !m) => <button key={"seg-" + k} className={"gp-seg" + (on ? " on" : "") + (muted ? " muted" : "")} data-p={k} data-seg={k} title={muted ? "还没有可用的模型，添加后可调" : undefined} onClick={(e) => paramPop(ctl, node, k, e.currentTarget)}>{label}</button>;
  const gdot = (k: string) => <i key={"gd-" + k} className="gp-dot">·</i>;
  const gline: React.ReactNode[] = [<button key="seg-model" className="gp-seg model" data-p="model" data-seg="model" onClick={(e) => paramPop(ctl, node, "model", e.currentTarget)}>{m?.name || "未配置模型"}</button>];
  if (kind === "image") {
    const ip = p as ImageParams;
    gline.push(<span key="gp-bar1" className="gp-bar" />, seg("ratio", <>{ip.ratio} · {ip.size}</>), gdot("c1"), seg("count", <>{ip.count}×</>));
    if (m?.mj) gline.push(gdot("cmj"), seg("mj", <>{mjSummary(ip.mj)}</>, !!(ip.mj && (ip.mj.version || ip.mj.hd || typeof ip.mj.stylize === "number" || (ip.mj.speed && ip.mj.speed !== "fast")))));
    // 风格 / 摄影机按「模型真的会转发」才渲染（没有能力就不给入口，不置灰）
    if (m?.style) gline.push(gdot("c2"), <button key="chip-style" ref={styleRef} type="button" data-p="style" data-chip="style"
      className={"gp-chip style" + (ip.style !== "无" ? " on" : "")} title="风格仅基于图片生效" onClick={() => setStyleOpen(true)}>
      <span className="ic"><StyleGlyph /></span><span className="lbl">{ip.style === "无" ? "风格" : ip.style}</span>
    </button>);
    if (m?.camera) gline.push(gdot("c3"), <button key="chip-camera" ref={camRef} type="button" data-p="camera" data-chip="camera"
      className={"gp-chip cam" + (ip.camera.on ? " on" : "")} title={ip.camera.on ? cameraSummary(ip.camera) : "摄影机控制"} onClick={openCamera}>
      <span className="ic"><CamGlyph kind="chip" /></span><span className="lbl">{ip.camera.on ? CAMERAS.body[Math.max(0, Math.min(CAMERAS.body.length - 1, ip.camera.body))] : "摄影机控制"}</span>
      {ip.camera.on ? <span className="x" data-rm-camera role="button" aria-label="清空摄影机组合" onClick={(e) => { e.stopPropagation(); clearCamera(); }}><Icon name="x" size="xs" /></span> : null}
    </button>);
    if (ip.search) gline.push(gdot("c4"), <span key="gp-net" className="gp-seg on" data-seg="search">联网</span>);
  }
  if (kind === "text") {
    const tp = p as TextParams;
    gline.push(<span key="gp-bar1" className="gp-bar" />, seg("output", OUTPUT_MODES.find((o) => o[0] === (tp.output || "text"))![1], tp.output === "table" || tp.output === "storyboard"));
    if (!m || m.search) gline.push(gdot("c2"), <button key="gp-net" className={"gp-seg" + (tp.search ? " on" : "") + (!m ? " muted" : "")} data-seg="tsearch" disabled={!m} onClick={() => set({ search: !tp.search })}>联网{tp.search ? " 开" : ""}</button>);
  }
  return <>
    <div className="gp-in">
      <button className={"sq tipT" + (pick === node.id ? " on" : "")} data-p="pick" data-tip="从画布选择输入" onClick={() => { const on = pick !== node.id; store.setUI({ pick: on ? node.id : null }); if (on) store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" /></button>
      {allIns.map((x) => { const src = srcOf(x.node); return (
        <button key={x.edge.id} className={"sq chip-in" + (src ? "" : " txt") + (ignored.has(x.edge.id) || unm.has(x.edge.id) ? " ignored" : "") + (unm.has(x.edge.id) ? " unref" : "")} data-chip={x.edge.id} title={unm.has(x.edge.id) ? `「${title(x.node)}」没有在提示词里 @ 引用，这次不会发送` : title(x.node)} draggable={false}
          onPointerDown={(e) => onChipDown(e, x.edge.id)} onPointerEnter={() => store.setUI({ hlEdge: x.edge.id, hlNode: x.node.id })} onPointerLeave={() => store.setUI({ hlEdge: null, hlNode: null })}>
          {src ? <ChipImg src={src} /> : <Icon name={x.node.kind === "table" ? "grid" : TYPE_ICON[x.node.kind as GenKind] || "layers"} size="s" />}
          <span className="ord">{x.order + 1}</span>
          <span className="x" data-rm={x.edge.id} onPointerDown={(e) => { e.stopPropagation(); store.removeEdge(x.edge.id); afterInputsChanged(store, node.id); store.toast(`已移除输入「${title(x.node)}」`); }}><Icon name="x" size="xs" /></span>
        </button>); })}
      <button className="sq tipT" data-p="addin" data-tip="添加输入" onClick={(e) => openPop(e.currentTarget, (close) => <>
        <button className="mi" onClick={() => { close(); store.setUI({ pick: node.id }); store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" />从画布选择</button>
        <button className="mi" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: { x: node.x - 360, y: node.y + 120 }, linkTo: node.id } })); }}><Icon name="upload" size="s" />上传图片</button>
        <button className="mi" onClick={() => { close(); store.setUI({ drawer: "assets" }); window.dispatchEvent(new CustomEvent("cn:lib-link", { detail: node.id })); }}><Icon name="folder" size="s" />从素材库选择</button>
      </>)}><Icon name="plus" size="s" /></button>
      <span className="grow" />
      <button className={"linkbtn" + (preview ? " on" : "")} data-p="preview" onClick={() => store.setUI({ preview: !preview })}><Icon name="text" size="xs" />请求预览</button>
    </div>
    <PromptEditor node={node} placeholder={ph} value={draft} onChange={onPrompt} onCommit={commitPrompt} onSend={send} onEscape={() => store.setUI({ sel: new Set(), pick: null })} onSlash={kind === "image" ? () => slashMenu(document.getElementById("gpPrompt") as HTMLElement) : undefined} />
    {tables.length ? <BatchPanel node={node} /> : null}
    {unm.size ? <UnrefWarn node={node} ids={[...unm]} onAdd={() => commitPrompt(draft)} /> : null}
    {warns.map((w) => <div key={w} className="gp-warn"><Icon name="alert" size="s" /><span>{w}</span></div>)}
    {preview ? <div className="gp-prev"><pre>{JSON.stringify(previewOf(ctl, node), null, 2)}</pre></div> : null}
    <div className="gp-foot">
      {kind === "image" || kind === "text" ? <div className="gp-line" data-gline>{gline}</div> : null}
      {foot.length ? <div className={"gp-opts" + (fit ? " fit" : "")} ref={optsRef}>{foot}</div> : null}
      {/* 动作区三个独立元素（不再用一个药丸包住耗时+发送）：同一中线、间距 8、发送不压药丸 */}
      <div className="gp-act">
        <OptimizeButton node={node} draft={draft} setDraft={setDraft} className="mic opt" />
        <button className="mic" data-p="mic" title="语音输入" onClick={(e) => voice(ctl, node, e.currentTarget, (v) => { setDraft(v); commitPrompt(v); })}><Icon name="mic" size="s" /></button>
        {/* 没配模型时 est 为空：不渲染空药丸（否则看起来像没渲染完），也不占位 */}
        {est ? <span className="est tnum" title="预计耗时">{est}{m?.local ? " · 本机" : ""}</span> : null}
        {run ? <button className="send busy" data-p="stop" title="停止生成" onClick={() => stopNode(store, node.id)}><i className="ring"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></svg></i><span className="sqr" /></button>
          : <button className="send" data-p="send" title="生成 ⌘↵" onClick={send}><Icon name="send" size="s" /></button>}
      </div>
    </div>
    {kind === "image" && camOpen ? <CamLayer node={node} anchor={camRef.current} onClose={() => setCamOpen(false)} /> : null}
    {kind === "image" && styleOpen ? <StyleLayer node={node} onClose={() => setStyleOpen(false)} /> : null}
  </>;
}

/** 视频结果动作的「更多」：首帧/尾帧截帧、设为视频封面、应用到画布、下载、全屏（对齐 TapNow） */
function videoMore(store: CanvasStore, node: CanvasNode, anchor: Element) {
  openPop(anchor, (close) => {
    const fire = (kind: string) => () => { close(); window.dispatchEvent(new CustomEvent("cn:editor", { detail: { kind, id: node.id } })); };
    return <>
      <div className="mh">截帧</div>
      <button className="mi" data-tbk="firstframe" onClick={fire("firstframe")}><Icon name="frame" size="s" /><span style={{ flex: 1 }}>首帧</span><span className="k">2</span></button>
      <button className="mi" data-tbk="lastframe" onClick={fire("lastframe")}><Icon name="frame" size="s" /><span style={{ flex: 1 }}>尾帧</span><span className="k">3</span></button>
      <div className="msep" />
      <button className="mi" data-tbk="setcover" onClick={fire("setcover")}><Icon name="star" size="s" />设为视频封面</button>
      <button className="mi" data-tbk="applycanvas" onClick={fire("applycanvas")}><Icon name="libadd" size="s" />应用到画布</button>
      <div className="msep" />
      <div className="mh">编辑当前帧</div>
      <button className="mi" data-tbk="cropframe" onClick={fire("cropframe")}><Icon name="crop" size="s" />裁剪画面<span className="k">先截帧</span></button>
      <button className="mi" data-tbk="eraseframe" onClick={fire("eraseframe")}><Icon name="eraser" size="s" />擦除画面<span className="k">先截帧</span></button>
      <div className="msep" />
      <button className="mi" data-tbk="dl" onClick={() => { close(); void download(node, store); }}><Icon name="download" size="s" />下载</button>
      <button className="mi" data-tbk="full" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id })); }}><Icon name="expand" size="s" />全屏</button>
      <div className="mh">暂未接入</div>
      <button className="mi" data-tbk="hd" disabled title="需要逐帧超分，当前没有接入"><Icon name="sparkle" size="s" /><span style={{ flex: 1 }}>高清</span><span className="k">要逐帧超分</span></button>
      <button className="mi" data-tbk="motion" disabled title="需要模型支持运动控制参数"><Icon name="branch" size="s" /><span style={{ flex: 1 }}>运动控制</span><span className="k">模型未提供</span></button>
      <button className="mi" data-tbk="fps" disabled title="需要重新转码改写帧率"><Icon name="monitor" size="s" /><span style={{ flex: 1 }}>帧率</span><span className="k">要重新转码</span></button>
    </>;
  }, "up");
}


/** 引用模式下：已连接但没被 @ 的上游不会发送，给一行提示和「全部引用」 */
function UnrefWarn({ node, ids, onAdd }: { node: CanvasNode; ids: string[]; onAdd: () => void }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc);
  const names = ids.map((e) => doc.edges.find((x) => x.id === e)).map((e) => e && store.node(e.from)).filter((n): n is CanvasNode => !!n);
  if (!names.length) return null;
  return <div className="gp-warn unref" data-warn="unref"><Icon name="link" size="s" /><span>{names.slice(0, 2).map((n) => `「${title(n)}」`).join("")}{names.length > 2 ? ` 等 ${names.length} 个` : ""}已连接但没有 @ 引用，这次不会发送</span>
    <button className="linkbtn" data-act="ref-all" onClick={() => { onAdd(); names.forEach((n) => addMention(store, node.id, n.id)); ctl.focusPrompt(); }}>全部引用</button></div>;
}

function ChipImg({ src }: { src: string }) { const u = useAssetUrl(src); return u ? <img src={u} alt="" draggable={false} /> : <Icon name="image" size="s" />; }

/** 请求预览：生成节点给出发给后端的请求；连着表格时给出第一行的请求和总行数 */
function previewOf(ctl: ReturnType<typeof useCtl>, node: CanvasNode) {
  const store = ctl.store; const rows = batchRows(store.state.doc, node.id, fillTargetOf(store.state.doc, node.id, batchOf(node).settings));
  const req = buildRequest(store, node, rows[0]); if (!req) return { error: "没有可用模型" };
  const { model, ...rest } = req;
  return { ...rest, model: { configId: model.id, name: model.name }, ...(rows.length ? { batch: { rows: rowsToRun(rows, batchOf(node).settings).length, previewRow: rows[0]?.row } } : {}) };
}

/* ---------------- 批量（上游连着多维表格） ---------------- */
function BatchPanel({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc);
  const { settings: s, journal } = batchOf(node); const fill = fillTargetOf(doc, node.id, s);
  const rows = batchRows(doc, node.id, fill); const todo = new Set(rowsToRun(rows, s).map((r) => r.row));
  const m = store.modelOf(node); const g = genOf(node);
  const cands = node.kind === "image" ? fillCandidates(doc, node.id) : [];
  const fillName = fill ? `${tableOf(store.node(fill.table)!).columns[fill.col]}` : "";
  const setS = (patch: Partial<BatchSettings>) => store.updateNode(node.id, (n) => withBatch(n, { settings: patch }));
  const stOf = (row: number) => journal?.rows.find((r) => r.row === row);
  const first = rows.filter((r) => todo.has(r.row)).slice(0, s.concurrency).map((r) => r.row);
  return <div className="gp-batch">
    <div className="bh"><Icon name="grid" size="s" /><b>生成输入</b><span className="tnum">{s.manual ? `独立运行 · 已选 ${s.selected.filter((x) => rows.some((r) => r.row === x)).length}/${rows.length}` : `批量 ${todo.size} 行 · 首批 ${Math.min(s.concurrency, todo.size)}`}</span><span className="sp" />{journal ? <button className="linkbtn" onClick={() => store.updateNode(node.id, (n) => withBatch(n, { journal: null }))} title="清除上次运行记录，下次从头生成">重置记录</button> : null}</div>
    <div className="blist">
      {rows.map((r) => { const j = stOf(r.row); const sel = s.manual ? s.selected.includes(r.row) : first.includes(r.row); return (
        <button key={r.row} className={"brow" + (sel ? " sel" : "") + (todo.has(r.row) ? "" : " skip") + (s.manual ? "" : " dim")} onClick={() => { if (!s.manual) return; setS({ selected: s.selected.includes(r.row) ? s.selected.filter((x) => x !== r.row) : [...s.selected, r.row].sort((a, b) => a - b) }); }}>
          <span className="n tnum">{r.row}</span>
          <span className="md">{r.media.slice(0, 3).map((md) => <RowThumb key={md.nodeId} src={md.src} kind={md.kind} />)}</span>
          <p>{(() => { const pl = planRow(node.kind as GenKind, g.params, m, r); const pp = pl.params as { mode?: string; dur?: number; ratio?: string }; const tags = [r.label, node.kind === "video" && pp.mode !== (g.params as { mode?: string }).mode ? pp.mode : null, r.dur != null && node.kind === "video" ? pp.dur + "s" : null, r.ratio ? pp.ratio : null].filter(Boolean); return <>{tags.length ? <b className="btag">{tags.join(" · ")}</b> : null}{r.text || (r.media.length ? "仅媒体输入" : "")}{pl.warnings.length ? <i className="bwarn" title={pl.warnings.join("\n")}> · {pl.warnings[0]}</i> : null}</>; })()}</p>
          <span className={"st" + (j?.status === "completed" ? " ok" : j?.status === "failed" ? " bad" : "")}>{j ? { completed: "已完成", failed: "失败", running: "生成中", pending: "待生成" }[j.status] : ""}</span>
        </button>); })}
      {!rows.length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>上游表格还没有行</span></div> : null}
    </div>
    <div className="bctl">
      <label title="同时生成几行（1–8）">并发数<input type="number" min={1} max={8} value={s.concurrency} onChange={(e) => setS({ concurrency: clamp(+e.target.value || 1, 1, 8) })} onKeyDown={(e) => e.stopPropagation()} /></label>
      {!s.manual ? <label title="从第几行开始">起始行<input type="number" min={1} max={Math.max(1, rows.length)} value={s.startRow} onChange={(e) => setS({ startRow: clamp(+e.target.value || 1, 1, Math.max(1, rows.length)) })} onKeyDown={(e) => e.stopPropagation()} /><span style={{ color: "var(--fg3)" }}>/ {rows.length}</span></label> : null}
      <button className={"tg" + (s.manual ? " on" : "")} onClick={() => setS({ manual: !s.manual })}>独立运行</button>
      <button className="tg" title="某一行失败后的处理" onClick={() => setS({ failure: s.failure === "stop" ? "continue" : "stop" })}>{s.failure === "stop" ? "遇错停止" : "遇错继续"}</button>
      {node.kind === "video" ? <button className={"tg" + (s.chain ? " on" : "")} data-act="chain" title="镜头串联：上一行视频的最后一帧作为下一行的首帧（这一行自己有首帧时不替换），按顺序逐行生成" onClick={() => setS({ chain: !s.chain })}>镜头串联</button> : null}
      {node.kind === "image" && cands.length ? <button className={"tg" + (fill ? " on" : "")} data-act="fill" title="出图后把每行的结果填回表格的图片列，下游视频节点就能按行读到首帧" onClick={(e) => openPop(e.currentTarget, (close) => <>
        <div className="mh">结果填回表格</div>
        <button className={"mi" + (s.fill === undefined ? " on" : "")} onClick={() => { close(); setS({ fill: undefined }); }}><span>自动<span className="d">有空着的「首帧」列就填回去</span></span></button>
        {cands.map((c) => <button key={c.table + c.col} className={"mi" + (s.fill && s.fill.table === c.table && s.fill.col === c.col ? " on" : "")} onClick={() => { close(); setS({ fill: { table: c.table, col: c.col } }); }}><span>填回「{c.name}」列</span></button>)}
        <button className={"mi" + (s.fill === null ? " on" : "")} onClick={() => { close(); setS({ fill: null }); }}><span>不回填<span className="d">表格里的图都当参考图</span></span></button>
      </>, "up")}>{fill ? `填回「${fillName}」` : "不回填"}</button> : null}
    </div>
  </div>;
}
function RowThumb({ src, kind }: { src: string; kind: string }) { const u = useAssetUrl(src); return u ? <img src={u} alt="" /> : <i><Icon name={kind === "video" ? "video" : kind === "audio" ? "audio" : "image"} size="xs" /></i>; }

/* ---------------- 参数弹层 ---------------- */
function paramPop(ctl: ReturnType<typeof useCtl>, node: CanvasNode, k: string, anchor: Element) {
  const store = ctl.store; const kind = node.kind as GenKind;
  const cur = () => { const n = store.node(node.id)!; return { g: genOf(n), m: store.modelOf(n) as ModelSpec | undefined }; };
  const set = (patch: Record<string, unknown>) => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, ...patch } as typeof gg.params }));
  if (k === "model") {
    const list = store.modelsOf(kind);
    const vendorOf = (x: ModelSpec) => x.vendor.trim() || "未命名供应商";
    const vendors = [...new Set(list.map(vendorOf))];
    const showModels = (vendor: string) => openPop(anchor, (close) => <>
      <button className="mi" data-model-back aria-label="返回供应商列表" onClick={showProviders}><Icon name="left" size="s" /><span style={{ flex: 1 }}>{vendor}<span className="d">返回供应商列表</span></span></button>
      <div className="msep" />
      {list.filter((x) => vendorOf(x) === vendor).map((x) => <button key={x.id} className={"mi" + (x.id === cur().m?.id ? " on" : "")} data-v={x.id} onClick={() => { close(); store.rememberModel(kind, x.id); store.patchGen(node.id, (gg) => ({ params: clampParams(kind, gg.params, x) })); if (kind === "video") afterInputsChanged(store, node.id); }}>
        <span style={{ flex: 1 }}><span style={{ display: "flex", gap: 6, alignItems: "center" }}>{x.name}{x.tags.map((t) => <span key={t} className={"tag" + (t === "NEW" ? " new" : "")}>{t}</span>)}{x.specSource === "guess" ? <span className="tag" data-spec-source="guess" title="服务商没有提供该模型的参数规格，下面的比例 / 档位 / 选项是按模型名推断的，以实际生成为准">未验证</span> : null}</span>
          {kind === "video" ? <span className="mtags">{x.res?.length && !x.tags.some((t) => t.toLowerCase() === x.res![x.res!.length - 1].toLowerCase()) ? <span className="tag">{x.res[x.res.length - 1]}</span> : null}{x.durs?.length ? <span className="tag tnum">{Math.min(...x.durs) === Math.max(...x.durs) ? x.durs[0] + "S" : Math.min(...x.durs) + "-" + Math.max(...x.durs) + "S"}</span> : null}{x.audio ? <span className="tag"><Icon name="audio" size="xs" /></span> : null}<span className="tag">{(x.modes || []).length} 种方式</span></span> : null}
          <span className="d">{x.vendor}{kind === "image" ? ` · ${x.i2i ? "最多 " + x.maxRefs + " 张参考图" : "仅文生图"}` : kind === "video" ? "" : kind === "text" ? (x.vision ? " · 能读图" : " · 只读文字") : ""}{x.specSource === "guess" ? " · 参数按名字推断" : ""}</span></span>
      </button>)}
    </>, "up");
    const showProviders = () => openPop(anchor, (close) => <>
      <div className="mh">{TYPE_LABEL[kind]}模型 · 选择供应商</div>
      {vendors.map((vendor) => {
        const count = list.filter((x) => vendorOf(x) === vendor).length;
        return <button key={vendor} className="mi" data-vendor={vendor} onClick={() => showModels(vendor)}><span style={{ flex: 1 }}>{vendor}<span className="d">{count} 个模型</span></span><Icon name="right" size="s" /></button>;
      })}
      {!list.length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>还没有配置{TYPE_LABEL[kind]}模型</span></div> : null}
      {ctl.host.openModelSettings ? <><div className="msep" /><button className="mi" onClick={() => { close(); ctl.host.openModelSettings!(); }}><Icon name="settings" size="s" />模型设置</button></> : null}
    </>, "up");
    return showProviders();
  }
  const { m } = cur();
  // 没配置模型：仍把同一套控件渲染出来（灰显），顶部保留引导 + 「打开模型设置」；有模型时行为不变。
  const dis = !m;
  const mm = m || placeholderSpec(kind);
  const pop = (render: (close: () => void) => React.ReactNode) => openPop(anchor, (close) => <>
    {dis ? <>
      <div className="mh">{TYPE_LABEL[kind]}参数</div>
      <div className="gp-nomodel" data-nomodel><Icon name="alert" size="s" /><span>还没有可用的{TYPE_LABEL[kind]}模型：下面是可调档位（灰显），添加模型后即可修改。</span></div>
      {ctl.host.openModelSettings ? <button className="mi" data-k="open-models" onClick={() => { close(); ctl.host.openModelSettings?.(); }}><Icon name="settings" size="s" />打开模型设置</button> : null}
      <div className="msep" />
    </> : null}
    {render(close)}
  </>, "up");
  if (k === "ratio") return pop(() => <RatioPop node={node} model={mm} disabled={dis} />);
  if (k === "mj") return pop(() => <MjPop node={node} model={mm} disabled={dis} />);
  if (k === "count") return pop((close) => <><div className="mh">一次生成几张</div>{[4, 2, 1].map((c) => <button key={c} className={"mi" + ((cur().g.params as ImageParams).count === c ? " on" : "")} disabled={dis || !mm.batch?.includes(c)} onClick={() => { close(); set({ count: c }); }}>{c}×<span className="k">{!dis && mm.batch?.includes(c) ? (c > 1 ? (store.state.ui.batchMode === "stack" ? "堆叠在本节点" : "铺开成新节点") : "") : "该模型不支持"}</span></button>)}</>);
  if (k === "vtimes") return pop((close) => <><div className="mh">一次生成几条</div>{[4, 2, 1].map((c) => <button key={c} className={"mi" + (((cur().g.params as VideoParams).times || 1) === c ? " on" : "")} disabled={dis || !(mm.times || [1]).includes(c)} onClick={() => { close(); set({ times: c }); }}>{c}×<span className="k">{!dis && (mm.times || [1]).includes(c) ? (c > 1 ? "每条单独计费" : "") : "该模型不支持"}</span></button>)}</>);
  if (k === "mode") return pop((close) => <><div className="mh">生成方式 · 会按输入自动选择</div>{(Object.keys(VMODES) as Array<keyof typeof VMODES>).map((x) => { const ok = (mm.modes || []).includes(x); return <button key={x} className={"mi" + ((cur().g.params as VideoParams).mode === x ? " on" : "")} disabled={!ok || dis} onClick={() => { close(); set({ mode: x }); }}><span style={{ flex: 1 }}>{x}<span className="d">{ok ? (x === "参考生视频" ? "最多 " + mm.maxRefs + " 张参考图" : VMODES[x].need) : mm.name + " 不支持"}</span></span><span className="k tnum">{VMODES[x].api}</span></button>; })}</>);
  if (k === "vratio") return pop(() => <VRatioPop node={node} m={mm} disabled={dis} />);
  if (k === "vset") return pop(() => <VideoSetPop node={node} m={mm} disabled={dis} />);
  if (k === "vres") { const rr = resRange(mm); const vp0 = cur().g.params as VideoParams; return pop((close) => <><div className="mh">清晰度</div><div className="seg wrap">{(mm.res || []).map((r) => <button key={r} className={vp0.res === r && !vp0.draft ? "on" : ""} disabled={dis} onClick={() => { close(); set({ res: r, draft: false }); }}>{r}</button>)}</div>
    <div className="msep" />
    <button className={"mi" + (vp0.draft ? " on" : "")} data-p="vdraft" disabled={dis || !rr} onClick={() => { close(); set({ draft: !vp0.draft }); }}><Icon name="bolt" size="s" /><span style={{ flex: 1 }}>草稿模式<span className="d">{rr ? `先按 ${rr.low} 出草稿，满意后一键按 ${rr.high} 出成片` : "该模型只有一档清晰度"}</span></span>{vp0.draft ? <span className="k"><Icon name="check" size="s" /></span> : null}</button></>); }
  if (k === "dur") return pop(() => <DurPop node={node} m={mm} disabled={dis} />);
  if (k === "vgenmode") return pop((close) => <><div className="mh">生成模式</div><div className="seg wrap">{(mm.genModes || []).map((x) => <button key={x} className={(cur().g.params as VideoParams).genMode === x ? "on" : ""} disabled={dis} onClick={() => { close(); set({ genMode: x }); }}>{x}</button>)}</div></>);
  if (k === "vturbo") return pop((close) => <><div className="mh">加速（极速模式）</div><div className="seg"><button className={(cur().g.params as VideoParams).turbo ? "on" : ""} disabled={dis} onClick={() => { close(); set({ turbo: true }); }}>开</button><button className={!(cur().g.params as VideoParams).turbo ? "on" : ""} disabled={dis} onClick={() => { close(); set({ turbo: false }); }}>关</button></div><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>极速模式会优先出片，画质与稳定性可能下降</span></div></>);
  if (k === "vaudio") return pop((close) => <><div className="mh">音频</div><div className="seg"><button className={(cur().g.params as VideoParams).sound ? "on" : ""} disabled={dis} onClick={() => { close(); set({ sound: true }); }}>开</button><button className={!(cur().g.params as VideoParams).sound ? "on" : ""} disabled={dis} onClick={() => { close(); set({ sound: false }); }}>关</button></div><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>为生成的视频添加音频内容</span></div></>);
  if (k === "akind") return pop((close) => <><div className="mh">类型</div>{(mm.kinds || []).map((x) => <button key={x} className={"mi" + ((cur().g.params as AudioParams).kind === x ? " on" : "")} disabled={dis} onClick={() => { close(); set({ kind: x }); }}>{x}</button>)}</>);
  if (k === "adur") return pop((close) => <><div className="mh">时长</div>{(mm.adurs || []).map((x) => <button key={x} className={"mi" + ((cur().g.params as AudioParams).dur === x ? " on" : "")} disabled={dis} onClick={() => { close(); set({ dur: x }); }}>{x}</button>)}</>);
  if (k === "output") return pop((close) => <><div className="mh">输出</div>{OUTPUT_MODES.map(([v, l, d]) => <button key={v} className={"mi" + (((cur().g.params as TextParams).output || "text") === v ? " on" : "")} disabled={dis} onClick={() => { close(); set({ output: v }); }}><span className="ic"><Icon name={v === "text" ? "text" : "grid"} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}<div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>表格会建在右侧并自动连线，再跑一次会更新同一张表</span></div></>);
}

function useNodeParams<T>(node: CanvasNode) { const n = useS((s) => s.doc.nodes.find((x) => x.id === node.id)) || node; return genOf(n).params as T; }
function RatioPop({ node, model, disabled = false }: { node: CanvasNode; model?: ModelSpec; disabled?: boolean }) {
  const ctl = useCtl(); const store = ctl.store; const p = useNodeParams<ImageParams>(node); const m = model || store.modelOf(node)!;
  const set = (patch: Partial<ImageParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as ImageParams), ...patch } }));
  const shape = (r: string) => { const [w, h] = ratioWH(r, 20); return <i style={{ width: w, height: h }} />; };
  return <>
    <div className="mh">画质</div><div className="seg">{(m.sizes || []).map((s) => <button key={s} className={p.size === s ? "on" : ""} disabled={disabled} onClick={() => set({ size: s })}>{s}</button>)}</div>
    <div className="mh">比例</div><div className="ratio-grid">{(m.ratios || []).map((r) => <button key={r} className={p.ratio === r ? "on" : ""} disabled={disabled} onClick={() => set({ ratio: r })}>{shape(r)}{r}</button>)}</div>
    {m.search ? <><div className="mh">联网搜索</div><div className="seg"><button className={p.search ? "on" : ""} disabled={disabled} onClick={() => set({ search: true })}>开</button><button className={!p.search ? "on" : ""} disabled={disabled} onClick={() => set({ search: false })}>关</button></div></> : <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>{m.name} 不支持联网搜索</span></div>}
  </>;
}
/** Midjourney 参数：版本 / 速度 / HD / 风格化（只列服务商规格声明的取值） */
const MJ_STYLIZE = [100, 250, 500, 750, 1000];
function MjPop({ node, model, disabled = false }: { node: CanvasNode; model?: ModelSpec; disabled?: boolean }) {
  const store = useCtl().store; const p = useNodeParams<ImageParams>(node); const m = model || store.modelOf(node)!;
  const spec = m.mj; const cur: MjParams = p.mj || {};
  const set = (patch: Partial<MjParams>) => store.patchGen(node.id, (g) => {
    const prev = (g.params as ImageParams).mj || {}; const next: MjParams = { ...prev, ...patch };
    if (next.hd && !mjHdAllowed(spec, next.version)) next.hd = false; // 换到不支持 HD 的版本就自动关掉
    return { params: { ...(g.params as ImageParams), mj: next } };
  });
  if (!spec) return null;
  const hdOk = mjHdAllowed(spec, cur.version);
  return <div className="mjpop" data-mjpop>
    <div className="mh">版本</div><div className="seg wrap">
      <button className={!cur.version ? "on" : ""} disabled={disabled} onClick={() => set({ version: undefined })}>默认</button>
      {spec.versions.map((v) => <button key={v} data-mjv={v} className={cur.version === v ? "on" : ""} disabled={disabled} onClick={() => set({ version: v })}>{/^niji/i.test(v) ? v.replace(/^niji\s*/i, "Niji ") : "v" + v}</button>)}
    </div>
    <div className="mh">速度</div><div className="seg">{spec.speeds.map((v) => <button key={v} data-mjs={v} className={(cur.speed || "fast") === v ? "on" : ""} disabled={disabled} onClick={() => set({ speed: v })}>{MJ_SPEED_LABEL[v] || v}</button>)}</div>
    <div className="mh">高清 HD</div><div className="seg">
      <button data-mjhd="on" className={cur.hd ? "on" : ""} disabled={disabled || !hdOk} onClick={() => set({ hd: true })}>开</button>
      <button className={!cur.hd ? "on" : ""} disabled={disabled} onClick={() => set({ hd: false })}>关</button>
      {!hdOk ? <span style={{ alignSelf: "center", marginLeft: 6, color: "var(--fg3)", fontSize: 12 }}>只支持 {spec.hd.map((v) => "v" + v).join(" / ")}</span> : null}
    </div>
    <div className="mh">风格化</div><div className="seg wrap">
      <button className={typeof cur.stylize !== "number" ? "on" : ""} disabled={disabled} onClick={() => set({ stylize: undefined })}>默认</button>
      {MJ_STYLIZE.map((v) => <button key={v} className={cur.stylize === v ? "on" : ""} disabled={disabled} onClick={() => set({ stylize: v })}>{v}</button>)}
    </div>
  </div>;
}
function SegPop({ node, groups }: { node: CanvasNode; groups: Array<[string, "ratio" | "res", string[]]> }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  return <>{groups.map(([label, key, list]) => <div key={key}><div className="mh">{label}</div><div className="seg">{list.map((v) => <button key={v} className={p[key] === v ? "on" : ""} onClick={() => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), [key]: v } }))}>{v}</button>)}</div></div>)}</>;
}
/**
 * 视频参数合并浮层（TapNow 同款分组）：只列当前模型真正支持的取值 —— 换模型后这里的选项跟着变，
 * 不支持的项不出现（比如只有 8 秒的模型就只剩 8s，不能出声的模型没有「生成音频」）。
 */
function VideoSetPop({ node, m, disabled = false }: { node: CanvasNode; m: ModelSpec; disabled?: boolean }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  const set = (patch: Partial<VideoParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), ...patch } }));
  const shape = (r: string) => { const [w, h] = ratioWH(r, 16); return <i style={{ width: w, height: h }} />; };
  const modes = ((m.modes || []) as VideoMode[]).filter((x) => x in VMODES);
  const durs = m.durs || []; const rr = resRange(m);
  return <div className="vset" data-vset={m.id}>
    <div className="vset-model"><span className="n">{m.name}</span>{m.specSource === "guess" ? <span className="d">参数按名字推断</span> : <span className="d">这个模型支持的参数</span>}</div>
    {modes.length ? <><div className="mh">生成方式</div><div className="seg wrap">{modes.map((x) => <button key={x} data-vopt={"mode:" + x} className={p.mode === x ? "on" : ""} disabled={disabled} title={VMODES[x].need} onClick={() => set({ mode: x })}>{x}</button>)}</div></> : null}
    {(m.ratios || []).length ? <><div className="mh">比例</div><div className="ratio-grid">{(m.ratios || []).map((r) => <button key={r} data-vopt={"ratio:" + r} className={p.ratio === r ? "on" : ""} disabled={disabled} onClick={() => set({ ratio: r })}>{shape(r)}{r}</button>)}</div></> : null}
    {(m.res || []).length ? <><div className="mh">清晰度</div><div className="seg wrap">{(m.res || []).map((r) => <button key={r} data-vopt={"res:" + r} className={p.res === r && !p.draft ? "on" : ""} disabled={disabled} onClick={() => set({ res: r, draft: false })}>{r}</button>)}{rr ? <button data-vopt="draft" className={p.draft ? "on" : ""} disabled={disabled} title={`先按 ${rr.low} 出草稿，满意后一键按 ${rr.high} 出成片`} onClick={() => set({ draft: !p.draft })}>草稿</button> : null}</div></> : null}
    <div className="mh">生成时长</div>
    {durs.length ? <div className="seg wrap">{durs.filter((d) => d > 0).map((d) => <button key={d} data-vopt={"dur:" + d} className={p.dur === d ? "on" : ""} disabled={disabled} onClick={() => set({ dur: d })}>{d}s</button>)}{durs.includes(-1) ? <button data-vopt="dur:auto" className={!p.dur || p.dur <= 0 ? "on" : ""} disabled={disabled} onClick={() => set({ dur: -1 })}>自动</button> : null}</div> : <div className="lg-dim" style={{ padding: "2px 0 6px" }}>由模型自动决定</div>}
    {m.audio ? <><div className="mh">生成音频</div><div className="seg"><button data-vopt="sound:on" className={p.sound ? "on" : ""} disabled={disabled} onClick={() => set({ sound: true })}>开启</button><button data-vopt="sound:off" className={!p.sound ? "on" : ""} disabled={disabled} onClick={() => set({ sound: false })}>关闭</button></div></> : null}
  </div>;
}
function DurPop({ node, m, disabled = false }: { node: CanvasNode; m: ModelSpec; disabled?: boolean }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  const set = (patch: Partial<VideoParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), ...patch } }));
  return <>
    <div className="mh">生成时长</div>
    <div className="seg wrap">
      {(m.durs || []).map((d) => <button key={d} className={p.dur === d ? "on" : ""} disabled={disabled} onClick={() => set({ dur: d })}>{d}s</button>)}
      {(m.durs || []).includes(-1) || !(m.durs || []).length ? <button className={!p.dur || p.dur <= 0 ? "on" : ""} disabled={disabled} onClick={() => set({ dur: -1 })}>自动</button> : null}
    </div>
    <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>「自动」由模型决定时长</span></div>
  </>;
}

/** 视频比例（带形状预览，与图片比例弹层一致） */
function VRatioPop({ node, m, disabled = false }: { node: CanvasNode; m: ModelSpec; disabled?: boolean }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  const set = (ratio: string) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), ratio } }));
  const shape = (r: string) => { const [w, h] = ratioWH(r, 16); return <i style={{ width: w, height: h }} />; };
  return <><div className="mh">比例</div><div className="ratio-grid">{(m.ratios || []).map((r) => <button key={r} className={p.ratio === r ? "on" : ""} disabled={disabled} onClick={() => set(r)}>{shape(r)}{r}</button>)}</div></>;
}

/* ---------------- 语音输入 ---------------- */
function voice(ctl: ReturnType<typeof useCtl>, node: CanvasNode, btn: HTMLElement, onText: (v: string) => void) {
  const SR = (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
  if (!SR) { ctl.store.toast("当前环境没有语音识别服务，可以用系统听写（按两下 Fn）输入"); return; }
  const r = new SR(); r.lang = "zh-CN"; r.interimResults = false; btn.classList.add("rec"); ctl.store.toast("正在听…说完会自动填进提示词", 2000);
  r.onresult = (e: any) => { const t = String(e.results?.[0]?.[0]?.transcript || ""); const cur = genOf(ctl.store.node(node.id)!).prompt; onText((cur ? cur + "，" : "") + t); };
  r.onerror = () => ctl.store.toast("没有听清，可以再试一次"); r.onend = () => btn.classList.remove("rec"); r.start();
  void closePop;
}

/* ---------------- 风格 / 摄影机（对齐 TapNow：4 轮盘浮层 + 风格资产模态） ---------------- */
type CamKey = "body" | "lens" | "focal" | "aperture";

/** 轮盘封面映射（集中一处，换图只改这里）：名称 → public/camera-tiles/<file>.webp；没有映射或加载失败回退下面 CamGlyph 的线条图形 */
const CAM_TILES: { body: Record<string, string>; lens: Record<string, string>; aperture: Record<string, string> } = {
  body: {
    "Sony Venice": "body-sony-venice",
    "Arri Alexa 35": "body-arri-alexa-35",
    "Arri Alexa 65": "body-arri-alexa-65",
    "Red V-Raptor": "body-red-v-raptor",
    "Panavision DXL2": "body-panavision-dxl2",
    "Arricam LT": "body-arricam-lt",
    "ArriFlex 435": "body-arriflex-435",
    "IMAX Keighley": "body-imax-keighley",
    "IMAX Film Camera": "body-imax-film-camera",
  },
  lens: {
    "Zeiss Ultra Prime": "lens-zeiss-ultra-prime",
    "Arri Signature Prime": "lens-arri-signature-prime",
    "Canon K-35": "lens-canon-k-35",
    "Cooke S4": "lens-cooke-s4",
    "Cooke Panchro": "lens-cooke-panchro",
    "Cooke SF 1.8x": "lens-cooke-sf-1-8x",
    "Helios": "lens-helios",
    "Panavision C-series": "lens-panavision-c-series",
    "Panavision Primo": "lens-panavision-primo",
    "Hawk Class X": "lens-hawk-class-x",
  },
  aperture: { "ƒ/1.4": "aperture-f1_4", "ƒ/4": "aperture-f4", "ƒ/11": "aperture-f11" },
};

/** 轮盘小图：成品小图优先；没有映射或图片加载失败时回退单色线条（回退路径保留） */
function CamArt({ kind, name }: { kind: "body" | "lens" | "aperture"; name: string }) {
  const file = CAM_TILES[kind][name] || "";
  const [bad, setBad] = useState(false);
  if (!file || bad) return <CamGlyph kind={kind} />;
  return <img className="gl" src={"./camera-tiles/" + file + ".webp"} alt="" draggable={false} onError={() => setBad(true)} />;
}

/** 单色图形（currentColor 描边）：机身 / 镜头 / 光圈叶片。图片缺失时作为回退，不用 emoji、不做彩色渐变。 */
function CamGlyph({ kind }: { kind: "body" | "lens" | "aperture" | "chip" }) {
  if (kind === "chip") return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="2.5" y="7" width="12" height="10" rx="2" /><circle cx="18" cy="12" r="3.2" /><path d="M6.5 7V4.8h4V7" /></svg>;
  if (kind === "lens") return <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true"><circle cx="32" cy="32" r="21" /><circle cx="32" cy="32" r="13" /><circle cx="32" cy="32" r="5.5" /><path d="M11 27H8v10h3M53 27h3v10h-3" /></svg>;
  if (kind === "aperture") return <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true"><circle cx="32" cy="32" r="22" /><path d="M32 10l8.5 15.5M54 32l-17 8.5M46 52l-8.5-17M10 32l17-8.5M18 52l8.5-17M46 12l-8.5 17" /><circle cx="32" cy="32" r="4" /></svg>;
  return <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true"><rect x="5" y="20" width="30" height="22" rx="3" /><circle cx="46" cy="31" r="11" /><circle cx="46" cy="31" r="6" /><path d="M12 20v-5h8v5M5 13h6M38 20l7-5" /></svg>;
}
function StyleGlyph() {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5 9.4 11.1 5 9.5l4.4-1.6z" /><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></svg>;
}

/** 摄影机控制浮层：602×272、4 列轮盘、标题 + 保存（保存只关闭）；enter/exit 150ms linear */
function CamLayer({ node, anchor, onClose }: { node: CanvasNode; anchor: HTMLElement | null; onClose: () => void }) {
  const store = useCtl().store;
  const cardRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const done = useRef(false);
  const close = () => { if (done.current) return; done.current = true; setClosing(true); window.setTimeout(onClose, 150); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); close(); };
    const onDown = (e: PointerEvent) => { const t = e.target as Node | null; if (!t || cardRef.current?.contains(t)) return; if (anchor && anchor.contains(t)) return; close(); };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  });
  const live = store.node(node.id) || node;
  const cam = (genOf(live).params as ImageParams).camera;
  const W = 602, H = 272;
  const r = anchor ? anchor.getBoundingClientRect() : null;
  const left = r ? Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) : 8;
  const top = r ? Math.max(8, r.top - H - 8) : 8;
  const set = (patch: Partial<CameraParams>) => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, camera: { ...(gg.params as ImageParams).camera, ...patch } } }));
  const idx = (k: CamKey) => Math.max(0, Math.min(CAMERAS[k].length - 1, cam[k]));
  const cols: Array<{ key: CamKey; items: ReadonlyArray<string | number> }> = [
    { key: "body", items: CAMERAS.body }, { key: "lens", items: CAMERAS.lens }, { key: "focal", items: CAMERAS.focal }, { key: "aperture", items: CAMERAS.aperture },
  ];
  const label = (k: CamKey) => (k === "focal" ? CAMERAS.focal[idx(k)] + "mm" : String(CAMERAS[k][idx(k)]));
  const host = document.querySelector(".cn-root");
  if (!host) return null;
  return createPortal(<div className={"campop" + (closing ? " closing" : "")} style={{ left, top }} data-campop role="dialog" aria-label="摄影机控制"
    data-cam-body={cam.body} data-cam-lens={cam.lens} data-cam-focal={cam.focal} data-cam-aperture={cam.aperture}>
    <div className="cam-card" ref={cardRef}>
      <div className="cam-hd"><b>摄影机控制</b><button type="button" className="cam-save" data-cam-save title="关闭（改轮盘即时生效，不用保存）" onClick={close}>保存</button></div>
      <div className="cam-wheels">
        {cols.map((col) => {
          const i = idx(col.key);
          return <div key={col.key} className="cam-col" data-cam-col={col.key} data-count={col.items.length}>
            <div className="cam-win">
              <div className="cam-track" style={{ transform: "translateY(" + (42 - 80 * i) + "px)" }}>
                {col.items.map((name, k) => <button key={String(name)} type="button" data-cam-item={col.key + ":" + k} data-cam-name={String(name)} data-on={k === i ? "1" : "0"} aria-label={String(name)}
                  className={"cam-item" + (k === i ? " on" : "") + (col.key === "focal" ? " num" : "")} onClick={() => set({ [col.key]: k } as Partial<CameraParams>)}>
                  {col.key === "focal" ? <span className="n">{name}mm</span> : <span className="g"><CamArt kind={col.key} name={String(name)} /></span>}
                  {col.key === "body" && k === i ? <i className="badge">DIGITAL</i> : null}
                </button>)}
              </div>
            </div>
            <div className="cam-label" data-cam-label={col.key} title={label(col.key)}>{label(col.key)}</div>
          </div>;
        })}
      </div>
    </div>
  </div>, host);
}

type AssetLib = { id: string; name: string; visibility?: string; access?: string };
type AssetItem = { id: string; title?: string; kind?: string; mediaKind?: string; media?: { kind?: string }; coverRef?: string; resourceRef?: string; previewUrl?: string; url?: string; prompt?: string };
type AssetCmd = (r: Record<string, unknown>) => Promise<Record<string, unknown>>;
const assetCmd = (): AssetCmd | null => { const c = (window as unknown as { openarc?: { canvas?: { command?: AssetCmd } } }).openarc?.canvas?.command; return typeof c === "function" ? c : null; };
const assetRefOf = (it: AssetItem) => it.resourceRef || it.coverRef || it.url || it.previewUrl || "";
const isPersonalLib = (l: AssetLib) => l.access === "owner" && String(l.visibility || "").toUpperCase() === "PRIVATE";
/** 资产没有文件夹字段：按 kind / 标题归类（归不进就是 Others，不编造） */
const folderOfAsset = (it: AssetItem): string => {
  const k = String(it.kind || it.mediaKind || it.media?.kind || "").toLowerCase();
  const t = String(it.title || "").toLowerCase();
  if (/style|风格/.test(k) || /风格/.test(t)) return "style";
  if (/character|role|角色/.test(k) || /角色/.test(t)) return "character";
  if (/scene|场景/.test(k) || /场景/.test(t)) return "scene";
  if (/prop|道具/.test(k) || /道具/.test(t)) return "prop";
  if (/audio|sound|音效/.test(k) || /音效/.test(t)) return "audio";
  return "others";
};
const STYLE_FOLDERS: Array<{ id: string; name: string; me: boolean; team: boolean }> = [
  { id: "fav", name: "收藏", me: true, team: false },
  { id: "character", name: "角色", me: true, team: true },
  { id: "scene", name: "场景", me: true, team: true },
  { id: "prop", name: "道具", me: true, team: true },
  { id: "style", name: "风格", me: true, team: true },
  { id: "audio", name: "音效", me: true, team: true },
  { id: "others", name: "Others", me: true, team: true },
];

/** 风格缩略图位：有真实资产就显示该资产图，没有就用色块；24×24 圆角 6 + 1px 描边（选中 2px 主色） */
function StyleDot({ src }: { src?: string }) {
  const url = useAssetUrl(src || "");
  const [bad, setBad] = useState(false);
  return <span className="dot">{url && !bad ? <img src={url} alt="" draggable={false} onError={() => setBad(true)} /> : null}</span>;
}

function StylePeek({ src, name, top }: { src: string; name: string; top: number }) {
  const url = useAssetUrl(src);
  if (!url) return null;
  return <div className="style-peek" data-style-peek={name} style={{ top }} aria-hidden="true"><img src={url} alt="" draggable={false} /><span>{name}</span></div>;
}

/** 选择风格图片：360×528 居中模态（TapNow 无进出动效，这里照做）；个人/团队 + 搜索 + 可折叠文件夹 + 取消/确认 */
function StyleLayer({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const ctl = useCtl(); const store = ctl.store;
  const [tab, setTab] = useState<"me" | "team">("me");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  const [libs, setLibs] = useState<AssetLib[] | null>(null);
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [err, setErr] = useState("");
  const [pickAsset, setPickAsset] = useState<AssetItem | null>(null);
  /** 悬停大图：在弹窗右侧和这一行对齐显示 160×160 预览（没有图就不显示） */
  const [peek, setPeek] = useState<{ src: string; name: string; top: number } | null>(null);
  const dlgRef = useRef<HTMLDivElement>(null);
  const peekAt = (row: HTMLElement, src: string, name: string) => {
    const box = dlgRef.current?.getBoundingClientRect();
    if (!src || !box) { setPeek(null); return; }
    const r = row.getBoundingClientRect();
    setPeek({ src, name, top: Math.max(0, Math.min(box.height - 196, r.top - box.top + r.height / 2 - 98)) });
  };
  const cmd = assetCmd();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); onClose(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  useEffect(() => {
    if (!cmd) { setLibs([]); return; }
    void cmd({ type: "canvas/assetLibrary/list" }).then((r) => setLibs(r && r.ok ? ((r.libraries as AssetLib[]) || []) : [])).catch(() => { setLibs([]); setErr("读取资产库失败"); });
  }, [cmd]);
  const pool = (libs || []).filter((l) => (tab === "team" ? !isPersonalLib(l) : isPersonalLib(l)));
  useEffect(() => {
    if (!cmd || !pool.length) { setAssets([]); return; }
    let dead = false;
    void (async () => {
      const all: AssetItem[] = [];
      for (const lib of pool) {
        const r = await cmd({ type: "canvas/assetLibrary/get", libraryId: lib.id }).catch(() => null);
        if (r && r.ok && Array.isArray(r.items)) all.push(...(r.items as AssetItem[]));
      }
      if (!dead) setAssets(all);
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd, tab, libs]);
  const kw = q.trim().toLowerCase();
  const rowsOf = (folder: string): AssetItem[] => assets.filter((it) => folderOfAsset(it) === folder && (!kw || [it.title, it.prompt].join(" ").toLowerCase().includes(kw)));
  const toggle = (id: string) => setOpen((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const confirm = () => {
    if (pickAsset) {
      const ref = assetRefOf(pickAsset);
      const live = store.node(node.id);
      if (!ref || !live) { store.toast("这个素材没有可引用的地址，没法作为参考图发送"); onClose(); return; }
      const made = store.newNode("image", live.x - 320, live.y + 40, { title: pickAsset.title || "风格参考", uploaded: true, hist: [{ url: ref }], w: 220, h: 220 });
      store.addNodes([made], [{ id: uid("e"), from: made.id, to: live.id }], { select: false });
      const prompt = genOf(store.node(node.id)!).prompt;
      if (!/参考所给图片的画面风格/.test(prompt)) store.patchGen(node.id, { prompt: (prompt ? prompt + "\n\n" : "") + "参考所给图片的画面风格" });
      store.toast("已把这张图作为风格参考输入：请求会带上它");
      onClose();
      return;
    }
    onClose();
  };
  const host = document.querySelector(".cn-root");
  if (!host) return null;
  return createPortal(<div className="style-mask" data-style-mask onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="style-dlg" ref={dlgRef} data-style-dlg role="dialog" aria-modal="true" aria-label="选择风格图片">
      {peek ? <StylePeek src={peek.src} name={peek.name} top={peek.top} /> : null}
      <div className="style-hd"><StyleGlyph /><b>选择风格图片</b><span className="sp" /><button type="button" className="style-x" data-style-x aria-label="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
      <div className="style-tabs">
        <div className="style-tabwrap" role="tablist">
          <span className="style-slider" style={{ transform: tab === "team" ? "translateX(156px)" : "none" }} />
          <button type="button" role="tab" aria-selected={tab === "me"} className={"style-tab" + (tab === "me" ? " on" : "")} data-style-tab="me" onClick={() => setTab("me")}>个人</button>
          <button type="button" role="tab" aria-selected={tab === "team"} className={"style-tab" + (tab === "team" ? " on" : "")} data-style-tab="team" onClick={() => setTab("team")}>团队</button>
        </div>
      </div>
      <div className="style-search"><Icon name="search" size="s" /><input data-style-search aria-label="搜索风格图片" placeholder="搜索风格图片" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      <div className="style-list" data-style-list>
        {STYLE_FOLDERS.filter((f) => (tab === "team" ? f.team : f.me)).map((f) => {
          const opened = open.includes(f.id);
          const kids = rowsOf(f.id);
          return <div key={f.id} className="style-group">
            <button type="button" className={"style-folder" + (opened ? " on" : "")} data-style-folder={f.id} data-open={opened ? "1" : "0"} onClick={() => toggle(f.id)}>
              <span className="style-arrow"><Icon name="down" size="s" /></span>
              <span className="fi"><Icon name="folder" size="s" /></span>
              <span className="fn">{f.name}</span>
            </button>
            {opened ? (kids.length ? <div className="style-kids">{kids.map((it) => <button key={it.id} type="button" className={"style-item" + (pickAsset?.id === it.id ? " on" : "")} data-style-asset={it.id}
                title={it.title || ""} onClick={() => setPickAsset(it)} onPointerEnter={(e) => peekAt(e.currentTarget, assetRefOf(it), it.title || "未命名素材")} onPointerLeave={() => setPeek(null)}><StyleDot src={assetRefOf(it)} /><span className="t">{it.title || "未命名素材"}</span></button>)}</div>
                : <div className="style-empty" data-style-empty>该文件夹暂无素材</div>) : null}
          </div>;
        })}
        {!cmd ? <div className="style-empty" style={{ paddingLeft: 4 }}>素材库只在桌面版可用</div> : null}
        {err ? <div className="style-empty" style={{ paddingLeft: 4 }}>{err}</div> : null}
      </div>
      <div className="style-ft">
        <button type="button" className="style-btn" data-style-cancel onClick={onClose}>取消</button>
        <button type="button" className="style-btn primary" data-style-ok onClick={confirm}>确认</button>
      </div>
    </div>
  </div>, host);
}

/* ---------------- 图片提示词快捷指令（输入 /） ---------------- */
export type PromptShortcut = { id: string; name: string; desc: string; prompt: string; ratio?: string; needRef?: boolean };
export const PROMPT_SHORTCUTS: PromptShortcut[] = [
  { id: "angles9", name: "多角度九宫格", desc: "用连着的参考图出 3×3 九个机位，可再「快速切分」成 9 张", ratio: "1:1", needRef: true,
    prompt: "以参考图中的主体为准，生成一张 3×3 九宫格联系表：九格分别是正面、左前 45°、右前 45°、左侧、右侧、背面、俯拍、仰拍、面部 / 局部特写。九格里主体的外观、服装、材质、颜色和光线完全一致，背景统一，格与格之间用细白线分隔，不加文字。" },
  { id: "story4", name: "四格分镜", desc: "2×2 四个连续镜头，适合先看节奏", ratio: "16:9",
    prompt: "生成一张 2×2 四格分镜图，按从左到右、从上到下的顺序讲一个连续的小情节：建立镜头 → 中景动作 → 特写反应 → 收尾镜头。四格人物和场景保持一致，电影感构图，格与格之间用细白线分隔，不加文字。" },
  { id: "turnaround", name: "角色三视图", desc: "正 / 侧 / 背三视图，白底", ratio: "16:9", needRef: true,
    prompt: "以参考图中的角色为准，生成一张角色设定三视图：从左到右依次是正面、侧面、背面全身站姿，三张比例和高度一致，纯白背景，平光，不加文字和标注。" },
  { id: "product", name: "白底产品图", desc: "电商主图：纯白底、柔光、居中", ratio: "1:1", needRef: true,
    prompt: "以参考图中的产品为准，生成电商白底主图：产品居中，纯白背景，柔和的棚拍光，轻微落地阴影，产品外观、颜色和细节与参考图完全一致，不加文字。" },
];
function SlashList({ onPick, onClose }: { onPick: (s: PromptShortcut) => void; onClose: () => void }) {
  const [hi, setHi] = useState(0);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + PROMPT_SHORTCUTS.length) % PROMPT_SHORTCUTS.length); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); setHi((h) => { onPick(PROMPT_SHORTCUTS[h]); return h; }); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", on, true); return () => document.removeEventListener("keydown", on, true);
  }, [onPick, onClose]);
  return <div className="slash-list" data-slash>
    <div className="mh">快捷指令 · ↑↓ 选择，↵ 确定</div>
    {PROMPT_SHORTCUTS.map((sc, i) => <button key={sc.id} className={"mi" + (i === hi ? " hi" : "")} data-sc={sc.id} onMouseMove={() => setHi(i)} onClick={() => onPick(sc)}>
      <Icon name={sc.id === "angles9" ? "grid" : sc.id === "story4" ? "layout" : sc.id === "turnaround" ? "cube" : "image"} size="s" />
      <span className="sl-m"><b>{sc.name}</b><small>{sc.desc}</small></span>{sc.ratio ? <span className="k">{sc.ratio}</span> : null}
    </button>)}
  </div>;
}
