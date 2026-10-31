/**
 * 模拟后端：独立页面 / 开发 / 自动化测试用。行为和真后端一致（异步、进度、可停止、会失败），
 * 产物是程序化画出来的图、波形和示例文本。提示词里带「失败」「违规」会模拟一次审核失败。
 */
import { emptyDoc, type CanvasDoc } from "../../react-canvas/reactCanvasStore";
import { ratioWH, specFor, type GenKind, type GenOutput, type ImageParams, type ModelSpec, type VideoParams, type AudioParams } from "../model";
import { POSTER_COPY, art, hash, headlineOf, loadImg, subOf, waveBars } from "./mockArt";
import { mockEdit } from "./mockEdit";
import { GenError, type CanvasBackend, type GenRequest } from "./types";

const MOCK_MODELS: Array<[GenKind, string, string, boolean?]> = [
  ["image", "banana-pro", "Banana Pro", false], ["image", "seedream-5-lite", "Seedream 5.0 Lite"], ["image", "gpt-image-2", "GPT Image 2"], ["image", "flux-2-pro", "Flux 2 Pro"], ["image", "sdxl-local", "SDXL（本机 ComfyUI）", true],
  ["video", "seedance-2", "Seedance 2.0"], ["video", "veo-3-1-lite", "Veo 3.1 Lite"], ["video", "kling-3", "Kling 3.0"],
  ["text", "gemini-3-1-flash-lite", "Gemini 3.1 Flash Lite"], ["text", "deepseek-v4", "DeepSeek V4"], ["text", "qwen-3-5-vl", "Qwen 3.5 VL（本机）", true],
  ["audio", "mureka-v8", "Mureka V8"], ["audio", "elevenlabs-v3", "ElevenLabs V3"],
];
const VENDOR: Record<string, string> = { "banana-pro": "Google", "seedream-5-lite": "字节跳动", "gpt-image-2": "OpenAI", "flux-2-pro": "BFL", "sdxl-local": "本机", "seedance-2": "字节跳动", "veo-3-1-lite": "Google", "kling-3": "快手", "gemini-3-1-flash-lite": "Google", "deepseek-v4": "DeepSeek", "qwen-3-5-vl": "本机", "mureka-v8": "Mureka", "elevenlabs-v3": "ElevenLabs" };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new GenError("STOPPED", "已停止")); }, { once: true }); });

export type MockOptions = { speed?: number; seedDoc?: () => CanvasDoc };

export function createMockBackend(opts: MockOptions = {}): CanvasBackend {
  const speed = opts.speed ?? 1;
  const store = new Map<string, { doc: CanvasDoc; version: number }>();
  const models = MOCK_MODELS.map(([kind, id, name, local]) => specFor({ configId: id, label: name, vendor: VENDOR[id], kind, local }));

  async function run<T>(req: GenRequest, onEvent: (e: { type: "progress"; progress: number } | { type: "text"; text: string } | { type: "started"; runId?: string }) => void, signal: AbortSignal, total: number, stream?: string): Promise<void> {
    onEvent({ type: "started", runId: "mock_" + Date.now().toString(36) });
    const t0 = performance.now();
    for (;;) {
      await sleep(120, signal);
      const p = Math.min(1, (performance.now() - t0) / total);
      if (stream != null) onEvent({ type: "text", text: stream.slice(0, Math.floor(stream.length * p)) });
      onEvent({ type: "progress", progress: p });
      if (p > .45 && /失败|违规/.test(req.prompt)) throw new GenError("MODERATION", "生成失败：提示词可能触发了内容审核，请修改后重试。本次积分已退回。");
      if (p >= 1) return;
    }
  }

  return {
    kind: "mock",
    available: () => true,
    listModels: async () => models,
    async loadDoc(canvasId) {
      let s = store.get(canvasId);
      if (!s) { let doc = emptyDoc(); try { const raw = localStorage.getItem("canvas-next:mock:" + canvasId); if (raw) doc = JSON.parse(raw); } catch { /* 预览环境可能没有存储 */ } if (!doc.nodes.length && opts.seedDoc) doc = opts.seedDoc(); s = { doc, version: 1 }; store.set(canvasId, s); }
      return { doc: s.doc, version: s.version, source: "mock" };
    },
    async saveDoc(canvasId, doc) {
      const s = { doc, version: (store.get(canvasId)?.version || 0) + 1 }; store.set(canvasId, s);
      try { localStorage.setItem("canvas-next:mock:" + canvasId, JSON.stringify(doc)); } catch { /* 存不下就只留内存 */ }
      return { ok: true, version: s.version };
    },
    async generate(req, onEvent, signal) {
      const m = req.model; const total = Math.max(600, m.secs * 220 / speed);
      const seed = hash(req.nodeId + req.prompt + Date.now());
      if (req.kind === "text") {
        const text = mockText(req);
        await run(req, onEvent, signal, total, text);
        return { outputs: [{ text, meta: { model: m.name, at: Date.now() } }] };
      }
      if (req.kind === "image") {
        const p = req.params as ImageParams;
        await run(req, onEvent, signal, total * Math.min(2, p.count || 1));
        const sec = req.inputs.find((x) => x.kind === "text")?.text || req.resolvedPrompt;
        const kind = /场景|街头|书桌|房间|背景/.test(req.prompt) ? "scene" : /模特|人物|手持/.test(req.prompt) ? "model" : /海报|卖点|主标题/.test(req.prompt + sec) ? "poster" : req.inputs.some((x) => x.kind === "image") ? "poster" : "generic";
        const outs: GenOutput[] = [];
        for (let i = 0; i < (p.count || 1); i++) { const a = art(kind, { ratio: p.ratio, seed: seed + i * 7, headline: headlineOf(sec) || (kind === "poster" ? "Halo Buds 2" : ""), sub: subOf(sec), style: p.style }); outs.push({ url: a.src, w: a.w, h: a.h, meta: { model: m.name, ratio: p.ratio, size: p.size, at: Date.now() } }); }
        return { outputs: outs };
      }
      if (req.kind === "video") {
        const p = req.params as VideoParams;
        await run(req, onEvent, signal, total);
        const [w, h] = ratioWH(p.ratio, 640); const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!;
        const first = req.inputs.find((x) => x.kind === "image" && x.url)?.url;
        const im = await loadImg(first || art("scene", { ratio: p.ratio, seed }).src) as HTMLImageElement;
        const s = Math.max(w / im.naturalWidth, h / im.naturalHeight); g.drawImage(im, (w - im.naturalWidth * s) / 2, (h - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
        const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .3, w / 2, h / 2, Math.max(w, h) * .7); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.5)"); g.fillStyle = vg; g.fillRect(0, 0, w, h);
        return { outputs: Array.from({ length: p.times || 1 }, () => ({ frame: c.toDataURL("image/jpeg", .85), url: "", dur: p.dur, res: p.res, w, h, meta: { model: m.name, at: Date.now() } })) };
      }
      const p = req.params as AudioParams;
      await run(req, onEvent, signal, total);
      return { outputs: [{ url: "", bars: waveBars(seed), dur: p.dur === "自适应" ? 30 : parseInt(p.dur), meta: { model: m.name, at: Date.now() } }] };
    },
    async editImage(req, onEvent, signal) {
      const total = Math.max(800, 1400 / speed); const t0 = performance.now();
      for (;;) { await sleep(120, signal); const p = Math.min(1, (performance.now() - t0) / total); onEvent({ type: "progress", progress: p }); if (p >= 1) break; }
      const r = await mockEdit(req); return { ...r, meta: { model: req.op, at: Date.now() } };
    },
    async chat(req, onDelta, signal) {
      const lc = req.messages[req.messages.length - 1]?.content; const last = typeof lc === "string" ? lc : (lc || []).map((p) => (p.type === "text" ? p.text : "")).join("");
      const sys = req.messages[0]?.role === "system" && typeof req.messages[0].content === "string" ? req.messages[0].content : "";
      const reply = sys.includes("【OpenArc 提示词优化】") ? mockOptimized(last, req.images?.length || 0) : /"kind":"table"/.test(last) ? mockTableJson(last) : "（模拟后端）收到：" + last.slice(0, 80);
      for (let i = 1; i <= 10; i++) { await sleep(40, signal); onDelta(reply.slice(0, Math.ceil(reply.length * i / 10))); }
      return reply;
    },
    async importAsset(_c, dataUrl) { return dataUrl; },
    async resolveAsset() { return null; },
    /** 模拟切镜：按时长均分成约 3 秒一段（真实切镜在桌面版用 ffmpeg 检测画面变化） */
    async detectScenes(dataUrl) {
      const duration = await new Promise<number>((resolve) => { try { const v = document.createElement("video"); v.preload = "metadata"; v.onloadedmetadata = () => resolve(Number(v.duration) || 0); v.onerror = () => resolve(0); v.src = dataUrl; } catch { resolve(0); } });
      if (!duration) return { ok: false as const, error: "PROBE_FAILED" };
      const n = Math.max(2, Math.min(6, Math.round(duration / 3))); const step = duration / n;
      return { ok: true as const, duration, shots: Array.from({ length: n }, (_, i) => ({ inSec: Math.round(i * step * 100) / 100, outSec: Math.round(Math.min(duration, (i + 1) * step) * 100) / 100 })) };
    },
  };
}

/** 模拟「优化提示词」：把用户原话扩成一段结构化描述（只用于离线预览） */
function mockOptimized(user: string, images: number): string {
  const said = (user.split("用户的提示词：\n")[1] || "").trim() || "根据输入生成画面";
  return `${said}。主体居中、清晰锐利，背景简洁干净，柔和的侧逆光勾出轮廓，色调统一${images ? `，保持参考图（共 ${images} 张）中产品的外观、颜色与材质不变` : ""}，画面有层次与质感，商业摄影级细节。`;
}

function mockText(req: GenRequest): string {
  const p = req.resolvedPrompt || "";
  if (/"kind":"table"/.test(p)) return mockTableJson(p);
  const texts = req.inputs.filter((x) => x.text).map((x) => x.text as string);
  if (/海报|卖点|文案/.test(p)) return POSTER_COPY;
  if (/分镜|脚本|镜头/.test(p)) return "镜头1\n画面：清晨地铁车厢，人群拥挤，主角戴上 Halo Buds 2，世界安静下来\n时长：3s\n\n镜头2\n画面：特写充电仓开合，绿灯亮起\n时长：2s\n\n镜头3\n画面：街头逆光，主角侧脸微笑，字幕“一戴就静”\n时长：3s";
  if (/英文|English|prompt/i.test(p)) return "A premium product shot of matte-black true wireless earbuds floating above an open charging case, deep indigo gradient background, concentric soft sound-wave rings, rim light, ultra-detailed, 85mm, f/4, studio lighting.";
  const base = texts[0] ? texts[0].split("\n")[0] : "（没有上游文本）";
  return `已读取 ${req.inputs.length} 个输入（文本 ${texts.length} 段，图片 ${req.inputs.filter((x) => x.kind === "image").length} 张）。\n\n要点：${base}\n\n建议：把卖点拆成“降噪 / 轻 / 通话”三条主线，每条对应一张海报，主标题不超过 10 个字。`;
}
function mockTableJson(prompt: string): string {
  if (/镜头/.test(prompt) && /列固定为/.test(prompt)) return JSON.stringify({ kind: "table", version: 1, columns: ["镜头", "画面", "运镜", "时长", "台词 / 字幕"], rows: [["1", "清晨地铁车厢，主角戴上耳机，周围嘈杂瞬间安静", "缓慢推近", "3s", "一戴就静"], ["2", "特写充电仓开合，指示灯亮起", "微距横移", "2s", ""], ["3", "街头逆光，主角侧脸微笑", "环绕跟拍", "3s", "嘈杂街头，也听得清"]] });
  return JSON.stringify({ kind: "table", version: 1, columns: ["主题", "画面描述", "主标题"], rows: [["深夜通勤", "深夜蓝紫渐变，耳机悬浮在声波环中央，充电仓斜置下方，冷光勾边", "一戴就静"], ["轻盈佩戴", "纯白棚拍，耳机放在羽毛旁做重量对比，冷灰柔光", "轻到忘记戴着"], ["街头通话", "城市街头暖色逆光，模特侧脸佩戴，背景虚化车流", "嘈杂也听得清"]] });
}
