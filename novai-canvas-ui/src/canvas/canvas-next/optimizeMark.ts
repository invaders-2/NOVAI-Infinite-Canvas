/**
 * 「优化提示词」的 system 标记。
 *
 * 新版本写 novai 版；升级前写下的会话 / system 提示里是 openarc 版，
 * 判断（mock 后端、任何解析侧）两种都要认，历史对话不用迁移。
 */
export const OPTIMIZE_MARK = "【NOVAI 提示词优化】";
export const LEGACY_OPTIMIZE_MARK = "【OpenArc 提示词优化】";

/** system 提示里是不是「优化提示词」请求（新旧两种标记都算）。 */
export const isOptimizeSystem = (text: string): boolean =>
  String(text || "").includes(OPTIMIZE_MARK) || String(text || "").includes(LEGACY_OPTIMIZE_MARK);
