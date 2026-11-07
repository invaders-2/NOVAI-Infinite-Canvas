/**
 * 模板「素材位」：模板铺到画布后，用户需要替换 / 填写的输入节点。
 *   · 素材位（image / video / audio）：没有上游、没有结果、上传过或提示词为空的输入节点 → 「在此替换」
 *   · 文本位（text）：没有上游、没有结果、正文为空的手写文本节点 → 「在此填写」
 * 用户替换素材 / 生成出结果后 outOf 不为空，标记自动消失（渲染层按 doc 实时计算，不存状态）。
 */
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { genOf, inputsOf, isGenKind, outOf, TYPE_LABEL } from "../model";
import type { CanvasStore } from "../store";

export type TemplateSlot = { id: string; kind: CanvasNode["kind"]; title: string; label: "在此替换" | "在此填写" };

const MATERIAL_KINDS = new Set<string>(["image", "video", "audio"]);

/** 这里不引 ../actions（它会把 UI 层拉进 engine 的测试打包）：标题口径与 actions.title 一致 */
const slotTitle = (node: CanvasNode) => genOf(node).title || node.text || (isGenKind(node.kind) ? TYPE_LABEL[node.kind] : "") || "未命名";

/** 单个节点是不是素材位（不是就返回 null） */
export function inputSlotOf(doc: CanvasDoc, node: CanvasNode): TemplateSlot | null {
  if (!isGenKind(node.kind)) return null;
  if (outOf(node)) return null;
  if (inputsOf(doc, node.id).length) return null;
  const g = genOf(node);
  const prompt = (g.prompt || "").trim();
  if (MATERIAL_KINDS.has(node.kind)) {
    return g.uploaded || !prompt ? { id: node.id, kind: node.kind, title: slotTitle(node), label: "在此替换" } : null;
  }
  if (node.kind === "text") {
    const text = (node.text || "").trim();
    if (!text && (g.manual || !prompt)) return { id: node.id, kind: "text", title: slotTitle(node), label: "在此填写" };
  }
  return null;
}

/** 画布上所有素材位 */
export function findInputSlots(doc: CanvasDoc): TemplateSlot[] {
  const slots: TemplateSlot[] = [];
  for (const node of doc.nodes) { const slot = inputSlotOf(doc, node); if (slot) slots.push(slot); }
  return slots;
}

/** 还没填的素材位（目前与 findInputSlots 等价：填了就有结果，标记自然消失） */
export function pendingSlots(doc: CanvasDoc): TemplateSlot[] { return findInputSlots(doc); }

/**
 * 运行前校验：还有素材位没填就提示 + 选中（有 ctl 时顺带 fitTo），返回 false 表示中止、不要发请求。
 */
export function validateRun(store: CanvasStore, opts: { ctl?: { fitTo?: (nodes: CanvasNode[], pad?: number, maxK?: number) => void }; slots?: TemplateSlot[] } = {}): boolean {
  const slots = (opts.slots || pendingSlots(store.state.doc)).slice();
  if (!slots.length) return true;
  const names = slots.map((s) => s.title);
  const head = names.slice(0, 4).join("、") + (names.length > 4 ? "…" : "");
  store.toast("还有 " + slots.length + " 个素材位没填：" + head, 6000);
  const ids = new Set(slots.map((s) => s.id));
  store.setUI({ sel: ids });
  const nodes = store.state.doc.nodes.filter((n) => ids.has(n.id));
  if (opts.ctl?.fitTo && nodes.length) opts.ctl.fitTo(nodes, 160, 1);
  return false;
}
