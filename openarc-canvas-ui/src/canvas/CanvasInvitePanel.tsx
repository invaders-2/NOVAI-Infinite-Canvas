/**
 * 画布宿主浮层 · 邀请码。
 *
 * 真实命令（electron/canvas-dxos-commands.cjs，canvas-service 内与共享同一事务 / 审计）：
 *   · canvas/invites/get     当前有效邀请摘要（末 4 位 / 权限 / 已兑换人数；仅 canManage 可见）
 *   · canvas/invites/create  { canvasId, permission: "read"|"edit" } → 明文口令**只在本次响应返回一次**
 *   · canvas/invites/revoke  撤销画布当前邀请（幂等）
 *   · canvas/invites/redeem  { code } → 按既有 share 三档加入（只读→VIEWER、编辑→EDITOR）
 * 数据库只存 sha256 与末 4 位提示；面板关闭后无法再查看明文，这是后端事实，不是 UI 藏起来。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, Ticket, X } from "lucide-react";
import {
  copyToClipboard,
  inviteErrorText,
  invitePermissionLabel,
  INVITE_PERMISSIONS,
  type Cmd,
} from "./canvasDxosModel";

type InviteSummary = { id: string; codeHint: string; permission: string; joinCount: number; createdAt: number };

export function CanvasInvitePanel({
  canvasId,
  title,
  canManage,
  cmd,
  onClose,
  onRedeemed,
}: {
  canvasId: string;
  title?: string;
  canManage: boolean;
  cmd: Cmd;
  onClose: () => void;
  onRedeemed?: (canvasId: string) => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [loading, setLoading] = useState(canManage);
  const [readOnly, setReadOnly] = useState(!canManage);
  const [invite, setInvite] = useState<InviteSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [creating, setCreating] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [revokeAsk, setRevokeAsk] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState<{ title: string; permission: string } | null>(null);

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

  const loadInvite = useCallback(async () => {
    if (!canManage) { setReadOnly(true); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const res = await cmd({ type: "canvas/invites/get", canvasId });
    if (!alive.current) return;
    setLoading(false);
    if (!res || !res.ok) {
      if (res && res.error === "READ_ONLY") { setReadOnly(true); return; }
      setError(inviteErrorText(res, "读取邀请码失败"));
      return;
    }
    setInvite(res.invite || null);
  }, [canManage, canvasId, cmd]);

  useEffect(() => { void loadInvite(); }, [loadInvite]);

  const createInvite = useCallback(async () => {
    if (creating || readOnly) return;
    setCreating(true);
    setError(null);
    setFlash(null);
    setCopied(null);
    const res = await cmd({ type: "canvas/invites/create", canvasId, permission });
    if (!alive.current) return;
    setCreating(false);
    if (!res || !res.ok) {
      setError(inviteErrorText(res, "生成邀请码失败"));
      return;
    }
    const code = typeof res.code === "string" ? res.code : "";
    setCreatedCode(code);
    setInvite(res.invite || null);
    setFlash("已生成新邀请码（" + invitePermissionLabel(permission) + "）：口令只显示这一次，旧口令已全部失效");
  }, [canvasId, cmd, creating, permission, readOnly]);

  const copyCode = useCallback(async () => {
    if (!createdCode) return;
    setCopied(null);
    const result = await copyToClipboard(createdCode);
    if (!alive.current) return;
    setCopied(result.ok ? createdCode : null);
    if (!result.ok) setError("复制失败（" + (result.error || "剪贴板不可用") + "）：请手动选中口令复制。");
  }, [createdCode]);

  const revoke = useCallback(async () => {
    if (revoking) return;
    setRevoking(true);
    setError(null);
    const res = await cmd({ type: "canvas/invites/revoke", canvasId });
    if (!alive.current) return;
    setRevoking(false);
    setRevokeAsk(false);
    if (!res || !res.ok) {
      setError(inviteErrorText(res, "撤销邀请码失败"));
      return;
    }
    setInvite(null);
    setCreatedCode(null);
    setFlash(res.revoked ? "已撤销当前邀请码：已发出的口令全部失效" : "当前没有有效邀请码（无需撤销）");
  }, [canvasId, cmd, revoking]);

  const redeem = useCallback(async () => {
    const code = redeemCode.trim();
    if (!code || redeeming) return;
    setRedeeming(true);
    setRedeemError(null);
    setRedeemed(null);
    const res = await cmd({ type: "canvas/invites/redeem", code });
    if (!alive.current) return;
    setRedeeming(false);
    if (!res || !res.ok) {
      setRedeemError(inviteErrorText(res, "兑换邀请码失败"));
      return;
    }
    const canvas = res.canvas || {};
    const canvasTitle = String(canvas.title || "画布");
    setRedeemed({ title: canvasTitle, permission: invitePermissionLabel(res.permission) });
    setRedeemCode("");
    onRedeemed?.(String(canvas.canvasId || ""));
  }, [cmd, onRedeemed, redeemCode, redeeming]);

  return (
    <aside
      className="canvas-share-panel canvas-dxos-panel"
      role="complementary"
      aria-labelledby={titleId}
      data-canvas-invite-panel
      data-canvas-invite-canvas={canvasId}
      data-canvas-invite-manage={readOnly ? "0" : "1"}
      data-canvas-invite-active={invite ? "1" : "0"}
      data-canvas-invite-code={createdCode ? "1" : "0"}
    >
      <header className="canvas-share-panel__head">
        <div className="canvas-share-panel__titles">
          <h2 id={titleId} className="canvas-share-panel__title">邀请</h2>
          {title ? <p className="canvas-share-panel__subject" title={title}>{title}</p> : null}
        </div>
        <button ref={closeRef} type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="关闭邀请面板" data-canvas-invite-close onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="canvas-share-panel__body">
        {flash ? <p className="canvas-share-flash" role="status" data-canvas-invite-flash>{flash}</p> : null}
        {error ? <p className="gov-error" role="alert" data-canvas-invite-error>{error}</p> : null}

        <section className="canvas-share-section">
          <h3 className="canvas-share-section__title">当前画布邀请</h3>
          {readOnly ? (
            <p className="canvas-share-hint" data-canvas-invite-readonly>
              只有所有者或「管理共享」成员可以生成 / 撤销邀请码。你仍然可以用下方口令加入其他画布。
            </p>
          ) : loading ? (
            <p className="canvas-share-hint" role="status">正在读取邀请码…</p>
          ) : (
            <>
              {invite ? (
                <div className="canvas-dxos-rule" data-canvas-invite-summary>
                  <KeyRound size={14} aria-hidden="true" />
                  <span>有效邀请：末 4 位 <code className="canvas-dxos-code">{invite.codeHint}</code> · 权限 {invitePermissionLabel(invite.permission)} · 已兑换 {invite.joinCount} 人</span>
                </div>
              ) : (
                <p className="canvas-share-empty" data-canvas-invite-empty>当前没有有效邀请码。</p>
              )}
              <div className="canvas-dxos-actions">
                <div className="segmented text" role="group" aria-label="新邀请权限">
                  {INVITE_PERMISSIONS.map((option) => (
                    <button key={option.value} type="button" aria-pressed={permission === option.value} data-canvas-invite-permission={option.value} onClick={() => setPermission(option.value)}>{option.label}</button>
                  ))}
                </div>
                <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-invite-create disabled={creating} onClick={() => void createInvite()}>
                  {creating ? <LoaderCircle size={14} className="canvas-dxos-spin" aria-hidden="true" /> : <Ticket size={14} aria-hidden="true" />}
                  <span className="ds-btn__label">{creating ? "生成中…" : invite ? "重新生成邀请码" : "生成邀请码"}</span>
                </button>
                {invite ? (
                  revokeAsk ? (
                    <span className="canvas-share-confirm" role="group" aria-label="确认撤销邀请码">
                      <span>撤销后已发出的口令全部失效？</span>
                      <button type="button" className="ds-btn ds-btn--danger ds-btn--sm" data-canvas-invite-revoke-confirm disabled={revoking} onClick={() => void revoke()}>{revoking ? "撤销中…" : "确认撤销"}</button>
                      <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-invite-revoke-cancel disabled={revoking} onClick={() => setRevokeAsk(false)}>取消</button>
                    </span>
                  ) : (
                    <button type="button" className="ds-btn ds-btn--danger ds-btn--sm" data-canvas-invite-revoke onClick={() => setRevokeAsk(true)}>撤销邀请码</button>
                  )
                ) : null}
              </div>
              {createdCode ? (
                <div className="canvas-dxos-invite-code" data-canvas-invite-created>
                  <p className="canvas-share-hint">新口令（只显示这一次，关闭面板后无法再次查看）：</p>
                  <div className="canvas-dxos-actions">
                    <code className="canvas-dxos-code canvas-dxos-invite-code__value" data-canvas-invite-code-value>{createdCode}</code>
                    <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-invite-copy onClick={() => void copyCode()}>
                      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                      <span className="ds-btn__label">{copied ? "已复制" : "复制口令"}</span>
                    </button>
                  </div>
                  <p className="canvas-share-hint">权限：{invitePermissionLabel(invite && invite.permission)}；只存 sha256 与末 4 位提示，明文不会落库。</p>
                </div>
              ) : null}
            </>
          )}
        </section>

        <section className="canvas-share-section">
          <h3 className="canvas-share-section__title">用邀请码加入画布</h3>
          <p className="canvas-share-hint">输入 8 位口令（可带一个「-」，不区分大小写）。兑换成功后按既有共享三档获得查看者 / 编辑者权限。</p>
          <div className="canvas-dxos-actions">
            <input
              className="canvas-dxos-input"
              aria-label="邀请口令"
              placeholder="例如 ABCD-EFGH"
              maxLength={20}
              value={redeemCode}
              data-canvas-invite-redeem-input
              onChange={(event) => setRedeemCode(event.target.value.toUpperCase())}
              onKeyDown={(event) => { if (event.key === "Enter") void redeem(); }}
            />
            <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-canvas-invite-redeem disabled={!redeemCode.trim() || redeeming} onClick={() => void redeem()}>
              {redeeming ? <LoaderCircle size={14} className="canvas-dxos-spin" aria-hidden="true" /> : null}
              <span className="ds-btn__label">{redeeming ? "兑换中…" : "兑换并加入"}</span>
            </button>
          </div>
          {redeemError ? <p className="gov-error" role="alert" data-canvas-invite-redeem-error>{redeemError}</p> : null}
          {redeemed ? (
            <p className="canvas-share-flash" role="status" data-canvas-invite-redeemed>
              已兑换口令：《{redeemed.title}》（{redeemed.permission}）；权限按既有共享三档生效，画布列表已刷新。
            </p>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
