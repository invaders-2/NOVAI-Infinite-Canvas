/* NOVAI 自绘下拉弹层。
   原生 <select> 的**弹层**由浏览器绘制，圆角/字号/内外边距/深浅色都不可控 ——
   深色主题下 option 白底白字就是这么来的（.theme-dark .select-lite option 那两条）。

   这里不替换 select，只在展开时接管：
   - 收起状态仍然是原来的 .select-lite（那本来就是我们的设计语言），布局零风险；
   - 展开时自绘一个 .nd-menu（沿用 .canvas-meta-pop + .menu-btn 这套弹层语言），
     并拦掉原生弹层。

   为什么用「拦 mousedown」而不是「隐藏 select + 自绘触发器」：
   - 一行调用方代码都不用改：value / onchange / options / disabled 全是原生的；
   - 节点每次重绘都会重建 select，逐个绑定会漏；这里在 document 上做事件委托；
   - 万一某个浏览器拦不住原生弹层，退化的也只是「又弹了一次原生列表」，
     不会变成「点了没反应」。

   shared/dropdown.js，canvas.html 在 canvas.js 之前引入；它会自己 install()。 */
(function(){
'use strict';

const MENU_CLASS = 'nd-menu';
const OPTION_CLASS = 'nd-option';
const ACTIVE_CLASS = 'active';
const HILITE_CLASS = 'is-active';
const MENU_MAX_HEIGHT = 320;
const EDGE_MARGIN = 8;
const GAP = 6;

let active = null;   // {select, menu, index}
let installed = false;

function doc(){ return typeof document === 'undefined' ? null : document; }

/* select 的 options → 弹层条目模型。OPTGROUP 变成一次分组标题。
   纯函数，方便测试。 */
function itemsFor(select){
    const out = [];
    if(!select || !select.options) return out;
    const selectedIndex = Number(select.selectedIndex);
    let lastGroup = null;
    for(let index = 0; index < select.options.length; index += 1){
        const option = select.options[index];
        const parent = option.parentNode;
        const group = parent && parent.tagName === 'OPTGROUP' ? String(parent.label || '') : '';
        // 只跟「上一个分组」比：连续同一个 optgroup 只出一个标题
        if(group && group !== lastGroup) out.push({type:'group', label:group});
        lastGroup = group || null;
        out.push({
            type:'option',
            value: String(option.value === null || option.value === undefined ? '' : option.value),
            label: String(option.textContent || ''),
            disabled: Boolean(option.disabled),
            active: index === selectedIndex
        });
    }
    return out;
}

/* 弹层落点：贴在 anchor 下沿，放不下就翻到上沿，左右夹在视口内。纯函数。 */
function placeFor(anchor, size, viewport, margin){
    const gap = Number.isFinite(Number(margin)) ? Number(margin) : EDGE_MARGIN;
    const width = Math.max(0, Number(size && size.width) || 0);
    const height = Math.max(0, Number(size && size.height) || 0);
    const vw = Math.max(1, Number(viewport && viewport.width) || 0);
    const vh = Math.max(1, Number(viewport && viewport.height) || 0);
    const left = Math.min(Math.max(Number(anchor && anchor.left) || 0, gap), Math.max(gap, vw - width - gap));
    let top = (Number(anchor && anchor.bottom) || 0) + GAP;
    let flip = false;
    if(top + height > vh - gap){
        const above = (Number(anchor && anchor.top) || 0) - height - GAP;
        if(above >= gap){ top = above; flip = true; }
        else top = Math.max(gap, vh - height - gap);
    }
    return {left: Math.round(left), top: Math.round(top), width: Math.round(width), flip};
}

function refreshIcons(){
    if(typeof window === 'undefined') return;
    if(window.NovaUtils && typeof window.NovaUtils.refreshIcons === 'function'){ window.NovaUtils.refreshIcons(); return; }
    if(window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons({icons: window.lucide.icons});
}

function closeMenu(){
    /* 菜单是每次 open 新建、close 直接扔掉的：挂在它身上的 MutationObserver / 事件监听
       虽然会跟着节点一起变成垃圾，但删节点前显式 destroy 才是确定的，也顺手停掉排队中的 rAF。 */
    if(active && active.glide && typeof active.glide.destroy === 'function') active.glide.destroy();
    if(active && active.menu && active.menu.parentNode) active.menu.parentNode.removeChild(active.menu);
    active = null;
}

function optionEls(menu){ return menu ? Array.prototype.slice.call(menu.querySelectorAll('.' + OPTION_CLASS)) : []; }

function paintHighlight(){
    if(!active) return;
    optionEls(active.menu).forEach((el, index) => el.classList.toggle(HILITE_CLASS, index === active.index));
}

function moveHighlight(step){
    if(!active) return;
    const list = optionEls(active.menu);
    if(!list.length) return;
    let index = active.index;
    for(let guard = 0; guard < list.length; guard += 1){
        index = (index + step + list.length) % list.length;
        if(!list[index].disabled){ active.index = index; break; }
    }
    paintHighlight();
    const el = list[active.index];
    if(el && typeof el.scrollIntoView === 'function') el.scrollIntoView({block:'nearest'});
}

function commit(select, value){
    if(!select) return;
    if(String(select.value) !== String(value)) select.value = value;
    /* 原生 select 变更时 input 与 change 都会发，这里对齐，onchange / addEventListener 都收得到 */
    if(typeof Event === 'function' && select.dispatchEvent){
        select.dispatchEvent(new Event('input', {bubbles:true}));
        select.dispatchEvent(new Event('change', {bubbles:true}));
    } else if(typeof select.onchange === 'function'){
        select.onchange({target:select});
    }
}

function open(select){
    closeMenu();
    const d = doc();
    if(!d || !select || select.disabled) return null;
    const items = itemsFor(select);
    if(!items.length) return null;

    const menu = d.createElement('div');
    menu.className = MENU_CLASS;
    menu.setAttribute('role', 'listbox');
    let index = -1;
    items.forEach(item => {
        if(item.type === 'group'){
            const title = d.createElement('div');
            title.className = 'menu-section-title';
            title.textContent = item.label;
            menu.appendChild(title);
            return;
        }
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'menu-btn ' + OPTION_CLASS + (item.active ? ' ' + ACTIVE_CLASS : '');
        row.dataset.value = item.value;
        const label = d.createElement('span');
        label.className = 'nd-option-label';
        label.textContent = item.label;
        row.appendChild(label);
        const check = d.createElement('i');
        check.dataset.lucide = 'check';
        check.className = 'nd-check';
        row.appendChild(check);
        if(item.disabled) row.disabled = true;
        row.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            if(item.disabled) return;   // disabled button 本来也不会派发 click，这里再兜一层
            commit(select, item.value);
            closeMenu();
            if(typeof select.focus === 'function') select.focus();
        };
        if(item.active && index < 0) index = optionEls(menu).length;
        menu.appendChild(row);
    });

    if(typeof d.body.appendChild === 'function') d.body.appendChild(menu);

    const rect = (typeof select.getBoundingClientRect === 'function'
        ? select.getBoundingClientRect()
        : {left:0, top:0, bottom:0, width:0});
    const win = typeof window === 'undefined' ? null : window;
    const size = {width: Math.max(rect.width || 0, 148), height: menu.offsetHeight || Math.min(MENU_MAX_HEIGHT, items.length * 34 + 12)};
    const spot = placeFor(
        {left: rect.left, top: rect.top, bottom: rect.bottom},
        size,
        {width: (win && win.innerWidth) || 0, height: (win && win.innerHeight) || 0}
    );
    menu.style.left = spot.left + 'px';
    menu.style.top = spot.top + 'px';
    menu.style.minWidth = size.width + 'px';

    // 用户没点过的下拉，高亮当前值所在那一条，并滚到可见位置
    const rows = optionEls(menu);
    active = {select, menu, index: index >= 0 ? index : -1};
    if(active.index >= 0){
        paintHighlight();
        const row = rows[active.index];
        if(row && typeof row.scrollIntoView === 'function') row.scrollIntoView({block:'nearest'});
    }
    refreshIcons();
    /* 滑块高亮交给通用模块（NovaGlide = shared/glide.js）。
       放在 refreshIcons() 之后：lucide 会把 <i data-lucide="check"> 换成 <svg>，几何要以换完的 DOM 为准。
       cursorClass 用 .is-active —— 键盘光标就是这个类（.active 是当前选中的值），
       于是「指针在容器内跟指针、否则跟光标、否则跟选中值」正好对上。存在才调：
       测试垫片和没引 glide.js 的页面没有 window.NovaGlide，这里不能抛。 */
    if(window.NovaGlide && typeof window.NovaGlide.attach === 'function'){
        active.glide = window.NovaGlide.attach(menu, { item: '.nd-option', cursorClass: 'is-active' });
    }
    return menu;
}

function selectFromEvent(event){
    const target = event && event.target;
    if(!target || typeof target.closest !== 'function') return null;
    const select = target.closest('select');
    return select && !select.disabled ? select : null;
}

function onSelectMouseDown(event, select){
    if(event.button !== 0) return;
    if(active && active.select === select && active.menu && active.menu.parentNode){
        // 再点一次收起
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        return;
    }
    /* 关键：preventDefault 拦掉原生弹层；stopPropagation 避免画布把这次 mousedown 当成拖节点 */
    event.preventDefault();
    event.stopPropagation();
    if(typeof select.focus === 'function') select.focus();
    open(select);
}

function onDocMouseDown(event){
    const select = selectFromEvent(event);
    if(select){ onSelectMouseDown(event, select); return; }
    if(active) onOutsideMouseDown(event);
}

/* 万一某个浏览器还是弹了原生列表、用户在那儿选了值：跟着关掉自绘菜单 */
function onDocChange(event){
    const target = event && event.target;
    if(!active || !target || target !== active.select) return;
    closeMenu();
}

/* 少数浏览器在 click 阶段才开原生弹层，这里再兜一层 */
function onDocClick(event){
    if(!active) return;
    const select = selectFromEvent(event);
    if(select && active.select === select){
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    if(active.menu && active.menu.contains && active.menu.contains(event.target)) return;
    closeMenu();
}

function onKeyDown(event){
    if(!active){
        const select = selectFromEvent(event);
        if(!select) return;
        if(['ArrowDown','ArrowUp',' ','Enter'].indexOf(event.key) < 0) return;
        event.preventDefault();
        open(select);
        return;
    }
    const key = event.key;
    if(key === 'Escape' || key === 'Tab'){ closeMenu(); return; }
    if(key === 'ArrowDown'){ event.preventDefault(); moveHighlight(1); return; }
    if(key === 'ArrowUp'){ event.preventDefault(); moveHighlight(-1); return; }
    if(key === 'Enter' || key === ' '){
        event.preventDefault();
        const row = optionEls(active.menu)[active.index];
        if(row && !row.disabled){
            commit(active.select, row.dataset.value);
            closeMenu();
        }
    }
}

function onOutsideMouseDown(event){
    if(!active) return;
    if(active.menu && active.menu.contains && active.menu.contains(event.target)) return;
    closeMenu();
}

function onViewportChange(){ closeMenu(); }

/* 滚轮单独处理：.nd-menu 是 max-height:320px + overflow:auto，长列表本来就该能滚。
   以前任何 wheel 都无条件 closeMenu，用户想在列表里往下滚，第一下就把菜单关了。
   现在只有滚轮落在弹层外面才关；弹层内部（含滚到顶/底后的惯性余量）一律不管，交给浏览器原生滚动。
   关闭仍有 点外面 / Esc / 选中一项 三条路。 */
function onWheel(event){
    if(active && active.menu && active.menu.contains && event && active.menu.contains(event.target)) return;
    closeMenu();
}

/* 画布上的 select 是节点重绘时动态生成的，所以用事件委托而不是逐个绑定。
   install() 幂等。 */
function install(){
    const d = doc();
    if(installed || !d || !d.addEventListener) return false;
    installed = true;
    /* capture 阶段：先于画布的拖拽/缩放逻辑拿到这次 mousedown */
    d.addEventListener('mousedown', onDocMouseDown, true);
    d.addEventListener('click', onDocClick, true);
    d.addEventListener('change', onDocChange, true);
    d.addEventListener('keydown', onKeyDown, true);
    if(window){
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('wheel', onWheel, {passive:true});
    }
    return true;
}

const api = {install, open, close: closeMenu, itemsFor, placeFor, MENU_CLASS, OPTION_CLASS};
if(typeof window !== 'undefined') window.NovaSelectMenu = api;
if(typeof module !== 'undefined' && module.exports) module.exports = api;
if(typeof document !== 'undefined') install();
})();
