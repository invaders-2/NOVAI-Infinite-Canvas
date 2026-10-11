<script setup>
// 完整节点列表：每个节点一张可折叠卡片，有已暴露字段的默认展开
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import InputRow from './InputRow.vue';
import { t } from '../../../lib/store.js';
import { nodeLabel, nodeSub, nodeIcon, configurableInputs, sortNodeIds, tf } from './nodeInfo.js';
import { wf } from './wfStore.js';

const open = ref({});   // nodeId -> bool（用户手动展开 / 收起；未设置时按「有已暴露字段」）
watch(() => wf.selectedName, () => { open.value = {}; });
const nodes = computed(() => {
    const w = wf.workflow || {};
    const fields = (wf.config && wf.config.fields) || [];
    return sortNodeIds(Object.keys(w)).map(id => {
        const inputs = configurableInputs(w[id]);
        const exposed = inputs.filter(([k]) => fields.some(f => f.node === id && f.input === k)).length;
        return { id, node: w[id], inputs, exposed };
    });
});
function isOpen(n) { return open.value[n.id] !== undefined ? open.value[n.id] : n.exposed > 0; }
function toggle(n) { open.value = { ...open.value, [n.id]: !isOpen(n) }; }
</script>

<template>
    <div class="nl">
        <div v-for="n in nodes" :key="n.id" class="nc" :class="{ open: isOpen(n) }">
            <button type="button" class="h" :aria-expanded="isOpen(n)" @click="toggle(n)">
                <span class="ic"><NvIcon :name="nodeIcon(n.node)" /></span>
                <span class="tt">
                    <b>{{ nodeLabel(n.node) }}</b>
                    <span>{{ nodeSub(n.node) }} · #{{ n.id }} · {{ tf('comfy.configurableCount', { count: n.inputs.length }, '{count} 个可配字段') }}</span>
                </span>
                <span v-if="n.exposed > 0" class="st">{{ tf('comfy.exposedCount', { count: n.exposed }, '{count} 已暴露') }}</span>
                <NvIcon name="chev" class="chev" />
            </button>
            <div class="bwrap">
                <div class="b">
                    <div class="bin">
                        <div v-if="!n.inputs.length" class="empty">{{ t('comfy.noConfigInputs', '此节点没有可配置字段（输入都来自连线）') }}</div>
                        <InputRow v-for="[k, v] in n.inputs" :key="n.id + ':' + k" :node-id="n.id" :input-key="k" :raw-value="v" solid />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.nl { display: flex; flex-direction: column; gap: 10px; }
.nc { border-radius: 12px; background: var(--fill-1); }
.h { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 0; border-radius: 12px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.h:hover { background: var(--fill-1); }
.ic { width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--solid); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); }
.ic .nv-i { width: 13px; height: 13px; }
.tt { flex: 1; min-width: 0; }
.tt b { display: block; font: 500 12.5px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt span { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st { flex: none; font: 400 11px/1 var(--font-sans); color: var(--ink-2); }
.chev { width: 14px; height: 14px; color: var(--ink-3); transition: transform 220ms var(--ease-out); }
.nc.open .chev { transform: rotate(180deg); }
.bwrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 260ms var(--ease-out); }
.nc.open .bwrap { grid-template-rows: 1fr; }
.b { min-height: 0; overflow: hidden; }
.nc.open .b { overflow: visible; }
.bin { padding: 0 6px 6px; display: flex; flex-direction: column; gap: 2px; }
.empty { padding: 14px; font: 400 11px/16px var(--font-sans); color: var(--ink-4); text-align: center; }
</style>
