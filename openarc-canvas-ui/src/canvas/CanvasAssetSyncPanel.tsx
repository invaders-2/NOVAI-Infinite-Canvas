/**
 * 画布宿主浮层 · 素材库 sync-sources。
 *
 * 真实命令（electron/canvas-dxos-commands.cjs，宿主已经接进 canvas:command）：
 *   · canvas/assetLibrary/list | ensure          目标素材库（本人 + 组织可见）
 *   · canvas/assetLibrary/syncSources            { libraryId, items: [{ nodeId, name?, canvasId? }] }
 *   · photos/library（既有只读域）                DX 虚拟文件树里当前用户可见的图片 / 视频
 * syncSources 的 nodeId 既接受**当前用户可见画布里的节点**，也接受 **DX 虚拟文件树节点**；
 * 后端统一复制资源引用 + 用 asset-source:<nodeId> 去重；只有素材库所有者可以同步（READ_ONLY 时如实拒绝）。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Images, LoaderCircle, RefreshCw, X } from "lucide-react";
import { callBridge, hostCommandError, unwrapValue, type Cmd } from "./canvasDxosModel";

type LibraryView = { id: string; name: string; visibility?: string; access?: string; itemCount?: number; updatedAt?: number };
type CanvasSource = { nodeId: string; label: string; meta: string };
type FileSource = { nodeId: string; label: string; meta: string };
type SourceTab = "canvas" | "files";

const mediaRefOf = (node: any): string | null => {
  if (!node || typeof node !== "object") return null;
  const candidates: string[] = [];
  if (typeof node.url === "string") candidates.push(node.url);
  if (Array.isArray(node.refs)) for (const ref of node.refs) if (typeof ref === "string") candidates.push(ref);
  return candidates.find((value) => value.startsWith("openarc-asset:")) || null;
};

export function CanvasAssetSyncPanel({
  canvasId,
  title,
  cmd,
  onClose,
}: {
  canvasId: string;
  title?: string;
  cmd: Cmd;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [librariesBusy, setLibrariesBusy] = useState(true);
  const [tab, setTab] = useState<SourceTab>("canvas");
  const [canvasSources, setCanvasSources] = useState<CanvasSource[]>([]);
  const [canvasSourcesError, setCanvasSourcesError] = useState<string | null>(null);
  const [canvasSourcesBusy, setCanvasSourcesBusy] = useState(true);
  const [files, setFiles] = useState<FileSource[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [pickedCanvas, setPickedCanvas] = useState<Record<string, boolean>>({});
  const [pickedFiles, setPickedFiles] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncFlash, setSyncFlash] = useState<string | null>(null);

  const library = libraries.find((entry) => entry.id === libraryId) || null;
  const canSync = !!library && library.access === "owner";
  const pickedCount = Object.values(pickedCanvas).filter(Boolean).length + Object.values(pickedFiles).filter(Boolean).length;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => { closeRef.current?.focus(); }, []);

  const loadLibraries = useCallback(async () => {
    setLibrariesBusy(true);
    setLibraryError(null);
    const ensured = await cmd({ type: "canvas/assetLibrary/ensure" });
    const listed = await cmd({ type: "canvas/assetLibrary/list" });
    if (!alive.current) return;
    setLibrariesBusy(false);
    if (!listed || !listed.ok) {
      setLibraryError(hostCommandError(listed, "读取素材库失败"));
      return;
    }
    const next: LibraryView[] = Array.isArray(listed.libraries) ? listed.libraries.map((entry: any) => ({
      id: String(entry && entry.id || ""), name: String(entry && entry.name || "素材库"),
      visibility: String(entry && entry.visibility || ""), access: String(entry && entry.access || ""),
      itemCount: Number(entry && entry.itemCount) || 0, updatedAt: Number(entry && entry.updatedAt) || 0,
    })) : [];
    setLibraries(next);
    const ensuredId = ensured && ensured.ok && ensured.library ? String(ensured.library.id || "") : "";
    setLibraryId((previous) => (previous && next.some((entry) => entry.id === previous) ? previous : ensuredId || (next[0] ? next[0].id : "")));
  }, [cmd]);

  const loadCanvasSources = useCallback(async () => {
    setCanvasSourcesBusy(true);
    setCanvasSourcesError(null);
    const res = await cmd({ type: "canvas/get", canvasId });
    if (!alive.current) return;
    setCanvasSourcesBusy(false);
    if (!res || !res.ok) {
      setCanvasSourcesError(hostCommandError(res, "读取当前画布节点失败"));
      return;
    }
    const nodes: any[] = res.canvas && res.canvas.doc && Array.isArray(res.canvas.doc.nodes) ? res.canvas.doc.nodes : [];
    const next: CanvasSource[] = [];
    for (const node of nodes) {
      const ref = mediaRefOf(node);
      if (!ref) continue;
      const label = String(node.name || node.title || node.type || node.id);
      const kind = String(node.type || "节点");
      next.push({ nodeId: String(node.id), label, meta: kind + " · 已有素材引用" });
    }
    setCanvasSources(next);
  }, [canvasId, cmd]);

  const loadFiles = useCallback(async () => {
    setFilesBusy(true);
    setFilesError(null);
    const res = await callBridge("photos", { type: "photos/library", limit: 80, offset: 0 });
    if (!alive.current) return;
    setFilesBusy(false);
    setFilesLoaded(true);
    if (!res || !res.ok) {
      setFilesError(hostCommandError(res, "读取 DX 文件失败"));
      setFiles([]);
      return;
    }
    const items = unwrapValue(res).items;
    const next: FileSource[] = [];
    for (const item of Array.isArray(items) ? items : []) {
      const node = item && item.node ? item.node : null;
      if (!node || !node.id) continue;
      const mime = String(node.mime || "");
      if (!mime.startsWith("image/") && !mime.startsWith("video/")) continue;
      next.push({ nodeId: String(node.id), label: String(node.name || node.id), meta: (mime || "文件") + (item.folderName ? " · " + String(item.folderName) : "") });
    }
    setFiles(next);
  }, []);

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);
  useEffect(() => { void loadCanvasSources(); }, [loadCanvasSources]);
  useEffect(() => { if (tab === "files" && !filesLoaded && !filesBusy) void loadFiles(); }, [tab, filesLoaded, filesBusy, loadFiles]);

  const toggle = (setter: typeof setPickedCanvas, nodeId: string) => {
    setter((previous) => ({ ...previous, [nodeId]: !previous[nodeId] }));
  };

  const sync = useCallback(async () => {
    if (!libraryId || syncing || !canSync) return;
    const items = [
      ...canvasSources.filter((source) => pickedCanvas[source.nodeId]).map((source) => ({ nodeId: source.nodeId, name: source.label, canvasId })),
      ...files.filter((source) => pickedFiles[source.nodeId]).map((source) => ({ nodeId: source.nodeId, name: source.label })),
    ];
    if (!items.length) return;
    setSyncing(true);
    setSyncError(null);
    setSyncFlash(null);
    const res = await cmd({ type: "canvas/assetLibrary/syncSources", libraryId, items });
    if (!alive.current) return;
    setSyncing(false);
    if (!res || !res.ok) {
      setSyncError(hostCommandError(res, "同步素材到素材库失败"));
      return;
    }
    const imported = Number(res.imported) || 0;
    setSyncFlash(imported > 0
      ? "已同步 " + imported + " 项素材（同一来源重复同步不会重复建条目）"
      : "没有新增条目：选中的来源都已经在素材库里（sourceKey 去重）");
    setPickedCanvas({});
    setPickedFiles({});
    await loadLibraries();
  }, [canvasId, canvasSources, canSync, cmd, files, libraryId, loadLibraries, pickedCanvas, pickedFiles, syncing]);

  const currentList = tab === "canvas" ? canvasSources : files;
  const picked = tab === "canvas" ? pickedCanvas : pickedFiles;

  return (
    <aside
      className="canvas-share-panel canvas-dxos-panel canvas-dxos-panel--wide"
      role="complementary"
      aria-labelledby={titleId}
      data-canvas-assets-panel
      data-canvas-assets-canvas={canvasId}
      data-canvas-assets-library={libraryId}
      data-canvas-assets-can-sync={canSync ? "1" : "0"}
      data-canvas-assets-selected={String(pickedCount)}
      data-canvas-assets-canvas-sources={String(canvasSources.length)}
      data-canvas-assets-file-sources={String(files.length)}
    >
      <header className="canvas-share-panel__head">
        <div className="canvas-share-panel__titles">
          <h2 id={titleId} className="canvas-share-panel__title">素材同步</h2>
          {title ? <p className="canvas-share-panel__subject" title={title}>{title}</p> : null}
        </div>
        <button ref={closeRef} type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="关闭素材同步面板" data-canvas-assets-close onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="canvas-share-panel__body">
        {syncFlash ? <p className="canvas-share-flash" role="status" data-canvas-assets-flash>{syncFlash}</p> : null}
        {syncError ? <p className="gov-error" role="alert" data-canvas-assets-error>{syncError}</p> : null}
        {libraryError ? <p className="gov-error" role="alert" data-canvas-assets-library-error>{libraryError}</p> : null}

        <section className="canvas-share-section">
          <h3 className="canvas-share-section__title">目标素材库</h3>
          <p className="canvas-share-hint">
            同步 = 把来源登记成素材条目并复用同一个资源引用；同一来源（sourceKey）不会重复建条目。只有素材库所有者可以同步导入来源。
          </p>
          <div className="canvas-dxos-actions">
            <select
              className="canvas-share-select canvas-dxos-select"
              aria-label="目标素材库"
              data-canvas-assets-library-select
              value={libraryId}
              disabled={librariesBusy || !libraries.length}
              onChange={(event) => setLibraryId(event.target.value)}
            >
              {libraries.length ? libraries.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name + " · " + (entry.access === "owner" ? "所有者" : "只读") + " · " + (entry.itemCount || 0) + " 项"}</option>
              )) : <option value="">{librariesBusy ? "正在读取素材库…" : "没有可用的素材库"}</option>}
            </select>
            <button type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="重新读取素材库" data-canvas-assets-library-refresh disabled={librariesBusy} onClick={() => void loadLibraries()}>
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
          {library ? (
            <p className="canvas-share-hint" data-canvas-assets-access={library.access || ""}>
              {library.access === "owner" ? "当前素材库：所有者，可同步。" : "当前素材库：只读，不能同步（可以换一个自己的素材库）。"}
            </p>
          ) : null}
        </section>

        <section className="canvas-share-section">
          <h3 className="canvas-share-section__title">来源</h3>
          <div className="segmented text" role="group" aria-label="素材来源">
            <button type="button" aria-pressed={tab === "canvas"} data-canvas-assets-tab="canvas" onClick={() => setTab("canvas")}>当前画布节点（{canvasSources.length}）</button>
            <button type="button" aria-pressed={tab === "files"} data-canvas-assets-tab="files" onClick={() => setTab("files")}>DX 文件（{files.length}）</button>
          </div>
          <p className="canvas-share-hint">
            {tab === "canvas"
              ? "只列出当前画布里有 openarc-asset 素材引用的节点；同步后素材库条目引用同一份资源。"
              : "来自 DX 虚拟文件树里当前账号可见的图片 / 视频（共享盘、部门盘、个人目录）；不列隐藏文件。"}
          </p>
          {tab === "canvas" && canvasSourcesBusy ? <p className="canvas-share-hint" role="status">正在读取画布节点…</p> : null}
          {tab === "canvas" && canvasSourcesError ? <p className="gov-error" role="alert" data-canvas-assets-canvas-error>{canvasSourcesError}</p> : null}
          {tab === "files" && filesBusy ? <p className="canvas-share-hint" role="status">正在读取 DX 文件…</p> : null}
          {tab === "files" && filesError ? <p className="gov-error" role="alert" data-canvas-assets-files-error>{filesError}</p> : null}
          {currentList.length ? (
            <ul className="canvas-dxos-source-list" data-canvas-assets-sources>
              {currentList.map((source) => (
                <li key={source.nodeId}>
                  <label className="canvas-dxos-source">
                    <input type="checkbox" checked={!!picked[source.nodeId]} onChange={() => toggle(tab === "canvas" ? setPickedCanvas : setPickedFiles, source.nodeId)} />
                    <span className="canvas-dxos-source__name" title={source.label}>{source.label}</span>
                    <span className="canvas-dxos-source__meta">{source.meta}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            !canvasSourcesBusy && !filesBusy && !canvasSourcesError && !filesError ? (
              <p className="canvas-share-empty" data-canvas-assets-sources-empty>
                {tab === "canvas" ? "当前画布没有可同步的素材节点（节点要带 openarc-asset 引用）。" : "DX 文件树里没有当前账号可见的图片 / 视频；也可以切到「当前画布节点」。"}
              </p>
            ) : null
          )}
        </section>

        <div className="canvas-dxos-actions">
          <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-assets-sync disabled={!canSync || pickedCount === 0 || syncing} onClick={() => void sync()}>
            {syncing ? <LoaderCircle size={14} aria-hidden="true" className="canvas-dxos-spin" /> : <Images size={14} aria-hidden="true" />}
            <span className="ds-btn__label">{syncing ? "同步中…" : "同步 " + pickedCount + " 项到素材库"}</span>
          </button>
          {!canSync && libraryId ? <span className="set-cap">目标素材库只读：请选择自己的素材库。</span> : null}
          {canSync && pickedCount === 0 ? <span className="set-cap">勾选来源后同步。</span> : null}
        </div>
        <p className="canvas-share-hint" data-canvas-assets-limit>
          单次最多 600 项；素材库容量由后端统一限制（超限时结构化拒绝，不截断）。
        </p>
      </div>
    </aside>
  );
}
