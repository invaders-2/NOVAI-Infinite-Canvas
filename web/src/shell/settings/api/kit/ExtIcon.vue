<script setup>
// 补充图标已合并进 canonical（tools/icons/canonical.json），这里只做旧调用点的薄包装
import NvIcon from '../../../../components/NvIcon.vue';

const props = defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: null } });
</script>

<template>
    <NvIcon :name="name" :size="size" />
</template>
