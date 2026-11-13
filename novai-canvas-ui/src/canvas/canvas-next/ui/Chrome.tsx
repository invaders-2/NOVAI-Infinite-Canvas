/**
 * 画布四周的浮层：左上标题、右上按钮、左侧工具栏、底部缩放条、小地图、空状态 / 回到节点、
 * 评论、抽屉（素材 / 历史）、搜索 / 模板对话框、文件面板、Agent 收起时的圆球、提示条、全屏查看。
 */
import { readMigratedKey, readMigratedSessionKey } from "../../../novaiStorage";
import { SharePanels } from "./SharePanels";
import { ShareLinkHost, shareMenu } from "./ShareSheet";
import { LanAvatarFace, LanChatHost, LanIdentity, LanNoticeHost, LanUnread, openChatEntry, openMyProfile } from "./LanChat";
import { LibrarySection } from "./Library";
import { ElementsSection } from "./Elements";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { clearOf, filterHistory, histNode, historyItems, histTime, usable, type HistFilter, type HistItem } from "../history";
import { createPortal } from "react-dom";
import type { CanvasComment, CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { renderCanvasThumb } from "../../react-canvas/exportCanvas";
import { alignSelection, deleteSelection, extractCurrentVersion, layoutSelection, title } from "../actions";
import { runNode, stopGroup } from "../engine";
import { minimapVisible } from "./minimap";
import { setPerfPref, usePerf } from "../perf";
import { download, downloadMany } from "./menus";
import { novaiName, novaiZipName } from "./downloadName";
import { stackOf, stackSelection } from "../stack";
import { groupSelection } from "./LegacyNodes";
import { groupName, groupsOf, membersOf, searchNodes, type SearchKind, type SearchScope } from "../search";
import { runKeyOf, runnableIds, runNodes, saveAsTemplate } from "./StackNode";
import { bounds, cloneParams, defaultParams, expandGroupInputs, genOf, NODE_TAG, inputsOf, isGenKind, outOf, srcOf, textOf, TYPE_ICON, TYPE_LABEL, uid, type AnyParams, type GenKind, type TextParams, type VideoMode, type VideoParams } from "../model";
import { emptyTable, withTable } from "../table";
import { ThumbImg } from "./thumb";
import { plainPrompt } from "../mentions";
import { useCtl, useS, type Ctl } from "./ctx";
import { EdgeBadge } from "./Edges";
import { AnimateIcon } from "./AnimateIcon";
import { FloatMenu, FloatMenuButton } from "./FloatMenu";
import { Icon, Logo } from "./Icon";
import { BeatAvatar } from "./BeatAvatar";
import { useOrbActivity } from "./useOrbActivity";
import { addMenu } from "./menus";
import { ModalHead, closePop, openModal, openPop } from "./overlay";
import { IS_MAC, keyHint, showKeys } from "./shortcuts";
export { showKeys };
import { computeExportBounds, exportCanvas, exportFileName, exportPixels, pickExportNodes, saveCanvasBlob, type ExportFormat, type ExportRange } from "../exportCanvas";
import { applyTheme, followsShellTheme, requestShellTheme } from "./theme";
import { clipable, createTimelineFrom } from "../playlist";
import { useAssetUrl } from "./useAsset";
import { useLbZoom } from "./lightboxZoom";
import { CommentMode } from "./comment-mode";
import { compareOriginal } from "./compareSource";
import { useMediaUrl } from "./useMedia";
import { cloneWorkflowForImport, deletePersonalTemplate, loadPersonalTemplates, parseWorkflowFile, savePersonalTemplate, workflowFileContents } from "../personalTemplates";
import { isAssetRef } from "../../canvasAssetRefs";
import { makeZip, readZip } from "../zip";
import { assetFileName, buildAssetManifest, collectMediaRefs, MANIFEST_JSON, mapWorkflowUrls, parseAssetManifest, sliceWorkflowDoc, WORKFLOW_JSON, zipEntryKey, type WorkflowAsset } from "../workflowBundle";
import { homeToDoc, loadHomeEntries, TemplatePreview, type HomeTemplate } from "./TemplatePreview";
import "./workflow-dialog.css";

export function Chrome() {
  const ctl = useCtl(); const store = ctl.store;
  const ui = useS((s) => s.ui); const name = useS((s) => s.name); const runs = useS((s) => s.runs); const nodes = useS((s) => s.doc.nodes); const view = useS((s) => s.view); const saving = useS((s) => s.saving); const peers = useS((s) => s.collab.peers);
  const [renaming, setRenaming] = useState(false);
  const zoomPct = Math.round(view.k * 100);
  const showMini = minimapVisible(ui.mini, view.k);
  return <>
    <div id="tl" className="float cap">
      <span className="logo"><img className="brand-logo" src="/static/images/logo.svg" alt="" draggable={false} /></span><span className="sep" />
      {renaming ? <input className="ttl" id="ttlIn" autoFocus defaultValue={name} onBlur={(e) => { store.set({ name: e.target.value.trim() || name }); setRenaming(false); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }} />
        : <span className="ttl" id="ttl" title="点击重命名" onClick={() => setRenaming(true)}>{name}</span>}
      <button className="ib tipB" style={{ width: 28, height: 28 }} id="canvasMenu" data-tip="切换画布 · 设置" onClick={(e) => canvasMenu(ctl, e.currentTarget, () => setRenaming(true))}><Icon name="down" size="s" /></button>
      <SaveStatus saving={saving} />
      {ctl.host.badge ? <span className="badge-preview">{ctl.host.badge}</span> : null}
    </div>
    <div id="tr" className="float">
      <button id="extBtn" className="ib tipB" data-tip="扩展" aria-label="扩展" onClick={(e) => openPop(e.currentTarget, (close) => <>
        <div className="mh">扩展</div>
        <button className="mi" data-ext="mcp" onClick={() => { close(); if (ctl.host.openMcpCenter) ctl.host.openMcpCenter(); else store.toast("MCP 中心要在桌面版里打开"); }}><Icon name="plug" size="s" />MCP 中心<span className="k">已接入的工具</span></button>
        <button className="mi" data-ext="models" onClick={() => { close(); if (ctl.host.openModelSettings) ctl.host.openModelSettings(); else store.toast("模型与 API 要在桌面版里打开"); }}><Icon name="settings" size="s" />模型与 API</button>
      </>, "down", "right")}><Icon name="plug" /></button>
      {ctl.host.features?.organization === false ? null : <button id="orgBtn" className="ib tipB" data-tip="社区 · 组织治理" aria-label="社区" onClick={() => { if (ctl.host.openApp) ctl.host.openApp("organization"); else store.toast("社区 / 组织治理要在桌面版里打开"); }}><Icon name="share" /></button>}
      <button id="usage" className="ib tipB" data-tip="本画布模型调用" onClick={(e) => { const c: Record<string, number> = { image: 0, video: 0, text: 0, audio: 0 }; runs.forEach((r) => (c[r.type] = (c[r.type] || 0) + 1)); openPop(e.currentTarget, () => <><div className="mh">本画布模型调用</div>{(["image", "video", "text", "audio"] as GenKind[]).map((k) => <div key={k} className="row"><span>{TYPE_LABEL[k]}</span><b className="tnum">{c[k]} 次</b></div>)}<div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>按模型服务商的用量计费</span></div></>, "down", "right"); }}><Icon name="bolt" /><span className="tnum">{runs.length}</span></button>
      {peers.length ? <div className="peers tipB" data-tip={`${peers.length + 1} 人在线`}>{peers.slice(0, 3).map((p, i) => <span key={p.id} className="pav">{(p.name || "协")[0]}{i === 2 && peers.length > 3 ? "+" : ""}</span>)}<span className="pav me">{ctl.host.user?.initial || "我"}</span></div> : null}
      {ctl.host.features?.share === false ? null : <AnimateIcon asChild><button id="shareBtn" className="ib tipB" data-tip="分享画布" onClick={(e) => ctl.host.openShare ? ctl.host.openShare() : shareMenu(ctl, e.currentTarget)}><Icon name="share" /></button></AnimateIcon>}
      <button id="themeBtn" className="ib tipB" data-tip={ui.theme === "light" ? "深色模式" : "浅色模式"} aria-label="切换深浅色" onClick={() => toggleCanvasTheme(ctl)}><Icon name={ui.theme === "light" ? "sun" : "moon"} /></button>
      <button id="settingsBtn" className="ib tipB" data-tip="设置" aria-label="设置" onClick={() => { let sent = false; try { if (window.parent && window.parent !== window) { window.parent.postMessage({ type: "open-settings", tab: "general" }, location.origin); sent = true; } } catch { /* 跨域父窗时退回提示 */ } if (!sent) store.toast("设置要在桌面版 / 外壳里打开"); }}><Icon name="settings" /></button>
    </div>
    <div id="lb" className="float cap">
      <AnimateIcon asChild animate><button className="ib primary tipR" id="addBtn" data-tip="添加节点" onClick={(e) => addMenu(ctl, e.currentTarget, ctl.center())}><Icon name="plus" /></button></AnimateIcon>
      <AnimateIcon asChild animation="draw"><button className="ib tipR" data-drawer="search" data-tip={"节点搜索 " + keyHint("search")} onClick={() => openSearch(ctl)}><Icon name="search" /></button></AnimateIcon>
      <button className={"ib tipR" + (ui.drawer === "assets" ? " on" : "")} data-drawer="assets" data-tip="素材库" onClick={() => store.setUI({ drawer: ui.drawer === "assets" ? null : "assets" })}><Icon name="folder" /></button>
      <button className="ib tipR" data-drawer="templates" data-tip="模板" onClick={(e) => openTemplates(ctl, e.currentTarget)}><Icon name="layout" /></button>
      <button className="ib tipR" id="sourceBrowserBtn" data-tip="在线素材" aria-label="在线素材" onClick={() => openSourceBrowser(store)}><Icon name="image" /></button>
      <AnimateIcon asChild><button className={"ib tipR" + (ui.drawer === "history" ? " on" : "")} data-drawer="history" data-tip="生成历史" onClick={() => store.setUI({ drawer: ui.drawer === "history" ? null : "history" })}><Icon name="history" /></button></AnimateIcon>
      <span className="div" />
      <button className="av tipR" id="avatar" data-tip="账户 · 点开好友与聊天，右键账户菜单" aria-label="账户与好友聊天" onClick={() => { closePop(); void openChatEntry(); }} onContextMenu={(e) => { e.preventDefault(); openPop(e.currentTarget, (close) => <><div className="mh">账户</div><LanIdentity role={ctl.host.user?.role} onOpen={() => { close(); openMyProfile(); }} /><div className="msep" /><button className="mi" onClick={() => { close(); void openChatEntry(); }}><Icon name="msg" size="s" />好友与聊天</button><button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button><button className="mi" onClick={() => { close(); showKeys(ctl.store); }}><Icon name="grid" size="s" />快捷键</button></>, "right"); }}><LanAvatarFace /><LanUnread /></button>
    </div>
    <div id="zb" className="float">
      <div className="cap">
        <button className={"ib tipT" + (showMini ? " on" : "")} id="miniBtn" data-mini-pref={ui.mini === null ? "auto" : ui.mini ? "on" : "off"} data-tip={ui.mini === null ? "小地图：跟随缩放（缩小自动浮出）" : ui.mini ? "小地图：开" : "小地图：关"} onClick={() => store.setUI({ mini: ui.mini === null ? false : ui.mini ? null : true })}><Icon name="map" /></button>
        <button className={"ib tipT" + (ui.hideEdges ? " on" : "")} id="edgeBtn" data-tip={ui.hideEdges ? "显示连线" : "隐藏连线"} onClick={() => { store.setUI({ hideEdges: !ui.hideEdges }); store.toast(!ui.hideEdges ? "已隐藏连线，输入关系仍然生效" : "已显示连线"); }}><Icon name={ui.hideEdges ? "eye" : "eyeoff"} /></button>
        <button className={"ib tipT" + (ui.snap ? " on" : "")} id="snapBtn" data-tip="网格吸附" onClick={() => { store.setUI({ snap: !ui.snap }); store.toast(!ui.snap ? "拖动节点时吸附到 20px 网格" : "已关闭网格吸附"); }}><Icon name="grid" /></button>
        <AnimateIcon asChild animation="pop"><button className="ib tipT" id="fitBtn" data-tip={"适应画布 " + keyHint("fit")} onClick={() => ctl.fitTo(store.state.doc.nodes)}><Icon name="fit" /></button></AnimateIcon>
        <button className="ib tipT" id="zoomOut" data-tip="缩小" aria-label="缩小画布" onClick={() => { const r = ctl.rect(); ctl.zoomAt(view.k / 1.2, r.left + r.width / 2, r.top + r.height / 2); }}>−</button>
        <span id="zoomV" className="tnum">{zoomPct}%</span>
        <button className="ib tipT" id="zoomIn" data-tip="放大" aria-label="放大画布" onClick={() => { const r = ctl.rect(); ctl.zoomAt(view.k * 1.2, r.left + r.width / 2, r.top + r.height / 2); }}>+</button>
      </div>
      <button className="ib cap tipT" id="help" data-tip="帮助" onClick={(e) => openPop(e.currentTarget, (close) => <><div className="mh">帮助</div><button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button><button className="mi" onClick={() => { close(); showKeys(ctl.store); }}><Icon name="grid" size="s" />快捷键<span className="k">?</span></button></>, "up")}><Icon name="help" /></button>
    </div>
    {showMini ? <Minimap /> : null}
    {ui.sel.size ? <MultiBar /> : null}
    <PinBar />
    <BatchRuns />
    {/* Agent 展开后画布区变窄，提示会压到左下工具栏上：此时不显示 */}
    {ui.agentOpen ? null : <div id="hint" className="float">{"中键 / 空格拖动平移 · 触控板双指平移 · 鼠标滚轮 / 捏合缩放 · " + (ui.leftDrag === "select" ? "拖动空白框选" : "拖动空白平移 · Shift 拖动框选") + " · 双击空白添加节点"}</div>}
    <BackToNodes />
    {!nodes.length ? <div id="empty" className="float">
      <div className="l1"><span className="kbd"><Icon name="cursor" size="s" />双击</span>画布自由生成，或从下面开始一条工作流</div>
      <div className="chips">
        {([["t2v", "video", "文字生视频"], ["bg", "image", "图片换背景"], ["i2v", "frame", "首帧生成视频"], ["table", "grid", "表格批量出图"], ["tpl", "layout", "模板"]] as const).map(([k, ic, l]) => <button key={k} data-flow={k} onClick={() => startFlow(ctl, k)}><Icon name={ic} size="s" />{l}</button>)}
      </div>
    </div> : null}
    <EdgeBadge />
    {ui.filesOpen ? <FilesPanel /> : null}
    {ui.cmtMode ? <div className="cmtbox float"><b style={{ fontSize: 13 }}>评论模式</b><span style={{ color: "var(--fg3)", fontSize: 12 }}>点击画布任意位置放置评论，Esc 退出</span></div> : null}
    <Comments />
    {ui.drawer === "assets" || ui.drawer === "history" ? <Drawer kind={ui.drawer} /> : null}
    {ctl.host.features?.share === false ? null : <SharePanels />}
    {ctl.host.features?.share === false ? null : <ShareLinkHost />}
    <LanChatHost />
    <LanNoticeHost />
    {!ui.agentOpen ? <AgentOrb /> : null}
  </>;
}

/* ---------- 右下角悬浮球：动态头像 + 收起对话时的轮播提醒 ---------- */
/* 气泡文案：口语、像在招呼你；超过 24 个字符截断加省略号（下面 clipTip） */
const ORB_TIPS = [
  "看看下一步做什么",
  "选中几张图，可以一起改风格",
  "双击空白处，直接生成",
  "试试说：给这个产品出 4 张主图",
  "把图片拖进画布，我能接住",
  "边聊边改，我看得到你选中的内容",
];
/* 关掉过就不再提示，直到这次页面重新加载。
   这里刻意不用 sessionStorage：它跨刷新还在，用户刷新一次就再也看不到提醒了（验收要求刷新后重新出现）；
   内存标记正好等于「本次页面会话」，刷新即清空。 */
let orbTipDismissed = false;
/** 进画布先安静 3s；之后 8s 换一条 */
const ORB_TIP_DELAY = 3000;
const ORB_TIP_EVERY = 8000;
const ORB_TIP_MAX = 24;

const clipTip = (text: string) => {
  const chars = Array.from(text);
  return chars.length > ORB_TIP_MAX ? chars.slice(0, ORB_TIP_MAX).join("") + "…" : text;
};

/** 悬浮球：外框尺寸由 CSS 决定（默认 40 / 触屏窄屏 48），头像跟量出来的尺寸走，不重复写媒体条件 */
function AgentOrb() {
  const ctl = useCtl(); const store = ctl.store;
  const ui = useS((s) => s.ui);
  const orb = useOrbActivity(ui.sel.size);
  const ref = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState(40);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w) setSize((current) => (current === w ? current : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [tipOn, setTipOn] = useState(() => !orbTipDismissed);
  const [tipShown, setTipShown] = useState(false);
  const [tipIndex, setTipIndex] = useState(0);
  const [tipPaused, setTipPaused] = useState(false);
  useEffect(() => {
    if (!tipOn) return;
    const timer = window.setTimeout(() => setTipShown(true), ORB_TIP_DELAY);
    return () => window.clearTimeout(timer);
  }, [tipOn]);
  /* 轮播只在「已出现 + 鼠标没停在气泡上」时走；离开后重新计一个 8s */
  useEffect(() => {
    if (!tipOn || !tipShown || tipPaused) return;
    const timer = window.setInterval(() => setTipIndex((i) => (i + 1) % ORB_TIPS.length), ORB_TIP_EVERY);
    return () => window.clearInterval(timer);
  }, [tipOn, tipShown, tipPaused]);

  const open = () => { orb.tap(); store.setUI({ agentOpen: true }); };
  const dismissTip = () => {
    setTipOn(false); setTipShown(false);
    orbTipDismissed = true;
  };
  const tipVisible = tipOn && tipShown;

  return <>
    {tipVisible ? <div id="orbTip" className="float" data-orb-tip
      onPointerEnter={() => setTipPaused(true)} onPointerLeave={() => setTipPaused(false)} onClick={open}>
      <span className="orb-tip-text" key={tipIndex}>{clipTip(ORB_TIPS[tipIndex])}</span>
      <button className="orb-tip-x" aria-label="关闭提醒" onClick={(event) => { event.stopPropagation(); dismissTip(); }}><Icon name="x" size="s" /></button>
    </div> : null}
    <button ref={ref} id="orb" className={"float" + (tipVisible ? " has-tip" : "")} aria-label="打开 Agent" title="Agent" data-orb
      onPointerEnter={() => orb.hover(true)} onPointerLeave={() => orb.hover(false)} onClick={open}>
      <BeatAvatar size={size} state={orb.state} progress={orb.progress} theme={ui.theme} />
      <span className="orb-name">Agent</span>
    </button>
  </>;
}

/* ---------- 画布菜单 / 设置 ---------- */
/** 画布保存状态（TapNow 标题旁的保存提示）：保存中 / 已保存 / 保存失败（可重试）/ 版本冲突 */
function SaveStatus({ saving }: { saving: "idle" | "saving" | "saved" | "error" | "conflict" }) {
  const store = useCtl().store; const [at, setAt] = useState(0);
  useEffect(() => { if (saving === "saved") setAt(Date.now()); }, [saving]);
  if (saving === "idle") return null;
  const tip = saving === "saved" ? `已自动保存${at ? " · " + new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}` : saving === "saving" ? "正在保存到本机画布库" : saving === "error" ? "保存失败，点击重试" : "画布在别处被修改过，已停止自动保存；刷新后载入最新版本";
  const label = saving === "saved" ? "已保存" : saving === "saving" ? "保存中…" : saving === "error" ? "保存失败 · 重试" : "版本冲突";
  return <button className={"savest tipB " + saving} id="saveStatus" data-save={saving} data-tip={tip} aria-label={tip} disabled={saving !== "error"} onClick={() => { void store.saveNow(); }}>
    <i className="dot" />{label}
  </button>;
}

/* ---------- 工作流导入 / 导出：选中节点、含资源 ZIP、拖拽导入 ---------- */
function openWorkflowPanel(ctl: Ctl) { openModal((close) => <WorkflowPanel ctl={ctl} close={close} />, "wf-panel"); }

function saveWorkflowFile(blob: Blob, file: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = file; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", m4v: "video/x-m4v", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac" };
function mimeOf(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() || "";
  return EXT_MIME[ext] || "application/octet-stream";
}

/** 媒体节点当前结果 → 字节；资源库引用先换成可取地址，取不到返回 null（调用方如实计失败） */
async function mediaBlob(store: Ctl["store"], url: string): Promise<Blob | null> {
  let target = url;
  if (isAssetRef(target)) {
    const resolved = await store.backend.resolveAsset(target);
    target = resolved && !isAssetRef(resolved) ? resolved : "";
  }
  if (!target) return null;
  const response = await fetch(target);
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(blob);
  });
}

/** 导入统一收口：克隆到视图中心、选中、可撤销，再适应视图 */
function applyImportedWorkflow(ctl: Ctl, doc: CanvasDoc): { nodes: number; edges: number } {
  const made = cloneWorkflowForImport(doc, ctl.center(), uid);
  ctl.store.addNodes(made.nodes, made.edges, { select: true, history: true });
  ctl.fitTo(made.nodes, 120, 1);
  return { nodes: made.nodes.length, edges: made.edges.length };
}

async function importWorkflowJson(ctl: Ctl, file: File): Promise<string> {
  const parsed = parseWorkflowFile(await file.text());
  const made = applyImportedWorkflow(ctl, parsed.doc);
  return "已导入 " + made.nodes + " 个节点、" + made.edges + " 条连线，图片 / 视频 / 文本 / 提示词均已保留（" + keyHint("undo") + " 可撤销）";
}

async function importWorkflowZip(ctl: Ctl, file: File): Promise<string> {
  const store = ctl.store;
  const entries = await readZip(await file.arrayBuffer());
  const byKey = new Map(entries.map((entry) => [zipEntryKey(entry.name), entry]));
  const workflow = byKey.get(zipEntryKey(WORKFLOW_JSON));
  if (!workflow) throw new Error("ZIP 里没有 " + WORKFLOW_JSON);
  const manifestEntry = byKey.get(zipEntryKey(MANIFEST_JSON));
  const manifest = manifestEntry ? parseAssetManifest(new TextDecoder().decode(manifestEntry.data)) : { schema: "", workflow: WORKFLOW_JSON, assets: [] };
  const mapping = new Map<string, string>();
  let imported = 0; let skipped = 0;
  for (const asset of manifest.assets) {
    const entry = byKey.get(zipEntryKey(asset.file));
    if (!entry) { skipped += 1; continue; }
    try {
      const dataUrl = await blobToDataUrl(new Blob([entry.data as unknown as BlobPart], { type: mimeOf(asset.file) }));
      const url = await store.backend.importAsset(store.state.canvasId, dataUrl, asset.name || "工作流资源");
      if (url) { mapping.set(asset.url, url); imported += 1; } else skipped += 1;
    } catch { skipped += 1; }
  }
  const parsed = parseWorkflowFile(new TextDecoder().decode(workflow.data));
  const made = applyImportedWorkflow(ctl, mapWorkflowUrls(parsed.doc, mapping));
  const notes = [imported ? imported + " 个资源" : "", skipped ? skipped + " 个资源缺失已跳过" : ""].filter(Boolean).join("、");
  return "已导入 " + made.nodes + " 个节点、" + made.edges + " 条连线" + (notes ? "，" + notes : "") + "（" + keyHint("undo") + " 可撤销）";
}

function WorkflowPanel({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const store = ctl.store;
  const doc = useS((s) => s.doc);
  const sel = useS((s) => s.ui.sel);
  const [busy, setBusy] = useState<"" | "assets" | "import">("");
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const slice = useMemo(() => sliceWorkflowDoc(doc, sel), [doc, sel]);
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : "未知错误";
    setNote("失败：" + message);
    store.toast("工作流操作失败：" + message, 6000);
  };
  const exportJson = () => {
    if (!slice.selected || !slice.nodeCount) { setNote("请先在画布上选中要导出的节点"); store.toast("请先选中要导出的节点"); return; }
    try {
      saveWorkflowFile(new Blob([workflowFileContents(store.state.name, slice.doc)], { type: "application/json" }), novaiName("json"));
      const text = "已导出 " + slice.nodeCount + " 个节点、" + slice.edgeCount + " 条连线";
      setNote(text); store.toast(text);
    } catch (error) { fail(error); }
  };
  const exportAssets = async () => {
    if (busy) return;
    if (!slice.selected || !slice.nodeCount) { setNote("请先在画布上选中要导出的节点"); store.toast("请先选中要导出的节点"); return; }
    setBusy("assets"); setNote("正在读取资源…");
    try {
      const files: Array<{ name: string; data: Blob | Uint8Array }> = [];
      const manifest: WorkflowAsset[] = [];
      let skipped = 0;
      for (const ref of collectMediaRefs(slice.doc)) {
        try {
          const blob = await mediaBlob(store, ref.url);
          if (!blob) { skipped += 1; continue; }
          const typed = /^[a-z]+\/([a-z0-9]+)/i.exec(blob.type)?.[1] || ref.ext;
          const ext = typed.replace("jpeg", "jpg");
          const file = assetFileName(manifest.length, ref.name, ext);
          files.push({ name: file, data: blob });
          manifest.push({ url: ref.url, file, name: ref.name, kind: ref.kind });
        } catch { skipped += 1; }
      }
      const zip = await makeZip([
        { name: WORKFLOW_JSON, data: new Blob([workflowFileContents(store.state.name, slice.doc)], { type: "application/json" }) },
        { name: MANIFEST_JSON, data: new Blob([JSON.stringify(buildAssetManifest(manifest), null, 2)], { type: "application/json" }) },
        ...files,
      ]);
      saveWorkflowFile(zip, novaiZipName());
      const text = "已导出 " + slice.nodeCount + " 个节点、" + slice.edgeCount + " 条连线、" + manifest.length + " 个资源" + (skipped ? "；" + skipped + " 个资源读取失败已跳过" : "");
      setNote(text); store.toast(text, 5200);
    } catch (error) { fail(error); }
    finally { setBusy(""); }
  };
  const importFile = async (file: File) => {
    if (busy) return;
    setBusy("import"); setNote("正在导入「" + file.name + "」…");
    try {
      const isZip = /\.zip$/i.test(file.name) || /zip/i.test(file.type || "");
      const text = isZip ? await importWorkflowZip(ctl, file) : await importWorkflowJson(ctl, file);
      setNote(text); store.toast(text, 5600); close();
    } catch (error) { fail(error); }
    finally { setBusy(""); }
  };
  const canExport = !!slice.selected && slice.nodeCount > 0;
  const status = slice.selected
    ? <>已选择 <b className="tnum">{slice.nodeCount}</b> 个节点、<b className="tnum">{slice.edgeCount}</b> 条连线</>
    : "未选择节点，请先选中要导出的组件";
  return <><ModalHead title="导入导出工作流" icon="layers" /><div className="mbd wf2">
    <p className="wf2-sub">请先选中节点再导出；导入会追加到当前画布</p>
    <section className="wf2-card" data-wf="export-card">
      <div className="wf2-card-head"><Icon name="download" size="s" /><span>导出工作流</span><span className="wf2-badge">{slice.selected ? "仅选中" : "未选择"}</span></div>
      <p className="wf2-desc">使用当前选中的节点和它们之间的连线生成工作流。</p>
      <p className="wf2-status" data-wf="status" aria-live="polite">{status}</p>
      <div className="wf2-acts">
        <button type="button" className="btn" data-wf="export-json" disabled={busy !== "" || !slice.nodeCount} onClick={exportJson}>导出 JSON</button>
        <button type="button" className="btn solid" data-wf="export-assets" aria-busy={busy === "assets"} disabled={busy !== "" || !slice.nodeCount} onClick={() => void exportAssets()}>{busy === "assets" ? "正在打包…" : "导出并包含资源"}</button>
      </div>
    </section>
    <section className="wf2-card" data-wf="import-card">
      <div className="wf2-card-head"><Icon name="upload" size="s" /><span>导入工作流</span><span className="wf2-badge">{busy === "import" ? "正在导入" : "JSON / ZIP"}</span></div>
      <p className="wf2-desc">支持工作流 JSON，也支持包含资源的 ZIP 包。导入内容会追加到当前画布。</p>
      <button type="button" className={"wf2-drop" + (drag ? " on" : "")} data-wf="import-drop" aria-busy={busy === "import"} disabled={busy !== ""}
        onClick={() => fileRef.current?.click()}
        onDragOver={(event) => { if (busy) return; event.preventDefault(); if (!drag) setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(event) => { event.preventDefault(); setDrag(false); if (busy) return; const file = event.dataTransfer?.files?.[0]; if (file) void importFile(file); }}>
        <Icon name="upload" size="s" />
        <span className="wf2-drop-t">拖入 JSON / ZIP 工作流</span>
        <span className="wf2-drop-s">或点击选择文件</span>
      </button>
      <input ref={fileRef} type="file" accept=".json,.zip,application/json,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
    </section>
    {note ? <p className="wf2-note" data-wf="result">{note}</p> : null}
  </div></>;
}

function canvasMenu(ctl: Ctl, anchor: Element, rename: () => void) {
  openPop(anchor, (close) => <>
    {ctl.host.backToList ? <button className="mi" onClick={() => { close(); ctl.host.backToList!(); }}><Icon name="back" size="s" />返回画布列表</button> : null}
    {ctl.host.createCanvas ? <button className="mi" data-menu="new-canvas" onClick={() => { close(); void Promise.resolve().then(() => ctl.host.createCanvas!()).catch((error) => ctl.store.toast("新建画布失败：" + (error instanceof Error ? error.message : "未知错误"), 5000)); }}><Icon name="plus" size="s" /><span style={{ flex: 1 }}>新建画布</span></button> : null}
    <button className="mi" onClick={() => { close(); rename(); }}><Icon name="pencil" size="s" />重命名</button>
    <button className="mi" data-menu="export-workflow" disabled={!ctl.store.state.doc.nodes.length} onClick={() => { close(); openWorkflowPanel(ctl); }}><Icon name="download" size="s" /><span style={{ flex: 1 }}>导出工作流</span><span className="k">JSON / ZIP</span></button>
    <button className="mi" data-menu="import-workflow" onClick={() => { close(); openWorkflowPanel(ctl); }}><Icon name="upload" size="s" /><span style={{ flex: 1 }}>导入工作流</span><span className="k">JSON / ZIP</span></button>
    <AnimateIcon asChild><button className="mi" data-menu="download-canvas" onClick={() => { close(); openDownloadCanvas(ctl); }}><Icon name="download" size="s" /><span style={{ flex: 1 }}>下载画布</span><span className="k">PNG / JPEG</span></button></AnimateIcon>
    <button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button>
    <CanvasList ctl={ctl} close={close} />
  </>);
}
function CanvasList({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const [list, setList] = useState<Array<{ id: string; name: string; nodes?: number }> | null>(null);
  useEffect(() => { void ctl.host.listCanvases?.().then(setList).catch(() => setList([])); }, [ctl]);
  if (!ctl.host.listCanvases) return null;
  return <><div className="msep" /><div className="mh">切换画布</div>{(list || []).map((c) => <button key={c.id} className={"mi" + (c.id === ctl.store.state.canvasId ? " on" : "")} onClick={() => { close(); if (c.id !== ctl.store.state.canvasId) ctl.host.openCanvas?.(c.id); }}><Icon name="layers" size="s" /><span>{c.name}</span></button>)}{!list ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>读取中…</span></div> : null}</>;
}
function canvasSettings(ctl: Ctl) {
  const store = ctl.store;
  openModal(() => <Settings ctl={ctl} />, "cset");
  void store;
}

/* ---------- 下载画布（整画布导出，见 ../exportCanvas.ts） ---------- */
function openDownloadCanvas(ctl: Ctl) { openModal((close) => <DownloadCanvas ctl={ctl} close={close} />, "download"); }
function DownloadCanvas({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const store = ctl.store;
  const doc = useS((s) => s.doc); const sel = useS((s) => s.ui.sel);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [scale, setScale] = useState(1);
  const [range, setRange] = useState<ExportRange>(sel.size ? "selection" : "all");
  const [busy, setBusy] = useState(false);
  const picked = pickExportNodes(doc, { range, selectedIds: sel });
  const bounds = computeExportBounds(picked.nodes);
  const pixels = bounds ? exportPixels(bounds, scale) : { width: 0, height: 0, scale: 1 };
  const filename = exportFileName(store.state.name || "画布", { format, scale: pixels.scale, range: picked.range });
  const run = async () => {
    if (busy || !picked.nodes.length) return;
    setBusy(true);
    try {
      store.toast("正在导出画布…", 1800);
      const result = await exportCanvas(store, { format, scale, range });
      const saved = await saveCanvasBlob(result.blob, result.filename);
      if (saved.ok === true) {
        // 主进程真把文件写进下载目录了才报成功；路径按 ~ 开头显示
        store.toast(`已保存到 ${saved.display}（${result.width}×${result.height}，${Math.round((saved.bytes || result.blob.size) / 1024)} KB）`, 6000);
        close();
      } else {
        store.toast(`保存失败：${saved.detail || saved.error || "未知错误"}`, 6000);
      }
    } catch (err) {
      store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 4000);
    } finally { setBusy(false); }
  };
  return <><ModalHead title="下载画布" icon="download" /><div className="mbd">
    <div className="sec"><span>范围</span></div>
    <div className="seg">
      <button className={range === "all" ? "on" : ""} data-dl-range="all" onClick={() => setRange("all")}>全部节点（{doc.nodes.length}）</button>
      <button className={range === "selection" ? "on" : ""} data-dl-range="selection" disabled={!sel.size} onClick={() => setRange("selection")}>选中（{sel.size}）</button>
    </div>
    <div className="sec"><span>格式</span></div>
    <div className="seg">
      <button className={format === "png" ? "on" : ""} data-dl-format="png" onClick={() => setFormat("png")}>PNG</button>
      <button className={format === "jpeg" ? "on" : ""} data-dl-format="jpeg" onClick={() => setFormat("jpeg")}>JPEG</button>
    </div>
    <div className="sec"><span>倍率</span></div>
    <div className="seg">
      <button className={scale === 1 ? "on" : ""} data-dl-scale="1" onClick={() => setScale(1)}>1x</button>
      <button className={scale === 2 ? "on" : ""} data-dl-scale="2" onClick={() => setScale(2)}>2x</button>
    </div>
    <p style={{ color: "var(--fg3)", fontSize: 12, margin: "12px 0 0" }} data-dl-summary>输出 {pixels.width}×{pixels.height} 像素 · {picked.nodes.length} 个节点 · 「{filename}」</p>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
      <button className="btn" onClick={close}>取消</button>
      <button className="btn solid" data-dl-run disabled={busy || !picked.nodes.length} onClick={() => void run()}>{busy ? "正在导出…" : "下载"}</button>
    </div>
  </div></>;
}
/**
 * 画布设置：和系统设置同一套写法——小标题 + 分组卡片；每行左边是名称和一句说明，右边是胶囊分段控件或开关。
 */
function Settings({ ctl }: { ctl: Ctl }) {
  const ui = useS((s) => s.ui); const models = useS((s) => s.models); const doc = useS((s) => s.doc); const saving = useS((s) => s.saving); const version = useS((s) => s.version); const store = ctl.store;
  const perf = usePerf();
  const followShell = followsShellTheme();
  const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } };
  const seg = <K extends string>(key: string, opts: ReadonlyArray<readonly [K, string]>, cur: K, pick: (k: K) => void) =>
    <div className="cset-seg" role="radiogroup" data-setting={key}>{opts.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={cur === k} data-v={k} className={cur === k ? "on" : ""} onClick={() => pick(k)}>{l}</button>)}</div>;
  const sw = (key: string, on: boolean, label: string, set: (v: boolean) => void) =>
    <button type="button" className="cset-sw" role="switch" aria-checked={on} aria-label={label} data-setting={key} onClick={() => set(!on)} />;
  const row = (label: string, cap: ReactNode, control: ReactNode, key?: string) =>
    <div className="cset-row" key={key}><div className="cset-lab"><span>{label}</span>{cap ? <small>{cap}</small> : null}</div>{control}</div>;
  const saveText = saving === "saving" ? "保存中…" : saving === "error" ? "保存失败" : saving === "conflict" ? "版本冲突" : "已自动保存";
  return <><ModalHead title="画布设置" icon="settings" /><div className="mbd cset-body">
    <section className="cset-sec"><h3>常规</h3><div className="cset-group">
      {row("主题", followShell ? "跟随软件主题" : null, followShell
        ? seg("theme", [["dark", "深色"], ["light", "浅色"]] as const, ui.theme, (k) => { requestShellTheme(k); applyTheme(store); })
        : seg("theme", [["dark", "深色"], ["light", "浅色"], ["system", "跟随系统"]] as const, ui.themePref, (k) => { store.setUI({ themePref: k }); save("novai-canvas-theme", k); applyTheme(store); }))}
      {row("左键拖动空白处", ui.leftDrag === "select" ? "中键 / 空格拖动平移画布，触控板双指平移，滚轮 / 捏合缩放" : "按住 Shift 拖动框选", seg("leftdrag", [["select", "框选"], ["pan", "平移"]] as const, ui.leftDrag, (k) => { store.setUI({ leftDrag: k }); save("novai-canvas-leftdrag", k); }))}
      {row("批量结果", ui.batchMode === "stack" ? "2× / 4× 结果叠在一个节点里" : "2× / 4× 结果铺成多个节点", seg("batch", [["stack", "堆叠"], ["spread", "铺开"]] as const, ui.batchMode, (k) => { store.setUI({ batchMode: k }); store.toast(k === "stack" ? "批量结果会堆叠，用 ‹ › 切换" : "批量结果会铺开成多个节点"); }))}
    </div></section>
    <section className="cset-sec"><h3>拖动与显示</h3><div className="cset-group">
      {row("对齐参考线", "按住 Alt 临时关闭", sw("guides", ui.guides, "对齐参考线", (v) => store.setUI({ guides: v })))}
      {row("网格吸附", null, sw("snap", ui.snap, "网格吸附", (v) => store.setUI({ snap: v })))}
      {row("显示连线", null, sw("edges", !ui.hideEdges, "显示连线", (v) => store.setUI({ hideEdges: !v })))}
      {row("小地图", null, seg("mini", [["auto", "自动"], ["on", "显示"], ["off", "隐藏"]] as const, ui.mini == null ? "auto" : ui.mini ? "on" : "off", (k) => store.setUI({ mini: k === "auto" ? null : k === "on" })))}
      {row("性能模式", perf.pref === "auto" ? (perf.mode === "low" ? "机器跑不动，已自动降到流畅优先" : "按帧率自动判断") : perf.mode === "low" ? "降低模糊与动效，换帧率" : "完整磨砂与动效", seg("perf", [["low", "流畅优先"], ["high", "画质优先"], ["auto", "自动"]] as const, perf.pref, (k) => setPerfPref(k)))}
    </div></section>
    <DefaultModelsPanel ctl={ctl} />
    <p className="cset-foot tnum">{doc.nodes.length} 个节点 · {doc.edges.length} 条连线 · {saveText}{version != null ? ` · 版本 ${version}` : ""} · 可用模型 {models.length} 个</p>
  </div></>;
}
/* ---------- 画布设置：默认模型 / 优化提示词模型 ---------- */
const MODEL_PICK_KINDS: GenKind[] = ["image", "video", "text", "audio"];

/**
 * 设置页的模型选择必须就地展开一层列表：openPop 的 #pop z-index 低于 .modal-bg，弹出会被弹窗压住。
 * localStorage 写入不触发 store 订阅，所以选完自己 bump 一次重渲染。
 */
function DefaultModelsPanel({ ctl }: { ctl: Ctl }) {
  const store = ctl.store;
  const models = useS((s) => s.models);
  const [open, setOpen] = useState<GenKind | "opt" | null>(null);
  const [, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const toggle = (k: GenKind | "opt") => setOpen((cur) => (cur === k ? null : k));
  const textModels = models.filter((m) => m.kind === "text");
  const optModel = store.optimizeModel();
  const optLabel = optModel ? optModel.name : textModels.length ? `自动（文本默认：${store.defaultModel("text")?.name || ""}）` : "自动（还没有文本模型）";

  /** 「自动」这一项：没显式选过（或存的 id 已失效）时它才是当前值，选中即把存过的 id 清掉 */
  const autoItem = (on: boolean, attr: Record<string, string>, hint: string, pick: () => void) =>
    <button type="button" className={"cset-opt" + (on ? " on" : "")} {...attr} aria-pressed={on} onClick={pick}>
      <span className="nm">自动<small> · {hint}</small></span>{on ? <span className="ck"><Icon name="check" size="xs" /></span> : null}
    </button>;

  const modelOpts = (kind: GenKind) => {
    const list = models.filter((m) => m.kind === kind);
    const stored = store.defaultModelId(kind);
    // 存过的 id 已经不在当前清单里时不算显式选择（存储不删）：按实际生效的「自动」标当前
    const valid = list.some((m) => m.id === stored) ? stored : "";
    const pick = (id: string) => { store.rememberModel(kind, id); setOpen(null); refresh(); };
    return <div className="cset-opts" data-model-opts={kind}>
      {autoItem(!valid, { "data-model-auto": kind }, "用列表里第一个可用模型", () => pick(""))}
      {list.length ? list.map((m) => <button type="button" key={m.id} className={"cset-opt" + (valid === m.id ? " on" : "")} data-model-opt={m.id} aria-pressed={valid === m.id} onClick={() => pick(m.id)}>
        <span className="nm">{m.name}<small> · {m.vendor || "未命名供应商"}{kind === "text" && m.vision ? " · 能读图" : ""}</small></span>
        {valid === m.id ? <span className="ck"><Icon name="check" size="xs" /></span> : null}
      </button>) : <div className="cset-opt-empty">还没有配置「{TYPE_LABEL[kind]}」模型</div>}
      {ctl.host.openModelSettings ? <button type="button" className="cset-opt more" data-model-settings onClick={() => { setOpen(null); ctl.host.openModelSettings?.(); }}><Icon name="settings" size="s" /><span className="nm">打开模型设置</span></button> : null}
    </div>;
  };

  const optimizeOpts = () => {
    const pick = (id: string) => { store.rememberOptimizeModel(id); setOpen(null); refresh(); };
    return <div className="cset-opts" data-opt-opts>
      {autoItem(!optModel, { "data-opt-auto": "1" }, "用文本默认模型", () => pick(""))}
      {textModels.length ? textModels.map((m) => <button type="button" key={m.id} className={"cset-opt" + (optModel?.id === m.id ? " on" : "")} data-opt-opt={m.id} aria-pressed={optModel?.id === m.id} onClick={() => pick(m.id)}>
        <span className="nm">{m.name}<small> · {m.vendor || "未命名供应商"}{m.vision ? " · 能读图" : ""}</small></span>
        {optModel?.id === m.id ? <span className="ck"><Icon name="check" size="xs" /></span> : null}
      </button>) : <div className="cset-opt-empty">还没有配置「文本」模型</div>}
    </div>;
  };

  return <section className="cset-sec"><h3>新节点默认模型</h3>
    <div className="cset-group">
      <div className="cset-grid">
        {MODEL_PICK_KINDS.map((kind) => {
          const list = models.filter((m) => m.kind === kind);
          const explicit = store.defaultModelId(kind);
          const shown = list.find((m) => m.id === explicit) || list[0];
          return <button type="button" key={kind} className={"cset-cell" + (open === kind ? " open" : "")} data-model-pick={kind} aria-expanded={open === kind} aria-label={`${TYPE_LABEL[kind]}默认模型：${shown?.name || "未配置"}`} onClick={() => toggle(kind)}>
            <span>{TYPE_LABEL[kind]}</span>
            <span className={"cset-val" + (shown ? "" : " muted")}><span className="nm">{shown?.name || "未配置"}</span><Icon name="down" size="xs" /></span>
          </button>;
        })}
      </div>
      {open && open !== "opt" ? modelOpts(open) : null}
    </div>
    <div className="cset-group">
      <div className="cset-row">
        <div className="cset-lab"><span>优化提示词</span><small>点节点上的「优化提示词」时，用哪个文本模型改写</small></div>
        <button type="button" className={"cset-pick" + (textModels.length ? "" : " muted")} data-opt-pick aria-expanded={open === "opt"} onClick={() => toggle("opt")}>
          <span className="nm">{optLabel}</span><Icon name="down" size="xs" />
        </button>
      </div>
      {open === "opt" ? optimizeOpts() : null}
    </div>
  </section>;
}
function connectAgentPop(ctl: Ctl, anchor: Element) {
  const addr = "novai://canvas/" + ctl.store.state.canvasId;
  openPop(anchor, (close) => <>
    <div className="mh">在 Agent 中打开这张画布</div>
    <button className="mi" onClick={() => { close(); ctl.store.setUI({ agentOpen: true }); }}><span className="ic"><Logo /></span><span>NOVAI 助手<span className="d">右侧面板，可直接改画布</span></span></button>
    <div className="msep" /><div className="row" style={{ font: "12px var(--mono)", color: "var(--fg2)" }}><span>{addr}</span><button className="btn" style={{ height: 26 }} onClick={async () => { try { await navigator.clipboard.writeText(addr); ctl.store.toast("已复制连接地址"); } catch { ctl.store.toast("复制失败，请手动选中地址"); } }}>复制</button></div>
  </>, "down", "right");
}
/**
 * 右上角那颗太阳 / 月亮：直接在当前深浅色之间切，不弹菜单。
 * NOVAI 宿主里画布没有自己的偏好，切的是软件主题（写存储 + 通知外壳）。
 */
function toggleCanvasTheme(ctl: Ctl) {
  const store = ctl.store;
  const next = store.state.ui.theme === "light" ? "dark" : "light";
  if (followsShellTheme()) { requestShellTheme(next); applyTheme(store); return; }
  store.setUI({ themePref: next }); try { localStorage.setItem("novai-canvas-theme", next); } catch { /* 无存储时只影响本次渲染 */ } applyTheme(store);
}
export function toggleCmt(ctl: Ctl) { const on = !ctl.store.state.ui.cmtMode; ctl.store.setUI({ cmtMode: on }); if (on) ctl.store.toast("点击画布放置评论"); }

/**
 * 左栏「在线素材」：面板沿用旧版智能画布那套 source-browser.js（DOM / 样式在 static/canvas.html 与
 * static/css/source-browser.css，桌面端把原生 WebContentsView 叠在占位锚点上）。
 */
export function openSourceBrowser(store: Ctl["store"]) {
  const api = (window as unknown as { __novaSourceBrowser?: { toggle?: () => void; isOpen?: () => boolean } }).__novaSourceBrowser;
  if (!api || typeof api.toggle !== "function") {
    store.toast("网页版不支持内置浏览器，请使用桌面客户端，或直接把图片从浏览器拖进画布", 4200);
    return;
  }
  // 在线素材是左侧大面板：跟素材 / 历史抽屉同时开会互相压，打开它先收起抽屉
  if (typeof api.isOpen === "function" && !api.isOpen() && store.state.ui.drawer) store.setUI({ drawer: null });
  api.toggle();
}

/* ---------- 搜索 / 模板 / 预置工作流 ---------- */
export function openSearch(ctl: Ctl) { openModal((close) => <SearchModal ctl={ctl} close={close} />, "search"); }
function SearchModal({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const [q, setQ] = useState(""); const [f, setF] = useState<SearchKind>("all"); const [scope, setScope] = useState<SearchScope>("world"); const doc = useS((s) => s.doc);
  const groups = groupsOf(doc); const sc = scope !== "world" && !groups.some((g) => g.id === scope) ? "world" : scope;
  const list = searchNodes(doc, { q, kind: f, scope: sc });
  // ↑↓ 选结果，↵ 打开；条件一变回到第一条
  const [hi, setHi] = useState(0); const cur = Math.min(hi, Math.max(0, list.length - 1));
  useEffect(() => setHi(0), [q, f, sc]);
  useEffect(() => { document.querySelector(`#modal .hrow[data-i="${cur}"]`)?.scrollIntoView({ block: "nearest" }); }, [cur]);
  // 堆叠里收起的节点：定位到所在堆叠
  const go = (n: CanvasNode) => { close(); const s = n.kind === "group" ? null : stackOf(doc, n.id); ctl.focusNode(s ? s.id : n.id); if (s) ctl.store.toast(`「${title(n)}」在堆叠里，双击堆叠展开`); };
  return <>
    <div className="sinput"><Icon name="search" /><input id="sq" autoFocus placeholder={sc === "world" ? "搜索整张画布..." : "在分组里搜索..."} value={q} onChange={(e) => setQ(e.target.value)} data-esc-clear onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (list.length) setHi((cur + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length); }
      else if (e.key === "Enter" && list[cur]) go(list[cur]);
      else if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); }
    }} /><button className="ib" onClick={close}><Icon name="x" /></button></div>
    {groups.length ? <div className="tabs sscope" data-search-scope={sc}><button data-scope="world" className={sc === "world" ? "on" : ""} onClick={() => setScope("world")}><Icon name="map" size="xs" />整张画布</button>{groups.map((g) => <button key={g.id} data-scope={g.id} className={sc === g.id ? "on" : ""} onClick={() => setScope(g.id)}><Icon name="layers" size="xs" />{groupName(g)}<span className="tnum">{membersOf(doc, g.id).size}</span></button>)}</div> : null}
    <div className="tabs">{([["all", "全部"], ["image", "图片"], ["video", "视频"], ["text", "文本"], ["audio", "音频"], ["table", "表格"], ["group", "分组"]] as const).map(([k, l]) => <button key={k} data-kind={k} className={f === k ? "on" : ""} onClick={() => setF(k)}>{l}</button>)}</div>
    <div className="dbody" style={{ maxHeight: 360, padding: "0 12px 12px" }}>
      {list.length ? list.map((n, i) => <NodeRow key={n.id} n={n} i={i} on={i === cur} onHover={() => setHi(i)} onClick={() => go(n)} sub={n.kind === "group" ? `${membersOf(doc, n.id).size} 个节点` : isGenKind(n.kind) ? (textOf(n) || plainPrompt(genOf(n).prompt, doc) || TYPE_LABEL[n.kind]).slice(0, 60) : "多维表格"} extra={stackOf(doc, n.id) ? "在堆叠里" : inputsOf(doc, n.id).length ? inputsOf(doc, n.id).length + " 个输入" : ""} />) : <div style={{ minHeight: 240, display: "grid", placeItems: "center", color: "var(--fg3)" }}>{q ? "没有匹配的节点" : sc === "world" ? "画布上还没有这类节点" : "这个分组里没有这类节点"}</div>}
    </div>
  </>;
}
function NodeRow({ n, sub, extra, onClick, i, on, onHover }: { n: CanvasNode; sub: string; extra?: string; onClick: () => void; i?: number; on?: boolean; onHover?: () => void }) {
  const src = srcOf(n);
  // 和生成历史行同一个 42px 格子：搜索面板一次列几十个节点，挂原图就是几十张大图一起解码
  return <div className={"hrow" + (on ? " on" : "")} data-focus={n.id} data-i={i} onClick={onClick} onMouseMove={onHover}><span className="th">{src ? <ThumbImg src={src} width={42} fallback={<Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" />} /> : <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" />}</span><span className="m"><b>{title(n)}</b><small>{sub}</small></span>{extra ? <span style={{ color: "var(--fg3)", fontSize: 11.5 }}>{extra}</span> : null}</div>;
}
const TEMPLATES = [
  { id: "ecom", name: "电商卖点套图", desc: "产品图 + 产品信息 → 卖点拆解 → 3 张海报" },
  { id: "i2v", name: "首帧生成视频", desc: "一张图作为首帧，写镜头描述出短片" },
  { id: "bg", name: "图片换背景", desc: "上传产品图，描述新背景" },
  { id: "table", name: "多维表格批量出图", desc: "文本 → 多维表格 → 逐行批量生成图片" },
  { id: "story", name: "分镜表到视频", desc: "一句创意 → 分镜表 → 逐镜头生成视频" },
] as const;

/* ---------- 模板面板（对齐 TapNow E12：贴左侧工具栏的浮层 + 公共/我的 + 搜索 + 3 列封面卡） ---------- */
/** 公共模板只展示内置模板与个人模板；带 doc 的模板一次铺全部节点与连线。 */
type TplNode = {
  id: string; kind: "text" | "image" | "video" | "audio" | "table";
  x: number; y: number; w: number; h: number;
  title: string; text: string; prompt: string;
  params?: { output?: TextParams["output"]; ratio?: string; count?: number; dur?: number; mode?: VideoMode };
  table?: { title?: string; columns?: string[]; rows?: string[][] } | null;
  /** 模板里已生成结果的封面（读取时从 doc 推导/保存时带上） */
  cover?: string;
};
type TplDoc = { nodes: TplNode[]; edges: Array<{ id: string; from: string; to: string }> };
type TplEntry = {
  id: string; name: string; summary: string;
  /** 原始标签：只参与搜索匹配 */
  tags: string[];
  /** 卡片上显示的标签：去掉与类型重复的词，最多 2 个 */
  chips: string[];
  /** 分类 id（对应市场清单 categories）；显示时换成中文名，拿不到就不显示 */
  category: string;
  /** 模板步骤：大预览里列出 title/detail */
  steps: Array<{ title: string; detail: string }>;
  /** doc 的节点/连线数：卡片角标与大预览直接用，避免每张卡重复算 */
  nodes: number; edges: number;
  /** 上架时间（毫秒）；详情里按 ISO 截到日显示 */
  publishedAt: number;
  /** 内置模板：没有 doc，走 startFlow 的预置工作流 */
  flow?: string;
  doc?: TplDoc | null;
  prompt?: string; nodeTitle?: string; kind?: string;
  personal?: boolean; cover?: string;
  /** 公共模板来自首页（web/src/pages/home/templates.js）：保留原始定义给预览/应用用 */
  home?: HomeTemplate;
};
function personalEntry(item: { id: string; title: string; prompt: string; updatedAt: number; doc: unknown; cover?: string; coverDataUrl?: string }): TplEntry | null {
  const doc = asTplDoc(item.doc);
  if (!doc) return null;
  const cover = item.cover || item.coverDataUrl || doc.nodes.find((n) => n.cover)?.cover || "";
  return { id: item.id, name: item.title, summary: item.prompt, tags: ["我的模板"], chips: [], category: "personal", steps: [], publishedAt: item.updatedAt, nodes: doc.nodes.length, edges: doc.edges.length, doc, personal: true, ...(cover ? { cover } : {}) };
}
const TPL_NODE_KINDS = ["text", "image", "video", "audio", "table"];
/** 卡片标签里没区分度的词：分类名 + 类型名（「模板」每条都有，挂上只是噪音） */
const TPL_KIND_LABEL: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频", table: "表格" };
const TPL_TAG_NOISE = new Set(["模板"]);
/** 缩略图只渲染一次（按主题分开缓存）：面板反复打开不重画 */
const TPL_THUMBS = new Map<string, string>();
const tplNum = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

/** doc 来自 IPC，形状自己再验一遍：坏条目跳过，不让异常冒进 React */
function asTplDoc(value: unknown): TplDoc | null {
  const box = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!box || !Array.isArray(box.nodes)) return null;
  const nodes: TplNode[] = [];
  for (const raw of box.nodes) {
    const n = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const id = n && typeof n.id === "string" ? n.id.trim() : "";
    const kind = n ? String(n.kind || "") : "";
    if (!n || !id || !TPL_NODE_KINDS.includes(kind)) continue;
    nodes.push({
      id, kind: kind as TplNode["kind"],
      x: Math.round(tplNum(n.x, 0)), y: Math.round(tplNum(n.y, 0)),
      w: Math.max(40, Math.round(tplNum(n.w, 260))), h: Math.max(40, Math.round(tplNum(n.h, 220))),
      title: typeof n.title === "string" ? n.title : "",
      text: typeof n.text === "string" ? n.text : "",
      prompt: typeof n.prompt === "string" ? n.prompt : "",
      params: n.params && typeof n.params === "object" ? (n.params as TplNode["params"]) : undefined,
      table: n.table && typeof n.table === "object" ? (n.table as TplNode["table"]) : null,
      ...(typeof n.cover === "string" && n.cover ? { cover: n.cover } : {}),
    });
  }
  if (!nodes.length) return null;
  const known = new Set(nodes.map((n) => n.id));
  const rawEdges = Array.isArray(box.edges) ? box.edges : Array.isArray(box.connections) ? box.connections : [];
  const edges = rawEdges.flatMap((raw) => {
    const e = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const from = e && typeof e.from === "string" ? e.from : "";
    const to = e && typeof e.to === "string" ? e.to : "";
    if (!known.has(from) || !known.has(to) || from === to) return [];
    return [{ id: e && typeof e.id === "string" ? e.id : from + ">" + to, from, to }];
  });
  return { nodes, edges };
}

function toTplEntry(raw: unknown): TplEntry[] {
  const t = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const id = t && typeof t.id === "string" ? t.id.trim() : "";
  const name = t && typeof t.name === "string" ? t.name.trim() : "";
  if (!t || !id || !name) return [];
  const kind = typeof t.kind === "string" ? t.kind : "";
  const tags = Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string").slice(0, 6) : [];
  const noise = new Set([...TPL_TAG_NOISE, TPL_KIND_LABEL[kind] || ""]);
  const chips = [...new Set(tags)].filter((tag) => !noise.has(tag)).slice(0, 2);
  const doc = asTplDoc(t.doc);
  const steps = (Array.isArray(t.steps) ? t.steps : []).slice(0, 12).flatMap((raw) => {
    const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const st = s && typeof s.title === "string" ? s.title.trim() : "";
    const sd = s && typeof s.detail === "string" ? s.detail.trim() : "";
    return st || sd ? [{ title: st || sd, detail: st ? sd : "" }] : [];
  });
  return [{
    id, name,
    summary: typeof t.summary === "string" ? t.summary : "",
    tags, chips,
    category: typeof t.category === "string" ? t.category : "",
    steps,
    publishedAt: tplNum(t.publishedAt, 0),
    nodes: doc ? doc.nodes.length : 0,
    edges: doc ? doc.edges.length : 0,
    doc,
    prompt: typeof t.prompt === "string" ? t.prompt : "",
    nodeTitle: typeof t.nodeTitle === "string" ? t.nodeTitle : "",
    kind,
  }];
}

/** 公共模板与首页同源：直接读 web/src/pages/home/templates.js（该文件读失败时返回空列表，不拖垮画布） */
async function loadMarketTemplates(): Promise<{ list: TplEntry[]; cats: Record<string, string>; error: string }> {
  const home = await loadHomeEntries();
  return { list: home.entries, cats: home.cats, error: home.error };
}

/** 按 doc 一次建全部节点与连线：尺寸/相对位置取自 doc，整体居中到当前视口 */
function createFromTemplate(ctl: Ctl, tpl: TplEntry): { nodes: number; edges: number } {
  const store = ctl.store; const doc = tpl.doc!;
  const minX = Math.min(...doc.nodes.map((n) => n.x)), maxX = Math.max(...doc.nodes.map((n) => n.x + n.w));
  const minY = Math.min(...doc.nodes.map((n) => n.y)), maxY = Math.max(...doc.nodes.map((n) => n.y + n.h));
  const c = ctl.center(); const ox = Math.round(c.x - (minX + maxX) / 2), oy = Math.round(c.y - (minY + maxY) / 2);
  const idOf = new Map<string, string>();
  for (const n of doc.nodes) idOf.set(n.id, uid("n"));
  const made: CanvasNode[] = [];
  for (const n of doc.nodes) {
    const id = idOf.get(n.id)!; const x = n.x + ox, y = n.y + oy; const title = n.title || tpl.nodeTitle || tpl.name;
    if (n.kind === "table") {
      // 上游文本节点：重新出表时更新同一张表（见 table.ts 的 sourceId）
      const up = doc.edges.filter((e) => e.to === n.id).map((e) => n.kind && doc.nodes.find((src) => src.id === e.from)).find((src) => src && src.kind === "text");
      const base = emptyTable();
      const t = { ...base, title: (n.table && n.table.title) || title, columns: n.table && n.table.columns && n.table.columns.length ? n.table.columns : base.columns, rows: n.table && n.table.rows && n.table.rows.length ? n.table.rows : base.rows, ...(up ? { sourceId: idOf.get(up.id)! } : {}) };
      made.push(withTable({ id, kind: "table", x, y, w: n.w, h: n.h, text: t.title }, t));
      continue;
    }
    const prompt = n.prompt || (n.kind === tpl.kind ? tpl.prompt || "" : "");
    const hist = n.kind === "text" && n.text ? [{ text: n.text }] : [];
    const base = defaultParams(n.kind, store.defaultModel(n.kind));
    // 模板里的 params 可能被反复套用：这里先深拷贝，camera / mj 等嵌套对象不和模板源共用
    const params: AnyParams = cloneParams(n.params ? { ...base, ...n.params } as AnyParams : base);
    made.push(store.newNode(n.kind, x, y, {
      id, title, w: n.w, h: n.h, prompt, params,
      ...(hist.length ? { hist, hi: 0 } : {}),
      ...(hist.length && !prompt ? { manual: true } : {}),
    }));
  }
  const edges = doc.edges.flatMap((e) => { const from = idOf.get(e.from), to = idOf.get(e.to); return from && to ? [{ id: uid("e"), from, to }] : []; });
  store.addNodes(made, edges, { select: false });
  // 视频节点按真实输入选生成方式（与 startFlow 同一口径）
  made.forEach((n) => { if (n.kind === "video") { const m = store.modelOf(store.node(n.id)!); const mode = m ? (inputsOf(store.state.doc, n.id).some((x) => x.node.kind === "image") ? "首帧" : null) : null; if (mode && m?.modes?.includes(mode)) store.patchGen(n.id, (g) => ({ params: { ...(g.params as VideoParams), mode } })); } });
  store.setUI({ sel: new Set([made[made.length - 1].id]) });
  ctl.fitTo(store.state.doc.nodes.filter((n) => made.some((m) => m.id === n.id)), 120, 1);
  return { nodes: made.length, edges: edges.length };
}

/** 应用模板：带 doc 一次铺全量；内置模板走既有 startFlow。返回空串表示成功（关哪一层交给调用方） */
function applyTemplate(ctl: Ctl, tpl: TplEntry): string {
  if (tpl.flow) { startFlow(ctl, tpl.flow); return ""; }
  const doc = tpl.home ? (homeToDoc(tpl.home) as unknown as TplDoc) : tpl.doc;
  if (!doc || !doc.nodes.length) {
    const msg = "「" + tpl.name + "」没有可用的节点文档，没法铺到画布上";
    ctl.store.toast(msg, 4000); return msg;
  }
  try {
    const made = createFromTemplate(ctl, tpl.home ? { ...tpl, doc } : tpl);
    ctl.store.toast(`已按模板创建 ${made.nodes} 个节点、${made.edges} 条连线（${keyHint("undo")} 可撤销）`, 4000);
    return "";
  } catch (e) {
    const msg = "应用模板失败：" + (e instanceof Error ? e.message : "未知错误");
    ctl.store.toast(msg, 4000); return msg;
  }
}

const coverNode = (id: string, kind: TplNode["kind"], x: number, y: number, title: string): TplNode => ({ id, kind, x, y, w: 220, h: 180, title, text: title, prompt: "" });
const coverEdge = (from: string, to: string) => ({ id: from + ">" + to, from, to });
const BUILTIN_COVER_DOCS: Record<string, TplDoc> = {
  ecom: { nodes: [coverNode("product", "image", 0, 80, "产品图"), coverNode("copy", "text", 280, 0, "卖点拆解"), coverNode("poster1", "image", 560, 0, "海报 1"), coverNode("poster2", "image", 560, 220, "海报 2"), coverNode("poster3", "image", 560, 440, "海报 3")], edges: [coverEdge("product", "copy"), coverEdge("copy", "poster1"), coverEdge("copy", "poster2"), coverEdge("copy", "poster3")] },
  i2v: { nodes: [coverNode("frame", "image", 0, 60, "首帧"), coverNode("video", "video", 300, 60, "短片")], edges: [coverEdge("frame", "video")] },
  bg: { nodes: [coverNode("source", "image", 0, 60, "原图"), coverNode("background", "image", 300, 60, "换背景")], edges: [coverEdge("source", "background")] },
  table: { nodes: [coverNode("task", "text", 0, 60, "任务拆解"), coverNode("rows", "table", 280, 40, "多维表格"), coverNode("images", "image", 580, 60, "逐行出图")], edges: [coverEdge("task", "rows"), coverEdge("rows", "images")] },
  story: { nodes: [coverNode("idea", "text", 0, 60, "创意"), coverNode("shots", "table", 280, 40, "分镜表"), coverNode("videos", "video", 580, 60, "逐镜头视频")], edges: [coverEdge("idea", "shots"), coverEdge("shots", "videos")] },
};
/** 内置模板先不送进「公共模板」：列表留空数组，由用户后续自己添加。
 *  TEMPLATES / BUILTIN_COVER_DOCS / TplEntry / toTplEntry 都保留，恢复时把这行换回
 *  `TEMPLATES.map((t) => { ... })`（原映射见 git 历史）即可重新填回来。 */
const BUILTIN_TEMPLATES: TplEntry[] = [];

export function openTemplates(ctl: Ctl, anchor?: Element | null) {
  const btn = anchor instanceof Element ? anchor : document.querySelector('[data-drawer="templates"]');
  openModal((close) => <TemplatesPanel ctl={ctl} close={close} anchor={btn instanceof Element ? btn : null} />, "tpl-panel");
}

/** 成品封面按模板 id 约定路径（public/market-previews/<id>.webp）；加载失败该卡回退结构预览，其余卡不受影响 */
const tplCoverUrl = (id: string) => "./market-previews/" + id + ".webp";
const TPL_PAGE = 10;
const TPL_STRIPS = new Map<string, string[]>();
/** 日期：我们只有 publishedAt（毫秒），按 SPEC 的 ISO 截到日 */
const tplDate = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—");
const tplMatch = (t: TplEntry, kw: string, cats: Record<string, string>) => !kw || (t.name + " " + t.summary + " " + t.tags.join(" ") + " " + (cats[t.category] || "")).toLowerCase().includes(kw);

/** 结构预览：按「尺寸 + 主题 + 模板」缓存，面板反复打开不重画；画不出来返回空串，不假装有图 */
async function tplThumb(t: TplEntry, skin: "dark" | "light", size: number): Promise<string> {
  if (!t.doc || !t.doc.nodes.length) return "";
  const key = size + ":" + skin + ":" + t.id;
  const hit = TPL_THUMBS.get(key);
  if (hit) return hit;
  const url = await tplRender(t.doc, skin, size);
  if (url) TPL_THUMBS.set(key, url);
  return url;
}

async function tplRender(doc: TplDoc, skin: "dark" | "light", size: number): Promise<string> {
  try {
    const url = await renderCanvasThumb({
      doc: { nodes: doc.nodes, edges: doc.edges } as unknown as CanvasDoc,
      width: size, height: size, theme: skin, structure: true, fit: "fill",
    });
    return url || "";
  } catch { return ""; }
}

/** 详情缩略条：节点全景 + 按 x 轴分组的局部结构（合计 2–4 张）；一张都画不出来返回空，调用方只留封面 */
async function tplStrip(t: TplEntry, skin: "dark" | "light"): Promise<string[]> {
  const doc = t.doc;
  if (!doc || !doc.nodes.length) return [];
  const key = "strip:" + skin + ":" + t.id;
  const hit = TPL_STRIPS.get(key);
  if (hit) return hit;
  const seen = new Set<string>();
  const shots: string[] = [];
  const push = async (nodes: TplNode[]) => {
    const ids = new Set(nodes.map((n) => n.id));
    const sig = [...ids].sort().join(",");
    if (seen.has(sig)) return;
    seen.add(sig);
    const url = await tplRender({ nodes, edges: doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }, skin, 240);
    if (url) shots.push(url);
  };
  await push(doc.nodes);
  const sorted = [...doc.nodes].sort((a, b) => a.x - b.x);
  const parts = Math.min(3, Math.max(2, Math.ceil(sorted.length / 2)));
  const per = Math.ceil(sorted.length / parts);
  for (let i = 0; i < sorted.length && shots.length < 4; i += per) await push(sorted.slice(i, i + per));
  if (shots.length) TPL_STRIPS.set(key, shots);
  return shots;
}

/** 面板锚点：贴模板按钮右侧（SPEC ①：left = 按钮右缘 + 14，top = 按钮 top），
 *  但整体（引导卡 + 面板）按**视口**算：.tpl-wrap 的定位祖先是 fixed 的全屏 .modal-bg，
 *  量 .cn-root 会被宿主给的「比窗口更高的画布框」带偏（面板被顶到折线以下、引导卡留在视口里）。
 *  视口装不下「500 面板 + 引导卡」时先收面板高度（.tpl 内容本来就能滚），面板永远完整可见。 */
function useAnchorPos(anchor: Element | null, width: number, height: number, tipRef: { current: HTMLElement | null }, tipOn: boolean, gap: number, ready = true) {
  const [pos, setPos] = useState<{ left: number; top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      if (!anchor || !anchor.isConnected) { setPos(null); return; }
      const a = anchor.getBoundingClientRect();
      const vw = window.innerWidth; const vh = window.innerHeight;
      const above = tipOn ? (tipRef.current?.offsetHeight || 0) + gap : 0;
      const panelH = Math.max(0, Math.min(height, vh - 16 - above));
      const left = Math.max(8, Math.min(a.right + 14, vw - width - 8));
      const top = Math.max(8 + above, Math.min(a.top, vh - 8 - panelH));
      const next = { left: Math.round(left), top: Math.round(top), height: Math.floor(panelH) };
      setPos((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.height === next.height ? cur : next));
    };
    measure();
    // 引导卡文案（有没有公共模板）与字体定稿会改高度，量到就重排一次
    const tipEl = tipOn ? tipRef.current : null;
    const observer = tipEl && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (tipEl) observer?.observe(tipEl);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [anchor, width, height, tipRef, tipOn, gap, ready]);
  return pos;
}

/** 模板卡：「查看 / 应用」只在 hover 或键盘聚焦时挂载（TapNow 是挂载式，没有淡入）；点卡片本体 = 直接应用 */
function TplCard({ tpl, cover, onCoverError, onApply, onView }: {
  tpl: TplEntry; cover: string; onCoverError: () => void;
  onApply: (t: TplEntry) => void; onView: (t: TplEntry, el: HTMLElement | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [act, setAct] = useState(false);
  useEffect(() => { if (tpl.personal && !cover) onCoverError(); }, [tpl.personal, cover]);
  return <div className="tpl-card" data-tpl-card data-tpl-id={tpl.id} ref={root}
    onPointerEnter={() => setAct(true)} onPointerLeave={() => setAct(false)}
    onFocus={() => setAct(true)}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAct(false); }}>
    <span className="tpl-cover">
      {cover ? <img src={cover} alt="" draggable={false} loading="lazy" onError={onCoverError} /> : <span className="tpl-ph"><Icon name="image" /></span>}
      <span className="tpl-veil" data-tpl-veil />
      {act ? <span className="tpl-acts" data-tpl-acts>
        <button type="button" data-tpl-act="view" onClick={() => onView(tpl, root.current)}>查看</button>
        <button type="button" data-tpl-act="apply" onClick={() => onApply(tpl)}>应用</button>
      </span> : null}
    </span>
    <span className="tpl-name">{tpl.name}</span>
    <button type="button" className="tpl-hit" data-tpl-hit aria-label={"应用模板：" + tpl.name} onClick={() => onApply(tpl)} />
  </div>;
}

function TemplatesPanel({ ctl, close, anchor }: { ctl: Ctl; close: () => void; anchor: Element | null }) {
  const theme = useS((s) => s.ui.theme);
  /** 封面按当前主题取色：深色 #1a1a1c 底 + 亮一档节点块，浅色 #f0f0f2 底 + 白节点块 */
  const skin: "dark" | "light" = theme === "light" ? "light" : "dark";
  const [tab, setTab] = useState<"public" | "mine">("public");
  const [q, setQ] = useState("");
  const [read, setRead] = useState<{ status: "loading" | "market" | "builtin"; list: TplEntry[]; cats: Record<string, string>; error: string }>({ status: "loading", list: [], cats: {}, error: "" });
  /** 已加载条数：每页 10，滚到距底 100 加一页（TapNow 的分页口径） */
  const [shown, setShown] = useState(TPL_PAGE);
  const [paging, setPaging] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** 成品封面加载失败的模板 id：为真时该卡回退结构预览 */
  const [coverBad, setCoverBad] = useState<Record<string, boolean>>({});
  const [gallery, setGallery] = useState(false);
  const [detail, setDetail] = useState<TplEntry | null>(null);
  /** 「查看」= 可交互预览窗（不再直接进 1100×700 模板库） */
  const [preview, setPreview] = useState<TplEntry | null>(null);
  const [strips, setStrips] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [mine, setMine] = useState<TplEntry[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>(() => { try { return JSON.parse(readMigratedKey("novai:template-recent") || "[]"); } catch { return []; } });
  /** 面板上方引导卡：本次会话只提示一次；累计关掉 2 次后多出「不再提示」（永久，localStorage） */
  const [tip, setTip] = useState(false);
  const [tipCount, setTipCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastCard = useRef<HTMLElement | null>(null);
  const pagingRef = useRef(false);
  const pageGen = useRef(0);
  const alive = useRef(true);
  const tipRef = useRef<HTMLDivElement>(null);
  /** 整组挂到 overlay 的 .modal-bg（#modal）下、而不是 .modal 里：.modal 只要带上入场动画或任何 transform
   *  就会成为绝对定位后代的包含块，写在 style 里的视口坐标会被它整体带到屏幕中心去（用户看到的「面板跑到右下角」）。
   *  挂到固定定位的 .modal-bg 下，left/top 才真的是视口坐标；关窗动画 .modal-bg.closing .tpl 也还在。 */
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(document.getElementById("modal")); }, []);
  const pos = useAnchorPos(anchor, 500, 500, tipRef, tip, 10, !!host);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    try {
      if (readMigratedKey("novai:template-tip") === "never") return;
      if (readMigratedSessionKey("novai:template-tip:session") === "1") return;
      setTipCount(Number(readMigratedKey("novai:template-tip:count") || 0) || 0);
      setTip(true);
    } catch { /* 存储不可用就不提示 */ }
  }, []);
  const dismissTip = () => {
    setTip(false);
    try {
      sessionStorage.setItem("novai:template-tip:session", "1");
      localStorage.setItem("novai:template-tip:count", String(tipCount + 1));
    } catch { /* 忽略 */ }
  };
  const neverTip = () => {
    setTip(false);
    try { localStorage.setItem("novai:template-tip", "never"); } catch { /* 忽略 */ }
  };
  const tipMore = () => ctl.store.toast("点卡片直接应用模板；hover 卡片点「查看」看详情；面板右上「浏览全部」打开模板库", 5200);
  useEffect(() => {
    void (async () => {
      const res = await loadMarketTemplates();
      if (!alive.current) return;
      setRead(res.list.length ? { status: "market", list: res.list, cats: res.cats, error: "" } : { status: "builtin", list: BUILTIN_TEMPLATES, cats: {}, error: res.error });
      const personal = await loadPersonalTemplates();
      if (!alive.current) return;
      setLibraryId(personal.libraryId);
      setMine(personal.items.flatMap((item) => { const entry = personalEntry(item); return entry ? [entry] : []; }));
      if (personal.error) setErr(personal.error);
    })();
  }, []);
  // 切页签 / 改搜索：回到第一页、滚回顶部（TapNow 会清空搜索）
  useEffect(() => {
    pageGen.current += 1; pagingRef.current = false;
    setShown(TPL_PAGE); setPaging(false);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab, q]);
  // 详情缩略条：结构图按 doc 生成，失败就只留封面
  useEffect(() => {
    setStrips([]);
    if (!detail) return;
    let dead = false;
    void tplStrip(detail, skin).then((urls) => { if (!dead && urls.length) setStrips(urls); });
    return () => { dead = true; };
  }, [detail, skin]);
  const source = tab === "mine" ? mine : read.list;
  const total = source.length;
  const kw = q.trim().toLowerCase();
  const loaded = tab === "mine" ? source : source.slice(0, shown);
  /** 搜索是纯前端过滤「已加载」的卡片，不发请求；搜索时不继续翻页（结果 <10 也不再加载） */
  const list = kw ? loaded.filter((t) => tplMatch(t, kw, read.cats)) : loaded;
  const hasMore = tab === "public" && !kw && shown < total;
  const loadMore = useCallback(() => {
    if (pagingRef.current) return;
    const gen = pageGen.current;
    pagingRef.current = true; setPaging(true);
    window.setTimeout(() => {
      pagingRef.current = false;
      if (!alive.current || gen !== pageGen.current) { setPaging(false); return; }
      setShown((n) => Math.min(n + TPL_PAGE, total));
      setPaging(false);
    }, 140);
  }, [total]);
  const onScroll = () => {
    const el = bodyRef.current; if (!el) return;
    if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 100) loadMore();
  };
  // 一页没填满滚动区时补下一页，别让用户对着空白滚
  useEffect(() => {
    const el = bodyRef.current; if (!el || !hasMore) return;
    if (el.scrollHeight - el.clientHeight < 8) loadMore();
  }, [shown, hasMore, loadMore]);
  const thumbKey = (t: TplEntry) => "480:" + skin + ":" + t.id;
  const ensureThumb = (t: TplEntry) => {
    const key = thumbKey(t);
    if (TPL_THUMBS.get(key) || thumbs[key]) return;
    void tplThumb(t, skin, 480).then((url) => { if (url && alive.current) setThumbs((p) => (p[key] ? p : { ...p, [key]: url })); });
  };
  const coverOf = (t: TplEntry) => t.home ? (t.home.media || "") : t.personal || t.flow ? (t.cover || thumbs[thumbKey(t)] || "") : (coverBad[t.id] ? thumbs[thumbKey(t)] || "" : tplCoverUrl(t.id));
  useEffect(() => { list.forEach(ensureThumb); }, [list, skin]);
  const onCoverError = (t: TplEntry) => {
    setCoverBad((p) => (p[t.id] ? p : { ...p, [t.id]: true }));
    ensureThumb(t);
  };
  const closeGallery = useCallback(() => {
    setGallery(false); setDetail(null);
    requestAnimationFrame(() => lastCard.current?.focus());
  }, []);
  const openAll = () => { setDetail(null); setGallery(true); };
  /** 模板库（浏览全部）里的详情仍走旧弹层 */
  const openDetail = (t: TplEntry, el: HTMLElement | null) => { if (el) lastCard.current = el; setErr(""); setDetail(t); setGallery(true); };
  /** 卡片「查看」：打开可交互预览窗 */
  const openPreview = (t: TplEntry) => { setErr(""); setPreview(t); };
  /** 模板库里的「查看」：同一个预览窗开在库之上，关掉后仍回到库 */
  const openGalleryPreview = (t: TplEntry) => { setErr(""); setDetail(null); setPreview(t); };
  const applyNow = (t: TplEntry) => {
    const message = applyTemplate(ctl, t);
    if (message) { setErr(message); return; }
    const recent = [t.id, ...recentIds.filter((id) => id !== t.id)].slice(0, 30);
    setRecentIds(recent);
    try { localStorage.setItem("novai:template-recent", JSON.stringify(recent)); } catch { /* 无存储时仍可使用模板 */ }
    setDetail(null); setGallery(false); close();
  };
  const openCreate = () => { setCreateName(ctl.store.state.name + " 模板"); setCreateDescription(""); setCreateError(""); setCreating(true); };
  const createDefaultWorkflow = () => {
    startFlow(ctl, "t2v");
    setGallery(false); setDetail(null); close();
  };
  const createTemplate = async () => {
    if (!createName.trim()) { setCreateError("请填写模板名称"); return; }
    if (!ctl.store.state.doc.nodes.length) { setCreateError("画布还没有可保存的节点"); return; }
    setCreateBusy(true); setCreateError("");
    const coverDataUrl = await renderCanvasThumb({ doc: ctl.store.state.doc, width: 480, height: 480, theme: skin, structure: true, fit: "fill" });
    const result = await savePersonalTemplate({ libraryId, title: createName, prompt: createDescription, doc: ctl.store.state.doc, coverDataUrl });
    setCreateBusy(false);
    if (!result.ok || !result.id) { setCreateError(result.error || "保存失败"); return; }
    const personal = await loadPersonalTemplates();
    setLibraryId(personal.libraryId);
    const next = personal.items.flatMap((item) => { const entry = personalEntry(item); return entry ? [entry] : []; });
    setMine(next);
    setCreating(false); setTab("mine"); setGallery(false); setDetail(null);
    ctl.store.toast("已保存到我的模板");
  };
  /** 删除个人模板；返回空串表示成功。旧详情页走 ask 的 window.confirm，预览窗走自己的确认弹层 */
  const removeMine = async (tpl: TplEntry, opts?: { ask?: boolean }): Promise<string> => {
    if (opts?.ask !== false && !window.confirm("删除个人模板「" + tpl.name + "」？原画布不会被删除。")) return "";
    if (!(await deletePersonalTemplate(libraryId, tpl.id))) return "删除个人模板失败";
    setMine((items) => items.filter((item) => item.id !== tpl.id)); setDetail(null);
    return "";
  };
  /** 预览窗确认删除后调用：删掉个人模板、关预览、回模板库；返回错误文案给确认弹层 */
  const deletePreviewTemplate = async (tpl: TplEntry): Promise<string> => {
    setErr("");
    const message = await removeMine(tpl, { ask: false });
    if (message) { setErr(message); ctl.store.toast(message, 4000); return message; }
    setPreview(null); setGallery(true);
    ctl.store.toast("已删除模板");
    return "";
  };
  // Esc 逐层倒退：详情 → 弹层 →（ModalView 的 Esc 关面板）。window 捕获先于 document，才抢得到弹层自己的 Esc
  useEffect(() => {
    if (!gallery || preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (detail) { setDetail(null); return; }
      closeGallery();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [gallery, detail, preview, closeGallery]);
  // 点面板外关闭：透明层不吃指针，所以自己监听；点模板按钮本身交给切换，不先关再开。
  // 引导卡和面板是一个整体（同一个 .tpl-wrap），点引导卡上的「知道了 / 了解更多」不算点外面。
  useEffect(() => {
    if (gallery || creating || preview) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || panelRef.current?.contains(t) || tipRef.current?.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [gallery, creating, preview, close, anchor]);
  const wrap = (
    <div className="tpl-wrap" style={pos ? { left: pos.left, top: pos.top, height: pos.height } : { visibility: "hidden" }}>
      {tip ? <TplTip innerRef={tipRef} templates={read.list.length} count={tipCount} onMore={tipMore} onDismiss={dismissTip} onNever={neverTip} /> : null}
      <div className="tpl" data-tpl-panel role="dialog" aria-label="模板" ref={panelRef}>
      <div className="tpl-col">
        <div className="tpl-hd" data-tpl-hd>
          <div className="tpl-tabs" role="tablist">
            <button type="button" className={"tpl-tab" + (tab === "public" ? " on" : "")} data-tpl-tab="public" role="tab" aria-selected={tab === "public"} onClick={() => setTab("public")}>公共模板</button>
            <button type="button" className={"tpl-tab" + (tab === "mine" ? " on" : "")} data-tpl-tab="mine" role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>我的模板</button>
          </div>
          <button type="button" className="tpl-all" data-tpl-all aria-label="浏览全部" title="浏览全部" onClick={openAll}><Icon name="fit" /></button>
        </div>
        <div className="tpl-searchrow">
          <div className="tpl-search">
            <Icon name="search" size="s" />
            <input data-tpl-search autoFocus aria-label="搜索模板" placeholder="搜索模板…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
        </div>
        <div className="tpl-body" data-tpl-body ref={bodyRef} onScroll={onScroll}>
          {tab === "mine" ? <>
            <button type="button" className="tpl-create tpl-create-default" data-tpl-default-create onClick={createDefaultWorkflow}><Icon name="plus" size="s" />创建工作流</button>
            <button type="button" className="tpl-create" data-tpl-create onClick={openCreate}><Icon name="plus" size="s" />保存当前画布为模板</button>
            {list.length ? <div className="tpl-grid">{list.map((t) => <TplCard key={t.id} tpl={t} cover={coverOf(t)} onCoverError={() => onCoverError(t)} onApply={applyNow} onView={openPreview} />)}</div> : null}
            {!list.length ? <div className="tpl-empty" data-tpl-mine><span className="l1">{kw ? "没有找到匹配模板" : "还没有个人模板"}</span><span className="l2">{libraryId ? "把当前画布的节点与连线保存下来，之后可以重复使用" : "连接桌面资产库后即可保存"}</span></div> : null}
          </> : <>
            {read.status === "loading" ? <div className="tpl-grid" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="tpl-sk" />)}</div> : null}
            {read.status !== "loading" && list.length ? <div className="tpl-grid">
              {list.map((t) => <TplCard key={t.id} tpl={t} cover={coverOf(t)} onCoverError={() => onCoverError(t)} onApply={applyNow} onView={openPreview} />)}
            </div> : null}
            {read.status !== "loading" && hasMore ? <div className="tpl-more" data-tpl-more data-tpl-loading={paging ? "1" : "0"}><span className="tpl-spin" data-tpl-spin /></div> : null}
            {read.status !== "loading" && !list.length ? <div className="tpl-empty" data-tpl-nomatch>
              <span className="l1">{kw ? "没有匹配的模板" : "还没有公共模板"}</span>
            </div> : null}
            {read.status === "builtin" && read.list.length ? <div className="tpl-note" data-tpl-note title={read.error}>当前显示内置模板</div> : null}
          </>}
          {err ? <div className="tpl-err" data-tpl-err>{err}</div> : null}
        </div>
      </div>
      </div>
    </div>
  );
  return <>
    {host ? createPortal(wrap, host) : null}
    {preview ? <TemplatePreview entry={preview} busy={false}
      onClose={() => setPreview(null)}
      onApply={() => { const t = preview; setPreview(null); applyNow(t); }}
      onAgent={() => {
        const t = preview; if (!t) return;
        setPreview(null);
        const message = applyTemplate(ctl, t);
        if (message) { setErr(message); return; }
        const recent = [t.id, ...recentIds.filter((id) => id !== t.id)].slice(0, 30);
        setRecentIds(recent);
        try { localStorage.setItem("novai:template-recent", JSON.stringify(recent)); } catch { /* 无存储时仍可使用模板 */ }
        setDetail(null); setGallery(false); close();
        // 只预填 + 聚焦，发不发由用户决定（AgentPanel 的 autoSend 默认 false）
        ctl.agentDraft?.("按这个模板帮我搭画布：" + t.name);
      }}
      onDeleteConfirm={preview.personal ? () => deletePreviewTemplate(preview) : undefined}
      agentDisabled={!ctl.agentDraft} /> : null}
    {gallery ? <TplGallery all={read.list} mine={mine} recentIds={recentIds} cats={read.cats} coverBad={coverBad} coverOf={coverOf} onCoverError={onCoverError}
      detail={detail} strips={strips} onDetail={openGalleryPreview} onApply={applyNow} onCreate={openCreate} onDefaultCreate={createDefaultWorkflow} onDelete={removeMine} onClose={closeGallery} onBack={() => setDetail(null)} /> : null}
    {creating ? <div className="tpl-create-scrim" data-tpl-create-dialog><form className="tpl-create-form" role="dialog" aria-modal="true" aria-label="创建模板" onSubmit={(e) => { e.preventDefault(); void createTemplate(); }}>
      <ModalHead title="保存为我的模板" />
      <label>模板名称<input autoFocus data-tpl-create-name value={createName} onChange={(e) => setCreateName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} maxLength={120} /></label>
      <label>用途说明<textarea data-tpl-create-description value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} onKeyDown={(e) => e.stopPropagation()} rows={4} placeholder="说明输入、步骤和适用场景" /></label>
      <p>保存当前画布的 {ctl.store.state.doc.nodes.length} 个节点和 {ctl.store.state.doc.edges.length} 条连线。图片等结果仍保留在原画布，模板只保存可复用的结构。</p>
      {createError ? <div className="tpl-err" role="alert">{createError}</div> : null}
      <div className="tpl-create-actions"><button type="button" className="btn" disabled={createBusy} onClick={() => setCreating(false)}>取消</button><button type="submit" className="btn solid" data-tpl-create-save disabled={createBusy || !libraryId}>{createBusy ? "保存中…" : "保存模板"}</button></div>
    </form></div> : null}
  </>;
}

/** 面板上方引导卡：示意图用纯 CSS/SVG 画「节点逐个出现 + 连线生长」，每 7s 循环一次；
 *  prefers-reduced-motion 下不播放，直接显示完整示意图；颜色取主题变量，深色 / 浅色都可读。 */
function TplTip({ templates, count, onMore, onDismiss, onNever, innerRef }: { templates: number; count: number; onMore: () => void; onDismiss: () => void; onNever: () => void; innerRef?: { current: HTMLDivElement | null } }) {
  const hasTemplates = templates > 0;
  return <div className="tpl-tip" data-tpl-tip ref={innerRef}>
    <div className="tpl-tip-shot" data-tpl-tip-shot><TplFlowAnim /></div>
    <div className="tpl-tip-main">
      <b>{hasTemplates ? "用一个模板开个头" : "从一张空白画布开始"}</b>
      <p>{hasTemplates ? "点卡片把节点铺到画布，" + keyHint("undo") + " 可撤销；也能把画布存成「我的模板」。" : "还没有公共模板。先直接开始创作，也可以把画布存成「我的模板」复用。"}</p>
      <button type="button" className="tpl-tip-more" title="模板用法：点卡片应用、hover 点「查看」看详情、右上「浏览全部」打开模板库" onClick={onMore}>了解更多</button>
    </div>
    <div className="tpl-tip-ft">
      {count >= 2 ? <button type="button" className="tpl-tip-btn" data-tpl-tip-never onClick={onNever}>不再提示</button> : null}
      <button type="button" className="tpl-tip-btn" data-tpl-tip-dismiss onClick={onDismiss}>知道了</button>
    </div>
  </div>;
}

/** 三节点两连线的示意图（236×133）：节点依次出现，连线随后生长；时间和顺序都在 CSS 里 */
function TplFlowAnim() {
  return <svg className="tpl-anim" viewBox="0 0 236 133" role="img" aria-label="节点逐个出现并连线生长的示意图" focusable="false">
    <g className="ta-node ta-n1"><rect x="14" y="44" width="58" height="44" rx="10" /><path className="ta-ink" d="M26 60h30M26 70h20" /></g>
    <g className="ta-node ta-n2"><rect x="94" y="38" width="58" height="56" rx="10" /><circle className="ta-ink" cx="139" cy="53" r="3" /><path className="ta-ink" d="M104 79l10-13 7 8 10-14 8 11" /></g>
    <g className="ta-node ta-n3"><rect x="174" y="44" width="48" height="44" rx="10" /><path className="ta-ink" d="M186 60h24M186 70h16M186 80h20" /></g>
    <path className="ta-edge ta-e1" pathLength="1" d="M72 66h22" />
    <path className="ta-edge ta-e2" pathLength="1" d="M152 66h22" />
  </svg>;
}

/** 模板库弹层（「浏览全部」与「查看」都进这里）：1100×700、左 256 分类栏、右侧网格 / 详情，无入场动画 */
function TplGallery({ all, mine, recentIds, cats, coverBad, coverOf, onCoverError, detail, strips, onDetail, onApply, onCreate, onDefaultCreate, onDelete, onClose, onBack }: {
  all: TplEntry[]; mine: TplEntry[]; recentIds: string[]; cats: Record<string, string>; coverBad: Record<string, boolean>;
  coverOf: (t: TplEntry) => string; onCoverError: (t: TplEntry) => void;
  detail: TplEntry | null; strips: string[];
  onDetail: (t: TplEntry, el: HTMLElement | null) => void; onApply: (t: TplEntry) => void;
  onCreate: () => void; onDefaultCreate: () => void; onDelete: (t: TplEntry) => void;
  onClose: () => void; onBack: () => void;
}) {
  const [cat, setCat] = useState("all");
  const [scope, setScope] = useState<"public" | "mine" | "recent">("public");
  const [gq, setGq] = useState("");
  const counts = new Map<string, number>();
  all.forEach((t) => { if (t.category) counts.set(t.category, (counts.get(t.category) || 0) + 1); });
  const catList = Object.keys(cats).filter((id) => (counts.get(id) || 0) > 0).map((id) => ({ id, name: cats[id], n: counts.get(id) || 0 }));
  const gk = gq.trim().toLowerCase();
  const source = scope === "mine" ? mine : scope === "recent" ? recentIds.map((id) => [...mine, ...all].find((t) => t.id === id)).filter((t): t is TplEntry => !!t) : all;
  const list = source.filter((t) => (scope !== "public" || cat === "all" || t.category === cat) && tplMatch(t, gk, cats));
  const catName = scope === "mine" ? "我的模板" : scope === "recent" ? "最近使用" : cat === "all" ? "全部" : cats[cat] || "全部";
  return <div className="tpl-lib" data-tpl-lib onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="tpl-lib-box" data-tpl-lib-box role="dialog" aria-modal="true" aria-label="模板库" onPointerDown={(e) => e.stopPropagation()}>
      <aside className="tpl-lib-side" data-tpl-lib-side>
        <div className="tpl-lib-nav">
          <button type="button" className={"tpl-lib-cat" + (scope === "recent" ? " on" : "")} data-tpl-lib-scope="recent" onClick={() => { setScope("recent"); onBack(); }}><span>最近使用</span><span className="tpl-lib-n">{recentIds.length}</span></button>
          <button type="button" className={"tpl-lib-cat" + (scope === "mine" ? " on" : "")} data-tpl-lib-scope="mine" onClick={() => { setScope("mine"); onBack(); }}><span>我的模板</span><span className="tpl-lib-n">{mine.length}</span></button>
          <div className="tpl-lib-label">公开模板</div>
          <button type="button" className={"tpl-lib-cat" + (scope === "public" && cat === "all" ? " on" : "")} data-tpl-lib-cat="all" onClick={() => { setScope("public"); setCat("all"); onBack(); }}>
            <span>全部</span><span className="tpl-lib-n">{all.length}</span>
          </button>
          {catList.map((c) => <button key={c.id} type="button" className={"tpl-lib-cat" + (scope === "public" && cat === c.id ? " on" : "")} data-tpl-lib-cat={c.id} onClick={() => { setScope("public"); setCat(c.id); onBack(); }}>
            <span>{c.name}</span><span className="tpl-lib-n">{c.n}</span>
          </button>)}
        </div>
        <div className="tpl-lib-create-actions">
          <button type="button" className="tpl-lib-create" data-tpl-default-create onClick={onDefaultCreate}><Icon name="plus" size="s" />创建工作流</button>
          <button type="button" className="tpl-lib-save-current" data-tpl-create onClick={onCreate}>保存当前画布为模板</button>
        </div>
      </aside>
      <div className="tpl-lib-main">
        <div className="tpl-lib-hd">
          <b data-tpl-lib-title>{catName}</b>
          <span className="sp" />
          <button type="button" className="tpl-lib-x" data-tpl-lib-x aria-label="关闭" onClick={onClose}><Icon name="x" /></button>
        </div>
        {detail
          ? <TplDetail tpl={detail} cat={detail.personal ? "我的模板" : cats[detail.category] || ""} strips={strips} coverBad={!!coverBad[detail.id]} cover={coverOf(detail)} onBack={onBack} onApply={onApply} onDelete={onDelete} />
          : <>
            <div className="tpl-lib-tools">
              <div className="tpl-lib-search">
                <Icon name="search" size="s" />
                <input data-tpl-lib-search aria-label="搜索模板" placeholder="搜索 场景/模板…" value={gq} onChange={(e) => setGq(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              </div>
            </div>
            <div className="tpl-lib-grid" data-tpl-lib-grid>
              {list.map((t) => <TplCard key={t.id} tpl={t} cover={coverOf(t)} onCoverError={() => onCoverError(t)} onApply={onApply} onView={onDetail} />)}
              {!list.length ? <div className="tpl-empty" data-tpl-lib-empty><span className="l1">{scope === "public" && !gk ? "还没有公共模板" : "未找到匹配资产"}</span></div> : null}
            </div>
          </>}
      </div>
    </div>
  </div>;
}

/** 详情：400×400 图 + 24px 标题 + 日期 + 112 高缩略条 + 364×36 主按钮；缩略图 = 封面 + 结构分组 */
function TplDetail({ tpl, cat, strips, coverBad, cover, onBack, onApply, onDelete }: {
  tpl: TplEntry; cat: string; strips: string[]; coverBad: boolean; cover: string;
  onBack: () => void; onApply: (t: TplEntry) => void; onDelete: (t: TplEntry) => void;
}) {
  const [shot, setShot] = useState(0);
  const shots: string[] = [];
  if (!coverBad && cover) shots.push(cover);
  strips.forEach((src) => shots.push(src));
  const at = shots.length ? Math.min(shot, shots.length - 1) : -1;
  return <div className="tpl-dt" data-tpl-detail>
    <div className="tpl-dt-top">
      <button type="button" className="tpl-dt-back" data-tpl-dt-back aria-label="返回全部模板" onClick={onBack}><Icon name="back" /></button>
    </div>
    <div className="tpl-dt-row">
      <div className="tpl-dt-shot" data-tpl-dt-shot>
        {at >= 0 ? <img src={shots[at]} alt={tpl.name + " 预览"} draggable={false} /> : <span className="tpl-ph">这个模板没有可用的预览图</span>}
      </div>
      <div className="tpl-dt-info">
        <b className="tpl-dt-name" data-tpl-dt-name>{tpl.name}</b>
        <div className="tpl-dt-date" data-tpl-dt-date>{tplDate(tpl.publishedAt)}</div>
        <div className="tpl-dt-meta" data-tpl-dt-meta>{cat ? cat + " · " : ""}{tpl.nodes ? tpl.nodes + " 节点 · " + tpl.edges + " 连线" : "内置工作流"}</div>
        {tpl.summary ? <p className="tpl-dt-sum">{tpl.summary}</p> : null}
        {tpl.steps.length ? <ol className="tpl-dt-steps">{tpl.steps.map((s, i) => <li key={i}><b>{s.title}</b>{s.detail ? <span>{s.detail}</span> : null}</li>)}</ol> : null}
        <button type="button" className="tpl-dt-apply" data-tpl-dt-apply onClick={() => onApply(tpl)}>应用</button>
        {tpl.personal ? <button type="button" className="tpl-dt-delete" data-tpl-dt-delete onClick={() => onDelete(tpl)}>删除个人模板</button> : null}
      </div>
    </div>
    {shots.length ? <div className="tpl-dt-strip" data-tpl-dt-strip>
      {shots.map((src, i) => <button key={i} type="button" className={"tpl-dt-th" + (i === at ? " on" : "")} data-tpl-dt-th onClick={() => setShot(i)}><img src={src} alt="" draggable={false} /></button>)}
    </div> : null}
  </div>;
}
export function startFlow(ctl: Ctl, kind: string) {
  const store = ctl.store; if (kind === "tpl") return openTemplates(ctl);
  const c = ctl.center(); const made: CanvasNode[] = []; const edges: Array<{ id: string; from: string; to: string }> = [];
  const add = (n: CanvasNode) => { made.push(n); return n; }; const link = (a: CanvasNode, b: CanvasNode) => edges.push({ id: uid("e"), from: a.id, to: b.id });
  const N = (k: GenKind, x: number, y: number, extra: Parameters<typeof store.newNode>[3] = {}) => add(store.newNode(k, x, y, extra));
  if (kind === "t2v") { const t = N("text", c.x - 420, c.y - 100, { title: "视频脚本", prompt: "写一段 10 秒短片的分镜脚本，3 个镜头" }); const v = N("video", c.x, c.y - 90, { title: "短片", prompt: "按上游脚本生成，电影感，节奏紧凑" }); link(t, v); }
  if (kind === "bg") { const s = N("image", c.x - 420, c.y - 120, { title: "原图", uploaded: true }); const o = N("image", c.x, c.y - 120, { title: "换背景", prompt: "保持主体不变，背景换成清晨的木质书桌，左侧窗光" }); link(s, o); }
  if (kind === "i2v") { const s = N("image", c.x - 420, c.y - 120, { title: "首帧", uploaded: true }); const v = N("video", c.x, c.y - 90, { title: "首帧视频", prompt: "镜头缓慢环绕主体，光线从左扫到右" }); link(s, v); }
  if (kind === "ecom") { const p = N("image", c.x - 700, c.y - 250, { title: "产品图", uploaded: true }); const info = N("text", c.x - 710, c.y + 80, { title: "产品信息", manual: true, hist: [{ text: "产品：\n卖点：\n人群：\n风格偏好：" }] }); const t = N("text", c.x - 300, c.y - 120, { title: "卖点拆解", w: 300, h: 240, prompt: "输出 3 个卖点海报方案，以“海报1”“海报2”“海报3”开头，每个包含主标题、画面、文案" }); link(info, t); link(p, t); [0, 1, 2].forEach((i) => { const o = N("image", c.x + 120, c.y - 380 + i * 330, { title: "海报" + (i + 1), w: 220, prompt: `参考 @卖点拆解·海报${i + 1}，基于产品图生成竖版卖点海报` }); link(p, o); link(t, o); }); }
  if (kind === "table" || kind === "story") {
    const story = kind === "story";
    const t = N("text", c.x - 640, c.y - 100, { title: story ? "创意" : "任务拆解", prompt: story ? "一条 15 秒的产品开箱短片，节奏由慢到快" : "把下面的产品拆成 4 张不同场景的宣传图任务", params: { ...(defaultParams("text", store.defaultModel("text")) as TextParams), output: story ? "storyboard" : "table" } });
    const tb = add(withTable({ id: uid("t"), kind: "table", x: Math.round(c.x - 220), y: Math.round(c.y - 140), w: 420, h: 220, text: story ? "分镜表" : "多维表格" }, { ...emptyTable(), title: story ? "分镜表" : "多维表格", sourceId: t.id }));
    const g = N(story ? "video" : "image", c.x + 340, c.y - 120, { title: story ? "逐镜头视频" : "逐行出图", prompt: story ? "按这一行的镜头描述生成" : "按这一行的描述生成宣传图，主体保持一致" });
    link(t, tb); link(tb, g);
  }
  if (!made.length) return;
  store.addNodes(made, edges, { select: false });
  made.forEach((n) => { if (n.kind === "video") { const m = store.modelOf(store.node(n.id)!); const mode = m ? (inputsOf(store.state.doc, n.id).some((x) => x.node.kind === "image") ? "首帧" : null) : null; if (mode && m?.modes?.includes(mode)) store.patchGen(n.id, (g) => ({ params: { ...(g.params as VideoParams), mode } })); } });
  store.setUI({ sel: new Set([made[made.length - 1].id]) }); ctl.fitTo(store.state.doc.nodes.filter((n) => made.some((m) => m.id === n.id)), 120, 1);
  store.toast(`已创建 ${made.length} 个节点并按顺序连好，选中节点点生成，或右键「运行到此（含上游）」`, 4000);
}

/* ---------- 小地图 / 回到节点 ---------- */
/** 多选工具条：浮在选区上方（FloatMenu，和组工具条同一套 Expandable Action Bar）；单个分组用组框上方的 GroupTools */
function MultiBar() {
  const ctl = useCtl(); const store = ctl.store; const ui = useS((s) => s.ui); const doc = useS((s) => s.doc); const batches = useS((s) => s.batches); const view = useS((s) => s.view);
  const nodes = [...ui.sel].map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n);
  // 工具条跟着选区浮在包围盒上方（不再是屏幕底部固定条）：view 变一次就重算一次
  const barRef = useRef<HTMLDivElement>(null);
  const [barPos, setBarPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    const v = store.state.view;
    const sel = nodes;
    if (!el || sel.length < 2) { setBarPos((p2) => (p2 ? null : p2)); return; }
    const minX = Math.min(...sel.map((n) => n.x)), maxX = Math.max(...sel.map((n) => n.x + n.w));
    const minY = Math.min(...sel.map((n) => n.y));
    const h = el.offsetHeight, half = el.offsetWidth / 2;
    const stage = el.parentElement?.clientWidth || ctl.rect().width;
    const cx = ((minX + maxX) / 2) * v.k + v.x;
    // 底边落在选区顶上方 12px（条自己 translate 基线还有 3px）
    const top = minY * v.k + v.y - 12 - 3 - h;
    // 顶边 / 左右都钳在画布内，靠边时不会跑出去；值没变就返回原对象，别每帧都触发重渲染
    const left = Math.max(half + 8, Math.min(cx, stage - half - 8));
    const next = Math.max(5, top);
    setBarPos((prev) => (prev && prev.left === left && prev.top === next ? prev : { left, top: next }));
  });
  // 单个分组不再走底部条：分组自己的工具都浮在组框上方（ui/LegacyNodes.tsx 的 GroupTools）
  if (nodes.length < 2) return null;
  // 排版只对自由节点生效：分组本身和组员都不参与，否则组框会和成员拆开
  const grouped = new Set(doc.nodes.filter((n) => n.kind === "group").flatMap((n) => n.children || []));
  const layoutable = nodes.length >= 2 && nodes.every((n) => n.kind !== "group" && !grouped.has(n.id));
  const runnable = runnableIds(store, nodes); const b = batches[runKeyOf(nodes)];
  // 多选条挂在 #layer 上（不在画布 world 的缩放里），屏幕像素就是最终大小：
  // 内联 scale:1 压掉 float-menu.css 里基于 --zinv 的反向缩放（--zinv 会从上层继承下来）

  // 多选条自己就是「left=中心 + translate:-50%」，展开时天然中心不动，不能再开 compensate（会双重补偿）
  return <FloatMenu ref={barRef} id="multibar" data={{ "data-multi": String(nodes.length) }}
    style={{ scale: 1, ...(barPos ? { left: barPos.left, top: barPos.top } : {}) }}>
    <span className="cn-fm-count tnum" data-mb-count>已选 {nodes.length} 个</span>
    {layoutable ? <FloatMenuButton icon="layoutgrid" label="布局" data={{ "data-mb": "layout" }} onClick={(e) => openPop(e.currentTarget, (close) => <>
      <div className="mh">排版 {nodes.length} 个节点</div>
      <button className="mi" data-layout="grid" onClick={() => { close(); layoutSelection(store, "grid"); }}><Icon name="grid" size="s" />宫格布局</button>
      <button className="mi" data-layout="horizontal" onClick={() => { close(); layoutSelection(store, "horizontal"); }}><Icon name="right" size="s" />水平流布局</button>
    </>, "down")} /> : null}
    <FloatMenuButton icon="align" label="对齐" data={{ "data-mb": "align" }} onClick={(e) => openPop(e.currentTarget, (close) => <>
      <div className="mh">对齐 {nodes.length} 个节点</div>
      <button className="mi" data-align="left" onClick={() => { close(); alignSelection(store, "left"); }}><Icon name="left" size="s" />左对齐</button>
      <button className="mi" data-align="top" onClick={() => { close(); alignSelection(store, "top"); }}><Icon name="up" size="s" />顶对齐</button>
      <button className="mi" data-align="hgap" onClick={() => { close(); alignSelection(store, "hgap"); }}><Icon name="distribute" size="s" />水平等距</button>
    </>, "down")} />
    <FloatMenuButton icon="layers" label="堆叠" title={"把选中的节点收成一叠（" + keyHint("stack") + "）"} data={{ "data-mb": "stack" }} onClick={() => stackSelection(store)} />
    <FloatMenuButton icon="group" label="分组" title={"编成一组（" + keyHint("group") + "）"} data={{ "data-mb": "group" }} onClick={() => groupSelection(store)} />
    {nodes.some(clipable) ? <FloatMenuButton icon="video" label="建剪辑" title="把选中的视频 / 音频 / 图片按画布上的顺序放进一条新的剪辑时间线" data={{ "data-mb": "playlist" }} onClick={() => createTimelineFrom(store, nodes)} /> : null}
    {b
      ? <><span className="cn-fm-count tnum" data-mb="prog">运行中 {b.done + b.failed}/{b.total}</span><FloatMenuButton icon="stop" label="停止" disabled={b.stopped} data={{ "data-mb": "stop" }} onClick={() => stopGroup(store, b.key)} /></>
      : <FloatMenuButton icon="play" label="一键运行" primary disabled={!runnable.length} data={{ "data-mb": "run" }}
        title={runnable.length ? `按依赖顺序运行 ${runnable.length} 个生成节点（${keyHint("run")}，先确认消耗）` : "选中的节点里没有可运行的"}
        onClick={() => runNodes(ctl, nodes)} />}
    <FloatMenuButton icon="layout" label="存为模板" title="存为我的模板" data={{ "data-mb": "tpl" }} onClick={() => saveAsTemplate(ctl, nodes, store.state.name + " 模板")} />
    <FloatMenuButton icon="download" label="下载" title="有结果的节点打包成 zip 下载" data={{ "data-mb": "dl" }} onClick={() => void downloadMany(nodes, store)} />
    <AnimateIcon asChild><button type="button" className="cn-fm-btn" data-mb="del" data-fm-danger="1" onClick={() => deleteSelection(store)}><Icon name="trash" /><span className="cn-fm-label">删除</span></button></AnimateIcon>
    <FloatMenuButton icon="x" label="取消选择" data={{ "data-mb": "cancel" }} onClick={() => store.setUI({ sel: new Set() })} />
  </FloatMenu>;
}

/** 顶部颜色标记栏（TapNow Pin bar）：按颜色分组计数，点一组列出节点，点节点跳过去并选中 */
function PinBar() {
  const ctl = useCtl(); const doc = useS((s) => s.doc);
  const groups = NODE_TAG.map(([k, c]) => ({ k, c, list: doc.nodes.filter((n) => isGenKind(n.kind) && (genOf(n).tag || (genOf(n).pinned ? "red" : "")) === k) })).filter((g) => g.list.length);
  if (!groups.length) return null;
  const open = (el: HTMLElement, g: (typeof groups)[number]) => openPop(el, (close) => <div className="pinlist" data-pin-list={g.k}>
    <div className="mh"><i className="pdot" style={{ background: g.c }} />{TAG_NAME[g.k] || g.k}标记 · {g.list.length} 个节点</div>
    {g.list.map((n) => <NodeRow key={n.id} n={n} onClick={() => { close(); const s = stackOf(doc, n.id); ctl.focusNode(s ? s.id : n.id); }} sub={(textOf(n) || plainPrompt(genOf(n).prompt, doc) || TYPE_LABEL[n.kind as GenKind] || "").slice(0, 40)} />)}
  </div>, "down");
  return <div id="pinbar" className="float cap">
    {groups.map((g) => <button key={g.k} className="pin-g tipB" data-pin={g.k} data-tip={`${TAG_NAME[g.k] || g.k} · ${g.list.length} 个节点`} onClick={(e) => open(e.currentTarget, g)}><i className="pdot" style={{ background: g.c }} /><span className="tnum">{g.list.length}</span></button>)}
  </div>;
}
const TAG_NAME: Record<string, string> = { red: "红色", orange: "橙色", yellow: "黄色", green: "绿色", blue: "蓝色", purple: "紫色" };

/** 顶部进度条：进行中的一键运行（取消选择后也看得到、停得了） */
function BatchRuns() {
  const ctl = useCtl(); const batches = Object.values(useS((s) => s.batches));
  if (!batches.length) return null;
  return <div id="batchruns" className="float">
    {batches.map((b) => <div key={b.key} className="br-item" data-batch={b.key}>
      <span className="runsig" />
      <span className="br-l">一键运行「{b.label}」</span>
      <span className="br-bar"><i style={{ width: `${Math.round(((b.done + b.failed) / Math.max(1, b.total)) * 100)}%` }} /></span>
      <span className="tnum br-n">{b.done + b.failed}/{b.total}{b.failed ? ` · 失败 ${b.failed}` : ""}</span>
      {ctl.store.node(b.key) ? <button className="linkbtn" data-br="focus" onClick={() => ctl.focusNode(b.key)}>查看</button> : null}
      <button className="linkbtn" data-br="stop" disabled={b.stopped} onClick={() => stopGroup(ctl.store, b.key)}>{b.stopped ? "正在停止" : "停止"}</button>
    </div>)}
  </div>;
}

function Minimap() {
  const ctl = useCtl(); const doc = useS((s) => s.doc); const view = useS((s) => s.view); const sel = useS((s) => s.ui.sel); const theme = useS((s) => s.ui.theme);
  // 只关心「哪些节点在生成」：原来订阅整份 runtime，流式生成每个 token 都要重画一遍小地图
  const running = useS((s) => Object.keys(s.runtime).join(","));
  const ref = useRef<HTMLCanvasElement>(null); const geo = useRef<{ ox: number; oy: number; s: number } | null>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const g = c.getContext("2d")!; g.clearRect(0, 0, c.width, c.height);
    const bb = bounds(doc.nodes); if (!bb) return; const r = ctl.rect();
    const vw = { x: -view.x / view.k, y: -view.y / view.k, w: r.width / view.k, h: r.height / view.k };
    const all = { x: Math.min(bb.x, vw.x), y: Math.min(bb.y, vw.y), w: 0, h: 0 }; all.w = Math.max(bb.x + bb.w, vw.x + vw.w) - all.x; all.h = Math.max(bb.y + bb.h, vw.y + vw.h) - all.y;
    const s = Math.min((c.width - 20) / all.w, (c.height - 20) / all.h); const ox = 10 - all.x * s + ((c.width - 20) - all.w * s) / 2, oy = 10 - all.y * s + ((c.height - 20) - all.h * s) / 2; geo.current = { ox, oy, s };
    // 取色只取一次：原来在 forEach 里对每个节点各调两次 getComputedStyle（100 节点 = 200 次强制样式解析/帧）
    const cs = getComputedStyle(document.querySelector(".cn-root") || document.documentElement);
    const ink = cs.getPropertyValue("--ink").trim() || "128,128,128";
    const solid = cs.getPropertyValue("--solid").trim() || "#111";
    const live = new Set(running ? running.split(",") : []);
    const idle = `rgba(${ink},.38)`;
    doc.nodes.forEach((n) => { g.fillStyle = sel.has(n.id) ? solid : live.has(n.id) ? "#8e8e93" : idle; g.fillRect(ox + n.x * s, oy + n.y * s, Math.max(2, n.w * s), Math.max(2, (n.h + 24) * s)); });
    g.strokeStyle = `rgba(${ink},.8)`; g.lineWidth = 2; g.strokeRect(ox + vw.x * s, oy + vw.y * s, vw.w * s, vw.h * s);
    // theme 只为触发重画：颜色全取自 CSS 变量，主题变了要重新取
  }, [doc, view, sel, running, theme, ctl]);
  return <div id="mini" className="float cap"><canvas ref={ref} width={440} height={280} onClick={(e) => { const gg = geo.current; if (!gg) return; const c = e.currentTarget; const rr = c.getBoundingClientRect(); const mx = ((e.clientX - rr.left) / rr.width) * c.width, my = ((e.clientY - rr.top) / rr.height) * c.height; const wx = (mx - gg.ox) / gg.s, wy = (my - gg.oy) / gg.s; const r = ctl.rect(); const v = ctl.store.state.view; ctl.store.setView({ ...v, x: r.width / 2 - wx * v.k, y: r.height / 2 - wy * v.k }); }} /></div>;
}
function BackToNodes() {
  const ctl = useCtl(); const doc = useS((s) => s.doc); const view = useS((s) => s.view); void view;
  if (!doc.nodes.length) return null; const r = ctl.rect();
  const visible = doc.nodes.some((n) => { const a = ctl.toScreen(n.x, n.y), c = ctl.toScreen(n.x + n.w, n.y + n.h + 24); return c.x > r.left && a.x < r.right && c.y > r.top && a.y < r.bottom; });
  if (visible) return null;
  return <div id="back" className="float cap">当前视窗没有节点，可快速回到内容区域<button id="backBtn" onClick={() => ctl.fitTo(doc.nodes)}>回到节点</button></div>;
}

/* ---------- 评论（TapNow：点位置发评论，点开看讨论串、回复；自己的可以编辑 / 删除；↵ 发送，⇧↵ 换行，200 字） ---------- */
const CMT_MAX = 200;
const cmtTime = (t: number) => new Date(t).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" });
/** 评论输入框：↵ 发送，⇧↵ 换行，输入法组字时不发送 */
function CmtInput({ init = "", placeholder, onSend, onCancel, send = "发送" }: { init?: string; placeholder: string; onSend: (t: string) => void; onCancel?: () => void; send?: string }) {
  const [text, setText] = useState(init); const ref = useRef<HTMLTextAreaElement>(null);
  // 放评论时画布的 pointerup 会把焦点抢走：挂载后下一帧再聚焦，光标放到末尾
  useEffect(() => { const id = setTimeout(() => { const el = ref.current; if (!el) return; el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); }, 30); return () => clearTimeout(id); }, []);
  const go = () => { const t = text.trim(); if (!t) return; onSend(t); setText(""); };
  return <div className="cin">
    <textarea ref={ref} maxLength={CMT_MAX} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); } }} />
    <div className="cin-bar"><small className="tnum" title={IS_MAC ? "↵ 发送 · ⇧↵ 换行" : "Enter 发送 · Shift+Enter 换行"}>{text.length}/{CMT_MAX} · {IS_MAC ? "↵ 发送" : "Enter 发送"}</small><span className="grow" />
      {onCancel ? <button className="btn" data-cmt="cancel" onClick={onCancel}>取消</button> : null}
      <button className="btn solid" data-cmt="send" disabled={!text.trim()} onClick={go}>{send}</button></div>
  </div>;
}
function Comments() {
  const ctl = useCtl(); const store = ctl.store; const comments = useS((s) => s.doc.comments); useS((s) => s.view);
  const [open, setOpen] = useState<string | null>(null); const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { const on = (e: Event) => { setDraft((e as CustomEvent).detail); setOpen(null); setEditing(null); }; addEventListener("cn:place-comment", on); return () => removeEventListener("cn:place-comment", on); }, []);
  const me = ctl.host.user?.name || "我";
  const mine = (a?: string) => !a || a === me;
  const r = ctl.rect(); const pos = (x: number, y: number) => { const s = ctl.toScreen(x, y); return { left: s.x - r.left, top: s.y - r.top }; };
  /** 气泡默认在图钉右边，靠右放不下就放左边；上下不出画布 */
  const bub = (x: number, y: number, w = 300, h = 300) => { const p = pos(x, y); const left = p.left + 30 + w > r.width - 12 ? p.left - w - 12 : p.left + 30; return { left: Math.max(12, left), top: Math.max(12, Math.min(p.top - 30, r.height - h - 12)) }; };
  // 编号按发出时间，不受同步顺序影响
  const ordered = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  const openC = comments.find((c) => c.id === open);
  const patchC = (id: string, f: (c: CanvasComment) => CanvasComment | null) => store.mutate((d) => ({ ...d, comments: d.comments.flatMap((c) => { if (c.id !== id) return [c]; const n = f(c); return n ? [n] : []; }) }), { history: true });
  const menu = (el: HTMLElement, edit: () => void, del: () => void) => openPop(el, (close) => <>
    <button className="mi" data-cmt="edit" onClick={() => { close(); edit(); }}><Icon name="pencil" size="s" />编辑</button>
    <button className="mi danger" data-cmt="del" onClick={() => { close(); del(); }}><Icon name="trash" size="s" />删除</button>
  </>, "down", "right");
  const Msg = ({ id, author, text, at, edited, onEdit, onDel }: { id: string; author?: string; text: string; at: number; edited?: number; onEdit: (t: string) => void; onDel: () => void }) => <div className="cmsg" data-cmsg={id}>
    <div className="cmsg-h"><span className="cav">{(author || "协")[0]}</span><b>{author || "协作者"}</b><small>{cmtTime(at)}{edited ? " · 已编辑" : ""}</small><span className="grow" />
      {mine(author) && editing !== id ? <button className="ib" data-cmt="more" aria-label="更多" onClick={(e) => menu(e.currentTarget, () => setEditing(id), onDel)}><Icon name="more" size="s" /></button> : null}</div>
    {editing === id ? <CmtInput init={text} placeholder="修改评论…" send="保存" onCancel={() => setEditing(null)} onSend={(t) => { onEdit(t); setEditing(null); }} /> : <div className="cmsg-t">{text}</div>}
  </div>;
  return <div id="cmts" onPointerDown={(e) => e.stopPropagation()}>
    {ordered.map((c, i) => <button key={c.id} className={"cpin" + (open === c.id ? " on" : "")} data-cpin={c.id} style={pos(c.x, c.y)} onClick={() => { setDraft(null); setEditing(null); setOpen(open === c.id ? null : c.id); }}>{i + 1}{c.replies?.length ? <i className="crn tnum">{c.replies.length}</i> : null}</button>)}
    {draft ? <div className="cbubble" style={bub(draft.x, draft.y, 290, 140)}>
      <CmtInput placeholder="输入你的评论…" onCancel={() => setDraft(null)} onSend={(said) => {
        const made: CanvasComment = { id: uid("c"), x: Math.round(draft.x), y: Math.round(draft.y), text: said, createdAt: Date.now(), clientId: "local", author: me };
        store.mutate((d) => ({ ...d, comments: [...d.comments, made] }), { history: true });
        setDraft(null); setOpen(made.id);
      }} />
    </div> : null}
    {openC ? <div className="cbubble thread" data-thread={openC.id} style={bub(openC.x, openC.y, 300, 120 + 70 * Math.min(4, 1 + (openC.replies?.length || 0)))}>
      <div className="cthread">
        <Msg id={openC.id} author={openC.author} text={openC.text} at={openC.createdAt} edited={openC.editedAt}
          onEdit={(t) => patchC(openC.id, (c) => ({ ...c, text: t, editedAt: Date.now() }))}
          onDel={() => { patchC(openC.id, () => null); setOpen(null); }} />
        {(openC.replies || []).map((rp) => <Msg key={rp.id} id={rp.id} author={rp.author} text={rp.text} at={rp.createdAt} edited={rp.editedAt}
          onEdit={(t) => patchC(openC.id, (c) => ({ ...c, replies: (c.replies || []).map((x) => (x.id === rp.id ? { ...x, text: t, editedAt: Date.now() } : x)) }))}
          onDel={() => patchC(openC.id, (c) => ({ ...c, replies: (c.replies || []).filter((x) => x.id !== rp.id) }))} />)}
      </div>
      <CmtInput key={openC.id} placeholder="回复…" onSend={(t) => patchC(openC.id, (c) => ({ ...c, replies: [...(c.replies || []), { id: uid("r"), text: t, createdAt: Date.now(), clientId: "local", author: me }] }))} />
    </div> : null}
  </div>;
}

/* ---------- 抽屉：素材 / 历史 ---------- */
function Drawer({ kind }: { kind: "assets" | "history" }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc); const runs = useS((s) => s.runs);
  const [type, setType] = useState("all"); const [q, setQ] = useState(""); const [target, setTarget] = useState<string | null>(null);
  useEffect(() => { const on = (e: Event) => setTarget((e as CustomEvent).detail); addEventListener("cn:lib-link", on); return () => removeEventListener("cn:lib-link", on); }, []);
  const close = () => store.setUI({ drawer: null });
  if (kind === "history") return <HistoryDrawer close={close} />;
  const assets = doc.nodes.filter((n) => (n.kind === "image" || n.kind === "video") && outOf(n) && (!q || title(n).includes(q)));
  const favs = assets.filter((n) => genOf(n).fav);
  const link = target ? store.node(target) : null;
  const use = (n: CanvasNode) => {
    const at = link || null; const c = at ? { x: at.x - 330, y: at.y + 100 } : ctl.center();
    const made = store.newNode(n.kind as GenKind, c.x - 120, c.y - 120, { title: genOf(n).title, uploaded: true, hist: [outOf(n)!], w: n.w, h: n.h });
    store.addNodes([made], at ? [{ id: uid("e"), from: made.id, to: at.id }] : [], { select: !at });
    if (at) { store.setUI({ sel: new Set([at.id]) }); setTarget(null); store.toast(`已作为「${title(at)}」的输入`); } else store.toast("已添加到画布");
  };
  return <div className="drawer float" id="drawer" onPointerDown={(e) => e.stopPropagation()}>
    <div className="dh"><Icon name="folder" size="s" />素材库<span className="sp" /><button className="ib" style={{ width: 28, height: 28 }} onClick={() => { setTarget(null); close(); }}><Icon name="x" size="s" /></button></div>
    <div className="dsearch"><Icon name="search" size="s" /><input placeholder="搜索素材" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="dbody">
      {link ? <div className="gp-warn" style={{ margin: "0 0 8px" }}><Icon name="link" size="s" /><span>点一张素材，作为「{title(link)}」的输入</span></div> : null}
      <LibrarySection q={q} />
      <ElementsSection q={q} />
      <div className="sec"><span>收藏</span><span className="tnum">{favs.length}</span></div>
      <div className="agrid">{favs.map((n) => <Asset key={n.id} n={n} onUse={use} />)}</div>
      <div className="sec"><span>本画布素材</span><span className="tnum">{assets.length}</span></div>
      <div className="agrid">{assets.map((n) => <Asset key={n.id} n={n} onUse={use} />)}</div>
    </div>
  </div>;
}

/** 生成历史（TapNow History）：本画布 / 全部项目，类型筛选、搜索，多选放到画布或打包下载 */
function HistoryDrawer({ close }: { close: () => void }) {
  const ctl = useCtl(); const store = ctl.store; const runs = useS((s) => s.runs);
  const [scope, setScope] = useState<"canvas" | "all">("canvas"); const [type, setType] = useState<HistFilter["type"]>("all"); const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const all = useMemo(() => historyItems(store, scope), [store, scope, runs]);
  const list = filterHistory(all, { type, q, status: "all" });
  const chosen = all.filter((r) => picked.has(r.id) && usable(r));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toNodes = () => { const c = ctl.center(); const cols = Math.ceil(Math.sqrt(chosen.length)); return chosen.map((r, i) => histNode(store, r, c.x - 150 + (i % cols) * 320, c.y - 150 + Math.floor(i / cols) * 320)).filter((n): n is CanvasNode => !!n); };
  const apply = () => { const ns = clearOf(store.state.doc.nodes, toNodes()); if (!ns.length) return; store.addNodes(ns, [], { select: true }); setPicked(new Set()); store.toast(`已放到画布：${ns.length} 个结果`); };
  const dl = () => { const ns = toNodes(); if (ns.length) void downloadMany(ns, store, "生成历史"); };
  const open = (r: HistItem) => {
    if (r.current) return store.node(r.node) ? ctl.focusNode(r.node) : usable(r) ? toggle(r.id) : store.toast("这个节点已经被删除");
    if (usable(r)) toggle(r.id); else store.toast(`来自「${r.canvasName}」，没有可用的结果`);
  };
  return <div className="drawer float" id="drawer" data-history-scope={scope} onPointerDown={(e) => e.stopPropagation()}>
    <div className="dh"><Icon name="history" size="s" />生成历史<span className="sp" />
      <div className="seg hscope">{([["canvas", "本画布"], ["all", "全部项目"]] as const).map(([k, l]) => <button key={k} data-scope={k} className={scope === k ? "on" : ""} onClick={() => { setScope(k); setPicked(new Set()); }}>{l}</button>)}</div>
      <button className="ib" style={{ width: 28, height: 28 }} onClick={close}><Icon name="x" size="s" /></button></div>
    <div className="dsearch"><Icon name="search" size="s" /><input placeholder="搜索标题、提示词、模型或画布" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="tabs">{([["all", "全部"], ["image", "图片"], ["video", "视频"], ["audio", "音频"], ["text", "文本"]] as const).map(([k, l]) => <button key={k} className={type === k ? "on" : ""} onClick={() => setType(k)}>{l}</button>)}</div>
    <div className="dbody">
      {list.map((r) => { const ok = usable(r); const on = picked.has(r.id); return <div key={r.canvasId + r.id} className={"hrow" + (on ? " on" : "")} data-run={r.id} onClick={() => open(r)}>
        {ok ? <button className={"hpick" + (on ? " on" : "")} aria-label={on ? "取消选择" : "选择"} aria-pressed={on} onClick={(e) => { e.stopPropagation(); toggle(r.id); }}>{on ? <Icon name="check" size="xs" /> : null}</button> : <span className="hpick off" />}
        <span className="th">{r.thumb || r.out?.frame || (r.type === "image" ? r.out?.url : "") ? <Thumb src={r.thumb || r.out?.frame || r.out?.url || ""} /> : <Icon name={r.type === "table" ? "grid" : TYPE_ICON[r.type]} size="s" />}</span>
        <span className="m"><b>{r.title}</b><small>{scope === "all" ? (r.current ? "本画布" : r.canvasName) + " · " : ""}{r.model} · {r.status === "done" ? r.secs + "s" : r.status === "stopped" ? "已停止" : "失败"} · {histTime(r)}</small></span>
        <span style={{ color: "var(--fg3)" }}><Icon name={r.status === "done" ? "check" : "x"} size="s" /></span>
      </div>; })}
      {list.length ? null : <p style={{ color: "var(--fg3)", fontSize: 12, padding: 12 }}>{q || type !== "all" ? "没有符合条件的记录" : scope === "all" ? "所有项目都还没有生成记录" : "还没有生成记录"}</p>}
    </div>
    {chosen.length ? <div className="hbar"><span>已选 {chosen.length}</span><span className="sp" /><button className="btn ghost" onClick={() => setPicked(new Set())}>取消</button><button className="btn ghost" data-hdl onClick={dl}><Icon name="download" size="s" />下载</button><button className="btn solid" data-happly onClick={apply}><Icon name="plus" size="s" />放到画布</button></div> : null}
  </div>;
}

function Asset({ n, onUse }: { n: CanvasNode; onUse: (n: CanvasNode) => void }) {
  const store = useCtl().store; const src = srcOf(n); const fav = genOf(n).fav;
  // 抽屉一行三格、每格约 100px：挂缩略图就够。之前挂原图，30 张 4K 就是 1.4GB 位图，抽屉一开就卡
  return <div className="a" title={title(n)} onClick={() => onUse(n)}>
    {src ? <ThumbImg src={src} width={100} fallback={null} /> : null}
    <button className={"fav" + (fav ? " on" : "")} onClick={(e) => { e.stopPropagation(); store.patchGen(n.id, { fav: !fav }); }}><Icon name="star" size="xs" /></button>
  </div>;
}

// 历史列表行 42px 小图：缩略图 256 档足够
function Thumb({ src }: { src: string }) { return <ThumbImg src={src} width={42} fallback={null} />; }

/** 全屏里的一格版本缩略图：地址要过 useAssetUrl，所以单独成组件；取不到地址时给占位块 */
function LbThumb({ src }: { src: string }) { return <ThumbImg src={src} width={88} fallback={<span className="lb-thumb-ph" />} />; }

function FilesPanel() {
  const ctl = useCtl(); const doc = useS((s) => s.doc); const runtime = useS((s) => s.runtime);
  const files = doc.nodes.filter((n) => isGenKind(n.kind) && genOf(n).agent);
  return <div id="files" className="float" onPointerDown={(e) => e.stopPropagation()}>
    <div className="fh"><Icon name="folder" size="s" />文件<span className="sp" /><button className="ib" style={{ width: 26, height: 26 }} onClick={() => ctl.store.setUI({ filesOpen: false })}><Icon name="x" size="s" /></button></div>
    {files.length ? files.map((n) => <NodeRow key={n.id} n={n} onClick={() => ctl.focusNode(n.id)} sub={`${TYPE_LABEL[n.kind as GenKind]} · ${runtime[n.id] ? "生成中" : outOf(n) ? "已完成" : "待生成"}`} />)
      : <div className="empty">暂无输出。Agent 在画布上创建的节点会列在这里。</div>}
  </div>;
}

export function Toasts() {
  const toasts = useS((s) => s.toasts);
  return <div id="toasts">{toasts.map((t) => <div key={t.id} className={"toast" + (t.out ? " out" : "") + (t.action ? " is-action" : "")} onClick={t.action ? () => { t.action?.(); } : undefined} role={t.action ? "button" : undefined} dangerouslySetInnerHTML={{ __html: escToast(t.html) }} />)}</div>;
}
const TOAST_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escToast = (html: string) => html.replace(/[&<>"]/g, (c) => TOAST_ESC[c] || c);

export function Lightbox() {
  const ctl = useCtl(); const [id, setId] = useState<string | null>(null); const doc = useS((s) => s.doc);
  const [commentOpen, setCommentOpen] = useState(false);
  useEffect(() => { const on = (e: Event) => setId((e as CustomEvent).detail); addEventListener("cn:lightbox", on); return () => removeEventListener("cn:lightbox", on); }, []);
  const [out, setOut] = useState(false);
  const [cmp, setCmp] = useState(false);
  const [cmpPct, setCmpPct] = useState(50);
  const [wipeDrag, setWipeDrag] = useState(false);
  // .lb-cmp 既是缩放 / 平移的变换层（就是 zoom.imgRef），也是分割线百分比的计算基准
  const cmpRef = useRef<HTMLDivElement | null>(null);
  // 右侧信息栏贴着图片包围盒的右边：缩放 / 平移 / 换节点后重量一次，夹在视口内
  const [infoAt, setInfoAt] = useState<{ left: number; top: number } | null>(null);
  // 左侧版本缩略图条也贴着图片包围盒：同一支定位里一起算
  const [stripAt, setStripAt] = useState<{ left: number; top: number } | null>(null);
  // 「对比原图」按钮贴在图片包围盒的右下角：right / bottom 是相对舞台的偏移
  const [corner, setCorner] = useState<{ right: number; bottom: number } | null>(null);
  const cmpBtnRef = useRef<HTMLButtonElement | null>(null);
  // 视频 / 文本 / 音频卡片的包围盒：这一支没有 <img>，信息栏按它定位
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => { if (id) { setOut(false); setCommentOpen(false); } }, [id]);
  useLayoutEffect(() => {
    if (!commentOpen) { setImgRect(null); return; }
    zoom.reset();
    const measure = () => {
      const el = zoom.imgRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      setImgRect((p) => (p && Math.abs(p.x - r.left) < 1 && Math.abs(p.y - r.top) < 1 && Math.abs(p.w - r.width) < 1 && Math.abs(p.h - r.height) < 1 ? p : { x: r.left, y: r.top, w: r.width, h: r.height }));
    };
    measure();
    const t = window.setTimeout(measure, 240);
    window.addEventListener("resize", measure);
    return () => { window.clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [commentOpen]);
  useEffect(() => { setCmp(false); }, [id]);
  useEffect(() => { setNatural(null); setVideoSize(null); }, [id]);
  useEffect(() => { if (cmp) setCmpPct(50); }, [cmp]);
  const node = id ? doc.nodes.find((n) => n.id === id) : null;
  const gen = node && isGenKind(node.kind) ? genOf(node) : null;
  const cur = gen ? gen.hist[gen.hi] : undefined;
  const imgSrc = gen && node && (node.kind === "image" || (node.kind === "video" && !cur?.url)) ? cur?.url || cur?.frame || "" : "";
  const imgUrl = useAssetUrl(imgSrc);
  const zoom = useLbZoom(imgSrc);
  const [imgRect, setImgRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // 「对比原图」：原图 = 生成前的那张图（来源节点结果 → 其它上游输入图 → 最后第一版）；视频/音频/提示词没有（null）
  const compare = useMemo(() => {
    if (!node || !gen || node.kind !== "image") return null;
    // 来源节点：点「生成」时记在新节点 data.sourceNodeId 上，它的当前结果就是生成前的图
    const sid = (node.data as { sourceNodeId?: unknown } | undefined)?.sourceNodeId;
    const from = typeof sid === "string" ? doc.nodes.find((x) => x.id === sid) : null;
    const source = from ? outOf(from)?.url || outOf(from)?.frame : "";
    const inputs = expandGroupInputs(doc, inputsOf(doc, node.id)).map((x) => outOf(x.node)?.url || outOf(x.node)?.frame || "");
    return compareOriginal({ kind: node.kind, hist: gen.hist, hi: gen.hi, inputs, source });
  }, [node, gen, doc]);
  const cmpOriginalUrl = useAssetUrl(compare?.original || "");
  const cmpCurrentUrl = useAssetUrl(compare?.current || "");
  const comparing = cmp && !!compare;
  const setCmpEl = useCallback((el: HTMLDivElement | null) => { cmpRef.current = el; zoom.assignImg(el); }, [zoom.assignImg]);
  // 进出对比态时 imgRef 换到了另一个元素上：重量一次，百分比读数和拖拽边界才跟着它走
  useLayoutEffect(() => { zoom.onLoad(); }, [comparing, zoom.onLoad]);
  // 信息栏位置：left = clamp(图片右边缘 + 48, 视口中线 + 150, 视口宽 - 280)，top = max(64, 图片顶)
  // 缩略图条位置：贴在图片左边缘左侧 40px，但不越过视口中线（避免压住图片），top 跟随图片中心
  useLayoutEffect(() => {
    const vw = innerWidth;
    const el = zoom.imgRef.current || cardRef.current;
    const r = el ? el.getBoundingClientRect() : null;
    const left = r && r.width ? Math.max(vw * .5 + 150, Math.min(r.right + 48, vw - 280)) : vw - 280;
    const top = r && r.height ? Math.max(64, r.top) : 64;
    setInfoAt((prev) => prev && Math.abs(prev.left - left) < 1 && Math.abs(prev.top - top) < 1 ? prev : { left, top });
    const STRIP_W = 88; // 88 = 缩略图宽度（无外层 padding）
    const sl = Math.max(20, r && r.width ? Math.min(r.left - 40 - STRIP_W, vw * .5 - STRIP_W - 24) : 20);
    const st = r && r.height ? Math.max(120, Math.min(r.top + r.height / 2, innerHeight - 120)) : innerHeight * .5;
    setStripAt((prev) => prev && Math.abs(prev.left - sl) < 1 && Math.abs(prev.top - st) < 1 ? prev : { left: sl, top: st });
  });
  // 「对比原图」：贴在图片右下角内侧 10px；图片被缩放 / 平移出舞台时夹回舞台内，别让 overflow:hidden 裁掉
  const measureCorner = useCallback(() => {
    const stage = zoom.stageRef.current, img = zoom.imgRef.current, btn = cmpBtnRef.current;
    if (!stage || !img || !btn) return;
    const s = stage.getBoundingClientRect(), i = img.getBoundingClientRect();
    if (!s.width || !s.height || !i.width || !i.height) return;
    const right = Math.max(10, Math.min(s.right - i.right + 10, s.width - btn.offsetWidth - 10));
    const bottom = Math.max(10, Math.min(s.bottom - i.bottom + 10, s.height - btn.offsetHeight - 10));
    setCorner((prev) => prev && Math.abs(prev.right - right) < 1 && Math.abs(prev.bottom - bottom) < 1 ? prev : { right, bottom });
  }, []);
  useLayoutEffect(() => { measureCorner(); });
  useEffect(() => { addEventListener("resize", measureCorner); return () => removeEventListener("resize", measureCorner); }, [measureCorner]);
  if (!node || !isGenKind(node.kind) || !gen) return null;
  const g = gen; const o = cur;
  const close = () => { setOut(true); setTimeout(() => setId(null), 160); };
  const step = (d: number) => ctl.store.patchGen(node.id, { hi: (g.hi + d + g.hist.length) % g.hist.length });
  // wipe 对比：左半边原图、右半边当前；适应窗口时按住任意位置左右拖动，放大后只有线附近 / 圆钮能拖
  const wipeAt = (clientX: number) => {
    const el = cmpRef.current; if (!el) return;
    const r = el.getBoundingClientRect(); if (!r.width) return;
    setCmpPct(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  /** 指针是否落在这条分割线上（±24px，屏幕像素）：放大后只有这里才接分割拖动 */
  const onWipeLine = (clientX: number) => {
    const el = cmpRef.current; if (!el) return true;
    const r = el.getBoundingClientRect(); if (!r.width) return true;
    return Math.abs(clientX - (r.left + r.width * cmpPct / 100)) <= 24;
  };
  // 适应窗口时整块拖动 = 拖分割线；放大后按在线外的地方不拦，让事件冒泡给舞台做平移
  const onCmpDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (zoom.s > 1.001 && !onWipeLine(e.clientX)) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setWipeDrag(true); wipeAt(e.clientX);
  };
  const onCmpMove = (e: RPointerEvent<HTMLDivElement>) => { if (!wipeDrag) return; wipeAt(e.clientX); };
  const onCmpUp = (e: RPointerEvent<HTMLDivElement>) => { if (!wipeDrag) return; setWipeDrag(false); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
  const onKnobKey = (e: RKeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault(); e.stopPropagation();
    setCmpPct((v) => Math.max(0, Math.min(100, v + (e.key === "ArrowLeft" ? -2 : 2))));
  };
  const onImgLoad = () => {
    zoom.onLoad();
    const el = zoom.imgRef.current;
    // 对比态 imgRef 是 .lb-cmp 包裹层，真实像素要从里面的图取
    const img = el instanceof HTMLImageElement ? el : el?.querySelector("img") ?? null;
    if (img) setNatural((p) => p && p.w === img.naturalWidth && p.h === img.naturalHeight ? p : { w: img.naturalWidth, h: img.naturalHeight });
  };
  const compareBtn = (at?: { right: number; bottom: number }) => <button ref={cmpBtnRef} className="lb-cmp-btn" data-lb="compare" style={at ? { right: at.right, bottom: at.bottom } : undefined} aria-pressed={comparing} disabled={!compare}
    title={compare ? (comparing ? "退出对比，回到正常查看" : compare.from === "version" ? "拖动分割线对比第一版（原图）" : "拖动分割线对比生成前的原图") : "没有可比的原图"}
    onClick={(e) => { e.stopPropagation(); setCmp((v) => !v); }} onPointerDown={(e) => e.stopPropagation()}>
    <Icon name="split" size="xs" /><span>对比原图</span>
  </button>;
  const fav = g.fav === true;
  const wh = (w?: number, h?: number) => (w && h ? w + " × " + h : "");
  // 分辨率：当前版本自带宽高 → meta.size（把两边的 × 规范成一个空格）→ 图片/视频的真实像素
  const resText = wh(o?.w, o?.h) || (o?.meta?.size ? o.meta.size.replace(/\s*[x×*]\s*/gi, " × ") : "") || wh(natural?.w, natural?.h) || wh(videoSize?.w, videoSize?.h);
  const modelText = o?.meta?.model || "";
  const at = o?.meta?.at || 0; const dt = at ? new Date(at) : null;
  const dateText = dt ? dt.getFullYear() + "/" + (dt.getMonth() + 1) + "/" + dt.getDate() : "";
  const showVer = g.hist.length > 1 && node.kind !== "text";
  return <div className={"lightbox" + (commentOpen ? " commenting" : "")} id="lightbox" tabIndex={-1} ref={(el) => { if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus(); }}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && g.hist.length > 1) ctl.store.patchGen(node.id, { hi: (g.hi + (e.key === "ArrowLeft" ? -1 : 1) + g.hist.length) % g.hist.length }); if (imgSrc && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_" || e.key === "0")) { e.preventDefault(); if (e.key === "0") zoom.reset(); else zoom.zoomBy(e.key === "-" || e.key === "_" ? .8 : 1.25); } }}
    style={out ? { animation: "fadeOut 160ms var(--e-exit) forwards" } : undefined}
    onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <button className="lb-back tipR" data-lb="back" data-tip="返回画布" aria-label="返回画布" onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); close(); setTimeout(() => ctl.focusNode(node.id), 170); }}><Icon name="arrowleft" /></button>
    {!comparing && g.hist.length > 1 && (node.kind === "image" || node.kind === "video") ? <div className="lb-thumbs" data-lb="thumbs" onPointerDown={(e) => e.stopPropagation()}
      style={{ "--lb-sx": stripAt ? stripAt.left + "px" : "20px", "--lb-sy": stripAt ? stripAt.top + "px" : "50%" } as CSSProperties}>
      {g.hist.map((h, i) => <button key={i} className={"lb-thumb tipR" + (i === g.hi ? " on" : "")} aria-pressed={i === g.hi} data-tip={"第 " + (i + 1) + " 版"} aria-label={"第 " + (i + 1) + " 版"}
        onClick={(e) => { e.stopPropagation(); ctl.store.patchGen(node.id, { hi: i }); }}><LbThumb src={h.url || h.frame || ""} /></button>)}
    </div> : null}
    {node.kind === "text" ? <div className="lb-mid" ref={cardRef}><div className="txt">{o?.text}</div></div>
      : node.kind === "audio" ? <div className="lb-mid" ref={cardRef}><div className="txt">音频 · {o?.dur}s</div></div>
      : node.kind === "video" && o?.url ? <div className="lb-mid" ref={cardRef}><BigVideo src={o.url} onSize={(w, h) => setVideoSize((p) => p && p.w === w && p.h === h ? p : { w, h })} /></div>
      : <div className={zoom.stageClass} ref={zoom.stageRef} data-lb="view" onDragStart={(e) => e.preventDefault()}
          onClick={(e) => { if (e.target === e.currentTarget && zoom.isBackdrop() && !zoom.wasDragged()) close(); }}
          onPointerDown={zoom.onPointerDown} onPointerMove={zoom.onPointerMove} onPointerUp={zoom.endDrag} onPointerCancel={zoom.endDrag}
          onDoubleClick={zoom.toggleFit}>
        {comparing
          // 对比态也活在同一个 .lb-stage 里：.lb-cmp 直接吃 zoom.imgStyle，缩放 / 平移 / 双击 / 键盘全部复用
          ? <div className={"lb-cmp" + (wipeDrag ? " drag" : "")} data-lb="compare-view" ref={setCmpEl}
              style={{ ...zoom.imgStyle, "--lb-z": 1 / zoom.s } as CSSProperties}
              onPointerDown={onCmpDown} onPointerMove={onCmpMove} onPointerUp={onCmpUp} onPointerCancel={onCmpUp}>
              {cmpCurrentUrl ? <img className="lb-cmp-cur" src={cmpCurrentUrl} alt="当前" draggable={false} onLoad={onImgLoad} /> : null}
              {cmpOriginalUrl ? <img className="lb-cmp-top" src={cmpOriginalUrl} alt="原图" draggable={false} style={{ clipPath: "inset(0 " + (100 - cmpPct) + "% 0 0)" }} /> : null}
              <span className="lb-cmp-tag">原图</span>
              <span className="lb-cmp-tag right">当前</span>
              <div className="lb-cmp-div" style={{ left: cmpPct + "%" }} aria-hidden="true">
                <span className="lb-cmp-knob" role="slider" tabIndex={0} aria-label="左右拖动对比原图与当前" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(cmpPct)} onKeyDown={onKnobKey} />
              </div>
            </div>
          : imgUrl ? <img className={zoom.imgClass} ref={zoom.assignImg} src={imgUrl} alt="" draggable={false} style={zoom.imgStyle} onLoad={onImgLoad} /> : null}
        {node.kind === "image" ? compareBtn(comparing ? undefined : (corner || undefined)) : null}
      </div>}
    {comparing ? null : <div className="lb-info" style={{ "--lb-x": (infoAt?.left ?? 0) + "px", "--lb-y": (infoAt?.top ?? 64) + "px" } as CSSProperties}>
      <div className="lb-facts">
        {resText ? <div className="lb-group" data-lb="res"><span className="lb-k">分辨率</span><span className="lb-v">{resText}</span></div> : null}
        {modelText ? <div className="lb-group" data-lb="model"><span className="lb-k">模型</span><span className="lb-v">{modelText}</span></div> : null}
        {dateText ? <div className="lb-group" data-lb="date"><span className="lb-k">日期</span><span className="lb-v">{dateText}</span></div> : null}
      </div>
      {showVer ? <div className="lb-acts">
        <div className="lb-ver" data-lb="ver"><span>版本 {g.hi + 1}/{g.hist.length}</span>
          <button className="lb-rnd" data-lb="prev" title="上一版（←）" aria-label="上一版" onClick={() => step(-1)}><Icon name="left" size="xs" /></button>
          <button className="lb-rnd" data-lb="next" title="下一版（→）" aria-label="下一版" onClick={() => step(1)}><Icon name="right" size="xs" /></button>
        </div>
      </div> : null}
    </div>}
    <div className="lb-tools">
      {node.kind === "image" && imgUrl ? <button className={"lb-btn" + (commentOpen ? " on" : "")} data-lb="comment" data-tip="评论标注" aria-label="评论标注" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setCmp(false); setCommentOpen((v) => !v); }}><Icon name="msg" /></button> : null}
      {node.kind !== "text" && (o?.url || o?.frame) ? <button className="lb-btn" data-lb="apply" data-tip="放到画布" aria-label="放到画布" onClick={() => { const made = extractCurrentVersion(ctl.store, node.id); close(); if (made) setTimeout(() => ctl.focusNode(made.id), 170); }}><Icon name="copy" /></button> : null}
      {node.kind !== "text" && o?.url ? <button className="lb-btn" data-lb="dl" data-tip="下载原图" aria-label="下载" onClick={() => void download(node, ctl.store)}><Icon name="download" /></button> : null}
      <button className={"lb-btn" + (fav ? " on" : "")} data-lb="fav" aria-pressed={fav} data-tip={fav ? "取消收藏" : "收藏"} aria-label={fav ? "取消收藏" : "收藏"} onClick={() => ctl.store.patchGen(node.id, { fav: !fav })}><Icon name="star" /></button>
      {imgSrc && zoom.pct > 100 ? <button className="lb-pct" data-lb="zoom" data-tip="回到适应窗口" aria-label={"当前缩放 " + zoom.pct + "%，点击适应窗口"} onClick={zoom.reset}>{zoom.pct}%</button> : null}
    </div>
    {commentOpen && imgUrl ? <CommentMode rect={imgRect} nodeId={node.id} nodeTitle={title(node)} image={natural ? { w: natural.w, h: natural.h } : undefined}
      onClose={() => setCommentOpen(false)}
      onCommit={(payload) => { setCommentOpen(false); window.dispatchEvent(new CustomEvent("cn:annotations-to-chat", { detail: payload })); close(); }} /> : null}
  </div>;
}
function BigVideo({ src, onSize }: { src: string; onSize?: (w: number, h: number) => void }) {
  const m = useMediaUrl(src);
  return m.url ? <video className="big" src={m.url} controls autoPlay onError={m.onError}
    onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) onSize?.(v.videoWidth, v.videoHeight); }} /> : null;
}
