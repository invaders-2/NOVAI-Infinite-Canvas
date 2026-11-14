/**
 * 素材库文件夹的交互 + 归并/归属规则（纯逻辑，node 可直接单测）。
 *
 * 抽屉里的文件夹是手风琴：单击文件夹行在它正下方就地展开（子文件夹 + 素材），再点收起；
 * 收起时不显示任何内容。（2026-11 用户明确要求，取代之前「扁平 + 钻取」的做法。）
 * 键盘：Enter / 空格 = 展开或收起，→ = 展开，← = 收起。
 */

export type KeyIntent = "toggle" | "open" | "close" | null;

export function rowKeyIntent(key: string): KeyIntent {
  if (key === "Enter" || key === " ") return "toggle";
  if (key === "ArrowRight") return "open";
  if (key === "ArrowLeft") return "close";
  return null;
}

export type CategoryRef = { id: string; name: string; parent_id?: string };

/** 有 parent_id 的分类是子文件夹，不参与固定文件夹（角色/场景/道具/风格/音效）的关键词归并 */
export function isChildCategory(cat: CategoryRef): boolean {
  return !!String(cat.parent_id || "").trim();
}

/** 去掉 asset:/local: 前缀后的分类 id（后端默认分类是 characters/scenes 这种稳定 id） */
export function bareCategoryId(id: string): string {
  return String(id || "").replace(/^(asset:|local:)/, "").toLowerCase();
}

/**
 * 把分类归到固定文件夹（角色/场景/道具/风格/音效）的规则：
 *   1) 只认顶级分类 —— 「道具」下的「小道具」要按 parentKey 挂到父级，不能被吞；
 *   2) 名字必须**完全等于**关键词，或 id 命中固定 id（characters/scenes/props/styles/sounds/audio）；
 *      按「包含」匹配会把「场景图」「角色参考」「道具备份」这类自建顶级文件夹整行吞掉，
 *      它们自己就永远看不见、也选不中。
 * 固定行本身即使一个分类都没匹配上也会照常渲染（空行，不消失）。
 */
export function matchFixedFolders<T extends CategoryRef>(cats: T[], needles: string[]): T[] {
  return cats.filter((c) => {
    if (isChildCategory(c)) return false;
    const name = String(c.name || "").trim().toLowerCase();
    const id = bareCategoryId(c.id);
    return needles.some((n) => name === n || id === n);
  });
}

export type LibraryRef = { id: string; categoryIds?: string[] };

/** 分类 id → 所属资产库 id：多库时保存要落到文件夹自己的库里，否则后端会报「文件夹不存在」 */
export function categoryOwners(libs: LibraryRef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const lib of libs) for (const id of lib.categoryIds || []) map.set(String(id).replace(/^asset:/, ''), lib.id);
  return map;
}

export type FolderNode = {
  key: string; catId: string; name: string; kind: string;
  parentKey?: string; depth: number;
  /** 文件夹自己直接装的素材数 / 连同所有子文件夹的合计 */
  count: number; total: number; childKeys: string[];
};

/**
 * 把分类摊成按树先序排列的文件夹列表（父在前、子紧跟其后）。
 * parent_id 指向不存在的分类 → 当顶级显示，避免丢项；成环的只取第一次遇到的位置。
 */
export function buildFolderTree<T extends CategoryRef & { kind?: string }>(cats: T[], countOf: (catId: string) => number): FolderNode[] {
  const ids = new Set(cats.map((c) => c.id));
  const parentOf = (c: T) => { const p = String(c.parent_id || "").trim(); return p && p !== c.id && ids.has(p) ? p : ""; };
  const kids = new Map<string, T[]>();
  for (const c of cats) { const p = parentOf(c); if (!kids.has(p)) kids.set(p, []); kids.get(p)!.push(c); }
  const out: FolderNode[] = []; const used = new Set<string>();
  const walk = (c: T, parentKey: string | undefined, depth: number) => {
    if (used.has(c.id)) return;
    used.add(c.id);
    const node: FolderNode = { key: "folder:" + c.id, catId: c.id, name: String(c.name || "未命名"), kind: String(c.kind || ""), parentKey, depth, count: countOf(c.id), total: 0, childKeys: [] };
    out.push(node);
    for (const k of kids.get(c.id) || []) { if (!used.has(k.id)) { node.childKeys.push("folder:" + k.id); walk(k, node.key, depth + 1); } }
  };
  for (const c of kids.get("") || []) walk(c, undefined, 0);
  for (const c of cats) walk(c, undefined, 0); // 成环的分类兜底按顶级显示
  const byKey = new Map(out.map((n) => [n.key, n]));
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i];
    n.total = n.count + n.childKeys.reduce((sum, k) => sum + (byKey.get(k)?.total || 0), 0);
  }
  return out;
}
