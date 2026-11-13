#!/usr/bin/env node
/* 产品收敛（只保留智能画布 / 去掉 BEAT 命名 / 下线旧智能画布新建）静态回归：
   N1. 画布列表：没有二选一选择器，新建直接 classic，标题 / 大标题「智能画布」，badge classic「智能画布」/ smart「旧版」；
   N2. 首页（V2 与旧外壳）：createCanvas 一律 classic + 🧩，打开历史 smart 仍按 kind 路由；
   N3. 素材库：classic「智能画布」/ smart「旧版智能画布」，默认分类优先 classic；
   N4. 后端分类名同步；静态页 / i18n / 旧版回退壳都没有用户可见的 BEAT 命名；
   N5. 历史画布相关文件（smart-canvas.html / smart-canvas.js）仍在，没有被删。
  跑法：node tests/test_canvas_convergence_naming.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[N1] 画布列表');
const listPage = read('web/src/pages/canvas/CanvasListPage.vue');
ok(!/pickerOpen/.test(listPage), '没有 pickerOpen（二选一选择器已删）');
ok(!/create\('smart'\)/.test(listPage), '不再有新建旧智能画布的入口');
ok(/async function create\(\)/.test(listPage) && /kind: 'classic'/.test(listPage) && /icon: '🧩'/.test(listPage), 'create() 固定 classic + 🧩');
ok(/const title = '智能画布 ' \+ new Date\(\)\.toLocaleTimeString/.test(listPage), '新建标题「智能画布 HH:MM」');
ok(/<h1 class="display">智能画布<\/h1>/.test(listPage), '页面大标题「智能画布」');
ok(/c\.kind === 'smart' \? '旧版' : '智能画布'/.test(listPage), 'badge：smart「旧版」/ classic「智能画布」');
ok(/c\.kind === 'smart' \? '\/static\/smart-canvas\.html' : '\/static\/canvas\.html'/.test(listPage), 'open() 仍按 kind 打开历史 smart 画布');

console.log('[N2] 首页');
const home = read('web/src/pages/home/HomePage.vue');
const createBody = home.slice(home.indexOf('async function createCanvas'), home.indexOf('async function launch'));
ok(/kind: 'classic'/.test(createBody) && /icon: '🧩'/.test(createBody), 'V2 createCanvas 一律 classic + 🧩');
ok(!/beat\s*\?\s*'classic'/.test(createBody), 'V2 createCanvas 不再按 ctx 分 smart / classic');
ok(/function openProject\(c\) \{ openCanvasUrl\(canvasUrl\(c\)\); \}/.test(home), 'openProject 按 kind 路由（历史 smart 仍可打开）');
const legacyHome = read('static/home.html');
const legacyCreate = legacyHome.slice(legacyHome.indexOf('function createCanvas'), legacyHome.indexOf('function launch'));
ok(/kind: 'classic'/.test(legacyCreate) && /icon: '🧩'/.test(legacyCreate) && !/kind: 'smart'/.test(legacyCreate), '旧外壳首页也新建 classic + 🧩');

console.log('[N3] 素材库');
const util = read('web/src/pages/assets/lib/util.js');
ok(/kind === 'smart' \? '旧版智能画布' : '智能画布'/.test(util), 'canvasKindLabel：classic「智能画布」/ smart「旧版智能画布」');
const canvasJs = read('web/src/pages/assets/lib/canvas.js');
ok(/'smart', name: '旧版智能画布'/.test(canvasJs) && /'classic', name: '智能画布'/.test(canvasJs), '分类回退名同步');
ok(/withAssets\.length/.test(canvasJs) && /withCanvases\.find\(c => c\.id === 'classic'\)/.test(canvasJs), '有资产 / 有画布时都优先 classic（默认落到智能画布）');

console.log('[N4] 后端 / 静态页 / i18n / 旧版回退壳');
const mainSrc = read('main.py');
ok(/\{"id": "classic", "name": "智能画布"/.test(mainSrc), '后端 classic 分类名「智能画布」');
ok(/\{"id": "smart", "name": "旧版智能画布"/.test(mainSrc), '后端 smart 分类名「旧版智能画布」');
ok(/<title>智能画布<\/title>/.test(read('static/canvas.html')), 'static/canvas.html title=智能画布');
const idx = read('static/index.html');
ok(!/智能画布BEAT/.test(idx), 'static/index.html 无「智能画布BEAT」');
ok(/data-i18n="nav.canvas">智能画布</.test(idx), '旧外壳导航文案「智能画布」');
const i18n = read('static/js/i18n/canvas.js');
ok(/"canvas\.title": \{ zh: "智能画布"/.test(i18n) && /"canvas\.newCanvas": \{ zh: "新建智能画布"/.test(i18n), '画布 i18n 文案「智能画布」');
const legacyJs = read('static/js/canvas-list.js');
ok(!/智能画布BEAT/.test(legacyJs) && !/ws-create-toggle/.test(legacyJs), '旧版 canvas-list.js 无 BEAT / 新建切换');
const legacyHtml = read('static/canvas-list.html');
ok(!/智能画布BEAT/.test(legacyHtml) && !/canvasPickerOverlay|pickerNormal|pickerSmart/.test(legacyHtml), '旧版 canvas-list.html 无 BEAT / 二选一选择器');
ok(/<h1 class="hero-title">智能画布<\/h1>/.test(legacyHtml), '旧版列表大标题「智能画布」');
ok(/function createCanvasFromPicker\(\)/.test(legacyHtml) && /kind: 'classic'/.test(legacyHtml), '旧版列表只能新建 classic');
const storeJs = read('web/src/lib/store.js');
ok(/'canvas', label: '智能画布'/.test(storeJs), 'V2 导航注册表不再写「智能画布BEAT」');
ok(/【当前是「智能画布」——/.test(mainSrc) && !/【当前是「智能画布BEAT」——/.test(mainSrc), '助手追加提示词标题「智能画布」');
ok(/'你是 NOVAI「智能画布」里的创作搭档 Agent/.test(mainSrc), '助手系统提示词首句「智能画布」');
ok(/配音 \/ 剪辑时间线节点只在智能画布里可用/.test(mainSrc), 'AgentToolError 文案「智能画布」');
const enDict = JSON.parse(read('web/src/lib/i18n-en.json'));
ok(!Object.prototype.hasOwnProperty.call(enDict, '智能画布BEAT'), 'i18n 词典里没有历史「智能画布BEAT」key');
const v2Dir = path.join(root, 'static/v2/assets');
const v2Js = fs.readdirSync(v2Dir).filter((name) => /^index-.*\.js$/.test(name)).map((name) => fs.readFileSync(path.join(v2Dir, name), 'utf8'));
ok(v2Js.length > 0 && v2Js.every((src) => !src.includes('智能画布BEAT')), 'web 构建产物里「智能画布BEAT」计数为 0（' + v2Js.length + ' 个入口 JS）');

console.log('[N5] 历史 smart 画布仍在');
ok(exists('static/smart-canvas.html'), 'static/smart-canvas.html 保留');
ok(exists('static/js/smart-canvas.js'), 'static/js/smart-canvas.js 保留');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
