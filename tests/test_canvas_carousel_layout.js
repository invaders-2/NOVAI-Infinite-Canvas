#!/usr/bin/env node
'use strict';
/*
 * 画布列表轮播「恢复原排版 + 文字说明磨砂玻璃」回归测试。
 *
 * 背景：上一轮把轮播改成横向通栏（.cl-carousel 移出 .cl-in / .cl-hero、width:100%，
 * .cl-cap 满宽贴边，.cl 自己接管 flex + 内边距）。Boss 要求撤销通栏、恢复原排版，
 * 并且只给文字说明 .cl-cap 加磨砂玻璃框，且不得改变它的盒模型占位。
 *
 * 守住这些点：
 *   [1] 模板：只有一个居中 .cl-in；.cl-carousel 回到 .cl-hero 内、紧跟 .cl-intro
 *   [2] .cl-carousel 回到 min(560px, 48%)（不再是 width:100%），没有 max-height
 *   [3] .cl-cap 横向满宽贴底（left:0 / right:0 / bottom:0 + padding:16px 18px，上下留白一致、玻璃带贯穿轮播整宽）
 *   [4] .cl 是纵向滚动容器、不再自己 flex + 内边距；.cl-in 重新居中 + 接管内边距
 *   [5] .cl-cap 磨砂玻璃：半透明底 / blur(12px) / 直角（border-radius:0，两侧不圆）/ outline 细边框（不用 inset 线框），
 *       除 left/right/bottom/padding 外不含其它盒模型属性；align-items:flex-start 让 b/span 回到内容宽度
 *       （满宽后默认 stretch 会把子项拉宽：box 宽变了但字形与行数没变；实测 1440/768/600 字形 run rect
 *       宽仍为 183.74 / 130.56 / 130.56，行数均 1）
 *   [6] 构建产物（Boss 服务器吃 static/v2）带上述规则；既有 .wel inert / .tpl-media .mini /
 *       记忆面板（/api/memories）标记仍在
 *
 * 跑法：node tests/test_canvas_carousel_layout.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/src/pages/canvas/CanvasListPage.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond) {
    if (cond) pass += 1;
    else { fail += 1; console.error('  \u2717 ' + name); }
}
function rule(css, selector) {
    const m = css.match(new RegExp(selector + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
}

const tpl = SRC.split('<template>')[1].split('</template>')[0];
const css = SRC.split('<style scoped>')[1].split('</style>')[0];

// [1] 模板：轮播回到受限容器
console.log('[1] 模板：轮播回到 .cl-in / .cl-hero');
const firstIn = tpl.indexOf('<div class="cl-in nv-enter">');
const secondIn = tpl.indexOf('<div class="cl-in nv-enter">', firstIn + 1);
const hero = tpl.indexOf('class="cl-hero"');
const intro = tpl.indexOf('class="cl-intro"');
const car = tpl.indexOf('class="cl-carousel"');
const bar = tpl.indexOf('class="cl-bar"');
const heroClose = tpl.indexOf('</section>', hero);
check('只有一个居中 .cl-in 容器（通栏版拆出的两个已合并回一个）', firstIn >= 0 && secondIn === -1);
check('.cl-carousel 在 .cl-hero 内（不再是 .cl 的直接子元素）', car > hero && heroClose > 0 && car < heroClose);
check('.cl-carousel 排在 .cl-intro 之后', intro > 0 && car > intro);
check('.cl-carousel 与工具条同在一个 .cl-in 里', bar > 0 && car < bar);

// [2] 轮播回到卡片宽
console.log('[2] .cl-carousel 回到 min(560px, 48%)');
const carRule = rule(css, '\\.cl-carousel');
check('.cl-carousel 宽度 min(560px, 48%)', /width:\s*min\(560px,\s*48%\)/.test(carRule));
check('.cl-carousel 不再是 width:100%', !/width:\s*100%/.test(carRule));
check('.cl-carousel 去掉了 max-height:360px', !/max-height/.test(carRule));
check('.cl-carousel 仍是 flex:none（不被压扁）', /flex:\s*none/.test(carRule));
check('.cl-carousel 保留圆角 var(--radius-2xl)', /border-radius:\s*var\(--radius-2xl\)/.test(carRule));
check('.cl-carousel 保留 overflow:hidden（圆角裁切）', /overflow:\s*hidden/.test(carRule));
check('图片裁切仍是 object-fit:cover', /object-fit:\s*cover/.test(rule(css, '\\.cl-media')));

// [3] 文字层横向满宽贴底（玻璃带贯穿轮播整宽，用 padding 保持文字位置）
console.log('[3] .cl-cap 横向满宽贴底 + padding:16px 18px（上下对称、水平 18px 不变）');
const capRule = rule(css, '\\.cl-cap');
check('.cl-cap 左边贴齐轮播 left:0', /left:\s*0(\D|$)/.test(capRule));
check('.cl-cap 右边贴齐轮播 right:0', /right:\s*0(\D|$)/.test(capRule));
check('.cl-cap 底边贴齐轮播 bottom:0', /bottom:\s*0(\D|$)/.test(capRule));
check('.cl-cap 用 padding:16px 18px（上下对称、水平 18px，文字不位移）', /padding:\s*16px\s+18px(\s|;)/.test(capRule));
check('.cl-cap 没有残留 left:18px / bottom:16px', !/left:\s*18px/.test(capRule) && !/bottom:\s*16px/.test(capRule));

// [4] 页面容器回到原滚动 / 居中排版
console.log('[4] .cl / .cl-in 回到原排版');
const clRule = rule(css, '\\.cl');
check('.cl 仍是纵向滚动容器', /overflow-y:\s*auto/.test(clRule));
check('.cl 横向仍 hidden（不产生横向滚动条）', /overflow-x:\s*hidden/.test(clRule));
check('.cl 去掉了上一轮自加的 display:flex / padding', !/display:\s*flex/.test(clRule) && !/padding/.test(clRule));
const inRule = rule(css, '\\.cl-in');
check('.cl-in 宽度恢复 min(1180px, calc(100% - 96px))', /width:\s*min\(1180px,\s*calc\(100% - 96px\)\)/.test(inRule));
check('.cl-in 重新居中（margin:0 auto）', /margin:\s*0 auto/.test(inRule));
check('.cl-in 重新接管页面内边距 padding:40px 0 96px', /padding:\s*40px 0 96px/.test(inRule));
check('.cl-in 去掉上一轮自加的 flex:none', !/flex:\s*none/.test(inRule));

// [5] 磨砂玻璃：只加不改变盒模型的属性
console.log('[5] .cl-cap 磨砂玻璃（不改盒模型）');
check('.cl-cap 有半透明底（alpha < 1）', /background:\s*rgba\([^)]*,\s*0?\.\d+\s*\)/.test(capRule) && !/background:\s*rgba\([^)]*,\s*1\s*\)/.test(capRule));
check('.cl-cap 有 backdrop-filter: blur', /backdrop-filter:\s*blur\(12px\)/.test(capRule));
check('.cl-cap 有 -webkit-backdrop-filter: blur', /-webkit-backdrop-filter:\s*blur\(12px\)/.test(capRule));
check('.cl-cap 直角 border-radius:0（两侧圆角去掉）', /border-radius:\s*0(\s*;|\s*$)/.test(capRule) && !/border-radius:\s*16px/.test(capRule));
check('.cl-cap 用 outline 做轻量边框（1px 实线）', /outline:\s*1px\s+solid/.test(capRule));
check('.cl-cap 不再用 box-shadow inset 线框', !/box-shadow:\s*inset/.test(capRule));
check('玻璃规则除 left/right/bottom/padding 外不引入 width/height/margin/字体', !/(^|;)\s*(margin|width|height|font-size|line-height)\s*:/.test(capRule));
check('.cl-cap 用 align-items:flex-start 让子项回到内容宽度（不再被 stretch 拉宽）', /align-items:\s*flex-start/.test(capRule));
check('.cl-cap b / span 没有固定 width（子项宽度由内容决定）', !/(^|;)\s*width\s*:/.test(rule(css, '\\.cl-cap b')) && !/(^|;)\s*width\s*:/.test(rule(css, '\\.cl-cap span')));

// [6] 构建产物
console.log('[6] 构建产物 static/v2');
const assetDir = path.join(ROOT, 'static/v2/assets');
const cssFiles = fs.existsSync(assetDir) ? fs.readdirSync(assetDir).filter(f => /^index-.*\.css$/.test(f)) : [];
const jsFiles = fs.existsSync(assetDir) ? fs.readdirSync(assetDir).filter(f => /^index-.*\.js$/.test(f)) : [];
const builtCss = cssFiles.map(f => fs.readFileSync(path.join(assetDir, f), 'utf8')).join('\n');
const builtJs = jsFiles.map(f => fs.readFileSync(path.join(assetDir, f), 'utf8')).join('\n');
const builtCarRules = builtCss.match(/\.cl-carousel\[[^\]]+\]\{[^}]*\}/g) || [];
const builtCapRules = builtCss.match(/\.cl-cap\[[^\]]+\]\{[^}]*\}/g) || [];
check('构建产物存在 static/v2/assets/index-*.css', cssFiles.length > 0);
check('构建产物 .cl-carousel 基础规则不再是 width:100%', builtCarRules.length > 0 && !/width:100%/.test(builtCarRules[0]));
check('构建产物 .cl-carousel 带 min(560px, 48%)', builtCarRules.some(r => /min\(560px,\s*48%\)/.test(r)));
check('构建产物 .cl-cap 横向满宽贴底（left/right/bottom:0 + padding:16px 18px 上下对称）', builtCapRules.some(r => /left:0/.test(r) && /right:0/.test(r) && /bottom:0/.test(r) && /padding:16px 18px/.test(r)));
check('构建产物 .cl-cap 带玻璃（blur + outline）', builtCapRules.some(r => /backdrop-filter:blur\(12px\)/.test(r) && /outline:1px solid/.test(r)));
check('构建产物 .cl-cap 不再有 inset 线框', builtCapRules.length > 0 && !/box-shadow:inset/.test(builtCapRules.join('\n')));
check('构建产物 .cl-cap 带 align-items:flex-start（子项回内容宽度）', builtCapRules.some(r => /align-items:flex-start/.test(r)));
check('既有 .tpl-media .mini 标记仍在构建 CSS 里', /\.tpl-media \.mini/.test(builtCss));
check('既有 .wel inert 标记仍在构建 JS 里', /inert/.test(builtJs));
check('既有记忆面板标记 /api/memories 仍在构建 JS 里', /\/api\/memories/.test(builtJs));

console.log('画布列表轮播（回退 + 磨砂玻璃）：' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : ''));
if (fail) {
    console.error('画布列表轮播（回退 + 磨砂玻璃）：失败 ' + fail + ' 项');
    process.exit(1);
}
console.log('全部通过');
