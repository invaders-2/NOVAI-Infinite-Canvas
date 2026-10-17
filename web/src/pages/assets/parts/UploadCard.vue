<script setup>
// 网格首位的上传卡：点击选文件，拖入文件直接上传（旧版的 #assetDrop / #localUploadDrop / #workflowDrop）
import { ref } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';

const props = defineProps({
    title: { type: String, default: '上传' },
    sub: { type: String, default: '' },
    accept: { type: String, default: 'image/*,video/*,audio/*' },
    disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['files']);
const input = ref(null);
const drag = ref(false);
function pick() { if (!props.disabled) input.value && input.value.click(); }
function changed(e) {
    const files = e.target.files;
    if (files && files.length) emit('files', [...files]);
    e.target.value = '';
}
function over(e) { if (props.disabled) return; e.preventDefault(); drag.value = true; }
function drop(e) {
    if (props.disabled) return;
    e.preventDefault();
    drag.value = false;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) emit('files', [...files]);
}
defineExpose({ pick });
</script>

<template>
    <button type="button" class="am-card am-up" :class="{ drag }" :disabled="disabled" @click="pick" @dragover="over" @dragleave="drag = false" @drop="drop">
        <span class="am-cm"><NvIcon name="upload" /><span>拖入文件或点击上传</span></span>
        <span class="nm">{{ title }}</span>
        <span class="mt">{{ sub }}</span>
        <input ref="input" type="file" :accept="accept" multiple hidden @change="changed">
    </button>
</template>
