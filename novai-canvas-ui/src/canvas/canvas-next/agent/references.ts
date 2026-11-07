import { hostRoot } from "../../../novaiBridgeRoot";
export type AgentReference = { id: string; kind: "app" | "asset"; title: string; ref: string; group: string; detail?: string };
export type AgentReferences = { apps: AgentReference[]; assets: AgentReference[]; errors: string[] };
type Command = (req: Record<string, unknown>) => Promise<Record<string, any>>;
type Part = { items: AgentReference[]; error: string };

function api(): { agent?: Command; canvas?: Command } {
  const root = hostRoot<{ agent?: { command?: Command }; canvas?: { command?: Command } }>();
  return { agent: root?.agent?.command, canvas: root?.canvas?.command };
}

/** 应用目录（工具清单）变化慢，缓存久一点没坏处 */
const APPS_TTL = 10_000;
/** 素材库收短到 1.5 秒：增删素材后 @ 面板里立刻能看到，原来的 10 秒窗口会让人以为没存上 */
const ASSETS_TTL = 1_500;

let appsCache: { at: number; value: Promise<Part> } | null = null;
let assetsCache: { at: number; value: Promise<Part> } | null = null;

/** 素材库被增删改之后调用：不等 TTL，下一次打开面板就能看到新内容 */
export function invalidateAgentReferences(): void {
  assetsCache = null;
}

/**
 * 桥接层把命令异常都吞成了 {ok:false,error}（不会 reject），只看 reject 会把失败当成「空列表」，
 * 所以这里显式认 ok === false 并返回人话原因。
 */
function failReason(result: Record<string, any> | null | undefined, fallback: string): string {
  if (!result) return fallback;
  if (result.ok !== false) return "";
  const detail = typeof result.error === "string" ? result.error : typeof result.detail === "string" ? result.detail : "";
  return detail && detail !== "REQUEST_FAILED" ? fallback + "（" + detail + "）" : fallback;
}

/**
 * 取「可 @ 的引用」：应用工具目录 + 素材库。
 * 失败（{ok:false} 或抛异常）一律写进 errors，并且失败结果不进缓存——下一次打开面板会真的重试。
 */
export async function listAgentReferences(): Promise<AgentReferences> {
  const [apps, assets] = await Promise.all([loadApps(), loadAssets()]);
  return { apps: apps.items, assets: assets.items, errors: [apps.error, assets.error].filter((error) => !!error) };
}

function cached(slot: () => { at: number; value: Promise<Part> } | null, ttl: number, load: () => Promise<Part>, replace: (next: { at: number; value: Promise<Part> } | null) => void): Promise<Part> {
  const now = Date.now();
  const hit = slot();
  if (hit && now - hit.at < ttl) return hit.value;
  const value = load();
  replace({ at: now, value });
  // 失败不留在缓存里：下一次打开必须真的重试，不能被一个空结果挡住
  void value.then((part) => { if (part.error && slot()?.value === value) replace(null); });
  return value;
}

function loadApps(): Promise<Part> {
  return cached(() => appsCache, APPS_TTL, fetchApps, (next) => { appsCache = next; });
}

function loadAssets(): Promise<Part> {
  return cached(() => assetsCache, ASSETS_TTL, fetchAssets, (next) => { assetsCache = next; });
}

async function fetchApps(): Promise<Part> {
  const { agent } = api();
  if (!agent) return { items: [], error: "" };
  try {
    const result = await agent({ type: "agent/tool/catalog", executableOnly: true });
    const reason = failReason(result, "应用工具目录不可用");
    if (reason) return { items: [], error: reason };
    const descriptors = Array.isArray(result.descriptors) ? (result.descriptors as Array<Record<string, any>>) : [];
    return {
      items: descriptors.map((tool) => ({ id: "app:" + tool.name, kind: "app" as const, title: String(tool.title || tool.name), ref: String(tool.name), group: tool.source === "mcp" ? "MCP 应用" : "应用", detail: String(tool.description || tool.statusText || "") })),
      error: "",
    };
  } catch {
    return { items: [], error: "应用工具目录不可用" };
  }
}

async function fetchAssets(): Promise<Part> {
  const { canvas } = api();
  if (!canvas) return { items: [], error: "" };
  let libraries: Array<{ id: string; name: string; visibility?: string; access?: string }>;
  try {
    const result = await canvas({ type: "canvas/assetLibrary/list" });
    const reason = failReason(result, "素材库不可用");
    if (reason) return { items: [], error: reason };
    libraries = Array.isArray(result.libraries) ? result.libraries : [];
  } catch {
    return { items: [], error: "素材库不可用" };
  }
  let failedReads = 0;
  const groups = await Promise.all(libraries.map(async (lib) => {
    try {
      const result = await canvas({ type: "canvas/assetLibrary/get", libraryId: lib.id });
      if (failReason(result, "素材库读取失败")) { failedReads += 1; return []; }
      const items = Array.isArray(result?.items) ? (result.items as Array<Record<string, any>>) : [];
      return items.map((item) => ({
        id: "asset:" + lib.id + ":" + item.id,
        kind: "asset" as const,
        title: String(item.title || item.prompt || "未命名素材"),
        ref: String(item.resourceRef || item.coverRef || item.url || item.prompt || ""),
        group: lib.access === "owner" && String(lib.visibility).toUpperCase() === "PRIVATE" ? "个人素材库" : "团队素材库",
        detail: String(item.kind || item.mediaKind || "素材"),
      })).filter((item) => item.ref);
    } catch {
      failedReads += 1;
      return [];
    }
  }));
  // 部分库读失败也把能读到的给用户，但整份素材库结果不进缓存，下次打开会补拉
  return { items: groups.flat(), error: failedReads ? "素材库读取失败" : "" };
}
