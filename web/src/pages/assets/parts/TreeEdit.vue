<script setup>
// 树内联编辑（新建 / 重命名库与分组）：Enter 保存、Esc 取消，挂载即聚焦全选
import { ref, onMounted, nextTick } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';

const props = defineProps({ value: { type: String, default: '' }, placeholder: { type: String, default: '名称' }, head: { type: Boolean, default: false } });
const emit = defineEmits(['save', 'cancel']);
const text = ref(props.value);
const el = ref(null);
const busy = ref(false);
onMounted(() => nextTick(() => { if (el.value) { el.value.focus(); el.value.select(); } }));
async function save() {
    if (busy.value) return;
    busy.value = true;
    try { await emitSave(); } finally { busy.value = false; }
}
function emitSave() { return new Promise(resolve => emit('save', text.value, resolve)); }
</script>

<template>
    <div class="am-tedit" :class="{ head }" @click.stop>
        <input ref="el" v-model="text" class="am-inp" type="text" :placeholder="placeholder" :aria-label="placeholder" maxlength="80"
               @keydown.enter.prevent="save" @keydown.esc.prevent.stop="emit('cancel')">
        <button type="button" class="am-ib pri" title="保存" :disabled="busy" @click="save"><span v-if="busy" class="am-spin"></span><NvIcon v-else name="check" /></button>
        <button type="button" class="am-ib" title="取消" @click="emit('cancel')"><NvIcon name="x" /></button>
    </div>
</template>
