/**
 * 画布分享（T49 + 社区 M2）：右上角分享按钮的子菜单。
 * - 分享链接：局域网链接 + 三档权限（仅查看 / 可克隆 / 可存模板）+ 有效期 + 撤销；
 * - 打开分享链接：粘贴链接后在当前画布只读预览，可克隆节点到当前画布；
 * - 发布到社区：局域网里的人能在社区看到并克隆这张画布；已发布时变成「已发布到社区 · vN」+ 管理子面板。
 * 面板走通用 openPop；发布弹窗由外壳（Vue）承担，这里只通过 postMessage 通知父窗口。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";
import { cloneWorkflowForImport } from "../personalTemplates";
import { uid } from "../model";
import { useCtl, useS, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { openPop } from "./overlay";
import { parseShareLink, permissionLabel, type ShareLinkPayload, type SharePermission } from "./shareDoc";
import { mediaStatsText, type MediaStats } from "./shareMedia";
import { ShareView } from "./ShareView";
import "./share-panel.css";

const EXPIRES: Array<{ value: number; label: string }> = [
  { value: 7, label: "7 天" },
  { value: 1, label: "1 天" },
  { value: 30, label: "30 天" },
  { value: 0, label: "永久" },
];

type CommunityItem = {
  id: string;
  version: number;
  title: string;
  status: string;
  has_changes?: boolean;
  changed_nodes?: number;
  cover?: string;
  package_updated_at?: number;
  updated_at?: number;
  stats?: { likes?: number; clones?: number; views?: number };
};

function ago(value?: number): string {
  const stamp = Number(value) || 0;
  if (!stamp) return "";
  const diff = Math.max(0, Date.now() - stamp);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + " 小时前";
  const days = Math.round(hours / 24);
  if (days < 30) return days + " 天前";
  return Math.round(days / 30) + " 个月前";
}

/** 画布 → 外壳：发布要弹窗、在社区查看要切页，画布自己是 iframe，做不了。 */
function tellHost(payload: Record<string, unknown>): boolean {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, location.origin);
      return true;
    }
  } catch {
    /* 跨域父窗：当作没有外壳 */
  }
  return false;
}

function usePublished(canvasId: string) {
  const [item, setItem] = useState<CommunityItem | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!canvasId) { setLoading(false); return; }
    setLoading(true);
    fetch("/api/community/mine?source_id=" + encodeURIComponent(canvasId), { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setItem((data && data.item) || null))
      .catch(() => setItem(null))
      .finally(() => setLoading(false));
  }, [canvasId]);
  useEffect(() => { load(); }, [load]);
  // 外壳发布成功后会广播一次，重新读一下发布状态
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin && event.origin !== location.origin) return;
      const data = event.data;
      if (data && data.type === "novai:community-updated") load();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);
  return { item, loading, reload: load };
}

export function shareMenu(ctl: Ctl, anchor: Element) {
  openPop(anchor, (close) => <ShareMenuBody ctl={ctl} close={close} />, "down", "right");
}

function ShareMenuBody({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const [view, setView] = useState<"menu" | "share" | "open" | "published">("menu");
  const canvasId = useS((s) => s.canvasId);
  const canvasName = useS((s) => s.name);
  const published = usePublished(canvasId);

  const openPublish = (itemId?: string) => {
    const sent = tellHost({
      type: "novai:community-publish",
      kind: "canvas",
      sourceId: canvasId,
      itemId: itemId || "",
      title: canvasName || "",
    });
    if (!sent) {
      ctl.store.toast("发布要在 NOVAI 主界面里操作");
      return;
    }
    close();
  };
  const openCommunity = () => {
    tellHost({ type: "novai:community-open", itemId: published.item ? published.item.id : "" });
    close();
  };

  if (view === "published") {
    return (
      <PublishedPanel
        ctl={ctl}
        item={published.item}
        loading={published.loading}
        reload={published.reload}
        back={() => setView("menu")}
        onEdit={() => openPublish(published.item ? published.item.id : "")}
        onOpenCommunity={openCommunity}
      />
    );
  }
  if (view === "open") return <OpenByLink ctl={ctl} close={close} back={() => setView("menu")} />;
  if (view === "share") return <ShareSettings ctl={ctl} close={close} back={() => setView("menu")} />;

  const item = published.item;
  return <>
    <div className="mh">分享这张画布</div>
    <button className="mi" data-share-entry="link" onClick={() => setView("share")}>
      <span className="ic"><Icon name="link" size="s" /></span>
      <span>分享链接<span className="d">同一局域网的电脑 / 手机可直接打开</span></span>
    </button>
    <button className="mi" data-share-entry="open" onClick={() => setView("open")}>
      <span className="ic"><Icon name="folder" size="s" /></span>
      <span>打开分享链接<span className="d">粘贴别人给的链接，只读预览并可克隆到当前画布</span></span>
    </button>
    <div className="nshare-gap" />
    <button className="mi" data-share-entry="community" data-community-state={item ? "published" : "draft"}
      onClick={() => { if (item) setView("published"); else openPublish(); }}>
      <span className="ic"><Icon name="users" size="s" /></span>
      <span>
        {item ? <>已发布到社区 <span className="nshare-ver mono">V{item.version}</span></> : "发布到社区"}
        <span className="d">
          {published.loading ? "读取发布状态…"
            : item ? (item.has_changes ? "画布有新改动，可以更新到社区" : "「" + (item.title || canvasName) + "」正在社区里")
              : "局域网里的人能在社区看到，并克隆这张画布"}
        </span>
      </span>
      {item && item.has_changes
        ? <span className="nshare-upd" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); setView("published"); }}>更新</span>
        : <Icon name="right" size="s" className="nshare-go" />}
    </button>
  </>;
}

function PublishedPanel({ ctl, item, loading, reload, back, onEdit, onOpenCommunity }: {
  ctl: Ctl;
  item: CommunityItem | null;
  loading: boolean;
  reload: () => void;
  back: () => void;
  onEdit: () => void;
  onOpenCommunity: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!item) {
    return <div className="nshare" data-share-published>
      <div className="mh" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button className="ib" style={{ width: 22, height: 22 }} aria-label="返回" onClick={back}><Icon name="back" size="s" /></button>
        社区
      </div>
      <div className="nshare-hint">{loading ? "读取中…" : "这张画布还没有发布到社区"}</div>
    </div>;
  }
  const stats = item.stats || {};
  const unlisted = item.status === "unlisted";
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data?.detail || "操作失败"));
    return data;
  };
  const update = async () => {
    if (busy) return;
    setBusy("update"); setError("");
    try {
      const response = await fetch("/api/community/mine/" + encodeURIComponent(item.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ republish: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || "更新失败"));
      ctl.store.toast("已更新到社区 v" + ((data.item && data.item.version) || item.version + 1));
      reload();
    } catch (err) {
      setError((err as Error).message || "更新失败");
    } finally { setBusy(""); }
  };
  const toggleUnlist = async () => {
    if (busy) return;
    setBusy("unlist"); setError("");
    try {
      await call("/api/community/mine/" + encodeURIComponent(item.id) + (unlisted ? "/relist" : "/unlist"));
      ctl.store.toast(unlisted ? "已重新上架到社区" : "已从社区下架");
      reload();
    } catch (err) {
      setError((err as Error).message || "操作失败");
    } finally { setBusy(""); }
  };
  const cover = item.cover ? "/api/community/cover/" + encodeURIComponent(item.id) + "?v=" + (item.package_updated_at || 0) : "";
  return <div className="nshare nshare-pub" data-share-published>
    <div className="mh" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button className="ib" style={{ width: 22, height: 22 }} aria-label="返回" onClick={back}><Icon name="back" size="s" /></button>
      已发布到社区
    </div>
    <div className="nshare-pubcard">
      {cover ? <img src={cover} alt="" /> : <span className="ph"><Icon name="canvas" size="s" /></span>}
      <div>
        <b>{item.title}</b>
        <small>画布 · <span className="mono">v{item.version}</span> · {ago(item.package_updated_at || item.updated_at)}{unlisted ? " · 已下架" : ""}</small>
      </div>
    </div>
    <div className="nshare-pubstats">
      <span><Icon name="heart" size="xs" /><span className="mono">{stats.likes || 0}</span></span>
      <span><Icon name="copy" size="xs" /><span className="mono">{stats.clones || 0}</span> 次克隆</span>
      <span><Icon name="eye" size="xs" /><span className="mono">{stats.views || 0}</span></span>
    </div>
    {item.has_changes && !unlisted ? <div className="nshare-pubwarn">
      发布后画布又改了 {Math.max(1, Number(item.changed_nodes) || 1)} 个节点。更新后社区里显示 <span className="mono">v{item.version + 1}</span>，已经克隆走的副本不受影响。
    </div> : null}
    <button className="mi" data-share-pub-edit onClick={onEdit}>
      <span className="ic"><Icon name="edit" size="s" /></span>
      <span>编辑标题、封面和简介</span>
    </button>
    <button className="mi" data-share-pub-open onClick={onOpenCommunity}>
      <span className="ic"><Icon name="users" size="s" /></span>
      <span>在社区查看</span>
    </button>
    <button className="mi" data-share-pub-unlist onClick={() => void toggleUnlist()} disabled={!!busy}>
      <span className="ic"><Icon name={unlisted ? "up" : "eyeoff"} size="s" /></span>
      <span>{unlisted ? "重新上架到社区" : "从社区下架"}</span>
    </button>
    {error ? <div className="nshare-err" role="alert">{error}</div> : null}
    {!unlisted ? <div className="nshare-foot">
      <button className="nshare-btn pri" data-share-pub-update disabled={!!busy || !item.has_changes} onClick={() => void update()}>
        <Icon name="upload" size="xs" />{busy === "update" ? "更新中…" : "更新到社区"}
      </button>
    </div> : <div className="nshare-foot">
      <button className="nshare-btn" disabled={!!busy} onClick={() => void toggleUnlist()}>{busy === "unlist" ? "处理中…" : "重新上架"}</button>
    </div>}
  </div>;
}

function ShareSettings({ ctl, close, back }: { ctl: Ctl; close: () => void; back: () => void }) {
  const canvasId = useS((s) => s.canvasId);
  const canvasName = useS((s) => s.name);
  const [share, setShare] = useState<ShareLinkPayload | null>(null);
  const [permission, setPermission] = useState<SharePermission>("view");
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/canvas-share/by-canvas/" + encodeURIComponent(canvasId), { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!alive) return;
        const current = (data?.share || null) as ShareLinkPayload | null;
        setShare(current);
        if (current) {
          setPermission(current.permission);
          if (current.expires_at) {
            const left = Math.max(1, Math.round((current.expires_at - Date.now()) / 86400000));
            setDays([1, 7, 30].includes(left) ? left : 7);
          } else setDays(0);
        }
        setLoading(false);
      })
      .catch(() => { if (alive) { setLoading(false); setError("读取分享设置失败，稍后重试"); } });
    return () => { alive = false; };
  }, [canvasId]);

  const createOrUpdate = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/canvas-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canvas_id: canvasId, permission, expires_in_days: days, owner_name: ctl.host.user?.name || "本机用户" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(String(data?.detail || "生成分享链接失败")); return; }
      setShare(data.share as ShareLinkPayload);
      ctl.store.toast("分享链接已就绪");
    } catch {
      setError("生成分享链接失败，检查网络后重试");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const url = share?.url || "";
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      ctl.store.toast("分享链接已复制");
    } catch {
      const input = document.querySelector<HTMLInputElement>("[data-share-url]");
      if (input) { input.focus(); input.select(); try { document.execCommand("copy"); ctl.store.toast("分享链接已复制"); } catch { ctl.store.toast("复制失败，请手动选中复制"); } }
    }
  };

  const revoke = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await fetch("/api/canvas-share/by-canvas/" + encodeURIComponent(canvasId), { method: "DELETE" });
      setShare(null); setRevoking(false);
      ctl.store.toast("已撤销分享，之前的链接立即失效");
    } catch {
      setError("撤销分享失败，稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return <div className="nshare" data-share-panel>
    <div className="mh" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button className="ib" style={{ width: 22, height: 22 }} aria-label="返回" onClick={back}><Icon name="back" size="s" /></button>
      分享链接 · 局域网
    </div>
    <div className="nshare-hint" style={{ paddingTop: 2 }}>{canvasName || "这张画布"} · 同一局域网内可直接打开，不上公网</div>
    <div className="nshare-row">
      <span>权限</span>
      <div className="seg">
        <button className={permission === "view" ? "on" : ""} data-share-perm="view" onClick={() => setPermission("view")}>仅查看</button>
        <button className={permission === "clone" ? "on" : ""} data-share-perm="clone" onClick={() => setPermission("clone")}>可克隆</button>
        <button className={permission === "template" ? "on" : ""} data-share-perm="template" onClick={() => setPermission("template")}>可存模板</button>
      </div>
    </div>
    <div className="nshare-row">
      <span>有效期</span>
      <div className="seg">
        {EXPIRES.map((entry) => <button key={entry.value} className={days === entry.value ? "on" : ""} data-share-days={entry.value} onClick={() => setDays(entry.value)}>{entry.label}</button>)}
      </div>
    </div>
    {error ? <div className="nshare-err" role="alert">{error}</div> : null}
    {loading ? <div className="nshare-hint">读取中…</div> : null}
    {!loading && !share ? <div className="nshare-foot">
      <button className="nshare-btn pri" data-share-create disabled={busy} onClick={() => void createOrUpdate()}>{busy ? "生成中…" : "生成分享链接"}</button>
    </div> : null}
    {share ? <>
      <div className="nshare-link">
        <input data-share-url readOnly value={share.url} onFocus={(e) => e.currentTarget.select()} aria-label="分享链接" />
        <button className="nshare-btn" data-share-copy onClick={() => void copy()}><Icon name="copy" size="xs" />复制</button>
      </div>
      <div className="nshare-hint">{permissionLabel(share.permission)} · {share.expires_at ? "到期自动失效" : "永久有效"} · 打开后可直接只读浏览</div>
      <div className="msep" />
      {revoking ? <div className="nshare-foot">
        <button className="nshare-btn" onClick={() => setRevoking(false)}>取消</button>
        <button className="nshare-btn danger" data-share-revoke-ok disabled={busy} onClick={() => void revoke()}>确认撤销</button>
      </div> : <div className="nshare-foot">
        <button className="nshare-btn" data-share-update disabled={busy} onClick={() => void createOrUpdate()}>{busy ? "更新中…" : "更新设置"}</button>
        <button className="nshare-btn danger" data-share-revoke onClick={() => setRevoking(true)}>撤销分享</button>
      </div>}
    </> : null}
  </div>;
}

function OpenByLink({ ctl, close, back }: { ctl: Ctl; close: () => void; back: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const open = () => {
    const parsed = parseShareLink(value);
    if (parsed.error) { setError(parsed.error); return; }
    close();
    // 裸 token / 本机链接 → 原同源路径；远端链接带上完整 URL，预览时由本机后端代取
    window.dispatchEvent(new CustomEvent("novai:share-preview", { detail: { token: parsed.token, url: parsed.url } }));
  };
  return <div className="nshare" data-share-open>
    <div className="mh" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button className="ib" style={{ width: 22, height: 22 }} aria-label="返回" onClick={back}><Icon name="back" size="s" /></button>
      打开分享链接
    </div>
    <input className="nshare-input" data-share-input autoFocus value={value} placeholder="粘贴分享链接，例如 http://192.168.1.8:3000/static/canvas.html?share=…" onChange={(e) => { setValue(e.target.value); setError(""); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") open(); }} />
    {error ? <div className="nshare-err" role="alert">{error}</div> : null}
    <div className="nshare-hint">只读预览，不会改动对方的画布；有克隆权限时可把节点放进当前画布。</div>
    <div className="nshare-foot">
      <button className="nshare-btn pri" data-share-open-go disabled={!value.trim()} onClick={open}>打开预览</button>
    </div>
  </div>;
}

/** 挂在 Chrome 上：接收「打开分享链接」事件，在当前画布之上渲染只读预览层。 */
export function ShareLinkHost() {
  const ctl = useCtl();
  const theme = useS((s) => s.ui.theme);
  const [target, setTarget] = useState<{ token: string; url: string } | null>(null);
  useEffect(() => {
    const on = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail === "string") { if (detail) setTarget({ token: detail, url: "" }); return; }
      const token = typeof detail?.token === "string" ? detail.token : "";
      const url = typeof detail?.url === "string" ? detail.url : "";
      if (token) setTarget({ token, url });
    };
    window.addEventListener("novai:share-preview", on);
    return () => window.removeEventListener("novai:share-preview", on);
  }, []);
  if (!target) return null;
  const close = () => setTarget(null);
  const cloneToCanvas = (doc: CanvasDoc, stats: MediaStats) => {
    try {
      const made = cloneWorkflowForImport(doc, ctl.center(), uid);
      if (!made.nodes.length) return null;
      ctl.store.addNodes(made.nodes, made.edges, { select: true, history: true });
      ctl.fitTo(made.nodes, 120, 1);
      const media = mediaStatsText(stats);
      ctl.store.toast("已克隆 " + made.nodes.length + " 个节点、" + made.edges.length + " 条连线到当前画布" + (media ? "，" + media : ""));
      return { nodes: made.nodes.length, edges: made.edges.length };
    } catch {
      return null;
    }
  };
  return createPortal(
    <div className="cn-root" data-theme={theme} style={{ position: "fixed", inset: 0, zIndex: 80 }}>
      <ShareView token={target.token} shareUrl={target.url} mode="embed" onClose={close} onCloneDoc={cloneToCanvas} />
    </div>,
    document.body,
  );
}
