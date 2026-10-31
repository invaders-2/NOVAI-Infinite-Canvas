/**
 * 画布宿主浮层 · 协作房间 + .dxcanvas 打包（React 岛，画布应用窗口内）。
 *
 * 为什么由宿主实现、而不是改上游画布页：
 *   · 上游页运行在 sandbox iframe 里，拿不到 window.openarc / IPC / 文件选择；
 *   · 这两块能力都是**宿主能力**（画布命令 + 下载 + 文件读取），与既有共享面板同一形态：
 *     入口在画布窗口右上角，面板是宿主浮层，上游页面 DOM 一个字节都不改。
 *
 * 命令真源：electron/canvas-dxos-commands.cjs（既有 canvas:command 扩展，没有新通道）
 *   · 协作：canvas/collab/join | leave | presence | heartbeat | cursor | patch | events | rooms | sweep
 *   · 打包：canvas/package/export（内联 base64，>32MB 拒绝）| canvas/package/import（新建画布）
 * 没有后端命名的能力一律如实标注不可用（例如「局域网 / 云端房间发现」与「素材库同步」）。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { Download, LogIn, LogOut, Upload, X } from "lucide-react";
import {
  MAX_PACKAGE_BYTES,
  base64ToBytes,
  bytesToBase64,
  collabEventView,
  formatBytes,
  hostCommandError,
  packageFileName,
  type CollabEventView,
  type Cmd,
} from "./canvasDxosModel";
import "./canvasDxosPanels.css";

type PresenceUser = { clientId: string; userId?: string; username?: string; canEdit?: boolean };
type RoomView = { canvasId: string; clientIds: string[] };

/** 右上角动作行里的入口按钮（与 CanvasShareEntry 同一排、同一视觉层级）。 */
export function CanvasHostPanelEntry({
  kind,
  label,
  icon,
  expanded = false,
  onOpen,
  buttonRef,
}: {
  kind: "collab" | "package" | "assets" | "invite" | "plugins";
  label: string;
  icon: ReactNode;
  expanded?: boolean;
  onOpen: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ds-btn ds-btn--sm ds-btn--ghost canvas-dxos-entry"
      data-canvas-dxos-entry={kind}
      data-canvas-dxos-entry-label={label}
      aria-expanded={expanded}
      onClick={onOpen}
    >
      {icon}
      <span className="canvas-dxos-entry__label">{label}</span>
    </button>
  );
}

const avatarOf = (user: PresenceUser) => {
  const label = String(user.username || user.userId || user.clientId || "?").trim();
  return (label.slice(0, 1) || "?").toUpperCase();
};

/**
 * 协作房间面板：真实消费 canvas/collab/*。
 * 加入即创建房间（后端只有 join，没有 create）；在线成员来自 presence 轮询，
 * 最近事件来自 canvas/collab/events 的真实下行队列（光标 / 补丁），不伪造活动。
 */
export function CanvasCollabPanel({
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
  const clientIdRef = useRef("c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4));
  const alive = useRef(true);
  const joinedRef = useRef(false);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [events, setEvents] = useState<CollabEventView[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const clientId = clientIdRef.current;

  /** 状态提示是"刚才发生了什么"的短反馈，3.2s 自动收起；在线人数等持续事实只在成员区展示。 */
  const say = useCallback((message: string) => {
    setFlash(message);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => { if (alive.current) setFlash(null); }, 3200);
  }, []);

  const readRooms = useCallback(async () => {
    const res = await cmd({ type: "canvas/collab/rooms" });
    if (!alive.current) return;
    if (res && res.ok && Array.isArray(res.rooms)) {
      setRooms(res.rooms.map((room: any) => ({ canvasId: String(room && room.canvasId || ""), clientIds: Array.isArray(room && room.clientIds) ? room.clientIds.map(String) : [] })));
    } else if (res && !res.ok && !joinedRef.current) {
      setError(hostCommandError(res, "读取协作房间失败"));
    }
  }, [cmd]);

  const refreshPresence = useCallback(async () => {
    const res = await cmd({ type: "canvas/collab/presence", canvasId });
    if (!alive.current || !joinedRef.current) return;
    if (res && res.ok && res.presence && Array.isArray(res.presence.users)) setPresence(res.presence.users);
    else if (res && !res.ok) setError(hostCommandError(res, "读取在线成员失败"));
  }, [canvasId, cmd]);

  const drainEvents = useCallback(async () => {
    const res = await cmd({ type: "canvas/collab/events", canvasId, clientId });
    if (!alive.current || !joinedRef.current) return;
    if (!res || !res.ok || !Array.isArray(res.events) || !res.events.length) return;
    const next = res.events.map((event: any, index: number) => collabEventView(event, index));
    setEvents((previous) => [...next, ...previous].slice(0, 8));
  }, [canvasId, clientId, cmd]);

  // 一个轮询：未加入只读房间列表；已加入 = heartbeat → presence → events（2.5s，与宿主既有轮询量级一致）。
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const tick = async () => {
      if (disposed || !alive.current) return;
      if (!joinedRef.current) {
        await readRooms();
        return;
      }
      await cmd({ type: "canvas/collab/heartbeat", canvasId, clientId });
      await refreshPresence();
      await drainEvents();
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2500);
    return () => {
      disposed = true;
      alive.current = false;
      window.clearInterval(timer);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (joinedRef.current) {
        joinedRef.current = false;
        void cmd({ type: "canvas/collab/leave", canvasId, clientId });
      }
    };
  }, [canvasId, clientId, cmd, drainEvents, readRooms, refreshPresence]);

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

  const join = useCallback(async () => {
    if (busy) return;
    setBusy("join");
    setError(null);
    setFatal(null);
    setFlash(null);
    const res = await cmd({ type: "canvas/collab/join", canvasId, clientId });
    if (!alive.current) return;
    setBusy(null);
    if (!res || !res.ok) {
      const message = hostCommandError(res, "加入协作房间失败");
      if (res && (res.error === "NOT_FOUND" || res.error === "NOT_FOUND_OR_FORBIDDEN" || res.error === "FORBIDDEN")) setFatal(message);
      else setError(message);
      return;
    }
    joinedRef.current = true;
    setJoined(true);
    setPresence(res.presence && Array.isArray(res.presence.users) ? res.presence.users : []);
    say("已加入协作房间");
    await readRooms();
  }, [busy, canvasId, clientId, cmd, readRooms, say]);

  const leave = useCallback(async () => {
    if (busy) return;
    setBusy("leave");
    setError(null);
    setFlash(null);
    const res = await cmd({ type: "canvas/collab/leave", canvasId, clientId });
    if (!alive.current) return;
    setBusy(null);
    joinedRef.current = false;
    setJoined(false);
    setPresence([]);
    setEvents([]);
    if (res && !res.ok) setError(hostCommandError(res, "离开协作房间失败"));
    else say("已离开协作房间（房间没人后由后端删除）");
    await readRooms();
  }, [busy, canvasId, clientId, cmd, readRooms, say]);

  return (
    <aside
      className="canvas-share-panel canvas-dxos-panel"
      role="complementary"
      aria-labelledby={titleId}
      data-canvas-collab-panel
      data-canvas-collab-client={clientId}
      data-canvas-collab-joined={joined ? "1" : "0"}
      data-canvas-collab-presence={presence.length}
      data-canvas-collab-rooms={rooms.length}
    >
      <header className="canvas-share-panel__head">
        <div className="canvas-share-panel__titles">
          <h2 id={titleId} className="canvas-share-panel__title">协作</h2>
          {title ? <p className="canvas-share-panel__subject" title={title}>{title}</p> : null}
        </div>
        <button ref={closeRef} type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="关闭协作面板" data-canvas-collab-close onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="canvas-share-panel__body">
        {flash ? <p className="canvas-share-flash" role="status" data-canvas-collab-flash>{flash}</p> : null}
        {error ? <p className="gov-error" role="alert" data-canvas-collab-error>{error}</p> : null}
        {fatal ? (
          <div className="canvas-share-fatal" role="alert" data-canvas-collab-fatal>
            <p className="gov-error">{fatal}</p>
            <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onClose}>关闭</button>
          </div>
        ) : (
          <>
            <section className="canvas-share-section">
              <h3 className="canvas-share-section__title">房间</h3>
              <p className="canvas-share-hint">
                加入即创建房间（后端只有 canvas/collab/join，没有单独的「创建房间」命令）。同一账号可以在多台设备各用一个客户端加入同一本画布。
              </p>
              <p className="canvas-dxos-client">本机客户端 <code className="canvas-dxos-code" data-canvas-collab-client-id>{clientId}</code> · {joined ? "已加入" : "未加入"}</p>
              <div className="canvas-dxos-actions">
                {joined ? (
                  <button type="button" className="ds-btn ds-btn--danger ds-btn--sm" data-canvas-collab-leave disabled={busy === "leave"} onClick={() => void leave()}>
                    <LogOut size={14} aria-hidden="true" /><span className="ds-btn__label">{busy === "leave" ? "离开中…" : "离开房间"}</span>
                  </button>
                ) : (
                  <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-collab-join disabled={busy === "join"} onClick={() => void join()}>
                    <LogIn size={14} aria-hidden="true" /><span className="ds-btn__label">{busy === "join" ? "加入中…" : "加入协作房间"}</span>
                  </button>
                )}
              </div>
              {rooms.length ? (
                <ul className="canvas-dxos-rooms" data-canvas-collab-rooms-list>
                  {rooms.map((room) => (
                    <li key={room.canvasId} className={"canvas-dxos-room" + (room.canvasId === canvasId ? " is-current" : "")}>
                      <span className="canvas-dxos-event__text">{room.canvasId === canvasId ? "本画布" : room.canvasId}</span>
                      <span>{room.clientIds.length} 个客户端</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="canvas-share-empty" data-canvas-collab-rooms-empty>进程内还没有协作房间。</p>
              )}
            </section>

            <section className="canvas-share-section">
              <h3 className="canvas-share-section__title">
                在线成员 <span className="ds-badge ds-badge--sm ds-badge--neutral" data-canvas-collab-member-count={String(presence.length)}>{presence.length}</span>
              </h3>
              {presence.length ? (
                <ul className="canvas-share-members" data-canvas-collab-members>
                  {presence.map((user) => (
                    <li key={user.clientId} className="gov-row canvas-share-member" data-canvas-collab-member={user.clientId} data-canvas-collab-member-editable={user.canEdit ? "1" : "0"}>
                      <span className="canvas-share-avatar" aria-hidden="true">{avatarOf(user)}</span>
                      <span className="canvas-share-ident">
                        <span className="gov-name">{String(user.username || user.userId || user.clientId)}</span>
                        <span className="gov-meta">{user.clientId === clientId ? "本机客户端" : "客户端 " + String(user.clientId).slice(0, 16)}</span>
                      </span>
                      <span className="ds-badge ds-badge--sm ds-badge--neutral">{user.canEdit ? "可编辑" : "只读"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="canvas-share-empty" data-canvas-collab-empty>
                  {joined ? "房间里只有本机：其他设备的客户端加入后会出现在这里。" : "还没加入房间：加入后才能看到在线成员。"}
                </p>
              )}
            </section>

            <section className="canvas-share-section">
              <h3 className="canvas-share-section__title">
                协作事件 <span className="ds-badge ds-badge--sm ds-badge--neutral" data-canvas-collab-event-count={String(events.length)}>{events.length}</span>
              </h3>
              <p className="canvas-share-hint">只展示后端 canvas/collab/events 真实下行的光标 / 补丁事件；在线状态由 presence 轮询，不在这儿重复。</p>
              {events.length ? (
                <ul className="canvas-dxos-events" data-canvas-collab-events>
                  {events.map((event) => <li key={event.key} className="canvas-dxos-event"><span className="canvas-dxos-event__text">{event.text}</span></li>)}
                </ul>
              ) : (
                <p className="canvas-share-empty" data-canvas-collab-events-empty>还没有收到协作事件。</p>
              )}
            </section>
          </>
        )}
        <p className="canvas-share-hint" data-canvas-collab-transport="local-only">
          局域网 / 云端房间发现未接入：本版只有同一 OpenArc 进程内的房间，没有跨设备网络传输层。
        </p>
      </div>
    </aside>
  );
}

/**
 * .dxcanvas 打包面板：真实消费 canvas/package/export | import。
 * 导出走 Chromium 下载（宿主没有通用 fs 桥，也不新造写盘通道）；导入走文件选择 + 后端解析新建画布。
 */
export function CanvasPackagePanel({
  canvasId,
  title,
  cmd,
  onClose,
  onImported,
}: {
  canvasId: string;
  title?: string;
  cmd: Cmd;
  onClose: () => void;
  onImported?: (canvasId: string) => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [exporting, setExporting] = useState(false);
  const [exportInfo, setExportInfo] = useState<{ bytes: number; sha256: string; format: string; fileName: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importInfo, setImportInfo] = useState<{ canvasId: string; fileName: string; importedAssets: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

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

  const doExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportInfo(null);
    setFlash(null);
    const res = await cmd({ type: "canvas/package/export", canvasId });
    if (!alive.current) return;
    if (!res || !res.ok) {
      setExporting(false);
      setExportError(hostCommandError(res, "导出 .dxcanvas 失败"));
      return;
    }
    const base64 = typeof res.base64 === "string" ? res.base64 : "";
    if (!base64) {
      setExporting(false);
      setExportError("后端返回成功但包内容为空（base64 缺失）：没有生成文件");
      return;
    }
    const fileName = packageFileName(title, canvasId);
    try {
      const bytes = base64ToBytes(base64);
      if (!bytes.length) throw new Error("empty-package");
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 15000);
      const byteLength = Number(res.byteLength);
      setExportInfo({ bytes: Number.isFinite(byteLength) && byteLength > 0 ? byteLength : bytes.length, sha256: String(res.sha256 || ""), format: String(res.format || ""), fileName });
      setFlash("已导出 " + fileName + "，由 Chromium 下载到系统下载目录");
    } catch {
      setExportError("导出数据无法解码为文件（包内容损坏或渲染层内存不足），没有生成下载");
    } finally {
      if (alive.current) setExporting(false);
    }
  }, [canvasId, cmd, exporting, title]);

  const onPickFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    setImportInfo(null);
    setFlash(null);
    if (file.size > MAX_PACKAGE_BYTES) {
      setImportError("文件 " + formatBytes(file.size) + " 超过后端 .dxcanvas 内联上限 32 MB：会被拒绝，未读取文件内容");
      return;
    }
    setImporting(true);
    let base64 = "";
    try {
      base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    } catch {
      if (alive.current) setImporting(false);
      setImportError("读取文件失败（渲染层读不到这个文件）");
      return;
    }
    const res = await cmd({ type: "canvas/package/import", base64, title: file.name.replace(/\.dxcanvas$/i, "") });
    if (!alive.current) return;
    setImporting(false);
    if (!res || !res.ok) {
      setImportError(hostCommandError(res, "导入 .dxcanvas 失败"));
      return;
    }
    const newCanvasId = String(res.canvasId || "");
    setImportInfo({ canvasId: newCanvasId, fileName: file.name, importedAssets: Number(res.importedAssets) || 0 });
    setFlash("已导入 " + file.name + " 并新建画布：" + newCanvasId);
    onImported?.(newCanvasId);
  }, [cmd, onImported]);

  return (
    <aside
      className="canvas-share-panel canvas-dxos-panel"
      role="complementary"
      aria-labelledby={titleId}
      data-canvas-package-panel
      data-canvas-package-canvas={canvasId}
      data-canvas-package-export-bytes={exportInfo ? String(exportInfo.bytes) : ""}
      data-canvas-package-export-sha256={exportInfo ? exportInfo.sha256 : ""}
      data-canvas-package-import-canvas={importInfo ? importInfo.canvasId : ""}
    >
      <header className="canvas-share-panel__head">
        <div className="canvas-share-panel__titles">
          <h2 id={titleId} className="canvas-share-panel__title">打包</h2>
          {title ? <p className="canvas-share-panel__subject" title={title}>{title}</p> : null}
        </div>
        <button ref={closeRef} type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="关闭打包面板" data-canvas-package-close onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="canvas-share-panel__body">
        {flash ? <p className="canvas-share-flash" role="status" data-canvas-package-flash>{flash}</p> : null}

        <section className="canvas-share-section">
          <h3 className="canvas-share-section__title">导出 .dxcanvas</h3>
          <p className="canvas-share-hint">
            把当前画布与素材打包成 .dxcanvas（后端 canvas/package/export，内联上限 32 MB；超过会被后端拒绝，不截断）。导出后由 Chromium 下载保存，下载目录跟随系统设置。
          </p>
          <div className="canvas-dxos-actions">
            <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-package-export disabled={exporting} onClick={() => void doExport()}>
              <Download size={14} aria-hidden="true" /><span className="ds-btn__label">{exporting ? "打包中…" : "导出 .dxcanvas"}</span>
            </button>
            <span className="set-cap">目标：当前画布</span>
          </div>
          {exportInfo ? (
            <div className="canvas-dxos-actions" data-canvas-package-export-result style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <p className="set-cap">已打包 {exportInfo.fileName} · {formatBytes(exportInfo.bytes)} · {exportInfo.format || "格式未知"}</p>
              <p className="set-cap">sha256 <code className="canvas-dxos-code" data-canvas-package-export-sha>{exportInfo.sha256}</code></p>
            </div>
          ) : null}
          {exportError ? <p className="gov-error" role="alert" data-canvas-package-export-error>{exportError}</p> : null}
        </section>

        <section className="canvas-share-section">
          <h3 className="canvas-share-section__title">导入 .dxcanvas</h3>
          <p className="canvas-share-hint">
            选择一个 .dxcanvas：后端 canvas/package/import 会解析包、把素材导入资源库并新建一本画布。不会覆盖或修改现有画布。
          </p>
          <input ref={fileRef} type="file" accept=".dxcanvas,application/zip,application/octet-stream" className="visually-hidden" data-canvas-package-file onChange={(event) => void onPickFile(event)} />
          <div className="canvas-dxos-actions">
            <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-package-import disabled={importing} onClick={() => fileRef.current?.click()}>
              <Upload size={14} aria-hidden="true" /><span className="ds-btn__label">{importing ? "导入中…" : "选择 .dxcanvas 文件"}</span>
            </button>
            <span className="set-cap">导入会新建画布</span>
          </div>
          {importInfo ? (
            <div data-canvas-package-import-result>
              <p className="set-cap">
                已导入 {importInfo.fileName} · 新建画布 <code className="canvas-dxos-code" data-canvas-package-import-canvas-id>{importInfo.canvasId}</code> · 素材 {importInfo.importedAssets} 个
              </p>
            </div>
          ) : null}
          {importError ? <p className="gov-error" role="alert" data-canvas-package-import-error>{importError}</p> : null}
        </section>

        <section className="canvas-share-section" aria-label="未接入能力">
          <h3 className="canvas-share-section__title">未接入</h3>
          <p className="canvas-share-hint" data-canvas-package-sources="unavailable">
            素材库同步（sync-sources）：本轮前端未接入，不提供入口。接入前不会用本地列表冒充云端素材。
          </p>
        </section>
      </div>
    </aside>
  );
}
