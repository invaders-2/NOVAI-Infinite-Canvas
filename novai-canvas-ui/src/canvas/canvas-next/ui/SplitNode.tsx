/**
 * 拆分图层（节点内联）：工具条新建「拆分结果」节点，结果直接在节点 body 里操作，不再开全屏弹窗。
 *
 * 流程：
 *   · 图片工具条「拆分图层」→ 自动 / 自定义 → startSplitNode() 在源图右侧建节点（1060×920，loading）；
 *   · NodeView 见到 genOf(node).split 就渲染本组件：32px 标题栏 + 内联 iframe（编辑器 inline 模式）；
 *   · iframe ready → init（源图 dataURL / 尺寸 / mode / 后端地址）；save → 节点变成普通图片节点；
 *   · 标题栏 X / 编辑器 close / error → 删除节点并把源图带回视口。
 *
 * 编辑器是独立静态页（同源），由另一位同事维护，宿主只按 postMessage 协议打交道。
 */
import { isAssetRef } from "../../canvasAssetRefs";
import { toDataUrl } from "./editors/sourceToDataUrl";
import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { fitMediaBox } from "../mediaFit";
import { genOf, isGenKind, outOf } from "../model";
import { useCtl, useS, type Ctl } from "./ctx";
import { Icon } from "./Icon";

const TOOL_PAGE = "/static/tools/split-layers/index.html";
/** 工具页要用的后端接口：同源，apiBase 用 location.origin */
const API_PATH = "/api/canvas/split";
const TOOL_SRC = "novai-split-editor";
const HOST_SRC = "novai-split-host";
/** 编辑器加载失败不会回消息：等 15s 仍未 ready 就把这个结果节点收掉 */
const READY_TIMEOUT_MS = 15000;
/** 源图长边上限：拆分层由后端处理，超过 2000 的图先缩（请求体和编辑器内存都省） */
const MAX_SIDE = 2000;
/** 结果节点尺寸：够放下 inline 编辑器（标题栏 32 + body） */
export const SPLIT_NODE_W = 1060;
export const SPLIT_NODE_H = 920;
/** 画布文档对普通节点宽高上限 800：保存后按结果比例收进这个盒子，刷新才不会把图裁掉 */
const RESULT_MAX = { w: 800, h: 800 } as const;
/** iframe 同源时锁到 location.origin；file:// 预览这类非 http(s) 只能 * */
const toolOrigin = () => (/^https?:$/.test(location.protocol) ? location.origin : "*");

export type SplitMode = "auto" | "custom";

/** 拆分中的结果节点（split 在文档里；splitPending 是上一版 pending 节点，仍按拆分节点渲染） */
export function isSplitNode(node: CanvasNode): boolean {
  if (!isGenKind(node.kind)) return false;
  const g = genOf(node);
  return !!g.split || !!g.splitPending;
}

/** 工具条「拆分图层」→ 源图右侧建结果节点（内联编辑器），选中并聚焦 */
export function startSplitNode(ctl: Ctl, sourceId: string, mode: SplitMode) {
  const store = ctl.store;
  const src = store.node(sourceId);
  if (!src || src.kind !== "image") { store.toast("找不到要拆分的图片节点"); return; }
  if (!outOf(src)?.url) { store.toast("这个节点还没有图片，先上传或生成一张再拆分"); return; }
  const made = store.newNode("image", src.x + src.w + 48, src.y, {
    title: "拆分结果", w: SPLIT_NODE_W, h: SPLIT_NODE_H,
    split: { sourceId, mode, status: "loading" },
  });
  store.addNodes([made], [], { select: true, history: true });
  ctl.focusNode(made.id);
}

export function SplitNodeBody({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store;
  // 主题跟 beat：只给 iframe 发消息，不重建节点 / iframe
  const theme = useS((s) => s.ui.theme);
  const split = genOf(node).split;
  const sourceId = split?.sourceId || "";
  const mode = split?.mode || "auto";
  // iframe 地址只在挂载时算一次：跟着 theme 重算会让 iframe 整个重载
  const [page] = useState(() => TOOL_PAGE + "?embed=1&inline=1&theme=" + encodeURIComponent(store.state.ui.theme));
  const [ready, setReady] = useState(false);
  const [prepared, setPrepared] = useState<{ image: string; width: number; height: number } | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const sentRef = useRef(false);
  const themeSentRef = useRef("");
  const aliveRef = useRef(true);
  const timeoutRef = useRef<number | null>(null);

  const send = (msg: Record<string, unknown>) => {
    const w = frameRef.current?.contentWindow;
    if (!w) return false;
    w.postMessage({ source: HOST_SRC, ...msg }, toolOrigin());
    return true;
  };

  /**
   * 窗口拖动：编辑器里的工具条 / loading 卡片只发一个起点，宿主铺一层全屏透明 overlay 接管
   * pointermove/pointerup —— 跨 iframe 的 pointer capture 不可靠，overlay 还能顺手挡住画布手势。
   */
  const dragEndRef = useRef<(() => void) | null>(null);
  function beginWinDrag(sx: number, sy: number) {
    if (!store.node(node.id)) return;
    dragEndRef.current?.();
    const start = store.node(node.id)!;
    const k = store.state.view.k || 1;
    // 拖哪个窗口就选中哪个（不改变别的节点的选中状态之外的行为）
    if (!store.state.ui.sel.has(node.id)) store.setUI({ sel: new Set([node.id]), edge: null });
    const cover = document.createElement("div");
    cover.className = "splitdrag-cover";
    cover.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:transparent;cursor:grabbing;touch-action:none";
    document.body.appendChild(cover);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!store.node(node.id)) return;
      const dx = (ev.clientX - sx) / k, dy = (ev.clientY - sy) / k;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 1) return;
      // 一次拖动只记一份历史：第一帧存快照，之后每帧只写坐标
      if (!moved) { moved = true; store.snapshot(); store.setUI({ dragging: true }); }
      store.updateNode(node.id, (n) => ({ ...n, x: Math.round(start.x + dx), y: Math.round(start.y + dy) }), { history: false });
    };
    const end = () => {
      cover.removeEventListener("pointermove", move);
      cover.removeEventListener("pointerup", end);
      cover.removeEventListener("pointercancel", end);
      cover.remove();
      if (dragEndRef.current === end) dragEndRef.current = null;
      if (moved) store.setUI({ dragging: false });
      send({ type: "win-drag-end" });
    };
    cover.addEventListener("pointermove", move);
    cover.addEventListener("pointerup", end);
    cover.addEventListener("pointercancel", end);
    dragEndRef.current = end;
  }
  useEffect(() => () => { dragEndRef.current?.(); }, []);

  /**
   * 常驻拖动把手：挂到 .cn-root（而不是节点内部）。节点在 #stage/#world 的层叠上下文里，
   * 内部 z-index 再高也压不过宿主顶部浮层 #tl（.float z-index:20）；挂到根层 40 才始终可点。
   * 位置按节点屏幕矩形每帧跟随（view/节点变化都走 store 订阅，不额外 React 重渲）。
   */
  useEffect(() => {
    if (!split) return;
    const root = document.querySelector<HTMLElement>(".cn-root");
    if (!root) return;
    const grip = document.createElement("div");
    grip.className = "splitgrip";
    grip.setAttribute("data-split-grip", "");
    grip.setAttribute("role", "button");
    grip.setAttribute("aria-label", "拖动移动窗口");
    grip.title = "拖动移动窗口";
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      beginWinDrag(ev.clientX, ev.clientY);
    };
    grip.addEventListener("pointerdown", onDown);
    root.appendChild(grip);
    let raf = 0;
    const place = () => {
      raf = 0;
      const nodeEl = document.querySelector<HTMLElement>('.node[data-id="' + CSS.escape(node.id) + '"]');
      if (!nodeEl) { grip.style.display = "none"; return; }
      const box = nodeEl.getBoundingClientRect();
      grip.style.display = "";
      grip.style.left = Math.round(box.left + 8) + "px";
      grip.style.top = Math.round(box.top + 8) + "px";
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
    place();
    const off = store.subscribe(schedule);
    addEventListener("resize", schedule);
    return () => {
      off();
      removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
      grip.removeEventListener("pointerdown", onDown);
      grip.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, node.id, store]);

  function removeNode() {
    if (!store.node(node.id)) return;
    // 临时节点不进撤销栈：撤销一次回到拆分前的画布，而不是留下一个没有编辑器的壳
    store.mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id), edges: d.edges.filter((e) => e.from !== node.id && e.to !== node.id) }), { history: false });
    store.setUI({ sel: new Set([...store.state.ui.sel].filter((x) => x !== node.id)) });
  }
  function focusSource() { if (sourceId && store.node(sourceId)) ctl.focusNode(sourceId); }
  function closeNode() { removeNode(); focusSource(); }
  function fail(message: string) {
    if (!aliveRef.current) return;
    removeNode();
    focusSource();
    store.toast("拆分图层失败：" + message);
  }

  function save(d: { image?: unknown; width?: unknown; height?: unknown }) {
    const image = typeof d.image === "string" ? d.image : "";
    const w = Math.round(Number(d.width) || 0);
    const h = Math.round(Number(d.height) || 0);
    if (!image.startsWith("data:image/")) { fail("编辑器没有回传有效的图片"); return; }
    store.patchGen(node.id, {
      title: "拆分结果", split: undefined, splitPending: false, prompt: "",
      hist: [w > 0 && h > 0 ? { url: image, w, h } : { url: image }], hi: 0,
    });
    // inline 节点比普通图大；文档上限 800，保存时按结果比例收进盒子，刷新后不会被裁
    const box = w > 0 && h > 0 ? fitMediaBox(RESULT_MAX.w, w, h, RESULT_MAX) : null;
    if (box) store.updateNode(node.id, (n) => ({ ...n, w: box.w, h: box.h }));
    // 让结果节点占满可见区域并保持选中（上一版全屏保存后的行为）
    ctl.focusNode(node.id);
    store.toast("已保存为图片节点");
  }

  // 透明合成：老浏览器 / 某些嵌入环境仍看 allowtransparency，现代浏览器靠 iframe 与文档自身背景透明
  useEffect(() => { frameRef.current?.setAttribute("allowtransparency", "true"); }, []);

  /* 挂载：解析源图并压成 dataURL，等 iframe ready 再发 init */
  useEffect(() => {
    aliveRef.current = true;
    if (!split) return;
    const src = store.node(sourceId);
    const raw = sourceId && src ? outOf(src)?.url || "" : "";
    if (!raw) { fail("源图已经不在了"); return; }

    let alive = true;
    void (async () => {
      try {
        // 工具页是普通 iframe：novai-asset: 得先解析成它能 fetch 的地址；再压到长边 ≤2000 的 dataURL
        const url = isAssetRef(raw) ? (await store.backend.resolveAsset(raw)) || "" : raw;
        if (!url) throw new Error("源图地址解析失败");
        const prep = await toDataUrl(url, MAX_SIDE);
        if (!alive || !aliveRef.current) return;
        setPrepared(prep);
      } catch (err) {
        if (alive && aliveRef.current) fail(err instanceof Error ? err.message : String(err));
      }
    })();

    timeoutRef.current = window.setTimeout(() => {
      if (readyRef.current || !aliveRef.current) return;
      fail("编辑器加载失败，请重试");
    }, READY_TIMEOUT_MS);

    return () => {
      alive = false; aliveRef.current = false;
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, sourceId, !!split]);

  // 工具页 ready 之后才发 init；源图还没准备好就等它（两者都到了再发一次）
  useEffect(() => {
    if (!ready || !prepared || sentRef.current) return;
    sentRef.current = true;
    const root = document.querySelector<HTMLElement>(".cn-root");
    const resolved = root?.dataset.theme === "light" || root?.dataset.theme === "dark" ? root.dataset.theme : store.state.ui.theme;
    themeSentRef.current = resolved;
    send({
      type: "init", image: prepared.image, width: prepared.width, height: prepared.height,
      mode, apiBase: location.origin, apiPath: API_PATH, title: "拆分结果",
      theme: resolved,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, prepared, mode, theme]);

  // 画布主题切换（含跟随外壳变化）：ready 之后只把新主题推给工具页；iframe 自己真透明，不再复刻画布底色
  useEffect(() => {
    if (!ready || !themeSentRef.current || themeSentRef.current === theme) return;
    themeSentRef.current = theme;
    send({ type: "theme", theme });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, theme]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { source?: string; type?: string; message?: string; image?: unknown; width?: unknown; height?: unknown } | null;
      if (!d || d.source !== TOOL_SRC) return;
      if (d.type === "ready") {
        readyRef.current = true; setReady(true);
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        return;
      }
      if (d.type === "save") { save(d); return; }
      if (d.type === "close") { closeNode(); return; }
      if (d.type === "win-drag-start") {
        const x = Number((d as { x?: unknown }).x), y = Number((d as { y?: unknown }).y);
        // 编辑器给的是 iframe 内坐标：换到宿主视口坐标，否则拖动位移会差一个 iframe 偏移
        const box = frameRef.current?.getBoundingClientRect();
        if (Number.isFinite(x) && Number.isFinite(y)) beginWinDrag(x + (box?.left || 0), y + (box?.top || 0));
        return;
      }
      if (d.type === "error") fail(typeof d.message === "string" && d.message ? d.message : "拆分失败");
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, sourceId]);

  return <div className="nbody splitbody" style={{ height: node.h }}>
    {split
      ? <>
        <iframe ref={frameRef} className="splitframe" title="拆分图层" src={page} style={{ backgroundColor: "transparent" }}
          allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="same-origin" />
        {/* 编辑器还没 ready：这张小玻璃卡片自己也能拖窗口（ready 之后由编辑器里的工具条 / loading 卡片接管） */}
        {!ready ? <div className="splitload" title="拖动移动窗口" onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); beginWinDrag(e.clientX, e.clientY); }}><Icon name="layers" size="s" /><span>拆分编辑器加载中…</span></div> : null}
      </>
      : <div className="splitmiss">拆分信息缺失，请重新拆分</div>}
  </div>;
}

