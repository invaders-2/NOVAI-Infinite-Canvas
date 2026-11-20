/**
 * 预设提示词：只读写画布自己的提示词库（优先 id=canvas-prompts，没有就取第一个非 system 库，
 * 都不存在时建一个「画布提示词」），与系统内置提示词库互不影响。
 * 接口见 server/routes/assets.py：GET /api/prompt-libraries、POST/PATCH/DELETE …/items。
 * 读取失败返回明确错误，不静默吞掉。
 */

export const PROMPT_PRESET_LIMIT = 10000;
const LIBRARY_ID = "canvas-prompts";
const LIBRARY_NAME = "画布提示词";

export type PromptPreset = { id: string; title: string; prompt: string };
export type PresetResult<T> = { ok: true } & T | { ok: false; error: string };

type Row = Record<string, any>;

/** 标题 / 提示词的「字」按码点算：表情不会被当成两个字 */
export const presetTextLength = (text: string) => Array.from(text || "").length;

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || data.error || `HTTP ${response.status}`);
  return data;
}

const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

function librariesOf(data: Row): Row[] {
  const list = data?.library?.libraries;
  return Array.isArray(list) ? list : [];
}

function pickLibrary(data: Row): string {
  const libraries = librariesOf(data);
  // 空串也算没挑到：避免拿到 id 为空的坏条目
  return String(libraries.find((lib) => String(lib.id) === LIBRARY_ID)?.id || libraries.find((lib) => lib.id && String(lib.id) !== "system")?.id || "");
}

/** 找到画布提示词库；一个都没有就建一个。返回库 id 与最新一次读取的数据 */
async function ensureLibrary(): Promise<{ id: string; data: Row }> {
  const first = await request("/api/prompt-libraries");
  const existing = pickLibrary(first);
  if (existing) return { id: existing, data: first };
  const made = await request("/api/prompt-libraries", json({ name: LIBRARY_NAME }));
  const data = made?.library?.libraries ? made : await request("/api/prompt-libraries");
  const id = String(made?.prompt_library?.id || "") || pickLibrary(data);
  if (!id) throw new Error("无法创建画布提示词库");
  return { id, data };
}

function itemOut(item: Row): PromptPreset | null {
  const id = String(item?.id || "");
  // 系统库内置条目是种子数据，不能在这里改
  if (!id || id.startsWith("builtin_")) return null;
  return { id, title: String(item.name || item.title || "未命名预设"), prompt: String(item.positive ?? item.prompt ?? "") };
}

/** 读这一个库的全部预设；空库返回空数组（由界面给空状态） */
export async function listPromptPresets(): Promise<{ ok: true; items: PromptPreset[] } | { ok: false; items: PromptPreset[]; error: string }> {
  try {
    const { id, data } = await ensureLibrary();
    const library = librariesOf(data).find((lib) => String(lib.id) === id);
    if (!library) return { ok: false, items: [], error: "画布提示词库不存在" };
    const items = (Array.isArray(library.items) ? library.items : []).flatMap((item: Row) => {
      const preset = itemOut(item);
      return preset ? [preset] : [];
    });
    return { ok: true, items };
  } catch (error) {
    return { ok: false, items: [], error: errorText(error, "读取预设提示词失败") };
  }
}

/** 新增（id 为空）或修改一条预设 */
export async function savePromptPreset(input: { id?: string; title: string; prompt: string }): Promise<PresetResult<{ item: PromptPreset }>> {
  const title = String(input.title || "").trim();
  const prompt = String(input.prompt || "");
  if (!title) return { ok: false, error: "请填写标题" };
  if (!prompt.trim()) return { ok: false, error: "请填写提示词" };
  if (presetTextLength(prompt) > PROMPT_PRESET_LIMIT) return { ok: false, error: `提示词不能超过 ${PROMPT_PRESET_LIMIT} 字` };
  try {
    const libraryId = (await ensureLibrary()).id;
    const body = { library_id: libraryId, name: title, category: "custom", positive: prompt };
    const made = input.id
      ? await request(`/api/prompt-libraries/items/${encodeURIComponent(input.id)}`, json(body, "PATCH"))
      : await request("/api/prompt-libraries/items", json(body));
    const item = itemOut(made?.item || {});
    if (!item) return { ok: false, error: "保存后没有返回预设内容" };
    return { ok: true, item };
  } catch (error) {
    return { ok: false, error: errorText(error, "保存预设提示词失败") };
  }
}

export async function deletePromptPreset(id: string): Promise<PresetResult<object>> {
  if (!id) return { ok: false, error: "缺少预设 id" };
  try {
    await request(`/api/prompt-libraries/items/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error, "删除预设提示词失败") };
  }
}
