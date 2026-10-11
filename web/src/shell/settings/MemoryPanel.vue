<script setup>
// 记忆：长期记忆库（/api/memories）的列表、批量启停与新增。
// 与 GPT 对话页记忆库同一套数据与作用域口径（全局 / 本对话），样式沿用设置页现有卡片/行/开关。
// 后端没有「总开关」字段：批量启停逐条 PATCH 每条的 enabled，不新造字段。
import { ref, computed, onMounted } from 'vue';
import SetCard from './SetCard.vue';
import SetRow from './SetRow.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import NvPills from '../../components/NvPills.vue';
import NvIcon from '../../components/NvIcon.vue';
import { toast } from '../../lib/store.js';
import { L, loadMemories, setScope, addMemory, toggleMemory, switchMemoryScope, deleteMemory, setAllEnabled } from './memoryApi.js';

const text = ref('');
const busy = ref(false);
const SCOPES = [{ value: 'global', label: '全局' }, { value: 'conversation', label: '本对话' }];

const enabledCount = computed(() => L.memories.filter(m => m && m.enabled !== false).length);
const listDesc = computed(() => {
    if (L.note) return L.note;
    if (!L.memories.length) return '暂无记忆';
    return `共 ${L.memories.length} 条 · ${enabledCount.value} 条已启用`;
});

onMounted(loadMemories);

async function setAll(enabled) {
    if (busy.value || !L.memories.length) return;
    busy.value = true;
    const ok = await setAllEnabled(enabled);
    busy.value = false;
    if (ok) toast(enabled ? '已启用全部记忆' : '已停用全部记忆', { icon: 'check' });
    else toast(L.note || '更新失败', { danger: true, icon: 'alert' });
}
async function submit() {
    if (!text.value.trim() || L.adding) return;
    const ok = await addMemory(text.value);
    if (ok) { text.value = ''; toast('已添加记忆', { icon: 'check' }); }
    else toast(L.note || '添加失败', { danger: true, icon: 'alert' });
}
async function remove(item) {
    await deleteMemory(item);
    if (L.note) toast(L.note, { danger: true, icon: 'alert' });
    else toast('已删除记忆', { icon: 'check' });
}
</script>

<template>
    <div>
        <SetCard>
            <template #action>
                <div class="bulk">
                    <button type="button" class="nv-btn sm ghost" :disabled="busy || !L.memories.length" @click="setAll(true)">全部启用</button>
                    <button type="button" class="nv-btn sm ghost" :disabled="busy || !L.memories.length" @click="setAll(false)">全部停用</button>
                </div>
            </template>
            <SetRow label="记忆列表" :desc="listDesc" stack>
                <div class="mlist">
                    <p v-if="!L.loaded" class="hint">记忆加载中…</p>
                    <p v-else-if="!L.memories.length" class="hint">还没有记忆，在下面添加一条长期使用偏好</p>
                    <div v-for="m in L.memories" :key="m.id" class="mrow" :class="{ off: m.enabled === false }">
                        <NvSwitch :model-value="m.enabled !== false" :label="`启用：${m.content}`" @update:model-value="toggleMemory(m)" />
                        <span class="tx" :title="m.content">{{ m.content }}</span>
                        <button type="button" class="scope" :class="{ g: m.scope !== 'conversation' }"
                            :title="m.scope === 'conversation' ? '仅当前对话生效 · 点击切为全局' : '全局生效 · 点击切为本对话'"
                            @click="switchMemoryScope(m)">{{ m.scope === 'conversation' ? '本对话' : '全局' }}</button>
                        <button type="button" class="nv-icon-btn sm round del" title="删除" aria-label="删除" @click="remove(m)"><NvIcon name="trash" /></button>
                    </div>
                </div>
            </SetRow>
            <SetRow label="新增记忆" desc="先选作用域，再写要长期记住的偏好" stack>
                <div class="madd">
                    <NvPills :model-value="L.scope" :options="SCOPES" label="记忆作用域" @update:model-value="setScope" />
                    <span class="nv-field grow"><input v-model="text" type="text" placeholder="例如：回答用中文、少用术语" maxlength="1000" aria-label="新增记忆内容" @keydown.enter="submit" /></span>
                    <button type="button" class="nv-btn sm primary" :disabled="L.adding || !text.trim()" @click="submit">添加</button>
                </div>
            </SetRow>
        </SetCard>
    </div>
</template>

<style scoped>
.bulk { display: flex; align-items: center; gap: 8px; }
.mlist { display: flex; flex-direction: column; width: 100%; }
.mrow { display: flex; align-items: center; gap: 10px; min-height: 44px; }
.mrow + .mrow { box-shadow: 0 -1px 0 var(--separator); }
.mrow .tx { flex: 1; min-width: 0; font: 400 12.5px/1.4 var(--font-sans); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrow.off .tx { color: var(--ink-4); }
.scope { height: 22px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--solid); color: var(--ink-2); font: 400 11px/1 var(--font-sans); cursor: pointer; flex: none; }
.scope.g { background: var(--accent); color: var(--on-accent); }
.del { color: var(--ink-3); }
.del:hover { color: var(--danger); background: var(--danger-fill); }
.hint { margin: 12px 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.madd { display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; padding: 4px 0 6px; }
.madd .grow { flex: 1 1 160px; min-width: 0; }
</style>
