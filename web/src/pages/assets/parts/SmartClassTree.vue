<script setup>
// 树里的「智能分类」节点：按 环境 / 构图 / 光影 / 模特 / 主体 / 风格 / 标签 分组，展开后是标签胶囊，点胶囊筛选
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { groupedClassEntries, classEntryGroup } from '../lib/classify.js';

const props = defineProps({
    entries: { type: Array, default: () => [] },
    activeKey: { type: String, default: '' },
    openGroup: { type: String, default: '' },
});
const emit = defineEmits(['root', 'group', 'filter']);
const groups = computed(() => groupedClassEntries(props.entries));
const activeGroup = computed(() => {
    const e = props.entries.find(x => x.key === props.activeKey);
    return e ? classEntryGroup(e)?.id : '';
});
</script>

<template>
    <button type="button" class="am-tr sub" @click="emit('root')">
        <NvIcon name="tag" /><b :style="activeKey ? 'font-weight:500' : ''">智能分类</b><span class="n">{{ groups.length }}</span>
    </button>
    <template v-if="groups.length">
        <template v-for="g in groups" :key="g.id">
            <button type="button" class="am-sgrp" :class="{ open: openGroup === g.id, act: activeGroup === g.id }" :aria-expanded="openGroup === g.id" @click="emit('group', g.id)">
                {{ g.name }}<small>{{ g.entries.length }}</small><NvIcon :name="openGroup === g.id ? 'chevu' : 'chev'" />
            </button>
            <div v-if="openGroup === g.id" class="am-pills">
                <button v-for="e in g.entries" :key="e.key" type="button" class="am-tag" :class="{ on: activeKey === e.key }" :title="e.label" @click="emit('filter', e.key)">
                    {{ e.tag }}<small>{{ e.count }}</small>
                </button>
            </div>
        </template>
    </template>
    <div v-else class="am-temp">暂无分类，先选择图片点“智能分类”</div>
</template>
