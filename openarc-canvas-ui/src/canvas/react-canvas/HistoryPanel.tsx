import { useEffect, useMemo, useState } from "react";
import { AudioLines, Box, ChevronDown, ChevronLeft, ChevronRight, Grid2X2, Image as ImageIcon, List, RotateCcw, Search, Video } from "lucide-react";
import { cachedAssetCommand, clearAssetCache } from "./assetLibraryCache";

type LibraryInfo = { id: string; name: string; visibility?: string; access?: string; itemCount?: number };
type HistoryItem = {
  id: string;
  kind?: string;
  title?: string;
  prompt?: string;
  group?: string;
  category?: string;
  mediaKind?: string;
  media?: { kind?: string; mime?: string };
  previewUrl?: string;
  url?: string;
  sourceKey?: string;
  sourceNodeId?: string;
  createdAt?: number;
  updatedAt?: number;
};
type Bridge = { command: (request: Record<string, unknown>) => Promise<Record<string, unknown>> };
type Tab = "image" | "video" | "audio" | "3d";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "3d", label: "3D" },
];

function bridge(): Bridge | null {
  const api = (window as unknown as { openarc?: { canvas?: { command?: Bridge["command"] } } }).openarc?.canvas;
  return api && typeof api.command === "function" ? (api as Bridge) : null;
}

function itemTab(item: HistoryItem): Tab {
  const kind = String(item.mediaKind || (item.media && item.media.kind) || item.kind || "").toLowerCase();
  if (kind.includes("video")) return "video";
  if (kind.includes("audio")) return "audio";
  if (kind.includes("3d")) return "3d";
  return "image";
}

function itemTime(item: HistoryItem) {
  const value = Number(item.createdAt || item.updatedAt || 0);
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function tabIcon(tab: Tab) {
  if (tab === "video") return <Video size={13} />;
  if (tab === "audio") return <AudioLines size={13} />;
  if (tab === "3d") return <Box size={13} />;
  return <ImageIcon size={13} />;
}

export function HistoryPanel({ canvasId, onClose, onInsert }: { canvasId: string; onClose: () => void; onInsert: (item: HistoryItem) => void }) {
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [tab, setTab] = useState<Tab>("image");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    const api = bridge();
    if (!api) {
      setLoading(false);
      setError("未连接桌面后端，无法读取历史");
      return;
    }
    try {
      const listed = await cachedAssetCommand(api, { type: "canvas/assetLibrary/list" });
      if (!listed || listed.ok !== true) throw new Error(String((listed && listed.error) || "HISTORY_LIST_FAILED"));
      let next = Array.isArray(listed.libraries) ? (listed.libraries as LibraryInfo[]) : [];
      if (!next.length) {
        const ensured = await cachedAssetCommand(api, { type: "canvas/assetLibrary/ensure" });
        if (ensured && ensured.ok === true && ensured.library) next = [ensured.library as LibraryInfo];
      }
      setLibraries(next);
      const library = next[0];
      if (!library) {
        setItems([]);
        return;
      }
      const got = await cachedAssetCommand(api, { type: "canvas/assetLibrary/get", libraryId: library.id });
      if (!got || got.ok !== true) throw new Error(String((got && got.error) || "HISTORY_GET_FAILED"));
      setItems(Array.isArray(got.items) ? (got.items as HistoryItem[]) : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "HISTORY_LOAD_FAILED");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items
      .filter((item) => itemTab(item) === tab)
      .filter((item) => {
        if (!query) return true;
        return [item.title, item.prompt, item.group, item.category]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => Number(b.createdAt || b.updatedAt || 0) - Number(a.createdAt || a.updatedAt || 0));
  }, [items, tab, search]);

  const insert = async (item: HistoryItem) => {
    const direct = item.url || item.previewUrl || "";
    if (direct) { onInsert({ ...item, url: direct }); return; }
    const api = bridge();
    if (!api) { setStatus("未连接桌面后端，无法插入"); return; }
    const library = libraries[0];
    if (library && item.id) {
      try {
        const attached = await api.command({ type: "canvas/assetLibrary/attach", libraryId: library.id, itemId: item.id, canvasId, x: 0, y: 0 });
        if (attached && attached.ok === true) { onInsert({ ...item, url: String(attached.ref || item.url || item.previewUrl || "") }); return; }
        setStatus(String((attached && (attached.detail || attached.error)) || "ATTACH_FAILED"));
        return;
      } catch (caught) { setStatus(caught instanceof Error ? caught.message : "ATTACH_FAILED"); return; }
    }
    const url = item.url || item.previewUrl || "";
    if (!url) { setStatus("该记录缺媒体地址，无法插入画布"); return; }
    onInsert({ ...item, url });
  };

  return (
    <aside className="rc-history-drawer" data-testid="history-panel" aria-label="历史">
      <div className="rc-history-head">
        <button className="rc-assets-close" aria-label="关闭历史" data-testid="history-close" onClick={onClose}>
          <ChevronLeft size={18} />
        </button>
        <strong className="rc-history-title">历史</strong>
        <div className="rc-history-view">
          <button className={"rc-history-view-btn" + (view === "list" ? " is-active" : "")} data-testid="history-view-list" aria-label="列表视图" onClick={() => setView("list")}><List size={14} /></button>
          <button className={"rc-history-view-btn" + (view === "grid" ? " is-active" : "")} data-testid="history-view-grid" aria-label="网格视图" onClick={() => setView("grid")}><Grid2X2 size={14} /></button>
        </div>
      </div>
      <div className="rc-history-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={"rc-history-tab" + (tab === entry.id ? " is-active" : "")}
            data-testid={"history-tab-" + entry.id}
            onClick={() => { setTab(entry.id); setExpanded(null); setStatus(""); }}
          >
            {tabIcon(entry.id)}<span>{entry.label}</span>
          </button>
        ))}
      </div>
      <label className="rc-history-search">
        <Search size={14} />
        <input data-testid="history-search" placeholder="搜索" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="rc-history-scroll">
        {loading ? (
          <div className="rc-history-empty">加载中…</div>
        ) : error ? (
          <div className="rc-history-empty" data-testid="history-error">
            <p>{error}</p>
            <button className="rc-assets-retry" data-testid="history-retry" onClick={() => { clearAssetCache(); void load(); }}>重试</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rc-history-empty" data-testid="history-empty">暂无生成历史</div>
        ) : view === "grid" ? (
          <div className="rc-history-grid" data-testid="history-grid">
            {filtered.map((item) => (
              <button key={item.id} className="rc-history-card" data-testid="history-item" title={item.title || "历史记录"} onClick={() => insert(item)}>
                <span className="rc-history-thumb">{item.previewUrl || item.url ? <img src={item.previewUrl || item.url} alt="" /> : tabIcon(itemTab(item))}</span>
                <span className="rc-history-name">{item.title || "未命名记录"}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rc-history-list" data-testid="history-list">
            {filtered.map((item) => (
              <div key={item.id} className={"rc-history-row" + (expanded === item.id ? " is-expanded" : "")}>
                <button className="rc-history-main" data-testid="history-item" onClick={() => insert(item)}>
                  <span className="rc-history-thumb">{item.previewUrl || item.url ? <img src={item.previewUrl || item.url} alt="" /> : tabIcon(itemTab(item))}</span>
                  <span className="rc-history-text">
                    <span className="rc-history-name">{item.title || "未命名记录"}</span>
                    <span className="rc-history-meta">{item.group || item.category || item.kind || "素材"} · {itemTime(item)}</span>
                  </span>
                  <ChevronRight size={14} />
                </button>
                <button className="rc-history-expand" data-testid="history-expand" aria-label="展开详情" onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                  <ChevronDown size={14} className={expanded === item.id ? "is-open" : ""} />
                </button>
                {expanded === item.id ? (
                  <div className="rc-history-detail" data-testid="history-detail">
                    <p>{item.prompt || item.title || "无描述"}</p>
                    <span>{item.sourceNodeId ? "来源：画布" : item.sourceKey || "来源：素材库"} {itemTime(item)}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {status ? <div className="rc-history-status" data-testid="history-status">{status}</div> : null}
      </div>
      <div className="rc-history-foot">
        <button className="rc-assets-action" disabled title="AI 角色（未接入）"><RotateCcw size={13} />AI 角色</button>
        <span className="rc-history-count">{filtered.length} 条</span>
      </div>
    </aside>
  );
}
