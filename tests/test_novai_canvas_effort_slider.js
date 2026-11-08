#!/usr/bin/env node
/* 2026-11-08：动态模型强度（Effort）滑块落到画布助手 + 首页模型菜单。
   契约：React <EffortSlider>（画布）与 Vue <EffortSlider>（首页）同款交互和版式；
   左侧填充是 WebGL 流体渐变（无 WebGL 回退 CSS 渐变，卸载销毁上下文），覆盖拇指及其四周 2px（宽度 = 42 + share·(W-42)），
   配色「近白 → 中段蓝 → 高档/极高/Max 右端紫」；
   28px 完整胶囊轨道（999px）/ 4px 档位点（两端 21px，点中心 = 21 + i·(W-42)/(n-1)）/ 38×24 白色胶囊拇指（两端各留 2px、只有轻投影，无 0 0 0 ring / 无 --ev-ring / 无蓝边）/ 「更快·更强」/「推荐」/「默认 + 恢复默认」；
   拖动（pointer capture）、点击跳档、←/→/Home/End、500ms spring、prefers-reduced-motion；
   一级模型菜单接入（304 / 300），档位来自 model_caps[模型].think，和画布共用 canvas-next:agent:think。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const react = read('novai-canvas-ui/src/canvas/canvas-next/ui/EffortSlider.tsx');
const fill = read('novai-canvas-ui/src/canvas/canvas-next/ui/effort-fill.ts');
const css = read('novai-canvas-ui/src/canvas/canvas-next/ui/effort-slider.css');
const vue = read('web/src/components/EffortSlider.vue');
const vueFill = read('web/src/lib/effortFill.js');
const agentPanel = read('novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx');
const menuCss = read('novai-canvas-ui/src/canvas/canvas-next/ui/canvas-next.css');
const home = read('web/src/pages/home/HomePage.vue');
const canvasHtml = read('static/canvas.html');

// ---- React 组件：结构 / 文案 / 档位 / 推荐 / 默认 ----
assert.ok(react.includes('export function EffortSlider('), 'React EffortSlider 组件存在');
assert.ok(react.includes('export const EFFORT_LABEL') && react.includes('low: "低"') && react.includes('max: "Max"'), '档位中文：低/中/高/极高/Max');
assert.ok(react.includes('"默认"') && react.includes('labelOf(localValue, labels)'), '空串 = 默认档位标题（labels 映射档位文案）');
assert.ok(react.includes('推荐') && react.includes('recommendedIndex'), '推荐档位小字（mid，没有则第二档）');
assert.ok(react.includes('更快') && react.includes('更强'), '轨道上方「更快 / 更强」');
assert.ok(react.includes('恢复默认') && react.includes('onChange("")'), '恢复默认按钮清空档位');
assert.ok(react.includes('越高越慢，推理越深'), 'info 说明文案「越高越慢，推理越深」仍是默认 hint');
assert.ok(react.includes('className="ev-info-wrap"'), 'info button 外层 span.ev-info-wrap（tooltip 定位基准）');
assert.ok(react.includes('const tipId = useId();') && react.includes('id={tipId}'), 'tooltip id 用 React useId 生成');
assert.ok(react.includes('role="tooltip"') && react.includes('className="ev-tip"') && react.includes('{hint}</span>'), '渲染 role=tooltip 的 .ev-tip，内容 = hint');
assert.ok(react.includes('aria-describedby={tipId}') && react.includes('aria-label={"说明：" + hint}'), 'button aria-label + aria-describedby 指向 tooltip');
assert.ok(!react.includes('title={hint}') && !react.includes('className="ev-info" title='), '去掉原生 title（延迟 / 样式不可控）');
assert.ok(react.includes('onMouseEnter={() => setTip(true)}') && react.includes('onMouseLeave={() => setTip(false)}') && react.includes('onFocus={() => setTip(true)}') && react.includes('onBlur={() => setTip(false)}'), '鼠标移入 / 键盘 focus 显示，移出 / 失焦隐藏');
assert.ok(react.includes('data-show={tip ? "" : undefined}') && react.includes('const [tip, setTip] = useState(false);'), 'data-show 控制 tooltip 显隐');
assert.ok(react.includes('levels.length > 1') && react.includes('if (!show) return null'), 'data 未就绪 / 只有一档时不渲染');

// ---- React 交互：pointer capture / 点击跳档 / 键盘 / 吸附 / 过渡 ----
assert.ok(react.includes('role="slider"') && react.includes('tabIndex={0}'), 'role=slider + 可聚焦');
assert.ok(react.includes('setPointerCapture(event.pointerId)') && react.includes('onPointerMove') && react.includes('onLostPointerCapture'), 'pointer capture 拖动跟手');
assert.ok(react.includes('Math.round(next * last)'), '拖动 / 点击后吸附到最近档位');
assert.ok(react.includes('"ArrowRight"') && react.includes('"ArrowLeft"') && react.includes('"Home"') && react.includes('"End"'), '键盘 ←/→/Home/End');
assert.ok(react.includes('aria-valuemin') && react.includes('aria-valuenow') && react.includes('aria-valuetext'), '滑块 ARIA');
assert.ok(react.includes('const THUMB = { width: 38, height: 24 };'), '布局常量：拇指 38×24');
assert.ok(react.includes('Math.min(1, Math.max(0, (clientX - rect.left - PAD) / Math.max(1, rect.width - THUMB.width)))'), '点击轨道按位置跳档');
assert.ok(react.includes('"--ev-thumb": `calc((100% - 42px) * ${share} + 2px)`') && !react.includes('"--ev-fill": `calc((100% - 42px) * ${share} + 2px)`'), '布局变量：thumb = (100% - 42px)·share + 2px（两端各留 2px；拇指中心 = 圆点中心）');
assert.ok(react.includes('"--ev-fill": `calc((100% - 42px) * ${share} + 42px)`'), '填充宽 = (100% - 42px)·share + 42px（右缘 = 拇指右缘 + 2px，拇指四周各露 2px 渐变；Max = 100% 填到轨道右端）');
assert.ok(react.includes('"--ev-rec": `calc((100% - 42px) * ${recShare} + 21px)`') && react.includes('const PAD = THUMB.width / 2;'), '推荐小字 = (100% - 42px)·recShare + 21px（推荐点中心）');
assert.ok(react.includes('const THUMB = { width: 38, height: 24 };'), '拇指宽度仍是 38（行程 42 = 38 + 两端各 2px）');
assert.ok(!react.includes('+ 0px)'), '--ev-thumb / --ev-fill 不再从 +0px 起（低档左缘贴边）');
assert.ok(!react.includes('${THUMB.width}px'), '布局变量不再用 (100% - 38px) 的旧行程');
assert.ok(react.includes('data-think-level={localValue || "default"}'), '保留 data-think-level 契约');
assert.ok(react.includes('data-think={item}'), '档位点保留 data-think 契约');
assert.ok(css.includes('transition: width .5s var(--ev-spring)') && css.includes('left .5s var(--ev-spring)'), '500ms spring 过渡');
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'prefers-reduced-motion 关过渡');
assert.ok(fill.includes('prefers-reduced-motion: reduce') && fill.includes('const still'), 'prefers-reduced-motion 下不跑动画（静态渐变）');

// ---- WebGL 动态流体：只在挂载时创建、卸载销毁、最多一个 context ----
assert.ok(fill.includes('export function createEffortFill('), 'effort-fill 导出 createEffortFill');
assert.ok(fill.includes('canvas.getContext("webgl"'), 'WebGL 上下文');
assert.ok(fill.includes('EFFORT_PALETTES') && fill.includes('#f7fbff') && fill.includes('#bcd8fb') && fill.includes('#4f97f5') && fill.includes('#818cf8'), '五档调色板（左端近白 → 中段蓝 → 高档起靛蓝）');
assert.ok(/#8b5cf6/.test(fill) && /#a855f7/.test(fill), '极高 / Max 档调色板含紫（#8b5cf6 / #a855f7）');
assert.ok(fill.includes('mix(start, end, smoothstep(0.0, 0.45, uv.x))') && fill.includes('color = mix(color, glow, smoothstep(0.45, 1.0, uv.x))'), '着色器三色站：0~45% 近白→中段蓝、45%~100% 中段蓝→右端紫');
assert.ok(fill.includes('fbm(') && fill.includes('requestAnimationFrame'), '噪声流场动画');
assert.ok(fill.includes('speed = 0.18 + 1.4 * level'), '档位越高流速越快');
assert.ok(fill.includes('WEBGL_lose_context') && fill.includes('loseContext()'), '卸载时释放上下文');
assert.ok(fill.includes('webglcontextlost') && fill.includes('event.preventDefault()'), '处理 WEBGL_lose_context 丢失');
assert.ok(fill.includes('let live: EffortFillHandle | null = null') && fill.includes('live?.destroy()'), '同一时刻最多一个 context');
assert.ok(fill.includes('export const effortFallback') && fill.includes('linear-gradient'), '无 WebGL 回退 CSS 渐变');
assert.ok(react.includes('createEffortFill(canvas') && react.includes('effortFallback(level)') && react.includes('canvas.remove()'), '组件挂载创建 canvas、卸载移除并回退');

// ---- React CSS：28px 胶囊轨道 / 4px 点（padding 21px、点中心 21+i·(W-42)/(n-1)）/ 38×24 白胶囊拇指 / 零 border / 零 inset ----
assert.ok(/\.cn-root \.ev-track \{[^}]*height: 28px;[^}]*border-radius: 999px;/.test(css), '轨道 28px / 完整胶囊 999px');
assert.ok(/\.cn-root \.ev-track \{[^}]*background: rgba\(var\(--ink\), \.06\)/.test(css), '轨道软底');
assert.ok(/\.cn-root \.ev-dot \{[^}]*width: 4px; height: 4px;[^}]*border-radius: 50%/.test(css), '档位点 4px');
assert.ok(/\.cn-root \.ev-dots \{[^}]*padding: 0 21px;/.test(css), '圆点两端 padding 21px');
assert.ok(/\.cn-root \.ev-dots \{[^}]*inset: 0 -2px;/.test(css), '圆点层左右各放宽 2px：4px 点中心 = 21 + i·(W-42)/(n-1)');
assert.ok(!css.includes('margin: 0 -2px') && !/\.cn-root \.ev-dot \{[^}]*margin:/.test(css), '圆点不再用负外边距（margin: 0 -2px 已删）');
assert.ok(/\.cn-root \.ev-thumb \{[^}]*top: 2px;[^}]*width: 38px; height: 24px;[^}]*border-radius: 999px; border: 0;/.test(css), '拇指 38×24 / 上下 2px / 胶囊 999 / 无 border');
assert.ok(/\.cn-root \.ev-thumb \{[^}]*background: #fff;/.test(css), '拇指白底');
assert.ok(/.cn-root \.ev-thumb \{[^}]*box-shadow: 0 2px 6px var\(--ev-drop\);/.test(css), '拇指只有投影（无 0 0 0 ring / 无蓝边）');
assert.ok(css.includes('.ev-track[data-dragging] .ev-thumb { transition: none; box-shadow: 0 3px 10px var(--ev-drop); }'), '拖动只加深投影，无 ring');
assert.ok(css.includes('.ev-track:hover:not([data-dragging]) .ev-thumb { box-shadow: 0 2px 8px var(--ev-drop); }'), 'hover 只加深投影，无 ring');
assert.ok(!/0 0 0 (?:4|4\.5|5\.5)px/.test(css) && !css.includes('ev-halo'), '不含 4/4.5/5.5px 外圈，--ev-halo 已删除');
assert.ok(!css.includes('--ev-ring') && !/0 0 0/.test(css) && !/#60a5fa|96, 165, 250/.test(css), '无 --ev-ring / 无 0 0 0 ring / 无蓝边');
assert.ok(/\.cn-root \.ev-dot\[data-on\] \{ background: #fff; \}/.test(css), '过档点纯白无 box-shadow');
assert.ok(css.includes('width: min(var(--ev-fill), 100%)') && /.cn-root \.ev-fill-wrap \{[^}]*border-radius: 999px;/.test(css), '填充两端胶囊 / 宽 clamp 100%（Max 填到轨道右端）/ 覆盖拇指及其周围 2px');
assert.ok(!css.includes('min(var(--ev-fill), calc(100% - 40px))'), '填充不再用 100%-40px 的旧 clamp（那样会把填充停在拇指左缘）');
assert.ok(css.includes('left: min(var(--ev-thumb), calc(100% - 40px))'), '拇指 left clamp = 100%-40px（Max 时 left=W-40、右缘=W-2，两端不贴边）');
assert.ok(!css.includes('calc(100% - 38px)'), '不再出现 100%-38px 旧 clamp');

// 拇指中心 = 档位圆点中心：行程 = W-42；thumb left = 2 + share·(W-42)，圆心 = 21 + share·(W-42)；
// 圆点层内容盒从 19px 起、点宽 4px，点中心 = 21 + i·(W-42)/(n-1)，同一条线。
const spanAt = (W) => W - 42;
const thumbLeftAt = (W, i, n) => 2 + (spanAt(W) * i) / (n - 1);
const thumbCenterAt = (W, i, n) => thumbLeftAt(W, i, n) + 38 / 2;
const dotCenterAt = (W, i, n) => 21 + (spanAt(W) * i) / (n - 1);
for (const W of [280, 300, 275.5]) {
  for (let i = 0; i < 5; i += 1) {
    assert.ok(Math.abs(thumbCenterAt(W, i, 5) - dotCenterAt(W, i, 5)) <= 0.5, '拇指中心 = 第 ' + (i + 1) + ' 档圆点中心（轨道 ' + W + 'px）');
  }
  // 边界：低档 left=2；Max 档 left=W-40、右缘=W-2（不贴边不出轨）
  assert.ok(Math.abs(thumbLeftAt(W, 0, 5) - 2) <= 0.5, '低档拇指 left = 2px（轨道 ' + W + 'px）');
  const maxLeft = Math.min(thumbLeftAt(W, 4, 5), W - 40);
  assert.ok(Math.abs(maxLeft - (W - 40)) <= 0.5 && Math.abs(maxLeft + 38 - (W - 2)) <= 0.5, 'Max 档拇指 right = 轨道右缘 - 2px（轨道 ' + W + 'px）');
  // 填充 = 42 + share·(W-42)：右缘 = 拇指右缘 + 2px；低档 = 轨道左缘 + 42；Max = W（填满到轨道右端）
  const fillWidthAt = (i) => Math.min(42 + (spanAt(W) * i) / 4, W);
  for (let i = 0; i < 5; i += 1) {
    const fillRight = fillWidthAt(i);
    const tLeft = thumbLeftAt(W, i, 5);
    assert.ok(fillRight >= tLeft + 38 + 1.5, '填充覆盖拇指右缘 + 2px（第 ' + (i + 1) + ' 档，轨道 ' + W + 'px）');
    assert.ok(Math.abs(fillRight - (tLeft + 38 + 2)) <= 0.5, '填充右缘 = 拇指右缘 + 2px（第 ' + (i + 1) + ' 档，轨道 ' + W + 'px）');
  }
  assert.ok(Math.abs(fillWidthAt(0) - 42) <= 0.5, '低档填充宽 = 轨道左缘 + 42px（拇指四周各露 2px，轨道 ' + W + 'px）');
  assert.ok(Math.abs(fillWidthAt(4) - W) <= 0.5, 'Max 填充宽 = 轨道宽（填到轨道右端，轨道 ' + W + 'px）');
}
assert.ok(!/border:\s*1px/.test(css) && !/box-shadow:[^;]*inset/.test(css), '零 border / 零 inset 描边');
assert.ok(css.includes('border-radius: 999px;') && !css.includes('outline: none; border'), '无发丝线');


// ---- info「?」：项目内 hover / focus tooltip（无原生 title，弹层不裁切） ----
const infoWrap = (css.match(/\.cn-root \.ev-info-wrap \{[^}]*\}/) || [])[0];
assert.ok(infoWrap && /position:\s*relative/.test(infoWrap) && /display:\s*inline-flex/.test(infoWrap) && /flex:\s*none/.test(infoWrap), '.ev-info-wrap 相对定位 / inline-flex / flex:none');
const tip = (css.match(/\.cn-root \.ev-tip \{[^}]*\}/) || [])[0];
assert.ok(tip && /position:\s*absolute/.test(tip) && /right:\s*-2px/.test(tip) && /bottom:\s*calc\(100% \+ 8px\)/.test(tip), '.ev-tip 绝对定位在图标右上方');
assert.ok(tip && /max-width:\s*220px/.test(tip) && /font-size:\s*11\.5px/.test(tip) && /line-height:\s*1\.5/.test(tip) && /padding:\s*7px 9px/.test(tip) && /border-radius:\s*9px/.test(tip), '.ev-tip 220px / 11.5px / 1.5 / 7px 9px / 9px');
assert.ok(tip && /background:\s*var\(--s3\)/.test(tip) && /color:\s*var\(--fg\)/.test(tip) && /box-shadow:/.test(tip) && /border:\s*0/.test(tip) && !/inset/.test(tip), '.ev-tip 实底 var(--s3) + var(--fg) / 柔和投影 / 零 border / 零 inset');
assert.ok(tip && /opacity:\s*0/.test(tip) && /visibility:\s*hidden/.test(tip) && /transform:\s*translateY\(2px\)/.test(tip) && /pointer-events:\s*none/.test(tip) && /z-index:\s*6/.test(tip) && /transition:[^;]*\.12s/.test(tip), '.ev-tip 默认 opacity 0 / hidden / 下移 2px / 不挡指针 / z-index 6 / .12s');
assert.ok(css.includes('.cn-root .ev-tip[data-show] { opacity: 1; visibility: visible; transform: translateY(0); }'), '[data-show] 才显示 tooltip');
assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.cn-root \.ev-tip \{ transition: none; \}/.test(css), 'reduced-motion 关 tooltip 过渡');
assert.ok(/\.cn-root #pop\.think-pop\{[^}]*overflow:visible;/.test(menuCss), '思考强度弹层 overflow:visible（tooltip 不被裁切）');
assert.ok(/\.cn-root #pop\.quality-pop\{[^}]*overflow:visible;/.test(menuCss), '质量弹层 overflow:visible（tooltip 不被裁切）');
assert.ok(menuCss.includes('.cn-root #pop.model-pop{overflow:visible}'), '模型菜单弹层保持 overflow:visible');

// ---- 画布助手接入：一级菜单 + 思考强度弹层 ----
assert.ok(agentPanel.includes('import { EffortSlider } from "../canvas-next/ui/EffortSlider"'), 'AgentPanel 引入 EffortSlider');
assert.ok(agentPanel.includes('thinkLevels={thinkLevels} thinkLevel={thinkLevel} onThinkChange={setThinkLevel}'), '一级模型菜单传入当前模型的档位 / 当前值 / 改写回调');
assert.ok(agentPanel.includes('<EffortSlider levels={thinkLevels} value={thinkLevel} onChange={onThinkChange} />'), '一级供应商列表下方、模型设置上方插入滑块');
assert.ok(agentPanel.indexOf('className="model-effort"') > agentPanel.indexOf('className="model-providers"') && agentPanel.indexOf('className="model-effort"') < agentPanel.indexOf('onSettings ?'), '滑块位于供应商列表与模型设置之间');
assert.ok(agentPanel.includes('<EffortSlider levels={thinkLevels} value={thinkLevel} onChange={setThinkLevel} />'), '#aThinkLevel 弹层复用同一滑块');
assert.ok(agentPanel.includes('id="aThinkLevel"') && agentPanel.includes('data-think-level={thinkLevel || "default"}'), '触发 pill / data-think-level 保留');
assert.ok(agentPanel.includes('localStorage.setItem("canvas-next:agent:think"') && agentPanel.includes('localStorage.removeItem("canvas-next:agent:think")'), '画布 localStorage canvas-next:agent:think 不变');
assert.ok(agentPanel.includes('thinkLevels.length > 1 ? <button'), '只有多于 1 档才给入口');
assert.ok(agentPanel.includes('closest?.(".ev-track")'), '滑块聚焦时方向键不被菜单抢走');

// ---- 一级菜单宽度 / 供应商列表高度 ----
assert.ok(/\.cn-root #pop\.model-pop\{\n  width:304px;min-width:304px;max-width:304px;padding:6px;/.test(menuCss), '一级面板 304px（滑块 280）');
assert.ok(menuCss.includes('\n.cn-root #pop.model-pop .model-effort{margin:6px 0 2px'), '滑块容器间距');
assert.ok(/\.cn-root #pop\.think-pop\{[^}]*width:304px/.test(menuCss), '思考强度弹层同宽 304');
assert.ok(/\.cn-root \.model-providers\{max-height:min\(300px,calc\(100vh - 320px\)\)/.test(menuCss), '供应商列表收紧到 300px 可滚');
assert.ok(menuCss.includes('.cn-root .model-flyout.model-flyout-portal{\n  width:308px;padding:6px;border-radius:14px;border:0;'), '二级面板保持 308px');

// ---- Vue 组件：同款结构 / 交互 ----
assert.ok(vue.includes('defineProps') && vue.includes('defineEmits([\'update:value\'])'), 'Vue EffortSlider 组件存在且受控');
assert.ok(vue.includes('data-effort-slider') && vue.includes(':data-think-level="value || \'default\'"'), 'Vue 保留 data-effort-slider / data-think-level');
assert.ok(vue.includes("'默认'") && vue.includes('推荐') && vue.includes('更快') && vue.includes('更强') && vue.includes('恢复默认'), 'Vue 中文文案齐全');
assert.ok(vue.includes('role="slider"') && vue.includes('tabindex="0"') && vue.includes(':aria-valuenow="index"'), 'Vue role=slider / ARIA');
assert.ok(vue.includes('setPointerCapture(event.pointerId)') && vue.includes('@pointermove="onPointerMove"') && vue.includes('@lostpointercapture="endDrag"'), 'Vue pointer capture');
assert.ok(vue.includes('Math.round(next * last.value)'), 'Vue 吸附到最近档位');
assert.ok(vue.includes("'ArrowRight'") && vue.includes("'ArrowLeft'") && vue.includes("'Home'") && vue.includes("'End'"), 'Vue 键盘 ←/→/Home/End');
assert.ok(vue.includes('createEffortFill(canvas') && vue.includes('effortFallback(progress)'), 'Vue 挂 WebGL / 回退 CSS 渐变');
assert.ok(vue.includes('handle.destroy()') && vue.includes('canvasEl.remove()'), 'Vue 卸载销毁上下文');
assert.ok(vue.includes('@media (prefers-reduced-motion: reduce)') && vue.includes('height: 28px') && !/border:\s*1px/.test(vue), 'Vue 28px 轨道 / reduced-motion / 零 border');
assert.ok(!/box-shadow:[^;]*inset/.test(vue), 'Vue 零 inset 描边');
assert.ok(vue.includes('border-radius: 999px;') && vue.includes('width: min(var(--eff-fill), 100%)'), 'Vue 轨道 / 填充都是胶囊 999，填充宽 clamp 100%（Max 填到轨道右端）');
assert.ok(!vue.includes('min(var(--eff-fill), calc(100% - 40px))'), 'Vue 填充不再用 100%-40px 的旧 clamp');
assert.ok(vue.includes('left: min(var(--eff-thumb), calc(100% - 40px));'), 'Vue 拇指 left clamp = 100%-40px（Max 右缘 = 轨道右缘 - 2px）');
assert.ok(!vue.includes('calc(100% - 38px)'), 'Vue 不再出现 100%-38px 旧 clamp');
assert.ok(vue.includes('.eff-dot') && vue.includes('width: 4px; height: 4px'), 'Vue 档位点 4px');
assert.ok(vue.includes('padding: 0 21px;'), 'Vue 圆点两端 padding 21px');
assert.ok(vue.includes('inset: 0 -2px;'), 'Vue 圆点层左右各放宽 2px（点中心 = 21 + i·(W-42)/(n-1)）');
assert.ok(!/.eff-dot \{[^}]*margin:/.test(vue) && !vue.includes('margin: 0 -2px'), 'Vue 圆点不再用负外边距');
assert.ok(vue.includes('const THUMB = 38;') && vue.includes("'--eff-fill': 'calc((100% - 42px) * ' + share.value + ' + 42px)'") && vue.includes("'--eff-thumb': 'calc((100% - 42px) * ' + share.value + ' + 2px)'"), 'Vue 布局：thumb = (100% - 42px)·share + 2px、fill = +42px（右缘 = 拇指右缘 + 2px，拇指四周各露 2px 渐变；Max 填满轨道）');
assert.ok(vue.includes("'--eff-rec': 'calc((100% - 42px) * ' + recShare.value + ' + 21px)'"), 'Vue 推荐小字 = (100% - 42px)·recShare + 21px（推荐点中心）');
assert.ok(!vue.includes('+ 0px)') && !vue.includes('(THUMB + 2)'), 'Vue 布局变量不再用 +0px / (THUMB + 2)');
assert.ok(vue.includes('width: 38px; height: 24px;') && vue.includes('border-radius: 999px; border: 0;') && vue.includes('top: 2px;'), 'Vue 拇指 38×24 / 上下 2px / 胶囊 999');
assert.ok(/\.eff-thumb \{[^}]*box-shadow: 0 2px 6px var\(--eff-drop\);/.test(vue), 'Vue 拇指只有投影（无 0 0 0 ring / 无蓝边）');
assert.ok(!/0 0 0 (?:4|4\.5|5\.5)px/.test(vue) && !vue.includes('eff-halo'), 'Vue 不含 4/4.5/5.5px 外圈，--eff-halo 已删除');
assert.ok(!vue.includes('--eff-ring') && !/0 0 0/.test(vue) && !/#60a5fa|96, 165, 250/.test(vue), 'Vue 无 --eff-ring / 无 0 0 0 ring / 无蓝边');
assert.ok(vue.includes('.eff-dot[data-on] { background: #fff; }') && !/\.eff-dot\[data-on\][^\n]*box-shadow/.test(vue), 'Vue 过档点无 box-shadow');
assert.ok(vue.slice(vue.indexOf('<style>')).includes(':global') === false, 'Vue 样式不依赖 :global 主题选择器');

// ---- Vue info「?」：项目内 hover / focus tooltip（无原生 title，首页模型菜单） ----
assert.ok(vue.includes("hint: { type: String, default: '越高越慢，推理越深' }"), 'Vue hint prop 默认「越高越慢，推理越深」');
assert.ok(vue.includes('<span class="eff-info-wrap"'), 'info button 外层 span.eff-info-wrap（tooltip 定位基准）');
assert.ok(vue.includes('let tipSeq = 0;') && vue.includes("const tipId = 'eff-tip-' + (++tipSeq);"), 'tooltip id 由模块级计数器生成（eff-tip-N，不依赖 Vue 版本）');
assert.ok(vue.includes('role="tooltip"') && vue.includes('class="eff-tip"') && vue.includes('{{ hint }}</span>'), '渲染 role=tooltip 的 .eff-tip，内容 = hint');
assert.ok(vue.includes(':aria-describedby="tipId"') && vue.includes(":aria-label=\"'说明：' + hint\""), 'button aria-describedby 指向 tooltip、aria-label = 说明：hint');
assert.ok(!vue.includes('class="eff-info" title=') && !vue.includes('title="越高越慢，推理越深"'), 'info button 不再有原生 title');
assert.ok(vue.includes('@mouseenter="tipOpen = true"') && vue.includes('@mouseleave="tipOpen = false"') && vue.includes('@focus="tipOpen = true"') && vue.includes('@blur="tipOpen = false"'), '鼠标移入 / 键盘 focus 显示，移出 / 失焦隐藏');
assert.ok(vue.includes(":data-show=\"tipOpen ? '' : undefined\"") && vue.includes('const tipOpen = ref(false);'), 'data-show 控制 tooltip 显隐');
const effInfoWrap = (vue.match(/\.eff-info-wrap \{[^}]*\}/) || [])[0];
assert.ok(effInfoWrap && /position:\s*relative/.test(effInfoWrap) && /display:\s*inline-flex/.test(effInfoWrap) && /flex:\s*none/.test(effInfoWrap) && /margin-left:\s*auto/.test(effInfoWrap), '.eff-info-wrap 相对定位 / inline-flex / flex:none / 承接右对齐');
assert.ok(!/\.eff-info \{[^}]*margin-left:\s*auto/.test(vue), '.eff-info 不再自带 margin-left:auto（右对齐移到 .eff-info-wrap，位置不变）');
const effTip = (vue.match(/\.eff-tip \{[^}]*\}/) || [])[0];
assert.ok(effTip && /position:\s*absolute/.test(effTip) && /right:\s*-2px/.test(effTip) && /bottom:\s*calc\(100% \+ 8px\)/.test(effTip), '.eff-tip 绝对定位在图标右上方');
assert.ok(effTip && /max-width:\s*220px/.test(effTip) && /font-size:\s*11\.5px/.test(effTip) && /line-height:\s*1\.5/.test(effTip) && /padding:\s*7px 9px/.test(effTip) && /border-radius:\s*9px/.test(effTip), '.eff-tip 220px / 11.5px / 1.5 / 7px 9px / 9px');
assert.ok(effTip && /background:\s*var\(--hp-pop, #fff\)/.test(effTip) && /color:\s*var\(--ink\)/.test(effTip) && /box-shadow:\s*var\(--shadow-pop, 0 8px 24px rgba\(0, 0, 0, \.18\)\)/.test(effTip) && /border:\s*0/.test(effTip) && !/inset/.test(effTip), '.eff-tip 底 = var(--hp-pop)（暗色自动 #1e1e20）/ 字 = var(--ink) / 柔和投影 / 零 border / 零 inset');
assert.ok(effTip && /opacity:\s*0/.test(effTip) && /visibility:\s*hidden/.test(effTip) && /transform:\s*translateY\(2px\)/.test(effTip) && /pointer-events:\s*none/.test(effTip) && /z-index:\s*6/.test(effTip) && /transition:[^;]*\.12s/.test(effTip), '.eff-tip 默认 opacity 0 / hidden / 下移 2px / 不挡指针 / z-index 6 / .12s');
assert.ok(vue.includes('.eff-tip[data-show] { opacity: 1; visibility: visible; transform: translateY(0); }'), '[data-show] 才显示 tooltip');
assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.eff-tip \{ transition: none; \}/.test(vue), 'reduced-motion 关 tooltip 过渡');
assert.ok(!/box-shadow:[^;]*inset/.test(vue), 'Vue tooltip 同样零 inset 描边');

// ---- Vue 流体填充 ----
assert.ok(vueFill.includes('export function createEffortFill('), 'effortFill.js 导出 createEffortFill');
assert.ok(vueFill.includes("canvas.getContext('webgl'"), 'Vue WebGL 上下文');
assert.ok(vueFill.includes('WEBGL_lose_context') && vueFill.includes('webglcontextlost'), 'Vue 释放 / 丢失上下文');
assert.ok(vueFill.includes('requestAnimationFrame') && vueFill.includes('let live = null'), 'Vue 动画 + 最多一个 context');
assert.ok(vueFill.includes('effortFallback') && vueFill.includes('linear-gradient'), 'Vue CSS 回退渐变');
assert.ok(vueFill.includes('#818cf8') && /#8b5cf6/.test(vueFill) && /#a855f7/.test(vueFill), 'Vue 调色板同样含紫（#818cf8 / #8b5cf6 / #a855f7）');
assert.ok(vueFill.includes('mix(start, end, smoothstep(0.0, 0.45, uv.x))') && vueFill.includes('color = mix(color, glow, smoothstep(0.45, 1.0, uv.x))'), 'Vue 着色器三色站：中段蓝、右端紫');

// ---- 首页接入 ----
assert.ok(home.includes("import EffortSlider from '../../components/EffortSlider.vue'"), '首页引入 Vue EffortSlider');
assert.ok(home.includes('<EffortSlider v-if="chatModel && chatThinkLevels.length > 1" class="hp-effort" :levels="chatThinkLevels" :value="thinkLevel" @update:value="applyThinkLevel" />'), '滑块插在一级面板供应商列表下方 / footer 上方');
assert.ok(home.includes('model_caps') && home.includes('normalizeThinkLevels(caps[name] && caps[name].think)'), '模型列表把 model_caps[模型].think 带进每个模型');
assert.ok(home.includes('const THINK_KEYS = [\'low\', \'mid\', \'high\', \'xhigh\', \'max\']'), '首页只认后端五个合法档位');
assert.ok(home.includes("localStorage.setItem('canvas-next:agent:think', next)") && home.includes("localStorage.removeItem('canvas-next:agent:think')"), '首页写 / 清空 canvas-next:agent:think');
assert.ok(home.includes('watch(chatThinkLevels'), '换模型时收敛合法档位');
assert.ok(/\.hp-mpanel \{\n    width: 300px; padding: 6px; border-radius: 14px; border: 0;\n    background: color-mix\(in srgb, var\(--hp-pop\) 86%, transparent\);/.test(home), '首页一级面板 300px / 磨砂底 86%');
assert.ok(home.includes('-webkit-backdrop-filter: blur(42px) saturate(180%);') && home.includes('backdrop-filter: blur(42px) saturate(180%);'), '首页一级/二级面板磨砂 blur(42px) saturate(180%)（含 -webkit-）');
assert.ok(/\.hp-mpanel-models \{ position: absolute; top: 0; right: 100%; width: 300px; display: flex; flex-direction: column; z-index: 2; \}/.test(home), '首页二级面板 300px：绝对定位在一级左侧（top:0 / right:100% 贴边 / z-index 2）');
assert.ok(home.includes(':style="{ top: modelTop + \'px\' }"'), '首页二级 top 绑定 modelTop（跟当前供应商行）');
// ---- 首页模型菜单交互：一级始终保留 / 二级贴边浮层 / 无返回按钮 ----
assert.ok(!home.includes('v-if="!modelVendor"') && home.includes('<div class="hp-mpanel hp-mpanel-vendors">'), '首页一级供应商面板始终渲染（不再 v-if 移除 / 替换）');
assert.ok(/<div v-if="modelVendor && activeVendor" class="hp-mpanel hp-mpanel-models" :style="\{ top: modelTop \+ 'px' \}">/.test(home), '二级仍是条件渲染的子菜单浮层，带动态 top');
assert.ok(!home.includes('hp-models-back') && !home.includes('hp-models-hd'), '二级无返回按钮 / 无 header（不再顶部返回行）');
assert.ok(home.includes('const modelTop = ref(0);') && home.includes('function showVendor(id, event)'), '首页 showVendor 接收 event 以计算二级 top');
assert.ok(home.includes('const rr = event.currentTarget.getBoundingClientRect();') && home.includes('const wr = modelPopEl.value.getBoundingClientRect();') && home.includes('modelTop.value = Math.max(0, Math.round(rr.top - wr.top));'), '二级 top = 供应商行 top 相对 wrap（Math.max(0, Math.round(rr.top - wr.top))）');
assert.ok(home.includes('@pointerenter="showVendor(g.id, $event)" @click="clickVendor(g.id, $event)"'), '一级供应商行 hover / click 都把 event 传下去');
assert.ok(/function clickVendor\(id, event\) \{\s*showVendor\(id, event\);/.test(home), 'clickVendor 把 event 转给 showVendor');
assert.ok(!/class="hp-pop hp-model-wrap"[^>]*@pointerleave/.test(home), '外层不再用 @pointerleave 关二级');
assert.ok(!home.includes('scheduleFlyoutClose') && !home.includes('cancelFlyoutClose') && !home.includes('modelCloseTimer'), '不靠关闭定时器（划过供应商自动切换，移到模型不消失）');
assert.ok(/\.hp-mv-list \{[^}]*max-height: 240px/.test(home), '首页供应商列表收紧高度（滑块可见）');
assert.ok(/\.hp-effort \{ margin: 4px 0 2px; \}/.test(home), '首页滑块间距');
assert.ok(home.includes('function applyThinkLevel(level)'), '首页统一写档位入口');

// ---- 缓存版本号两处一致 ----
const versions = [...canvasHtml.matchAll(/\/static\/novai-canvas\/canvas\.(?:css|js)\?v=([\w.]+)/g)].map((m) => m[1]);
assert.strictEqual(versions.length, 2, 'canvas.html 里 canvas.css / canvas.js 各一处 ?v=');
assert.strictEqual(versions[0], versions[1], 'canvas.css / canvas.js 的 ?v= 一致');

console.log('[PASS] 动态模型强度（Effort）滑块：React/Vue 组件 + WebGL 流体渐变（近白→中段蓝→右端紫，高档起含紫）+ 档位/推荐/默认 + pointer capture/键盘/500ms spring；拇指 38×24 两端各留 2px（行程 42px、clamp 100%-40px）、中心 = 圆点中心 21+i·(W-42)/(n-1)、只有投影（无 ring / 无蓝边）；填充 = 42+share·(W-42) 覆盖拇指及其四周 2px（clamp 100%，Max 填到轨道右端）；画布一级菜单 304 与 #aThinkLevel 弹层、首页 300 + model_caps.think + canvas-next:agent:think');
