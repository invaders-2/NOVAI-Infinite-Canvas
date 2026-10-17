/* 扩图提示词不再承诺精确输出尺寸（Lovart free 模式尺寸不可控，只保证比例）。
   跑法：node tests/test_lovart_outpaint_honest_size.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/js/smart-canvas.js'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const countOf = needle => source.split(needle).length - 1;

ok(countOf('向外扩图：') === 2, '两处扩图入口都还在');
ok(countOf('不要改变原有背景。输出尺寸 ') === 0, '不再把「输出尺寸 W×H」当精确承诺');
ok(countOf('若平台只能按自身档位出图，请保持该比例') === 2,
   '两处扩图入口都改成「按 W×H 输出；平台不能精确出图则保持比例」');

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(item => console.error('  ✗ ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
