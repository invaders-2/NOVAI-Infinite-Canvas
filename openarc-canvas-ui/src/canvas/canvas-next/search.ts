/**
 * 节点搜索（TapNow 搜索的 World / Group 范围）：
 *   范围  world = 整张画布；或某个分组 / 堆叠里的节点（含嵌套分组）
 *   类型  全部 / 图片 / 视频 / 文本 / 音频 / 表格 / 分组
 *   关键词匹配标题、提示词、文本内容；堆叠里收起的节点也能搜到，定位时落到所在堆叠
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { title } from "./actions";
import { genOf, isGenKind, textOf, type GenKind } from "./model";
import { plainPrompt } from "./mentions";
import { groupLabel } from "./stack";

export type SearchKind = "all" | GenKind | "table" | "group";
export type SearchScope = "world" | string;

export const groupsOf = (doc: CanvasDoc) => doc.nodes.filter((n) => n.kind === "group");
export const groupName = groupLabel;

/** 分组里的全部节点 id（含嵌套分组的成员） */
export function membersOf(doc: CanvasDoc, gid: string): Set<string> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n])); const out = new Set<string>(); const todo = [gid];
  while (todo.length) { const g = byId.get(todo.pop()!); for (const c of g?.children || []) if (!out.has(c)) { out.add(c); if (byId.get(c)?.kind === "group") todo.push(c); } }
  return out;
}

const haystack = (doc: CanvasDoc, n: CanvasNode) => (n.kind === "group" ? groupName(n) : title(n) + " " + (isGenKind(n.kind) ? plainPrompt(genOf(n).prompt, doc) + " " + textOf(n) : "")).toLowerCase();

export function searchNodes(doc: CanvasDoc, opts: { q: string; kind: SearchKind; scope: SearchScope }): CanvasNode[] {
  const inScope = opts.scope === "world" ? null : membersOf(doc, opts.scope);
  const q = opts.q.trim().toLowerCase();
  return doc.nodes.filter((n) => (inScope ? inScope.has(n.id) : true)
    && (opts.kind === "all" ? n.kind !== "group" : opts.kind === "group" ? n.kind === "group" : n.kind === opts.kind)
    && (!q || haystack(doc, n).includes(q)));
}
