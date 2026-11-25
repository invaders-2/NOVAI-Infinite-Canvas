/**
 * 图片编辑器：
 *   本地完成：裁剪、调整像素、快速切分、视频截帧；
 *   走模型（backend.editImage）：局部重绘、擦除、标注、多角度、重打光、扩图、增强、抠图。
 * 结果作为新版本写回原节点（多角度 / 切分 / 截帧是新建节点并连线），原图留在历史里。
 */
import { isAssetRef } from "../../../canvasAssetRefs";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CanvasNode } from "../../../react-canvas/reactCanvasStore";
import { relit } from "../../backend/mockEdit";
import { GenError, type EditOp, type MattingModelStatus, type UpscaleRuntimeStatus } from "../../backend/types";
import { maskedStructureScore } from "../../whitemodelScore.js";
import { clamp, clampTrim, genOf, outOf, uid, withGen, type GenOutput, type ModelSpec, type VideoTrim } from "../../model";
import { fitMediaBox } from "../../mediaFit";
import type { CanvasStore } from "../../store";
import { useCtl, useS, type Ctl } from "../ctx";
import { VendorLogo } from "../VendorLogo";
import { Icon } from "../Icon";
import { closeModal, ModalHead, openModal, openPop } from "../overlay";
import { useAssetUrl } from "../useAsset";
import { openColorAdjust } from "./ColorAdjust";
import { openLosslessEdit } from "./LosslessEdit";
import { OutpaintFrame } from "./OutpaintFrame";
import { Markup } from "./Markup";
import { barAbove, useEdBar } from "./barPos";
import { brushRadius, ringVisible, type Ext } from "./outpaint-geometry";
import { ComboMenu } from "../combo";
// 扩图框 / 笔刷圆圈的样式：独立小块，写进 canvas-next.css 会和另一路（textdoc 段）冲突。
// 在这里 import 一次即可 —— registry 随画布常驻，笔刷圆圈不用等扩图框打开才加载样式。
import "./editors.css";
import { openSplitEditor } from "./SplitEditor";

/** 画笔大小范围（px）：圆圈直径 = 实际笔迹直径 = 这个值 */
const BRUSH_MIN = 4; const BRUSH_MAX = 120;

/*
 * 编辑参数 → 提示词。
 * NOVAI 适配器（createNovaiBackend）发给模型平台的只有 prompt + 参考图，params 只带给 BEAT 桌面版；
 * 所以这里把滑杆 / 光源位置这些参数写成模型看得懂的人话，两条后端都能照做。
 */
/** 光源方向：取光点在画面里的位置说成人话（左上方 / 正前方…） */
function lightDir(lx: number, ly: number) {
  const h = lx < .34 ? "左" : lx > .66 ? "右" : "";
  const v = ly < .34 ? "上" : ly > .66 ? "下" : "";
  return h + v ? h + v + "方" : "正前方";
}
/** 色温滑杆（0 最暖 ~ 100 最冷）→ 中文说法 + 近似开尔文（模型对色温数字更敏感） */
function colorTemp(temp: number) {
  const t = clamp(Number(temp) || 0, 0, 100);
  const kelvin = t <= 40 ? 2800 + (t / 40) * 1700 : t <= 60 ? 4500 + ((t - 40) / 20) * 2000 : 6500 + ((t - 60) / 40) * 3500;
  return { label: t < 40 ? "偏暖" : t > 60 ? "偏冷" : "中性", kelvin: Math.round(kelvin / 100) * 100 };
}
/** 增强：把「2×」说成目标长边，模型才知道要放大多少 */
function enhancePrompt(n: CanvasNode) {
  const o = outOf(n); const long = Math.max(Number(o?.w) || 0, Number(o?.h) || 0);
  return `把这张图做高清增强：清晰度提升到 2 倍分辨率${long ? `（原图长边 ${long}px，目标长边约 ${Math.round(long * 2)}px）` : ""}，锐化边缘与纹理、去除噪点与压缩痕迹；内容、构图、颜色完全不变。`;
}
/** 遮罩类编辑：说清「第几张参考图是什么」，并写明改完不要留标注笔迹 */
const MASK_NOTE = "参考图说明：第一张是原图；第二张是涂抹遮罩（透明底上的笔迹标出要处理的部分，未标记区域请保持一模一样）。";
const ANNOT_NOTE = "参考图说明：第一张是要改的原图；第二张是标注图层（透明底上只有红色笔迹，红色是标出要改的位置，不是要画进图里的内容）。";
type EdState = { type: "crop" | "mask" | "outpaint" | "markup" | "whitemodel"; id: string; mode?: "redraw" | "erase" | "annot" } | null;
let ed: EdState = null; const ls = new Set<() => void>();
const setEd = (v: EdState) => { ed = v; ls.forEach((l) => l()); };
export const useEditorState = () => useSyncExternalStore((l) => { ls.add(l); return () => { ls.delete(l); }; }, () => ed);

const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error("图片读取失败")); im.src = src; });
/** 白膜三档：人台（服装展示）、白模（商品未上色石膏粗模）、清场（商品连同接触投影一起移除）。 */
export type WhiteTier = "mannequin" | "blockout" | "clear";
/**
 * 白膜结果的自动审查，两档待遇不同：
 *   空白图（整幅一个颜色 / 读不出图）→ block：真废图，拦下不写版本，换更强模型重试；
 *   其余按档位各查，只 warn，结果照常写进版本 ——
 *   人台：结构大体要对得上，且不许有彩色残留（衣服 / 背景没变全白）；
 *   白模：结构大体要对得上（只能去掉细节、不能换个东西），背景保留原色所以不查彩色；
 *   清场：结果本来就要保留原背景颜色，所以不查彩色残留，改查「和输入几乎没变化」（商品没被移除）。
 * 只提示不拦：用户是花钱生成的，误判一次就把结果丢掉比多一张废图更糟（人台档在忙背景的图上误杀过）。
 * 返回 {} = 通过。
 */
async function whiteModelIssue(src: string, tier: WhiteTier = "mannequin", from = ""): Promise<{ block?: string; warn?: string }> {
  const im = await loadImg(src);
  const w = 96, h = Math.max(1, Math.round((96 * im.naturalHeight) / Math.max(1, im.naturalWidth)));
  const c = cv(w, h); const g = c.getContext("2d")!; g.drawImage(im, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; let n = 0, s = 0, s2 = 0, colored = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const l = r * .299 + gg * .587 + b * .114;
    n++; s += l; s2 += l * l;
    // 纯白 / 中性灰的 R−G−B 差很小；原图砖墙、皮肤、彩色鞋子会明显超阈值
    if (Math.max(r, gg, b) - Math.min(r, gg, b) > 12 && l < 248) colored++;
  }
  if (!n) return { block: "模型返回的图片读不出来，换一个图片模型再试" };
  const mean = s / n;
  const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  // 干净的棚拍场景（无缝米色背景）清掉商品后本来就接近一片纯色（实测 std 3.9），用 3 会误杀，
  // 清场阈值放宽到 1.5；人台 / 白模仍用 6，只拦「整块一个色」的空白图。
  if (std < (tier === "clear" ? 1.5 : 6)) return { block: "模型把画面生成成空白了，已拦下不写版本；换一个更强的图片模型（nano banana / GPT Image）再试一次" };
  // 人台 / 白模：颜色和亮度本来就会整体改变（人台全白、白模石膏灰），比颜色必误杀；改比轮廓（见 structureScore）。
  // 分数只作提示，不过就不再往版本历史上丢图。
  if (tier !== "clear") {
    if (!from) return {};
    const score = await structureScore(src, from).catch(() => 0);
    if (score < STRUCT_MIN) return { warn: tier === "blockout"
      ? "结果和原商品的轮廓对不上：产品档只该去掉细节、不该换外形。这次已经照常写入版本，不满意可以撤销后换个模型再试"
      : "结果和原图的轮廓对不上：人台档要求原图里有人物，并且要保住原来的姿态和机位（商品图请改用「产品」档）。这次已经照常写入版本，不满意可以撤销后换个模型再试" };
  }
  if (tier === "blockout") return {};
  if (tier === "clear") {
    if (!from) return {};
    // 清场档：按亮度逐点对比输入图；商品该占掉的那块没动 = 模型原样返回 / 没清掉。
    // 两条都「几乎为零」才判失败（小商品本来就只占画面很小一块，单看均值会误杀）
    const im0 = await loadImg(from);
    const c0 = cv(w, h); const g0 = c0.getContext("2d")!; g0.drawImage(im0, 0, 0, w, h);
    const d0 = g0.getImageData(0, 0, w, h).data; let diff = 0, moved = 0;
    for (let i = 0; i < d.length; i += 4) {
      const dl = Math.abs((d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) - (d0[i] * .299 + d0[i + 1] * .587 + d0[i + 2] * .114));
      diff += dl; if (dl > 8) moved++;
    }
    if (diff / n < 2 && moved / n < .01) return { warn: "结果和原图几乎没有变化，商品好像没被拿掉。这次已经照常写入版本，不满意可以撤销后换个模型再试" };
    return {};
  }
  if (colored / n > 0.02) return { warn: "结果里还残留原图的颜色（衣服或背景没变全白）。这次已经照常写入版本，不满意可以撤销后换个模型再试" };
  return {};
}
const cv = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
async function srcData(store: CanvasStore, url: string) { return isAssetRef(url) ? (await store.backend.resolveAsset(url)) || "" : url; }
/** 结构相似度阈值（96px 灰度梯度余弦，已剔除结果里被抹成纯白的背景）：
 *  真图人台正例 0.64 / 0.70；忙背景原图对正常的人台结果 0.54（旧算法 0.45，会被误杀）；主体平移 20% 0.49；
 *  换一张完全不同的图 0.68 —— 这两类分不开，所以分数只用来提示、不拦结果，阈值取 0.45 只拦明显对不上的。 */
const STRUCT_MIN = 0.45;
/**
 * 只比轮廓 / 构图：96px 灰度 → Sobel 梯度图 → 余弦相似度（结果被抹成纯白的背景不计，见 whitemodelScore.js）。
 * 颜色、整体亮度、白平衡的改变都会被梯度抵消，适合「人台整体变白 / 白模变石膏灰」之后仍要判断主体有没有跑偏。
 */
async function structureScore(a: string, b: string) {
  const im = await loadImg(a);
  const w = 96, h = Math.max(1, Math.round((96 * im.naturalHeight) / Math.max(1, im.naturalWidth)));
  const lum = async (src: string) => {
    const c = cv(w, h); const g = c.getContext("2d")!; g.drawImage(await loadImg(src), 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data; const v = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) v[p] = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
    return v;
  };
  return maskedStructureScore(await lum(a), await lum(b), w, h).score;
}
/**
 * 白模档的本地白平衡兜底（不靠模型）：生成模型经常给奶白 / 米白 / 浅灰底，达不到「纯白」。
 * target 默认 250（产品档）；人物档传 252（形体靠明暗，不能上平场，只把白点再抬一点）。
 * 96px 缩略图统计三通道各自的 99 分位（避开极少数噪点高光），每通道乘一个系数把那分位拉到 250
 * （不是 255，留余量防死白），系数夹在 [1,1.6] 且已经 >=250 的通道不动；再整张图按系数重画。
 * 只对白模档生效；人台 / 清场要保持原照片的颜色，不能动。
 */
async function pureWhite(src: string, target = 250) {
  const im = await loadImg(src);
  const w = Math.max(1, Math.min(96, im.naturalWidth));
  const h = Math.max(1, Math.round((w * im.naturalHeight) / Math.max(1, im.naturalWidth)));
  const t = cv(w, h); const tg = t.getContext("2d")!; tg.drawImage(im, 0, 0, w, h);
  const d = tg.getImageData(0, 0, w, h).data;
  // 三个通道的直方图（用 96px 缩略图统计，别拿整图噪点算分位）
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; }
  // 99 分位：从亮往暗累加，累计到 1% 像素时落在哪个亮度
  const need = Math.max(1, Math.round(w * h * 0.01));
  const p99 = (hh: Uint32Array) => { let acc = 0; for (let v = 255; v >= 0; v--) { acc += hh[v]; if (acc >= need) return v; } return 0; };
  const gain = [0, 1, 2].map((k) => { const p = p99(hist[k]); return p >= 250 ? 1 : Math.min(1.6, Math.max(1, target / Math.max(1, p))); });
  if (gain.every((g) => g === 1)) return src;
  const out = cv(im.naturalWidth, im.naturalHeight); const g2 = out.getContext("2d")!;
  g2.drawImage(im, 0, 0);
  const big = g2.getImageData(0, 0, out.width, out.height); const bd = big.data;
  for (let i = 0; i < bd.length; i += 4) {
    bd[i] = Math.min(255, bd[i] * gain[0]);
    bd[i + 1] = Math.min(255, bd[i + 1] * gain[1]);
    bd[i + 2] = Math.min(255, bd[i + 2] * gain[2]);
  }
  g2.putImageData(big, 0, 0);
  return out.toDataURL("image/png");
}
/**
 * 背景平场（只对白模档，跟在 pureWhite 之后）：白平衡只能把亮部拉白，模型给的四角暗角 / 渐变还在。
 * 在长边 ≤512 的缩略图上估背景平滑明暗场（亮部遮罩 + 大半径模糊），把背景归一化到 250；
 * 只对「像素≈背景场」的地方生效（投影、商品边缘差值大，保持原样），系数夹在 [0.9,1.4] 避免放大噪点。
 */
async function flatField(src: string) {
  const im = await loadImg(src);
  const s = Math.min(1, 512 / Math.max(1, Math.max(im.naturalWidth, im.naturalHeight)));
  const w = Math.max(1, Math.round(im.naturalWidth * s)), h = Math.max(1, Math.round(im.naturalHeight * s));
  const t = cv(w, h); const tg = t.getContext("2d")!; tg.drawImage(im, 0, 0, w, h);
  const d = tg.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) L[p] = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
  // 亮部 99 分位 → 0.85× 作遮罩阈值：只让背景（和本来就该白的商品亮部）参与背景场估计
  const p99 = Float32Array.from(L).sort()[Math.max(0, Math.min(L.length - 1, Math.round(L.length * .99) - 1))];
  const cutAt = .85 * p99;
  const mask = new Float32Array(w * h); const num = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) { const m = L[i] >= cutAt ? 1 : 0; mask[i] = m; num[i] = L[i] * m; }
  const rad = Math.max(1, Math.round(Math.min(w, h) / 8));
  const blur = (a: Float32Array) => {
    const once = (src: Float32Array, horiz: boolean) => {
      const out = new Float32Array(src.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let k = -rad; k <= rad; k++) {
          const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          sum += src[yy * w + xx]; cnt++;
        }
        out[y * w + x] = sum / cnt;
      }
      return out;
    };
    let a1 = a; for (let pass = 0; pass < 3; pass++) a1 = once(once(a1, true), false);
    return a1;
  };
  const bn = blur(num), bd = blur(mask);
  const gains = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) {
    const field = bd[i] > 1e-3 ? bn[i] / bd[i] : L[i];
    const diff = Math.abs(L[i] - field);
    // 差值 4 以内视为背景、原样应用；到 14 完全不动（投影 / 商品边缘）
    const e = Math.min(1, Math.max(0, (diff - 4) / 10));
    const wgt = 1 - e * e * (3 - 2 * e);
    const g = Math.min(1.4, Math.max(.9, 250 / Math.max(1, field)));
    gains[i] = 1 + (g - 1) * wgt;
  }
  // gain map 编码成灰度图放大回原尺寸（canvas 双线性插值），再逐像素乘
  const gc = cv(w, h); const gctx = gc.getContext("2d")!; const gi = gctx.createImageData(w, h);
  for (let i = 0, p = 0; i < gains.length; i++, p += 4) {
    const v = Math.round((gains[i] - .9) / .5 * 255);
    gi.data[p] = gi.data[p + 1] = gi.data[p + 2] = v; gi.data[p + 3] = 255;
  }
  gctx.putImageData(gi, 0, 0);
  const big = cv(im.naturalWidth, im.naturalHeight); const bg = big.getContext("2d")!;
  bg.imageSmoothingQuality = "high"; bg.drawImage(gc, 0, 0, big.width, big.height);
  const out = cv(im.naturalWidth, im.naturalHeight); const og = out.getContext("2d")!; og.drawImage(im, 0, 0);
  const px = og.getImageData(0, 0, out.width, out.height); const gd = bg.getImageData(0, 0, out.width, out.height).data;
  for (let i = 0, p = 0; i < px.data.length; i += 4, p += 4) {
    const k = .9 + (gd[p] / 255) * .5;
    px.data[i] = Math.min(255, px.data[i] * k); px.data[i + 1] = Math.min(255, px.data[i + 1] * k); px.data[i + 2] = Math.min(255, px.data[i + 2] * k);
  }
  og.putImageData(px, 0, 0);
  return out.toDataURL("image/png");
}


/** 新版本写回节点（data URL 先进资源库） */
async function applyVariant(store: CanvasStore, id: string, out: GenOutput, label: string, quiet = false) {
  const url = out.url?.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, out.url, label)
    : out.url && /^https?:\/\//i.test(out.url) && store.backend.importRemote ? await store.backend.importRemote(store.state.canvasId, out.url, label) : out.url;
  const n = store.node(id); if (!n) return; const g = genOf(n); const o = { ...out, url, meta: { ...(out.meta || {}), model: label, size: out.w && out.h ? out.w + "×" + out.h : undefined } };
  store.updateNode(id, (x) => {
    // 编辑结果也按真实像素摆正：超高 / 超宽时等比缩进最大盒，不单边压扁
    const box = o.w && o.h ? fitMediaBox(x.w, o.w, o.h) : null;
    return withGen({ ...x, ...(box ? { w: box.w, h: box.h } : {}) }, { hist: [...g.hist, o], hi: g.hist.length });
  }, { history: true });
  // 后端换了请求尺寸规则但模型没有权威规格时，会在 meta.sizeNote 里说明一句，直接告诉用户
  const note = (out.meta as { sizeNote?: string } | undefined)?.sizeNote;
  if (!quiet) store.toast(`${label}完成${note ? "（" + note + "）" : ""}，原图保留在历史版本里（‹ › 切换）`);
}

/** 旋转 / 翻转：本地处理，作为新版本写回（原图留在历史里） */
async function transformImage(store: CanvasStore, id: string, op: "cw" | "ccw" | "fh" | "fv", quiet = false) {
  const n = store.node(id); const url = n ? outOf(n)?.url : ""; if (!n || !url) return;
  try {
    const im = await loadImg(await srcData(store, url)); const W = im.naturalWidth, H = im.naturalHeight; const rot = op === "cw" || op === "ccw";
    const c = cv(rot ? H : W, rot ? W : H); const g = c.getContext("2d")!;
    if (op === "cw") { g.translate(H, 0); g.rotate(Math.PI / 2); }
    else if (op === "ccw") { g.translate(0, W); g.rotate(-Math.PI / 2); }
    else if (op === "fh") { g.translate(W, 0); g.scale(-1, 1); }
    else { g.translate(0, H); g.scale(1, -1); }
    g.drawImage(im, 0, 0);
    const png = /\.png($|\?)/i.test(url) || url.startsWith("data:image/png");
    await applyVariant(store, id, { url: c.toDataURL(png ? "image/png" : "image/jpeg", .93), w: c.width, h: c.height }, { cw: "向右旋转", ccw: "向左旋转", fh: "水平翻转", fv: "垂直翻转" }[op], quiet);
  } catch (e) { store.toast("处理失败：" + (e instanceof Error ? e.message : "图片读取失败")); }
}

/**
 * 人台档的输入预处理：本地 RMBG 把人物抠出来贴到纯白，再交给模型。
 * 原图里的椅子、包、道具会跟着进结果（真图实测：光靠提示词说「背景换成无缝纯白」保不住，模型照样留着），
 * 抠图是本地跑的、不花钱；抠不出来（没下模型 / 老后端）就返回空串，调用方照旧用原图，不影响出图。
 */
async function subjectOnWhite(store: CanvasStore, req: { canvasId: string; nodeId: string; model?: ModelSpec; sourceUrl: string }, signal: AbortSignal) {
  let cut: GenOutput | null = null;
  try {
    cut = await store.backend.editImage({ canvasId: req.canvasId, nodeId: req.nodeId, op: "cutout", model: req.model, sourceUrl: req.sourceUrl }, () => {}, signal);
  } catch { return ""; }
  if (!cut?.url) return "";
  const im = await loadImg(await srcData(store, cut.url)).catch(() => null);
  if (!im) return "";
  const c = cv(im.naturalWidth, im.naturalHeight); const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0);
  return c.toDataURL("image/png");
}

/**
 * 白模档的收边：模型经常把商品重画变形（鞋头被捏掉、整体缩小 / 挪位），
 * 生成完按原商品的抠图轮廓裁一遍 —— 轮廓、比例、位置强制跟原图一致，只留下模型做的石膏质感。
 * 轮廓先向外扩一点（长边 0.4% 画幅），避免把模型的柔和投影和边缘高光切掉。
 */
async function clipToSilhouette(store: CanvasStore, resultUrl: string, sourceUrl: string, signal: AbortSignal) {
  let cut: GenOutput | null = null;
  try {
    cut = await store.backend.editImage({ canvasId: store.state.canvasId, nodeId: "", op: "cutout", sourceUrl }, () => {}, signal);
  } catch { return ""; }
  if (!cut?.url) return "";
  const [im, mask] = await Promise.all([loadImg(await srcData(store, resultUrl)).catch(() => null), loadImg(await srcData(store, cut.url)).catch(() => null)]);
  if (!im || !mask) return "";
  const W = im.naturalWidth, H = im.naturalHeight;
  // 轮廓膨胀在 240px 缩略图上做（便宜），再放大当遮罩用
  const s = 240 / Math.max(W, H);
  const sw = Math.max(1, Math.round(W * s)), sh2 = Math.max(1, Math.round(H * s));
  const small = cv(sw, sh2); const sg = small.getContext("2d")!;
  sg.fillStyle = "#000"; sg.fillRect(0, 0, sw, sh2); sg.drawImage(mask, 0, 0, sw, sh2);
  const sd = sg.getImageData(0, 0, sw, sh2); const a = new Float32Array(sw * sh2);
  for (let i = 0, p = 0; i < sd.data.length; i += 4, p++) a[p] = sd.data[i];
  const rad = Math.max(1, Math.round(Math.max(sw, sh2) * 0.004)); // ≈ 长边的 0.4%，只把边线放宽一点点
  const dil = new Float32Array(a.length);
  for (let y = 0; y < sh2; y++) for (let x = 0; x < sw; x++) {
    let m = 0;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sw || yy >= sh2) continue;
      const v = a[yy * sw + xx]; if (v > m) m = v;
    }
    dil[y * sw + x] = m;
  }
  const mcanvas = cv(sw, sh2); const mg = mcanvas.getContext("2d")!; const mi = mg.createImageData(sw, sh2);
  for (let i = 0, p = 0; p < dil.length; i += 4, p++) { mi.data[i] = mi.data[i + 1] = mi.data[i + 2] = 255; mi.data[i + 3] = dil[p]; }
  mg.putImageData(mi, 0, 0);
  const maskFull = cv(W, H); const mfg = maskFull.getContext("2d")!;
  mfg.imageSmoothingQuality = "high"; mfg.drawImage(mcanvas, 0, 0, W, H);
  const out = cv(W, H); const g = out.getContext("2d")!;
  g.drawImage(im, 0, 0);
  g.globalCompositeOperation = "destination-in"; g.drawImage(maskFull, 0, 0);
  g.globalCompositeOperation = "destination-over"; g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  return out.toDataURL("image/png");
}

/**
 * 走模型的编辑：目标节点进入生成态（同一套加载动效），可停止。
 * 用哪个模型？统一跟节点当前选中的生图模型（节点底栏那颗模型按钮），编辑不再自己挑模型。
 */
async function runEdit(store: CanvasStore, id: string, op: EditOp, label: string, extra: { maskDataUrl?: string; prompt?: string; params?: Record<string, unknown>; sourceUrl?: string; model?: ModelSpec } = {}, target?: string, onError?: (err: Error) => void) {
  const n = store.node(id); const src = n ? outOf(n)?.url : ""; if (!n || !src) return;
  const tid = target || id; const abort = new AbortController();
  const dst = store.node(tid) || n;
  // extra.model：少数编辑会指定更适合的模型（白膜选人台理解更好的），其余仍跟节点当前模型
  const model = extra.model || store.modelOf(dst) || store.modelOf(n) || store.defaultModel("image");
  store.setRun(tid, { status: "running", progress: .02, abort, startedAt: Date.now() });
  let warn = "";
  try {
    // 扩图会自己合成「原图 + 透明扩展」再传进来（extra.sourceUrl）；其余编辑仍用节点当前结果
    const { sourceUrl: prepadded, ...rest } = extra;
    const sourceUrl = prepadded || (store.backend.kind === "mock" ? await srcData(store, src) : src);
    // 白膜三档：档位决定自检规则（人台查结构 + 彩色残留，白模查结构，清场查「商品没被移除」）
    const wantTier = (rest.params as { tier?: string } | undefined)?.tier;
    const whiteTier: WhiteTier | null = op !== "whitemodel" ? null
      : wantTier === "clear" ? "clear" : wantTier === "blockout" ? "blockout" : "mannequin";
    let req = { canvasId: store.state.canvasId, nodeId: tid, op, model, sourceUrl, ...rest };
    // 本地预处理（只有带本地抠图的后端才做，模型没下载 / 老后端一律跳过、照旧走模型）：
    //   人台 → 先把人物抠到纯白再送模型（原图里的椅子、包、道具会跟着进结果，提示词挡不住）；
    //   白模 → 送原图（模型看原图才能做出石膏的明暗体块），生成完再按原轮廓收边（见 clipToSilhouette）。
    const canMatte = typeof store.backend.mattingModelStatus === "function"
      && !!(await store.backend.mattingModelStatus().catch(() => null))?.downloaded;
    if (whiteTier === "mannequin" && canMatte) {
      const prepped = await subjectOnWhite(store, req, abort.signal).catch(() => "");
      if (prepped) req = { ...req, sourceUrl: prepped };
    }
    const onEvent = (e: { type: string; progress?: number }) => { if (e.type === "progress") store.patchRun(tid, { progress: clamp(Number(e.progress) || .02, .02, 1) }); };
    let out = await store.backend.editImage(req, onEvent, abort.signal);
    if (op === "whitemodel") {
      const tier: WhiteTier = whiteTier || "mannequin";
      // 结构自检要跟模型实际拿到的那张图比（人台档是抠到纯白后的输入），两档都读一遍
      const before = await srcData(store, req.sourceUrl).catch(() => "");
      // 产品档：本地白平衡 + 背景平场（鞋体积大、有灰面，平场是好事）；
      // 人物档：只做白平衡（目标 252），不做平场 —— 平场会把白色人台和背景抹成一片、杀掉形体；
      // 清空商品：都不做（要保持原场景颜色）。
      const balanceOut = async (o: GenOutput) => {
        if ((tier !== "blockout" && tier !== "mannequin") || !o.url) return o;
        const fixed = await pureWhite(await srcData(store, o.url), tier === "mannequin" ? 252 : 250).catch(() => "");
        if (!fixed || tier === "mannequin") return fixed ? { ...o, url: fixed } : o;
        const flat = await flatField(fixed).catch(() => "");
        return { ...o, url: flat || fixed };
      };
      out = await balanceOut(out);
      // 白模档收边：模型容易把商品重画变形，用原图轮廓裁一遍，形状 / 位置 / 比例锁定在原商品上
      if (tier === "blockout" && canMatte && out.url) {
        const clipped = await clipToSilhouette(store, out.url, sourceUrl, abort.signal).catch(() => "");
        if (clipped) out = { ...out, url: clipped };
      }
      let verdict: { block?: string; warn?: string } = out.url
        ? await whiteModelIssue(await srcData(store, out.url), tier, before).catch(() => ({} as { block?: string; warn?: string }))
        : { block: "模型没有返回图片，换一个更强的图片模型再试一次" };
      // 只有真废图（空白 / 读不出图）才自动换一个更强的模型重试、仍不行才拦下；
      // 结构 / 颜色类问题只提示，结果照常写进版本 —— 用户花钱生成的图不能因为一次误判被丢掉。
      if (verdict.block) {
        const images = store.state.models.filter((m) => m.kind === "image" && m.id !== model?.id);
        // 优先 APIMART 上的 Gemini / GPT Image（主体理解最稳），再退到 nano banana；每个只试一次。
        const ranked = [
          /gemini-nano-banana-2\.1/i, /gpt-image-2\.6/i, /gemini-3-pro-image-preview/i, /nano[._-]?banana/i, /gpt-image-2\.[56]/i,
        ].flatMap((re) => images.filter((m) => re.test(m.id))).slice(0, 2);
        for (const alt of ranked) {
          store.patchRun(tid, { progress: .05 });
          const retryRaw = await store.backend.editImage({ ...req, model: alt }, onEvent, abort.signal).catch(() => null);
          if (!retryRaw?.url) continue;
          const retry = await balanceOut(retryRaw);
          verdict = await whiteModelIssue(await srcData(store, retry.url || ""), tier, before).catch(() => ({} as { block?: string; warn?: string }));
          if (!verdict.block) { out = retry; break; }
        }
        if (verdict.block) throw new Error(verdict.block);
      }
      warn = verdict.warn || "";
    }
    store.setRun(tid, null); await applyVariant(store, tid, out, label);
    if (warn) store.toast(warn, 6000);
    store.logRun({ node: tid, title: genOf(store.node(tid)!).title, type: "image", model: label, status: "done", secs: 0 });
  } catch (err) {
    store.setRun(tid, null);
    if (!(err instanceof GenError && err.code === "STOPPED")) {
      store.patchGen(tid, { err: err instanceof Error ? err.message : label + "失败" });
      onError?.(err instanceof Error ? err : new Error(label + "失败"));
    }
  }
}

/* ---------- 抠图：走本地 RMBG，没下载模型就先引导下载（下载完自动继续抠图） ---------- */
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function etaText(sec: number) {
  if (!(sec > 0)) return "";
  return sec < 60 ? `剩余约 ${Math.round(sec)} 秒` : `剩余约 ${Math.ceil(sec / 60)} 分钟`;
}

/** 抠图入口：先查本地模型状态 —— 已下载直接抠，没下载弹窗；后端没有这套接口时退回原来的抠图 */
async function startCutout(ctl: Ctl, id: string) {
  const store = ctl.store; const be = store.backend;
  if (!be.mattingModelStatus || !be.mattingModelDownload) { void runCutout(ctl, id); return; }
  const st = await be.mattingModelStatus().catch(() => undefined);
  if (!st) { void runCutout(ctl, id); return; }
  if (st.downloaded) { void runCutout(ctl, id); return; }
  openModal((close) => <MattingModelModal ctl={ctl} id={id} initial={st} close={close} />, "mm");
}
function runCutout(ctl: Ctl, id: string) {
  return runEdit(ctl.store, id, "cutout", "抠图", {}, undefined, (err) => ctl.store.toast(err.message));
}

function MattingModelModal({ ctl, id, initial, close }: { ctl: Ctl; id: string; initial: MattingModelStatus; close: () => void }) {
  const store = ctl.store;
  const [st, setSt] = useState<MattingModelStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(true); const polling = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (initial.downloading) void poll();
    return () => { alive.current = false; };
  }, []);
  const sizeMb = Math.round(Number(st.model_size_mb || st.total_mb) || 349);
  const gotMb = Math.round(Number(st.downloaded_mb) || 0);
  const pct = Math.max(0, Math.min(100, Math.round(Number(st.progress) || 0)));
  const resume = gotMb > 1 && gotMb < sizeMb;
  const downloading = !!st.downloading || !!st.verifying;
  const beginCutout = () => { close(); store.toast("本地抠图模型已就绪，开始抠图"); void runCutout(ctl, id); };
  /** 下载中每秒轮询一次：进度 / 速度 / 剩余时间；完成就自动接着抠图，中断则留在弹窗里说原因 */
  async function poll() {
    if (polling.current) return;
    polling.current = true;
    while (alive.current) {
      await wait(1000);
      if (!alive.current) break;
      const next = await store.backend.mattingModelStatus!().catch(() => null);
      if (!alive.current) break;
      if (!next) continue;
      setSt(next);
      if (next.downloaded) { polling.current = false; beginCutout(); return; }
      if (!next.downloading && !next.verifying) {
        setErr(next.cancelled ? "" : next.error || "下载中断，已下载的部分会保留，点重试接着下");
        polling.current = false;
        return;
      }
    }
    polling.current = false;
  }
  const start = async () => {
    setBusy(true); setErr("");
    try {
      const r = await store.backend.mattingModelDownload!();
      if (!r.ok) { setErr(r.error || "下载启动失败，稍后重试"); return; }
      if (r.downloaded) { beginCutout(); return; }
      setSt((s) => ({ ...s, downloading: true, progress: Number(s.progress) || 0 }));
      void poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "下载启动失败，稍后重试");
    } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!st.verifying) { await store.backend.mattingModelCancel?.().catch(() => undefined); store.toast("已取消下载，下次会接着下"); }
    close();
  };
  return <><ModalHead title="本地抠图模型" /><div className="mbd">
    {downloading ? <>
      <div className="mm-bar"><i style={{ width: pct + "%" }} /></div>
      <div className="mm-meta">
        <span>{st.verifying ? "正在校验文件…" : `${pct}% · 已下载 ${gotMb} / ${sizeMb} MB`}</span>
        <span>{st.verifying ? "" : [st.speed_mbps ? `${Number(st.speed_mbps).toFixed(1)} MB/s` : "", etaText(Number(st.eta_seconds) || 0)].filter(Boolean).join(" · ")}</span>
      </div>
      {st.retrying && st.hint ? <p className="mm-hint">{st.hint}（第 {Number(st.attempt) || 1} 次尝试）</p> : null}
      <div className="mm-acts"><button className="btn" onClick={() => void stop()}>{st.verifying ? "后台继续" : "取消下载"}</button></div>
    </> : <>
      <p className="mm-text">本地抠图模型 约 {sizeMb} MB，只下这一次；下完离线可用，发丝和半透明边缘更干净。</p>
      {resume ? <p className="mm-text">上次已下载 {gotMb} MB，这次会接着下。</p> : null}
      {st.load_error ? <p className="mm-err"><Icon name="alert" size="s" />{st.load_error}</p> : null}
      {err ? <p className="mm-err"><Icon name="alert" size="s" />{err}</p> : null}
      <div className="mm-acts">
        <button className="btn" onClick={close}>取消</button>
        <button className="btn solid" disabled={busy} data-k="matting-download" onClick={() => void start()}><Icon name="download" size="s" />{busy ? "正在开始…" : err ? "重试下载" : resume ? "继续下载并抠图" : "下载并抠图"}</button>
      </div>
    </>}
  </div></>;
}

/* ---------- 增强：本地超分（免费、离线），没实现这套接口的后端退回在线 AI 增强 ---------- */
/** 后端没有本地超分时直接走在线 AI 增强，别让用户点了本地项没反应 */
function fallbackEnhance(ctl: Ctl, id: string) {
  const store = ctl.store; const n = store.node(id);
  store.toast("当前后端没有本地超分，已改用 AI 增强");
  if (n) void runEdit(store, id, "enhance", "增强", { prompt: enhancePrompt(n) });
}

/** 本地超分入口：先查运行时 —— 装好直接超分，没装（或正在下）就弹窗下载，下完自动接着超分 */
async function startLocalUpscale(ctl: Ctl, id: string, target: "2k" | "4k") {
  const be = ctl.store.backend;
  if (!be.upscaleLocal) { fallbackEnhance(ctl, id); return; }
  const st = await be.upscaleRuntimeStatus?.().catch(() => undefined);
  // 状态查不到时也照跑：接口自己会把「未安装 / 不支持」翻译成人话
  if (!st || st.installed) { void runUpscale(ctl, id, target); return; }
  openModal((close) => <UpscaleRuntimeModal ctl={ctl} id={id} target={target} initial={st} close={close} />, "mm");
}

/** 跑本地超分：节点进生成态，结果作为新版本写回；原图已经够大时后端指回原图，不再写新版本 */
async function runUpscale(ctl: Ctl, id: string, target: "2k" | "4k") {
  const store = ctl.store; const n = store.node(id); const src = n ? outOf(n)?.url : "";
  if (!n || !src) { store.toast("这张图还没有画面，先上传或生成一张再超分"); return; }
  const label = target === "4k" ? "本地超分 4K" : "本地超分 2K";
  const abort = new AbortController(); const started = Date.now();
  store.setRun(id, { status: "running", progress: .02, abort, startedAt: started });
  try {
    const out = await store.backend.upscaleLocal!(await srcData(store, src), target);
    store.setRun(id, null);
    // 接口没有中止参数：点停止只能丢掉结果，后端那趟超分仍会跑完
    if (abort.signal.aborted) return;
    // 上一次失败留下的错误横幅：这次成功了要一起清掉，否则新版本和旧报错会同时挂在节点上
    store.patchGen(id, { err: undefined });
    if (out.skipped) { store.toast("原图已经达到这个精度，不用再放大"); return; }
    await applyVariant(store, id, out, label, true);
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    store.toast(`${label}完成，用了 ${secs} 秒；原图保留在历史版本里（‹ › 切换）`);
    store.logRun({ node: id, title: genOf(store.node(id)!).title, type: "image", model: label, status: "done", secs });
  } catch (err) {
    store.setRun(id, null);
    const text = err instanceof Error ? err.message : label + "失败";
    store.patchGen(id, { err: text });
    store.toast(text);
  }
}

function UpscaleRuntimeModal({ ctl, id, target, initial, close }: { ctl: Ctl; id: string; target: "2k" | "4k"; initial: UpscaleRuntimeStatus; close: () => void }) {
  const store = ctl.store;
  const [st, setSt] = useState<UpscaleRuntimeStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(true); const polling = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (initial.downloading) void poll();
    return () => { alive.current = false; };
  }, []);
  const pct = Math.max(0, Math.min(100, Math.round(Number(st.progress) || 0)));
  const downloading = !!st.downloading;
  const beginUpscale = () => { close(); store.toast("本地超分组件已就绪，开始超分"); void runUpscale(ctl, id, target); };
  /** 下载中每秒轮询（进度和文案都只用后端给的）；装好就自动接着超分，中断就留在弹窗里显示后端 message */
  async function poll() {
    if (polling.current) return;
    polling.current = true;
    while (alive.current) {
      await wait(1000);
      if (!alive.current) break;
      const next = await store.backend.upscaleRuntimeStatus?.().catch(() => null);
      if (!alive.current) break;
      if (!next) continue;
      setSt(next);
      if (next.installed) { polling.current = false; beginUpscale(); return; }
      if (!next.downloading) { setErr(next.message || "下载中断，点重试接着下"); polling.current = false; return; }
    }
    polling.current = false;
  }
  const start = async () => {
    setBusy(true); setErr("");
    try {
      const r = await store.backend.upscaleRuntimeDownload!();
      if (!r.ok) { setErr(r.error || "下载启动失败，稍后重试"); return; }
      if (r.installed) { beginUpscale(); return; }
      setSt((s) => ({ ...s, downloading: true, progress: Number(s.progress) || 0, message: "正在开始下载" }));
      void poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "下载启动失败，稍后重试");
    } finally { setBusy(false); }
  };
  return <><ModalHead title="本地超分组件" /><div className="mbd">
    {downloading ? <>
      <div className="mm-bar"><i style={{ width: pct + "%" }} /></div>
      <div className="mm-meta"><span>本地超分组件</span><span>{st.message || "正在下载…"}</span></div>
      <div className="mm-acts"><button className="btn" onClick={close}>后台继续</button></div>
    </> : <>
      <p className="mm-text">本地 {target === "4k" ? "4K" : "2K"} 超分用本机组件放大这张图，不花 API 额度。第一次用要先下载超分组件（约 50 MB，只下一次，之后离线可用），下完自动接着放大。</p>
      {err ? <p className="mm-err"><Icon name="alert" size="s" />{err}</p> : null}
      <div className="mm-acts">
        <button className="btn" onClick={close}>取消</button>
        <button className="btn solid" disabled={busy} data-k="hd-download" onClick={() => void start()}><Icon name="download" size="s" />{busy ? "正在开始…" : err ? "重试下载" : "下载并超分"}</button>
      </div>
    </>}
  </div></>;
}

/** ⌘I「指向编辑」：在图片上圈出要改的地方再写说明（标注编辑器） */
export function openPointEdit(id: string) { setEd({ type: "mask", id, mode: "annot" }); }
export function openEditor(ctl: Ctl, kind: string, id: string, anchor?: Element) {
  const store = ctl.store; const n = store.node(id); if (!n) return;
  if (kind === "crop") return setEd({ type: "crop", id });
  if (kind === "markup") return setEd({ type: "markup", id });
  if (kind === "rotate") return void transformImage(store, id, "cw");
  if (kind === "mask") return setEd({ type: "mask", id, mode: "redraw" });
  if (kind === "angle") return openModal(() => <AngleModal ctl={ctl} id={id} />);
  if (kind === "relight") return openModal(() => <RelightModal ctl={ctl} id={id} />);
  if (kind === "whitemodel") return setEd({ type: "whitemodel", id });
  // 无损改图是全屏编辑层（有自己的 iframe + Esc 处理），不进 openModal，否则 Esc 会和 picker 打架
  if (kind === "adjust") return openColorAdjust(id);
  if (kind === "lossless") return openLosslessEdit(id);
  if (kind === "frame") return void captureFrame(store, n, "current");
  if (kind === "cropframe") return void frameThen(ctl, n, "crop");
  if (kind === "eraseframe") return void frameThen(ctl, n, "erase");
  if (kind === "firstframe") return void captureFrame(store, n, "first");
  if (kind === "lastframe") return void captureFrame(store, n, "last");
  if (kind === "setcover") return void setVideoCover(store, n);
  if (kind === "applycanvas") return void applyVideoToCanvas(store, n);
  if (kind === "more" && anchor) return openPop(anchor, (close) => <MoreMenu ctl={ctl} id={id} n={n} close={close} />, "down", "left", "split-menu-pop");
}

/* ---------- 「更多」菜单里的子浮层（旋转 / 快速切分 / 增强共用） ---------- */
type FlyKey = "rotate" | "split" | "enhance" | "layersplit";

/**
 * 子浮层的开合与定位（旋转 / 快速切分 / 增强共用，避免两份 measure）：
 * 没有浮层时悬停行立刻打开；已有浮层时换行要「停留 200ms」才切 —— 指针常常会斜穿相邻行去点
 * 旁边的子菜单项，扫过就切会把浮层抢走。指针离开该行或进入任意浮层都会取消这次切换。
 * 指针离开行或浮层 140ms 后收起（跨过 8px 间隙进浮层时取消关闭）；key 是单值，同一时刻只开一个。
 * 位置按行 / #pop 的实测矩形算：贴菜单面板右缘 8px，顶部对齐行并 clamp 进视口（下方不够上移），
 * 右侧放不下就翻到菜单左侧。
 */
function useMenuFlyout() {
  const [key, setKey] = useState<FlyKey | null>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const rowEl = useRef<HTMLElement | null>(null);
  const flyEl = useRef<HTMLDivElement | null>(null);
  const hideT = useRef<number | null>(null);
  const switchT = useRef<number | null>(null);
  // 进浮层 / 离开行都走它：延时关闭和「待切换」两个定时器一起清掉
  const clearHide = () => {
    if (hideT.current != null) { window.clearTimeout(hideT.current); hideT.current = null; }
    if (switchT.current != null) { window.clearTimeout(switchT.current); switchT.current = null; }
  };
  // 悬停 / 聚焦一行：没有浮层时立刻开（悬停即弹出）；已有浮层且换行时先记一个 200ms 的切换意图，
  // 指针在同一行停留够久才真的切，斜穿这一行去点旁边的子菜单项则不算。
  const open = (k: FlyKey, el: HTMLElement | null) => {
    clearHide();
    if (key == null) { rowEl.current = el; setKey(k); return; }
    if (key === k) return;
    switchT.current = window.setTimeout(() => { switchT.current = null; rowEl.current = el; setKey(k); }, 200);
  };
  const hideSoon = () => { clearHide(); hideT.current = window.setTimeout(() => setKey(null), 140); };
  useEffect(() => clearHide, []);
  useLayoutEffect(() => {
    if (!key) { setPos(null); return; }
    const measure = () => {
      const row = rowEl.current, el = flyEl.current; if (!row || !el) return;
      const pop = row.closest("#pop"); if (!pop) return;
      const pr = pop.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const margin = 8, gap = 8, fw = el.offsetWidth, fh = el.offsetHeight;
      const top = clamp(rr.top - pr.top, margin - pr.top, Math.max(margin - pr.top, innerHeight - margin - fh - pr.top));
      const toRight = pr.width + gap;
      const flip = pr.left + toRight + fw > innerWidth - margin && pr.left - gap - fw >= margin;
      const next: { top: number; left?: number; right?: number } = flip
        ? { top, right: pr.width + gap }
        : { top, left: clamp(toRight, margin - pr.left, Math.max(margin - pr.left, innerWidth - margin - fw - pr.left)) };
      setPos((cur) => (cur && cur.top === next.top && cur.left === next.left && cur.right === next.right ? cur : next));
    };
    measure();
    // 菜单自己的入场动画（scale/位移）期间量到的矩形会偏一点，动画结束后再校一次
    const settle = window.setTimeout(measure, 260);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (flyEl.current) ro?.observe(flyEl.current);
    window.addEventListener("resize", measure);
    return () => { window.clearTimeout(settle); ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [key]);
  return { key, pos, flyEl, open, hideSoon, clearHide };
}

/**
 * 「更多」菜单：整块内容进组件，因为旋转 / 快速切分 / 增强的子浮层要挂在这个弹层内部 ——
 * 二级 openPop 会顶掉父菜单（父菜单整个消失），所以子菜单都改成菜单内的绝对定位浮层：
 * 父菜单保持展开，浮层贴在对应行右侧、顶部跟行对齐，悬停另一行会自动切换。
 */
function MoreMenu({ ctl, id, n, close }: { ctl: Ctl; id: string; n: CanvasNode; close: () => void }) {
  const store = ctl.store;
  const fly = useMenuFlyout();
  const flyStyle: React.CSSProperties = {
    top: fly.pos?.top ?? 0, visibility: fly.pos ? undefined : "hidden",
    ...(fly.pos?.right != null ? { right: fly.pos.right } : { left: fly.pos?.left ?? 0 }),
  };
  return <>
    <button className="mi" data-k="open-outpaint" onClick={() => { close(); setEd({ type: "outpaint", id }); }}><Icon name="outpaint" size="s" />扩图</button>
    <button className="mi" onClick={() => { close(); setEd({ type: "mask", id, mode: "erase" }); }}><Icon name="eraser" size="s" />擦除</button>
    <button className="mi" onClick={() => { close(); setEd({ type: "mask", id, mode: "annot" }); }}><Icon name="annot" size="s" />标注</button>
    {/* 2.0.08 收窄工具条时把这两个入口漏了（编辑器一直在，只是没按钮）：补回「更多」前部 */}
    <button className="mi" data-k="crop" onClick={() => { close(); openEditor(ctl, "crop", id); }}><Icon name="crop" size="s" />裁剪 / 旋转</button>
    <button className="mi" data-k="markup" onClick={() => { close(); openEditor(ctl, "markup", id); }}><Icon name="pencil" size="s" />涂鸦 / 文字 / 马赛克</button>
    {/* 低频 AI 特效：与条上按钮同一条 openEditor 路由，功能不变 */}
    <button className="mi" data-k="angle" onClick={() => { close(); openEditor(ctl, "angle", id); }}><Icon name="cube" size="s" />多角度</button>
    <button className="mi" data-k="relight" onClick={() => { close(); openEditor(ctl, "relight", id); }}><Icon name="sun" size="s" />重打光</button>
    <button className="mi" data-k="whitemodel" onClick={() => { close(); openEditor(ctl, "whitemodel", id); }}><Icon name="user" size="s" />白膜处理</button>
    <div className={"mi enhance-menu" + (fly.key === "enhance" ? " on" : "")} role="button" tabIndex={0} data-k="enhance-menu" aria-expanded={fly.key === "enhance"}
      onPointerEnter={(e) => fly.open("enhance", e.currentTarget)} onPointerLeave={fly.hideSoon}
      onFocus={(e) => fly.open("enhance", e.currentTarget)} onClick={(e) => fly.open("enhance", e.currentTarget)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fly.open("enhance", e.currentTarget); } }}>
      <Icon name="sparkle" size="s" />增强
      <Icon name="right" size="s" className="chev" />
    </div>
    <button className="mi" onClick={() => { close(); openModal(() => <ResizeModal ctl={ctl} id={id} />); }}><Icon name="resize" size="s" />调整像素</button>
    <button className="mi" data-k="cutout" onClick={() => { close(); void startCutout(ctl, id); }}><Icon name="scissors" size="s" />抠图</button>
    <div className={"mi rotate-menu" + (fly.key === "rotate" ? " on" : "")} role="button" tabIndex={0} data-k="rotate-menu" aria-expanded={fly.key === "rotate"}
      onPointerEnter={(e) => fly.open("rotate", e.currentTarget)} onPointerLeave={fly.hideSoon}
      onFocus={(e) => fly.open("rotate", e.currentTarget)} onClick={(e) => fly.open("rotate", e.currentTarget)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fly.open("rotate", e.currentTarget); } }}>
      <Icon name="undo" size="s" />旋转
      <Icon name="right" size="s" className="chev" />
    </div>
    <div className={"mi split-menu" + (fly.key === "split" ? " on" : "")} role="button" tabIndex={0} data-k="split-menu" aria-expanded={fly.key === "split"}
      onPointerEnter={(e) => fly.open("split", e.currentTarget)} onPointerLeave={fly.hideSoon}
      onFocus={(e) => fly.open("split", e.currentTarget)} onClick={(e) => fly.open("split", e.currentTarget)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fly.open("split", e.currentTarget); } }}>
      <Icon name="grid" size="s" />快速切分
      <Icon name="right" size="s" className="chev" />
    </div>
    <div className={"mi layersplit-menu" + (fly.key === "layersplit" ? " on" : "")} role="button" tabIndex={0} data-k="layersplit-menu" aria-expanded={fly.key === "layersplit"}
      onPointerEnter={(e) => fly.open("layersplit", e.currentTarget)} onPointerLeave={fly.hideSoon}
      onFocus={(e) => fly.open("layersplit", e.currentTarget)} onClick={(e) => fly.open("layersplit", e.currentTarget)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fly.open("layersplit", e.currentTarget); } }}>
      <Icon name="layers" size="s" />拆分图层
      <Icon name="right" size="s" className="chev" />
    </div>
    {fly.key === "rotate" ? <div ref={fly.flyEl} className="rotate-flyout" data-k="rotate-flyout"
      onPointerEnter={fly.clearHide} onPointerLeave={fly.hideSoon} style={flyStyle}>
      {([["ccw", "左旋 90°", "rotate-ccw"], ["cw", "右旋 90°", "rotate-cw"], ["fh", "水平翻转", "rotate-fh"], ["fv", "垂直翻转", "rotate-fv"]] as const).map(([op, label, k]) => (
        <button key={op} className="mi" data-k={k} onClick={() => { close(); void transformImage(store, id, op); }}>{label}</button>
      ))}
    </div> : null}
    {fly.key === "split" ? <div ref={fly.flyEl} className="split-flyout" data-k="split-grid" data-testid="split-flyout"
      onPointerEnter={fly.clearHide} onPointerLeave={fly.hideSoon} style={flyStyle}>
      <SplitGrid ctl={ctl} id={id} close={close} />
    </div> : null}
    {fly.key === "layersplit" ? <div ref={fly.flyEl} className="rotate-flyout" data-k="layersplit-flyout"
      onPointerEnter={fly.clearHide} onPointerLeave={fly.hideSoon} style={flyStyle}>
      <button className="mi" data-split-mode="auto" title="自动识别图层和文字，先出结果再调" onClick={() => { close(); openSplitEditor(id, "auto"); }}>自动拆分</button>
      <button className="mi" data-split-mode="custom" title="框选区域并描述，只拆你圈出的部分" onClick={() => { close(); openSplitEditor(id, "custom"); }}>自定义拆分</button>
    </div> : null}
    {fly.key === "enhance" ? <div ref={fly.flyEl} className="rotate-flyout" data-k="enhance-flyout"
      onPointerEnter={fly.clearHide} onPointerLeave={fly.hideSoon} style={flyStyle}>
      <button className="mi" data-k="hd-2k" onClick={() => { close(); void startLocalUpscale(ctl, id, "2k"); }}>本地 2K<span className="k">免费 · 离线</span></button>
      <button className="mi" data-k="hd-4k" onClick={() => { close(); void startLocalUpscale(ctl, id, "4k"); }}>本地 4K<span className="k">免费 · 离线</span></button>
      <button className="mi" data-k="enhance-ai" onClick={() => { close(); void runEdit(store, id, "enhance", "增强", { prompt: enhancePrompt(n) }); }}>AI 增强 2×<span className="k">在线模型</span></button>
    </div> : null}
  </>;
}

/**
 * 网格格子与读数：面板外壳由 .split-flyout 提供（近实底 / 圆角 / 内边距）。
 * 鼠标移到哪格就预览「列 × 行」，左上角那块就是将要切出的张数范围。
 */
const SPLIT_MAX = 8;
function SplitGrid({ ctl, id, close }: { ctl: Ctl; id: string; close: () => void }) {
  const [pick, setPick] = useState({ cols: 1, rows: 1 });
  const cells: React.ReactNode[] = [];
  for (let r = 1; r <= SPLIT_MAX; r++) for (let c = 1; c <= SPLIT_MAX; c++) cells.push(
    <button key={c + "-" + r} type="button" className={"sg-c" + (c <= pick.cols && r <= pick.rows ? " on" : "")}
      data-c={c} data-r={r} aria-label={`${c} 列 × ${r} 行`}
      onPointerEnter={() => setPick({ cols: c, rows: r })} onFocus={() => setPick({ cols: c, rows: r })}
      onClick={() => { close(); void split(ctl, id, c, r); }} />,
  );
  return <>
    <div className="sg-cells">{cells}</div>
    <div className="sg-label tnum" data-k="split-label">{pick.cols}×{pick.rows}</div>
  </>;
}

/* ---------- 叠在节点上的编辑层（裁剪 / 蒙版） ---------- */
export function EditorLayer() {
  const st = useEditorState(); const ctl = useCtl(); useS((s) => s.view); const doc = useS((s) => s.doc);
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === "Escape" && ed) { e.stopPropagation(); setEd(null); } }; addEventListener("keydown", on, true); return () => removeEventListener("keydown", on, true); }, []);
  if (!st) return null; const n = doc.nodes.find((x) => x.id === st.id); if (!n) { setTimeout(() => setEd(null)); return null; }
  const r0 = ctl.rect(); const a = ctl.toScreen(n.x, n.y + 24), b = ctl.toScreen(n.x + n.w, n.y + 24 + n.h);
  const rect = { left: a.x - r0.left, top: a.y - r0.top, width: b.x - a.x, height: b.y - a.y };
  if (st.type === "outpaint") return <Outpaint ctl={ctl} n={n} onClose={() => setEd(null)} />;
  if (st.type === "markup") return <Markup key={n.id} ctl={ctl} n={n} rect={rect} onClose={() => setEd(null)} onApply={async (url, w, h) => { setEd(null); await applyVariant(ctl.store, n.id, { url, w, h }, "标注"); }} />;
  if (st.type === "whitemodel") return <WhiteModelEditor key={n.id} ctl={ctl} n={n} rect={rect} onClose={() => setEd(null)} />;
  return st.type === "crop" ? <Crop ctl={ctl} n={n} rect={rect} /> : <Mask ctl={ctl} n={n} rect={rect} mode={st.mode || "redraw"} />;
}

/** 扩图框的外壳：把资源引用解析成可显示的原图，确认后带着合成好的 PNG 去走 outpaint */
function Outpaint({ ctl, n, onClose }: { ctl: Ctl; n: CanvasNode; onClose: () => void }) {
  const src = useAssetUrl(outOf(n)?.url || "");
  // 扩图的待补区域是画进 sourceUrl 的透明边，模型只能从画面看到 —— 提示词里再点明一遍扩展比例和目标尺寸
  const apply = (png: string, ext: Ext) => {
    onClose();
    const o = outOf(n); const bw = Number(o?.w) || 0, bh = Number(o?.h) || 0;
    const pc = (v: number) => Math.round(v * 100);
    const tw = bw ? Math.round(bw * (1 + ext.l + ext.r)) : 0, th = bh ? Math.round(bh * (1 + ext.t + ext.b)) : 0;
    const prompt = `这张图四周已经是透明待补区域（各边扩展：左 ${pc(ext.l)}%、上 ${pc(ext.t)}%、右 ${pc(ext.r)}%、下 ${pc(ext.b)}%${bw && bh && tw && th ? `；原图 ${bw}×${bh}，目标 ${tw}×${th} 像素` : ""}）：请把透明区域自然延展补全，延续原图的透视、光照、阴影、风格和纹理，接缝自然过渡；原图已有内容保持不变。`;
    void runEdit(ctl.store, n.id, "outpaint", "扩图", { sourceUrl: png, params: { ext, prepadded: true }, prompt });
  };
  return <OutpaintFrame ctl={ctl} n={n} source={src} onClose={onClose} onApply={apply} />;
}
export const editorOpen = () => !!ed;

type Rect = { left: number; top: number; width: number; height: number };
const CROP_RATIOS = ["自由", "原图", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "4:5", "21:9"];
function Crop({ ctl, n, rect }: { ctl: Ctl; n: CanvasNode; rect: Rect }) {
  const src = useAssetUrl(outOf(n)?.url || ""); const [rs, setRs] = useState({ l: .08, t: .08, w: .84, h: .84 }); const [ratio, setRatio] = useState("自由"); const el = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const o = outOf(n); const natW = Number(o?.w) || 0, natH = Number(o?.h) || 0;
  const pq = (ra: string): [number, number] | null => ra === "自由" ? null : ra === "原图" ? (natW && natH ? [natW, natH] : el.current ? [el.current.clientWidth, el.current.clientHeight] : null) : (ra.split(":").map(Number) as [number, number]);
  const fix = (r: typeof rs, ra = ratio) => { const x = { ...r }; const k = pq(ra); if (k && el.current) { const [p, q] = k; const R = el.current.clientWidth / el.current.clientHeight; x.h = clamp((x.w * R * q) / p, .05, 1 - x.t); x.w = (x.h * p) / (q * R); } x.w = clamp(x.w, .05, 1 - x.l); x.h = clamp(x.h, .05, 1 - x.t); return x; };
  /** 换比例时以当前框中心为准、尽量撑满 */
  const fitRatio = (ra: string) => { const k = pq(ra); if (!k || !el.current) return { l: .08, t: .08, w: .84, h: .84 }; const R = el.current.clientWidth / el.current.clientHeight; const want = k[0] / k[1] / R; let w = .9, h = w / want; if (h > .9) { h = .9; w = h * want; } return { l: (1 - w) / 2, t: (1 - h) / 2, w, h }; };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); const h = (e.target as HTMLElement).closest("i")?.className || ""; const sx = e.clientX, sy = e.clientY, o0 = { ...rs }; const W = el.current!.clientWidth, H = el.current!.clientHeight; const tgt = e.currentTarget; tgt.setPointerCapture(e.pointerId);
    tgt.onpointermove = (ev) => { const dx = (ev.clientX - sx) / W, dy = (ev.clientY - sy) / H; const r = { ...o0 };
      if (!h) { r.l = clamp(o0.l + dx, 0, 1 - o0.w); r.t = clamp(o0.t + dy, 0, 1 - o0.h); }
      else { if (h.includes("l")) { r.l = clamp(o0.l + dx, 0, o0.l + o0.w - .05); r.w = o0.w + (o0.l - r.l); } if (h.includes("r")) r.w = clamp(o0.w + dx, .05, 1 - o0.l); if (h.includes("t")) { r.t = clamp(o0.t + dy, 0, o0.t + o0.h - .05); r.h = o0.h + (o0.t - r.t); } if (h.includes("b")) r.h = clamp(o0.h + dy, .05, 1 - o0.t); }
      setRs(ratio !== "自由" && h ? fix(r) : r); };
    tgt.onpointerup = () => { tgt.onpointermove = null; };
  };
  const ok = async () => {
    if (busy) return; setBusy(true);
    try { const im = await loadImg(src); const c = cv(im.naturalWidth * rs.w, im.naturalHeight * rs.h); c.getContext("2d")!.drawImage(im, -im.naturalWidth * rs.l, -im.naturalHeight * rs.t); setEd(null); const png = /\.png($|\?)/i.test(o?.url || "") || (o?.url || "").startsWith("data:image/png"); await applyVariant(ctl.store, n.id, { url: c.toDataURL(png ? "image/png" : "image/jpeg", .93), w: c.width, h: c.height }, "裁剪"); }
    catch (e) { setBusy(false); ctl.store.toast("裁剪失败：" + (e instanceof Error ? e.message : "图片读取失败")); }
  };
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void ok(); } }; addEventListener("keydown", on, true); return () => removeEventListener("keydown", on, true); });
  const pxW = natW ? Math.round(natW * rs.w) : 0, pxH = natH ? Math.round(natH * rs.h) : 0;
  const stage = ctl.rect(); const bar = useEdBar(rect.left + rect.width / 2, stage.width);
  return <>
    <div className="edov" data-ed="crop" ref={el} style={rect} onPointerDown={(e) => e.stopPropagation()}>
      {src ? <img className="crop-img" src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      <div className="crop-rect" style={{ left: rs.l * 100 + "%", top: rs.t * 100 + "%", width: rs.w * 100 + "%", height: rs.h * 100 + "%" }} onPointerDown={down}><i className="tl" /><i className="tr" /><i className="bl" /><i className="br" />{pxW && pxH ? <span className="crop-px tnum">{pxW} × {pxH}</span> : null}</div>
    </div>
    <div className="edbar" ref={bar.ref} style={{ left: bar.left, top: Math.min(rect.top + rect.height + 14, stage.height - 54), transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="取消（Esc）" onClick={() => setEd(null)}><Icon name="x" /></button><span className="vsep" />
      <button className="pill" data-k="crop-ratio" onClick={(e) => openPop(e.currentTarget, (close) => <div className="seg wrap crop-ratios">{CROP_RATIOS.map((r) => <button key={r} className={r === ratio ? "on" : ""} onClick={() => { close(); setRatio(r); setRs(r === "自由" ? rs : fitRatio(r)); }}>{r}</button>)}</div>, "up")}><Icon name="ratio" size="s" /><span>比例：{ratio}</span></button>
      <span className="vsep" />
      <button className="ib" data-tip="左转 90°" data-k="crop-ccw" disabled={busy} onClick={() => void transformImage(ctl.store, n.id, "ccw", true)}><Icon name="undo" /></button>
      <button className="ib" data-tip="右转 90°" data-k="crop-cw" disabled={busy} onClick={() => void transformImage(ctl.store, n.id, "cw", true)}><Icon name="redo" /></button>
      <button className="ib" data-tip="水平翻转" data-k="crop-fh" disabled={busy} onClick={() => void transformImage(ctl.store, n.id, "fh", true)}><Icon name="split" /></button>
      <button className="ib" data-tip="重置裁剪框" onClick={() => { setRatio("自由"); setRs({ l: 0, t: 0, w: 1, h: 1 }); }}><Icon name="fit" /></button>
      <span className="vsep" />
      <button className="pill" data-k="ok" style={{ background: "var(--solid)", color: "var(--on-solid)" }} disabled={busy} onClick={() => void ok()}><Icon name="check" size="s" />确认裁剪</button>
    </div>
  </>;
}

function Mask({ ctl, n, rect, mode }: { ctl: Ctl; n: CanvasNode; rect: Rect; mode: "redraw" | "erase" | "annot" }) {
  const cvsRef = useRef<HTMLCanvasElement>(null); const strokes = useRef<Array<{ t: string; size: number; p: Array<{ x: number; y: number }> }>>([]); const undone = useRef<typeof strokes.current>([]);
  const [tool, setTool] = useState("brush"); const [size, setSize] = useState(28); const [prompt, setPrompt] = useState(""); const [, force] = useState(0);
  // 遮罩内换品：挂一张新品图，运行时作为第三张参考图发（novai 适配器 / 桌面桥接都按 refUrl 走换品提示词）
  const [ref, setRef] = useState<{ url: string; name: string } | null>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const onRefFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || "")); r.onerror = () => rej(new Error("读取失败")); r.readAsDataURL(f); });
      setRef({ url, name: f.name }); ctl.store.toast("已带上新品参考");
    } catch (e) { ctl.store.toast(e instanceof Error ? e.message : "读取失败"); }
  };
  // 圆圈光标：直径 = 笔刷 size（半径 = size/2），只在画布内、只对鼠标 / 触控笔显示
  const [ring, setRing] = useState<{ x: number; y: number; ptype: string } | null>(null);
  const ringShown = ring ? ringVisible(tool, ring.ptype, true) : false;
  const dia = brushRadius(size) * 2;
  const title = { redraw: "局部重绘", erase: "擦除", annot: "标注" }[mode];
  const paint = () => { const c = cvsRef.current; if (!c) return; const g = c.getContext("2d")!; c.width = c.clientWidth; c.height = c.clientHeight; g.clearRect(0, 0, c.width, c.height);
    for (const s of strokes.current) { g.globalCompositeOperation = s.t === "eraser" ? "destination-out" : "source-over"; g.fillStyle = g.strokeStyle = mode === "annot" ? "rgba(255,69,58,.9)" : "rgba(255,255,255,.55)";
      if (s.t === "rect") { const [a, b] = [s.p[0], s.p[s.p.length - 1]]; if (mode === "annot") { g.lineWidth = 3; g.strokeRect(a.x * c.width, a.y * c.height, (b.x - a.x) * c.width, (b.y - a.y) * c.height); } else g.fillRect(a.x * c.width, a.y * c.height, (b.x - a.x) * c.width, (b.y - a.y) * c.height); }
      else { g.lineWidth = s.size; g.lineCap = g.lineJoin = "round"; g.beginPath(); s.p.forEach((pt, i) => (i ? g.lineTo(pt.x * c.width, pt.y * c.height) : g.moveTo(pt.x * c.width, pt.y * c.height))); g.stroke(); } }
    g.globalCompositeOperation = "source-over"; };
  useEffect(paint);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === "INPUT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) { const s = undone.current.pop(); if (s) strokes.current.push(s); } else { const s = strokes.current.pop(); if (s) undone.current.push(s); } paint(); force((x) => x + 1); }
      else if ((e.key === "[" || e.key === "]") && !typing) { e.stopPropagation(); setSize((v) => Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, v + (e.key === "]" ? 6 : -6)))); }
    };
    addEventListener("keydown", on, true); return () => removeEventListener("keydown", on, true);
  });
  const go = async () => {
    if (!strokes.current.length) return ctl.store.toast(mode === "annot" ? "先在图上画出要改的位置" : "先涂抹需要编辑的区域");
    if (mode === "redraw" && !prompt.trim()) return ctl.store.toast("写一句要改成什么");
    const src = await srcData(ctl.store, outOf(n)?.url || ""); const im = await loadImg(src); const mask = cv(im.naturalWidth, im.naturalHeight); mask.getContext("2d")!.drawImage(cvsRef.current!, 0, 0, mask.width, mask.height);
    // 遮罩 / 标注在 NOVAI 适配器里是当第二张参考图发的，不写清「哪张是什么」模型容易乱改
    const text = prompt.trim();
    const body = mode === "redraw"
      ? `按说明重绘遮罩标记的区域：${text}`
      : mode === "erase"
        ? `把遮罩标记区域里的内容完整移除，用周围画面自然补全背景、纹理和光影，不要留下痕迹${text ? `（补充：${text}）` : ""}`
        : `按红色标注的位置修改这张图：${text || "按标注处理"}；改完输出完整图片，不要保留红色笔迹，标注以外的地方保持不变`;
    setEd(null);
    await runEdit(ctl.store, n.id, mode === "annot" ? "annotate" : mode, ref && mode === "redraw" ? "换品" : title, {
      maskDataUrl: mask.toDataURL("image/png"),
      prompt: `${body}。${mode === "annot" ? ANNOT_NOTE : MASK_NOTE}`,
      ...(ref && mode === "redraw" ? { refUrl: ref!.url } : {}),
    });
  };
  const stage = ctl.rect(); const H = stage.height; const cx = rect.left + rect.width / 2;
  const tb = useEdBar(cx, stage.width); const pb = useEdBar(cx, stage.width);
  const above = barAbove(rect.top);
  const tbTop = above ?? Math.min(H - 170, rect.top + rect.height + 14);
  const pbTop = above != null ? Math.min(H - 120, rect.top + rect.height + 14) : Math.min(H - 120, tbTop + 56);
  return <>
    <div className="edov" data-ed="mask" style={rect} onPointerDown={(e) => e.stopPropagation()}>
      <canvas ref={cvsRef} className="mask-cv"
        style={{ cursor: ringShown ? "none" : "crosshair" }}
        onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setRing({ x: e.clientX - r.left, y: e.clientY - r.top, ptype: e.pointerType || "mouse" }); }}
        onPointerEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setRing({ x: e.clientX - r.left, y: e.clientY - r.top, ptype: e.pointerType || "mouse" }); }}
        onPointerLeave={() => setRing(null)}
        onPointerDown={(e) => { e.stopPropagation(); const c = e.currentTarget; c.setPointerCapture(e.pointerId); const r = c.getBoundingClientRect(); const s = { t: tool, size, p: [{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }] }; strokes.current.push(s);
        c.onpointermove = (ev) => { const pt = { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height }; if (s.t === "rect") s.p[1] = pt; else s.p.push(pt); paint(); }; c.onpointerup = () => { c.onpointermove = null; undone.current = []; force((x) => x + 1); }; }} />
      {ringShown && ring ? <div className="brush-ring" data-brush-ring data-brush-size={size} data-brush-dia={Math.round(dia)}
        style={{ left: ring.x, top: ring.y, width: dia, height: dia, transform: "translate(-50%,-50%)" }} /> : null}
    </div>
    <div className="edbar" ref={tb.ref} style={{ left: tb.left, top: tbTop, transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="关闭" onClick={() => setEd(null)}><Icon name="x" /></button><span className="vsep" /><span className="est">{title}</span>
      {([["brush", "brush", "画笔"], ["rect", "rect", "矩形"], ["eraser", "eraser", "橡皮"]] as const).map(([t, ic, tip]) => <button key={t} className={"ib" + (tool === t ? " on" : "")} data-tip={tip} onClick={() => setTool(t)}><Icon name={ic} /></button>)}
      <span className="vsep" /><input type="range" min={BRUSH_MIN} max={BRUSH_MAX} step={1} value={size} className="brush-size" aria-label="画笔大小" data-k="brush-size" onChange={(e) => setSize(+e.target.value)} /><span className="tnum est" data-k="brush-size-val">{size}px</span>
      <button className="ib" data-tip="撤销一笔（⌘Z）" onClick={() => { const s = strokes.current.pop(); if (s) undone.current.push(s); paint(); force((x) => x + 1); }}><Icon name="undo" /></button>
      <button className="ib" data-tip="重做（⇧⌘Z）" disabled={!undone.current.length} onClick={() => { const s = undone.current.pop(); if (s) strokes.current.push(s); paint(); force((x) => x + 1); }}><Icon name="redo" /></button>
      <button className="ib" data-tip="清空" disabled={!strokes.current.length} onClick={() => { undone.current = [...strokes.current].reverse(); strokes.current = []; paint(); force((x) => x + 1); }}><Icon name="trash" /></button>
      {mode === "redraw" ? <>
        <span className="vsep" />
        <input ref={refInput} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => void onRefFile(e.target.files?.[0])} />
        <button className="pill" data-k="mask-ref" data-tip="挂一张新品图：遮罩区域里的商品会换成它" onClick={() => refInput.current?.click()}><Icon name="image" size="s" /><span>参考图</span></button>
        {ref ? <span className="pill" data-k="mask-ref-chip" style={{ gap: 6 }}><img src={ref.url} alt="" style={{ width: 18, height: 18, borderRadius: 4, objectFit: "cover" }} /><button className="ib" data-tip="移除参考图" onClick={() => setRef(null)}><Icon name="x" size="xs" /></button></span> : null}
      </> : null}
    </div>
    <div className="edprompt" ref={pb.ref} style={{ left: pb.left, top: pbTop, transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void go(); }} placeholder={mode === "erase" ? "可选：说明要擦掉什么（例如：去掉挂绳）" : mode === "annot" ? "描述标注要做的修改，例如：箭头处的 Logo 放大" : "描述你想改变什么…"} />
      <div className="gp-foot"><span className="est">{ref && mode === "redraw" ? "已带上新品参考 · 开始换品" : mode === "erase" ? "涂抹要擦除的区域" : mode === "annot" ? "在图上圈出要改的位置" : "绘制蒙版以重绘"}</span><span className="sp" /><button className="send" data-k="go" onClick={() => void go()}><Icon name="send" size="s" /></button></div>
    </div>
  </>;
}

/* ---------- 对话框：多角度 / 重打光 / 调整像素 ---------- */
function AngleModal({ ctl, id }: { ctl: Ctl; id: string }) {
  const n = ctl.store.node(id)!; const src = useAssetUrl(outOf(n)?.url || "");
  const [yaw, setYaw] = useState(23), [pitch, setPitch] = useState(-12), [zoom, setZoom] = useState(1), [wide, setWide] = useState(false);
  // 角度描述也写进提示词：有的后端（NOVAI 适配器）只转发 prompt，params 不一定被读
  const angleText = () => `水平旋转 ${yaw}°，俯仰 ${pitch}°，缩放 ${zoom.toFixed(1)} 倍${wide ? "，广角镜头" : ""}`;
  const go = () => {
    closeModal(); const store = ctl.store;
    const v = withGen({ id: uid("n"), kind: "image", x: n.x + n.w + 80, y: n.y, w: n.w, h: n.h, text: "" }, { ...genOf(n), title: `多角度 ${yaw}°`, prompt: "", hist: [], hi: 0, order: [] });
    store.addNodes([v], [{ id: uid("e"), from: n.id, to: v.id }], { select: true });
    void runEdit(store, id, "angle", "多角度", { params: { yaw, pitch, zoom, wide }, prompt: angleText() }, v.id);
  };
  return <><ModalHead title="多角度" /><div className="mbd">
    <div className="angle-stage">
      <div className="grid" /><div className="card3d" style={{ transform: `rotateY(${yaw}deg) rotateX(${-pitch}deg) scale(${zoom})` }}>{src ? <img src={src} alt="" /> : null}</div></div>
    <p style={{ color: "var(--fg3)", fontSize: 12, margin: "8px 0" }}>拖滑杆调整视角。生成一个新视角的图片节点，原图不变，并自动连线。</p>
    <div className="ctlrow"><span>旋转</span><input type="range" className="slider" min={-180} max={180} step={1} value={yaw} onChange={(e) => setYaw(+e.target.value)} /><span className="tnum">{yaw}°</span></div>
    <div className="ctlrow"><span>俯仰</span><input type="range" className="slider" min={-90} max={90} step={1} value={pitch} onChange={(e) => setPitch(+e.target.value)} /><span className="tnum">{pitch}°</span></div>
    <div className="ctlrow"><span>缩放</span><input type="range" className="slider" min={50} max={200} step={1} value={Math.round(zoom * 100)} onChange={(e) => setZoom(+e.target.value / 100)} /><span className="tnum">{Math.round(zoom * 100)}%</span></div>
    <div className="row" style={{ padding: "6px 0" }}><span>广角镜头</span><button className={"sw" + (wide ? " on" : "")} onClick={() => setWide(!wide)} /></div>
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}><button className="btn" onClick={() => { setYaw(0); setPitch(0); setZoom(1); }}>重置</button><button className="btn solid" id="ago" onClick={go}>生成新视角</button></div>
  </div></>;
}
function RelightModal({ ctl, id }: { ctl: Ctl; id: string }) {
  const n = ctl.store.node(id)!; const src = useAssetUrl(outOf(n)?.url || "");
  const [lx, setLx] = useState(.25), [ly, setLy] = useState(.3), [inten, setInten] = useState(70), [temp, setTemp] = useState(40); const [pv, setPv] = useState("");
  useEffect(() => { if (!src) return; let alive = true; const t = setTimeout(() => void (relit(src, lx, ly, inten, temp, 360) as Promise<string>).then((u) => { if (alive) setPv(u); }).catch(() => undefined), 60); return () => { alive = false; clearTimeout(t); }; }, [src, lx, ly, inten, temp]);
  // 参数用人话写进提示词：NOVAI 适配器只转 prompt，params 只带给 BEAT 桌面版
  const relightPrompt = () => {
    const ct = colorTemp(temp);
    return `保持画面内容、构图和主体完全不变，只重新打光：主光从${lightDir(lx, ly)}打来，光照强度 ${inten}%，色温${ct.label}（约 ${ct.kelvin}K）；阴影和高光随光源方向自然变化，不要新增、删除或替换任何内容。`;
  };
  return <><ModalHead title="重打光" /><div className="mbd">
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <div className="light-pad" onPointerDown={(e) => { const el = e.currentTarget; el.setPointerCapture(e.pointerId); const mv = (ev: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); setLx(clamp((ev.clientX - r.left) / r.width, 0, 1)); setLy(clamp((ev.clientY - r.top) / r.height, 0, 1)); }; mv(e); el.onpointermove = mv; el.onpointerup = () => (el.onpointermove = null); }}><i style={{ left: lx * 100 + "%", top: ly * 100 + "%" }} /></div>
      <div style={{ flex: 1, minWidth: 200 }}><img src={pv || src} style={{ width: "100%", borderRadius: 12, maxHeight: 220, objectFit: "contain", background: "var(--s0)" }} alt="" /></div>
    </div>
    <div className="ctlrow"><span>强度</span><input type="number" className="slider" min={10} max={100} value={inten} onChange={(e) => setInten(+e.target.value)} /><span className="tnum">{inten}%</span></div>
    <div className="ctlrow"><span>色温</span><input type="number" className="slider" min={0} max={100} value={temp} onChange={(e) => setTemp(+e.target.value)} /><span>{temp < 40 ? "偏暖" : temp > 60 ? "偏冷" : "中性"}</span></div>
    <p style={{ color: "var(--fg3)", fontSize: 12, margin: "8px 0 0" }}>预览是本地近似效果，点「应用」由节点当前的图片模型按光源方向、强度和色温重新打光（参数会写进提示词）。</p>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}><button className="btn solid" id="rgo" onClick={() => { closeModal(); void runEdit(ctl.store, id, "relight", "重打光", { params: { lx, ly, intensity: inten, temp }, prompt: relightPrompt() }); }}>应用</button></div>
  </div></>;
}
/**
 * 白膜处理：和「涂鸦」一样叠在节点上操作 —— 底下一条浮动工具条选模型 / 开始，不再弹居中对话框（取消、Esc 关掉）。
 * 模型理解力弱的会把穿搭留下来或生成空白，所以默认优先 APIMART 的 Gemini，并在生成后自检。
 */
/**
 * 白膜处理：和「涂鸦」一样叠在节点上操作 —— 底下一条浮动工具条选档位 / 模型 / 开始，不再弹居中对话框。
 * 三档：产品（商品未上色石膏粗模，默认）、人物（白色人台）、清空商品（商品移除，只留干净场景）。
 * 模型理解力弱的会把穿搭留下来、生成空白或换错主体，所以生成后还会自检。
 */
const WHITE_TIERS: Array<{ id: WhiteTier; label: string; tip: string }> = [
  { id: "blockout", label: "产品", tip: "把商品做成白色模型：保留外形、机位和投影，抹掉 logo、缝线、装饰和反光，纯白底" },
  { id: "mannequin", label: "人物", tip: "把人物变成白色人台：脱掉衣服，保留姿态和构图，纯白底" },
  { id: "clear", label: "清空商品", tip: "把商品连它的影子一起拿掉，只留干净场景" },
];
const tierIcon = (t: WhiteTier) => t === "clear" ? "eraser" : t === "blockout" ? "cube" : "user";
function WhiteModelEditor({ ctl, n, rect, onClose }: { ctl: Ctl; n: CanvasNode; rect: Rect; onClose: () => void }) {
  const store = ctl.store; const src = useAssetUrl(outOf(n)?.url || "");
  const all = store.state.models.filter((m) => m.kind === "image");
  const nodeModel = store.modelOf(n);
  const mannequinBest = all.find((m) => /gemini-3-pro-image-preview/i.test(m.id))
    || all.find((m) => /gemini-nano-banana-2\.1/i.test(m.id))
    || all.find((m) => /nano[._-]?banana/i.test(m.id))
    || all.find((m) => /gpt-image-2\.[56]/i.test(m.id))
    || nodeModel;
  const [tier, setTier] = useState<WhiteTier>("blockout");
  const bestFor = () => mannequinBest;
  const pickTier = (t: WhiteTier) => { setTier(t); setModelId(bestFor()?.id || ""); };
  const [modelId, setModelId] = useState(bestFor()?.id || nodeModel?.id || "");
  const model = all.find((m) => m.id === modelId) || bestFor() || nodeModel;
  const shortName = (m: ModelSpec) => /gemini-3-pro-image-preview/i.test(m.id) ? "Gemini 3 Pro"
    : /gemini-nano-banana-2\.1/i.test(m.id) ? "Nano Banana 2.1"
    : /gpt-image-2\.6/i.test(m.id) ? "GPT Image 2.6"
    : /nano[._-]?banana/i.test(m.id) ? "Nano Banana"
    : /gpt-image-2\.5/i.test(m.id) ? "GPT Image 2.5"
    : (m.name || m.id);
  const stage = ctl.rect(); const bar = useEdBar(rect.left + rect.width / 2, stage.width);
  const run = () => { onClose(); void runEdit(store, n.id, "whitemodel", "白膜", { model, params: { tier } }, undefined, (err) => store.toast(err.message)); };
  // 模型选择跟参数浮层同一套：先选供应商，再选这个供应商下的模型（ComboMenu 两级 + 搜索）
  const vendorOf = (m: ModelSpec) => (m.vendor || "").trim() || "未命名供应商";
  const currentVendor = model ? vendorOf(model) : "";
  // 当前供应商排最前，打开菜单第一眼就能看到自己正在用的那家
  const vendors = [...new Set(all.map(vendorOf))].sort((a, b) => (b === currentVendor ? 1 : 0) - (a === currentVendor ? 1 : 0));
  // 编辑器的模型菜单怎么选，这里就怎么选：先弹「供应商」列表，点进去换成这家供应商的模型列表（顶部可返回），
  // 每次只有一层列表、各自一个浮层，不做成一整块带背景的双栏。
  // 菜单自己贴住编辑条上方 8px（和编辑器里的参数菜单同一个距离）：底边锚定，列表再长也往上长，不会压住浮条
  // 档位和模型共用同一个浮层容器：都是「一颗 pill + 点开一层磨砂菜单」，贴着编辑条上沿
  const [pick, setPick] = useState<{ left: number; bottom: number; vendor?: string; tier?: boolean } | null>(null);
  const openMenu = (fallback: Element, extra?: { tier?: boolean }) => {
    // 以被点的那颗 pill 为准水平居中（.wm-pick-menu 宽 300）；底边仍贴住编辑条上沿 8px
    const r = fallback.getBoundingClientRect();
    const barRect = (bar.ref.current as Element | null)?.getBoundingClientRect();
    const top = barRect ? barRect.top : r.top;
    setPick({ left: Math.max(8, Math.min(r.left + r.width / 2 - 150, innerWidth - 308)), bottom: innerHeight - top + 8, ...extra });
  };
  const openPicker = (fallback: Element) => openMenu(fallback);
  return <>
    <div className="edov" data-ed="whitemodel" style={rect} onPointerDown={(e) => e.stopPropagation()}>
      {src ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
    </div>
    <div className="edbar" ref={bar.ref} style={{ left: bar.left, top: Math.min(rect.top + rect.height + 14, stage.height - 54), transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="取消（Esc）" onClick={onClose}><Icon name="x" /></button>
      <span className="vsep" />
      <span className="wm-hint">白膜</span>
      <button className="pill" data-k="whitemodel-model" aria-haspopup="menu" onClick={(e) => openPicker(e.currentTarget)}><Icon name="user" size="s" /><span>{model ? shortName(model) : "模型"}</span><Icon name="right" size="xs" /></button>
      <span className="vsep" />
      <button className="pill" data-k="whitemodel-tier" data-tier={tier} aria-haspopup="menu" aria-label="白膜档位" onClick={(e) => openMenu(e.currentTarget, { tier: true })}><Icon name={tierIcon(tier)} size="s" /><span>{WHITE_TIERS.find((t) => t.id === tier)?.label}</span><Icon name="right" size="xs" /></button>
      <span className="vsep" />
      <button className="pill" data-k="whitemodel-run" style={{ background: "var(--solid)", color: "var(--on-solid)" }} onClick={run}><Icon name="check" size="s" />{tier === "clear" ? "开始清空" : "开始白模"}</button>
    </div>
    {pick ? <>
      <div className="wm-pick-back" onPointerDown={() => setPick(null)} />
      <div className="wm-pick-menu" role={pick.tier ? "menu" : undefined} aria-label={pick.tier ? "白膜档位" : undefined} style={{ left: pick.left, bottom: pick.bottom }} onPointerDown={(e) => e.stopPropagation()}>
        {pick.tier ? WHITE_TIERS.map((t) => (
          <button key={t.id} className={"mi" + (tier === t.id ? " on" : "")} data-tier={t.id} role="menuitemradio" aria-checked={tier === t.id} onClick={() => { pickTier(t.id); setPick(null); }}>
            <Icon name={tierIcon(t.id)} size="s" />
            <span style={{ flex: 1 }}>{t.label}<span className="d">{t.tip}</span></span>
          </button>
        )) : pick.vendor ? <ComboMenu
          autoFocus searchable searchPlaceholder="搜索模型" onEscape={() => setPick(null)}
          empty={<span>这个供应商还没有图片模型</span>}
          header={<button className="mi" data-model-back aria-label="返回供应商列表" onClick={() => setPick({ ...pick, vendor: undefined })}><Icon name="left" size="s" /><span style={{ flex: 1 }}>{pick.vendor}<span className="d">返回供应商列表</span></span></button>}
          itemAttrs={(m) => ({ "data-model": m.id })}
          itemClassName={(m) => "mi combo-item" + (m.id === modelId ? " on" : "")}
          items={all.filter((m) => vendorOf(m) === pick.vendor)}
          label={(m) => m.name}
          onPick={(m) => { setModelId(m.id); setPick(null); }}
          renderItem={(m) => <><VendorLogo name={m.vendor} model={m.name} size={14} /><span style={{ flex: 1 }}><span style={{ display: "flex", gap: 6, alignItems: "center" }}>{m.name}</span><span className="d">{m.vendor}{m.i2i ? " · 最多 " + m.maxRefs + " 张参考图" : " · 仅文生图"}</span></span></>}
        /> : <ComboMenu
          autoFocus searchable searchPlaceholder="搜索供应商" onEscape={() => setPick(null)}
          empty={<span>还没有配置图片模型</span>}
          header={<div className="mh">账号模型 · 选择供应商</div>}
          itemAttrs={(v) => ({ "data-vendor": v })}
          itemClassName={(v) => "mi combo-item" + (v === currentVendor ? " on" : "")}
          items={vendors}
          label={(v) => v}
          onPick={(v) => setPick({ ...pick, vendor: v })}
          renderItem={(v) => <><VendorLogo name={v} size={16} /><span style={{ flex: 1 }}>{v}<span className="d">{all.filter((m) => vendorOf(m) === v).length} 个模型</span></span><Icon name="right" size="s" /></>}
        />}
      </div>
    </> : null}
  </>;
}
function ResizeModal({ ctl, id }: { ctl: Ctl; id: string }) {
  const n = ctl.store.node(id)!; const o = outOf(n)!; const w0 = o.w || 1024, h0 = o.h || 1024;
  const [w, setW] = useState(w0), [h, setH] = useState(h0), [lock, setLock] = useState(true);
  const go = async () => { const W = clamp(w, 16, 4096), H = clamp(h, 16, 4096); closeModal(); const im = await loadImg(await srcData(ctl.store, o.url || "")); const c = cv(W, H); const g = c.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, W, H); await applyVariant(ctl.store, id, { url: c.toDataURL("image/jpeg", .92), w: W, h: H }, `调整像素 ${W}×${H}`); };
  const inp = { width: 110, background: "var(--sunken)", borderRadius: 8, padding: "6px 8px" };
  return <><ModalHead title="调整像素" /><div className="mbd">
    <div className="row"><span>宽</span><input type="number" className="tnum" style={inp} value={w} onChange={(e) => { const v = +e.target.value; setW(v); if (lock) setH(Math.round((v * h0) / w0)); }} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="row"><span>高</span><input type="number" className="tnum" style={inp} value={h} onChange={(e) => { const v = +e.target.value; setH(v); if (lock) setW(Math.round((v * w0) / h0)); }} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="row"><span>锁定比例</span><button className={"sw" + (lock ? " on" : "")} onClick={() => setLock(!lock)} /></div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}><button className="btn solid" onClick={() => void go()}>应用</button></div>
  </div></>;
}

/* ---------- 切分 / 截帧 ---------- */
/** 按「列 × 行」切分：新图按 cols 列 × rows 行排开，标题 `原题 行-列`，每张都连到原图 */
async function split(ctl: Ctl, id: string, cols: number, rows: number) {
  const store = ctl.store; const n = store.node(id); const src = n ? outOf(n)?.url || "" : "";
  if (!n) return;
  if (!src) { store.toast("这张图还没有画面，先上传或生成一张再切分"); return; }
  const c0 = clamp(Math.round(cols) || 1, 1, SPLIT_MAX), r0 = clamp(Math.round(rows) || 1, 1, SPLIT_MAX);
  const im = await loadImg(await srcData(store, src)).catch(() => null);
  if (!im) { store.toast("图片读取失败，没法切分"); return; }
  const W = im.naturalWidth / c0, H = im.naturalHeight / r0; const cw = Math.max(120, Math.round((n.w / c0) * 1.4));
  const ch = (w: number) => Math.round((w * H) / W);
  const made: CanvasNode[] = []; const edges: Array<{ id: string; from: string; to: string }> = [];
  for (let r = 0; r < r0; r++) for (let c = 0; c < c0; c++) {
    const cvs = cv(W, H); cvs.getContext("2d")!.drawImage(im, -c * W, -r * H);
    const title = `${genOf(n).title} ${r + 1}-${c + 1}`;
    const url = await store.backend.importAsset(store.state.canvasId, cvs.toDataURL("image/jpeg", .9), title);
    const t = store.newNode("image", n.x + n.w + 80 + c * (cw + 20), n.y + r * (ch(cw) + 28), { title, w: cw, h: ch(cw), hist: [{ url, w: Math.round(W), h: Math.round(H) }] });
    made.push(t); edges.push({ id: uid("e"), from: n.id, to: t.id });
  }
  store.addNodes(made, edges, { select: true }); ctl.fitTo([n, ...made], 100, 1);
  store.toast(`已切成 ${c0 * r0} 张（${c0} 列 × ${r0} 行），每张都连到原图`);
}
/**
 * 视频截帧：current = 正在播放的那一帧（没在播就退回封面）；
 * first / last = 用临时 video 定位到开头 / 结尾再画（对齐 TapNow 的截帧 1 / 首帧 2 / 尾帧 3）。
 */
export async function grabVideoFrame(store: CanvasStore, n: CanvasNode, at: "current" | "first" | "last"): Promise<string> {
  const o = outOf(n);
  if (!o) return "";
  // 「当前帧」= 节点里正在播放/暂停的那一帧；流式地址（openarc-resource）画到 canvas 会被标记为跨源、导不出，
  // 这时改用数据地址的隐藏 video 跳到同一时间点再取
  let nowAt = -1;
  if (at === "current") {
    const vid = document.querySelector(`.node[data-id="${n.id}"] video`) as HTMLVideoElement | null;
    if (vid && vid.videoWidth) {
      try { const c = cv(vid.videoWidth, vid.videoHeight); c.getContext("2d")!.drawImage(vid, 0, 0); return c.toDataURL("image/jpeg", .92); }
      catch { nowAt = vid.currentTime || 0; }
    }
  }
  const { data } = await seekVideoFrame(store, n, o, (duration, trim) => nowAt >= 0
    ? Math.min(nowAt, Math.max(0, duration - 0.05))
    : at === "first"
      ? (trim ? trim.in : Math.min(0.05, Math.max(0, duration / 2)))
      : (trim ? Math.min(trim.out, duration || trim.out) : Math.max(0, duration - 0.05)));
  return data;
}

/**
 * 按秒取帧：解析视频时区间中点 / 末帧这种 grabVideoFrame 的 first / current / last 覆盖不到的时点用它。
 * 返回帧和源时长：调用方要算中点 / 末帧时不用再加载一遍元数据。
 */
export async function grabVideoFrameAt(store: CanvasStore, n: CanvasNode, seconds: number): Promise<{ data: string; duration: number }> {
  const o = outOf(n);
  if (!o) return { data: "", duration: 0 };
  const target = Number(seconds);
  return seekVideoFrame(store, n, o, (duration) => {
    const top = duration > 0 ? Math.max(0, duration - 0.05) : Math.max(0, Number.isFinite(target) ? target : 0);
    return Math.min(Math.max(0, Number.isFinite(target) ? target : 0), top);
  });
}

/** 临时 video 定位到某一时刻再画：grabVideoFrame / grabVideoFrameAt 共用这一段，seek 只有一份 */
async function seekVideoFrame(
  store: CanvasStore, n: CanvasNode, o: GenOutput,
  timeOf: (duration: number, trim: VideoTrim | null) => number,
): Promise<{ data: string; duration: number }> {
  const src = o.url ? await srcData(store, o.url) : "";
  if (!src) return { data: o.frame ? await srcData(store, o.frame) : "", duration: 0 };
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.src = src;
  const ok = await new Promise<boolean>((resolve) => {
    v.onloadedmetadata = () => resolve(true);
    v.onerror = () => resolve(false);
    setTimeout(() => resolve(!!v.videoWidth), 4000);
  });
  if (!ok || !v.videoWidth) return { data: o.frame ? await srcData(store, o.frame) : "", duration: 0 };
  const duration = Number(v.duration) || 0;
  // 设了「使用区间」就按区间取首/尾帧（截帧跟着区间走）
  const trim = o.trim ? clampTrim(o.dur, o.trim) : null;
  v.currentTime = timeOf(duration, trim);
  await new Promise<void>((resolve) => { v.onseeked = () => resolve(); setTimeout(resolve, 3000); });
  const c = cv(v.videoWidth, v.videoHeight);
  c.getContext("2d")!.drawImage(v, 0, 0);
  return { data: c.toDataURL("image/jpeg", .92), duration };
}

/** 把某一帧做成新的图片节点（默认连到视频节点） */
async function frameNode(store: CanvasStore, n: CanvasNode, at: "current" | "first" | "last", label: string, opts: { link?: boolean } = {}) {
  const data = await grabVideoFrame(store, n, at);
  if (!data) { store.toast("还没有可截取的画面：先等视频生成完成"); return null; }
  const url = data.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, data, genOf(n).title + " · " + label) : data;
  // 图片节点按帧的真实比例摆放（宽度跟视频节点一致），避免 16:9 的帧被裁成方块
  const im = data.startsWith("data:") ? await loadImg(data).catch(() => null) : null;
  const fw = im?.naturalWidth || 0, fh = im?.naturalHeight || 0;
  const size = fw && fh ? { w: n.w, h: Math.round((n.w * fh) / fw), } : {};
  const made = store.newNode("image", n.x + n.w + 60, n.y, { title: genOf(n).title + " · " + label, hist: [{ url, ...(fw && fh ? { w: fw, h: fh } : {}) }], ...size });
  store.addNodes([made], opts.link === false ? [] : [{ id: uid("e"), from: n.id, to: made.id }], { select: true });
  return made;
}

/** 视频裁剪 / 擦除：先截当前帧成图片节点，再在它上面打开对应编辑器（视频逐帧处理要转码，暂不做） */
async function frameThen(ctl: Ctl, n: CanvasNode, editor: "crop" | "erase") {
  const store = ctl.store;
  const made = await frameNode(store, n, "current", editor === "crop" ? "裁剪素材" : "擦除素材");
  if (!made) return;
  if (editor === "crop") openEditor(ctl, "crop", made.id);
  else setEd({ type: "mask", id: made.id, mode: "erase" });
  store.toast(editor === "crop" ? "已截当前帧，在它上面裁剪" : "已截当前帧，在它上面擦除");
}

async function captureFrame(store: CanvasStore, n: CanvasNode, at: "current" | "first" | "last" = "current") {
  const label = at === "first" ? "首帧" : at === "last" ? "尾帧" : "当前帧";
  const made = await frameNode(store, n, at, label);
  if (made) store.toast(`已截取${label}，作为新的图片节点`);
}

/** 设为视频封面：把首帧写进当前结果的 frame（节点卡片 / 分享预览都用它） */
async function setVideoCover(store: CanvasStore, n: CanvasNode) {
  const data = await grabVideoFrame(store, n, "first");
  if (!data) { store.toast("还没有可截取的画面：先等视频生成完成"); return; }
  const url = data.startsWith("data:") ? await store.backend.importAsset(store.state.canvasId, data, genOf(n).title + " · 封面") : data;
  store.patchGen(n.id, (g) => ({ hist: g.hist.map((h, i) => (i === g.hi ? { ...h, frame: url } : h)) }), { history: true });
  store.toast("已设为视频封面");
}

/** 应用到画布：把视频画面作为一张独立图片节点放到画布上（不连线） */
async function applyVideoToCanvas(store: CanvasStore, n: CanvasNode) {
  const made = await frameNode(store, n, "first", "应用到画布", { link: false });
  if (made) store.toast("已把视频画面放到画布上");
}
