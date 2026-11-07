#!/usr/bin/env node
// 「专业调色 → 对比 → 放大」图片重叠的静态回归检查。
//
// 现象：点「对比原图」后放大图片，对比区出现两张大小不一致的同一张图（重叠）。
// 成因：对比用的原图层 .iaj-orig 靠 inset:0 + 100%/100% 跟随 #cropCanvas，但 .crop-canvas img 上的
//   max-width/max-height（1300x840 上限）会把这层单独卡小；缩放超过该上限后原图层不再铺满，
//   底下同一张 #cropImage 透出来，左右两半各显示一张、大小不同。
// 本检查锁住修复：原图层显式 max-width/max-height:none，且不改动基准 fit 上限、不改缩放/对比实现。
// 运行：node tests/test_image_adjust_compare_overlay.js
'use strict';
const fs = require('fs');
const path = require('path');
let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const compact = s => String(s || '').split(' ').join('').split('\n').join('').split('\t').join('').split('\r').join('');
function ruleBody(css, selector) {
    let from = 0;
    while (true) {
        const i = css.indexOf(selector, from);
        if (i < 0) return null;
        let k = i + selector.length;
        while (k < css.length && ' \t\r\n'.includes(css[k])) k++;
        if (css[k] === '{') {
            const j = css.indexOf('}', k);
            if (j < 0) return null;
            return compact(css.slice(k + 1, j));
        }
        from = i + 1;
    }
}

console.log('[1] 对比原图层跟随 holder，且不被 .crop-canvas img 的尺寸上限卡住');
const adjust = read('static/css/image-adjust.css');
const orig = ruleBody(adjust, '.crop-canvas .iaj-orig');
ok(Boolean(orig), '找到 .crop-canvas .iaj-orig 规则');
if (orig) {
    ok(orig.includes('position:absolute'), '原图层是绝对定位（叠在图片上做对比）');
    ok(orig.includes('inset:0'), '原图层 inset:0 贴住 holder');
    ok(orig.includes('width:100%') && orig.includes('height:100%'), '原图层宽高 100% 跟随 holder');
    ok(orig.includes('max-width:none'), 'max-width:none（否则被 .crop-canvas img 的 1300px 上限卡小）');
    ok(orig.includes('max-height:none'), 'max-height:none（否则被 840px 上限卡小）');
    ok(orig.includes('object-fit:contain'), '原图层保持 contain，不拉伸变形');
}

console.log('[2] 两个编辑器给 #cropImage 的基准 fit 上限保持不变（修复只针对对比原图层）');
['static/css/smart-canvas.css', 'static/css/canvas.css'].forEach(p => {
    const base = ruleBody(read(p), '.crop-canvas img');
    ok(Boolean(base), p + ' 仍保留 .crop-canvas img 基准规则');
    if (base) {
        ok(base.includes('max-width:min('), p + ' 基准 max-width 仍是原有的 fit 上限');
        ok(base.includes('max-height:min('), p + ' 基准 max-height 仍是原有的 fit 上限');
    }
});

console.log('[3] 缩放只改 #cropImage；对比沿用同一层原图，靠切结果画布可见性');
const zoomLine = 'img.style.width=Math.round(imageEditBaseW*imageEditZoom)+\'px\'';
['static/js/smart-canvas.js', 'static/js/canvas.js'].forEach(p => {
    ok(compact(read(p)).includes(zoomLine), p + ' 的缩放仍只改 #cropImage 像素宽（applyImageEditZoom 行为未变）');
});
const editor = read('static/js/image-adjust-editor.js');
ok(editor.includes("orig.id = 'iajOrigImg'"), '原图层仍是同一层 #iajOrigImg（未新增图层）');
ok(editor.includes("S.cv.style.visibility = S.cmpOrig ? 'hidden' : ''"), '对比改成切结果画布可见性（原图层不动，仍按 holder 铺满）');
ok(!/clipPath|splitX|iaj-vbar|iaj-sideview|adjustCompareDivider|setHold/.test(editor), '旧的拖动对比 / 并排 / 按住看原图已删干净');

console.log('[4] 图片右下角「对比原图」按钮：点击切换、不误触取色、剪切三角默认不显示');
const cmpRule = ruleBody(adjust, '.crop-canvas .iaj-cmp');
ok(Boolean(cmpRule), '有 .crop-canvas .iaj-cmp 按钮规则');
if (cmpRule) {
    ok(cmpRule.includes('position:absolute') && cmpRule.includes('right:10px') && cmpRule.includes('bottom:10px'), '按钮绝对定位贴在图片右下角 10px');
    ok(Number((cmpRule.match(/z-index:(\d+)/) || [0, 0])[1]) > 3, 'z-index 盖过结果画布（.image-edit-canvas-adjust z-index:3）');
    ok(cmpRule.includes('border:0'), '不画边框（层级靠底和投影）');
    ok(cmpRule.includes('box-shadow:'), '近实底 + 柔和投影');
    ok(cmpRule.includes('border-radius:99px'), '胶囊圆角');
}
ok(/\.crop-canvas \.iaj-cmp\.on\{[^}]*background:var\(--cmp-on-bg\)/.test(adjust), '选中态用反色实底');
ok(adjust.includes('.crop-canvas.iaj-picking .iaj-cmp{cursor:pointer !important}'), '取色（crosshair）时按钮光标保持 pointer');
ok(editor.includes("if (e.target.closest && e.target.closest('.iaj-cmp')) return;"), '取色 pointerdown 忽略按钮（holder 上是捕获阶段，必须这样兜）');
ok(editor.includes("['pointerdown', 'pointerup', 'mousedown', 'click'].forEach(t => btn.addEventListener(t, e => e.stopPropagation()))"), '按钮自己 stopPropagation（含 mousedown：两个宿主的平移都别从按钮上起来）');
ok(editor.includes('function toggleCompare()') && editor.includes('if (!e.repeat) toggleCompare();'), '点按钮 / 按 \\ 键都是同一个切换函数（长按不连跳）');
const clipRule = ruleBody(adjust, '.iaj-clip');
ok(Boolean(clipRule) && clipRule.includes('opacity:0'), '剪切三角默认 opacity:0（没剪切时完全不出现）');
ok(/\.iaj-clip\.on\{opacity:1\}/.test(adjust), '只有 .on 才 opacity:1');
ok(editor.includes("$('.iaj-clip.lo', S.panel).classList.toggle('on', h.clipLo)"), '暗部三角由分析结果的 clipLo 驱动');
ok(editor.includes("$('.iaj-clip.hi', S.panel).classList.toggle('on', h.clipHi)"), '高光三角由分析结果的 clipHi 驱动');
ok(editor.includes('继续编辑上次的调色 · 基于原图'), '「继续编辑上次的调色 · 基于原图」提示没丢（挪到面板内）');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if (fails.length) { console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
