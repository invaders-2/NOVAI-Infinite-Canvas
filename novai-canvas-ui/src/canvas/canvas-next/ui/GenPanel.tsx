/**
 * 选中单个节点时：节点上方工具条 + 节点下方生成面板。
 * 生成面板：输入（可拖动排序）→ 提示词（@ 引用上游分段）→ 提示 → 请求预览 → 底栏（模型 / 参数 / 张数 / 发送）。
 * 上游连着多维表格时，面板中间出现「生成输入」逐行列表与批量设置。
 */
import { hostRoot } from "../../../novaiBridgeRoot";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { addMention, afterInputsChanged, title } from "../actions";
import { mentionable, mentionedIds, unmentionedInputs } from "../mentions";
import { PromptEditor } from "./PromptEditor";
import { requestForNode, rolesFor, ROLE_LABEL, runNode, selfInputRole, stopNode } from "../engine";
import { mjHdAllowed, mjSummary, MJ_SPEED_LABEL, type MjParams } from "../model";
import { bgColor, CAMERAS, cameraSummary, clamp, clampParams, DEFAULT_CAMERA, formatClock, genOf, withGen, gifFrameCountFor, gifFrameDurationFor, gifFrameSpec, GIF_FRAME_FALLBACK, isQualityDefault, NODE_BG, NODE_TAG, newNode, placeholderSpec, promptOnlyModel, qualityChoices, qualityLabel, qualityLevelsFor, tagColor, thinkLevelLabel, thinkLevelsFor, thinkingAvailable, inputsOf, isGenKind, outOf, outputFormatForRequest, outputFormatOptions, outputFormatShortLabel, refsIn, sectionsOf, srcOf, textOf, TYPE_ICON, TYPE_LABEL, uid, videoDurationTagLabel, videoDurLabel, videoRatioLabel, videoResLabel, videoTimesLabel, VMODES, resRange, type AudioParams, type CameraParams, type GenKind, type ImageParams, type ModelSpec, type TextParams, type VideoParams, type VideoMode } from "../model";
import { batchInputWarnings, batchOf, batchRows, fillCandidates, fillTargetOf, OUTPUT_MODES, ownRefCount, planRow, rowsToRun, tableOf, withBatch, type BatchSettings } from "../table";
import { useCtl, useS, type Ctl } from "./ctx";
import { isSplitNode } from "./SplitNode";
import { openSplitEditor } from "./editors/SplitEditor";
import { startVoiceCapture, transcribeVoice, voiceErrorText, type VoiceCapture, type VoicePhase } from "../voiceInput";
import { keyHint } from "./shortcuts";
import { ratioDisplayLabel, sourceBoxForNode, sourceSizeForTier, type RatioParams, type SourceBox } from "../originalRatio";
import { fitSourceBox, isAdaptiveRatio } from "../mediaFit";
import { ComboMenu } from "./combo";
import { FloatMenuBar, FloatMenuButton } from "./FloatMenu";
import { Icon, type IconName } from "./Icon";
import { download } from "./menus";
import { saveNodeToLibrary } from "./Library";
import { VendorLogo } from "./VendorLogo";
import { openPop } from "./overlay";
import { ThumbImg } from "./thumb";
import { OptCards, normRatio, ratioShape } from "./OptCards";
import { OptimizeButton } from "./OptimizeButton";
import { DurationSlider } from "./DurationSlider";
import { EffortSlider } from "./EffortSlider";
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
    if (tbRef.current) { const tw = tbRef.current.offsetWidth, th = tbRef.current.offsetHeight; const ty = a.y - sr.top - 60; const top = Math.max(8, ty); tb = ty > sr.height - 60 || b.y < sr.top ? { left: -9999, top: -9999 } : { left: clamp(cx - tw / 2, minLeft(top, th), sr.width - tw - 8), top }; }
    if (gpRef.current) { const gw = gpRef.current.offsetWidth, gh = gpRef.current.offsetHeight; let top = b.y - sr.top + 14; const safeB = gpRef.current.closest(".cn-root.in-win") ? 76 : 8; /* 嵌在系统窗口里：底部给会弹出的 Dock 让位 */ if (top + gh > sr.height - safeB) top = Math.max(8, sr.height - gh - safeB); gp = { left: clamp(cx - gw / 2, minLeft(top, gh), sr.width - gw - 8), top }; }
    if (JSON.stringify(tb) !== JSON.stringify(pos.tb) || JSON.stringify(gp) !== JSON.stringify(pos.gp)) setPos({ tb, gp });
  });
  if (!node) return null;
  const run = runtime[node.id];
  return <>
    <Toolbar key={"t" + node.id} refEl={tbRef} node={node} running={!!run} progress={run?.progress || 0} style={pos.tb || { left: -9999, top: -9999 }} />
    {isGenKind(node.kind) && !isSplitNode(node) ? <div id="gp" key={"g" + node.id} ref={gpRef} className={"float enter" + (node.kind === "video" ? " gp-video" : "")} style={pos.gp || { left: -9999, top: -9999 }} onPointerDown={(e) => e.stopPropagation()}><GenPanel node={node} /></div> : null}
  </>;
}

function Toolbar({ node, running, progress, style, refEl }: { node: CanvasNode; running: boolean; progress: number; style: React.CSSProperties; refEl: React.RefObject<HTMLDivElement | null> }) {
  const ctl = useCtl(); const store = ctl.store; const out = isGenKind(node.kind) ? outOf(node) : null; const g = isGenKind(node.kind) ? genOf(node) : null;
  // 拆分结果节点自己就是编辑器：不挂普通图片工具条（关闭键在节点标题栏里）
  if (isSplitNode(node)) return null;
  // 空状态（还没结果、也没在生成）的文本 / 视频 / 音频节点不挂这条工具条：这时条上只剩背景色、标记这类零碎入口，
  // 却一直压在节点上方（右键菜单里都有）。生成中要能停止、有结果要能编辑，都不受影响。空图片节点见下面单独的分支。
  if (isGenKind(node.kind) && !out && !running && node.kind !== "image") return null;
  // 空图片节点只有一颗「上传」：同一套 dock 容器里的单颗按钮（常显图标 + 文字）。
  // 不走 FloatMenuBar —— 那套「按指针所在那颗长标签」是给一排按钮用的，单颗按钮用它会像一条空条子。
  if (isGenKind(node.kind) && !out && !running && node.kind === "image") {
    return <div id="ntb" ref={refEl} className="float enter ntb-empty-upload" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib tipT lab" data-tb="upload" data-tip="上传图片" onClick={() => window.dispatchEvent(new CustomEvent("cn:upload", { detail: { target: node.id, at: { x: node.x + 120, y: node.y + 120 } } }))}><Icon name="upload" />上传</button>
    </div>;
  }
  /** 展开态用的短标签（提示文字仍是原来的 tip，data-tb / data-tip 逐字保留给 e2e 与功能） */
  const LABEL: Record<string, string> = { crop: "裁剪", markup: "涂鸦", angle: "角度", mask: "局部", relight: "打光", whitemodel: "白膜", adjust: "调色", lossless: "无损", more: "更多", bg: "背景色", pin: "标记", lib: "素材库", dl: "下载", full: "全屏", frame: "截帧", stop: "停止", upload: "上传", copy: "复制", trim: "修剪", smartclip: "切分", final: "出成片" };
  const B = (act: string, ic: IconName, tip: string, lab = "", on?: (el: HTMLElement) => void) => <FloatMenuButton key={act} icon={ic} label={lab || LABEL[act] || tip} title={tip} data={{ "data-tb": act, "data-tip": tip }} onClick={(e) => on ? on(e.currentTarget) : edit(act, e.currentTarget)} />;
  /** TapNow「背景颜色」：无色 + 7 种低饱和色，竖排弹出 */
  const bgBtn = () => <FloatMenuButton key="bg" icon="palette" label="背景色" title="背景颜色" data={{ "data-tb": "bg", "data-tip": "背景颜色" }}
    adornment={<i className="bgdot" style={{ background: bgColor(g!.bg) || "var(--fg)" }} />}
    onClick={(e) => openPop(e.currentTarget, (close) => <div className="swatches v">
    <button className={"sw none" + (!g!.bg ? " on" : "")} aria-label="无" onClick={() => { close(); store.patchGen(node.id, { bg: undefined }, { history: true }); }} />
    {NODE_BG.map(([k, c]) => <button key={k} className={"sw" + (g!.bg === k ? " on" : "")} style={{ background: c }} aria-label={k} onClick={() => { close(); store.patchGen(node.id, { bg: k }, { history: true }); }} />)}
  </div>, "down", "left", "pop-sw")} />;
  /** TapNow「Pin」：6 种亮色标签，再点同色取消 */
  const tagBtn = () => <FloatMenuButton key="pin" icon="tag" label="标记" title={g!.tag ? "颜色标记" : "标记"} data={{ "data-tb": "pin", "data-tip": g!.tag ? "颜色标记" : "标记" }}
    adornment={g!.tag ? <i className="tagmini" style={{ background: tagColor(g!.tag)! }} /> : null}
    onClick={(e) => openPop(e.currentTarget, (close) => <div className="swatches h">
    <button className={"sw none" + (!g!.tag ? " on" : "")} aria-label="无" data-tag="none" onClick={() => { close(); store.patchGen(node.id, { tag: undefined, pinned: false }, { history: true }); }} />
    {NODE_TAG.map(([k, c]) => <button key={k} className={"sw" + (g!.tag === k ? " on" : "")} style={{ background: c }} aria-label={k} onClick={() => { close(); store.patchGen(node.id, g!.tag === k ? { tag: undefined, pinned: false } : { tag: k, pinned: true }, { history: true }); }} />)}
  </div>, "up", "left", "pop-sw")} />;
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
  else if (node.kind === "image") items = [B("crop", "crop", "裁剪 / 旋转"), B("markup", "pencil", "涂鸦 / 文字 / 马赛克"), B("angle", "cube", "多角度"), B("mask", "brush", "局部重绘"), B("relight", "sun", "重打光"), B("whitemodel", "user", "白膜处理：把人物变成白色石膏人台，保留姿势与构图"), B("adjust", "palette", "调色"), B("lossless", "edit", "无损改图"), B("split", "layers", "拆分图层", "拆分图层", (el) => splitMenu(ctl, node.id, el)), B("more", "more", "更多"), <span key="s" className="vsep" />, tagBtn(), B("lib", "libadd", "保存到素材库", "", (el) => saveToLibrary(el)), B("dl", "download", "下载", "", () => void download(node, store)), B("full", "expand", "全屏查看", "", () => window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id })))];
  else if (node.kind === "text") items = [bgBtn(), tagBtn(), <span key="s" className="vsep" />, B("copy", "copy", "复制全部", "", async () => { try { await navigator.clipboard.writeText(textOf(node)); store.toast("已复制全部内容"); } catch { store.toast("剪贴板不可用"); } }), B("lib", "libadd", "保存到素材库", "", (el) => { const r = el.getBoundingClientRect(); void saveNodeToLibrary(ctl, node, { x: r.left, y: r.bottom + 6 }); }), B("full", "expand", "全屏编辑", "", () => window.dispatchEvent(new CustomEvent("cn:textdoc", { detail: node.id })))];
  else if (node.kind === "video" && out) items = [
    // TapNow 视频工具栏：修剪 / 智能切镜 / AI 编辑（替换·移除·续写·重拍）/ 截帧 / 更多 ┃ 标签 ┃ 保存素材库 / 下载 / 全屏
    // 草稿模式出的低清版本最前面多一个「出成片」
    ...(out.draft ? [B("final", "sparkle", "按最高清晰度重新生成成片", "出成片", () => void draftToFinal(store, node))] : []),
    B("trim", "scissors", "修剪：把使用区间裁成新视频节点", "", () => void trimToNode(store, node)),
    B("smartclip", "split", "智能切镜：按镜头拆成多个节点", "", () => void smartClip(store, node)),
    <FloatMenuButton key="vai" icon="wand" label="AI 编辑" title="AI 编辑：替换 / 移除 / 续写 / 重拍" data={{ "data-tb": "vai", "data-tip": "AI 编辑：替换 / 移除 / 续写 / 重拍" }} onClick={(e) => videoAiMenu(store, node, e.currentTarget)} />,
    B("frame", "frame", "截帧（快捷键 1）", "截帧"),
    <FloatMenuButton key="vmore" icon="more" label="更多" title="更多" data={{ "data-tb": "vmore", "data-tip": "更多" }} onClick={(e) => videoMore(ctl, node, e.currentTarget)} />,
    <span key="s1" className="vsep" />, tagBtn(), <span key="s2" className="vsep" />,
    B("lib", "libadd", "保存到素材库", "", (el) => saveToLibrary(el)),
    B("dl", "download", "下载", "", () => void download(node, store)),
    B("full", "expand", "全屏播放", "", () => window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id }))),
  ];
  // TapNow 音频结果：颜色标记 ┃ 保存素材库 / 下载
  else if (node.kind === "audio" && out) items = [tagBtn(), <span key="s" className="vsep" />, B("lib", "libadd", "保存到素材库", "", (el) => saveToLibrary(el)), B("dl", "download", "下载", "", () => void download(node, store))];
  // 多维表格：文件类操作（复制 / 导入 / 全屏）放顶部浮条，表内编辑（加行加列 / 分镜出片）留在节点底部 .tfoot。
  // 复制与导入走自定义事件交回 TableNodeBody，那里才有 CsvImportDialog 和 csvFromTable。
  else if (node.kind === "table") items = [
    B("csv-copy", "copy", "把整张表（不含输入通道列）复制成 CSV，第一行是列名", "复制 CSV", () => window.dispatchEvent(new CustomEvent("cn:tablecsv", { detail: { id: node.id, action: "copy" } }))),
    B("csv-import", "upload", "粘贴 CSV / TSV 替换整张表（保留标题、输入通道模式和列用途）", "导入 CSV", () => window.dispatchEvent(new CustomEvent("cn:tablecsv", { detail: { id: node.id, action: "import" } }))),
    B("table-full", "expand", "全屏编辑表格", "全屏编辑", () => window.dispatchEvent(new CustomEvent("cn:tabledoc", { detail: node.id }))),
  ];
  if (!items.length) return null;
  // 位置仍由 SelectionUI 用屏幕坐标算（pos.tb），这里只换外观/动效；
  // #ntb 在 .cn-root 层、不在画布 world 缩放下，所以显式 scale:1（别被 --zinv 放大）
  return <FloatMenuBar id="ntb" ref={refEl} show compensate className="float enter" style={{ ...style, scale: 1 }} onPointerDown={(e) => e.stopPropagation()}>{items}</FloatMenuBar>;
}

/* ---------------- 生成面板 ---------------- */
function GenPanel({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const run = useS((s) => s.runtime[node.id]); const preview = useS((s) => s.ui.preview); const pick = useS((s) => s.ui.pick); useS((s) => s.models);
  const kind = node.kind as GenKind; const g = genOf(node); const m = store.modelOf(node); const p = g.params;
  const allIns = inputsOf(doc, node.id); const unm = unmentionedInputs(node, allIns);
  const ins = allIns.filter((x) => x.node.kind !== "table"); const tables = allIns.filter((x) => x.node.kind === "table");
  const { roles, ignored } = rolesFor(kind, p, m, ins);
  const imgIns = ins.filter((x) => x.node.kind === "image");
  const originalSource = useSourceBox(node, kind);
  // 原图比例：量到源图尺寸就记进 params.sourceSize（图片是请求要发的显式 WxH，视频只当比例备忘），
  // 节点摆正由 store 的比例不变量处理；比例没变不会重摆，用户拖过的尺寸不会被弹回去
  const ratioMemo = p as RatioParams;
  const originalMemo = ratioMemo.sourceSize || "";
  useEffect(() => {
    if (kind !== "image" && kind !== "video") return;
    if (!isAdaptiveRatio(ratioMemo.ratio)) return;
    const size = sourceSizeForTier(originalSource, kind === "image" ? (p as ImageParams).size : "1K");
    if (size && size !== originalMemo) store.patchGen(node.id, (gg) => ({ params: { ...gg.params, sourceSize: size } }));
  }, [kind, node.id, p, originalSource, ratioMemo.ratio, originalMemo]);
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
  /* 语音输入：录音 → WAV → 后端转写，成功后接在当前提示词后面 */
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const voiceCap = useRef<VoiceCapture | null>(null);
  const voiceStarting = useRef(false);
  const voiceToken = useRef(0);
  /** 卸载时权限弹窗可能还没回来：回来后再拿到的 cap 要立刻取消 */
  const voiceAlive = useRef(true);
  const applyVoiceText = (text: string) => {
    const cur = genOf(store.node(node.id)!).prompt;
    const next = (cur ? cur + "，" : "") + text;
    setDraft(next);
    commitPrompt(next);
  };
  const transcribeIntoPrompt = async (blob: Blob) => {
    const token = voiceToken.current;
    const result = await transcribeVoice(blob);
    if (token !== voiceToken.current) return;
    if (result.ok && result.text) applyVoiceText(result.text);
    else store.toast(voiceErrorText(result.code, result.error));
    setVoicePhase("idle");
  };
  const voice = async () => {
    if (voicePhase === "transcribing" || voiceStarting.current) return;
    if (voicePhase === "recording") {
      const cap = voiceCap.current;
      // 到时长上限自动结束时回调已经接管，这次点击直接忽略
      if (!cap) return;
      voiceCap.current = null;
      setVoicePhase("transcribing");
      let blob: Blob | null = null;
      try { blob = await cap.stop(); } catch { blob = null; }
      if (!blob) { setVoicePhase("idle"); return; }
      await transcribeIntoPrompt(blob);
      return;
    }
    voiceStarting.current = true;
    try {
      const cap = await startVoiceCapture({
        maxSeconds: 90,
        onAutoStop: (blob) => { voiceCap.current = null; setVoicePhase("transcribing"); void transcribeIntoPrompt(blob); },
      });
      if (!voiceAlive.current) { cap.cancel(); return; }
      voiceCap.current = cap;
      setVoicePhase("recording");
    } catch (error) {
      const err = error as { name?: string; message?: string } | null;
      store.toast(voiceErrorText(err?.name, err?.message));
    } finally {
      voiceStarting.current = false;
    }
  };
  // 面板关掉 / 切节点时释放麦克风
  useEffect(() => {
    voiceAlive.current = true;
    return () => {
      voiceAlive.current = false;
      voiceToken.current += 1;
      voiceCap.current?.cancel();
      voiceCap.current = null;
    };
  }, []);
  /** 编辑器每次改动：插入 @ 引用时立刻写回并切到引用模式（其余改动失焦时写回） */
  const onPrompt = (v: string, o?: { mention?: boolean }) => { setDraft(v); if (o?.mention) store.patchGen(node.id, { prompt: v, refMode: "mention" }); };

  const warns: string[] = [];
  if (!m) warns.push(`还没有可用的${TYPE_LABEL[kind]}模型，请在 设置 › 模型 里添加。`);
  if (m && kind === "image" && imgIns.length && !m.i2i) warns.push(`${m.name} 不支持参考图，${imgIns.length} 张图片输入不会发送。`);
  else if (m && kind === "image" && imgIns.length > (m.maxRefs || 0)) warns.push(`${m.name} 最多接收 ${m.maxRefs} 张参考图，按连线顺序只发送前 ${m.maxRefs} 张。`);
  if (m && kind === "text" && imgIns.length && !m.vision) warns.push(`${m.name} 不读图片，${imgIns.length} 张图片输入会被忽略。`);
  if (kind === "video") { const vp = p as VideoParams; if (["视频编辑", "视频延长", "参考视频生视频"].includes(vp.mode) && !ins.some((x) => x.node.kind === "video") && !tables.length) warns.push(`「${vp.mode}」需要连入一段视频。`); if (vp.mode === "数字人" && !(imgIns.length && ins.some((x) => x.node.kind === "audio"))) warns.push("「数字人」需要 1 张人像和 1 段音频。"); if (imgIns.length && vp.mode === "文生视频") warns.push("当前是文生视频，图片输入不会发送。切到「首帧」可以用上第 1 张图。"); }
  // 音频节点的输入现在会带一条「来源」连线（媒体节点再生成时自己也是输入），但音频模型还不收音频 / 图片参考
  if (kind === "audio" && ins.some((x) => x.node.kind !== "text" && x.node.kind !== "table")) warns.push("音频模型还不支持把音频 / 图片输入当参考：这条连线只表示来源，不会随请求发送。");
  // 提示词里 @ 了本节点，但当前模型 / 生成方式不收自己这条结果：说清楚，别让人以为发了
  if (m && (kind === "image" || kind === "video") && mentionedIds(g.prompt).has(node.id)) {
    const live = ins.filter((x) => !ignored.has(x.edge.id));
    if (!selfInputRole(kind, p, m, live.filter((x) => x.node.kind === "image").length)) {
      warns.push(kind === "video"
        ? `当前生成方式「${(p as VideoParams).mode}」不接受视频输入：@ 的本节点当前视频不会发送，切到「参考视频生视频」或「视频编辑」才行。`
        : `${m.name} 不支持参考图：提示词里 @ 的本节点当前结果不会发送。`);
    }
    // 当前版本上记着生成时的自我参考源（或明确没有）：重新生成沿用那条记录，不会把新一版结果再喂回去。
    // 这是有意的行为变化，在面板上说清楚怎么拿当前这一版继续改。
    const fixed = outOf(node)?.meta?.selfSrc;
    if (fixed !== undefined) warns.push(fixed
      ? `重新生成会继续用最初带出去的「本节点」参考图，不会把新一版结果再喂回去。想拿当前这一版继续改，先右键「副本」复制成独立的${kind === "video" ? "视频" : "图片"}节点，再 @ 引用它。`
      : `这一版生成时没有带「本节点」参考图，重新生成也不会补上上一版结果。想拿当前这一版继续改，先右键「副本」复制成独立的${kind === "video" ? "视频" : "图片"}节点，再 @ 引用它。`);
  }
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
    /** 只出提示词的模型（Context-IR）：不给视频参数，改成一行说明 */
    const promptOnly = promptOnlyModel(m);
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
        <button className={"vp-pick tipB" + (preview ? " on" : "")} data-p="preview" data-tip="请求预览：看看这次会发给后端什么" onClick={() => store.setUI({ preview: !preview })}><Icon name="text" size="s" /></button>
        {m?.modes?.includes("视频编辑") ? <button className="vp-object" data-p="object-replace" disabled={busy} onClick={() => { set({ mode: "视频编辑" }); const next = draft.trim() || "替换源视频中的目标对象，保持其他人物、背景、光照、镜头运动和场景连续性不变"; setDraft(next); commitPrompt(next); }}><Icon name="wand" size="xs" />对象替换</button> : null}
      </div>
      <PromptEditor node={node} className="vp-prompt" placeholder={ph} value={draft} onChange={onPrompt} onCommit={commitPrompt} onSend={send} onEscape={() => store.setUI({ sel: new Set(), pick: null })} />
      {promptOnly ? <div className="gp-note" data-prompt-only role="note"><Icon name="brain" size="s" /><span>该模型只返回提示词，不产视频：需再把结果喂给 MiniMax-H3 生成视频。</span></div> : null}
      {tables.length ? <BatchPanel node={node} /> : null}
      {unm.size ? <UnrefWarn node={node} ids={[...unm]} onAdd={() => commitPrompt(draft)} /> : null}
    {warns.map((w) => <div key={w} className="gp-warn"><Icon name="alert" size="s" /><span>{w}</span></div>)}
      {preview ? <div className="gp-prev"><pre>{JSON.stringify(previewOf(ctl, node), null, 2)}</pre></div> : null}
      <div className="vp-foot">
        <button className="vp-model" data-p="model" onClick={(e) => paramPop(ctl, node, "model", e.currentTarget)} title={m?.name || (store.modelsOf(kind).length ? "选择模型" : "未配置模型")}>{m?.name || (store.modelsOf(kind).length ? "选择模型" : "未配置模型")}</button>
        <span className="vp-between" />
        {promptOnly
          ? ((m?.ratios || []).length ? <button className="vp-vals" data-p="vratio" disabled={busy} title="比例：点开调整（该模型只返回提示词）" onClick={(e) => paramPop(ctl, node, "vratio", e.currentTarget)}><span data-vval="ratio">{videoRatioLabel(vp.ratio)}</span></button> : null)
          : <button className="vp-vals" data-p="vset" disabled={busy} title={m ? `${m.name} 的参数：点开调整` : "还没有可用的视频模型"} onClick={(e) => paramPop(ctl, node, "vset", e.currentTarget)}>
          <span data-vval="mode">{vp.mode}</span>
          <i>·</i>
          <span data-vval="ratio">{videoRatioLabel(vp.ratio)}</span>
          <i>·</i>
          <span data-vval="res">{vp.draft && resRange(m) ? `草稿 ${resRange(m)!.low}` : videoResLabel(vp.res)}</span>
          <i>·</i>
          <span data-vval="dur">{videoDurLabel(vp.dur)}</span>
        </button>}
        <span className="grow" />
        {promptOnly ? null : <button className={"vp-audio tipT" + (vp.sound ? " on" : "")} data-p="vaudio" data-tip={vp.sound ? "音频：开" : "音频：关"} disabled={busy || !m?.audio} onClick={() => set({ sound: !vp.sound })}><Icon name="audio" size="s" /></button>}
        <OptimizeButton node={node} draft={draft} setDraft={setDraft} className="vp-audio opt" />
        {promptOnly ? null : <button className="vp-times tnum" data-p="vtimes" disabled={busy || !m || (m.times || [1]).length < 2} onClick={(e) => paramPop(ctl, node, "vtimes", e.currentTarget)}>{videoTimesLabel(vp.times)}</button>}
        {run
          ? <button className="vp-send busy" data-p="stop" title="停止生成" onClick={() => stopNode(store, node.id)}><span className="sqr" /></button>
          : <button className="vp-send" data-p="send" title={"生成 " + keyHint("promptSend")} onClick={send}><Icon name="send" size="s" /></button>}
      </div>
    </>;
  }
  const pill = (k: string, content: React.ReactNode, on = false, extraCls = "") => <button key={"p-" + k} className={"pill" + (on ? " on" : "") + (extraCls ? " " + extraCls : "")} data-p={k} onClick={(e) => paramPop(ctl, node, k, e.currentTarget)}>{content}</button>;
  const vline = (k: string) => <span key={k} className="vline" />;
  const foot: React.ReactNode[] = [];
  if (kind === "audio") { const ap = p as AudioParams; foot.push(pill("model", <><Icon name="sparkle" size="s" />{m?.name || (store.modelsOf(kind).length ? "选择模型" : "未配置模型")}<Icon name="down" size="xs" /></>), vline("v1"), pill("akind", <><Icon name="audio" size="s" />{ap.kind}</>), vline("v2"), pill("adur", <>{ap.dur}</>)); }
  // 图片 / 文本：TapNow 式单行文本（模型 ｜ 比例 · 尺寸 · 次数 · 风格 · 摄影机），点哪段开哪段弹层，能力不丢
  // 没模型时节段灰显（仍可点开看有哪些档位，弹层里的控件是禁用的）
  const seg = (k: string, label: React.ReactNode, on = false, muted = !m) => <button key={"seg-" + k} className={"gp-seg" + (on ? " on" : "") + (muted ? " muted" : "")} data-p={k} data-seg={k} title={muted ? "还没有可用的模型，添加后可调" : undefined} onClick={(e) => paramPop(ctl, node, k, e.currentTarget)}>{label}</button>;
  const gdot = (k: string) => <i key={"gd-" + k} className="gp-dot">·</i>;
  const gline: React.ReactNode[] = [<button key="seg-model" className="gp-seg model" data-p="model" data-seg="model" onClick={(e) => paramPop(ctl, node, "model", e.currentTarget)}>{m?.name || (store.modelsOf(kind).length ? "选择模型" : "未配置模型")}</button>];
  if (kind === "image") {
    const ip = p as ImageParams;
    const formats = outputFormatOptions(m);
    // 质量档 / 先思考：只看后端 caps（qualities > 1 档才有质量档；thinking_mode 为真才有开关）
    if (qualityLevelsFor(m).length > 1) gline.push(gdot("cqual"), <button key="seg-quality" className={"gp-seg" + (isQualityDefault(ip.quality) ? "" : " on")} data-p="quality" data-seg="quality"
      aria-label={"质量：" + (isQualityDefault(ip.quality) ? "默认" : qualityLabel(ip.quality))}
      title={"质量（" + (m?.name || "") + "）：" + (isQualityDefault(ip.quality) ? "默认（跟随上游）" : qualityLabel(ip.quality))}
      onClick={(e) => paramPop(ctl, node, "quality", e.currentTarget)}>质量{isQualityDefault(ip.quality) ? "" : " " + qualityLabel(ip.quality)}</button>);
    if (thinkingAvailable(m)) gline.push(gdot("cthinking"), <button key="seg-thinking" className={"gp-seg" + (ip.thinking === true || ip.thinking === false ? " on" : "")} data-p="thinking" data-seg="thinking"
      aria-label={"先思考：" + (ip.thinking === true ? "开" : ip.thinking === false ? "关" : "默认")}
      title={"先思考（" + (m?.name || "") + "）：" + (ip.thinking === true ? "开：先想再画" : ip.thinking === false ? "关：直接出图" : "默认（模型决定）")}
      onClick={(e) => paramPop(ctl, node, "thinking", e.currentTarget)}>先思考{ip.thinking === true ? " 开" : ip.thinking === false ? " 关" : " 默认"}</button>);
    // 透明背景的入口在「比例 · 尺寸」弹层里（RatioPop），底栏只保留一个「 · 透明」状态摘要
    const bgOn = ip.background === "transparent";
    const gifOn = outputFormatForRequest(ip.outputFormat) === "gif";
    gline.push(<span key="gp-bar1" className="gp-bar" />, seg("ratio", <>{/^(auto|adaptive|自适应)$/i.test(ip.ratio) ? "原图比例" : ip.ratio} · {ip.size}{!bgOn && formats.length ? " · " + outputFormatShortLabel(ip.outputFormat) : ""}{bgOn ? " · 透明" : ""}</>), gdot("c1"), seg("count", <>{ip.count}×</>));
    if (gifOn) gline.push(gdot("cgif"), seg("gifframes", <>{gifFrameCountFor(ip.frameCount, m)} 帧 · {gifFrameDurationFor(ip.frameDuration, m)}ms</>));
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
    // 模型强度：档位来自后端 /api/config 的 model_caps[model].think；多于 1 档才给入口（不支持 = 不显示）
    if (thinkLevelsFor(m).length > 1) gline.push(gdot("cthink"), <button key="seg-think" className={"gp-seg" + (tp.think ? " on" : "")} data-p="think" data-seg="think"
      aria-label={"模型强度：" + (tp.think ? thinkLevelLabel(tp.think) : "默认")}
      title={"模型强度（" + (m?.name || "") + "）：" + (tp.think ? thinkLevelLabel(tp.think) : "默认（不指定）")}
      onClick={(e) => paramPop(ctl, node, "think", e.currentTarget)}>模型强度{tp.think ? " " + thinkLevelLabel(tp.think) : ""}</button>);
    gline.push(<span key="gp-bar1" className="gp-bar" />, seg("output", OUTPUT_MODES.find((o) => o[0] === (tp.output || "text"))![1], tp.output === "table" || tp.output === "storyboard"));
    if (!m || m.search) gline.push(gdot("c2"), <button key="gp-net" className={"gp-seg" + (tp.search ? " on" : "") + (!m ? " muted" : "")} data-seg="tsearch" disabled={!m} onClick={() => set({ search: !tp.search })}>联网{tp.search ? " 开" : ""}</button>);
  }
  return <>
    <div className="gp-in">
      <button className={"sq tipT" + (pick === node.id ? " on" : "")} data-p="pick" data-tip="从画布选择输入" onClick={() => { const on = pick !== node.id; store.setUI({ pick: on ? node.id : null }); if (on) store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" /></button>
      {ins.map((x) => { const src = srcOf(x.node); return (
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
        <button className={"mic" + (voicePhase === "recording" ? " rec" : "")} data-p="mic" data-voice-phase={voicePhase} aria-pressed={voicePhase === "recording"} disabled={voicePhase === "transcribing"} title={voicePhase === "recording" ? "结束并转写" : voicePhase === "transcribing" ? "正在转写…" : "语音输入"} onClick={() => void voice()}><Icon name="mic" size="s" /></button>
        {/* 没配模型时 est 为空：不渲染空药丸（否则看起来像没渲染完），也不占位 */}
        {est ? <span className="est tnum" title="预计耗时">{est}{m?.local ? " · 本机" : ""}</span> : null}
        {run ? <button className="send busy" data-p="stop" title="停止生成" onClick={() => stopNode(store, node.id)}><i className="ring"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></svg></i><span className="sqr" /></button>
          : <button className="send" data-p="send" title={"生成 " + keyHint("promptSend")} onClick={send}><Icon name="send" size="s" /></button>}
      </div>
    </div>
    {kind === "image" && camOpen ? <CamLayer node={node} anchor={camRef.current} onClose={() => setCamOpen(false)} /> : null}
    {kind === "image" && styleOpen ? <StyleLayer node={node} onClose={() => setStyleOpen(false)} /> : null}
  </>;
}

/** 工具条「拆分图层」：自动 / 自定义两种拆法都打开同一个全屏编辑器（拆分本身不消耗积分） */
function splitMenu(ctl: Ctl, id: string, anchor: Element) {
  openPop(anchor, (close) => {
    const fire = (mode: "auto" | "custom") => () => { close(); openSplitEditor(id, mode); };
    return <>
      <div className="mh">拆分图层</div>
      <button className="mi" data-split-mode="auto" onClick={fire("auto")}>
        <span className="ic"><Icon name="layers" size="s" /></span>
        <span>自动拆分<span className="d">自动识别图层和文字，先出结果再调</span></span>
      </button>
      <button className="mi" data-split-mode="custom" onClick={fire("custom")}>
        <span className="ic"><Icon name="crop" size="s" /></span>
        <span>自定义拆分<span className="d">框选区域并描述，只拆你圈出的部分</span></span>
      </button>
    </>;
  }, "up");
}

/**
 * 深度动作捕捉：本机逐帧把这段视频转成灰度深度视频（越近越亮、不带原片外观），
 * 结果作为新视频节点接在源视频右边，再连到视频生成节点当参考视频用。
 */
async function runDepthCapture(store: CanvasStore, n: CanvasNode) {
  const src = outOf(n)?.url;
  if (!src) { store.toast("这段视频还没有画面，先上传或生成一段再提取"); return; }
  const be = store.backend;
  if (!be.depthCapture) { store.toast("当前后端没有深度动作捕捉，更新到最新安装包再试"); return; }
  const started = Date.now();
  const abort = new AbortController();
  store.setRun(n.id, { status: "running", progress: .02, abort, startedAt: started });
  try {
    const out = await be.depthCapture(src);
    store.setRun(n.id, null);
    // 接口没有中止参数：点停止只是丢掉结果，后端那趟仍会跑完
    if (abort.signal.aborted) return;
    // 深度视频和源视频可能不是同一个画幅（竖版源片被塞进横框就是这样）：按深度视频的真实像素定框，别沿用源节点尺寸
    const box = out.w && out.h ? fitSourceBox(out.w, out.h) : null;
    const w = box?.w || n.w, h = box?.h || n.h;
    const made = newNode("video", n.x + n.w + 120, n.y, {
      title: (n.text || "视频") + " · 深度动作捕捉",
      hist: [{ url: out.url, w, h, dur: out.dur, meta: { model: "深度动作捕捉", at: Date.now() } }],
      w, h,
    });
    store.addNodes([made], [{ id: uid("e"), from: n.id, to: made.id }], { select: true });
    const secs = out.seconds ? Math.round(out.seconds) : Math.round((Date.now() - started) / 1000);
    store.toast(`深度视频已生成，用了 ${secs} 秒；连到视频节点当参考用`);
  } catch (err) {
    store.setRun(n.id, null);
    store.toast(err instanceof Error ? err.message : "深度动作捕捉失败");
  }
}

/**
 * 套用原声：生成侧不复刻声音（模型输出无音轨），这里把来源视频的音轨本机贴到成片上。
 * 结果作为这个节点的一条新历史，不新建节点——下游连线不用重接，旧版本还在历史里可回退。
 */
async function applyAudio(ctl: Ctl, node: CanvasNode, source: CanvasNode) {
  const store = ctl.store;
  const video = outOf(node)?.url;
  const audio = outOf(source)?.url;
  if (!video) { store.toast("这个节点还没有成片，先出片再套原声"); return; }
  if (!audio) { store.toast("选中的参考视频没有画面，读不到声音"); return; }
  const be = store.backend;
  if (!be.muxAudio) { store.toast("当前后端没有本机音频处理，更新到最新安装包再试"); return; }
  const started = Date.now();
  store.setRun(node.id, { status: "running", progress: .05, abort: new AbortController(), startedAt: started });
  try {
    const out = await be.muxAudio(video, audio, {});
    store.setRun(node.id, null);
    store.updateNode(node.id, (n) => {
      const g = genOf(n);
      const hist = [...(g.hist || []), { url: out.url, dur: out.dur, meta: { model: "套用原声", at: Date.now() } }];
      return withGen(n, { hist, hi: hist.length - 1 });
    }, { history: true });
    store.toast("已套用「" + (genOf(source).title || "参考视频") + "」的声音，用了 " + Math.max(1, Math.round((Date.now() - started) / 1000)) + " 秒");
  } catch (err) {
    store.setRun(node.id, null);
    store.toast(err instanceof Error ? err.message : "套用原声失败");
  }
}

/** 视频结果动作的「更多」：首帧/尾帧截帧、设为视频封面、应用到画布、下载、全屏（对齐 TapNow） */
function videoMore(ctl: Ctl, node: CanvasNode, anchor: Element) {
  const store = ctl.store;
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
      <div className="mh">参考视频</div>
      <button className="mi" data-tbk="depthcapture" onClick={() => { close(); void runDepthCapture(store, node); }}><Icon name="layers" size="s" /><span style={{ flex: 1 }}>深度动作捕捉</span><span className="k">本机</span></button>
      <div className="msep" />
      <div className="mh">声音</div>
      <button className="mi" data-tbk="audio" onClick={(e) => openPop(e.currentTarget, (close2) => {
        const doc = store.state.doc;
        const upstream = (doc.edges || []).filter((edge) => edge.to === node.id).map((edge) => store.node(edge.from));
        const others = doc.nodes.filter((n) => n.kind === "video" && n.id !== node.id);
        const seen = new Set<string>();
        const picked = [...upstream, ...others].filter((n): n is CanvasNode => !!n && !!outOf(n)?.url && !seen.has(n.id) && (seen.add(n.id), true)).slice(0, 6);
        return <>
          <div className="mh">套用哪个视频的原声<span className="d"> · 本机贴音轨，画质不动</span></div>
          {picked.length ? picked.map((src) => (
            <button key={src.id} className="mi" data-audio-from={src.id} onClick={() => { close2(); close(); void applyAudio(ctl, node, src); }}>
              <Icon name="audio" size="s" /><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{genOf(src).title || "视频"}</span>
            </button>
          )) : <div className="mh" style={{ whiteSpace: "normal", lineHeight: 1.5 }}>画布上还没有带画面的参考视频</div>}
          <div className="mh" style={{ whiteSpace: "normal", lineHeight: 1.5 }}>整段音乐按成片长度裁；原片说话的话口型对不上，慎用</div>
        </>;
      }, "up")}><Icon name="audio" size="s" /><span style={{ flex: 1 }}>套用原声</span><span className="k">本机</span></button>
      <div className="msep" />
      <div className="mh">编辑当前帧</div>
      <button className="mi" data-tbk="cropframe" onClick={fire("cropframe")}><Icon name="crop" size="s" />裁剪画面<span className="k">先截帧</span></button>
      <button className="mi" data-tbk="eraseframe" onClick={fire("eraseframe")}><Icon name="eraser" size="s" />擦除画面<span className="k">先截帧</span></button>
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

// 输入/风格胶囊里的 28px 小图：只值一张缩略图
function ChipImg({ src }: { src: string }) { return <ThumbImg src={src} width={28} fallback={<Icon name="image" size="s" />} />; }

/** 请求预览：生成节点给出发给后端的请求；连着表格时给出第一行的请求和总行数 */
function previewOf(ctl: ReturnType<typeof useCtl>, node: CanvasNode) {
  const store = ctl.store; const rows = batchRows(store.state.doc, node.id, fillTargetOf(store.state.doc, node.id, batchOf(node).settings));
  const req = requestForNode(store, node, rows[0]); if (!req) return { error: "没有可用模型" };
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
  // 常驻说明（不只 toast）：输入编号对不上 / 多出来的旧通道；参考图超模型上限被截时点名是哪一列
  const inputWarns = batchInputWarnings(doc, node.id);
  // 生成节点自身连的图会占参考图名额：预览 / 行提醒都要用和真实请求同一个 reserved
  const reservedRefs = ownRefCount(doc, node.id, node.kind as GenKind);
  const refWarns = [...new Set(rows.filter((r) => todo.has(r.row)).flatMap((r) => planRow(node.kind as GenKind, g.params, m, r, reservedRefs).warnings).filter((w) => w.includes("参考图超过") || w.includes("不支持参考图") || w.includes("参考图名额已被")))];
  return <div className="gp-batch">
    <div className="bh"><Icon name="grid" size="s" /><b>生成输入</b><span className="tnum">{s.manual ? `独立运行 · 已选 ${s.selected.filter((x) => rows.some((r) => r.row === x)).length}/${rows.length}` : `批量 ${todo.size} 行 · 首批 ${Math.min(s.concurrency, todo.size)}`}</span><span className="sp" />{journal ? <button className="linkbtn" onClick={() => store.updateNode(node.id, (n) => withBatch(n, { journal: null }))} title="清除上次运行记录，下次从头生成">重置记录</button> : null}</div>
    {inputWarns.map((w) => <div className="gp-warn" data-warn="table-input" key={w}><Icon name="alert" size="s" /><span>{w}</span></div>)}
    {refWarns.map((w) => <div className="gp-warn" data-warn="ref-limit" key={w}><Icon name="alert" size="s" /><span>{w}</span></div>)}
    <div className="blist">
      {rows.map((r) => { const j = stOf(r.row); const sel = s.manual ? s.selected.includes(r.row) : first.includes(r.row); return (
        <button key={r.row} className={"brow" + (sel ? " sel" : "") + (todo.has(r.row) ? "" : " skip") + (s.manual ? "" : " dim")} onClick={() => { if (!s.manual) return; setS({ selected: s.selected.includes(r.row) ? s.selected.filter((x) => x !== r.row) : [...s.selected, r.row].sort((a, b) => a - b) }); }}>
          <span className="n tnum">{r.row}</span>
          <span className="md">{r.media.slice(0, 3).map((md) => <RowThumb key={md.nodeId} src={md.src} kind={md.kind} />)}</span>
          <p>{(() => { const pl = planRow(node.kind as GenKind, g.params, m, r, reservedRefs); const pp = pl.params as { mode?: string; dur?: number; ratio?: string }; const tags = [r.label, node.kind === "video" && pp.mode !== (g.params as { mode?: string }).mode ? pp.mode : null, r.dur != null && node.kind === "video" ? pp.dur + "s" : null, r.ratio ? pp.ratio : null].filter(Boolean); return <>{tags.length ? <b className="btag">{tags.join(" · ")}</b> : null}{tags.length && r.text ? " · " : null}{r.text || (r.media.length ? "仅媒体输入" : "")}{pl.warnings.length ? <i className="bwarn" title={pl.warnings.join("\n")}> · {pl.warnings[0]}</i> : j?.warn ? <i className="bwarn" title={j.warn}> · {j.warn}</i> : null}</>; })()}</p>
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
function RowThumb({ src, kind }: { src: string; kind: string }) { return <ThumbImg src={src} width={28} fallback={<i><Icon name={kind === "video" ? "video" : kind === "audio" ? "audio" : "image"} size="xs" /></i>} />; }

/* ---------------- 参数弹层 ---------------- */
function paramPop(ctl: ReturnType<typeof useCtl>, node: CanvasNode, k: string, anchor: Element) {
  const store = ctl.store; const kind = node.kind as GenKind;
  const cur = () => { const n = store.node(node.id)!; return { g: genOf(n), m: store.modelOf(n) as ModelSpec | undefined }; };
  const set = (patch: Record<string, unknown>) => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, ...patch } as typeof gg.params }));
  if (k === "model") {
    const list = store.modelsOf(kind);
    const vendorOf = (x: ModelSpec) => x.vendor.trim() || "未命名供应商";
    const vendors = [...new Set(list.map(vendorOf))];
    const showModels = (vendor: string) => openPop(anchor, (close) => <ComboMenu
      autoFocus
      empty={<span>{list.filter((x) => vendorOf(x) === vendor).length ? "没有匹配的模型" : "这个供应商还没有模型"}</span>}
      header={<>
        <button className="mi" data-model-back aria-label="返回供应商列表" onClick={showProviders}><Icon name="left" size="s" /><span style={{ flex: 1 }}>{vendor}<span className="d">返回供应商列表</span></span></button>
        <div className="msep" />
      </>}
      itemAttrs={(x) => ({ "data-v": x.id })}
      itemClassName={(x) => "mi combo-item" + (x.id === cur().m?.id ? " on" : "")}
      items={list.filter((x) => vendorOf(x) === vendor)}
      label={(x) => x.name}
      onPick={(x) => { close(); store.rememberModel(kind, x.id); store.patchGen(node.id, (gg) => ({ params: clampParams(kind, gg.params, x) })); if (kind === "video") afterInputsChanged(store, node.id); }}
      renderItem={(x) => <><VendorLogo name={x.vendor} model={x.name} size={14} /><span style={{ flex: 1 }}><span style={{ display: "flex", gap: 6, alignItems: "center" }}>{x.name}{x.tags.map((t) => <span key={t} className={"tag" + (t === "NEW" ? " new" : "")}>{t}</span>)}{x.specSource === "guess" ? <span className="tag" data-spec-source="guess" title="服务商没有提供该模型的参数规格，下面的比例 / 档位 / 选项是按模型名推断的，以实际生成为准">未验证</span> : null}</span>
        {kind === "video" ? <span className="mtags">{x.res?.length && !x.tags.some((t) => t.toLowerCase() === x.res![x.res!.length - 1].toLowerCase()) ? <span className="tag">{x.res[x.res.length - 1]}</span> : null}{x.durs?.length ? <span className="tag tnum">{videoDurationTagLabel(x.durs)}</span> : null}{x.audio ? <span className="tag"><Icon name="audio" size="xs" /></span> : null}<span className="tag">{(x.modes || []).length} 种方式</span></span> : null}
        <span className="d">{x.vendor}{kind === "image" ? ` · ${x.i2i ? "最多 " + x.maxRefs + " 张参考图" : "仅文生图"}` : kind === "video" ? "" : kind === "text" ? (x.vision ? " · 能读图" : " · 只读文字") : ""}{x.specSource === "guess" ? " · 参数按名字推断" : ""}</span></span></>}
      searchPlaceholder="搜索模型"
      searchable
    />, "up", "left", "model-pop combo-pop");
    const currentModel = cur().m;
    const currentVendor = currentModel ? vendorOf(currentModel) : "";
    const showProviders = () => openPop(anchor, (close) => <ComboMenu
      autoFocus
      empty={<span>还没有配置{TYPE_LABEL[kind]}模型</span>}
      footer={ctl.host.openModelSettings ? <button className="mi" onClick={() => { close(); ctl.host.openModelSettings!(); }}><Icon name="settings" size="s" />模型设置</button> : undefined}
      header={<div className="mh">{TYPE_LABEL[kind]}模型 · 选择供应商</div>}
      itemAttrs={(vendor) => ({ "data-vendor": vendor })}
      itemClassName={(vendor) => "mi combo-item" + (vendor === currentVendor ? " on" : "")}
      items={vendors}
      label={(vendor) => vendor}
      onPick={(vendor) => showModels(vendor)}
      renderItem={(vendor) => <><VendorLogo name={vendor} size={16} /><span style={{ flex: 1 }}>{vendor}<span className="d">{list.filter((x) => vendorOf(x) === vendor).length} 个模型</span></span>{vendor === currentVendor ? null : <Icon name="right" size="s" />}</>}
      searchPlaceholder="搜索供应商"
      searchable
    />, "up", "left", "model-pop combo-pop");
    return showProviders();
  }
  const { m } = cur();
  // 没配置模型：仍把同一套控件渲染出来（灰显），顶部保留引导 + 「打开模型设置」；有模型时行为不变。
  const dis = !m;
  const mm = m || placeholderSpec(kind);
  // 参数弹层统一挂 param-pop：走「小弹层加厚底」那套磨砂玻璃（和模型菜单 / 生成态浮层一致），
  // 不挂的话会退回大面积用的 70% 薄玻璃，画布内容透上来深浅不匀
  const pop = (render: (close: () => void) => React.ReactNode, cls?: string) => openPop(anchor, (close) => <>
    {dis ? <>
      <div className="mh">{TYPE_LABEL[kind]}参数</div>
      <div className="gp-nomodel" data-nomodel><Icon name="alert" size="s" /><span>还没有可用的{TYPE_LABEL[kind]}模型：下面是可调档位（灰显），添加模型后即可修改。</span></div>
      {ctl.host.openModelSettings ? <button className="mi" data-k="open-models" onClick={() => { close(); ctl.host.openModelSettings?.(); }}><Icon name="settings" size="s" />打开模型设置</button> : null}
      <div className="msep" />
    </> : null}
    {render(close)}
  </>, "up", "left", cls ? "param-pop " + cls : "param-pop");
  if (k === "think") return pop((close) => {
    const levels = thinkLevelsFor(store.modelOf(node));
    const curThink = String((cur().g.params as TextParams).think || "");
    return <>
      <div className="mh">模型强度 · {mm.name}</div>
      {levels.map((lv) => <button key={lv} className={"mi" + (curThink === lv ? " on" : "")} data-think={lv} aria-pressed={curThink === lv} onClick={() => { close(); set({ think: lv }); }}>
        <span className="ic"><Icon name="gauge" size="s" /></span>
        <span>{thinkLevelLabel(lv)}<span className="d">{lv.toUpperCase()} · 越强越慢，推理更深</span></span>
        {curThink === lv ? <span className="k"><Icon name="check" size="s" /></span> : null}
      </button>)}
      <div className="msep" />
      <button className={"mi" + (curThink ? "" : " on")} data-think="default" aria-pressed={!curThink} onClick={() => { close(); set({ think: undefined }); }}>
        <span className="ic"><Icon name="gauge" size="s" /></span>
        <span>默认<span className="d">不指定强度，交给模型自己决定</span></span>
        {curThink ? null : <span className="k"><Icon name="check" size="s" /></span>}
      </button>
    </>;
  });
  if (k === "quality") return pop(() => {
    // 质量档来自 caps：auto 和「默认」都不发字段，合并成第一档（caps 没有 auto 时第一档叫「默认」）
    const choices = qualityChoices(store.modelOf(node));
    const labels = Object.fromEntries(choices.map((choice) => [choice.value, choice.label]));
    const curQuality = String((cur().g.params as ImageParams).quality || "");
    return <EffortSlider
      levels={choices.map((choice) => choice.value)}
      labels={labels}
      label="质量"
      hint="档位越高，画质越精细，耗时越长"
      leftLabel="更低"
      rightLabel="更高"
      recommended={null}
      showRestore={false}
      value={isQualityDefault(curQuality) ? choices[0].value : curQuality}
      onChange={(level) => set({ quality: !level || level.toLowerCase() === "auto" ? undefined : level })}
    />;
  }, "quality-pop");
  if (k === "thinking") return pop((close) => {
    const curThinking = (cur().g.params as ImageParams).thinking;
    const rows: Array<{ key: string; label: string; desc: string; value: boolean | undefined }> = [
      { key: "default", label: "默认", desc: "由模型决定，不发这个参数", value: undefined },
      { key: "on", label: "开", desc: "先想一遍再画，细节更准、更慢", value: true },
      { key: "off", label: "关", desc: "跳过思考直接出图，更快", value: false },
    ];
    return <>
      <div className="mh">先思考 · {mm.name}</div>
      {rows.map(({ key, label, desc, value }) => {
        const picked = key === "default" ? curThinking !== true && curThinking !== false : curThinking === value;
        return <button key={key} className={"mi" + (picked ? " on" : "")} data-thinking={key} aria-pressed={picked} onClick={() => { close(); set({ thinking: value }); }}>
          <span className="ic"><Icon name="brain" size="s" /></span>
          <span>{label}<span className="d">{desc}</span></span>
          {picked ? <span className="k"><Icon name="check" size="s" /></span> : null}
        </button>;
      })}
    </>;
  });
  if (k === "ratio") return pop(() => <RatioPop node={node} model={mm} disabled={dis} />);
  if (k === "mj") return pop(() => <MjPop node={node} model={mm} disabled={dis} />);
  if (k === "gifframes") return pop(() => <GifFramePop node={node} model={mm} disabled={dis} />, "gif-frame-pop");
  if (k === "count") return pop((close) => {
    const options = mm.batchUnknown ? [1] : [4, 2, 1];
    return <><div className="mh">一次生成几张</div>{options.map((c) => <button key={c} className={"mi" + ((cur().g.params as ImageParams).count === c ? " on" : "")} disabled={dis || !mm.batch?.includes(c)} onClick={() => { close(); set({ count: c }); }}>{c}×<span className="k">{!dis && mm.batch?.includes(c) ? (c > 1 ? (store.state.ui.batchMode === "stack" ? "堆叠在本节点" : "铺开成新节点") : "") : "该模型不支持"}</span></button>)}
    </>;
  });
  if (k === "vtimes") return pop((close) => <><div className="mh">一次生成几条</div>{[4, 2, 1].map((c) => <button key={c} className={"mi" + (((cur().g.params as VideoParams).times || 1) === c ? " on" : "")} disabled={dis || !(mm.times || [1]).includes(c)} onClick={() => { close(); set({ times: c }); }}>{c}×<span className="k">{!dis && (mm.times || [1]).includes(c) ? (c > 1 ? "每条单独计费" : "") : "该模型不支持"}</span></button>)}</>);
  if (k === "mode") return pop((close) => <><div className="mh">生成方式 · 会按输入自动选择</div>{(Object.keys(VMODES) as Array<keyof typeof VMODES>).map((x) => { const ok = (mm.modes || []).includes(x); return <button key={x} className={"mi" + ((cur().g.params as VideoParams).mode === x ? " on" : "")} disabled={!ok || dis} onClick={() => { close(); set({ mode: x }); }}><span style={{ flex: 1 }}>{x}<span className="d">{ok ? (x === "参考生视频" ? "最多 " + mm.maxRefs + " 张参考图" : VMODES[x].need) : mm.name + " 不支持"}</span></span><span className="k tnum">{VMODES[x].api}</span></button>; })}</>);
  if (k === "vratio") return pop(() => <VRatioPop node={node} m={mm} disabled={dis} />);
  // 视频参数是最高的一层（方式 / 分辨率 / 草稿 / 比例 / 时长 / 音频），单独放宽高度上限，别被 420 截掉
  if (k === "vset") return pop(() => <VideoSetPop node={node} m={mm} disabled={dis} />, "vset-pop");
  if (k === "vres") { const rr = resRange(mm); const vp0 = cur().g.params as VideoParams; const list = mm.res || []; return pop((close) => <>
    <div className="mh">分辨率</div>
    <OptCards cols={list.length} items={list.map((r) => ({ key: r, label: r, on: vp0.res === r && !vp0.draft, disabled: dis, pick: () => { close(); set({ res: r, draft: false }); } }))} />
    <DraftRow on={!!vp0.draft} disabled={dis} range={rr} onToggle={() => { close(); set({ draft: !vp0.draft }); }} />
  </>); }
  if (k === "dur") return pop(() => <DurPop node={node} m={mm} disabled={dis} />);
  if (k === "vgenmode") return pop((close) => <><div className="mh">生成模式</div><div className="seg wrap">{(mm.genModes || []).map((x) => <button key={x} className={(cur().g.params as VideoParams).genMode === x ? "on" : ""} disabled={dis} onClick={() => { close(); set({ genMode: x }); }}>{x}</button>)}</div></>);
  if (k === "vturbo") return pop((close) => <><div className="mh">加速（极速模式）</div><div className="seg"><button className={(cur().g.params as VideoParams).turbo ? "on" : ""} disabled={dis} onClick={() => { close(); set({ turbo: true }); }}>开</button><button className={!(cur().g.params as VideoParams).turbo ? "on" : ""} disabled={dis} onClick={() => { close(); set({ turbo: false }); }}>关</button></div></>);
  if (k === "vaudio") return pop((close) => <><div className="mh">音频</div><div className="seg"><button className={(cur().g.params as VideoParams).sound ? "on" : ""} disabled={dis} onClick={() => { close(); set({ sound: true }); }}>开</button><button className={!(cur().g.params as VideoParams).sound ? "on" : ""} disabled={dis} onClick={() => { close(); set({ sound: false }); }}>关</button></div></>);
  if (k === "akind") return pop((close) => <><div className="mh">类型</div>{(mm.kinds || []).map((x) => <button key={x} className={"mi" + ((cur().g.params as AudioParams).kind === x ? " on" : "")} disabled={dis} onClick={() => { close(); set({ kind: x }); }}>{x}</button>)}</>);
  if (k === "adur") return pop((close) => <><div className="mh">时长</div>{(mm.adurs || []).map((x) => <button key={x} className={"mi" + ((cur().g.params as AudioParams).dur === x ? " on" : "")} disabled={dis} onClick={() => { close(); set({ dur: x }); }}>{x}</button>)}</>);
  if (k === "output") return pop((close) => <><div className="mh">输出</div>{OUTPUT_MODES.map(([v, l, d]) => <button key={v} className={"mi" + (((cur().g.params as TextParams).output || "text") === v ? " on" : "")} disabled={dis} onClick={() => { close(); set({ output: v }); }}><span className="ic"><Icon name={v === "text" ? "text" : "grid"} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}</>);
}

function useNodeParams<T>(node: CanvasNode) { const n = useS((s) => s.doc.nodes.find((x) => x.id === node.id)) || node; return genOf(n).params as T; }
function useSourceBox(node: CanvasNode, kind: GenKind): SourceBox | null {
  const store = useCtl().store;
  const candidate = sourceBoxForNode(store, node, kind);
  const [measured, setMeasured] = useState<SourceBox | null>(null);
  useEffect(() => {
    if (!candidate || (candidate.w > 0 && candidate.h > 0)) { setMeasured(null); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => { if (alive && img.naturalWidth > 0 && img.naturalHeight > 0) setMeasured({ url: candidate.url, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { if (alive) setMeasured(null); };
    img.src = candidate.url;
    return () => { alive = false; img.onload = null; img.onerror = null; };
  }, [candidate?.url, candidate?.w, candidate?.h]);
  if (!candidate) return null;
  if (candidate.w > 0 && candidate.h > 0) return candidate;
  return measured && measured.url === candidate.url ? measured : null;
}

/**
 * 视频草稿模式：分辨率下面一行（不是分辨率选项，所以不占卡片位）。
 * 右侧用画布统一的胶囊开关（`.sw`：36×20 胶囊 + 16px 圆钮，开态走 --solid），
 * 和「记忆开关 / 技能启用 / 广角镜头 / 锁定比例」是同一个控件；行本身也可以点。
 */
function DraftRow({ on, disabled = false, range, onToggle }: { on: boolean; disabled?: boolean; range?: { low: string; high: string } | null; onToggle: () => void }) {
  const caption = range ? `先按 ${range.low} 出草稿，满意后再按 ${range.high} 出成片` : "该模型只有一档分辨率";
  const locked = disabled || !range;
  return <div className="draft-mode" data-p="vdraft" data-vopt="draft" data-on={on ? "" : undefined}
    data-locked={locked ? "" : undefined} title={caption} onClick={() => { if (!locked) onToggle(); }}>
    <span className="tx">
      <span className="t">草稿模式</span>
      <span className="d">{caption}</span>
    </span>
    <button type="button" className={"sw" + (on ? " on" : "")} role="switch" aria-checked={on}
      aria-label="草稿模式" disabled={locked}
      onClick={(event) => { event.stopPropagation(); onToggle(); }} />
  </div>;
}

const OUTPUT_FORMAT_TIP: Record<string, string> = { "": "PNG / JPG 单张图片", gif: "GIF 循环动画", svg: "SVG 矢量图，可任意放大" };
/** 数字输入：编辑过程只存本地草稿（不夹取、不写回），失焦 / Enter 才 clamp 写回，Esc 回退，上下箭头按 step 立即写回 */
function GifNumberRow({ dataP, label, value, min, max, step, unit, disabled, normalize, onCommit }: {
  dataP: string; label: string; value: number; min: number; max: number; step: number; unit: string; disabled?: boolean;
  normalize: (raw: unknown) => number; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string | null) => {
    setDraft(null);
    const parsed = Number(String(raw ?? "").trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onCommit(normalize(parsed));
  };
  const nudge = (delta: number) => {
    const parsed = Number(String(draft ?? value).trim());
    const base = Number.isFinite(parsed) && parsed > 0 ? parsed : value;
    setDraft(null);
    onCommit(normalize(base + delta * step));
  };
  return <div className="gif-row" data-p={dataP}>
    <span className="lbl">{label}</span>
    <span className="val">
      <input type="number" min={min} max={max} step={step} value={draft ?? String(value)} disabled={disabled} aria-label={"GIF " + label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(draft); }
          else if (e.key === "Escape") { e.preventDefault(); setDraft(null); }
          else if (e.key === "ArrowUp") { e.preventDefault(); nudge(1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); nudge(-1); }
        }} />
      <span className="unit">{unit}</span>
    </span>
  </div>;
}
/** GIF 帧参数（只有输出格式选到 GIF 时才渲染）：帧数 2–16、每帧时长 20–2000 步进 10 */
function GifFrameRows({ model, params, disabled, onPatch }: { model?: ModelSpec; params: ImageParams; disabled?: boolean; onPatch: (patch: Partial<ImageParams>) => void }) {
  const spec = gifFrameSpec(model);
  return <>
    <div className="mh">GIF 帧</div>
    <GifNumberRow dataP="gif-frame-count" label="帧数" value={gifFrameCountFor(params.frameCount, model)} min={spec.min} max={spec.max} step={1} unit={spec.min + "–" + spec.max + " 帧"} disabled={disabled}
      normalize={(raw) => gifFrameCountFor(raw, model)} onCommit={(next) => onPatch({ frameCount: next })} />
    <GifNumberRow dataP="gif-frame-duration" label="每帧时长" value={gifFrameDurationFor(params.frameDuration, model)}
      min={GIF_FRAME_FALLBACK.durationMin} max={GIF_FRAME_FALLBACK.durationMax} step={GIF_FRAME_FALLBACK.durationStep}
      unit={"ms · " + GIF_FRAME_FALLBACK.durationMin + "–" + GIF_FRAME_FALLBACK.durationMax} disabled={disabled}
      normalize={(raw) => gifFrameDurationFor(raw, model)} onCommit={(next) => onPatch({ frameDuration: next })} />
  </>;
}
/** GIF 帧参数弹层（底栏「N 帧 · Nms」打开）：参数弹层太长要滚动，帧控件单独一屏 */
function GifFramePop({ node, model, disabled }: { node: CanvasNode; model?: ModelSpec; disabled?: boolean }) {
  const store = useCtl().store; const p = useNodeParams<ImageParams>(node);
  const set = (patch: Partial<ImageParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as ImageParams), ...patch } }));
  return <GifFrameRows model={model} params={p} disabled={disabled} onPatch={set} />;
}
function RatioPop({ node, model, disabled = false }: { node: CanvasNode; model?: ModelSpec; disabled?: boolean }) {
  const ctl = useCtl(); const store = ctl.store; const p = useNodeParams<ImageParams>(node); const m = model || store.modelOf(node)!;
  const source = useSourceBox(node, "image");
  const hasSource = !!source;
  const set = (patch: Partial<ImageParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as ImageParams), ...patch } }));
  const shape = (r: string) => ratioShape(r, 20);
  const chooseRatio = (raw: string) => {
    const ratio = normRatio(raw);
    if (ratio === "自适应" && !hasSource) return;
    set({ ratio, sourceSize: ratio === "自适应" ? sourceSizeForTier(source, p.size) : "" });
  };
  const chooseSize = (size: string) => set({ size, ...(p.ratio === "自适应" && source ? { sourceSize: sourceSizeForTier(source, size) } : {}) });
  const ratios = [...new Set((m.ratios || []).map(normRatio))];
  const formats = outputFormatOptions(m);
  const format = outputFormatForRequest(p.outputFormat);
  // 透明背景和 GIF / SVG 互斥（透明只能出 PNG）：开着透明背景时不显示输出格式区块
  const transparent = p.background === "transparent";
  return <>
    <div className="mh">分辨率</div>
    <OptCards cols={(m.sizes || []).length} items={(m.sizes || []).map((s) => ({ key: s, label: s, on: p.size === s, disabled, pick: () => chooseSize(s) }))} />
    {m.nativeBackground ? <>
      <div className="mh">背景</div>
      <div className="seg" data-p="background">
        <button className={transparent ? "" : "on"} data-background="default" disabled={disabled} onClick={() => set({ background: undefined })}>默认</button>
        <button className={transparent ? "on" : ""} data-background="transparent" disabled={disabled} onClick={() => set({ background: "transparent", outputFormat: undefined })}>透明背景</button>
      </div>
    </> : null}
    <div className="mh">比例</div>
    <OptCards cols={4} items={ratios.map((r) => {
      const needSource = r === "自适应" && !hasSource;
      return { key: r, label: ratioDisplayLabel(r), shape: shape(r), on: p.ratio === r, disabled: disabled || needSource, title: needSource ? "需要有参考图或节点已有图" : undefined, pick: () => chooseRatio(r) };
    })} />
    {m.search ? <><div className="mh">联网搜索</div><div className="seg"><button className={p.search ? "on" : ""} disabled={disabled} onClick={() => set({ search: true })}>开</button><button className={!p.search ? "on" : ""} disabled={disabled} onClick={() => set({ search: false })}>关</button></div></> : null}
    {!transparent && formats.length ? <>
      <div className="mh">输出格式</div>
      <div className="seg" data-p="output-format">
        {formats.map((f) => <button key={f.value || "static"} className={format === f.value ? "on" : ""} disabled={disabled} title={OUTPUT_FORMAT_TIP[f.value]} onClick={() => f.value ? set({ outputFormat: f.value, background: undefined }) : set({ outputFormat: undefined })}>{f.label}</button>)}
      </div>
    </> : null}
    {format === "gif" ? <GifFrameRows model={m} params={p} disabled={disabled} onPatch={set} /> : null}
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
    {spec.versions.length ? <><div className="mh">版本</div><div className="seg wrap">
      <button className={!cur.version ? "on" : ""} disabled={disabled} onClick={() => set({ version: undefined })}>默认</button>
      {spec.versions.map((v) => <button key={v} data-mjv={v} className={cur.version === v ? "on" : ""} disabled={disabled} onClick={() => set({ version: v })}>{/^niji/i.test(v) ? v.replace(/^niji\s*/i, "Niji ") : "v" + v}</button>)}
    </div></> : null}
    {spec.speeds.length ? <><div className="mh">速度</div><div className="seg">{spec.speeds.map((v) => <button key={v} data-mjs={v} className={(cur.speed || "fast") === v ? "on" : ""} disabled={disabled} onClick={() => set({ speed: v })}>{MJ_SPEED_LABEL[v] || v}</button>)}</div></> : null}
    {spec.hd.length ? <><div className="mh">高清 HD</div><div className="seg">
      <button data-mjhd="on" className={cur.hd ? "on" : ""} disabled={disabled || !hdOk} onClick={() => set({ hd: true })}>开</button>
      <button className={!cur.hd ? "on" : ""} disabled={disabled} onClick={() => set({ hd: false })}>关</button>
    </div></> : null}
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
  const shape = (r: string) => ratioShape(r, 16);
  const modes = ((m.modes || []) as VideoMode[]).filter((x) => x in VMODES);
  const rr = resRange(m);
  return <div className="vset" data-vset={m.id}>
    <div className="vset-model"><span className="n">{m.name}</span>{m.specSource === "guess" ? <span className="d">参数按名字推断</span> : <span className="d">这个模型支持的参数</span>}</div>
    {modes.length ? <><div className="mh">生成方式</div><div className="seg wrap">{modes.map((x) => <button key={x} data-vopt={"mode:" + x} className={p.mode === x ? "on" : ""} disabled={disabled} title={VMODES[x].need} onClick={() => set({ mode: x })}>{x}</button>)}</div></> : null}
    {(m.res || []).length ? <>
      <div className="mh">分辨率</div>
      <OptCards cols={(m.res || []).length} items={(m.res || []).map((r) => ({ key: r, label: r, on: p.res === r && !p.draft, disabled, attrs: { "data-vopt": "res:" + r }, pick: () => set({ res: r, draft: false }) }))} />
      {rr ? <DraftRow on={!!p.draft} disabled={disabled} range={rr} onToggle={() => set({ draft: !p.draft })} /> : null}
    </> : null}
    {(m.ratios || []).length ? <>
      <div className="mh">比例</div>
      <OptCards cols={4} items={videoRatioChoices(m.ratios || []).map(({ value, label }) => ({ key: value, label, shape: shape(value), on: sameVideoRatio(p.ratio, value), disabled, attrs: { "data-vopt": "ratio:" + value }, pick: () => set({ ratio: value }) }))} />
    </> : null}
    <div className="vset-dur" data-vset-dur>
      <DurationSlider node={node} model={m} disabled={disabled} />
    </div>
    {m.audio ? <><div className="mh">生成音频</div><div className="seg"><button data-vopt="sound:on" className={p.sound ? "on" : ""} disabled={disabled} onClick={() => set({ sound: true })}>开启</button><button data-vopt="sound:off" className={!p.sound ? "on" : ""} disabled={disabled} onClick={() => set({ sound: false })}>关闭</button></div></> : null}
  </div>;
}
function DurPop({ node, m, disabled = false }: { node: CanvasNode; m: ModelSpec; disabled?: boolean }) {
  return <DurationSlider node={node} model={m} disabled={disabled} />;
}

/** 视频比例（带形状预览，与图片比例弹层一致） */
function videoRatioValue(value: string): string { return /^(auto|adaptive|自适应)$/i.test(String(value || "")) ? "adaptive" : String(value || ""); }
function videoRatioChoices(list: string[]): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const raw of list) {
    const value = videoRatioValue(raw);
    if (!value || out.some((x) => x.value === value)) continue;
    out.push({ value, label: ratioDisplayLabel(value) });
  }
  return out;
}
function sameVideoRatio(a: unknown, b: unknown): boolean { return videoRatioValue(String(a || "")) === videoRatioValue(String(b || "")); }

function VRatioPop({ node, m, disabled = false }: { node: CanvasNode; m: ModelSpec; disabled?: boolean }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  const set = (ratio: string) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), ratio: videoRatioValue(ratio) } }));
  const shape = (r: string) => ratioShape(r, 16);
  return <>
    <div className="mh">比例</div>
    <OptCards cols={4} items={videoRatioChoices(m.ratios || []).map(({ value, label }) => ({ key: value, label, shape: shape(value), on: sameVideoRatio(p.ratio, value), disabled, pick: () => set(value) }))} />
  </>;
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
const assetCmd = (): AssetCmd | null => { const c = hostRoot<{ canvas?: { command?: AssetCmd } }>()?.canvas?.command; return typeof c === "function" ? c : null; };
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
  if (!src) return <span className="dot" />;
  // 24px 圆点：缩略图 256 档足够，没必要为一行风格色块解码原图
  return <span className="dot"><ThumbImg src={src} width={24} fallback={null} /></span>;
}

function StylePeek({ src, name, top }: { src: string; name: string; top: number }) {
  // 悬停预览显示 160×160：给 160 档（缩略图 512），够清晰又不用拉原图
  return <div className="style-peek" data-style-peek={name} style={{ top }} aria-hidden="true"><ThumbImg src={src} width={160} fallback={<span />} /><span>{name}</span></div>;
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
