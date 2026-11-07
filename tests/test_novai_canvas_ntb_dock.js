#!/usr/bin/env node
'use strict';
/**
 * 节点工具栏（选中节点上方的 #ntb）Floating Dock + 磨砂玻璃 V2：玻璃胶囊（默认 / 深色 #111 74% + 6% 白雾，
 * 深色再加深成 #1c1c1e 80% + 4% 白雾；浅色主题 96% 白实底 + 深色图标）+ blur(44px) saturate(190%) + 圆角 14 + padding 7 + gap 4 + 高 50；
 * 按钮 36×36 / 圆角 8 / 图标 15，标签只在指针所在那一颗展开，白色 12% 滑块跟着它走。
 * 五处工具栏（#ntb / #multibar / 分组 GroupTools / 堆叠 stack-tools / 空图片节点的单按钮条）共用 float-menu.css 这一层。
 * 只读源码 / 构建产物断言，不需要跑浏览器。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** 去掉空白再比对：源码写得松、构建产物被压过，数值本身不变 */
const flat = (s) => s.replace(/\s+/g, '');
/** 玻璃 V2：一层白雾 linear-gradient 叠在 color-mix 底色之上（构建产物会把 rgba(255,255,255,.06) 压成 #ffffff0f） */
const GLASS_LIGHT = /background:\s*linear-gradient\((?:rgba\(255,\s*255,\s*255,\s*\.06\)|#ffffff0f)\s*,\s*(?:rgba\(255,\s*255,\s*255,\s*\.06\)|#ffffff0f)\),\s*color-mix\(in srgb,\s*(?:#111|rgb\(\s*17,\s*17,\s*17\))\s*74%,\s*transparent\)/;
const GLASS_DARK = /background:\s*linear-gradient\((?:rgba\(255,\s*255,\s*255,\s*\.04\)|#ffffff0a)\s*,\s*(?:rgba\(255,\s*255,\s*255,\s*\.04\)|#ffffff0a)\),\s*color-mix\(in srgb,\s*#1c1c1e\s*80%,\s*transparent\)/;

/** 取一个选择器的规则体：源码写成「sel {」、压缩产物写成「sel{」，两种都试 */
function ruleOf(sel, src) {
    for (const head of [sel + '{', sel + ' {', sel + '\n{']) {
        const start = src.indexOf(head);
        if (start < 0) continue;
        const end = src.indexOf('}', start);
        // 规则里的注释（解释为什么这么写）不参与数值断言：先剥掉，免得注释里的「1px」被当成描边
        return end < 0 ? '' : src.slice(start, end + 1).replace(/\/\*[\s\S]*?\*\//g, '');
    }
    return '';
}

const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui/';
const fmCss = read(ui + 'float-menu.css');
const css = read(ui + 'canvas-next.css');
const fmJs = read(ui + 'FloatMenu.tsx');
const genPanel = read(ui + 'GenPanel.tsx');
const chrome = read(ui + 'Chrome.tsx');
const legacy = read(ui + 'LegacyNodes.tsx');
const stack = read(ui + 'StackNode.tsx');

/* ---------- 1. dock 容器（float-menu.css 是唯一皮肤来源） ---------- */
const dock = ruleOf('.cn-root .cn-fm', fmCss);
assert(dock, 'float-menu.css 有 .cn-fm 规则');
const dockBody = flat(dock);
assert(dockBody.includes('gap:4px'), '.cn-fm gap 4');
assert(dockBody.includes('padding:7px'), '.cn-fm padding 7');
assert(dockBody.includes('height:50px'), '.cn-fm 高 50');
assert(dockBody.includes('border-radius:14px'), '.cn-fm 圆角 14');
assert(dockBody.includes('width:min-content'), '.cn-fm 宽 min-content');
assert(dockBody.includes('border:0'), '.cn-fm 不画边框');
assert(dockBody.includes(flat('--fm-bg: color-mix(in srgb, rgb(17, 17, 17) 74%, transparent)')) && dockBody.includes(flat('--fm-fog: rgba(255, 255, 255, .06)')), '.cn-fm 默认皮肤：6% 白雾 + color-mix(#111 74%)（写成变量）');
assert(dockBody.includes('background:linear-gradient(var(--fm-fog),var(--fm-fog)),var(--fm-bg)'), '.cn-fm 底色 / 雾面都读变量，两套主题在一处切换');
assert(!/color-mix\(in srgb,\s*(#111|rgb\(17,\s*17,\s*17\))\s*78%/.test(dock), '.cn-fm 不再用旧的 78% 底色');
assert((dock.match(/backdrop-filter:\s*blur\(44px\) saturate\(190%\)/g) || []).length === 2, '.cn-fm 带 -webkit-backdrop-filter 与标准 backdrop-filter blur(44px) saturate(190%)');
assert(dockBody.includes(flat('--fm-shadow: 0 24px 64px rgba(0, 0, 0, .16), 0 8px 20px rgba(0, 0, 0, .10)')) && dockBody.includes('box-shadow:var(--fm-shadow)'), '.cn-fm 沿用两层柔和投影（变量化）');
assert(!dockBody.includes('1px'), '.cn-fm 不写 1px 描边 / 高光');

const dockDark = ruleOf('.cn-root[data-theme="dark"] .cn-fm', fmCss);
assert(dockDark, '暗色有 .cn-fm 覆盖');
assert(GLASS_DARK.test(dockDark), '暗色 dock 玻璃 V2：4% 白雾渐变 + color-mix(#1c1c1e 80%)（纯黑底上 74% 会糊）');
assert(flat(dockDark).includes('024px64pxrgba(0,0,0,.32)') && flat(dockDark).includes('08px20pxrgba(0,0,0,.18)'), '暗色投影加重到 .32 / .18');

const dockLight = ruleOf('.cn-root[data-theme="light"] .cn-fm', fmCss);
assert(dockLight, '浅色有 .cn-fm 覆盖');
const dockLightBody = flat(dockLight);
assert(dockLightBody.includes('--fm-bg:rgba(255,255,255,.96)'), '浅色 dock 是 96% 白实底（小工具条盖在图片上，不靠 blur 也要读得清）');
assert(dockLightBody.includes('--fm-fg:rgba(0,0,0,.62)') && dockLightBody.includes('--fm-fg-hi:var(--fg)'), '浅色图标 rgba(0,0,0,.62)、hover / 展开用 var(--fg)');
assert(dockLightBody.includes('--fm-hl:rgba(0,0,0,.06)') && dockLightBody.includes('--fm-primary:rgba(0,0,0,.08)') && dockLightBody.includes('--fm-dim:rgba(0,0,0,.5)'), '浅色滑块 / 主操作底 / 计数文字都换成深色系');
assert(dockLightBody.includes('--fm-shadow:024px64pxrgba(0,0,0,.14),08px20pxrgba(0,0,0,.10)'), '浅色投影收浅一档');
assert(!flat(dockLight).includes('border'), '浅色覆盖不加边框 / 发丝线');

/* ---------- 2. 按钮：36×36 方块，展开那一颗 padding 0 12 ---------- */
const btn = ruleOf('.cn-root .cn-fm-btn', fmCss);
assert(btn, '有 .cn-fm-btn 规则');
const btnBody = flat(btn);
assert(btnBody.includes('min-width:36px') && btnBody.includes('height:36px'), '按钮折叠态 36×36');
assert(btnBody.includes('padding:0'), '折叠态按钮没有内距');
assert(btnBody.includes('border-radius:8px'), '按钮圆角 8');
assert(btnBody.includes('background:transparent'), '按钮默认透明底（底色交给滑块）');
assert(btnBody.includes('color:var(--fm-fg)'), '图标色读 --fm-fg（默认 rgba(255,255,255,.7)）');
assert(btnBody.includes('gap:0'), '按钮 gap 0（间距走标签 margin-left，折叠态图标才在方块正中）');
assert(btnBody.includes('font-size:13px') && btnBody.includes('font-weight:500'), '标签字号 13 / 字重 500');
assert(btnBody.includes('letter-spacing:-0.02em'), '标签字距 -0.02em');
assert(btnBody.includes('font-family:var(--font)'), '标签用 var(--font)');
assert(btnBody.includes('border:0'), '按钮不画边框');
assert(fmCss.includes('.cn-root .cn-fm-btn.is-open { padding: 0 12px; }'), '展开那一颗 padding 0 12');
assert(fmCss.includes('.cn-root .cn-fm-btn:hover:not(:disabled),') && fmCss.includes('.cn-root .cn-fm-btn.is-open { color: var(--fm-fg-hi); }'), 'hover / 展开时图标读 --fm-fg-hi（默认 #fff）');
assert(flat(ruleOf('.cn-root .cn-fm .cn-fm-btn svg.i', fmCss)).includes('width:15px'), '图标 15×15');

/* ---------- 3. 标签：只在 is-open 那一颗进场 ---------- */
const label = ruleOf('.cn-root .cn-fm-label', fmCss);
assert(label, '有 .cn-fm-label 规则');
const labelBody = flat(label);
assert(labelBody.includes('max-width:0') && labelBody.includes('opacity:0'), '标签默认收起');
assert(labelBody.includes('color:var(--fm-fg-hi)'), '标签色读 --fm-fg-hi（默认 #fff，浅色是 #1d1d1f）');
assert(labelBody.includes('margin-left:0'), '折叠态标签没有外边距（不占那个 6px）');
assert(labelBody.includes('transform:translateX(-4px)') && labelBody.includes('filter:blur(3px)'), '标签从 -4px / blur(3px) 进场');
assert(labelBody.includes('max-width.16svar(--fm-ease)'), '标签宽度 160ms');
assert(labelBody.includes('opacity.16sease'), '标签透明度 160ms');
assert(flat(fmCss).includes('--fm-ease:cubic-bezier(.22,1,.36,1)'), '过渡曲线 cubic-bezier(.22,1,.36,1)');
const openLabel = ruleOf('.cn-root .cn-fm-btn.is-open .cn-fm-label', fmCss);
assert(openLabel, '有 .is-open 的标签展开规则');
assert(flat(openLabel).includes('opacity:1') && flat(openLabel).includes('transform:none') && flat(openLabel).includes('filter:blur(0)'), '展开后 opacity 1 / 位移与模糊归零');
assert(flat(openLabel).includes('margin-left:6px'), '展开时标签 margin-left 6（图标 ↔ 文字间距）');
assert(flat(ruleOf('.cn-root .cn-fm .bgdot', fmCss)).includes('margin-left:5px'), 'bgdot 距图标 5px（折叠态内容 15+5+10=30 < 36，方块仍是 36）');
assert(!fmCss.includes('.cn-fm.opened'), '旧的「整条 hover 全部展开」规则已删掉');
assert(fmCss.includes(':focus-visible') && flat(ruleOf('.cn-root .cn-fm-btn:focus-visible .cn-fm-label', fmCss)).includes('max-width:max-content'), '键盘 :focus-visible 也展开该颗标签');

/* ---------- 4. 滑块：白 12% / 圆角 8 / 高 36 / left,width 180ms ---------- */
const hl = ruleOf('.cn-root .cn-fm-hl', fmCss);
assert(hl, '有 .cn-fm-hl 规则');
const hlBody = flat(hl);
assert(hlBody.includes('background:var(--fm-hl)'), '滑块读 --fm-hl（默认白 12%，浅色是黑 6%）');
assert(hlBody.includes('border-radius:8px'), '滑块圆角 8');
assert(hlBody.includes('height:36px'), '滑块高 36');
assert(hlBody.includes('transition:left.18svar(--fm-ease),width.18svar(--fm-ease)'), '滑块 left / width 180ms 同一曲线');
assert(hlBody.includes('opacity:0'), '滑块默认隐藏');

/* ---------- 5. 数量 / 生成中文字 / 小标 ---------- */
const count = flat(ruleOf('.cn-root .cn-fm-count', fmCss));
assert(count.includes('color:var(--fm-dim)') && count.includes('font-size:13px'), '多选计数读 --fm-dim（默认 rgba(255,255,255,.62)）/ 13px');
const est = flat(ruleOf('.cn-root .cn-fm .est', fmCss));
assert(est.includes('color:var(--fm-dim)') && est.includes('font-size:12px'), '生成中文字读 --fm-dim（默认 rgba(255,255,255,.62)）/ 12px');
assert(flat(ruleOf('.cn-root .cn-fm .bgdot', fmCss)).includes('width:10px') && flat(ruleOf('.cn-root .cn-fm .bgdot', fmCss)).includes('height:10px') && flat(ruleOf('.cn-root .cn-fm .bgdot', fmCss)).includes('border-radius:50%'), 'bgdot 10×10 圆');
const tagmini = flat(ruleOf('.cn-root .cn-fm .tagmini', fmCss));
assert(tagmini.includes('position:absolute') && tagmini.includes('right:3px') && tagmini.includes('bottom:3px') && tagmini.includes('width:7px'), 'tagmini 绝对定位到右下角 7×7');

/* ---------- 6. 定位微调 + 移动端 + 降低动态 ---------- */
assert(flat(ruleOf('.cn-root .cn-fm-anchored', fmCss)).includes('top:-58px'), '.cn-fm-anchored top -58（50 高 dock + 8 间距）');
const mobile = fmCss.slice(fmCss.indexOf('@media (max-width: 760px)'), fmCss.indexOf('@media (prefers-reduced-motion'));
assert(mobile, '有 ≤760px 媒体查询');
assert(flat(mobile).includes('padding:6px') && flat(mobile).includes('border-radius:13px'), '移动端容器 padding 6 / 圆角 13');
assert(flat(mobile).includes('.cn-root.cn-fm-btn,.cn-root.cn-fm-btn.is-open{min-width:32px;height:32px;padding:0'), '移动端按钮 32×32');
assert(mobile.includes('.cn-root .cn-fm-label { display: none; }'), '移动端隐藏标签');
assert(fmCss.includes('@media (prefers-reduced-motion: reduce)') && flat(fmCss).includes('.cn-root.cn-fm-label{transition:none'), '降低动态偏好下不做过渡');
assert(!fmCss.includes('#ntb.cn-fm'), 'float-menu.css 不再有 #ntb.cn-fm 的重复覆盖');
assert(fmCss.includes('backdrop-filter: blur(44px) saturate(190%)') && fmCss.includes('-webkit-backdrop-filter: blur(44px) saturate(190%)'), 'float-menu.css 含完整玻璃配方（标准 + -webkit-）');
assert(fmCss.includes('--fm-bg: color-mix(in srgb, rgb(17, 17, 17) 74%, transparent)') && fmCss.includes('--fm-fog: rgba(255, 255, 255, .06)') && fmCss.includes('background: linear-gradient(rgba(255, 255, 255, .04), rgba(255, 255, 255, .04)), color-mix(in srgb, #1c1c1e 80%, transparent)'), 'float-menu.css 默认（= 原浅色玻璃）/ 深色两套玻璃 V2 都在');

/* ---------- 7. canvas-next.css：旧 #ntb 玻璃规则已清 ---------- */
const ntb = ruleOf('.cn-root #ntb', css);
assert(ntb, 'canvas-next.css 仍有 #ntb 规则');
const ntbBody = flat(ntb);
assert(ntbBody.includes('z-index:25'), '#ntb 层级不变（25）');
assert(!ntbBody.includes('background') && !ntbBody.includes('backdrop-filter') && !ntbBody.includes('border-radius') && !ntbBody.includes('box-shadow'), '#ntb 不再自带底色 / 模糊 / 圆角 / 投影（交给 .cn-fm）');
assert(!ruleOf('.cn-root[data-theme="dark"] #ntb', css), '文件末尾的暗色 #ntb 玻璃底覆盖已删除');
assert(!css.includes('.cn-root #ntb .lab{'), '旧的 .lab 标签规则已删');
const vsep = flat(ruleOf('.cn-root #ntb .vsep', css));
assert(vsep.includes('width:6px') && !vsep.includes('background:var(--line)'), '#ntb 里 .vsep 改成 6px 空白间隔（不画发丝线）');

/* ---------- 8. 空图片节点：同一套 dock 容器 + 单颗 36 高按钮 ---------- */
const empty = flat(ruleOf('.cn-root #ntb.ntb-empty-upload', css));
assert(empty.includes('padding:7px') && empty.includes('height:50px') && empty.includes('border-radius:14px'), '空图片节点容器同 dock（padding 7 / 高 50 / 圆角 14）');
assert(GLASS_LIGHT.test(ruleOf('.cn-root #ntb.ntb-empty-upload', css)), '空图片节点容器同款玻璃 V2（6% 白雾 + 74% 底色）');
assert((ruleOf('.cn-root #ntb.ntb-empty-upload', css).match(/backdrop-filter:blur\(44px\) saturate\(190%\)/g) || []).length === 2, '空图片节点容器带 blur(44px) saturate(190%)（标准 + -webkit-）');
assert(!empty.includes('border:1px'), '空图片节点容器无描边');
const emptyDark = flat(ruleOf('.cn-root[data-theme=dark] #ntb.ntb-empty-upload', css));
assert(GLASS_DARK.test(ruleOf('.cn-root[data-theme=dark] #ntb.ntb-empty-upload', css)), '空图片节点容器暗色 80% 玻璃 + 4% 白雾');
const emptyBtn = ruleOf('.cn-root #ntb.ntb-empty-upload .ib', css);
assert(/height:\s*36px/.test(emptyBtn) && /padding:\s*0 12px/.test(emptyBtn) && /border-radius:\s*8px/.test(emptyBtn), '空图片节点按钮高 36 / padding 0 12 / 圆角 8');
assert(emptyBtn.includes('font-size:13px') && emptyBtn.includes('color:#fff'), '「上传」13px 白字');
assert(flat(ruleOf('.cn-root #ntb.ntb-empty-upload .ib:hover', css)).includes('background:rgba(255,255,255,.12)'), 'hover 时白 12% 滑块铺满这颗按钮');
assert(flat(ruleOf('.cn-root #ntb.ntb-empty-upload .ib svg.i', css)).includes('width:15px'), '上传图标 15px');

/* ---------- 9. FloatMenu.tsx：按指针所在单颗展开 ---------- */
assert(fmJs.includes('const OPEN_PAD_X = 12;') && fmJs.includes('const LABEL_GAP = 6;'), '展开内距 12 / 图标与文字间距 6');
assert(fmJs.includes('hit.disabled'), '禁用按钮不展开标签、只藏滑块');
assert(fmJs.includes('btn.classList.add("is-open")') && fmJs.includes('btn.classList.remove("is-open")'), '展开态挂在单颗按钮的 is-open 上');
assert(!fmJs.includes('classList.add("opened")'), '不再给整条加 opened（旧的整条展开）');
assert(fmJs.includes('function growthOf') && fmJs.includes('createRange') && fmJs.includes('function localScale'), '保留 Range 量宽 + localScale 那套');
assert(fmJs.includes('const openButton = useCallback') && fmJs.includes('if (prev) closeButton(prev);'), '同一时刻只展开一颗');
assert(fmJs.includes('const compensateFor = useCallback') && fmJs.includes('menu.style.marginLeft = margin + "px"'), '只给外部定位的 #ntb 做 margin-left 补偿');
assert(fmJs.includes('const COLLAPSE_DELAY = 90;'), '指针离开整条 90ms 后才收起');
assert(fmJs.includes('for (const btn of buttonsOf(menu)) closeButton(btn);'), '收起时所有标签 max-width 归零');
assert(fmJs.includes('placeHighlight(hovered.current)'), 'max-width 过渡结束后按最终几何重摆滑块');
assert(fmJs.includes('setHighlightOpacity("0")'), '收起 / 指针进间隙时滑块淡出');

/* ---------- 10. 五处工具栏都复用同一层，e2e 钩子全在 ---------- */
assert(genPanel.includes('id="ntb"') && genPanel.includes('compensate'), '#ntb 仍走 FloatMenuBar 且开补偿');
assert(genPanel.includes('className="float enter ntb-empty-upload"'), '空图片节点仍是单独的单按钮条');
assert(genPanel.includes('const ty = a.y - sr.top - 60;'), '#ntb 顶部偏移改成 -60（50 高 dock）');
assert(chrome.includes('id="multibar"'), '#multibar 保留');
assert(legacy.includes('<FloatMenu show={visible} data={{ "data-gt-tools": node.id }}>'), '分组工具条仍用 FloatMenu');
assert(stack.includes('className="stack-tools"'), '.stack-tools 保留');
for (const hook of ['"data-tb"', '"data-tip"']) assert(genPanel.includes(hook), '#ntb 保留 ' + hook);
assert(chrome.includes('"data-mb"'), '#multibar 保留 data-mb');
assert(legacy.includes('"data-gt"'), '分组保留 data-gt');
assert(stack.includes('"data-st"'), '堆叠保留 data-st');
for (const cls of ['cn-fm', 'cn-fm-btn', 'cn-fm-label', 'cn-fm-hl', 'cn-fm-clip']) assert(fmJs.includes(cls), 'FloatMenu.tsx 保留 class ' + cls);
assert(fmJs.includes('"data-fm-primary": "1"') && fmJs.includes('"data-fm-danger": "1"'), '保留 data-fm-primary / data-fm-danger');
assert(fmJs.includes('title={title ?? label}'), '按钮 title 文案规则不变');
assert(chrome.includes('cn-fm-count') && legacy.includes('cn-fm-count'), 'cn-fm-count 钩子保留');

/* ---------- 11. 构建产物 ---------- */
const built = read('static/novai-canvas/canvas.css');
const builtDock = flat(ruleOf('.cn-root .cn-fm', built));
assert(builtDock, '构建产物 CSS 有 .cn-fm 规则');
assert(builtDock.includes('gap:4px') && builtDock.includes('padding:7px') && builtDock.includes('height:50px') && builtDock.includes('border-radius:14px'), '构建产物 dock：gap 4 / padding 7 / 高 50 / 圆角 14');
assert(flat(ruleOf('.cn-root .cn-fm', built)).includes(flat('--fm-bg: color-mix(in srgb, rgb(17, 17, 17) 74%, transparent)')) && flat(ruleOf('.cn-root .cn-fm', built)).includes(flat('--fm-fog: rgba(255, 255, 255, .06)')), '构建产物 dock 默认皮肤变量（6% 白雾 + 74% 底色）');
assert((ruleOf('.cn-root .cn-fm', built).match(/backdrop-filter:blur\(44px\) saturate\(190%\)/g) || []).length === 2, '构建产物 dock 带 blur(44px) saturate(190%)（标准 + -webkit-）');
assert(GLASS_DARK.test(ruleOf('.cn-root[data-theme=dark] .cn-fm', built)), '构建产物含暗色 80% 玻璃 + 4% 白雾覆盖');
assert(flat(ruleOf('.cn-root[data-theme=light] .cn-fm', built)).includes('--fm-bg:rgba(255,255,255,.96)'), '构建产物含浅色 96% 白实底覆盖');
assert(GLASS_LIGHT.test(ruleOf('.cn-root #ntb.ntb-empty-upload', built)), '构建产物空图片节点容器也是同款玻璃 V2');
const builtHl = flat(ruleOf('.cn-root .cn-fm-hl', built));
assert(builtHl.includes('border-radius:8px') && builtHl.includes('height:36px'), '构建产物滑块圆角 8 / 高 36');
assert(flat(ruleOf('.cn-root .cn-fm', built)).includes('--fm-hl:rgba(255,255,255,.12)') || flat(ruleOf('.cn-root .cn-fm', built)).includes('--fm-hl:#ffffff1f'), '构建产物滑块默认白 12%（走 --fm-hl）');
assert(flat(ruleOf('.cn-root .cn-fm-btn', built)).includes('height:36px'), '构建产物按钮 36 高');
assert(flat(ruleOf('.cn-root .cn-fm-anchored', built)).includes('top:-58px'), '构建产物 .cn-fm-anchored top -58');
assert(flat(ruleOf('.cn-root #ntb', built)) === '.cn-root#ntb{z-index:25}', '构建产物 #ntb 只剩层级');
const builtJs = read('static/novai-canvas/canvas.js');
assert(builtJs.includes('is-open'), '构建产物 JS 打进了单颗展开的 is-open');

/* ---------- 12. 入口版本号两处一致 ---------- */
const html = read('static/canvas.html');
const vers = [...html.matchAll(/novai-canvas\/(?:canvas\.css|canvas\.js)\?v=([0-9.]+)/g)].map((m) => m[1]);
assert.strictEqual(vers.length, 2, 'canvas.html 里 css / js 各一处 ?v=');
assert.strictEqual(vers[0], vers[1], 'css / js 的 ?v= 一致');
assert(/^1\.0\.143\.\d{10}$/.test(vers[0]), '?v= 形如 1.0.143.<unix 秒>：' + vers[0]);

console.log('[PASS] 节点工具栏 #ntb：Floating Dock + 磨砂玻璃 V2（浅 color-mix(#111 74%)+6% 白雾 / 深 color-mix(#1c1c1e 80%)+4% 白雾'
    + ' + blur(44px) saturate(190%)、圆角 14、padding 7、gap 4、高 50、border 0 + 两层柔和投影；'
    + '按钮 36×36 / 圆角 8 / 图标 15；只有指针那一颗长标签 13px/500/-0.02em 160ms；'
    + '白 12% 滑块 180ms 跟随；空图片节点单按钮条同款玻璃；五处工具栏共用 float-menu.css）');
