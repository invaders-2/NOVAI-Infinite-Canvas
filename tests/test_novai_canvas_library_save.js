#!/usr/bin/env node
/*
 * task-50：素材库两个既有问题的修复。
 *   1) 抽屉关着时保存的素材，重开抽屉要立刻看到（bridge 缓存失效 + 抽屉打开强制拉最新）；
 *   2) 多资产库时保存弹窗按「文件夹所属的库」保存，不再固定用第一个库。
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
const tree = load('novai-canvas-ui/src/canvas/canvas-next/libraryTree.ts');

// ---- 分类 → 所属资产库 ----
const libs = [
  { id: 'default', categoryIds: ['characters', 'scenes', 'cat_a'] },
  { id: 'lib_2', categoryIds: ['cat_b', 'asset:cat_c'] },
];
const owners = tree.categoryOwners(libs);
assert.strictEqual(owners.get('characters'), 'default', '单库的顶级分类归属');
assert.strictEqual(owners.get('cat_a'), 'default', '第一库的子分类归属');
assert.strictEqual(owners.get('cat_b'), 'lib_2', '第二个库的分类归属');
assert.strictEqual(owners.get('cat_c'), 'lib_2', '带 asset: 前缀也能对上');
assert.strictEqual(owners.get('nope'), undefined, '未知分类没有归属');
assert.strictEqual(tree.categoryOwners([{ id: 'only' }]).size, 0, '库没给 categoryIds 时不报错');

const bridge = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBridge.ts'), 'utf8');
// ---- 缓存失效 ----
assert.ok(bridge.includes('function invalidateGlobalAssets'), 'bridge 有缓存失效函数');
assert.ok(bridge.includes('globalPageCache.clear()'), '失效时清掉分页缓存');
assert.ok(bridge.includes('target.items = [...(target.items || []), item]'), '能对上分类就把新条目并进 extras 缓存');
assert.ok(bridge.includes('if (!item || !target) { globalExtrasCache = null; return; }'), '对不上分类就作废 extras 缓存，下次重拉');
const importBlock = bridge.slice(bridge.indexOf('async function importAsset'), bridge.indexOf('async function ensurePromptLibrary'));
assert.ok(importBlock.includes('invalidateGlobalAssets(made.item, cat ? String(cat.id) : undefined)'), '导入成功后立刻失效缓存（不等 5 分钟 TTL）');
assert.ok(bridge.includes('categoryIds: categories(lib, false).map((cat: Row) => String(cat.id))'), 'assetLibrary/list 带回每个库的分类 id');

const component = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Library.tsx'), 'utf8');
// ---- 抽屉打开强制拉最新 ----
assert.ok(component.includes('{ type: "canvas/globalAssets", limit: PAGE, refresh: true }'), '抽屉挂载时强制拉一次最新（绕过 5 分钟缓存）');
// ---- 保存弹窗按文件夹所属库保存 ----
assert.ok(component.includes('categoryOwners, matchFixedFolders, rowKeyIntent'), '组件用 libraryTree.categoryOwners');
assert.ok(component.includes('const owners = useMemo(() => categoryOwners(libs), [libs])'), '弹窗记下 folder→library 映射');
assert.ok(component.includes('libraryId: ownerOf('), '每个文件夹行带上所属 libraryId');
const saveBlock = component.slice(component.indexOf('const save = async () => {'), component.indexOf('const makeFolder = async () => {'));
assert.ok(saveBlock.includes('const targetLib = (row?.libraryId ? libs.find((l) => l.id === row.libraryId) : null) || lib;'), '保存时用选中文件夹所属的库');
assert.ok(saveBlock.includes('saveOne(cmd, store, targetLib, node, target)'), 'import 走 targetLib 而不是固定第一个库');
assert.ok(saveBlock.includes('已存入「" + targetLib.name + "」'), 'toast 报实际落到的库');
const makeBlock = component.slice(component.indexOf('const makeFolder = async () => {'), component.indexOf('return <div className="save-lib">'));
assert.ok(makeBlock.includes('const parentLib = (parent?.libraryId ? libs.find((l) => l.id === parent.libraryId) : null) || lib;'), '新建子文件夹也落在父文件夹所属的库');
assert.ok(makeBlock.includes('libraryId: parentLib.id'), '新建用 parentLib.id');
const dropBlock = component.slice(component.indexOf('export async function saveNodeToLibraryDrop'), component.indexOf('export async function saveNodeToLibrary('));
assert.ok(dropBlock.includes('const folderOwner = folderId ? libs.find('), '拖入文件夹时同样按文件夹所属库保存');
assert.ok(dropBlock.includes('const lib = folderOwner || libs.find(isPersonal) || libs[0];'), '找不到归属才退回第一个个人库（单库行为不变）');

console.log('[PASS] 素材库保存：导入后缓存立刻失效/合并，抽屉打开强制拉最新');
console.log('[PASS] 素材库保存：保存弹窗按文件夹所属资产库保存（单库行为不变），拖入同样按归属库');
