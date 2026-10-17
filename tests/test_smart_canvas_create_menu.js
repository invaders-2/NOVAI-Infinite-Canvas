#!/usr/bin/env node
/* 创建菜单回归（A）：
   A1. 右键菜单第一项从「上传」改为「图片节点」（smart-image，线性 image 图标），新增「视频节点」
       （smart-video，线性 video 图标），不再有「上传」项；
   A2. 两个入口只建空的 smart-image / smart-video 节点，不再打开本地上传选择器；
       上传仍走拖入画布 / 节点自身的上传按钮；
   A3. 素材库拖素材到画布按真实类型落节点（本地素材库要能列出视频；壳层 drop 用 createNode 的类型判定）；
   A4. 空画布引导菜单同步加「视频节点」。
   跑法：node tests/test_smart_canvas_create_menu.js */
'use strict';
const fs = require('fs');
const path = require('path');
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
ok(!/data-lucide="upload-cloud"/.test(menuBlock) && !/<span>上传<\/span>/.test(menuBlock), '删除了「上传」这一项');
ok((menuBlock.match(/data-create-type=/g) || []).length === 8, '菜单还是 8 项（原 7 项：删上传、加视频）');

console.log('[2] createNodeFromMenu：图片/视频入口只建空节点');
const cnfm = topLevelFunction(js, 'createNodeFromMenu');
ok(/type === 'video'/.test(cnfm), 'createNodeFromMenu 认得 video');
ok(/createImageNodeAt\(p, \[\], \{type:'smart-video'\}\)/.test(cnfm), 'video 入口建 smart-video 空节点');
ok(!/pickLocalMediaForNode|pickMediaForSmartNode|createElement\('input'\)/.test(cnfm), 'image/video 入口不再打开本地上传选择器');
ok(!/pickLocalMediaForNode/.test(js), '删除创建节点专用的 pickLocalMediaForNode');
ok(/pickMediaForSmartNode\(id\)/.test(js), '节点自身的上传按钮保留（仍可打开选择器）');
ok(/async function handleFiles/.test(js), '拖拽 / 粘贴上传入口保留');

console.log('[3] 上传落点类型 + 素材库拖拽类型');
const append = topLevelFunction(js, 'appendImagesToSmartNode');
ok(/opts\.type \|\| \(opts\.mediaKind === 'video' \? 'smart-video' : 'smart-image'\)/.test(append), '新建节点按 opts 决定 smart-video / smart-image');
ok(/applySmartMediaTypeForKind\(node, node\.images\.every\(isVideoMediaItem\) \? 'video' : 'image'\)/.test(append), '新节点按素材真实类型收敛节点 type');
ok(/\['image', 'video'\]\.includes\(assetMediaKind\(item\)\)/.test(js), '本地素材库分类同时列出图片与视频（否则视频没法拖）');
const createNode = topLevelFunction(js, 'createNode');
ok(/nodeImages\.every\(isVideoMediaItem\) \? 'smart-video' : 'smart-image'/.test(createNode), '壳层 drop 走 createNode：清一色视频建 smart-video');

console.log('[4] 空画布引导菜单');
ok(/data-empty-create="video"/.test(js) && /视频节点（上传或生成）/.test(js), '空画布引导加了「视频节点」入口');
ok(/window\.zoomBarCreate\(type\)/.test(js), '引导按钮复用 zoomBarCreate → createNodeFromMenu');

console.log('');
console.log('创建菜单回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
