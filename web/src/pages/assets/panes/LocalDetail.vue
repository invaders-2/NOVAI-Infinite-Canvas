<script setup>
// 本地上传详情：重命名 / 下载 / 新窗口打开 / 复制链接 / 删除；行内改名；生成信息；智能分类（点标签筛选）；
// 反推提示词（单张反推、复制、编辑后保存）
import { ref, watch, computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import MediaThumb from '../parts/MediaThumb.vue';
import GenInfo from '../parts/GenInfo.vue';
import { setStatus, run } from '../lib/state.js';
import { assetKind, assetKindLabel, formatDate, formatFileSize, copyText } from '../lib/util.js';
import { classChips } from '../lib/classify.js';
import * as U from '../lib/local.js';

const props = defineProps({ item: { type: Object, default: null } });
const emit = defineEmits(['rename']);
const X = U.U;
const name = ref('');
const caption = ref('');
const saving = ref(false);
watch(() => props.item && props.item.id + '|' + props.item.name, () => { name.value = props.item?.name || '本地素材'; }, { immediate: true });
watch(() => props.item && props.item.id + '|' + (props.item.caption || ''), () => { caption.value = props.item?.caption || ''; }, { immediate: true });
const kind = computed(() => assetKind(props.item));
const isImage = computed(() => kind.value === 'image');
const gen = computed(() => props.item?.generation || null);
const chips = computed(() => classChips(props.item, 28));
const delKey = computed(() => 'one:' + (props.item?.id || ''));
function inlineSave() { if (props.item) run(U.saveName(props.item.id, name.value)); }
function openNew() { if (props.item?.url) window.open(props.item.url, '_blank'); }
async function copyLink() { setStatus((await copyText(props.item?.url || '')) ? '已复制链接' : '复制失败'); }
async function copyCaption() {
    if (!String(caption.value || '').trim()) { setStatus('当前图片暂无可复制的提示词'); return; }
    setStatus((await copyText(caption.value)) ? '已复制提示词' : '复制失败，请手动复制');
}
async function saveCaption() {
    saving.value = true;
    try { await U.saveCaption(props.item.id, caption.value); } finally { saving.value = false; }
}
</script>

<template>
    <aside class="am-det">
        <template v-if="!item">
            <div class="am-ph"><div class="pt"><b>素材预览</b><span>选择一个素材查看详情</span></div></div>
            <div class="am-dsc"><div class="am-empty"><NvIcon name="image" /><span>暂无可预览素材</span></div></div>
        </template>
        <template v-else>
            <div class="am-ph">
                <div class="pt"><b>素材预览</b><span>{{ assetKindLabel(item) }}</span></div>
                <div class="pa">
                    <button type="button" class="am-ib" title="重命名" @click="emit('rename', item.id)"><NvIcon name="pencil" /></button>
                    <button type="button" class="am-ib" title="下载" @click="U.downloadOne(item.id)"><NvIcon name="download" /></button>
                    <button type="button" class="am-ib" title="新窗口打开" @click="openNew"><NvIcon name="ext" /></button>
                    <button type="button" class="am-ib" title="复制链接" @click="copyLink"><NvIcon name="link" /></button>
                    <button type="button" class="am-ib dng" :class="{ cf: X.pendingDelete === delKey }" :title="X.pendingDelete === delKey ? '再次点击确认删除' : '删除'" @click="U.remove([item.id], delKey)"><NvIcon name="trash" /></button>
                </div>
            </div>
            <div class="am-dsc">
                <button type="button" class="am-dm" title="点击放大预览" @click="U.preview(item.id)">
                    <MediaThumb :url="item.url" :kind="kind" :name="item.name" :w="640" plain />
                    <span v-if="kind === 'image' || kind === 'video'" class="zm"><NvIcon :name="kind === 'video' ? 'play' : 'expand'" /></span>
                </button>
                <input v-model="name" class="am-dn" type="text" title="直接修改名称" aria-label="素材名称" @change="inlineSave" @keydown.enter.prevent="$event.target.blur()">
                <div class="am-kv">
                    <div><span>类型</span><b>{{ assetKindLabel(item) }}</b></div>
                    <div><span>大小</span><b>{{ formatFileSize(item.size) }}</b></div>
                    <div><span>上传时间</span><b>{{ formatDate((item.created_at || 0) * 1000) }}</b></div>
                    <div><span>来源</span><b>本地上传</b></div>
                </div>
                <GenInfo v-if="gen && (gen.prompt || gen.model)" :prompt="gen.prompt || ''" :model="gen.model || ''" :provider="gen.provider || ''" :ratio="gen.ratio || ''"
                         :size="gen.width && gen.height ? gen.width + '×' + gen.height : ''" :at="gen.at || 0" refs-title="生成自" ref-icon="locate"
                         :refs="gen.canvas_id ? [{ id: gen.canvas_id, kind: gen.canvas_kind || '', node: gen.node_id || '', title: gen.canvas_title }] : []" />
                <div class="am-url">{{ item.url }}</div>
                <div v-if="isImage" class="am-sec">
                    <div class="am-sech"><b><NvIcon name="tag" />智能分类</b></div>
                    <div class="am-cls">
                        <button v-for="c in chips" :key="c.key" type="button" class="am-tag" :class="{ on: X.classFilter === c.key }" :title="c.label" @click="U.toggleClassFilter(c.key)">{{ c.tag }}</button>
                        <span v-if="!chips.length" class="empty">暂无智能分类，可以上传时自动生成或后续批量分类。</span>
                    </div>
                </div>
                <div v-if="isImage" class="am-sec">
                    <div class="am-sech">
                        <b>反推提示词</b>
                        <div class="row">
                            <button type="button" class="am-mini" :disabled="X.captionBusy || X.classifyBusy" @click="U.captionOne(item.id)"><span v-if="X.captionBusy" class="am-spin"></span><NvIcon v-else name="wand2" />{{ X.captionBusy ? '反推中' : '反推' }}</button>
                            <button type="button" class="am-mini" @click="copyCaption"><NvIcon name="copy" />复制</button>
                            <button type="button" class="am-mini pri" :disabled="saving" @click="saveCaption"><span v-if="saving" class="am-spin"></span><NvIcon v-else name="save" />保存</button>
                        </div>
                    </div>
                    <textarea v-model="caption" class="am-txa cap" placeholder="暂无反推提示词，可以批量反推后自动写入，也可以在这里手动编辑。"></textarea>
                </div>
            </div>
        </template>
    </aside>
</template>

<style scoped>
.cap { min-height: 96px; }
</style>
