#!/usr/bin/env node
/* 同节点多组的执行队列：approve 后的 4 个 run_generation 要真的跑 4 次（task-25 复测修复）
   跑法：node tests/test_novai_canvas_agent_count_queue.js */
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}
const plan = load('novai-canvas-ui/src/canvas/canvas-next/agent/planParams.ts');
const runQueue = load('novai-canvas-ui/src/canvas/canvas-next/agent/runQueue.ts');
const countQueue = load('novai-canvas-ui/src/canvas/canvas-next/agent/countQueue.ts');
const modelResolve = load('novai-canvas-ui/src/canvas/canvas-next/agent/modelResolve.ts');
const spec = (batch) => ({ id: 'comfly::m', name: 'm', vendor: 'comfly', kind: 'image', tags: [], secs: 10, batch });
const step = (count) => ({ tool: 'run_generation', args: { node_id: 'n1', settings: { provider: 'comfly', model: 'm', count } } });

/* 1) 展开结果带 countGroup 标记，队列按序取出 */
let approved = plan.expandGenerationSteps([step(4)], [spec([1])]);
assert.strictEqual(approved.length, 4);
assert.deepStrictEqual(approved.map((s) => s.args.countGroup), [{ index: 1, total: 4 }, { index: 2, total: 4 }, { index: 3, total: 4 }, { index: 4, total: 4 }], '每步带 countGroup={index,total}');
let queue = plan.countGroupQueue(approved);
assert.strictEqual(queue.size, 1);
assert.deepStrictEqual(queue.get('n1').map((x) => x.index), [1, 2, 3, 4], '队列按 index 排序');
assert.deepStrictEqual(queue.get('n1').map((x) => x.settings.count), [1, 1, 1, 1], '每次 count=1');

approved = plan.expandGenerationSteps([step(4)], [spec([1, 2])]);
assert.deepStrictEqual(plan.countGroupQueue(approved).get('n1').map((x) => x.settings.count), [2, 2], 'batch=[1,2] 队列 2 项各 2 张');
approved = plan.expandGenerationSteps([step(4)], [spec([1, 2, 4])]);
assert.strictEqual(approved.length, 1, 'batch=[1,2,4] 只有 1 步');
assert.strictEqual(approved[0].args.countGroup, undefined, '单组不写标记（不拆）');

/* 2) 旧路径：没有标记的重复步骤不建队列（仍按节点去重只跑一次） */
const legacy = [step(1), step(1), step(1), step(1)];
assert.strictEqual(plan.countGroupQueue(legacy).size, 0, '没有 countGroup 标记 → 不建队列，保持旧去重行为');

/* 3) 串行执行器：桩函数数调用次数 + 顺序（等价 runAgentQueued 的队列分支） */
(async () => {
    const calls = [];
    const out = await runQueue.runQueueSequentially(queue.get('n1'), async (item) => { calls.push({ index: item.index, count: item.settings.count }); return item.index; });
    assert.deepStrictEqual(calls.map((c) => c.index), [1, 2, 3, 4], '真的按顺序跑了 4 次');
    assert.deepStrictEqual(out, [1, 2, 3, 4], '返回每次结果');
    let single = 0;
    await runQueue.runQueueSequentially([], async () => { single += 1; });
    assert.strictEqual(single, 0, '空队列不调用');

    /* 3b) 内存队列：approve 后画布刷新（节点 data 被覆盖/清掉）也不影响执行，且每组的 provider/model 原样套用 */
    const items = queue.get('n1').map((item) => ({ index: item.index, settings: { ...item.settings, provider: 'agnes', model: 'Qwen-Image-Edit' } }));
    countQueue.rememberCountQueue('canvas-1', 'n1', items.slice().reverse());   // 乱序放入也要按 index 排
    // 模拟刷新权威文档：节点 data 里的队列被清掉（内存队列不受影响）
    const refreshedNode = { id: 'n1', kind: 'image', data: {} };
    assert.deepStrictEqual(refreshedNode.data, {}, '刷新后节点 data 被清空');
    assert.deepStrictEqual(countQueue.pendingCountQueueNodeIds('canvas-1'), ['n1'], '刷新后内存队列仍然在');
    const taken = countQueue.takeCountQueue('canvas-1', 'n1');
    assert.deepStrictEqual(taken.map((x) => x.index), [1, 2, 3, 4], '取出时按 index 排序');
    assert.deepStrictEqual(taken.map((x) => [x.settings.count, x.settings.provider, x.settings.model]), [[1, 'agnes', 'Qwen-Image-Edit'], [1, 'agnes', 'Qwen-Image-Edit'], [1, 'agnes', 'Qwen-Image-Edit'], [1, 'agnes', 'Qwen-Image-Edit']], '每组带上卡片选的 provider/model');
    assert.strictEqual(countQueue.takeCountQueue('canvas-1', 'n1'), null, '取出后删除，不会重复跑');
    assert.deepStrictEqual(countQueue.pendingCountQueueNodeIds('canvas-1'), [], '跑完没有残留');
    const refreshedCalls = [];
    await runQueue.runQueueSequentially(taken, async (item) => { refreshedCalls.push({ count: item.settings.count, provider: item.settings.provider, model: item.settings.model }); return true; });
    assert.strictEqual(refreshedCalls.length, 4, '刷新后仍按 4 组各跑一次');
    assert.ok(refreshedCalls.every((c) => c.count === 1 && c.provider === 'agnes' && c.model === 'Qwen-Image-Edit'), '每次参数都用队列里的 settings');

    /* 3c) 模型 id：队列写短 id 也要能解析到正确模型（store.modelOf 兼容） */
    const agnes = { id: 'agnes-ai::agnes-image-2.0-flash', name: 'agnes-image-2.0-flash', vendor: 'agnes-ai', kind: 'image', tags: [], secs: 10, batch: [1] };
    const qwen = { id: 'modelscope::Qwen-Image-Edit', name: 'Qwen-Image-Edit', vendor: 'modelscope', kind: 'image', tags: [], secs: 10, batch: [1] };
    const list = [agnes, qwen];
    assert.strictEqual(modelResolve.resolveModelForParams(list, 'image', { model: 'agnes-image-2.0-flash', provider: 'agnes-ai' })?.id, agnes.id, '短 id + provider 能解析');
    assert.strictEqual(modelResolve.resolveModelForParams(list, 'image', { model: agnes.id })?.id, agnes.id, '完整 id 直接命中');
    assert.strictEqual(modelResolve.resolveModelForParams(list, 'image', { model: 'agnes-image-2.0-flash' })?.id, agnes.id, '只有短名也能按唯一名匹配');
    assert.strictEqual(modelResolve.resolveModelForParams(list, 'image', { model: '不存在的模型' }), undefined, '解析不到就是 undefined（不乱配）');
    assert.strictEqual(modelResolve.normalizeModelParams(list, 'image', { model: 'agnes-image-2.0-flash', provider: 'agnes-ai' }).model, agnes.id, '写队列时归一成完整 id');
    // 队列项：settings 里短 id → countGroupQueue 输出完整 id；套进节点后 modelOf 能解析
    const shortStep = { tool: 'run_generation', args: { node_id: 'n1', countGroup: { index: 1, total: 2 }, settings: { provider: 'agnes-ai', model: 'agnes-image-2.0-flash', count: 1 } } };
    const shortQueue = plan.countGroupQueue([shortStep]);
    assert.strictEqual(shortQueue.get('n1')[0].settings.model, agnes.id, '队列里 model 已归一成完整 id');
    const nodeParams = { ...shortQueue.get('n1')[0].settings };
    assert.strictEqual(modelResolve.resolveModelForParams(list, 'image', nodeParams)?.id, agnes.id, '套进节点后 modelOf 能解析到正确模型');
    const storeSrc = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/store.ts'), 'utf8');
    assert.ok(storeSrc.includes('resolveModelForParams(this.modelsOf(node.kind)'), 'store.modelOf 走兼容解析（完整 → provider::model → 短名+provider）');

    /* 4) 源码接线：autorun 读 agentRunQueue / 内存队列、逐组串行、清队列；panel 批准时写内存队列 */
    const src = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/canvas-next/agent/autorun.ts'), 'utf8');
    assert.ok(src.includes('agentRunQueue') && src.includes('runQueueSequentially(group'), 'autorun 按队列逐组执行');
    assert.ok(src.includes('delete d.agentRunQueue'), '执行后清掉队列，避免重复');
    const panel = fs.readFileSync(path.join(root, 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx'), 'utf8');
    assert.ok(panel.includes('countGroupQueue(steps)') && panel.includes('agentRunQueue:'), 'panel 批准时把队列写进本地画布（回落路径）');
    assert.ok(panel.includes('rememberCountQueue(store.state.canvasId'), 'panel 批准时把队列放进内存队列（不依赖画布持久化）');
    assert.ok(src.includes('takeCountQueue(store.state.canvasId') && src.includes('pendingCountQueueNodeIds'), 'autorun 优先读内存队列');
    assert.ok(src.includes('else if (queueOf(n).length)'), '没有内存队列时回落到 data.agentRunQueue');
    console.log('[PASS] 同节点多组：countGroup 标记 4 条 + 队列 5 条 + 串行桩 3 条 + 接线 4 条 全部通过');
})().catch((err) => { console.error(err); process.exit(1); });
