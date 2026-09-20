#!/usr/bin/env node
// 通用滑块高亮（shared/glide.js）的行为测试 + 接线检查。
// 运行：node tests/test_glide.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const eq = (a, b, m) => {
    const s = v => { try { return JSON.stringify(v); } catch(e){ return String(v); } };
    s(a) === s(b) ? pass++ : fails.push(m + ' 期望' + s(b) + ' 实际' + s(a));
};
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= (eps || 1e-9), m + ' 期望' + b + ' 实际' + a);

/* ── 极简 DOM 垫片：只要够 scanItems 用 ── */
function collect(el, sel, out){
    (el.children || []).forEach(child => {
        if(sel.attr){
            if(Object.prototype.hasOwnProperty.call(child._attrs || {}, sel.attr)) out.push(child);
        } else if(sel.classes.every(name => child._cls.has(name))) out.push(child);
        collect(child, sel, out);
    });
    return out;
}
function parseSelector(selector){
    const text = String(selector).trim();
    const attr = /^\[([\w-]+)\]$/.exec(text);
    if(attr) return {attr: attr[1]};
    if(/^(\.[\w-]+)+$/.test(text)) return {classes: text.slice(1).split('.')};
    throw new Error('unsupported selector: ' + selector);
}
function makeEl(tag, className){
    const el = {
        tagName: String(tag).toUpperCase(), nodeType: 1, children: [], parentNode: null,
        _attrs: {}, _cls: new Set(String(className || '').split(/\s+/).filter(Boolean)),
        appendChild(child){ child.parentNode = el; el.children.push(child); return child; },
        setAttribute(name, value){ el._attrs[name] = String(value); },
        removeAttribute(name){ delete el._attrs[name]; },
        hasAttribute(name){ return Object.prototype.hasOwnProperty.call(el._attrs, name); },
        querySelectorAll(selector){ return collect(el, parseSelector(selector), []); },
        get className(){ return Array.from(el._cls).join(' '); },
    };
    el.classList = {
        add(...names){ names.forEach(name => el._cls.add(name)); },
        remove(...names){ names.forEach(name => el._cls.delete(name)); },
        contains(name){ return el._cls.has(name); },
        toggle(name, force){
            const on = force === undefined ? !el._cls.has(name) : Boolean(force);
            on ? el._cls.add(name) : el._cls.delete(name);
            return on;
        },
    };
    return el;
}
global.window = {};
global.document = {createElement: makeEl};

const G = require('../static/js/shared/glide.js');

/* ── 1. 导出面 ── */
{
    ok(typeof G.attach === 'function', '导出 attach');
    ok(typeof G.pickActive === 'function', '导出 pickActive（优先级纯函数）');
    ok(typeof G.toLocalRect === 'function', '导出 toLocalRect（局部坐标纯函数）');
    ok(typeof G.scanItems === 'function', '导出 scanItems（选项扫描纯函数）');
    eq(global.window.NovaGlide, G, '同时挂到 window.NovaGlide（浏览器侧入口）');
    eq(G.PILL_CLASS, 'nv-glide-pill', '滑块 class 常量');
    eq(G.ITEM_ATTR, 'data-nv-glide-item', '选项标记属性常量');
}

/* ── 2. pickActive：三个输入源的优先级 ── */
{
    const hover = {id: 'hover'}; const cursor = {id: 'cursor'}; const active = {id: 'active'};
    eq(G.pickActive({hoverEl: hover, cursorEl: cursor, activeEl: active}), hover, '指针悬停项压过一切');
    eq(G.pickActive({hoverEl: null, cursorEl: cursor, activeEl: active}), cursor, '没有指针 → 键盘光标项');
    eq(G.pickActive({hoverEl: null, cursorEl: null, activeEl: active}), active, '光标也没有 → 当前选中项');
    eq(G.pickActive({hoverEl: null, cursorEl: null, activeEl: null}), null, '三个都没有 → 隐藏');
    eq(G.pickActive({}), null, '空状态 → 隐藏');
    eq(G.pickActive(), null, '不传参 → 隐藏');
    eq(G.pickActive({hoverEl: undefined, cursorEl: undefined, activeEl: active}), active, '字段是 undefined 也往下走');
}

/* ── 3. toLocalRect：screen → 容器自身坐标（画布缩放修正） ── */
{
    const host = {left: 100, top: 200, width: 400, height: 600};
    eq(G.toLocalRect({left: 120, top: 260, width: 288, height: 60}, host, 1),
        {left: 20, top: 60, width: 288, height: 60}, '缩放 1：只做相对容器的差值');
    eq(G.toLocalRect({left: 120, top: 260, width: 288, height: 60}, host, 0.5),
        {left: 40, top: 120, width: 576, height: 120}, '缩放 0.5：#world 里 rect 被乘过，四个值都要除回去');
    /* 画布真实场景：world scale 0.6，屏幕上量到的 288×60 在容器坐标里是 480×100 */
    const scaled = G.toLocalRect({left: 300, top: 500, width: 288, height: 60}, {left: 240, top: 440}, 0.6);
    near(scaled.left, 100, 1e-9, '缩放 0.6：left 换算（60 / 0.6）');
    near(scaled.top, 100, 1e-9, '缩放 0.6：top 换算（60 / 0.6）');
    near(scaled.width, 480, 1e-9, '缩放 0.6：宽度换算（288 / 0.6）');
    near(scaled.height, 100, 1e-9, '缩放 0.6：高度换算（60 / 0.6）');
    eq(G.toLocalRect({left: 10, top: 10, width: 10, height: 10}, host, 0).width, 10, 'scale 0 当 1 处理（除零会得到 Infinity）');
    eq(G.toLocalRect({left: 10, top: 10, width: 10, height: 10}, host, NaN).left, -90, 'scale NaN 当 1 处理');
    eq(G.toLocalRect({left: 10, top: 10, width: 10, height: 10}, host, undefined).top, -190, 'scale 缺省当 1 处理');
    eq(G.toLocalRect(null, null, 1), {left: 0, top: 0, width: 0, height: 0}, 'rect 缺失 → 全 0，不抛');
}

/* ── 3b. toLocalRect：滚动容器的边框 / 滚动量修正 ── */
{
    const host = {left: 100, top: 200, width: 400, height: 200};
    const item = {left: 120, top: 260, width: 288, height: 60};
    eq(G.toLocalRect(item, host, 1, {}),
        {left: 20, top: 60, width: 288, height: 60}, 'frame 全 0：等价于不传第四参');
    eq(G.toLocalRect(item, host, 1, {clientLeft: 2, clientTop: 3}),
        {left: 18, top: 57, width: 288, height: 60}, '减掉容器边框（.demo-scroll 那类 2px border）');
    eq(G.toLocalRect(item, host, 1, {scrollTop: 120}),
        {left: 20, top: 180, width: 288, height: 60}, '加上 scrollTop：滑块随内容滚动，写的是内容空间坐标');
    eq(G.toLocalRect(item, host, .5, {clientLeft: 2, clientTop: 4, scrollTop: 50}),
        {left: 38, top: 166, width: 576, height: 120}, '缩放 + 边框 + 滚动量同时生效');
    /* 滚动不变性：容器滚动 S 后目标 rect 同步上移 S，算出来的坐标必须原地不动，
       否则滑块会在滚动时从目标身上飘走 */
    const before = G.toLocalRect(item, host, 1, {scrollTop: 0});
    const after = G.toLocalRect({left: 120, top: 140, width: 288, height: 60}, host, 1, {scrollTop: 120});
    eq(after, before, '容器滚动 120px 后算出的坐标不变 → 滑块自动跟住内容');
    /* grid 场景：同一行第二列的项 left 变了、top 没变 */
    const sameRow = G.toLocalRect({left: 320, top: 260, width: 288, height: 60}, host, 1, {});
    ok(sameRow.top === before.top && sameRow.left !== before.left,
        'grid 同一行的第二列只该动 x、不动 y（二维 translate 的由来）');
}

/* ── 4. scanItems：只认匹配项，且不把滑块自己当选项 ── */
{
    const host = makeEl('div', 'nd-menu');
    const titleA = host.appendChild(makeEl('div', 'menu-section-title'));
    const one = host.appendChild(makeEl('button', 'nd-option active'));
    const two = host.appendChild(makeEl('button', 'nd-option'));
    const titleB = host.appendChild(makeEl('div', 'menu-section-title'));
    const three = host.appendChild(makeEl('button', 'nd-option'));
    const group = host.appendChild(makeEl('div', 'nd-option-group'));
    const nested = group.appendChild(makeEl('button', 'nd-option'));
    const pill = makeEl('span', 'nv-glide-pill');
    host.insertBefore ? host.insertBefore(pill, one) : host.children.unshift(pill);

    const items = G.scanItems(host, '.nd-option');
    eq(items.length, 4, '只收 .nd-option，分组标题 / 分组容器都不算');
    ok(items.indexOf(titleA) < 0 && items.indexOf(titleB) < 0, '分组标题不在选项里');
    ok(items.indexOf(one) >= 0 && items.indexOf(two) >= 0 && items.indexOf(three) >= 0, '三个直接选项都在');
    ok(items.indexOf(nested) >= 0, '深层匹配项按 CSS 选择器语义一并返回（要精确就自己写 :scope > 前缀）');
    eq(G.scanItems(host, '.nv-glide-pill').length, 0, '滑块自己带 nv-glide-pill，宽松选择器也扫不到它');
    eq(G.scanItems(host, '.nd-option.active').map(el => el.className), ['nd-option active'], '带类名组合的选择器照常工作');
    eq(G.scanItems(host, '.nothing-here'), [], '没有匹配项 → 空数组');
    eq(G.scanItems(host, '>>>'), [], '非法选择器 → 空数组，不把调用方拖崩');
    eq(G.scanItems(null, '.nd-option'), [], '容器为空 → 空数组');
    eq(G.scanItems(host, ''), [], '选择器为空 → 空数组');
    eq(items[0], one, '顺序按文档序，滑块插在最前面也不影响');
}

/* ── 5. 接线：三个页面引入 + 样式就位 + 引入顺序 ── */
{
    const root = path.join(__dirname, '..');
    const read = p => fs.readFileSync(path.join(root, p), 'utf8');
    const css = read('static/css/glide.css');
    const src = read('static/js/shared/glide.js');

    ok(/\.nv-glide-pill \{/.test(css), 'glide.css 有 .nv-glide-pill');
    ok(/var\(--nv-glide-bg, var\(--soft, rgba\(127, ?127, ?127/.test(css), '滑块底色走 --nv-glide-bg → --soft → 中性灰三级回退');
    ok(/\.nv-glide-host\.nv-glide-instant \.nv-glide-pill \{[\s\S]*?transition: none;/.test(css), '瞬移开关 .nv-glide-instant 会关掉过渡');
    ok(/prefers-reduced-motion: reduce/.test(css), 'reduced-motion 下关过渡');
    ok(/transition:[\s\S]*?cubic-bezier\(\.23, 1, \.32, 1\)/.test(css), '过渡曲线是参考实现的 cubic-bezier(.23,1,.32,1)');
    ok(/transform var\(--nv-glide-ms, 220ms\)/.test(css) && /width var\(--nv-glide-ms, 220ms\)/.test(css)
        && /height var\(--nv-glide-ms, 220ms\)/.test(css), 'translate / width / height 都在过渡里');
    ok(/\.nv-glide-host \[data-nv-glide-item\] \{[\s\S]*?position: relative;[\s\S]*?z-index: 1;/.test(css), '选项抬到滑块之上');
    const suppress = /\.nv-glide-host \[data-nv-glide-item\]:hover,[\s\S]*?\}/.exec(css);
    ok(!!suppress, '有 hover / active / is-active / hovered 这一组底色压制');
    if(suppress){
        const block = suppress[0];
        [':hover', '.active', '.is-active', '.hovered'].forEach(name => {
            ok(block.indexOf('[data-nv-glide-item]' + name) >= 0, '压制覆盖 ' + name);
        });
        ok(/background-color: transparent !important;/.test(block) && /border-color: transparent !important;/.test(block),
            '压制的确是 background-color / border-color');
        ok(!/font-weight/.test(block) && !/(^|[;{\s])color\s*:/.test(block),
            '只压底色，不动字重/文字色（勾选图标与选中文字标识留给选项自己）');
    }

    /* gpt-chat.html 里那批 `background: var(--nav-hover-bg) !important` 的权重体检：
       压制选择器是 (0,3,0)，只要那边没有更高的、且 glide.css 排在其后，压制就成立。
       以后有人往那页加一条更重的 !important 底色，这条断言会先炸。 */
    const gpt = read('static/gpt-chat.html');
    const spec = selector => {
        const s = String(selector).trim();
        if(!s || s[0] === '@') return null;
        return {
            ids: (s.match(/#[\w-]+/g) || []).length,
            classes: (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length + (s.match(/:(?!:)[\w-]+/g) || []).length,
            els: (s.match(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g) || []).length + (s.match(/::[\w-]+/g) || []).length
        };
    };
    const heavy = [];
    [...gpt.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].forEach(block => {
        const body = block[1].replace(/\/\*[\s\S]*?\*\//g, ' ');
        [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].forEach(rule => {
            const decls = rule[2];
            if(!/!important/.test(decls) || !/(^|[;{\s])background(-color)?\s*:/.test(decls)) return;
            if(!/--nav-hover-bg/.test(decls)) return;
            rule[1].split(',').forEach(selector => {
                const s = spec(selector);
                if(s) heavy.push(Object.assign({selector: selector.trim()}, s));
            });
        });
    });
    ok(heavy.length >= 10, 'gpt-chat.html 里确实有一批 --nav-hover-bg !important 底色规则（' + heavy.length + ' 条）');
    const over = heavy.filter(h => h.ids > 0 || h.classes > 3 || (h.classes === 3 && h.els > 0));
    eq(over.map(h => h.selector), [], '没有一条权重超过压制的 (0,3,0)');
    const tied = heavy.filter(h => h.classes === 3 && h.els === 0).map(h => h.selector);
    ok(tied.indexOf('.upload-btn.attach-btn:hover') >= 0, '权重打平的 .upload-btn.attach-btn:hover 被认出来了（只能靠后引入取胜）');
    ok(gpt.indexOf('/static/css/glide.css') >= 0
        && gpt.indexOf('/static/css/glide.css') > gpt.lastIndexOf('--nav-hover-bg'),
        'glide.css 排在那批 !important 之后引入（打平的那条才压得住）');

    ok(src.indexOf("window.NovaGlide = api") >= 0, 'glide.js 挂 window.NovaGlide');
    ok(src.indexOf('module.exports = api') >= 0, 'glide.js 双导出供 node 单测');
    ok(src.indexOf('localScale') >= 0 && src.indexOf('Math.hypot') >= 0, '画布缩放修正来自 initSmartNodeMenuMotion 的 localScale');
    ok(src.indexOf('getBoundingClientRect') >= 0, '定位用 getBoundingClientRect 差值，不按 index × 行高');
    /* grid / 双列布局：位移必须是单条二维 transform，拆成 translateX/translateY 二选一会错位 */
    ok(/transform: 'translate\(' \+ left \+ 'px, ' \+ top \+ 'px\)'/.test(src),
        '位移写成 translate(x, y) 二维形式');
    ok(src.indexOf('pill.style.left') < 0 && src.indexOf('pill.style.top') < 0,
        '不再分别写 left / top，避免两条过渡在斜向移动时不同步');
    ok(/addEventListener\('scroll', onScroll, true\)/.test(src), '捕获阶段监听滚动，容器自己或内部滚动区滚动都重新定位');
    ok(/itemChanged\) paint\(resolve\(\), true\)/.test(src) && src.indexOf('if(contentChanged) refresh();') >= 0,
        'MutationObserver 只对「选项 class 变化」重新定位');
    ok(src.indexOf('selfClassWrites') >= 0,
        '自己写的容器 class 变化记账后吞掉：否则 observer → paint → observer 会自激把页面卡死');
    ok(src.indexOf('container.clientTop') >= 0 && src.indexOf('container.scrollTop') >= 0,
        '把 clientLeft/clientTop 与 scrollLeft/scrollTop 交给坐标换算');
    ok(src.indexOf("'touch'") >= 0, '触屏指针不参与悬停高亮');
    ok(src.indexOf('prefers-reduced-motion: reduce') >= 0, 'reduced-motion 一律瞬间到位');

    /* 开发用的合成场景页不能出现在 static/：那是发布出去的网站根目录，用户能直接访问，
       产品里不该有这种东西。它现在放在验证脚本自己的目录里，由脚本用 page.route 喂给浏览器。 */
    ok(!fs.existsSync(path.join(root, 'static/glide-verify.html')),
        'static/ 里没有开发用验证页（glide-verify.html 只允许待在 tests/artifacts/verify-scripts/）');

    ['static/canvas.html', 'static/smart-canvas.html', 'static/gpt-chat.html'].forEach(page => {
        const html = read(page);
        const cssTag = /<link rel="stylesheet" href="\/static\/css\/glide\.css\?v=1\.0\.120\.(\d+)"/.exec(html);
        const jsTag = /<script src="\/static\/js\/shared\/glide\.js\?v=1\.0\.120\.(\d+)"><\/script>/.exec(html);
        ok(!!cssTag, page + ' 引入 glide.css 且带 ?v= 版本号');
        ok(!!jsTag, page + ' 引入 shared/glide.js 且带 ?v= 版本号');
        /* 版本串的约定（main.py:2357 versioned_static_html / 2377 sync_static_html_versions）：
           服务启动时会把每个 /static/*.js|css|html 引用的 ?v= 重写成「版本号 + 被引用文件自己的
           mtime（秒）」（main.py:2371），所以同一页里 glide.css 与 glide.js 的后缀本来就该不一样 ——
           谁再去把它们「统一」成一个值，下一次服务重启就会被 main.py 按 mtime 改回去。
           这里只守形式（带纯数字缓存串），不守两者相等、也不守等于磁盘 mtime：
           开发中改了文件但没重启服务时，页面里的串落后于 mtime 属于正常，不该在测试里假红。 */
        ok(!!cssTag && /^\d+$/.test(cssTag[1]), page + ' glide.css 的 ?v= 是「版本号.纯数字」（main.py 按 mtime 重写，别去统一）');
        ok(!!jsTag && /^\d+$/.test(jsTag[1]), page + ' glide.js 的 ?v= 是「版本号.纯数字」（与 css 不同属正常）');
        /* glide.css 必须是本页最后一个样式表：gpt-chat 那批 !important 靠权重赢，
           但同权重时靠的就是「后引入」，顺序写错会静默失效 */
        const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)];
        const last = links[links.length - 1][1];
        ok(last.indexOf('/static/css/glide.css') >= 0, page + ' glide.css 排在其它样式表之后（实际最后一个是 ' + last + '）');
        const utilsAt = html.indexOf('/static/js/shared/utils.js');
        ok(utilsAt >= 0 && html.indexOf('/static/js/shared/glide.js') > utilsAt, page + ' glide.js 在 shared/utils.js 之后加载');
    });
}

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
