<script setup>
// 运行结果大图预览：点结果图打开，点空白 / Esc 关闭
import { watch, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { wf } from './wfStore.js';

function close() { wf.lightbox = ''; }
function onKey(e) { if (e.key === 'Escape' && wf.lightbox) { e.stopImmediatePropagation(); e.preventDefault(); close(); } }
watch(() => wf.lightbox, v => {
    if (v) window.addEventListener('keydown', onKey, true);
    else window.removeEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="wflb">
            <div v-if="wf.lightbox" class="wflb" role="dialog" aria-modal="true" aria-label="结果预览" @click="close">
                <img :src="wf.lightbox" alt="preview" @click.stop />
                <button type="button" class="wflb-x" title="关闭" aria-label="关闭" @click.stop="close"><NvIcon name="x" /></button>
            </div>
        </Transition>
    </Teleport>
</template>

<style>
.wflb { position: fixed; inset: 0; z-index: 2550; display: flex; align-items: center; justify-content: center; padding: 48px; background: rgba(10,10,10,.82); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); cursor: zoom-out; }
.wflb img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.6); cursor: default; }
.wflb-x { position: absolute; top: 18px; right: 18px; width: 32px; height: 32px; border: 0; border-radius: 999px; background: rgba(255,255,255,.12); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.wflb-x:hover { background: rgba(255,255,255,.2); }
.wflb-enter-active { transition: opacity 240ms var(--ease-out); }
.wflb-enter-active img { transition: transform 320ms var(--ease-sheet); }
.wflb-leave-active { transition: opacity 160ms var(--ease-out); }
.wflb-enter-from, .wflb-leave-to { opacity: 0; }
.wflb-enter-from img { transform: scale(.98) translateY(10px); }
</style>
