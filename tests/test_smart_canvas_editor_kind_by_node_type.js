#!/usr/bin/env node
/* 编辑器模式判定（删除「图片 / 视频」切换按钮后的回归）：
   B1. 页面上不再有切换按钮（#apiKindToggle / .kind-toggle）：HTML 标记、JS 常量与显隐同步、
       只为它存在的 glide 接线、i18n 词条一并删除，全仓无悬挂引用；
   B2. 面板仍按 settings.apiKind 分流：图片 → renderApiParams，视频 → renderApiVideoParams；
   B3. 媒体节点按节点类型强制，批量节点按本次设置 / 视频分镜标记，不看历史产物；
   B4. 删除按钮后的可达路径仍在：创建菜单有「图片节点 / 视频节点」两个入口（空节点由此获得目标类型）。
   跑法：node tests/test_smart_canvas_editor_kind_by_node_type.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

console.log('[1] 切换按钮已完全删除（HTML / JS / CSS / i18n 无悬挂引用）');
ok(!/id="apiKindToggle"/.test(html), 'smart-canvas.html 没有 #apiKindToggle');
ok(!/kind-toggle/.test(html), 'smart-canvas.html 没有 .kind-toggle 标记');
ok(!/data-i18n="smart\.kind(Image|Video)"/.test(html), 'HTML 不再引用 smart.kindImage / smart.kindVideo');
ok(!/apiKindToggle|syncApiKindToggleVisibility/.test(js), 'smart-canvas.js 没有 apiKindToggle / syncApiKindToggleVisibility');
ok(!/\[data-kind\]/.test(js), 'smart-canvas.js 没有按 [data-kind] 切类型的旧逻辑');
ok(!/kind-toggle/.test(css), 'smart-canvas.css 没有只为切换按钮存在的 .kind-toggle');
ok(!/smart\.kind(Image|Video)/.test(i18n), 'i18n 词条 smart.kindImage / smart.kindVideo 已清理（仅该按钮使用）');

console.log('[2] 参数面板仍按 apiKind 分流：图片面板 renderApiParams / 视频面板 renderApiVideoParams');
const rdp = topLevelFunction(js, 'renderDynamicParams');
ok(/if\(settings\.apiKind === 'video'\) renderApiVideoParams\(\);\s*else renderApiParams\(\);/.test(rdp), 'engine=api：apiKind=video 出视频面板，否则图片面板');
ok(/if\(settings\.apiKind === 'video'\) renderVolcengineVideoParams\(\);\s*else renderVolcengineParams\(\);/.test(rdp), 'engine=volcengine：同样按 apiKind 分流');

console.log('[3] 媒体节点按类型决定 apiKind，批量节点按本次设置决定');
const sfn = topLevelFunction(js, 'smartSettingsForNode');
ok(/const mediaApiKind = isSmartVideoNode\(node\) \? 'video' : isSmartImageNode\(node\) \? 'image' : batchApiKind \|\| contentKind;/.test(sfn),
   'smart-video → video / smart-image → image（分组按素材回退，批量优先本次设置）');
ok(/nodeSettings\.apiKind === 'video' \? 'video' : nodeSettings\.apiKind === 'image' \? 'image' : node\?\.tableBatchVideo \? 'video' : ''/.test(sfn),
   '批量图片 / 视频本次设置优先，视频分镜标记只做默认值，不被旧产物覆盖');
ok(/if\(mediaApiKind && isApiLikeEngine\(base\.engine\)\) base\.apiKind = mediaApiKind;/.test(sfn),
   '按节点类型强制写回 base.apiKind（沿用既有逻辑，没有另造一套）');

console.log('[4] 删除按钮后的可达路径仍在：创建菜单的「图片节点 / 视频节点」两入口');
const menuBlock = html.slice(html.indexOf('id="createMenu"'), html.indexOf('id="fileInput"'));
ok(/data-create-type="video"/.test(menuBlock) && /<span>视频节点<\/span>/.test(menuBlock), '空节点→视频：菜单「视频节点」建 smart-video');
ok(/data-create-type="image"/.test(menuBlock) && /<span>图片节点<\/span>/.test(menuBlock), '空节点→图片：菜单「图片节点」建 smart-image');

console.log('');
console.log('编辑器模式由节点类型决定：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
