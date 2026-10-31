/** 模拟后端的示例画布（和预览同一套内容），只在独立页 / 测试里用 */
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { art, PRODUCT_INFO, POSTER_COPY, headlineOf, subOf, waveBars } from "../backend/mockArt";
import { defaultParams, newNode, sectionsOf, specFor, uid, withGen, type GenOutput } from "../model";

export function demoDoc(): CanvasDoc {
  const im = (o: { src: string; w: number; h: number }): GenOutput => ({ url: o.src, w: o.w, h: o.h });
  const banana = specFor({ configId: "banana-pro", label: "Banana Pro", kind: "image" });
  const N = (k: Parameters<typeof newNode>[0], x: number, y: number, extra: Parameters<typeof newNode>[3]) => newNode(k, x, y, extra, k === "image" ? banana : undefined);
  const n1 = N("image", 0, 0, { title: "产品图", uploaded: true, hist: [im(art("product", { ratio: "1:1", seed: 3 }))], params: { ...(defaultParams("image", banana) as any), ratio: "1:1" } });
  const n2 = N("text", -10, 330, { title: "产品信息", manual: true, hist: [{ text: PRODUCT_INFO }], h: 190 });
  const sec = sectionsOf(POSTER_COPY);
  const n7 = N("image", 420, -390, { title: "模特图", prompt: "根据产品特性，生成一个适合展示该产品、时尚有高级感的模特半身像，白底，人物居中", w: 220, hist: [im(art("model", { ratio: "3:4", seed: 11, pal: 1 }))], h: 293 });
  const n3 = N("text", 420, 70, { title: "卖点拆解", w: 300, h: 270, prompt: "深刻理解产品信息和产品图，输出 3 个不同构思的卖点海报方案，以“海报1”“海报2”“海报3”开头，每个包含主标题、画面、文案", hist: [{ text: POSTER_COPY }] });
  const posters: CanvasNode[] = [[0, -330], [1, 40], [2, 410]].map(([i, y]) => N("image", 870, y, { title: "卖点海报" + (i + 1), w: 220, h: 293, prompt: `参考 @卖点拆解·海报${i + 1}，基于产品图生成竖版卖点海报，保持产品外观不变`, hist: i < 2 ? [im(art("poster", { ratio: "3:4", seed: 20 + i, pal: i === 0 ? 0 : 6, headline: headlineOf(sec["海报" + (i + 1)]), sub: subOf(sec["海报" + (i + 1)]) }))] : [] }));
  const n8 = N("video", 1270, -300, { title: "开箱短片", prompt: "镜头缓慢推近，耳机从充电仓中升起，声波光环向外扩散，结尾停在主标题", params: { ...(defaultParams("video") as any), mode: "首帧" } });
  const n9 = N("audio", 1270, 110, { title: "背景音乐", prompt: "低频律动的电子氛围音乐，克制、高级，适合产品开箱", hist: [{ bars: waveBars(7), dur: 30 }] });
  let nodes = [n1, n2, n7, n3, ...posters, n8, n9]; const edges: CanvasDoc["edges"] = [];
  const link = (a: CanvasNode, b: CanvasNode) => { const e = { id: uid("e"), from: a.id, to: b.id }; edges.push(e); nodes = nodes.map((n) => n.id === b.id ? withGen(n, { order: [...((n.data as any).gen.order || []), e.id] }) : n); };
  link(n2, n7); link(n2, n3); link(n1, n3); posters.forEach((p) => { link(n1, p); link(n3, p); }); link(posters[0], n8);
  return { nodes, edges, comments: [{ id: uid("c"), x: 1100, y: 60, text: "海报2 的主标题再短一点，控制在 6 个字以内？", createdAt: Date.now() - 3600e3, clientId: "peer", author: "小林" }] };
}
