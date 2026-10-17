<script setup>
// 「素材 / 本地上传」：文件夹树 + 智能分类；上传（按钮 / 拖入）、管理条（下载 / 复制到画布 / 剪切移动 / 删除）、
// AI 处理（平台、模型、反推要求、智能分类、提示词反推、分类追加要求）、卡片名点击即改名、框选
import { ref, computed, watch, nextTick } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import AssetCard from '../parts/AssetCard.vue';
import UploadCard from '../parts/UploadCard.vue';
import MenuSelect from '../parts/MenuSelect.vue';
import ProgressiveMore from '../parts/ProgressiveMore.vue';
import SmartClassTree from '../parts/SmartClassTree.vue';
import KindBar from '../parts/KindBar.vue';
import LocalDetail from './LocalDetail.vue';
import { S, ask, run, captionProviders, captionModels, setCaptionProvider, setCaptionModel, writeCaptionSettings } from '../lib/state.js';
import { assetKind, assetKindLabel, assetKindName, formatFileSize } from '../lib/util.js';
import { useProgressive, useMarquee } from '../lib/compose.js';
import * as U from '../lib/local.js';

const X = U.U;
const list = computed(() => U.items());
const detail = computed(() => U.detailItem(list.value));
const total = computed(() => (S.localAssets || []).length);
const imageCount = computed(() => U.selectedImages().length);
const providerOpts = computed(() => captionProviders().map(p => ({ value: p.id, label: p.name || p.id })));
const modelOpts = computed(() => captionModels().map(m => ({ value: m, label: m })));
const aiBusy = computed(() => X.captionBusy || X.classifyBusy);
const aiOff = computed(() => !imageCount.value || !providerOpts.value.length || !S.caption.model || aiBusy.value);
const folders = computed(() => {
    const out = [];
    const walk = (node, depth) => { if (!node) return; out.push({ node, depth }); (node.children || []).forEach(c => walk(c, depth + 1)); };
    walk(S.localTree || { path: '', name: '全部上传', count: total.value, children: [] }, 0);
    return out;
});
const ktabs = computed(() => U.kindTabs());
const emptyText = computed(() => {
    const name = assetKindName(S.kind);
    if (X.query.trim()) return `没有找到匹配的${name}素材，可以换个关键词或切回「全部」。`;
    return `当前文件夹下没有${name}素材，可以切回「全部」查看。`;
});
const prog = useProgressive(() => list.value, () => [X.folder, X.classFilter, X.query, S.kind].join('|'), () => X.sel);
const scroller = ref(null);
const uploader = ref(null);
const marq = useMarquee(scroller, { enabled: () => X.manage, get: () => X.ids, set: s => { X.ids = s; }, end: () => { X.pendingBatch = false; } });
watch(() => X.query, () => { X.sel = ''; });

const renameText = ref('');
const renameEl = ref(null);
function startRename(id) {
    const it = U.findUpload(id);
    if (!it) return;
    X.renaming = id;
    renameText.value = it.name || '本地素材';
    nextTick(() => { const el = Array.isArray(renameEl.value) ? renameEl.value[0] : renameEl.value; if (el) { el.focus(); el.select(); } });
}
function finishRename(save) {
    const id = X.renaming;
    if (!id) return;
    X.renaming = '';
    if (save) run(U.saveName(id, renameText.value.trim()));
}
async function newFolder() {
    const name = await ask({ title: '新建文件夹', input: true, value: '新文件夹', placeholder: '文件夹名称', ok: '新建' });
    if (name != null) run(U.createFolder(name));
}
async function renameFolder() {
    if (!X.folder) return;
    const name = await ask({ title: '重命名文件夹', input: true, value: U.folderTitle(), placeholder: '文件夹名称', ok: '保存' });
    if (name != null) run(U.renameFolder(name));
}
</script>

<template>
    <div class="am-cols">
        <aside class="am-nav">
            <div class="am-ph">
                <div class="pt"><b>本地上传</b><span>批量上传到 assets/uploads</span></div>
                <div class="pa">
                    <button type="button" class="am-ib" title="新建文件夹" @click="newFolder"><NvIcon name="folderplus" /></button>
                    <button type="button" class="am-ib" title="重命名文件夹" :disabled="!X.folder" @click="renameFolder"><NvIcon name="pencil" /></button>
                </div>
            </div>
            <button v-for="f in folders" :key="f.node.path || '__root__'" type="button" class="am-tr" :class="[f.depth ? 'sub' : 'par', { 'is-on': !U.activeClassEntry() && (f.node.path || '') === X.folder }]"
                    :style="f.depth > 1 ? { paddingLeft: 30 + (f.depth - 1) * 20 + 'px' } : null" @click="U.selectFolder(f.node.path || '')">
                <NvIcon :name="f.depth ? 'folder' : 'cloud'" /><b>{{ f.node.name || '文件夹' }}</b><span class="n">{{ Number(f.node.count || 0) }}</span>
            </button>
            <SmartClassTree :entries="U.classEntries()" :active-key="X.classFilter" :open-group="X.openGroup" @root="U.classRoot()" @group="U.toggleGroup" @filter="U.toggleClassFilter" />
            <div class="am-hint">选择图片/视频/音频文件即可上传，文件保存在项目 assets/uploads 目录。</div>
        </aside>

        <section class="am-main" :class="{ 'manage-on': X.manage }">
            <div class="am-ct">
                <div class="ch"><b>{{ U.folderTitle() }}</b><span>{{ U.viewSubtitle(list.length) }}</span></div>
                <label class="nv-field"><NvIcon name="search" /><input v-model="X.query" type="search" placeholder="搜索本地上传" aria-label="搜索本地上传"></label>
                <button type="button" class="nv-btn sm primary" @click="uploader && uploader.pick()"><NvIcon name="upload" />上传文件</button>
                <button type="button" class="nv-btn sm" :class="{ primary: X.manage }" :disabled="!total" @click="U.toggleManage()"><NvIcon name="list" />{{ X.manage ? '完成管理' : '批量管理' }}</button>
            </div>

            <KindBar v-model="S.kind" :tabs="ktabs" />

            <div v-if="X.manage" class="am-mbar">
                <div class="am-mrow">
                    <span class="gt">管理</span>
                    <span class="smy">已选 {{ X.ids.size }} 个，其中 {{ imageCount }} 张图片</span>
                    <button type="button" class="nv-btn sm" :disabled="!list.length" @click="U.selectAll()"><NvIcon name="check" />全选</button>
                    <button type="button" class="nv-btn sm" :disabled="!X.ids.size" @click="U.clearSelection()"><NvIcon name="square" />清空</button>
                    <button type="button" class="nv-btn sm" :disabled="!X.ids.size" @click="U.downloadSelected()"><NvIcon name="download" />下载</button>
                    <button type="button" class="nv-btn sm" :disabled="!X.ids.size" @click="U.copyToCanvas()"><NvIcon name="clip" />复制到画布</button>
                    <button type="button" class="nv-btn sm" :disabled="!X.ids.size" @click="U.cutSelected()"><NvIcon name="scissors" />剪切/移动</button>
                    <button type="button" class="nv-btn sm danger" :disabled="!X.ids.size" @click="U.remove([...X.ids], 'batch')"><NvIcon name="trash" />{{ X.pendingBatch ? '确认删除' : '删除' }}</button>
                </div>
                <div class="am-mrow">
                    <span class="gt">AI 处理</span>
                    <MenuSelect :model-value="S.caption.provider" :options="providerOpts" placeholder="暂无聊天平台" :disabled="!providerOpts.length" variant="solid" title="平台" @update:model-value="setCaptionProvider" />
                    <MenuSelect :model-value="S.caption.model" :options="modelOpts" placeholder="暂无模型" :disabled="!modelOpts.length" variant="solid" title="模型" @update:model-value="setCaptionModel" />
                    <input v-model="S.caption.prompt" class="am-inp prompt" type="text" placeholder="描述图片" title="反推要求" @input="writeCaptionSettings">
                    <button type="button" class="nv-btn sm" :disabled="aiOff" @click="U.classifySelected()"><span v-if="X.classifyBusy" class="am-spin"></span><NvIcon v-else name="tag" />{{ X.classifyBusy ? '分类中' : '智能分类' }}</button>
                    <button type="button" class="nv-btn sm primary" :disabled="aiOff" @click="U.captionSelected()"><span v-if="X.captionBusy" class="am-spin"></span><NvIcon v-else name="wand2" />{{ X.captionBusy ? '反推中' : '提示词反推' }}</button>
                    <button type="button" class="am-ib" :class="{ pri: X.classifyPromptOpen }" title="智能分类要求" @click="X.classifyPromptOpen = !X.classifyPromptOpen"><NvIcon :name="X.classifyPromptOpen ? 'chevu' : 'settings'" /></button>
                </div>
                <textarea v-if="X.classifyPromptOpen" v-model="S.caption.classifyPrompt" class="am-txa" placeholder="默认已内置室内/室外、空间、主体、光影、模特、风格、色彩等分类。这里可以追加你的分类要求，例如：增加家装风格、镜头焦段、商业用途、人物年龄段、产品材质。" @input="writeCaptionSettings"></textarea>
            </div>

            <div v-if="X.clipboard && X.clipboard.ids.length" class="am-clip">
                <NvIcon name="clip" /><span>已剪切 {{ X.clipboard.ids.length }} 个素材</span>
                <button type="button" class="b" :disabled="U.clipboardSameFolder()" @click="U.pasteClipboard()">
                    <NvIcon name="clip2" />{{ U.clipboardSameFolder() ? '切到其他文件夹后移动' : `移动到「${X.folder ? U.folderTitle() : '根目录'}」` }}
                </button>
                <button type="button" class="x" title="取消剪切" @click="X.clipboard = null"><NvIcon name="x" /></button>
            </div>

            <div ref="scroller" class="am-scroll" @pointerdown="marq.down">
                <div class="am-grid">
                    <UploadCard ref="uploader" title="上传本地素材" sub="松开即可上传" accept="image/*,video/*,audio/*" @files="U.upload" />
                    <AssetCard v-for="it in prog.visible.value" :key="it.id" :card-id="it.id" :url="it.url" :kind="assetKind(it)" :name="it.name || '本地素材'" renamable
                               :meta="assetKindLabel(it) + ' · ' + formatFileSize(it.size) + (assetKind(it) === 'image' && String(it.caption || '').trim() ? ' · 有提示词' : '')"
                               :active="detail && detail.id === it.id" :checked="X.ids.has(it.id)" :manage="X.manage"
                               @select="U.clickCard" @toggle="U.toggleSelect" @rename="startRename">
                        <template v-if="X.renaming === it.id" #name>
                            <input ref="renameEl" v-model="renameText" class="ren" type="text" aria-label="素材名称" @click.stop @pointerdown.stop
                                   @keydown.enter.prevent="finishRename(true)" @keydown.esc.prevent.stop="finishRename(false)" @blur="finishRename(true)">
                        </template>
                    </AssetCard>
                    <div v-if="S.kind && !list.length" class="am-emptybox">{{ emptyText }}</div>
                    <ProgressiveMore v-if="prog.rest.value" :key="prog.shown.value" :rest="prog.rest.value" @more="prog.more" />
                </div>
                <div v-if="marq.box.value" class="am-marq" :style="marq.box.value"></div>
            </div>
        </section>
        <LocalDetail :item="detail" @rename="startRename" />
    </div>
</template>

<style scoped>
.prompt { width: 140px; }
.am-mbar .am-txa { min-height: 56px; }
.am-ct :deep(.am-sel) { height: 30px; }
</style>
