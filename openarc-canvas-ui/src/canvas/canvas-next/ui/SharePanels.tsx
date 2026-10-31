/**
 * 共享按钮：成员与权限、邀请链接、协作房间、局域网协作、素材同步到团队资产库。
 * 面板本身复用桌面版现成组件（CanvasSharePanel 等，样式在外壳 styles.css），这里只负责入口和摆放。
 */
import { useEffect, useState } from "react";
import { CanvasAssetSyncPanel } from "../../CanvasAssetSyncPanel";
import { CanvasCollabPanel } from "../../CanvasDxosPanels";
import { CanvasInvitePanel } from "../../CanvasInvitePanel";
import { CanvasSharePanel } from "../../CanvasSharePanel";
import { LanCollabPanel } from "../../react-canvas/LanCollabPanel";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { openPop } from "./overlay";

type Kind = "members" | "invite" | "room" | "lan" | "assets";
const cmd = async (payload: Record<string, unknown>) => {
  const api = (window as unknown as { openarc?: { canvas?: { command?: (r: Record<string, unknown>) => Promise<any> } } }).openarc?.canvas;
  if (!api || typeof api.command !== "function") return { ok: false, error: "BRIDGE_UNAVAILABLE", detail: "未连接桌面后端" };
  return api.command(payload);
};

export function shareMenu(anchor: Element, canManage: boolean, peers: number) {
  const go = (k: Kind) => window.dispatchEvent(new CustomEvent("cn:share", { detail: k }));
  openPop(anchor, (close) => <>
    <div className="mh">共享与协作{peers ? ` · ${peers + 1} 人在线` : ""}</div>
    <button className="mi" onClick={() => { close(); go("members"); }}><span className="ic"><Icon name="user" size="s" /></span><span>成员与权限<span className="d">邀请同事查看或编辑这张画布</span></span></button>
    <button className="mi" onClick={() => { close(); go("invite"); }}><span className="ic"><Icon name="link" size="s" /></span><span>邀请链接<span className="d">{canManage ? "生成一次性邀请码" : "输入别人给的邀请码加入"}</span></span></button>
    <button className="mi" onClick={() => { close(); go("room"); }}><span className="ic"><Icon name="msg" size="s" /></span><span>协作房间<span className="d">同时编辑、看到彼此的光标</span></span></button>
    <button className="mi" onClick={() => { close(); go("lan"); }}><span className="ic"><Icon name="share" size="s" /></span><span>局域网协作<span className="d">同一网络里的另一台电脑扫码 / 输码加入</span></span></button>
    <div className="msep" />
    <button className="mi" onClick={() => { close(); go("assets"); }}><span className="ic"><Icon name="libadd" size="s" /></span><span>同步到团队资产库<span className="d">把画布里的素材整理进资产库，团队成员可复用</span></span></button>
  </>, "down", "right");
}

export function SharePanels() {
  const ctl = useCtl(); const canvasId = useS((s) => s.canvasId); const name = useS((s) => s.name);
  const [kind, setKind] = useState<Kind | null>(null); const [canManage, setCanManage] = useState(true);
  useEffect(() => { const on = (e: Event) => setKind((e as CustomEvent).detail as Kind); addEventListener("cn:share", on); return () => removeEventListener("cn:share", on); }, []);
  if (!kind) return null;
  const close = () => setKind(null);
  return <div className="canvas-share-layer cn-share-layer" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
    {kind === "members" ? <CanvasSharePanel canvasId={canvasId} title={name} cmd={cmd} onClose={close} onData={(d) => setCanManage(!!d?.canManage)} onOpenInvite={() => setKind("invite")} /> : null}
    {kind === "invite" ? <CanvasInvitePanel canvasId={canvasId} title={name} canManage={canManage} cmd={cmd} onClose={close} onRedeemed={(id) => ctl.host.openCanvas?.(id)} /> : null}
    {kind === "room" ? <CanvasCollabPanel canvasId={canvasId} title={name} cmd={cmd} onClose={close} /> : null}
    {kind === "assets" ? <CanvasAssetSyncPanel canvasId={canvasId} title={name} cmd={cmd} onClose={close} /> : null}
    {kind === "lan" ? <div className="canvas-share-panel cn-lan">
      <header className="canvas-share-panel__head"><div className="canvas-share-panel__titles"><h2 className="canvas-share-panel__title">局域网协作</h2><p className="canvas-share-panel__subject">{name}</p></div><button className="ib" aria-label="关闭" onClick={close}><Icon name="x" size="s" /></button></header>
      <LanCollabPanel canvasId={canvasId} getHandlers={() => (ctl.collab ? ctl.collab.handlers() : ({} as never))} onJoin={(info, collab) => { ctl.collab?.addTransport(collab); ctl.store.toast(info.canEdit ? "已加入局域网协作，可以一起编辑" : "已加入局域网协作（只读）"); close(); }} />
    </div> : null}
  </div>;
}
