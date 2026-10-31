type Row = Record<string, any>;
type Command = (request: Record<string, unknown>) => Promise<Record<string, any>>;

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || data.error || `HTTP ${response.status}`);
  return data;
}

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function commandOf(path: string, init?: RequestInit): Promise<Row> {
  try { return { ok: true, ...(await request(path, init)) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "REQUEST_FAILED" }; }
}

async function rawLibrary(): Promise<Row> {
  const data = await request("/api/asset-library");
  return data.library || { libraries: [] };
}

function categories(library: Row | null, imageOnly = false): Row[] {
  return (library?.categories || []).filter((cat: Row) => !imageOnly || (cat.type || "image") === "image");
}

function findLibrary(data: Row, id: string): Row | null {
  return (data.libraries || []).find((lib: Row) => lib.id === id) || data.libraries?.[0] || null;
}

function itemOut(item: Row, cat: Row): Row {
  const kind = item.kind || cat.type || "asset";
  return {
    id: String(item.id), kind,
    title: String(item.name || item.title || "素材"),
    mediaKind: kind,
    resourceRef: String(item.url || ""),
    previewUrl: String(item.thumbnail || item.url || ""),
    url: String(item.url || ""),
    group: String(cat.name || "未分组"),
    createdAt: Number(item.created_at) || 0,
    updatedAt: Number(item.updated_at || item.created_at) || 0,
    ...(kind === "workflow" ? { prompt: String(item.description || "") } : {}),
  };
}

function libraryOut(lib: Row): Row {
  const count = categories(lib).reduce((sum: number, cat: Row) => sum + (cat.items || []).length, 0);
  return { id: String(lib.id), name: String(lib.name || "资产库"), visibility: "PRIVATE", access: "owner", itemCount: count };
}

async function ensureLibrary(id = ""): Promise<Row> {
  const data = await rawLibrary();
  let lib = findLibrary(data, id);
  if (!lib) {
    const made = await request("/api/asset-library/libraries", json({ name: "默认资产库" }));
    lib = made.asset_library;
  }
  if (!lib) return { ok: false, error: "无法创建资产库" };
  return { ok: true, library: libraryOut(lib) };
}

async function getItems(libraryId: string): Promise<Row> {
  const data = await rawLibrary();
  const lib = findLibrary(data, libraryId);
  if (!lib) return { ok: false, error: "资产库不存在" };
  const items = await Promise.all(categories(lib).flatMap((cat: Row) => (cat.items || []).map(async (item: Row) => {
    const out = itemOut(item, cat);
    if (out.kind === "workflow" && out.url) out.workflow = await request(out.url).catch(() => null);
    return out;
  })));
  const prompts = await request("/api/prompt-libraries").catch(() => ({ library: { libraries: [] } }));
  for (const lib of prompts.library?.libraries || []) {
    for (const item of lib.items || []) {
      if (String(item.id).startsWith("builtin_")) continue;
      items.push({ id: String(item.id), kind: "prompt", title: String(item.name || "提示词"), prompt: String(item.positive || ""), group: "提示词", updatedAt: Number(item.updated_at || item.created_at) || 0 });
    }
  }
  return { ok: true, items };
}

async function imageCategory(libraryId: string, name = ""): Promise<Row> {
  const data = await rawLibrary();
  const lib = findLibrary(data, libraryId);
  if (!lib) throw new Error("资产库不存在");
  const cats = categories(lib, true);
  if (name) {
    const found = cats.find((cat: Row) => cat.name === name);
    if (found) return found;
    const made = await request("/api/asset-library/categories", json({ library_id: lib.id, name, type: "image" }));
    return made.category;
  }
  return cats[0] || (await request("/api/asset-library/categories", json({ library_id: lib.id, name: "未分组", type: "image" }))).category;
}

async function importAsset(input: Row): Promise<Row> {
  const libraryId = String(input.libraryId || "");
  const cat = await imageCategory(libraryId);
  let url = String(input.url || input.dataUrl || "");
  if (url.startsWith("data:")) {
    const uploaded = await request("/api/ai/upload-base64", json({ data: url, name: String(input.name || "素材"), content_type: String(input.mime || url.slice(5).split(";", 1)[0]) }));
    url = String(uploaded.files?.[0]?.url || "");
  }
  if (!url) throw new Error("素材地址为空");
  const made = await request("/api/asset-library/items", json({ library_id: libraryId, category_id: cat.id, url, name: String(input.title || input.name || "素材") }));
  return { ok: true, item: itemOut(made.item, cat) };
}

async function ensurePromptLibrary(): Promise<string> {
  const data = await request("/api/prompt-libraries");
  const existing = (data.library?.libraries || []).find((lib: Row) => lib.id === "canvas-prompts") || (data.library?.libraries || []).find((lib: Row) => lib.id !== "system");
  if (existing) return String(existing.id);
  const made = await request("/api/prompt-libraries", json({ name: "画布提示词" }));
  return String(made.prompt_library.id);
}

async function upsert(input: Row): Promise<Row> {
  const item = input.item || {};
  if (item.kind === "prompt") {
    const body = { library_id: await ensurePromptLibrary(), name: String(item.title || "提示词"), category: "custom", positive: String(item.prompt || "") };
    const made = item.id
      ? await request(`/api/prompt-libraries/items/${encodeURIComponent(String(item.id))}`, json(body, "PATCH"))
      : await request("/api/prompt-libraries/items", json(body));
    return { ok: true, item: { id: made.item.id, kind: "prompt", title: made.item.name, prompt: made.item.positive } };
  }
  if (item.kind === "workflow") {
    if (item.id) await request(`/api/asset-library/items/${encodeURIComponent(String(item.id))}`, { method: "DELETE" }).catch(() => null);
    const lib = findLibrary(await rawLibrary(), String(input.libraryId || ""));
    const cat = categories(lib, false).find((row: Row) => row.type === "workflow") || categories(lib, false)[0];
    if (!lib || !cat) throw new Error("工作流分类不存在");
    const form = new FormData();
    form.append("library_id", String(input.libraryId || lib.id));
    form.append("category_id", String(cat.id));
    form.append("files", new File([JSON.stringify(item.workflow || {})], `${String(item.title || "canvas-template").replace(/[\\/:*?"<>|]/g, "_")}.json`, { type: "application/json" }));
    const made = await request("/api/asset-library/workflows/upload", { method: "POST", body: form });
    return { ok: true, item: itemOut(made.items[0], cat) };
  }
  return importAsset({ ...input, ...item });
}

async function canvasCommand(input: Row): Promise<Row> {
  const type = String(input.type || "");
  if (type === "canvas/libraryList") {
    const data = await rawLibrary();
    const q = String(input.query || "").toLowerCase();
    const items = (data.libraries || []).flatMap((lib: Row) => categories(lib, true).flatMap((cat: Row) => (cat.items || []).map((item: Row) => ({ ref: String(item.url || ""), name: String(item.name || "素材"), mimeType: item.kind === "video" ? "video/mp4" : item.kind === "audio" ? "audio/mpeg" : "image/png", thumbnail: String(item.thumbnail || item.url || "") })))).filter((item: Row) => item.ref && (!q || item.name.toLowerCase().includes(q))).slice(0, Number(input.limit) || 60);
    return { ok: true, items };
  }
  if (type === "canvas/assetLibrary/ensure") return ensureLibrary(String(input.libraryId || ""));
  if (type === "canvas/assetLibrary/list") {
    const data = await rawLibrary();
    return { ok: true, libraries: (data.libraries || []).map(libraryOut) };
  }
  if (type === "canvas/assetLibrary/get") return getItems(String(input.libraryId || ""));
  if (type === "canvas/assetLibrary/import") return importAsset(input);
  if (type === "canvas/assetLibrary/upsert") return upsert(input);
  if (type === "canvas/assetLibrary/delete") return commandOf(`/api/asset-library/items/${encodeURIComponent(String(input.itemId || ""))}`, { method: "DELETE" });
  if (type === "canvas/assetLibrary/folderList") {
    const lib = findLibrary(await rawLibrary(), String(input.libraryId || ""));
    return { ok: true, folders: categories(lib, true).map((cat: Row) => ({ name: String(cat.name), count: (cat.items || []).length, custom: true })) };
  }
  if (type === "canvas/assetLibrary/folderCreate") {
    const made = await request("/api/asset-library/categories", json({ library_id: String(input.libraryId || ""), name: String(input.name || ""), type: "image" }));
    return { ok: true, folder: made.category };
  }
  if (type === "canvas/assetLibrary/folderRename") {
    const lib = findLibrary(await rawLibrary(), String(input.libraryId || ""));
    const cat = categories(lib, true).find((row: Row) => row.name === input.from);
    if (!cat) throw new Error("文件夹不存在");
    const made = await request(`/api/asset-library/categories/${encodeURIComponent(String(cat.id))}`, json({ name: String(input.to || ""), library_id: String(input.libraryId || "") }, "PATCH"));
    return { ok: true, folder: made.category };
  }
  if (type === "canvas/assetLibrary/folderMove") {
    const cat = await imageCategory(String(input.libraryId || ""), String(input.folder || "未分组"));
    return commandOf("/api/asset-library/items/move", json({ library_id: String(input.libraryId || ""), target_category_id: cat.id, ids: [String(input.itemId || "")] }));
  }
  if (type === "canvas/assetLibrary/syncSources") return { ok: true };
  if (type === "canvas/models") return { ok: true, models: [] };
  return { ok: false, error: "NOT_SUPPORTED", detail: `当前 NOVAI 不支持 ${type}` };
}

function disabledSkills(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem("canvas-next:novai-skills-off") || "[]")); } catch { return new Set(); }
}

function saveDisabledSkills(ids: Set<string>) {
  try { localStorage.setItem("canvas-next:novai-skills-off", JSON.stringify([...ids])); } catch { /* ignore */ }
}

async function skillCommand(input: Row): Promise<Row> {
  const command = String(input.command || "");
  const payload = input.payload || {};
  if (command === "skill/list") {
    const data = await request("/api/skills");
    const disabled = disabledSkills();
    return { ok: true, value: { items: (data.skills || []).map((skill: Row) => ({ id: skill.id, name: skill.name, description: skill.description, enabled: skill.enabled !== false && !disabled.has(String(skill.id)), builtin: skill.skill_type === "system", origin: skill.skill_type === "system" ? "official" : "custom", visibleInApp: true })) } };
  }
  if (command === "skill/enable" || command === "skill/disable") {
    const disabled = disabledSkills();
    if (command === "skill/disable") disabled.add(String(payload.skillId || "")); else disabled.delete(String(payload.skillId || ""));
    saveDisabledSkills(disabled);
    return { ok: true };
  }
  if (command === "skill/save") {
    const skill = payload.skill || {};
    const markdown = String(skill.systemPrompt || `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`);
    const made = await request("/api/skills/import", json({ markdown, overwrite: true }));
    return { ok: true, value: made };
  }
  return { ok: false, error: "NOT_SUPPORTED" };
}

async function resourceCommand(input: Row): Promise<Row> {
  const type = String(input.type || "");
  if (type === "resource/query") {
    const data = await request("/api/memories");
    return { ok: true, items: (data.memories || []).map((memory: Row) => ({ resourceRef: memory.id, memorySubtype: memory.scope === "conversation" ? "project-memory" : "personal-preference", attributes: { canvasId: memory.conversation_id || null } })) };
  }
  if (type === "resource/readText") {
    const data = await request("/api/memories");
    const memory = (data.memories || []).find((row: Row) => row.id === input.resourceRef);
    return memory ? { ok: true, text: String(memory.content || "") } : { ok: false, error: "记忆不存在" };
  }
  if (type === "resource/create") {
    const made = await request("/api/memories", json({ content: String(input.content || ""), scope: input.memorySubtype === "project-memory" ? "conversation" : "global", conversation_id: input.attributes?.canvasId || "" }));
    return { ok: true, resourceRef: made.memory.id };
  }
  if (type === "resource/delete") return commandOf(`/api/memories/${encodeURIComponent(String(input.resourceRef || ""))}`, { method: "DELETE" });
  return { ok: false, error: "NOT_SUPPORTED" };
}

async function taskCommand(input: Row): Promise<Row> {
  const type = String(input.type || "");
  const payload = input.payload || {};
  if (type === "task/run") {
    const context = payload.canvasContext || {};
    const configId = String(context.modelConfigId || "");
    const splitAt = configId.indexOf("::");
    const provider = splitAt >= 0 ? configId.slice(0, splitAt) : "comfly";
    const model = splitAt >= 0 ? configId.slice(splitAt + 2) : configId;
    const resourceRefs = Array.isArray(context.resourceRefs) ? context.resourceRefs.map(String).filter(Boolean) : [];
    const referenceVideos = resourceRefs.filter((url: string) => /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i.test(url));
    const referenceImages = resourceRefs.filter((url: string) => !referenceVideos.includes(url));
    const thinking = String(context.thinking || "standard");
    const response = await fetch("/api/agent/run", json({
      canvas_id: String(context.canvasId || ""),
      instruction: String(payload.goal || ""),
      provider,
      model,
      ms_model: provider === "modelscope" ? model : "",
      mode: context.mode === "run" ? "run" : "plan",
      max_steps: thinking === "off" ? 4 : thinking === "light" ? 8 : thinking === "heavy" ? 24 : 12,
      focus: {
        selected_node_ids: Array.isArray(context.selectedNodeIds) ? context.selectedNodeIds : [],
        reference_images: referenceImages,
        reference_videos: referenceVideos,
        references: (Array.isArray(context.selectedNodeIds) ? context.selectedNodeIds : []).map((id: string) => ({ id, role: "context", source: "node" })),
      },
      history: [],
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || data.error || `HTTP ${response.status}`);
    const taskId = String(response.headers.get("X-NOVAI-Run-Id") || "");
    if (!taskId) throw new Error("Agent 运行没有返回任务 ID");
    if (response.body) void response.body.cancel().catch(() => undefined);
    return { ok: true, taskId, status: "RUNNING" };
  }
  if (type === "task/get") return commandOf(`/api/agent/runs/${encodeURIComponent(String(payload.taskId || ""))}/snapshot`);
  if (type === "task/list") return commandOf("/api/agent/tasks");
  if (type === "task/cancel") return commandOf(`/api/agent/runs/${encodeURIComponent(String(payload.taskId || ""))}/cancel`, json({}));
  return { ok: false, error: "NOT_SUPPORTED" };
}

async function modelCommand(input: Row): Promise<Row> {
  if (input.type === "canvas/models") return { ok: true, models: [] };
  return { ok: false, error: "NOT_SUPPORTED" };
}

async function call(fn: (input: Row) => Promise<Row>, input: Row): Promise<Row> {
  try { return await fn(input); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "REQUEST_FAILED" }; }
}

export function installNovaiBridge() {
  const root = window as any;
  const previous = root.openarc || {};
  root.openarc = {
    ...previous,
    canvas: { command: (input: Row) => call(canvasCommand, input) },
    model: { command: (input: Row) => call(modelCommand, input) },
    skill: { command: (input: Row) => call(skillCommand, input) },
    resource: { command: (input: Row) => call(resourceCommand, input) },
    task: { command: (input: Row) => call(taskCommand, input) },
  };
}
