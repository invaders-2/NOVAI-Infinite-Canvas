<script setup>
// 市场里的封面：有 poster 先铺底图，视频在需要播放时才加载（列表/预设墙默认不自动播，hover 或轮播当前页才播）。
import { computed, ref, watch } from 'vue';

const props = defineProps({
    src: { type: String, default: '' },
    poster: { type: String, default: '' },
    type: { type: String, default: 'image' },   // image | video
    alt: { type: String, default: '' },
    label: { type: String, default: '' },        // 无图时渐变块里的首字
    autoplay: { type: Boolean, default: false },
    objectPosition: { type: String, default: '' },
});

const broken = ref(false);
const videoEl = ref(null);
watch(() => [props.src, props.poster], () => { broken.value = false; });
watch(() => props.autoplay, playing => {
    const el = videoEl.value;
    if (!el) return;
    if (playing) { el.play().catch(() => {}); } else { el.pause(); }
});

const isVideo = computed(() => props.type === 'video' && !!props.src && !broken.value);
const imageSrc = computed(() => (props.type === 'video' ? (props.poster || '') : (props.src || '')));
const showImage = computed(() => !!imageSrc.value && !broken.value);
const initial = computed(() => String(props.label || props.alt || '·').trim().slice(0, 1).toUpperCase() || '·');
</script>

<template>
    <div class="store-cover" :class="{ 'is-fallback': !showImage && !isVideo }">
        <img v-if="showImage" :src="imageSrc" :alt="alt" loading="lazy" :style="objectPosition ? { objectPosition } : null" @error="broken = true" />
        <video v-if="isVideo" ref="videoEl" :src="src" :poster="poster || undefined" muted loop playsinline :autoplay="autoplay"
               :preload="autoplay ? 'auto' : 'none'" @error="broken = true"></video>
        <span v-if="!showImage && !isVideo" class="store-cover-letter" aria-hidden="true">{{ initial }}</span>
        <slot />
    </div>
</template>

<style scoped>
.store-cover { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--fill-2); }
.store-cover > img, .store-cover > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.store-cover.is-fallback { background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent) 4%, transparent)); display: flex; align-items: center; justify-content: center; }
.store-cover-letter { font: 700 clamp(20px, 2.2vw, 34px)/1 var(--font-sans); color: color-mix(in srgb, var(--ink) 40%, transparent); }
</style>
