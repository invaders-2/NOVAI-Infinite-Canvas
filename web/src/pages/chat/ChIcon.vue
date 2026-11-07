<script setup>
// 对话页补充图标已合并进 canonical（tools/icons/canonical.json），这里只做旧调用点的薄包装
import NvIcon from '../../components/NvIcon.vue';

const props = defineProps({ name: { type: String, required: true } });
</script>

<template>
    <NvIcon :name="name" />
</template>
