/**
 * 局域网好友 / 聊天（T51）。
 * - 入口全在左侧栏 #lb 底部那颗「我」的头像上：左键进聊天，右键弹账户菜单；LanUnread / LanAvatarFace 给它补红点和局域网头像；
 * - LanChatHost：浮层本体（好友列表 / 会话 / 加好友 / 我的资料 / 画布卡片只读预览），portal 到 body。
 * 在线状态与未读每 5s 轮询，会话内容 4s 轮询；不用 WebSocket。
 * 画布卡片的只读预览直接复用 T49 的 ShareView（内部是 TemplatePreview + 克隆 / 存模板）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";
import { serverDocToDoc } from "../../../novaiBackend";
import { cloneWorkflowForImport, savePersonalTemplate } from "../personalTemplates";
import { uid } from "../model";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { AnimatedSendIcon } from "./AnimatedSendIcon";
import { TemplatePreview } from "./TemplatePreview";
import { previewDocOf, shareErrorMessage } from "./shareDoc";
import { localizeDocMedia, mediaStatsText, type MediaStats } from "./shareMedia";
import { AvatarCrop } from "./AvatarCrop";
import {
  absolutizeSnapshot, avatarText, daySeparator, friendStatusLabel, isDataAvatar, lanErrorMessage, mergeLanMessages,
  messageDeliveryLabel, messageTimeLabel, newMessageId, onlineCount, parseFriendCode, requestPeer, requestPreview, shareTokenOf,
  unreadTotal, type LanFriend, type LanFriendRequest, type LanMe, type LanMessage, type LanMessageKind, type LanView,
} from "./lanDoc";
import {
  appendNotices, clearFriendNotices, noticeMessages, noticePreviewOf, planNoticeFetches, NOTICE_LEAVE, NOTICE_TTL,
  type LanNoticeItem, type LanNoticeMessage, type NoticePollState,
} from "./lanNotice";
import "./lan-chat.css";

type LanRequests = { incoming: LanFriendRequest[]; outgoing: LanFriendRequest[] };

type Snapshot = {
  ready: boolean;
  me: LanMe | null;
  friends: LanFriend[];
  messages: LanMessage[];
  requests: LanRequests;
  open: boolean;
  view: LanView;
  activeId: string;
  previewUrl: string;
  sending: boolean;
  notice: string;
  error: string;
};

const EMPTY: Snapshot = {
  ready: false, me: null, friends: [], messages: [], requests: { incoming: [], outgoing: [] }, open: false, view: "list",
  activeId: "", previewUrl: "", sending: false, notice: "", error: "",
};

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();

function setLan(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const fn of listeners) fn();
}

function subscribeLan(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function useLan(): Snapshot {
  return useSyncExternalStore(subscribeLan, () => snapshot, () => snapshot);
}

/** 浮层里的操作要能 toast；LanChatHost 挂载时把 ctl.store.toast 接进来 */
let notify: (text: string) => void = () => {};
const lastReadAt: Record<string, number> = {};

type ApiResult = { ok: boolean; status: number; data: any; error: string };

async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers || {}) },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, status: response.status, data, error: lanErrorMessage(response.status, data?.detail) };
    }
    return { ok: true, status: response.status, data, error: "" };
  } catch {
    return { ok: false, status: 0, data: null, error: lanErrorMessage(0) };
  }
}

async function loadMe(): Promise<void> {
  const result = await api("/api/lan/me");
  if (result.ok) setLan({ me: result.data?.me || null, ready: true, error: "" });
  else setLan({ ready: true, error: result.error });
}

async function loadFriends(quiet = true): Promise<void> {
  const result = await api("/api/lan/friends");
  // 成功只更新列表：发送失败后紧接着也会刷新好友，不能顺手把报错清掉
  if (result.ok) setLan({ friends: Array.isArray(result.data?.friends) ? result.data.friends : [] });
  else if (!quiet) setLan({ error: result.error });
}

/** 关掉好友请求卡片 = 忽略这一次；30 分钟内同一请求不再弹（列表顶部照样能处理） */
const REQUEST_IGNORE_MS = 30 * 60 * 1000;
const ignoredRequests = new Map<string, number>();

function ignoreRequest(requestId: string): void {
  ignoredRequests.set(requestId, Date.now());
}

function isIgnoredRequest(requestId: string, now = Date.now()): boolean {
  const stamp = ignoredRequests.get(requestId) || 0;
  if (!stamp) return false;
  if (now - stamp < REQUEST_IGNORE_MS) return true;
  ignoredRequests.delete(requestId);
  return false;
}

/** 上一轮看到的状态：只有「pending → accepted/rejected」才提示，刷新页面不会把旧结果再弹一遍 */
const lastRequestStatus = new Map<string, string>();

/** 好友请求轮询：失败静默，绝不往 error 里塞（每 5s 弹一次红字比不提示更糟） */
async function loadRequests(): Promise<void> {
  const result = await api("/api/lan/friend-requests");
  if (!result.ok) return;
  const data = result.data || {};
  const incoming: LanFriendRequest[] = Array.isArray(data.incoming) ? data.incoming : [];
  const outgoing: LanFriendRequest[] = Array.isArray(data.outgoing) ? data.outgoing : [];
  setLan({ requests: { incoming, outgoing } });
  let settled = false;
  for (const request of outgoing) {
    const before = lastRequestStatus.get(request.id);
    lastRequestStatus.set(request.id, request.status);
    if (before !== "pending") continue;
    if (request.status !== "accepted" && request.status !== "rejected") continue;
    const name = String(requestPeer(request)?.nickname || "").trim() || "对方";
    settled = true;
    notify(request.status === "accepted" ? name + " 已同意你的好友请求" : name + " 拒绝了你的好友请求");
  }
  if (settled) void loadFriends(false);
}

/** 同意 / 拒绝本机收到的好友请求；卡片和列表顶部那一行共用 */
async function respondToRequest(request: LanFriendRequest, accept: boolean): Promise<boolean> {
  const result = await api(
    "/api/lan/friend-requests/" + encodeURIComponent(request.id) + (accept ? "/accept" : "/reject"),
    { method: "POST" },
  );
  if (!result.ok) {
    notify(result.error || "操作失败，稍后再试");
    return false;
  }
  ignoreRequest(request.id);
  const name = String(requestPeer(request)?.nickname || "").trim() || "对方";
  notify(accept ? "已添加 " + name + " 为好友" : "已拒绝");
  void loadFriends(false);
  void loadRequests();
  return true;
}

async function loadMessages(friendId: string, after = 0): Promise<void> {
  if (!friendId) return;
  const result = await api("/api/lan/messages?with=" + encodeURIComponent(friendId) + "&after=" + (after || 0));
  if (!result.ok) { setLan({ error: result.error }); return; }
  const incoming: LanMessage[] = Array.isArray(result.data?.messages) ? result.data.messages : [];
  if (!incoming.length) return;
  // 后端把「待补发」的消息送出去后状态会变 sent：给一句提示，别让用户以为还卡着
  const before = new Map(snapshot.messages.map((item) => [item.id, item.status]));
  const recovered = incoming.filter((item) => item.status === "sent" && before.get(item.id) === "pending");
  // 只并消息，不清 error：发送失败后这里紧接着刷新一次，清了用户就看不到报错了。
  // 例外：这条失败的消息已经补发出去，那条红字就过期了，得一起收掉。
  setLan(recovered.length
    ? { messages: mergeLanMessages(snapshot.messages, incoming), error: "" }
    : { messages: mergeLanMessages(snapshot.messages, incoming) });
  if (recovered.length === 1) {
    const text = String(recovered[0].text || "").trim().slice(0, 16);
    notify(recovered[0].kind === "text" && text ? "已补发：" + text : "消息已补发");
  } else if (recovered.length > 1) {
    notify(recovered.length + " 条消息已补发");
  }
}

async function markRead(friendId: string): Promise<void> {
  if (!friendId) return;
  const stamp = Date.now();
  if (stamp - (lastReadAt[friendId] || 0) < 2000) return;
  lastReadAt[friendId] = stamp;
  const result = await api("/api/lan/messages/read", { method: "POST", body: JSON.stringify({ friend_id: friendId }) });
  if (result.ok) {
    setLan({ friends: snapshot.friends.map((f) => (f.id === friendId ? { ...f, unread: 0 } : f)) });
  }
}

function openChat(friendId: string) {
  setLan({ open: true, view: "chat", activeId: friendId, messages: [], error: "", notice: "" });
  void loadMessages(friendId);
  void markRead(friendId);
}

function togglePanel() {
  const next = !snapshot.open;
  setLan({ open: next, view: snapshot.view === "chat" && !snapshot.activeId ? "list" : snapshot.view, error: "" });
  if (next) { void loadMe(); void loadFriends(false); }
}

/**
 * 独立「聊天」入口：有好友直接进最近的会话（优先有未读的），没有好友就停在列表空态。
 * 好友列表没有「最后一条消息时间」，只能拿 last_seen 近似「最近联系」，够用。
 */
export async function openChatEntry(): Promise<void> {
  const reset = { open: true, view: "list" as LanView, activeId: "", messages: [], error: "", notice: "" };
  if (!snapshot.ready) {
    setLan(reset);
    await Promise.all([loadMe(), loadFriends(false)]);
  }
  const friends = snapshot.friends;
  if (!friends.length) { setLan(reset); return; }
  const recent = [...friends].sort((a, b) => (Number(b.last_seen) || 0) - (Number(a.last_seen) || 0));
  const target = recent.find((friend) => Number(friend.unread) > 0) || recent[0];
  if (snapshot.open && snapshot.view === "chat" && snapshot.activeId === target.id) return;
  openChat(target.id);
}

/** 左侧栏头像左键：先到好友列表，点某个好友才进会话（openChatEntry 保留「直接进最近会话」的老语义） */
export async function openFriendList(): Promise<void> {
  setLan({ open: true, view: "list", activeId: "", messages: [], error: "", notice: "" });
  void loadRequests();
  await Promise.all([loadMe(), loadFriends(false)]);
}

type SendInput = {
  text?: string;
  kind?: LanMessageKind;
  share_url?: string;
  canvas_title?: string;
  message_id?: string;
  media_url?: string;
  media_name?: string;
  media_size?: number;
};

async function sendToFriend(friendId: string, input: SendInput): Promise<ApiResult> {
  if (!friendId) return { ok: false, status: 0, data: null, error: "好友不存在，可能已经被删除" };
  setLan({ sending: true, error: "" });
  const result = await api("/api/lan/friends/" + encodeURIComponent(friendId) + "/send", {
    method: "POST",
    body: JSON.stringify({
      text: input.text || "",
      kind: input.kind || "text",
      share_url: input.share_url || "",
      canvas_title: input.canvas_title || "",
      media_url: input.media_url || "",
      media_name: input.media_name || "",
      media_size: input.media_size || 0,
      message_id: input.message_id || newMessageId(),
    }),
  });
  const message = result.ok ? (result.data?.message as LanMessage | undefined) : undefined;
  if (message) {
    setLan({ messages: mergeLanMessages(snapshot.messages, [message]), sending: false, error: "" });
  } else {
    setLan({ sending: false, error: result.error });
    notify(result.error);
    // 502 时后端已经把这条存成「待重发」，重新拉一次让它出现在会话里
    await loadMessages(friendId);
  }
  void loadFriends();
  return result;
}

/* ---------------------------------------------------------------- 图片 / 视频 */

/** 后端单文件上限 200MB，超出直接拦在本地，省一次白跑 */
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

type LanMedia = { id: string; url: string; name: string; size: number; mime: string; kind: "image" | "video" };

function mediaKindOf(file: File): "image" | "video" | "" {
  const type = String(file.type || "");
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "";
}

/** 粘贴 / 拖拽过来的文件：优先 items（拖拽时 files 常是空的） */
function mediaFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && mediaKindOf(file)) files.push(file);
  }
  if (files.length) return files;
  return Array.from(data.files || []).filter((file) => !!mediaKindOf(file));
}

/** 上传到本机后端，拿到局域网可访问的绝对地址；失败给一句中文原因 */
async function uploadMedia(file: File): Promise<{ media?: LanMedia; error: string }> {
  const form = new FormData();
  form.append("file", file, file.name || "media");
  try {
    const response = await fetch("/api/lan/media", { method: "POST", body: form });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 413) return { error: "文件太大（上限 200MB）" };
      return { error: lanErrorMessage(response.status, String(data?.detail || "")) };
    }
    const media = data?.media as LanMedia | undefined;
    if (!media?.url) return { error: "上传失败，请重试" };
    return { media, error: "" };
  } catch {
    return { error: lanErrorMessage(0) };
  }
}

/* ---------------------------------------------------------------- 画布卡片只读预览 */

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; doc: CanvasDoc; snapshot: any };

/**
 * 好友发来的画布卡片：快照由本机后端代取（跨域 + 对方局域网口令都在服务端解决），
 * 渲染复用 T49 的 TemplatePreview（拖动平移 / 滚轮缩放 / 点节点看详情），
 * 右上角按分享权限给「保存为模板」「克隆到画布」。
 */
function LanCanvasPreview({ url, onClose, onCloneDoc }: {
  url: string;
  onClose: () => void;
  onCloneDoc: (doc: CanvasDoc, stats: MediaStats) => { nodes: number; edges: number } | null;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "clone" | "template">("");

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    fetch("/api/lan/share-preview?url=" + encodeURIComponent(url), { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!alive) return;
        if (!response.ok) {
          setState({ kind: "error", message: shareErrorMessage(response.status, String(data?.detail || "")) });
          return;
        }
        const snapshot = absolutizeSnapshot(data?.snapshot, url);
        const converted = serverDocToDoc({
          nodes: snapshot?.canvas?.nodes || [],
          connections: snapshot?.canvas?.connections || [],
          settings: snapshot?.canvas?.settings,
        }).doc;
        if (!converted) {
          setState({ kind: "error", message: "这张画布没有可预览的内容。" });
          return;
        }
        setState({ kind: "ready", doc: converted, snapshot });
      })
      .catch(() => { if (alive) setState({ kind: "error", message: shareErrorMessage(0) }); });
    return () => { alive = false; };
  }, [url]);

  const preview = useMemo(() => (state.kind === "ready" ? previewDocOf(state.doc) : { nodes: [], edges: [] }), [state]);
  const snapshot = state.kind === "ready" ? state.snapshot : null;
  const canClone = !!(snapshot?.can_clone ?? snapshot?.share?.can_clone);
  const canSaveTemplate = !!(snapshot?.can_save_template ?? snapshot?.share?.can_save_template);
  const title = snapshot?.title || snapshot?.canvas?.title || "共享画布";
  const ownerName = snapshot?.share?.owner_name || "好友";
  const permission = String(snapshot?.share?.permission || "view");

  const clone = async () => {
    if (state.kind !== "ready" || busy) return;
    setBusy("clone");
    setNote("");
    // 克隆前把好友机器上的媒体取到本机，之后好友关机也能看
    const localized = await localizeDocMedia(state.doc, url);
    const made = onCloneDoc(localized.doc, { copied: localized.copied, failed: localized.failed, skipped: localized.skipped });
    setBusy("");
    if (!made) { setNote("克隆失败：这张画布没有可用的节点"); return; }
    const media = mediaStatsText(localized);
    setNote("已克隆 " + made.nodes + " 个节点、" + made.edges + " 条连线" + (media ? "，" + media : ""));
    onClose();
  };

  const saveTemplate = async () => {
    if (state.kind !== "ready" || busy) return;
    setBusy("template");
    setNote("");
    const localized = await localizeDocMedia(state.doc, url);
    const result = await savePersonalTemplate({ title: title + " 模板", prompt: "", doc: localized.doc });
    setBusy("");
    if (!result.ok) { setNote("保存模板失败：" + (result.error || "未知错误")); return; }
    const media = mediaStatsText(localized);
    setNote("已保存到「我的模板」" + (media ? "，" + media : ""));
  };

  if (state.kind === "loading") {
    return <div className="novai-canvas-error"><h2>正在打开画布…</h2><p style={{ color: "#6e6e73", fontSize: 13 }}>从好友的电脑读取只读快照</p></div>;
  }
  if (state.kind === "error") {
    return <div className="novai-canvas-error" data-lan-preview-error>
      <h2>画布打不开</h2>
      <p style={{ maxWidth: 420, lineHeight: 1.7, fontSize: 13, color: "#6e6e73" }}>{state.message}</p>
      <button type="button" onClick={onClose}>关闭</button>
    </div>;
  }
  return <TemplatePreview
    entry={{ id: "lan-" + state.doc.nodes.length, name: title, doc: preview }}
    onClose={onClose}
    note={note || ("只读分享 · 来自 " + ownerName)}
    busy={!!busy}
    actions={<>
      <span className="tplpv-chip" data-share-permission={permission}>{permission === "template" ? "可存为模板" : permission === "clone" ? "可克隆到画布" : "仅查看"}</span>
      {canSaveTemplate ? <button type="button" className="tplpv-btn" data-share-template disabled={!!busy} onClick={() => void saveTemplate()}>{busy === "template" ? "保存中…" : "保存为模板"}</button> : null}
      {canClone ? <button type="button" className="tplpv-btn pri" data-share-clone disabled={!!busy} onClick={() => clone()}>{busy === "clone" ? "克隆中…" : "克隆到画布"}</button> : null}
    </>}
  />;
}

/* ---------------------------------------------------------------- 入口按钮 */

const unreadDot = (unread: number) => unread
  ? <span className="lan-dot" data-lan-dot>{unread > 99 ? "99+" : unread}</span>
  : null;

/** 单独一颗未读红点：给 #lb 的头像这类已经有自己的点击行为的按钮复用 */
export function LanUnread() {
  const snap = useLan();
  return unreadDot(unreadTotal(snap.friends));
}

export function LanButton() {
  const snap = useLan();
  const unread = unreadTotal(snap.friends);
  const online = onlineCount(snap.friends);
  const tip = snap.friends.length
    ? "好友 · " + online + "/" + snap.friends.length + " 在线" + (unread ? " · " + unread + " 条未读" : "")
    : "好友 · 局域网加好友聊天";
  return <button id="lanBtn" className={"ib tipR" + (snap.open ? " on" : "")} data-tip={tip} aria-label="好友" data-lan-unread={unread || undefined} onClick={togglePanel}>
    <Icon name="user" />
    {unreadDot(unread)}
  </button>;
}

export function ChatButton() {
  const snap = useLan();
  const unread = unreadTotal(snap.friends);
  const tip = unread ? "聊天 · " + unread + " 条未读" : "聊天";
  return <button id="chatBtn" className={"ib tipR" + (snap.open ? " on" : "")} data-tip={tip} aria-label="聊天" data-lan-unread={unread || undefined} onClick={() => void openChatEntry()}>
    <Icon name="msg" />
    {unreadDot(unread)}
  </button>;
}

/* ---------------------------------------------------------------- 局域网身份 */

const IDENTITY_FALLBACK = { nickname: "本机用户", avatar: "" };

/** 画布别处（账户菜单）显示自己的昵称 / 头像，统一走 /api/lan/me 这份数据 */
export function useLanMe(): LanMe | null {
  const snap = useLan();
  useEffect(() => { if (!snap.ready) void loadMe(); }, [snap.ready]);
  return snap.me;
}

/** 打开「我的资料」（账户菜单顶部那行点进来） */
export function openMyProfile(): void {
  setLan({ open: true, view: "me", error: "", notice: "" });
  if (!snapshot.me) void loadMe();
  void loadFriends(false);
}

/** 账户菜单顶部的身份行：emoji / data 头像 + 昵称，整行就是「我的资料」入口 */
export function LanIdentity({ role, onOpen }: { role?: string; onOpen: () => void }) {
  const me = useLanMe();
  const person = me || IDENTITY_FALLBACK;
  return (
    <button className="mi lan-id" data-lan-identity onClick={onOpen}>
      <span className="lan-avatar lan-id-av">{isDataAvatar(person.avatar) ? <img src={person.avatar} alt="" /> : avatarText(person)}</span>
      <span className="lan-id-name">{person.nickname || "本机用户"}</span>
      {role ? <span className="lan-id-role">{role}</span> : null}
      <span className="k">我的资料</span>
    </button>
  );
}

/** 左侧栏「我」的头像：data: 走 <img>，emoji 直接显示，都没有就昵称首字，再兜底「我」 */
export function LanAvatarFace() {
  const me = useLanMe();
  if (isDataAvatar(me?.avatar)) return <img className="lan-face" src={String(me?.avatar)} alt="" />;
  const text = String(me?.avatar || "").trim().slice(0, 8) || String(me?.nickname || "").trim()[0] || "我";
  return <>{text}</>;
}

/** 原图留在内存里：本次会话内「重新裁切」直接复用这张 HTMLImageElement，不再读文件 */
function decodeAvatarSource(file: File) {
  return new Promise<{ image: HTMLImageElement; url: string }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("读取图片失败")); };
    image.src = url;
  });
}

/* ---------------------------------------------------------------- 浮层 */

export function LanChatHost() {
  const ctl = useCtl();
  const theme = useS((s) => s.ui.theme);
  const snap = useLan();
  const [name, setName] = useState("");
  const [avatarDraft, setAvatarDraft] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const avatarFileRef = useRef<HTMLInputElement | null>(null);
  const mediaFileRef = useRef<HTMLInputElement | null>(null);
  /** 加载失败的图片 / 视频按消息 id 记住，占位文案顶上去（不画边框） */
  const [brokenMedia, setBrokenMedia] = useState<Record<string, boolean>>({});
  /** 正拖着文件进会话区：只改底色提示，不加描边 */
  const [dropActive, setDropActive] = useState(false);
  /** 列表顶部请求行正在同意 / 拒绝的 request.id */
  const [requestBusy, setRequestBusy] = useState("");
  /** 本次会话内上传过的原图；确认裁切后才留，用于「重新裁切」 */
  const [avatarSource, setAvatarSource] = useState<{ image: HTMLImageElement; url: string } | null>(null);
  /** 裁切中：fresh 表示这次新选的文件，取消时要把它的 objectURL 一起丢掉 */
  const [crop, setCrop] = useState<{ image: HTMLImageElement; url: string; fresh: boolean } | null>(null);
  /** 贴着 #avatar 的内联定位；量不到头像或窄屏时为 null，交回 CSS 默认值 */
  const [panelBox, setPanelBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const dropObjectUrl = (source: { url: string } | null) => {
    if (!source) return;
    try { URL.revokeObjectURL(source.url); } catch { /* 已经释放 */ }
  };

  const cancelCrop = () => {
    if (crop?.fresh) dropObjectUrl(crop);
    setCrop(null);
  };

  const confirmCrop = (dataUrl: string) => {
    if (!crop) return;
    if (crop.fresh) {
      dropObjectUrl(avatarSource);
      setAvatarSource({ image: crop.image, url: crop.url });
    }
    setAvatarDraft(dataUrl);
    setCrop(null);
  };

  const recrop = () => {
    if (!avatarSource) return;
    setCrop({ image: avatarSource.image, url: avatarSource.url, fresh: false });
  };

  const removeAvatar = () => {
    dropObjectUrl(avatarSource);
    setAvatarSource(null);
    setAvatarDraft("");
  };

  // 关掉浮层就丢掉内存里的原图：下次再打开不再显示「重新裁切」
  useEffect(() => {
    if (snap.open) return;
    if (crop?.fresh) dropObjectUrl(crop);
    setCrop(null);
    dropObjectUrl(avatarSource);
    setAvatarSource(null);
  }, [snap.open]);

  useEffect(() => { notify = (text: string) => ctl.store.toast(text); }, [ctl]);

  // 面板贴着头像打开：量 #avatar 的 getBoundingClientRect 算 left / top / max-height。
  // 头像在 #lb 里是垂直居中的，窗口高度一变它就动，所以 resize 要重新量。
  // ≤720px 时清掉内联值，让媒体查询的全宽贴顶规则生效。
  useLayoutEffect(() => {
    if (!snap.open) { setPanelBox(null); return; }
    const place = () => {
      const avatar = document.getElementById("avatar");
      if (!avatar || window.innerWidth <= 720) { setPanelBox(null); return; }
      const rect = avatar.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 12;
      const cap = Math.min(660, vh - margin * 2);
      const minHeight = Math.min(160, cap);
      let left = rect.right + 12;
      if (left + 364 > vw - margin) left = vw - margin - 364;
      let top = rect.top;
      if (top + minHeight > vh - margin) top = vh - margin - minHeight;
      left = Math.max(margin, Math.round(left));
      top = Math.max(margin, Math.round(top));
      setPanelBox({ left, top, maxHeight: Math.floor(Math.min(cap, vh - margin - top)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [snap.open]);

  // 我的资料：每次打开浮层同步一次（昵称/头像可能被另一台机器或另一个页面改过）
  // 好友与好友请求同频 5s 轮询；请求失败静默（loadRequests 内部吞掉）
  useEffect(() => {
    void loadMe();
    void loadFriends(false);
    void loadRequests();
    // 窗口 / 画布 iframe 不可见时跳过（原来最小化了也每 5s 打两个接口），重新可见时立刻补一次
    const poll = () => { if (document.hidden) return; void loadFriends(); void loadRequests(); };
    const timer = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, []);

  // 首页（外壳 iframe）点头像菜单里的好友时发 novai:lan-open 过来：合法 friendId 直接进那个会话，否则走默认入口
  useEffect(() => {
    let lastAt = 0;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; friendId?: string } | null;
      if (!data || data.type !== "novai:lan-open") return;
      const now = Date.now();
      if (now - lastAt < 300) return;
      lastAt = now;
      const friendId = String(data.friendId || "").trim();
      if (/^[A-Za-z0-9_-]{1,64}$/.test(friendId)) openChat(friendId);
      else void openChatEntry();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!snap.me) return;
    setName(snap.me.nickname);
    setAvatarDraft(snap.me.avatar);
  }, [snap.me?.nickname, snap.me?.avatar]);

  // 会话：4s 轮询；打开时把 incoming 标已读
  useEffect(() => {
    if (!snap.open || snap.view !== "chat" || !snap.activeId) return;
    const friendId = snap.activeId;
    const tick = async () => {
      await loadMessages(friendId);
      if (snapshot.messages.some((item) => item.dir === "in" && !item.read)) await markRead(friendId);
    };
    void tick();
    const timer = setInterval(() => { if (!document.hidden) void tick(); }, 4000);
    return () => clearInterval(timer);
  }, [snap.open, snap.view, snap.activeId]);

  // 新消息进来（含自己发的）滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.messages.length, snap.view, snap.activeId]);

  useEffect(() => {
    if (!snap.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (crop) { cancelCrop(); return; }
      if (snap.previewUrl) { setLan({ previewUrl: "" }); return; }
      setLan({ open: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [snap.open, snap.previewUrl, crop]);

  const active = snap.friends.find((f) => f.id === snap.activeId) || null;
  const pendingIncoming = snap.requests.incoming.filter((request) => request.status === "pending");
  const pendingOutgoing = snap.requests.outgoing.filter((request) => request.status === "pending");

  const submitText = async () => {
    const text = draft.trim();
    if (!text || !snap.activeId || snap.sending) return;
    setDraft("");
    const result = await sendToFriend(snap.activeId, { text, message_id: newMessageId() });
    // 502 说明后端已经把消息存成「待补发」，塞回输入框会让用户再发一条重复的
    if (!result.ok && result.status !== 502) setDraft(text);
    composerRef.current?.focus();
  };

  const markBroken = (messageId: string) => {
    setBrokenMedia((prev) => (prev[messageId] ? prev : { ...prev, [messageId]: true }));
  };

  /** 选文件 / 粘贴 / 拖拽都走这里：先传本机后端拿局域网地址，再按 image|video 发出去 */
  const sendMediaFiles = async (files: File[]) => {
    const friendId = snap.activeId;
    if (!friendId || snap.sending) return;
    const usable = files.filter((file) => !!mediaKindOf(file));
    if (!usable.length) { notify("只能发图片或视频"); return; }
    setLan({ sending: true, error: "" });
    for (const file of usable) {
      const kind = mediaKindOf(file);
      if (!kind) continue;
      if (file.size > MEDIA_MAX_BYTES) {
        setLan({ sending: false, error: "文件太大（上限 200MB）" });
        notify("文件太大（上限 200MB）");
        return;
      }
      const uploaded = await uploadMedia(file);
      if (!uploaded.media) {
        setLan({ sending: false, error: uploaded.error });
        notify(uploaded.error);
        return;
      }
      await sendToFriend(friendId, {
        kind,
        media_url: uploaded.media.url,
        media_name: uploaded.media.name,
        media_size: uploaded.media.size,
        message_id: newMessageId(),
      });
    }
    setLan({ sending: false });
  };

  const respondFromList = async (request: LanFriendRequest, accept: boolean) => {
    setRequestBusy(request.id);
    await respondToRequest(request, accept);
    setRequestBusy("");
  };

  const sendCanvas = async () => {
    if (!snap.activeId || snap.sending) return;
    const canvasId = String(ctl.store.state.canvasId || "");
    if (!canvasId) { notify("当前没有打开的画布，先打开一张再发"); return; }
    setLan({ sending: true, error: "" });
    const result = await api("/api/canvas-share", {
      method: "POST",
      body: JSON.stringify({ canvas_id: canvasId, permission: "template", expires_in_days: 7, owner_name: snap.me?.nickname || "本机用户" }),
    });
    const share = result.data?.share || null;
    if (!result.ok || !share?.url) {
      setLan({ sending: false, error: result.error || "生成画布分享链接失败" });
      notify(result.error || "生成画布分享链接失败");
      return;
    }
    await sendToFriend(snap.activeId, {
      kind: "canvas",
      share_url: String(share.url),
      canvas_title: String(ctl.store.state.name || share.title || "当前画布"),
      message_id: newMessageId(),
    });
  };

  const addFriend = async () => {
    const parsed = parseFriendCode(codeDraft);
    if (!parsed) { setLan({ error: "好友码格式不对：应为 6 位数字 ID（如 483920），或旧的 NOVAI-IP:端口-口令" }); return; }
    setLan({ sending: true, error: "", notice: "" });
    const result = await api("/api/lan/friends", { method: "POST", body: JSON.stringify({ code: codeDraft.trim() }) });
    if (!result.ok) { setLan({ sending: false, error: result.error }); return; }
    // 新版本对方在线时只是「投递了请求」（pending），旧版本才直接成为好友
    const friend = result.data?.friend as LanFriend | undefined;
    const pending = !!result.data?.pending;
    const peerName = String(requestPeer(result.data?.request as LanFriendRequest)?.nickname || "").trim();
    await loadFriends(false);
    void loadRequests();
    setLan({ sending: false, error: "", notice: "" });
    setCodeDraft("");
    if (friend?.id) {
      notify("已加为好友：" + (friend.nickname || "对方"));
      openChat(friend.id);
      return;
    }
    setLan({ view: "list" });
    if (pending) notify("已向 " + (peerName || "对方") + " 发送好友请求，等对方同意");
  };

  const saveMe = async () => {
    const nickname = name.trim();
    if (!nickname) { setLan({ error: "昵称不能为空" }); return; }
    const result = await api("/api/lan/me", { method: "PUT", body: JSON.stringify({ nickname, avatar: avatarDraft }) });
    if (!result.ok) { setLan({ error: result.error }); return; }
    setLan({ me: result.data?.me || snapshot.me, error: "", notice: "已保存昵称和头像" });
    notify("已保存昵称和头像");
    // 画布内改名：问候语挂在 main.tsx 的昵称状态上，广播给它立刻重拉（外壳改名走 postMessage 的 novai:profile）
    window.dispatchEvent(new Event("novai:profile-local"));
    void loadFriends();
  };

  /** 头像选图：先读进内存进入裁切态，确认后才落地（导出与压缩交给 AvatarCrop） */
  const pickAvatar = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { notify("只能选图片文件"); return; }
    setAvatarBusy(true);
    try {
      const source = await decodeAvatarSource(file);
      if (crop?.fresh) dropObjectUrl(crop);
      setCrop({ image: source.image, url: source.url, fresh: true });
    } catch {
      notify("读取图片失败，换一张试试");
    } finally {
      setAvatarBusy(false);
    }
  };

  const copyValue = async (text: string, okText: string, fallbackSelector = "") => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notify(okText);
    } catch {
      const input = fallbackSelector ? document.querySelector<HTMLInputElement>(fallbackSelector) : null;
      if (input) { input.focus(); input.select(); try { document.execCommand("copy"); notify(okText); } catch { notify("复制失败，请手动选中复制"); } }
      else notify("复制失败，请手动选中复制");
    }
  };

  const copyCode = () => void copyValue(snap.me?.friend_code || "", "6 位数字好友码已复制，发给对方即可加你", "[data-lan-code]");
  const copyDirectCode = () => void copyValue(snap.me?.direct_code || "", "直连好友码已复制，发给对方粘贴即可", "[data-lan-direct-code]");
  const copyId = () => void copyValue(snap.me?.code || "", "我的 ID 已复制");

  const removeFriend = async (friend: LanFriend) => {
    const result = await api("/api/lan/friends/" + encodeURIComponent(friend.id), { method: "DELETE" });
    if (!result.ok) { setLan({ error: result.error }); return; }
    setLan({ view: "list", activeId: "", messages: [], error: "" });
    await loadFriends(false);
    notify("已删除好友：" + friend.nickname);
  };

  const retry = async (message: LanMessage) => {
    if (!snap.activeId) return;
    await sendToFriend(snap.activeId, {
      text: message.text,
      kind: message.kind,
      share_url: message.share_url,
      canvas_title: message.canvas_title,
      media_url: message.media_url,
      media_name: message.media_name,
      media_size: message.media_size,
      message_id: message.id,
    });
  };

  const cloneToCanvas = (doc: CanvasDoc, stats: MediaStats): { nodes: number; edges: number } | null => {
    try {
      const made = cloneWorkflowForImport(doc, ctl.center(), uid);
      if (!made.nodes.length) return null;
      ctl.store.addNodes(made.nodes, made.edges, { select: true, history: true });
      ctl.fitTo(made.nodes, 120, 1);
      const media = mediaStatsText(stats);
      notify("已克隆 " + made.nodes.length + " 个节点、" + made.edges.length + " 条连线到当前画布" + (media ? "，" + media : ""));
      return { nodes: made.nodes.length, edges: made.edges.length };
    } catch {
      return null;
    }
  };

  if (!snap.open && !snap.previewUrl) return null;

  const friendRow = (friend: LanFriend) => (
    <button key={friend.id} className={"lan-friend" + (friend.online ? " on" : "")} data-lan-friend={friend.id} onClick={() => openChat(friend.id)}>
      <span className="lan-avw" data-online={friend.online ? "1" : undefined}>
        <span className="lan-avatar">
          {isDataAvatar(friend.avatar) ? <img src={friend.avatar} alt="" /> : avatarText(friend)}
        </span>
        {friend.online ? <span className="lan-online-dot" /> : null}
      </span>
      <span className="lan-friend-main">
        <span className="lan-friend-name">{friend.nickname}</span>
        <span className="lan-friend-status">
          {friend.code ? <span className="lan-friend-code">#{friend.code}</span> : null}
          <span className="lan-friend-sub">{friendStatusLabel(friend)}</span>
        </span>
      </span>
      {friend.unread ? <span className="lan-unread">{friend.unread > 99 ? "99+" : friend.unread}</span> : null}
    </button>
  );

  return createPortal(
    <div className="cn-root lan-root" data-theme={theme}>
      {snap.open ? (
        <div id="lanPanel" className="lan-panel" data-lan-panel onKeyDown={(e) => e.stopPropagation()}
          style={panelBox ? { left: panelBox.left, top: panelBox.top, bottom: "auto", maxHeight: panelBox.maxHeight } : undefined}>
          <div className="lan-head">
            {snap.view === "chat" ? (
              <button className="lan-ib" aria-label="返回好友列表" data-lan-back onClick={() => setLan({ view: "list", activeId: "", messages: [], error: "" })}><Icon name="back" size="s" /></button>
            ) : <span className="lan-head-ic"><Icon name="user" size="s" /></span>}
            <span className="lan-title">
              {snap.view === "chat" ? (active?.nickname || "好友")
                : snap.view === "add" ? "加好友"
                  : snap.view === "me" ? "我的资料"
                    : "好友"}
              {snap.view === "chat" ? <small className={active?.online ? "on" : ""}>{active?.code ? "#" + active.code + " · " : ""}{friendStatusLabel(active)}</small>
                : snap.view === "list" ? <small>{"局域网 · " + onlineCount(snap.friends) + "/" + snap.friends.length + " 在线"}</small> : null}
            </span>
            {snap.view === "chat" ? (
              <button className="lan-ib" aria-label="删除好友" data-lan-remove onClick={() => { if (active) void removeFriend(active); }}><Icon name="trash" size="s" /></button>
            ) : null}
            {snap.view === "list" ? (
              <>
                <button className="lan-ib" aria-label="加好友" data-lan-add-open onClick={() => setLan({ view: "add", error: "", notice: "" })}><Icon name="plus" size="s" /></button>
                <button className="lan-ib" aria-label="我的资料" data-lan-me-open onClick={() => setLan({ view: "me", error: "", notice: "" })}><Icon name="settings" size="s" /></button>
              </>
            ) : null}
            <button className="lan-ib" aria-label="关闭" data-lan-close onClick={() => setLan({ open: false })}><Icon name="x" size="s" /></button>
          </div>

          {snap.error ? <div className="lan-err" role="alert" data-lan-error>{snap.error}</div> : null}
          {snap.notice ? <div className="lan-note" data-lan-notice>{snap.notice}</div> : null}

          {snap.view === "list" ? (
            <div className="lan-body" data-lan-view="list">
              {pendingIncoming.length || pendingOutgoing.length ? (
                <div className="lan-reqs" data-lan-request-rows>
                  {pendingIncoming.map((request) => {
                    const peer = requestPeer(request);
                    return (
                      <div className="lan-req-row" key={request.id} data-lan-request-row={request.id}>
                        <span className="lan-avatar lan-req-row-av">{isDataAvatar(peer?.avatar) ? <img src={String(peer?.avatar || "")} alt="" /> : avatarText(peer)}</span>
                        <span className="lan-req-row-text">{requestPreview(request)}</span>
                        <button className="lan-req-btn ghost" data-lan-request-reject-row={request.id} disabled={requestBusy === request.id} onClick={() => void respondFromList(request, false)}>拒绝</button>
                        <button className="lan-req-btn" data-lan-request-accept-row={request.id} disabled={requestBusy === request.id} onClick={() => void respondFromList(request, true)}>同意</button>
                      </div>
                    );
                  })}
                  {pendingOutgoing.map((request) => (
                    <div className="lan-req-row wait" key={request.id} data-lan-request-wait={request.id}>
                      <span className="lan-req-row-text">{requestPreview(request)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {snap.friends.length ? snap.friends.map(friendRow) : (
                <div className="lan-empty">
                  <span className="lan-empty-ic"><Icon name="user" /></span>
                  <b>还没有好友</b>
                  <span>和对方各自打开 NOVAI，交换 6 位数字好友 ID 就能聊天、发画布。</span>
                  <button className="lan-btn pri" onClick={() => setLan({ view: "add" })}>用好友码加好友</button>
                </div>
              )}
            </div>
          ) : null}

          {snap.view === "chat" ? (
            <>
              <div className="lan-list" ref={listRef} data-lan-view="chat" data-lan-messages data-drop={dropActive ? "1" : undefined}
                onDragOver={(e) => {
                  if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (!dropActive) setDropActive(true);
                }}
                onDragLeave={() => setDropActive(false)}
                onDrop={(e) => {
                  const files = mediaFilesOf(e.dataTransfer);
                  if (!files.length) return;
                  e.preventDefault();
                  setDropActive(false);
                  void sendMediaFiles(files);
                }}>
                {snap.messages.length ? snap.messages.map((message, index) => {
                  const previous = index > 0 ? snap.messages[index - 1] : null;
                  const day = daySeparator(message.ts, previous?.ts || 0);
                  return (
                    <div key={message.id}>
                      {day ? <div className="lan-day">{day}</div> : null}
                      {message.dir === "sys" ? (
                        <div className="lan-sys" data-lan-msg={message.id} data-dir="sys">{message.text}</div>
                      ) : (
                      <div className={"lan-msg" + (message.dir === "out" ? " me" : "")} data-lan-msg={message.id} data-dir={message.dir}>
                        {message.kind === "canvas" ? (
                          <button className="lan-card" data-lan-card disabled={!shareTokenOf(message.share_url)}
                            onClick={() => {
                              if (!shareTokenOf(message.share_url)) { setLan({ error: "这条画布消息的链接已经失效" }); return; }
                              setLan({ previewUrl: message.share_url, open: false });
                            }}>
                            <span className="lan-card-ic"><Icon name="layout" size="s" /></span>
                            <span className="lan-card-txt">
                              <b>{message.canvas_title || "共享画布"}</b>
                              <small>{shareTokenOf(message.share_url) ? "点开只读预览 · 可克隆到画布" : "链接已失效"}</small>
                            </span>
                          </button>
                        ) : message.kind === "image" || message.kind === "video" ? (
                          <div className={"lan-media-wrap" + (message.dir === "out" ? " me" : "")} data-lan-media={message.id}>
                            {message.kind === "video"
                              ? (message.media_url && !brokenMedia[message.id]
                                ? <video className="lan-media-video" src={message.media_url} controls preload="metadata" playsInline onError={() => markBroken(message.id)} />
                                : <span className="lan-media-fail">视频加载失败</span>)
                              : (
                                <button type="button" className="lan-media" disabled={!message.media_url}
                                  aria-label={message.media_name ? "查看图片 " + message.media_name : "查看图片"}
                                  onClick={() => { if (message.media_url) window.open(message.media_url, "_blank"); }}>
                                  {message.media_url && !brokenMedia[message.id]
                                    ? <img src={message.media_url} alt={message.media_name || "图片"} loading="lazy" onError={() => markBroken(message.id)} />
                                    : <span className="lan-media-fail">图片加载失败</span>}
                                </button>
                              )}
                            {String(message.text || "").trim() ? <div className="lan-bubble lan-caption">{message.text}</div> : null}
                          </div>
                        ) : (
                          <div className="lan-bubble">{message.text}</div>
                        )}
                        <div className="lan-meta">
                          <span>{messageTimeLabel(message.ts)}</span>
                          {messageDeliveryLabel(message.status)
                            ? <span className="lan-pending" data-lan-pending={message.status}>{messageDeliveryLabel(message.status)}</span>
                            : null}
                          {message.status === "failed" || message.status === "pending"
                            ? <button className="lan-retry" data-lan-retry onClick={() => void retry(message)}>重发</button>
                            : null}
                        </div>
                      </div>
                      )}
                    </div>
                  );
                }) : <div className="lan-empty small"><span>还没有消息，打个招呼吧</span></div>}
              </div>
              <div className="lan-composer">
                <textarea
                  ref={composerRef}
                  data-lan-input
                  rows={1}
                  value={draft}
                  placeholder={active?.online ? "发消息给 " + (active?.nickname || "好友") + "，Enter 发送" : "对方离线也能发，连上后会收到"}
                  onChange={(e) => { setDraft(e.target.value); if (snap.error) setLan({ error: "" }); }}
                  onPaste={(e) => {
                    const files = mediaFilesOf(e.clipboardData);
                    if (!files.length) return;
                    e.preventDefault();
                    void sendMediaFiles(files);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submitText(); }
                  }}
                />
                <input ref={mediaFileRef} type="file" accept="image/*,video/*" multiple hidden data-lan-media-input
                  onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; void sendMediaFiles(files); }} />
                <button className="lan-ib" data-lan-attach data-tip="发图片或视频" aria-label="发送图片或视频" title="发送图片或视频"
                  disabled={snap.sending} onClick={() => mediaFileRef.current?.click()}><Icon name="image" size="s" /></button>
                <button className="lan-ib" data-lan-send-canvas data-tip="把当前画布发给对方" aria-label="发送当前画布" title="把当前画布发给对方" disabled={snap.sending} onClick={() => void sendCanvas()}><Icon name="layout" size="s" /></button>
                {snap.sending ? <span className="lan-sending" data-lan-sending>发送中…</span> : null}
                <button className="lan-send" data-lan-send disabled={snap.sending || !draft.trim()} aria-label="发送" onClick={() => void submitText()}><AnimatedSendIcon size={16} /></button>
              </div>
            </>
          ) : null}

          {snap.view === "add" ? (
            <div className="lan-body" data-lan-view="add">
              <div className="lan-hint">让对方在「好友 → 我的资料」里复制 6 位数字好友码（如 483920），粘贴到这里。两台电脑要在同一个局域网。自动发现不到时，可以让对方发「直连好友码」（NOVAI-IP:端口-口令），整串粘贴进来。</div>
              <input className="lan-input" data-lan-code-input autoFocus value={codeDraft} placeholder="123456"
                onChange={(e) => { setCodeDraft(e.target.value); if (snap.error) setLan({ error: "" }); }}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void addFriend(); }} />
              <div className="lan-foot">
                <button className="lan-btn" data-lan-back onClick={() => setLan({ view: "list", error: "" })}>返回</button>
                <button className="lan-btn pri" data-lan-add disabled={snap.sending || !codeDraft.trim()} onClick={() => void addFriend()}>{snap.sending ? "校验中…" : "加为好友"}</button>
              </div>
            </div>
          ) : null}

          {snap.view === "me" ? (
            <div className="lan-body" data-lan-view="me" data-lan-cropping={crop ? "1" : undefined}>
              {crop ? (
                <AvatarCrop image={crop.image} onCancel={cancelCrop} onConfirm={confirmCrop} />
              ) : (
                <>
                  <div className="lan-me">
                    <span className="lan-avatar big">{isDataAvatar(avatarDraft) ? <img src={avatarDraft} alt="" /> : avatarText({ nickname: name, avatar: avatarDraft })}</span>
                    <div className="lan-me-fields">
                      <label className="lan-label">昵称</label>
                      <input className="lan-input" data-lan-nickname value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                      <label className="lan-label">头像（emoji 或上传图片）</label>
                      <div className="lan-avatar-row">
                        {isDataAvatar(avatarDraft)
                          ? (avatarSource
                            ? <button type="button" className="lan-avatar-file lan-avatar-recrop" data-lan-avatar-recrop onClick={recrop}>重新裁切</button>
                            : <span className="lan-avatar-file" data-lan-avatar-file>已上传图片</span>)
                          : <input className="lan-input" data-lan-avatar value={avatarDraft} maxLength={8} placeholder="🐼" onChange={(e) => setAvatarDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />}
                        <button type="button" className="lan-btn" data-lan-avatar-upload disabled={avatarBusy} onClick={() => avatarFileRef.current?.click()}>{avatarBusy ? "处理中…" : "上传图片"}</button>
                        {isDataAvatar(avatarDraft) ? <button type="button" className="lan-btn" data-lan-avatar-remove onClick={removeAvatar}>移除</button> : null}
                        <input ref={avatarFileRef} type="file" accept="image/*" hidden data-lan-avatar-input onChange={(e) => { const file = e.target.files?.[0] || null; e.target.value = ""; void pickAvatar(file); }} />
                      </div>
                    </div>
                  </div>
                  <div className="lan-ident">
                    <span className="lan-ident-label">我的 ID</span>
                    <button type="button" className="lan-ident-code" data-lan-my-id={snap.me?.code || ""} title="点击复制我的 ID" onClick={() => copyId()}>
                      <b>{snap.me?.code || "读取中…"}</b>
                      <Icon name="copy" size="xs" />
                    </button>
                  </div>
                  <label className="lan-label">我的好友码（6 位数字）</label>
                  <div className="lan-code">
                    <input data-lan-code readOnly value={snap.me?.friend_code || "读取中…"} onFocus={(e) => e.currentTarget.select()} />
                    <button className="lan-btn" data-lan-copy onClick={() => void copyCode()}><Icon name="copy" size="xs" />复制</button>
                  </div>
                  <div className="lan-hint">同一局域网内会自动发现对方；把上面的 6 位数字好友码发给对方，对方加你之后两边互相可见。</div>
                  <label className="lan-label">直连好友码</label>
                  <div className="lan-code">
                    <input data-lan-direct-code readOnly value={snap.me?.direct_code || "读取中…"} onFocus={(e) => e.currentTarget.select()} />
                    <button className="lan-btn" data-lan-direct-copy onClick={() => void copyDirectCode()}><Icon name="copy" size="xs" />复制</button>
                  </div>
                  <div className="lan-hint">这个码带本机地址和口令，只发给要加好友的人；自动发现不到时把整串发给对方，对方在「加好友」里粘贴即可。</div>
                  <div className="lan-foot">
                    <button className="lan-btn" data-lan-back onClick={() => setLan({ view: "list", error: "" })}>返回</button>
                    <button className="lan-btn pri" data-lan-save disabled={!name.trim()} onClick={() => void saveMe()}>保存</button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {snap.previewUrl ? (
        <div className="lan-preview" data-lan-preview>
          <LanCanvasPreview url={snap.previewUrl} onClose={() => setLan({ previewUrl: "" })} onCloneDoc={cloneToCanvas} />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- 右下角新消息通知 */

/**
 * 新消息卡片：一条消息一张，自下而上涨上去（数组按消息时间排，第 0 项贴右下角，见 lanNotice.ts）。
 * 触发仍然挂在 5s 轮询回来的未读数上：某好友 unread 涨了才按 ts 游标补拉一次消息，
 * 按 message id 去重；页面刚打开时只记游标不弹（历史未读不打扰），正开着这个人的会话也不弹。
 */
export function LanNoticeHost() {
  const theme = useS((s) => s.ui.theme);
  const agentOpen = useS((s) => s.ui.agentOpen);
  const snap = useLan();
  const [items, setItems] = useState<LanNoticeItem[]>([]);
  const pollState = useRef<NoticePollState>({ unread: new Map(), cursor: new Map() });
  const shown = useRef(new Set<string>());
  const fetching = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  const mounted = useRef(true);

  const clearTimer = (messageId: string) => {
    const timer = timers.current.get(messageId);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(messageId);
  };

  const dismiss = (messageId: string) => {
    clearTimer(messageId);
    setItems((list) => list.map((item) => (item.messageId === messageId ? { ...item, leaving: true } : item)));
    timers.current.set(messageId, window.setTimeout(() => {
      timers.current.delete(messageId);
      setItems((list) => list.filter((item) => item.messageId !== messageId));
    }, NOTICE_LEAVE));
  };

  const arm = (messageId: string) => {
    clearTimer(messageId);
    timers.current.set(messageId, window.setTimeout(() => dismiss(messageId), NOTICE_TTL));
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    };
  }, []);

  useEffect(() => {
    const chattingWith = snap.open && snap.view === "chat" ? snap.activeId : "";
    const plan = planNoticeFetches(pollState.current, snap.friends, chattingWith);
    pollState.current = plan.state;
    for (const job of plan.fetches) {
      if (fetching.current.has(job.friendId)) continue;
      const friend = snap.friends.find((item) => item.id === job.friendId);
      if (!friend) continue;
      fetching.current.add(job.friendId);
      void api("/api/lan/messages?with=" + encodeURIComponent(friend.id) + "&after=" + (job.after || 0))
        .then((result) => {
          if (!mounted.current || !result.ok) return;
          const all: LanNoticeMessage[] = Array.isArray(result.data?.messages) ? result.data.messages : [];
          // 游标按返回里的最新 ts 走：中间夹着自己发的消息也算处理过，下次不重拉
          const latest = all.reduce((n, message) => Math.max(n, Number(message?.ts) || 0), 0);
          if (latest) pollState.current.cursor.set(friend.id, Math.max(pollState.current.cursor.get(friend.id) || 0, latest));
          const fresh = noticeMessages(all, job.after, shown.current).map((message) => {
            shown.current.add(message.id);
            return {
              friendId: friend.id, messageId: message.id, nickname: friend.nickname,
              avatar: friend.avatar, preview: noticePreviewOf(message), ts: Number(message.ts) || 0,
            };
          });
          if (!fresh.length) return;
          setItems((list) => appendNotices(list, fresh));
          for (const item of fresh) arm(item.messageId);
        })
        .catch(() => {})
        .finally(() => { fetching.current.delete(job.friendId); });
    }
  }, [snap.friends, snap.open, snap.view, snap.activeId]);

  const openFromNotice = (friendId: string) => {
    for (const item of items) if (item.friendId === friendId) clearTimer(item.messageId);
    setItems((list) => clearFriendNotices(list, friendId));
    openChat(friendId);
  };

  if (!items.length) return null;

  return createPortal(
    <div className="cn-root lan-root" data-theme={theme}>
      <div className="lan-notices" data-lan-notices style={agentOpen ? { right: "calc(380px + 16px)" } : undefined}>
        {items.map((item) => (
          <div key={item.messageId} className="lan-notice" data-lan-notice={item.messageId} data-lan-notice-friend={item.friendId}
            data-leaving={item.leaving ? "1" : undefined} role="button" tabIndex={0}
            aria-label={"查看 " + item.nickname + " 的新消息：" + item.preview}
            onClick={() => openFromNotice(item.friendId)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openFromNotice(item.friendId); } }}>
            <span className="lan-avatar lan-notice-av">{isDataAvatar(item.avatar) ? <img src={item.avatar} alt="" /> : avatarText(item)}</span>
            <span className="lan-notice-main">
              <span className="lan-notice-name">{item.nickname}</span>
              <span className="lan-notice-text">{item.preview}</span>
            </span>
            <span className="lan-notice-go">查看</span>
            <button type="button" className="lan-notice-x" aria-label="关闭提醒" onClick={(event) => { event.stopPropagation(); dismiss(item.messageId); }}><Icon name="x" size="xs" /></button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- 右下角好友请求卡片 */

const REQUEST_CARD_MAX = 2;

/**
 * 好友请求卡片：规格照 web/src/shell/UpdateReminder.vue（320 宽、圆角 16、磨砂厚底、标题行 + 说明 + 右下按钮）。
 * 不自动消失；点关闭只是忽略这一次（内存记 30 分钟），好友列表顶部照样能同意 / 拒绝。
 */
export function LanRequestHost() {
  const theme = useS((s) => s.ui.theme);
  const agentOpen = useS((s) => s.ui.agentOpen);
  const snap = useLan();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState("");

  const dismiss = (requestId: string) => {
    ignoreRequest(requestId);
    setDismissed((list) => (list.includes(requestId) ? list : [...list, requestId]));
  };

  const respond = async (request: LanFriendRequest, accept: boolean) => {
    setBusy(request.id);
    const ok = await respondToRequest(request, accept);
    setBusy("");
    if (ok) dismiss(request.id);
  };

  const items = snap.requests.incoming
    .filter((request) => request.status === "pending" && !dismissed.includes(request.id) && !isIgnoredRequest(request.id))
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    .slice(0, REQUEST_CARD_MAX);

  if (!items.length) return null;

  return createPortal(
    <div className="cn-root lan-root" data-theme={theme}>
      <div className="lan-requests" data-lan-requests style={agentOpen ? { right: "calc(380px + 16px)" } : undefined}>
        {items.map((request) => {
          const peer = requestPeer(request);
          const pending = busy === request.id;
          return (
            <div key={request.id} className="lan-req" data-lan-request={request.id} role="dialog" aria-label={requestPreview(request)}>
              <div className="lan-req-hd">
                <span className="lan-avatar lan-req-av">{isDataAvatar(peer?.avatar) ? <img src={String(peer?.avatar || "")} alt="" /> : avatarText(peer)}</span>
                <b className="lan-req-title">{requestPreview(request)}</b>
                <button type="button" className="lan-req-x" aria-label="关闭提醒" onClick={() => dismiss(request.id)}><Icon name="x" size="xs" /></button>
              </div>
              <p className="lan-req-note">同意后你们可以互相发消息、图片和视频。</p>
              <div className="lan-req-acts">
                <button type="button" className="lan-btn" data-lan-request-reject={request.id} disabled={pending} onClick={() => void respond(request, false)}>拒绝</button>
                <button type="button" className="lan-btn pri" data-lan-request-accept={request.id} disabled={pending} onClick={() => void respond(request, true)}>同意</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
