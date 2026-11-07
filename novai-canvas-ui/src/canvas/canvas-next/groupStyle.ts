/**
 * 分组背景色：存在组节点的 data.color 里（复用 NODE_TAG 那 6 个色键），
 * 渲染时转成低透明度底色，虚线框和组内节点都还看得见。
 * data 是 unknown，读写都从这里走，别在别处 as。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { NODE_TAG, tagColor } from "./model";

const readData = (n: CanvasNode): Record<string, unknown> => (n.data && typeof n.data === "object" ? { ...(n.data as Record<string, unknown>) } : {});

/** 分组背景色键；没设过 / 不是认识的键都当没有（""） */
export function groupColor(n: CanvasNode | null | undefined): string {
  if (!n || n.kind !== "group") return "";
  const raw = readData(n).color;
  return typeof raw === "string" && NODE_TAG.some(([k]) => k === raw) ? raw : "";
}

/** 写回背景色；"" = 重置，并避免留下一个空 data 对象 */
export function withGroupColor(n: CanvasNode, color: string): CanvasNode {
  const data = readData(n);
  if (color) data.color = color; else delete data.color;
  return { ...n, data: Object.keys(data).length ? data : undefined };
}

/** 给 .gbody 用的实色（配合 CSS 里的 color-mix 调透明度） */
export const groupTint = (n: CanvasNode): string | null => tagColor(groupColor(n));

/** 调色板上的中文名（键与 NODE_TAG 一致） */
export const GROUP_COLOR_LABEL: Record<string, string> = { red: "红色", orange: "橙色", yellow: "黄色", green: "绿色", blue: "蓝色", purple: "紫色" };

/** 组框底色透明度（0.1 = 90% 透明）：改这一个值就能整体调浓淡 */
export const GROUP_BG_ALPHA = 0.1;
/** 选中态不画描边，用底色加深一档来表达 */
export const GROUP_BG_ALPHA_ON = 0.16;

const rgba = (hex: string, alpha: number) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

/** 组框底色：设过色用该色，没设色用主题墨色（深浅两套主题都看得见，又不糊住网格和组内节点） */
export function groupBackground(n: CanvasNode, active: boolean): string {
  const a = active ? GROUP_BG_ALPHA_ON : GROUP_BG_ALPHA;
  const hex = groupTint(n);
  return hex ? rgba(hex, a) : `rgba(var(--ink), ${a})`;
}
