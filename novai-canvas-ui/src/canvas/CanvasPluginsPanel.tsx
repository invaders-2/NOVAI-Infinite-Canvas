/**
 * 画布宿主浮层 · 画布插件（数据 / 受控网络）。
 *
 * 真实命令：
 *   · developer/list（既有只读域）  列出本机已装载 App 的安全投影（含 enabled 与 manifest.canvas）
 *   · canvas/plugins/data           { pluginId, action: list|get|set|delete, key, value }
 *   · canvas/plugins/network        { pluginId, request: { url, method, headers, body, responseType } }
 *   · canvas/plugins/* 只接受**已安装 + 已启用 + 清单声明 canvas** 的插件；数据还要求 host.storage 声明，
 *     网络委托既有 developer/network/request（App 白名单 + DNS 公网校验 + 限流 + 审计）。
 * 插件列表的过滤条件在 UI 与后端两侧同时成立：列表只显示符合条件的插件，命令仍由后端复核。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Database, Globe, LoaderCircle, Pencil, Plug, RefreshCw, Trash2, X } from "lucide-react";
import {
  callBridge,
  formatJsonText,
  hostCommandError,
  parseJsonText,
  unwrapValue,
  type Cmd,
} from "./canvasDxosModel";

type PluginApp = {
  appId: string;
  enabled: boolean;
  version: string;
  build: number;
  manifest: {
    id?: string; name?: string; version?: string;
    canvas?: { nodeManifests?: string[]; templateManifests?: string[] } | null;
    network?: { domains?: string[]; methods?: string[]; maxResponseBytes?: number } | null;
  } | null;
};

export function CanvasPluginsPanel({ cmd, onClose }: { cmd: Cmd; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<PluginApp[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [keysBusy, setKeysBusy] = useState(false);
  const [dataKey, setDataKey] = useState("");
  const [dataText, setDataText] = useState("");
  const [dataBusy, setDataBusy] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataFlash, setDataFlash] = useState<string | null>(null);
  const [netUrl, setNetUrl] = useState("");
  const [netMethod, setNetMethod] = useState("GET");
  const [netHeaders, setNetHeaders] = useState("");
  const [netBody, setNetBody] = useState("");
  const [netBusy, setNetBusy] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const [netResult, setNetResult] = useState<string | null>(null);

  const selected = apps.find((app) => app.appId === selectedId) || null;

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

  const loadApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await callBridge("developer", { type: "developer/list" });
    if (!alive.current) return;
    setLoading(false);
    if (!res || !res.ok) {
      setError(hostCommandError(res, "读取已安装插件失败"));
      setApps([]);
      return;
    }
    const list = unwrapValue(res).apps;
    const next: PluginApp[] = (Array.isArray(list) ? list : [])
      .filter((app: any) => app && app.enabled === true && app.manifest && app.manifest.canvas)
      .map((app: any) => ({ appId: String(app.appId), enabled: true, version: String(app.version || ""), build: Number(app.build) || 0, manifest: app.manifest }));
    setApps(next);
    setSelectedId((previous) => (previous && next.some((app) => app.appId === previous) ? previous : (next[0] ? next[0].appId : "")));
  }, []);

  const loadKeys = useCallback(async (pluginId: string) => {
    if (!pluginId) { setKeys([]); return; }
    setKeysBusy(true);
    const res = await cmd({ type: "canvas/plugins/data", pluginId, action: "list" });
    if (!alive.current) return;
    setKeysBusy(false);
    if (res && res.ok && Array.isArray(res.keys)) { setKeys(res.keys); setDataError(null); return; }
    setKeys([]);
    setDataError(hostCommandError(res, "读取插件数据键失败"));
  }, [cmd]);

  useEffect(() => { void loadApps(); }, [loadApps]);
  useEffect(() => {
    setDataKey(""); setDataText(""); setDataError(null); setDataFlash(null);
    setNetUrl(""); setNetHeaders(""); setNetBody(""); setNetError(null); setNetResult(null);
    if (selectedId) void loadKeys(selectedId);
  }, [loadKeys, selectedId]);

  const readData = useCallback(async () => {
    if (!selected || !dataKey.trim()) return;
    setDataBusy("get");
    setDataError(null);
    setDataFlash(null);
    const res = await cmd({ type: "canvas/plugins/data", pluginId: selected.appId, action: "get", key: dataKey.trim() });
    if (!alive.current) return;
    setDataBusy(null);
    if (!res || !res.ok) { setDataError(hostCommandError(res, "读取插件数据失败")); return; }
    setDataText(res.exists ? formatJsonText(res.value) : "");
    setDataFlash(res.exists ? "已读取 " + dataKey.trim() : "键 " + dataKey.trim() + " 不存在（后端返回 exists:false）");
  }, [cmd, dataKey, selected]);

  const saveData = useCallback(async () => {
    if (!selected || !dataKey.trim()) return;
    const parsed = parseJsonText(dataText);
    if (!parsed.ok) { setDataError(parsed.error); return; }
    setDataBusy("set");
    setDataError(null);
    setDataFlash(null);
    const res = await cmd({ type: "canvas/plugins/data", pluginId: selected.appId, action: "set", key: dataKey.trim(), value: parsed.value });
    if (!alive.current) return;
    setDataBusy(null);
    if (!res || !res.ok) { setDataError(hostCommandError(res, "保存插件数据失败")); return; }
    setDataFlash("已保存 " + dataKey.trim() + "（" + (Number(res.bytes) || 0) + " 字节；容量上限取插件 Manifest 的 host.storage）");
    await loadKeys(selected.appId);
  }, [cmd, dataKey, dataText, loadKeys, selected]);

  const deleteData = useCallback(async () => {
    if (!selected || !dataKey.trim()) return;
    setDataBusy("delete");
    setDataError(null);
    setDataFlash(null);
    const res = await cmd({ type: "canvas/plugins/data", pluginId: selected.appId, action: "delete", key: dataKey.trim() });
    if (!alive.current) return;
    setDataBusy(null);
    if (!res || !res.ok) { setDataError(hostCommandError(res, "删除插件数据失败")); return; }
    setDataFlash("已删除 " + dataKey.trim());
    setDataText("");
    await loadKeys(selected.appId);
  }, [cmd, dataKey, loadKeys, selected]);

  const sendNetwork = useCallback(async () => {
    if (!selected || !netUrl.trim() || netBusy) return;
    let headers: Record<string, string> | undefined;
    if (netHeaders.trim()) {
      const parsed = parseJsonText(netHeaders);
      if (!parsed.ok) { setNetError("请求头不是合法 JSON：" + parsed.error); return; }
      if (parsed.value != null && (typeof parsed.value !== "object" || Array.isArray(parsed.value))) { setNetError("请求头必须是 JSON 对象"); return; }
      headers = parsed.value == null ? undefined : parsed.value as Record<string, string>;
    }
    setNetBusy(true);
    setNetError(null);
    setNetResult(null);
    const res = await cmd({
      type: "canvas/plugins/network",
      pluginId: selected.appId,
      request: { url: netUrl.trim(), method: netMethod, headers, body: netMethod === "GET" || netMethod === "HEAD" ? undefined : netBody, responseType: "json" },
    });
    if (!alive.current) return;
    setNetBusy(false);
    if (!res || !res.ok) { setNetError(hostCommandError(res, "受控网络请求失败")); return; }
    setNetResult(formatJsonText(res.response));
  }, [cmd, netBody, netBusy, netHeaders, netMethod, netUrl, selected]);

  const netMethods = selected && selected.manifest && selected.manifest.network && Array.isArray(selected.manifest.network.methods) && selected.manifest.network.methods.length
    ? selected.manifest.network.methods.map(String)
    : ["GET", "POST", "PUT", "PATCH", "DELETE"];

  return (
    <aside
      className="canvas-share-panel canvas-dxos-panel canvas-dxos-panel--wide"
      role="complementary"
      aria-labelledby={titleId}
      data-canvas-plugins-panel
      data-canvas-plugins-count={String(apps.length)}
      data-canvas-plugins-selected={selectedId}
    >
      <header className="canvas-share-panel__head">
        <div className="canvas-share-panel__titles">
          <h2 id={titleId} className="canvas-share-panel__title">画布插件</h2>
          <p className="canvas-share-panel__subject">只显示已安装、已启用且在清单里声明 canvas 的插件</p>
        </div>
        <button type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="刷新插件列表" data-canvas-plugins-refresh disabled={loading} onClick={() => void loadApps()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button ref={closeRef} type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="关闭插件面板" data-canvas-plugins-close onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="canvas-share-panel__body">
        {error ? <p className="gov-error" role="alert" data-canvas-plugins-error>{error}</p> : null}
        {loading ? <p className="canvas-share-hint" role="status">正在读取已安装插件…</p> : null}

        {!loading && !apps.length ? (
          <div className="canvas-share-empty" data-canvas-plugins-empty>
            <p>没有可用的画布插件。</p>
            <p className="canvas-share-hint">到「开发者」装载带 canvas 清单的 App，并启用后才会出现在这里；未安装 / 未启用 / 未声明 canvas 的 App 不会显示。</p>
          </div>
        ) : null}

        {apps.length ? (
          <>
            <section className="canvas-share-section">
              <h3 className="canvas-share-section__title">插件 <span className="ds-badge ds-badge--sm ds-badge--neutral">{apps.length}</span></h3>
              <ul className="canvas-dxos-source-list" data-canvas-plugins-list>
                {apps.map((app) => (
                  <li key={app.appId}>
                    <button type="button" className={"canvas-dxos-plugin" + (app.appId === selectedId ? " is-current" : "")} data-canvas-plugin={app.appId} onClick={() => setSelectedId(app.appId)}>
                      <Plug size={14} aria-hidden="true" />
                      <span className="canvas-dxos-source__name">{String(app.manifest && app.manifest.name || app.appId)}</span>
                      <span className="canvas-dxos-source__meta">{app.appId + " · v" + app.version}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {selected ? (
              <>
                <section className="canvas-share-section">
                  <h3 className="canvas-share-section__title">清单声明</h3>
                  <div className="canvas-dxos-rule">
                    <span>canvas 节点清单 {selected.manifest && selected.manifest.canvas && Array.isArray(selected.manifest.canvas.nodeManifests) ? selected.manifest.canvas.nodeManifests.length : 0} 个</span>
                    <span>·</span>
                    <span>受控网络 {selected.manifest && selected.manifest.network && Array.isArray(selected.manifest.network.domains) && selected.manifest.network.domains.length ? selected.manifest.network.domains.join("、") : "未声明（网络请求会被后端拒绝）"}</span>
                  </div>
                </section>

                <section className="canvas-share-section">
                  <h3 className="canvas-share-section__title"><Database size={13} aria-hidden="true" /> 插件数据</h3>
                  <p className="canvas-share-hint">数据落本机；容量上限取插件 Manifest 的 host.storage，未声明时后端拒绝（不兜底）。</p>
                  <div className="canvas-dxos-actions">
                    <button type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="刷新数据键" data-canvas-plugins-keys-refresh disabled={keysBusy} onClick={() => void loadKeys(selected.appId)}>
                      <RefreshCw size={14} aria-hidden="true" />
                    </button>
                    {keys.length ? <span className="canvas-share-hint" data-canvas-plugins-keys>{keys.join(" · ")}</span> : <span className="canvas-share-hint" data-canvas-plugins-keys-empty>{keysBusy ? "读取中…" : "还没有数据键"}</span>}
                  </div>
                  <input
                    className="canvas-dxos-input"
                    aria-label="插件数据键"
                    placeholder="数据键，例如 settings"
                    value={dataKey}
                    data-canvas-plugins-key
                    onChange={(event) => setDataKey(event.target.value)}
                  />
                  <textarea
                    className="canvas-dxos-textarea"
                    aria-label="插件数据 JSON"
                    rows={4}
                    placeholder='JSON 值，例如 {"theme":"dark"}；留空保存为 null'
                    value={dataText}
                    data-canvas-plugins-value
                    onChange={(event) => setDataText(event.target.value)}
                  />
                  <div className="canvas-dxos-actions">
                    <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-plugins-get disabled={!dataKey.trim() || !!dataBusy} onClick={() => void readData()}>
                      {dataBusy === "get" ? <LoaderCircle size={14} className="canvas-dxos-spin" aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
                      <span className="ds-btn__label">读取</span>
                    </button>
                    <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-plugins-set disabled={!dataKey.trim() || !!dataBusy} onClick={() => void saveData()}>
                      {dataBusy === "set" ? <LoaderCircle size={14} className="canvas-dxos-spin" aria-hidden="true" /> : <Database size={14} aria-hidden="true" />}
                      <span className="ds-btn__label">保存</span>
                    </button>
                    <button type="button" className="ds-btn ds-btn--danger ds-btn--sm" data-canvas-plugins-delete disabled={!dataKey.trim() || !!dataBusy} onClick={() => void deleteData()}>
                      {dataBusy === "delete" ? <LoaderCircle size={14} className="canvas-dxos-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                      <span className="ds-btn__label">删除</span>
                    </button>
                  </div>
                  {dataError ? <p className="gov-error" role="alert" data-canvas-plugins-data-error>{dataError}</p> : null}
                  {dataFlash ? <p className="canvas-share-flash" role="status" data-canvas-plugins-data-flash>{dataFlash}</p> : null}
                </section>

                <section className="canvas-share-section">
                  <h3 className="canvas-share-section__title"><Globe size={13} aria-hidden="true" /> 受控网络</h3>
                  <p className="canvas-share-hint">请求由后端按插件 Manifest 的域名 / 方法白名单、DNS 公网校验与限流执行；未在白名单里的地址会被结构化拒绝。</p>
                  <div className="canvas-dxos-actions">
                    <select className="canvas-share-select" aria-label="请求方法" data-canvas-plugins-method value={netMethod} onChange={(event) => setNetMethod(event.target.value)}>
                      {netMethods.map((method) => <option key={method} value={method}>{method}</option>)}
                    </select>
                    <input className="canvas-dxos-input" aria-label="请求地址" placeholder="https://（必须在插件白名单内）" value={netUrl} data-canvas-plugins-url onChange={(event) => setNetUrl(event.target.value)} />
                  </div>
                  <textarea
                    className="canvas-dxos-textarea"
                    aria-label="请求头 JSON"
                    rows={2}
                    placeholder='请求头 JSON（可留空），例如 {"accept":"application/json"}'
                    value={netHeaders}
                    data-canvas-plugins-headers
                    onChange={(event) => setNetHeaders(event.target.value)}
                  />
                  {netMethod !== "GET" && netMethod !== "HEAD" ? (
                    <textarea
                      className="canvas-dxos-textarea"
                      aria-label="请求体"
                      rows={2}
                      placeholder="请求体（可留空）"
                      value={netBody}
                      data-canvas-plugins-body
                      onChange={(event) => setNetBody(event.target.value)}
                    />
                  ) : null}
                  <div className="canvas-dxos-actions">
                    <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-plugins-send disabled={!netUrl.trim() || netBusy} onClick={() => void sendNetwork()}>
                      {netBusy ? <LoaderCircle size={14} className="canvas-dxos-spin" aria-hidden="true" /> : <Globe size={14} aria-hidden="true" />}
                      <span className="ds-btn__label">{netBusy ? "请求中…" : "发送受控请求"}</span>
                    </button>
                  </div>
                  {netError ? <p className="gov-error" role="alert" data-canvas-plugins-net-error>{netError}</p> : null}
                  {netResult ? <pre className="canvas-dxos-pre" data-canvas-plugins-net-result>{netResult}</pre> : null}
                </section>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
