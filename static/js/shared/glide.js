/* NOVAI 通用「滑块高亮」动效模块（移植 ReactBits GlideSelect 的 pill 交互）。

   为什么不给每个选项加 :hover 底色，而是单独养一个滑块：
   悬停/选中/键盘光标三条路径都会改「谁被点亮」，各画各的底色就会逐格闪、且三套状态迟早对不上；
   收敛到一个元素上，指针划过整列是一条连续的轨。

   三条输入源统一收敛到 pickActive 一条规则，所以调用方不需要改自己的选择逻辑：
   .nd-menu 的 moveHighlight 照旧只切 .is-active，这里用 MutationObserver 接住，
   键盘移动瞬间到位（不滑动），指针悬停才滑。

   几何一律 getBoundingClientRect 差值，不按 index × 行高：
   分组标题、左右双列、grid 网格、行高不一致的列表都会算错。
   位移永远写成 translate(x, y) 二维形式 —— 目标布局可能是 grid / 双列，
   只写 translateY 会在同一行里横向错位。orientation 仅作语义标注，不参与几何。

   目标可能落在滚动容器里（.nd-menu 有 padding + overflow:auto）：
   绝对定位的包含块是 padding box 且随内容滚动，所以坐标要减 clientLeft/clientTop、加 scrollLeft/scrollTop，
   否则一旦列表滚动，边框和滚动量就会变成固定偏移。

   画布里的菜单处在 #world 的 transform: scale() 之下，rect 已经被缩放乘过一轮，
   写 translate 必须除回祖先累计缩放（localScale），否则滑块整体偏移。

   MutationObserver 里最危险的是自激：paint 会改容器的 nv-glide-instant，
   若回调对「容器 class 变化」也重新 paint，就会 observer → paint → observer 无限循环把页面卡死。
   所以回调只对「选项（非容器）的 class 变化」重新定位，容器自身的 class 变化用 selfClassWrites 记账后直接吞掉。

   纯函数（pickActive / toLocalRect / scanItems）单独导出，node 单测直接断言。

   shared/glide.js，必须排在 shared/utils.js 之后引入；样式见 css/glide.css。 */
(function(){
'use strict';

const HOST_CLASS = 'nv-glide-host';
const PILL_CLASS = 'nv-glide-pill';
const ITEM_ATTR = 'data-nv-glide-item';
const INSTANT_CLASS = 'nv-glide-instant';
const DURATION_VAR = '--nv-glide-ms';

const DEFAULTS = {
    item: '',
    orientation: 'vertical',
    activeClass: 'active',
    cursorClass: '',
    duration: 220,
    inset: 0
};

/* 激活项优先级：指针悬停项 > cursorClass（键盘光标）> activeClass（当前选中）> 隐藏。
   hoverEl 只在「指针确实落在某一项上」时给，指针离开容器才清空。 */
function pickActive(input){
    const state = input || {};
    return state.hoverEl || state.cursorEl || state.activeEl || null;
}

/* screen 坐标 → 容器自身坐标。
   scale 是祖先累计缩放（#world 的 transform / zoom）；
   frame 是容器的 clientLeft / clientTop / scrollLeft / scrollTop——
   绝对定位的包含块是 padding box 且随内容滚动，减边框、加滚动量才能贴住目标。 */
function toLocalRect(rect, containerRect, scale, frame){
    const raw = Number(scale);
    const factor = Number.isFinite(raw) && raw > 0 ? raw : 1;
    const box = rect || {};
    const host = containerRect || {};
    const view = frame || {};
    const num = value => Number(value) || 0;
    return {
        left: (num(box.left) - num(host.left)) / factor - num(view.clientLeft) + num(view.scrollLeft),
        top: (num(box.top) - num(host.top)) / factor - num(view.clientTop) + num(view.scrollTop),
        width: num(box.width) / factor,
        height: num(box.height) / factor
    };
}

/* 容器内匹配 selector 的元素；滑块自己也是容器的子元素，
   选择器宽松到 'span' / '*' 时不能把它当成一个选项。 */
function scanItems(container, selector){
    if(!container || !selector || typeof container.querySelectorAll !== 'function') return [];
    let found;
    try { found = container.querySelectorAll(selector); }
    catch(error){ return []; }   // 调用方给了非法选择器，不该把整页拖崩
    const out = [];
    Array.prototype.forEach.call(found, el => {
        if(!el || !el.classList || el.classList.contains(PILL_CLASS)) return;
        out.push(el);
    });
    return out;
}

function reducedMotion(){
    return !!(typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* 祖先累计缩放：zoom 直接乘，transform 取矩阵的 hypot(a, b)。
   从容器自己开始往上走 —— 容器自身带 scale 时，滑块作为子元素同样被缩放。 */
function localScale(node){
    let scale = 1;
    for(let current = node; current; current = current.parentElement){
        const style = window.getComputedStyle(current);
        if(!style) continue;
        const zoom = parseFloat(style.zoom);
        if(zoom > 0) scale *= zoom;
        const transform = style.transform;
        if(transform && transform !== 'none'){
            const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
            if(values.length >= 4) scale *= Math.hypot(values[0], values[1]) || 1;
        }
    }
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function attach(container, options){
    if(!container || typeof container.querySelectorAll !== 'function') return null;
    const conf = Object.assign({}, DEFAULTS, options || {});
    if(!conf.item) return null;
    /* 同一容器重复 attach（弹层每次打开都调一次）不能叠出两个滑块 */
    if(container.__nvGlide && typeof container.__nvGlide.destroy === 'function') container.__nvGlide.destroy();

    const horizontal = conf.orientation === 'horizontal';
    const inset = Number(conf.inset) > 0 ? Number(conf.inset) : 0;
    const duration = Number(conf.duration) > 0 ? Number(conf.duration) : DEFAULTS.duration;
    const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : fn => setTimeout(fn, 16);
    const cancelRaf = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : id => clearTimeout(id);

    container.classList.add(HOST_CLASS);
    container.style.setProperty(DURATION_VAR, duration + 'ms');
    /* static 定位的容器放不住绝对定位的滑块，临时补一个 relative；原值留着 destroy 还原 */
    const originalPosition = container.style.position;
    const patchedPosition = window.getComputedStyle(container).position === 'static';
    if(patchedPosition) container.style.position = 'relative';

    const pill = document.createElement('span');
    pill.className = PILL_CLASS;
    pill.setAttribute('aria-hidden', 'true');
    container.insertBefore(pill, container.firstChild);

    let items = [];
    let hoverEl = null;
    /* undefined = 没被接管，按类推；null = 显式隐藏；元素 = 显式指定。
       显式接管必须能压过类，否则 clear() 会被下一次类变化立刻推翻。 */
    let pin;
    let shown = false;
    let scrollFrame = 0;
    let lastTransform = '';
    /* 自己动容器 class 的记账：MutationObserver 回调里要认出「这条是我写的」，
       否则 nv-glide-instant 的增删会自激成死循环 */
    let selfClassWrites = 0;

    const setInstantClass = on => {
        if(container.classList.contains(INSTANT_CLASS) === on) return;
        selfClassWrites += 1;
        container.classList.toggle(INSTANT_CLASS, on);
    };

    const byClass = name => (name ? items.find(el => el.classList.contains(name)) : null) || null;
    const resolve = () => {
        if(pin !== undefined) return pin;
        return pickActive({
            hoverEl: hoverEl,
            cursorEl: byClass(conf.cursorClass),
            activeEl: byClass(conf.activeClass)
        });
    };

    /* 瞬移的值必须先落地，再撤掉 transition:none，否则浏览器会把它当成一次过渡的起点补一段动画 */
    const finish = jump => {
        if(!jump) return;
        void container.offsetWidth;
        setInstantClass(false);
    };

    const hide = jump => {
        if(!shown) return;   /* 已经是隐藏态就别写样式，省掉一串无意义的过渡属性变更 */
        shown = false;
        setInstantClass(jump);
        pill.style.opacity = '0';
        finish(jump);
    };

    /* 目标项 rect 换算成容器坐标（内容空间）。display:none 的选项 rect 全是 0，
       换算出来是容器外的野坐标，这种情况返回 null 让调用方隐藏滑块。 */
    const measure = target => {
        const rect = target && typeof target.getBoundingClientRect === 'function'
            ? target.getBoundingClientRect() : null;
        if(!rect || (!rect.width && !rect.height)) return null;
        const local = toLocalRect(rect, container.getBoundingClientRect(), localScale(container), {
            clientLeft: container.clientLeft,
            clientTop: container.clientTop,
            scrollLeft: container.scrollLeft,
            scrollTop: container.scrollTop
        });
        const left = local.left + inset;
        const top = local.top + inset;
        return {
            left: left,
            top: top,
            transform: 'translate(' + left + 'px, ' + top + 'px)',
            width: Math.max(0, local.width - inset * 2),
            height: Math.max(0, local.height - inset * 2)
        };
    };

    const paint = (target, instant) => {
        const jump = instant === true || reducedMotion();
        const box = measure(target);
        if(!box){ hide(jump); return; }
        setInstantClass(jump);
        pill.style.transform = box.transform;
        pill.style.width = box.width + 'px';
        pill.style.height = box.height + 'px';
        pill.style.opacity = '1';
        lastTransform = box.transform;
        shown = true;
        finish(jump);
    };

    const refresh = () => {
        const next = scanItems(container, conf.item);
        next.forEach(el => el.setAttribute(ITEM_ATTR, ''));
        items.forEach(el => { if(next.indexOf(el) < 0) el.removeAttribute(ITEM_ATTR); });
        items = next;
        if(hoverEl && next.indexOf(hoverEl) < 0) hoverEl = null;
        if(pin && next.indexOf(pin) < 0) pin = undefined;
        paint(resolve(), true);   /* 内容被重写后滑块不该横穿整个弹层，直接落位 */
    };

    const onPointerOver = event => {
        if(event.pointerType === 'touch') return;   /* 触屏没有 hover，别抢点击反馈 */
        const target = event.target;
        if(!target || typeof target.closest !== 'function') return;
        const item = target.closest('[' + ITEM_ATTR + ']');
        if(!item || !container.contains(item) || item === hoverEl) return;
        hoverEl = item;
        /* 第一次出现没有起点，直接落位；之后才从上一项滑过来 */
        paint(item, !shown);
    };

    const onPointerLeave = () => {
        if(!hoverEl) return;
        hoverEl = null;
        paint(resolve(), false);   /* 回到类决定的激活项，这一段要滑 */
    };

    /* 容器（或容器内的滚动区）滚动时重新对齐。
       目标是内容空间坐标，滚动本身不改变它，所以值没变时直接跳过 ——
       否则这一次瞬移会把正在滑的过渡打断成跳变（按住滚轮划过菜单时最明显）。
       值真变了才重画（滚动条出现/消失改了 clientLeft，或滚动期间类变了）。 */
    const onScroll = () => {
        if(scrollFrame) return;
        scrollFrame = raf(() => {
            scrollFrame = 0;
            const target = resolve();
            const box = measure(target);
            if(shown && box && box.transform === lastTransform) return;
            paint(target, true);
        });
    };

    const observer = new MutationObserver(records => {
        let contentChanged = false;
        let itemChanged = false;
        records.forEach(record => {
            if(record.type === 'childList'){
                const nodes = Array.prototype.slice.call(record.addedNodes)
                    .concat(Array.prototype.slice.call(record.removedNodes));
                /* 滑块自己插进来也是 childList 变更，认出来别让它再触发一轮 */
                if(nodes.length && nodes.every(node => node === pill)) return;
                contentChanged = true;   /* 内容重写：选项可能整套换掉，要重新打标记 */
                return;
            }
            if(record.target === container){
                /* 容器自己的 class 变化：自己写的吞掉（不重画，否则自激），
                   外部写的当作布局可能变了，走 refresh 而不是重画 */
                if(selfClassWrites > 0){ selfClassWrites -= 1; return; }
                contentChanged = true;
                return;
            }
            itemChanged = true;   /* 选项的 class 变化 = 键盘上下键改 .is-active */
        });
        if(contentChanged) refresh();
        else if(itemChanged) paint(resolve(), true);
    });
    observer.observe(container, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class']
    });

    container.addEventListener('pointerover', onPointerOver);
    container.addEventListener('pointerleave', onPointerLeave);
    /* 捕获阶段：容器的滚动事件不冒泡，内部滚动区的事件也收不到，只有捕获能全覆盖 */
    container.addEventListener('scroll', onScroll, true);

    refresh();

    const controller = {
        setActive(el, opts){
            pin = el && typeof el.getBoundingClientRect === 'function' ? el : null;
            paint(pin, !!(opts && opts.instant) || !shown);
            return controller;
        },
        clear(){
            pin = null;
            paint(null, false);
            return controller;
        },
        refresh(){ refresh(); return controller; },
        orientation: horizontal ? 'horizontal' : 'vertical',
        destroy(){
            observer.disconnect();
            if(scrollFrame) cancelRaf(scrollFrame);
            scrollFrame = 0;
            container.removeEventListener('pointerover', onPointerOver);
            container.removeEventListener('pointerleave', onPointerLeave);
            container.removeEventListener('scroll', onScroll, true);
            if(pill.parentNode) pill.parentNode.removeChild(pill);
            items.forEach(el => el.removeAttribute(ITEM_ATTR));
            items = [];
            hoverEl = null;
            pin = undefined;
            shown = false;
            lastTransform = '';
            container.classList.remove(HOST_CLASS);
            container.classList.remove(INSTANT_CLASS);
            container.style.removeProperty(DURATION_VAR);
            if(patchedPosition) container.style.position = originalPosition;
            delete container.__nvGlide;
        }
    };
    container.__nvGlide = controller;
    return controller;
}

const api = {
    attach,
    pickActive,
    toLocalRect,
    scanItems,
    HOST_CLASS,
    PILL_CLASS,
    ITEM_ATTR,
    INSTANT_CLASS
};
if(typeof window !== 'undefined') window.NovaGlide = api;
if(typeof module !== 'undefined' && module.exports) module.exports = api;
})();
