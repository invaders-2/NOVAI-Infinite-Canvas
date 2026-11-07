/**
 * Midjourney 提示词清洗。
 *
 * MJ 把 `--xxx` 当参数解析，提示词里的 markdown（`---`、`##`、`|`、`**`）会被上游当成
 * 「无法识别的参数」直接失败（真实失败样本：Midjourney 任务失败：无法识别的参数: `---`, `##`, …）。
 * 画布会把上游文本节点整段拼进提示词，所以发 MJ 之前必须清格式、压成一行；内容不删。
 *
 * 注意：后端 main.py 的 midjourney_prompt_text 是同一套规则（其它入口也走它），
 * tests/test_canvas_gen_pipe.js 拿两边输出对拍，规则只改一处会被测试挡下来。
 */
export const MJ_PROMPT_LIMIT = 2000;

const RULES: Array<[RegExp, string]> = [
  [/```[^\n]*\n?/g, " "],
  [/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, " "],
  [/#{1,6}(?=\s|[\u4e00-\u9fa5])/g, ""],
  [/^\s{0,3}>\s?/gm, " "],
  [/^\s*(?:[-*_]\s*){3,}$/gm, " "],
  [/\*\*|__/g, ""],
  [/`/g, ""],
  [/\|/g, " "],
  [/^\s*[-*+]\s+/gm, " "],
  [/-{2,}/g, "-"],
  [/[\r\n\t]+/g, " "],
  [/ {2,}/g, " "],
];

export function midjourneyPrompt(prompt: string, limit = MJ_PROMPT_LIMIT): string {
  let text = String(prompt || "");
  for (const [re, to] of RULES) text = text.replace(re, to);
  text = text.trim();
  return text.length > limit ? text.slice(0, limit).trim() : text;
}
