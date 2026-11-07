/**
 * 应用市场「在新画布里使用」种进来的技能引用 → 画布助手的技能胶囊。
 *
 * 协议（web 侧写 seed.skillRef）：内置技能 = 技能 id，市场技能 = store:<id>。
 * 这里只做纯映射（不读 DOM / 不读全局），行为对齐 tests/test_beat_skill_seed.js。
 */
export type SkillLike = { id?: string; name: string };

/** store:<id> 去掉前缀；空值 = 没有技能 */
export function normalizeSkillRef(raw: unknown): string {
  return String(raw ?? "").trim().replace(/^store:/, "").trim();
}

/** 按 id 或名字在已加载技能里匹配，返回技能名（面板的 a.skill 记的是名字）；匹配不到返回 null，静默忽略 */
export function matchSkillRef(ref: unknown, skills: readonly SkillLike[]): string | null {
  const wanted = normalizeSkillRef(ref);
  if (!wanted) return null;
  const hit = skills.find((skill) => String(skill.id || "") === wanted || skill.name === wanted);
  return hit ? hit.name : null;
}
