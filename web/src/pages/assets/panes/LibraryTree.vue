<script setup>
// 资产库左栏：资产库 → 图片分组 → 智能分类；库 / 分组的操作条（新分组 / 重命名 / 删除，删除需再点一次确认）与树内编辑
import NvIcon from '../../../components/NvIcon.vue';
import TreeEdit from '../parts/TreeEdit.vue';
import SmartClassTree from '../parts/SmartClassTree.vue';
import { run } from '../lib/state.js';
import * as A from '../lib/library.js';

const L = A.L;
const libEditKinds = ['library-rename', 'category-new'];
const catEditKinds = ['category-new', 'category-rename'];
function save(name, done) { run(A.saveTreeEdit(name)).finally(done); }
function isLibOn(lib) { return lib.id === A.libId(); }
function catOn(cat) { return cat.id === A.catId() && L.focus === 'category' && !A.activeClassEntry(); }
</script>

<template>
    <aside class="am-nav">
        <div class="am-ph">
            <TreeEdit v-if="L.treeEdit && L.treeEdit.placement === 'head'" head :value="L.treeEdit.value" :placeholder="L.treeEdit.label" @save="save" @cancel="L.treeEdit = null" />
            <template v-else>
                <div class="pt"><b>资产层级</b><span>先选库，再选分组</span></div>
                <div class="pa"><button type="button" class="am-ib" title="新建资产库" @click="A.startTreeEdit('library-new')"><NvIcon name="plus" /></button></div>
            </template>
        </div>
        <template v-for="lib in A.libraries()" :key="lib.id">
            <button type="button" class="am-tr par" :class="{ 'is-on': isLibOn(lib) && L.focus === 'library' }" @click="A.selectLib(lib.id)">
                <NvIcon name="folder" /><b>{{ lib.name || '资产库' }}</b><span class="n">{{ A.countForLib(lib) }}</span>
            </button>
            <template v-if="isLibOn(lib)">
                <template v-if="L.focus === 'library'">
                    <TreeEdit v-if="L.treeEdit && libEditKinds.includes(L.treeEdit.kind)" :key="L.treeEdit.kind" :value="L.treeEdit.value" :placeholder="L.treeEdit.label" @save="save" @cancel="L.treeEdit = null" />
                    <div v-else class="am-tacts">
                        <button type="button" @click="A.startTreeEdit('category-new')"><NvIcon name="folderplus" />新分组</button>
                        <button type="button" @click="A.startTreeEdit('library-rename')"><NvIcon name="pencil" />重命名</button>
                        <button type="button" class="dng" :class="{ cf: L.pendingTreeDelete === 'asset-lib:' + lib.id }" @click="run(A.deleteLib(lib.id))">
                            <NvIcon name="trash" />{{ L.pendingTreeDelete === 'asset-lib:' + lib.id ? '确认删除' : '删除库' }}
                        </button>
                    </div>
                </template>
                <template v-for="cat in A.imageCats(lib)" :key="cat.id">
                    <button type="button" class="am-tr sub" :class="{ 'is-on': catOn(cat) }" @click="A.selectCat(lib.id, cat.id)">
                        <NvIcon name="image" /><b>{{ cat.name || '分组' }}</b><span class="n">{{ (cat.items || []).length }}</span>
                    </button>
                    <template v-if="catOn(cat)">
                        <TreeEdit v-if="L.treeEdit && catEditKinds.includes(L.treeEdit.kind)" :key="L.treeEdit.kind" :value="L.treeEdit.value" :placeholder="L.treeEdit.label" @save="save" @cancel="L.treeEdit = null" />
                        <div v-else class="am-tacts">
                            <button type="button" @click="A.startTreeEdit('category-new')"><NvIcon name="folderplus" />新分组</button>
                            <button type="button" @click="A.startTreeEdit('category-rename', { catId: cat.id })"><NvIcon name="pencil" />重命名</button>
                            <button type="button" class="dng" :class="{ cf: L.pendingTreeDelete === 'asset-cat:' + cat.id }" @click="run(A.deleteCat())">
                                <NvIcon name="trash" />{{ L.pendingTreeDelete === 'asset-cat:' + cat.id ? '确认删除' : '删除' }}
                            </button>
                        </div>
                    </template>
                </template>
                <div v-if="!A.imageCats(lib).length" class="am-temp">暂无分组</div>
                <SmartClassTree :entries="A.classEntries(lib)" :active-key="L.classFilter" :open-group="L.openGroup"
                                @root="A.classRoot(lib.id)" @group="A.toggleGroup" @filter="k => A.toggleClassFilter(k, lib.id)" />
                <div class="am-navsep"></div>
            </template>
        </template>
    </aside>
</template>
