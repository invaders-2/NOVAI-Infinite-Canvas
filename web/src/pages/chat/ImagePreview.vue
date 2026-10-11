<script setup>
// 图片预览：点生成图 / 附件缩略图全屏查看；点遮罩、× 或 Esc 关闭
import { onMounted, onBeforeUnmount } from 'vue';
import ChIcon from './ChIcon.vue';

const props = defineProps({ url: { type: String, default: '' } });
const emit = defineEmits(['close']);
const onKey = e => { if (props.url && e.key === 'Escape') emit('close'); };
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="lb">
            <div v-if="url" class="gc-lb" role="dialog" aria-modal="true" aria-label="图片预览" @click="emit('close')">
                <button type="button" class="cl" title="关闭" aria-label="关闭" @click.stop="emit('close')"><ChIcon name="x" /></button>
                <img :src="url" alt="preview" @click.stop />
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
/* 看图遮罩：始终是深色底（图片查看器，深浅主题一致），上面的按钮用白字 */
.gc-lb { position: fixed; inset: 0; z-index: 2400; display: flex; align-items: center; justify-content: center; padding: 56px; background: rgba(10,10,10,.82); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); cursor: zoom-out; }
.gc-lb img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; box-shadow: 0 40px 100px -30px rgba(0,0,0,.8); cursor: default; }
.cl { position: absolute; right: 24px; top: 20px; width: 36px; height: 36px; border: 0; border-radius: 99px; background: rgba(255,255,255,.12); color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background var(--duration-fast); }
.cl:hover { background: rgba(255,255,255,.22); }
.cl .nv-i { width: 16px; height: 16px; }
.lb-enter-active, .lb-leave-active { transition: opacity .22s var(--ease-out); }
.lb-enter-active img, .lb-leave-active img { transition: transform .32s var(--ease-sheet); }
.lb-enter-from, .lb-leave-to { opacity: 0; }
.lb-enter-from img { transform: scale(.96); }
</style>
