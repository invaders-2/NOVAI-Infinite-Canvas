<script setup>
// 画布资产详情：预览 / 打开链接 / 复制链接 / 下载；来源画布与节点；生成信息；在画布中定位；用在 N 个画布
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import MediaThumb from '../parts/MediaThumb.vue';
import GenInfo from '../parts/GenInfo.vue';
import { setStatus, run } from '../lib/state.js';
import { assetKind, canvasAssetKindLabel, canvasKindLabel, formatDate, copyText } from '../lib/util.js';
import * as K from '../lib/canvas.js';

const props = defineProps({ item: { type: Object, default: null } });
const kind = computed(() => assetKind(props.item));
const canPreview = computed(() => ['image', 'video'].includes(kind.value));
const size = computed(() => (props.item && props.item.natural_w && props.item.natural_h ? `${props.item.natural_w}×${props.item.natural_h}` : ''));
const usedIn = computed(() => (Array.isArray(props.item?.used_in) ? props.item.used_in : []));
const refs = computed(() => (usedIn.value.length > 1 ? usedIn.value.map(r => ({ id: r.id, kind: r.kind || '', node: r.node_id || '', title: r.title })) : []));
function openLink() { if (props.item?.url) window.open(props.item.url, '_blank', 'noopener'); }
async function copyLink() { setStatus((await copyText(props.item?.url || '')) ? '已复制画布资产链接' : '复制失败'); }
</script>

<template>
    <aside class="am-det">
        <template v-if="!item">
            <div class="am-ph"><div class="pt"><b>画布资产详情</b><span>选择一个画布资产查看详情</span></div></div>
            <div class="am-dsc"><div class="am-empty"><NvIcon name="grid9" /><span>暂无画布资产</span></div></div>
        </template>
        <template v-else>
            <div class="am-ph">
                <div class="pt"><b>画布资产详情</b><span>{{ canvasAssetKindLabel(item) }}</span></div>
                <div class="pa">
                    <button v-if="canPreview" type="button" class="am-ib" :title="kind === 'video' ? '预览视频' : '放大预览'" @click="K.preview(item.id)"><NvIcon :name="kind === 'video' ? 'play' : 'expand'" /></button>
                    <button type="button" class="am-ib" title="打开链接" @click="openLink"><NvIcon name="ext" /></button>
                    <button type="button" class="am-ib" title="复制链接" @click="copyLink"><NvIcon name="copy" /></button>
                    <button type="button" class="nv-btn sm primary" @click="run(K.download([item.id]), '下载画布资产失败')"><NvIcon name="download" />下载</button>
                </div>
            </div>
            <div class="am-dsc">
                <button v-if="canPreview" type="button" class="am-dm" :title="kind === 'video' ? '点击预览视频' : '点击放大预览'" @click="K.preview(item.id)">
                    <MediaThumb :url="item.url" :kind="kind" :name="item.name" :w="640" plain /><span class="zm"><NvIcon :name="kind === 'video' ? 'play' : 'expand'" /></span>
                </button>
                <div v-else class="am-dm static"><MediaThumb :url="item.url" :kind="kind" :name="item.name" plain /></div>
                <div class="am-dn plain">{{ item.name || '画布资产' }}</div>
                <div class="am-kv">
                    <div><span>类型</span><b>{{ canvasAssetKindLabel(item) }}</b></div>
                    <div><span>画布分类</span><b>{{ canvasKindLabel(item.canvas_kind) }}</b></div>
                    <div><span>来源画布</span><b :title="item.canvas_title || ''">{{ item.canvas_title || '未命名画布' }}</b></div>
                    <div><span>更新时间</span><b>{{ formatDate(item.canvas_updated_at || item.created_at) }}</b></div>
                    <div><span>来源节点</span><b :title="item.node_title || item.node_type || ''">{{ item.node_title || item.node_type || '节点' }}</b></div>
                    <div><span>节点类型</span><b>{{ item.node_type || '-' }}</b></div>
                </div>
                <GenInfo :prompt="item.gen_prompt || ''" :model="item.gen_model || ''" :provider="item.gen_provider || ''" :ratio="item.gen_ratio || ''" :size="size" :at="item.gen_at || 0"
                         :refs-title="'用在 ' + usedIn.length + ' 个画布'" :refs="refs">
                    <button type="button" class="am-wbtn big" @click="K.openCanvasAtNode(item.canvas_id, item.canvas_kind, item.node_id)"><NvIcon name="locate" />在画布中定位</button>
                </GenInfo>
                <div class="am-url">{{ item.url }}</div>
            </div>
        </template>
    </aside>
</template>
