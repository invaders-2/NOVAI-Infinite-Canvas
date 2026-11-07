/**
 * 调色：居中对话框，中间挂 static/tools/image-adjust/index.html
 * （旧智能画布的专业调色调色引擎/面板，原样复用 static/js/image-adjust-*.js + css/image-adjust.css）。
 *
 * 分工：工具页负责渲染与全分辨率导出，宿主只做三件事 —— 传图 + 参数（init）、要结果（apply）、
 * 把结果落成「新图片节点 + adjust 参数」（带源图引用，下次从原图 + 参数继续调）。
 * 对话框外壳（.ie-scrim/.ie-dialog/.ie-head/.ie-body）与无损改图共用，见 editors.css。
 */
import { isAssetRef } from "../../../canvasAssetRefs";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CanvasNode } from "../../../react-canvas/reactCanvasStore";
import { fitMediaBox } from "../../mediaFit";
import { genOf, outOf, uid, type GenData } from "../../model";
import { useCtl, useS } from "../ctx";
import { Icon } from "../Icon";
import { MAX_UPLOAD_BYTES, compressForUpload } from "./largeUpload";

const TOOL_PAGE = "/static/tools/image-adjust/index.html";
const TOOL_SRC = "novai-image-adjust";
const HOST_SRC = "novai-image-adjust-host";
const APPLY_TIMEOUT_MS = 60000;
/** iframe 同源时锁到 location.origin；file:// 预览这类非 http(s) 只能 * */
const toolOrigin = () => (/^https?:$/.test(location.protocol) ? location.origin : "*");

type AdjustMeta = NonNullable<GenData["adjust"]>;
type ToolResult = { dataUrl: string; params: unknown; width: number; height: number };
/** 工具页 init 需要的初始状态：src 是这次要调的图，adjust 有值表示「从原图 + 参数继续」 */
type InitState = { url: string; name: string; saveUrl: string; adjust?: { params: unknown; source: { url: string; name: string } } };

type CaState = { id: string } | null;
let ca: CaState = null; const ls = new Set<() => void>();
const setCa = (v: CaState) => { ca = v; ls.forEach((l) => l()); };
const useAdjustState = () => useSyncExternalStore((l) => { ls.add(l); return () => { ls.delete(l); }; }, () => ca);

/** 工具条「调色」→ 调色对话框（cn:editor 事件进来） */
export function openColorAdjust(id: string) { setCa({ id }); }

/** 文件名 / 新节点标题都从节点标题来；空标题给兜底，避免出现「_adjust.png」这种没名字的文件 */
function nameOf(n: CanvasNode) {
  const t = String(genOf(n).title || "").trim();
  return (t || "调色").replace(/[\s\\/:*?"<>|]+/g, "_").replace(/\.[^.]+$/, "").slice(0, 60) || "调色";
}

/* ---------- 调色宿主 ---------- */
export function ColorAdjustLayer() {
  const st = useAdjustState();
  if (!st) return null;
  return <ColorAdjust key={st.id} id={st.id} />;
}

function ColorAdjust({ id }: { id: string }) {
  const ctl = useCtl(); const store = ctl.store;
  const node = useS((s) => s.doc).nodes.find((x) => x.id === id);
  const theme = useS((s) => s.ui.theme);
  // iframe 地址只在挂载时算一次：跟着 theme 重算会让 iframe 整个重载，主题改用消息同步
  const [page] = useState(() => TOOL_PAGE + "?embed=1&theme=" + encodeURIComponent(store.state.ui.theme));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [inited, setInited] = useState(false);
  const busyRef = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const queueRef = useRef<Array<Record<string, unknown>>>([]);
  const pendingRef = useRef<{ ok: (r: ToolResult) => void; fail: (e: Error) => void } | null>(null);
  const loadedRef = useRef(false);
  const sentRef = useRef(false);
  const aliveRef = useRef(true);
  const initRef = useRef<InitState | null>(null);

  // 工具页要用宿主真实 token 画窗底 / 浮层：直接读 .cn-root 上的 --panel / --raised，读不到退回主题常量
  const themeMsg = () => {
    const shell = layerRef.current?.closest(".cn-root") as HTMLElement | null;
    const cs = shell ? getComputedStyle(shell) : null;
    const pick = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback;
    const dark = store.state.ui.theme !== "light";
    /* panel = 图片区底色（宿主 --bg），raised = 右侧面板底色（宿主 --raised） */
    return { type: "theme", theme: store.state.ui.theme, panel: pick("--bg", dark ? "#000000" : "#f2f2f4"), raised: pick("--raised", dark ? "#171717" : "#ffffff") };
  };

  const send = (msg: Record<string, unknown>) => {
    const w = frameRef.current?.contentWindow;
    if (!w) return false;
    w.postMessage({ source: HOST_SRC, ...msg }, toolOrigin());
    return true;
  };
  // ready 之前消息得排队：工具还没注册监听，早发就丢了
  const post = (msg: Record<string, unknown>) => {
    if (!readyRef.current) { queueRef.current.push(msg); return true; }
    return send(msg);
  };

  const initMessage = () => {
    const s = initRef.current; if (!s) return null;
    const msg: Record<string, unknown> = { type: "init", src: { url: s.url, name: s.name } };
    if (s.adjust) msg.adjust = s.adjust;
    return msg;
  };
  /** iframe load 之后补一次：工具是先发 ready 再注册响应的，宿主早发的 init 会丢 */
  const kick = () => {
    if (!loadedRef.current || !initRef.current || sentRef.current) return;
    sentRef.current = true;
    const m = initMessage(); if (m) { post(m); setInited(true); }
  };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; pendingRef.current?.fail(new Error("已关闭调色")); pendingRef.current = null; }; }, []);
  // 焦点先收到宿主：焦点留在 iframe 里时，宿主的 keydown 收不到 Esc
  useEffect(() => { layerRef.current?.focus({ preventScroll: true }); }, []);
  // 工具页加载失败不会回消息，等 10s 仍未 ready 就把「加载中」换成失败提示（不自动关层）
  useEffect(() => {
    if (ready) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), 10000);
    return () => clearTimeout(t);
  }, [ready]);

  // 初始图 + 参数：当前结果给工具显示；节点带 adjust 时按「原图 + 参数」继续，并解析源图地址
  useEffect(() => {
    let alive = true;
    void (async () => {
      const n = store.node(id); if (!n) return;
      const resolve = async (u: string) => (isAssetRef(u) ? (await store.backend.resolveAsset(u)) || "" : u);
      const raw = outOf(n)?.url || "";
      const meta = genOf(n).adjust;
      const name = nameOf(n);
      const srcUrl = raw ? await resolve(raw) : "";
      if (meta && meta.source && meta.source.url) {
        const origUrl = await resolve(meta.source.url);
        if (!alive) return;
        initRef.current = { url: srcUrl || origUrl, name, saveUrl: meta.source.url, adjust: { params: meta.params, source: { url: origUrl, name: meta.source.name || name } } };
      } else {
        if (!alive) return;
        initRef.current = { url: srcUrl, name, saveUrl: raw };
      }
      setInited(true);
      kick();
    })();
    return () => { alive = false; };
  }, [id, store]);

  // 主题联动：store 里切深浅色，工具跟着切
  useEffect(() => { if (ready) post(themeMsg()); }, [theme, ready]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { source?: string; type?: string; message?: string; dataUrl?: string; width?: number; height?: number; params?: unknown } | null;
      if (!d || d.source !== TOOL_SRC) return;
      if (d.type === "ready") {
        readyRef.current = true; setReady(true);
        const q = queueRef.current; queueRef.current = [];
        q.forEach((m) => send(m));
        return;
      }
      if (d.type === "result") {
        pendingRef.current?.ok({ dataUrl: String(d.dataUrl || ""), params: d.params ?? null, width: Number(d.width) || 0, height: Number(d.height) || 0 });
        return;
      }
      if (d.type === "error") { pendingRef.current?.fail(new Error(d.message || "调色工具返回错误")); return; }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);

  // 编辑层开着时吃掉画布快捷键（Esc / 单键工具），输入框里照常打字
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toUpperCase();
      const typing = tag === "INPUT" || tag === "TEXTAREA" || !!t?.isContentEditable;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setCa(null); return; }
      if (!typing) e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  if (!node) { setTimeout(() => setCa(null)); return null; }

  /** 向工具要调色结果：只认本 iframe + 工具方标记的消息，60 秒没回就当失败 */
  const requestResult = () => new Promise<ToolResult>((resolve, reject) => {
    if (!frameRef.current?.contentWindow) { reject(new Error("调色面板还没准备好")); return; }
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); pendingRef.current = null; fn(); };
    const timer = setTimeout(() => settle(() => reject(new Error("工具 60 秒没有返回结果"))), APPLY_TIMEOUT_MS);
    pendingRef.current = {
      ok: (r) => settle(() => resolve(r)),
      fail: (e) => settle(() => reject(e)),
    };
    if (!post({ type: "apply" })) settle(() => reject(new Error("调色面板还没准备好")));
  });

  const apply = async () => {
    // 连点两下也只跑一次（按钮 disabled 要等下一次渲染才生效）
    if (busyRef.current) return;
    if (!initRef.current) { store.toast("调色失败：原图还没准备好"); return; }
    busyRef.current = true; setBusy(true);
    try {
      const res = await requestResult();
      if (!aliveRef.current) return;
      if (!res.dataUrl) throw new Error("工具没有回传有效的图片");
      let dataUrl = res.dataUrl;
      let name = nameOf(node) + "_adjust.png";
      const small = await compressForUpload(res.dataUrl, name, MAX_UPLOAD_BYTES);
      if (small) { dataUrl = small.dataUrl; name = small.name; store.toast("调色结果较大，已自动压缩后应用"); }
      if (!aliveRef.current) return;
      // 上传失败要出声：不能静默新建一个没有图的节点
      const url = await store.backend.importAsset(store.state.canvasId, dataUrl, name);
      if (!url) throw new Error("上传没有返回地址");
      if (!aliveRef.current) return;
      const live = store.node(id);
      if (!live) throw new Error("原节点已经不在画布上了");
      const src = initRef.current;
      const w = Math.round(Number(res.width) || 0) || live.w;
      const h = Math.round(Number(res.height) || 0) || live.h;
      const box = fitMediaBox(live.w, w, h) || { w: live.w, h: live.h };
      // 源图存 compact 的引用（novai-asset / 服务端路径），不写 data URL；再次调色从这张原图继续
      const adjust: AdjustMeta = { v: 2, source: { url: src.saveUrl, name: src.name }, params: res.params };
      const made = store.newNode("image", live.x + live.w + 80, live.y, { title: "调色", w: box.w, h: box.h, hist: [{ url, w, h }], adjust });
      store.addNodes([made], [{ id: uid("e"), from: live.id, to: made.id }], { select: true });
      store.toast("调色完成，已生成新节点");
      setCa(null);
    } catch (err) {
      // 编辑层关掉之后不再弹错（用户已经走了，报错只会让人以为画布坏了）
      if (aliveRef.current) store.toast("调色失败：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return <div className="ie-scrim" data-ca="1" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setCa(null); }}>
    <div className="ie-dialog ca" ref={layerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="调色">
      <div className="ie-head">
        <button className="ib" data-ca="close" data-tip="关闭" aria-label="关闭" onClick={() => setCa(null)}><Icon name="x" /></button>
        <span className="ie-title">调色</span>
        {!ready ? <span className="ie-hint">{stalled ? "工具加载失败" : "工具加载中…"}</span> : null}
        <span className="ie-sp" />
      </div>
      <div className="ie-body">
        <iframe ref={frameRef} className="ie-frame" title="调色" src={page}
          allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="same-origin"
          onLoad={() => { loadedRef.current = true; post(themeMsg()); kick(); }} />
        {/* 应用按钮放在右侧浮窗正下方（浮窗宽 320、右边距 12），等 init 完成后才可点 */}
        <button className="ie-apply" data-ca="apply" disabled={!ready || !inited || busy} onClick={() => void apply()}>{busy ? "正在应用…" : "应用"}</button>
        {!ready ? <div className="ie-load"><Icon name={stalled ? "alert" : "palette"} size="s" /><span>{stalled ? "调色工具加载失败，请关闭后重试" : "调色工具加载中…"}</span></div> : null}
      </div>
    </div>
  </div>;
}
