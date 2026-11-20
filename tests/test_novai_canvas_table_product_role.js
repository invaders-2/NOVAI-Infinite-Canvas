#!/usr/bin/env node
'use strict';
/**
 * 表格「产品替换」的任务提示词：两组素材的角色分工必须写进 tablePrompt。
 *   待替换组（场景 / 白膜图）= 只提供机位、构图、光影、背景；
 *   产品组 = 新品外观的唯一权威；
 *   待替换组里的占位商品（白膜人台 / 旧商品）造型、缝线、鞋底花纹、鞋带结构、logo、装饰不得出现在成品里；
 *   每行文案必须显式写清这层关系（行文案会直接进图像生成的提示词）。
 * 只读 tablePrompt 的真实输出，不花模型额度。
 */
const assert = require('assert');
const path = require('path');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputText ? result.outputText : result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const table = load('novai-canvas-ui/src/canvas/canvas-next/table.ts');
const ok = (v, msg) => assert.ok(v, msg);
const has = (text, key, msg) => ok(text.includes(key), msg || ('tablePrompt 必须写明「' + key + '」'));

/* 产品替换任务：两组素材（待替换的场景图 / 白膜图 + 要换上去的产品图） */
const prompt = table.tablePrompt('把参考图里的产品替换成白底图的产品', 'table', 7,
    [{ name: '参考图', count: 2 }, { name: '白底多角度', count: 5 }]);

// 待替换组只给机位 / 构图 / 光影 / 背景
has(prompt, '待替换组（场景 / 白膜图）只提供机位、构图、光影和背景', '待替换组只提供机位 / 构图 / 光影 / 背景');

// 占位商品（白膜人台 / 旧商品）不得保留造型与细节
has(prompt, '占位商品（白膜人台 / 旧商品）', '点名占位商品是白膜人台 / 旧商品');
has(prompt, '造型、缝线、鞋底花纹、鞋带结构、logo、装饰', '占位商品的造型 / 缝线 / 鞋底花纹 / 鞋带结构 / logo / 装饰逐个点名');
has(prompt, '一律不允许保留', '占位商品在成品里一律不允许保留');
has(prompt, '必须被新产品完全替换掉', '占位商品必须被新产品完全替换');

// 产品组是新品外观的唯一权威
has(prompt, '是新品外观的唯一权威', '产品组是新品外观的唯一权威');
has(prompt, '形状、比例、配色、材质和细节必须和产品组一致', '成品里新品的形状 / 比例 / 配色 / 材质 / 细节必须与产品组一致');
has(prompt, '不能从待替换组里的占位商品上推', '新品外观不能从占位商品上推');

// 每行文案显式写清关系，不许「参考图 1」占位
has(prompt, '每一行文案都要把这两层关系显式写出来', '每行文案必须显式写清两组关系');
has(prompt, '不要只写「参考图 1」这类占位说明', '不许只写「参考图 1」这类占位说明');
has(prompt, '行文案会直接进入图像生成的提示词', '说明行文案会直接进图像生成的提示词');

// 规则不外扩：明确只对「产品替换」这类任务生效
has(prompt, '只有「产品替换」这类任务用上面这几条角色规则', '角色规则只作用于产品替换任务');
has(prompt, '其它任务（分镜、文案、多角度）不要套用产品替换的说法', '明确不把产品替换规则扩到其它任务');

// 原有契约没被挤掉
has(prompt, 'inputGroups', 'inputGroups 契约仍在');
has(prompt, 'every-row', 'every-row 说明仍在');

console.log('[PASS] 表格「产品替换」任务提示词：待替换组只给机位/构图/光影/背景 + 占位商品不得保留 + 产品组是唯一权威 + 行文案显式写清关系');
