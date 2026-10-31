/**
 * 元素（TapNow Elements）：把角色、产品、场景、风格存成一组参考图 + 描述，在任何画布的提示词里用 @名字 反复引用。
 *
 *   存储      本机 localStorage「canvas-next:elements」做缓存；桌面版同步到个人资产库的「AI 角色」条目
 *             （canvas/assetLibrary/character*），换设备 / 换画布都能用；参考图先存进资源库，只留引用
 *   引用      提示词里写 @名字：请求组装时把 @名字 换成「名字」（描述），参考图按模型能力加成参考输入
 *   改动通知  window 事件 cn:elements
 */
import type { GenInput } from "./backend/types";
import type { GenKind, ModelSpec, VideoParams } from "./model";

export type ElementKind = "character" | "product" | "scene" | "style" | "other";
export type CanvasElement = { id: string; name: string; kind: ElementKind; desc: string; refs: string[]; at: number; /** 资产库里对应的角色条目 id（已同步） */ remoteId?: string };

export const ELEMENT_KINDS: Array<[ElementKind, string]> = [["character", "角色"], ["product", "产品"], ["scene", "场景"], ["style", "风格"], ["other", "其他"]];
export const ELEMENT_MAX_REFS = 4;
const KEY = "canvas-next:elements";
const NAME_RE = /^[^\s@·,，。!?！？:：;；"'“”‘’()[\]{}<>]{1,20}$/;

let cache: CanvasElement[] | null = null;
export function listElements(): CanvasElement[] {
  if (cache) return cache;
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); cache = Array.isArray(v) ? v.filter((e) => e && typeof e.name === "string" && Array.isArray(e.refs)) : []; } catch { cache = []; }
  return cache;
}
function persist(list: CanvasElement[]) {
  cache = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 空间不够时只在本次会话里有效 */ }
  try { window.dispatchEvent(new CustomEvent("cn:elements")); } catch { /* 非浏览器环境 */ }
}

/** 名字用作 @引用，不能有空格和标点，同名覆盖前要先确认（UI 负责） */
export function nameError(name: string, list = listElements(), selfId?: string): string {
  const n = name.trim();
  if (!n) return "给元素起个名字";
  if (!NAME_RE.test(n)) return "名字最多 20 个字，不能有空格、@ 和标点（会用 @名字 引用）";
  if (list.some((e) => e.name === n && e.id !== selfId)) return `已经有叫「${n}」的元素了`;
  return "";
}

export function saveElement(e: Omit<CanvasElement, "id" | "at"> & { id?: string }): CanvasElement {
  const list = listElements();
  const err = nameError(e.name, list, e.id); if (err) throw new Error(err);
  const prev = e.id ? list.find((x) => x.id === e.id) : undefined;
  const item: CanvasElement = { id: e.id || "el_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: e.name.trim(), kind: e.kind, desc: e.desc.trim().slice(0, 300), refs: e.refs.filter(Boolean).slice(0, ELEMENT_MAX_REFS), at: Date.now(), ...(prev?.remoteId ? { remoteId: prev.remoteId } : {}) };
  persist([item, ...list.filter((x) => x.id !== item.id)]);
  void pushElement(item);
  return item;
}
export function deleteElement(id: string) {
  const e = listElements().find((x) => x.id === id);
  persist(listElements().filter((x) => x.id !== id));
  if (e?.remoteId) void withLibrary((cmd, libraryId) => cmd({ type: "canvas/assetLibrary/characterDelete", libraryId, id: e.remoteId }));
}

/* ---------- 桌面版同步：个人资产库的 AI 角色条目 ---------- */
type Cmd = (r: Record<string, unknown>) => Promise<Record<string, any>>;
let cmdOverride: Cmd | null | undefined;
/** 测试用：替换桌面端命令通道（null = 没有桌面端） */
export function setElementCommand(c: Cmd | null | undefined) { cmdOverride = c; libraryId = null; }
const cmdOf = (): Cmd | null => {
  if (cmdOverride !== undefined) return cmdOverride;
  try { const c = (globalThis as { openarc?: { canvas?: { command?: Cmd } } }).openarc?.canvas?.command; return typeof c === "function" ? c : null; } catch { return null; }
};
let libraryId: string | null = null;
async function withLibrary<T>(fn: (cmd: Cmd, libraryId: string) => Promise<T>): Promise<T | null> {
  const cmd = cmdOf(); if (!cmd) return null;
  try {
    if (!libraryId) { const r = await cmd({ type: "canvas/assetLibrary/ensure" }); libraryId = r && r.ok && r.library?.id ? String(r.library.id) : null; }
    return libraryId ? await fn(cmd, libraryId) : null;
  } catch { return null; }
}
const KIND_TAG = /^element-kind:(\w+)/;
const syncable = (refs: string[]) => refs.filter((r) => /^(openarc-asset:|https?:\/\/)/i.test(r));
/** 本地改动推到资产库（失败只留在本机，下次同步再试） */
export async function pushElement(e: CanvasElement): Promise<boolean> {
  const r = await withLibrary((cmd, lib) => cmd({ type: e.remoteId ? "canvas/assetLibrary/characterUpdate" : "canvas/assetLibrary/characterCreate", libraryId: lib, ...(e.remoteId ? { id: e.remoteId } : {}), name: e.name, description: e.desc, prompt: "element-kind:" + e.kind, referenceUrls: syncable(e.refs) }));
  if (!r || !r.ok) return false;
  const rid = r.character?.id ? String(r.character.id) : e.remoteId;
  if (rid && rid !== e.remoteId) persist(listElements().map((x) => (x.id === e.id ? { ...x, remoteId: rid } : x)));
  return true;
}
/** 从资产库拉取（以资产库为准）；本机还没同步上去的补推一次 */
export async function syncElements(): Promise<boolean> {
  const r = await withLibrary((cmd, lib) => cmd({ type: "canvas/assetLibrary/characterList", libraryId: lib }));
  if (!r || !r.ok || !Array.isArray(r.characters)) return false;
  // 资产库里的「AI 角色」都算元素（没有类型标记的按角色）
  const local = listElements();
  const remote: CanvasElement[] = r.characters.map((c: any) => {
    const mine = local.find((l) => l.remoteId === String(c.id));
    const kind = (String(c.prompt || "").match(KIND_TAG)?.[1] || mine?.kind || "character") as ElementKind;
    return { id: mine?.id || "el_" + String(c.id), remoteId: String(c.id), name: String(c.name || ""), kind: ELEMENT_KINDS.some(([k]) => k === kind) ? kind : "other", desc: String(c.description || ""), refs: (Array.isArray(c.referenceUrls) ? c.referenceUrls : []).slice(0, ELEMENT_MAX_REFS), at: Number(c.updatedAt || c.createdAt || 0) };
  }).filter((e: CanvasElement) => e.name);
  const pending = local.filter((l) => !l.remoteId);
  persist([...pending, ...remote].sort((a, b) => b.at - a.at));
  for (const e of pending) await pushElement(e);
  return true;
}
/** 测试用：清掉内存缓存，重新从存储读 */
export function resetElementCache() { cache = null; }

/** 提示词里出现的 @名字（长名字优先，避免 @小白 吃掉 @小白猫） */
export function mentionedElements(prompt: string, list = listElements()): CanvasElement[] {
  const p = String(prompt || ""); if (!p.includes("@")) return [];
  const sorted = [...list].sort((a, b) => b.name.length - a.name.length); const hit: CanvasElement[] = []; let rest = p;
  for (const e of sorted) { const tag = "@" + e.name; if (rest.includes(tag)) { hit.push(e); rest = rest.split(tag).join(" "); } }
  return hit;
}

/** @名字 → 「名字」（描述） */
export function applyElements(prompt: string, list = listElements()): string {
  let p = String(prompt || "");
  for (const e of mentionedElements(p, list)) p = p.split("@" + e.name).join(e.desc ? `「${e.name}」（${e.desc}）` : `「${e.name}」`);
  return p;
}

/** 这个模型 / 模式还能再收几张参考图（不支持参考图返回 0） */
export function refRoom(kind: GenKind, m: ModelSpec | undefined, params: unknown, inputs: GenInput[]): number {
  if (!m) return 0;
  const used = inputs.filter((i) => i.kind === "image" && i.role === "reference").length;
  if (kind === "image") return m.i2i ? Math.max(0, (m.maxRefs ?? 0) - used) : 0;
  if (kind === "text") return m.vision ? Math.max(0, 4 - used) : 0;
  if (kind === "video") { const mode = (params as VideoParams).mode; return mode === "参考生视频" || mode === "视频编辑" ? Math.max(0, (m.maxRefs ?? 0) - used) : 0; }
  return 0;
}

/** 被 @ 的元素的参考图 → 参考输入（按剩余名额，元素之间轮流取，保证每个元素至少一张） */
export function elementInputs(prompt: string, kind: GenKind, m: ModelSpec | undefined, params: unknown, inputs: GenInput[], list = listElements()): GenInput[] {
  const els = mentionedElements(prompt, list).filter((e) => e.refs.length); let room = refRoom(kind, m, params, inputs);
  const out: GenInput[] = [];
  for (let round = 0; room > 0 && els.some((e) => e.refs[round]); round++) {
    for (const e of els) {
      if (room <= 0) break; const url = e.refs[round]; if (!url) continue;
      out.push({ nodeId: "element:" + e.id + ":" + round, title: e.name, kind: "image", order: inputs.length + out.length + 1, role: "reference", url });
      room--;
    }
  }
  return out;
}
