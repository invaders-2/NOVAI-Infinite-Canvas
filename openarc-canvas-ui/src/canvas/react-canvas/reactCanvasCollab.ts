import {
  channelName,
  emptyDoc,
  sanitizeDoc,
  sanitizeOp,
  type CanvasDoc,
  type CanvasOp,
} from "./reactCanvasStore";
import { canvasBridge, serverDocToDoc, type CanvasCommandBridge } from "./persistence";

export type PeerCursor = { x: number; y: number };
export type PeerState = { cursor: PeerCursor | null; seenAt: number };
export type CollabTransport = "host" | "local" | "lan";

export type CollabHandlers = {
  getDoc: () => CanvasDoc;
  onOp: (op: CanvasOp) => void;
  onSnapshot: (doc: CanvasDoc) => void;
  onPresence: (clientId: string, cursor: PeerCursor | null) => void;
  onJoin?: (clientId: string) => void;
};

export type CollabOptions = {
  /** 显式注入宿主通讯桥；缺省读 window.openarc.canvas。 */
  bridge?: CanvasCommandBridge | null;
  /** 独立页 / 测试强制只走 BroadcastChannel。 */
  forceLocal?: boolean;
};

export type Collab = {
  clientId: string;
  readonly transport: CollabTransport;
  sendOp: (op: CanvasOp) => void;
  sendPresence: (cursor: PeerCursor | null) => void;
  requestSnapshot: () => void;
  close: () => void;
};

type Msg =
  | { t: "hello"; cid: string }
  | { t: "snapshot-request"; cid: string }
  | { t: "snapshot"; cid: string; doc: CanvasDoc }
  | { t: "op"; cid: string; op: CanvasOp }
  | { t: "presence"; cid: string; cursor: PeerCursor | null };

type LocalTransport = {
  sendOp: (op: CanvasOp) => void;
  sendPresence: (cursor: PeerCursor | null) => void;
  requestSnapshot: () => void;
  close: () => void;
};

type HostTransport = {
  start: () => void;
  sendOp: (op: CanvasOp) => boolean;
  sendPresence: (cursor: PeerCursor | null) => boolean;
  requestSnapshot: () => boolean;
  close: () => void;
};

/** 补丁信封：op 原样放在 patches[0] 里，含义与 store 的 applyOp 完全一致，只做传输封装。 */
const HOST_FRAME_SOURCE = "react-canvas";
const HOST_POLL_MS = 250;
const HOST_HEARTBEAT_MS = 2000;
const HOST_CURSOR_RESEND_MS = 1000;
const HOST_CURSOR_MIN_GAP_MS = 70;
const HOST_RETRY_MIN_MS = 1500;
const HOST_RETRY_MAX_MS = 15000;
const HOST_QUEUE_MAX = 500;

function parseCursor(raw: unknown): PeerCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.x !== "number" || typeof r.y !== "number") return null;
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  return { x: r.x, y: r.y };
}

function createLocalTransport(canvasId: string, clientId: string, handlers: CollabHandlers): LocalTransport {
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(channelName(canvasId));
  } catch {
    channel = null;
  }
  let lastCursor: PeerCursor | null = null;
  let closed = false;

  const post = (msg: Msg) => {
    if (!channel || closed) return;
    try {
      channel.postMessage(msg);
    } catch {
      return;
    }
  };

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;
      const cid = msg.cid;
      if (typeof cid !== "string" || !cid || cid === clientId) return;
      switch (msg.t) {
        case "hello":
          handlers.onJoin?.(cid);
          post({ t: "presence", cid: clientId, cursor: lastCursor });
          break;
        case "snapshot-request":
          post({ t: "snapshot", cid: clientId, doc: sanitizeDoc(handlers.getDoc()) ?? emptyDoc() });
          break;
        case "snapshot": {
          const doc = sanitizeDoc(msg.doc);
          if (doc) handlers.onSnapshot(doc);
          break;
        }
        case "op": {
          const op = sanitizeOp(msg.op);
          if (op) handlers.onOp(op);
          break;
        }
        case "presence":
          handlers.onPresence(cid, parseCursor(msg.cursor));
          break;
        default:
          break;
      }
    };
  }

  const heartbeat = window.setInterval(() => {
    if (!closed && channel) post({ t: "presence", cid: clientId, cursor: lastCursor });
  }, 1000);

  return {
    sendOp(op) {
      post({ t: "op", cid: clientId, op });
    },
    sendPresence(cursor) {
      lastCursor = cursor;
      post({ t: "presence", cid: clientId, cursor });
    },
    requestSnapshot() {
      post({ t: "snapshot-request", cid: clientId });
      post({ t: "hello", cid: clientId });
    },
    close() {
      if (closed) return;
      closed = true;
      window.clearInterval(heartbeat);
      try {
        channel?.close();
      } catch {
        return;
      }
      channel = null;
    },
  };
}

/**
 * 宿主通道：canvas:command 的 canvas/collab/* 命令（主进程 hub 广播，事件靠 canvas/collab/events 拉取）。
 *
 * 断线判定：命令抛错或返回 ok:false。首次连上后断线不再回退 BroadcastChannel，本地 op 顺序入队，
 * 重连后按序补发并重新拉取服务端文档（canvas/get）；同一节点并发仍由接收端逐 op 应用，保持 last-writer。
 *
 * patch 的 baseRevision/currentRevision 用传输层单调计数（两者恒等）：该守卫只用于拒绝过期广播，
 * 新画布没有服务端实时 rev，文档版本仍由 canvas/save 的 baseRevision 保护。
 */
function createHostTransport(
  canvasId: string,
  clientId: string,
  handlers: CollabHandlers,
  bridge: CanvasCommandBridge,
  hooks: { onConnected: () => void; onLost: () => void },
): HostTransport {
  let joined = false;
  let everJoined = false;
  let closed = false;
  let polling = false;
  let revision = 0;
  let lastCursor: PeerCursor | null = null;
  let lastCursorSentAt = 0;
  let lastHeartbeatAt = 0;
  let pendingCursor = false;
  let retryDelay = HOST_RETRY_MIN_MS;
  let retryTimer: number | null = null;
  let pollTimer: number | null = null;
  const queue: CanvasOp[] = [];
  const knownPeers = new Set<string>();

  const call = (command: Record<string, unknown>) => bridge.command(command);

  const stopPolling = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  const stopRetry = () => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const pushQueue = (op: CanvasOp) => {
    queue.push(op);
    if (queue.length > HOST_QUEUE_MAX) queue.splice(0, queue.length - HOST_QUEUE_MAX);
  };

  const scheduleRetry = () => {
    if (closed || joined || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(HOST_RETRY_MAX_MS, Math.round(retryDelay * 1.8));
  };

  const markLost = () => {
    if (closed || !joined) return;
    joined = false;
    stopPolling();
    hooks.onLost();
    scheduleRetry();
  };

  const applyPresence = (presence: unknown) => {
    if (!presence || typeof presence !== "object") return;
    const users = (presence as { users?: unknown }).users;
    if (!Array.isArray(users)) return;
    for (const user of users) {
      if (!user || typeof user !== "object") continue;
      const cid = String((user as { clientId?: unknown }).clientId || "");
      if (!cid || cid === clientId || knownPeers.has(cid)) continue;
      knownPeers.add(cid);
      handlers.onPresence(cid, null);
    }
  };

  const handleEvent = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const event = raw as Record<string, unknown>;
    if (event.type === "cursor") {
      const cid = String(event.clientId || "");
      if (!cid || cid === clientId) return;
      const cursor = parseCursor(event);
      if (!cursor) return;
      knownPeers.add(cid);
      handlers.onPresence(cid, cursor);
      return;
    }
    if (event.type === "presence") {
      applyPresence(event.presence);
      return;
    }
    if (event.type === "patch") {
      if (String(event.sourceClientId || "") === clientId) return;
      const patches = Array.isArray(event.patches) ? event.patches : [];
      for (const item of patches) {
        if (!item || typeof item !== "object") continue;
        const framed = item as Record<string, unknown>;
        if (framed.source !== HOST_FRAME_SOURCE) continue;
        const op = sanitizeOp(framed.op);
        if (op) handlers.onOp(op);
      }
    }
  };

  const fetchSnapshot = async () => {
    let response: Record<string, unknown> | null = null;
    try {
      response = await call({ type: "canvas/get", canvasId });
    } catch {
      return;
    }
    if (closed || !response || response.ok !== true) return;
    const canvas = response.canvas && typeof response.canvas === "object" ? (response.canvas as Record<string, unknown>) : null;
    if (!canvas) return;
    const parsed = serverDocToDoc(canvas.doc);
    if (parsed.doc) handlers.onSnapshot(parsed.doc);
  };

  const sendPatch = async (op: CanvasOp) => {
    revision += 1;
    const current = revision;
    const response = await call({
      type: "canvas/collab/patch",
      canvasId,
      clientId,
      baseRevision: current,
      currentRevision: current,
      patch: { patches: [{ source: HOST_FRAME_SOURCE, op }] },
    });
    if (!response || response.ok !== true) throw new Error(String((response && response.error) || "COLLAB_PATCH_FAILED"));
  };

  const flushQueue = async () => {
    while (joined && queue.length) {
      const op = queue.shift();
      if (!op) break;
      try {
        await sendPatch(op);
      } catch {
        pushQueue(op);
        markLost();
        return;
      }
    }
  };

  const sendCursor = async (force: boolean) => {
    if (closed || !joined || !lastCursor) return;
    const now = Date.now();
    if (now - lastCursorSentAt < HOST_CURSOR_MIN_GAP_MS) {
      pendingCursor = true;
      return;
    }
    lastCursorSentAt = now;
    pendingCursor = false;
    const cursor = lastCursor;
    try {
      const response = await call({ type: "canvas/collab/cursor", canvasId, clientId, x: cursor.x, y: cursor.y });
      if (response && response.ok === false && response.error === "NOT_FOUND") markLost();
    } catch {
      markLost();
    }
  };

  const poll = async () => {
    if (closed || !joined || polling) return;
    polling = true;
    try {
      let response: Record<string, unknown> | null = null;
      try {
        response = await call({ type: "canvas/collab/events", canvasId, clientId });
      } catch {
        markLost();
        return;
      }
      if (closed || !joined) return;
      if (!response || response.ok !== true) {
        markLost();
        return;
      }
      const events = Array.isArray(response.events) ? response.events : [];
      for (const event of events) {
        try {
          handleEvent(event);
        } catch {
          continue;
        }
      }
      const now = Date.now();
      if (now - lastHeartbeatAt >= HOST_HEARTBEAT_MS) {
        lastHeartbeatAt = now;
        try {
          const beat = await call({ type: "canvas/collab/heartbeat", canvasId, clientId });
          if (!beat || beat.ok !== true) {
            markLost();
            return;
          }
          // presence 不进 events 队列（后端只排队 cursor / patch），在线成员靠心跳同频轮询。
          const view = await call({ type: "canvas/collab/presence", canvasId });
          if (view && view.ok === true) applyPresence(view.presence);
        } catch {
          markLost();
          return;
        }
      }
      if (pendingCursor || (lastCursor && now - lastCursorSentAt >= HOST_CURSOR_RESEND_MS)) void sendCursor(false);
    } finally {
      polling = false;
    }
  };

  const startPolling = () => {
    stopPolling();
    void poll();
    pollTimer = window.setInterval(() => {
      void poll();
    }, HOST_POLL_MS);
  };

  const connect = async () => {
    if (closed || joined) return;
    stopRetry();
    let response: Record<string, unknown> | null = null;
    try {
      response = await call({ type: "canvas/collab/join", canvasId, clientId });
    } catch {
      response = null;
    }
    if (closed) return;
    if (!response || response.ok !== true) {
      scheduleRetry();
      return;
    }
    joined = true;
    retryDelay = HOST_RETRY_MIN_MS;
    everJoined = true;
    hooks.onConnected();
    applyPresence(response.presence);
    await flushQueue();
    if (!joined || closed) return;
    void fetchSnapshot();
    lastHeartbeatAt = Date.now();
    startPolling();
    if (lastCursor) void sendCursor(true);
  };

  return {
    start() {
      void connect();
    },
    sendOp(op) {
      if (closed) return false;
      if (!joined) {
        if (!everJoined) return false;
        pushQueue(op);
        return true;
      }
      void sendPatch(op).catch(() => {
        pushQueue(op);
        markLost();
      });
      return true;
    },
    sendPresence(cursor) {
      if (closed) return false;
      lastCursor = cursor;
      if (!joined) return everJoined;
      void sendCursor(true);
      return true;
    },
    requestSnapshot() {
      if (closed) return false;
      if (!joined) return everJoined;
      void fetchSnapshot();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      stopPolling();
      stopRetry();
      queue.length = 0;
      const wasJoined = joined;
      joined = false;
      if (wasJoined) {
        try {
          void call({ type: "canvas/collab/leave", canvasId, clientId }).catch(() => undefined);
        } catch {
          return;
        }
      }
    },
  };
}

export function createCollab(canvasId: string, handlers: CollabHandlers, options: CollabOptions = {}): Collab {
  const clientId = "c_" + Math.random().toString(36).slice(2, 10);
  const bridge = options.forceLocal ? null : options.bridge !== undefined ? options.bridge : canvasBridge();
  const local = createLocalTransport(canvasId, clientId, handlers);
  let transport: CollabTransport = "local";
  let closed = false;

  const host: HostTransport | null = bridge
    ? createHostTransport(canvasId, clientId, handlers, bridge, {
        onConnected: () => {
          if (closed) return;
          transport = "host";
          local.close();
        },
        onLost: () => {
          // 保持 host 模式：断线期间 op 入队，重连后按序补发；不重开 BroadcastChannel，避免双通道重复投递。
        },
      })
    : null;
  if (host) host.start();

  return {
    clientId,
    get transport(): CollabTransport {
      return transport;
    },
    sendOp(op) {
      if (closed) return;
      if (host && host.sendOp(op)) return;
      local.sendOp(op);
    },
    sendPresence(cursor) {
      if (closed) return;
      if (host && host.sendPresence(cursor)) return;
      local.sendPresence(cursor);
    },
    requestSnapshot() {
      if (closed) return;
      if (host && host.requestSnapshot()) return;
      local.requestSnapshot();
    },
    close() {
      if (closed) return;
      closed = true;
      local.close();
      host?.close();
      transport = "local";
    },
  };
}
