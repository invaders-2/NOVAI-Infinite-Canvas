<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ICONS, ICON_ANIM } from '../lib/icons.js';
import { NV_ANIM_KEY, cssTime, normalizeAnimation, playOnce } from '../lib/nvAnim.js';

const DEFAULT_SIZE = 24;

const props = defineProps({
    name: { type: String, required: true },
    size: { type: [Number, String], default: DEFAULT_SIZE },
    stroke: { type: [Number, String], default: null },
    animation: { type: String, default: '' },
    animate: { type: Boolean, default: false },
    animateOnHover: { type: Boolean, default: true },
    animateOnTap: { type: Boolean, default: false },
    animateOnView: { type: Boolean, default: false },
    speed: { type: [Number, String], default: null },
    delay: { type: [Number, String], default: null },
    loop: { type: Boolean, default: false },
    title: { type: String, default: '' },
});

const ctx = inject(NV_ANIM_KEY, null);
const el = ref(null);
let observer = null;

const resolvedAnim = computed(() => {
    const own = props.animation;
    const inherited = ctx && ctx.animation ? ctx.animation : '';
    return normalizeAnimation(own || inherited || ICON_ANIM[props.name] || 'default');
});

const hoverEnabled = computed(() => {
    if (props.animateOnHover === false) return false;
    return ctx ? ctx.animateOnHover !== false : true;
});

const tapEnabled = computed(() => props.animateOnTap);
const viewEnabled = computed(() => props.animateOnView || (ctx ? ctx.animateOnView : false));
const animateEnabled = computed(() => props.animate || (ctx ? ctx.animate : false));
const loopEnabled = computed(() => props.loop || (ctx ? ctx.loop : false));

const speed = computed(() => (props.speed != null ? props.speed : ctx ? ctx.speed : null));
const delay = computed(() => (props.delay != null ? props.delay : ctx ? ctx.delay : null));

const classes = computed(() => [
    'nv-i',
    'nv-i-' + props.name,
    'nv-i-a-' + resolvedAnim.value,
    {
        'nv-i-always': animateEnabled.value,
        'nv-i-loop': loopEnabled.value,
    },
]);

// 只有调用方显式指定 animation 时才发 data-animation，避免覆盖图标名的方向默认值
const explicitAnim = computed(() => (props.animation ? resolvedAnim.value : null));

const style = computed(() => {
    const s = {};
    const px = Number(props.size);
    if (props.size != null && !(Number.isFinite(px) && px === DEFAULT_SIZE)) {
        const n = px;
        s.width = Number.isFinite(n) ? n + 'px' : String(props.size);
        s.height = s.width;
    }
    if (props.stroke != null) s['--nv-i-stroke'] = String(props.stroke);
    s.strokeWidth = 'var(--nv-i-stroke, 1.5)';
    if (speed.value != null) s['--nv-i-speed'] = String(speed.value);
    if (delay.value != null) s['--nv-i-delay'] = cssTime(delay.value);
    if (loopEnabled.value) s['--nv-i-loop'] = 'infinite';
    return s;
});

function escapeHtml(v) {
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 只给 path 补 pathLength，circle / rect / line 不动（draw 动画的虚线只作用于 path）
const svgHtml = computed(() => {
    const raw = ICONS[props.name] || '';
    const withLen = raw.replace(/<path\b[^>]*>/g, tag => (/\bpathLength=/.test(tag) ? tag : tag.replace('<path', '<path pathLength="1"')));
    if (!props.title) return withLen;
    return '<title>' + escapeHtml(props.title) + '</title>' + withLen;
});

function onTap() {
    if (!tapEnabled.value) return;
    playOnce(el.value);
}

function play() {
    playOnce(el.value);
}

watch(
    () => (ctx ? ctx.tick : 0),
    () => playOnce(el.value)
);

watch(
    () => (ctx ? ctx.viewTick : 0),
    () => playOnce(el.value, 'nv-i-view', 1200)
);

onMounted(() => {
    if (!viewEnabled.value || typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver(
        entries => {
            if (entries.some(e => e.isIntersecting)) {
                playOnce(el.value, 'nv-i-view', 1200);
                observer.disconnect();
                observer = null;
            }
        },
        { threshold: 0.4 }
    );
    if (el.value) observer.observe(el.value);
});

onBeforeUnmount(() => {
    if (observer) observer.disconnect();
    if (el.value) clearTimeout(el.value.__nvPlayTimer);
});

defineExpose({ play });
</script>

<template>
    <svg
        ref="el"
        :class="classes"
        :style="style"
        viewBox="0 0 24 24"
        :data-icon="name"
        :data-animation="explicitAnim"
        :data-nv-no-hover="hoverEnabled ? null : ''"
        :role="title ? 'img' : null"
        :aria-label="title || null"
        :aria-hidden="title ? null : 'true'"
        v-html="svgHtml"
        @pointerdown="onTap"
    />
</template>
