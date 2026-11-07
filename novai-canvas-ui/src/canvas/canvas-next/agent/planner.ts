import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { genOf, inputsOf, isGenKind, outOf, textOf } from "../model";
import type { CanvasStore } from "../store";

export function ruleAnswer(store: CanvasStore, text: string, ctx: CanvasNode[]): { text: string; acts: string[] } {
  const doc = store.state.doc; const gen = doc.nodes.filter((n) => isGenKind(n.kind));
  const idle = gen.filter((n) => !outOf(n) && !store.state.runtime[n.id] && !genOf(n).manual && !genOf(n).uploaded); const running = gen.filter((n) => store.state.runtime[n.id]);
  const missing = gen.filter((n) => inputsOf(doc, n.id).some((x) => isGenKind(x.node.kind) && !outOf(x.node)));
  const topic = (ctx[0] ? title(ctx[0]) : doc.nodes.find((n) => n.kind === "text") ? title(doc.nodes.find((n) => n.kind === "text")!) : "这张画布的主题");
  // 没有助手运行时（离线回退）不编造创意内容：头脑风暴这类需要模型的请求直接说明连不上
  if (/头脑风暴|故事方向|发散|策划|方案/.test(text)) return { text: "画布助手现在连不上对话模型，没法帮你出方案。请检查「设置 › API 设置」里的对话模型后再试。", acts: [] };
  if (/延续.*记忆|已经确定的设定|设定、风格/.test(text)) return { text: `这张画布目前确定的内容：\n\n- **节点**：${doc.nodes.length} 个，${doc.edges.length} 条连线\n- **已有结果**：${gen.filter((n) => outOf(n)).map((n) => "「" + title(n) + "」").join("、") || "还没有"}\n\n之后的规划和生成都会沿用这些设定。想固定某条规则，可以直接说「记住……」。`, acts: ["记住：海报都用 3:4", "检查一下这张画布还缺什么"] };
  if (/状态|缺|检查|有哪些|看看|总结/.test(text) || !ctx.length) return { text: `这张画布有 ${doc.nodes.length} 个节点、${doc.edges.length} 条连线。\n${running.length ? `· 生成中：${running.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}${idle.length ? `· 还没生成：${idle.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}${missing.length ? `· 上游还没结果：${missing.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}要我直接处理吗？`, acts: ["生成一套卖点海报", "把选中的图片做成一条短片", "把需求拆成表格批量出图", "整理一下画布"] };
  return { text: `已读取 ${ctx.map((n) => "「" + title(n) + "」").join("、")}。可以让我基于它们出海报、做视频、拆表格批量出图，或者换背景。`, acts: ["基于选中节点做一套卖点海报", "用选中的图片做首帧视频", "把选中的图片换成书桌背景"] };
}
