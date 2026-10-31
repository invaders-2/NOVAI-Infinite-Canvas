/**
 * 多人协作：复用旧画布的 reactCanvasCollab（宿主通道 canvas/collab；独立页 / 同机多窗口走 BroadcastChannel）。
 *
 * 新画布的 store 是整份文档替换式（mutate），协作层用「比对前后文档 → 生成 CanvasOp」的方式发出本地改动；
 * 收到远端 op 用 applyOp 套到当前文档上（不进撤销栈、不回发）。光标 / 在线成员走 presence。
 * 保存冲突时（另一端先存了）不再停掉自动保存：以当前文档为准，补上远端新增的节点后按远端版本号重存。
 */
import { applyOp, type CanvasDoc, type CanvasEdge, type CanvasNode, type CanvasOp } from "../react-canvas/reactCanvasStore";
import { createCollab, type Collab, type CollabHandlers, type PeerCursor } from "../react-canvas/reactCanvasCollab";
import type { CanvasStore } from "./store";

export type Peer = { id: string; cursor: PeerCursor | null; seenAt: number; name?: string };

const NODE_KEYS = ["x", "y", "w", "h", "text", "url", "originalUrl", "variants", "clips", "scene", "refUrl", "model", "ratio", "children", "data"] as const;
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** 两份文档的差异 → op 列表 */
export function diffDoc(prev: CanvasDoc, next: CanvasDoc, clientId: string): CanvasOp[] {
  const ops: CanvasOp[] = []; const ts = Date.now();
  const pn = new Map(prev.nodes.map((n) => [n.id, n])); const nn = new Map(next.nodes.map((n) => [n.id, n]));
  const removed = prev.nodes.filter((n) => !nn.has(n.id)).map((n) => n.id);
  if (removed.length) ops.push({ type: "remove-nodes", ids: removed });
  for (const n of next.nodes) {
    const o = pn.get(n.id);
    if (!o) { ops.push({ type: "add-node", node: n }); continue; }
    if (o === n) continue;
    const patch: Record<string, unknown> = {};
    for (const k of NODE_KEYS) if (!same((o as Record<string, unknown>)[k], (n as Record<string, unknown>)[k])) patch[k] = (n as Record<string, unknown>)[k];
    if (Object.keys(patch).length) ops.push({ type: "update-node", id: n.id, patch: patch as never, ts, clientId });
  }
  const pe = new Set(prev.edges.map((e) => e.id)); const ne = new Set(next.edges.map((e) => e.id));
  const goneE = prev.edges.filter((e) => !ne.has(e.id)).map((e) => e.id);
  if (goneE.length) ops.push({ type: "remove-edges", ids: goneE });
  next.edges.filter((e) => !pe.has(e.id)).forEach((edge: CanvasEdge) => ops.push({ type: "add-edge", edge }));
  const pc = new Set(prev.comments.map((c) => c.id)); const nc = new Set(next.comments.map((c) => c.id));
  prev.comments.filter((c) => !nc.has(c.id)).forEach((c) => ops.push({ type: "remove-comment", id: c.id }));
  next.comments.filter((c) => !pc.has(c.id)).forEach((comment) => ops.push({ type: "add-comment", comment }));
  // 评论被编辑 / 有了新回复：没有单独的 update 操作，按「删掉再加回」同步（id 不变）
  const before = new Map(prev.comments.map((c) => [c.id, c]));
  next.comments.forEach((c) => { const o = before.get(c.id); if (o && o !== c && !same(o, c)) { ops.push({ type: "remove-comment", id: c.id }); ops.push({ type: "add-comment", comment: c }); } });
  if (!same(prev.settings, next.settings) && next.settings) ops.push({ type: "update-settings", patch: next.settings });
  return ops;
}

/** 协作中心：一个文档 ↔ 若干条通道（宿主 / 同机窗口 + 可选的局域网会话） */
export type CollabHub = { handlers: () => CollabHandlers; addTransport: (c: Collab) => void; detach: () => void };

export function attachCollab(store: CanvasStore, opts: { forceLocal?: boolean } = {}): CollabHub {
  let applying = false; let last = store.state.doc; let timer: ReturnType<typeof setTimeout> | null = null;
  const seen = new Set(last.nodes.map((n) => n.id));
  const peers = new Map<string, Peer>(); const transports: Collab[] = [];
  const publishPeers = () => store.setCollab({ peers: [...peers.values()].sort((a, b) => a.id.localeCompare(b.id)) });
  const flush = () => {
    timer = null; const next = store.state.doc; if (next === last) return;
    const ops = diffDoc(last, next, transports[0]?.clientId || "local"); last = next; next.nodes.forEach((n) => seen.add(n.id));
    for (const op of ops) for (const t of transports) { try { t.sendOp(op); } catch { /* 单条通道失败不影响其它 */ } }
  };
  const handlers = (): CollabHandlers => ({
    getDoc: () => store.state.doc,
    onOp: (op) => {
      if (timer) { clearTimeout(timer); flush(); } // 先把本地待发的改动发出去，再套远端
      applying = true;
      try { store.applyRemote((d) => applyOp(d, op)); } finally { applying = false; }
      last = store.state.doc; last.nodes.forEach((n) => seen.add(n.id));
    },
    onSnapshot: (remote) => {
      // 只有本地空白、对方有内容时才采用对方快照（新打开的窗口追上进度）
      if (store.state.doc.nodes.length || !remote.nodes.length) return;
      applying = true; try { store.applyRemote(() => remote); } finally { applying = false; } last = store.state.doc;
    },
    onPresence: (id, cursor) => { peers.set(id, { id, cursor, seenAt: Date.now() }); publishPeers(); },
    onJoin: (id) => { peers.set(id, { id, cursor: null, seenAt: Date.now() }); publishPeers(); },
  });
  const addTransport = (c: Collab) => { transports.push(c); store.setCollab({ clientId: transports[0].clientId, transport: transports.map((t) => t.transport).join("+") }); c.requestSnapshot(); c.sendPresence(null); };
  try { addTransport(createCollab(store.state.canvasId, handlers(), { forceLocal: !!opts.forceLocal })); } catch { /* 没有可用通道：单机使用 */ }
  store.rebase = (ours, remote) => {
    // 冲突重存：当前文档为准，补上对方新增、我们从没见过的节点 / 连线
    const mine = new Set(ours.nodes.map((n) => n.id)); const extra: CanvasNode[] = remote.nodes.filter((n) => !mine.has(n.id) && !seen.has(n.id));
    const myE = new Set(ours.edges.map((e) => e.id)); const ids = new Set([...mine, ...extra.map((n) => n.id)]);
    const extraE = remote.edges.filter((e) => !myE.has(e.id) && ids.has(e.from) && ids.has(e.to));
    return extra.length || extraE.length ? { ...ours, nodes: [...ours.nodes, ...extra], edges: [...ours.edges, ...extraE] } : ours;
  };
  const off = store.subscribe(() => {
    if (applying || !transports.length) return;
    if (store.state.doc !== last && !timer) timer = setTimeout(flush, 60);
  });
  const prune = setInterval(() => { const now = Date.now(); let ch = false; peers.forEach((p, k) => { if (now - p.seenAt > 6000) { peers.delete(k); ch = true; } }); if (ch) publishPeers(); }, 1500);
  // 光标：画布坐标，节流 80ms；每 3 秒心跳一次（带上最后的位置）
  let lastCur = 0; let cur: PeerCursor | null = null;
  const send = (c: PeerCursor | null) => transports.forEach((t) => { try { t.sendPresence(c); } catch { /* ignore */ } });
  const onMove = (e: Event) => { const d = (e as CustomEvent).detail as PeerCursor | null; cur = d; const now = Date.now(); if (d && now - lastCur < 80) return; lastCur = now; send(d); };
  window.addEventListener("cn:cursor", onMove);
  const beat = setInterval(() => send(cur), 3000);
  const detach = () => { if (timer) { clearTimeout(timer); flush(); } off(); clearInterval(prune); clearInterval(beat); window.removeEventListener("cn:cursor", onMove); transports.forEach((t) => { try { t.close(); } catch { /* ignore */ } }); transports.length = 0; store.rebase = null; store.setCollab({ peers: [], transport: null, clientId: null }); };
  return { handlers, addTransport, detach };
}
