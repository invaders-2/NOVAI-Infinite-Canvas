#!/usr/bin/env node
/*
 * 画布助手「结构化引用」回归测试（零依赖）：focus.references 必须带节点身份，
 * 同时旧字段 reference_images / reference_videos 继续发（后端兼容期）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const smart = read('static/js/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (condition, label) => {
    if(condition) pass += 1;
    else fails.push(label);
};
const blockAfter = (text, marker) => {
    const start = text.indexOf(marker);
    if(start < 0) return '';
    const end = text.indexOf('\n}', start);
    return text.slice(start, end < 0 ? text.length : end);
};
const focusBody = blockAfter(smart, 'function buildAgentFocus(){');
const pushSites = [];
const pushRe = /chatRefs\.push\(\{/g;
let hit;
while((hit = pushRe.exec(smart))) pushSites.push(smart.slice(hit.index, hit.index + 400));

console.log('[1] buildAgentFocus 存在且新增 references');
ok(focusBody.length > 0, 'smart-canvas.js 里能找到 function buildAgentFocus(){');
ok(/references/.test(focusBody), 'buildAgentFocus 里出现 references');
ok(/focus\.references\s*=/ .test(focusBody), 'buildAgentFocus 里给 focus.references 赋值');
ok(/\(chatRefs \|\| \[\]\)\.map\(function\(r\)\{/.test(focusBody), 'references 从全局 chatRefs 派生');
ok(/\.filter\(function\(r\)\{ return r\.id; \}\)/.test(focusBody), '过滤掉空 id（id 必填）');

console.log('[2] 每条引用带 id / name / role / source');
ok(/id:\s*String\(r\.id \|\| ''\)/.test(focusBody), 'id: String(r.id || \'\')');
ok(/name:\s*String\(r\.name \|\| ''\)\.slice\(0, 80\)/.test(focusBody), 'name 截断 80');
ok(/role:\s*r\.role \|\| null/.test(focusBody), 'role: r.role || null');
ok(/source:\s*r\.upload \? 'upload' : 'node'/.test(focusBody), "source: r.upload ? 'upload' : 'node'");

console.log('[3] 旧字段 reference_images / reference_videos 仍在（防误删）');
ok(/reference_images:\s*\[\]/.test(focusBody), 'focus 初始化里仍有 reference_images: []');
ok(/reference_videos:\s*\[\]/.test(focusBody), 'focus 初始化里仍有 reference_videos: []');
ok(/focus\.reference_images\s*=\s*chatContextImages\(\);/.test(focusBody), 'focus.reference_images = chatContextImages() 未改');
ok(/focus\.reference_videos\s*=\s*chatContextVideos\(\);/.test(focusBody), 'focus.reference_videos = chatContextVideos() 未改');

console.log('[4] chatRefs 两处 push 都补了 role: null');
ok(pushSites.length === 2, '找到 2 处 chatRefs.push（实际 ' + pushSites.length + '）');
ok(pushSites.length > 0 && /role:\s*null/.test(pushSites[0]) && /images:imgs/.test(pushSites[0]), '画布节点引用 push 带 role: null');
ok(pushSites.length > 1 && /role:\s*null/.test(pushSites[1]) && /upload:true/.test(pushSites[1]), '上传素材引用 push 带 role: null');
ok(!/chatRefs\.push\(\{[^}]*role:\s*['"]/.test(smart), '本轮只发 null，不引入 role 选择值');

console.log('[5] 引用角色 UI：常量 / 白名单 / 函数 / 徽标');
const roleBlock = blockAfter(smart, 'const CHAT_REF_ROLES = [');
const roleIds = Array.from(roleBlock.matchAll(/id:'([a-z_]*)'/g), match => match[1]);
ok(roleIds.join(',') === ',subject,style,composition,first_frame,last_frame,context', '6 个 role id 与后端白名单一致且顺序固定（实际 ' + roleIds.join(',') + '）');
ok(/id:'', label:'未指定'/.test(roleBlock), '首项「未指定」映射空字符串');
const renderBody = blockAfter(smart, 'function renderChatContext(){');
ok(/chat-ctx-role/.test(renderBody), 'renderChatContext 渲染 .chat-ctx-role 徽标');
ok(/openChatRefRolePicker\(/.test(renderBody), '徽标 onclick 调 openChatRefRolePicker');
ok(/data-ref-role=/.test(renderBody), '徽标带 data-ref-role（引用 id）');
ok(/chatRefRoleBadgeStyle\(/.test(renderBody), '徽标样式走 chatRefRoleBadgeStyle（无边框）');
ok(/roleIndex \? chatRefRoleLabel\(r\.role\) : '角色'/.test(renderBody), '未指定显示「角色」');
ok(/function chatRefRoleLabel\(role\)\{/.test(smart), 'chatRefRoleLabel 已定义');
ok(/function chatRefRoleIndex\(role\)\{/.test(smart), 'chatRefRoleIndex 已定义');
ok(/function setChatRefRole\(refId, role\)\{/.test(smart), 'setChatRefRole 已定义');
ok(/function openChatRefRolePicker\(refId, ev\)\{/.test(smart), 'openChatRefRolePicker 已定义');
ok(/function closeChatRefRolePicker\(\)\{/.test(smart), 'closeChatRefRolePicker 已定义');
ok(/window\.openChatRefRolePicker = openChatRefRolePicker;/.test(smart), 'openChatRefRolePicker 导出到 window（内联 onclick 才找得到）');
ok(/return CHAT_REF_ROLES\[chatRefRoleIndex\(role\)\]\.label;/.test(smart), 'chatRefRoleLabel 找不到时回退「未指定」');
ok(/role:\s*r\.role \|\| null/.test(focusBody), 'buildAgentFocus 仍把 r.role 写进 references（防回退）');

console.log('[6] 角色浮层：复用 smart-popover / fixed 定位 / 无描边');
const roleFeature = smart.slice(smart.indexOf('const CHAT_REF_ROLES = ['), smart.indexOf('function chatContextImages(){'));
ok(roleFeature.length > 0, '能截取到角色 UI 片段');
ok(!/1px solid/.test(roleFeature), '角色 UI 不含 1px 描边');
ok(!/border\s*:/.test(roleFeature), '角色 UI 不含 border: 声明');
ok(/smart-popover/.test(roleFeature) && /position:fixed/.test(roleFeature), '浮层复用 .smart-popover + fixed 定位');
ok(/getBoundingClientRect/.test(roleFeature), '按徽标 getBoundingClientRect 定位');
ok(/is-active/.test(roleFeature) && /font-weight:600/.test(roleFeature), '当前项有选中态（软底 + 字重）');
ok(/Escape/.test(roleFeature) && /mousedown/.test(roleFeature), 'Esc / 点空白关闭');
ok(/chatRefRolePicker = null/.test(roleFeature) && /removeChild/.test(roleFeature), '同一时刻只开一个（先关后开）');

console.log('[7] 停靠态也要同步引用条');
ok(/if\(!chatModal\.classList\.contains\('open'\) && !chatModal\.classList\.contains\('is-docked'\)\) return;/.test(smart), 'syncChatContext 守卫同时接受 open / is-docked（停靠态也要同步引用 chip）');

console.log('');
console.log('结构引用回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(label => console.log('  ✗ ' + label));
if(fails.length) process.exitCode = 1;
