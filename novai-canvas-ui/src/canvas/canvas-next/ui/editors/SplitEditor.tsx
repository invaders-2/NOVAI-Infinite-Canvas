/**
 * 拆分图层（弹窗）：工具条「拆分图层」→ 自动 / 自定义 → 全屏对话框里挂 static/tools/split-layers/index.html。
 *
 * 为什么不再建「拆分结果」节点：拆分是一次性操作，节点会一直占画布、还要处理窗口拖动/最小尺寸；
 * 跟无损改图、调色统一成「弹窗里改完 → 保存落一个普通图片节点」，操作模型一致，编辑器也能铺满屏幕。
 *
 * 协议：iframe ready → init（源图 / 尺寸 / 模式 / 后端地址）；
 *      save → 上传承合图 → 源图右边建普通图片节点 + 连线；close → 直接关窗，画布不留东西。
 * 旧的「拆分结果」节点（文档里已有 split 数据）仍由 SplitNode 渲染，本组件不碰。
 */
import { isAssetRef } from "../../../canvasAssetRefs";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { fitMediaBox } from "../../mediaFit";
import { outOf, uid } from "../../model";
import { useCtl, useS } from "../ctx";
import { Icon } from "../Icon";
import { toDataUrl } from "./sourceToDataUrl";

const TOOL_PAGE = "/static/tools/split-layers/index.html";
const TOOL_QUERY = "?embed=1&inline=1&theme=";
/** 工具页要用的后端接口：同源，apiBase 用 location.origin */
const API_PATH = "/api/canvas/split";
const TOOL_SRC = "novai-split-editor";
const HOST_SRC = "novai-split-host";
/** 编辑器加载失败不会回消息：等 15s 仍未 ready 就提示重试 */
const READY_TIMEOUT_MS = 15000;
/** 源图长边上限：拆分层由后端处理，超过 2000 的图先缩（请求体和编辑器内存都省） */
const MAX_SIDE = 2000;
/** 弹窗默认尺寸：比铺满小一档，够放下画板 + 196 图层栏；用户拖右下角可自己调 */
const DEFAULT_SIZE = { w: 1100, h: 800 };
const MIN_SIZE = { w: 900, h: 620 };
const SIZE_KEY = "novai-split-editor-size";

function clampSize(w: number, h: number) {
  const maxW = Math.max(360, window.innerWidth - 32);
  const maxH = Math.max(320, window.innerHeight - 32);
  const minW = Math.min(MIN_SIZE.w, maxW);
  const minH = Math.min(MIN_SIZE.h, maxH);
  return { w: Math.round(Math.min(Math.max(w, minW), maxW)), h: Math.round(Math.min(Math.max(h, minH), maxH)) };
}

function loadSize() {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) || "null") as { w?: unknown; h?: unknown } | null;
    if (raw && Number(raw.w) > 0 && Number(raw.h) > 0) return clampSize(Number(raw.w), Number(raw.h));
  } catch { /* 存储坏了就用默认 */ }
  return clampSize(DEFAULT_SIZE.w, DEFAULT_SIZE.h);
}

export type SplitMode = "auto" | "custom";

type SeState = { id: string; mode: SplitMode } | null;
let se: SeState = null;
const subs = new Set<() => void>();
const setSe = (v: SeState) => { se = v; subs.forEach((l) => l()); };
const useSeState = () => useSyncExternalStore((l) => { subs.add(l); return () => { subs.delete(l); }; }, () => se);

/** 工具条「拆分图层」→ 打开拆分弹窗 */
export function openSplitEditor(id: string, mode: SplitMode) { setSe({ id, mode }); }

/* ---------- 编辑层 ---------- */
export function SplitEditorLayer() {
  const st = useSeState();
  if (!st) return null;
  return <SplitEditor key={st.id + ":" + st.mode} id={st.id} mode={st.mode} />;
}

function SplitEditor({ id, mode }: { id: string; mode: SplitMode }) {
  const ctl = useCtl();
  const store = ctl.store;
  const node = useS((s) => s.doc).nodes.find((x) => x.id === id);
  const theme = useS((s) => s.ui.theme);
  // iframe 地址只在挂载时算一次：跟着 theme 重算会让 iframe 整个重载，主题改用消息同步
  const [page] = useState(() => TOOL_PAGE + TOOL_QUERY + encodeURIComponent(store.state.ui.theme));
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prepared, setPrepared] = useState<{ image: string; width: number; height: number } | null>(null);
  const [size, setSize] = useState(loadSize);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const readyRef = useRef(false);
  const sentRef = useRef(false);
  const themeSentRef = useRef("");
  const aliveRef = useRef(true);
  const savingRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

  const send = (msg: Record<string, unknown>) => {
    const w = frameRef.current?.contentWindow;
    if (!w) return false;
    w.postMessage({ source: HOST_SRC, ...msg }, /^https?:$/.test(location.protocol) ? location.origin : "*");
    return true;
  };

  /** 右下角拖动改尺寸：只在用户松手时写 localStorage，拖拽过程不刷存储 */
  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const from = sizeRef.current;
    const move = (ev: PointerEvent) => {
      const next = clampSize(from.w + (ev.clientX - startX), from.h + (ev.clientY - startY));
      setSize(next);
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizeRef.current)); } catch { /* 隐私模式写不进去就算了 */ }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  }

  // 浏览器窗口变小：把对话框收回可视区（不改用户存的尺寸）
  useEffect(() => {
    const onResize = () => setSize((s) => clampSize(s.w, s.h));
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  const close = () => {
    setSe(null);
    if (store.node(id)) ctl.focusNode(id);
  };
  const fail = (message: string) => {
    if (!aliveRef.current) return;
    store.toast("拆分图层失败：" + message);
    close();
  };

  /* 挂载：解析源图并压成 dataURL，等 iframe ready 再发 init */
  useEffect(() => {
    aliveRef.current = true;
    if (!node) { fail("源图已经不在了"); return; }
    const raw = outOf(node)?.url || "";
    if (!raw) { fail("源图还没有图片"); return; }
    let alive = true;
    void (async () => {
      try {
        const url = isAssetRef(raw) ? (await store.backend.resolveAsset(raw)) || "" : raw;
        if (!url) throw new Error("源图地址解析失败");
        const prep = await toDataUrl(url, MAX_SIDE);
        if (alive && aliveRef.current) setPrepared(prep);
      } catch (err) {
        if (alive && aliveRef.current) fail(err instanceof Error ? err.message : String(err));
      }
    })();

    timeoutRef.current = window.setTimeout(() => {
      if (readyRef.current || !aliveRef.current) return;
      setStalled(true);
    }, READY_TIMEOUT_MS);

    return () => {
      alive = false;
      aliveRef.current = false;
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 工具页 ready + 源图准备好之后发 init（两者都到了才发）
  useEffect(() => {
    if (!ready || !prepared || sentRef.current) return;
    sentRef.current = true;
    const resolved = store.state.ui.theme;
    themeSentRef.current = resolved;
    send({
      type: "init", image: prepared.image, width: prepared.width, height: prepared.height,
      mode, apiBase: location.origin, apiPath: API_PATH, title: "拆分结果", theme: resolved,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, prepared, mode]);

  // 画布主题切换：只把新主题推给工具页
  useEffect(() => {
    if (!ready || !themeSentRef.current || themeSentRef.current === theme) return;
    themeSentRef.current = theme;
    send({ type: "theme", theme });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, theme]);

  /** 保存：合成图先上传成素材，再在源图右侧建普通图片节点 + 连线（和无损改图一致） */
  async function save(d: { image?: unknown; width?: unknown; height?: unknown }) {
    if (savingRef.current) return;
    const image = typeof d.image === "string" ? d.image : "";
    if (!image.startsWith("data:image/")) { fail("编辑器没有回传有效的图片"); return; }
    const live = store.node(id);
    if (!live) { fail("源图已经不在了"); return; }
    const w = Math.round(Number(d.width) || 0);
    const h = Math.round(Number(d.height) || 0);
    savingRef.current = true;
    setSaving(true);
    try {
      const url = await store.backend.importAsset(store.state.canvasId, image, "拆分结果.png");
      if (!url) throw new Error("结果上传失败");
      const box = (w > 0 && h > 0 ? fitMediaBox(live.w, w, h) : null) || { w: live.w, h: live.h };
      const made = store.newNode("image", live.x + live.w + 80, live.y, {
        title: "拆分结果", w: box.w, h: box.h,
        hist: [w > 0 && h > 0 ? { url, w, h } : { url }],
      });
      store.addNodes([made], [{ id: uid("e"), from: live.id, to: made.id }], { select: true });
      store.toast("拆分完成，结果已放到画布上的新节点");
      setSe(null);
    } catch (err) {
      if (aliveRef.current) store.toast("拆分失败：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      savingRef.current = false;
      if (aliveRef.current) setSaving(false);
    }
  }

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { source?: string; type?: string; message?: string; image?: unknown; width?: unknown; height?: unknown } | null;
      if (!d || d.source !== TOOL_SRC) return;
      if (d.type === "ready") {
        readyRef.current = true;
        setReady(true);
        setStalled(false);
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        return;
      }
      if (d.type === "save") { void save(d); return; }
      if (d.type === "close") { close(); return; }
      if (d.type === "error") { fail(typeof d.message === "string" && d.message ? d.message : "拆分失败"); return; }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !savingRef.current) { e.preventDefault(); close(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!node) return null;

  return <div className="ie-scrim" data-split-editor="1" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !saving) setSe(null); }}>
    <div className="ie-dialog split" role="dialog" aria-modal="true" aria-label="拆分图层" style={{ width: size.w, height: size.h }}>
      <div className="ie-head">
        <button className="ib" data-split="close" data-tip="关闭" aria-label="关闭" onClick={() => { if (!saving) setSe(null); }}><Icon name="x" /></button>
        <span className="ie-title">拆分图层</span>
        <span className="ie-hint">{saving ? "正在保存…" : ready ? "拆完点编辑器里的「保存」" : stalled ? "工具加载失败，请关闭后重试" : "工具加载中…"}</span>
        <span className="ie-sp" />
      </div>
      <div className="ie-body">
        <iframe ref={frameRef} className="ie-frame" title="拆分图层" src={page}
          allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="same-origin" />
        {!ready ? <div className="ie-load"><Icon name={stalled ? "alert" : "layers"} size="s" /><span>{stalled ? "拆分工具加载失败，请关闭后重试" : "拆分工具加载中…"}</span></div> : null}
        <div className="ie-resize" role="button" aria-label="拖动调整大小" title="拖动调整大小" onPointerDown={startResize} />
      </div>
    </div>
  </div>;
}
