<script setup>
// 工作流设置（替代旧 static/comfyui-settings.html）：
// 左栏 后端地址 / 工作流列表 / 画布节点预览；右栏 名称 + 删除 / 保存配置 + 「工作流 | 测试画布」+ 节点图 + 完整节点列表
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import InstancesCard from './workflow/InstancesCard.vue';
import WorkflowListCard from './workflow/WorkflowListCard.vue';
import PreviewCard from './workflow/PreviewCard.vue';
import NodeGraph from './workflow/NodeGraph.vue';
import NodeList from './workflow/NodeList.vue';
import TestCanvas from './workflow/TestCanvas.vue';
import WfDialog from './workflow/WfDialog.vue';
import WfLightbox from './workflow/WfLightbox.vue';
import { t } from '../../lib/store.js';
import { tf } from './workflow/nodeInfo.js';
import { wf, loadList, resetAll, saveConfig, deleteWorkflow, updateWorkflowTitle } from './workflow/wfStore.js';

const showNodes = ref(false);
const confirmDel = ref(false);
const sub = computed(() => {
    if (!wf.workflow) return t('comfy.editorSubDefault', '从左侧列表选择，或上传新的 API 工作流');
    return tf('comfy.nodeStats', { nodes: Object.keys(wf.workflow).length, fields: wf.config.fields.length }, '{nodes} 个节点 · 已暴露 {fields} 个字段') + (wf.isBuiltin ? ` · ${t('comfy.builtin', '内置')}` : '');
});
// 与旧版一致：只在切换 / 重新加载工作流时回填输入框，清空时不强行回填
const titleValue = ref('');
watch(() => [wf.fitTick, wf.config], () => { titleValue.value = (wf.config && wf.config.title) || wf.selectedName.replace('.json', ''); }, { immediate: true });
function onTitle(e) { titleValue.value = e.target.value; updateWorkflowTitle(e.target.value); }
const delName = computed(() => (wf.config && wf.config.title) || wf.selectedName);
function setMode(m) { wf.mode = m === 'canvas' ? 'canvas' : 'graph'; if (wf.mode === 'canvas') wf.popupNodeId = null; }
async function doDelete() { await deleteWorkflow(); confirmDel.value = false; }

onMounted(() => { resetAll(); loadList(); });
onBeforeUnmount(resetAll);
</script>

<template>
    <div class="wfs">
        <aside class="side">
            <InstancesCard />
            <WorkflowListCard />
            <PreviewCard />
        </aside>
        <main class="main">
            <template v-if="wf.workflow">
                <div class="head">
                    <div class="ti">
                        <input class="title" type="text" :value="titleValue" :placeholder="t('comfy.workflowName', '工作流名称')" :aria-label="t('comfy.workflowName', '工作流名称')" @input="onTitle" />
                        <span class="sub">{{ sub }}</span>
                    </div>
                    <button v-if="!wf.isBuiltin" type="button" class="nv-btn sm danger" :disabled="wf.deleting" @click="confirmDel = true"><NvIcon name="trash" />{{ t('common.delete', '删除') }}</button>
                    <button type="button" class="nv-btn sm primary" :disabled="wf.saving" @click="saveConfig"><span v-if="wf.saving" class="spin s12"></span><NvIcon v-else name="save" />{{ t('comfy.saveConfig', '保存配置') }}</button>
                </div>
                <div class="seg" role="tablist">
                    <button type="button" role="tab" :class="{ on: wf.mode === 'graph' }" :aria-selected="wf.mode === 'graph'" @click="setMode('graph')">{{ t('comfy.workflow', '工作流') }}</button>
                    <button type="button" role="tab" :class="{ on: wf.mode === 'canvas' }" :aria-selected="wf.mode === 'canvas'" @click="setMode('canvas')">{{ t('comfy.testCanvas', '测试画布') }}</button>
                </div>
                <Transition name="ws" mode="out-in">
                    <NodeGraph v-if="wf.mode === 'graph'" key="g" />
                    <TestCanvas v-else key="c" />
                </Transition>
                <template v-if="wf.mode === 'graph'">
                    <button type="button" class="toggle" :aria-expanded="showNodes" @click="showNodes = !showNodes"><NvIcon name="list" />{{ showNodes ? t('comfy.hideNodeList', '收起节点列表') : t('comfy.showNodeList', '显示完整节点列表') }}</button>
                    <Transition name="nlt"><NodeList v-if="showNodes" /></Transition>
                </template>
            </template>
            <div v-else-if="wf.opening || wf.listLoading" class="nv-skel ph"></div>
            <div v-else class="empty">{{ t('comfy.editorSubDefault', '从左侧列表选择，或上传新的 API 工作流') }}</div>
        </main>
        <WfDialog :open="confirmDel" title="确认删除" :desc="tf('comfy.deleteConfirm', { name: delName }, '确认删除工作流「{name}」？此操作不可恢复。')" :confirm-text="t('common.delete', '删除')" :cancel-text="t('common.cancel', '取消')" danger :busy="wf.deleting" @confirm="doDelete" @cancel="confirmDel = false" />
        <WfLightbox />
    </div>
</template>

<style scoped>
.wfs { display: flex; align-items: flex-start; gap: 20px; }
.side { width: 300px; flex: none; display: flex; flex-direction: column; gap: 16px; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: flex-start; gap: 10px; }
.ti { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.title { height: 36px; padding: 0 10px; border: 0; outline: 0; border-radius: var(--radius-md); background: var(--fill-1); color: var(--ink); font: 500 15px/1 var(--font-sans); transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.title:hover { background: var(--fill-2); }
.title:focus { background: var(--fill-2); box-shadow: none; }
.sub { padding-left: 2px; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.head .nv-btn { margin-top: 4px; }
.s12 { width: 12px; height: 12px; }
.seg { align-self: flex-start; display: inline-flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--fill-1); }
.seg button { height: 28px; padding: 0 14px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-3); font: 400 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast), box-shadow var(--duration-fast); }
.seg button:hover { color: var(--ink-2); }
.seg button.on { background: var(--solid); color: var(--ink); font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--fill-1); color: var(--ink); font: 400 12px/1 var(--font-sans); cursor: pointer; }
.toggle:hover { background: var(--fill-2); }
.toggle .nv-i { width: 13px; height: 13px; color: var(--ink-3); }
.ph { height: 560px; border-radius: 14px; }
.empty { padding: 48px 18px; border-radius: 14px; background: var(--fill-1); font: 400 12px/18px var(--font-sans); color: var(--ink-3); text-align: center; }
.ws-enter-active, .ws-leave-active { transition: opacity 160ms var(--ease-out), transform 200ms var(--ease-out); }
.ws-enter-from { opacity: 0; transform: translateY(6px); }
.ws-leave-to { opacity: 0; }
.nlt-enter-active, .nlt-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.nlt-enter-from, .nlt-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
