<script setup>
// 「工作流」：工作流分组树（新建 / 重命名 / 二次确认删除）+ 工作流网格（上传 JSON / ZIP、批量导出 / 删除）+ 详情
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import AssetCard from '../parts/AssetCard.vue';
import UploadCard from '../parts/UploadCard.vue';
import MediaThumb from '../parts/MediaThumb.vue';
import TreeEdit from '../parts/TreeEdit.vue';
import { ask, run } from '../lib/state.js';
import { workflowKindLabel, shortDate, formatDate } from '../lib/util.js';
import * as F from '../lib/workflows.js';

const W = F.W;
const cat = computed(() => F.activeCat());
const items = computed(() => F.currentItems());
const detail = computed(() => F.selectedItem(items.value));
const name = ref('');
watch(() => detail.value && detail.value.id + '|' + detail.value.name, () => { name.value = detail.value?.name || 'workflow'; }, { immediate: true });
watch(() => W.query, () => { W.sel = ''; });
const isOn = c => cat.value && c.id === cat.value.id && c.__libraryId === cat.value.__libraryId;
function save(n, done) { run(F.saveTreeEdit(n)).finally(done); }
function upload(files) { run(F.upload(files), '上传失败'); }
async function rename(id) {
    const it = F.findWorkflow(id);
    const n = await ask({ title: '重命名工作流', input: true, value: it?.name || '', placeholder: '工作流名称', ok: '保存' });
    if (n != null && String(n).trim()) run(F.rename(id, n));
}
</script>

<template>
    <div class="am-cols">
        <aside class="am-nav">
            <div class="am-ph">
                <TreeEdit v-if="W.treeEdit && W.treeEdit.placement === 'head'" head :value="W.treeEdit.value" :placeholder="W.treeEdit.label" @save="save" @cancel="W.treeEdit = null" />
                <template v-else>
                    <div class="pt"><b>工作流层级</b><span>独立管理工作流分组</span></div>
                    <div class="pa"><button type="button" class="am-ib" title="新建工作流分组" @click="F.startTreeEdit('category-new')"><NvIcon name="folderplus" /></button></div>
                </template>
            </div>
            <div class="am-tr par static"><NvIcon name="folder" /><b>工作流库</b><span class="n">{{ F.total() }}</span></div>
            <template v-for="c in F.categories()" :key="c.__libraryId + ':' + c.id">
                <button type="button" class="am-tr sub" :class="{ 'is-on': isOn(c) }" @click="F.selectCat(c.__libraryId, c.id)">
                    <NvIcon name="workflow" /><b>{{ c.name || '工作流' }}</b><span class="n">{{ (c.items || []).length }}</span>
                </button>
                <template v-if="isOn(c)">
                    <TreeEdit v-if="W.treeEdit && W.treeEdit.kind === 'category-rename'" :value="W.treeEdit.value" :placeholder="W.treeEdit.label" @save="save" @cancel="W.treeEdit = null" />
                    <div v-else class="am-tacts">
                        <button type="button" @click="F.startTreeEdit('category-rename')"><NvIcon name="pencil" />重命名</button>
                        <button type="button" class="dng" :class="{ cf: W.pendingTreeDelete === `workflow-cat:${c.__libraryId}:${c.id}` }" @click="run(F.deleteCategory())">
                            <NvIcon name="trash" />{{ W.pendingTreeDelete === `workflow-cat:${c.__libraryId}:${c.id}` ? '确认删除' : '删除' }}
                        </button>
                    </div>
                </template>
            </template>
            <div v-if="!F.categories().length" class="am-temp">暂无工作流分组</div>
        </aside>

        <section class="am-main" :class="{ 'manage-on': W.manage }">
            <div class="am-ct">
                <div class="ch"><b>{{ cat?.name || '工作流管理' }}</b><span>工作流库 / {{ items.length }} 个工作流</span></div>
                <label class="nv-field"><NvIcon name="search" /><input v-model="W.query" type="search" placeholder="搜索工作流" aria-label="搜索工作流"></label>
                <button type="button" class="nv-btn sm" :class="{ primary: W.manage }" @click="F.toggleManage()"><NvIcon name="list" />{{ W.manage ? '完成管理' : '批量管理' }}</button>
            </div>
            <div v-if="W.manage" class="am-mbar">
                <div class="am-mrow">
                    <span class="smy">已选择 {{ W.ids.size }} 个工作流。</span>
                    <span class="sp"></span>
                    <button type="button" class="nv-btn sm" :disabled="!items.length" @click="F.selectAll()"><NvIcon name="check" />全选</button>
                    <button type="button" class="nv-btn sm" :disabled="!W.ids.size" @click="W.ids.clear(); W.pendingBatch = false"><NvIcon name="square" />清空</button>
                    <button type="button" class="nv-btn sm" :disabled="!W.ids.size" @click="run(F.exportItems([...W.ids]), '导出工作流失败')"><NvIcon name="download" />导出所选</button>
                    <button type="button" class="nv-btn sm danger" :disabled="!W.ids.size" @click="run(F.deleteSelected())"><NvIcon name="trash" />{{ W.pendingBatch ? '确认删除' : '删除所选' }}</button>
                </div>
            </div>
            <div class="am-scroll">
                <div class="am-grid">
                    <UploadCard title="上传工作流" sub="支持 JSON / ZIP" accept=".json,.zip,application/json,application/zip,application/x-zip-compressed" :disabled="!cat" @files="upload" />
                    <AssetCard v-for="it in items" :key="it.id" :card-id="it.id" kind="workflow" :name="it.name || 'workflow'" :meta="workflowKindLabel(it) + ' · ' + shortDate(it.created_at)"
                               :active="detail && detail.id === it.id" :checked="W.ids.has(it.id)" :manage="W.manage" @select="F.clickCard" @toggle="F.toggleSelect" />
                    <div v-if="!items.length" class="am-emptybox">当前分组还没有工作流，可以上传 JSON / ZIP，或从传统画布导出到资产库。</div>
                </div>
            </div>
        </section>

        <aside class="am-det">
            <template v-if="!detail">
                <div class="am-ph"><div class="pt"><b>工作流详情</b><span>选择一个工作流查看详情</span></div></div>
                <div class="am-dsc"><div class="am-empty"><NvIcon name="workflow" /><span>暂无工作流</span></div></div>
            </template>
            <template v-else>
                <div class="am-ph">
                    <div class="pt"><b>工作流详情</b><span>{{ workflowKindLabel(detail) }}</span></div>
                    <div class="pa">
                        <button type="button" class="am-ib" title="导出工作流" @click="run(F.exportItems([detail.id]))"><NvIcon name="download" /></button>
                        <button type="button" class="am-ib" title="重命名" @click="rename(detail.id)"><NvIcon name="pencil" /></button>
                        <button type="button" class="am-ib dng" :class="{ cf: W.pendingDelete === detail.id }" :title="W.pendingDelete === detail.id ? '再次点击确认删除' : '删除'" @click="run(F.deleteOne(detail.id))"><NvIcon name="trash" /></button>
                    </div>
                </div>
                <div class="am-dsc">
                    <div class="am-dm static"><MediaThumb kind="workflow" plain /></div>
                    <input v-model="name" class="am-dn" type="text" title="直接修改名称" aria-label="工作流名称" @change="run(F.saveInlineName(detail.id, name), '保存失败')" @keydown.enter.prevent="$event.target.blur()">
                    <div class="am-kv">
                        <div><span>类型</span><b>{{ workflowKindLabel(detail) }}</b></div>
                        <div><span>创建时间</span><b>{{ formatDate(detail.created_at) }}</b></div>
                        <div><span>位置</span><b>工作流库</b></div>
                        <div><span>分组</span><b>{{ cat?.name || '工作流' }}</b></div>
                    </div>
                    <div class="am-url">{{ detail.url }}</div>
                </div>
            </template>
        </aside>
    </div>
</template>

<style scoped>
.am-tr.static { cursor: default; }
.am-tr.static:hover { background: transparent; }
</style>
