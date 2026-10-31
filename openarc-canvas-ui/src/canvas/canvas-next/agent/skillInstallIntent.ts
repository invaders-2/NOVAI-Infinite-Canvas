export type SkillInstallPreview = {
  previewId: string;
  repository: string;
  sourceUrl: string;
  branch: string;
  commit: string;
  sha256: string;
  skills: Array<{ name: string; description: string; path: string }>;
  scripts: string[];
  excluded: string[];
  bytes: number;
  expiresAt: number;
};

export type SkillInstallMessage = {
  status: "inspecting" | "ready" | "installing" | "installed" | "error" | "cancelled";
  source: string;
  preview?: SkillInstallPreview;
  error?: string;
  packId?: string;
  skillCount?: number;
};

export function skillInstallIntent(value: string): string | null {
  const text = value.trim();
  const npx = text.match(/^npx\s+skills\s+add\s+(https:\/\/\S+)$/i);
  const natural = text.match(/^(?:请)?(?:安装|导入)\s*(?:这个|以下|一下)?\s*(?:技能|skill)?\s*[:：]?\s*(https:\/\/\S+)$/i);
  const candidate = (npx || natural)?.[1] || (/^https:\/\/\S+$/i.test(text) ? text : "");
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash || parts.length !== 2) return null;
    return "https://github.com/" + parts.join("/");
  } catch {
    return null;
  }
}
