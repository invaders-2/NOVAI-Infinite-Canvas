<script setup>
// 确认弹窗（替代旧 confirm()）：state = { title, desc, ok, danger }，@done(true|false)
import ApiModal from './ApiModal.vue';
defineProps({ state: Object });
const emit = defineEmits(['done']);
</script>

<template>
    <ApiModal :open="!!state" :width="380" :label="state && state.title" @close="emit('done', false)">
        <div v-if="state" class="cf">
            <h3>{{ state.title }}</h3>
            <p v-if="state.desc">{{ state.desc }}</p>
            <div class="acts">
                <button type="button" class="nv-btn sm ghost" @click="emit('done', false)">取消</button>
                <button type="button" class="nv-btn sm" :class="state.danger ? 'danger' : 'primary'" @click="emit('done', true)">{{ state.ok || '确认' }}</button>
            </div>
        </div>
    </ApiModal>
</template>

<style scoped>
.cf { padding: 22px 22px 18px; display: flex; flex-direction: column; gap: 8px; }
h3 { margin: 0; font: 500 15px/22px var(--font-sans); }
p { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
