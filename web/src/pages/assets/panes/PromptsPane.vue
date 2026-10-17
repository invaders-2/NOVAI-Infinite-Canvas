<script setup>
// 「提示词库」：词库 / 分组树（树内编辑、二次确认删除）+ 提示词列表（搜索、批量管理、框选）+ 右侧预览 / 编辑 / 新增
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import TreeEdit from '../parts/TreeEdit.vue';
import PromptDetail from './PromptDetail.vue';
import { run } from '../lib/state.js';
import { useMarquee } from '../lib/compose.js';
import * as P from '../lib/prompts.js';

const X = P.P;
const lib = computed(() => P.activeLib());
const readonly = computed(() => Boolean(lib.value?.readonly));
const items = computed(() => P.currentItems());
const detail = computed(() => (X.create ? null : P.selectedItem(items.value)));
const emptyText = computed(() => ((lib.value?.items || []).length ? '当前条件下没有提示词。可以切换分类或清空搜索条件。' : `${lib.value?.name || '当前提示词库'} 暂无提示词，点击「新增」添加。`));
const scroller = ref(null);
const marq = useMarquee(scroller, { enabled: () => X.manage, get: () => X.ids, set: s => { X.ids = s; }, end: () => { X.pendingBatch = false; } });
watch(() => X.query, () => { X.sel = ''; });
const libKinds = ['library-rename', 'category-new'];
const catKinds = ['category-new', 'category-rename'];
function save(name, done) { run(P.saveTreeEdit(name)).finally(done); }
const isLibOn = l => l.id === lib.value?.id;
const catOn = id => P.activeCatId() === id && X.focus === 'category';
function rowDown(e, id) {
    if (!X.manage || readonly.value || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    P.toggleSelect(id);
}
function rowClick(id) { if (!X.manage) P.clickRow(id); }
</script>

<template>
    <div class="am-cols">
        <aside class="am-nav">
            <div class="am-ph">
                <TreeEdit v-if="X.treeEdit && X.treeEdit.placement === 'head'" head :value="X.treeEdit.value" :placeholder="X.treeEdit.label" @save="save" @cancel="X.treeEdit = null" />
                <template v-else>
                    <div class="pt"><b>提示词库</b><span>可创建多个词库</span></div>
                    <div class="pa"><button type="button" class="am-ib" title="新建提示词库" @click="P.startTreeEdit('library-new')"><NvIcon name="plus" /></button></div>
                </template>
            </div>
            <template v-for="l in P.libraries()" :key="l.id">
                <button type="button" class="am-tr par" :class="{ 'is-on': isLibOn(l) && X.focus === 'library' }" @click="P.selectLib(l.id)">
                    <NvIcon :name="l.id === 'system' ? 'sparkles' : 'book'" /><b>{{ l.name || '提示词库' }}</b><span class="n">{{ (l.items || []).length }}</span>
                </button>
                <template v-if="isLibOn(l)">
                    <template v-if="X.focus === 'library'">
                        <TreeEdit v-if="X.treeEdit && libKinds.includes(X.treeEdit.kind)" :key="X.treeEdit.kind" :value="X.treeEdit.value" :placeholder="X.treeEdit.label" @save="save" @cancel="X.treeEdit = null" />
                        <div v-else class="am-tacts">
                            <button type="button" @click="P.startTreeEdit('category-new')"><NvIcon name="folderplus" />新分组</button>
                            <button type="button" @click="P.startTreeEdit('library-rename')"><NvIcon name="pencil" />重命名</button>
                            <button v-if="!P.isSystem(l)" type="button" class="dng" :class="{ cf: X.pendingTreeDelete === 'prompt-lib:' + l.id }" @click="run(P.deleteLibrary())">
                                <NvIcon name="trash" />{{ X.pendingTreeDelete === 'prompt-lib:' + l.id ? '确认删除' : '删除库' }}
                            </button>
                        </div>
                    </template>
                    <button type="button" class="am-tr sub" :class="{ 'is-on': catOn('all') }" @click="P.selectCat(l.id, 'all')">
                        <NvIcon name="list" /><b>全部提示词</b><span class="n">{{ P.countFor('all', l) }}</span>
                    </button>
                    <div v-if="catOn('all')" class="am-tacts"><span class="muted"><NvIcon name="key" />请选择具体分组后编辑</span></div>
                    <template v-for="c in P.categoriesFor(l)" :key="c.id">
                        <button type="button" class="am-tr sub" :class="{ 'is-on': catOn(c.id) }" @click="P.selectCat(l.id, c.id)">
                            <NvIcon name="tag" /><b>{{ c.name || P.categoryLabel(c.id) }}</b><span class="n">{{ P.countFor(c.id, l) }}</span>
                        </button>
                        <template v-if="catOn(c.id)">
                            <TreeEdit v-if="X.treeEdit && catKinds.includes(X.treeEdit.kind)" :key="X.treeEdit.kind" :value="X.treeEdit.value" :placeholder="X.treeEdit.label" @save="save" @cancel="X.treeEdit = null" />
                            <div v-else class="am-tacts">
                                <button type="button" @click="P.startTreeEdit('category-rename')"><NvIcon name="pencil" />重命名</button>
                                <button type="button" class="dng" :class="{ cf: X.pendingTreeDelete === 'prompt-cat:' + c.id }" @click="run(P.deleteCategory())">
                                    <NvIcon name="trash" />{{ X.pendingTreeDelete === 'prompt-cat:' + c.id ? '确认删除' : '删除' }}
                                </button>
                            </div>
                        </template>
                    </template>
                    <div class="am-navsep"></div>
                </template>
            </template>
        </aside>

        <section class="am-main" :class="{ 'manage-on': X.manage }">
            <div class="am-ct">
                <div class="ch"><b>{{ lib?.name || '提示词库' }}</b><span>共 {{ items.length }} 条提示词</span></div>
                <label class="nv-field wide"><NvIcon name="search" /><input v-model="X.query" type="search" placeholder="搜索名称、说明或正文" aria-label="搜索提示词"></label>
                <button type="button" class="nv-btn sm primary" :disabled="readonly" @click="P.startCreate()"><NvIcon name="plus" />新增</button>
                <button type="button" class="nv-btn sm" :class="{ primary: X.manage }" @click="P.toggleManage()"><NvIcon name="list" />{{ X.manage ? '完成管理' : '批量管理' }}</button>
            </div>
            <div v-if="X.manage" class="am-mbar">
                <div class="am-mrow">
                    <span class="smy">已选择 {{ X.ids.size }} 条提示词，支持拖拽框选或逐个勾选。</span>
                    <span class="sp"></span>
                    <button type="button" class="nv-btn sm" :disabled="!items.length || readonly" @click="P.selectAll()"><NvIcon name="check" />全选</button>
                    <button type="button" class="nv-btn sm" :disabled="!X.ids.size" @click="P.clearSelection()"><NvIcon name="square" />清空</button>
                    <button type="button" class="nv-btn sm danger" :disabled="readonly || !X.ids.size" @click="run(P.deleteSelected())"><NvIcon name="trash" />{{ X.pendingBatch ? '确认删除' : '删除所选' }}</button>
                </div>
            </div>
            <div ref="scroller" class="am-scroll" @pointerdown="marq.down">
                <div v-if="items.length" class="am-plist">
                    <article v-for="it in items" :key="it.id" class="am-pr" :class="{ on: (X.manage ? X.ids.has(it.id) : detail && detail.id === it.id) }" :data-card-id="it.id"
                             @pointerdown="rowDown($event, it.id)" @click="rowClick(it.id)">
                        <span v-if="X.manage" class="chk" :class="{ on: X.ids.has(it.id), off: readonly }"><NvIcon v-if="X.ids.has(it.id)" name="check" /></span>
                        <div class="bd">
                            <div class="tt"><b>{{ it.name || '提示词' }}</b><span class="am-tag">{{ P.categoryLabel(it.category || 'custom') }}</span></div>
                            <div class="sc">{{ it.scene || '未填写用途说明' }}</div>
                            <div class="tx">{{ it.positive || '' }}</div>
                        </div>
                    </article>
                </div>
                <div v-else class="am-emptybox">{{ emptyText }}</div>
                <div v-if="marq.box.value" class="am-marq" :style="marq.box.value"></div>
            </div>
        </section>
        <PromptDetail :item="detail" :readonly="readonly" />
    </div>
</template>

<style scoped>
.am-ct .nv-field.wide { width: 220px; }
.am-plist { display: flex; flex-direction: column; gap: 6px; }
.am-pr { display: flex; gap: 12px; padding: 12px 14px; border-radius: 14px; background: var(--fill-1); cursor: pointer; transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.am-pr:hover { background: var(--fill-2); }
.am-pr.on { background: var(--solid); box-shadow: var(--shadow-float); }
.manage-on .am-pr { user-select: none; }
.chk { margin-top: 2px; width: 16px; height: 16px; flex: none; border-radius: 5px; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; color: var(--on-accent); }
.chk.on { background: var(--accent); }
.chk.off { opacity: .4; }
.chk .nv-i { width: 11px; height: 11px; }
.bd { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tt { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tt b { font: 500 13px/19px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt .am-tag { height: 20px; padding: 0 6px; background: var(--fill-2); flex: none; cursor: inherit; }
.am-pr.on .tt .am-tag { background: var(--fill-1); }
.sc { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tx { font: 400 11.5px/17px var(--font-mono); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
