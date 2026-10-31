import { emptyDoc, sanitizeDoc, sanitizeOp, type CanvasOp } from "./reactCanvasStore";
import type { Collab, CollabHandlers, PeerCursor } from "./reactCanvasCollab";

export type LanCollabOptions = {
  canvasId: string;
  wsUrl: string;
  token: string;
  canEdit: boolean;
  handlers: CollabHandlers;
  WebSocketImpl?: typeof WebSocket;
};

function parseCursor(raw: unknown): PeerCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.x !== "number" || typeof r.y !== "number" || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  return { x: r.x, y: r.y };
}

/** Explicit LAN transport; same wire messages as the same-instance protocol. */
export function createLanCollab({ canvasId, wsUrl, token, canEdit, handlers, WebSocketImpl = WebSocket }: LanCollabOptions): Collab {
  const clientId = "lan-client:" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let socket: WebSocket | null = null;
  let joined = false;
  let closed = false;
  let readOnly = !canEdit;
  let retryDelay = 1500;
  let retryTimer: number | null = null;
  const queue: CanvasOp[] = [];
  let lastCursor: PeerCursor | null = null;
  const knownPeers = new Set<string>();

  const makeUrl = () => {
    const url = new URL(wsUrl, window.location.href);
    if (token && !url.searchParams.get("token")) url.searchParams.set("token", token);
    return url.toString();
  };
  const send = (message: Record<string, unknown>) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  };
  const push = (op: CanvasOp) => {
    queue.push(op);
    if (queue.length > 500) queue.splice(0, queue.length - 500);
  };
  const flush = () => { while (queue.length) { const op = queue[0]; if (!send({ type: "op", canvasId, op })) return; queue.shift(); } };
  const scheduleRetry = () => {
    if (closed) return;
    retryTimer = window.setTimeout(() => { retryTimer = null; void connect(); }, retryDelay);
    retryDelay = Math.min(15000, Math.round(retryDelay * 1.8));
  };
  const connect = async () => {
    if (closed) return;
    try {
      const ws = new WebSocketImpl(makeUrl());
      socket = ws;
      ws.onopen = () => {
        retryDelay = 1500;
        send({ type: "collab.join", canvasId, username: "LAN 设备" });
        send({ type: "hello", cid: clientId });
        send({ type: "snapshot-request", canvasId });
        if (lastCursor) send({ type: "presence", canvasId, cursor: lastCursor });
      };
      ws.onmessage = (event) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        const type = String(message.type || "");
        if (type === "collab.join.result") {
          joined = !!(message.ok === true);
          readOnly = message.readOnly === true;
          if (!joined) return;
          flush();
          return;
        }
        const cid = String(message.cid || message.clientId || "");
        if (type === "hello" || type === "presence") {
          if (cid && cid !== clientId) { knownPeers.add(cid); handlers.onPresence(cid, parseCursor(message.cursor)); }
          return;
        }
        if (type === "snapshot-request") {
          if (cid !== clientId) send({ type: "snapshot", canvasId, doc: sanitizeDoc(handlers.getDoc()) ?? emptyDoc() });
          return;
        }
        if (type === "snapshot") {
          const doc = sanitizeDoc(message.doc);
          if (doc) handlers.onSnapshot(doc);
          return;
        }
        if (type === "op") {
          if (cid === clientId) return;
          const op = sanitizeOp(message.op);
          if (op) handlers.onOp(op);
          return;
        }
        if (type === "error" && message.error === "READ_ONLY") readOnly = true;
      };
      ws.onclose = () => { joined = false; socket = null; if (!closed) scheduleRetry(); };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    } catch { scheduleRetry(); }
  };

  void connect();
  return {
    clientId,
    transport: "lan",
    sendOp: (op) => { if (readOnly) return; if (!joined || !send({ type: "op", canvasId, op })) push(op); },
    sendPresence: (cursor) => { lastCursor = cursor; if (joined) send({ type: "presence", canvasId, cursor }); },
    requestSnapshot: () => { if (joined) send({ type: "snapshot-request", canvasId }); },
    close: () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      joined = false;
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
    },
  };
}
