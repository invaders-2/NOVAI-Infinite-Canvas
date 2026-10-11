#!/usr/bin/env node
'use strict';
/*
 * 旧画布列表页（static/canvas-list.html）hero 轮播窄屏塌宽回归。
 *
 * 背景：<=760px 时 .hero 变 flex-direction:column，但仍保留 .hero { align-items:center }；
 * .hero-right{flex:1;min-width:0} 在竖排下退化成内容宽度（内容只有 width:100% 的轮播 -> 0），
 * 整块轮播不可见。修法只在 (max-width:760px) 里给 .hero-right 补 width:100%，让竖排子项吃满
 * 交叉轴，桌面端与 500px 分支一律不动。500px 分支是 760 分支的子集，未重声明 align-items /
 * .hero-right，所以窄屏修复对它同样生效（420/500 实测轮播宽=视口内容宽）。
 *
 * 跑法：node tests/test_canvas_list_hero_media.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas-list.html'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

function mediaBlock(css, query) {
    const start = css.indexOf(query);
    if (start < 0) return '';
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
            depth -= 1;
            if (depth === 0) return css.slice(open + 1, i);
        }
    }
    return '';
}
function rule(block, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = block.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
}

const css = html.split('<style>')[1].split('</style>')[0];
const mq760 = mediaBlock(css, '@media (max-width: 760px)');
const mq500 = mediaBlock(css, '@media (max-width: 500px)');

console.log('[1] <=760px：.hero 竖排后 .hero-right 拿回整宽');
ok(!!mq760, '找到 (max-width:760px) 媒体块');
ok(/flex-direction\s*:\s*column/.test(rule(mq760, '.hero')), '.hero 仍是 flex-direction: column');
ok(/width\s*:\s*100%/.test(rule(mq760, '.hero-right')), '.hero-right 在该块内被设为 width: 100%');
ok(/height\s*:\s*220px/.test(rule(mq760, '.hero-carousel')), '.hero-carousel 窄屏高度仍是 220px（未动）');
ok(mq760.indexOf('!important') < 0, '窄屏块没有 !important');

console.log('[2] <=500px：同族问题由 760 块继承覆盖，无需重复声明');
ok(!!mq500, '找到 (max-width:500px) 媒体块');
ok(/flex-direction\s*:\s*column/.test(rule(mq500, '.hero')), '.hero 仍是 flex-direction: column');
ok(!/align-items/.test(rule(mq500, '.hero')), '500 块没有重声明 .hero align-items（不覆盖 760 的修复）');
ok(!/width\s*:\s*100%/.test(rule(mq500, '.hero-right')), '500 块没有把 .hero-right 改回窄宽');
ok(/height\s*:\s*200px/.test(rule(mq500, '.hero-carousel')), '.hero-carousel 超窄屏高度仍是 200px（未动）');

console.log('[3] 桌面端（>760px）基准原样保留');
const baseHero = css.slice(0, css.indexOf('@media'));
ok(/align-items\s*:\s*center/.test(rule(baseHero, '.hero')), '.hero 桌面仍 align-items: center');
ok(/gap\s*:\s*56px/.test(rule(baseHero, '.hero')), '.hero 桌面仍 gap: 56px');
ok(/flex\s*:\s*1/.test(rule(baseHero, '.hero-right')) && /min-width\s*:\s*0/.test(rule(baseHero, '.hero-right')), '.hero-right 桌面仍 flex:1; min-width:0');
ok(/width\s*:\s*100%/.test(rule(baseHero, '.hero-carousel')), '.hero-carousel 仍 width:100%');
ok(/height\s*:\s*300px/.test(rule(baseHero, '.hero-carousel')), '.hero-carousel 桌面高度仍是 300px');
ok(!/width\s*:\s*100%/.test(rule(baseHero, '.hero-right')), '.hero-right 桌面没有被加 width:100%');

console.log('画布列表 hero 轮播窄屏宽度：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) {
    fails.forEach(f => console.error('  \u2717 ' + f));
    process.exit(1);
}
console.log('全部通过');
