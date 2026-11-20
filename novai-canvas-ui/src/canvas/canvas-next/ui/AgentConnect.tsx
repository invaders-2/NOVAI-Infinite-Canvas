/**
 * 「在 Agent 中打开」弹窗（画布右上角插头菜单 → MCP 中心）。
 * 数据全部走同源 /api/mcp/*：connect-info 给 stdio 配置与 base_url，installed-agents 给本机状态，
 * install-agent 一键写入，open-agent 打开客户端或返回 CLI 启动命令。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Ctl } from "./ctx";
import { Icon } from "./Icon";
import { openModal } from "./overlay";
import { VendorLogo } from "./VendorLogo";
import "./agent-connect.css";

export function openAgentConnect(ctl: Ctl) {
  openModal((close) => <AgentConnect ctl={ctl} close={close} />, "agent-connect-modal");
}

type AgentId = "claude" | "codex" | "workbuddy" | "kimi" | "hermes" | "dsh" | "more";

type AgentMeta = { id: AgentId; name: string; kind: "desktop" | "cli"; title: string; desc: string };

const AGENTS: AgentMeta[] = [
  { id: "claude", name: "Claude", kind: "desktop", title: "在 Claude 里继续这个项目", desc: "打开 Claude 并预填一段提示词，通过 MCP 把它连到 NOVAI 并交接当前项目。首次使用时 Claude 会引导你添加连接器。" },
  { id: "codex", name: "Codex", kind: "cli", title: "在 Codex 里继续这个项目", desc: "把 NOVAI MCP 写进 Codex CLI 的配置，在终端里用画布工具继续当前项目。" },
  { id: "workbuddy", name: "WorkBuddy", kind: "desktop", title: "在 WorkBuddy 里继续这个项目", desc: "一键把 NOVAI MCP 写进 WorkBuddy 的 MCP 配置，重启 WorkBuddy 后就能在对话里使用画布工具。" },
  { id: "kimi", name: "Kimi Code", kind: "cli", title: "在 Kimi Code 里继续这个项目", desc: "把 NOVAI MCP 写进 Kimi Code 的 MCP 配置，重启 Kimi Code 后就能在终端里调用画布工具。" },
  { id: "hermes", name: "Hermes", kind: "cli", title: "在 Hermes 里继续这个项目", desc: "把 NOVAI MCP 写进 Hermes 的 MCP 配置，重启 Hermes 后就能在终端里调用画布工具。" },
  { id: "dsh", name: "DSH", kind: "desktop", title: "在 DSH 里继续这个项目", desc: "DSH 需要手动粘贴 MCP 配置：复制后加到 DSH 的 MCP 设置里，重启 DSH 生效。" },
  { id: "more", name: "更多 Agent", kind: "desktop", title: "在其他 Agent 里继续这个项目", desc: "复制 NOVAI MCP 配置，粘贴到任意支持 MCP 的 Agent 中即可使用画布工具。" },
];

const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a])) as Record<AgentId, AgentMeta>;

/** 后端旧版本缺 installable / launchable 时的兜底，新后端会逐条覆盖 */
const INSTALLABLE_FALLBACK: Record<string, boolean> = { claude: true, codex: true, "claude-cli": true, workbuddy: true, kimi: true, hermes: true };

const CONFIG_PATH_FALLBACK: Record<AgentId, string> = {
  claude: /Mac/i.test(navigator.platform) ? "~/Library/Application Support/Claude/claude_desktop_config.json" : "%APPDATA%\\Claude\\claude_desktop_config.json",
  codex: "~/.codex/config.toml",
  workbuddy: "~/.workbuddy/mcp.json",
  kimi: "~/.kimi-code/mcp.json",
  hermes: "~/.hermes/config.yaml",
  dsh: "DSH 的 MCP 设置（仅复制配置，不自动写入）",
  more: "客户端默认配置文件（后端自动定位）",
};

type ServerEntry = { command?: string; args?: string[]; env?: Record<string, string> };
type ConnectInfo = { base_url?: string; server_entry?: ServerEntry; mcp_servers_json?: unknown; codex_command?: string; http_url?: string; docs_path?: string };
type AgentState = {
  installed: boolean;
  configured: boolean;
  configuredBaseUrl: string;
  path: string;
  command: string;
  configPath: string;
  kind: string;
  installable?: boolean;
  launchable?: boolean;
  reason: string;
};
type ActionKind = "install" | "open" | "copy-command" | "copy-config" | "copy-prompt" | "docs";
type PlanAction = { kind: ActionKind; label: string };
type Plan = { primary?: PlanAction; ghost?: PlanAction };

const EMPTY_STATE: AgentState = { installed: false, configured: false, configuredBaseUrl: "", path: "", command: "", configPath: "", kind: "", reason: "" };

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "");
  if (!text) return "网络错误";
  if (/failed to fetch|networkerror|load failed/i.test(text)) return "接口不可用";
  return text;
}

function normalizeAgents(list: unknown): Record<string, AgentState> {
  const next: Record<string, AgentState> = {};
  if (!Array.isArray(list)) return next;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = String(item.id || item.name || "").toLowerCase();
    if (!id) continue;
    next[id] = {
      installed: item.installed !== false,
      configured: item.configured === true,
      configuredBaseUrl: String(item.configured_base_url || item.configuredBaseUrl || ""),
      path: String(item.path || ""),
      command: String(item.command || ""),
      configPath: String(item.config_path || item.configPath || ""),
      kind: String(item.kind || ""),
      installable: typeof item.installable === "boolean" ? item.installable : undefined,
      launchable: typeof item.launchable === "boolean" ? item.launchable : undefined,
      reason: String(item.reason || ""),
    };
  }
  return next;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && typeof data === "object" ? String((data as { detail?: unknown }).detail || "") : "";
    throw new Error(detail ? detail + "（HTTP " + res.status + "）" : "HTTP " + res.status);
  }
  return data as T;
}

/** 剪贴板：优先 navigator.clipboard，失败退到 execCommand；布尔值表示是否真的复制成功 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 无权限 / 非安全上下文时走兜底 */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch { return false; }
}

function serverCommand(info: ConnectInfo | null): string {
  const entry = info?.server_entry;
  return [entry?.command || "", ...(entry?.args || [])].filter(Boolean).join(" ");
}

function promptOf(ctl: Ctl, info: ConnectInfo | null): string {
  const name = String(ctl.store.state?.name || "").trim() || "未命名画布";
  const canvasId = String(ctl.store.state?.canvasId || "").trim() || "未知";
  const base = String(info?.base_url || "").replace(/\/$/, "");
  return "请通过 MCP 连接 NOVAI 画布，继续当前项目。\n"
    + "当前画布：「" + name + "」（id：" + canvasId + "）\n"
    + "服务器名：novai-canvas\n"
    + "stdio 命令：" + (serverCommand(info) || "配置未生成") + "\n"
    + "base_url：" + base + "\n"
    + "要求：先列出可用的画布工具再动手。如果 NOVAI 工具没出现，先停下让我重启 Claude；连接后把这张画布当当前项目，先读结构再继续。\n"
    + "接入指南：" + (base || "") + "/static/help/mcp.html";
}

function AgentMark({ id, size }: { id: AgentId; size?: number }) {
  const box: CSSProperties | undefined = size ? { width: size, height: size, flex: "0 0 " + size + "px" } : undefined;
  const letter: CSSProperties | undefined = size
    ? { ...box, borderRadius: Math.round(size * 0.29), fontSize: Math.round(size * 0.48) }
    : undefined;
  if (id === "claude") return <span className="ac-mark ac-mark-claude" style={box} />;
  if (id === "codex") return <span className="ac-mark ac-mark-openai" style={box} />;
  if (id === "workbuddy") return <img className="ac-mark-img" src="/static/images/brands/workbuddy.svg" alt="" draggable={false} style={box} />;
  if (id === "kimi") return <span className="ac-letter ac-letter-kimi" style={letter}>K</span>;
  if (id === "hermes") return <span className="ac-letter ac-letter-hermes" style={letter}>H</span>;
  if (id === "dsh") return <VendorLogo name="DeepSeek" size={size ?? 16} />;
  return <span className="ac-mark ac-mark-more" style={box}><Icon name="grid" /></span>;
}

/** 「更多 Agent」hero 的一排 App 图标：中间 NOVAI 最大最亮，两侧略小并轻微旋转 / 上下错位 */
const LINEUP: Array<{ key: string; agent?: AgentId; label: string; size: number; radius: number; tilt: number; dy: number }> = [
  { key: "claude", agent: "claude", label: "Claude", size: 58, radius: 17, tilt: -4, dy: 7 },
  { key: "workbuddy", agent: "workbuddy", label: "WorkBuddy", size: 66, radius: 18, tilt: 3, dy: -5 },
  { key: "novai", label: "NOVAI", size: 78, radius: 20, tilt: 0, dy: -13 },
  { key: "codex", agent: "codex", label: "Codex", size: 66, radius: 18, tilt: -3, dy: -5 },
  { key: "kimi", agent: "kimi", label: "Kimi", size: 58, radius: 17, tilt: 4, dy: 7 },
];

function AgentLineup() {
  return (
    <div className="ac-lineup">
      {LINEUP.map((item) => (
        <span key={item.key} className={"ac-app" + (item.key === "novai" ? " is-center" : "")}
          title={item.label} aria-label={item.label}
          style={{ width: item.size, height: item.size, borderRadius: item.radius, ["--ac-tilt" as string]: item.tilt + "deg", ["--ac-dy" as string]: item.dy + "px" }}>
          {item.agent
            ? <AgentMark id={item.agent} size={Math.round(item.size * 0.56)} />
            : <img className="ac-novai ac-app-logo" src="/static/images/logo.svg" alt="NOVAI" draggable={false} style={{ width: Math.round(item.size * 0.56), height: Math.round(item.size * 0.56) }} />}
        </span>
      ))}
    </div>
  );
}

function AgentConnect({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const store = ctl.store;
  const [active, setActive] = useState<AgentId>("claude");
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [states, setStates] = useState<Record<string, AgentState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [agentsError, setAgentsError] = useState(false);
  const [confirmId, setConfirmId] = useState<AgentId | null>(null);
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [infoResult, agentsResult] = await Promise.allSettled([
      requestJson<ConnectInfo>("/api/mcp/connect-info"),
      requestJson<{ agents?: unknown }>("/api/mcp/installed-agents"),
    ]);
    if (!alive.current) return;
    if (infoResult.status === "fulfilled") {
      setInfo(infoResult.value || null);
    } else {
      setInfo(null);
      const msg = messageOf(infoResult.reason);
      setLoadError(msg);
      store.toast("读取 MCP 连接信息失败：" + msg + "，请确认 NOVAI 后端已启动", 5200);
    }
    if (agentsResult.status === "fulfilled") {
      setStates(normalizeAgents(agentsResult.value?.agents));
      setAgentsError(false);
    } else {
      setStates({});
      setAgentsError(true);
      store.toast("读取本机 Agent 状态失败：" + messageOf(agentsResult.reason) + "，已按未安装处理", 5200);
    }
    setLoading(false);
  }, [store]);

  useEffect(() => { void load(); }, [load]);

  const reloadAgents = async () => {
    try {
      const data = await requestJson<{ agents?: unknown }>("/api/mcp/installed-agents");
      if (alive.current) { setStates(normalizeAgents(data?.agents)); setAgentsError(false); }
    } catch (error) {
      if (alive.current) store.toast("刷新本机 Agent 状态失败：" + messageOf(error), 4200);
    }
  };

  const stateOf = (id: AgentId) => states[id] || null;
  const installedOf = (id: AgentId) => !!stateOf(id)?.installed;
  const configuredOf = (id: AgentId) => !!stateOf(id)?.installed && !!stateOf(id)?.configured;
  const isStale = (id: AgentId) => {
    const st = stateOf(id);
    if (!st?.installed || !st.configured || !st.configuredBaseUrl) return false;
    const current = String(info?.base_url || "").replace(/\/$/, "");
    return !!current && st.configuredBaseUrl.replace(/\/$/, "") !== current;
  };
  const installableOf = (id: AgentId) => {
    if (id === "more") return false;
    const st = stateOf(id);
    return typeof st?.installable === "boolean" ? st.installable : !!INSTALLABLE_FALLBACK[id];
  };
  const launchableOf = (id: AgentId) => {
    if (id === "more") return false;
    const st = stateOf(id);
    return typeof st?.launchable === "boolean" ? st.launchable : true;
  };
  const kindOf = (id: AgentId): "desktop" | "cli" => {
    const st = stateOf(id);
    if (st?.kind === "cli" || st?.kind === "desktop") return st.kind;
    return AGENT_BY_ID[id].kind;
  };
  const reasonOf = (id: AgentId) => {
    if (id === "more" || !installedOf(id)) return "";
    const st = stateOf(id);
    if (st?.reason) return st.reason;
    return installableOf(id) ? "" : "该客户端暂不支持自动写入，复制配置后手动粘贴";
  };
  const needsConfig = (id: AgentId) => installedOf(id) && installableOf(id) && (!configuredOf(id) || isStale(id));

  const planFor = (id: AgentId): Plan => {
    const meta = AGENT_BY_ID[id];
    if (!installedOf(id)) return { primary: { kind: "copy-config", label: "复制配置" }, ghost: { kind: "docs", label: "MCP 文档" } };
    if (installableOf(id) && needsConfig(id)) {
      return {
        primary: { kind: "install", label: "一键接入 " + meta.name + (isStale(id) ? "（更新）" : "") },
        ghost: kindOf(id) === "cli" ? { kind: "copy-command", label: "复制命令" } : { kind: "open", label: "打开 " + meta.name },
      };
    }
    if (kindOf(id) === "cli") return { primary: { kind: "copy-command", label: "复制启动命令" }, ghost: { kind: "copy-config", label: "复制配置" } };
    if (!launchableOf(id)) return { primary: { kind: "copy-config", label: "复制配置" }, ghost: { kind: "docs", label: "MCP 文档" } };
    return { primary: { kind: "open", label: "打开 " + meta.name }, ghost: { kind: "copy-config", label: "复制配置" } };
  };

  const copyText = async (text: string, okMsg: string) => {
    if (!text.trim()) { store.toast("没有可复制的内容", 4000); return false; }
    const ok = await writeClipboard(text);
    store.toast(ok ? okMsg : "复制失败，请手动选择文本复制", ok ? 2600 : 4200);
    return ok;
  };

  const copyConfig = () => copyText(JSON.stringify(info?.mcp_servers_json || {}, null, 2), "已复制 MCP 配置");

  const launchCommand = async (id: AgentId) => {
    setBusy("command");
    try {
      const data = await requestJson<{ command?: string }>("/api/mcp/open-agent", { method: "POST", body: JSON.stringify({ id }) });
      const command = String(data?.command || stateOf(id)?.command || id);
      await copyText(command, "已复制启动命令");
    } catch (error) {
      store.toast("获取 " + AGENT_BY_ID[id].name + " 启动命令失败：" + messageOf(error), 5200);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const openAgent = async (id: AgentId) => {
    setBusy("open");
    const name = AGENT_BY_ID[id].name;
    // Claude 走官方深链预填输入框；其它 Agent 不传 prompt
    const prompt = id === "claude" ? promptOf(ctl, info) : "";
    try {
      const data = await requestJson<{ action?: string; command?: string }>("/api/mcp/open-agent", {
        method: "POST",
        body: JSON.stringify(prompt ? { id, prompt } : { id }),
      });
      if (data?.action === "deep_link") {
        store.toast("已在 Claude 输入框填好，按发送即可", 3600);
      } else if (data?.action === "opened") {
        if (!prompt) {
          store.toast("已打开 " + name, 3000);
          return;
        }
        const ok = await writeClipboard(prompt);
        store.toast(ok ? "已打开 " + name + "，提示词已复制，粘贴后发送" : "已打开 " + name + "，但提示词复制失败，请手动复制", ok ? 3600 : 5600);
      } else if (data?.action === "command") {
        const command = String(data.command || stateOf(id)?.command || id);
        const ok = await writeClipboard(command);
        store.toast(ok ? "已复制启动命令，在终端运行 " + command : "启动命令：" + command + "（复制失败，请手动复制）", ok ? 3600 : 5600);
      } else {
        store.toast("已复制配置，请手动打开 " + name, 3600);
      }
    } catch (error) {
      const reason = messageOf(error);
      if (!prompt) {
        store.toast("打开 " + name + " 失败：" + reason, 5200);
        return;
      }
      const ok = await writeClipboard(prompt);
      store.toast("打开 " + name + " 失败（" + reason + "）" + (ok ? "，提示词已复制，可手动打开后粘贴" : "，提示词复制也失败，请手动复制"), 5600);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const install = async (id: AgentId) => {
    if (installing) return;
    setInstalling(true);
    try {
      const data = await requestJson<{ path?: string }>("/api/mcp/install-agent", { method: "POST", body: JSON.stringify({ id, confirm: true }) });
      if (alive.current) {
        setStates((prev) => {
          const cur = prev[id] || EMPTY_STATE;
          return { ...prev, [id]: { ...cur, installed: true, configured: true, configPath: String(data?.path || cur.configPath || "") } };
        });
        setConfirmId(null);
      }
      store.toast("已写入配置，重启 " + AGENT_BY_ID[id].name + " 生效", 3600);
      await reloadAgents();
    } catch (error) {
      store.toast("写入 " + AGENT_BY_ID[id].name + " 配置失败：" + messageOf(error), 5200);
    } finally {
      if (alive.current) setInstalling(false);
    }
  };

  const runAction = async (action: PlanAction) => {
    const id = active;
    if (action.kind === "install") { setConfirmId(id); return; }
    if (action.kind === "open") { await openAgent(id); return; }
    if (action.kind === "copy-command") { await launchCommand(id); return; }
    if (action.kind === "copy-prompt") { await copyText(promptOf(ctl, info), "已复制提示词"); return; }
    await copyConfig();
  };

  const actionButton = (action: PlanAction, primary: boolean) => {
    if (action.kind === "docs") {
      return <a key="docs" className="ac-btn ghost" href="/static/help/mcp.html" target="_blank" rel="noopener">MCP 文档</a>;
    }
    return (
      <button key={action.kind} type="button" className={"ac-btn " + (primary ? "primary" : "ghost")} disabled={installing || busy !== null} onClick={() => { void runAction(action); }}>
        {action.label}
      </button>
    );
  };

  const meta = AGENT_BY_ID[active];
  const plan = planFor(active);
  const st = stateOf(active);
  const stale = isStale(active);
  const reason = reasonOf(active);
  const confirmPath = confirmId ? (stateOf(confirmId)?.configPath || CONFIG_PATH_FALLBACK[confirmId]) : "";
  const confirmName = confirmId ? AGENT_BY_ID[confirmId].name : "";

  return (
    <div className="ac-wrap">
      <aside className="ac-list">
        <h3>在 Agent 中打开</h3>
        <div className="ac-items">
          {AGENTS.map((agent) => {
            const badge = installedOf(agent.id) ? (configuredOf(agent.id) ? "已接入" : "已安装") : "";
            return (
              <button key={agent.id} type="button" className={"ac-item" + (agent.id === active ? " is-on" : "")}
                aria-pressed={agent.id === active} onClick={() => { setActive(agent.id); setConfirmId(null); }}>
                <span className="ac-item-ico"><AgentMark id={agent.id} /></span>
                <span className="ac-item-label">{agent.name}</span>
                {badge ? <span className={"ac-badge" + (configuredOf(agent.id) ? " is-linked" : "")}>{badge}</span> : null}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="ac-main">
        <button type="button" className="ac-close" aria-label="关闭" title="关闭" onClick={close}><Icon name="x" /></button>

        {loading ? (
          <div className="ac-state ac-loading"><span className="ac-dot" />正在读取连接信息…</div>
        ) : loadError ? (
          <div className="ac-state">
            <b>读取 MCP 连接信息失败</b>
            <p>{loadError}</p>
            <p className="ac-hint">请确认 NOVAI 后端已启动，然后重试。</p>
            <button type="button" className="ac-btn ghost" onClick={() => { void load(); }}>重试</button>
          </div>
        ) : (
          <>
            {agentsError ? (
              <div className="ac-banner">
                <span>本机 Agent 状态读取失败，当前按未安装处理</span>
                <button type="button" className="ac-mini" onClick={() => { void reloadAgents(); }}>重试</button>
              </div>
            ) : null}

            {active === "more" ? (
              <div className="ac-hero is-lineup"><AgentLineup /></div>
            ) : (
              <div className="ac-hero">
                <img className="ac-novai" src="/static/images/logo.svg" alt="NOVAI" width={52} height={52} draggable={false} />
                <span className="ac-arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12h16" /><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" />
                  </svg>
                </span>
                <span className="ac-agent-mark"><AgentMark id={active} size={52} /></span>
              </div>
            )}

            <h3 className="ac-title">{meta.title}</h3>
            <p className="ac-desc">{meta.desc}</p>
            {stale ? <p className="ac-stale">配置指向旧地址 {st?.configuredBaseUrl}，建议重新接入</p> : null}
            {reason ? <p className="ac-reason">{reason}</p> : null}

            {active === "claude" ? (
              <div className="ac-prompt">
                <div className="ac-prompt-head">
                  <span>MCP 提示词</span>
                  <button type="button" className="ac-mini" onClick={() => { void copyText(promptOf(ctl, info), "已复制提示词"); }}>复制</button>
                </div>
                <pre>{promptOf(ctl, info)}</pre>
              </div>
            ) : null}

            {confirmId ? (
              <div className="ac-confirm">
                <p className="ac-confirm-title">写入 {confirmName} 配置？</p>
                <p className="ac-confirm-sub">将修改以下文件：</p>
                <p className="ac-confirm-path">{confirmPath}</p>
                <p className="ac-confirm-hint">{kindOf(confirmId) === "cli" ? "会先备份原文件，重启终端后生效。" : "会先备份原文件，重启 " + confirmName + " 后生效。"}</p>
                <div className="ac-confirm-actions">
                  <button type="button" className="ac-btn ghost" disabled={installing} onClick={() => setConfirmId(null)}>取消</button>
                  <button type="button" className="ac-btn primary" disabled={installing} onClick={() => { void install(confirmId); }}>{installing ? "写入中…" : "确认写入"}</button>
                </div>
              </div>
            ) : null}

            <div className="ac-actions">
              {plan.ghost ? actionButton(plan.ghost, false) : null}
              {plan.primary ? actionButton(plan.primary, true) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
