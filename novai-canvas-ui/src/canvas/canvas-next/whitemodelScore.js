/**
 * 白膜自检的结构比对：96px 灰度 → Sobel 梯度图 → 余弦相似度。
 * 人台 / 产品两档都会把背景换成无缝纯白：原图背景的纹理在结果里本来就不该出现，
 * 若仍计入分母，背景越花主体的分数被压得越低（真图实测：同一主体、忙背景原图对纯背景结果只有 0.45，
 * 会被误判成「主体对不上」）。所以先把结果里「近白且平坦」的像素整体剔除，只比两边都还在的地方。
 * 结果只用来提示，不再拦下结果（见 registry.tsx 的 whitemodel 分支）。
 */

/** 越界取最近的边（与 canvas 的绘制取样一致，避免边上出现假边缘） */
function at(v, x, y, w, h) {
  const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
  return v[yy * w + xx];
}

export function sobel(lum, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(lum, x - 1, y - 1, w, h), tc = at(lum, x, y - 1, w, h), tr = at(lum, x + 1, y - 1, w, h);
      const ml = at(lum, x - 1, y, w, h), mr = at(lum, x + 1, y, w, h);
      const bl = at(lum, x - 1, y + 1, w, h), bc = at(lum, x, y + 1, w, h), br = at(lum, x + 1, y + 1, w, h);
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      out[y * w + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** 3×3 取最大：容忍 96px 网格上 1px 的对位误差，小块平移不至于直接判成 0 */
export function dilateMax(map, w, h, r = 1) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const v = at(map, x + dx, y + dy, w, h);
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** 3×3 亮度标准差：区分「整块纯白」和「白色但还有形体的地方」 */
function localStd(lum, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = at(lum, x + dx, y + dy, w, h);
          s += v; s2 += v * v;
        }
      }
      const m = s / 9; const varr = s2 / 9 - m * m;
      out[y * w + x] = Math.sqrt(varr > 0 ? varr : 0);
    }
  }
  return out;
}

function cosineWith(a, b, keep, mask) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask && !keep[i]) continue;
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * @returns {{ score: number, keptRatio: number }}
 *   keptRatio = 参与比对（未被当成纯白背景剔除）的像素占比。
 *   结果几乎整张纯白（keptRatio < 0.05）时不加掩码、不膨胀地退回整幅余弦：交给上层的空白检查处理。
 */
export function maskedStructureScore(lumA, lumB, w, h) {
  const ga = sobel(lumA, w, h), gb = sobel(lumB, w, h);
  const std = localStd(lumB, w, h);
  const keep = new Uint8Array(w * h);
  let kept = 0;
  for (let i = 0; i < keep.length; i++) {
    const background = lumB[i] >= 247 && std[i] < 2;
    keep[i] = background ? 0 : 1;
    if (!background) kept++;
  }
  const keptRatio = keep.length ? kept / keep.length : 0;
  if (keptRatio < 0.05) return { score: cosineWith(ga, gb, keep, false), keptRatio };
  return { score: cosineWith(ga, dilateMax(gb, w, h, 1), keep, true), keptRatio };
}
