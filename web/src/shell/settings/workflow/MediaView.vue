<script setup>
// 媒体上传区：未上传时显示「点击上传…」，已上传按类型显示图片 / 视频 / 音频
import NvIcon from '../../../components/NvIcon.vue';
import { typeLabel, mediaUploadText } from './nodeInfo.js';

defineProps({ kind: { type: String, default: 'image' }, url: String, name: String, compact: Boolean });
defineEmits(['pick']);
</script>

<template>
    <div class="md" :class="{ has: !!url, compact, [kind]: true }" role="button" tabindex="0" @click="$emit('pick')" @keydown.enter.prevent="$emit('pick')" @keydown.space.prevent="$emit('pick')">
        <template v-if="!url"><NvIcon name="upload" /><span>{{ mediaUploadText(kind) }}</span></template>
        <video v-else-if="kind === 'video'" :src="url" muted preload="metadata" playsinline controls @click.stop></video>
        <div v-else-if="kind === 'audio'" class="au">
            <span class="nm"><NvIcon name="music" />{{ name || typeLabel(kind) }}</span>
            <audio :src="url" controls preload="metadata" @click.stop></audio>
        </div>
        <img v-else :src="url" alt="" />
    </div>
</template>

<style scoped>
.md { position: relative; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 64px; border-radius: 9px; background: var(--solid); color: var(--ink-3); font: 400 11px/1 var(--font-sans); cursor: pointer; overflow: hidden; transition: background var(--duration-fast) var(--ease-out); }
.md:hover { background: var(--fill-2); }
.md .nv-i { width: 14px; height: 14px; }
.md.has { background: var(--fill-1); }
.md.has img { display: block; width: 100%; max-height: 160px; object-fit: contain; }
.md.compact.has img { max-height: 110px; }
.md video { display: block; width: 100%; max-height: 160px; background: #000; }
.au { width: 100%; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.au .nm { display: flex; align-items: center; gap: 6px; min-width: 0; font: 400 11.5px/16px var(--font-sans); color: var(--ink-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.au audio { width: 100%; height: 30px; }
</style>
