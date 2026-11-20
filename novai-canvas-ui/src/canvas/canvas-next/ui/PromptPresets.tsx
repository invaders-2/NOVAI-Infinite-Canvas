/**
 * 预设提示词：点左侧工具栏 icon → 贴着该按钮上方弹出列表面板（空间不够翻下方，列表内部滚动）。
 * 「＋ 添加预设提示词」和行内铅笔 → overlay 的居中弹窗（openModal + ModalHead），弹窗打开时列表面板保持；
 * 垃圾桶 → 居中的 .folder-dialog 小确认弹窗。位置统一交给 overlay/placement，不自己写定位。
 * 数据只经 promptPresets.ts 读写「画布提示词」库，不用 localStorage。
 */
import { useEffect, useState } from "react";
import type { Ctl } from "./ctx";
import { useCtl } from "./ctx";
import { Icon } from "./Icon";
import { ModalHead, closePop, openModal, openPop } from "./overlay";
import { genOf, isGenKind } from "../model";
import { PROMPT_PRESET_LIMIT, deletePromptPreset, listPromptPresets, presetTextLength, savePromptPreset, type PromptPreset } from "../promptPresets";

/** 列表里的提示词预览：压成一行，太长由 CSS 省略 */
const previewOf = (text: string) => text.replace(/\s+/g, " ").trim() || "（没有内容）";

const PANEL_PREFER_ABOVE = 400;
/** 面板里挂的「保存/删除后刷新列表」：弹窗在面板上层，关掉后面板原地刷新 */
let refreshPanel: (() => void) | null = null;

/**
 * 列表面板贴按钮浮层的位置：上方够高优先上方（底边离按钮 8px）；否则翻到下方；
 * 两边都紧时取大的一侧并让列表自己滚动，不会压住被点的按钮。
 */
function capAt(anchor: Element): { dir: "up" | "down"; cap: number } {
  const rect = anchor.getBoundingClientRect();
  const above = Math.max(0, rect.top - 16); // 8px 视口边距 + 8px 与按钮的间距
  const below = Math.max(0, innerHeight - rect.bottom - 16);
  const limit = 470;
  // floor：placement 拿整像素上限和浮点空间比大小，四舍五入会多 0.5px 导致刚放得下的一侧又翻回去
  const fit = (side: number) => Math.max(120, Math.floor(Math.min(limit, side)));
  if (above >= PANEL_PREFER_ABOVE) return { dir: "up", cap: fit(above) };
  if (below >= 150) return { dir: "down", cap: fit(below) };
  return above >= below ? { dir: "up", cap: fit(Math.max(160, above)) } : { dir: "down", cap: fit(Math.max(160, below)) };
}

/** 节点编辑器里的那颗 icon：开着就关，关了就贴 icon 的上方打开列表面板 */
export function togglePromptPresets(ctl: Ctl, nodeId: string, anchor: HTMLElement) {
  const existing = document.querySelector("#pop.preset-pop");
  if (existing && !existing.classList.contains("closing")) { closePop(); return; }
  const { dir, cap } = capAt(anchor);
  openPop(anchor, (close) => <PresetPanel ctl={ctl} nodeId={nodeId} anchor={anchor} onClose={close} />, dir, "center", "preset-pop", cap);
}

function PresetPanel({ ctl, nodeId, anchor, onClose }: { ctl: Ctl; nodeId: string; anchor: HTMLElement; onClose: () => void }) {
  const store = ctl.store;
  const [items, setItems] = useState<PromptPreset[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // 切节点 / 关掉这个节点的编辑器时 icon 会卸载：面板跟着收起，别挂在画布上指向一个已经不显示的节点
  useEffect(() => {
    let frame = 0;
    const check = () => { frame = 0; if (!anchor.isConnected || !ctl.store.node(nodeId)) closePop(); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const off = ctl.store.subscribe(schedule);
    const timer = window.setInterval(check, 400);
    schedule();
    return () => { off(); window.clearInterval(timer); if (frame) cancelAnimationFrame(frame); };
  }, [ctl, nodeId, anchor]);
  // 弹窗（保存 / 删除）直接调这个刷新，不重开面板、不丢滚动位置
  useEffect(() => {
    const refresh = () => setReloadKey((n) => n + 1);
    refreshPanel = refresh;
    return () => { if (refreshPanel === refresh) refreshPanel = null; };
  }, []);
  useEffect(() => {
    let alive = true;
    setStatus("loading");
    void listPromptPresets().then((result) => {
      if (!alive) return;
      setItems(result.items);
      setError(result.ok ? "" : result.error);
      setStatus(result.ok ? "ready" : "error");
    });
    return () => { alive = false; };
  }, [reloadKey]);

  /** 点行 = 套用：直接写进打开这个面板的节点（空提示词直接填、非空换行追加） */
  const apply = (preset: PromptPreset) => {
    const node = store.node(nodeId);
    if (!node || !isGenKind(node.kind)) { store.toast("这个节点已经不在了，没法套用预设"); return; }
    const current = genOf(node).prompt || "";
    store.patchGen(node.id, { prompt: current.trim() ? current.trimEnd() + "\n" + preset.prompt : preset.prompt }, { history: true });
    store.toast(`已套用预设「${preset.title}」`);
    ctl.focusPrompt();
  };

  /** 新增 / 编辑：居中的 overlay 弹窗，打开期间列表面板保持原样 */
  const openForm = (preset: PromptPreset | null) => {
    openModal((close) => <PresetDialog preset={preset} onClose={close} onSaved={() => refreshPanel?.()} />, "preset-dialog-modal preset-modal");
  };

  /** 删除：居中的 .folder-dialog 二次确认 */
  const openDelete = (preset: PromptPreset) => {
    openModal((close) => <DeletePresetDialog preset={preset} onClose={close} onDeleted={() => refreshPanel?.()} />, "folder-dialog-modal preset-modal");
  };

  return <div className="preset-panel" onPointerDown={(e) => e.stopPropagation()}>
    <div className="preset-head"><Icon name="list" size="s" />预设提示词<span className="sp" />
      <button className="ib" style={{ width: 26, height: 26 }} aria-label="关闭预设提示词" title="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
    <div className="preset-list" data-preset-list>
      {status === "loading" ? <p className="preset-hint">正在读取预设提示词…</p> : null}
      {status === "error" ? <div className="preset-error">
        <p>读取预设提示词失败：{error}</p>
        <button className="btn" data-preset-retry onClick={() => setReloadKey((n) => n + 1)}>重试</button>
      </div> : null}
      {status === "ready" && !items.length ? <div className="preset-empty">
        <Icon name="list" size="s" />
        <b>还没有预设提示词</b>
        <span>把常用的提示词存成预设，下次点一下就能套到选中的生成节点上。</span>
      </div> : null}
      {status === "ready" ? items.map((preset) => <div key={preset.id} className="preset-row" role="button" tabIndex={0} data-preset-row={preset.id}
        aria-label={`套用预设「${preset.title}」`} title={preset.prompt}
        onClick={() => apply(preset)}
        onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(preset); } }}>
        <span className="preset-main">
          <b className="preset-title">{preset.title}</b>
          <small className="preset-preview">{previewOf(preset.prompt)}</small>
        </span>
        <span className="preset-acts">
          <button className="preset-act" data-preset-edit title="编辑" aria-label={`编辑预设「${preset.title}」`}
            onClick={(e) => { e.stopPropagation(); openForm(preset); }}><Icon name="pencil" size="s" /></button>
          <button className="preset-act danger" data-preset-delete title="删除" aria-label={`删除预设「${preset.title}」`}
            onClick={(e) => { e.stopPropagation(); openDelete(preset); }}><Icon name="trash" size="s" /></button>
        </span>
      </div>) : null}
    </div>
    <button className="preset-add" data-preset-add onClick={() => openForm(null)}><Icon name="plus" size="s" />添加预设提示词</button>
  </div>;
}

/** 新增 / 编辑共用弹窗（round1 形态）：标题必填、提示词必填且不超过 10000 字；保存中防连点 */
function PresetDialog({ preset, onClose, onSaved }: { preset: PromptPreset | null; onClose: () => void; onSaved: () => void }) {
  const store = useCtl().store;
  const [title, setTitle] = useState(preset?.title || "");
  const [prompt, setPrompt] = useState(preset?.prompt || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = presetTextLength(prompt);
  const tooLong = count > PROMPT_PRESET_LIMIT;
  const valid = !!title.trim() && !!prompt.trim() && !tooLong;
  const run = async () => {
    if (busy || !valid) return;
    setBusy(true); setError("");
    const result = await savePromptPreset({ id: preset?.id, title, prompt });
    setBusy(false);
    if (!result.ok) { setError(result.error); store.toast(`保存失败：${result.error}`, 4200); return; }
    store.toast(`已保存预设「${result.item.title}」`);
    onSaved();
    onClose();
  };
  return <div className="preset-dialog">
    <ModalHead title={preset ? "编辑提示词预设" : "添加提示词预设"} />
    <div className="preset-form">
      <label className="preset-field">
        <span>标题</span>
        <input data-preset-title autoFocus maxLength={120} placeholder="输入你的提示词预设标题" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="preset-field">
        <span>提示词</span>
        <textarea data-preset-prompt placeholder="输入你的提示词" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className={"preset-count tnum" + (tooLong ? " over" : "")}>{count}/{PROMPT_PRESET_LIMIT}</div>
      {error ? <p className="preset-error" data-preset-error>{error}</p> : null}
      <div className="preset-foot">
        <button className="btn" data-preset-cancel disabled={busy} onClick={onClose}>取消</button>
        <button className="btn solid" data-preset-save disabled={!valid || busy} onClick={() => void run()}>{busy ? "保存中…" : "保存"}</button>
      </div>
    </div>
  </div>;
}

/** 删除二次确认：居中的 .folder-dialog（round1 形态），不用浏览器 confirm */
function DeletePresetDialog({ preset, onClose, onDeleted }: { preset: PromptPreset; onClose: () => void; onDeleted: () => void }) {
  const store = useCtl().store;
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const result = await deletePromptPreset(preset.id);
    setBusy(false);
    if (!result.ok) { setErr(result.error); store.toast(`删除失败：${result.error}`, 4200); return; }
    store.toast(`已删除预设「${preset.title}」`);
    onDeleted();
    onClose();
  };
  return <div className="folder-dialog" data-preset-delete-dialog>
    <div className="fd-head"><b>删除预设提示词</b><button className="ib" aria-label="关闭" onClick={onClose}><Icon name="x" size="s" /></button></div>
    <p>删除「{preset.title}」？删除后不可恢复。</p>
    {err ? <div className="fd-err">{err}</div> : null}
    <div className="fd-foot">
      <button className="btn" data-preset-delete-cancel onClick={onClose}>取消</button>
      <button className="btn solid" data-preset-delete-confirm disabled={busy} onClick={() => void go()}>{busy ? "删除中…" : "删除"}</button>
    </div>
  </div>;
}
