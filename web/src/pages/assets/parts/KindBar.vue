<script setup>
// 媒体面板顶部的类型筛选（素材库 / 本地上传 / 画布里的共用）。tabs 由各面板 lib 的 kindTabs() 提供：
// 「全部」+ 当前面板实际有数据的 图片/视频/音频；选中项用 nv-seg 的软底 + 文字提亮，不画边框。
const props = defineProps({
    tabs: { type: Array, default: () => [] },
    modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);
</script>

<template>
    <div class="am-kbar" role="group" aria-label="按素材类型筛选">
        <div class="nv-seg static">
            <button v-for="t in props.tabs" :key="t.id || 'all'" type="button" :class="{ 'is-on': props.modelValue === t.id }"
                    :aria-pressed="props.modelValue === t.id" @click="emit('update:modelValue', t.id)">
                {{ t.label }}<em>{{ t.count }}</em>
            </button>
        </div>
    </div>
</template>
