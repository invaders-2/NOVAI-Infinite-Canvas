import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Search, Sparkles } from "lucide-react";
import { cachedAssetCommand, clearAssetCache } from "./assetLibraryCache";

type PromptItem = {
  id: string;
  kind?: string;
  title?: string;
  prompt?: string;
  promptRole?: string;
  category?: string;
  group?: string;
  mediaKind?: string;
  sourceKey?: string;
  createdBy?: string;
};
type Bridge = { command: (request: Record<string, unknown>) => Promise<Record<string, unknown>> };

function bridge(): Bridge | null {
  const api = (window as unknown as { openarc?: { canvas?: { command?: Bridge["command"] } } }).openarc?.canvas;
  return api && typeof api.command === "function" ? (api as Bridge) : null;
}

const PUBLIC_MARK = "system:";

export function TemplatesPanel({ onClose, onUse }: { onClose: () => void; onUse: (prompt: string) => void }) {
  const [items, setItems] = useState<PromptItem[]>([]);
  const [tab, setTab] = useState<"public" | "mine">("public");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    const api = bridge();
    if (!api) {
      setLoading(false);
      setError("未连接桌面后端，无法读取模板");
      return;
    }
    try {
      const ensured = await cachedAssetCommand(api, { type: "canvas/assetLibrary/ensure" });
      const library = ensured && ensured.ok === true && ensured.library ? (ensured.library as Record<string, unknown>) : null;
      const libraryId = library ? String(library.id || "") : "";
      if (!libraryId) throw new Error(String((ensured && ensured.error) || "TEMPLATE_LIBRARY_UNAVAILABLE"));
      const got = await cachedAssetCommand(api, { type: "canvas/assetLibrary/get", libraryId });
      if (!got || got.ok !== true) throw new Error(String((got && got.error) || "TEMPLATE_GET_FAILED"));
      const all = Array.isArray(got.items) ? (got.items as PromptItem[]) : [];
      setItems(all.filter((item) => item.kind === "prompt"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "TEMPLATE_LOAD_FAILED");
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
      .filter((item) => {
        const isPublic = String(item.sourceKey || "").indexOf(PUBLIC_MARK) === 0 || item.createdBy === "system";
        return tab === "public" ? isPublic : !isPublic;
      })
      .filter((item) => {
        if (!query) return true;
        return [item.title, item.prompt, item.group, item.category, item.promptRole]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase()
          .includes(query);
      });
  }, [items, tab, search]);

  return (
    <aside className="rc-templates-drawer" data-testid="templates-panel" aria-label="模板">
      <div className="rc-templates-head">
        <button className="rc-assets-close" aria-label="关闭模板" data-testid="templates-close" onClick={onClose}>
          <ChevronLeft size={18} />
        </button>
        <strong className="rc-templates-heading">模板</strong>
      </div>
      <div className="rc-templates-banner">
        <div className="rc-templates-banner-art" aria-hidden="true" />
        <div>
          <h2>使用模板加速创作</h2>
          <p>一键套用专业模板，快速构建你的专属场景。了解更多</p>
        </div>
      </div>
      <div className="rc-templates-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "public"} className={"rc-templates-tab" + (tab === "public" ? " is-active" : "")} data-testid="templates-tab-public" onClick={() => setTab("public")}>公共模板</button>
        <button role="tab" aria-selected={tab === "mine"} className={"rc-templates-tab" + (tab === "mine" ? " is-active" : "")} data-testid="templates-tab-mine" onClick={() => setTab("mine")}>我的模板</button>
      </div>
      <label className="rc-templates-search">
        <Search size={14} />
        <input data-testid="templates-search" placeholder="搜索资产包..." value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="rc-templates-scroll">
        {loading ? <div className="rc-templates-empty">加载中…</div> : error ? (
          <div className="rc-templates-empty" data-testid="templates-error">
            <p>{error}</p>
            <button className="rc-assets-retry" data-testid="templates-retry" onClick={() => { clearAssetCache(); void load(); }}>重试</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rc-templates-empty" data-testid="templates-empty">暂无模板</div>
        ) : (
          <div className="rc-templates-grid" data-testid="templates-grid">
            {filtered.map((item) => (
              <button key={item.id} className="rc-template-card" data-testid="template-card" title={item.title || "模板"} onClick={() => { if (item.prompt) onUse(item.prompt); }}>
                <span className="rc-template-thumb"><Sparkles size={18} /></span>
                <span className="rc-template-title">{item.title || "未命名模板"}</span>
                <span className="rc-template-summary">{item.prompt || "无提示词"}</span>
                <span className="rc-template-tag">{item.promptRole || item.category || item.group || "模板"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
