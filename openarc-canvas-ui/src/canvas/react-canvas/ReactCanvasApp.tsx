import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  Box,
  Clipboard,
  Copy,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  CopyPlus,
  Film,
  Globe,
  History as HistoryIcon,
  Image as ImageIcon,
  Images,
  LayoutGrid,
  Layers,
  Maximize2,
  Mic,
  MoreHorizontal,
  Library,
  LayoutTemplate,
  MessageCircle,
  MessageSquare,
  Minus,
  Music,
  PanelLeft,
  Pencil,
  Plug,
  Plus,
  FileText,
  Folder,
  ShieldCheck,
  Paperclip,
  Lightbulb,
  Check,
  Redo2,
  Search,
  Send,
  RefreshCw,
  Square,
  Wrench,
  Download,
  Settings,
  Share2,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  Upload,
  User,
  Video,
  Wand2,
  X,
} from "lucide-react";
import type { Window as WinDomain } from "../../../electron/window-domain.ts";
import { createCollab, type Collab, type PeerCursor, type PeerState } from "./reactCanvasCollab";
import { StudioHome } from "../studio/StudioHome";
import { AssetsPanel } from "./AssetsPanel";
import { buildCanvasModelLabelIndex, canvasModelBaseName } from "../canvasModelLabels";
import { CanvasInvitePanel } from "../CanvasInvitePanel";
import { CanvasSharePanel } from "../CanvasSharePanel";
import { LanCollabPanel, type LanJoinInfo } from "./LanCollabPanel";
import { FeedbackDialog } from "./FeedbackDialog";
import { createLanCollab } from "./reactCanvasLan";
import { HistoryPanel } from "./HistoryPanel";
import { TemplatesPanel } from "./TemplatesPanel";
import { ReactCanvas, type ReactCanvasHandle } from "./ReactCanvas";
import {
  applyOp,
  emptyDoc,
  hasContent,
  makeGroupNode,
  makeId,
  makeNode,
  NODE_KIND_LABEL,
  NODE_SIZE,
  normalizeCanvasId,
  type CanvasSettings,
  readDoc,
  sanitizeDoc,
  writeDoc,
  type CanvasComment,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type CanvasOp,
  type NodeKind,
} from "./reactCanvasStore";
import { migrateLegacyDoc } from "./migration";
import { backupLegacyDoc, loadDoc, saveDoc } from "./persistence";
import "./reactCanvas.css";

if (typeof window !== "undefined") {
  const hooks = window as unknown as {
    __openarcCanvasMigrate?: typeof migrateLegacyDoc;
    __openarcCanvasPersistence?: { loadDoc: typeof loadDoc; saveDoc: typeof saveDoc };
  };
  hooks.__openarcCanvasMigrate = migrateLegacyDoc;
  hooks.__openarcCanvasPersistence = { loadDoc, saveDoc };
}

type PanelId = "search" | "assets" | "templates" | "comments" | "history" | "me";
type AgentMessage = { id: string; role: "assistant" | "user"; text: string };
type AgentConversation = { id: string; title: string; messages: AgentMessage[]; draft: string; at: number };
const AGENT_HISTORY_KEY = "openarc-canvas-react:agent-history";
const AGENT_HISTORY_MAX = 20;
function readAgentHistory(): AgentConversation[] {
  try {
    const raw = window.localStorage.getItem(AGENT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is AgentConversation => !!item && typeof item === "object").slice(0, AGENT_HISTORY_MAX) : [];
  } catch { return []; }
}
function writeAgentHistory(list: AgentConversation[]): void {
  try { window.localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify(list.slice(0, AGENT_HISTORY_MAX))); } catch { return; }
}
type HistoryEntry = { before: CanvasDoc; after: CanvasDoc };

function nodeSignature(node: CanvasNode): string {
  return JSON.stringify([node.kind, node.x, node.y, node.w, node.h, node.text, node.children || null]);
}

function edgeSignature(edge: CanvasEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.fromSide || null]);
}

function collectHistoryDiff(before: CanvasDoc, after: CanvasDoc): { nodeIds: string[]; edgeIds: string[] } {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const nodeIds: string[] = [];
  Array.from(new Set(Array.from(beforeNodes.keys()).concat(Array.from(afterNodes.keys())))).forEach((id) => {
    const a = beforeNodes.get(id);
    const b = afterNodes.get(id);
    if (!a || !b || nodeSignature(a) !== nodeSignature(b)) nodeIds.push(id);
  });
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const edgeIds: string[] = [];
  Array.from(new Set(Array.from(beforeEdges.keys()).concat(Array.from(afterEdges.keys())))).forEach((id) => {
    const a = beforeEdges.get(id);
    const b = afterEdges.get(id);
    if (!a || !b || edgeSignature(a) !== edgeSignature(b)) edgeIds.push(id);
  });
  return { nodeIds, edgeIds };
}

function buildRestoreOps(
  target: CanvasDoc,
  current: CanvasDoc,
  nodeIds: string[],
  edgeIds: string[],
): CanvasOp[] {
  const ops: CanvasOp[] = [];
  const targetNodes = new Map(target.nodes.map((node) => [node.id, node]));
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  nodeIds.forEach((id) => {
    const want = targetNodes.get(id);
    const have = currentNodes.get(id);
    if (want && !have) {
      ops.push({ type: "add-node", node: want });
      return;
    }
    if (!want && have) {
      ops.push({ type: "remove-nodes", ids: [id] });
      return;
    }
    if (!want || !have || nodeSignature(want) === nodeSignature(have)) return;
    ops.push({
      type: "update-node",
      id,
      patch: {
        x: want.x,
        y: want.y,
        w: want.w,
        h: want.h,
        text: want.text,
        ...(want.kind === "group" ? { children: want.children || [] } : {}),
      },
    });
  });
  const targetEdges = new Map(target.edges.map((edge) => [edge.id, edge]));
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));
  edgeIds.forEach((id) => {
    const want = targetEdges.get(id);
    const have = currentEdges.get(id);
    if (want && !have) ops.push({ type: "add-edge", edge: want });
    else if (!want && have) ops.push({ type: "remove-edges", ids: [id] });
    else if (want && have && edgeSignature(want) !== edgeSignature(have)) {
      ops.push({ type: "remove-edges", ids: [id] });
      ops.push({ type: "add-edge", edge: want });
    }
  });
  return ops;
}

type HistoryState = { past: HistoryEntry[]; future: HistoryEntry[] };

const PANEL_TITLE: Record<PanelId, string> = {
  search: "搜索",
  assets: "素材",
  templates: "模板",
  comments: "评论",
  history: "历史",
  me: "匿名身份",
};

const ASSISTANT_INTRO =
  "本地画布助手 · 未接入模型。可用指令：添加图片节点、添加文本节点、添加便签节点、清空画布、撤销、重做、适应视图。";
const AGENT_SUGGESTIONS = [
  { title: "生成角色三视图", desc: "用统一风格生成角色正面、侧面与背面设定" },
  { title: "为产品做宣传海报", desc: "根据产品卖点生成一张竖版宣传海报" },
  { title: "搭建电影感场景", desc: "生成带镜头说明的场景概念图" },
  { title: "整理画布为故事板", desc: "把当前节点整理成分镜顺序并补齐说明" },
];
const QUICK_COMMANDS = ["添加图片节点", "添加文本节点", "添加便签节点", "清空画布", "撤销", "适应视图"];

const ALIGN_BUTTONS: Array<{
  mode: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdist" | "vdist";
  label: string;
  short: string;
}> = [
  { mode: "left", label: "左对齐", short: "左" },
  { mode: "hcenter", label: "水平居中", short: "横中" },
  { mode: "right", label: "右对齐", short: "右" },
  { mode: "hdist", label: "横向等间距", short: "横距" },
  { mode: "top", label: "顶对齐", short: "上" },
  { mode: "vcenter", label: "垂直居中", short: "纵中" },
  { mode: "bottom", label: "底对齐", short: "下" },
  { mode: "vdist", label: "纵向等间距", short: "纵距" },
];

type CanvasEntry = { id: string; title: string };
type CanvasEntryMeta = CanvasEntry & { updatedAt?: number };
let sharedCanvasList: CanvasEntryMeta[] | null = null;
let sharedCanvasListRequest: Promise<CanvasEntryMeta[]> | null = null;
if (typeof window !== "undefined") {
  (window as unknown as { __openarcCanvasListClear?: () => void }).__openarcCanvasListClear = () => {
    sharedCanvasList = null;
    sharedCanvasListRequest = null;
  };
}

const LOCAL_LIST_KEY = "openarc-canvas-react:list";

type CanvasBridge = { command: (command: Record<string, unknown>) => Promise<Record<string, unknown>> };

function canvasBridge(): CanvasBridge | null {
  const bridge = (window as unknown as { openarc?: { canvas?: CanvasBridge } }).openarc?.canvas;
  return bridge && typeof bridge.command === "function" ? bridge : null;
}

function readLocalList(): CanvasEntry[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({ id: normalizeCanvasId(String(item.id || "")), title: String(item.title || "未命名画布") }))
      .filter((entry) => entry.id !== "default");
  } catch {
    return [];
  }
}

function writeLocalList(entries: CanvasEntry[]): void {
  try {
    window.localStorage.setItem(LOCAL_LIST_KEY, JSON.stringify(entries.slice(0, 50)));
  } catch {
    return;
  }
}

function withEntry(list: CanvasEntry[], entry: CanvasEntry): CanvasEntry[] {
  const rest = list.filter((item) => item.id !== entry.id);
  return [entry].concat(rest).slice(0, 50);
}

function canvasFromWin(win?: WinDomain): CanvasEntry | null {
  const loose = win as unknown as { canvasId?: unknown; meta?: Record<string, unknown> } | undefined;
  const fromWin = loose?.canvasId ?? loose?.meta?.canvasId;
  if (typeof fromWin === "string" && fromWin.trim()) {
    const metaTitle = loose?.meta?.title;
    return { id: normalizeCanvasId(fromWin), title: typeof metaTitle === "string" && metaTitle.trim() ? metaTitle : "画布" };
  }
  const query = new URLSearchParams(window.location.search).get("canvas");
  if (query) {
    const id = normalizeCanvasId(query);
    return { id, title: "画布 " + id };
  }
  return null;
}

function sameCursor(a: PeerCursor | null, b: PeerCursor | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function readDefaultCanvasSettings(): CanvasSettings {
  let gridSnap = false;
  try { gridSnap = window.localStorage.getItem("openarc-canvas-react:grid-snap") === "1"; } catch { gridSnap = false; }
  return { gridSnap, hideEdges: false, batchMode: "variants", voiceEnabled: false };
}

type SearchChip = "all" | "image" | "video" | "text" | "audio" | "world" | "group";
const SEARCH_CHIPS: Array<{ id: SearchChip; label: string }> = [
  { id: "all", label: "全部" },
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "text", label: "文本" },
  { id: "audio", label: "音频" },
  { id: "world", label: "World" },
  { id: "group", label: "分组" },
];

function searchChipIcon(id: SearchChip) {
  if (id === "image") return <ImageIcon size={14} />;
  if (id === "video") return <Video size={14} />;
  if (id === "text") return <Type size={14} />;
  if (id === "audio") return <Music size={14} />;
  if (id === "world") return <Globe size={14} />;
  if (id === "group") return <Layers size={14} />;
  return <LayoutGrid size={14} />;
}

function searchNodeTitle(node: CanvasNode): string {
  if (node.kind === "image") return "图片";
  if (node.kind === "group") return "分组";
  const first = node.text.split("\n")[0].trim();
  if (first) return first.slice(0, 40);
  return node.kind === "text" ? "未命名文本" : "未命名便签";
}

function searchNodeSummary(node: CanvasNode): string {
  if (node.kind === "image") return "图片节点";
  if (node.kind === "group") return (node.children ? node.children.length : 0) + " 个节点";
  const lines = node.text.split("\n");
  const rest = lines.slice(1).join(" ").trim();
  if (rest) return rest.slice(0, 60);
  const first = lines[0].trim();
  return first ? first.slice(0, 60) : NODE_KIND_LABEL[node.kind] + "节点";
}

function kindIcon(kind: NodeKind) {
  if (kind === "image") return <ImageIcon size={15} />;
  if (kind === "video") return <Video size={15} />;
  if (kind === "audio") return <Music size={15} />;
  if (kind === "text") return <Type size={15} />;
  return <StickyNote size={15} />;
}

export function ReactCanvasApp({ win, onOpenMcpCenter, onOpenModelSettings, onOpenSettings, onBackToWorkspace }: {
  win?: WinDomain; onOpenMcpCenter?: () => void; onOpenModelSettings?: () => void; onOpenSettings?: () => void; onBackToWorkspace?: () => void;
  /** 外壳的「打开指定画布」（市场立即体验）：旧版画布不认这两个参数，收下即可，不要报错 */
  openCanvasId?: string; onCanvasOpened?: (canvasId?: string) => void;
}) {
  const fixed = useMemo(() => canvasFromWin(win), [win]);
  const [active, setActive] = useState<CanvasEntry | null>(fixed);
  const [showCanvasPicker, setShowCanvasPicker] = useState(false);
  useEffect(() => {
    setActive(fixed);
  }, [fixed]);
  const canvas = active || fixed;
  if (!canvas && !showCanvasPicker) return <StudioHome onOpenSettings={onOpenModelSettings} onOpenCanvas={() => setShowCanvasPicker(true)} />;
  if (!canvas) return <CanvasPicker onOpen={setActive} />;
  return (
    <CanvasWorkspace
      key={canvas.id}
      canvasId={canvas.id}
      title={canvas.title}
      canSwitch={true}
      onSelectCanvas={(entry) => setActive(entry)}
      onOpenMcpCenter={onOpenMcpCenter}
      onOpenModelSettings={onOpenModelSettings}
      onOpenSettings={onOpenSettings}
      onBackToWorkspace={onBackToWorkspace}
    />
  );
}

function CanvasWorkspace({
  canvasId,
  title,
  canSwitch,
  onSelectCanvas,
  onOpenMcpCenter,
  onOpenModelSettings,
  onOpenSettings,
  onBackToWorkspace,
}: {
  canvasId: string;
  title: string;
  canSwitch: boolean;
  onSelectCanvas: (entry: CanvasEntry) => void;
  onOpenMcpCenter?: () => void;
  onOpenModelSettings?: () => void;
  onOpenSettings?: () => void;
  onBackToWorkspace?: () => void;
}) {
  const [doc, setDocState] = useState<CanvasDoc>(() => readDoc(canvasId) ?? emptyDoc());
  const docRef = useRef(doc);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [history, setHistoryState] = useState<HistoryState>({ past: [], future: [] });
  const historyRef = useRef(history);
  const activeEntryRef = useRef<HistoryEntry | null>(null);
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentSidebarOpen, setAgentSidebarOpen] = useState(false);
  const [agentSidebarTab, setAgentSidebarTab] = useState<"files" | "outputs">("files");
  const [agentMenu, setAgentMenu] = useState<"history" | "more" | null>(null);
  const [agentFullscreen, setAgentFullscreen] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [agentHistory, setAgentHistory] = useState<AgentConversation[]>(() => readAgentHistory());
  const [undoMessages, setUndoMessages] = useState<AgentMessage[] | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [plusOpen, setPlusOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [confirmMode, setConfirmMode] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [references, setReferences] = useState<Array<{ id: string; label: string }>>([]);
  const [canvasSettingsOpen, setCanvasSettingsOpen] = useState(false);
  const [imageModels, setImageModels] = useState<Array<{ label: string; configId: string; providerName?: string }>>([]);
  const [selectedConfigs, setSelectedConfigs] = useState<Record<string, string>>({ image: "", video: "", audio: "", chat: "" });
  const [has3dModel, setHas3dModel] = useState(false);
  const [agentName] = useState(() => window.localStorage.getItem("openarc-display-name") || window.localStorage.getItem("openarc:display-name") || "创作者");
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [videoModels, setVideoModels] = useState<Array<{ label: string; configId: string; providerName?: string }>>([]);
  const [chatModels, setChatModels] = useState<Array<{ label: string; configId: string; providerName?: string }>>([]);
  const [audioModels, setAudioModels] = useState<Array<{ label: string; configId: string; providerName?: string }>>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [voiceInterim, setVoiceInterim] = useState("");
  const voiceBaseDraftRef = useRef("");
  const voiceRecognitionFailedRef = useRef(false);
  const voiceHasRecognitionRef = useRef(false);
  const voiceFinalAppliedRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceRecognitionRef = useRef<{ stop: () => void } | null>(null);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceTranscriptRef = useRef("");
  const streamRequestRef = useRef("");
  const streamRunRef = useRef("");
  const streamAssistantRef = useRef("");
  const lastPromptRef = useRef("");
  const streamOffRef = useRef<(() => void) | null>(null);
  const [generation, setGeneration] = useState<Record<string, { status: "pending" | "error"; error?: string }>>({});
  const addUploadRef = useRef<HTMLInputElement | null>(null);
  const [appUploadError, setAppUploadError] = useState("");
  const [identityOpen, setIdentityOpen] = useState(false);
  const [identityCopied, setIdentityCopied] = useState(false);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [commentMode, setCommentMode] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareNonce, setShareNonce] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState<{ text: string; error: boolean } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [shareCanManage, setShareCanManage] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usage, setUsage] = useState<{ calls: number; tokens: number; lastCallAt: number | null } | null>(null);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [nodeMenuMulti, setNodeMenuMulti] = useState(false);
  const [deletingNodeIds, setDeletingNodeIds] = useState<Set<string>>(new Set());
  const imagePollEpochRef = useRef(0);
  const deleteTimersRef = useRef<Record<string, number>>({});
  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
  const imagePollTokensRef = useRef<Record<string, number>>({});
  const [connectAgent, setConnectAgent] = useState("claude");
  const [connectToast, setConnectToast] = useState("");
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [canvasList, setCanvasList] = useState<CanvasEntryMeta[]>([]);
  const [canvasListLoading, setCanvasListLoading] = useState(false);
  const [canvasListError, setCanvasListError] = useState("");
  const [creatingCanvas, setCreatingCanvas] = useState(false);
  const [newCanvasTitle, setNewCanvasTitle] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [pendingComment, setPendingComment] = useState<{ x: number; y: number } | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const agentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuAt, setAddMenuAt] = useState<{ x: number; y: number } | null>(null);
  const addMenuClampedRef = useRef(false);
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackNodeId, setFeedbackNodeId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [searchChip, setSearchChip] = useState<SearchChip>("all");
  const [studioMode, setStudioMode] = useState(true);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [clientId, setClientId] = useState("");
  const canvasRef = useRef<ReactCanvasHandle | null>(null);
  const collabRef = useRef<Collab | null>(null);
  const lanCollabRef = useRef<Collab | null>(null);
  const clientIdRef = useRef("");
  const fieldStampsRef = useRef<Map<string, Map<string, { ts: number; clientId: string }>>>(new Map());
  const lanReadOnlyRef = useRef(false);
  const [lanSession, setLanSession] = useState<{ readOnly: boolean; canvasId: string } | null>(null);
  const persistTimer = useRef<number | null>(null);
  const versionRef = useRef<number | null>(null);
  const conflictRef = useRef(false);
  const [saveState, setSaveState] = useState<{
    state: "idle" | "local" | "saving" | "saved" | "conflict" | "error";
    text: string;
  }>({ state: "idle", text: "" });
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[] } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const nodeMenuRef = useRef<HTMLDivElement | null>(null);


  const setDoc = (next: CanvasDoc) => {
    docRef.current = next;
    setDocState(next);
  };
  const setHistory = (next: HistoryState) => {
    historyRef.current = next;
    setHistoryState(next);
  };

  const persistDoc = async () => {
    const snapshot = docRef.current;
    if (conflictRef.current) return;
    setSaveState({ state: "saving", text: "保存中…" });
    const result = await saveDoc(canvasId, snapshot, versionRef.current);
    if (result.ok) {
      versionRef.current = result.version;
      setSaveState(
        result.source === "local"
          ? { state: "local", text: "本地存储" }
          : { state: "saved", text: "已保存（revision " + (result.version ?? "-") + "）" },
      );
      return;
    }
    if (result.conflict) {
      conflictRef.current = true;
      setSaveState({ state: "conflict", text: "版本冲突：已在别处修改，本地内容未覆盖" });
      return;
    }
    setSaveState({ state: "error", text: "保存失败：" + result.error });
  };

  const schedulePersist = () => {
    writeDoc(canvasId, docRef.current);
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      void persistDoc();
    }, 400);
  };

  const flushLocal = () => {
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    writeDoc(canvasId, docRef.current);
    if (conflictRef.current) return;
    void saveDoc(canvasId, docRef.current, versionRef.current).then((result) => {
      if (result.ok) versionRef.current = result.version;
    });
  };

  useEffect(() => {
    if (!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) return;
    (window as unknown as { __openarcTestDispatch?: (op: unknown) => void }).__openarcTestDispatch = (op) => dispatch(op as CanvasOp, { history: false });
    (window as unknown as { __openarcTestReplaceDoc?: (doc: unknown) => void }).__openarcTestReplaceDoc = (raw) => {
      const parsed = sanitizeDoc(raw);
      if (parsed) dispatch({ type: "replace", doc: parsed }, { history: false });
    };
    return () => { delete (window as unknown as { __openarcTestReplaceDoc?: (doc: unknown) => void }).__openarcTestReplaceDoc; };
  }, []);

  const stampFields = (nodeId: string, patch: Record<string, unknown>, ts: number, clientId: string) => {
    let fields = fieldStampsRef.current.get(nodeId);
    if (!fields) { fields = new Map(); fieldStampsRef.current.set(nodeId, fields); }
    for (const key of Object.keys(patch)) fields.set(key, { ts, clientId });
  };
  const fieldWins = (nodeId: string, field: string, ts: number, clientId: string) => {
    const current = fieldStampsRef.current.get(nodeId)?.get(field);
    if (!current) return true;
    if (ts !== current.ts) return ts > current.ts;
    return clientId > current.clientId;
  };
  const applyRemoteOp = (op: CanvasOp) => {
    if (op.type === "remove-nodes") {
      op.ids.forEach((id) => fieldStampsRef.current.delete(id));
      const next = applyOp(docRef.current, op);
      if (next !== docRef.current) { setDoc(next); schedulePersist(); }
      return;
    }
    if (op.type !== "update-node") {
      const next = applyOp(docRef.current, op);
      if (next !== docRef.current) { setDoc(next); schedulePersist(); }
      return;
    }
    const ts = Number.isFinite(Number(op.ts)) ? Number(op.ts) : Date.now();
    const remoteClient = String(op.clientId || "");
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(op.patch || {})) {
      if (fieldWins(op.id, field, ts, remoteClient)) patch[field] = value;
    }
    if (!Object.keys(patch).length) return;
    const next = applyOp(docRef.current, { type: "update-node", id: op.id, patch: patch as typeof op.patch });
    if (next === docRef.current) return;
    stampFields(op.id, patch, ts, remoteClient);
    setDoc(next);
    schedulePersist();
  };

  const dispatch = (op: CanvasOp, opts?: { history?: boolean; historyBase?: CanvasDoc }) => {
    if (lanReadOnlyRef.current) return;
    let stamped: CanvasOp = op.type === "update-node" ? { ...op, ts: Number.isFinite(Number(op.ts)) ? Number(op.ts) : Date.now(), clientId: op.clientId || clientIdRef.current } : op;
    if (stamped.type === "update-node" && stamped.patch) {
      const ts = Number(stamped.ts);
      const cid = String(stamped.clientId || "");
      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(stamped.patch)) if (fieldWins(stamped.id, field, ts, cid)) patch[field] = value;
      if (!Object.keys(patch).length) return;
      stamped = { ...stamped, patch: patch as typeof stamped.patch };
    }
    const prev = docRef.current;
    const next = applyOp(prev, stamped);
    if (next === prev) return;
    setDoc(next);
    if (opts && opts.history === false) {
      const active = activeEntryRef.current;
      if (active) active.after = next;
    } else {
      const base = (opts && opts.historyBase) || prev;
      const entry: HistoryEntry = { before: base, after: next };
      setHistory({ past: historyRef.current.past.concat([entry]).slice(-80), future: [] });
      activeEntryRef.current = entry;
      queueMicrotask(() => {
        activeEntryRef.current = null;
      });
    }
    if (stamped.type === "update-node") stampFields(stamped.id, stamped.patch || {}, Number(stamped.ts), String(stamped.clientId || ""));
    if (stamped.type === "remove-nodes") stamped.ids.forEach((id) => fieldStampsRef.current.delete(id));
    const collab = collabRef.current;
    if (collab) collab.sendOp(stamped);
    lanCollabRef.current?.sendOp(stamped);
    schedulePersist();
  };

  useEffect(() => { clientIdRef.current = clientId; }, [clientId]);

  useEffect(() => {
    const collab = createCollab(canvasId, {
      getDoc: () => docRef.current,
      onOp: (op) => applyRemoteOp(op),
      onSnapshot: (remote) => {
        if (hasContent(docRef.current) || !hasContent(remote)) return;
        setDoc(remote);
        schedulePersist();
      },
      onPresence: (peerId, cursor) => {
        setPeers((prev) => {
          const existing = prev[peerId];
          const seenAt = Date.now();
          if (existing && sameCursor(existing.cursor, cursor) && seenAt - existing.seenAt < 700) return prev;
          const next = Object.assign({}, prev);
          next[peerId] = { cursor, seenAt };
          return next;
        });
      },
    });
    collabRef.current = collab;
    setClientId(collab.clientId);
    collab.requestSnapshot();
    collab.sendPresence(null);
    const prune = window.setInterval(() => {
      const now = Date.now();
      setPeers((prev) => {
        let changed = false;
        const next: Record<string, PeerState> = {};
        Object.keys(prev).forEach((key) => {
          if (now - prev[key].seenAt < 4000) next[key] = prev[key];
          else changed = true;
        });
        return changed ? next : prev;
      });
    }, 1000);
    return () => {
      window.clearInterval(prune);
      collab.close();
      collabRef.current = null;
      flushLocal();
    };
  }, [canvasId]);

  // 打开画布：优先服务端文档；旧 smart-canvas 文档先迁移再保存；bridge 不可用则用本地副本。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hydrated = await loadDoc(canvasId);
      if (cancelled) return;
      versionRef.current = hydrated.version;
      if (hydrated.migrated && hydrated.rawLegacy !== undefined) backupLegacyDoc(canvasId, hydrated.rawLegacy);
      const serverDoc = hydrated.source === "bridge" && hasContent(hydrated.doc);
      if (serverDoc) setDoc(hydrated.doc);
      else if (!hasContent(docRef.current) && hasContent(hydrated.doc)) setDoc(hydrated.doc);
      if (hydrated.migrated) {
        setSaveState({ state: "saving", text: "正在迁移旧画布…" });
        const saved = await saveDoc(canvasId, docRef.current, hydrated.version);
        if (cancelled) return;
        if (saved.ok) {
          versionRef.current = saved.version;
          setSaveState({ state: "saved", text: "旧画布已迁移（revision " + (saved.version ?? "-") + "）" });
        } else if (saved.conflict) {
          conflictRef.current = true;
          setSaveState({ state: "conflict", text: "版本冲突：已在别处修改，本地内容未覆盖" });
        } else {
          setSaveState({ state: "error", text: "迁移保存失败：" + saved.error });
        }
        return;
      }
      if (hydrated.source === "bridge" && !hasContent(hydrated.doc) && hasContent(docRef.current)) {
        const uploaded = await saveDoc(canvasId, docRef.current, hydrated.version);
        if (cancelled) return;
        if (uploaded.ok) {
          versionRef.current = uploaded.version;
          setSaveState({ state: "saved", text: "已上传本地画布（revision " + (uploaded.version ?? "-") + "）" });
        } else if (uploaded.conflict) {
          conflictRef.current = true;
          setSaveState({ state: "conflict", text: "版本冲突：已在别处修改，本地内容未覆盖" });
        } else {
          setSaveState({ state: "error", text: "上传失败：" + uploaded.error });
        }
        return;
      }
      if (hydrated.source === "local") {
        setSaveState({ state: "local", text: hydrated.error ? "本地暂存（服务端不可用）" : "本地存储" });
        return;
      }
      if (serverDoc && hydrated.version != null) {
        setSaveState({ state: "saved", text: "已同步（revision " + hydrated.version + "）" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canvasId]);

  useEffect(() => {
    const flush = () => flushLocal();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [canvasId]);

  const applyRestore = (target: CanvasDoc, diff: { nodeIds: string[]; edgeIds: string[] }) => {
    const ops = buildRestoreOps(target, docRef.current, diff.nodeIds, diff.edgeIds);
    ops.forEach((op) => {
      const prev = docRef.current;
      const next = applyOp(prev, op);
      if (next === prev) return;
      setDoc(next);
      const collab = collabRef.current;
      if (collab) collab.sendOp(op);
    });
    if (ops.length) schedulePersist();
  };

  const undo = () => {
    const current = historyRef.current;
    if (!current.past.length) return;
    const entry = current.past[current.past.length - 1];
    applyRestore(entry.before, collectHistoryDiff(entry.before, entry.after));
    setHistory({ past: current.past.slice(0, -1), future: [entry].concat(current.future).slice(0, 80) });
  };

  const redo = () => {
    const current = historyRef.current;
    if (!current.future.length) return;
    const entry = current.future[0];
    applyRestore(entry.after, collectHistoryDiff(entry.before, entry.after));
    setHistory({ past: current.past.concat([entry]).slice(-80), future: current.future.slice(1) });
  };

  const deleteSelection = () => {
    if (selectedEdgeId) {
      dispatch({ type: "remove-edges", ids: [selectedEdgeId] });
      setSelectedEdgeId(null);
      return;
    }
    if (selectedNodeIds.length) {
      const ids = [...selectedNodeIds];
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        dispatch({ type: "remove-nodes", ids });
        setSelectedNodeIds([]);
        return;
      }
      setDeletingNodeIds((prev) => new Set([...prev, ...ids]));
      setSelectedNodeIds([]);
      ids.forEach((id) => {
        pendingDeleteIdsRef.current.add(id);
        deleteTimersRef.current[id] = window.setTimeout(() => {
          pendingDeleteIdsRef.current.delete(id); delete deleteTimersRef.current[id];
          dispatch({ type: "remove-nodes", ids: [id] });
          setDeletingNodeIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
        }, 160);
      });
    }
  };

  const selectAllNodes = () => {
    setSelectedNodeIds(docRef.current.nodes.map((node) => node.id));
    setSelectedEdgeId(null);
  };

  const copySelection = () => {
    const ids = new Set(selectedNodeIds);
    const nodes = docRef.current.nodes.filter((node) => ids.has(node.id));
    if (!nodes.length) return;
    const edges = docRef.current.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    clipboardRef.current = { nodes: nodes.map((node) => ({ ...node })), edges: edges.map((edge) => ({ ...edge })) };
  };

  const cloneIntoCanvas = (source: { nodes: CanvasNode[]; edges: CanvasEdge[] }, dx: number, dy: number) => {
    if (!source.nodes.length) return;
    const base = docRef.current;
    const idMap = new Map<string, string>();
    source.nodes.forEach((node) => idMap.set(node.id, makeId("n")));
    source.nodes.forEach((node, index) => {
      dispatch(
        {
          type: "add-node",
          node: { ...node, id: idMap.get(node.id) || makeId("n"), x: Math.round(node.x + dx), y: Math.round(node.y + dy) },
        },
        index === 0 ? { history: true, historyBase: base } : { history: false },
      );
    });
    source.edges.forEach((edge) => {
      const from = idMap.get(edge.from);
      const to = idMap.get(edge.to);
      if (!from || !to) return;
      dispatch(
        { type: "add-edge", edge: { id: makeId("e"), from, to, ...(edge.fromSide ? { fromSide: edge.fromSide } : {}) } },
        { history: false },
      );
    });
    setSelectedNodeIds(source.nodes.map((node) => idMap.get(node.id) || "").filter(Boolean));
    setSelectedEdgeId(null);
  };

  const pasteClipboard = () => {
    const clip = clipboardRef.current;
    if (!clip || !clip.nodes.length) return;
    const lastPoint = canvasRef.current ? canvasRef.current.lastWorldPoint() : null;
    const center = lastPoint || (canvasRef.current ? canvasRef.current.centerWorld() : { x: 0, y: 0 });
    const xs = clip.nodes.map((node) => node.x);
    const ys = clip.nodes.map((node) => node.y);
    const cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    const cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
    cloneIntoCanvas(clip, center.x - cx, center.y - cy);
  };

  const duplicateSelection = () => {
    const ids = new Set(selectedNodeIds);
    const nodes = docRef.current.nodes.filter((node) => ids.has(node.id));
    if (!nodes.length) return;
    const edges = docRef.current.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    cloneIntoCanvas({ nodes: nodes.map((node) => ({ ...node })), edges: edges.map((edge) => ({ ...edge })) }, 20, 20);
  };

  const selectedNodesOf = () => {
    const ids = new Set(selectedNodeIds);
    return docRef.current.nodes.filter((node) => ids.has(node.id));
  };

  const alignTargets = () => selectedNodesOf().filter((node) => node.kind !== "group");

  const applyNodeMoves = (moves: Array<{ id: string; x: number; y: number }>) => {
    if (!moves.length) return;
    const base = docRef.current;
    moves.forEach((move, index) => {
      dispatch(
        { type: "update-node", id: move.id, patch: { x: Math.round(move.x), y: Math.round(move.y) } },
        index === 0 ? { history: true, historyBase: base } : { history: false },
      );
    });
  };

  const groupSelection = () => {
    const chosen = selectedNodesOf().filter((node) => node.kind !== "group");
    if (!chosen.length) return;
    const group = makeGroupNode(chosen);
    dispatch({ type: "add-node", node: group });
    setSelectedNodeIds([group.id]);
    setSelectedEdgeId(null);
    setNodeMenu(null);
  };

  const ungroupSelection = () => {
    const groups = selectedNodesOf().filter((node) => node.kind === "group");
    if (!groups.length) return;
    const childIds = groups.reduce((acc: string[], group) => acc.concat(group.children || []), []);
    dispatch({ type: "remove-nodes", ids: groups.map((group) => group.id) });
    setSelectedNodeIds(childIds);
    setSelectedEdgeId(null);
    setNodeMenu(null);
  };

  const deleteGroupWithChildren = (groupId: string) => {
    const group = docRef.current.nodes.find((node) => node.id === groupId);
    if (!group || group.kind !== "group") return;
    dispatch({ type: "remove-nodes", ids: [groupId].concat(group.children || []) });
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    setNodeMenu(null);
  };

  const alignSelection = (mode: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdist" | "vdist") => {
    const list = alignTargets();
    if (list.length < 2 || ((mode === "hdist" || mode === "vdist") && list.length < 3)) return;
    const rects = new Map(list.map((node) => [node.id, { x: node.x, y: node.y, w: node.w, h: node.h }]));
    const all = Array.from(rects.values());
    const minX = Math.min.apply(null, all.map((rect) => rect.x));
    const maxX = Math.max.apply(null, all.map((rect) => rect.x + rect.w));
    const minY = Math.min.apply(null, all.map((rect) => rect.y));
    const maxY = Math.max.apply(null, all.map((rect) => rect.y + rect.h));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const moves: Array<{ id: string; x: number; y: number }> = [];
    if (mode === "hdist" || mode === "vdist") {
      const horizontal = mode === "hdist";
      const sorted = list
        .slice()
        .sort((a, b) => (horizontal ? rects.get(a.id)!.x - rects.get(b.id)!.x : rects.get(a.id)!.y - rects.get(b.id)!.y));
      const total = sorted.reduce((sum, node) => sum + (horizontal ? node.w : node.h), 0);
      const span = horizontal ? maxX - minX : maxY - minY;
      const gap = (span - total) / Math.max(1, sorted.length - 1);
      let cursor = horizontal ? minX : minY;
      sorted.forEach((node) => {
        const rect = rects.get(node.id)!;
        moves.push(horizontal ? { id: node.id, x: cursor, y: rect.y } : { id: node.id, x: rect.x, y: cursor });
        cursor += (horizontal ? rect.w : rect.h) + gap;
      });
    } else {
      list.forEach((node) => {
        const rect = rects.get(node.id)!;
        if (mode === "left") moves.push({ id: node.id, x: minX, y: rect.y });
        else if (mode === "right") moves.push({ id: node.id, x: maxX - rect.w, y: rect.y });
        else if (mode === "hcenter") moves.push({ id: node.id, x: cx - rect.w / 2, y: rect.y });
        else if (mode === "top") moves.push({ id: node.id, x: rect.x, y: minY });
        else if (mode === "bottom") moves.push({ id: node.id, x: rect.x, y: maxY - rect.h });
        else if (mode === "vcenter") moves.push({ id: node.id, x: rect.x, y: cy - rect.h / 2 });
      });
    }
    applyNodeMoves(moves);
  };

  const arrangeGrid = () => {
    const list = alignTargets();
    if (list.length < 2) return;
    const columns = Math.ceil(Math.sqrt(list.length));
    const gap = 24;
    const cellW = Math.max.apply(null, list.map((node) => node.w));
    const cellH = Math.max.apply(null, list.map((node) => node.h));
    const startX = Math.min.apply(null, list.map((node) => node.x));
    const startY = Math.min.apply(null, list.map((node) => node.y));
    const sorted = list.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    applyNodeMoves(
      sorted.map((node, index) => ({
        id: node.id,
        x: startX + (index % columns) * (cellW + gap),
        y: startY + Math.floor(index / columns) * (cellH + gap),
      })),
    );
  };

  const clearCanvas = () => {
    if (!hasContent(docRef.current)) return;
    dispatch({ type: "replace", doc: emptyDoc() });
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
  };

  const addNodeAtCenter = (kind: NodeKind) => {
    const center = canvasRef.current ? canvasRef.current.centerWorld() : { x: 0, y: 0 };
    const size = NODE_SIZE[kind];
    const index = docRef.current.nodes.length;
    const column = index % 2;
    const row = Math.floor(index / 2) % 4;
    const node = makeNode(
      kind,
      center.x + 140 + column * (size.w + 40),
      center.y - size.h / 2 + row * (size.h + 40),
    );
    dispatch({ type: "add-node", node });
    setSelectedNodeIds([node.id]);
    setSelectedEdgeId(null);
    setAddMenuOpen(false);
    setPanel(null);
  };

  const pushMessage = (role: AgentMessage["role"], text: string) => {
    setMessages((prev) => prev.concat([{ id: "m_" + Math.random().toString(36).slice(2, 8), role, text }]));
  };

  const runCommand = (raw: string, skipConfirm = false) => {
    const text = raw.trim();
    if (confirmMode && !skipConfirm) {
      setPendingConfirm(text);
      return;
    }
    if (!text) return;
    pushMessage("user", text);
    const add = (kind: NodeKind, label: string) => {
      addNodeAtCenter(kind);
      pushMessage("assistant", "已添加" + label + "节点（本地操作，未接入模型）。");
    };
    if (/清空|清掉/.test(text)) {
      if (!hasContent(docRef.current)) pushMessage("assistant", "画布已经是空的。");
      else {
        clearCanvas();
        pushMessage("assistant", "已清空画布，可用撤销恢复。");
      }
    } else if (/图片/.test(text)) {
      add("image", "图片");
    } else if (/文本|文字/.test(text)) {
      add("text", "文本");
    } else if (/便签|便利贴/.test(text)) {
      add("note", "便签");
    } else if (/撤销|撤回/.test(text)) {
      undo();
      pushMessage("assistant", "已撤销一步。");
    } else if (/重做/.test(text)) {
      redo();
      pushMessage("assistant", "已重做一步。");
    } else if (/适应|全览|居中|视图/.test(text)) {
      if (canvasRef.current) canvasRef.current.fit();
      pushMessage("assistant", "已适应视图。");
    } else {
      pushMessage(
        "assistant",
        "本地助手未接入模型，只认这些固定指令：添加图片节点、添加文本节点、添加便签节点、清空画布、撤销、重做、适应视图。",
      );
    }
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || streaming) return;
    void executePrompt(text);
  };

  const stagePoint = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: clientX, y: clientY };
    const rect = stage.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const openAddMenuAt = (clientX: number, clientY: number) => {
    const point = stagePoint(clientX, clientY);
    setBlankMenu(null);
    addMenuClampedRef.current = false;
    setAddMenuAt({ x: point.x + 8, y: point.y + 8 });
    setAddMenuOpen(true);
    setPanel(null);
    setNodeMenu(null);
  };

  const openBlankMenuAt = (clientX: number, clientY: number) => {
    const point = stagePoint(clientX, clientY);
    setBlankMenu({ x: point.x + 4, y: point.y + 4 });
    setNodeMenu(null);
    setAddMenuOpen(false);
    setPanel(null);
  };

  const openNodeMenuAt = (nodeId: string, clientX: number, clientY: number, multi = false) => {
    const point = stagePoint(clientX, clientY);
    setNodeMenuMulti(multi);
    setBlankMenu(null);
    setNodeMenu({ nodeId, x: point.x + 4, y: point.y + 4 });
    setAddMenuOpen(false);
    setPanel(null);
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (addMenuOpen && addMenuAt && addMenuRef.current && !addMenuClampedRef.current) {
      addMenuClampedRef.current = true;
      const width = addMenuRef.current.offsetWidth;
      const height = addMenuRef.current.offsetHeight;
      const maxX = Math.max(14, stage.clientWidth - width - 14);
      const maxY = Math.max(14, stage.clientHeight - height - 14);
      const x = Math.max(14, Math.min(maxX, addMenuAt.x));
      const y = Math.max(14, Math.min(maxY, addMenuAt.y));
      if (x !== addMenuAt.x || y !== addMenuAt.y) setAddMenuAt({ x, y });
      return;
    }
    if (!addMenuOpen) addMenuClampedRef.current = false;
    if (nodeMenu && nodeMenuRef.current) {
      const width = nodeMenuRef.current.offsetWidth;
      const height = nodeMenuRef.current.offsetHeight;
      const maxX = Math.max(14, stage.clientWidth - width - 14);
      const maxY = Math.max(14, stage.clientHeight - height - 14);
      const x = Math.max(14, Math.min(maxX, nodeMenu.x));
      const y = Math.max(14, Math.min(maxY, nodeMenu.y));
      if (x !== nodeMenu.x || y !== nodeMenu.y) setNodeMenu({ ...nodeMenu, x, y });
    }
  }, [addMenuOpen, nodeMenu]);

  const keyboardRef = useRef({
    undo,
    redo,
    deleteSelection,
    selectAll: selectAllNodes,
    copy: copySelection,
    paste: pasteClipboard,
    duplicate: duplicateSelection,
    search: () => {
      setPanel("search");
      setAddMenuOpen(false);
    },
    group: groupSelection,
    ungroup: ungroupSelection,
    toggleAgent: () => setAgentOpen((open) => !open),
  });
  keyboardRef.current = {
    undo,
    redo,
    deleteSelection,
    selectAll: selectAllNodes,
    copy: copySelection,
    paste: pasteClipboard,
    duplicate: duplicateSelection,
    search: () => {
      setPanel("search");
      setAddMenuOpen(false);
    },
    group: groupSelection,
    ungroup: ungroupSelection,
    toggleAgent: () => setAgentOpen((open) => !open),
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        ((target.tagName === "INPUT" &&
          ["range", "checkbox", "radio", "button", "submit", "reset"].indexOf((target as HTMLInputElement).type) < 0) ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable === true);
      const meta = event.metaKey || event.ctrlKey;
      if (!typing && !meta && !event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setCommentMode((value) => !value);
        return;
      }
      if (meta && event.key.toLowerCase() === "z") {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) keyboardRef.current.redo();
        else keyboardRef.current.undo();
        return;
      }
      if (meta && !typing) {
        const combo = event.key.toLowerCase();
        if (combo === "y" && !event.shiftKey) {
          event.preventDefault();
          keyboardRef.current.redo();
          return;
        }
        if (combo === "a") {
          event.preventDefault();
          keyboardRef.current.selectAll();
          return;
        }
        if (combo === "c") {
          event.preventDefault();
          keyboardRef.current.copy();
          return;
        }
        if (combo === "v") {
          event.preventDefault();
          keyboardRef.current.paste();
          return;
        }
        if (combo === "d") {
          event.preventDefault();
          keyboardRef.current.duplicate();
          return;
        }
        if (combo === "f") {
          event.preventDefault();
          keyboardRef.current.search();
          return;
        }
        if (combo === "j") {
          event.preventDefault();
          keyboardRef.current.toggleAgent();
          return;
        }
        if (combo === "g") {
          event.preventDefault();
          if (event.shiftKey) keyboardRef.current.ungroup();
          else keyboardRef.current.group();
          return;
        }
      }
      if (!typing && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        keyboardRef.current.deleteSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && pendingDeleteIdsRef.current.size) {
        event.preventDefault();
        for (const id of pendingDeleteIdsRef.current) { window.clearTimeout(deleteTimersRef.current[id]); delete deleteTimersRef.current[id]; }
        pendingDeleteIdsRef.current.clear();
        setDeletingNodeIds(new Set());
        return;
      }
      if (event.key === "Escape") {
        setAgentMenu(null);
        setAgentSidebarOpen(false);
        setPlusOpen(false);
        setContextOpen(false);
        setModelMenu(false);
        setIdentityOpen(false);
        setCanvasSettingsOpen(false);
        setCanvasMenuOpen(false);
        setConnectOpen(false);
        setCommentMode(false);
        setCommentDraft("");
        setPendingComment(null);
        setAddMenuOpen(false);
        setNodeMenu(null);
        setBlankMenu(null);
        setPanel(null);
        setSelectedNodeIds([]);
        setSelectedEdgeId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const saveNodeToAssetLibrary = async (node: CanvasNode) => {
    if (!node.url) return;
    const bridge = (window as unknown as {
      openarc?: { canvas?: { command: (command: Record<string, unknown>) => Promise<Record<string, unknown>> } };
    }).openarc?.canvas;
    if (!bridge || typeof bridge.command !== "function") {
      setSaveState({ state: "error", text: "素材库不可用：未连接桌面后端" });
      return;
    }
    try {
      const ensured = await bridge.command({ type: "canvas/assetLibrary/ensure" });
      const library = ensured && ensured.ok === true ? (ensured.library as Record<string, unknown> | undefined) : undefined;
      const nested = library && library.library && typeof library.library === "object" ? (library.library as Record<string, unknown>) : null;
      const libraryId = String((library && library.id) || (nested && nested.id) || "");
      if (!libraryId) {
        setSaveState({ state: "error", text: "保存到素材库失败：无法取得素材库" });
        return;
      }
      const result = await bridge.command({
        type: "canvas/assetLibrary/syncSources",
        libraryId,
        items: [{ nodeId: node.id, name: searchNodeTitle(node), canvasId }],
      });
      if (result && result.ok === true) {
        setSaveState({ state: "saved", text: "已保存到素材库" });
      } else {
        setSaveState({ state: "error", text: "保存到素材库失败：" + String((result && result.error) || "ASSET_SYNC_FAILED") });
      }
    } catch (error) {
      setSaveState({ state: "error", text: "保存到素材库失败：" + (error instanceof Error ? error.message : "BRIDGE_ERROR") });
    }
  };

  const copyNodeToClipboard = async (node: CanvasNode) => {
    const text = node.url || node.text || searchNodeTitle(node);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setSaveState({ state: "saved", text: "已复制到剪贴板" });
  };

  const menuNode = nodeMenu ? doc.nodes.find((node) => node.id === nodeMenu.nodeId) : undefined;
  const alignableNow = alignTargets();
  const peerCount = Object.keys(peers).length;
  useEffect(() => {
    if (!commentMode) {
      setCommentDraft("");
      setPendingComment(null);
    }
  }, [commentMode]);

  const connectAgents: Array<{ id: string; label: string; desc: string; unavailable?: boolean }> = [
    { id: "claude", label: "Claude", desc: "在 Claude 或 Claude Code 里继续这个项目" },
    { id: "chatgpt", label: "ChatGPT", desc: "在 ChatGPT 中继续这个项目" },
    { id: "workbuddy", label: "WorkBuddy", desc: "在 WorkBuddy 中继续这个项目" },
    { id: "qianwen", label: "千问办公", desc: "在千问办公中继续这个项目" },
    { id: "more", label: "更多 Agent", desc: "更多 Agent 即将接入", unavailable: true },
  ];
  const activeConnectAgent = connectAgents.find((agent) => agent.id === connectAgent) || connectAgents[0];
  const connectPrompt = () => "请在 " + activeConnectAgent.label + " 中继续 OpenArc 项目「" + title + "」。\ncanvasId: " + canvasId + "\n请通过 MCP 连接本机 OpenArc，读取当前画布内容与协作状态，然后继续创作。";
  const copyConnectPrompt = async () => {
    const text = connectPrompt();
    (window as unknown as { __openarcLastConnectPrompt?: string }).__openarcLastConnectPrompt = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setConnectToast("提示词已复制到剪贴板");
    window.setTimeout(() => setConnectToast(""), 2200);
  };
  const hostMcpOpen =
    onOpenMcpCenter ||
    (typeof (window as unknown as { __openarcOpenMcpCenter?: () => void }).__openarcOpenMcpCenter === "function"
      ? () => (window as unknown as { __openarcOpenMcpCenter?: () => void }).__openarcOpenMcpCenter?.()
      : undefined);
  const openMcpSettings = () => {
    if (!hostMcpOpen) {
      setConnectToast("缺宿主 MCP 中心入口");
      return;
    }
    hostMcpOpen();
    setConnectToast("已请求宿主打开 MCP 中心");
    window.setTimeout(() => setConnectToast(""), 2200);
  };

  const shareCmd = async (payload: Record<string, unknown>) => {
    const api = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
    if (!api || typeof api.command !== "function") {
      return { ok: false, error: "BRIDGE_UNAVAILABLE", detail: "未连接桌面后端，无法管理共享" };
    }
    return api.command(payload);
  };

  const loadCanvasList = async (force = false) => {
    if (!force && sharedCanvasList) {
      setCanvasList(sharedCanvasList);
      setCanvasListError("");
      return;
    }
    const api = canvasBridge();
    if (!api) {
      setCanvasListError("未连接桌面后端，无法读取画布列表");
      return;
    }
    setCanvasListLoading(true);
    setCanvasListError("");
    try {
      const request = api.command({ type: "canvas/list" });
      sharedCanvasListRequest = request.then((res) => {
        if (!res || res.ok !== true) throw new Error(String((res && res.error) || "CANVAS_LIST_FAILED"));
        const raw = Array.isArray(res.items) ? res.items : Array.isArray(res.canvases) ? res.canvases : [];
        return raw.map((item) => {
          const row = item as Record<string, unknown>;
          return { id: normalizeCanvasId(String(row.id ?? row.canvasId ?? "")), title: String(row.title ?? row.name ?? "未命名画布"), updatedAt: Number(row.updatedAt || 0) };
        });
      });
      const items = await sharedCanvasListRequest;
      sharedCanvasList = items;
      setCanvasList(items);
    } catch (error) {
      sharedCanvasList = null;
      sharedCanvasListRequest = null;
      setCanvasListError(error instanceof Error ? error.message : "CANVAS_LIST_FAILED");
    } finally {
      setCanvasListLoading(false);
    }
  };

  const downloadNode = async (node: { url?: string; text?: string }) => {
    const url = node.url || "";
    if (!url) return;
    try {
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = (node.text || "openarc-download").replace(/[\\/:*?"<>|]/g, "_");
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } catch { /* 浏览器拒绝下载时保持无操作 */ }
  };
  useEffect(() => {
    const target = agentOpen ? agentInputRef.current : (document.querySelector('[data-testid="canvas-title-button"]') as HTMLElement | null);
    if (!target) return;
    const timer = window.setTimeout(() => target.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [agentOpen]);
  const openUsage = async () => {
    setUsageOpen(true);
    try {
      const model = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.model;
      const result = model && typeof model.command === "function" ? await model.command({ type: "model/usage/summary" }) : null;
      const value = result && result.ok === true && result.usage ? result.usage as { calls?: number; tokens?: number; lastCallAt?: number | null } : null;
      setUsage({ calls: Number(value?.calls) || 0, tokens: Number(value?.tokens) || 0, lastCallAt: value?.lastCallAt || null });
    } catch { setUsage({ calls: 0, tokens: 0, lastCallAt: null }); }
  };
  const createCanvas = async () => {
    if (!newCanvasTitle.trim()) return;
    const api = canvasBridge();
    if (!api) {
      setCanvasListError("未连接桌面后端，无法新建画布");
      return;
    }
    setCreatingCanvas(true);
    setCanvasListError("");
    try {
      const res = await api.command({ type: "canvas/create", title: newCanvasTitle.trim() });
      const created = res && res.ok === true && res.canvas ? (res.canvas as Record<string, unknown>) : null;
      if (!created) throw new Error(String((res && res.error) || "CANVAS_CREATE_FAILED"));
      const entry: CanvasEntryMeta = { id: normalizeCanvasId(String(created.id ?? created.canvasId ?? "")), title: String(created.title ?? created.name ?? newCanvasTitle.trim()), updatedAt: Date.now() };
      sharedCanvasList = [entry, ...(sharedCanvasList || []).filter((item) => item.id !== entry.id)];
      setCanvasList(sharedCanvasList);
      setNewCanvasTitle("");
      setCreatingCanvas(false);
      setCanvasMenuOpen(false);
      onSelectCanvas(entry);
    } catch (error) {
      setCanvasListError(error instanceof Error ? error.message : "CANVAS_CREATE_FAILED");
      setCreatingCanvas(false);
    }
  };

  useEffect(() => {
    if (canvasMenuOpen) void loadCanvasList();
  }, [canvasMenuOpen]);
  useEffect(() => { imagePollEpochRef.current += 1; imagePollTokensRef.current = {}; }, [canvasId]);
  useEffect(() => () => { imagePollEpochRef.current += 1; }, []);

  const archiveConversation = () => {
    if (!messages.some((message) => message.role === "user" || message.text !== ASSISTANT_INTRO)) return;
    const entry: AgentConversation = {
      id: makeId("chat"),
      title: (messages.find((message) => message.role === "user")?.text || "新对话").slice(0, 40),
      messages,
      draft,
      at: Date.now(),
    };
    const next = [entry, ...agentHistory.filter((item) => item.id !== entry.id)].slice(0, AGENT_HISTORY_MAX);
    setAgentHistory(next);
    writeAgentHistory(next);
  };

  const startNewConversation = () => {
    setUndoMessages(messages);
    archiveConversation();
    setMessages([]);
    setDraft("");
    setAgentMenu(null);
  };

  const restoreConversation = (entry: AgentConversation) => {
    setMessages(entry.messages.length ? entry.messages : []);
    setDraft(entry.draft || "");
    setAgentMenu(null);
    setUndoMessages(null);
  };

  const canvasSettings = doc.settings || readDefaultCanvasSettings();
  const updateCanvasSettings = (patch: Partial<CanvasSettings>) => {
    const next = applyOp(docRef.current, { type: "update-settings", patch });
    writeDoc(canvasId, next);
    dispatch({ type: "update-settings", patch }, { history: true });
  };
  const agentTokens = messages.reduce((sum, message) => sum + Math.ceil(message.text.length / 4), 0);
  const hostBackToWorkspace =
    onBackToWorkspace ||
    (typeof (window as unknown as { __openarcBackToWorkspace?: () => void }).__openarcBackToWorkspace === "function"
      ? () => (window as unknown as { __openarcBackToWorkspace?: () => void }).__openarcBackToWorkspace?.()
      : undefined);
  const hostOpenSettings =
    onOpenSettings ||
    (typeof (window as unknown as { __openarcOpenSettings?: () => void }).__openarcOpenSettings === "function"
      ? () => (window as unknown as { __openarcOpenSettings?: () => void }).__openarcOpenSettings?.()
      : undefined);
  const modelHostOpen =
    onOpenModelSettings ||
    (typeof (window as unknown as { __openarcOpenModelSettings?: () => void }).__openarcOpenModelSettings === "function"
      ? () => (window as unknown as { __openarcOpenModelSettings?: () => void }).__openarcOpenModelSettings?.()
      : undefined);
  const recentOutputs = doc.nodes.filter((node) => node.url && (node.kind === "image" || node.kind === "video" || node.kind === "audio" || node.kind === "model3d")).slice(-8).reverse();
  const suggestionPage = AGENT_SUGGESTIONS.slice(suggestIndex % AGENT_SUGGESTIONS.length).concat(AGENT_SUGGESTIONS.slice(0, suggestIndex % AGENT_SUGGESTIONS.length)).slice(0, 2);

  useEffect(() => {
    const modelBridge = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.model;
    if (!modelBridge || typeof modelBridge.command !== "function") return;
    modelBridge
      .command({ type: "canvas/models" })
      .then((res) => {
        const models = res && res.ok === true && Array.isArray(res.models) ? res.models : [];
        const labelIndex = buildCanvasModelLabelIndex(models as never);
        const image = models.filter((item) => {
          const row = item as Record<string, unknown>;
          return row.status === "enabled" && Array.isArray(row.capabilities) && row.capabilities.includes("image-generation");
        }).map((item) => {
          const row = item as Record<string, unknown>;
          return { label: labelIndex.labelOf.get(String(row.configId)) || canvasModelBaseName(row as never), configId: String(row.configId), providerName: String(row.providerName || "") };
        });
        setImageModels(image);
        setHas3dModel(models.some((item) => { const row = item as Record<string, unknown>; return row.status === "enabled" && Array.isArray(row.capabilities) && row.capabilities.includes("3d-generation"); }));
      })
      .catch(() => setImageModels([]));
  }, []);

  const loadVideoModels = async () => {
    const modelBridge = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.model;
    if (!modelBridge || typeof modelBridge.command !== "function") return [] as Array<{ label: string; configId: string; providerName?: string }>;
    try {
      const res = await modelBridge.command({ type: "canvas/models" });
      const models = res && res.ok === true && Array.isArray(res.models) ? res.models : [];
      const labelIndex = buildCanvasModelLabelIndex(models as never);
      const video = models.filter((item) => {
        const row = item as Record<string, unknown>;
        return row.status === "enabled" && Array.isArray(row.capabilities) && row.capabilities.includes("video-generation");
      }).map((item) => {
        const row = item as Record<string, unknown>;
        return { label: labelIndex.labelOf.get(String(row.configId)) || canvasModelBaseName(row as never), configId: String(row.configId), providerName: String(row.providerName || "") };
      });
      setVideoModels(video);
      return video;
    } catch { setVideoModels([]); return [] as Array<{ label: string; configId: string; providerName?: string }>; }
  };

  const modelKey = (kind: string) => "openarc:canvas:model:" + canvasId + ":" + kind;
  const selectModelConfig = (kind: string, configId: string) => {
    setSelectedConfigs((prev) => ({ ...prev, [kind]: configId }));
    try { window.localStorage.setItem(modelKey(kind), configId); } catch { /* ignore */ }
  };
  useEffect(() => {
    const lists: Record<string, Array<{ label: string; configId: string; providerName?: string }>> = { image: imageModels, video: videoModels, audio: audioModels, chat: chatModels };
    setSelectedConfigs((prev) => {
      const next = { ...prev }; let changed = false;
      for (const [kind, list] of Object.entries(lists)) {
        let stored = ""; try { stored = window.localStorage.getItem(modelKey(kind)) || ""; } catch { /* ignore */ }
        const candidate = prev[kind] || stored;
        const value = list.some((model) => model.configId === candidate) ? candidate : (list[0]?.configId || "");
        if (value !== prev[kind]) { next[kind] = value; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [canvasId, imageModels, videoModels, audioModels, chatModels]);
  const selectedImageModel = imageModels.find((model) => model.configId === selectedConfigs.image) || imageModels[0] || null;
  const selectedChatModel = chatModels.find((model) => model.configId === selectedConfigs.chat) || chatModels[0] || null;
  const selectedVideoModel = videoModels.find((model) => model.configId === selectedConfigs.video) || videoModels[0] || null;
  const selectedAudioModel = audioModels.find((model) => model.configId === selectedConfigs.audio) || audioModels[0] || null;
  const loadImageModels = async () => {
    const modelBridge = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.model;
    if (!modelBridge || typeof modelBridge.command !== "function") return [] as Array<{ label: string; configId: string; providerName?: string }>;
    try {
      const res = await modelBridge.command({ type: "canvas/models" });
      const models = res && res.ok === true && Array.isArray(res.models) ? res.models : [];
      const labelIndex = buildCanvasModelLabelIndex(models as never);
      const image = models.filter((item) => {
        const row = item as Record<string, unknown>;
        return row.status === "enabled" && Array.isArray(row.capabilities) && row.capabilities.includes("image-generation");
      }).map((item) => {
        const row = item as Record<string, unknown>;
        return { label: labelIndex.labelOf.get(String(row.configId)) || canvasModelBaseName(row as never), configId: String(row.configId), providerName: String(row.providerName || "") };
      });
      setImageModels(image);
      return image;
    } catch {
      setImageModels([]);
      return [] as Array<{ label: string; configId: string; providerName?: string }>;
    }
  };

  useEffect(() => {
    void loadImageModels();
    void loadVideoModels();
    void loadAudioModels();
  }, []);

  const handleAddUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setAppUploadError("");
    const center = canvasRef.current?.centerWorld() || { x: 0, y: 0 };
    let created = 0;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setAppUploadError("不是图片文件：" + file.name);
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        setAppUploadError("图片超过 20MB：" + file.name);
        continue;
      }
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取失败：" + file.name));
        reader.readAsDataURL(file);
      }).catch((error: unknown) => {
        setAppUploadError(error instanceof Error ? error.message : "读取失败");
        return "";
      });
      if (!url) continue;
      const size = NODE_SIZE.image;
      const node = { ...makeNode("image", center.x + 140 + (created % 2) * (size.w + 40), center.y - size.h / 2 + (Math.floor(created / 2) % 4) * (size.h + 40), file.name), url, originalUrl: url };
      dispatch({ type: "add-node", node }, { history: true });
      created += 1;
    }
    if (created) setPanel(null);
  };

  const loadAudioModels = async () => {
    const modelBridge = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.model;
    if (!modelBridge || typeof modelBridge.command !== "function") return [] as Array<{ label: string; configId: string; providerName?: string }>;
    try {
      const res = await modelBridge.command({ type: "canvas/models" });
      const models = res && res.ok === true && Array.isArray(res.models) ? res.models : [];
      const labelIndex = buildCanvasModelLabelIndex(models as never);
      const audio = models.filter((item) => {
        const row = item as Record<string, unknown>;
        return row.status === "enabled" && Array.isArray(row.capabilities) && row.capabilities.includes("audio-generation");
      }).map((item) => {
        const row = item as Record<string, unknown>;
        return { label: labelIndex.labelOf.get(String(row.configId)) || canvasModelBaseName(row as never), configId: String(row.configId), providerName: String(row.providerName || "") };
      });
      setAudioModels(audio);
      return audio;
    } catch { setAudioModels([]); return [] as Array<{ label: string; configId: string; providerName?: string }>; }
  };

  const loadChatModels = async () => {
    const modelBridge = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.model;
    if (!modelBridge || typeof modelBridge.command !== "function") return [] as Array<{ label: string; configId: string; providerName?: string }>;
    try {
      const res = await modelBridge.command({ type: "canvas/models" });
      const models = res && res.ok === true && Array.isArray(res.models) ? res.models : [];
      const labelIndex = buildCanvasModelLabelIndex(models as never);
      const chat = models.filter((item) => {
        const row = item as Record<string, unknown>;
        return row.status === "enabled" && Array.isArray(row.capabilities) && row.capabilities.includes("chat");
      }).map((item) => {
        const row = item as Record<string, unknown>;
        return { label: labelIndex.labelOf.get(String(row.configId)) || canvasModelBaseName(row as never), configId: String(row.configId), providerName: String(row.providerName || "") };
      });
      setChatModels(chat);
      return chat;
    } catch { setChatModels([]); return [] as Array<{ label: string; configId: string; providerName?: string }>; }
  };

  const handleModelStreamEvent = (event: unknown) => {
    const payload = (event as { payload?: { type?: string; requestId?: string; event?: { type?: string; text?: string } } })?.payload;
    if (!payload || payload.type !== "canvas.stream" || String(payload.requestId || "") !== streamRequestRef.current) return;
    const ev = payload.event;
    if (ev && ev.type === "text.delta" && typeof ev.text === "string") {
      setMessages((prev) => prev.map((message) => message.id === streamAssistantRef.current ? { ...message, text: message.text + ev.text } : message));
    }
  };

  useEffect(() => {
    void loadChatModels();
    const api = (window as unknown as { openarc?: { model?: { onEvent?: (cb: (event: unknown) => void) => () => void } } }).openarc?.model;
    if (!api || typeof api.onEvent !== "function") return;
    streamOffRef.current = api.onEvent(handleModelStreamEvent);
    return () => { try { streamOffRef.current?.(); } catch { /* ignore */ } streamOffRef.current = null; };
  }, []);

  const releaseVoiceTracks = () => {
    try { voiceStreamRef.current?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
    voiceStreamRef.current = null;
    if (voiceTimerRef.current != null) { window.clearInterval(voiceTimerRef.current); voiceTimerRef.current = null; }
    try { voiceRecognitionRef.current?.stop(); } catch { /* ignore */ }
    voiceRecognitionRef.current = null;
  };

  const saveVoiceRecording = (chunks: Blob[]) => {
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    if (!blob.size) { setVoiceError("录音为空，未创建音频节点"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      if (!url) { setVoiceError("录音读取失败"); return; }
      const node = { ...makeNode("audio", 240, 240, "语音录音"), url, originalUrl: url };
      dispatch({ type: "add-node", node }, { history: true });
      const transcript = voiceTranscriptRef.current.trim();
      if (voiceFinalAppliedRef.current) { /* final already written live */ }
      else if (transcript && !voiceRecognitionFailedRef.current && voiceHasRecognitionRef.current) setDraft((prev) => (prev ? prev + " " : "") + transcript);
      else setVoiceNotice("已保存录音（未转写）");
      setVoiceInterim("");
    };
    reader.onerror = () => setVoiceError("录音读取失败");
    reader.readAsDataURL(blob);
  };

  const stopVoiceRecording = () => {
    try { voiceRecognitionRef.current?.stop(); } catch { /* ignore */ }
    setVoiceInterim("");
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* ignore */ }
    } else {
      saveVoiceRecording(voiceChunksRef.current);
    }
    mediaRecorderRef.current = null;
    releaseVoiceTracks();
    setRecording(false);
    setRecordingSeconds(0);
  };

  const startVoiceRecording = async () => {
    if (!canvasSettings.voiceEnabled) { setVoiceError("请先在设置开启语音输入"); return; }
    if (recording) { stopVoiceRecording(); return; }
    setVoiceError("");
    setVoiceNotice("");
    voiceTranscriptRef.current = "";
    voiceBaseDraftRef.current = draft;
    voiceRecognitionFailedRef.current = false;
    voiceHasRecognitionRef.current = false;
    voiceFinalAppliedRef.current = false;
    setVoiceInterim("");
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") { setVoiceError("当前环境不支持麦克风"); return; }
    if (typeof MediaRecorder !== "function") { setVoiceError("当前环境不支持录音"); return; }
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data && event.data.size) voiceChunksRef.current.push(event.data); };
      recorder.onstop = () => { const chunks = voiceChunksRef.current; voiceChunksRef.current = []; saveVoiceRecording(chunks); };
      recorder.start(200);
      setRecording(true);
      setRecordingSeconds(0);
      voiceTimerRef.current = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
      const SpeechCtor = (window as unknown as { SpeechRecognition?: new () => { continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }; webkitSpeechRecognition?: new () => { continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void } }).SpeechRecognition
        || (window as unknown as { webkitSpeechRecognition?: new () => { continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void } }).webkitSpeechRecognition;
      if (SpeechCtor) {
        try {
          const recognition: any = new SpeechCtor();
          recognition.continuous = false;
          recognition.interimResults = true;
          recognition.lang = navigator.language || "zh-CN";
          recognition.onresult = (event: any) => {
            let interim = ""; const finals: string[] = [];
            for (let i = 0; i < event.results.length; i += 1) {
              const result = event.results[i]; const text = result?.[0]?.transcript || "";
              if (result?.isFinal) finals.push(text.trim()); else interim += text;
            }
            if (finals.length) {
              const finalText = finals.join(" ").trim();
              voiceTranscriptRef.current = finalText;
              voiceFinalAppliedRef.current = true;
              setDraft((prev) => prev ? prev + " " + finalText : finalText);
              setVoiceInterim("");
            } else setVoiceInterim(interim.trim());
          };
          recognition.onerror = () => { voiceRecognitionFailedRef.current = true; setVoiceInterim(""); setVoiceNotice("语音识别失败，录音将保存（未转写）"); };
          recognition.onend = () => { /* transcript applied after save */ };
          recognition.start();
          voiceRecognitionRef.current = recognition;
          voiceHasRecognitionRef.current = true;
        } catch { voiceRecognitionRef.current = null; }
      }
    } catch {
      setVoiceError("麦克风权限被拒绝或设备不可用");
      releaseVoiceTracks();
      setRecording(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && recording) stopVoiceRecording(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  useEffect(() => () => { releaseVoiceTracks(); }, []);

  const executePrompt = async (raw: string, skipConfirm = false) => {
    const text = raw.trim();
    if (!text) return;
    if (confirmMode && !skipConfirm) {
      setPendingConfirm(text);
      return;
    }
    if (/^(添加|清空|撤销|重做|适应)/.test(text)) {
      runCommand(text, true);
      return;
    }
    let models = chatModels;
    if (!models.length) models = await loadChatModels();
    if (!models.length) {
      pushMessage("user", text);
      pushMessage("assistant", "未接入模型：当前没有可用的文本模型。本地指令（添加/清空/撤销/重做/适应）仍可使用。");
      setStreamError("未接入模型");
      return;
    }
    const bridge = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
    if (!bridge || typeof bridge.command !== "function") {
      pushMessage("user", text);
      pushMessage("assistant", "未连接桌面后端，无法调用模型。");
      setStreamError("未连接模型后端");
      return;
    }
    const modelApi = (window as unknown as { openarc?: { model?: { onEvent?: (cb: (event: unknown) => void) => () => void } } }).openarc?.model;
    if (!streamOffRef.current && modelApi && typeof modelApi.onEvent === "function") {
      streamOffRef.current = modelApi.onEvent(handleModelStreamEvent);
    }
    lastPromptRef.current = text;
    setStreamError("");
    setDraft("");
    setStreaming(true);
    pushMessage("user", text);
    const assistantId = makeId("m");
    streamAssistantRef.current = assistantId;
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", text: "" }]);
    try {
      const run = await bridge.command({ type: "canvas/run", canvasId, kind: "chat", nodeId: null, configId: selectedChatModel?.configId || undefined });
      if (!run || run.ok !== true) throw new Error(String((run && run.error) || "RUN_FAILED"));
      streamRunRef.current = String(run.runId || "");
      const requestId = "cvstream_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      streamRequestRef.current = requestId;
      const history = messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-20).map((message) => ({ role: message.role, content: message.text }));
      const result = await bridge.command({ type: "canvas/modelChatStream", canvasId, runId: run.runId, messages: history.concat([{ role: "user", content: text }]), configId: selectedChatModel?.configId || models[0].configId, requestId });
      await bridge.command({ type: "canvas/runFinish", canvasId, runId: run.runId, status: result && result.ok ? "DONE" : "FAILED" });
      if (result && result.ok === true && typeof result.text === "string") {
        setMessages((prev) => prev.map((message) => message.id === assistantId ? { ...message, text: String(result.text) } : message));
      } else if (!result || result.ok !== true) {
        throw new Error(String((result && result.error) || "MODEL_ERROR"));
      }
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : "模型调用失败");
      setMessages((prev) => prev.map((message) => message.id === assistantId ? { ...message, text: (message.text ? message.text + "\n" : "") + "模型调用失败：" + (error instanceof Error ? error.message : "MODEL_ERROR") } : message));
    } finally {
      streamRequestRef.current = "";
      streamRunRef.current = "";
      setStreaming(false);
    }
  };

  const generateNodeAudio = async (nodeId: string, prompt: string) => {
    if (!prompt.trim()) return;
    let models = audioModels;
    if (!models.length) models = await loadAudioModels();
    if (!models.length) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "音频模型未配置，打开模型设置" } }));
      return;
    }
    const bridge = canvasBridge();
    if (!bridge) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "未连接桌面后端，无法生成" } }));
      return;
    }
    const pollToken = (imagePollTokensRef.current[nodeId] || 0) + 1;
    imagePollTokensRef.current[nodeId] = pollToken;
    const pollEpoch = imagePollEpochRef.current;
    const cancelled = () => pollEpoch !== imagePollEpochRef.current || pollToken !== imagePollTokensRef.current[nodeId];
    setGeneration((prev) => ({ ...prev, [nodeId]: { status: "pending" } }));
    try {
      let result = await bridge.command({
        type: "canvas/nodes/execute",
        payload: { type: "builtin.audio-generator", canvasId, nodeId, async: true, params: { prompt, configId: selectedAudioModel?.configId || models[0].configId } },
      });
      if (result && result.async === true && result.runId) {
        setGeneration((prev) => ({ ...prev, [nodeId]: { status: "pending", runId: result.runId } }));
        const deadline = Date.now() + 10 * 60 * 1000;
        let terminal: Record<string, unknown> | null = null;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (cancelled()) return;
          const status = await bridge.command({ type: "canvas/runStatus", canvasId, runId: result.runId });
          if (!status || status.ok !== true) throw new Error(String((status && status.error) || "RUN_STATUS_FAILED"));
          if (status.status === "DONE") { terminal = (status.result || {}) as Record<string, unknown>; break; }
          if (status.status === "FAILED") throw new Error(String(status.error || "音频生成失败"));
          if (status.status === "STOPPED") { if (!cancelled()) setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "已停止" } })); return; }
        }
        if (!terminal) throw new Error("生成超时（10 分钟）");
        result = terminal;
      }
      if (!result || result.ok !== true) throw new Error(String((result && (result.detail || result.error)) || "AUDIO_GENERATION_FAILED"));
      const rows = result.outputs && typeof result.outputs === "object" ? (result.outputs as { audios?: unknown[] }).audios : null;
      const first = Array.isArray(rows) ? rows[0] as Record<string, unknown> | string | undefined : undefined;
      const url = String((first && typeof first === "object" ? (first.url || first.value || first.sourceUrl) : first) || "");
      if (!url) throw new Error("生成结果缺少音频地址");
      const existing = docRef.current.nodes.find((item) => item.id === nodeId);
      dispatch({ type: "update-node", id: nodeId, patch: { url, ...(existing?.originalUrl ? {} : { originalUrl: url }), model: models[0].label } }, { history: true });
      setGeneration((prev) => { const next = { ...prev }; delete next[nodeId]; return next; });
    } catch (error) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: error instanceof Error ? error.message : "音频生成失败" } }));
    }
  };

  const enhancePrompt = async (prompt: string): Promise<string> => {
    let models = chatModels;
    if (!models.length) models = await loadChatModels();
    if (!models.length) throw new Error("未接入模型");
    const bridge = canvasBridge();
    if (!bridge) throw new Error("未连接桌面后端");
    const run = await bridge.command({ type: "canvas/run", canvasId, kind: "chat", nodeId: null, configId: selectedChatModel?.configId || undefined });
    if (!run || run.ok !== true) throw new Error(String((run && run.error) || "RUN_FAILED"));
    const requestId = "enhance_" + Date.now().toString(36);
    try {
      const result = await bridge.command({ type: "canvas/modelChatStream", canvasId, runId: run.runId, messages: [{ role: "user", content: "请把下面的生成提示词改写得更具体、更适合生成模型，只返回改写后的提示词：\n" + prompt }], configId: selectedChatModel?.configId || models[0].configId, requestId });
      if (result && result.ok === true && typeof result.text === "string" && result.text.trim()) return result.text.trim();
      throw new Error(String((result && result.error) || "MODEL_ERROR"));
    } finally {
      await bridge.command({ type: "canvas/runFinish", canvasId, runId: run.runId, status: "DONE" }).catch(() => undefined);
    }
  };

  const generateNodeVideo = async (nodeId: string, prompt: string) => {
    if (!prompt.trim()) return;
    let models = videoModels;
    if (!models.length) models = await loadVideoModels();
    if (!models.length) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "视频模型未配置，打开模型设置" } }));
      return;
    }
    const bridge = canvasBridge();
    if (!bridge) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "未连接桌面后端，无法生成" } }));
      return;
    }
    const pollToken = (imagePollTokensRef.current[nodeId] || 0) + 1;
    imagePollTokensRef.current[nodeId] = pollToken;
    const pollEpoch = imagePollEpochRef.current;
    const cancelled = () => pollEpoch !== imagePollEpochRef.current || pollToken !== imagePollTokensRef.current[nodeId];
    setGeneration((prev) => ({ ...prev, [nodeId]: { status: "pending" } }));
    try {
      let result = await bridge.command({
        type: "canvas/nodes/execute",
        payload: {
          type: "builtin.video-generator",
          canvasId,
          nodeId,
          async: true,
          params: { prompt, configId: selectedVideoModel?.configId || models[0].configId, ratio: "16:9", count: 1 },
        },
      });
      if (result && result.async === true && result.runId) {
        setGeneration((prev) => ({ ...prev, [nodeId]: { status: "pending", runId: result.runId } }));
        const deadline = Date.now() + 10 * 60 * 1000;
        let terminal: Record<string, unknown> | null = null;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (cancelled()) return;
          const status = await bridge.command({ type: "canvas/runStatus", canvasId, runId: result.runId });
          if (!status || status.ok !== true) throw new Error(String((status && status.error) || "RUN_STATUS_FAILED"));
          if (status.status === "DONE") { terminal = (status.result || {}) as Record<string, unknown>; break; }
          if (status.status === "FAILED") throw new Error(String(status.error || "视频生成失败"));
          if (status.status === "STOPPED") { if (!cancelled()) setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "已停止" } })); return; }
        }
        if (!terminal) throw new Error("生成超时（10 分钟）");
        result = terminal;
      }
      if (!result || result.ok !== true) throw new Error(String((result && (result.detail || result.error)) || "VIDEO_GENERATION_FAILED"));
      const outputsRaw = result.outputs && typeof result.outputs === "object" ? (result.outputs as { videos?: unknown[] }).videos : null;
      const outputs = Array.isArray(outputsRaw) ? outputsRaw : [];
      const firstVideo = outputs[0] as Record<string, unknown> | string | undefined;
      const url = String((firstVideo && typeof firstVideo === "object" ? (firstVideo.url || firstVideo.value || firstVideo.sourceUrl) : firstVideo) || "");
      if (!url) throw new Error("生成结果缺少视频地址");
      const existing = docRef.current.nodes.find((item) => item.id === nodeId);
      dispatch({ type: "update-node", id: nodeId, patch: { url, ...(existing?.originalUrl ? {} : { originalUrl: url }), model: models[0].label, ratio: "16:9" } }, { history: true });
      setGeneration((prev) => { const next = { ...prev }; delete next[nodeId]; return next; });
    } catch (error) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: error instanceof Error ? error.message : "视频生成失败" } }));
    }
  };

  const stopGeneration = async (nodeId: string) => {
    const info = generation[nodeId] as unknown as { runId?: string } | undefined;
    imagePollTokensRef.current[nodeId] = (imagePollTokensRef.current[nodeId] || 0) + 1;
    setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "已停止" } }));
    const bridge = canvasBridge();
    if (bridge && info?.runId) await bridge.command({ type: "canvas/runStop", canvasId, runId: info.runId, reason: "USER_STOP" }).catch(() => undefined);
  };
  const generateNodeImage = async (nodeId: string, prompt: string) => {
    if (!prompt.trim()) return;
    let models = imageModels;
    if (!models.length) models = await loadImageModels();
    if (!models.length) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "模型未配置，打开模型设置" } }));
      return;
    }
    const bridge = canvasBridge();
    if (!bridge) {
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "未连接桌面后端，无法生成" } }));
      return;
    }
    const pollToken = (imagePollTokensRef.current[nodeId] || 0) + 1;
    imagePollTokensRef.current[nodeId] = pollToken;
    const pollEpoch = imagePollEpochRef.current;
    const cancelled = () => pollEpoch !== imagePollEpochRef.current || pollToken !== imagePollTokensRef.current[nodeId];
    setGeneration((prev) => ({ ...prev, [nodeId]: { status: "pending" } }));
    try {
      const run = await bridge.command({ type: "canvas/run", canvasId, kind: "image", nodeId, configId: selectedImageModel?.configId || undefined });
      if (!run || run.ok !== true) throw new Error(String((run && run.error) || "RUN_FAILED"));
      let result = await bridge.command({ type: "canvas/modelImage", canvasId, runId: run.runId, async: true, prompt, ratio: docRef.current.nodes.find((item) => item.id === nodeId)?.ratio || "1:1", count: Number((docRef.current.nodes.find((item) => item.id === nodeId) as unknown as { count?: number })?.count) || 1, configId: (selectedImageModel || imageModels[0]).configId });
      if (result && result.async === true && result.runId) {
        const deadline = Date.now() + 10 * 60 * 1000;
        let terminal: Record<string, unknown> | null = null;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (cancelled()) return;
          const status = await bridge.command({ type: "canvas/runStatus", canvasId, runId: result.runId });
          if (!status || status.ok !== true) throw new Error(String((status && status.error) || "RUN_STATUS_FAILED"));
          if (status.status === "DONE") { terminal = (status.result || {}) as Record<string, unknown>; break; }
          if (status.status === "FAILED") throw new Error(String(status.error || "生成失败"));
          if (status.status === "STOPPED") { if (!cancelled()) setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: "已停止" } })); return; }
        }
        if (!terminal) throw new Error("生成超时（10 分钟）");
        result = terminal;
      }
      await bridge.command({ type: "canvas/runFinish", canvasId, runId: run.runId, status: result && result.ok ? "DONE" : "FAILED" });
      const images = result && Array.isArray(result.images) ? result.images : [];
      const urls = images.map((image: unknown) => String((image as Record<string, unknown>)?.dataUrl || (image as Record<string, unknown>)?.url || image || "")).filter(Boolean);
      if (!urls.length) throw new Error("生成结果缺少图片地址");
      const mode = docRef.current.settings?.batchMode || "variants";
      if (mode === "spread") {
        const source = docRef.current.nodes.find((node) => node.id === nodeId);
        const sourceNode = docRef.current.nodes.find((item) => item.id === nodeId);
        dispatch({ type: "update-node", id: nodeId, patch: { url: urls[0], ...(sourceNode?.originalUrl ? {} : { originalUrl: urls[0] }), model: (selectedImageModel || imageModels[0]).label, ratio: "1:1" } }, { history: true });
        if (source) {
          urls.slice(1).forEach((url, index) => {
            const created = { ...makeNode("image", source.x + (index + 1) * (source.w + 24), source.y, "变体 " + (index + 2)), url, model: (selectedImageModel || imageModels[0]).label, ratio: "1:1" };
            dispatch({ type: "add-node", node: created }, { history: true });
          });
        }
      } else {
        const sourceNode = docRef.current.nodes.find((item) => item.id === nodeId);
        dispatch({ type: "update-node", id: nodeId, patch: { url: urls[0], ...(sourceNode?.originalUrl ? {} : { originalUrl: urls[0] }), variants: urls.slice(1), model: (selectedImageModel || imageModels[0]).label, ratio: "1:1" } }, { history: true });
      }
      if (cancelled()) return;
      setGeneration((prev) => { const next = { ...prev }; delete next[nodeId]; return next; });
    } catch (error) {
      if (cancelled()) return;
      setGeneration((prev) => ({ ...prev, [nodeId]: { status: "error", error: error instanceof Error ? error.message : "生成失败" } }));
    }
  };

  const submitComment = () => {
    if (!pendingComment || !commentDraft.trim()) return;
    const comment: CanvasComment = {
      id: makeId("c"),
      x: pendingComment.x,
      y: pendingComment.y,
      text: commentDraft.trim().slice(0, 200),
      createdAt: Date.now(),
      clientId: clientId || "local",
      author: "我",
    };
    dispatch({ type: "add-comment", comment }, { history: true });
    setCommentDraft("");
    setPendingComment(null);
  };

  useEffect(() => {
    if (panel === "search") {
      setSearchChip("all");
      setSearch("");
    }
  }, [panel]);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    return doc.nodes.filter((node) => {
      if (searchChip === "image" && node.kind !== "image") return false;
      if (searchChip === "text" && node.kind !== "text") return false;
      if (searchChip === "group" && node.kind !== "group") return false;
      if (searchChip === "video" || searchChip === "audio" || searchChip === "world") return false;
      if (!query) return true;
      return (NODE_KIND_LABEL[node.kind] + " " + node.text).toLowerCase().indexOf(query) >= 0;
    });
  }, [doc.nodes, search, searchChip]);

  const panelBody = () => {
    if (!panel) return null;
    if (panel === "search") return null;
    if (panel === "history") {
      return (
        <div className="rc-panel-body">
          <div className="rc-stat"><span>节点</span><b>{doc.nodes.length}</b></div>
          <div className="rc-stat"><span>连线</span><b>{doc.edges.length}</b></div>
          <div className="rc-stat"><span>可撤销 / 可重做</span><b>{history.past.length + " / " + history.future.length}</b></div>
          <div className="rc-panel-actions">
            <button className="rc-secondary" onClick={undo} disabled={!history.past.length}>
              <Undo2 size={14} />撤销
            </button>
            <button className="rc-secondary" onClick={redo} disabled={!history.future.length}>
              <Redo2 size={14} />重做
            </button>
            <button className="rc-secondary" onClick={clearCanvas} disabled={!hasContent(doc)}>
              <Trash2 size={14} />清空
            </button>
          </div>
        </div>
      );
    }
    if (panel === "me") {
      return (
        <div className="rc-panel-body">
          <div className="rc-stat"><span>身份</span><b>匿名协作</b></div>
          <div className="rc-stat"><span>clientId</span><b className="rc-mono">{clientId || "…"}</b></div>
          <div className="rc-stat"><span>画布</span><b className="rc-mono">{canvasId}</b></div>
          <div className="rc-stat"><span>协作伙伴</span><b>{peerCount}</b></div>
          <p className="rc-empty">无登录、无权限、无账号数据；仅用于同源标签页实时协作。</p>
        </div>
      );
    }
    return (
      <div className="rc-panel-body">
        <p className="rc-empty">「{PANEL_TITLE[panel]}」尚未接入，本任务不提供该能力。</p>
      </div>
    );
  };

  const lanHandlers = () => ({
    getDoc: () => docRef.current,
    onOp: (op: CanvasOp) => applyRemoteOp(op),
    onSnapshot: (doc: CanvasDoc) => { docRef.current = doc; setDoc(doc); schedulePersist(); },
    onPresence: (peerId: string, cursor: PeerCursor | null) => { setPeers((prev) => ({ ...prev, [peerId]: { cursor, seenAt: Date.now() } })); },
  });
  const joinLanSession = (info: LanJoinInfo, collab: Collab) => {
    lanCollabRef.current = collab;
    lanReadOnlyRef.current = !info.canEdit;
    setLanSession({ readOnly: !info.canEdit, canvasId: info.canvasId });
    setShareOpen(false);
  };
  useEffect(() => {
    if (!lanSession) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      lanCollabRef.current?.close();
      lanCollabRef.current = null;
      lanReadOnlyRef.current = false;
      setLanSession(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lanSession]);

  if (studioMode) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const stop = () => {
      const bridge = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
      if (bridge && streamRunRef.current) void bridge.command?.({ type: "canvas/runStop", canvasId, runId: streamRunRef.current, reason: "USER_STOP" });
      streamRequestRef.current = "";
      streamRunRef.current = "";
      setStreaming(false);
    };
    return (
      <div className="studio-chat" data-studio-chat>
        <header className="studio-head" data-studio-toolbar>
          <strong>AI Studio</strong><span className="studio-sub">对话工作台</span><span className="studio-grow" />
          <button type="button" className="studio-ghost" data-studio-canvas onClick={() => setStudioMode(false)}>画布</button>
          <button type="button" className="studio-ghost" onClick={() => onOpenModelSettings?.()}>模型设置</button>
        </header>
        <div className="studio-thread" data-studio-thread>
          {messages.length === 0 ? (
            <div className="studio-empty" data-studio-empty>
              <h1>今天想创作什么？</h1>
              <p>描述目标，我会拆解步骤并调用可用工具；也可以直接打开画布继续编辑。</p>
              <div className="studio-suggestions">
                {["为秋季新品写一段门店海报文案", "把这段故事拆成 3 集短剧", "设计一张 3:4 的商品主图", "总结这个项目的待办"].map((text) => (
                  <button key={text} type="button" className="studio-suggestion" onClick={() => setDraft(text)}>{text}</button>
                ))}
              </div>
            </div>
          ) : messages.map((message) => (
            <article key={message.id} className={"studio-msg " + message.role} data-studio-message={message.role}>
              <div className="studio-msg-role">{message.role === "user" ? "你" : "Assistant"}</div>
              <div className="studio-msg-body">{message.text || (streaming ? <span className="studio-typing" data-studio-generating>正在生成…</span> : "")}</div>
              {message.role === "assistant" && message.text ? (
                <div className="studio-actions">
                  <button type="button" className="studio-action" onClick={() => void navigator.clipboard?.writeText?.(message.text)}><Copy size={13} /> 复制</button>
                  <button type="button" className="studio-action" onClick={() => lastUser && void executePrompt(lastUser.text)}><RefreshCw size={13} /> 重试</button>
                </div>
              ) : null}
            </article>
          ))}
          {streamError ? (
            <div className="studio-error" role="alert" data-studio-error>
              <span>{streamError === "未接入模型" ? "未接入可用文本模型。" : "生成失败：" + streamError}</span>
              <button type="button" className="studio-action" onClick={() => onOpenModelSettings?.()}>去系统设置配置</button>
            </div>
          ) : null}
        </div>
        <form className="studio-composer" data-studio-composer onSubmit={(e) => { e.preventDefault(); void executePrompt(draft); }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="描述你想创作的内容…（Enter 发送，Shift+Enter 换行）" rows={3} data-studio-input
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void executePrompt(draft); } }} />
          <div className="studio-composer-bar">
            <button type="button" className="studio-tool"><Paperclip size={14} /> 附件</button>
            <button type="button" className="studio-tool"><Wrench size={14} /> 工具</button>
            <select className="studio-model" aria-label="模型" data-studio-model value={selectedChatModel?.configId || ""} onChange={(e) => setSelectedConfigs((prev) => ({ ...prev, chat: e.target.value }))}>
              {chatModels.length === 0 ? <option value="">未配置模型</option> : chatModels.map((m) => <option key={m.configId} value={m.configId}>{m.label}</option>)}
            </select>
            <span className="studio-grow" />
            {streaming ? (
              <button type="button" className="studio-send stop" data-studio-stop onClick={stop}><Square size={12} /> 停止</button>
            ) : (
              <button type="submit" className="studio-send" data-studio-send><Send size={13} /> 发送</button>
            )}
          </div>
        </form>
      </div>
    );
  }
  return (
    <div className={"rc-app" + (agentFullscreen ? " is-agent-fullscreen" : "") + (!previewVisible ? " is-preview-hidden" : "")} data-testid="react-canvas-app"><button type="button" className="studio-return" onClick={() => setStudioMode(true)} data-studio-back>对话</button>
      {agentFullscreen ? (
        <div className="rc-agent-fullscreen-bar" data-testid="agent-fullscreen-bar">
          <button className="rc-fs-project" data-testid="agent-fs-project" disabled={!hostBackToWorkspace} title={hostBackToWorkspace ? "返回项目" : "缺宿主入口"} onClick={() => hostBackToWorkspace?.()}>返回项目</button>
          <button data-testid="agent-fs-sidebar" onClick={() => setAgentSidebarOpen(!agentSidebarOpen)}><PanelLeft size={14} />侧边栏</button>
          <button data-testid="agent-fs-history" onClick={() => { setAgentMenu(agentMenu === "history" ? null : "history"); setAgentFullscreen(true); }}><HistoryIcon size={14} />新建对话</button>
          <button data-testid="agent-fs-new" onClick={startNewConversation}>新对话</button>
          <button className="rc-fs-agent-right" data-testid="agent-dock-right" onClick={() => setAgentFullscreen(false)}>Agent 居右</button>
          <button data-testid="agent-fs-preview" onClick={() => setPreviewVisible(!previewVisible)}>{previewVisible ? "收起画布预览" : "展开画布预览"}</button>
          <button data-testid="agent-fs-more" onClick={() => setAgentMenu(agentMenu === "more" ? null : "more")}><MoreHorizontal size={14} /></button>
        </div>
      ) : null}
      <div className="rc-stage" ref={stageRef}>
        <div className={"rc-files-card" + (filesCollapsed ? " is-collapsed" : "")} data-testid="files-card">
          <button className="rc-files-head" data-testid="files-toggle" onClick={() => setFilesCollapsed(!filesCollapsed)}>
            <strong>文件</strong><ChevronDown size={14} className={filesCollapsed ? "is-collapsed" : ""} />
          </button>
          <div className="rc-files-body">
            {recentOutputs.length === 0 ? <div className="rc-files-empty" data-testid="files-empty">暂无输出</div> : recentOutputs.map((node) => (
              <button key={node.id} className="rc-files-item" data-testid="files-item" onClick={() => { setSelectedNodeIds([node.id]); setSelectedEdgeId(null); canvasRef.current?.focusNode(node.id); }}>
                <span>{NODE_KIND_LABEL[node.kind]}</span><span>{node.text || node.id.slice(-4)}</span>
              </button>
            ))}
          </div>
        </div>

        {lanSession ? <div className={"rc-lan-badge" + (lanSession.readOnly ? " is-readonly" : "")} data-testid="lan-session-badge">LAN · {lanSession.readOnly ? "只读" : "可编辑"}</div> : null}
        <div className="rc-canvas-title" data-testid="canvas-title">
          <span className="rc-canvas-brand" aria-hidden="true" />
          <span className="rc-canvas-title-divider" aria-hidden="true" />
          <button className="rc-canvas-title-main" data-testid="canvas-title-button" aria-expanded={canvasMenuOpen} onClick={() => setCanvasMenuOpen(!canvasMenuOpen)}>
            <span className="rc-canvas-title-text">{title}</span>
            <ChevronDown size={14} className={canvasMenuOpen ? "is-open" : ""} />
          </button>
          {saveState.text && saveState.state === "error" ? (
            <span
              className={"rc-save-state rc-save-dot rc-save-" + saveState.state}
              data-testid="save-state"
              data-state={saveState.state}
              title={saveState.text}
              aria-label={saveState.text}
            />
          ) : null}
        </div>
        {canvasSettingsOpen ? (
          <div className="rc-canvas-settings-pop" data-testid="canvas-settings-pop" role="dialog" aria-label="画布设置">
            <div className="rc-settings-row"><span>网格吸附</span><button className="rc-switch" role="switch" aria-checked={canvasSettings.gridSnap} data-testid="settings-grid-snap" onClick={() => updateCanvasSettings({ gridSnap: !canvasSettings.gridSnap })}><span /></button></div>
            <div className="rc-settings-row"><span>语音输入<small>开启后允许麦克风录音；语音识别由浏览器/系统服务提供，可能联网；无可用识别时仅录音</small></span><button className="rc-switch" role="switch" aria-checked={canvasSettings.voiceEnabled} data-testid="settings-voice-enabled" onClick={() => updateCanvasSettings({ voiceEnabled: !canvasSettings.voiceEnabled })}><span /></button></div>
            <div className="rc-settings-row"><span>隐藏节点连线</span><button className="rc-switch" role="switch" aria-checked={canvasSettings.hideEdges} data-testid="settings-hide-edges" onClick={() => updateCanvasSettings({ hideEdges: !canvasSettings.hideEdges })}><span /></button></div>
            <div className="rc-settings-group-title">批量生成结果</div>
            {(["stack", "variants", "spread"] as const).map((mode) => (
              <button key={mode} className={"rc-settings-option" + (canvasSettings.batchMode === mode ? " is-active" : "")} data-testid={"settings-batch-" + mode} onClick={() => updateCanvasSettings({ batchMode: mode })}>
                <span>{mode === "stack" ? "堆叠" : mode === "variants" ? "多变体" : "铺开"}</span>
                {canvasSettings.batchMode === mode ? <Check size={13} /> : null}
              </button>
            ))}
          </div>
        ) : null}
        {canvasMenuOpen ? (
          <div className="rc-canvas-switch-menu" data-testid="canvas-switch-menu" role="menu">
            <button className="rc-canvas-menu-item" data-testid="canvas-settings" onClick={() => { setCanvasSettingsOpen(true); setCanvasMenuOpen(false); }}><Settings size={14} /><span>画布设置</span></button>
            <button className="rc-canvas-menu-item" data-testid="canvas-back" disabled={!hostBackToWorkspace} title={hostBackToWorkspace ? "返回工作空间" : "无宿主入口：缺后端"} onClick={() => { setCanvasMenuOpen(false); hostBackToWorkspace?.(); }}>
              <ChevronLeft size={14} /><span>返回工作空间</span>{hostBackToWorkspace ? null : <small>缺宿主</small>}
            </button>
            <button className="rc-canvas-menu-item" data-testid="settings-entry" disabled={!hostOpenSettings} onClick={() => { setCanvasMenuOpen(false); hostOpenSettings?.(); }}><Settings size={14} /><span>设置</span></button>
            <button className="rc-canvas-menu-item" data-testid="canvas-menu-export" onClick={() => { setCanvasMenuOpen(false); void canvasRef.current?.exportPng("all"); }}><Download size={14} /><span>导出 PNG</span></button>
            <div className="rc-menu-group-title">画布</div>
            {canvasListLoading ? <div className="rc-canvas-menu-empty">加载中…</div> : null}
            {canvasListError ? (
              <div className="rc-canvas-menu-empty" data-testid="canvas-list-error">
                <p>{canvasListError}</p>
                <button className="rc-assets-retry" data-testid="canvas-list-retry" onClick={() => void loadCanvasList(true)}>重试</button>
              </div>
            ) : null}
            {!canvasListLoading && !canvasListError
              ? canvasList.map((entry) => (
                  <button
                    key={entry.id}
                    className={"rc-canvas-menu-item" + (entry.id === canvasId ? " is-current" : "")}
                    data-testid="canvas-list-item"
                    data-current={entry.id === canvasId ? "1" : "0"}
                    onClick={() => { setCanvasMenuOpen(false); if (entry.id !== canvasId) onSelectCanvas(entry); }}
                  >
                    <span className="rc-canvas-menu-name">{entry.title}</span>
                    <small>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</small>
                  </button>
                ))
              : null}
            <div className="rc-canvas-menu-sep" />
            {creatingCanvas ? (
              <div className="rc-canvas-new-row">
                <input
                  className="rc-canvas-new-input"
                  data-testid="canvas-new-title"
                  autoFocus
                  placeholder="新画布标题"
                  value={newCanvasTitle}
                  onChange={(event) => setNewCanvasTitle(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void createCanvas(); }}
                />
                <button className="rc-canvas-new-confirm" data-testid="canvas-new-confirm" disabled={!newCanvasTitle.trim()} onClick={() => void createCanvas()}>创建</button>
              </div>
            ) : (
              <button className="rc-canvas-menu-item" data-testid="canvas-new" onClick={() => setCreatingCanvas(true)}>
                <Plus size={14} /><span>新建画布</span>
              </button>
            )}
          </div>
        ) : null}
        <ReactCanvas
              onOpenFeedback={() => { setFeedbackNodeId(null); setFeedbackOpen(true); }}
          ref={canvasRef}
          doc={doc}
          selectedNodeIds={selectedNodeIds}
          selectedEdgeId={selectedEdgeId}
          peers={peers}
          onSelectNodes={(ids) => {
            setSelectedNodeIds(ids);
            setSelectedEdgeId(null);
            setNodeMenu(null);
          }}
          onSelectEdge={(id) => {
            setSelectedEdgeId(id);
            if (id) setSelectedNodeIds([]);
          }}
          dispatch={dispatch}
          onRequestAddMenu={openAddMenuAt}
          onNodeContextMenu={openNodeMenuAt}
          onCanvasContextMenu={openBlankMenuAt}
          onCanvasSuggestion={(text) => { setDraft(text); setAgentOpen(true); }}
          onOpenTemplates={() => { setPanel("templates"); }}
          onDismissMenus={() => {
            setAddMenuOpen(false);
            setNodeMenu(null);
            setBlankMenu(null);
            setFilesCollapsed(true);
          }}
          canvasId={canvasId}
          deletingNodeIds={deletingNodeIds}
          comments={doc.comments}
          commentMode={commentMode}
          pendingComment={pendingComment}
          clientId={clientId}
          onPlaceComment={(x, y) => { setPendingComment({ x, y }); setCommentDraft(""); setTimeout(() => commentInputRef.current?.focus(), 0); }}
          onDeleteComment={(id) => dispatch({ type: "remove-comment", id }, { history: true })}
          imageModels={imageModels}
          selectedImageModelLabel={selectedImageModel?.label}
          selectedConfigs={selectedConfigs}
          onSelectModel={selectModelConfig}
          generation={generation}
          onGenerateImage={(nodeId, prompt) => { void generateNodeImage(nodeId, prompt); }}
          videoModels={videoModels}
          videoModelLabel={selectedVideoModel?.label}
          audioModelLabel={selectedAudioModel?.label}
          onGenerateVideo={(nodeId, prompt) => { void generateNodeVideo(nodeId, prompt); }}
          onReloadVideoModels={() => { void loadVideoModels(); }}
          chatModels={chatModels}
          onEnhancePrompt={enhancePrompt}
          audioModels={audioModels}
          onGenerateAudio={(nodeId, prompt) => { void generateNodeAudio(nodeId, prompt); }}
          onStopGeneration={(nodeId) => { void stopGeneration(nodeId); }}
          onReloadAudioModels={() => { void loadAudioModels(); }}
          onOpenModelSettings={onOpenModelSettings}
          onReloadModels={() => { void loadImageModels(); }}
          settings={canvasSettings}
          onUpdateSettings={updateCanvasSettings}
          onCursor={(cursor) => {
            const collab = collabRef.current;
            if (collab) collab.sendPresence(cursor);
          }}
        />

        <div className="rc-left-toolbar" role="toolbar" aria-label="画布工具">
          <button
            className="rc-tool rc-tool-primary"
            data-testid="tool-add"
            aria-label="添加"
            title="添加"
            aria-expanded={addMenuOpen}
            onClick={(event) => {
              if (addMenuOpen) {
                setAddMenuOpen(false);
                return;
              }
              openAddMenuAt(event.clientX, event.clientY);
            }}
          >
            <Plus size={18} />
          </button>
          <button
            className="rc-tool"
            data-testid="tool-search"
            aria-label="搜索"
            title="搜索画布节点"
            aria-pressed={panel === "search"}
            onClick={() => {
              setPanel(panel === "search" ? null : "search");
              setAddMenuOpen(false);
            }}
          >
            <Search size={17} />
          </button>
          <button
            className="rc-tool"
            data-testid="tool-assets"
            aria-label="素材"
            title="素材库"
            aria-pressed={panel === "assets"}
            onClick={() => {
              setPanel(panel === "assets" ? null : "assets");
              setAddMenuOpen(false);
            }}
          >
            <Folder size={17} />
          </button>
          <button
            className="rc-tool"
            data-testid="tool-templates"
            aria-label="模板"
            title="模板"
            aria-pressed={panel === "templates"}
            onClick={() => {
              setPanel(panel === "templates" ? null : "templates");
              setAddMenuOpen(false);
            }}
          >
            <LayoutTemplate size={17} />
          </button>
          <button
            className={"rc-tool" + (commentMode ? " is-active" : "")}
            data-testid="tool-comments"
            aria-label="评论"
            title="评论"
            aria-pressed={commentMode}
            onClick={() => {
              setCommentMode(!commentMode);
              setPanel(null);
              setAddMenuOpen(false);
            }}
          >
            <MessageSquare size={17} />
          </button>
          <button
            className="rc-tool"
            data-testid="tool-history"
            aria-label="历史"
            title="历史"
            aria-pressed={panel === "history"}
            onClick={() => {
              setPanel(panel === "history" ? null : "history");
              setAddMenuOpen(false);
            }}
          >
            <HistoryIcon size={17} />
          </button>
          <button
            className="rc-tool"
            data-testid="tool-me"
            aria-label="匿名身份"
            title="匿名协作身份"
            aria-pressed={identityOpen}
            onClick={() => {
              setIdentityOpen(!identityOpen);
              setPanel(null);
              setAddMenuOpen(false);
            }}
          >
            <User size={17} />
          </button>
        </div>

        {addMenuOpen ? (
          <div
            ref={addMenuRef}
            className="rc-add-menu"
            role="menu"
            data-testid="add-menu"
            style={addMenuAt ? { left: addMenuAt.x, top: addMenuAt.y } : undefined}
          >
            <div className="rc-menu-group-title">添加节点</div>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-text" onClick={() => addNodeAtCenter("text")}>
              <Type size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">文本</span><span className="rc-add-item-desc">脚本、广告词、品牌文案</span></span>
            </button>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-image" onClick={() => addNodeAtCenter("image")}>
              <ImageIcon size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">图片</span><span className="rc-add-item-desc">宣传图、海报、封面</span></span>
            </button>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-video" onClick={() => addNodeAtCenter("video")}>
              <Video size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">视频</span><span className="rc-add-item-desc">宣传视频、动画、电影</span></span>
            </button>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-audio" onClick={() => addNodeAtCenter("audio")}>
              <Music size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">音频</span><span className="rc-add-item-desc">音乐、配音、音效</span></span>
            </button>
            <button className={"rc-menu-item rc-add-item" + (has3dModel ? "" : " is-disabled")} role="menuitem" aria-disabled={!has3dModel} disabled={!has3dModel} title={has3dModel ? "Tripo3D 文生/图生 3D" : "未配置 3D provider（Tripo3D）"} data-testid="add-3d">
              <Box size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">3D</span><span className="rc-add-item-desc">生成 3D 场景与对象</span></span>
              <span className="rc-add-item-status">需 3D 额度</span>
            </button>
            <div className="rc-menu-group-title">辅助工具</div>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-timeline" onClick={() => addNodeAtCenter("timeline")}>
              <Film size={16} />
              <span className="rc-add-item-text">
                <span className="rc-add-item-label">剪辑时间线 <span className="rc-add-item-beta">Beta</span></span>
                <span className="rc-add-item-desc">时间轴串联多段素材</span>
              </span>
            </button>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-3d-stage" onClick={() => addNodeAtCenter("scene3d")}>
              <Boxes size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">3D 片场</span><span className="rc-add-item-desc">布置场景、角色与镜头调度</span></span>
              <ChevronRight size={14} className="rc-add-item-chevron" />
            </button>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-image-editor" onClick={() => { setAddMenuOpen(false); if (!canvasRef.current?.openImageEditor()) setConnectToast("请先选择图片节点"); }}>
              <Wand2 size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">图片编辑器</span><span className="rc-add-item-desc">编辑和处理图片</span></span>
            </button>
            <div className="rc-menu-group-title">添加资源</div>
            <button className="rc-menu-item rc-add-item" role="menuitem" data-testid="add-upload" onClick={() => { addUploadRef.current?.click(); setAddMenuOpen(false); }}>
              <Upload size={16} />
              <span className="rc-add-item-text"><span className="rc-add-item-label">上传</span><span className="rc-add-item-desc">支持图片（≤20MB，可多选）</span></span>
            </button>
          </div>
        ) : null}

        {blankMenu ? (
          <div className="rc-add-menu rc-blank-menu" role="menu" data-testid="blank-context-menu" style={{ left: blankMenu.x, top: blankMenu.y }}>
            <div className="rc-menu-group-title">添加</div>
            <button className="rc-menu-item" data-testid="blank-menu-upload" onClick={() => { setBlankMenu(null); addUploadRef.current?.click(); }}><Upload size={16} /><span>上传</span></button>
            <button className="rc-menu-item" data-testid="blank-menu-asset" onClick={() => { setBlankMenu(null); setPanel("assets"); }}><Images size={16} /><span>添加资产</span></button>
            <button className="rc-menu-item" data-testid="blank-menu-node" onClick={() => { setBlankMenu(null); setAddMenuOpen(true); setAddMenuAt({ x: blankMenu.x + 8, y: blankMenu.y + 8 }); }}><Plus size={16} /><span>添加节点</span></button>
            <button className="rc-menu-item" data-testid="blank-menu-tool" onClick={() => { setBlankMenu(null); setAddMenuOpen(true); setAddMenuAt({ x: blankMenu.x + 8, y: blankMenu.y + 8 }); }}><Wand2 size={16} /><span>添加辅助工具</span></button>
            <div className="rc-menu-group-title">编辑</div>
            <button className="rc-menu-item" data-testid="blank-menu-undo" onClick={() => { undo(); setBlankMenu(null); }}><Undo2 size={16} /><span>撤销</span><small>⌘Z</small></button>
            <button className="rc-menu-item" data-testid="blank-menu-redo" onClick={() => { redo(); setBlankMenu(null); }}><Redo2 size={16} /><span>重做</span><small>⇧⌘Z</small></button>
            <button className="rc-menu-item" data-testid="blank-menu-paste" onClick={() => { pasteClipboard(); setBlankMenu(null); }}><Clipboard size={16} /><span>粘贴</span><small>⌘V</small></button>
          </div>
        ) : null}
        {nodeMenu ? (
          <div
            ref={nodeMenuRef}
            className="rc-add-menu rc-node-menu"
            role="menu"
            data-testid="node-menu"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
          >
            {nodeMenuMulti || (menuNode && menuNode.kind === "group") ? <div className="rc-menu-group-title">节点</div> : null}
            <button
              className={"rc-menu-item" + (menuNode && menuNode.url ? "" : " is-disabled")}
              data-testid="node-menu-save-asset"
              disabled={!menuNode || !menuNode.url}
              title={menuNode && menuNode.url ? "保存到素材库" : "缺媒体：该节点没有媒体地址，不是缺少后端"}
              onClick={() => { if (menuNode && menuNode.url) { void saveNodeToAssetLibrary(menuNode); setNodeMenu(null); } }}
            >
              <Library size={16} /><span>保存到素材库</span><small>{menuNode && menuNode.url ? "" : "缺媒体"}</small>
            </button>
            {menuNode && menuNode.kind !== "text" && menuNode.kind !== "note" ? <button className={"rc-menu-item" + (menuNode.url ? "" : " is-disabled")} data-testid="node-menu-download" disabled={!menuNode.url} onClick={() => { if (menuNode.url) { void downloadNode(menuNode); setNodeMenu(null); } }}>
              <Download size={16} /><span>下载</span>
            </button> : null}
            <button className="rc-menu-item" data-testid="node-menu-copy" onClick={() => { copySelection(); setNodeMenu(null); }}>
              <Copy size={16} /><span>复制</span><small>⌘C</small>
            </button>
            <button className="rc-menu-item" data-testid="node-menu-paste" onClick={() => { pasteClipboard(); setNodeMenu(null); }}>
              <Clipboard size={16} /><span>粘贴</span><small>⌘V</small>
            </button>
            <button className="rc-menu-item" data-testid="node-menu-duplicate" onClick={() => { duplicateSelection(); setNodeMenu(null); }}>
              <CopyPlus size={16} /><span>副本</span><small>⌘D</small>
            </button>
            <button className="rc-menu-item" data-testid="node-menu-delete" onClick={() => { deleteSelection(); setNodeMenu(null); }}>
              <Trash2 size={16} /><span>删除</span><small>⌫,del</small>
            </button>
            {menuNode && menuNode.kind === "image" ? <button className="rc-menu-item" data-testid="node-menu-copy-clipboard" onClick={() => { if (menuNode) { void copyNodeToClipboard(menuNode); setNodeMenu(null); } }}><ClipboardCopy size={16} /><span>复制到剪贴板</span></button> : null}
            {menuNode && menuNode.kind === "image" ? <button className="rc-menu-item" data-testid="node-menu-image-edit" onClick={() => { if (menuNode) canvasRef.current?.openImageEditor(menuNode.id); setNodeMenu(null); }}><Wand2 size={16} /><span>编辑图片</span></button> : null}
            <button className="rc-menu-item" data-testid="node-menu-feedback" onClick={() => { setFeedbackNodeId(menuNode ? menuNode.id : null); setFeedbackOpen(true); setNodeMenu(null); }}>
              <MessageCircle size={16} /><span>反馈问题</span>
            </button>
            {nodeMenuMulti || (menuNode && menuNode.kind === "group") ? <>
            <div className="rc-menu-group-title">操作</div>
            {menuNode && menuNode.kind === "group" ? (
              <>
                <button
                  className="rc-menu-item"
                  data-testid="node-menu-ungroup"
                  onClick={() => {
                    ungroupSelection();
                    setNodeMenu(null);
                  }}
                >
                  <LayoutGrid size={16} /><span>取消分组</span><small>⇧⌘G</small>
                </button>
                <button
                  className="rc-menu-item"
                  data-testid="node-menu-delete-group"
                  onClick={() => deleteGroupWithChildren(menuNode.id)}
                >
                  <Trash2 size={16} /><span>删除分组及子节点</span>
                </button>
              </>
            ) : (
              <button
                className="rc-menu-item"
                data-testid="node-menu-group"
                onClick={() => {
                  groupSelection();
                  setNodeMenu(null);
                }}
              >
                <LayoutGrid size={16} /><span>分组</span><small>⌘G</small>
              </button>
            )}
            <div className="rc-menu-group-title">对齐</div>
            <div className="rc-menu-align-grid" data-testid="canvas-align-grid">
              {ALIGN_BUTTONS.map((item) => (
                <button
                  key={item.mode}
                  className="rc-menu-align-btn"
                  data-testid={"node-menu-" + item.mode}
                  title={item.label}
                  disabled={
                    item.mode === "hdist" || item.mode === "vdist" ? alignableNow.length < 3 : alignableNow.length < 2
                  }
                  onClick={() => {
                    alignSelection(item.mode);
                    setNodeMenu(null);
                  }}
                >
                  {item.short}
                </button>
              ))}
            </div>
            <button
              className="rc-menu-item"
              data-testid="node-menu-grid"
              disabled={alignableNow.length < 2}
              onClick={() => {
                arrangeGrid();
                setNodeMenu(null);
              }}
            >
              <LayoutGrid size={16} /><span>整理为网格</span>
            </button>
            </> : null}
          </div>
        ) : null}

        {feedbackOpen ? <FeedbackDialog canvasId={canvasId} nodeId={feedbackNodeId} onClose={() => setFeedbackOpen(false)} /> : null}
        <div className="rc-topbar">
          <button className="rc-connect-agent" data-testid="connect-agent" aria-label="连接 Agent" title="连接 Agent" onClick={() => setConnectOpen(true)}>
            <Plug size={18} />
          </button>
          <button className="rc-usage-entry" data-testid="usage-open" aria-label="模型调用次数（积分计费未接入）" title="模型调用次数（积分计费未接入）" onClick={() => void openUsage()}>{usage ? usage.calls : "—"}</button>
          <button className="rc-community-entry" data-testid="community-open" onClick={() => setCommunityOpen(true)}>社区</button>

          <button className="rc-share-button" data-testid="share-open" aria-label="分享" onClick={() => { setShareNonce((value) => value + 1); setShareOpen(true); setInviteOpen(false); setPanel(null); setAddMenuOpen(false); }}>
            <Share2 size={14} /><span>共享</span>
          </button>
        </div>
        {identityOpen ? (
          <div className="rc-identity-popover" data-testid="identity-popover" role="dialog" aria-label="匿名身份">
            <div className="rc-identity-head"><strong>匿名身份</strong><span className="rc-dot is-on" />本机</div>
            <div className="rc-identity-row"><span>客户端 ID</span><b className="rc-mono" data-testid="identity-client-id">{(clientId || "local").slice(0, 8)}</b></div>
            <div className="rc-identity-row"><span>协作人数</span><b data-testid="identity-peer-count">{peerCount} 人</b></div>
            <div className="rc-identity-row"><span>当前画布</span><b className="rc-identity-canvas">{title}</b></div>
            <div className="rc-identity-row"><span>连接状态</span><b>本机 BroadcastChannel</b></div>
            <button className="rc-identity-copy" data-testid="identity-copy" onClick={async () => {
              const value = clientId || "local";
              try { await navigator.clipboard.writeText(value); } catch { const area = document.createElement("textarea"); area.value = value; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }
              setIdentityCopied(true);
              window.setTimeout(() => setIdentityCopied(false), 1800);
            }}>{identityCopied ? "已复制" : "复制客户端 ID"}</button>
            <p className="rc-identity-hint">不显示账号、登录或权限信息；仅用于同源标签页协作。</p>
          </div>
        ) : null}
        {usageOpen ? <div className="rc-usage-panel" data-testid="usage-panel" role="dialog" aria-label="用量">
          <div className="rc-usage-head"><strong>用量</strong><button data-testid="usage-close" onClick={() => setUsageOpen(false)}>×</button></div>
          <p data-testid="usage-billing">积分计费未接入，这里展示真实调用统计</p>
          <dl><div><dt>模型调用次数</dt><dd data-testid="usage-calls">{usage ? usage.calls : "—"}</dd></div><div><dt>Token 使用</dt><dd data-testid="usage-tokens">{usage ? usage.tokens : "—"}</dd></div><div><dt>最近调用</dt><dd data-testid="usage-last">{usage && usage.lastCallAt ? new Date(usage.lastCallAt).toLocaleString("zh-CN") : "暂无"}</dd></div></dl>
        </div> : null}
        {communityOpen ? <div className="rc-community-panel" data-testid="community-panel" role="dialog" aria-label="社区">
          <div className="rc-usage-head"><strong>社区</strong><button data-testid="community-close" onClick={() => setCommunityOpen(false)}>×</button></div>
          <p>社区未接入（无后端/入口），这里不展示帖子内容。</p>
        </div> : null}
        {connectOpen ? (
          <div className="rc-connect-overlay" data-testid="connect-overlay" onClick={() => setConnectOpen(false)}>
            <div className="rc-connect-modal" data-testid="connect-agent-modal" role="dialog" aria-modal="true" aria-label="在 Agent 中打开" onClick={(event) => event.stopPropagation()}>
              <button className="rc-connect-close" aria-label="关闭" data-testid="connect-close" onClick={() => setConnectOpen(false)}><X size={16} /></button>
              <div className="rc-connect-rail">
                <h2>在 Agent 中打开</h2>
                {connectAgents.map((agent) => (
                  <button
                    key={agent.id}
                    className={"rc-connect-agent-row" + (connectAgent === agent.id ? " is-active" : "") + (agent.unavailable ? " is-disabled" : "")}
                    data-testid={"connect-agent-" + agent.id}
                    disabled={"unavailable" in agent && agent.unavailable}
                    title={"unavailable" in agent && agent.unavailable ? "缺后端：更多 Agent 尚未接入" : "复制项目提示词"}
                    onClick={() => setConnectAgent(agent.id)}
                  >
                    <span className="rc-connect-agent-dot" />{agent.label}
                  </button>
                ))}
                <a className="rc-connect-mcp-link" href="#" onClick={(event) => { event.preventDefault(); void openMcpSettings(); }} data-testid="connect-mcp-link">了解 OpenArc MCP</a>
              </div>
              <div className="rc-connect-main">
                <div className="rc-connect-hero" aria-hidden="true"><span className="rc-connect-hero-a" /><span className="rc-connect-hero-b" /></div>
                <div className="rc-connect-copy">
                  <h3>{activeConnectAgent.desc}</h3>
                  <p>打开 {activeConnectAgent.label} 并预填一段提示词，通过 MCP 连接到 OpenArc 并交接当前项目。首次使用时 {activeConnectAgent.label} 会引导你添加连接器并登录 OpenArc。</p>
                </div>
                <div className="rc-connect-footer">
                  <button className="rc-connect-prompt" data-testid="connect-copy-prompt" onClick={() => void copyConnectPrompt()}><Copy size={14} />没有打开？复制提示词</button>
                  <button className="rc-connect-open" data-testid="connect-mcp-settings" disabled={!hostMcpOpen} title={hostMcpOpen ? "打开 MCP 设置" : "缺宿主 MCP 中心入口"} onClick={() => openMcpSettings()}>打开 MCP 设置</button>
                  <button className="rc-connect-open" onClick={() => { void copyConnectPrompt(); }}>在 {activeConnectAgent.label} 打开</button>
                </div>
              </div>
              {connectToast ? <div className="rc-connect-toast" data-testid="connect-toast">{connectToast}</div> : null}
            </div>
          </div>
        ) : null}
        {shareOpen || inviteOpen ? (
          <div className="rc-share-layer" data-testid="share-layer">
            {shareOpen ? (
              <div className="rc-share-export" data-testid="share-export">
                <button className="rc-share-button" data-testid="export-open" aria-label="导出" onClick={() => { setExportOpen(!exportOpen); setExportState(null); }}>导出 PNG</button>
                {exportOpen ? <div className="rc-export-menu" data-testid="export-menu" role="menu">
                  {(["view", "selected", "all"] as const).map((scope) => <button key={scope} data-testid={"export-" + scope} role="menuitem" onClick={async () => { try { const result = await canvasRef.current?.exportPng(scope); setExportState({ text: "已导出 PNG · " + (result ? result.width + "×" + result.height : ""), error: false }); } catch (caught) { setExportState({ text: caught instanceof Error ? caught.message : "导出失败", error: true }); } }}>{scope === "view" ? "导出当前视图" : scope === "selected" ? "导出选中节点" : "导出整个画布"}</button>)}
                  {exportState ? <div className={"rc-export-state" + (exportState.error ? " is-error" : "")} data-testid="export-state">{exportState.text}</div> : null}
                </div> : null}
              </div>
            ) : null}
            {shareOpen ? (
              <CanvasSharePanel
                key={"share-" + shareNonce}
                canvasId={canvasId}
                title={title}
                cmd={shareCmd}
                onClose={() => setShareOpen(false)}
                onData={(data) => setShareCanManage(!!data?.canManage)}
                onOpenInvite={() => { setInviteOpen(true); setShareOpen(false); }}
              />
            ) : null}
            {inviteOpen ? (
              <CanvasInvitePanel
                canvasId={canvasId}
                title={title}
                canManage={shareCanManage}
                cmd={shareCmd}
                onClose={() => setInviteOpen(false)}
              />
            ) : null}
            <div className="rc-share-extra">
              <LanCollabPanel canvasId={canvasId} onJoin={joinLanSession} getHandlers={lanHandlers} />
              <button disabled title="缺后端：没有公开链接命令">公开链接（缺后端）</button>
              <button disabled title="缺后端：没有克隆 token 命令">克隆 Token（缺后端）</button>
            </div>
          </div>
        ) : null}
        {commentMode ? (
          <div className="rc-comment-bar" data-testid="comment-bar">
            <textarea
              ref={commentInputRef}
              className="rc-comment-input"
              data-testid="comment-input"
              placeholder="输入你的评论..."
              maxLength={200}
              rows={2}
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value.slice(0, 200))}
            />
            <div className="rc-comment-bar-foot">
              <span className="rc-comment-count" data-testid="comment-count">{commentDraft.length}/200</span>
              <button className="rc-comment-send" data-testid="comment-send" aria-label="发送评论" disabled={!pendingComment || !commentDraft.trim()} onClick={submitComment}>
                <Send size={14} />
              </button>
            </div>
          </div>
        ) : null}
        <input ref={addUploadRef} type="file" accept="image/*" multiple hidden data-testid="add-upload-input" onChange={handleAddUpload} />
        {appUploadError ? <div className="rc-upload-error" data-testid="upload-error">{appUploadError}</div> : null}
        {panel === "search" ? (
          <div className="rc-search-overlay" onClick={() => setPanel(null)}>
            <div className="rc-search-panel" data-testid="search-panel" role="dialog" aria-label="节点搜索" onClick={(event) => event.stopPropagation()}>
              <div className="rc-search-head">
                <Search size={18} />
                <input
                  className="rc-search-input"
                  data-testid="search-input"
                  autoFocus
                  placeholder="搜索节点..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="rc-search-chips">
                {SEARCH_CHIPS.map((chip) => (
                  <button
                    key={chip.id}
                    className={"rc-search-chip" + (searchChip === chip.id ? " is-active" : "")}
                    data-testid={"search-chip-" + chip.id}
                    onClick={() => setSearchChip(chip.id)}
                  >
                    {searchChipIcon(chip.id)}<span>{chip.label}</span>
                  </button>
                ))}
              </div>
              <div className="rc-search-results">
                {searchResults.length === 0 ? (
                  <div className="rc-search-empty" data-testid="search-empty"><p>暂无可搜索节点</p></div>
                ) : (
                  searchResults.map((node) => (
                    <button
                      key={node.id}
                      className="rc-search-item"
                      data-testid="search-result"
                      onClick={() => {
                        setSelectedNodeIds([node.id]);
                        setSelectedEdgeId(null);
                        if (canvasRef.current) canvasRef.current.focusNode(node.id);
                        setPanel(null);
                      }}
                    >
                      {kindIcon(node.kind)}
                      <span className="rc-search-item-text">
                        <span className="rc-search-item-title">{searchNodeTitle(node)}</span>
                        <span className="rc-search-item-summary">{searchNodeSummary(node)}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : panel === "templates" ? (
          <TemplatesPanel
            onClose={() => setPanel(null)}
            onUse={(prompt) => {
              setDraft(prompt);
              setAgentOpen(true);
              setPanel(null);
              window.requestAnimationFrame(() => agentInputRef.current?.focus());
            }}
          />
        ) : panel === "history" ? (
          <HistoryPanel
            canvasId={canvasId}
            onClose={() => setPanel(null)}
            onInsert={(item) => {
              const center = canvasRef.current?.centerWorld() || { x: 0, y: 0 };
              const imageSize = NODE_SIZE.image;
              const node = makeNode("image", center.x - imageSize.w / 2, center.y - imageSize.h / 2, item.title || "");
              dispatch({ type: "add-node", node: { ...node, url: item.url || item.previewUrl } }, { history: true });
              setPanel(null);
            }}
          />
        ) : panel === "assets" ? (
          <AssetsPanel canvasId={canvasId} onClose={() => setPanel(null)} onInsertCharacter={(character) => {
            const center = canvasRef.current?.centerWorld() || { x: 0, y: 0 };
            const text = "角色：" + character.name + "\n" + (character.description || "") + "\n\n" + (character.prompt || "");
            const note = makeNode("note", center.x - 130, center.y - 80, text);
            dispatch({ type: "add-node", node: { ...note, refUrl: character.referenceUrls?.[0] } }, { history: true });
            setPanel(null);
          }} />
        ) : panel ? (
          <div className="rc-panel" data-testid="tool-panel">
            <div className="rc-panel-head">
              <strong>{PANEL_TITLE[panel]}</strong>
              <button className="rc-icon-button" aria-label="关闭" onClick={() => setPanel(null)}>
                <X size={14} />
              </button>
            </div>
            {panelBody()}
          </div>
        ) : null}
      </div>

      <aside className={"rc-agent" + (agentOpen ? "" : " is-collapsed")} aria-label="画布助手" aria-hidden={!agentOpen}>
        <div className="rc-agent-head">
          <button className="rc-agent-head-btn" data-testid="agent-sidebar-toggle" aria-label="侧边栏" aria-pressed={agentSidebarOpen} onClick={() => setAgentSidebarOpen(!agentSidebarOpen)}>
            <PanelLeft size={15} />
          </button>
          <button className="rc-agent-title-row" data-testid="agent-history" aria-expanded={agentMenu === "history"} onClick={() => setAgentMenu(agentMenu === "history" ? null : "history")}>
            <span className="rc-agent-title">新建对话</span>
            <ChevronDown size={13} />
          </button>
          <div className="rc-agent-head-actions">
            <button className="rc-agent-head-btn" data-testid="agent-new-chat" aria-label="新对话" title="新对话" onClick={startNewConversation}><Pencil size={14} /></button>
            <button className="rc-agent-head-btn" data-testid="agent-fullscreen" aria-label="Agent 全屏" title="Agent 全屏" onClick={() => { setAgentFullscreen(!agentFullscreen); setPreviewVisible(true); }}><Maximize2 size={14} /></button>
            <button className="rc-agent-head-btn" data-testid="agent-more" aria-label="更多选项" title="更多选项" aria-expanded={agentMenu === "more"} onClick={() => setAgentMenu(agentMenu === "more" ? null : "more")}><MoreHorizontal size={15} /></button>
          </div>
        </div>
        {agentMenu === "history" ? (
          <div className="rc-agent-pop" data-testid="agent-history-menu">
            <button className="rc-agent-pop-item" data-testid="agent-current-conversation" onClick={() => setAgentMenu(null)}><MessageSquare size={13} /><span>当前对话</span></button>
            <button className="rc-agent-pop-item" data-testid="agent-history-new" onClick={startNewConversation}><Pencil size={13} /><span>新建对话</span></button>
            <div className="rc-menu-group-title">历史记录</div>
            {agentHistory.length === 0 ? <p className="rc-agent-pop-empty">暂无历史对话</p> : agentHistory.map((entry) => (
              <button key={entry.id} className="rc-agent-pop-item" data-testid="agent-history-item" onClick={() => restoreConversation(entry)}>
                <HistoryIcon size={13} /><span>{entry.title}</span><small>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
              </button>
            ))}
          </div>
        ) : null}
        {agentMenu === "more" ? (
          <div className="rc-agent-pop" data-testid="agent-more-menu">
            <div className="rc-agent-usage" data-testid="agent-usage">用量统计 <small>{messages.length} 条消息 · 约 {agentTokens} token</small></div>
            <button className="rc-agent-pop-item" data-testid="agent-collapse" onClick={() => { setAgentMenu(null); setAgentOpen(false); }}><ChevronRight size={13} /><span>收起对话</span></button>
          </div>
        ) : null}
        {agentSidebarOpen ? (
          <div className="rc-agent-sidebar" data-testid="agent-sidebar">
            <div className="rc-agent-sidebar-tabs">
              <button className={agentSidebarTab === "files" ? "is-active" : ""} data-testid="agent-sidebar-files" onClick={() => setAgentSidebarTab("files")}>文件</button>
              <button className={agentSidebarTab === "outputs" ? "is-active" : ""} data-testid="agent-sidebar-outputs" onClick={() => setAgentSidebarTab("outputs")}>输出</button>
              <button className="rc-agent-sidebar-close" aria-label="关闭侧边栏" onClick={() => setAgentSidebarOpen(false)}><X size={13} /></button>
            </div>
            <div className="rc-agent-sidebar-body">
              {agentSidebarTab === "outputs" ? (recentOutputs.length ? <div className="rc-agent-outputs" data-testid="agent-outputs">{recentOutputs.map((node) => <button key={node.id} className="rc-agent-output-item" data-testid="agent-output-item" onClick={() => { setSelectedNodeIds([node.id]); setSelectedEdgeId(null); canvasRef.current?.focusNode(node.id); }}><span>{NODE_KIND_LABEL[node.kind]}</span><span>{node.text || node.id.slice(-4)}</span></button>)}</div> : <p data-testid="agent-outputs-empty">暂无输出</p>) : <p data-testid="agent-files-empty">暂无文件</p>}
            </div>
          </div>
        ) : null}
        {undoMessages ? (
          <div className="rc-agent-undo" data-testid="agent-undo-bar">
            <span>已开始新对话</span>
            <button data-testid="agent-undo" onClick={() => { setMessages(undoMessages); setUndoMessages(null); }}>撤销</button>
          </div>
        ) : null}
        <div className="rc-messages" ref={messagesRef} data-testid="agent-messages">
          {messages.map((message) => (
            <div key={message.id} className={"rc-msg rc-msg-" + message.role} data-role={message.role}>
              {message.text}
            </div>
          ))}
        </div>
        {streamError ? <div className="rc-agent-retrybar" data-testid="agent-retry-bar">模型调用失败：{streamError}<button data-testid="agent-retry" onClick={() => { setStreamError(""); void executePrompt(lastPromptRef.current, true); }}>重试</button></div> : null}
        {messages.some((message) => message.role === "user") ? <div className="rc-chips">
          {QUICK_COMMANDS.map((command) => (
            <button key={command} className="rc-chip" onClick={() => runCommand(command)}>
              {command}
            </button>
          ))}
        </div> : null}
        {!messages.some((message) => message.role === "user") ? (
          <div className="rc-agent-greeting" data-testid="agent-greeting"><strong>Hi {agentName}！</strong><span>今天一起创作点什么？</span></div>
        ) : null}
        {!messages.some((message) => message.role === "user") ? (
          <div className="rc-agent-suggestions" data-testid="agent-suggestions">
            {suggestionPage.map((suggestion) => (
              <button key={suggestion.title} className="rc-agent-suggestion" data-testid="agent-suggestion" onClick={() => { setDraft(suggestion.title + "：" + suggestion.desc); agentInputRef.current?.focus(); }}>
                <span className="rc-agent-suggestion-title">{suggestion.title}</span>
                <span className="rc-agent-suggestion-desc">{suggestion.desc}</span>
                <ChevronRight size={14} className="rc-agent-suggestion-arrow" />
              </button>
            ))}
          </div>
        ) : null}
        {pendingConfirm ? (
          <div className="rc-agent-confirm" data-testid="agent-confirm-bar">
            <span>执行前确认：{pendingConfirm}</span>
            <button data-testid="agent-confirm-yes" onClick={() => { const text = pendingConfirm; setPendingConfirm(null); void executePrompt(text, true); }}>确认执行</button>
            <button data-testid="agent-confirm-no" onClick={() => setPendingConfirm(null)}>取消</button>
          </div>
        ) : null}
        <div className="rc-agent-inputwrap">
          {references.length ? (
            <div className="rc-agent-references">
              {references.map((reference) => (
                <span key={reference.id} className="rc-agent-reference" data-testid="agent-reference-chip">
                  {reference.label}
                  <button aria-label="移除引用" onClick={() => setReferences((list) => list.filter((item) => item.id !== reference.id))}><X size={10} /></button>
                </span>
              ))}
            </div>
          ) : null}
          {recording && voiceInterim ? <div className="rc-voice-interim" data-testid="agent-voice-interim">{voiceInterim}</div> : null}
          <div className="rc-composer rc-composer-agent">
            <textarea
              className="rc-input rc-input-multiline"
              ref={agentInputRef}
              data-testid="agent-input"
              rows={1}
              placeholder="输入本地指令，例如：添加图片节点"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitDraft();
                }
              }}
            />
            <div className="rc-agent-context-row">
              <span className="rc-badge">{chatModels.length ? "有可用模型" : "未配置模型"}</span>
              <span className="rc-agent-status" data-testid="collab-status" title="同源标签页实时协作"><span className={"rc-dot" + (peerCount ? " is-on" : "")} />{peerCount ? "协作 " + peerCount + " 人" : "仅本机"}</span>
            </div>
            <div className="rc-agent-inputbar">
              <button className="rc-agent-toolbtn" data-testid="agent-plus" aria-label="更多输入" onClick={() => { setPlusOpen(!plusOpen); setContextOpen(false); setModelMenu(false); }}><Plus size={15} /></button>
              <button className="rc-agent-toolbtn" data-testid="agent-context" onClick={() => { setContextOpen(!contextOpen); setPlusOpen(false); setModelMenu(false); }}>◔ 估算</button>
              <button className="rc-agent-toolbtn" data-testid="agent-model" title={selectedChatModel ? "选择对话模型：" + selectedChatModel.label : "未配置模型"} onClick={() => { setModelMenu(!modelMenu); setPlusOpen(false); setContextOpen(false); }}>{selectedChatModel?.label || "未配置模型"}<ChevronDown size={12} /></button>
              <button className={"rc-agent-toolbtn" + (confirmMode ? " is-active" : "")} data-testid="agent-confirm" aria-pressed={confirmMode} title="Agent 在执行生成前都会寻求您的确认" onClick={() => setConfirmMode(!confirmMode)}><ShieldCheck size={14} /></button>
              <button className={"rc-agent-toolbtn" + (recording ? " is-recording" : "")} data-testid={recording ? "agent-recording" : "agent-mic"} aria-label={recording ? "停止录音" : "语音输入"} disabled={!canvasSettings.voiceEnabled && !recording} title={canvasSettings.voiceEnabled ? (recording ? "停止录音" : "语音输入") : "请先在设置开启语音输入"} onClick={() => { void startVoiceRecording(); }}><Mic size={15} />{recording ? " " + recordingSeconds + "s" : ""}</button>
              {streaming ? (
              <button className="rc-send rc-send-stop" data-testid="agent-stop" aria-label="停止" onClick={() => { const bridge = canvasBridge(); if (bridge && streamRunRef.current) void bridge.command({ type: "canvas/runStop", canvasId, runId: streamRunRef.current, reason: "USER_STOP" }); streamRequestRef.current = ""; setStreaming(false); }}>■</button>
            ) : (
              <button className="rc-send" data-testid="agent-send" aria-label="发送" onClick={submitDraft}><Send size={15} /></button>
            )}
            </div>
            {voiceError ? <div className="rc-voice-status is-error" data-testid="voice-error">{voiceError}</div> : null}
            {voiceNotice ? <div className="rc-voice-status" data-testid="voice-notice">{voiceNotice}</div> : null}
          </div>
          {plusOpen ? (
            <div className="rc-agent-pop rc-agent-inputpop" data-testid="agent-plus-menu">
              <div className="rc-menu-group-title">从画布添加</div>
              {doc.nodes.length === 0 ? <p className="rc-agent-pop-empty">画布暂无节点</p> : doc.nodes.slice(0, 8).map((node) => (
                <button key={node.id} className="rc-agent-pop-item" data-testid="agent-add-node" onClick={() => { setReferences((list) => list.some((item) => item.id === node.id) ? list : [...list, { id: node.id, label: NODE_KIND_LABEL[node.kind] + " " + searchNodeTitle(node) }]); setPlusOpen(false); }}>
                  <Plus size={13} /><span>{NODE_KIND_LABEL[node.kind]} · {searchNodeTitle(node)}</span>
                </button>
              ))}
              <div className="rc-menu-group-title">更多</div>
              <button className="rc-agent-pop-item is-disabled" disabled title="缺后端"><Paperclip size={13} /><span>上传附件</span><small>缺后端</small></button>
              <button className="rc-agent-pop-item is-disabled" disabled title="缺后端"><Sparkles size={13} /><span>技能</span><small>缺后端</small></button>
              <button className="rc-agent-pop-item is-disabled" disabled title="缺后端"><Lightbulb size={13} /><span>头脑风暴</span><small>缺后端</small></button>
              <button className="rc-agent-pop-item is-disabled" disabled title="缺后端"><LayoutGrid size={13} /><span>全部应用</span><small>缺后端</small></button>
            </div>
          ) : null}
          {contextOpen ? (
            <div className="rc-agent-pop rc-agent-inputpop" data-testid="agent-context-bubble">
              <div className="rc-agent-usage">上下文占用 <small>{messages.length} 条消息 · 约 {agentTokens} token · 估算（无真实上下文窗）</small></div>
            </div>
          ) : null}
          {modelMenu ? (
            <div className="rc-agent-pop rc-agent-inputpop" data-testid="agent-model-menu">
              {chatModels.length === 0 ? <p className="rc-agent-pop-empty">未配置模型</p> : chatModels.map((model) => <button key={model.configId} className="rc-agent-pop-item" data-testid="agent-model-option" data-config-id={model.configId} onClick={() => { selectModelConfig("chat", model.configId); setModelMenu(false); }}><Sparkles size={16} /><span className="rc-model-option-text"><strong>{model.label}</strong>{model.providerName ? <small>{model.providerName}</small> : null}</span>{selectedChatModel?.configId === model.configId ? <Check size={14} className="rc-model-option-check" /> : null}</button>)}
              <button className="rc-agent-pop-item" data-testid="agent-open-model-settings" disabled={!modelHostOpen} title={modelHostOpen ? "打开模型设置" : "缺宿主模型设置入口"} onClick={() => { setModelMenu(false); modelHostOpen?.(); }}><LayoutGrid size={13} /><span>打开模型设置</span></button>
            </div>
          ) : null}
        </div>
        <div className="rc-agent-foot">
          画布 <code>{canvasId}</code> · 打开另一标签页 canvas-react.html?canvas={canvasId} 即可实时协作
        </div>
      </aside>
    </div>
  );
}

function CanvasPicker({ onOpen }: { onOpen: (entry: CanvasEntry) => void }) {
  const [entries, setEntries] = useState<CanvasEntry[]>(() => readLocalList());
  const [source, setSource] = useState<"bridge" | "local">("local");
  const [status, setStatus] = useState("正在读取画布列表…");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const bridge = canvasBridge();
    if (!bridge) {
      setSource("local");
      setStatus("画布命令不可用，使用本地画布列表。");
      return () => {
        cancelled = true;
      };
    }
    bridge
      .command({ type: "canvas/list" })
      .then((res) => {
        if (cancelled) return;
        if (res && res.ok && Array.isArray(res.items)) {
          const items = (res.items as Array<Record<string, unknown>>)
            .map((item) => ({ id: normalizeCanvasId(String(item.canvasId || "")), title: String(item.title || "未命名画布") }))
            .filter((entry) => entry.id !== "default");
          setEntries(items);
          writeLocalList(items);
          setSource("bridge");
          setStatus(items.length ? "" : "还没有画布，先新建一个。");
        } else {
          setSource("local");
          setStatus("读取画布列表失败，使用本地列表。");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setSource("local");
        setStatus("读取画布列表失败，使用本地列表。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (entry: CanvasEntry) => {
    writeLocalList(withEntry(readLocalList(), entry));
    onOpen(entry);
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    const name = title.trim() || "未命名画布";
    const bridge = canvasBridge();
    if (bridge) {
      try {
        const res = await bridge.command({ type: "canvas/create", title: name, icon: "🧩", kind: "classic" });
        const canvas =
          res && res.ok && res.canvas && typeof res.canvas === "object" ? (res.canvas as Record<string, unknown>) : null;
        if (canvas) {
          open({ id: normalizeCanvasId(String(canvas.canvasId || "")), title: String(canvas.title || name) });
          setBusy(false);
          return;
        }
      } catch {
        return;
      }
    }
    open({ id: normalizeCanvasId("local-" + Date.now().toString(36)), title: name });
    setBusy(false);
  };

  return (
    <div className="rc-picker" data-testid="canvas-picker">
      <div className="rc-picker-card">
        <div className="rc-picker-head">
          <strong>画布</strong>
          <span className="rc-badge">{source === "bridge" ? "画布命令" : "本地列表"}</span>
        </div>
        {status ? <p className="rc-empty">{status}</p> : null}
        <div className="rc-picker-list">
          {entries.length === 0 ? (
            <p className="rc-empty">还没有画布，先新建一个。</p>
          ) : (
            entries.map((entry) => (
              <button key={entry.id} className="rc-picker-row" data-testid="canvas-open" onClick={() => open(entry)}>
                <span>{entry.title}</span>
                <span className="rc-mono">{entry.id}</span>
              </button>
            ))
          )}
        </div>
        <div className="rc-picker-new">
          <input
            className="rc-input"
            data-testid="canvas-title-input"
            placeholder="新画布标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
          />
          <button className="rc-send" data-testid="canvas-create" aria-label="新建画布" onClick={() => void create()} disabled={busy}>
            <Plus size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
