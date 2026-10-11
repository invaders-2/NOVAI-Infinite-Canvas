<script setup>
// 工作流列表（内置 / 上传）+ 上传 JSON（选文件 → 命名弹窗 → POST /api/workflows）
import { ref } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import WfDialog from './WfDialog.vue';
import { t } from '../../../lib/store.js';
import { tf } from './nodeInfo.js';
import { wf, selectWorkflow, readWorkflowFile, uploadWorkflow } from './wfStore.js';

const fileEl = ref(null);
const pending = ref(null);     // { workflow, baseName }

async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const parsed = await readWorkflowFile(file);
    if (parsed) pending.value = parsed;
}
async function onName(name) {
    const p = pending.value;
    if (!p) return;
    const ok = await uploadWorkflow(name, p.workflow);
    if (ok) pending.value = null;
}
function pick(w) { selectWorkflow(w.name); }   // 与旧版一致：再次点击当前项会重新加载（丢弃未保存的修改）
</script>

<template>
    <section class="grp">
        <span class="cap">{{ t('comfy.workflowList', '工作流列表') }}</span>
        <div class="list">
            <template v-if="wf.listLoading && !wf.workflows.length"><div v-for="i in 3" :key="i" class="nv-skel sk"></div></template>
            <div v-else-if="!wf.workflows.length" class="empty">还没有工作流，上传一个 ComfyUI API 格式的 JSON 开始</div>
            <TransitionGroup v-else name="li">
                <button v-for="w in wf.workflows" :key="w.name" type="button" class="wfc" :class="{ on: w.name === wf.selectedName }" :aria-pressed="w.name === wf.selectedName" @click="pick(w)">
                    <span class="ic"><NvIcon :name="w.builtin ? 'box' : 'file'" /></span>
                    <span class="mn"><b>{{ w.title }}</b><span>{{ tf('comfy.fieldCount', { count: w.field_count }, '{count} 个字段') }}</span></span>
                    <span v-if="w.builtin" class="nv-badge">{{ t('comfy.builtin', '内置') }}</span>
                    <span v-if="wf.opening && w.name === wf.selectedName" class="spin s12"></span>
                </button>
            </TransitionGroup>
        </div>
        <button type="button" class="nv-btn sm wide up" :disabled="wf.uploading" @click="fileEl.click()"><span v-if="wf.uploading" class="spin s12"></span><NvIcon v-else name="upload" />{{ t('comfy.uploadWorkflow', '上传工作流') }}</button>
        <input ref="fileEl" type="file" accept="application/json" hidden @change="onFile" />
        <WfDialog :open="!!pending" title="上传工作流" :desc="t('comfy.namePrompt', '给这个工作流起个名字（中文/英文/数字/_-.）：')" input :input-value="pending ? pending.baseName : ''" input-placeholder="工作流名称" confirm-text="上传" :busy="wf.uploading" @confirm="onName" @cancel="pending = null" />
    </section>
</template>

<style scoped>
.grp { display: flex; flex-direction: column; gap: 4px; padding: 14px; border-radius: 14px; background: var(--fill-1); }
.cap { padding-bottom: 4px; font: 400 10.5px/14px var(--font-mono); letter-spacing: .05em; color: var(--ink-3); text-transform: uppercase; }
.list { position: relative; display: flex; flex-direction: column; gap: 2px; }
.sk { height: 46px; border-radius: 10px; }
.empty { padding: 16px 12px; border-radius: 12px; background: var(--solid); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
.wfc { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.wfc:hover { background: var(--fill-1); }
.wfc.on { background: var(--solid); box-shadow: var(--shadow-float); }
.ic { width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); }
.ic .nv-i { width: 13px; height: 13px; }
.mn { flex: 1; min-width: 0; }
.mn b { display: block; font: 500 12.5px/17px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mn span { display: block; font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.wide { width: 100%; }
.up { margin-top: 6px; }
.s12 { width: 12px; height: 12px; flex: none; color: var(--ink-3); }
.li-enter-active, .li-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.li-enter-from, .li-leave-to { opacity: 0; transform: translateY(-4px); }
.li-leave-active { position: absolute; left: 0; right: 0; }
.li-move { transition: transform 200ms var(--ease-out); }
</style>
