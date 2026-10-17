<script setup>
// 网格卡片：缩略图 + 名称 + 元信息。管理模式下按下即切换勾选（旧版用 capture 阶段的 pointerdown 做的同一件事，
// 这样拖拽框选从卡片外开始、点卡片不会误触发框选）；普通模式点击查看详情。data-card-id 给框选用。
import NvIcon from '../../../components/NvIcon.vue';
import MediaThumb from './MediaThumb.vue';

const props = defineProps({
    cardId: { type: String, required: true },
    url: { type: String, default: '' },
    kind: { type: String, default: 'image' },
    name: { type: String, default: '' },
    meta: { type: String, default: '' },
    active: { type: Boolean, default: false },
    checked: { type: Boolean, default: false },
    manage: { type: Boolean, default: false },
    badge: { type: Boolean, default: false },
    label: { type: String, default: '' },
    renamable: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'toggle', 'rename']);
function down(e) {
    if (!props.manage || e.button !== 0) return;
    if (e.target.closest && e.target.closest('input')) return;
    e.preventDefault();
    e.stopPropagation();
    emit('toggle', props.cardId);
}
function click(e) {
    if (props.manage) return;
    if (e.target.closest && e.target.closest('input')) return;
    emit('select', props.cardId);
}
function nameClick(e) {
    if (!props.renamable || props.manage) return;
    e.stopPropagation();
    emit('rename', props.cardId);
}
</script>

<template>
    <article class="am-card" :class="{ act: active && !manage, pick: manage && checked }" :data-card-id="cardId" @pointerdown="down" @click="click">
        <div class="am-cm">
            <MediaThumb :url="url" :kind="kind" :name="name" :badge="badge" :label="label" />
            <span v-if="manage" class="am-ck" :class="{ on: checked }"><NvIcon v-if="checked" name="check" /></span>
        </div>
        <slot name="name">
            <span class="nm" :title="name" @click="nameClick">{{ name }}</span>
        </slot>
        <span class="mt">{{ meta }}</span>
    </article>
</template>
