<script setup>
// 更新说明里的动态演示：gif 直接播；image 淡入 + 轻微缩放；video 自动播放、静音、循环、可内联播放。
import { computed, ref } from 'vue';

const props = defineProps({ media: { type: Object, default: null } });

const failed = ref(false);
const kind = computed(() => {
    const t = props.media && props.media.type;
    return ['image', 'gif', 'video'].includes(t) ? t : '';
});
const src = computed(() => (props.media && props.media.src) || '');
const caption = computed(() => (props.media && props.media.caption) || '');
</script>

<template>
    <figure class="um" :class="kind">
        <div class="box">
            <video v-if="kind === 'video' && src && !failed" :src="src" autoplay muted loop playsinline preload="metadata" @error="failed = true"></video>
            <img v-else-if="src && !failed" :src="src" :alt="caption" @error="failed = true" />
            <p v-else class="ph">这段演示没有加载出来，可以看文字说明。</p>
        </div>
        <figcaption v-if="caption" class="cap">{{ caption }}</figcaption>
    </figure>
</template>

<style scoped>
.um { margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.box { position: relative; aspect-ratio: 16 / 10; border-radius: 14px; overflow: hidden; background: var(--fill-1); display: flex; align-items: center; justify-content: center; }
.box img, .box video { width: 100%; height: 100%; display: block; object-fit: contain; }
.box.image img { animation: um-zoom var(--duration-slow) var(--ease-out) both; }
.box.gif img, .box.video video { animation: um-fade var(--duration-base) var(--ease-out) both; }
@keyframes um-zoom { from { opacity: 0; transform: scale(1.03); } to { opacity: 1; transform: none; } }
@keyframes um-fade { from { opacity: 0; } to { opacity: 1; } }
.ph { margin: 0; padding: 20px; text-align: center; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.cap { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
@media (prefers-reduced-motion: reduce) { .box img, .box video { animation: none; } }
</style>
