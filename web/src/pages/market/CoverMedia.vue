<script setup>
// 应用市场封面：有封面视频就渲染 video（悬停 / 进入视口由父级 play），否则封面图，最后退回图标。
// 列表卡只有 48px，视频默认不加载（preload="none"），悬停才播。
import NvIcon from '../../components/NvIcon.vue';

defineProps({ item: { type: Object, required: true }, icon: { type: String, default: 'wand2' } });
</script>

<template>
    <video v-if="item.coverVideoUrl" :src="item.coverVideoUrl" :poster="item.coverUrl || ''" muted loop playsinline preload="none"></video>
    <img v-else-if="item.coverUrl" :src="item.coverUrl" alt="" loading="lazy" decoding="async" @error="e => (e.target.style.visibility = 'hidden')">
    <NvIcon v-else :name="icon" />
</template>
