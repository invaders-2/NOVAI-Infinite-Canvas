<script setup>
// 输入框：附件条（图片缩略 / 文件卡片，最多 20 个，可拖入 / 粘贴 / 「+」选择）、自适应高度的文本框（Enter 发送、Shift+Enter 换行）、
// 尺寸（Agent / 图像模式）、平台与模型、思考强度（推理模型）、发送 / 停止。
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import ChIcon from './ChIcon.vue';
import SizePicker from './SizePicker.vue';
import ModelPicker from './ModelPicker.vue';
import ThinkPicker from './ThinkPicker.vue';
import { S, thinkLevels } from './chatState.js';
import { C, send, stop, uploadFiles, removeRef, isImageRef, attachmentName } from './session.js';
import { t } from '../../lib/store.js';

const emit = defineEmits(['preview']);
const text = ref('');
const ta = ref(null);
const fileIn = ref(null);
const body = ref(null);
const drag = ref(false);

const canSend = computed(() => !!text.value.trim() && !C.busy);
const showThink = computed(() => !!(thinkLevels.value && thinkLevels.value.length));

function grow() {
    const el = ta.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
}
function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!C.busy) submit(); }
}
async function submit() {
    if (C.busy) { stop(); return; }
    const v = text.value;
    if (!v.trim()) return;
    text.value = '';
    nextTick(grow);
    await send(v);
}
function fill(v) {
    text.value = v;
    nextTick(() => { grow(); if (ta.value) { ta.value.focus(); ta.value.setSelectionRange(v.length, v.length); } });
}
function focus() { if (ta.value) ta.value.focus(); }
defineExpose({ fill, focus });

function pickFiles(e) { uploadFiles(e.target.files); e.target.value = ''; }
const hasFiles = dt => Array.from((dt && dt.items) || []).some(it => it.kind === 'file');
function onDragOver(e) { if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); drag.value = true; }
function onDragLeave(e) { if (!body.value || !body.value.contains(e.relatedTarget)) drag.value = false; }
function onDrop(e) { if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); drag.value = false; uploadFiles(e.dataTransfer.files); }

// 粘贴图片 / 文件（与旧版一样挂在 window 上；页面不在前台时不接）
const props = defineProps({ active: { type: Boolean, default: true } });
function onPaste(e) {
    if (!props.active) return;
    const files = Array.from((e.clipboardData && e.clipboardData.items) || []).filter(x => x.kind === 'file').map(x => x.getAsFile()).filter(Boolean);
    if (files.length) uploadFiles(files);
}
onMounted(() => { window.addEventListener('paste', onPaste); grow(); });
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));
</script>

<template>
    <div ref="body" class="cmp" :class="{ drag }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
        <TransitionGroup v-if="C.refs.length || C.uploading" tag="div" name="ref" class="refs">
            <div v-for="(r, i) in C.refs" :key="r.url + i" class="ref" :class="{ fl: !isImageRef(r) }" :title="attachmentName(r)">
                <img v-if="isImageRef(r)" :src="r.url" alt="" @click="emit('preview', r.url)" />
                <template v-else><ChIcon name="file" /><span class="nm">{{ attachmentName(r) }}</span></template>
                <button type="button" class="x" aria-label="移除附件" @click="removeRef(i)"><ChIcon name="x" /></button>
            </div>
            <div v-if="C.uploading" key="__up" class="ref up"><span class="spin"></span></div>
        </TransitionGroup>
        <textarea ref="ta" v-model="text" rows="1" :placeholder="t('chat.inputPlaceholder', '请输入任务，交给我来帮你完成')" @input="grow" @keydown="onKey"></textarea>
        <div class="foot">
            <input ref="fileIn" class="file-in" type="file" multiple @change="pickFiles" />
            <button type="button" class="add" title="选择文件" aria-label="选择文件" @click="fileIn && fileIn.click()"><ChIcon name="plus" /></button>
            <SizePicker v-if="S.mode !== 'chat'" />
            <span class="grow"></span>
            <ModelPicker />
            <ThinkPicker v-if="showThink" />
            <button type="button" class="send" :class="{ busy: C.busy, off: !C.busy && !canSend }" :disabled="!C.busy && !canSend"
                :title="C.busy ? '停止' : t('chat.send', '发送')" :aria-label="C.busy ? '停止' : t('chat.send', '发送')" @click="submit">
                <template v-if="C.busy"><span class="spin"></span><ChIcon name="stop" class="stop" /></template>
                <ChIcon v-else name="send" />
            </button>
        </div>
    </div>
</template>

<style scoped>
.cmp { position: relative; border-radius: 20px; padding: 12px 12px 10px 16px; background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%);
    box-shadow: var(--shadow-rim), var(--shadow-lift); display: flex; flex-direction: column; gap: 10px; transition: box-shadow var(--duration-base) var(--ease-out), background var(--duration-base); }
.cmp:focus-within { box-shadow: var(--shadow-rim), var(--shadow-pop); }
.cmp.drag { background: var(--solid); box-shadow: var(--shadow-lift); }
textarea { width: 100%; min-height: 48px; max-height: 40vh; padding: 2px 0; border: 0; outline: 0; resize: none; background: transparent; color: var(--ink); font: 400 14.5px/24px var(--font-sans); }
textarea::placeholder { color: var(--ink-4); }
.refs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-top: 4px; }
.ref { position: relative; width: 48px; height: 48px; border-radius: 10px; background: var(--fill-1); }
.ref img { width: 100%; height: 100%; object-fit: cover; border-radius: 10px; display: block; cursor: zoom-in; }
.ref.fl { width: auto; max-width: 220px; padding: 0 14px 0 10px; display: inline-flex; align-items: center; gap: 8px; font: 400 12px/1 var(--font-sans); color: var(--ink-2); }
.ref.fl .nv-i { width: 16px; height: 16px; color: var(--ink-3); flex: none; }
.ref .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref.up { display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.ref.up .spin { width: 14px; height: 14px; }
.ref .x { position: absolute; right: -5px; top: -5px; width: 17px; height: 17px; padding: 0; border: 0; border-radius: 6px; cursor: pointer; background: var(--accent); color: var(--on-accent);
    display: inline-flex; align-items: center; justify-content: center; opacity: 0; transform: scale(.85); transition: opacity var(--duration-fast), transform var(--duration-fast) var(--ease-out); }
.ref .x .nv-i { width: 10px; height: 10px; }
.ref:hover .x, .ref .x:focus-visible { opacity: 1; transform: none; }
.ref-enter-active, .ref-leave-active { transition: opacity .18s var(--ease-out), transform .18s var(--ease-out); }
.ref-enter-from, .ref-leave-to { opacity: 0; transform: scale(.9); }
.foot { display: flex; align-items: center; gap: 6px; min-width: 0; }
.grow { flex: 1; }
.file-in { display: none; }
.add { width: 32px; height: 32px; flex: none; border: 0; border-radius: 99px; cursor: pointer; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; transition: background var(--duration-fast), color var(--duration-fast); }
.add:hover { background: var(--fill-2); color: var(--ink); }
.add .nv-i { width: 16px; height: 16px; }
.send { position: relative; width: 34px; height: 34px; flex: none; margin-left: 4px; border: 0; border-radius: 99px; cursor: pointer; background: var(--accent); color: var(--on-accent);
    display: inline-flex; align-items: center; justify-content: center; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base), background var(--duration-fast); }
.send:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-lift); }
.send .nv-i { width: 15px; height: 15px; }
.send.off { background: var(--fill-2); color: var(--ink-4); cursor: default; }
.send.busy { background: var(--fill-2); color: var(--ink-2); }
.send.busy .spin { width: 14px; height: 14px; transition: opacity var(--duration-fast); }
.send.busy .stop { position: absolute; width: 12px; height: 12px; opacity: 0; transition: opacity var(--duration-fast); }
.send.busy:hover .spin { opacity: 0; }
.send.busy:hover .stop { opacity: 1; }
@media (max-width: 640px) { .foot { flex-wrap: wrap; } }
</style>
