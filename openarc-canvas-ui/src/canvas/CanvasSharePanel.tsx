/**
 * 画布共享面板（宿主浮层 · React 岛）。
 *
 * 入口在 CanvasHost 右上角（画布页）与列表卡片菜单（经桥 open-share）；
 * **共享 UI 只属于宿主**：上游页面的外观不动，列表页只多一个菜单项。
 *
 * 规则：三档角色（查看者/编辑者/管理共享）+ 私有/组织内可见，全部由服务端
 * canvas/shares · canvas/access/get 返回的能力决定；无管理权的用户只看到
 * "我的角色 + 可见性说明"，服务端本身就不会把成员 ID 交给这个面板。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Search, Share2, Trash2, UserPlus, X } from "lucide-react";
import {
  DEFAULT_SHARE_ROLE,
  SHARE_ROLE_OPTIONS,
  beginRemove,
  beginTransfer,
  entryLabel,
  formatJoinedAt,
  isRemoveConfirming,
  mapShareError,
  memberLabel,
  memberRowState,
  nextRemove,
  nextTransfer,
  panelCapabilities,
  shareRoleLabel,
  sourceRoleLabel,
  transferTargets,
  visibilityHint,
  visibilityLabel,
  visibilityValue,
  type Candidate,
  type RemoveState,
  type ShareMember,
  type ShareRole,
  type SharesResponse,
  type TransferState,
} from "./canvasShareModel";

type Cmd = (payload: Record<string, unknown>) => Promise<any>;

const initialRemove: RemoveState = { userId: null };
const initialTransfer: TransferState = { target: null, confirming: false };

/** 右上角入口：能管理显示「共享」，否则显示对方此刻的角色（点击打开同一面板的只读视图）。*/
export function CanvasShareEntry({ canManage, source, expanded = false, onOpen, buttonRef }: {
  canManage: boolean;
  source?: string | null;
  expanded?: boolean;
  onOpen: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const label = entryLabel(canManage, source);
  return (
    <button
      ref={buttonRef}
      type="button"
      className={"ds-btn ds-btn--sm canvas-share-entry" + (canManage ? " ds-btn--secondary" : " ds-btn--ghost")}
      data-canvas-share-entry
      data-canvas-share-entry-label={label}
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <Share2 size={14} aria-hidden="true" />
      <span className="canvas-share-entry__label">{label}</span>
    </button>
  );
}

export function CanvasSharePanel({
  canvasId,
  title,
  cmd,
  refreshToken = 0,
  onClose,
  onAccessChanged,
  onFatalAccessLost,
  onData,
  onOpenInvite,
}: {
  canvasId: string;
  title?: string;
  cmd: Cmd;
  refreshToken?: number;
  onClose: () => void;
  /** 自己的权限事实可能变了（例如把所有权转给别人）：让宿主立刻重读 access 并 pushContext。*/
  onAccessChanged?: () => void;
  /** 当前打开的画布已经被撤销/删除：让宿主切只读并提示/返回列表。*/
  onFatalAccessLost?: (error: string) => void;
  onData?: (data: SharesResponse | null) => void;
  onOpenInvite?: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const flashTimer = useRef<number | null>(null);
  const alive = useRef(true);
  // 回调放进 ref：父组件即使传内联函数也不会让 load 每次渲染都重建（否则会无限重读）。
  const fatalRef = useRef(onFatalAccessLost);
  fatalRef.current = onFatalAccessLost;
  const accessChangedRef = useRef(onAccessChanged);
  accessChangedRef.current = onAccessChanged;
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SharesResponse | null>(null);
  const [fatal, setFatal] = useState<{ code: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null);
  const [remove, setRemove] = useState<RemoveState>(initialRemove);
  const [transfer, setTransfer] = useState<TransferState>(initialTransfer);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [roleDraft, setRoleDraft] = useState<ShareRole>(DEFAULT_SHARE_ROLE);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateEpoch, setCandidateEpoch] = useState(0);
  const [transferPick, setTransferPick] = useState("");

  const say = useCallback((message: string) => {
    setFlash(message);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => { if (alive.current) setFlash(null); }, 3200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    setError(null);
    const res = await cmd({ type: "canvas/shares", canvasId });
    if (!alive.current) return;
    setLoading(false);
    if (!res || !res.ok) {
      const code = String((res && res.error) || "INTERNAL_ERROR");
      const message = mapShareError(code, res && res.detail);
      setFatal({ code, message });
      if (code === "NOT_FOUND_OR_FORBIDDEN") fatalRef.current?.(code);
      return;
    }
    setData(res as SharesResponse);
    setRemove(initialRemove);
    setTransfer(initialTransfer);
    setTransferPick("");
  }, [canvasId, cmd]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; if (flashTimer.current) window.clearTimeout(flashTimer.current); }; }, []);
  useEffect(() => { void load(); }, [load, refreshToken]);
  useEffect(() => { onData?.(data); }, [data, onData]);
  useEffect(() => { closeRef.current?.focus(); }, []);

  // Esc 关闭；行内两步确认打开时先取消确认（不误关整个面板）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (transfer.confirming) { setTransfer(nextTransfer(transfer, { type: "cancel" })); setTransferPick(""); return; }
      if (remove.userId) { setRemove(nextRemove(remove, { type: "cancel" })); return; }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, remove, transfer]);

  const caps = panelCapabilities({ canManage: !!data?.canManage, source: data?.access?.source });
  const visibility = visibilityValue(data?.visibility);
  const ownerId = data?.owner?.userId || null;
  const members = data?.shares || [];

  // 候选人：能管理就请求（转移所有者的下拉也用同一份候选）；查询变化 220ms 防抖；
  // 失败给行内错误而不是伪造空列表。
  useEffect(() => {
    if (!caps.canAddMember) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      setCandidateLoading(true);
      setCandidateError(null);
      const res = await cmd({ type: "canvas/share/candidates", canvasId, query, limit: 20 });
      if (!live) return;
      setCandidateLoading(false);
      if (!res || !res.ok) {
        setCandidates([]);
        setCandidateError(mapShareError(res && res.error, res && res.detail));
        return;
      }
      setCandidates(Array.isArray(res.items) ? res.items : []);
    }, query ? 220 : 0);
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [candidateEpoch, canvasId, caps.canAddMember, cmd, query]);

  const applyShares = useCallback((shares: ShareMember[] | null) => {
    if (!Array.isArray(shares)) return;
    setData((d) => (d ? { ...d, shares, shareCount: shares.length } : d));
  }, []);

  const toggleVisibility = async (next: "PRIVATE" | "ORGANIZATION") => {
    if (!data || busy || next === visibility) return;
    const previous = visibility;
    setBusy("visibility");
    setError(null);
    setData((d) => (d ? { ...d, visibility: next } : d));
    const res = await cmd({ type: "canvas/visibility", canvasId, visibility: next });
    if (!alive.current) return;
    setBusy(null);
    if (!res || !res.ok) {
      setData((d) => (d ? { ...d, visibility: previous } : d));
      setError(mapShareError(res && res.error, res && res.detail));
      return;
    }
    setData((d) => (d ? { ...d, visibility: visibilityValue(res.canvas && res.canvas.visibility) } : d));
    say(next === "ORGANIZATION" ? "已切换为「组织内可见」：组织成员只能查看" : "已切换为「私有」：仅被单独共享的人可打开");
  };

  const addMember = async (candidate: Candidate) => {
    const uid = String(candidate.userId || "");
    if (!uid || busy) return;
    setBusy("add:" + uid);
    setError(null);
    const res = await cmd({ type: "canvas/share", canvasId, userId: uid, role: roleDraft });
    if (!alive.current) return;
    setBusy(null);
    if (!res || !res.ok) {
      setError(mapShareError(res && res.error, res && res.detail));
      return;
    }
    applyShares(res.shares);
    setQuery("");
    setCandidateEpoch((n) => n + 1);
    say(memberLabel(candidate) + " 已加入（" + shareRoleLabel(roleDraft) + "）");
  };

  const updateRole = async (member: ShareMember, role: string) => {
    if (!caps.canChangeRole || busy) return;
    const uid = String(member.userId);
    setBusy("role:" + uid);
    setRowError(null);
    const res = await cmd({ type: "canvas/share/update", canvasId, userId: uid, role });
    if (!alive.current) return;
    setBusy(null);
    if (!res || !res.ok) {
      setRowError({ userId: uid, message: mapShareError(res && res.error, res && res.detail) });
      return;
    }
    applyShares(res.shares);
    say(memberLabel(member) + " 的角色已改为「" + shareRoleLabel(role) + "」");
  };

  const confirmRemove = async (member: ShareMember) => {
    const uid = String(member.userId);
    if (!caps.canRemoveMember || busy) return;
    setBusy("remove:" + uid);
    setRowError(null);
    const res = await cmd({ type: "canvas/share/remove", canvasId, userId: uid });
    if (!alive.current) return;
    setBusy(null);
    if (!res || !res.ok) {
      setRowError({ userId: uid, message: mapShareError(res && res.error, res && res.detail) });
      return;
    }
    setRemove(nextRemove(remove, { type: "cancel" }));
    applyShares(res.shares);
    setCandidateEpoch((n) => n + 1);
    say(memberLabel(member) + " 已被移出共享");
  };

  const confirmTransfer = async () => {
    if (!caps.canTransferOwner || !transfer.target || busy) return;
    const target = transfer.target;
    setBusy("transfer");
    setError(null);
    const res = await cmd({ type: "canvas/owner/transfer", canvasId, newOwnerUserId: target });
    if (!alive.current) return;
    setBusy(null);
    if (!res || !res.ok) {
      setTransfer(nextTransfer(transfer, { type: "cancel" }));
      setTransferPick("");
      setError(mapShareError(res && res.error, res && res.detail));
      if (res && res.error === "READ_ONLY" && res.detail === "owner-changed") accessChangedRef.current?.();
      return;
    }
    applyShares(res.shares);
    setTransfer(nextTransfer(transfer, { type: "done" }));
    setTransferPick("");
    say("所有权已转移：你现在是编辑者，不能再管理共享");
    accessChangedRef.current?.();
    // 以服务端最新能力为准（转移后 canManage 变 false）：重新读一次面板数据。
    void load();
  };

  const targets = transferTargets(members, candidates, ownerId);
  const transferTargetLabel = targets.find((t) => t.userId === transfer.target)?.label || transfer.target || "";
  const selectedTransferLabel = targets.find((t) => t.userId === transferPick)?.label || "";

  return (
    <aside
      className="canvas-share-panel"
      role="complementary"
      aria-labelledby={titleId}
      data-canvas-share-panel
      data-canvas-share-ready={data && !loading ? "1" : "0"}
      data-canvas-share-can-manage={data ? (data.canManage ? "1" : "0") : ""}
      data-canvas-share-source={data?.access?.source || ""}
      data-canvas-share-visibility={visibility}
      data-canvas-share-mode={data ? (data.canManage ? "manage" : "readonly") : "loading"}
      data-canvas-share-refresh={refreshToken}
    >
      <header className="canvas-share-panel__head">
        <div className="canvas-share-panel__titles">
          <h2 id={titleId} className="canvas-share-panel__title">共享</h2>
          {title ? <p className="canvas-share-panel__subject" title={title}>{title}</p> : null}
        </div>
        {onOpenInvite ? (
          <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-testid="share-open-invite" onClick={onOpenInvite}>
            <UserPlus size={14} aria-hidden="true" />邀请
          </button>
        ) : null}
        <button ref={closeRef} type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost" aria-label="关闭共享面板" data-canvas-share-close onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="canvas-share-panel__body">
        {loading ? (
          <div className="canvas-share-skeleton" data-canvas-share-loading aria-hidden="true">
            <span className="gov-row" /><span className="gov-row" /><span className="gov-row" />
          </div>
        ) : fatal ? (
          <div className="canvas-share-fatal" role="alert" data-canvas-share-fatal={fatal.code}>
            <p className="gov-error">{fatal.message}</p>
            <div className="canvas-share-inline">
              <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => void load()}>重试</button>
              <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onClose}>关闭</button>
            </div>
          </div>
        ) : data ? (
          <>
            {error ? <p className="gov-error" role="alert" data-canvas-share-error>{error}</p> : null}
            {flash ? <p className="canvas-share-flash" role="status" data-canvas-share-flash>{flash}</p> : null}

            <section className="canvas-share-section" aria-labelledby={titleId + "-access"}>
              <h3 id={titleId + "-access"} className="canvas-share-section__title">访问权限</h3>
              {caps.canChangeVisibility ? (
                <div className="segmented text" role="group" aria-label="可见性" data-canvas-share-visibility-group>
                  <button type="button" aria-pressed={visibility === "PRIVATE"} disabled={!!busy} data-share-visibility="PRIVATE" onClick={() => void toggleVisibility("PRIVATE")}>私有</button>
                  <button type="button" aria-pressed={visibility === "ORGANIZATION"} disabled={!!busy} data-share-visibility="ORGANIZATION" onClick={() => void toggleVisibility("ORGANIZATION")}>组织内可见</button>
                </div>
              ) : (
                <p className="canvas-share-visibility" data-canvas-share-visibility-label>{visibilityLabel(visibility)}</p>
              )}
              <p className="canvas-share-hint">{visibilityHint(visibility)}</p>
            </section>

            {caps.showMemberList ? (
              <section className="canvas-share-section" aria-labelledby={titleId + "-members"}>
                <h3 id={titleId + "-members"} className="canvas-share-section__title">
                  成员 <span className="ds-badge ds-badge--sm ds-badge--neutral" data-canvas-share-member-count>{data.shareCount}</span>
                </h3>
                <ul className="canvas-share-members" data-canvas-share-members>
                  <li className="gov-row canvas-share-member" data-share-owner={data.owner?.userId || ""}>
                    <span className="canvas-share-avatar" aria-hidden="true">{(memberLabel(data.owner).trim().slice(0, 1) || "?").toUpperCase()}</span>
                    <span className="canvas-share-ident">
                      <span className="gov-name">{memberLabel(data.owner) || "—"}</span>
                      <span className="gov-meta">{data.owner?.username ? "@" + data.owner.username : "所有者账号缺失"}</span>
                    </span>
                    <span className="ds-badge ds-badge--sm ds-badge--neutral">所有者</span>
                  </li>
                  {members.map((m) => {
                    const row = memberRowState(m, caps.canChangeRole);
                    const confirming = isRemoveConfirming(remove, String(m.userId));
                    const rowBusy = busy === "role:" + m.userId || busy === "remove:" + m.userId;
                    return (
                      <li key={m.userId} className="gov-row canvas-share-member" data-share-member={m.userId} data-share-member-status={String(m.status || "ACTIVE")} data-share-member-role={m.role}>
                        <span className="canvas-share-avatar" aria-hidden="true">{(memberLabel(m).trim().slice(0, 1) || "?").toUpperCase()}</span>
                        <span className="canvas-share-ident">
                          <span className="gov-name">{memberLabel(m) || "—"}</span>
                        </span>
                        {caps.canChangeRole && !confirming ? (
                          <select
                            className="canvas-share-select"
                            aria-label={(memberLabel(m) || m.userId) + " 的角色"}
                            value={m.role}
                            disabled={row.roleDisabled || rowBusy}
                            data-share-role={m.userId}
                            onChange={(e) => void updateRole(m, e.target.value)}
                          >
                            {SHARE_ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : null}
                        {caps.canRemoveMember ? (
                          confirming ? (
                            <span className="canvas-share-confirm" role="group" aria-label={"确认移除 " + (memberLabel(m) || m.userId)}>
                              <span>移除？</span>
                              <button type="button" className="ds-btn ds-btn--danger ds-btn--sm" data-share-remove-confirm={m.userId} disabled={rowBusy} onClick={() => void confirmRemove(m)}>移除</button>
                              <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-share-remove-cancel={m.userId} disabled={rowBusy} onClick={() => setRemove(nextRemove(remove, { type: "cancel" }))}>取消</button>
                            </span>
                          ) : (
                            <button type="button" className="ds-iconbtn ds-iconbtn--sm ds-iconbtn--ghost canvas-share-remove" aria-label={"移除" + (memberLabel(m) || m.userId) + "的共享"} title="移除" data-share-remove={m.userId} disabled={row.removeDisabled || rowBusy} onClick={() => setRemove(beginRemove(remove, String(m.userId)))}>
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          )
                        ) : null}
                        <span className="canvas-share-sub">
                          {m.username ? "@" + m.username + " · " : ""}
                          <span className={"canvas-share-status" + (row.statusTone === "neutral" ? "" : " is-off")} data-share-status={m.status || "ACTIVE"}>{row.statusLabel}</span>
                          {" · 加入于 " + formatJoinedAt(m.createdAt)}
                        </span>
                        {rowError && rowError.userId === m.userId ? <p className="canvas-share-row-error" role="alert" data-share-row-error={m.userId}>{rowError.message}</p> : null}
                      </li>
                    );
                  })}
                </ul>
                {members.length === 0 ? <p className="canvas-share-empty" data-canvas-share-empty>还没有共享给任何人。被单独共享的人可以打开这本画布。</p> : null}
              </section>
            ) : (
              <section className="canvas-share-section" aria-labelledby={titleId + "-me"}>
                <h3 id={titleId + "-me"} className="canvas-share-section__title">我的角色</h3>
                <div className="gov-row canvas-share-member" data-canvas-share-my-role={sourceRoleLabel(data.access?.source, data.myRole)}>
                  <span className="canvas-share-avatar" aria-hidden="true">我</span>
                  <span className="canvas-share-ident">
                    <span className="gov-name">{sourceRoleLabel(data.access?.source, data.myRole)}</span>
                    <span className="gov-meta">你的访问权限</span>
                  </span>
                </div>
                <p className="canvas-share-hint">只有所有者和被授予「管理共享」的人可以修改共享设置。</p>
              </section>
            )}

            {caps.canAddMember ? (
              <section className="canvas-share-section" aria-labelledby={titleId + "-add"}>
                <h3 id={titleId + "-add"} className="canvas-share-section__title">添加成员</h3>
                {!addOpen ? (
                  <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-share-add onClick={() => setAddOpen(true)}>
                    <UserPlus size={14} aria-hidden="true" /><span className="ds-btn__label">添加成员</span>
                  </button>
                ) : (
                  <div className="canvas-share-add" data-share-add-panel>
                    <div className="canvas-share-add__controls">
                      <label className="ds-field canvas-share-add__search">
                        <span className="visually-hidden">搜索组织成员</span>
                        <span className="ds-field__box">
                          <span className="ds-field__affix" aria-hidden="true"><Search size={14} /></span>
                          <input className="ds-field__input" type="search" placeholder="搜索成员名或账号" aria-label="搜索组织成员" data-share-search value={query} onChange={(e) => setQuery(e.target.value)} />
                        </span>
                      </label>
                      <label className="ds-field canvas-share-add__role">
                        <span className="visually-hidden">添加成员的角色</span>
                        <span className="ds-field__box">
                          <select className="canvas-share-select" aria-label="添加成员的角色" data-share-add-role value={roleDraft} onChange={(e) => setRoleDraft(e.target.value as ShareRole)}>
                            {SHARE_ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </span>
                      </label>
                    </div>
                    {candidateError ? <p className="gov-error" role="alert" data-share-candidate-error>{candidateError}</p> : null}
                    {candidateLoading ? <p className="canvas-share-hint" role="status">正在查找成员…</p> : null}
                    {!candidateLoading && !candidateError && candidates.length === 0 ? (
                      <p className="canvas-share-empty" data-share-candidate-empty>{query ? "没有找到这个成员" : "组织里的成员都已加入"}</p>
                    ) : null}
                    {!candidateLoading && candidates.length > 0 ? (
                      <ul className="canvas-share-candidates" data-share-candidates>
                        {candidates.map((c) => (
                          <li key={c.userId}>
                            <button type="button" className="canvas-share-candidate" data-share-candidate={c.userId} disabled={busy === "add:" + c.userId} onClick={() => void addMember(c)}>
                              <span className="canvas-share-avatar" aria-hidden="true">{(memberLabel(c).trim().slice(0, 1) || "?").toUpperCase()}</span>
                              <span className="canvas-share-ident">
                                <span className="gov-name">{memberLabel(c)}</span>
                                <span className="gov-meta">{c.username ? "@" + c.username : "同组织成员"}</span>
                              </span>
                              <span className="canvas-share-candidate__add">{busy === "add:" + c.userId ? "添加中…" : "添加为" + shareRoleLabel(roleDraft)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" data-share-add-close onClick={() => { setAddOpen(false); setQuery(""); }}>收起</button>
                  </div>
                )}
              </section>
            ) : null}

            {caps.canTransferOwner ? (
              <section className="canvas-share-section canvas-share-transfer" aria-labelledby={titleId + "-transfer"}>
                <h3 id={titleId + "-transfer"} className="canvas-share-section__title">转移所有者</h3>
                <p className="canvas-share-hint">转移后你会变为编辑者，不能再管理共享；只有新所有者可以再次转移。</p>
                {transfer.confirming ? (
                  <div className="canvas-share-confirm" role="group" aria-label="确认转移所有者" data-share-transfer-confirm-group>
                    <span>把所有者转给 {transferTargetLabel}？</span>
                    <button type="button" className="ds-btn ds-btn--danger ds-btn--sm" data-share-transfer-confirm disabled={busy === "transfer"} onClick={() => void confirmTransfer()}>{busy === "transfer" ? "转移中…" : "确认转移"}</button>
                    <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-share-transfer-cancel disabled={busy === "transfer"} onClick={() => { setTransfer(nextTransfer(transfer, { type: "cancel" })); setTransferPick(""); }}>取消</button>
                  </div>
                ) : (
                  <div className="canvas-share-inline">
                    <select className="canvas-share-select canvas-share-transfer__pick" aria-label="新所有者" data-share-transfer-target value={transferPick} onChange={(e) => setTransferPick(e.target.value)}>
                      <option value="">选择新所有者…</option>
                      {targets.map((t) => <option key={t.userId} value={t.userId}>{t.label}</option>)}
                    </select>
                    <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" data-share-transfer-open disabled={!transferPick || !!busy} onClick={() => setTransfer(beginTransfer(transfer, transferPick))}>转移…</button>
                  </div>
                )}
                {!transfer.confirming && transferPick && selectedTransferLabel ? <p className="canvas-share-hint">将转给 {selectedTransferLabel}（需要二次确认）</p> : null}
              </section>
            ) : null}
          </>
        ) : (
          <div className="canvas-share-fatal" role="alert" data-canvas-share-fatal="EMPTY">
            <p className="gov-error">没有读到共享设置</p>
            <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => void load()}>重试</button>
          </div>
        )}
      </div>
    </aside>
  );
}
