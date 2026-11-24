/**
 * Midjourney 提示词清洗（与后端 main.py 的 midjourney_prompt_params 同一套规则，
 * tests/test_canvas_gen_pipe.js 拿两边输出对拍，规则只改一处会被测试挡下来）。
 *
 * MJ 把提示词里的 "-xxx" 当参数解析：单横杠这种非法 token 会被直接拒单（真机失败样本：
 * upstream code=9 upstream submit failure，尾部残留 "-ar 16:9 -v 6.0"；同段文字去掉就成功）。
 * 所以这里做「规范化 + 映射」而不是全删：
 *   - 所有 -flag / --flag 写回合法的 --flag；
 *   - ar / v / s 画布 body 里已有等价字段（body 优先），从提示词摘掉避免打架；
 *   - --no / --iw / --cref / --sref / --weird / --chaos / --tile / --repeat / --raw / --stop
 *     面板没有对应控件，规范化后原样保留，交给上游 MJ 自己解析（不静默丢用户能力）；
 *   - 只认已知参数名，正文里的普通连字符（black slip dress / e-commerce）永远不动。
 */
export const MJ_PROMPT_LIMIT = 2000;

const PARAM_NAMES = "ar|aspect|v|version|s|stylize|q|quality|iw|c|chaos|niji|repeat|stop|weird|cref|sref|dref"
  + "|seed|video|hd|beta|uplight|upbeta|draft|motion|turbo|relax|fast|raw|tile|style|no|cw|sw";
// 参数值：一个非空白 token，但不许以 "-" 开头（否则 "--ar --v 6.0" 会把下一个参数当值吃掉）
const PARAM_VALUE = "[^-\\s,。;][^\\s,。;]*";
// 参数 -> body 字段（只有这些从提示词摘出来，其余保留）
const BODY_PARAMS: Record<string, string> = {
  ar: "aspect", aspect: "aspect",
  v: "version", version: "version",
  s: "stylize", stylize: "stylize",
};
const VALUE_OK: Record<string, RegExp> = {
  aspect: /^\d{1,2}:\d{1,2}$/,
  version: /^\d{1,2}(?:\.\d)?$/,
  stylize: /^\d{1,4}$/,
};

const RULES: Array<[RegExp, string]> = [
  [/\`\`\`[^\n]*\n?/g, " "],
  [/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, " "],
  [/#{1,6}(?=\s|[\u4e00-\u9fa5])/g, ""],
  [/^\s{0,3}>\s?/gm, " "],
  [/^\s*(?:[-*_]\s*){3,}$/gm, " "],
  [/\*\*|__/g, ""],
  [/\`/g, ""],
  [/\|/g, " "],
  [/^\s*[-*+]\s+/gm, " "],
  // 先压成一行：参数 token 才能用 ^ / 空白定界（否则行首参数匹配不到）
  [/[\r\n\t]+/g, " "],
  // markdown 的 --- 只变空格，不再压成单横杠（单横杠会被上游当参数）
  [/-{3,}/g, " "],
];

const PARAM_RE = new RegExp("(^|\\s)(-{1,2})(" + PARAM_NAMES + ")(?![a-zA-Z])(?:[ \\t]*[=:]?[ \\t]*(" + PARAM_VALUE + "))?", "gi");

export type MjPromptParams = { aspect?: string; version?: string; stylize?: string };

function bodyParamKey(name: string, value: string): string | null {
  const key = BODY_PARAMS[String(name || "").toLowerCase()];
  if (!key) return null;
  const ok = VALUE_OK[key];
  return ok && ok.test(String(value || "").trim()) ? key : null;
}

/** 清洗 + 拆出可映射到 body 的 MJ 参数（aspect / version / stylize）。 */
export function midjourneyPromptParams(prompt: string, limit = MJ_PROMPT_LIMIT): { text: string; params: MjPromptParams } {
  let text = String(prompt || "");
  for (const [re, to] of RULES) text = text.replace(re, to);
  const params: MjPromptParams = {};
  text = text.replace(PARAM_RE, (_match, prefix: string, _dashes: string, name: string, rawValue: string) => {
    const value = String(rawValue || "").trim();
    const suffix = value ? " " + value : "";
    const key = bodyParamKey(name, value);
    if (key) {
      if (params[key as keyof MjPromptParams] === undefined) params[key as keyof MjPromptParams] = value;
      return prefix || "";
    }
    return (prefix || "") + "--" + name + suffix;
  });
  text = text.replace(/ {2,}/g, " ").trim();
  if (text.length > limit) text = text.slice(0, limit).trim();
  return { text, params };
}

export function midjourneyPrompt(prompt: string, limit = MJ_PROMPT_LIMIT): string {
  return midjourneyPromptParams(prompt, limit).text;
}
