<script setup>
// 资产详情：预览（点开 Lightbox）、行内改名、基本信息、生成信息、智能分类（点标签筛选）、平台注册；编辑模式改名后保存
import { ref, watch, computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import MediaThumb from '../parts/MediaThumb.vue';
import GenInfo from '../parts/GenInfo.vue';
import AvatarSection from './AvatarSection.vue';
import { run } from '../lib/state.js';
import { assetKind, assetKindLabel, formatDate } from '../lib/util.js';
import { classChips } from '../lib/classify.js';
import * as A from '../lib/library.js';

const props = defineProps({ item: { type: Object, default: null } });
const L = A.L;
const name = ref('');
const editName = ref('');
const saving = ref(false);
watch(() => props.item && props.item.id + '|' + props.item.name, () => { name.value = props.item?.name || 'asset'; editName.value = props.item?.name || ''; }, { immediate: true });
const kind = computed(() => assetKind(props.item));
const gen = computed(() => props.item?.generation || null);
const chips = computed(() => classChips(props.item, 32));
const editing = computed(() => L.edit && props.item && (props.item.id === L.sel || !L.sel));
function inlineSave() { if (props.item) run(A.saveInlineName(props.item.id, name.value), '保存失败'); }
async function saveEdit() {
    saving.value = true;
    try { await run(A.saveEdit(props.item.id, editName.value)); } finally { saving.value = false; }
}
</script>

<template>
    <aside class="am-det">
        <template v-if="!item">
            <div class="am-ph"><div class="pt"><b>素材预览</b><span>选择一个素材查看详情</span></div></div>
            <div class="am-dsc"><div class="am-empty"><NvIcon name="image" /><span>暂无可预览素材</span></div></div>
        </template>
        <template v-else-if="editing">
            <div class="am-ph">
                <div class="pt"><b>编辑素材</b><span>当前分组内直接保存</span></div>
                <div class="pa">
                    <button type="button" class="nv-btn sm primary" :disabled="saving" @click="saveEdit"><span v-if="saving" class="am-spin"></span><NvIcon v-else name="check" />保存</button>
                    <button type="button" class="am-ib" title="取消" @click="L.edit = false"><NvIcon name="x" /></button>
                </div>
            </div>
            <div class="am-dsc">
                <button type="button" class="am-dm" title="点击放大预览" @click="A.preview(item.id)"><MediaThumb :url="item.url" :kind="kind" :name="item.name" :w="640" plain /></button>
                <div class="am-form">
                    <label><span>素材名称</span><input v-model="editName" class="am-inp" type="text" placeholder="素材名称" @keydown.enter.prevent="saveEdit"></label>
                </div>
                <div class="am-kv">
                    <div><span>类型</span><b>{{ assetKindLabel(item) }}</b></div>
                    <div><span>创建时间</span><b>{{ formatDate(item.created_at) }}</b></div>
                </div>
                <div class="am-url">{{ item.url }}</div>
                <AvatarSection :item="item" />
            </div>
        </template>
        <template v-else>
            <div class="am-ph">
                <div class="pt"><b>素材预览</b><span>{{ assetKindLabel(item) }}</span></div>
                <div class="pa">
                    <button type="button" class="am-ib" title="下载素材" @click="A.downloadOne(item.id)"><NvIcon name="download" /></button>
                    <button type="button" class="am-ib" title="编辑" @click="A.startEdit(item.id)"><NvIcon name="pencil" /></button>
                    <button type="button" class="am-ib dng" :class="{ cf: L.pendingDelete === item.id }" :title="L.pendingDelete === item.id ? '再次点击确认删除' : '删除'" @click="run(A.deleteOne(item.id))"><NvIcon name="trash" /></button>
                </div>
            </div>
            <div class="am-dsc">
                <button type="button" class="am-dm" :title="kind === 'video' ? '点击预览视频' : '点击放大预览'" @click="A.preview(item.id)">
                    <MediaThumb :url="item.url" :kind="kind" :name="item.name" :w="640" plain />
                    <span v-if="kind === 'image' || kind === 'video'" class="zm"><NvIcon :name="kind === 'video' ? 'play' : 'expand'" /></span>
                </button>
                <input v-model="name" class="am-dn" type="text" title="直接修改名称" aria-label="素材名称" @change="inlineSave" @keydown.enter.prevent="$event.target.blur()">
                <div class="am-kv">
                    <div><span>类型</span><b>{{ assetKindLabel(item) }}</b></div>
                    <div><span>创建时间</span><b>{{ formatDate(item.created_at) }}</b></div>
                    <div><span>资产库</span><b>{{ A.activeLib()?.name || '资产库' }}</b></div>
                    <div><span>分组</span><b>{{ A.activeCat()?.name || '分组' }}</b></div>
                </div>
                <GenInfo v-if="gen && (gen.prompt || gen.model)" :prompt="gen.prompt || ''" :model="gen.model || ''" :provider="gen.provider || ''" :ratio="gen.ratio || ''"
                         :size="gen.width && gen.height ? gen.width + '×' + gen.height : ''" :at="gen.at || 0" refs-title="生成自" ref-icon="locate"
                           :refs="gen.canvas_id ? [{ id: gen.canvas_id, kind: gen.canvas_kind || '', node: gen.node_id || '', title: gen.canvas_title }] : []" />
                <div class="am-url">{{ item.url }}</div>
                <div v-if="kind === 'image'" class="am-sec">
                    <div class="am-sech"><b><NvIcon name="tag" />智能分类</b></div>
                    <div class="am-cls">
                        <button v-for="c in chips" :key="c.key" type="button" class="am-tag" :class="{ on: L.classFilter === c.key }" :title="c.label" @click="A.toggleClassFilter(c.key, A.libId())">{{ c.tag }}</button>
                        <span v-if="!chips.length" class="empty">暂无智能分类，可以选中图片后点击“智能分类”。</span>
                    </div>
                </div>
                <AvatarSection :item="item" />
            </div>
        </template>
    </aside>
</template>
