<script setup>
// 内容区工具条右端：状态点（悬停看状态文字）+ 偏好设置 + 刷新。2026-11 页头去掉后，这三个入口挪到这里（各面板共用）
import { inject, computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { S } from '../lib/state.js';

const refresh = inject('amRefresh', () => {});
const busy = computed(() => /(\.\.\.|…)$/.test(S.status));
</script>

<template>
    <span class="am-tools">
        <span class="am-dot" :class="{ busy }" :title="S.status" :aria-label="S.status"></span>
        <button type="button" class="am-ib" title="偏好设置" aria-label="偏好设置" @click="S.prefsOpen = true"><NvIcon name="settings" /></button>
        <button type="button" class="am-ib" title="刷新" aria-label="刷新" @click="refresh()"><NvIcon name="refresh" /></button>
    </span>
</template>

<style scoped>
.am-tools { display: inline-flex; align-items: center; gap: 2px; height: 30px; flex: none; }
.am-dot { margin: 0 6px 0 4px; }
.am-ib { width: 30px; height: 30px; }
</style>
