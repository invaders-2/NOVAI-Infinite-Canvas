/**
 * 局域网好友 / 聊天的纯函数（T51）：好友码解析、消息合并、未读统计、时间与错误文案。
 * 单独成文件是为了能用 esbuild 直接单测（不 import React / CSS）。
 */

export type LanView = "list" | "chat" | "add" | "me";

export type LanMe = {
  id: string;
  nickname: string;
  avatar: string;
  /** 6 位数字好友 ID（如 483920），聊天/列表里的 "#CODE" 用它；旧版字母码仍可能出现在这里 */
  code: string;
  friend_code: string;
  direct_code?: string;
  lan_ip: string;
  port: string;
  version: string;
};

export type LanFriend = {
  id: string;
  code: string;
  nickname: string;
  avatar: string;
  base_url: string;
  online: boolean;
  last_seen: number;
  unread: number;
  added_by: string;
};

export type LanMessageKind = "text" | "canvas";
export type LanMessageStatus = "sent" | "failed" | "received";
export type LanMessage = {
  id: string;
  kind: LanMessageKind;
  text: string;
  share_url: string;
  canvas_title: string;
  ts: number;
  dir: "in" | "out" | "sys";
  status: LanMessageStatus;
  read: boolean;
};

/** 旧好友码：NOVAI-<局域网IP>:<端口>-<32+ 位口令>（与后端 parse_friend_code 同一套规则） */
const FRIEND_CODE = /^NOVAI-((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})-([A-Za-z0-9_-]{32,})$/;
/** 6 位数字短码（如 483920），也兼容旧版 6 位字母码；允许带 NOVAI- 前缀（用户可能从好友码里抄后半截） */
const SHORT_CODE = /^(?:NOVAI-)?(\d{6}|[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6})$/i;

export type ParsedFriendCode = {
  /** 6 位数字短码（旧版字母码归一成大写）；旧格式没有，为空串 */
  code: string;
  /** 旧格式（ip:port-token）才有，短码为空 */
  ip: string;
  port: number;
  token: string;
  base_url: string;
};

export function parseFriendCode(input: unknown): ParsedFriendCode | null {
  const text = typeof input === "string" ? input.trim().replace(/\s+/g, "") : "";
  if (!text) return null;
  const short = SHORT_CODE.exec(text);
  if (short) return { code: short[1].toUpperCase(), ip: "", port: 0, token: "", base_url: "" };
  const match = FRIEND_CODE.exec(text);
  if (!match) return null;
  const port = Number(match[2]);
  if (!port || port < 1 || port > 65535) return null;
  return { code: "", ip: match[1], port, token: match[3], base_url: "http://" + match[1] + ":" + port };
}

/** 收到的消息并进本地列表：按 id 去重（同一 id 用后到的覆盖），再按时间排序 */
export function mergeLanMessages(current: LanMessage[], incoming: LanMessage[]): LanMessage[] {
  const byId = new Map<string, LanMessage>();
  for (const item of Array.isArray(current) ? current : []) if (item && item.id) byId.set(item.id, item);
  for (const item of Array.isArray(incoming) ? incoming : []) if (item && item.id) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || String(a.id).localeCompare(String(b.id)));
}

/** 好友列表里所有未读之和（入口红点） */
export function unreadTotal(friends: LanFriend[] | null | undefined): number {
  return (Array.isArray(friends) ? friends : []).reduce((n, item) => n + Math.max(0, Number(item?.unread) || 0), 0);
}

/** 在线好友数 */
export function onlineCount(friends: LanFriend[] | null | undefined): number {
  return (Array.isArray(friends) ? friends : []).filter((item) => !!item?.online).length;
}

/** 头像兜底：emoji 直接用，data URL 走 <img>，其余用昵称首字 */
export function avatarText(friend: { nickname?: string; avatar?: string } | null | undefined): string {
  const avatar = String(friend?.avatar || "").trim();
  if (avatar && !avatar.startsWith("data:")) return avatar.slice(0, 8);
  return (String(friend?.nickname || "友").trim()[0] || "友").toUpperCase();
}

export function isDataAvatar(avatar: unknown): boolean {
  return typeof avatar === "string" && avatar.startsWith("data:image/");
}

/** 会话列表里的一行摘要 */
export function messagePreview(message: LanMessage | null | undefined): string {
  if (!message) return "还没有消息";
  if (message.kind === "canvas") return "画布 · " + (message.canvas_title || "未命名画布");
  const text = String(message.text || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 40) : "还没有消息";
}

function pad2(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

function dayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 会话里每条消息的时间：今天 HH:MM / 昨天 HH:MM / 更早 M月D日 */
export function messageTimeLabel(ts: number, now: number = Date.now()): string {
  const value = Number(ts) || 0;
  if (!value) return "";
  const date = new Date(value);
  const today = dayStart(now);
  const hour = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  if (value >= today) return hour;
  if (value >= today - 86400000) return "昨天 " + hour;
  return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + hour;
}

/** 需要插入「日期分隔」时返回标签，否则空串（同一天不重复插） */
export function daySeparator(ts: number, previousTs: number, now: number = Date.now()): string {
  if (!ts) return "";
  if (previousTs && dayStart(previousTs) === dayStart(ts)) return "";
  const date = new Date(ts);
  const today = dayStart(now);
  if (ts >= today) return "今天";
  if (ts >= today - 86400000) return "昨天";
  return (date.getMonth() + 1) + "月" + date.getDate() + "日";
}

/** 好友状态：在线 / 离线（几分钟前在线 / 从未连上） */
export function friendStatusLabel(friend: LanFriend | null | undefined, now: number = Date.now()): string {
  if (!friend) return "";
  const seen = Number(friend.last_seen) || 0;
  if (friend.online) return "在线";
  if (!seen) return "离线";
  const minutes = Math.max(1, Math.round((now - seen) / 60000));
  if (minutes < 60) return "离线 · " + minutes + " 分钟前在线";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return "离线 · " + hours + " 小时前在线";
  return "离线";
}

/** 后端 / 网络错误 → 一句用户能懂的话（不静默、不吞错误） */
export function lanErrorMessage(status: number, detail?: string): string {
  const text = String(detail || "").trim();
  if (status === 0) return "连不上本机的 NOVAI 服务，确认后端还在运行。";
  if (status === 400) return text || "好友码不对，检查后重试。";
  if (status === 403) return "好友凭据无效：让对方删掉你之后重新用好友码加一次。";
  if (status === 404) return text || "好友不存在，可能已经被删除。";
  if (status === 410) return "这条分享已经失效，请对方重新发一张画布。";
  if (status === 502) return text || "对方离线或端口不通，稍后重试。";
  if (status >= 500) return "对方那台 NOVAI 出了点问题，稍后再试。";
  return text || "操作失败，请稍后再试。";
}

/** 从分享链接里取 token（画布卡片只存链接，打开时复用 T49 的只读预览） */
export function shareTokenOf(url: unknown): string {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) return "";
  try {
    const parsed = new URL(text, "http://local");
    const token = parsed.searchParams.get("share") || "";
    return /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : "";
  } catch {
    const match = /[?&]share=([^&#\s]+)/.exec(text);
    return match ? match[1] : "";
  }
}

/**
 * 画布快照里的相对路径（/output/…、/assets/…）在本机页面会指向自己，必须补上分享者的 origin；
 * 分享链接里带了对方的局域网口令时，数据面（/output、/assets、/apps）再拼一次 token，图片才打得开。
 * 纯函数，便于单测；不改快照里的非路径字段。
 */
const MEDIA_PATH = new RegExp("^/(?:output|assets|apps)/");

export function absolutizeSnapshot<T>(snapshot: T, shareUrl: unknown): T {
  const text = typeof shareUrl === "string" ? shareUrl.trim() : "";
  if (!snapshot || !text) return snapshot;
  let origin = "";
  let token = "";
  try {
    const parsed = new URL(text, "http://local");
    origin = parsed.origin === "http://local" ? "" : parsed.origin;
    token = parsed.searchParams.get("token") || "";
  } catch {
    return snapshot;
  }
  if (!origin) return snapshot;
  const fix = (value: string): string => {
    if (!value.startsWith("/") || value.startsWith("//")) return value;
    if (!token || !MEDIA_PATH.test(value)) return origin + value;
    return origin + value + (value.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return fix(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item);
      return out;
    }
    return value;
  };
  return walk(snapshot) as T;
}

/** 本地消息 id：后端只收 [A-Za-z0-9_-]{6,64} */
export function newMessageId(): string {
  return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
