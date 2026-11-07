<script setup>
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue';
import { NV_ANIM_KEY, cssTime } from '../lib/nvAnim.js';

const props = defineProps({
    as: { type: String, default: 'div' },
    animation: { type: String, default: '' },
    animate: { type: Boolean, default: false },
    animateOnHover: { type: Boolean, default: true },
    animateOnTap: { type: Boolean, default: false },
    animateOnView: { type: Boolean, default: false },
    speed: { type: [Number, String], default: null },
    delay: { type: [Number, String], default: null },
    loop: { type: Boolean, default: false },
});

const ctx = reactive({
    animation: props.animation,
    animate: props.animate,
    animateOnHover: props.animateOnHover,
    animateOnTap: props.animateOnTap,
    animateOnView: props.animateOnView,
    speed: props.speed,
    delay: props.delay,
    loop: props.loop,
    tick: 0,
    viewTick: 0,
});

provide(NV_ANIM_KEY, ctx);

watch(
    () => [props.animation, props.animate, props.animateOnHover, props.animateOnTap, props.animateOnView, props.speed, props.delay, props.loop],
    ([animation, animate, animateOnHover, animateOnTap, animateOnView, speed, delay, loop]) => {
        Object.assign(ctx, { animation, animate, animateOnHover, animateOnTap, animateOnView, speed, delay, loop });
    }
);

const root = ref(null);
let observer = null;
let pulseTimer = 0;

const pulse = ref(false);

const classes = computed(() => [
    'nv-animate-icon',
    {
        'nv-i-host': props.animateOnHover,
        'nv-i-always': props.animate,
        'nv-i-loop': props.loop,
        'nv-i-play': pulse.value,
    },
]);

const hostStyle = computed(() => {
    const s = {};
    if (props.speed != null) s['--nv-i-speed'] = String(props.speed);
    if (props.delay != null) s['--nv-i-delay'] = cssTime(props.delay);
    if (props.loop) s['--nv-i-loop'] = 'infinite';
    return s;
});

function fire() {
    ctx.tick += 1;
    pulse.value = false;
    void (root.value ? root.value.getBoundingClientRect() : 0);
    pulse.value = true;
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => (pulse.value = false), 900);
}

function onTap() {
    if (!props.animateOnTap) return;
    fire();
}

onMounted(() => {
    if (!props.animateOnView || typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver(
        entries => {
            if (entries.some(e => e.isIntersecting)) {
                ctx.viewTick += 1;
                fire();
                observer.disconnect();
                observer = null;
            }
        },
        { threshold: 0.4 }
    );
    if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
    if (observer) observer.disconnect();
    clearTimeout(pulseTimer);
});
</script>

<template>
    <component
        :is="as"
        ref="root"
        :class="classes"
        :style="hostStyle"
        :data-animation="animation || null"
        :data-icon-trigger="animateOnHover ? '' : null"
        @pointerdown="onTap"
    >
        <slot />
    </component>
</template>
