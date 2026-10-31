import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasApp } from "./canvas/canvas-next/CanvasApp";
import type { HostActions } from "./canvas/canvas-next/ui/ctx";
import { createNovaiBackend } from "./novaiBackend";
import { installNovaiBridge } from "./novaiBridge";
import "./styles.css";

installNovaiBridge();

const params = new URLSearchParams(location.search);
const canvasId = params.get("id") || params.get("canvas") || "";

function navigate(route: string) {
  if (window.parent && window.parent !== window) window.parent.postMessage({ type: "navigate", route }, location.origin);
  else location.href = "/static/index.html";
}

function backToList() {
  const project = params.get("project") || "default";
  if (window.parent && window.parent !== window) window.parent.postMessage({ type: "navigate", route: "canvas" }, location.origin);
  location.href = `/static/canvas-list.html?project=${encodeURIComponent(project)}`;
}

function syncTheme(theme?: string) {
  const dark = theme ? theme === "dark" : (() => { try { return localStorage.getItem("studio_theme") === "dark"; } catch { return false; } })();
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("theme-dark", dark);
}

function NovaiCanvas() {
  const backend = useMemo(() => createNovaiBackend(), []);
  const [name, setName] = useState("画布");
  useEffect(() => {
    syncTheme();
    const onTheme = (event: MessageEvent) => { if (event.data?.type === "studio-theme") syncTheme(event.data.theme); };
    window.addEventListener("message", onTheme);
    return () => window.removeEventListener("message", onTheme);
  }, []);
  useEffect(() => {
    let alive = true;
    void fetch(`/api/canvases/${encodeURIComponent(canvasId)}`).then((response) => response.ok ? response.json() : null).then((data) => {
      if (alive && data?.canvas?.title) setName(String(data.canvas.title));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const host = useMemo<HostActions>(() => ({
    backToList,
    openModelSettings: () => navigate("api-settings"),
    openMcpCenter: () => { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "open-settings", tab: "mcp" }, location.origin); },
    openApp: (id) => { if (id === "skills") navigate("store"); },
    features: { collab: false, share: false, organization: false, desktopInputs: false, elements: false, teamAssets: false },
    openCanvas: (id) => { location.href = `/static/canvas.html?id=${encodeURIComponent(id)}`; },
    listCanvases: async () => {
      const response = await fetch("/api/canvases");
      if (!response.ok) return [];
      const data = await response.json();
      return (data.canvases || []).filter((canvas: any) => (canvas.kind || "classic") === "classic").map((canvas: any) => ({ id: String(canvas.id), name: String(canvas.title || "未命名画布"), nodes: Number(canvas.node_count) || undefined }));
    },
    user: { name: "本机用户", initial: "我" },
    badge: "智能画布BEAT",
  }), []);
  return <CanvasApp backend={backend} canvasId={canvasId} name={name} host={host} onReady={(store) => { (window as any).__cn = store; }} />;
}

syncTheme();
const root = document.getElementById("root")!;
if (canvasId) createRoot(root).render(<NovaiCanvas />);
else createRoot(root).render(<div className="novai-canvas-error"><h2>没有指定要打开的画布</h2><button onClick={backToList}>返回画布列表</button></div>);
