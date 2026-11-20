#!/usr/bin/env node
'use strict';
/**
 * 白膜结构自检的纯数学部分（whitemodelScore.mjs）：只跑合成图，不依赖 DOM / 模型额度。
 *
 * 这层的任务不是「证明结果是完美的」，而是别把正常结果误判成跑偏：
 *   人台 / 产品两档都会把背景换成无缝纯白 —— 结果里被抹白的背景必须从比对里剔除，
 *   否则原图背景的纹理一直压在分母上，背景越花主体分越低（真图实测：同一主体、忙背景原图只有 0.45）。
 */
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const W = 96, H = 96;

/** 合成一张「主体 + 背景」的灰度图：主体是中间一块带内部起伏的方块，背景按传入方式画 */
function scene({ bg, jitter = 0 }) {
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inSubject = x > 28 && x < 68 && y > 18 && y < 82;
      let v = bg(x, y);
      if (inSubject) {
        // 中间亮、两边暗，外加一点横向纹理 → 有明确的轮廓和内部结构
        v = 150 + 55 * Math.sin((x - 28) / 40 * Math.PI) - 18 * Math.cos((y - 18) / 64 * Math.PI * 2);
      }
      if (jitter) v += ((x * 7 + y * 13) % 5 - 2) * jitter;
      lum[y * W + x] = v;
    }
  }
  return lum;
}

const texturedBg = (x, y) => 90 + 60 * Math.sin(x / 6) + 40 * Math.cos(y / 9);
const flatWhite = () => 255;

const lumOriginal = scene({ bg: texturedBg });
const lumMannequin = scene({ bg: flatWhite });
const lumShifted = (() => {
  const src = lumMannequin;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = src[y * W + ((x + 12) % W)];
  return out;
})();
const lumAllWhite = new Float32Array(W * H).fill(255);

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'novai-canvas-ui', 'src', 'canvas', 'canvas-next', 'whitemodelScore.js')).href);
  const { maskedStructureScore } = mod;

  const rows = [
    ['背景抹白、主体不动', lumOriginal, lumMannequin],
    ['主体平移 12px（12% 画幅）', lumOriginal, lumShifted],
    ['结果整幅纯白', lumOriginal, lumAllWhite],
    ['结果 = 原图', lumOriginal, lumOriginal],
  ];
  const got = {};
  console.log('用例'.padEnd(28) + 'score'.padStart(8) + 'kept'.padStart(8));
  for (const [label, a, b] of rows) {
    const r = maskedStructureScore(a, b, W, H);
    got[label] = r;
    console.log(label.padEnd(28) + r.score.toFixed(3).padStart(8) + r.keptRatio.toFixed(2).padStart(8));
  }

  // 背景被抹成纯白 → 只比主体，应该高分
  assert(got['背景抹白、主体不动'].score > 0.65, '主体没动时不该判成跑偏（实际 ' + got['背景抹白、主体不动'].score.toFixed(3) + '）');
  // 主体整体挪走 → 明显掉下来
  assert(got['主体平移 12px（12% 画幅）'].score < got['背景抹白、主体不动'].score - 0.15, '主体挪走必须比「没动」低一截');
  // 整幅纯白 → keptRatio 触发回退，交给上层空白检查
  assert(got['结果整幅纯白'].keptRatio < 0.05, '整幅纯白时几乎没有可比对区域');
  assert(got['结果整幅纯白'].score < 0.2, '整幅纯白不应该拿到高分');
  // 同一张图 → 接近 1（3×3 膨胀会吃掉一点，真图实测 0.85 上下）
  assert(got['结果 = 原图'].score > 0.75, '同一张图应接近满分（实际 ' + got['结果 = 原图'].score.toFixed(3) + '）');

  console.log('\n结构自检数学用例全部通过');
})().catch((err) => { console.error(err.message || err); process.exit(1); });
