import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Scene3D } from "./Scene3D";
import { ImageEditor } from "./ImageEditor";
import { AudioWaveform } from "./AudioWaveform";
import { MaskEditor } from "./MaskEditor";
import { Model3DViewer } from "./Model3DViewer";
import { exportCanvasPng } from "./exportCanvas";
import { TimelineWaveform } from "./TimelineWaveform";
import productDoc from "../../../PRODUCT.md?raw";
import changelogDoc from "../../../CHANGELOG.md?raw";
import { downloadTimelineBlob, exportTimelineWebM } from "./timelineExport";
import { backendExportAvailable, exportTimelineMp4 } from "./timelineExportBackend";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArrowUp, Box, Check, Coins, Music, Video, Film, Download, Eye, RotateCw, FlipHorizontal2, FlipVertical2, SlidersHorizontal, Crop, PenLine, Grid3X3, EyeOff, HelpCircle, Image as ImageIcon, Keyboard, Layers, Magnet, Map as MapIcon, LayoutGrid, Mic, MousePointer2, Plus, RotateCcw, Sparkles, StickyNote, Type, Upload, Wand2, X } from "lucide-react";
import {
  makeId,
  makeNode,
  NODE_KIND_LABEL,
  type CanvasComment,
  type CanvasDoc,
  type CanvasSettings,
  type Scene3DData,
  type CanvasNode,
  type CanvasOp,
} from "./reactCanvasStore";
import type { PeerCursor, PeerState } from "./reactCanvasCollab";

export type ReactCanvasHandle = {
  centerWorld: () => PeerCursor;
  lastWorldPoint: () => PeerCursor | null;
  fit: () => void;
  focusNode: (id: string) => void;
  exportPng: (scope: "view" | "selected" | "all") => Promise<{ bytes: number; width: number; height: number }>;
  openImageEditor: (nodeId?: string) => boolean;
};

type Props = {
  doc: CanvasDoc;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  peers: Record<string, PeerState>;
  onSelectNodes: (ids: string[]) => void;
  onSelectEdge: (id: string | null) => void;
  dispatch: (op: CanvasOp, opts?: { history?: boolean; historyBase?: CanvasDoc }) => void;
  onCursor: (cursor: PeerCursor | null) => void;
  onRequestAddMenu: (clientX: number, clientY: number) => void;
  onNodeContextMenu: (nodeId: string, clientX: number, clientY: number, multi?: boolean) => void;
  onCanvasContextMenu: (clientX: number, clientY: number) => void;
  onCanvasSuggestion?: (text: string) => void;
  onOpenFeedback?: () => void;
  onOpenTemplates?: () => void;
  onDismissMenus: () => void;
  comments: CanvasComment[];
  commentMode: boolean;
  pendingComment: { x: number; y: number } | null;
  clientId: string;
  onPlaceComment: (x: number, y: number) => void;
  onDeleteComment: (id: string) => void;
  imageModels: Array<{ label: string; configId: string; providerName?: string }>;
  selectedImageModelLabel?: string;
  canvasId?: string;
  selectedConfigs?: Record<string, string>;
  deletingNodeIds?: Set<string>;
  onSelectModel?: (kind: "image" | "video" | "audio" | "chat", configId: string) => void;
  videoModelLabel?: string;
  audioModelLabel?: string;
  videoModels: Array<{ label: string; configId: string; providerName?: string }>;
  onGenerateVideo: (nodeId: string, prompt: string) => void;
  onReloadVideoModels?: () => void;
  chatModels: Array<{ label: string; configId: string; providerName?: string }>;
  onEnhancePrompt: (prompt: string) => Promise<string>;
  audioModels: Array<{ label: string; configId: string; providerName?: string }>;
  onGenerateAudio: (nodeId: string, prompt: string) => void;
  onStopGeneration?: (nodeId: string) => void;
  onReloadAudioModels?: () => void;
  generation: Record<string, { status: "pending" | "error"; error?: string }>;
  onGenerateImage: (nodeId: string, prompt: string) => void;
  onOpenModelSettings?: () => void;
  onReloadModels?: () => void;
  settings: CanvasSettings;
  onUpdateSettings: (patch: Partial<CanvasSettings>) => void;
};

type View = { k: number; x: number; y: number };
type DragState = {
  id: string;
  startX: number;
  startY: number;
  nodeX: number;
  nodeY: number;
  base: CanvasDoc;
  moved: boolean;
  children: Array<{ id: string; x: number; y: number }>;
};
type PanState = { startX: number; startY: number; viewX: number; viewY: number };
type MarqueeState = { startX: number; startY: number };

// TapNow 点阵：40px 间距、r=1 白点 rgba(255,255,255,0.3)
const GRID = 40;
// TapNow：缩放范围固定 15%–200%（滑块 aria-valuemin/max = 0.15 / 2，截图 55-zoom-out.png 为 15%）
const MIN_SCALE = 0.15;
const MAX_SCALE = 2;
// 缩放条 +/- 与滑块方向键 = 1 个百分点；⌘+/⌘- = 5 个百分点（TapNow 该快捷键未实测，不臆造）
const ZOOM_STEP = 0.01;
const ZOOM_KEY_STEP = 0.05;
const TRACKPAD_PINCH_THRESHOLD = 5;
// TapNow 小地图浮层：约 190×128
const MINIMAP_W = 190;
const MINIMAP_H = 128;
const MINIMAP_PAD = 40;

const GRID_SNAP_KEY = "openarc-canvas-react:grid-snap";
const HELP_DISABLED_ITEMS = ["最近更新", "使用教程", "连接 Agent", "反馈问题"];
const SHORTCUTS: Array<{ keys: string; label: string; unavailable?: boolean }> = [
  { keys: "空白拖拽", label: "平移画布" },
  { keys: "滚轮 / 捏合", label: "缩放（指针锚点，15%–200%）" },
  { keys: "Ctrl/⌘ + 拖拽", label: "框选节点" },
  { keys: "Ctrl/⌘ + Z", label: "撤销" },
  { keys: "⇧⌘ + Z / ⌘Y", label: "重做" },
  { keys: "⌘A", label: "全选" },
  { keys: "⌘C / ⌘V", label: "复制 / 粘贴" },
  { keys: "⌘D", label: "创建副本" },
  { keys: "Delete / Backspace", label: "删除选中" },
  { keys: "方向键 / Shift+方向键", label: "微调节点（10px）" },
  { keys: "⌘G / ⇧⌘G", label: "分组 / 取消分组" },
  { keys: "⌘F", label: "搜索节点" },
  { keys: "⌘J", label: "显示/隐藏助手" },
  { keys: "⌘0", label: "重置视图（100% 居中）" },
  { keys: "⌘+ / ⌘-", label: "缩放（5 个百分点）" },
  { keys: "⌘1", label: "适应视图" },
  { keys: "⌘Enter", label: "在节点内直接生成", unavailable: true },
  { keys: "Alt + 方向键", label: "多选对齐", unavailable: true },
  { keys: "Alt + 拖拽", label: "拖动复制节点", unavailable: true },
];
const PEER_COLORS = ["#8e8e93", "#636366", "#aeaeb2", "#48484a", "#7c7c80"];

const IMAGE_UPLOAD_LIMIT = 20 * 1024 * 1024;
function readImageFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("不是图片文件：" + file.name));
  if (file.size > IMAGE_UPLOAD_LIMIT) return Promise.reject(new Error("图片超过 20MB：" + file.name));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取失败：" + file.name));
    reader.readAsDataURL(file);
  });
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// novai 用 NovaViewport.isMouseWheel 区分「鼠标滚轮 = 缩放」与「触控板双指 = 平移」。
function isMouseWheelEvent(event: WheelEvent): boolean {
  if (event.deltaMode !== 0) return true;
  return Math.abs(event.deltaY) >= 100;
}

function peerColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PEER_COLORS[hash % PEER_COLORS.length];
}

function shortLabel(id: string): string {
  return id.slice(0, 6);
}

function edgePathToPoint(node: CanvasNode, side: "left" | "right", px: number, py: number): string {
  const ax = side === "right" ? node.x + node.w : node.x;
  const ay = node.y + node.h / 2;
  const dir = side === "right" ? 1 : -1;
  const out = Math.max(48, Math.abs(px - ax) * 0.45);
  const inDir = px >= ax ? -1 : 1;
  return (
    "M " + ax + " " + ay + " C " + (ax + out * dir) + " " + ay + ", " +
    (px + out * inDir) + " " + py + ", " + px + " " + py
  );
}

function edgeGeometry(from: CanvasNode, to: CanvasNode, fromSide: "left" | "right"): string {
  const fromCenter = from.x + from.w / 2;
  const toCenter = to.x + to.w / 2;
  const tx = toCenter >= fromCenter ? to.x : to.x + to.w;
  const ty = to.y + to.h / 2;
  return edgePathToPoint(from, fromSide, tx, ty);
}

function kindGlyph(kind: CanvasNode["kind"]) {
  if (kind === "image") return <ImageIcon size={12} />;
  if (kind === "video") return <Video size={12} />;
  if (kind === "audio") return <Mic size={12} />;
  if (kind === "text") return <Type size={12} />;
  if (kind === "group") return <Layers size={12} />;
  return <StickyNote size={12} />;
}

export const ReactCanvas = forwardRef<ReactCanvasHandle, Props>(function ReactCanvas(props, ref) {
  const { doc, selectedNodeIds, selectedEdgeId, peers } = props;
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [connect, setConnect] = useState<{ from: string; side: "left" | "right"; x: number; y: number } | null>(null);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [showEdges, setShowEdges] = useState(!props.settings.hideEdges);
  const [gridSnap, setGridSnap] = useState<boolean>(() => {
    try {
      return props.settings.gridSnap || window.localStorage.getItem(GRID_SNAP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const elWidthRef = useRef(0);
  const elHeightRef = useRef(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const docRef = useRef(doc);
  docRef.current = doc;
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const connectRef = useRef<{ from: string; side: "left" | "right" } | null>(null);
  const textBaseRef = useRef<CanvasDoc | null>(null);
  const textTimer = useRef<number | null>(null);
  const lastCursor = useRef(0);
  const lastMouseWorldRef = useRef<PeerCursor | null>(null);
  const rKeyRef = useRef(false);
  const selectedRef = useRef(selectedNodeIds);
  selectedRef.current = selectedNodeIds;
  const dispatchRef = useRef(props.dispatch);
  dispatchRef.current = props.dispatch;

  useEffect(() => {
    try {
      window.localStorage.setItem(GRID_SNAP_KEY, gridSnap ? "1" : "0");
    } catch {
      return;
    }
  }, [gridSnap]);

  const snapCoord = (value: number) => (gridSnap ? Math.round(value / GRID) * GRID : value);

  const resetView = () => {
    const el = viewportRef.current;
    if (!el) return;
    const nodes = docRef.current.nodes;
    if (!nodes.length) {
      setView({ k: 1, x: el.clientWidth / 2, y: el.clientHeight / 2 });
      return;
    }
    const minX = Math.min.apply(null, nodes.map((node) => node.x));
    const minY = Math.min.apply(null, nodes.map((node) => node.y));
    const maxX = Math.max.apply(null, nodes.map((node) => node.x + node.w));
    const maxY = Math.max.apply(null, nodes.map((node) => node.y + node.h));
    setView({ k: 1, x: el.clientWidth / 2 - (minX + maxX) / 2, y: el.clientHeight / 2 - (minY + maxY) / 2 });
  };

  const zoomToPercent = (percent: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const sx = el.clientWidth / 2;
    const sy = el.clientHeight / 2;
    setView((prev) => {
      const target = clamp(percent / 100, MIN_SCALE, MAX_SCALE);
      if (Math.abs(target - prev.k) < 1e-6) return prev;
      const worldX = (sx - prev.x) / prev.k;
      const worldY = (sy - prev.y) / prev.k;
      return { k: target, x: sx - worldX * target, y: sy - worldY * target };
    });
  };

  const clientToWorld = (clientX: number, clientY: number): PeerCursor => {
    const el = viewportRef.current;
    const current = viewRef.current;
    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: (clientX - rect.left - current.x) / current.k,
      y: (clientY - rect.top - current.y) / current.k,
    };
  };

  const findNodeAt = (x: number, y: number): CanvasNode | undefined => {
    const nodes = docRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (x >= node.x && x <= node.x + node.w && y >= node.y && y <= node.y + node.h) return node;
    }
    return undefined;
  };

  const fitView = () => {
    const el = viewportRef.current;
    if (!el) return;
    const nodes = docRef.current.nodes;
    if (!nodes.length) {
      setView({ k: 0.45, x: el.clientWidth / 2, y: el.clientHeight / 2 });
      return;
    }
    const minX = Math.min.apply(null, nodes.map((n) => n.x));
    const minY = Math.min.apply(null, nodes.map((n) => n.y));
    const maxX = Math.max.apply(null, nodes.map((n) => n.x + n.w));
    const maxY = Math.max.apply(null, nodes.map((n) => n.y + n.h));
    const width = Math.max(1, maxX - minX + 320);
    const height = Math.max(1, maxY - minY + 320);
    const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (el.clientWidth - 80) / width, (el.clientHeight - 80) / height));
    setView({
      k,
      x: el.clientWidth / 2 - ((minX + maxX) / 2) * k,
      y: el.clientHeight / 2 - ((minY + maxY) / 2) * k,
    });
  };

  const focusNode = (id: string) => {
    const el = viewportRef.current;
    const node = docRef.current.nodes.find((n) => n.id === id);
    if (!el || !node) return;
    const k = viewRef.current.k;
    setView({
      k,
      x: el.clientWidth / 2 - (node.x + node.w / 2) * k,
      y: el.clientHeight / 2 - (node.y + node.h / 2) * k,
    });
  };

  const zoomByStep = (deltaPercent: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const sx = el.clientWidth / 2;
    const sy = el.clientHeight / 2;
    setView((prev) => {
      const target = clamp(Math.round(prev.k * 100 + deltaPercent) / 100, MIN_SCALE, MAX_SCALE);
      if (Math.abs(target - prev.k) < 1e-6) return prev;
      const worldX = (sx - prev.x) / prev.k;
      const worldY = (sy - prev.y) / prev.k;
      return { k: target, x: sx - worldX * target, y: sy - worldY * target };
    });
  };

  const zoomByDelta = (delta: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const sx = el.clientWidth / 2;
    const sy = el.clientHeight / 2;
    setView((prev) => {
      const target = clamp(Math.round((prev.k + delta) * 100) / 100, MIN_SCALE, MAX_SCALE);
      if (Math.abs(target - prev.k) < 1e-6) return prev;
      const worldX = (sx - prev.x) / prev.k;
      const worldY = (sy - prev.y) / prev.k;
      return { k: target, x: sx - worldX * target, y: sy - worldY * target };
    });
  };

  const resetZoom = () => {
    const el = viewportRef.current;
    if (!el) return;
    const sx = el.clientWidth / 2;
    const sy = el.clientHeight / 2;
    setView((prev) => {
      if (Math.abs(1 - prev.k) < 1e-6) return prev;
      const worldX = (sx - prev.x) / prev.k;
      const worldY = (sy - prev.y) / prev.k;
      return { k: 1, x: sx - worldX, y: sy - worldY };
    });
  };

  useImperativeHandle(ref, () => ({
    centerWorld() {
      const el = viewportRef.current;
      const current = viewRef.current;
      return {
        x: ((el ? el.clientWidth : 800) / 2 - current.x) / current.k,
        y: ((el ? el.clientHeight : 600) / 2 - current.y) / current.k,
      };
    },
    fit: fitView,
    focusNode,
    openImageEditor(nodeId) {
      const id = nodeId || selectedRef.current.find((selected) => doc.nodes.find((node) => node.id === selected && node.kind === "image" && node.url));
      const node = doc.nodes.find((item) => item.id === id && item.kind === "image" && item.url);
      if (!node) { setImageError("请先选择图片节点"); return false; }
      setImageEditor({ nodeId: node.id, mode: "view" });
      return true;
    },
    exportPng(scope) { const el = viewportRef.current; return exportCanvasPng({ doc, scope, selectedIds: selectedRef.current, view: viewRef.current, viewportWidth: el ? el.clientWidth : 1280, viewportHeight: el ? el.clientHeight : 800 }); },
    lastWorldPoint() {
      return lastMouseWorldRef.current;
    },
  }));

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let pinchAccum = 0;
    let lastPinchAt = 0;
    const zoomAtPointer = (nextScale: number, sx: number, sy: number) => {
      setView((prev) => {
        const k = clamp(Number.isFinite(nextScale) ? nextScale : prev.k, MIN_SCALE, MAX_SCALE);
        const worldX = (sx - prev.x) / prev.k;
        const worldY = (sy - prev.y) / prev.k;
        return { k, x: sx - worldX * k, y: sy - worldY * k };
      });
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const now = Date.now();
      if (now - lastPinchAt > 200) pinchAccum = 0;
      lastPinchAt = now;
      if (event.ctrlKey || event.metaKey) {
        pinchAccum += event.deltaY;
        if (Math.abs(pinchAccum) < TRACKPAD_PINCH_THRESHOLD) return;
        zoomAtPointer(viewRef.current.k * Math.exp(-pinchAccum * 0.01), sx, sy);
        pinchAccum = 0;
        return;
      }
      if (isMouseWheelEvent(event)) {
        zoomAtPointer(viewRef.current.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1), sx, sy);
        return;
      }
      setView((prev) => ({ k: prev.k, x: prev.x - event.deltaX, y: prev.y - event.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const nudgeSelection = (key: string, big: boolean, repeat: boolean): boolean => {
    const ids = selectedRef.current;
    if (!ids.length) return false;
    const step = Math.max(1, Math.round((big ? 10 : 1) / viewRef.current.k));
    const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
    const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return false;
    const base = docRef.current;
    ids.forEach((id, index) => {
      const node = base.nodes.find((n) => n.id === id);
      if (!node) return;
      dispatchRef.current(
        { type: "update-node", id, patch: { x: node.x + dx, y: node.y + dy } },
        index === 0 ? { history: !repeat, historyBase: base } : { history: false },
      );
    });
    return true;
  };

  useEffect(() => {
    const editable = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "r" && !editable(event.target)) rKeyRef.current = true;
      if (editable(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (!meta && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")) {
        if (nudgeSelection(event.key, event.shiftKey, event.repeat)) event.preventDefault();
        return;
      }
      if (meta && !event.shiftKey && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        zoomByStep(5);
        return;
      }
      if (meta && (event.key === "-" || event.key === "_")) {
        event.preventDefault();
        zoomByStep(-5);
        return;
      }
      if (meta && !event.shiftKey && event.key === "1") {
        event.preventDefault();
        fitView();
        return;
      }
      if (meta && event.key === "0") {
        event.preventDefault();
        resetZoom();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "r") rKeyRef.current = false;
    };
    const onBlur = () => {
      rKeyRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const onViewportDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target && target.closest(".rc-node")) return;
    event.preventDefault();
    props.onRequestAddMenu(event.clientX, event.clientY);
  };

  const onViewportContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    // novai 29450：Ctrl/Meta 按住（或 R 框选）时右键不弹菜单，避免 ctrl+click 触发菜单
    if (event.ctrlKey || event.metaKey || rKeyRef.current) {
      event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && target.closest(".rc-node")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    props.onCanvasContextMenu(event.clientX, event.clientY);
  };

  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState("");
  useEffect(() => {
    setGridSnap(props.settings.gridSnap);
    setShowEdges(!props.settings.hideEdges);
  }, [props.settings.gridSnap, props.settings.hideEdges]);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [timelineAddOpen, setTimelineAddOpen] = useState(false);
  const [timelinePreview, setTimelinePreview] = useState<{ nodeId: string; index: number } | null>(null);
  const [timelineError, setTimelineError] = useState("");
  const [sceneSelectedId, setSceneSelectedId] = useState("");
  const [sceneThumbs, setSceneThumbs] = useState<Record<string, string>>({});
  const [timelineExportNodeId, setTimelineExportNodeId] = useState("");
  const [timelineExporting, setTimelineExporting] = useState(false);
  const [timelineExportProgress, setTimelineExportProgress] = useState({ current: 0, total: 0 });
  const [timelineExportError, setTimelineExportError] = useState("");
  const [timelineExportFormat, setTimelineExportFormat] = useState<"webm" | "mp4">("webm");
  const [timelineExportSuccess, setTimelineExportSuccess] = useState("");
  const timelineExportCancelRef = useRef(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [modelMenuKind, setModelMenuKind] = useState<"image" | "video" | "audio" | null>(null);
  const [newNodeIds, setNewNodeIds] = useState<Set<string>>(new Set());
  const [resultEnterIds, setResultEnterIds] = useState<Set<string>>(new Set());
  const [drawingEdgeIds, setDrawingEdgeIds] = useState<Set<string>>(new Set());
  const knownEdgeIdsRef = useRef<Set<string> | null>(null);
  const knownNodeIdsRef = useRef<Set<string> | null>(null);
  const prevGenerationRef = useRef<Record<string, { status?: string }>>({});
  useEffect(() => {
    const current = new Set(doc.nodes.map((node) => node.id));
    const previous = knownNodeIdsRef.current;
    knownNodeIdsRef.current = current;
    if (!previous) return;
    const added = [...current].filter((id) => !previous.has(id));
    if (!added.length) return;
    setNewNodeIds((prev) => new Set([...prev, ...added]));
    const timer = window.setTimeout(() => setNewNodeIds((prev) => { const next = new Set(prev); added.forEach((id) => next.delete(id)); return next; }), 1400);
    return () => window.clearTimeout(timer);
  }, [doc.nodes]);
  useEffect(() => {
    const previous = prevGenerationRef.current;
    const entering: string[] = [];
    for (const [id, info] of Object.entries(props.generation || {})) {
      if (previous[id]?.status === "pending" && info.status !== "pending") entering.push(id);
    }
    prevGenerationRef.current = props.generation || {};
    if (!entering.length) return;
    setResultEnterIds((prev) => new Set([...prev, ...entering]));
    const timer = window.setTimeout(() => setResultEnterIds((prev) => { const next = new Set(prev); entering.forEach((id) => next.delete(id)); return next; }), 220);
    return () => window.clearTimeout(timer);
  }, [props.generation]);
  useEffect(() => {
    const ids = new Set(doc.edges.map((edge) => edge.id));
    const previous = knownEdgeIdsRef.current;
    knownEdgeIdsRef.current = ids;
    if (!previous) return;
    const added = [...ids].filter((id) => !previous.has(id));
    if (!added.length) return;
    setDrawingEdgeIds((prev) => new Set([...prev, ...added]));
    window.setTimeout(() => setDrawingEdgeIds((prev) => { const next = new Set(prev); added.forEach((id) => next.delete(id)); return next; }), 240);
  }, [doc.edges]);
  const [pendingSeconds, setPendingSeconds] = useState(0);
  const pendingCount = Object.values(props.generation || {}).filter((item) => item && item.status === "pending").length;
  useEffect(() => {
    if (!pendingCount) { setPendingSeconds(0); return; }
    const started = Date.now(); setPendingSeconds(0);
    const timer = window.setInterval(() => setPendingSeconds(Math.round((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [pendingCount]);
  useEffect(() => {
    if (!modelMenuKind) return;
    const close = (event: PointerEvent) => { const target = event.target as Element | null; if (target?.closest(".rc-gen-model-menu, [data-testid=\"node-gen-model\"]")) return; setModelMenuKind(null); };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [modelMenuKind]);
  const [imageError, setImageError] = useState("");
  const [imageEditor, setImageEditor] = useState<{ nodeId: string; mode: "view" | "crop" | "annotate" } | null>(null);
  const [gridOpen, setGridOpen] = useState(false);
  const [helpModal, setHelpModal] = useState<"help" | "feedback" | "changelog" | "about" | null>(null);
  const [maskNodeId, setMaskNodeId] = useState("");
  const [model3dBusy, setModel3dBusy] = useState(false);
  const [model3dError, setModel3dError] = useState("");
  const [model3dModes, setModel3dModes] = useState<Record<string, "text" | "image">>({});
  const [model3dRunId, setModel3dRunId] = useState<string | null>(null);
  const [model3dRefs, setModel3dRefs] = useState<Record<string, string>>({});
  const [legacyNotice, setLegacyNotice] = useState("");
  const [previewTime, setPreviewTime] = useState(0);
  const [previewFade, setPreviewFade] = useState(1);
  const touchPointsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number; k: number; x: number; y: number } | null>(null);
  const [colorValues, setColorValues] = useState({ brightness: 1, contrast: 1, saturate: 1 });
  const nodeUploadRef = useRef<HTMLInputElement | null>(null);
  const refUploadRef = useRef<HTMLInputElement | null>(null);
  const uploadReplaceRef = useRef<string>("");
  const selectedImageId = props.selectedNodeIds.length === 1 ? props.selectedNodeIds[0] : "";
  useEffect(() => { setGenPrompt(""); }, [selectedImageId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setPreviewUrl(""); setColorOpen(false); setTimelinePreview(null); setTimelineError(""); timelineExportCancelRef.current = true; setTimelineExportNodeId(""); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sceneDataOf = (node: CanvasNode): Scene3DData => node.scene || { objects: [], camera: { position: [6, 5, 8], target: [0, 0, 0] }, background: "#111111" };
  const dispatchScene = (node: CanvasNode, scene: Scene3DData) => props.dispatch({ type: "update-node", id: node.id, patch: { scene } }, { history: true });
  const updateSceneObject = (node: CanvasNode, id: string, patch: Partial<Scene3DData["objects"][number]>) => {
    const data = sceneDataOf(node);
    dispatchScene(node, { ...data, objects: data.objects.map((item) => item.id === id ? { ...item, ...patch } : item) });
  };

  const updateTimelineClips = (node: CanvasNode, clips: NonNullable<CanvasNode["clips"]>) => {
    props.dispatch({ type: "update-node", id: node.id, patch: { clips: clips.map((clip, index) => ({ ...clip, order: index })) } }, { history: true });
  };
  const timelinePreviewNode = timelinePreview ? doc.nodes.find((node) => node.id === timelinePreview.nodeId) : undefined;
  const timelinePreviewClip = timelinePreviewNode && timelinePreview ? (timelinePreviewNode.clips || [])[timelinePreview.index] : undefined;
  const closeTimelinePreview = () => { setTimelinePreview(null); setTimelineError(""); };
  const advanceTimeline = () => {
    setTimelinePreview((prev) => {
      if (!prev) return null;
      const node = doc.nodes.find((item) => item.id === prev.nodeId);
      const next = prev.index + 1;
      return node && next < (node.clips || []).length ? { nodeId: prev.nodeId, index: next } : null;
    });
    setTimelineError("");
  };

  const timelineExportSupported = typeof MediaRecorder === "function" && typeof HTMLCanvasElement.prototype.captureStream === "function";
  const startTimelineExport = async () => {
    const node = doc.nodes.find((item) => item.id === timelineExportNodeId);
    if (!node) return;
    setTimelineExporting(true);
    setTimelineExportError("");
    setTimelineExportSuccess("");
    timelineExportCancelRef.current = false;
    try {
      if (timelineExportFormat === "mp4") {
        const result = await exportTimelineMp4({
          clips: (node.clips || []).map((clip) => ({ url: clip.url, mediaKind: clip.mediaKind, inPoint: clip.inPoint, outPoint: clip.outPoint })),
          canvasId: props.canvasId || "default",
          onProgress: (value) => setTimelineExportProgress({ current: value, total: 100 }),
        });
        setTimelineExportSuccess("已导出：" + result.relativePath);
        return;
      }
      const blob = await exportTimelineWebM({
        clips: (node.clips || []).map((clip) => ({ url: clip.url, mediaKind: clip.mediaKind, inPoint: clip.inPoint, outPoint: clip.outPoint, ...(clip.type === "subtitle" ? { type: "subtitle" as const, text: clip.text, start: clip.start, end: clip.end } : {}), fadeIn: clip.fadeIn, fadeOut: clip.fadeOut })),
        fileName: "timeline-" + node.id,
        onProgress: (current, total) => setTimelineExportProgress({ current, total }),
        isCancelled: () => timelineExportCancelRef.current,
      });
      downloadTimelineBlob(blob, "timeline-" + node.id + ".webm");
      setTimelineExportNodeId("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") setTimelineExportNodeId("");
      else setTimelineExportError(error instanceof Error ? error.message : "导出失败");
    } finally {
      setTimelineExporting(false);
    }
  };

  const splitImageGrid = async (node: CanvasNode, count: number) => {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        if (node.url && !node.url.startsWith("data:")) image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("LOAD_FAILED"));
        image.src = node.originalUrl || node.url || "";
      });
      const tileW = Math.floor(img.naturalWidth / count);
      const tileH = Math.floor(img.naturalHeight / count);
      if (!tileW || !tileH) throw new Error("TOO_SMALL");
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          const tile = document.createElement("canvas");
          tile.width = tileW; tile.height = tileH;
          const ctx = tile.getContext("2d");
          if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
          ctx.drawImage(img, col * tileW, row * tileH, tileW, tileH, 0, 0, tileW, tileH);
          const url = tile.toDataURL("image/png");
          props.dispatch({ type: "add-node", node: { ...makeNode("image", node.x + col * (tileW + 16), node.y + row * (tileH + 16), "宫格 " + count + "x" + count), url, originalUrl: url } }, { history: true });
        }
      }
      setGridOpen(false);
    } catch { setImageError("宫格切分失败：图片读取失败或跨域"); }
  };

  const applyImageEdit = async (mode: "rotate" | "flip-h" | "flip-v" | "color" | "upscale") => {
    const target = overlayNode;
    if (!target || !target.url) return;
    const source = target.originalUrl || target.url;
    setImageError("");
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        if (!source.startsWith("data:")) img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("LOAD_FAILED"));
        img.src = source;
      });
      const rotate = mode === "rotate";
      const upscale = mode === "upscale";
      const width = rotate ? image.height : upscale ? image.width * 2 : image.width;
      const height = rotate ? image.width : upscale ? image.height * 2 : image.height;
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
      if (rotate) { ctx.translate(width / 2, height / 2); ctx.rotate(Math.PI / 2); ctx.drawImage(image, -image.width / 2, -image.height / 2); }
      else if (mode === "flip-h") { ctx.translate(width, 0); ctx.scale(-1, 1); ctx.drawImage(image, 0, 0); }
      else if (mode === "flip-v") { ctx.translate(0, height); ctx.scale(1, -1); ctx.drawImage(image, 0, 0); }
      else if (upscale) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(image, 0, 0, width, height); }
      else { ctx.filter = "brightness(" + colorValues.brightness + ") contrast(" + colorValues.contrast + ") saturate(" + colorValues.saturate + ")"; ctx.drawImage(image, 0, 0); }
      const url = canvas.toDataURL("image/png");
      const patch: Record<string, unknown> = { url };
      if (!target.originalUrl) patch.originalUrl = source;
      if (rotate) { patch.w = target.h; patch.h = target.w; }
      if (upscale) { patch.w = target.w * 2; patch.h = target.h * 2; }
      props.dispatch({ type: "update-node", id: target.id, patch }, { history: true });
      setColorOpen(false);
    } catch {
      setImageError("图片处理失败（跨域或读取失败），原图未修改");
    }
  };

  const addImageFiles = async (files: File[], point?: { x: number; y: number }, replaceId?: string) => {
    if (!files.length) return;
    setUploadError("");
    const loaded: Array<{ name: string; url: string }> = [];
    for (const file of files) {
      try {
        loaded.push({ name: file.name, url: await readImageFile(file) });
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "读取失败");
      }
    }
    if (!loaded.length) return;
    const base = point || lastMouseWorldRef.current || { x: 0, y: 0 };
    let start = 0;
    if (replaceId && loaded[0]) {
      props.dispatch({ type: "update-node", id: replaceId, patch: { url: loaded[0].url } }, { history: true });
      start = 1;
    }
    for (let index = start; index < loaded.length; index += 1) {
      const item = loaded[index];
      const node = { ...makeNode("image", base.x + index * 28, base.y + index * 28, item.name), url: item.url };
      props.dispatch({ type: "add-node", node }, { history: true });
    }
  };

  const handleNodeUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const target = uploadReplaceRef.current;
    uploadReplaceRef.current = "";
    event.target.value = "";
    await addImageFiles(files, undefined, target || undefined);
  };

  const handleCanvasDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files || []);
    if (!files.length) return;
    await addImageFiles(files, clientToWorld(event.clientX, event.clientY));
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) return;
      event.preventDefault();
      void addImageFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointsRef.current.size === 2) {
        event.preventDefault();
        panRef.current = null; setPanning(false); marqueeRef.current = null; setMarquee(null);
        const pts = [...touchPointsRef.current.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        pinchRef.current = { dist, midX: (pts[0].x + pts[1].x) / 2, midY: (pts[0].y + pts[1].y) / 2, k: viewRef.current.k, x: viewRef.current.x, y: viewRef.current.y };
        try { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ } } catch { /* synthetic touch */ }
        return;
      }
    }
    props.onDismissMenus();
    if (props.commentMode && event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !rKeyRef.current) {
      event.preventDefault();
      const point = clientToWorld(event.clientX, event.clientY);
      setOpenCommentId(null);
      props.onPlaceComment(point.x, point.y);
      return;
    }
    if (event.button === 0 && (event.shiftKey || event.ctrlKey || event.metaKey || rKeyRef.current)) {
      event.preventDefault();
      const point = clientToWorld(event.clientX, event.clientY);
      marqueeRef.current = { startX: point.x, startY: point.y };
      setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
      return;
    }
    if (event.button === 0 || event.button === 1) {
      if (event.button === 0) {
        props.onSelectNodes([]);
        props.onSelectEdge(null);
      }
      panRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        viewX: viewRef.current.x,
        viewY: viewRef.current.y,
      };
      setPanning(true);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    }
  };

  const onViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointsRef.current.size >= 2 && pinchRef.current) {
        const pts = [...touchPointsRef.current.values()]; const base = pinchRef.current;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
        const k = Math.max(0.25, Math.min(3, base.k * (dist / base.dist)));
        setView({ k, x: base.x + (midX - base.midX), y: base.y + (midY - base.midY) });
        return;
      }
    }
    const now = Date.now();
    const point = clientToWorld(event.clientX, event.clientY);
    lastMouseWorldRef.current = point;
    if (!panRef.current && !marqueeRef.current && now - lastCursor.current > 60) {
      lastCursor.current = now;
      props.onCursor(point);
    }
    if (panRef.current) {
      const pan = panRef.current;
      setView((prev) => ({
        k: prev.k,
        x: pan.viewX + event.clientX - pan.startX,
        y: pan.viewY + event.clientY - pan.startY,
      }));
      return;
    }
    if (marqueeRef.current) {
      const point = clientToWorld(event.clientX, event.clientY);
      setMarquee({ x0: marqueeRef.current.startX, y0: marqueeRef.current.startY, x1: point.x, y1: point.y });
    }
  };

  const onViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") { touchPointsRef.current.delete(event.pointerId); if (touchPointsRef.current.size < 2) pinchRef.current = null; }
    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
    }
    if (marqueeRef.current) {
      const start = marqueeRef.current;
      const point = clientToWorld(event.clientX, event.clientY);
      marqueeRef.current = null;
      setMarquee(null);
      const x0 = Math.min(start.startX, point.x);
      const x1 = Math.max(start.startX, point.x);
      const y0 = Math.min(start.startY, point.y);
      const y1 = Math.max(start.startY, point.y);
      if (x1 - x0 > 4 || y1 - y0 > 4) {
        const ids = docRef.current.nodes
          .filter((node) => node.x < x1 && node.x + node.w > x0 && node.y < y1 && node.y + node.h > y0)
          .map((node) => node.id);
        props.onSelectNodes(ids);
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => {
    if (event.button !== 0 || editingId === node.id) return;
    event.stopPropagation();
    props.onSelectNodes([node.id]);
    props.onSelectEdge(null);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    const childIds = node.kind === "group" ? node.children || [] : [];
    dragRef.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
      base: doc,
      moved: false,
      children: doc.nodes.filter((item) => childIds.indexOf(item.id) >= 0).map((item) => ({ id: item.id, x: item.x, y: item.y })),
    };
  };

  const onNodePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const k = viewRef.current.k;
    const x = snapCoord(Math.round(drag.nodeX + (event.clientX - drag.startX) / k));
    const y = snapCoord(Math.round(drag.nodeY + (event.clientY - drag.startY) / k));
    if (!drag.moved && x === drag.nodeX && y === drag.nodeY) return;
    drag.moved = true;
    props.dispatch({ type: "update-node", id: drag.id, patch: { x, y } }, { history: false });
    drag.children.forEach((child) => {
      props.dispatch(
        { type: "update-node", id: child.id, patch: { x: child.x + (x - drag.nodeX), y: child.y + (y - drag.nodeY) } },
        { history: false },
      );
    });
  };

  const recomputeParentGroups = (nodeId: string, x: number, y: number) => {
    const nodes = docRef.current.nodes.map((node) => (node.id === nodeId ? { ...node, x, y } : node));
    const parents = nodes.filter((node) => node.kind === "group" && node.children && node.children.indexOf(nodeId) >= 0);
    parents.forEach((group) => {
      const members = nodes.filter((node) => group.children!.indexOf(node.id) >= 0);
      if (!members.length) return;
      const minX = Math.min.apply(null, members.map((node) => node.x));
      const minY = Math.min.apply(null, members.map((node) => node.y));
      const maxX = Math.max.apply(null, members.map((node) => node.x + node.w));
      const maxY = Math.max.apply(null, members.map((node) => node.y + node.h));
      dispatchRef.current(
        {
          type: "update-node",
          id: group.id,
          patch: { x: Math.round(minX - 24), y: Math.round(minY - 24), w: Math.round(maxX - minX + 48), h: Math.round(maxY - minY + 48) },
        },
        { history: false },
      );
    });
  };

  const onNodePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && drag.moved) {
      const k = viewRef.current.k;
      const patch = {
        x: snapCoord(Math.round(drag.nodeX + (event.clientX - drag.startX) / k)),
        y: snapCoord(Math.round(drag.nodeY + (event.clientY - drag.startY) / k)),
      };
      props.dispatch({ type: "update-node", id: drag.id, patch }, { history: true, historyBase: drag.base });
      drag.children.forEach((child) => {
        props.dispatch(
          { type: "update-node", id: child.id, patch: { x: child.x + (patch.x - drag.nodeX), y: child.y + (patch.y - drag.nodeY) } },
          { history: false },
        );
      });
      const dragged = docRef.current.nodes.find((node) => node.id === drag.id);
      if (dragged && dragged.kind !== "group") recomputeParentGroups(drag.id, patch.x, patch.y);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const queueTextUpdate = (id: string, text: string) => {
    if (textTimer.current) window.clearTimeout(textTimer.current);
    textTimer.current = window.setTimeout(() => {
      textTimer.current = null;
      props.dispatch({ type: "update-node", id, patch: { text } }, { history: false });
    }, 120);
  };

  const commitText = (id: string, text: string) => {
    if (textTimer.current) {
      window.clearTimeout(textTimer.current);
      textTimer.current = null;
    }
    const base = textBaseRef.current;
    if (!base) return;
    textBaseRef.current = null;
    setEditingId(null);
    const before = base.nodes.find((n) => n.id === id);
    if ((before ? before.text : "") === text) return;
    props.dispatch({ type: "update-node", id, patch: { text } }, { history: true, historyBase: base });
  };

  const startConnect = (event: ReactPointerEvent<HTMLSpanElement>, node: CanvasNode, side: "left" | "right") => {
    event.stopPropagation();
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    connectRef.current = { from: node.id, side };
    const point = clientToWorld(event.clientX, event.clientY);
    setConnect({ from: node.id, side, x: point.x, y: point.y });
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const active = connectRef.current;
    if (!active) return;
    const point = clientToWorld(event.clientX, event.clientY);
    setConnect({ from: active.from, side: active.side, x: point.x, y: point.y });
    const target = findNodeAt(point.x, point.y);
    setConnectTarget(target && target.id !== active.from ? target.id : null);
  };

  const endConnect = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const active = connectRef.current;
    connectRef.current = null;
    setConnect(null);
    setConnectTarget(null);
    if (active) {
      const point = clientToWorld(event.clientX, event.clientY);
      const target = findNodeAt(point.x, point.y);
      if (target && target.id !== active.from) {
        const edgeId = makeId("e");
        setDrawingEdgeIds((prev) => new Set([...prev, edgeId]));
        window.setTimeout(() => setDrawingEdgeIds((prev) => { const next = new Set(prev); next.delete(edgeId); return next; }), 240);
        props.dispatch(
          { type: "add-edge", edge: { id: edgeId, from: active.from, to: target.id, fromSide: active.side } },
          { history: true },
        );
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const currentConnectNode = connect ? doc.nodes.find((n) => n.id === connect.from) : undefined;
  const connectPath = connect && currentConnectNode ? edgePathToPoint(currentConnectNode, connect.side, connect.x, connect.y) : "";

  const mountedNodeIds = (() => {
    if (doc.nodes.length <= 120) return null;
    const current = viewRef.current;
    const width = elWidthRef.current || 1200;
    const height = elHeightRef.current || 800;
    const x0 = (-current.x - 400) / current.k;
    const y0 = (-current.y - 400) / current.k;
    const x1 = (width - current.x + 400) / current.k;
    const y1 = (height - current.y + 400) / current.k;
    const centerX = (x0 + x1) / 2, centerY = (y0 + y1) / 2;
    const candidates = doc.nodes.filter((node) => node.x + node.w >= x0 && node.x <= x1 && node.y + node.h >= y0 && node.y <= y1);
    candidates.sort((a, b) => Math.hypot(a.x + a.w / 2 - centerX, a.y + a.h / 2 - centerY) - Math.hypot(b.x + b.w / 2 - centerX, b.y + b.h / 2 - centerY));
    return new Set(candidates.slice(0, 110).map((node) => node.id));
  })();
  const isNodeMounted = (node: CanvasNode) => mountedNodeIds === null || mountedNodeIds.has(node.id);

  const renderNode = (node: CanvasNode) => {
    const selected = selectedNodeIds.indexOf(node.id) >= 0;
    const editing = editingId === node.id;
    const target = connectTarget === node.id;
    const className =
      "rc-node rc-node-" + node.kind +
      (selected ? " is-selected" : "") +
      (target ? " is-connect-target" : "") +
      (newNodeIds.has(node.id) ? " is-new" : "") +
      (resultEnterIds.has(node.id) ? " is-result-enter" : "") +
      (props.deletingNodeIds && props.deletingNodeIds.has(node.id) ? " is-deleting" : "") +
      (editing ? " is-editing" : "");
    if (!isNodeMounted(node)) {
      return (
        <div key={node.id} className={className + " is-lod"} style={{ left: node.x, top: node.y, width: node.w, height: node.h }} data-testid="canvas-node" data-node-id={node.id} data-kind={node.kind} data-x={node.x} data-y={node.y} data-lod="1" onPointerDown={(event) => onNodePointerDown(event, node)} onPointerMove={onNodePointerMove} onPointerUp={onNodePointerUp} onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); if (event.ctrlKey || event.metaKey || rKeyRef.current) return; event.stopPropagation(); if (selectedRef.current.indexOf(node.id) < 0) props.onSelectNodes([node.id]); props.onNodeContextMenu(node.id, event.clientX, event.clientY, selectedRef.current.length > 1); }}>
          <span className="rc-node-lod" />
        </div>
      );
    }
    return (
      <div
        key={node.id}
        className={className}
        style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
        data-testid="canvas-node"
        data-node-id={node.id}
        data-model-url={node.kind === "model3d" ? node.url || "" : undefined}
        data-kind={node.kind}
        data-x={node.x}
        data-y={node.y}
        data-children={node.kind === "group" && node.children ? node.children.length : undefined}
        onPointerDown={(event) => onNodePointerDown(event, node)}
        onPointerMove={onNodePointerMove}
        onPointerUp={onNodePointerUp}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (node.kind === "table" || node.kind === "smart-batch" || node.kind === "smart-loop") { setLegacyNotice("旧版节点只读，不能编辑"); return; }
          if (node.kind === "image") {
            if (node.url) setPreviewUrl(node.url);
            return;
          }
          if (node.kind === "video" || node.kind === "audio") {
            event.preventDefault();
            const media = (event.currentTarget as HTMLElement).querySelector("video,audio") as HTMLMediaElement | null;
            if (media) { if (media.paused) void media.play().catch(() => undefined); else media.pause(); }
            return;
          }
          if (node.kind === "group" || node.kind === "timeline" || node.kind === "scene3d" || node.kind === "model3d") return;
          setEditingId(node.id);
          setDraftText(node.text);
          textBaseRef.current = doc;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey || rKeyRef.current) return;
          event.stopPropagation();
          if (selectedRef.current.indexOf(node.id) < 0) props.onSelectNodes([node.id]);
          props.onNodeContextMenu(node.id, event.clientX, event.clientY, selectedRef.current.length > 1);
        }}
      >
        <span className="rc-node-label">
          {kindGlyph(node.kind)}
          {NODE_KIND_LABEL[node.kind]}
        </span>
        {props.generation[node.id]?.status === "pending" ? <div className="rc-node-shimmer" data-testid="node-shimmer" aria-label="生成中"><span className="rc-shimmer-dots" /></div> : null}
        {node.kind === "image" && node.variants && node.variants.length ? (
          <button
            className="rc-node-variants-badge"
            data-testid="node-variants-badge"
            title="切换主图"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); const variants = [...(node.variants || [])]; const nextMain = variants.shift() || node.url || ""; props.dispatch({ type: "update-node", id: node.id, patch: { url: nextMain, variants: [node.url || "", ...variants] } }, { history: true }); }}
          >
            {node.variants.length + 1}
          </button>
        ) : null}
        {node.kind === "group" ? (
          <div className="rc-group-body">
            <span className="rc-group-count">{node.children ? node.children.length : 0} 个节点</span>
            <span className="rc-group-hint">拖动分组移动整组 · ⇧⌘G 取消分组</span>
          </div>
        ) : node.kind === "audio" ? (
          node.url ? (
            <AudioWaveform url={node.url} />
          ) : (
            <div className="rc-node-image"><Mic size={40} /></div>
          )
        ) : node.kind === "scene3d" ? (
          <div className="rc-scene3d" data-testid="scene3d-panel" onPointerDown={(event) => event.stopPropagation()}>
            <Scene3D node={node} onChange={(scene) => dispatchScene(node, scene)} onThumbnail={(dataUrl) => setSceneThumbs((prev) => ({ ...prev, [node.id]: dataUrl }))} />
            {sceneThumbs[node.id] ? <img className="rc-scene3d-thumb" src={sceneThumbs[node.id]} alt="3D 渲染快照" /> : null}
            <div className="rc-scene3d-tools" onPointerDown={(event) => event.stopPropagation()}>
              <span>添加</span>
              {(["cube", "sphere", "cylinder", "plane"] as const).map((type) => (
                <button key={type} data-testid={"scene3d-add-" + type} onClick={() => {
                  const data = sceneDataOf(node);
                  const id = makeId("obj");
                  dispatchScene(node, { ...data, objects: [...data.objects, { id, type, position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#e8e8e8" }] });
                  setSceneSelectedId(id);
                }}>{type === "cube" ? "立方体" : type === "sphere" ? "球体" : type === "cylinder" ? "圆柱" : "平面"}</button>
              ))}
              <button data-testid="scene3d-clear" onClick={() => { dispatchScene(node, { ...sceneDataOf(node), objects: [] }); setSceneSelectedId(""); }}>清屏</button>
            </div>
            <div className="rc-scene3d-objects" data-testid="scene3d-objects">
              {sceneDataOf(node).objects.map((obj) => (
                <button key={obj.id} className={"rc-scene3d-object" + (sceneSelectedId === obj.id ? " is-active" : "")} data-testid="scene3d-object" onClick={() => setSceneSelectedId(obj.id)}>{obj.type}</button>
              ))}
              {sceneDataOf(node).objects.length === 0 ? <span className="rc-scene3d-empty">暂无物体</span> : null}
            </div>
            {(() => {
              const selected = sceneDataOf(node).objects.find((obj) => obj.id === sceneSelectedId);
              if (!selected) return null;
              return (
                <div className="rc-scene3d-inspector" data-testid="scene3d-inspector">
                  {(["position", "rotation", "scale"] as const).map((key) => (
                    <div className="rc-scene3d-vector" key={key}>
                      <span>{key === "position" ? "位置" : key === "rotation" ? "旋转" : "缩放"}</span>
                      {[0, 1, 2].map((axis) => (
                        <input key={axis} type="number" step="0.1" data-testid={"scene3d-" + key.slice(0, 3) + "-" + ["x", "y", "z"][axis]} value={selected[key][axis]} onChange={(event) => { const next = [...selected[key]] as [number, number, number]; next[axis] = Number(event.target.value) || 0; updateSceneObject(node, selected.id, { [key]: next }); }} />
                      ))}
                    </div>
                  ))}
                  <label className="rc-scene3d-color">颜色<input type="color" data-testid="scene3d-color" value={selected.color} onChange={(event) => updateSceneObject(node, selected.id, { color: event.target.value })} /></label>
                  <button data-testid="scene3d-delete" onClick={() => { dispatchScene(node, { ...sceneDataOf(node), objects: sceneDataOf(node).objects.filter((obj) => obj.id !== selected.id) }); setSceneSelectedId(""); }}>删除</button>
                </div>
              );
            })()}
          </div>
        ) : node.kind === "timeline" ? (
          <div className="rc-timeline" data-testid="timeline-panel" onPointerDown={(event) => event.stopPropagation()}>
            <div className="rc-timeline-head"><span>剪辑时间线 <small>Beta</small></span><button className="rc-timeline-export" data-testid="timeline-export" disabled={!timelineExportSupported || (node.clips || []).length === 0} title={!timelineExportSupported ? "当前浏览器不支持 captureStream/MediaRecorder" : (node.clips || []).length === 0 ? "时间线暂无片段" : "导出 WebM"} onClick={() => { setTimelineExportNodeId(node.id); setTimelineExportError(""); setTimelineExportSuccess(""); setTimelineExportFormat("webm"); setTimelineExportProgress({ current: 0, total: Math.max(1, (node.clips || []).reduce((sum, clip) => clip.type === "subtitle" ? sum : sum + Math.max(0.1, clip.outPoint - clip.inPoint), 0)) }); }}>合成导出</button></div>
            <div className="rc-timeline-actions">
              <button data-testid="timeline-add" onClick={() => setTimelineAddOpen((open) => !open)}>添加片段</button>
              <button data-testid="timeline-add-subtitle" onClick={() => { const clips = [...(node.clips || []), { id: makeId("sub"), sourceNodeId: "", url: "", mediaKind: "video" as const, inPoint: 0, outPoint: 2, order: (node.clips || []).length, type: "subtitle" as const, text: "新字幕", start: 0, end: 2, fadeIn: 0, fadeOut: 0 }]; updateTimelineClips(node, clips); }}>添加字幕</button>
              <span className="rc-timeline-total" data-testid="timeline-total">总时长 {Math.max((node.clips || []).reduce((sum, clip) => clip.type === "subtitle" ? sum : sum + Math.max(0, clip.outPoint - clip.inPoint), 0), ...(node.clips || []).filter((clip) => clip.type === "subtitle").map((clip) => Number(clip.end) || 0)).toFixed(1)}s</span>
            </div>
            {timelineAddOpen ? (
              <div className="rc-timeline-sources" data-testid="timeline-sources">
                {doc.nodes.filter((item) => (item.kind === "video" || item.kind === "audio") && item.url).map((source) => (
                  <button key={source.id} data-testid={"timeline-source-" + source.id} onClick={() => {
                    const clips = [...(node.clips || []), { id: makeId("clip"), sourceNodeId: source.id, url: source.url || "", mediaKind: source.kind === "audio" ? "audio" as const : "video" as const, inPoint: 0, outPoint: 5, order: (node.clips || []).length }];
                    updateTimelineClips(node, clips);
                    setTimelineAddOpen(false);
                  }}>{NODE_KIND_LABEL[source.kind]} · {source.text || source.id.slice(-4)}</button>
                ))}
                {doc.nodes.filter((item) => (item.kind === "video" || item.kind === "audio") && item.url).length === 0 ? <span className="rc-timeline-empty">画布上没有带 url 的视频/音频节点</span> : null}
              </div>
            ) : null}
            {(node.clips || []).length === 0 ? (
              <div className="rc-timeline-empty" data-testid="timeline-empty">暂无片段，点击「添加片段」从画布媒体加入</div>
            ) : (<>{((node.clips || []).filter((clip) => clip.type !== "subtitle")).map((clip, index) => (
              <div className="rc-timeline-clip" data-testid="timeline-clip" key={clip.id}>
                <span>{index + 1}</span><span>{clip.mediaKind === "audio" ? "音频" : "视频"}</span>
                {clip.mediaKind === "audio" ? <TimelineWaveform url={clip.url} inPoint={clip.inPoint} outPoint={clip.outPoint} /> : null}
                <label>入 <input type="number" step="0.1" min="0" value={clip.inPoint} data-testid="timeline-in" onChange={(event) => { const value = Math.max(0, Math.min(Number(event.target.value) || 0, clip.outPoint - 0.1)); updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, inPoint: value } : item)); }} /></label>
                <label>出 <input type="number" step="0.1" min="0" value={clip.outPoint} data-testid="timeline-out" onChange={(event) => { const value = Math.max(clip.inPoint + 0.1, Math.min(Number(event.target.value) || 0, 3600)); updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, outPoint: value } : item)); }} /></label>
                {clip.mediaKind === "video" ? <><label>淡入<input type="number" min="0" max="1000" step="50" data-testid="timeline-fade-in" value={clip.fadeIn || 0} onChange={(event) => updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, fadeIn: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) } : item))} /></label><label>淡出<input type="number" min="0" max="1000" step="50" data-testid="timeline-fade-out" value={clip.fadeOut || 0} onChange={(event) => updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, fadeOut: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) } : item))} /></label></> : null}
                <span className="rc-timeline-duration">{(clip.outPoint - clip.inPoint).toFixed(1)}s</span>
                <button data-testid="timeline-up" disabled={index === 0} onClick={() => { const clips = [...(node.clips || [])]; [clips[index - 1], clips[index]] = [clips[index], clips[index - 1]]; updateTimelineClips(node, clips); }}>↑</button>
                <button data-testid="timeline-down" disabled={index === (node.clips || []).length - 1} onClick={() => { const clips = [...(node.clips || [])]; [clips[index + 1], clips[index]] = [clips[index], clips[index + 1]]; updateTimelineClips(node, clips); }}>↓</button>
                <button data-testid="timeline-remove" onClick={() => updateTimelineClips(node, (node.clips || []).filter((item) => item.id !== clip.id))}>×</button>
              </div>
            ))}{((node.clips || []).filter((clip) => clip.type === "subtitle")).map((clip) => (
              <div className="rc-timeline-clip is-subtitle" data-testid="timeline-subtitle" key={clip.id}>
                <span>字幕</span>
                <input className="rc-timeline-subtitle-text" data-testid="timeline-subtitle-text" value={clip.text || ""} onChange={(event) => updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, text: event.target.value } : item))} />
                <label>起 <input type="number" step="0.1" min="0" data-testid="timeline-subtitle-start" value={clip.start || 0} onChange={(event) => updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, start: Number(event.target.value) || 0 } : item))} /></label>
                <label>止 <input type="number" step="0.1" min="0" data-testid="timeline-subtitle-end" value={clip.end || 0} onChange={(event) => updateTimelineClips(node, (node.clips || []).map((item) => item.id === clip.id ? { ...item, end: Number(event.target.value) || 0 } : item))} /></label>
                <button data-testid="timeline-subtitle-remove" onClick={() => updateTimelineClips(node, (node.clips || []).filter((item) => item.id !== clip.id))}>×</button>
              </div>
            ))}</>)}
            <div className="rc-timeline-foot"><button data-testid="timeline-preview" disabled={(node.clips || []).length === 0} onClick={() => { setTimelineError(""); setTimelinePreview({ nodeId: node.id, index: Math.max(0, (node.clips || []).findIndex((clip) => clip.type !== "subtitle")) }); setPreviewTime(0); setPreviewFade(1); }}>预览</button></div>
          </div>
        ) : node.kind === "model3d" ? (
          <div className="rc-node-model3d" data-testid="node-model3d" data-model-url={node.url || ""}>
            <div className="rc-model3d-title">3D 模型</div>
            <div className="rc-model3d-modes">
              <button className={(model3dModes[node.id] || "text") === "text" ? "is-active" : ""} data-testid="node-3d-mode-text" onClick={() => setModel3dModes((prev) => ({ ...prev, [node.id]: "text" }))}>文生 3D</button>
              <button className={model3dModes[node.id] === "image" ? "is-active" : ""} data-testid="node-3d-mode-image" onClick={() => setModel3dModes((prev) => ({ ...prev, [node.id]: "image" }))}>图生 3D</button>
            </div>
            <textarea className="rc-model3d-prompt" data-testid="node-3d-prompt" value={node.text} placeholder="描述要生成的 3D 对象" onChange={(event) => props.dispatch({ type: "update-node", id: node.id, patch: { text: event.target.value } }, { history: false })} />
            {model3dModes[node.id] === "image" ? <label className="rc-model3d-ref">上传参考图<input type="file" accept="image/*" hidden data-testid="node-3d-ref-input" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setModel3dRefs((prev) => ({ ...prev, [node.id]: String(reader.result || "") })); reader.readAsDataURL(file); event.target.value = ""; }} />{model3dRefs[node.id] ? <img src={model3dRefs[node.id]} alt="参考图" /> : null}</label> : null}
            <button className="rc-model3d-generate" data-testid="node-3d-generate" disabled={model3dBusy} onPointerDown={(event) => event.stopPropagation()} onClick={async (event) => {
              event.stopPropagation();
              const api = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
              if (!api || typeof api.command !== "function") { setModel3dError("未连接桌面后端"); return; }
              setModel3dBusy(true); setModel3dError("");
              try {
                const canvasId = props.canvasId || "default";
                const mode3d = model3dModes[node.id] || "text";
                if (mode3d === "image" && !model3dRefs[node.id]) { setModel3dError("请先上传参考图"); return; }
                let result = await api.command({ type: "canvas/model3d", canvasId, nodeId: node.id, async: true, prompt: node.text || "a small red apple", mode: mode3d, sourceDataUrl: mode3d === "image" ? model3dRefs[node.id] : null });
                if (result && result.async === true && result.runId) {
                  setModel3dRunId(String(result.runId));
                  const deadline = Date.now() + 10 * 60 * 1000;
                  let terminal: Record<string, unknown> | null = null;
                  while (Date.now() < deadline) {
                    await new Promise((resolve) => window.setTimeout(resolve, 1000));
                    const status = await api.command({ type: "canvas/runStatus", canvasId, runId: result.runId });
                    if (!status || status.ok !== true) throw new Error(String((status && status.error) || "RUN_STATUS_FAILED"));
                    if (status.status === "DONE") { terminal = (status.result || {}) as Record<string, unknown>; break; }
                    if (status.status === "FAILED") throw new Error(String(status.error || "3D 生成失败"));
                    if (status.status === "STOPPED") { setModel3dError("已停止"); return; }
                  }
                  if (!terminal) throw new Error("生成超时（10 分钟）");
                  result = terminal;
                }
                if (!result || result.ok !== true) { setModel3dError(String((result && (result.detail || result.error)) || "3D 生成失败")); return; }
                props.dispatch({ type: "update-node", id: node.id, patch: { url: String(result.modelUrl || "") } }, { history: true });
              } catch (caught) { setModel3dError(caught instanceof Error ? caught.message : "3D 生成失败"); }
              finally { setModel3dBusy(false); setModel3dRunId(null); }
            }}>{model3dBusy ? "生成中…" : "生成 3D"}</button>
            {model3dBusy ? <button data-testid="node-3d-stop" onClick={async () => { const api = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas; if (api && typeof api.command === "function" && model3dRunId) { await api.command({ type: "canvas/runStop", canvasId: new URLSearchParams(window.location.search).get("canvas") || props.canvasId || "default", runId: model3dRunId, reason: "USER_STOP" }); } setModel3dError("已停止"); setModel3dBusy(false); }}>停止</button> : null}
            {model3dError ? <div className="rc-model3d-error" data-testid="model3d-generate-error">{model3dError}</div> : null}
            {node.url ? <div className="rc-model3d-viewer"><Model3DViewer url={node.url} /></div> : null}
          </div>
        ) : node.kind === "table" ? (() => {
          const raw = node.data as any;
          const matrix: string[][] = Array.isArray(raw) ? raw.map((row: any) => Array.isArray(row) ? row.map(String) : [String(row)]) : Array.isArray(raw && raw.cells) ? raw.cells.map((row: any) => Array.isArray(row) ? row.map(String) : [String(row)]) : [Array.isArray(raw && raw.columns) ? raw.columns.map(String) : [], ...(Array.isArray(raw && raw.rows) ? raw.rows.map((row: any) => Array.isArray(row) ? row.map(String) : [String(row)]) : [])];
          const columns = matrix[0] || [];
          const rows = matrix.slice(1);
          return <div className="rc-legacy-table" data-testid="legacy-table" data-columns={columns.length} data-rows={rows.length}>
            {columns.length ? <div className="rc-legacy-table-row is-head" data-testid="legacy-table-head">{columns.map((cell, index) => <span key={index}>{cell}</span>)}</div> : null}
            {rows.map((row, rowIndex) => <div className="rc-legacy-table-row" data-testid="legacy-table-row" key={rowIndex}>{row.map((cell, index) => <span key={index}>{cell}</span>)}</div>)}
            {!columns.length && !rows.length ? <div className="rc-legacy-empty" data-testid="legacy-table-empty">表格数据为空或格式无法识别</div> : null}
            <span className="rc-legacy-badge" data-testid="legacy-readonly-badge">旧版只读</span>
          </div>;
        })() : node.kind === "smart-batch" || node.kind === "smart-loop" ? (() => {
          const raw = node.data as any;
          const count = Number(raw && (raw.count || raw.items?.length || raw.iterations || raw.loopCount)) || (Array.isArray(raw) ? raw.length : 0);
          return <div className="rc-legacy-card" data-testid={node.kind === "smart-batch" ? "legacy-batch" : "legacy-loop"}>
            <Box size={28} /><strong>{node.text || (node.kind === "smart-batch" ? "批量节点" : "循环节点")}</strong>
            <span>{node.kind === "smart-batch" ? "子项 " : "循环 "}{count} {node.kind === "smart-batch" ? "个" : "次"}</span>
            <span className="rc-legacy-badge" data-testid="legacy-readonly-badge">旧版只读</span>
          </div>;
        })() : node.kind === "video" ? (
          node.url ? (
            <video className="rc-node-video-real" src={node.url} controls data-testid="node-generated-video" />
          ) : (
            <div className="rc-node-image"><Video size={40} /></div>
          )
        ) : node.kind === "image" ? (
          node.url ? (
            <img className="rc-node-image-real" src={node.url} alt={node.text || "生成图片"} data-testid="node-generated-image" />
          ) : (
            <div className="rc-node-image">
              <ImageIcon size={40} />
            </div>
          )
        ) : editing ? (
          <textarea
            className="rc-node-editor"
            data-testid="node-editor"
            value={draftText}
            autoFocus
            onChange={(event) => {
              const value = event.target.value;
              setDraftText(value);
              queueTextUpdate(node.id, value);
            }}
            onBlur={() => commitText(node.id, draftText)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                commitText(node.id, draftText);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commitText(node.id, draftText);
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ) : (
          <div className={"rc-node-text" + (node.text ? "" : " is-placeholder")}>
            {node.text || (node.kind === "text" ? "双击编辑文本" : "双击编辑便签")}
          </div>
        )}
        {!editing && node.kind !== "group" ? (
          <>
            <span
              className="rc-handle rc-handle-left"
              role="button"
              aria-label="从左侧连线"
              data-testid="handle-left"
              onPointerDown={(event) => startConnect(event, node, "left")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={endConnect}
            />
            <span
              className="rc-handle rc-handle-right"
              role="button"
              aria-label="从右侧连线"
              data-testid="handle-right"
              onPointerDown={(event) => startConnect(event, node, "right")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={endConnect}
            />
          </>
        ) : null}
      </div>
    );
  };

  const minimapDragRef = useRef(false);

  const minimapLayout = () => {
    const nodes = docRef.current.nodes;
    if (!nodes.length) return null;
    const minX = Math.min.apply(null, nodes.map((node) => node.x));
    const minY = Math.min.apply(null, nodes.map((node) => node.y));
    const maxX = Math.max.apply(null, nodes.map((node) => node.x + node.w));
    const maxY = Math.max.apply(null, nodes.map((node) => node.y + node.h));
    const worldW = Math.max(1, maxX - minX + MINIMAP_PAD * 2);
    const worldH = Math.max(1, maxY - minY + MINIMAP_PAD * 2);
    const scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH);
    return {
      scale,
      offsetX: (MINIMAP_W - worldW * scale) / 2 - (minX - MINIMAP_PAD) * scale,
      offsetY: (MINIMAP_H - worldH * scale) / 2 - (minY - MINIMAP_PAD) * scale,
    };
  };

  const centerOnWorld = (worldX: number, worldY: number) => {
    const el = viewportRef.current;
    if (!el) return;
    setView((prev) => ({ k: prev.k, x: el.clientWidth / 2 - worldX * prev.k, y: el.clientHeight / 2 - worldY * prev.k }));
  };

  const minimapToWorld = (event: ReactPointerEvent<SVGSVGElement>) => {
    const layout = minimapLayout();
    if (!layout) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - layout.offsetX) / layout.scale,
      y: (event.clientY - rect.top - layout.offsetY) / layout.scale,
    };
  };

  const onMinimapPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = minimapToWorld(event);
    if (!point) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    minimapDragRef.current = true;
    centerOnWorld(point.x, point.y);
  };

  const onMinimapPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!minimapDragRef.current) return;
    const point = minimapToWorld(event);
    if (point) centerOnWorld(point.x, point.y);
  };

  const onMinimapPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    minimapDragRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (viewportRef.current) {
    elWidthRef.current = viewportRef.current.clientWidth;
    elHeightRef.current = viewportRef.current.clientHeight;
  }
  const selectedImageNode =
    props.selectedNodeIds.length === 1 ? doc.nodes.find((node) => node.id === props.selectedNodeIds[0]) : undefined;
  const overlayNode =
    selectedImageNode && (selectedImageNode.kind === "image" || selectedImageNode.kind === "video" || selectedImageNode.kind === "audio") && editingId !== selectedImageNode.id ? selectedImageNode : undefined;
  const overlayRect = overlayNode
    ? {
        left: overlayNode.x * view.k + view.x,
        top: overlayNode.y * view.k + view.y,
        width: overlayNode.w * view.k,
        height: overlayNode.h * view.k,
      }
    : null;
  const miniLayout = minimapLayout();

  const orderedNodes = doc.nodes
    .slice()
    .sort((a, b) => (a.kind === "group" ? 0 : 1) - (b.kind === "group" ? 0 : 1));

  return (
    <>
      <div
        ref={viewportRef}
        className={"rc-viewport" + (panning ? " is-panning" : "") + (dragActive ? " is-drag-active" : "")}
        data-testid="canvas-viewport"
        style={{
          backgroundColor: "#000",
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,.3) 0.6409494922964066px, transparent 0.641px)",
          backgroundSize: "25.637979691856266px 25.637979691856266px",
          backgroundPosition: "-12.818989845928133px -12.818989845928133px",
        }}
        onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer.types.indexOf("Files") >= 0) setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleCanvasDrop}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={onViewportPointerUp}
        onPointerLeave={() => props.onCursor(null)}
        onDoubleClick={onViewportDoubleClick}
        onContextMenu={onViewportContextMenu}
      >
        <svg className={"rc-edges" + (showEdges ? "" : " is-hidden")} width="100%" height="100%" aria-hidden="true">
          <g transform={"translate(" + view.x + " " + view.y + ") scale(" + view.k + ")"}>
            {showEdges ? doc.edges.map((edge) => {
              const from = doc.nodes.find((n) => n.id === edge.from);
              const to = doc.nodes.find((n) => n.id === edge.to);
              if (!from || !to) return null;
              if (!isNodeMounted(from) || !isNodeMounted(to)) return null;
              const path = edgeGeometry(from, to, edge.fromSide || "right");
              return (
                <g key={edge.id}>
                  <path className={"rc-edge" + (selectedEdgeId === edge.id ? " is-selected" : "") + (drawingEdgeIds.has(edge.id) ? " is-drawing" : "")} d={path} />
                  <path
                    className="rc-edge-hit"
                    d={path}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      props.onSelectEdge(edge.id);
                    }}
                  />
                </g>
              );
            }) : null}
            {connectPath ? <path className="rc-edge rc-edge-temp" d={connectPath} /> : null}
            {marquee ? (
              <rect
                className="rc-marquee"
                x={Math.min(marquee.x0, marquee.x1)}
                y={Math.min(marquee.y0, marquee.y1)}
                width={Math.abs(marquee.x1 - marquee.x0)}
                height={Math.abs(marquee.y1 - marquee.y0)}
              />
            ) : null}
          </g>
        </svg>
        <div
          className="rc-world"
          style={{ transform: "translate(" + view.x + "px, " + view.y + "px) scale(" + view.k + ")" }}
        >
          {orderedNodes.map(renderNode)}
          {props.comments.map((comment, index) => {
            const author = comment.author || shortLabel(comment.clientId);
            const own = comment.clientId === props.clientId;
            return (
              <div key={comment.id} className="rc-comment-anchor" style={{ left: comment.x, top: comment.y }} data-testid="comment-anchor">
                <button
                  className={"rc-comment-pin" + (openCommentId === comment.id ? " is-open" : "")}
                  data-testid="comment-pin"
                  title={author + "：" + comment.text}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); setOpenCommentId(openCommentId === comment.id ? null : comment.id); }}
                >
                  {index + 1}
                </button>
                {openCommentId === comment.id ? (
                  <div className="rc-comment-bubble" data-testid="comment-bubble" onPointerDown={(event) => event.stopPropagation()}>
                    <p className="rc-comment-bubble-text">{comment.text}</p>
                    <div className="rc-comment-bubble-meta">
                      <span>{author} · {new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                      {own ? <button className="rc-comment-delete" data-testid="comment-delete" onClick={() => { props.onDeleteComment(comment.id); setOpenCommentId(null); }}>删除</button> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {props.pendingComment ? (
            <div className="rc-comment-anchor" style={{ left: props.pendingComment.x, top: props.pendingComment.y }} data-testid="comment-pending">
              <span className="rc-comment-pin is-pending">+</span>
            </div>
          ) : null}
        </div>
        {Object.keys(peers).map((id) => {
          const peer = peers[id];
          if (!peer.cursor) return null;
          const screenX = peer.cursor.x * view.k + view.x;
          const screenY = peer.cursor.y * view.k + view.y;
          const color = peerColor(id);
          return (
            <div key={id} className="rc-remote" style={{ left: screenX, top: screenY }} data-testid="remote-cursor">
              <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
                <path
                  d="M1 1 L13 9 L7.5 10.5 L10 16.5 L7 17.5 L4.5 11.5 L1 15 Z"
                  fill={color}
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth="0.8"
                />
              </svg>
              <span className="rc-remote-label" style={{ background: color }}>
                {shortLabel(id)}
              </span>
            </div>
          );
        })}
        {doc.nodes.length === 0 ? (
          <div className="rc-empty-hint">滚轮缩放 · 空白拖拽平移 · Shift 拖拽框选 · 左侧 + 添加节点</div>
        ) : null}
      </div>
      {minimapOpen ? (
        <div className="rc-minimap" data-testid="minimap">
          {doc.nodes.length === 0 || !miniLayout ? (
            <p className="rc-minimap-empty">画布为空</p>
          ) : (
            <svg
              className="rc-minimap-canvas"
              width={MINIMAP_W}
              height={MINIMAP_H}
              onPointerDown={onMinimapPointerDown}
              onPointerMove={onMinimapPointerMove}
              onPointerUp={onMinimapPointerUp}
              onPointerCancel={onMinimapPointerUp}
            >
              {doc.nodes.map((node) => (
                <rect
                  key={node.id}
                  className={"rc-minimap-node" + (node.kind === "group" ? " is-group" : "")}
                  data-testid="minimap-node"
                  x={miniLayout.offsetX + node.x * miniLayout.scale}
                  y={miniLayout.offsetY + node.y * miniLayout.scale}
                  width={Math.max(2, node.w * miniLayout.scale)}
                  height={Math.max(2, node.h * miniLayout.scale)}
                  rx={2}
                />
              ))}
              <rect
                className="rc-minimap-viewport"
                data-testid="minimap-viewport"
                x={miniLayout.offsetX + (-view.x / view.k) * miniLayout.scale}
                y={miniLayout.offsetY + (-view.y / view.k) * miniLayout.scale}
                width={Math.max(2, (elWidthRef.current / view.k) * miniLayout.scale)}
                height={Math.max(2, (elHeightRef.current / view.k) * miniLayout.scale)}
              />
            </svg>
          )}
        </div>
      ) : null}
      <input ref={nodeUploadRef} type="file" accept="image/*" multiple hidden data-testid="node-upload-input" onChange={handleNodeUpload} />
      <input ref={refUploadRef} type="file" accept="image/*" hidden data-testid="node-ref-input" onChange={(event) => { const file = event.target.files && event.target.files[0]; const node = overlayNode; if (!file || !node) return; const reader = new FileReader(); reader.onload = () => { const url = String(reader.result || ""); props.dispatch({ type: "update-node", id: node.id, patch: { refUrl: url } }, { history: true }); }; reader.readAsDataURL(file); event.target.value = ""; }} />
      {uploadError ? <div className="rc-upload-error" data-testid="node-upload-error">{uploadError}</div> : null}
      <div className="rc-zoombar" data-testid="zoombar">
        <button
          className="rc-zoom-button"
          aria-label="小地图"
          title="打开小地图"
          data-testid="minimap-toggle"
          aria-pressed={minimapOpen}
          onClick={() => {
            setMinimapOpen((open) => !open);
            setHelpOpen(false);
          }}
        >
          <MapIcon size={14} />
        </button>
        <button
          className="rc-zoom-button"
          aria-label="隐藏节点连线"
          title="隐藏节点连线"
          data-testid="toggle-edges"
          aria-pressed={!showEdges}
          onClick={() => { const next = !showEdges; setShowEdges(next); props.onUpdateSettings({ hideEdges: !next }); }}
        >
          <EyeOff size={14} />
        </button>
        <button
          className="rc-zoom-button"
          aria-label="网格吸附"
          title="网格吸附"
          data-testid="toggle-grid"
          aria-pressed={gridSnap}
          onClick={() => { const next = !gridSnap; setGridSnap(next); props.onUpdateSettings({ gridSnap: next }); }}
        >
          <Magnet size={14} />
        </button>
        <button className="rc-zoom-button" aria-label="重置视图" title="重置视图" data-testid="view-reset" onClick={resetView}>
          <RotateCcw size={14} />
        </button>
        <input
          className="rc-zoom-slider"
          data-testid="zoom-slider"
          type="range"
          min={Math.round(MIN_SCALE * 100)}
          max={Math.round(MAX_SCALE * 100)}
          step={1}
          value={Math.round(view.k * 100)}
          aria-label="缩放（15%–200%）"
          aria-valuetext={Math.round(view.k * 100) + "%"}
          onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) setView((v) => ({ ...v, k: Math.max(MIN_SCALE, Math.min(MAX_SCALE, next / 100)) })); }}
        />
        <span className="rc-zoom-value" data-testid="zoom-value">{Math.round(view.k * 100)}%</span>
      </div>
      <button className="rc-help-button" aria-label="快捷键帮助" title="快捷键帮助" data-testid="help-toggle" aria-pressed={helpOpen} onClick={() => setHelpOpen((open) => !open)}><HelpCircle size={16} /></button>
      {helpOpen ? (
        <div className="rc-help-menu" data-testid="help-menu">
          <button className="rc-help-item" data-testid="help-shortcuts" onClick={() => { setHelpOpen(false); setShortcutsOpen(true); }}><Keyboard size={14} /><span>快捷键</span></button>
          <button className="rc-help-item" data-testid="help-center" onClick={() => { setHelpOpen(false); setHelpModal("help"); }}><HelpCircle size={14} /><span>帮助中心</span></button>
          <button className="rc-help-item" data-testid="help-feedback" onClick={() => { setHelpOpen(false); if (props.onOpenFeedback) props.onOpenFeedback(); else setHelpModal("feedback"); }}><HelpCircle size={14} /><span>反馈</span></button>
          <button className="rc-help-item" data-testid="help-changelog" onClick={() => { setHelpOpen(false); setHelpModal("changelog"); }}><HelpCircle size={14} /><span>更新日志</span></button>
          <button className="rc-help-item" data-testid="help-about" onClick={() => { setHelpOpen(false); setHelpModal("about"); }}><HelpCircle size={14} /><span>关于</span><small>OpenArc OS</small></button>
        </div>
      ) : null}
      {shortcutsOpen ? (
        <div className="rc-shortcuts-panel" data-testid="shortcuts-panel">
          <div className="rc-shortcuts-head"><strong>快捷键</strong><button data-testid="shortcuts-close" onClick={() => setShortcutsOpen(false)}><X size={14} /></button></div>
          <div className="rc-shortcuts-row"><span className="rc-shortcut-keys">Space</span><span className="rc-shortcut-label">平移画布</span></div>
          <div className="rc-shortcuts-row"><span className="rc-shortcut-keys">Ctrl + 滚轮</span><span className="rc-shortcut-label">缩放</span></div>
          <div className="rc-shortcuts-row is-disabled"><span className="rc-shortcut-keys">C</span><span className="rc-shortcut-label">评论</span><small>未接入</small></div>
        </div>
      ) : null}
      {overlayNode && overlayRect && !previewUrl ? (
        <div className="rc-node-overlay" data-testid="node-overlay" style={overlayRect}>
          <div className="rc-node-toolbar" data-testid="node-toolbar" onPointerDown={(event) => event.stopPropagation()}>
            <button className="rc-node-tool-pill" data-testid="node-tool-upload" title="上传图片" onClick={() => { uploadReplaceRef.current = overlayNode.id; nodeUploadRef.current?.click(); }}>
              <Upload size={12} /><span>上传</span>
            </button>
            {overlayNode.url ? (<>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-download" title="下载" onClick={() => { const a = document.createElement("a"); a.href = overlayNode.url || ""; a.download = "image.png"; a.click(); }}><Download size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-preview" title="预览" onClick={() => setPreviewUrl(overlayNode.url || "")}><Eye size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-rotate" title="旋转 90°" onClick={() => void applyImageEdit("rotate")}><RotateCw size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-flip-h" title="水平翻转" onClick={() => void applyImageEdit("flip-h")}><FlipHorizontal2 size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-flip-v" title="垂直翻转" onClick={() => void applyImageEdit("flip-v")}><FlipVertical2 size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-adjust" title="调色" onClick={() => setColorOpen(!colorOpen)}><SlidersHorizontal size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-reset" title="重置" onClick={() => { if (overlayNode.originalUrl) props.dispatch({ type: "update-node", id: overlayNode.id, patch: { url: overlayNode.originalUrl } }, { history: true }); else setImageError("没有可重置的原始图片"); }}><RotateCcw size={14} /></button>
            </>) : null}
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-crop" title="裁剪" onClick={() => setImageEditor({ nodeId: overlayNode.id, mode: "crop" })}><Crop size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" title="AI 蒙版编辑（Lovart 图生图）" data-testid="image-magic" onClick={() => setMaskNodeId(overlayNode.id)}><PenLine size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-annotate" title="标注" onClick={() => setImageEditor({ nodeId: overlayNode.id, mode: "annotate" })}><PenLine size={14} /></button>
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-grid" title="宫格切分" onClick={() => setGridOpen(!gridOpen)}><Grid3X3 size={14} /></button>
            {gridOpen ? <div className="rc-grid-menu" data-testid="image-grid-menu"><button data-testid="image-grid-2" onClick={() => void splitImageGrid(overlayNode, 2)}>2×2</button><button data-testid="image-grid-3" onClick={() => void splitImageGrid(overlayNode, 3)}>3×3</button></div> : null}
            <button className="rc-node-tool-icon" tabIndex={-1} aria-hidden="true" data-testid="image-upscale" title="本地 2x 放大（非 AI 超分）" onClick={() => void applyImageEdit("upscale")}><Sparkles size={14} /></button>
          </div>
          {colorOpen && overlayNode.url ? (
            <div className="rc-image-color-pop" data-testid="image-color-pop" onPointerDown={(event) => event.stopPropagation()}>
              {(["brightness", "contrast", "saturate"] as const).map((key) => (
                <label key={key}>{key === "brightness" ? "亮度" : key === "contrast" ? "对比度" : "饱和度"}
                  <input type="range" min="0.5" max="1.5" step="0.05" value={colorValues[key]} onChange={(event) => { const value = Number(event.target.value); setColorValues((prev) => ({ ...prev, [key]: value })); }} />
                </label>
              ))}
              <div className="rc-image-color-actions">
                <button data-testid="image-color-cancel" onClick={() => setColorOpen(false)}>取消</button>
                <button data-testid="image-color-apply" onClick={() => void applyImageEdit("color")}>确认</button>
              </div>
            </div>
          ) : null}
          <div className="rc-node-genbar" data-testid="node-genbar" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape" && props.generation[overlayNode.id]?.status === "pending") { event.preventDefault(); event.stopPropagation(); props.onStopGeneration?.(overlayNode.id); } }}>
            <div className="rc-gen-tools">
              <button className="rc-gen-icon" disabled={!props.chatModels.length || !genPrompt.trim()} title={props.chatModels.length ? "增强提示词" : "未接入模型"} data-testid="node-gen-enhance" onClick={async () => { if (!props.chatModels.length || !genPrompt.trim()) return; try { const next = await props.onEnhancePrompt(genPrompt); setGenPrompt(next); } catch { /* 保持原提示词 */ } }}><Sparkles size={14} /></button>
              <button className="rc-gen-icon" title="添加参考图" data-testid="node-gen-upload" onClick={() => refUploadRef.current?.click()}><Plus size={14} /></button>
            </div>
            <textarea className="rc-gen-prompt" data-testid="node-gen-prompt" placeholder="描述任何你想要生成的内容" rows={2} value={genPrompt} onChange={(event) => setGenPrompt(event.target.value)} />
            <div className="rc-gen-foot">
              {modelMenuKind ? <div className="rc-gen-model-menu" data-testid="node-model-menu">
                {(modelMenuKind === "video" ? props.videoModels : modelMenuKind === "audio" ? props.audioModels : props.imageModels).map((model) => (
                  <button key={model.configId} data-testid="node-model-option" data-config-id={model.configId} className={props.selectedConfigs?.[modelMenuKind] === model.configId ? "is-active" : ""} onClick={() => { props.onSelectModel?.(modelMenuKind, model.configId); setModelMenuKind(null); }}>
                    <span className="rc-model-option-icon">{modelMenuKind === "video" ? <Video size={16} /> : modelMenuKind === "audio" ? <Music size={16} /> : <ImageIcon size={16} />}</span>
                    <span className="rc-model-option-text"><strong>{model.label}</strong>{model.providerName ? <small>{model.providerName}</small> : null}</span>
                    {props.selectedConfigs?.[modelMenuKind] === model.configId ? <Check size={14} className="rc-model-option-check" /> : null}
                  </button>
                ))}
                {(!props.imageModels.length && modelMenuKind === "image") ? <span className="rc-model-menu-empty">未配置模型</span> : null}
              </div> : null}
              <button className="rc-gen-chip" data-testid="node-gen-model" onClick={() => { const kind = overlayNode.kind === "video" ? "video" : overlayNode.kind === "audio" ? "audio" : "image"; const list = kind === "video" ? props.videoModels : kind === "audio" ? props.audioModels : props.imageModels; if (!list.length) { if (kind === "video") props.onReloadVideoModels?.(); else if (kind === "audio") props.onReloadAudioModels?.(); else props.onReloadModels?.(); return; } setModelMenuKind((prev) => prev === kind ? null : kind); }} title={(overlayNode.kind === "video" ? props.videoModels.length : overlayNode.kind === "audio" ? props.audioModels.length : props.imageModels.length) ? "选择模型" : "模型未配置，点击读取或打开模型设置"}>
                <Sparkles size={12} />{overlayNode.kind === "video" ? (props.videoModelLabel || props.videoModels[0]?.label || "视频模型未配置") : overlayNode.kind === "audio" ? (props.audioModelLabel || props.audioModels[0]?.label || "音频模型未配置") : (props.selectedImageModelLabel || props.imageModels[0]?.label || "模型未配置")}
              </button>
              <span className="rc-gen-chip">{overlayNode.kind === "video" ? "16:9 · 默认时长" : overlayNode.kind === "audio" ? "音乐 · 自适应" : "1:1 · 2K"}</span>
              <span className="rc-gen-spacer" />
              {overlayNode.kind !== "audio" ? <span className="rc-gen-chip">1x</span> : null}
              <span className="rc-gen-chip" data-testid="node-gen-cost" title="费用估算未接入" aria-label="费用估算未接入">—</span>
              {props.generation[overlayNode.id]?.status === "pending" ? <button className="rc-gen-stop" data-testid="node-gen-stop" aria-label="停止生成" title="停止生成" onClick={() => props.onStopGeneration?.(overlayNode.id)}><span /></button> : null}
              <button className={`rc-gen-send${props.generation[overlayNode.id]?.status === "pending" ? " is-loading" : ""}`} data-testid="node-gen-send" disabled={!genPrompt.trim() || (overlayNode.kind === "video" ? props.videoModels.length === 0 : overlayNode.kind === "audio" ? props.audioModels.length === 0 : props.imageModels.length === 0) || props.generation[overlayNode.id]?.status === "pending"} onClick={() => { if (overlayNode.kind === "video") props.onGenerateVideo(overlayNode.id, genPrompt.trim()); else if (overlayNode.kind === "audio") props.onGenerateAudio(overlayNode.id, genPrompt.trim()); else props.onGenerateImage(overlayNode.id, genPrompt.trim()); }}>{props.generation[overlayNode.id]?.status === "pending" ? <span className="rc-gen-spinner" data-testid="node-gen-spinner" /> : <ArrowUp size={16} />}</button>
            </div>
            {overlayNode.refUrl ? <span className="rc-ref-badge" data-testid="node-ref-badge">参考图已添加</span> : null}
        {props.generation[overlayNode.id]?.status === "pending" ? <div className="rc-gen-status" data-testid="node-gen-pending">生成中… {pendingSeconds}s</div> : null}
            {props.generation[overlayNode.id]?.status === "error" ? <div className="rc-gen-status is-error" data-testid="node-gen-error">{props.generation[overlayNode.id]?.error || "生成失败"}</div> : null}
          </div>
        </div>
      ) : null}
      {doc.nodes.length === 0 ? (
        <div className="rc-empty-state" data-testid="canvas-empty-state">
          <p className="rc-empty-line"><span className="rc-empty-double" data-testid="empty-double-click"><MousePointer2 size={13} />双击</span><span>画布自由生成，或查看模板</span></p>
          <div className="rc-empty-chips">
            <button data-testid="empty-chip-text-video" onClick={() => props.onCanvasSuggestion?.("生成一段电影感的视频")}><Film size={14} />文字生视频</button>
            <button data-testid="empty-chip-bg" onClick={() => props.onCanvasSuggestion?.("把这张图片的背景换成极简影棚")}><ImageIcon size={14} />图片换背景</button>
            <button data-testid="empty-chip-first-frame" onClick={() => props.onCanvasSuggestion?.("用这张首帧生成一段视频")}><Video size={14} />首帧生成视频</button>
            <button data-testid="empty-chip-audio-video" onClick={() => props.onCanvasSuggestion?.("用这段音频生成匹配的视频")}><Mic size={14} />音频生视频</button>
            <button data-testid="empty-chip-templates" onClick={() => props.onOpenTemplates?.()}><LayoutGrid size={14} />模板</button>
          </div>
        </div>
      ) : null}
      {maskNodeId ? (() => {
        const node = doc.nodes.find((item) => item.id === maskNodeId);
        if (!node || !node.url) return null;
        return <MaskEditor url={node.originalUrl || node.url} onCancel={() => setMaskNodeId("")} onGenerate={async ({ mode, prompt, sourceDataUrl }) => {
          const api = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
          if (!api || typeof api.command !== "function") throw new Error("未连接桌面后端");
          const canvasId = props.canvasId || "default";
          const run = await api.command({ type: "canvas/run", canvasId, kind: "image", nodeId: node.id, configId: props.selectedConfigs?.image || undefined });
          if (!run || run.ok !== true) throw new Error(String((run && run.error) || "RUN_FAILED"));
          let result;
          try {
            result = await api.command({ type: "canvas/modelImageEdit", canvasId, nodeId: node.id, runId: run.runId, prompt, mode, sourceDataUrl, configId: props.selectedConfigs?.image || undefined });
          } finally {
            await api.command({ type: "canvas/runFinish", canvasId, runId: run.runId, status: "DONE" }).catch(() => undefined);
          }
          if (!result || result.ok !== true) throw new Error(String((result && (result.detail || result.error)) || "IMAGE_EDIT_FAILED"));
          const rows = Array.isArray(result.images) ? result.images as Array<Record<string, unknown>> : [];
          const url = String((rows[0] && (rows[0].dataUrl || rows[0].url || rows[0].sourceUrl)) || "");
          if (!url) throw new Error("生成结果缺少图片地址");
          props.dispatch({ type: "update-node", id: node.id, patch: { url, ...(node.originalUrl ? {} : { originalUrl: node.url }) } }, { history: true });
          setMaskNodeId("");
        }} />;
      })() : null}
      {imageEditor ? (() => {
        const node = doc.nodes.find((item) => item.id === imageEditor.nodeId);
        if (!node || !node.url) return null;
        return <ImageEditor url={node.originalUrl || node.url} mode={imageEditor.mode} onMagic={() => setMaskNodeId(node.id)} onGrid={(count) => { void splitImageGrid(node, count); }} onCancel={() => setImageEditor(null)} onApply={(dataUrl) => { props.dispatch({ type: "update-node", id: node.id, patch: { url: dataUrl, ...(node.originalUrl ? {} : { originalUrl: node.url }) } }, { history: true }); setImageEditor(null); }} />;
      })() : null}
      {helpModal ? (
        <div className="rc-help-modal" data-testid="help-modal" onClick={() => setHelpModal(null)}>
          <div className="rc-help-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="rc-help-modal-head"><strong>{helpModal === "help" ? "帮助中心" : helpModal === "feedback" ? "反馈" : helpModal === "changelog" ? "更新日志" : "关于"}</strong><button data-testid="help-modal-close" onClick={() => setHelpModal(null)}><X size={14} /></button></div>
            <pre className="rc-help-modal-body">
              {helpModal === "help" ? productDoc.slice(0, 6000) : helpModal === "changelog" ? changelogDoc.slice(0, 8000) : helpModal === "feedback" ? "反馈问题\n\n请通过团队任务台或仓库 issue 提交问题，附上画布链接、复现步骤与截图。\n当前版本未接入独立反馈后端，此入口提供真实反馈说明。" : "OpenArc OS\n\n画布 · 智能创作工作台\n开源本地优先，数据保存在本机。"}
            </pre>
          </div>
        </div>
      ) : null}
      {timelineExportNodeId ? (
        <div className="rc-timeline-preview" data-testid="timeline-export-modal" onClick={() => { if (!timelineExporting) setTimelineExportNodeId(""); }}>
          <div className="rc-timeline-player" onClick={(event) => event.stopPropagation()}>
            <div className="rc-timeline-player-head"><span>合成导出 · WebM</span><button data-testid="timeline-export-close" disabled={timelineExporting} onClick={() => { timelineExportCancelRef.current = true; setTimelineExportNodeId(""); }}>关闭</button></div>
            <div className="rc-timeline-export-formats" data-testid="timeline-export-formats">
              <label><input type="radio" name="timeline-format" data-testid="export-format-webm" checked={timelineExportFormat === "webm"} onChange={() => setTimelineExportFormat("webm")} /><span>WebM（浏览器实时合成）</span></label>
              <label className={backendExportAvailable() ? "" : "is-disabled"}><input type="radio" name="timeline-format" data-testid="export-format-mp4" checked={timelineExportFormat === "mp4"} disabled={!backendExportAvailable()} onChange={() => setTimelineExportFormat("mp4")} /><span>MP4（后端渲染）</span>{!backendExportAvailable() ? <small>媒体后端不可用</small> : null}</label>
            </div>
            <div className="rc-timeline-export-meta"><span>分辨率 1280×720</span><span>fps 30</span><span>预计时长 {timelineExportProgress.total.toFixed(1)}s</span></div>
            <div className="rc-timeline-export-progress" data-testid="timeline-export-progress">{timelineExportFormat === "mp4" ? Math.round(timelineExportProgress.current) + "%" : timelineExportProgress.current.toFixed(1) + "s / " + timelineExportProgress.total.toFixed(1) + "s"}</div>
            {timelineExportSuccess ? <div className="rc-timeline-export-success" data-testid="timeline-export-success">{timelineExportSuccess}</div> : null}
            {timelineExportError ? <div className="rc-timeline-error" data-testid="timeline-export-error">{timelineExportError}</div> : null}
            <div className="rc-timeline-player-actions">
              {timelineExporting ? (
                <button data-testid="timeline-export-cancel" onClick={() => { timelineExportCancelRef.current = true; }}>取消导出</button>
              ) : (
                <button data-testid="timeline-export-start" onClick={() => { void startTimelineExport(); }}>开始导出</button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {timelinePreview && timelinePreviewClip ? (
        <div className="rc-timeline-preview" data-testid="timeline-preview-overlay" onClick={closeTimelinePreview}>
          <div className="rc-timeline-player" onClick={(event) => event.stopPropagation()}>
            <div className="rc-timeline-player-head"><span>片段 {timelinePreview.index + 1} / {(timelinePreviewNode?.clips || []).length}</span><button data-testid="timeline-stop" onClick={closeTimelinePreview}>停止</button></div>
            {timelinePreviewClip.mediaKind === "audio" ? (
              <audio key={timelinePreviewClip.id} src={timelinePreviewClip.url} autoPlay controls onTimeUpdate={(event) => { setPreviewTime(event.currentTarget.currentTime); const clip = timelinePreviewClip; const duration = Math.max(0.1, clip.outPoint - clip.inPoint); const fin = Math.max(0, Number(clip.fadeIn) || 0) / 1000; const fout = Math.max(0, Number(clip.fadeOut) || 0) / 1000; setPreviewFade(Math.max(0, Math.min(1, fin > 0 ? (event.currentTarget.currentTime - clip.inPoint) / fin : 1, fout > 0 ? (clip.outPoint - event.currentTarget.currentTime) / fout : 1))); if (event.currentTarget.currentTime >= timelinePreviewClip.outPoint) advanceTimeline(); }} onEnded={advanceTimeline} onError={() => setTimelineError("媒体元数据加载失败")} data-testid="timeline-media" />
            ) : (
              <video key={timelinePreviewClip.id} src={timelinePreviewClip.url} autoPlay controls onTimeUpdate={(event) => { setPreviewTime(event.currentTarget.currentTime); const clip = timelinePreviewClip; const duration = Math.max(0.1, clip.outPoint - clip.inPoint); const fin = Math.max(0, Number(clip.fadeIn) || 0) / 1000; const fout = Math.max(0, Number(clip.fadeOut) || 0) / 1000; setPreviewFade(Math.max(0, Math.min(1, fin > 0 ? (event.currentTarget.currentTime - clip.inPoint) / fin : 1, fout > 0 ? (clip.outPoint - event.currentTarget.currentTime) / fout : 1))); if (event.currentTarget.currentTime >= timelinePreviewClip.outPoint) advanceTimeline(); }} onEnded={advanceTimeline} onError={() => setTimelineError("媒体元数据加载失败")} data-testid="timeline-media" style={{ opacity: previewFade, transition: "opacity .2s linear" }} />
            )}
            {(() => { const subtitle = (timelinePreviewNode?.clips || []).find((clip) => clip.type === "subtitle" && previewTime >= (clip.start || 0) && previewTime <= (clip.end || 0)); return subtitle ? <div className="rc-timeline-subtitle-overlay" data-testid="timeline-subtitle-overlay">{subtitle.text}</div> : null; })()}
            {timelineError ? <div className="rc-timeline-error" data-testid="timeline-error">{timelineError}</div> : null}
          </div>
        </div>
      ) : null}
      {previewUrl ? createPortal(
        <div className="rc-image-preview" data-testid="image-preview-overlay" onClick={() => setPreviewUrl("")} role="dialog" aria-modal="true" aria-label="图片预览">
          <img src={previewUrl} alt="预览" onClick={(event) => event.stopPropagation()} />
        </div>, document.body,
      ) : null}
      {imageError ? <div className="rc-upload-error" data-testid="image-error">{imageError}</div> : null}
      {legacyNotice ? <div className="rc-legacy-notice" data-testid="legacy-readonly-notice" onClick={() => setLegacyNotice("")}>{legacyNotice}</div> : null}
    </>
  );
});
