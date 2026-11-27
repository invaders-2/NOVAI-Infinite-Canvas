/**
 * 消息剪贴板：点消息的「复制」时，把这条消息带的画布节点一起带走；粘回输入框还原成真正的节点引用
 * （引用胶囊 + 本次对话的上下文缩略图行），而不是只剩一段文字。
 *
 * 剪贴板里写两份：
 *   · text/plain —— 给人看的可读文本（和改动前完全一致，粘到外部应用不会多出任何标记）；
 *   · text/html  —— 同一份可读文本（换行变 <br>）+ 一份 HTML 注释里的机器载荷（base64 的 JSON）。
 * 载荷里的 text 是「@标题」换成 @{节点id} 记号后的版本，粘贴时直接按输入框既有的记号路径落成胶囊。
 */
export type MsgClipRef = { id: string; kind: string; title: string };
/** skills：这条消息带的技能名（本轮技能）。v 仍是 1：旧载荷没有这个字段也算合法 */
export type MsgClip = { v: 1; text: string; refs: MsgClipRef[]; skills?: string[] };

/** 机器载荷的标记：放在 HTML 注释里，可见文本里绝不会出现 */
const CLIP_HTML_PREFIX = "novai-agent-message:";
const CLIP_HTML_RE = new RegExp("<!--\\s*" + CLIP_HTML_PREFIX + "([A-Za-z0-9+/=]+)\\s*-->");

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const base64OfUtf8 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const utf8OfBase64 = (b64: string): string => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/** 正文里已经写着记号的引用（历史消息 / 手动粘过）不再补到末尾 */
const tokenIdsOf = (text: string): Set<string> => {
  const out = new Set<string>();
  const re = /@(?:ref|app|skill)?\{([^}\n]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
};

const appendMissingRefs = (text: string, refs: MsgClipRef[], used: Set<string>): string => {
  const miss = refs.filter((r) => !!r && !!r.id && !used.has(r.id));
  if (!miss.length) return text;
  const sep = text && !/\s$/.test(text) ? " " : "";
  return text + sep + miss.map((r) => "@{" + r.id + "}").join(" ");
};

/**
 * 「@标题」→ @{节点id}：和消息气泡 textNodes 同一套规则——同名多处按引用顺序取没用过的那个，
 * 同一处有长短两个候选时取长的（「图片1」不会被「图片」截走）；正文里没出现过的引用把记号补到末尾，
 * 跟气泡「没内联到的缩略图补在末尾」一致。纯字符串扫描（标题里有正则特殊字符也不怕）。
 */
export function tokenizeRefs(text: string, refs: MsgClipRef[]): string {
  const src = String(text || "");
  const list = (refs || []).filter((r) => !!r && !!r.id);
  if (!list.length) return src;
  const used = tokenIdsOf(src);
  const hits: Array<{ start: number; end: number; id: string }> = [];
  for (const r of list) {
    const title = String(r.title || "").trim();
    if (!title) continue;
    let from = 0;
    for (;;) {
      const at = src.indexOf("@" + title, from);
      if (at < 0) break;
      hits.push({ start: at, end: at + 1 + title.length, id: r.id });
      from = at + 1;
    }
  }
  if (!hits.length) return appendMissingRefs(src, list, used);
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let out = "";
  let cur = 0;
  for (let i = 0; i < hits.length; i += 1) {
    let hit = hits[i];
    if (hit.start < cur) continue;
    for (let j = i; j < hits.length && hits[j].start === hit.start && hits[j].end === hit.end; j += 1) {
      if (!used.has(hits[j].id)) { hit = hits[j]; break; }
    }
    out += src.slice(cur, hit.start) + "@{" + hit.id + "}";
    used.add(hit.id);
    cur = hit.end;
  }
  out += src.slice(cur);
  return appendMissingRefs(out, list, used);
}

/** 文本里已有的技能名（@skill{名}）：技能只按这个记号算，绝不拿节点标题去猜技能 */
const skillNamesOf = (text: string): Set<string> => {
  const out = new Set<string>();
  const re = /@skill\{([^}\n]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
};

/**
 * 载荷 text 的生成：先按节点规则把「@标题」换成 @{id}，再保证每个技能名在正文里有 @skill{名} 记号
 * （正文里没有的技能补到末尾，和节点「没出现过的补末尾」一致）。技能名按 @skill{…} 原样比对。
 */
export function buildClipText(rich: string, refs: MsgClipRef[], skills: string[] = []): string {
  const out = tokenizeRefs(rich, refs);
  const names = [...new Set((skills || []).map((s) => String(s || "").trim()).filter(Boolean))];
  if (!names.length) return out;
  const have = skillNamesOf(out);
  const miss = names.filter((n) => !have.has(n));
  if (!miss.length) return out;
  const sep = out && !/\s$/.test(out) ? " " : "";
  return out + sep + miss.map((n) => "@skill{" + n + "}").join(" ");
}

/** 写进 text/html 的那份：可读文本（转义 + 换行 <br>）+ 注释里的机器载荷 */
export function buildMessageClipHtml(plain: string, clip: MsgClip): string {
  return escapeHtml(String(plain || "")).replace(/\n/g, "<br>") + "<!--" + CLIP_HTML_PREFIX + base64OfUtf8(JSON.stringify(clip)) + "-->";
}

/** 从 text/html 里解出消息载荷；格式不认识 / 字段不全 / 解不开都返回 null（按普通粘贴处理） */
export function parseMessageClipHtml(html: string): MsgClip | null {
  const m = CLIP_HTML_RE.exec(String(html || ""));
  if (!m) return null;
  try {
    const data = JSON.parse(utf8OfBase64(m[1])) as { v?: unknown; text?: unknown; refs?: unknown; skills?: unknown };
    if (!data || data.v !== 1 || typeof data.text !== "string" || !Array.isArray(data.refs)) return null;
    const refs: MsgClipRef[] = [];
    for (const raw of data.refs as Array<{ id?: unknown; kind?: unknown; title?: unknown }>) {
      if (!raw || typeof raw.id !== "string" || !raw.id) continue;
      refs.push({ id: raw.id, kind: typeof raw.kind === "string" ? raw.kind : "node", title: typeof raw.title === "string" ? raw.title : "" });
      if (refs.length >= 64) break;
    }
    // skills 是后加的：旧载荷没有这个字段照样能用（不报错、不丢节点）
    const skills: string[] = [];
    for (const raw of Array.isArray(data.skills) ? data.skills : []) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name || skills.includes(name)) continue;
      skills.push(name);
      if (skills.length >= 32) break;
    }
    return { v: 1, text: data.text, refs, ...(skills.length ? { skills } : {}) };
  } catch { return null; }
}

/** 写剪贴板：优先同时写 text/plain + text/html；不支持 / 被拒时退回只写纯文本。
 *  返回 true 表示 html 也写进去了（有节点一起走的文案）；写纯文本也失败时抛出，由调用方给「剪贴板不可用」。 */
export async function writeClipboard(plain: string, html: string): Promise<boolean> {
  const cb = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const Item = typeof window === "undefined" ? undefined : (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (cb && typeof cb.write === "function" && typeof Item === "function") {
    try {
      await cb.write([new Item({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      return true;
    } catch { /* 桌面壳 / 权限 / 非安全上下文：退回纯文本 */ }
  }
  await cb!.writeText(plain);
  return false;
}
