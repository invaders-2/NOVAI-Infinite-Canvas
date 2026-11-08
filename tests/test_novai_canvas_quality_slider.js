#!/usr/bin/env node
/* 2026-11-08：图片「质量」档改成和「模型强度」同款的 EffortSlider 滑块。
   契约：GenPanel 的 paramPop(..., "quality", ...) 分支不再是一列 data-quality 按钮，
   档位来自 qualityChoices(model)（auto/默认 + low/medium/high/xhigh/max），value 当 levels、label 当 labels，
   当前值 isQualityDefault ? 第一档 : 当前值；标题「质量」、更低/更高、info「档位越高，画质越精细，耗时越长」、
   无推荐档（recommended=null）、无恢复默认（showRestore=false）；拖动即时 set({quality}) 不清空档位、不关弹层；
   弹层 class quality-pop：304 / 14px 圆角 / 6px 内距 / 86% 磨砂玻璃 + blur 42px / 零 border / 零 inset。
   EffortSlider 新增 labels / hint / leftLabel / rightLabel / recommended(null) / showRestore，默认模型强度行为不变。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const gen = read('novai-canvas-ui/src/canvas/canvas-next/ui/GenPanel.tsx');
const slider = read('novai-canvas-ui/src/canvas/canvas-next/ui/EffortSlider.tsx');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
const effortCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/effort-slider.css');
const model = read('novai-canvas-ui/src/canvas/canvas-next/model.ts');

const qualityStart = gen.indexOf('if (k === "quality") return pop(');
const qualityEnd = gen.indexOf('if (k === "thinking") return pop(');
assert.ok(qualityStart > 0 && qualityEnd > qualityStart, 'GenPanel 有独立的 quality 分支');
const quality = gen.slice(qualityStart, qualityEnd);

// ---- GenPanel：质量分支换成 EffortSlider ----
assert.ok(gen.includes('import { EffortSlider } from "./EffortSlider";'), 'GenPanel 引入 EffortSlider');
assert.ok(quality.includes('<EffortSlider'), '质量分支用 EffortSlider');
assert.ok(!quality.includes('data-quality') && !quality.includes('>质量 · '), '质量分支不再渲染 data-quality 按钮列表 / 旧标题');
assert.ok(!/<button[^>]*data-quality/.test(gen), '全文件不再有 data-quality 按钮');
assert.ok(quality.includes('qualityChoices(store.modelOf(node))'), '档位来自 qualityChoices(model)');
assert.ok(quality.includes('levels={choices.map((choice) => choice.value)}'), 'choices 的 value 作为 levels');
assert.ok(quality.includes('labels={labels}') && quality.includes('const labels = Object.fromEntries(choices.map((choice) => [choice.value, choice.label]));'), 'choice.label 作为 labels');
assert.ok(quality.includes('label="质量"'), '标题「质量」');
assert.ok(quality.includes('hint="档位越高，画质越精细，耗时越长"'), 'info 提示「档位越高，画质越精细，耗时越长」');
assert.ok(quality.includes('leftLabel="更低"') && quality.includes('rightLabel="更高"'), '左右文案「更低 / 更高」');
assert.ok(quality.includes('recommended={null}'), '质量没有推荐档（不显示「推荐」）');
assert.ok(quality.includes('showRestore={false}'), '自动/默认就是第一档，不显示「恢复默认」');
assert.ok(quality.includes('isQualityDefault(curQuality) ? choices[0].value : curQuality'), '默认/自动取 choices 第一档，否则用当前值');
assert.ok(quality.includes('!level || level.toLowerCase() === "auto" ? undefined : level'), 'auto / 空串 → 清空 quality，其它 → 写入档位');
assert.ok(!quality.includes('close()'), '拖动即时生效，不关闭弹层（点外面才关）');
assert.ok(quality.trimEnd().endsWith('}, "quality-pop");'), '质量弹层用 quality-pop class');

// ---- pop() helper 增加可选 class ----
assert.ok(gen.includes('const pop = (render: (close: () => void) => React.ReactNode, cls?: string) => openPop(anchor'), 'pop() 增加可选 class 参数');
assert.ok(gen.includes('  </>, "up", "left", cls);'), 'pop() 把 class 透传给 openPop');

// ---- model.ts：auto 第一档 / 空串「默认」 ----
assert.ok(model.includes('? { value: "auto", label: "自动（默认）", isDefault: true }'), 'caps 有 auto 时第一档 value=auto、label=自动（默认）');
assert.ok(model.includes(': { value: "", label: "默认", isDefault: true };'), 'caps 没有 auto 时第一档 value=""、label=默认');
assert.ok(model.includes('isDefault: false'), '其余档位不是默认档');

// ---- EffortSlider：新增 props（默认值保持模型强度原行为） ----
assert.ok(/recommended\?: string \| null;/.test(slider), 'recommended 允许 null');
assert.ok(slider.includes('labels?: Record<string, string>;'), 'labels prop');
assert.ok(slider.includes('hint?: string;'), 'hint prop');
assert.ok(slider.includes('leftLabel?: string;') && slider.includes('rightLabel?: string;'), 'leftLabel / rightLabel prop');
assert.ok(slider.includes('showRestore?: boolean;'), 'showRestore prop');
assert.ok(slider.includes('labels = EFFORT_LABEL, hint = "越高越慢，推理越深"'), 'labels / hint 默认值 = 模型强度文案');
assert.ok(slider.includes('leftLabel = "更快", rightLabel = "更强", showRestore = true'), '左右文案 / 恢复默认默认值不变');
assert.ok(slider.includes('recommended = EFFORT_RECOMMENDED'), 'recommended 默认仍是 mid');
assert.ok(slider.includes('if (recommended == null) return -1;'), 'recommended=null → recommendedIndex 返回 -1');
assert.ok(slider.includes('{showRestore && explicit ?'), 'showRestore=false 时不渲染恢复默认');
assert.ok(slider.includes('labelOf(localValue, labels)'), '标题值用 labels 映射');
assert.ok(slider.includes('labelOf(levels[index], labels)'), 'aria-valuetext 用 labels 映射');
assert.ok(slider.includes('aria-label={"说明：" + hint}') && slider.includes('aria-describedby={tipId}') && slider.includes('role="tooltip"') && slider.includes('{hint}</span>'), 'info 图标用 hint 渲染项目内 tooltip（aria-describedby 关联）');
assert.ok(!slider.includes('title={hint}'), '不再用原生 title（延迟 / 样式不可控）');
assert.ok(slider.includes('onMouseEnter={() => setTip(true)}') && slider.includes('onMouseLeave={() => setTip(false)}') && slider.includes('onFocus={() => setTip(true)}') && slider.includes('onBlur={() => setTip(false)}'), 'hover / focus 显示，移出 / 失焦隐藏');
assert.ok(slider.includes('<span>{leftLabel}</span><span>{rightLabel}</span>'), '左右文案来自 props');
assert.ok(slider.includes('aria-label={label}') && slider.includes('data-effort-slider') && slider.includes('role="slider"'), '标题 / ARIA / role 仍用 label');
assert.ok(slider.includes('if (!show) return null') && slider.includes('levels.length > 1'), 'levels 只有 1 档仍不渲染');
// 交互不回归
assert.ok(slider.includes('setPointerCapture(event.pointerId)') && slider.includes('onPointerMove') && slider.includes('onLostPointerCapture'), '拖动 / 指针捕获保持');
assert.ok(slider.includes('"ArrowRight"') && slider.includes('"ArrowLeft"') && slider.includes('"Home"') && slider.includes('"End"'), '键盘 ←/→/Home/End 保持');
assert.ok(slider.includes('createEffortFill(canvas') && slider.includes('effortFallback(level)'), '动态 WebGL 填充 / 回退保持');
assert.ok(effortCss.includes('transition: width .5s var(--ev-spring)') && effortCss.includes('left .5s var(--ev-spring)'), '500ms spring 保持');
assert.ok(effortCss.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion 保持');

// ---- CSS：#pop.quality-pop 304 / 14px / 6px / 磨砂玻璃 / 零 border / 零 inset ----
const qualityRule = (css.match(/\.cn-root #pop\.quality-pop\{([^}]*)\}/) || [])[1];
assert.ok(qualityRule, '有 #pop.quality-pop 样式');
assert.ok(/width:304px;min-width:304px;max-width:304px;padding:6px;/.test(qualityRule), '宽 304 / 内距 6px');
assert.ok(/border-radius:14px;border:0;/.test(qualityRule), '14px 圆角 / 零 border');
assert.ok(/background:color-mix\(in srgb,var\(--panel\) 86%,transparent\);/.test(qualityRule), '86% 磨砂玻璃底');
assert.ok(/-webkit-backdrop-filter:blur\(42px\) saturate\(180%\);backdrop-filter:blur\(42px\) saturate\(180%\);/.test(qualityRule), 'blur 42px');
assert.ok(qualityRule.includes('box-shadow:var(--glass-shadow);'), '同款 glass shadow');
assert.ok(!/inset/.test(qualityRule) && !/border:\s*[1-9]/.test(qualityRule), '零 border / 零 inset');

// ---- info「?」tooltip 样式 + 弹层不裁切 ----
const infoWrap = (effortCss.match(/\.cn-root \.ev-info-wrap \{[^}]*\}/) || [])[0];
assert.ok(infoWrap && /position:\s*relative/.test(infoWrap) && /display:\s*inline-flex/.test(infoWrap) && /flex:\s*none/.test(infoWrap), '.ev-info-wrap 相对定位 / inline-flex / flex:none');
const tip = (effortCss.match(/\.cn-root \.ev-tip \{[^}]*\}/) || [])[0];
assert.ok(tip && /position:\s*absolute/.test(tip) && /right:\s*-2px/.test(tip) && /bottom:\s*calc\(100% \+ 8px\)/.test(tip), '.ev-tip 绝对定位在图标右上方');
assert.ok(tip && /max-width:\s*220px/.test(tip) && /font-size:\s*11\.5px/.test(tip) && /line-height:\s*1\.5/.test(tip) && /padding:\s*7px 9px/.test(tip) && /border-radius:\s*9px/.test(tip), '.ev-tip 220px / 11.5px / 1.5 / 7px 9px / 9px');
assert.ok(tip && /background:\s*var\(--s3\)/.test(tip) && /color:\s*var\(--fg\)/.test(tip) && /box-shadow:/.test(tip) && /border:\s*0/.test(tip) && !/inset/.test(tip), '.ev-tip 实底 var(--s3) + var(--fg) / 柔和投影 / 零 border / 零 inset');
assert.ok(tip && /opacity:\s*0/.test(tip) && /visibility:\s*hidden/.test(tip) && /transform:\s*translateY\(2px\)/.test(tip) && /pointer-events:\s*none/.test(tip) && /z-index:\s*6/.test(tip) && /transition:[^;]*\.12s/.test(tip), '.ev-tip 默认隐藏 / 不挡指针 / z-index 6 / .12s 过渡');
assert.ok(effortCss.includes('.cn-root .ev-tip[data-show] { opacity: 1; visibility: visible; transform: translateY(0); }'), '[data-show] 才显示 tooltip');
assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.cn-root \.ev-tip \{ transition: none; \}/.test(effortCss), 'reduced-motion 关 tooltip 过渡');
assert.ok(qualityRule.includes('overflow:visible;'), '质量弹层 overflow:visible（tooltip 不被裁切）');
assert.ok(/\.cn-root #pop\.think-pop\{[^}]*overflow:visible;/.test(css), '思考强度弹层 overflow:visible（tooltip 不被裁切）');
assert.ok(css.includes('.cn-root #pop.model-pop{overflow:visible}'), '模型菜单弹层保持 overflow:visible');

// ---- 默认模型强度行为仍成立（回归护栏） ----
assert.ok(slider.includes('export const EFFORT_LABEL') && slider.includes('low: "低"') && slider.includes('mid: "中"') && slider.includes('max: "Max"'), '模型强度档位文案不变');
assert.ok(slider.includes('export const EFFORT_RECOMMENDED = "mid"'), '推荐档仍是 mid');
assert.ok(slider.includes('onChange("")') && slider.includes('恢复默认'), '恢复默认按钮仍在（默认显示）');
assert.ok(/\.cn-root #pop\.think-pop\{[^}]*width:304px/.test(css), '模型强度弹层 think-pop 仍是 304');

console.log('[PASS] 图片「质量」档滑块：qualityChoices → EffortSlider（levels/labels/label=质量/更低·更高/hint/recommended=null/showRestore=false）、auto 第一档、auto·空串清空 quality、quality-pop 304 + 磨砂玻璃 + 零 border/inset；模型强度默认行为不变');
