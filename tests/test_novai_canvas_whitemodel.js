#!/usr/bin/env node
'use strict';
/**
 * 图片节点「白膜处理」入口：工具条按钮 → 确认弹窗 → whitemodel 编辑 → 新版本写回。
 * 只读源码与构建产物断言，不花模型额度。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui/';
const genPanel = read(ui + 'GenPanel.tsx');
const registry = read(ui + 'editors/registry.tsx');
const types = read('novai-canvas-ui/src/canvas/canvas-next/backend/types.ts');
const novai = read('novai-canvas-ui/src/novaiBackend.ts');
const bridge = read('novai-canvas-ui/src/canvas/canvas-next/backend/bridge.ts');
const mock = read('novai-canvas-ui/src/canvas/canvas-next/backend/mockEdit.ts');
const built = read('static/novai-canvas/canvas.js');

assert(types.includes('"cutout" | "whitemodel"'), 'EditOp 增加 whitemodel');
assert(genPanel.includes('B("whitemodel", "user"'), '图片工具条挂白膜按钮');
assert(/whitemodel:\s*"白膜"/.test(genPanel), '工具条短标签是「白膜」');
assert(registry.includes('kind === "whitemodel"'), 'openEditor 分发 whitemodel');
assert(registry.includes('function WhiteModelEditor'), '白膜是就地编辑层（和涂鸦同一套）');
assert(registry.includes('data-ed="whitemodel"'), '编辑层叠在图片节点上');
assert(registry.includes('runEdit(store, n.id, "whitemodel", "白膜"'), '工具条开始后按 whitemodel 跑编辑');
assert(registry.includes('whiteModelIssue'), '结果有自动审查');
assert(registry.includes('const retry = await store.backend.editImage'), '不合格自动换模型重试一次');
assert(registry.includes('模型把画面生成成空白了'), '空白结果被拦下');
assert(registry.includes('残留原图的颜色'), '彩色残留（衣服/背景没变白）被拦下');
assert(registry.includes('data-k="whitemodel-model"'), '编辑条里可以选处理模型');
assert(registry.includes('ComboMenu') && registry.includes('选择供应商'), '模型菜单先选供应商（编辑器同款两级）');
assert(registry.includes('返回供应商列表'), '模型列表可返回供应商');
assert(registry.includes('data-model'), '再选这家供应商的具体模型');
assert(registry.includes('gemini-3-pro-image-preview'), '默认优先 APIMART 的 Gemini 图片模型');
assert(registry.includes('nano[._-]?banana'), '其次 nano banana');
assert(novai.includes('whitemodel:'), 'NOVAI 适配器有白膜提示词');
assert(/whitemodel:\s*"[^"]*人台[^"]*"/.test(novai), '提示词说明白膜 = 人台');
assert(/不偏黄/.test(novai), '提示词要求不偏黄');
assert(/身上没有衣服/.test(novai), '提示词要求去掉原图穿搭');
assert(/保持原来的姿势、动作、镜头角度和构图/.test(novai), '提示词要求保持原姿势与构图');
assert(bridge.includes('case "whitemodel"'), '桌面桥接有 whitemodel');
assert(mock.includes('req.op === "whitemodel"'), '模拟后端的本地近似效果不崩');
assert(built.includes('"whitemodel"') && built.includes("白膜"), '构建产物已包含白膜入口（act 是变量，按 op / 标签断言）');
console.log('[PASS] 图片节点「白膜处理」：工具条入口 / 就地编辑条（同涂鸦）/ whitemodel 提示词 / 桌面与模拟后端 / 构建产物');
