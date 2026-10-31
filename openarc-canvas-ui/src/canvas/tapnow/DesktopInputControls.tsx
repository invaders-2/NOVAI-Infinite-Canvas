import { useEffect, useRef, useState } from "react";
import { addFiles } from "../canvas-next/actions";
import type { Ctl } from "../canvas-next/ui/ctx";
import { Icon } from "../canvas-next/ui/Icon";
import { ModalHead, closeModal, openModal, openPop } from "../canvas-next/ui/overlay";
import type { AgentState } from "../canvas-next/agent/state";

type Cmd = (req: Record<string, unknown>) => Promise<Record<string, any>>;
type Source = { id: string; name: string; kind: string; thumbnail: string };
type FolderFile = { id: string; name: string; relative: string; mime: string; size: number };
const command = (): Cmd | null => (window as unknown as { openarc?: { canvas?: { command?: Cmd } } }).openarc?.canvas?.command || null;

async function importData(ctl: Ctl, a: AgentState, dataUrl: string, name: string, mime: string) {
  const blob = await (await fetch(dataUrl)).blob();
  await addFiles(ctl.store, [new File([blob], name, { type: mime || blob.type })], ctl.center());
  [...ctl.store.state.ui.sel].forEach((id) => { if (!a.pinned.includes(id)) a.pinned.push(id); }); a.emit();
}

export function FolderButton({ ctl, a }: { ctl: Ctl; a: AgentState }) {
  const [name, setName] = useState("");
  if (ctl.host.features?.desktopInputs === false) return null;
  useEffect(() => { const cmd = command(); if (!cmd) return; void cmd({ type: "canvas/folder/grants" }).then((r) => { if (r.grants?.[0]) setName(r.grants[0].name); }).catch(() => undefined); }, []);
  const files = (grantId: string) => {
    openModal(() => <FolderFiles ctl={ctl} a={a} grantId={grantId} onName={setName} />);
  };
  return <button className={"ib" + (name ? " on" : "")} id="aFolder" aria-label={name ? "已选目录：" + name : "选择本地文件夹"} title={name || "选择本地文件夹"} onClick={(e) => openPop(e.currentTarget, (close) => <FolderMenu ctl={ctl} a={a} close={close} onChoose={files} onName={setName} />, "up")}><Icon name="folder" size="s" /></button>;
}

function FolderMenu({ ctl, a, close, onChoose, onName }: { ctl: Ctl; a: AgentState; close: () => void; onChoose: (id: string) => void; onName: (name: string) => void }) {
  const [grants, setGrants] = useState<Array<{ id: string; name: string }>>([]);
  const load = () => { const cmd = command(); if (!cmd) return; void cmd({ type: "canvas/folder/grants" }).then((r) => setGrants(r.grants || [])); };
  useEffect(load, []);
  return <>
    <button className="mi" onClick={async () => { const cmd = command(); if (!cmd) return ctl.store.toast("本地文件夹只在桌面版可用"); const r = await cmd({ type: "canvas/folder/choose" }); if (r.ok) { onName(r.grant.name); close(); onChoose(r.grant.id); } else if (r.error !== "CANCELLED") ctl.store.toast("授权失败：" + r.error); }}><Icon name="folder" size="s" />添加本地文件夹并记住授权</button>
    {grants.map((g) => <div className="folder-grant" key={g.id}><button className="mi" onClick={() => { close(); onName(g.name); onChoose(g.id); }}><Icon name="folder" size="s" />{g.name}</button><button className="ib" aria-label={"撤销 " + g.name} onClick={async () => { await command()?.({ type: "canvas/folder/remove", grantId: g.id }); onName(""); load(); }}><Icon name="x" size="xs" /></button></div>)}
  </>;
}

function FolderFiles({ ctl, a, grantId, onName }: { ctl: Ctl; a: AgentState; grantId: string; onName: (name: string) => void }) {
  const [files, setFiles] = useState<FolderFile[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  useEffect(() => { void command()?.({ type: "canvas/folder/files", grantId }).then((r) => { if (r.ok) { setFiles(r.files || []); onName(r.grant.name); } else setError(r.error || "读取失败"); }); }, [grantId]);
  return <><ModalHead title="本地文件夹" icon="folder" /><div className="mbd folder-files">{files.map((file) => <button className="mi" key={file.id} disabled={!!busy} onClick={async () => { setBusy(file.id); const r = await command()?.({ type: "canvas/folder/read", grantId, file: file.relative }); setBusy(""); if (r?.ok) { await importData(ctl, a, r.dataUrl, r.name, r.mime); closeModal(); } else setError(r?.error || "读取失败"); }}><Icon name={file.mime.startsWith("video") ? "video" : file.mime.startsWith("audio") ? "audio" : "image"} size="s" /><span>{file.name}<span className="d">{file.relative} · {Math.ceil(file.size / 1024)} KB{busy === file.id ? " · 读取中…" : ""}</span></span></button>)}{!files.length && !error ? <div className="row"><span>这个文件夹没有支持的媒体文件</span></div> : null}{error ? <div className="gp-warn"><Icon name="alert" size="s" />{error}</div> : null}</div></>;
}

export function CaptureButton({ ctl, a }: { ctl: Ctl; a: AgentState }) {
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null); const stream = useRef<MediaStream | null>(null); const chunks = useRef<Blob[]>([]);
  useEffect(() => () => { recorder.current?.state === "recording" && recorder.current.stop(); stream.current?.getTracks().forEach((t) => t.stop()); }, []);
  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); setRecording(false); };
  if (ctl.host.features?.desktopInputs === false) return null;
  return <>
    <button className={"ib" + (recording ? " on rec" : "")} id="aCapture" aria-label={recording ? "停止录屏" : "截图与录屏"} onClick={(e) => recording ? stop() : openPop(e.currentTarget, (close) => <>
      <button className="mi" onClick={() => { close(); captureSource(ctl, a, "screenshot"); }}><Icon name="camera" size="s" />截图</button>
      <button className="mi" onClick={() => { close(); captureSource(ctl, a, "recording", recorder, stream, chunks, setRecording); }}><Icon name="video" size="s" />录屏</button>
    </>, "up")}><Icon name={recording ? "rect" : "camera"} size="s" /></button>
    {recording ? <span className="capture-live">录屏中</span> : null}
  </>;
}

function captureSource(ctl: Ctl, a: AgentState, mode: "screenshot" | "recording", recorder?: React.MutableRefObject<MediaRecorder | null>, stream?: React.MutableRefObject<MediaStream | null>, chunks?: React.MutableRefObject<Blob[]>, setRecording?: (v: boolean) => void) {
  const cmd = command(); if (!cmd) return ctl.store.toast("截图与录屏只在桌面版可用");
  openModal(() => <CaptureSources ctl={ctl} a={a} mode={mode} recorder={recorder} stream={stream} chunks={chunks} setRecording={setRecording} />);
}

function CaptureSources({ ctl, a, mode, recorder, stream, chunks, setRecording }: { ctl: Ctl; a: AgentState; mode: "screenshot" | "recording"; recorder?: React.MutableRefObject<MediaRecorder | null>; stream?: React.MutableRefObject<MediaStream | null>; chunks?: React.MutableRefObject<Blob[]>; setRecording?: (v: boolean) => void }) {
  const [sources, setSources] = useState<Source[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  useEffect(() => { void command()?.({ type: "canvas/capture/sources" }).then((r) => r.ok ? setSources(r.sources || []) : setError(r.error || "无法读取采集源")); }, []);
  const startRecording = async (source: Source) => {
    const selected = await command()?.({ type: "canvas/capture/selectRecording", sourceId: source.id });
    if (!selected?.ok) throw new Error(selected?.error || "无法选择录屏来源");
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream!.current = media; chunks!.current = [];
    const rec = new MediaRecorder(media, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm" });
    recorder!.current = rec;
    rec.ondataavailable = (e) => { if (e.data.size) chunks!.current.push(e.data); };
    rec.onstop = async () => { media.getTracks().forEach((t) => t.stop()); await command()?.({ type: "canvas/capture/stopRecording" }); const blob = new Blob(chunks!.current, { type: "video/webm" }); if (blob.size) await importData(ctl, a, URL.createObjectURL(blob), "画布录屏-" + Date.now() + ".webm", "video/webm"); };
    media.getVideoTracks()[0]?.addEventListener("ended", () => { if (rec.state === "recording") rec.stop(); setRecording?.(false); });
    rec.start(500); setRecording?.(true);
  };
  return <><ModalHead title={mode === "screenshot" ? "选择截图来源" : "选择录屏来源"} icon="camera" /><div className="mbd capture-sources">{sources.map((source) => <button className="capture-source" key={source.id} disabled={!!busy} onClick={async () => { setBusy(source.id); setError(""); try { if (mode === "recording") await startRecording(source); else { const r = await command()?.({ type: "canvas/capture/screenshot", sourceId: source.id }); if (!r?.ok) throw new Error(r?.error || "截图失败"); await importData(ctl, a, r.dataUrl, r.name, r.mime); } closeModal(); } catch (err) { setError(err instanceof Error ? err.message : "采集失败"); } finally { setBusy(""); } }}><img src={source.thumbnail} alt="" /><span>{source.name}<small>{source.kind === "screen" ? "屏幕" : "窗口"}{busy === source.id ? " · 处理中…" : ""}</small></span></button>)}{!sources.length && !error ? <div className="row"><span>正在读取屏幕与窗口…</span></div> : null}{error ? <div className="gp-warn"><Icon name="alert" size="s" />{error}</div> : null}</div></>;
}
