/**
 * 画布四周的浮层：左上标题、右上按钮、左侧工具栏、底部缩放条、小地图、空状态 / 回到节点、
 * 评论、抽屉（素材 / 历史）、搜索 / 模板对话框、文件面板、Agent 收起时的圆球、提示条、全屏查看。
 */
import { shareMenu, SharePanels } from "./SharePanels";
import { LibrarySection } from "./Library";
import { ElementsSection } from "./Elements";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clearOf, filterHistory, histNode, historyItems, histTime, usable, type HistFilter, type HistItem } from "../history";
import { createPortal } from "react-dom";
import type { CanvasComment, CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { renderCanvasThumb } from "../../react-canvas/exportCanvas";
import { alignSelection, deleteSelection, extractCurrentVersion, title } from "../actions";
import { runNode, stopGroup } from "../engine";
import { minimapVisible } from "./minimap";
import { download, downloadMany } from "./menus";
import { isStack, stackOf, stackSelection } from "../stack";
import { groupSelection, ungroup } from "./LegacyNodes";
import { groupName, groupsOf, membersOf, searchNodes, type SearchKind, type SearchScope } from "../search";
import { groupLabel, runKeyOf, runnableIds, runNodes, saveAsTemplate } from "./StackNode";
import { bounds, defaultParams, genOf, NODE_TAG, inputsOf, isGenKind, outOf, srcOf, textOf, TYPE_ICON, TYPE_LABEL, uid, type AnyParams, type GenKind, type TextParams, type VideoMode, type VideoParams } from "../model";
import { emptyTable, withTable } from "../table";
import { plainPrompt } from "../mentions";
import { useCtl, useS, type Ctl } from "./ctx";
import { EdgeBadge } from "./Edges";
import { Icon, Logo } from "./Icon";
import { addMenu } from "./menus";
import { ModalHead, openModal, openPop } from "./overlay";
import { computeExportBounds, exportCanvas, exportFileName, exportPixels, pickExportNodes, saveCanvasBlob, type ExportFormat, type ExportRange } from "../exportCanvas";
import { applyTheme } from "./theme";
import { clipable, createTimelineFrom } from "../playlist";
import { useAssetUrl } from "./useAsset";
import { useMediaUrl } from "./useMedia";
import { deletePersonalTemplate, loadPersonalTemplates, savePersonalTemplate } from "../personalTemplates";

export function Chrome() {
  const ctl = useCtl(); const store = ctl.store;
  const ui = useS((s) => s.ui); const name = useS((s) => s.name); const runs = useS((s) => s.runs); const nodes = useS((s) => s.doc.nodes); const view = useS((s) => s.view); const saving = useS((s) => s.saving); const peers = useS((s) => s.collab.peers);
  const [renaming, setRenaming] = useState(false);
  const zoomPct = Math.round(view.k * 100);
  const showMini = minimapVisible(ui.mini, view.k);
  return <>
    <div id="tl" className="float cap">
      <span className="logo"><Logo /></span><span className="sep" />
      {renaming ? <input className="ttl" id="ttlIn" autoFocus defaultValue={name} onBlur={(e) => { store.set({ name: e.target.value.trim() || name }); setRenaming(false); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }} />
        : <span className="ttl" id="ttl" title="点击重命名" onClick={() => setRenaming(true)}>{name}</span>}
      <button className="ib tipB" style={{ width: 28, height: 28 }} id="canvasMenu" data-tip="切换画布 · 设置" onClick={(e) => canvasMenu(ctl, e.currentTarget, () => setRenaming(true))}><Icon name="down" size="s" /></button>
      <SaveStatus saving={saving} />
      {ctl.host.badge ? <span className="badge-preview">{ctl.host.badge}</span> : null}
    </div>
    <div id="tr" className="float">
      <div className="cap"><button id="extBtn" className="sq tipB" data-tip="扩展" aria-label="扩展" onClick={(e) => openPop(e.currentTarget, (close) => <>
        <div className="mh">扩展</div>
        <button className="mi" data-ext="skills" onClick={() => { close(); if (ctl.host.openApp) ctl.host.openApp("skills"); else store.toast("Skill 中心要在桌面版里打开"); }}><Icon name="sparkle" size="s" />Skill 中心<span className="k">技能市场</span></button>
        <button className="mi" data-ext="mcp" onClick={() => { close(); if (ctl.host.openMcpCenter) ctl.host.openMcpCenter(); else store.toast("MCP 中心要在桌面版里打开"); }}><Icon name="plug" size="s" />MCP 中心<span className="k">已接入的工具</span></button>
        <button className="mi" data-ext="models" onClick={() => { close(); if (ctl.host.openModelSettings) ctl.host.openModelSettings(); else store.toast("模型与 API 要在桌面版里打开"); }}><Icon name="settings" size="s" />模型与 API</button>
      </>, "down", "right")}><Icon name="plug" /></button></div>
      {ctl.host.features?.organization === false ? null : <div className="cap"><button id="orgBtn" className="sq tipB" data-tip="社区 · 组织治理" aria-label="社区" onClick={() => { if (ctl.host.openApp) ctl.host.openApp("organization"); else store.toast("社区 / 组织治理要在桌面版里打开"); }}><Icon name="share" /></button></div>}
      <div className="cap"><button id="usage" className="tipB" data-tip="本画布模型调用" onClick={(e) => { const c: Record<string, number> = { image: 0, video: 0, text: 0, audio: 0 }; runs.forEach((r) => (c[r.type] = (c[r.type] || 0) + 1)); openPop(e.currentTarget, () => <><div className="mh">本画布模型调用</div>{(["image", "video", "text", "audio"] as GenKind[]).map((k) => <div key={k} className="row"><span>{TYPE_LABEL[k]}</span><b className="tnum">{c[k]} 次</b></div>)}<div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>按模型服务商的用量计费</span></div></>, "down", "right"); }}><Icon name="bolt" size="s" /><span className="tnum">{runs.length}</span></button></div>
      {peers.length ? <div className="cap peers tipB" data-tip={`${peers.length + 1} 人在线`}>{peers.slice(0, 3).map((p, i) => <span key={p.id} className="pav">{(p.name || "协")[0]}{i === 2 && peers.length > 3 ? "+" : ""}</span>)}<span className="pav me">{ctl.host.user?.initial || "我"}</span></div> : null}
      {ctl.host.features?.share === false ? null : <div className="cap"><button id="shareBtn" className="sq tipB" data-tip="共享与协作" onClick={(e) => ctl.host.openShare ? ctl.host.openShare() : store.backend.kind === "bridge" ? shareMenu(e.currentTarget, true, peers.length) : store.toast("共享需要在桌面版里打开这张画布")}><Icon name="share" /></button></div>}
    </div>
    <div id="lb" className="float cap">
      <button className="ib primary tipR" id="addBtn" data-tip="添加节点" onClick={(e) => addMenu(ctl, e.currentTarget, ctl.center())}><Icon name="plus" /></button>
      <button className="ib tipR" data-drawer="search" data-tip="节点搜索 ⌘F" onClick={() => openSearch(ctl)}><Icon name="search" /></button>
      <button className={"ib tipR" + (ui.drawer === "assets" ? " on" : "")} data-drawer="assets" data-tip="素材库" onClick={() => store.setUI({ drawer: ui.drawer === "assets" ? null : "assets" })}><Icon name="folder" /></button>
      <button className="ib tipR" data-drawer="templates" data-tip="模板" onClick={(e) => openTemplates(ctl, e.currentTarget)}><Icon name="layout" /></button>
      <button className={"ib tipR" + (ui.cmtMode ? " on" : "")} id="cmtBtn" data-tip="评论 C" onClick={() => toggleCmt(ctl)}><Icon name="msg" /></button>
      <button className={"ib tipR" + (ui.drawer === "history" ? " on" : "")} data-drawer="history" data-tip="生成历史" onClick={() => store.setUI({ drawer: ui.drawer === "history" ? null : "history" })}><Icon name="history" /></button>
      <span className="div" />
      <button className="av tipR" id="avatar" data-tip="账户" onClick={(e) => openPop(e.currentTarget, (close) => <><div className="mh">账户</div><div className="row"><span>{ctl.host.user?.name || "本机用户"}</span><span style={{ color: "var(--fg3)", fontSize: 12 }}>{ctl.host.user?.role || ""}</span></div><div className="msep" /><button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button><button className="mi" onClick={() => { close(); showKeys(); }}><Icon name="grid" size="s" />快捷键</button></>, "right")}>{ctl.host.user?.initial || "我"}</button>
    </div>
    <div id="zb" className="float">
      <div className="cap">
        <button className={"ib tipT" + (showMini ? " on" : "")} id="miniBtn" data-mini-pref={ui.mini === null ? "auto" : ui.mini ? "on" : "off"} data-tip={ui.mini === null ? "小地图：跟随缩放（缩小自动浮出）" : ui.mini ? "小地图：开" : "小地图：关"} onClick={() => store.setUI({ mini: ui.mini === null ? false : ui.mini ? null : true })}><Icon name="map" /></button>
        <button className={"ib tipT" + (ui.hideEdges ? " on" : "")} id="edgeBtn" data-tip={ui.hideEdges ? "显示连线" : "隐藏连线"} onClick={() => { store.setUI({ hideEdges: !ui.hideEdges }); store.toast(!ui.hideEdges ? "已隐藏连线，输入关系仍然生效" : "已显示连线"); }}><Icon name={ui.hideEdges ? "eye" : "eyeoff"} /></button>
        <button className={"ib tipT" + (ui.snap ? " on" : "")} id="snapBtn" data-tip="网格吸附" onClick={() => { store.setUI({ snap: !ui.snap }); store.toast(!ui.snap ? "拖动节点时吸附到 20px 网格" : "已关闭网格吸附"); }}><Icon name="grid" /></button>
        <button className="ib tipT" id="fitBtn" data-tip="适应画布 ⇧1" onClick={() => ctl.fitTo(store.state.doc.nodes)}><Icon name="fit" /></button>
        <input type="range" id="zoomR" min={15} max={200} step={1} aria-label="缩放" value={zoomPct} onChange={(e) => { const r = ctl.rect(); ctl.zoomAt(+e.target.value / 100, r.left + r.width / 2, r.top + r.height / 2); }} />
        <span id="zoomV" className="tnum">{zoomPct}%</span>
      </div>
      <button className="ib cap tipT" id="themeBtn" data-tip={ui.theme === "light" ? "浅色模式" : "深色模式"} onClick={(e) => themeMenu(ctl, e.currentTarget)}><Icon name={ui.theme === "light" ? "sun" : "moon"} /></button>
      <button className="ib cap tipT" id="help" data-tip="帮助" onClick={(e) => openPop(e.currentTarget, (close) => <><div className="mh">帮助</div><button className="mi" onClick={() => { close(); showKeys(); }}><Icon name="grid" size="s" />快捷键<span className="k">?</span></button></>, "up")}><Icon name="help" /></button>
    </div>
    {showMini ? <Minimap /> : null}
    {ui.sel.size ? <MultiBar /> : null}
    <PinBar />
    <BatchRuns />
    {/* Agent 展开后画布区变窄，提示会压到左下工具栏上：此时不显示 */}
    {ui.agentOpen ? null : <div id="hint" className="float">{ui.leftDrag === "select" ? "滚轮平移 · ⌘/Ctrl+滚轮缩放 · 拖动空白框选 · 右键 / 空格拖动平移 · 双击空白添加节点" : "滚轮平移 · ⌘/Ctrl+滚轮缩放 · 拖动空白平移 · Shift 拖动框选 · 双击空白添加节点"}</div>}
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
    {!ui.agentOpen ? <button id="orb" className="float" aria-label="打开 Agent" title="Agent" data-orb onClick={() => store.setUI({ agentOpen: true })}><span className="orb-name">Agent</span></button> : null}
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

function canvasMenu(ctl: Ctl, anchor: Element, rename: () => void) {
  const store = ctl.store;
  openPop(anchor, (close) => <>
    {ctl.host.backToList ? <button className="mi" onClick={() => { close(); ctl.host.backToList!(); }}><Icon name="back" size="s" />返回画布列表</button> : null}
    <button className="mi" onClick={() => { close(); rename(); }}><Icon name="pencil" size="s" />重命名</button>
    <button className="mi" data-menu="download-canvas" onClick={() => { close(); openDownloadCanvas(ctl); }}><Icon name="download" size="s" /><span style={{ flex: 1 }}>下载画布</span><span className="k">PNG / JPEG</span></button>
    <button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button>
    <CanvasList ctl={ctl} close={close} />
  </>);
  void store;
}
function CanvasList({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const [list, setList] = useState<Array<{ id: string; name: string; nodes?: number }> | null>(null);
  useEffect(() => { void ctl.host.listCanvases?.().then(setList).catch(() => setList([])); }, [ctl]);
  if (!ctl.host.listCanvases) return null;
  return <><div className="msep" /><div className="mh">切换画布</div>{(list || []).map((c) => <button key={c.id} className={"mi" + (c.id === ctl.store.state.canvasId ? " on" : "")} onClick={() => { close(); if (c.id !== ctl.store.state.canvasId) ctl.host.openCanvas?.(c.id); }}><Icon name="layers" size="s" /><span>{c.name}{c.nodes != null ? <span className="d">{c.nodes} 个节点</span> : null}</span></button>)}{!list ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>读取中…</span></div> : null}</>;
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
  const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } };
  const seg = <K extends string>(key: string, opts: ReadonlyArray<readonly [K, string]>, cur: K, pick: (k: K) => void) =>
    <div className="cset-seg" role="radiogroup" data-setting={key}>{opts.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={cur === k} data-v={k} className={cur === k ? "on" : ""} onClick={() => pick(k)}>{l}</button>)}</div>;
  const sw = (key: string, on: boolean, label: string, set: (v: boolean) => void) =>
    <button type="button" className="cset-sw" role="switch" aria-checked={on} aria-label={label} data-setting={key} onClick={() => set(!on)} />;
  const row = (label: string, cap: ReactNode, control: ReactNode, key?: string) =>
    <div className="cset-row" key={key}><div className="cset-lab"><span>{label}</span>{cap ? <small>{cap}</small> : null}</div>{control}</div>;
  const val = (v: ReactNode, cls = "") => <span className={"cset-val" + (cls ? " " + cls : "")}>{v}</span>;
  const saveText = saving === "saving" ? "保存中…" : saving === "error" ? "保存失败" : saving === "conflict" ? "版本冲突" : "已自动保存";
  return <><ModalHead title="画布设置" icon="settings" /><div className="mbd cset-body">
    <section className="cset-sec"><h3>常规</h3><div className="cset-group">
      {row("主题", null, seg("theme", [["dark", "深色"], ["light", "浅色"], ["system", "跟随系统"]] as const, ui.themePref, (k) => { store.setUI({ themePref: k }); save("openarc-canvas-theme", k); applyTheme(store); }))}
      {row("左键拖动空白处", ui.leftDrag === "select" ? "右键 / 空格拖动平移画布" : "按住 Shift 拖动框选", seg("leftdrag", [["select", "框选"], ["pan", "平移"]] as const, ui.leftDrag, (k) => { store.setUI({ leftDrag: k }); save("openarc-canvas-leftdrag", k); }))}
      {row("批量结果", ui.batchMode === "stack" ? "2× / 4× 结果叠在一个节点里" : "2× / 4× 结果铺成多个节点", seg("batch", [["stack", "堆叠"], ["spread", "铺开"]] as const, ui.batchMode, (k) => { store.setUI({ batchMode: k }); store.toast(k === "stack" ? "批量结果会堆叠，用 ‹ › 切换" : "批量结果会铺开成多个节点"); }))}
    </div></section>
    <section className="cset-sec"><h3>拖动与显示</h3><div className="cset-group">
      {row("对齐参考线", "按住 Alt 临时关闭", sw("guides", ui.guides, "对齐参考线", (v) => store.setUI({ guides: v })))}
      {row("网格吸附", null, sw("snap", ui.snap, "网格吸附", (v) => store.setUI({ snap: v })))}
      {row("显示连线", null, sw("edges", !ui.hideEdges, "显示连线", (v) => store.setUI({ hideEdges: !v })))}
      {row("小地图", null, seg("mini", [["auto", "自动"], ["on", "显示"], ["off", "隐藏"]] as const, ui.mini == null ? "auto" : ui.mini ? "on" : "off", (k) => store.setUI({ mini: k === "auto" ? null : k === "on" })))}
    </div></section>
    <section className="cset-sec"><h3>新节点默认模型</h3><div className="cset-group cset-grid">
      {(["image", "video", "text", "audio"] as GenKind[]).map((t) => { const m = store.defaultModel(t); return <div className="cset-cell" key={t} data-model-kind={t}><span>{TYPE_LABEL[t]}</span>{val(m?.name || "未配置", m ? "" : "muted")}</div>; })}
    </div></section>
    <p className="cset-foot tnum">{doc.nodes.length} 个节点 · {doc.edges.length} 条连线 · {saveText}{version != null ? ` · 版本 ${version}` : ""} · 可用模型 {models.length} 个</p>
  </div></>;
}
function connectAgentPop(ctl: Ctl, anchor: Element) {
  const addr = "openarc://canvas/" + ctl.store.state.canvasId;
  openPop(anchor, (close) => <>
    <div className="mh">在 Agent 中打开这张画布</div>
    <button className="mi" onClick={() => { close(); ctl.store.setUI({ agentOpen: true }); }}><span className="ic"><Logo /></span><span>OpenArc 助手<span className="d">右侧面板，可直接改画布</span></span></button>
    <div className="msep" /><div className="row" style={{ font: "12px var(--mono)", color: "var(--fg2)" }}><span>{addr}</span><button className="btn" style={{ height: 26 }} onClick={async () => { try { await navigator.clipboard.writeText(addr); ctl.store.toast("已复制连接地址"); } catch { ctl.store.toast("复制失败，请手动选中地址"); } }}>复制</button></div>
  </>, "down", "right");
}
function themeMenu(ctl: Ctl, anchor: Element) {
  const store = ctl.store;
  openPop(anchor, (close) => <><div className="mh">外观</div>{([["dark", "moon", "深色"], ["light", "sun", "浅色"], ["system", "monitor", "跟随系统"]] as const).map(([k, ic, t]) => <button key={k} className={"mi" + (store.state.ui.themePref === k ? " on" : "")} data-th={k} onClick={() => { close(); store.setUI({ themePref: k }); try { localStorage.setItem("openarc-canvas-theme", k); } catch { /* 忽略 */ } applyTheme(store); }}><span className="ic"><Icon name={ic} size="s" /></span><span style={{ flex: 1 }}>{t}</span>{store.state.ui.themePref === k ? <span className="k"><Icon name="check" size="s" /></span> : null}</button>)}</>, "up");
}
export function showKeys() {
  const k = [["撤销 / 重做", "⌘Z / ⇧⌘Z"], ["复制 / 粘贴", "⌘C / ⌘V"], ["创建副本", "⌘D"], ["删除", "⌫ / Del"], ["全选", "⌘A"], ["节点搜索", "⌘F"], ["打开 / 收起 Agent", "⌘J"], ["指向编辑（图上圈改 / 点节点给 Agent）", "⌘I"], ["语音输入（再按一次结束）", "V"], ["发送生成", "⌘↵"], ["适应画布", "⇧1"], ["放大 / 缩小", "⌘+ / ⌘−"], ["切换深浅色", "⇧⌘L"], ["评论模式", "C"], ["拖动画布", "右键 / 中键 / 空格 + 拖动"], ["微移节点", "方向键（⇧ 10px）"], ["重命名节点", "双击节点标题"], ["框选", "拖动空白（⇧ 追加）"], ["堆叠选中节点", "⇧S"], ["一键运行分组 / 选中节点", "⌘↵"], ["取消 / 关闭", "Esc"]];
  openModal(() => <><ModalHead title="快捷键" /><div className="mbd"><div className="kbdlist">{k.map(([a, b]) => <div key={a}><span>{a}</span><kbd>{b}</kbd></div>)}</div></div></>);
}
export function toggleCmt(ctl: Ctl) { const on = !ctl.store.state.ui.cmtMode; ctl.store.setUI({ cmtMode: on }); if (on) ctl.store.toast("点击画布放置评论"); }

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
  const src = srcOf(n); const url = useAssetUrl(src);
  return <div className={"hrow" + (on ? " on" : "")} data-focus={n.id} data-i={i} onClick={onClick} onMouseMove={onHover}><span className="th">{url ? <img src={url} alt="" /> : <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" />}</span><span className="m"><b>{title(n)}</b><small>{sub}</small></span>{extra ? <span style={{ color: "var(--fg3)", fontSize: 11.5 }}>{extra}</span> : null}</div>;
}
const TEMPLATES = [
  { id: "ecom", name: "电商卖点套图", desc: "产品图 + 产品信息 → 卖点拆解 → 3 张海报" },
  { id: "i2v", name: "首帧生成视频", desc: "一张图作为首帧，写镜头描述出短片" },
  { id: "bg", name: "图片换背景", desc: "上传产品图，描述新背景" },
  { id: "table", name: "多维表格批量出图", desc: "文本 → 多维表格 → 逐行批量生成图片" },
  { id: "story", name: "分镜表到视频", desc: "一句创意 → 分镜表 → 逐镜头生成视频" },
] as const;

/* ---------- 模板面板（对齐 TapNow E12：贴左侧工具栏的浮层 + 公共/我的 + 搜索 + 3 列封面卡） ---------- */
/**
 * 数据源是随包市场清单里的 templates（window.openarc.market → market/catalog）。
 * 清单读不到就退回上面这 5 条内置模板并如实标注；带 doc 的模板一次铺全部节点与连线。
 */
type TplNode = {
  id: string; kind: "text" | "image" | "video" | "audio" | "table";
  x: number; y: number; w: number; h: number;
  title: string; text: string; prompt: string;
  params?: { output?: TextParams["output"]; ratio?: string; count?: number; dur?: number; mode?: VideoMode };
  table?: { title?: string; columns?: string[]; rows?: string[][] } | null;
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
};
function personalEntry(item: { id: string; title: string; prompt: string; updatedAt: number; doc: unknown }): TplEntry | null {
  const doc = asTplDoc(item.doc);
  if (!doc) return null;
  return { id: item.id, name: item.title, summary: item.prompt, tags: ["我的模板"], chips: [], category: "personal", steps: [], publishedAt: item.updatedAt, nodes: doc.nodes.length, edges: doc.edges.length, doc, personal: true };
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

/** 市场清单读取：任何异常都折成 { list: [], error }，绝不抛到调用方 */
async function loadMarketTemplates(): Promise<{ list: TplEntry[]; cats: Record<string, string>; error: string }> {
  const api = (window as unknown as { openarc?: { market?: { command?: (arg: Record<string, unknown>) => Promise<unknown> } } }).openarc?.market;
  const cmd = api && typeof api.command === "function" ? api.command : null;
  if (!cmd) return { list: [], cats: {}, error: "当前环境没有市场桥（只在 OpenArc 桌面应用里可读）" };
  try {
    const res = await cmd({ command: "market/catalog", payload: {} });
    const box = res && typeof res === "object" ? (res as Record<string, unknown>) : {};
    if (box.ok !== true) return { list: [], cats: {}, error: String(box.error || "market/catalog 未返回 ok") };
    const value = box.value && typeof box.value === "object" ? (box.value as Record<string, unknown>) : null;
    if (!value || !Array.isArray(value.templates)) return { list: [], cats: {}, error: "市场清单里没有 templates 数组" };
    const cats: Record<string, string> = {};
    if (Array.isArray(value.categories)) for (const raw of value.categories) {
      const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const cid = c && typeof c.id === "string" ? c.id : "";
      const cname = c && typeof c.name === "string" ? c.name.trim() : "";
      if (cid && cname) cats[cid] = cname;
    }
    const list = value.templates.flatMap(toTplEntry);
    if (!list.length) return { list: [], cats, error: "市场清单里的模板都不合法" };
    return { list, cats, error: "" };
  } catch (e) {
    return { list: [], cats: {}, error: e instanceof Error ? e.message : "读取市场清单出错" };
  }
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
    const params: AnyParams = n.params ? { ...base, ...n.params } as AnyParams : base;
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
  if (!tpl.doc || !tpl.doc.nodes.length) {
    const msg = "「" + tpl.name + "」没有可用的节点文档，没法铺到画布上";
    ctl.store.toast(msg, 4000); return msg;
  }
  try {
    const made = createFromTemplate(ctl, tpl);
    ctl.store.toast(`已按模板创建 ${made.nodes} 个节点、${made.edges} 条连线（⌘Z 可撤销）`, 4000);
    return "";
  } catch (e) {
    const msg = "应用模板失败：" + (e instanceof Error ? e.message : "未知错误");
    ctl.store.toast(msg, 4000); return msg;
  }
}

const BUILTIN_TEMPLATES: TplEntry[] = TEMPLATES.map((t) => ({ id: "bi-" + t.id, name: t.name, summary: t.desc, tags: [], chips: [], category: "", steps: [], publishedAt: 0, nodes: 0, edges: 0, flow: t.id }));

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

/** 面板锚点：贴模板按钮右侧、顶部对齐（SPEC ①：left = 按钮右缘 + 14，top = 按钮 top）；越界时按 8px 边距内收 */
function useAnchorPos(anchor: Element | null, width: number, height: number) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const root = document.querySelector(".cn-root");
      if (!anchor || !anchor.isConnected || !root) { setPos(null); return; }
      const a = anchor.getBoundingClientRect(); const r = root.getBoundingClientRect();
      const left = Math.max(8, Math.min(a.right - r.left + 14, r.width - width - 8));
      const top = Math.max(8, Math.min(a.top - r.top, r.height - height - 8));
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor, width, height]);
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
  const [strips, setStrips] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [mine, setMine] = useState<TplEntry[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("openarc:template-recent") || "[]"); } catch { return []; } });
  /** 面板上方引导卡：本次会话只提示一次；累计关掉 2 次后多出「不再提示」（永久，localStorage） */
  const [tip, setTip] = useState(false);
  const [tipCount, setTipCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastCard = useRef<HTMLElement | null>(null);
  const pagingRef = useRef(false);
  const pageGen = useRef(0);
  const alive = useRef(true);
  const pos = useAnchorPos(anchor, 500, 500);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    try {
      if (localStorage.getItem("openarc:template-tip") === "never") return;
      if (sessionStorage.getItem("openarc:template-tip:session") === "1") return;
      setTipCount(Number(localStorage.getItem("openarc:template-tip:count") || 0) || 0);
      setTip(true);
    } catch { /* 存储不可用就不提示 */ }
  }, []);
  const dismissTip = () => {
    setTip(false);
    try {
      sessionStorage.setItem("openarc:template-tip:session", "1");
      localStorage.setItem("openarc:template-tip:count", String(tipCount + 1));
    } catch { /* 忽略 */ }
  };
  const neverTip = () => {
    setTip(false);
    try { localStorage.setItem("openarc:template-tip", "never"); } catch { /* 忽略 */ }
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
  const coverOf = (t: TplEntry) => t.personal ? (t.cover || thumbs[thumbKey(t)] || "") : (coverBad[t.id] ? thumbs[thumbKey(t)] || "" : tplCoverUrl(t.id));
  const onCoverError = (t: TplEntry) => {
    setCoverBad((p) => (p[t.id] ? p : { ...p, [t.id]: true }));
    ensureThumb(t);
  };
  const closeGallery = useCallback(() => {
    setGallery(false); setDetail(null);
    requestAnimationFrame(() => lastCard.current?.focus());
  }, []);
  const openAll = () => { setDetail(null); setGallery(true); };
  const openDetail = (t: TplEntry, el: HTMLElement | null) => { if (el) lastCard.current = el; setErr(""); setDetail(t); setGallery(true); };
  const applyNow = (t: TplEntry) => {
    const message = applyTemplate(ctl, t);
    if (message) { setErr(message); return; }
    const recent = [t.id, ...recentIds.filter((id) => id !== t.id)].slice(0, 30);
    setRecentIds(recent);
    try { localStorage.setItem("openarc:template-recent", JSON.stringify(recent)); } catch { /* 无存储时仍可使用模板 */ }
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
  const removeMine = async (tpl: TplEntry) => {
    if (!window.confirm("删除个人模板「" + tpl.name + "」？原画布不会被删除。")) return;
    if (!(await deletePersonalTemplate(libraryId, tpl.id))) { setErr("删除个人模板失败"); return; }
    setMine((items) => items.filter((item) => item.id !== tpl.id)); setDetail(null);
  };
  // Esc 逐层倒退：详情 → 弹层 →（ModalView 的 Esc 关面板）。window 捕获先于 document，才抢得到弹层自己的 Esc
  useEffect(() => {
    if (!gallery) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (detail) { setDetail(null); return; }
      closeGallery();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [gallery, detail, closeGallery]);
  // 点面板外关闭：透明层不吃指针，所以自己监听；点模板按钮本身交给切换，不先关再开
  useEffect(() => {
    if (gallery || creating) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || panelRef.current?.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [gallery, creating, close, anchor]);
  return <>
    <div className="tpl-wrap" style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}>
      {tip ? <TplTip total={total} count={tipCount} onMore={tipMore} onDismiss={dismissTip} onNever={neverTip} /> : null}
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
            {list.length ? <div className="tpl-grid">{list.map((t) => <TplCard key={t.id} tpl={t} cover={coverOf(t)} onCoverError={() => onCoverError(t)} onApply={applyNow} onView={openDetail} />)}</div> : null}
            {!list.length ? <div className="tpl-empty" data-tpl-mine><span className="l1">{kw ? "没有找到匹配模板" : "还没有个人模板"}</span><span className="l2">{libraryId ? "把当前画布的节点与连线保存下来，之后可以重复使用" : "连接桌面资产库后即可保存"}</span></div> : null}
          </> : <>
            {read.status === "loading" ? <div className="tpl-grid" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="tpl-sk" />)}</div> : null}
            {read.status !== "loading" && list.length ? <div className="tpl-grid">
              {list.map((t) => <TplCard key={t.id} tpl={t} cover={coverOf(t)} onCoverError={() => onCoverError(t)} onApply={applyNow} onView={openDetail} />)}
            </div> : null}
            {read.status !== "loading" && hasMore ? <div className="tpl-more" data-tpl-more data-tpl-loading={paging ? "1" : "0"}><span className="tpl-spin" data-tpl-spin /></div> : null}
            {read.status !== "loading" && !list.length ? <div className="tpl-empty" data-tpl-nomatch>
              <span className="l1">{kw ? "未找到匹配资产" : "没有找到模板"}</span>
              {kw && total > loaded.length ? <span className="l2">还有 {total - loaded.length} 个模板尚未加载，清空搜索后可以继续浏览</span> : null}
            </div> : null}
            {read.status === "builtin" ? <div className="tpl-note" data-tpl-note title={read.error}>市场清单读取失败，当前显示内置模板</div> : null}
          </>}
          {err ? <div className="tpl-err" data-tpl-err>{err}</div> : null}
        </div>
      </div>
    </div>
    </div>
    {gallery ? <TplGallery all={read.list} mine={mine} recentIds={recentIds} cats={read.cats} coverBad={coverBad} coverOf={coverOf} onCoverError={onCoverError}
      detail={detail} strips={strips} onDetail={openDetail} onApply={applyNow} onCreate={openCreate} onDefaultCreate={createDefaultWorkflow} onDelete={removeMine} onClose={closeGallery} onBack={() => setDetail(null)} /> : null}
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

/** 面板上方引导卡（TapNow ② 2.2 的 498×159 位置）：视频换成我方成品静图 + 极轻 Ken Burns，reduced-motion 下静止 */
function TplTip({ total, count, onMore, onDismiss, onNever }: { total: number; count: number; onMore: () => void; onDismiss: () => void; onNever: () => void }) {
  return <div className="tpl-tip" data-tpl-tip>
    <div className="tpl-tip-shot" data-tpl-tip-shot>
      <img src={tplCoverUrl("tpl-text-to-video")} alt="" draggable={false} />
    </div>
    <div className="tpl-tip-main">
      <b>用一个模板开个头</b>
      <p>{(total > 0 ? total : "全部") + " 个模板覆盖电商、影视、社媒；点卡片直接把节点铺到画布，⌘Z 可撤销。"}</p>
      <button type="button" className="tpl-tip-more" title="模板用法：点卡片应用、hover 点「查看」看详情、右上「浏览全部」打开模板库" onClick={onMore}>了解更多</button>
    </div>
    <div className="tpl-tip-ft">
      {count >= 2 ? <button type="button" className="tpl-tip-btn" data-tpl-tip-never onClick={onNever}>不再提示</button> : null}
      <button type="button" className="tpl-tip-btn" data-tpl-tip-dismiss onClick={onDismiss}>知道了</button>
    </div>
  </div>;
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
              {!list.length ? <div className="tpl-empty" data-tpl-lib-empty><span className="l1">未找到匹配资产</span></div> : null}
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
/** 多选工具条：已选 N 个 + 对齐 / 一键运行 / 下载 / 删除（TapNow 的批量条）；只选中一个分组时显示分组的操作 */
function MultiBar() {
  const ctl = useCtl(); const store = ctl.store; const ui = useS((s) => s.ui); const doc = useS((s) => s.doc); const batches = useS((s) => s.batches);
  const nodes = [...ui.sel].map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n);
  const group = nodes.length === 1 && nodes[0].kind === "group" ? nodes[0] : null;
  if (nodes.length < 2 && !group) return null;
  const runnable = runnableIds(store, nodes); const b = batches[runKeyOf(nodes)];
  const runBtn = b
    ? <><span className="mb-prog tnum" data-mb="prog"><span className="runsig" />运行中 {b.done + b.failed}/{b.total}</span><button className="mb-btn" data-mb="stop" disabled={b.stopped} onClick={() => stopGroup(store, b.key)}><Icon name="x" size="s" />{b.stopped ? "正在停止" : "停止"}</button></>
    : <button className="mb-btn strong" data-mb="run" disabled={!runnable.length} title={runnable.length ? `按依赖顺序运行 ${runnable.length} 个生成节点（⌘↵，先确认消耗）` : "选中的节点里没有可运行的"} onClick={() => runNodes(ctl, nodes)}><Icon name="play" size="s" />一键运行{runnable.length ? <span className="mb-n tnum">{runnable.length}</span> : null}</button>;
  if (group) return <div className="multi-bar float" id="multibar" data-multi="group">
    <span className="mb-count" data-mb-count>{groupLabel(group)} · {runnable.length} 个可运行</span>
    <span className="vsep" />
    {runBtn}
    <button className="mb-btn" data-mb="tpl" title="存为我的模板" onClick={() => saveAsTemplate(ctl, nodes, groupLabel(group) + " 模板")}><Icon name="layout" size="s" />存为模板</button>
    <button className="mb-btn" data-mb="dl" title="有结果的节点打包成 zip 下载" onClick={() => void downloadMany((group.children || []).map((c) => store.node(c)).filter((x): x is CanvasNode => !!x), store, groupLabel(group))}><Icon name="download" size="s" />下载</button>
    {isStack(group) ? null : <button className="mb-btn" data-mb="ungroup" title="取消分组（⇧⌘G）" onClick={() => ungroup(store, group.id)}><Icon name="split" size="s" />取消分组</button>}
    <span className="vsep" />
    <button className="mb-btn icon-only" data-mb="cancel" title="取消选择" onClick={() => store.setUI({ sel: new Set() })}><Icon name="x" size="s" /></button>
  </div>;
  return <div className="multi-bar float" id="multibar" data-multi={nodes.length}>
    <span className="mb-count tnum" data-mb-count>已选 {nodes.length} 个</span>
    <span className="vsep" />
    <button className="mb-btn" data-mb="align" onClick={(e) => openPop(e.currentTarget, (close) => <>
      <div className="mh">对齐 {nodes.length} 个节点</div>
      <button className="mi" data-align="left" onClick={() => { close(); alignSelection(store, "left"); }}><Icon name="left" size="s" />左对齐</button>
      <button className="mi" data-align="top" onClick={() => { close(); alignSelection(store, "top"); }}><Icon name="up" size="s" />顶对齐</button>
      <button className="mi" data-align="hgap" onClick={() => { close(); alignSelection(store, "hgap"); }}><Icon name="layers" size="s" />水平等距</button>
    </>, "down")}><Icon name="layers" size="s" />对齐</button>
    <button className="mb-btn" data-mb="stack" title="把选中的节点收成一叠（⇧S）" onClick={() => stackSelection(store)}><Icon name="layers" size="s" />堆叠</button>
    <button className="mb-btn" data-mb="group" title="编成一组（⌘G）" onClick={() => groupSelection(store)}><Icon name="grid" size="s" />分组</button>
    {nodes.some(clipable) ? <button className="mb-btn" data-mb="playlist" title="把选中的视频 / 音频按画布上的顺序放进一条新的剪辑时间线" onClick={() => createTimelineFrom(store, nodes)}><Icon name="video" size="s" />建剪辑<span className="mb-n tnum">{nodes.filter(clipable).length}</span></button> : null}
    {runBtn}
    <button className="mb-btn" data-mb="dl" title="有结果的节点打包成 zip 下载" onClick={() => void downloadMany(nodes, store)}><Icon name="download" size="s" />下载</button>
    <button className="mb-btn danger" data-mb="del" onClick={() => deleteSelection(store)}><Icon name="trash" size="s" />删除</button>
    <span className="vsep" />
    <button className="mb-btn icon-only" data-mb="cancel" title="取消选择" onClick={() => store.setUI({ sel: new Set() })}><Icon name="x" size="s" /></button>
  </div>;
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
  const ctl = useCtl(); const doc = useS((s) => s.doc); const view = useS((s) => s.view); const sel = useS((s) => s.ui.sel); const runtime = useS((s) => s.runtime); useS((s) => s.ui.theme);
  const ref = useRef<HTMLCanvasElement>(null); const geo = useRef<{ ox: number; oy: number; s: number } | null>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const g = c.getContext("2d")!; g.clearRect(0, 0, c.width, c.height);
    const bb = bounds(doc.nodes); if (!bb) return; const r = ctl.rect(); const css = (k: string) => getComputedStyle(document.querySelector(".cn-root") || document.documentElement).getPropertyValue(k).trim();
    const vw = { x: -view.x / view.k, y: -view.y / view.k, w: r.width / view.k, h: r.height / view.k };
    const all = { x: Math.min(bb.x, vw.x), y: Math.min(bb.y, vw.y), w: 0, h: 0 }; all.w = Math.max(bb.x + bb.w, vw.x + vw.w) - all.x; all.h = Math.max(bb.y + bb.h, vw.y + vw.h) - all.y;
    const s = Math.min((c.width - 20) / all.w, (c.height - 20) / all.h); const ox = 10 - all.x * s + ((c.width - 20) - all.w * s) / 2, oy = 10 - all.y * s + ((c.height - 20) - all.h * s) / 2; geo.current = { ox, oy, s };
    const ink = css("--ink") || "128,128,128";
    doc.nodes.forEach((n) => { g.fillStyle = sel.has(n.id) ? (css("--solid") || "#111") : runtime[n.id] ? "#8e8e93" : `rgba(${ink},.38)`; g.fillRect(ox + n.x * s, oy + n.y * s, Math.max(2, n.w * s), Math.max(2, (n.h + 24) * s)); });
    g.strokeStyle = `rgba(${css("--ink")},.8)`; g.lineWidth = 2; g.strokeRect(ox + vw.x * s, oy + vw.y * s, vw.w * s, vw.h * s);
  });
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
    <div className="cin-bar"><small className="tnum" title="↵ 发送 · ⇧↵ 换行">{text.length}/{CMT_MAX} · ↵ 发送</small><span className="grow" />
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
      <div className="agrid">{favs.map((n) => <Asset key={n.id} n={n} onUse={use} />)}{favs.length ? null : <span style={{ gridColumn: "1/-1", color: "var(--fg3)", fontSize: 12 }}>点图片节点左上角的星标收藏</span>}</div>
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
  const store = useCtl().store; const url = useAssetUrl(srcOf(n)); const fav = genOf(n).fav;
  return <div className="a" title={title(n)} onClick={() => onUse(n)}>
    {url ? <img src={url} alt="" /> : null}
    <button className={"fav" + (fav ? " on" : "")} onClick={(e) => { e.stopPropagation(); store.patchGen(n.id, { fav: !fav }); }}><Icon name="star" size="xs" /></button>
  </div>;
}

function Thumb({ src }: { src: string }) { const url = useAssetUrl(src); return url ? <img src={url} alt="" /> : null; }

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
  return <div id="toasts">{toasts.map((t) => <div key={t.id} className={"toast" + (t.out ? " out" : "")} dangerouslySetInnerHTML={{ __html: escToast(t.html) }} />)}</div>;
}
const TOAST_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escToast = (html: string) => html.replace(/[&<>"]/g, (c) => TOAST_ESC[c] || c);

export function Lightbox() {
  const ctl = useCtl(); const [id, setId] = useState<string | null>(null); const doc = useS((s) => s.doc);
  useEffect(() => { const on = (e: Event) => setId((e as CustomEvent).detail); addEventListener("cn:lightbox", on); return () => removeEventListener("cn:lightbox", on); }, []);
  const [out, setOut] = useState(false);
  useLayoutEffect(() => { if (id) setOut(false); }, [id]);
  const node = id ? doc.nodes.find((n) => n.id === id) : null;
  if (!node || !isGenKind(node.kind)) return null;
  const g = genOf(node); const o = g.hist[g.hi];
  const close = () => { setOut(true); setTimeout(() => setId(null), 160); };
  return <div className="lightbox" id="lightbox" tabIndex={-1} ref={(el) => { if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus(); }}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && g.hist.length > 1) ctl.store.patchGen(node.id, { hi: (g.hi + (e.key === "ArrowLeft" ? -1 : 1) + g.hist.length) % g.hist.length }); }}
    style={out ? { animation: "fadeOut 160ms var(--e-exit) forwards" } : undefined}
    onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div className="lb-tools">
      {node.kind !== "text" && (o?.url || o?.frame) ? <button className="pill" data-lb="apply" title="把当前这一版单独放到画布上，成为新节点" onClick={() => { const made = extractCurrentVersion(ctl.store, node.id); close(); if (made) setTimeout(() => ctl.focusNode(made.id), 170); }}><Icon name="plus" size="xs" />放到画布</button> : null}
      <button className="pill" data-lb="locate" title="关闭预览并跳到这个节点" onClick={() => { close(); setTimeout(() => ctl.focusNode(node.id), 170); }}><Icon name="fit" size="xs" />回到画布</button>
      {node.kind !== "text" && o?.url ? <button className="pill" data-lb="dl" onClick={() => void download(node, ctl.store)}><Icon name="download" size="xs" />下载</button> : null}
      <button className="ib" data-lb="close" aria-label="关闭" onClick={close}><Icon name="x" /></button>
    </div>
    {node.kind === "text" ? <div className="txt">{o?.text}</div>
      : node.kind === "audio" ? <div className="txt">音频 · {o?.dur}s</div>
      : node.kind === "video" && o?.url ? <BigVideo src={o.url} />
      : <BigImg src={o?.url || o?.frame || ""} />}
    <div style={{ color: "var(--fg2)", fontSize: 12 }}>{g.title}{g.hist.length > 1 ? ` · 版本 ${g.hi + 1}/${g.hist.length}` : ""}{o?.meta?.model ? ` · ${o.meta.model}` : ""}{o?.meta?.ratio ? ` · ${o.meta.ratio}` : ""}{o?.meta?.size ? ` · ${o.meta.size}` : ""}</div>
    {g.hist.length > 1 && node.kind !== "text" ? <div className="thumbs">{g.hist.map((h, i) => <button key={i} className={i === g.hi ? "on" : ""} onClick={() => ctl.store.patchGen(node.id, { hi: i })}><Thumb src={h.url || h.frame || ""} /></button>)}</div> : null}
  </div>;
}
function BigImg({ src }: { src: string }) { const url = useAssetUrl(src); return url ? <img className="big" src={url} alt="" /> : null; }
function BigVideo({ src }: { src: string }) { const m = useMediaUrl(src); return m.url ? <video className="big" src={m.url} controls autoPlay onError={m.onError} /> : null; }
