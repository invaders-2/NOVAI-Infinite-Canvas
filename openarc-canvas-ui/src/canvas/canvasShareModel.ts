/**
 * 画布共享面板 · 纯逻辑（面板与宿主刷新共用同一份判定）。
 *
 * 这里只放**可单测**的规则：角色文案/能力矩阵/错误码中文/两步确认状态机/权限签名。
 * UI 组件（CanvasSharePanel.tsx）与 CanvasHost 的轮询刷新都消费这里的函数，
 * 保证"按钮该不该出现"与"服务端会不会拒"用同一套档位定义（三档来自 canvas-domain.cjs）。
 */

export type ShareRole = "VIEWER" | "EDITOR" | "MANAGER";
export type ShareStatus = "ACTIVE" | "DISABLED" | "MISSING";
export type Visibility = "PRIVATE" | "ORGANIZATION";

/** 服务端 canvas/access/get · canvas/shares · canvas/meta 的 access 投影（字段都可缺省）。*/
export type AccessView = {
  canView?: boolean;
  canEdit?: boolean;
  canManage?: boolean;
  canShare?: boolean;
  source?: string | null;
};

export type ShareMember = {
  userId: string;
  displayName?: string | null;
  username?: string | null;
  role: ShareRole;
  grantedBy?: string | null;
  grantedByName?: string | null;
  createdAt?: number;
  at?: number;
  status?: ShareStatus;
};

export type SharesResponse = {
  ok: true;
  canvasId: string;
  visibility: Visibility;
  owner: { userId: string; displayName: string | null; username: string | null; status: string } | null;
  shares: ShareMember[] | null;
  shareCount: number;
  canManage: boolean;
  myRole?: ShareRole | null;
  access?: AccessView;
};

export type Candidate = { userId: string; displayName?: string | null; username?: string | null; status?: string };

export const SHARE_ROLE_OPTIONS: ReadonlyArray<{ value: ShareRole; label: string }> = [
  { value: "VIEWER", label: "查看者" },
  { value: "EDITOR", label: "编辑者" },
  { value: "MANAGER", label: "管理共享" },
];

export const DEFAULT_SHARE_ROLE: ShareRole = "VIEWER";

/** 角色中文名；未知值如实显示（不猜成查看者）。*/
export function shareRoleLabel(role: string | null | undefined): string {
  const key = String(role || "").toUpperCase();
  return SHARE_ROLE_OPTIONS.find((o) => o.value === key)?.label || (key ? key : "—");
}

/** 存取签名的规范化（只用于比较变化，不用于授权）。*/
export function normalizeAccess(access: AccessView | null | undefined): Required<AccessView> {
  return {
    canView: !!access?.canView,
    canEdit: !!access?.canEdit,
    canManage: !!access?.canManage,
    canShare: !!access?.canShare,
    source: String(access?.source || ""),
  };
}

/**
 * 权限事实的稳定签名。宿主轮询每一轮都拿它和上一轮比：
 * 只要 canEdit / canManage / canShare / source（= 显式 share 档位，如 SHARE_EDITOR）里有一项变化，
 * 就说明权限被降级/撤销/转移，必须立刻 pushContext 更新只读闸。
 */
export function accessSignature(access: AccessView | null | undefined): string {
  const a = normalizeAccess(access);
  return [a.canEdit ? "1" : "0", a.canManage ? "1" : "0", a.canShare ? "1" : "0", a.canView ? "1" : "0", a.source].join("|");
}

/** 签名比较：changed=true 时宿主必须把新的 canEdit 推给页面。*/
export function accessChange(previousSignature: string, access: AccessView | null | undefined): { changed: boolean; signature: string } {
  const signature = accessSignature(access);
  return { changed: previousSignature !== signature, signature };
}

/** 轮询/打开失败里代表"权限已经不在"的错误码（不是临时故障，不能当普通错误忽略）。*/
export function isAccessLostError(error: string | null | undefined): boolean {
  const code = String(error || "");
  return code === "READ_ONLY" || code === "NOT_FOUND_OR_FORBIDDEN";
}

/** 来源 → "我的角色"文案（顺序与后端 evaluateCanvasAccess 的 source 一致）。*/
export function sourceRoleLabel(source: string | null | undefined, myRole?: string | null): string {
  switch (String(source || "")) {
    case "OWNER_POLICY": return "所有者";
    case "SUPER_ADMIN": return "超级管理员";
    case "SHARE_MANAGER": return "管理共享";
    case "SHARE_EDITOR": return "编辑者";
    case "SHARE_VIEWER": return "查看者";
    case "ORG_POLICY": return "组织内可查看（只读）";
    default: return shareRoleLabel(myRole || null);
  }
}

/** 右上角入口文案：能管理就叫「共享」，否则显示对方此刻的角色。*/
export function entryLabel(canManage: boolean, source?: string | null): string {
  if (canManage) return "共享";
  if (String(source || "") === "ORG_POLICY") return "组织内可查看";
  if (String(source || "") === "SHARE_EDITOR") return "编辑者";
  if (String(source || "") === "SHARE_VIEWER") return "只读共享";
  return "共享";
}

/** 面板能力矩阵（与服务端 canManage / owner 判定一致；MANAGER 不能转移所有者）。*/
export function panelCapabilities(input: { canManage: boolean; source?: string | null }) {
  const canManage = !!input.canManage;
  const source = String(input.source || "");
  const canTransferOwner = canManage && (source === "OWNER_POLICY" || source === "SUPER_ADMIN");
  return {
    showMemberList: canManage,
    canChangeVisibility: canManage,
    canAddMember: canManage,
    canChangeRole: canManage,
    canRemoveMember: canManage,
    canTransferOwner,
  };
}

/** 成员行状态：按钮/下拉是否可用 + 徽标文案与色调。停用/不存在只能移除，不能改角色。*/
export function memberRowState(member: { status?: ShareStatus | string | null }, canManage: boolean) {
  const status = String(member?.status || "ACTIVE").toUpperCase();
  const roleDisabled = !canManage || status !== "ACTIVE";
  const removeDisabled = !canManage;
  const statusLabel = status === "ACTIVE" ? "正常" : status === "DISABLED" ? "已停用" : "账号不存在";
  const statusTone: "neutral" | "warning" | "danger" = status === "ACTIVE" ? "neutral" : status === "DISABLED" ? "warning" : "danger";
  return { roleDisabled, removeDisabled, statusLabel, statusTone };
}

export function visibilityValue(v: string | null | undefined): Visibility {
  return String(v || "").toUpperCase() === "ORGANIZATION" ? "ORGANIZATION" : "PRIVATE";
}

export function visibilityLabel(v: string | null | undefined): string {
  return visibilityValue(v) === "ORGANIZATION" ? "组织内可见" : "私有";
}

export function visibilityHint(v: string | null | undefined): string {
  return visibilityValue(v) === "ORGANIZATION"
    ? "组织内所有成员都能打开查看，但不能编辑；被单独共享为编辑者的人仍可编辑。"
    : "仅所有者与被单独共享的人可以打开；组织内其他人看不到这本画布。";
}

/**
 * 错误码 → 中文（面板里只显示一句人话，原始错误码留在 data-* 证据面）。
 * detail 是后端明确给出的结构化原因（target-org / target-disabled / READ_ONLY 的 access.source 等）。
 */
export function mapShareError(code: string | null | undefined, detail?: string | null): string {
  const c = String(code || "");
  const d = String(detail || "");
  if (c === "NOT_FOUND_OR_FORBIDDEN") return "这本画布已不可访问（可能已被移出共享）";
  if (c === "NOT_FOUND") return d === "share" ? "这个成员还没有被共享，无法修改角色" : "画布不存在或已被删除";
  if (c === "READ_ONLY") {
    if (d === "owner-changed") return "所有权已被其他操作变更，请重新打开共享面板";
    return "只有所有者和管理共享的人可以修改共享设置";
  }
  if (c === "INVALID_INPUT") {
    if (d === "target") return "找不到这个成员（账号可能已被删除）";
    if (d === "target-disabled") return "该账号已停用，不能共享";
    if (d === "target-org") return "只能共享给同一组织的成员";
    if (d === "owner") return "不能对画布所有者执行这个操作";
    if (d === "role") return "角色不合法（只能是查看者 / 编辑者 / 管理共享）";
    if (d === "visibility") return "可见性取值不合法（只能私有或组织内可见）";
    if (d === "share") return "这个成员还没有被共享，无法修改角色";
    return "提交的内容不合法";
  }
  if (c === "INTERNAL_ERROR") return d === "audit" ? "保存失败：审计未写入，本次操作已回滚" : "保存失败，请重试";
  if (c === "NO_BRIDGE") return "宿主桥不可用（无法读取共享设置）";
  if (c === "CANVAS_COMMAND_NOT_ALLOWED") return "当前版本不支持这条共享命令";
  return c ? "操作失败：" + c : "操作失败";
}

/** 加入时间：本地时区 MM-DD；没有时间戳时如实显示"—"。*/
export function formatJoinedAt(ms: number | null | undefined): string {
  const n = Number(ms || 0);
  if (!n) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return mm + "-" + dd;
}

/** 列表卡片「共享…」消息：只认 kind + 非空 canvasId（token/来源校验仍由宿主消息闸门做）。*/
export function parseShareTargetMessage(data: unknown): string | null {
  const d = data as { kind?: unknown; canvasId?: unknown } | null;
  if (!d || d.kind !== "open-share") return null;
  const id = String(d.canvasId || "").trim().slice(0, 120);
  return id || null;
}

/* ── 两步确认状态机（移除成员 / 转移所有者）────────────────────────────── */

export type RemoveState = { userId: string | null };
export type RemoveAction = { type: "ask"; userId: string } | { type: "cancel" } | { type: "confirm" };

export function beginRemove(state: RemoveState, userId: string): RemoveState {
  return { userId: String(userId || "") || null };
}

export function nextRemove(state: RemoveState, action: RemoveAction): RemoveState {
  if (action.type === "ask") return beginRemove(state, action.userId);
  if (action.type === "cancel") return { userId: null };
  return state; // confirm 本身不改变待确认目标；提交结果由调用方清理
}

export function isRemoveConfirming(state: RemoveState, userId: string): boolean {
  return !!state.userId && state.userId === userId;
}

export type TransferState = { target: string | null; confirming: boolean };
export type TransferAction = { type: "open"; target: string } | { type: "confirm" } | { type: "cancel" } | { type: "done" };

export function beginTransfer(state: TransferState, target: string): TransferState {
  return { target: String(target || "") || null, confirming: true };
}

export function nextTransfer(state: TransferState, action: TransferAction): TransferState {
  if (action.type === "open") return beginTransfer(state, action.target);
  if (action.type === "confirm") return { target: state.target, confirming: true };
  if (action.type === "cancel") return { target: null, confirming: false };
  return { target: null, confirming: false };
}

/** 合并转移候选：已有成员 + 候选人（按 userId 去重，排除 owner）。*/
export function transferTargets(shares: ShareMember[] | null, candidates: Candidate[], ownerUserId: string | null): Array<{ userId: string; label: string }> {
  const out: Array<{ userId: string; label: string }> = [];
  const seen = new Set<string>();
  for (const m of shares || []) {
    const id = String(m.userId || "");
    if (!id || id === ownerUserId || seen.has(id)) continue;
    if (String(m.status || "ACTIVE") !== "ACTIVE") continue;
    seen.add(id);
    out.push({ userId: id, label: m.displayName || m.username || id });
  }
  for (const c of candidates || []) {
    const id = String(c.userId || "");
    if (!id || id === ownerUserId || seen.has(id)) continue;
    seen.add(id);
    out.push({ userId: id, label: c.displayName || c.username || id });
  }
  return out;
}

/** 成员显示名（null 时回落到 @username，再回落到 id —— 只为可读，不伪造身份）。*/
export function memberLabel(m: { displayName?: string | null; username?: string | null; userId?: string } | null | undefined): string {
  if (!m) return "";
  return String(m.displayName || m.username || m.userId || "");
}
