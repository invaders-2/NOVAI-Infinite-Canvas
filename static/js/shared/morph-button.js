/* NOVAI 通用「状态按钮」动效模块（移植 Spectrum UI MorphButton 的状态机与动效，
   只搬行为，不搬它的胶囊形状与中性配色：按钮 idle 外观完全保持各页原样）。

   为什么不包装全局函数：主画布那批按钮根本没有 inline onclick（运行时 el.onclick = 闭包，
   或者只靠面板事件委托），包装 window 上的函数覆盖不到；改成接管元素自己的这次点击，
   影响面也只有这一个按钮。

   为什么监听挂在元素自身、且必须是捕获阶段：
   实测（Chromium）target 元素上后注册的捕获监听先于行内 onclick 执行，
   所以能先读到 el.onclick、把它置空、再自己调一次；
   置空是必须的，否则事件继续走完 target 阶段时浏览器会再调一次行内处理器 → 原动作跑两遍。

   为什么置空后还要缓存：置空只对当前这次点击负责，下一次点击 el.onclick 已经是 null，
   不缓存的话按钮点一次就废了（页面若重新赋值 onclick，点击瞬间读到的新值会覆盖缓存）。

   为什么把「resolve 出 false」「动作期间弹过 alert」判成 error：
   本仓库的异步保存函数自己 try/catch，失败时 alert/toast 后 return false，
   promise 永远 resolve；只看 then/catch 会把失败画成绿色的成功态。
   alert 探针只在动作进行期间生效，动作结束立刻还原 window.alert。

   为什么状态层与原始内容分成两层：
   宽度 morph 要量「新内容的自然宽度」，状态层就必须参与布局；
   原始内容退成绝对定位淡出，两层都居中，切换时不会互相挤位。

   shared/morph-button.js；样式自带一次注入，类名统一 nv-morph 前缀。 */
(function () {
'use strict';

const STYLE_ID = 'nv-morph-style';
const HOST_CLASS = 'nv-morph';
const INNER_CLASS = 'nv-morph-inner';
const STATE_CLASS = 'nv-morph-state';
const LIVE_CLASS = 'nv-morph-live';
const STATE_ATTR = 'data-nv-morph-state';
const SELECTOR = 'button, [role="button"]';
const STATES = ['idle', 'loading', 'success', 'error'];

/* 动效参数照抄参考实现：时长/缓动/位移不改，改了就只剩「像」而不是「是」 */
const CONTENT_SHIFT = 8;
const CONTENT_DURATION = 300;
const DRAW_DURATION = 250;
const SHAKE_DURATION = 250;
const SHAKE_KEYFRAMES = [0, -3, 3, -2, 2, 0];
const WIDTH_DURATION = 280;
const SPIN_DURATION = 800;
const SPIN_ARC = 0.75;
const SPINNER_RADIUS = 10;
const EASE_REVEAL = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_SPRING = 'cubic-bezier(0.34, 1.3, 0.64, 1)';
const DEFAULT_RESET_DELAY = 1800;
const DEFAULT_MIN_LOADING = 300;

const CHECK_PATH = 'M5 13l4.5 4.5L19 7';
const X_PATHS = ['M7 7l10 10', 'M17 7L7 17'];
const SUCCESS_BG = '#10b981';
const ERROR_BG = '#f43f5e';

/* 白名单：只认这些开头，避免把「删除/取消/测试」这类按钮也卷进状态机 */
const TEXT_WHITELIST = ['应用到模型列表', '保存配置', '保存设置', '保存更改', '保存', '确定', '确认', '应用'];

const CSS = [
    '.nv-morph { position: relative; box-sizing: border-box; overflow: hidden; }',
    '.nv-morph > .nv-morph-inner { display: inline-flex; align-items: center; justify-content: center;' +
        ' transition: opacity ' + CONTENT_DURATION + 'ms ' + EASE_REVEAL + ', transform ' + CONTENT_DURATION + 'ms ' + EASE_REVEAL + '; }',
    '.nv-morph > .nv-morph-state { display: none; align-items: center; justify-content: center; white-space: nowrap; }',
    '.nv-morph:not([' + STATE_ATTR + '="idle"]) > .nv-morph-state { display: inline-flex; }',
    '.nv-morph:not([' + STATE_ATTR + '="idle"]) > .nv-morph-inner { position: absolute; inset: 0; justify-content: center;' +
        ' opacity: 0; transform: translateY(-' + CONTENT_SHIFT + 'px); pointer-events: none; }',
    '.nv-morph[' + STATE_ATTR + '="success"] { background: ' + SUCCESS_BG + ' !important; border-color: ' + SUCCESS_BG + ' !important; color: #fff !important; }',
    '.nv-morph[' + STATE_ATTR + '="error"] { background: ' + ERROR_BG + ' !important; border-color: ' + ERROR_BG + ' !important; color: #fff !important; }',
    '.nv-morph:not([' + STATE_ATTR + '="idle"]) { cursor: default; }',
    '.nv-morph .nv-morph-state svg { display: block; flex: 0 0 auto; }',
    '.nv-morph .nv-morph-spin { transform-origin: 50% 50%; }',
    '.nv-morph-live { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;' +
        ' clip: rect(0 0 0 0); white-space: nowrap; border: 0; }',
    '@media (prefers-reduced-motion: reduce) { .nv-morph > .nv-morph-inner, .nv-morph > .nv-morph-state { transition: none !important; } }'
].join('\n');

let styleInjected = false;
const alertWatch = { count: 0, fired: false, original: null };

/* ── 基础工具 ─────────────────────────────────────────────────────────── */

function reduceMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function injectStyle() {
    if (styleInjected || document.getElementById(STYLE_ID)) { styleInjected = true; return; }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    styleInjected = true;
}

function visibleText(el) {
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function matchesWhitelist(el) {
    const text = visibleText(el);
    return TEXT_WHITELIST.some(prefix => text.indexOf(prefix) === 0);
}

/* onclick="fnName(字面量参数…)" 才在绑定时摘属性转成 action；
   多语句或复杂表达式的行内处理器不动它，交给点击瞬间的接管路径，
   那条路径把整段行内代码原样执行，语义最稳。 */
function parseInlineCall(raw) {
    const match = /^\s*(?:window\.)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(raw || '');
    if (!match) return null;
    const args = parseLiteralArgs(match[2]);
    if (!args) return null;
    return { name: match[1], args: args };
}

function parseLiteralArgs(source) {
    const text = String(source || '').trim();
    if (!text) return [];
    const parts = [];
    let depth = 0, quote = '', current = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            current += ch;
            if (ch === '\\') { current += text[i + 1] || ''; i += 1; continue; }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    parts.push(current);
    const values = [];
    for (let i = 0; i < parts.length; i += 1) {
        const token = parts[i].trim();
        if (/^-?\d+(\.\d+)?$/.test(token)) { values.push(Number(token)); continue; }
        if (/^'(?:[^'\\]|\\.)*'$/.test(token) || /^"(?:[^"\\]|\\.)*"$/.test(token)) {
            values.push(token.slice(1, -1).replace(/\\(.)/g, '$1'));
            continue;
        }
        if (token === 'true') { values.push(true); continue; }
        if (token === 'false') { values.push(false); continue; }
        if (token === 'null') { values.push(null); continue; }
        if (token === 'undefined') { values.push(undefined); continue; }
        return null;   /* 认不出的参数就不摘属性，走点击瞬间的接管路径 */
    }
    return values;
}

function isBindable(el) {
    if (el.hasAttribute('data-morph')) return true;
    if (!matchesWhitelist(el)) return false;
    return typeof el.onclick === 'function' || el.hasAttribute('onclick');
}

function announceKey(text) {
    if (text.indexOf('保存') >= 0) return 'save';
    if (text.indexOf('更新') >= 0) return 'update';
    if (text.indexOf('应用') >= 0) return 'apply';
    return 'default';
}

const ANNOUNCE = {
    save:    { loading: '正在保存…', success: '已保存', error: '保存失败' },
    update:  { loading: '正在更新…', success: '已更新', error: '更新失败' },
    apply:   { loading: '正在应用…', success: '已应用', error: '应用失败' },
    default: { loading: '处理中…', success: '已完成', error: '操作失败' }
};

/* ── alert 探针：动作期间弹过 alert 即视为失败信号 ──────────────────────── */

function watchAlertStart() {
    if (typeof window.alert !== 'function') return;
    if (alertWatch.count === 0) {
        alertWatch.fired = false;
        alertWatch.original = window.alert;
        const original = alertWatch.original;
        window.alert = function () {
            alertWatch.fired = true;
            return original.apply(this, arguments);
        };
    }
    alertWatch.count += 1;
}

function watchAlertStop() {
    if (alertWatch.count === 0) return false;
    alertWatch.count -= 1;
    if (alertWatch.count === 0 && alertWatch.original) {
        window.alert = alertWatch.original;
        alertWatch.original = null;
    }
    return alertWatch.fired;
}

/* ── 状态渲染 ─────────────────────────────────────────────────────────── */

function svgEl(name) {
    return document.createElementNS('http://www.w3.org/2000/svg', name);
}

function spinnerSvg(size) {
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('nv-morph-spin');
    const circle = svgEl('circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', String(SPINNER_RADIUS));
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2.5');
    circle.setAttribute('stroke-linecap', 'round');
    const circumference = 2 * Math.PI * SPINNER_RADIUS;
    circle.setAttribute('stroke-dasharray', (circumference * SPIN_ARC) + ' ' + circumference);
    svg.appendChild(circle);
    return svg;
}

function drawnSvg(paths, size) {
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(d => {
        const path = svgEl('path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    });
    return svg;
}

function drawPath(path, delay, instant) {
    let length = 0;
    try { length = path.getTotalLength(); } catch (e) { length = 0; }
    if (!length) return;
    path.style.strokeDasharray = String(length);
    if (instant) { path.style.strokeDashoffset = '0'; return; }
    path.style.strokeDashoffset = String(length);
    path.animate(
        [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
        { duration: DRAW_DURATION, delay: delay, easing: EASE_REVEAL, fill: 'forwards' }
    );
}

function iconSize(el) {
    const icon = el.querySelector('svg');
    if (icon) {
        const rect = icon.getBoundingClientRect();
        if (rect.width) return Math.round(rect.width);
    }
    const cs = window.getComputedStyle(el);
    const fs = parseFloat(cs.fontSize) || 13;
    return Math.max(12, Math.min(20, Math.round(fs + 2)));
}

function renderStateContent(el, state, ctl) {
    const layer = ctl.stateEl;
    layer.textContent = '';
    if (state === 'idle') return;
    const size = iconSize(el);
    const instant = reduceMotion();
    if (state === 'loading') {
        const spinner = spinnerSvg(size);
        layer.appendChild(spinner);
        if (ctl.loadingLabel) {
            const span = document.createElement('span');
            span.textContent = ctl.loadingLabel;
            layer.appendChild(span);
        }
        if (!instant) {
            spinner.animate(
                [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
                { duration: SPIN_DURATION, iterations: Infinity, easing: 'linear' }
            );
        }
        return;
    }
    const isSuccess = state === 'success';
    const holder = document.createElement('span');
    holder.style.display = 'inline-flex';
    const svg = drawnSvg(isSuccess ? [CHECK_PATH] : X_PATHS, size);
    holder.appendChild(svg);
    layer.appendChild(holder);
    Array.prototype.forEach.call(svg.querySelectorAll('path'), (path, index) => {
        drawPath(path, index * 50, instant);
    });
    if (isSuccess && !instant) {
        holder.animate(
            [{ transform: 'scale(0.6)' }, { transform: 'scale(1)' }],
            { duration: 320, easing: EASE_SPRING }
        );
    }
    const label = isSuccess ? ctl.successLabel : ctl.errorLabel;
    if (label) {
        const span = document.createElement('span');
        span.textContent = label;
        layer.appendChild(span);
    }
}

function announceText(ctl, state) {
    const table = ANNOUNCE[ctl.announce];
    if (state === 'loading') return ctl.loadingAnnounce || table.loading;
    if (state === 'success') return ctl.successAnnounce || table.success;
    if (state === 'error') return ctl.errorAnnounce || table.error;
    return '';
}

function morphWidth(el, startWidth, ctl) {
    if (ctl.keepWidth || !startWidth || reduceMotion()) return;
    const endWidth = el.getBoundingClientRect().width;
    if (!endWidth || Math.abs(endWidth - startWidth) < 0.5) return;
    el.animate(
        [{ width: startWidth + 'px' }, { width: endWidth + 'px' }],
        { duration: WIDTH_DURATION, easing: EASE_SPRING }
    );
}

/* 各页有 body:not(...) 前缀的 !important 底色规则，特异性比本模块的类选择器高，
   成功/失败底色只能写成行内 !important 才压得住；回 idle 时再摘掉，不污染原样式。 */
function paintState(el, state) {
    const color = state === 'success' ? SUCCESS_BG : (state === 'error' ? ERROR_BG : '');
    if (!color) {
        el.style.removeProperty('background-color');
        el.style.removeProperty('border-color');
        el.style.removeProperty('color');
        return;
    }
    el.style.setProperty('background-color', color, 'important');
    el.style.setProperty('border-color', color, 'important');
    el.style.setProperty('color', '#ffffff', 'important');
}

function render(el, state, ctl, startWidth) {
    el.setAttribute(STATE_ATTR, state);
    paintState(el, state);
    renderStateContent(el, state, ctl);
    if (state === 'idle') {
        ctl.liveEl.textContent = '';
        el.removeAttribute('aria-busy');
        if (ctl.keepWidth) el.style.width = '';
        return;
    }
    ctl.liveEl.textContent = announceText(ctl, state);
    if (state === 'loading') el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
    if (ctl.keepWidth && !el.style.width && ctl.idleWidth) el.style.width = ctl.idleWidth + 'px';
    morphWidth(el, startWidth, ctl);
    if (state === 'error' && !reduceMotion()) {
        el.animate(SHAKE_KEYFRAMES.map(x => ({ transform: 'translateX(' + x + 'px)' })), {
            duration: SHAKE_DURATION, easing: 'ease-in-out'
        });
    }
}

function clearTimers(ctl) {
    if (ctl.resetTimer) { clearTimeout(ctl.resetTimer); ctl.resetTimer = 0; }
    if (ctl.finishTimer) { clearTimeout(ctl.finishTimer); ctl.finishTimer = 0; }
}

function setState(el, state) {
    const ctl = el && el.__nvMorph;
    if (!ctl) return null;
    if (STATES.indexOf(state) < 0) return ctl;
    if (ctl.state === state && state !== 'idle') return ctl;
    clearTimers(ctl);
    const wasIdle = ctl.state === 'idle';
    const startWidth = wasIdle ? el.getBoundingClientRect().width : 0;
    ctl.state = state;
    if (state === 'loading') ctl.loadingStart = now();
    /* 进状态前刚从 idle 量过宽度，先刷新锁定值再渲染：attach 时字体可能还没加载完，那时的宽度不可靠 */
    if (wasIdle && state !== 'idle' && startWidth) ctl.idleWidth = Math.round(startWidth);
    render(el, state, ctl, startWidth);
    if (state === 'idle') {
        const width = Math.round(el.getBoundingClientRect().width);
        if (width) ctl.idleWidth = width;
    } else if (state === 'success' || state === 'error') {
        ctl.resetTimer = setTimeout(() => { ctl.resetTimer = 0; setState(el, 'idle'); }, ctl.resetDelay);
    }
    return ctl;
}

function settle(el, ctl, state) {
    if (!ctl || ctl.state !== 'loading') return;
    const elapsed = now() - (ctl.loadingStart || now());
    const wait = Math.max(0, (ctl.minLoading || 0) - elapsed);
    if (wait <= 0) { setState(el, state); return; }
    /* loading 太短会一闪而过，凑满 minLoading 再落结果 */
    if (ctl.finishTimer) clearTimeout(ctl.finishTimer);
    ctl.finishTimer = setTimeout(() => {
        ctl.finishTimer = 0;
        if (ctl.state === 'loading') setState(el, state);
    }, wait);
}

/* ── 点击接管 ─────────────────────────────────────────────────────────── */

/* 取这次点击要执行的处理器：
   action 优先；否则点击瞬间读 el.onclick（页面可能刚重写过），读到就摘下来缓存，
   下一次点击 el.onclick 已是 null，用缓存继续，保证按钮不会被点一次就废。 */
function takeHandler(el, ctl) {
    const inline = el.onclick;
    if (ctl.action) {
        if (typeof inline === 'function') el.onclick = null;
        return ctl.action;
    }
    if (typeof inline === 'function') {
        el.onclick = null;
        ctl.inline = inline;
        return inline;
    }
    return ctl.inline || null;
}

function runHandler(el, ctl, event, handler) {
    setState(el, 'loading');
    watchAlertStart();
    let result;
    try {
        result = handler.call(el, event);
    } catch (err) {
        const alerted = watchAlertStop();
        settle(el, ctl, 'error');
        if (!alerted) throw err;
        return;
    }
    const finish = ok => {
        const alerted = watchAlertStop();
        settle(el, ctl, (ok && !alerted) ? 'success' : 'error');
    };
    if (result && typeof result.then === 'function') {
        result.then(value => finish(value !== false), () => finish(false));
        return;
    }
    finish(result !== false);
}

function onHostClick(el, ctl, event) {
    if (ctl.swallow) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    const handler = takeHandler(el, ctl);
    if (!handler) return;                      /* 既没 action 也没 onclick：不拦、不动效，交给页面委托 */
    if (ctl.state !== 'idle') return;          /* loading 期间不收重复点击，但不停传播，页面自己的防抖照旧 */
    runHandler(el, ctl, event, handler);
}

/* ── 挂载 / 卸载 ──────────────────────────────────────────────────────── */

function idleTextOf(inner) {
    return String(inner.textContent || '').replace(/\s+/g, ' ').trim();
}

function buildLayers(el) {
    const inner = document.createElement('span');
    inner.className = INNER_CLASS;
    const cs = window.getComputedStyle(el);
    /* 原按钮的 gap/字体来自按钮自身 CSS，包一层后要显式带过来，否则图标与文字间距会变 */
    if (cs.gap && cs.gap !== 'normal') inner.style.gap = cs.gap;
    ['font-size', 'font-weight', 'font-family', 'letter-spacing', 'line-height', 'color', 'text-transform'].forEach(prop => {
        inner.style.setProperty(prop, cs.getPropertyValue(prop));
    });
    while (el.firstChild) inner.appendChild(el.firstChild);
    const stateEl = document.createElement('span');
    stateEl.className = STATE_CLASS;
    stateEl.setAttribute('aria-hidden', 'true');
    const liveEl = document.createElement('span');
    liveEl.className = LIVE_CLASS;
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    el.appendChild(inner);
    el.appendChild(stateEl);
    el.appendChild(liveEl);
    return { inner: inner, stateEl: stateEl, liveEl: liveEl };
}

function attach(el, opts) {
    if (!el || el.nodeType !== 1) return null;
    if (el.__nvMorph) {
        if (!el.contains(el.__nvMorph.innerEl)) relayer(el.__nvMorph);
        return el.__nvMorph;
    }
    const options = opts || {};
    injectStyle();
    const attribute = el.getAttribute('onclick');
    const parsed = options.action ? null : parseInlineCall(attribute);
    const layers = buildLayers(el);
    const ctl = {
        el: el,
        state: 'idle',
        /* 工具栏里宽度变化会顶到邻居的按钮，用 data-morph-keep-width 就地声明，不必逐个 attach */
        keepWidth: options.keepWidth === true || el.hasAttribute('data-morph-keep-width'),
        swallow: options.swallow === true,
        resetDelay: Number.isFinite(options.resetDelay) ? options.resetDelay : DEFAULT_RESET_DELAY,
        minLoading: Number.isFinite(options.minLoading) ? options.minLoading : DEFAULT_MIN_LOADING,
        loadingLabel: options.loadingLabel || '',
        successLabel: options.successLabel || '',
        errorLabel: options.errorLabel || '',
        loadingAnnounce: options.loadingAnnounce || '',
        successAnnounce: options.successAnnounce || '',
        errorAnnounce: options.errorAnnounce || '',
        /* 图标按钮没有可见文字，退回 title（"保存 Key"）才能播报成「正在保存…」而不是「处理中…」 */
        announce: announceKey(idleTextOf(layers.inner) || el.getAttribute('title') || ''),
        idleWidth: Math.round(el.getBoundingClientRect().width) || 0,
        loadingStart: 0,
        resetTimer: 0,
        finishTimer: 0,
        innerEl: layers.inner,
        stateEl: layers.stateEl,
        liveEl: layers.liveEl,
        inline: null,
        removedAttribute: null,
        action: null,
        manualAction: typeof options.action === 'function' ? options.action : null,
        setState: function (state) { setState(el, state); return ctl; },
        destroy: function () { detach(el); }
    };
    /* 解析成功的行内调用转成 action：属性摘掉，避免别处再触发一次同一个处理器；
       全局函数在点击时才取，页面后替换实现也能跟上。 */
    if (parsed) {
        ctl.removedAttribute = attribute;
        el.removeAttribute('onclick');
        ctl.action = function () {
            const fn = typeof window[parsed.name] === 'function' ? window[parsed.name] : null;
            if (!fn) return undefined;
            return fn.apply(this, parsed.args);
        };
    } else if (ctl.manualAction) {
        ctl.action = ctl.manualAction;
    }
    ctl.onClick = function (event) { onHostClick(el, ctl, event); };
    el.addEventListener('click', ctl.onClick, true);
    el.classList.add(HOST_CLASS);
    el.setAttribute(STATE_ATTR, 'idle');
    el.__nvMorph = ctl;
    return ctl;
}

/* 页面重写 innerHTML 会带走包装层，控制器还在，就地重建一层 */
function relayer(ctl) {
    const layers = buildLayers(ctl.el);
    ctl.innerEl = layers.inner;
    ctl.stateEl = layers.stateEl;
    ctl.liveEl = layers.liveEl;
    clearTimers(ctl);
    ctl.state = 'idle';
    ctl.el.setAttribute(STATE_ATTR, 'idle');
    ctl.el.removeAttribute('aria-busy');
    if (ctl.keepWidth) ctl.el.style.width = '';
}

function detach(el) {
    const ctl = el && el.__nvMorph;
    if (!ctl) return;
    clearTimers(ctl);
    el.removeEventListener('click', ctl.onClick, true);
    const inner = ctl.innerEl;
    while (inner.firstChild) el.insertBefore(inner.firstChild, inner);
    inner.remove();
    ctl.stateEl.remove();
    ctl.liveEl.remove();
    if (ctl.removedAttribute !== null && !el.hasAttribute('onclick')) {
        el.setAttribute('onclick', ctl.removedAttribute);
    }
    el.removeAttribute(STATE_ATTR);
    el.removeAttribute('aria-busy');
    if (ctl.keepWidth) el.style.width = '';
    el.classList.remove(HOST_CLASS);
    delete el.__nvMorph;
}

/* ── 批量扫描 ─────────────────────────────────────────────────────────── */

function collect(root) {
    const scope = (root && root.querySelectorAll) ? root : document;
    const nodes = [];
    if (scope.nodeType === 1 && scope.matches && scope.matches(SELECTOR)) nodes.push(scope);
    Array.prototype.push.apply(nodes, scope.querySelectorAll(SELECTOR));
    return nodes;
}

function autoBind(root, opts) {
    let count = 0;
    collect(root).forEach(el => {
        /* 已绑过：只有当页面把包装层冲掉时才重建，避免重复挂监听 */
        if (el.__nvMorph) {
            if (!el.contains(el.__nvMorph.innerEl)) relayer(el.__nvMorph);
            return;
        }
        if (el.hasAttribute(STATE_ATTR)) el.setAttribute(STATE_ATTR, 'idle');
        if (!isBindable(el)) return;
        if (attach(el, opts)) count += 1;
    });
    return count;
}

function observe(root, opts) {
    const target = (root && root.nodeType === 1) ? root : document.body;
    if (!target || typeof MutationObserver !== 'function') return null;
    let scheduled = 0;
    const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = setTimeout(() => {
            scheduled = 0;
            autoBind(target, opts);
        }, 60);
    });
    observer.observe(target, { childList: true, subtree: true });
    return {
        disconnect: function () {
            observer.disconnect();
            if (scheduled) clearTimeout(scheduled);
            scheduled = 0;
        }
    };
}

const api = {
    attach: attach,
    autoBind: autoBind,
    observe: observe,
    setState: setState,
    destroy: detach,
    HOST_CLASS: HOST_CLASS,
    STATE_ATTR: STATE_ATTR
};
if (typeof window !== 'undefined') window.NovaMorphButton = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
