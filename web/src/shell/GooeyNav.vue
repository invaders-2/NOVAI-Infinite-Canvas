<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import '../lib/hyalite.js';

const props = defineProps({
    items: { type: Array, required: true },
    active: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const nav = ref(null);
const pill = ref(null);

/* 2026-11 选中态改版：把原来的实底胶囊换成一块「液态玻璃」——
   hyalite 用 SDF 位移贴图 + backdrop-filter 让选中块背后发生真实折射，
   所以不再铺底、不画边。胶囊照旧跟着指针走：悬停哪一项滑到哪一项，移开回到当前页。 */
const SPRING = { k: 350, c: 28 };
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
    try { if (window.CSS && CSS.supports('transition-timing-function', 'linear(0, 1)')) return c; } catch (e) {}
    return { duration: 420, easing: 'cubic-bezier(.3, 1.25, .45, 1)' };
})();
const PILL_TRANSITION = 'transform ' + CURVE.duration + 'ms ' + CURVE.easing +
    ', width ' + CURVE.duration + 'ms ' + CURVE.easing + ', height .3s var(--ease-out)';

/* 30px 高的选中块：倒角 14 / 厚度 24，色散和边缘光都收着，别抢文字 */
const GLASS = {
    bevel: 12, thickness: 22, dispersion: 1.2, blur: 2,
    shade: 0.22, rim: 0.12, edgeW: 8, sat: 1, edge: 0,
    light: -140, smooth: 1, materialize: 340, settle: 0,
};

let hovered = -1;
let ro = null;
let glassOn = false;

function prefersReduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function itemEls() {
    return nav.value ? Array.prototype.slice.call(nav.value.querySelectorAll('.tb-nav-item')) : [];
}
function targetEl() {
    const els = itemEls();
    if (!els.length) return null;
    if (hovered >= 0 && els[hovered]) return els[hovered];
    const i = props.items.findIndex(it => it.id === props.active);
    return els[i >= 0 ? i : 0];
}
function place(instant) {
    const el = targetEl();
    const p = pill.value;
    if (!el || !p || !nav.value) return;
    const nr = nav.value.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    p.style.transition = instant || prefersReduced() ? 'none' : PILL_TRANSITION;
    p.style.width = r.width + 'px';
    p.style.height = r.height + 'px';
    p.style.transform = 'translate3d(' + (r.left - nr.left) + 'px,' + (r.top - nr.top) + 'px,0)';
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => { if (p) p.style.transition = PILL_TRANSITION; }));
}

/* 胶囊动的时候通知首页动态背景先停一下（沿用原来的约定） */
function signalBusy() {
    window.dispatchEvent(new CustomEvent('nv-motion-busy', { detail: { ms: CURVE.duration + 150 } }));
}

function onOver(e) {
    if (e.pointerType === 'touch') return;
    const btn = e.target.closest ? e.target.closest('.tb-nav-item') : null;
    if (!btn || !nav.value || !nav.value.contains(btn)) return;
    const i = itemEls().indexOf(btn);
    if (i < 0 || i === hovered) return;
    hovered = i;
    signalBusy();
    place(false);
}
function onLeave() {
    if (hovered < 0) return;
    hovered = -1;
    signalBusy();
    place(false);
}
function onLayout() {
    place(true);
    if (glassOn && window.Hyalite && pill.value) window.Hyalite.refresh(pill.value);
}

onMounted(() => {
    nextTick(() => {
        const el = nav.value;
        if (!el) return;
        place(true);
        ro = new ResizeObserver(() => { place(false); });
        ro.observe(el);
        el.addEventListener('pointerover', onOver);
        el.addEventListener('pointerleave', onLeave);
        const H = window.Hyalite;
        if (H && H.supported() && pill.value) {
            glassOn = true;
            H.attach(pill.value, GLASS);
        }
    });
    window.addEventListener('resize', onLayout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(onLayout).catch(() => {});
});

onBeforeUnmount(() => {
    if (ro) ro.disconnect();
    ro = null;
    window.removeEventListener('resize', onLayout);
    const el = nav.value;
    if (el) {
        el.removeEventListener('pointerover', onOver);
        el.removeEventListener('pointerleave', onLeave);
    }
    if (glassOn && window.Hyalite && pill.value) window.Hyalite.detach(pill.value);
    glassOn = false;
});

watch(() => props.active, () => { if (hovered < 0) { signalBusy(); place(false); } });
watch(() => props.items, () => nextTick(onLayout));
</script>

<template>
    <nav ref="nav" class="tb-nav" aria-label="主导航">
        <span ref="pill" class="tb-pill" aria-hidden="true"></span>
        <button v-for="it in items" :key="it.id" type="button" class="tb-nav-item"
                :class="{ on: active === it.id }"
                :aria-current="active === it.id ? 'page' : null"
                @click="emit('select', it.id)">
            <NvIcon :name="it.icon" /><span>{{ it.label }}</span>
        </button>
    </nav>
</template>

<style scoped>
/* 导航本体：标题栏正中，只负责摆位置 */
.tb-nav { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 2px; -webkit-app-region: no-drag; }
/* 选中块：一层液态玻璃，没有底色、没有描边。hyalite 会把 --hyalite 写到这个元素上 */
.tb-pill {
    position: absolute; left: 0; top: 0; z-index: 0; border-radius: var(--radius-pill, 999px);
    pointer-events: none; will-change: transform, width;
    background: linear-gradient(180deg,
        color-mix(in srgb, var(--ink) 8%, transparent),
        color-mix(in srgb, var(--ink) 3%, transparent));
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ink) 18%, transparent);
    -webkit-backdrop-filter: var(--hyalite, blur(6px));
    backdrop-filter: var(--hyalite, blur(6px));
}
.tb-nav-item { position: relative; z-index: 1; height: 30px; padding: 0 13px 0 11px; border: 0; border-radius: var(--radius-pill); background: transparent; color: var(--ink-3); display: flex; align-items: center; gap: 6px;
    font: 500 13px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: color var(--duration-fast) var(--ease-out); }
.tb-nav-item .nv-i { width: 15px; height: 15px; }
.tb-nav-item:hover { color: var(--ink); }
/* 选中不铺底：靠文字色 + 那块玻璃 */
.tb-nav-item.on { color: var(--ink); }
@media (max-width: 760px) { .tb-nav-item span { display: none; } .tb-nav-item { padding: 0 10px; } }
</style>
