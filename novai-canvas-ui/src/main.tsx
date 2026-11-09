import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasApp } from "./canvas/canvas-next/CanvasApp";
import type { HostActions } from "./canvas/canvas-next/ui/ctx";
import { consumeHomeSeed, type AgentDraft } from "./canvas/canvas-next/homeSeed";
import { applyShellTheme, shellDark } from "./canvas/canvas-next/ui/theme";
import { SharePage } from "./canvas/canvas-next/ui/ShareView";
import { createNovaiBackend } from "./novaiBackend";
import { installNovaiBridge } from "./novaiBridge";
import "streamdown/styles.css";
import "./hexta.css";
import "./styles.css";
import "./canvas/canvas-next/ui/focus-ring.css";

installNovaiBridge();

/** 输入模态：指针（鼠标/触摸）聚焦不画焦点框，键盘聚焦保留可见焦点；规则在 ui/focus-ring.css */
const markInputMode = (mode: "pointer" | "keyboard") => {
  if (mode === "pointer") document.documentElement.dataset.input = "pointer";
  else delete document.documentElement.dataset.input;
};
addEventListener("pointerdown", () => markInputMode("pointer"), true);
addEventListener("keydown", () => markInputMode("keyboard"), true);
/** 画布是软件里的子页面：只跟随软件主题，不保留自己的深浅色偏好 */
(window as unknown as Record<string, unknown>).__novaiCanvasHost = { followTheme: true };

const params = new URLSearchParams(location.search);
const canvasId = params.get("id") || params.get("canvas") || "";
const shareToken = params.get("share") || "";

function navigate(route: string) {
  if (window.parent && window.parent !== window) window.parent.postMessage({ type: "navigate", route }, location.origin);
  else location.href = "/static/index.html";
}

function backToList() {
  const project = params.get("project") || "default";
  if (window.parent && window.parent !== window) window.parent.postMessage({ type: "navigate", route: "canvas" }, location.origin);
  location.href = `/static/canvas-list.html?project=${encodeURIComponent(project)}`;
}

/** 新建画布：和画布列表的「新建」同一个接口，标题带时间方便在列表里分辨；失败抛给画布菜单 toast */
async function createCanvas() {
  const project = params.get("project") || "default";
  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const response = await fetch("/api/canvases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `智能画布BEAT ${time}`, icon: "🧩", kind: "classic", project, board_x: 40, board_y: 40 }),
  });
  if (!response.ok) throw new Error(`新建画布失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => null);
  const id = String(data?.canvas?.id || data?.id || "");
  if (!id) throw new Error("新建画布没有返回画布 ID");
  location.href = `/static/canvas.html?id=${encodeURIComponent(id)}&project=${encodeURIComponent(project)}`;
}

function storedTheme(): "dark" | "light" {
  try { return (localStorage.getItem("studio_theme") || localStorage.getItem("canvas_theme")) === "dark" ? "dark" : "light"; } catch { return "light"; }
}

/**
 * 外壳主题同步：class 三个外壳各认一套（旧外壳认 theme-dark / studio-theme-dark，独立桌面应用认 .dark），
 * data-shell-theme 是画布自己的权威值，浅色时也写，theme.ts 靠它区分「浅色」和「没有外壳」。
 */
function syncTheme(theme?: string) {
  applyShellTheme(theme === "dark" || theme === "light" ? theme : storedTheme());
}

function NovaiCanvas() {
  const backend = useMemo(() => createNovaiBackend(), []);
  const [name, setName] = useState("画布");
  const [nickname, setNickname] = useState("本机用户");
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null);
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
  /** 昵称以 LAN 账号为准：旧后端没有 /api/lan/me 时静默保持「本机用户」；外壳改名走 novai:profile，画布内改名走 novai:profile-local */
  useEffect(() => {
    let alive = true;
    const loadNickname = () => {
      void fetch("/api/lan/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then((response) => response.ok ? response.json() : null)
        .then((data) => { const next = String(data?.me?.nickname || ""); if (alive && next) setNickname(next); })
        .catch(() => undefined);
    };
    loadNickname();
    const onVisible = () => { if (document.visibilityState === "visible") loadNickname(); };
    const onMessage = (event: MessageEvent) => { if (event.data?.type === "novai:profile") loadNickname(); };
    window.addEventListener("focus", loadNickname);
    window.addEventListener("message", onMessage);
    window.addEventListener("novai:profile-local", loadNickname);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.removeEventListener("focus", loadNickname);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("novai:profile-local", loadNickname);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const host = useMemo<HostActions>(() => ({
    backToList,
    openModelSettings: () => navigate("api-settings"),
    openMcpCenter: () => { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "open-settings", tab: "mcp" }, location.origin); },
    features: { collab: false, share: true, organization: false, desktopInputs: false, elements: false, teamAssets: false },
    openCanvas: (id) => { location.href = `/static/canvas.html?id=${encodeURIComponent(id)}`; },
    createCanvas,
    listCanvases: async () => {
      const response = await fetch("/api/canvases");
      if (!response.ok) return [];
      const data = await response.json();
      return (data.canvases || []).filter((canvas: any) => (canvas.kind || "classic") === "classic").map((canvas: any) => ({ id: String(canvas.id), name: String(canvas.title || "未命名画布"), nodes: Number(canvas.node_count) || undefined }));
    },
    user: { name: nickname, initial: "我" },
    badge: "",
  }), [nickname]);
  return <CanvasApp backend={backend} canvasId={canvasId} name={name} host={host} agentDraft={agentDraft} onReady={(store) => {
    (window as any).__cn = store;
    // 铺参考图要等图片尺寸，异步补上：不挡画布加载；种子读一次就删，重复调用只会拿到 null
    void consumeHomeSeed(store).then((draft) => { if (draft) setAgentDraft(draft); }).catch(() => undefined);
  }} />;
}

/** 独立分享页：跟着外壳 / 系统深浅色走，外壳切主题时实时更新 */
function ShareRoot({ token }: { token: string }) {
  const [theme, setTheme] = useState<"dark" | "light">(() => (shellDark() ? "dark" : "light"));
  useEffect(() => {
    const sync = () => setTheme(shellDark() ? "dark" : "light");
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener?.("change", sync);
    window.addEventListener("message", sync);
    return () => { media.removeEventListener?.("change", sync); window.removeEventListener("message", sync); };
  }, []);
  return <SharePage token={token} theme={theme} />;
}

syncTheme();
const root = document.getElementById("root")!;
if (shareToken) createRoot(root).render(<ShareRoot token={shareToken} />);
else if (canvasId) createRoot(root).render(<NovaiCanvas />);
else createRoot(root).render(<div className="novai-canvas-error"><h2>没有指定要打开的画布</h2><button onClick={backToList}>返回画布列表</button></div>);
