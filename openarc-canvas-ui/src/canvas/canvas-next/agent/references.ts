export type AgentReference = { id: string; kind: "app" | "asset"; title: string; ref: string; group: string; detail?: string };
type Command = (req: Record<string, unknown>) => Promise<Record<string, any>>;

function api(): { agent?: Command; canvas?: Command } {
  const root = (window as unknown as { openarc?: { agent?: { command?: Command }; canvas?: { command?: Command } } }).openarc;
  return { agent: root?.agent?.command, canvas: root?.canvas?.command };
}

export async function listAgentReferences(): Promise<{ apps: AgentReference[]; assets: AgentReference[]; errors: string[] }> {
  const { agent, canvas } = api(); const errors: string[] = [];
  const appsPromise = agent ? agent({ type: "agent/tool/catalog", executableOnly: true }).then((r) => (r.descriptors || []) as Array<Record<string, any>>).catch(() => { errors.push("应用工具目录不可用"); return []; }) : Promise.resolve([]);
  const assetsPromise = canvas ? canvas({ type: "canvas/assetLibrary/list" }).then(async (r) => {
    const libraries = (r.libraries || []) as Array<{ id: string; name: string; visibility?: string; access?: string }>;
    const groups = await Promise.all(libraries.map(async (lib) => {
      const result = await canvas({ type: "canvas/assetLibrary/get", libraryId: lib.id }).catch(() => null);
      return ((result?.items || []) as Array<Record<string, any>>).map((item) => ({
        id: "asset:" + lib.id + ":" + item.id,
        kind: "asset" as const,
        title: String(item.title || item.prompt || "未命名素材"),
        ref: String(item.resourceRef || item.coverRef || item.url || item.prompt || ""),
        group: lib.access === "owner" && String(lib.visibility).toUpperCase() === "PRIVATE" ? "个人素材库" : "团队素材库",
        detail: String(item.kind || item.mediaKind || "素材"),
      })).filter((item) => item.ref);
    }));
    return groups.flat();
  }).catch(() => { errors.push("素材库不可用"); return []; }) : Promise.resolve([]);
  const [descriptors, assets] = await Promise.all([appsPromise, assetsPromise]);
  const apps = descriptors.map((tool) => ({ id: "app:" + tool.name, kind: "app" as const, title: String(tool.title || tool.name), ref: String(tool.name), group: tool.source === "mcp" ? "MCP 应用" : "应用", detail: String(tool.description || tool.statusText || "") }));
  return { apps, assets, errors };
}
