<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../components/NvIcon.vue';

const props = defineProps({
    items: { type: Array, required: true },
    active: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const nav = ref(null);
const capL = ref(null);
const mid = ref(null);
const capR = ref(null);

/* 2026-11-07 重做胶囊动画（悬停跟随卡顿）：
   原来每帧在 JS 里解 spring、改胶囊的 width / height —— 每帧都要重排 + 重绘，
   再叠上标题栏三层磨砂和首页动态背景，主线程一忙动画就掉帧。
   现在胶囊拆成「左半圆 + 中段 + 右半圆」三块，只用 transform（平移 / 横向缩放）做动画，
   交给浏览器合成线程（Web Animations）去跑：不重排、不占主线程，主线程卡了动画也照样顺。
   缓动仍是原来的 spring（stiffness 350 / damping 28，带一点回弹），预先算成 linear() 曲线。 */
const SPRING = { k: 350, c: 28 };
const MID_BASE = 100;   // 中段元素的基准宽度，靠 scaleX 拉到实际长度

function springCurve() {
    const dt = 1 / 240;
    let x = 0, v = 0, t = 0;
    const pts = [0];
    while (t < 2) {
        for (let i = 0; i < 4; i++) { v += (-SPRING.k * (x - 1) - SPRING.c * v) * dt; x += v * dt; t += dt; }
        pts.push(x);
        if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break;
    }
    pts[pts.length - 1] = 1;
    return { duration: Math.round(t * 1000), easing: 'linear(' + pts.map(p => p.toFixed(4)).join(', ') + ')' };
}
const CURVE = (() => {
    const c = springCurve();
    try { if (window.CSS && CSS.supports('animation-timing-function', 'linear(0, 1)')) return c; } catch (e) {}
    return { duration: 420, easing: 'cubic-bezier(.3, 1.25, .45, 1)' };   // 不支持 linear() 的老内核：近似回弹
})();

let hovered = -1;
let ro = null;

function prefersReduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function itemsInDom() {
    return nav.value ? nav.value.querySelectorAll('.tb-nav-item') : [];
}
function targetIndex() {
    if (hovered >= 0) return hovered;
    const i = props.items.findIndex(it => it.id === props.active);
    return i >= 0 ? i : 0;
}
function measure(index) {
    const btn = itemsInDom()[index];
    if (!btn) return null;
    const w = btn.offsetWidth, h = btn.offsetHeight;
    if (!w && !h) return null;   // 导航被隐藏时量不出东西，别把胶囊甩到 0,0
    return { x: btn.offsetLeft, y: btn.offsetTop, w, h };
}

/* 三块的目标 transform（统一写成 matrix，和 getComputedStyle 读回来的格式一致，插值是逐分量线性的，
   三块用同一条缓动，任意时刻中段两端都正好接在两个半圆上） */
function targets(box) {
    const h = box.h;
    const midW = Math.max(0, box.w - h);
    return [
        'matrix(1, 0, 0, 1, ' + box.x + ', ' + box.y + ')',
        'matrix(' + (midW / MID_BASE) + ', 0, 0, 1, ' + (box.x + h / 2) + ', ' + box.y + ')',
        'matrix(1, 0, 0, 1, ' + (box.x + box.w - h) + ', ' + box.y + ')',
    ];
}

let lastH = 0;
function setSize(h) {
    if (h === lastH) return;
    lastH = h;
    for (const el of [capL.value, capR.value]) { if (el) { el.style.width = h + 'px'; el.style.height = h + 'px'; } }
    if (mid.value) mid.value.style.height = h + 'px';
}

function aim(instant) {
    const box = measure(targetIndex());
    if (!box) return;
    setSize(box.h);
    const els = [capL.value, mid.value, capR.value];
    const to = targets(box);
    const animate = !instant && !prefersReduced() && typeof Element.prototype.animate === 'function';
    els.forEach((el, i) => {
        if (!el) return;
        const from = animate ? getComputedStyle(el).transform : '';   // 正在动的话读到的是当前帧的位置，从这里接着走
        el.getAnimations().forEach(a => a.cancel());
        el.style.transform = to[i];
        if (animate && from && from !== 'none' && from !== to[i]) {
            el.animate([{ transform: from }, { transform: to[i] }], { duration: CURVE.duration, easing: CURVE.easing });
        }
    });
}

/* 布局变了（resize / 字体 / 语言 / 窄窗口只剩图标）要重新量，直接落位不是飞过去 */
function onLayout() {
    if (nav.value) aim(true);
}

/* 三块重叠的地方如果用半透明色会叠深，所以块本身用不透明的墨色，整层再用 opacity 还原 --fill-2 的透明度
   （颜色和透明度都从 token 里读，不在模板里写死新颜色） */
function syncTint() {
    const el = nav.value;
    if (!el) return;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;background-color:var(--fill-2);';
    el.appendChild(probe);
    const raw = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const nums = raw.replace(/[^0-9.]+/g, ' ').trim().split(/\s+/).map(Number);
    if (nums.length < 3 || nums.some(n => !Number.isFinite(n))) return;
    const a = nums.length > 3 ? nums[3] : 1;
    el.style.setProperty('--tb-pill-tint', 'rgb(' + nums[0] + ', ' + nums[1] + ', ' + nums[2] + ')');
    el.style.setProperty('--tb-pill-alpha', String(Number.isFinite(a) ? a : 0.08));
}

/* 胶囊动的时候通知首页动态背景先停一下：背景每动一帧，标题栏三层磨砂都要重新模糊，
   和胶囊抢同一批合成帧；停几百毫秒肉眼看不出来，胶囊就能满帧跑 */
function signalBusy() {
    window.dispatchEvent(new CustomEvent('nv-motion-busy', { detail: { ms: CURVE.duration + 150 } }));
}

function onOver(e) {
    if (e.pointerType === 'touch') return;
    const btn = e.target.closest ? e.target.closest('.tb-nav-item') : null;
    if (!btn || !nav.value || !nav.value.contains(btn)) return;
    const index = Array.prototype.indexOf.call(itemsInDom(), btn);
    if (index < 0 || index === hovered) return;
    hovered = index;
    signalBusy();
    aim(false);
}
function onLeave() {
    if (hovered < 0) return;
    hovered = -1;
    signalBusy();
    aim(false);
}
function onTheme() { syncTint(); }

onMounted(() => {
    syncTint();
    nextTick(() => {
        aim(true);
        if (nav.value) { ro = new ResizeObserver(onLayout); ro.observe(nav.value); }
    });
    window.addEventListener('resize', onLayout);
    window.addEventListener('studio-theme-change', onTheme);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(onLayout).catch(() => {});
    if (nav.value) {
        nav.value.addEventListener('pointerover', onOver);
        nav.value.addEventListener('pointerleave', onLeave);
    }
});

onBeforeUnmount(() => {
    if (ro) ro.disconnect();
    ro = null;
    window.removeEventListener('resize', onLayout);
    window.removeEventListener('studio-theme-change', onTheme);
    if (nav.value) {
        nav.value.removeEventListener('pointerover', onOver);
        nav.value.removeEventListener('pointerleave', onLeave);
    }
});

// 换页后胶囊回到当前页面项（正在 hover 时以指针为准）
watch(() => props.active, () => { if (hovered < 0) { signalBusy(); aim(false); } });
// 语言 / 文案变了，宽度跟着变，重新量
watch(() => props.items, () => nextTick(onLayout));
</script>

<template>
    <nav ref="nav" class="tb-nav" aria-label="主导航">
        <div class="tb-pill" aria-hidden="true">
            <span ref="capL" class="tb-pill-cap"></span>
            <span ref="mid" class="tb-pill-mid"></span>
            <span ref="capR" class="tb-pill-cap"></span>
        </div>
        <button v-for="it in items" :key="it.id" type="button" class="tb-nav-item"
                :class="{ on: active === it.id }"
                :aria-current="active === it.id ? 'page' : null"
                @click="emit('select', it.id)">
            <NvIcon :name="it.icon" /><span>{{ it.label }}</span>
        </button>
    </nav>
</template>

<style scoped>
/* 导航本体：标题栏正中，只负责摆位置；胶囊在下面独立的一层 */
.tb-nav { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 2px; -webkit-app-region: no-drag; }
/* 胶囊层：不接事件；三块是不透明墨色，整层 opacity 还原 --fill-2 的半透明（见 syncTint） */
.tb-pill { position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: var(--tb-pill-alpha, .08); }
.tb-pill > span { position: absolute; left: 0; top: 0; background: var(--tb-pill-tint, var(--ink)); will-change: transform; backface-visibility: hidden; }
.tb-pill-cap { width: 30px; height: 30px; border-radius: 50%; }
.tb-pill-mid { width: 100px; height: 30px; transform-origin: 0 0; }
.tb-nav-item { position: relative; z-index: 1; height: 30px; padding: 0 13px 0 11px; border: 0; border-radius: var(--radius-pill); background: transparent; color: var(--ink-3); display: flex; align-items: center; gap: 6px;
    font: 500 13px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: color var(--duration-fast) var(--ease-out); }
.tb-nav-item .nv-i { width: 15px; height: 15px; }
.tb-nav-item:hover { color: var(--ink); }
/* 选中不自己铺底：底色由胶囊提供，这里只留文字色 */
.tb-nav-item.on { color: var(--ink); }
@media (max-width: 760px) { .tb-nav-item span { display: none; } .tb-nav-item { padding: 0 10px; } }
</style>
