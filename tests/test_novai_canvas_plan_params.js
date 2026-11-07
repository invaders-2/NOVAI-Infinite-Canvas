#!/usr/bin/env node
/* 方案卡参数（task-8）：
   1) 图片分辨率档 × 比例 → 显式 WxH，与 main.py CHAT_RATIO_SIZE_OPTIONS 同表；
   2) 生成类步骤的 args / settings 读改（模型 / 比例 / 分辨率 / 张数 / 时长）真正写回；
   3) 方案卡摘要文案；
   4) 批准给后端的 steps 用的是改后的值（静态接线） + task/run 带上当前图片模型。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');

function load(entry) {
    const result = esbuild.buildSync({
        entryPoints: [path.join(root, entry)], bundle: true, platform: 'node',
        format: 'cjs', write: false, logLevel: 'silent',
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const p = load('novai-canvas-ui/src/canvas/canvas-next/agent/planParams.ts');
const models = [
    { id: 'p1::m1', name: 'm1', vendor: 'P1', kind: 'image', ratios: ['1:1', '9:16'], sizes: ['1K', '2K'], batch: [1, 2], secs: 10, tags: [] },
    { id: 'p2::gemini-3-pro-image', name: 'gemini-3-pro-image', vendor: 'APIMart', kind: 'image', ratios: ['1:1', '3:4', '9:16', 'auto'], sizes: ['1K', '2K', '4K'], batch: [1, 2, 4], secs: 20, tags: [] },
    { id: 'v1::video-1', name: 'video-1', vendor: 'V1', kind: 'video', ratios: ['adaptive', '16:9'], durs: [5, 10], res: ['720p', '1080p'], modes: ['文生视频', '首帧'], secs: 60, tags: [] },
    { id: 'v2::video-2', name: 'video-2', vendor: 'V2', kind: 'video', ratios: ['adaptive', '16:9', '9:16'], durs: [5, 8, 10], res: ['720p'], modes: ['文生视频', '参考生视频'], secs: 60, tags: [] },
];
const step = (tool, args) => ({ tool, args, description: tool });

// ---- 1. 尺寸表 / 显式像素 ----
assert.strictEqual(p.imageSizeFor('1:1', '1K'), '1024x1024');
assert.strictEqual(p.imageSizeFor('9:16', '2K'), '1152x2048');
assert.strictEqual(p.imageSizeFor('9:16', '4K'), '2160x3840');
assert.strictEqual(p.imageSizeFor('3:4', '4K'), '2480x3312');
assert.strictEqual(p.imageSizeFor('16:9', '1K'), '1536x864');
assert.strictEqual(p.imageSizeFor('1:1', '3K'), '2880x2880', '3K 表里没有独立列，按 4K 列再由后端尺寸策略收敛');
assert.strictEqual(p.imageSizeFor('21:9', '2K'), '2048x878', '表外比例按该档长边等比换算');
assert.strictEqual(p.imageSizeFor('auto', '2K'), '', '自适应比例不写显式 size');
assert.strictEqual(p.resolutionFromSize('1152x2048', '9:16'), '2K');
assert.strictEqual(p.resolutionFromSize('2160x3840', '9:16'), '4K');
assert.strictEqual(p.resolutionFromSize('3000x3000', ''), '4K', '对不上表时按长边取最近档');
assert.strictEqual(p.tierLabel(p.tierIndex('3K')), '4K');

// ---- 2. 读参数 + 写回 ----
const img = step('generate_image', { canvas_id: 'c', prompt: '鞋', provider: 'p1', model: 'm1', ratio: '9:16', size: '1152x2048', count: 1 });
const ip = p.readPlanParams(img, 'image', models);
assert.deepStrictEqual([ip.provider, ip.model, ip.ratio, ip.resolution, ip.size, ip.count], ['p1', 'm1', '9:16', '2K', '1152x2048', 1]);
const img2 = p.patchPlanStep(img, 'image', models, { modelConfigId: 'p2::gemini-3-pro-image', ratio: '3:4', resolution: '4K', count: 2 });
assert.strictEqual(img2.args.provider, 'p2');
assert.strictEqual(img2.args.model, 'gemini-3-pro-image');
assert.strictEqual(img2.args.ratio, '3:4');
assert.strictEqual(img2.args.size, '2480x3312');
assert.strictEqual(img2.args.count, 2);
assert.strictEqual(img.args.provider, 'p1', '写回不改原步骤');
assert.notStrictEqual(img2.args, img.args, '写回是深拷贝');
assert.strictEqual(p.readPlanParams(img2, 'image', models).resolution, '4K', '改完再读一致');

const auto = p.patchPlanStep(img, 'image', models, { modelConfigId: 'p2::gemini-3-pro-image', ratio: 'auto' });
assert.strictEqual('size' in auto.args, false, '自适应比例清掉旧 size');

const vid = step('generate_video', { canvas_id: 'c', prompt: '短片', provider: 'v1', model: 'video-1', ratio: 'adaptive', duration: 5 });
const vp = p.readPlanParams(vid, 'video', models);
assert.deepStrictEqual([vp.provider, vp.model, vp.ratio, vp.duration, vp.resolution], ['v1', 'video-1', 'adaptive', 5, '720p']);
const vid2 = p.patchPlanStep(vid, 'video', models, { modelConfigId: 'v2::video-2', ratio: '16:9', duration: 10, resolution: '720p' });
assert.deepStrictEqual([vid2.args.provider, vid2.args.model, vid2.args.ratio, vid2.args.duration], ['v2', 'video-2', '16:9', 10]);
assert.strictEqual('resolution' in vid2.args, false, 'generate_video 后端 schema 没有分辨率参数，不能写进去假装生效');
assert.strictEqual('size' in vid2.args, false, '视频不写图片 size');

// ---- 2b. 视频生成方式：ModelSpec.modes → 接口值写回 / 纠正 / 摘要 ----
assert.deepStrictEqual(p.videoModeOptions(models[2]), [{ value: 'text_to_video', label: '文生视频' }, { value: 'image_to_video', label: '首帧' }], '方式选项来自 ModelSpec.modes');
const modeStep = step('generate_video', { canvas_id: 'c', prompt: '短片', provider: 'v2', model: 'video-2', ratio: '16:9', duration: 8, mode: 'reference_to_video' });
const modeRead = p.readPlanParams(modeStep, 'video', models);
assert.strictEqual(modeRead.mode, 'reference_to_video', '读 args.mode 接口值');
assert.strictEqual(p.planParamsSummary([modeStep], models), '用 V2 · video-2 以参考生视频出 8s 16:9 视频', '摘要体现方式');
const modeAuto = step('generate_video', { canvas_id: 'c', provider: 'v2', model: 'video-2', ratio: '16:9', duration: 8 });
assert.strictEqual(p.readPlanParams(modeAuto, 'video', models).mode, '', '没给 mode = 自动选择');
const unsupportedMode = step('generate_video', { canvas_id: 'c', provider: 'v1', model: 'video-1', ratio: '16:9', duration: 5, mode: 'reference_to_video' });
assert.strictEqual(p.readPlanParams(unsupportedMode, 'video', models).mode, 'text_to_video', '不支持的方式读成第一个支持项');
const modePatched = p.patchPlanStep(modeAuto, 'video', models, { mode: '参考生视频' });
assert.strictEqual(modePatched.args.mode, 'reference_to_video', '中文方式也写回接口值');
const modeCleared = p.patchPlanStep(modeStep, 'video', models, { mode: '' });
assert.strictEqual('mode' in modeCleared.args, false, '自动选择清掉 args.mode');
const switchedMode = p.patchPlanStep(modeStep, 'video', models, { modelConfigId: 'v1::video-1' });
assert.strictEqual(switchedMode.args.mode, 'text_to_video', '换到不支持当前方式的模型 → 纠正为第一个支持项');
const modeSummaryAuto = p.planParamsSummary([modeAuto], models);
assert.strictEqual(modeSummaryAuto, '用 V2 · video-2 出 8s 16:9 视频', '自动方式不硬写“自动”以外的词');

const batch = step('batch_generate', { canvas_id: 'c', rows: ['a', 'b', 'c'], media: 'video', settings: { provider: 'v1', model: 'video-1', ratio: 'adaptive', duration: 5 } });
assert.strictEqual(p.planStepKind(batch, models), 'video');
assert.strictEqual(p.planStepScope(batch), 'settings');
const batch2 = p.patchPlanStep(batch, 'video', models, { modelConfigId: 'v2::video-2', ratio: '16:9', duration: 8, resolution: '720p' });
assert.strictEqual(batch2.args.settings.provider, 'v2');
assert.strictEqual(batch2.args.settings.model, 'video-2');
assert.strictEqual(batch2.args.settings.ratio, '16:9');
assert.strictEqual(batch2.args.settings.duration, 8);
assert.strictEqual(batch2.args.settings.resolution, '720p');
assert.deepStrictEqual(batch2.args.rows, ['a', 'b', 'c'], '表格行原样保留');
assert.strictEqual('count' in batch2.args.settings, false, '批量张数=行数，不写 count');

const batchImg = step('batch_generate', { canvas_id: 'c', rows: ['a', 'b'], settings: {} });
assert.strictEqual(p.planStepKind(batchImg, models), 'image');
const batchImg2 = p.patchPlanStep(batchImg, 'image', models, { modelConfigId: 'p2::gemini-3-pro-image', ratio: '1:1', resolution: '2K' });
assert.strictEqual(batchImg2.args.settings.resolution, '2k', 'settings 作用域写小写档位');
assert.strictEqual(batchImg2.args.settings.size, '2048x2048');
assert.strictEqual('count' in batchImg2.args.settings, false);

// ---- 3. 摘要 ----
const summaryImg = p.planParamsSummary([img2], models);
assert.strictEqual(summaryImg, '用 APIMart · gemini-3-pro-image 出 2 张 3:4 4K');
const summaryVideo = p.planParamsSummary([vid2], models);
assert.strictEqual(summaryVideo, '用 V2 · video-2 出 10s 16:9 视频');
const summaryBatch = p.planParamsSummary([batchImg2], models);
assert.strictEqual(summaryBatch, '按 2 行批量出图（APIMart · gemini-3-pro-image，1:1 2K）');
const summaryMixed = p.planParamsSummary([img2, vid2], models);
assert.ok(summaryMixed.includes('；') && summaryMixed.includes('视频'), '多生成步骤用分号串起来');
assert.strictEqual(p.planParamsSummary([step('update_node', {})], models), '', '没有生成步骤时为空白，卡片退回后端 summary');

// ---- 4. 接线：批准用改后的 steps；task/run 带图片模型；卡片显示 assumptions/reason ----
const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
const card = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/TaskPlanCard.tsx'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/novaiBridge.ts'), 'utf8');
const types = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/backend/types.ts'), 'utf8');
assert.ok(panel.includes('async function approvePlan(m: AgentMsg, approved?:') && panel.includes('approved && approved.length ? approved'), '执行用卡片回写后的 steps');
assert.ok(panel.includes('onApprovePlan={(steps) => void approvePlan(m, steps)}') && card.includes('onApprove(approvedSteps(steps, models))'), '卡片把 draft steps 交回执行（批准前按模型上限归一）');
assert.ok(panel.includes('imageProvider, imageModel') && bridge.includes('image_provider: String(context.imageProvider || "")') && bridge.includes('image_model: String(context.imageModel || "")'), 'task/run 把当前图片模型传给后端');
assert.ok(types.includes('assumptions?: string[] | string') && types.includes('reason?: string') && card.includes('plan.assumptions') && card.includes('plan.reason'), 'assumptions / reason 透出到方案卡');
assert.ok(card.includes('planParamsSummary(steps, models)') && card.includes('plan-params'), '卡片渲染参数区与摘要');
assert.ok(card.includes('videoModeOptions(spec)') && card.includes('自动选择') && card.includes('change(index, { mode:'), '方案卡视频方式下拉来自 ModelSpec，并写回 args.mode');

console.log('[PASS] 方案卡参数：尺寸换算 / 回写 steps / 摘要 / 模型透传（' + '共 4 组' + '）');