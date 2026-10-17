<script setup>
// 「素材 / 资产库」：左树 + 中间网格（上传卡、管理条、剪贴板条、分批渲染、框选）+ 右侧详情
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import AssetCard from '../parts/AssetCard.vue';
import UploadCard from '../parts/UploadCard.vue';
import MenuSelect from '../parts/MenuSelect.vue';
import ProgressiveMore from '../parts/ProgressiveMore.vue';
import KindBar from '../parts/KindBar.vue';
import LibraryTree from './LibraryTree.vue';
import AssetDetail from './AssetDetail.vue';
import { S, run } from '../lib/state.js';
import { assetKind, assetKindLabel, assetKindName, shortDate } from '../lib/util.js';
import { useProgressive, useMarquee } from '../lib/compose.js';
import * as A from '../lib/library.js';

const L = A.L;
const items = computed(() => A.currentItems());
const detail = computed(() => A.selectedItem(items.value));
const imageCount = computed(() => A.selectedImages().length);
const targets = computed(() => A.moveTargets());
const filtering = computed(() => !!A.activeClassEntry());
const ktabs = computed(() => A.kindTabs());
const emptyText = computed(() => {
    if (!S.kind) return '当前分组还没有素材，可以上传，或从智能画布输出保存到素材库。';
    const name = assetKindName(S.kind);
    if (L.query.trim()) return `没有找到匹配的${name}素材，可以换个关键词或切回「全部」。`;
    if (filtering.value) return `当前分类下没有${name}素材，可以切回「全部」查看。`;
    return `当前分组还没有${name}素材。`;
});
const prog = useProgressive(() => items.value, () => [A.libId(), A.catId(), L.classFilter, L.query, S.kind].join('|'), () => L.sel);
const scroller = ref(null);
const marq = useMarquee(scroller, { enabled: () => L.manage, get: () => L.ids, set: s => { L.ids = s; }, end: () => { L.pendingBatch = false; } });
watch(() => L.query, () => { L.sel = ''; });

function upload(files) { run(A.uploadFiles(files), '上传失败'); }
function move(target) { if (target) run(A.moveSelected(target)); }
</script>

<template>
    <div class="am-cols">
        <LibraryTree />
        <section class="am-main" :class="{ 'manage-on': L.manage }">
            <div class="am-ct">
                <div class="ch"><b>{{ A.viewTitle() }}</b><span>{{ A.viewSubtitle(items.length) }}</span></div>
                <label class="nv-field"><NvIcon name="search" /><input v-model="L.query" type="search" placeholder="搜索素材" aria-label="搜索素材"></label>
                <button type="button" class="nv-btn sm" :class="{ primary: L.manage }" @click="A.toggleManage()"><NvIcon name="list" />{{ L.manage ? '完成管理' : '批量管理' }}</button>
            </div>

            <KindBar v-model="S.kind" :tabs="ktabs" />

            <div v-if="L.manage" class="am-mbar">
                <div class="am-mrow">
                    <span class="gt">管理</span>
                    <button type="button" class="nv-btn sm" :disabled="!items.length" @click="A.selectAll()"><NvIcon name="check" />全选</button>
                    <button type="button" class="nv-btn sm" :disabled="!L.ids.size" @click="A.clearSelection()"><NvIcon name="square" />清空</button>
                    <button type="button" class="nv-btn sm" :disabled="!L.ids.size" @click="A.setClipboard('cut')"><NvIcon name="scissors" />剪切</button>
                    <button type="button" class="nv-btn sm" :disabled="!L.ids.size" @click="A.setClipboard('copy')"><NvIcon name="copy" />复制</button>
                    <MenuSelect model-value="" :options="targets" placeholder="移动到…" :disabled="!L.ids.size || !targets.length" variant="solid" title="把所选素材移动到其他分组" @update:model-value="move" />
                    <button type="button" class="nv-btn sm" :disabled="!L.ids.size" @click="A.downloadSelected()"><NvIcon name="download" />下载所选</button>
                    <button type="button" class="nv-btn sm" :disabled="!L.ids.size" @click="A.copyToCanvas()"><NvIcon name="clip" />复制到画布</button>
                    <button type="button" class="nv-btn sm danger" :disabled="!L.ids.size" @click="run(A.deleteSelected())"><NvIcon name="trash" />{{ L.pendingBatch ? '确认删除' : '删除所选' }}</button>
                </div>
                <div class="am-mrow">
                    <span class="gt">AI 处理</span>
                    <button type="button" class="nv-btn sm" :disabled="!imageCount || L.classifyBusy" @click="run(A.classifySelected())">
                        <span v-if="L.classifyBusy" class="am-spin"></span><NvIcon v-else name="tag" />{{ L.classifyBusy ? '分类中' : '智能分类' }}
                    </button>
                    <span class="sp"></span>
                    <span class="smy">已选 {{ L.ids.size }} 个，其中 {{ imageCount }} 张图片</span>
                </div>
            </div>

            <div v-if="L.clipboard && L.clipboard.ids.length" class="am-clip">
                <NvIcon name="clip" /><span>{{ L.clipboard.mode === 'cut' ? '剪切' : '复制' }}了 {{ L.clipboard.ids.length }} 个素材</span>
                <button type="button" class="b" :disabled="A.clipboardSameTarget() && L.clipboard.mode === 'cut'" @click="run(A.pasteClipboard())">
                    <NvIcon name="clip2" />{{ A.clipboardSameTarget() && L.clipboard.mode === 'cut' ? '选择其他分组后粘贴' : '粘贴到当前分组' }}
                </button>
                <button type="button" class="x" title="清空剪贴板" @click="L.clipboard = null"><NvIcon name="x" /></button>
            </div>

            <div ref="scroller" class="am-scroll" @pointerdown="marq.down">
                <div class="am-grid">
                    <UploadCard v-if="!filtering" title="上传到当前分组" sub="图片 / 视频 / 音频" accept="image/*,video/*,audio/*" :disabled="!A.activeCat()" @files="upload" />
                    <AssetCard v-for="it in prog.visible.value" :key="it.id" :card-id="it.id" :url="it.url" :kind="assetKind(it)" :name="it.name || 'asset'"
                               :meta="assetKindLabel(it) + ' · ' + shortDate(it.created_at)" :active="detail && detail.id === it.id" :checked="L.ids.has(it.id)" :manage="L.manage"
                               @select="A.clickCard" @toggle="A.toggleSelect" />
                    <ProgressiveMore v-if="prog.rest.value" :key="prog.shown.value" :rest="prog.rest.value" @more="prog.more" />
                    <div v-if="!items.length" class="am-emptybox">{{ emptyText }}</div>
                </div>
                <div v-if="marq.box.value" class="am-marq" :style="marq.box.value"></div>
            </div>
        </section>
        <AssetDetail :item="detail" />
    </div>
</template>
