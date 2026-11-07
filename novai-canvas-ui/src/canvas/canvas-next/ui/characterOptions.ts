import { ELEMENT_ERAS, type ElementAttrKey } from "../elements";

/** 角色属性的固定候选值：生成表单下拉 + 角色库筛选 chip 共用（顺序即展示顺序） */
export const CHARACTER_OPTIONS: Array<[ElementAttrKey, string[]]> = [
  ["era", [...ELEMENT_ERAS]],
  ["gender", ["男", "女", "中性"]],
  ["age", ["少年", "青年", "中年", "老年"]],
  ["species", ["人类", "精灵", "兽人", "妖族", "机械", "其他"]],
  ["build", ["纤细", "匀称", "健壮", "壮硕", "丰腴"]],
  ["height", ["娇小", "中等", "高挑", "极高"]],
  ["skin", ["白皙", "自然", "小麦", "古铜", "暗黑"]],
  ["hairLen", ["短发", "中长发", "长发", "及腰", "光头"]],
  ["hairColor", ["黑", "棕", "金", "红", "银白", "彩色"]],
  ["vibe", ["温和", "冷峻", "威严", "俏皮", "忧郁", "神秘"]],
];
export const CHARACTER_OPTION_MAP: Partial<Record<ElementAttrKey, string[]>> = Object.fromEntries(CHARACTER_OPTIONS);
