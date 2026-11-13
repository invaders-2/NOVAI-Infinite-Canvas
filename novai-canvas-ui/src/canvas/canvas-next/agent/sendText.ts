/** 发送文本的取值：建议芯片 / 快捷动作可以把文本直接传进来，不再依赖 draft 状态（避免读到上一次输入）。 */
export type SendOutgoing = { text?: string } | null | undefined;
export function pickSendText(direct?: string, outgoing?: SendOutgoing, draft?: string): string {
    const directText = typeof direct === "string" ? direct : "";
    if (directText.trim()) return directText;
    if (outgoing && typeof outgoing.text === "string") return outgoing.text;
    return String(draft ?? "");
}
