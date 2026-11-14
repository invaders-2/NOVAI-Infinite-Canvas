#!/usr/bin/env node
/* task-34：全局素材库合并/分类/搜索/原图比例。 */
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
const canvas = { categories: [{ id: 'all', name: '全部画布' }, { id: 'smart', name: '智能画布' }], items: [
  { id: 'c1', url: '/a.png', name: 'A', kind: 'image', canvas_id: 'cv1', canvas_kind: 'smart' },
  { id: 'c2', url: '/a.png', name: 'A duplicate', kind: 'image', canvas_id: 'cv2', canvas_kind: 'smart' },
  { id: 'c3', url: '/b.mp4', name: 'B', kind: 'video', canvas_id: 'cv3', canvas_kind: 'classic' },
] };
const local = { items: [
  { id: 'l1', url: '/a.png', name: 'A local', kind: 'image', folder: 'characters', natural_w: 800, natural_h: 600 },
  { id: 'l2', url: '/voice.mp3', name: 'voice', kind: 'audio', folder: 'audio' },
] };
const assets = { library: { categories: [{ id: 'characters', name: '角色', type: 'image', items: [{ id: 'ch1', url: '/char.png', name: '角色', kind: 'image' }] }, { id: 'scenes', name: '场景', type: 'image', items: [] }] } };
const prompts = { library: { libraries: [{ items: [{ id: 'p1', name: '提示词', positive: '电影感' }] }] } };
const merged = lib.mergeAssetSources(canvas, local, assets, prompts);
assert.strictEqual(merged.items.filter((x) => x.url === '/a.png').length, 1, '按 URL 去重');
assert.strictEqual(merged.categories.find((c) => c.id === 'all').count, merged.items.length, '全部计数');
assert.ok(merged.categories.some((c) => c.id === 'canvas:smart' && c.count >= 1), '画布分类');
assert.ok(merged.categories.some((c) => c.id === 'local:characters'), '本地文件夹分类');
assert.ok(merged.categories.some((c) => c.id === 'asset:characters'), '资产库角色分类');
assert.ok(merged.categories.some((c) => c.id === 'prompt:all'), '提示词分类');
assert.deepStrictEqual(lib.filterLibraryItems(merged.items, 'local:characters', '').map((x) => x.url), ['/a.png'], '按本地 folder 过滤');
assert.deepStrictEqual(lib.filterLibraryItems(merged.items, 'asset:characters', '').map((x) => x.url), ['/char.png'], '按资产库分类过滤');
assert.deepStrictEqual(lib.filterLibraryItems(merged.items, 'all', '电影').map((x) => x.kind), ['prompt'], '提示词可搜索');
assert.deepStrictEqual(lib.filterLibraryItems(merged.items, 'all', 'voice').map((x) => x.url), ['/voice.mp3'], '搜索');
assert.deepStrictEqual(lib.libraryNodeBox(800, 600, 'image'), { w: 320, h: 240 }, '横图按原比例');
assert.deepStrictEqual(lib.libraryNodeBox(600, 800, 'image'), { w: 320, h: 427 }, '竖图按原比例');
assert.deepStrictEqual(lib.libraryNodeBox(0, 0, 'video'), { w: 320, h: 180 }, '视频缺尺寸时 16:9 兜底，不方形');

const bridge = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBridge.ts'), 'utf8');
const component = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Library.tsx'), 'utf8');
assert.ok(bridge.includes('/api/canvas-assets') && bridge.includes('/api/local-assets') && bridge.includes('/api/asset-library') && bridge.includes('/api/prompt-libraries'), '桥接三个全局来源');
assert.ok(bridge.includes('mergeAssetSources') && bridge.includes('canvas/globalAssets'), '素材库走全局合并命令');
assert.ok(component.includes('filterLibraryItems') && component.includes('libraryNodeBox') && component.includes('replaceNodeMedia'), '分类/搜索/插入使用纯函数和原图盒');
assert.ok(!component.includes('canvas/libraryList'), '不再只读 asset-library 的空列表');
assert.ok(component.includes('const PAGE = 60') && component.includes('IntersectionObserver') && component.includes('slice(0, visible)'), '首屏 60 条 + 无限滚动增量');
assert.ok(component.includes('loading="lazy"') && component.includes('decoding="async"') && component.includes('/api/media-preview?w=256'), '缩略图走 media-preview + lazy');
assert.ok(bridge.includes('globalPageCache') && bridge.includes('globalExtrasCache') && bridge.includes('5 * 60 * 1000') && bridge.includes('input.refresh'), '会话分页缓存 + 手动刷新');
assert.ok(bridge.includes('?limit=') && component.includes('hasMore') && component.includes('offset + PAGE'), 'API limit 分页 + 滚到底加载');
assert.ok(component.includes('lib-head') && component.includes('lib-scope') && component.includes('个人') && component.includes('本地'), '文件管理器式头部/个人本地切换');
assert.ok(component.includes('lib-folder-list') && component.includes('buildFolderTree(pool'), '抽屉文件夹 = 后端真实分类树（不再有前端写死的虚拟文件夹）');
const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
assert.ok(css.includes('.drawer:has(.lib-shell)') && css.includes('.lib-row') && css.includes('.lib-scope'), '抽屉布局样式');
assert.ok(component.includes('aria-expanded={isOpen}') && component.includes('toggleFolder') && component.includes('lib-fbody'), '文件夹手风琴：点开在下方就地展开，再点收起');
assert.ok(component.includes('这个文件夹还是空的') && component.includes('显示全部'), '展开后的空态 / 超出先折叠');
assert.ok(component.includes('canvas/assetLibrary/products') && component.includes('lib-chips') && component.includes('lib-types'), '产品档案 / 用途筛选 / 类型筛选');
assert.ok(component.includes('normalizeAssetUrl(store, o.url)') && component.includes('input.url = prep.url'), '素材地址先归一化再直传 URL');
assert.ok(component.includes('prep.dataUrl') && component.includes('读取素材失败'), 'data/不可读素材有明确兜底');
assert.ok(component.includes('x?.detail || x?.error'), '后端 detail 原样进 toast');
assert.ok(bridge.includes('kind: n.kind') || component.includes('kind: n.kind'), '媒体类型传给 import');
assert.ok(bridge.includes('...(cat ? { category_id: cat.id } : {})') && bridge.includes('...(input.kind ? { kind } : {})'), '视频/音频不带图片分类，后端按 kind 归类');
const viewport = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Viewport.tsx'), 'utf8');
assert.ok(viewport.includes('saveNodeToLibraryDrop') && viewport.includes('asset-drop') && viewport.includes('e.altKey'), 'Alt 拖节点到素材库');
assert.ok(component.includes('saveNodeToLibraryDrop') && component.includes('把画布上的节点拖到这里存入素材库'), '拖入直接存默认库 + 可发现提示');
assert.ok(fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8').includes('.drawer.asset-drop'), '抽屉 drop 高亮样式');
assert.ok(component.includes('normalizeAssetUrl') && component.includes('/api/media-preview') && component.includes('openarc-asset'), '预览代理/openarc ref 先归一化');
assert.ok(component.includes('openModal') && component.includes('保存到素材库') && component.includes('新建文件夹') && component.includes('角色') && component.includes('场景'), '保存弹窗 + 文件夹列表');
assert.ok(component.includes('categoryName') && bridge.includes('categoryName'), '文件夹分类传到 import');
assert.ok(component.includes('categoryId') && bridge.includes('input.categoryId') && bridge.includes('category_id'), 'categoryId 映射到后端 category_id');
assert.ok(component.includes('row.id') && component.includes('folder.id ? { categoryId'), '保存弹窗把文件夹 id 传下去');
assert.ok(component.includes('onDoubleClick') && component.includes('onContextMenu') && component.includes('添加到画布') && component.includes('asset-preview-modal'), '单击选中/双击预览/右键菜单');
assert.ok(component.includes('selected === it.url') && component.includes('" sel"'), '素材选中态');
assert.ok(component.includes('__novaiLibDrag') && viewport.includes('placeItem(ctl, lib'), '素材可拖到画布插入');
assert.ok(component.includes('cn:asset-saved') && component.includes('scheduleRefresh') && component.includes('setCats'), '乐观插入 + 后台校准');
assert.ok(component.includes('/ws/stats') && component.includes('asset_library_updated') && component.includes('2 ** retry'), 'ws 自动刷新 + 指数退避重连');
assert.ok(component.includes('refreshTimer') && component.includes('400'), 'ws 去抖刷新');
assert.ok(component.includes('folderCreate') && component.includes('folderRename') && component.includes('folderDelete'), '文件夹新建/重命名/删除');
assert.ok(bridge.includes('canvas/assetLibrary/folderDelete') && bridge.includes('/api/asset-library/categories/'), 'folderDelete 桥接');
assert.ok(viewport.includes('cn-drag-ghost') && viewport.includes('assetFolderRef') && viewport.includes('clearAssetDrop'), '拖拽 ghost + 文件夹落点');
assert.ok(viewport.includes('markAssetDrop(d.orig[0].id') && viewport.includes('assetOverRef.current'), '普通拖动也能进素材库（不再只靠 Alt）');
console.log('[PASS] 全局素材库：三源合并/去重/分类/搜索/原图比例/插入 + 分页/缓存/layout');
console.log('[PASS] 全局素材库：三源合并/去重/分类/搜索/原图比例/插入接线');
assert.ok(component.includes('lib-head') && component.includes('lib-scope'), '文件管理器布局');
assert.ok(component.includes('PAGE = 60') && component.includes('loading="lazy"'), '首屏分页 + lazy');