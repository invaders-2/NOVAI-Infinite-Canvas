<script setup>
// 二次确认（替代旧页面的 window.confirm）。state = useConfirm().st.value
import ApiDialog from './ApiDialog.vue';
defineProps({ state: Object });
const emit = defineEmits(['done']);
</script>

<template>
    <ApiDialog :open="!!state" width="360px" top label="确认" @close="emit('done', false)">
        <div v-if="state" class="cf">
            <h2 class="nv-dialog-title">{{ state.title }}</h2>
            <p v-if="state.desc" class="nv-dialog-body">{{ state.desc }}</p>
            <div class="nv-dialog-actions">
                <button type="button" class="nv-btn ghost" @click="emit('done', false)">取消</button>
                <button type="button" class="nv-btn" :class="state.danger ? 'danger' : 'primary'" @click="emit('done', true)">{{ state.ok }}</button>
            </div>
        </div>
    </ApiDialog>
</template>

<style scoped>
.cf { padding: 24px; display: flex; flex-direction: column; gap: 8px; }
</style>
