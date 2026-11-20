/**
 * 右下角新消息提醒的纯函数（不 import React / CSS，node 测试可直接 esbuild 加载）。
 * 一条消息一张卡（同一个人连发 N 条就是 N 张，各自计时消失）；堆叠靠 .lan-notices 的 column-reverse ——
 * 数组第 0 项贴右下角：按消息时间从下往上排，最新的一条离角落最近，老的往上顶。
 */
import { mediaKindLabel } from "./lanDoc";

export type LanNoticeMessage = {
    id: string;
    kind?: string;
    text?: string;
    canvas_title?: string;
    ts?: number;
    dir?: string;
};

export type LanNoticeItem = {
    friendId: string;
    messageId: string;
    nickname: string;
    avatar: string;
    preview: string;
    ts: number;
    leaving?: boolean;
};

export type LanNoticeFriend = {
    id: string;
    nickname?: string;
    avatar?: string;
    unread?: number;
    last_message?: { ts?: number } | null;
};

export type NoticePollState = {
    /** 上一轮每人的未读数：只有涨了才去补拉消息 */
    unread: Map<string, number>;
    /** 每人已处理到的 ts 游标，请求 /api/lan/messages 的 after 用它 */
    cursor: Map<string, number>;
};

export type NoticeFetch = { friendId: string; after: number };

/** 同时最多 4 张：4×52 + 3×8 约 232px，从 bottom 96 往上堆还在 #orb 和底部工具条上方，超出的丢最老的 */
export const NOTICE_MAX = 4;
export const NOTICE_TTL = 5000;
export const NOTICE_LEAVE = 180;

function squeeze(value: unknown, limit: number): string {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 单条消息的一句话预览：类型标签 + 一行文字（画布卡片带标题） */
export function noticePreviewOf(message: LanNoticeMessage | null | undefined): string {
    if (!message) return "给你发来一条消息";
    const kind = String(message.kind || "");
    const text = squeeze(message.text, 60);
    if (kind === "canvas") {
        const title = squeeze(message.canvas_title, 40);
        return "[画布]" + (title ? " " + title : "") + (text ? " " + text : "");
    }
    const media = mediaKindLabel(kind);
    if (media) return media + (text ? " " + text : "");
    return text || "给你发来一条消息";
}

/** 只留收到的、比游标新的、没弹过的；按 ts 升序（同一毫秒用 id 兜底，顺序稳定） */
export function noticeMessages(
    messages: LanNoticeMessage[] | null | undefined,
    after: number,
    seen?: { has(id: string): boolean } | null,
): LanNoticeMessage[] {
    const floor = Number(after) || 0;
    return (Array.isArray(messages) ? messages : [])
        .filter((item) => {
            if (!item || !item.id) return false;
            if (item.dir !== "in") return false;
            if ((Number(item.ts) || 0) <= floor) return false;
            return !(seen && seen.has(item.id));
        })
        .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || String(a.id).localeCompare(String(b.id)));
}

/** 收到的按 message id 并进来，再按消息时间从下往上排：index 0（贴右下角）永远是最新那条，超过上限丢最老的 */
export function appendNotices(list: LanNoticeItem[], incoming: LanNoticeItem[], max = NOTICE_MAX): LanNoticeItem[] {
    const next = (Array.isArray(list) ? list : []).slice();
    for (const item of Array.isArray(incoming) ? incoming : []) {
        if (!item || !item.messageId) continue;
        if (next.some((old) => old.messageId === item.messageId)) continue;
        next.push(item);
    }
    next.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || String(b.messageId).localeCompare(String(a.messageId)));
    return next.slice(0, Math.max(1, Number(max) || NOTICE_MAX));
}

/** 点卡片进会话 / 消息已读：这个人的卡一起收掉，别留僵尸卡 */
export function clearFriendNotices(list: LanNoticeItem[], friendId: string): LanNoticeItem[] {
    return (Array.isArray(list) ? list : []).filter((item) => item.friendId !== friendId);
}

/**
 * 一轮好友列表 → 这轮要补拉谁的消息。
 * 第一次看到某个好友只记游标（页面刚打开，历史未读不弹）；
 * 之后只有 unread 真的涨了才拉；正开着这个人的会话不拉，但游标跟上，之后不会补弹旧消息。
 */
export function planNoticeFetches(
    state: NoticePollState | null | undefined,
    friends: LanNoticeFriend[] | null | undefined,
    chattingWith = "",
): { state: NoticePollState; fetches: NoticeFetch[] } {
    const unread = new Map(state?.unread || []);
    const cursor = new Map(state?.cursor || []);
    const fetches: NoticeFetch[] = [];
    for (const friend of Array.isArray(friends) ? friends : []) {
        if (!friend || !friend.id) continue;
        const count = Math.max(0, Number(friend.unread) || 0);
        const lastTs = Math.max(0, Number(friend.last_message?.ts) || 0);
        const before = unread.get(friend.id);
        unread.set(friend.id, count);
        if (before === undefined) {
            cursor.set(friend.id, Math.max(cursor.get(friend.id) || 0, lastTs));
            continue;
        }
        if (count <= before) continue;
        const after = cursor.get(friend.id) || 0;
        if (friend.id === chattingWith) {
            cursor.set(friend.id, Math.max(after, lastTs));
            continue;
        }
        fetches.push({ friendId: friend.id, after });
    }
    return { state: { unread, cursor }, fetches };
}
