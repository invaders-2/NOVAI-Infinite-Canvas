#!/usr/bin/env node
// 自绘下拉弹层（shared/dropdown.js）的行为测试 + 接线检查。
// 运行：node tests/test_select_menu.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const eq = (a, b, m) => {
    const s = v => { try { return JSON.stringify(v); } catch(e){ return String(v); } };
    s(a) === s(b) ? pass++ : fails.push(m + ' 期望' + s(b) + ' 实际' + s(a));
};

/* ── 极简 DOM 垫片：只要够 dropdown.js 用 ── */
function matches(el, sel){
    if(sel[0] !== '.') return false;
    return sel.slice(1).split('.').every(name => el.classList.contains(name));
}
function collect(el, sel, out){
    (el.children || []).forEach(child => {
        if(matches(child, sel)) out.push(child);
        collect(child, sel, out);
    });
    return out;
}
function makeEl(tag){
    const el = {
        tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {},
        disabled: false, type: '', parentNode: null, _text: '', _cls: new Set(), _rect: null,
        appendChild(child){ child.parentNode = el; el.children.push(child); return child; },
        removeChild(child){ const i = el.children.indexOf(child); if(i >= 0) el.children.splice(i, 1); child.parentNode = null; return child; },
        contains(node){ return node === el || collect(el, '.x', []).length >= 0 && (function walk(n){ return n.children.some(c => c === node || walk(c)); })(el); },
        querySelectorAll(sel){ return collect(el, sel, []); },
        setAttribute(){}, focus(){ el._focused = true; },
        getBoundingClientRect(){ return el._rect || {left:0, top:0, right:0, bottom:0, width:0, height:0}; },
        get className(){ return Array.from(el._cls).join(' '); },
        set className(value){ el._cls = new Set(String(value || '').split(/\s+/).filter(Boolean)); },
        get textContent(){ return el.children.length ? el.children.map(c => c.textContent).join('') : el._text; },
        set textContent(value){ el.children.length = 0; el._text = String(value === null || value === undefined ? '' : value); },
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
const listeners = {};
const body = makeEl('body');
global.document = {
    createElement: makeEl,
    body,
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
};
const winListeners = {};   // window 级监听（resize / wheel）也记下来，不然驱动不了
global.window = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener(type, fn){ (winListeners[type] = winListeners[type] || []).push(fn); },
};
global.Event = class { constructor(type, init){ this.type = type; this.bubbles = Boolean(init && init.bubbles); } };

const D = require('../static/js/shared/dropdown.js');

/* ── 造一个 select 垫片 ── */
function makeSelect(options, selectedIndex, opts){
    const select = {
        tagName: 'SELECT', disabled: Boolean(opts && opts.disabled), selectedIndex,
        _events: [],
        closest(sel){ return sel === 'select' ? select : null; },
        focus(){ select._focused = true; },
        getBoundingClientRect(){ return {left: 40, top: 100, right: 240, bottom: 134, width: 200, height: 34}; },
        dispatchEvent(event){ select._events.push(event.type); return true; },
        get value(){ const opt = select.options[select.selectedIndex]; return opt ? opt.value : ''; },
        set value(v){
            const index = select.options.findIndex(opt => String(opt.value) === String(v));
            if(index >= 0) select.selectedIndex = index;
        },
    };
    select.options = options.map(raw => {
        const option = {value: raw.value, textContent: raw.label, disabled: Boolean(raw.disabled), parentNode: null};
        if(raw.group){
            option.parentNode = {tagName: 'OPTGROUP', label: raw.group};
        }
        return option;
    });
    return select;
}
const OPTIONS = [
    {value:'a', label:'灵境 API'},
    {value:'b', label:'ModelScope'},
    {value:'c', label:'OpenAI', disabled:true},
];

/* ── 1. itemsFor：选项 + optgroup 分组 ── */
{
    const select = makeSelect(OPTIONS, 1);
    const items = D.itemsFor(select);
    eq(items.filter(i => i.type === 'option').map(i => i.value), ['a','b','c'], '条目按 option 顺序');
    eq(items.filter(i => i.active).map(i => i.value), ['b'], '当前值标记 active');
    eq(items.find(i => i.value === 'c').disabled, true, 'disabled 透传');
    const grouped = D.itemsFor(makeSelect([
        {group:'国内', value:'x', label:'X'},
        {group:'国内', value:'y', label:'Y'},
        {group:'国外', value:'z', label:'Z'},
    ], 0));
    eq(grouped.map(i => i.type), ['group','option','option','group','option'], 'optgroup 生成分组标题');
    eq(grouped[0].label, '国内', '分组标题取 optgroup label');
    eq(D.itemsFor(null), [], '空 select → 空');
}

/* ── 2. placeFor：贴下沿 / 翻上 / 夹边 ── */
{
    const anchor = {left: 100, top: 100, bottom: 134};
    const down = D.placeFor(anchor, {width: 200, height: 200}, {width: 1200, height: 800});
    eq(down, {left: 100, top: 140, width: 200, flip: false}, '空间够 → 贴下沿');
    const up = D.placeFor({left: 100, top: 700, bottom: 734}, {width: 200, height: 200}, {width: 1200, height: 800});
    eq(up.flip, true, '下面放不下 → 翻到上面');
    eq(up.top, 494, '翻上去的落点 = top - 高度 - 间隙');
    const right = D.placeFor({left: 1150, top: 100, bottom: 134}, {width: 200, height: 120}, {width: 1200, height: 800});
    eq(right.left, 992, '右边越界 → 夹在视口内（1200 - 200 - 8）');
    const tiny = D.placeFor({left: 0, top: 10, bottom: 44}, {width: 200, height: 900}, {width: 1200, height: 800});
    eq(tiny.top, 8, '上下都放不下 → 顶到上边距，不跑出视口');
}

/* ── 3. mousedown 委托：拦原生弹层 + 自绘菜单 ── */
const fire = (type, event) => (listeners[type] || []).forEach(fn => fn(event));
function mouseDown(select){
    let prevented = false; let stopped = false;
    fire('mousedown', {
        button: 0, target: select,
        preventDefault(){ prevented = true; }, stopPropagation(){ stopped = true; },
    });
    return {prevented, stopped};
}
ok((listeners.mousedown || []).length > 0, 'install() 注册了 document 级 mousedown');
{
    const select = makeSelect(OPTIONS, 1);
    const result = mouseDown(select);
    eq(result, {prevented: true, stopped: true}, 'mousedown 被拦下（原生弹层不会开、画布不当拖拽）');
    eq(select._focused, true, '顺手把焦点给 select');
    eq(body.children.length, 1, '自绘菜单已挂到 body');
    const menu = body.children[0];
    ok(menu.classList.contains('nd-menu'), '菜单 class = nd-menu');
    const rows = menu.querySelectorAll('.nd-option');
    eq(rows.length, 3, '三条选项');
    eq(rows.map(r => r.textContent), ['灵境 API','ModelScope','OpenAI'], '选项文案');
    eq(rows.map(r => r.dataset.value), ['a','b','c'], '选项值');
    eq(menu.querySelectorAll('.nd-option.active').map(r => r.dataset.value), ['b'], '当前值高亮');
    eq(rows[2].disabled, true, 'disabled 选项在弹层里也禁用');
    eq(menu.style.minWidth, '200px', '菜单至少和 select 一样宽');
    eq(menu.style.left, '40px', '横向对齐 select');

    // 点第 3 条（disabled）不生效
    rows[2].onclick({preventDefault(){}, stopPropagation(){}});
    eq(select.value, 'b', 'disabled 选项点了不改值');
    eq(body.children.length, 1, 'disabled 选项点了也不关菜单');

    // 点第 1 条 → 提交 + 关菜单
    rows[0].onclick({preventDefault(){}, stopPropagation(){}});
    eq(select.value, 'a', '点选项写回 select.value');
    eq(select._events, ['input','change'], 'input 与 change 都发了（onchange / addEventListener 都收得到）');
    eq(body.children.length, 0, '选完关菜单');
}

/* ── 4. 再点一次收起 / 点外面收起 / Esc 收起 ── */
{
    const select = makeSelect(OPTIONS, 0);
    mouseDown(select);
    eq(body.children.length, 1, '打开');
    mouseDown(select);
    eq(body.children.length, 0, '再点同一个 select → 收起');
    mouseDown(select);
    fire('mousedown', {button: 0, target: makeEl('div'), preventDefault(){}, stopPropagation(){}});
    eq(body.children.length, 0, '点外面 → 收起');
    mouseDown(select);
    let prevented = false;
    fire('keydown', {key:'Escape', preventDefault(){ prevented = true; }, stopPropagation(){}});
    eq(body.children.length, 0, 'Esc → 收起');
    ok(!prevented, 'Esc 不需要 preventDefault');
    mouseDown(select);
    fire('keydown', {key:'ArrowDown', preventDefault(){}, stopPropagation(){}});
    eq(body.children[0].querySelectorAll('.nd-option.is-active').length, 1, '方向键移动高亮');
    fire('keydown', {key:'ArrowDown', preventDefault(){}, stopPropagation(){}});
    fire('keydown', {key:'Enter', preventDefault(){}, stopPropagation(){}});
    eq(select.value, 'a', 'Enter 提交高亮项（从当前项往下第二格）');
    eq(body.children.length, 0, 'Enter 后关菜单');
    // disabled select 不接管
    const disabled = makeSelect(OPTIONS, 0, {disabled: true});
    mouseDown(disabled);
    eq(body.children.length, 0, 'disabled select 不开自绘菜单');
}

/* ── 5. 接线：canvas.html 引入 + ?v= + 样式就位 ── */
{
    const root = path.join(__dirname, '..');
    const read = p => fs.readFileSync(path.join(root, p), 'utf8');
    const html = read('static/canvas.html');
    const css = read('static/css/canvas.css');
    const smartHtml = read('static/smart-canvas.html');
    const smartCss = read('static/css/smart-canvas.css');
    ok(/shared\/dropdown\.js\?v=[0-9.]+/.test(html), 'canvas.html 带 ?v= 引入 shared/dropdown.js');
    ok(html.indexOf('shared/dropdown.js') < html.indexOf('/static/js/canvas.js?'), 'dropdown.js 先于 canvas.js 加载');
    ok(/shared\/dropdown\.js\?v=[0-9.]+/.test(smartHtml), 'smart-canvas.html 也带 ?v= 引入（两套画布同一套弹层）');
    ok(/\.nd-menu \{/.test(css), 'canvas.css 有 .nd-menu 弹层样式');
    ok(/\.nd-menu \{/.test(smartCss), 'smart-canvas.css 也有 .nd-menu 弹层样式');
    ok(/\.nd-option\.active \{/.test(css) && /\.nd-option\.active \{/.test(smartCss), '两处都有选中态样式');
    // --card-solid 只在 canvas.css 里定义，smart-canvas 解析不了；弹层底色统一用 marvis-shared 的 --surface
    ok(/\.nd-menu \{[^}]*background:var\(--surface\)/.test(css)
        && /\.nd-menu \{[^}]*background:var\(--surface\)/.test(smartCss), '弹层底色用 marvis-shared 的 --surface');
    const src = read('static/js/shared/dropdown.js');
    ok(src.indexOf("dataset.lucide = 'check'") >= 0, '选中态用 Lucide check 图标（线性）');
    ok(src.indexOf("addEventListener('mousedown', onDocMouseDown, true)") >= 0, 'mousedown 走 capture 阶段');
    ok(src.indexOf("event.preventDefault()") >= 0 && src.indexOf('拦掉原生弹层') >= 0, '说明并拦掉了原生弹层');
}

/* ── 5b. 接线：NovaGlide 滑块（shared/glide.js）接到自绘弹层 ── */
{
    const root = path.join(__dirname, '..');
    const read = p => fs.readFileSync(path.join(root, p), 'utf8');
    const src = read('static/js/shared/dropdown.js');
    ok(src.indexOf('window.NovaGlide') >= 0 && src.indexOf("typeof window.NovaGlide.attach === 'function'") >= 0,
        'dropdown.js 用「存在才调」守卫接 NovaGlide（垫片里没有它，否则一开菜单就抛）');
    ok(/NovaGlide\.attach\(menu, \{ item: '\.nd-option', cursorClass: 'is-active' \}\)/.test(src),
        "attach(menu, {item:'.nd-option', cursorClass:'is-active'})：滑块跟键盘光标（.is-active）");
    ok(src.indexOf('refreshIcons();') < src.indexOf('NovaGlide.attach'),
        'attach 排在 refreshIcons() 之后（lucide 换完 svg 才量几何）');
    const closeBody = (src.match(/function closeMenu\(\)\{([\s\S]*?)\n\}/) || [null, ''])[1];
    ok(/active\.glide\.destroy\(\)/.test(closeBody),
        'closeMenu() 里显式 destroy（菜单一移除就断开 MutationObserver）');

    [['canvas.html', 'css/canvas.css'], ['smart-canvas.html', 'css/smart-canvas.css']].forEach(pair => {
        const html = read('static/' + pair[0]);
        const css = read('static/' + pair[1]);
        const links = html.match(/<link[^>]+rel="stylesheet"[^>]*>/g) || [];
        const at = links.findIndex(tag => /\/static\/css\/glide\.css\?v=[0-9.]+/.test(tag));
        ok(at >= 0, pair[0] + ' 带 ?v= 引入 glide.css');
        ok(at === links.length - 1, pair[0] + ' 的 glide.css 排在其它的 <link rel="stylesheet"> 之后');
        ok(/shared\/glide\.js\?v=[0-9.]+/.test(html), pair[0] + ' 带 ?v= 引入 shared/glide.js');
        ok(/\.nd-menu \{ --nv-glide-bg: var\(--nav-hover-bg\); \}/.test(css),
            pair[1] + ' 滑块底色 = --nav-hover-bg（真·hover token，两个主题都亮过面板）');
        // --surface-2 浅色看不见；--soft 深色被 theme.css 重定义成 --bg，会比面板还深
        ok(!/--nv-glide-bg: var\(--(surface-2|soft)\)/.test(css),
            pair[1] + ' 不用 --surface-2、也不用会被 theme.css 改写的 --soft');
        ok(/\.nd-menu\.nv-glide-host \.nd-option\.active \{ color: var\(--text\); \}/.test(css),
            pair[1] + ' 滑块 host 内选中项文字回到 --text（否则浅色下 --strong-text 白字不可见）');
    });
}

/* ── 5c. 滚轮：弹层内部不关（长列表要能滚），外部照旧关；resize 照旧关 ── */
{
    const fireWin = (type, event) => (winListeners[type] || []).forEach(fn => fn(event));
    ok((winListeners.wheel || []).length > 0 && (winListeners.resize || []).length > 0,
        'install() 分别注册了 window 级 wheel 与 resize');
    const wheelEvt = target => ({target, preventDefault(){}, stopPropagation(){}});

    const select = makeSelect(OPTIONS, 1);
    mouseDown(select);
    eq(body.children.length, 1, '（前置）菜单已打开');
    const menu = body.children[0];
    const option = menu.querySelectorAll('.nd-option')[1];

    fireWin('wheel', wheelEvt(option));
    eq(body.children.length, 1, '滚轮落在选项上 → 菜单不关（列表才滚得动）');
    fireWin('wheel', wheelEvt(menu));
    eq(body.children.length, 1, '滚轮落在弹层空白处 → 也不关');
    fireWin('wheel', wheelEvt(option));
    fireWin('wheel', wheelEvt(option));
    eq(body.children.length, 1, '连续滚（触控板惯性余量）→ 仍然不关');

    fireWin('wheel', wheelEvt(makeEl('div')));
    eq(body.children.length, 0, '滚轮落在弹层外面 → 照旧关（原意图保留）');

    mouseDown(select);
    eq(body.children.length, 1, '（前置）再次打开');
    fireWin('resize', {});
    eq(body.children.length, 0, 'resize → 照旧关（弹层位置会失效）');
}

console.log('通过 ' + pass + '/' + (pass + fails.length));
if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('全部通过');
