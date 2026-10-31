import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Folder, Image as ImageIcon, Images, Plus, Search, Sparkles } from "lucide-react";
import { cachedAssetCommand, clearAssetCache } from "./assetLibraryCache";

type LibraryInfo = {
  id: string;
  name: string;
  visibility?: string;
  access?: string;
  ownerId?: string;
  itemCount?: number;
};
type AssetItem = {
  id: string;
  kind?: string;
  title?: string;
  group?: string;
  category?: string;
  prompt?: string;
  sourceKey?: string;
  sourceNodeId?: string;
  mediaKind?: string;
  media?: { kind?: string; mime?: string; name?: string };
  coverRef?: string;
  resourceRef?: string;
  previewUrl?: string;
  url?: string;
};
type Bridge = { command: (request: Record<string, unknown>) => Promise<Record<string, unknown>> };
type Character = { id: string; name: string; description?: string; prompt?: string; referenceUrls?: string[] };

const FOLDERS = ["角色", "场景", "道具", "风格", "音效", "Others"];

function bridge(): Bridge | null {
  const api = (window as unknown as { openarc?: { canvas?: { command?: Bridge["command"] } } }).openarc?.canvas;
  return api && typeof api.command === "function" ? (api as Bridge) : null;
}

function isPersonal(library: LibraryInfo) {
  return library.access === "owner" || String(library.visibility || "").toUpperCase() === "PRIVATE" || !library.visibility;
}

function itemFolder(item: AssetItem) {
  return item.group || item.category || "未分组";
}

function itemType(item: AssetItem) {
  return item.mediaKind || (item.media && item.media.kind) || item.kind || "asset";
}

function itemSource(item: AssetItem) {
  if (item.sourceNodeId) return "画布";
  if (item.sourceKey) return "素材库";
  return "素材库";
}

export function AssetsPanel({ canvasId, onClose, onInsertCharacter }: { canvasId: string; onClose: () => void; onInsertCharacter?: (character: Character) => void }) {
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [activeTab, setActiveTab] = useState<"personal" | "team">("personal");
  const [activeLibrary, setActiveLibrary] = useState<LibraryInfo | null>(null);
  const [items, setItems] = useState<AssetItem[]>([]);
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState<string>("全部");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [serverFolders, setServerFolders] = useState<string[]>([]);
  const [folderCreating, setFolderCreating] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [moveItemId, setMoveItemId] = useState("");
  const [moveTarget, setMoveTarget] = useState("未分组");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [characterForm, setCharacterForm] = useState<Character | null>(null);
  const [characterError, setCharacterError] = useState("");
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const loadLibraries = async () => {
    setLoading(true);
    setError("");
    const api = bridge();
    if (!api) {
      setLoading(false);
      setError("未连接桌面后端，无法读取素材库");
      return;
    }
    try {
      const listed = await cachedAssetCommand(api, { type: "canvas/assetLibrary/list" });
      if (!listed || listed.ok !== true) throw new Error(String((listed && listed.error) || "ASSET_LIST_FAILED"));
      let next = Array.isArray(listed.libraries) ? (listed.libraries as LibraryInfo[]) : [];
      if (!next.length) {
        const ensured = await cachedAssetCommand(api, { type: "canvas/assetLibrary/ensure" });
        if (ensured && ensured.ok === true && ensured.library) next = [ensured.library as LibraryInfo];
      }
      setLibraries(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ASSET_LIST_FAILED");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLibraries();
  }, []);

  const personal = useMemo(() => libraries.filter((library) => isPersonal(library)), [libraries]);
  const team = useMemo(() => libraries.filter((library) => !isPersonal(library)), [libraries]);
  const tabLibraries = activeTab === "personal" ? personal : team;

  useEffect(() => {
    const library = tabLibraries[0] || null;
    setActiveLibrary(library);
    setFolder("全部");
    if (!library) {
      setItems([]);
      return;
    }
    const api = bridge();
    if (!api) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    cachedAssetCommand(api, { type: "canvas/assetLibrary/get", libraryId: library.id })
      .then((result) => {
        if (cancelled) return;
        if (!result || result.ok !== true) throw new Error(String((result && result.error) || "ASSET_GET_FAILED"));
        setItems(Array.isArray(result.items) ? (result.items as AssetItem[]) : []);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "ASSET_GET_FAILED");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, libraries]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (folder !== "全部" && itemFolder(item) !== folder) return false;
      if (!query) return true;
      return [item.title, item.prompt, item.group, item.category, item.kind]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [items, search, folder]);

  const uploadAsset = async (file: File) => {
    const api = bridge();
    if (!api) { setError("未连接桌面后端，无法上传"); return; }
    if (!activeLibrary) { setError("请先选择素材库"); return; }
    setUploading(true);
    setError("");
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
        reader.readAsDataURL(file);
      });
      const result = await api.command({ type: "canvas/assetLibrary/import", libraryId: activeLibrary.id, name: file.name, mime: file.type || "image/png", dataUrl });
      if (!result || result.ok !== true) throw new Error(String((result && result.error) || "ASSET_IMPORT_FAILED"));
      clearAssetCache();
      const refreshed = await api.command({ type: "canvas/assetLibrary/get", libraryId: activeLibrary.id });
      if (refreshed && refreshed.ok === true) setItems(Array.isArray(refreshed.items) ? (refreshed.items as AssetItem[]) : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ASSET_IMPORT_FAILED");
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    const api = bridge();
    if (!api || !activeLibrary) { setServerFolders([]); return; }
    let cancelled = false;
    void api.command({ type: "canvas/assetLibrary/folderList", libraryId: activeLibrary.id }).then((result) => {
      if (cancelled) return;
      if (result && result.ok === true && Array.isArray(result.folders)) setServerFolders((result.folders as Array<{ name?: string }>).map((folder) => String(folder.name || "")).filter(Boolean));
      else setServerFolders([]);
    }).catch(() => { if (!cancelled) setServerFolders([]); });
    return () => { cancelled = true; };
  }, [activeLibrary]);
  const folderNames = useMemo(() => Array.from(new Set(["全部", "未分组", ...serverFolders, ...customFolders, ...items.map((item) => itemFolder(item))])), [customFolders, items, serverFolders]);
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    FOLDERS.forEach((name) => { counts[name] = 0; });
    items.forEach((item) => { counts[itemFolder(item)] += 1; });
    return counts;
  }, [items, customFolders]);

  const loadCharacters = async () => {
    const api = bridge(); if (!api || !activeLibrary) return;
    try {
      const result = await api.command({ type: "canvas/assetLibrary/characterList", libraryId: activeLibrary.id });
      if (!result || result.ok !== true) throw new Error(String((result && result.error) || "CHARACTER_LIST_FAILED"));
      setCharacters(Array.isArray(result.characters) ? result.characters as Character[] : []);
    } catch (caught) { setCharacterError(caught instanceof Error ? caught.message : "CHARACTER_LIST_FAILED"); }
  };
  const saveCharacter = async () => {
    const api = bridge(); if (!api || !activeLibrary || !characterForm) return;
    try {
      const payload = { type: characterForm.id ? "canvas/assetLibrary/characterUpdate" : "canvas/assetLibrary/characterCreate", libraryId: activeLibrary.id, id: characterForm.id, name: characterForm.name, description: characterForm.description || "", prompt: characterForm.prompt || "", referenceUrls: characterForm.referenceUrls || [] };
      const result = await api.command(payload);
      if (!result || result.ok !== true) throw new Error(String((result && (result.detail || result.error)) || "CHARACTER_SAVE_FAILED"));
      setCharacterForm(null); setCharacterError(""); await loadCharacters();
    } catch (caught) { setCharacterError(caught instanceof Error ? caught.message : "CHARACTER_SAVE_FAILED"); }
  };
  const removeCharacter = async (character: Character) => {
    const api = bridge(); if (!api || !activeLibrary) return;
    try {
      const result = await api.command({ type: "canvas/assetLibrary/characterDelete", libraryId: activeLibrary.id, id: character.id });
      if (!result || result.ok !== true) throw new Error(String((result && (result.detail || result.error)) || "CHARACTER_DELETE_FAILED"));
      await loadCharacters();
    } catch (caught) { setCharacterError(caught instanceof Error ? caught.message : "CHARACTER_DELETE_FAILED"); }
  };

  const attachItem = async (item: { id: string; title?: string }) => {
    const api = bridge(); if (!api || !activeLibrary) { setError("未配置素材库，无法插入"); return; }
    try {
      const result = await api.command({ type: "canvas/assetLibrary/attach", libraryId: activeLibrary.id, itemId: item.id, canvasId, x: 0, y: 0 });
      if (!result || result.ok !== true) throw new Error(String((result && (result.detail || result.error)) || "ATTACH_FAILED"));
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "ATTACH_FAILED"); }
  };
  const createFolder = async () => {
    const api = bridge(); if (!api || !activeLibrary) return;
    const name = folderDraft.trim(); if (!name) return;
    try {
      const result = await api.command({ type: "canvas/assetLibrary/folderCreate", libraryId: activeLibrary.id, name });
      if (!result || result.ok !== true) throw new Error(String((result && result.detail) || (result && result.error) || "FOLDER_CREATE_FAILED"));
      setCustomFolders((prev) => prev.includes(name) ? prev : [...prev, name]);
      setFolderDraft(""); setFolderCreating(false); setFolder(name);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "FOLDER_CREATE_FAILED"); }
  };
  const renameFolder = async (from: string) => {
    const api = bridge(); if (!api || !activeLibrary) return;
    const to = window.prompt("重命名文件夹", from)?.trim(); if (!to || to === from) return;
    try {
      const result = await api.command({ type: "canvas/assetLibrary/folderRename", libraryId: activeLibrary.id, from, to });
      if (!result || result.ok !== true) throw new Error(String((result && result.detail) || (result && result.error) || "FOLDER_RENAME_FAILED"));
      setCustomFolders((prev) => Array.from(new Set(prev.map((name) => name === from ? to : name))));
      setItems((prev) => prev.map((item) => itemFolder(item) === from ? { ...item, group: to } : item));
      setFolder((prev) => prev === from ? to : prev);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "FOLDER_RENAME_FAILED"); }
  };
  const moveItem = async () => {
    const api = bridge(); if (!api || !activeLibrary || !moveItemId) return;
    try {
      const result = await api.command({ type: "canvas/assetLibrary/folderMove", libraryId: activeLibrary.id, itemId: moveItemId, folder: moveTarget });
      if (!result || result.ok !== true) throw new Error(String((result && result.detail) || (result && result.error) || "FOLDER_MOVE_FAILED"));
      setItems((prev) => prev.map((item) => item.id === moveItemId ? { ...item, group: moveTarget } : item));
      setMoveItemId(""); setFolder(moveTarget);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "FOLDER_MOVE_FAILED"); }
  };

  return (
    <aside className="rc-assets-drawer" data-testid="assets-panel" aria-label="素材库">
      {characterOpen ? (
        <div className="rc-ai-role-panel" data-testid="ai-role-panel">
          <div className="rc-ai-role-head"><strong>AI 角色</strong><button data-testid="ai-role-close" onClick={() => { setCharacterOpen(false); setCharacterForm(null); }}>×</button><button data-testid="ai-role-new" onClick={() => setCharacterForm({ id: "", name: "", description: "", prompt: "", referenceUrls: [] })}>新建角色</button></div>
          {characterError ? <div className="rc-lan-error" data-testid="ai-role-error">{characterError}</div> : null}
          {characterForm ? <div className="rc-ai-role-form">
            <input data-testid="ai-role-name" placeholder="角色名称" value={characterForm.name} onChange={(event) => setCharacterForm((prev) => prev ? { ...prev, name: event.target.value } : prev)} />
            <input data-testid="ai-role-desc" placeholder="描述（≤500字）" value={characterForm.description || ""} onChange={(event) => setCharacterForm((prev) => prev ? { ...prev, description: event.target.value } : prev)} />
            <textarea data-testid="ai-role-prompt" placeholder="角色提示词（≤4000字）" value={characterForm.prompt || ""} onChange={(event) => setCharacterForm((prev) => prev ? { ...prev, prompt: event.target.value } : prev)} />
            <input data-testid="ai-role-refs" placeholder="参考图 URL，逗号分隔" value={(characterForm.referenceUrls || []).join(",")} onChange={(event) => setCharacterForm((prev) => prev ? { ...prev, referenceUrls: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) } : prev)} />
            <div><button data-testid="ai-role-save" onClick={() => void saveCharacter()}>保存</button><button data-testid="ai-role-cancel" onClick={() => setCharacterForm(null)}>取消</button></div>
          </div> : null}
          <div className="rc-ai-role-grid" data-testid="ai-role-grid">
            {characters.length === 0 ? <div className="rc-assets-empty" data-testid="ai-role-empty">暂无角色</div> : characters.map((character) => (
              <div className="rc-ai-role-card" data-testid="ai-role-card" key={character.id}>
                <strong>{character.name}</strong><span>{character.description || "无描述"}</span><small>{(character.prompt || "").slice(0, 80)}</small>
                {(character.referenceUrls || []).slice(0, 3).map((url) => <img key={url} src={url} alt="" />)}
                <div><button data-testid="ai-role-edit" onClick={() => setCharacterForm(character)}>编辑</button><button data-testid="ai-role-insert" onClick={() => onInsertCharacter?.(character)}>插入画布</button><button data-testid="ai-role-delete" onClick={() => void removeCharacter(character)}>删除</button></div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="rc-assets-head">
        <button className="rc-assets-close" aria-label="关闭素材库" data-testid="assets-close" onClick={onClose}>
          <ChevronLeft size={18} />
        </button>
        <strong className="rc-assets-title">素材库</strong>
        <div className="rc-assets-actions">
          <button className="rc-assets-action" data-testid="assets-ai-role" onClick={() => { setCharacterOpen(true); void loadCharacters(); }}>
            <Sparkles size={12} />AI 角色
          </button>
          <button className="rc-assets-plus" data-testid="assets-new-folder" title="新建文件夹" aria-label="新建文件夹" onClick={() => setFolderCreating(true)}>
            <Plus size={16} />
          </button>
        </div>
      </div>
      <div className="rc-assets-tabs" role="tablist">
        {(["personal", "team"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={"rc-assets-tab" + (activeTab === tab ? " is-active" : "")}
            data-testid={"assets-tab-" + tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "personal" ? "个人" : "团队"}
          </button>
        ))}
      </div>
      <label className="rc-assets-search">
        <Search size={14} />
        <input
          data-testid="assets-search"
          placeholder="搜索"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="rc-assets-scroll">

        <div className="rc-assets-divider">文件夹</div>
        {folderCreating ? (
          <div className="rc-assets-folder-create">
            <input data-testid="assets-folder-input" autoFocus placeholder="文件夹名称" value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createFolder(); if (event.key === "Escape") setFolderCreating(false); }} />
            <button data-testid="assets-folder-confirm" onClick={() => void createFolder()}>确定</button>
            <button data-testid="assets-folder-cancel" onClick={() => setFolderCreating(false)}>取消</button>
          </div>
        ) : null}
        {folderNames.map((name) => (
          <div className="rc-assets-folder-row" key={name}>
            <button
              className={"rc-assets-folder" + (folder === name ? " is-active" : "")}
              data-testid={"assets-folder-" + name}
              onClick={() => setFolder(folder === name ? "全部" : name)}
            >
              <Folder size={14} />
              <span>{name}</span>
              <span className="rc-assets-count">{folderCounts[name] || 0}</span>
            </button>
            {name !== "全部" && name !== "未分组" ? <button className="rc-assets-folder-rename" data-testid={"assets-folder-rename-" + name} title="重命名文件夹" onClick={() => void renameFolder(name)}>✎</button> : null}
          </div>
        ))}
        <div className="rc-assets-divider">素材</div>
        {loading ? (
          <div className="rc-assets-empty">加载中…</div>
        ) : error ? (
          <div className="rc-assets-empty" data-testid="assets-error">
            <p>{error}</p>
            <button className="rc-assets-retry" data-testid="assets-retry" onClick={() => { clearAssetCache(); void loadLibraries(); }}>
              重试
            </button>
          </div>
        ) : !activeLibrary ? (
          <div className="rc-assets-empty" data-testid="assets-empty">{activeTab === "team" ? "暂无团队素材库" : "暂无个人素材库"}</div>
        ) : filtered.length === 0 ? (
          <div className="rc-assets-empty" data-testid="assets-empty">{items.length === 0 ? "暂无素材" : "没有匹配的素材"}</div>
        ) : (
          <div className="rc-assets-grid" data-testid="assets-grid">
            {filtered.map((item) => (
              <button key={item.id} className="rc-assets-card" data-testid="assets-item" title={item.title || "素材"} onClick={() => { setMoveItemId(item.id); setMoveTarget(itemFolder(item)); }}>
                <span className="rc-assets-thumb">
                  {(item.previewUrl || item.url) ? <img src={item.previewUrl || item.url} alt="" /> : <ImageIcon size={20} />}
                </span>
                <span className="rc-assets-name">{item.title || "未命名素材"}</span>
                <span className="rc-assets-meta">{itemType(item)} · {itemSource(item)}</span>
                <span className="rc-assets-insert" role="button" tabIndex={0} data-testid="assets-attach" onClick={(event) => { event.stopPropagation(); void attachItem(item); }} onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); void attachItem(item); } }}>插入</span>
              </button>
            ))}
          </div>
        )}
        {moveItemId ? (
          <div className="rc-assets-move" data-testid="assets-move-bar">
            <select data-testid="assets-move-target" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
              {folderNames.filter((name) => name !== "全部").map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button data-testid="assets-move-confirm" onClick={() => void moveItem()}>移动</button>
            <button data-testid="assets-move-cancel" onClick={() => setMoveItemId("")}>取消</button>
          </div>
        ) : null}
      </div>
      <div className="rc-assets-foot">
        <button className="rc-assets-action" data-testid="assets-upload" disabled={!activeLibrary || uploading} title={activeLibrary ? "上传素材" : "请先选择素材库"} onClick={() => uploadRef.current?.click()}>
          <Images size={13} />{uploading ? "上传中…" : "上传"}
        </button>
        <input ref={uploadRef} type="file" accept="image/*" hidden data-testid="assets-upload-input" onChange={(event) => { const file = event.target.files && event.target.files[0]; if (file) void uploadAsset(file); event.target.value = ""; }} />
        <span className="rc-assets-foot-id">{canvasId}</span>
      </div>
    </aside>
  );
}
