/**
 * 验收专用调试口（仅 ?debugBatchRatio=1 时调用，不进生产流程）：
 * 在空画布上用产品自己的建节点 / 分组 / 表格 API 一次性建好「批量原图比例」的验证数据：
 *   两张图片节点（800×600、600×1067）→ 一个 group 装这两张 → 2 行表格只连这个 group（input-1 sequence）
 *   → 表格后接批量图片节点（ratio=auto 原图比例、2K、agnes-ai::agnes-image-2.0-flash）。
 * 不手写节点 JSON，全部走 newNode / withGen / makeGroupNode / withTable / withBatch / addNodes。
 */
import { makeGroupNode } from "../../react-canvas/reactCanvasStore";
import type { CanvasEdge, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { defaultParams, newNode, type ImageParams, type ModelSpec } from "../model";
import { emptyTable, withBatch, withTable, type TableData } from "../table";

// 真·PNG 小图（bridge 只认位图，SVG 占位会「数据无法解码」）；尺寸按验收要求写 800×600 / 600×1067
const PNG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAA70lEQVR4nGOsmLaFYSAACwMDQ3umN51trZy+lQXOoput7WB/MjEMEGAatZhegIluNqGBUYvpBpjoZxUqGLWYboCJflYNSYtNNWVb0j15ONnpbbGmgvixSw/U5cXoajErCzMbC/Pp64806WyxmqzozcevX3/4KsjLycxEaeJgIV6plqK4pAifrpIkLzeHkpTQ7Sdv6GExEyOjiAD3pFWHIV7XUBCn0GImItXJSwo+f/MJwr7//J2qrAgltjIQb7GWgvjdp28h7N9//n759ktMkIceQb312HVk7qyNx0dGyUVFwAKh6N+LAVlMz/4LHAAAsXU2TNyo2gMAAAAASUVORK5CYII=";
const PNG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAA1CAIAAADZOcwAAAAA50lEQVR4nGPcMq2CgTaAhYGBwTuznermbp1eyQJnUdFcb7BbmRhoBphGjUYFowGCBkYDBA2MBggaGA0QNDAaIGhgNEDQwGiAoAFo6wkP8Eht+vDqCSMDAwsbx63Tu18+uE41o///+3ti4ywGBgY+YUkTrzjijSYhGj+9ffH/3z/i1ZNgtIiM0rWjW4hXTzhAGJmYLfzTmJmZ+cVk3j69S5Ow5hWWsApIp0mA/P7x7evHd9QPEIb//xkYGC4fXE9No3fMrmMgC4yWIWhgNEDQwGiAoIHRABkWAcICoWgxkAMymrpDOHAAALHsPuoHi0btAAAAAElFTkSuQmCC";

type StoreLike = {
  addNodes: (nodes: CanvasNode[], edges?: CanvasEdge[], opts?: { select?: boolean; history?: boolean }) => void;
  /** 可选：addNodes 的 isolatedNode 会把不在模型清单里的 model 换回默认；这里再写回验收要求的完整 id */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patchGen?: (id: string, patch: any, opts?: any) => void;
};

export function buildDebugBatchRatio(store: StoreLike, at = { x: 120, y: 160 }): { groupId: string; tableId: string; batchId: string; imageIds: string[] } {
  const imageA = newNode("image", at.x, at.y, { title: "素材 A（800×600）", hist: [{ url: PNG_A, w: 800, h: 600 }], hi: 0 });
  const imageB = newNode("image", at.x + 280, at.y, { title: "素材 B（600×1067）", hist: [{ url: PNG_B, w: 600, h: 1067 }], hi: 0 });
  // 产品自己的分组 action：按子节点包围盒建 group，children 就是两个素材节点 id
  const group = makeGroupNode([imageA, imageB]);
  group.x = at.x - 60; group.y = at.y - 40;
  // 表格：2 行 × 2 列；通道模式只写 input-1 = 逐行（group 只有一条入边 → 只会有一条输入通道）
  const tableData: TableData = {
    ...emptyTable(),
    title: "验收批量（2 行）",
    columns: ["镜头", "画面提示词"],
    rows: [["镜头 1", "雨夜天台，冷白光，保温杯特写"], ["镜头 2", "清晨书桌，左侧窗光，杯身雾气"]],
    inputModes: { "input-1": "sequence" },
  };
  const table = withTable({ id: "debug-table", kind: "table", x: at.x + 520, y: at.y, w: 650, h: 300, text: tableData.title }, tableData);
  // 批量图片节点：原图比例 + 2K + 指定模型（params 用 defaultParams 打底，模型写完整 provider::model）
  const agnes: ModelSpec = { id: "agnes-ai::agnes-image-2.0-flash", name: "agnes-image-2.0-flash", vendor: "agnes-ai", kind: "image", tags: [], secs: 10 };
  const batchParams: ImageParams = { ...(defaultParams("image", agnes) as ImageParams), ratio: "auto", resolution: "2K", size: "", model: agnes.id };
  const batch = newNode("image", at.x + 1240, at.y, {
    title: "批量出图（原图比例）",
    prompt: "按表格每一行的提示词生成图片",
    params: batchParams,
  });
  const batched = withBatch(batch, { settings: { startRow: 1 } });
  const edges: CanvasEdge[] = [
    { id: "debug-e-group-table", from: group.id, to: table.id },
    { id: "debug-e-table-batch", from: table.id, to: batched.id },
  ];
  store.addNodes([imageA, imageB, group, table, batched], edges, { history: false });
  // 验收环境装了 agnes 时 isolatedNode 会保留；没装的机器上会被换成默认模型，这里再写回一次，保证 params 与验收要求一致
  store.patchGen?.(batched.id, (g: { params: Record<string, unknown> }) => ({ params: { ...g.params, ratio: "auto", resolution: "2K", size: "", model: "agnes-ai::agnes-image-2.0-flash" } }));
  return { groupId: group.id, tableId: table.id, batchId: batched.id, imageIds: [imageA.id, imageB.id] };
}
