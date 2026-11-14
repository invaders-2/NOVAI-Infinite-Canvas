#!/usr/bin/env node
/*
 * task-48：素材库文件夹列表 = 扁平 + 钻取。
 *   列表只列顶级文件夹，不再就地展开子项（用户说那看着像子菜单）；
 *   单击任意文件夹行 = 直接进入该文件夹视图；子文件夹只在进入后的视图顶部列出；
 *   键盘 Enter = 进入、← = 返回上一级；行上没有箭头/没有「›」/没有子级缩进；
 *   保存弹窗保留层级缩进（那是选择器，不是子菜单）。
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


// ---- 键盘规则：Enter 进入、← 返回，其它键不处理 ----
assert.strictEqual(tree.rowKeyIntent('Enter'), 'enter', 'Enter = 进入文件夹');
assert.strictEqual(tree.rowKeyIntent('ArrowLeft'), 'back', '← = 返回上一级');
assert.strictEqual(tree.rowKeyIntent('ArrowRight'), null, '→ 不再参与展开');
assert.strictEqual(tree.rowKeyIntent('a'), null, '其它键不处理');

// ---- 展开逻辑已删除：没有 toggle / expand / collapse / 双击窗口 ----
assert.strictEqual(tree.clickIntent, undefined, '不再有单击展开判定');
assert.strictEqual(tree.keyIntent, undefined, '不再有展开/收起键盘判定');
assert.strictEqual(tree.libraryExpansion, undefined, '展开状态 store 已删除');
assert.strictEqual(tree.DOUBLE_CLICK_GUARD, undefined, '单击延迟/双击窗口已删除');

// ---- 组件：扁平列表 + 单击直接进入 ----
const component = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/ui/Library.tsx'), 'utf8');
assert.ok(component.includes('rowKeyIntent'), '文件夹行用 libraryTree 的键盘规则');
assert.ok(component.includes('folders.filter((f) => !f.parentKey)') && component.includes('topFolders'), '列表只列顶级文件夹（扁平）');
assert.ok(!component.includes('visibleFolders'), '不再按展开状态过滤可见行');
assert.ok(!component.includes('expanded') && !component.includes('toggleExpanded') && !component.includes('expandRow') && !component.includes('collapseRow'), '展开状态/展开函数全部移除');
assert.ok(!component.includes('DOUBLE_CLICK_GUARD') && !component.includes('clickIntent'), '没有单击延迟和双击判定');

const rowView = component.slice(component.indexOf('function FolderRowView'), component.indexOf('export function LibrarySection'));
assert.ok(rowView.includes('onClick={() => onEnter(f)}'), '整行单击 = 直接进入');
assert.ok(!rowView.includes('onDoubleClick'), '不需要双击（单击就进）');
assert.ok(rowView.includes('role="button"') && rowView.includes('tabIndex={0}'), '行可聚焦');
assert.ok(!rowView.includes('aria-expanded') && !rowView.includes('aria-level'), '不再是可展开的树节点');
assert.ok(!rowView.includes('lib-caret'), '行上没有 ▸/▾ 箭头');
assert.ok(!rowView.includes('name="right"') && !rowView.includes('lib-enter'), '行尾没有「›」进入按钮');
assert.ok(!rowView.includes('paddingLeft'), '行没有子级缩进');
assert.ok(rowView.includes('if (intent === "enter") onEnter(f); else onBack();'), 'Enter 进入、← 返回');

const listLine = component.slice(component.indexOf('<div className="lib-folder-list">{topFolders'), component.indexOf('</> : <div className="lib-search">'));
assert.ok(listLine.includes('topFolders.map') && !listLine.includes('paddingLeft'), '列表渲染扁平、无缩进');
const folderView = component.slice(component.indexOf('lib-folder-list lib-subfolders'), component.indexOf('lib-folder-list lib-subfolders') + 900);
assert.ok(folderView.includes('childFolders.map') && folderView.includes('onEnter={enterFolder}'), '子文件夹只在进入后的视图里列出并可进入');
assert.ok(!folderView.includes('name="right"') && !folderView.includes('paddingLeft'), '子文件夹行也没有箭头/缩进');

// ---- 归并修复接进了列表和保存弹窗 ----
assert.ok(component.includes('matchFixedFolders(scope === "personal" ? assetCats : localCats, needles)'), '列表的固定文件夹归并排除了子文件夹');
assert.ok(component.includes('matchFixedFolders(pool, needles)'), '保存弹窗的固定文件夹归并同样排除子文件夹');
assert.ok(!component.includes('needles.some((n) => c.name.toLowerCase()'), '旧的关键词匹配（会吞子文件夹）已全部替换');
// 固定行（角色/场景/道具/风格/音效）即使没匹配到分类也要照常渲染（空行，不消失）
const drawerFixed = component.slice(component.indexOf('for (const [key, name, icon, needles] of fixed)'), component.indexOf('// 父级缺失的孤儿分类按顶级展示'));
assert.ok(drawerFixed.indexOf('rows.push(row);') > 0 && drawerFixed.indexOf('rows.push(row);') < drawerFixed.indexOf('if (primary) addChildren'), '列表：固定行无条件 push，再挂子级');
const dialogStart = component.indexOf('for (const [name, needles] of defs)');
const dialogFixed = component.slice(dialogStart, component.indexOf('for (const c of pool) {', dialogStart));
assert.ok(dialogFixed.indexOf('out.push({ name,') > 0 && dialogFixed.indexOf('out.push({ name,') < dialogFixed.indexOf('if (primary) addChildren'), '保存弹窗：固定行无条件 push，再挂子级');

const favRow = component.slice(component.indexOf('active === "favorite"'), component.indexOf('active === "favorite"') + 400);
assert.ok(!favRow.includes('name="right"'), '收藏/主体库行也去掉行尾「›」');

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

console.log('[PASS] 文件夹列表：扁平无箭头/无缩进，单击整行直接进入，子文件夹只在文件夹视图里');
console.log('[PASS] 文件夹列表：Enter 进入 / ← 返回、行尾无「›」、保存弹窗保留层级缩进');
