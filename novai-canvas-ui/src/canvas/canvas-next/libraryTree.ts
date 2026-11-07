/**
 * 素材库文件夹的交互 + 归并/归属规则（纯逻辑，node 可直接单测）。
 *
 * 文件夹列表是扁平的：只列顶级文件夹，不再展开子项（用户说那看着像子菜单）。
 * 单击任意文件夹行 = 直接进入该文件夹视图；子文件夹只在进入后的视图顶部列出。
 * 键盘：Enter = 进入，← = 返回上一级（和顶部「‹ 返回」同一个动作）。
 */

export type KeyIntent = "enter" | "back" | null;

export function rowKeyIntent(key: string): KeyIntent {
  if (key === "Enter") return "enter";
  if (key === "ArrowLeft") return "back";
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
