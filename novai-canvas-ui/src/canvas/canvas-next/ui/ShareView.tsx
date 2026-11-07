/**
 * 分享只读视图（T49 + T52/T53）：
 * - 独立页：/static/canvas.html?share=<token> → 只读预览窗 + 克隆到画布 / 保存为模板；
 * - 画布内：ShareSheet 的「打开分享链接」→ 同一个只读预览窗，克隆时追加到当前画布；
 * - 跨机：粘贴的链接主机（带端口）不是本机时，先经本机后端 GET /api/lan/share-preview 代取快照；
 * - 克隆 / 存模板前把远端媒体复制到本机（/api/canvas-share/localize-media），失败的保留原地址并报数。
 * 画布渲染复用 TemplatePreview（docGraph + 平移缩放 + 点节点详情）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { serverDocToDoc } from "../../../novaiBackend";
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";
import { absolutizeSnapshot } from "./lanDoc";
import { savePersonalTemplate } from "../personalTemplates";
import { Icon } from "./Icon";
import { TemplatePreview } from "./TemplatePreview";
import { isRemoteShareUrl, parseShareToken, permissionLabel, previewDocOf, shareErrorMessage, type ShareSnapshot } from "./shareDoc";
import { localizeDocMedia, mediaStatsText, type MediaStats } from "./shareMedia";

export type ShareViewProps = {
  token: string;
  mode: "page" | "embed";
  /** 用户粘贴的原始分享链接（裸令牌时为空）：远端链接才走本机代取与媒体本地化 */
  shareUrl?: string;
  onClose?: () => void;
  /** 画布内打开时：把（已本地化的）doc 追加到当前画布；返回落地数量，null 表示失败 */
  onCloneDoc?: (doc: CanvasDoc, stats: MediaStats) => { nodes: number; edges: number } | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "ready"; snapshot: ShareSnapshot };

/** dev（vite base /static/novai-canvas/）与打包页（/static/canvas.html）共用一套跳转 */
function appBasePath(): string {
  const path = location.pathname;
  return /\/static\/novai-canvas\/?$/.test(path) ? "/static/novai-canvas/" : "";
}

function canvasPageUrl(id: string): string {
  const base = appBasePath();
  return base ? base + "?id=" + encodeURIComponent(id) : "/static/canvas.html?id=" + encodeURIComponent(id);
}

function goBack() {
  try {
    if (history.length > 1) { history.back(); return; }
  } catch { /* 没有历史时回列表 */ }
  location.href = appBasePath() || "/static/canvas-list.html";
}

export function ShareView({ token, mode, shareUrl, onClose, onCloneDoc }: ShareViewProps) {
  const clean = useMemo(() => parseShareToken(token), [token]);
  const remote = useMemo(() => isRemoteShareUrl(shareUrl), [shareUrl]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "clone" | "template">("");
  const [pendingCanvasId, setPendingCanvasId] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let alive = true;
    setElapsed(0);
    if (!clean) { setState({ kind: "error", status: 404, message: shareErrorMessage(404) }); return; }
    setState({ kind: "loading" });
    setPendingCanvasId("");
    const request = remote
      ? fetch("/api/lan/share-preview?url=" + encodeURIComponent(String(shareUrl || "")), { headers: { Accept: "application/json" } })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(new Error(String(data?.detail || "")), { status: response.status, detail: String(data?.detail || "") });
          // 对方快照里的相对媒体地址补成对方 origin + 口令，预览图才打得开
          return absolutizeSnapshot(data?.snapshot, shareUrl) as ShareSnapshot;
        })
      : fetch("/api/canvas-share/" + encodeURIComponent(clean), { headers: { Accept: "application/json" } })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(new Error(String(data?.detail || "")), { status: response.status, detail: String(data?.detail || "") });
          return data as ShareSnapshot;
        });
    request
      .then((snapshot) => { if (alive) setState({ kind: "ready", snapshot }); })
      .catch((error: any) => {
        if (!alive) return;
        const status = Number(error?.status) || 0;
        setState({ kind: "error", status, message: shareErrorMessage(status, String(error?.detail || error?.message || "")) });
      });
    return () => { alive = false; };
  }, [clean, remote, shareUrl, reloadKey]);

  // 大画布代取可能几十秒：显示已等待秒数，超过 5s 给一句「画布较大，请稍候」
  useEffect(() => {
    if (state.kind !== "loading") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [state.kind, reloadKey]);

  const converted = useMemo(() => {
    if (state.kind !== "ready") return null;
    const doc = serverDocToDoc({ nodes: state.snapshot.canvas?.nodes || [], connections: state.snapshot.canvas?.connections || [], settings: state.snapshot.canvas?.settings }).doc;
    return doc;
  }, [state]);

  const preview = useMemo(() => previewDocOf(converted), [converted]);
  const snapshot = state.kind === "ready" ? state.snapshot : null;
  const canClone = !!snapshot && (snapshot.can_clone ?? snapshot.share.can_clone);
  const canSaveTemplate = !!snapshot && (snapshot.can_save_template ?? snapshot.share.can_save_template);
  const title = snapshot?.title || snapshot?.canvas?.title || "分享的画布";
  const ownerName = snapshot?.share.owner_name || "本机用户";

  useEffect(() => {
    if (mode !== "page") return;
    const previous = document.title;
    document.title = title + " · 分享 · NOVAI";
    return () => { document.title = previous; };
  }, [mode, title]);

  const close = useCallback(() => {
    if (onClose) { onClose(); return; }
    if (mode === "page") goBack();
  }, [mode, onClose]);

  /** 克隆 / 存模板前先把远端媒体取到本机（本机链接没有 http 媒体，直接跳过） */
  const localize = async (doc: CanvasDoc) => {
    const result = await localizeDocMedia(doc, remote ? String(shareUrl || "") : "");
    if (result.error) setNote(result.error);
    return result;
  };

  const clone = async () => {
    if (!canClone || busy) return;
    setBusy("clone");
    setNote("");
    if (mode === "embed") {
      if (!converted || !onCloneDoc) { setBusy(""); setNote("这张分享没有可克隆的节点"); return; }
      const localized = await localize(converted);
      const made = onCloneDoc(localized.doc, { copied: localized.copied, failed: localized.failed, skipped: localized.skipped });
      setBusy("");
      if (!made) { setNote("克隆失败：当前画布没有接收这些节点"); return; }
      const media = mediaStatsText(localized);
      setNote("已克隆 " + made.nodes + " 个节点、" + made.edges + " 条连线到当前画布" + (media ? "，" + media : ""));
      close();
      return;
    }
    try {
      const response = await fetch("/api/canvas-share/" + encodeURIComponent(clean) + "/clone", { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setBusy(""); setNote(shareErrorMessage(response.status, String(data?.detail || ""))); return; }
      const id = String(data?.canvas_id || "");
      if (!id) { setBusy(""); setNote("克隆失败：没有拿到新画布 ID"); return; }
      const copied = Math.max(0, Number(data?.copied) || 0);
      const failed = Math.max(0, Number(data?.failed) || 0);
      if (failed > 0) {
        // 不自动跳走：先告诉用户哪些资源没取到，再给「打开副本」
        setBusy("");
        setPendingCanvasId(id);
        setNote("副本已创建，但 " + failed + " 个资源没复制成功（保留原地址）；可先打开副本确认。" + (copied ? "已复制 " + copied + " 个。" : ""));
        return;
      }
      location.href = canvasPageUrl(id);
    } catch {
      setBusy("");
      setNote(shareErrorMessage(0));
    }
  };

  const saveTemplate = async () => {
    if (!canSaveTemplate || busy) return;
    setBusy("template");
    setNote("");
    if (!converted || !converted.nodes.length) { setBusy(""); setNote("这张分享没有可保存的节点"); return; }
    const localized = await localize(converted);
    const result = await savePersonalTemplate({ title: title + " 模板", prompt: "", doc: localized.doc });
    setBusy("");
    if (!result.ok) { setNote("保存模板失败：" + (result.error || "未知错误")); return; }
    const media = mediaStatsText(localized);
    setNote("已保存到「我的模板」" + (media ? "，" + media : ""));
  };

  if (state.kind === "loading") {
    return <div className="novai-canvas-error" data-share-loading>
      <h2>正在打开分享…</h2>
      <p style={{ color: "#6e6e73", fontSize: 13 }}>{remote ? "正在从对方的电脑读取画布" : "正在读取画布"}{elapsed > 0 ? "（已等待 " + elapsed + " 秒）" : "…"}</p>
      {elapsed >= 5 ? <p style={{ color: "#6e6e73", fontSize: 12 }}>画布较大，请稍候</p> : null}
    </div>;
  }
  if (state.kind === "error") {
    return <div className="novai-canvas-error" data-share-error={state.status}>
      <h2>分享打不开</h2>
      <p style={{ maxWidth: 420, lineHeight: 1.7, fontSize: 13, color: "#6e6e73" }}>{state.message}</p>
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <button type="button" className="secondary" data-share-retry onClick={() => { setNote(""); setReloadKey((value) => value + 1); }}>重试</button>
        <button type="button" onClick={() => { if (mode === "embed" && onClose) onClose(); else goBack(); }}>返回画布</button>
      </div>
    </div>;
  }

  return <>
    <TemplatePreview
      entry={{ id: clean, name: title, doc: preview }}
      onClose={close}
      note={note || ("只读分享 · 分享者：" + ownerName + (remote ? "（另一台电脑）" : ""))}
      busy={!!busy}
      actions={<>
        <span className="tplpv-chip" data-share-permission={snapshot?.share.permission}>{permissionLabel(snapshot?.share.permission)}</span>
        {pendingCanvasId ? <button type="button" className="tplpv-btn pri" data-share-open-copy onClick={() => { location.href = canvasPageUrl(pendingCanvasId); }}><Icon name="right" size="s" />打开副本</button> : null}
        {canSaveTemplate ? <button type="button" className="tplpv-btn" data-share-template disabled={!!busy} onClick={() => void saveTemplate()}><Icon name="layout" size="s" />{busy === "template" ? "保存中…" : "保存为模板"}</button> : null}
        {canClone && !pendingCanvasId ? <button type="button" className="tplpv-btn pri" data-share-clone disabled={!!busy} onClick={() => void clone()}><Icon name="copy" size="s" />{busy === "clone" ? "克隆中…" : "克隆到画布"}</button> : null}
      </>}
    />
  </>;
}

/** 独立分享页（main.tsx 在 URL 带 share= 时渲染）：套 .cn-root 才有画布主题变量。 */
export function SharePage({ token, theme }: { token: string; theme: "dark" | "light" }) {
  return <div className="cn-root" data-theme={theme} style={{ position: "fixed", inset: 0 }}><ShareView token={token} mode="page" /></div>;
}
