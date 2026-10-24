#!/usr/bin/env node
/* 创建菜单回归（A）：
   A1. 右键菜单第一项「图片节点」（smart-image）+「视频节点」（smart-video）+「音频节点」
       （smart-audio，内联线性音符）+「上传…」（打开系统文件选择器），共 10 项；
   A2. 图片/视频/音频入口只建空节点；「上传…」不建空节点，而是记住右键落点后打开 #fileInput，
       选完文件在落点建节点；上传仍走拖入画布 / 节点自身的上传按钮；
   A3. 素材库拖素材到画布按真实类型落节点（本地素材库要能列出视频；壳层 drop 用 createNode 的类型判定）；
   A4. 空画布引导菜单同步加「视频节点」。
   跑法：node tests/test_smart_canvas_create_menu.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');

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

const menuBlock = html.slice(html.indexOf('id="createMenu"'), html.indexOf('id="fileInput"'));
console.log('[1] #createMenu 菜单项');
ok(/data-create-type="image"/.test(menuBlock), '保留 image 入口（图片节点）');
ok(/data-create-type="video"/.test(menuBlock), '新增 video 入口（视频节点）');
ok(/data-lucide="image"/.test(menuBlock) && /<span>图片节点<\/span>/.test(menuBlock), '第一项是「图片节点」+ 线性 image 图标');
ok(/data-lucide="video"/.test(menuBlock) && /<span>视频节点<\/span>/.test(menuBlock), '新增「视频节点」+ 线性 video 图标');
ok(/data-create-type="audio"/.test(menuBlock) && /<span>音频节点<\/span>/.test(menuBlock), '新增「音频节点」入口');
const audioMenuBtn = menuBlock.slice(menuBlock.indexOf('data-create-type="audio"'), menuBlock.indexOf('data-create-type="upload"'));
ok(/<svg[^>]*stroke="currentColor"/.test(audioMenuBtn) && /<circle/.test(audioMenuBtn), '音频节点用内联线性音符（lucide 子集没有 music）');
ok(!/fill="currentColor"/.test(audioMenuBtn), '音符是线性图标（不填充）');
ok(/data-create-type="upload"/.test(menuBlock) && /data-lucide="upload"/.test(menuBlock) && /<span>上传…<\/span>/.test(menuBlock), '新增「上传…」+ 线性 upload 图标');
ok((menuBlock.match(/data-create-type=/g) || []).length === 10, '菜单共 10 项（原 8 项 + 音频 + 上传）');

console.log('[2] createNodeFromMenu：图片/视频/音频入口只建空节点，「上传…」走文件选择器');
const cnfm = topLevelFunction(js, 'createNodeFromMenu');
ok(/type === 'video'/.test(cnfm), 'createNodeFromMenu 认得 video');
ok(/createImageNodeAt\(p, \[\], \{type:'smart-video'\}\)/.test(cnfm), 'video 入口建 smart-video 空节点');
ok(/type === 'audio'\) created = createImageNodeAt\(p, \[\], \{type:'smart-audio', title:tr\('smart\.kindAudio'\)\}\)/.test(cnfm), 'audio 入口建 smart-audio 空节点（标题用中文种类名）');
ok(/if\(type === 'upload'\)\{/.test(cnfm) && /pendingMenuUploadPoint = createMenuPoint \|\| viewportCenter\(\)/.test(cnfm), '上传入口先记住右键落点（pendingMenuUploadPoint）');
ok(/fileInput\?\.click\(\)/.test(cnfm) && /return null;/.test(cnfm), '上传入口打开 #fileInput 并直接返回（不建空节点）');
ok(!/pickLocalMediaForNode|pickMediaForSmartNode|createElement\('input'\)/.test(cnfm), '图片/视频/音频入口不再打开本地上传选择器');
ok(!/pickLocalMediaForNode/.test(js), '删除创建节点专用的 pickLocalMediaForNode');
ok(/pickMediaForSmartNode\(id\)/.test(js), '节点自身的上传按钮保留（仍可打开选择器）');
ok(/async function handleFiles/.test(js), '拖拽 / 粘贴上传入口保留');

console.log('[3] 上传落点类型 + 素材库拖拽类型');
const append = topLevelFunction(js, 'appendImagesToSmartNode');
ok(/opts\.type \|\| \(opts\.mediaKind === 'video' \? 'smart-video' : 'smart-image'\)/.test(append), '新建节点按 opts 决定 smart-video / smart-image');
ok(/applySmartMediaTypeForKind\(node, smartUploadNodeKind\(node\.images\)\)/.test(append), '新节点按素材真实类型收敛节点 type（音频 → smart-audio）');
ok(/function smartUploadNodeKind\(items\)\{[\s\S]*?if\(list\.every\(isAudioMediaItem\)\) return 'audio';[\s\S]*?list\.every\(isVideoMediaItem\) \? 'video' : 'image'/.test(js),
    'smartUploadNodeKind：清一色音频 → audio，清一色视频 → video，其余（含图文混传）→ image');
ok(/if\(kinds\.has\('audio'\)\) return tr\('smart\.kindAudio'\)/.test(js), '上传音频的标题用中文种类名（不再是 Audio）');
const onchange = js.slice(js.indexOf('fileInput.onchange = () => {'), js.indexOf('if(assetToggle) assetToggle.onclick'));
ok(/const menuPoint = pendingMenuUploadPoint;/.test(onchange), 'fileInput.onchange 读取菜单上传落点');
ok(/forceNew:true/.test(onchange) && /\(groupPoint \|\| menuPoint\) \? '' : \(uploadTargetId \|\| selectedId\)/.test(onchange),
    '菜单上传落到右键落点且 forceNew（不追加到当前选中节点）');
ok(/pendingMenuUploadPoint = null;/.test(onchange), '用完清空一次性落点');
ok(/addEventListener\('cancel', \(\) => \{ pendingMenuUploadPoint = null; \}\)/.test(js), '取消选择文件时清掉一次性落点（不污染其它上传入口）');
ok(/\['image', 'video'\]\.includes\(assetMediaKind\(item\)\)/.test(js), '本地素材库分类同时列出图片与视频（否则视频没法拖）');
const createNode = topLevelFunction(js, 'createNode');
ok(/nodeImages\.every\(isVideoMediaItem\) \? 'smart-video' : 'smart-image'/.test(createNode), '壳层 drop 走 createNode：清一色视频建 smart-video');

console.log('[4] 空画布引导菜单');
ok(/data-empty-action="video"/.test(js) && /文字生视频/.test(js), '空画布引导保留视频入口（文字生视频）');
ok(/window\.zoomBarCreate\('video'\)/.test(js), '引导胶囊复用 zoomBarCreate → createNodeFromMenu');

console.log('[5] 行为：smartUploadNodeKind 按素材真实类型判定');
const kindSandbox = {
    isAudioMediaItem: img => Boolean(img && img.kind === 'audio'),
    isVideoMediaItem: img => Boolean(img && img.kind === 'video')
};
vm.runInNewContext(topLevelFunction(js, 'smartUploadNodeKind') + '\nglobalThis.__kind = smartUploadNodeKind;', kindSandbox);
const kindOf = kindSandbox.__kind;
ok(kindOf([{kind:'audio'}]) === 'audio', '单个音频 → audio');
ok(kindOf([{kind:'audio'}, {kind:'audio'}]) === 'audio', '多个音频 → audio（不混进图片节点）');
ok(kindOf([{kind:'video'}]) === 'video', '单个视频 → video（保持原行为）');
ok(kindOf([{kind:'image'}]) === 'image', '图片 → image');
ok(kindOf([{kind:'image'}, {kind:'audio'}]) === 'image', '图文混传 → image（音频作为素材进图片节点）');
ok(kindOf([{kind:'image'}, {kind:'video'}]) === 'image', '图视频混传 → image（与原有收敛口径一致）');
ok(kindOf([]) === 'image', '没有素材时兜底 image');

console.log('');
console.log('创建菜单回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
