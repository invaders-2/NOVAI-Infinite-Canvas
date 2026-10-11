#!/usr/bin/env node
/* 多维表格单元格「编辑态文字重叠」的源码级回归断言。
   背景：td 里始终放着只读层 .table-cell-view，进入编辑态再往同一个 td append 一个
   绝对定位的 textarea.table-cell-editor；编辑器底色曾是半透明的 --soft
   （marvis-shared.css 里 --soft → --nav-hover-bg = rgba(...,.04/.06)，且该文件在
   smart-canvas.css 之后加载，所以 --soft 取的是半透明那份）→ 只读文字和编辑器文字
   被同时画出来、横向错开 8px，就是用户看到的「文字重叠」。
   这里钉死三件事：编辑器底改成不透明 --surface；编辑态用 visibility 隐藏只读层；
   编辑相关的交互绑定一行没动。跑法：node tests/test_table_edit_overlay.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const css = read('static/css/table-node.css');
const shared = read('static/css/marvis-shared.css');
const html = read('static/smart-canvas.html');
const js = read('static/js/shared/table-node.js');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const show = v => { try { return JSON.stringify(v); } catch(e){ return String(v); } };
const eq = (a, b, m) => ok(show(a) === show(b), m + ' 期望' + show(b) + ' 实际' + show(a));
// 取某个选择器规则体的第一个匹配（选择器里已经转义好了）
const rule = (src, selectorEscaped) =>
    (src.match(new RegExp(selectorEscaped + '\\s*\\{([\\s\\S]*?)\\}')) || [])[1] || '';

console.log('[1] 编辑器底色：不透明面板 token（不再是半透明 --soft）');
const editorBlock = rule(css, '\\.table-cell-editor');
ok(editorBlock.length > 100, '找得到 .table-cell-editor 规则体');
ok(/background:\s*var\(--surface\)\s*;/.test(editorBlock), '编辑器 background = var(--surface)（不透明底）');
ok(!/background:\s*var\(--soft\)/.test(editorBlock), '编辑器不再用半透明的 var(--soft)');
ok(/position:\s*absolute/.test(editorBlock) && /inset:\s*0/.test(editorBlock), '编辑器仍是绝对定位铺满 td（未改结构）');

console.log('[2] 编辑态隐藏只读层：visibility，不是 display');
const editViewBlock = rule(css, '\\.table-cell\\.is-editing\\s+\\.table-cell-view');
ok(/visibility:\s*hidden/.test(editViewBlock), '.table-cell.is-editing .table-cell-view 用 visibility: hidden');
ok(!/display:\s*none/.test(editViewBlock), '不用 display: none（避免单元格高度塌陷、表格跳动）');
const isEditingBlock = rule(css, '\\.table-cell\\.is-editing');
ok(/padding:\s*0/.test(isEditingBlock), '编辑态 td padding 仍为 0（原有布局规则不动）');

console.log('[3] token 链与加载顺序（根因证据）');
const surfaceValues = shared.match(/--surface:\s*[^;]+;/g) || [];
eq(surfaceValues.length, 2, 'marvis-shared 里 --surface 有亮/暗两个定义');
ok(surfaceValues.every(v => /^--surface:\s*#[0-9a-fA-F]{6}\s*;$/.test(v)),
   '两个 --surface 都是不带 alpha 的 6 位 hex（不透明）：' + JSON.stringify(surfaceValues));
ok(/--soft:\s*var\(--nav-hover-bg\)/.test(shared), 'marvis-shared --soft 指向 --nav-hover-bg');
const hoverBgs = shared.match(/--nav-hover-bg:\s*rgba\([^)]*\)/g) || [];
ok(hoverBgs.length >= 2, '找得到亮/暗两处 --nav-hover-bg');
ok(hoverBgs.every(v => { const m = /,\s*([\d.]+)\)$/.exec(v); return m && Number(m[1]) >= 0 && Number(m[1]) < 1; }),
   '--nav-hover-bg 都带 <1 的 alpha（半透明，盖不住只读层）：' + JSON.stringify(hoverBgs));
const sharedIdx = html.indexOf('marvis-shared.css');
const canvasIdx = html.indexOf('css/smart-canvas.css');
ok(canvasIdx >= 0 && sharedIdx > canvasIdx,
   'marvis-shared.css 在 smart-canvas.css 之后加载 → --soft 取的是半透明那份（否则这条修复就是空转）');
const gridBlock = rule(css, '\\.table-node-grid');
ok(/background:\s*var\(--surface\)/.test(gridBlock), '.table-node-grid 底色同为 --surface（编辑器底与容器一致、不出现色块）');
const headEditing = rule(css, '\\.table-head-cell\\.is-editing');
ok(/background:\s*var\(--surface\)/.test(headEditing), '表头编辑态同款不透明底（两处做法一致）');

console.log('[4] 只读观感不变（padding / 换行规则原样）');
const viewBlock = rule(css, '\\.table-cell-view');
ok(/padding:\s*5px 0/.test(viewBlock), '只读层 padding 仍是 5px 0（不动只读观感）');
ok(/white-space:\s*pre-wrap/.test(viewBlock), '长文本换行规则不变');

console.log('[5] 编辑交互绑定一行未动');
ok(/cell\.ondblclick = event => \{ event\.stopPropagation\(\); beginTableEdit\(node, \{kind:'cell', row:rowIndex, column:index\}\); \};/.test(js),
   '双击单元格 → beginTableEdit(cell)');
ok(/const editor = document\.createElement\('textarea'\);/.test(js), '编辑器仍是 textarea');
ok(/editor\.className = 'table-cell-editor';/.test(js), '编辑器 class 不变');
ok(/editor\.value = value;/.test(js), '编辑器初值仍取单元格文字');
ok(/bindTableCellEditor\(node, editor, rowIndex, index\);/.test(js), '仍走 bindTableCellEditor');
ok(/editor\.onblur = \(\) => finish\(true\);/.test(js), '失焦提交不变');
ok(/if\(event\.key === 'Escape'\)\{ event\.preventDefault\(\); finish\(false\); \}/.test(js), 'Esc 取消不变');
ok(/else if\(event\.key === 'Enter' && !event\.shiftKey\)\{ event\.preventDefault\(\); finish\(true\); \}/.test(js), 'Enter 提交不变');
ok(/cell\.appendChild\(view\);/.test(js), '只读层 .table-cell-view 仍始终 append 到 td（只是编辑态被 visibility 藏起）');
ok(/cell\.classList\.add\('is-editing'\);/.test(js), '编辑态仍加 is-editing');
ok(/cell\.appendChild\(editor\);/.test(js), '编辑器仍 append 到同一个 td');
ok(/cell\.classList\.add\('table-media-cell', 'is-media-cell'\);/.test(js), '媒体格走独立分支（不受本次修改影响）');

console.log('');
if(fails.length){
    fails.forEach(f => console.log('  ✗ ' + f));
    console.log('失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
process.exit(0);
