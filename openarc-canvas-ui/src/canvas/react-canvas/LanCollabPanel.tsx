import { useEffect, useState } from "react";
import type { Collab } from "./reactCanvasCollab";
import { createLanCollab } from "./reactCanvasLan";

type HostStatus = {
  enabled: boolean; port: number | null; lanUrl: string | null; address: string | null; path: string;
  devices: Array<{ clientId: string; username: string; ip: string; canEdit: boolean; connectedAt: number }>;
  pairing: { active: boolean; expiresAt: number | null; canEdit?: boolean };
};
type Bridge = { openarc?: { desktop?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } };
export type LanJoinInfo = { wsUrl: string; token: string; canEdit: boolean; canvasId: string };
type Props = { canvasId: string; onJoin: (info: LanJoinInfo, collab: Collab) => void; getHandlers: () => Parameters<typeof createLanCollab>[0]["handlers"] };

export function LanCollabPanel({ canvasId, onJoin, getHandlers }: Props) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [joinHost, setJoinHost] = useState("");
  const [joinCode, setJoinCode] = useState("");

  const command = async (type: string, payload: Record<string, unknown> = {}) => {
    const bridge = (window as unknown as Bridge).openarc?.desktop;
    if (!bridge || typeof bridge.command !== "function") throw new Error("未连接桌面后端");
    const result = await bridge.command({ type, payload });
    if (!result || result.ok !== true) throw new Error(String((result && result.error) || "LAN_ERROR"));
    return result.value as Record<string, unknown>;
  };
  const loadStatus = async () => {
    try {
      const value = await command("desktop/lan/status");
      setStatus(value as unknown as HostStatus);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "LAN_STATUS_FAILED"); }
  };
  useEffect(() => { void loadStatus(); }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!status || !status.enabled) return;
    const timer = window.setInterval(() => {
      void command("desktop/lan/devices").then((value) => setStatus((prev) => prev ? { ...prev, devices: Array.isArray(value.devices) ? value.devices as HostStatus["devices"] : prev.devices } : prev)).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status?.enabled]);

  const startStop = async () => {
    setBusy(true); setError("");
    try {
      if (status?.enabled) await command("desktop/lan/stop");
      else await command("desktop/lan/start");
      await loadStatus();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "LAN_START_FAILED"); }
    finally { setBusy(false); }
  };
  const createCode = async () => {
    setBusy(true); setError("");
    try {
      const value = await command("desktop/lan/pairing/create", { canvasId, canEdit });
      setCode(String(value.code || "")); setExpiresAt(Number(value.expiresAt) || null); setNow(Date.now());
      await loadStatus();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "PAIRING_CREATE_FAILED"); }
    finally { setBusy(false); }
  };
  const revoke = async (device: { clientId: string; ip: string }) => {
    try { await command("desktop/lan/revoke", { clientId: device.clientId, ip: device.ip }); await loadStatus(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "REVOKE_FAILED"); }
  };
  const join = async () => {
    setBusy(true); setError("");
    try {
      const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("加入协作超时，请检查主机地址/网络")), 5000));
      const value = await Promise.race([command("desktop/lan/join", { hostUrl: joinHost.trim(), code: joinCode.trim() }), timeout]);
      const info: LanJoinInfo = { wsUrl: String(value.wsUrl || ""), token: String(value.token || ""), canEdit: value.canEdit === true, canvasId: String(value.canvasId || "") };
      if (!info.wsUrl || !info.token) throw new Error("配对响应缺少 wsUrl/token");
      const collab = createLanCollab({ canvasId: info.canvasId || canvasId, wsUrl: info.wsUrl, token: info.token, canEdit: info.canEdit, handlers: getHandlers() });
      onJoin(info, collab);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "LAN_JOIN_FAILED"); }
    finally { setBusy(false); }
  };

  const seconds = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  return (
    <div className="rc-lan-panel" data-testid="lan-panel">
      <div className="rc-lan-title">跨设备协作</div>
      <div className="rc-lan-row">
        <button data-testid="lan-host-toggle" disabled={busy} onClick={() => void startStop()}>{status?.enabled ? "关闭局域网协作" : "开启局域网协作"}</button>
        <label><input type="checkbox" data-testid="lan-canedit" checked={canEdit} onChange={(event) => setCanEdit(event.target.checked)} />可编辑</label>
        <button data-testid="lan-refresh" onClick={() => void loadStatus()}>刷新</button>
      </div>
      {status?.enabled ? (
        <>
          <div className="rc-lan-address" data-testid="lan-address">{status.lanUrl || ("端口 " + status.port)}</div>
          <div className="rc-lan-row">
            <button data-testid="lan-create-code" disabled={busy} onClick={() => void createCode()}>生成配对码</button>
            {code ? <span className="rc-lan-code" data-testid="lan-code">{code}</span> : null}
            {expiresAt ? <small>{seconds > 0 ? seconds + "s 后过期 · 一次性" : "已过期"}</small> : null}
          </div>
          <div className="rc-lan-devices" data-testid="lan-devices">
            {(status.devices || []).length === 0 ? <span className="rc-lan-empty">暂无设备</span> : null}
            {(status.devices || []).map((device) => (
              <div className="rc-lan-device" data-testid="lan-device" key={device.clientId}>
                <span>{device.username || device.clientId.slice(-6)}</span><span>{device.ip}</span><span>{device.canEdit ? "可编辑" : "只读"}</span>
                <button data-testid="lan-revoke" onClick={() => void revoke(device)}>撤销</button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="rc-lan-title">加入协作</div>
      <div className="rc-lan-row">
        <input placeholder="主机地址 http://192.168.x.x:port" data-testid="lan-join-host" value={joinHost} onChange={(event) => setJoinHost(event.target.value)} />
        <input placeholder="配对码" data-testid="lan-join-code" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} />
        <button data-testid="lan-join" disabled={busy} onClick={() => void join()}>加入</button>
      </div>
      {error ? <div className="rc-lan-error" data-testid="lan-error">{error}</div> : null}
    </div>
  );
}
