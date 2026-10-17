<script setup>
// 缩略图内容（放进 .am-cm / .am-dm 容器）：图片走 /api/media-preview 缩放代理；视频用服务端截帧做 poster + preload=none；
// 音频 / 文本显示文件图标；工作流画一个节点示意图。
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { assetPreviewUrl } from '../lib/util.js';

const props = defineProps({
    url: { type: String, default: '' },
    kind: { type: String, default: 'image' },   // image | video | audio | text | workflow
    name: { type: String, default: '' },
    w: { type: Number, default: 256 },
    badge: { type: Boolean, default: false },   // 右下角类型角标（画布资产 / 视频）
    label: { type: String, default: '' },        // 文件类图标下的文字
    plain: { type: Boolean, default: false },   // 详情大图：不要角标
});
const src = computed(() => assetPreviewUrl(props.url, props.w));
const badgeIcon = computed(() => ({ video: 'play', audio: 'music', text: 'file' }[props.kind] || 'image'));
</script>

<template>
    <svg v-if="kind === 'workflow'" class="am-wf" viewBox="0 0 104 84" aria-hidden="true">
        <path class="w" d="M32 27 C38 27 38 41 44 41" /><path class="w" d="M32 57 C38 57 38 41 44 41" />
        <path class="w" d="M66 41 C71 41 71 27 76 27" /><path class="w" d="M66 41 C71 41 71 57 76 57" />
        <rect class="n" x="10" y="20" width="22" height="14" rx="3" /><rect class="n" x="10" y="50" width="22" height="14" rx="3" />
        <rect class="n k" x="44" y="34" width="22" height="14" rx="3" />
        <rect class="n" x="76" y="20" width="18" height="14" rx="3" /><rect class="n" x="76" y="50" width="18" height="14" rx="3" />
    </svg>
    <video v-else-if="kind === 'video'" :src="url" :poster="src" muted preload="none" playsinline></video>
    <span v-else-if="kind === 'audio' || kind === 'text'" class="fi"><NvIcon :name="kind === 'audio' ? 'music' : 'file'" /><span>{{ label || (kind === 'audio' ? '音频' : '文本') }}</span></span>
    <img v-else :src="src" :alt="name || 'asset'" loading="lazy" decoding="async" draggable="false">
    <span v-if="!plain && (badge || kind === 'video')" class="kb"><NvIcon :name="badgeIcon" /></span>
</template>

<style scoped>
.am-wf { position: absolute; left: 18%; top: 18%; width: 64%; height: 64%; }
.am-wf .n { fill: var(--solid); stroke: none; }
.am-wf .w { fill: none; stroke: var(--ink-4); stroke-width: 1.2; }
.am-wf .n.k { fill: var(--ink); }
</style>
