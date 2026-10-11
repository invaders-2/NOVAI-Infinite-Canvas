<script setup>
// 节点图里点选节点后的弹层：列出该节点所有可配置输入（InputRow）
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import InputRow from './InputRow.vue';
import { t } from '../../../lib/store.js';
import { nodeLabel, nodeSub, nodeIcon, configurableInputs } from './nodeInfo.js';
import { wf } from './wfStore.js';

defineProps({ pos: { type: Object, required: true } });   // { left, top, maxH }
const emit = defineEmits(['close']);
const node = computed(() => (wf.workflow && wf.popupNodeId ? wf.workflow[wf.popupNodeId] : null));
const inputs = computed(() => configurableInputs(node.value));
</script>

<template>
    <div v-if="node" class="np nv-glass-pop" role="dialog" :aria-label="nodeLabel(node)" :style="{ left: pos.left + 'px', top: pos.top + 'px', maxHeight: pos.maxH + 'px' }" @wheel.stop @mousedown.stop>
        <div class="nph">
            <span class="ic"><NvIcon :name="nodeIcon(node)" /></span>
            <div class="tt"><b>{{ nodeLabel(node) }}</b><span>{{ nodeSub(node) }} · #{{ wf.popupNodeId }}</span></div>
            <button type="button" class="nv-icon-btn sm round x" title="关闭" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
        </div>
        <div class="npb">
            <div v-if="!inputs.length" class="empty">{{ t('comfy.noConfigFields', '此节点没有可配置字段（所有输入都来自连线）') }}</div>
            <InputRow v-for="[k, v] in inputs" :key="wf.popupNodeId + ':' + k" :node-id="wf.popupNodeId" :input-key="k" :raw-value="v" />
        </div>
    </div>
</template>

<style scoped>
.np { position: absolute; z-index: 10; width: 380px; display: flex; flex-direction: column; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-pop); cursor: default; animation: np-in 220ms var(--ease-out) both; }
@keyframes np-in { from { opacity: 0; transform: translateY(-4px) scale(.99); } to { opacity: 1; transform: none; } }
.nph { display: flex; align-items: center; gap: 10px; padding: 12px 12px 8px 14px; flex: none; }
.ic { width: 28px; height: 28px; flex: none; border-radius: 8px; background: var(--fill-1); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); }
.ic .nv-i { width: 14px; height: 14px; }
.tt { flex: 1; min-width: 0; }
.tt b { display: block; font: 500 13px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt span { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x { background: var(--fill-1); color: var(--ink-3); }
.npb { min-height: 0; overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 4px; overscroll-behavior: contain; }
.empty { padding: 18px; border-radius: 12px; background: var(--fill-1); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
</style>
