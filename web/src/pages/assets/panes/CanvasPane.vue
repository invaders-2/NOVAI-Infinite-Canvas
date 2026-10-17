<script setup>
// 「素材 / 画布里的」：画布分类树 → 各画布；时间 / 模型筛选、排序（画布名称时按画布分组）、批量下载、框选
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import AssetCard from '../parts/AssetCard.vue';
import MenuSelect from '../parts/MenuSelect.vue';
import ProgressiveMore from '../parts/ProgressiveMore.vue';
import KindBar from '../parts/KindBar.vue';
import CanvasDetail from './CanvasDetail.vue';
import { S, run } from '../lib/state.js';
import { assetKind, assetKindName, canvasAssetKindLabel } from '../lib/util.js';
import { useProgressive, useMarquee } from '../lib/compose.js';
import * as K from '../lib/canvas.js';

const C = K.C;
const items = computed(() => K.currentItems());
const groups = computed(() => K.groupItems(items.value));
const flat = computed(() => groups.value.length === 1 && !groups.value[0].title);
const total = computed(() => K.uniqueItems().length);
const detail = computed(() => K.selectedItem(items.value));
const models = computed(() => K.modelOptions());
const modelOpts = computed(() => [{ value: '', label: '全部模型' }, ...models.value.map(([m, n]) => ({ value: m, label: `${m}（${n}）` })), { value: '__none__', label: '非生成素材（上传 / 导入）', sep: true }]);
const key = () => [K.activeCat().id, C.canvasId, C.query, C.sort, C.model, C.date, S.kind].join('|');
const ktabs = computed(() => K.kindTabs());
const emptyText = computed(() => {
    if (S.kind) {
        const name = assetKindName(S.kind);
        if (C.query.trim()) return `没有找到匹配的${name}素材，可以换个关键词或切回「全部」。`;
        if (C.model || C.date) return `当前筛选下没有${name}素材，可以换时间范围或模型，或点「清除筛选」。`;
        return `当前画布分类下没有${name}素材。`;
    }
    return C.model || C.date ? '没有符合筛选条件的素材，可以换个时间范围或模型，或点「清除筛选」。' : '当前分类没有可下载的画布资产。可以点击“刷新资源”，或在画布中生成/导入图片、视频、音频后再查看。';
});
const progFlat = useProgressive(() => (flat.value ? items.value : []), key, () => C.sel);
const progGroups = useProgressive(() => (flat.value ? [] : groups.value), key, () => '', g => (g.items || []).length || 1);
const scroller = ref(null);
const marq = useMarquee(scroller, { enabled: () => C.manage, get: () => C.ids, set: s => { C.ids = s; } });
watch(() => C.query, () => { C.sel = ''; });
const modelValue = computed(() => (C.model && C.model !== '__none__' && !models.value.some(([m]) => m === C.model) ? '' : C.model));
</script>

<template>
    <div class="am-cols">
        <aside class="am-nav">
            <div class="am-ph"><div class="pt"><b>画布分类</b><span>从所有画布拉取资产</span></div></div>
            <template v-for="cat in K.categories()" :key="cat.id">
                <button type="button" class="am-tr par" :class="{ 'is-on': cat.id === K.activeCat().id && !K.activeCanvas() }" @click="K.selectCat(cat.id)">
                    <NvIcon :name="cat.id === 'smart' ? 'sparkles' : 'grid9'" /><b>{{ cat.name || '画布' }}</b><span class="n">{{ Number(cat.count || 0) }}</span>
                </button>
                <template v-if="cat.id === K.activeCat().id">
                    <button v-for="cv in K.canvasesFor(cat.id)" :key="cv.id" type="button" class="am-tr sub" :class="{ 'is-on': cv.id === C.canvasId }" :title="cv.title || '未命名画布'" @click="K.selectCanvas(cat.id, cv.id)">
                        <NvIcon :name="cv.kind === 'smart' ? 'sparkles' : 'image'" /><b>{{ cv.title || '未命名画布' }}</b><span class="n">{{ K.countForCanvas(cv.id) }}</span>
                    </button>
                    <div v-if="!K.canvasesFor(cat.id).length" class="am-temp">暂无画布</div>
                </template>
            </template>
            <div class="am-hint">共 {{ (S.canvasData.canvases || []).length }} 个画布，{{ total }} 个可下载资产。</div>
        </aside>

        <section class="am-main" :class="{ 'manage-on': C.manage }">
            <div class="am-ct">
                <div class="ch"><b>{{ K.viewTitle() }}</b><span>{{ K.viewSubtitle(items.length) }}</span></div>
                <button type="button" class="nv-btn sm" title="重新读取画布中的图片、视频、音频资源" @click="run(K.refresh())"><NvIcon name="refresh" />刷新资源</button>
                <label class="nv-field"><NvIcon name="search" /><input v-model="C.query" type="search" placeholder="搜索画布资产" aria-label="搜索画布资产"></label>
                <MenuSelect v-model="C.sort" :options="K.SORTS" title="排序方法" @update:model-value="C.sel = ''" />
                <button type="button" class="nv-btn sm" :class="{ primary: C.manage }" :disabled="!total" @click="K.toggleManage()"><NvIcon name="list" />{{ C.manage ? '完成管理' : '批量管理' }}</button>
            </div>
            <KindBar v-model="S.kind" :tabs="ktabs" />
            <div class="am-fbar">
                <div class="nv-seg static" role="group" aria-label="按时间筛选">
                    <button v-for="d in K.DATES" :key="d[0]" type="button" :class="{ 'is-on': C.date === d[0] }" @click="K.setFilter('date', d[0])">{{ d[1] }}</button>
                </div>
                <MenuSelect v-if="models.length" :model-value="modelValue" :options="modelOpts" title="按生成模型筛选" @update:model-value="v => K.setFilter('model', v)" />
                <button v-if="C.model || C.date" type="button" class="clr" @click="K.clearFilters()">清除筛选</button>
            </div>
            <div v-if="C.manage" class="am-mbar">
                <div class="am-mrow">
                    <span class="smy">已选择 {{ C.ids.size }} 个画布资产，支持拖拽框选或逐个勾选。</span>
                    <span class="sp"></span>
                    <button type="button" class="nv-btn sm" :disabled="!items.length" @click="K.selectAll()"><NvIcon name="check" />全选</button>
                    <button type="button" class="nv-btn sm" :disabled="!C.ids.size" @click="C.ids.clear()"><NvIcon name="square" />清空</button>
                    <button type="button" class="nv-btn sm primary" :disabled="!C.ids.size" @click="run(K.download([...C.ids]), '下载画布资产失败')"><NvIcon name="download" />下载所选</button>
                </div>
            </div>

            <div ref="scroller" class="am-scroll" @pointerdown="marq.down">
                <div v-if="flat" class="am-grid">
                    <AssetCard v-for="it in progFlat.visible.value" :key="it.id" :card-id="it.id" :url="it.url" :kind="assetKind(it)" :name="it.name || 'canvas asset'" badge
                               :meta="canvasAssetKindLabel(it) + ' · ' + (it.canvas_title || '未命名画布')" :active="detail && detail.id === it.id" :checked="C.ids.has(it.id)" :manage="C.manage"
                               @select="K.clickCard" @toggle="K.toggleSelect" />
                    <ProgressiveMore v-if="progFlat.rest.value" :key="progFlat.shown.value" :rest="progFlat.rest.value" @more="progFlat.more" />
                </div>
                <div v-else class="am-groups">
                    <section v-for="g in progGroups.visible.value" :key="g.key" class="am-grp">
                        <div class="am-gh"><b :title="g.title">{{ g.title }}</b><span>{{ g.subtitle }}</span><small>{{ g.items.length }} 个资产</small></div>
                        <div class="am-grid">
                            <AssetCard v-for="it in g.items" :key="it.id" :card-id="it.id" :url="it.url" :kind="assetKind(it)" :name="it.name || 'canvas asset'" badge
                                       :meta="canvasAssetKindLabel(it) + ' · ' + (it.canvas_title || '未命名画布')" :active="detail && detail.id === it.id" :checked="C.ids.has(it.id)" :manage="C.manage"
                                       @select="K.clickCard" @toggle="K.toggleSelect" />
                        </div>
                    </section>
                    <ProgressiveMore v-if="progGroups.rest.value" :key="progGroups.shown.value" :rest="progGroups.rest.value" @more="progGroups.more" />
                </div>
                <div v-if="!items.length" class="am-emptybox">{{ emptyText }}</div>
                <div v-if="marq.box.value" class="am-marq" :style="marq.box.value"></div>
            </div>
        </section>
        <CanvasDetail :item="detail" />
    </div>
</template>

<style scoped>
.am-groups { display: flex; flex-direction: column; gap: 26px; }
.am-ct :deep(.am-sel) { height: 30px; flex: none; }
</style>
