#!/usr/bin/env node
// 「专业调色 → 对比 → 放大」图片重叠的静态回归检查。
//
// 现象：点「拖动对比」后放大图片，对比区出现两张大小不一致的同一张图（重叠）。
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

console.log('[3] 缩放/对比实现不变：缩放只改 #cropImage，对比按 holder 百分比定位');
const zoomLine = 'img.style.width=Math.round(imageEditBaseW*imageEditZoom)+\'px\'';
['static/js/smart-canvas.js', 'static/js/canvas.js'].forEach(p => {
    ok(compact(read(p)).includes(zoomLine), p + ' 的缩放仍只改 #cropImage 像素宽（applyImageEditZoom 行为未变）');
});
const editor = read('static/js/image-adjust-editor.js');
ok(editor.includes("S.cv.style.clipPath = S.compare === 'split'"), '拖动对比仍用 clipPath 切分调整后画布');
ok(editor.includes("div.style.left = S.splitX + '%'"), '分割线仍按 holder 百分比定位');
ok(editor.includes("orig.id = 'iajOrigImg'"), '原图层仍是同一层 #iajOrigImg（未新增图层）');

console.log('通过 ' + pass + '/' + (pass + fails.length));
if (fails.length) { console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
