/**
 * 局域网好友 / 聊天（T51）。
 * - 入口全在左侧栏 #lb 底部那颗「我」的头像上：左键进聊天，右键弹账户菜单；LanUnread / LanAvatarFace 给它补红点和局域网头像；
 * - LanChatHost：浮层本体（好友列表 / 会话 / 加好友 / 我的资料 / 画布卡片只读预览），portal 到 body。
 * 在线状态与未读每 5s 轮询，会话内容 4s 轮询；不用 WebSocket。
 * 画布卡片的只读预览直接复用 T49 的 ShareView（内部是 TemplatePreview + 克隆 / 存模板）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CanvasDoc } from "../../react-canvas/reactCanvasStore";
import { serverDocToDoc } from "../../../novaiBackend";
import { cloneWorkflowForImport, savePersonalTemplate } from "../personalTemplates";
import { uid } from "../model";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { TemplatePreview } from "./TemplatePreview";
import { previewDocOf, shareErrorMessage } from "./shareDoc";
import { localizeDocMedia, mediaStatsText, type MediaStats } from "./shareMedia";
import { AvatarCrop } from "./AvatarCrop";
import {
  absolutizeSnapshot, avatarText, daySeparator, friendStatusLabel, isDataAvatar, lanErrorMessage, mergeLanMessages,
  messageTimeLabel, newMessageId, onlineCount, parseFriendCode, shareTokenOf,
  unreadTotal, type LanFriend, type LanMe, type LanMessage, type LanView,
} from "./lanDoc";
import "./lan-chat.css";

type Snapshot = {
  ready: boolean;
  me: LanMe | null;
  friends: LanFriend[];
  messages: LanMessage[];
  open: boolean;
  view: LanView;
  activeId: string;
  previewUrl: string;
  sending: boolean;
  notice: string;
  error: string;
};

const EMPTY: Snapshot = {
  ready: false, me: null, friends: [], messages: [], open: false, view: "list",
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

async function loadMessages(friendId: string, after = 0): Promise<void> {
  if (!friendId) return;
  const result = await api("/api/lan/messages?with=" + encodeURIComponent(friendId) + "&after=" + (after || 0));
  if (!result.ok) { setLan({ error: result.error }); return; }
  const incoming: LanMessage[] = Array.isArray(result.data?.messages) ? result.data.messages : [];
  if (!incoming.length) return;
  // 只并消息，不清 error：发送失败后这里紧接着刷新一次，清了用户就看不到报错了
  setLan({ messages: mergeLanMessages(snapshot.messages, incoming) });
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

type SendInput = { text?: string; kind?: "text" | "canvas"; share_url?: string; canvas_title?: string; message_id?: string };

async function sendToFriend(friendId: string, input: SendInput): Promise<boolean> {
  if (!friendId) return false;
  setLan({ sending: true, error: "" });
  const result = await api("/api/lan/friends/" + encodeURIComponent(friendId) + "/send", {
    method: "POST",
    body: JSON.stringify({
      text: input.text || "",
      kind: input.kind || "text",
      share_url: input.share_url || "",
      canvas_title: input.canvas_title || "",
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
  return result.ok;
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
  /** 本次会话内上传过的原图；确认裁切后才留，用于「重新裁切」 */
  const [avatarSource, setAvatarSource] = useState<{ image: HTMLImageElement; url: string } | null>(null);
  /** 裁切中：fresh 表示这次新选的文件，取消时要把它的 objectURL 一起丢掉 */
  const [crop, setCrop] = useState<{ image: HTMLImageElement; url: string; fresh: boolean } | null>(null);

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

  // 我的资料：每次打开浮层同步一次（昵称/头像可能被另一台机器或另一个页面改过）
  useEffect(() => {
    void loadMe();
    void loadFriends(false);
    const timer = setInterval(() => { void loadFriends(); }, 5000);
    return () => clearInterval(timer);
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
    const timer = setInterval(() => { void tick(); }, 4000);
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

  const submitText = async () => {
    const text = draft.trim();
    if (!text || !snap.activeId || snap.sending) return;
    setDraft("");
    const ok = await sendToFriend(snap.activeId, { text, message_id: newMessageId() });
    if (!ok) setDraft(text);
    composerRef.current?.focus();
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
    const friend = result.data?.friend as LanFriend | undefined;
    await loadFriends(false);
    setLan({ sending: false, error: "", notice: "" });
    setCodeDraft("");
    notify("已加为好友：" + (friend?.nickname || "对方"));
    if (friend?.id) openChat(friend.id);
    else setLan({ view: "list" });
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
      <span className="lan-avatar" data-online={friend.online ? "1" : undefined}>
        {isDataAvatar(friend.avatar) ? <img src={friend.avatar} alt="" /> : avatarText(friend)}
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
        <div id="lanPanel" className="lan-panel" data-lan-panel onKeyDown={(e) => e.stopPropagation()}>
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
              <div className="lan-list" ref={listRef} data-lan-messages>
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
                        ) : (
                          <div className="lan-bubble">{message.text}</div>
                        )}
                        <div className="lan-meta">
                          <span>{messageTimeLabel(message.ts)}</span>
                          {message.status === "failed" ? <button className="lan-retry" data-lan-retry onClick={() => void retry(message)}>重发</button> : null}
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
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submitText(); }
                  }}
                />
                <button className="lan-ib" data-lan-send-canvas data-tip="把当前画布发给对方" aria-label="发送当前画布" title="把当前画布发给对方" disabled={snap.sending} onClick={() => void sendCanvas()}><Icon name="layout" size="s" /></button>
                <button className="lan-send" data-lan-send disabled={snap.sending || !draft.trim()} aria-label="发送" onClick={() => void submitText()}><Icon name="send" size="s" /></button>
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

type LanLastMessage = { kind?: string; text?: string; ts?: number; dir?: string };

type LanNotice = { friendId: string; nickname: string; avatar: string; preview: string; leaving?: boolean };

/** 停 5s 自动消失、退场 180ms、同时最多两张：够看清又不挡画布 */
const NOTICE_TTL = 5000;
const NOTICE_LEAVE = 180;
const NOTICE_MAX = 2;

const lastMessageOf = (friend: LanFriend): LanLastMessage | null => {
  const last = (friend as LanFriend & { last_message?: LanLastMessage | null }).last_message;
  return last && typeof last === "object" ? last : null;
};

/** 一句话预览：后端 last_message 拿不到也要给出看得懂的兜底 */
const noticePreview = (friend: LanFriend): string => {
  const last = lastMessageOf(friend);
  if (!last) return "给你发来一条消息";
  const text = String(last.text || "").replace(/\s+/g, " ").trim();
  if (last.kind === "canvas") return "[画布]" + (text ? " " + text.slice(0, 40) : "");
  return text ? text.slice(0, 60) : "给你发来一条消息";
};

/**
 * 新消息卡片：跟着 5s 轮询回来的未读数走，某好友 unread 比上一轮涨了就弹一张。
 * 正看着这个人的会话不弹；同一好友再来消息只换预览、重置计时。
 */
export function LanNoticeHost() {
  const theme = useS((s) => s.ui.theme);
  const agentOpen = useS((s) => s.ui.agentOpen);
  const snap = useLan();
  const [items, setItems] = useState<LanNotice[]>([]);
  const previousUnread = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, number>());

  const clearTimer = (friendId: string) => {
    const timer = timers.current.get(friendId);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(friendId);
  };

  const dismiss = (friendId: string) => {
    clearTimer(friendId);
    setItems((list) => list.map((item) => (item.friendId === friendId ? { ...item, leaving: true } : item)));
    timers.current.set(friendId, window.setTimeout(() => {
      timers.current.delete(friendId);
      setItems((list) => list.filter((item) => item.friendId !== friendId));
    }, NOTICE_LEAVE));
  };

  const arm = (friendId: string) => {
    clearTimer(friendId);
    timers.current.set(friendId, window.setTimeout(() => dismiss(friendId), NOTICE_TTL));
  };

  useEffect(() => {
    const previous = previousUnread.current;
    const next = new Map<string, number>();
    const fresh: LanFriend[] = [];
    for (const friend of snap.friends) {
      const unread = Math.max(0, Number(friend.unread) || 0);
      next.set(friend.id, unread);
      const before = previous.get(friend.id);
      if (before !== undefined && unread > before) fresh.push(friend);
    }
    previousUnread.current = next;
    if (!fresh.length) return;
    const chattingWith = snap.open && snap.view === "chat" ? snap.activeId : "";
    const show = fresh.filter((friend) => friend.id !== chattingWith);
    if (!show.length) return;
    setItems((list) => {
      let merged = list;
      for (const friend of show) {
        const notice: LanNotice = { friendId: friend.id, nickname: friend.nickname, avatar: friend.avatar, preview: noticePreview(friend) };
        merged = [notice, ...merged.filter((item) => item.friendId !== friend.id)];
      }
      return merged.slice(0, NOTICE_MAX);
    });
    for (const friend of show) arm(friend.id);
  }, [snap.friends, snap.open, snap.view, snap.activeId]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  const openFromNotice = (friendId: string) => {
    clearTimer(friendId);
    setItems((list) => list.filter((item) => item.friendId !== friendId));
    openChat(friendId);
  };

  if (!items.length) return null;

  return createPortal(
    <div className="cn-root lan-root" data-theme={theme}>
      <div className="lan-notices" data-lan-notices style={agentOpen ? { right: "calc(380px + 16px)" } : undefined}>
        {items.map((item) => (
          <div key={item.friendId} className="lan-notice" data-lan-notice={item.friendId} data-leaving={item.leaving ? "1" : undefined}
            role="button" tabIndex={0} aria-label={"查看 " + item.nickname + " 的新消息"}
            onClick={() => openFromNotice(item.friendId)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openFromNotice(item.friendId); } }}>
            <span className="lan-avatar lan-notice-av">{isDataAvatar(item.avatar) ? <img src={item.avatar} alt="" /> : avatarText(item)}</span>
            <span className="lan-notice-main">
              <span className="lan-notice-name">{item.nickname}</span>
              <span className="lan-notice-text">{item.preview}</span>
            </span>
            <span className="lan-notice-go">查看</span>
            <button type="button" className="lan-notice-x" aria-label="关闭提醒" onClick={(event) => { event.stopPropagation(); dismiss(item.friendId); }}><Icon name="x" size="xs" /></button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
