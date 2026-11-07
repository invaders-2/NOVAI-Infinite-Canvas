/**
 * 无损改图：居中对话框，中间挂旧智能画布的内置工具 static/tools/lossless-edit/index.html。
 *
 * 工具页的 postMessage 协议写死在工具里，宿主只能照着它说；图片一律不走 URL 参数
 * （合成图是 data URL，塞进 query 会超长），改成 ready 之后用 prefill / pick-result 传。
 * 结果按旧画布的行为落成「新图片节点 + 连线」，原节点不动。
 * 对话框外壳（.ie-scrim/.ie-dialog/.ie-head/.ie-body）与调色共用，见 editors.css。
 */
import { isAssetRef } from "../../../canvasAssetRefs";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CanvasNode } from "../../../react-canvas/reactCanvasStore";
import { fitMediaBox } from "../../mediaFit";
import { genOf, inputsOf, outOf, uid } from "../../model";
import { useCtl, useS } from "../ctx";
import { Icon } from "../Icon";
import { useAssetUrl } from "../useAsset";
import { previewThumbUrl } from "../../table";
import { MAX_UPLOAD_BYTES, compressForUpload, dataUrlToBlob } from "./largeUpload";

const TOOL_PAGE = "/static/tools/lossless-edit/index.html";
/** iframe 与预热共用这一串 query：两边拼出同一个地址，预热才打得中缓存 */
const TOOL_QUERY = "?embed=1&beat=1&theme=";
const toolPageOf = (theme: string) => TOOL_PAGE + TOOL_QUERY + encodeURIComponent(theme);
/** 选择器格子只有 ~120px 宽：384 档缩略图（3× 余量）就够，16 张原图是 768MB 位图 */
const PICK_THUMB_W = 384;
let toolWarmed = false;
/**
 * 画布空闲时预热工具页：它是 939KB 的单文件（gzip 213KB），首次点「无损改图」要下载 + 解析。
 * 这里只按真实请求地址抓一次进 HTTP 缓存，点开时省掉下载；解析仍由 iframe 自己做。
 * 不用隐藏 iframe 预热：那会多一个工具实例，双实例会抢同一套 postMessage。
 */
export function warmLosslessTool(theme: string): void {
  if (toolWarmed || typeof document === "undefined") return;
  toolWarmed = true;
  const run = () => { void fetch(toolPageOf(theme), { credentials: "same-origin" }).catch(() => undefined); };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4000 }); else setTimeout(run, 1500);
}
const TOOL_SRC = "novai-lossless-edit";
const HOST_SRC = "novai-lossless-edit-host";
const APPLY_TIMEOUT_MS = 30000;
/** iframe 同源时锁到 location.origin；file:// 预览这类非 http(s) 只能 * */
const toolOrigin = () => (/^https?:$/.test(location.protocol) ? location.origin : "*");
const SLOT_LABEL = { orig: "原图", ai: "修改图" } as const;
type Slot = keyof typeof SLOT_LABEL;
type ToolResult = { dataUrl: string; width: number; height: number };

type LeState = { id: string } | null;
let le: LeState = null; const ls = new Set<() => void>();
const setLe = (v: LeState) => { le = v; ls.forEach((l) => l()); };
const useLosslessState = () => useSyncExternalStore((l) => { ls.add(l); return () => { ls.delete(l); }; }, () => le);

/** 工具条「无损改图」→ 编辑对话框（cn:editor 事件进来） */
export function openLosslessEdit(id: string) { setLe({ id }); }

/** 文件名 / 新节点标题都从节点标题来，空标题给个兜底，避免出现「_lossless.png」这种没名字的文件 */
function nameOf(n: CanvasNode) {
  const t = String(genOf(n).title || "").trim();
  return (t || "无损改图").replace(/[\s\\/:*?"<>|]+/g, "_").replace(/\.[^.]+$/, "").slice(0, 60) || "无损改图";
}

/* ---------- 编辑层 ---------- */
export function LosslessEditLayer() {
  const st = useLosslessState();
  if (!st) return null;
  return <LosslessEdit key={st.id} id={st.id} />;
}

function LosslessEdit({ id }: { id: string }) {
  const ctl = useCtl(); const store = ctl.store;
  const node = useS((s) => s.doc).nodes.find((x) => x.id === id);
  const theme = useS((s) => s.ui.theme);
  // iframe 地址只在挂载时算一次：跟着 theme 重算会让 iframe 整个重载，主题改用消息同步
  const [page] = useState(() => TOOL_PAGE + TOOL_QUERY + encodeURIComponent(store.state.ui.theme));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pick, setPickState] = useState<Slot | null>(null);
  const busyRef = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const queueRef = useRef<Array<Record<string, unknown>>>([]);
  const pendingRef = useRef<{ ok: (r: ToolResult) => void; fail: (e: Error) => void } | null>(null);
  const loadedRef = useRef(false);
  const sentRef = useRef(false);
  const aliveRef = useRef(true);
  const pickRef = useRef<Slot | null>(null);
  // 预填的两张图：解析好（novai-asset → 可 fetch 地址）之后才发
  const srcRef = useRef<{ orig: string; ai: string } | null>(null);
  const [srcReady, setSrcReady] = useState(false);
  const [stalled, setStalled] = useState(false);

  const setPick = (v: Slot | null) => { pickRef.current = v; setPickState(v); };

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

  const prefill = () => {
    const s = srcRef.current; if (!s) return;
    const msg: Record<string, unknown> = { type: "prefill", reset: true };
    if (s.orig) msg.orig = s.orig;
    if (s.ai) msg.ai = s.ai;
    post(msg);
  };
  /** iframe load 之后补一次：工具是先发 ready 再注册响应的，宿主早发的 prefill 会丢 */
  const kick = () => {
    if (!loadedRef.current || !srcRef.current || sentRef.current) return;
    sentRef.current = true;
    prefill();
  };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; pendingRef.current?.fail(new Error("已关闭无损改图")); pendingRef.current = null; }; }, []);

  // 层一打开就把焦点收回宿主：焦点在 iframe 里时，宿主的 keydown 收不到（同源 iframe 的按键也不冒泡上来）
  useEffect(() => { layerRef.current?.focus({ preventScroll: true }); }, []);
  // 选择器关掉（取消 / 遮罩 / 选中）后焦点回到层，Esc 才能接着关层
  useEffect(() => { if (!pick) layerRef.current?.focus({ preventScroll: true }); }, [pick]);
  // 工具页加载失败不会回消息，等 10s 仍未 ready 就把「加载中」换成失败提示（不自动关层，交用户决定）
  useEffect(() => {
    if (ready) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), 10000);
    return () => clearTimeout(t);
  }, [ready]);

  // 预填：ai = 本节点当前结果；只有一条来自图片节点的入边时才带 orig，其余留空让用户在工具里自己选
  useEffect(() => {
    let alive = true;
    void (async () => {
      const n = store.node(id); if (!n) return;
      const aiRaw = outOf(n)?.url || "";
      const ins = inputsOf(store.state.doc, id);
      const origRaw = ins.length === 1 && ins[0].node.kind === "image" ? outOf(ins[0].node)?.url || "" : "";
      const resolve = async (u: string) => (isAssetRef(u) ? (await store.backend.resolveAsset(u)) || "" : u);
      const [ai, orig] = await Promise.all([resolve(aiRaw), resolve(origRaw)]);
      if (!alive) return;
      srcRef.current = { orig, ai };
      setSrcReady(true);
    })();
    return () => { alive = false; };
  }, [id, store]);

  useEffect(() => { kick(); }, [srcReady]);
  // 主题联动：store 里切深浅色，工具跟着切
  useEffect(() => { if (ready) post(themeMsg()); }, [theme, ready]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { source?: string; type?: string; slot?: string; message?: string; dataUrl?: string; width?: number; height?: number } | null;
      if (!d || d.source !== TOOL_SRC) return;
      if (d.type === "ready") {
        readyRef.current = true; setReady(true);
        const q = queueRef.current; queueRef.current = [];
        q.forEach((m) => send(m));
        return;
      }
      if (d.type === "result") {
        pendingRef.current?.ok({ dataUrl: String(d.dataUrl || ""), width: Number(d.width) || 0, height: Number(d.height) || 0 });
        return;
      }
      if (d.type === "error") { pendingRef.current?.fail(new Error(d.message || "工具返回错误")); return; }
      // 工具里点素材槽：宿主出选择器，选完用 pick-result 回传
      if (d.type === "pick-request") { setPick(d.slot === "ai" ? "ai" : "orig"); return; }
      // theme-changed：工具里自己切了深浅色，宿主不反写（画布下次切主题会覆盖）
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
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (pickRef.current) { setPick(null); return; }
        setLe(null);
        return;
      }
      if (!typing) e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  if (!node) { setTimeout(() => setLe(null)); return null; }

  /** 向工具要合成结果：只认本 iframe + 工具方标记的消息，30 秒没回就当失败 */
  const requestResult = () => new Promise<ToolResult>((resolve, reject) => {
    if (!frameRef.current?.contentWindow) { reject(new Error("无损改图面板还没准备好")); return; }
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); pendingRef.current = null; fn(); };
    const timer = setTimeout(() => settle(() => reject(new Error("工具 30 秒没有返回结果"))), APPLY_TIMEOUT_MS);
    pendingRef.current = {
      ok: (r) => settle(() => resolve(r)),
      fail: (e) => settle(() => reject(e)),
    };
    if (!post({ type: "request-result" })) settle(() => reject(new Error("无损改图面板还没准备好")));
  });

  const apply = async () => {
    // 连点两下也只跑一次（按钮 disabled 要等下一次渲染才生效）
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const res = await requestResult();
      if (!aliveRef.current) return;
      if (!res.dataUrl) throw new Error("工具没有回传有效的图片");
      let dataUrl = res.dataUrl;
      let name = nameOf(node) + "_lossless.png";
      const blob = dataUrlToBlob(res.dataUrl);
      if (!blob) throw new Error("工具回传的图片无法解析");
      if (blob.size > MAX_UPLOAD_BYTES) {
        const small = await compressForUpload(res.dataUrl, name, MAX_UPLOAD_BYTES);
        if (small) {
          dataUrl = small.dataUrl;
          name = small.name;
          store.toast("原图较大，已自动压缩后应用");
        }
      }
      if (!aliveRef.current) return;
      // 上传失败要出声：不能静默新建一个没有图的节点
      const url = await store.backend.importAsset(store.state.canvasId, dataUrl, name);
      if (!url) throw new Error("上传没有返回地址");
      if (!aliveRef.current) return;
      const live = store.node(id);
      if (!live) throw new Error("原节点已经不在画布上了");
      const w = Math.round(Number(res.width) || 0) || live.w;
      const h = Math.round(Number(res.height) || 0) || live.h;
      const box = fitMediaBox(live.w, w, h) || { w: live.w, h: live.h };
      const made = store.newNode("image", live.x + live.w + 80, live.y, { title: "无损改图", w: box.w, h: box.h, hist: [{ url, w, h }] });
      store.addNodes([made], [{ id: uid("e"), from: live.id, to: made.id }], { select: true });
      store.toast("无损改图完成，结果已放到画布上的新节点");
      setLe(null);
    } catch (err) {
      // 编辑层关掉之后不再弹错（用户已经走了，报错只会让人以为画布坏了）
      if (aliveRef.current) store.toast("无损改图失败：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return <div className="ie-scrim" data-le="1" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setLe(null); }}>
    <div className="ie-dialog le" ref={layerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="无损改图">
      <div className="ie-head">
        <button className="ib" data-le="close" data-tip="关闭" aria-label="关闭" onClick={() => setLe(null)}><Icon name="x" /></button>
        <span className="ie-title">无损改图</span>
        {!ready ? <span className="ie-hint">{stalled ? "工具加载失败" : "工具加载中…"}</span> : null}
        <span className="ie-sp" />
      </div>
      <div className="ie-body">
        <iframe ref={frameRef} className="ie-frame" title="无损改图" src={page}
          allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="same-origin"
          onLoad={() => { loadedRef.current = true; post(themeMsg()); kick(); }} />
        {/* 应用按钮放在右侧浮窗正下方（浮窗宽 322、右边距 12），点完由 apply() 落节点后自动关窗 */}
        <button className="ie-apply" data-le="apply" disabled={!ready || busy} onClick={() => void apply()}>{busy ? "正在应用…" : "应用"}</button>
        {!ready ? <div className="ie-load"><Icon name={stalled ? "alert" : "layers"} size="s" /><span>{stalled ? "工具加载失败，请关闭后重试" : "无损改图工具加载中…"}</span></div> : null}
        {pick ? <LosslessPick slot={pick} onClose={() => { post({ type: "pick-cancel", slot: pick }); setPick(null); }}
          onPick={(url, name) => { post({ type: "pick-result", slot: pick, url, name }); setPick(null); }} /> : null}
      </div>
    </div>
  </div>;
}

/* ---------- 素材槽选择器：工具里点「选择画布图片」时浮在 iframe 之上 ---------- */
function LosslessPick({ slot, onClose, onPick }: { slot: Slot; onClose: () => void; onPick: (url: string, name: string) => void }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 选择器一开就把焦点抢到面板：不然焦点还在 iframe 里，Esc 根本到不了宿主
  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, []);
  const items = doc.nodes.filter((n) => n.kind === "image" && !!outOf(n)?.url);
  const kw = q.trim().toLowerCase();
  const list = kw ? items.filter((n) => titleOf(n).toLowerCase().includes(kw)) : items;

  /** 工具页是普通 iframe：novai-asset: 得先解析成它能 fetch 的地址 */
  const forFrame = async (u: string) => (isAssetRef(u) ? (await store.backend.resolveAsset(u)) || "" : u);

  const choose = async (n: CanvasNode) => {
    if (busy) return;
    const raw = outOf(n)?.url || ""; if (!raw) return;
    setBusy(true);
    try {
      const url = await forFrame(raw);
      if (!url) throw new Error("这张图读不出来，换一张试试");
      onPick(url, titleOf(n) + ".png");
    } catch (err) {
      store.toast("读取图片失败：" + (err instanceof Error ? err.message : String(err)));
    } finally { setBusy(false); }
  };

  const upload = async (file: File) => {
    if (busy) return;
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(new Error("读取文件失败"));
        fr.readAsDataURL(file);
      });
      const ref = await store.backend.importAsset(store.state.canvasId, dataUrl, file.name || "图片.png");
      if (!ref) throw new Error("上传没有返回地址");
      const url = await forFrame(ref);
      if (!url) throw new Error("上传后的地址读不出来");
      onPick(url, file.name || "图片.png");
    } catch (err) {
      store.toast("上传失败：" + (err instanceof Error ? err.message : String(err)));
    } finally { setBusy(false); }
  };

  return <div className="le-pick" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
    <div className="le-pick-panel" role="dialog" ref={panelRef} tabIndex={-1} aria-label={"选择画布图片 · " + SLOT_LABEL[slot]}>
      <div className="le-pick-head">
        <span className="le-pick-title">选择画布图片 · {SLOT_LABEL[slot]}</span>
        <span className="le-sp" />
        <input className="le-pick-search" type="search" value={q} placeholder="搜索节点标题" aria-label="搜索画布图片" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="le-pick-list">
        {list.length
          ? <div className="le-pick-grid">{list.map((n) => <PickCell key={n.id} node={n} onPick={(x) => void choose(x)} />)}</div>
          : <div className="le-pick-empty">{items.length ? "没有匹配的图片" : "画布上还没有带图的节点"}</div>}
      </div>
      <div className="le-pick-foot">
        <button className="btn" data-le="pick-upload" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="upload" size="s" />上传本地图片</button>
        <button className="btn" data-le="pick-cancel" onClick={onClose}>取消</button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
    </div>
  </div>;
}

const titleOf = (n: CanvasNode) => String(genOf(n).title || "").trim() || "图片";

function PickCell({ node, onPick }: { node: CanvasNode; onPick: (n: CanvasNode) => void }) {
  // full 是原图地址（点选后交给工具页的也是它，见 choose()）；格子这里只显示缩略图
  const full = useAssetUrl(outOf(node)?.url || "");
  const [step, setStep] = useState(0);
  const label = titleOf(node);
  const thumb = previewThumbUrl(full, PICK_THUMB_W);
  const src = step === 0 ? thumb : full;
  return <button className="le-pick-item" data-node={node.id} title={label} onClick={() => onPick(node)}>
    {full && step <= 1 ? <img src={src} alt="" draggable={false} loading="lazy" decoding="async"
      onError={() => setStep((s) => (s === 0 && thumb !== full ? 1 : 2))} /> : null}
    <span className="le-pick-name">{label}</span>
  </button>;
}
