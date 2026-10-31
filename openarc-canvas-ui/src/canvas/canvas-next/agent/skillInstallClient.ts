import { isAllowedSkillCommand } from "../../../skills/skillCenterLogic";
import type { SkillInstallPreview } from "./skillInstallIntent";

type Command = (request: { command: string; payload: Record<string, unknown> }) => Promise<Record<string, any>>;

function bridge(): Command | null {
  const command = (window as unknown as { openarc?: { skill?: { command?: Command } } }).openarc?.skill?.command;
  return typeof command === "function" ? command : null;
}

async function send(command: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  if (!isAllowedSkillCommand(command)) throw new Error("SKILL_COMMAND_NOT_ALLOWED");
  const cmd = bridge();
  if (!cmd) throw new Error("SKILL_NOT_READY：当前环境没有技能服务");
  const result = await cmd({ command, payload });
  if (!result || result.ok !== true) {
    const code = String(result?.error || "SKILL_INTERNAL");
    const message = String(result?.message || result?.detail || "技能操作未完成");
    throw new Error(message.includes(code) ? message : code + "：" + message);
  }
  const value = result.value && typeof result.value === "object" ? result.value : result;
  if (!value || typeof value !== "object") throw new Error("RESPONSE_INCOMPLETE：技能服务返回不完整");
  return value;
}

export async function inspectSkillRepository(source: string): Promise<SkillInstallPreview> {
  const value = await send("skill/pack/inspectOnline", { source });
  const preview = value.preview;
  if (!preview || typeof preview.previewId !== "string" || typeof preview.repository !== "string" || !Array.isArray(preview.skills)) {
    throw new Error("RESPONSE_INCOMPLETE：安装预览缺少必要信息");
  }
  return preview as SkillInstallPreview;
}

export async function installSkillPreview(previewId: string): Promise<{ packId: string; skillCount: number }> {
  const value = await send("skill/pack/installStaged", { previewId });
  const packId = String(value.pack?.id || "");
  if (!packId || !Array.isArray(value.skills)) throw new Error("RESPONSE_INCOMPLETE：安装结果不完整");
  return { packId, skillCount: value.skills.length };
}
