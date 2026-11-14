#!/usr/bin/env node
/*
 * 素材库 → 画布：放上去的节点记住来源素材（gen.asset = 条目 id / 用途 / 产品档案），助手据此知道这是哪个产品。
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
const lib = load('novai-canvas-ui/src/canvas/canvas-next/libraryAssets.ts');
const asset = { library: { categories: [{ id: 'c1', name: '产品', type: 'image', items: [
  { id: 'asset_1', name: '白鞋正面', url: '/assets/library/a.png', use: 'product', product_id: 'prod_1' },
  { id: 'asset_2', name: '无用途', url: '/assets/library/b.png' },
] }] } };
const canvas = { items: [{ id: 'cv1', name: '画布里的同一张', url: '/assets/library/a.png', canvas_kind: 'smart' }], categories: [] };
const merged = lib.mergeAssetSources(canvas, { items: [] }, asset, { library: { libraries: [] } });
const a = merged.items.find((x) => x.url === '/assets/library/a.png');
assert.strictEqual(a.assetId, 'asset_1', '画布里也有的文件补上资产库条目 id');
assert.strictEqual(a.use, 'product');
assert.strictEqual(a.productId, 'prod_1');
const b = merged.items.find((x) => x.url === '/assets/library/b.png');
assert.strictEqual(b.assetId, 'asset_2');
assert.strictEqual(b.use, undefined, '没有用途就不带');

const ui = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Library.tsx'), 'utf8');
const place = ui.slice(ui.indexOf('export async function placeItem'), ui.indexOf('function scopeOf'));
assert.ok(place.includes('const asset = assetRefOf(it);'), 'placeItem 取来源引用');
assert.ok(place.includes('...(asset ? { asset } : {})'), '新节点写入 gen.asset');
assert.ok(place.includes('store.patchGen(target, { asset })'), '替换素材时同步来源引用');
const model = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/model.ts'), 'utf8');
assert.ok(model.includes('asset?: AssetRef;'), 'GenData 有 asset 字段');
console.log('[PASS] 素材库 → 画布：节点记住来源素材（条目 id / 用途 / 产品档案）');
