/**
 * 生成图纯白背景后处理（全局白平衡 + 轻柔收边）：
 * 1) 四边各 3% 取中位背景色；太暗 / 有色相直接跳过；
 * 2) 每通道增益 255/bg，限制 1.0–1.15，整图乘增益（背景到白，主体只整体提亮）；
 * 3) 1/2 分辨率上，从四边泛洪「离白 ≤10 且梯度平缓」的残留淡灰，再放大应用（不碰 T 恤内部）；
 * 4) 已经很亮的像素（亮度≥252 且彩差≤3）跳过；
 * 5) 任何失败都返回原图。
 */
const SAMPLE = 0.03;
const MIN_LUM = 195;
const MAX_CHROMA = 20;
const GAIN_MIN = 1;
const GAIN_MAX = 1.15;
const TOL = 10;
const GRAD_GATE = 22;

function median(values: number[]): number {
  if (!values.length) return 255;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = src;
  await img.decode();
  return img;
}

export async function whitenBackground(src: string): Promise<string> {
  if (!src) return src;
  try {
    const img = await loadImage(src);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h || w * h > 50_000_000) return src;
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));

    const half = document.createElement("canvas"); half.width = hw; half.height = hh;
    const hctx = half.getContext("2d", { willReadFrequently: true });
    if (!hctx) return src;
    hctx.drawImage(img, 0, 0, hw, hh);
    const hd = hctx.getImageData(0, 0, hw, hh); const d = hd.data;

    const bx = Math.max(1, Math.round(hw * SAMPLE)), by = Math.max(1, Math.round(hh * SAMPLE));
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const push = (x: number, y: number) => { const p = (y * hw + x) * 4; rs.push(d[p]); gs.push(d[p + 1]); bs.push(d[p + 2]); };
    for (let y = 0; y < by; y++) for (let x = 0; x < hw; x++) { push(x, y); push(x, hh - 1 - y); }
    for (let x = 0; x < bx; x++) for (let y = by; y < hh - by; y++) { push(x, y); push(hw - 1 - x, y); }
    const R = median(rs), G = median(gs), B = median(bs);
    const lum = 0.299 * R + 0.587 * G + 0.114 * B;
    const chroma = Math.max(R, G, B) - Math.min(R, G, B);
    if (lum < MIN_LUM || chroma > MAX_CHROMA) return src;

    const gains = [255 / Math.max(1, R), 255 / Math.max(1, G), 255 / Math.max(1, B)].map((g) => Math.max(GAIN_MIN, Math.min(GAIN_MAX, g)));
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    const octx = out.getContext("2d", { willReadFrequently: true }); if (!octx) return src;
    octx.drawImage(img, 0, 0);
    const od = octx.getImageData(0, 0, w, h);
    const odata = od.data;
    for (let p = 0; p < odata.length; p += 4) {
      const r = odata[p], g = odata[p + 1], b = odata[p + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const c = Math.max(r, g, b) - Math.min(r, g, b);
      if (l >= 252 && c <= 3) continue;
      odata[p] = Math.min(255, Math.round(r * gains[0]));
      odata[p + 1] = Math.min(255, Math.round(g * gains[1]));
      odata[p + 2] = Math.min(255, Math.round(b * gains[2]));
    }
    octx.putImageData(od, 0, 0);

    const h2 = document.createElement("canvas"); h2.width = hw; h2.height = hh;
    const h2ctx = h2.getContext("2d", { willReadFrequently: true }); if (!h2ctx) return src;
    h2ctx.drawImage(out, 0, 0, hw, hh);
    const d2 = h2ctx.getImageData(0, 0, hw, hh).data;
    const luma = new Float32Array(hw * hh);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) luma[i] = 0.299 * d2[p] + 0.587 * d2[p + 1] + 0.114 * d2[p + 2];
    const grad = new Float32Array(hw * hh);
    const at = (x: number, y: number) => luma[Math.max(0, Math.min(hh - 1, y)) * hw + Math.max(0, Math.min(hw - 1, x))];
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        grad[y * hw + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    const nearWhite = (i: number) => { const p = i * 4; return Math.abs(d2[p] - 255) <= TOL && Math.abs(d2[p + 1] - 255) <= TOL && Math.abs(d2[p + 2] - 255) <= TOL; };
    const mask = new Uint8Array(hw * hh);
    const stack: number[] = [];
    const seed = (i: number) => { if (!mask[i] && nearWhite(i) && grad[i] <= GRAD_GATE) { mask[i] = 1; stack.push(i); } };
    for (let x = 0; x < hw; x++) { seed(x); seed((hh - 1) * hw + x); }
    for (let y = 0; y < hh; y++) { seed(y * hw); seed(y * hw + hw - 1); }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % hw, y = (i - x) / hw;
      if (grad[i] > GRAD_GATE) continue;
      if (x > 0) seed(i - 1);
      if (x < hw - 1) seed(i + 1);
      if (y > 0) seed(i - hw);
      if (y < hh - 1) seed(i + hw);
    }

    let changed = 0;
    for (let y = 0; y < h; y++) {
      const my = Math.min(hh - 1, Math.floor((y * hh) / h));
      for (let x = 0; x < w; x++) {
        const mx = Math.min(hw - 1, Math.floor((x * hw) / w));
        if (!mask[my * hw + mx]) continue;
        const p = (y * w + x) * 4;
        odata[p] = 255; odata[p + 1] = 255; odata[p + 2] = 255; changed++;
      }
    }
    // 极窄边缘带补白：角落暗角/渐变常比中位背景更低，容差 10 收不到；只处理最外 1%（且亮度≥220），
    // 让四角确定是 255，不会碰到主体
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.01));
    for (let y = 0; y < h; y++) {
      const edgeY = y < band || y >= h - band;
      for (let x = 0; x < w; x++) {
        if (!edgeY && x >= band && x < w - band) continue;
        const p = (y * w + x) * 4;
        if (odata[p] >= 220 && odata[p + 1] >= 220 && odata[p + 2] >= 220) {
          odata[p] = 255; odata[p + 1] = 255; odata[p + 2] = 255; changed++;
        }
      }
    }
    if (!changed) return src;
    octx.putImageData(od, 0, 0);
    return out.toDataURL("image/jpeg", 0.95);
  } catch {
    return src;
  }
}
