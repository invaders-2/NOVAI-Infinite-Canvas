<script setup>
// 参考图三格（Main / Aux A / Aux B）：点击选文件、拖入图片、右上角 × 清除；上传由父组件处理
import { ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';

defineProps({ slots: { type: Array, default: () => [] } });     // [{ preview, uploading }]
const emit = defineEmits(['file', 'clear']);
const LABELS = ['Main', 'Aux A', 'Aux B'];
const inputs = ref([]);
const over = ref(-1);

function pickFile(i) { const el = inputs.value[i]; if (el) el.click(); }
function onChange(i, e) { const f = e.target.files && e.target.files[0]; if (f) emit('file', i, f); e.target.value = ''; }
function onDrop(i, e) { over.value = -1; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) emit('file', i, f); }
</script>

<template>
    <div class="ors">
        <div v-for="(s, i) in slots" :key="i" class="slot" :class="{ has: !!s.preview, drag: over === i }" role="button" tabindex="0"
            :aria-label="'参考图 ' + LABELS[i]" @click="pickFile(i)" @keydown.enter.prevent="pickFile(i)"
            @dragover.prevent="over = i" @dragleave="over = -1" @drop.prevent="onDrop(i, $event)">
            <input :ref="el => (inputs[i] = el)" type="file" accept="image/*" hidden @change="onChange(i, $event)" />
            <template v-if="s.preview">
                <img :src="s.preview" alt="" draggable="false" />
                <span class="tg">{{ LABELS[i] }}</span>
                <span v-if="s.uploading" class="up"><span class="spin"></span></span>
                <button type="button" class="x" title="移除" aria-label="移除" @click.stop="emit('clear', i)"><NvIcon name="x" /></button>
            </template>
            <template v-else>
                <NvIcon name="plus" /><span class="l">{{ LABELS[i] }}</span>
            </template>
        </div>
    </div>
</template>

<style scoped>
.ors { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.slot { position: relative; aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--fill-1); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--ink-3); cursor: pointer; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-base) var(--ease-out); }
.slot:hover { background: var(--fill-2); color: var(--ink); transform: translateY(-1px); }
.slot.drag { background: var(--fill-3); box-shadow: none; color: var(--ink); }
.slot > .nv-i { width: 16px; height: 16px; }
.slot .l { font: 400 10.5px/1 var(--font-mono); letter-spacing: .05em; text-transform: uppercase; }
.slot img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; animation: ors-in .4s var(--ease-out); }
@keyframes ors-in { from { opacity: 0; } to { opacity: 1; } }
.slot .tg { position: absolute; left: 6px; bottom: 6px; height: 16px; padding: 0 5px; border-radius: 5px; background: rgba(10,10,10,.5); color: #fff; font: 400 11px/16px var(--font-mono); letter-spacing: .04em; text-transform: uppercase; }
.slot .x { position: absolute; right: 5px; top: 5px; width: 20px; height: 20px; border: 0; border-radius: 99px; background: rgba(10,10,10,.6); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.slot .x:hover { background: rgba(10,10,10,.8); }
.slot .x .nv-i { width: 11px; height: 11px; }
.slot .up { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(10,10,10,.25); color: #fff; }
</style>
