#!/usr/bin/env node
/*
 * 素材库抽屉文件夹 = 手风琴（2026-11 用户要求，取代 task-48 的「扁平 + 钻取」）：
 *   单击文件夹行在它正下方就地展开（子文件夹 + 素材），再点收起，收起时什么都不显示；
 *   键盘 Enter/空格 = 展开或收起、→ 展开、← 收起；
 *   新建 / 改名文件夹在列表里行内输入，不弹窗；
 *   文件夹来自后端真实分类（buildFolderTree），保存弹窗保留层级缩进。
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

// ---- 固定文件夹归并：名字完全匹配 / id 命中才算（task-49 + task-51）----
const cats = [
  { id: 'asset:characters', name: '角色' },
  { id: 'asset:props', name: '道具' },
  { id: 'asset:scenes', name: '场景' },
  { id: 'asset:cat_prop_kid', name: '小道具', parent_id: 'asset:props' },
  { id: 'asset:cat_role_kid', name: '小角色', parent_id: 'asset:characters' },
  { id: 'asset:cat_role_kid2', name: '角色参考', parent_id: 'asset:characters' },
  { id: 'asset:cat_scene_pic', name: '场景图' },
  { id: 'asset:cat_prop_backup', name: '道具备份' },
  { id: 'asset:cat_renamed', name: '人物', parent_id: '' },
  { id: 'asset:cat_plain', name: '参考图' },
];
assert.strictEqual(tree.isChildCategory(cats[3]), true, '有 parent_id 的是子文件夹');
assert.strictEqual(tree.isChildCategory(cats[0]), false, '顶级文件夹不是子文件夹');
assert.strictEqual(tree.bareCategoryId('asset:characters'), 'characters', '去掉 asset: 前缀');
assert.strictEqual(tree.bareCategoryId('local:audio'), 'audio', '去掉 local: 前缀');

const propMatch = tree.matchFixedFolders(cats, ['道具', 'props', 'prop']);
assert.deepStrictEqual(propMatch.map((c) => c.name), ['道具'], '顶级「道具」归并，子级「小道具」不参与');
assert.ok(!propMatch.some((c) => c.id === 'asset:cat_prop_kid'), '子文件夹不参与归并');
const roleMatch = tree.matchFixedFolders(cats, ['角色', 'characters', 'character', 'role']);
assert.deepStrictEqual(roleMatch.map((c) => c.name), ['角色'], '「小角色」「角色参考」不参与归并（子级）');
const sceneMatch = tree.matchFixedFolders(cats, ['场景', 'scenes', 'scene']);
assert.deepStrictEqual(sceneMatch.map((c) => c.name), ['场景'], '名字含「场景」的顶级「场景图」不被吞');
assert.ok(!sceneMatch.some((c) => c.name === '场景图'), '「场景图」保留为独立文件夹');
assert.ok(!sceneMatch.some((c) => c.name === '道具备份'), '「道具备份」也不会被「道具」吞');
assert.deepStrictEqual(tree.matchFixedFolders(cats, ['参考']).map((c) => c.name), [], '只按名字完全相等匹配，「参考图」不再被「参考」吞');
assert.deepStrictEqual(tree.matchFixedFolders(cats, ['不存在']).map((c) => c.name), [], '没有匹配就返回空（固定行由调用方无条件渲染）');
assert.deepStrictEqual(tree.matchFixedFolders([{ id: 'asset:characters', name: '人物' }], ['角色', 'characters']).map((c) => c.name), ['人物'], '后端默认分类被改名后，靠 id 命中仍归到「角色」');


// ---- 键盘规则：Enter/空格 展开收起，→ 展开，← 收起 ----
assert.strictEqual(tree.rowKeyIntent('Enter'), 'toggle', 'Enter = 展开 / 收起');
assert.strictEqual(tree.rowKeyIntent(' '), 'toggle', '空格 = 展开 / 收起');
assert.strictEqual(tree.rowKeyIntent('ArrowRight'), 'open', '→ = 展开');
assert.strictEqual(tree.rowKeyIntent('ArrowLeft'), 'close', '← = 收起');
assert.strictEqual(tree.rowKeyIntent('a'), null, '其它键不处理');

// ---- buildFolderTree：先序排列、子级紧跟父级、合计含子级、孤儿 / 成环兜底 ----
const tcats = [
  { id: 'asset:a', name: '产品' },
  { id: 'asset:b', name: '场景' },
  { id: 'asset:a1', name: '鞋', parent_id: 'asset:a' },
  { id: 'asset:a1x', name: '白鞋', parent_id: 'asset:a1' },
  { id: 'asset:orphan', name: '孤儿', parent_id: 'asset:gone' },
  { id: 'asset:c1', name: '环1', parent_id: 'asset:c2' },
  { id: 'asset:c2', name: '环2', parent_id: 'asset:c1' },
];
const counts = { 'asset:a': 2, 'asset:a1': 3, 'asset:a1x': 1, 'asset:b': 4 };
const ft = tree.buildFolderTree(tcats, (id) => counts[id] || 0);
assert.deepStrictEqual(ft.map((f) => f.name), ['产品', '鞋', '白鞋', '场景', '孤儿', '环1', '环2'], '先序：子文件夹紧跟父级');
assert.deepStrictEqual(ft.map((f) => f.depth), [0, 1, 2, 0, 0, 0, 1], '层级深度');
const byName = Object.fromEntries(ft.map((f) => [f.name, f]));
assert.strictEqual(byName['产品'].total, 6, '合计含所有子孙');
assert.strictEqual(byName['产品'].count, 2, '自己直接装的数量');
assert.deepStrictEqual(byName['产品'].childKeys, ['folder:asset:a1'], '直接子级');
assert.strictEqual(byName['鞋'].parentKey, 'folder:asset:a', 'parentKey 指向父级');
assert.strictEqual(byName['孤儿'].parentKey, undefined, '父级不存在的按顶级显示');
assert.strictEqual(new Set(ft.map((f) => f.key)).size, ft.length, '成环也不重复');

// ---- 组件：手风琴 + 行内新建 / 改名 ----
const component = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Library.tsx'), 'utf8');
const section = component.slice(component.indexOf('export function LibrarySection'), component.indexOf('function DeleteFolderDialog'));
assert.ok(section.includes('rowKeyIntent'), '文件夹行用 libraryTree 的键盘规则');
assert.ok(section.includes('buildFolderTree(pool'), '文件夹来自后端真实分类树');
assert.ok(!section.includes('["role", "角色", "user"'), '抽屉不再有写死的虚拟文件夹');
assert.ok(!section.includes('"Others"'), '不再常驻 Others');
assert.ok(!section.includes('收藏') && !section.includes('主体库'), '去掉空壳「收藏」和「主体库」');
assert.ok(!section.includes('enterFolder') && !section.includes('folderKey'), '不再钻取进入文件夹视图');
const renderBlock = section.slice(section.indexOf('const renderFolder'), section.indexOf('const topFolders'));
assert.ok(renderBlock.includes('aria-expanded={isOpen}') && renderBlock.includes('onClick={() => toggleFolder(f)}'), '单击行 = 展开 / 收起');
assert.ok(renderBlock.includes('{isOpen ? <div className="lib-fbody">'), '内容紧跟在该文件夹行下方，收起时不渲染');
assert.ok(renderBlock.includes('f.childKeys.map((k) => folderByKey.get(k))') && renderBlock.includes('.map(renderFolder)'), '子文件夹在父级下方递归展开');
assert.ok(renderBlock.includes('data-folder-name={f.name}') && renderBlock.includes('className={"lib-row lib-frow"'), '行保留拖放落点标记（Viewport 用 .lib-folder-list .lib-row）');
assert.ok(renderBlock.includes('edit?.mode === "rename"') && renderBlock.includes('<FolderEditRow'), '改名在行内输入');
assert.ok(section.includes('edit?.mode === "new"') && section.includes('setEdit({ mode: "new" })'), '新建文件夹在列表末尾行内输入');
assert.ok(section.includes('mode: "sub"') && section.includes('新建子文件夹'), '右键 / 更多菜单可新建子文件夹');
assert.ok(!component.includes('FolderNameDialog'), '新建 / 改名不再弹窗');
const editRow = component.slice(component.indexOf('function FolderEditRow'), component.indexOf('export function LibrarySection'));
assert.ok(editRow.includes('e.key === "Enter"') && editRow.includes('e.key === "Escape"'), '行内输入 Enter 保存 / Esc 取消');

// 保存弹窗：层级缩进保留（选择器）
const saveRows = component.slice(component.indexOf('className={"lib-row sl-frow"'), component.indexOf('className={"lib-row sl-frow"') + 900);
assert.ok(saveRows.includes('paddingLeft: 6 + r.depth * 15'), '保存弹窗保留层级缩进');
assert.ok(!saveRows.includes('lib-caret') && !saveRows.includes('name="right"'), '保存弹窗没有展开箭头');
assert.ok(saveRows.includes('onClick={() => setSel(folderKeyOf(r))}'), '保存弹窗单击只选中（按文件夹 id）');

// ---- 样式：没有箭头/进入按钮样式，行可点、不选字、焦点无框 ----
const css = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css'), 'utf8');
assert.ok(!css.includes('.lib-caret'), '箭头样式已删除');
assert.ok(!css.includes('.lib-enter'), '进入按钮样式已删除');
assert.ok(!css.includes('.lib-row>svg:last-child'), '行尾图标样式（箭头用）已删除');
const styleBlock = css.slice(css.indexOf('.cn-root .lib-row em small'), css.indexOf('.cn-root .lib-name') + '.cn-root .lib-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'.length);
assert.ok(styleBlock.includes('.lib-folder-list .lib-row{cursor:pointer;outline:none;user-select:none'), '整行可点 + 不选字');
assert.ok(styleBlock.includes('.lib-row:focus-visible{background:var(--hover);color:var(--fg);outline:none;box-shadow:none}'), '焦点态软底、无描边');
assert.ok(!/border:\s*(1px|0\.5px)/.test(styleBlock), '文件夹行样式里没有 1px 描边');

console.log('[PASS] 文件夹手风琴：单击就地展开 / 收起，子文件夹递归展开，行内新建 / 改名');
console.log('[PASS] 文件夹树：Enter/空格 展开收起、→ 展开、← 收起，先序 + 合计 + 孤儿兜底，保存弹窗保留层级缩进');

// ---- 单击画布空白处收起素材库抽屉（拖动平移 / 框选不收）----
const viewportSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Viewport.tsx'), 'utf8');
assert.ok(viewportSrc.includes('if ((d.kind === "pan" || d.kind === "marq") && !d.moved && (st.ui.drawer === "assets" || st.ui.drawer === "history")) store.setUI({ drawer: null });'), '单击空白处收起抽屉');
console.log('[PASS] 单击画布空白处收起素材库抽屉');
