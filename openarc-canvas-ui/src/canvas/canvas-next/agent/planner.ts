import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { genOf, inputsOf, isGenKind, outOf, textOf } from "../model";
import type { CanvasStore } from "../store";

export function ruleAnswer(store: CanvasStore, text: string, ctx: CanvasNode[]): { text: string; acts: string[] } {
  const doc = store.state.doc; const gen = doc.nodes.filter((n) => isGenKind(n.kind));
  const idle = gen.filter((n) => !outOf(n) && !store.state.runtime[n.id] && !genOf(n).manual && !genOf(n).uploaded); const running = gen.filter((n) => store.state.runtime[n.id]);
  const missing = gen.filter((n) => inputsOf(doc, n.id).some((x) => isGenKind(x.node.kind) && !outOf(x.node)));
  const topic = (ctx[0] ? title(ctx[0]) : doc.nodes.find((n) => n.kind === "text") ? title(doc.nodes.find((n) => n.kind === "text")!) : "这张画布的主题");
  if (/头脑风暴|故事方向|发散/.test(text)) return { text: `围绕「${topic}」发散三个差异明显的方向：\n\n### 方向一 · 极限挑战\n- **核心冲突**：主角在恶劣环境里突破自己\n- **画面**：大远景 + 第一人称速度感\n\n### 方向二 · 日常反差\n- **核心冲突**：平凡场景里突然出现的高光时刻\n- **画面**：生活化近景，节奏先慢后快\n\n### 方向三 · 品牌宣言\n- **核心冲突**：用一句口号串起三段情绪\n- **画面**：留白构图 + 大字标题\n\n**建议收束到方向一**：和现有素材最贴合，最容易出片。要我按这个方向拆分镜吗？`, acts: ["按方向一拆成分镜", "三个方向各出一张概念图", "换三个更大胆的方向"] };
  if (/延续.*记忆|已经确定的设定|设定、风格/.test(text)) return { text: `这张画布目前确定的内容：\n\n- **节点**：${doc.nodes.length} 个，${doc.edges.length} 条连线\n- **已有结果**：${gen.filter((n) => outOf(n)).map((n) => "「" + title(n) + "」").join("、") || "还没有"}\n\n之后的规划和生成都会沿用这些设定。想固定某条规则，可以直接说「记住……」。`, acts: ["记住：海报都用 3:4", "检查一下这张画布还缺什么"] };
  if (/状态|缺|检查|有哪些|看看|总结/.test(text) || !ctx.length) return { text: `这张画布有 ${doc.nodes.length} 个节点、${doc.edges.length} 条连线。\n${running.length ? `· 生成中：${running.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}${idle.length ? `· 还没生成：${idle.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}${missing.length ? `· 上游还没结果：${missing.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}要我直接处理吗？`, acts: ["生成一套卖点海报", "把选中的图片做成一条短片", "把需求拆成表格批量出图", "整理一下画布"] };
  return { text: `已读取 ${ctx.map((n) => "「" + title(n) + "」").join("、")}。可以让我基于它们出海报、做视频、拆表格批量出图，或者换背景。`, acts: ["基于选中节点做一套卖点海报", "用选中的图片做首帧视频", "把选中的图片换成书桌背景"] };
}
