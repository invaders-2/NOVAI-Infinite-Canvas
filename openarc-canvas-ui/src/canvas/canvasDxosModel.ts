/**
 * 画布宿主浮层（协作 / .dxcanvas 打包）的纯函数层。
 *
 * 与 canvasShareModel.ts 同一分工：组件只做状态与渲染，错误文案、字节编解码、
 * 文件名与事件摘要都放在这里，便于单独核对「不伪造」口径：
 *   · 命令失败只按后端真实 error / detail 生成文案，不把失败当成功；
 *   · .dxcanvas 内联上限取后端 canvas-dxos-commands.cjs 的 32MB，绝不截断；
 *   · 下载文件名只由画布标题与 canvasId 组成，不含绝对路径。
 */

export type Cmd = (payload: Record<string, unknown>) => Promise<any>;

/** 与 electron/canvas-dxos-commands.cjs 的 MAX_INLINE_PACKAGE_BYTES 同一个值。 */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

const HOST_ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: "画布桥没有接入（宿主不可用）",
  CANVAS_UNAVAILABLE: "画布服务未装配（后端不可用）",
  CANVAS_COMMAND_NOT_ALLOWED: "当前构建没有登记这条画布命令（不可用）",
  NOT_IMPLEMENTED: "后端没有实现这条画布命令（不可用）",
  NOT_FOUND: "这本画布已经不存在或无法打开",
  NOT_FOUND_OR_FORBIDDEN: "这本画布已不可访问（可能已被移出共享或删除）",
  READ_ONLY: "当前是只读权限，不能执行这个操作",
  FORBIDDEN: "没有权限执行这个操作",
  INVALID_INPUT: "请求内容不完整或不正确",
  LIMIT_EXCEEDED: "超过后端上限",
  REVISION_CONFLICT: "版本冲突：画布在别处被修改过",
  INTERNAL_ERROR: "画布服务内部出错",
};

/** 结构化失败 → 中文原因（保留后端错误码，不吞掉 detail）。 */
export function hostCommandError(res: any, fallback: string): string {
  const code = res && typeof res === "object" ? String(res.error || "") : "";
  const known = HOST_ERROR_TEXT[code];
  if (known) return known + (code ? "（" + code + "）" : "");
  const detail = res && typeof res === "object" && res.detail != null ? "：" + String(res.detail).slice(0, 160) : "";
  return fallback + (code ? "（" + code + detail + "）" : "");
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

/** 分块编码，避免 String.fromCharCode(...array) 对 32MB 数据一次性展开。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 下载文件名：画布标题（去掉文件系统保留字符）+ 短 canvasId，不含任何路径。 */
export function packageFileName(title: string | undefined, canvasId: string): string {
  const base = String(title || "画布").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "画布";
  const shortId = String(canvasId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return base + (shortId ? "-" + shortId : "") + ".dxcanvas";
}

export type CollabEventView = { key: string; text: string };

/** 协作下行事件 → 一行可读摘要（只描述事件本身，不推断谁在编辑什么）。 */
export function collabEventView(event: any, index: number): CollabEventView {
  const type = String((event && event.type) || "unknown");
  const clientId = String((event && (event.sourceClientId || event.clientId)) || "");
  const name = String((event && event.username) || "") || (clientId ? "客户端 " + clientId.slice(0, 12) : "其他设备");
  if (type === "cursor") {
    const x = Number(event && event.x);
    const y = Number(event && event.y);
    const where = Number.isFinite(x) && Number.isFinite(y) ? "（" + Math.round(x) + ", " + Math.round(y) + "）" : "";
    return { key: type + ":" + clientId + ":" + index, text: "光标 · " + name + where };
  }
  if (type === "patch") {
    const revision = Number(event && event.revision);
    return { key: type + ":" + clientId + ":" + index, text: "补丁 · " + name + (Number.isFinite(revision) ? " revision " + revision : "") };
  }
  if (type === "presence") return { key: type + ":" + index, text: "在线状态变化" };
  return { key: type + ":" + index, text: type };
}

/** 跨域只读/受控调用（photos 图库、developer 插件清单）：同样只在宿主里用，失败一律结构化。 */
export async function callBridge(channel: string, payload: Record<string, unknown>): Promise<any> {
  const api = (window as any).openarc && (window as any).openarc[channel];
  if (!api || typeof api.command !== "function") return { ok: false, error: "NO_BRIDGE", detail: channel };
  try {
    return (await api.command(payload)) || { ok: false, error: "INTERNAL_ERROR" };
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

/** media / photos / developer 等域命令统一是 { ok, value } 信封；这里只做解包，不改语义。 */
export function unwrapValue(res: any): any {
  return res && res.value && typeof res.value === "object" ? res.value : res;
}

export const INVITE_PERMISSIONS = [
  { value: "read", label: "查看者" },
  { value: "edit", label: "编辑者" },
] as const;

export function invitePermissionLabel(value: string | null | undefined): string {
  return value === "edit" ? "编辑者" : "查看者";
}

/** 邀请码错误 → 中文原因（保留后端错误码，不把失败当成功）。 */
export function inviteErrorText(res: any, fallback: string): string {
  const code = res && typeof res === "object" ? String(res.error || "") : "";
  if (code === "READ_ONLY") return "只有所有者或「管理共享」成员可以管理邀请码（READ_ONLY）";
  if (code === "NOT_FOUND") return "邀请口令不存在或已失效（NOT_FOUND）";
  if (code === "INVALID_INPUT") return "邀请口令格式不正确：8 位字母数字，可带一个「-」（INVALID_INPUT）";
  if (code === "FORBIDDEN") return "不能兑换其他组织的邀请口令，或没有权限执行这个操作（FORBIDDEN）";
  return hostCommandError(res, fallback);
}

export function formatJsonText(value: unknown): string {
  try { return JSON.stringify(value == null ? null : value, null, 2); } catch { return String(value); }
}

/** JSON 文本框解析：只接受合法 JSON，空文本视为 null（后端按 null 存储）。 */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const raw = String(text || "").trim();
  if (!raw) return { ok: true, value: null };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch (caught) { return { ok: false, error: "不是合法 JSON：" + (caught instanceof Error ? caught.message : String(caught)) }; }
}

/** 复制口令 / 引用：宿主有剪贴板权限时直接写；失败返回原因，界面提供手动复制兜底。 */
export async function copyToClipboard(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return { ok: false, error: "剪贴板不可用" };
    await navigator.clipboard.writeText(String(text || ""));
    return { ok: true };
  } catch {
    return { ok: false, error: "剪贴板写入被拒绝" };
  }
}
