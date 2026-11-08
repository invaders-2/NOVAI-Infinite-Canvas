type Row = Record<string, any>;
import { mergeAssetSources } from "./canvas/canvas-next/libraryAssets";
import { invalidateAgentReferences } from "./canvas/canvas-next/agent/references";
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
    if (out.kind === "workflow") {
      // 优先走 API 读回 JSON（dev 只代理 /api，直连 /assets 会 404）；失败再回退静态 url
      const viaApi = await request(`/api/asset-library/items/${encodeURIComponent(String(out.id))}/workflow`).catch(() => null);
      out.workflow = (viaApi && viaApi.workflow) || (out.url ? await request(out.url).catch(() => null) : null);
    }
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

async function imageCategory(libraryId: string, name = "", categoryId = ""): Promise<Row> {
  const data = await rawLibrary();
  const lib = findLibrary(data, libraryId);
  if (!lib) throw new Error("资产库不存在");
  const cats = categories(lib, true);
  const wanted = String(categoryId || "").replace(/^asset:/, "");
  if (wanted) {
    const found = cats.find((cat: Row) => String(cat.id) === wanted) || cats.find((cat: Row) => cat.name === name);
    if (found) return found;
    throw new Error("文件夹不存在或不是图片分类");
  }
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
  const kind = String(input.kind || "image");
  // 图片走默认图片分类；视频/音频让后端按 kind 自动归类（没有合适分类时传空 category_id）
  const cat = kind === "image" ? await imageCategory(libraryId, String(input.categoryName || ""), String(input.categoryId || "")) : null;
  let url = String(input.url || input.dataUrl || "");
  if (url.startsWith("data:")) {
    const uploaded = await request("/api/ai/upload-base64", json({ data: url, name: String(input.name || "素材"), content_type: String(input.mime || url.slice(5).split(";", 1)[0]) }));
    url = String(uploaded.files?.[0]?.url || "");
  }
  if (!url) throw new Error("素材地址为空");
  const made = await request("/api/asset-library/items", json({
    library_id: libraryId,
    ...(cat ? { category_id: cat.id } : {}),
    url,
    name: String(input.title || input.name || "素材"),
    ...(input.kind ? { kind } : {}),
  }));
  const out = { ok: true, item: itemOut(made.item, cat || { name: kind, type: kind }) };
  // 存完立刻让素材库缓存失效并把新条目并进去：抽屉关着时保存，重开也要马上看到（不等 5 分钟 TTL）
  invalidateGlobalAssets(made.item, cat ? String(cat.id) : undefined);
  return out;
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

let globalExtrasCache: { at: number; asset: Row; prompt: Row } | null = null;
const globalPageCache = new Map<string, { at: number; data: Row }>();
/**
 * 往资产库写东西之后调用：分页缓存直接作废；extras 缓存把新条目并进对应分类，
 * 对不上分类（或拿到的是视频/音频等无分类条目）就整体作废，让下次重拉。
 */
function invalidateGlobalAssets(item?: Row, categoryId?: string) {
  globalPageCache.clear();
  if (!globalExtrasCache) return;
  const cats: Row[] = globalExtrasCache.asset?.library?.categories || [];
  const wanted = String(categoryId || "").replace(/^asset:/, "");
  const target = wanted ? cats.find((cat) => String(cat.id) === wanted) : null;
  if (!item || !target) { globalExtrasCache = null; return; }
  target.items = [...(target.items || []), item];
}
async function globalAssets(limit = 60, refresh = false): Promise<Row> {
  limit = Math.max(1, Math.min(1000, limit || 60));
  const key = String(limit);
  const hit = globalPageCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  if (refresh) globalPageCache.clear();
  if (!globalExtrasCache || refresh) {
    const [asset, prompt] = await Promise.all([
      request("/api/asset-library").catch(() => ({ library: { categories: [] } })),
      request("/api/prompt-libraries").catch(() => ({ library: { libraries: [] } })),
    ]);
    globalExtrasCache = { at: Date.now(), asset, prompt };
  }
  const [canvasData, localData] = await Promise.all([
    request("/api/canvas-assets?limit=" + limit).catch(() => ({ categories: [], items: [] })),
    request("/api/local-assets?limit=" + limit).catch(() => ({ items: [] })),
  ]);
  const merged = mergeAssetSources(canvasData, localData, globalExtrasCache.asset, globalExtrasCache.prompt);
  const parentOf = new Map<string, string>();
  for (const cat of globalExtrasCache.asset?.library?.categories || []) {
    const raw = String(cat.parent_id || "").trim();
    if (raw) parentOf.set("asset:" + String(cat.id), raw.startsWith("asset:") ? raw : "asset:" + raw);
  }
  if (parentOf.size) merged.categories = merged.categories.map((c) => parentOf.has(c.id) ? { ...c, parent_id: parentOf.get(c.id) } : c) as typeof merged.categories;
  const hasMore = (canvasData.items || []).length >= limit;
  const data = { ok: true, ...merged, hasMore };
  globalPageCache.set(key, { at: Date.now(), data });
  return data;
}

/** 素材库写完之后作废 @ 面板的引用缓存：不等 1.5 秒窗口，下一次打开就能看到新素材 */
async function afterLibraryWrite(job: Promise<Row>): Promise<Row> {
  try { return await job; } finally { invalidateAgentReferences(); }
}

/**
 * base64 → 字节：按 4 的倍数分块 atob。
 * 整张 2x PNG 动辄几十 MB，一次性解码既吃内存也容易把调用栈撑爆。
 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const raw = String(base64 || "");
  const step = 0x8000 * 3; // 4 的倍数：每块都是完整 base64 组，可以单独解码
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < raw.length; i += step) {
    const binary = atob(raw.slice(i, i + step));
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j += 1) bytes[j] = binary.charCodeAt(j);
    parts.push(bytes);
  }
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  return all;
}

/**
 * canvas/saveExport：浏览器版没有桌面进程写盘，只能把字节交给 <a download>。
 * 返回 path = fileName，调用方的 toast 直接显示文件名，不再报「保存失败」。
 */
function saveExport(input: Row): Row {
  const fileName = String(input.fileName || "画布.png");
  const bytes = base64ToBytes(String(input.base64 || ""));
  if (!bytes.length) return { ok: false, error: "EMPTY_EXPORT", detail: "导出数据为空" };
  const blob = new Blob([bytes], { type: String(input.mime || "image/png") });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器把下载取消掉
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, path: fileName, fileName, bytes: bytes.length };
}

async function canvasCommand(input: Row): Promise<Row> {
  const type = String(input.type || "");
  if (type === "canvas/globalAssets") return globalAssets(Number(input.limit) || 60, !!input.refresh);
  if (type === "canvas/libraryList") {
    const data = await rawLibrary();
    const q = String(input.query || "").toLowerCase();
    const items = (data.libraries || []).flatMap((lib: Row) => categories(lib, true).flatMap((cat: Row) => (cat.items || []).map((item: Row) => ({ ref: String(item.url || ""), name: String(item.name || "素材"), mimeType: item.kind === "video" ? "video/mp4" : item.kind === "audio" ? "audio/mpeg" : "image/png", thumbnail: String(item.thumbnail || item.url || "") })))).filter((item: Row) => item.ref && (!q || item.name.toLowerCase().includes(q))).slice(0, Number(input.limit) || 60);
    return { ok: true, items };
  }
  if (type === "canvas/assetLibrary/ensure") return ensureLibrary(String(input.libraryId || ""));
  if (type === "canvas/assetLibrary/list") {
    const data = await rawLibrary();
    // categoryIds 给保存弹窗做 folder → 所属资产库 的映射（多库时按文件夹所在的库保存）
    return { ok: true, libraries: (data.libraries || []).map((lib: Row) => ({ ...libraryOut(lib), categoryIds: categories(lib, false).map((cat: Row) => String(cat.id)) })) };
  }
  if (type === "canvas/assetLibrary/get") return getItems(String(input.libraryId || ""));
  if (type === "canvas/assetLibrary/import") return afterLibraryWrite(importAsset(input));
  if (type === "canvas/assetLibrary/upsert") return afterLibraryWrite(upsert(input));
  if (type === "canvas/assetLibrary/delete") return afterLibraryWrite(commandOf(`/api/asset-library/items/${encodeURIComponent(String(input.itemId || ""))}`, { method: "DELETE" }));
  if (type === "canvas/assetLibrary/folderList") {
    const lib = findLibrary(await rawLibrary(), String(input.libraryId || ""));
    return { ok: true, folders: categories(lib, true).map((cat: Row) => ({ name: String(cat.name), count: (cat.items || []).length, custom: true })) };
  }
  if (type === "canvas/assetLibrary/folderCreate") {
    const made = await request("/api/asset-library/categories", json({ library_id: String(input.libraryId || ""), name: String(input.name || ""), type: "image", ...(input.parentId ? { parent_id: String(input.parentId) } : {}) }));
    return { ok: true, folder: made.category };
  }
  if (type === "canvas/assetLibrary/folderRename") {
    const lib = findLibrary(await rawLibrary(), String(input.libraryId || ""));
    const cat = String(input.categoryId || "") ? categories(lib, true).find((row: Row) => String(row.id) === String(input.categoryId)) : categories(lib, true).find((row: Row) => row.name === input.from);
    if (!cat) throw new Error("文件夹不存在");
    const made = await request(`/api/asset-library/categories/${encodeURIComponent(String(cat.id))}`, json({ name: String(input.to || ""), library_id: String(input.libraryId || "") }, "PATCH"));
    return { ok: true, folder: made.category };
  }
  if (type === "canvas/assetLibrary/folderDelete") {
    const lib = findLibrary(await rawLibrary(), String(input.libraryId || ""));
    const cat = String(input.categoryId || "") ? categories(lib, false).find((row: Row) => String(row.id) === String(input.categoryId)) : categories(lib, false).find((row: Row) => row.name === input.name);
    if (!cat) throw new Error("文件夹不存在");
    const made = await commandOf(`/api/asset-library/categories/${encodeURIComponent(String(cat.id))}?library_id=${encodeURIComponent(String(input.libraryId || ""))}`, { method: "DELETE" });
    return { ok: true, ...made };
  }
  if (type === "canvas/assetLibrary/folderMove") {
    const cat = await imageCategory(String(input.libraryId || ""), String(input.folder || "未分组"));
    return commandOf("/api/asset-library/items/move", json({ library_id: String(input.libraryId || ""), target_category_id: cat.id, ids: [String(input.itemId || "")] }));
  }
  if (type === "canvas/assetLibrary/syncSources") return { ok: true };
  if (type === "canvas/saveExport") return saveExport(input);
  if (type === "canvas/models") return { ok: true, models: [] };
  return { ok: false, error: "NOT_SUPPORTED", detail: `当前 NOVAI 不支持 ${type}` };
}

function disabledSkills(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem("canvas-next:novai-skills-off") || "[]")); } catch { return new Set(); }
}

function saveDisabledSkills(ids: Set<string>) {
  try { localStorage.setItem("canvas-next:novai-skills-off", JSON.stringify([...ids])); } catch { /* ignore */ }
}

/** 技能正文缓存：列表接口不返回 SKILL.md，正文要逐条去 export 拿；key 只用 id，reload / save 时整体作废 */
const skillBodyCache = new Map<string, string>();
const SKILL_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

/** 正文（去掉 YAML frontmatter）才是提示词；取不到返回空串，由调用方退回 description */
async function skillInstructions(id: string): Promise<string> {
  const hit = skillBodyCache.get(id);
  if (hit !== undefined) return hit;
  try {
    const response = await fetch(`/api/skills/${encodeURIComponent(id)}/export`);
    if (!response.ok) return "";
    const body = (await response.text()).replace(SKILL_FRONTMATTER, "").trim();
    if (body) skillBodyCache.set(id, body);
    return body;
  } catch { return ""; }
}

/** 并发上限：技能多时别串行把 / 菜单拖到几秒（结果顺序与入参一致） */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; out[index] = await run(items[index]); }
  }));
  return out;
}

async function skillCommand(input: Row): Promise<Row> {
  const command = String(input.command || "");
  const payload = input.payload || {};
  if (command === "skill/list" || command === "skill/reload") {
    if (command === "skill/reload") skillBodyCache.clear();
    const data = await request("/api/skills");
    const disabled = disabledSkills();
    // 内置技能包（skill_type=system）也是真技能：以前按类型过滤掉，/ 菜单就空了
    // 官方技能要先去应用市场「添加到助手」（后端据此置 enabled）；未添加的不列进画布技能中心
    const rows: Row[] = (Array.isArray(data.skills) ? data.skills : []).filter((skill: Row) => !(skill.skill_type === "system" && skill.enabled === false));
    const bodies = await mapLimit(rows, 4, (skill: Row) => skillInstructions(String(skill.id || "")));
    return { ok: true, value: { items: rows.map((skill: Row, index: number) => {
      const id = String(skill.id || "");
      const official = skill.skill_type === "system";
      const description = String(skill.description || "");
      return {
        id, name: String(skill.name || id), description,
        enabled: skill.enabled !== false && !disabled.has(id),
        builtin: official, origin: official ? "official" : "custom", visibleInApp: true,
        source: { format: "skill.md", instructions: bodies[index] || description },
      };
    }).filter((skill: Row) => !!skill.id) } };
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
    skillBodyCache.delete(String(skill.id || ""));
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
  if (type === "task/approve") {
    // 方案卡上的「执行」：后端沿用原 run 的指令/画布/模型，带 approved_steps 开一次新 run
    const approved = await request(`/api/agent/runs/${encodeURIComponent(String(payload.taskId || ""))}/approve`, json({ steps: Array.isArray(payload.steps) ? payload.steps : [] }));
    const taskId = String(approved?.taskId || approved?.runId || "");
    if (!taskId) throw new Error("批准方案后没有返回新的运行 ID");
    return { ok: true, taskId, status: "RUNNING" };
  }
  if (type === "task/run") {
    const context = payload.canvasContext || {};
    const configId = String(context.modelConfigId || "");
    const splitAt = configId.indexOf("::");
    const provider = splitAt >= 0 ? configId.slice(0, splitAt) : "comfly";
    const model = splitAt >= 0 ? configId.slice(splitAt + 2) : configId;
    const resourceRefs = Array.isArray(context.resourceRefs) ? context.resourceRefs.map(String).filter(Boolean) : [];
    const referenceVideos = resourceRefs.filter((url: string) => /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i.test(url));
    const referenceImages = resourceRefs.filter((url: string) => !referenceVideos.includes(url));
    const response = await fetch("/api/agent/run", json({
      canvas_id: String(context.canvasId || ""),
      instruction: String(payload.goal || ""),
      provider,
      model,
      ms_model: provider === "modelscope" ? model : "",
      image_provider: String(context.imageProvider || ""),
      image_model: String(context.imageModel || ""),
      mode: context.mode === "run" ? "run" : "plan",
      // 模型强度（low/mid/high/xhigh/max）：后端映射到上游 reasoning 参数，不支持时安全降级；空串 = 默认
      think_level: String(context.thinkLevel || ""),
      // 技能正文 / 点名应用单独传：进系统提示，不占 instruction 的长度
      skill_name: String(context.skillName || ""),
      skill_prompt: String(context.skillPrompt || "").slice(0, 20000),
      apps: Array.isArray(context.apps) ? context.apps.slice(0, 8) : [],
      // 带 thread_id：后端用这条线程的历史当上下文，并把本轮 user + assistant 追加回线程
      thread_id: String(payload.threadId || context.threadId || ""),
      // 告诉后端这是智能画布BEAT：节点按 canvas-next 格式读写，生成交回画布引擎执行
      renderer: "beat",
      // 面板选了「自动」：直接执行，不出方案卡
      auto_execute: context.mode === "run",
      // 步数不再由思考强度决定（思考强度只影响提示/追问）：0 = 不限步数，长任务靠服务端时长/轮次刹车
      max_steps: 0,
      focus: {
        selected_node_ids: Array.isArray(context.selectedNodeIds) ? context.selectedNodeIds : [],
        reference_images: referenceImages,
        reference_videos: referenceVideos,
        references: (Array.isArray(context.selectedNodeIds) ? context.selectedNodeIds : []).map((id: string) => ({ id, role: "context", source: "node" })),
      },
      history: [],
    }));
    // 成功时是一条持续到运行结束的 SSE 流：只读响应头拿 run id，别等正文（等正文会一直卡到整个任务跑完，面板收不到进度）
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || data.error || `HTTP ${response.status}`);
    }
    const taskId = String(response.headers.get("X-NOVAI-Run-Id") || "");
    if (!taskId) throw new Error("Agent 运行没有返回任务 ID");
    if (response.body) void response.body.cancel().catch(() => undefined);
    return { ok: true, taskId, status: "RUNNING" };
  }
  if (type === "task/regenerate") {
    // 审查不合格 → 后端按修订提示词 / 用户描述改节点参数并立刻开跑，跑完自动复审再问
    const items = (Array.isArray(payload.items) ? payload.items : []).map((item: Row) => ({
      node_id: String(item?.node_id || ""),
      label: String(item?.label || "").slice(0, 60),
      kind: String(item?.kind || ""),
      prompt: String(item?.prompt || "").slice(0, 2000),
      issues: Array.isArray(item?.issues) ? item.issues.map(String).slice(0, 8) : [],
    })).filter((item: Row) => !!item.node_id);
    if (!items.length) throw new Error("没有要重新生成的结果");
    // provider / model 拿不到就留空，后端回退默认模型
    const configId = String(payload.modelConfigId || "");
    const splitAt = configId.indexOf("::");
    const response = await fetch("/api/agent/regenerate", json({
      canvas_id: String(payload.canvasId || ""),
      thread_id: String(payload.threadId || ""),
      description: String(payload.description || "").slice(0, 1200),
      items,
      provider: splitAt >= 0 ? configId.slice(0, splitAt) : String(payload.provider || ""),
      model: splitAt >= 0 ? configId.slice(splitAt + 2) : String(payload.model || ""),
      think_level: String(payload.thinkLevel || ""),
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || data.error || `HTTP ${response.status}`);
    // 和 task/run 一样：拿到 run id 就走既有的 task/get 快照监听
    const taskId = String(data.taskId || data.runId || "");
    if (!taskId) throw new Error("重新生成没有返回任务 ID");
    return { ok: true, taskId, status: String(data.status || "RUNNING"), steps: Number(data.steps) || 0 };
  }
  if (type === "task/get") return commandOf(`/api/agent/runs/${encodeURIComponent(String(payload.taskId || ""))}/snapshot`);
  if (type === "task/list") return commandOf("/api/agent/tasks");
  if (type === "task/cancel") return commandOf(`/api/agent/runs/${encodeURIComponent(String(payload.taskId || ""))}/cancel`, json({}));
  // 对话线程：NOVAI 按画布持久化，退出/刷新画布后靠它恢复历史
  const canvasId = String(payload.canvasId || "");
  const threadId = String(payload.threadId || "");
  if (type === "thread/list") {
    if (!canvasId) return { ok: false, error: "canvasId 不能为空" };
    return commandOf(`/api/agent/threads?canvas_id=${encodeURIComponent(canvasId)}`);
  }
  if (type === "thread/messages") {
    if (!canvasId || !threadId) return { ok: false, error: "canvasId / threadId 不能为空" };
    const limit = Math.max(1, Math.min(200, Number(payload.limit) || 60));
    // before：往上翻时只要这个位置之前的一页
    const before = Number.isInteger(payload.before) && payload.before >= 0 ? `&before=${payload.before}` : "";
    return commandOf(`/api/agent/threads/${encodeURIComponent(threadId)}/messages?canvas_id=${encodeURIComponent(canvasId)}&limit=${limit}${before}`);
  }
  if (type === "thread/switch") {
    if (!canvasId || !threadId) return { ok: false, error: "canvasId / threadId 不能为空" };
    return commandOf("/api/agent/threads/switch", json({ canvas_id: canvasId, thread_id: threadId }));
  }
  if (type === "thread/new") {
    if (!canvasId) return { ok: false, error: "canvasId 不能为空" };
    return commandOf("/api/agent/threads/new", json({ canvas_id: canvasId }));
  }
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
  const previous = root.novai || root.openarc || {};
  const bridge = {
    ...previous,
    canvas: { command: (input: Row) => call(canvasCommand, input) },
    model: { command: (input: Row) => call(modelCommand, input) },
    skill: { command: (input: Row) => call(skillCommand, input) },
    resource: { command: (input: Row) => call(resourceCommand, input) },
    task: { command: (input: Row) => call(taskCommand, input) },
    // 剪辑时间线导出 MP4：NOVAI 后端用 ffmpeg 按时间线渲染（片段位置 / 变速 / 音量 / 淡入淡出 / 转场 / 字幕）
    timeline: {
      render: async (payload: Row): Promise<Row> => {
        const response = await fetch("/api/timeline/render", json(payload));
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || `导出失败（HTTP ${response.status}）`);
        return data;
      },
    },
  };
  root.novai = bridge;
  // 兼容：外部桌面外壳与老探针脚本按旧名字取宿主桥 —— 指向同一个对象，不是副本
  root.openarc = bridge;
}