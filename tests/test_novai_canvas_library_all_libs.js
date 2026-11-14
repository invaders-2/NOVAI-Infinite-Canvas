#!/usr/bin/env node
/*
 * 素材库联动（PR：素材库检索与存取）：
 *   1) 抽屉 / 保存弹窗列出所有资产库的文件夹，不只是「当前激活」的库；
 *   2) 文件夹改名 / 删除 / 建子文件夹按文件夹所在的库操作；
 *   3) 多选 / 堆叠存素材库也先选文件夹（不再默认落到第一个图片分类）；
 *   4) 保存弹窗按文件夹 id 选中，同名文件夹不会串。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
  const r = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

// ---- allLibrariesView：摊平所有库 ----
const bridge = load('novai-canvas-ui/src/novaiBridge.ts');
const asset = {
  library: {
    active_library_id: 'lib_b',
    categories: [{ id: 'cat_b', name: '默认分组', items: [] }],
    libraries: [
      { id: 'default', name: '默认资产库', categories: [{ id: 'characters', name: '角色', items: [{ id: 'a1', url: '/a.png' }] }] },
      { id: 'lib_b', name: '产品库', categories: [
        { id: 'cat_b', name: '默认分组', items: [{ id: 'b1', url: '/b.png' }] },
        { id: 'cat_c', name: '鞋', parent_id: 'cat_b', items: [] },
      ] },
    ],
  },
};
const view = bridge.allLibrariesView(asset);
const cats = view.library.categories;
assert.deepStrictEqual(cats.map((c) => c.id), ['characters', 'cat_b', 'cat_c'], '所有库的分类都在');
assert.strictEqual(cats[0].name, '角色', '默认库不加前缀（固定文件夹「角色」照常归并）');
assert.strictEqual(cats[1].name, '产品库 · 默认分组', '非默认库的顶级文件夹加库名前缀');
assert.strictEqual(cats[2].name, '鞋', '子文件夹不加前缀');
assert.strictEqual(asset.library.categories.length, 1, '不改原对象');
const single = { library: { libraries: [{ id: 'lib_x', name: '唯一库', categories: [{ id: 'k', name: '产品', items: [] }] }] } };
assert.strictEqual(bridge.allLibrariesView(single).library.categories[0].name, '产品', '只有一个库时不加前缀');
assert.strictEqual(bridge.allLibrariesView({ library: { categories: [] } }).library.categories.length, 0, '旧数据没有 libraries 时原样返回');

// ---- 接线 ----
const src = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBridge.ts'), 'utf8');
assert.ok(src.includes('globalExtrasCache = { at: Date.now(), asset: allLibrariesView(asset), prompt };'), '抽屉数据走 allLibrariesView');
for (const t of ['folderRename', 'folderDelete']) {
  const block = src.slice(src.indexOf(`type === "canvas/assetLibrary/${t}"`));
  assert.ok(block.slice(0, 600).includes('libraryOwning(data, input.categoryId)'), `${t} 按文件夹所在库操作`);
}
assert.ok(src.includes('const owner = input.parentId ? libraryOwning(await rawLibrary(), input.parentId) : null;'), '建子文件夹落在父文件夹所在库');
assert.ok(src.includes('String(input.to || "").startsWith(prefix)'), '改名时去掉抽屉加的库名前缀');

const ui = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Library.tsx'), 'utf8');
const multi = ui.slice(ui.indexOf('export async function saveNodesToLibrary'));
assert.ok(multi.includes('<SaveLibraryDialog ctl={ctl} nodes={list} onClose={close} />'), '多选存素材库打开选文件夹弹窗');
assert.ok(!multi.includes('saveOne(cmd, store, lib, n)'), '不再不选文件夹直接存');
assert.ok(ui.includes('const folderKeyOf = (r: { id?: string; name: string }) => r.id ? "id:" + r.id : "name:" + r.name;'), '文件夹行按 id 选中');
assert.ok(ui.includes('rows.find((r) => folderKeyOf(r) === sel)'), '保存 / 建子文件夹都按 id 找选中行');
assert.ok(!ui.includes('rows.find((r) => r.name === sel)'), '不再按名字找选中行');

console.log('[PASS] 素材库联动：抽屉列出所有库、文件夹操作按所在库、多选存入先选文件夹、按 id 选文件夹');
