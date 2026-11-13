#!/usr/bin/env node
/* 2026-11-13：视频时长从「一排秒数按钮」改成拖动条（DurationSlider）。
   契约：
   1. 档位来自后端能力表 ModelSpec.durs（/api/model-caps）：-1 排最左、标签「自动」；
      正数按秒升序；只有一档 / 没有档位时不渲染滑轨，给只读说明（veo3.1 固定 8 秒这类）。
   2. 轨道 / 拇指 / 键盘 / 吸附全部复用 EffortSlider（usage="duration"），视觉与模型强度滑块一致：
      28px 胶囊软底、零边框零发丝线、38×24 白色拇指、500ms spring。
   3. 「生成时长」不再有任何秒数按钮：GenPanel 里不允许再出现 data-vopt="dur:…" 的 chip。
   4. 时长滑块不写 data-think-level（否则和模型强度 / 记忆面板的选择器串台）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const esbuild = require('../novai-canvas-ui/node_modules/esbuild');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function load(entry) {
    const result = esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    return module.exports;
}

const model = load('novai-canvas-ui/src/canvas/canvas-next/model.ts');

// ---- 1. 档位映射（纯函数）----
const plain = model.durationSliderLevels([3, 4, 5, 10, 30]);
assert.deepStrictEqual(plain.levels, ['3', '4', '5', '10', '30'], '正数档按秒升序（后端已排序）');
assert.strictEqual(plain.labels['30'], '30s', '标签带 s');
assert.ok(!plain.levels.includes('-1'), '没声明 -1 就没有「自动」档');

const withAuto = model.durationSliderLevels([-1, 4, 5, 6]);
assert.deepStrictEqual(withAuto.levels, ['-1', '4', '5', '6'], '-1 排最左');
assert.strictEqual(withAuto.labels['-1'], '自动', '-1 显示「自动」');
assert.strictEqual(withAuto.labels['4'], '4s');

assert.deepStrictEqual(model.durationSliderLevels([-1]).levels, ['-1'], '只有自动的模型只有一档（走只读说明）');
assert.deepStrictEqual(model.durationSliderLevels([8]).levels, ['8'], '固定 8 秒只有一档');
assert.deepStrictEqual(model.durationSliderLevels(undefined).levels, [], '没有档位声明 → 空（保持「由模型自动决定」）');
assert.deepStrictEqual(model.durationSliderLevels([5, 10]).levels, ['5', '10'], 'kling-video-o1 那种只有 5/10');

// ---- 2. 组件接线 ----
const dur = read('novai-canvas-ui/src/canvas/canvas-next/ui/DurationSlider.tsx');
const slider = read('novai-canvas-ui/src/canvas/canvas-next/ui/EffortSlider.tsx');
const panel = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');

assert.ok(dur.includes('export function DurationSlider('), 'DurationSlider 组件存在');
assert.ok(dur.includes('<EffortSlider') && dur.includes('usage="duration"'), '复用 EffortSlider（usage=duration）');
assert.ok(dur.includes('durationSliderLevels(model.durs)'), '档位来自能力表 durs');
assert.ok(dur.includes('recommended={null}') && dur.includes('showRestore={false}'), '时长没有「推荐档 / 恢复默认」');
assert.ok(dur.includes('data-dur-note="fixed"') && dur.includes('该模型只有这一档'), '单档模型给只读说明');
assert.ok(dur.includes('data-dur-note="auto"') && dur.includes('由模型自动决定'), '没有档位声明的模型保持原文案');
assert.ok(dur.includes('store.patchGen(node.id') && dur.includes('dur: Number(level)'), '拖动结果写回 VideoParams.dur');
assert.ok(dur.includes('useS((s) => s.doc.nodes.find((x) => x.id === node.id))'), '订阅节点，拖动时数值跟手（弹层不会因父组件重渲染）');

// ---- 3. GenPanel：生成时长不再有按钮 ----
assert.ok(!panel.includes('data-vopt="dur:'), '「生成时长」不再有秒数按钮（data-vopt="dur:…"）');
assert.ok(!panel.includes('data-vopt={"dur:" + d}'), '旧的秒数 chip 生成逻辑已删除');
assert.strictEqual((panel.match(/<DurationSlider/g) || []).length, 2, '合并参数浮层与旧时长浮层都用拖动条');
assert.ok(panel.includes('<div className="vset-dur" data-vset-dur>'), '参数浮层里有拖动条容器');
assert.ok(!panel.includes('durationTiers('), 'GenPanel 不再自己算时长档位（统一走 DurationSlider）');

// ---- 4. 滑块复用与隔离 ----
assert.ok(slider.includes('usage?: "effort" | "duration"'), 'EffortSlider 增加 usage 用途标记');
assert.ok(slider.includes('if (usage === "duration") return ('), '时长用途单独返回外层（不写 data-think-level）');
assert.ok(slider.includes('data-dur-slider') && slider.includes('data-think-level={localValue || "default"}'), '模型强度保留 data-think-level，时长用 data-dur-slider');
assert.ok(slider.includes('if (event.button !== 0 || disabled) return;') && slider.includes('if (disabled) return;\n    let next = index;'), 'disabled 时不响应拖动 / 键盘');
assert.ok(slider.includes('data-disabled={disabled ? "" : undefined}'), 'disabled 状态可被样式与测试读到');

// ---- 4a. 蓝色 + 小号（用户要求：只要蓝，不要紫；比模型强度那条小一圈）----
assert.ok(dur.includes('size="sm"') && dur.includes('tone="blue"'), '时长滑块用小号 + 纯蓝');
assert.ok(slider.includes('size?: "md" | "sm"') && slider.includes('tone?: "default" | "blue"'), 'EffortSlider 支持尺寸 / 配色两档');
assert.ok(slider.includes('data-size={size}') && slider.includes('data-tone={tone}'), '尺寸 / 配色落到 DOM（data-size / data-tone）');
assert.ok(slider.includes('tone === "blue"') && slider.includes('blueFallback(level)'), '蓝色直接用 CSS 渐变');
const fill = read('novai-canvas-ui/src/canvas/canvas-next/ui/effort-fill.ts');
assert.ok(fill.includes('export const BLUE_FALLBACKS') && fill.includes('export const blueFallback'), '纯蓝渐变表存在');
const blueBlock = fill.slice(fill.indexOf('BLUE_FALLBACKS: string[]'), fill.indexOf('export const effortTier'));
for (const purple of ['#8b5cf6', '#a855f7', '#818cf8']) assert.ok(!blueBlock.includes(purple), '蓝表不含紫色 ' + purple);
assert.ok(!/purple/i.test(blueBlock), '蓝表没有 purple');
assert.ok(slider.includes('if (tone === "blue") return;'), '蓝色不建 WebGL 上下文（小滑块常驻 canvas 不值得）');

const smallCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/effort-slider.css');
assert.ok(/\.cn-root \.ev-slider\[data-size="sm"\] \.ev-track \{ height: 20px; \}/.test(smallCss), '小号轨道 20px（原 28px）');
assert.ok(/\[data-size="sm"\] \.ev-thumb \{[^}]*width: 30px; height: 18px/.test(smallCss), '小号拇指 30×18（原 38×24）');
assert.ok(/\[data-size="sm"\] \.ev-dot \{ width: 3px; height: 3px; \}/.test(smallCss), '小号档位点 3px');
assert.ok(/\[data-size="sm"\] \.ev-value \{ font-size: 11.5px; \}/.test(smallCss), '小号数值字号更小');

// ---- 5. 样式：零边框、只读说明 ----
assert.ok(/\.cn-root \.vset-dur\{padding:2px 0 4px\}/.test(css), '拖动条容器间距');
assert.ok(/\.cn-root \.ds-note\{[^}]*color:var\(--fg3\)/.test(css), '只读说明用次级文字色');
assert.ok(/\.cn-root \.ev-slider\[data-disabled\] \{ opacity: \.55; \}/.test(read('novai-canvas-ui/src/canvas/canvas-next/ui/effort-slider.css')), '只读态降透明');
for (const block of css.match(/\.cn-root \.ds-note\{[^}]*\}/g) || []) {
    assert.ok(!/border/.test(block), '只读说明不画边框（设计硬规则）：' + block);
}

console.log('[PASS] 视频时长拖动条：档位映射（-1=自动 / 正数秒 / 单档只读）+ GenPanel 无秒数按钮 + 复用 EffortSlider（data-dur-slider、disabled、零边框）');
