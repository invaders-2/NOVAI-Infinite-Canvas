<script setup>
// 输入框下方的「猜你想问」：文案与能力指向全部来自后端 GET /api/capabilities/suggestions，
// 前端不写死任何一条；点击 = 填进输入框并按需挂上 capability（type=agent/skill/generate-image）。
import { onMounted } from 'vue';
import ChIcon from '../ChIcon.vue';
import { CAP, loadSuggestions } from './capState.js';

const emit = defineEmits(['pick']);
// iconType -> 线性图标（对齐 sealseek 的 hot / new / skill / generate-image）
const ICON = { hot: 'bolt', new: 'sparkles', skill: 'wand2', 'generate-image': 'image' };
function iconOf(s) { return ICON[String((s && s.icon_type) || '')] || 'chat'; }

onMounted(() => { loadSuggestions(); });
</script>

<template>
    <div v-if="CAP.suggestions.length" class="sq-row" aria-label="猜你想问">
        <span class="lbl">猜你想问</span>
        <button v-for="s in CAP.suggestions" :key="s.id" type="button" class="q" :title="s.text" @click="emit('pick', s)">
            <ChIcon :name="iconOf(s)" />
            <span>{{ s.text }}</span>
        </button>
    </div>
</template>

<style scoped>
.sq-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 0 2px; }
.lbl { flex: none; font: 400 11px/1 var(--font-mono); letter-spacing: .04em; color: var(--ink-4); }
.q { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 30px; padding: 0 12px; border: 0; border-radius: 999px;
    background: var(--fill-1); color: var(--ink-2); font: 400 12px/1 var(--font-sans); cursor: pointer; white-space: nowrap;
    overflow: hidden; transition: background var(--duration-fast), color var(--duration-fast), transform var(--duration-base) var(--ease-out); }
.q:hover { background: var(--fill-2); color: var(--ink); transform: translateY(-1px); }
.q .nv-i { flex: none; width: 13px; height: 13px; color: var(--ink-3); }
.q:hover .nv-i { color: var(--ink-2); }
.q > span { overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 640px) { .sq-row { flex-wrap: nowrap; overflow-x: auto; } }
</style>
