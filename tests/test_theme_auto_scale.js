#!/usr/bin/env node
/* 自动界面缩放回归（纯静态，不用浏览器）：
   1. auto 固定 100%：theme.js 不再按 1500x940 设计基准 / 屏幕长边猜比例；
   2. 没有 contentFit 二次降档（旧逻辑会在 2K/4K 放大后 80ms 又压回，启动肉眼可见跳变）；
   3. 手动档位保留（60%~140%），默认 auto；
   4. 设置面板文案说明「自动=100%，想更大手动选 115%/125%」。
   跑法：node tests/test_theme_auto_scale.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const theme = read('static/js/theme.js');
const panel = read('web/src/shell/settings/AppearancePanel.vue');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] auto 固定 100%');
const autoBody = theme.slice(theme.indexOf('function autoScale()'), theme.indexOf('function scaleForMode'));
ok(/return 1;/.test(autoBody), 'autoScale 直接返回 1');
ok(!/1500|940/.test(theme), '没有 1500x940 设计基准常量');
ok(!/screenLong|viewportLong|longEdge/.test(theme), '不再按屏幕长边猜放大档');
ok(!/compactRatio/.test(theme), '不再按窗口尺寸猜缩小档');

console.log('[2] 没有 contentFit 二次降档');
ok(!/scheduleContentFit|contentFitTimer/.test(theme), 'contentFit 降档逻辑已移除');
ok(!/studioFitScale/.test(theme), '没有 data-studio-fit-scale 分支');
ok(!/fitted < current/.test(theme), '没有加载后把 scale 改小的路径');

console.log('[3] 手动档位与默认值');
ok(/const SCALE_OPTIONS = \['auto', '60', '65', '70', '75', '80', '85', '90', '95', '100', '115', '125', '140'\];/.test(theme), '手动档位保留到 140%');
ok(/normalizeScaleMode\(localStorage\.getItem\(SCALE_KEY\) \|\| 'auto'\)/.test(theme), '默认模式仍是 auto');
ok(/if\(next === 'auto'\) return autoScale\(\);/.test(theme), 'auto 走 autoScale（=1）');
ok(/style\.setProperty\('--studio-ui-scale', value\.toFixed\(3\)\)/.test(theme), '--studio-ui-scale 与 getScale 用同一份 value');
ok(/getScale: \(\) => scaleForMode\(currentScaleMode\(\)\)/.test(theme), 'StudioScale.getScale 与写入一致');

console.log('[4] 设置面板文案');
ok(/v === 'auto' \? '自动（100%）'/.test(panel), '自动档文案标注 100%');
ok(/自动 = 100%/.test(panel) && /115% \/ 125%/.test(panel), '说明写清自动=100%、可手动选 115%/125%');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
