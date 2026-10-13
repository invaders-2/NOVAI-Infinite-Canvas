<script setup>
// 推荐 API 内嵌页：筛选（全部 / 全能 / 性价比 / 免费）、分组、卡片
import { computed, inject } from 'vue';
import AIcon from './AIcon.vue';
import ApiHead from './ApiHead.vue';
import RecommendCard from './RecommendCard.vue';
import NvPills from '../../../../components/NvPills.vue';
import { t } from '../../../../lib/store.js';
import { RECOMMENDED_APIS, RECOMMEND_GROUPS } from '../core/constants.js';

const store = inject('apiStore');
const S = store.S;
const filters = computed(() => [{ value: 'all', label: '全部', sub: String(RECOMMENDED_APIS.length) }]
    .concat(RECOMMEND_GROUPS.map(g => ({ value: g.key, label: g.short, sub: String(RECOMMENDED_APIS.filter(a => (a.category || 'cheap') === g.key).length) }))));
const groups = computed(() => RECOMMEND_GROUPS
    .filter(g => S.recommendFilter === 'all' || S.recommendFilter === g.key)
    .map(g => ({ ...g, items: RECOMMENDED_APIS.map((api, index) => ({ api, index })).filter(x => (x.api.category || 'cheap') === g.key) }))
    .filter(g => g.items.length));
</script>

<template>
    <div class="rv">
        <ApiHead crumb="已验证可用的平台 · 选一个填 Key 即可开始生成" title="推荐 API">
            <template #actions><NvPills v-model="S.recommendFilter" :options="filters" label="推荐 API 筛选" /></template>
        </ApiHead>
        <TransitionGroup tag="div" name="rsec" class="secs">
            <div v-for="g in groups" :key="g.key" class="rsec">
                <div class="rh"><AIcon :name="g.icon" />{{ t(g.titleKey, g.title) }}<em>{{ g.items.length }}</em></div>
                <div class="grid"><RecommendCard v-for="x in g.items" :key="x.index" :api="x.api" :index="x.index" /></div>
            </div>
        </TransitionGroup>
        <div class="note">{{ t('api.recommendApiNote', '提示：账户内需要至少 0.05 元余额，才能验证地址并拉取模型。') }}</div>
    </div>
</template>

<style scoped>
.rv { display: flex; flex-direction: column; gap: 22px; }
.secs { display: flex; flex-direction: column; gap: 22px; }
.rsec { display: flex; flex-direction: column; gap: 10px; }
.rh { display: flex; align-items: center; gap: 8px; font: 500 13px/18px var(--font-sans); }
.rh .nv-i { width: 15px; height: 15px; color: var(--ink-3); }
.rh em { font: normal 400 11px/1 var(--font-mono); color: var(--ink-3); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: stretch; }
.note { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.rsec-enter-active { transition: opacity 220ms var(--ease-out), transform 220ms var(--ease-out); }
.rsec-leave-active { display: none; }
.rsec-enter-from { opacity: 0; transform: translateY(6px); }
@media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>
