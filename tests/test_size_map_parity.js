#!/usr/bin/env node
// 两处「官方 size×resolution 映射表」逐格一致性校验（防止再次分叉；在线生图页已下线删除，web sizeData 那一路随之移除）：
//   1) static/js/smart-canvas.js 的 const SIZE_MAP（前端真值源）；
//   2) main.py 的 _AGENT_SMART_SIZE_MAP（画布助手建图片节点用的尺寸表）。
//
// 官方口径（https://docs.apimart.ai gpt-image-2 generation）：size 15 比例 × resolution 1k/2k/4k。
// 真值锚点直接读 main.py 的 APIMART_OFFICIAL_PIXELS（1k 有两组等价像素时取第一组），
// 不另抄一份常量；前端整表另有 tests/test_size_map_official.js 对着后端 apimart_size_resolution 校验。
//
// 差分证明（把 main.py 表指到改前备份，应报出不一致格数并非零退出）：
//   NOVAI_PARITY_MAIN_SRC=/tmp/novai-lastcopy-evidence/backup/main.py \
//     node tests/test_size_map_parity.js
// 运行：node tests/test_size_map_parity.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SMART_SRC = process.env.NOVAI_PARITY_SMART_SRC || path.join(ROOT, 'static/js/smart-canvas.js');
const MAIN_SRC = process.env.NOVAI_PARITY_MAIN_SRC || path.join(ROOT, 'main.py');
const LEVELS = ['1k', '2k', '4k'];
const PRINT_ALL = process.env.NOVAI_PARITY_ALL === '1';  // 打印完整 39 格 parity 表（出证据用）

// 画布预置比例 key → 官方比例（与 static API_RATIO_LABELS / test_size_map_official.js 同源）
const KEY_TO_RATIO = {
    square: '1:1', portrait: '2:3', portrait43: '3:4', landscape43: '4:3', landscape: '3:2',
    story: '9:16', wide: '16:9', ultrawide: '21:9', ultratall: '9:21',
    portrait12: '1:2', landscape21: '2:1', landscape54: '5:4', portrait45: '4:5',
};
// 官方 15 比例里的 3:1 / 1:3：APIMART_OFFICIAL_PIXELS 的 1k 第一组（1881x836 / 887x1774）非 16 对齐，
// 四张预置表统一取官方另一组精确且 /16 的像素（见 ALIGNED_PIXELS）。
const ALIGNED_KEYS = { landscape31: '3:1', portrait13: '1:3' };
const ALL_KEYS = Object.assign({}, KEY_TO_RATIO, ALIGNED_KEYS);
const ALIGNED_PIXELS = {
  landscape31: { '1k': '1536x512', '2k': '3072x1024', '4k': '3840x1280' },
  portrait13: { '1k': '512x1536', '2k': '1024x3072', '4k': '1280x3840' }
};

let pass = 0;
const fails = [];
const ok = (cond, msg) => { cond ? pass++ : fails.push(msg); };

// ── 真值锚点：main.py APIMART_OFFICIAL_PIXELS（比例 → 档位 → 第一组像素）────────────
function parseOfficialPixels(src){
  const block = (src.match(/APIMART_OFFICIAL_PIXELS = \{[\s\S]*?\n\}/) || [])[0];
  if(!block) throw new Error('缺少 APIMART_OFFICIAL_PIXELS：' + MAIN_SRC);
  const table = {};
  const entryRe = /"([^"]+)"\s*:\s*\{([^}]*)\}/g;
  let m;
  while((m = entryRe.exec(block))){
    const tiers = {};
    const cellRe = /"(1k|2k|4k)"\s*:\s*\(\((\d+),\s*(\d+)\)/g;
    let c;
    while((c = cellRe.exec(m[2]))) tiers[c[1]] = c[2] + 'x' + c[3];
    table[m[1]] = tiers;
  }
  return table;
}

// ── 前端 SIZE_MAP ────────────────────────────────────────────────────────────
function extractSizeMap(src){
  const block = (src.match(/const SIZE_MAP = \{[\s\S]*?\n\};/) || [])[0];
  if(!block) throw new Error('缺少 SIZE_MAP：' + SMART_SRC);
  const map = {};
  const keyRe = /(\w+)\s*:\s*\{([^}]*)\}/g;
  let m;
  while((m = keyRe.exec(block))){
    const entry = {};
    const pairRe = /'([^']+)'\s*:\s*'([^']+)'/g;
    let p;
    while((p = pairRe.exec(m[2]))) entry[p[1]] = p[2];
    map[m[1]] = entry;
  }
  return map;
}

// ── main.py _AGENT_SMART_SIZE_MAP ────────────────────────────────────────────
function extractAgentMap(src){
  const block = (src.match(/_AGENT_SMART_SIZE_MAP = \{[\s\S]*?\n\}/) || [])[0];
  if(!block) throw new Error('缺少 _AGENT_SMART_SIZE_MAP：' + MAIN_SRC);
  const map = {};
  const keyRe = /"(\w+)"\s*:\s*\{([^}]*)\}/g;
  let m;
  while((m = keyRe.exec(block))){
    const entry = {};
    const pairRe = /"(1k|2k|4k)"\s*:\s*"([^"]+)"/g;
    let p;
    while((p = pairRe.exec(m[2]))) entry[p[1]] = p[2];
    map[m[1]] = entry;
  }
  return map;
}

function coverage(label, map, expected = KEY_TO_RATIO){
  const keys = Object.keys(map);
  ok(keys.length === Object.keys(expected).length,
    label + ' 覆盖 ' + Object.keys(expected).length + ' 个比例（实际 ' + keys.length + '：' + keys.join(',') + '）');
  Object.keys(expected).forEach(key => {
    ok(!!map[key], label + ' 缺比例 ' + key);
    if(map[key]) LEVELS.forEach(level => ok(!!map[key][level], label + ' 缺 ' + key + '@' + level));
  });
}

async function main(){
  const mainSrc = fs.readFileSync(MAIN_SRC, 'utf8');
  const official = parseOfficialPixels(mainSrc);
  const smartMap = extractSizeMap(fs.readFileSync(SMART_SRC, 'utf8'));
  const agentMap = extractAgentMap(mainSrc);

  console.log('[size-map-parity] 前端 SIZE_MAP = ' + (process.env.NOVAI_PARITY_SMART_SRC || 'static/js/smart-canvas.js'));
  console.log('[size-map-parity] main.py 表    = ' + (process.env.NOVAI_PARITY_MAIN_SRC || 'main.py'));

  coverage('前端 SIZE_MAP', smartMap, ALL_KEYS);
  coverage('main.py _AGENT_SMART_SIZE_MAP', agentMap, ALL_KEYS);

  console.log('');
  console.log('[size-map-parity] key        ratio  档位  smart SIZE_MAP | main.py 助手表 | 官方');
  let mismatches = 0;
  Object.keys(ALL_KEYS).forEach(key => {
    const ratio = ALL_KEYS[key];
    LEVELS.forEach(level => {
      const expected = (ALIGNED_PIXELS[key] && ALIGNED_PIXELS[key][level])
        || ((official[ratio] || {})[level]) || '(官方缺)';
      const cells = [smartMap[key] && smartMap[key][level], agentMap[key] && agentMap[key][level]];
      const diff = cells.filter(value => value !== expected).length;
      mismatches += diff;
      if(diff || PRINT_ALL){
        console.log('[size-map-parity] ' + key.padEnd(12) + ratio.padEnd(7) + level.padEnd(4)
          + cells.map(value => value || '(缺)').join(' | ') + ' | ' + expected + '  ← 差异 ' + diff);
      }
      ok(cells[0] === expected, key + '@' + level + ' 前端 SIZE_MAP = ' + expected + '（实际 ' + cells[0] + '）');
      ok(cells[1] === expected, key + '@' + level + ' main.py _AGENT_SMART_SIZE_MAP = ' + expected + '（实际 ' + cells[1] + '）');
    });
  });
  ok(mismatches === 0, '两处逐格与官方表差异为 0（实际 ' + mismatches + ' 格）');

  console.log('');
  console.log('[size-map-parity] 与前端 SIZE_MAP 的两两差异（45 格）：');
  [['main.py _AGENT_SMART_SIZE_MAP', agentMap]].forEach(pair => {
    let diff = 0;
    Object.keys(ALL_KEYS).forEach(key => LEVELS.forEach(level => {
      const left = smartMap[key] && smartMap[key][level];
      const right = pair[1][key] && pair[1][key][level];
      if(left !== right) diff++;
    }));
    console.log('[size-map-parity]   ' + pair[0] + ' vs 前端 SIZE_MAP：不一致 ' + diff + ' / 45 格');
    ok(diff === 0, pair[0] + ' 与前端 SIZE_MAP 逐格一致（实际 ' + diff + ' 格不一致）');
  });
  console.log('');
  console.log('[size-map-parity] 矩阵 ' + (Object.keys(ALL_KEYS).length * LEVELS.length) + ' 格，差异 ' + mismatches + ' 格，' + pass + ' 项通过');
  if(fails.length){
    fails.slice(0, 80).forEach(msg => console.error('  ✗ ' + msg));
    if(fails.length > 80) console.error('  … 其余 ' + (fails.length - 80) + ' 项');
    console.error('失败 ' + fails.length + ' 项（不一致 ' + mismatches + ' 格）');
    process.exit(1);
  }
  console.log('全部通过（差异 0 格）');
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
